#!/usr/bin/env node
/**
 * Refresh the per-file durations the CI shards are balanced by
 * (`tests/helpers/shard-durations.json`, read by `tests/helpers/shardSequencer.ts`).
 *
 * The input is what the shards already write: vitest's JSON report, which the
 * Postgres suite uploads with each shard's file list and Deploy uploads with
 * each SQLite shard. Download a run's artifacts and pass the reports:
 *
 *   gh api repos/<owner>/<repo>/actions/runs/<id>/artifacts   # find them
 *   node scripts/test-durations.mjs --backend postgres  path/to/*.json
 *   node scripts/test-durations.mjs --backend sqlite    path/to/*.json
 *
 * A file the reports measured takes the new duration; a file they did not
 * keeps its old one; a file no longer on disk is dropped. A stale table only
 * makes the split less even — the shards' own reports, not this table, prove
 * the suite ran whole — so refreshing is upkeep, never a gate.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tablePath = path.join(root, 'tests/helpers/shard-durations.json');

const args = process.argv.slice(2);
const at = args.indexOf('--backend');
const backend = at === -1 ? undefined : args[at + 1];
const reports = args.filter((_, i) => i !== at && i !== at + 1);
if ((backend !== 'postgres' && backend !== 'sqlite') || reports.length === 0) {
  console.error('usage: test-durations.mjs --backend postgres|sqlite <vitest-report.json>...');
  process.exit(2);
}

const measured = {};
for (const report of reports) {
  const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  for (const result of parsed.testResults ?? []) {
    const file = path.relative(root, result.name).split(path.sep).join('/');
    const ms = Number(result.endTime) - Number(result.startTime);
    if (file.startsWith('tests/') && Number.isFinite(ms) && ms > 0) measured[file] = Math.round(ms / 100) * 100;
  }
}
if (Object.keys(measured).length === 0) {
  console.error('the reports named no test file with a duration; nothing written');
  process.exit(1);
}

const tables = fs.existsSync(tablePath) ? JSON.parse(fs.readFileSync(tablePath, 'utf8')) : {};
const merged = { ...(tables[backend] ?? {}), ...measured };
const kept = Object.fromEntries(
  Object.entries(merged)
    .filter(([file]) => fs.existsSync(path.join(root, file)))
    .sort(([a], [b]) => (a < b ? -1 : 1)),
);
tables[backend] = kept;
const ordered = Object.fromEntries(Object.keys(tables).sort().map((k) => [k, tables[k]]));
fs.writeFileSync(tablePath, JSON.stringify(ordered, null, 1) + '\n');
console.log(`${backend}: ${Object.keys(measured).length} measured, ${Object.keys(kept).length} in the table`);
