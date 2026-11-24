/**
 * A construction holds a bounded number of the library's designs, whatever
 * the library has accumulated.
 *
 * Production, 2026-11-24 (after #1269): the process still reached its 2.5 GB
 * heap ceiling, minutes after the goal-plan pass started. The largest
 * project's arrangement library held 9,908 constructed designs — 74 MB of
 * design JSON, growing every pass — and every construction (each goal's plan
 * read, the goal-less library pass, the leverage reader, a factory probe over
 * every project) read and parsed all of them in one statement, then shipped
 * every parsed design to the evaluator thread to find the few hundred it
 * composes; writing a pass back read every design's JSON again to compare.
 *
 * What is pinned: no statement that returns a design returns more than
 * `ARRANGEMENT_PAGE` rows, the write-back reads only the rows it could match,
 * and the library still reuses what it holds — the construction is what it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createNode } from '../server/repos/industry.ts';
import { getDb } from '../server/db/database.ts';
import { clearConstructionMemo, constructArrangements, lastConstructionReport } from '../server/services/cash/construct.ts';
import { rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';
import { ARRANGEMENT_PAGE, recordConstructedArrangements } from '../server/repos/monetization.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';

let projectId = '';

beforeEach(async () => {
  forgetKnowledge();
  clearConstructionMemo();
  const fixture = await freshProject();
  const owner = (await createUser({ email: `bound-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId: fixture.project.id, ownerUserId: owner, actorUserId: owner, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  projectId = fixture.project.id;
  const sector = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Veterinary care', origin: 'SEED' });
  await createNode({ projectId, parentId: sector.node.id, kind: 'BUYER_TYPE', name: 'Independent veterinary clinics', origin: 'SEED' });
  await createNode({ projectId, parentId: sector.node.id, kind: 'BOTTLENECK', name: 'After-hours phone coverage', origin: 'SEED' });
  await createNode({ projectId, parentId: sector.node.id, kind: 'FULFILMENT_SOURCE', name: 'Remote answering services', origin: 'SEED' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every statement a piece of work sends, with how many rows came back. */
async function statements(work: () => Promise<unknown>): Promise<Array<{ sql: string; rows: number }>> {
  const db = getDb();
  const seen: Array<{ sql: string; rows: number }> = [];
  const all = db.all.bind(db);
  vi.spyOn(db, 'all').mockImplementation((async (sql: string, params?: unknown[]) => {
    const rows = await all(sql, params as never);
    seen.push({ sql, rows: rows.length });
    return rows;
  }) as typeof db.all);
  await work();
  vi.restoreAllMocks();
  return seen;
}

/** Statements that hand back a stored design. */
const readsDesigns = (sql: string): boolean => /FROM monetization_paths/i.test(sql) && /SELECT \*|design_json/i.test(sql);

const input = () => ({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30 });

/** Designs nothing will compose again, standing in for a library that has grown for weeks. */
async function padLibrary(n: number): Promise<void> {
  const hex = (i: number) => i.toString(16).padStart(32, 'f');
  await recordConstructedArrangements(
    projectId,
    null,
    Array.from({ length: n }, (_, i) => ({
      signature: hex(i),
      legacyKey: `pad:${i}`,
      method: 'SERVICE_FEE' as never,
      title: `Padding ${i}`,
      thesis: null,
      constructionOrigin: 'FORWARD' as const,
      opportunityId: null,
      industryNodeId: null,
      precedentOpportunityId: null,
      inputsDigest: `pad-${i}`,
      designJson: JSON.stringify({ version: 1, arrangement: { signature: hex(i), composedUnder: `pad-under-${i}`, label: 'x'.repeat(2_000) } }),
      positionJson: null,
      positionKey: null,
    })),
  );
}

describe('the arrangement library is read a page at a time', () => {
  it('a construction over a large library holds at most a page of designs, and still reuses what it stored', async () => {
    const first = await constructArrangements(input());
    expect(first.length).toBeGreaterThan(0);
    await rememberArrangements(projectId, null, first);
    await padLibrary(ARRANGEMENT_PAGE * 2 + 7);

    clearConstructionMemo();
    let again: Awaited<ReturnType<typeof constructArrangements>> = [];
    const seen = await statements(async () => {
      again = await constructArrangements(input());
    });
    const designReads = seen.filter((one) => readsDesigns(one.sql));
    expect(designReads.length).toBeGreaterThan(0);
    for (const one of designReads) expect(one.rows).toBeLessThanOrEqual(ARRANGEMENT_PAGE);
    // The whole library was still read — every page — so nothing it holds is missed.
    const paged = designReads.filter((one) => /ORDER BY created_at, id LIMIT/i.test(one.sql));
    const held = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM monetization_paths WHERE project_id = ? AND design_signature IS NOT NULL', [projectId]);
    expect(Number(held?.n)).toBeGreaterThan(ARRANGEMENT_PAGE * 2);
    expect(paged.reduce((sum, one) => sum + one.rows, 0)).toBe(Number(held?.n));
    // What it stored is reused, and the construction is the same one.
    expect(lastConstructionReport(projectId)!.reused).toBeGreaterThan(0);
    expect(again.map((one) => one.signature).sort()).toEqual(first.map((one) => one.signature).sort());
  }, 120_000);

  it('writing a pass back reads only the rows it could match, not the whole library', async () => {
    const first = await constructArrangements(input());
    await padLibrary(ARRANGEMENT_PAGE + 3);
    const stored = first.filter((one) => one.signature && one.inputsDigest);
    const seen = await statements(() => rememberArrangements(projectId, null, first));
    const designReads = seen.filter((one) => readsDesigns(one.sql));
    expect(designReads.length).toBeGreaterThan(0);
    for (const one of designReads) expect(one.rows).toBeLessThanOrEqual(stored.length);
  }, 120_000);
});
