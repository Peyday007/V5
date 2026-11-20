/**
 * The fulfilment lever (§99 FULFILMENT, owner 2026-11-20: "alternative
 * fulfillment", "supplier terms" are restructurings Brain must consider, each
 * with a defensible mechanism, and "this is not permission to invent
 * favorable assumptions").
 *
 * Production plan read, goal $5K/mo (2026-11-20 ~10:00Z): the plan reached 0%;
 * the binding analysis read "COST direct cost at the bottom of its range →
 * reach 78.3%" and the requirement analysis "supplier-cost ×5.03 · evidence
 * reaches ×20 or beyond · SUPPORTED", yet no operator could change how an
 * opening is fulfilled. And the "SUPPORTED" was itself false: the cost was an
 * UNKNOWN swept from $0, whose width was read as evidence of a $0 supplier.
 *
 * Now: (a) where the opening's own DIRECT evidence shows suppliers fulfilling
 * the same deliverable for less, the reconstruction re-routes it as an
 * ESTIMATE and the assumption-free reading improves; (b) a comparable from
 * other populations is at most an assumption, never the headline, and asks
 * who fulfils it for these buyers; an unevidenced sweep is no route and no
 * SUPPORTED requirement; (c) the plan step names the supplier route and is
 * integrity-clean.
 */
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { buildOperators, reconstructPlan, type StrategyState } from '../server/services/goals/reconstruction.ts';
import { fulfilmentRoute } from '../server/services/goals/fulfilment.ts';
import { assumedMovesOf } from '../server/services/goals/reasoning/directions.ts';
import { sweepVariables } from '../server/services/goals/reasoning/variables.ts';
import { adoptReconstruction, planSearchBrief, planSteps, type PlanReading } from '../server/services/goals/plan.ts';
import { integrityInput } from '../server/services/goals/planIntegrityInput.ts';
import { internalKeyIn, planIntegrity } from '../server/domain/planIntegrity.ts';

const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: { kind: 'CLAIM', ref: 'clm_fixture' }, note: 'evidenced' });
/** What fulfilling one deal is observed to cost: offshore bookkeepers at $100–$200, local firms at $600–$800. */
const OBSERVED = [100, 120, 150, 180, 200, 600, 650, 700, 750, 800];
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = q * (s.length - 1);
  const i = Math.floor(at);
  return s[i]! + (at - i) * (s[Math.min(s.length - 1, i + 1)]! - s[i]!);
};
/** A direct cost the quant engine inferred: DIRECT (this deliverable, these buyers) and justified, or a comparable from other populations. */
function inferredCost(tier: 'DIRECT' | 'COMPARABLE'): ModelInput {
  const direct = tier === 'DIRECT';
  return {
    value: null,
    low: OBSERVED[0]!,
    high: OBSERVED[OBSERVED.length - 1]!,
    provenance: direct ? 'EVIDENCE' : 'ASSUMPTION',
    source: { kind: 'CLAIM', ref: 'clm_bookkeeping_costs', note: 'published bookkeeping rates' },
    note: `inferred as a share of the top price: ${tier}`,
    ...(direct ? { distribution: { kind: 'EMPIRICAL' as const, values: OBSERVED } } : {}),
    inferred: { tier, justified: direct, p10: quantile(OBSERVED, 0.1), p50: quantile(OBSERVED, 0.5), p90: quantile(OBSERVED, 0.9), observations: OBSERVED.length, events: 0, populations: direct ? 1 : 3, sizedPopulations: direct ? 1 : 0 },
  };
}
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'nobody has established the direct cost; swept from nothing to 60% of the price' });

function opening(directCost: ModelInput): ModelledOpportunity {
  return {
    opportunity: { id: 'cop_bookkeeping', title: 'Monthly bookkeeping for dental practices', payer: 'Dental practice owners', offerScope: 'monthly bookkeeping' } as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(900),
    capital: fixed(0),
    hours: fixed(1),
    daysToCash: fixed(5),
    close: fixed(0.2),
    respond: fixed(0.02),
    directCost,
    volume: fixed(20),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
  };
}

const LIMITS = { remaining: 12_000, daysLeft: 30, capitalCeiling: 3000, beforeProof: 3000, perWeek: 3000, resources: null, contactsPerDay: fixed(500), worlds: 600, seed: 7 };

async function reconstruct(directCost: ModelInput) {
  const openings = [opening(directCost)];
  const baseline = evaluateGoalPortfolio({ ...LIMITS, openings });
  const r = await reconstructPlan({ openings, portfolio: LIMITS, baseline, required: 0.9, levers: [], explore: null });
  return { openings, baseline, r };
}

describe('the fulfilment lever', () => {
  it('(a) evidence of a cheaper supplier for the same deliverable re-routes it as an estimate, and the assumption-free reading improves', async () => {
    const f = fulfilmentRoute(opening(inferredCost('DIRECT')))!;
    expect(f.evidenced).toBe(true);
    expect(f.to!.high).toBeLessThanOrEqual(200);
    // The cheaper half of the same observations, still drawn as evidence.
    expect(f.cost!.provenance).toBe('EVIDENCE');
    expect(f.cost!.distribution).toEqual({ kind: 'EMPIRICAL', values: [100, 120, 150, 180, 200] });

    const { r, baseline } = await reconstruct(inferredCost('DIRECT'));
    const tried = r.rounds[0]!.tried.find((t) => t.changes.some((c) => c.dimension === 'FULFILMENT' && c.basis === 'ESTIMATE'));
    expect(tried, 'the fulfilment move is considered').toBeDefined();
    const move = r.best.changes.find((c) => c.dimension === 'FULFILMENT');
    expect(move, r.best.key).toBeDefined();
    expect(move!.basis).toBe('ESTIMATE');
    expect(move!.detail).toContain('accepted claim clm_bookkeeping_costs');
    // Counts toward the assumption-free reading: it survives the removal of every assumed move.
    expect(r.established!.changes.some((c) => c.dimension === 'FULFILMENT')).toBe(true);
    expect(r.established!.reach).toBeGreaterThan(baseline.best!.reach + 0.02);
    expect(r.challenges.find((c) => c.testedBy === 'FULFILMENT')!.status).toBe('ESTIMATE');
  });

  it('(b) a comparable from other populations is never adopted as evidence, and asks who fulfils it for these buyers', async () => {
    const f = fulfilmentRoute(opening(inferredCost('COMPARABLE')))!;
    expect(f.evidenced).toBe(false);
    const { r, baseline } = await reconstruct(inferredCost('COMPARABLE'));
    const fulfil = r.rounds.flatMap((x) => x.tried).flatMap((t) => t.changes).filter((c) => c.dimension === 'FULFILMENT');
    expect(fulfil.length).toBeGreaterThan(0);
    expect(fulfil.every((c) => c.basis === 'ASSUMPTION')).toBe(true);
    expect(fulfil[0]!.ask).toMatch(/^Who fulfils "monthly bookkeeping" for Dental practice owners, and at what published cost per deal/);
    // Never the headline: the assumption-free reading holds no fulfilment move and gains nothing from one.
    expect(assumedMovesOf(r.established!.changes)).toEqual([]);
    expect(r.established!.changes.some((c) => c.dimension === 'FULFILMENT')).toBe(false);
    expect(r.established!.reach).toBeLessThanOrEqual(baseline.best!.reach + 0.02);
    const { adoption } = adoptReconstruction({ reconstruction: r, baseline, openings: [{ opportunity: { id: 'cop_bookkeeping', title: 'Monthly bookkeeping for dental practices' } }] });
    expect(adoption.source).toBe('BASELINE');
  });

  it('(b) an unevidenced sweep is no route, no SUPPORTED requirement, and becomes the research question', async () => {
    const o = opening(swept(0, 540));
    expect(fulfilmentRoute(o)!.cost).toBeNull();
    const base: StrategyState = { openings: [o], committed: 0, changes: [] };
    const input = { openings: [o], portfolio: LIMITS, baseline: evaluateGoalPortfolio({ ...LIMITS, openings: [o] }), required: 0.9 };
    for (const op of buildOperators({ input, base, levers: [] }).filter((x) => x.dimension === 'FULFILMENT')) expect(op.apply(base)).toBeNull();
    const sweep = await sweepVariables({
      base, greedy: base, operators: buildOperators({ input, base, levers: [] }), operatorsFor: (t) => buildOperators({ input, base, levers: [], target: t }),
      remaining: LIMITS.remaining, daysLeft: LIMITS.daysLeft, required: 0.9, contactsPerDay: LIMITS.contactsPerDay, limits: LIMITS, maxMs: 2_000,
    });
    const cost = sweep.requirements.find((x) => x.condition === 'supplier-cost')!;
    // Before: "evidence reaches ×20 or beyond · SUPPORTED" — the width of a sweep from $0 read as a $0 supplier.
    expect(cost.evidencedTop).toBe(1);
    expect(cost.inEvidence).toBe(cost.needed === 1);
    const { r } = await reconstruct(swept(0, 540));
    expect(r.challenges.find((c) => c.testedBy === 'FULFILMENT')!.status).toBe('UNTESTED');
    // Cost binds (the production shape), so the route is asked of the world, and the goal round's brief says what to find.
    expect(r.diagnosis[0]!.factor).toBe('COST');
    expect(r.searchBrief).toContain('Fulfilment: Who fulfils "monthly bookkeeping" for Dental practice owners, and at what published cost per deal');
    expect(planSearchBrief(r, LIMITS.remaining, LIMITS.daysLeft)).toMatch(/^Direct cost binds: find who fulfils the plan's deliverables for these same buyers at a lower published cost per deal.* Who fulfils "monthly bookkeeping"/);
  });

  it('(c) the plan step names the supplier route to engage, and the plan is integrity-clean', async () => {
    const { r, baseline, openings } = await reconstruct(inferredCost('DIRECT'));
    const titles = new Map(openings.map((o) => [o.opportunity.id, o.opportunity.title]));
    const { adoption } = adoptReconstruction({ reconstruction: r, baseline, openings });
    expect(adoption.source).toBe('RECONSTRUCTED');
    const steps = planSteps({ adoption, reconstruction: r, sales: [], nextTest: null, permissionsMissing: [], titles, daysLeft: LIMITS.daysLeft });
    const step = steps.find((s) => s.stage?.stage === 'SUPPLY_TERMS')!;
    expect(step, steps.map((s) => s.label).join(' | ')).toBeDefined();
    expect(step.label).toMatch(/^Fulfil "Monthly bookkeeping for dental practices" through a supplier at the cheaper half of 10 observed fulfilment costs$/);
    expect(step.detail).toContain('at $100–$200 a deal instead of about $400');
    expect(step.basis).toBe('ESTIMATE');
    expect(step.cost).toBe(0);
    expect(step.startDay).toEqual({ low: 0, high: 3 });
    expect(step.executor).toMatchObject({ operation: 'NEGOTIATE_TERMS', provider: expect.stringMatching(/^a supplier at the cheaper half/) });
    expect(step.kill).toMatch(/no written quote from a supplier at the cheaper half .* by day 10 → fulfil at the cost the plan held before/);
    expect(step.owner).toBe('BRAIN');
    for (const s of steps) expect(internalKeyIn(`${s.label} ${s.detail}`), s.label).toBeNull();
    const reading = { goalId: 'wst_fulfilment', verdict: 'NEEDS_EVIDENCE', summary: 'A plan.', acceptance: { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: null, shortfalls: [], sentence: 'A candidate.' }, steps, nextTest: null, portfolio: null } as unknown as PlanReading;
    expect(planIntegrity(integrityInput(reading)).violations).toEqual([]);
  });
});
