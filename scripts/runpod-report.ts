/**
 * `sh /app/scripts/runpod-report.sh` — research jobs the free lane did, by model.
 *
 * Read-only. Counts `FREE_LANE_ITEM` events (one per research work item a free-lane
 * worker answered) in the last hours, split by the model slot and outcome, and the
 * GPU's own settings. Fallbacks from the GPU are logged by `cheap/runpod.ts` as
 * `[runpod] fallback`; the workflow counts those from the logs beside this.
 *
 * Quality, per model: the research claims on the fragments that model submitted —
 * how many, what share passed source validation (`sourced`), and what share a
 * verifier later refuted. A fragment two models both answered counts for both.
 *
 * Cost: a pod bills by the hour whether it is busy or not, so the GPU's cost per
 * research job is its hourly price × the window ÷ the jobs it submitted. The price
 * is `BRAIN_RUNPOD_USD_PER_HOUR` (what RunPod charges for the pod); unset, the cost
 * is reported as unknown rather than guessed.
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
  const quality = await getDb().all<{ reason: string | null; claims: number | string; sourced: number | string | null; refuted: number | string | null }>(
    `SELECT e.reason AS reason, COUNT(c.id) AS claims,
            SUM(CASE WHEN c.sourced = 1 THEN 1 ELSE 0 END) AS sourced,
            SUM(CASE WHEN c.contradiction_state = 'REFUTED' THEN 1 ELSE 0 END) AS refuted
       FROM bin_events e
       JOIN work_items w ON w.id = e.work_item_id
       JOIN research_claims c ON c.fragment_id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED'
        AND e.workload_class = 'RESEARCH_FRAGMENT' AND e.at >= ? AND w.fragment_id IS NOT NULL
      GROUP BY e.reason`,
    [since],
  );
  console.log('RESEARCH QUALITY (claims on fragments each model submitted)');
  if (quality.length === 0) console.log('  none');
  for (const row of quality) {
    const model = String(row.reason ?? '').replace(/^model /, '').split(':')[0] || '(unknown)';
    const claims = Number(row.claims);
    const pct = (x: number | string | null) => (claims ? `${Math.round((100 * Number(x ?? 0)) / claims)}%` : '-');
    console.log(`  ${model.padEnd(40)} claims ${claims} · sourced ${pct(row.sourced)} · refuted ${pct(row.refuted)}`);
  }
  const gpuRow = [...table].find(([m]) => m.startsWith('runpod/'));
  const gpuJobs = gpuRow ? gpuRow[1].submitted : 0;
  // The pod's own power history: what Brain stopped and started, and RunPod's
  // price sampled while it ran (runpodPod.ts), so running time is measured.
  const pod = await getDb().all<{ outcome: string; n: number | string; ms: number | string | null; measures: string | null }>(
    `SELECT outcome, COUNT(*) AS n, SUM(duration_ms) AS ms, MAX(measures) AS measures FROM bin_events
      WHERE event_type = 'RUNPOD_POD' AND at >= ? GROUP BY outcome`,
    [since],
  );
  const podCount = (o: string) => Number(pod.find((r) => r.outcome === o)?.n ?? 0);
  const runningMs = Number(pod.find((r) => r.outcome === 'SAMPLE_RUNNING')?.ms ?? 0);
  const sampledCost = (() => {
    try {
      const m = JSON.parse(String(pod.find((r) => r.outcome === 'SAMPLE_RUNNING')?.measures ?? '{}')) as { costPerHr?: number | null };
      return typeof m.costPerHr === 'number' && m.costPerHr > 0 ? m.costPerHr : null;
    } catch {
      return null;
    }
  })();
  if (pod.length > 0) {
    console.log(`POD stopped ${podCount('STOPPED')} · started ${podCount('STARTED')} · failed ${podCount('STOP_FAILED') + podCount('START_FAILED')} · running ~${Math.round(runningMs / 60_000)} min sampled · stopped ~${Math.round(Number(pod.find((r) => r.outcome === 'SAMPLE_EXITED')?.ms ?? 0) / 60_000)} min sampled`);
  } else console.log('POD no supervision events (auto stop/start is off without BRAIN_RUNPOD_API_KEY)');
  const price = sampledCost ?? Number(process.env['BRAIN_RUNPOD_USD_PER_HOUR'] ?? '');
  if (sampledCost && runningMs > 0) {
    const spend = (sampledCost * runningMs) / 3_600_000;
    console.log(`GPU COST $${spend.toFixed(2)} measured: ${Math.round(runningMs / 60_000)} min running at RunPod's $${sampledCost}/h · ${gpuJobs ? `$${(spend / gpuJobs).toFixed(4)} per research job` : 'no GPU jobs yet'}`);
  } else if (Number.isFinite(price) && price > 0) {
    const spend = price * hours;
    console.log(`GPU COST $${spend.toFixed(2)} for ${hours}h at $${price}/h · ${gpuJobs ? `$${(spend / gpuJobs).toFixed(4)} per research job` : 'no GPU jobs yet'}`);
  } else console.log('GPU COST unknown (set BRAIN_RUNPOD_USD_PER_HOUR to the pod price)');
  console.log(`RUNPOD_SUBMITTED ${gpuJobs}`);
  console.log('RUNPOD-REPORT: OK');
}

main()
  .catch((error) => {
    const pooler = describePoolerRefusal(error);
    console.error('RUNPOD-REPORT: FAILED', pooler ?? error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
