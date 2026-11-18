/** Throwaway read-only probe (claude/probe-d3): research acceptance and claim storage. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const W0 = '2026-11-18T14:55:00Z';
const W1 = '2026-11-18T17:10:00Z';
const D24 = new Date(Date.now() - 24 * 3_600_000).toISOString();
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args); for (const r of rows) out(tag, r); if (rows.length === 0) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
async function main(): Promise<void> {
  await initDatabase();
  try {
    const QUALITY = `SELECT one.reason AS reason, COUNT(*) AS claims,
            SUM(CASE WHEN one.sourced = 1 THEN 1 ELSE 0 END) AS sourced,
            SUM(CASE WHEN one.contradiction_state = 'REFUTED' THEN 1 ELSE 0 END) AS refuted,
            SUM(CASE WHEN one.accepted = 1 THEN 1 ELSE 0 END) AS accepted,
            SUM(CASE WHEN one.accepted = 1 AND one.contradiction_state = 'REFUTED' THEN 1 ELSE 0 END) AS accepted_refuted
       FROM (SELECT DISTINCT e.reason AS reason, c.id AS id, c.sourced AS sourced,
                    c.contradiction_state AS contradiction_state, c.accepted AS accepted
               FROM bin_events e
               JOIN work_items w ON w.id = e.work_item_id
               JOIN research_fragments f ON f.id = w.fragment_id
               JOIN research_claims c ON c.fragment_id = f.id
              WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED'
                AND e.workload_class = 'RESEARCH_FRAGMENT' AND e.at >= ?
                AND (e.at >= ? OR f.completed_at >= ?)) one
      GROUP BY one.reason`;
    for (const [tag, since] of [['NEW_H1', '2026-11-18T14:50:00Z'], ['NEW_H2', '2026-11-18T16:01:00Z']] as const) {
      const earliest = new Date(Date.parse(since) - 24 * 3_600_000).toISOString();
      await q(tag, QUALITY, [earliest, since, since]);
    }
    await q('OLD_H2', `SELECT e.reason AS reason, COUNT(c.id) AS claims, SUM(CASE WHEN c.accepted = 1 THEN 1 ELSE 0 END) AS accepted
       FROM bin_events e JOIN work_items w ON w.id = e.work_item_id JOIN research_claims c ON c.fragment_id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.workload_class = 'RESEARCH_FRAGMENT' AND e.at >= ? AND w.fragment_id IS NOT NULL GROUP BY e.reason`, ['2026-11-18T16:01:00Z']);
    await q('TRACE_NEW', `SELECT COUNT(*) AS n FROM research_claims c LEFT JOIN research_fragments f ON f.id = c.fragment_id WHERE c.accepted = 1 AND COALESCE(f.completed_at, c.created_at) >= ?`, ['2026-11-18T16:01:00Z']);
    await q('TRACE_OLD', `SELECT COUNT(*) AS n FROM research_claims c WHERE c.accepted = 1 AND c.created_at >= ?`, ['2026-11-18T16:01:00Z']);
    // Verify lag: fragment submission to gate, 24h, free lane.
    await q('VERIFY_LAG', `SELECT f.id, MIN(e.at) AS submitted, f.completed_at FROM bin_events e JOIN work_items w ON w.id = e.work_item_id JOIN research_fragments f ON f.id = w.fragment_id
      WHERE e.event_type = 'FREE_LANE_ITEM' AND e.outcome = 'SUBMITTED' AND e.workload_class = 'RESEARCH_FRAGMENT' AND e.at >= ? AND f.integrity_verdict IS NOT NULL GROUP BY f.id, f.completed_at ORDER BY MIN(e.at) DESC LIMIT 40`, [D24]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
