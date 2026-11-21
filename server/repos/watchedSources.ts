/**
 * Watched sources and the changes seen on them (§65; migration 159).
 *
 * Two rules live here, in the statements:
 *
 *  - **A read is applied only forward** (invariant 32). `applyRead` moves a
 *    source's position (`fetched_at`) and its hash only when the read is newer
 *    than the position and started from the hash the caller read, in the one
 *    UPDATE that makes the change. A late, older read changes nothing; the
 *    same read delivered twice lands once, and its change row is unique by
 *    `(watched_source_id, fetched_at)` besides.
 *  - **A change row is append-only.** It is written once, in the transaction
 *    whose UPDATE landed, and never updated or deleted.
 *
 * Nothing here writes a fact, a claim or a card field. A change asks for a
 * re-read; the research pipeline and the claim gate decide what it says.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { parseBlockerKey } from '../domain/types.ts';
import type {
  BlockerKey,
  SourceChange,
  SourceChangeRow,
  WatchedSource,
  WatchedSourceRow,
} from '../domain/types.ts';

/** The shortest interval a watch may ask for: a page is not polled harder than this. */
export const MIN_CHECK_INTERVAL_MINUTES = 60;
export const DEFAULT_CHECK_INTERVAL_MINUTES = 360;

function mapSource(row: WatchedSourceRow): WatchedSource {
  return {
    id: row.id,
    projectId: row.project_id,
    url: row.url,
    reason: row.reason,
    blockerKey: parseBlockerKey(row.blocker_key),
    checkIntervalMinutes: Number(row.check_interval_minutes),
    etag: row.etag,
    lastModified: row.last_modified,
    bodyHash: row.body_hash,
    textHash: row.text_hash,
    lastText: row.last_text,
    fetchedAt: row.fetched_at,
    nextCheckAt: row.next_check_at,
    lastError: row.last_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChange(row: SourceChangeRow): SourceChange {
  return {
    id: row.id,
    projectId: row.project_id,
    watchedSourceId: row.watched_source_id,
    url: row.url,
    blockerKey: parseBlockerKey(row.blocker_key),
    oldHash: row.old_hash,
    newHash: row.new_hash,
    previousFetchedAt: row.previous_fetched_at,
    fetchedAt: row.fetched_at,
    diffExcerpt: row.diff_excerpt,
    rereadCandidateId: row.reread_candidate_id,
    createdAt: row.created_at,
  };
}

/**
 * Start watching a page, or read back the watch that already holds it.
 * One watch per (project, URL); a second call changes nothing.
 */
export async function watchSource(input: {
  projectId: string;
  url: string;
  reason: string;
  blockerKey?: BlockerKey | null;
  checkIntervalMinutes?: number;
  createdBy: string;
  at?: string;
}): Promise<{ source: WatchedSource; created: boolean }> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('A watch says why the page is watched.');
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new Error('A watched source is a URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('A watched source is an http(s) URL.');
  if (url.username || url.password) throw new Error('A watched source carries no credentials in its URL.');
  const key = input.blockerKey ?? null;
  if (key !== null && parseBlockerKey(key) === null) throw new Error('The blocker key is malformed.');
  const interval = Math.max(MIN_CHECK_INTERVAL_MINUTES, Math.round(input.checkIntervalMinutes ?? DEFAULT_CHECK_INTERVAL_MINUTES));
  const at = input.at ?? nowIso();
  const id = newId('wsrc');
  const result = await getDb().run(
    `INSERT INTO watched_sources
       (id, project_id, url, reason, blocker_key, check_interval_minutes, etag, last_modified,
        body_hash, text_hash, last_text, fetched_at, next_check_at, last_error, created_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.projectId, url.toString(), reason.slice(0, 1000), key, interval, at, input.createdBy, at, at],
  );
  const rows = await getDb().all<WatchedSourceRow>(
    'SELECT * FROM watched_sources WHERE project_id = ? AND url = ?',
    [input.projectId, url.toString()],
  );
  if (!rows[0]) throw new Error('The watched source disappeared immediately after being written.');
  return { source: mapSource(rows[0]), created: result.changes === 1 };
}

export async function getWatchedSource(id: string): Promise<WatchedSource | null> {
  const rows = await getDb().all<WatchedSourceRow>('SELECT * FROM watched_sources WHERE id = ?', [id]);
  return rows[0] ? mapSource(rows[0]) : null;
}

export async function watchedSourcesFor(projectId: string): Promise<WatchedSource[]> {
  const rows = await getDb().all<WatchedSourceRow>(
    'SELECT * FROM watched_sources WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapSource);
}

/** One project's watches whose next check is due, oldest due first, bounded. */
export async function dueWatchedSources(projectId: string, now: string, limit: number): Promise<WatchedSource[]> {
  const rows = await getDb().all<WatchedSourceRow>(
    'SELECT * FROM watched_sources WHERE project_id = ? AND next_check_at <= ? ORDER BY next_check_at, id LIMIT ?',
    [projectId, now, limit],
  );
  return rows.map(mapSource);
}

/** The blocker keys watched sources in one project name: these keys alone are detected (§65). */
export async function watchedBlockerKeys(projectId: string): Promise<Set<string>> {
  const rows = await getDb().all<{ blocker_key: string }>(
    'SELECT DISTINCT blocker_key FROM watched_sources WHERE project_id = ? AND blocker_key IS NOT NULL',
    [projectId],
  );
  return new Set(rows.map((row) => row.blocker_key));
}

/** What a read saw, for `applyRead`. */
export interface ReadApplied {
  etag: string | null;
  lastModified: string | null;
  bodyHash: string | null;
  textHash: string;
  text: string;
  fetchedAt: string;
  nextCheckAt: string;
}

/**
 * Move a source to a read, guarded: only if the read is newer than the
 * source's position and the source still holds `fromHash` (null for the first
 * read). True when this call's UPDATE landed.
 */
export async function applyRead(sourceId: string, fromHash: string | null, read: ReadApplied): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE watched_sources
        SET etag = ?, last_modified = ?, body_hash = ?, text_hash = ?, last_text = ?,
            fetched_at = ?, next_check_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
        AND (fetched_at IS NULL OR fetched_at < ?)
        AND ${fromHash === null ? 'text_hash IS NULL' : 'text_hash = ?'}`,
    [
      read.etag,
      read.lastModified,
      read.bodyHash,
      read.textHash,
      read.text,
      read.fetchedAt,
      read.nextCheckAt,
      read.fetchedAt,
      sourceId,
      read.fetchedAt,
      ...(fromHash === null ? [] : [fromHash]),
    ],
  );
  return result.changes === 1;
}

/**
 * A read that saw no change in the text: refresh the validators and the
 * schedule, still only forward. The hash and the text are not touched.
 */
export async function applyUnchangedRead(
  sourceId: string,
  read: { etag: string | null; lastModified: string | null; bodyHash: string | null; fetchedAt: string; nextCheckAt: string },
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE watched_sources
        SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
            body_hash = COALESCE(?, body_hash), fetched_at = ?, next_check_at = ?,
            last_error = NULL, updated_at = ?
      WHERE id = ? AND (fetched_at IS NULL OR fetched_at < ?)`,
    [read.etag, read.lastModified, read.bodyHash, read.fetchedAt, read.nextCheckAt, read.fetchedAt, sourceId, read.fetchedAt],
  );
  return result.changes === 1;
}

/** A failed read: the error and the next attempt. Position and hash are untouched. */
export async function recordReadFailure(sourceId: string, error: string, nextCheckAt: string, at: string): Promise<void> {
  await getDb().run(
    'UPDATE watched_sources SET last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?',
    [error.slice(0, 300), nextCheckAt, at, sourceId],
  );
}

/** Append one change row. Only ever called in the transaction whose `applyRead` landed. */
export async function insertSourceChange(input: Omit<SourceChange, 'id' | 'createdAt'> & { at: string }): Promise<SourceChange | null> {
  const id = newId('schg');
  const result = await getDb().run(
    `INSERT INTO source_changes
       (id, project_id, watched_source_id, url, blocker_key, old_hash, new_hash,
        previous_fetched_at, fetched_at, diff_excerpt, reread_candidate_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.watchedSourceId,
      input.url,
      input.blockerKey,
      input.oldHash,
      input.newHash,
      input.previousFetchedAt,
      input.fetchedAt,
      input.diffExcerpt,
      input.rereadCandidateId,
      input.at,
    ],
  );
  if (result.changes !== 1) return null;
  const rows = await getDb().all<SourceChangeRow>('SELECT * FROM source_changes WHERE id = ?', [id]);
  return rows[0] ? mapChange(rows[0]) : null;
}

export async function sourceChangesFor(watchedSourceId: string): Promise<SourceChange[]> {
  const rows = await getDb().all<SourceChangeRow>(
    'SELECT * FROM source_changes WHERE watched_source_id = ? ORDER BY fetched_at, id',
    [watchedSourceId],
  );
  return rows.map(mapChange);
}

/**
 * Keyed changes in one project recorded at or after `since` (all of them when
 * null), oldest first, bounded: what the reconsideration pass consumes.
 */
export async function keyedSourceChangesSince(projectId: string, since: string | null, limit = 500): Promise<SourceChange[]> {
  const rows = await getDb().all<SourceChangeRow>(
    `SELECT * FROM source_changes
      WHERE project_id = ? AND blocker_key IS NOT NULL${since ? ' AND created_at >= ?' : ''}
      ORDER BY created_at, id LIMIT ?`,
    since ? [projectId, since, limit] : [projectId, limit],
  );
  return rows.map(mapChange);
}
