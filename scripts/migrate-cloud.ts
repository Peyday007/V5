/**
 * `npm run migrate:cloud` — move this Brain's state into the cloud.
 *
 * Four ways to run it, and the order they are meant to be used in:
 *
 *   --dry-run       Read everything, write nothing, and say exactly what would
 *                   move. Run this first, always.
 *   (no flag)       Do it. Safe to interrupt and safe to run twice.
 *   --resume        The same thing, said out loud. Kept because "resume" is
 *                   what a person reaches for after an interrupted run, and
 *                   finding out that the ordinary command already does it is a
 *                   worse way to learn it than being able to type it.
 *   --verify-only   Touch nothing; check that the target really holds what the
 *                   source holds, down to the checksum of every file.
 *
 *   --project <id or slug>   One project instead of the whole Brain.
 *
 * The local Brain is never modified. The source database is opened read-only,
 * no local file is deleted at any point, and success does not trigger any
 * cleanup: after a migration you have two complete Brains, and archiving the
 * first one is a decision for a person to make later, deliberately.
 */
import path from 'node:path';
import fs from 'node:fs';
import { DATA_ROOT, DB_PATH } from '../server/env.ts';
import { databaseConfig, storageConfig } from '../server/config.ts';
import { DatabaseConfigurationError } from '../server/db/types.ts';
import { StorageConfigurationError } from '../server/services/storage/types.ts';
import {
  runCloudMigration,
  type CloudMigrationMode,
  type CloudMigrationReport,
} from '../server/services/cloudMigration.ts';

interface Args {
  mode: CloudMigrationMode;
  project: string | null;
  json: boolean;
  /** Only for a local target store: where its objects should live. */
  targetRoot: string | null;
}

function parseArgs(argv: string[]): Args {
  let mode: CloudMigrationMode = 'MIGRATE';
  let project: string | null = null;
  let json = false;
  let targetRoot: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dry-run') mode = 'DRY_RUN';
    else if (arg === '--verify-only') mode = 'VERIFY_ONLY';
    else if (arg === '--resume') mode = 'MIGRATE';
    else if (arg === '--json') json = true;
    else if (arg === '--project') {
      project = argv[i + 1] ?? null;
      i += 1;
      if (!project || project.startsWith('--')) {
        fail('--project needs a project id or slug after it.');
      }
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length);
    } else if (arg === '--target-root') {
      targetRoot = argv[i + 1] ?? null;
      i += 1;
      if (!targetRoot || targetRoot.startsWith('--')) {
        fail('--target-root needs a directory after it.');
      }
    } else if (arg.startsWith('--target-root=')) {
      targetRoot = arg.slice('--target-root='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`Unrecognised argument: ${arg}\n\n${USAGE}`);
    }
  }
  return { mode, project, json, targetRoot };
}

const USAGE = `
  npm run migrate:cloud -- [options]

    --dry-run              Report what would move. Writes nothing.
    --resume               Continue an interrupted migration. (The default run
                           already resumes; this is the same thing named.)
    --verify-only          Check the target against the source, change nothing.
    --project <id|slug>    One project instead of the whole Brain.
    --json                 Print the report as JSON instead of prose.
    --target-root <dir>    Where a local target store keeps its objects. Only
                           meaningful with BRAIN_STORAGE_PROVIDER=local, for
                           moving documents onto another volume.

  Reads BRAIN_DATABASE_URL and the SUPABASE_* variables for the target. The
  local database and document folder are never modified, and nothing local is
  ever deleted — not even after a migration succeeds.
`.trimEnd();

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function printReport(report: CloudMigrationReport): void {
  const line = '  ' + '─'.repeat(70);
  console.log('');
  console.log(line);
  console.log(
    `  ${report.mode === 'DRY_RUN' ? 'DRY RUN' : report.mode === 'VERIFY_ONLY' ? 'VERIFICATION' : 'MIGRATION'}` +
      ` — ${report.ok ? 'OK' : 'PROBLEMS FOUND'}`,
  );
  console.log(line);
  console.log('');
  console.log(`  Scope        ${report.scope.projectName ?? 'the whole Brain'}`);
  console.log(`  From         ${report.source.database}`);
  console.log(`               ${report.source.documents}`);
  console.log(`  To           ${report.target.database}`);
  console.log(`               ${report.target.storage}  (schema version ${report.target.schemaVersion})`);
  console.log('');

  const moved = report.tables.filter((t) => t.sourceRows > 0);
  if (moved.length > 0) {
    console.log('  Rows');
    const width = Math.max(...moved.map((t) => t.table.length));
    for (const table of moved) {
      const target = table.targetRows === null ? '' : ` → ${table.targetRows} in target`;
      console.log(
        `    ${table.table.padEnd(width)}  ${String(table.sourceRows).padStart(7)} source  ` +
          `${String(table.inserted).padStart(7)} written  ` +
          `${String(table.skipped).padStart(7)} already there${target}`,
      );
    }
    console.log('');
  }

  const count = (status: string) => report.files.filter((f) => f.status === status).length;
  console.log('  Files');
  console.log(`    ${report.source.files} registered, ${bytes(report.source.bytes)} in total`);
  console.log(
    report.mode === 'DRY_RUN'
      ? `    ${count('WOULD_COPY')} would be copied, ${count('MISSING_AT_SOURCE')} missing at source`
      : `    ${count('COPIED')} copied, ${count('ALREADY_PRESENT')} already there, ` +
          `${count('MISSING_AT_SOURCE')} missing at source, ${count('FAILED')} failed`,
  );
  console.log('');

  if (report.verification) {
    const v = report.verification;
    const badCounts = v.rowCounts.filter((r) => !r.ok);
    const badLinks = v.relationships.filter((r) => !r.ok);
    console.log('  Verification');
    console.log(
      `    row counts        ${v.rowCounts.length - badCounts.length}/${v.rowCounts.length} tables hold at least what the source holds`,
    );
    for (const row of badCounts) {
      console.log(`      ✗ ${row.table}: source ${row.source}, target ${row.target}`);
    }
    console.log(
      `    relationships     ${v.relationships.length - badLinks.length}/${v.relationships.length} resolve across tables in the target`,
    );
    for (const row of badLinks) {
      console.log(`      ✗ ${row.description}: source ${row.source}, target ${row.target}`);
    }
    console.log(
      `    file checksums    ${v.checksums.matched}/${v.checksums.checked} match the bytes the target returns`,
    );
    for (const key of v.checksums.mismatched) console.log(`      ✗ different bytes: ${key}`);
    for (const key of v.checksums.missing) console.log(`      ✗ not in the target: ${key}`);
    console.log('');
  }

  if (report.problems.length > 0) {
    console.log('  Problems');
    for (const problem of report.problems) console.log(`    • ${problem}`);
    console.log('');
  }

  console.log(line);
  if (report.mode === 'DRY_RUN') {
    console.log('  Nothing was written. Run without --dry-run to do it.');
  } else if (report.mode === 'MIGRATE') {
    console.log(
      report.ok
        ? '  Done. The local Brain is unchanged and still works — nothing here has\n' +
            '  deleted or altered it, and nothing will. Keep it until you have used the\n' +
            '  cloud one for long enough to trust it, then archive it yourself.'
        : '  Finished with problems. Nothing local was changed. Fix what is listed\n' +
            '  above and run it again — work already done will not be repeated.',
    );
  } else {
    console.log(
      report.ok
        ? '  The target holds everything the source holds.'
        : '  The target does NOT match the source. Run the migration again.',
    );
  }
  console.log(line);
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DB_PATH)) {
    fail(
      `There is no local database at ${DB_PATH}, so there is nothing to migrate.\n` +
        '  Start Brain locally once first, or point BRAIN_DATA_DIR at the data folder you mean.',
    );
  }

  let target;
  let targetStorage;
  try {
    // Read from the environment exactly as the server does, so the target of a
    // migration and the target of a boot can never be two different places.
    target = databaseConfig();
    targetStorage = storageConfig();
  } catch (error) {
    const e = error as DatabaseConfigurationError;
    fail(`${e.message}\n  ${e.detail ?? ''}`);
  }

  if (target.provider !== 'postgres') {
    fail(
      'BRAIN_DATABASE_PROVIDER is not "postgres", so there is no cloud database to migrate into.\n' +
        '  Set BRAIN_DATABASE_PROVIDER=postgres and BRAIN_DATABASE_URL to the target database.',
    );
  }

  console.log('');
  console.log(`  Reading  ${DB_PATH}`);
  console.log(`           ${path.join(DATA_ROOT, 'projects')}`);
  console.log('');

  try {
    const report = await runCloudMigration({
      sourceDbPath: DB_PATH,
      sourceRoot: DATA_ROOT,
      target,
      targetStorage,
      project: args.project,
      mode: args.mode,
      ...(args.targetRoot ? { targetRoot: args.targetRoot } : {}),
      log: (message) => console.log(`  ${message}`),
    });

    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);

    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    const e = error as Error & { detail?: string };
    console.error('');
    console.error('  The migration stopped.');
    console.error('');
    console.error(`  ${e.message}`);
    if (
      (e instanceof DatabaseConfigurationError || e instanceof StorageConfigurationError) &&
      e.detail
    ) {
      console.error(`  ${e.detail}`);
    }
    console.error('');
    console.error(
      '  Nothing local was changed. The source database was opened read-only and no\n' +
        '  local file was written or removed, so the Brain on this machine is exactly\n' +
        '  as it was. Fix the problem above and run it again: anything that did reach\n' +
        '  the target will be recognised rather than copied twice.',
    );
    console.error('');
    process.exit(1);
  }
}

await main();
