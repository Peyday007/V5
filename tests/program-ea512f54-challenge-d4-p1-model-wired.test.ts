/**
 * CHAL-33 repair F3 (unreachable): Brain's existing model challenger is asked
 * about a plan from the path the running Brain uses — `optimizePortfolio`,
 * which every goal plan read goes through (`goals/portfolio.ts`) — not only
 * from a function nothing calls.
 *
 *   * a deep plan with no supplied answer starts one ask of the challenger,
 *     with the plan stated as an ADOPT_PLAN decision, and stays held as due;
 *   * the next read of the same plan binds the answer as an INDEPENDENT_MODEL
 *     check, without asking again;
 *   * a minor reversible plan is never sent to the challenger;
 *   * silence or a failure is no answer, never a pass, and is not re-asked
 *     until the retry interval has passed;
 *   * an answer the caller supplied is used as given, and no second ask is made.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Challenge, DecisionInput } from '../server/domain/decision.ts';
import { optimizePortfolio, type Activity, type PortfolioProblem } from '../server/services/quant/portfolio.ts';
import {
  MODEL_CHALLENGE_RETRY_MS,
  forgetPlanChallenges,
  modelChallengeFor,
  setPlanChallengeAsker,
  settlePlanChallenges,
} from '../server/services/quant/modelChallenge.ts';
import { challengePlan } from '../server/services/quant/challenge.ts';

const act = (key: string, over: Partial<Activity> = {}): Activity => ({
  key, label: key, cash: [60], days: [2], justified: true, capital: 10, evidence: { sampleSize: 30 }, ...over,
});

function deepPlan(): PortfolioProblem {
  return {
    target: 1000, deadlineDays: 10, startingCapital: 1000, worlds: 400,
    activities: [act('big', { cash: [1500], capital: 600, evidence: { sampleSize: 10_000 } }), act('tiny', { cash: [150], capital: 1, evidence: { sampleSize: 10_000 } })],
  };
}

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

beforeEach(() => forgetPlanChallenges());
afterEach(() => {
  setPlanChallengeAsker(null);
  forgetPlanChallenges();
});

describe('the optimizer asks the existing challenger when a plan earns it', () => {
  it('a deep plan starts one ask, stays due, and the next read binds the answer as an independent check', async () => {
    const asker = vi.fn(async (_input: DecisionInput) => proceed);
    setPlanChallengeAsker(asker);
    const first = optimizePortfolio(deepPlan());
    expect(first.assurance!.challenge!.modelChallenge).toMatchObject({ required: true, due: true, verdict: null });
    expect(first.assurance!.claimsAtLeast90).toBe(false);
    expect(asker).toHaveBeenCalledTimes(1);
    expect(asker.mock.calls[0]![0].kind).toBe('ADOPT_PLAN');

    await settlePlanChallenges();
    const second = optimizePortfolio(deepPlan());
    const summary = second.assurance!.challenge!;
    expect(summary.modelChallenge).toMatchObject({ required: true, due: false, verdict: 'PROCEED', by: proceed.model });
    expect(summary.ran).toContain('INDEPENDENT_MODEL');
    expect(summary.independentValidation.counted).toBe(1);
    expect(asker).toHaveBeenCalledTimes(1);
  });

  it('a REVISE from the challenger holds the deep step on the next read', async () => {
    setPlanChallengeAsker(async () => revise);
    optimizePortfolio(deepPlan());
    await settlePlanChallenges();
    const summary = optimizePortfolio(deepPlan()).assurance!.challenge!;
    expect(summary.modelChallenge.verdict).toBe('REVISE');
    expect(summary.independentValidation.disagreeing).toBe(1);
    expect(summary.steps.find((s) => s.key === 'big')!.mayProceed).toBe(false);
  });

  it('a minor reversible plan is never sent to the challenger', async () => {
    const asker = vi.fn(async () => proceed);
    setPlanChallengeAsker(asker);
    const r = optimizePortfolio(minorPlan());
    await settlePlanChallenges();
    expect(r.assurance!.challenge!.modelChallenge.required).toBe(false);
    expect(asker).not.toHaveBeenCalled();
  });

  it('silence or a failure is no answer, stays due, and is not re-asked before the retry interval', async () => {
    const asker = vi.fn(async (): Promise<Challenge | null> => {
      throw new Error('no model answered');
    });
    setPlanChallengeAsker(asker);
    const p = deepPlan();
    optimizePortfolio(p);
    await settlePlanChallenges();
    const again = optimizePortfolio(p);
    expect(again.assurance!.challenge!.modelChallenge.due).toBe(true);
    expect(again.assurance!.claimsAtLeast90).toBe(false);
    expect(asker).toHaveBeenCalledTimes(1);
    // After the retry interval the same plan is asked again.
    const r = optimizePortfolio({ ...p, challenge: false });
    const s = challengePlan(p, r);
    expect(modelChallengeFor(p, r, s, Date.now() + MODEL_CHALLENGE_RETRY_MS + 1)).toBeUndefined();
    await settlePlanChallenges();
    expect(asker).toHaveBeenCalledTimes(2);
  });

  it('an answer the caller supplied is used as given, and nothing is asked', async () => {
    const asker = vi.fn(async () => revise);
    setPlanChallengeAsker(asker);
    const r = optimizePortfolio({ ...deepPlan(), challenge: { modelChallenge: proceed } });
    await settlePlanChallenges();
    expect(r.assurance!.challenge!.modelChallenge.verdict).toBe('PROCEED');
    expect(asker).not.toHaveBeenCalled();
  });

  it('the goal plan path reaches it: goals/portfolio.ts reads its plan through optimizePortfolio with the challenge on', () => {
    const source = readFileSync('server/services/goals/portfolio.ts', 'utf8');
    const call = source.slice(source.indexOf('const result = optimizePortfolio({'), source.indexOf('const combination ='));
    expect(call.length).toBeGreaterThan(0);
    expect(call).not.toMatch(/challenge:\s*false/);
    const optimizer = readFileSync('server/services/quant/portfolio.ts', 'utf8');
    expect(optimizer).toMatch(/modelChallengeFor\(problem, result, plain\)/);
  });
});
