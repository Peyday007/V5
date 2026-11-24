/**
 * A recompute and a plan hold a bounded number of dependency rows, whatever
 * the project has accumulated.
 *
 * Production, 2026-11-24: the app ran out of its 2.5 GB heap every 15–22
 * minutes (exit 134, 130 restarts in 72 h). Its largest project held 216,844
 * run dependencies — 110 automatic redos waiting BLOCKED, each carrying its
 * layer's ~2,190 documents as a packet and a ~1 MB prompt — and every
 * recompute read all of them in one statement, once for run readiness and
 * again for every layer with an open run, while `buildPlan` derived every
 * layer at once and read every open run's prompt. On that shape one plan
 * peaked near 2 GB of heap and three concurrent plans near 4 GB; read a
 * bounded group of runs at a time, one plan stays near 100 MB.
 *
 * What is pinned: no statement against `dependencies` returns more than
 * `RUN_DEPENDENCY_CHUNK` runs' rows, the drift check returns at most one row,
 * the plan reads no run text — and the derived state is what it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';
import { buildPlan } from '../server/services/planner.ts';
import { createRun, getRun } from '../server/repos/runs.ts';
import { listLayers } from '../server/repos/layers.ts';
import { dependenciesDrifted, RUN_DEPENDENCY_CHUNK } from '../server/repos/dependencies.ts';
import { nowIso } from '../server/repos/util.ts';

let ctx: TestProject;

beforeEach(async () => {
  ctx = await freshProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await teardown();
});

/** Every statement a piece of work sends, with how many rows came back. */
async function statements(work: () => Promise<unknown>): Promise<Array<{ sql: string; rows: number }>> {
  const db = getDb();
  const seen: Array<{ sql: string; rows: number }> = [];
  const all = db.all.bind(db);
  const get = db.get.bind(db);
  vi.spyOn(db, 'all').mockImplementation((async (sql: string, params?: unknown[]) => {
    const rows = await all(sql, params as never);
    seen.push({ sql, rows: rows.length });
    return rows;
  }) as typeof db.all);
  vi.spyOn(db, 'get').mockImplementation((async (sql: string, params?: unknown[]) => {
    const row = await get(sql, params as never);
    seen.push({ sql, rows: row ? 1 : 0 });
    return row;
  }) as typeof db.get);
  await work();
  vi.restoreAllMocks();
  return seen;
}

const PACKET = 12;
const WAITING = 3 * RUN_DEPENDENCY_CHUNK + 1;

describe('a project with many waiting runs carrying wide packets', () => {
  it('is recomputed and planned a bounded group of runs at a time, with the same derived state', async () => {
    const layer = (await listLayers(ctx.project.id))[0]!;
    const present = await addDocument(ctx, layer.name, 'v1');
    const db = getDb();
    const insert = async (runId: string, names: string[]) => {
      for (const [i, name] of names.entries()) {
        await db.run(
          `INSERT INTO dependencies (id, project_id, dependent_run_id, required_document_id, required_canonical_name, required_layer_id, dependency_type, required, notes, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 'SOURCE_PACKET', 1, NULL, ?)`,
          [`dep_${runId}_${i}`, ctx.project.id, runId, name, layer.id, nowIso()],
        );
      }
    };

    // Waiting redos whose packets name documents that do not exist: they stay BLOCKED.
    const blocked: string[] = [];
    for (let r = 0; r < WAITING; r++) {
      const run = await createRun({ projectId: ctx.project.id, layerId: layer.id, runType: 'REDO', status: 'BLOCKED', prompt: 'p'.repeat(20_000), targetVersion: `v1R${r}` });
      await insert(run.id, Array.from({ length: PACKET }, (_, i) => `${layer.name} — source ${r}.${i} that was never produced`));
      blocked.push(run.id);
    }
    // One waiting run whose whole packet is present: the recompute releases it.
    const releasable = await createRun({ projectId: ctx.project.id, layerId: layer.id, runType: 'REDO', status: 'BLOCKED', prompt: 'r', targetVersion: 'v1RR' });
    await insert(releasable.id, [present.canonicalName]);

    const recompute = await statements(() => recomputeProject(ctx.project.id));
    const plan = await statements(() => buildPlan(ctx.project.id));

    const dependencyReads = [...recompute, ...plan].filter((one) => /\bFROM\s+dependencies\b/i.test(one.sql));
    expect(dependencyReads.length).toBeGreaterThan(0);
    for (const one of dependencyReads) {
      // Never the project's every run dependency in one statement.
      expect(one.sql).not.toMatch(/WHERE\s+project_id\s*=\s*\?\s+AND\s+dependent_run_id\s+IS\s+NOT\s+NULL/i);
      expect(one.rows).toBeLessThanOrEqual(RUN_DEPENDENCY_CHUNK * PACKET);
    }
    // The whole project's rows would have come back at once before.
    expect(WAITING * PACKET).toBeGreaterThan(RUN_DEPENDENCY_CHUNK * PACKET);

    // The plan reads open runs without their prompt, sections, attachments or result.
    for (const one of plan.filter((s) => /\bFROM\s+research_runs\b/i.test(s.sql))) {
      expect(one.sql).not.toMatch(/SELECT\s+\*/i);
      expect(one.sql).not.toMatch(/\bprompt\b|prompt_sections|result_text|required_attachments/i);
    }

    // The same state as before the bound: the missing packets keep their runs blocked,
    // the present one is released, and the plan sees the layer's open work.
    for (const id of blocked) expect((await getRun(id))!.status).toBe('BLOCKED');
    expect((await getRun(releasable.id))!.status).toBe('READY');
    const result = await buildPlan(ctx.project.id);
    expect(result.layers.some((one) => one.layerId === layer.id)).toBe(true);
  });

  it('asks whether any link drifted with one row at most, and still sees a drift', async () => {
    const layer = (await listLayers(ctx.project.id))[0]!;
    const run = await createRun({ projectId: ctx.project.id, layerId: layer.id, runType: 'REDO', status: 'BLOCKED', prompt: 'p', targetVersion: 'v1R' });
    const db = getDb();
    for (let i = 0; i < 40; i++) {
      await db.run(
        `INSERT INTO dependencies (id, project_id, dependent_run_id, required_document_id, required_canonical_name, required_layer_id, dependency_type, required, notes, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, 'SOURCE_PACKET', 1, NULL, ?)`,
        [`dep_d_${i}`, ctx.project.id, run.id, `${layer.name} — absent ${i}`, layer.id, nowIso()],
      );
    }
    // Nothing names a present document and nothing links to one: no drift.
    let drifted = false;
    const quiet = await statements(async () => {
      drifted = await dependenciesDrifted(ctx.project.id);
    });
    expect(drifted).toBe(false);
    for (const one of quiet) expect(one.rows).toBeLessThanOrEqual(1);

    // A document arrives under one of those names: the link has drifted, and the read is still one row.
    const document = await addDocument(ctx, layer.name, 'v1');
    await db.run('UPDATE dependencies SET required_canonical_name = ? WHERE id = ?', [document.canonicalName, 'dep_d_7']);
    const moved = await statements(async () => {
      drifted = await dependenciesDrifted(ctx.project.id);
    });
    expect(drifted).toBe(true);
    for (const one of moved) expect(one.rows).toBeLessThanOrEqual(1);

    // And the recompute re-links it, after which nothing has drifted.
    await recomputeProject(ctx.project.id);
    const linked = await db.get<{ required_document_id: string | null }>('SELECT required_document_id FROM dependencies WHERE id = ?', ['dep_d_7']);
    expect(linked?.required_document_id).toBe(document.id);
    expect(await dependenciesDrifted(ctx.project.id)).toBe(false);
  });
});
