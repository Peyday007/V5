import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../server/db/adapters/sqlite.ts';
import { runMigrations } from '../server/db/migrate.ts';
import { MAGIC_TABLES } from '../server/domain/magicTypes.ts';

const SQLITE = fileURLToPath(new URL('../server/db/migrations', import.meta.url));
const PG = fileURLToPath(new URL('../server/db/pg-migrations', import.meta.url));

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-magic-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('magic schema', () => {
  it('both chains carry the magic migration and name every table', () => {
    for (const root of [SQLITE, PG]) {
      const file = fs.readdirSync(root).find((f) => f.endsWith('_magic.sql'));
      expect(file).toBeDefined();
      const sql = fs.readFileSync(path.join(root, file!), 'utf8');
      for (const table of MAGIC_TABLES) expect(sql).toContain(`CREATE TABLE ${table} (`);
      expect(sql).not.toContain('$$');
    }
  });

  it('boots from empty, restarts against existing, and keeps versions append-only in shape', async () => {
    const dbPath = path.join(dir, 'brain.db');
    const db = openSqlite(dbPath);
    try {
      await runMigrations(db, dbPath);
      const second = await runMigrations(db, dbPath);
      expect(second.applied.length).toBe(0);
    for (const table of MAGIC_TABLES) {
      const row = await db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
      expect(row?.name).toBe(table);
    }
    // versions carry no mutable "current" flag: the pointer lives on the deck
    const cols = await db.all<{ name: string }>("SELECT name FROM pragma_table_info('magic_deck_versions')");
    expect(cols.map((c) => c.name)).not.toContain('is_current');
    } finally {
      await db.close();
    }
  });
});
