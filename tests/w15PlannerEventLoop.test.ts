/**
 * W15 (production 2026-11-17): SHEDDING with a healthy database — 10–20 s
 * event-loop stalls per 120 s window, the connection report's CPU profile
 * naming `planSet` `canonical`/`overlap`, `payerNamedIn`/`statesNamedIn` and
 * `evaluatorPool` (`postMessage`/`structuredClone`).
 *
 * Each fix is bounded here on a production-shaped fixture, and each keeps the
 * outcome: the readings are fingerprinted against the code before the fix.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { comparablePricesFor } from '../server/services/cash/goalScenario.ts';
import { buildPlanSet, rebuildAfter } from '../server/services/goals/planSet.ts';
import { buyerPopulationName, payerNamedIn } from '../server/domain/industry.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { reconstructPlan } from '../server/services/goals/reconstruction.ts';
import { inlineEvaluator, type Evaluator } from '../server/services/goals/reasoning/evaluatorPool.ts';
import { modelledOf } from '../bench/spec.ts';
import { GOAL_10K_LIMITS, GOAL_10K_PLAN } from '../bench/planSpeed/fixture.ts';
import { candidateFixture, DEMANDS, priceFixture } from './fixtures/w15PlannerHotPaths.ts';

const sha1 = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');

describe('W15: planner hot paths', () => {
  it('reads comparable prices for 400 arrangements over 300 prose payers within a bound, unchanged', () => {
    const prices = priceFixture();
    const t = performance.now();
    const out = Array.from({ length: 400 }, (_, i) =>
      comparablePricesFor({ sector: null, demand: { name: DEMANDS[i % DEMANDS.length]!, claimId: null, from: 'INDUSTRY_MAP', ref: 'n' } }, prices),
    );
    const ms = performance.now() - t;
    // Before: 5,808 ms on this fixture (every arrangement re-read every payer's prose, ~200 RegExp compilations each). After: ~35 ms.
    expect(ms).toBeLessThan(1_500);
    // The readings the code produced before the fix, byte for byte.
    expect(sha1(out)).toBe('ecd647a3b7b5654478163c368412a34d13256ef7');
  });

  it('remembers a payer reading without changing it', () => {
    const payer = 'Pennsylvania Department of Transportation issued RFP 2026-114 for bridge inspection';
    const first = [payerNamedIn(payer), buyerPopulationName(payer)];
    expect(first).toEqual(['Pennsylvania Department of Transportation', 'state transportation departments']);
    expect([payerNamedIn(payer), buyerPopulationName(payer)]).toEqual(first);
    expect(payerNamedIn(null)).toBeNull();
    expect(buyerPopulationName(undefined)).toBeNull();
  });

  it('builds and rebuilds a 400-candidate plan set within a bound, unchanged', () => {
    const candidates = candidateFixture(400);
    const condition = { amount: 10_000, daysLeft: 60, confidence: null, capitalCeiling: 2_000, breadth: null };
    const t = performance.now();
    const set = buildPlanSet(candidates, condition);
    const rebuild = rebuildAfter(candidates, { kind: 'CHANNEL_FAILED', channel: 'Channel 3' }, condition);
    const ms = performance.now() - t;
    // Before: 1,345 ms (every candidate re-canonicalised every group's signature and lists). After: ~60 ms.
    expect(ms).toBeLessThan(700);
    expect([set.distinct, set.collapses.length]).toEqual([120, 280]);
    expect(sha1([set, rebuild])).toBe('a4af70d4b5ad0b9ba3d732d1c69f69e97f489103');
  });

  it("never sends the project's knowledge to an evaluation thread, and reads the same plan without it", async () => {
    const openings = GOAL_10K_PLAN.openings.map((o, i) => modelledOf(o, i + 1));
    const portfolio = { ...GOAL_10K_LIMITS, worlds: 150, seed: 11 };
    const baseline = evaluateGoalPortfolio({ ...portfolio, openings, knowledge: null, causal: false });
    // A stand-in for the project's knowledge: large, and read by nothing a `causal: false` evaluation does.
    const knowledge = { projectId: 'p', opportunities: new Map(Array.from({ length: 2_000 }, (_, i) => [`o${i}`, { id: `o${i}`, detail: 'x'.repeat(500) }])) } as never;
    const sent: unknown[] = [];
    const inline = inlineEvaluator();
    const watching: Evaluator = {
      threads: 1,
      evaluate: (input) => (sent.push(input.knowledge), inline.evaluate(input)),
      sweep: (job) => (sent.push(job.portfolio.knowledge), inline.sweep(job)),
      close: () => inline.close(),
    };
    const run = (withKnowledge: boolean, evaluator: Evaluator) =>
      reconstructPlan({ openings, portfolio: withKnowledge ? { ...portfolio, knowledge } : portfolio, baseline, required: 0.9, evaluator, explore: null });
    const withIt = await run(true, watching);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((k) => k === null)).toBe(true);
    const without = await run(false, inlineEvaluator());
    expect([withIt.best.key, withIt.best.reach, withIt.best.settledP50]).toEqual([without.best.key, without.best.reach, without.best.settledP50]);
  }, 120_000);
});
