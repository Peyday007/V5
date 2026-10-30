import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { addCollectSource, getCheckpoint, listCollectSources, saveCheckpoint, setRobotsStatus } from '../server/repos/collectSources.ts';
import { readSourceMetrics, recordPullMetrics } from '../server/repos/collectMetrics.ts';
import { insertFeedItems, itemSources, itemVersions, linkItemSource, recordItemVersion } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';

const base = { kind: 'RSS_ATOM' as const, urlTemplate: 'https://x.test/feed', parserId: 'rss', intervalMs: 3_600_000 };

describe('collect registry', () => {
  let projectId: string;
  beforeEach(async () => { projectId = (await freshProject()).project.id; });

  it('adds a source as data, idempotently, starting UNCHECKED', async () => {
    const a = await addCollectSource({ ...base, slug: 'a', label: 'A' });
    const b = await addCollectSource({ ...base, slug: 'a', label: 'A again' });
    expect(b.id).toBe(a.id);
    expect(a.robotsStatus).toBe('UNCHECKED');
    await setRobotsStatus(a.id, 'ALLOWED', 'robots.txt permits /feed');
    const [read] = await listCollectSources(null);
    expect(read?.robotsStatus).toBe('ALLOWED');
    expect(read?.robotsCheckedAt).not.toBeNull();
  });

  it('shows a private project source only to that project', async () => {
    await addCollectSource({ ...base, slug: 'pub', label: 'Public' });
    await addCollectSource({ ...base, slug: 'priv', label: 'Private', projectId });
    expect((await listCollectSources(null)).map((s) => s.slug)).toEqual(['pub']);
    expect((await listCollectSources('someone-else')).map((s) => s.slug)).toEqual(['pub']);
    expect((await listCollectSources(projectId)).map((s) => s.slug)).toEqual(['priv', 'pub']);
  });

  it('refuses a bad kind or interval', async () => {
    await expect(addCollectSource({ ...base, slug: 'k', label: 'k', kind: 'FTP' as never })).rejects.toThrow(/source kind/);
    await expect(addCollectSource({ ...base, slug: 'i', label: 'i', intervalMs: 0 })).rejects.toThrow(/interval/);
  });

  it('keeps one checkpoint per source and merges patches', async () => {
    const s = await addCollectSource({ ...base, slug: 'c', label: 'C' });
    await saveCheckpoint(s.id, { cursor: 'page-2', etag: 'e1' });
    await saveCheckpoint(s.id, { contentHash: 'h' });
    const cp = await getCheckpoint(s.id);
    expect([cp?.cursor, cp?.etag, cp?.contentHash]).toEqual(['page-2', 'e1', 'h']);
  });

  it('records pull metrics and sums them per source, with failures by cause', async () => {
    const m = { method: 'RSS_ATOM' as const, fetched: 10, inserted: 4, duplicates: 6, relevant: 2, signals: 1, failureCause: null, wallMs: 50, bytes: 100, memoryBytes: null, cheapCalls: 2, claudeJobs: 0 };
    await recordPullMetrics('s1', true, m);
    await recordPullMetrics('s1', false, { ...m, fetched: 0, inserted: 0, duplicates: null, cheapCalls: 0, failureCause: 'SOURCE_UNREACHABLE' }, 'ENOTFOUND');
    const [r] = (await readSourceMetrics()).filter((x) => x.source === 's1');
    expect([r?.pulls, r?.fetched, r?.inserted, r?.duplicates, r?.cheapCalls]).toEqual([2, 10, 4, 6, 2]);
    expect(r?.failuresByCause).toEqual({ SOURCE_UNREACHABLE: 1 });
  });

  it('keeps a change history in order and links one item to every source that delivered it', async () => {
    await insertFeedItems('one', [{ externalId: 'x1', url: 'https://x.test/1', title: 'T', body: null, organization: 'Acme', publishedAt: null }]);
    const row = await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE source = ?', ['one']);
    const id = row!.id;
    await recordItemVersion({ itemId: id, changeKind: 'NEW' });
    await recordItemVersion({ itemId: id, changeKind: 'FIELD_CHANGED', field: 'title', oldValue: 'T', newValue: 'T2' });
    expect((await itemVersions(id)).map((v) => v.changeKind).sort()).toEqual(['FIELD_CHANGED', 'NEW']);
    await linkItemSource(id, 'one', 'x1');
    await linkItemSource(id, 'two', 'y9');
    await linkItemSource(id, 'two', 'y9');
    expect(await itemSources(id)).toEqual([{ source: 'one', externalId: 'x1' }, { source: 'two', externalId: 'y9' }]);
  });
});
