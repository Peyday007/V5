/**
 * §102: every plan read that is not defensibly accepted sweeps the plan's
 * variables — tens of thousands of combinations of money, price, deal size,
 * channel, partner, financing, timing and composition, then the world's
 * conditions — with ordinary code, attacks the result from several
 * directions, and hands the strongest distinct strategies to the engine. The
 * $10K goal is the regression case; a second goal shares nothing with it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { reconstructPlan, renderReconstruction } from '../server/services/goals/reconstruction.ts';
import { compile, fastReading, type Limits } from '../server/services/goals/reasoning/variables.ts';
import { recentExplorations, recordExploration } from '../server/services/goals/reasoning/learning.ts';
import { inlineEvaluator, openEvaluator } from '../server/services/goals/reasoning/evaluatorPool.ts';
import { freshProject, teardown } from './helpers.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const portfolioInput = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 1000, seed: 11 };
const baseline = evaluateGoalPortfolio({ ...portfolioInput, openings: GOAL_10K_OPENINGS });
const r = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9 });
const x = r.exploration!;
const w = x.sweep!;
if (process.env.SHOW) console.log(renderReconstruction(r).join('\n'));

afterAll(async () => {
  await teardown();
});

describe('§102 on the $10K goal', () => {
  it('reads tens of thousands of distinct variations with ordinary code, and counts an equivalent plan once', () => {
    expect(w.variations).toBeGreaterThanOrEqual(50_000);
    expect(w.factorial).toBeGreaterThanOrEqual(10_000);
    expect(w.conditionReads).toBeGreaterThanOrEqual(10_000);
    expect(w.equivalent).toBeGreaterThan(0);
    expect(w.space).toBeGreaterThan(w.factorial);
    // No model call was spent on a calculation: the exploration ran without one.
    expect(x.model.calls).toBe(0);
  });

  it('discovers its variables from the problem: decisions from the costed operators and scopes, conditions from the openings\' ranges', () => {
    const families = w.variables.map((v) => v.family);
    for (const f of ['MONEY_CAPACITY', 'CHANNEL', 'PARTNER', 'DEAL_SIZE', 'FINANCING', 'CASH_TIMING', 'PRICE', 'COMBINATION']) expect(families).toContain(f);
    const keys = w.conditions.map((c) => c.key);
    for (const k of ['reply', 'close', 'market', 'ticket', 'supplier-cost', 'cash-speed', 'outreach-capacity', 'time-available']) expect(keys).toContain(k);
    // Discovered, not listed: one per wide range an opening holds.
    expect(w.conditions.filter((c) => c.scope !== 'ALL').length).toBeGreaterThanOrEqual(10);
  });

  it('attacks the space from several directions, and its strategies are judged by the engine inside the exploration', () => {
    const approaches = w.approaches.map((a) => a.approach);
    for (const a of ['FORWARD', 'BACKWARD', 'MIDDLE_OUT', 'BOTTLENECK', 'CHALLENGE', 'PERSPECTIVE:CASH', 'PERSPECTIVE:FLOOR', 'PERSPECTIVE:SPEED', 'PERSPECTIVE:CAPITAL', 'COMBINE']) expect(approaches).toContain(a);
    expect(w.directions.length).toBeGreaterThanOrEqual(5);
    const judged = x.all.filter((d) => d.direction.stance.startsWith('VARIABLE:'));
    expect(judged.length).toBeGreaterThanOrEqual(5);
    // It changes the plan's size and structure: the strongest strategy reads materially more cash than the plan as held.
    expect(Math.max(...judged.map((d) => d.reading.settledP50))).toBeGreaterThan(2 * x.baseline.settledP50);
  });

  it('separates what is commercially supported from what is only mathematically possible, and never invents demand', () => {
    expect(w.bestSupported).not.toBeNull();
    expect(w.bestSupported!.supported).toBe(true);
    expect(w.bestSupported!.assumptions).toHaveLength(0);
    expect(w.bestSupported!.reading.mean).toBeGreaterThan(w.baseline.mean);
    expect(w.bestMathematical).not.toBeNull();
    expect(w.bestMathematical!.supported).toBe(false);
    expect(Object.keys(w.bestMathematical!.conditions).length).toBeGreaterThan(0);
    // Backward from the requirement: each condition's needed multiple, marked inside or outside evidence.
    expect(w.requirements).toHaveLength(8);
    for (const q of w.requirements) expect(q.inEvidence).toBe(q.needed !== null && q.needed <= q.evidencedTop + 1e-9);
    // What only the world can answer reaches the next discovery round.
    expect(w.asks.length).toBeGreaterThan(0);
    expect(r.searchBrief).toContain(w.asks[0]!);
    // Coverage stays coverage.
    expect(r.confidence.basis).toBe('COVERAGE');
    expect(renderReconstruction(r).join('\n')).toMatch(/variables .*variation\(s\) of 8 decision variable/);
  });

  it('records the variations on the exploration row', async () => {
    await freshProject();
    await recordExploration('wst_sweep', x);
    const [row] = await recentExplorations('wst_sweep');
    expect(Number(row!.variations)).toBe(w.variations);
    expect(Number(row!.variables)).toBe(w.variables.length + w.conditions.length);
  });
});

describe('§102 mechanics', () => {
  const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
  const one = (id: string, over: Partial<ModelledOpportunity>): ModelledOpportunity =>
    ({ opportunity: { id, title: id }, index: 1, tier: 'QUALIFIED', repeatable: true, price: swept(400, 600), capital: swept(0, 100), hours: swept(0, 0), daysToCash: swept(3, 7), close: swept(0.1, 0.2), respond: swept(0.01, 0.03), directCost: swept(0, 50), volume: swept(50, 150), agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false, ...over }) as ModelledOpportunity;
  const L: Limits = { remaining: 5000, daysLeft: 30, contacts: 100, cvContacts: 0.05, startingCapital: 500, beforeProof: 300, spendCeiling: 1000, ceiling: 1000 };

  it('the fast reading moves the way the model does: more capacity, market or time never reads less', () => {
    const rows = compile({ openings: [one('a', {}), one('b', { price: swept(100, 200) })], committed: 0, changes: [] }, 300);
    const base = fastReading(rows, L, 0);
    expect(fastReading(rows, L, 0, { contacts: 2 }).mean).toBeGreaterThanOrEqual(base.mean);
    expect(fastReading(rows, L, 0, { volume: 2 }).mean).toBeGreaterThanOrEqual(base.mean);
    expect(fastReading(rows, L, 0, { days: 1.5 }).mean).toBeGreaterThanOrEqual(base.mean);
    expect(fastReading(rows, L, 0, { respond: 0.5, close: 0.5 }).reach).toBeLessThanOrEqual(base.reach);
    expect(fastReading(rows, L, 2000).feasible).toBe(false);
    expect(base.p10).toBeLessThanOrEqual(base.p50);
    expect(base.p50).toBeLessThanOrEqual(base.p90);
  });

  it('never holds the event loop: requests are served between slices of the sweep', async () => {
    // Production, 2026-11-11 (Deploy 42998216834): a sweep that yielded every 2,000 reads coincided with a request timing out after the restart.
    /*
     * Measured on the evaluator the plan read uses (`plan.ts` passes the shared pool). This
     * test once timed `reconstructPlan`'s inline default and started its clock before its own
     * synchronous baseline evaluation, so the "stall" it read was the engine's one whole
     * evaluation on the test's thread — 161 ms on both attempts of Deploy 43570660021, against
     * the 150 ms bound — not a slice of the sweep.
     */
    const b = evaluateGoalPortfolio({ ...portfolioInput, openings: GOAL_10K_OPENINGS, worlds: 200 });
    const pool = openEvaluator(1);
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
    }, 1);
    const started = performance.now();
    const again = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: { ...portfolioInput, worlds: 200 }, baseline: b, required: 0.9, explore: { maxMs: 1 }, evaluator: pool });
    clearInterval(tick);
    await pool.close();
    expect(again.exploration?.sweep?.variations ?? 0).toBeGreaterThan(10_000);
    expect(performance.now() - started).toBeGreaterThan(200);
    // The longest hold is one direction evaluation, which the inline fallback cannot split (production runs
    // these on a pool thread: the next test). Measured 122-134 ms locally and 155-161 ms on CI runners
    // (2026-11-12, 2026-11-14), so 150 failed on runner speed, not on a sweep that stopped yielding: a sweep
    // that holds the loop for its whole run is seconds, far past this bound.
    expect(worst).toBeLessThan(200);
  });


  it('runs on a pool thread, not the server\'s loop, and reads the same as inline', async () => {
    // Production, 2026-11-11: both releases whose boot ran the sweep on the main loop timed out a database-heavy request after the restart.
    const pool = openEvaluator(1);
    const job = { openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9, greedy: { openings: GOAL_10K_OPENINGS, committed: 0, changes: [] }, maxVariations: 5_000 };
    const threaded = await pool.sweep(job);
    const inline = await inlineEvaluator().sweep(job);
    await pool.close();
    expect(threaded.variations).toBe(inline.variations);
    expect(threaded.bestSupported?.label).toBe(inline.bestSupported?.label);
    expect(threaded.directions.map((d) => d.signature)).toEqual(inline.directions.map((d) => d.signature));
  });

  it('a time bound is shared between stages: a slow machine still searches locally and moves the world', async () => {
    // Production, 2026-11-11 (Goals plan 43003547180): one bound let the factorial take all 49 s; local search and conditions read nothing.
    const quick = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9, explore: { maxMs: 1, sweepMs: 600 } });
    const s = quick.exploration!.sweep!;
    expect(s.stopped).toBe('TIME');
    expect(s.factorial).toBeGreaterThan(0);
    expect(s.local).toBeGreaterThan(0);
    expect(s.conditionReads).toBeGreaterThan(1000);
  });

  it('a second goal with nothing in common sweeps its own variables', async () => {
    const openings = [one('opp_x', {}), one('opp_y', { price: swept(2000, 4000), close: swept(0.02, 0.08), volume: swept(5, 30) }), one('opp_z', { repeatable: false, price: swept(800, 1200), close: swept(0.3, 0.6) })];
    const input = { remaining: 6000, daysLeft: 45, capitalCeiling: 1500, beforeProof: 200, perWeek: 400, resources: null, worlds: 300, seed: 3 };
    const b = evaluateGoalPortfolio({ ...input, openings });
    const r2 = await reconstructPlan({ openings, portfolio: input, baseline: b, required: 0.9, explore: { sweepMs: 20_000, maxVariations: 20_000 } });
    const s = r2.exploration?.sweep;
    expect(s).toBeTruthy();
    expect(s!.variations).toBeGreaterThan(1000);
    expect(s!.variations).toBeLessThanOrEqual(20_000 + 100);
    expect(s!.conditions.some((c) => c.scope === 'opp_y')).toBe(true);
  });
});
