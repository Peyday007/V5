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
    await q('PARKED_COLS', `SELECT * FROM russell_candidates c WHERE c.id IN (${PRICE}) AND c.state = 'PARKED' LIMIT 1`);
    await q('PARKED_JUDGMENT', `SELECT c.id, c.updated_at, substr(c.judgment, 1, 900) AS j FROM russell_candidates c WHERE c.id IN (${PRICE}) AND c.state = 'PARKED' LIMIT 3`);
    await q('PARKED_EVENTS', `SELECT e.event_type, substr(e.payload,1,400) AS p, e.created_at FROM project_events e WHERE e.entity_id IN (SELECT c.id FROM russell_candidates c WHERE c.id IN (${PRICE}) AND c.state = 'PARKED') ORDER BY e.created_at DESC LIMIT 6`);
    await q('A_GRANT', "SELECT * FROM research_goals WHERE project_id = 'prj_630132c1875545548727' ORDER BY created_at DESC LIMIT 2");
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
