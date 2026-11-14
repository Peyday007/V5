/**
 * §99: when a goal's plan falls short of its required probability, Brain
 * diagnoses why, constructs materially different strategies across
 * dimensions, weighs spending its money on what binds, and says honestly what
 * the strongest one is worth. The $10K goal as production read it on
 * 2026-11-09 is the regression case.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { reconstructPlan, renderReconstruction, RETURN_BOUND } from '../server/services/goals/reconstruction.ts';
import { ACQUISITION_LEVERS, dailyVolumePlan, purchaseCapacity } from '../server/services/goals/acquisitionLevers.ts';
import { assessOutreachRecord } from '../server/services/goals/evidenceAuthority.ts';
import { reconstructionDiagnosis } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';

const portfolioInput = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 1000, seed: 11 };
const baseline = evaluateGoalPortfolio({ ...portfolioInput, openings: GOAL_10K_OPENINGS });
const r = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio: portfolioInput, baseline, required: 0.9 });
/** What Brain did before §99: the workspace record bound every opening, and nothing was reconstructed. */
const before = evaluateGoalPortfolio({ ...portfolioInput, openings: GOAL_10K_OPENINGS, forceMeasured: true });
const tried = r.rounds.flatMap((x) => x.tried);
const dims = new Set(tried.flatMap((t) => t.changes.map((c) => c.dimension)));

describe('§99 regression: the $10K plan', () => {
  it('recognises that the old Instantly record measured a defective implementation, keeps it as the as-is floor, and does not let it bind', () => {
    const a = assessOutreachRecord(GOAL_10K_RECORD);
    expect(a.authority).toBe('CONTEXT_ONLY');
    expect(a.defects.map((d) => d.kind)).toEqual(expect.arrayContaining(['LIST_QUALITY', 'DIFFERENT_OFFER', 'FEW_REPLIES']));
    expect(baseline.measuredRates!.applied).toBe('AS_IS_FLOOR_ONLY');
    expect(baseline.measuredRates!.asIs!.reach).toBeLessThan(baseline.best!.reach);
    expect(r.challenges[0]!.finding).toMatch(/CONTEXT_ONLY/);
  });

  it('explores materially different strategies across dimensions, not percentages of the same one', () => {
    for (const d of ['CAPACITY', 'ACQUISITION', 'PARTNER', 'TRANSACTION', 'CAPITAL', 'CASH_TIMING'] as const) expect(dims.has(d)).toBe(true);
    // The kept plan changes how the business works, not an estimate.
    expect(r.best.changes.length).toBeGreaterThanOrEqual(2);
    expect(r.best.changes.every((c) => !c.label.startsWith('test:'))).toBe(true);
    expect(r.best.reach - r.baseline.reach).toBeGreaterThan(0.1);
    // Diagnosis names what binds, ranked, and the ceiling of the openings held.
    expect(r.diagnosis.map((d) => d.factor)).toEqual(expect.arrayContaining(['VOLUME', 'REPLY', 'CLOSE', 'PRICE', 'CASH_TIMING', 'CAPITAL', 'MARKET_SIZE']));
    expect(r.diagnosis[0]!.liftReach).toBeGreaterThanOrEqual(r.diagnosis[r.diagnosis.length - 1]!.liftReach);
  });

  it('evaluates spending the goal\'s money on capacity, and costs 10,000 a day instead of assuming it either way', () => {
    const capacity = tried.filter((t) => t.changes.some((c) => c.dimension === 'CAPACITY'));
    expect(capacity.length).toBeGreaterThan(0);
    expect(capacity.every((t) => t.committed <= 3000)).toBe(true);
    // A purchase within the before-proof limit is costed from sourced unit prices.
    const buy = purchaseCapacity(ACQUISITION_LEVERS.find((l) => l.key === 'cold-email-prewarmed')!, 375, 30)!;
    expect(buy.cost).toBeLessThanOrEqual(375);
    expect(buy.addedPerDay.high).toBeGreaterThan(0);
    const tenK = r.volumePlans.find((p) => p.perDay === 10_000)!;
    expect(tenK.units.low).toBeGreaterThanOrEqual(334);
    expect(tenK.costInWindow.high).toBeGreaterThan(3000);
    expect(tenK.feasible).toBe(false);
    expect(tenK.reasons.join(' ')).toMatch(/before proof/);
    // Not "impossible" by fiat: a volume the limits do allow reads feasible.
    expect(dailyVolumePlan(ACQUISITION_LEVERS[0]!, 200, 30, { beforeProof: 375, perWeek: 750, capitalCeiling: 3000 }).feasible).toBe(true);
  });

  it('can change the acquisition method and the financing structure of the business', () => {
    const bought = tried.find((t) => t.changes.some((c) => c.dimension === 'ACQUISITION'));
    expect(bought?.changes[0]!.detail).toMatch(/leads at/);
    const prepaid = tried.find((t) => t.key.includes('prepaid-fulfilment'));
    expect(prepaid).toBeTruthy();
    // Suppliers and partners: sell through someone who already holds the buyers, commission sourced, volume assumed.
    const partner = tried.find((t) => t.changes.some((c) => c.dimension === 'PARTNER'))!;
    expect(partner.changes[0]!.detail).toMatch(/10–30%/);
    expect(partner.changes[0]!.basis).toBe('ASSUMPTION');
  });

  it('states the strongest plan as an execution sequence', () => {
    expect(r.best.changes.every((c) => c.startDay !== undefined)).toBe(true);
    expect(renderReconstruction(r).some((l) => /^\s+day \d+–\d+/.test(l))).toBe(true);
  });

  it('asks the world for openings beyond its existing types, from the binding constraint, through the goal round it already runs', () => {
    expect(r.searchBrief).toMatch(/any industry, including ones not searched before/);
    const d = reconstructionDiagnosis(r);
    expect(d[0]!.cause).toBe('STRATEGY_RECONSTRUCTION');
    expect(d[0]!.instruction).toBe(r.searchBrief);
  });

  it('never calls coverage a probability, and states what the strongest plan needs and how it does on the old record', () => {
    expect(r.best.basis).toBe('COVERAGE');
    expect(r.confidence.statement).toMatch(/not a probability/);
    expect(r.confidence.assumed.length).toBeGreaterThan(0);
    expect(r.floor).not.toBeNull();
    expect(r.floor!.reach).toBeLessThanOrEqual(r.best.reach + 0.02);
    expect(r.requiredReply === null || r.requiredReply > 0).toBe(true);
    expect(renderReconstruction(r).join('\n')).toMatch(/as-is/);
  });

  it('concludes on a plausible plan: its median is within the bound on the money behind it, or the reading is flagged and not concluded with (C-4)', () => {
    const ratio = r.best.settledP50 / Math.max(1, r.best.committed + (portfolioInput.capitalCeiling ?? 0));
    expect(ratio <= RETURN_BOUND || (r.best.implausible ?? []).some((f) => f.kind === 'RETURN')).toBe(true);
    expect(r.best.implausible ?? []).toHaveLength(0);
    // Production read p50 $34.5M on this goal's limits; the fixture read $76,826 on $364 before the repair.
    expect(r.best.settledP50).toBeLessThan(RETURN_BOUND * (r.best.committed + 3000));
    expect(r.best.reach).toBeLessThanOrEqual(r.headroom.reach + 0.02);
  });

  it('improves on what Brain produced before §99, and evaluates each strategy once', () => {
    expect(r.best.reach).toBeGreaterThan(before.best!.reach + 0.2);
    const keys = tried.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(r.evaluations).toBeLessThan(100);
  });
});

describe('§99 is general: any goal, any openings', () => {
  const fixed = (v: number): ModelInput => ({ value: v, low: v, high: v, provenance: 'EVIDENCE', source: null, note: '' });
  const one = (id: string, index: number, over: Partial<ModelledOpportunity>): ModelledOpportunity => ({
    opportunity: { id, title: id } as ModelledOpportunity['opportunity'],
    index,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(400),
    capital: fixed(0),
    hours: fixed(1),
    daysToCash: fixed(4),
    close: fixed(0.2),
    respond: fixed(0.02),
    directCost: fixed(0),
    volume: fixed(1000),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    ...over,
  });
  const limits = { remaining: 2000, daysLeft: 14, capitalCeiling: 500, beforeProof: 200, perWeek: 300, resources: '40 emails a day', worlds: 800, seed: 3 };
  const openings = [one('a', 1, {}), one('b', 2, { price: fixed(90) })];
  const base = evaluateGoalPortfolio({ ...limits, openings });

  it('reconstructs a different goal with no knowledge of the $10K case, and reads probability only when every input is evidence', async () => {
    const rr = await reconstructPlan({ openings, portfolio: limits, baseline: base, required: 0.9 });
    expect(rr.diagnosis.length).toBeGreaterThan(0);
    expect(rr.rounds[0]!.tried.length).toBeGreaterThan(0);
    // Every input is evidence and the owner stated the outreach: the baseline is a probability.
    expect(rr.baseline.basis).toBe('PROBABILITY');
    // A strategy that rests on an assumption is never stated as a probability.
    if (rr.best.changes.some((c) => c.basis !== 'MEASURED')) expect(rr.confidence.statement).toMatch(/not a probability/);
  });
});
