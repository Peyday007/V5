/**
 * `npx tsx scripts/upgrade-check.ts` — does the newest migration apply to a
 * database that already holds data?
 *
 * The suites prove "from empty", which is the easier half. Production is at the
 * previous version with real rows in it, so the question that actually matters
 * is whether the new migration applies *over* them without loss — and the only
 * honest way to ask is to build a populated database, put it back one version,
 * and re-migrate exactly as a boot would.
 *
 * It follows whatever `server/config.ts` resolves, so it checks SQLite by
 * default and Postgres when `BRAIN_DATABASE_PROVIDER=postgres` and
 * `BRAIN_DATABASE_URL` are set. It writes only to the database it is pointed
 * at, and it destroys that database's data directory first — so point it at a
 * scratch one, never at anything real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const root = process.env['BRAIN_DATA_DIR']!;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

await initDatabase();

// Real rows, of the kind production has.
//
// Two projects, because migration 028 classifies them differently and a
// fixture with only one cannot tell a default from a backfill.
await getDb().run(
  `INSERT INTO projects (id, name, slug, description, created_at, updated_at)
   VALUES ('prj_up', 'Upgrade check', 'upgrade-check', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
);
await getDb().run(
  `INSERT INTO conversations (id, project_id, layer_id, run_id, title, provider_conversation_id, created_at, updated_at)
   VALUES ('cnv_up', 'prj_up', NULL, NULL, 'Project Chat', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
);
await getDb().run(
  `INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
   VALUES ('msg_up', 'cnv_up', 'user', 'an older question', '{}', '2026-01-01T00:00:00.000Z')`,
);
// The scope migration 028 must reclassify. Its slug is the whole test: the
// backfill names it exactly, because a LIKE would be the naming convention the
// column replaces.
await getDb().run(
  `INSERT INTO projects (id, name, slug, description, created_at, updated_at)
   VALUES ('prj_up_scope', 'Verification scope', 'verification-scope', NULL,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
);

const before = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM messages');

// Put it back to 026: drop what 027 added and forget it ever ran.
// Reverse dependency order. SQLite tolerates any order; Postgres refuses to
// drop a table another one still references, which is a better error than
// SQLite's silence and is the reason this list is ordered rather than
// alphabetical.
/*
 * Put the database back, by name.
 *
 * Three migrations are undone rather than one, because production is behind by
 * three and "the newest migration applies" is not the question — "the boot a
 * person is about to perform applies" is. Reverse dependency order: Postgres
 * refuses to drop a table another one still references, which is a better
 * error than SQLite's silence and is the reason this list is ordered rather
 * than alphabetical.
 *
 * By **name**, never by number. The two chains are numbered independently and
 * their versions do not mean the same thing: the Russell migration is 027 on
 * SQLite and 018 on Postgres. A hard-coded `version >= 27` therefore deleted
 * nothing on Postgres, the runner believed the migration was already applied,
 * and the tables stayed dropped — exactly the confusion CLAUDE.md §3 warns
 * about, reproduced by somebody who had read the warning.
 */
const UNDO: {
  name: string;
  tables: string[];
  /**
   * Indexes to drop before the columns they cover.
   *
   * SQLite refuses to drop a column an index still references, with an error
   * about the index rather than the column — which is a better error than
   * Postgres's silent cascade, and the reason this is a separate list instead
   * of something the column drop is trusted to handle.
   */
  indexes: string[];
  columns: [string, string][];
}[] = [
  {
    name: 'conversation_lanes',
    indexes: [],
    tables: [
      'spend_reservations',
      'spend_ledger',
      'spend_authorizations',
      'llm_models',
      'russell_rules',
      'conversation_reviews',
    ],
    columns: [],
  },
  {
    name: 'project_purpose',
    tables: [],
    indexes: ['idx_projects_purpose'],
    columns: [['projects', 'purpose']],
  },
  {
    name: 'russell',
    indexes: [],
    tables: [
      'russell_probe_observations',
      'russell_candidate_merges',
      'russell_knowledge',
      'russell_human_requests',
      'russell_missions',
      'russell_probes',
      'russell_budget_reservations',
      'russell_goals',
      'russell_candidates',
      'russell_messages',
      'russell_conversation_context',
      'russell_conversations',
      'russell_cycle',
    ],
    columns: [],
  },
];

for (const step of UNDO) {
  for (const index of step.indexes) {
    await getDb().run(`DROP INDEX IF EXISTS ${index}`);
  }
  for (const table of step.tables) {
    await getDb().run(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const [table, column] of step.columns) {
    await getDb().run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  await getDb().run(`DELETE FROM schema_migrations WHERE name = ?`, [step.name]);
}

const before026 = await getDb().all<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
await closeDatabase();

// Boot again, exactly as production would.
await initDatabase();

const after = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM messages');
const version = await getDb().all<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
const cycle = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM russell_cycle');
const conv = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM russell_conversations');
const projects = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM projects');

// 028: an ordinary project defaults, a named scope is reclassified. Both, or
// the column proves nothing.
const ordinary = await getDb().all<{ purpose: string }>(
  `SELECT purpose FROM projects WHERE id = 'prj_up'`,
);
const scope = await getDb().all<{ purpose: string }>(
  `SELECT purpose FROM projects WHERE id = 'prj_up_scope'`,
);

// 029: the tables exist and are **empty**. Empty is the point — no
// authorization means no ceiling means no paid call is possible on a Brain
// that has just been upgraded.
const spendRows = await getDb().all<{ n: number }>(
  'SELECT COUNT(*) AS n FROM spend_authorizations',
);
const modelRows = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM llm_models');
const reviewRows = await getDb().all<{ n: number }>(
  'SELECT COUNT(*) AS n FROM conversation_reviews',
);

console.log(`  was at        ${before026[0]!.v}`);
console.log(`  now at        ${version[0]!.v}`);
console.log(`  messages      ${before[0]!.n} before, ${after[0]!.n} after`);
console.log(`  projects      ${projects[0]!.n}`);
console.log(`  cycle rows    ${cycle[0]!.n}`);
console.log(`  russell convs ${conv[0]!.n}`);
console.log(`  purpose       ordinary=${ordinary[0]?.purpose} scope=${scope[0]?.purpose}`);
console.log(`  spend tables  authorizations=${spendRows[0]!.n} models=${modelRows[0]!.n} reviews=${reviewRows[0]!.n}`);

const ok =
  before[0]!.n === after[0]!.n &&
  before[0]!.n === 1 &&
  projects[0]!.n === 2 &&
  cycle[0]!.n === 1 &&
  version[0]!.v > before026[0]!.v &&
  ordinary[0]?.purpose === 'PROJECT' &&
  scope[0]?.purpose === 'TECHNICAL' &&
  spendRows[0]!.n === 0 &&
  modelRows[0]!.n === 0 &&
  reviewRows[0]!.n === 0;

console.log(ok ? 'UPGRADE: OK' : 'UPGRADE: FAILED');
await closeDatabase();
process.exit(ok ? 0 : 1);
