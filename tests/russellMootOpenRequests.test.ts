/**
 * Every card the operator's `moot` rule calls moot is withdrawn by Brain
 * itself, decided by the mission's state rather than by a sentence.
 *
 * Recorded failure class OPERATOR:RECURRING_OPERATIONAL_FAILURE:6efa69506072328a:
 * goal wst_7b4fcbb5f2384f31b6c3 read "PERSON: 39 open request(s)" with 31
 * moot, and the operator kept withdrawing them by hand (30
 * OPERATOR_WITHDREW_MOOT_REQUEST events from 2026-11-06). Attempt 1 withdrew
 * only an answer whose resume failed with "the mission moved out of Needs
 * You…", and swept only OPEN cards carrying that sentence; cards whose mission
 * left NEEDS_HUMAN by another route, or whose answer failed in other words,
 * stayed in front of a person.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createUser } from '../server/repos/identity.ts';
import { listEvents, listEventsByEntity } from '../server/repos/events.ts';
import { answerHumanRequest, askHuman, getHumanRequest, getMission, listOpenRequests, transitionMission } from '../server/repos/russellMissions.ts';
import { NEEDS_HUMAN_CHOICES, reopenAnswered, resumeAnsweredRequest, unparkResolvedMissions } from '../server/services/russell/needsHuman.ts';
import { moot } from '../server/domain/operator.ts';

let fixture: TestProject;
let userId: string;

beforeEach(async () => {
  fixture = await freshProject();
  userId = (
    await createUser({ email: `moot-open-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Test person', password: 'correct horse battery staple' })
  ).id;
});

async function parkedMission(): Promise<string> {
  const layer = await fixture.layerByName('World Model');
  const run = await createRun({ projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({
    projectId: fixture.project.id, layerId: layer.id, runId: run.id, title: 'A parked packet', assignment: 'what the packet asks', provider: 'WORKER', autoApprove: false,
  });
  const missionId = newId('rms');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO russell_missions (id, project_id, layer_id, visibility, objective, why_now, state, waiting_on,
       orchestration_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'SHARED', ?, ?, 'NEEDS_HUMAN', ?, ?, ?, ?, ?)`,
    [missionId, fixture.project.id, layer.id, 'Settle the question.', 'It is open.', 'a person to authorize the plan', orchestration.id, `moot-open-${missionId}`, at, at],
  );
  return missionId;
}

async function card(missionId: string | null, opts: { resumeKey?: string; recommendation?: string | null } = {}) {
  const { request } = await askHuman({
    projectId: fixture.project.id, visibility: 'SHARED', missionId,
    authorityNeeded: 'Authorize the plan.', whyNotRussell: 'Only a person can authorize research.',
    recommendation: opts.recommendation ?? null,
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.STOP], resumeKey: opts.resumeKey ?? `moot-open:${missionId ?? newId('none')}`,
  });
  return request;
}

async function answered(missionId: string | null, resumeKey?: string) {
  const request = await card(missionId, { resumeKey });
  const out = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice: NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key });
  expect(out.ok, out.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

const reading = async (requestId: string) => {
  const r = (await getHumanRequest(requestId))!;
  const mission = r.missionId ? await getMission(r.missionId) : null;
  return moot({ resumeKey: r.resumeKey, missionId: r.missionId, missionState: mission?.state ?? null, packetStatus: null });
};
const operatorMootCount = async () => {
  let n = 0;
  for (const r of await listOpenRequests(fixture.project.id)) if ((await reading(r.id)).moot) n += 1;
  return n;
};
const decisions = async (id: string) => (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', id)).filter((e) => e.eventType === 'RUSSELL_ROUTINE_DECISION');
const operatorWithdrawals = async () => (await listEvents(fixture.project.id)).filter((e) => e.eventType === 'OPERATOR_WITHDREW_MOOT_REQUEST');

describe('an OPEN card whose mission moved on, with any recommendation', () => {
  it('is withdrawn on the loop\'s unpark pass, decided by the operator\'s moot reading', async () => {
    const missionId = await parkedMission();
    const open = await card(missionId, { recommendation: 'Russell suggests approving the narrower plan.' });
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    expect((await reading(open.id)).moot).toBe(true);
    expect(await operatorMootCount()).toBe(1);

    await unparkResolvedMissions(50);

    const after = (await getHumanRequest(open.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toContain('RUNNING');
    expect(after.whyNotRussell).toContain('Russell suggests approving the narrower plan.');
    const events = await decisions(open.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ choice: 'WITHDRAW_MOOT_ANSWER', missionId, missionState: 'RUNNING' });
    expect(await operatorMootCount()).toBe(0);
    expect(await operatorWithdrawals()).toHaveLength(0);

    // A second cycle changes nothing.
    await unparkResolvedMissions(50);
    expect(await decisions(open.id)).toHaveLength(1);
  });
});

describe('an answer whose mission already left NEEDS_HUMAN', () => {
  it('is withdrawn with the reason when the resume failed in other words, not reopened', async () => {
    for (const to of ['RUNNING', 'CANCELLED'] as const) {
      const missionId = await parkedMission();
      const request = await answered(missionId);
      expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to, terminalReason: to === 'CANCELLED' ? 'cancelled elsewhere' : undefined })).toBe(true);
      const reason = 'the person who answered cannot be resolved, so nothing is authorized in their name';
      expect(await reopenAnswered(request, reason)).toBe(true);
      const after = (await getHumanRequest(request.id))!;
      expect(after.state).toBe('WITHDRAWN');
      expect(after.whyNotRussell).toContain(to);
      expect(after.whyNotRussell).toContain(reason);
      expect((await decisions(request.id))[0]!.payload).toMatchObject({ missionState: to, reason });
    }
    expect(await operatorMootCount()).toBe(0);
    expect(await operatorWithdrawals()).toHaveLength(0);
  });
});

describe('what is still asked', () => {
  it('reopens an answer whose mission still waits in NEEDS_HUMAN', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId);
    expect(await reopenAnswered(request, 'the person who answered cannot be resolved')).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('OPEN');
    expect(after.choices.length).toBeGreaterThan(0);
    expect(await decisions(request.id)).toHaveLength(0);
  });

  it('never withdraws a capability-authority:, cash-reconsider: or missionless card', async () => {
    for (const prefix of ['capability-authority:', 'cash-reconsider:']) {
      const missionId = await parkedMission();
      const open = await card(missionId, { resumeKey: `${prefix}${newId('k')}`, recommendation: 'anything' });
      expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'gone' })).toBe(true);
      await unparkResolvedMissions(50);
      expect((await getHumanRequest(open.id))!.state).toBe('OPEN');
      expect(await decisions(open.id)).toHaveLength(0);
    }
    const missionless = await answered(null);
    expect(await reopenAnswered(missionless, 'could not be applied')).toBe(true);
    expect((await getHumanRequest(missionless.id))!.state).toBe('OPEN');
  });

  it('leaves an answer a person gave first untouched: the sweep only moves OPEN cards', async () => {
    const missionId = await parkedMission();
    const request = await card(missionId);
    // The person answers before the mission moves and before the sweep runs.
    expect((await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice: NEEDS_HUMAN_CHOICES.STOP.key })).ok).toBe(true);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    await unparkResolvedMissions(50);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('ANSWERED');
    expect(after.answeredChoice).toBe(NEEDS_HUMAN_CHOICES.STOP.key);
    expect(await decisions(request.id)).toHaveLength(0);
  });
});

/**
 * Why a card on a mission that left NEEDS_HUMAN is moot, pinned as behaviour
 * rather than left to a comment. A reviewer found the stated reason, "every
 * answer begins with a transition guarded on NEEDS_HUMAN", untrue: STOP is
 * applied from whatever state the mission is in. The true reason has two halves,
 * and each is asserted here.
 */
describe('the reason a departed mission\'s card is moot', () => {
  it('a non-STOP answer is guarded on NEEDS_HUMAN, so on a FAILED mission it cannot apply and is withdrawn', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'FAILED', terminalReason: 'nothing to research' })).toBe(true);
    const outcome = await resumeAnsweredRequest(request);
    expect(outcome.settled).toBe(false);
    expect((await getMission(missionId))!.state).toBe('FAILED');
    expect(await reopenAnswered(request, outcome.reason)).toBe(true);
    expect((await getHumanRequest(request.id))!.state).toBe('WITHDRAWN');
    expect(await decisions(request.id)).toHaveLength(1);
  });

  it('STOP is not guarded on NEEDS_HUMAN: it applies from any state and settles, so it never reaches the moot rule', async () => {
    for (const from of ['RUNNING', 'FAILED'] as const) {
      const missionId = await parkedMission();
      const request = await card(missionId);
      const out = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice: NEEDS_HUMAN_CHOICES.STOP.key });
      expect(out.ok, out.reason).toBe(true);
      expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: from, terminalReason: 'moved on' })).toBe(true);
      const outcome = await resumeAnsweredRequest((await getHumanRequest(request.id))!);
      expect(outcome).toMatchObject({ ok: true, settled: true });
      expect((await getMission(missionId))!.state).toBe('CANCELLED');
      expect(await decisions(request.id)).toHaveLength(0);
    }
  });
});
