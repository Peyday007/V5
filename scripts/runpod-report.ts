/**
 * `sh /app/scripts/runpod-report.sh` — research jobs the free lane did, by model.
 *
 * Read-only. Counts `FREE_LANE_ITEM` events (one per research work item a free-lane
 * worker answered) in the last hours, split by the model slot and outcome, and the
 * GPU's own settings. Fallbacks from the GPU are logged by `cheap/runpod.ts` as
 * `[runpod] fallback`; the workflow counts those from the logs beside this.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { describePoolerRefusal } from '../server/db/adapters/postgres.ts';
import { runpodConfig } from '../server/services/cheap/runpod.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--hours');
const hours = at >= 0 ? Math.max(1, Number(argv[at + 1]) || 6) : 6;

async function main(): Promise<void> {
  await initDatabase();
  const gpu = runpodConfig();
  console.log(`GPU ${gpu ? `primary ${gpu.model}` : 'off'}`);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = await getDb().all<{ reason: string | null; outcome: string; workload_class: string | null; n: number | string; ms: number | string | null }>(
    `SELECT reason, outcome, workload_class, COUNT(*) AS n, AVG(duration_ms) AS ms FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY reason, outcome, workload_class`,
    [since],
  );
  const table = new Map<string, { submitted: number; failed: number; ms: number[]; kinds: Set<string> }>();
  for (const row of rows) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const entry = table.get(model) ?? { submitted: 0, failed: 0, ms: [], kinds: new Set<string>() };
    if (row.outcome === 'SUBMITTED') {
      entry.submitted += Number(row.n);
      if (row.workload_class) entry.kinds.add(row.workload_class);
      if (row.ms != null) entry.ms.push(Number(row.ms));
    } else entry.failed += Number(row.n);
    table.set(model, entry);
  }
  console.log(`FREE-LANE RESEARCH JOBS, last ${hours}h`);
  if (table.size === 0) console.log('  none');
  for (const [model, e] of table) {
    const avg = e.ms.length ? Math.round(e.ms.reduce((a, b) => a + b, 0) / e.ms.length / 1000) : null;
    console.log(`  ${model.padEnd(40)} submitted ${e.submitted} · not accepted ${e.failed}${avg !== null ? ` · ~${avg}s each` : ''}${e.kinds.size ? ` · ${[...e.kinds].join(',')}` : ''}`);
  }
  const gpuRow = [...table].find(([m]) => m.startsWith('runpod/'));
  console.log(`RUNPOD_SUBMITTED ${gpuRow ? gpuRow[1].submitted : 0}`);
  console.log('RUNPOD-REPORT: OK');
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error('RUNPOD-REPORT: FAILED', pooler ?? error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
