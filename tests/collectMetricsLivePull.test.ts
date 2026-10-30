import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { readSourceMetrics } from '../server/repos/collectMetrics.ts';
import { pullDueFeeds } from '../server/services/feeds/run.ts';
import type { FeedSource } from '../server/services/feeds/sources.ts';

beforeEach(async () => { await freshProject(); });

const source = (id: string): FeedSource => ({
  id, label: id, url: `https://example.test/${id}`, intervalMs: 3_600_000,
  parse: () => [
    { externalId: 'a', title: 'A', url: 'https://example.test/a', body: null, organization: null, publishedAt: null },
    { externalId: 'b', title: 'B', url: 'https://example.test/b', body: null, organization: null, publishedAt: null },
  ],
});

describe('the live pull path records source metrics', () => {
  it('writes method-aware wall time and failure cause through pullDueFeeds, so readSourceMetrics is not empty', async () => {
    const now = new Date('2026-10-30T00:00:00Z');
    await pullDueFeeds({ now, sources: [source('ok-src')], fetcher: async () => [] });
    await pullDueFeeds({ now, sources: [source('bad-src')], fetcher: async () => { throw new Error('ENOTFOUND'); } });
    const by = new Map((await readSourceMetrics()).map((r) => [r.source, r]));
    expect(by.get('ok-src')).toMatchObject({ pulls: 1, fetched: 2, inserted: 2 });
    expect(by.get('bad-src')?.failuresByCause).toEqual({ SOURCE_UNREACHABLE: 1 });
  });
});
