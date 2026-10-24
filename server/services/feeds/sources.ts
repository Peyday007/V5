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
 * small-business owner describing a problem. It is a raw lead, never evidence.
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

/** Reddit's listing JSON: `{ data: { children: [{ data }] } }`. */
export function parseReddit(body: unknown): FeedItem[] {
  const data = body && typeof body === 'object' ? (body as Record<string, unknown>)['data'] : null;
  const children = data && typeof data === 'object' ? (data as Record<string, unknown>)['children'] : null;
  const out: FeedItem[] = [];
  for (const child of records(children)) {
    const row = child['data'];
    if (!row || typeof row !== 'object') continue;
    const post = row as Record<string, unknown>;
    const id = text(post['id']);
    const title = text(post['title']);
    const permalink = text(post['permalink']);
    if (!id || !title || !permalink) continue;
    if (post['stickied'] === true || post['over_18'] === true) continue;
    out.push({
      externalId: id,
      url: `https://www.reddit.com${permalink}`,
      title,
      body: plain(post['selftext']),
      organization: text(post['subreddit_name_prefixed']),
      publishedAt: isoOrNull(post['created_utc']),
    });
  }
  return out;
}

const REDDIT_HEADERS = { 'user-agent': 'brain-feed/1.0 (reads public listings)' };

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
  {
    id: 'reddit-smallbusiness',
    label: 'r/smallbusiness: owners describing problems',
    url: 'https://www.reddit.com/r/smallbusiness/new.json?limit=100',
    intervalMs: 2 * HOUR,
    headers: REDDIT_HEADERS,
    parse: parseReddit,
  },
  {
    id: 'reddit-entrepreneur',
    label: 'r/Entrepreneur: owners describing problems',
    url: 'https://www.reddit.com/r/Entrepreneur/new.json?limit=100',
    intervalMs: 2 * HOUR,
    headers: REDDIT_HEADERS,
    parse: parseReddit,
  },
];
