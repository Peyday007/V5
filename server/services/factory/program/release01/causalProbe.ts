/**
 * Production probes for CAUSAL-14-1, 14-2, 14-3, 14-4, 14-5, 14-7 and 15-2,
 * the causal-model-d0-p1 campaign's requirements. A campaign does not register
 * its own judge (§27); these read what the running Brain builds for each live
 * goal — the portfolio a plan read composes, with its causal graph, money
 * routes, chains, what-if answers, assurance and decompositions — and judge it.
 *
 * Read with `persist: false`, so probing records nothing. Three answers:
 *  - UNKNOWN: no live goal, a plan that could not be read, or a portfolio that
 *    does not yet model the part a requirement is about (§39: absence is not a
 *    demonstration, and not a defect a repair can fix).
 *  - FAIL: a reading that contradicts the requirement.
 *  - PASS: the readings demonstrate it and none contradicts it.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';
import type { GoalPortfolio, OpeningCausal } from '../../../goals/portfolio.ts';

export interface PortfolioOf {
  goalId: string;
  portfolio: GoalPortfolio;
}

/** The portfolios live goals compose now, or an UNKNOWN saying why there are none. */
export async function livePortfolios(): Promise<PortfolioOf[] | ProbeResult> {
  const { readGoalPlan } = await import('../../../goals/plan.ts');
  const goals = await getDb().all<{ id: string }>(
    `SELECT id FROM workstreams
      WHERE target_metric IS NOT NULL AND target_amount_cents IS NOT NULL AND due_at IS NOT NULL AND due_at > ?
        AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL ORDER BY id`,
    [new Date().toISOString()],
  );
  if (goals.length === 0) return { ok: null, detail: 'no live goal carries a target and a deadline: no causal model to read' };
  const out: PortfolioOf[] = [];
  for (const goal of goals) {
    let reading;
    try {
      reading = await readGoalPlan({ goalId: goal.id, persist: false });
    } catch (error) {
      return { ok: null, detail: `goal ${goal.id}: the plan could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'error'})` };
    }
    const portfolio = (reading as { portfolio?: GoalPortfolio | null } | null)?.portfolio;
    if (portfolio) out.push({ goalId: goal.id, portfolio });
  }
  if (out.length === 0) return { ok: null, detail: `${goals.length} live goal(s) read; none has a modelled portfolio yet` };
  return out;
}

const membersOf = (ps: readonly PortfolioOf[]): Array<{ goalId: string; m: OpeningCausal }> =>
  ps.flatMap((p) => (p.portfolio.causal?.members ?? []).map((m) => ({ goalId: p.goalId, m })));

const unknownNone = (what: string): ProbeResult => ({ ok: null, detail: `no live goal's portfolio carries ${what} yet` });

/** CAUSAL-14-1: a typed graph with actions and the causal route to money. Pure. */
export function graphHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const ms = membersOf(ps);
  if (ms.length === 0) return unknownNone('a causal graph');
  for (const { goalId, m } of ms) {
    if (!m.route || !(m.route.route ?? '').trim()) return { ok: false, detail: `goal ${goalId}, opening ${m.opportunityId}: a causal graph with no route to money` };
  }
  const full = ms.filter(({ m }) => m.nodes > 0 && m.relations > 0 && m.actions > 0);
  if (full.length === 0) return { ok: null, detail: `${ms.length} opening graph(s), none yet with nodes, relations and actions together` };
  return { ok: true, detail: `${full.length} of ${ms.length} opening graph(s) carry typed nodes, relations, operational actions and a route to money` };
}

/** CAUSAL-14-2: every number carries lineage and a status. Pure. */
export function lineageHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const ms = membersOf(ps);
  if (ms.length === 0) return unknownNone('a money route');
  let known = 0;
  for (const { goalId, m } of ms) {
    const f = m.route?.freeCents;
    if (!f) return { ok: false, detail: `goal ${goalId}, opening ${m.opportunityId}: the free amount carries no figure` };
    if (f.status !== 'UNKNOWN') {
      known += 1;
      if (!(f.source ?? '').trim() && (f.derivedFrom ?? []).length === 0) {
        return { ok: false, detail: `goal ${goalId}, opening ${m.opportunityId}: a ${f.status} free amount with no source and no derivation` };
      }
    } else if (f.value !== null) {
      return { ok: false, detail: `goal ${goalId}, opening ${m.opportunityId}: an UNKNOWN figure states a value` };
    }
  }
  const accounted = ps.filter((p) => p.portfolio.causal?.account).length;
  if (accounted === 0) return { ok: null, detail: `${ms.length} money route(s) read, no portfolio account produced yet` };
  return { ok: true, detail: `${ms.length} money route(s): ${known} free amount(s) with a status and lineage, the rest UNKNOWN without a value; ${accounted} full account(s)` };
}

/** CAUSAL-14-3: the dependency chain, with its binding constraint. Pure. */
export function chainHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const ms = membersOf(ps);
  if (ms.length === 0) return unknownNone('a dependency chain');
  for (const { goalId, m } of ms) {
    if (m.chain && m.chain.firstUnknown !== null && m.chain.outputUnits !== null) {
      return { ok: false, detail: `goal ${goalId}, opening ${m.opportunityId}: the chain states output past an unknown stage (${m.chain.firstUnknown})` };
    }
  }
  const chained = ms.filter(({ m }) => (m.chain?.stages ?? []).length > 0);
  if (chained.length === 0) return { ok: null, detail: `${ms.length} opening graph(s), no chain of stages yet` };
  const bound = chained.filter(({ m }) => m.chain.bindingConstraint || m.chain.firstUnknown).length;
  return { ok: true, detail: `${chained.length} chain(s) passed volume stage by stage; ${bound} name their binding constraint or first unknown` };
}

/** CAUSAL-14-4: the model is executable — questions are asked of it and propagated. Pure. */
export function whatIfHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const ms = membersOf(ps);
  if (ms.length === 0) return unknownNone('a causal graph to question');
  const answers = ms.flatMap(({ m }) => m.whatIf ?? []);
  for (const a of answers) {
    for (const e of a.effects) {
      if (!e.before || !e.after) return { ok: false, detail: `what-if ${a.id}: an effect on ${e.opportunityId} without its before and after` };
    }
  }
  const propagated = answers.filter((a) => a.effects.length > 0);
  if (propagated.length === 0) return { ok: null, detail: `${ms.length} opening graph(s), no what-if answer propagated yet` };
  return { ok: true, detail: `${propagated.length} what-if answer(s) propagated through the graph, each effect with its before and after` };
}

/** CAUSAL-14-5: uncertainty modelled, inputs validated. Pure. */
export function assuranceHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const withAssurance = ps.filter((p) => p.portfolio.assurance);
  if (withAssurance.length === 0) return unknownNone('an assurance reading');
  for (const p of withAssurance) {
    const a = p.portfolio.assurance!;
    if (a.claimsAtLeast90 && a.validationProblems.length > 0) {
      return { ok: false, detail: `goal ${p.goalId}: claims 90% with ${a.validationProblems.length} unvalidated input(s)` };
    }
  }
  return { ok: true, detail: `${withAssurance.length} portfolio(s) carry an assurance status with their validation problems named` };
}

/** CAUSAL-14-7: a calibrated, auditable probability — never coverage read as one. Pure. */
export function calibrationHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const withAssurance = ps.filter((p) => p.portfolio.assurance);
  if (withAssurance.length === 0) return unknownNone('an assurance reading');
  for (const p of withAssurance) {
    if (p.portfolio.basis === 'COVERAGE' && p.portfolio.assurance!.claimsAtLeast90) {
      return { ok: false, detail: `goal ${p.goalId}: coverage of tested conditions is presented as a 90% probability` };
    }
  }
  const histories = ps.reduce((n, p) => n + (p.portfolio.marketHistory?.length ?? 0), 0);
  return { ok: true, detail: `${withAssurance.length} portfolio(s) state their assurance against their basis; ${histories} market history record set(s) behind the samples` };
}

/** CAUSAL-15-2: an AI business decomposed into observable subproblems. Pure. */
export function decompositionHolds(ps: readonly PortfolioOf[]): ProbeResult {
  const decomposed = membersOf(ps).filter(({ m }) => m.decomposition && m.decomposition.length > 0);
  if (decomposed.length === 0) return unknownNone('an opening Brain fulfils itself, decomposed');
  for (const { goalId, m } of decomposed) {
    const blind = m.decomposition!.find((s) => !(s.observable ?? '').trim());
    if (blind) return { ok: false, detail: `goal ${goalId}, opening ${m.opportunityId}: subproblem ${blind.id} names nothing observable` };
  }
  return { ok: true, detail: `${decomposed.length} Brain-fulfilled opening(s) decomposed into observable causal subproblems` };
}

type Judge = (ps: readonly PortfolioOf[]) => ProbeResult;
async function onRows(judge: Judge): Promise<ProbeResult> {
  const ps = await livePortfolios();
  return Array.isArray(ps) ? judge(ps) : ps;
}

export const causalGraphOnRows = () => onRows(graphHolds);
export const causalLineageOnRows = () => onRows(lineageHolds);
export const causalChainOnRows = () => onRows(chainHolds);
export const causalWhatIfOnRows = () => onRows(whatIfHolds);
export const causalAssuranceOnRows = () => onRows(assuranceHolds);
export const causalCalibrationOnRows = () => onRows(calibrationHolds);
export const causalDecompositionOnRows = () => onRows(decompositionHolds);
