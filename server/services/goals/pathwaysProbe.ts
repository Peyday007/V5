/**
 * Production probe for OPP-04: every input of a candidate transaction path is
 * marked evidence-backed, estimated with a justified range, or unknown, and what
 * the quantity says transforms the strategy.
 *
 * It reads each live goal's plan through the one reader the goal screens use
 * (`readGoalPlan`, persisting nothing) and judges the pathways it produced:
 *  - every fact, and `rights` and `capacity`, carries a recognised status and a basis;
 *  - an UNKNOWN fact states no point value — an unknown is never a favourable number;
 *  - an ESTIMATED fact carries a range or a value; a PROVEN one carries a value;
 *  - the tally of the fourteen commercial facts adds up;
 *  - a pathway whose reach falls short on its channel carries the REACH_SHORTFALL gap
 *    and a construct move that changes the channel, never a quiet drop.
 * With no pathway on any live goal the answer is a failure: nothing to look at is not a
 * demonstration (§39). Registered here because `probes.ts` is a protected path;
 * `pathways.ts` imports this module so it is registered wherever pathways load.
 */
import { getDb } from '../../db/database.ts';
import { registerProbe, type ProbeResult } from '../factory/program/probes.ts';
import type { PathFact, TransactionPathway } from './pathways.ts';

export const PATHWAYS_PROBE = 'r01.opp-04';

const STATUSES = new Set(['PROVEN', 'ESTIMATED', 'UNKNOWN', 'DENIED']);

/** Why one fact breaks the marking rule, or null. Pure. */
export function factProblem(name: string, fact: PathFact | null | undefined): string | null {
  if (!fact || !STATUSES.has(fact.status)) return `${name} is not marked proven, estimated or unknown`;
  if (typeof fact.basis !== 'string' || fact.basis.trim() === '') return `${name} is marked ${fact.status} without a basis`;
  if (fact.status === 'UNKNOWN' && fact.value !== null) return `${name} is unknown yet states the value ${String(fact.value)}`;
  if (fact.status === 'PROVEN' && fact.value === null) return `${name} is proven without a value`;
  if (fact.status === 'ESTIMATED' && fact.value === null && (fact.low === null || fact.high === null)) return `${name} is estimated without a value or a range`;
  if (fact.low !== null && fact.high !== null && fact.low > fact.high) return `${name} has a range whose low exceeds its high`;
  return null;
}

/** Why one pathway breaks the rule, or null. Pure. */
export function pathwayProblem(p: TransactionPathway): string | null {
  const commercial: Array<[string, PathFact]> = [
    ['buyer', p.buyer], ['motivation', p.motivation], ['channel', p.channel], ['offer', p.offer], ['fulfiller', p.fulfiller],
    ['revenuePerDeal', p.revenuePerDeal], ['acquisitionCost', p.acquisitionCost], ['fulfilmentCost', p.fulfilmentCost], ['net', p.net],
    ['conversion', p.conversion], ['volume', p.volume], ['frequency', p.frequency], ['daysToCash', p.daysToCash], ['capital', p.capital],
  ];
  for (const [name, fact] of [...commercial, ['rights', p.rights], ['capacity', p.capacity]] as Array<[string, PathFact]>) {
    const problem = factProblem(name, fact);
    if (problem) return problem;
  }
  const tally = p.counts.proven + p.counts.estimated + p.counts.unknown;
  if (tally !== commercial.length) return `the fact tally is ${tally}, not ${commercial.length}`;
  if (p.gaps.includes('REACH_SHORTFALL') && !p.moves.some((m) => m.gap === 'REACH_SHORTFALL' && m.action === 'CONSTRUCT')) {
    return 'reaches too few buyers on its channel but offers no move that changes the channel';
  }
  if (p.fit.lever.variable === 'CHANNEL' && !p.gaps.includes('REACH_SHORTFALL')) return 'its failing lever is the channel but the shortfall is not named';
  return null;
}

export async function opportunityPathsMarkedOnRows(): Promise<ProbeResult> {
  const { readGoalPlan } = await import('./plan.ts');
  const goals = await getDb().all<{ id: string }>(
    `SELECT id FROM workstreams
      WHERE target_metric IS NOT NULL AND target_amount_cents IS NOT NULL AND due_at IS NOT NULL AND due_at > ?
        AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL ORDER BY id`,
    [new Date().toISOString()],
  );
  if (goals.length === 0) return { ok: false, detail: 'no live goal carries a target and a deadline: no pathway to read' };
  let pathways = 0;
  let unknownFacts = 0;
  let shortfalls = 0;
  for (const goal of goals) {
    let reading;
    try {
      reading = await readGoalPlan({ goalId: goal.id, persist: false });
    } catch (error) {
      return { ok: false, detail: `goal ${goal.id}: the plan could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'error'})` };
    }
    for (const p of reading?.pathways?.pathways ?? []) {
      const problem = pathwayProblem(p);
      if (problem) return { ok: false, detail: `goal ${goal.id}, pathway ${p.opportunityId}: ${problem}` };
      pathways += 1;
      unknownFacts += p.counts.unknown;
      if (p.gaps.includes('REACH_SHORTFALL')) shortfalls += 1;
    }
  }
  if (pathways === 0) return { ok: false, detail: `${goals.length} live goal(s) read; none has a pathway, so the marking is not yet demonstrated` };
  return {
    ok: true,
    detail: `${pathways} pathway(s) across ${goals.length} goal(s): every input marked proven, estimated or unknown (${unknownFacts} unknown, none stated as a number); ${shortfalls} with a channel-changing move for a reach shortfall`,
  };
}

registerProbe(PATHWAYS_PROBE, opportunityPathsMarkedOnRows);
