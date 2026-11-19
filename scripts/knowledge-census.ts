/**
 * Read-only probe (claude/probe-price-research): why price-refused constructed
 * arrangements produce no research round. SELECT only; never merged.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const PAIRS: Array<[string, string]> = [
  ['wst_deede4995a0c471c95ee', 'prj_630132c1875545548727'],
  ['wst_fa4761773e4441b89e5a', 'prj_c56705b8a3164d4190a0'],
  ['wst_4f0c312400e1425dab2e', 'prj_f1d8f9d6a9854c65939a'],
];

function msg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 400);
}

async function q(label: string, sql: string, params: unknown[]): Promise<void> {
  try {
    const rows = await getDb().all(sql, params as string[]);
    console.log(`${label} ${JSON.stringify(rows)}`);
  } catch (e) {
    console.log(`${label} ERROR ${msg(e)}`);
  }
}

async function step(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    console.log(`${label} ${JSON.stringify(await fn())}`);
  } catch (e) {
    console.log(`${label} ERROR ${msg(e)}`);
  }
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const now = new Date().toISOString();
    const { knowledgeResearchAllowed } = await import('../server/services/cash/lifecycle.ts');
    const disc = await import('../server/services/cash/discovery.ts');
    const room = await import('../server/services/cash/researchRoom.ts');
    const { listRounds } = await import('../server/repos/cashDiscovery.ts');
    const { missionsForRounds } = await import('../server/services/russell/roundMissions.ts');
    for (const [g, p] of PAIRS) {
      console.log(`=== ${g} ${p}`);
      await step('KNOWLEDGE', async () => {
        const k = await knowledgeResearchAllowed(p, now);
        return { allowed: k.allowed, basis: k.basis, reason: k.reason };
      });
      await step('FOCUS_CAP', () => room.constructedCapFor(p));
      await step('SPARE', () => room.cashSpareSurfaces(p));
      await step('ROUNDS', async () => {
        const all = await listRounds(p);
        const prefix = `goal-${g}`;
        const mine = all.filter((r) => r.bucketId === prefix || r.bucketId.startsWith(`${prefix}-`));
        const mx = mine.filter((r) => r.bucketId.startsWith(`${prefix}-mx-`));
        const missions = await missionsForRounds(mine.slice(0, 60).map((r) => r.candidateId));
        return {
          total: all.length,
          mine: mine.length,
          mx: mx.length,
          mineResearching: await disc.roundsStillResearching(mine),
          mxResearching: await disc.roundsStillResearching(mx),
          mxLive: await disc.liveConstructedResearch(mx),
          mxStale: await disc.staleUnlaunchedRounds(mx, now),
          mineStale: await disc.staleUnlaunchedRounds(mine, now),
          share: disc.constructedShare(disc.MAX_LIVE_GOAL_ROUNDS),
          latest: mine.slice(0, 25).map((r) => ({
            b: r.bucketId.slice(prefix.length),
            r: r.round,
            s: r.state,
            o: r.openedAt,
            h: r.harvestedAt,
            c: r.candidateId,
            m: missions.get(r.candidateId)?.latest?.state ?? null,
          })),
        };
      });
      await q('CANDS', "SELECT c.id, c.state, c.created_at, substr(c.title,1,80) AS t, substr(COALESCE(c.reason,''),1,160) AS why FROM russell_candidates c WHERE c.project_id = ? AND c.created_at > '2026-11-19T00:00' ORDER BY c.created_at DESC LIMIT 15", [p]);
      await q('EVENTS', "SELECT kind, created_at, substr(summary,1,300) AS s FROM workstream_events WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 25", [g]);
      await q('READINGS', "SELECT created_at, verdict, substr(next_test,1,300) AS nt FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 3", [g]);
      await q('LIB', "SELECT COUNT(*) AS n, SUM(CASE WHEN last_asked_at IS NOT NULL THEN 1 ELSE 0 END) AS asked, MAX(last_asked_at) AS last FROM monetization_paths WHERE project_id = ? AND design_signature IS NOT NULL", [p]);
    }
  } finally {
    await closeDatabase();
  }
  console.log('GOALS: OK');
}

main().catch((error) => {
  console.log(`PROBE FAILED ${msg(error)}`);
  console.log('GOALS: OK');
});
