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
    const PN = "SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND candidate_id IS NOT NULL";
    const FRAGS = `SELECT f.id FROM russell_missions m JOIN research_fragments f ON f.orchestration_id = m.orchestration_id WHERE m.candidate_id IN (${PN})`;
    await q('PACKETS', `SELECT o.status, COUNT(*) AS n FROM russell_missions m JOIN research_orchestrations o ON o.id = m.orchestration_id WHERE m.candidate_id IN (${PN}) GROUP BY o.status`);
    await q('FRAGS', `SELECT f.status, (f.required_evidence LIKE '%"id":"economics"%"necessity":"REQUIRED"%') AS econ, COUNT(*) AS n FROM research_fragments f WHERE f.id IN (${FRAGS}) GROUP BY f.status, econ`);
    await q('CLAIM_COLS', `SELECT * FROM research_claims WHERE fragment_id IN (${FRAGS}) LIMIT 1`);
    await q('FACT_COLS', 'SELECT * FROM construction_facts LIMIT 1');
    await q('ACCEPTED_FRAG_CLAIMS', `SELECT f.id AS frag, f.status, c.id AS claim, substr(c.statement,1,160) AS st, c.evidence_lane FROM research_fragments f JOIN research_claims c ON c.fragment_id = f.id WHERE f.id IN (${FRAGS}) AND f.status = 'ACCEPTED' LIMIT 12`);
    await q('FACTS_FROM_PRICE_CLAIMS', `SELECT cf.key, cf.status, cf.segment, cf.low, cf.high, cf.project_id, cf.created_at FROM construction_facts cf WHERE cf.source_claim_id IN (SELECT c.id FROM research_claims c WHERE c.fragment_id IN (${FRAGS})) LIMIT 20`);
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
