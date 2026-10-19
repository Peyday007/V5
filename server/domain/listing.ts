/**
 * A known listing on a platform: which one it is, read from the link it was
 * found at, and what a retrieval of it established.
 *
 * Regular code retrieves a listing Brain already knows about; a worker judges
 * the opportunity. So the identity is derived here, from the accepted claim's
 * own source URL, and is handed to every follow-up task verbatim — a worker
 * that rebuilt the address from a title or a publisher name could read a
 * different listing and report it as this one.
 *
 * Pure. Nothing here fetches, reads a row or reads a clock.
 */

/** The platforms Brain can identify a listing on. One today. */
export type ListingPlatform = 'FREELANCER';

export interface ListingRef {
  platform: ListingPlatform;
  /** The platform's own numeric id, when the link carries one. */
  platformId: string | null;
  /** The platform's own slug path ("category/Slug"), when the link carries that instead. */
  seoUrl: string | null;
  /** The link exactly as the source claim recorded it. Never rewritten. */
  originalUrl: string;
}

// The same publisher's country sites (freelancer.co.uk, .ca, .in, .com.au …),
// matching `readableRoutes.ts`.
const FREELANCER_HOST = /^(www\.)?freelancer\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/i;

/**
 * Which listing a URL names, or null when it names none Brain can identify.
 *
 * Only what the URL itself says: an id in the API path or in `projects[]`, or
 * a slug in a listing page path. A search page, a profile or any other address
 * names no one listing and is null rather than a guess.
 */
export function parseListingRef(url: string | null | undefined): ListingRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !FREELANCER_HOST.test(parsed.hostname)) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  const api = /^\/api\/projects\/0\.1\/projects\/(\d+)$/.exec(path);
  if (api) return { platform: 'FREELANCER', platformId: api[1]!, seoUrl: null, originalUrl: url };
  const listed = parsed.searchParams.getAll('projects[]');
  if (/^\/api\/projects\/0\.1\/projects$/.test(path) && listed.length === 1 && /^\d+$/.test(listed[0]!)) {
    return { platform: 'FREELANCER', platformId: listed[0]!, seoUrl: null, originalUrl: url };
  }
  const page = /^\/projects\/(.+)$/.exec(path);
  if (page) {
    const rest = decodeURIComponent(page[1]!);
    if (/^\d+$/.test(rest)) return { platform: 'FREELANCER', platformId: rest, seoUrl: null, originalUrl: url };
    // A listing slug is "category/Title-words"; a single segment is a category
    // or a search, which names no one listing.
    if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(rest)) {
      return { platform: 'FREELANCER', platformId: null, seoUrl: rest, originalUrl: url };
    }
  }
  return null;
}

/** The one address Brain retrieves a Freelancer listing from. */
export function freelancerRequestUrl(ref: ListingRef): string {
  if (ref.platformId) {
    return `https://www.freelancer.com/api/projects/0.1/projects/${ref.platformId}/?full_description=true`;
  }
  return (
    'https://www.freelancer.com/api/projects/0.1/projects/?full_description=true&seo_urls[]=' +
    encodeURIComponent(ref.seoUrl ?? '')
  );
}

/**
 * What one retrieval established, in four answers that must not be collapsed.
 *
 * `NOT_FOUND` is the platform saying this listing is not there. `BLOCKED` is
 * the platform refusing this client. `TEMPORARY` is a timeout, a reset, a 5xx
 * or a rate limit. None of the three failures is evidence about demand: a
 * listing Brain could not read is a listing Brain did not read.
 */
export const LISTING_OUTCOMES = ['RETRIEVED', 'NOT_FOUND', 'BLOCKED', 'TEMPORARY'] as const;
export type ListingOutcome = (typeof LISTING_OUTCOMES)[number];

/** How many temporary failures in a row before Brain stops retrying a listing. */
export const MAX_TEMPORARY_ATTEMPTS = 3;

export interface ClassifiedRetrieval {
  outcome: ListingOutcome;
  /** The platform's id for the listing, when the response named it. */
  platformId: string | null;
  reason: string;
}

/** What an HTTP answer from the Freelancer API establishes. */
export function classifyFreelancerAnswer(status: number, body: unknown): ClassifiedRetrieval {
  if (status === 404 || status === 410) {
    return { outcome: 'NOT_FOUND', platformId: null, reason: `the platform answered ${status}: the listing does not exist there` };
  }
  if (status === 429 || status >= 500) {
    return { outcome: 'TEMPORARY', platformId: null, reason: `the platform answered ${status}` };
  }
  if (status === 401 || status === 403 || (status >= 400 && status < 500)) {
    return { outcome: 'BLOCKED', platformId: null, reason: `the platform refused the request (${status})` };
  }
  if (status < 200 || status >= 300) {
    return { outcome: 'TEMPORARY', platformId: null, reason: `the platform answered ${status}` };
  }
  const project = freelancerProject(body);
  if (!project) {
    const result = (body as { result?: { projects?: unknown } } | null)?.result;
    // An seo lookup that matched nothing is an empty list, which the platform
    // means as "no such listing".
    if (result && Array.isArray(result.projects) && result.projects.length === 0) {
      return { outcome: 'NOT_FOUND', platformId: null, reason: 'the platform has no listing at that address' };
    }
    return { outcome: 'TEMPORARY', platformId: null, reason: 'the platform answered 2xx with a body Brain could not read' };
  }
  return { outcome: 'RETRIEVED', platformId: project.id, reason: 'retrieved' };
}

export interface FreelancerProject {
  id: string;
  title: string | null;
  status: string | null;
  frontendStatus: string | null;
  postedAt: string | null;
  budget: string | null;
  bids: string | null;
  seoUrl: string | null;
  description: string | null;
}

/** The fields a worker needs from one project, read out of an API body. */
export function freelancerProject(body: unknown): FreelancerProject | null {
  if (!body || typeof body !== 'object') return null;
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return null;
  const listed = (result as { projects?: unknown }).projects;
  const raw = (Array.isArray(listed) ? listed[0] : result) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || (typeof raw.id !== 'number' && typeof raw.id !== 'string')) return null;
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const budget = raw.budget as Record<string, unknown> | undefined;
  const currency = text((raw.currency as Record<string, unknown> | undefined)?.code);
  const min = num(budget?.minimum);
  const max = num(budget?.maximum);
  const stats = raw.bid_stats as Record<string, unknown> | undefined;
  const bidCount = num(stats?.bid_count);
  const bidAvg = num(stats?.bid_avg);
  const submitted = num(raw.time_submitted) ?? num(raw.submitdate);
  return {
    id: String(raw.id),
    title: text(raw.title),
    status: text(raw.status),
    frontendStatus: text(raw.frontend_project_status),
    postedAt: submitted !== null ? new Date(submitted * 1000).toISOString() : null,
    budget:
      min !== null || max !== null
        ? `${min ?? '?'}–${max ?? '?'} ${currency ?? ''} ${text(raw.type) ?? ''}`.replace(/\s+/g, ' ').trim()
        : null,
    bids: bidCount !== null ? `${bidCount}${bidAvg !== null ? ` (average ${Math.round(bidAvg * 100) / 100})` : ''}` : null,
    seoUrl: text(raw.seo_url),
    description: text(raw.description) ?? text(raw.preview_description),
  };
}

/**
 * The sentence a follow-up task's question carries about its listing.
 *
 * Stable: it is composed from the source claim and nothing that changes, so a
 * question compiled from it is the same question on every read.
 */
export function listingIdentitySentence(input: {
  ref: ListingRef | null;
  originalUrl: string | null;
  sourceClaimId: string | null;
}): string {
  if (!input.originalUrl) return '';
  const which = input.ref?.platformId
    ? `This is Freelancer project ${input.ref.platformId}, found at ${input.originalUrl}`
    : input.ref
      ? `This is the Freelancer listing "${input.ref.seoUrl}", found at ${input.originalUrl}`
      : `It was found at ${input.originalUrl}`;
  const claim = input.sourceClaimId ? ` (source claim ${input.sourceClaimId})` : '';
  return (
    ` ${which}${claim}. Read that listing by that link${input.ref?.platformId ? ' and that id' : ''}; ` +
    'do not reconstruct, guess or search for another address for it.'
  );
}
