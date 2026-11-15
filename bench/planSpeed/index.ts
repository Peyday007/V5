/**
 * Suite `planSpeed`: wall-clock of the plan's quantitative reconstruction on a
 * frozen input (docs/evolution/DESIGN.md).
 *
 * The production plan read spends most of its time here (trace, 2026-11-15:
 * `trace plan +26063ms (48506ms) reconstruction`). What is timed is what
 * `plan.ts reconstructionFor` runs: the engine's baseline reading
 * (`evaluateGoalPortfolio`, causal reading off as the search reads it), then
 * `reconstructPlan` with exploration on — diagnosis, operators, greedy rounds,
 * the variable sweep (§102), the multidirectional exploration (§101), the
 * as-is floor and the reply-rate bisection — with an empty method library and
 * no model lane, as a read between model calls runs it.
 *
 * Deterministic: the engine is seeded and runs on the inline evaluator (one
 * thread, so a timing does not depend on how many cores the runner has), and
 * the exploration's and sweep's clocks are lifted far above what they need, so
 * both stop on their evaluation and variation budgets — never on time, which
 * would make the plan depend on the machine. Every run must read the same plan.
 *
 * Metrics:
 *   p50ms / minms / maxms — over runs, of the total across cases (primary p50ms, lower is better)
 *   bestReach   — the strongest plan's reach on the first case (coverage, not a probability)
 *   reachDelta  — bestReach less the case's recorded reference (guard: |Δ| within tolerance)
 *   evaluations — the reconstruction's own engine evaluations
 *   deterministic — 1 when every run read the same strongest plan
 */
import { evaluateGoalPortfolio } from '../../server/services/goals/portfolio.ts';
import { reconstructPlan } from '../../server/services/goals/reconstruction.ts';
import { inlineEvaluator } from '../../server/services/goals/reasoning/evaluatorPool.ts';
import { modelledOf } from '../spec.ts';
import { HIDDEN_PREFIX, type CaseResult, type Suite, type SuiteOptions, type SuiteOutcome } from '../types.ts';
import { GOAL_10K_LIMITS, GOAL_10K_PLAN, type PlanSpeedCase } from './fixture.ts';

export const PLAN_SEED = 11;
/** The plan's own world count (`limits.worlds ?? 2000` in the reconstruction's full read). */
export const PLAN_WORLDS = 2000;
export const DEFAULT_RUNS = 3;
/** A reach this far from the reference is a different plan, not Monte Carlo noise at these worlds. */
export const REACH_TOLERANCE = 0.03;
/** Far above any budget-bound stop, so the clocks never decide. */
const CLOCK_MS = 30 * 60_000;

/**
 * The reference reading of the public case on the current production code
 * (BASELINE.md). A variant that reads a materially different strongest plan
 * moves `reachDelta`; it is a guard, not something to optimise.
 */
export const REFERENCE_REACH: Record<string, number> = { 'goal10k-23': 0.8852 };

function caseOf(value: unknown): PlanSpeedCase | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<PlanSpeedCase>;
  if (typeof c.id !== 'string' || !Array.isArray(c.openings) || c.openings.length === 0) return null;
  return c as PlanSpeedCase;
}

export interface PlanRun {
  ms: number;
  reach: number;
  settledP50: number;
  key: string;
  evaluations: number;
  stages: { baselineMs: number; reconstructionMs: number };
}

export async function runPlan(c: PlanSpeedCase, worlds = PLAN_WORLDS, explore = true): Promise<PlanRun> {
  const limits = { ...GOAL_10K_LIMITS, ...(c.limits ?? {}) };
  const openings = c.openings.map((o, i) => modelledOf(o, i + 1));
  const portfolio = { ...limits, worlds, seed: PLAN_SEED };
  const t0 = performance.now();
  const baseline = evaluateGoalPortfolio({ ...portfolio, openings, knowledge: null, causal: false });
  const t1 = performance.now();
  const r = await reconstructPlan({
    openings,
    portfolio,
    baseline,
    required: c.required ?? 0.9,
    evaluator: inlineEvaluator(),
    explore: explore ? { library: [], stancePrior: {}, maxMs: CLOCK_MS, sweepMs: CLOCK_MS } : null,
  });
  const t2 = performance.now();
  return {
    ms: t2 - t0,
    reach: r.best.reach,
    settledP50: r.best.settledP50,
    key: r.best.key,
    evaluations: r.evaluations + (r.exploration?.evaluations ?? 0),
    stages: { baselineMs: t1 - t0, reconstructionMs: t2 - t1 },
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

export async function runPlanSpeed(options: SuiteOptions = {}): Promise<SuiteOutcome> {
  const runs = options.runs ?? DEFAULT_RUNS;
  const worlds = options.worlds ?? PLAN_WORLDS;
  const all: Array<{ c: PlanSpeedCase | null; hidden: boolean; raw: unknown }> = [
    { c: GOAL_10K_PLAN, hidden: false, raw: GOAL_10K_PLAN },
    ...(options.extraCases ?? []).map((raw) => ({ c: caseOf(raw), hidden: true, raw })),
  ];
  const totals: number[] = Array.from({ length: runs }, () => 0);
  const cases: CaseResult[] = [];
  const summary: string[] = [];
  let first: { reach: number; delta: number | null; evaluations: number } | null = null;
  let deterministic = true;
  for (const [i, { c, hidden, raw }] of all.entries()) {
    const rawId = c?.id ?? (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : `case-${i + 1}`);
    const id = hidden ? `${HIDDEN_PREFIX}${rawId}` : rawId;
    if (!c) {
      cases.push({ id, pass: false, score: 0, ms: 0 });
      summary.push(`  FAIL ${id} malformed`);
      continue;
    }
    const readings: PlanRun[] = [];
    for (let run = 0; run < runs; run++) {
      const one = await runPlan(c, worlds, !options.quick);
      readings.push(one);
      totals[run]! += one.ms;
      options.log?.(`${id} run ${run + 1}/${runs}: ${Math.round(one.ms)} ms (baseline ${Math.round(one.stages.baselineMs)} ms) · reach ${one.reach.toFixed(4)} · ${one.evaluations} evaluations`);
    }
    const same = readings.every((r) => r.reach === readings[0]!.reach && r.key === readings[0]!.key && r.settledP50 === readings[0]!.settledP50);
    if (!same) deterministic = false;
    const reach = readings[0]!.reach;
    const reference = hidden ? c.referenceReach : (c.referenceReach ?? REFERENCE_REACH[c.id]);
    // The reference was recorded at the plan's own worlds: a reduced-worlds run is a shape check, not a quality reading.
    const delta = reference !== undefined && worlds === PLAN_WORLDS && !options.quick ? reach - reference : null;
    const pass = same && (delta === null || Math.abs(delta) <= REACH_TOLERANCE);
    const ms = median(readings.map((r) => r.ms));
    cases.push({ id, pass, score: round(reach, 4), ms: round(ms) });
    summary.push(`  ${pass ? 'ok  ' : 'FAIL'} ${id}: p50 ${Math.round(ms)} ms · reach ${reach.toFixed(4)}${delta !== null ? ` (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(4)})` : ''}${same ? '' : ' · runs disagree'}${hidden ? '' : ` · best "${readings[0]!.key.slice(0, 80)}"`}`);
    if (!first) first = { reach, delta, evaluations: readings[0]!.evaluations };
  }
  const metrics: Record<string, number> = {
    p50ms: round(median(totals)),
    minms: round(Math.min(...totals)),
    maxms: round(Math.max(...totals)),
    bestReach: round(first?.reach ?? 0, 4),
    reachDelta: round(first?.delta ?? 0, 4),
    evaluations: first?.evaluations ?? 0,
    deterministic: deterministic ? 1 : 0,
    runs,
    worlds,
    explored: options.quick ? 0 : 1,
    cases: cases.length,
  };
  summary.unshift(`planSpeed: p50 ${Math.round(metrics['p50ms']!)} ms · min ${Math.round(metrics['minms']!)} ms over ${runs} run(s) at ${worlds} worlds · bestReach ${metrics['bestReach']} · reachDelta ${metrics['reachDelta']}`);
  return { cases, metrics, summary };
}

export const planSpeed: Suite = {
  name: 'planSpeed',
  primary: { metric: 'p50ms', direction: 'lower' },
  run: runPlanSpeed,
};
