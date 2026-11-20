/**
 * FORECAST:operator:EVIDENCE_QUALITY — the operator kept committing decisions
 * on a comparable bucket (`operator:<kind>`) judged miscalibrated, whose
 * systematic misses were EVIDENCE_QUALITY (production, 5 of 5): decide()
 * records the prediction's data from the chosen option's evidence, and the
 * chosen option cited none, so every forecast rested on no named data. The
 * probability was shifted, but the next decision arrived on the same empty
 * evidence. The bucket reading now carries those misses, and a decision whose
 * chosen option again cites nothing is sent back to be revised.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import {
  EVIDENCE_QUALITY_INSTRUCTION,
  bucketCorrectionFrom,
  correctedProbability,
  decide,
  operatorCalibration,
  readDecision,
  verify,
} from '../server/services/operator/decisions.ts';
import { readLedger, recordOutcome, recordPrediction } from '../server/services/quant/ledger.ts';

/** A decision whose chosen option cites no evidence: the recorded shape of every miss. */
const bare: DecisionInput = {
  kind: 'RESEARCH',
  goalId: null,
  question: 'Which opening gets the next research round?',
  options: [
    { action: 'Price the HVAC supplier arrangement', probability: 0.3, valueUsd: 40, costUsd: 5, evidence: [] },
    { action: 'Do nothing', probability: 1, valueUsd: 0, costUsd: 0, evidence: [] },
  ],
  chosen: 0,
  assumptions: ['owners answer cold email at 1%'],
  whyNotHighestEv: null,
  prediction: { outcome: 'a strong actionable opportunity is found', probability: 0.8, horizonDays: 2 },
  irreversible: false,
};

const cited = (evidence: string[]): DecisionInput => ({
  ...bare,
  options: [{ ...bare.options[0]!, evidence }, bare.options[1]!],
});

/** The recorded failure class: operator decisions forecast at 0.9 on no named data, that mostly missed. */
async function seedEvidenceBucket(projectId: string, kind: string, opts: { n: number; occurred: number; data: string[] }): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_evq${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'a strong actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: opts.data, assumptions: ['a'], probability: 0.9, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    await recordOutcome(p.id, occurred, {}, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision on a bucket whose misses were EVIDENCE_QUALITY', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: the bucket reading names every EVIDENCE_QUALITY miss', async () => {
    const missed = await seedEvidenceBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, data: [] });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.evidenceQualityClaims)).toEqual(new Set(missed));
  });

  it('sends a decision whose chosen option cites no evidence back to be revised, uncommitted', async () => {
    await seedEvidenceBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, data: [] });
    const before = (await readLedger(null)).predictions.length;
    for (const input of [bare, cited(['   ', ''])]) {
      const d = await decide(input, ctx());
      expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
      expect(d.problems.join(' ')).toMatch(/EVIDENCE_QUALITY/);
      expect(d.next).toContain(EVIDENCE_QUALITY_INSTRUCTION);
    }
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('commits one whose chosen option cites its rows, at the corrected probability, with that data recorded', async () => {
    await seedEvidenceBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, data: [] });
    const d = await decide(cited([' arr_2d0bae0f1074 ', 'https://example.com/hvac-pricing']), ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    expect(recorded.probability).toBe(correctedProbability(0.8, d.correction!));
    expect(recorded.data).toEqual(['arr_2d0bae0f1074', 'https://example.com/hvac-pricing']);
  });

  it('leaves a bucket whose misses had named data, a thin bucket, and a calibrated bucket alone', async () => {
    await seedEvidenceBucket(projectId, 'RESEARCH', { n: 5, occurred: 0, data: [] });
    const thin = await decide(bare, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    await seedEvidenceBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 27, data: [] });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
    await seedEvidenceBucket(projectId, 'PAUSE_GOAL', { n: 24, occurred: 4, data: ['row'] });
    const named = bucketCorrectionFrom(await readLedger(null), 'operator:PAUSE_GOAL');
    expect(named).not.toBeNull();
    expect(named!.evidenceQualityClaims).toEqual([]);
  });

  it('tells the operator to cite evidence when an EVIDENCE_QUALITY miss is verified', async () => {
    const first = await decide(bare, ctx());
    expect(first.verdict).toBe('COMMITTED');
    const verified = await verify({ decisionId: first.decisionId!, occurred: false, evidence: 'no opportunity was found' }, ctx());
    expect(verified['ok']).toBe(true);
    expect(String(verified['nextDecisionOfThisKind'] ?? '')).toContain(EVIDENCE_QUALITY_INSTRUCTION);
    const preds = [{ id: 'p1', comparableKey: 'operator:RESEARCH', probability: 0.9 }];
    expect(operatorCalibration({ predictions: preds, outcomes: [{ predictionId: 'p1', occurred: false, observedCauses: ['TIMING'] }] }, 'operator:RESEARCH')).not.toHaveProperty('nextDecisionOfThisKind');
  });
});
