/**
 * The reading backlog, for the operator's health surface.
 *
 * §9 makes an unread document something the auditor does not have, and blocks
 * its layer. Nothing Brain-wide answered "how many documents are waiting to be
 * read, stuck mid-read, or unreadable" until now — `extractionQueueDepth` and
 * `documents.extraction_status` were each readable, and neither was ever read
 * at this scope. This reports; it refuses nothing and enqueues nothing.
 */
import { getDb } from '../../db/database.ts';
import { EXTRACTION_STATUSES, type ExtractionStatus } from '../../domain/types.ts';
import { extractionQueueDepth } from './queue.ts';

export interface ReadingBacklog {
  /** Documents currently queued for extraction or being extracted right now. */
  inProcess: number;
  /** One key per ExtractionStatus, each a count of documents at that status. */
  byStatus: Record<ExtractionStatus, number>;
  /** Registered documents whose file no longer exists on disk or in the store. */
  missingFiles: number;
}

export async function readingBacklog(): Promise<ReadingBacklog> {
  const db = getDb();

  const counts = await db.all<{ extraction_status: string; n: number }>(
    'SELECT extraction_status, COUNT(*) AS n FROM documents GROUP BY extraction_status',
  );
  const countByStatus = new Map(counts.map((row) => [row.extraction_status, Number(row.n)]));
  const byStatus = Object.fromEntries(
    EXTRACTION_STATUSES.map((status) => [status, countByStatus.get(status) ?? 0]),
  ) as Record<ExtractionStatus, number>;

  const missing = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM documents WHERE file_missing = 1',
  );

  return {
    inProcess: extractionQueueDepth(),
    byStatus,
    missingFiles: Number(missing?.n ?? 0),
  };
}
