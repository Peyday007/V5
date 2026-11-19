/** Throwaway read-only probe (claude/probe-agentrx): find a real failed execution for AgentRx. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args as any); for (const r of rows) out(tag, r); if (!rows.length) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
async function main() {
  await initDatabase();
  try {
    const A = '2026-11-18T15:00:00.000Z', B = '2026-11-18T17:15:00.000Z';
    await q('EXPIRED_BY_TYPE', `SELECT w.work_type, l.outcome, COUNT(*) AS n, SUM(l.heartbeat_count) AS hb FROM work_leases l JOIN work_items w ON w.id = l.work_item_id WHERE l.claimed_at >= ? AND l.claimed_at < ? GROUP BY w.work_type, l.outcome ORDER BY n DESC`, [A, B]);
    const rows = await q('EXPIRED_SAMPLE', `SELECT l.work_item_id, w.work_type, w.orchestration_id, w.fragment_id, w.state, w.attempt_count, w.max_attempts, w.failure_category, substr(COALESCE(w.result_summary,''),1,200) AS summary, l.attempt_number, l.claimed_at, l.expires_at, l.heartbeat_count, l.ended_at, l.outcome, substr(COALESCE(l.detail,''),1,200) AS detail FROM work_leases l JOIN work_items w ON w.id = l.work_item_id WHERE l.claimed_at >= ? AND l.claimed_at < ? AND l.outcome = 'EXPIRED' ORDER BY l.claimed_at LIMIT 12`, [A, B]);
    const orcs = [...new Set(rows.map((r: any) => r.orchestration_id).filter(Boolean))].slice(0, 4);
    for (const o of orcs) {
      await q('ORC', `SELECT id, title, status, verdict, attempt, substr(COALESCE(failure_reason,''),1,300) AS failure_reason, created_at, completed_at, failed_at FROM research_orchestrations WHERE id = ?`, [o]);
      await q('ORC_ITEMS', `SELECT w.id, w.work_type, w.state, w.attempt_count, w.max_attempts, w.failure_category, (SELECT COUNT(*) FROM work_leases l WHERE l.work_item_id = w.id) AS leases FROM work_items w WHERE w.orchestration_id = ? ORDER BY w.created_at`, [o]);
      await q('ORC_EVENTS', `SELECT entity_type, event_type, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM project_events WHERE entity_id = ? OR payload LIKE ? GROUP BY entity_type, event_type ORDER BY first`, [o, `%${o}%`]);
    }
    const wis = rows.slice(0, 3).map((r: any) => r.work_item_id);
    for (const w of wis) await q('WI_EVENTS', `SELECT entity_type, entity_id, event_type, created_at, substr(payload,1,400) AS p FROM project_events WHERE entity_id = ? OR payload LIKE ? ORDER BY created_at LIMIT 20`, [w, `%${w}%`]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
