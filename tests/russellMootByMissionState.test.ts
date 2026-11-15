/**
 * Moot is the mission's state, not the wording of the failure.
 *
 * Recorded failure class OPERATOR:RECURRING_OPERATIONAL_FAILURE:6efa69506072328a:
 * the operator measures a card as moot by `moot()` in `server/domain/operator.ts`
 * — any OPEN mission card whose mission is not NEEDS_HUMAN — while
 * `needsHuman.ts` only withdrew cards whose reason was the one sentence "the
 * mission moved out of Needs You…". Every other failure on a departed mission
 * was re-asked, and the operator withdrew those cards by hand (30
 * OPERATOR_WITHDREW_MOOT_REQUEST events in a week). Pinned here: after
 * `reopenAnswered` and `withdrawMootBacklog`, the operator's own predicate
 * reads zero moot open requests, and Brain — not the operator — withdrew them.
 */
import { readFileSync } from 'node:fs';
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
import { NEEDS_HUMAN_CHOICES, reopenAnswered, withdrawMootBacklog } from '../server/services/russell/needsHuman.ts';
import { moot } from '../server/domain/operator.ts';

let fixture: TestProject;
let userId: string;

beforeEach(async () => {
  fixture = await freshProject();
  userId = (
    await createUser({
      email: `moot-state-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
});

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
      orchestration.id, `moot-state-${missionId}`, at, at],
  );
  return missionId;
}

async function ask(missionId: string | null, resumeKey?: string) {
  const { request } = await askHuman({
    projectId: fixture.project.id,
    visibility: 'SHARED',
    missionId,
    authorityNeeded: 'Authorize the plan.',
    whyNotRussell: 'Only a person can authorize research.',
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: resumeKey ?? `moot-state:${missionId ?? newId('none')}`,
  });
  return request;
}

async function answered(missionId: string | null, resumeKey?: string) {
  const request = await ask(missionId, resumeKey);
  const result = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice: NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key });
  expect(result.ok, result.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

/** The operator's own reading: how many open requests in the project are moot. */
async function operatorMootCount(): Promise<number> {
  let count = 0;
  for (const request of await listOpenRequests(fixture.project.id)) {
    const mission = request.missionId ? await getMission(request.missionId) : null;
    if (moot({ resumeKey: request.resumeKey, missionId: request.missionId, missionState: mission?.state ?? null, packetStatus: null }).moot) {
      count += 1;
    }
  }
  return count;
}

const eventsOf = async (requestId: string, type: string) =>
  (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', requestId)).filter((event) => event.eventType === type);

describe('moot is decided by the mission state, as the operator decides it', () => {
  it('A01: leaves zero moot open requests after reopenAnswered and withdrawMootBacklog', async () => {
    // An answered card whose mission is RUNNING, and one whose mission is
    // CANCELLED, each resumed with a failure that is not the moved-out sentence.
    const running = await parkedMission();
    const answeredRunning = await answered(running);
    expect(await transitionMission({ missionId: running, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);
    const cancelled = await parkedMission();
    const answeredCancelled = await answered(cancelled);
    expect(await transitionMission({ missionId: cancelled, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'elsewhere' })).toBe(true);

    // An OPEN card, never answered, whose mission left NEEDS_HUMAN by another route.
    const leftOpen = await parkedMission();
    const openCard = await ask(leftOpen);
    expect(await transitionMission({ missionId: leftOpen, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'superseded' })).toBe(true);

    expect(await reopenAnswered(answeredRunning, 'the plan could not be approved')).toBe(true);
    expect(await reopenAnswered(answeredCancelled, 'the person who answered cannot be resolved')).toBe(true);
    await withdrawMootBacklog(50);

    expect(await operatorMootCount()).toBe(0);
    for (const id of [answeredRunning.id, answeredCancelled.id, openCard.id]) {
      expect((await getHumanRequest(id))!.state).toBe('WITHDRAWN');
      expect(await eventsOf(id, 'RUSSELL_ROUTINE_DECISION')).toHaveLength(1);
      expect(await eventsOf(id, 'OPERATOR_WITHDREW_MOOT_REQUEST')).toHaveLength(0);
    }
    // Nothing pretends the decision was carried out.
    expect((await getMission(running))!.state).toBe('RUNNING');

    // A second sweep changes nothing and records nothing.
    expect(await withdrawMootBacklog(50)).toEqual([]);
    expect(await eventsOf(openCard.id, 'RUSSELL_ROUTINE_DECISION')).toHaveLength(1);
  });

  it('A03: withdraws an answer on a departed mission with its state and reason; re-asks a live one', async () => {
    const departed = await parkedMission();
    const request = await answered(departed);
    expect(await transitionMission({ missionId: departed, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'elsewhere' })).toBe(true);
    const reason = 'the plan could not be approved';
    expect(await reopenAnswered(request, reason)).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toMatch(/CANCELLED/);
    expect(after.whyNotRussell).toContain(reason);
    const events = await eventsOf(request.id, 'RUSSELL_ROUTINE_DECISION');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ choice: 'WITHDRAW_MOOT_ANSWER', missionState: 'CANCELLED', reason });
    expect(await eventsOf(request.id, 'OPERATOR_WITHDREW_MOOT_REQUEST')).toHaveLength(0);

    const live = await parkedMission();
    const liveRequest = await answered(live);
    expect(await reopenAnswered(liveRequest, reason)).toBe(true);
    const reopened = (await getHumanRequest(liveRequest.id))!;
    expect(reopened.state).toBe('OPEN');
    expect(reopened.choices.map((choice) => choice.key)).toContain(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(await eventsOf(liveRequest.id, 'RUSSELL_ROUTINE_DECISION')).toHaveLength(0);
  });

  it('A03: capability-authority: and cash-reconsider: cards are reopened, never withdrawn', async () => {
    for (const prefix of ['capability-authority:', 'cash-reconsider:']) {
      const missionless = await answered(null, `${prefix}${newId('x')}`);
      expect(await reopenAnswered(missionless, 'could not be applied')).toBe(true);
      expect((await getHumanRequest(missionless.id))!.state).toBe('OPEN');
      expect(await eventsOf(missionless.id, 'RUSSELL_ROUTINE_DECISION')).toHaveLength(0);
    }
  });
});

/**
 * The helper that pins these withdrawals is documented where it is defined.
 *
 * Its JSDoc was once inserted between `parkedMission`'s doc comment and
 * `parkedMission` itself, so the nervous-system suite read two consecutive
 * doc blocks above `expectWithdrawnByBrain` and none above the function the
 * first one describes. This reads the source and holds each comment to its
 * own function.
 */
describe('the moot-withdrawal helper keeps its own doc comment', () => {
  const source = readFileSync(new URL('./russellNervousSystem.test.ts', import.meta.url), 'utf8');

  function docAbove(name: string): string {
    const at = source.indexOf(`async function ${name}(`);
    expect(at).toBeGreaterThan(0);
    const before = source.slice(0, at);
    expect(before.trimEnd().endsWith('*/')).toBe(true);
    return before.slice(before.lastIndexOf('/**'));
  }

  it('documents expectWithdrawnByBrain with its own comment, and only that one', () => {
    const doc = docAbove('expectWithdrawnByBrain');
    expect(doc).toContain('A card Brain withdrew');
    const preceding = source.slice(0, source.indexOf(doc)).trimEnd();
    expect(preceding.endsWith('*/')).toBe(false);
  });

  it('leaves parkedMission directly under the comment that describes it', () => {
    expect(docAbove('parkedMission')).toContain('A launched mission, ready to be parked by the loop.');
  });
});
