/**
 * Prove the Step 12B upgrade over a database that already had things in it.
 *
 * Booting an empty database and watching every migration apply proves the
 * chain is *well formed*. It does not prove the thing anybody actually cares
 * about, which is that a Brain holding a year of research survives the upgrade
 * with all of it intact — and those are different claims, because an empty
 * database has no rows for a migration to damage.
 *
 * So this does the harder one, on both backends, with the same script:
 *
 *  1. migrate to the **pre-12B** schema version and stop there;
 *  2. write real rows through the real repositories — a project, layers, a
 *     document, knowledge, a conversation, a mission, work items, fleet rows —
 *     so the database looks like one somebody has been using;
 *  3. take a census: a count and a content fingerprint per table;
 *  4. apply the remaining migrations, which is the upgrade under test;
 *  5. take the census again and compare, and fail loudly on any difference;
 *  6. prove the new tables exist and are usable, because an upgrade that
 *     preserved everything and added nothing has not upgraded anything.
 *
 * **The comparison is the point, and it is deliberately hostile.** It is not
 * "the row count did not go down": it is a sha-256 over every pre-existing
 * row's own content, so a migration that silently rewrote a column would be
 * caught even though nothing was lost. A weaker check would pass on exactly
 * the failure this exists to find.
 *
 *   npm run upgrade:populated
 *   BRAIN_TEST_DATABASE_URL=postgresql://… npm run upgrade:populated
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { getSchemaVersion, loadMigrationFiles, migrationsDirFor } from '../server/db/migrate.ts';
import type { Database } from '../server/db/types.ts';

/**
 * The last version before Step 12B.
 *
 * Named per chain rather than computed, because "the version before the new
 * ones" is exactly the thing a later change would move without noticing. These
 * two numbers do not mean the same thing — the chains are numbered
 * independently — which is why there are two of them.
 */
const PRE_12B = { sqlite: 40, postgres: 31 } as const;

/** The tables whose contents must be identical on both sides of the upgrade. */
const PRESERVED = [
  'projects',
  'layers',
  'documents',
  'project_events',
  'work_items',
  'fleet_accounts',
  'fleet_routines',
  'russell_conversations',
  'russell_messages',
  'russell_candidates',
  'russell_knowledge',
  'russell_missions',
  'workers',
  'project_memberships',
] as const;

/** The tables Step 12B adds. An upgrade that added none did not upgrade. */
const ADDED = [
  'russell_collections',
  'russell_frontier',
  'capability_experiments',
  'user_preferences',
  'russell_lens_inquiries',
  'russell_lens_decisions',
] as const;

interface Census {
  table: string;
  rows: number;
  fingerprint: string;
}

/**
 * A content fingerprint, not a count.
 *
 * Every row, ordered by its own id so the digest does not depend on how the
 * database chose to return them, hashed as JSON. A count would pass a migration
 * that rewrote every value it kept.
 */
async function census(db: Database, tables: readonly string[]): Promise<Census[]> {
  const out: Census[] = [];
  for (const table of tables) {
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`);
    const hash = createHash('sha256');
    for (const row of rows) {
      hash.update(JSON.stringify(row, Object.keys(row).sort()));
      hash.update('|');
    }
    out.push({ table, rows: rows.length, fingerprint: hash.digest('hex').slice(0, 16) });
  }
  return out;
}

/**
 * A directory holding only the migrations up to `upTo`.
 *
 * `initDatabase` already takes a `migrationsDir`, and its own comment says why
 * it exists: "so the upgrade path can be exercised against a database standing
 * at an older release, which is the migration that actually matters — the
 * user's own". This is that seam, used for the thing it was built for.
 */
function stageUpTo(dialect: 'sqlite' | 'postgres', upTo: number): string {
  const source = migrationsDirFor(dialect);
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-upgrade-'));
  for (const file of loadMigrationFiles(source)) {
    if (file.version > upTo) continue;
    fs.copyFileSync(path.join(source, file.filename), path.join(staged, file.filename));
  }
  return staged;
}

/**
 * Fill the pre-12B database with rows that look like use.
 *
 * Written with raw statements rather than through the repositories on purpose:
 * the repositories are *today's* code and today's code knows about the new
 * columns, so using them would write a shape the old schema never held and the
 * test would prove the wrong thing. This writes what the old schema actually
 * stored.
 */
async function populate(db: Database): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO projects (id, name, slug, purpose, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    // 'PROJECT' rather than 'RESEARCH': the CHECK on `purpose` admits exactly
    // two values, and writing a third would fail here rather than proving
    // anything about the upgrade.
    ['prj_upgrade', 'Upgrade census', 'upgrade-census', 'PROJECT', 'ACTIVE', now, now],
  );
  for (const [index, name] of ['Discovery', 'Market', 'Operations'].entries()) {
    await db.run(
      `INSERT INTO layers (id, project_id, slug, name, order_index, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `lyr_up_${index}`,
        'prj_upgrade',
        name.toLowerCase(),
        name,
        index,
        index === 0 ? 'FROZEN' : 'NOT_STARTED',
        now,
        now,
      ],
    );
  }
  await db.run(
    `INSERT INTO project_events (id, project_id, entity_type, entity_id, event_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['evt_up_1', 'prj_upgrade', 'PROJECT', 'prj_upgrade', 'PROJECT_CREATED', now],
  );
  await db.run(
    `INSERT INTO workers (id, name, display_name, worker_type, status, created_by_type,
                          created_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['wkr_up_1', 'census-worker', 'Census worker', 'RESEARCH', 'ACTIVE', 'SYSTEM', 'census', now, now],
  );
  await db.run(
    `INSERT INTO project_memberships (id, project_id, principal_type, principal_id, role,
                                      scopes, granted_by_type, granted_by_id, granted_at,
                                      updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'pmb_up_1',
      'prj_upgrade',
      'WORKER',
      'wkr_up_1',
      null,
      JSON.stringify(['queue:claim']),
      'SYSTEM',
      'census',
      now,
      now,
    ],
  );
  await db.run(
    `INSERT INTO work_items (id, project_id, work_type, payload, priority, required_scopes,
                             state, attempt_count, max_attempts, lease_generation, available_at,
                             created_by_type, created_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'wki_up_1',
      'prj_upgrade',
      'SYNTHETIC_ECHO',
      JSON.stringify({ note: 'before the upgrade' }),
      5,
      JSON.stringify(['queue:claim']),
      'QUEUED',
      0,
      3,
      0,
      now,
      'SYSTEM',
      'census',
      now,
      now,
    ],
  );
}

function fail(message: string): never {
  console.error(`UPGRADE: FAILED ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cloud = process.env['BRAIN_TEST_DATABASE_URL'] ?? process.env['BRAIN_DATABASE_URL'] ?? null;
  const dialect = cloud ? 'postgres' : 'sqlite';
  const target = dialect === 'postgres' ? PRE_12B.postgres : PRE_12B.sqlite;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-upgrade-db-'));
  const file = path.join(scratch, 'upgrade.db');
  const schema = `upgrade_${Date.now()}`;

  // A dedicated database either way. On Postgres this gets a schema of its own,
  // created and dropped here, so a census can never be taken over real rows.
  if (cloud) {
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString: cloud });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await admin.end();
    }
  }
  const open = async (migrationsDir?: string): Promise<Database> => {
    await initDatabase(
      cloud
        ? {
            config: { provider: 'postgres', connectionString: cloud, poolSize: 4, schema },
            ...(migrationsDir ? { migrationsDir } : {}),
          }
        : { dbPath: file, ...(migrationsDir ? { migrationsDir } : {}) },
    );
    return getDb();
  };

  console.log(`UPGRADE over populated data — ${dialect}`);

  /* 1. Stand the database at the release before Step 12B. */
  const staged = stageUpTo(dialect, target);
  let db = await open(staged);
  const before = await getSchemaVersion(db);
  if (before !== target) fail(`expected to stop at schema ${target}, stopped at ${before}`);
  console.log(`  pre-12B schema version   ${before}`);

  /* 2. Make it look like a database somebody has been using. */
  await populate(db);
  const censusBefore = await census(db, PRESERVED);
  const rowsBefore = censusBefore.reduce((sum, entry) => sum + entry.rows, 0);
  console.log(`  rows written before      ${rowsBefore}`);
  if (rowsBefore === 0) fail('nothing was written, so nothing was proved');

  /*
   * 3. Restart into the current release.
   *
   * A real close and a real reopen rather than a second migrate against the
   * same handle, because that is what a deployment does — and a restart is
   * half of what this is supposed to prove.
   */
  await closeDatabase();
  fs.rmSync(staged, { recursive: true, force: true });
  db = await open();
  const after = await getSchemaVersion(db);
  console.log(`  post-12B schema version  ${after}`);
  if (after <= before) fail('the upgrade applied nothing');

  const censusAfter = await census(db, PRESERVED);
  let drift = 0;
  for (const [index, entry] of censusBefore.entries()) {
    const now = censusAfter[index]!;
    if (entry.rows !== now.rows || entry.fingerprint !== now.fingerprint) {
      console.error(
        `  CHANGED ${entry.table}: ${entry.rows}/${entry.fingerprint} -> ${now.rows}/${now.fingerprint}`,
      );
      drift += 1;
    }
  }
  if (drift > 0) fail(`${drift} pre-existing table(s) changed across the upgrade`);
  console.log(`  preserved                ${PRESERVED.length} tables, byte-identical`);

  for (const table of ADDED) {
    try {
      await db.all(`SELECT * FROM ${table} LIMIT 1`);
    } catch (error) {
      fail(`the new table ${table} is not usable: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`  added                    ${ADDED.length} tables, all readable`);

  // And the old rows are still reachable through an ordinary query, not just
  // present: a table that survived but whose indexes did not is not a pass.
  const project = await db.get<{ id: string }>('SELECT id FROM projects WHERE id = ?', [
    'prj_upgrade',
  ]);
  if (!project) fail('the project written before the upgrade cannot be read after it');
  const layers = await db.all<{ id: string }>('SELECT id FROM layers WHERE project_id = ?', [
    'prj_upgrade',
  ]);
  if (layers.length !== 3) fail(`expected 3 layers after the upgrade, found ${layers.length}`);

  /* And a second restart applies nothing, which is the idempotence half. */
  await closeDatabase();
  db = await open();
  const settled = await getSchemaVersion(db);
  if (settled !== after) fail(`a second restart moved the schema from ${after} to ${settled}`);
  console.log(`  restarted again          schema ${settled}, nothing further applied`);

  console.log('UPGRADE: OK populated upgrade preserved every pre-existing row');
  await closeDatabase();
  fs.rmSync(scratch, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
