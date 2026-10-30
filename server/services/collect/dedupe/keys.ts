/**
 * Identity for a collected record: URL canonicalisation, a normalised
 * organisation + title + date key, and a content hash. Pure; nothing here
 * reads or writes a row. Strict on purpose — two different companies must
 * never be merged, so a missing part makes a key null rather than a guess.
 */
import { createHash } from 'node:crypto';
import { employerKey, titleKey } from '../../feeds/detectors.ts';

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|source$|igshid$)/i;

/** A URL reduced to what names the page; null when it is not an http(s) URL. */
export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  url.pathname = path;
  return `https://${url.host}${url.pathname}${url.search}`;
}

export function contentHash(...parts: (string | null | undefined)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${(part ?? '').replace(/\s+/g, ' ').trim()}\u0000`);
  return hash.digest('hex');
}

export interface CollectedRecord {
  source: string;
  externalId: string;
  url: string | null;
  title: string;
  organization: string | null;
  publishedAt: string | null;
  body: string | null;
}

/** organisation + title + day, or null when the organisation or title is unreadable. */
export function recordKey(record: Pick<CollectedRecord, 'organization' | 'title' | 'publishedAt'>): string | null {
  const org = employerKey(record.organization);
  const title = titleKey(record.title);
  if (!org || !title) return null;
  const at = record.publishedAt ? Date.parse(record.publishedAt) : NaN;
  const day = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : 'undated';
  return `${org}|${title}|${day}`;
}

export const recordContentHash = (r: CollectedRecord): string => contentHash(r.title, r.organization, r.publishedAt, r.body);
