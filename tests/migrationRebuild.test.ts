/**
 * Migrating a Brain that already has people in it.
 *
 * Every other suite migrates an empty database, which is the path that cannot
 * fail: there is nothing to carry across and nothing for a cascade to reach. A
 * table rebuild is only dangerous over rows, so this one puts rows there first.
 *
 * It exists because the passkey migration was written twice and both versions
 * were silently destructive. `PRAGMA foreign_keys` is a documented no-op inside
 * a transaction, so a rebuild written the obvious way keeps foreign keys on:
 * `DROP TABLE users` performs an implicit DELETE, every `ON DELETE CASCADE`
 * aimed at `users` fires, and the migration **succeeds** having deleted the
 * sessions, conversations, messages, collections, preferences and milestones
 * those cascades reached. Renaming instead does not help — with foreign keys on
 * a rename rewrites the other tables' `REFERENCES` clauses to follow it.
 *
 * Neither failure is visible from reading the file, from a typecheck, or from a
 * suite that migrates an empty database. It is visible from one row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../server/db/adapters/sqlite.ts';
import { loadMigrationFiles, runMigrations } from '../server/db/migrate.ts';

const MIGRATIONS = fileURLToPath(new URL('../server/db/migrations', import.meta.url));

/** The migration that relaxes `users`, found by its marker rather than by number. */
const MARKER = '-- brain:rebuild-without-foreign-keys';

let workspace = '';

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-migrate-'));
});

afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

/** Copy the migration files below `upTo` into a directory of their own. */
function chainUpTo(upTo: number): string {
  const dir = path.join(workspace, `chain-${upTo}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of loadMigrationFiles(MIGRATIONS)) {
    if (file.version > upTo) continue;
    fs.writeFileSync(path.join(dir, file.filename), file.sql);
  }
  return dir;
}

describe('a rebuild of a table people are already in', () => {
  it('carries every row across and destroys nothing a cascade points at', async () => {
    const rebuilds = loadMigrationFiles(MIGRATIONS).filter((file) => file.sql.startsWith(MARKER));
    // If nothing carries the marker there is nothing to prove here, and a test
    // that silently passed on an empty set would be the mechanism nothing calls.
    expect(rebuilds.length).toBeGreaterThan(0);
    const rebuild = rebuilds[0]!;

    const before = chainUpTo(rebuild.version - 1);
    const dbPath = path.join(workspace, 'brain.db');
    const db = openSqlite(dbPath);
    try {
      await runMigrations(db, dbPath, before);

      /*
       * A person, and one row from every kind of thing that cascades off them:
       * a session, a conversation, and a message inside it. These are the rows
       * the destructive version deleted while reporting success.
       */
      const at = '2026-01-01T00:00:00.000Z';
      await db.run(
        `INSERT INTO users (id, email, display_name, password_algorithm, password_verifier,
           password_updated_at, must_change_password, is_brain_admin, disabled_at,
           created_by_type, created_by_id, created_at, updated_at)
         VALUES ('usr_1', 'somebody@example.invalid', 'Somebody', 'scrypt', 'scrypt$never',
           ?, 0, 1, NULL, NULL, NULL, ?, ?)`,
        [at, at, at],
      );
      await db.run(
        `INSERT INTO user_sessions (id, user_id, token_verifier, issued_at, expires_at)
         VALUES ('ses_1', 'usr_1', 'a-digest', ?, '2027-01-01T00:00:00.000Z')`,
        [at],
      );
      const project = await db.get<{ id: string }>('SELECT id FROM projects LIMIT 1');
      await db.run(
        `INSERT INTO russell_conversations (id, owner_user_id, project_id, title, visibility,
           created_at, updated_at)
         VALUES ('rcv_1', 'usr_1', ?, 'A thread', 'PRIVATE', ?, ?)`,
        [project?.id ?? null, at, at],
      );

      // Now the rebuild itself, over those rows.
      const after = chainUpTo(rebuild.version);
      const report = await runMigrations(db, dbPath, after);
      expect(report.applied.map((one) => one.version)).toContain(rebuild.version);

      const users = await db.all<{ id: string; email: string | null }>('SELECT * FROM users');
      expect(users).toHaveLength(1);
      expect(users[0]!.email).toBe('somebody@example.invalid');

      const sessions = await db.all('SELECT id FROM user_sessions');
      const conversations = await db.all('SELECT id FROM russell_conversations');
      expect(sessions).toHaveLength(1);
      expect(conversations).toHaveLength(1);

      // And the schema is genuinely consistent afterwards, not merely populated.
      expect(await db.all('PRAGMA foreign_key_check')).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('leaves the connection enforcing foreign keys again afterwards', async () => {
    const dbPath = path.join(workspace, 'brain.db');
    const db = openSqlite(dbPath);
    try {
      await runMigrations(db, dbPath, MIGRATIONS);
      /*
       * The pragma is restored on the way out, including on the failure path. A
       * Brain that carried on with foreign keys off would have had its
       * constraints quietly stop applying, which is worse than the failed
       * migration that turned them off.
       */
      const state = await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(Number(state?.foreign_keys)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('accepts what the rebuild exists for: a member with no address at all', async () => {
    const dbPath = path.join(workspace, 'brain.db');
    const db = openSqlite(dbPath);
    try {
      await runMigrations(db, dbPath, MIGRATIONS);
      const at = '2026-01-01T00:00:00.000Z';
      await db.run(
        `INSERT INTO users (id, email, display_name, password_algorithm, password_verifier,
           password_updated_at, must_change_password, is_brain_admin, disabled_at,
           created_by_type, created_by_id, created_at, updated_at)
         VALUES ('usr_p', NULL, 'Passkey person', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, ?, ?)`,
        [at, at],
      );
      // Two of them, because a UNIQUE column that refused a second NULL would
      // make this a one-member Brain.
      await db.run(
        `INSERT INTO users (id, email, display_name, password_algorithm, password_verifier,
           password_updated_at, must_change_password, is_brain_admin, disabled_at,
           created_by_type, created_by_id, created_at, updated_at)
         VALUES ('usr_q', NULL, 'Another one', NULL, NULL, NULL, 0, 0, NULL, NULL, NULL, ?, ?)`,
        [at, at],
      );
      expect(await db.all('SELECT id FROM users WHERE email IS NULL')).toHaveLength(2);
    } finally {
      await db.close();
    }
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Every rebuild, not only the first one.
 *
 * The suite above finds `rebuilds[0]` and proves that one carries its rows
 * across — which was right while there was one, and quietly stopped covering
 * anything the moment a second migration took the marker. A guard that only
 * ever examines the first member of a growing set is the *mechanism nothing
 * calls* at a new altitude: it keeps passing, and it stops being about the
 * thing that changed.
 *
 * So this walks all of them. For each, it migrates to the version before,
 * counts every row in every table, applies the rebuild, and asserts that
 * nothing lost rows and that the schema is consistent afterwards. It cannot
 * know what a future rebuild will be about; it can know that a rebuild which
 * deletes rows is always wrong.
 */
describe('every rebuild in the chain, not only the first', () => {
  it('carries every table across and leaves the schema consistent', async () => {
    const rebuilds = loadMigrationFiles(MIGRATIONS).filter((file) => file.sql.startsWith(MARKER));
    expect(rebuilds.length).toBeGreaterThan(0);

    for (const rebuild of rebuilds) {
      const dbPath = path.join(workspace, `chain-${rebuild.version}.db`);
      const db = openSqlite(dbPath);
      try {
        await runMigrations(db, dbPath, chainUpTo(rebuild.version - 1));

        const tables = (
          await db.all<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
        ).map((one) => one.name);
        const before = new Map<string, number>();
        for (const table of tables) {
          const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
          before.set(table, Number(row?.n ?? 0));
        }

        const report = await runMigrations(db, dbPath, chainUpTo(rebuild.version));
        expect(report.applied.map((one) => one.version)).toContain(rebuild.version);

        for (const [table, count] of before) {
          const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
          expect(
            Number(row?.n ?? -1),
            `${rebuild.filename} lost rows from ${table}`,
          ).toBeGreaterThanOrEqual(count);
        }
        expect(
          await db.all('PRAGMA foreign_key_check'),
          `${rebuild.filename} left a dangling reference`,
        ).toHaveLength(0);
      } finally {
        await db.close();
      }
    }
  });

  it('carries a member’s half-finished Claude setup across the connection rebuild', async () => {
    /*
     * The row counts above are only as good as there being rows, and the
     * connection rebuild is precisely the one whose table is empty in every
     * other suite. So this puts a real half-finished setup there — the shape a
     * member is actually in while they wait for an administrator — and reads
     * every column back afterwards.
     */
    const rebuild = loadMigrationFiles(MIGRATIONS)
      .filter((file) => file.sql.startsWith(MARKER))
      .find((file) => file.sql.includes('capacity_connections'));
    expect(rebuild, 'no rebuild touches capacity_connections').toBeTruthy();

    const dbPath = path.join(workspace, 'connection.db');
    const db = openSqlite(dbPath);
    try {
      await runMigrations(db, dbPath, chainUpTo(rebuild!.version - 1));
      const at = '2026-01-01T00:00:00.000Z';
      await db.run(
        `INSERT INTO users (id, email, display_name, password_algorithm, password_verifier,
           password_updated_at, must_change_password, is_brain_admin, disabled_at,
           created_by_type, created_by_id, created_at, updated_at)
         VALUES ('usr_1', 'somebody@example.invalid', 'Somebody', 'scrypt', 'scrypt$never',
           ?, 0, 0, NULL, NULL, NULL, ?, ?)`,
        [at, at, at],
      );
      await db.run(
        `INSERT INTO capacity_connections
           (id, user_id, connector_name, routine_name, secret_name, trigger_ref,
            account_id, routine_id, state, probe_bin_id, probe_sent_at, healthy_at,
            created_at, updated_at)
         VALUES ('cxn_1', 'usr_1', 'Brain (Somebody)', 'Brain Research — Somebody',
                 'BRAIN_ROUTINE_TOKEN_SOMEBODY', 'trig_01ABCDEFGHIJKLMNOPQR',
                 'acct_1', 'rtn_1', 'WAITING_FOR_ADMIN', NULL, NULL, NULL, ?, ?)`,
        [at, at],
      );

      await runMigrations(db, dbPath, chainUpTo(rebuild!.version));

      const row = await db.get<Record<string, unknown>>(
        'SELECT * FROM capacity_connections WHERE id = ?',
        ['cxn_1'],
      );
      expect(row).toBeTruthy();
      // The three names in particular: one of them is what an administrator was
      // told to set, and a rebuild that changed it would send them to set a
      // variable nothing reads.
      expect(row!['connector_name']).toBe('Brain (Somebody)');
      expect(row!['secret_name']).toBe('BRAIN_ROUTINE_TOKEN_SOMEBODY');
      expect(row!['trigger_ref']).toBe('trig_01ABCDEFGHIJKLMNOPQR');
      expect(row!['routine_id']).toBe('rtn_1');
      expect(row!['state']).toBe('WAITING_FOR_ADMIN');
      expect(row!['created_at']).toBe(at);
      // And the new columns arrive empty rather than invented: the three new
      // states are reachable only by a transition somebody makes from here on.
      expect(row!['invitation_requested_at']).toBeNull();
      expect(row!['revoked_at']).toBeNull();

      // The indexes the journey's idempotency rests on are still there.
      const indexes = (
        await db.all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'capacity_connections'`,
        )
      ).map((one) => one.name);
      expect(indexes).toContain('idx_capacity_connections_user');
      expect(indexes).toContain('idx_capacity_connections_trigger');
      expect(indexes).toContain('idx_capacity_connections_secret');
    } finally {
      await db.close();
    }
  });
});
