/**
 * The source registry and its checkpoints.
 *
 * A source with no project is public to all; one with a project is read only by
 * that project. The filter is in the statement. Robots/terms status is recorded
 * with when it was checked, and a source that is not ALLOWED is never due.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { SOURCE_KINDS, ROBOTS_STATUSES } from '../domain/collect.ts';
import type { CollectCheckpoint, CollectSource, RobotsStatus, SourceKind } from '../domain/collect.ts';

interface Row {
  id: string; project_id: string | null; slug: string; label: string; kind: string; url_template: string;
  pagination: string | null; parser_id: string; interval_ms: number; host_rate_per_min: number | null;
  robots_status: string; robots_checked_at: string | null; robots_note: string | null; enabled: number;
  created_at: string; updated_at: string;
}

const map = (r: Row): CollectSource => ({
  id: r.id, projectId: r.project_id, slug: r.slug, label: r.label, kind: r.kind as SourceKind,
  urlTemplate: r.url_template, pagination: r.pagination, parserId: r.parser_id, intervalMs: r.interval_ms,
  hostRatePerMin: r.host_rate_per_min, robotsStatus: r.robots_status as RobotsStatus,
  robotsCheckedAt: r.robots_checked_at, robotsNote: r.robots_note, enabled: r.enabled === 1,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export interface NewCollectSource {
  projectId?: string | null;
  slug: string;
  label: string;
  kind: SourceKind;
  urlTemplate: string;
  pagination?: string | null;
  parserId: string;
  intervalMs: number;
  hostRatePerMin?: number | null;
}

/** Adding a source of an existing kind is this insert, and nothing else. Idempotent by slug. */
export async function addCollectSource(input: NewCollectSource): Promise<CollectSource> {
  if (!SOURCE_KINDS.includes(input.kind)) throw new Error(`"${input.kind}" is not a source kind.`);
  if (!Number.isInteger(input.intervalMs) || input.intervalMs <= 0) throw new Error('A pull interval is a positive number of milliseconds.');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO collect_sources
       (id, project_id, slug, label, kind, url_template, pagination, parser_id, interval_ms, host_rate_per_min,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO NOTHING`,
    [newId('csr'), input.projectId ?? null, input.slug, input.label, input.kind, input.urlTemplate,
      input.pagination ?? null, input.parserId, input.intervalMs, input.hostRatePerMin ?? null, at, at],
  );
  const found = await getDb().get<Row>('SELECT * FROM collect_sources WHERE slug = ?', [input.slug]);
  if (!found) throw new Error('The source disappeared immediately after being written.');
  return map(found);
}

/** Public sources plus the viewer's own project's; another project's are not returned. */
export async function listCollectSources(viewerProjectId: string | null): Promise<CollectSource[]> {
  const rows = await getDb().all<Row>(
    'SELECT * FROM collect_sources WHERE project_id IS NULL OR project_id = ? ORDER BY slug',
    [viewerProjectId],
  );
  return rows.map(map);
}

export async function setRobotsStatus(id: string, status: RobotsStatus, note: string | null): Promise<void> {
  if (!ROBOTS_STATUSES.includes(status)) throw new Error(`"${status}" is not a robots status.`);
  const at = nowIso();
  await getDb().run(
    'UPDATE collect_sources SET robots_status = ?, robots_checked_at = ?, robots_note = ?, updated_at = ? WHERE id = ?',
    [status, at, note, at, id],
  );
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  await getDb().run('UPDATE collect_sources SET enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, nowIso(), id]);
}

export async function getCheckpoint(sourceId: string): Promise<CollectCheckpoint | null> {
  const r = await getDb().get<{
    source_id: string; cursor: string | null; etag: string | null; last_modified: string | null;
    content_hash: string | null; updated_at: string;
  }>('SELECT * FROM collect_checkpoints WHERE source_id = ?', [sourceId]);
  return r
    ? { sourceId: r.source_id, cursor: r.cursor, etag: r.etag, lastModified: r.last_modified, contentHash: r.content_hash, updatedAt: r.updated_at }
    : null;
}

/** Replace the one live checkpoint for a source. */
export async function saveCheckpoint(
  sourceId: string,
  patch: { cursor?: string | null; etag?: string | null; lastModified?: string | null; contentHash?: string | null },
): Promise<void> {
  const prev = await getCheckpoint(sourceId);
  const next = {
    cursor: patch.cursor !== undefined ? patch.cursor : prev?.cursor ?? null,
    etag: patch.etag !== undefined ? patch.etag : prev?.etag ?? null,
    lastModified: patch.lastModified !== undefined ? patch.lastModified : prev?.lastModified ?? null,
    contentHash: patch.contentHash !== undefined ? patch.contentHash : prev?.contentHash ?? null,
  };
  await getDb().run(
    `INSERT INTO collect_checkpoints (source_id, cursor, etag, last_modified, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET cursor = excluded.cursor, etag = excluded.etag,
       last_modified = excluded.last_modified, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
    [sourceId, next.cursor, next.etag, next.lastModified, next.contentHash, nowIso()],
  );
}
