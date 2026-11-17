/**
 * Resolving how to reach the real content behind a catalog listing (ACQ-21-4,
 * behaviour 2), and reading it again only when it changed.
 *
 * A catalog listing is not the underlying dataset. A CKAN `package_show`
 * answer (Data.gov is one), a DCAT record or any registry entry describes a
 * dataset and links to it; `resolveAccess` turns that description into the
 * resources that actually carry the data — their format, endpoint, bulk export
 * link, update mechanism, authentication and usage constraints — and never into
 * the listing itself. When both a bulk/dump link and a paged API exist, the bulk
 * route is preferred over polling the API page by page.
 *
 * A constraint found in the listing (a login, an API key, a restricted access
 * level, a licence) is reported as a constraint and makes that resource
 * unusable for an automated read; it is never routed around. Which method class
 * fits a need stays `../sources/accessMethods.ts`'s judgment, and opening and
 * recording a source stays `../sources/access.ts`'s: this module only reads a
 * listing it is given and wraps an injected transport.
 *
 * `conditionalFetcher` sends the stored ETag / Last-Modified validators as
 * `If-None-Match` / `If-Modified-Since` and treats a 304 as NOT_MODIFIED, so an
 * unchanged dataset is not re-ingested. A 200 whose content hash equals the
 * stored one is also NOT_MODIFIED (a server that ignores validators still
 * costs no re-ingest). Pure apart from the injected transport.
 */
import { createHash } from 'node:crypto';
import type { MethodClass } from '../sources/accessMethods.ts';

/** How the content behind a resource is kept current. */
export type UpdateMechanism = 'EVENT_SUBSCRIPTION' | 'BULK_SNAPSHOT' | 'CONDITIONAL_FETCH' | 'PAGED_API' | 'UNKNOWN';

/** What a resource is, judged from its own fields, never from the dataset's subject. */
export type ResourceKind = 'BULK' | 'FEED' | 'DOCUMENT' | 'API' | 'LANDING_PAGE';

export type AuthenticationNeed = 'NONE' | 'REQUIRED' | 'UNKNOWN';

export interface ResolvedResource {
  url: string;
  name: string | null;
  /** Normalised upper-case format (CSV, JSON, ZIP, API, HTML …) or null when nothing states it. */
  format: string | null;
  kind: ResourceKind;
  /** The method class in `accessMethods.ts` terms this resource would be read through. */
  methodClass: MethodClass;
  updateMechanism: UpdateMechanism;
  authentication: AuthenticationNeed;
  /** Constraints this resource states, in plain words; honoured, never bypassed. */
  constraints: string[];
  /** False when a stated constraint stops an automated read (login, key, restriction). */
  automatable: boolean;
  /** Why it was ranked where it was. */
  note: string;
}

export interface ResolvedAccess {
  /** The listing that was resolved. Never itself a resource. */
  listingUrl: string | null;
  title: string | null;
  licence: string | null;
  /** The dataset's own update frequency, as the listing states it. */
  statedFrequency: string | null;
  /** Every real resource, best first. */
  resources: ResolvedResource[];
  /** The best automatable resource, or null when none is automatable. */
  preferred: ResolvedResource | null;
  /** Constraints that apply to the whole dataset. */
  constraints: string[];
  /** Links that only point back at a catalog page and were set aside. */
  setAside: { url: string; reason: string }[];
  /** When no resource is automatable: the boundary met and the permitted route to seek. */
  handoff: string | null;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

const BULK_FORMATS = new Set(['ZIP', 'GZ', 'GZIP', 'TGZ', 'TAR', 'BZ2', 'XZ', '7Z', 'PARQUET', 'WARC', 'WAT', 'WET', 'NDJSON', 'JSONL', 'DUMP', 'SQL']);
const FEED_FORMATS = new Set(['RSS', 'ATOM', 'WEBHOOK', 'WEBSUB', 'SSE']);
const DOCUMENT_FORMATS = new Set(['CSV', 'TSV', 'JSON', 'XML', 'XLS', 'XLSX', 'PDF', 'TXT', 'GEOJSON', 'KML', 'SHP', 'ODS', 'RDF', 'TTL', 'NT']);
const API_FORMATS = new Set(['API', 'ESRI REST', 'REST', 'SPARQL', 'WMS', 'WFS', 'ARCGIS GEOSERVICES REST API', 'OGC API', 'ODATA', 'GRAPHQL']);
const PAGE_FORMATS = new Set(['HTML', 'HTM', 'WEB PAGE', 'WEBPAGE', 'LANDING PAGE']);

const EXTENSION_FORMAT: readonly [RegExp, string][] = [
  [/\.(zip)(\?|$)/i, 'ZIP'],
  [/\.(t?gz|gzip)(\?|$)/i, 'GZ'],
  [/\.bz2(\?|$)/i, 'BZ2'],
  [/\.xz(\?|$)/i, 'XZ'],
  [/\.parquet(\?|$)/i, 'PARQUET'],
  [/\.warc(\.gz)?(\?|$)/i, 'WARC'],
  [/\.(jsonl|ndjson)(\?|$)/i, 'JSONL'],
  [/\.csv(\?|$)/i, 'CSV'],
  [/\.tsv(\?|$)/i, 'TSV'],
  [/\.json(\?|$)/i, 'JSON'],
  [/\.xml(\?|$)/i, 'XML'],
  [/\.xlsx?(\?|$)/i, 'XLSX'],
  [/\.pdf(\?|$)/i, 'PDF'],
  [/\.(rss)(\?|$)/i, 'RSS'],
  [/\.(atom)(\?|$)/i, 'ATOM'],
  [/\.html?(\?|$)/i, 'HTML'],
];

function normaliseFormat(format: string | null, url: string, mimetype: string | null): string | null {
  const stated = format?.toUpperCase().replace(/^\./, '') ?? null;
  if (stated) return stated;
  for (const [re, f] of EXTENSION_FORMAT) if (re.test(url)) return f;
  const mime = mimetype?.toLowerCase() ?? '';
  if (mime.includes('zip')) return 'ZIP';
  if (mime.includes('csv')) return 'CSV';
  if (mime.includes('json')) return 'JSON';
  if (mime.includes('rss')) return 'RSS';
  if (mime.includes('atom')) return 'ATOM';
  if (mime.includes('xml')) return 'XML';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('html')) return 'HTML';
  return null;
}

const DUMP_WORDS = /\b(bulk|dump|full (download|export|extract)|archive|snapshot|complete dataset)\b/i;
const API_WORDS = /\b(api|endpoint|query service|sparql|rest service)\b/i;
const PAGED_WORDS = /[?&](page|offset|start|cursor|limit|rows)=/i;

function kindOf(format: string | null, url: string, text: string, resourceType: string | null): ResourceKind {
  if (format && FEED_FORMATS.has(format)) return 'FEED';
  if (format && BULK_FORMATS.has(format)) return 'BULK';
  if (resourceType === 'api' || (format && API_FORMATS.has(format))) return 'API';
  if (format && DOCUMENT_FORMATS.has(format)) return DUMP_WORDS.test(text) ? 'BULK' : 'DOCUMENT';
  if (format && PAGE_FORMATS.has(format)) return 'LANDING_PAGE';
  if (DUMP_WORDS.test(text)) return 'BULK';
  if (API_WORDS.test(text) || PAGED_WORDS.test(url) || /\/api\//i.test(url)) return 'API';
  return 'LANDING_PAGE';
}

const METHOD_OF_KIND: Record<ResourceKind, MethodClass> = {
  BULK: 'BULK',
  FEED: 'BULK',
  DOCUMENT: 'HTTP',
  API: 'NATIVE',
  LANDING_PAGE: 'HTTP',
};

function mechanismOf(kind: ResourceKind, format: string | null, url: string, text: string): UpdateMechanism {
  if (format === 'WEBHOOK' || format === 'WEBSUB' || format === 'SSE' || /\b(webhook|websub|subscribe|subscription|push notification)\b/i.test(text)) return 'EVENT_SUBSCRIPTION';
  if (kind === 'BULK') return 'BULK_SNAPSHOT';
  if (kind === 'FEED' || kind === 'DOCUMENT') return 'CONDITIONAL_FETCH';
  // An API with no subscription is read by asking it again: polling, page by page.
  if (kind === 'API') return 'PAGED_API';
  return 'UNKNOWN';
}

/** Lower is better. Event subscriptions and bulk exports before polling an API page by page. */
const KIND_RANK: Record<ResourceKind, number> = { BULK: 1, FEED: 2, DOCUMENT: 3, API: 4, LANDING_PAGE: 5 };
const MECHANISM_BONUS: Record<UpdateMechanism, number> = { EVENT_SUBSCRIPTION: -2, BULK_SNAPSHOT: 0, CONDITIONAL_FETCH: 0, PAGED_API: 0, UNKNOWN: 0.5 };

const AUTH_WORDS = /\b(api[ _-]?key|token required|log ?in|sign ?in|login required|registration required|register to|requires? (an )?account|authenticat\w*|oauth|subscription required|credentials?)\b/i;
const RESTRICTED_ACCESS = new Set(['restricted public', 'non-public', 'restricted', 'private']);
const TERMS_WORDS = /\b(terms of (use|service)|fair access|rate limit\w*|user-agent|no more than \d+ requests?|acceptable use|attribution required|non-commercial)\b/i;

function authAndConstraints(r: Json, text: string): { authentication: AuthenticationNeed; constraints: string[]; automatable: boolean } {
  const constraints: string[] = [];
  let authentication: AuthenticationNeed = 'UNKNOWN';
  let automatable = true;
  const accessLevel = str(r.access_level) ?? str(r.accessLevel) ?? str(r.accessRights);
  const restricted = r.restricted === true || r.restricted === 'true' || (accessLevel !== null && RESTRICTED_ACCESS.has(accessLevel.toLowerCase()));
  const statedAuth = str(r.authentication) ?? str(r.auth);
  if (restricted) {
    constraints.push(`access is restricted${accessLevel ? ` (${accessLevel})` : ''}: obtain permitted access, do not read around it`);
    automatable = false;
    authentication = 'REQUIRED';
  }
  if ((statedAuth && !/^(none|no|false|public)$/i.test(statedAuth)) || r.requires_auth === true || r.requiresAuth === true || AUTH_WORDS.test(text)) {
    constraints.push(`authentication required${statedAuth ? ` (${statedAuth})` : ''}: an authorized account or key must be granted; it is not bypassed`);
    automatable = false;
    authentication = 'REQUIRED';
  } else if (!restricted && (statedAuth || r.requires_auth === false || r.requiresAuth === false || (accessLevel && accessLevel.toLowerCase() === 'public'))) {
    authentication = 'NONE';
  }
  const terms = text.match(TERMS_WORDS);
  if (terms) constraints.push(`usage terms stated (${terms[0]}): honour them for every read`);
  const rights = str(r.rights) ?? str(r.license) ?? str(r.license_title);
  if (rights) constraints.push(`licence/rights: ${rights}`);
  return { authentication, constraints, automatable };
}

function sameTarget(a: string, b: string | null): boolean {
  if (!b) return false;
  const n = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/** A link that only points back at a catalog page: the listing, the CKAN API or a dataset page on the catalog host. */
function catalogEcho(url: string, listingUrl: string | null, catalogHost: string | null): string | null {
  if (sameTarget(url, listingUrl)) return 'is the listing itself';
  if (/\/api\/(3\/)?action\/package_(show|search)\b/i.test(url)) return 'is the catalog API describing the dataset, not the dataset';
  let host: string | null = null;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return 'is not a URL';
  }
  if (catalogHost && host === catalogHost && /\/dataset\/[^/]+\/?$/i.test(new URL(url).pathname)) return 'is the catalog page for the dataset';
  return null;
}

function unwrapListing(listing: unknown): { pkg: Json; resources: Json[] } {
  const root = obj(listing) ?? {};
  // CKAN action API wraps its answer as { success, result }.
  const pkg = obj(root.result) ?? root;
  const raw = Array.isArray(pkg.resources) ? pkg.resources : Array.isArray(pkg.distribution) ? pkg.distribution : [];
  const resources: Json[] = [];
  for (const r of raw) {
    const o = obj(r);
    if (o) resources.push(o);
  }
  return { pkg, resources };
}

/**
 * Turns a catalog listing into the resources that carry the data, best first.
 * Accepts a CKAN `package_show` answer (wrapped or not) or a DCAT-style record
 * with `distribution`. Pure.
 */
export function resolveAccess(listing: unknown, listingUrl: string | null = null): ResolvedAccess {
  const { pkg, resources: raw } = unwrapListing(listing);
  let catalogHost: string | null = null;
  if (listingUrl) {
    try {
      catalogHost = new URL(listingUrl).host.toLowerCase();
    } catch {
      catalogHost = null;
    }
  }
  const licence = str(pkg.license_title) ?? str(pkg.license_id) ?? str(pkg.license) ?? str(pkg.rights);
  const datasetConstraints: string[] = [];
  if (licence) datasetConstraints.push(`licence: ${licence}`);
  if (pkg.private === true) datasetConstraints.push('the dataset is marked private in its catalog: obtain permitted access');
  const datasetAccess = str(pkg.accessLevel) ?? str(pkg.access_level);
  if (datasetAccess && RESTRICTED_ACCESS.has(datasetAccess.toLowerCase())) datasetConstraints.push(`dataset access level: ${datasetAccess}`);
  const datasetRestricted = pkg.private === true || (datasetAccess !== null && RESTRICTED_ACCESS.has(datasetAccess.toLowerCase()));

  const setAside: { url: string; reason: string }[] = [];
  const resources: ResolvedResource[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const url = str(r.url) ?? str(r.downloadURL) ?? str(r.accessURL) ?? str(r.download_url) ?? str(r.access_url);
    if (!url) continue;
    const echo = catalogEcho(url, listingUrl, catalogHost);
    if (echo) {
      setAside.push({ url, reason: `${url} ${echo}` });
      continue;
    }
    const key = url.replace(/#.*$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = str(r.name) ?? str(r.title);
    const text = [name, str(r.description), str(r.notes), str(r.conformsTo), str(r.authentication)].filter(Boolean).join(' ');
    const format = normaliseFormat(str(r.format), url, str(r.mimetype) ?? str(r.mediaType));
    const kind = kindOf(format, url, text, str(r.resource_type)?.toLowerCase() ?? null);
    const updateMechanism = mechanismOf(kind, format, url, text);
    const ac = authAndConstraints(r, text);
    const automatable = ac.automatable && !datasetRestricted;
    resources.push({
      url,
      name,
      format,
      kind,
      methodClass: METHOD_OF_KIND[kind],
      updateMechanism,
      authentication: datasetRestricted && ac.authentication !== 'REQUIRED' ? 'REQUIRED' : ac.authentication,
      constraints: ac.constraints,
      automatable,
      note:
        kind === 'BULK'
          ? 'a bulk export or dump: read it whole once, then incrementally, instead of polling an API page by page'
          : kind === 'FEED'
            ? 'a feed: read it conditionally, or subscribe where the source offers it'
            : kind === 'DOCUMENT'
              ? 'a single document: read it with a conditional fetch'
              : kind === 'API'
                ? 'an API: used when no bulk export covers the need, paced to the source'
                : 'a landing page, not the data itself: last resort',
    });
  }

  const score = (r: ResolvedResource) => KIND_RANK[r.kind] + MECHANISM_BONUS[r.updateMechanism] + (r.automatable ? 0 : 10);
  const ordered = resources
    .map((r, i) => ({ r, i }))
    .sort((a, b) => score(a.r) - score(b.r) || a.i - b.i)
    .map((x) => x.r);
  const preferred = ordered.find((r) => r.automatable && r.kind !== 'LANDING_PAGE') ?? ordered.find((r) => r.automatable) ?? null;
  const handoff =
    preferred || ordered.length === 0
      ? null
      : 'every resource states an access constraint (authentication, a key or a restricted access level): seek an authorized account, an official export or a licence; nothing is read around it';

  return {
    listingUrl,
    title: str(pkg.title) ?? str(pkg.name),
    licence,
    statedFrequency: str(pkg.accrualPeriodicity) ?? str(pkg.update_frequency) ?? str(pkg.frequency),
    resources: ordered,
    preferred,
    constraints: datasetConstraints,
    setAside,
    handoff,
  };
}

/** A URL that names a packed archive: whatever format a catalog states, its body is not the records themselves. */
const ARCHIVE_URL = /\.(zip|t?gz|gzip|bz2|xz|7z|tar)(\?|$)/i;
/** Formats a JSON reader can parse as they arrive. */
const JSON_READABLE = new Set(['JSON', 'GEOJSON']);

/**
 * Whether a reader that parses `format` (a source's declared access format)
 * can read this resource's body as it arrives. A catalog's "JSON" link to a
 * `.json.zip` is an archive, never a JSON body; an API resource with no stated
 * format (or `API`) answers JSON, the common case a JSON reader expects, and
 * health classifies it as a broken parser if it does not. Pure.
 */
export function readableAs(resource: Pick<ResolvedResource, 'url' | 'format' | 'kind' | 'automatable'>, format: string): boolean {
  if (!resource.automatable || resource.kind === 'LANDING_PAGE') return false;
  if (ARCHIVE_URL.test(resource.url)) return false;
  const want = format.toUpperCase();
  const have = resource.format?.toUpperCase() ?? null;
  if (want === 'JSON') return (have !== null && JSON_READABLE.has(have)) || (resource.kind === 'API' && (have === null || have === 'API' || have === 'JSON'));
  return have === want;
}

/**
 * The best resource of a resolved listing that a reader of `format` can read:
 * the ranking `resolveAccess` made, narrowed to what the reader parses, so a
 * bulk ZIP is never handed to a JSON parser. Null when none qualifies. Pure.
 */
export function preferredReadable(access: ResolvedAccess, format: string): ResolvedResource | null {
  return access.resources.find((r) => readableAs(r, format)) ?? null;
}

// ---------------------------------------------------------------------------
// Conditional fetching
// ---------------------------------------------------------------------------

/** The validators and content hash stored from the last successful read. */
export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
}

export interface TransportResponse {
  status: number;
  /** Response headers; names are matched case-insensitively. */
  headers: Record<string, string | undefined>;
  body: string;
}

/** The injected network call. Tests pass a stub; production passes `httpTransport`. */
export type Transport = (url: string, headers: Record<string, string>, timeoutMs?: number) => Promise<TransportResponse>;

export type ConditionalResult =
  | { status: 'NOT_MODIFIED'; httpStatus: number; validators: Validators; reason: string }
  | { status: 'MODIFIED'; httpStatus: number; body: string; validators: Validators; contentHash: string };

export const contentHashOf = (body: string): string => createHash('sha256').update(body).digest('hex');

function header(headers: Record<string, string | undefined>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want && typeof v === 'string' && v !== '') return v;
  return null;
}

/** The request headers a conditional read sends, from the prior validators. Pure. */
export function conditionalHeaders(prior: Validators | null | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (prior?.etag) h['If-None-Match'] = prior.etag;
  if (prior?.lastModified) h['If-Modified-Since'] = prior.lastModified;
  return h;
}

/**
 * Wraps a transport into a conditional reader. A 304 is NOT_MODIFIED and keeps
 * the prior validators (refreshed by any the 304 carried); a 200 whose body hash
 * equals the stored hash is NOT_MODIFIED too. Any other non-2xx status throws
 * `HTTP <status>`, so a refusal is never mistaken for "unchanged".
 */
export function conditionalFetcher(transport: Transport) {
  return async (url: string, prior: Validators | null = null, extraHeaders: Record<string, string> = {}, timeoutMs?: number): Promise<ConditionalResult> => {
    const response = await transport(url, { ...extraHeaders, ...conditionalHeaders(prior) }, timeoutMs);
    const etag = header(response.headers, 'etag');
    const lastModified = header(response.headers, 'last-modified');
    if (response.status === 304) {
      return {
        status: 'NOT_MODIFIED',
        httpStatus: 304,
        validators: { etag: etag ?? prior?.etag ?? null, lastModified: lastModified ?? prior?.lastModified ?? null, contentHash: prior?.contentHash ?? null },
        reason: 'the source answered 304 Not Modified to the stored validators',
      };
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    const contentHash = contentHashOf(response.body);
    const validators: Validators = { etag, lastModified, contentHash };
    if (prior?.contentHash && prior.contentHash === contentHash) {
      return { status: 'NOT_MODIFIED', httpStatus: response.status, validators, reason: 'the content hash equals the stored one' };
    }
    return { status: 'MODIFIED', httpStatus: response.status, body: response.body, validators, contentHash };
  };
}

/** The production transport over `fetch`. Kept separate so the logic above stays testable without a network. */
export const httpTransport: Transport = async (url, headers, timeoutMs = 30_000) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: response.status, headers: out, body: response.status === 304 ? '' : await response.text() };
};
