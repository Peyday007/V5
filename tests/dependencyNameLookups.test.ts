/**
 * One recompute reads each canonical name once (§89). Production, 2026-11-05:
 * `findDocumentByCanonicalName` ran ~14 times a second, the database's largest
 * cost by ~700×, because every run's and document's dependency check read the
 * same names again.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { checkCanonicalNames, withNameLookups } from '../server/services/dependencies.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';

async function countingNameLookups<T>(fn: () => Promise<T>): Promise<{ result: T; lookups: number }> {
  const db = getDb() as unknown as Record<'get', (sql: string, ...rest: unknown[]) => unknown>;
  const original = db.get;
  let lookups = 0;
  db.get = (sql: string, ...rest: unknown[]) => {
    if (sql.includes('FROM documents WHERE project_id = ?') && sql.includes('canonical_name')) lookups += 1;
    return original.call(db, sql, ...rest);
  };
  try {
    return { result: await fn(), lookups };
  } finally {
    db.get = original;
  }
}

describe('a recompute reads each canonical name once', () => {
  it('reads a name once inside a pass, and every time outside one', async () => {
    const { project } = await freshProject();
    const names = ['Foundation Report v1', 'Market Map v2'];
    const outside = await countingNameLookups(async () => {
      await checkCanonicalNames(project.id, names);
      await checkCanonicalNames(project.id, names);
    });
    expect(outside.lookups).toBe(4);
    const inside = await countingNameLookups(() =>
      withNameLookups(async () => {
        await checkCanonicalNames(project.id, names);
        // Case differs; SQLite's NOCASE and Postgres's `nocase` read the same row.
        await checkCanonicalNames(project.id, ['foundation report v1', 'MARKET MAP V2']);
      }),
    );
    expect(inside.lookups).toBe(2);
    expect(inside.result).toBeUndefined();
  });

  it('a project recompute still answers, inside one pass', async () => {
    const { project } = await freshProject();
    const snapshots = await recomputeProject(project.id);
    expect(snapshots.length).toBeGreaterThan(0);
  });
});
