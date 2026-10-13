/**
 * INF-4 and INF-2 against a real Postgres: what a new connection carries
 * before its first statement, and what a slow statement's time was spent on.
 *
 * The session settings used to be sent from the pool's `connect` event without
 * being awaited. pg 8's per-client queue kept them in order by accident and
 * printed a deprecation warning on every new connection — an error in pg 9 —
 * and chaining them in the handler would have let the caller's first statement
 * run between two of them. These tests read the settings *from* the first
 * statement on a new connection, which is the only place the ordering matters.
 *
 * Live only: a SQLite run has no session to configure and says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAdapter } from '../server/db/adapters/postgres.ts';
import {
  asControlPlane,
  checkoutSummary,
  connectionChurnReading,
  resetLatencies,
  statementCosts,
} from '../server/db/infra.ts';
import { postgresTestConnection } from './helpers.ts';

const postgres = postgresTestConnection();

interface Settings {
  statement_timeout: string;
  idle_in_transaction_session_timeout: string;
  client_connection_check_interval: string;
  lock_timeout: string;
}

const READ_SETTINGS = `SELECT current_setting('statement_timeout') AS statement_timeout,
       current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
       current_setting('client_connection_check_interval') AS client_connection_check_interval,
       current_setting('lock_timeout') AS lock_timeout`;

const warnings: string[] = [];
const onWarning = (warning: Error): void => {
  warnings.push(warning.message);
};

beforeEach(() => {
  warnings.length = 0;
  process.on('warning', onWarning);
  resetLatencies();
});

afterEach(() => {
  process.off('warning', onWarning);
});

/** Let any warning emitted on a later tick arrive before it is asserted absent. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe.runIf(postgres)('a new connection is configured before its first statement (INF-4)', () => {
  it('a workload connection: the first statement already runs under all three settings', async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({ connectionString: postgres.connectionString, schema: postgres.schema, max: 8 });
    try {
      const first = await adapter.get<Settings>(READ_SETTINGS);
      expect(first?.statement_timeout).toBe('2min');
      expect(first?.idle_in_transaction_session_timeout).toBe('2min');
      expect(first?.client_connection_check_interval).toBe('10s');
      await settle();
      expect(warnings.filter((w) => /already executing a query/.test(w))).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it('a control connection carries its own, tighter bounds', async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({ connectionString: postgres.connectionString, schema: postgres.schema, max: 8 });
    try {
      const first = await asControlPlane(() => adapter.get<Settings>(READ_SETTINGS));
      expect(first?.statement_timeout).toBe('12s');
      expect(first?.lock_timeout).toBe('5s');
      expect(first?.client_connection_check_interval).toBe('10s');
      // Warming the reserved connections applies the settings too.
      expect(await adapter.warmControlPlane()).toBe(2);
      await settle();
      expect(warnings.filter((w) => /already executing a query/.test(w))).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("a transaction's first statement, on a connection opened for it, sees them as well", async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({ connectionString: postgres.connectionString, schema: postgres.schema, max: 1 });
    try {
      const inside = await adapter.transaction(() => adapter.get<Settings>(READ_SETTINGS));
      expect(inside?.statement_timeout).toBe('2min');
      // Applied once per connection: the next checkout of the same client is
      // not configured again, and still carries them.
      const again = await adapter.get<Settings>(READ_SETTINGS);
      expect(again?.statement_timeout).toBe('2min');
      expect(connectionChurnReading().counts['WORKLOAD:OPENED']).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it('many concurrent first statements on fresh connections are all configured', async () => {
    if (!postgres) return;
    const adapter = new PostgresAdapter({ connectionString: postgres.connectionString, schema: postgres.schema, max: 10 });
    try {
      const rows = await Promise.all(Array.from({ length: 8 }, () => adapter.get<Settings>(READ_SETTINGS)));
      for (const row of rows) expect(row?.statement_timeout).toBe('2min');
      await settle();
      expect(warnings.filter((w) => /already executing a query/.test(w))).toEqual([]);
    } finally {
      await adapter.close();
    }
  });
});

describe.runIf(postgres)("a statement's time is split into the wait for a client and the answer (INF-2)", () => {
  it('a statement queued behind a held connection records the wait, not a slow answer', async () => {
    if (!postgres) return;
    // One connection, held by a transaction: saturation by construction.
    const adapter = new PostgresAdapter({ connectionString: postgres.connectionString, schema: postgres.schema, max: 1 });
    try {
      let release = (): void => {};
      const holding = adapter.transaction(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await settle();
      const queued = adapter.get('SELECT 41 + 1 AS split_probe');
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await holding;
      await queued;

      const probe = statementCosts(50).find((c) => c.key.includes('split_probe'));
      expect(probe?.count).toBe(1);
      expect(probe!.waitMaxMs).toBeGreaterThanOrEqual(200);
      // The server answered at once; the wait is not reported as its time.
      expect(probe!.maxMs).toBeLessThan(200);
      expect(checkoutSummary()['WORKLOAD']?.max ?? 0).toBeGreaterThanOrEqual(200);
    } finally {
      await adapter.close();
    }
  });
});

describe.runIf(postgres)('a floor of workload connections can be kept open (INF-3 knob)', () => {
  const previous = process.env['BRAIN_DATABASE_POOL_MIN'];
  afterEach(() => {
    if (previous === undefined) delete process.env['BRAIN_DATABASE_POOL_MIN'];
    else process.env['BRAIN_DATABASE_POOL_MIN'] = previous;
  });

  async function idleAfterBurst(floor: string | null): Promise<number> {
    if (!postgres) return -1;
    if (floor === null) delete process.env['BRAIN_DATABASE_POOL_MIN'];
    else process.env['BRAIN_DATABASE_POOL_MIN'] = floor;
    const adapter = new PostgresAdapter({
      connectionString: postgres.connectionString,
      schema: postgres.schema,
      max: 8,
      idleTimeoutMillis: 100,
    });
    try {
      await Promise.all(Array.from({ length: 4 }, () => adapter.get('SELECT pg_sleep(0.05)')));
      await new Promise((resolve) => setTimeout(resolve, 600));
      return adapter.poolReadings().workload.total;
    } finally {
      await adapter.close();
    }
  }

  it('idles every connection out by default, as before', async () => {
    expect(await idleAfterBurst(null)).toBe(0);
  });

  it('keeps the floor open when one is set, and closes the rest', async () => {
    expect(await idleAfterBurst('2')).toBe(2);
  });
});
