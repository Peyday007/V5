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
export async function insertFeedItems(source: string, items: readonly FeedItem[], fetchedAt?: string): Promise<number> {
  let inserted = 0;
  const at = fetchedAt ?? nowIso();
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

/** The last success, and the failures since it, for one source. */
export async function pullState(source: string): Promise<{ lastSuccessAt: string | null; failuresSince: number; lastFailureAt: string | null }> {
  const db = getDb();
  const ok = await db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM feed_pulls WHERE source = ? AND ok = 1', [source]);
  const lastSuccessAt = ok?.at ?? null;
  const failed = await db.get<{ n: number | string; at: string | null }>(
    `SELECT COUNT(*) AS n, MAX(created_at) AS at FROM feed_pulls
      WHERE source = ? AND ok = 0 AND created_at > ?`,
    [source, lastSuccessAt ?? ''],
  );
  return { lastSuccessAt, failuresSince: Number(failed?.n ?? 0), lastFailureAt: failed?.at ?? null };
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
  // Every source that was ever asked, so one that has never returned anything still shows.
  const per = await db.all<{ source: string; n: number | string }>(
    `SELECT s.source, (SELECT COUNT(*) FROM feed_items i WHERE i.source = s.source) AS n
       FROM (SELECT source FROM feed_items UNION SELECT source FROM feed_pulls) s
      ORDER BY s.source`,
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

// ---------------------------------------------------------------------------
// Change history and cross-source links. Additive: nothing above reads these.
// ---------------------------------------------------------------------------
import type { ChangeKind } from '../domain/collect.ts';

export interface ItemVersion {
  id: string;
  itemId: string;
  changeKind: ChangeKind;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  contentHash: string | null;
  observedAt: string;
}

/** Append one observed change to an item's history. History is never rewritten. */
export async function recordItemVersion(input: {
  itemId: string;
  changeKind: ChangeKind;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  contentHash?: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO feed_item_versions (id, item_id, change_kind, field, old_value, new_value, content_hash, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('fiv'), input.itemId, input.changeKind, input.field ?? null, input.oldValue ?? null,
      input.newValue ?? null, input.contentHash ?? null, nowIso()],
  );
}

export async function itemVersions(itemId: string): Promise<ItemVersion[]> {
  const rows = await getDb().all<{
    id: string; item_id: string; change_kind: string; field: string | null; old_value: string | null;
    new_value: string | null; content_hash: string | null; observed_at: string;
  }>('SELECT * FROM feed_item_versions WHERE item_id = ? ORDER BY observed_at, id', [itemId]);
  return rows.map((r) => ({
    id: r.id, itemId: r.item_id, changeKind: r.change_kind as ChangeKind, field: r.field, oldValue: r.old_value,
    newValue: r.new_value, contentHash: r.content_hash, observedAt: r.observed_at,
  }));
}

/** Say that one stored item was delivered by this source too. Idempotent; a repeat only moves last-seen. */
export async function linkItemSource(itemId: string, source: string, externalId: string): Promise<void> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO feed_item_sources (item_id, source, external_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (item_id, source, external_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [itemId, source, externalId, at, at],
  );
}

export async function itemSources(itemId: string): Promise<{ source: string; externalId: string }[]> {
  const rows = await getDb().all<{ source: string; external_id: string }>(
    'SELECT source, external_id FROM feed_item_sources WHERE item_id = ? ORDER BY source, external_id', [itemId],
  );
  return rows.map((r) => ({ source: r.source, externalId: r.external_id }));
}
