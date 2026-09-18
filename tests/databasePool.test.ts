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
import { PostgresAdapter, describePoolExhaustion } from '../server/db/adapters/postgres.ts';
import { postgresTestConnection } from './helpers.ts';

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

describe.runIf(postgres)('a real saturated pool reports itself', () => {
  it('names the pool rather than the driver, on both checkout paths', async () => {
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
      let queryError: unknown;
      let transactionError: unknown;

      await adapter.transaction(async () => {
        // Inside the transaction the pool's only client is checked out, so
        // anything reaching for a second one must wait and then give up.
        queryError = await adapter.all('SELECT 1 AS one').then(
          () => undefined,
          (error: unknown) => error,
        );
        transactionError = await adapter.transaction(async () => undefined).then(
          () => undefined,
          (error: unknown) => error,
        );
      });

      // A nested transaction shares its parent's client on purpose, so it must
      // NOT time out; the pool path must.
      expect(transactionError).toBeUndefined();
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
      let release = () => {};
      const holding = adapter.transaction(
        async () => await new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      // Let the holder actually take the client before reaching for a second.
      await new Promise((resolve) => setTimeout(resolve, 50));

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
