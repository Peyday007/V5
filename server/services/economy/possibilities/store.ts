/**
 * Keeping possibilities, screening them in code, and reconsidering exactly the
 * ones a change affects. Persistence is `repos/economy.ts`; nothing here
 * scans every possibility, researches to keep one warm, or reads another
 * owner's rows.
 */
import { getDb } from '../../../db/database.ts';
import { parseJson } from '../../../repos/util.ts';
import {
  keepPossibility, listPossibilities, possibilityEdgesOf, triggerCondition, watchCondition, watchersOf,
} from '../../../repos/economy.ts';
import type {
  Possibility, PossibilityKind, PossibilityRequirements,
} from '../../../domain/economy.ts';
import {
  reachOf, researchNext, screenPossibility, type GoalLimits, type ScreenResult,
} from './screen.ts';

/** Machines never keep, reconsider or share a person's possibilities. */
export interface Actor { type: 'PERSON' | 'WORKER'; userId: string }

export function requirePerson(actor: Actor, ownerUserId: string): void {
  if (actor.type !== 'PERSON' || actor.userId !== ownerUserId) {
    throw new Error('There is nothing here for you to see.');
  }
}

export async function keepScreened(input: {
  actor: Actor; projectId: string; ownerUserId: string; kind: PossibilityKind; title: string;
  requirements: PossibilityRequirements; sourceRef?: string | null; limits: GoalLimits;
}): Promise<{ possibility: Possibility; screen: ScreenResult; created: boolean }> {
  requirePerson(input.actor, input.ownerUserId);
  const screen = screenPossibility(input.requirements, input.limits);
  const { possibility, created } = await keepPossibility({
    projectId: input.projectId, ownerUserId: input.ownerUserId, kind: input.kind,
    title: input.title, requirements: input.requirements, sourceRef: input.sourceRef ?? null,
    parkedReason: screen.verdict === 'ADVANCE' ? null : screen.reasons.join(' '),
  });
  for (const key of screen.watch) {
    await watchCondition({ projectId: input.projectId, possibilityId: possibility.id, conditionKey: key });
  }
  return { possibility, screen, created };
}

export interface Reconsideration {
  /** Watch rows read: the cost of the change, independent of how many possibilities exist. */
  rowsTouched: number;
  reconsidered: { possibilityId: string; screen: ScreenResult }[];
  /** Watches left standing because the change did not clear the limit. */
  stillBlocked: string[];
}

/**
 * A change happened (capital changed, price changed, ...). Read the watchers of
 * that one key by index, re-screen only those against the new limits, and
 * trigger the watches that are now met, once each.
 */
export async function reconsiderOnChange(input: {
  projectId: string; ownerUserId: string; conditionKey: string; changeRef: string; limits: GoalLimits;
}): Promise<Reconsideration> {
  const watchers = await watchersOf(input.projectId, input.conditionKey);
  const result: Reconsideration = { rowsTouched: watchers.length, reconsidered: [], stillBlocked: [] };
  if (watchers.length === 0) return result;
  const ids = [...new Set(watchers.map((w) => w.possibilityId))];
  const rows = await getDb().all<{ id: string; requirements: string }>(
    `SELECT id, requirements FROM possibilities
      WHERE project_id = ? AND owner_user_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    [input.projectId, input.ownerUserId, ...ids],
  );
  const reqs = new Map(rows.map((r) => [r.id, parseJson<PossibilityRequirements>(r.requirements, {})]));
  for (const watch of watchers) {
    const requirements = reqs.get(watch.possibilityId);
    if (!requirements) continue; // another owner's: never read, never touched
    const screen = screenPossibility(requirements, input.limits);
    if (screen.watch.includes(input.conditionKey)) {
      result.stillBlocked.push(watch.possibilityId);
      continue;
    }
    if (await triggerCondition(watch.id, input.changeRef)) {
      result.reconsidered.push({ possibilityId: watch.possibilityId, screen });
    }
  }
  return result;
}

/** Own possibilities plus other owners' possibilities marked general. */
export async function visiblePossibilities(
  actor: Actor, projectId: string, ownerUserId: string,
): Promise<Possibility[]> {
  requirePerson(actor, ownerUserId);
  return listPossibilities(projectId, ownerUserId);
}

export interface ResearchOrder {
  /** Researchable now, strongest reach first. */
  next: { possibilityId: string; title: string; reach: number }[];
  /** Zero-reach candidates passed over because a stronger one is still open. */
  passedOver: { possibilityId: string; title: string }[];
}

/**
 * What one person should research next among their own kept possibilities,
 * read from the stored graph rather than handed in: the reach ordering of
 * `researchNext` over the owner's rows and the owner's edges only.
 */
export async function researchOrder(input: {
  actor: Actor; projectId: string; ownerUserId: string; explored?: ReadonlySet<string>;
}): Promise<ResearchOrder> {
  requirePerson(input.actor, input.ownerUserId);
  const [possibilities, edges] = await Promise.all([
    listPossibilities(input.projectId, input.ownerUserId),
    possibilityEdgesOf(input.projectId, input.ownerUserId),
  ]);
  const explored = input.explored ?? new Set<string>();
  const byId = new Map(possibilities.map((p) => [p.id, p]));
  const nextIds = researchNext(possibilities, edges, explored);
  const chosen = new Set(nextIds);
  return {
    next: nextIds.map((id) => ({ possibilityId: id, title: byId.get(id)!.title, reach: reachOf(id, edges) })),
    passedOver: possibilities
      .filter((p) => !explored.has(p.id) && !chosen.has(p.id))
      .map((p) => ({ possibilityId: p.id, title: p.title })),
  };
}
