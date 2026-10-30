/** Collection: what a source is, what a pull can fail on, and what a change is. */
export const SOURCE_KINDS = ['RSS_ATOM', 'JSON_API', 'CSV_DATASET', 'SITEMAP', 'HTML_LIST', 'OVERPASS', 'PAGE_WATCH'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ROBOTS_STATUSES = ['UNCHECKED', 'ALLOWED', 'DISALLOWED', 'TERMS_FORBID'] as const;
export type RobotsStatus = (typeof ROBOTS_STATUSES)[number];

/**
 * Why a pull produced nothing. SOURCE_UNREACHABLE and NO_MATCHING_RECORDS are
 * different facts with different remedies and are never folded together: the
 * first means nobody could ask, the second means somebody asked and the source
 * had nothing.
 */
export const COLLECT_FAILURE_CAUSES = [
  'SOURCE_UNREACHABLE', 'NO_MATCHING_RECORDS', 'REFUSED', 'RATE_LIMITED', 'UNPARSEABLE', 'TIMEOUT', 'SERVER_ERROR',
] as const;
export type CollectFailureCause = (typeof COLLECT_FAILURE_CAUSES)[number];

/** Causes worth retrying with backoff; the rest are permanent until something changes. */
export const RETRYABLE_CAUSES: readonly CollectFailureCause[] = ['RATE_LIMITED', 'TIMEOUT', 'SERVER_ERROR', 'SOURCE_UNREACHABLE'];

export const CHANGE_KINDS = ['NEW', 'FIELD_CHANGED', 'DISAPPEARED', 'REAPPEARED'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface CollectSource {
  id: string;
  projectId: string | null;
  slug: string;
  label: string;
  kind: SourceKind;
  urlTemplate: string;
  pagination: string | null;
  parserId: string;
  intervalMs: number;
  hostRatePerMin: number | null;
  robotsStatus: RobotsStatus;
  robotsCheckedAt: string | null;
  robotsNote: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CollectCheckpoint {
  sourceId: string;
  cursor: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  updatedAt: string;
}

export interface FeedPullMetrics {
  method: SourceKind | null;
  fetched: number;
  inserted: number;
  duplicates: number | null;
  relevant: number | null;
  signals: number | null;
  failureCause: CollectFailureCause | null;
  wallMs: number | null;
  bytes: number | null;
  memoryBytes: number | null;
  cheapCalls: number | null;
  claudeJobs: number | null;
}
