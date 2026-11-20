/**
 * FORECAST:operator:CHANGED_CONDITIONS — the operator kept committing decisions
 * on a comparable bucket (`operator:<kind>`) judged miscalibrated, whose
 * systematic misses were observed as CHANGED_CONDITIONS (production, 9 of 9):
 * a condition the decision assumed no longer held when the outcome arrived.
 * decide() shifted the probability but read only MISSING_MECHANISM and CAPACITY
 * out of the bucket, so the next decision rested on the same unchecked
 * condition. The reading now carries CHANGED_CONDITIONS misses, and a decision
 * that names no re-checked condition is sent back to be revised.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import {
  CONDITION_ASSUMPTION,
  CONDITION_ASSUMPTION_INSTRUCTION,
  MECHANISM_ASSUMPTION_INSTRUCTION,
  bucketCorrectionFrom,
  correctedProbability,
  decide,
  operatorCalibration,
  readDecision,
  verify,
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

/** The recorded failure class: operator decisions forecast at 0.9 that mostly missed because an assumed condition changed. */
async function seedConditionBucket(
  projectId: string,
  kind: string,
  opts: { n: number; occurred: number; mechanismMissingEvery?: number },
): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_cond${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'a strong actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: ['row'], assumptions: ['a'], probability: 0.9, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    const mechanismMissing = opts.mechanismMissingEvery ? i % opts.mechanismMissingEvery === 0 : false;
    const signals = occurred ? {} : mechanismMissing ? { mechanismMissing: true } : { assumptionBroke: true };
    await recordOutcome(p.id, occurred, signals, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred && !mechanismMissing) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision on a bucket whose misses were CHANGED_CONDITIONS', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: the bucket reading names every CHANGED_CONDITIONS miss', async () => {
    const missed = await seedConditionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.changedConditionClaims)).toEqual(new Set(missed));
    expect(correction!.missingMechanismClaims).toEqual([]);
    expect(correction!.capacityShortfallClaims).toEqual([]);
  });

  it('sends a decision that names no re-checked condition back to be revised, uncommitted', async () => {
    await seedConditionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const before = (await readLedger(null)).predictions.length;
    const d = await decide(base, ctx());
    expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
    expect(d.problems.join(' ')).toMatch(/CHANGED_CONDITIONS/);
    expect(d.next).toContain(CONDITION_ASSUMPTION_INSTRUCTION);
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('commits one that names its condition, at the corrected probability', async () => {
    await seedConditionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const quoted = /beginning "([^"]+)"/.exec(CONDITION_ASSUMPTION_INSTRUCTION)![1]!;
    const written = `${quoted} the supplier still lists wholesale pricing, seen on its price page 2026-11-19`;
    expect(CONDITION_ASSUMPTION.test(written)).toBe(true);
    const d = await decide({ ...base, assumptions: [...base.assumptions, written] }, ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    expect(recorded.probability).toBe(correctedProbability(0.8, d.correction!));
    expect(recorded.probability!).toBeLessThan(0.3);
  });

  it('names both a missing mechanism and a changed condition in one REVISE', async () => {
    await seedConditionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, mechanismMissingEvery: 2 });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction!.missingMechanismClaims.length).toBeGreaterThan(0);
    expect(correction!.changedConditionClaims.length).toBeGreaterThan(0);
    const bare = { ...base, assumptions: ['owners answer cold email at 1%'] };
    const first = await decide(bare, ctx());
    expect(first).toMatchObject({ committed: false, verdict: 'REVISE' });
    expect(first.problems).toHaveLength(2);
    expect(first.next).toContain(MECHANISM_ASSUMPTION_INSTRUCTION);
    expect(first.next).toContain(CONDITION_ASSUMPTION_INSTRUCTION);
    const answered = await decide(
      { ...bare, assumptions: [...bare.assumptions, 'mechanism: the supplier is reached through its listed sales inbox', 'condition: wholesale pricing still listed, price page read 2026-11-19'] },
      ctx(),
    );
    expect(answered.verdict).toBe('COMMITTED');
  });

  it('quotes the assumption a verifier recorded as broken, and leaves a thin bucket alone', async () => {
    const thin = await decide(base, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    const verified = await verify(
      { decisionId: thin.decisionId!, occurred: false, evidence: 'the supplier withdrew wholesale pricing', signals: { assumptionBroke: true }, brokenAssumption: 'the supplier sells wholesale to resellers' },
      ctx(),
    );
    expect(verified['ok']).toBe(true);
    expect(String(verified['nextDecisionOfThisKind'] ?? '')).toContain(CONDITION_ASSUMPTION_INSTRUCTION);
    // Make the bucket systematic around that verified miss.
    await seedConditionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const d = await decide(base, ctx());
    expect(d.verdict).toBe('REVISE');
    expect(d.problems.join(' ')).toContain('"the supplier sells wholesale to resellers"');
  });

  it('a calibrated bucket or another kind of miss does not ask for a condition', async () => {
    await seedConditionBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 27 });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
    const preds = [{ id: 'p1', comparableKey: 'operator:RESEARCH', probability: 0.9 }];
    expect(operatorCalibration({ predictions: preds, outcomes: [{ predictionId: 'p1', occurred: false, observedCauses: ['TIMING'] }] }, 'operator:RESEARCH')).not.toHaveProperty('nextDecisionOfThisKind');
    expect(
      String(operatorCalibration({ predictions: preds, outcomes: [{ predictionId: 'p1', occurred: false, observedCauses: ['CHANGED_CONDITIONS'] }] }, 'operator:RESEARCH')['nextDecisionOfThisKind']),
    ).toContain('CHANGED_CONDITIONS');
  });
});
