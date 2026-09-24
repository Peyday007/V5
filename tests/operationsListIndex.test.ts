import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';

/*
 * Deploy 346, 10:51:28Z: `canceling statement due to statement timeout` in
 *   SELECT * FROM idempotency_operations WHERE project_id = $1
 *    ORDER BY created_at DESC, id LIMIT 100
 * — the operations inspection route, which answered 500 in both 345 and 346.
 * The only project index was (project_id, state), so every call read and
 * sorted the project's whole history, and the verification project gains
 * operations on every deploy. The order must be served by an index, so the
 * limit stops the read rather than trimming a sort.
 */
beforeEach(async () => {
  await freshProject();
});

const POSTGRES = Boolean(process.env['BRAIN_TEST_DATABASE_URL']);

describe('listing a project\'s operations', () => {
  it.skipIf(POSTGRES)('is served in order by an index rather than a sort over the whole history', async () => {
    const plan = await getDb().all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT * FROM idempotency_operations WHERE project_id = ?
        ORDER BY created_at DESC, id LIMIT 100`,
      ['prj_x'],
    );
    const text = plan.map((row) => row.detail).join(' | ');
    expect(text).toMatch(/idx_idempotency_operations_project_created/);
    expect(text).not.toMatch(/TEMP B-TREE/);
  });

  it.skipIf(!POSTGRES)('has the same index on the backend production runs', async () => {
    const rows = await getDb().all<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_idempotency_operations_project_created'`,
      [],
    );
    expect(rows[0]?.indexdef).toMatch(/\(project_id, created_at DESC, id\)/);
  });
});
