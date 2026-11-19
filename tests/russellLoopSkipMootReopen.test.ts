/**
 * The loop settles a moot answer before any resume, and never reopens it.
 *
 * OPERATOR:RECURRING_OPERATIONAL_FAILURE:8298f8d1444104b1 — goal
 * wst_7b4fcbb5f2384f31b6c3: 43 OPERATOR_WITHDREW_MOOT_REQUEST events in a week.
 * The loop's `answered-requests` pass handed every answered card to
 * `resumeAnsweredRequest` and every failed resume to `reopenAnswered`,
 * including "the mission moved out of Needs You before the answer could be
 * applied" — a failure that can never succeed. The pass now reads the
 * operator's `moot` predicate first: a moot answer (anything but STOP) is
 * settled as moot through `reopenAnswered`'s guarded withdrawal without a
 * resume being attempted at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/services/russell/needsHuman.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/russell/needsHuman.ts')>();
  return { ...actual, resumeAnsweredRequest: vi.fn(actual.resumeAnsweredRequest) };
});

import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { createUser } from '../server/repos/identity.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import {
  answerHumanRequest,
  askHuman,
  getHumanRequest,
  getMission,
  listOpenRequests,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { NEEDS_HUMAN_CHOICES, resumeAnsweredRequest } from '../server/services/russell/needsHuman.ts';
import { tick } from '../server/services/russell/loop.ts';

const MOVED_OUT = 'the mission moved out of Needs You before the answer could be applied';
const resumeSpy = vi.mocked(resumeAnsweredRequest);

let fixture: TestProject;
let userId: string;

beforeEach(async () => {
  resumeSpy.mockClear();
  fixture = await freshProject();
  userId = (
    await createUser({
      email: `skip-moot-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
});

/** A mission parked at NEEDS_HUMAN on a packet with one plan awaiting approval. */
async function parkedMission(): Promise<string> {
  const layer = await fixture.layerByName('World Model');
  const run = await createRun({
    projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p',
  });
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
      dependsOn: [], attempt: 1, status: 'PLANNED',
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const missionId = newId('rms');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_missions (id, project_id, layer_id, visibility, objective, why_now, state, waiting_on,
       orchestration_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'SHARED', ?, ?, 'NEEDS_HUMAN', ?, ?, ?, ?, ?)`,
    [missionId, fixture.project.id, layer.id, 'Settle the question.', 'It is open.', 'a person to authorize the plan',
      orchestration.id, `skip-moot-${missionId}`, at, at],
  );
  return missionId;
}

async function answeredRequest(missionId: string | null, choice: string) {
  const { request } = await askHuman({
    projectId: fixture.project.id,
    visibility: 'SHARED',
    missionId,
    authorityNeeded: 'Authorize the plan.',
    whyNotRussell: 'Only a person can authorize research.',
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: `skip-moot-test:${missionId ?? newId('none')}`,
  });
  const answered = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice });
  expect(answered.ok, answered.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

const resumedIds = () => resumeSpy.mock.calls.map(([request]) => request.id);
const decisions = async (requestId: string) =>
  (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', requestId)).filter((event) => event.eventType === 'RUSSELL_ROUTINE_DECISION');
const operatorWithdrawals = async () =>
  (await getDb().all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM project_events WHERE event_type = 'OPERATOR_WITHDREW_MOOT_REQUEST'`,
  ))[0]!.n;

describe('answered-requests skips the resume and the reopen for a moot answer', () => {
  it('A01: several answered cards whose missions moved to RUNNING or CANCELLED leave nothing OPEN or ANSWERED after one tick', async () => {
    const cards: { requestId: string; missionId: string; to: 'RUNNING' | 'CANCELLED' }[] = [];
    for (const [to, choice] of [
      ['CANCELLED', NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key],
      ['CANCELLED', NEEDS_HUMAN_CHOICES.RECORD_GAPS.key],
      ['RUNNING', NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key],
      ['RUNNING', NEEDS_HUMAN_CHOICES.RECORD_GAPS.key],
    ] as const) {
      const missionId = await parkedMission();
      const request = await answeredRequest(missionId, choice);
      expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to, terminalReason: 'moved elsewhere' })).toBe(true);
      cards.push({ requestId: request.id, missionId, to });
    }
    const before = await operatorWithdrawals();

    const report = await tick('skip-moot');

    const open = (await listOpenRequests(fixture.project.id)).map((r) => r.id);
    for (const card of cards) {
      const after = (await getHumanRequest(card.requestId))!;
      expect(after.state).toBe('WITHDRAWN');
      expect(open).not.toContain(card.requestId);
      // Never handed to the resume: the decision could not apply, so nothing attempted it.
      expect(resumedIds()).not.toContain(card.requestId);
      expect(report.withdrawnMootAnswers.map((entry) => entry.requestId)).toContain(card.requestId);
      expect(await decisions(card.requestId)).toHaveLength(1);
    }
    // Cleared by the loop itself: the operator had nothing to withdraw by hand.
    expect(await operatorWithdrawals()).toBe(before);

    // A second cycle neither reopens them nor records anything more.
    await tick('skip-moot');
    for (const card of cards) {
      expect((await getHumanRequest(card.requestId))!.state).toBe('WITHDRAWN');
      expect(await decisions(card.requestId)).toHaveLength(1);
    }
  });

  it('A03: a moved mission\'s answer is WITHDRAWN with the mission state named, never re-OPENed', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'cancelled elsewhere' })).toBe(true);

    const report = await tick('skip-moot-one');
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toMatch(/CANCELLED/);
    expect(report.withdrawnMootAnswers).toContainEqual({ requestId: request.id, missionState: 'CANCELLED', reason: MOVED_OUT });
    expect(resumedIds()).not.toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('CANCELLED');
    const events = await decisions(request.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ choice: 'WITHDRAW_MOOT_ANSWER', missionState: 'CANCELLED', reason: MOVED_OUT });
  });

  it('A03: an answer whose mission still waits at NEEDS_HUMAN and cannot be carried out is reopened as before', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await getDb().run(`UPDATE russell_human_requests SET answered_choice = ? WHERE id = ?`, ['NOT_A_CHOICE', request.id]);
    await getDb().run(
      `UPDATE research_orchestrations SET status = 'AWAITING_APPROVAL'
        WHERE id = (SELECT orchestration_id FROM russell_missions WHERE id = ?)`,
      [missionId],
    );

    const report = await tick('skip-moot-live');
    expect(resumedIds()).toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('OPEN');
    expect(after.recommendation).toMatch(/does not implement the answer "NOT_A_CHOICE"/);
    expect(report.withdrawnMootAnswers.map((entry) => entry.requestId)).not.toContain(request.id);
    expect(await decisions(request.id)).toHaveLength(0);
  });

  it('A03: a STOP answer on a mission that moved is resumed, not withdrawn', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.STOP.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);

    const report = await tick('skip-moot-stop');
    expect(resumedIds()).toContain(request.id);
    expect((await getHumanRequest(request.id))!.state).toBe('RESUMED');
    expect(report.resumed).toContain(request.id);
    expect(report.withdrawnMootAnswers.map((entry) => entry.requestId)).not.toContain(request.id);
    expect(await decisions(request.id)).toHaveLength(0);
  });

  it('A03: a missionless card is untouched by the moot check and settles as before', async () => {
    const request = await answeredRequest(null, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);

    const report = await tick('skip-moot-missionless');
    expect(resumedIds()).toContain(request.id);
    expect((await getHumanRequest(request.id))!.state).toBe('RESUMED');
    expect(report.withdrawnMootAnswers.map((entry) => entry.requestId)).not.toContain(request.id);
    expect(await decisions(request.id)).toHaveLength(0);
  });
});
