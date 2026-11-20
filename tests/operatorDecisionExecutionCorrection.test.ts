/**
 * FORECAST:operator:EXECUTION_BEHAVIOR — the operator kept committing decisions
 * on a comparable bucket (`operator:<kind>`) judged miscalibrated, whose
 * systematic misses were observed as EXECUTION_BEHAVIOR (production, 2 of 2 on
 * operator:opd_a3148d1cd5bd640e and operator:opd_b7fc34fecd867b48): the work the
 * decision assumed was not done as planned. decide() only shifted the
 * probability, so the next decision rested on the same unplanned execution. The
 * bucket reading now carries EXECUTION_BEHAVIOR misses, and a decision that
 * names no operation to carry it out is sent back to be revised.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import {
  EXECUTION_ASSUMPTION,
  EXECUTION_ASSUMPTION_INSTRUCTION,
  bucketCorrectionFrom,
  executionAssumptionProblem,
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

/** The recorded failure class: operator decisions forecast at 0.9 that mostly missed because the work was not done as planned. */
async function seedExecutionBucket(projectId: string, kind: string, opts: { n: number; occurred: number }): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_exe${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'a strong actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: ['row'], assumptions: ['a'], probability: 0.9, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    await recordOutcome(p.id, occurred, occurred ? {} : { executionDeviated: true }, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision on a bucket whose misses were EXECUTION_BEHAVIOR', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: the bucket reading names every EXECUTION_BEHAVIOR miss', async () => {
    const missed = await seedExecutionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.executionBehaviorClaims)).toEqual(new Set(missed));
    expect(correction!.capacityShortfallClaims).toEqual([]);
  });

  it('sends a decision that names no execution back to be revised, uncommitted', async () => {
    await seedExecutionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const before = (await readLedger(null)).predictions.length;
    const d = await decide(base, ctx());
    expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
    expect(d.problems.join(' ')).toMatch(/EXECUTION_BEHAVIOR/);
    expect(d.next).toContain(EXECUTION_ASSUMPTION_INSTRUCTION);
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('commits one that names its execution, at the corrected probability', async () => {
    await seedExecutionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const quoted = /beginning "([^"]+)"/.exec(EXECUTION_ASSUMPTION_INSTRUCTION)![1]!;
    const written = `${quoted} a research bin run by the free lane, checked by its research_runs row within 2 days`;
    expect(EXECUTION_ASSUMPTION.test(written)).toBe(true);
    const d = await decide({ ...base, assumptions: [...base.assumptions, written] }, ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    expect(recorded.probability).toBe(correctedProbability(0.8, d.correction!));
    expect(recorded.probability!).toBeLessThan(0.3);
  });

  it('does not accept the "execution:" prefix alone: the operation, its runner and its checking row must each be named', async () => {
    await seedExecutionBucket(projectId, 'RESEARCH', { n: 24, occurred: 4 });
    const before = (await readLedger(null)).predictions.length;
    const incomplete = [
      'execution: we will get it done',
      'execution: run by the free lane, checked by its research_runs row',
      'execution: a research bin, checked by its research_runs row',
      'execution: a research bin run by the free lane',
      'execution: a research bin run by the free lane, checked by Peyton',
    ];
    for (const written of incomplete) {
      expect(EXECUTION_ASSUMPTION.test(written)).toBe(true);
      expect(executionAssumptionProblem([written])).not.toBeNull();
      const d = await decide({ ...base, assumptions: [...base.assumptions, written] }, ctx());
      expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
      expect(d.problems.join(' ')).toMatch(/no execution assumption names the operation, its runner and the row/);
      expect(d.next).toContain(EXECUTION_ASSUMPTION_INSTRUCTION);
    }
    expect((await readLedger(null)).predictions.length).toBe(before);
    expect(executionAssumptionProblem(['execution: brain_bin_complete run by the factory session, checked by the bins row within 2 days'])).toBeNull();
    expect(executionAssumptionProblem(['owners answer cold email at 1%'])).toBeNull();
    expect(executionAssumptionProblem(['execution: soon', 'execution: a research bin run by the free lane, checked by its research_runs row'])).toBeNull();
  });

  it('leaves a thin or calibrated bucket alone, and another kind does not leak', async () => {
    await seedExecutionBucket(projectId, 'RESEARCH', { n: 5, occurred: 0 });
    const thin = await decide(base, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    await seedExecutionBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 27 });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
  });

  it('tells the operator the "execution:" convention when an EXECUTION_BEHAVIOR miss is verified', async () => {
    const first = await decide(base, ctx());
    expect(first.verdict).toBe('COMMITTED');
    const verified = await verify({ decisionId: first.decisionId!, occurred: false, evidence: 'the research round was never run', signals: { executionDeviated: true } }, ctx());
    expect(verified['ok']).toBe(true);
    expect(String(verified['nextDecisionOfThisKind'] ?? '')).toContain(EXECUTION_ASSUMPTION_INSTRUCTION);
    const preds = [{ id: 'p1', comparableKey: 'operator:RESEARCH', probability: 0.9 }];
    expect(operatorCalibration({ predictions: preds, outcomes: [{ predictionId: 'p1', occurred: false, observedCauses: ['TIMING'] }] }, 'operator:RESEARCH')).not.toHaveProperty('nextDecisionOfThisKind');
  });
});
