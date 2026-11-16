/**
 * Filter at loop (EXPERIMENT evx_f0f141e30794417c8187, variant
 * "filter-at-loop"; OPERATOR:RECURRING_OPERATIONAL_FAILURE:8298f8d1444104b1).
 *
 * The loop's `answered-requests` pass now reads each answered card's mission
 * before resuming it. These tests drive the real repositories and real ticks.
 * `resumeAnsweredRequest` is wrapped around the real implementation, so the
 * test can count calls and inject the one race below. The behaviour pinned:
 *
 *  - An answer whose mission already left NEEDS_HUMAN is withdrawn as moot
 *    and never resumed. At the base commit, a RECORD_GAPS answer like that
 *    still ran the resume, which authorized the packet's gap policy in the
 *    person's name before reporting that the mission had moved on.
 *  - The recorded failure class: a card the pass reopened earlier, whose
 *    mission a later answer in the same pass moves on, ended the pass OPEN in
 *    front of a person. The operator then withdrew it by hand
 *    (OPERATOR_WITHDREW_MOOT_REQUEST) or a later pass swept it, and it was
 *    never reported as a moot answer. The pass now withdraws it itself.
 *  - A mission still waiting is reopened exactly as before, a missionless
 *    answer behaves as before, a STOP still stops, and a mission that leaves
 *    NEEDS_HUMAN during a failed resume is withdrawn, not reopened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  calls: [] as string[],
  /** When set, the next resume of this request moves its mission to RUNNING and then fails. */
  raceOn: null as string | null,
}));

vi.mock('../server/services/russell/needsHuman.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/russell/needsHuman.ts')>();
  const { transitionMission } = await import('../server/repos/russellMissions.ts');
  return {
    ...real,
    resumeAnsweredRequest: async (request: Parameters<typeof real.resumeAnsweredRequest>[0]) => {
      control.calls.push(request.id);
      if (control.raceOn === request.id && request.missionId) {
        control.raceOn = null;
        await transitionMission({ missionId: request.missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' });
        return { ok: false, reason: 'the provider timed out', missionId: request.missionId, settled: false };
      }
      return real.resumeAnsweredRequest(request);
    },
  };
});

import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, getOrchestration } from '../server/repos/research.ts';
import { createUser } from '../server/repos/identity.ts';
import { answerHumanRequest, askHuman, getHumanRequest, getMission, listOpenRequests, transitionMission } from '../server/repos/russellMissions.ts';
import { NEEDS_HUMAN_CHOICES } from '../server/services/russell/needsHuman.ts';
import { tick } from '../server/services/russell/loop.ts';

const LEFT = 'the mission moved out of Needs You before the answer could be applied';

let fixture: TestProject;
let userId: string;

beforeEach(async () => {
  fixture = await freshProject();
  control.calls.length = 0;
  control.raceOn = null;
  userId = (
    await createUser({
      email: `filter-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
});

/** A mission parked at NEEDS_HUMAN on a packet whose one fragment is PLANNED, or ACCEPTED. */
async function parkedMission(fragmentStatus: 'PLANNED' | 'ACCEPTED' = 'PLANNED'): Promise<{ missionId: string; orchestrationId: string }> {
  const layer = await fixture.layerByName('World Model');
  const run = await createRun({ projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({
    projectId: fixture.project.id, layerId: layer.id, runId: run.id, title: 'A parked packet',
    assignment: 'what the packet asks', provider: 'WORKER', autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: fixture.project.id, layerId: layer.id, geography: 'United States',
      requiredEvidence: [{ id: 'published_price', description: 'a price', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the platform itself'], excludedSourceTypes: ['a blog about it'], completionCriteria: ['one dated price'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'prices', question: 'What does each platform publish?',
      dependsOn: [], attempt: 1, status: fragmentStatus,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  await getDb().run(`UPDATE research_orchestrations SET status = 'AWAITING_APPROVAL' WHERE id = ?`, [orchestration.id]);
  const missionId = newId('rms');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_missions (id, project_id, layer_id, visibility, objective, why_now, state, waiting_on,
       orchestration_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'SHARED', ?, ?, 'NEEDS_HUMAN', ?, ?, ?, ?, ?)`,
    [missionId, fixture.project.id, layer.id, 'Settle the question.', 'It is open.', 'a person to decide', orchestration.id, `filter-${missionId}`, at, at],
  );
  return { missionId, orchestrationId: orchestration.id };
}

async function answered(missionId: string | null, choice: string, key = newId('k')) {
  const { request } = await askHuman({
    projectId: fixture.project.id,
    visibility: 'SHARED',
    missionId,
    authorityNeeded: 'Decide the packet.',
    whyNotRussell: 'Only a person can authorize research.',
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: `filter-test:${key}`,
  });
  const result = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice });
  expect(result.ok, result.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

const openIds = async () => (await listOpenRequests(fixture.project.id)).map((r) => r.id);

describe('the recorded failure class: a card the pass reopened goes moot later in the same pass', () => {
  it('is withdrawn and reported as a moot answer by the pass itself, not left OPEN for the operator', async () => {
    const { missionId } = await parkedMission();
    // Answered first, and fails for a reason a person could still act on: reopened OPEN while the mission waits.
    const first = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await getDb().run(`UPDATE russell_human_requests SET answered_choice = ?, answered_at = ? WHERE id = ?`, ['NOT_A_CHOICE', '2026-01-01T00:00:00.000Z', first.id]);
    // Answered second, and carried out: the mission leaves NEEDS_HUMAN, so the first card is now moot.
    const second = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await getDb().run(`UPDATE russell_human_requests SET answered_at = ? WHERE id = ?`, ['2026-01-02T00:00:00.000Z', second.id]);

    const report = await tick('filter-same-pass');

    expect((await getMission(missionId))!.state).not.toBe('NEEDS_HUMAN');
    expect(report.resumed).toContain(second.id);
    const after = (await getHumanRequest(first.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(await openIds()).not.toContain(first.id);
    // The pass itself withdrew it as a moot answer. At the base commit it left this card OPEN, and it never appeared here.
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).toContain(first.id);
  });
});

describe('an answer whose mission already left NEEDS_HUMAN', () => {
  it('is withdrawn with the reason, reported as moot, and never resumed', async () => {
    const { missionId } = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'cancelled elsewhere' })).toBe(true);

    const report = await tick('filter-cancelled');

    expect(control.calls).not.toContain(request.id);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toMatch(/CANCELLED/);
    expect(report.withdrawnMootAnswers).toContainEqual({ requestId: request.id, missionState: 'CANCELLED', reason: LEFT });
    expect(await openIds()).not.toContain(request.id);
  });

  it('a RECORD_GAPS answer authorizes nothing in the person\'s name (the base commit set the gap policy first)', async () => {
    const { missionId, orchestrationId } = await parkedMission('ACCEPTED');
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.RECORD_GAPS.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    const before = (await getOrchestration(orchestrationId))!.unresolvedGapPolicy;

    const report = await tick('filter-record-gaps');

    expect(control.calls).not.toContain(request.id);
    expect((await getOrchestration(orchestrationId))!.unresolvedGapPolicy).toBe(before);
    expect((await getHumanRequest(request.id))!.state).toBe('WITHDRAWN');
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).toContain(request.id);
  });

  it('a STOP answer still settles as a stop', async () => {
    const { missionId } = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.STOP.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);

    const report = await tick('filter-stop');

    expect(control.calls).toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('CANCELLED');
    expect(report.resumed).toContain(request.id);
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).not.toContain(request.id);
  });
});

describe('as before', () => {
  it('a mission still at NEEDS_HUMAN whose resume fails is reopened OPEN with its choices', async () => {
    const { missionId } = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await getDb().run(`UPDATE russell_human_requests SET answered_choice = ? WHERE id = ?`, ['NOT_A_CHOICE', request.id]);

    const report = await tick('filter-live');

    expect(control.calls).toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('OPEN');
    expect(after.recommendation).toMatch(/does not implement the answer "NOT_A_CHOICE"/);
    expect(after.choices.map((choice) => choice.key)).toContain(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).not.toContain(request.id);
    expect(await openIds()).toContain(request.id);
  });

  it('a request with no mission is resumed exactly as before', async () => {
    const request = await answered(null, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    const report = await tick('filter-missionless');
    expect(control.calls).toContain(request.id);
    expect(report.resumed).toContain(request.id);
    expect((await getHumanRequest(request.id))!.state).not.toBe('WITHDRAWN');
  });
});

describe('a mission that leaves NEEDS_HUMAN during a failed resume', () => {
  it('is withdrawn, not reopened', async () => {
    const { missionId } = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    control.raceOn = request.id;

    const report = await tick('filter-race');

    expect(control.calls).toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('RUNNING');
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(report.withdrawnMootAnswers).toContainEqual({ requestId: request.id, missionState: 'RUNNING', reason: LEFT });
    expect(await openIds()).not.toContain(request.id);
  });
});
