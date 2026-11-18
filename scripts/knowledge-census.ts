/** Throwaway read-only probe (claude/probe-d6): GPU-run throughput, leases, pressure, spend rows. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { readPodRows, windowSpendFromRows, podBudget, budgetWindowStart } from '../server/services/cheap/runpodPod.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const FROM = '2026-11-18T14:55:00Z';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const r = await getDb().all(sql, args); for (const x of r) out(tag, x); return r; } catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
async function main() {
  await initDatabase();
  try {
    out('NOW', new Date().toISOString());
    out('ENV', { mode: process.env['BRAIN_RUNPOD_MODE'], budget: process.env['BRAIN_RUNPOD_BUDGET_USD'], win: process.env['BRAIN_RUNPOD_BUDGET_WINDOW_HOURS'], from: process.env['BRAIN_RUNPOD_BUDGET_FROM'], maxph: process.env['BRAIN_RUNPOD_MAX_USD_PER_HOUR'], slots: process.env['BRAIN_RUNPOD_MAX_SLOTS'], pod: process.env['BRAIN_RUNPOD_POD_ID'], idle: process.env['BRAIN_RUNPOD_IDLE_STOP_MINUTES'] });
    // 1. pod rows (non-sample) and sample summary
    await q('POD_EVT', `SELECT at, outcome, reason, measures FROM bin_events WHERE event_type='RUNPOD_POD' AND at >= ? AND outcome NOT LIKE 'SAMPLE_%' ORDER BY at`, [FROM]);
    await q('POD_SAMPLES', `SELECT outcome, COUNT(*) n, MIN(at) first, MAX(at) last, SUM(duration_ms) ms FROM bin_events WHERE event_type='RUNPOD_POD' AND at >= ? AND outcome LIKE 'SAMPLE_%' GROUP BY outcome`, [FROM]);
    await q('POD_LAST_SAMPLES', `SELECT at, outcome, duration_ms, measures FROM bin_events WHERE event_type='RUNPOD_POD' AND at >= ? AND outcome LIKE 'SAMPLE_%' ORDER BY at DESC LIMIT 4`, [FROM]);
    // 2. spend as the supervisor computes it now, and as it would compute at a later resume
    const env = { ...process.env, BRAIN_RUNPOD_MODE: 'primary' } as NodeJS.ProcessEnv;
    const budget = podBudget(env);
    out('BUDGET', budget);
    if (budget) {
      const now = Date.now();
      const since = budgetWindowStart(budget, now);
      const rows = await readPodRows(new Date(since - budget.windowMs).toISOString());
      out('SPEND_NOW', windowSpendFromRows(rows, { since, now, live: null }));
      const resume = Date.parse('2026-11-18T20:00:00Z');
      out('SPEND_IF_RESUMED_20Z_AT_2015Z', windowSpendFromRows(rows, { since, now: resume + 15 * 60_000, live: { podId: 'qe5u6nhdv69ofl', status: 'RUNNING', costPerHr: 3.59, startedAt: resume } as any }));
    }
    // 3. GPU job throughput by hour and kind
    await q('JOBS', `SELECT substr(at,1,13) h, outcome, workload_class k, COUNT(*) n, ROUND(AVG(duration_ms)/1000) avg_s, MAX(duration_ms)/1000 max_s FROM bin_events WHERE event_type='FREE_LANE_ITEM' AND at >= ? AND reason LIKE 'model runpod/%' GROUP BY h, outcome, k ORDER BY h, k, outcome`, [FROM]);
    await q('JOBS_ALL_MODELS', `SELECT substr(reason,1,40) r, outcome, COUNT(*) n, ROUND(AVG(duration_ms)/1000) avg_s FROM bin_events WHERE event_type='FREE_LANE_ITEM' AND at >= ? GROUP BY r, outcome ORDER BY r`, [FROM]);
    await q('JOB_FAIL_REASONS', `SELECT workload_class k, substr(reason,1,140) r, COUNT(*) n FROM bin_events WHERE event_type='FREE_LANE_ITEM' AND at >= ? AND outcome <> 'SUBMITTED' GROUP BY k, r ORDER BY n DESC LIMIT 25`, [FROM]);
    // 4. leases: TTL vs job durations, by outcome and type
    await q('LEASES', `SELECT w.work_type t, l.outcome o, COUNT(*) n, ROUND(AVG((julianday(l.expires_at)-julianday(l.claimed_at))*86400)) ttl_s, ROUND(AVG((julianday(COALESCE(l.ended_at,l.expires_at))-julianday(l.claimed_at))*86400)) held_s, MAX(l.heartbeat_count) maxhb, SUM(CASE WHEN l.heartbeat_count>0 THEN 1 ELSE 0 END) withhb FROM work_leases l JOIN work_items w ON w.id=l.work_item_id WHERE l.claimed_at >= ? GROUP BY t, o ORDER BY t, o`, [FROM]);
    await q('LEASE_DETAIL_FAILED_AUDIT', `SELECT substr(l.detail,1,120) d, l.outcome o, COUNT(*) n FROM work_leases l JOIN work_items w ON w.id=l.work_item_id WHERE l.claimed_at >= ? AND w.work_type='RESEARCH_AUDIT' GROUP BY d, o ORDER BY n DESC LIMIT 10`, [FROM]);
    // 5. accepted claims per hour, last 48h (sustainable accepted-answer rate before/after)
    await q('ACCEPTED_BY_HOUR', `SELECT substr(created_at,1,13) h, COUNT(*) n, SUM(CASE WHEN accepted=1 THEN 1 ELSE 0 END) acc FROM research_claims WHERE created_at >= ? GROUP BY h ORDER BY h`, [new Date(Date.now() - 48 * 3_600_000).toISOString()]);
    await q('ITEMS_SUCCEEDED_BY_HOUR', `SELECT substr(completed_at,1,13) h, work_type t, state s, COUNT(*) n FROM work_items WHERE completed_at >= ? AND work_type LIKE 'RESEARCH_%' GROUP BY h, t, s ORDER BY h, t, s`, [new Date(Date.now() - 30 * 3_600_000).toISOString()]);
    // 6. queue depth now, total and for the goal
    await q('QUEUE', `SELECT work_type t, state s, COUNT(*) n, MIN(available_at) oldest FROM work_items WHERE state IN ('QUEUED','LEASED') GROUP BY t, s`);
    await q('QUEUE_GOAL', `SELECT work_type t, state s, COUNT(*) n, MIN(created_at) oldest FROM work_items WHERE state IN ('QUEUED','LEASED') AND payload LIKE ? GROUP BY t, s`, [`%${G}%`]);
    await q('GOAL_ITEMS_SINCE', `SELECT work_type t, state s, COUNT(*) n FROM work_items WHERE created_at >= ? AND payload LIKE ? GROUP BY t, s`, [FROM, `%${G}%`]);
    // 7. controller decisions and pressure
    await q('CAP_DECISIONS', `SELECT substr(at,1,16) at, outcome, substr(workload_class,1,40) m, substr(reason,1,90) r, substr(measures,1,260) ms FROM bin_events WHERE event_type='FREE_LANE_CAPACITY' AND at >= ? ORDER BY at`, [FROM]);
    await q('IDLE', `SELECT substr(at,1,13) h, COUNT(*) n FROM bin_events WHERE event_type='FREE_LANE_IDLE' AND at >= ? GROUP BY h`, [FROM]);
    await q('INFRA_FAIL', `SELECT substr(at,1,13) h, event_type, substr(reason,1,100) r, COUNT(*) n FROM bin_events WHERE at >= ? AND (event_type LIKE '%INFRA%' OR event_type LIKE '%PRESSURE%' OR event_type LIKE 'DB_%') GROUP BY h, event_type, r ORDER BY h LIMIT 40`, [FROM]);
    await q('LIVENESS', `SELECT * FROM runtime_liveness ORDER BY 1 DESC LIMIT 3`);
    await q('EVENT_TYPES', `SELECT event_type, COUNT(*) n FROM bin_events WHERE at >= ? GROUP BY event_type ORDER BY n DESC LIMIT 40`, [FROM]);
  } finally {
    await closeDatabase().catch(() => undefined);
  }
  console.log('GOALS: OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
