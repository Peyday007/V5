/**
 * What an effect's failure is allowed to write down.
 *
 * `runIdempotent` closes the attempt row with the exception's message, outside
 * the transaction that rolls the effect back, so it survives — and for a long
 * time that row was the *only* durable account of an internal tool failure,
 * because the caller is handed one deliberately opaque sentence and the log
 * line beside it ages out of the host's buffer within the hour.
 *
 * It was also the wrong half. A `StorageConfigurationError` says "The document
 * store refused an upload (HTTP 400)." in its message and carries the store's
 * own answer — which named the offending key — in a `detail` the attempt row
 * dropped. So the durable record survived and still could not say what was
 * wrong, which took a cash sprint's whole filing path six hours to diagnose
 * from first principles.
 *
 * Read structurally rather than by error class: anything carrying a string
 * `detail` contributes it. The effects engine has no business importing the
 * storage layer to ask whether this is one of its errors, and the next
 * provider to carry a `detail` should not need this file edited.
 *
 * ---------------------------------------------------------------------------
 * What must never reach a row
 * ---------------------------------------------------------------------------
 *
 * A provider body is somebody else's text, so it is treated as untrusted:
 * bounded, single-lined, and stripped of every shape a credential is carried
 * in — a bearer token, an api key, a signed URL's query string, an
 * `Authorization` header echoed back in an error. §17 is unconditional about
 * this: no credential in a log, an audit row, a response, an error or a URL.
 * The redaction is deliberately over-broad, because a diagnostic that loses a
 * few characters is recoverable and one that records a service key is not.
 */

/** Bounded to keep one failure from filling the column. */
const MAX_PROVIDER_DETAIL = 400;

/**
 * The shapes a secret travels in, and the URL query that can hide one.
 *
 * Applied to a provider's own words, so it matches loosely on purpose: a
 * `sig=`, a `token=` or an `X-Amz-Signature` is redacted wherever it appears,
 * and a query string is dropped whole rather than parsed for which parameter
 * happens to be the dangerous one this week.
 */
const SECRETS: readonly RegExp[] = Object.freeze([
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role|authorization|secret|password|signature|sig|token|key)\b\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}"?/gi,
  /\beyJ[A-Za-z0-9._-]{16,}/g,
  /\bbrnw_[A-Za-z0-9._-]+/g,
  // A signed URL is its query string. Keep the path, which is the diagnostic
  // half, and drop everything after the `?`.
  /(https?:\/\/[^\s"']+)\?[^\s"']*/gi,
]);

/** One line, bounded, with anything credential-shaped taken out. */
export function sanitizeProviderDetail(value: string): string {
  let out = value.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRETS) {
    out = out.replace(pattern, (match, keep: string | undefined) =>
      typeof keep === 'string' ? `${keep}?[redacted]` : '[redacted]',
    );
  }
  return out.length > MAX_PROVIDER_DETAIL ? `${out.slice(0, MAX_PROVIDER_DETAIL)}…` : out;
}

/**
 * The message, plus whatever the provider said about it.
 *
 * The message comes first and unmodified, so every reader that already matched
 * on it keeps working; the provider's account follows it behind a separator, or
 * nothing does.
 */
export function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail !== 'string') return message;
  const cleaned = sanitizeProviderDetail(detail);
  if (cleaned.length === 0) return message;
  return `${message} · ${cleaned}`;
}
