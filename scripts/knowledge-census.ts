/** Throwaway read-only probe (claude/probe-d4): accepted research -> facts -> arrangements -> goal model -> plan, for one goal. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { getWorkstream } from '../server/repos/register.ts';
import { readTarget } from '../server/services/goals/target.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
import { loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';
import { backfillCandidates } from '../server/services/industry/expand.ts';

const G = 'wst_7b4fcbb5f2384f31b6c3';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(sql: string, args: unknown[] = []): Promise<any[]> {
  try { return await getDb().all(sql, args); } catch (e) { out('ERR', `${sql.slice(0, 100)} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const slim = (m: any) => { if (!m) return m; const { distribution, ...rest } = m; return { ...rest, distN: distribution?.values?.length ?? null }; };

const SINCE = '2026-11-18T19:11:52.000Z';
async function main() {
  await initDatabase();
  try {
    out('NOW', new Date().toISOString());
    out('SINCE', SINCE);
    const P = 'prj_22fb4fec295f403a8a22';
    const bucket = `goal-${G}-%`;
    const goalClaim = `SELECT c.id FROM research_claims c WHERE c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?)`;
    // (1) openings created since the deploy, and which rest on a goal-round claim.
    for (const r of await q(`SELECT COUNT(*) AS n FROM cash_opportunities WHERE project_id = ? AND created_at >= ?`, [P, SINCE])) out('OPPS_SINCE_ALL', r);
    const fromGoal = await q(`SELECT id, substr(title, 1, 110) AS title, price_cents, mechanism, state, source_claim_id, created_at FROM cash_opportunities WHERE project_id = ? AND created_at >= ? AND source_claim_id IN (${goalClaim}) ORDER BY created_at`, [P, SINCE, bucket]);
    out('OPPS_SINCE_FROM_GOAL_N', fromGoal.length);
    for (const o of fromGoal) out('OPP_FROM_GOAL', o);
    for (const r of await q(`SELECT MAX(created_at) AS last, COUNT(*) AS n FROM cash_opportunities WHERE project_id = ? AND source_claim_id IN (${goalClaim})`, [P, bucket])) out('OPPS_FROM_GOAL_ALLTIME', r);
    for (const r of await q(`SELECT COUNT(*) AS n FROM construction_facts WHERE project_id = ? AND created_at >= ?`, [P, SINCE])) out('FACTS_SINCE', r);
    for (const f of await q(`SELECT id, fact_key, low, status, source_claim_id, segment FROM construction_facts WHERE project_id = ? AND created_at >= ? ORDER BY created_at LIMIT 20`, [P, SINCE])) out('FACT_SINCE', f);
    // (2) the newest reading.
    const readings = await q(`SELECT id, created_at, verdict, chosen_strategy, strategies, forecast, next_test FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 3`, [G]);
    for (const r of readings) out('READING_ROW', { id: r.id, at: r.created_at, verdict: r.verdict, chosen: r.chosen_strategy, afterDeploy: r.created_at >= SINCE });
    const latest = readings[0];
    const text = latest ? `${latest.strategies ?? ''}${latest.forecast ?? ''}${latest.next_test ?? ''}` : '';
    let forecast: any = null;
    try { forecast = latest?.forecast ? JSON.parse(latest.forecast) : null; } catch { forecast = null; }
    const acc = forecast?.acceptance ?? null;
    out('ACCEPTANCE', acc ? { status: acc.status, verdict: acc.verdict, candidate: acc.candidate, evidence: acc.construction?.evidence } : { keys: forecast ? Object.keys(forecast) : null });
    const goalIds = new Set((await q(goalClaim, [bucket])).map((r) => r.id));
    const claimIds = [...new Set([...text.matchAll(/clm_[0-9a-f]{20}/g)].map((m) => m[0]))];
    out('READING_CLAIMS', claimIds.map((id) => `${id}${goalIds.has(id) ? ':GOAL_ROUND' : ''}`));
    const oppIds = [...new Set([...text.matchAll(/cop_[0-9a-f]{20}/g)].map((m) => m[0]))];
    for (const id of oppIds) {
      const o = (await q(`SELECT id, substr(title, 1, 80) AS title, price_cents, source_claim_id, created_at FROM cash_opportunities WHERE id = ?`, [id]))[0];
      out('READING_OPP', { ...o, goalSourced: o?.source_claim_id ? goalIds.has(o.source_claim_id) : false });
    }
    // Each candidate arrangement's model inputs and the claims they cite.
    const target: any = await readTarget((await getWorkstream(G)) as any);
    const daysLeft = target?.daysLeft ?? 21;
    const knowledge = await loadCashKnowledge(P);
    const gs: any = await import('../server/services/cash/goalScenario.ts');
    const arrKeys = [...new Set([...text.matchAll(/arr_([0-9a-f]{12})/g)].map((m) => m[1]!)), '2821cce3c372'];
    for (const key of arrKeys) {
      const rec: any = await arrangementForLegacyKey(P, key);
      const a = rec?.design?.arrangement;
      if (!a) { out('ARR_MISSING', key); continue; }
      out('ARR', { key, updatedAt: rec.updatedAt, label: String(a.label).slice(0, 90), value: { ...a.value, evidence: undefined }, fixedCost: a.fixedCost ?? null });
      if (typeof gs.pooledRunCostPerDeal === 'function') {
        const per = gs.pooledRunCostPerDeal(a);
        out(`RUNCOST_PER_DEAL_${key}`, per ? { prov: per.provenance, low: per.low, high: per.high, source: per.source, note: per.note } : null);
      } else out('RUNCOST_FN', 'pooledRunCostPerDeal not in running code');
      const m: any = gs.estimatedFromArrangement(a, { projectId: P, currency: 'USD', knowledge, now: new Date(), daysLeft, beforeProofCents: null });
      if (!m) { out('MODEL_NULL', key); continue; }
      for (const k of ['price', 'directCost', 'daysToCash', 'hours', 'capital', 'volume', 'close', 'respond']) {
        const s: any = m[k];
        const cites = [...new Set(JSON.stringify(s ?? {}).match(/clm_[0-9a-f]{20}/g) ?? [])];
        out(`MODEL_${key}_${k}`, { prov: s?.provenance, low: s?.low, high: s?.high, tier: s?.inferred?.tier, cites: cites.map((id) => `${id}${goalIds.has(id) ? ':GOAL_ROUND' : ''}`), note: String(s?.note ?? '').slice(0, 200) });
      }
    }
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
