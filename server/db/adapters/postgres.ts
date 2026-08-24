/**
 * The cloud adapter: Postgres, pooled, with transactions pinned to a client.
 *
 * Three things here are not incidental.
 *
 * A transaction takes its own connection out of the pool and holds it. This is
 * the only correct way to run concurrent transactions against a pool: BEGIN is
 * a property of a session, so two transactions sharing a client would end up
 * inside one another. The client is bound to the async context, so every
 * statement issued while the transaction body runs — from any depth of call —
 * goes to that client, and statements from elsewhere go to a different one and
 * are genuinely outside the transaction.
 *
 * Values come back the way SQLite hands them over. Postgres would otherwise
 * return `bigint` as a string and `numeric` as a string, and the repositories —
 * written once, against one set of expectations — would start seeing "3" where
 * they had always seen 3. The type parsers below are set so that the same row
 * shape arrives from both backends, which is what makes one repository layer
 * over two databases honest rather than merely compiling.
 *
 * Credentials never leave this file's inputs. The connection string is read
 * from the environment on the server, and nothing in a diagnostic, a log line
 * or an API response ever repeats it — `describeConnection` exists so an
 * operator can be told which host they reached without being told the password
 * they reached it with.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import type { Database, RunResult, Row, SqlParam } from '../types.ts';
import { DatabaseConfigurationError } from '../types.ts';
import { toPostgresSql, splitStatements } from '../dialect.ts';
import { childFrame, rootFrame, savepointName, type TransactionFrame } from './transactions.ts';

const { Pool, types } = pg;

/**
 * Make Postgres answer in the same shapes SQLite does.
 *
 * int8 arrives as a string because it can exceed a JS number; every int8 in
 * this schema is a row counter or a byte count, so a number is right and a
 * string would silently break arithmetic. float8 and numeric are read as
 * numbers for the same reason — a confidence of "0.8" is not 0.8.
 */
types.setTypeParser(20, (value: string) => Number(value)); // int8
types.setTypeParser(1700, (value: string) => Number(value)); // numeric
types.setTypeParser(701, (value: string) => Number(value)); // float8

interface TransactionContext extends TransactionFrame {
  client: PoolClient;
}

/** Everything the adapter needs to open a pool, with nothing secret exposed. */
export interface PostgresOptions {
  connectionString: string;
  /** Applied when the URL does not carry its own sslmode. */
  ssl?: boolean;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  applicationName?: string;
}

export class PostgresAdapter implements Database {
  readonly dialect = 'postgres' as const;
  readonly kind = 'postgres' as const;

  #pool: pg.Pool;
  #transactions = new AsyncLocalStorage<TransactionContext>();
  #closed = false;

  constructor(options: PostgresOptions) {
    const config: PoolConfig = {
      connectionString: options.connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      application_name: options.applicationName ?? 'brain',
    };
    // Supabase and most managed Postgres require TLS, and their certificates
    // are signed by roots Node does not ship. Verification is therefore off by
    // default for the pooled connection string — which is what every Supabase
    // client does — and can be demanded explicitly by putting `sslmode=verify-full`
    // in the URL.
    if (options.ssl !== false && !/sslmode=/i.test(options.connectionString)) {
      config.ssl = { rejectUnauthorized: false };
    }
    this.#pool = new Pool(config);
    // A pool that emits an error with no listener takes the process down. An
    // idle client dropped by the far end is ordinary; the pool replaces it.
    this.#pool.on('error', () => undefined);
  }

  /** The client this statement belongs on: the transaction's, or the pool's. */
  async #query<T extends pg.QueryResultRow>(
    sql: string,
    params: SqlParam[] | undefined,
  ): Promise<pg.QueryResult<T>> {
    if (this.#closed) {
      throw new DatabaseConfigurationError('The database connection has been closed.');
    }
    const translated = toPostgresSql(sql);
    const values = normalise(params);
    const context = this.#transactions.getStore();
    if (context) {
      return (await context.client.query<T>(translated.sql, values)) as pg.QueryResult<T>;
    }
    return (await this.#pool.query<T>(translated.sql, values)) as pg.QueryResult<T>;
  }

  /**
   * Run a script for its effect.
   *
   * Postgres will not accept several statements in one parameterised call, so a
   * script is split and run in order. Inside a transaction they share its
   * client and therefore its atomicity; outside one they do not, which is why
   * the migrator always calls this from inside a transaction.
   */
  async exec(sql: string): Promise<void> {
    for (const statement of splitStatements(sql)) {
      await this.#query(statement, undefined);
    }
  }

  async all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
    const result = await this.#query<T & pg.QueryResultRow>(sql, params);
    return result.rows;
  }

  async get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    const result = await this.#query<T & pg.QueryResultRow>(sql, params);
    return result.rows[0];
  }

  async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
    const result = await this.#query<pg.QueryResultRow>(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.#transactions.getStore();
    if (existing) return await this.#nested(existing, fn);

    const client = await this.#pool.connect();
    const context: TransactionContext = { client, ...rootFrame() };
    try {
      await client.query('BEGIN');
      try {
        const result = await this.#transactions.run(context, fn);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  /**
   * A nested transaction, on the same client and serialised with its siblings.
   *
   * Savepoints are a stack here too, so two nested transactions running
   * concurrently inside one parent would release each other's.
   */
  async #nested<T>(parent: TransactionContext, fn: () => Promise<T>): Promise<T> {
    const release = await parent.children.acquire();
    const frame: TransactionContext = { client: parent.client, ...childFrame(parent) };
    const savepoint = savepointName(frame);
    try {
      await parent.client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await this.#transactions.run(frame, fn);
        await parent.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await parent.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await parent.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }
}

/**
 * SQLite accepts a narrow set of JS types and so, here, does Postgres.
 *
 * Booleans become 0/1 because that is what the columns hold in both schemas —
 * the repositories are the only place the two representations meet, and this
 * keeps that true.
 */
function normalise(params: SqlParam[] | undefined): unknown[] {
  if (!params || params.length === 0) return [];
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return Number(value);
    return value;
  });
}

/**
 * A connection string with the secret taken out.
 *
 * Enough for an operator to recognise which database they reached — host, port,
 * database name — and nothing that would let anyone else reach it.
 */
export function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    const port = url.port ? `:${url.port}` : '';
    return `${url.hostname}${port}/${database}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/**
 * Prove the connection works before anything depends on it.
 *
 * "The environment variable is set" is not the same fact as "the database
 * answers", and reporting the first as though it were the second is how a
 * system ends up claiming to be cloud-backed while writing to a laptop. This
 * runs a real statement.
 */
export async function verifyConnection(adapter: Database): Promise<{ serverVersion: string }> {
  const row = await adapter.get<{ version: string }>('SELECT version() AS version');
  if (!row?.version) {
    throw new DatabaseConfigurationError(
      'The Postgres connection opened but did not answer a trivial query.',
    );
  }
  return { serverVersion: row.version };
}
