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
    await q('PRICE_CANDS', `SELECT c.project_id, c.state, c.priority, (c.judgment LIKE '%"missionSpec"%') AS has_spec, COUNT(*) AS n, MIN(c.created_at) AS first FROM russell_candidates c WHERE c.id IN (${PRICE}) GROUP BY c.project_id, c.state, c.priority, has_spec`);
    await q('PRICE_SAMPLE', `SELECT c.id, c.project_id, substr(c.title,1,90) AS title, c.updated_at, substr(c.state_reason,1,140) AS reason FROM russell_candidates c WHERE c.id IN (${PRICE}) ORDER BY c.created_at LIMIT 5`);
    const loop = await import('../server/services/russell/loop.ts');
    const slots = await loop.launchableByProject();
    console.log(`SLOTS ${JSON.stringify(slots)}`);
    await q('LIVE_MISSIONS', "SELECT m.project_id, m.state, COUNT(*) AS n FROM russell_missions m WHERE m.state NOT IN ('DONE','FAILED','CANCELLED','PARKED') GROUP BY m.project_id, m.state");
    await step('NEXT_LAUNCHABLE', async () => {
      const next = await loop.nextLaunchable(400);
      const price = new Set((await getDb().all<{ candidate_id: string }>(PRICE)).map((r) => r.candidate_id));
      return {
        total: next.length,
        fits: next.filter((n) => n.fitsFreeSlot).length,
        priceInWindow: next.filter((n) => price.has(n.candidateId)).length,
        priceFits: next.filter((n) => price.has(n.candidateId) && n.fitsFreeSlot).length,
        firstFits: next.filter((n) => n.fitsFreeSlot).slice(0, 8).map((n) => n.candidateId),
      };
    });
    await q('MODES', "SELECT project_id, state, updated_at FROM cash_modes ORDER BY updated_at DESC LIMIT 10");
    await q('RECENT_LAUNCH_EVENTS', "SELECT event_type, COUNT(*) AS n, MAX(created_at) AS last FROM project_events WHERE created_at > '2026-11-19T13:00' AND (event_type LIKE '%LAUNCH%' OR event_type LIKE 'RUSSELL_MISSION%') GROUP BY event_type ORDER BY n DESC LIMIT 12");
  } finally {
    await closeDatabase();
    console.log('CENSUS: OK');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
