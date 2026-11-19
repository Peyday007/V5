/**
 * Read-only probe (claude/probe-goal-authority): why a goal created on a
 * project with no sprint/grant cannot research. SELECT only; never merged.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const PROJECTS = ['prj_22fb4fec295f403a8a22', 'prj_630132c1875545548727', 'prj_c56705b8a3164d4190a0', 'prj_f1d8f9d6a9854c65939a'];
const GOALS = ['wst_deede4995a0c471c95ee', 'wst_fa4761773e4441b89e5a', 'wst_4f0c312400e1425dab2e'];

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

async function main(): Promise<void> {
  await initDatabase();
  try {
    const now = new Date().toISOString();
    const { knowledgeResearchAllowed, discoveryAllowed } = await import('../server/services/cash/lifecycle.ts');
    const { kernelAuthority } = await import('../server/services/industry/kernel.ts');
    for (const p of PROJECTS) {
      console.log(`=== ${p}`);
      await q('PROJECT', 'SELECT id, name, slug, created_at FROM projects WHERE id = ?', [p]);
      await q('CASH_MODE', 'SELECT id, state, owner_user_id, created_by_user_id, activated_at FROM cash_modes WHERE project_id = ?', [p]);
      await q('GRANTS', 'SELECT id, name, state, purpose, starts_at, expires_at, allowed_work, work_policy, max_concurrent, owner_user_id, created_at, revoked_at, revoked_reason FROM russell_goals WHERE project_id = ? ORDER BY created_at', [p]);
      await q('COMMERCIAL', "SELECT COUNT(*) AS n FROM russell_goals WHERE project_id = ? AND allowed_work LIKE '%COMMERCIAL%'", [p]);
      await q('CANDIDATES', 'SELECT state, COUNT(*) AS n FROM russell_candidates WHERE project_id = ? GROUP BY state', [p]);
      await q('PARK_REASONS', "SELECT substr(COALESCE(reason, ''), 1, 160) AS r, COUNT(*) AS n FROM russell_candidates WHERE project_id = ? AND state = 'PARKED' GROUP BY r ORDER BY n DESC LIMIT 5", [p]);
      await q('ROUNDS', 'SELECT state, COUNT(*) AS n FROM cash_discovery_rounds WHERE project_id = ? GROUP BY state', [p]);
      await q('NEEDS', 'SELECT state, COUNT(*) AS n FROM cash_needs WHERE project_id = ? GROUP BY state', [p]);
      try {
        const d = await discoveryAllowed(p);
        console.log(`DISCOVERY_ALLOWED ${JSON.stringify({ allowed: d.allowed, reason: d.reason })}`);
      } catch (e) {
        console.log(`DISCOVERY_ALLOWED ERROR ${msg(e)}`);
      }
      try {
        const k = await knowledgeResearchAllowed(p, now);
        console.log(`KNOWLEDGE_ALLOWED ${JSON.stringify({ allowed: k.allowed, basis: k.basis, reason: k.reason })}`);
      } catch (e) {
        console.log(`KNOWLEDGE_ALLOWED ERROR ${msg(e)}`);
      }
      try {
        const k = await kernelAuthority(p, { now });
        console.log(`KERNEL_AUTHORITY ${JSON.stringify({ allowed: k.allowed, basis: k.basis, reason: k.reason })}`);
      } catch (e) {
        console.log(`KERNEL_AUTHORITY ERROR ${msg(e)}`);
      }
    }
    for (const g of GOALS) {
      console.log(`=== ${g}`);
      await q('WORKSTREAM', 'SELECT id, project_id, title, owner_user_id, created_at, paused_at, archived_at FROM workstreams WHERE id = ?', [g]);
      await q('LINKS', 'SELECT kind, COUNT(*) AS n FROM workstream_links WHERE workstream_id = ? GROUP BY kind', [g]);
      await q('EVENTS', 'SELECT kind, COUNT(*) AS n FROM workstream_events WHERE workstream_id = ? GROUP BY kind ORDER BY n DESC LIMIT 20', [g]);
      await q('GOAL_ROUNDS', "SELECT project_id, state, COUNT(*) AS n FROM cash_discovery_rounds WHERE bucket_id LIKE ? GROUP BY project_id, state", [`goal-${g}%`]);
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
