/**
 * Sending an archive to Brain, the same way from a browser and a terminal.
 *
 * Environment-neutral: it takes the archive's files as name → bytes readers
 * (a zip opened with JSZip, or a folder read from disk) and a `post` function,
 * and does the rest — read, declare the manifest, send only what Brain does
 * not already hold, in size-bounded batches, then the files messages refer to.
 * Run it again with the same export and it resumes: Brain answers which
 * conversations are still pending and only those are sent.
 */
import {
  manifestEntryOf,
  matchArchiveFile,
  parseArchive,
  type ArchiveFileText,
  type ParsedConversation,
} from './parse.ts';

export interface ArchiveEntrySource {
  name: string;
  size: number | null;
  text(): Promise<string>;
  base64(): Promise<string>;
}

export interface UploadProgress {
  phase: 'READING' | 'DECLARING' | 'CONVERSATIONS' | 'FILES' | 'DONE';
  done: number;
  total: number;
  message: string;
}

export interface UploadSummary {
  archiveId: string;
  declared: number;
  sent: number;
  alreadyHeld: number;
  failed: { externalId: string; error: string }[];
  filesSent: number;
  filesTooLarge: number;
  filesMissing: number;
  unreadable: { name: string; reason: string }[];
  notes: string[];
}

type Post = <T>(path: string, body: unknown) => Promise<T>;

const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_MAX = 100;
const FILE_LIMIT = 7 * 1024 * 1024;
const TEXT_FILE = /\.(json|md|markdown)$/i;
const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$)|chat\.html$/i;

export async function uploadArchive(input: {
  label: string;
  entries: ArchiveEntrySource[];
  post: Post;
  progress?: (p: UploadProgress) => void;
}): Promise<UploadSummary> {
  const report = input.progress ?? (() => undefined);
  const usable = input.entries.filter((e) => !IGNORED.test(e.name));
  const textEntries = usable.filter((e) => TEXT_FILE.test(e.name));
  const binaryEntries = usable.filter((e) => !TEXT_FILE.test(e.name) && !/\.(html|txt)$/i.test(e.name));

  const files: ArchiveFileText[] = [];
  for (const [index, entry] of textEntries.entries()) {
    report({ phase: 'READING', done: index, total: textEntries.length, message: `Reading ${entry.name}` });
    files.push({ name: entry.name, text: await entry.text() });
  }
  const parsed = parseArchive(files, binaryEntries.map((e) => e.name));
  if (parsed.conversations.length === 0) {
    throw new Error(
      'No conversations were found. Choose the ChatGPT export zip (it contains conversations.json), or ChatGPTExporter JSON / Markdown files.',
    );
  }

  report({ phase: 'DECLARING', done: 0, total: parsed.conversations.length, message: 'Declaring the archive to Brain' });
  const sourceFormat = parsed.format;
  const opened = await input.post<{ archive: { id: string }; pending: string[] }>('/api/memory/archives', {
    label: input.label,
    sourceFormat,
    entries: parsed.conversations.map(manifestEntryOf),
    declaredFiles: binaryEntries.length,
    notes: [...parsed.notes, ...parsed.unreadable.map((u) => `${u.name}: ${u.reason}`)].slice(0, 200),
  });
  const pending = new Set(opened.pending);
  const toSend = parsed.conversations.filter((c) => pending.has(c.externalId));
  const projectNames: Record<string, string> = {};
  for (const c of parsed.conversations) if (c.projectRef && c.projectName) projectNames[c.projectRef] = c.projectName;

  const summary: UploadSummary = {
    archiveId: opened.archive.id,
    declared: parsed.conversations.length,
    sent: 0,
    alreadyHeld: parsed.conversations.length - toSend.length,
    failed: [],
    filesSent: 0,
    filesTooLarge: 0,
    filesMissing: 0,
    unreadable: parsed.unreadable,
    notes: parsed.notes,
  };

  // Oldest last: the owner's priority is summer 2025 onward, so newest first.
  toSend.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  let batch: ParsedConversation[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const body = {
      projectNames,
      conversations: batch.map((c) =>
        c.format === 'CHATGPT_MARKDOWN'
          ? { kind: 'MARKDOWN', name: (c.raw as { fileName: string }).fileName, text: (c.raw as { markdown: string }).markdown }
          : { kind: 'JSON', value: c.raw, format: c.format },
      ),
    };
    const answer = await input.post<{ results: { externalId: string; outcome: string; error?: string }[] }>(
      `/api/memory/archives/${encodeURIComponent(opened.archive.id)}/conversations`,
      body,
    );
    for (const r of answer.results) {
      if (r.outcome === 'FAILED') summary.failed.push({ externalId: r.externalId, error: r.error ?? 'unknown' });
      else summary.sent += 1;
    }
    report({ phase: 'CONVERSATIONS', done: summary.sent + summary.failed.length, total: toSend.length, message: 'Sending conversations' });
    batch = [];
    bytes = 0;
  };
  for (const conversation of toSend) {
    const size = JSON.stringify(conversation.raw).length;
    if (batch.length > 0 && (bytes + size > BATCH_BYTES || batch.length >= BATCH_MAX)) await flush();
    batch.push(conversation);
    bytes += size;
  }
  await flush();

  // The files messages refer to, matched by the export's own file ids.
  const refs = new Map<string, string>();
  for (const c of parsed.conversations) {
    for (const node of c.nodes) for (const a of node.attachments) if (!refs.has(a.sourceRef)) refs.set(a.sourceRef, a.mimeType ?? '');
  }
  const names = binaryEntries.map((e) => e.name);
  let index = 0;
  for (const [sourceRef, mime] of refs) {
    index += 1;
    const match = matchArchiveFile(sourceRef, names);
    if (!match) {
      summary.filesMissing += 1;
      continue;
    }
    const entry = binaryEntries.find((e) => e.name === match)!;
    report({ phase: 'FILES', done: index, total: refs.size, message: `Sending ${match}` });
    if (entry.size !== null && entry.size > FILE_LIMIT) {
      await input.post('/api/memory/attachments', { sourceRef, fileName: match, mimeType: mime || null, size: entry.size });
      summary.filesTooLarge += 1;
      continue;
    }
    const result = await input.post<{ state: string }>('/api/memory/attachments', {
      sourceRef,
      fileName: match.split('/').pop(),
      mimeType: mime || null,
      base64: await entry.base64(),
    });
    if (result.state === 'RECOVERED') summary.filesSent += 1;
    else if (result.state === 'TOO_LARGE') summary.filesTooLarge += 1;
  }

  await input.post(`/api/memory/archives/${encodeURIComponent(opened.archive.id)}/complete`, {});
  await input.post('/api/memory/process', {}).catch(() => undefined);
  report({ phase: 'DONE', done: 1, total: 1, message: 'Imported' });
  return summary;
}
