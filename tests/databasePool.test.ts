/**
 * What a pool timeout says, and to whom.
 *
 * Six production deploys failed their post-restart verification on `pg-pool`'s
 * `timeout exceeded when trying to connect`, and the first five were debugged
 * as something else, because those eight words name no condition, no numbers,
 * no database and no knob. The two conditions behind them have opposite
 * remedies. These tests pin the distinction and the reading.
 *
 * The pure half runs on both backends, because the branch is arithmetic over a
 * reading and a branch only one dialect can exercise is a branch half-tested.
 * The live half needs a real Postgres and says so rather than pretending.
 */
import { describe, expect, it } from 'vitest';
import {
  PostgresAdapter,
  describeConnectionHeadroom,
  describePoolExhaustion,
  readServerConnectionLimit,
} from '../server/db/adapters/postgres.ts';
import { postgresTestConnection } from './helpers.ts';

/**
 * The other half of the number, and the reason it took eight deploys.
 *
 * `describePoolExhaustion` says what the *pool* was doing. Sizing the ceiling
 * needs what the *server* will allow, and §27 refused to raise it seven times
 * for exactly that reason. The production reading that finally forced this was
 * `2/2 connection(s) in use, 0 idle, 380 caller(s) waiting, ceiling 2`, so the
 * ceiling-of-two case is pinned by name rather than left as a general one.
 *
 * Pure, so both dialects draw every branch.
 */
describe('how much room the pool has above it', () => {
  it('reports the ceiling against what the server will actually give out', () => {
    const message = describeConnectionHeadroom(
      { maxConnections: 100, superuserReserved: 3, backendsInUse: 41 },
      2,
    );

    expect(message).toContain('pool ceiling 2');
    expect(message).toContain('97 usable');
    expect(message).toContain('max_connections 100');
    expect(message).toContain('3 reserved for superusers');
    expect(message).toContain('41 backend(s) connected now');
    expect(message).toContain('BRAIN_DATABASE_POOL_SIZE sets the ceiling');
  });

  it('says a ceiling at the server limit cannot be raised into more connections', () => {
    const message = describeConnectionHeadroom(
      { maxConnections: 20, superuserReserved: 3, backendsInUse: 17 },
      17,
    );

    expect(message).toContain('at or above what the server will give out');
    expect(message).toContain('refused connections rather than more of them');
  });

  /*
   * The direction that matters. A server that would not say must read as
   * *unknown*, never as roomy: §30's rule that an unknown is never a
   * favourable assumption, at the one number somebody would raise a ceiling
   * on. An under-reading here is what talks an operator into exhausting a
   * server's own limit and turning a failed verification into a failed boot.
   */
  it('calls an unreadable limit unknown rather than large', () => {
    const message = describeConnectionHeadroom(
      { maxConnections: null, superuserReserved: null, backendsInUse: null },
      10,
    );

    expect(message).toContain('pool ceiling 10');
    expect(message).toContain('unknown rather than large');
    expect(message).not.toContain('usable');
  });

  it('reports a backend count it could not read as unknown, and still gives the limit', () => {
    const message = describeConnectionHeadroom(
      { maxConnections: 60, superuserReserved: null, backendsInUse: null },
      10,
    );

    expect(message).toContain('60 usable');
    expect(message).toContain('unknown backend(s) connected now');
    expect(message).not.toContain('reserved for superusers');
  });
});

describe('a pool timeout names its condition', () => {
  it('calls a fully checked-out pool the ceiling, and names the knob', () => {
    const message = describePoolExhaustion({ total: 10, idle: 0, waiting: 4, max: 10, timeoutMs: 10_000 });

    expect(message).toContain('database pool');
    expect(message).toContain('10/10 connection(s) in use');
    expect(message).toContain('0 idle');
    expect(message).toContain('4 caller(s) waiting');
    expect(message).toContain('ceiling 10');
    expect(message).toContain('10000ms');
    expect(message).toContain('BRAIN_DATABASE_POOL_SIZE');
    // The reading must not send an operator to look at the network.
    expect(message).toContain('not an unreachable database');
  });

  it('calls a pool below its ceiling the database, and says the ceiling is not it', () => {
    const message = describePoolExhaustion({ total: 2, idle: 1, waiting: 0, max: 10, timeoutMs: 500 });

    expect(message).toContain('would not give this pool a connection');
    expect(message).toContain('1/2 connection(s) in use');
    expect(message).toContain('below its ceiling');
    expect(message).toContain('raising BRAIN_DATABASE_POOL_SIZE would not help');
    expect(message).not.toContain('not an unreachable database');
  });

  it('never repeats the eight words it exists to replace', () => {
    for (const reading of [
      { total: 10, idle: 0, waiting: 1, max: 10, timeoutMs: 1 },
      { total: 0, idle: 0, waiting: 0, max: 10, timeoutMs: 1 },
    ]) {
      expect(describePoolExhaustion(reading)).not.toContain('timeout exceeded when trying to connect');
    }
  });
});

const postgres = postgresTestConnection();

/** Let whatever was just started actually take the client before we reach for one. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Check the pool's only client out and keep it out until told otherwise.
 *
 * Deliberately not awaited: the caller has to run at the top level, because a
 * statement issued inside this transaction's async context would go to *its*
 * client and never ask the pool for one.
 */
function holdTheOnlyClient(adapter: PostgresAdapter): {
  release: () => void;
  holding: Promise<void>;
} {
  let release = (): void => {};
  const holding = adapter.transaction(
    async () =>
      await new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { release: () => release(), holding };
}

describe.runIf(postgres)('a real saturated pool reports itself', () => {
  it('names the pool rather than the driver when a checkout times out', async () => {
    if (!postgres) return;
    // One connection, so holding it is saturation by construction rather than
    // by timing: a race test that passes because the race did not happen is
    // worse than no test.
    const adapter = new PostgresAdapter({
      connectionString: postgres.connectionString,
      schema: postgres.schema,
      max: 1,
      connectionTimeoutMillis: 300,
    });

    try {
      const { release, holding } = holdTheOnlyClient(adapter);
      await settle();

      // From OUTSIDE the transaction, so this reaches `#pool.query` and has to
      // check a client out. An earlier version of this test asked from *inside*
      // the transaction and asserted a timeout, which the adapter's own rule
      // makes impossible — a statement issued inside a transaction goes to that
      // transaction's client and never touches the pool. It never ran on
      // SQLite, because the live half is skipped there.
      const queryError = await adapter.all('SELECT 1 AS one').then(
        () => undefined,
        (error: unknown) => error,
      );

      release();
      await holding;

      expect(queryError).toBeInstanceOf(Error);
      const message = (queryError as Error).message;
      expect(message).toContain('database pool');
      expect(message).toContain('ceiling 1');
      expect(message).toContain('BRAIN_DATABASE_POOL_SIZE');
      expect(message).not.toContain('timeout exceeded when trying to connect');
      // The original stays reachable for anything matching on the driver.
      expect(((queryError as Error).cause as Error | undefined)?.message).toBe(
        'timeout exceeded when trying to connect',
      );
    } finally {
      await adapter.close();
    }
  });

  it('leaves a statement inside a transaction alone, because it never asks the pool', async () => {
    if (!postgres) return;
    // The other half of the rule above, pinned rather than assumed: with the
    // pool's only client checked out by this very transaction, a statement
    // issued inside it still succeeds, and so does a nested transaction.
    const adapter = new PostgresAdapter({
      connectionString: postgres.connectionString,
      schema: postgres.schema,
      max: 1,
      connectionTimeoutMillis: 300,
    });

    try {
      const rows = await adapter.transaction(async () => {
        const inner = await adapter.all<{ one: number }>('SELECT 1 AS one');
        await adapter.transaction(async () => undefined);
        return inner;
      });
      expect(rows[0]?.one).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it("names a checkout `transaction()`'s own connect could not get", async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({
      connectionString: postgres.connectionString,
      schema: postgres.schema,
      max: 1,
      connectionTimeoutMillis: 300,
    });

    try {
      // Started without awaiting, so the second call below runs at the top
      // level rather than inside this one's async context — otherwise it would
      // be a nested transaction sharing this client, which is correct and is
      // not the path under test.
      const { release, holding } = holdTheOnlyClient(adapter);
      await settle();

      const error = await adapter.transaction(async () => undefined).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      release();
      await holding;

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('database pool');
      expect(message).toContain('ceiling 1');
      expect(message).not.toContain('timeout exceeded when trying to connect');
    } finally {
      await adapter.close();
    }
  });
});

/**
 * The reading against a real server, because a describer over a hand-written
 * object proves the sentence and not the query.
 *
 * `current_setting` and `pg_stat_database` are what the boot actually asks,
 * and either could be refused to a non-superuser on a managed Postgres — which
 * is precisely the case the null branch above exists for. This is what says
 * which of the two this repository is in.
 */
describe.runIf(postgres)('the server says what it will allow', () => {
  it('reads a real max_connections and a real backend count', async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({
      connectionString: postgres.connectionString,
      schema: postgres.schema,
      max: 2,
    });
    try {
      const limit = await readServerConnectionLimit(adapter);

      // Not `toBeGreaterThan(0)` on a nullable: a null here would be a genuine
      // finding about this server rather than a failure, and the assertion says
      // which it got rather than accepting either.
      expect(limit.maxConnections).not.toBeNull();
      expect(limit.maxConnections).toBeGreaterThan(0);
      expect(limit.backendsInUse).not.toBeNull();
      // This connection is one of them, so the count cannot be zero.
      expect(limit.backendsInUse).toBeGreaterThan(0);

      const message = describeConnectionHeadroom(limit, 2);
      expect(message).toContain('pool ceiling 2');
      expect(message).toContain(`max_connections ${limit.maxConnections}`);
      expect(message).not.toContain('unknown rather than large');
    } finally {
      await adapter.close();
    }
  });

  /*
   * It must never be able to fail a boot. §18 forbids cloud mode falling back
   * and this is the other half of that rule: a *diagnostic* that threw would
   * stop a Brain whose database had already answered a real query.
   */
  it('answers nulls rather than throwing when the adapter is unusable', async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({
      connectionString: postgres.connectionString,
      schema: postgres.schema,
      max: 1,
    });
    await adapter.close();

    const limit = await readServerConnectionLimit(adapter);
    expect(limit).toEqual({
      maxConnections: null,
      superuserReserved: null,
      backendsInUse: null,
    });
  });
});
