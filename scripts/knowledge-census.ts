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
    // Accepted claims of the goal's rounds, by round kind (mx- arrangement, ind- industry, pw pathway, other) and structural flag.
    for (const r of await q(
      `SELECT CASE WHEN r.bucket_id LIKE ? THEN 'mx' WHEN r.bucket_id LIKE ? THEN 'ind' ELSE substr(r.bucket_id, 1, 60) END AS kind,
              COUNT(DISTINCT c.id) AS n, COUNT(DISTINCT CASE WHEN c.structural_finding IS NOT NULL THEN c.id END) AS structural,
              COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM construction_facts f WHERE f.source_claim_id = c.id) THEN c.id END) AS filed
         FROM research_claims c JOIN russell_missions m ON m.orchestration_id = c.orchestration_id JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id
        WHERE r.bucket_id LIKE ? AND c.accepted = 1 GROUP BY 1 ORDER BY n DESC LIMIT 20`,
      [`goal-${G}-mx-%`, `goal-${G}-ind-%`, bucket],
    )) out('ACC_BY_KIND', r);
    for (const r of await q(`SELECT c.structural_finding AS sf, COUNT(*) AS n FROM research_claims c WHERE c.accepted = 1 AND c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?) GROUP BY 1 ORDER BY n DESC LIMIT 10`, [bucket])) out('STRUCTURAL', r);
    // Dry-run back-fill over every unfiled constructed-round claim of the project (nothing is filed).
    const reasons = new Map<string, number>();
    const filedKeys = new Map<string, number>();
    const samples = new Map<string, string[]>();
    let cursor = '';
    let read = 0;
    const goalMx = new Set((await q(`SELECT DISTINCT c.id FROM research_claims c WHERE c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?)`, [`goal-${G}-mx-%`])).map((r) => r.id));
    out('GOAL_MX_CLAIMS', goalMx.size);
    for (let i = 0; i < 25; i++) {
      const pool = await backfillCandidates(P, { unitEconomic: 'zzzz', constructed: cursor });
      const mine = pool.decisions.filter((d) => d.source === 'CONSTRUCTED_ROUND');
      if (i === 0) {
        const other = pool.decisions.filter((d) => d.source !== 'CONSTRUCTED_ROUND');
        const oc = new Map<string, number>();
        for (const d of other) oc.set(`${d.source}|${d.candidate ? 'FILE:' + d.candidate.key : (d.reason ?? '').slice(0, 90)}`, (oc.get(`${d.source}|${d.candidate ? 'FILE:' + d.candidate.key : (d.reason ?? '').slice(0, 90)}`) ?? 0) + 1);
        out('OTHER_SOURCES', [...oc].sort((a, b) => b[1] - a[1]).slice(0, 15));
      }
      if (mine.length === 0) break;
      for (const d of mine) {
        read++;
        const k = d.candidate ? `FILE:${d.candidate.key}` : (d.reason ?? '').replace(/"[^"]*"/g, '"…"').slice(0, 110);
        if (d.candidate) filedKeys.set(d.candidate.key, (filedKeys.get(d.candidate.key) ?? 0) + 1);
        reasons.set(k, (reasons.get(k) ?? 0) + 1);
        const l = samples.get(k) ?? [];
        if (l.length < 4 && d.claimId) l.push(d.claimId);
        samples.set(k, l);
      }
      cursor = mine[mine.length - 1]!.claimId ?? cursor;
    }
    out('MX_READ', read);
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 25)) out('MX_REASON', { n, k, samples: samples.get(k) });
    // Every sample's text, so a reader can judge whether a refused claim stated a price.
    const ids = [...samples.values()].flat();
    if (ids.length) for (const c of await q(`SELECT id, substr(claim, 1, 260) AS claim FROM research_claims WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) out('SAMPLE', c);
    // The 2821cce3c372 round's accepted claims, each with its dry-run decision.
    const r2821 = await q(`SELECT c.id, substr(c.claim, 1, 320) AS claim, c.structural_finding AS sf, (SELECT GROUP_CONCAT(f.fact_key || ':' || f.low) FROM construction_facts f WHERE f.source_claim_id = c.id) AS facts FROM research_claims c WHERE c.accepted = 1 AND c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?) ORDER BY c.id`, [`goal-${G}-mx-2821cce3c372%`]);
    for (const c of r2821) out('C2821', c);
    // Every claim in the goal's rounds that states a dollar figure with slot/ad/spot/advertis wording.
    for (const c of await q(`SELECT c.id, c.accepted, substr(c.claim, 1, 260) AS claim, (SELECT GROUP_CONCAT(f.fact_key || ':' || f.low) FROM construction_facts f WHERE f.source_claim_id = c.id) AS facts FROM research_claims c WHERE c.orchestration_id IN (SELECT m.orchestration_id FROM russell_missions m JOIN cash_discovery_rounds r ON r.candidate_id = m.candidate_id WHERE r.bucket_id LIKE ?) AND c.claim LIKE '%$%' AND (lower(c.claim) LIKE '%slot%' OR lower(c.claim) LIKE '%advertis%' OR lower(c.claim) LIKE '% ad %' OR lower(c.claim) LIKE '%spot%' OR lower(c.claim) LIKE '%postcard%' OR lower(c.claim) LIKE '%mailer%') ORDER BY c.id LIMIT 40`, [bucket])) out('SLOTLIKE', c);
    // Open rounds now, and what their fragments ask.
    for (const r of await q(`SELECT r.id, r.bucket_id, r.state, r.opened_at, r.candidate_id FROM cash_discovery_rounds r WHERE r.bucket_id LIKE ? AND r.state = 'OPEN'`, [bucket])) {
      const frags = await q(`SELECT f.fragment_key, f.status, f.question AS q FROM research_fragments f WHERE f.orchestration_id IN (SELECT orchestration_id FROM russell_missions WHERE candidate_id = ?) ORDER BY f.fragment_index LIMIT 6`, [r.candidate_id]);
      const cand = await q(`SELECT substr(statement, 1, 1500) AS s FROM russell_candidates WHERE id = ?`, [r.candidate_id]);
      out('OPEN_ROUND', { id: r.id, bucket: r.bucket_id.replace(`goal-${G}-`, ''), at: r.opened_at, statement: cand[0]?.s, frags: frags.map((f) => `${f.fragment_key}|${f.status}|${String(f.q).slice(0, 700)}`) });
    }
  } finally {
    await closeDatabase();
    console.log('GOALS: OK');
  }
}
main().catch((e) => { console.error(e); console.log('GOALS: OK'); process.exit(0); });
