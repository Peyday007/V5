import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, ensureDataDirs } from '../env.ts';
import { openDriver, type SqliteDriver, type SqlParam, type Row } from './driver.ts';
import { runMigrations, type MigrationReport } from './migrate.ts';

export interface Database extends SqliteDriver {
  /**
   * Run `fn` inside a transaction. Nested calls use SAVEPOINTs so services can
   * compose freely without knowing whether they are the outermost caller.
   */
  transaction<T>(fn: () => T): T;
}

let db: Database | null = null;
let migrationReport: MigrationReport | null = null;
let bootError: Error | null = null;

function wrap(driver: SqliteDriver): Database {
  let depth = 0;
  const database = driver as Database;
  database.transaction = function transaction<T>(fn: () => T): T {
    const savepoint = `sp_${depth}`;
    if (depth === 0) driver.exec('BEGIN');
    else driver.exec(`SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = fn();
      depth -= 1;
      if (depth === 0) driver.exec('COMMIT');
      else driver.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      depth -= 1;
      if (depth === 0) driver.exec('ROLLBACK');
      else driver.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  };
  return database;
}

/**
 * Open the database and bring the schema fully up to date. Called once during
 * boot, before any route is served. Idempotent.
 */
export function initDatabase(
  options: {
    dbPath?: string;
    /**
     * Where the migrations live.
     *
     * A test seam and nothing else: it exists so the upgrade path can be
     * exercised against a database standing at an older release, which is the
     * migration that actually matters — the user's own.
     */
    migrationsDir?: string;
  } = {},
): {
  db: Database;
  migrations: MigrationReport;
} {
  if (db && migrationReport) return { db, migrations: migrationReport };

  ensureDataDirs();
  const file = options.dbPath ?? DB_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const driver = openDriver(file);
  // WAL keeps the app responsive while long imports write; foreign keys are
  // enforced so invariant violations surface immediately rather than silently.
  driver.exec('PRAGMA journal_mode = WAL');
  driver.exec('PRAGMA foreign_keys = ON');
  driver.exec('PRAGMA busy_timeout = 5000');
  driver.exec('PRAGMA synchronous = NORMAL');

  const wrapped = wrap(driver);
  try {
    migrationReport = runMigrations(wrapped, file, options.migrationsDir);
  } catch (error) {
    bootError = error instanceof Error ? error : new Error(String(error));
    driver.close();
    throw bootError;
  }
  db = wrapped;
  bootError = null;
  return { db, migrations: migrationReport };
}

export function getDb(): Database {
  if (bootError) throw bootError;
  if (!db) throw new Error('Database not initialised. Call initDatabase() during boot.');
  return db;
}

export function getMigrationReport(): MigrationReport | null {
  return migrationReport;
}

/** Test/teardown helper. */
export function closeDatabase(): void {
  db?.close();
  db = null;
  migrationReport = null;
  bootError = null;
}

export type { SqlParam, Row };
