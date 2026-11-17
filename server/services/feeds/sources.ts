/**
 * Free public sources plain code reads in bulk — no model, no key.
 *
 * Each source is a URL Brain wrote, a pull interval that respects the
 * publisher's stated limit, and a pure parser from the response body to
 * items. A parser never throws on a strange body: it returns what it can read
 * and drops the rest, because one malformed entry must not cost the batch.
 *
 * What an item is: a published, dated thing that may show a business needing
 * work done — a job opening, a new federal rule businesses must comply with, a
 * named business in the news. Every source names a real organisation; anonymous
 * forums are left out because nothing proves a business or a budget behind them. It is a raw lead, never evidence.
 */

export interface FeedItem {
  externalId: string;
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  publishedAt: string | null;
}

export interface FeedSource {
  id: string;
  label: string;
  url: string;
  /** How often Brain may ask, from the publisher's own guidance. */
  intervalMs: number;
  headers?: Record<string, string>;
  /** Wait this long before asking, when another source was just asked (a publisher's rate rule). */
  spacingMs?: number;
  /** How long one request may take; a slow public API gets longer. */
  timeoutMs?: number;
  /**
   * The same request narrowed to what was published since a cursor (ISO), for a
   * publisher whose API takes a start date. Absent: the source has no such
   * parameter and is read whole, with storage deduplicating what was seen.
   */
  cursorUrl?: (since: string) => string;
  parse(body: unknown): FeedItem[];
  /**
   * What the acquisition pipeline in `run.ts` reads about this source
   * (ACQ-21-3, ACQ-21-4): which corpus or open domain class it is an instance
   * of, the facts it is pulled for, how its real content is reached, and the
   * provenance every pull of it carries. Absent: the source is pulled the old
   * way, with no evaluation, health supervision or yield ranking.
   */
  acquisition?: SourceAcquisition;
  /**
   * A large source read in shards (index pages, archive members, query
   * windows) through `ingestShards`, checkpointed per shard so an interrupted
   * read resumes where it stopped. Absent: one request is one shard.
   */
  shards?: (now: Date) => { snapshot: string; keys: readonly string[]; url: (key: string) => string };
  /**
   * The provider's own statement, read from a body, that it holds no records
   * for what was asked (a total of zero), as distinct from a body whose
   * records the parser cannot read. Only an explicit zero counts; absent, an
   * empty parse is never assumed to be a quiet period (inv. 39).
   */
  emptyBody?: (body: unknown) => boolean;
}

/** How a source is reached and what each pull of it is recorded with. */
export interface SourceAcquisition {
  /**
   * The `CORPORA` id (`corpora.ts`) this source is an instance of: a named
   * corpus, or an open domain class (`domain:…`). Judged per need before every
   * pull; it is never a whitelist.
   */
  corpus: string;
  /** The kinds of fact the source is pulled for, in `corpora.ts`'s open vocabulary. */
  factKinds: readonly string[];
  /** The oldest a record may be and still answer the need, in days. Unstated is unknown, never favourable. */
  maxAgeDays?: number;
  /**
   * A catalog listing (a CKAN `package_show`, a DCAT record) that describes the
   * dataset rather than being it. When present, `resolveAccess` turns it into
   * the resource that carries the data, and that resource is read instead.
   */
  listingUrl?: string;
  /**
   * Query parameters appended to the resource a listing resolves to (paging,
   * ordering), in the provider's own vocabulary. The resource is still the one
   * the listing named; this only narrows what is asked of it.
   */
  resourceQuery?: string;
  access: {
    /** The format of the real content, upper case (JSON, CSV, ZIP …). */
    format: string;
    /** How the content is kept current: read conditionally, or a paged API asked again. */
    updateMechanism: 'CONDITIONAL_FETCH' | 'PAGED_API' | 'BULK_SNAPSHOT' | 'EVENT_SUBSCRIPTION';
    authentication: 'NONE' | 'REQUIRED';
    /** The publisher's stated usage constraint, honoured on every read. */
    usage: string;
  };
  provenance: {
    publisher: string;
    /** The licence or terms the records are retrieved under. */
    license: string;
    /** The version of this source's parser; a change in reading is visible in the rows. */
    parserVersion: string;
  };
}

/**
 * How far before the last successful pull an incremental read starts. A
 * publisher indexes late (GDELT minutes, the Federal Register by publication
 * day), so the window overlaps the last one and storage drops the repeats.
 */
export const CURSOR_OVERLAP_MS = 2 * 3_600_000;

/**
 * The URL one pull asks: incremental from the source's own last success when it
 * takes a start date, the whole listing otherwise (and on its first pull). Pure.
 */
export function pullUrl(source: Pick<FeedSource, 'url' | 'cursorUrl'>, lastSuccessAt: string | null): { url: string; incremental: boolean } {
  if (!source.cursorUrl || !lastSuccessAt) return { url: source.url, incremental: false };
  const at = Date.parse(lastSuccessAt);
  if (!Number.isFinite(at)) return { url: source.url, incremental: false };
  return { url: source.cursorUrl(new Date(at - CURSOR_OVERLAP_MS).toISOString()), incremental: true };
}

const HOUR = 3_600_000;
const MAX_BODY = 2_000;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Strip markup to plain words, bounded. */
export function plain(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const stripped = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return stripped ? stripped.slice(0, MAX_BODY) : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isHttpUrl(value: string | null): value is string {
  return !!value && /^https?:\/\//i.test(value);
}

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((one): one is Record<string, unknown> => !!one && typeof one === 'object' && !Array.isArray(one))
    : [];

/** RemoteOK's public API: a JSON array whose first entry is its legal notice. */
export function parseRemoteOk(body: unknown): FeedItem[] {
  const out: FeedItem[] = [];
  for (const row of records(body)) {
    const id = row['id'];
    const title = text(row['position']);
    const url = text(row['url']) ?? (id ? `https://remoteok.com/remote-jobs/${String(id)}` : null);
    if (!id || !title || !isHttpUrl(url)) continue;
    out.push({
      externalId: String(id),
      url,
      title,
      body: plain(row['description']),
      organization: text(row['company']),
      publishedAt: isoOrNull(row['date'] ?? row['epoch']),
    });
  }
  return out;
}

/** Remotive's public API: `{ jobs: [...] }`. */
export function parseRemotive(body: unknown): FeedItem[] {
  const jobs = body && typeof body === 'object' ? (body as Record<string, unknown>)['jobs'] : null;
  const out: FeedItem[] = [];
  for (const row of records(jobs)) {
    const id = row['id'];
    const title = text(row['title']);
    const url = text(row['url']);
    if (!id || !title || !isHttpUrl(url)) continue;
    out.push({
      externalId: String(id),
      url,
      title,
      body: plain(row['description']),
      organization: text(row['company_name']),
      publishedAt: isoOrNull(row['publication_date']),
    });
  }
  return out;
}

/**
 * The document a Federal Register correction corrects. A correction (C1-2026-21030) carries no
 * effective_on, dates or action of its own; its `correction_of` names the rule it corrects, either
 * as a document number, a documents URL (its final path segment) or an object with document_number.
 */
function correctedDocumentNumber(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return correctedDocumentNumber((value as Record<string, unknown>)['document_number']);
  }
  const raw = text(value);
  if (!raw) return null;
  if (!isHttpUrl(raw)) return raw;
  try {
    const segments = new URL(raw).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? decodeURIComponent(last).replace(/\.json$/i, '') : null;
  } catch {
    return null;
  }
}

/** The Federal Register's documents API: newly published final rules. */
export function parseFederalRegister(body: unknown): FeedItem[] {
  const results = body && typeof body === 'object' ? (body as Record<string, unknown>)['results'] : null;
  const out: FeedItem[] = [];
  for (const row of records(results)) {
    const id = text(row['document_number']);
    const title = text(row['title']);
    const url = text(row['html_url']);
    if (!id || !title || !isHttpUrl(url)) continue;
    const agencies = records(row['agencies'])
      .map((agency) => text(agency['name']))
      .filter((name): name is string => !!name);
    const effective = text(row['effective_on']);
    const abstract = plain(row['abstract']);
    const corrects = correctedDocumentNumber(row['correction_of']);
    out.push({
      externalId: id,
      url,
      title,
      body:
        [abstract, effective ? `Effective ${effective}.` : null, corrects ? `Corrects ${corrects}.` : null]
          .filter(Boolean)
          .join(' ') || null,
      organization: agencies.join(', ') || null,
      publishedAt: isoOrNull(row['publication_date']),
    });
  }
  return out;
}

/** GDELT's seen-date, `20261026T120000Z`, as ISO. */
function gdeltDate(value: unknown): string | null {
  const raw = text(value);
  const m = raw ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : isoOrNull(value);
}

/** The GDELT DOC API's article list: `{ articles: [...] }`. */
export function parseGdelt(body: unknown): FeedItem[] {
  const articles = body && typeof body === 'object' ? (body as Record<string, unknown>)['articles'] : null;
  const out: FeedItem[] = [];
  for (const row of records(articles)) {
    const url = text(row['url']);
    const title = text(row['title']);
    if (!title || !isHttpUrl(url)) continue;
    out.push({
      externalId: url.slice(0, 500),
      url,
      title,
      body: null,
      organization: text(row['domain']),
      publishedAt: gdeltDate(row['seendate']),
    });
  }
  return out;
}

/**
 * The two sides of the monthly Hacker News "Freelancer? Seeking freelancer?"
 * thread, read through HN's public Algolia search API (no key, no login):
 * `SEEKING FREELANCER` comments state a request to buy work from an outside
 * provider, and `SEEKING WORK` comments advertise a provider's capacity and
 * rate. One source family with both sides of one market, so a buyer's request
 * can meet a supplier in the event graph (ALGO-16-1 items 1 and 3).
 */
export type HnFreelanceSide = 'SEEKING FREELANCER' | 'SEEKING WORK';

/** A comment segment that names only where or how the work is done, not what it is. */
const WHERE_ONLY = /^(?:location\s*:?.*|remote(?:\s+only|\s+ok)?|on-?site|hybrid|anywhere|worldwide|(?:us|usa|eu|uk|europe|americas?)(?:\s+(?:only|time ?zones?))?)$/i;
/** A segment that is a place as people write one, `Austin, TX` (case matters: `React, Go` is work). */
const PLACE_ONLY = /^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:,\s*[A-Za-z .'-]+)?$/;

/**
 * Algolia's HN search hits: `{ hits: [{ objectID, comment_text, author, created_at, ... }] }`.
 * Only a comment that itself opens with the side's tag is kept (a reply quoting
 * it is not a request or an offer). Its title is the first segment that names
 * the work; the whole comment is the body, so place, rate and dates are read
 * from the author's own words.
 */
export function parseHnFreelance(side: HnFreelanceSide): (body: unknown) => FeedItem[] {
  const tag = new RegExp(`^\\s*${side.replace(' ', '\\s+')}\\b[\\s:|\\-–—]*`, 'i');
  return (body: unknown): FeedItem[] => {
    const hits = body && typeof body === 'object' ? (body as Record<string, unknown>)['hits'] : null;
    const out: FeedItem[] = [];
    for (const row of records(hits)) {
      const id = text(row['objectID']);
      const raw = text(row['comment_text']);
      const comment = plain(raw);
      // The heading is the comment's first paragraph: HN separates paragraphs with <p>, which plain text loses.
      const heading = plain(raw?.split(/<p>|\n/i)[0]);
      if (!id || !comment || !heading || !tag.test(heading)) continue;
      const rest = heading.replace(tag, '');
      const segments = rest.split(/\s*\|\s*/).map((one) => one.trim()).filter(Boolean);
      const what = segments.find((one) => one.length >= 3 && one.length <= 120 && !WHERE_ONLY.test(one) && !PLACE_ONLY.test(one));
      if (!what) continue;
      out.push({
        externalId: id,
        url: `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`,
        title: what.slice(0, 200),
        body: comment,
        organization: text(row['author']),
        publishedAt: isoOrNull(row['created_at'] ?? row['created_at_i']),
      });
    }
    return out;
  };
}

/**
 * SEC EDGAR full-text search hits (`efts.sec.gov/LATEST/search-index`):
 * `{ hits: { hits: [{ _id: "<accession>:<file>", _source: { adsh, ciks, display_names, form, file_date, file_description, items, biz_locations } }] } }`.
 * A filing is a dated, named company's own statement of what it did; it is
 * company activity, never by itself a request to buy work.
 */
export function parseEdgarFullText(body: unknown): FeedItem[] {
  const outer = body && typeof body === 'object' ? (body as Record<string, unknown>)['hits'] : null;
  const hits = outer && typeof outer === 'object' ? (outer as Record<string, unknown>)['hits'] : null;
  const out: FeedItem[] = [];
  for (const row of records(hits)) {
    const id = text(row['_id']);
    const src = row['_source'] && typeof row['_source'] === 'object' ? (row['_source'] as Record<string, unknown>) : null;
    if (!id || !src) continue;
    const adsh = text(src['adsh']) ?? id.split(':')[0] ?? null;
    const file = id.includes(':') ? id.slice(id.indexOf(':') + 1) : null;
    const cik = Array.isArray(src['ciks']) ? text(src['ciks'][0]) : null;
    const form = text(src['form']) ?? text(src['root_form']);
    const names = Array.isArray(src['display_names']) ? src['display_names'].map(text).filter((n): n is string => !!n) : [];
    // "ACME CORP  (ACME)  (CIK 0000123456)" → "ACME CORP"
    const organization = names[0]?.replace(/\s*\(CIK \d+\)\s*$/i, '').replace(/\s*\([A-Z0-9.,\s-]+\)\s*$/, '').trim() || null;
    if (!adsh || !cik || !form || !organization) continue;
    const folder = `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${adsh.replace(/-/g, '')}`;
    const items = Array.isArray(src['items']) ? src['items'].map(text).filter(Boolean).join(', ') : '';
    const places = Array.isArray(src['biz_locations']) ? src['biz_locations'].map(text).filter(Boolean).join('; ') : '';
    const description = text(src['file_description']);
    out.push({
      externalId: id.slice(0, 500),
      url: file ? `${folder}/${file}` : `${folder}/`,
      title: `${form}${description ? ` (${description})` : ''}: ${organization}`.slice(0, 200),
      body: [items ? `Items ${items}.` : null, places ? `Business location: ${places}.` : null].filter(Boolean).join(' ') || null,
      organization,
      publishedAt: isoOrNull(src['file_date']),
    });
  }
  return out;
}

/**
 * The CFPB Consumer Complaint Database search API, the resource Data.gov's
 * listing of the dataset points to: an Elasticsearch-shaped
 * `{ hits: { hits: [{ _source: { complaint_id, company, product, issue, date_received, ... } }] } }`.
 * A complaint names a company and the problem its customers report; it is a
 * dated observation about a business, never a request to buy work.
 */
export function parseCfpbComplaints(body: unknown): FeedItem[] {
  const outer = body && typeof body === 'object' ? (body as Record<string, unknown>)['hits'] : null;
  const hits = outer && typeof outer === 'object' ? (outer as Record<string, unknown>)['hits'] : null;
  const out: FeedItem[] = [];
  for (const row of records(hits)) {
    const src = row['_source'] && typeof row['_source'] === 'object' ? (row['_source'] as Record<string, unknown>) : row;
    const raw = src['complaint_id'] ?? row['_id'];
    const id = typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
    const company = text(src['company']);
    const product = text(src['product']);
    const issue = text(src['issue']);
    if (!id || !company || !(product || issue)) continue;
    const parts = [
      text(src['sub_product']) ? `Product: ${product ?? ''} / ${text(src['sub_product'])}.` : product ? `Product: ${product}.` : null,
      text(src['sub_issue']) ? `Detail: ${text(src['sub_issue'])}.` : null,
      text(src['state']) ? `State: ${text(src['state'])}.` : null,
      text(src['company_response']) ? `Company response: ${text(src['company_response'])}.` : null,
    ].filter(Boolean);
    out.push({
      externalId: id,
      url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/${encodeURIComponent(id)}`,
      title: `${product ?? 'Complaint'}${issue ? `: ${issue}` : ''}`.slice(0, 200),
      body: parts.join(' ') || null,
      organization: company,
      publishedAt: isoOrNull(src['date_received']),
    });
  }
  return out;
}

/**
 * Whether an Elasticsearch-shaped body (EDGAR full-text search) states a total
 * of zero hits and carries none: `{ hits: { total: { value: 0 }, hits: [] } }`
 * (older shape: `total: 0`). Anything else, including a moved shape, is not
 * a statement of zero. Pure.
 */
export function statesZeroHits(body: unknown): boolean {
  const outer = body && typeof body === 'object' ? (body as Record<string, unknown>)['hits'] : null;
  if (!outer || typeof outer !== 'object') return false;
  const o = outer as Record<string, unknown>;
  const total = o['total'];
  const value = typeof total === 'number' ? total : total && typeof total === 'object' ? (total as Record<string, unknown>)['value'] : undefined;
  return value === 0 && Array.isArray(o['hits']) && o['hits'].length === 0;
}

/** The last `count` completed UTC days before `now`, oldest first, as YYYY-MM-DD. Pure. */
export function completedUtcDays(now: Date, count: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let back = count; back >= 1; back -= 1) out.push(new Date(today - back * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** The acquisition metadata of a JSON API read with plain conditional GETs. */
function jsonApi(
  corpus: string,
  factKinds: readonly string[],
  publisher: string,
  license: string,
  usage: string,
  extra: { maxAgeDays?: number; updateMechanism?: SourceAcquisition['access']['updateMechanism'] } = {},
): SourceAcquisition {
  return {
    corpus,
    factKinds,
    ...(extra.maxAgeDays !== undefined ? { maxAgeDays: extra.maxAgeDays } : {}),
    access: { format: 'JSON', updateMechanism: extra.updateMechanism ?? 'CONDITIONAL_FETCH', authentication: 'NONE', usage },
    provenance: { publisher, license, parserVersion: `${corpus}/1` },
  };
}

/** One side of the HN freelance thread, newest first; incremental by the comment's own creation time. */
function hnFreelance(id: string, label: string, side: HnFreelanceSide): FeedSource {
  const base = `https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=200&query=${encodeURIComponent(`"${side.toLowerCase()}"`)}`;
  return {
    id,
    label,
    url: base,
    // Algolia filters on created_at_i (epoch seconds): only comments made since the last read.
    cursorUrl: (since: string) => `${base}&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor(Date.parse(since) / 1000)}`)}`,
    intervalMs: 6 * HOUR,
    headers: { 'user-agent': 'brain-feed/1.0' },
    parse: parseHnFreelance(side),
    acquisition: jsonApi(
      'domain:permitted-marketplaces',
      side === 'SEEKING FREELANCER' ? ['buyer-request', 'listing'] : ['supplier', 'price', 'listing'],
      'Hacker News via the Algolia HN Search API',
      'public comments; Y Combinator / Algolia API terms',
      'keyless public search API; incremental by created_at_i',
      { updateMechanism: 'PAGED_API' },
    ),
  };
}

/** A GDELT news search for one kind of trigger, over the last day, US English. */
function gdelt(id: string, label: string, query: string): FeedSource {
  const base = {
    query: `${query} sourcecountry:US sourcelang:english`,
    mode: 'artlist',
    maxrecords: '75',
    format: 'json',
  };
  const params = new URLSearchParams({ ...base, timespan: '1d' });
  return {
    id,
    label,
    url: `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`,
    // GDELT takes a start time (YYYYMMDDHHMMSS, UTC): only articles after the last read are asked for.
    cursorUrl: (since: string) =>
      `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ ...base, startdatetime: since.replace(/[-:T]/g, '').slice(0, 14) }).toString()}`,
    intervalMs: 6 * HOUR,
    // GDELT asks for no more than one request every five seconds; leave room.
    spacingMs: 12_000,
    // And it is slow: a day's article list often takes longer than 20 seconds.
    timeoutMs: 60_000,
    parse: parseGdelt,
    acquisition: jsonApi(
      'gdelt',
      ['news-event', 'event-trigger', 'market-change'],
      'The GDELT Project',
      'open for research and commercial use with attribution',
      'no more than one DOC API request every five seconds',
      { maxAgeDays: 1, updateMechanism: 'PAGED_API' },
    ),
  };
}


/**
 * SEC EDGAR's keyless full-text search over 8-K current reports, read as a
 * sharded corpus: one shard is one completed filing day. A finished day's
 * filings do not change, so each day is read once, checkpointed, and never
 * asked again; an interrupted pass resumes at the first unread day, and a new
 * day is the only new shard (ACQ-21-4 step 3). The SEC's fair-access rules
 * hold on every request: a declared User-Agent naming the operator (the
 * deployment sets `SEC_EDGAR_USER_AGENT` to its own name and contact) and far
 * below ten requests a second. A refusal is a permission need health records,
 * never something read around.
 */
export const EDGAR_8K_QUERY = '"new facility" OR "expansion" OR "acquisition" OR "new headquarters"';
export const EDGAR_SHARD_DAYS = 3;
export const EDGAR_SNAPSHOT = 'efts/8-K/v1';

export function edgarFullTextUrl(day: string, from = 0): string {
  const params = new URLSearchParams({ q: EDGAR_8K_QUERY, forms: '8-K', dateRange: 'custom', startdt: day, enddt: day });
  if (from > 0) params.set('from', String(from));
  return `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
}

function edgarCurrentReports(): FeedSource {
  return {
    id: 'sec-edgar-8k',
    label: 'SEC EDGAR: 8-K current reports of company activity',
    url: edgarFullTextUrl(completedUtcDays(new Date(), 1)[0]!),
    intervalMs: 12 * HOUR,
    headers: { 'user-agent': process.env['SEC_EDGAR_USER_AGENT']?.trim() || 'Brain research-operations brain-feed/1.0' },
    // Fair access: at most ten requests a second; Brain asks far less often.
    spacingMs: 1_000,
    timeoutMs: 30_000,
    parse: parseEdgarFullText,
    // A weekend or holiday filing day has no 8-Ks; EDGAR says so with a zero total.
    emptyBody: statesZeroHits,
    shards: (now: Date) => ({ snapshot: EDGAR_SNAPSHOT, keys: completedUtcDays(now, EDGAR_SHARD_DAYS), url: (day: string) => edgarFullTextUrl(day) }),
    acquisition: {
      corpus: 'sec-edgar',
      factKinds: ['company-filing', 'company-activity'],
      maxAgeDays: EDGAR_SHARD_DAYS + 1,
      access: {
        format: 'JSON',
        updateMechanism: 'PAGED_API',
        authentication: 'NONE',
        usage: 'SEC fair access: a declared User-Agent, no more than 10 requests a second; one completed filing day per shard',
      },
      provenance: { publisher: 'U.S. Securities and Exchange Commission (EDGAR)', license: 'public filings; SEC website terms and fair-access rules', parserVersion: 'sec-edgar-efts/1' },
    },
  };
}

/**
 * The CFPB Consumer Complaint Database, reached the way the corpus says Data.gov
 * must be: the catalog's CKAN `package_show` is a listing, never the data, so
 * each pull resolves it (`resolveAccess`) to the provider's own resource and
 * reads that — the newest complaints, conditionally — never the catalog record
 * (ACQ-21-4 step 2). A bulk archive the listing names is not handed to the JSON
 * parser; Data.gov being public says nothing about pursuing government work.
 */
export const DATA_GOV_CFPB_LISTING = 'https://catalog.data.gov/api/3/action/package_show?id=consumer-complaint-database';

function dataGovCfpbComplaints(): FeedSource {
  return {
    id: 'data-gov-cfpb-complaints',
    label: 'Data.gov → CFPB consumer complaints about named companies',
    // The listing; every pull resolves it to the resource that carries the data.
    url: DATA_GOV_CFPB_LISTING,
    intervalMs: 24 * HOUR,
    timeoutMs: 60_000,
    parse: parseCfpbComplaints,
    acquisition: {
      corpus: 'data-gov',
      factKinds: ['government-dataset', 'regulatory'],
      listingUrl: DATA_GOV_CFPB_LISTING,
      resourceQuery: 'size=100&sort=created_date_desc&no_aggs=true',
      access: { format: 'JSON', updateMechanism: 'CONDITIONAL_FETCH', authentication: 'NONE', usage: 'public API of the listed provider; the listing is metadata only and is resolved on every pull' },
      provenance: { publisher: 'Consumer Financial Protection Bureau, listed on Data.gov', license: 'U.S. government work, public domain', parserVersion: 'data-gov-cfpb/1' },
    },
  };
}

const FEDERAL_REGISTER_RULES_URL =
  'https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest' +
  '&conditions%5Btype%5D%5B%5D=RULE' +
  '&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=html_url' +
  '&fields%5B%5D=publication_date&fields%5B%5D=effective_on&fields%5B%5D=agencies' +
  '&fields%5B%5D=correction_of';

export const FEED_SOURCES: readonly FeedSource[] = [
  {
    id: 'remoteok',
    label: 'RemoteOK job posts',
    url: 'https://remoteok.com/api',
    intervalMs: 6 * HOUR,
    headers: { 'user-agent': 'brain-feed/1.0' },
    parse: parseRemoteOk,
    acquisition: jsonApi('domain:permitted-marketplaces', ['listing'], 'Remote OK', 'Remote OK API terms: link back and credit Remote OK', 'public API; credit the source on every use'),
  },
  {
    // Remotive asks for no more than four requests a day.
    id: 'remotive',
    label: 'Remotive job posts',
    url: 'https://remotive.com/api/remote-jobs?limit=300',
    intervalMs: 6 * HOUR,
    parse: parseRemotive,
    acquisition: jsonApi('domain:permitted-marketplaces', ['listing'], 'Remotive', 'Remotive public API terms: link back to the job', 'no more than four requests a day'),
  },
  {
    id: 'federal-register-rules',
    label: 'Federal Register: new final rules',
    url: FEDERAL_REGISTER_RULES_URL,
    intervalMs: 6 * HOUR,
    // The Federal Register filters by publication date: only rules published since the last read.
    cursorUrl: (since: string) => `${FEDERAL_REGISTER_RULES_URL}&conditions%5Bpublication_date%5D%5Bgte%5D=${since.slice(0, 10)}`,
    parse: parseFederalRegister,
    acquisition: jsonApi(
      'domain:regulatory-records',
      ['regulatory', 'compliance-deadline'],
      'Office of the Federal Register (NARA)',
      'US government work, public domain',
      'keyless public API; filtered by publication date',
    ),
  },
  // A market with both sides on one page: buyers stating what they will pay an outside provider for,
  // and providers stating what they do, when they are free and at what rate.
  hnFreelance('hn-seeking-freelancer', 'Hacker News: buyers seeking a freelancer', 'SEEKING FREELANCER'),
  hnFreelance('hn-seeking-work', 'Hacker News: freelancers seeking work', 'SEEKING WORK'),
  // Fast cash only: events with a deadline inside weeks, where a business has
  // to get something done now and pays for speed.
  gdelt('news-new-rule-deadline', 'News: a rule or deadline businesses must meet soon', '("deadline" OR "must comply" OR "takes effect" OR "goes into effect") ("small businesses" OR "employers" OR "business owners")'),
  gdelt('news-new-location', 'News: a business opening soon', '("grand opening" OR "opening soon" OR "now open") (location OR store OR office OR clinic OR restaurant)'),
  gdelt('news-shutdown', 'News: a tool businesses use shutting down', '("shutting down" OR "will be discontinued" OR "end of support" OR "sunsetting") (platform OR software OR app OR service)'),
  gdelt('news-closures', 'News: a competitor closing, leaving customers behind', '("closing all" OR "closes its doors" OR "going out of business") (business OR company OR store)'),
  gdelt('news-event-rush', 'News: an event businesses are rushing to prepare for', '("ahead of" OR "in time for") ("holiday season" OR "black friday" OR "tax season" OR "open enrollment" OR "festival")'),
  // A large corpus read in checkpointed, resumable shards (ACQ-21-4 step 3).
  edgarCurrentReports(),
  // A catalog listing resolved to the provider's real resource (ACQ-21-4 step 2).
  dataGovCfpbComplaints(),
];
