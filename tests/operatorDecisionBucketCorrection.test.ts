/**
 * FORECAST:operator:MISSING_MECHANISM — the operator kept committing decisions
 * at the probability it stated after its own comparable bucket (`operator:<kind>`)
 * had been judged miscalibrated, with every systematic miss naming a missing
 * mechanism step (production, 12 of 12). decide() now reads the bucket's own
 * record first: the probability it records carries the measured correction, and
 * a decision that again names no mechanism step is sent back to be revised.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import { bucketCorrectionFrom, correctedProbability, decide, readDecision } from '../server/services/operator/decisions.ts';
import { readLedger, recordOutcome, recordPrediction } from '../server/services/quant/ledger.ts';

const base: DecisionInput = {
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
  prediction: { outcome: 'the opening carries a price buyers are shown to pay', probability: 0.8, horizonDays: 2 },
  irreversible: false,
};

/** The recorded failure class: a bucket of operator decisions forecast at 0.9 that mostly failed for a missing mechanism step. */
async function seedMiscalibratedBucket(projectId: string, kind: string, opts: { n: number; occurred: number; mechanismMissing: boolean }): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_seed${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'an actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: ['row'], assumptions: ['a'], probability: 0.9, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    await recordOutcome(p.id, occurred, occurred ? {} : { mechanismMissing: opts.mechanismMissing }, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision reads its comparable bucket before committing', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: a miscalibrated bucket whose misses name MISSING_MECHANISM', async () => {
    const missed = await seedMiscalibratedBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, mechanismMissing: true });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.missingMechanismClaims)).toEqual(new Set(missed));
  });

  it('sends a decision that names no mechanism step back to be revised, uncommitted', async () => {
    await seedMiscalibratedBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, mechanismMissing: true });
    const before = (await readLedger(null)).predictions.length;
    const d = await decide(base, ctx());
    expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
    expect(d.problems.join(' ')).toMatch(/MISSING_MECHANISM/);
    expect(d.next).toMatch(/mechanism:/);
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('commits one that names the step, at the corrected probability, keeping what was stated', async () => {
    await seedMiscalibratedBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, mechanismMissing: true });
    const input = { ...base, assumptions: [...base.assumptions, 'mechanism: the supplier is reached through its listed sales inbox and pays on the quoted invoice'] };
    const d = await decide(input, ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    // Before the change the stated 0.8 was recorded verbatim on a bucket that hits 1 in 6.
    expect(recorded.probability).not.toBe(0.8);
    expect(recorded.probability).toBe(correctedProbability(0.8, d.correction!));
    expect(recorded.probability!).toBeLessThan(0.3);
    expect(recorded.assumptions.some((a) => /^forecast correction: operator:RESEARCH is miscalibrated/.test(a))).toBe(true);
    expect(decision!.input.prediction.probability).toBe(0.8);
  });

  it('stops holding the gate once a later decision of the kind carried a mechanism line, and re-arms on a new miss (review F3)', async () => {
    await seedMiscalibratedBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, mechanismMissing: true });
    const withMechanism = { ...base, assumptions: [...base.assumptions, 'mechanism: the supplier is reached through its listed sales inbox and pays on the quoted invoice'] };
    const carried = await decide(withMechanism, ctx());
    expect(carried.verdict).toBe('COMMITTED');
    // Before the change every earlier miss still counted inside the 90-day window, so this was sent back.
    const after = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(after).not.toBeNull();
    expect(after!.shift).toBeLessThan(-0.5);
    expect(after!.missingMechanismClaims).toEqual([]);
    const next = await decide(base, ctx());
    expect(next.verdict).toBe('COMMITTED');
    // The probability correction is untouched: only the answered mechanism demand is lifted.
    const recorded = (await readLedger(null)).predictions.find((p) => p.claimId === `operator:${next.decisionId}`)!;
    expect(recorded.probability!).toBeLessThan(0.3);
    // A claim that named a mechanism and still missed for want of one re-arms the gate: the step it named did not carry.
    const failed = await recordPrediction(
      { claimId: 'operator:opd_seedmechfail', outcome: 'an actionable opportunity is found', horizonDays: 2, population: 'operator decisions of kind RESEARCH', data: ['row'], assumptions: ['mechanism: the owner answers a cold email'], probability: 0.9, comparableKey: 'operator:RESEARCH' },
      { projectId, caller: 'test' },
    );
    await recordOutcome(failed.id, false, { mechanismMissing: true }, { projectId, evidence: 'mechanism did not carry', caller: 'test' });
    const rearmed = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(rearmed!.missingMechanismClaims).toEqual(['operator:opd_seedmechfail']);
    expect((await decide(base, ctx())).verdict).toBe('REVISE');
  });

  it('corrects the probability without asking for a mechanism when the misses name another cause', async () => {
    await seedMiscalibratedBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, mechanismMissing: false });
    const d = await decide(base, ctx());
    expect(d.verdict).toBe('COMMITTED');
    expect(d.correction!.missingMechanismClaims).toEqual([]);
    const recorded = (await readLedger(null)).predictions.find((p) => p.claimId === `operator:${d.decisionId}`)!;
    expect(recorded.probability!).toBeLessThan(0.8);
  });

  it('leaves a calibrated or unjudged bucket exactly as stated', async () => {
    // Too few outcomes to judge.
    await seedMiscalibratedBucket(projectId, 'RESEARCH', { n: 5, occurred: 0, mechanismMissing: true });
    const thin = await decide(base, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    expect((await readLedger(null)).predictions.find((p) => p.claimId === `operator:${thin.decisionId}`)!.probability).toBe(0.8);
    // Calibrated: 0.9 forecasts that happen 9 times in 10, in another bucket.
    await seedMiscalibratedBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 27, mechanismMissing: true });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
    // Another kind's miscalibration does not leak into this one.
    await seedMiscalibratedBucket(projectId, 'PAUSE_GOAL', { n: 24, occurred: 2, mechanismMissing: true });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
  });
});
