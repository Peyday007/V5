/**
 * Extraction scheduling (section 18).
 *
 * Reading a fifty-page PDF takes seconds and OCR can take minutes, so import
 * must not wait for it. Work is queued and run one document at a time — serial
 * rather than parallel, because several large PDFs decoded at once is the fastest
 * way to exhaust memory on a laptop, and the user gains nothing from it.
 *
 * Two guarantees matter more than throughput:
 *   - a document already being extracted is never started twice, so concurrent
 *     imports cannot produce conflicting runs;
 *   - a crash leaves the run recoverable, never apparently ready (see
 *     `recoverInterruptedExtractions`).
 */
import { getDb } from '../../db/database.ts';
import { extractDocument, type ExtractionResult } from './extraction.ts';

interface QueueEntry {
  documentId: string;
  force: boolean;
  resolve: (result: ExtractionResult) => void;
  reject: (error: unknown) => void;
}

const pending: QueueEntry[] = [];
/** documentId -> the promise callers can await for the in-flight extraction. */
const inFlight = new Map<string, Promise<ExtractionResult>>();
let draining = false;
let idleWaiters: (() => void)[] = [];

function settleIdle(): void {
  if (pending.length > 0 || inFlight.size > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const waiter of waiters) waiter();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const entry = pending.shift();
      if (!entry) break;
      try {
        entry.resolve(await extractDocument(entry.documentId, { force: entry.force }));
      } catch (error) {
        entry.reject(error);
      } finally {
        inFlight.delete(entry.documentId);
      }
    }
  } finally {
    draining = false;
    settleIdle();
  }
}

/**
 * Schedule extraction for a document. Returns the promise for the in-flight run
 * when one already exists, so two imports of the same file share one extraction
 * rather than racing.
 */
export function enqueueExtraction(
  documentId: string,
  options: { force?: boolean } = {},
): Promise<ExtractionResult> {
  const existing = inFlight.get(documentId);
  if (existing) return existing;

  const promise = new Promise<ExtractionResult>((resolve, reject) => {
    pending.push({ documentId, force: options.force ?? false, resolve, reject });
  });
  inFlight.set(documentId, promise);
  // Errors are delivered to whoever awaited the promise; an unawaited scheduling
  // call must not take the process down.
  promise.catch(() => undefined);
  void drain();
  return promise;
}

/** Resolves once every queued extraction has finished. Used by tests and shutdown. */
export function whenExtractionIdle(): Promise<void> {
  if (pending.length === 0 && inFlight.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
  });
}

export function extractionQueueDepth(): number {
  return pending.length + inFlight.size;
}

/**
 * Queue every document that has never been successfully read.
 *
 * Called at boot so a folder dropped in while the server was down, or a document
 * whose extraction was interrupted, becomes auditable without the user having to
 * ask. Documents already READY are left alone.
 */
export function queueUnreadDocuments(): number {
  const rows = getDb().all<{ id: string }>(
    `SELECT id FROM documents
     WHERE filesystem_path IS NOT NULL
       AND file_missing = 0
       AND extraction_status NOT IN ('READY','READY_WITH_WARNINGS','BLOCKED')`,
  );
  for (const row of rows) void enqueueExtraction(row.id);
  return rows.length;
}
