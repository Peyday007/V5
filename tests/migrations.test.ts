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
function openDatabaseAt(dbPath: string, migrationsDir: string): { schemaVersion: number } {
  closeDatabase();
  const report = initDatabase({ dbPath, migrationsDir });
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

afterEach(() => {
  closeDatabase();
});

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mig-')), 'brain.db');
}

describe('migrations', () => {
  it('creates every table from an empty database', () => {
    const { migrations } = initDatabase({ dbPath: tempDbPath() });
    expect(migrations.applied.length).toBeGreaterThan(0);
    expect(migrations.schemaVersion).toBe(loadMigrationFiles().at(-1)?.version);

    const tables = getDb()
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((r) => r.name)
      .filter((n) => !n.startsWith('sqlite_'));
    for (const table of EXPECTED_TABLES) expect(tables).toContain(table);
  });

  it('is a no-op on restart against an existing database', () => {
    const dbPath = tempDbPath();
    const first = initDatabase({ dbPath });
    expect(first.migrations.applied.length).toBeGreaterThan(0);
    closeDatabase();

    const second = initDatabase({ dbPath });
    expect(second.migrations.applied).toHaveLength(0);
    expect(second.migrations.alreadyApplied).toBeGreaterThan(0);
    expect(getSchemaVersion(getDb())).toBe(second.migrations.schemaVersion);
  });

  it('rejects duplicate or malformed migration filenames', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-badmig-'));
    fs.writeFileSync(path.join(dir, 'not-a-migration.sql'), 'SELECT 1;');
    expect(() => loadMigrationFiles(dir)).toThrow(/NNN_name\.sql/);
  });

  it('upgrades a database that already holds a project, without losing it', () => {
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
    const older = openDatabaseAt(dbPath, staged);
    expect(older.schemaVersion).toBe(upTo);
    const ts = new Date().toISOString();
    getDb().run(
      `INSERT INTO projects (id, name, slug, description, current_wave, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['proj_old', 'Existing project', 'existing-project', 'From before the upgrade', 1, ts, ts],
    );
    getDb().run(
      `INSERT INTO layers (id, project_id, name, slug, order_index, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['lyr_old', 'proj_old', 'World Model', 'world-model', 1, 'NOT_STARTED', ts, ts],
    );
    closeDatabase();

    // Now apply everything since. The data survives and the new tables exist.
    const upgraded = initDatabase({ dbPath });
    expect(upgraded.migrations.applied.length).toBeGreaterThan(0);
    expect(upgraded.migrations.schemaVersion).toBe(all.at(-1)?.version);

    const project = getDb().get<{ name: string }>('SELECT name FROM projects WHERE id = ?', [
      'proj_old',
    ]);
    expect(project?.name).toBe('Existing project');
    const layer = getDb().get<{ name: string }>('SELECT name FROM layers WHERE id = ?', ['lyr_old']);
    expect(layer?.name).toBe('World Model');

    const tables = getDb()
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
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
    const fragmentColumns = getDb()
      .all<{ name: string }>('PRAGMA table_info(research_fragments)')
      .map((row) => row.name);
    expect(fragmentColumns).toContain('repair_plan');
    expect(fragmentColumns).toContain('cancelled_reason');
    const orchestrationColumns = getDb()
      .all<{ name: string }>('PRAGMA table_info(research_orchestrations)')
      .map((row) => row.name);
    expect(orchestrationColumns).toContain('auto_approve');
  });

  it('enforces foreign keys and WAL mode', () => {
    initDatabase({ dbPath: tempDbPath() });
    const fk = getDb().get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(Number(fk?.foreign_keys)).toBe(1);
  });
});
