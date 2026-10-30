import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalUrl, dedupeKey, normalizeDate, parseAmount } from '../server/services/collect/normalize/index.ts';
import { collect, conditionalHeaders, gate, parseCsvRows, retryDelayMs } from '../server/services/collect/collectors/index.ts';
import type { JsonMapping } from '../server/services/collect/collectors/index.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/collect-collectors/${n}`, import.meta.url), 'utf8');
const ok = (body: string, extra: object = {}) => ({ status: 200, body, ...extra });

describe('normalisation', () => {
  it('reads dates to ISO UTC and refuses nonsense', () => {
    expect(normalizeDate('Mon, 26 Oct 2026 12:00:00 GMT')).toBe('2026-10-26T12:00:00.000Z');
    expect(normalizeDate('2026-09-30')).toBe('2026-09-30T00:00:00.000Z');
    expect(normalizeDate(1793000000)).toBe('2026-10-26T07:33:20.000Z');
    expect(normalizeDate('20261026T120000Z')).toBe('2026-10-26T12:00:00.000Z');
    expect(normalizeDate('not a date')).toBeNull();
    expect(normalizeDate('')).toBeNull();
  });
  it('reads amounts with currency and unit, and never invents a currency', () => {
    expect(parseAmount('$1,200.50 per unit')).toEqual({ value: 1200.5, currency: 'USD', unit: 'unit' });
    expect(parseAmount('£40/hr')).toEqual({ value: 40, currency: 'GBP', unit: 'hour' });
    expect(parseAmount('€3.5k')).toEqual({ value: 3500, currency: 'EUR', unit: null });
    expect(parseAmount('3500 EUR')?.currency).toBe('EUR');
    expect(parseAmount('call us')).toBeNull();
    expect(parseAmount('1200')).toBeNull();
    expect(parseAmount('CA$900')).toBeNull();
  });
  it('canonicalises urls so copies match', () => {
    expect(canonicalUrl('HTTPS://www.Example.com:443/a//b/?utm_source=x&b=2&a=1#top')).toBe('https://example.com/a/b?a=1&b=2');
    expect(canonicalUrl('ftp://x')).toBeNull();
    expect(dedupeKey({ organization: 'Acme, Inc.', title: 'Plant!', publishedAt: '2026-10-26T01:00:00Z' })).toBe(
      dedupeKey({ organization: 'acme inc', title: 'plant', publishedAt: '2026-10-26T23:00:00Z' }));
  });
});

describe('collectors', () => {
  it('RSS: normalises, strips markup, canonicalises and marks missing fields', () => {
    const r = collect({ kind: 'RSS_ATOM' }, ok(fx('rss.xml')), 'https://example.com/feed');
    expect(r.outcome).toBe('RECORDS');
    expect(r.records).toHaveLength(2);
    const [a, b] = r.records;
    expect(a).toMatchObject({ title: 'Acme & Sons opens plant', url: 'https://example.com/news/acme', organization: 'Acme', body: 'New plant in Ohio', publishedAt: '2026-10-26T12:00:00.000Z' });
    expect(a!.missing).toEqual(['location', 'amount']);
    expect(b!.missing).toEqual(expect.arrayContaining(['publishedAt', 'organization', 'body']));
  });
  it('Atom: link rel, author and amount in summary', () => {
    const r = collect({ kind: 'RSS_ATOM' }, ok(fx('atom.xml')), 'https://example.org/f');
    expect(r.records[0]).toMatchObject({ url: 'https://example.org/bid/1', organization: 'City of X', publishedAt: '2026-10-20T08:00:00.000Z' });
  });
  it('JSON API: mapped fields, joined location, pagination by cursor', () => {
    const mapping: JsonMapping = { rows: 'data.jobs', externalId: 'id', url: 'link', title: 'name', organization: 'company', publishedAt: 'posted', amount: 'pay', location: 'city+st', next: { kind: 'cursor', path: 'cursor', param: 'after' } };
    const r = collect({ kind: 'JSON_API', mapping }, ok(fx('api-page1.json')), 'https://api.example.com/jobs');
    expect(r.outcome).toBe('RECORDS');
    expect(r.records[0]).toMatchObject({ url: 'https://api.example.com/j/1', location: 'Toledo, OH', amount: { value: 45, currency: 'USD', unit: 'hour' }, publishedAt: '2026-10-26T07:33:20.000Z' });
    expect(r.records[1]!.missing).toEqual(expect.arrayContaining(['organization', 'amount', 'location']));
    expect(r.next).toBe('https://api.example.com/jobs?after=abc');
  });
  it('JSON API: a page-number rule and a page past the end stops', () => {
    const mapping: JsonMapping = { rows: 'data.jobs', url: 'link', title: 'name', next: { kind: 'page', param: 'page' } };
    expect(collect({ kind: 'JSON_API', mapping, page: 2 }, ok(fx('api-page1.json')), 'https://a.example.com/x?page=2').next).toBe('https://a.example.com/x?page=3');
    const empty = collect({ kind: 'JSON_API', mapping }, ok('{"data":{"jobs":[]}}'), 'https://a.example.com/x');
    expect(empty.outcome).toBe('NO_MATCHING_RECORDS');
    expect(empty.next).toBeNull();
    expect(collect({ kind: 'JSON_API', mapping }, ok('<html>'), 'https://a.example.com/x').outcome).toBe('UNPARSEABLE');
  });
  it('CSV: quoting, skipped rows without a title, bad dates missing', () => {
    expect(parseCsvRows('a,b\n"x,1","y ""q"""\n')).toEqual([['a', 'b'], ['x,1', 'y "q"']]);
    const r = collect({ kind: 'CSV', mapping: { externalId: 'id', title: 'name', organization: 'org', publishedAt: 'posted', amount: 'value', location: 'city', urlTemplate: 'https://data.example.gov/r/{externalId}' } }, ok(fx('data.csv')), 'https://data.example.gov/d.csv');
    expect(r.records.map((x) => x.title)).toEqual(['Road, repair', 'Bridge']);
    expect(r.records[0]).toMatchObject({ organization: 'Dept "A"', amount: { value: 3500, currency: 'EUR' }, location: 'Lyon' });
    expect(r.records[1]!.publishedAt).toBeNull();
    expect(r.records[1]!.missing).toContain('publishedAt');
  });
  it('HTML list: repeating blocks, relative urls resolved, tracking stripped', () => {
    const mapping = { item: '<li class="r">.*?</li>', url: 'href="([^"]+)"', title: '<a[^>]*>(.*?)</a>', organization: '<span class="o">(.*?)</span>', publishedAt: '<time>(.*?)</time>' };
    const r = collect({ kind: 'HTML_LIST', mapping }, ok(fx('list.html')), 'https://city.example.gov/rfps');
    expect(r.records.map((x) => x.url)).toEqual(['https://city.example.gov/p/1', 'https://city.example.gov/p/2']);
    expect(r.records[0]!.publishedAt).toBe('2026-10-12T00:00:00.000Z');
    expect(collect({ kind: 'HTML_LIST', mapping: { ...mapping, item: '(' } }, ok(fx('list.html')), 'https://x.gov/').outcome).toBe('UNPARSEABLE');
  });
  it('sitemap: titles from slugs, lastmod as date, index returns next', () => {
    const r = collect({ kind: 'SITEMAP' }, ok(fx('sitemap.xml')), 'https://example.com/sitemap.xml');
    expect(r.records.map((x) => x.title)).toEqual(['steel pipe', 'copper wire']);
    expect(r.records[0]!.publishedAt).toBe('2026-10-01T00:00:00.000Z');
  });
  it('Overpass: named places only, website preferred, missing recorded', () => {
    const body = JSON.stringify({ elements: [{ type: 'node', id: 7, tags: { name: 'Joe Cafe', amenity: 'cafe', website: 'joes.example.com', 'addr:city': 'Tampa' } }, { type: 'node', id: 8, tags: { shop: 'x' } }] });
    const r = collect({ kind: 'OVERPASS' }, ok(body), 'https://overpass-api.de/api/interpreter');
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ externalId: 'node/7', url: 'https://joes.example.com/', location: 'Tampa' });
  });
  it('page watch: first reading, unchanged, changed, and a missing region', () => {
    const page = (s: string) => `<html><title>T</title><body><div id="x">${s}</div><p>footer ${Math.random()}</p></body></html>`;
    const spec = (prior: string | null) => ({ kind: 'PAGE_WATCH' as const, region: '<div id="x">(.*?)</div>', priorTextHash: prior });
    const first = collect(spec(null), ok(page('price 10')), 'https://shop.example.com/p');
    expect(first.outcome).toBe('RECORDS');
    const hash = first.note!.split(':')[1]!;
    expect(collect(spec(hash), ok(page('price 10')), 'https://shop.example.com/p').outcome).toBe('UNCHANGED');
    expect(collect(spec(hash), ok(page('price 12')), 'https://shop.example.com/p').note).toMatch(/^CHANGED:/);
    expect(collect({ kind: 'PAGE_WATCH', region: '<nav>(.*?)</nav>' }, ok(page('a')), 'https://shop.example.com/p').outcome).toBe('UNPARSEABLE');
  });
});

describe('conditional requests and refusals', () => {
  it('sends validators and treats 304 and an equal body hash as unchanged', () => {
    expect(conditionalHeaders({ etag: '"e1"', lastModified: 'Mon, 1 Jan 2026 00:00:00 GMT' })).toEqual({ 'if-none-match': '"e1"', 'if-modified-since': 'Mon, 1 Jan 2026 00:00:00 GMT' });
    expect(collect({ kind: 'RSS_ATOM' }, { status: 304, body: '' }, 'https://e.com/f', { etag: '"e1"' })).toMatchObject({ outcome: 'UNCHANGED', etag: '"e1"' });
    const first = collect({ kind: 'RSS_ATOM' }, ok(fx('rss.xml'), { etag: '"e2"' }), 'https://e.com/f');
    expect(first.etag).toBe('"e2"');
    const again = collect({ kind: 'RSS_ATOM' }, ok(fx('rss.xml')), 'https://e.com/f', { bodyHash: first.bodyHash });
    expect(again.outcome).toBe('UNCHANGED');
    expect(again.records).toEqual([]);
  });
  it('records a refusal and never offers a retry for it', () => {
    for (const [status, cause] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [410, 'GONE'], [402, 'PAYWALL']] as const) {
      const r = gate({ status, body: 'x' });
      expect(r).toMatchObject({ outcome: 'REFUSED', refusal: cause, temporary: null });
      expect(retryDelayMs(r!, 0)).toBeNull();
    }
    expect(gate({ status: 403, body: '<h1>Please complete the CAPTCHA</h1>' })!.refusal).toBe('CAPTCHA');
    expect(gate({ status: 200, body: '<p>Verify you are human</p>' })!.refusal).toBe('CAPTCHA');
  });
  it('separates SOURCE_UNREACHABLE (retry with backoff) from NO_MATCHING_RECORDS', () => {
    for (const [resp, cause] of [[{ status: 503, body: '' }, 'SERVER_ERROR'], [{ status: 429, body: '' }, 'RATE_LIMITED'], [{ status: 0, body: '', errorCode: 'ETIMEDOUT' }, 'TIMEOUT'], [{ status: 0, body: '', errorCode: 'ENOTFOUND' }, 'NETWORK']] as const) {
      const r = gate(resp);
      expect(r).toMatchObject({ outcome: 'SOURCE_UNREACHABLE', temporary: cause });
      expect(retryDelayMs(r!, 1)).toBe(4_000);
      expect(retryDelayMs(r!, 4)).toBeNull();
    }
    expect(collect({ kind: 'RSS_ATOM' }, ok('<rss><channel></channel></rss>'), 'https://e.com/f').outcome).toBe('NO_MATCHING_RECORDS');
    expect(collect({ kind: 'RSS_ATOM' }, ok('<html>not a feed</html>'), 'https://e.com/f').outcome).toBe('UNPARSEABLE');
  });
  it('never throws on garbage', () => {
    for (const body of ['', '\u0000\u0001', '<<<>>>', '{"a":', 'x'.repeat(100_000)]) {
      for (const spec of [{ kind: 'RSS_ATOM' }, { kind: 'SITEMAP' }, { kind: 'OVERPASS' }, { kind: 'CSV', mapping: { title: 't' } }, { kind: 'PAGE_WATCH' }] as const) {
        expect(() => collect(spec, ok(body), 'https://e.com/')).not.toThrow();
      }
    }
  });
});
