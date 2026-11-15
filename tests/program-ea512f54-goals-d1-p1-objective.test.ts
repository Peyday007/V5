/**
 * GOAL-18-4 (S-0199, S-0200): a goal's objective is a configurable minimum
 * threshold; a confidence goal is a bound on the modelled chance below target,
 * never a floor; a cash floor comes only from enforceable rows; trade-offs are
 * explicit.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { RECOMMENDATION_POLICY } from '../server/services/goals/plan.ts';
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
