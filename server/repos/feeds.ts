/**
 * Raw leads from free public feeds, and the record of each pull.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { FeedItem } from '../services/feeds/sources.ts';

export interface StoredFeedItem extends FeedItem {
  id: string;
  source: string;
  fetchedAt: string;
  shortlistedRoundId: string | null;
}

interface Row {
  id: string;
  source: string;
  external_id: string;
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  published_at: string | null;
  fetched_at: string;
  shortlisted_round_id: string | null;
}

const toItem = (row: Row): StoredFeedItem => ({
  id: row.id,
  source: row.source,
  externalId: row.external_id,
  url: row.url,
  title: row.title,
  body: row.body,
  organization: row.organization,
  publishedAt: row.published_at,
  fetchedAt: row.fetched_at,
  shortlistedRoundId: row.shortlisted_round_id,
});

/** Insert what is new; an item already held is left exactly as it was. */
export async function insertFeedItems(source: string, items: readonly FeedItem[]): Promise<number> {
  let inserted = 0;
  const at = nowIso();
  for (const item of items) {
    const result = await getDb().run(
      `INSERT INTO feed_items
         (id, source, external_id, url, title, body, organization, published_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [
        newId('fdi'),
        source,
        item.externalId,
        item.url,
        item.title.slice(0, 300),
        item.body,
        item.organization?.slice(0, 200) ?? null,
        item.publishedAt,
        at,
      ],
    );
    inserted += result.changes ?? 0;
  }
  return inserted;
}

export async function recordFeedPull(input: {
  source: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  error: string | null;
  at?: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO feed_pulls (id, source, ok, fetched, inserted, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId('fdp'), input.source, input.ok ? 1 : 0, input.fetched, input.inserted, input.error, input.at ?? nowIso()],
  );
}

export async function lastPullAt(source: string): Promise<string | null> {
  const row = await getDb().get<{ at: string | null }>(
    'SELECT MAX(created_at) AS at FROM feed_pulls WHERE source = ?',
    [source],
  );
  return row?.at ?? null;
}

/** Items no shortlist has taken, newest first. */
export async function unlistedFeedItems(input: { since: string; limit: number }): Promise<StoredFeedItem[]> {
  const rows = await getDb().all<Row>(
    `SELECT * FROM feed_items
      WHERE shortlisted_round_id IS NULL AND fetched_at >= ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT ?`,
    [input.since, input.limit],
  );
  return rows.map(toItem);
}

/** Mark items taken by a shortlist round; an item already taken is not moved. */
export async function markShortlisted(ids: readonly string[], roundId: string): Promise<void> {
  const at = nowIso();
  for (const id of ids) {
    await getDb().run(
      `UPDATE feed_items SET shortlisted_round_id = ?, shortlisted_at = ?
        WHERE id = ? AND shortlisted_round_id IS NULL`,
      [roundId, at, id],
    );
  }
}

export interface FeedReading {
  items: number;
  today: number;
  shortlisted: number;
  bySource: { source: string; items: number; lastPull: string | null; lastError: string | null }[];
}

export async function feedReading(now: Date = new Date()): Promise<FeedReading> {
  const db = getDb();
  const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const total = await db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM feed_items');
  const today = await db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM feed_items WHERE fetched_at >= ?', [day]);
  const listed = await db.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM feed_items WHERE shortlisted_round_id IS NOT NULL',
  );
  const per = await db.all<{ source: string; n: number | string }>(
    'SELECT source, COUNT(*) AS n FROM feed_items GROUP BY source ORDER BY source',
  );
  const bySource = [];
  for (const row of per) {
    const last = await db.get<{ created_at: string; error: string | null; ok: number }>(
      'SELECT created_at, error, ok FROM feed_pulls WHERE source = ? ORDER BY created_at DESC LIMIT 1',
      [row.source],
    );
    bySource.push({
      source: row.source,
      items: Number(row.n),
      lastPull: last?.created_at ?? null,
      lastError: last && !last.ok ? last.error : null,
    });
  }
  return { items: Number(total?.n ?? 0), today: Number(today?.n ?? 0), shortlisted: Number(listed?.n ?? 0), bySource };
}
