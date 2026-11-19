/**
 * FORECAST:operator:CAPACITY — the operator kept committing decisions on a
 * comparable bucket (`operator:<kind>`) judged miscalibrated, whose systematic
 * misses were observed as CAPACITY (production, 9 of 9): the outcome needed
 * capacity the decision assumed and did not have. decide() already corrected
 * the probability and asked for a mechanism step when the misses named
 * MISSING_MECHANISM; the same reading now carries CAPACITY misses, and a
 * decision that again names no capacity is sent back to be revised.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import type { DecisionInput } from '../server/domain/decision.ts';
import {
  CAPACITY_ASSUMPTION,
  MECHANISM_ASSUMPTION_INSTRUCTION,
  CAPACITY_ASSUMPTION_INSTRUCTION,
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

/** The recorded failure class: operator decisions forecast at 0.9 that mostly missed for a capacity shortfall. */
async function seedCapacityBucket(
  projectId: string,
  kind: string,
  opts: { n: number; occurred: number; capacityShortfall: boolean; mechanismMissingEvery?: number },
): Promise<string[]> {
  const claims: string[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const claimId = `operator:opd_cap${kind}${i}`;
    const p = await recordPrediction(
      { claimId, outcome: 'a strong actionable opportunity is found', horizonDays: 2, population: `operator decisions of kind ${kind}`, data: ['row'], assumptions: ['a'], probability: 0.9, comparableKey: `operator:${kind}` },
      { projectId, caller: 'test' },
    );
    const occurred = i < opts.occurred;
    const mechanismMissing = opts.mechanismMissingEvery ? i % opts.mechanismMissingEvery === 0 : false;
    const signals = occurred ? {} : mechanismMissing ? { mechanismMissing: true } : { capacityShortfall: opts.capacityShortfall };
    await recordOutcome(p.id, occurred, signals, { projectId, evidence: `seed ${i}`, caller: 'test' });
    if (!occurred) claims.push(claimId);
  }
  return claims;
}

describe('an operator decision on a bucket whose misses were CAPACITY', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('reproduces the failure class: the bucket reading names every CAPACITY miss', async () => {
    const missed = await seedCapacityBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, capacityShortfall: true });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction).not.toBeNull();
    expect(correction!.shift).toBeLessThan(-0.5);
    expect(new Set(correction!.capacityShortfallClaims)).toEqual(new Set(missed));
    expect(correction!.missingMechanismClaims).toEqual([]);
  });

  it('sends a decision that names no capacity back to be revised, uncommitted', async () => {
    await seedCapacityBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, capacityShortfall: true });
    const before = (await readLedger(null)).predictions.length;
    const d = await decide(base, ctx());
    expect(d).toMatchObject({ committed: false, verdict: 'REVISE', decisionId: null });
    expect(d.problems.join(' ')).toMatch(/CAPACITY/);
    expect(d.next).toContain(CAPACITY_ASSUMPTION_INSTRUCTION);
    expect((await readLedger(null)).predictions.length).toBe(before);
  });

  it('commits one that names its capacity, at the corrected probability', async () => {
    await seedCapacityBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, capacityShortfall: true });
    const quoted = /beginning "([^"]+)"/.exec(CAPACITY_ASSUMPTION_INSTRUCTION)![1]!;
    const written = `${quoted} one free research worker, shown idle on the fleet capacity row for the next 2 days`;
    expect(CAPACITY_ASSUMPTION.test(written)).toBe(true);
    const d = await decide({ ...base, assumptions: [...base.assumptions, written] }, ctx());
    expect(d.verdict).toBe('COMMITTED');
    const decision = await readDecision(d.decisionId!);
    const recorded = (await readLedger(null)).predictions.find((p) => p.id === decision!.predictionId)!;
    expect(recorded.probability).toBe(correctedProbability(0.8, d.correction!));
    expect(recorded.probability!).toBeLessThan(0.3);
  });

  it('leaves a thin or calibrated bucket alone, and another kind does not leak', async () => {
    await seedCapacityBucket(projectId, 'RESEARCH', { n: 5, occurred: 0, capacityShortfall: true });
    const thin = await decide(base, ctx());
    expect(thin).toMatchObject({ verdict: 'COMMITTED', correction: null });
    await seedCapacityBucket(projectId, 'SUBMIT_FIX', { n: 30, occurred: 27, capacityShortfall: true });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
    await seedCapacityBucket(projectId, 'PAUSE_GOAL', { n: 24, occurred: 2, capacityShortfall: true });
    expect(bucketCorrectionFrom(await readLedger(null), 'operator:SUBMIT_FIX')).toBeNull();
  });

  it('names both a missing mechanism and a missing capacity in one REVISE, not two in sequence', async () => {
    await seedCapacityBucket(projectId, 'RESEARCH', { n: 24, occurred: 4, capacityShortfall: true, mechanismMissingEvery: 2 });
    const correction = bucketCorrectionFrom(await readLedger(null), 'operator:RESEARCH');
    expect(correction!.missingMechanismClaims.length).toBeGreaterThan(0);
    expect(correction!.capacityShortfallClaims.length).toBeGreaterThan(0);
    const bare = { ...base, assumptions: ['owners answer cold email at 1%'] };
    const first = await decide(bare, ctx());
    expect(first).toMatchObject({ committed: false, verdict: 'REVISE' });
    expect(first.problems).toHaveLength(2);
    expect(first.problems.join(' ')).toMatch(/MISSING_MECHANISM/);
    expect(first.problems.join(' ')).toMatch(/CAPACITY/);
    expect(first.next).toContain(MECHANISM_ASSUMPTION_INSTRUCTION);
    expect(first.next).toContain(CAPACITY_ASSUMPTION_INSTRUCTION);
    // One revision that answers both commits; there is no second REVISE waiting behind the first.
    const answered = await decide(
      { ...bare, assumptions: [...bare.assumptions, 'mechanism: the supplier is reached through its listed sales inbox', 'capacity: one free research worker shown idle on the fleet row'] },
      ctx(),
    );
    expect(answered.verdict).toBe('COMMITTED');
    // Answering only one still names the other alone.
    const half = await decide({ ...bare, assumptions: [...bare.assumptions, 'mechanism: the supplier is reached through its listed sales inbox'] }, ctx());
    expect(half.verdict).toBe('REVISE');
    expect(half.problems).toHaveLength(1);
    expect(half.next).toContain(CAPACITY_ASSUMPTION_INSTRUCTION);
    expect(half.next).not.toContain(MECHANISM_ASSUMPTION_INSTRUCTION);
  });

  it('tells the operator the "capacity:" convention when a CAPACITY miss is verified', async () => {
    const first = await decide(base, ctx());
    expect(first.verdict).toBe('COMMITTED');
    const verified = await verify({ decisionId: first.decisionId!, occurred: false, evidence: 'no worker was free', signals: { capacityShortfall: true } }, ctx());
    expect(verified['ok']).toBe(true);
    expect(String(verified['nextDecisionOfThisKind'] ?? '')).toContain(CAPACITY_ASSUMPTION_INSTRUCTION);
    const preds = [{ id: 'p1', comparableKey: 'operator:RESEARCH', probability: 0.9 }];
    expect(operatorCalibration({ predictions: preds, outcomes: [{ predictionId: 'p1', occurred: false, observedCauses: ['TIMING'] }] }, 'operator:RESEARCH')).not.toHaveProperty('nextDecisionOfThisKind');
  });
});
