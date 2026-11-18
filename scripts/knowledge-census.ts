/** Throwaway read-only probe (claude/ge-probe) pass 2: what feeds arr_9c291f2760f2. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';
const P = 'prj_22fb4fec295f403a8a22';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q(sql: string, args: unknown[] = []): Promise<any[]> {
  try { return await getDb().all(sql, args); } catch (e) { out('ERR', `${sql.slice(0, 80)} :: ${e instanceof Error ? e.message : e}`); return []; }
}
const slim = (m: any) => { if (!m) return m; const { distribution, ...rest } = m; return { ...rest, distN: distribution?.values?.length ?? null }; };
async function main() {
  await initDatabase();
  try {
    for (const c of await q(`SELECT id, created_at, accepted, validation_state, orchestration_id, fragment_id, claim, source_url, source_title FROM research_claims WHERE id IN ('clm_51df38793dfe46f6b16e','clm_a74616dc7c8b4de6b92b')`)) out('CLAIM', c);
    for (const p of await q(`SELECT id, legacy_key, created_at, updated_at, asked_count, evaluated_count, last_asked_at, research_verdict FROM monetization_paths WHERE project_id = ? AND legacy_key IN ('9c291f2760f2','4cbbf91e4df7','9b8b17b801cb','86da3f1661d1')`, [P])) out('PATH', p);
    for (const e of await q(`SELECT e.path_id, MIN(e.evaluated_at) AS first, MAX(e.evaluated_at) AS last, COUNT(*) AS n, SUM(e.picked) AS picked FROM monetization_path_evaluations e JOIN monetization_paths p ON p.id = e.path_id WHERE p.legacy_key IN ('9c291f2760f2','4cbbf91e4df7') AND e.goal_id = 'wst_7b4fcbb5f2384f31b6c3' GROUP BY e.path_id`)) out('EVALS', e);
    for (const f of await q(`SELECT id, fact_key, segment, low, high, status, source_claim_id, supersedes_fact_id, created_at, substr(measures,1,260) AS measures, source_url FROM construction_facts WHERE node_id IN ('ind_ba78f4a749b94d9bb9c0','ind_1d19cbca862144a6a1ef') OR segment IN ('map_ind_ba78f4a749b94d9bb9c0','map_ind_1d19cbca862144a6a1ef') ORDER BY created_at`)) out('NODE_FACT', f);
    for (const n of await q(`SELECT id, kind, name, created_at FROM industry_nodes WHERE id IN ('ind_ba78f4a749b94d9bb9c0','ind_1d19cbca862144a6a1ef','ind_d7e777c4879f4b9b921a')`)) out('NODE', n);
    const knowledge = await loadCashKnowledge(P);
    for (const key of ['9c291f2760f2', '4cbbf91e4df7']) {
      const rec: any = await arrangementForLegacyKey(P, key);
      const a = rec?.design?.arrangement;
      if (!a) { out('NOARR', key); continue; }
      const m: any = estimatedFromArrangement(a, { projectId: P, currency: 'USD', knowledge, now: new Date(), daysLeft: 21, beforeProofCents: null } as any);
      if (!m) { out('NULLMODEL', key); continue; }
      for (const k of ['price', 'daysToCash', 'directCost', 'capital', 'close', 'respond', 'volume', 'hours']) out(`INPUT_${key}_${k}`, slim(m[k]));
      out(`EST_${key}`, m.estimated);
    }
  } finally {
    await closeDatabase();
    console.log('PROBE: END');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
