/**
 * FORECAST:operator:TIMING — the operator kept committing decisions on a
 * comparable bucket (`operator:<kind>`) judged miscalibrated, whose systematic
 * misses were observed as TIMING (production, 1 of 1 on
 * operator:opd_b7fc34fecd867b48): the outcome arrived after the horizon the
 * decision stated. decide() only shifted the probability, so the next decision
 * rested on the same unmeasured lead time. The bucket reading now carries TIMING
 * misses, and a decision that states no measured lead time inside its horizon
 * is sent back to be revised.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import {
  TIMING_ASSUMPTION,
  TIMING_ASSUMPTION_INSTRUCTION,
  bucketCorrectionFrom,
  correctedProbability,
  decide,
  readDecision,
  timingAssumptionProblem,
} from '../server/services/operator/decisions.ts';
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
  assumptions: ['owners answer cold email at 1%', 'mechanism: the supplier is reached through its listed sales inbox and pays on the quoted invoice'],
  whyNotHighestEv: null,
  prediction: { outcome: 'the opening carries a price buyers are shown to pay', probability: 0.8, horizonDays: 2 },
  irreversible: false,
};

/** The recorded failure class: operator decisions forecast at 0.9 that mostly missed because the outcome arrived late. */
async function seedTimingBucket(projectId: string, kind: string, opts: { n: number; occurred: number }): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_tim${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'a strong actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: ['row'], assumptions: ['a'], probability: 0.9, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    const signals = occurred ? {} : i % 2 === 0 ? { lateByDays: 3 } : { arrivedLate: true };
    await recordOutcome(p.id, occurred, signals, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision on a bucket whose misses were TIMING', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: the bucket reading names every TIMING miss', async () => {
    const missed = await seedTimingBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.timingLateClaims)).toEqual(new Set(missed));
    expect(correction!.executionBehaviorClaims).toEqual([]);
  });

  it('sends a decision that states no lead time back to be revised, uncommitted', async () => {
    await seedTimingBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const before = (await readLedger(null)).predictions.length;
    const d = await decide(base, ctx());
    expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
    expect(d.problems.join(' ')).toMatch(/TIMING/);
    expect(d.next).toContain(TIMING_ASSUMPTION_INSTRUCTION);
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('commits one that states a measured lead time within its horizon, at the corrected probability', async () => {
    await seedTimingBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const quoted = /beginning "([^"]+)"/.exec(TIMING_ASSUMPTION_INSTRUCTION)![1]!;
    const written = `${quoted} the priced reply is observable within 36 hours, measured from research_runs row rsr_7f3a91c2d4`;
    expect(TIMING_ASSUMPTION.test(written)).toBe(true);
    const d = await decide({ ...base, assumptions: [...base.assumptions, written] }, ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    expect(recorded.probability).toBe(correctedProbability(0.8, d.correction!));
    expect(recorded.probability!).toBeLessThan(0.3);
  });

  it('does not accept the "timing:" prefix alone: a sourced lead time inside the horizon is required', async () => {
    await seedTimingBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const before = (await readLedger(null)).predictions.length;
    const incomplete = [
      'timing: soon',
      'timing: about 1 day',
      'timing: measured from rsr_7f3a91c2d4',
      'timing: observable in 5 days, measured from rsr_7f3a91c2d4',
      'timing: observable in 2 weeks per https://example.com/lead-times',
      'timing: observed 2026-11-01 in rsr_7f3a91c2d4',
    ];
    for (const written of incomplete) {
      expect(TIMING_ASSUMPTION.test(written)).toBe(true);
      expect(timingAssumptionProblem([written], 2)).not.toBeNull();
      const d = await decide({ ...base, assumptions: [...base.assumptions, written] }, ctx());
      expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
      expect(d.problems.join(' ')).toMatch(/no timing assumption states a measured lead time within the horizon/);
      expect(d.next).toContain(TIMING_ASSUMPTION_INSTRUCTION);
    }
    expect((await readLedger(null)).predictions.length).toBe(before);
    expect(timingAssumptionProblem(['timing: 2 days, from opd_b7fc34fecd867b48'], 2)).toBeNull();
    expect(timingAssumptionProblem(['timing: 12h per https://example.com/sla'], 1)).toBeNull();
    expect(timingAssumptionProblem(['owners answer cold email at 1%'], 2)).toBeNull();
    expect(timingAssumptionProblem(['timing: soon', 'timing: 1 day from rsr_7f3a91c2d4'], 2)).toBeNull();
  });

  it('leaves a thin or calibrated bucket alone, and another kind does not leak', async () => {
    await seedTimingBucket(projectId, 'RESEARCH', { n: 5, occurred: 0 });
    const thin = await decide(base, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    await seedTimingBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 27 });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
  });
});
