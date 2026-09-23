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

/**
 * The sentence `pg-pool` throws when a checkout waits past its timeout.
 *
 * Matched on the message because the driver attaches no code to it, so there is
 * nothing else to match on. A miss degrades to the original error rather than
 * to a wrong diagnosis.
 */
const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/** What the pool was holding at the instant a checkout gave up. */
export interface PoolReading {
  /** Connections the pool currently owns, checked out or idle. */
  total: number;
  /** Of those, the ones sitting unused. */
  idle: number;
  /** Callers queued behind them. */
  waiting: number;
  /** The ceiling this pool was opened with. */
  max: number;
  /** How long a checkout was allowed to wait. */
  timeoutMs: number;
}

/**
 * Say which condition a pool timeout actually was, with the numbers.
 *
 * `pg-pool` throws one sentence for two conditions that have nothing in common:
 * a pool whose clients are every one of them checked out, and a server that
 * would not hand out a new connection. The remedies are opposite — the first is
 * a ceiling or a slow query holding a client, the second is the database or the
 * network — and the message distinguishes neither, names no numbers, says
 * nothing about the database at all, and names no knob. Six production deploys
 * have now failed their post-restart verification on those eight words, and the
 * first five were debugged as something else.
 *
 * The counts are read at the moment of failure, so this is a measurement rather
 * than an account of what the pool was probably doing. It is pure so that both
 * dialects can test the branch it draws; §23's own rule, one module along — a
 * reading is worth more than a ceiling nobody has observed.
 */
export function describePoolExhaustion(reading: PoolReading): string {
  const { total, idle, waiting, max, timeoutMs } = reading;
  const held = total - idle;
  const saturated = total >= max && idle === 0;
  const state = `${held}/${total} connection(s) in use, ${idle} idle, ${waiting} caller(s) waiting, ceiling ${max}`;
  if (saturated) {
    return (
      `The database pool had no free connection within ${timeoutMs}ms: ${state}. ` +
      'Every connection was checked out, so this is the ceiling or something holding one too long, ' +
      'not an unreachable database. BRAIN_DATABASE_POOL_SIZE sets the ceiling.'
    );
  }
  return (
    `The database would not give this pool a connection within ${timeoutMs}ms: ${state}. ` +
    'The pool was below its ceiling, so this is the database or the network rather than the ceiling: ' +
    'raising BRAIN_DATABASE_POOL_SIZE would not help.'
  );
}

/**
 * The pooler in front of the database saying no, which is a third and a
 * fourth condition and not the two above.
 *
 * `describePoolExhaustion` answers *this pool could not hand me one of its
 * own connections*. Supabase's session-mode pooler has its own, lower client
 * limit, shared with every other client of that pooler — so a process opening
 * its first connection can be refused outright, before any pool of its own
 * exists to be exhausted. It arrives as `XX000 (EMAXCONNSESSION)`, and a
 * script that prints the driver's error object shows twenty lines of
 * `undefined` fields and never names the remedy.
 *
 * **`ECHECKOUTTIMEOUT` is the fourth, and it went unrecognised until it had
 * failed a release gate and two operator reads in one morning.** Deploy 323's
 * post-restart hosted verification died on
 * `(ECHECKOUTTIMEOUT) unable to check out connection from the pool after
 * 15000ms in Session mode` after getting as far as reading 434 documents and
 * handing a worker its assignment. Neither diagnosis fired: Brain's own pool
 * had not timed out, so `describePoolExhaustion` was never reached, and the
 * marker is not `EMAXCONNSESSION`, so this function returned null. **A
 * mechanism that does not reach the condition it exists for is not a
 * mechanism**, and what a reader got instead was the driver's bare string —
 * which is the exact thing §27 added these sentences to stop.
 *
 * **An earlier version of this comment said the two console reads dispatched
 * twenty-five minutes later "failed the same way". They did not, and the
 * difference is the whole reason one fix here was not enough.** They failed
 * in `openCloud`'s verification query, before any statement, with
 * `Connection terminated due to connection timeout` wrapped in *"could not
 * reach"* — a message carrying no pooler marker at all, which this function
 * cannot match and should not try to. Their diagnosis is `hintFor` in
 * `server/db/database.ts`, which had no branch for a timeout either. Same
 * underlying scarcity, two paths, two sentences; widening only this one would
 * have left the condition actually seen on the console still unexplained.
 *
 * The two pooler conditions are named apart rather than folded together,
 * because they say different things about where the limit is. `EMAXCONNSESSION`
 * is *too many clients of the pooler*: the client was refused outright.
 * `ECHECKOUTTIMEOUT` is the pooler accepting the client and then failing to
 * get **it** a database connection inside its own timeout, so the binding
 * number is the pooler's upstream pool or the database's own capacity, and a
 * database that has simply gone slow produces it too.
 *
 * What they agree on is the sentence that matters to whoever is reading, and
 * it is the opposite of the other two: raising `BRAIN_DATABASE_POOL_SIZE`
 * makes both *worse*, because the binding number is not this application's.
 *
 * **The codes are matched differently, and deliberately.** `EMAXCONNSESSION`
 * was observed with `XX000` and keeps that pair, because `XX000` alone is
 * generic and the pair is what makes it narrow. `ECHECKOUTTIMEOUT` was
 * observed only through a harness that printed the message and no fields, so
 * **its code is not established and is therefore not required** — asserting
 * `XX000` for it would be a guess wearing a matcher. The marker carries the
 * specificity in both cases: nothing else in this system emits the literal
 * `(ECHECKOUTTIMEOUT)`, so keying on it alone is as narrow as the pair beside
 * it rather than looser. The failure mode that matters is still naming a
 * condition that is not this one — §29's warning that cries wolf, at a
 * connection string.
 *
 * Pure, like its neighbour, and it reports rather than decides: nothing acts
 * on this string.
 */
export function describePoolerRefusal(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : '';
  const shared =
    'Raising BRAIN_DATABASE_POOL_SIZE would make this worse rather than better; what clears ' +
    'it is fewer concurrent clients, or waiting for stale sessions to age out.';

  if (code === 'XX000' && text.includes('EMAXCONNSESSION')) {
    return (
      'The connection pooler in front of the database refused a new client: ' +
      `${text.trim()}. That limit is the pooler's rather than this application's, and it is ` +
      'shared with every other client of it — the running app holds its own connections, and ' +
      `each operator script opens a pool of its own beside them. ${shared}`
    );
  }

  if (text.includes('ECHECKOUTTIMEOUT')) {
    return (
      'The connection pooler in front of the database accepted this client and then could not ' +
      `get it a database connection in time: ${text.trim()}. That timeout is the pooler's ` +
      "rather than this application's, so it is the pooler's upstream pool or the database " +
      'itself — a database that has gone slow produces this too, and so does every other ' +
      `client of that pooler holding its connections. ${shared}`
    );
  }

  /*
   * The pooler checks a credential by querying the database itself, and that
   * query did not come back in time. Not a client count and not a password:
   * production, 2026-09-23 22:17:51Z, printed no diagnosis for this at all.
   */
  if (text.includes('EAUTHQUERY')) {
    return (
      'The connection pooler in front of the database could not check this credential in ' +
      `time: ${text.trim()}. It checks by querying the database itself, so this is the ` +
      'database itself answering slowly (or not at all) — not a wrong password, and not a ' +
      'shortage of pooler clients. Raising BRAIN_DATABASE_POOL_SIZE changes nothing; check ' +
      "the database's health, then try again."
    );
  }

  return null;
}

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
  /**
   * Confine every connection to one schema.
   *
   * Set through the connection's own `options` parameter rather than by issuing
   * a `SET` after connecting, because the pool hands a client out as soon as it
   * is connected — a `SET` racing that would let the first statements run
   * against `public`. Used by the test harness to give each file its own
   * namespace in one database; unset in ordinary operation.
   */
  schema?: string;
}

export class PostgresAdapter implements Database {
  readonly dialect = 'postgres' as const;
  readonly kind = 'postgres' as const;

  #pool: pg.Pool;
  #transactions = new AsyncLocalStorage<TransactionContext>();
  #closed = false;
  // Kept because `pg.Pool` does not expose the options it was opened with, and a
  // reading without its ceiling cannot say whether the ceiling was the problem.
  #max: number;
  #connectionTimeoutMs: number;

  constructor(options: PostgresOptions) {
    const config: PoolConfig = {
      connectionString: options.connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      application_name: options.applicationName ?? 'brain',
    };
    if (options.schema) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(options.schema)) {
        throw new DatabaseConfigurationError(
          `"${options.schema}" is not a usable schema name.`,
          'A schema name may contain letters, digits and underscores, and must not start with a digit.',
        );
      }
      config.options = `-c search_path=${options.schema}`;
    }
    // Supabase and most managed Postgres require TLS, and their certificates
    // are signed by roots Node does not ship. Verification is therefore off by
    // default for the pooled connection string — which is what every Supabase
    // client does — and can be demanded explicitly by putting `sslmode=verify-full`
    // in the URL.
    if (options.ssl !== false && !/sslmode=/i.test(options.connectionString)) {
      config.ssl = { rejectUnauthorized: false };
    }
    this.#max = config.max ?? 10;
    this.#connectionTimeoutMs = config.connectionTimeoutMillis ?? 10_000;
    this.#pool = new Pool(config);
    // A pool that emits an error with no listener takes the process down. An
    // idle client dropped by the far end is ordinary; the pool replaces it.
    this.#pool.on('error', () => undefined);
  }

  /**
   * Replace `pg-pool`'s eight words with the condition and the numbers.
   *
   * Anything that is not a checkout timeout is returned untouched: a wrong
   * diagnosis costs more than the bare message it replaced.
   */
  #namePoolTimeout(error: unknown): unknown {
    if (!(error instanceof Error) || error.message !== POOL_TIMEOUT_MESSAGE) return error;
    if ('brainPool' in error) return error;
    const named = new DatabaseConfigurationError(
      describePoolExhaustion({
        total: this.#pool.totalCount,
        idle: this.#pool.idleCount,
        waiting: this.#pool.waitingCount,
        max: this.#max,
        timeoutMs: this.#connectionTimeoutMs,
      }),
    );
    Object.defineProperty(named, 'brainPool', { value: true, enumerable: false });
    Object.defineProperty(named, 'cause', { value: error, enumerable: false });
    return named;
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
    try {
      if (context) {
        return (await context.client.query<T>(translated.sql, values)) as pg.QueryResult<T>;
      }
      return (await this.#pool.query<T>(translated.sql, values)) as pg.QueryResult<T>;
    } catch (error) {
      const pooled = this.#namePoolTimeout(error);
      if (pooled !== error) throw pooled;
      // Name the statement. A dialect problem otherwise surfaces as `syntax
      // error at or near "$3"` with nothing to say which of two hundred queries
      // produced it. The parameters are deliberately not included: they are the
      // part that carries the user's content.
      throw annotate(error, translated.sql);
    }
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

    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw this.#namePoolTimeout(error);
    }
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
 * Attach the offending SQL to a driver error, once.
 *
 * The original error is rethrown rather than replaced so its `code` and the
 * rest of the driver's detail survive for anything matching on them.
 */
function annotate(error: unknown, sql: string): unknown {
  if (!(error instanceof Error) || 'brainSql' in error) return error;
  // Only when the server itself rejected the statement. A SQLSTATE means
  // Postgres parsed it and said no, so naming it is the whole diagnosis; a
  // connection that was refused or a TLS handshake that failed has nothing to
  // do with the statement that happened to be first, and saying so there would
  // put SQL into a boot error about an unreachable host.
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return error;
  Object.defineProperty(error, 'brainSql', { value: sql, enumerable: false });
  error.message = `${error.message}\n  in: ${sql.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
  return error;
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

/**
 * What the *server* will allow, which is the fact a pool ceiling has to be
 * sized against and the one this repository has never had.
 *
 * §27 records seven occurrences of a post-restart verification dying at a pool
 * checkout and says, in as many words, that the ceiling was deliberately not
 * raised because *"this repository has no reading of that limit"* — raising it
 * blind could exhaust the server's own limit and turn a failed verification
 * into a failed boot. The eighth occurrence then produced the other half of the
 * number: `2/2 connection(s) in use, 0 idle, 380 caller(s) waiting, ceiling 2`.
 * A ceiling of two with three hundred and eighty callers queued is the ceiling
 * binding, not a slow query — and the only thing between that reading and a
 * sized decision is this one.
 *
 * **It is a diagnostic and never a gate.** It runs after `verifyConnection` has
 * already proved the database answers, every field is nullable, and a refusal
 * returns nulls rather than throwing: §18's rule is that cloud mode must not
 * fall back, and a *diagnostic* that failed the boot would be a diagnosis
 * replacing the thing it exists to explain. `deploy.yml`'s own "Why it failed"
 * step carries the same `|| true` for the same reason.
 *
 * `max_connections` and `superuser_reserved_connections` are `current_setting`
 * reads any role may make. The backend count comes from `pg_stat_database`
 * rather than `pg_stat_activity`, deliberately: a non-superuser sees only its
 * own rows in the second, so a count taken there would be a *partial* total
 * reported as a whole one — an under-reading that makes the server look idle,
 * which is the direction that would talk somebody into raising the ceiling on
 * a server that has no room. `numbackends` is server-wide and visible to
 * everyone.
 *
 * Nothing here names a credential, a host or a database; it is four integers.
 */
export interface ServerConnectionLimit {
  /** The server's own ceiling, or null when it would not say. */
  maxConnections: number | null;
  /** Slots the server keeps back for superusers, so they are not ours to use. */
  superuserReserved: number | null;
  /** Backends currently connected, server-wide, from `pg_stat_database`. */
  backendsInUse: number | null;
}

export async function readServerConnectionLimit(
  adapter: Database,
): Promise<ServerConnectionLimit> {
  const unknown: ServerConnectionLimit = {
    maxConnections: null,
    superuserReserved: null,
    backendsInUse: null,
  };
  try {
    const row = await adapter.get<{
      max_connections: string | number | null;
      superuser_reserved: string | number | null;
      backends: string | number | null;
    }>(
      `SELECT current_setting('max_connections') AS max_connections,
              current_setting('superuser_reserved_connections') AS superuser_reserved,
              (SELECT sum(numbackends) FROM pg_stat_database) AS backends`,
    );
    if (!row) return unknown;
    return {
      maxConnections: asCount(row.max_connections),
      superuserReserved: asCount(row.superuser_reserved),
      backendsInUse: asCount(row.backends),
    };
  } catch {
    // A server that will not answer this is a server whose limit is unknown,
    // which is a different fact from a limit of zero and is reported as one.
    return unknown;
  }
}

function asCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The half of the reading this function cannot take, said rather than implied.
 *
 * **`max_connections` is the database's ceiling and it is not necessarily the
 * binding one.** A connection pooler in front of the database has a client
 * limit of its own, that limit is lower, it is shared with every other client
 * of the same pooler, and it is not readable from a session on the far side of
 * it — `current_setting('max_connections')` answers about Postgres, which is
 * exactly the thing that is not refusing.
 *
 * Measured in production on 2026-09-20. The banner read
 * `pool ceiling 10 of 57 usable (max_connections 60, 3 reserved for
 * superusers)` while the pooler refused an ordinary operator read outright:
 *
 *     (EMAXCONNSESSION) max clients reached in session mode
 *     - max clients are limited to pool_size: 15
 *
 * So the number on the banner was **57** and the number that was binding was
 * **15**, and it is shared: the app holds up to `BRAIN_DATABASE_POOL_SIZE`,
 * and every `flyctl ssh console` operator script beside it opens its own pool
 * of two. Four concurrent readings and a busy app exhaust it, which is what a
 * hosted verification hanging for ninety-five minutes on one step looks like
 * from the inside.
 *
 * This says so and reads nothing extra to do it. Sniffing the host for
 * `pooler.` would be deriving a deployment fact from a name — §25's rule about
 * prose, at a connection string — and it would still not produce the pooler's
 * number. An unknown ceiling reads as unknown rather than as headroom.
 */
const POOLER_CAVEAT =
  'A pooler in front of the database has its own, lower client limit that is not readable ' +
  'from here, and it is shared with every other client of that pooler — so this is the ' +
  'database\'s ceiling rather than necessarily the binding one.';

/**
 * The sentence an operator needs, or the honest absence of one.
 *
 * Pure, so both dialects test every branch it draws — the same reason
 * `describePoolExhaustion` is pure. It reports and never decides: nothing in
 * this repository can set `BRAIN_DATABASE_POOL_SIZE`, which is a deployment
 * secret, and a function that recommended a number it could not apply would be
 * a remedy the reader cannot use.
 */
export function describeConnectionHeadroom(
  limit: ServerConnectionLimit,
  poolCeiling: number,
): string {
  const { maxConnections, superuserReserved, backendsInUse } = limit;
  if (maxConnections === null) {
    return (
      `pool ceiling ${poolCeiling}; the server would not report max_connections, so how much ` +
      `headroom there is above that ceiling is unknown rather than large. ${POOLER_CAVEAT}`
    );
  }
  const reserved = superuserReserved ?? 0;
  const usable = maxConnections - reserved;
  const used = backendsInUse === null ? 'unknown' : String(backendsInUse);
  const head =
    `pool ceiling ${poolCeiling} of ${usable} usable at the database (max_connections ` +
    `${maxConnections}` +
    `${superuserReserved === null ? '' : `, ${reserved} reserved for superusers`}), ` +
    `${used} backend(s) connected now`;
  if (poolCeiling >= usable) {
    return (
      `${head}. The ceiling is at or above what the database will give out, so raising ` +
      `BRAIN_DATABASE_POOL_SIZE would be refused connections rather than more of them. ` +
      POOLER_CAVEAT
    );
  }
  return `${head}. BRAIN_DATABASE_POOL_SIZE sets the ceiling. ${POOLER_CAVEAT}`;
}
