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

/*
 * An advance that fails every time, for the packets the progress deadline is the
 * backstop for. Off by default, so every other packet plans its repairs with the
 * real ladder.
 */
const advanceFault = vi.hoisted(() => ({ on: false }));
vi.mock('../server/services/research/repair.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/research/repair.ts')>();
  return {
    ...actual,
    buildRepairPlan: (...args: Parameters<typeof actual.buildRepairPlan>) => {
      if (advanceFault.on) throw new Error('the repair planner is unavailable');
      return actual.buildRepairPlan(...args);
    },
  };
});
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
  advanceFault.on = false;
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
 * RECOVERY.STALLS attempt 3 — the '+work' class. A packet whose fragment is
 * being worked under a live, heartbeated lease never had its own `updated_at`
 * touched, so `PACKETS_MOVING` (updated within six hours) read it as idle.
 */
describe('a packet whose work is being done under a live lease', () => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  async function leasedItem(
    orchestrationId: string,
    lease: { heartbeatAgoMs: number | null; expiresInMs: number; claimedAgoMs?: number },
  ): Promise<string> {
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_FRAGMENT',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId,
    });
    const worker = await createWorker({ name: `w-${item.id}`, createdByType: 'SYSTEM', createdById: 'test' });
    const heartbeat = lease.heartbeatAgoMs === null ? null : new Date(Date.now() - lease.heartbeatAgoMs).toISOString();
    const claimed = lease.claimedAgoMs === undefined ? heartbeat : new Date(Date.now() - lease.claimedAgoMs).toISOString();
    await getDb().run(
      `UPDATE work_items SET state = 'LEASED', lease_id = ?, worker_id = ?, lease_generation = 1,
              leased_at = ?, heartbeat_at = ?, lease_expires_at = ? WHERE id = ?`,
      [
        `lse_${item.id}`,
        worker.id,
        claimed,
        heartbeat,
        new Date(Date.now() + lease.expiresInMs).toISOString(),
        item.id,
      ],
    );
    return item.id;
  }

  async function itemRow(id: string): Promise<Record<string, unknown>> {
    return (await getDb().get<Record<string, unknown>>(
      'SELECT state, lease_generation, lease_id, worker_id, leased_at, heartbeat_at, lease_expires_at FROM work_items WHERE id = ?',
      [id],
    ))!;
  }

  it('reproduces the failure class and is stamped so PACKETS_MOVING reads it as moving', async () => {
    // Past six hours by its own row, while a worker heartbeated a minute ago.
    const id = await packet('RESEARCHING', SIX_HOURS + 60_000);
    const item = await leasedItem(id, { heartbeatAgoMs: 60_000, expiresInMs: 600_000 });
    const itemBefore = await itemRow(item);

    const swept = await advanceIdlePackets(10);
    expect(swept).toContainEqual({ orchestrationId: id, from: 'RESEARCHING', to: 'RESEARCHING' });

    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('RESEARCHING');
    // The probe's own predicate: updated within six hours.
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.now() - SIX_HOURS);
    // The worker's item is untouched: the queue still owns it.
    expect(await itemRow(item)).toEqual(itemBefore);

    // Stamped, so it drops out of the selection.
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
  });

  it('leaves work that shows no progress exactly as it is: no stamp, no conclusion, no item change', async () => {
    const queued = await packet('RESEARCHING', PACKET_PROGRESS_DEADLINE_MS + 60_000);
    const queuedItem = (await enqueueWork({
      projectId,
      workType: 'RESEARCH_FRAGMENT',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: queued,
    })).id;
    const staleHeartbeat = await packet('RESEARCHING', PACKET_PROGRESS_DEADLINE_MS + 60_000);
    const staleItem = await leasedItem(staleHeartbeat, {
      heartbeatAgoMs: PACKET_STALL_WINDOW_MS + 60_000,
      expiresInMs: 600_000,
    });
    const expired = await packet('RESEARCHING', PACKET_PROGRESS_DEADLINE_MS + 60_000);
    const expiredItem = await leasedItem(expired, { heartbeatAgoMs: 60_000, expiresInMs: -60_000 });
    const ids = [queued, staleHeartbeat, expired];
    const items = [queuedItem, staleItem, expiredItem];
    const before = await Promise.all(ids.map(async (id) => (await getOrchestration(id))!));
    const itemsBefore = await Promise.all(items.map(itemRow));

    const swept = (await advanceIdlePackets(10)).map((e) => e.orchestrationId);
    for (const id of ids) expect(swept).not.toContain(id);
    expect(await Promise.all(ids.map(async (id) => (await getOrchestration(id))!))).toEqual(before);
    expect(await Promise.all(items.map(itemRow))).toEqual(itemsBefore);
  });

  it('reads a heartbeat as liveness, not progress: one claim moves the packet once, however long it is heartbeated', async () => {
    // Review finding: a worker that heartbeats an item for ever without
    // completing it kept its packet reading as moving indefinitely, and every
    // stamp pushed back the updated_at the progress deadline reads.
    const claimedAgo = 5 * 60 * 60 * 1000;
    const id = await packet('RESEARCHING', SIX_HOURS + 60_000);
    const item = await leasedItem(id, { claimedAgoMs: claimedAgo, heartbeatAgoMs: 60_000, expiresInMs: 600_000 });
    const claimedAt = (await itemRow(item)).leased_at as string;

    // The claim is real progress newer than the packet's row: stamped to it, not to now.
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).toContain(id);
    expect((await getOrchestration(id))!.updatedAt).toBe(claimedAt);

    // The worker keeps heartbeating; nothing it does moves the packet again.
    for (let beatNo = 0; beatNo < 3; beatNo += 1) {
      await getDb().run('UPDATE work_items SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ?', [
        new Date().toISOString(),
        new Date(Date.now() + 600_000).toISOString(),
        item,
      ]);
      expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
      expect((await getOrchestration(id))!.updatedAt).toBe(claimedAt);
    }

    // So once six hours pass from the claim it reads idle, and when the lease
    // ends the deadline is measured from the claim, never from the last heartbeat.
    expect(Date.now() - Date.parse((await getOrchestration(id))!.updatedAt)).toBeGreaterThanOrEqual(claimedAgo);
  });

  it('a reclaim is a new progress event and moves the packet to that claim', async () => {
    const id = await packet('RESEARCHING', SIX_HOURS + 60_000);
    const item = await leasedItem(id, { claimedAgoMs: 5 * 60 * 60 * 1000, heartbeatAgoMs: 60_000, expiresInMs: 600_000 });
    await advanceIdlePackets(10);
    const reclaimed = new Date(Date.now() - 30_000).toISOString();
    await getDb().run('UPDATE work_items SET leased_at = ?, heartbeat_at = ?, lease_generation = 2 WHERE id = ?', [
      reclaimed,
      reclaimed,
      item,
    ]);
    // Within the stall window now, so it is out of the selection — and was moved by a real claim.
    expect((await getOrchestration(id))!.updatedAt < reclaimed).toBe(true);
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - SIX_HOURS).toISOString(),
      id,
    ]);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).toContain(id);
    expect((await getOrchestration(id))!.updatedAt).toBe(reclaimed);
  });

  it('leaves a recently updated packet under a live lease alone', async () => {
    const id = await packet('RESEARCHING', 60_000);
    await leasedItem(id, { heartbeatAgoMs: 1_000, expiresInMs: 600_000 });
    const before = (await getOrchestration(id))!;
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect((await getOrchestration(id))!.updatedAt).toBe(before.updatedAt);
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

  async function fragmentOn(id: string, patch: Parameters<typeof updateFragment>[1], index = 0): Promise<void> {
    const [fragment] = await createFragments([{
      orchestrationId: id,
      projectId,
      layerId,
      fragmentIndex: index,
      fragmentKey: `f${index}`,
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
   * What the deadline is the backstop for: a packet whose advance cannot move
   * it. AWAITING_REPAIR with a blocked fragment whose repair cannot even be
   * planned — the advance fails every time, so it changes nothing, every time.
   * (A repair time that has already passed is no longer such a packet: it is a
   * repair that is due, and the advance runs it — see the next describe.)
   */
  async function stalled(ageMs: number, fragmentStatus: 'BLOCKED' | 'NEEDS_HUMAN' = 'BLOCKED'): Promise<string> {
    advanceFault.on = true;
    const id = await packet('AWAITING_REPAIR', ageMs);
    await fragmentOn(id, { status: fragmentStatus });
    if (fragmentStatus !== 'BLOCKED') await fragmentOn(id, { status: 'BLOCKED' }, 1);
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

/**
 * The finding this repairs: a retry time that has already passed was read as a
 * wait, so the packet changed nothing on every advance until the progress
 * deadline wrote it off as FAILED — a due repair lost and its research abandoned
 * instead of moved. A passed retry time is a repair that is due: the advance
 * mints it when the one repair answer still allows it, and parks the packet with
 * that answer's refusals when it does not. Both happen under the deadline, which
 * stays the backstop only for a packet that genuinely cannot move.
 */
describe('a repair whose retry time has passed is due, not a wait', () => {
  const UNDER = Math.floor((PACKET_STALL_WINDOW_MS + PACKET_PROGRESS_DEADLINE_MS) / 2);
  const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

  async function dueRepair(fragmentStatus: 'BLOCKED' | 'RUNNING', patch: Parameters<typeof updateFragment>[1] = {}): Promise<{ id: string; fragmentId: string }> {
    const id = await packet('AWAITING_REPAIR', UNDER);
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
    await updateFragment(fragment!.id, { status: fragmentStatus, nextRetryAt: PAST(), ...patch });
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - UNDER).toISOString(),
      id,
    ]);
    return { id, fragmentId: fragment!.id };
  }

  async function liveItems(id: string): Promise<{ work_type: string }[]> {
    return getDb().all<{ work_type: string }>(
      `SELECT work_type FROM work_items WHERE orchestration_id = ? AND state IN ('QUEUED', 'LEASED')`,
      [id],
    );
  }

  it('mints a due repair that is still allowed, and the packet moves rather than being written off', async () => {
    const { id } = await dueRepair('BLOCKED', { blockedReason: 'no source cleared the gate' });
    const moved = await advanceIdlePackets(10);
    expect(moved.map((e) => e.orchestrationId)).toContain(id);
    const after = (await getOrchestration(id))!;
    expect(after.status).not.toBe('FAILED');
    expect(after.status).not.toBe('AWAITING_REPAIR');
    const attempts = await getDb().all<{ attempt: number; status: string }>(
      `SELECT attempt, status FROM research_fragments WHERE orchestration_id = ? AND fragment_key = 'f0' ORDER BY attempt`,
      [id],
    );
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect((await liveItems(id)).map((i) => i.work_type)).toContain('RESEARCH_FRAGMENT');
  });

  it('parks a due repair nothing can mint with the refusal, under the deadline, instead of idling into FAILED', async () => {
    const { id } = await dueRepair('RUNNING');
    const moved = await advanceIdlePackets(10);
    expect(moved).toEqual([{ orchestrationId: id, from: 'AWAITING_REPAIR', to: 'NEEDS_HUMAN' }]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('NEEDS_HUMAN');
    expect(after.failedAt).toBeNull();
    expect(after.failureReason).toContain('no claimable work');
    expect(after.failureReason).not.toMatch(/progress deadline/);
  });

  it('parks with the ladder\'s own refusal when the fragment has had its last attempt', async () => {
    const { id } = await dueRepair('BLOCKED', { maxRepairs: 1 });
    await advanceIdlePackets(10);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('NEEDS_HUMAN');
    expect(after.failureReason).toMatch(/f0 has had 1 of its 1 attempt\(s\)/);
  });

  it('still leaves a repair whose retry time is ahead to return when it said it would', async () => {
    const { id } = await dueRepair('RUNNING', { nextRetryAt: new Date(Date.now() + 3_600_000).toISOString() });
    const before = (await getOrchestration(id))!;
    expect(await advanceIdlePackets(10)).toEqual([]);
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('AWAITING_REPAIR');
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

/**
 * The review finding this repairs: the probe's '+work' bucket counts packets
 * with QUEUED or LEASED items, and only the LEASED-under-a-live-heartbeat subset
 * was moved. A packet whose QUEUED work was claimable for the whole progress
 * deadline and never claimed stayed live and idle for ever. It now takes the
 * deadline's existing bound action, with the deadline's own guards.
 */
describe('a packet whose queued work nobody claims', () => {
  const OVERDUE = PACKET_PROGRESS_DEADLINE_MS + 60_000;

  async function overdueWithQueued(opts: { availableAgoMs?: number; leasedAgoMs?: number } = {}): Promise<{ id: string; itemId: string }> {
    const id = await packet('RESEARCHING', OVERDUE);
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_FRAGMENT',
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: id,
    });
    const created = new Date(Date.now() - OVERDUE).toISOString();
    const available = new Date(Date.now() - (opts.availableAgoMs ?? OVERDUE)).toISOString();
    const leased = opts.leasedAgoMs === undefined ? null : new Date(Date.now() - opts.leasedAgoMs).toISOString();
    await getDb().run('UPDATE work_items SET created_at = ?, available_at = ?, leased_at = ? WHERE id = ?', [
      created,
      available,
      leased,
      item.id,
    ]);
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [created, id]);
    return { id, itemId: item.id };
  }

  async function itemState(itemId: string): Promise<string> {
    return (await getDb().get<{ state: string }>('SELECT state FROM work_items WHERE id = ?', [itemId]))!.state;
  }

  /**
   * The lane was serving: some worker claimed another item of `workType`
   * `claimedAgoMs` ago, and finished it. That is the evidence that this
   * packet's item was passed over rather than that nobody was taking the work.
   */
  async function laneServed(workType: string, claimedAgoMs: number): Promise<void> {
    const other = await enqueueWork({
      projectId,
      workType,
      payload: {},
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
    });
    const worker = await createWorker({ name: `lane-${other.id}`, createdByType: 'SYSTEM', createdById: 'test' });
    const claimed = new Date(Date.now() - claimedAgoMs).toISOString();
    await getDb().run(
      `UPDATE work_items SET state = 'SUCCEEDED', attempt_count = 1, lease_generation = 1,
              leased_at = ?, completed_at = ? WHERE id = ?`,
      [claimed, claimed, other.id],
    );
    await getDb().run(
      `INSERT INTO work_leases (id, work_item_id, project_id, attempt_number, lease_generation, worker_id,
                                claimed_at, expires_at, ended_at, outcome)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, 'SUCCEEDED')`,
      [`wls_${other.id}`, other.id, projectId, worker.id, claimed, claimed, claimed],
    );
  }

  it('reproduces the failure class: claimable, never claimed past the deadline, and the tick concludes it', async () => {
    const { id, itemId } = await overdueWithQueued();
    await laneServed('RESEARCH_FRAGMENT', 60 * 60_000);
    vi.mocked(recomputeProject).mockClear();

    const swept = await advanceIdlePackets(10);

    expect(swept).toContainEqual({ orchestrationId: id, from: 'RESEARCHING', to: 'FAILED' });
    const after = (await getOrchestration(id))!;
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toContain('no worker claimed');
    expect(await itemState(itemId)).toBe('CANCELLED');
    const event = await getDb().get<{ payload: string }>(
      `SELECT payload FROM project_events WHERE event_type = 'RESEARCH_FAILED' AND payload LIKE ?`,
      [`%${id}%`],
    );
    expect(JSON.parse(event!.payload)).toMatchObject({ orchestrationId: id, unclaimedWithdrawn: 1 });
    expect(recomputeProject).toHaveBeenCalledWith(projectId);

    // Idempotent by the state it produced.
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
  });

  it('is reached through the existing tick sweep', async () => {
    const { id } = await overdueWithQueued();
    await laneServed('RESEARCH_FRAGMENT', 60 * 60_000);
    await concludeUnworkablePackets(10);
    expect((await getOrchestration(id))!.status).toBe('FAILED');
  });

  /*
   * The recorded review finding: with no worker taking this work type at all in
   * the window (a lane outage, a quota, the §86 controller holding, contention
   * ahead of it), "nobody claimed it" is Brain's missing capacity, not the
   * packet's failure (§53). The packet stays live and its work stays queued.
   */
  it('never concludes a packet when no worker took that work type in the window: that is missing capacity', async () => {
    const { id, itemId } = await overdueWithQueued();
    const before = (await getOrchestration(id))!;

    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    await concludeUnworkablePackets(10);

    expect((await getOrchestration(id))!).toEqual(before);
    expect(await itemState(itemId)).toBe('QUEUED');
  });

  it('does not read claims of a different work type as the lane serving this one', async () => {
    const { id, itemId } = await overdueWithQueued();
    await laneServed('RESEARCH_PLAN', 60 * 60_000);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect(await itemState(itemId)).toBe('QUEUED');
    expect((await getOrchestration(id))!.status).toBe('RESEARCHING');
  });

  it('does not read a claim from before the window as the lane serving it now', async () => {
    const { id, itemId } = await overdueWithQueued();
    await laneServed('RESEARCH_FRAGMENT', OVERDUE + 60 * 60_000);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect(await itemState(itemId)).toBe('QUEUED');
  });

  it('leaves an item in backoff alone: available only recently is not unclaimed', async () => {
    const { id, itemId } = await overdueWithQueued({ availableAgoMs: 60_000 });
    const before = (await getOrchestration(id))!;
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect((await getOrchestration(id))!).toEqual(before);
    expect(await itemState(itemId)).toBe('QUEUED');
  });

  it('leaves an item a worker took inside the window alone', async () => {
    const { id, itemId } = await overdueWithQueued({ leasedAgoMs: 60_000 });
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect(await itemState(itemId)).toBe('QUEUED');
  });

  it('never touches a packet under the deadline', async () => {
    const { id, itemId } = await overdueWithQueued();
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - (PACKET_PROGRESS_DEADLINE_MS - 60_000)).toISOString(),
      id,
    ]);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect(await itemState(itemId)).toBe('QUEUED');
  });

  it('never withdraws work from a plan waiting for a person to approve it (§16)', async () => {
    const { id, itemId } = await overdueWithQueued();
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
    await updateFragment(fragment!.id, { status: 'PLANNED' });
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - OVERDUE).toISOString(),
      id,
    ]);
    expect((await advanceIdlePackets(10)).map((e) => e.orchestrationId)).not.toContain(id);
    expect(await itemState(itemId)).toBe('QUEUED');
    expect((await getOrchestration(id))!.status).toBe('RESEARCHING');
  });
});
