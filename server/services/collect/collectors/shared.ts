import { canonicalUrl, cleanText, contentHash, normalizeAmount, normalizeDate, plainText } from '../normalize/index.ts';
import type { Amount } from '../normalize/index.ts';
import {
  RECORD_FIELDS,
  type CollectedRecord,
  type CollectOutcome,
  type FetchedBody,
  type RecordField,
  type Refusal,
  type Validators,
} from './types.ts';

export const DEFAULT_MAX_RECORDS = 5_000;

/** A refusal is recorded; it is never worked around. */
export function refusalFor(status: number, body: string): Refusal | null {
  if (status >= 200 && status < 300) {
    if (/captcha|are you a robot|verify you are human|cf-chl|attention required/i.test(body.slice(0, 4000)) && body.length < 20_000)
      return { reason: 'CAPTCHA', status, retryable: false, detail: 'the page asks to prove the reader is human' };
    return null;
  }
  if (status === 304) return null;
  if (status === 401) return { reason: 'UNAUTHORIZED', status, retryable: false, detail: 'authentication is required' };
  if (status === 402) return { reason: 'PAYWALL', status, retryable: false, detail: 'payment is required' };
  if (status === 403) return { reason: 'FORBIDDEN', status, retryable: false, detail: 'the publisher refuses this client' };
  if (status === 410) return { reason: 'GONE', status, retryable: false, detail: 'the resource is gone' };
  if (status === 429) return { reason: 'RATE_LIMITED', status, retryable: true, detail: 'the publisher asked us to slow down' };
  if (status >= 500) return { reason: 'SERVER_ERROR', status, retryable: true, detail: `server error ${status}` };
  return { reason: 'FORBIDDEN', status, retryable: false, detail: `unexpected status ${status}` };
}

/** Whether the body needs processing at all. */
export function unchanged(fetched: FetchedBody, previous: Validators | undefined, hash: string): CollectOutcome | null {
  if (fetched.status === 304) return { kind: 'UNCHANGED', basis: 'STATUS_304' };
  if (!previous) return null;
  if (previous.etag && fetched.etag && previous.etag === fetched.etag) return { kind: 'UNCHANGED', basis: 'ETAG' };
  if (previous.lastModified && fetched.lastModified && previous.lastModified === fetched.lastModified)
    return { kind: 'UNCHANGED', basis: 'LAST_MODIFIED' };
  if (previous.contentHash && previous.contentHash === hash) return { kind: 'UNCHANGED', basis: 'CONTENT_HASH' };
  return null;
}

export interface Draft {
  externalId?: string | null;
  url?: unknown;
  title?: unknown;
  organization?: unknown;
  publishedAt?: unknown;
  location?: unknown;
  amount?: unknown;
  body?: unknown;
}

/** Build a record from raw field values; absent fields are listed as missing. */
export function recordFrom(draft: Draft, base: string): CollectedRecord | null {
  const url = canonicalUrl(draft.url, base);
  const title = plainText(draft.title, 300);
  const organization = plainText(draft.organization, 200);
  const publishedAt = normalizeDate(draft.publishedAt);
  const location = plainText(draft.location, 200);
  const amount: Amount | null =
    draft.amount && typeof draft.amount === 'object' ? (draft.amount as Amount) : normalizeAmount(draft.amount);
  const body = plainText(draft.body);
  if (!title && !url && !body) return null;
  const externalId = cleanText(draft.externalId) ?? url ?? contentHash(`${title ?? ''}|${organization ?? ''}|${publishedAt ?? ''}`);
  const present: Record<RecordField, boolean> = {
    title: !!title, organization: !!organization, publishedAt: !!publishedAt, location: !!location, amount: !!amount, url: !!url,
  };
  return {
    externalId, url, title, organization, publishedAt, location, amount, body,
    contentHash: contentHash(JSON.stringify([title, organization, publishedAt, location, amount, url, body])),
    missing: RECORD_FIELDS.filter((field) => !present[field]),
  };
}

/** Records or NO_MATCHING_RECORDS; the body was reachable either way. */
export function outcomeFor(records: CollectedRecord[], hash: string, fetched: FetchedBody, nextPage: string | null = null, max = DEFAULT_MAX_RECORDS): CollectOutcome {
  const etag = fetched.etag ?? null;
  const lastModified = fetched.lastModified ?? null;
  if (records.length === 0) return { kind: 'NO_MATCHING_RECORDS', contentHash: hash, etag, lastModified };
  const seen = new Set<string>();
  const unique = records.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true))).slice(0, max);
  return { kind: 'RECORDS', records: unique, contentHash: hash, etag, lastModified, nextPage };
}

/** Run a parser behind the shared refusal / unchanged gates. Never throws. */
export function run(
  fetched: FetchedBody,
  previous: Validators | undefined,
  parse: (hash: string) => { records: CollectedRecord[]; nextPage?: string | null },
  max = DEFAULT_MAX_RECORDS,
): CollectOutcome {
  const refusal = refusalFor(fetched.status, fetched.body);
  if (refusal) return { kind: 'REFUSED', refusal };
  const hash = contentHash(fetched.body ?? '');
  const skip = unchanged(fetched, previous, hash);
  if (skip) return skip;
  try {
    const parsed = parse(hash);
    return outcomeFor(parsed.records, hash, fetched, parsed.nextPage ?? null, max);
  } catch {
    return outcomeFor([], hash, fetched);
  }
}

export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

export function tagText(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? (m[1] ?? null) : null;
}
