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
import { afterCommit, getDb, inTransaction, outsideTransaction } from '../../db/database.ts';
import { asWorkload } from '../../db/infra.ts';
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
export async function enqueueExtraction(
  documentId: string,
  options: { force?: boolean } = {},
): Promise<ExtractionResult> {
  // Read without awaiting, deliberately. `inFlight` is a Map, so there is
  // nothing to await — and suspending here would return control before the
  // `inFlight.set` below, letting a second caller for the same document miss
  // the entry and enqueue a competing extraction of the same file.
  /*
   * A caller inside a transaction — a filing inside its effect's transaction —
   * is extracting a document only that transaction can see, so it runs here,
   * in the caller's context, and nowhere near the shared queue. Starting the
   * queue from inside a transaction used to run the whole drain loop on that
   * transaction's connection: every document anybody else queued meanwhile was
   * extracted inside the filing's transaction, and once it committed the loop
   * kept issuing statements on a client the pool had already handed to someone
   * else. And a filing that found the queue busy waited behind the backlog,
   * holding its connection and the work item's fence, for a document the queue
   * could not see.
   */
  if (inTransaction()) return extractDocument(documentId, { force: options.force ?? false });

  const existing: Promise<ExtractionResult> | undefined = inFlight.get(documentId);
  if (existing) return existing;

  const promise = new Promise<ExtractionResult>((resolve, reject) => {
    pending.push({ documentId, force: options.force ?? false, resolve, reject });
  });
  inFlight.set(documentId, promise);
  // Errors are delivered to whoever awaited the promise; an unawaited scheduling
  // call must not take the process down.
  void promise.catch(() => undefined);
  // The queue runs in no caller's transaction and on the workload pool.
  void outsideTransaction(() => asWorkload(drain));
  return promise;
}

/**
 * Queue extraction without waiting for it, once the caller's transaction (if
 * any) has committed — a document only that transaction can see is invisible to
 * the queue until then, and starting the queue from inside the transaction is
 * the defect `enqueueExtraction` describes. Dropped if the transaction rolls
 * back, which is right: the document it would have read does not exist.
 */
export function scheduleExtraction(documentId: string, options: { force?: boolean } = {}): void {
  afterCommit(() => {
    void enqueueExtraction(documentId, options).catch(() => undefined);
  });
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
export async function queueUnreadDocuments(): Promise<number> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM documents
     WHERE filesystem_path IS NOT NULL
       AND file_missing = 0
       AND extraction_status NOT IN ('READY','READY_WITH_WARNINGS','BLOCKED')`,
  );
  for (const row of rows) void enqueueExtraction(row.id);
  return rows.length;
}
