/**
 * A recompute never reads a run's prompt or result text.
 *
 * Production, 2026-11-10 to 11-14: `SELECT * FROM research_runs WHERE layer_id
 * = $1` was the costliest statement by response in every stalled process —
 * 5–32 s a call against well under a second for anything else under the same
 * event-loop stall — because the state engine materialised every run's prompt,
 * its parsed sections and its result text on every derivation, and used none
 * of them. The garbage kept the heap near its limit and the collector on the
 * CPU; the stalls read as an exhausted database pool. What is pinned is the
 * shape: no statement a recompute issues against `research_runs` selects the
 * text columns, and the derived state is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { addDocument, freshProject, teardown, type TestProject } from './helpers.ts';
import { computeLayerState, recomputeProject, recomputeRunReadiness } from '../server/services/stateEngine.ts';
import { createRun, getRun } from '../server/repos/runs.ts';
import { listLayers } from '../server/repos/layers.ts';

let ctx: TestProject;

beforeEach(async () => {
  ctx = await freshProject();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await teardown();
});

async function runStatements(work: () => Promise<unknown>): Promise<string[]> {
  const db = getDb();
  const seen: string[] = [];
  const all = db.all.bind(db);
  vi.spyOn(db, 'all').mockImplementation((async (sql: string, params?: unknown[]) => {
    if (/research_runs/i.test(sql)) seen.push(sql);
    return await all(sql, params as never);
  }) as typeof db.all);
  await work();
  return seen;
}

describe('the state engine reads runs without their text', () => {
  it('selects no prompt, sections or result text, and still sees a running synthesis', async () => {
    const layer = (await listLayers(ctx.project.id))[0]!;
    await addDocument(ctx, layer.name, 'v1');
    const run = await createRun({
      projectId: ctx.project.id,
      layerId: layer.id,
      runType: 'SYNTHESIS',
      status: 'RUNNING',
      prompt: 'x'.repeat(50_000),
      targetVersion: 'v1S',
    });

    const statements = await runStatements(() => recomputeProject(ctx.project.id));
    // The two reads that ran on every derivation and every recompute: a layer's
    // runs, and the project's runs for readiness. (The open-runs read the planner
    // and the local snapshot use stays as it was: it returns only open runs.)
    const layerReads = statements.filter((sql) => /WHERE\s+layer_id\s*=/i.test(sql));
    const projectReads = statements.filter((sql) => /WHERE\s+project_id\s*=\s*\?\s+(AND\s+status\s+IN\s+\(\?|ORDER)/i.test(sql));
    expect(layerReads.length).toBeGreaterThan(0);
    expect(projectReads.length).toBeGreaterThan(0);
    for (const sql of [...layerReads, ...projectReads]) {
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/\bprompt\b|prompt_sections|result_text/i);
    }

    // The derivation still sees the run it needs: a synthesis in flight.
    expect((await computeLayerState(layer.id)).status).toBe('SYNTHESIS_RUNNING');
    // And the run itself keeps its prompt; only the read was narrowed.
    expect((await getRun(run.id))!.prompt).toHaveLength(50_000);
  });

  it('readiness reads only runs that have not started', async () => {
    const layer = (await listLayers(ctx.project.id))[0]!;
    await createRun({ projectId: ctx.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'COMPLETE', prompt: 'done' });
    const statements = await runStatements(() => recomputeRunReadiness(ctx.project.id));
    expect(statements.some((sql) => /status IN/i.test(sql))).toBe(true);
    for (const sql of statements) expect(sql).not.toMatch(/SELECT\s+\*/i);
  });
});
