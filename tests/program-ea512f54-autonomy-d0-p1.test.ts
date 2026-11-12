/**
 * The capability-gap loop and its measures (AUTO-20-1, AUTO-20-2, AUTO-20-4; §87/§88).
 *
 * A review of the change that introduced these found them untested. This pins:
 *
 *  - `refusalFor`: each step's mandatory content, and that ACQUIRE is refused
 *    until reuse was searched (SEARCH_EXISTING) — nothing is constructed first;
 *  - `gapStateFrom`: where a loop stands is read from its rows alone — `next`,
 *    `outstanding`, `integrated` (reopened by a later ACQUIRE), `concluded`
 *    and the cause — and a loop survives a restart of the database;
 *  - the method-inadequacy branch of the improvement loop's `register()`: a
 *    weakness that persists after an attempt kept without effect or reverted
 *    opens its next attempt as a judgment that the method was inadequate, and
 *    an attempt merely rejected does not;
 *  - `readGapMeasures`: identified, closed (only KEPT), closed without owner
 *    input, delivered-but-not-proven, regressions and the median hours to use.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, restartDatabase } from './helpers.ts';
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
import { improvementTick } from '../server/services/improvement/loop.ts';
import { readGapMeasures } from '../server/services/improvement/scoreboard.ts';
import { approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import { run } from '../server/services/factory/git.ts';
import { ensureCampaign } from '../server/repos/factory.ts';
import { advanceRun, grantRelease, openRun } from '../server/repos/factoryRelease.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createCandidate as createIdea } from '../server/repos/russellCandidates.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';

const empty = (gapKey = 'GAP:X'): GapLoopState => gapStateFrom(gapKey, []);

function row(step: string, at: string, detail: Record<string, unknown> = {}, reason = `${step} summary`) {
  return { at, provider: step, reason, measures: JSON.stringify({ detail }) };
}

describe('refusalFor: a step is refused when its mandatory content is missing (pure)', () => {
  it('refuses a notice with nothing observed, and accepts one that names its observation', () => {
    expect(refusalFor('NOTICE', {}, empty())).toMatch(/what was observed/);
    expect(refusalFor('NOTICE', { observation: '   ' }, empty())).toMatch(/what was observed/);
    expect(refusalFor('NOTICE', { observation: 'supplier capacity missing in 4 of 5 promising deals' }, empty())).toBeNull();
  });

  it('requires a hypothesis to name what it enables, the measure, the failure mode and a known cause', () => {
    const full = { enables: 'quote within a day', measure: 'quote latency', failureMode: 'buyers decline anyway', cause: 'MISSING_DATASET' };
    expect(refusalFor('HYPOTHESIS', full, empty())).toBeNull();
    for (const key of ['enables', 'measure', 'failureMode'] as const) {
      expect(refusalFor('HYPOTHESIS', { ...full, [key]: '' }, empty())).toMatch(/hypothesis names what the piece enables/);
    }
    expect(refusalFor('HYPOTHESIS', { ...full, cause: 'BAD_LUCK' }, empty())).toMatch(/names its cause/);
    expect(refusalFor('HYPOTHESIS', { ...full, cause: 'METHOD_INADEQUATE' }, empty())).toBeNull();
  });

  it('requires a search of what exists to say where it looked', () => {
    expect(refusalFor('SEARCH_EXISTING', {}, empty())).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: [] }, empty())).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: 'everywhere' }, empty())).toMatch(/where it looked/);
    expect(refusalFor('SEARCH_EXISTING', { searched: ['method archive'] }, empty())).toBeNull();
  });

  it('requires a value judgment to name the option chosen and the alternatives', () => {
    expect(refusalFor('VALUE', { chosen: 'Factory change' }, empty())).toMatch(/alternatives/);
    expect(refusalFor('VALUE', { alternatives: 'research; abandon' }, empty())).toMatch(/option chosen/);
    expect(refusalFor('VALUE', { chosen: 'Factory change', alternatives: 'research; abandon' }, empty())).toBeNull();
  });

  it('refuses ACQUIRE until SEARCH_EXISTING is on the record: reuse comes first', () => {
    const owner = { owner: 'Factory' };
    expect(refusalFor('ACQUIRE', owner, empty())).toMatch(/reuse comes first/);
    const searched = gapStateFrom('GAP:X', [row('SEARCH_EXISTING', '2026-11-01T00:00:00.000Z', { searched: ['archive'] })]);
    expect(refusalFor('ACQUIRE', owner, searched)).toBeNull();
    expect(refusalFor('ACQUIRE', {}, searched)).toMatch(/existing execution owner/);
  });

  it('refuses a verification that is tests alone, without baseline and real-world comparison', () => {
    expect(refusalFor('VERIFY', { comparison: 'tests pass' }, empty())).toMatch(/not tests alone/);
    expect(refusalFor('VERIFY', { baseline: '0.2 pass rate' }, empty())).toMatch(/not tests alone/);
    expect(refusalFor('VERIFY', { baseline: '0.2 pass rate', comparison: '0.45 pass rate on production rows' }, empty())).toBeNull();
  });

  it('requires integration to name capability, provenance and owner, and continuation what resumed', () => {
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p' }, empty())).toMatch(/owning subsystem/);
    expect(refusalFor('INTEGRATE', { capability: 'c', provenance: 'p', owner: 'o' }, empty())).toBeNull();
    expect(refusalFor('CONTINUE', {}, empty())).toMatch(/what resumed/);
    expect(refusalFor('CONTINUE', { resumed: 'cash goal research' }, empty())).toBeNull();
  });
});

describe('gapStateFrom: where a loop stands is read from its rows (pure)', () => {
  it('starts with every step outstanding and NOTICE next', () => {
    const state = empty();
    expect(state.outstanding).toEqual([...GAP_LOOP_STEPS]);
    expect(state.next).toBe('NOTICE');
    expect(state).toMatchObject({ integrated: false, concluded: false, cause: null, steps: [] });
  });

  it('names the first unrecorded step next, whatever order the steps were recorded in', () => {
    const state = gapStateFrom('GAP:X', [
      row('NOTICE', '2026-11-01T00:00:00.000Z', { observation: 'o' }),
      row('SEARCH_EXISTING', '2026-11-01T01:00:00.000Z', { searched: ['a'] }),
    ]);
    expect(state.next).toBe('HYPOTHESIS');
    expect(state.outstanding).toEqual(['HYPOTHESIS', 'VALUE', 'ACQUIRE', 'VERIFY', 'INTEGRATE', 'CONTINUE']);
    expect(state.latest.SEARCH_EXISTING?.detail).toEqual({ searched: ['a'] });
    expect(state.latest.NOTICE?.summary).toBe('NOTICE summary');
  });

  it('keeps the latest record per step and reads the cause from the latest hypothesis', () => {
    const state = gapStateFrom('GAP:X', [
      row('HYPOTHESIS', '2026-11-01T00:00:00.000Z', { cause: 'MISSING_DATASET' }),
      row('HYPOTHESIS', '2026-11-02T00:00:00.000Z', { cause: 'PERMISSION_GAP' }),
    ]);
    expect(state.steps.length).toBe(2);
    expect(state.cause).toBe('PERMISSION_GAP');
    expect(gapStateFrom('GAP:X', [row('HYPOTHESIS', '2026-11-01T00:00:00.000Z', { cause: 'NONSENSE' })]).cause).toBeNull();
  });

  it('is integrated by INTEGRATE after the last ACQUIRE, and reopened by a later ACQUIRE', () => {
    const base = [
      row('SEARCH_EXISTING', '2026-11-01T00:00:00.000Z', { searched: ['a'] }),
      row('ACQUIRE', '2026-11-01T01:00:00.000Z', { owner: 'Factory' }),
      row('INTEGRATE', '2026-11-01T02:00:00.000Z', { capability: 'c', provenance: 'p', owner: 'o' }),
    ];
    const integrated = gapStateFrom('GAP:X', base);
    expect(integrated.integrated).toBe(true);
    expect(integrated.concluded).toBe(true);

    const reopened = gapStateFrom('GAP:X', [...base, row('ACQUIRE', '2026-11-01T03:00:00.000Z', { owner: 'Factory again' })]);
    expect(reopened.integrated).toBe(false);
    expect(reopened.concluded).toBe(false);

    // INTEGRATE with no ACQUIRE at all (retiring a direction) is integrated.
    expect(gapStateFrom('GAP:X', [row('INTEGRATE', '2026-11-01T00:00:00.000Z')]).integrated).toBe(true);
  });

  it('is concluded when CONTINUE is the last step, and reopened by any later step', () => {
    const continued = gapStateFrom('GAP:X', [
      row('NOTICE', '2026-11-01T00:00:00.000Z'),
      row('CONTINUE', '2026-11-01T01:00:00.000Z', { resumed: 'other work' }),
    ]);
    expect(continued).toMatchObject({ concluded: true, integrated: false });
    const again = gapStateFrom('GAP:X', [
      row('NOTICE', '2026-11-01T00:00:00.000Z'),
      row('CONTINUE', '2026-11-01T01:00:00.000Z', { resumed: 'other work' }),
      row('VERIFY', '2026-11-01T02:00:00.000Z', { baseline: 'b', comparison: 'c' }),
    ]);
    expect(again.concluded).toBe(false);
    expect(again.next).toBe('HYPOTHESIS');
  });

  it('ignores rows that are not steps and keeps a step whose detail cannot be parsed', () => {
    const state = gapStateFrom('GAP:X', [
      { at: '2026-11-01T00:00:00.000Z', provider: 'SOMETHING_ELSE', reason: 'x', measures: '{}' },
      { at: '2026-11-01T00:00:00.000Z', provider: null, reason: null, measures: null },
      { at: '2026-11-01T01:00:00.000Z', provider: 'NOTICE', reason: null, measures: '{not json' },
    ]);
    expect(state.steps.map((s) => s.step)).toEqual(['NOTICE']);
    expect(state.latest.NOTICE).toMatchObject({ summary: '', detail: {} });
    expect(state.next).toBe('HYPOTHESIS');
  });
});

describe('the gap loop on real rows', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('refuses ACQUIRE before SEARCH_EXISTING and writes nothing', async () => {
    await recordGapStep({ gapKey: 'GAP:SUPPLIER', step: 'NOTICE', summary: 'supplier capacity missing', detail: { observation: 'o' } });
    await expect(recordGapStep({ gapKey: 'GAP:SUPPLIER', step: 'ACQUIRE', summary: 'build it', detail: { owner: 'Factory' } })).rejects.toBeInstanceOf(
      GapStepRefused,
    );
    const rows = await getDb().all<{ provider: string }>('SELECT provider FROM bin_events WHERE event_type = ? AND workload_class = ?', [GAP_EVENT, 'GAP:SUPPLIER']);
    expect(rows.map((r) => r.provider)).toEqual(['NOTICE']);

    await recordGapStep({ gapKey: 'GAP:SUPPLIER', step: 'SEARCH_EXISTING', summary: 'looked', detail: { searched: ['connectors', 'archive'] } });
    const after = await recordGapStep({ gapKey: 'GAP:SUPPLIER', step: 'ACQUIRE', summary: 'Factory change', detail: { owner: 'Factory' } });
    expect(after.latest.ACQUIRE?.detail).toEqual({ owner: 'Factory' });
  });

  it('continues after context loss: a restarted database answers what comes next, and lists the loop as open until it concludes', async () => {
    await recordGapStep({ gapKey: 'GAP:A', step: 'NOTICE', summary: 'n', detail: { observation: 'o' } });
    await recordGapStep({ gapKey: 'GAP:A', step: 'HYPOTHESIS', summary: 'h', detail: { enables: 'e', measure: 'm', failureMode: 'f', cause: 'REASONING_DEFECT' } });
    await recordGapStep({ gapKey: 'GAP:B', step: 'NOTICE', summary: 'n', detail: { observation: 'o' } });
    await recordGapStep({ gapKey: 'GAP:B', step: 'CONTINUE', summary: 'c', detail: { resumed: 'other work' } });

    await restartDatabase();

    const a = await readGapLoop('GAP:A');
    expect(a).toMatchObject({ next: 'SEARCH_EXISTING', cause: 'REASONING_DEFECT', concluded: false });
    const open = await openGapLoops();
    expect(open.map((s) => s.gapKey)).toEqual(['GAP:A']);
  });
});

describe('register(): a persisting weakness after an ineffective attempt is a method judgment', () => {
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

  async function secondAttemptAfter(decision: 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED') {
    await failures(30);
    await improvementTick(new Date(Date.now() + 1000));
    const first = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    expect(first.attempt).toBe(1);
    await decideCandidate(first.id, decision, `test: ${decision}`);
    // Old enough that the weakness persisting is a new attempt.
    await getDb().run('UPDATE improvement_candidates SET updated_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', first.id]);
    await failures(30);
    await improvementTick(new Date(Date.now() + 2000));
    return getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED#2');
  }

  for (const decision of ['KEPT_NO_EFFECT', 'REVERTED'] as const) {
    it(`records methodInadequacy on the next attempt when the earlier one ended ${decision}`, async () => {
      const second = await secondAttemptAfter(decision);
      expect(second).toMatchObject({ attempt: 2 });
      const judgment = second!.evidence['methodInadequacy'] as { judgment: string; failedAttempts: number[] };
      expect(judgment.failedAttempts).toEqual([1]);
      expect(judgment.judgment).toContain(decision);
      expect(judgment.judgment).toContain('do not re-run it');
      expect(String(second!.evidence['researchQuestion'])).toContain('find a different class of method');
      const detected = await listImprovementEvents({ candidateId: second!.id, kinds: ['WEAKNESS_DETECTED'] });
      expect(detected.length).toBe(1);
      expect(detected[0]!.detail['methodInadequacy']).toEqual(judgment);
    });
  }

  it('does not call a method inadequate when the earlier attempt was only rejected', async () => {
    const second = await secondAttemptAfter('REJECTED');
    expect(second).toMatchObject({ attempt: 2 });
    expect(second!.evidence['methodInadequacy']).toBeUndefined();
    const detected = await listImprovementEvents({ candidateId: second!.id, kinds: ['WEAKNESS_DETECTED'] });
    expect(detected[0]!.detail['methodInadequacy']).toBeUndefined();
  });

  it('does not judge a first attempt at all', async () => {
    await failures(30);
    await improvementTick(new Date(Date.now() + 1000));
    const all = await listCandidates();
    expect(all.length).toBe(1);
    expect(all[0]!.evidence['methodInadequacy']).toBeUndefined();
  });
});

describe('readGapMeasures: gaps identified and closed, counted from improvement rows', () => {
  const FROM = '2026-10-01T00:00:00.000Z';
  const TO = '2026-10-08T00:00:00.000Z';

  beforeEach(async () => {
    await freshProject();
  });

  async function candidate(
    key: string,
    opts: {
      created: string;
      decision?: 'KEPT' | 'KEPT_NO_EFFECT' | 'REVERTED' | 'REJECTED';
      decided?: string;
      delivered?: string;
      /** When the row was last touched, if not at the decision (a re-detection or a later patch). */
      touched?: string;
      /** False: decided on the row with no DECIDED event, as rows written before the event existed. */
      event?: boolean;
    },
  ) {
    const { candidate: c } = await upsertCandidate({
      weaknessKey: key,
      kind: 'FREE_LANE_FAILURE',
      title: key,
      problem: 'p',
      metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
      downstreamMetric: null,
      ownerComponent: 'server/services/freeLane/worker.ts',
      frequency: 10,
      denominator: 100,
      scope: 'GENERAL',
      severity: 'MEDIUM',
      evidence: {},
    });
    if (opts.decision) {
      await decideCandidate(c.id, opts.decision, 'test');
      // As the loop does (loop.ts): every decision is also an append-only DECIDED event, and that event is when the gap closed.
      if (opts.event !== false) await recordImprovementEvent({ candidateId: c.id, kind: 'DECIDED', detail: { decision: opts.decision }, at: opts.decided ?? opts.created });
    }
    await getDb().run('UPDATE improvement_candidates SET created_at = ?, updated_at = ?, delivered_at = ? WHERE id = ?', [
      opts.created,
      opts.touched ?? opts.decided ?? opts.created,
      opts.delivered ?? null,
      c.id,
    ]);
    return c.id;
  }

  it('counts only KEPT as closed, separates owner-touched and delivered-but-unproven, and takes the median hours', async () => {
    // Three kept in the window: 2h, 10h and 30h from detection to the measured decision.
    const k1 = await candidate('K1', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T02:00:00.000Z' });
    await candidate('K2', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T10:00:00.000Z' });
    await candidate('K3', { created: '2026-10-03T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-04T06:00:00.000Z' });
    await candidate('NE', { created: '2026-10-03T00:00:00.000Z', decision: 'KEPT_NO_EFFECT', decided: '2026-10-05T00:00:00.000Z' });
    await candidate('RV', { created: '2026-10-03T00:00:00.000Z', decision: 'REVERTED', decided: '2026-10-05T00:00:00.000Z' });
    await candidate('RJ', { created: '2026-10-03T00:00:00.000Z', decision: 'REJECTED', decided: '2026-10-05T00:00:00.000Z' });
    // Merged but not shown to have worked: never a success.
    await candidate('DL', { created: '2026-10-04T00:00:00.000Z', delivered: '2026-10-05T00:00:00.000Z' });
    // Outside the window entirely.
    await candidate('OLD', { created: '2026-09-01T00:00:00.000Z', decision: 'KEPT', decided: '2026-09-02T00:00:00.000Z' });
    // The owner touched one closed gap.
    await recordImprovementEvent({ candidateId: k1, kind: 'OWNER_OVERRIDE', detail: {} });

    const m = await readGapMeasures(FROM, TO);
    expect(m.identified).toBe(7);
    expect(m.closed).toBe(3);
    // K1 the owner touched; K2 and K3 link no campaign, so the rows cannot say how they were merged: unmeasured, never "without owner input".
    expect(m.closedWithoutOwnerInput).toBe(0);
    expect(m.ownerInput).toMatchObject({ gaps: 3, withoutOwnerInput: 0, withOwnerInput: 1, unmeasured: 2 });
    expect(m.deliveredNotProven).toBe(1);
    expect(m.hoursToUseMedian).toBe(10);
    expect(m.regressions).toEqual({ reverted: 1, keptNoEffect: 1 });
    // Measured, not declared unmeasured: no row in this case gives a before/after window or a campaign, and the figures say so.
    expect(m.productiveWorkResumed).toMatchObject({ status: 'MEASURED', gaps: 3, continued: 0, attributed: 0, unitsPerDayGained: 0 });
    expect(m.cost).toMatchObject({ status: 'MEASURED', gaps: 5, attributed: 0, bins: 0, leases: 0, workerMs: 0 });
  });

  it('measures the productive work a kept gap released and the worker time its Factory campaign cost', async () => {
    const { project } = await freshProject();
    const kept = await candidate('PW', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-04T00:00:00.000Z' });
    const reverted = await candidate('RV2', { created: '2026-10-02T00:00:00.000Z', decision: 'REVERTED', decided: '2026-10-05T00:00:00.000Z' });
    // As measureAndDecide writes it: the metric before delivery (2 days, 10 submitted) and after (1 day, 20 submitted).
    const result = {
      before: { key: 'FREE_LANE_FRAGMENT_PASS_RATE', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z', numerator: 10, denominator: 40 },
      after: { key: 'FREE_LANE_FRAGMENT_PASS_RATE', from: '2026-10-03T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', numerator: 20, denominator: 25 },
    };
    await getDb().run('UPDATE improvement_candidates SET result = ?, campaign_id = ? WHERE id = ?', [JSON.stringify(result), 'fcp_pw', kept]);
    await getDb().run('UPDATE improvement_candidates SET campaign_id = ? WHERE id = ?', ['fcp_rv', reverted]);
    // The gap loop recorded CONTINUE for the kept gap: it resumed other work.
    await recordBinEvent({ eventType: 'CAPABILITY_GAP_STEP', provider: 'CONTINUE', workloadClass: 'PW', outcome: 'RECORDED', evidenceClass: 'MEASURED' });
    // Factory bins of both campaigns, and the leases that ended on them.
    const bin = async (id: string, campaign: string) =>
      getDb().run(
        `INSERT INTO bins (id, project_id, kind, title, objective, completion_contract, state, created_by_type, created_at, updated_at, factory_campaign_id)
         VALUES (?, ?, 'FACTORY_UNITS', ?, 'o', 'FACTORY_UNITS_V1', 'COMPLETE', 'SYSTEM', ?, ?, ?)`,
        [id, project.id, id, FROM, FROM, campaign],
      );
    await bin('bin_pw', 'fcp_pw');
    await bin('bin_rv', 'fcp_rv');
    await bin('bin_other', 'fcp_unrelated');
    await recordBinEvent({ eventType: 'BIN_TERMINAL', binId: 'bin_pw', leaseId: 'l1', leaseGeneration: 1, durationMs: 60_000, outcome: 'COMPLETE' });
    await recordBinEvent({ eventType: 'BIN_RELEASED', binId: 'bin_rv', leaseId: 'l2', leaseGeneration: 1, outcome: 'RELEASED' });
    await recordBinEvent({ eventType: 'BIN_TERMINAL', binId: 'bin_rv', leaseId: 'l3', leaseGeneration: 2, durationMs: 30_000, outcome: 'COMPLETE' });
    await recordBinEvent({ eventType: 'BIN_TERMINAL', binId: 'bin_other', leaseId: 'l4', leaseGeneration: 1, durationMs: 999_000, outcome: 'COMPLETE' });

    const m = await readGapMeasures(FROM, TO);
    expect(m.productiveWorkResumed).toEqual({
      status: 'MEASURED',
      gaps: 1,
      continued: 1,
      attributed: 1,
      unitsPerDayGained: 15,
      perGap: [{ weaknessKey: 'PW', metric: 'FREE_LANE_FRAGMENT_PASS_RATE', beforePerDay: 5, afterPerDay: 20, continued: true }],
    });
    // Both attempts were paid for; the unrelated campaign's bin is not.
    expect(m.cost).toEqual({ status: 'MEASURED', gaps: 2, attributed: 2, bins: 2, leases: 3, leasesUntimed: 1, workerMs: 90_000 });
  });

  it('reads owner input from how each gap was merged and whether Factory stopped for a person (F-OWNER-INPUT-UNMEASURED)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-input-repo-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'subject', scripts: {} }));
      await run('git', ['init', '-b', 'main'], { cwd: root });
      await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
      await run('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
      await run('git', ['add', '-A'], { cwd: root });
      await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
      const project = (await getProjectBySlug('deal-dispatch'))!;
      const admin = await createUser({ email: 'owner-input@test.local', displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
      // One approved change request and campaign per gap; `grantBy` says who executed the release grant, when there is one.
      const gap = async (key: string, merge: string, release: { grantBy: string | null; live: boolean } | null) => {
        const id = await candidate(key, { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-03T00:00:00.000Z' });
        const submitted = await submitObjective({
          projectId: project.id,
          objective: `Improve ${key} so its metric moves.`,
          expectedOutcome: 'the metric moves',
          acceptanceConditions: [{ statement: 'the metric moves', verification: 'measure it' }],
          repositoryRoot: root,
          mutationScope: ['client/**'],
        });
        const approved = await approveObjective({ changeRequestId: submitted.changeRequest.id, via: 'PERSON', userId: admin.id });
        expect(approved.ok).toBe(true);
        const { campaign } = await ensureCampaign({
          changeRequestId: submitted.changeRequest.id,
          projectId: project.id,
          baseSha: approved.changeRequest.baseSha,
          laneTarget: 1,
          laneTargetReason: 'initial',
        });
        await getDb().run('UPDATE improvement_candidates SET campaign_id = ?, delivered_ref = ? WHERE id = ?', [campaign.id, merge, id]);
        if (release) {
          const { grant } = await grantRelease({
            changeRequestId: submitted.changeRequest.id,
            projectId: project.id,
            liveChecks: [],
            pagePath: null,
            grantedByUserId: admin.id,
            authorityChannel: 'SHELL',
            executedByRef: release.grantBy,
            reason: 'test',
          });
          const { run: opened } = await openRun({ campaignId: campaign.id, changeRequestId: submitted.changeRequest.id, grantId: grant.id, headSha: 'a'.repeat(40), attempt: 1, state: 'GATING', refusal: [], workflowRunId: null });
          if (release.live) await advanceRun(opened!.id, { from: ['GATING'], to: 'LIVE', mergeSha: merge });
          else await advanceRun(opened!.id, { from: ['GATING'], to: 'FAILED', failureStage: 'GATE', failureDetail: 'flaky suite' });
        }
        return id;
      };
      // Brain released it alone, under the loop's standing grant.
      await gap('AUTO', 'b'.repeat(40), { grantBy: 'improvement-loop', live: true });
      // Its release failed and the merge happened anyway: a hand merge.
      await gap('HAND', 'c'.repeat(40), { grantBy: 'improvement-loop', live: false });
      // Never granted: a person merged it.
      await gap('NOGRANT', 'd'.repeat(40), null);
      // Released, but under a grant a person gave for that change.
      await gap('PERSONGRANT', 'e'.repeat(40), { grantBy: null, live: true });
      // Brain released it, but Factory had stopped for a person on the way.
      const stopped = await gap('STOPPED', 'f'.repeat(40), { grantBy: 'improvement-loop', live: true });
      await recordImprovementEvent({ candidateId: stopped, kind: 'FACTORY_BLOCKED', detail: { detail: 'x', needsPerson: true, personAction: 'Approve or refuse the release on Build.' } });
      // Brain released it, and the stop on the way was Brain's own.
      const own = await gap('OWNSTOP', '1'.repeat(40), { grantBy: 'improvement-loop', live: true });
      await recordImprovementEvent({ candidateId: own, kind: 'FACTORY_BLOCKED', detail: { detail: 'no surface', needsPerson: false, personAction: null } });
      // Brain released it, but a stop recorded before the loop said whether it waited on a person.
      const legacy = await gap('LEGACYSTOP', '2'.repeat(40), { grantBy: 'improvement-loop', live: true });
      await recordImprovementEvent({ candidateId: legacy, kind: 'FACTORY_BLOCKED', detail: { detail: 'old' } });

      const m = await readGapMeasures(FROM, TO);
      const finding = Object.fromEntries(m.ownerInput.perGap.map((g) => [g.weaknessKey, g.finding]));
      expect(finding).toEqual({
        AUTO: 'NONE',
        HAND: 'OWNER_INPUT',
        NOGRANT: 'OWNER_INPUT',
        PERSONGRANT: 'OWNER_INPUT',
        STOPPED: 'OWNER_INPUT',
        OWNSTOP: 'NONE',
        LEGACYSTOP: 'UNMEASURED',
      });
      expect(m.closed).toBe(7);
      expect(m.closedWithoutOwnerInput).toBe(2);
      expect(m.ownerInput).toMatchObject({ gaps: 7, withoutOwnerInput: 2, withOwnerInput: 4, unmeasured: 1 });
      expect(m.ownerInput.perGap.find((g) => g.weaknessKey === 'HAND')!.reason).toMatch(/hand merge/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a gap closed by a hand-off to a non-software owner from its own rows, and costs it through the work it was given (F1-HANDOFF-CLOSURE-ALWAYS-UNMEASURED)', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layerId = (await fixture.layerByName('Monetization Logic')).id;
    const DELIVERED_AT = '2026-10-02T12:00:00.000Z';
    // As handToOwner writes it: deliveredRef OWNER:<route>:<owner>, no campaign, and a DELIVERED event naming the work given.
    const handoff = async (key: string, work: Record<string, unknown>[] | null) => {
      const id = await candidate(key, { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-04T00:00:00.000Z', delivered: DELIVERED_AT });
      await getDb().run('UPDATE improvement_candidates SET delivered_ref = ? WHERE id = ?', ['OWNER:CONNECTOR:research pipeline', id]);
      if (work) {
        await recordImprovementEvent({
          candidateId: id,
          kind: 'DELIVERED',
          detail: { handedTo: 'research pipeline', route: 'CONNECTOR', handed: work.length, family: 'UNMET_NEED', work, refused: [] },
          at: DELIVERED_AT,
        });
      }
      return id;
    };
    const routed = async (gapKey: string, route: string, needId: string, at: string) => {
      const event = await recordCashEvent({ projectId, kind: 'CASH_NEED_ROUTED', actorRef: 'improvement loop', summary: 's', detail: { needId, gapKey, route, owner: route === 'PERSON' ? 'a person' : 'research pipeline', work: { kind: route } } });
      await getDb().run('UPDATE cash_events SET created_at = ? WHERE id = ?', [at, event.id]);
    };

    // Handed to research, a worker given the need, and nobody else on record: closed without owner input.
    const idea = await createIdea({ projectId, title: 'find the supplier', statement: 'find the supplier' });
    await handoff('HOFF_NONE', [{ needId: 'need_a', route: 'CONNECTOR', owner: 'research pipeline', kind: 'ALLOCATED', candidateId: idea.id, reused: false }]);
    await routed('HOFF_NONE', 'CONNECTOR', 'need_a', DELIVERED_AT);
    // A PERSON route for some other gap, or for this gap outside its lifetime, says nothing about this one.
    await routed('SOME_OTHER_GAP', 'PERSON', 'need_x', DELIVERED_AT);
    await routed('HOFF_NONE', 'PERSON', 'need_old', '2026-09-01T00:00:00.000Z');
    // One of its pieces was left for a person's review.
    await handoff('HOFF_PERSON_WORK', [
      { needId: 'need_b', route: 'CONNECTOR', owner: 'research pipeline', kind: 'ALLOCATED', candidateId: 'idea_unlaunched', reused: false },
      { needId: 'need_p', route: 'PERSON', owner: 'a person', kind: 'PERSON' },
    ]);
    // Its own DELIVERED record shows only the watch, but the cash events say a need of this gap was routed to a person.
    await handoff('HOFF_PERSON_ROUTED', [{ needId: 'need_w', route: 'WATCH', owner: 'reconsideration', kind: 'WATCH' }]);
    await routed('HOFF_PERSON_ROUTED', 'PERSON', 'need_q', '2026-10-02T06:00:00.000Z');
    // It was held for a person before it was handed off.
    const held = await handoff('HOFF_HELD', [{ needId: 'need_h', route: 'CONNECTOR', owner: 'research pipeline', kind: 'ALLOCATED', candidateId: 'idea_h', reused: true }]);
    await recordImprovementEvent({ candidateId: held, kind: 'DECIDED', detail: { decision: 'HELD', needsPerson: true, personAction: 'a person supplies the credential' }, at: '2026-10-02T01:00:00.000Z' });
    // Marked handed off, but no DELIVERED record says what was given: the rows cannot say.
    await handoff('HOFF_NORECORD', null);

    // The research the first hand-off was given: its idea's mission, that mission's packet, and the bin that worked it.
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
    const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'supplier', assignment: 'find it', provider: 'WORKER' });
    await getDb().run(
      `INSERT INTO russell_missions (id, project_id, candidate_id, objective, why_now, state, orchestration_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, 'o', 'w', 'DONE', ?, ?, ?, ?)`,
      ['rmi_hoff', projectId, idea.id, orchestration.id, 'hoff-mission', DELIVERED_AT, DELIVERED_AT],
    );
    await getDb().run(
      `INSERT INTO bins (id, project_id, kind, title, objective, completion_contract, state, created_by_type, created_at, updated_at, orchestration_id)
       VALUES ('bin_hoff', ?, 'FACTORY_UNITS', 'research', 'o', 'FACTORY_UNITS_V1', 'COMPLETE', 'SYSTEM', ?, ?, ?)`,
      [projectId, DELIVERED_AT, DELIVERED_AT, orchestration.id],
    );
    await recordBinEvent({ eventType: 'BIN_TERMINAL', binId: 'bin_hoff', leaseId: 'lh', leaseGeneration: 1, durationMs: 45_000, outcome: 'COMPLETE' });

    const m = await readGapMeasures(FROM, TO);
    const finding = Object.fromEntries(m.ownerInput.perGap.map((g) => [g.weaknessKey, g.finding]));
    expect(finding).toEqual({
      HOFF_NONE: 'NONE',
      HOFF_PERSON_WORK: 'OWNER_INPUT',
      HOFF_PERSON_ROUTED: 'OWNER_INPUT',
      HOFF_HELD: 'OWNER_INPUT',
      HOFF_NORECORD: 'UNMEASURED',
    });
    expect(m.closed).toBe(5);
    expect(m.closedWithoutOwnerInput).toBe(1);
    expect(m.ownerInput).toMatchObject({ gaps: 5, withoutOwnerInput: 1, withOwnerInput: 3, unmeasured: 1 });
    const reason = Object.fromEntries(m.ownerInput.perGap.map((g) => [g.weaknessKey, g.reason]));
    expect(reason['HOFF_NONE']).toMatch(/handed by Brain to research pipeline \(CONNECTOR\): 1 piece\(s\) given to workers, no person on record/);
    expect(reason['HOFF_PERSON_WORK']).toMatch(/need_p was left for a person's review/);
    expect(reason['HOFF_PERSON_ROUTED']).toMatch(/need_q was routed to a person/);
    expect(reason['HOFF_HELD']).toMatch(/held for a person: a person supplies the credential/);
    expect(reason['HOFF_NORECORD']).toMatch(/no readable DELIVERED record/);
    // Only the hand-off whose research ran on a bin is attributed; its lease is the cost.
    expect(m.cost).toEqual({ status: 'MEASURED', gaps: 5, attributed: 1, bins: 1, leases: 1, leasesUntimed: 0, workerMs: 45_000 });
  });

  it('averages the middle two for an even count, and says unmeasured when nothing closed', async () => {
    expect((await readGapMeasures(FROM, TO)).hoursToUseMedian).toBeNull();
    await candidate('A', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T04:00:00.000Z' });
    await candidate('B', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T07:00:00.000Z' });
    const m = await readGapMeasures(FROM, TO);
    expect(m.closed).toBe(2);
    expect(m.closedWithoutOwnerInput).toBe(0);
    expect(m.ownerInput.unmeasured).toBe(2);
    expect(m.hoursToUseMedian).toBe(5.5);
  });

  it('times a closed gap from its DECIDED event, so a later touch of the row neither moves it nor its window', async () => {
    // Decided inside the window, re-detected (row touched) a month later: still closed in this window, 6h to use.
    await candidate('T', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T06:00:00.000Z', touched: '2026-11-02T00:00:00.000Z' });
    // Decided before the window but touched inside it: not closed in this window.
    await candidate('P', { created: '2026-09-20T00:00:00.000Z', decision: 'KEPT', decided: '2026-09-21T00:00:00.000Z', touched: '2026-10-03T00:00:00.000Z' });
    const m = await readGapMeasures(FROM, TO);
    expect(m.closed).toBe(1);
    expect(m.hoursToUseMedian).toBe(6);
    expect((await readGapMeasures('2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z')).closed).toBe(0);
  });

  it('does not count a decided row with no DECIDED event: its decision time is unknown, not its last touch', async () => {
    await candidate('U', { created: '2026-10-02T00:00:00.000Z', decision: 'KEPT', decided: '2026-10-02T03:00:00.000Z', event: false });
    const m = await readGapMeasures(FROM, TO);
    expect(m.closed).toBe(0);
    expect(m.hoursToUseMedian).toBeNull();
  });
});
