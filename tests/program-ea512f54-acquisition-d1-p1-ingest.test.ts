/**
 * ACQ-21-4 step 3 — a large corpus is ingested in shards, filtered in place,
 * checkpointed after every shard, resumed after an interruption, deduplicated
 * by content hash and paced per provider.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { contentHash, feedIngestStore, ingestShards, INGEST_CHECKPOINT_EVENT, type IngestStore, type ShardCheckpoint, type ShardedSource } from '../server/services/feeds/ingest.ts';
import type { FeedItem } from '../server/services/feeds/sources.ts';

const item = (id: string, title = `title ${id}`, body: string | null = `body ${id}`): FeedItem => ({
  externalId: id,
  url: `https://corpus.example/${id}`,
  title,
  body,
  organization: null,
  publishedAt: '2026-11-01T00:00:00.000Z',
});

function memoryStore(): IngestStore & { rows: Map<string, FeedItem>; saved: ShardCheckpoint[] } {
  const rows = new Map<string, FeedItem>();
  const saved: ShardCheckpoint[] = [];
  return {
    rows,
    saved,
    checkpoints: async (source) => saved.filter((one) => one.source === source),
    saveCheckpoint: async (checkpoint) => {
      saved.push(checkpoint);
    },
    store: async (source, items) => {
      let n = 0;
      for (const one of items) {
        const key = `${source}:${one.externalId}`;
        if (!rows.has(key)) {
          rows.set(key, one);
          n += 1;
        }
      }
      return n;
    },
  };
}

const shardsOf = (data: Record<string, FeedItem[]>, failOn: Set<string> = new Set(), log: string[] = []): Pick<ShardedSource, 'shards' | 'fetchShard'> => ({
  shards: Object.keys(data),
  fetchShard: async (key) => {
    log.push(key);
    if (failOn.has(key)) throw new Error(`shard ${key} reset by peer`);
    return data[key]!;
  },
});

describe('ACQ-21-4 — checkpointed, resumable ingestion', () => {
  it('an interrupted run resumes at the next unprocessed shard and re-reads nothing already checkpointed', async () => {
    const store = memoryStore();
    const data = { 's-0': [item('a'), item('b')], 's-1': [item('c')], 's-2': [item('d')] };
    const log: string[] = [];
    const failing = new Set(['s-1']);
    const first = await ingestShards({ id: 'corpus', snapshot: '2026-11', spacingMs: 0, ...shardsOf(data, failing, log) }, store);
    expect(first.completed.map((one) => one.shard)).toEqual(['s-0']);
    expect(first.interruptedAt).toEqual({ shard: 's-1', error: 'shard s-1 reset by peer' });
    expect(store.rows.size).toBe(2);

    failing.clear();
    const second = await ingestShards({ id: 'corpus', snapshot: '2026-11', spacingMs: 0, ...shardsOf(data, failing, log) }, store);
    expect(second.resumedPast).toEqual(['s-0']);
    expect(second.completed.map((one) => one.shard)).toEqual(['s-1', 's-2']);
    expect(second.interruptedAt).toBeNull();
    // s-0 was fetched once, ever; the failed shard was fetched again, and nothing else twice.
    expect(log).toEqual(['s-0', 's-1', 's-1', 's-2']);
    expect(store.rows.size).toBe(4);
  });

  it('the same content under a new id is a duplicate, and changed content under a known id is an update', async () => {
    const store = memoryStore();
    await ingestShards({ id: 'corpus', snapshot: 'v1', spacingMs: 0, ...shardsOf({ 'p-0': [item('a', 'same thing', 'same body'), item('b')] }) }, store);
    const next = await ingestShards(
      {
        id: 'corpus',
        snapshot: 'v2',
        spacingMs: 0,
        ...shardsOf({ 'p-0': [item('a2', 'same thing', 'same body'), item('b', 'title b', 'revised body'), item('c')] }),
      },
      store,
    );
    const checkpoint = next.completed[0]!;
    expect(checkpoint.duplicates).toBe(1);
    expect(checkpoint.updated).toEqual(['b']);
    expect(checkpoint.stored).toBe(1);
    expect(store.rows.has('corpus:a2')).toBe(false);
    expect(store.rows.has('corpus:c')).toBe(true);
    expect(checkpoint.hashes['b']).toBe(contentHash(item('b', 'title b', 'revised body')));
  });

  it('a hash is the content, never the fetch: the same record hashes the same, a changed field does not', () => {
    expect(contentHash(item('x'))).toBe(contentHash(item('x')));
    expect(contentHash(item('x'))).not.toBe(contentHash(item('x', 'title x', 'other')));
    expect(contentHash(item('x'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the provider\'s pacing is waited between shard requests, and not before the first', async () => {
    const store = memoryStore();
    const waits: number[] = [];
    await ingestShards({ id: 'paced', snapshot: 's', spacingMs: 1_500, ...shardsOf({ a: [item('1')], b: [item('2')], c: [item('3')] }) }, store, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([1_500, 1_500]);
  });

  it('only records the in-place filter keeps are stored; the rest are counted, not copied', async () => {
    const store = memoryStore();
    const run = await ingestShards(
      { id: 'filtered', snapshot: 's', spacingMs: 0, keep: (one) => (one.body ?? '').includes('wanted'), ...shardsOf({ a: [item('1', 't', 'wanted record'), item('2', 't', 'noise'), item('3', 't', 'noise')] }) },
      store,
    );
    expect(run.completed[0]).toMatchObject({ read: 3, kept: 1, stored: 1 });
    expect([...store.rows.keys()]).toEqual(['filtered:1']);
    expect(Object.keys(run.completed[0]!.hashes)).toEqual(['1']);
  });
});

describe('ACQ-21-4 — the production store', () => {
  it('stores records in feed_items and checkpoints on the cash ledger, and a new run resumes from those rows', async () => {
    const fixture = await freshProject();
    const store = feedIngestStore(fixture.project.id);
    const source = `corpus-${Math.random().toString(36).slice(2, 8)}`;
    const data = { 'idx-0': [item(`${source}-a`)], 'idx-1': [item(`${source}-b`)] };
    const failing = new Set(['idx-1']);
    const first = await ingestShards({ id: source, snapshot: 'crawl-1', spacingMs: 0, ...shardsOf(data, failing) }, store);
    expect(first.interruptedAt?.shard).toBe('idx-1');

    const { getDb } = await import('../server/db/database.ts');
    const count = async () => (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM feed_items WHERE source = ?', [source]))!.n;
    expect(Number(await count())).toBe(1);
    const events = await getDb().all<{ detail: string }>('SELECT detail FROM cash_events WHERE project_id = ? AND kind = ?', [fixture.project.id, INGEST_CHECKPOINT_EVENT]);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ source, snapshot: 'crawl-1', shard: 'idx-0', stored: 1 });

    failing.clear();
    const log: string[] = [];
    const second = await ingestShards({ id: source, snapshot: 'crawl-1', spacingMs: 0, ...shardsOf(data, failing, log) }, feedIngestStore(fixture.project.id));
    expect(second.resumedPast).toEqual(['idx-0']);
    expect(log).toEqual(['idx-1']);
    expect(Number(await count())).toBe(2);
  });
});
