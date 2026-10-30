/**
 * Collectors turn a fetched body into normalised records. Pure: nothing here
 * touches a network or a database, and a refusal is recorded, never worked around.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collect, type CollectOutcome } from '../server/services/collect/collectors/index.ts';
import {
  canonicalUrl,
  normalizeAmount,
  normalizeDate,
  normalizeUnit,
} from '../server/services/collect/normalize/index.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/collect-collectors/${name}`, import.meta.url), 'utf8');
const ok = (body: string, extra: Record<string, unknown> = {}) => ({ status: 200, body, ...extra });
const records = (o: CollectOutcome) => {
  if (o.kind !== 'RECORDS') throw new Error(`expected RECORDS, got ${o.kind}`);
  return o.records;
};

describe('normalisation', () => {
  it('normalises dates and refuses ambiguous ones', () => {
    expect(normalizeDate('Tue, 28 Oct 2025 10:00:00 GMT')).toBe('2025-10-28T10:00:00.000Z');
    expect(normalizeDate(1761300000)).toBe('2025-10-24T10:00:00.000Z');
    expect(normalizeDate('03/14/2025')).toBe('2025-03-14T00:00:00.000Z');
    expect(normalizeDate('03/04/2025')).toBeNull();
    expect(normalizeDate('soon')).toBeNull();
  });
  it('reads amounts with currency and units, and assumes no currency', () => {
    expect(normalizeAmount('$1,200.50')).toEqual({ value: 1200.5, currency: 'USD', unit: null });
    expect(normalizeAmount('EUR 3.000,00 /day')).toEqual({ value: 3000, currency: 'EUR', unit: 'day' });
    expect(normalizeAmount('$30 per hour')).toEqual({ value: 30, currency: 'USD', unit: 'hour' });
    expect(normalizeAmount('12k USD')).toEqual({ value: 12000, currency: 'USD', unit: null });
    expect(normalizeAmount('1500')).toEqual({ value: 1500, currency: null, unit: null });
    expect(normalizeAmount('call us')).toBeNull();
    expect(normalizeUnit('per Hr')).toBe('hour');
    expect(normalizeUnit('parsecs')).toBeNull();
  });
  it('canonicalises URLs for dedupe', () => {
    expect(canonicalUrl('HTTPS://Ex.test/a/?utm_source=x&b=2&a=1#f')).toBe('https://ex.test/a?a=1&b=2');
    expect(canonicalUrl('/x', 'https://ex.test/y')).toBe('https://ex.test/x');
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('collectors', () => {
  it('parses RSS and records absent fields as missing', () => {
    const rs = records(collect('RSS_ATOM', ok(fx('feed.rss')), { url: 'https://ex.test/feed' }));
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({
      externalId: 'g1', title: 'Fleet & truck wash RFP', organization: 'Acme County',
      publishedAt: '2025-10-28T10:00:00.000Z', url: 'https://ex.test/a?id=2',
    });
    expect(rs[0]!.body).toContain('Budget $12,500 per day');
    expect(rs[1]!.missing).toEqual(expect.arrayContaining(['publishedAt', 'url', 'organization', 'amount']));
    expect(rs[1]!.missing).not.toContain('title');
  });
  it('parses Atom and returns the next page without following it', () => {
    const out = collect('RSS_ATOM', ok(fx('feed.atom')), { url: 'https://ex.test/atom' });
    expect(out.kind === 'RECORDS' && out.nextPage).toBe('https://ex.test/atom?page=2');
    expect(records(out)[0]).toMatchObject({ externalId: 'urn:1', organization: 'Org A', url: 'https://ex.test/e1' });
  });
  it('parses a paginated JSON API through a mapping', () => {
    const out = collect('JSON_API', ok(fx('api-page1.json')), {
      url: 'https://ex.test/api',
      mapping: { items: 'data.results', title: 'name', organization: 'company.name', publishedAt: 'posted', location: 'where', amount: 'pay', url: 'link', next: 'paging.next' },
    });
    const rs = records(out);
    expect(out.kind === 'RECORDS' && out.nextPage).toBe('https://ex.test/api?page=2');
    expect(rs[0]).toMatchObject({ title: 'Bulk steel tender', organization: 'Steelco', location: 'Detroit, MI', amount: { value: 3000, currency: 'EUR', unit: 'day' } });
    expect(rs[1]!.missing).toEqual(expect.arrayContaining(['publishedAt', 'amount', 'location']));
  });
  it('parses CSV with quotes, commas and ambiguous dates', () => {
    const rs = records(collect('CSV', ok(fx('data.csv')), { url: 'https://ex.test/d.csv' }));
    expect(rs[0]).toMatchObject({ title: 'Pump, industrial', amount: { value: 1200.5, currency: 'USD', unit: null }, publishedAt: '2025-10-02T00:00:00.000Z' });
    expect(rs[1]).toMatchObject({ title: 'Valve', organization: 'Beta "Corp"', publishedAt: '2025-03-14T00:00:00.000Z' });
    expect(rs[1]!.missing).toEqual(expect.arrayContaining(['amount', 'location', 'url']));
  });
  it('parses an HTML list page, ignoring script and non-matching items', () => {
    const out = collect('HTML_LIST', ok(fx('list.html')), { url: 'https://ex.test/jobs', mapping: { itemClass: 'job' } });
    const rs = records(out);
    expect(rs.map((r) => r.title)).toEqual(['Welder', 'Painter']);
    expect(rs[0]).toMatchObject({ url: 'https://ex.test/jobs/1', organization: 'Weld Inc', location: 'Akron', amount: { value: 30, currency: 'USD', unit: 'hour' }, publishedAt: '2025-10-05T00:00:00.000Z' });
    expect(out.kind === 'RECORDS' && out.nextPage).toBe('/jobs?page=2');
  });
  it('parses sitemaps and Overpass', () => {
    expect(records(collect('SITEMAP', ok(fx('sitemap.xml')), { url: 'https://ex.test/sitemap.xml' })).map((r) => r.url)).toEqual(['https://ex.test/a', 'https://ex.test/b']);
    const osm = records(collect('OVERPASS', ok(fx('overpass.json')), { url: 'https://overpass.test/' }));
    expect(osm).toHaveLength(1);
    expect(osm[0]).toMatchObject({ externalId: 'osm:node/1', title: "Joe's Garage", url: 'https://joes.test/', location: '5 Main' });
  });
  it('never throws on a strange body and distinguishes nothing-matched from unreachable', () => {
    for (const kind of ['RSS_ATOM', 'JSON_API', 'CSV', 'SITEMAP', 'HTML_LIST', 'OVERPASS', 'PAGE_WATCH'] as const) {
      expect(() => collect(kind, ok('\u0000{{<<not a thing'), { url: 'https://ex.test/' })).not.toThrow();
    }
    expect(collect('JSON_API', ok('{not json'), { url: 'https://ex.test/' }).kind).toBe('NO_MATCHING_RECORDS');
    expect(collect('RSS_ATOM', { status: 503, body: '' }, { url: 'https://ex.test/' })).toMatchObject({ kind: 'REFUSED', refusal: { reason: 'SERVER_ERROR', retryable: true } });
  });
});

describe('unchanged bodies are skipped', () => {
  it('treats 304, ETag, Last-Modified and an identical content hash as unchanged', () => {
    const first = collect('RSS_ATOM', ok(fx('feed.rss'), { etag: '"v1"', lastModified: 'Mon, 01 Sep 2025 00:00:00 GMT' }), { url: 'https://ex.test/f' });
    if (first.kind !== 'RECORDS') throw new Error('first pull should return records');
    expect(collect('RSS_ATOM', { status: 304, body: '' }, { url: 'u' })).toEqual({ kind: 'UNCHANGED', basis: 'STATUS_304' });
    expect(collect('RSS_ATOM', ok(fx('feed.rss'), { etag: '"v1"' }), { url: 'u', previous: { etag: first.etag } })).toEqual({ kind: 'UNCHANGED', basis: 'ETAG' });
    expect(collect('RSS_ATOM', ok(fx('feed.rss'), { lastModified: first.lastModified }), { url: 'u', previous: { lastModified: first.lastModified } })).toEqual({ kind: 'UNCHANGED', basis: 'LAST_MODIFIED' });
    expect(collect('RSS_ATOM', ok(fx('feed.rss')), { url: 'u', previous: { contentHash: first.contentHash } })).toEqual({ kind: 'UNCHANGED', basis: 'CONTENT_HASH' });
    expect(collect('RSS_ATOM', ok(fx('feed.atom')), { url: 'u', previous: { contentHash: first.contentHash } }).kind).toBe('RECORDS');
  });
});

describe('a refusal is recorded, not worked around', () => {
  it.each([
    [401, 'UNAUTHORIZED', false],
    [402, 'PAYWALL', false],
    [403, 'FORBIDDEN', false],
    [410, 'GONE', false],
    [429, 'RATE_LIMITED', true],
  ])('status %i', (status, reason, retryable) => {
    expect(collect('JSON_API', { status, body: '{}' }, { url: 'u' })).toMatchObject({ kind: 'REFUSED', refusal: { reason, retryable, status } });
  });
  it('recognises a CAPTCHA wall served with 200', () => {
    expect(collect('HTML_LIST', ok('<html><body>Please verify you are human <div class="g-recaptcha">captcha</div></body></html>'), { url: 'u' })).toMatchObject({ kind: 'REFUSED', refusal: { reason: 'CAPTCHA', retryable: false } });
  });
});

describe('page-change watch', () => {
  it('ignores script, comment and whitespace churn and reports a real text change', () => {
    const first = collect('PAGE_WATCH', ok(fx('watch-a.html')), { url: 'https://ex.test/p' });
    if (first.kind !== 'RECORDS') throw new Error('first sight returns the record');
    expect(collect('PAGE_WATCH', ok(fx('watch-b.html')), { url: 'https://ex.test/p', previous: { contentHash: first.contentHash } })).toEqual({ kind: 'UNCHANGED', basis: 'CONTENT_HASH' });
    const changed = collect('PAGE_WATCH', ok(fx('watch-c.html')), { url: 'https://ex.test/p', previous: { contentHash: first.contentHash } });
    expect(records(changed)[0]!.body).toContain('$7');
    expect(changed.kind === 'RECORDS' && changed.contentHash).not.toBe(first.contentHash);
  });
});
