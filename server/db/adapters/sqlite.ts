/**
 * The local adapter: an asynchronous face on a synchronous SQLite driver.
 *
 * Nothing here actually waits for I/O — `node:sqlite` returns rows before the
 * promise is created. What the adapter buys is one boundary for both backends,
 * and it costs one microtask per statement.
 *
 * The part that is not cosmetic is the lock. When the boundary became
 * asynchronous, two requests could interleave inside one transaction on a
 * single shared connection: request A opens BEGIN, awaits, request B writes,
 * and B's write is now inside A's transaction and rolls back with it. That
 * cannot be allowed to happen quietly, so one connection means one operation at
 * a time, and a transaction holds the connection for its whole duration.
 * SQLite statements take microseconds, so serialising them costs nothing worth
 * measuring; the alternative costs correctness.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Database,
  DatabaseKind,
  RunResult,
  Row,
  SqlParam,
  SqlValue,
} from '../types.ts';
import { openDriver, type SqliteDriver } from '../driver.ts';
import {
  Mutex,
  childFrame,
  rootFrame,
  savepointName,
  type TransactionFrame,
} from './transactions.ts';

export class SqliteAdapter implements Database {
  readonly dialect = 'sqlite' as const;
  readonly kind: DatabaseKind;

  #driver: SqliteDriver;
  #lock = new Mutex();
  #transactions = new AsyncLocalStorage<TransactionFrame>();

  constructor(driver: SqliteDriver) {
    this.#driver = driver;
    this.kind = driver.kind;
  }

  /**
   * Run one operation against the connection.
   *
   * Inside a transaction the lock is already held by that transaction, and
   * taking it again would deadlock — so the async context decides.
   */
  async #withConnection<T>(work: () => T): Promise<T> {
    if (this.#transactions.getStore()) return work();
    const release = await this.#lock.acquire();
    try {
      return work();
    } finally {
      release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.#withConnection(() => this.#driver.exec(sql));
  }

  async all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return await this.#withConnection(() => this.#driver.all<T>(sql, params));
  }

  async get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    return await this.#withConnection(() => this.#driver.get<T>(sql, params));
  }

  async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
    return await this.#withConnection(() => ({ changes: this.#driver.run(sql, params).changes }));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const parent = this.#transactions.getStore();
    if (parent) return await this.#nested(parent, fn);

    const release = await this.#lock.acquire();
    try {
      this.#driver.exec('BEGIN');
      try {
        const result = await this.#transactions.run(rootFrame(), fn);
        this.#driver.exec('COMMIT');
        return result;
      } catch (error) {
        this.#driver.exec('ROLLBACK');
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * A composed transaction, which must be able to fail without failing its
   * parent — and must not interleave with its siblings, because savepoints are
   * a stack and releasing one out of order discards the others.
   */
  async #nested<T>(parent: TransactionFrame, fn: () => Promise<T>): Promise<T> {
    const release = await parent.children.acquire();
    const frame = childFrame(parent);
    const savepoint = savepointName(frame);
    try {
      this.#driver.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = await this.#transactions.run(frame, fn);
        this.#driver.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.#driver.exec(`ROLLBACK TO ${savepoint}`);
        this.#driver.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    this.#driver.close();
  }
}

/** Open a local database file and put the pragmas Brain relies on in place. */
export function openSqlite(
  filePath: string,
  options: { readOnly?: boolean } = {},
): SqliteAdapter {
  const driver = openDriver(filePath, options);
  if (options.readOnly) {
    // Nothing here may write, so the pragmas that configure writing are not
    // set: journal_mode in particular would itself be a write, and would fail.
    driver.exec('PRAGMA foreign_keys = ON');
    driver.exec('PRAGMA busy_timeout = 5000');
    return new SqliteAdapter(driver);
  }
  // WAL keeps the app responsive while long imports write; foreign keys are
  // enforced so invariant violations surface immediately rather than silently.
  driver.exec('PRAGMA journal_mode = WAL');
  driver.exec('PRAGMA foreign_keys = ON');
  driver.exec('PRAGMA busy_timeout = 5000');
  driver.exec('PRAGMA synchronous = NORMAL');
  return new SqliteAdapter(driver);
}

export type { SqlValue };
