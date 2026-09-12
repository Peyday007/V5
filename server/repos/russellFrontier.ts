/**
 * The frontier's rows.
 *
 * A frontier item is a *derived* reading that is remembered, which is an
 * unusual shape for this codebase and is deliberate. Everything about a
 * project's edges can be re-derived from knowledge, layers, audit gaps and
 * candidates — so the table is not a second store of what the project knows.
 * It exists for the two things a pure derivation cannot do: remember that an
 * area was on the frontier and stopped being, and hold a person's statement
 * that an area is deliberately not required.
 *
 * The write is an insert guarded on the fingerprint followed by a touch, so two
 * passes over one project cannot both insert the same item.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  FrontierRegion,
  FrontierSourceKind,
  RussellFrontierItem,
  RussellFrontierRow,
  RussellVisibility,
} from '../domain/types.ts';

function map(row: RussellFrontierRow): RussellFrontierItem {
  return {
    id: row.id,
    projectId: row.project_id,
    region: row.region as FrontierRegion,
    subject: row.subject,
    detail: row.detail,
    sourceKind: row.source_kind as FrontierSourceKind,
    sourceId: row.source_id,
    lens: row.lens,
    fingerprint: row.fingerprint,
    visibility: row.visibility as RussellVisibility,
    dismissedAt: row.dismissed_at,
    dismissedByUserId: row.dismissed_by_user_id,
    dismissedReason: row.dismissed_reason,
    resolvedAt: row.resolved_at,
    version: row.version,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * The identity of one reading.
 *
 * Deterministic over the things that make two readings the same reading. The
 * subject is included because one layer can produce several items — an
 * unexamined region and an open question about the same layer are different
 * facts and must not collide.
 */
export function frontierFingerprint(input: {
  region: FrontierRegion;
  sourceKind: FrontierSourceKind;
  sourceId: string | null;
  subject: string;
}): string {
  return createHash('sha256')
    .update(
      [
        input.region,
        input.sourceKind,
        input.sourceId ?? '',
        input.subject.trim().toLowerCase(),
      ].join(' '),
    )
    .digest('hex');
}

export interface FrontierUpsert {
  projectId: string;
  region: FrontierRegion;
  subject: string;
  detail?: string | null;
  sourceKind: FrontierSourceKind;
  sourceId?: string | null;
  lens?: string | null;
  visibility?: RussellVisibility;
}

/**
 * Record that this reading is currently true.
 *
 * Insert-or-touch: a new item is written with both timestamps, and one that is
 * already there has its `last_seen_at` moved and any previous resolution
 * cleared — because a region that was settled and has become weak again is the
 * same item coming back, not a new one. `first_seen_at` never moves, so "this
 * has been open since March" stays answerable.
 */
export async function observeFrontierItem(input: FrontierUpsert): Promise<void> {
  const now = nowIso();
  const fingerprint = frontierFingerprint({
    region: input.region,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId ?? null,
    subject: input.subject,
  });
  const db = getDb();
  await db.run(
    `INSERT INTO russell_frontier
       (id, project_id, region, subject, detail, source_kind, source_id, lens,
        fingerprint, visibility, version, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (project_id, fingerprint) DO NOTHING`,
    [
      newId('rfr'),
      input.projectId,
      input.region,
      input.subject,
      input.detail ?? null,
      input.sourceKind,
      input.sourceId ?? null,
      input.lens ?? null,
      fingerprint,
      input.visibility ?? 'SHARED',
      now,
      now,
    ],
  );
  await db.run(
    `UPDATE russell_frontier
        SET last_seen_at = ?, resolved_at = NULL, detail = ?, subject = ?
      WHERE project_id = ? AND fingerprint = ?`,
    [now, input.detail ?? null, input.subject, input.projectId, fingerprint],
  );
}

/**
 * Everything not observed in this pass has stopped being true.
 *
 * Resolved rather than deleted: §11's rule is that an explicit unknown must not
 * become a silent dark spot, and a delete makes one look like progress.
 *
 * **The pass is identified by a time, not by a list of what it saw.** The
 * obvious implementation is `fingerprint NOT IN (…)`, and it is wrong for a
 * reason that only appears on a project big enough to matter: SQLite refuses a
 * statement with more than 999 bound parameters by default, so a frontier of a
 * thousand items would start throwing — on the largest projects, which are
 * exactly the ones whose edges are worth reading. `observeFrontierItem` stamps
 * every item it sees with the same `now`, so "not seen in this pass" is
 * `last_seen_at < startedAt`, which is one parameter however many items there
 * are.
 */
export async function resolveUnseenFrontierItems(input: {
  projectId: string;
  /** When the pass began. Everything observed since carries a later stamp. */
  startedAt: string;
  at?: string;
}): Promise<number> {
  const result = await getDb().run(
    `UPDATE russell_frontier
        SET resolved_at = ?
      WHERE project_id = ?
        AND resolved_at IS NULL
        AND last_seen_at < ?`,
    [input.at ?? nowIso(), input.projectId, input.startedAt],
  );
  return result.changes;
}

export async function listFrontier(input: {
  projectId: string;
  includeResolved?: boolean;
  includePrivate?: boolean;
  limit?: number;
}): Promise<RussellFrontierItem[]> {
  const rows = await getDb().all<RussellFrontierRow>(
    `SELECT * FROM russell_frontier
      WHERE project_id = ?
        ${input.includeResolved ? '' : 'AND resolved_at IS NULL'}
        AND (visibility = 'SHARED' OR ? = 1)
      ORDER BY region, last_seen_at DESC
      LIMIT ?`,
    [input.projectId, input.includePrivate ? 1 : 0, Math.min(1000, input.limit ?? 400)],
  );
  return rows.map(map);
}

/**
 * A person saying an area is deliberately not required.
 *
 * Attributed and reasoned. It is reversible by passing `dismissed: false`,
 * because a judgment about scope is exactly the kind that changes — and a
 * decision with no way back is the escalation-with-no-answering-transition
 * defect at the smallest possible scale.
 */
export async function dismissFrontierItem(input: {
  id: string;
  projectId: string;
  userId: string;
  reason: string;
  dismissed: boolean;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE russell_frontier
        SET dismissed_at = ?, dismissed_by_user_id = ?, dismissed_reason = ?
      WHERE id = ? AND project_id = ?`,
    [
      input.dismissed ? nowIso() : null,
      input.dismissed ? input.userId : null,
      input.dismissed ? input.reason : null,
      input.id,
      input.projectId,
    ],
  );
  return result.changes > 0;
}
