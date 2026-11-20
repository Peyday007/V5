/**
 * Read-only probe (claude/probe-price-answers): have goal-price research needs
 * produced answers, and where did they stop? SELECT only; never merged.
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

async function main(): Promise<void> {
  await initDatabase();
  try {
    await q('NEED_STATES', "SELECT state, COUNT(*) AS n, MIN(created_at) AS first, MAX(updated_at) AS last FROM cash_needs WHERE request_key LIKE 'goal-price-%' GROUP BY state");
    const needs = await q('NEEDS', "SELECT id, project_id, state, request_key, candidate_id, created_at, updated_at, verified_by FROM cash_needs WHERE request_key LIKE 'goal-price-%' ORDER BY created_at DESC LIMIT 40");
    const cands = needs.map((n) => n.candidate_id).filter(Boolean) as string[];
    if (cands.length) {
      const ph = cands.map(() => '?').join(',');
      await q('CANDIDATES', `SELECT state, priority, COUNT(*) AS n FROM russell_candidates WHERE id IN (${ph}) GROUP BY state, priority`, cands);
      await q('MISSION_COLS', 'SELECT * FROM russell_missions LIMIT 1');
      const missions = await q('MISSIONS', `SELECT * FROM russell_missions WHERE candidate_id IN (${ph}) ORDER BY created_at DESC LIMIT 40`, cands);
      const orcs = [...new Set(missions.flatMap((m) => Object.entries(m).filter(([k, v]) => /orchestration|packet/.test(k) && typeof v === 'string').map(([, v]) => v as string)))];
      if (orcs.length) {
        const ph2 = orcs.map(() => '?').join(',');
        await q('PACKETS', `SELECT id, status, verdict, substr(title,1,80) AS title, created_at, completed_at FROM research_orchestrations WHERE id IN (${ph2})`, orcs);
        await q('PACKET_FRAGMENTS', `SELECT orchestration_id, status, COUNT(*) AS n FROM research_fragments WHERE orchestration_id IN (${ph2}) GROUP BY orchestration_id, status`, orcs);
        await q('PACKET_CLAIMS', `SELECT f.orchestration_id, COUNT(c.id) AS claims FROM research_fragments f LEFT JOIN research_claims c ON c.fragment_id = f.id WHERE f.orchestration_id IN (${ph2}) GROUP BY f.orchestration_id`, orcs);
      }
    }
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
