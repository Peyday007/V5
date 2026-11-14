/**
 * Planning speed without a weaker plan (lens P, Surge B, 2026-11-14).
 *
 * A cold $10K plan read over ~500 held openings took 316 s locally and
 * 26 min 41 s on production; 88% of it was the reconstruction, because each of
 * its ~200 engine evaluations carried every repeatable opening and re-drew
 * every opening's Monte Carlo worlds. Two repairs:
 *  - the reconstruction moves the ranked members plus the `MOVABLE_UNRANKED`
 *    strongest other openings, and holds the rest in the INCLUDE reserve;
 *  - `demandWorlds` reuses an opening's worlds across evaluations, keyed by
 *    every input it reads, so a reading is identical to the one it replaces.
 *
 * Measured on a 4-core machine, inline evaluator, single vitest worker, the
 * 300-opening fixture below with exploration off (diagnosis, greedy rounds,
 * volume questions, as-is floor and the reply bisection — 41 evaluations):
 *   before: reconstruction 41.1 s (1,000 ms an evaluation), baseline 8.8 s
 *   after:   reconstruction  5.8 s (  140 ms an evaluation), baseline 7.8 s
 * Same strongest plan (the bundle move on the same member); its reach read
 * 0.920 before on 150 worlds and 0.946 after on 800 (the bounded set affords
 * more worlds per evaluation), within Monte Carlo tolerance.
 * At 500 openings with exploration on (sweep and directions, default caps):
 *   before: reconstruction 295–305 s, 208–260 evaluations at 1.4–1.8 s, sweep 45 s
 *   after:  reconstruction  29 s,     347 evaluations at 0.10 s,  sweep 5.4 s,
 *           the same exploration budget (120 directions, held openings counted)
 * There the plan differs, and the old one was the artifact: before, every read
 * ran at 150 worlds (7,200 ÷ 500 openings, floored) and "bundle" read kept
 * p50 $56,227, under the critic's ×20 return bound; read at 2,000 worlds,
 * on the full set and on the bounded set alike, it keeps $61,541 — ×20.5,
 * implausible. The bounded set affords 266/771 worlds, sees that, and keeps
 * "retainer" (reach 0.892; 0.8835 at 2,000 worlds on either set).
 * The $10K fixture's reconstruction is bit-identical before and after (eight
 * openings: the bound does not bind), 5.6 s → 3.8 s without exploration and
 * 12.1 s → 8.1 s with it, from the draw cache alone.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { buildOperators, MOVABLE_UNRANKED, partitionOpenings, reconstructPlan, type StrategyState } from '../server/services/goals/reconstruction.ts';
import { applyProgram } from '../server/services/goals/reasoning/directions.ts';
import { inlineEvaluator } from '../server/services/goals/reasoning/evaluatorPool.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';
import { manyOpenings } from './fixtures/goalManyOpenings.ts';

const portfolio = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, seed: 11 };
const openings = manyOpenings(300);
const baseline = evaluateGoalPortfolio({ ...portfolio, openings, worlds: 2000, causal: false });
const { movable, held } = partitionOpenings(openings, baseline);

describe('the reconstruction moves a bounded set of openings', () => {
  it('keeps every ranked member and the strongest unranked ones, and holds the rest in order', () => {
    const ranked = new Set([...(baseline.best?.members ?? []), ...baseline.alternatives.flatMap((a) => a.members)].map((m) => m.opportunityId));
    const ids = new Set(movable.map((o) => o.opportunity.id));
    for (const id of ranked) expect(ids.has(id)).toBe(true);
    expect(movable.length).toBeLessThanOrEqual(ranked.size + MOVABLE_UNRANKED);
    expect(movable.length + held.length).toBe(openings.length);
    // Held strongest first, and none stronger than the weakest unranked opening moved.
    const p50 = new Map(baseline.demand.map((d) => [d.opportunityId, d.revenue.p50]));
    const weakestMoved = Math.min(...movable.filter((o) => !ranked.has(o.opportunity.id)).map((o) => p50.get(o.opportunity.id)!));
    for (let i = 1; i < held.length; i++) expect(p50.get(held[i - 1]!.opportunity.id)!).toBeGreaterThanOrEqual(p50.get(held[i]!.opportunity.id)!);
    expect(p50.get(held[0]!.opportunity.id)!).toBeLessThanOrEqual(weakestMoved);
    // The input's order is kept, so the engine's activity order is unchanged.
    const at = new Map(openings.map((o, i) => [o.opportunity.id, i]));
    for (let i = 1; i < movable.length; i++) expect(at.get(movable[i]!.opportunity.id)!).toBeGreaterThan(at.get(movable[i - 1]!.opportunity.id)!);
  });

  it('brings a strong opening outside the bounded set in through INCLUDE, and the engine judges it', async () => {
    const strong = held[0]!;
    expect(movable.some((o) => o.opportunity.id === strong.opportunity.id)).toBe(false);
    const input = { openings: movable, portfolio: { ...portfolio, worlds: 400 }, baseline, required: 0.9 };
    const base: StrategyState = { openings: movable, committed: 0, changes: [] };
    const ctx = { operators: buildOperators({ input, base }), operatorsFor: (t: string) => buildOperators({ input, base, target: t }), remaining: portfolio.remaining, reserve: held };
    const { state } = applyProgram(base, [{ op: 'INCLUDE', key: strong.opportunity.id }], ctx);
    expect(state.openings.some((o) => o.opportunity.id === strong.opportunity.id)).toBe(true);
    expect(state.changes.map((c) => c.label)).toContain(`include:${strong.opportunity.id}`);
    const read = evaluateGoalPortfolio({ ...portfolio, worlds: 400, causal: false, openings: state.openings });
    expect(read.demand.some((d) => d.opportunityId === strong.opportunity.id && !d.refused)).toBe(true);
  });

  it('an evaluation of the bounded set reads the plan the full set reads, at a fraction of the cost', () => {
    const time = (xs: typeof openings) => {
      const t = performance.now();
      const p = evaluateGoalPortfolio({ ...portfolio, worlds: 150, seed: 5151, causal: false, openings: xs });
      return { ms: performance.now() - t, p };
    };
    const all = time(openings);
    const bounded = time(movable);
    expect(bounded.ms).toBeLessThan(all.ms / 3);
    // Same worlds, same strongest combination: the openings left out were never going to be in it.
    expect(bounded.p.best?.members.map((m) => `${m.opportunityId}@${m.share}`)).toEqual(all.p.best?.members.map((m) => `${m.opportunityId}@${m.share}`));
    expect(bounded.p.best?.reach).toBeCloseTo(all.p.best!.reach, 6);
  });

  it('reconstructs 300 openings within a budget well under the 41 s it took before', async () => {
    const t = performance.now();
    const r = await reconstructPlan({ openings, portfolio: { ...portfolio, worlds: 2000 }, baseline, required: 0.9, evaluator: inlineEvaluator(), explore: null });
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(20_000);
    expect(r.best.reach).toBeGreaterThanOrEqual(r.baseline.reach);
    expect(r.best.changes.map((c) => c.label)).toContain('bundle');
  }, 120_000);
});

describe('the per-opening draw cache changes nothing it returns', () => {
  it('reads the $10K portfolio identically cold and warm', () => {
    const read = () => evaluateGoalPortfolio({ ...portfolio, openings: GOAL_10K_OPENINGS, worlds: 700, seed: 424242 });
    const cold = read();
    const warm = read();
    expect(warm).toEqual(cold);
    // A changed input is a different key: the reading moves with it.
    const moved = evaluateGoalPortfolio({ ...portfolio, openings: GOAL_10K_OPENINGS.map((o) => (o.opportunity.id === 'cop_lists' ? { ...o, price: { ...o.price, low: 400, high: 900 } } : o)), worlds: 700, seed: 424242 });
    expect(moved.demand.find((d) => d.opportunityId === 'cop_lists')!.price).not.toEqual(cold.demand.find((d) => d.opportunityId === 'cop_lists')!.price);
    expect(moved.demand.find((d) => d.opportunityId === 'arr_gifts')).toEqual(cold.demand.find((d) => d.opportunityId === 'arr_gifts'));
  });
});
