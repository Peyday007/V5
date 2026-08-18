/**
 * SQLite driver abstraction.
 *
 * The platform must install and boot with zero native build steps, so the
 * default driver is Node's built-in `node:sqlite`. If the user has installed
 * `better-sqlite3` we transparently prefer it (it is faster and non-experimental).
 *
 * Only positional `?` parameters are used so both drivers behave identically.
 */

import { createRequire } from 'node:module';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined | Date;
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteDriver {
  readonly kind: 'node:sqlite' | 'better-sqlite3';
  exec(sql: string): void;
  all<T = Row>(sql: string, params?: SqlParam[]): T[];
  get<T = Row>(sql: string, params?: SqlParam[]): T | undefined;
  run(sql: string, params?: SqlParam[]): RunResult;
  close(): void;
}

/** SQLite accepts a narrow set of JS types; normalise everything else. */
function normalise(params: SqlParam[] | undefined): SqlValue[] {
  if (!params || params.length === 0) return [];
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    return value;
  });
}

interface StatementLike {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

/**
 * Statements are prepared once and reused. Both drivers keep prepared
 * statements valid across schema changes for our usage pattern, but the cache
 * is cleared explicitly by the migrator to be safe.
 */
class CachingDriver implements SqliteDriver {
  readonly kind: SqliteDriver['kind'];
  #db: DatabaseLike;
  #cache = new Map<string, StatementLike>();

  constructor(db: DatabaseLike, kind: SqliteDriver['kind']) {
    this.#db = db;
    this.kind = kind;
  }

  #stmt(sql: string): StatementLike {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    // DDL can invalidate prepared statements; drop the cache defensively.
    this.#cache.clear();
    this.#db.exec(sql);
  }

  all<T = Row>(sql: string, params?: SqlParam[]): T[] {
    return this.#stmt(sql).all(...normalise(params)) as T[];
  }

  get<T = Row>(sql: string, params?: SqlParam[]): T | undefined {
    const row = this.#stmt(sql).get(...normalise(params));
    return (row ?? undefined) as T | undefined;
  }

  run(sql: string, params?: SqlParam[]): RunResult {
    const result = this.#stmt(sql).run(...normalise(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  close(): void {
    this.#cache.clear();
    this.#db.close();
  }
}

const require_ = createRequire(import.meta.url);

interface NodeSqliteModule {
  DatabaseSync: new (p: string) => DatabaseLike;
}

/**
 * Open the best available driver.
 *
 * Both loads deliberately go through `createRequire` / `process.getBuiltinModule`
 * rather than `import`, so bundlers (Vite, esbuild) never try to resolve them at
 * transform time — `node:sqlite` is not in every bundler's builtin list, and
 * `better-sqlite3` is genuinely optional.
 */
export function openDriver(filePath: string): SqliteDriver {
  try {
    const Ctor = require_('better-sqlite3') as new (p: string) => DatabaseLike;
    return new CachingDriver(new Ctor(filePath), 'better-sqlite3');
  } catch {
    // better-sqlite3 is not installed; use the built-in driver.
  }

  const getBuiltin = (process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
  }).getBuiltinModule;

  const sqlite = (getBuiltin?.('node:sqlite') ?? require_('node:sqlite')) as NodeSqliteModule;
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      'No SQLite driver available. Brain requires Node.js >= 22.5 (for the built-in ' +
        'node:sqlite module) or the optional `better-sqlite3` package.',
    );
  }
  return new CachingDriver(new sqlite.DatabaseSync(filePath), 'node:sqlite');
}
