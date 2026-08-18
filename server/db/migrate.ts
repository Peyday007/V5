import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqliteDriver } from './driver.ts';
import { BACKUP_ROOT } from '../env.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationReport {
  driver: string;
  databasePath: string;
  schemaVersion: number;
  applied: { version: number; name: string; durationMs: number }[];
  alreadyApplied: number;
  backupPath: string | null;
}

interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

/** Stable, dependency-free checksum used to detect edited migrations. */
function checksum(text: string): string {
  // FNV-1a, 64-bit, hex encoded.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash ^ BigInt(text.charCodeAt(i))) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const migrations: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const filename of files) {
    const match = /^(\d+)[_-](.+)\.sql$/.exec(filename);
    if (!match) {
      throw new Error(
        `Migration "${filename}" does not follow the required NNN_name.sql convention.`,
      );
    }
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version} (${filename}).`);
    }
    seen.add(version);
    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    migrations.push({ version, name: match[2] ?? filename, filename, sql, checksum: checksum(sql) });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

function ensureMigrationTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Copy the database file aside before the first schema change is applied to an
 * existing database. Cheap insurance; only taken when there is something to lose.
 */
function backupDatabase(databasePath: string): string | null {
  try {
    if (!fs.existsSync(databasePath) || fs.statSync(databasePath).size === 0) return null;
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(BACKUP_ROOT, `brain-${stamp}.db`);
    fs.copyFileSync(databasePath, target);
    return target;
  } catch {
    // A failed backup must never block boot; migrations are transactional anyway.
    return null;
  }
}

/**
 * Apply every unapplied migration, in order, each inside its own transaction.
 * Throws with a precise message if any migration fails — the caller surfaces
 * that as an application error rather than serving a half-migrated database.
 */
export function runMigrations(
  db: SqliteDriver,
  databasePath: string,
  dir: string = MIGRATIONS_DIR,
): MigrationReport {
  ensureMigrationTable(db);

  const files = loadMigrationFiles(dir);
  const appliedRows = db.all<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  const appliedByVersion = new Map(appliedRows.map((r) => [Number(r.version), r]));

  for (const file of files) {
    const previous = appliedByVersion.get(file.version);
    if (previous && previous.checksum !== file.checksum) {
      throw new Error(
        `Migration ${file.filename} changed after it was applied ` +
          `(recorded checksum ${previous.checksum}, current ${file.checksum}). ` +
          `Applied migrations are immutable — add a new migration instead of editing this one.`,
      );
    }
  }

  const pending = files.filter((f) => !appliedByVersion.has(f.version));
  let backupPath: string | null = null;
  if (pending.length > 0 && appliedRows.length > 0) {
    backupPath = backupDatabase(databasePath);
  }

  const applied: MigrationReport['applied'] = [];
  for (const file of pending) {
    const startedAt = Date.now();
    db.exec('BEGIN');
    try {
      db.exec(file.sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [file.version, file.name, file.checksum, new Date().toISOString()],
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone */
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file.filename} failed and was rolled back: ${reason}`);
    }
    applied.push({ version: file.version, name: file.name, durationMs: Date.now() - startedAt });
  }

  const latest = files.at(-1)?.version ?? 0;
  return {
    driver: db.kind,
    databasePath,
    schemaVersion: latest,
    applied,
    alreadyApplied: appliedRows.length,
    backupPath,
  };
}

export function getSchemaVersion(db: SqliteDriver): number {
  ensureMigrationTable(db);
  const row = db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  return Number(row?.version ?? 0);
}
