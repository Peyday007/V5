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
  parse(body: unknown): FeedItem[];
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

/** A GDELT news search for one kind of trigger, over the last day, US English. */
function gdelt(id: string, label: string, query: string): FeedSource {
  const params = new URLSearchParams({
    query: `${query} sourcecountry:US sourcelang:english`,
    mode: 'artlist',
    maxrecords: '75',
    format: 'json',
    timespan: '1d',
  });
  return {
    id,
    label,
    url: `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`,
    intervalMs: 6 * HOUR,
    // GDELT asks for no more than one request every five seconds; leave room.
    spacingMs: 12_000,
    // And it is slow: a day's article list often takes longer than 20 seconds.
    timeoutMs: 60_000,
    parse: parseGdelt,
  };
}


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
    url:
      'https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest' +
      '&conditions%5Btype%5D%5B%5D=RULE' +
      '&fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=html_url' +
      '&fields%5B%5D=publication_date&fields%5B%5D=effective_on&fields%5B%5D=agencies',
    intervalMs: 6 * HOUR,
    parse: parseFederalRegister,
  },
  // Fast cash only: events with a deadline inside weeks, where a business has
  // to get something done now and pays for speed.
  gdelt('news-new-rule-deadline', 'News: a rule or deadline businesses must meet soon', '("deadline" OR "must comply" OR "takes effect" OR "goes into effect") ("small businesses" OR "employers" OR "business owners")'),
  gdelt('news-new-location', 'News: a business opening soon', '("grand opening" OR "opening soon" OR "now open") (location OR store OR office OR clinic OR restaurant)'),
  gdelt('news-shutdown', 'News: a tool businesses use shutting down', '("shutting down" OR "will be discontinued" OR "end of support" OR "sunsetting") (platform OR software OR app OR service)'),
  gdelt('news-closures', 'News: a competitor closing, leaving customers behind', '("closing all" OR "closes its doors" OR "going out of business") (business OR company OR store)'),
  gdelt('news-event-rush', 'News: an event businesses are rushing to prepare for', '("ahead of" OR "in time for") ("holiday season" OR "black friday" OR "tax season" OR "open enrollment" OR "festival")'),
];

// ---------------------------------------------------------------------------
// The registry's side of these sources.
//
// A source is a row (`collect_sources`); the three bulk feeds, the GDELT
// searches and the OSM site sweep are its first rows, seeded from the
// definitions above so the behaviour is the one the code always had. What a row
// cannot hold - a parser - is named by `parserId` and looked up here, so adding
// a source of an existing kind is an insert, and only a new *parser* is code.
// ---------------------------------------------------------------------------

/** How a parser id is run. A row's own interval and rate always win. */
export interface ParserProfile {
  id: string;
  parse(body: unknown): FeedItem[];
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** A row naming this parser is read by the shared collector for its kind, not by a bespoke parser. */
export const GENERIC_PARSER = 'collector';

export const PARSERS: Readonly<Record<string, ParserProfile>> = Object.freeze({
  remoteok: { id: 'remoteok', parse: parseRemoteOk, headers: { 'user-agent': 'brain-feed/1.0' } },
  remotive: { id: 'remotive', parse: parseRemotive },
  'federal-register': { id: 'federal-register', parse: parseFederalRegister },
  // GDELT's day-long article list is slow: it gets longer than the default.
  'gdelt-artlist': { id: 'gdelt-artlist', parse: parseGdelt, timeoutMs: 60_000 },
});

const PARSER_BY_SOURCE: Readonly<Record<string, string>> = {
  remoteok: 'remoteok',
  remotive: 'remotive',
  'federal-register-rules': 'federal-register',
};

/** The parser id a hardcoded definition runs under. */
export function parserIdFor(source: Pick<FeedSource, 'id'>): string {
  return PARSER_BY_SOURCE[source.id] ?? 'gdelt-artlist';
}

/** The OSM broken-site sweep's row. Its query and its checks stay in sites.ts. */
export const SITE_SWEEP_SLUG = 'osm-broken-sites';

export interface SeedRow {
  slug: string;
  label: string;
  kind: 'JSON_API' | 'OVERPASS';
  urlTemplate: string;
  parserId: string;
  intervalMs: number;
  hostRatePerMin: number | null;
}

/** Every hardcoded source as the row that replaces it. Pure. */
export function seedRows(): SeedRow[] {
  const rows: SeedRow[] = FEED_SOURCES.map((source) => ({
    slug: source.id,
    label: source.label,
    kind: 'JSON_API' as const,
    urlTemplate: source.url,
    parserId: parserIdFor(source),
    intervalMs: source.intervalMs,
    // A publisher's "one request every N seconds" is a rate per minute.
    hostRatePerMin: source.spacingMs ? Math.max(1, Math.round(60_000 / source.spacingMs)) : null,
  }));
  rows.push({
    slug: SITE_SWEEP_SLUG,
    label: 'OpenStreetMap: businesses with a website, by metro',
    kind: 'OVERPASS',
    urlTemplate: 'https://overpass-api.de/api/interpreter?data={query}',
    parserId: 'osm-broken-sites',
    intervalMs: 7 * 86_400_000,
    hostRatePerMin: null,
  });
  return rows;
}

/** The runnable form of a hardcoded definition, with the profile's headers and timeout. */
export function profileFor(parserId: string): ParserProfile | null {
  return PARSERS[parserId] ?? null;
}
