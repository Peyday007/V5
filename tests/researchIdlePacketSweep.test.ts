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
import { createOrchestration, getOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  advanceIdlePackets,
  concludeUnworkablePackets,
  PACKET_STALL_WINDOW_MS,
} from '../server/services/research/packetRunner.ts';

let projectId = '';
let layerId = '';

beforeEach(async () => {
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
});
