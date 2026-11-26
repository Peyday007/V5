// E-011: reconstruct recorded critic verdicts into RouteCritique and apply REF applyCritique; plus constructed controls and fault injection.
import { applyCritique, critiqueJson, parseRoutes, critiquePrompt, type RouteCritique, type ProposedRoute } from '../../../../server/services/goals/routeProposal.ts';
import { probes, refCtx, write } from './lib.ts';

const RULES = ['OWNER_FIT', 'WINDOW', 'CHANNEL', 'FULFILLER', 'PRICE', 'CAPITAL', 'MARKET', 'VALUE', 'LAWFUL', 'EVIDENCE'];
const out: any[] = [];
for (const c of probes()) {
  const cr = c.critique;
  if (!cr || !('ranked' in cr) || !c.parsed) continue;
  const ctx = refCtx(c);
  // The routes the critic actually judged = the recorded parse, re-read through REF parseRoutes (same fields).
  const routes = parseRoutes({ routes: c.parsed.routes }, ctx).routes;
  const reviews: any[] = [];
  routes.forEach((r, i) => {
    const d = cr.dropped.find((x: any) => x.title === r.title);
    const k = cr.ranked.find((x: any) => x.route.title === r.title);
    if (d) {
      const m = /fails ([A-Z_, ]+)\): (.*)$/s.exec(d.why);
      const failed = m ? m[1]!.split(',').map((s: string) => s.trim()).filter((s: string) => RULES.includes(s)) : [];
      reviews.push({ index: i + 1, verdict: 'DROP', failed, scores: {}, why: m ? m[2] : d.why, repair: null });
    } else if (k) reviews.push({ index: i + 1, verdict: 'KEEP', failed: [], scores: {}, why: k.why, repair: null });
  });
  const ranking = cr.ranked.map((x: any) => routes.findIndex((r) => r.title === x.route.title) + 1).filter((n: number) => n > 0);
  // Pass through REF critiqueJson so the reconstructed reply is read exactly as a model reply would be.
  const critique = critiqueJson(JSON.stringify({ reviews, ranking }), routes.length);
  const applied = critique ? applyCritique(routes, critique, ctx) : null;
  out.push({
    case: c.case, epoch: c.revision.slice(0, 7),
    recorded: { ranked: cr.ranked.map((x: any) => x.route.title), dropped: cr.dropped.map((x: any) => x.title) },
    reconstructed: reviews.map((r) => ({ i: r.index, verdict: r.verdict, failed: r.failed })),
    ref: applied && { ranked: applied.ranked.map((x) => ({ title: x.route.title, why: x.why.slice(0, 160) })), dropped: applied.dropped.map((x) => x.title) },
  });
}

// Constructed: p10 snow route (integration diagnosis quote: "fails WINDOW: first snow events typically occur in December, well after the 90-day window ends").
const p10 = probes().find((c) => c.case === 'probe1_p10_cap')!;
const ctx10 = refCtx(p10);
const snowRaw = { title: 'Commercial snow-plow contracts brokered to plow operators', mechanism: 'EXISTING_BUYING_SIGNAL', industry: 'snow removal', payer: 'Minneapolis commercial property managers', offer: 'monthly snow-plow contract fulfilled by a subcontracted plow operator', price: 700, directCost: 450, acquisitionCostPerSale: 50, channel: 'direct email to property managers', performer: 'SUBCONTRACTOR', fulfiller: 'local plow operator', capital: 1000, ownerHoursPerDeal: 0, daysToFirstCash: 35, monthly: false, buyerCount: 400, ownerFit: 'capital only, no owner hours' };
const [snow] = parseRoutes({ routes: [snowRaw] }, ctx10).routes as [ProposedRoute];
const crit = (verdict: string, failed: string[], why: string, repair: Record<string, unknown> | null = null): RouteCritique =>
  critiqueJson(JSON.stringify({ reviews: [{ index: 1, verdict, failed, scores: {}, why, repair }], ranking: [] }), 1)!;
const cases: Record<string, RouteCritique> = {
  // known-bad (false WINDOW-only drop): must be kept at REF
  knownBad_snowWindowOnly: crit('DROP', ['WINDOW'], 'first snow events typically occur in December, well after the 90-day window ends'),
  // known-bad as the p02/p10 critics actually wrote them: a false WINDOW claim paired with a soft second rule
  knownBad_falseWindowPlusChannel: crit('DROP', ['WINDOW', 'CHANNEL'], "Printful's Dec 3-7 delivery falls after the 90-day window; Meta ads at $44 CPA not guaranteed"),
  // control A: TRUE window violation invisible in the route's own figures (the route says 35 days; the critic correctly says the payer pays on 120-day terms), no repair
  controlTrueWindow_noRepair: crit('DROP', ['WINDOW'], 'F12 shows these property managers pay subcontract invoices on net-120 terms, after the window ends'),
  // control B: same true violation, critic gives a repair with the true figure
  controlTrueWindow_repair: crit('REPAIR', ['WINDOW'], 'F12 shows net-120 terms', { daysToFirstCash: 120 }),
  // control C: true CAPITAL violation the route did not state (the p06 "$5 posting fee with $0 capital" class), no repair
  controlTrueCapital_noRepair: crit('DROP', ['CAPITAL'], 'requires a $1,500 plow-operator deposit before the first contract; route states $1,000 against a... (illustrative)'),
  // control D: a genuine legal drop must still drop
  controlLawful: crit('DROP', ['LAWFUL'], 'brokering snow removal requires a licence the owner does not hold (F7)'),
  // fault injection: an invented objection citing a finding that does not exist (F999) on a non-numeric rule
  fault_inventedFinding: crit('DROP', ['MARKET'], 'F999 shows no Minneapolis property manager buys plow contracts'),
  // fault injection: invented objection with no rule named at all (verdict DROP, empty failed)
  fault_noRule: crit('DROP', [], 'not convinced'),
  // fault injection: KEEP verdict but a 1/5 score on WINDOW (score-derived failure)
  fault_keepButScore1: critiqueJson(JSON.stringify({ reviews: [{ index: 1, verdict: 'KEEP', scores: { WINDOW: 1 }, why: 'fine' }], ranking: [1] }), 1)!,
};
const constructed: any = {};
for (const [k, cq] of Object.entries(cases)) {
  const a = applyCritique([snow], cq, ctx10);
  constructed[k] = { failed: cq.reviews[0]!.failed, verdict: cq.reviews[0]!.verdict, ranked: a.ranked.map((x) => ({ title: x.route.title, score: x.score, days: x.route.daysToFirstCash, why: x.why.slice(0, 200) })), dropped: a.dropped };
}
// Does the critic prompt let a reader check the critic's cited refs? Show the prompt's findings count and whether F999 could appear.
const promptLen = critiquePrompt(ctx10, [snow], null).length;
write('raw/E-011/replay.json', out);
write('raw/E-011/constructed.json', { snowRoute: snow, constructed, critiquePromptChars: promptLen });
console.log(JSON.stringify(out, null, 1));
console.log(JSON.stringify(constructed, null, 1));
