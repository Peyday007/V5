/**
 * RECOVERY.STALLS — "packet idle holding a slot".
 *
 * A live packet with nothing QUEUED or LEASED has nothing left to complete, so
 * nothing calls `advancePacket` on it; if its last advance never happened it is
 * idle for ever. The tick sweep must reach it from rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
import {
  advanceIdlePackets,
  concludeUnworkablePackets,
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
