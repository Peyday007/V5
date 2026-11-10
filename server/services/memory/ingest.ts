/**
 * Source preservation: getting a whole conversation history in, exactly, and
 * being able to say afterwards how much of it arrived.
 *
 * The shape is a declared manifest followed by batches, because a real export
 * is too large for one request and a person will close the laptop halfway:
 *
 *   1. `openArchive` records every conversation the archive declares — the
 *      denominator — and answers which of them Brain already holds, so a resumed
 *      import sends only the rest.
 *   2. `ingestConversations` takes raw conversation objects, re-reads each one
 *      itself (the client's reading is never trusted), and stores it: a new
 *      conversation, a new version of a changed one, or nothing for an unchanged
 *      one. Each conversation is its own transaction and its own checkpoint.
 *   3. `storeAttachment` takes the bytes of one file the archive held.
 *
 * The original is never edited. A conversation that changed between two
 * exports is a new version beside the old one; a message whose text changed is
 * a new row and the old row records the version that superseded it.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { newId, nowIso, parseJson, toJson } from '../../repos/util.ts';
import { getStorage } from '../storage/index.ts';
import {
  contentHashOf,
  manifestEntryOf,
  parseExportConversation,
  parseExporterMarkdown,
  type ManifestEntry,
  type ParsedConversation,
} from './parse.ts';
import { recordMemoryEvent } from './events.ts';

export const MAX_BATCH_CONVERSATIONS = 200;
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

export type ArchiveSourceFormat = 'CHATGPT_OFFICIAL' | 'CHATGPT_EXPORTER' | 'CHATGPT_MARKDOWN' | 'BRIDGE' | 'MIXED';
export type EntryState = 'DECLARED' | 'IMPORTED' | 'UNCHANGED' | 'FAILED';

export interface ArchiveView {
  id: string;
  label: string;
  sourceFormat: ArchiveSourceFormat;
  state: 'RECEIVING' | 'COMPLETE' | 'ABANDONED';
  declared: { conversations: number; messages: number; nodes: number; attachments: number; files: number };
  entries: Record<EntryState, number>;
  notes: string[];
  createdAt: string;
  completedAt: string | null;
}

interface ArchiveRow {
  id: string;
  owner_user_id: string;
  label: string;
  source_format: ArchiveSourceFormat;
  manifest_hash: string;
  state: ArchiveView['state'];
  declared_conversations: number;
  declared_messages: number;
  declared_nodes: number;
  declared_attachments: number;
  declared_files: number;
  notes: string;
  created_at: string;
  completed_at: string | null;
}

export class MemoryNotFound extends Error {}

async function archiveView(row: ArchiveRow): Promise<ArchiveView> {
  const counts = await getDb().all<{ state: EntryState; n: number }>(
    'SELECT state, COUNT(*) AS n FROM memory_archive_entries WHERE archive_id = ? GROUP BY state',
    [row.id],
  );
  const entries: Record<EntryState, number> = { DECLARED: 0, IMPORTED: 0, UNCHANGED: 0, FAILED: 0 };
  for (const c of counts) entries[c.state] = Number(c.n);
  return {
    id: row.id,
    label: row.label,
    sourceFormat: row.source_format,
    state: row.state,
    declared: {
      conversations: row.declared_conversations,
      messages: row.declared_messages,
      nodes: row.declared_nodes,
      attachments: row.declared_attachments,
      files: row.declared_files,
    },
    entries,
    notes: parseJson<string[]>(row.notes, []),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** One owner's archive, or nothing — never somebody else's. */
export async function getArchive(ownerId: string, archiveId: string): Promise<ArchiveView> {
  const row = await getDb().get<ArchiveRow>('SELECT * FROM memory_archives WHERE id = ? AND owner_user_id = ?', [archiveId, ownerId]);
  if (!row) throw new MemoryNotFound('No such archive.');
  return archiveView(row);
}

export async function listArchives(ownerId: string): Promise<ArchiveView[]> {
  const rows = await getDb().all<ArchiveRow>(
    'SELECT * FROM memory_archives WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 50',
    [ownerId],
  );
  return Promise.all(rows.map(archiveView));
}

function manifestHashOf(entries: readonly ManifestEntry[]): string {
  const canonical = [...entries]
    .map((e) => `${e.externalId}\u0000${e.contentHash}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface OpenArchiveInput {
  ownerId: string;
  label: string;
  sourceFormat: ArchiveSourceFormat;
  entries: ManifestEntry[];
  declaredFiles: number;
  notes: string[];
}

/**
 * Declare what the archive holds. Idempotent by the manifest's own content, so
 * re-opening the same export resumes it rather than counting it twice.
 */
export async function openArchive(input: OpenArchiveInput): Promise<{ archive: ArchiveView; pending: string[] }> {
  const db = getDb();
  const manifestHash = manifestHashOf(input.entries);
  const at = nowIso();
  let row = await db.get<ArchiveRow>(
    'SELECT * FROM memory_archives WHERE owner_user_id = ? AND manifest_hash = ?',
    [input.ownerId, manifestHash],
  );
  if (!row) {
    const id = newId('mar');
    await db.run(
      `INSERT INTO memory_archives (id, owner_user_id, label, source_format, manifest_hash, state,
         declared_conversations, declared_messages, declared_nodes, declared_attachments, declared_files,
         notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'RECEIVING', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, manifest_hash) DO NOTHING`,
      [
        id,
        input.ownerId,
        input.label.slice(0, 200),
        input.sourceFormat,
        manifestHash,
        input.entries.length,
        input.entries.reduce((s, e) => s + e.messages, 0),
        input.entries.reduce((s, e) => s + e.nodes, 0),
        input.entries.reduce((s, e) => s + e.attachments, 0),
        input.declaredFiles,
        toJson(input.notes.slice(0, 200)),
        at,
        at,
      ],
    );
    row = (await db.get<ArchiveRow>(
      'SELECT * FROM memory_archives WHERE owner_user_id = ? AND manifest_hash = ?',
      [input.ownerId, manifestHash],
    ))!;
    for (const entry of input.entries) {
      await db.run(
        `INSERT INTO memory_archive_entries (archive_id, external_id, title, content_hash, declared_nodes,
           declared_messages, declared_attachments, source_updated_at, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DECLARED', ?)
         ON CONFLICT (archive_id, external_id) DO NOTHING`,
        [row.id, entry.externalId, entry.title.slice(0, 500), entry.contentHash, entry.nodes, entry.messages, entry.attachments, entry.updatedAt, at],
      );
    }
    await recordMemoryEvent(input.ownerId, 'ARCHIVE', row.id, 'ARCHIVE_DECLARED', {
      conversations: input.entries.length,
      format: input.sourceFormat,
    });
  }

  // Anything Brain already holds at exactly this content is already done.
  await db.run(
    `UPDATE memory_archive_entries
        SET state = 'UNCHANGED',
            conversation_id = (SELECT c.id FROM memory_conversations c
                                WHERE c.owner_user_id = ? AND c.source = 'CHATGPT'
                                  AND c.external_id = memory_archive_entries.external_id
                                  AND c.content_hash = memory_archive_entries.content_hash),
            updated_at = ?
      WHERE archive_id = ? AND state IN ('DECLARED','FAILED')
        AND EXISTS (SELECT 1 FROM memory_conversations c
                     WHERE c.owner_user_id = ? AND c.source = 'CHATGPT'
                       AND c.external_id = memory_archive_entries.external_id
                       AND c.content_hash = memory_archive_entries.content_hash)`,
    [input.ownerId, at, row.id, input.ownerId],
  );
  const pending = await db.all<{ external_id: string }>(
    `SELECT external_id FROM memory_archive_entries WHERE archive_id = ? AND state IN ('DECLARED','FAILED') ORDER BY external_id`,
    [row.id],
  );
  return { archive: await archiveView(row), pending: pending.map((p) => p.external_id) };
}

/** A raw conversation as a client sends it: an export object, or a Markdown file. */
export type RawConversation = { kind: 'JSON'; value: unknown; format?: 'CHATGPT_OFFICIAL' | 'CHATGPT_EXPORTER' } | { kind: 'MARKDOWN'; name: string; text: string };

export interface IngestOutcome {
  externalId: string;
  outcome: 'CREATED' | 'VERSIONED' | 'UNCHANGED' | 'FAILED';
  conversationId: string | null;
  version: number | null;
  error?: string;
}

function reparse(raw: RawConversation, projectNames: Record<string, string>): ParsedConversation {
  if (raw.kind === 'MARKDOWN') {
    const parsed = parseExporterMarkdown(raw.text, raw.name);
    if (!parsed) throw new Error('The Markdown held no You/ChatGPT turns.');
    return parsed;
  }
  const value = raw.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(value as Record<string, unknown>).mapping) {
    throw new Error('Not a conversation object: it has no message tree (`mapping`).');
  }
  return parseExportConversation(value as Record<string, unknown>, raw.format ?? 'CHATGPT_EXPORTER', projectNames);
}

export async function ingestConversations(input: {
  ownerId: string;
  archiveId: string;
  conversations: RawConversation[];
  projectNames?: Record<string, string>;
}): Promise<IngestOutcome[]> {
  const archive = await getDb().get<{ id: string }>(
    'SELECT id FROM memory_archives WHERE id = ? AND owner_user_id = ?',
    [input.archiveId, input.ownerId],
  );
  if (!archive) throw new MemoryNotFound('No such archive.');
  const outcomes: IngestOutcome[] = [];
  for (const raw of input.conversations.slice(0, MAX_BATCH_CONVERSATIONS)) {
    let parsed: ParsedConversation | null = null;
    try {
      parsed = reparse(raw, input.projectNames ?? {});
      const stored = await storeConversation({ ownerId: input.ownerId, archiveId: input.archiveId, source: 'CHATGPT', parsed });
      outcomes.push(stored);
      await markEntry(input.archiveId, parsed, stored.outcome === 'UNCHANGED' ? 'UNCHANGED' : 'IMPORTED', stored.conversationId, null);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const externalId = parsed?.externalId ?? externalIdGuess(raw);
      outcomes.push({ externalId, outcome: 'FAILED', conversationId: null, version: null, error: message });
      if (parsed) await markEntry(input.archiveId, parsed, 'FAILED', null, message);
      else await markFailedById(input.archiveId, externalId, message);
    }
  }
  return outcomes;
}

function externalIdGuess(raw: RawConversation): string {
  if (raw.kind === 'MARKDOWN') return `md:${raw.name}`;
  const v = raw.value as Record<string, unknown> | null;
  const id = v && typeof v === 'object' ? v.conversation_id ?? v.id : null;
  return typeof id === 'string' ? id : `unreadable-${contentHashOf(JSON.stringify(raw.value) ?? '')}`;
}

async function markEntry(
  archiveId: string,
  parsed: ParsedConversation,
  state: EntryState,
  conversationId: string | null,
  error: string | null,
): Promise<void> {
  const at = nowIso();
  const entry = manifestEntryOf(parsed);
  // A conversation that arrived without being declared is still counted: it is
  // added to the denominator rather than recovered from nowhere.
  await getDb().run(
    `INSERT INTO memory_archive_entries (archive_id, external_id, title, content_hash, declared_nodes,
       declared_messages, declared_attachments, source_updated_at, state, conversation_id, attempts, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (archive_id, external_id) DO UPDATE SET
       state = excluded.state,
       conversation_id = excluded.conversation_id,
       attempts = memory_archive_entries.attempts + 1,
       error = excluded.error,
       updated_at = excluded.updated_at`,
    [archiveId, entry.externalId, entry.title.slice(0, 500), entry.contentHash, entry.nodes, entry.messages, entry.attachments, entry.updatedAt, state, conversationId, error, at],
  );
}

async function markFailedById(archiveId: string, externalId: string, error: string): Promise<void> {
  await getDb().run(
    `UPDATE memory_archive_entries SET state = 'FAILED', attempts = attempts + 1, error = ?, updated_at = ?
      WHERE archive_id = ? AND external_id = ?`,
    [error, nowIso(), archiveId, externalId],
  );
}

interface ConversationRow {
  id: string;
  version: number;
  content_hash: string;
}

/**
 * Store one conversation: new, a new version, or nothing.
 *
 * One transaction per conversation, so an interruption leaves each one either
 * wholly stored at a version or not at all — the checkpoint is the row.
 */
export async function storeConversation(input: {
  ownerId: string;
  archiveId: string | null;
  source: 'CHATGPT' | 'BRIDGE';
  parsed: ParsedConversation;
  /** BRIDGE: the raw record is the bridge's own rows; nothing extra is written to the store. */
  rawHeldElsewhere?: string;
}): Promise<IngestOutcome> {
  const db = getDb();
  const { parsed } = input;
  const existing = await db.get<ConversationRow>(
    'SELECT id, version, content_hash FROM memory_conversations WHERE owner_user_id = ? AND source = ? AND external_id = ?',
    [input.ownerId, input.source, parsed.externalId],
  );
  if (existing && existing.content_hash === parsed.contentHash) {
    // Unchanged content; the source's own clock may still have moved, and a
    // watermark left behind would be read as work on every pass.
    await db.run(
      'UPDATE memory_conversations SET source_updated_at = COALESCE(?, source_updated_at) WHERE id = ?',
      [parsed.updatedAt, existing.id],
    );
    return { externalId: parsed.externalId, outcome: 'UNCHANGED', conversationId: existing.id, version: existing.version };
  }

  const conversationId = existing?.id ?? newId('mcv');
  const version = (existing?.version ?? 0) + 1;

  // The raw object first, outside the transaction: a stored object with no row
  // is harmless and is overwritten identically on retry; a row naming bytes that
  // were never written would be a lie.
  let rawKey: string | null = null;
  let rawBytes = 0;
  if (!input.rawHeldElsewhere) {
    const body = Buffer.from(JSON.stringify(parsed.raw), 'utf8');
    rawBytes = body.byteLength;
    rawKey = `memory/${input.ownerId}/conversations/${conversationId}/v${version}-${parsed.contentHash}.json`;
    await getStorage().put({ key: rawKey, body, contentType: 'application/json', overwrite: true });
  }

  const at = nowIso();
  const said = parsed.nodes.map((n) => n.saidAt).filter((v): v is string => !!v).sort();
  const firstSaid = said[0] ?? parsed.createdAt;
  const lastSaid = said[said.length - 1] ?? parsed.updatedAt ?? parsed.createdAt;

  await db.transaction(async () => {
    if (!existing) {
      await db.run(
        `INSERT INTO memory_conversations (id, owner_user_id, source, external_id, title, source_created_at,
           source_updated_at, project_ref, project_name, current_node_id, version, content_hash, node_count,
           message_count, branch_point_count, alternate_message_count, attachment_count, first_said_at,
           last_said_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          conversationId, input.ownerId, input.source, parsed.externalId, parsed.title.slice(0, 500),
          parsed.createdAt, parsed.updatedAt, parsed.projectRef, parsed.projectName, parsed.currentNodeId,
          version, parsed.contentHash, parsed.nodes.length, parsed.messageCount, parsed.branchPointCount,
          parsed.nodes.filter((n) => !n.onCurrentPath).length, parsed.attachmentCount, firstSaid, lastSaid, at, at,
        ],
      );
    } else {
      await db.run(
        `UPDATE memory_conversations SET title = ?, source_created_at = ?, source_updated_at = ?, project_ref = ?,
           project_name = COALESCE(?, project_name), current_node_id = ?, version = ?, content_hash = ?,
           node_count = ?, message_count = ?, branch_point_count = ?, alternate_message_count = ?,
           attachment_count = ?, first_said_at = ?, last_said_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          parsed.title.slice(0, 500), parsed.createdAt, parsed.updatedAt, parsed.projectRef, parsed.projectName,
          parsed.currentNodeId, version, parsed.contentHash, parsed.nodes.length, parsed.messageCount,
          parsed.branchPointCount, parsed.nodes.filter((n) => !n.onCurrentPath).length, parsed.attachmentCount,
          firstSaid, lastSaid, at, conversationId,
        ],
      );
    }
    await db.run(
      `INSERT INTO memory_conversation_versions (conversation_id, version, content_hash, archive_id, raw_key, raw_bytes, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [conversationId, version, parsed.contentHash, input.archiveId, rawKey ?? input.rawHeldElsewhere ?? null, rawBytes, at],
    );

    const present = new Map<string, { id: string; hash: string }[]>();
    if (existing) {
      const rows = await db.all<{ id: string; node_id: string; content_hash: string }>(
        'SELECT id, node_id, content_hash FROM memory_messages WHERE conversation_id = ? AND superseded_in_version IS NULL',
        [conversationId],
      );
      for (const r of rows) present.set(r.node_id, [...(present.get(r.node_id) ?? []), { id: r.id, hash: r.content_hash }]);
    }

    for (const node of parsed.nodes) {
      const hash = contentHashOf(`${node.role}\u0000${node.contentType}\u0000${node.text}\u0000${node.attachments.map((a) => a.sourceRef).join(',')}`);
      const prior = present.get(node.nodeId) ?? [];
      const same = prior.find((p) => p.hash === hash);
      let messageId: string;
      if (same) {
        messageId = same.id;
        // Placement can move between exports (a new branch elsewhere); keep it current.
        await db.run(
          'UPDATE memory_messages SET on_current_path = ?, sibling_index = ?, sibling_count = ?, depth = ? WHERE id = ?',
          [node.onCurrentPath ? 1 : 0, node.siblingIndex, node.siblingCount, node.depth, messageId],
        );
      } else {
        for (const old of prior) {
          await db.run('UPDATE memory_messages SET superseded_in_version = ? WHERE id = ?', [version, old.id]);
        }
        messageId = newId('mms');
        await db.run(
          `INSERT INTO memory_messages (id, conversation_id, owner_user_id, node_id, parent_node_id, depth, sibling_index,
             sibling_count, on_current_path, role, author_name, recipient, content_type, text, content_hash, said_at,
             source_updated_at, model_slug, hidden, metadata, first_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (conversation_id, node_id, content_hash) DO NOTHING`,
          [
            messageId, conversationId, input.ownerId, node.nodeId, node.parentId, node.depth, node.siblingIndex,
            node.siblingCount, node.onCurrentPath ? 1 : 0, node.role, node.authorName, node.recipient,
            node.contentType, node.text, hash, node.saidAt, node.updatedAt, node.modelSlug, node.hidden ? 1 : 0,
            toJson(node.metadata), version, at,
          ],
        );
      }
      for (const attachment of node.attachments) {
        await db.run(
          `INSERT INTO memory_attachments (id, owner_user_id, conversation_id, message_id, kind, source_ref, name,
             mime_type, size_bytes, width, height, metadata, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REFERENCED_ONLY', ?, ?)
           ON CONFLICT (message_id, source_ref) DO NOTHING`,
          [
            newId('mat'), input.ownerId, conversationId, messageId, attachment.kind, attachment.sourceRef.slice(0, 300),
            attachment.name, attachment.mimeType, attachment.sizeBytes, attachment.width, attachment.height,
            toJson(attachment.metadata), at, at,
          ],
        );
      }
    }
  });

  // Bytes already held for a file this conversation now references (the same
  // image in two conversations, or a file sent before its conversation).
  await db.run(
    `UPDATE memory_attachments
        SET state = 'RECOVERED',
            storage_key = (SELECT r.storage_key FROM memory_attachments r WHERE r.owner_user_id = memory_attachments.owner_user_id
                             AND r.source_ref = memory_attachments.source_ref AND r.state = 'RECOVERED' LIMIT 1),
            byte_hash = (SELECT r.byte_hash FROM memory_attachments r WHERE r.owner_user_id = memory_attachments.owner_user_id
                             AND r.source_ref = memory_attachments.source_ref AND r.state = 'RECOVERED' LIMIT 1),
            updated_at = ?
      WHERE conversation_id = ? AND state = 'REFERENCED_ONLY'
        AND EXISTS (SELECT 1 FROM memory_attachments r WHERE r.owner_user_id = memory_attachments.owner_user_id
                      AND r.source_ref = memory_attachments.source_ref AND r.state = 'RECOVERED')`,
    [nowIso(), conversationId],
  );

  await recordMemoryEvent(input.ownerId, 'CONVERSATION', conversationId, existing ? 'CONVERSATION_VERSIONED' : 'CONVERSATION_IMPORTED', {
    version,
    nodes: parsed.nodes.length,
    archiveId: input.archiveId,
    notes: parsed.notes.length,
  });
  return {
    externalId: parsed.externalId,
    outcome: existing ? 'VERSIONED' : 'CREATED',
    conversationId,
    version,
  };
}

/**
 * The bytes of one file the archive held, matched to every message that
 * references it by its export id. Content-addressed in the store, so the same
 * image sent twice is one object.
 */
export async function storeAttachment(input: {
  ownerId: string;
  sourceRef: string;
  fileName: string;
  mimeType: string | null;
  bytes: Buffer;
}): Promise<{ matched: number; state: 'RECOVERED' | 'UNREFERENCED' | 'TOO_LARGE' }> {
  const db = getDb();
  const refs = await db.all<{ id: string }>(
    'SELECT id FROM memory_attachments WHERE owner_user_id = ? AND source_ref = ?',
    [input.ownerId, input.sourceRef],
  );
  if (refs.length === 0) return { matched: 0, state: 'UNREFERENCED' };
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    await db.run(
      `UPDATE memory_attachments SET state = 'FAILED', failure = ?, updated_at = ? WHERE owner_user_id = ? AND source_ref = ? AND state <> 'RECOVERED'`,
      [`${input.bytes.byteLength} bytes is over the ${MAX_ATTACHMENT_BYTES}-byte per-file limit.`, nowIso(), input.ownerId, input.sourceRef],
    );
    return { matched: refs.length, state: 'TOO_LARGE' };
  }
  const byteHash = createHash('sha256').update(input.bytes).digest('hex');
  const extension = /\.([a-z0-9]{1,8})$/i.exec(input.fileName)?.[1]?.toLowerCase() ?? 'bin';
  const key = `memory/${input.ownerId}/files/${byteHash}.${extension}`;
  await getStorage().put({
    key,
    body: input.bytes,
    contentType: input.mimeType ?? 'application/octet-stream',
    originalFilename: input.fileName.slice(0, 200),
    overwrite: true,
  });
  await db.run(
    `UPDATE memory_attachments SET state = 'RECOVERED', storage_key = ?, byte_hash = ?, failure = NULL,
       name = COALESCE(name, ?), mime_type = COALESCE(mime_type, ?), size_bytes = COALESCE(size_bytes, ?), updated_at = ?
     WHERE owner_user_id = ? AND source_ref = ?`,
    [key, byteHash, input.fileName.slice(0, 300), input.mimeType, input.bytes.byteLength, nowIso(), input.ownerId, input.sourceRef],
  );
  return { matched: refs.length, state: 'RECOVERED' };
}

export async function completeArchive(ownerId: string, archiveId: string): Promise<ArchiveView> {
  const view = await getArchive(ownerId, archiveId);
  await getDb().run(
    `UPDATE memory_archives SET state = 'COMPLETE', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), archiveId],
  );
  await recordMemoryEvent(ownerId, 'ARCHIVE', archiveId, 'ARCHIVE_COMPLETED', { entries: view.entries });
  return getArchive(ownerId, archiveId);
}

// ---------------------------------------------------------------------------
// The bridge: conversations synced live are part of the same history.
// ---------------------------------------------------------------------------
interface BridgeConversationRow {
  id: string;
  owner_user_id: string;
  title: string;
  updated_at: string;
  created_at: string;
}

interface BridgeMessageRow {
  id: string;
  ordinal: number;
  revision: number;
  external_id: string | null;
  role: string;
  author_label: string | null;
  content: string;
  said_at: string | null;
  received_at: string;
  superseded_at: string | null;
}

/**
 * Bring bridge-synced conversations into the history, as source BRIDGE.
 *
 * The bridge's own rows are the original record, so nothing is copied to the
 * store; a conversation's version moves when the bridge holds more than the
 * history does. Superseded revisions become alternate siblings — the edit is
 * kept, beside what replaced it.
 */
export async function absorbBridgeConversations(ownerId: string | null, limit = 25): Promise<number> {
  const db = getDb();
  const rows = await db.all<BridgeConversationRow>(
    `SELECT b.id, b.owner_user_id, b.title, b.updated_at, b.created_at
       FROM bridge_conversations b
       LEFT JOIN memory_conversations m
         ON m.owner_user_id = b.owner_user_id AND m.source = 'BRIDGE' AND m.external_id = b.id
      WHERE ${ownerId ? 'b.owner_user_id = ? AND' : ''} b.message_count > 0
        AND (m.id IS NULL OR m.source_updated_at IS NULL OR m.source_updated_at < b.updated_at)
      ORDER BY b.updated_at
      LIMIT ?`,
    ownerId ? [ownerId, limit] : [limit],
  );
  let absorbed = 0;
  for (const row of rows) {
    const messages = await db.all<BridgeMessageRow>(
      `SELECT id, ordinal, revision, external_id, role, author_label, content, said_at, received_at, superseded_at
         FROM bridge_messages WHERE conversation_id = ? ORDER BY ordinal, revision`,
      [row.id],
    );
    const parsed = bridgeAsConversation(row, messages);
    await storeConversation({ ownerId: row.owner_user_id, archiveId: null, source: 'BRIDGE', parsed, rawHeldElsewhere: `bridge:${row.id}` });
    absorbed += 1;
  }
  return absorbed;
}

export function bridgeAsConversation(row: BridgeConversationRow, messages: BridgeMessageRow[]): ParsedConversation {
  const byOrdinal = new Map<number, BridgeMessageRow[]>();
  for (const m of messages) byOrdinal.set(m.ordinal, [...(byOrdinal.get(m.ordinal) ?? []), m]);
  const ordinals = [...byOrdinal.keys()].sort((a, b) => a - b);
  const nodes: ParsedConversation['nodes'] = [];
  let parentLive: string | null = null;
  for (const ordinal of ordinals) {
    const revisions = byOrdinal.get(ordinal)!;
    const live = revisions.find((r) => !r.superseded_at) ?? revisions[revisions.length - 1]!;
    revisions.forEach((revision, index) => {
      nodes.push({
        nodeId: revision.id,
        parentId: parentLive,
        depth: ordinal,
        siblingIndex: index,
        siblingCount: revisions.length,
        onCurrentPath: revision.id === live.id,
        role: (['USER', 'ASSISTANT', 'SYSTEM', 'TOOL'].includes(revision.role) ? revision.role : 'UNKNOWN') as ParsedConversation['nodes'][number]['role'],
        authorName: revision.author_label,
        recipient: null,
        contentType: 'text',
        text: revision.content,
        saidAt: revision.said_at ?? revision.received_at,
        updatedAt: null,
        modelSlug: null,
        hidden: false,
        metadata: { bridgeOrdinal: ordinal, bridgeRevision: revision.revision, externalId: revision.external_id },
        attachments: [],
      });
    });
    parentLive = live.id;
  }
  const signature = messages.map((m) => `${m.id}:${m.revision}:${m.superseded_at ?? ''}`).join('|');
  return {
    externalId: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectRef: null,
    projectName: null,
    currentNodeId: parentLive,
    format: 'CHATGPT_EXPORTER',
    nodes,
    messageCount: nodes.length,
    branchPointCount: [...byOrdinal.values()].filter((r) => r.length > 1).length,
    attachmentCount: 0,
    contentHash: contentHashOf(signature),
    notes: [],
    raw: null,
  };
}
