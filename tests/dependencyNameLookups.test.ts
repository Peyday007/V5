/**
 * One recompute reads each canonical name once (§89). Production, 2026-11-05:
 * `findDocumentByCanonicalName` ran ~14 times a second, the database's largest
 * cost by ~700×, because every run's and document's dependency check read the
 * same names again.
 */
import { describe, expect, it } from 'vitest';
import { addDocument, freshProject } from './helpers.ts';
import { findDocumentByCanonicalName, findDocumentsByCanonicalNames } from '../server/repos/documents.ts';
import { getDb } from '../server/db/database.ts';
import { checkCanonicalNames, withNameLookups } from '../server/services/dependencies.ts';
import { recomputeProject } from '../server/services/stateEngine.ts';

async function countingNameLookups<T>(fn: () => Promise<T>): Promise<{ result: T; lookups: number }> {
  const db = getDb() as unknown as Record<'get' | 'all', (sql: string, ...rest: unknown[]) => unknown>;
  const originals = { get: db.get, all: db.all };
  let lookups = 0;
  for (const method of ['get', 'all'] as const) {
    db[method] = (sql: string, ...rest: unknown[]) => {
      if (sql.includes('FROM documents WHERE project_id = ?') && sql.includes('canonical_name')) lookups += 1;
      return originals[method].call(db, sql, ...rest);
    };
  }
  try {
    return { result: await fn(), lookups };
  } finally {
    db.get = originals.get;
    db.all = originals.all;
  }
}

describe('a recompute reads each canonical name once', () => {
  it('reads a check\u2019s names in one statement, once inside a pass, and every check outside one', async () => {
    const { project } = await freshProject();
    const names = ['Foundation Report v1', 'Market Map v2'];
    const outside = await countingNameLookups(async () => {
      await checkCanonicalNames(project.id, names);
      await checkCanonicalNames(project.id, names);
    });
    expect(outside.lookups).toBe(2);
    const inside = await countingNameLookups(() =>
      withNameLookups(async () => {
        await checkCanonicalNames(project.id, names);
        // Case differs; SQLite's NOCASE and Postgres's `nocase` read the same row.
        await checkCanonicalNames(project.id, ['foundation report v1', 'MARKET MAP V2']);
      }),
    );
    expect(inside.lookups).toBe(1);
    expect(inside.result).toBeUndefined();
  });

  it('a project recompute still answers, inside one pass', async () => {
    const { project } = await freshProject();
    const snapshots = await recomputeProject(project.id);
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('a batch gives the single-name lookup\u2019s answer for every name, in any case', async () => {
    const fixture = await freshProject();
    for (const version of ['v1', 'v1B', 'v1C']) await addDocument(fixture, 'Decision Routing Rules', version);
    const names = [
      'Decision Routing Rules v1',
      'decision routing rules V1B',
      'DECISION ROUTING RULES v1c',
      'Decision Routing Rules v1G',
    ];
    const batch = await findDocumentsByCanonicalNames(fixture.project.id, names);
    for (const name of names) {
      const single = await findDocumentByCanonicalName(fixture.project.id, name);
      expect(batch.get(name)?.id ?? null).toBe(single?.id ?? null);
    }
    expect(batch.get('Decision Routing Rules v1')).not.toBeNull();
    expect(batch.get('Decision Routing Rules v1G')).toBeNull();
  });
});
