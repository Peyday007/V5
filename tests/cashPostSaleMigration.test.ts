/**
 * The post-sale migrations (108/109, pg 099/100) over a Brain that already has
 * money in it, on whichever backend the suite runs against.
 *
 * 109 rebuilds `cash_money_entries` on SQLite to widen its kind CHECK, and a
 * rebuild is only dangerous over rows (see `migrationRebuild.test.ts`). Every
 * other suite migrates an empty database. So this one records a production-
 * shaped ledger before 108, migrates to the head, and asserts:
 *   - every row and its rowid order come through;
 *   - the idempotency index still refuses a duplicate;
 *   - the two new kinds are accepted;
 *   - a second boot changes nothing.
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
const DIR = fileURLToPath(
  new URL(PG_URL ? '../server/db/pg-migrations' : '../server/db/migrations', import.meta.url),
);
const INVOICES = loadMigrationFiles(DIR).find((f) => /cash_invoices/.test(f.filename))!;

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
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-postsale-migrate-'));
  if (PG_URL) {
    schema = `psmig_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const AT = '2026-09-01T00:00:00.000Z';
const KINDS = [
  'CAPITAL_IN',
  'PIPELINE_AGREED',
  'CUSTOMER_PAYMENT',
  'SETTLEMENT',
  'REFUND',
  'COST',
  'UNPAID_COMMITMENT',
  'COMMITMENT_PAID',
  'RESERVE',
] as const;

async function entry(id: string, kind: string, key: string | null, amount = 1_000): Promise<void> {
  await db.run(
    `INSERT INTO cash_money_entries (id, project_id, opportunity_id, kind, amount_cents, currency,
       verified_reference, funds_available_at, occurred_at, note, recorded_by, created_at,
       idempotency_key, payload_fingerprint, commitment_id)
     VALUES (?, 'prj_1', NULL, ?, ?, 'USD', NULL, NULL, ?, 'carried', 'usr_1', ?, ?, NULL, NULL)`,
    [id, kind, amount, AT, AT, key],
  );
}

describe('the post-sale migrations over a populated ledger', () => {
  it('carry every entry, keep the key index, accept the new kinds, and boot twice', async () => {
    expect(INVOICES).toBeDefined();
    const dbPath = path.join(workspace, 'brain.db');
    await runMigrations(db, dbPath, chainUpTo(INVOICES.version - 1));

    await db.run(
      `INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES ('prj_1', 'p', 'P', ?, ?)`,
      [AT, AT],
    );
    // One entry of every kind production can already hold; one with no key,
    // because the rows from before 053 carry none.
    for (const [index, kind] of KINDS.entries()) {
      await entry(`cme_${index}`, kind, `key-${index}`, 1_000 + index);
    }
    await entry('cme_legacy', 'COST', null, 77);
    const before = await db.all<{ id: string; kind: string; amount_cents: number }>(
      'SELECT id, kind, amount_cents FROM cash_money_entries ORDER BY id',
    );

    await runMigrations(db, dbPath, DIR);

    const after = await db.all<{ id: string; kind: string; amount_cents: number }>(
      'SELECT id, kind, amount_cents FROM cash_money_entries ORDER BY id',
    );
    expect(after.map((row) => ({ ...row, amount_cents: Number(row.amount_cents) }))).toEqual(
      before.map((row) => ({ ...row, amount_cents: Number(row.amount_cents) })),
    );

    // The idempotency index came back with the table.
    await expect(entry('cme_dup', 'COST', 'key-0')).rejects.toThrow();
    // And the two kinds the post-sale model writes are now accepted.
    await entry('cme_released', 'PIPELINE_RELEASED', 'agreement-released:agr_1');
    await entry('cme_commit_released', 'COMMITMENT_RELEASED', 'fulfillment-cost:cfl_1:x');
    // While anything else still is not.
    await expect(entry('cme_bad', 'NOT_A_KIND', 'nope')).rejects.toThrow();

    // The tables the model reads exist and are empty.
    for (const table of ['cash_invoices', 'cash_agreements', 'cash_fulfillments', 'cash_fulfillment_events', 'cash_outcomes', 'cash_observations']) {
      const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(count?.n), table).toBe(0);
    }

    // A second boot over the migrated database applies nothing and moves no row.
    const second = await runMigrations(db, dbPath, DIR);
    expect(second.applied).toEqual([]);
    const total = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cash_money_entries');
    expect(Number(total?.n)).toBe(before.length + 2);
  });
});
