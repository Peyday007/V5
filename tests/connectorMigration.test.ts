/**
 * Migration 100 (pg 091) over a populated token table, on whichever backend the
 * suite runs against: the grant family, the revocation reason and the first
 * use are derived from the rows already there, nobody has to reconnect, and
 * booting again changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../server/db/adapters/sqlite.ts';
import { PostgresAdapter } from '../server/db/adapters/postgres.ts';
import { loadMigrationFiles, runMigrations } from '../server/db/migrate.ts';
import type { Database } from '../server/db/types.ts';

const PG_URL = process.env['BRAIN_TEST_DATABASE_URL'];
const DIR = fileURLToPath(new URL(PG_URL ? '../server/db/pg-migrations' : '../server/db/migrations', import.meta.url));
const TARGET = loadMigrationFiles(DIR).find((f) => /connector_lifecycle/.test(f.filename))!;

let workspace = '';
let db: Database;
let schema = '';

function chainUpTo(upTo: number): string {
  const dir = path.join(workspace, `chain-${upTo}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of loadMigrationFiles(DIR)) {
    if (file.version <= upTo) fs.writeFileSync(path.join(dir, file.filename), file.sql);
  }
  return dir;
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cnr-migrate-'));
  if (PG_URL) {
    schema = `cnrmig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new PostgresAdapter({ connectionString: PG_URL, max: 1 });
    await admin.run(`CREATE SCHEMA ${schema}`);
    await admin.close();
    db = new PostgresAdapter({ connectionString: PG_URL, max: 2, schema });
  } else {
    db = openSqlite(path.join(workspace, 'brain.db'));
  }
});

afterEach(async () => {
  await db.close();
  if (PG_URL) {
    const admin = new PostgresAdapter({ connectionString: PG_URL, max: 1 });
    await admin.run(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function token(row: {
  id: string;
  kind: 'ACCESS' | 'REFRESH';
  parent?: string | null;
  created: string;
  revoked?: string | null;
  lastUsed?: string | null;
}): Promise<void> {
  await db.run(
    `INSERT INTO oauth_tokens (id, token_digest, token_prefix, kind, client_id, worker_id, scope, resource,
                               created_at, expires_at, last_used_at, revoked_at, parent_token_id)
     VALUES (?, ?, ?, ?, 'brnc_x', 'wkr_x', '', 'https://brain.example/mcp', ?, '2099-01-01T00:00:00.000Z', ?, ?, ?)`,
    [row.id, `digest-${row.id}`, `prefix-${row.id}`, row.kind, row.created, row.lastUsed ?? null, row.revoked ?? null, row.parent ?? null],
  );
}

describe('migration over a populated token table', () => {
  it('derives grants, reasons and first use, and a second boot is a no-op', async () => {
    expect(TARGET).toBeDefined();
    await runMigrations(db, path.join(workspace, 'brain.db'), chainUpTo(TARGET.version - 1));

    // A grant rotated twice, a superseded sibling, an explicit revocation, and
    // access tokens hanging off each refresh.
    await token({ id: 'r1', kind: 'REFRESH', created: '2026-01-01T00:00:00.000Z', revoked: '2026-01-01T01:00:00.000Z' });
    await token({ id: 'a1', kind: 'ACCESS', parent: 'r1', created: '2026-01-01T00:00:00.000Z', revoked: '2026-01-01T01:00:00.000Z', lastUsed: '2026-01-01T00:30:00.000Z' });
    await token({ id: 'r2', kind: 'REFRESH', parent: 'r1', created: '2026-01-01T01:00:00.000Z', revoked: '2026-01-01T02:00:00.000Z' });
    await token({ id: 'r2b', kind: 'REFRESH', parent: 'r1', created: '2026-01-01T01:30:00.000Z' });
    await token({ id: 'r3', kind: 'REFRESH', parent: 'r2', created: '2026-01-01T02:00:00.000Z', lastUsed: '2026-01-05T00:00:00.000Z' });
    await token({ id: 'x1', kind: 'REFRESH', created: '2026-02-01T00:00:00.000Z', revoked: '2026-02-02T00:00:00.000Z' });

    await runMigrations(db, path.join(workspace, 'brain.db'), DIR);
    const rows = await db.all<{ id: string; grant_id: string | null; revoked_reason: string | null; first_used_at: string | null }>(
      'SELECT id, grant_id, revoked_reason, first_used_at FROM oauth_tokens ORDER BY id',
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['r1']).toMatchObject({ grant_id: 'r1', revoked_reason: 'ROTATED' });
    expect(by['r2']).toMatchObject({ grant_id: 'r1', revoked_reason: 'ROTATED' });
    expect(by['r2b']).toMatchObject({ grant_id: 'r1', revoked_reason: null });
    expect(by['r3']).toMatchObject({ grant_id: 'r1', revoked_reason: null });
    expect(by['a1']).toMatchObject({ grant_id: 'r1' });
    expect(by['x1']).toMatchObject({ grant_id: 'x1', revoked_reason: 'EXPLICIT' });
    // The strict direction: a used token was first used no later than it was made.
    expect(by['r3']!.first_used_at).toBe('2026-01-01T02:00:00.000Z');
    expect(by['r1']!.first_used_at).toBeNull();

    const before = JSON.stringify(rows);
    const again = await runMigrations(db, path.join(workspace, 'brain.db'), DIR);
    expect(again.applied ?? []).toEqual([]);
    const after = await db.all('SELECT id, grant_id, revoked_reason, first_used_at FROM oauth_tokens ORDER BY id');
    expect(JSON.stringify(after)).toBe(before);
  });
});
