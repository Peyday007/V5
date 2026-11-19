/** Throwaway read-only probe (claude/probe-d5): rounds, missions, plan freshness, learning records. SELECT only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { constructedShare, MAX_LIVE_GOAL_ROUNDS, roundsStillResearching } from '../server/services/cash/discovery.ts';
import { cashSpareSurfaces, constructedCapFor } from '../server/services/cash/researchRoom.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const P = 'prj_22fb4fec295f403a8a22';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args as any); for (const r of rows) out(tag, r); if (!rows.length) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
async function main() {
  await initDatabase();
  const since24 = new Date(Date.now() - 24 * 3600e3).toISOString();
  
  try {
    out('NOW', new Date().toISOString());
    const SINCE = '2026-11-19T01:07:00.000Z';
    await q('R2821', `SELECT r.id, r.state, r.round, r.found, r.created_at, r.opened_at, r.harvested_at, c.state AS cand, c.statement AS question FROM cash_discovery_rounds r LEFT JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.project_id = ? AND r.bucket_id LIKE '%-mx-2821cce3c372' ORDER BY r.created_at`, [P]);
    await q('MX_OPENED_SINCE', `SELECT r.id, r.bucket_id, r.state, r.created_at FROM cash_discovery_rounds r WHERE r.project_id = ? AND r.bucket_id LIKE 'goal-wst_7b4fcbb5f2384f31b6c3-%' AND r.created_at >= ? ORDER BY r.created_at`, [P, SINCE]);
    try {
      const rounds = await listRounds(P);
      const mine = rounds.filter((r) => r.bucketId.startsWith(`goal-${G}`));
      const mx = mine.filter((r) => r.bucketId.startsWith(`goal-${G}-mx-`));
      const spare = await cashSpareSurfaces(P);
      const liveCap = MAX_LIVE_GOAL_ROUNDS + Math.max(0, spare);
      const openMx = mx.filter((r) => r.state === 'OPEN');
      const researchingMx = await roundsStillResearching(openMx);
      out('ROOM', { spare, liveCap, constructedShare: constructedShare(liveCap), openMx: openMx.length, researchingMx, room: constructedShare(liveCap) - researchingMx, openAll: mine.filter((r) => r.state === 'OPEN').length, researchingAll: await roundsStillResearching(mine), focusCap: await constructedCapFor(P) });
      out('OPEN_MX', openMx.map((r) => ({ id: r.id, b: r.bucketId.slice(-16), openedAt: r.openedAt })));
    } catch (e) { out('ROOM_ERR', String(e)); }
    try {
      const rec: any = await arrangementForLegacyKey(P, '2821cce3c372');
      const a = rec?.design?.arrangement;
      out('LIB2821', rec ? { updatedAt: rec.updatedAt, askedCount: rec.askedCount, verdict: rec.verdict, value: a?.value ? { tier: a.value.tier, p50: a.value.p50, observations: a.value.observations } : null, fixedCost: a?.fixedCost ?? null, exposure: a?.stress?.exposure } : null);
    } catch (e) { out('LIB_ERR', String(e)); }
    await q('PLAN_LAST', `SELECT id, verdict, created_at FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 4`, [G]);
    await q('WS_EVENTS', `SELECT kind, created_at, substr(summary,1,200) AS s FROM workstream_events WHERE workstream_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 15`, [G, SINCE]);
    await q('CASH_OPENED', `SELECT kind, created_at, substr(summary,1,220) AS s FROM cash_events WHERE project_id = ? AND kind IN ('CASH_DISCOVERY_OPENED','CASH_DISCOVERY_ROUND_STOPPED') AND created_at >= ? ORDER BY created_at DESC LIMIT 10`, [P, SINCE]);
    await q('DEGRADED', `SELECT created_at, substr(payload,1,300) AS p FROM project_events WHERE entity_id = ? AND event_type = 'GOAL_PLAN_DEGRADED' AND created_at >= ? ORDER BY created_at DESC LIMIT 5`, [G, SINCE]);
    await q('CYCLE', `SELECT last_ran_at, substr(COALESCE(last_error,''),1,800) AS err FROM russell_cycle`);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
