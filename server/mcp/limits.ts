/**
 * The bounds, and the reasoning behind each number.
 *
 * A remote gateway that answers "as much as you asked for" is a gateway that
 * can be used to read a project one enormous response at a time, and to keep
 * a Brain busy answering. Every bound here is enforced server-side and every
 * truncation is *reported* — a result that was cut and does not say so is worse
 * than one that refuses, because the caller draws conclusions from a document
 * it only half received.
 */
import { limitExceeded } from './errors.ts';

/* ------------------------------------------------------------------------ */
/* Sizes                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * A tool call is arguments, not an upload. Brain's file path is multipart on a
 * different route with its own 50 MiB bound and its own authorization; nothing
 * about MCP needs to carry bytes.
 */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * The hard ceiling on one tool result, after serialisation.
 *
 * Chosen to be comfortably larger than any bounded answer below, so that
 * hitting it means a bug rather than an ordinary large read — the per-tool
 * bounds are what shape normal results, and this is the backstop.
 */
export const MAX_RESULT_BYTES = 256 * 1024;

/** Page sizes for the listing tools. */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** `retrieveEvidence` already bounds itself; this bounds the boundary. */
export const MAX_PASSAGES = 20;

/** Per call. A transcript is not a tool result — read it in pages. */
export const MAX_DOCUMENT_TEXT_CHARS = 128 * 1024;

/* ------------------------------------------------------------------------ */
/* Rate                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Per credential, not per address.
 *
 * Behind Fly's load balancer every caller shares an address, so an IP limit
 * would either be useless (the balancer's address is one client) or would
 * throttle the whole fleet as one. The credential id is the only identifier
 * here that means "one worker", and it comes from an authenticated principal
 * rather than from anything the caller sent.
 *
 * KNOWN AND DELIBERATE: the counter is in-memory, so with two instances the
 * effective limit multiplies by the instance count. That is the identical
 * property the sign-in throttle has, it is already recorded as Step 11's to
 * resolve at the point a second machine is actually run, and Brain runs one
 * machine today. It is written here rather than left for someone to discover.
 */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_CALLS = 120;
export const MAX_CONCURRENT_PER_CREDENTIAL = 8;

interface Bucket {
  windowStart: number;
  count: number;
  inFlight: number;
}

const buckets = new Map<string, Bucket>();

/** Test seam. Never called by the server. */
export function resetRateLimits(): void {
  buckets.clear();
}

function bucketFor(credentialId: string, now: number): Bucket {
  const existing = buckets.get(credentialId);
  if (existing && now - existing.windowStart < RATE_WINDOW_MS) return existing;
  // A fresh window keeps the in-flight count, which is not windowed: a call
  // that is still running is still running whatever the clock did.
  const bucket: Bucket = { windowStart: now, count: 0, inFlight: existing?.inFlight ?? 0 };
  buckets.set(credentialId, bucket);
  return bucket;
}

export interface RateLease {
  release: () => void;
}

/**
 * Take a slot, or refuse.
 *
 * Returns a release handle rather than a boolean because the concurrency half
 * has to be given back, and a caller that can forget to give it back would
 * wedge a worker permanently after one crash.
 */
export function takeRateSlot(credentialId: string, now = Date.now()): RateLease {
  const bucket = bucketFor(credentialId, now);

  if (bucket.count >= RATE_MAX_CALLS) {
    const retryAfterMs = Math.max(0, RATE_WINDOW_MS - (now - bucket.windowStart));
    throw limitExceeded('Too many calls. Slow down and retry.', { retryAfterMs });
  }
  if (bucket.inFlight >= MAX_CONCURRENT_PER_CREDENTIAL) {
    throw limitExceeded('Too many calls in flight for this credential.', {
      retryAfterMs: 1000,
    });
  }

  bucket.count += 1;
  bucket.inFlight += 1;

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Truncation                                                                */
/* ------------------------------------------------------------------------ */

export interface Bounded<T> {
  items: T[];
  truncated: boolean;
  omitted: number;
}

/** Cut a list to a bound, and say how much was left behind. Never silently. */
export function bound<T>(items: T[], limit: number): Bounded<T> {
  if (items.length <= limit) return { items, truncated: false, omitted: 0 };
  return { items: items.slice(0, limit), truncated: true, omitted: items.length - limit };
}

/**
 * The page size a caller asked for, clamped.
 *
 * Refuses a non-integer or negative value rather than coercing it: a caller
 * that sent `limit: "all"` has a bug, and quietly answering 50 hides it.
 */
export function pageSize(requested: unknown): number {
  if (requested === undefined || requested === null) return DEFAULT_PAGE;
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
    throw limitExceeded('limit must be a positive integer.');
  }
  return Math.min(MAX_PAGE, requested);
}

/**
 * The last gate before a result leaves.
 *
 * If a tool somehow produced something enormous, the caller is told the result
 * was too large rather than handed a truncated JSON document it would parse as
 * complete. Truncating *structure* is the one kind of truncation that cannot be
 * reported honestly, so it is not done.
 */
export function assertResultWithinBounds(value: unknown): void {
  const size = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  if (size > MAX_RESULT_BYTES) {
    throw limitExceeded('That result is too large to return. Narrow the request.', {
      maxBytes: MAX_RESULT_BYTES,
    });
  }
}
