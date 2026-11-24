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

async function main(): Promise<void> {
  const command = process.argv[2];
  await initDatabase();
  try {
    if (command === 'fragment-failures') await fragmentFailures();
    else if (command === 'operator-runs') await operatorRuns();
    else if (command === 'bin-gates') await binGates(process.argv[3] ?? '');
    else throw new Error('usage: diagnose-readings.ts fragment-failures|operator-runs|bin-gates <bin>');
  } finally {
    await closeDatabase();
  }
}

await main();
