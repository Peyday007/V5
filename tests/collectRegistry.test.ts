import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  FEED_SOURCES, SOURCE_ROWS, canonicalUrl, dedupeItems, parseCsv, parseRssAtom, rowsVisibleTo, sourceFromRow, type SourceRow,
} from '../server/services/feeds/sources.ts';
import { isPermanentRefusal, nextPullAt, pullDueFeeds } from '../server/services/feeds/run.ts';
import { SITE_SWEEP_ROW } from '../server/services/feeds/sites.ts';

const RSS = `<rss><channel><item><title>Recall &amp; alert</title><link>https://x.gov/a?utm_source=z</link><guid>g1</guid><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Bad batch</p>]]></description></item><item><title>No link</title></item></channel></rss>`;
const ATOM = `<feed><entry><title>Atom one</title><link href="https://y.gov/1"/><id>tag:1</id><updated>2026-10-01T00:00:00Z</updated><summary>S</summary></entry></feed>`;

beforeEach(async () => { await freshProject(); });

describe('source registry', () => {
  it('keeps the original three as rows with their original URLs and intervals', () => {
    const by = new Map(FEED_SOURCES.map((s) => [s.id, s]));
    expect(by.get('remoteok')).toMatchObject({ url: 'https://remoteok.com/api', intervalMs: 6 * 3_600_000 });
    expect(by.get('remotive')?.url).toBe('https://remotive.com/api/remote-jobs?limit=300');
    expect(by.get('federal-register-rules')?.url).toContain('conditions%5Btype%5D%5B%5D=RULE');
  });
  it('has at least five new keyless sources across three kinds, each with robots status recorded', () => {
    const added = SOURCE_ROWS.filter((r) => !r.id.startsWith('news-') && !['remoteok', 'remotive', 'federal-register-rules'].includes(r.id));
    expect(added.length).toBeGreaterThanOrEqual(5);
    expect(new Set(added.map((r) => r.kind)).size).toBeGreaterThanOrEqual(3);
    for (const r of SOURCE_ROWS) expect(r.robots.status).not.toBe('UNCHECKED');
  });
  it('describes the OSM sweep as a row', () => {
    expect(SITE_SWEEP_ROW.kind).toBe('OSM_OVERPASS');
    expect(() => sourceFromRow(SITE_SWEEP_ROW)).toThrow(/sites\.ts/);
  });
  it('pulls a new source of an existing kind added only as a row', async () => {
    const row: SourceRow = { id: 'collect-test-rss', label: 'Test feed', kind: 'RSS_ATOM', url: 'https://example.test/feed', intervalHours: 1, robots: { status: 'ALLOWED_PUBLIC_FEED', checkedAt: '2026-10-30', note: 't' }, ownerProjectId: null };
    const out = await pullDueFeeds({ now: new Date('2026-10-30T00:00:00Z'), sources: [sourceFromRow(row)], fetcher: async (_u, _h, _t, format) => { expect(format).toBe('text'); return RSS; } });
    expect(out[0]).toMatchObject({ source: 'collect-test-rss', inserted: 1, error: null, outcome: 'COLLECTED' });
  });
  it('hides a private project source from another project', () => {
    const priv: SourceRow = { ...SOURCE_ROWS[0]!, id: 'private-one', ownerProjectId: 'prj_a' };
    expect(rowsVisibleTo('prj_a', [priv]).length).toBe(1);
    expect(rowsVisibleTo('prj_b', [priv]).length).toBe(0);
    expect(rowsVisibleTo(null, [priv, SOURCE_ROWS[0]!]).map((r) => r.id)).toEqual(['remoteok']);
  });
  it('does not pull a private source for another project', async () => {
    const priv = sourceFromRow({ ...SOURCE_ROWS[0]!, id: 'private-two', ownerProjectId: 'prj_a' });
    let called = 0;
    const out = await pullDueFeeds({ now: new Date('2026-10-30T00:00:00Z'), sources: [priv], projectId: 'prj_b', fetcher: async () => { called += 1; return []; } });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});

describe('generic collectors', () => {
  it('reads RSS and Atom and drops entries with no link', () => {
    const rss = parseRssAtom(RSS);
    expect(rss).toHaveLength(1);
    expect(rss[0]).toMatchObject({ title: 'Recall & alert', externalId: 'g1', body: 'Bad batch' });
    expect(parseRssAtom(ATOM)[0]).toMatchObject({ url: 'https://y.gov/1', externalId: 'tag:1' });
    expect(parseRssAtom(42)).toEqual([]);
  });
  it('reads CSV with quotes through mapped columns', () => {
    const csv = 'id,name,link\n1,"Acme, Inc",https://a.test/1\n2,Bad,notaurl\n';
    expect(parseCsv(csv, { id: 'id', title: 'name', url: 'link' })).toEqual([
      expect.objectContaining({ externalId: '1', title: 'Acme, Inc' }),
    ]);
  });
  it('a page watch yields nothing new while the page is unchanged and one item when it changes', () => {
    const watch = sourceFromRow(SOURCE_ROWS.find((r) => r.kind === 'PAGE_WATCH')!);
    const a = watch.parse('<html><body>Rates 7.25</body></html>');
    expect(watch.parse('<html><body>Rates 7.25</body></html>')[0]?.externalId).toBe(a[0]?.externalId);
    expect(watch.parse('<html><body>Rates 7.50</body></html>')[0]?.externalId).not.toBe(a[0]?.externalId);
  });
  it('canonicalises URLs and collapses duplicates within a batch', () => {
    expect(canonicalUrl('https://WWW.X.gov/a/?utm_source=q#f')).toBe('https://x.gov/a');
    const item = { externalId: '1', url: 'https://x.gov/a', title: 'T', body: null, organization: 'O', publishedAt: null };
    const { kept, duplicates } = dedupeItems([item, { ...item, externalId: '2', url: 'https://www.x.gov/a?utm_x=1' }]);
    expect(kept).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe('reliability', () => {
  it('names unreachable vs empty, and isolates a failing source', async () => {
    const ok = sourceFromRow({ id: 'collect-ok', label: 'ok', kind: 'RSS_ATOM', url: 'https://ok.test/', intervalHours: 1, robots: { status: 'ALLOWED_PUBLIC_FEED', checkedAt: 'x', note: '' }, ownerProjectId: null });
    const bad = sourceFromRow({ ...ok.row!, id: 'collect-bad', url: 'https://bad.test/' });
    const empty = sourceFromRow({ ...ok.row!, id: 'collect-empty', url: 'https://empty.test/' });
    const out = await pullDueFeeds({
      now: new Date('2026-10-30T00:00:00Z'),
      sources: [bad, empty, ok],
      fetcher: async (url) => { if (url.includes('bad')) throw new Error('HTTP 403'); return url.includes('empty') ? '<rss/>' : RSS; },
    });
    expect(out.map((o) => o.outcome)).toEqual(['SOURCE_UNREACHABLE', 'NO_MATCHING_RECORDS', 'COLLECTED']);
  });
  it('treats 401/403/410/robots as permanent and does not retry them before the interval', () => {
    expect(isPermanentRefusal('HTTP 403')).toBe(true);
    expect(isPermanentRefusal('HTTP 429')).toBe(false);
    const src = { intervalMs: 6 * 3_600_000 };
    const state = { lastSuccessAt: null, failuresSince: 1, lastFailureAt: '2026-10-30T00:00:00.000Z' };
    expect(nextPullAt(src, { ...state, permanent: true }) - Date.parse(state.lastFailureAt)).toBe(6 * 3_600_000);
    expect(nextPullAt(src, state) - Date.parse(state.lastFailureAt)).toBeLessThan(6 * 3_600_000);
  });
});
