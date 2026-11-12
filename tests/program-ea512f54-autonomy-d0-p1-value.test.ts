/**
 * The VALUE step is a comparison, not a label (AUTO-20-2 step 4, S-0248; repair F-VALUE-NOT-COMPARED).
 *
 * A review found the VALUE row carried a constant list of "alternatives" and a
 * constant cost beside whatever the stage machine had already done. This pins:
 *
 *  - `evaluateNextStep`: every option is costed (P(success), latency, worker
 *    cost, opportunity cost, dependencies, constraints), the choice follows the
 *    figures and changes when the evidence changes, and options the old loop
 *    could never take — reuse without research, one credential from a person,
 *    abandoning — are chosen when the evidence favours them;
 *  - measured route history replaces priors, and an earlier attempt a method
 *    failed lowers that route's chance;
 *  - on real rows, the improvement tick records SEARCH_EXISTING, then an
 *    evaluated VALUE, then ACQUIRE, and acts on what VALUE chose.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getCandidateByKey, listImprovementEvents, upsertCandidate } from '../server/repos/improvement.ts';
import { gapStateFrom, readGapLoop } from '../server/services/selfmodel/gapLoop.ts';
import { gapStepsDue } from '../server/services/selfmodel/gapLoopSync.ts';
import {
  NEXT_STEP_OPTIONS,
  PRIOR_LATENCY_HOURS,
  evaluateNextStep,
  readRouteHistory,
  smoothedRate,
  valueDetail,
  type RouteHistory,
  type ValueInput,
} from '../server/services/selfmodel/gapValue.ts';
import { improvementTick } from '../server/services/improvement/loop.ts';
import type { ImprovementCandidate } from '../server/repos/improvement.ts';

const prior: RouteHistory = {
  factoryKept: smoothedRate(0, 0, 'x'),
  researchYield: smoothedRate(0, 0, 'y'),
  researchLatencyHours: { value: PRIOR_LATENCY_HOURS.research, basis: 'PRIOR' },
  factoryLatencyHours: { value: PRIOR_LATENCY_HOURS.factory, basis: 'PRIOR' },
  factoryWorkerHours: { value: 3, basis: 'PRIOR' },
  researchWorkerHours: { value: 2, basis: 'PRIOR' },
};

function input(over: Partial<ValueInput> = {}): ValueInput {
  return {
    stage: 'DIAGNOSE',
    severity: 'MEDIUM',
    scope: 'GENERAL',
    frequency: 30,
    denominator: 40,
    cause: 'OTHER',
    knownCause: null,
    archiveClaims: 0,
    existingOther: 0,
    research: null,
    failedAttempts: [],
    history: prior,
    ...over,
  };
}

describe('evaluateNextStep: every option is costed and the figures decide (pure)', () => {
  it('costs every option with P(success), latency, cost, opportunity cost, dependencies and constraints', () => {
    const judgment = evaluateNextStep(input());
    expect(judgment.options.map((o) => o.option)).toEqual([...NEXT_STEP_OPTIONS]);
    for (const o of judgment.options) {
      expect(typeof o.pSuccess).toBe('number');
      expect(typeof o.latencyHours).toBe('number');
      expect(typeof o.costWorkerHours).toBe('number');
      expect(typeof o.opportunityCost).toBe('number');
      expect(Array.isArray(o.dependencies)).toBe(true);
      expect(Array.isArray(o.constraints)).toBe(true);
      expect(o.why.length).toBeGreaterThan(0);
    }
    // Nothing stated, nothing in the archive: learning the method first is worth more than guessing at it.
    expect(judgment.chosen).toBe('COMMISSION_RESEARCH');
    const research = judgment.options.find((o) => o.option === 'COMMISSION_RESEARCH')!;
    const factory = judgment.options.find((o) => o.option === 'FACTORY_CHANGE')!;
    expect(research.net).toBeGreaterThan(factory.net);
    expect(judgment.basis).toContain('COMMISSION_RESEARCH');
  });

  it('builds at once when the rows state the cause', () => {
    const judgment = evaluateNextStep(input({ stage: 'ENGINEER', knownCause: 'the lane id list is not sent to the worker' }));
    expect(judgment.chosen).toBe('FACTORY_CHANGE');
    expect(judgment.options.find((o) => o.option === 'COMMISSION_RESEARCH')!.feasible).toBe(false);
  });

  it('reuses an accepted method rather than commissioning research for it', () => {
    const judgment = evaluateNextStep(input({ archiveClaims: 1 }));
    expect(judgment.chosen).toBe('REUSE_EXISTING');
  });

  it('refuses to research what the archive already answers (invariant 13)', () => {
    const judgment = evaluateNextStep(input({ stage: 'ENGINEER', archiveClaims: 3 }));
    const research = judgment.options.find((o) => o.option === 'COMMISSION_RESEARCH')!;
    expect(research.feasible).toBe(false);
    expect(research.why).toContain('invariant 13');
  });

  it('asks a person for one credential when the rows state an authorization refusal', () => {
    const judgment = evaluateNextStep(input({ stage: 'ENGINEER', cause: 'PERMISSION_GAP', knownCause: 'the forge answers 403 for the integration branch' }));
    expect(judgment.chosen).toBe('ASK_CREDENTIAL');
    expect(judgment.options.find((o) => o.option === 'ASK_CREDENTIAL')!.constraints.join(' ')).toContain('MISSING_AUTHORITY');
    // Without a stated refusal a person is never asked.
    const none = evaluateNextStep(input({ stage: 'ENGINEER', cause: 'PERMISSION_GAP', knownCause: null }));
    expect(none.options.find((o) => o.option === 'ASK_CREDENTIAL')!.feasible).toBe(false);
  });

  it('abandons when research settled with nothing and the rows state no cause', () => {
    const judgment = evaluateNextStep(input({ stage: 'ENGINEER', research: { opened: true, settled: true, acceptedClaims: 0 } }));
    expect(judgment.chosen).toBe('ABANDON');
    expect(judgment.options.filter((o) => o.feasible).map((o) => o.option)).toEqual(['ABANDON']);
  });

  it('abandons a direction whose every option costs more than it is expected to return', () => {
    const judgment = evaluateNextStep(input({ frequency: 1, denominator: 100, severity: 'LOW', scope: 'LOCAL' }));
    expect(judgment.chosen).toBe('ABANDON');
    expect(judgment.basis).toMatch(/costs/);
  });

  it('lowers the chance of a route an earlier attempt failed with, and can change the choice', () => {
    const base = evaluateNextStep(input({ stage: 'ENGINEER', knownCause: 'x' }));
    const failed = evaluateNextStep(input({ stage: 'ENGINEER', knownCause: 'x', failedAttempts: [{ attempt: 1, researched: false }] }));
    const p = (j: typeof base) => j.options.find((o) => o.option === 'FACTORY_CHANGE')!.pSuccess;
    expect(p(failed)).toBeLessThan(p(base));
    expect(failed.options.find((o) => o.option === 'FACTORY_CHANGE')!.pBasis).toContain('earlier attempt');
  });

  it('follows measured route history: a route that rarely works loses to one that does', () => {
    const poorFactory: RouteHistory = { ...prior, factoryKept: smoothedRate(0, 20, 'kept') };
    const strong = evaluateNextStep(input({ stage: 'ENGINEER', knownCause: 'x', frequency: 2 }));
    const weak = evaluateNextStep(input({ stage: 'ENGINEER', knownCause: 'x', frequency: 2, history: poorFactory }));
    expect(strong.chosen).toBe('FACTORY_CHANGE');
    expect(weak.chosen).toBe('ABANDON');
    expect(weak.options.find((o) => o.option === 'FACTORY_CHANGE')!.pBasis).toContain('MEASURED 0/20');
  });

  it('writes a VALUE detail whose alternatives are the evaluated options, not a fixed list', () => {
    const a = valueDetail(evaluateNextStep(input()));
    const b = valueDetail(evaluateNextStep(input({ archiveClaims: 1 })));
    expect(a['evaluated']).toBe(true);
    expect(a['alternatives']).not.toEqual(b['alternatives']);
    expect(String(a['alternatives'])).toMatch(/FACTORY_CHANGE: net/);
    expect((a['options'] as unknown[]).length).toBe(NEXT_STEP_OPTIONS.length);
  });
});

describe('gapStepsDue never claims alternatives were weighed when they were not (pure)', () => {
  const candidate = {
    id: 'c1', weaknessKey: 'K', kind: 'FREE_LANE_FAILURE', title: 't', problem: 'p', metric: 'AUTO_RECOVERY_RATE', downstreamMetric: null,
    ownerComponent: 'server/x.ts', frequency: 3, denominator: 10, scope: 'GENERAL', severity: 'MEDIUM', evidence: {}, proposal: null,
    dependencyCheck: null, researchGoalId: null, changeRequestId: null, campaignId: null, deliveredAt: null, deliveredRef: null, baseline: null,
    result: null, decision: 'COMBINED', decisionReason: null, combinedIntoId: 'c0', heldOn: null, attempt: 1, parentId: null, createdAt: '', updatedAt: '',
  } as unknown as ImprovementCandidate;

  it('records a choice made without a comparison as exactly that', () => {
    const value = gapStepsDue(candidate, gapStateFrom('K', []), null).find((d) => d.step === 'VALUE')!;
    expect(value.detail['evaluated']).toBe(false);
    expect(String(value.detail['alternatives'])).toMatch(/none weighed/);
  });

  it('adds nothing once the loop recorded an evaluated VALUE', () => {
    const rows = [{ at: '2026-11-01T00:00:00.000Z', provider: 'VALUE', reason: 'v', measures: JSON.stringify({ detail: { evaluated: true, chosen: 'ABANDON', ref: 'ABANDON', alternatives: 'x' } }) }];
    expect(gapStepsDue(candidate, gapStateFrom('K', rows), null).some((d) => d.step === 'VALUE')).toBe(false);
  });
});

describe('the improvement tick values the next step before it acquires anything (real rows)', () => {
  beforeEach(async () => {
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
  });

  async function failures(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await recordBinEvent({
        eventType: 'FREE_LANE_ITEM',
        workloadClass: 'RESEARCH_FRAGMENT',
        outcome: 'FAILED_RETRYABLE',
        reason: 'model a: brain_submit_claims refused: evidence_lane is not a declared lane id',
        evidenceClass: 'MEASURED',
      });
    }
  }

  it('records SEARCH_EXISTING, then an evaluated VALUE, then ACQUIRE, and acts on the choice', async () => {
    await failures(30);
    await improvementTick(new Date(Date.now() + 1000));
    const candidate = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    const loop = await readGapLoop(candidate.weaknessKey);
    const order = loop.steps.map((s) => s.step);
    expect(order.indexOf('SEARCH_EXISTING')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('VALUE')).toBeGreaterThan(order.indexOf('SEARCH_EXISTING'));
    expect(order.indexOf('ACQUIRE')).toBeGreaterThan(order.indexOf('VALUE'));
    const value = loop.latest.VALUE!.detail;
    expect(value['evaluated']).toBe(true);
    expect(value['chosen']).toBe('COMMISSION_RESEARCH');
    expect((value['options'] as { option: string }[]).map((o) => o.option)).toEqual([...NEXT_STEP_OPTIONS]);
    // What VALUE chose is what happened.
    expect(candidate.researchGoalId).toBeTruthy();
    const opened = await listImprovementEvents({ candidateId: candidate.id, kinds: ['RESEARCH_OPENED'] });
    expect(String(opened[0]!.detail['value'])).toContain('COMMISSION_RESEARCH');
    // A second pass reaching the same judgment adds no VALUE row.
    await improvementTick(new Date(Date.now() + 2000));
    expect((await readGapLoop(candidate.weaknessKey)).steps.filter((s) => s.step === 'VALUE').length).toBe(1);
  });

  it('reads route history from the loop\'s own rows rather than priors once rows exist', async () => {
    const empty = await readRouteHistory();
    expect(empty.factoryKept.basis).toMatch(/^PRIOR/);
    for (const [i, decision] of (['KEPT', 'KEPT', 'REVERTED'] as const).entries()) {
      const { candidate } = await upsertCandidate({
        weaknessKey: `HIST:${i}`, kind: 'X', title: 't', problem: 'p', metric: 'AUTO_RECOVERY_RATE', downstreamMetric: null,
        ownerComponent: 'server/x.ts', frequency: 1, denominator: 1, scope: 'LOCAL', severity: 'LOW',
        evidence: {}, attempt: 1, parentId: null,
      });
      await getDb().run('UPDATE improvement_candidates SET change_request_id = ?, decision = ? WHERE id = ?', [`fcr_${i}`, decision, candidate.id]);
    }
    const measured = await readRouteHistory();
    expect(measured.factoryKept.basis).toContain('MEASURED 2/3');
    expect(measured.factoryKept.value).toBeCloseTo(3 / 5, 5);
  });
});
