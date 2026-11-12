/**
 * An answer whose mission already left Needs You is withdrawn, not re-asked.
 *
 * Production, 2026-11-12: goal wst_7b4fcbb5f2384f31b6c3 read "PERSON: 39 open
 * request(s)", and 31 of them were moot. The loop's `answered-requests` pass
 * handed every unsettled resume to `reopenAnswered`, including "the mission
 * moved out of Needs You before the answer could be applied" — e.g.
 * rhr_2036cc5ee76b4b939e9e, whose mission rms_da903e70d2f3416d9b16 was
 * CANCELLED. That failure can never succeed, because every answer is applied
 * through a transition guarded on `NEEDS_HUMAN`, so the card went back in
 * front of the person for a decision nobody can carry out.
 *
 * Pinned here: the moot card is WITHDRAWN with the mission's state named and
 * a RUSSELL_ROUTINE_DECISION event recorded, once; a live mission's card and a missionless card are
 * still reopened exactly as before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
import {
  NEEDS_HUMAN_CHOICES,
  reopenAnswered,
  resumeAnsweredRequest,
} from '../server/services/russell/needsHuman.ts';

const MOVED_OUT = 'the mission moved out of Needs You before the answer could be applied';

let fixture: TestProject;
let userId: string;

beforeEach(async () => {
  fixture = await freshProject();
  userId = (
    await createUser({
      email: `moot-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
      orchestration.id, `moot-${missionId}`, at, at],
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
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: `moot-test:${missionId ?? newId('none')}`,
  });
  const answered = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice });
  expect(answered.ok, answered.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

describe('reopenAnswered and a mission that left Needs You', () => {
  it('A01: withdraws an answer whose mission was cancelled before it could be applied', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    // The recorded failure: the mission is cancelled underneath the answer.
    expect(
      await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'cancelled elsewhere' }),
    ).toBe(true);

    const outcome = await resumeAnsweredRequest(request);
    expect(outcome.settled).toBe(false);
    expect(outcome.reason).toBe(MOVED_OUT);

    expect(await reopenAnswered(request, outcome.reason)).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toMatch(/CANCELLED/);
    expect((await listOpenRequests(fixture.project.id)).map((r) => r.id)).not.toContain(request.id);
    // The decision was not carried out, and nothing pretends it was.
    expect((await getMission(missionId))!.state).toBe('CANCELLED');

    const events = (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', request.id)).filter(
      (event) => event.eventType === 'RUSSELL_ROUTINE_DECISION',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      choice: 'WITHDRAW_MOOT_ANSWER',
      requestId: request.id,
      missionId,
      missionState: 'CANCELLED',
      reason: MOVED_OUT,
      surface: 'RUSSELL',
    });

    // A second pass over the same (stale) answer changes nothing and records nothing.
    expect(await reopenAnswered(request, outcome.reason)).toBe(false);
    expect((await getHumanRequest(request.id))!.state).toBe('WITHDRAWN');
    expect(
      (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', request.id)).filter(
        (event) => event.eventType === 'RUSSELL_ROUTINE_DECISION',
      ),
    ).toHaveLength(1);
  });

  it('A03: reopens a live mission\'s answer that failed for another reason, with re-derived choices', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    // The answerer cannot be resolved: a failure a person can still act on.
    const stale = { ...request, answeredByUserId: 'usr_nobody' };
    const outcome = await resumeAnsweredRequest(stale);
    expect(outcome.settled).toBe(false);
    expect(outcome.reason).toMatch(/cannot be resolved/);
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');

    expect(await reopenAnswered(stale, outcome.reason)).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('OPEN');
    expect(after.recommendation).toBe(outcome.reason);
    // Derived from the packet's shape: one PLANNED fragment offers approval.
    expect(after.choices.map((choice) => choice.key)).toContain(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect((await listOpenRequests(fixture.project.id)).map((r) => r.id)).toContain(request.id);
    expect(
      (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', request.id)).filter(
        (event) => event.eventType === 'RUSSELL_ROUTINE_DECISION',
      ),
    ).toHaveLength(0);
  });

  it('A03: reopens a missionless answer with its own choices', async () => {
    const request = await answeredRequest(null, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(await reopenAnswered(request, 'could not be applied')).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('OPEN');
    expect(after.choices.map((choice) => choice.key)).toEqual(request.choices.map((choice) => choice.key));
    expect(after.whyNotRussell).toBe(request.whyNotRussell);
  });
});
