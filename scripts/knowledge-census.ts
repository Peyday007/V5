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

async function main() {
  await initDatabase();
  try {
    out('NOW', new Date().toISOString());
    const P = 'prj_22fb4fec295f403a8a22';
    const bucket = `goal-${G}-%`;
    const { readMoneyFigures } = await import('../server/services/cash/figures.ts');
    const { arrangementKeyOfBucket } = await import('../server/services/cash/arrangementLibrary.ts');
    // Every accepted constructed-round claim not yet filed, with its bucket, read through the filer's own reasons.
    let cursor = '';
    const byReason = new Map<string, { n: number; money: number; perUnit: number; buckets: Map<string, number>; moneySamples: string[] }>();
    const unmatched = new Map<string, number>();
    const all: { claimId: string; reason: string }[] = [];
    for (let i = 0; i < 25; i++) {
      const pool = await backfillCandidates(P, { unitEconomic: 'zzzz', constructed: cursor });
      const mine = pool.decisions.filter((d) => d.source === 'CONSTRUCTED_ROUND');
      if (mine.length === 0) break;
      for (const d of mine) all.push({ claimId: d.claimId ?? '', reason: d.candidate ? 'FILE' : (d.reason ?? '').slice(0, 60) });
      for (const d of mine) if (d.unmatchedBuyer) unmatched.set(d.unmatchedBuyer.slice(0, 80), (unmatched.get(d.unmatchedBuyer.slice(0, 80)) ?? 0) + 1);
      cursor = mine[mine.length - 1]!.claimId ?? cursor;
    }
    const ids = all.map((a) => a.claimId).filter(Boolean);
    const rows = new Map<string, any>();
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      for (const r of await q(`SELECT c.id, c.claim, (SELECT MIN(r.bucket_id) FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE m.orchestration_id = c.orchestration_id AND r.bucket_id LIKE 'goal-%-mx-%') AS b FROM research_claims c WHERE c.id IN (${chunk.map(() => '?').join(',')})`, chunk)) rows.set(r.id, r);
    }
    for (const a of all) {
      const r = rows.get(a.claimId);
      const money = r ? readMoneyFigures(String(r.claim), 'USD').filter((f: any) => f.cents > 0) : [];
      const e = byReason.get(a.reason) ?? { n: 0, money: 0, perUnit: 0, buckets: new Map(), moneySamples: [] };
      e.n++;
      if (money.length) e.money++;
      if (money.some((f: any) => f.perUnit)) { e.perUnit++; if (e.moneySamples.length < 8) e.moneySamples.push(`${a.claimId}: ${String(r.claim).slice(0, 200)}`); }
      const b = String(r?.b ?? '').replace(/^goal-[^-]+-/, '').replace(/^wst_[0-9a-f]+-/, '');
      e.buckets.set(b, (e.buckets.get(b) ?? 0) + 1);
      byReason.set(a.reason, e);
    }
    for (const [k, e] of byReason) out('REASON', { k, n: e.n, statesUsd: e.money, statesPerUnitUsd: e.perUnit, buckets: [...e.buckets].sort((x, y) => y[1] - x[1]).slice(0, 12) });
    for (const [k, e] of byReason) for (const s of e.moneySamples) out('PERUNIT_SAMPLE', `${k.slice(0, 30)} | ${s}`);
    out('UNMATCHED', [...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 15));
    // Is each not-in-library key anywhere in monetization_paths (any project, any signature)?
    const keys = new Set<string>();
    for (const r of rows.values()) { const k = r.b ? arrangementKeyOfBucket(String(r.b)) : null; if (k) keys.add(k); }
    for (const k of keys) {
      const lib = await q(`SELECT project_id, origin, construction_origin, design_signature IS NOT NULL AS sig, updated_at FROM monetization_paths WHERE legacy_key = ? LIMIT 3`, [k]);
      const rounds = await q(`SELECT MIN(opened_at) AS first, COUNT(*) AS n FROM cash_discovery_rounds WHERE bucket_id LIKE ?`, [`%-mx-${k}`]);
      out('KEY', { k, lib, rounds: rounds[0] });
    }
    // Openings the latest reading names, and whether their source claim is one of the goal's rounds' claims.
    const latest = (await q(`SELECT strategies, forecast FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [G]))[0];
    const text = `${latest?.strategies ?? ''}${latest?.forecast ?? ''}`;
    const oppIds = [...new Set([...text.matchAll(/\b(cop_[0-9a-f]{8,}|opp_[0-9a-f]{8,})/g)].map((m) => m[1]!))].slice(0, 40);
    out('READING_OPP_IDS', oppIds.length);
    for (const id of oppIds) {
      const o = (await q(`SELECT id, substr(title, 1, 90) AS title, price_cents, source_claim_id, created_at FROM cash_opportunities WHERE id = ?`, [id]))[0];
      const inGoal = o?.source_claim_id ? (await q(`SELECT 1 AS x FROM research_claims c WHERE c.id = ? AND c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?)`, [o.source_claim_id, bucket])).length > 0 : false;
      out('READING_OPP', { ...o, claimFromGoalRounds: inGoal });
    }
    // Openings created from this goal's rounds' claims at all.
    for (const r of await q(`SELECT COUNT(*) AS n, MAX(o.created_at) AS last FROM cash_opportunities o WHERE o.project_id = ? AND o.source_claim_id IN (SELECT c.id FROM research_claims c WHERE c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?))`, [P, bucket])) out('OPPS_FROM_GOAL_CLAIMS', r);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
