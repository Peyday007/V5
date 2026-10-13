/**
 * INF-5: a recompute holds a connection only for what it writes.
 *
 * Production measured `recomputeProject`'s one transaction at 13 holds in two
 * and a half hours, mean about 51 s and max 237 s — one of eight workload
 * connections for the whole derivation, nearly always to conclude that nothing
 * had changed. Called on its own, it now derives outside a transaction and
 * commits each change with its own event; called inside somebody else's
 * transaction, it stays part of that one, as before.
 *
 * What is pinned is the shape rather than a timing: how many transactions a
 * recompute opens, that every change still lands with its event exactly once,
 * and that a caller's transaction still makes the whole recompute atomic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { addDocument, deletePhysicalFile, freshProject, teardown, type TestProject } from './helpers.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';
import { getDocument } from '../server/repos/documents.ts';
import { listEvents } from '../server/repos/events.ts';
import { getLayer, listLayers } from '../server/repos/layers.ts';

let ctx: TestProject;

beforeEach(async () => {
  ctx = await freshProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await teardown();
});

async function countTransactions(work: () => Promise<unknown>): Promise<number> {
  const db = getDb();
  const spy = vi.spyOn(db, 'transaction');
  try {
    await work();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('a recompute that changes nothing opens no transaction of its own', () => {
  it('opens only the dependency refresh, whatever the number of layers', async () => {
    const layers = await listLayers(ctx.project.id);
    expect(layers.length).toBeGreaterThan(3);
    await addDocument(ctx, layers[0]!.name, 'v1');
    await recomputeProject(ctx.project.id); // settle

    // The one left is `refreshProjectDependencies`, which owns its own
    // transaction (dependencies.ts). The recompute used to add one around the
    // whole thing and one per layer inside it.
    expect(await countTransactions(() => recomputeProject(ctx.project.id))).toBe(1);
  });
});

describe('a recompute that does change something', () => {
  it('commits each change with its event, once, and a repeat changes nothing', async () => {
    const layer = (await listLayers(ctx.project.id))[0]!;
    const document = await addDocument(ctx, layer.name, 'v1');
    await recomputeProject(ctx.project.id);
    const statusBefore = (await getLayer(layer.id))!.status;

    deletePhysicalFile(document);
    await recomputeProject(ctx.project.id);
    expect((await getDocument(document.id))!.fileMissing).toBe(true);
    const missingEvents = (await listEvents(ctx.project.id, 500)).filter(
      (e) => e.eventType === 'DOCUMENT_FILE_MISSING' && e.entityId === document.id,
    );
    expect(missingEvents.length).toBe(1);
    const statusAfter = (await getLayer(layer.id))!.status;
    const statusEvents = (await listEvents(ctx.project.id, 500)).filter(
      (e) => e.eventType === 'LAYER_STATUS_CHANGED' && e.layerId === layer.id,
    );
    if (statusAfter !== statusBefore) {
      expect(statusEvents.at(0)?.payload).toMatchObject({ from: statusBefore, to: statusAfter });
    }

    const eventsBefore = (await listEvents(ctx.project.id, 500)).length;
    await recomputeProject(ctx.project.id);
    expect((await listEvents(ctx.project.id, 500)).length).toBe(eventsBefore);
  });

  it("stays atomic inside a caller's transaction: a rollback undoes the whole recompute", async () => {
    const layer = (await listLayers(ctx.project.id))[0]!;
    const document = await addDocument(ctx, layer.name, 'v1');
    await recomputeProject(ctx.project.id);
    deletePhysicalFile(document);
    const eventsBefore = (await listEvents(ctx.project.id, 500)).length;

    await expect(
      getDb().transaction(async () => {
        await recomputeProject(ctx.project.id);
        expect((await getDocument(document.id))!.fileMissing).toBe(true);
        throw new Error('the caller changed its mind');
      }),
    ).rejects.toThrow('the caller changed its mind');

    expect((await getDocument(document.id))!.fileMissing).toBe(false);
    expect((await listEvents(ctx.project.id, 500)).length).toBe(eventsBefore);
  });
});
