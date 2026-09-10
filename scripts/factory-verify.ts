/**
 * `npm run factory:verify` — run the verification the factory cannot run on
 * itself, and record what actually happened.
 *
 * Three things the factory's own campaign machinery cannot establish about
 * itself, because each one is about the whole repository rather than about one
 * merged tree:
 *
 *   1. The suite passes on **both** production persistence backends.
 *   2. The schema migrates a **populated** database and survives a reopen.
 *   3. Both of those were observed, not asserted.
 *
 * So this script *runs* them and records the exit code it observed. The
 * difference matters: an operator typing "the Postgres suite passed" into a row
 * is self-report, and a script that spawned the run and read its exit status is
 * a measurement. `factory-acceptance.ts` reads these rows and will not pass
 * F16 or F17 on anything else.
 *
 *   npm run factory:verify
 *   BRAIN_TEST_DATABASE_URL=postgresql://... npm run factory:verify
 *
 * Nothing here mutates project state, and no credential is recorded: the row
 * names the dialect, never the connection string.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { recordFactoryEvent } from '../server/repos/factoryFleet.ts';
import { REPO_ROOT } from '../server/env.ts';

interface RunOutcome {
  exitCode: number;
  durationMs: number;
  tail: string;
}

function runSuite(env: Record<string, string>): Promise<RunOutcome> {
  const startedAt = Date.now();
  return new Promise<RunOutcome>((resolve) => {
    const child = spawn('npx', ['vitest', 'run'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        tail: output.slice(-4000),
      });
    });
  });
}

/** Pull the counts out of vitest's own summary rather than recomputing them. */
function countsFrom(tail: string): { files: number; tests: number } {
  const files = /Test Files\s+(\d+) passed/.exec(tail);
  const tests = /Tests\s+(\d+) passed/.exec(tail);
  return { files: Number(files?.[1] ?? 0), tests: Number(tests?.[1] ?? 0) };
}

/**
 * Migrate a copy of the live, populated database and reopen it.
 *
 * A copy rather than the original, for the obvious reason and for one more: the
 * check has to be safe to run against a Brain somebody is using. What it proves
 * is the migration that actually matters — the user's own, with their rows in it
 * — rather than the one from an empty file that every test already covers.
 */
async function verifyPopulatedMigration(): Promise<{
  populatedRowsBefore: number;
  versionBefore: number;
  versionAfter: number;
  restarted: boolean;
}> {
  const db = getDb();
  const before = await db.all<{ total: number }>(`SELECT MAX(version) AS total FROM schema_migrations`);
  const versionBefore = Number(before[0]?.total ?? 0);
  /*
   * How populated the database actually is.
   *
   * Counted across the tables a real Brain fills rather than one of them: the
   * first version counted `project_events` alone, which in a freshly seeded Brain
   * is a single row — technically populated and not what the check is about.
   */
  let populatedRowsBefore = 0;
  for (const table of [
    'project_events',
    'factory_events',
    'factory_work_units',
    'factory_sessions',
    'identity_events',
  ]) {
    try {
      const counted = await db.all<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`);
      populatedRowsBefore += Number(counted[0]?.total ?? 0);
    } catch {
      // A table this Brain does not have contributes nothing.
    }
  }

  if (db.dialect !== 'sqlite') {
    // A cloud Brain cannot be copied sideways from here, and pretending otherwise
    // would be a check that reported on something it never touched.
    return { populatedRowsBefore, versionBefore, versionAfter: versionBefore, restarted: false };
  }

  const source = process.env.BRAIN_DB_PATH ?? path.join(REPO_ROOT, 'data', 'brain.db');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-migrate-'));
  const copy = path.join(scratch, 'brain.db');
  fs.copyFileSync(source, copy);

  /*
   * A second process, so this really is a reopen rather than the same handle.
   *
   * A *file* rather than `tsx -e`, because `-e` compiles to CommonJS and refuses
   * top-level await — which made the probe exit non-zero and report a schema
   * version of 0, so the check failed for a reason that had nothing to do with
   * the migration it was checking.
   */
  const probePath = path.join(scratch, 'probe.mts');
  fs.writeFileSync(
    probePath,
    [
      `import { initDatabase, getDb, closeDatabase } from ${JSON.stringify(path.join(REPO_ROOT, 'server/db/database.ts'))};`,
      'const opened = await initDatabase({ dbPath: process.env.FACTORY_MIGRATE_COPY });',
      "const rows = await getDb().all('SELECT COUNT(*) AS total FROM factory_events');",
      'console.log(JSON.stringify({ version: opened.migrations.schemaVersion, applied: opened.migrations.applied.length, rows: Number(rows[0]?.total ?? 0) }));',
      'await closeDatabase();',
    ].join('\n'),
  );

  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(
      'npx',
      ['tsx', probePath],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, FACTORY_MIGRATE_COPY: copy, BRAIN_DB_PATH: copy },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: -1, out }));
    child.on('exit', (code) => {
      if (code !== 0 && err) process.stderr.write(`migration probe: ${err.slice(-600)}\n`);
    });
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });

  let versionAfter = 0;
  const match = /\{"version":\s*\d+[^}]*\}/.exec(result.out);
  if (match) {
    try {
      versionAfter = (JSON.parse(match[0]) as { version: number }).version;
    } catch {
      versionAfter = 0;
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });

  return {
    populatedRowsBefore,
    versionBefore,
    versionAfter,
    restarted: result.code === 0 && versionAfter === versionBefore,
  };
}

async function main(): Promise<void> {
  await initDatabase();
  const postgresUrl = (process.env.BRAIN_TEST_DATABASE_URL ?? '').trim();
  /*
   * Re-check the migration without repeating twenty minutes of tests.
   *
   * The suites and the migration check are separate measurements of separate
   * things, and a defect in one should not cost a re-run of the other.
   */
  const migrationOnly = process.argv.includes('--migration-only');

  if (migrationOnly) {
    console.log('--- migration over a populated database ---');
    const only = await verifyPopulatedMigration();
    await recordFactoryEvent({
      kind: 'MIGRATION_VERIFIED',
      evidenceClass: 'MEASURED',
      detail: only,
    });
    console.log(
      `schema ${only.versionBefore} to ${only.versionAfter} over ` +
        `${only.populatedRowsBefore} pre-existing row(s); reopened: ${only.restarted}`,
    );
    await closeDatabase();
    process.exitCode = only.restarted ? 0 : 1;
    return;
  }

  console.log('--- suite on sqlite ---');
  const sqlite = await runSuite({ BRAIN_TEST_DATABASE_URL: '' });
  const sqliteCounts = countsFrom(sqlite.tail);
  await recordFactoryEvent({
    kind: 'SUITE_VERIFIED',
    durationMs: sqlite.durationMs,
    evidenceClass: 'MEASURED',
    detail: {
      dialect: 'sqlite',
      exitCode: sqlite.exitCode,
      files: sqliteCounts.files,
      tests: sqliteCounts.tests,
    },
  });
  console.log(
    `sqlite: exit ${sqlite.exitCode}, ${sqliteCounts.tests} test(s) in ${sqliteCounts.files} file(s)`,
  );

  if (postgresUrl) {
    console.log('--- suite on postgres ---');
    const postgres = await runSuite({ BRAIN_TEST_DATABASE_URL: postgresUrl });
    const postgresCounts = countsFrom(postgres.tail);
    await recordFactoryEvent({
      kind: 'SUITE_VERIFIED',
      durationMs: postgres.durationMs,
      evidenceClass: 'MEASURED',
      // The dialect, never the connection string.
      detail: {
        dialect: 'postgres',
        exitCode: postgres.exitCode,
        files: postgresCounts.files,
        tests: postgresCounts.tests,
      },
    });
    console.log(
      `postgres: exit ${postgres.exitCode}, ${postgresCounts.tests} test(s) in ${postgresCounts.files} file(s)`,
    );
  } else {
    console.log(
      'postgres: skipped — set BRAIN_TEST_DATABASE_URL to verify the other backend. F16 stays NOT_RUN.',
    );
  }

  console.log('--- migration over a populated database ---');
  const migration = await verifyPopulatedMigration();
  await recordFactoryEvent({
    kind: 'MIGRATION_VERIFIED',
    evidenceClass: 'MEASURED',
    detail: migration,
  });
  console.log(
    `schema ${migration.versionBefore} to ${migration.versionAfter} over ` +
      `${migration.populatedRowsBefore} pre-existing row(s); reopened: ${migration.restarted}`,
  );

  await closeDatabase();
  process.exitCode = sqlite.exitCode === 0 && migration.restarted ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
