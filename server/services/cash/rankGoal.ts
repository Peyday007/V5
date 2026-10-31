/**
 * Ranking read from the goal, not from a fixed list of preferences.
 *
 * Lexicographic over named criteria, in an order the goal sets: the first
 * criterion two opportunities differ on decides, and the explanation says which
 * and how. There is no score and no weight anywhere. An unknown never helps: on
 * every criterion a missing fact sorts after a known one, and a known violation
 * of the goal's own limits sorts after both on the fit criterion.
 *
 * What counts as achievable is only what `valueLayers.goalContribution` lets
 * count - the ledger, and realistic revenue that something sourced supports. An
 * advertised price, a market size or an unagreed commission is zero here, so a
 * large listing cannot outrank a small supported one by being large.
 *
 * Pure: the caller reads the rows and passes them in.
 */
import type { CashOpportunity } from '../../domain/types.ts';
import type { ValueLayerReading } from '../../domain/cashValueLayers.ts';
import type { TargetReading } from '../goals/target.ts';
import { goalContribution } from './valueLayers.ts';
import { listValueLayers } from '../../repos/cashValueLayers.ts';
import { listWorkstreams } from '../../repos/register.ts';
import { readTarget } from '../goals/target.ts';

export type RankGoal = Pick<TargetReading, 'metric' | 'targetCents' | 'daysLeft' | 'capitalCeilingCents' | 'capitalBeforeProofCents' | 'hoursCeiling' | 'currency'>;

export const RANK_CRITERIA = [
  'GOAL_FIT',
  'ACHIEVABLE_CONTRIBUTION',
  'TIME_TO_USABLE_CASH',
  'CAPITAL',
  'HOURS',
  'ACCESSIBILITY',
  'DEMAND_EVIDENCE',
  'DELIVERY',
  'DEPENDENCIES',
  'DOWNSIDE',
  'REPEATABILITY',
  'COMBINABILITY',
  'EVIDENCE_QUALITY',
] as const;
export type RankCriterion = (typeof RANK_CRITERIA)[number];

export interface RankInput {
  opportunity: CashOpportunity;
  readings: ValueLayerReading[];
  /** Whole days until money would be usable, when someone has established it. */
  daysToCash: number | null;
  /** Whether the same buyer or channel can be sold to again; null when unknown. */
  repeatable: boolean | null;
  /** Whether this can be run alongside others without competing for the same scarce input; null when unknown. */
  combinable: boolean | null;
}

export type Fit = 'FITS' | 'UNKNOWN' | 'MISFIT';

/** One entry's reading on every criterion. Lower `key` is better; `null` key means unknown (sorts last). */
interface Reading {
  key: number | null;
  words: string;
}

export interface RankedEntry {
  id: string;
  fit: Fit;
  countedCents: number;
  readings: Record<RankCriterion, Reading>;
}

const present = (r: ValueLayerReading | undefined): boolean => !!r && r.status !== 'UNKNOWN' && !!r.source;

function layer(readings: ValueLayerReading[], name: ValueLayerReading['layer']): ValueLayerReading | undefined {
  return readings.find((r) => r.layer === name);
}

/** Whether the opportunity's known facts break the goal's own limits. Unknown facts never do. */
export function fitOf(input: RankInput, goal: RankGoal): { fit: Fit; why: string } {
  const o = input.opportunity;
  const capital = o.peakFundingCents;
  if (capital !== null && goal.capitalCeilingCents !== null && capital > goal.capitalCeilingCents) {
    return { fit: 'MISFIT', why: 'needs more capital than the goal allows' };
  }
  if (capital !== null && goal.capitalBeforeProofCents !== null && capital > goal.capitalBeforeProofCents) {
    return { fit: 'MISFIT', why: 'needs more capital before proof than the goal allows' };
  }
  const timed = goal.metric === 'SETTLED_CASH' || goal.metric === 'COLLECTED_CASH';
  if (timed && goal.daysLeft !== null && input.daysToCash !== null && input.daysToCash > goal.daysLeft) {
    return { fit: 'MISFIT', why: 'would pay after the goal\'s deadline' };
  }
  const unknown = (capital === null && (goal.capitalCeilingCents !== null || goal.capitalBeforeProofCents !== null)) || (timed && goal.daysLeft !== null && input.daysToCash === null);
  return unknown ? { fit: 'UNKNOWN', why: 'a limit-relevant fact is not established' } : { fit: 'FITS', why: 'inside the goal\'s limits on what is known' };
}

export function readInput(input: RankInput, goal: RankGoal): RankedEntry {
  const o = input.opportunity;
  const { fit, why } = fitOf(input, goal);
  const contribution = goalContribution(input.readings, goal.currency);
  const supportedEvidence = [layer(input.readings, 'TRANSACTION_EVIDENCE'), layer(input.readings, 'BUYER_DEMAND'), layer(input.readings, 'ACCESSIBILITY')];
  const verified = input.readings.filter((r) => r.status === 'VERIFIED').length;
  const R = (key: number | null, words: string): Reading => ({ key, words });
  const readings: Record<RankCriterion, Reading> = {
    GOAL_FIT: R(fit === 'FITS' ? 0 : fit === 'UNKNOWN' ? 1 : 2, why),
    ACHIEVABLE_CONTRIBUTION: R(-contribution.countedCents, `${(contribution.countedCents / 100).toLocaleString('en-US')} counted toward the goal (${contribution.realisticReason})`),
    TIME_TO_USABLE_CASH: R(input.daysToCash, input.daysToCash === null ? 'time to usable cash is not established' : `usable cash in ${input.daysToCash} day(s)`),
    CAPITAL: R(o.peakFundingCents, o.peakFundingCents === null ? 'capital needed is not established' : `needs ${(o.peakFundingCents / 100).toLocaleString('en-US')} up front`),
    HOURS: R(o.humanHours, o.humanHours === null ? 'hours are not established' : `${o.humanHours} hour(s) of work`),
    ACCESSIBILITY: R(present(supportedEvidence[2]) ? 0 : null, present(supportedEvidence[2]) ? 'we can reach it, with a source' : 'access is not established'),
    DEMAND_EVIDENCE: R(present(supportedEvidence[0]) || present(supportedEvidence[1]) ? 0 : null, present(supportedEvidence[0]) || present(supportedEvidence[1]) ? 'there is sourced buyer or transaction evidence' : 'no sourced demand evidence'),
    DELIVERY: R((o.fulfillmentOwner ?? '').trim() || (o.deliveryMethod ?? '').trim() ? 0 : null, (o.fulfillmentOwner ?? '').trim() || (o.deliveryMethod ?? '').trim() ? 'a delivery path is named' : 'no delivery path is named'),
    DEPENDENCIES: R(o.dependsOnId ? 1 : 0, o.dependsOnId ? 'waits on another opportunity' : 'depends on nothing else'),
    DOWNSIDE: R(o.peakFundingCents, o.peakFundingCents === null ? 'downside is not established' : `at most ${(o.peakFundingCents / 100).toLocaleString('en-US')} at risk`),
    REPEATABILITY: R(input.repeatable === null ? null : input.repeatable ? 0 : 1, input.repeatable === null ? 'repeatability is not established' : input.repeatable ? 'repeatable' : 'one-off'),
    COMBINABILITY: R(input.combinable === null ? null : input.combinable ? 0 : 1, input.combinable === null ? 'combinability is not established' : input.combinable ? 'can run alongside others' : 'competes with others for a scarce input'),
    EVIDENCE_QUALITY: R(-verified, `${verified} VERIFIED layer(s)`),
  };
  return { id: o.id, fit, countedCents: contribution.countedCents, readings };
}

/**
 * The order the goal puts the criteria in. A goal with a deadline and a cash
 * metric cares about when usable cash arrives before how much; a goal with a
 * capital limit cares about capital before time; everything else keeps the
 * default order. Fit always comes first: nothing outranks a misfit by size.
 */
export function criteriaOrderFor(goal: RankGoal): RankCriterion[] {
  const timed = (goal.metric === 'SETTLED_CASH' || goal.metric === 'COLLECTED_CASH') && goal.daysLeft !== null;
  const tightCapital = goal.capitalCeilingCents !== null || goal.capitalBeforeProofCents !== null;
  let order = [...RANK_CRITERIA];
  const moveBefore = (c: RankCriterion, before: RankCriterion) => {
    order = order.filter((x) => x !== c);
    order.splice(order.indexOf(before), 0, c);
  };
  if (timed) moveBefore('TIME_TO_USABLE_CASH', 'ACHIEVABLE_CONTRIBUTION');
  if (tightCapital) moveBefore('CAPITAL', timed ? 'TIME_TO_USABLE_CASH' : 'ACHIEVABLE_CONTRIBUTION');
  return order;
}

function compareKeys(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // unknown sorts last
  if (b === null) return -1;
  return a - b;
}

export interface RankedOpportunity {
  id: string;
  rank: number;
  fit: Fit;
  countedCents: number;
  /** Which criterion put this above the next one, and in words; null for the last. */
  explanation: string | null;
}

/** Rank opportunities for one goal. Deterministic: ties fall to id. */
export function rankForGoal(items: RankInput[], goal: RankGoal): RankedOpportunity[] {
  const order = criteriaOrderFor(goal);
  const entries = items.map((i) => ({ i, e: readInput(i, goal) }));
  const decide = (a: RankedEntry, b: RankedEntry): { delta: number; by: RankCriterion | null } => {
    for (const c of order) {
      const d = compareKeys(a.readings[c].key, b.readings[c].key);
      if (d !== 0) return { delta: d, by: c };
    }
    return { delta: 0, by: null };
  };
  entries.sort((x, y) => decide(x.e, y.e).delta || (x.e.id < y.e.id ? -1 : x.e.id > y.e.id ? 1 : 0));
  return entries.map((x, idx) => {
    const next = entries[idx + 1];
    let explanation: string | null = null;
    if (next) {
      const { by } = decide(x.e, next.e);
      explanation = by
        ? `Ranks above the next on ${by.toLowerCase().replace(/_/g, ' ')}: ${x.e.readings[by].words}, against ${next.e.readings[by].words}. Nothing after that was consulted.`
        : 'Indistinguishable from the next on every criterion; ordered by id only.';
    }
    return { id: x.e.id, rank: idx + 1, fit: x.e.fit, countedCents: x.e.countedCents, explanation };
  });
}

/** A comparator for `portfolio.rank`: the goal's order over two opportunities with their inputs. */
export function goalComparator(inputs: Map<string, RankInput>, goal: RankGoal): (a: CashOpportunity, b: CashOpportunity) => number {
  const order = criteriaOrderFor(goal);
  const cache = new Map<string, RankedEntry>();
  const read = (o: CashOpportunity): RankedEntry | null => {
    const hit = cache.get(o.id);
    if (hit) return hit;
    const input = inputs.get(o.id);
    if (!input) return null;
    const e = readInput(input, goal);
    cache.set(o.id, e);
    return e;
  };
  return (a, b) => {
    const ea = read(a);
    const eb = read(b);
    if (!ea || !eb) return 0;
    for (const c of order) {
      const d = compareKeys(ea.readings[c].key, eb.readings[c].key);
      if (d !== 0) return d;
    }
    return 0;
  };
}

/**
 * The project's own goal as a ranking, or undefined when it has none.
 *
 * With several live, unachieved goals the one due soonest decides (a goal with
 * no due date after those with one), because its deadline is the tightest limit
 * anything is being ranked against. Value layers are read per opportunity; the
 * time, repeatability and combinability facts nobody has established stay null,
 * which sorts last on their criteria rather than helping.
 */
export async function goalRankingFor(
  projectId: string,
  opportunities: readonly CashOpportunity[],
  now: Date = new Date(),
): Promise<{ goal: RankGoal; inputs: Map<string, RankInput> } | undefined> {
  const goals: RankGoal[] = [];
  for (const workstream of await listWorkstreams({ projectIds: [projectId] })) {
    if (workstream.projectId !== projectId || !workstream.target) continue;
    const reading = await readTarget(workstream, now);
    if (reading && !reading.achieved) goals.push(reading);
  }
  if (goals.length === 0) return undefined;
  goals.sort((a, b) => (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY));
  const inputs = new Map<string, RankInput>();
  for (const opportunity of opportunities) {
    inputs.set(opportunity.id, {
      opportunity,
      readings: await listValueLayers(projectId, opportunity.id),
      daysToCash: null,
      repeatable: null,
      combinable: null,
    });
  }
  return { goal: goals[0]!, inputs };
}

export async function goalCompareFor(
  projectId: string,
  opportunities: readonly CashOpportunity[],
  now: Date = new Date(),
): Promise<((a: CashOpportunity, b: CashOpportunity) => number) | undefined> {
  const ranking = await goalRankingFor(projectId, opportunities, now);
  return ranking ? goalComparator(ranking.inputs, ranking.goal) : undefined;
}
