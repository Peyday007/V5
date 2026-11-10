/**
 * Reading a ChatGPT archive, whole.
 *
 * Pure: no Node, no database, no network. The browser imports it to read an
 * export on the person's own machine and send it in batches; the terminal
 * importer imports it to do the same from a file; the server imports it to
 * re-read what arrived. One reader, so the denominators a browser declares and
 * the records a server stores are counted by the same code.
 *
 * Three shapes, all of which a person can actually produce:
 *
 *   * **The official export** (`Settings → Data controls → Export data`): a zip
 *     holding `conversations.json` — an array of conversations, each a tree of
 *     nodes in `mapping` — plus the uploaded and generated files themselves.
 *   * **ChatGPTExporter JSON**: one conversation object per file, in the same
 *     tree shape (it saves the API's own object), often many files in a zip.
 *   * **ChatGPTExporter Markdown**: `#### You:` / `#### ChatGPT:` headed turns.
 *     No ids, no tree, usually no times — and the reader says so rather than
 *     inventing them.
 *
 * What it keeps that `bridge/import.ts` does not: every node of the tree, not
 * only the branch the person last read. An edited prompt and a regenerated
 * answer are siblings in the export, and both are the person's history.
 */

export type MemoryRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL' | 'UNKNOWN';
export type AttachmentKind = 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'OTHER';
export type ArchiveFormat = 'CHATGPT_OFFICIAL' | 'CHATGPT_EXPORTER' | 'CHATGPT_MARKDOWN';

export interface ParsedAttachment {
  kind: AttachmentKind;
  /** The export's own file id (`file-…`, `file_…`), or a name when it has none. */
  sourceRef: string;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown>;
}

export interface ParsedNode {
  nodeId: string;
  parentId: string | null;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  onCurrentPath: boolean;
  role: MemoryRole;
  authorName: string | null;
  recipient: string | null;
  contentType: string;
  text: string;
  saidAt: string | null;
  updatedAt: string | null;
  modelSlug: string | null;
  hidden: boolean;
  metadata: Record<string, unknown>;
  attachments: ParsedAttachment[];
}

export interface ParsedConversation {
  externalId: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** A ChatGPT Project (`g-p-…`) or custom GPT (`g-…`) this conversation belonged to. */
  projectRef: string | null;
  projectName: string | null;
  currentNodeId: string | null;
  format: ArchiveFormat;
  nodes: ParsedNode[];
  /** Nodes that carry a message (the structural root does not). */
  messageCount: number;
  branchPointCount: number;
  attachmentCount: number;
  contentHash: string;
  /** What could not be read, in words. */
  notes: string[];
  /** The original object exactly as it arrived, for the immutable record. */
  raw: unknown;
}

/** The manifest line one conversation contributes: the denominator. */
export interface ManifestEntry {
  externalId: string;
  title: string;
  contentHash: string;
  nodes: number;
  messages: number;
  attachments: number;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Hashing: FNV-1a over UTF-16 code units, two lanes, hex. Deterministic in the
// browser and on the server without async crypto; it identifies content for
// deduplication, and the server records a sha-256 of the raw bytes beside it.
// ---------------------------------------------------------------------------
export function contentHashOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 15;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${text.length.toString(16)}`;
}

function isoFromEpoch(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds in the export; milliseconds in some exporter builds.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normaliseRole(role: unknown): MemoryRole {
  const text = typeof role === 'string' ? role.toLowerCase() : '';
  if (text === 'user') return 'USER';
  if (text === 'assistant') return 'ASSISTANT';
  if (text === 'system') return 'SYSTEM';
  if (text === 'tool') return 'TOOL';
  return 'UNKNOWN';
}

/** `file-service://file-abc` and `sediment://file_abc` both name `file-abc` / `file_abc`. */
export function fileIdOf(pointer: string): string {
  return pointer.replace(/^[a-z-]+:\/\//i, '').trim();
}

function kindOfMime(mime: string | null, name: string | null): AttachmentKind {
  const m = (mime ?? '').toLowerCase();
  const n = (name ?? '').toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/.test(n)) return 'IMAGE';
  if (m.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac)$/.test(n)) return 'AUDIO';
  if (m.startsWith('video/') || /\.(mp4|mov|avi|mkv)$/.test(n)) return 'VIDEO';
  if (m || n) return 'FILE';
  return 'OTHER';
}

interface ExportMessage {
  id?: unknown;
  author?: { role?: unknown; name?: unknown } | null;
  recipient?: unknown;
  content?: Record<string, unknown> | null;
  create_time?: unknown;
  update_time?: unknown;
  status?: unknown;
  metadata?: Record<string, unknown> | null;
}

interface ExportNode {
  id?: unknown;
  parent?: unknown;
  children?: unknown;
  message?: ExportMessage | null;
}

/**
 * The words in one message, whatever kind of content it is.
 *
 * Every content type the export has used carries its text in one of a few
 * places; anything unrecognised is kept as its JSON so nothing is silently
 * empty. Non-text parts (an image) contribute an attachment, not words.
 */
function textOf(content: Record<string, unknown> | null | undefined, attachments: ParsedAttachment[]): string {
  if (!content) return '';
  const pieces: string[] = [];
  const parts = content.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part) pieces.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      const ctype = str(p.content_type) ?? '';
      const pointer = str(p.asset_pointer);
      if (pointer) {
        const metadata = (p.metadata && typeof p.metadata === 'object' ? (p.metadata as Record<string, unknown>) : {});
        const kind: AttachmentKind = ctype.includes('audio')
          ? 'AUDIO'
          : ctype.includes('video')
            ? 'VIDEO'
            : 'IMAGE';
        attachments.push({
          kind,
          sourceRef: fileIdOf(pointer),
          name: null,
          mimeType: str(p.format) ? `${kind === 'AUDIO' ? 'audio' : kind === 'VIDEO' ? 'video' : 'image'}/${String(p.format)}` : null,
          sizeBytes: num(p.size_bytes),
          width: num(p.width),
          height: num(p.height),
          metadata: { contentType: ctype, ...metadata },
        });
        continue;
      }
      const inner = str(p.text);
      if (inner) pieces.push(inner);
    }
  }
  for (const key of ['text', 'result', 'user_profile', 'user_instructions', 'model_set_context', 'content']) {
    const value = content[key];
    if (typeof value === 'string' && value.trim()) pieces.push(value);
  }
  const thoughts = content.thoughts;
  if (Array.isArray(thoughts)) {
    for (const thought of thoughts) {
      if (thought && typeof thought === 'object') {
        const t = thought as Record<string, unknown>;
        const line = [str(t.summary), str(t.content)].filter(Boolean).join(': ');
        if (line) pieces.push(line);
      }
    }
  }
  if (pieces.length === 0 && !Array.isArray(parts)) {
    const rest = Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'content_type'));
    if (Object.keys(rest).length > 0) {
      const json = JSON.stringify(rest);
      if (json && json !== '{}') pieces.push(json);
    }
  }
  return pieces.join('\n\n');
}

function metadataAttachments(metadata: Record<string, unknown> | null | undefined): ParsedAttachment[] {
  const list = metadata?.attachments;
  if (!Array.isArray(list)) return [];
  const out: ParsedAttachment[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    const name = str(a.name);
    const mime = str(a.mime_type) ?? str(a.mimeType);
    const id = str(a.id) ?? name;
    if (!id) continue;
    out.push({
      kind: kindOfMime(mime, name),
      sourceRef: fileIdOf(id),
      name,
      mimeType: mime,
      sizeBytes: num(a.size),
      width: num(a.width),
      height: num(a.height),
      metadata: Object.fromEntries(
        Object.entries(a).filter(([key]) => !['id', 'name', 'mime_type', 'mimeType', 'size', 'width', 'height'].includes(key)),
      ),
    });
  }
  return out;
}

/** The small, non-content part of a message's metadata worth keeping beside it. */
function keptMetadata(message: ExportMessage): Record<string, unknown> {
  const md = message.metadata ?? {};
  const kept: Record<string, unknown> = {};
  for (const key of [
    'citations',
    'content_references',
    'finish_details',
    'request_id',
    'message_type',
    'is_visually_hidden_from_conversation',
    'voice_mode_message',
    'dalle',
    'search_result_groups',
    'gizmo_id',
    'parent_id',
  ]) {
    if (md[key] !== undefined) kept[key] = md[key];
  }
  if (message.status !== undefined) kept.status = message.status;
  return kept;
}

function isExportConversation(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    !!(value as Record<string, unknown>).mapping &&
    typeof (value as Record<string, unknown>).mapping === 'object';
}

/**
 * Read one conversation object, every node of it.
 *
 * Depth and sibling order come from the tree itself; `current_node` marks the
 * path the person last read, and every other node is kept as an alternate.
 */
export function parseExportConversation(
  record: Record<string, unknown>,
  format: ArchiveFormat,
  projectNames: Record<string, string> = {},
): ParsedConversation {
  const notes: string[] = [];
  const mapping = record.mapping as Record<string, ExportNode>;
  const ids = Object.keys(mapping);

  // Parent links are the tree. A node naming a parent that is not in the
  // mapping is kept as a root and said so, rather than dropped.
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  for (const id of ids) {
    const node = mapping[id]!;
    const parent = typeof node.parent === 'string' ? node.parent : null;
    if (parent && !mapping[parent]) {
      notes.push(`Node ${id} names a parent missing from the export; it was kept as a root.`);
      parentOf.set(id, null);
    } else {
      parentOf.set(id, parent);
    }
  }
  // Children in the order the parent declares them; a node that names a parent
  // which does not list it is still that parent's child, after the listed ones.
  const named = new Map<string, string[]>();
  for (const id of ids) {
    const parent = parentOf.get(id);
    if (parent) named.set(parent, [...(named.get(parent) ?? []), id]);
  }
  for (const id of ids) {
    const declared: unknown[] = Array.isArray(mapping[id]!.children) ? (mapping[id]!.children as unknown[]) : [];
    const kids = declared.filter((k): k is string => typeof k === 'string' && !!mapping[k] && parentOf.get(k) === id);
    const listed = new Set(kids);
    for (const other of named.get(id) ?? []) if (!listed.has(other)) kids.push(other);
    childrenOf.set(id, kids);
  }

  const currentNodeId = typeof record.current_node === 'string' && mapping[record.current_node] ? record.current_node : null;
  const currentPath = new Set<string>();
  if (currentNodeId) {
    let cursor: string | null = currentNodeId;
    while (cursor && !currentPath.has(cursor)) {
      currentPath.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  } else {
    notes.push('The conversation names no current node, so the last child at each fork was taken as the read path.');
    const roots = ids.filter((id) => parentOf.get(id) === null);
    let cursor: string | undefined = roots[0];
    while (cursor && !currentPath.has(cursor)) {
      currentPath.add(cursor);
      const kids: string[] = childrenOf.get(cursor) ?? [];
      cursor = kids[kids.length - 1];
    }
  }

  const nodes: ParsedNode[] = [];
  const visited = new Set<string>();
  let branchPointCount = 0;
  const roots = ids.filter((id) => parentOf.get(id) === null);
  const stack: { id: string; depth: number; siblingIndex: number; siblingCount: number }[] = roots
    .map((id, index) => ({ id, depth: 0, siblingIndex: index, siblingCount: roots.length }))
    .reverse();
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.id)) {
      notes.push(`Node ${entry.id} is reachable twice; the tree was read once.`);
      continue;
    }
    visited.add(entry.id);
    const node = mapping[entry.id]!;
    const kids = childrenOf.get(entry.id) ?? [];
    if (kids.length > 1) branchPointCount += 1;
    const message = node.message;
    if (message && typeof message === 'object') {
      const attachments: ParsedAttachment[] = [];
      const content = (message.content ?? null) as Record<string, unknown> | null;
      const text = textOf(content, attachments);
      attachments.push(...metadataAttachments(message.metadata));
      const md = message.metadata ?? {};
      nodes.push({
        nodeId: entry.id,
        parentId: parentOf.get(entry.id) ?? null,
        depth: entry.depth,
        siblingIndex: entry.siblingIndex,
        siblingCount: entry.siblingCount,
        onCurrentPath: currentPath.has(entry.id),
        role: normaliseRole(message.author?.role),
        authorName: str(message.author?.name),
        recipient: str(message.recipient),
        contentType: str(content?.content_type) ?? 'unknown',
        text,
        saidAt: isoFromEpoch(message.create_time),
        updatedAt: isoFromEpoch(message.update_time),
        modelSlug: str(md.model_slug) ?? str(md.default_model_slug),
        hidden: md.is_visually_hidden_from_conversation === true,
        metadata: keptMetadata(message),
        attachments: dedupeAttachments(attachments),
      });
    }
    kids
      .map((id, index) => ({ id, depth: entry.depth + 1, siblingIndex: index, siblingCount: kids.length }))
      .reverse()
      .forEach((kid) => stack.push(kid));
  }
  const unreached = ids.filter((id) => !visited.has(id));
  if (unreached.length > 0) {
    notes.push(`${unreached.length} node(s) sit in a cycle with no root; they were not read.`);
  }

  const projectRef = str(record.gizmo_id) ?? str(record.project_id) ?? str(record.conversation_template_id);
  const externalId = str(record.conversation_id) ?? str(record.id) ?? `untitled-${contentHashOf(JSON.stringify(record))}`;
  if (!str(record.conversation_id) && !str(record.id)) {
    notes.push('The conversation carried no id; one was derived from its content.');
  }
  const messageNodes = nodes.filter((n) => n.role !== 'UNKNOWN' || n.text.trim());
  return {
    externalId,
    title: str(record.title) ?? 'Untitled conversation',
    createdAt: isoFromEpoch(record.create_time),
    updatedAt: isoFromEpoch(record.update_time),
    projectRef,
    projectName: projectRef ? projectNames[projectRef] ?? null : null,
    currentNodeId,
    format,
    nodes,
    messageCount: messageNodes.length,
    branchPointCount,
    attachmentCount: nodes.reduce((sum, n) => sum + n.attachments.length, 0),
    contentHash: contentHashOf(JSON.stringify(record)),
    notes,
    raw: record,
  };
}

function dedupeAttachments(list: ParsedAttachment[]): ParsedAttachment[] {
  const seen = new Map<string, ParsedAttachment>();
  for (const one of list) {
    const prior = seen.get(one.sourceRef);
    if (!prior) {
      seen.set(one.sourceRef, one);
      continue;
    }
    // Two mentions of one file: keep whichever knows more about it.
    seen.set(one.sourceRef, {
      ...prior,
      name: prior.name ?? one.name,
      mimeType: prior.mimeType ?? one.mimeType,
      sizeBytes: prior.sizeBytes ?? one.sizeBytes,
      width: prior.width ?? one.width,
      height: prior.height ?? one.height,
      metadata: { ...one.metadata, ...prior.metadata },
    });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Markdown (ChatGPTExporter)
// ---------------------------------------------------------------------------
const MD_MARKERS: { pattern: RegExp; role: MemoryRole }[] = [
  { pattern: /^(?:#{1,6}\s*|\*\*)?(?:you|user|me)\s*:?\s*(?:\*\*)?\s*:?\s*$/i, role: 'USER' },
  { pattern: /^(?:#{1,6}\s*|\*\*)?(?:chatgpt|assistant|gpt-?[\w.-]*)\s*:?\s*(?:\*\*)?\s*:?\s*$/i, role: 'ASSISTANT' },
  { pattern: /^(?:#{1,6}\s*|\*\*)?system\s*:?\s*(?:\*\*)?\s*:?\s*$/i, role: 'SYSTEM' },
];

export function parseExporterMarkdown(body: string, fileName: string): ParsedConversation | null {
  const lines = body.split(/\r?\n/);
  let title: string | null = null;
  const turns: { role: MemoryRole; lines: string[] }[] = [];
  const notes: string[] = [];
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const marker = MD_MARKERS.find((m) => m.pattern.test(trimmed));
    if (marker) {
      turns.push({ role: marker.role, lines: [] });
      continue;
    }
    if (turns.length === 0) {
      const heading = /^#\s+(.+)$/.exec(trimmed);
      if (heading && !title) title = heading[1]!.trim();
      const created = /^\*{0,2}(?:created|date)\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/i.exec(trimmed);
      if (created) createdAt = isoFromEpoch(created[1]!.trim());
      const updated = /^\*{0,2}(?:updated|last updated)\*{0,2}\s*:\s*\*{0,2}\s*(.+)$/i.exec(trimmed);
      if (updated) updatedAt = isoFromEpoch(updated[1]!.trim());
      continue;
    }
    turns[turns.length - 1]!.lines.push(line);
  }
  const kept = turns
    .map((turn) => ({ role: turn.role, text: turn.lines.join('\n').replace(/\n-{3,}\s*$/, '').trim() }))
    .filter((turn) => turn.text);
  if (kept.length === 0) return null;
  notes.push('Read from Markdown: the export carries no node ids and no branches, so only the visible path exists.');
  if (!createdAt) notes.push('No timestamps were present in the Markdown; message times are unknown.');
  const nodes: ParsedNode[] = kept.map((turn, index) => ({
    nodeId: `md-${index}`,
    parentId: index === 0 ? null : `md-${index - 1}`,
    depth: index,
    siblingIndex: 0,
    siblingCount: 1,
    onCurrentPath: true,
    role: turn.role,
    authorName: null,
    recipient: null,
    contentType: 'text',
    text: turn.text,
    saidAt: index === 0 ? createdAt : null,
    updatedAt: null,
    modelSlug: null,
    hidden: false,
    metadata: {},
    attachments: [],
  }));
  const resolvedTitle = title ?? fileName.replace(/\.(md|markdown)$/i, '');
  return {
    externalId: `md-${contentHashOf(`${resolvedTitle}\n${kept[0]!.text}`)}`,
    title: resolvedTitle,
    createdAt,
    updatedAt,
    projectRef: null,
    projectName: null,
    currentNodeId: nodes[nodes.length - 1]!.nodeId,
    format: 'CHATGPT_MARKDOWN',
    nodes,
    messageCount: nodes.length,
    branchPointCount: 0,
    attachmentCount: 0,
    contentHash: contentHashOf(body),
    notes,
    raw: { markdown: body, fileName },
  };
}

// ---------------------------------------------------------------------------
// A whole archive: a set of named files, read into conversations + files.
// ---------------------------------------------------------------------------
export interface ArchiveFileText {
  name: string;
  text: string;
}

export interface ParsedArchive {
  format: ArchiveFormat | 'MIXED';
  conversations: ParsedConversation[];
  /** File names in the archive that are not conversation documents: candidate attachments. */
  binaryFiles: string[];
  /** Files that looked like conversation documents and could not be read, with why. */
  unreadable: { name: string; reason: string }[];
  notes: string[];
}

/** Names that hold project or GPT names: `{id, name|title}` objects, anywhere in an array. */
export function readProjectNames(value: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  const visit = (v: unknown, depth: number): void => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    const id = str(o.id) ?? str(o.gizmo_id) ?? str(o.project_id);
    const name = str(o.name) ?? str(o.title) ?? str(o.display_name);
    if (id && name && /^g-/.test(id)) names[id] = name;
    for (const value of Object.values(o)) if (value && typeof value === 'object') visit(value, depth + 1);
  };
  visit(value, 0);
  return names;
}

const NON_CONVERSATION_JSON = /(^|\/)(user|message_feedback|model_comparisons|shared_conversations|user_settings)\.json$/i;

/**
 * Read every text file of an archive.
 *
 * `binaryNames` are the archive's other entries (images, PDFs, audio), passed
 * through so a caller can match attachment ids to the bytes it holds.
 */
export function parseArchive(files: ArchiveFileText[], binaryNames: string[] = []): ParsedArchive {
  const conversations: ParsedConversation[] = [];
  const unreadable: { name: string; reason: string }[] = [];
  const notes: string[] = [];
  const formats = new Set<ArchiveFormat>();
  const projectNames: Record<string, string> = {};

  const jsonFiles: { name: string; value: unknown }[] = [];
  for (const file of files) {
    if (/\.json$/i.test(file.name)) {
      try {
        jsonFiles.push({ name: file.name, value: JSON.parse(file.text) });
      } catch (error) {
        unreadable.push({ name: file.name, reason: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  for (const file of jsonFiles) {
    if (/(gizmo|project)s?\.json$/i.test(file.name)) Object.assign(projectNames, readProjectNames(file.value));
  }

  const seen = new Map<string, ParsedConversation>();
  const add = (conversation: ParsedConversation): void => {
    const prior = seen.get(conversation.externalId);
    if (prior) {
      // The same conversation twice in one archive: keep the newer reading,
      // and say so — two copies are a fact about the archive.
      notes.push(`Conversation ${conversation.externalId} appeared more than once; the most recently updated copy was kept.`);
      if ((prior.updatedAt ?? '') >= (conversation.updatedAt ?? '')) return;
      conversations.splice(conversations.indexOf(prior), 1);
    }
    seen.set(conversation.externalId, conversation);
    conversations.push(conversation);
  };

  for (const file of jsonFiles) {
    if (NON_CONVERSATION_JSON.test(file.name) || /(gizmo|project)s?\.json$/i.test(file.name)) continue;
    const value = file.value;
    const official = /(^|\/)conversations(-\d+)?\.json$/i.test(file.name);
    const list = Array.isArray(value) ? value : [value];
    let read = 0;
    list.forEach((item, index) => {
      if (isExportConversation(item)) {
        const format: ArchiveFormat = official ? 'CHATGPT_OFFICIAL' : 'CHATGPT_EXPORTER';
        formats.add(format);
        add(parseExportConversation(item, format, projectNames));
        read += 1;
      } else if (item && typeof item === 'object' && Array.isArray(value)) {
        unreadable.push({ name: `${file.name}[${index}]`, reason: 'An entry with no message tree (`mapping`).' });
      }
    });
    if (read === 0 && !Array.isArray(value)) {
      unreadable.push({ name: file.name, reason: 'A JSON file that is not a conversation (no `mapping`).' });
    }
  }

  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.name)) continue;
    const parsed = parseExporterMarkdown(file.text, file.name.split('/').pop() ?? file.name);
    if (parsed) {
      formats.add('CHATGPT_MARKDOWN');
      add(parsed);
    } else {
      unreadable.push({ name: file.name, reason: 'Markdown with no You/ChatGPT turn markers.' });
    }
  }

  const format: ParsedArchive['format'] = formats.size === 1 ? [...formats][0]! : formats.size === 0 ? 'CHATGPT_OFFICIAL' : 'MIXED';
  return { format, conversations, binaryFiles: binaryNames, unreadable, notes };
}

export function manifestEntryOf(conversation: ParsedConversation): ManifestEntry {
  return {
    externalId: conversation.externalId,
    title: conversation.title,
    contentHash: conversation.contentHash,
    nodes: conversation.nodes.length,
    messages: conversation.messageCount,
    attachments: conversation.attachmentCount,
    updatedAt: conversation.updatedAt,
  };
}

/**
 * Which archive file holds an attachment's bytes.
 *
 * The export names a file by its id, followed by the original name:
 * `file-AbC123-photo.png`, `file_00000000a1b2-…​.png`, `dalle-generations/file-…`.
 */
export function matchArchiveFile(sourceRef: string, names: readonly string[]): string | null {
  const id = sourceRef.toLowerCase();
  if (!id) return null;
  for (const name of names) {
    const base = (name.split('/').pop() ?? name).toLowerCase();
    if (base === id || base.startsWith(`${id}-`) || base.startsWith(`${id}.`) || base.startsWith(`${id}_`)) return name;
  }
  return null;
}
