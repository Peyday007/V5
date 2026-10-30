/** What every collector returns. Missing is recorded as missing, never guessed. */
import type { Amount } from '../normalize/index.ts';

export type CollectorKind = 'RSS_ATOM' | 'JSON_API' | 'CSV' | 'SITEMAP' | 'HTML_LIST' | 'OVERPASS' | 'PAGE_WATCH';

export const RECORD_FIELDS = ['title', 'organization', 'publishedAt', 'location', 'amount', 'url'] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

export interface CollectedRecord {
  externalId: string;
  url: string | null;
  title: string | null;
  organization: string | null;
  publishedAt: string | null;
  location: string | null;
  amount: Amount | null;
  body: string | null;
  contentHash: string;
  /** Fields of RECORD_FIELDS this record has no value for. */
  missing: RecordField[];
}

export type RefusalReason =
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'PAYWALL' | 'CAPTCHA' | 'ROBOTS_DISALLOWED' | 'GONE' | 'RATE_LIMITED' | 'SERVER_ERROR';

export interface Refusal {
  reason: RefusalReason;
  status: number | null;
  /** Temporary refusals may be retried with backoff; permanent ones never are. */
  retryable: boolean;
  detail: string;
}

export interface FetchedBody {
  status: number;
  body: string;
  etag?: string | null;
  lastModified?: string | null;
}

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

export type CollectOutcome =
  | { kind: 'RECORDS'; records: CollectedRecord[]; contentHash: string; etag: string | null; lastModified: string | null; nextPage: string | null }
  | { kind: 'NO_MATCHING_RECORDS'; contentHash: string; etag: string | null; lastModified: string | null }
  | { kind: 'UNCHANGED'; basis: 'STATUS_304' | 'ETAG' | 'LAST_MODIFIED' | 'CONTENT_HASH' }
  | { kind: 'REFUSED'; refusal: Refusal };

export interface CollectOptions {
  /** URL the body came from, for resolving relative links. */
  url: string;
  previous?: Validators;
  /** Collector-specific field mapping (JSON API, CSV, HTML list). */
  mapping?: Record<string, string>;
  maxRecords?: number;
}
