/**
 * RECOVERY.STALLS — "packet idle holding a slot".
 *
 * A live packet with nothing QUEUED or LEASED has nothing left to complete, so
 * nothing calls `advancePacket` on it; if its last advance never happened it is
 * idle for ever. The tick sweep must reach it from rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The real recompute runs; the wrapper only records that a transition asked
 * for it, so a conclusion that leaves derived state stale is caught (§6).
 */
vi.mock('../server/services/stateEngine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/stateEngine.ts')>();
  return { ...actual, recomputeProject: vi.fn(actual.recomputeProject) };
});
import { recomputeProject } from '../server/services/stateEngine.ts';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  getOrchestration,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  advanceIdlePackets,
  concludeUnworkablePackets,
  PACKET_PROGRESS_DEADLINE_MS,
  PACKET_STALL_WINDOW_MS,
  resetIdlePacketAttempts,
} from '../server/services/research/packetRunner.ts';

let projectId = '';
let layerId = '';

beforeEach(async () => {
  resetIdlePacketAttempts();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('World Model')).id;
});

async function packet(status: string, ageMs: number): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'anything',
  });
  const o = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'An idle packet',
    assignment: 'nothing is outstanding',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(o.id, { status: status as never });
  await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
    new Date(Date.now() - ageMs).toISOString(),
    o.id,
  ]);
  return o.id;
}

const STALE = PACKET_STALL_WINDOW_MS + 60_000;

describe('advanceIdlePackets', () => {
  it('reaches a live packet idle past the window with nothing outstanding, then is idempotent', async () => {
    const id = await packet('SYNTHESIZING', STALE);
    const before = (await getOrchestration(id))!;

    const first = await advanceIdlePackets(10);
    expect(first.map((e) => e.orchestrationId)).toContain(id);

    const after = (await getOrchestration(id))!;
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.now() - PACKET_STALL_WINDOW_MS);

    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
  });

  it('is reached by the existing tick sweep without a new entry point', async () => {
    const id = await packet('SYNTHESIZING', STALE);
    await concludeUnworkablePackets(10);
    const after = (await getOrchestration(id))!;
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.now() - PACKET_STALL_WINDOW_MS);
  });

  it('starts a worker packet left QUEUED with nothing queued: its plan is asked for', async () => {
    // Production 2026-11-06: "QUEUED+nothing queued:7", idle past six hours,
    // after the launch's first advance failed on a dropped connection.
    const id = await packet('QUEUED', STALE);
    const moved = await advanceIdlePackets(10);
    expect(moved.map((e) => e.orchestrationId)).toContain(id);
    expect((await getOrchestration(id))!.status).toBe('PLANNING');
    const plan = await getDb().all<{ work_type: string }>(
      `SELECT work_type FROM work_items WHERE orchestration_id = ? AND state IN ('QUEUED', 'LEASED')`,
      [id],
    );
    expect(plan.map((p) => p.work_type)).toContain('RESEARCH_PLAN');
  });

  it('leaves a recently updated packet alone', async () => {
    const id = await packet('SYNTHESIZING', 60_000);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
  });

  it('leaves a terminal packet alone', async () => {
    const id = await packet('COMPLETE', STALE);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
  });

  it('leaves a packet with outstanding work to its queue', async () => {
    const id = await packet('SYNTHESIZING', STALE);
    await enqueueWork({
      projectId,
      workType: 'RESEARCH_SYNTHESIZE',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: id,
    });
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
  });

  it('does not let a packet that cannot advance crowd out one that can', async () => {
    // A repair waiting on a scheduled retry is a packet advancePacket leaves as
    // it is; it is older, so it is selected first.
    const stuck = await packet('AWAITING_REPAIR', STALE + 3_600_000);
    const [fragment] = await createFragments([{
      orchestrationId: stuck,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'f0',
      question: 'q',
      requiredEvidence: [],
      acceptableSourceTypes: [],
      excludedSourceTypes: [],
      completionCriteria: [],
      dependsOn: [],
      minIndependentSources: 1,
    }]);
    await updateFragment(fragment!.id, { nextRetryAt: new Date(Date.now() + 3_600_000).toISOString() });
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - STALE - 3_600_000).toISOString(),
      stuck,
    ]);
    const movable = await packet('SYNTHESIZING', STALE);
    const stuckBefore = (await getOrchestration(stuck))!;

    // limit 1: the first pass spends it on the stuck packet and moves nothing.
    expect(await advanceIdlePackets(1)).toEqual([]);
    expect((await getOrchestration(stuck))!.updatedAt).toBe(stuckBefore.updatedAt);

    // the second pass skips it and reaches the packet behind it.
    expect((await advanceIdlePackets(1)).map((e) => e.orchestrationId)).toEqual([movable]);
    expect((await getOrchestration(stuck))!.updatedAt).toBe(stuckBefore.updatedAt);
  });
});

/**
 * The bound action. Detection alone left a packet whose advance changes nothing
 * live, unstamped and re-tried every hour for ever. Past the progress deadline,
 * judged from its own rows, it is concluded once.
 */
describe('the progress deadline', () => {
  const OVERDUE = PACKET_PROGRESS_DEADLINE_MS + 60_000;
  /** Between the stall window and the deadline: advanced, but not yet concluded. */
  const UNDER = Math.floor((PACKET_STALL_WINDOW_MS + PACKET_PROGRESS_DEADLINE_MS) / 2);

  async function age(id: string, ageMs: number): Promise<void> {
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - ageMs).toISOString(),
      id,
    ]);
  }

  async function fragmentOn(id: string, patch: Parameters<typeof updateFragment>[1]): Promise<void> {
    const [fragment] = await createFragments([{
      orchestrationId: id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'f0',
      question: 'q',
      requiredEvidence: [],
      acceptableSourceTypes: [],
      excludedSourceTypes: [],
      completionCriteria: [],
      dependsOn: [],
      minIndependentSources: 1,
    }]);
    await updateFragment(fragment!.id, patch);
  }

  /**
   * The recorded failure class, from rows: AWAITING_REPAIR whose repair time has
   * already passed, on a fragment left RUNNING with no item. `advancePacket`
   * reads any `nextRetryAt` as a wait, so it changes nothing, every time.
   */
  async function stalled(ageMs: number, fragmentStatus: 'RUNNING' | 'NEEDS_HUMAN' = 'RUNNING'): Promise<string> {
    const id = await packet('AWAITING_REPAIR', ageMs);
    await fragmentOn(id, { status: fragmentStatus, nextRetryAt: new Date(Date.now() - 3_600_000).toISOString() });
    await age(id, ageMs);
    return id;
  }

  async function events(id: string): Promise<{ event_type: string; payload: string }[]> {
    return getDb().all<{ event_type: string; payload: string }>(
      `SELECT event_type, payload FROM project_events WHERE payload LIKE ?`,
      [`%${id}%`],
    );
  }

  it('reproduces the stall: under the deadline the advance changes nothing and the packet stays live', async () => {
    const id = await stalled(UNDER);
    const before = (await getOrchestration(id))!;
    expect(await advanceIdlePackets(10)).toEqual([]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('AWAITING_REPAIR');
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('concludes a no-op idle packet past the deadline through the existing tick, with its reason and an event', async () => {
    const id = await stalled(OVERDUE);
    await concludeUnworkablePackets(10);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toMatch(/sat AWAITING_REPAIR for 5 hours/);
    expect(after.failureReason).toMatch(/progress deadline/);
    expect(after.failureReason).toMatch(/Nothing was synthesized/);
    expect(after.failedAt).not.toBeNull();
    expect(after.documentId).toBeNull();
    const failed = (await events(id)).filter((e) => e.event_type === 'RESEARCH_FAILED');
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!.payload)).toMatchObject({ orchestrationId: id, stuckStatus: 'AWAITING_REPAIR', status: 'FAILED' });

    // Once: a concluded packet is no longer selected.
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect((await events(id)).filter((e) => e.event_type === 'RESEARCH_FAILED')).toHaveLength(1);
  });

  it('re-derives project state when it concludes a packet, and not when it leaves one alone (§6)', async () => {
    const recompute = vi.mocked(recomputeProject);
    const young = await stalled(UNDER);
    recompute.mockClear();
    expect(await advanceIdlePackets(10)).toEqual([]);
    expect(recompute).not.toHaveBeenCalled();
    expect((await getOrchestration(young))!.status).toBe('AWAITING_REPAIR');

    const failed = await stalled(OVERDUE);
    const parked = await stalled(OVERDUE, 'NEEDS_HUMAN');
    recompute.mockClear();
    const moved = await advanceIdlePackets(10);
    expect(moved.map((e) => e.orchestrationId).sort()).toEqual([failed, parked].sort());
    expect(recompute).toHaveBeenCalledTimes(2);
    expect(recompute.mock.calls.every(([id]) => id === projectId)).toBe(true);
  });

  it('reads the judgment from rows, so a restart neither resets it nor brings it forward', async () => {
    const overdue = await stalled(UNDER);
    const young = await stalled(UNDER);
    // First pass: both are under the deadline and are only remembered as no-ops.
    expect(await advanceIdlePackets(10)).toEqual([]);

    // Time passes for one of them, and the process restarts.
    await age(overdue, OVERDUE);
    resetIdlePacketAttempts();

    const moved = await advanceIdlePackets(10);
    expect(moved).toEqual([{ orchestrationId: overdue, from: 'AWAITING_REPAIR', to: 'FAILED' }]);
    expect((await getOrchestration(overdue))!.status).toBe('FAILED');
    expect((await getOrchestration(young))!.status).toBe('AWAITING_REPAIR');
  });

  it('parks at NEEDS_HUMAN when a fragment already asks for a person', async () => {
    const id = await stalled(OVERDUE, 'NEEDS_HUMAN');
    const moved = await advanceIdlePackets(10);
    expect(moved).toEqual([{ orchestrationId: id, from: 'AWAITING_REPAIR', to: 'NEEDS_HUMAN' }]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('NEEDS_HUMAN');
    expect(after.failureReason).toMatch(/one of its fragments already asks for/);
    expect((await events(id)).map((e) => e.event_type)).toContain('RESEARCH_BLOCKED');
  });

  it('parks a stalled packet behind a mission at NEEDS_HUMAN instead of failing it, as a no-gate packet does', async () => {
    const id = await stalled(OVERDUE);
    const { mission } = await launchMission({
      projectId, layerId, visibility: 'PRIVATE', objective: 'o', whyNow: 'w', idempotencyKey: `m-${id}`,
    });
    await linkMission({ missionId: mission.id, orchestrationId: id });
    await age(id, OVERDUE);
    const moved = await advanceIdlePackets(10);
    expect(moved).toEqual([{ orchestrationId: id, from: 'AWAITING_REPAIR', to: 'NEEDS_HUMAN' }]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('NEEDS_HUMAN');
    expect(after.failedAt).toBeNull();
    expect(after.failureReason).toMatch(new RegExp(`behind mission ${mission.id}`));
    expect(after.failureReason).toMatch(/progress deadline/);
    const kinds = (await events(id)).map((e) => e.event_type);
    expect(kinds).toContain('RESEARCH_BLOCKED');
    expect(kinds).not.toContain('RESEARCH_FAILED');

    // The same stall with no mission still ends FAILED: only the mission changes it.
    const lone = await stalled(OVERDUE);
    await advanceIdlePackets(10);
    expect((await getOrchestration(lone))!.status).toBe('FAILED');
  });

  it('never concludes a plan waiting for a person to approve it: that is the §16 gate, not a stall', async () => {
    const id = await packet('PLANNING', OVERDUE);
    await fragmentOn(id, { status: 'PLANNED' });
    await age(id, OVERDUE);
    const before = (await getOrchestration(id))!;
    expect(await advanceIdlePackets(10)).toEqual([]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('PLANNING');
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('never concludes a repair that is scheduled to return', async () => {
    const id = await packet('AWAITING_REPAIR', OVERDUE);
    await fragmentOn(id, { status: 'RUNNING', nextRetryAt: new Date(Date.now() + 3_600_000).toISOString() });
    await age(id, OVERDUE);
    expect(await advanceIdlePackets(10)).toEqual([]);
    expect((await getOrchestration(id))!.status).toBe('AWAITING_REPAIR');
  });

  it('never selects or changes an overdue packet with a QUEUED item, or one under a live lease', async () => {
    const queued = await stalled(OVERDUE);
    await enqueueWork({
      projectId,
      workType: 'RESEARCH_SYNTHESIZE',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: queued,
    });
    await age(queued, OVERDUE);
    const leased = await stalled(OVERDUE);
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_SYNTHESIZE',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: leased,
    });
    await getDb().run(
      `UPDATE work_items SET state = 'LEASED', lease_id = 'lse_live', worker_id = ?, lease_expires_at = ? WHERE id = ?`,
      [
        (await createWorker({ name: 'holding-worker', createdByType: 'SYSTEM', createdById: 'test' })).id,
        new Date(Date.now() + 3_600_000).toISOString(),
        item.id,
      ],
    );
    await age(leased, OVERDUE);
    const before = [(await getOrchestration(queued))!, (await getOrchestration(leased))!];

    const moved = (await concludeUnworkablePackets(10)).map((e) => e.orchestrationId);
    const swept = (await advanceIdlePackets(10)).map((e) => e.orchestrationId);
    expect([...moved, ...swept]).not.toContain(queued);
    expect([...moved, ...swept]).not.toContain(leased);
    expect((await getOrchestration(queued))!).toEqual(before[0]);
    expect((await getOrchestration(leased))!).toEqual(before[1]);
  });
});
