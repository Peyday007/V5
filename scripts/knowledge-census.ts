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
    await q('LEASES', `SELECT w.work_type t, l.outcome o, COUNT(*) n, ROUND(AVG(EXTRACT(EPOCH FROM (l.expires_at::timestamptz - l.claimed_at::timestamptz)))) ttl_s, ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(l.ended_at,l.expires_at)::timestamptz - l.claimed_at::timestamptz)))) held_s, MAX(l.heartbeat_count) maxhb FROM work_leases l JOIN work_items w ON w.id=l.work_item_id WHERE l.claimed_at >= ? GROUP BY w.work_type, l.outcome ORDER BY 1, 2`, ['2026-11-18T15:00:00Z']);
    await q('LEASED_NOW', `SELECT w.work_type t, l.worker_id wk, l.claimed_at c, l.expires_at e FROM work_leases l JOIN work_items w ON w.id=l.work_item_id WHERE l.ended_at IS NULL ORDER BY l.claimed_at LIMIT 25`);
    await q('GPU_FRAG_CLAIMS', `SELECT substr(e.at,1,13) h, COUNT(DISTINCT w.fragment_id) frags, COUNT(c.id) claims, SUM(CASE WHEN c.accepted=1 THEN 1 ELSE 0 END) acc FROM bin_events e JOIN work_items w ON w.id=e.work_item_id LEFT JOIN research_claims c ON c.fragment_id=w.fragment_id WHERE e.event_type='FREE_LANE_ITEM' AND e.outcome='SUBMITTED' AND e.workload_class='RESEARCH_FRAGMENT' AND e.at >= ? GROUP BY 1 ORDER BY 1`, ['2026-11-17T00:00:00Z']);
    await q('LANE_JOBS_24H', `SELECT substr(reason,1,32) m, workload_class k, outcome, COUNT(*) n, ROUND(AVG(duration_ms)/1000) avg_s FROM bin_events WHERE event_type='FREE_LANE_ITEM' AND at >= ? AND outcome='SUBMITTED' GROUP BY 1,2,3 ORDER BY 1,2`, ['2026-11-17T17:00:00Z']);
    out('POOL', { size: process.env['BRAIN_DATABASE_POOL_SIZE'] ?? null });
  } finally {
    await closeDatabase().catch(() => undefined);
  }
  console.log('GOALS: OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
