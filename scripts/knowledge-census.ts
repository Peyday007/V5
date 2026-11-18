/** Throwaway read-only probe (claude/ge-probe): goal wst_7b4fcbb5f2384f31b6c3 trace claims, arr_9c291f2760f2 inputs, #1091 supersession. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
const G = 'wst_7b4fcbb5f2384f31b6c3';
const SINCE = '2026-11-17T19:30:00Z';
const out = (tag: string, v: unknown) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));
async function q<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  try { return await getDb().all<T>(sql, args); } catch (e) { out('ERR', `${sql.slice(0, 80)} :: ${e instanceof Error ? e.message : e}`); return []; }
}
async function main() {
  await initDatabase();
  try {
    const db = getDb();
    const [ws] = await q<{ project_id: string }>('SELECT project_id FROM workstreams WHERE id = ?', [G]);
    const P = ws!.project_id;
    out('PROJECT', P);
    const rounds = await q<{ id: string; bucket_id: string; round: number; state: string; orchestration_id: string }>(
      `SELECT r.id, r.bucket_id, r.round, r.state, m.orchestration_id FROM cash_discovery_rounds r JOIN russell_missions m ON m.candidate_id = r.candidate_id
        WHERE r.project_id = ? AND r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL ORDER BY r.opened_at DESC LIMIT 400`, [P, `goal-${G}%`]);
    const roundOf = new Map(rounds.map((r) => [r.orchestration_id, r]));
    const orch = [...roundOf.keys()];
    const m = (n: number) => Array.from({ length: n }, () => '?').join(',');
    const claims: any[] = [];
    for (let i = 0; i < orch.length; i += 200) {
      const c = orch.slice(i, i + 200);
      claims.push(...(await q(`SELECT id, orchestration_id, fragment_id, claim, created_at, source_url, source_title, validation_state, primary_source FROM research_claims WHERE accepted = 1 AND created_at >= ? AND orchestration_id IN (${m(c.length)}) ORDER BY created_at DESC LIMIT 200`, [SINCE, ...c])));
    }
    claims.sort((a, b) => b.created_at.localeCompare(a.created_at));
    out('CLAIMS_N', claims.length);
    const ids = claims.map((c) => c.id);
    const frags = [...new Set(claims.map((c) => c.fragment_id).filter(Boolean))];
    if (!ids.length) return;
    const openings = await q<any>(`SELECT id, title, payer, price_cents, mechanism, source_claim_id, fragment_id, created_at FROM cash_opportunities WHERE project_id = ? AND duplicate_of_id IS NULL AND (source_claim_id IN (${m(ids.length)})${frags.length ? ` OR fragment_id IN (${m(frags.length)})` : ''})`, [P, ...ids, ...frags]);
    const cards = await q<any>(`SELECT id, claim_id, opportunity_id, field, kind, value, created_at FROM cash_card_facts WHERE project_id = ? AND claim_id IN (${m(ids.length)})`, [P, ...ids]);
    const cons = await q<any>(`SELECT * FROM construction_facts WHERE source_claim_id IN (${m(ids.length)})`, ids);
    for (const c of claims) {
      const op = openings.filter((o) => o.source_claim_id === c.id || (c.fragment_id && o.fragment_id === c.fragment_id));
      const cf = cards.filter((f) => f.claim_id === c.id);
      const cs = cons.filter((f) => f.source_claim_id === c.id);
      const stored = op.length + cf.length + cs.length > 0;
      const r = roundOf.get(c.orchestration_id);
      out(stored ? 'STORED' : 'claim', { id: c.id, at: c.created_at, round: r ? `${r.bucket_id} r${r.round}` : null, frag: c.fragment_id, text: stored ? c.claim : String(c.claim).slice(0, 90) });
      if (stored) {
        out('  SRC', { url: c.source_url, title: c.source_title, v: c.validation_state, primary: c.primary_source });
        for (const o of op) out('  OPENING', { ...o, via: o.source_claim_id === c.id ? 'claim' : 'fragment' });
        for (const f of cf) out('  CARD', f);
        for (const f of cs) out('  CFACT', f);
        if (c.fragment_id) { const [fr] = await q<any>('SELECT question FROM research_fragments WHERE id = ?', [c.fragment_id]); out('  Q', String(fr?.question ?? '').slice(0, 300)); }
      }
    }
    // Arrangements in the candidate.
    for (const key of ['9c291f2760f2', '4cbbf91e4df7', '9b8b17b801cb']) {
      const a: any = await arrangementForLegacyKey(P, key);
      out(`ARR_${key}`, a ? JSON.stringify(a).slice(0, 6000) : null);
      if (a?.pathId) for (const f of await q<any>('SELECT attribute, kind, value, amount_cents, days, claim_id, created_at FROM monetization_path_facts WHERE path_id = ?', [a.pathId])) out(`  PFACT_${key}`, f);
    }
    // Plan readings: when the candidate changed, and the model entry for arr_9c291f2760f2.
    const readings = await q<any>('SELECT id, created_at, scenario_model_id, scenario_run_id, forecast FROM goal_plan_readings WHERE workstream_id = ? AND created_at >= ? ORDER BY created_at', ['wst_7b4fcbb5f2384f31b6c3', '2026-11-17T12:00:00Z']);
    let lastModel: string | null = null;
    for (const r of readings) {
      let cand: any = null;
      try { cand = JSON.parse(r.forecast ?? 'null')?.acceptance?.candidate; } catch { /* */ }
      out('READING', { id: r.id, at: r.created_at, model: r.scenario_model_id, ids: cand?.opportunityIds, reach: cand?.reach, p50: cand?.settledP50 });
      if (r.scenario_model_id) lastModel = r.scenario_model_id;
    }
    const firstWith = readings.find((r) => String(r.forecast ?? '').includes('arr_9c291f2760f2'));
    out('FIRST_READING_WITH_9c29', firstWith ? { id: firstWith.id, at: firstWith.created_at, model: firstWith.scenario_model_id } : null);
    for (const mid of [...new Set([firstWith?.scenario_model_id, lastModel].filter(Boolean))]) {
      const [sm] = await q<any>('SELECT id, created_at, definition_json FROM scenario_models WHERE id = ?', [mid]);
      if (!sm) continue;
      const d: string = sm.definition_json;
      out('MODEL', { id: sm.id, at: sm.created_at, len: d.length });
      let i = d.indexOf('9c291f2760f2'); let n = 0;
      while (i >= 0 && n < 40) { out('  MSNIP', d.slice(Math.max(0, i - 200), i + 900)); i = d.indexOf('9c291f2760f2', i + 900); n++; }
    }
    // Construction facts that could feed it: recent ones on this project/goal.
    for (const f of await q<any>(`SELECT id, fact_key, segment, low, high, status, source_claim_id, supersedes_fact_id, node_id, created_at, substr(measures,1,220) AS measures, source_url FROM construction_facts WHERE (project_id = ? OR workstream_id = ?) AND created_at >= ? ORDER BY created_at`, [P, G, '2026-11-17T19:30:00Z'])) out('RECENT_CFACT', f);
    // #1091 supersession.
    for (const f of await q<any>(`SELECT id, fact_key, segment, low, high, status, source_claim_id, supersedes_fact_id, created_at, substr(measures,1,200) AS measures FROM construction_facts WHERE supersedes_fact_id IS NOT NULL ORDER BY created_at`)) out('SUPERSEDER', f);
    for (const f of await q<any>(`SELECT id, fact_key, segment, low, high, status, source_claim_id, created_at, substr(measures,1,200) AS measures, source_url FROM construction_facts WHERE id LIKE 'cfa_b20e6370%' OR (fact_key = 'price_per_unit' AND (low IN (259, 0.26) OR measures LIKE '%ostcard%' OR measures LIKE '%USPS%'))`)) out('POSTCARD', f);
    for (const e of await q<any>(`SELECT id, created_at, summary, detail FROM cash_events WHERE kind = 'INDUSTRY_FACT_ABSORBED' AND created_at >= ? AND detail LIKE '%supersedes%' ORDER BY created_at`, ['2026-11-18T07:00:00Z'])) out('SUPERSEDE_EVENT', e);
    const [cnt] = await q<any>(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM cash_events WHERE kind = 'INDUSTRY_FACT_ABSORBED' AND created_at >= ?`, ['2026-11-18T07:58:00Z']);
    out('ABSORBED_SINCE_0758', cnt);
    void db;
  } finally {
    await closeDatabase();
    console.log('PROBE: END');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
