/**
 * Opening the database Brain was configured to use, and proving it works.
 *
 * `getDb()` is the only way anything above this file reaches storage, and it
 * hands back the same interface whichever backend answered. What changes
 * between local and cloud is decided once, here, at boot.
 *
 * The one behaviour worth stating plainly: cloud mode never degrades into local
 * mode. If Postgres was asked for and cannot be reached, boot fails with the
 * reason. A server that fell back would keep working, keep accepting research,
 * and keep writing it somewhere nobody else could see — and the failure would
 * only surface later, as missing work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, ensureDataDirs } from '../env.ts';
import { databaseConfig, type DatabaseConfig } from '../config.ts';
import { openSqlite } from './adapters/sqlite.ts';
import { PostgresAdapter, describeConnection, verifyConnection } from './adapters/postgres.ts';
import { runMigrations, type MigrationReport } from './migrate.ts';
import { DatabaseConfigurationError, type Database, type Row, type SqlParam } from './types.ts';

let db: Database | null = null;
let migrationReport: MigrationReport | null = null;
let bootError: Error | null = null;
let activeConfig: DatabaseConfig | null = null;

export interface InitDatabaseOptions {
  /** Local mode only: the file to open. */
  dbPath?: string;
  /**
   * Where the migrations live.
   *
   * A test seam and nothing else: it exists so the upgrade path can be
   * exercised against a database standing at an older release, which is the
   * migration that actually matters — the user's own.
   */
  migrationsDir?: string;
  /** Overrides the environment. Used by the migration tool and by tests. */
  config?: DatabaseConfig;
}

/**
 * Open the database and bring the schema fully up to date. Called once during
 * boot, before any route is served. Idempotent.
 */
export async function initDatabase(
  options: InitDatabaseOptions = {},
): Promise<{ db: Database; migrations: MigrationReport }> {
  if (db && migrationReport) return { db, migrations: migrationReport };

  const config = options.config ?? databaseConfig();
  activeConfig = config;

  try {
    const opened =
      config.provider === 'postgres'
        ? await openCloud(config)
        : openLocal(options.dbPath ?? DB_PATH);

    try {
      migrationReport = await runMigrations(opened.db, opened.describedPath, options.migrationsDir);
    } catch (error) {
      await opened.db.close();
      throw error;
    }

    db = opened.db;
    bootError = null;
    return { db, migrations: migrationReport };
  } catch (error) {
    bootError = error instanceof Error ? error : new Error(String(error));
    throw bootError;
  }
}

function openLocal(file: string): { db: Database; describedPath: string } {
  ensureDataDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { db: openSqlite(file), describedPath: file };
}

/**
 * Open the cloud database, and refuse to continue unless it answered.
 *
 * The verification query is the point. Everything else — the variable being
 * set, the URL parsing, the pool being constructed — can all succeed against a
 * database that does not exist.
 */
async function openCloud(config: DatabaseConfig): Promise<{ db: Database; describedPath: string }> {
  const adapter = new PostgresAdapter({
    connectionString: config.connectionString!,
    max: config.poolSize,
  });
  const described = describeConnection(config.connectionString!);
  try {
    await verifyConnection(adapter);
  } catch (error) {
    await adapter.close().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new DatabaseConfigurationError(
      `Brain is configured for Postgres but could not reach ${described}.`,
      `${reason} Nothing was written locally: cloud mode does not fall back, because a server ` +
        `that quietly kept working against a local file would report itself as cloud-backed ` +
        `while the work went somewhere nobody else can see.`,
    );
  }
  return { db: adapter, describedPath: described };
}

export function getDb(): Database {
  if (bootError) throw bootError;
  if (!db) throw new Error('Database not initialised. Call initDatabase() during boot.');
  return db;
}

export function getMigrationReport(): MigrationReport | null {
  return migrationReport;
}

/** Which backend actually answered, for the health endpoint and the banner. */
export function activeDatabaseConfig(): DatabaseConfig | null {
  return activeConfig;
}

/** Test/teardown helper. */
/**
 * Close the database, but not before the work already in flight has committed.
 *
 * Extraction and research run in background queues on purpose — an import must
 * not wait for a fifty-page PDF. That means at any moment there may be work
 * holding a half-written run, and closing underneath it turns an orderly
 * shutdown into a document stuck in EXTRACTING forever, recoverable only by the
 * interrupted-run sweep at the next boot.
 *
 * So shutdown waits for the queues to go idle first. It is bounded, because a
 * hung provider must not stop the process from exiting: past the grace period
 * the close proceeds, and the interrupted work is recovered at the next boot
 * exactly as it would be after a crash.
 */
export async function closeDatabase(options: { drainMs?: number } = {}): Promise<void> {
  const open = db;
  if (open) await drainBackgroundWork(options.drainMs ?? 5_000);
  db = null;
  migrationReport = null;
  bootError = null;
  activeConfig = null;
  if (open) await open.close();
}

async function drainBackgroundWork(graceMs: number): Promise<void> {
  // Imported here rather than at module scope: the queues reach back into the
  // database, and a static cycle between them would leave one of the two
  // half-initialised depending on which was loaded first.
  const [{ whenExtractionIdle }, { whenResearchIdle }] = await Promise.all([
    import('../services/documents/queue.ts'),
    import('../services/research/queue.ts'),
  ]);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all([whenExtractionIdle(), whenResearchIdle()]), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { Database, SqlParam, Row };
export { DatabaseConfigurationError };
