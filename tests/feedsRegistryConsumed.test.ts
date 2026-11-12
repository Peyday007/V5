/**
 * The `collect_sources` registry is what the pull reads: a database row alone,
 * with no code change, becomes a source `pullDueFeeds` pulls
 * (repair-registry-not-consumed).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { addCollectSource, setSourceEnabled } from '../server/repos/collectSources.ts';
import { FEED_SOURCES, registryReading, sourceFromRegistry } from '../server/services/feeds/sources.ts';
import { pullDueFeeds, readRegistryRows, registrySources, type Fetcher } from '../server/services/feeds/run.ts';
import { getDb } from '../server/db/database.ts';

const NOW = new Date('2026-11-01T00:00:00Z');
const RSS = `<rss><channel><item><title>Registry item</title><link>https://registry.test/a</link><guid>r1</guid></item></channel></rss>`;
const CSV = 'Ref,Name,Link\nT-1,"Bridge works, phase 2",https://tenders.test/1\n';

/** Answers the registry test hosts; every code source gets an empty body. */
const fetcher: Fetcher = async (url, _h, _t, format) => {
  if (url.startsWith('https://registry.test/')) return RSS;
  if (url.startsWith('https://tenders.test/')) return CSV;
  return format === 'text' ? '' : [];
};

let projectId = '';
beforeEach(async () => { projectId = (await freshProject()).project.id; });

describe('the pull reads the collect_sources registry', () => {
  it('pulls a source that exists only as a database row', async () => {
    await addCollectSource({ slug: 'db-only-rss', label: 'DB only', kind: 'RSS_ATOM', urlTemplate: 'https://registry.test/feed', parserId: 'rss:default', intervalMs: 3_600_000 });
    const out = await pullDueFeeds({ now: NOW, fetcher, robots: null });
    expect(out.find((o) => o.source === 'db-only-rss')).toMatchObject({ inserted: 1, error: null, outcome: 'COLLECTED' });
    const stored = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM feed_items WHERE source = ?', ['db-only-rss']);
    expect(Number(stored?.n)).toBe(1);
    // The code rows are still pulled beside it.
    expect(out.some((o) => o.source === 'remoteok')).toBe(true);
  });

  it('reads a CSV row through the field mapping its parser id carries, with no code', async () => {
    await addCollectSource({ slug: 'db-csv', label: 'Tenders', kind: 'CSV_DATASET', urlTemplate: 'https://tenders.test/new.csv', parserId: 'csv:id=Ref&title=Name&url=Link', intervalMs: 3_600_000 });
    const out = await pullDueFeeds({ now: NOW, fetcher, robots: null });
    expect(out.find((o) => o.source === 'db-csv')).toMatchObject({ inserted: 1, outcome: 'COLLECTED' });
    const item = await getDb().get<{ title: string; url: string }>('SELECT title, url FROM feed_items WHERE source = ?', ['db-csv']);
    expect(item).toMatchObject({ title: 'Bridge works, phase 2', url: 'https://tenders.test/1' });
  });

  it('does not pull a disabled row', async () => {
    const row = await addCollectSource({ slug: 'db-disabled', label: 'Off', kind: 'RSS_ATOM', urlTemplate: 'https://registry.test/off', parserId: 'rss:default', intervalMs: 3_600_000 });
    await setSourceEnabled(row.id, false);
    const out = await pullDueFeeds({ now: NOW, fetcher, robots: null });
    expect(out.some((o) => o.source === 'db-disabled')).toBe(false);
  });

  it('leaves a slug a code row defines to that row, so it is pulled once', async () => {
    const code = FEED_SOURCES[0]!;
    await addCollectSource({ slug: code.id, label: code.label, kind: 'JSON_API', urlTemplate: code.url, parserId: 'json:remoteok', intervalMs: code.intervalMs });
    const out = await pullDueFeeds({ now: NOW, fetcher, robots: null });
    expect(out.filter((o) => o.source === code.id)).toHaveLength(1);
  });

  it("keeps a project's private row out of another project's pull, and in the unscoped loop", async () => {
    await addCollectSource({ projectId, slug: 'db-private', label: 'Private', kind: 'RSS_ATOM', urlTemplate: 'https://registry.test/private', parserId: 'rss:default', intervalMs: 3_600_000 });
    expect((await readRegistryRows('prj_someone_else')).map((r) => r.slug)).not.toContain('db-private');
    expect((await readRegistryRows(projectId)).map((r) => r.slug)).toContain('db-private');
    expect((await readRegistryRows(undefined)).map((r) => r.slug)).toContain('db-private');
    const other = await pullDueFeeds({ now: NOW, fetcher, robots: null, projectId: 'prj_someone_else' });
    expect(other.some((o) => o.source === 'db-private')).toBe(false);
    const loop = await pullDueFeeds({ now: NOW, fetcher, robots: null });
    expect(loop.find((o) => o.source === 'db-private')).toMatchObject({ inserted: 1 });
  });

  it('an injected list is pulled as given, without the registry', async () => {
    await addCollectSource({ slug: 'db-not-injected', label: 'x', kind: 'RSS_ATOM', urlTemplate: 'https://registry.test/x', parserId: 'rss:default', intervalMs: 3_600_000 });
    const out = await pullDueFeeds({ now: NOW, fetcher, robots: null, sources: [] });
    expect(out).toEqual([]);
  });
});

describe('a registry row as a runnable source', () => {
  it('reads a named parser exactly as the code row with that parser', () => {
    expect(registryReading('json:remoteok')).toEqual({ name: 'remoteok', mapping: {} });
    expect(registryReading('csv:title=Name&url=Link')).toEqual({ name: null, mapping: { title: 'Name', url: 'Link' } });
    expect(registryReading('rss:default')).toEqual({ name: null, mapping: {} });
  });
  it('carries the row kind, host rate and interval', () => {
    const at = new Date().toISOString();
    const s = sourceFromRegistry({ id: 'csr_1', projectId: null, slug: 's', label: 'L', kind: 'SITEMAP', urlTemplate: 'https://a.test/sitemap.xml', pagination: null, parserId: 'sitemap:default', intervalMs: 5, hostRatePerMin: 6, robotsStatus: 'UNCHECKED', robotsCheckedAt: null, robotsNote: null, enabled: true, createdAt: at, updatedAt: at });
    expect(s).toMatchObject({ id: 's', intervalMs: 5, spacingMs: 10_000, format: 'text', registry: { kind: 'SITEMAP' } });
    expect(registrySources([], new Set())).toEqual([]);
  });
});
