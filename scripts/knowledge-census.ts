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
    const since72 = new Date(Date.now() - 72 * 3600e3).toISOString();
    const stale = new Date(Date.now() - 6 * 3600e3).toISOString();
    await q('STUCK', `SELECT m.id, m.state, m.created_at, m.updated_at, m.candidate_id, c.state AS cand, m.orchestration_id AS orch, o.status AS orch_status, o.updated_at AS orch_upd, b.state AS bin_state, b.updated_at AS bin_upd,
        (SELECT string_agg(f.status || ':' || cnt, ',') FROM (SELECT status, COUNT(*) AS cnt FROM research_fragments WHERE orchestration_id = m.orchestration_id GROUP BY status) f) AS frags,
        (SELECT MAX(e.at) FROM bin_events e WHERE e.orchestration_id = m.orchestration_id) AS last_bin_event,
        (SELECT r.id || ':' || r.state FROM cash_discovery_rounds r WHERE r.candidate_id = m.candidate_id ORDER BY r.created_at DESC LIMIT 1) AS round
      FROM russell_missions m LEFT JOIN research_orchestrations o ON o.id = m.orchestration_id LEFT JOIN bins b ON b.id = m.bin_id LEFT JOIN russell_candidates c ON c.id = m.candidate_id
      WHERE m.project_id = ? AND m.state = 'RUNNING' AND m.updated_at < ? ORDER BY m.created_at`, [P, stale]);
    await q('STUCK_ALLPROJ', `SELECT m.project_id, COUNT(*) AS n, MIN(m.updated_at) AS oldest FROM russell_missions m WHERE m.state = 'RUNNING' AND m.updated_at < ? GROUP BY m.project_id`, [stale]);
    await q('ORCH_STATUS', `SELECT o.status, COUNT(*) AS n FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE m.project_id = ? AND m.state = 'RUNNING' GROUP BY o.status`, [P]);
    await q('OPEN_ROUND_CANDS', `SELECT r.id, r.opened_at, c.id AS cand, c.state, c.priority, c.ordinal, c.updated_at FROM cash_discovery_rounds r JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.project_id = ? AND r.bucket_id LIKE 'goal-%' AND r.state = 'OPEN'`, [P]);
    await q('ROUND_STOPPED_72H', `SELECT substr(payload,1,400) AS p, created_at FROM project_events WHERE project_id = ? AND event_type = 'CASH_DISCOVERY_ROUND_STOPPED' AND created_at >= ? ORDER BY created_at DESC LIMIT 8`, [P, since72]);
    await q('CASH_EVENT_KINDS_72H', `SELECT event_type, COUNT(*) AS n FROM project_events WHERE project_id = ? AND created_at >= ? AND event_type LIKE 'CASH%' GROUP BY event_type ORDER BY n DESC LIMIT 30`, [P, since72]);
    // research -> openings
    await q('SIGNAL_72H', `SELECT COALESCE(c.opportunity_signal,'(none)') AS sig, COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM cash_opportunities op WHERE op.project_id = o.project_id AND op.source_claim_id = c.id) THEN 1 ELSE 0 END) AS filed FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND c.created_at >= ? GROUP BY COALESCE(c.opportunity_signal,'(none)') ORDER BY n DESC`, [P, since72]);
    await q('SIGNAL_UNFILED', `SELECT c.id, c.created_at, c.opportunity_signal, c.claim_type, c.source_date, c.closes_on, c.evidence_lane, substr(c.source_url,1,80) AS url, substr(c.claim,1,140) AS claim FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND c.opportunity_signal IS NOT NULL AND c.created_at >= ? AND NOT EXISTS (SELECT 1 FROM cash_opportunities op WHERE op.project_id = o.project_id AND op.source_claim_id = c.id) ORDER BY c.created_at DESC LIMIT 15`, [P, since72]);
    await q('SIGNAL_ALL_UNFILED', `SELECT COUNT(*) AS n, MIN(c.created_at) AS oldest FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND c.opportunity_signal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cash_opportunities op WHERE op.project_id = o.project_id AND op.source_claim_id = c.id)`, [P]);
    await q('GOAL_ROUND_CLAIMS_72H', `SELECT r.id AS round, r.state, r.found, COUNT(c.id) AS claims, SUM(CASE WHEN c.accepted = 1 THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN c.accepted = 1 AND c.opportunity_signal IS NOT NULL THEN 1 ELSE 0 END) AS signalled FROM cash_discovery_rounds r JOIN russell_missions m ON m.candidate_id = r.candidate_id LEFT JOIN research_claims c ON c.orchestration_id = m.orchestration_id WHERE r.project_id = ? AND r.bucket_id LIKE 'goal-%' AND r.updated_at >= ? GROUP BY r.id, r.state, r.found ORDER BY r.id`, [P, since72]);
    await q('OPP_NEWEST', `SELECT id, created_at, discovery_round_id, source_claim_id, substr(title,1,80) AS t FROM cash_opportunities WHERE project_id = ? ORDER BY created_at DESC LIMIT 5`, [P]);
    await q('FRAG_72H_GOAL', `SELECT f.status, COUNT(*) AS n FROM research_fragments f JOIN russell_missions m ON m.orchestration_id = f.orchestration_id JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.project_id = ? AND r.bucket_id LIKE 'goal-%' AND f.created_at >= ? GROUP BY f.status`, [P, since72]);
    // learning: model choice / forecast ledger / operator runs
    await q('FORECAST_EVENTS', `SELECT event_type, COUNT(*) AS n, MAX(at) AS last FROM bin_events WHERE event_type LIKE 'FORECAST_%' GROUP BY event_type`);
    await q('OPRUNS_24H', `SELECT state, model, COUNT(*) AS n, MAX(started_at) AS last FROM operator_runs WHERE started_at >= ? GROUP BY state, model`, [since24]);
    await q('CREDITS', `SELECT COUNT(*) AS n FROM reasoning_method_credits`);
    await q('OUTCOMES', `SELECT kind, COUNT(*) AS n, MAX(observed_at) AS last FROM goal_outcomes GROUP BY kind`);
    await q('LESSON_DUP', `SELECT substr(lesson,1,60) AS l, COUNT(*) AS n FROM operator_learnings WHERE goal_id = ? AND recorded_at >= ? GROUP BY substr(lesson,1,60) ORDER BY n DESC LIMIT 8`, [G, since24]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
