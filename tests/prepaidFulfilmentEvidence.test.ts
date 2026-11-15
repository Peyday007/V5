/**
 * Production, 2026-11-15 (goal wst_7b4fcbb5f2384f31b6c3, revision 842bb7c):
 * the reconstruction's `capital:prepaid-fulfilment` lever read "the buyer pays
 * in full before the supplier is paid" for a constructed arrangement whose
 * buyers — state technical utility services bureaus — were known only from a
 * sourced claim that one of them issued an RFP. An $881,310 direct cost left
 * the $3,000 capital limit, one deal kept ~$1.9M, and the plan read 46.7%.
 *
 * The lever now applies only where prepayment is stated for that buyer;
 * stated arrears, an award and terms nobody stated never read as prepaid
 * (invariant 39). A constructed arrangement inherits the terms its buyers'
 * evidence states. The plausibility critic reads one deal's kept cash against
 * the money behind the plan (SCALE), so such a deal cannot carry the plan.
 */
import { describe, expect, it } from 'vitest';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import { prepaymentEligible, reconstructPlan, RETURN_BOUND } from '../server/services/goals/reconstruction.ts';
import { combineTimings, modelledTiming, openingTiming, timingOfText } from '../server/services/cash/paymentTiming.ts';
import { buyerTermsOf, type Primitive } from '../server/services/cash/construct.ts';
import { inheritedTerms, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const fixed = (v: number): ModelInput => ({ value: v, low: v, high: v, provenance: 'EVIDENCE', source: null, note: '' });
const swept = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: '' });
const one = (id: string, index: number, over: Partial<ModelledOpportunity>): ModelledOpportunity => ({
  opportunity: { id, title: id } as ModelledOpportunity['opportunity'],
  index,
  tier: 'QUALIFIED',
  repeatable: true,
  price: fixed(400),
  capital: fixed(0),
  hours: fixed(1),
  daysToCash: fixed(6),
  close: swept(0.05, 0.25),
  respond: swept(0.005, 0.03),
  directCost: fixed(0),
  volume: fixed(200),
  agreed: false,
  agreedValue: 0,
  agreedDeals: 0,
  fulfilledBy: null,
  competitiveAward: false,
  ...over,
});

const RFP_CLAIM = 'The Pennsylvania PUC Bureau of Technical Utility Services issued an RFP (2026) for technical utility review services.';

/** The production arrangement as the engine saw it: priced from observed facts (p50 ≈ $2.77M), an $881,310 direct cost, one deal. */
function bureaus(paymentTerms: string | null, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return one('arr_15871099b48b', 9, {
    opportunity: { id: 'arr_15871099b48b', title: 'Constructed: state technical utility services bureaus', paymentTerms } as unknown as ModelledOpportunity['opportunity'],
    tier: 'ESTIMATE',
    repeatable: false,
    price: { value: null, low: 1_200_000, high: 4_500_000, provenance: 'ASSUMPTION', source: null, note: 'reconstructed', inferred: { tier: 'ESTIMATE' as never, justified: false, p10: 1_200_000, p50: 2_765_302, p90: 4_500_000, observations: 2 } },
    capital: swept(0, 881_310),
    daysToCash: swept(3, 60),
    close: swept(0.02, 0.5),
    respond: swept(0.002, 0.15),
    directCost: { value: 881_310, low: 881_310, high: 881_310, provenance: 'ASSUMPTION', source: null, note: 'observed construction fact' },
    volume: { value: 1, low: 1, high: 1, provenance: 'ASSUMPTION', source: null, note: 'a one-off design is one deal' },
    ...over,
  });
}

const limits = { remaining: 10_000, daysLeft: 30, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: '40 emails a day', worlds: 600, seed: 7 };
const held = [one('lists', 1, { price: fixed(300) }), one('audits', 2, { price: fixed(900), close: swept(0.03, 0.15), volume: fixed(60) })];

async function reconstruct(openings: ModelledOpportunity[]) {
  const baseline = evaluateGoalPortfolio({ ...limits, openings });
  return reconstructPlan({ openings, portfolio: limits, baseline, required: 0.9 });
}
const tried = (r: Awaited<ReturnType<typeof reconstruct>>) => r.rounds.flatMap((x) => x.tried);
const BUREAU = 'Constructed: state technical utility services bureaus'.slice(0, 50);

describe('payment timing is read only from what is stated', () => {
  it('an RFP or award is arrears, stated terms decide, and nothing stated is unknown', () => {
    expect(timingOfText(RFP_CLAIM, 'claim c1').timing).toBe('ARREARS');
    expect(timingOfText('Invoices are net 30 after acceptance', 'terms').timing).toBe('ARREARS');
    expect(timingOfText('Clients pay a 50% deposit at signing, balance on delivery', 'terms').timing).toBe('PREPAID');
    expect(timingOfText('Paid in full up front at checkout', 'terms').timing).toBe('PREPAID');
    expect(timingOfText(null, 'terms').timing).toBe('UNKNOWN');
    expect(timingOfText('Technical utility review services', 'node').timing).toBe('UNKNOWN');
    // Conflicting evidence about one buyer is never read in the plan's favour.
    expect(combineTimings([timingOfText('deposit at order', 'a'), timingOfText(RFP_CLAIM, 'b')]).timing).toBe('ARREARS');
    expect(openingTiming({ title: 'RFP: utility review services', source: null, buyingSignal: null, paymentTerms: null }, 'opening o1').timing).toBe('ARREARS');
  });

  it('a constructed arrangement inherits its buyers\' evidenced terms (RFP → arrears), and none stated stays unknown', () => {
    const demand: Primitive = { name: 'state technical utility services bureaus', claimId: 'c1', from: 'INDUSTRY_MAP', ref: 'node1', terms: timingOfText(RFP_CLAIM, 'claim c1') };
    const inherited = buyerTermsOf(demand, []);
    expect(inherited.buyerTerms?.timing).toBe('ARREARS');
    const terms = inheritedTerms(inherited);
    expect(terms).toMatch(/arrears/);
    expect(modelledTiming(bureaus(terms)).timing).toBe('ARREARS');
    // A held opening sold to the same buyer through a tender carries arrears too.
    const tender = { id: 'o2', title: 'Tender: technical review', source: null, buyingSignal: null, paymentTerms: null } as unknown as CashOpportunity;
    expect(buyerTermsOf({ ...demand, terms: undefined }, [tender]).buyerTerms?.timing).toBe('ARREARS');
    // Nothing stated: no inherited terms at all — unknown, not prepaid.
    expect(buyerTermsOf({ ...demand, terms: undefined }, []).buyerTerms).toBeUndefined();
    expect(inheritedTerms({})).toBeNull();
  });
});

describe('production case: the prepaid lever never zeroes an arrears or unknown buyer\'s cost', () => {
  for (const [label, terms] of [['evidenced arrears (RFP → award)', "paid in arrears, after delivery, as these buyers' evidence states"], ['unknown payment timing', null]] as const) {
    it(`${label}: no prepaid fulfilment on the bureaus, and the best plan does not rest on them`, async () => {
      const gov = bureaus(terms);
      expect(prepaymentEligible(gov).eligible).toBe(false);
      const r = await reconstruct([...held, gov]);
      // Nothing else carries a direct cost, so the lever has nothing it may touch: it is not tried at all.
      expect(tried(r).some((t) => t.key.includes('prepaid-fulfilment'))).toBe(false);
      expect(r.best.changes.some((c) => c.op === 'capital:prepaid-fulfilment')).toBe(false);
      // The CAPITAL challenge says why, instead of the lever saying the buyer prepays.
      const capital = r.challenges.find((c) => c.testedBy === 'CAPITAL')!;
      expect(capital.status).toBe('UNTESTED');
      expect(capital.finding).toMatch(terms ? /1 paying in arrears/ : /1 with terms nobody stated/);
      // The best plan is plausible and does not stand on the $1.9M deal.
      expect(r.best.implausible ?? []).toHaveLength(0);
      expect(r.best.members).not.toContain(BUREAU);
      // Every reading that does rest on it is flagged by the critic and kept, never concluded with (invariant 47).
      for (const t of tried(r).filter((x) => x.members.includes(BUREAU))) expect((t.implausible ?? []).some((f) => f.kind === 'SCALE')).toBe(true);
    }, 60_000);
  }

  it('the critic flags one deal keeping more than the bound times the money behind the plan', async () => {
    // Before the fix the lever made exactly this reading; force it in by funding the deal outright.
    const gov = { ...bureaus(null), fundedByBuyer: true };
    const r = await reconstruct([...held, gov]);
    const withGov = [r.baseline, ...tried(r)].filter((t) => t.members.includes(BUREAU));
    expect(withGov.length).toBeGreaterThan(0);
    for (const t of withGov) {
      const scale = (t.implausible ?? []).find((f) => f.kind === 'SCALE');
      expect(scale?.detail).toMatch(new RegExp(`bound ×${RETURN_BOUND}`));
    }
    expect(r.best.members).not.toContain(BUREAU);
  }, 60_000);

  it('a buyer with evidenced prepayment still gets the lever', async () => {
    const supplied = one('gifts', 3, {
      opportunity: { id: 'gifts', title: 'Corporate gifts, supplier drop-ships', paymentTerms: 'paid in full at checkout before the supplier ships' } as unknown as ModelledOpportunity['opportunity'],
      price: swept(690, 3450),
      directCost: swept(550, 3000),
      capital: swept(0, 300),
    });
    expect(prepaymentEligible(supplied).eligible).toBe(true);
    const r = await reconstruct([...held, supplied, bureaus(null)]);
    const prepaid = tried(r).find((t) => t.key.includes('prepaid-fulfilment'));
    expect(prepaid).toBeTruthy();
    const change = prepaid!.changes.find((c) => c.op === 'capital:prepaid-fulfilment')!;
    expect(change.detail).toMatch(/1 opening\(s\)/);
    expect(change.basis).toBe('ASSUMPTION');
    expect(r.challenges.find((c) => c.testedBy === 'CAPITAL')!.finding).toMatch(/1 shown paying before delivery/);
  }, 60_000);
});
