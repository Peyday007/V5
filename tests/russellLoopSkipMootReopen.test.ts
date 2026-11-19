/**
 * The loop recognises a moot answer before it tries to carry it out.
 *
 * OPERATOR:RECURRING_OPERATIONAL_FAILURE:8298f8d1444104b1, production
 * 2026-11-09..19: 43 OPERATOR_WITHDREW_MOOT_REQUEST events in a week. The
 * `answered-requests` pass in russell/loop.ts handed every answered card to
 * `resumeAnsweredRequest`, and every failure from it to the reopen path —
 * including cards whose mission had already left NEEDS_HUMAN, where no answer
 * but STOP can ever apply. Pinned here: such a card is settled as moot through
 * needsHuman.ts's guarded withdrawal without the resume being tried — so a
 * "record the gaps" answer no longer writes the person's authorization onto
 * the packet before the guard refuses it (the outcome the baseline gets
 * wrong) — a STOP
 * answer is still resumed, and a missionless card or one whose mission still
 * waits behaves as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { createUser } from '../server/repos/identity.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import { getOrchestration } from '../server/repos/research.ts';
import {
  answerHumanRequest,
  askHuman,
  getHumanRequest,
  getMission,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import * as needsHuman from '../server/services/russell/needsHuman.ts';
import { tick } from '../server/services/russell/loop.ts';

// Count the resumes the loop tries, while still running the real one.
const resumed: string[] = [];
// When set, the 'unpark-resolved' pass fails the way one bad packet re-ask makes it fail.
const unparkFails = { on: false };
vi.mock('../server/services/russell/needsHuman.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../server/services/russell/needsHuman.ts')>();
  return {
    ...real,
    resumeAnsweredRequest: async (request: Parameters<typeof real.resumeAnsweredRequest>[0]) => {
      resumed.push(request.id);
      return real.resumeAnsweredRequest(request);
    },
    reaskRefusedPlans: async (limit: number) => {
      if (unparkFails.on) throw new Error('a packet re-ask threw');
      return real.reaskRefusedPlans(limit);
    },
  };
});

const { NEEDS_HUMAN_CHOICES } = needsHuman;
const MOVED_OUT = 'the mission moved out of Needs You before the answer could be applied';

let fixture: TestProject;
let userId: string;

beforeEach(async () => {
  resumed.length = 0;
  unparkFails.on = false;
  fixture = await freshProject();
  userId = (
    await createUser({
      email: `skip-moot-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
});

/**
 * A mission parked at NEEDS_HUMAN on a packet with one fragment — PLANNED (a
 * plan awaiting approval) by default, or ACCEPTED (research that cleared its
 * gate, so recording the unresolved gaps would file a report).
 */
async function parkedMission(fragmentStatus: 'PLANNED' | 'ACCEPTED' = 'PLANNED'): Promise<string> {
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
      dependsOn: [], attempt: 1, status: fragmentStatus,
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

async function answeredRequest(missionId: string | null, choice: string, resumeKey?: string) {
  const { request } = await askHuman({
    projectId: fixture.project.id,
    visibility: 'SHARED',
    missionId,
    authorityNeeded: 'Authorize the plan.',
    whyNotRussell: 'Only a person can authorize research.',
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: resumeKey ?? `skip-moot-test:${missionId ?? newId('none')}`,
  });
  const answered = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice });
  expect(answered.ok, answered.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}

async function operatorWithdrawals(requestId: string) {
  return (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', requestId)).filter(
    (event) => event.eventType === 'OPERATOR_WITHDREW_MOOT_REQUEST',
  );
}

describe("the loop's answered-requests pass and a mission that left Needs You", () => {
  it('A01: several answered cards on missions moved to RUNNING or CANCELLED end WITHDRAWN in one tick, none left for the operator', async () => {
    const cards: { requestId: string; missionId: string; state: string }[] = [];
    for (const to of ['RUNNING', 'CANCELLED', 'RUNNING', 'CANCELLED'] as const) {
      const missionId = await parkedMission();
      const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
      expect(
        await transitionMission({ missionId, from: 'NEEDS_HUMAN', to, ...(to === 'CANCELLED' ? { terminalReason: 'cancelled elsewhere' } : {}) }),
      ).toBe(true);
      cards.push({ requestId: request.id, missionId, state: to });
    }

    const report = await tick('skip-moot-several');
    for (const card of cards) {
      const after = (await getHumanRequest(card.requestId))!;
      expect(after.state).toBe('WITHDRAWN');
      expect(after.whyNotRussell).toContain(card.state);
      expect(report.withdrawnMootAnswers).toContainEqual({ requestId: card.requestId, missionState: card.state, reason: MOVED_OUT });
      expect(await operatorWithdrawals(card.requestId)).toEqual([]);
      // Recognised as moot before anything was tried on the mission.
      expect(resumed).not.toContain(card.requestId);
    }
    const open = await getDb().all<{ id: string }>(
      `SELECT id FROM russell_human_requests WHERE project_id = ? AND state IN ('OPEN', 'ANSWERED')`,
      [fixture.project.id],
    );
    expect(open.map((r) => r.id).filter((id) => cards.some((c) => c.requestId === id))).toEqual([]);

    // A second tick finds nothing left to settle and records nothing more.
    const again = await tick('skip-moot-several');
    for (const card of cards) {
      expect((await getHumanRequest(card.requestId))!.state).toBe('WITHDRAWN');
      expect(again.withdrawnMootAnswers.map((e) => e.requestId)).not.toContain(card.requestId);
      expect(
        (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', card.requestId)).filter((e) => e.eventType === 'RUSSELL_ROUTINE_DECISION'),
      ).toHaveLength(1);
    }
  });

  /*
   * The recorded failure class at the level of what a person's answer did to
   * the packet. Trying a moot answer was not free: `recordGaps` records the
   * person's authorization of unresolved gaps on the packet before its
   * NEEDS_HUMAN-guarded transition, so a "record the gaps" answer on a mission
   * that had already moved on wrote that person's name onto the packet as
   * having authorized a report with open questions — a decision that, by the
   * card's own withdrawal, never applied. Recognising the card as moot first
   * leaves the packet exactly as it was.
   */
  for (const to of ['RUNNING', 'CANCELLED'] as const) {
    it(`A01: a "record the gaps" answer on a mission moved to ${to} authorizes nothing in the person's name`, async () => {
      const missionId = await parkedMission('ACCEPTED');
      const orchestrationId = (await getMission(missionId))!.orchestrationId!;
      const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.RECORD_GAPS.key);
      expect(
        await transitionMission({ missionId, from: 'NEEDS_HUMAN', to, ...(to === 'CANCELLED' ? { terminalReason: 'cancelled elsewhere' } : {}) }),
      ).toBe(true);

      const report = await tick(`skip-moot-gaps-${to}`);

      expect((await getHumanRequest(request.id))!.state).toBe('WITHDRAWN');
      expect(report.withdrawnMootAnswers.map((e) => e.requestId)).toContain(request.id);
      const packet = (await getOrchestration(orchestrationId))!;
      expect(packet.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
      expect(packet.unresolvedGapAuthorizedBy).toBeNull();
      expect(packet.unresolvedGapAuthorizedAt).toBeNull();
      const authorized = (await listEventsByEntity('RUN', packet.runId)).filter(
        (event) => event.eventType === 'RESEARCH_PLAN_REVIEWED' && (event.payload as { decision?: string } | null)?.decision === 'UNRESOLVED_GAP_POLICY_AUTHORIZED',
      );
      expect(authorized).toEqual([]);
      expect((await getMission(missionId))!.state).toBe(to);
    });
  }

  it('A03: a STOP answer on a mission that moved is resumed, not withdrawn', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.STOP.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);

    const report = await tick('skip-moot-stop');
    expect(resumed).toContain(request.id);
    expect((await getHumanRequest(request.id))!.state).toBe('RESUMED');
    expect(report.resumed).toContain(request.id);
    expect(report.withdrawnMootAnswers.map((e) => e.requestId)).not.toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('CANCELLED');
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
    expect(resumed).toContain(request.id);
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');
    expect((await getHumanRequest(request.id))!.state).toBe('OPEN');
    expect(report.withdrawnMootAnswers.map((e) => e.requestId)).not.toContain(request.id);
  });

  it('A03: a card about no mission is untouched by the moot check', async () => {
    const request = await answeredRequest(null, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);

    const report = await tick('skip-moot-missionless');
    expect(resumed).toContain(request.id);
    expect((await getHumanRequest(request.id))!.state).toBe('RESUMED');
    expect(report.withdrawnMootAnswers.map((e) => e.requestId)).not.toContain(request.id);
  });
});

describe('an OPEN card whose mission left Needs You, when the unpark pass fails', () => {
  async function openRequest(missionId: string) {
    const { request } = await askHuman({
      projectId: fixture.project.id,
      visibility: 'SHARED',
      missionId,
      authorityNeeded: 'Authorize the plan.',
      whyNotRussell: 'Only a person can authorize research.',
      choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.STOP],
      resumeKey: `skip-moot-open:${missionId}`,
    });
    return request;
  }

  it('is withdrawn by its own pass, never left for the operator, and a card whose mission waits stays open', async () => {
    unparkFails.on = true;
    const gone = await parkedMission();
    const goneCard = await openRequest(gone);
    expect(await transitionMission({ missionId: gone, from: 'NEEDS_HUMAN', to: 'CANCELLED', terminalReason: 'cancelled elsewhere' })).toBe(true);
    const waiting = await parkedMission();
    const waitingCard = await openRequest(waiting);

    const report = await tick('skip-moot-open-unpark-fails');
    // The recorded failure class: the pass the sweep used to live in did not complete.
    expect(report.passFailures.map((f) => f.pass)).toContain('unpark-resolved');

    const after = (await getHumanRequest(goneCard.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(after.whyNotRussell).toContain('CANCELLED');
    expect(report.withdrawnMootCards).toContain(goneCard.id);
    expect(await operatorWithdrawals(goneCard.id)).toEqual([]);
    expect(
      (await listEventsByEntity('RUSSELL_HUMAN_REQUEST', goneCard.id)).filter((e) => e.eventType === 'RUSSELL_ROUTINE_DECISION'),
    ).toHaveLength(1);

    expect((await getHumanRequest(waitingCard.id))!.state).toBe('OPEN');
    expect(report.withdrawnMootCards).not.toContain(waitingCard.id);
  });
});
