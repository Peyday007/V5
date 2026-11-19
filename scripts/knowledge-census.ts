/** Read-only probe: why model-interpretation measures 0 accepted facts/h. SELECT only. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
const T = ['RESEARCH_PLAN', 'RESEARCH_FRAGMENT', 'RESEARCH_SYNTHESIZE'];
const V = ['RESEARCH_VERIFY', 'RESEARCH_AUDIT'];
const ph = (a: string[]): string => a.map(() => '?').join(', ');
const q = async (label: string, sql: string, params: unknown[] = []): Promise<void> => {
  try {
    const rows = await getDb().all<Record<string, unknown>>(sql, params);
    console.log(`${label}: ${JSON.stringify(rows)}`);
  } catch (e) {
    console.log(`${label}: ERROR ${(e as Error).message}`);
  }
};

async function main(): Promise<void> {
  await initDatabase();
  console.log(`since ${since}`);
  await q('latest stage capacity', `SELECT at, outcome, reason FROM bin_events WHERE event_type = 'FREE_LANE_STAGE_CAPACITY' ORDER BY at DESC LIMIT 2`);
  await q('lane events by class/outcome', `SELECT workload_class, outcome, COUNT(*) AS k FROM bin_events WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? GROUP BY workload_class, outcome ORDER BY workload_class, outcome`, [since]);
  await q('submitted items work_items.result_ref null/set', `SELECT e.workload_class, SUM(CASE WHEN w.result_ref IS NULL THEN 1 ELSE 0 END) AS ref_null, SUM(CASE WHEN w.result_ref IS NOT NULL THEN 1 ELSE 0 END) AS ref_set FROM bin_events e JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ? GROUP BY e.workload_class`, [since]);
  await q('facts as measured now (work_items.result_ref)', `SELECT COUNT(DISTINCT c.id) AS n FROM research_claims c WHERE c.accepted = 1 AND c.pass_id IN (SELECT w.result_ref FROM bin_events e JOIN work_items w ON w.id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ? AND w.result_ref IS NOT NULL AND e.workload_class IN (${ph(T)}))`, [since, ...T]);
  await q('idempotency ops for submitted lane items', `SELECT e.workload_class, o.namespace, o.state, COUNT(*) AS k, SUM(CASE WHEN o.result_ref IS NULL THEN 0 ELSE 1 END) AS with_ref FROM bin_events e JOIN idempotency_operations o ON o.work_item_id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ? GROUP BY e.workload_class, o.namespace, o.state`, [since]);
  await q('claims by acceptance via idempotency result_ref', `SELECT c.accepted, COUNT(DISTINCT c.id) AS n FROM research_claims c WHERE c.pass_id IN (SELECT o.result_ref FROM bin_events e JOIN idempotency_operations o ON o.work_item_id = e.work_item_id WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.at >= ? AND o.state = 'SUCCEEDED' AND o.result_ref IS NOT NULL AND e.workload_class IN (${ph(T)})) GROUP BY c.accepted`, [since, ...T]);
  await q('lane queue', `SELECT work_type, state, COUNT(*) AS k FROM work_items WHERE work_type IN (${ph([...T, ...V])}) AND state IN ('QUEUED','LEASED') GROUP BY work_type, state`, [...T, ...V]);
  await closeDatabase();
  console.log('GOALS: OK');
}
main().catch(async (e) => {
  console.log(`probe failed: ${(e as Error).message}`);
  try { await closeDatabase(); } catch { /* closed */ }
  process.exit(1);
});
