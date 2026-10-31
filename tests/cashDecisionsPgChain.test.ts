/**
 * A schema change is not done until both chains have it. The decision record and
 * the value layers were created for SQLite only, so on the Postgres Brain every
 * read of them would have failed. This reads both chains, and on Postgres
 * also asks the real database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';

const read = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');

const TABLES: Record<string, string[]> = {
  cash_decisions: [
    'opportunity_id', 'goal_id', 'verdict', 'reason', 'detail', 'binding_constraint', 'missing_facts',
    'evidence_ids', 'reopen_condition', 'change_ref', 'is_current', 'recompute_change_ref',
    'recompute_requested_at', 'decided_at', 'superseded_at',
  ],
  cash_value_layers: ['opportunity_id', 'layer', 'status', 'amount_cents', 'currency', 'source', 'note'],
};

describe('both migration chains carry the decision tables', () => {
  const sqlite = strip(read('server/db/migrations'));
  const pg = strip(read('server/db/pg-migrations'));

  for (const [table, columns] of Object.entries(TABLES)) {
    it(`${table} exists in both chains with the same columns`, () => {
      const make = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\n\\);`);
      const a = make.exec(sqlite)?.[1];
      const b = make.exec(pg)?.[1];
      expect(a, `${table} in server/db/migrations`).toBeDefined();
      expect(b, `${table} in server/db/pg-migrations`).toBeDefined();
      for (const column of columns) {
        expect(a).toMatch(new RegExp(`\\b${column}\\b`));
        expect(b, `${table}.${column} missing from the Postgres chain`).toMatch(new RegExp(`\\b${column}\\b`));
      }
    });
  }

  it('keeps one current decision per opportunity and goal on both', () => {
    const index = /CREATE UNIQUE INDEX idx_cash_decisions_current ON cash_decisions \(opportunity_id, goal_id\) WHERE is_current = 1/;
    expect(sqlite).toMatch(index);
    expect(pg).toMatch(index);
  });
});

describe('the live database has the tables', () => {
  it('answers a read of each', async () => {
    await freshProject();
    for (const table of Object.keys(TABLES)) {
      const row = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(row?.n)).toBe(0);
    }
  });
});
