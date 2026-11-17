/**
 * A research slot is held by work that is running, and by nothing else.
 *
 * Production, 2026-11-17 (Cash Mode 1, `brain_operator_capacity`): the
 * discovery grant held 22–26 live missions against an at-once ceiling of 13
 * while 41 missions read RUNNING beside 24 packets in flight with a mission,
 * and the $10K goal's nine rounds waited for a slot. A mission whose packet
 * had ended kept its hold renewed until the writeback reached it, and the
 * writeback window was the oldest live missions Brain-wide — the ones still
 * running. And rounds that did launch ended with fragments blocked
 * WORK_FAULTED "finished without recording anything" because their research
 * item ran out of attempts on lapsed leases.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { discoveryAuthority } from '../server/services/cash/discoveryAuthority.ts';
import { reserve } from '../server/repos/russellAuthority.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { getDb } from '../server/db/database.ts';
import {
  claimWriteback,
  closeStrandedWritebacks,
  getMission,
  launchMission,
  linkMission,
  renewLiveMissionReservations,
  STRANDED_WRITEBACK_MINUTES,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { enqueueWork, listWorkItemsForOrchestration } from '../server/repos/workQueue.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';

let projectId = '';
let layerId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  const user = await createUser({
    email: `slots-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function packet(): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded discovery question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a bounded discovery question',
    assignment: 'the openings it would find',
    provider: 'WORKER',
    autoApprove: true,
  });
  return orchestration.id;
}

async function liveHolds(goalId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM russell_budget_reservations
      WHERE goal_id = ? AND kind = 'MISSION' AND state = 'HELD' AND expires_at > ?`,
    [goalId, new Date().toISOString()],
  );
  return Number(row?.n ?? 0);
}

async function runningMission(): Promise<{ missionId: string; goalId: string; orchestrationId: string; reservationId: string }> {
  await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  const goal = (await discoveryAuthority(projectId))!;
  const candidate = await createCandidate({
    projectId,
    visibility: 'SHARED',
    title: 'An opening worth qualifying',
    statement: 'A bounded question about one published opening.',
  });
  const held = await reserve({ goalId: goal.id, kind: 'MISSION', idempotencyKey: `mission:${candidate.id}` });
  expect(held.ok).toBe(true);
  const { mission } = await launchMission({
    projectId,
    layerId,
    visibility: 'SHARED',
    objective: 'A bounded question about one published opening.',
    whyNow: 'the sprint is active',
    idempotencyKey: `mission:${candidate.id}`,
    candidateId: candidate.id,
    goalId: goal.id,
    reservationId: held.reservation!.id,
  } as never);
  const orchestrationId = await packet();
  await linkMission({ missionId: mission.id, orchestrationId });
  await updateOrchestration(orchestrationId, { status: 'RESEARCHING' });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  return { missionId: mission.id, goalId: goal.id, orchestrationId, reservationId: held.reservation!.id };
}

describe('a mission whose packet has ended', () => {
  it('gives its research slot back on the next renewal, before the writeback', async () => {
    const { missionId, goalId, orchestrationId } = await runningMission();
    await renewLiveMissionReservations(10);
    expect(await liveHolds(goalId)).toBe(1);

    await updateOrchestration(orchestrationId, { status: 'FAILED' });
    await renewLiveMissionReservations(10);
    expect(await liveHolds(goalId)).toBe(0);

    // Nothing rewritten: the mission is still RUNNING until its writeback, and
    // the hold is still HELD (lapsed), for the writeback to settle.
    expect((await getMission(missionId))?.state).toBe('RUNNING');
    const kept = await getDb().get<{ state: string }>(
      `SELECT state FROM russell_budget_reservations WHERE goal_id = ? AND kind = 'MISSION'`,
      [goalId],
    );
    expect(kept?.state).toBe('HELD');

    // A second renewal does not readmit it.
    await renewLiveMissionReservations(10);
    expect(await liveHolds(goalId)).toBe(0);
  });

  it('keeps the slot of a mission whose packet is still running', async () => {
    const { goalId } = await runningMission();
    await renewLiveMissionReservations(10);
    await renewLiveMissionReservations(10);
    expect(await liveHolds(goalId)).toBe(1);
  });
});

describe('a writeback claimed and never finished', () => {
  it('closes the mission with a recorded reason and settles its hold', async () => {
    const { missionId, orchestrationId, reservationId } = await runningMission();
    await updateOrchestration(orchestrationId, { status: 'CANCELLED' });
    expect(await claimWriteback(missionId)).toBe(true);

    // Not yet stranded: a writeback in progress is left to finish.
    expect(await closeStrandedWritebacks(10)).toEqual([]);

    const later = new Date(Date.now() + (STRANDED_WRITEBACK_MINUTES + 1) * 60_000);
    expect(await closeStrandedWritebacks(10, later)).toEqual([missionId]);
    const mission = await getMission(missionId);
    expect(mission?.state).toBe('FAILED');
    expect(mission?.terminalReason).toContain('never finished');
    const hold = await getDb().get<{ state: string }>(
      'SELECT state FROM russell_budget_reservations WHERE id = ?',
      [reservationId],
    );
    expect(hold?.state).toBe('SETTLED');
  });

  it('leaves a mission whose packet is still running', async () => {
    const { missionId } = await runningMission();
    expect(await claimWriteback(missionId)).toBe(true);
    const later = new Date(Date.now() + (STRANDED_WRITEBACK_MINUTES + 1) * 60_000);
    expect(await closeStrandedWritebacks(10, later)).toEqual([]);
    expect((await getMission(missionId))?.state).toBe('RUNNING');
  });
});

describe('a fragment whose research item the queue spent', () => {
  async function researchingPacket(): Promise<{ orchestrationId: string; fragmentId: string }> {
    const orchestrationId = await packet();
    await createFragments([
      {
        orchestrationId,
        projectId,
        layerId,
        geography: 'United States',
        requiredEvidence: [{ id: 'demand_signal', description: 'a posting', necessity: 'REQUIRED' }],
        acceptableSourceTypes: ['the marketplace itself'],
        excludedSourceTypes: ['a blog about it'],
        completionCriteria: ['one dated posting'],
        minIndependentSources: 1,
        maxRepairs: 2,
        fragmentIndex: 0,
        fragmentKey: 'openings',
        question: 'Who is asking to be paid for this?',
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const fragment = (await currentFragments(orchestrationId))[0]!;
    await updateFragment(fragment.id, { status: 'QUEUED' });
    await updateOrchestration(orchestrationId, { status: 'RESEARCHING' });
    return { orchestrationId, fragmentId: fragment.id };
  }

  async function spentItem(orchestrationId: string, fragmentId: string, category: string): Promise<void> {
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_FRAGMENT',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim', 'claims:write'],
      orchestrationId,
      fragmentId,
    });
    await getDb().run(
      `UPDATE work_items SET state = 'FAILED', failure_category = ?, attempt_count = max_attempts WHERE id = ?`,
      [category, item.id],
    );
  }

  async function fragmentState(fragmentId: string): Promise<{ status: string; blocked_reason: string | null }> {
    return (await getDb().get<{ status: string; blocked_reason: string | null }>(
      'SELECT status, blocked_reason FROM research_fragments WHERE id = ?',
      [fragmentId],
    ))!;
  }

  it('is given another item rather than blocked WORK_FAULTED', async () => {
    const { orchestrationId, fragmentId } = await researchingPacket();
    await spentItem(orchestrationId, fragmentId, 'LEASE_EXPIRED');

    await advancePacket(orchestrationId);

    expect((await fragmentState(fragmentId)).status).toBe('QUEUED');
    const items = (await listWorkItemsForOrchestration(orchestrationId)).filter(
      (item) => item.workType === 'RESEARCH_FRAGMENT' && item.fragmentId === fragmentId,
    );
    expect(items.map((item) => item.state).sort()).toEqual(['FAILED', 'QUEUED']);
  });

  it('is blocked once its items reach the per-target bound', async () => {
    const { orchestrationId, fragmentId } = await researchingPacket();
    for (let i = 0; i < 3; i += 1) await spentItem(orchestrationId, fragmentId, 'ATTEMPTS_EXHAUSTED');

    await advancePacket(orchestrationId);

    const fragment = await fragmentState(fragmentId);
    expect(fragment.status).toBe('BLOCKED');
    expect(fragment.blocked_reason).toMatch(/^A research work item for this fragment finished without recording/);
  });

  it('is still blocked when a worker failed its item as not retryable', async () => {
    const { orchestrationId, fragmentId } = await researchingPacket();
    await spentItem(orchestrationId, fragmentId, 'INVALID_INPUT');

    await advancePacket(orchestrationId);

    expect((await fragmentState(fragmentId)).status).toBe('BLOCKED');
  });
});
