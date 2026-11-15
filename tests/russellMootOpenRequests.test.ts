/**
 * OPERATOR:RECURRING_OPERATIONAL_FAILURE:6efa69506072328a, attempt 2.
 *
 * Open person-requests whose mission had already left NEEDS_HUMAN kept arriving
 * with any recommendation on them, and the operator withdrew them by hand
 * (OPERATOR_WITHDREW_MOOT_REQUEST). Attempt 1 only reached cards re-asked on
 * one exact sentence. The loop now withdraws every card the shared moot rule
 * (`domain/operator.ts` `moot`) decides, and a failed answer whose mission has
 * left NEEDS_HUMAN is withdrawn whatever the failure's wording.
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
  reopenRequest,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import {
  NEEDS_HUMAN_CHOICES,
  reopenAnswered,
  resumeAnsweredRequest,
  unparkResolvedMissions,
  withdrawMootOpenRequests,
} from '../server/services/russell/needsHuman.ts';
import { moot } from '../server/domain/operator.ts';

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


const decisions = async (requestId: string) =>
  (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', requestId)).filter((event) => event.eventType === 'RUSSELL_ROUTINE_DECISION');

/** An OPEN card on a parked mission, never answered, with its own recommendation. */
async function openCard(missionId: string | null, resumeKey?: string) {
  const { request } = await askHuman({
    projectId: fixture.project.id,
    visibility: 'SHARED',
    missionId,
    authorityNeeded: 'Authorize the plan.',
    whyNotRussell: 'Only a person can authorize research.',
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: resumeKey ?? `moot-open:${missionId ?? newId('none')}`,
  });
  return (await getHumanRequest(request.id))!;
}

describe('an OPEN card whose mission left Needs You by another door', () => {
  it('reproduces the failure class: withdrawn by the rule on the loop pass, whatever its recommendation', async () => {
    const missionId = await parkedMission();
    const card = await openCard(missionId);
    expect(card.state).toBe('OPEN');
    // The mission moves on without anybody answering (advanced, stopped, recovered…).
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    const reading = moot({ resumeKey: card.resumeKey, missionId, missionState: 'RUNNING', packetStatus: null });
    expect(reading.moot).toBe(true);

    await unparkResolvedMissions(50);

    const after = (await getHumanRequest(card.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toMatch(/RUNNING/);
    expect(after.whyNotRussell).toContain(reading.why);
    expect((await listOpenRequests(fixture.project.id)).map((r) => r.id)).not.toContain(card.id);
    const events = await decisions(card.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ choice: 'WITHDRAW_MOOT_ANSWER', requestId: card.id, missionId, missionState: 'RUNNING', reason: reading.why });

    // Idempotent: a second pass moves and records nothing.
    expect(await withdrawMootOpenRequests(50)).toEqual([]);
    expect(await decisions(card.id)).toHaveLength(1);
  });

  it('keeps a card whose mission still waits, a card with no mission and a capability or reconsider card', async () => {
    const waiting = await openCard(await parkedMission());
    const missionless = await openCard(null);
    const gone = await parkedMission();
    const capability = await openCard(gone, `capability-authority:${newId('gap')}`);
    expect(await transitionMission({ missionId: gone, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'x' })).toBe(true);

    expect(await withdrawMootOpenRequests(50)).toEqual([]);
    for (const one of [waiting, missionless, capability]) expect((await getHumanRequest(one.id))!.state).toBe('OPEN');
  });

  it('a person who answers first wins: an ANSWERED card is never withdrawn by the sweep', async () => {
    const missionId = await parkedMission();
    const card = await openCard(missionId);
    expect((await answerHumanRequest({ requestId: card.id, actorUserId: userId, choice: NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key })).ok).toBe(true);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    expect(await withdrawMootOpenRequests(50)).toEqual([]);
    expect((await getHumanRequest(card.id))!.state).toBe('ANSWERED');
    expect(await decisions(card.id)).toHaveLength(0);
  });
});

describe('a failed answer whose mission left Needs You, whatever the failure said', () => {
  it('is withdrawn with the reason, not reopened', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    const reason = 'this mission has no packet to authorize';
    expect(await reopenAnswered(request, reason)).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toContain(reason);
    const events = await decisions(request.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ choice: 'WITHDRAW_MOOT_ANSWER', missionState: 'RUNNING', reason });
  });

  it('a mission still in NEEDS_HUMAN is re-asked as before', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    const stale = { ...request, answeredByUserId: 'usr_nobody' };
    const outcome = await resumeAnsweredRequest(stale);
    expect(outcome.settled).toBe(false);
    expect(await reopenAnswered(stale, outcome.reason)).toBe(true);
    expect((await getHumanRequest(request.id))!.state).toBe('OPEN');
    expect(await decisions(request.id)).toHaveLength(0);
  });
});
