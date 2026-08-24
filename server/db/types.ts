/**
 * The database boundary.
 *
 * Everything above this line — repositories, services, routes — asks the same
 * five questions of whatever is underneath, and never learns which it is
 * talking to. That is the whole point: the research engine has one set of
 * semantics whether its state lives in a file on a laptop or in a Postgres
 * instance a continent away.
 *
 * The interface is asynchronous even for SQLite, where it need not be. A
 * synchronous boundary would have forced the cloud adapter to block the event
 * loop on every round trip, which for a database tens of milliseconds away
 * means freezing every other request — a research stream, a heartbeat, the
 * queue — for the duration. Paying a resolved promise locally is the cheaper
 * side of that trade by a wide margin.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined | Date;
export type Row = Record<string, SqlValue>;

export interface RunResult {
  /** Rows affected. Both drivers report this the same way. */
  changes: number;
}

export type DatabaseDialect = 'sqlite' | 'postgres';
export type DatabaseKind = 'node:sqlite' | 'better-sqlite3' | 'postgres';

export interface Database {
  readonly kind: DatabaseKind;
  readonly dialect: DatabaseDialect;
  /** Run a statement, or a script of them, for its effect. */
  exec(sql: string): Promise<void>;
  all<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params?: SqlParam[]): Promise<RunResult>;
  /**
   * Run `fn` inside a transaction.
   *
   * Nested calls use savepoints, so a service can compose repository functions
   * that each open a transaction without knowing whether it is the outermost
   * caller. Every statement issued while `fn` is running — from anywhere in
   * that async context — goes to the same connection and is inside the same
   * transaction; statements from *other* contexts are kept out of it.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * A failure that is about the database being unusable rather than about a
 * particular statement.
 *
 * Kept distinct so boot can refuse to serve traffic with a sentence the
 * operator can act on, instead of a driver error four frames deep.
 */
export class DatabaseConfigurationError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'DatabaseConfigurationError';
    this.detail = detail;
  }
}
