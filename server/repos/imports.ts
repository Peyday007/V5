/**
 * Data access for folder imports.
 *
 * Every write here happens while the import is running rather than at the end,
 * because the whole point of the job rows is that an interrupted import can say
 * exactly what it had already done. A file's row is updated the moment its state
 * changes, and the job's counters are re-derived from its files rather than
 * incremented in memory — a counter that drifts from the rows it summarises is
 * worse than no counter.
 */
import { getDb } from '../db/database.ts';
import type {
  DocumentFormat,
  DocumentScope,
  ExtractionStatus,
  ImportFile,
  ImportFileRow,
  ImportFileStatus,
  ImportJob,
  ImportJobRow,
  ImportJobStatus,
} from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

function mapJob(row: ImportJobRow): ImportJob {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceLabel: row.source_label,
    rootPath: row.root_path,
    status: row.status as ImportJobStatus,
    scope: row.scope as DocumentScope,
    discovered: Number(row.discovered),
    processed: Number(row.processed),
    registered: Number(row.registered),
    duplicates: Number(row.duplicates),
    unsupported: Number(row.unsupported),
    unreadable: Number(row.unreadable),
    failed: Number(row.failed),
    needsReview: Number(row.needs_review),
    message: row.message,
    cancelReason: row.cancel_reason,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFile(row: ImportFileRow): ImportFile {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    absolutePath: row.absolute_path,
    relativePath: row.relative_path,
    filename: row.filename,
    fileSize: row.file_size === null ? null : Number(row.file_size),
    fileHash: row.file_hash,
    detectedFormat: (row.detected_format as DocumentFormat | null) ?? null,
    sourceModifiedAt: row.source_modified_at,
    status: row.status as ImportFileStatus,
    documentId: row.document_id,
    duplicateOfId: row.duplicate_of_id,
    extractionStatus: (row.extraction_status as ExtractionStatus | null) ?? null,
    extractionMethod: row.extraction_method,
    pages: row.pages === null ? null : Number(row.pages),
    ocrPages: row.ocr_pages === null ? null : Number(row.ocr_pages),
    detail: row.detail,
    warnings: parseJson<string[]>(row.warnings, []),
    classification: parseJson<unknown>(row.classification, null),
    needsConfirmation: toBool(row.needs_confirmation),
    attempts: Number(row.attempts),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createImportJob(input: {
  projectId: string;
  sourceLabel: string;
  rootPath: string;
  scope?: DocumentScope;
}): Promise<ImportJob> {
  const ts = nowIso();
  const id = newId('imp');
  await getDb().run(
    `INSERT INTO import_jobs (id, project_id, source_label, root_path, status, scope,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'DISCOVERING', ?, ?, ?)`,
    [id, input.projectId, input.sourceLabel, input.rootPath, input.scope ?? 'LAYER', ts, ts],
  );
  return (await getImportJob(id))!;
}

export async function getImportJob(id: string): Promise<ImportJob | null> {
  const row = await getDb().get<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', [id]);
  return row ? mapJob(row) : null;
}

export async function listImportJobs(projectId: string): Promise<ImportJob[]> {
  return (await getDb().all<ImportJobRow>('SELECT * FROM import_jobs WHERE project_id = ? ORDER BY created_at DESC', [
      projectId,
    ]))
    .map(mapJob);
}

/** Jobs a dead process may have left looking alive. */
export async function listUnfinishedImportJobs(): Promise<ImportJob[]> {
  return (await getDb().all<ImportJobRow>(
      `SELECT * FROM import_jobs WHERE status IN ('DISCOVERING','QUEUED','RUNNING')
       ORDER BY created_at`,
    ))
    .map(mapJob);
}

export async function updateImportJob(
  id: string,
  patch: {
    status?: ImportJobStatus;
    message?: string | null;
    cancelReason?: string | null;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<ImportJob | null> {
  const { clause, values } = buildUpdate({
    status: patch.status,
    message: patch.message,
    cancel_reason: patch.cancelReason,
    heartbeat_at: patch.heartbeatAt,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
  });
  if (!clause) return getImportJob(id);
  await getDb().run(`UPDATE import_jobs SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getImportJob(id);
}

export interface DiscoveredFileInput {
  jobId: string;
  projectId: string;
  absolutePath: string;
  relativePath: string;
  filename: string;
  fileSize: number | null;
  sourceModifiedAt: string | null;
}

/**
 * Record what discovery found, before anything is read.
 *
 * Written in one transaction so a crash during discovery leaves either the whole
 * list or none of it, never a half-enumerated folder that would look complete.
 */
export async function insertDiscoveredFiles(inputs: DiscoveredFileInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const db = getDb();
  const ts = nowIso();
  let inserted = 0;
  await db.transaction(async () => {
    for (const input of inputs) {
      // The same folder re-imported into the same job is one row per path.
      const existing = await db.get<{ id: string }>(
        'SELECT id FROM import_files WHERE job_id = ? AND relative_path = ?',
        [input.jobId, input.relativePath],
      );
      if (existing) continue;
      await db.run(
        `INSERT INTO import_files (id, job_id, project_id, absolute_path, relative_path, filename,
           file_size, source_modified_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, ?)`,
        [newId('imf'), input.jobId, input.projectId, input.absolutePath, input.relativePath,
          input.filename, input.fileSize, input.sourceModifiedAt, ts, ts],
      );
      inserted += 1;
    }
  });
  return inserted;
}

export async function getImportFile(id: string): Promise<ImportFile | null> {
  const row = await getDb().get<ImportFileRow>('SELECT * FROM import_files WHERE id = ?', [id]);
  return row ? mapFile(row) : null;
}

export async function listImportFiles(jobId: string): Promise<ImportFile[]> {
  return (await getDb().all<ImportFileRow>('SELECT * FROM import_files WHERE job_id = ? ORDER BY relative_path', [jobId]))
    .map(mapFile);
}

/**
 * The next file to work on: the oldest one nobody has finished.
 *
 * Taken one at a time from the database rather than from an in-memory list, so a
 * resumed job picks up exactly where the dead one stopped.
 */
export async function nextPendingFile(jobId: string): Promise<ImportFile | null> {
  const row = await getDb().get<ImportFileRow>(
    `SELECT * FROM import_files
      WHERE job_id = ? AND status IN ('DISCOVERED','QUEUED','EXTRACTING','OCR')
      ORDER BY relative_path LIMIT 1`,
    [jobId],
  );
  return row ? mapFile(row) : null;
}

export async function updateImportFile(
  id: string,
  patch: {
    status?: ImportFileStatus;
    fileHash?: string | null;
    fileSize?: number | null;
    detectedFormat?: DocumentFormat | null;
    documentId?: string | null;
    duplicateOfId?: string | null;
    extractionStatus?: ExtractionStatus | null;
    extractionMethod?: string | null;
    pages?: number | null;
    ocrPages?: number | null;
    detail?: string | null;
    warnings?: string[];
    classification?: unknown;
    needsConfirmation?: boolean;
    attempts?: number;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<ImportFile | null> {
  const { clause, values } = buildUpdate({
    status: patch.status,
    file_hash: patch.fileHash,
    file_size: patch.fileSize,
    detected_format: patch.detectedFormat,
    document_id: patch.documentId,
    duplicate_of_id: patch.duplicateOfId,
    extraction_status: patch.extractionStatus,
    extraction_method: patch.extractionMethod,
    pages: patch.pages,
    ocr_pages: patch.ocrPages,
    detail: patch.detail,
    warnings: patch.warnings ? toJson(patch.warnings) : undefined,
    classification: patch.classification === undefined ? undefined : toJson(patch.classification),
    needs_confirmation:
      patch.needsConfirmation === undefined ? undefined : fromBool(patch.needsConfirmation),
    attempts: patch.attempts,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
  });
  if (!clause) return getImportFile(id);
  await getDb().run(`UPDATE import_files SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getImportFile(id);
}

/**
 * Recount the job from its files.
 *
 * Derived rather than incremented: the rows are the truth, and a counter that
 * disagrees with them would make the import report a fiction.
 */
export async function recountImportJob(jobId: string): Promise<ImportJob | null> {
  const db = getDb();
  const counts = await db.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM import_files WHERE job_id = ? GROUP BY status',
    [jobId],
  );
  const by = new Map(counts.map((row) => [row.status, Number(row.n)]));
  const total = [...by.values()].reduce((sum, value) => sum + value, 0);
  const pending =
    (by.get('DISCOVERED') ?? 0) +
    (by.get('QUEUED') ?? 0) +
    (by.get('EXTRACTING') ?? 0) +
    (by.get('OCR') ?? 0);

  await db.run(
    `UPDATE import_jobs SET discovered = ?, processed = ?, registered = ?, duplicates = ?,
       unsupported = ?, unreadable = ?, failed = ?, needs_review = ?, updated_at = ?
     WHERE id = ?`,
    [total, total - pending, by.get('REGISTERED') ?? 0, by.get('DUPLICATE') ?? 0,
      by.get('UNSUPPORTED') ?? 0, by.get('UNREADABLE') ?? 0, by.get('FAILED') ?? 0,
      by.get('NEEDS_REVIEW') ?? 0, nowIso(), jobId],
  );
  return getImportJob(jobId);
}

/** Files that can be tried again: the failures, and nothing that succeeded. */
export async function retryableFiles(jobId: string): Promise<ImportFile[]> {
  return (await getDb().all<ImportFileRow>(
      `SELECT * FROM import_files WHERE job_id = ? AND status IN ('FAILED','UNREADABLE')
       ORDER BY relative_path`,
      [jobId],
    ))
    .map(mapFile);
}

/** A file already registered in this project, by content. */
export async function findImportedByHash(projectId: string, hash: string): Promise<ImportFile | null> {
  const row = await getDb().get<ImportFileRow>(
    `SELECT * FROM import_files
      WHERE project_id = ? AND file_hash = ? AND status = 'REGISTERED'
      ORDER BY created_at LIMIT 1`,
    [projectId, hash],
  );
  return row ? mapFile(row) : null;
}
