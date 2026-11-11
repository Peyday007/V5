/**
 * AUTO-20-1 / AUTO-20-2 / AUTO-20-4 (program fpg_ea512f54974d4ff39a84).
 *
 * Pins the parts of the capability-gap loop that decide something:
 *  - `refusalFor`: each step's mandatory content, and reuse before acquisition;
 *  - `gapStateFrom`: where a loop stands, read from rows alone (integrated / next /
 *    concluded / cause), so a lost context or restart loses nothing;
 *  - the method-inadequacy branch of the improvement loop's `register()`: a weakness
 *    that persists after an attempt kept without effect or reverted becomes an
 *    attempt that asks for a different method, and one that was merely rejected does not;
 *  - `readGapMeasures`: counting of identified / closed / closed-without-owner-input /
 *    delivered-not-proven / regressions, and the median hours to use.
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
  type CandidateInput,
} from '../server/repos/improvement.ts';
import { improvementTick } from '../server/services/improvement/loop.ts';
import { readGapMeasures, readScoreboard } from '../server/services/improvement/scoreboard.ts';
import {
  GAP_EVENT,
  GAP_LOOP_STEPS,
  GapStepRefused,
  gapStateFrom,
  openGapLoops,
  readGapLoop,
  recordGapStep,
  refusalFor,
  type GapLoopState,
} from '../server/services/selfmodel/gapLoop.ts';

const empty = (gapKey = 'G'): GapLoopState => gapStateFrom(gapKey, []);

function row(step: string, at: string, detail: Record<string, unknown> = {}, reason = step.toLowerCase()) {
  return { at, provider: step, reason, measures: JSON.stringify({ gap: 'G', step, detail }) };
}

describe('refusalFor: what each step must carry', () => {
  it('refuses a NOTICE without an observation and accepts one with it', () => {
    expect(refusalFor('NOTICE', {}, empty())).toMatch(/notice names what was observed/);
    expect(refusalFor('NOTICE', { observation: '   ' }, empty())).not.toBeNull();
    expect(refusalFor('NOTICE', { observation: '30 of 35 fragments refused' }, empty())).toBeNull();
  });

  it('requires a hypothesis to name what it enables, the measure, the failure mode and a known cause', () => {
    const full = { enables: 'claims accepted', measure: 'FREE_LANE_FRAGMENT_PASS_RATE', failureMode: 'the cause is upstream' };
    expect(refusalFor('HYPOTHESIS', { ...full, measure: '' }, empty())).toMatch(/which measure changes/);
    expect(refusalFor('HYPOTHESIS', full, empty())).toMatch(/names its cause/);
    expect(refusalFor('HYPOTHESIS', { ...full, cause: 'BAD_LUCK' }, empty())).toMatch(/names its cause/);
    for (const cause of ['MISSING_DATASET', 'REASONING_DEFECT', 'PERMISSION_GAP', 'UNAVAILABLE_PROVIDER', 'MARKET_LIMITATION', 'METHOD_INADEQUATE', 'OTHER']) {
      expect(refusalFor('HYPOTHESIS', { ...full, cause }, empty())).toBeNull();
    }
  });

  it('requires a search to say where it looked', () => {
    expect(refusalFor('SEARCH_EXISTING', {}, empty())).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: [] }, empty())).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: 'archive' }, empty())).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: ['method archive'] }, empty())).toBeNull();
  });

  it('requires a value judgment to name the choice and what it was compared with', () => {
    expect(refusalFor('VALUE', { chosen: 'research' }, empty())).toMatch(/alternatives/);
    expect(refusalFor('VALUE', { chosen: 'research', alternatives: 'build; abandon' }, empty())).toBeNull();
  });

  it('refuses acquisition before reuse was searched, however complete the acquisition is', () => {
    const acquire = { owner: 'Factory' };
    expect(refusalFor('ACQUIRE', acquire, empty())).toMatch(/reuse comes first/);
    const searched = gapStateFrom('G', [row('SEARCH_EXISTING', '2026-11-01T00:00:00.000Z', { searched: ['x'] })]);
    expect(refusalFor('ACQUIRE', {}, searched)).toMatch(/existing execution owner/);
    expect(refusalFor('ACQUIRE', acquire, searched)).toBeNull();
  });

  it('refuses verification by tests alone: a baseline and a real comparison are both required', () => {
    expect(refusalFor('VERIFY', { comparison: 'tests passed' }, empty())).toMatch(/not tests alone/);
    expect(refusalFor('VERIFY', { baseline: '0.31', comparison: '0.62 on production rows' }, empty())).toBeNull();
  });

  it('requires integration to name capability, provenance and owner, and continuation what resumed', () => {
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p' }, empty())).toMatch(/owning subsystem/);
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }, empty())).toBeNull();
    expect(refusalFor('CONTINUE', {}, empty())).toMatch(/what resumed/);
    expect(refusalFor('CONTINUE', { resumed: 'the free lane' }, empty())).toBeNull();
  });
});

describe('gapStateFrom: where a loop stands, from its rows alone', () => {
  it('starts with every step outstanding and NOTICE next', () => {
    const state = empty();
    expect(state.outstanding).toEqual([...GAP_LOOP_STEPS]);
    expect(state).toMatchObject({ next: 'NOTICE', integrated: false, concluded: false, cause: null, steps: [] });
  });

  it('names the first unrecorded step as next, whatever order the steps were recorded in', () => {
    const state = gapStateFrom('G', [
      row('SEARCH_EXISTING', '2026-11-01T01:00:00.000Z', { searched: ['x'] }),
      row('NOTICE', '2026-11-01T02:00:00.000Z', { observation: 'o' }),
    ]);
    expect(state.next).toBe('HYPOTHESIS');
    expect(state.outstanding).not.toContain('SEARCH_EXISTING');
    expect(state.latest.NOTICE?.summary).toBe('notice');
  });

  it('is integrated only when INTEGRATE follows the last ACQUIRE; a later acquisition reopens it', () => {
    const base = [
      row('SEARCH_EXISTING', '2026-11-01T01:00:00.000Z', { searched: ['x'] }),
      row('ACQUIRE', '2026-11-01T02:00:00.000Z', { owner: 'Factory' }),
      row('INTEGRATE', '2026-11-01T03:00:00.000Z', { capability: 'c', provenance: 'p', owner: 'o' }),
    ];
    expect(gapStateFrom('G', base)).toMatchObject({ integrated: true, concluded: true });
    const reopened = gapStateFrom('G', [...base, row('ACQUIRE', '2026-11-01T04:00:00.000Z', { owner: 'Factory again' })]);
    expect(reopened).toMatchObject({ integrated: false, concluded: false });
    // INTEGRATE with no ACQUIRE at all (a capability found by the search) is integrated.
    expect(gapStateFrom('G', [row('INTEGRATE', '2026-11-01T03:00:00.000Z')]).integrated).toBe(true);
  });

  it('is concluded when the last step is CONTINUE, and a later step reopens it', () => {
    const continued = [row('NOTICE', '2026-11-01T01:00:00.000Z'), row('CONTINUE', '2026-11-01T02:00:00.000Z', { resumed: 'x' })];
    expect(gapStateFrom('G', continued)).toMatchObject({ concluded: true, integrated: false });
    expect(gapStateFrom('G', [...continued, row('VALUE', '2026-11-01T03:00:00.000Z')]).concluded).toBe(false);
  });

  it('reads the cause from the latest hypothesis, ignores unknown steps and survives an unreadable record', () => {
    const state = gapStateFrom('G', [
      row('HYPOTHESIS', '2026-11-01T01:00:00.000Z', { cause: 'MISSING_DATASET' }),
      { at: '2026-11-01T01:30:00.000Z', provider: 'DANCE', reason: 'not a step', measures: '{}' },
      row('HYPOTHESIS', '2026-11-01T02:00:00.000Z', { cause: 'METHOD_INADEQUATE' }),
      { at: '2026-11-01T03:00:00.000Z', provider: 'NOTICE', reason: null, measures: '{not json' },
    ]);
    expect(state.cause).toBe('METHOD_INADEQUATE');
    expect(state.steps.map((s) => s.step)).toEqual(['HYPOTHESIS', 'HYPOTHESIS', 'NOTICE']);
    expect(state.latest.NOTICE).toMatchObject({ summary: '', detail: {} });
    expect(gapStateFrom('G', [row('HYPOTHESIS', '2026-11-01T01:00:00.000Z', { cause: 'NONSENSE' })]).cause).toBeNull();
  });
});

describe('the gap loop on real rows', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('writes nothing when a step is refused, and resumes from the rows after the in-memory state is gone', async () => {
    await expect(recordGapStep({ gapKey: 'GAP:x', step: 'ACQUIRE', summary: 'build it', detail: { owner: 'Factory' } })).rejects.toBeInstanceOf(GapStepRefused);
    const none = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bin_events WHERE event_type = ?', [GAP_EVENT]);
    expect(Number(none?.n)).toBe(0);

    await recordGapStep({ gapKey: 'GAP:x', step: 'NOTICE', summary: 'seen', detail: { observation: 'refusals' } });
    await recordGapStep({ gapKey: 'GAP:x', step: 'SEARCH_EXISTING', summary: 'looked', detail: { searched: ['archive'] } });
    await recordGapStep({ gapKey: 'GAP:x', step: 'ACQUIRE', summary: 'handed over', detail: { owner: 'Factory' } });
    await recordGapStep({ gapKey: 'GAP:y', step: 'NOTICE', summary: 'other', detail: { observation: 'o' } });
    await recordGapStep({ gapKey: 'GAP:y', step: 'CONTINUE', summary: 'resumed', detail: { resumed: 'other work' } });

    // A fresh reader — nothing carried over but the database.
    const resumed = await readGapLoop('GAP:x');
    expect(resumed.steps.map((s) => s.step)).toEqual(['NOTICE', 'SEARCH_EXISTING', 'ACQUIRE']);
    expect(resumed.next).toBe('HYPOTHESIS');
    expect(resumed.latest.ACQUIRE?.detail).toEqual({ owner: 'Factory' });
    expect((await openGapLoops()).map((s) => s.gapKey)).toEqual(['GAP:x']);
  });
});

describe('method inadequacy: a persisting weakness asks for a different method', () => {
  beforeEach(async () => {
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
  });

  async function failures(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason: 'model a: brain_submit_claims refused: x', evidenceClass: 'MEASURED' });
    }
  }

  async function secondAttemptAfter(decision: 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED') {
    await failures(30);
    await improvementTick(new Date(Date.now() + 1000));
    const first = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    expect(first.attempt).toBe(1);
    expect(first.evidence['methodInadequacy']).toBeUndefined();
    for (const open of await listCandidates({ open: true })) {
      expect(await decideCandidate(open.id, decision, `test: ${decision}`)).toBe(true);
      await getDb().run('UPDATE improvement_candidates SET updated_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', open.id]);
    }
    await failures(30);
    await improvementTick(new Date(Date.now() + 2000));
    return { first, second: await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED#2') };
  }

  for (const decision of ['KEPT_NO_EFFECT', 'REVERTED'] as const) {
    it(`judges the method inadequate after an attempt ${decision}, on the candidate and in its detection event`, async () => {
      const { first, second } = await secondAttemptAfter(decision);
      expect(second).toMatchObject({ attempt: 2, parentId: first.id });
      const judged = second!.evidence['methodInadequacy'] as { judgment: string; failedAttempts: number[] };
      expect(judged.failedAttempts).toEqual([1]);
      expect(judged.judgment).toContain(decision);
      expect(judged.judgment).toMatch(/do not re-run it/);
      expect(String(second!.evidence['researchQuestion'])).toMatch(/find a different class of method/);
      const detected = (await listImprovementEvents({ candidateId: second!.id, kinds: ['WEAKNESS_DETECTED'] }))[0];
      expect(detected?.detail).toMatchObject({ attempt: 2, methodInadequacy: { failedAttempts: [1] } });
    });
  }

  it('does not call a method inadequate when the earlier attempt was only rejected', async () => {
    const { second } = await secondAttemptAfter('REJECTED');
    expect(second?.attempt).toBe(2);
    expect(second!.evidence['methodInadequacy']).toBeUndefined();
    const detected = (await listImprovementEvents({ candidateId: second!.id, kinds: ['WEAKNESS_DETECTED'] }))[0];
    expect(detected?.detail['methodInadequacy']).toBeUndefined();
  });
});

describe('readGapMeasures: gaps identified and closed, counted from improvement rows', () => {
  const FROM = '2026-11-01T00:00:00.000Z';
  const TO = '2026-11-02T00:00:00.000Z';

  beforeEach(async () => {
    await freshProject();
  });

  function input(key: string): CandidateInput {
    return {
      weaknessKey: key, kind: 'FREE_LANE', title: key, problem: 'p', metric: 'FREE_LANE_FRAGMENT_PASS_RATE', downstreamMetric: null,
      ownerComponent: 'server/services/x.ts', frequency: 1, denominator: 1, scope: 'GENERAL', severity: 'MEDIUM', evidence: {},
    };
  }

  async function seed(key: string, at: { created: string; updated?: string; delivered?: string }, decision: string | null = null): Promise<string> {
    const { candidate } = await upsertCandidate(input(key));
    await getDb().run(
      'UPDATE improvement_candidates SET created_at = ?, updated_at = ?, delivered_at = ?, decision = ? WHERE id = ?',
      [at.created, at.updated ?? at.created, at.delivered ?? null, decision, candidate.id],
    );
    return candidate.id;
  }

  it('counts each outcome from the rows, never a merge as a closure, and the median hours to use', async () => {
    // Identified in the window: a, b, c, d, e, f (6). g was identified before it.
    await seed('a', { created: '2026-11-01T00:00:00.000Z', updated: '2026-11-01T02:00:00.000Z' }, 'KEPT'); // 2h
    const b = await seed('b', { created: '2026-11-01T01:00:00.000Z', updated: '2026-11-01T05:00:00.000Z' }, 'KEPT'); // 4h, owner touched
    await seed('c', { created: '2026-11-01T02:00:00.000Z', updated: '2026-11-01T12:00:00.000Z' }, 'KEPT'); // 10h
    await seed('d', { created: '2026-11-01T03:00:00.000Z', updated: '2026-11-01T04:00:00.000Z' }, 'REVERTED');
    await seed('e', { created: '2026-11-01T04:00:00.000Z', updated: '2026-11-01T06:00:00.000Z', delivered: '2026-11-01T05:00:00.000Z' }, 'KEPT_NO_EFFECT');
    await seed('f', { created: '2026-11-01T05:00:00.000Z', delivered: '2026-11-01T06:00:00.000Z' }); // merged, undecided
    await seed('g', { created: '2026-10-30T00:00:00.000Z', updated: '2026-11-01T00:00:00.000Z', delivered: '2026-10-31T00:00:00.000Z' }, 'KEPT'); // 48h
    // Outside the window entirely.
    await seed('h', { created: '2026-11-03T00:00:00.000Z', updated: '2026-11-03T01:00:00.000Z' }, 'KEPT');
    await recordImprovementEvent({ candidateId: b, kind: 'OWNER_APPROVED', detail: {} });

    const m = await readGapMeasures(FROM, TO);
    expect(m).toMatchObject({
      from: FROM,
      to: TO,
      identified: 6,
      closed: 4, // a, b, c, g — KEPT only
      closedWithoutOwnerInput: 3, // b had an owner event
      deliveredNotProven: 2, // e (KEPT_NO_EFFECT) and f (undecided); g is KEPT and before the window anyway
      regressions: { reverted: 1, keptNoEffect: 1 },
    });
    // Hours 2, 4, 10, 48 → median (4 + 10) / 2.
    expect(m.hoursToUseMedian).toBe(7);
    expect(m.productiveWorkResumed.status).toBe('NOT_MEASURED');
    expect(m.cost.status).toBe('NOT_MEASURED');
  });

  it('takes the middle value for an odd count, and reports nothing measured rather than zero when none closed', async () => {
    await seed('a', { created: '2026-11-01T00:00:00.000Z', updated: '2026-11-01T01:00:00.000Z' }, 'KEPT');
    await seed('b', { created: '2026-11-01T00:00:00.000Z', updated: '2026-11-01T03:00:00.000Z' }, 'KEPT');
    await seed('c', { created: '2026-11-01T00:00:00.000Z', updated: '2026-11-01T09:00:00.000Z' }, 'KEPT');
    expect((await readGapMeasures(FROM, TO)).hoursToUseMedian).toBe(3);

    await freshProject();
    await seed('z', { created: '2026-11-01T00:00:00.000Z' });
    const none = await readGapMeasures(FROM, TO);
    expect(none).toMatchObject({ identified: 1, closed: 0, closedWithoutOwnerInput: 0, hoursToUseMedian: null });
  });

  it('is carried by the scoreboard itself', async () => {
    await seed('a', { created: '2026-11-01T00:00:00.000Z', updated: '2026-11-01T02:00:00.000Z' }, 'KEPT');
    const board = await readScoreboard(FROM, TO);
    expect(board.gaps).toMatchObject({ identified: 1, closed: 1, closedWithoutOwnerInput: 1, hoursToUseMedian: 2 });
  });
});
