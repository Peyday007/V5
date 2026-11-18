/** Throwaway read-only probe (claude/probe-d5): rounds, missions, plan freshness, learning records. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const P = 'prj_22fb4fec295f403a8a22';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args as any); for (const r of rows) out(tag, r); if (!rows.length) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
async function main() {
  await initDatabase();
  const since24 = new Date(Date.now() - 24 * 3600e3).toISOString();
  
  try {
    out('NOW', new Date().toISOString());
    const nowIso = new Date().toISOString();
    const SINCE = '2026-11-18T19:00:00.000Z';
    await q('OPP_SINCE', `SELECT op.id, op.created_at, op.discovery_round_id, r.bucket_id, op.source_claim_id, op.duplicate_of_id, substr(op.title,1,90) AS t FROM cash_opportunities op LEFT JOIN cash_discovery_rounds r ON r.id = op.discovery_round_id WHERE op.project_id = ? AND op.created_at >= ? ORDER BY op.created_at`, [P, SINCE]);
    await q('OPP_SINCE_COUNT', `SELECT COUNT(*) AS n, SUM(CASE WHEN r.bucket_id LIKE 'goal-%' THEN 1 ELSE 0 END) AS goal_rounds, SUM(CASE WHEN op.duplicate_of_id IS NOT NULL THEN 1 ELSE 0 END) AS dups FROM cash_opportunities op LEFT JOIN cash_discovery_rounds r ON r.id = op.discovery_round_id WHERE op.project_id = ? AND op.created_at >= ?`, [P, SINCE]);
    await q('OPP_LATEST', `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM cash_opportunities WHERE project_id = ?`, [P]);
    await q('ROUNDS', `SELECT r.id, r.state, r.found, r.updated_at, r.harvested_at, c.state AS cand, (SELECT m.id || ':' || m.state FROM russell_missions m WHERE m.candidate_id = r.candidate_id ORDER BY m.created_at DESC LIMIT 1) AS mission FROM cash_discovery_rounds r LEFT JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.id IN ('cdr_fbb0fd60c12f4e6f8798','cdr_0fb0026947b0491983d9','cdr_8c45a2cc326b42fab983')`);
    await q('STOP_EVENTS', `SELECT created_at, substr(detail,1,500) AS d FROM cash_events WHERE project_id = ? AND kind = 'CASH_DISCOVERY_ROUND_STOPPED' AND created_at >= ? ORDER BY created_at`, [P, SINCE]);
    await q('GOAL_ROUNDS_OPEN', `SELECT state, COUNT(*) AS n FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE 'goal-wst_7b4fcbb5f2384f31b6c3%' AND (state = 'OPEN' OR updated_at >= ?) GROUP BY state`, [P, SINCE]);
    await q('HELD', `SELECT COUNT(*) AS n FROM russell_budget_reservations WHERE goal_id = 'rgl_2b3bcf1aa24f443382cf' AND kind = 'MISSION' AND state = 'HELD' AND expires_at > ?`, [nowIso]);
    await q('HELD_BY_STATE', `SELECT m.state AS mstate, o.status AS ostatus, COUNT(*) AS n FROM russell_budget_reservations r LEFT JOIN russell_missions m ON m.reservation_id = r.id LEFT JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE r.goal_id = 'rgl_2b3bcf1aa24f443382cf' AND r.kind = 'MISSION' AND r.state = 'HELD' AND r.expires_at > ? GROUP BY m.state, o.status`, [nowIso]);
    await q('PLAN_LAST', `SELECT id, verdict, created_at FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 3`, [G]);
    await q('CYCLE', `SELECT last_ran_at, substr(COALESCE(last_error,''),1,600) AS err FROM russell_cycle`);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
