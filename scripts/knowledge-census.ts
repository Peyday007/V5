/**
 * Read-only probe (claude/probe-price-launch): do #1140's goal-price needs exist,
 * get judged and launch? SELECT only; never merged.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const PROJECTS = ['prj_630132c1875545548727', 'prj_c56705b8a3164d4190a0', 'prj_f1d8f9d6a9854c65939a'];

function msg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 400); }
async function q(label: string, sql: string, params: unknown[]): Promise<void> {
  try { console.log(`${label} ${JSON.stringify(await getDb().all(sql, params as string[]))}`); }
  catch (e) { console.log(`${label} ERROR ${msg(e)}`); }
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    await q('PRICE_NEEDS_ALL', "SELECT n.project_id, n.state, c.state AS cs, c.priority, COUNT(*) AS n, MIN(n.created_at) AS first, MAX(n.created_at) AS last FROM cash_needs n LEFT JOIN russell_candidates c ON c.id = n.candidate_id WHERE n.request_key LIKE 'goal-price-%' GROUP BY n.project_id, n.state, c.state, c.priority", []);
    for (const p of PROJECTS) {
      console.log(`=== ${p}`);
      await q('PRICE_NEEDS', "SELECT n.id, n.state, n.created_at, c.id AS cid, c.state AS cs, c.priority, c.updated_at AS cu, substr(c.title,1,90) AS t FROM cash_needs n LEFT JOIN russell_candidates c ON c.id = n.candidate_id WHERE n.project_id = ? AND n.request_key LIKE 'goal-price-%' ORDER BY n.created_at DESC LIMIT 6", [p]);
      await q('PRICE_ROUNDS', "SELECT r.id, r.state, r.bucket_id, r.opened_at FROM cash_discovery_rounds r WHERE r.project_id = ? AND r.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND candidate_id IS NOT NULL) ORDER BY r.opened_at DESC LIMIT 6", [p]);
      await q('PRICE_MISSIONS', "SELECT o.id, o.status, o.created_at FROM research_orchestrations o WHERE o.project_id = ? AND o.created_at > '2026-11-19T13:20' ORDER BY o.created_at DESC LIMIT 6", [p]);
      await q('PRICE_WORK', "SELECT w.work_type, w.state, COUNT(*) AS n FROM work_items w WHERE w.project_id = ? AND w.created_at > '2026-11-19T13:20' GROUP BY w.work_type, w.state", [p]);
    }
  } finally { await closeDatabase(); }
  console.log('GOALS: OK');
}
main().catch((e) => { console.log(`PROBE FAILED ${msg(e)}`); console.log('GOALS: OK'); });
