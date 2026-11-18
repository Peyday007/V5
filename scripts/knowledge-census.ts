/** Throwaway read-only probe (claude/probe-d4): accepted research -> facts -> arrangements -> goal model -> plan, for one goal. Not for merge. */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { arrangementForLegacyKey } from '../server/repos/monetization.ts';
import { getWorkstream } from '../server/repos/register.ts';
import { readTarget } from '../server/services/goals/target.ts';
import { constructionObservations } from '../server/services/cash/construct.ts';
import { loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';

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
    const goal: any = await getWorkstream(G);
    const target: any = goal ? await readTarget(goal) : null;
    const P: string = target?.projectId ?? goal?.target?.projectId ?? 'prj_22fb4fec295f403a8a22';
    const daysLeft = target?.daysLeft ?? 21;
    out('GOAL', { P, daysLeft, remaining: target?.remainingCents, cap: target?.capitalCeilingCents, before: target?.capitalBeforeProofCents });

    // 1. Accepted claims tied to this goal's rounds (bucket goal-G-%) through missions -> orchestrations.
    const goalOrch = `SELECT DISTINCT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ? AND m.orchestration_id IS NOT NULL`;
    const bucket = `goal-${G}-%`;
    for (const r of await q(`SELECT COUNT(*) AS n, SUM(CASE WHEN c.accepted = 1 THEN 1 ELSE 0 END) AS acc FROM research_claims c WHERE c.orchestration_id IN (${goalOrch})`, [bucket])) out('GOAL_CLAIMS_TOTAL', r);
    const claims = await q(
      `SELECT c.id, c.orchestration_id, c.fragment_id, c.created_at, c.validation_state, c.evidence_lane, substr(c.claim, 1, 220) AS claim FROM research_claims c WHERE c.accepted = 1 AND c.orchestration_id IN (${goalOrch}) ORDER BY c.created_at`,
      [bucket],
    );
    out('GOAL_ACCEPTED_N', claims.length);
    const ids = claims.map((c) => c.id);
    const factsByClaim = new Map<string, any[]>();
    const cardByClaim = new Map<string, any[]>();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      for (const f of await q(`SELECT f.id, f.fact_key, f.segment, f.low, f.high, f.status, f.source_claim_id, f.valid_until, f.supersedes_fact_id, (SELECT s.id FROM construction_facts s WHERE s.supersedes_fact_id = f.id LIMIT 1) AS superseded_by, n.name AS node, n.kind AS node_kind FROM construction_facts f LEFT JOIN industry_nodes n ON n.id = f.node_id WHERE f.source_claim_id IN (${ph})`, ids)) {
        const l = factsByClaim.get(f.source_claim_id) ?? []; l.push(f); factsByClaim.set(f.source_claim_id, l);
      }
      for (const f of await q(`SELECT id, opportunity_id, field, kind, substr(value,1,80) AS value, claim_id, updated_at FROM cash_card_facts WHERE claim_id IN (${ph})`, ids)) {
        const l = cardByClaim.get(f.claim_id) ?? []; l.push(f); cardByClaim.set(f.claim_id, l);
      }
    }
    // Plan reading text: which claim / fact ids does the latest reading carry?
    const latest = (await q(`SELECT id, created_at, verdict, strategies, forecast, next_test FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [G]))[0];
    const text = latest ? `${latest.strategies ?? ''}${latest.forecast ?? ''}${latest.next_test ?? ''}` : '';
    out('LATEST_READING', latest ? { id: latest.id, at: latest.created_at, verdict: latest.verdict, len: text.length } : null);

    // 2. The model inputs of every arrangement the reading names, from the stored library, with this project's knowledge.
    const knowledge = await loadCashKnowledge(P);
    const arrKeys = [...new Set([...text.matchAll(/arr_([0-9a-f]{12})/g)].map((m) => m[1]!))];
    out('READING_ARR_KEYS', arrKeys);
    const inputText: string[] = [];
    for (const key of [...arrKeys, '2821cce3c372']) {
      const rec: any = await arrangementForLegacyKey(P, key);
      const a = rec?.design?.arrangement;
      if (!a) { out('ARR_MISSING', key); continue; }
      out('ARR', { key, label: a.label?.slice(0, 120), design: a.design, value: { ...a.value, evidence: undefined }, fixedCost: a.fixedCost ?? null, conversion: a.conversion ? { ...a.conversion, evidence: undefined } : null, unknownParts: a.unknownParts, stress: { exposure: a.stress?.exposure, worst: a.stress?.worstCaseCents }, demand: a.demand?.name, demandRef: a.demand?.ref });
      const m: any = estimatedFromArrangement(a, { projectId: P, currency: 'USD', knowledge, now: new Date(), daysLeft, beforeProofCents: null } as any);
      if (!m) { out('MODEL_NULL', key); continue; }
      for (const k of ['price', 'directCost', 'capital', 'volume', 'daysToCash', 'close', 'respond', 'hours']) {
        const s = slim(m[k]);
        out(`MODEL_${key}_${k}`, { prov: s?.provenance, low: s?.low, high: s?.high, value: s?.value, tier: s?.inferred?.tier, obs: s?.inferred?.observations, note: String(s?.note ?? '').slice(0, 300), source: s?.source });
        inputText.push(JSON.stringify(m[k] ?? {}));
      }
    }
    const inputs = inputText.join(' ');
    for (const c of claims) {
      const facts = factsByClaim.get(c.id) ?? [];
      const cards = cardByClaim.get(c.id) ?? [];
      const live = facts.filter((f) => !f.superseded_by);
      out('CLAIM', {
        id: c.id, at: c.created_at, claim: c.claim,
        facts: facts.map((f) => `${f.id}:${f.fact_key}:${f.low}-${f.high}:${f.status}:${f.segment}:${f.node_kind}:${f.superseded_by ? 'SUPERSEDED' : 'LIVE'}:until=${f.valid_until ?? ''}`),
        cards: cards.map((f) => `${f.id}:${f.opportunity_id}:${f.field}:${f.kind}`),
        inReading: text.includes(c.id) || live.some((f) => text.includes(f.id)) || cards.some((f) => text.includes(f.id)),
        inModelInputs: inputs.includes(c.id) || live.some((f) => inputs.includes(f.id)),
      });
    }
    // Claims with a card fact in this project that are NOT from the goal's rounds but the inference reads (project-wide evidence).
    for (const r of await q(`SELECT field, kind, COUNT(*) AS n, SUM(CASE WHEN claim_id IS NOT NULL THEN 1 ELSE 0 END) AS claimed FROM cash_card_facts WHERE project_id = ? GROUP BY field, kind ORDER BY n DESC`, [P])) out('CARD_FACTS', r);
    for (const r of await q(`SELECT fact_key, status, COUNT(*) AS n FROM construction_facts f WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM construction_facts s WHERE s.supersedes_fact_id = f.id) GROUP BY fact_key, status ORDER BY n DESC`, [P])) out('CONSTR_FACTS', r);
    const obs = await constructionObservations({ projectId: P, currency: 'USD', daysLeft });
    out('OBS_COUNTS', Object.fromEntries(Object.entries(obs).map(([k, v]) => [k, (v as any[]).length])));
    for (const o of obs.priced.slice(0, 40)) out('OBS_PRICED', { id: o.id, payer: o.context['payer'], v: o.value, lineage: o.lineage, measures: o.measures.slice(0, 100) });

    // 3. What the goal's rounds ask, and whether they target the plan's unknowns.
    for (const r of await q(`SELECT state, mechanism, COUNT(*) AS n, MAX(opened_at) AS last FROM cash_discovery_rounds WHERE bucket_id LIKE ? GROUP BY state, mechanism ORDER BY n DESC`, [bucket])) out('ROUNDS', r);
    for (const r of await q(`SELECT state, COUNT(*) AS n FROM cash_discovery_rounds WHERE bucket_id LIKE ? AND opened_at >= ? GROUP BY state`, [bucket, new Date(Date.now() - 24 * 3600_000).toISOString()])) out('ROUNDS_24H', r);
    const recent = await q(`SELECT r.id, r.bucket_id, r.state, r.opened_at, r.candidate_id FROM cash_discovery_rounds r WHERE r.bucket_id LIKE ? ORDER BY r.opened_at DESC LIMIT 25`, [bucket]);
    for (const r of recent) {
      const frags = await q(`SELECT f.fragment_key, f.status, substr(f.question, 1, 260) AS q FROM research_fragments f WHERE f.orchestration_id IN (SELECT orchestration_id FROM russell_missions WHERE candidate_id = ?) ORDER BY f.fragment_index LIMIT 8`, [r.candidate_id]);
      const acc = await q(`SELECT COUNT(*) AS n, SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS acc FROM research_claims WHERE orchestration_id IN (SELECT orchestration_id FROM russell_missions WHERE candidate_id = ?)`, [r.candidate_id]);
      out('ROUND', { id: r.id, bucket: r.bucket_id.replace(`goal-${G}-`, ''), state: r.state, at: r.opened_at, claims: acc[0], frags: frags.map((f) => `${f.fragment_key}|${f.status}|${f.q}`) });
    }
    // Rounds on the plan's candidate arrangements, and on arrangements the model dropped as value UNKNOWN.
    for (const key of [...arrKeys, '2821cce3c372']) for (const r of await q(`SELECT id, state, opened_at FROM cash_discovery_rounds WHERE bucket_id LIKE ? ORDER BY opened_at DESC LIMIT 3`, [`goal-${G}-mx-${key}%`])) out('ARR_ROUND', { key, ...r });
    for (const r of await q(`SELECT research_verdict, COUNT(*) AS n, SUM(CASE WHEN asked_count > 0 THEN 1 ELSE 0 END) AS asked, SUM(CASE WHEN evaluated_count > 0 THEN 1 ELSE 0 END) AS evaluated FROM monetization_paths WHERE project_id = ? AND origin = 'CONSTRUCTED' GROUP BY research_verdict`, [P])) out('PATHS', r);
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
