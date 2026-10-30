/**
 * Turning a response into a recorded outcome. No network here: callers pass the
 * response they got, so every rule is testable. A refusal is a recorded fact and
 * is never retried or worked around; only temporary failures may be retried.
 */
import { sha256 } from '../normalize/index.ts';
import { EMPTY_RESULT, type CollectResult, type RefusalCause, type TemporaryCause } from './types.ts';

export interface RawResponse {
  status: number;
  body: string;
  etag?: string | null;
  lastModified?: string | null;
  /** Set by the transport when it never got a response. */
  errorCode?: string | null;
}

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
  bodyHash?: string | null;
}

/** Headers for a conditional request; unchanged content then costs nothing to process. */
export function conditionalHeaders(prior: Validators): Record<string, string> {
  const headers: Record<string, string> = {};
  if (prior.etag) headers['if-none-match'] = prior.etag;
  if (prior.lastModified) headers['if-modified-since'] = prior.lastModified;
  return headers;
}

const CAPTCHA = /(captcha|are you a robot|verify you are human|cf-chl|attention required)/i;
const PAYWALL = /(subscribe to continue|subscription required|paywall|sign in to read)/i;

export function refusalFor(status: number, body: string): RefusalCause | null {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 410) return 'GONE';
  if (status === 402) return 'PAYWALL';
  if (status === 403 || status === 451) return CAPTCHA.test(body.slice(0, 5_000)) ? 'CAPTCHA' : 'FORBIDDEN';
  if (status === 200 && body.length < 20_000 && CAPTCHA.test(body)) return 'CAPTCHA';
  if (status === 200 && body.length < 20_000 && PAYWALL.test(body)) return 'PAYWALL';
  return null;
}

export function temporaryFor(response: RawResponse): TemporaryCause | null {
  if (response.errorCode) return /TIMEDOUT|TIMEOUT|ABORT/i.test(response.errorCode) ? 'TIMEOUT' : 'NETWORK';
  if (response.status === 408) return 'TIMEOUT';
  if (response.status === 429) return 'RATE_LIMITED';
  if (response.status >= 500) return 'SERVER_ERROR';
  return null;
}

/** Backoff only for temporary causes; a refusal or a clean answer returns null (do not retry). */
export function retryDelayMs(result: Pick<CollectResult, 'temporary'>, attempt: number, base = 2_000, cap = 300_000): number | null {
  if (!result.temporary || attempt >= 4) return null;
  return Math.min(cap, base * 2 ** attempt);
}

/**
 * Decide what a response means before any parsing happens. Returns a finished
 * result for every case that needs no parsing (refused, unreachable, unchanged),
 * or null when the body should be parsed.
 */
export function gate(response: RawResponse, prior: Validators = {}): CollectResult | null {
  const base = { ...EMPTY_RESULT, etag: response.etag ?? prior.etag ?? null, lastModified: response.lastModified ?? prior.lastModified ?? null };
  const temporary = temporaryFor(response);
  if (temporary) return { ...base, outcome: 'SOURCE_UNREACHABLE', temporary, note: response.errorCode ?? `HTTP ${response.status}` };
  if (response.status === 304) return { ...base, outcome: 'UNCHANGED', note: 'not modified' };
  const refusal = refusalFor(response.status, response.body);
  if (refusal) return { ...base, outcome: 'REFUSED', refusal, note: `HTTP ${response.status}` };
  if (response.status >= 400) return { ...base, outcome: 'SOURCE_UNREACHABLE', note: `HTTP ${response.status}` };
  const bodyHash = sha256(response.body);
  if (prior.bodyHash && prior.bodyHash === bodyHash) return { ...base, outcome: 'UNCHANGED', bodyHash, note: 'same content hash' };
  return null;
}

/** Finish a parsed pull: an empty parse of a reachable source is NO_MATCHING_RECORDS, or UNPARSEABLE when the body had content. */
export function finish(response: RawResponse, prior: Validators, parse: () => Pick<CollectResult, 'records' | 'next'>, emptyMeansUnparseable = false): CollectResult {
  const early = gate(response, prior);
  if (early) return early;
  const base = { ...EMPTY_RESULT, etag: response.etag ?? null, lastModified: response.lastModified ?? null, bodyHash: sha256(response.body) };
  let parsed: Pick<CollectResult, 'records' | 'next'>;
  try {
    parsed = parse();
  } catch (error) {
    return { ...base, outcome: 'UNPARSEABLE', note: error instanceof Error ? error.message : 'parse failed' };
  }
  if (parsed.records.length > 0) return { ...base, outcome: 'RECORDS', records: parsed.records, next: parsed.next };
  return { ...base, outcome: emptyMeansUnparseable && response.body.trim() ? 'UNPARSEABLE' : 'NO_MATCHING_RECORDS', note: null };
}
