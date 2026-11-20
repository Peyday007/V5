/**
 * FORECAST:operator:PARAMETER_ESTIMATE — the operator kept committing decisions
 * on a comparable bucket (`operator:<kind>`) judged miscalibrated, whose
 * systematic misses no observation explained, so the ledger read them as
 * PARAMETER_ESTIMATE (production, 4 of 4: "landed as claimed 0% of the time
 * against an implied 65%: the estimate drawn from its rows is too narrow").
 * The probability was shifted, but nothing in the next claim carried the
 * correction, so the next decision stated the same unanchored figure. The
 * bucket reading now carries those misses and the measured rates; Brain
 * records that base rate in the next claim itself, and an estimate the
 * operator states without a base-rate figure is sent back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import {
  ESTIMATE_ASSUMPTION_INSTRUCTION,
  bucketCorrectionFrom,
  correctedProbability,
  decide,
  estimateAssumptionProblem,
  measuredEstimateAssumption,
  operatorCalibration,
  readDecision,
} from '../server/services/operator/decisions.ts';
import { readLedger, recordOutcome, recordPrediction } from '../server/services/quant/ledger.ts';

/** A decision citing its rows but stating a probability with no anchor: the recorded shape of every miss. */
const unanchored: DecisionInput = {
  kind: 'RESEARCH',
  goalId: null,
  question: 'Which opening gets the next research round?',
  options: [
    { action: 'Price the HVAC supplier arrangement', probability: 0.3, valueUsd: 40, costUsd: 5, evidence: ['arr_2d0bae0f1074'] },
    { action: 'Do nothing', probability: 1, valueUsd: 0, costUsd: 0, evidence: [] },
  ],
  chosen: 0,
  assumptions: ['owners answer cold email at 1%'],
  whyNotHighestEv: null,
  prediction: { outcome: 'a strong actionable opportunity is found', probability: 0.65, horizonDays: 2 },
  irreversible: false,
};

const withAssumption = (a: string): DecisionInput => ({ ...unanchored, assumptions: [...unanchored.assumptions, a] });

/** The recorded failure class: decisions forecast at 0.65 on named data, none of which landed, with no cause observed. */
async function seedEstimateBucket(projectId: string, kind: string, opts: { n: number; occurred: number }): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_pe${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'a strong actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: ['arr_2d0bae0f1074'], assumptions: ['a'], probability: 0.65, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    await recordOutcome(p.id, occurred, {}, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision on a bucket whose misses were PARAMETER_ESTIMATE', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: the bucket reading names every PARAMETER_ESTIMATE miss and the measured rates', async () => {
    const missed = await seedEstimateBucket(projectId, 'RESEARCH', { n: 24, occurred: 0 });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.parameterEstimateClaims)).toEqual(new Set(missed));
    expect(correction!.evidenceQualityClaims).toEqual([]);
    expect(correction!.observedRate).toBe(0);
    expect(correction!.meanForecast).toBeCloseTo(0.65, 5);
  });

  it('sends a decision whose own estimate states no base rate back to be revised, uncommitted', async () => {
    await seedEstimateBucket(projectId, 'RESEARCH', { n: 24, occurred: 0 });
    const before = (await readLedger(null)).predictions.length;
    for (const input of [withAssumption('estimate: we feel good about this one'), withAssumption('estimate: observed 2026-11-19')]) {
      const d = await decide(input, ctx());
      expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
      expect(d.problems.join(' ')).toMatch(/PARAMETER_ESTIMATE/);
      expect(d.problems.join(' ')).toMatch(/happened 0% of the time against a stated 65%/);
      expect(d.next).toContain(ESTIMATE_ASSUMPTION_INSTRUCTION);
      // The unanchored estimate is named once, as its own problem, beside the bucket's miscalibration.
      const named = estimateAssumptionProblem(input.assumptions)!;
      expect(named).toMatch(/states the observed rate/);
      expect(d.problems.filter((p) => p === named)).toHaveLength(1);
    }
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('records the measured base rate itself when the operator states none, at the corrected probability', async () => {
    await seedEstimateBucket(projectId, 'RESEARCH', { n: 24, occurred: 0 });
    const d = await decide(unanchored, ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    expect(recorded.probability).toBe(correctedProbability(0.65, d.correction!));
    expect(recorded.probability!).toBeLessThan(0.65);
    const anchors = recorded.assumptions.filter((a) => /^estimate:/.test(a));
    expect(anchors).toEqual([measuredEstimateAssumption(unanchored.assumptions, d.correction!)]);
    expect(anchors[0]).toMatch(/happened 0% of the time against a stated 65%/);
    expect(estimateAssumptionProblem(recorded.assumptions)).toBeNull();
  });

  it('commits one that states the base rate it starts from, keeping the operator\'s anchor rather than adding one', async () => {
    await seedEstimateBucket(projectId, 'RESEARCH', { n: 24, occurred: 0 });
    for (const anchor of ['estimate: earlier RESEARCH decisions landed 0% of the time; this one has a named buyer', 'estimate: base rate 0.05 from the bucket, raised for the signed letter of intent']) {
      const d = await decide(withAssumption(anchor), ctx());
      expect(d.verdict).toBe('COMMITTED');
      const decision = await readDecision(d.decisionId!);
      const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
      expect(recorded.probability).toBe(correctedProbability(0.65, d.correction!));
      expect(recorded.assumptions.filter((a) => /^estimate:/.test(a))).toEqual([anchor]);
    }
  });

  it('leaves a thin bucket, a calibrated bucket, and misses whose cause was observed alone', async () => {
    await seedEstimateBucket(projectId, 'RESEARCH', { n: 5, occurred: 0 });
    const thin = await decide(unanchored, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    const thinRecorded = (await readLedger(null)).predictions.find((p) => p.claimId === `operator:${thin.decisionId}`)!;
    expect(thinRecorded.assumptions).toEqual(unanchored.assumptions);
    await seedEstimateBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 20 });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
    for (let i = 0; i < 24; i += 1) {
      const p = await recordPrediction(
        { claimId: `operator:opd_obs${i}`, outcome: 'x', horizonDays: 2, population: 'operator decisions of kind PAUSE_GOAL', data: ['arr_2d0bae0f1074'], assumptions: ['a'], probability: 0.65, comparableKey: 'operator:PAUSE_GOAL' },
        { projectId, caller: 'test' },
      );
      await recordOutcome(p.id, false, { mechanismMissing: true }, { projectId, evidence: `seed ${i}`, caller: 'test' });
    }
    const observed = bucketCorrectionFrom(await readLedger(null), 'operator:PAUSE_GOAL');
    expect(observed).not.toBeNull();
    expect(observed!.parameterEstimateClaims).toEqual([]);
  });

  it('holds an estimate assumption to a figure, and names the instruction when such a miss is recorded', () => {
    expect(estimateAssumptionProblem(['a'])).toBeNull();
    expect(estimateAssumptionProblem(['estimate: 12% of earlier decisions landed'])).toBeNull();
    expect(estimateAssumptionProblem(['estimate: rate 0.1 over the bucket'])).toBeNull();
    expect(estimateAssumptionProblem(['estimate: confident'])).toMatch(/states the observed rate/);
    const preds = [{ id: 'p1', comparableKey: 'operator:RESEARCH', probability: 0.65 }];
    const told = operatorCalibration({ predictions: preds, outcomes: [{ predictionId: 'p1', occurred: false, observedCauses: ['PARAMETER_ESTIMATE'] }] }, 'operator:RESEARCH');
    expect(String(told['nextDecisionOfThisKind'] ?? '')).toContain(ESTIMATE_ASSUMPTION_INSTRUCTION);
  });
});
