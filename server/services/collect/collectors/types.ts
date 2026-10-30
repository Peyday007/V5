import type { Amount } from '../normalize/index.ts';

/** The fields every collector tries to fill; a field it could not read is listed in `missing`, never guessed. */
export interface CollectedRecord {
  externalId: string;
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  publishedAt: string | null;
  location: string | null;
  amount: Amount | null;
  /** Names of the fields above that the source did not supply. */
  missing: string[];
  /** Hash of the record's own readable content, for change detection. */
  contentHash: string;
}

export const OPTIONAL_FIELDS = ['body', 'organization', 'publishedAt', 'location', 'amount'] as const;

/** Why a pull produced no records. SOURCE_UNREACHABLE and NO_MATCHING_RECORDS are never the same answer. */
export type CollectOutcome =
  | 'RECORDS'
  | 'NO_MATCHING_RECORDS'
  | 'UNCHANGED'
  | 'SOURCE_UNREACHABLE'
  | 'REFUSED'
  | 'UNPARSEABLE';

export type RefusalCause = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'GONE' | 'ROBOTS_DISALLOWED' | 'CAPTCHA' | 'PAYWALL';
export type TemporaryCause = 'TIMEOUT' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'NETWORK';

export interface CollectResult {
  outcome: CollectOutcome;
  records: CollectedRecord[];
  /** Set when outcome is REFUSED: recorded, never worked around. */
  refusal: RefusalCause | null;
  /** Set when outcome is SOURCE_UNREACHABLE. Retry is allowed only for these. */
  temporary: TemporaryCause | null;
  /** Conditional-request validators to store for the next pull. */
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
  /** Next page request when the source paginates and more is permitted. */
  next: string | null;
  note: string | null;
}

export const EMPTY_RESULT: CollectResult = {
  outcome: 'NO_MATCHING_RECORDS', records: [], refusal: null, temporary: null,
  etag: null, lastModified: null, bodyHash: null, next: null, note: null,
};
