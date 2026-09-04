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

const before = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM messages');

// Put it back to 026: drop what 027 added and forget it ever ran.
for (const table of [
  'russell_probe_observations', 'russell_probes', 'russell_candidate_merges',
  'russell_candidates', 'russell_budget_reservations', 'russell_goals',
  'russell_knowledge', 'russell_human_requests', 'russell_missions',
  'russell_messages', 'russell_conversation_context', 'russell_conversations',
  'russell_cycle',
]) {
  await getDb().run(`DROP TABLE IF EXISTS ${table}`);
}
await getDb().run(`DELETE FROM schema_migrations WHERE version >= 27`);
const at026 = await getDb().all<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
await closeDatabase();

// Boot again, exactly as production would.
await initDatabase();
const after = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM messages');
const version = await getDb().all<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations');
const cycle = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM russell_cycle');
const conv = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM russell_conversations');

console.log(`  was at        ${at026[0]!.v}`);
console.log(`  now at        ${version[0]!.v}`);
console.log(`  messages      ${before[0]!.n} before, ${after[0]!.n} after`);
console.log(`  cycle rows    ${cycle[0]!.n}`);
console.log(`  russell convs ${conv[0]!.n}`);
const ok =
  before[0]!.n === after[0]!.n && before[0]!.n === 1 && cycle[0]!.n === 1 && version[0]!.v > at026[0]!.v;
console.log(ok ? 'UPGRADE: OK' : 'UPGRADE: FAILED');
await closeDatabase();
process.exit(ok ? 0 : 1);
