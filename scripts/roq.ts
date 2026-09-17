/**
 * A read-only query runner, for one audit, on a scratch branch. Never deployed.
 *
 * It takes a base64 bundle of statements on argv, refuses anything that is not
 * a SELECT or a WITH, opens the adapter directly rather than `initDatabase()`
 * (which would run the migration chain), and runs every statement inside one
 * `SET TRANSACTION READ ONLY` transaction, so the database is the thing
 * enforcing read-only rather than a promise in a comment.
 *
 *   node --import tsx roq.ts <base64> [maxFieldChars]
 *
 * Statements are separated by `;;` and may carry a leading `-- @label` line.
 * Rows print as JSON, one per line, with long fields clipped so a large ledger
 * cannot bury the answer.
 */
import { PostgresAdapter } from '../server/db/adapters/postgres.ts';
import { databaseConfig } from '../server/config.ts';
import type { Database, Row } from '../server/db/types.ts';

const BUNDLE = process.argv[2] ?? '';
const MAX = Number(process.argv[3] ?? '600') || 600;

function clip(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

async function main(): Promise<void> {
  const sql = Buffer.from(BUNDLE, 'base64').toString('utf8');
  const statements = sql
    .split(';;')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  for (const statement of statements) {
    const body = statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (!/^(select|with)\b/i.test(body)) {
      console.log(`ROQ: refusing a statement that is not a SELECT: ${body.slice(0, 80)}`);
      process.exit(1);
    }
  }

  const cfg = databaseConfig();
  if (cfg.provider !== 'postgres') {
    console.log(`ROQ: refusing — the provider is ${cfg.provider}.`);
    process.exit(1);
  }
  const db: Database = new PostgresAdapter({
    connectionString: cfg.connectionString!,
    max: 2,
    schema: cfg.schema,
    applicationName: 'brain-readonly-audit',
  });

  try {
    await db.transaction(async () => {
      await db.exec('SET TRANSACTION READ ONLY');
      console.log('ROQ: transaction is READ ONLY');
      for (const statement of statements) {
        const label = /^--\s*@(.+)$/m.exec(statement)?.[1]?.trim() ?? '(unlabelled)';
        console.log('');
        console.log(`===== ${label} =====`);
        let rows: Row[];
        try {
          rows = await db.all<Row>(statement);
        } catch (error) {
          console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        console.log(`  ${rows.length} row(s)`);
        for (const row of rows) {
          const clipped: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) clipped[key] = clip(value);
          console.log(`  ${JSON.stringify(clipped)}`);
        }
      }
    });
  } finally {
    await db.close().catch(() => undefined);
  }
  console.log('');
  console.log('ROQ: OK');
}

main().catch((error) => {
  console.error('ROQ: FAILED', error);
  process.exit(1);
});
