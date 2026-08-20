/**
 * Importing an existing research archive.
 *
 * Forty-odd documents in nested folders, synced from a Drive folder onto the
 * user's own machine. This is not a bigger drag-and-drop: it takes minutes, the
 * user will close the laptop halfway through, and OCR will fail on at least one
 * scan. So the shape of it is a persisted job with a row per file, worked one at
 * a time, with every state change written as it happens.
 *
 * The guarantees that matter:
 *
 *   - A file that finished stays finished. Cancel, restart, crash — resuming
 *     continues from the first unfinished file and never re-reads the rest.
 *   - No file is silently skipped. Every discovered file ends in exactly one
 *     recorded state, including the ones Brain cannot read, with the reason.
 *   - Identical bytes never become two pieces of evidence. A duplicate is
 *     recorded as a duplicate of the document it matches, with both paths kept.
 *   - Originals are never moved or renamed in the user's folder. Brain copies
 *     what it registers and leaves the archive exactly as it found it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DocumentScope, ImportFile, ImportJob } from '../../domain/types.ts';
import { getProject } from '../../repos/projects.ts';
import { getDocument, updateDocument } from '../../repos/documents.ts';
import { recordEvent } from '../../repos/events.ts';
import {
  createImportJob,
  findImportedByHash,
  getImportFile,
  getImportJob,
  insertDiscoveredFiles,
  listImportFiles,
  listUnfinishedImportJobs,
  nextPendingFile,
  recountImportJob,
  retryableFiles,
  updateImportFile,
  updateImportJob,
} from '../../repos/imports.ts';
import { getCurrentExtractionRun } from '../../repos/extraction.ts';
import { detectFormat } from '../documents/formats.ts';
import { enqueueExtraction } from '../documents/queue.ts';
import { isAuditable } from '../documents/quality.ts';
import { hashBuffer } from '../storage.ts';
import { importFile as importOneFile, importProjectSource } from '../importer.ts';
import { ingestSource } from '../sources/ingest.ts';
import { recomputeProject } from '../stateEngine.ts';

/** Extensions Brain can read. Anything else is recorded as unsupported, never skipped. */
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.text']);

/** Names that are never research documents. */
const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', 'icon\r']);

/** Guard against a pathological tree; deeper than this is not a research folder. */
const MAX_DEPTH = 12;

/** A ceiling on one job, high enough for a real archive and low enough to stop a mistake. */
export const MAX_ARCHIVE_FILES = 5_000;

/** Per-file ceiling, matching the upload path. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface DiscoveredEntry {
  absolutePath: string;
  relativePath: string;
  filename: string;
  fileSize: number | null;
  sourceModifiedAt: string | null;
  supported: boolean;
}

/**
 * Walk the folder the user chose.
 *
 * Symlinks are not followed: a synced folder can contain a link back to itself,
 * and a discovery pass that loops is worse than one that misses a shortcut.
 */
export function discoverFiles(root: string, depth = 0, base = root): DiscoveredEntry[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: DiscoveredEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Hidden and system folders are not research folders.
      if (entry.name.startsWith('.')) continue;
      found.push(...discoverFiles(absolute, depth + 1, base));
      continue;
    }
    if (!entry.isFile()) continue;
    if (IGNORED_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;

    let size: number | null = null;
    let modified: string | null = null;
    try {
      const stat = fs.statSync(absolute);
      size = stat.size;
      modified = new Date(stat.mtimeMs).toISOString();
    } catch {
      // Unreadable stat is not a reason to drop the file: it is recorded and the
      // read attempt will produce the real error.
    }

    found.push({
      absolutePath: absolute,
      relativePath: path.relative(base, absolute).split(path.sep).join('/'),
      filename: entry.name,
      fileSize: size,
      sourceModifiedAt: modified,
      supported: SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    });
    if (found.length >= MAX_ARCHIVE_FILES) break;
  }
  return found;
}

export interface StartArchiveImportInput {
  projectId: string;
  /** The folder as the user typed or picked it. */
  folder: string;
  /** What these documents are: layer reports, or project-wide sources. */
  scope?: DocumentScope;
}

/**
 * Create the job and record what is in the folder. Nothing is read yet.
 *
 * Discovery is separate from processing so the user sees the true size of the
 * job — including the unsupported files — before any minutes are spent on it.
 */
export function startArchiveImport(input: StartArchiveImportInput): ImportJob {
  const project = getProject(input.projectId);
  if (!project) throw new Error(`Unknown project ${input.projectId}`);

  const folder = input.folder.trim();
  if (folder.length === 0) throw new Error('Choose the folder your research documents are in.');

  const resolved = path.resolve(folder);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(
      `There is no folder at ${folder}. If it is a Drive folder, make sure Drive for Desktop has ` +
        'finished syncing it and that it is available offline.',
    );
  }
  if (!stat.isDirectory()) throw new Error(`${folder} is a file, not a folder.`);

  const job = createImportJob({
    projectId: project.id,
    sourceLabel: folder,
    rootPath: resolved,
    ...(input.scope ? { scope: input.scope } : {}),
  });

  const entries = discoverFiles(resolved);
  insertDiscoveredFiles(
    entries.map((entry) => ({
      jobId: job.id,
      projectId: project.id,
      absolutePath: entry.absolutePath,
      relativePath: entry.relativePath,
      filename: entry.filename,
      fileSize: entry.fileSize,
      sourceModifiedAt: entry.sourceModifiedAt,
    })),
  );

  // Unsupported files are settled at discovery: there is nothing to try later,
  // and leaving them pending would make the job look permanently unfinished.
  for (const file of listImportFiles(job.id)) {
    const entry = entries.find((candidate) => candidate.relativePath === file.relativePath);
    if (entry && !entry.supported) {
      updateImportFile(file.id, {
        status: 'UNSUPPORTED',
        detail: `Brain cannot read ${path.extname(entry.filename) || 'this file type'} yet, so it was left in place and not imported.`,
        completedAt: new Date().toISOString(),
      });
    }
  }

  updateImportJob(job.id, {
    status: entries.length === 0 ? 'COMPLETE' : 'QUEUED',
    message:
      entries.length === 0
        ? 'No supported documents were found in that folder.'
        : `${entries.length} file(s) found.`,
    ...(entries.length === 0 ? { completedAt: new Date().toISOString() } : {}),
  });
  recountImportJob(job.id);

  recordEvent({
    projectId: project.id,
    entityType: 'PROJECT',
    entityId: project.id,
    eventType: 'ARCHIVE_IMPORT_STARTED',
    payload: { jobId: job.id, folder, discovered: entries.length },
  });

  return getImportJob(job.id)!;
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<ImportJob>>();
const cancelled = new Set<string>();

export interface ProcessOptions {
  /** Stop after this many files; the rest stay queued. Used for bounded batches. */
  limit?: number;
  onProgress?: (job: ImportJob, file: ImportFile) => void;
}

/**
 * Work the job's files, one at a time, until they are all settled.
 *
 * Serial on purpose: extraction and OCR are the expensive parts and they already
 * queue internally, so reading four PDFs at once only makes the first one slower.
 */
export function processArchiveImport(
  jobId: string,
  options: ProcessOptions = {},
): Promise<ImportJob> {
  const existing = running.get(jobId);
  if (existing) return existing;
  const promise = drain(jobId, options).finally(() => {
    running.delete(jobId);
  });
  running.set(jobId, promise);
  promise.catch(() => undefined);
  return promise;
}

async function drain(jobId: string, options: ProcessOptions): Promise<ImportJob> {
  const job = getImportJob(jobId);
  if (!job) throw new Error(`Unknown import job ${jobId}`);
  cancelled.delete(jobId);

  updateImportJob(jobId, {
    status: 'RUNNING',
    startedAt: job.startedAt ?? new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    cancelReason: null,
  });

  let processed = 0;
  for (;;) {
    if (cancelled.has(jobId)) break;
    if (options.limit !== undefined && processed >= options.limit) break;

    const file = nextPendingFile(jobId);
    if (!file) break;

    await processOneFile(jobId, file);
    processed += 1;
    const updated = recountImportJob(jobId);
    updateImportJob(jobId, { heartbeatAt: new Date().toISOString() });
    const after = getImportFile(file.id);
    if (updated && after) options.onProgress?.(updated, after);
  }

  const remaining = nextPendingFile(jobId);
  const wasCancelled = cancelled.has(jobId);
  cancelled.delete(jobId);

  const final = recountImportJob(jobId)!;
  if (wasCancelled) {
    updateImportJob(jobId, {
      status: 'CANCELLED',
      message:
        `Stopped after ${final.processed} of ${final.discovered} file(s). ` +
        'Everything already imported was kept; resume to continue with the rest.',
    });
  } else if (!remaining) {
    updateImportJob(jobId, {
      status: 'COMPLETE',
      completedAt: new Date().toISOString(),
      message:
        `${final.registered} registered, ${final.duplicates} duplicate(s), ` +
        `${final.unsupported} unsupported, ${final.unreadable} unreadable, ${final.failed} failed.`,
    });
  } else {
    updateImportJob(jobId, { status: 'PAUSED', message: 'Paused with files still to read.' });
  }

  const done = getImportJob(jobId)!;
  if (done.status === 'COMPLETE' || done.status === 'CANCELLED') {
    recomputeProject(done.projectId);
    recordEvent({
      projectId: done.projectId,
      entityType: 'PROJECT',
      entityId: done.projectId,
      eventType: 'ARCHIVE_IMPORT_COMPLETED',
      payload: {
        jobId,
        status: done.status,
        registered: done.registered,
        duplicates: done.duplicates,
        unsupported: done.unsupported,
        unreadable: done.unreadable,
        failed: done.failed,
      },
    });
  }
  return done;
}

/**
 * One file, start to finish, with its outcome written before the next begins.
 *
 * Every branch ends in a settled state and a sentence explaining it, because the
 * import report is the only place a user will ever see why a particular document
 * is not in their project.
 */
async function processOneFile(jobId: string, file: ImportFile): Promise<void> {
  const job = getImportJob(jobId)!;
  updateImportFile(file.id, {
    status: 'EXTRACTING',
    startedAt: new Date().toISOString(),
    attempts: file.attempts + 1,
  });

  let contents: Buffer;
  try {
    const stat = fs.statSync(file.absolutePath);
    if (stat.size > MAX_FILE_BYTES) {
      updateImportFile(file.id, {
        status: 'UNSUPPORTED',
        fileSize: stat.size,
        detail: `The file is ${Math.round(stat.size / (1024 * 1024))} MB, above the 50 MB limit.`,
        completedAt: new Date().toISOString(),
      });
      return;
    }
    contents = fs.readFileSync(file.absolutePath);
  } catch (error) {
    updateImportFile(file.id, {
      status: 'FAILED',
      detail: `The file could not be read from disk: ${message(error)}`,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const hash = hashBuffer(contents);
  const detection = detectFormat(file.filename, contents);
  updateImportFile(file.id, {
    fileHash: hash,
    fileSize: contents.byteLength,
    detectedFormat: detection.format,
  });

  if (detection.format === 'UNSUPPORTED') {
    updateImportFile(file.id, {
      status: 'UNSUPPORTED',
      detail: `Brain could not tell what this file is (${detection.reason}), so it was left alone.`,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  // Identical bytes already imported: recorded as a duplicate, both paths kept.
  const twin = findImportedByHash(job.projectId, hash);
  if (twin && twin.id !== file.id) {
    updateImportFile(file.id, {
      status: 'DUPLICATE',
      duplicateOfId: twin.documentId,
      detail:
        `Byte-for-byte identical to ${twin.relativePath}, which is already registered. ` +
        'It was left in place rather than imported twice.',
      completedAt: new Date().toISOString(),
    });
    return;
  }

  try {
    // Filename inference gets first refusal, because a file confidently named
    // "World Model v1B.pdf" belongs in that layer and nothing is gained by
    // routing it the long way round.
    const byName =
      job.scope === 'LAYER'
        ? importOneFile({
            projectId: job.projectId,
            originalFilename: file.filename,
            contents,
            notes: `Imported from ${file.relativePath}`,
          })
        : null;

    if (byName?.duplicateOfDocumentId) {
      updateImportFile(file.id, {
        status: 'DUPLICATE',
        duplicateOfId: byName.duplicateOfDocumentId,
        detail: byName.message,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // Everything else is registered as a project-wide source and classified from
    // its contents (section 5.6). This is the whole difference between an
    // archive import and a drag-and-drop: a folder of forty documents whose
    // names say nothing must still be read, not parked unregistered awaiting
    // forty manual decisions. The proposals it produces are reviewable, and a
    // document that spans layers is never forced into one.
    const registration =
      byName?.documentId
        ? { documentId: byName.documentId, message: byName.message, inference: byName.inference,
            requiresConfirmation: byName.requiresConfirmation, projectScoped: false }
        : (() => {
            const source = importProjectSource({
              projectId: job.projectId,
              originalFilename: file.filename,
              contents,
              scope: job.scope === 'LAYER' ? 'PROJECT_SOURCE' : job.scope,
              notes: `Imported from ${file.relativePath}`,
            });
            return {
              documentId: source.documentId,
              message: source.message,
              inference: byName?.inference ?? source.inference,
              requiresConfirmation: true,
              projectScoped: true,
              duplicateOf: source.duplicateOfDocumentId,
            };
          })();

    if (!registration.documentId) {
      const duplicateOf = (registration as { duplicateOf?: string | null }).duplicateOf ?? null;
      updateImportFile(file.id, {
        status: duplicateOf ? 'DUPLICATE' : 'NEEDS_REVIEW',
        duplicateOfId: duplicateOf,
        needsConfirmation: !duplicateOf,
        classification: registration.inference,
        detail: registration.message,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // Provenance travels with the document, not only with the import job.
    updateDocument(registration.documentId, {
      importJobId: job.id,
      sourcePath: file.relativePath,
      sourceModifiedAt: file.sourceModifiedAt,
    });

    // Reading it is the point of importing it.
    const extraction = await enqueueExtraction(registration.documentId);
    const run = getCurrentExtractionRun(registration.documentId) ?? extraction.run;
    const readable = isAuditable(run.status);

    // Classification reads the contents, and only once they have been read.
    let proposals = 0;
    if (registration.projectScoped && readable) {
      const report = await ingestSource({
        documentId: registration.documentId,
        scope: job.scope === 'LAYER' ? 'PROJECT_SOURCE' : job.scope,
      });
      proposals = report.proposedLinks;
    }

    updateImportFile(file.id, {
      status: readable ? 'REGISTERED' : 'UNREADABLE',
      documentId: registration.documentId,
      extractionStatus: run.status,
      pages: run.pagesExpected,
      ocrPages: run.pagesOcr,
      warnings: run.warnings,
      classification: registration.inference,
      needsConfirmation: registration.requiresConfirmation && readable,
      detail: readable
        ? registration.projectScoped
          ? `Registered and read. ${proposals} layer link(s) proposed from its contents, awaiting review.`
          : registration.message
        : (run.blockedReason ??
          'The file was registered but Brain could not read it, so it is not evidence yet.'),
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    updateImportFile(file.id, {
      status: 'FAILED',
      detail: message(error),
      completedAt: new Date().toISOString(),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stop the job after the file in flight. Everything finished stays finished. */
export function cancelArchiveImport(jobId: string, reason: string): ImportJob | null {
  const job = getImportJob(jobId);
  if (!job) return null;
  cancelled.add(jobId);
  updateImportJob(jobId, { cancelReason: reason });
  if (!running.has(jobId)) {
    updateImportJob(jobId, {
      status: 'CANCELLED',
      message: 'Cancelled before it started. Nothing was imported.',
    });
  }
  return getImportJob(jobId);
}

/** Continue a paused, cancelled or interrupted job from the first unfinished file. */
export function resumeArchiveImport(jobId: string, options: ProcessOptions = {}): Promise<ImportJob> {
  const job = getImportJob(jobId);
  if (!job) throw new Error(`Unknown import job ${jobId}`);
  cancelled.delete(jobId);
  updateImportJob(jobId, { status: 'QUEUED', cancelReason: null });
  return processArchiveImport(jobId, options);
}

/**
 * Try the failures again, and only the failures.
 *
 * A retry that re-read the whole folder would spend the user's time proving what
 * the job already recorded. Successful files are not touched.
 */
export function retryFailedFiles(jobId: string, options: ProcessOptions = {}): Promise<ImportJob> {
  const files = retryableFiles(jobId);
  for (const file of files) {
    updateImportFile(file.id, { status: 'QUEUED', detail: null, completedAt: null });
  }
  recountImportJob(jobId);
  return resumeArchiveImport(jobId, options);
}

/**
 * Close out jobs a dead process left running.
 *
 * Called at boot, alongside the extraction and research recoveries. The file
 * that was mid-read goes back to the queue; everything already settled stays
 * settled, so resuming costs only the file that was lost.
 */
export function recoverInterruptedImports(): number {
  const jobs = listUnfinishedImportJobs().filter((job) => !running.has(job.id));
  for (const job of jobs) {
    for (const file of listImportFiles(job.id)) {
      if (file.status === 'EXTRACTING' || file.status === 'OCR') {
        updateImportFile(file.id, {
          status: 'QUEUED',
          detail: 'The server stopped while this file was being read; it will be read again.',
          startedAt: null,
        });
      }
    }
    recountImportJob(job.id);
    updateImportJob(job.id, {
      status: 'PAUSED',
      message:
        'Interrupted by a restart. Everything already imported was kept — resume to continue ' +
        'with the files that were not reached.',
    });
  }
  return jobs.length;
}

/** The report a person reads: counts, and the files that need them. */
export interface ImportReport {
  job: ImportJob;
  files: ImportFile[];
  byStatus: Record<string, number>;
  needsAttention: ImportFile[];
}

export function importReport(jobId: string): ImportReport | null {
  const job = getImportJob(jobId);
  if (!job) return null;
  const files = listImportFiles(jobId);
  const byStatus: Record<string, number> = {};
  for (const file of files) byStatus[file.status] = (byStatus[file.status] ?? 0) + 1;
  return {
    job,
    files,
    byStatus,
    needsAttention: files.filter((file) =>
      ['FAILED', 'UNREADABLE', 'NEEDS_REVIEW', 'UNSUPPORTED'].includes(file.status),
    ),
  };
}

/** Documents that came from one import, for the reconciliation stage. */
export function importedDocuments(jobId: string): string[] {
  return listImportFiles(jobId)
    .map((file) => file.documentId)
    .filter((id): id is string => id !== null)
    .filter((id) => getDocument(id) !== null);
}
