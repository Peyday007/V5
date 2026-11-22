/**
 * Read-only probe (claude/probe-price-answers, round 2): why goal-price research
 * ideas never launch. SELECT and pure reads only; never merged.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

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
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
