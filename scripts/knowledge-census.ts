/** Throwaway read-only probe (claude/probe-d5-live): why 2821 got no price re-ask after #1117. SELECT / pure reads only. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { constructedShare, MAX_LIVE_GOAL_ROUNDS, roundsStillResearching, staleUnlaunchedRounds, liveConstructedResearch, nextGoalRoundFor, priceReaskRound } from '../server/services/cash/discovery.ts';
import { cashSpareSurfaces, constructedCapFor } from '../server/services/cash/researchRoom.ts';
import { knowledgeResearchAllowed } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { missionsForRounds } from '../server/services/russell/roundMissions.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const P = 'prj_22fb4fec295f403a8a22';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(tag: string, sql: string, args: unknown[] = []): Promise<any[]> {
  try { const rows = await getDb().all(sql, args as any); for (const r of rows) out(tag, r); if (!rows.length) out(tag, 'NONE'); return rows; }
  catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const step = async (tag: string, f: () => Promise<unknown>) => { try { out(tag, await f()); } catch (e) { out('ERR', `${tag} :: ${e instanceof Error ? e.stack?.slice(0, 400) : e}`); } };
async function main() {
  await initDatabase();
  try {
    const now = new Date().toISOString();
    out('NOW', now);
    const prefix = `goal-${G}`;
    const all = await listRounds(P);
    const mine = all.filter((one) => one.bucketId === prefix || one.bucketId.startsWith(`${prefix}-`));
    const mx = mine.filter((one) => one.bucketId.startsWith(`${prefix}-mx-`));
    const openMx = mx.filter((r) => r.state === 'OPEN');
    const spare = await cashSpareSurfaces(P);
    const liveCap = MAX_LIVE_GOAL_ROUNDS + Math.max(0, spare);
    await step('GATE_RESEARCH_ALLOWED', async () => { const g = await knowledgeResearchAllowed(P); return { allowed: g.allowed, basis: g.basis, mode: !!g.mode, reason: (g as any).reason ?? null }; });
    await step('PLAN_ROOM', async () => {
      const researching = await roundsStillResearching(openMx);
      const stale = await staleUnlaunchedRounds(openMx, now);
      const share = constructedShare(liveCap);
      return { spare, liveCap, share, researching, stale, room: share - researching, priceOnlyRoom: share - (researching - stale) };
    });
    await step('OPEN_GATE_CAPS', async () => {
      const stMx = await staleUnlaunchedRounds(mx, now), stMine = await staleUnlaunchedRounds(mine, now);
      const rMx = await roundsStillResearching(mx), rMine = await roundsStillResearching(mine);
      const focusCap = await constructedCapFor(P); const live = await liveConstructedResearch(mx);
      return { rMx, stMx, share: constructedShare(liveCap), rMine, stMine, liveCap, liveCapBlocks: rMx - stMx >= constructedShare(liveCap) && rMine - stMine >= liveCap, focusCap, liveConstructed: live, focusBlocks: focusCap !== null && live - stMx >= focusCap };
    });
    await step('MX_ROUNDS', async () => {
      const ms = await missionsForRounds(mx.map((r) => r.candidateId));
      return mx.filter((r) => r.state === 'OPEN' || ms.get(r.candidateId)?.latest && !['DONE','FAILED','CANCELLED'].includes((ms.get(r.candidateId) as any).latest.state)).map((r) => ({ id: r.id, key: r.bucketId.slice(-12), state: r.state, openedAt: r.openedAt, mission: (ms.get(r.candidateId) as any)?.latest ? { id: (ms.get(r.candidateId) as any).latest.id, state: (ms.get(r.candidateId) as any).latest.state } : null }));
    });
    await step('H2821', async () => {
      const lens = 'mx-2821cce3c372';
      const own = mine.filter((one) => one.bucketId === `${prefix}-${lens}`);
      const every = all.filter((one) => one.bucketId.startsWith('goal-') && one.bucketId.endsWith(`-${lens}`));
      const asOne = [...every].sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id)).map((one, i) => ({ ...one, round: i + 1 }));
      const nf = (h: any[]) => nextGoalRoundFor(h, now) ?? priceReaskRound(h, now, 3);
      return { own: own.map((r) => ({ id: r.id, state: r.state, round: r.round, found: r.found, harvestedAt: r.harvestedAt })), every: every.length, nextOwn: nf(own), nextEvery: nf(asOne), plainNext: nextGoalRoundFor(own, now) };
    });
    for (const m of ['rms_cba833c0165241ee8423','rms_f9e1515cc9cb411aa8e8','rms_f84b517f58a2464aa61e']) {
      await q('FRAGS_'+m.slice(4,12), `SELECT f.status, COUNT(*) AS n, MIN(f.created_at) AS first, MAX(f.updated_at) AS last FROM russell_missions mm JOIN research_fragments f ON f.orchestration_id = mm.orchestration_id WHERE mm.id = ? GROUP BY f.status`, [m]);
    }
    await q('FL_QUEUE', `SELECT status, COUNT(*) AS n FROM research_fragments WHERE updated_at >= ? GROUP BY status`, [new Date(Date.now() - 6 * 3600e3).toISOString()]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
