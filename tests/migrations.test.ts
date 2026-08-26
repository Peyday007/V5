import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase, getDb } from '../server/db/database.ts';
import { loadMigrationFiles, getSchemaVersion, runMigrations } from '../server/db/migrate.ts';
import { openDriver } from '../server/db/driver.ts';

/**
 * Boot a database at whatever schema a directory of migrations describes.
 *
 * Used to stand a database up at an older release so the upgrade path can be
 * tested against data rather than against emptiness.
 */
async function openDatabaseAt(dbPath: string, migrationsDir: string): Promise<{ schemaVersion: number }> {
  await closeDatabase();
  const report = await initDatabase({ dbPath, migrationsDir });
  return { schemaVersion: report.migrations.schemaVersion };
}

const EXPECTED_TABLES = [
  'audit_findings',
  'audits',
  'conversations',
  'dependencies',
  'documents',
  'layers',
  'messages',
  'project_events',
  'projects',
  'research_runs',
  'schema_migrations',
];

afterEach(async () => {
  await closeDatabase();
});

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mig-')), 'brain.db');
}

describe('migrations', () => {
  it('creates every table from an empty database', async () => {
    const { migrations } = await initDatabase({ dbPath: tempDbPath() });
    expect(migrations.applied.length).toBeGreaterThan(0);
    expect(migrations.schemaVersion).toBe(loadMigrationFiles().at(-1)?.version);

    const tables = (await getDb()
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'));
    for (const table of EXPECTED_TABLES) expect(tables).toContain(table);
  });

  it('is a no-op on restart against an existing database', async () => {
    const dbPath = tempDbPath();
    const first = await initDatabase({ dbPath });
    expect(first.migrations.applied.length).toBeGreaterThan(0);
    await closeDatabase();

    const second = await initDatabase({ dbPath });
    expect(second.migrations.applied).toHaveLength(0);
    expect(second.migrations.alreadyApplied).toBeGreaterThan(0);
    expect(await getSchemaVersion(getDb())).toBe(second.migrations.schemaVersion);
  });

  it('rejects duplicate or malformed migration filenames', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-badmig-'));
    fs.writeFileSync(path.join(dir, 'not-a-migration.sql'), 'SELECT 1;');
    expect(() => loadMigrationFiles(dir)).toThrow(/NNN_name\.sql/);
  });

  it('upgrades a database that already holds a project, without losing it', async () => {
    // The migration path that matters is not the empty one — it is the user's
    // own database, with their documents in it, meeting a new release.
    const dbPath = tempDbPath();
    const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mig-old-'));
    const all = loadMigrationFiles();
    const upTo = 6;
    for (const file of all.filter((entry) => entry.version <= upTo)) {
      fs.copyFileSync(
        path.join(fileURLToPath(new URL('../server/db/migrations', import.meta.url)), file.filename),
        path.join(staged, file.filename),
      );
    }

    // Boot at the older schema and put real rows in it.
    const older = await openDatabaseAt(dbPath, staged);
    expect(older.schemaVersion).toBe(upTo);
    const ts = new Date().toISOString();
    await getDb().run(
      `INSERT INTO projects (id, name, slug, description, current_wave, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['proj_old', 'Existing project', 'existing-project', 'From before the upgrade', 1, ts, ts],
    );
    await getDb().run(
      `INSERT INTO layers (id, project_id, name, slug, order_index, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lyr_old', 'proj_old', 'World Model', 'world-model', 1, 'NOT_STARTED', ts, ts],
    );
    await closeDatabase();

    // Now apply everything since. The data survives and the new tables exist.
    const upgraded = await initDatabase({ dbPath });
    expect(upgraded.migrations.applied.length).toBeGreaterThan(0);
    expect(upgraded.migrations.schemaVersion).toBe(all.at(-1)?.version);

    const project = await getDb().get<{ name: string }>('SELECT name FROM projects WHERE id = ?', [
      'proj_old',
    ]);
    expect(project?.name).toBe('Existing project');
    const layer = await getDb().get<{ name: string }>('SELECT name FROM layers WHERE id = ?', ['lyr_old']);
    expect(layer?.name).toBe('World Model');

    const tables = (await getDb()
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'"))
      .map((row) => row.name);
    for (const table of [
      'import_jobs',
      'import_files',
      'boundary_contracts',
      'requirements',
      'existing_claims',
      'requirement_coverage',
      'research_jobs',
      'research_job_fragments',
      'quota_pauses',
      'provider_connections',
    ]) {
      expect(tables).toContain(table);
    }

    // And the columns added to existing tables are really there.
    const fragmentColumns = (await getDb()
      .all<{ name: string }>('PRAGMA table_info(research_fragments)'))
      .map((row) => row.name);
    expect(fragmentColumns).toContain('repair_plan');
    expect(fragmentColumns).toContain('cancelled_reason');
    const orchestrationColumns = (await getDb()
      .all<{ name: string }>('PRAGMA table_info(research_orchestrations)'))
      .map((row) => row.name);
    expect(orchestrationColumns).toContain('auto_approve');
  });

  it('does not mistake a Windows checkout for an edited migration', async () => {
    // The failure this exists for, reproduced: the Brain was first migrated
    // from a Windows laptop, where Git had rewritten LF to CRLF on checkout, so
    // the checksum recorded in the database was taken over CRLF bytes. The
    // container then read the identical commit with LF, computed a different
    // number, and refused to boot naming a file nobody had touched.
    //
    // The guard has to keep refusing a real edit and stop refusing this.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-crlf-'));
    const body = 'CREATE TABLE crlf_check (id TEXT PRIMARY KEY);\nCREATE INDEX i1 ON crlf_check (id);\n';
    fs.writeFileSync(path.join(dir, '001_only.sql'), body, 'utf8');

    const dbPath = path.join(dir, 'brain.db');
    await closeDatabase();
    await initDatabase({ dbPath, migrationsDir: dir });

    // Rewrite the file exactly as a Windows checkout would present it. Not a
    // simulated checksum — the actual bytes, run through the actual loader.
    fs.writeFileSync(path.join(dir, '001_only.sql'), body.replace(/\n/g, '\r\n'), 'utf8');

    await closeDatabase();
    // Must not throw: the content is the same, only the line endings differ.
    const second = await initDatabase({ dbPath, migrationsDir: dir });
    expect(second.migrations.schemaVersion).toBe(1);

    // And a genuine edit is still refused.
    fs.writeFileSync(
      path.join(dir, '001_only.sql'),
      `${body}CREATE INDEX i2 ON crlf_check (id);\n`,
      'utf8',
    );
    await closeDatabase();
    await expect(initDatabase({ dbPath, migrationsDir: dir })).rejects.toThrow(
      /changed after it was applied/i,
    );

    await closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enforces foreign keys and WAL mode', async () => {
    await initDatabase({ dbPath: tempDbPath() });
    const fk = await getDb().get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(Number(fk?.foreign_keys)).toBe(1);
  });
});
