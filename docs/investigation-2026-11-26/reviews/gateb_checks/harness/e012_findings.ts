// E-012: REF findingsOf over the verified facts the intelligence test supplied (tools/batch.py selection), at REF cap 120 and pre-repair 40.
import fs from 'node:fs';
import path from 'node:path';
import { findingsOf, FINDINGS_SHOWN } from '../../../../../server/services/goals/routeProposal.ts';
import { ROOT, write } from './lib.ts';

// Same selection and order as docs/intelligence-test-2026-11-26/tools/batch.py (EXACT|FUZZY, follow-ups F* first = "newest first").
const supplied = (goal: string) => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, `docs/intelligence-test-2026-11-26/verified/v_${goal}.json`), 'utf8')) as any[];
  const ok = v.filter((r) => r.v === 'EXACT' || r.v === 'FUZZY');
  const ord = [...ok.filter((r) => r.q.startsWith('F')), ...ok.filter((r) => !r.q.startsWith('F'))];
  return ord.map((r, i) => ({ id: `probe_${i + 1}`, q: r.q, claim: String(r.claim).slice(0, 280), sourceUrl: r.sourceUrl, sourceTitle: (r.sourceTitle ?? '').slice(0, 80), sourcePublisher: null, sourceDate: r.sourceDate ?? null, evidenceLane: r.lane && r.lane !== 'other' ? r.lane : null, retrievedAt: '2026-11-26T00:00:00Z' })) as any[];
};
// Decisive facts named by the 30Q report (p10: agency pricing, cold-email cost per client, SMB budgets; p06: TaskRabbit; p02: payment terms).
const DECISIVE: Record<string, RegExp[]> = {
  p10: [/10.{0,3}20\s*%|percent of (?:ad|media) spend|£1,?000/i, /52\s*% of small businesses|monthly marketing budgets/i, /\$153|booked meeting/i, /\$100.{0,6}\$?500 per client|per client/i],
  p06: [/TaskRabbit/i, /\$31|average.*hour/i],
  p02: [/net 30|paid in full at the shoot|at the shoot/i, /\$129|\$300 per shoot/i],
};
const res: any = {};
for (const goal of ['p02', 'p06', 'p10']) {
  const claims = supplied(goal);
  const at = (max: number) => {
    const f = findingsOf(claims, max);
    const ids = new Set(f.map((x) => x.claimId));
    const lanes: Record<string, number> = {};
    for (const x of f) lanes[x.lane ?? '(none)'] = (lanes[x.lane ?? '(none)'] ?? 0) + 1;
    const decisive = DECISIVE[goal]!.map((re) => {
      const hits = claims.filter((c) => re.test(c.claim));
      return { pattern: String(re), inSupplied: hits.length, shown: hits.filter((c) => ids.has(c.id)).length, examples: hits.slice(0, 2).map((c) => `${c.q}${ids.has(c.id) ? ' SHOWN' : ' CUT'}: ${c.claim.slice(0, 120)}`) };
    });
    return { shown: f.length, lanes, decisive };
  };
  const all = findingsOf(claims, 100000);
  res[goal] = { supplied: claims.length, eligibleAfterFilters: all.length, droppedByFilters: claims.length - all.length, droppedTexts: claims.filter((c) => !all.some((x) => x.claimId === c.id)).map((c) => `${c.q}: ${c.claim.slice(0, 140)}`), ref120: at(FINDINGS_SHOWN), pre40: at(40) };
}
// Fault injection 1: a refuted claim, and a CONTESTED one, supplied to findingsOf.
const base = supplied('p10');
const refuted = { ...base[0], id: 'inj_refuted', claim: 'INJECTED: Meta ads for holiday beanies cost $3 per sale in Minneapolis in 2026 (refuted).', contradictionState: 'REFUTED' };
const contested = { ...base[0], id: 'inj_contested', claim: 'INJECTED: Meta ads for holiday beanies cost $4 per sale in Minneapolis in 2026 (contested).', contradictionState: 'CONTESTED' };
const fi = findingsOf([refuted, contested, ...base], FINDINGS_SHOWN);
const fault1 = { refutedShown: fi.some((x) => x.claimId === 'inj_refuted'), contestedShown: fi.some((x) => x.claimId === 'inj_contested'), contestedMarkedInPrompt: fi.find((x) => x.claimId === 'inj_contested')?.text };
// Fault injection 2: 200 new, newest-first, low-relevance findings (one recent round on e-commerce) in two lanes, ahead of the 135 supplied.
const noise = Array.from({ length: 200 }, (_, i) => ({ id: `inj_noise_${i}`, claim: `INJECTED round ${i}: a Shopify store in another state sold ${i + 3} beanies in week ${i % 52} of 2026 according to a forum post.`, sourceUrl: `https://example.org/noise/${i}`, sourceTitle: 'forum', sourcePublisher: null, sourceDate: '2026-11-25', evidenceLane: i % 2 ? 'comparable_demand' : 'current_demand', retrievedAt: '2026-11-26T01:00:00Z' }));
const noisy = findingsOf([...noise, ...base], FINDINGS_SHOWN);
const noisyIds = new Set(noisy.map((x) => x.claimId));
const fault2 = {
  shown: noisy.length, noiseShown: noisy.filter((x) => x.claimId.startsWith('inj_noise')).length, realShown: noisy.filter((x) => !x.claimId.startsWith('inj_noise')).length,
  decisiveP10: DECISIVE.p10!.map((re) => ({ pattern: String(re), shown: base.filter((c) => re.test(c.claim) && noisyIds.has(c.id)).length, inSupplied: base.filter((c) => re.test(c.claim)).length })),
  // what the production read hands findingsOf: projectEvidenceClaims(projectId, FINDINGS_SHOWN*3) newest first — the 360 newest claims only.
  productionReadLimit: FINDINGS_SHOWN * 3,
};
// Fault injection 3: 400 noise claims ahead of the real ones, truncated as production's read truncates (LIMIT 360, newest first) before findingsOf.
const noise400 = Array.from({ length: 400 }, (_, i) => ({ ...noise[i % 200], id: `inj_n400_${i}`, claim: `${noise[i % 200]!.claim} variant ${i}` }));
const read360 = [...noise400, ...base].slice(0, FINDINGS_SHOWN * 3);
const f3 = findingsOf(read360, FINDINGS_SHOWN);
const fault3 = { readRealClaims: read360.filter((c) => !String(c.id).startsWith('inj')).length, shownReal: f3.filter((x) => !x.claimId.startsWith('inj')).length };
write('raw/E-012/result.json', { res, fault1, fault2, fault3 });
console.log(JSON.stringify({ res, fault1, fault2, fault3 }, null, 1));
