/**
 * What makes a claim sourced.
 *
 * The rule from the spec is blunt and the whole ledger depends on it: no URL
 * means the claim is not treated as sourced. Everything here exists to apply
 * that rule the same way every time, and to say why when it fails.
 *
 * Validation is structural, not liveness. Brain does not fetch the URLs a model
 * returns: fetching attacker-chosen addresses from the user's machine is exactly
 * the request-forgery hazard a local-first tool should not introduce, and a 200
 * response would not prove the page says what the claim says anyway. What is
 * checked is that the address is a real, absolute, public web URL — and an
 * unreachable-but-well-formed URL is a lead a person can follow, which is more
 * than an invented one gives them.
 */
import crypto from 'node:crypto';
import type { ClaimValidationState } from '../../domain/types.ts';

export interface RawClaim {
  claim: string;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourcePublisher?: string | null;
  sourceDate?: string | null;
  evidenceExcerpt?: string | null;
  evidenceLocator?: string | null;
  retrievedAt?: string | null;
  confidence?: number | null;
}

export interface ValidatedClaim extends RawClaim {
  normalizedUrl: string | null;
  validationState: ClaimValidationState;
  validationDetail: string | null;
  sourced: boolean;
  contentHash: string;
}

/** Only the public web. A file:// or data: "source" is not a source. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Addresses that cannot be evidence for anybody but the machine that produced
 * them. A citation nobody else can follow is not a citation.
 */
function isLocalAddress(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  // A bare hostname with no dot is an intranet name, not a public source.
  return !host.includes('.');
}

/** The claim's identity: its text, normalized for whitespace and case. */
export function claimHash(claim: string): string {
  const normalized = claim.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * The URL as it will be compared and stored.
 *
 * Tracking parameters and fragments are dropped so the same page cited twice is
 * recognisably the same page; the path is left alone, because a path is content.
 */
export function normalizeUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  for (const key of [...copy.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref)$/i.test(key)) copy.searchParams.delete(key);
  }
  copy.hostname = copy.hostname.toLowerCase();
  return copy.toString();
}

/** A date the reader can act on: ISO, or a plain year/month, and never the future. */
function plausibleDate(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(trimmed) && Number.isNaN(Date.parse(trimmed))) return false;
  const parsed = new Date(/^\d{4}$/.test(trimmed) ? `${trimmed}-01-01` : trimmed);
  if (Number.isNaN(parsed.getTime())) return false;
  // A day of slack for clock skew between the tool and this machine.
  return parsed.getTime() <= Date.now() + 24 * 60 * 60 * 1000;
}

/**
 * Judge one claim's source.
 *
 * Order matters: the strongest objection is reported, so "you gave no URL" is
 * never masked by a complaint about a missing excerpt.
 */
export function validateClaim(raw: RawClaim): ValidatedClaim {
  const base = {
    ...raw,
    contentHash: claimHash(raw.claim),
    normalizedUrl: null as string | null,
  };

  const url = (raw.sourceUrl ?? '').trim();
  if (url.length === 0) {
    return {
      ...base,
      validationState: 'NO_URL',
      validationDetail:
        'No source URL was given, so this is the tool\'s assertion rather than evidence.',
      sourced: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ...base,
      validationState: 'INVALID_URL',
      validationDetail: `"${url.slice(0, 120)}" is not a valid absolute URL.`,
      sourced: false,
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ...base,
      validationState: 'UNSUPPORTED_SCHEME',
      validationDetail: `${parsed.protocol} is not a web address anybody else can open.`,
      sourced: false,
    };
  }

  if (isLocalAddress(parsed.hostname)) {
    return {
      ...base,
      validationState: 'LOCAL_ADDRESS',
      validationDetail: `${parsed.hostname} is a local or private address, not a public source.`,
      sourced: false,
    };
  }

  const excerpt = (raw.evidenceExcerpt ?? '').trim();
  const locator = (raw.evidenceLocator ?? '').trim();
  if (excerpt.length === 0 && locator.length === 0) {
    // A bare link is a reading suggestion. The spec asks for the passage or the
    // place in the document, because that is what makes the claim checkable.
    return {
      ...base,
      normalizedUrl: normalizeUrl(parsed),
      validationState: 'NO_EVIDENCE',
      validationDetail:
        'A URL was given but no supporting passage or locator, so the claim cannot be checked against it.',
      sourced: false,
    };
  }

  const date = (raw.sourceDate ?? '').trim();
  const dateWarning =
    date.length > 0 && !plausibleDate(date)
      ? ` The stated date "${date}" is not a usable or past date.`
      : '';

  return {
    ...base,
    normalizedUrl: normalizeUrl(parsed),
    validationState: 'SOURCED',
    validationDetail: dateWarning.trim().length > 0 ? dateWarning.trim() : null,
    sourced: true,
  };
}

export interface LedgerSummary {
  total: number;
  sourced: number;
  unsourced: number;
  distinctSources: number;
  contested: number;
  refuted: number;
  byState: Record<string, number>;
}

export function summarize(
  claims: { sourced: boolean; validationState: string; contradictionState: string; sourceUrl: string | null }[],
): LedgerSummary {
  const byState: Record<string, number> = {};
  const sources = new Set<string>();
  let sourced = 0;
  let contested = 0;
  let refuted = 0;

  for (const claim of claims) {
    byState[claim.validationState] = (byState[claim.validationState] ?? 0) + 1;
    if (claim.sourced) {
      sourced += 1;
      if (claim.sourceUrl) sources.add(claim.sourceUrl);
    }
    if (claim.contradictionState === 'CONTESTED') contested += 1;
    if (claim.contradictionState === 'REFUTED') refuted += 1;
  }

  return {
    total: claims.length,
    sourced,
    unsourced: claims.length - sourced,
    distinctSources: sources.size,
    contested,
    refuted,
    byState,
  };
}
