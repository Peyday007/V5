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
  /** How the response body is read: JSON by default, raw text for feeds and pages. */
  format?: 'json' | 'text';
  /** The registry row this source was built from, when it was. */
  row?: SourceRow;
}

/** The kinds of source a registry row may name. */
export type SourceKind = 'JSON_API' | 'RSS_ATOM' | 'CSV' | 'PAGE_WATCH' | 'OSM_OVERPASS';

/** What was established about a publisher's robots/terms. Recorded, never assumed. */
export type RobotsStatus = 'ALLOWED_PUBLIC_API' | 'ALLOWED_PUBLIC_FEED' | 'ALLOWED_PUBLIC_PAGE' | 'UNCHECKED';

/**
 * A source as data. Adding a source of an existing kind is a new row here, with
 * no new code: the kind picks the generic collector and `parserId` (JSON) or
 * `fields` (CSV) says how to read it.
 */
export interface SourceRow {
  id: string;
  label: string;
  kind: SourceKind;
  /** URL template; `{name}` is filled from `params`. */
  url: string;
  params?: Record<string, string>;
  intervalHours: number;
  spacingMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** JSON_API: which named parser reads the body. */
  parserId?: string;
  /** CSV: column names to item fields. */
  fields?: Partial<Record<'id' | 'title' | 'url' | 'organization' | 'publishedAt' | 'body', string>>;
  robots: { status: RobotsStatus; checkedAt: string; note: string };
  /** The project that owns the row; null means shared. Private rows are visible to their project only. */
  ownerProjectId: string | null;
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
 * A body whose top-level shape is not the one a parser reads is not "no
 * records": it is UNPARSEABLE, and saying so is how a changed publisher format
 * shows up as a failure with a cause instead of as a quiet empty pull.
 */
export class UnparseableBody extends Error {
  constructor(what: string) {
    super(`UNPARSEABLE: ${what}`);
    this.name = 'UnparseableBody';
  }
}

const field = (obj: unknown, ...path: string[]): unknown => {
  let at: unknown = obj;
  for (const key of path) {
    if (!at || typeof at !== 'object' || Array.isArray(at)) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
};

/**
 * UK Find a Tender's public OCDS release packages (`{ releases: [...] }`): a
 * procurement notice per release, keyless. A release's `id` is the notice id
 * the public notice page is addressed by.
 */
export function parseFindATender(body: unknown): FeedItem[] {
  const releases = field(body, 'releases');
  if (!Array.isArray(releases)) throw new UnparseableBody('no releases array in an OCDS release package');
  const out: FeedItem[] = [];
  for (const row of records(releases)) {
    const id = text(row['id']);
    const title = plain(field(row, 'tender', 'title'));
    if (!id || !title) continue;
    const amount = field(row, 'tender', 'value', 'amount');
    const currency = text(field(row, 'tender', 'value', 'currency'));
    const deadline = text(field(row, 'tender', 'tenderPeriod', 'endDate'));
    const description = plain(field(row, 'tender', 'description'));
    out.push({
      externalId: (text(row['ocid']) ?? id).slice(0, 500),
      url: `https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(id)}`,
      title,
      body: [
        description,
        typeof amount === 'number' && Number.isFinite(amount) ? `Value ${amount}${currency ? ` ${currency}` : ''}.` : null,
        deadline ? `Tenders due ${deadline}.` : null,
      ].filter(Boolean).join(' ') || null,
      organization: text(field(row, 'buyer', 'name')),
      publishedAt: isoOrNull(row['date']),
    });
  }
  return out;
}

/**
 * GLEIF's public LEI register (`{ data: [...] }`): newly registered legal
 * entities, keyless and published as open data. The record's own API address
 * is its URL, because GLEIF's search page addresses a record after `#`, and a
 * fragment is exactly what URL canonicalisation drops.
 */
export function parseGleif(body: unknown): FeedItem[] {
  const data = field(body, 'data');
  if (!Array.isArray(data)) throw new UnparseableBody('no data array in a GLEIF response');
  const out: FeedItem[] = [];
  for (const row of records(data)) {
    const lei = text(field(row, 'attributes', 'lei')) ?? text(row['id']);
    const name = text(field(row, 'attributes', 'entity', 'legalName', 'name'));
    if (!lei || !name) continue;
    const city = text(field(row, 'attributes', 'entity', 'legalAddress', 'city'));
    const country = text(field(row, 'attributes', 'entity', 'legalAddress', 'country'));
    const status = text(field(row, 'attributes', 'entity', 'status'));
    const category = text(field(row, 'attributes', 'entity', 'category'));
    out.push({
      externalId: lei,
      url: `https://api.gleif.org/api/v1/lei-records/${encodeURIComponent(lei)}`,
      title: `New legal entity registered: ${name}`,
      body: [
        [city, country].filter(Boolean).join(', ') || null,
        category ? `Category ${category}.` : null,
        status ? `Entity status ${status}.` : null,
      ].filter(Boolean).join(' ') || null,
      organization: name,
      publishedAt: isoOrNull(field(row, 'attributes', 'registration', 'initialRegistrationDate')),
    });
  }
  return out;
}

/**
 * An OpenStreetMap category read through the public Overpass API
 * (`{ elements: [...] }`): one item per named element, addressed by its OSM
 * page. Mapped features carry no publication date, so none is invented.
 */
export function parseOverpassElements(body: unknown): FeedItem[] {
  const elements = field(body, 'elements');
  if (!Array.isArray(elements)) throw new UnparseableBody('no elements array in an Overpass response');
  const out: FeedItem[] = [];
  for (const row of records(elements)) {
    const type = text(row['type']);
    const id = row['id'];
    const tags = field(row, 'tags');
    const name = text(field(tags, 'name'));
    if (!type || !['node', 'way', 'relation'].includes(type) || (typeof id !== 'number' && typeof id !== 'string') || !name) continue;
    const place = [text(field(tags, 'addr:street')), text(field(tags, 'addr:city'))].filter(Boolean).join(', ');
    out.push({
      externalId: `${type}/${String(id)}`,
      url: `https://www.openstreetmap.org/${type}/${String(id)}`,
      title: name,
      body: [
        place || null,
        text(field(tags, 'product')) ? `Product: ${text(field(tags, 'product'))}.` : null,
        text(field(tags, 'operator')) ? `Operator: ${text(field(tags, 'operator'))}.` : null,
        text(field(tags, 'website')) ? `Website: ${text(field(tags, 'website'))}.` : null,
      ].filter(Boolean).join(' ') || null,
      organization: text(field(tags, 'operator')) ?? name,
      publishedAt: null,
    });
  }
  return out;
}

const NAMED_PARSERS: Record<string, (body: unknown) => FeedItem[]> = {
  remoteok: parseRemoteOk,
  remotive: parseRemotive,
  'federal-register': parseFederalRegister,
  gdelt: parseGdelt,
  'find-a-tender': parseFindATender,
  gleif: parseGleif,
  'overpass-elements': parseOverpassElements,
};

const decodeEntities = (v: string): string =>
  v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? text(decodeEntities(m[1]!)) : null;
}

/** RSS 2.0 and Atom, in one pure parser that never throws. */
export function parseRssAtom(body: unknown): FeedItem[] {
  if (typeof body !== 'string') return [];
  const out: FeedItem[] = [];
  const blocks = body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = plain(tag(block, 'title'));
    const atomLink = /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? null;
    const link = tag(block, 'link') ?? (atomLink ? decodeEntities(atomLink) : null);
    if (!title || !isHttpUrl(link)) continue;
    out.push({
      externalId: (tag(block, 'guid') ?? tag(block, 'id') ?? link).slice(0, 500),
      url: link,
      title,
      body: plain(tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content')),
      organization: plain(tag(block, 'author') ?? tag(block, 'dc:creator')),
      publishedAt: isoOrNull(tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated')),
    });
  }
  return out;
}

/** Split CSV text into rows, honouring quotes. */
export function parseCsvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** A dataset download: the header row names the columns the registry row maps. */
export function parseCsv(body: unknown, fields: NonNullable<SourceRow['fields']>): FeedItem[] {
  if (typeof body !== 'string') return [];
  const [rawHeader, ...rest] = parseCsvRows(body.replace(/^\uFEFF/, ''));
  if (!rawHeader) return [];
  const header = rawHeader.map((h) => h.trim());
  // A mapped column the header does not have is a changed format, not an empty dataset.
  for (const name of [fields.title, fields.url]) {
    if (name && !header.includes(name)) throw new UnparseableBody(`CSV header has no column "${name}"`);
  }
  const col = (name: string | undefined) => (name ? header.indexOf(name) : -1);
  const at = (r: string[], name: string | undefined) => { const i = col(name); return i >= 0 ? text(r[i]) : null; };
  const out: FeedItem[] = [];
  for (const r of rest) {
    const title = at(r, fields.title);
    const url = at(r, fields.url);
    if (!title || !isHttpUrl(url)) continue;
    out.push({
      externalId: (at(r, fields.id) ?? url).slice(0, 500),
      url,
      title,
      body: plain(at(r, fields.body)),
      organization: at(r, fields.organization),
      publishedAt: isoOrNull(at(r, fields.publishedAt)),
    });
  }
  return out;
}

/** A short stable hash of text (FNV-1a, 64 bit as two 32-bit halves). */
export function contentHash(value: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    a = Math.imul(a ^ value.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** A page-change watch: nothing new while the page's text is unchanged; one item when it changes. */
export function pageWatchParser(id: string, label: string, url: string): (body: unknown) => FeedItem[] {
  return (body) => {
    if (typeof body !== 'string') return [];
    const words = (plain(body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')) ?? '');
    const full = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!full) return [];
    const hash = contentHash(full);
    return [{ externalId: `watch:${id}:${hash}`, url, title: `Page changed: ${label}`, body: words || null, organization: null, publishedAt: null }];
  };
}

/** Canonical form of a URL for duplicate detection: no fragment, tracking params, trailing slash or case in the host. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw.trim();
  }
}

/** Items repeated within or across sources (same canonical URL, or same organisation+title+day) collapse to the first. */
export function dedupeItems(items: readonly FeedItem[]): { kept: FeedItem[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: FeedItem[] = [];
  for (const item of items) {
    const keys = [
      `u:${canonicalUrl(item.url)}`,
      `t:${(item.organization ?? '').toLowerCase()}|${item.title.toLowerCase().replace(/\W+/g, ' ').trim()}|${(item.publishedAt ?? '').slice(0, 10)}`,
    ];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    kept.push(item);
  }
  return { kept, duplicates: items.length - kept.length };
}

/** Fill `{name}` in a URL template from the row's params. */
export function expandUrl(row: Pick<SourceRow, 'url' | 'params'>): string {
  return row.url.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(row.params?.[k] ?? ''));
}

/** Build the runnable source for a row. Throws only for a row that names no way to read it. */
export function sourceFromRow(row: SourceRow): FeedSource {
  const url = expandUrl(row);
  let parse: (body: unknown) => FeedItem[];
  let format: 'json' | 'text' = 'text';
  switch (row.kind) {
    case 'JSON_API': {
      const named = row.parserId ? NAMED_PARSERS[row.parserId] : undefined;
      if (!named) throw new Error(`source ${row.id}: unknown parserId ${row.parserId ?? '(none)'}`);
      parse = named;
      format = 'json';
      break;
    }
    case 'RSS_ATOM': parse = parseRssAtom; break;
    case 'CSV': {
      const fields = row.fields;
      if (!fields?.title || !fields.url) throw new Error(`source ${row.id}: a CSV row maps title and url`);
      parse = (b) => parseCsv(b, fields);
      break;
    }
    case 'PAGE_WATCH': parse = pageWatchParser(row.id, row.label, url); break;
    case 'OSM_OVERPASS': {
      // A category read (a named parser over one query) is pulled like any feed; the broken-site sweep is run by sites.ts.
      const named = row.parserId ? NAMED_PARSERS[row.parserId] : undefined;
      if (!named) throw new Error(`source ${row.id}: an OSM sweep is run by sites.ts, not pulled as a feed`);
      parse = named;
      format = 'json';
      break;
    }
  }
  return { id: row.id, label: row.label, url, intervalMs: row.intervalHours * HOUR, headers: row.headers, spacingMs: row.spacingMs, timeoutMs: row.timeoutMs, parse, format, row };
}

const R = (status: RobotsStatus, note: string) => ({ status, checkedAt: '2026-10-30', note });
const FR_FIELDS = 'fields%5B%5D=document_number&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=html_url&fields%5B%5D=publication_date&fields%5B%5D=effective_on&fields%5B%5D=agencies';

function gdeltRow(id: string, label: string, query: string): SourceRow {
  const params = new URLSearchParams({ query: `${query} sourcecountry:US sourcelang:english`, mode: 'artlist', maxrecords: '75', format: 'json', timespan: '1d' });
  return { id, label, kind: 'JSON_API', url: `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`, parserId: 'gdelt', intervalHours: 6, spacingMs: 12_000, timeoutMs: 60_000, robots: R('ALLOWED_PUBLIC_API', 'GDELT public API; asks one request per five seconds'), ownerProjectId: null };
}

/** Every source Brain pulls, as data. The first three are the original hardcoded sources, unchanged. */
export const SOURCE_ROWS: readonly SourceRow[] = [
  { id: 'remoteok', label: 'RemoteOK job posts', kind: 'JSON_API', url: 'https://remoteok.com/api', parserId: 'remoteok', intervalHours: 6, headers: { 'user-agent': 'brain-feed/1.0' }, robots: R('ALLOWED_PUBLIC_API', 'public API; legal notice in first entry'), ownerProjectId: null },
  { id: 'remotive', label: 'Remotive job posts', kind: 'JSON_API', url: 'https://remotive.com/api/remote-jobs?limit=300', parserId: 'remotive', intervalHours: 6, robots: R('ALLOWED_PUBLIC_API', 'asks for no more than four requests a day'), ownerProjectId: null },
  { id: 'federal-register-rules', label: 'Federal Register: new final rules', kind: 'JSON_API', url: `https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest&conditions%5Btype%5D%5B%5D={type}&${FR_FIELDS}`, params: { type: 'RULE' }, parserId: 'federal-register', intervalHours: 6, robots: R('ALLOWED_PUBLIC_API', 'US government public API, keyless'), ownerProjectId: null },
  gdeltRow('news-new-rule-deadline', 'News: a rule or deadline businesses must meet soon', '("deadline" OR "must comply" OR "takes effect" OR "goes into effect") ("small businesses" OR "employers" OR "business owners")'),
  gdeltRow('news-new-location', 'News: a business opening soon', '("grand opening" OR "opening soon" OR "now open") (location OR store OR office OR clinic OR restaurant)'),
  gdeltRow('news-shutdown', 'News: a tool businesses use shutting down', '("shutting down" OR "will be discontinued" OR "end of support" OR "sunsetting") (platform OR software OR app OR service)'),
  gdeltRow('news-closures', 'News: a competitor closing, leaving customers behind', '("closing all" OR "closes its doors" OR "going out of business") (business OR company OR store)'),
  gdeltRow('news-event-rush', 'News: an event businesses are rushing to prepare for', '("ahead of" OR "in time for") ("holiday season" OR "black friday" OR "tax season" OR "open enrollment" OR "festival")'),
  // New sources, added as data.
  { id: 'federal-register-proposed-rules', label: 'Federal Register: proposed rules open for comment', kind: 'JSON_API', url: `https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest&conditions%5Btype%5D%5B%5D={type}&${FR_FIELDS}`, params: { type: 'PRORULE' }, parserId: 'federal-register', intervalHours: 12, robots: R('ALLOWED_PUBLIC_API', 'US government public API, keyless'), ownerProjectId: null },
  { id: 'federal-register-notices', label: 'Federal Register: new agency notices', kind: 'JSON_API', url: `https://www.federalregister.gov/api/v1/documents.json?per_page=100&order=newest&conditions%5Btype%5D%5B%5D={type}&${FR_FIELDS}`, params: { type: 'NOTICE' }, parserId: 'federal-register', intervalHours: 12, robots: R('ALLOWED_PUBLIC_API', 'US government public API, keyless'), ownerProjectId: null },
  { id: 'fda-recalls-rss', label: 'FDA recalls and safety alerts', kind: 'RSS_ATOM', url: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml', intervalHours: 6, robots: R('ALLOWED_PUBLIC_FEED', 'US government public RSS feed'), ownerProjectId: null },
  { id: 'cisa-advisories-rss', label: 'CISA cybersecurity advisories', kind: 'RSS_ATOM', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml', intervalHours: 6, robots: R('ALLOWED_PUBLIC_FEED', 'US government public RSS feed'), ownerProjectId: null },
  { id: 'watch-dol-state-minimum-wage', label: 'US DOL: state minimum wage laws page', kind: 'PAGE_WATCH', url: 'https://www.dol.gov/agencies/whd/minimum-wage/state', intervalHours: 24, robots: R('ALLOWED_PUBLIC_PAGE', 'public US government page; read once a day'), ownerProjectId: null },
  // Procurement, a dataset download, a business register and an OSM category, as data.
  { id: 'canadabuys-new-tenders-csv', label: 'CanadaBuys: new federal tender notices (open data CSV)', kind: 'CSV', url: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv', intervalHours: 24, fields: { id: 'referenceNumber-numeroReference', title: 'title-titre-eng', url: 'noticeURL-URLavis-eng', organization: 'contractingEntityName-nomEntitContractante-eng', publishedAt: 'publicationDate-datePublication', body: 'tenderDescription-descriptionAppelOffres-eng' }, timeoutMs: 60_000, robots: R('ALLOWED_PUBLIC_FEED', 'Government of Canada open-data download under the Open Government Licence, keyless'), ownerProjectId: null },
  { id: 'find-a-tender-ocds', label: 'UK Find a Tender: new tender notices (OCDS API)', kind: 'JSON_API', url: 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?stages={stage}&limit=100', params: { stage: 'tender' }, parserId: 'find-a-tender', intervalHours: 12, timeoutMs: 60_000, robots: R('ALLOWED_PUBLIC_API', 'UK government public OCDS API, keyless'), ownerProjectId: null },
  { id: 'gleif-new-lei-registrations', label: 'GLEIF: newly registered legal entities (LEI register)', kind: 'JSON_API', url: 'https://api.gleif.org/api/v1/lei-records?sort=-registration.initialRegistrationDate&page%5Bsize%5D=100', parserId: 'gleif', intervalHours: 24, headers: { accept: 'application/vnd.api+json' }, robots: R('ALLOWED_PUBLIC_API', 'GLEIF public API; LEI data published as open data, keyless'), ownerProjectId: null },
  { id: 'osm-houston-factories', label: 'OpenStreetMap: named factories and plants, Houston metro', kind: 'OSM_OVERPASS', url: 'https://overpass-api.de/api/interpreter?data={query}', params: { query: '[out:json][timeout:90];nwr["man_made"="works"]["name"](29.58,-95.65,29.96,-95.2);out tags 400;' }, parserId: 'overpass-elements', intervalHours: 7 * 24, timeoutMs: 120_000, robots: R('ALLOWED_PUBLIC_API', 'Overpass public API; one category query a week'), ownerProjectId: null },
];

/** The rows a project may see: shared ones, and its own. */
export function rowsVisibleTo(projectId: string | null, rows: readonly SourceRow[] = SOURCE_ROWS): SourceRow[] {
  return rows.filter((r) => r.ownerProjectId === null || r.ownerProjectId === projectId);
}

export const FEED_SOURCES: readonly FeedSource[] = SOURCE_ROWS.map(sourceFromRow);
