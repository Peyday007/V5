/**
 * AUTO-20-1 / AUTO-20-2 / AUTO-20-4 (§87/§88): Brain originates its own work,
 * records each step of a capability-gap loop, and measures the gaps it closed.
 *
 * Review finding F5: the three behaviours landed with no test. These pin
 *  - refusalFor: what each loop step must carry, and that ACQUIRE waits on SEARCH_EXISTING;
 *  - gapStateFrom: latest/outstanding/next, the integrated flag and the cause;
 *  - register()'s methodInadequacy branch, driven through improvementTick on real rows;
 *  - readGapMeasures: identified, closed, closed without owner input, delivered-not-proven,
 *    regressions and the median hours to use.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  decideCandidate,
  getCandidateByKey,
  listCandidates,
  listImprovementEvents,
  patchCandidate,
  recordImprovementEvent,
  upsertCandidate,
} from '../server/repos/improvement.ts';
import { improvementTick } from '../server/services/improvement/loop.ts';
import { readGapMeasures } from '../server/services/improvement/scoreboard.ts';
import {
  GAP_LOOP_STEPS,
  GapStepRefused,
  gapStateFrom,
  readGapLoop,
  recordGapStep,
  refusalFor,
  type GapLoopState,
} from '../server/services/selfmodel/gapLoop.ts';

const EMPTY: GapLoopState = gapStateFrom('GAP:x', []);

function row(step: string, at: string, detail: Record<string, unknown> = {}, reason = `${step} done`) {
  return { at, provider: step, reason, measures: JSON.stringify({ detail }) };
}

describe('refusalFor: what each step must carry (pure)', () => {
  it('refuses a notice without an observation and accepts one with it', () => {
    expect(refusalFor('NOTICE', {}, EMPTY)).toContain('observed');
    expect(refusalFor('NOTICE', { observation: '   ' }, EMPTY)).toContain('observed');
    expect(refusalFor('NOTICE', { observation: 'supplier capacity missing in 4 of 5 deals' }, EMPTY)).toBeNull();
  });

  it('requires a hypothesis to name what it enables, the measure, the failure mode and a known cause', () => {
    const full = { enables: 'quotes', measure: 'quote rate', failureMode: 'supplier refuses', cause: 'MISSING_DATASET' };
    expect(refusalFor('HYPOTHESIS', full, EMPTY)).toBeNull();
    expect(refusalFor('HYPOTHESIS', { ...full, measure: '' }, EMPTY)).toContain('which measure changes');
    expect(refusalFor('HYPOTHESIS', { ...full, cause: 'BAD_LUCK' }, EMPTY)).toContain('names its cause');
    expect(refusalFor('HYPOTHESIS', { ...full, cause: undefined }, EMPTY)).toContain('names its cause');
  });

  it('requires a search to name where it looked', () => {
    expect(refusalFor('SEARCH_EXISTING', { searched: [] }, EMPTY)).toContain('where it looked');
    expect(refusalFor('SEARCH_EXISTING', { searched: 'code' }, EMPTY)).toContain('where it looked');
    expect(refusalFor('SEARCH_EXISTING', { searched: ['server/services/selfmodel'] }, EMPTY)).toBeNull();
  });

  it('requires a value judgment to name the choice and its alternatives', () => {
    expect(refusalFor('VALUE', { chosen: 'export' }, EMPTY)).toContain('alternatives');
    expect(refusalFor('VALUE', { chosen: 'export', alternatives: 'integration, abandon' }, EMPTY)).toBeNull();
  });

  it('refuses to acquire before reuse was checked, then requires an owner', () => {
    expect(refusalFor('ACQUIRE', { owner: 'FACTORY' }, EMPTY)).toContain('reuse comes first');
    const searched = gapStateFrom('GAP:x', [row('SEARCH_EXISTING', '2026-11-01T00:00:00.000Z', { searched: ['code'] })]);
    expect(refusalFor('ACQUIRE', { owner: 'FACTORY' }, searched)).toBeNull();
    expect(refusalFor('ACQUIRE', {}, searched)).toContain('execution owner');
  });

  it('refuses verification by tests alone: a baseline and a real-world comparison are required', () => {
    expect(refusalFor('VERIFY', { tests: 'green' }, EMPTY)).toContain('not tests alone');
    expect(refusalFor('VERIFY', { baseline: '3/10', comparison: '8/10 in production' }, EMPTY)).toBeNull();
  });

  it('requires integration to name capability, provenance and owner, and continuation what resumed', () => {
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p' }, EMPTY)).toContain('owning subsystem');
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }, EMPTY)).toBeNull();
    expect(refusalFor('CONTINUE', {}, EMPTY)).toContain('what resumed');
    expect(refusalFor('CONTINUE', { resumed: 'goal g' }, EMPTY)).toBeNull();
  });
});

describe('gapStateFrom: where a loop stands, read from its rows (pure)', () => {
  it('starts with every step outstanding and NOTICE next', () => {
    expect(EMPTY).toMatchObject({ steps: [], outstanding: [...GAP_LOOP_STEPS], next: 'NOTICE', integrated: false, cause: null });
  });

  it('keeps the latest record per step, ignores unknown steps, and survives an unreadable record', () => {
    const state = gapStateFrom('GAP:x', [
      row('NOTICE', '2026-11-01T00:00:00.000Z', { observation: 'first' }),
      { at: '2026-11-01T00:30:00.000Z', provider: 'SOMETHING_ELSE', reason: 'x', measures: '{}' },
      row('NOTICE', '2026-11-01T01:00:00.000Z', { observation: 'second' }),
      { at: '2026-11-01T02:00:00.000Z', provider: 'HYPOTHESIS', reason: null, measures: 'not json' },
    ]);
    expect(state.steps.map((s) => s.step)).toEqual(['NOTICE', 'NOTICE', 'HYPOTHESIS']);
    expect(state.latest.NOTICE?.detail).toEqual({ observation: 'second' });
    expect(state.latest.HYPOTHESIS).toMatchObject({ summary: '', detail: {} });
    expect(state.outstanding).toEqual(GAP_LOOP_STEPS.filter((s) => s !== 'NOTICE' && s !== 'HYPOTHESIS'));
    expect(state.next).toBe('SEARCH_EXISTING');
    // An unreadable hypothesis carries no cause, and a cause outside the vocabulary is not believed.
    expect(state.cause).toBeNull();
    expect(gapStateFrom('GAP:x', [row('HYPOTHESIS', '2026-11-01T00:00:00.000Z', { cause: 'INVENTED' })]).cause).toBeNull();
    expect(gapStateFrom('GAP:x', [row('HYPOTHESIS', '2026-11-01T00:00:00.000Z', { cause: 'PERMISSION_GAP' })]).cause).toBe('PERMISSION_GAP');
  });

  it('is integrated only when INTEGRATE follows the last ACQUIRE', () => {
    const acquiredThenIntegrated = gapStateFrom('GAP:x', [
      row('ACQUIRE', '2026-11-01T00:00:00.000Z'),
      row('INTEGRATE', '2026-11-01T01:00:00.000Z'),
    ]);
    expect(acquiredThenIntegrated.integrated).toBe(true);
    // A failed verification sent the loop back: a later ACQUIRE reopens it.
    const reopened = gapStateFrom('GAP:x', [
      row('ACQUIRE', '2026-11-01T00:00:00.000Z'),
      row('INTEGRATE', '2026-11-01T01:00:00.000Z'),
      row('ACQUIRE', '2026-11-01T02:00:00.000Z'),
    ]);
    expect(reopened.integrated).toBe(false);
    // Integration with no acquisition (an existing capability reused) counts.
    expect(gapStateFrom('GAP:x', [row('INTEGRATE', '2026-11-01T00:00:00.000Z')]).integrated).toBe(true);
  });

  it('reports next as null once every step is recorded', () => {
    const all = gapStateFrom(
      'GAP:x',
      GAP_LOOP_STEPS.map((step, i) => row(step, `2026-11-01T0${i}:00:00.000Z`)),
    );
    expect(all.outstanding).toEqual([]);
    expect(all.next).toBeNull();
  });
});

describe('the gap loop on real rows', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('writes nothing when a step is refused, and resumes from the rows alone', async () => {
    await expect(recordGapStep({ gapKey: 'GAP:supplier', step: 'ACQUIRE', summary: 'build it', detail: { owner: 'FACTORY' } })).rejects.toBeInstanceOf(GapStepRefused);
    expect((await readGapLoop('GAP:supplier')).steps).toEqual([]);

    await recordGapStep({ gapKey: 'GAP:supplier', step: 'NOTICE', summary: 'seen', detail: { observation: 'needs supplier capacity' } });
    await recordGapStep({ gapKey: 'GAP:supplier', step: 'SEARCH_EXISTING', summary: 'looked', detail: { searched: ['connectors'] } });
    const after = await recordGapStep({ gapKey: 'GAP:supplier', step: 'ACQUIRE', summary: 'handed over', detail: { owner: 'FACTORY' } });
    expect(after.steps.map((s) => s.step)).toEqual(['NOTICE', 'SEARCH_EXISTING', 'ACQUIRE']);
    // A fresh reader (a new worker, after a restart) sees the same state from the rows.
    const resumed = await readGapLoop('GAP:supplier');
    expect(resumed.next).toBe('HYPOTHESIS');
    expect(resumed.integrated).toBe(false);
  });
});

describe('register(): a method that did not work is judged inadequate, not re-run', () => {
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
        reason: 'model a: brain_submit_claims refused: x',
        evidenceClass: 'MEASURED',
      });
    }
  }

  async function nextAttemptAfter(decision: 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED') {
    await failures(30);
    await improvementTick(new Date(Date.now() + 1000));
    const first = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    expect(first.attempt).toBe(1);
    expect(first.evidence['methodInadequacy']).toBeUndefined();
    await decideCandidate(first.id, decision, `test: ${decision}`);
    await getDb().run('UPDATE improvement_candidates SET updated_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', first.id]);
    await failures(30);
    await improvementTick(new Date(Date.now() + 2000));
    return (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED#2'))!;
  }

  for (const decision of ['KEPT_NO_EFFECT', 'REVERTED'] as const) {
    it(`records the judgment on the next attempt after ${decision}, and asks for a different method`, async () => {
      const second = await nextAttemptAfter(decision);
      expect(second).toMatchObject({ attempt: 2 });
      const judged = second.evidence['methodInadequacy'] as { judgment: string; failedAttempts: number[] };
      expect(judged.failedAttempts).toEqual([1]);
      expect(judged.judgment).toContain(`Attempt(s) 1 ended ${decision}`);
      expect(judged.judgment).toContain('do not re-run it');
      expect(String(second.evidence['researchQuestion'])).toContain('find a different class of method');
      const detected = (await listImprovementEvents({ candidateId: second.id, kinds: ['WEAKNESS_DETECTED'] }))[0]!;
      expect(detected.detail['methodInadequacy']).toEqual(judged);
    });
  }

  it('does not call a method inadequate when the earlier attempt was not tried and measured', async () => {
    const second = await nextAttemptAfter('REJECTED');
    expect(second).toMatchObject({ attempt: 2 });
    expect(second.evidence['methodInadequacy']).toBeUndefined();
    const detected = (await listImprovementEvents({ candidateId: second.id, kinds: ['WEAKNESS_DETECTED'] }))[0]!;
    expect(detected.detail['methodInadequacy']).toBeUndefined();
  });
});

describe('readGapMeasures: gaps identified and closed without owner input', () => {
  const FROM = '2026-11-01T00:00:00.000Z';
  const TO = '2026-11-02T00:00:00.000Z';

  beforeEach(async () => {
    await freshProject();
  });

  async function candidate(key: string, createdAt: string, decision: string | null, updatedAt: string, deliveredAt: string | null = null): Promise<string> {
    const { candidate: c } = await upsertCandidate({
      weaknessKey: key,
      kind: 'FREE_LANE',
      title: key,
      problem: 'p',
      metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
      downstreamMetric: null,
      ownerComponent: `component:${key}`,
      frequency: 10,
      denominator: 100,
      scope: 'GENERAL',
      severity: 'MEDIUM',
      evidence: {},
    });
    if (decision) await decideCandidate(c.id, decision as 'KEPT', 'test');
    if (deliveredAt) await patchCandidate(c.id, { deliveredAt, changeRequestId: `fcr_${key}`, deliveredRef: 'abc' });
    await getDb().run('UPDATE improvement_candidates SET created_at = ?, updated_at = ? WHERE id = ?', [createdAt, updatedAt, c.id]);
    return c.id;
  }

  it('reports zero identified, nothing closed and an unmeasured median on an empty window', async () => {
    const measures = await readGapMeasures(FROM, TO);
    expect(measures).toMatchObject({
      identified: 0,
      closed: 0,
      closedWithoutOwnerInput: 0,
      deliveredNotProven: 0,
      hoursToUseMedian: null,
      regressions: { reverted: 0, keptNoEffect: 0 },
      productiveWorkResumed: { status: 'NOT_MEASURED' },
      cost: { status: 'NOT_MEASURED' },
    });
  });

  it('counts closures only as measured KEPT, separates owner-touched ones, and takes the median hours', async () => {
    // Three KEPT in the window: 2h, 4h and 10h from detection to decision. Median = 4.
    const a = await candidate('A', '2026-11-01T00:00:00.000Z', 'KEPT', '2026-11-01T02:00:00.000Z');
    await candidate('B', '2026-11-01T01:00:00.000Z', 'KEPT', '2026-11-01T05:00:00.000Z');
    await candidate('C', '2026-11-01T02:00:00.000Z', 'KEPT', '2026-11-01T12:00:00.000Z');
    // Regressions are reported, never counted as closed.
    await candidate('D', '2026-11-01T03:00:00.000Z', 'REVERTED', '2026-11-01T13:00:00.000Z');
    await candidate('E', '2026-11-01T03:00:00.000Z', 'KEPT_NO_EFFECT', '2026-11-01T14:00:00.000Z');
    // Delivered (merged) but undecided: not a success.
    await candidate('F', '2026-11-01T04:00:00.000Z', null, '2026-11-01T15:00:00.000Z', '2026-11-01T06:00:00.000Z');
    // Outside the window: opened before it and decided after it.
    await candidate('G', '2026-10-30T00:00:00.000Z', 'KEPT', '2026-11-03T00:00:00.000Z');
    // The owner touched A, so A is closed but not closed without owner input.
    await recordImprovementEvent({ candidateId: a, kind: 'OWNER_OVERRIDE', detail: {} });

    const measures = await readGapMeasures(FROM, TO);
    expect(measures.identified).toBe(6);
    expect(measures.closed).toBe(3);
    expect(measures.closedWithoutOwnerInput).toBe(2);
    expect(measures.deliveredNotProven).toBe(1);
    expect(measures.regressions).toEqual({ reverted: 1, keptNoEffect: 1 });
    expect(measures.hoursToUseMedian).toBe(4);
    expect(measures.goalQuality).toBeDefined();
  });

  it('averages the two middle values for an even number of closures', async () => {
    await candidate('A', '2026-11-01T00:00:00.000Z', 'KEPT', '2026-11-01T01:00:00.000Z');
    await candidate('B', '2026-11-01T00:00:00.000Z', 'KEPT', '2026-11-01T04:00:00.000Z');
    const measures = await readGapMeasures(FROM, TO);
    expect(measures.closed).toBe(2);
    expect(measures.hoursToUseMedian).toBe(2.5);
    expect(await listCandidates()).toHaveLength(2);
  });
});
