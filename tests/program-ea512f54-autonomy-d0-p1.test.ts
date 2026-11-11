/**
 * AUTO-20-1 / AUTO-20-2 / AUTO-20-4: the capability-gap loop, the judgment
 * that a method was inadequate, and the gap measures the scoreboard reports.
 *
 * Pins the four behaviours a reviewer found untested: `refusalFor`'s mandatory
 * content per step (reuse before construction, verification beyond tests),
 * `gapStateFrom`'s `integrated` / `next` reading, `register()`'s
 * methodInadequacy branch reached through the real `improvementTick`, and
 * `readGapMeasures`' counting and median.
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
  recordImprovementEvent,
  upsertCandidate,
} from '../server/repos/improvement.ts';
import { improvementTick } from '../server/services/improvement/loop.ts';
import { readGapMeasures } from '../server/services/improvement/scoreboard.ts';
import {
  GAP_LOOP_STEPS,
  gapStateFrom,
  refusalFor,
  type GapLoopState,
} from '../server/services/selfmodel/gapLoop.ts';

const empty: GapLoopState = gapStateFrom('G', []);

function row(step: string, at: string, detail: Record<string, unknown> = {}) {
  return { at, provider: step, reason: `${step} summary`, measures: JSON.stringify({ detail }) };
}

describe('refusalFor: each step carries its mandatory content (pure)', () => {
  it('refuses a notice without an observation and accepts one with it', () => {
    expect(refusalFor('NOTICE', {}, empty)).toMatch(/observed/);
    expect(refusalFor('NOTICE', { observation: '   ' }, empty)).toMatch(/observed/);
    expect(refusalFor('NOTICE', { observation: 'supplier capacity missing on 4 deals' }, empty)).toBeNull();
  });

  it('requires a hypothesis to name what it enables, the measure, the failure mode and a known cause', () => {
    const base = { enables: 'x', measure: 'y', failureMode: 'z' };
    expect(refusalFor('HYPOTHESIS', { enables: 'x', measure: 'y' }, empty)).toMatch(/fail/);
    expect(refusalFor('HYPOTHESIS', base, empty)).toMatch(/cause/);
    expect(refusalFor('HYPOTHESIS', { ...base, cause: 'NOT_A_CAUSE' }, empty)).toMatch(/cause/);
    expect(refusalFor('HYPOTHESIS', { ...base, cause: 'METHOD_INADEQUATE' }, empty)).toBeNull();
  });

  it('requires a search to say where it looked', () => {
    expect(refusalFor('SEARCH_EXISTING', { searched: [] }, empty)).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: 'code' }, empty)).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: ['server/services/selfmodel'] }, empty)).toBeNull();
  });

  it('requires a value judgment to name the choice and its alternatives', () => {
    expect(refusalFor('VALUE', { chosen: 'build' }, empty)).toMatch(/alternatives/);
    expect(refusalFor('VALUE', { chosen: 'build', alternatives: 'buy, abandon' }, empty)).toBeNull();
  });

  it('refuses acquisition before reuse was checked, then requires an owner', () => {
    expect(refusalFor('ACQUIRE', { owner: 'factory' }, empty)).toMatch(/reuse comes first/);
    const searched = gapStateFrom('G', [row('SEARCH_EXISTING', '2026-11-01T00:00:00.000Z', { searched: ['a'] })]);
    expect(refusalFor('ACQUIRE', {}, searched)).toMatch(/owner/);
    expect(refusalFor('ACQUIRE', { owner: 'factory' }, searched)).toBeNull();
  });

  it('refuses verification on tests alone: a baseline and a real comparison are mandatory', () => {
    expect(refusalFor('VERIFY', { tests: 'green' }, empty)).toMatch(/baseline/);
    expect(refusalFor('VERIFY', { baseline: 'b' }, empty)).toMatch(/baseline/);
    expect(refusalFor('VERIFY', { baseline: 'b', comparison: 'c' }, empty)).toBeNull();
  });

  it('requires integration to name capability, provenance and owner, and continuation what resumed', () => {
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p' }, empty)).toMatch(/owning subsystem/);
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }, empty)).toBeNull();
    expect(refusalFor('CONTINUE', {}, empty)).toMatch(/resumed/);
    expect(refusalFor('CONTINUE', { resumed: 'goal g' }, empty)).toBeNull();
  });
});

describe('gapStateFrom: where a loop stands, read from its rows (pure)', () => {
  it('starts with every step outstanding and NOTICE next', () => {
    expect(empty.outstanding).toEqual([...GAP_LOOP_STEPS]);
    expect(empty.next).toBe('NOTICE');
    expect(empty.integrated).toBe(false);
    expect(empty.cause).toBeNull();
  });

  it('ignores rows that are not steps, survives an unreadable record, and reads the cause from the latest hypothesis', () => {
    const state = gapStateFrom('G', [
      row('NOTICE', '2026-11-01T00:00:00.000Z', { observation: 'o' }),
      { at: '2026-11-01T00:01:00.000Z', provider: 'NOT_A_STEP', reason: null, measures: '{}' },
      { at: '2026-11-01T00:02:00.000Z', provider: 'HYPOTHESIS', reason: null, measures: '{not json' },
      row('HYPOTHESIS', '2026-11-01T00:03:00.000Z', { cause: 'MISSING_DATASET' }),
    ]);
    expect(state.steps.map((s) => s.step)).toEqual(['NOTICE', 'HYPOTHESIS', 'HYPOTHESIS']);
    expect(state.cause).toBe('MISSING_DATASET');
    expect(state.next).toBe('SEARCH_EXISTING');
  });

  it('is integrated only when INTEGRATE follows the last ACQUIRE; a re-acquisition reopens it', () => {
    const through = [
      row('SEARCH_EXISTING', '2026-11-01T00:00:00.000Z'),
      row('ACQUIRE', '2026-11-01T01:00:00.000Z'),
      row('INTEGRATE', '2026-11-01T02:00:00.000Z'),
    ];
    expect(gapStateFrom('G', through).integrated).toBe(true);
    const reopened = gapStateFrom('G', [...through, row('ACQUIRE', '2026-11-01T03:00:00.000Z')]);
    expect(reopened.integrated).toBe(false);
    // Integrating with no acquisition (an existing capability reused) counts.
    expect(gapStateFrom('G', [row('INTEGRATE', '2026-11-01T00:00:00.000Z')]).integrated).toBe(true);
  });

  it('reports next as null once every step is recorded', () => {
    const all = GAP_LOOP_STEPS.map((step, i) => row(step, `2026-11-01T0${i}:00:00.000Z`));
    const state = gapStateFrom('G', all);
    expect(state.outstanding).toEqual([]);
    expect(state.next).toBeNull();
  });
});

describe('with a database', () => {
  beforeEach(async () => {
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
  });

  async function failures(n: number, reason: string): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason, evidenceClass: 'MEASURED' });
    }
  }

  async function nextAttemptAfter(decision: 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED') {
    await failures(30, 'model a: brain_submit_claims refused: x');
    await improvementTick(new Date(Date.now() + 1000));
    const first = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    expect(first).toBeTruthy();
    await decideCandidate(first.id, decision, `test: ${decision}`);
    await getDb().run('UPDATE improvement_candidates SET updated_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', first.id]);
    await failures(30, 'model a: brain_submit_claims refused: x');
    await improvementTick(new Date(Date.now() + 2000));
    return { first, second: await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED#2') };
  }

  it('judges the method inadequate when a weakness persists after an attempt kept without effect', async () => {
    const { first, second } = await nextAttemptAfter('KEPT_NO_EFFECT');
    expect(second).toMatchObject({ attempt: 2, parentId: first.id });
    const judged = second!.evidence['methodInadequacy'] as { judgment: string; failedAttempts: number[] };
    expect(judged.failedAttempts).toEqual([1]);
    expect(judged.judgment).toMatch(/KEPT_NO_EFFECT/);
    expect(String(second!.evidence['researchQuestion'])).toMatch(/different class of method/);
    const detected = (await listImprovementEvents({ candidateId: second!.id })).find((e) => e.kind === 'WEAKNESS_DETECTED');
    expect(detected?.detail['methodInadequacy']).toEqual(judged);
  });

  it('judges it inadequate after a reverted attempt too', async () => {
    const { second } = await nextAttemptAfter('REVERTED');
    expect((second!.evidence['methodInadequacy'] as { failedAttempts: number[] }).failedAttempts).toEqual([1]);
  });

  it('does not call a method inadequate when the earlier attempt was not tried and failed', async () => {
    const { second } = await nextAttemptAfter('REJECTED');
    expect(second).toMatchObject({ attempt: 2 });
    expect(second!.evidence['methodInadequacy']).toBeUndefined();
    const detected = (await listImprovementEvents({ candidateId: second!.id })).find((e) => e.kind === 'WEAKNESS_DETECTED');
    expect(detected?.detail['methodInadequacy']).toBeUndefined();
  });

  it('counts gaps identified and closed, with and without owner input, and the median hours to use', async () => {
    const FROM = '2026-11-01T00:00:00.000Z';
    const TO = '2026-11-02T00:00:00.000Z';
    let n = 0;
    async function candidate(created: string, updated: string, decision: string | null, delivered: string | null = null): Promise<string> {
      n += 1;
      const { candidate } = await upsertCandidate({
        weaknessKey: `TEST:GAP_${n}`,
        kind: 'ENGINEERING',
        title: `gap ${n}`,
        problem: 'p',
        metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
        downstreamMetric: null,
        ownerComponent: `component-${n}`,
        frequency: 1,
        denominator: 1,
        scope: 'LOCAL',
        severity: 'LOW',
        evidence: {},
      });
      await getDb().run('UPDATE improvement_candidates SET decision = ?, created_at = ?, updated_at = ?, delivered_at = ? WHERE id = ?', [
        decision,
        created,
        updated,
        delivered,
        candidate.id,
      ]);
      return candidate.id;
    }
    // Identified in the window: four created inside it, one before.
    const keptA = await candidate('2026-11-01T01:00:00.000Z', '2026-11-01T03:00:00.000Z', 'KEPT'); // 2h
    const keptB = await candidate('2026-11-01T02:00:00.000Z', '2026-11-01T08:00:00.000Z', 'KEPT'); // 6h
    await candidate('2026-11-01T04:00:00.000Z', '2026-11-01T05:00:00.000Z', 'REVERTED');
    await candidate('2026-11-01T06:00:00.000Z', '2026-11-01T07:00:00.000Z', 'KEPT_NO_EFFECT', '2026-11-01T06:30:00.000Z');
    const keptC = await candidate('2026-10-31T00:00:00.000Z', '2026-11-01T10:00:00.000Z', 'KEPT'); // 34h, created before
    await candidate('2026-10-30T00:00:00.000Z', '2026-10-30T01:00:00.000Z', 'KEPT'); // decided outside the window
    await recordImprovementEvent({ candidateId: keptB, kind: 'OWNER_OVERRIDE', detail: {} });

    const measures = await readGapMeasures(FROM, TO);
    expect(measures.identified).toBe(4);
    expect(measures.closed).toBe(3);
    expect(measures.closedWithoutOwnerInput).toBe(2);
    expect(measures.hoursToUseMedian).toBe(6); // median of 2, 6, 34
    expect(measures.regressions).toEqual({ reverted: 1, keptNoEffect: 1 });
    expect(measures.deliveredNotProven).toBe(1);
    expect(measures.cost.status).toBe('NOT_MEASURED');
    expect(measures.productiveWorkResumed.status).toBe('NOT_MEASURED');

    // An even count takes the mean of the two middle values.
    await getDb().run('UPDATE improvement_candidates SET decision = ? WHERE id = ?', ['REVERTED', keptC]);
    expect((await readGapMeasures(FROM, TO)).hoursToUseMedian).toBe(4); // (2 + 6) / 2
    void keptA;
  });

  it('reports no median, not zero, when nothing was closed', async () => {
    const measures = await readGapMeasures('2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    expect(measures).toMatchObject({ identified: 0, closed: 0, closedWithoutOwnerInput: 0, hoursToUseMedian: null });
    expect(await listCandidates()).toEqual([]);
  });
});
