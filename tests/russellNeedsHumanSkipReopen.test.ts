/**
 * OPERATOR:RECURRING_OPERATIONAL_FAILURE:8298f8d1444104b1 — the "skip-reopen" variant.
 *
 * A person's answer to a card whose mission has already left NEEDS_HUMAN can never be applied: every
 * answer but STOP goes through a transition guarded on NEEDS_HUMAN. `resumeAnsweredRequest` now says so
 * before its one pre-guard effect — so a RECORD_GAPS answer no longer authorizes the packet's gaps in the
 * answerer's name first — and the card is withdrawn (never re-asked) through `reopenAnswered`'s guarded
 * withdrawal. STOP, live missions, missionless and authority cards are unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, getOrchestration } from '../server/repos/research.ts';
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
import { NEEDS_HUMAN_CHOICES, reopenAnswered, resumeAnsweredRequest } from '../server/services/russell/needsHuman.ts';
import { tick } from '../server/services/russell/loop.ts';

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

async function answered(missionId: string | null, choice: string, resumeKey?: string) {
  const { request } = await askHuman({
    projectId: fixture.project.id,
    visibility: 'SHARED',
    missionId,
    authorityNeeded: 'Authorize the plan.',
    whyNotRussell: 'Only a person can authorize research.',
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: resumeKey ?? `skip-reopen:${missionId ?? newId('none')}`,
  });
  const result = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice });
  expect(result.ok, result.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

async function moveMission(missionId: string, to: 'CANCELLED' | 'RUNNING') {
  expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to, terminalReason: 'moved elsewhere' })).toBe(true);
}

describe('an answer whose mission already left Needs You is withdrawn, never re-asked', () => {
  it('A01: several moot answers end WITHDRAWN after one tick, none OPEN or ANSWERED, and none authorizes anything', async () => {
    /*
     * The recorded failure class, end to end through the loop that produced it. Withdrawal alone already
     * held before this variant; what did not hold is that a moot RECORD_GAPS answer on a packet with an
     * accepted fragment authorized the packet's gaps in the answerer's name *before* the guarded
     * transition refused it — an effect recorded for a decision nobody was waiting on. So every
     * RECORD_GAPS card here sits on a packet whose report could be filed, and the tick must leave each
     * packet unauthorized as well as each card withdrawn.
     */
    const cards: { id: string; state: string; orchestrationId: string | null }[] = [];
    for (const [choice, to] of [
      [NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key, 'CANCELLED'],
      [NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key, 'RUNNING'],
      [NEEDS_HUMAN_CHOICES.RECORD_GAPS.key, 'CANCELLED'],
      [NEEDS_HUMAN_CHOICES.RECORD_GAPS.key, 'RUNNING'],
    ] as const) {
      const missionId = await parkedMission();
      const request = await answered(missionId, choice);
      let orchestrationId: string | null = null;
      if (choice === NEEDS_HUMAN_CHOICES.RECORD_GAPS.key) {
        orchestrationId = (await getMission(missionId))!.orchestrationId!;
        await getDb().run(`UPDATE research_fragments SET status = 'ACCEPTED' WHERE orchestration_id = ?`, [orchestrationId]);
      }
      await moveMission(missionId, to);
      cards.push({ id: request.id, state: to, orchestrationId });
    }

    const report = await tick('skip-reopen');
    for (const card of cards) {
      const after = (await getHumanRequest(card.id))!;
      expect(after.state, card.id).toBe('WITHDRAWN');
      expect(after.whyNotRussell).toMatch(new RegExp(card.state));
      expect(report.withdrawnMootAnswers.map((w) => w.requestId)).toContain(card.id);
      if (card.orchestrationId) {
        const packet = (await getOrchestration(card.orchestrationId))!;
        expect(packet.unresolvedGapPolicy, card.id).not.toBe('RECORD_GAPS');
        expect(packet.unresolvedGapAuthorizedBy ?? null, card.id).toBeNull();
      }
    }
    const open = (await listOpenRequests(fixture.project.id)).map((r) => r.id);
    expect(cards.some((c) => open.includes(c.id))).toBe(false);
  });

  it('A01: a moot RECORD_GAPS answer authorizes nothing in the answerer\'s name', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.RECORD_GAPS.key);
    const orchestrationId = (await getMission(missionId))!.orchestrationId!;
    // A packet whose report could be filed: something cleared its gate, so recordGaps reaches its effect.
    await getDb().run(`UPDATE research_fragments SET status = 'ACCEPTED' WHERE orchestration_id = ?`, [orchestrationId]);
    await moveMission(missionId, 'CANCELLED');

    const outcome = await resumeAnsweredRequest(request);
    expect(outcome.reason).toBe(MOVED_OUT);
    const packet = (await getOrchestration(orchestrationId))!;
    expect(packet.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    expect(packet.unresolvedGapAuthorizedBy ?? null).toBeNull();
    // ...and the card is withdrawn, not re-asked.
    expect(await reopenAnswered(request, outcome.reason)).toBe(true);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toMatch(/CANCELLED/);
  });

  it('A03: a STOP answer on a moved mission is carried out, not withdrawn', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.STOP.key);
    await moveMission(missionId, 'RUNNING');
    await tick('skip-reopen-stop');
    expect((await getHumanRequest(request.id))!.state).toBe('RESUMED');
  });

  it('A03: an answer whose mission still waits is reopened as before', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    const stale = { ...request, answeredByUserId: 'usr_nobody' };
    const outcome = await resumeAnsweredRequest(stale);
    expect(outcome.settled).toBe(false);
    expect(outcome.reason).not.toBe(MOVED_OUT);
    expect(await reopenAnswered(stale, outcome.reason)).toBe(true);
    expect((await getHumanRequest(request.id))!.state).toBe('OPEN');
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');
  });

  it('A03: a missionless card and an authority card on a moved mission are never classed moot', async () => {
    const missionless = await answered(null, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect((await resumeAnsweredRequest(missionless)).reason).not.toBe(MOVED_OUT);

    const missionId = await parkedMission();
    const authority = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key, `capability-authority:${newId('gap')}`);
    await moveMission(missionId, 'RUNNING');
    // Not classed moot: the authority card's answer is tried as before (and fails at the plan's own guard),
    // and the card is put back in front of the person rather than withdrawn.
    await tick('skip-reopen-authority');
    expect((await getHumanRequest(authority.id))!.state).not.toBe('WITHDRAWN');
    expect((await getHumanRequest(missionless.id))!.state).not.toBe('WITHDRAWN');
  });
});

describe('skip-reopen: a moot answer is withdrawn straight from ANSWERED, never by way of OPEN', () => {
  it('the withdrawn card keeps who answered and what they chose, and was never put back OPEN', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await moveMission(missionId, 'CANCELLED');

    const report = await tick('skip-reopen-history');
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    // The reopen route cleared these on its way through OPEN; the row is the history.
    expect(after.answeredChoice).toBe(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(after.answeredByUserId).toBe(userId);
    expect(after.answeredAt).toBe(request.answeredAt);
    expect(after.recommendation).toBe(MOVED_OUT);
    expect(after.whyNotRussell).toMatch(/CANCELLED/);
    expect(report.withdrawnMootAnswers.map((w) => w.requestId)).toContain(request.id);
    // Exactly one decision recorded, by Brain, carrying the answer that could not apply.
    const decisions = (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', request.id)).filter(
      (event) => event.eventType === 'RUSSELL_ROUTINE_DECISION',
    );
    expect(decisions).toHaveLength(1);
  });

  it('a moot answer whose mission came back to Needs You is not withdrawn', async () => {
    const missionId = await parkedMission();
    const request = await answered(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await moveMission(missionId, 'RUNNING');
    expect(await transitionMission({ missionId, from: 'RUNNING', to: 'NEEDS_HUMAN', waitingOn: 'a person' })).toBe(true);
    const outcome = await resumeAnsweredRequest(request);
    expect(outcome.reason).not.toBe(MOVED_OUT);
    expect((await getHumanRequest(request.id))!.state).not.toBe('WITHDRAWN');
  });
});
