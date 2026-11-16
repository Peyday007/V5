/**
 * The filter-at-loop variant (experiment evx_f0f141e30794417c8187): the
 * loop's `answered-requests` pass reads an answered request's mission before
 * resuming it. A request whose mission has already left NEEDS_HUMAN is never
 * resumed — no resume can apply, and one (RECORD_GAPS) authorizes the packet's
 * unresolved gaps before it discovers the mission has moved on — and is
 * settled as moot through the existing guarded withdrawal instead of being
 * put back OPEN in front of a person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { newId, nowIso } from '../server/repos/util.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { createUser } from '../server/repos/identity.ts';
import { answerHumanRequest, askHuman, getHumanRequest, getMission, listOpenRequests, transitionMission } from '../server/repos/russellMissions.ts';
import * as needsHuman from '../server/services/russell/needsHuman.ts';
import { NEEDS_HUMAN_CHOICES } from '../server/services/russell/needsHuman.ts';
import { movedOutWith, tick } from '../server/services/russell/loop.ts';

const MOVED_OUT = 'the mission moved out of Needs You before the answer could be applied';

afterEach(() => vi.restoreAllMocks());

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
    choices: [NEEDS_HUMAN_CHOICES.APPROVE_PLAN, NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey: `moot-test:${missionId ?? newId('none')}`,
  });
  const answered = await answerHumanRequest({ requestId: request.id, actorUserId: userId, choice });
  expect(answered.ok, answered.reason).toBe(true);
  return (await getHumanRequest(request.id))!;
}


describe('answered-requests reads the mission before resuming', () => {
  it.each(['RUNNING', 'CANCELLED', 'FAILED'] as const)('withdraws, without resuming, an answer whose mission is already %s', async (state) => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.RECORD_GAPS.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: state, terminalReason: 'moved elsewhere' })).toBe(true);
    const resume = vi.spyOn(needsHuman, 'resumeAnsweredRequest');

    const report = await tick(`filter-${state}`);

    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    expect(resume.mock.calls.map(([one]) => one.id)).not.toContain(request.id);
    expect(after.whyNotRussell).toContain(state);
    expect(report.withdrawnMootAnswers).toContainEqual({ requestId: request.id, missionState: state, reason: MOVED_OUT });
    expect((await listOpenRequests(fixture.project.id)).map((r) => r.id)).not.toContain(request.id);
  });

  it('a STOP answer on a mission that left NEEDS_HUMAN still settles as a stop', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.STOP.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);

    const report = await tick('filter-stop');

    expect(report.resumed).toContain(request.id);
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).not.toContain(request.id);
    expect((await getHumanRequest(request.id))!.state).not.toBe('OPEN');
    expect((await getMission(missionId))!.state).not.toBe('RUNNING');
  });

  it('an answer whose mission still waits at NEEDS_HUMAN and whose resume fails is reopened with its choices, as before', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await getDb().run(`UPDATE russell_human_requests SET answered_choice = ? WHERE id = ?`, ['NOT_A_CHOICE', request.id]);
    await getDb().run(
      `UPDATE research_orchestrations SET status = 'AWAITING_APPROVAL' WHERE id = (SELECT orchestration_id FROM russell_missions WHERE id = ?)`,
      [missionId],
    );
    const resume = vi.spyOn(needsHuman, 'resumeAnsweredRequest');

    const report = await tick('filter-live');

    expect(resume.mock.calls.map(([one]) => one.id)).toContain(request.id);
    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('OPEN');
    expect(after.choices.map((c) => c.key)).toContain(NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).not.toContain(request.id);
  });

  it('an answer with no mission is resumed exactly as before', async () => {
    const request = await answeredRequest(null, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    const resume = vi.spyOn(needsHuman, 'resumeAnsweredRequest');
    const report = await tick('filter-missionless');
    expect(resume.mock.calls.map(([one]) => one.id)).toContain(request.id);
    expect(report.resumed).toContain(request.id);
  });

  it('a mission that leaves NEEDS_HUMAN between the read and a failed resume is withdrawn, not reopened', async () => {
    const missionId = await parkedMission();
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.APPROVE_PLAN.key);
    await getDb().run(
      `UPDATE research_orchestrations SET status = 'AWAITING_APPROVAL' WHERE id = (SELECT orchestration_id FROM russell_missions WHERE id = ?)`,
      [missionId],
    );
    const real = needsHuman.resumeAnsweredRequest;
    vi.spyOn(needsHuman, 'resumeAnsweredRequest').mockImplementation(async (one) => {
      if (one.id !== request.id) return real(one);
      // The mission moves on while the resume runs, and the resume fails for a reason of its own.
      await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' });
      return { ok: false, reason: 'the person who answered cannot be resolved, so nothing is authorized in their name', missionId, settled: false };
    });

    const report = await tick('filter-race');

    const after = (await getHumanRequest(request.id))!;
    expect(after.state).toBe('WITHDRAWN');
    const refusal = 'the person who answered cannot be resolved, so nothing is authorized in their name';
    // Both halves survive: the move that made it moot, and what the resume actually said.
    const settled = report.withdrawnMootAnswers.find((one) => one.requestId === request.id)!;
    expect(settled.missionState).toBe('RUNNING');
    expect(settled.reason).toContain(MOVED_OUT);
    expect(settled.reason).toContain(refusal);
    expect(after.whyNotRussell).toContain(MOVED_OUT);
    expect(after.whyNotRussell).toContain(refusal);
    expect((await listOpenRequests(fixture.project.id)).map((r) => r.id)).not.toContain(request.id);
  });

  it('keeps the refusal beside the move, names the move alone without one, and never repeats it', () => {
    expect(movedOutWith('no report to file')).toBe(`${MOVED_OUT}; no report to file`);
    expect(movedOutWith(MOVED_OUT)).toBe(MOVED_OUT);
    expect(movedOutWith('  ')).toBe(MOVED_OUT);
    expect(movedOutWith(null)).toBe(MOVED_OUT);
  });

  it('reproduces the recorded failure class: a RECORD_GAPS answer on a mission already running authorizes nothing in the answerer\'s name', async () => {
    const missionId = await parkedMission();
    const mission = (await getMission(missionId))!;
    // A packet with an accepted fragment: the state in which RECORD_GAPS would file the report with its gaps.
    await getDb().run(`UPDATE research_fragments SET status = 'ACCEPTED' WHERE orchestration_id = ?`, [mission.orchestrationId]);
    const request = await answeredRequest(missionId, NEEDS_HUMAN_CHOICES.RECORD_GAPS.key);
    expect(await transitionMission({ missionId, from: 'NEEDS_HUMAN', to: 'RUNNING' })).toBe(true);

    const report = await tick('filter-gaps');

    const packet = await getDb().get<{ unresolved_gap_policy: string | null }>(
      'SELECT unresolved_gap_policy FROM research_orchestrations WHERE id = ?',
      [mission.orchestrationId],
    );
    expect(packet?.unresolved_gap_policy ?? null).not.toBe('RECORD_GAPS');
    expect((await getHumanRequest(request.id))!.state).toBe('WITHDRAWN');
    expect(report.withdrawnMootAnswers.map((one) => one.requestId)).toContain(request.id);
  });
});
