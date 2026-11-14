/**
 * Planning recovery (2026-11-14): an independent acceptance of general-purpose
 * cash planning. These objectives are not the $10K fixture's industry, size or
 * horizon, and the assertions are written by the evaluator, not derived from
 * the planner's own critics: a plan never spends money the owner did not set
 * aside, never claims more than an independent market bound, never calls a
 * coverage a probability, and an arithmetic impossibility is reported as one
 * rather than dressed up as a plan.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { reconstructPlan } from '../server/services/goals/reconstruction.ts';
import { requiredStructures } from '../server/services/goals/pathways.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { GOAL_10K_LIMITS, GOAL_10K_OPENINGS, GOAL_10K_RECORD } from './fixtures/goal10k.ts';

const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function opening(id: string, title: string, index: number, over: Partial<ModelledOpportunity>): ModelledOpportunity {
  return {
    opportunity: { id, title } as ModelledOpportunity['opportunity'],
    index, tier: 'QUALIFIED', repeatable: true,
    price: swept(100, 500), capital: swept(0, 100), hours: fixed(0), daysToCash: swept(3, 15),
    close: swept(0.05, 0.25), respond: swept(0.005, 0.03), directCost: swept(0, 50), volume: swept(10, 200),
    agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false,
    ...over,
  };
}

interface Objective {
  name: string;
  limits: { remaining: number; daysLeft: number; capitalCeiling: number; beforeProof: number; perWeek: number; resources: string };
  openings: ModelledOpportunity[];
}

const OBJECTIVES: Objective[] = [
  {
    name: '$100 in 48 hours, no capital (digital goods)',
    limits: { remaining: 100, daysLeft: 2, capitalCeiling: 0, beforeProof: 0, perWeek: 0, resources: 'No money to spend.' },
    openings: [
      opening('o_templates', 'Spreadsheet templates sold on a marketplace listing', 1, { price: swept(9, 29), directCost: fixed(0), capital: fixed(0), daysToCash: swept(0, 2), volume: swept(0, 15), close: swept(0.02, 0.1) }),
      opening('o_gig', 'Posted data-cleanup gig', 2, { repeatable: false, price: swept(40, 120), capital: fixed(0), directCost: fixed(0), daysToCash: swept(1, 7), volume: swept(1, 1), close: swept(0.1, 0.4) }),
    ],
  },
  {
    name: '$100,000 in 90 days, $10,000 capital (B2B software implementation)',
    limits: { remaining: 100_000, daysLeft: 90, capitalCeiling: 10_000, beforeProof: 1000, perWeek: 2500, resources: 'Up to $10,000.' },
    openings: [
      opening('o_crm', 'CRM implementation for 20–50 person firms', 1, { price: swept(4000, 12000), directCost: swept(1500, 5000), close: swept(0.03, 0.15), daysToCash: swept(14, 45), volume: swept(10, 300) }),
      opening('o_audit', 'Fixed-price workflow audit', 2, { price: swept(1500, 3000), directCost: swept(200, 600), close: swept(0.05, 0.2), daysToCash: swept(7, 21), volume: swept(20, 400) }),
      opening('o_support', 'Monthly admin support retainer', 3, { price: swept(800, 2000), directCost: swept(300, 900), close: swept(0.04, 0.15), daysToCash: swept(30, 30), volume: swept(10, 150) }),
    ],
  },
  {
    name: '$1,000,000 in one year, $50,000 capital (wholesale distribution)',
    limits: { remaining: 1_000_000, daysLeft: 365, capitalCeiling: 50_000, beforeProof: 5000, perWeek: 10_000, resources: 'Up to $50,000.' },
    openings: [
      opening('o_wholesale', 'Restaurant supply wholesale route', 1, { price: swept(2000, 6000), directCost: swept(1500, 4800), capital: swept(1500, 4800), close: swept(0.05, 0.25), daysToCash: swept(15, 45), volume: swept(50, 1500) }),
      opening('o_private', 'Private-label cleaning products to janitorial firms', 2, { price: swept(3000, 9000), directCost: swept(1800, 6000), capital: swept(1800, 6000), close: swept(0.03, 0.12), daysToCash: swept(30, 60), volume: swept(30, 800) }),
    ],
  },
  {
    name: '$1,000,000 in 48 hours with no capital (infeasible as stated)',
    limits: { remaining: 1_000_000, daysLeft: 2, capitalCeiling: 0, beforeProof: 0, perWeek: 0, resources: 'None.' },
    openings: [
      opening('o_consult', 'One-day consulting engagement', 1, { price: swept(1000, 5000), capital: fixed(0), directCost: fixed(0), daysToCash: swept(7, 30), volume: swept(1, 20) }),
    ],
  },
];

/** The most cash the openings' markets can pay even if every buyer bought at the highest price any move may reach (×4 a unit, ×10 units a bundle). */
function marketBound(openings: ModelledOpportunity[]): number {
  return openings.reduce((sum, o) => sum + (o.volume.high ?? 0) * (o.price.high ?? 0) * 4 * 10, 0);
}

async function plan(o: Objective) {
  const portfolio = { ...o.limits, worlds: 600, seed: 7 };
  const baseline = evaluateGoalPortfolio({ ...portfolio, openings: o.openings });
  const r = await reconstructPlan({ openings: o.openings, portfolio, baseline, required: 0.9, explore: null });
  return { baseline, r };
}

describe('planning recovery: general-purpose cash planning holds its economics across objectives', () => {
  for (const o of OBJECTIVES) {
    it(o.name, async () => {
      const { r } = await plan(o);
      // Never spends money the owner did not set aside.
      expect(r.best.committed).toBeLessThanOrEqual(o.limits.capitalCeiling + 1e-6);
      // Never claims more than the markets it holds could pay.
      expect(r.best.settledP50).toBeLessThanOrEqual(marketBound(o.openings));
      // Never more than the arithmetic allows: the kept plan's reach never exceeds what the openings could do at their best.
      expect(r.best.reach).toBeLessThanOrEqual(r.headroom.reach + 0.02);
      // An assumed change is coverage, never a probability.
      if (r.best.changes.some((c) => c.basis === 'ASSUMPTION')) expect(r.confidence.basis).toBe('COVERAGE');
      // A flagged (implausible) reading is never the kept plan.
      expect(r.flags.some((f) => f.key === r.best.key)).toBe(false);
    }, 240_000);
  }

  it('reports an impossible objective as impossible instead of constructing a plan for it', async () => {
    const o = OBJECTIVES[3]!;
    const { r } = await plan(o);
    expect(r.best.reach).toBeLessThan(0.05);
    expect(r.structural).toBe(true);
    const s = requiredStructures({ remaining: o.limits.remaining, daysLeft: o.limits.daysLeft, currency: 'USD', perArrangement: 0, spendCeiling: 0, outreachPerDay: { low: 10, high: 60, stated: false } });
    expect(s.structures.filter((x) => x.verdict !== 'IMPOSSIBLE').every((x) => x.kind === 'INSTANT')).toBe(true);
  }, 240_000);

  it('the $10K production case: the plan stays inside economics and is not called accepted on assumptions', async () => {
    const portfolio = { ...GOAL_10K_LIMITS, measuredRates: GOAL_10K_RECORD, worlds: 600, seed: 11 };
    const baseline = evaluateGoalPortfolio({ ...portfolio, openings: GOAL_10K_OPENINGS });
    const r = await reconstructPlan({ openings: GOAL_10K_OPENINGS, portfolio, baseline, required: 0.9, explore: null });
    expect(r.best.committed).toBeLessThanOrEqual(3000);
    // Production read a $34.5M median for this goal before the recovery; ten times the target from $3K in 30 days is not a plan.
    expect(r.best.settledP50).toBeLessThan(100_000);
    expect(r.confidence.basis).toBe('COVERAGE');
    // The as-is floor rests on no assumed move.
    expect((r.floor?.changes ?? []).every((c) => c.basis !== 'ASSUMPTION')).toBe(true);
  }, 240_000);

  it('responds to a changed constraint: less capital, a plan that spends less', async () => {
    const o = OBJECTIVES[1]!;
    const tight = { ...o, limits: { ...o.limits, capitalCeiling: 500, beforeProof: 200, perWeek: 200 } };
    const { r } = await plan(tight);
    expect(r.best.committed).toBeLessThanOrEqual(500);
  }, 240_000);
});
