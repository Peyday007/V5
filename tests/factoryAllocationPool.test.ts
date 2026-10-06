/**
 * `factory allocation` with one database connection.
 *
 * Operator doors run with `BRAIN_DATABASE_POOL_SIZE=1`, and a read that held
 * the only connection while waiting on a second query it issued would hang
 * until the pool's checkout timeout. Measured here against a real Postgres,
 * because SQLite has one connection by construction and could not tell.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, postgresTestConnection, teardown, type TestProject } from './helpers.ts';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { factoryAllocation } from '../server/services/factory/allocation.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';

let fixture: TestProject;
const pg = postgresTestConnection();

beforeEach(async () => {
  fixture = await freshProject();
});
afterEach(async () => {
  await teardown();
});

describe.skipIf(!pg)('one connection', () => {
  it('answers the allocation reading without waiting on itself', async () => {
    await closeDatabase();
    await initDatabase({
      config: { provider: 'postgres', connectionString: pg!.connectionString, poolSize: 1, schema: pg!.schema },
    });
    const started = Date.now();
    await fleetSnapshot();
    const view = await factoryAllocation({ projectId: fixture.project.id, canReport: false });
    expect(Array.isArray(view.repositories)).toBe(true);
    // Well inside the pool's 10s checkout timeout: nothing queued behind itself.
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});
