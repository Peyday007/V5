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
    await q('GRANT', `SELECT id, project_id, state, max_concurrent, max_missions, expires_at FROM russell_goals WHERE id = 'rgl_2b3bcf1aa24f443382cf'`);
    await q('HELD', `SELECT r.id, r.amount, r.expires_at, m.id AS mission, m.state AS mstate, m.updated_at AS mupd, o.status AS ostatus, (SELECT b.purpose || ':' || b.state FROM bins b WHERE b.id = m.bin_id) AS bin FROM russell_budget_reservations r LEFT JOIN russell_missions m ON m.reservation_id = r.id LEFT JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE r.goal_id = 'rgl_2b3bcf1aa24f443382cf' AND r.kind = 'MISSION' AND r.state = 'HELD' AND r.expires_at > ? ORDER BY r.expires_at`, [nowIso]);
    await q('HELD_BY_STATE', `SELECT m.state AS mstate, o.status AS ostatus, COUNT(*) AS n FROM russell_budget_reservations r LEFT JOIN russell_missions m ON m.reservation_id = r.id LEFT JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE r.goal_id = 'rgl_2b3bcf1aa24f443382cf' AND r.kind = 'MISSION' AND r.state = 'HELD' AND r.expires_at > ? GROUP BY m.state, o.status`, [nowIso]);
    await q('BLOCKED_BINS', `SELECT b.id, b.purpose, b.state, b.orchestration_id, b.updated_at FROM bins b WHERE b.project_id = ? AND b.orchestration_id IN ('orc_f96ea5caa5d9466f8e30','orc_83fa14145d5343a79330') ORDER BY b.created_at`, [P]);
    await q('CAND_EVENTS', `SELECT entity_id, event_type, created_at, substr(payload,1,300) AS p FROM project_events WHERE entity_id IN ('rcn_8bf0215b80e9445cbc68','rcn_8be62682e4d04545a955') ORDER BY created_at DESC LIMIT 12`);
    await q('CAND_ROWS', `SELECT id, state, priority, ordinal, updated_at FROM russell_candidates WHERE id IN ('rcn_8bf0215b80e9445cbc68','rcn_8be62682e4d04545a955')`);
    await q('CAND_CASH_EVENTS', `SELECT kind, created_at, substr(summary,1,300) AS s FROM cash_events WHERE project_id = ? AND (summary LIKE '%rcn_8bf0215b%' OR summary LIKE '%rcn_8be62682%' OR detail LIKE '%rcn_8bf0215b%' OR detail LIKE '%rcn_8be62682%') ORDER BY created_at DESC LIMIT 8`, [P]);
    await q('ROUTINE_DECISIONS', `SELECT created_at, substr(payload,1,400) AS p FROM project_events WHERE project_id = ? AND event_type = 'RUSSELL_ROUTINE_DECISION' ORDER BY created_at DESC LIMIT 4`, [P]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
