import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, initDatabase, getDb } from '../server/db/database.ts';
import { loadMigrationFiles, getSchemaVersion } from '../server/db/migrate.ts';

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

  it('enforces foreign keys and WAL mode', () => {
    initDatabase({ dbPath: tempDbPath() });
    const fk = getDb().get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(Number(fk?.foreign_keys)).toBe(1);
  });
});
