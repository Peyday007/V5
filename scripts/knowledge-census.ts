/**
 * Read-only probe (claude/probe-price-answers, round 2): why goal-price research
 * ideas never launch. SELECT and pure reads only; never merged.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { launchableByProject } from '../server/services/russell/loop.ts';

const trim = (r: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…` : v]));
async function q(label: string, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    const rows = await getDb().all<Record<string, unknown>>(sql, params as string[]);
    console.log(`${label} ${JSON.stringify(rows.map(trim))}`);
    return rows;
  } catch (e) {
    console.log(`${label} ERROR ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    return [];
  }
}
async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  try { console.log(`${label} ${JSON.stringify(await fn())}`); } catch (e) { console.log(`${label} ERROR ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`); }
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    await q('PLAN_QS', "SELECT n.state, substr(n.request_key,1,60) AS k, substr(n.blocked_action,1,160) AS what, n.candidate_id, n.created_at FROM cash_needs n WHERE n.request_key LIKE 'goal-plan-%' OR n.blocked_action LIKE '%goal:wst_7b4fcbb5f2384f31b6c3:plan%' ORDER BY n.created_at DESC LIMIT 12");
    await q('PLAN_Q_IDEAS', "SELECT c.state, COUNT(*) AS n FROM russell_candidates c WHERE c.id IN (SELECT candidate_id FROM cash_needs WHERE blocked_action LIKE '%goal:wst_7b4fcbb5f2384f31b6c3:plan%' AND candidate_id IS NOT NULL) GROUP BY c.state");
    await q('TIMING_QS', "SELECT n.state, substr(n.request_key,1,50) AS k, substr(n.blocked_action,1,200) AS what, n.created_at FROM cash_needs n WHERE (n.blocked_action LIKE '%days to usable cash%' OR n.blocked_action LIKE '%days_to_cash%' OR n.blocked_action LIKE '%deposit%') AND n.project_id = 'prj_22fb4fec295f403a8a22' ORDER BY n.created_at DESC LIMIT 8");
    await q('PLAN_Q_MISSIONS', "SELECT m.state, COUNT(*) AS n, MIN(m.created_at) AS first FROM russell_missions m WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE blocked_action LIKE '%goal:wst_7b4fcbb5f2384f31b6c3:plan%' AND candidate_id IS NOT NULL) GROUP BY m.state");
    await q('DAYS_TO_CASH_Q', "SELECT n.state, substr(n.request_key,1,60) AS k, substr(n.blocked_action,1,200) AS what, n.candidate_id, n.created_at FROM cash_needs n WHERE n.blocked_action LIKE '%days to cash%' ORDER BY n.created_at DESC LIMIT 8");
    await q('PLAN_Q_SINCE_LIVE', "SELECT COUNT(*) AS n FROM cash_needs n WHERE n.blocked_action LIKE '%goal:wst_%:plan%' AND n.created_at > '2026-11-22T04:10:00'");
    await q('MISSIONS_SINCE_LIVE', "SELECT m.state, COUNT(*) AS n FROM russell_missions m WHERE m.created_at > '2026-11-22T04:10:00' GROUP BY m.state");
    await q('GOAL_PRICE_IDEAS', "SELECT c.state, COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM russell_missions m WHERE m.candidate_id = c.id) THEN 1 ELSE 0 END) AS with_mission FROM russell_candidates c WHERE c.id IN (SELECT candidate_id FROM cash_needs WHERE state = 'OPEN' AND request_key LIKE 'goal-price-%' AND candidate_id IS NOT NULL) GROUP BY c.state");
    await q('PLAN_Q_JUDGED', "SELECT c.id, c.state, c.project_id, c.id AS cid, substr(c.judgment, strpos(c.judgment,'compilerVersion'), 700) AS judgment, c.updated_at FROM russell_candidates c WHERE c.id IN (SELECT candidate_id FROM cash_needs WHERE blocked_action LIKE '%goal:wst_7b4fcbb5f2384f31b6c3:plan%' AND candidate_id IS NOT NULL)");
    await q('PRICE_Q_JUDGED', "SELECT c.id, c.state, c.project_id, substr(c.judgment,1,300) AS judgment FROM russell_candidates c WHERE c.state = 'QUEUED' AND c.id IN (SELECT candidate_id FROM cash_needs WHERE state = 'OPEN' AND request_key LIKE 'goal-price-%') LIMIT 2");
    await q('PLAN_Q_SPEC', "SELECT c.id, c.priority, c.ordinal, CASE WHEN c.judgment LIKE '%\"missionSpec\"%' THEN 1 ELSE 0 END AS has_spec, CASE WHEN c.judgment LIKE '%\"proposedMission\"%' THEN 1 ELSE 0 END AS has_proposed, substr(c.reason,1,150) AS reason FROM russell_candidates c WHERE c.id IN (SELECT candidate_id FROM cash_needs WHERE blocked_action LIKE '%goal:wst_7b4fcbb5f2384f31b6c3:plan%' AND candidate_id IS NOT NULL)");
    await q('PRICE_Q_SPEC', "SELECT CASE WHEN c.judgment LIKE '%\"missionSpec\"%' THEN 1 ELSE 0 END AS has_spec, c.priority, COUNT(*) AS n FROM russell_candidates c WHERE c.state = 'QUEUED' AND c.id IN (SELECT candidate_id FROM cash_needs WHERE state = 'OPEN' AND request_key LIKE 'goal-price-%') GROUP BY 1, 2");
    await q('RUNNING_BY_PROJECT', "SELECT c.project_id, COUNT(*) AS n FROM russell_missions m JOIN russell_candidates c ON c.id = m.candidate_id WHERE m.state IN ('RUNNING','LAUNCHING','PLANNED','QUEUED') GROUP BY c.project_id");
    await step('SLOTS', async () => (await launchableByProject()).map((p) => ({ p: p.projectId.slice(0, 12), waiting: p.waiting, cap: p.slots?.cap ?? null, live: p.slots?.live ?? null, free: p.free })));
    await q('MAIN_RUNNING_AGE', "SELECT m.state, COUNT(*) AS n, MIN(m.created_at) AS oldest, MAX(m.created_at) AS newest FROM russell_missions m JOIN russell_candidates c ON c.id = m.candidate_id WHERE c.project_id = 'prj_22fb4fec295f403a8a22' AND m.state IN ('RUNNING','LAUNCHING','PLANNED','QUEUED') GROUP BY m.state");
    await q('MAIN_LAUNCHED_TODAY', "SELECT substr(m.created_at,1,13) AS hour, COUNT(*) AS n FROM russell_missions m JOIN russell_candidates c ON c.id = m.candidate_id WHERE c.project_id = 'prj_22fb4fec295f403a8a22' AND m.created_at > '2026-11-21T18:00:00' GROUP BY 1 ORDER BY 1");
    await q('PLAN_Q_MISSION_DETAIL', "SELECT m.id, m.state, m.waiting_on, m.orchestration_id, m.writeback_at, m.created_at, m.updated_at FROM russell_missions m WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE blocked_action LIKE '%goal:wst_7b4fcbb5f2384f31b6c3:plan%' AND candidate_id IS NOT NULL)");
    await q('PLAN_Q_FRAGS', "SELECT f.orchestration_id, f.status, f.attempt, COUNT(*) AS n FROM research_fragments f WHERE f.orchestration_id IN ('orc_694532fd32904450968a','orc_345b17a00c904f55957e') GROUP BY 1, 2, 3");
    await q('PLAN_Q_ORCH', "SELECT o.id, o.status, o.updated_at FROM research_orchestrations o WHERE o.id IN ('orc_694532fd32904450968a','orc_345b17a00c904f55957e')");
    await q('FRAG_QUEUE', "SELECT f.status, COUNT(*) AS n, MIN(f.created_at) AS oldest FROM research_fragments f WHERE f.created_at > '2026-11-15' GROUP BY f.status");
    await q('FRAG_DONE_BY_HOUR', "SELECT substr(f.updated_at,1,13) AS hour, f.status, COUNT(*) AS n FROM research_fragments f WHERE f.updated_at > '2026-11-22T00:00:00' AND f.status NOT IN ('QUEUED','PENDING') GROUP BY 1, 2 ORDER BY 1");
    await q('FRAG_QUEUE_PROJ', "SELECT f.project_id, COUNT(*) AS n FROM research_fragments f WHERE f.status = 'QUEUED' GROUP BY 1");
    await q('FL_CAP_EVENTS', "SELECT e.at, e.workload_class AS model, e.outcome, substr(e.reason,1,160) AS reason, substr(e.measures,1,160) AS measures FROM bin_events e WHERE e.event_type = 'FREE_LANE_CAPACITY' AND e.at > '2026-11-22T20:00:00' ORDER BY e.at DESC LIMIT 15");
    await q('FL_CLAIMS_BY_HOUR', "SELECT substr(e.at,1,13) AS hour, e.event_type, COUNT(*) AS n FROM bin_events e WHERE e.at > '2026-11-23T00:00:00' AND e.event_type IN ('CLAIMED','COMPLETED','FAILED','RELEASED','LEASE_EXPIRED','CHECKPOINT') GROUP BY 1, 2 ORDER BY 1, 2");
    await q('BIN_EVENT_TYPES', "SELECT e.event_type, COUNT(*) AS n FROM bin_events e WHERE e.at > '2026-11-23T03:00:00' GROUP BY 1 ORDER BY 2 DESC LIMIT 25");
    await q('FL_ITEM_OUTCOMES', "SELECT e.outcome, substr(e.reason,1,90) AS reason, COUNT(*) AS n FROM bin_events e WHERE e.event_type = 'FREE_LANE_ITEM' AND e.at > '2026-11-23T00:00:00' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15");
    await q('FL_ITEM_SAMPLE', "SELECT e.at, e.workload_class AS model, e.outcome, substr(e.reason,1,220) AS reason, e.duration_ms FROM bin_events e WHERE e.event_type = 'FREE_LANE_ITEM' ORDER BY e.at DESC LIMIT 8");
    await q('INFRA_FAILURES', "SELECT 1 AS probe_placeholder");
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
