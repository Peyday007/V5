/** Throwaway read-only probe (claude/gate-probe): does arrangement 2821cce3c372 read the 4675 run cost? Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { getWorkstream } from '../server/repos/register.ts';
import { readTarget } from '../server/services/goals/target.ts';
import { executionFrame } from '../server/services/cash/discovery.ts';
import { goalExclusions } from '../server/services/cash/exclusions.ts';
import { constructArrangements, constructionObservations } from '../server/services/cash/construct.ts';
import { loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const KEY = '2821cce3c372';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(sql: string, args: unknown[] = []): Promise<any[]> {
  try { return await getDb().all(sql, args); } catch (e) { out('ERR', `${sql.slice(0, 80)} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const slim = (m: any) => { if (!m) return m; const { distribution, ...rest } = m; return { ...rest, distN: distribution?.values?.length ?? null }; };
const arrView = (a: any) => a ? { key: a.key, label: a.label, design: a.design, structure: a.structure, fixedCost: a.fixedCost ?? null, value: a.value ? { ...a.value, evidence: undefined } : null, stress: a.stress, evidenced: a.evidenced, unknownParts: a.unknownParts, targetsMet: a.targetsMet, inputsDigest: a.inputsDigest } : null;
function around(text: string | null, needle: string, n = 3, w = 700): string[] {
  if (!text) return [];
  const res: string[] = []; let i = text.indexOf(needle);
  while (i >= 0 && res.length < n) { res.push(text.slice(Math.max(0, i - 200), i + w)); i = text.indexOf(needle, i + 1); }
  return res;
}
async function model(a: any, P: string, daysLeft: number, tag: string) {
  try {
    const knowledge = await loadCashKnowledge(P);
    const m: any = estimatedFromArrangement(a, { projectId: P, currency: 'USD', knowledge, now: new Date(), daysLeft, beforeProofCents: null } as any);
    if (!m) { out(`${tag}_NULLMODEL`, KEY); return; }
    for (const k of ['price', 'directCost', 'capital', 'volume']) out(`${tag}_INPUT_${k}`, slim(m[k]));
    out(`${tag}_EST`, m.estimated);
  } catch (e) { out(`${tag}_MODEL_ERR`, e instanceof Error ? e.message : String(e)); }
}
async function main() {
  await initDatabase();
  try {
    out('NOW', new Date().toISOString());
    for (const f of await q(`SELECT id, fact_key, segment, low, high, status, source_claim_id, supersedes_fact_id, created_at FROM construction_facts WHERE supersedes_fact_id LIKE 'cfa_d740c475%' OR supersedes_fact_id LIKE 'cfa_8cc776d4%' OR id LIKE 'cfa_d740c475%' OR id LIKE 'cfa_8cc776d4%' ORDER BY created_at`)) out('FACT', f);
    for (const f of await q(`SELECT id, fact_key, segment, low, high, status, source_claim_id, supersedes_fact_id, created_at FROM construction_facts WHERE fact_key = 'fixed_cost_per_run' ORDER BY created_at`)) out('RUNCOST_FACT', f);
    for (const c of await q(`SELECT id, accepted, validation_state, substr(claim,1,300) AS claim FROM research_claims WHERE id LIKE 'clm_9cf1f15c%'`)) out('CLAIM', c);
    const goal = await getWorkstream(G);
    const P = (goal as any)?.target?.projectId ?? 'prj_22fb4fec295f403a8a22';
    out('GOAL', { id: G, project: P, state: (goal as any)?.state, status: (goal as any)?.status });
    for (const r of await q(`SELECT id, verdict, chosen_strategy, created_at, length(strategies) AS sl, length(forecast) AS fl FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 5`, [G])) out('READING', r);
    for (const p of await q(`SELECT id, legacy_key, created_at, updated_at, asked_count, evaluated_count, last_asked_at, research_verdict FROM monetization_paths WHERE id = 'mpx_a8f5f34d435f48af9a57' OR legacy_key = ?`, [KEY])) out('PATH', p);
    for (const e of await q(`SELECT e.goal_id, MIN(e.evaluated_at) AS first, MAX(e.evaluated_at) AS last, COUNT(*) AS n, SUM(e.picked) AS picked FROM monetization_path_evaluations e WHERE e.path_id = 'mpx_a8f5f34d435f48af9a57' GROUP BY e.goal_id`)) out('EVALS', e);
    for (const e of await q(`SELECT MAX(e.evaluated_at) AS last, COUNT(*) AS n FROM monetization_path_evaluations e WHERE e.goal_id = ? AND e.evaluated_at >= '2026-11-18T09:34:51Z'`, [G])) out('GOAL_EVALS_SINCE_DEPLOY', e);
    const latest = (await q(`SELECT * FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [G]))[0];
    if (latest) {
      out('LATEST_READING', { id: latest.id, created_at: latest.created_at, verdict: latest.verdict });
      for (const col of ['strategies', 'forecast', 'next_test']) for (const s of around(latest[col], KEY)) out(`LATEST_${col}_HIT`, s);
      out('LATEST_HAS', { strategies: (latest.strategies ?? '').includes(KEY), forecast: (latest.forecast ?? '').includes(KEY), clm9cf: ((latest.forecast ?? '') + (latest.strategies ?? '')).includes('clm_9cf1f15c'), has4675: ((latest.forecast ?? '') + (latest.strategies ?? '')).includes('4675') });
    }
    const rec: any = await arrangementForLegacyKey(P, KEY);
    out('LIB', rec ? { id: rec.id, updatedAt: rec.updatedAt, arr: arrView(rec.design?.arrangement) } : null);
    const target: any = goal ? await readTarget(goal) : null;
    const daysLeft = target?.daysLeft ?? 21;
    out('TARGET', target ? { daysLeft: target.daysLeft, remainingCents: target.remainingCents, currency: target.currency, cap: target.capitalCeilingCents } : null);
    if (rec?.design?.arrangement) await model(rec.design.arrangement, P, daysLeft, 'LIB');
    const obs = await constructionObservations({ projectId: P, currency: target?.currency ?? 'USD', daysLeft });
    out('OBS_COUNTS', Object.fromEntries(Object.entries(obs).map(([k, v]) => [k, (v as any[]).length])));
    for (const o of obs.runCost) out('OBS_RUNCOST', o);
    const t0 = Date.now();
    const frame = await executionFrame(P, target?.currency ?? 'USD');
    const arrangements = await constructArrangements({
      projectId: P, currency: target?.currency ?? 'USD', delivers: frame?.delivers ?? [], capitalCeilingCents: target?.capitalCeilingCents ?? null, daysLeft,
      limits: { daysLeft, remainingCents: target?.remainingCents ?? 1, capitalCeilingCents: target?.capitalCeilingCents ?? null, capitalBeforeProofCents: target?.capitalBeforeProofCents ?? null, bestReachCents: null },
      exclusions: goal ? await goalExclusions(goal as any) : [], now: new Date(),
    });
    out('COMPOSED', { n: arrangements.length, ms: Date.now() - t0, withFixedCost: arrangements.filter((a) => a.fixedCost).map((a) => a.key) });
    const a: any = arrangements.find((one) => one.key === KEY);
    if (!a) out('NOT_COMPOSED', KEY); else { out('ARR', arrView(a)); await model(a, P, daysLeft, 'LIVE'); }
  } finally {
    await closeDatabase();
    console.log('PROBE: END');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
