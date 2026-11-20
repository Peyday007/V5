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
    const PARKED = "SELECT c.id FROM russell_candidates c WHERE c.state = 'PARKED' AND c.id IN (SELECT candidate_id FROM cash_needs WHERE request_key LIKE 'goal-price-%' AND candidate_id IS NOT NULL)";
    const ms = await q('A_MISSIONS', `SELECT * FROM russell_missions WHERE candidate_id IN (${PARKED}) ORDER BY created_at DESC LIMIT 3`);
    await q('A_MISSION_STATES', `SELECT state, COUNT(*) AS n FROM russell_missions WHERE candidate_id IN (${PARKED}) GROUP BY state`);
    const ids = ms.map((m) => m.id as string);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await q('A_MISSION_EVENTS', `SELECT entity_id, event_type, substr(payload,1,500) AS p, created_at FROM project_events WHERE entity_id IN (${ph}) ORDER BY created_at LIMIT 20`, ids);
      const orcs = ms.map((m) => m.orchestration_id as string).filter(Boolean);
      if (orcs.length) {
        const ph2 = orcs.map(() => '?').join(',');
        await q('A_PACKETS', `SELECT id, status, verdict, substr(failure_reason,1,300) AS why, created_at, completed_at FROM research_orchestrations WHERE id IN (${ph2})`, orcs);
        await q('A_FRAGS', `SELECT orchestration_id, status, substr(blocked_reason,1,200) AS why, COUNT(*) AS n FROM research_fragments WHERE orchestration_id IN (${ph2}) GROUP BY orchestration_id, status, why`, orcs);
      }
    }
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
