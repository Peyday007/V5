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
    const PRICE = "SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND state = 'OPEN' AND candidate_id IS NOT NULL";
    await q('PRICE_CANDS', `SELECT c.project_id, c.state, COUNT(*) AS n FROM russell_candidates c WHERE c.id IN (${PRICE}) GROUP BY c.project_id, c.state`);
    await q('PRICE_MISSIONS', `SELECT m.project_id, m.state, COUNT(*) AS n, MIN(m.created_at) AS first, MAX(m.updated_at) AS last FROM russell_missions m WHERE m.candidate_id IN (${PRICE}) AND m.created_at > '2026-11-20T03:00' GROUP BY m.project_id, m.state`);
    await q('PRICE_PACKETS', `SELECT o.status, COUNT(*) AS n, MAX(substr(o.failure_reason,1,200)) AS why FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE m.candidate_id IN (${PRICE}) AND m.created_at > '2026-11-20T03:00' GROUP BY o.status`);
    await q('PRICE_FRAGS', `SELECT f.status, COUNT(*) AS n FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id WHERE m.candidate_id IN (${PRICE}) AND m.created_at > '2026-11-20T03:00' GROUP BY f.status`);
    await q('PRICE_DECISIONS', `SELECT substr(e.payload, 1, 260) AS p, e.created_at FROM project_events e WHERE e.event_type = 'RUSSELL_ROUTINE_DECISION' AND e.created_at > '2026-11-20T03:00' AND e.entity_id IN (SELECT m.id FROM russell_missions m WHERE m.candidate_id IN (${PRICE})) LIMIT 5`);
    const loop = await import('../server/services/russell/loop.ts');
    console.log(`SLOTS ${JSON.stringify((await loop.launchableByProject()).map((s) => ({ p: s.projectId.slice(0, 12), w: s.waiting, cap: s.slots?.cap, live: s.slots?.live })))}`);
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
