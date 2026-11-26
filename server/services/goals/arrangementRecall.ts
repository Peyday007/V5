/**
 * A goal's constructed arrangements read back from the library when this
 * pass could not compose them (OPP-04 repair, episode 2, finding F3).
 *
 * `readGoalPlan` degraded a failed construction to no arrangements at all, so
 * a goal whose model is refused — every arrangement it holds unpriced — read
 * no pathway, and probe r01.opp-04 reported "none has a pathway" exactly as
 * before the partial-pathway repair. What construction composed for this goal
 * on an earlier pass is already durable (`rememberArrangements`, K-1): the
 * library rows this goal first composed or last weighed. Those are this goal's
 * own designs, so reading them back is the same search, not a new one; the
 * plan still says construction failed (C-13) and the next pass composes again,
 * because nothing recovered here is held as a fresh composition.
 *
 * Read through the library's own reader (`constructedArrangementsByIds`), one
 * bounded statement for the ids: no second store and no second writer.
 */
import { getDb } from '../../db/database.ts';
import { constructedArrangementsByIds } from '../../repos/monetization.ts';
import { namesABuyerPopulation } from '../../domain/industry.ts';
import type { ConstructedArrangementRecord } from '../../domain/types.ts';
import type { ConstructedArrangement } from '../cash/construct.ts';

/** The most designs one recovery reads: the newest this goal composed or weighed. */
export const RECALL_LIMIT = 200;

/**
 * The stored design of one library row as a constructed arrangement, or null
 * when the row does not carry one a reader can use. Pure.
 */
export function arrangementOfRecord(record: Pick<ConstructedArrangementRecord, 'design' | 'signature' | 'inputsDigest' | 'legacyKey'>): ConstructedArrangement | null {
  const stored = (record.design as { arrangement?: unknown } | null)?.arrangement;
  if (!stored || typeof stored !== 'object') return null;
  const one = stored as Partial<ConstructedArrangement>;
  if (typeof one.key !== 'string' || typeof one.label !== 'string' || typeof one.structure !== 'string') return null;
  if (!one.design || typeof one.design !== 'object' || !one.demand || typeof one.demand.name !== 'string') return null;
  // A row stored before a field a reader walks existed is not readable as this goal's design: it is left for the next composition.
  if (!Array.isArray(one.unknownParts) || !Array.isArray(one.relatedOpenings) || typeof one.question !== 'string' || !one.stress || !one.value) return null;
  if (!namesABuyerPopulation(one.demand.name)) return null;
  return {
    ...(one as ConstructedArrangement),
    signature: one.signature ?? (record.signature || undefined),
    inputsDigest: one.inputsDigest ?? (record.inputsDigest || undefined),
  } as ConstructedArrangement;
}

/** The arrangements this goal composed or was last weighed against, newest first, deduplicated by key. */
export async function recalledGoalArrangements(projectId: string, goalId: string, limit: number = RECALL_LIMIT): Promise<ConstructedArrangement[]> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM monetization_paths
      WHERE project_id = ? AND design_signature IS NOT NULL
        AND (first_goal_id = ? OR last_evaluation_goal_id = ?)
      ORDER BY COALESCE(last_composed_at, created_at) DESC, id
      LIMIT ?`,
    [projectId, goalId, goalId, limit],
  );
  if (rows.length === 0) return [];
  const order = new Map(rows.map((row, at) => [row.id, at]));
  const records = (await constructedArrangementsByIds(rows.map((row) => row.id))).sort((a, b) => (order.get(a.pathId) ?? 0) - (order.get(b.pathId) ?? 0));
  const seen = new Set<string>();
  const out: ConstructedArrangement[] = [];
  for (const record of records) {
    const one = arrangementOfRecord(record);
    if (!one || seen.has(one.key)) continue;
    seen.add(one.key);
    out.push(one);
  }
  return out;
}
