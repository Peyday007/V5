/**
 * Collectors by kind. Each takes the response the caller fetched plus the
 * validators from the last pull and returns a CollectResult; none touches the
 * network, a database or a clock, and none throws.
 */
import { parseCsv, type CsvMapping } from './csv.ts';
import { finish, gate, type RawResponse, type Validators } from './fetch.ts';
import { parseFeed } from './feed.ts';
import { compareWatch, parseHtmlList, readWatch, watchRecord, type HtmlListMapping } from './html.ts';
import { parseJson, type JsonMapping } from './json.ts';
import { parseOverpassRecords } from './overpass.ts';
import { parseSitemap } from './sitemap.ts';
import { EMPTY_RESULT, type CollectResult } from './types.ts';
import { sha256 } from '../normalize/index.ts';

export * from './types.ts';
export * from './fetch.ts';
export { parseFeed } from './feed.ts';
export { parseJson, type JsonMapping } from './json.ts';
export { parseCsv, parseCsvRows, type CsvMapping } from './csv.ts';
export { parseHtmlList, readWatch, compareWatch, watchRecord, type HtmlListMapping, type WatchChange, type WatchReading } from './html.ts';
export { parseOverpassRecords } from './overpass.ts';
export { parseSitemap } from './sitemap.ts';

export type CollectorSpec =
  | { kind: 'RSS_ATOM' }
  | { kind: 'JSON_API'; mapping: JsonMapping; page?: number }
  | { kind: 'CSV'; mapping: CsvMapping }
  | { kind: 'SITEMAP' }
  | { kind: 'HTML_LIST'; mapping: HtmlListMapping }
  | { kind: 'OVERPASS' }
  | { kind: 'PAGE_WATCH'; region?: string; label?: string; priorTextHash?: string | null };

export function collect(spec: CollectorSpec, response: RawResponse, url: string, prior: Validators = {}): CollectResult {
  switch (spec.kind) {
    case 'RSS_ATOM':
      return finish(response, prior, () => ({ records: parseFeed(response.body, url), next: null }), !/<(rss|feed|rdf:rdf)\b/i.test(response.body));
    case 'JSON_API': {
      let json: unknown;
      const early = gate(response, prior);
      if (early) return early;
      try { json = JSON.parse(response.body); } catch { return { ...EMPTY_RESULT, outcome: 'UNPARSEABLE', bodyHash: sha256(response.body), note: 'body is not JSON' }; }
      return finish(response, {}, () => parseJson(json, spec.mapping, url, spec.page ?? 1));
    }
    case 'CSV':
      return finish(response, prior, () => ({ records: parseCsv(response.body, spec.mapping, url), next: null }), true);
    case 'SITEMAP':
      return finish(response, prior, () => {
        const { records, sitemaps } = parseSitemap(response.body);
        return { records, next: sitemaps[0] ?? null };
      }, !/<(urlset|sitemapindex)\b/i.test(response.body));
    case 'HTML_LIST':
      return finish(response, prior, () => ({ records: parseHtmlList(response.body, spec.mapping, url), next: null }), true);
    case 'OVERPASS': {
      const early = gate(response, prior);
      if (early) return early;
      try { return finish(response, {}, () => ({ records: parseOverpassRecords(JSON.parse(response.body)), next: null })); } catch { return { ...EMPTY_RESULT, outcome: 'UNPARSEABLE', bodyHash: sha256(response.body), note: 'body is not JSON' }; }
    }
    case 'PAGE_WATCH': {
      const early = gate(response, {});
      if (early) return early;
      const reading = readWatch(response.body, url, spec.region);
      const bodyHash = sha256(response.body);
      if (!reading) return { ...EMPTY_RESULT, outcome: 'UNPARSEABLE', bodyHash, note: spec.region ? 'watched region not found' : 'page has no readable text' };
      const change = compareWatch(spec.priorTextHash ? { textHash: spec.priorTextHash } : null, reading);
      if (change === 'UNCHANGED') return { ...EMPTY_RESULT, outcome: 'UNCHANGED', bodyHash, note: reading.textHash };
      const record = watchRecord(reading, spec.label ?? 'Watched page');
      return { ...EMPTY_RESULT, outcome: record ? 'RECORDS' : 'NO_MATCHING_RECORDS', records: record ? [record] : [], bodyHash, note: `${change}:${reading.textHash}` };
    }
  }
}
