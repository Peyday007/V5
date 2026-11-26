// E-010: replay every recorded raw reply through REF routesJson+parseRoutes; compare to the recorded (c52d6d3 / a8c4699) parse.
import { parseRoutes, routesJson, routeEconomics, economicsLine } from '../../../../../server/services/goals/routeProposal.ts';
import { probes, refCtx, write } from './lib.ts';

const rows: any[] = [];
for (const c of probes()) {
  const ctx = refCtx(c);
  for (const [i, r] of c.replies.entries()) {
    if (!r.content) { rows.push({ case: c.case, reply: i, model: r.model, empty: true, ms: r.ms, error: r.error }); continue; }
    const json = routesJson(r.content);
    const ref = parseRoutes(json, ctx);
    // Which reply did the recorded parse come from? The probe parses the first reply with content.
    const recordedFromThis = c.replies.findIndex((x) => x.content) === i;
    const rec = recordedFromThis ? c.parsed : null;
    rows.push({
      case: c.case, reply: i, model: r.model, chars: r.content.length, truncatedAt9000: r.content.length === 9000,
      routesJsonNull: json === null, rawRouteObjects: json?.routes.length ?? 0,
      recorded: rec ? { kept: rec.routes.map((x: any) => x.title), rejected: rec.rejected.map((x: any) => `${x.rule}: ${x.title}`) } : null,
      ref: {
        kept: ref.routes.map((x) => x.title), rejected: ref.rejected.map((x) => `${x.rule}: ${x.title} — ${x.why}`),
        economics: ref.routes.map((x) => ({ title: x.title, price: x.price, directCost: x.directCost, acq: x.acquisitionCostPerSale, hours: x.ownerHoursPerDeal, line: economicsLine(x, ctx) })),
      },
      // the raw fields the proposer gave, for the rejected-or-kept routes (to compute what the code could compute)
      rawFields: (json?.routes ?? []).map((x: any) => ({ title: x?.title, price: x?.price, directCost: x?.directCost, acquisitionCostPerSale: x?.acquisitionCostPerSale ?? null, ownerHoursPerDeal: x?.ownerHoursPerDeal, ownerFit: x?.ownerFit === undefined ? '(absent)' : 'present', daysToFirstCash: x?.daysToFirstCash, capital: x?.capital, buyerCount: x?.buyerCount, performer: x?.performer })),
    });
  }
}

// Constructed W1c cases (the recorded "445 sales from $3k at $38.99 CPA" route class) + sound control.
const p10 = probes().find((c) => c.case === 'probe1_p10_cap')!;
const ctx10 = refCtx(p10);
const base = { title: 'X', mechanism: 'EXISTING_BUYING_SIGNAL', industry: 'retail', payer: 'holiday gift shoppers', channel: 'Meta ads', performer: 'SUBCONTRACTOR', fulfiller: 'Printful', daysToFirstCash: 10, capital: 3000, monthly: false, ownerHoursPerDeal: 0, ownerFit: 'capital only' };
const constructed = {
  // as the W route stated it: $45 beanie, $25.43 direct cost (Printful+ship), $38.99 CPA, 445 buyers.
  knownBad_cpaAboveMargin: { ...base, title: 'Beanie dropship (recorded figures)', offer: 'themed beanie', price: 45, directCost: 25.43, acquisitionCostPerSale: 38.99, buyerCount: 445 },
  // same route class but the proposer OMITS acquisitionCostPerSale (as every recorded c52d6d3 reply did: the field did not exist).
  knownBad_cpaOmitted: { ...base, title: 'Beanie dropship (no CPA field)', offer: 'themed beanie 2', price: 45, directCost: 25.43, buyerCount: 445 },
  // CPA below margin but the spend to win the needed sales exceeds capital ($5k) — does anything flag acquisition spend > capital?
  knownBad_spendOverCapital: { ...base, title: 'Beanie dropship (CPA 15, spend over capital)', offer: 'themed beanie 3', price: 45, directCost: 25.43, acquisitionCostPerSale: 15, buyerCount: 100000 },
  // sound control: $400 service, $100 cost, $50 CPA — must be kept and not flagged.
  control_sound: { ...base, title: 'Sound control route', offer: 'bookkeeping catch-up', payer: 'Minneapolis small businesses', price: 400, directCost: 100, acquisitionCostPerSale: 50, buyerCount: 5000, capital: 1000 },
};
const constructedOut: any = {};
for (const [k, r] of Object.entries(constructed)) {
  const p = parseRoutes({ routes: [r] }, ctx10);
  constructedOut[k] = { kept: p.routes.map((x) => x.title), rejected: p.rejected, economics: p.routes[0] ? { ...routeEconomics(p.routes[0], ctx10), line: economicsLine(p.routes[0], ctx10) } : null };
}
// E-002 lead: the exact truncated a8c4699 content
const e002 = probes().find((c) => c.case === 'E-002_eval_p02_cap')!;
const tr = e002.replies[0]!;
const trJson = routesJson(tr.content);
// Known-good controls on the p06 limits (15 owner hours, $0 capital, 7 days): a correct HOURS / MARGIN / DEADLINE / CAPITAL rejection must persist.
const p06 = probes().find((c) => c.case === 'final_p06_all')!;
const ctx06 = refCtx(p06);
const b06 = { mechanism: 'EXISTING_BUYING_SIGNAL', industry: 'services', channel: 'TaskRabbit', performer: 'OWNER', fulfiller: 'the owner', capital: 0, daysToFirstCash: 2, monthly: false, ownerFit: 'own hours' };
const controls06 = {
  hours_oneSaleOver15h: { ...b06, title: 'One 20-hour job', payer: 'a', offer: 'a', price: 600, directCost: 0, ownerHoursPerDeal: 20 },
  hours_wholeTargetOver15h_oneSaleFits: { ...b06, title: 'Recorded class: 2 h a sale, 13 sales', payer: 'b', offer: 'b', price: 80, directCost: 40, ownerHoursPerDeal: 2 },
  margin_costEqualsPrice: { ...b06, title: 'Cost = price', payer: 'c', offer: 'c', price: 62, directCost: 62, ownerHoursPerDeal: 1 },
  deadline_8days: { ...b06, title: '8 days to cash', payer: 'd', offer: 'd', price: 100, directCost: 0, ownerHoursPerDeal: 1, daysToFirstCash: 8 },
  capital_5dollars: { ...b06, title: '$5 posting fee as capital', payer: 'e', offer: 'e', price: 100, directCost: 0, ownerHoursPerDeal: 1, capital: 5 },
};
const controlsOut: any = {};
for (const [k, r] of Object.entries(controls06)) { const p = parseRoutes({ routes: [r] }, ctx06); controlsOut[k] = { kept: p.routes.map((x) => x.title), rejected: p.rejected.map((x) => `${x.rule}: ${x.why}`) }; }
write('raw/E-010/controls_p06.json', controlsOut);
console.log('CONTROLS', JSON.stringify(controlsOut, null, 1));
const leadA = { chars: tr.content.length, error: tr.error, routesJson: trJson, parse: parseRoutes(trJson, refCtx(e002)), recordedParsed: e002.parsed, recordedCritique: e002.critique, tail: tr.content.slice(-200) };

write('raw/E-010/replay.json', rows);
write('raw/E-010/constructed.json', constructedOut);
write('raw/E-010/lead_truncated_e002.json', leadA);
for (const r of rows) console.log(JSON.stringify({ case: r.case, reply: r.reply, model: r.model, empty: r.empty, chars: r.chars, rec: r.recorded, refKept: r.ref?.kept, refRej: r.ref?.rejected?.map((x: string) => x.slice(0, 160)) }));
console.log('CONSTRUCTED', JSON.stringify(constructedOut, null, 1));
console.log('LEAD_A', JSON.stringify({ ...leadA, recordedCritique: leadA.recordedCritique }, null, 1));
