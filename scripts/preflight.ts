/**
 * `npm run preflight` — read the cloud Brain, change nothing, and say whether
 * the next migration can succeed.
 *
 * This exists because Supabase's free plan has no scheduled backups, and
 * "back it up first" is advice you cannot follow when there is nothing to click.
 * It is **not a backup** and does not pretend to be: it copies no rows and no
 * documents, and it will not restore anything. Saying otherwise would be worse
 * than having nothing, because somebody would rely on it.
 *
 * What it is instead is the two things a backup would have been used for:
 *
 *   1. **A record of what was there before**, as counts per table, written to a
 *      local file with a sha-256 so the same command afterwards can be compared
 *      against it. If a migration ever did lose something, this is what turns
 *      "it feels emptier" into a number.
 *   2. **The pre-flight for the one thing that can actually fail.** Migration
 *      004 adds the three uniqueness constraints the cloud schema has been
 *      missing. Adding a unique index to a table that already holds duplicates
 *      fails — correctly, and having changed nothing — so this looks first and
 *      names the rows a person would have to decide between.
 *
 * Nothing here prints a credential. The database is named by host and database,
 * never by connection string, exactly as every other diagnostic in this project.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKUP_ROOT, ensureDataDirs } from '../server/env.ts';
import { databaseConfig, describePersistence, persistenceConfig } from '../server/config.ts';
import { DatabaseConfigurationError } from '../server/db/types.ts';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

/**
 * The tables worth counting.
 *
 * Not every table: the point is a number a person can recognise, so this is the
 * research itself plus the identity state Step 4 introduces. A count that
 * changed unexpectedly in any of these is worth stopping for.
 */
const COUNTED = [
  'projects',
  'layers',
  'documents',
  'research_runs',
  'audits',
  'project_events',
  'extraction_runs',
  'document_chunks',
  'research_orchestrations',
  'research_claims',
  'document_segments',
] as const;

/** Only present after migration 014/003; absent before it, which is not an error. */
const IDENTITY_TABLES = [
  'users',
  'user_sessions',
  'workers',
  'worker_credentials',
  'project_memberships',
  'identity_events',
] as const;

interface DuplicateGroup {
  what: string;
  key: string;
  count: number;
}

async function countOf(table: string): Promise<number | null> {
  try {
    const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(row?.n ?? 0);
  } catch {
    // The table does not exist yet. That is information, not a failure.
    return null;
  }
}

/**
 * The three constraints migration 004 adds, checked before it tries.
 *
 * Each of these is a pair of rows the Brain has always treated as one thing.
 * Only a person can decide which is real, so this names them and stops.
 */
async function duplicatesBlockingMigration(): Promise<DuplicateGroup[]> {
  const found: DuplicateGroup[] = [];

  const queries: { what: string; sql: string }[] = [
    {
      what: 'two projects with the same slug',
      sql: `SELECT slug AS key, COUNT(*) AS n FROM projects GROUP BY slug HAVING COUNT(*) > 1`,
    },
    {
      what: 'two layers with the same slug in one project',
      sql: `SELECT project_id || ' / ' || slug AS key, COUNT(*) AS n
              FROM layers GROUP BY project_id, slug HAVING COUNT(*) > 1`,
    },
    {
      what: 'two documents with the same canonical name in one project',
      sql: `SELECT project_id || ' / ' || canonical_name AS key, COUNT(*) AS n
              FROM documents GROUP BY project_id, canonical_name HAVING COUNT(*) > 1`,
    },
  ];

  for (const query of queries) {
    const rows = await getDb().all<{ key: string; n: number }>(query.sql);
    for (const row of rows) {
      found.push({ what: query.what, key: row.key, count: Number(row.n) });
    }
  }
  return found;
}

async function main(): Promise<void> {
  let config;
  try {
    config = databaseConfig();
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) {
      console.error(`\n  ${error.message}\n  ${error.detail}\n`);
      process.exit(2);
    }
    throw error;
  }

  // Described by the same helper the boot banner uses, which names a host and a
  // database and has never been allowed to name a credential.
  const target = describePersistence(persistenceConfig()).database.target;

  console.log('');
  console.log('  Pre-flight — reads only, writes nothing to the database.');
  console.log('');
  console.log(`  Database        ${config.provider} · ${target}`);

  // Opening applies pending migrations, which is exactly what we do NOT want
  // before reporting on the state that precedes them. `migrationsDir` is
  // pointed at an empty directory so the schema is left as it is found.
  ensureDataDirs();
  const emptyMigrations = fs.mkdtempSync(path.join(BACKUP_ROOT, 'preflight-'));
  try {
    await initDatabase({ migrationsDir: emptyMigrations });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = (error as { detail?: string }).detail ?? '';
    console.error(`\n  Could not read it.\n\n  ${message}\n  ${detail}\n`);
    process.exit(2);
  }

  const version = await getDb()
    .get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations')
    .then((row) => Number(row?.v ?? 0))
    .catch(() => 0);
  console.log(`  Schema version  ${version}`);
  console.log('');

  const counts: Record<string, number | null> = {};
  console.log('  What is in it');
  for (const table of COUNTED) {
    const n = await countOf(table);
    counts[table] = n;
    console.log(`    ${table.padEnd(26)} ${n === null ? '(no such table)' : n}`);
  }

  console.log('');
  console.log('  Identity state (present only after the Step 4 migration)');
  let identityPresent = false;
  for (const table of IDENTITY_TABLES) {
    const n = await countOf(table);
    counts[table] = n;
    if (n !== null) identityPresent = true;
    console.log(`    ${table.padEnd(26)} ${n === null ? 'not yet' : n}`);
  }

  console.log('');
  const duplicates = await duplicatesBlockingMigration();
  if (duplicates.length === 0) {
    console.log('  Nothing blocks the Step 4 migration: no duplicate slugs or canonical names.');
  } else {
    console.log('  STOP — the Step 4 migration would fail on these, having changed nothing:');
    console.log('');
    for (const duplicate of duplicates) {
      console.log(`    ${duplicate.what}: "${duplicate.key}" appears ${duplicate.count} times`);
    }
    console.log('');
    console.log('    Each pair is two rows this Brain has always treated as one thing, and only');
    console.log('    a person can decide which is real. Resolve them, then run this again.');
  }

  // The record. Counts and a schema version — no row content, no credential.
  const snapshot = {
    takenAt: new Date().toISOString(),
    database: { provider: config.provider, target },
    schemaVersion: version,
    identityTablesPresent: identityPresent,
    counts,
    duplicatesBlockingMigration: duplicates.length,
  };
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const file = path.join(BACKUP_ROOT, `preflight-${snapshot.takenAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, body, 'utf8');

  console.log('');
  console.log(`  Recorded        ${file}`);
  console.log(`  sha-256         ${digest}`);
  console.log('');
  console.log('  This is a record, not a backup. It restores nothing. Run it again after the');
  console.log('  migration and compare the counts: every number above should be unchanged.');
  console.log('');

  await closeDatabase();
  fs.rmSync(emptyMigrations, { recursive: true, force: true });
  process.exit(duplicates.length === 0 ? 0 : 1);
}

await main();
