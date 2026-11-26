/**
 * Read-only diagnosis readings, small enough to be carried to the running
 * machine with the command (`dispatch-diagnose.yml`), so they read production
 * before the commit that holds them is released.
 *
 *   node --import tsx scripts/diagnose-readings.ts fragment-failures|operator-runs
 *
 * Nothing here writes a row.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { DISPATCHABLE_SQL, FIREABLE_SQL, ownerDirectedGoalBinSql, purposeAdmitsSql, workReadySql } from '../server/repos/bins.ts';
import * as binsRepo from '../server/repos/bins.ts';

async function fragmentFailures(): Promise<void> {
  /*
   * Why research fragments failed in the last 24 hours, grouped by what the
   * gate recorded (`block_cause`, then the first words of `blocked_reason`),
   * so a shared cause reads as one large group. The operations report counts
   * failures by `updated_at` and completions by `completed_at`, so it also
   * prints how many of the failures were *created* in the window — a sweep
   * that touches old blocked rows is not 45 new failures.
   *
   * Read-only. Prints no claim text and no conversation content.
   */
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const totals = await getDb().get<{ failed: number; failed_new: number; accepted: number; accepted_touched: number }>(
    `SELECT
       (SELECT COUNT(*) FROM research_fragments WHERE updated_at >= ? AND status IN ('REJECTED','BLOCKED')) AS failed,
       (SELECT COUNT(*) FROM research_fragments WHERE created_at >= ? AND status IN ('REJECTED','BLOCKED')) AS failed_new,
       (SELECT COUNT(*) FROM research_fragments WHERE completed_at >= ? AND status = 'ACCEPTED') AS accepted,
       (SELECT COUNT(*) FROM research_fragments WHERE updated_at >= ? AND status = 'ACCEPTED') AS accepted_touched`,
    [since, since, since, since],
  );
  console.log(`DIAGNOSE: fragment-failures since ${since}`);
  console.log(`  failed (updated in window) ${totals?.failed ?? 0}; of them created in window ${totals?.failed_new ?? 0}`);
  console.log(`  accepted (completed in window) ${totals?.accepted ?? 0}; accepted rows touched in window ${totals?.accepted_touched ?? 0}`);
  const rows = await getDb().all<{ status: string; cause: string | null; reason: string | null; n: number; last_at: string }>(
    `SELECT status AS status, block_cause AS cause, SUBSTR(COALESCE(blocked_reason, ''), 1, 160) AS reason,
            COUNT(*) AS n, MAX(updated_at) AS last_at
       FROM research_fragments
      WHERE updated_at >= ? AND status IN ('REJECTED','BLOCKED')
      GROUP BY status, block_cause, SUBSTR(COALESCE(blocked_reason, ''), 1, 160)
      ORDER BY n DESC
      LIMIT 40`,
    [since],
  );
  for (const row of rows) {
    console.log(`  ${String(row.n).padStart(4)}x ${row.status} ${row.cause ?? '(no cause)'}  last ${row.last_at}`);
    console.log(`         ${row.reason || '(no reason recorded)'}`);
  }
  const claims = await getDb().all<{ reason: string | null; n: number }>(
    `SELECT SUBSTR(COALESCE(c.rejection_reason, ''), 1, 120) AS reason, COUNT(*) AS n
       FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
      WHERE f.updated_at >= ? AND f.status IN ('REJECTED','BLOCKED') AND c.accepted = 0
      GROUP BY SUBSTR(COALESCE(c.rejection_reason, ''), 1, 120)
      ORDER BY n DESC
      LIMIT 15`,
    [since],
  );
  if (claims.length > 0) console.log('  rejected claims inside those fragments, by reason:');
  for (const row of claims) console.log(`  ${String(row.n).padStart(5)}x ${row.reason || '(no reason recorded)'}`);
  const projects = await getDb().all<{ project_id: string; n: number }>(
    `SELECT project_id AS project_id, COUNT(*) AS n FROM research_fragments
      WHERE updated_at >= ? AND status IN ('REJECTED','BLOCKED') GROUP BY project_id ORDER BY n DESC LIMIT 10`,
    [since],
  );
  for (const row of projects) console.log(`  project ${row.project_id} ${row.n}`);
}

async function operatorRuns(): Promise<void> {
  /*
   * The operator's (Hermes's) last runs: how long each took, every tool it
   * called with whether the call succeeded and its error, and its own
   * summary — so "21 minutes and zero actions" is read from what it called
   * and what refused it. Then the operator's events of the last 24 hours by
   * kind. Read-only.
   */
  const runs = await getDb().all<{ id: string; state: string; model: string; started_at: string; finished_at: string | null; summary: string | null; tool_calls: string; error: string | null }>(
    'SELECT id, state, model, started_at, finished_at, summary, tool_calls, error FROM operator_runs ORDER BY started_at DESC LIMIT 4',
  );
  console.log(`DIAGNOSE: operator-runs ${runs.length}`);
  for (const run of runs) {
    const minutes = run.finished_at ? ((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 60_000).toFixed(1) : 'running';
    console.log('');
    console.log(`RUN ${run.id} ${run.state} ${run.model} started ${run.started_at} minutes ${minutes}`);
    if (run.error) console.log(`  error: ${run.error.slice(0, 400)}`);
    let calls: { tool?: string; ok?: boolean; error?: string }[] = [];
    try {
      calls = JSON.parse(run.tool_calls) as typeof calls;
    } catch {
      calls = [];
    }
    const byTool = new Map<string, { ok: number; failed: number; errors: Set<string> }>();
    for (const call of calls) {
      const entry = byTool.get(call.tool ?? '?') ?? { ok: 0, failed: 0, errors: new Set<string>() };
      if (call.ok === false) entry.failed += 1;
      else entry.ok += 1;
      if (call.error) entry.errors.add(call.error.slice(0, 200));
      byTool.set(call.tool ?? '?', entry);
    }
    for (const [tool, entry] of byTool) {
      console.log(`  ${tool} ok ${entry.ok} failed ${entry.failed}`);
      for (const error of entry.errors) console.log(`    ! ${error}`);
    }
    console.log(`  summary: ${(run.summary ?? '(none)').replace(/\s+/g, ' ').slice(0, 2500)}`);
  }
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const events = await getDb().all<{ event_type: string; n: number }>(
    `SELECT event_type AS event_type, COUNT(*) AS n FROM project_events
      WHERE created_at >= ? AND event_type LIKE 'OPERATOR_%' GROUP BY event_type ORDER BY n DESC`,
    [since],
  );
  console.log('');
  for (const row of events) console.log(`  ${String(row.n).padStart(5)}x ${row.event_type}`);
  const refusals = await getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE created_at >= ? AND event_type LIKE 'OPERATOR_DECISION%' ORDER BY created_at DESC LIMIT 6`,
    [since],
  );
  for (const row of refusals) console.log(`  decision: ${row.payload.replace(/\s+/g, ' ').slice(0, 600)}`);
}

/** Why one bin is or is not fired: each predicate the dispatcher composes, asked of it alone. */
async function binGates(binId: string): Promise<void> {
  if (!/^bin_[0-9a-f]+$/.test(binId)) throw new Error('a bin id is bin_ followed by hex');
  const now = new Date().toISOString();
  // Every `?` a composed predicate carries is bound to now, as the dispatcher binds them.
  const ask = async (label: string, sql: string): Promise<void> => {
    const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => now);
    const row = await getDb().get<{ id: string }>(`SELECT id FROM bins WHERE id = ? AND ${sql}`, [binId, ...params] as never[]);
    console.log(`  ${row ? 'yes' : 'NO '} ${label}`);
  };
  const bin = await getDb().get<{ purpose: string | null; orchestration_id: string | null; factory_campaign_id: string | null; held_by_workstream_id: string | null; project_id: string; kind: string }>(
    'SELECT purpose, orchestration_id, factory_campaign_id, held_by_workstream_id, project_id, kind FROM bins WHERE id = ?',
    [binId],
  );
  console.log(`DIAGNOSE: bin-gates ${binId} ${JSON.stringify(bin ?? null)}`);
  if (!bin) return;
  await ask('purpose admits (brain-only mode and the owner-directed exception)', purposeAdmitsSql(''));
  await ask('linked to an owner-directed goal', ownerDirectedGoalBinSql(''));
  await ask('dispatchable (claimable state and attempts)', DISPATCHABLE_SQL);
  await ask('fireable now (no backoff)', FIREABLE_SQL);
  await ask('has work a worker can claim', workReadySql('bins.'));
  const items = await getDb().all<{ state: string; n: number }>(
    `SELECT state AS state, COUNT(*) AS n FROM work_items WHERE bin_id = ? OR (bin_id IS NULL AND orchestration_id = ?) GROUP BY state`,
    [binId, bin.orchestration_id ?? '-'],
  );
  console.log(`  work items: ${items.map((one) => `${one.state} ${one.n}`).join(', ') || 'none'}`);
  const detail = await getDb().all<{ id: string; work_type: string; state: string; worker_id: string | null; attempt_count: number; failure_category: string | null; result_summary: string | null; updated_at: string }>(
    `SELECT id, work_type, state, worker_id, attempt_count, failure_category, result_summary, updated_at FROM work_items
      WHERE bin_id = ? OR (bin_id IS NULL AND orchestration_id = ?) ORDER BY updated_at DESC LIMIT 5`,
    [binId, bin.orchestration_id ?? '-'],
  );
  for (const one of detail) {
    console.log(`    ${one.id} ${one.work_type} ${one.state} worker=${one.worker_id ?? '-'} attempts=${one.attempt_count} ${one.updated_at} ${one.failure_category ?? ''} ${(one.result_summary ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  // The stranded-pin query reconcile runs (present only once that release is live).
  const stranded = (binsRepo as Record<string, unknown>)['strandedPinnedBins'];
  if (typeof stranded === 'function') {
    const rows = await (stranded as (before: string) => Promise<unknown[]>)(new Date(Date.now() - 6 * 3_600_000).toISOString());
    console.log(`  stranded pins now: ${JSON.stringify(rows).slice(0, 600)}`);
  } else console.log('  stranded pins: strandedPinnedBins not in the running image');
  const pin = await getDb().get<{ pinned_routine_id: string | null; created_at: string }>('SELECT pinned_routine_id, created_at FROM bins WHERE id = ?', [binId]);
  console.log(`  pin: ${pin?.pinned_routine_id ?? '-'} created ${pin?.created_at ?? '-'}`);
  if (pin?.pinned_routine_id) {
    const routine = await getDb().get<{ name: string; state: string; account_id: string; account_state: string | null }>(
      `SELECT r.name, r.state, r.account_id, a.state AS account_state FROM fleet_routines r LEFT JOIN fleet_accounts a ON a.id = r.account_id WHERE r.id = ?`,
      [pin.pinned_routine_id],
    );
    console.log(`  pinned routine: ${JSON.stringify(routine ?? null)}`);
  }
  const recent = await getDb().all<{ event_type: string; at: string; outcome: string | null; reason: string | null }>(
    `SELECT event_type, at, outcome, reason FROM bin_events WHERE bin_id = ? ORDER BY at DESC LIMIT 6`,
    [binId],
  );
  for (const one of recent) console.log(`    event ${one.at} ${one.event_type} ${one.outcome ?? ''} ${(one.reason ?? '').slice(0, 160)}`);
  const links = await getDb().all<{ workstream_id: string; kind: string; relation: string }>(
    `SELECT workstream_id, kind, relation FROM workstream_links WHERE superseded_at IS NULL AND (ref IN (?, ?, ?)
       OR ref IN (SELECT candidate_id FROM russell_missions WHERE candidate_id IS NOT NULL AND (bin_id = ? OR orchestration_id = ?))
       OR ref IN (SELECT id FROM russell_missions WHERE bin_id = ? OR orchestration_id = ?))`,
    [binId, bin.orchestration_id ?? '-', bin.factory_campaign_id ?? '-', binId, bin.orchestration_id ?? '-', binId, bin.orchestration_id ?? '-'],
  );
  console.log(`  direct links: ${links.map((one) => `${one.workstream_id} ${one.kind} ${one.relation}`).join('; ') || 'none'}`);
  const missions = await getDb().all<{ id: string; state: string }>(
    'SELECT id, state FROM russell_missions WHERE bin_id = ? OR (orchestration_id IS NOT NULL AND orchestration_id = ?)',
    [binId, bin.orchestration_id ?? '-'],
  );
  const packet = await getDb().get<{ status: string }>('SELECT status FROM research_orchestrations WHERE id = ?', [bin.orchestration_id ?? '-']);
  console.log(`  packet: ${bin.orchestration_id ?? '-'} ${packet?.status ?? '(none)'}`);
  console.log(`  missions: ${missions.map((one) => `${one.id} ${one.state}`).join(', ') || 'none'}`);
}

/** Free-lane outcomes by work type and model over 24 h, from FREE_LANE_ITEM events. */
async function freeLaneYield(): Promise<void> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = await getDb().all<{ workload_class: string | null; outcome: string | null; reason: string | null }>(
    `SELECT workload_class, outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? LIMIT 20000`,
    [since],
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const model = (row.reason ?? '').replace(/^model\s+/, '').split(':')[0]?.trim() ?? '';
    const key = `${row.workload_class ?? '-'} ${row.outcome ?? '-'} ${model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log(`DIAGNOSE: free-lane-yield since ${since} (${rows.length} events)`);
  for (const [key, n] of [...counts].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(n).padStart(5)}x ${key}`);
}

/**
 * Why the free lane's slot targets moved over the last 24 h (read-only): every
 * `FREE_LANE_CAPACITY` change per hour and model, its reason reduced to the
 * controller's own cause (the text before any detail), and what tripped a
 * database shrink (`measures.db` with the pool reading beside it); then the
 * items the lane accepted per hour, so a shrink can be read against what it cost.
 */
async function laneCapacity(): Promise<void> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = await getDb().all<{ at: string; workload_class: string | null; outcome: string | null; reason: string | null }>(
    `SELECT at, workload_class, outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND at >= ? ORDER BY at LIMIT 20000`,
    [since],
  );
  const cause = (reason: string | null): string =>
    (reason ?? '')
      .replace(/^\d+ -> \d+: /, '')
      .replace(/\d+(\.\d+)?/g, '#')
      .split(/[;(]/)[0]!
      .trim()
      .slice(0, 70);
  const byCause = new Map<string, number>();
  const byHour = new Map<string, number>();
  for (const row of rows) {
    const key = `${(row.workload_class ?? '-').slice(0, 28).padEnd(28)} ${(row.outcome ?? '-').padEnd(6)} ${cause(row.reason)}`;
    byCause.set(key, (byCause.get(key) ?? 0) + 1);
    if (row.outcome === 'SHRINK') {
      const hour = `${row.at.slice(0, 13)} ${cause(row.reason)}`;
      byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    }
  }
  console.log(`DIAGNOSE: lane-capacity since ${since} (${rows.length} target changes)`);
  for (const [key, n] of [...byCause].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}x ${key}`);
  console.log('DIAGNOSE: lane-capacity shrinks per hour');
  for (const [key, n] of [...byHour].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(n).padStart(5)}x ${key}`);
  const accepted = await getDb().all<{ hour: string; outcome: string | null; n: number | string }>(
    `SELECT SUBSTR(at, 1, 13) AS hour, outcome, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY SUBSTR(at, 1, 13), outcome ORDER BY hour`,
    [since],
  );
  console.log('DIAGNOSE: lane-capacity items per hour by outcome');
  for (const row of accepted) console.log(`  ${row.hour} ${String(row.outcome ?? '-').padEnd(12)} ${Number(row.n)}`);
  const restarts = await getDb().all<{ ended_at: string }>(
    "SELECT ended_at FROM infra_incidents WHERE kind = 'PROCESS_RESTART' AND ended_at >= ? ORDER BY ended_at",
    [since],
  );
  console.log(`DIAGNOSE: lane-capacity process restarts ${restarts.length}: ${restarts.map((r) => r.ended_at.slice(11, 16)).join(' ')}`);
}

/**
 * Who answered the GPU slot, per UTC day over the last 16 days: `FREE_LANE_ITEM`
 * rows on a `runpod/` slot split by whether `measures.servedBy` was recorded and
 * what it names, beside the pod's own `RUNPOD_POD` samples (running, and whether
 * vLLM answered its readiness probe). Read-only.
 */
async function gpuAnswers(): Promise<void> {
  const since = new Date(Date.now() - 16 * 86_400_000).toISOString();
  const parse = (raw: unknown): Record<string, unknown> => {
    try {
      return ((typeof raw === 'string' ? JSON.parse(raw) : raw) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const items = await getDb().all<{ at: string; outcome: string | null; reason: string | null; measures: string | null }>(
    `SELECT at, outcome, reason, measures FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND (reason LIKE 'model runpod/%' OR measures LIKE '%runpod/%')`,
    [since],
  );
  const byItem = new Map<string, number>();
  let firstServedBy: string | null = null;
  for (const row of items) {
    const served = parse(row.measures)['servedBy'];
    const who = !Array.isArray(served) ? 'no-servedBy' : served.some((m) => String(m).startsWith('runpod/')) ? 'servedBy-gpu' : 'servedBy-fallback';
    if (who !== 'no-servedBy' && (firstServedBy === null || row.at < firstServedBy)) firstServedBy = row.at;
    const slot = (row.reason ?? '').replace(/^model\s+/, '').split(':')[0]?.trim() ?? '';
    bump(byItem, `${row.at.slice(0, 10)} ${slot} ${who} ${row.outcome ?? '-'}`);
  }
  console.log(`DIAGNOSE: gpu-answers items since ${since} (${items.length} GPU-slot items; first servedBy at ${firstServedBy ?? 'never'})`);
  for (const [key, n] of [...byItem].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(n).padStart(5)}x ${key}`);

  // The GPU's own call window (runpodCallWindow: ok is a call the GPU itself answered), as the
  // capacity controller recorded it on each decision for the GPU slot (gpuWindow, 3-minute window).
  const caps = await getDb().all<{ at: string; measures: string | null }>(
    `SELECT at, measures FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class LIKE 'runpod/%' AND at >= ?`,
    [since],
  );
  const capDay = new Map<string, { rows: number; withOk: number; maxOk: number; sumOk: number; sumFailed: number }>();
  for (const row of caps) {
    const m = parse(row.measures);
    const ok = Number(m['ok'] ?? 0) || 0;
    const failed = Number(m['transient'] ?? 0) || 0;
    const d = capDay.get(row.at.slice(0, 10)) ?? { rows: 0, withOk: 0, maxOk: 0, sumOk: 0, sumFailed: 0 };
    d.rows += 1;
    if (ok > 0) d.withOk += 1;
    d.maxOk = Math.max(d.maxOk, ok);
    d.sumOk += ok;
    d.sumFailed += failed;
    capDay.set(row.at.slice(0, 10), d);
  }
  console.log('DIAGNOSE: gpu-answers capacity decisions on the GPU slot by day (ok = calls answered in the 3 min before)');
  for (const [day, d] of [...capDay].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`  ${day} decisions ${d.rows} · with ok>0 ${d.withOk} · max ok ${d.maxOk} · mean ok ${(d.sumOk / d.rows).toFixed(1)} · mean failed ${(d.sumFailed / d.rows).toFixed(1)}`);
  }

  const pod = await getDb().all<{ at: string; outcome: string | null; measures: string | null }>(
    `SELECT at, outcome, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND at >= ? ORDER BY at`,
    [since],
  );
  const podCounts = new Map<string, number>();
  for (const row of pod) {
    bump(podCounts, `${row.at.slice(0, 10)} ${row.outcome ?? '-'}${row.outcome?.startsWith('SAMPLE_') ? ` ready=${String(parse(row.measures)['ready'])}` : ''}`);
  }
  console.log('DIAGNOSE: gpu-answers RUNPOD_POD rows by day');
  for (const [key, n] of [...podCounts].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(n).padStart(5)}x ${key}`);

  // The same attribution as `gpuCapacity.ts` `servingAt`, written out here because this
  // reading runs against the released code: a row with no servedBy is the GPU's when the
  // latest pod sample within two periods said RUNNING and ready.
  const points = pod
    .filter((r) => r.outcome?.startsWith('SAMPLE_'))
    .map((r) => ({ t: Date.parse(r.at), serving: r.outcome === 'SAMPLE_RUNNING' && parse(r.measures)['ready'] === true }));
  const servingAt = (at: string): boolean => {
    const t = Date.parse(at);
    let latest: { t: number; serving: boolean } | null = null;
    for (const p of points) if (p.t <= t && (!latest || p.t > latest.t)) latest = p;
    return !!latest && latest.serving && t - latest.t <= 10 * 60_000;
  };
  const attributed = new Map<string, number>();
  let gpuItems = 0;
  let gpuSubmitted = 0;
  for (const row of items) {
    if (Array.isArray(parse(row.measures)['servedBy']) || row.at >= '2026-11-20T21:13:15.213Z') continue;
    if (!(row.reason ?? '').startsWith('model runpod/')) continue;
    const gpu = servingAt(row.at);
    // The throughput line reads the same 14 days runpod-report's GPU CAPACITY reads.
    if (gpu && Date.parse(row.at) >= Date.now() - 14 * 86_400_000) {
      gpuItems += 1;
      if (row.outcome === 'SUBMITTED') gpuSubmitted += 1;
    }
    bump(attributed, `${row.at.slice(0, 10)} ${gpu ? 'pod-serving' : 'pod-not-serving'} ${row.outcome ?? '-'}`);
  }
  const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const runningH = pod.filter((r) => r.outcome === 'SAMPLE_RUNNING' && r.at >= since14).length * 5 / 60;
  const servingH = points.filter((p) => p.serving && p.t >= Date.parse(since14)).length * 5 / 60;
  console.log(`DIAGNOSE: gpu-answers rows without servedBy, by the pod's serving state (running ${runningH.toFixed(1)} h, serving ${servingH.toFixed(1)} h)`);
  for (const [key, n] of [...attributed].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(n).padStart(5)}x ${key}`);
  console.log(`GPU_INFERRED items ${gpuItems} submitted ${gpuSubmitted} per_running_h ${(gpuItems / runningH).toFixed(1)} submitted_per_running_h ${(gpuSubmitted / runningH).toFixed(1)} submitted_per_serving_h ${(gpuSubmitted / servingH).toFixed(1)}`);

  const reasons = await getDb().all<{ day: string; reason: string | null; n: number | string }>(
    `SELECT SUBSTR(at, 1, 10) AS day, SUBSTR(reason, 1, 110) AS reason, COUNT(*) AS n FROM bin_events
      WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND reason LIKE 'model runpod/%:%'
      GROUP BY SUBSTR(at, 1, 10), SUBSTR(reason, 1, 110) ORDER BY day, n DESC`,
    [since],
  );
  console.log('DIAGNOSE: gpu-answers top failure reasons on the GPU slot, per day');
  const shown = new Map<string, number>();
  for (const r of reasons) {
    if ((shown.get(r.day) ?? 0) >= 3) continue;
    bump(shown, r.day);
    console.log(`  ${r.day} ${String(Number(r.n)).padStart(5)}x ${r.reason}`);
  }
}

/**
 * How long the dispatcher's and the capacity reader's statements take on the
 * running database, part by part (§88: measured, not read from code). Each is
 * bounded by the session's own statement timeout; a timeout is printed as one.
 */
async function queryTimes(): Promise<void> {
  const now = new Date().toISOString();
  const bind = (sql: string): string[] => Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => now);
  const time = async (label: string, sql: string, params?: unknown[]): Promise<void> => {
    const started = Date.now();
    try {
      const rows = await getDb().all<Record<string, unknown>>(sql, (params ?? bind(sql)) as never[]);
      const first = rows[0] ? JSON.stringify(rows[0]).slice(0, 160) : '(no rows)';
      console.log(`  ${String(Date.now() - started).padStart(7)} ms  ${label}  ${rows.length} row(s) ${first}`);
    } catch (error) {
      console.log(`  ${String(Date.now() - started).padStart(7)} ms  ${label}  FAILED ${String((error as Error).message ?? error).slice(0, 160)}`);
    }
  };
  console.log(`DIAGNOSE: query-times at ${now}`);
  await time('bins by state', 'SELECT state, COUNT(*) AS n FROM bins GROUP BY state ORDER BY state', []);
  await time('russell_missions rows', 'SELECT COUNT(*) AS n FROM russell_missions', []);
  await time('workstream_links rows', 'SELECT COUNT(*) AS n FROM workstream_links', []);
  await time('work_items rows', 'SELECT COUNT(*) AS n FROM work_items', []);
  await time('brain_only_mode', "SELECT name, enabled FROM brain_switches WHERE name = 'brain_only_mode'", []);
  const claimable = "(bins.state = 'READY' OR (bins.state = 'LEASED' AND bins.lease_expires_at <= ?))";
  await time('claimable bins (state only)', `SELECT COUNT(*) AS n FROM bins WHERE ${claimable}`);
  await time('  + purposeAdmitsSql', `SELECT COUNT(*) AS n FROM bins WHERE ${claimable} AND ${purposeAdmitsSql('bins.')}`);
  await time('  + ownerDirectedGoalBinSql', `SELECT COUNT(*) AS n FROM bins WHERE ${claimable} AND ${ownerDirectedGoalBinSql('bins.')}`);
  await time('  + workReadySql', `SELECT COUNT(*) AS n FROM bins WHERE ${claimable} AND ${workReadySql('bins.')}`);
  await time('DISPATCHABLE_SQL', `SELECT COUNT(*) AS n FROM bins WHERE ${DISPATCHABLE_SQL}`);
  await time(
    'listDispatchableBinHeads statement',
    `SELECT id FROM bins WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')} ORDER BY priority DESC, created_at, rowid LIMIT 200`,
  );
  console.log('  EXPLAIN listDispatchableBinHeads:');
  const plan = await getDb()
    .all<Record<string, string>>(
      `EXPLAIN SELECT id FROM bins WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')} ORDER BY priority DESC, created_at, rowid LIMIT 200`,
      bind(`${DISPATCHABLE_SQL} ${FIREABLE_SQL} ${workReadySql('bins.')}`) as never[],
    )
    .catch(() => []);
  for (const row of plan) console.log(`    ${Object.values(row)[0]}`);
  // The capacity reader's pools, one at a time, as `brain_operator_capacity` reads them.
  const watchdog = await import('../server/services/engineering/watchdog.ts');
  const step = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    const started = Date.now();
    try {
      const value = await run();
      console.log(`  ${String(Date.now() - started).padStart(7)} ms  ${label}  ${JSON.stringify(value).slice(0, 300)}`);
    } catch (error) {
      console.log(`  ${String(Date.now() - started).padStart(7)} ms  ${label}  FAILED ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  };
  await step('idleCounts (ROUTINES pool)', () => watchdog.idleCounts());
  await step('researchSlotsFree (RESEARCH_SLOTS pool)', () => watchdog.researchSlotsFree());
  await step('brainUtilization (every pool)', () => watchdog.brainUtilization());
}

/** Every process restart in the last 72 h (`infra_incidents` PROCESS_RESTART), and how long each process lived. */
async function restarts(): Promise<void> {
  const since = new Date(Date.now() - 72 * 3_600_000).toISOString();
  const rows = await getDb().all<{ started_at: string; ended_at: string }>(
    "SELECT started_at, ended_at FROM infra_incidents WHERE kind = 'PROCESS_RESTART' AND ended_at >= ? ORDER BY ended_at",
    [since],
  );
  console.log(`DIAGNOSE: restarts since ${since}: ${rows.length}`);
  let previousListen: string | null = null;
  for (const row of rows) {
    const lived = previousListen ? Math.round((Date.parse(row.started_at) - Date.parse(previousListen)) / 60_000) : null;
    console.log(`  down ${row.started_at} -> up ${row.ended_at}  previous process lived ${lived === null ? '?' : `${lived} min`}`);
    previousListen = row.ended_at;
  }
  const kinds = await getDb().all<{ kind: string; n: number | string }>(
    'SELECT kind, COUNT(*) AS n FROM infra_incidents WHERE ended_at >= ? GROUP BY kind ORDER BY kind',
    [since],
  );
  console.log(`  incidents by kind: ${kinds.map((one) => `${one.kind} ${one.n}`).join(', ')}`);
}

/**
 * The last readings each recent process wrote into `runtime_liveness` (every
 * thirty seconds), so a process that died is read at its last half-minute:
 * its heap, its pools, its costliest statements and longest connection holds.
 */
async function liveness(): Promise<void> {
  const rows = await getDb().all<{ instance_id: string; started_at: string; alive_at: string; readings: string | null }>(
    'SELECT instance_id, started_at, alive_at, readings FROM runtime_liveness ORDER BY alive_at DESC LIMIT 6',
    [],
  );
  console.log(`DIAGNOSE: liveness ${rows.length} process(es)`);
  for (const row of rows) {
    const lived = Math.round((Date.parse(row.alive_at) - Date.parse(row.started_at)) / 60_000);
    console.log(`  ${row.instance_id} started ${row.started_at} last alive ${row.alive_at} (${lived} min)`);
    let readings: Record<string, unknown> = {};
    try {
      readings = JSON.parse(row.readings ?? '{}') as Record<string, unknown>;
    } catch {
      console.log('    readings unreadable');
    }
    for (const key of ['memory', 'pools', 'eventLoop', 'stalls', 'pressure', 'statements', 'holds']) {
      if (readings[key] !== undefined) console.log(`    ${key}: ${JSON.stringify(readings[key]).slice(0, 1500)}`);
    }
  }
}

/**
 * Where a process's heap could come from (read-only): the statements that return
 * the most rows per call (pg_stat_statements), and the largest relations.
 */
async function heapSources(): Promise<void> {
  console.log('DIAGNOSE: heap-sources');
  const show = async (label: string, sql: string): Promise<void> => {
    const started = Date.now();
    try {
      const rows = await getDb().all<Record<string, unknown>>(sql);
      console.log(`  ${label} (${Date.now() - started} ms)`);
      for (const row of rows) console.log(`    ${JSON.stringify(row).slice(0, 900)}`);
    } catch (error) {
      console.log(`  ${label} FAILED ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  };
  const where = await getDb()
    .get<{ schema: string | null }>(
      `SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`,
    )
    .catch(() => null);
  const schema = where?.schema ?? null;
  if (schema) {
    await show('statements window', `SELECT stats_reset::text AS stats_reset FROM ${schema}.pg_stat_statements_info`);
    const dbFilter = `dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    await show(
      'most rows per call (calls >= 2)',
      `SELECT calls, rows, (rows / NULLIF(calls, 0))::bigint AS rows_per_call, round(mean_exec_time::numeric, 1) AS mean_ms,
              SUBSTR(query, 1, 700) AS query
         FROM ${schema}.pg_stat_statements WHERE ${dbFilter} AND calls >= 2
        ORDER BY rows / NULLIF(calls, 0) DESC NULLS LAST LIMIT 25`,
    );
    await show(
      'most rows in total',
      `SELECT calls, rows, (rows / NULLIF(calls, 0))::bigint AS rows_per_call, round(mean_exec_time::numeric, 1) AS mean_ms,
              SUBSTR(query, 1, 500) AS query
         FROM ${schema}.pg_stat_statements WHERE ${dbFilter}
        ORDER BY rows DESC LIMIT 20`,
    );
    /*
     * The counters above are cumulative since the last reset, so what the
     * running process reads now is the difference over a window: snapshot,
     * watch the newest process's heap each minute, snapshot again.
     */
    const windowMin = Number(process.env['DIAG_WINDOW_MIN'] ?? '8');
    type Snap = Map<string, { calls: number; rows: number; total: number; blocks: number }>;
    const snap = async (): Promise<Snap> => {
      const rows = await getDb().all<{ queryid: string; calls: number | string; rows: number | string; total: number | string; blocks: number | string }>(
        `SELECT queryid::text AS queryid, calls, rows, total_exec_time AS total, shared_blks_hit + shared_blks_read AS blocks
           FROM ${schema}.pg_stat_statements(false) WHERE ${dbFilter}`,
      );
      return new Map(rows.map((r) => [r.queryid, { calls: Number(r.calls), rows: Number(r.rows), total: Number(r.total), blocks: Number(r.blocks) }]));
    };
    const before = await snap();
    const startedAt = Date.now();
    while (Date.now() - startedAt < windowMin * 60_000) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      const live = await getDb().get<{ instance_id: string; started_at: string; readings: string | null }>(
        'SELECT instance_id, started_at, readings FROM runtime_liveness ORDER BY alive_at DESC LIMIT 1',
      );
      let memory: unknown = null;
      try {
        memory = (JSON.parse(live?.readings ?? '{}') as Record<string, unknown>)['memory'];
      } catch {
        /* unreadable */
      }
      console.log(`  ${new Date().toISOString()} ${live?.instance_id} (started ${live?.started_at}) ${JSON.stringify(memory)}`);
    }
    const after = await snap();
    const diff = [...after]
      .map(([id, a]) => {
        const b = before.get(id) ?? { calls: 0, rows: 0, total: 0, blocks: 0 };
        return { id, calls: a.calls - b.calls, rows: a.rows - b.rows, ms: Math.round(a.total - b.total), mb: ((a.blocks - b.blocks) * 8) / 1024 };
      })
      .filter((d) => d.calls > 0);
    const texts = new Map<string, string>();
    for (let i = 0; i < diff.length; i += 200) {
      const ids = diff.slice(i, i + 200).map((d) => d.id);
      const rows = await getDb().all<{ queryid: string; query: string }>(
        `SELECT queryid::text AS queryid, SUBSTR(query, 1, 300) AS query FROM ${schema}.pg_stat_statements WHERE ${dbFilter} AND queryid::text IN (${ids.map(() => '?').join(', ')})`,
        ids,
      );
      for (const r of rows) texts.set(r.queryid, r.query.replace(/\s+/g, ' '));
    }
    const line = (d: (typeof diff)[number]) =>
      `    rows ${d.rows} calls ${d.calls} per_call ${Math.round(d.rows / d.calls)} blocksMB ${d.mb.toFixed(0)} ms ${d.ms} :: ${texts.get(d.id) ?? '?'}`;
    console.log(`  rows returned in the last ${windowMin} min, by statement`);
    for (const d of [...diff].sort((x, y) => y.rows - x.rows).slice(0, 25)) console.log(line(d));
    console.log(`  blocks touched (8 kB) in the last ${windowMin} min, by statement`);
    for (const d of [...diff].sort((x, y) => y.mb - x.mb).slice(0, 25)) console.log(line(d));
    console.log('  every statement on research_runs that returns its text columns');
    for (const d of diff.filter((x) => /FROM research_runs/i.test(texts.get(x.id) ?? '') && /SELECT \*|prompt/i.test(texts.get(x.id) ?? ''))) console.log(line(d));
  } else {
    console.log('  pg_stat_statements is not installed');
  }
  await show(
    'largest relations (MB, ~rows)',
    `SELECT c.relname AS name, (pg_total_relation_size(c.oid) / 1048576)::int AS mb, c.reltuples::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 30`,
  );
}

/**
 * Which allocation sites the running server's heap is made of: the server's
 * inspector is opened (SIGUSR1, loopback only), V8's sampling heap profiler
 * runs for a window, and the samples still alive at its end are summed by the
 * site that allocated them. The inspector is closed again afterwards. Writes
 * no row.
 */
async function heapProfile(): Promise<void> {
  const { readdirSync, readFileSync } = await import('node:fs');
  let pid = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (cmd.includes('server/index.ts')) pid = Number(entry);
    } catch {
      /* gone */
    }
  }
  if (!pid) throw new Error('no server process found');
  console.log(`DIAGNOSE: heap-profile of pid ${pid}`);
  process.kill(pid, 'SIGUSR1');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const targets = (await (await fetch('http://127.0.0.1:9229/json/list')).json()) as Array<{ webSocketDebuggerUrl: string }>;
  const ws = new WebSocket(targets[0]!.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result ?? { error: msg.error });
  };
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      seq += 1;
      waiting.set(seq, resolve);
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
  const windowMin = Number(process.env['DIAG_WINDOW_MIN'] ?? '15');
  try {
    await call('HeapProfiler.enable');
    console.log(`  start ${JSON.stringify(await call('HeapProfiler.startSampling', { samplingInterval: 131072 }))}`);
    for (let minute = 0; minute < windowMin; minute += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      const usage = await call('Runtime.getHeapUsage');
      console.log(`  ${new Date().toISOString()} used ${Math.round(Number(usage['usedSize']) / 1048576)} MB of ${Math.round(Number(usage['totalSize']) / 1048576)} MB`);
    }
    const { profile } = (await call('HeapProfiler.getSamplingProfile')) as {
      profile: { head: HeapNode };
    };
    type HeapNode = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: HeapNode[] };
    const where = (n: HeapNode) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/app\//, '')}:${n.callFrame.lineNumber + 1}`;
    const bySite = new Map<string, number>();
    const byStack = new Map<string, number>();
    const byFile = new Map<string, number>();
    let total = 0;
    const walk = (n: HeapNode, path: string[]) => {
      const here = [...path, where(n)];
      if (n.selfSize > 0) {
        total += n.selfSize;
        bySite.set(where(n), (bySite.get(where(n)) ?? 0) + n.selfSize);
        const brain = here.filter((f) => f.includes('server/'));
        const key = brain.slice(-6).join(' < ') || here.slice(-4).join(' < ');
        byStack.set(key, (byStack.get(key) ?? 0) + n.selfSize);
        for (const f of new Set(brain.map((x) => x.split(' ')[1]!.split(':')[0]!))) byFile.set(f, (byFile.get(f) ?? 0) + n.selfSize);
      }
      for (const c of n.children) walk(c, here);
    };
    walk(profile.head, []);
    const mb = (b: number) => (b / 1048576).toFixed(1);
    console.log(`  live sampled ${mb(total)} MB (allocated during the window and still alive)`);
    console.log('  by Brain file on the stack (inclusive)');
    for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    ${mb(v)} MB ${k}`);
    console.log('  by Brain stack (innermost last 6 Brain frames)');
    for (const [k, v] of [...byStack].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    ${mb(v)} MB ${k.split(' < ').reverse().join(' < ').slice(0, 700)}`);
    console.log('  by allocating site');
    for (const [k, v] of [...bySite].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`    ${mb(v)} MB ${k}`);
  } finally {
    await call('HeapProfiler.stopSampling').catch(() => undefined);
    // Closing the inspector ends this connection before it can answer, so the reply is not awaited.
    void call('Runtime.evaluate', { expression: "process.getBuiltinModule('node:inspector').close()" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    ws.close();
  }
}

/** How many bytes the heaviest whole-set reads return, per call, on the largest project (read-only). */
async function rowBytes(): Promise<void> {
  console.log('DIAGNOSE: row-bytes');
  const show = async (label: string, sql: string, params: unknown[] = []): Promise<void> => {
    const started = Date.now();
    try {
      const rows = await getDb().all<Record<string, unknown>>(sql, params as never[]);
      console.log(`  ${label} (${Date.now() - started} ms)`);
      for (const row of rows) console.log(`    ${JSON.stringify(row).slice(0, 600)}`);
    } catch (error) {
      console.log(`  ${label} FAILED ${String((error as Error).message ?? error).slice(0, 200)}`);
    }
  };
  const mb = (expr: string) => `ROUND(SUM(${expr}) / 1048576.0, 1)`;
  await show(
    'monetization_paths with a design, by project (what recordConstructedArrangements and listConstructedArrangements read)',
    `SELECT project_id, COUNT(*) AS n, ${mb('COALESCE(LENGTH(design_json),0)')} AS design_mb, ${mb('COALESCE(LENGTH(position_json),0)')} AS position_mb,
            ${mb('pg_column_size(m.*)')} AS row_mb, MAX(LENGTH(design_json)) AS max_design
       FROM monetization_paths m WHERE design_signature IS NOT NULL GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 5`,
  );
  await show(
    'audit round events by project (auditRoundFor reads all of them per orchestration)',
    `SELECT project_id, COUNT(*) AS n, ${mb('LENGTH(payload)')} AS payload_mb, MAX(LENGTH(payload)) AS max_payload FROM project_events
      WHERE event_type IN ('DOCUMENT_HANDED_OFF', 'AUDIT_ROUND_REOPENED', 'RESEARCH_ROUND_RESUMED') GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 5`,
  );
  await show('cash_card_facts by project', `SELECT project_id, COUNT(*) AS n, ${mb('pg_column_size(f.*)')} AS row_mb FROM cash_card_facts f GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 3`);
  await show('existing_claims by project', `SELECT project_id, COUNT(*) AS n, ${mb('pg_column_size(c.*)')} AS row_mb FROM existing_claims c GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 3`);
  await show('routine_delivery_proofs settled', `SELECT COUNT(*) AS n, ${mb('pg_column_size(p.*)')} AS row_mb FROM routine_delivery_proofs p WHERE state IN ('PROVEN', 'FAILED', 'CLEARED')`);
  await show('factory_program_verifications by program', `SELECT program_id, COUNT(*) AS n, ${mb('pg_column_size(v.*)')} AS row_mb FROM factory_program_verifications v GROUP BY program_id ORDER BY COUNT(*) DESC LIMIT 3`);
  await show('cash_events by kind (largest)', `SELECT kind, COUNT(*) AS n, ${mb('LENGTH(detail)')} AS detail_mb FROM cash_events GROUP BY kind ORDER BY SUM(LENGTH(detail)) DESC LIMIT 4`);
  await show('cash_opportunities by project', `SELECT project_id, COUNT(*) AS n, ${mb('pg_column_size(o.*)')} AS row_mb FROM cash_opportunities o GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 3`);
  await show(
    'latest rank snapshot per path, largest project',
    `SELECT s.project_id, COUNT(*) AS n, ${mb('pg_column_size(s.*)')} AS row_mb FROM monetization_rank_snapshots s
       JOIN (SELECT path_id, MAX(evaluated_at) AS newest FROM monetization_rank_snapshots GROUP BY path_id) m ON m.path_id = s.path_id AND m.newest = s.evaluated_at
      GROUP BY s.project_id ORDER BY COUNT(*) DESC LIMIT 3`,
  );
  await show(
    'research_runs text by layer (what SELECT * by layer returns)',
    `SELECT layer_id, COUNT(*) AS n, ${mb('COALESCE(LENGTH(prompt),0) + COALESCE(LENGTH(prompt_sections),0) + COALESCE(LENGTH(result_text),0) + COALESCE(LENGTH(required_attachments),0)')} AS text_mb
       FROM research_runs GROUP BY layer_id ORDER BY 3 DESC LIMIT 4`,
  );
  await show('research_claims by project (accepted read)', `SELECT f.project_id, COUNT(*) AS n, ${mb('pg_column_size(c.*)')} AS row_mb FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id GROUP BY f.project_id ORDER BY COUNT(*) DESC LIMIT 3`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  await initDatabase();
  try {
    if (command === 'query-times') await queryTimes();
    else if (command === 'restarts') await restarts();
    else if (command === 'liveness') await liveness();
    else if (command === 'fragment-failures') await fragmentFailures();
    else if (command === 'operator-runs') await operatorRuns();
    else if (command === 'free-lane-yield') await freeLaneYield();
    else if (command === 'lane-capacity') await laneCapacity();
    else if (command === 'gpu-answers') await gpuAnswers();
    else if (command === 'heap-sources') await heapSources();
    else if (command === 'heap-profile') await heapProfile();
    else if (command === 'row-bytes') await rowBytes();
    else if (command === 'bin-gates') await binGates(process.argv[3] ?? '');
    else throw new Error('usage: diagnose-readings.ts query-times|fragment-failures|operator-runs|free-lane-yield|bin-gates <bin>');
  } finally {
    await closeDatabase();
  }
}

await main();
