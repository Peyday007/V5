/**
 * Keeping possibilities, screening them in code, and reconsidering exactly the
 * ones a change affects. Persistence is `repos/economy.ts`; nothing here
 * scans every possibility, researches to keep one warm, or reads another
 * owner's rows.
 */
import { getDb } from '../../../db/database.ts';
import { parseJson } from '../../../repos/util.ts';
import {
  keepPossibility, listPossibilities, possibilityEdges, triggerCondition, watchCondition, watchersOf,
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

export interface ResearchQueueEntry {
  possibilityId: string;
  title: string;
  /** How many of the owner's other possibilities this one leads to. */
  reach: number;
}

export interface ResearchQueue {
  /** What may be researched next, strongest reach first. */
  next: ResearchQueueEntry[];
  /** Zero-reach candidates passed over because something stronger remains. */
  passedOver: ResearchQueueEntry[];
  /** Parked by the code screen: never offered for research until reconsidered. */
  parked: number;
}

/**
 * The research order over one owner's kept possibilities, read from the store.
 * Candidates are the ones the code screen advanced (not parked) and not yet
 * explored; reach is measured over that owner's own edges only. A zero-reach
 * candidate waits while any stronger one remains (`researchNext`).
 */
export async function researchQueue(input: {
  actor: Actor; projectId: string; ownerUserId: string; explored?: ReadonlySet<string>;
}): Promise<ResearchQueue> {
  requirePerson(input.actor, input.ownerUserId);
  const all = await listPossibilities(input.projectId, input.ownerUserId);
  const edges = await possibilityEdges(input.projectId, input.ownerUserId);
  const explored = input.explored ?? new Set<string>();
  const candidates = all.filter((p) => p.parkedReason === null);
  const byId = new Map(all.map((p) => [p.id, p]));
  const entry = (id: string): ResearchQueueEntry =>
    ({ possibilityId: id, title: byId.get(id)?.title ?? id, reach: reachOf(id, edges) });
  const nextIds = researchNext(candidates, edges, explored);
  const chosen = new Set(nextIds);
  return {
    next: nextIds.map(entry),
    passedOver: candidates.filter((p) => !explored.has(p.id) && !chosen.has(p.id)).map((p) => entry(p.id)),
    parked: all.length - candidates.length,
  };
}

/** Terminal lines for a research queue; prints what the store says, nothing composed. */
export function researchQueueLines(queue: ResearchQueue): string[] {
  const lines = [`  research    ${queue.next.length} next, ${queue.passedOver.length} passed over (zero reach while stronger remain), ${queue.parked} parked by the screen`];
  queue.next.forEach((e, i) => lines.push(`  next ${String(i + 1).padStart(3)}    ${e.possibilityId} reach=${e.reach}  ${e.title}`));
  for (const e of queue.passedOver) lines.push(`  waits       ${e.possibilityId} reach=0  ${e.title}`);
  return lines;
}
