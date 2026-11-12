/**
 * Parking a packet for a person writes once. Re-deriving a packet already
 * parked for the same reason — every pass, and every restart — changes nothing,
 * so an old park is not read as a new one and `completed_at` keeps the moment
 * the packet actually stopped.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, getOrchestration, parkOrchestration } from '../server/repos/research.ts';

async function packet() {
  const fixture = await freshProject();
  const layer = await fixture.layerByName('Discovery Logic');
  const run = await createRun({
    projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION',
    status: 'PLANNED', provider: 'WORKER', prompt: 'park',
  });
  return createOrchestration({
    projectId: fixture.project.id, layerId: layer.id, runId: run.id,
    title: 'Park once', assignment: 'Park once.', provider: 'WORKER', autoApprove: false,
  });
}

describe('parking a packet', () => {
  it('writes once for one reason, and again only when the reason changes', async () => {
    const orchestration = await packet();
    expect(await parkOrchestration(orchestration.id, 'A reason.', { stampCompleted: true })).toBe(true);
    const first = (await getOrchestration(orchestration.id))!;
    expect(first.status).toBe('NEEDS_HUMAN');
    expect(first.failureReason).toBe('A reason.');
    expect(first.completedAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await parkOrchestration(orchestration.id, 'A reason.', { stampCompleted: true })).toBe(false);
    const again = (await getOrchestration(orchestration.id))!;
    expect(again.updatedAt).toBe(first.updatedAt);
    expect(again.completedAt).toBe(first.completedAt);

    expect(await parkOrchestration(orchestration.id, 'Another reason.')).toBe(true);
    const changed = (await getOrchestration(orchestration.id))!;
    expect(changed.failureReason).toBe('Another reason.');
    expect(changed.completedAt).toBe(first.completedAt);
  });

  it('treats a null reason like an empty one, without writing it twice', async () => {
    const orchestration = await packet();
    expect(await parkOrchestration(orchestration.id, null)).toBe(true);
    expect((await getOrchestration(orchestration.id))!.failureReason).toBeNull();
    expect(await parkOrchestration(orchestration.id, null)).toBe(false);
  });
});
