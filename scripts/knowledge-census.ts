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
  const since6 = new Date(Date.now() - 6 * 3600e3).toISOString();
  try {
    out('NOW', new Date().toISOString());
    // 1. rounds
    await q('ROUND_BUCKETS', `SELECT substr(bucket_id,1,40) AS b, state, COUNT(*) AS n, MIN(opened_at) AS first_open, MAX(updated_at) AS last_upd FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE 'goal-%' GROUP BY substr(bucket_id,1,40), state ORDER BY b, state`, [P]);
    await q('ROUND_STATE', `SELECT state, COUNT(*) AS n, MIN(opened_at) AS oldest_open, MAX(opened_at) AS newest_open, MIN(created_at) AS oldest_created FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE 'goal-%' GROUP BY state`, [P]);
    await q('ROUND_24H', `SELECT state, COUNT(*) AS n, SUM(found) AS found FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE 'goal-%' AND updated_at >= ? GROUP BY state`, [P, since24]);
    await q('ROUND_CREATED_24H', `SELECT state, COUNT(*) AS n FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE 'goal-%' AND created_at >= ? GROUP BY state`, [P, since24]);
    await q('ROUND_OPEN', `SELECT r.id, r.bucket_id, r.round, r.opened_at, r.created_at, r.candidate_id, c.state AS cand_state, (SELECT m.id||':'||m.state||':'||COALESCE(m.waiting_on,'')||':'||m.updated_at FROM russell_missions m WHERE m.candidate_id = r.candidate_id ORDER BY m.created_at DESC LIMIT 1) AS mission FROM cash_discovery_rounds r LEFT JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.project_id = ? AND r.bucket_id LIKE 'goal-%' AND r.state = 'OPEN' ORDER BY r.created_at LIMIT 40`, [P]);
    await q('ROUND_LAST20', `SELECT r.id, substr(r.bucket_id,1,50) AS b, r.state, r.found, r.created_at, r.opened_at, r.harvested_at, r.updated_at, c.state AS cand_state FROM cash_discovery_rounds r LEFT JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.project_id = ? AND r.bucket_id LIKE 'goal-%' ORDER BY r.updated_at DESC LIMIT 20`, [P]);
    // 2. missions
    await q('MISSION_STATE', `SELECT state, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(updated_at) AS newest FROM russell_missions WHERE project_id = ? GROUP BY state`, [P]);
    await q('MISSION_GOALID', `SELECT goal_id, state, COUNT(*) AS n FROM russell_missions WHERE project_id = ? AND created_at >= ? GROUP BY goal_id, state`, [P, since24]);
    await q('MISSION_DONE_24H', `SELECT state, COALESCE(substr(terminal_reason,1,80),'') AS why, COUNT(*) AS n, SUM(CASE WHEN document_id IS NOT NULL THEN 1 ELSE 0 END) AS with_doc FROM russell_missions WHERE project_id = ? AND (completed_at >= ? OR (updated_at >= ? AND state NOT IN ('ACTIVE','RUNNING','OPEN','WAITING'))) GROUP BY state, COALESCE(substr(terminal_reason,1,80),'') ORDER BY n DESC LIMIT 30`, [P, since24, since24]);
    await q('MISSION_LIVE', `SELECT id, state, waiting_on, created_at, updated_at, candidate_id, bin_id FROM russell_missions WHERE project_id = ? AND completed_at IS NULL AND state NOT IN ('DONE','FAILED','ABANDONED','CANCELLED','EXPIRED','COMPLETED') ORDER BY created_at LIMIT 30`, [P]);
    await q('MISSION_COMPLETED_HOURLY', `SELECT substr(completed_at,1,13) AS h, state, COUNT(*) AS n FROM russell_missions WHERE project_id = ? AND completed_at >= ? GROUP BY substr(completed_at,1,13), state ORDER BY h`, [P, since24]);
    // 3. plan freshness vs evidence
    await q('PLAN_LAST', `SELECT id, verdict, chosen_strategy, created_at, digest FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 8`, [G]);
    await q('PLAN_HOURLY', `SELECT substr(created_at,1,13) AS h, COUNT(*) AS n FROM goal_plan_readings WHERE workstream_id = ? AND created_at >= ? GROUP BY substr(created_at,1,13) ORDER BY h`, [G, since24]);
    await q('SCENARIO_RUNS', `SELECT r.id, r.state, r.started_at, r.finished_at, substr(COALESCE(r.error,''),1,160) AS err FROM scenario_runs r WHERE r.model_id IN (SELECT scenario_model_id FROM goal_plan_readings WHERE workstream_id = ?) ORDER BY r.started_at DESC LIMIT 10`, [G]);
    await q('SCENARIO_RUN_STATES_24H', `SELECT state, COUNT(*) AS n, MAX(started_at) AS last FROM scenario_runs WHERE started_at >= ? GROUP BY state`, [since24]);
    await q('OBJ_READINGS', `SELECT id, verdict, chosen_strategy, substr(COALESCE(error,''),1,200) AS err, calls, created_at FROM goal_objective_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 6`, [G]);
    await q('OBJ_ERR_24H', `SELECT substr(COALESCE(error,''),1,120) AS err, COUNT(*) AS n FROM goal_objective_readings WHERE workstream_id = ? AND created_at >= ? GROUP BY substr(COALESCE(error,''),1,120)`, [G, since24]);
    await q('ACCEPTED_CLAIMS_LATEST', `SELECT c.id, c.created_at, c.validation_state, substr(c.claim,1,120) AS claim FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 ORDER BY c.created_at DESC LIMIT 8`, [P]);
    await q('CLAIMS_24H', `SELECT c.accepted, COUNT(*) AS n, MAX(c.created_at) AS last FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.created_at >= ? GROUP BY c.accepted`, [P, since24]);
    await q('FACTS_LATEST', `SELECT id, fact_key, status, source_claim_id, created_at FROM construction_facts WHERE (project_id = ? OR workstream_id = ?) AND source_claim_id IS NOT NULL ORDER BY created_at DESC LIMIT 6`, [P, G]);
    await q('OPP_LATEST', `SELECT COUNT(*) AS n, MAX(created_at) AS last_created, MAX(updated_at) AS last_upd FROM cash_opportunities WHERE project_id = ?`, [P]);
    await q('CARDFACT_LATEST', `SELECT COUNT(*) AS n, MAX(updated_at) AS last_upd FROM cash_card_facts WHERE project_id = ?`, [P]);
    await q('GOAL_EVENTS_24H', `SELECT event_type, COUNT(*) AS n, MAX(created_at) AS last FROM project_events WHERE entity_id = ? AND created_at >= ? GROUP BY event_type ORDER BY n DESC LIMIT 30`, [G, since24]);
    await q('DEGRADED_LAST', `SELECT created_at, substr(payload,1,300) AS p FROM project_events WHERE entity_id = ? AND event_type = 'GOAL_PLAN_DEGRADED' ORDER BY created_at DESC LIMIT 12`, [G]);
    await q('WS_EVENTS_24H', `SELECT kind, COUNT(*) AS n, MAX(created_at) AS last FROM workstream_events WHERE workstream_id = ? AND created_at >= ? GROUP BY kind ORDER BY n DESC LIMIT 30`, [G, since24]);
    await q('TICK_ERRS', `SELECT event_type, created_at, substr(payload,1,300) AS p FROM project_events WHERE created_at >= ? AND (payload LIKE '%goal-plans%' OR payload LIKE '%goalPlans%' OR event_type LIKE '%GOAL_PLAN%') ORDER BY created_at DESC LIMIT 10`, [since6]);
    // 4. learning
    await q('OPLEARN', `SELECT goal_id, COUNT(*) AS n, MIN(recorded_at) AS first, MAX(recorded_at) AS last FROM operator_learnings GROUP BY goal_id ORDER BY last DESC LIMIT 10`);
    await q('OPLEARN_LAST', `SELECT id, goal_id, run_id, substr(lesson,1,200) AS lesson, substr(evidence,1,160) AS ev, recorded_at FROM operator_learnings ORDER BY recorded_at DESC LIMIT 6`);
    await q('OPRUNS_24H', `SELECT state, COUNT(*) AS n, MAX(created_at) AS last FROM operator_runs WHERE created_at >= ? GROUP BY state`, [since24]);
    await q('RM_SUMMARY', `SELECT origin, stance, COUNT(*) AS n, SUM(tries) AS tries, SUM(improvements) AS imp, SUM(wins) AS wins, MAX(last_used_at) AS last FROM reasoning_methods GROUP BY origin, stance ORDER BY tries DESC LIMIT 30`);
    await q('RM_RECENT', `SELECT COUNT(*) AS n, MAX(last_used_at) AS last, MAX(created_at) AS last_created FROM reasoning_methods`);
    await q('REXPL', `SELECT id, created_at, directions, model_directions, baseline_reach, greedy_reach, best_reach, best_method, replaced, variations FROM reasoning_explorations WHERE goal_id = ? ORDER BY created_at DESC LIMIT 6`, [G]);
    await q('REXPL_HOURLY', `SELECT substr(created_at,1,13) AS h, COUNT(*) AS n, SUM(replaced) AS replaced FROM reasoning_explorations WHERE goal_id = ? AND created_at >= ? GROUP BY substr(created_at,1,13) ORDER BY h`, [G, since24]);
    await q('FORECAST_EVENTS', `SELECT event_type, COUNT(*) AS n, MAX(created_at) AS last FROM bin_events WHERE event_type LIKE 'FORECAST_%' GROUP BY event_type`);
    await q('SALES_LEARN', `SELECT kind, COUNT(*) AS n, MAX(recorded_at) AS last FROM sales_learnings GROUP BY kind`);
    await q('EVOL', `SELECT state, verdict, COUNT(*) AS n, MAX(created_at) AS last FROM evolution_experiments GROUP BY state, verdict`);
    await q('SHARED_FINDINGS', `SELECT state, COUNT(*) AS n, MAX(created_at) AS last FROM shared_findings GROUP BY state`);
    await q('SHARED_FINDINGS_24H', `SELECT state, COUNT(*) AS n FROM shared_findings WHERE created_at >= ? GROUP BY state`, [since24]);
    await q('DEADLINE_OUT', `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM deadline_outcomes`);
    await q('BIN_EVENT_KINDS_24H', `SELECT event_type, COUNT(*) AS n FROM bin_events WHERE created_at >= ? GROUP BY event_type ORDER BY n DESC LIMIT 40`, [since24]);
    await q('PROJ_EVENT_KINDS_24H', `SELECT event_type, COUNT(*) AS n FROM project_events WHERE project_id = ? AND created_at >= ? GROUP BY event_type ORDER BY n DESC LIMIT 50`, [P, since24]);
    await q('TABLES_LEARN', `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE '%learn%' OR table_name LIKE '%retain%' OR table_name LIKE '%bench%' OR table_name LIKE '%model_choice%' OR table_name LIKE '%decision%' OR table_name LIKE '%method%')`);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
