/**
 * CHAL-33 repair F3: the plan's challenge and Brain's existing model
 * challenger (`operator/decisions.ts` `challengeDecision`, read back by
 * `domain/planReady.ts` as `hermes.challenge`) are one path, not two.
 *
 *   * the challenger's verdict enters the plan's challenge as an
 *     INDEPENDENT_MODEL check — PROCEED validates a deep step, REVISE holds it
 *     with the assumption and the alternative the challenger named;
 *   * the plan's consequence tier decides when that heavier challenge is
 *     required: deep requires it, and a minor reversible plan is never sent
 *     to a second model.
 */
import { describe, expect, it, vi } from 'vitest';
import { MODEL_CHALLENGE_SOURCE, OPTIMIZER_PRODUCER, challengePlan, checkFromModelChallenge, type ModelChallenge } from '../server/services/quant/challenge.ts';
import { challengePlanWithModel } from '../server/services/quant/modelChallenge.ts';
import type { challengeDecision } from '../server/services/operator/decisions.ts';
import { optimizePortfolio, type Activity, type PortfolioProblem } from '../server/services/quant/portfolio.ts';
import type { Challenge } from '../server/domain/decision.ts';
import type { PlanReadyFacts } from '../server/domain/planReady.ts';

const act = (key: string, over: Partial<Activity> = {}): Activity => ({
  key, label: key, cash: [60], days: [2], justified: true, capital: 10, evidence: { sampleSize: 30 }, ...over,
});

/** Two members, one of them large: the plan and its large step earn a deep review, and nothing else validates it. */
function deepPlan(): PortfolioProblem {
  return {
    target: 1000, deadlineDays: 10, startingCapital: 1000, worlds: 400,
    activities: [act('big', { cash: [1500], capital: 600, evidence: { sampleSize: 10_000 } }), act('tiny', { cash: [150], capital: 1, evidence: { sampleSize: 10_000 } })],
  };
}

/** One small reversible member against a large target. */
function minorPlan(): PortfolioProblem {
  return { target: 100_000, deadlineDays: 30, startingCapital: 1000, worlds: 200, activities: [act('probe', { cash: [5], capital: 1, evidence: { sampleSize: 10_000 } })] };
}

const proceed: Challenge = { verdict: 'PROCEED', hiddenAssumptions: [], missingVariables: [], strongerAlternative: null, reasons: 'holds', model: 'switchboard:strong-model' };
const revise: Challenge = {
  verdict: 'REVISE',
  hiddenAssumptions: ['buyers of big pay on delivery rather than on invoice'],
  missingVariables: ['payout hold'],
  strongerAlternative: 'take a 30% deposit before committing big',
  reasons: 'the cash timing assumption changes the choice',
  model: 'switchboard:strong-model',
};

const optimize = (p: PortfolioProblem) => optimizePortfolio({ ...p, challenge: false });

describe("the existing challenger's verdict is an independent check", () => {
  it('PROCEED agrees and REVISE disagrees, as INDEPENDENT_MODEL over different data from the optimizer', () => {
    const yes = checkFromModelChallenge(proceed)!;
    expect(yes).toMatchObject({ method: 'INDEPENDENT_MODEL', by: proceed.model, dataSource: MODEL_CHALLENGE_SOURCE, agrees: true });
    expect(yes.dataSource).not.toBe(OPTIMIZER_PRODUCER.dataSource);
    expect(yes.by).not.toBe(OPTIMIZER_PRODUCER.model);
    const no = checkFromModelChallenge(revise)!;
    expect(no.agrees).toBe(false);
    expect(no.assumptions).toContain(revise.hiddenAssumptions[0]);
    expect(no.alternative).toBe(revise.strongerAlternative);
  });

  it('an unreadable or absent verdict is no check at all, never a passing one', () => {
    expect(checkFromModelChallenge(null)).toBeNull();
    expect(checkFromModelChallenge({ ...proceed, verdict: 'MAYBE' })).toBeNull();
  });

  it('accepts the challenge exactly as planReady reads it back (hermes.challenge)', () => {
    const hermes: NonNullable<NonNullable<PlanReadyFacts['hermes']>['challenge']> = { verdict: 'PROCEED', model: 'gpu:big', reasons: 'ok', hiddenAssumptions: [], missingVariables: [], strongerAlternative: null };
    const asModel: ModelChallenge = hermes;
    expect(checkFromModelChallenge(asModel)?.agrees).toBe(true);
  });

  it('PROCEED clears the deep step that was held only for want of independent validation', () => {
    const p = deepPlan();
    const r = optimize(p);
    const before = challengePlan(p, r);
    const bigBefore = before.steps.find((s) => s.key === 'big')!;
    expect(bigBefore.scrutiny.tier).toBe('DEEP');
    expect(bigBefore.heldBy.some((h) => h.includes('no independent check has agreed'))).toBe(true);
    const after = challengePlan(p, r, { modelChallenge: proceed });
    expect(after.independentValidation.counted).toBe(1);
    expect(after.ran).toContain('INDEPENDENT_MODEL');
    expect(after.steps.find((s) => s.key === 'big')!.heldBy.some((h) => h.includes('no independent check has agreed'))).toBe(false);
    expect(after.modelChallenge).toMatchObject({ required: true, verdict: 'PROCEED', by: proceed.model, due: false });
  });

  it('REVISE holds the deep step, and the finding names the assumption, the test and the safer structure the challenger gave', () => {
    const p = deepPlan();
    const s = challengePlan(p, optimize(p), { modelChallenge: revise });
    expect(s.independentValidation.disagreeing).toBe(1);
    expect(s.modelChallenge.verdict).toBe('REVISE');
    const f = s.findings.find((x) => x.method === 'INDEPENDENT_MODEL' && x.assumption.includes(revise.model))!;
    expect(f.assumption).toContain(revise.hiddenAssumptions[0]);
    expect(f.test).toContain(revise.hiddenAssumptions[0]);
    expect(f.saferStructure).toContain(revise.strongerAlternative!);
    const big = s.steps.find((x) => x.key === 'big')!;
    expect(big.mayProceed).toBe(false);
    expect(big.heldBy.some((h) => h.includes('disagree'))).toBe(true);
  });

  it('reaches the optimizer through its own challenge options, so no caller needs a second path', () => {
    const r = optimizePortfolio({ ...deepPlan(), challenge: { modelChallenge: proceed } });
    expect(r.assurance!.challenge!.modelChallenge.verdict).toBe('PROCEED');
  });
});

describe('the consequence tier decides when the heavier model challenge is required', () => {
  it('a deep plan requires it, and it is due until the challenger answers', () => {
    const p = deepPlan();
    const s = challengePlan(p, optimize(p));
    expect(s.modelChallenge.required).toBe(true);
    expect(s.modelChallenge.due).toBe(true);
    expect(s.modelChallenge.because.join(' ')).toMatch(/deep review/);
  });

  it('a minor reversible plan does not require it', () => {
    const p = minorPlan();
    const s = challengePlan(p, optimize(p));
    expect(s.scrutiny.tier).not.toBe('DEEP');
    expect(s.steps.every((x) => x.scrutiny.tier !== 'DEEP')).toBe(true);
    expect(s.modelChallenge).toMatchObject({ required: false, due: false, verdict: null });
  });

  it('challengePlanWithModel asks the existing challenger only when required, and feeds its answer back', async () => {
    const challenger = vi.fn<typeof challengeDecision>(async () => revise);
    const minor = minorPlan();
    const skipped = await challengePlanWithModel(minor, optimize(minor), [], {}, challenger);
    expect(skipped.asked).toBe(false);
    expect(challenger).not.toHaveBeenCalled();

    const deep = deepPlan();
    const asked = await challengePlanWithModel(deep, optimize(deep), [], { goalId: 'goal_1' }, challenger);
    expect(asked.asked).toBe(true);
    expect(challenger).toHaveBeenCalledTimes(1);
    const [input, review] = challenger.mock.calls[0]!;
    expect(input.kind).toBe('ADOPT_PLAN');
    expect(input.goalId).toBe('goal_1');
    expect(review.ok).toBe(true);
    expect(review.highImpact).toBe(true);
    expect(asked.summary.modelChallenge).toMatchObject({ verdict: 'REVISE', due: false });
    expect(asked.summary.steps.find((x) => x.key === 'big')!.mayProceed).toBe(false);
  });

  it('a challenger that does not answer leaves the challenge due, never a pass', async () => {
    const deep = deepPlan();
    const r = await challengePlanWithModel(deep, optimize(deep), [], {}, async () => null);
    expect(r.asked).toBe(true);
    expect(r.summary.modelChallenge.due).toBe(true);
    expect(r.summary.independentValidation.counted).toBe(0);
  });
});
