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
    const PRICE_ALL = "SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND state = 'OPEN' AND candidate_id IS NOT NULL";
    await q('NEED_IDEA_STATES', `SELECT c.project_id, c.state, COUNT(*) AS n FROM russell_candidates c WHERE c.id IN (${PRICE_ALL}) GROUP BY c.project_id, c.state`);
    await q('REASKED', "SELECT project_id, COUNT(*) AS n, MIN(created_at) AS first FROM russell_candidates WHERE title LIKE 'Causal unknown:%' AND created_at > '2026-11-20T04:10' GROUP BY project_id");
    await q('PRICE_MISSIONS_SINCE', `SELECT m.project_id, m.state, COUNT(*) AS n FROM russell_missions m WHERE m.candidate_id IN (${PRICE_ALL}) AND m.created_at > '2026-11-20T03:22:30' GROUP BY m.project_id, m.state`);
    await q('PRICE_PACKETS_SINCE', `SELECT o.status, COUNT(*) AS n, MAX(substr(o.failure_reason,1,160)) AS why FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE m.candidate_id IN (${PRICE_ALL}) AND m.created_at > '2026-11-20T03:22:30' GROUP BY o.status`);
    await q('PRICE_PACKETS_ALL', `SELECT o.status, o.verdict, COUNT(*) AS n FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%') AND m.created_at > '2026-11-20T03:22:30' GROUP BY o.status, o.verdict`);
    await q('PRICE_CLAIM_STATES', `SELECT c.status, COUNT(*) AS n FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id JOIN research_claims c ON c.fragment_id = f.id WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%') GROUP BY c.status`);
    await q('PRICE_CLAIM_SAMPLE', `SELECT substr(c.claim_text,1,200) AS t, c.status, c.created_at FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id JOIN research_claims c ON c.fragment_id = f.id WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%') ORDER BY c.created_at DESC LIMIT 6`);
    await q('PRICE_FRAG_STATES', `SELECT f.status, substr(f.blocked_reason,1,120) AS why, COUNT(*) AS n FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%') AND m.created_at > '2026-11-20T03:22:30' GROUP BY f.status, why`);
    const PN = "SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND candidate_id IS NOT NULL";
    await q('NEW_PROFILE_FRAGS', `SELECT f.status, (f.required_evidence LIKE '%"id":"economics"%"necessity":"REQUIRED"%') AS econ_required, COUNT(*) AS n FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id WHERE m.candidate_id IN (${PN}) AND m.created_at > '2026-11-20T09:30' GROUP BY f.status, econ_required`);
    await q('ACCEPTED_FRAGS_ALL', `SELECT f.status, COUNT(*) AS n FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id WHERE m.candidate_id IN (${PN}) GROUP BY f.status`);
    await q('NEED_STATES_ALL', "SELECT state, COUNT(*) AS n FROM cash_needs WHERE request_key LIKE 'goal-price-%' GROUP BY state");
    await q('PRICE_CLAIMS', `SELECT COUNT(c.id) AS claims FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id JOIN research_claims c ON c.fragment_id = f.id WHERE m.candidate_id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%')`);
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
