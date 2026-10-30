/**
 * Keeping a possibility, and reconsidering exactly the ones a change affects.
 *
 * Nothing here launches research. A reconsideration is an indexed read of the
 * watches for one change key, a guarded trigger per watch, and a re-screen of
 * the possibilities those watches belong to — never a scan of the store.
 */
import { getDb } from '../../../db/database.ts';
import { nowIso } from '../../../repos/util.ts';
import {
  keepPossibility, triggerCondition, watchCondition, watchersOf,
} from '../../../repos/economy.ts';
import type { Possibility, PossibilityKind, PossibilityRequirements } from '../../../domain/economy.ts';
import { codeScreen } from './screen.ts';
import type { GoalLimits, Screen, ScreenResult } from './screen.ts';

interface Row { [key: string]: unknown }

async function loadPossibility(id: string, projectId: string): Promise<Possibility | null> {
  const r = await getDb().get<Row>(
    'SELECT * FROM possibilities WHERE id = ? AND project_id = ?', [id, projectId]);
  if (!r) return null;
  return {
    id: r['id'] as string, projectId: r['project_id'] as string, ownerUserId: r['owner_user_id'] as string,
    kind: r['kind'] as PossibilityKind, title: r['title'] as string,
    requirements: JSON.parse(r['requirements'] as string) as PossibilityRequirements,
    sourceRef: (r['source_ref'] as string | null) ?? null,
    parkedReason: (r['parked_reason'] as string | null) ?? null,
    shared: Number(r['shared']) === 1, createdAt: r['created_at'] as string, updatedAt: r['updated_at'] as string,
  };
}

async function park(p: Possibility, screen: ScreenResult): Promise<void> {
  await getDb().run(
    'UPDATE possibilities SET parked_reason = ?, updated_at = ? WHERE id = ?',
    [screen.verdict === 'PASS' ? null : screen.reason, nowIso(), p.id]);
  for (const key of screen.reopenOn) {
    await watchCondition({ projectId: p.projectId, possibilityId: p.id, conditionKey: key });
  }
}

/** Screens in code, keeps the possibility whatever the verdict, and watches what would reopen it. */
export async function keepScreened(input: {
  projectId: string; ownerUserId: string; kind: PossibilityKind; title: string;
  requirements: PossibilityRequirements; sourceRef?: string | null;
  limits: GoalLimits; screen?: Screen;
}): Promise<{ possibility: Possibility; created: boolean; screen: ScreenResult; deepJobsLaunched: 0 }> {
  const { possibility, created } = await keepPossibility(input);
  const result = (input.screen ?? codeScreen)(possibility, input.limits);
  await park(possibility, result);
  return { possibility: (await loadPossibility(possibility.id, input.projectId))!, created, screen: result, deepJobsLaunched: 0 };
}

export interface Reconsideration {
  /** Watch rows read for this change: the cost of the pass. */
  rowsTouched: number;
  reopened: { possibilityId: string; screen: ScreenResult }[];
  stillParked: { possibilityId: string; screen: ScreenResult }[];
}

/**
 * One change (capital changed, goal achieved, capability acquired, price
 * changed, relationship discovered) reconsiders the watchers of its key, for
 * its owner only. A replay of the same change ref triggers nothing twice.
 */
export async function reconsiderOnChange(input: {
  projectId: string; ownerUserId: string; key: string; changeRef: string;
  limits: GoalLimits; screen?: Screen;
}): Promise<Reconsideration> {
  const out: Reconsideration = { rowsTouched: 0, reopened: [], stillParked: [] };
  const screen = input.screen ?? codeScreen;
  for (const watch of await watchersOf(input.projectId, input.key)) {
    const p = await loadPossibility(watch.possibilityId, input.projectId);
    out.rowsTouched += 1;
    if (!p || p.ownerUserId !== input.ownerUserId) continue;
    if (!(await triggerCondition(watch.id, input.changeRef))) continue;
    const result = screen(p, input.limits);
    await park(p, result);
    (result.verdict === 'PASS' ? out.reopened : out.stillParked).push({ possibilityId: p.id, screen: result });
  }
  return out;
}
