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
    await q('R2821', `SELECT r.id, r.state, r.round, r.found, r.opened_at, r.harvested_at, c.state AS cand, c.statement AS question FROM cash_discovery_rounds r LEFT JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.project_id = ? AND r.bucket_id LIKE '%-mx-2821cce3c372' ORDER BY r.created_at`, [P]);
    await q('PLAN_LAST', `SELECT id, verdict, created_at FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 3`, [G]);
    await q('PLAN_EVT', `SELECT kind, created_at, substr(summary,1,400) AS s FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_PLAN_READ' ORDER BY created_at DESC LIMIT 2`, [G]);
    await q('FRAG_Q', `SELECT f.id, f.status, f.created_at, f.updated_at, f.lease_owner, f.attempt_count FROM russell_missions mm JOIN research_fragments f ON f.orchestration_id = mm.orchestration_id WHERE mm.id = 'rms_f9e1515cc9cb411aa8e8'`);
    await q('NEWROUND', `SELECT r.id, r.bucket_id, r.state, r.round, r.opened_at, c.id AS cand_id, c.state AS cand, substr(c.statement,1,1600) AS question FROM cash_discovery_rounds r LEFT JOIN russell_candidates c ON c.id = r.candidate_id WHERE r.id IN ('cdr_df62f598e6044e029644','cdr_5074b6364ca641a6b2bc')`);
    await q('HIST_1ccd', `SELECT id, round, state, found, opened_at, harvested_at FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id LIKE '%-mx-1ccdb59e0206' ORDER BY created_at`, [P]);
    await q('LAUNCH_EVT', `SELECT kind, created_at, substr(summary,1,300) AS s FROM cash_events WHERE project_id = ? AND created_at >= ? AND (summary LIKE '%cdr_df62%' OR summary LIKE '%1ccdb59e0206%' OR summary LIKE '%cdr_5074%') ORDER BY created_at DESC LIMIT 10`, [P, '2026-11-19T04:00:00.000Z']);
    await q('MISSIONS_OPEN', `SELECT state, COUNT(*) AS n FROM russell_missions WHERE state NOT IN ('DONE','FAILED','CANCELLED') GROUP BY state`);
    await q('GRANT', `SELECT id, state, max_concurrent, updated_at FROM russell_goals WHERE project_id = ? ORDER BY updated_at DESC LIMIT 3`, [P]);
    await q('HELD', `SELECT r.kind, COUNT(*) AS n, SUM(r.amount) AS amt FROM russell_budget_reservations r JOIN russell_goals g ON g.id = r.goal_id WHERE g.project_id = ? AND r.state = 'HELD' AND r.expires_at > ? GROUP BY r.kind`, [P, new Date().toISOString()]);
    await q('HELD_MISSIONS', `SELECT r.idempotency_key AS k, r.created_at, r.expires_at FROM russell_budget_reservations r JOIN russell_goals g ON g.id = r.goal_id WHERE g.project_id = ? AND r.state = 'HELD' AND r.kind = 'MISSION' AND r.expires_at > ? ORDER BY r.created_at LIMIT 30`, [P, new Date().toISOString()]);
    await q('RUN_MISSIONS_DONE', `SELECT m.id, m.created_at, (SELECT COUNT(*) FROM research_fragments f WHERE f.orchestration_id = m.orchestration_id) AS frags, (SELECT COUNT(*) FROM research_fragments f WHERE f.orchestration_id = m.orchestration_id AND f.status NOT IN ('ACCEPTED','BLOCKED','REJECTED','CANCELLED','NEEDS_HUMAN')) AS live, (SELECT o.status FROM research_orchestrations o WHERE o.id = m.orchestration_id) AS packet FROM russell_missions m JOIN russell_candidates c ON c.id = m.candidate_id WHERE c.project_id = ? AND m.state = 'RUNNING' ORDER BY m.created_at`, [P]);
    try { const { launchableInProject } = await import('../server/services/russell/loop.ts'); out('LAUNCHABLE', await launchableInProject(P)); } catch (e) { out('ERR', 'launchable ' + String(e)); }
    await q('HELD_STATE', `SELECT c.id AS cand, m.id AS mission, m.state AS mstate, (SELECT COUNT(*) FROM research_fragments f WHERE f.orchestration_id = m.orchestration_id) AS frags, (SELECT COUNT(*) FROM research_fragments f WHERE f.orchestration_id = m.orchestration_id AND f.status NOT IN ('ACCEPTED','BLOCKED','REJECTED','CANCELLED','NEEDS_HUMAN')) AS live_frags, (SELECT COUNT(*) FROM work_items w WHERE w.orchestration_id = m.orchestration_id AND w.state IN ('QUEUED','LEASED')) AS open_work FROM russell_budget_reservations r JOIN russell_candidates c ON r.idempotency_key = 'russell:mission:' || c.id || ':' || r.goal_id LEFT JOIN russell_missions m ON m.candidate_id = c.id AND m.state NOT IN ('DONE','FAILED','CANCELLED') WHERE r.state = 'HELD' AND r.kind = 'MISSION' AND r.goal_id = 'rgl_2b3bcf1aa24f443382cf'`);
    await q('FL_QUEUE', `SELECT status, COUNT(*) AS n FROM research_fragments WHERE updated_at >= ? GROUP BY status`, [new Date(Date.now() - 6 * 3600e3).toISOString()]);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
