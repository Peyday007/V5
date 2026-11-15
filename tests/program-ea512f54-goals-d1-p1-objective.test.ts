/**
 * GOAL-18-4 (S-0199, S-0200): a goal's objective is a configurable minimum
 * threshold; a confidence goal is a bound on the modelled chance below target,
 * never a floor; a cash floor comes only from enforceable rows; trade-offs are
 * explicit.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { combinationDaysToCash, composeGoalReadings, RECOMMENDATION_POLICY, type PlanAcceptance } from '../server/services/goals/plan.ts';
import { pathwayOf, type PathwayReading, type TransactionPathway } from '../server/services/goals/pathways.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { TargetReading } from '../server/services/goals/target.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';
import { objectiveForGoal } from '../server/services/goals/policy.ts';
import {
  cashFloor,
  DEFAULT_REQUIRED_CONFIDENCE,
  goalObjective,
  readOutcome,
  statedConfidence,
  tradeOffs,
  type EnforceableCommitment,
} from '../server/services/goals/objective.ts';

const NOW = new Date('2026-11-15T00:00:00Z');
const goal = (intent: string, cents = 1_000_000) => ({ title: 'Cash goal', intent, outcome: null, dueAt: '2026-12-15T00:00:00Z', target: { amountCents: cents } });

/** 1000 worlds spread evenly from `low` to `high` dollars. */
const worlds = (low: number, high: number) => Array.from({ length: 1000 }, (_, i) => low + ((high - low) * i) / 999);

describe('the objective is configurable per goal', () => {
  it('keeps the recorded default in step with the plan policy', () => {
    expect(DEFAULT_REQUIRED_CONFIDENCE).toBe(RECOMMENDATION_POLICY.requiredProbability);
  });

  it('gives two goals with different stated confidence different thresholds', () => {
    const a = goalObjective(goal('Collect $10K in 30 days with a 90% chance'), NOW);
    const b = goalObjective(goal('Collect $10K in 60 days with 75% confidence'), NOW);
    expect(a.requiredConfidence).toMatchObject({ value: 0.9, source: 'STATED' });
    expect(b.requiredConfidence).toMatchObject({ value: 0.75, source: 'STATED' });
    expect(a.horizonDays).toBe(30);
    expect(b.horizonDays).toBe(60);
  });

  it('records the default when no confidence is stated', () => {
    const o = goalObjective(goal('Make $10K before the deadline'), NOW);
    expect(o.requiredConfidence.source).toBe('DEFAULT');
    expect(o.requiredConfidence.value).toBe(RECOMMENDATION_POLICY.requiredProbability);
    expect(o.requiredConfidence.statement).toContain('RECOMMENDATION_POLICY.requiredProbability');
    expect(o.threshold).toBe(10_000);
    expect(o.continueBeyondThreshold).toBe(true);
  });

  it('reads stated upside, downside and reuse targets from the words, and nothing else', () => {
    const o = goalObjective(goal('Collect $10K, stretch to $25K, keep a buffer of $2,000 and reinvest to fund the next goal'), NOW);
    expect(o.targets.upside).toMatchObject({ value: 25_000, source: 'STATED' });
    expect(o.targets.downsideProtection).toMatchObject({ value: 2_000, source: 'STATED' });
    expect(o.targets.reusableCapital.source).toBe('STATED');
    expect(o.targets.capabilityGrowth.source).toBe('UNSTATED');
    expect(statedConfidence('reach at least 40% margin')).toBeNull();
  });

  it('resolves a goal row through the policy owner', async () => {
    await freshProject();
    const g = await createWorkstream({ projectId: null, title: 'Earn $10K', intent: 'with 80% probability in 90 days', purpose: 'REVENUE_DIRECT', createdByUserId: null });
    const o = await objectiveForGoal(g.id, NOW);
    expect(o?.requiredConfidence).toMatchObject({ value: 0.8, source: 'STATED' });
    expect(await objectiveForGoal('wst_missing', NOW)).toBeNull();
  });
});

describe('a confidence goal is a bound, never a floor', () => {
  const objective = goalObjective(goal('Collect $10K with a 90% chance'), NOW);

  it('reports expected, upper and adverse readings and accepts at most 10% below target', () => {
    const r = readOutcome(objective, worlds(9_000, 30_000), { calibrated: true });
    expect(r.allowedBelowTarget).toBeCloseTo(0.1);
    expect(r.modelledBelowTarget).toBeCloseTo(0.048, 2);
    expect(r.meetsConfidence).toBe(true);
    expect(r.status).toBe('ACCEPTED');
    expect(r.expected).toBeCloseTo(19_500, 0);
    expect(r.upper).toBeGreaterThan(r.expected);
    expect(r.adverse).toBeGreaterThan(10_000);
    // The worst world is below target and the goal still holds: it is not a floor.
    expect(Math.min(...worlds(9_000, 30_000))).toBeLessThan(10_000);
    expect(r.floor).toBeNull();
    expect(objective.meaning).toContain('at most a 10% modelled probability of finishing below');
    expect(objective.meaning).toContain('not a guarantee');
    expect(r.continueExploring).toBe(true);
    expect(r.surplusForSuccessors).toBeGreaterThan(0);
  });

  it('refuses a reading with more than 10% of worlds below target', () => {
    const r = readOutcome(objective, worlds(5_000, 20_000), { calibrated: true });
    expect(r.meetsConfidence).toBe(false);
    expect(r.status).toBe('CANDIDATE');
    expect(r.protection.adverseMargin).toBeLessThan(0);
  });

  it('withholds confidence and stays a candidate when uncalibrated', () => {
    const r = readOutcome(objective, worlds(20_000, 30_000), { calibrated: false });
    expect(r.meetsConfidence).toBeNull();
    expect(r.status).toBe('CANDIDATE');
    expect(r.confidenceWithheld).toMatch(/not calibrated/);
  });
});

describe('a cash floor comes only from enforceable rows', () => {
  const objective = goalObjective(goal('Collect $10K with a 90% chance'), NOW);
  const commit = (over: Partial<EnforceableCommitment>): EnforceableCommitment => ({ kind: 'ESCROW', amount: 4_000, counterparty: 'Acme', sourceRowId: 'opp_1', settlesInHorizon: true, ...over });

  it('is null without a supporting row and quantifies buffer and margin instead', () => {
    const r = readOutcome(objective, worlds(8_000, 20_000), { calibrated: true, commitments: [commit({ sourceRowId: null })], cashOnHand: 1_500 });
    expect(r.floor).toBeNull();
    expect(r.protection.cashBuffer).toBe(1_500);
    expect(r.protection.overTargetMargin).toBeCloseTo(4_000, 0);
  });

  it('counts enforceable rows inside the horizon and names correlated and systemic limits', () => {
    const f = cashFloor([commit({}), commit({ kind: 'DEPOSIT', amount: 1_000, counterparty: 'Beta', sourceRowId: 'opp_2' }), commit({ amount: 9_000, settlesInHorizon: false })]);
    expect(f?.amount).toBe(5_000);
    expect(f?.mechanisms).toEqual(['ESCROW', 'DEPOSIT']);
    expect(f?.limits.some((l) => l.startsWith('correlated: 80%'))).toBe(true);
    expect(f?.limits.some((l) => l.startsWith('systemic'))).toBe(true);
  });
});

describe('trade-offs are explicit', () => {
  it('reports cash velocity, uncertainty, shared dependencies, opportunity cost and upside', () => {
    const objective = goalObjective(goal('Collect $10K'), NOW);
    const fast = readOutcome(objective, worlds(11_000, 14_000), { calibrated: true });
    const wide = readOutcome(objective, worlds(6_000, 40_000), { calibrated: true });
    const [a, b] = tradeOffs(objective, [
      { key: 'fast', reading: fast, daysToCash: 20, sharedDependencies: ['instantly'], forgoneAlternative: wide.expected },
      { key: 'wide', reading: wide, daysToCash: null, sharedDependencies: [], forgoneAlternative: null },
    ]);
    expect(a).toMatchObject({ key: 'fast', sharedDependencies: ['instantly'], status: 'ACCEPTED' });
    expect(a!.cashVelocity).toBeCloseTo(fast.expected / 20);
    expect(a!.opportunityCost).toBeLessThan(0);
    expect(b!.uncertainty!).toBeGreaterThan(a!.uncertainty!);
    expect(b!.upside!).toBeGreaterThan(a!.upside!);
    expect(b!.cashVelocity).toBeNull();
    expect(b!.status).toBe('CANDIDATE');
  });
});

/*
 * F2-2: the plan's cash-velocity trade-off is read from each combination's own
 * settlement, never from the goal's days left — which made velocity identical
 * across combinations up to expected value, so a fast plan never won on speed.
 */
describe('the plan trades off cash velocity between combinations by their own settlement', () => {
  const ctx = { remaining: 10_000, daysLeft: 45, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now: NOW, capabilities: null };
  const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
  const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });
  const opening = (id: string, days: ModelInput): ModelledOpportunity => {
    const o = {
      id, projectId: 'prj_1', title: `Opening ${id}`, mechanism: 'PRODUCTIZED_SERVICE', industry: null,
      payer: `Payer ${id}`, reachableChannel: 'published business email', buyingSignal: 'posted asking for it', signalObservedAt: null,
      offerScope: 'one report', priceCents: 90_000, currency: 'USD', fulfillmentOwner: 'Brain', economicsNote: null, expiresAt: null,
      requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD',
    } as unknown as CashOpportunity;
    return {
      opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: true, price: evidence(900), capital: evidence(0), hours: unknown(1, 2), daysToCash: days,
      close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(90), volume: unknown(1, 200), agreed: false, agreedValue: 0, agreedDeals: 0,
      fulfilledBy: { value: 'Brain produces it', provenance: 'EVIDENCE', source: null }, competitiveAward: false,
    } as unknown as ModelledOpportunity;
  };
  const fast = pathwayOf(opening('fast', evidence(5)), null, ctx);
  const slow = pathwayOf(opening('slow', evidence(40)), null, ctx);
  const unsettled: TransactionPathway = { ...pathwayOf(opening('unsettled', unknown(1, 90)), null, ctx), daysToCash: { value: null, low: null, high: null, status: 'UNKNOWN', basis: 'nobody said' } };

  it('reads the slowest member of a combination, and unknown when any member is unknown', () => {
    const pathways = [fast, slow, unsettled];
    expect(combinationDaysToCash(['fast'], pathways)).toBe(5);
    expect(combinationDaysToCash(['fast', 'slow'], pathways)).toBe(40);
    expect(combinationDaysToCash(['fast', 'unsettled'], pathways)).toBeNull();
    expect(combinationDaysToCash(['missing'], pathways)).toBeNull();
    expect(combinationDaysToCash([], pathways)).toBeNull();
  });

  it('gives combinations with equal expected value but different settlement different velocities in the composed plan', () => {
    const combo = (id: string) => ({ members: [{ opportunityId: id, title: `Opening ${id}`, share: null }], reach: 0.5, settledP10: 6_000, settledP50: 11_000, settledP90: 16_000, capitalShort: 0, overSpend: 0 });
    const portfolio = {
      basis: 'COVERAGE', worlds: 1000, best: combo('fast'), alternatives: [combo('slow'), combo('unsettled')], demand: [],
      limits: { target: 10_000, deadlineDays: 45, startingCapital: null, perArrangement: 375, spendCeiling: null, contactsPerDay: { value: 60, low: 60, high: 60, source: 'test' }, correlation: 0 },
    } as unknown as GoalPortfolio;
    const target = {
      metric: 'COLLECTED', metricLabel: 'collected', currency: 'USD', projectId: 'prj_1', targetCents: 1_000_000, achievedCents: 0, remainingCents: 1_000_000,
      achieved: false, daysLeft: 45, counted: [], notCounted: [], since: NOW.toISOString(), capitalCeilingCents: null, capitalBeforeProofCents: null,
    } as unknown as TargetReading;
    const acceptance = { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, accepted: null, candidate: null, shortfalls: [], sentence: '' } as unknown as PlanAcceptance;
    const { objective } = composeGoalReadings({
      objective: goalObjective(goal('Collect $10K in 45 days'), NOW),
      target, portfolio, pathways: { pathways: [fast, slow, unsettled] } as unknown as PathwayReading, arrangements: [], reconstruction: null, acceptance,
    });
    const by = (k: string) => objective.tradeOffs.find((t) => t.key === k)!;
    expect(by('fast').cashVelocity).not.toBeNull();
    expect(by('slow').cashVelocity).not.toBeNull();
    expect(by('fast').cashVelocity! / by('slow').cashVelocity!).toBeCloseTo(40 / 5);
    expect(by('unsettled').cashVelocity).toBeNull();
  });
});
