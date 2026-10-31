import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', 'server', 'db');
const read = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(root, dir, f), 'utf8'))
    .join('\n');

const tablesOf = (sql: string) =>
  [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);

// CLAUDE.md §3: a schema change is not done until both chains have it.
describe('cash screening tables exist in the Postgres chain', () => {
  const sqlite = readFileSync(join(root, 'migrations', '131_cash_value_layers.sql'), 'utf8')
    + readFileSync(join(root, 'migrations', '132_cash_decisions.sql'), 'utf8');
  const pg = read('pg-migrations');
  for (const table of tablesOf(sqlite)) {
    it(`${table} is created in pg-migrations`, () => {
      expect(tablesOf(pg)).toContain(table);
    });
  }
  it('covers both tables', () => {
    expect(tablesOf(sqlite).sort()).toEqual(['cash_decisions', 'cash_value_layers']);
  });
});
