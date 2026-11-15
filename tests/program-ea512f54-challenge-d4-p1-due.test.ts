/**
 * CHAL-33 repair F3, second finding: a due model challenge binds.
 *
 * `ChallengeSummary.modelChallenge.due` — a plan or step that earns a deep
 * review whose required independent-model challenge has not answered — used
 * to be computed and then read by nothing: the assurance every reader acts on
 * kept claiming 90% as if the plan had been validated. It now holds the claim
 * and owes the challenge as research, and the challenger's answer, once it
 * arrives through `challengePlanWithModel`, is what lifts or keeps that hold.
 */
import { describe, expect, it } from 'vitest';
import { challengePlan } from '../server/services/quant/challenge.ts';
import { challengePlanWithModel } from '../server/services/quant/modelChallenge.ts';
import { MODEL_CHALLENGE_NEED, applyChallengeToAssurance, assess, optimizePortfolio, type Activity, type PortfolioProblem } from '../server/services/quant/portfolio.ts';
import type { Challenge } from '../server/domain/decision.ts';

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
  return { target: 100, deadlineDays: 10, worlds: 300, activities: [act('only', { cash: [200], capital: 1, evidence: { sampleSize: 100_000 } })] };
}

const proceed: Challenge = { verdict: 'PROCEED', hiddenAssumptions: [], missingVariables: [], strongerAlternative: null, reasons: 'holds', model: 'switchboard:strong-model' };
const revise: Challenge = {
  verdict: 'REVISE', hiddenAssumptions: ['buyers of big pay on delivery'], missingVariables: ['payout hold'],
  strongerAlternative: 'take a deposit before committing big', reasons: 'cash timing', model: 'switchboard:strong-model',
};

const owesChallenge = (needs: string[] | undefined) => (needs ?? []).some((n) => n.startsWith(MODEL_CHALLENGE_NEED));

describe('a due model challenge binds the assurance', () => {
  it('the precondition holds: the deep plan claims 90% on evidence alone and its model challenge is due', () => {
    const p = deepPlan();
    const r = optimizePortfolio({ ...p, challenge: false });
    expect(assess(p, r.best!).claimsAtLeast90).toBe(true);
    expect(challengePlan(p, r).modelChallenge.due).toBe(true);
  });

  it('withdraws the 90% claim and owes the challenge as research while it is due', () => {
    const r = optimizePortfolio(deepPlan());
    const a = r.assurance!;
    expect(a.challenge!.modelChallenge.due).toBe(true);
    expect(a.claimsAtLeast90).toBe(false);
    expect(a.status).toBe(a.range ? 'RANGE' : 'CALIBRATION_UNAVAILABLE');
    expect(a.reason).toContain('required independent model challenge has not answered');
    expect(owesChallenge(a.researchNeeds)).toBe(true);
    // Never raised: the range is still assess()'s own.
    expect(a.range).toEqual(assess(deepPlan(), r.best!).range);
  });

  it('binds on its own: a summary that is otherwise a pass still holds when only the challenge is due', () => {
    const p = minorPlan();
    const r = optimizePortfolio({ ...p, challenge: false });
    const passing = challengePlan(p, r);
    expect(passing.verdict).toBe('PASS');
    expect(passing.modelChallenge.due).toBe(false);
    const clean = { ...r.assurance! };
    applyChallengeToAssurance(clean, passing);
    expect(owesChallenge(clean.researchNeeds)).toBe(false);
    expect(clean.claimsAtLeast90).toBe(r.assurance!.claimsAtLeast90);

    const due = { ...passing, modelChallenge: { required: true, because: ['the plan earns a deep review: test'], verdict: null, by: null, due: true } };
    const held = { ...r.assurance!, claimsAtLeast90: true };
    applyChallengeToAssurance(held, due);
    expect(held.claimsAtLeast90).toBe(false);
    expect(owesChallenge(held.researchNeeds)).toBe(true);
  });

  it('a minor reversible plan is never held for a model challenge it does not require', () => {
    const r = optimizePortfolio(minorPlan());
    expect(r.assurance!.challenge!.modelChallenge.required).toBe(false);
    expect(owesChallenge(r.assurance!.researchNeeds)).toBe(false);
    expect(r.assurance!.reason).not.toContain('model challenge has not answered');
  });
});

describe("the challenger's answer is what lifts or keeps the hold", () => {
  it('PROCEED lifts only the hold the missing challenge caused, exactly as supplying it up front would', async () => {
    const p = deepPlan();
    const r = optimizePortfolio(p);
    expect(r.assurance!.claimsAtLeast90).toBe(false);
    const out = await challengePlanWithModel(p, r, [], {}, async () => proceed);
    expect(out.summary.modelChallenge.due).toBe(false);
    expect(r.assurance!.challenge).toBe(out.summary);
    expect(owesChallenge(r.assurance!.researchNeeds)).toBe(false);
    const upFront = optimizePortfolio({ ...p, challenge: { modelChallenge: proceed } }).assurance!;
    expect(r.assurance!.claimsAtLeast90).toBe(upFront.claimsAtLeast90);
    expect(r.assurance!.status).toBe(upFront.status);
  });

  it('REVISE keeps the claim withdrawn, as a disagreeing independent check', async () => {
    const p = deepPlan();
    const r = optimizePortfolio(p);
    await challengePlanWithModel(p, r, [], {}, async () => revise);
    expect(r.assurance!.challenge!.modelChallenge).toMatchObject({ verdict: 'REVISE', due: false });
    expect(r.assurance!.claimsAtLeast90).toBe(false);
    expect(r.assurance!.reason).toContain('disagree');
  });

  it('a challenger that does not answer leaves the hold and the research need in place', async () => {
    const p = deepPlan();
    const r = optimizePortfolio(p);
    await challengePlanWithModel(p, r, [], {}, async () => null);
    expect(r.assurance!.claimsAtLeast90).toBe(false);
    expect(owesChallenge(r.assurance!.researchNeeds)).toBe(true);
  });
});
