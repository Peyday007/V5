/**
 * Redaction for everything a browser routine records (ACQ-21-5).
 *
 * A browser workflow (`../browserWorkflow.ts`) operates a site under a granted
 * account, and what it records — step details, page text it extracted, the
 * addresses it reached, headers, the values it typed and the screenshots it
 * took — becomes `bin_events` rows that people, audits and other workers read.
 * Invariant 22 and §17 are unconditional: no credential in a log, an audit
 * row, a response, an error or a URL. This module is the one place a browser
 * record passes through before it is written, so a run's log can be shown,
 * compared and kept without carrying the session that produced it.
 *
 * Pure and deliberately narrow in what it changes:
 *
 *  - URLs keep their scheme, host, path and every non-secret parameter byte
 *    for byte; only the *value* of a token-, session-, code-, signature- or
 *    key-like query or fragment parameter is replaced, user-info is replaced,
 *    and a `;jsessionid=` path parameter is replaced. A diagnostic that names
 *    the page is the useful half; the credential is never needed.
 *  - Free text is changed only where a credential-shaped run appears (a
 *    bearer token, a JWT, an issued Brain credential, `password=…`, a cookie
 *    or authorization header line, or a URL above). Everything else is left
 *    byte-identical, so a reader matching on a step's words keeps working.
 *  - Header and form values are replaced when the header or field is
 *    credential-like, whatever the value looks like.
 *  - A screenshot of a page that shows a credential field is withheld unless
 *    the capture says those fields were masked: a picture of a password box
 *    is a leak whatever the box contains.
 *
 * Idempotent by construction: every replacement marker is outside the
 * character class its pattern matches, so redacting a redacted record
 * returns it unchanged.
 *
 * This extends the existing owner rather than adding a store: it holds no
 * state, writes nothing, and is applied by whoever calls `recordBinEvent` for
 * a browser record. No host, category or industry is named.
 */
import {
  BRIDGE_CREDENTIAL_MARKER,
  INVITATION_MARKER,
  OAUTH_TOKEN_MARKER,
  WORKER_CREDENTIAL_MARKER,
} from '../../identity/secrets.ts';
import type { BrowserWorkflow, WorkflowRun, WorkflowStep } from '../browserWorkflow.ts';

/** What a secret is replaced with inside a URL (stays a valid URL character run). */
export const REDACTED_URL_VALUE = 'REDACTED';
/** What a secret is replaced with everywhere else. */
export const REDACTED = '[redacted]';

const isMarker = (v: string): boolean => v === REDACTED || v === REDACTED_URL_VALUE || v === encodeURIComponent(REDACTED);

/* ------------------------------------------------------------------------- */
/* What counts as secret                                                       */
/* ------------------------------------------------------------------------- */

/** Query/fragment parameter names whose value is a credential, a session or a one-time code. */
const SECRET_PARAM_EXACT = new Set([
  'code', 'state', 'nonce', 'sid', 'sig', 'key', 'auth', 'otp', 'pin', 'ticket', 'jwt', 'bearer',
  'pwd', 'pass', 'passwd', 'apikey', 'hash', 'hmac', 'saml', 'samlresponse', 'samlrequest',
]);
const SECRET_PARAM_CONTAINS = /token|secret|session|sessid|passw|signature|credential|api[_-]?key|access[_-]?key|private[_-]?key|auth(?!or)|cookie|csrf|xsrf|assertion/i;

/** Whether a URL parameter name carries a secret value. Pure. */
export function isSecretParam(name: string): boolean {
  let n = name;
  try {
    n = decodeURIComponent(name);
  } catch {
    /* keep the raw name */
  }
  n = n.trim().toLowerCase();
  if (n === '') return false;
  return SECRET_PARAM_EXACT.has(n) || SECRET_PARAM_CONTAINS.test(n);
}

/** Headers whose value is a credential or a session, whatever it looks like. */
const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|www-authenticate|proxy-authenticate)$|token|secret|session|api[-_]?key|auth|csrf|xsrf|signature|credential|password/i;

/** Whether a header name carries a credential. Pure. */
export function isSecretHeader(name: string): boolean {
  return SECRET_HEADER.test(name.trim());
}

/**
 * A form field a person's credential goes into. Matches the field's type,
 * name, label, autocomplete hint or locator text; the same boundary
 * `browserWorkflow.ts` refuses to fill, read here so a recorded value typed
 * into such a field is never kept.
 */
const CREDENTIAL_FIELD = /pass(word|code|phrase)?|secret|token|otp|one[- ]time|2fa|mfa|\bpin\b|cvv|cvc|card[- ]?number|cc-number|cc-csc|security[- ]code|current-password|new-password|api[-_ ]?key/i;

export interface FieldDescriptor {
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  autocomplete?: string;
  placeholder?: string;
}

/** Whether a field takes a credential. Pure. */
export function isCredentialField(field: FieldDescriptor | string): boolean {
  if (typeof field === 'string') return CREDENTIAL_FIELD.test(field);
  if ((field.type ?? '').toLowerCase() === 'password') return true;
  return [field.name, field.id, field.label, field.autocomplete, field.placeholder].some((v) => typeof v === 'string' && CREDENTIAL_FIELD.test(v));
}

/** A value that is itself credential-shaped, wherever it was typed. */
const SECRET_SHAPED_VALUE = /^(sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr]|AKIA|ASIA|brn[a-z])[-_A-Z0-9]|^eyJ[A-Za-z0-9_-]{8,}\.|^Bearer\s/;

/* ------------------------------------------------------------------------- */
/* URLs                                                                        */
/* ------------------------------------------------------------------------- */

function redactParams(part: string): string {
  return part
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return pair;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || isMarker(value) || !isSecretParam(name)) return pair;
      return `${name}=${REDACTED_URL_VALUE}`;
    })
    .join('&');
}

/**
 * The URL with every secret value replaced and everything else byte-identical.
 * Works on the string, never through `URL`, which would re-encode the parts
 * it was not asked to touch. Pure and idempotent.
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url === '') return url;
  let rest = url;
  let fragment: string | null = null;
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let query: string | null = null;
  const qAt = rest.indexOf('?');
  if (qAt >= 0) {
    query = rest.slice(qAt + 1);
    rest = rest.slice(0, qAt);
  }
  // user-info: scheme://user:pass@host → scheme://REDACTED@host
  rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+)@/i, (whole, scheme: string, info: string) => (isMarker(info) ? whole : `${scheme}${REDACTED_URL_VALUE}@`));
  // path parameters: ;jsessionid=…, ;sid=…
  rest = rest.replace(/;([A-Za-z0-9_.-]+)=([^;/?#]*)/g, (whole, name: string, value: string) =>
    value === '' || isMarker(value) || !isSecretParam(name) ? whole : `;${name}=${REDACTED_URL_VALUE}`,
  );
  let out = rest;
  if (query !== null) out += `?${redactParams(query)}`;
  if (fragment !== null) out += `#${fragment.includes('=') ? redactParams(fragment) : fragment}`;
  return out;
}

/* ------------------------------------------------------------------------- */
/* Free text                                                                   */
/* ------------------------------------------------------------------------- */

const ISSUED = [WORKER_CREDENTIAL_MARKER, OAUTH_TOKEN_MARKER, INVITATION_MARKER, BRIDGE_CREDENTIAL_MARKER];

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const HEADER_LINE = /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)(\s*:\s*)([^\r\n]+)/gi;
// The value must carry a digit, so prose ("bearer instrument") is left alone.
const BEARER = /\b(bearer|basic)(\s+)((?=[A-Za-z._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const ISSUED_IN_TEXT = new RegExp(`\\b(?:${ISSUED.join('|')})[A-Za-z0-9._-]+`, 'g');
const PROVIDER_KEY = /\b(?:sk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}|\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const KEYED = /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|passcode|pwd|token|session[_-]?id|sessionid|session|otp|cookie)\b(\s*[:=]\s*)("?)([^\s"'&,;)\]}]+)/gi;

/**
 * Free text with every credential-shaped run replaced and everything else
 * byte-identical. Pure and idempotent.
 */
export function redactText(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text.replace(URL_IN_TEXT, (u) => redactUrl(u));
  out = out.replace(HEADER_LINE, (whole, name: string, sep: string, value: string) => (isMarker(value.trim()) ? whole : `${name}${sep}${REDACTED}`));
  out = out.replace(BEARER, (whole, scheme: string, sep: string, value: string) => (isMarker(value) || /^redacted$/i.test(value) ? whole : `${scheme}${sep}${REDACTED}`));
  out = out.replace(JWT, REDACTED);
  out = out.replace(ISSUED_IN_TEXT, REDACTED);
  out = out.replace(PROVIDER_KEY, REDACTED);
  out = out.replace(KEYED, (whole, name: string, sep: string, quote: string, value: string) =>
    isMarker(value) || value.startsWith('[redacted') ? whole : `${name}${sep}${quote}${REDACTED}`,
  );
  return out;
}

/* ------------------------------------------------------------------------- */
/* Headers, form values, screenshots                                           */
/* ------------------------------------------------------------------------- */

/** Headers with every credential-like value replaced; names and other values untouched. Pure. */
export function redactHeaders<T extends Record<string, unknown>>(headers: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isSecretHeader(name)) out[name] = Array.isArray(value) ? value.map(() => REDACTED) : value == null ? value : REDACTED;
    else out[name] = typeof value === 'string' ? redactText(value) : value;
  }
  return out as T;
}

/** A value typed into a field: kept unless the field takes a credential or the value is one. Pure. */
export function redactFormValue(field: FieldDescriptor | string, value: string): string {
  if (typeof value !== 'string') return value;
  if (isMarker(value)) return value;
  if (isCredentialField(field) || SECRET_SHAPED_VALUE.test(value)) return REDACTED;
  return redactText(value);
}

export interface RecordedScreenshot {
  /** Where the image is stored (path, URL or storage key). */
  ref: string | null;
  pageUrl?: string | null;
  /** The capture saw a visible credential field on the page. */
  credentialField?: boolean;
  /** The fields visible on the page when it was captured, if the capture listed them. */
  fields?: FieldDescriptor[];
  /** The capture masked every credential field before saving. */
  masked?: boolean;
  withheld?: boolean;
  withheldReason?: string;
  [extra: string]: unknown;
}

export const SCREENSHOT_WITHHELD_REASON = 'the page showed a credential field and the capture was not masked';

/**
 * A screenshot reference safe to record. A page that showed a credential field
 * is withheld — its image reference is dropped and the reason recorded —
 * unless the capture itself masked those fields. Pure and idempotent.
 */
export function redactScreenshot(shot: RecordedScreenshot): RecordedScreenshot {
  const pageUrl = typeof shot.pageUrl === 'string' ? redactUrl(shot.pageUrl) : shot.pageUrl;
  const sawCredential = shot.credentialField === true || (Array.isArray(shot.fields) && shot.fields.some((f) => isCredentialField(f)));
  const fields = Array.isArray(shot.fields) ? shot.fields.map((f) => ({ ...f })) : shot.fields;
  if (shot.withheld === true || (sawCredential && shot.masked !== true)) {
    return {
      ...shot,
      ref: null,
      pageUrl,
      fields,
      credentialField: sawCredential || shot.credentialField === true,
      withheld: true,
      withheldReason: shot.withheldReason ?? SCREENSHOT_WITHHELD_REASON,
    };
  }
  return { ...shot, ref: typeof shot.ref === 'string' ? redactUrl(shot.ref) : shot.ref, pageUrl, fields };
}

/* ------------------------------------------------------------------------- */
/* Steps, runs and arbitrary log entries                                       */
/* ------------------------------------------------------------------------- */

function locatorText(step: { locator?: Record<string, unknown> }): string {
  const loc = step.locator ?? {};
  return ['role', 'name', 'label', 'testId', 'css', 'text'].map((k) => (typeof loc[k] === 'string' ? (loc[k] as string) : '')).join(' ');
}

/** A workflow step safe to record: a value typed into a credential field is replaced; URLs are redacted. Pure. */
export function redactStep(step: WorkflowStep): WorkflowStep {
  switch (step.kind) {
    case 'navigate':
      return { ...step, url: redactUrl(step.url) };
    case 'fill':
      return { ...step, value: redactFormValue(locatorText(step as unknown as { locator?: Record<string, unknown> }), step.value) };
    case 'download':
      return step.url === undefined ? { ...step } : { ...step, url: redactUrl(step.url) };
    case 'expect':
      return step.urlIncludes === undefined ? { ...step } : { ...step, urlIncludes: redactUrl(step.urlIncludes) };
    default:
      return { ...step };
  }
}

/** A workflow definition safe to record. Pure. */
export function redactWorkflow(workflow: BrowserWorkflow): BrowserWorkflow {
  return { ...workflow, steps: Array.isArray(workflow.steps) ? workflow.steps.map(redactStep) : workflow.steps };
}

/** A run safe to record: every detail, excerpt, address and download redacted. Pure and idempotent. */
export function redactRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    steps: run.steps.map((s) => ({ ...s, detail: redactText(s.detail) })),
    extracted: run.extracted.map((e) => ({ ...e, text: redactText(e.text) })),
    downloads: run.downloads.map((d) => ({ ...d, url: redactUrl(d.url), text: redactText(d.text) })),
    finalUrl: run.finalUrl === null ? null : redactUrl(run.finalUrl),
    detail: redactText(run.detail),
  };
}

/** Keys whose value is a credential whatever it looks like. */
const SECRET_KEY = /^(password|passwd|pwd|passcode|passphrase|secret|client_?secret|token|access_?token|refresh_?token|id_?token|auth_?token|api_?key|apikey|cookie|cookies|set-cookie|authorization|session|session_?id|sessionid|otp|credential|credentials|private_?key|storage_?state)$/i;
const URL_KEY = /^(url|href|src|finalurl|pageurl|starturl|redirect|redirecturl|location|referer|referrer)$/i;
const HEADERS_KEY = /^(headers|requestheaders|responseheaders)$/i;
const SCREENSHOT_KEY = /^(screenshot|screenshots)$/i;

function looksLikeScreenshot(v: unknown): v is RecordedScreenshot {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'ref' in (v as Record<string, unknown>);
}

/**
 * Any value a browser routine is about to record — a step detail, a run, a
 * page excerpt, a header map — with every secret replaced. Walks plain
 * objects and arrays; strings are redacted as free text, credential-named
 * keys are replaced whole, header maps and screenshot references get their
 * own treatment, and a `fill` step is handled as a form entry. Pure and
 * idempotent; the input is never mutated.
 */
export function redactLog<T>(entry: T): T {
  return walk(entry, null, new WeakMap()) as T;
}

function walk(value: unknown, key: string | null, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    if (key !== null && SECRET_KEY.test(key)) return value === '' || isMarker(value) ? value : REDACTED;
    if (key !== null && URL_KEY.test(key)) return redactText(redactUrl(value));
    return redactText(value);
  }
  if (value === null || typeof value !== 'object') {
    if (key !== null && SECRET_KEY.test(key) && value !== null && value !== undefined && typeof value !== 'boolean') return REDACTED;
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    if (key !== null && SCREENSHOT_KEY.test(key)) {
      const out = value.map((v) => (looksLikeScreenshot(v) ? walk(redactScreenshot(v), null, seen) : walk(v, null, seen)));
      seen.set(value, out);
      return out;
    }
    const out: unknown[] = [];
    seen.set(value, out);
    for (const v of value) out.push(walk(v, null, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // a Buffer, a Date: not text, recorded as it is
  if (key !== null && SECRET_KEY.test(key)) return REDACTED;
  let obj = value as Record<string, unknown>;
  if (key !== null && HEADERS_KEY.test(key)) obj = redactHeaders(obj);
  if (key !== null && SCREENSHOT_KEY.test(key) && looksLikeScreenshot(obj)) obj = redactScreenshot(obj);
  if (obj.kind === 'fill' && typeof obj.value === 'string') {
    const loc = (obj.locator ?? {}) as Record<string, unknown>;
    obj = { ...obj, value: redactFormValue(locatorText({ locator: loc }), obj.value) };
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'value' && obj.kind === 'fill') out[k] = v;
    else out[k] = walk(v, k, seen);
  }
  return out;
}
