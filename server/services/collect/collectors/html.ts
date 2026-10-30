/**
 * HTML list pages and page-change watches, with no DOM and no script execution.
 * A list page is read by repeating-block regexes the source row supplies; a
 * watch hashes the readable text of the page (or one region of it).
 */
import { canonicalUrl, normalizeDate, plainText, sha256 } from '../normalize/index.ts';
import { buildRecord } from './record.ts';
import type { CollectedRecord } from './types.ts';

export interface HtmlListMapping {
  /** Regex source matching one repeating block; flags are 'gis'. */
  item: string;
  /** Regexes applied inside a block; group 1 is the value. */
  url: string;
  title: string;
  body?: string;
  organization?: string;
  publishedAt?: string;
  location?: string;
  amount?: string;
}

function grab(block: string, source: string | undefined): string | undefined {
  if (!source) return undefined;
  try {
    const m = new RegExp(source, 'is').exec(block);
    return m ? (m[1] ?? m[0]) : undefined;
  } catch {
    return undefined;
  }
}

export function parseHtmlList(body: string, mapping: HtmlListMapping, baseUrl?: string): CollectedRecord[] {
  let items: IterableIterator<RegExpMatchArray>;
  try {
    items = body.matchAll(new RegExp(mapping.item, 'gis'));
  } catch {
    return [];
  }
  const out: CollectedRecord[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const m of items) {
    if (++n > 5_000) break;
    const block = m[0];
    const url = grab(block, mapping.url);
    const r = buildRecord({
      url,
      title: grab(block, mapping.title),
      body: grab(block, mapping.body),
      organization: grab(block, mapping.organization),
      publishedAt: normalizeDate(plainText(grab(block, mapping.publishedAt) ?? '') ?? ''),
      location: grab(block, mapping.location),
      amount: plainText(grab(block, mapping.amount) ?? '') ?? undefined,
    }, baseUrl);
    if (r && !seen.has(r.url)) { seen.add(r.url); out.push(r); }
  }
  return out;
}

export interface WatchReading {
  url: string;
  title: string | null;
  /** Hash of the readable text; equal hashes mean the page did not change. */
  textHash: string;
  excerpt: string | null;
  length: number;
}

/** The readable state of one page, optionally narrowed to a region by a regex (group 1). */
export function readWatch(body: string, url: string, region?: string): WatchReading | null {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;
  let scope = body;
  if (region) {
    try {
      const m = new RegExp(region, 'is').exec(body);
      if (!m) return null;
      scope = m[1] ?? m[0];
    } catch {
      return null;
    }
  }
  const text = plainText(scope, 200_000);
  if (!text) return null;
  const title = plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1], 300);
  return { url: canonical, title, textHash: sha256(text), excerpt: text.slice(0, 500), length: text.length };
}

export type WatchChange = 'FIRST_READING' | 'UNCHANGED' | 'CHANGED';

export function compareWatch(prior: { textHash: string } | null, current: WatchReading): WatchChange {
  return !prior ? 'FIRST_READING' : prior.textHash === current.textHash ? 'UNCHANGED' : 'CHANGED';
}

/** A watch result expressed as one record, so downstream code treats it like any other lead. */
export function watchRecord(reading: WatchReading, label: string): CollectedRecord | null {
  return buildRecord({ externalId: reading.url, url: reading.url, title: reading.title ?? label, body: reading.excerpt, organization: null, publishedAt: null });
}
