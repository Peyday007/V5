import { describe, expect, it } from 'vitest';
import { gateRecommendation, policyFor, supportedProbability, GOAL_STAGES, type GateInput } from '../server/services/goals/policy.ts';
import type { GoalTarget } from '../server/domain/register.ts';

const target: GoalTarget = {
  metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId: 'p',
  capitalCeilingCents: 50_000, hoursCeiling: null, resources: null,
  capitalBeforeProofCents: 20_000, capitalPerWeekCents: 10_000, setAt: '2026-10-01T00:00:00.000Z',
};
const squeeze = policyFor({ target, daysLeft: 30 });
const twoSetbacks = [{ setbacks: ['payment delay', 'supplier failure'], goalMet: true }];
const good: GateInput = {
  policy: squeeze,
  probability: { measured: { lowerBound: 0.93, sampleSize: 20 }, modelled: null },
  combinedSetbacks: twoSetbacks,
  adverseShare: { lowerBound: 0.85 },
};

describe('goal policy', () => {
  it('reads the goal’s own target, deadline, capital limits and default reliability', () => {
    expect(squeeze.target).toEqual({ amountCents: 1_000_000, currency: 'USD' });
    expect(squeeze.deadlineDays).toBe(30);
    expect(squeeze.capital).toEqual({ ceilingCents: 50_000, beforeProofCents: 20_000, perWeekCents: 10_000 });
    expect(squeeze.reliability).toEqual({ normal: 0.9, adverse: 0.8 });
  });
  it('accepts per-goal reliability and ignores nonsense', () => {
    expect(policyFor({ target, daysLeft: 5, overrides: { reliability: { normal: 0.95, adverse: 0.7 } } }).reliability).toEqual({ normal: 0.95, adverse: 0.7 });
    expect(policyFor({ target, overrides: { reliability: { normal: 0.7, adverse: 0.9 } } }).reliability).toEqual({ normal: 0.9, adverse: 0.8 });
  });
  it('refuses a probability without supporting evidence and the plan is not recommendable', () => {
    const r = gateRecommendation({ ...good, probability: { measured: null, modelled: null, sweepCoverage: 0.97 } });
    expect(r.recommendable).toBe(false);
    expect(r.probability).toMatchObject({ supported: false });
    expect(r.reasons.join(' ')).toMatch(/not a probability/);
  });
  it('does not accept a model that leaves a stage of the complete goal unestablished', () => {
    const p = supportedProbability({ measured: null, modelled: { estimate: 0.95, lowerBound: 0.92, establishedStages: ['ACQUISITION', 'PAYMENT'] } });
    expect(p.supported).toBe(false);
    expect(supportedProbability({ measured: null, modelled: { estimate: 0.95, lowerBound: 0.92, establishedStages: [...GOAL_STAGES] } }).supported).toBe(true);
  });
  it('passes when evidence, the standards and combined setbacks all hold', () => {
    expect(gateRecommendation(good)).toMatchObject({ recommendable: true, reasons: [] });
  });
  it('fails a plan that fails combined ordinary setbacks, or never tested them', () => {
    const failed = gateRecommendation({ ...good, combinedSetbacks: [{ setbacks: ['a', 'b'], goalMet: false }] });
    expect(failed.recommendable).toBe(false);
    expect(gateRecommendation({ ...good, combinedSetbacks: [{ setbacks: ['a'], goalMet: true }] }).recommendable).toBe(false);
  });
  it('holds below-standard chances back', () => {
    expect(gateRecommendation({ ...good, probability: { measured: { lowerBound: 0.6, sampleSize: 30 }, modelled: null } }).recommendable).toBe(false);
    expect(gateRecommendation({ ...good, adverseShare: { lowerBound: 0.5 } }).recommendable).toBe(false);
  });
  it('does not judge long-term or creative goals under squeeze rules', () => {
    for (const kind of ['LONG_TERM_VENTURE', 'CREATIVE', 'RESEARCH', 'RECURRING_INCOME'] as const) {
      const policy = policyFor({ kind, target, daysLeft: 3 });
      expect(policy.reliability).toBeNull();
      expect(policy.target).toBeNull();
      const r = gateRecommendation({ policy, probability: { measured: null, modelled: null }, combinedSetbacks: [] });
      expect(r).toMatchObject({ notSqueeze: true, recommendable: true, reasons: [] });
    }
  });
});
