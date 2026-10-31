import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', 'server', 'db');

// A schema change is not done until both chains have it (CLAUDE.md §3). The
// SQLite suite cannot see a missing Postgres table, so read the chain itself.
describe('cash value layers and decisions exist in the Postgres chain', () => {
  const pg = readdirSync(join(ROOT, 'pg-migrations')).map((f) => ({
    f,
    sql: readFileSync(join(ROOT, 'pg-migrations', f), 'utf8'),
  }));
  for (const table of ['cash_value_layers', 'cash_decisions']) {
    it(`creates ${table}`, () => {
      expect(pg.some((m) => new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`).test(m.sql))).toBe(true);
    });
  }
  it('keeps the current-decision partial unique index', () => {
    expect(pg.some((m) => /idx_cash_decisions_current[\s\S]*WHERE is_current = 1/.test(m.sql))).toBe(true);
  });
});
