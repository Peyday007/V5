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
    out.push({
      externalId: id,
      url,
      title,
      body: [abstract, effective ? `Effective ${effective}.` : null].filter(Boolean).join(' ') || null,
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
  };
}


const FEDERAL_REGISTER_RULES_URL =
  'https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest' +
  '&conditions%5Btype%5D%5B%5D=RULE' +
  '&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=html_url' +
  '&fields%5B%5D=publication_date&fields%5B%5D=effective_on&fields%5B%5D=agencies';

export const FEED_SOURCES: readonly FeedSource[] = [
  {
    id: 'remoteok',
    label: 'RemoteOK job posts',
    url: 'https://remoteok.com/api',
    intervalMs: 6 * HOUR,
    headers: { 'user-agent': 'brain-feed/1.0' },
    parse: parseRemoteOk,
  },
  {
    // Remotive asks for no more than four requests a day.
    id: 'remotive',
    label: 'Remotive job posts',
    url: 'https://remotive.com/api/remote-jobs?limit=300',
    intervalMs: 6 * HOUR,
    parse: parseRemotive,
  },
  {
    id: 'federal-register-rules',
    label: 'Federal Register: new final rules',
    url: FEDERAL_REGISTER_RULES_URL,
    intervalMs: 6 * HOUR,
    // The Federal Register filters by publication date: only rules published since the last read.
    cursorUrl: (since: string) => `${FEDERAL_REGISTER_RULES_URL}&conditions%5Bpublication_date%5D%5Bgte%5D=${since.slice(0, 10)}`,
    parse: parseFederalRegister,
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
];
