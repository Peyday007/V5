import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createSearchMethod, getSearchMethod, listMethodComparisons, setMethodTrust } from '../server/repos/searchMethods.ts';
import { getDb } from '../server/db/database.ts';
import {
  compareMethods, methodMetrics, mayMove, provenMethods, rankByPrecision, recordRunAndSettle, retireMethod,
} from '../server/services/research/searchMethods/index.ts';
import type { SearchReader } from '../server/domain/searchIntelligence.ts';

const reader: SearchReader = { projectIds: [], userId: null };
const make = (key: string, subjectId: string | null = 'sub1') =>
  createSearchMethod({ scope: 'GENERAL', methodKey: key, subjectId, finds: 'x', sources: ['s'], checkProcedure: 'check' });
const run = (methodId: string, confirmed: number, rejected: number, surfaced = confirmed + rejected) =>
  recordRunAndSettle(reader, { methodId, executor: 'CODE', outcome: 'FOUND', examined: 100, surfaced, confirmed, rejected });

describe('search method trust', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('cannot go from PROPOSED to PROVEN, and a run with nothing verified moves nothing', async () => {
    expect(mayMove('PROPOSED', 'PROVEN')).toBe(false);
    const m = await make('a');
    const r = await run(m.id, 0, 0, 500);
    expect(r?.method.trustState).toBe('PROPOSED');
    expect(await provenMethods(reader)).toHaveLength(0);
  });

  it('moves PROPOSED -> TESTING -> PROVEN only on verified results with enough precision', async () => {
    const m = await make('b');
    expect((await run(m.id, 3, 1))?.method.trustState).toBe('TESTING');
    expect((await run(m.id, 6, 1))?.method.trustState).toBe('PROVEN');
    expect((await provenMethods(reader)).map((x) => x.id)).toEqual([m.id]);
  });

  it('keeps a high-volume, low-precision method out of PROVEN, and demotes one that falls', async () => {
    const noisy = await make('noisy');
    const r = await run(noisy.id, 2, 30, 5000);
    expect(r?.method.trustState).toBe('TESTING');
    expect((await run(noisy.id, 1, 10))?.method.trustState).toBe('DEMOTED');
  });

  it('does not let a stored PROVEN state stand without runs behind it', async () => {
    const m = await make('forged');
    await setMethodTrust(m.id, 'PROPOSED', 'PROVEN', 'written some other way');
    expect(await provenMethods(reader)).toHaveLength(0);
    expect((await getSearchMethod(reader, m.id))?.trustState).toBe('PROVEN');
  });

  it('retires a method once, and refuses a run against a method the reader cannot see', async () => {
    const m = await make('c');
    expect(await retireMethod(reader, m.id, 'obsolete')).toBe(true);
    expect(await retireMethod(reader, m.id, 'again')).toBe(false);
    expect(await recordRunAndSettle(reader, { methodId: 'nope', executor: 'CODE', outcome: 'FOUND' })).toBeNull();
  });
});

describe('ranking and comparison', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('ranks a low-volume high-precision method above a high-volume low-precision one', () => {
    const loud = { id: 'loud', metrics: methodMetrics([{ surfaced: 1000, confirmed: 20, rejected: 180 } as never]) };
    const quiet = { id: 'quiet', metrics: methodMetrics([{ surfaced: 5, confirmed: 4, rejected: 1 } as never]) };
    const unknown = { id: 'unknown', metrics: methodMetrics([]) };
    expect(rankByPrecision([unknown, loud, quiet]).map((x) => x.id)).toEqual(['quiet', 'loud', 'unknown']);
  });

  it('compares two methods on the same data and refuses anything outside it', async () => {
    const a = await make('A');
    const b = await make('B');
    const items = ['1', '2', '3', '4', '5', '6'];
    const ok = await compareMethods(reader, {
      subjectId: 'sub1',
      items,
      results: {
        [a.id]: { surfaced: items, confirmed: ['1'], rejected: ['2', '3', '4', '5', '6'] },
        [b.id]: { surfaced: ['1', '2'], confirmed: ['1', '2'], rejected: [] },
      },
    });
    expect(ok.ok && ok.comparison.ranking.map((x) => x.methodId)).toEqual([b.id, a.id]);
    const outside = await compareMethods(reader, {
      subjectId: 'sub1', items,
      results: { [a.id]: { surfaced: ['9'], confirmed: [], rejected: [] }, [b.id]: { surfaced: [], confirmed: [], rejected: [] } },
    });
    expect(outside.ok).toBe(false);
    const other = await make('C', 'sub2');
    const mixed = await compareMethods(reader, {
      subjectId: 'sub1', items,
      results: { [a.id]: { surfaced: [], confirmed: [], rejected: [] }, [other.id]: { surfaced: [], confirmed: [], rejected: [] } },
    });
    expect(mixed.ok).toBe(false);
  });

  it('records an accepted comparison with each method\'s rank and metrics, and a refused one writes nothing', async () => {
    const a = await make('RA');
    const b = await make('RB');
    const items = ['1', '2', '3', '4', '5', '6'];
    const ok = await compareMethods(reader, {
      subjectId: 'sub1',
      items,
      results: {
        [a.id]: { surfaced: items, confirmed: ['1'], rejected: ['2', '3', '4', '5', '6'] },
        [b.id]: { surfaced: ['1', '2'], confirmed: ['1', '2'], rejected: [] },
      },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;

    const stored = await listMethodComparisons(reader, { subjectId: 'sub1' });
    expect(stored).toHaveLength(1);
    const c = stored[0]!;
    expect(c.id).toBe(ok.comparison.id);
    expect(c.scope).toBe('GENERAL');
    expect(c.items).toBe(6);
    expect(c.itemRefs.sort()).toEqual(items);
    expect(c.decidedBy).toBe(ok.comparison.decidedBy);
    expect(c.entries).toEqual([
      { methodId: b.id, rank: 1, examined: 6, surfaced: 2, confirmed: 2, rejected: 0, verified: 2, precision: 1 },
      { methodId: a.id, rank: 2, examined: 6, surfaced: 6, confirmed: 1, rejected: 5, verified: 6, precision: 1 / 6 },
    ]);
    expect((await listMethodComparisons(reader, { methodId: a.id })).map((x) => x.id)).toEqual([c.id]);

    // The rows are on disk, not only in the returned value.
    const rows = await getDb().all<{ method_id: string; rank_order: number }>(
      'SELECT method_id, rank_order FROM search_method_comparison_entries WHERE comparison_id = ? ORDER BY rank_order',
      [c.id],
    );
    expect(rows.map((r) => [r.method_id, Number(r.rank_order)])).toEqual([[b.id, 1], [a.id, 2]]);

    const refused = await compareMethods(reader, {
      subjectId: 'sub1', items,
      results: { [a.id]: { surfaced: ['9'], confirmed: [], rejected: [] }, [b.id]: { surfaced: [], confirmed: [], rejected: [] } },
    });
    expect(refused.ok).toBe(false);
    expect(await listMethodComparisons(reader, { subjectId: 'sub1' })).toHaveLength(1);
  });

  it('records a project\'s comparison in that project, invisible to another project', async () => {
    const a = await make('PA');
    const b = await make('PB');
    const mine: SearchReader = { projectIds: ['prj_mine'], userId: null };
    const ok = await compareMethods(mine, {
      subjectId: 'sub1',
      items: ['x', 'y'],
      results: {
        [a.id]: { surfaced: ['x'], confirmed: ['x'], rejected: [] },
        [b.id]: { surfaced: ['x', 'y'], confirmed: ['x'], rejected: ['y'] },
      },
    });
    expect(ok.ok && ok.comparison.scope).toEqual({ scope: 'PROJECT', projectId: 'prj_mine', userId: null });
    expect(await listMethodComparisons(mine)).toHaveLength(1);
    expect(await listMethodComparisons({ projectIds: ['prj_other'], userId: null })).toHaveLength(0);
    expect(await listMethodComparisons(reader)).toHaveLength(0);

    const elsewhere = await compareMethods(mine, {
      subjectId: 'sub1', items: ['x'], scope: { scope: 'PROJECT', projectId: 'prj_other' },
      results: { [a.id]: { surfaced: [], confirmed: [], rejected: [] }, [b.id]: { surfaced: [], confirmed: [], rejected: [] } },
    });
    expect(elsewhere.ok).toBe(false);
    expect(await listMethodComparisons({ projectIds: ['prj_other'], userId: null })).toHaveLength(0);
  });
});
