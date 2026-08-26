/**
 * Applying schema changes, to whichever database is underneath.
 *
 * Two directories, one runner. `migrations/` is the SQLite chain that every
 * existing local Brain has already applied and whose files are therefore
 * immutable; `pg-migrations/` is the cloud chain, which starts from a baseline
 * describing the same schema and moves forward on its own numbering. The two
 * are deliberately separate: pretending one file could describe both dialects
 * would mean writing to the intersection of them, and the intersection is not
 * expressive enough to say what this schema needs.
 *
 * What both chains share is the discipline. Every file is applied once, in
 * order, inside a transaction, with its checksum recorded — so an applied
 * migration that is later edited stops the boot rather than half-applying
 * itself, and a migration interrupted mid-flight leaves nothing behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database, DatabaseDialect } from './types.ts';
import { BACKUP_ROOT } from '../env.ts';

const SQLITE_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const POSTGRES_MIGRATIONS_DIR = fileURLToPath(new URL('./pg-migrations', import.meta.url));

/** Where the chain for one dialect lives. */
export function migrationsDirFor(dialect: DatabaseDialect): string {
  return dialect === 'postgres' ? POSTGRES_MIGRATIONS_DIR : SQLITE_MIGRATIONS_DIR;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationReport {
  driver: string;
  /** The local file, or the sanitized description of the cloud database. */
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

/** FNV-1a, 64-bit, hex encoded. Dependency-free and stable across versions. */
function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash ^ BigInt(text.charCodeAt(i))) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The line endings a migration is checksummed with, and why it is not simply
 * the bytes on disk.
 *
 * This checksum answers one question — *did somebody edit an applied
 * migration?* — and for a long time it answered a subtly different one: *are
 * these the same bytes?* Those are the same question only while the file is
 * checked out on one operating system.
 *
 * They stopped being the same the moment this project had both a Windows
 * laptop and a Linux container building from one repository. Git for Windows
 * converts LF to CRLF on checkout, so the laptop applied `001_baseline.sql`
 * and recorded a checksum over CRLF bytes; the container read the same commit
 * with LF, computed a different number, and the immutability guard did exactly
 * what it was built to do — refused to boot, naming a file nobody had touched.
 *
 * Measured rather than reasoned about: the recorded value was the CRLF hash of
 * that file and the "current" value was the LF hash of the identical content.
 *
 * So the checksum is taken over content with line endings normalised. A real
 * edit still changes it; a checkout on a different platform no longer does.
 */
function normalizeEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function checksum(text: string): string {
  return fnv1a(normalizeEndings(text));
}

/**
 * Is `recorded` this file, written down before the normalisation above existed?
 *
 * Only two encodings can have produced it — the raw bytes as they were on that
 * machine, and those bytes with CRLF endings — so those are the only two
 * accepted. Anything else is a genuine edit and must still stop the boot; this
 * is a compatibility path, not a weakening of the check.
 */
function matchesLegacyChecksum(recorded: string, sql: string): boolean {
  const normalized = normalizeEndings(sql);
  return recorded === fnv1a(sql) || recorded === fnv1a(normalized.replace(/\n/g, '\r\n'));
}

export function loadMigrationFiles(dir: string = SQLITE_MIGRATIONS_DIR): MigrationFile[] {
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

/**
 * The ledger, in whichever dialect.
 *
 * Same four columns, same meaning, so the two chains can be reasoned about
 * together even though their contents differ.
 */
async function ensureMigrationTable(db: Database): Promise<void> {
  const versionType = db.dialect === 'postgres' ? 'integer' : 'INTEGER';
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    ${versionType} PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Copy the database file aside before the first schema change is applied to an
 * existing database. Cheap insurance; only taken when there is something to lose.
 *
 * Local only. A managed Postgres has its own backups, and copying one from here
 * would be both impossible and a worse promise than the one its provider makes.
 */
async function backupDatabase(db: Database, databasePath: string): Promise<string | null> {
  if (db.dialect !== 'sqlite') return null;
  try {
    if (!fs.existsSync(databasePath) || fs.statSync(databasePath).size === 0) return null;
    // In WAL mode the newest committed pages may live only in the -wal sidecar, so a
    // plain file copy would silently back up a stale database. Fold the WAL in first.
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
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
export async function runMigrations(
  db: Database,
  databasePath: string,
  dir?: string,
): Promise<MigrationReport> {
  const directory = dir ?? migrationsDirFor(db.dialect);
  await ensureMigrationTable(db);

  const files = loadMigrationFiles(directory);
  const appliedRows = await db.all<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  const appliedByVersion = new Map(appliedRows.map((r) => [Number(r.version), r]));

  for (const file of files) {
    const previous = appliedByVersion.get(file.version);
    if (!previous || previous.checksum === file.checksum) continue;

    // Same content, recorded before line endings were normalised out of the
    // checksum. Heal the row rather than refusing: the file has not been
    // edited, and leaving the old value would mean every future boot from the
    // other platform hit the same false alarm.
    if (matchesLegacyChecksum(previous.checksum, file.sql)) {
      await db.run('UPDATE schema_migrations SET checksum = ? WHERE version = ?', [
        file.checksum,
        file.version,
      ]);
      console.log(
        `  ${file.filename}: checksum rewritten to its line-ending-independent form ` +
          '(the file is unchanged; it was first applied from a checkout with different line endings).',
      );
      continue;
    }

    throw new Error(
      `Migration ${file.filename} changed after it was applied ` +
        `(recorded checksum ${previous.checksum}, current ${file.checksum}). ` +
        `Applied migrations are immutable — add a new migration instead of editing this one.`,
    );
  }

  const pending = files.filter((f) => !appliedByVersion.has(f.version));
  let backupPath: string | null = null;
  if (pending.length > 0 && appliedRows.length > 0) {
    backupPath = await backupDatabase(db, databasePath);
  }

  const applied: MigrationReport['applied'] = [];
  for (const file of pending) {
    const startedAt = Date.now();
    try {
      // One transaction per file, so a failure leaves the schema exactly where
      // it was. Postgres runs DDL transactionally, which is what makes this
      // promise true on both backends rather than only on one.
      await db.transaction(async () => {
        await db.exec(file.sql);
        await db.run(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          [file.version, file.name, file.checksum, new Date().toISOString()],
        );
      });
    } catch (error) {
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

export async function getSchemaVersion(db: Database): Promise<number> {
  await ensureMigrationTable(db);
  const row = await db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  return Number(row?.version ?? 0);
}
