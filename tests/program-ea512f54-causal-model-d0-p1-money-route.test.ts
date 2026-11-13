/**
 * Finding F3 (CAUSAL-14-1, 14-2): an opening's money route on production had
 * no invoice or collection date, an unknown hold on every route, and dropped
 * the direct-cost outflow whenever the cost was unknown — so free-to-use cash
 * never resolved and no threshold or range was computed for the unknown.
 * The route is now read from the opening's own row: its terms, deadline,
 * acceptance condition and modelled days to cash; an unpriced outflow stays on
 * the route as unknown, and the threshold the unknown must respect is computed.
 */
import { describe, expect, it } from 'vitest';
import { causalGraphOf, causalOf, settlementOf } from '../server/services/goals/portfolio.ts';
import { readMoneyRoute, unknownFigure, type MoneyRoute } from '../server/services/quant/graph.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

const sourced = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: { kind: 'CLAIM', ref: 'clm_1' }, note: '' } as ModelInput);
const missing: ModelInput = { value: null, low: null, high: null, provenance: 'ASSUMPTION', source: null, note: '' } as unknown as ModelInput;

function opening(row: Partial<ModelledOpportunity['opportunity']>, over: Partial<ModelledOpportunity> = {}): ModelledOpportunity {
  return {
    opportunity: {
      id: 'opp_1', title: 'Office cleaning contract', payer: 'Acme Property', reachableChannel: 'email', offerScope: 'weekly cleaning',
      acceptanceCondition: null, paymentTerms: null, deadline: null, currency: 'USD', createdAt: '2026-11-01T00:00:00.000Z',
      requiredCapabilities: [], fulfillmentOwner: 'Spotless Subcontracting', mechanism: 'BROKER', ...row,
    } as ModelledOpportunity['opportunity'],
    index: 1, tier: 'QUALIFIED', repeatable: false,
    price: sourced(1_000), capital: sourced(0), hours: sourced(1), daysToCash: sourced(30), close: sourced(0.5), respond: sourced(1),
    directCost: sourced(600), volume: sourced(1), agreed: false, agreedValue: 0, agreedDeals: 0, fulfilledBy: null, competitiveAward: false,
    ...over,
  };
}

const routeOf = (one: ModelledOpportunity) => readMoneyRoute([...causalGraphOf(one).routes.values()][0]!);

describe('an opening\'s money route resolves from its own row', () => {
  it('net terms after delivery: dates derived, nothing held, free cash resolved and reproducible from entries', () => {
    const one = opening({ paymentTerms: 'net 30 on completion', deadline: '2026-11-20' });
    const route = [...causalGraphOf(one).routes.values()][0] as MoneyRoute;
    expect(route.collectedAt).toBe('2026-12-01');
    expect(route.invoicedAt).toBe('2026-11-01');
    expect(route.dateBasis?.collected).toContain('30 days to cash');
    expect(route.heldAgainstCents.value).toBe(0);
    expect(route.heldAgainstCents.status).toBe('MODELED');
    const r = readMoneyRoute(route);
    expect(r.freeCents.value).toBe(40_000);
    expect(r.gaps).not.toContain('invoice date');
    expect(r.gaps).not.toContain('collection date');
    expect(r.gaps).not.toContain('amount held against refund or fulfilment');
    expect(r.ledger.reconciliation.balanced).toBe(true);
    expect(r.discrepancies).toEqual([]);
  });

  it('prepaid: the whole collection is held against fulfilment, derived from the price', () => {
    const route = [...causalGraphOf(opening({ paymentTerms: 'prepaid in full' })).routes.values()][0] as MoneyRoute;
    expect(route.invoicedAt).toBe('2026-11-01');
    expect(route.heldAgainstCents.value).toBe(100_000);
    expect(route.heldAgainstCents.derivedFrom.length).toBe(1);
  });

  it('an acceptance condition alone means collection after delivery, with the invoice on the stated deadline', () => {
    const s = settlementOf(opening({ acceptanceCondition: 'client signs off the walkthrough', deadline: '2026-11-15' }), unknownFigure('p', 'cents'));
    expect(s.invoicedAt).toBe('2026-11-15');
    expect(s.heldAgainstCents.value).toBe(0);
  });

  it('an unknown direct cost stays on the route as an unknown outflow and yields the ceiling it must stay under', () => {
    const one = opening({ paymentTerms: 'net 15' }, { directCost: missing });
    const route = [...causalGraphOf(one).routes.values()][0] as MoneyRoute;
    expect(route.outflows).toHaveLength(1);
    expect(route.outflows[0]!.amountCents).toBeNull();
    const r = readMoneyRoute(route);
    expect(r.freeCents.value).toBeNull();
    expect(r.unknownOutflows).toBe(1);
    expect(r.gaps).toContain('amount paid to Spotless Subcontracting');
    expect(r.breakEven).toMatchObject({ unknown: 'outflowCents', bound: 'AT_MOST', cents: 100_000 });
  });

  it('nothing in the row decides the hold: hold and unknown cost get one combined ceiling, not a guess', () => {
    const r = routeOf(opening({}, { directCost: missing }));
    expect(r.heldAgainstCents).toBeNull();
    expect(r.breakEven).toMatchObject({ unknown: 'heldAgainstCents+outflowCents', bound: 'AT_MOST', cents: 100_000 });
    expect(r.breakEven!.statement).toContain('0 to 100000 cents');
  });

  it('an unknown hold with a known cost gives the hold\'s ceiling', () => {
    const r = routeOf(opening({}));
    expect(r.breakEven).toMatchObject({ unknown: 'heldAgainstCents', cents: 40_000 });
  });

  it('the portfolio reading carries the resolved route, not a blanket of unknowns', () => {
    const reading = causalOf([opening({ paymentTerms: 'net 30' })], []);
    const member = reading!.members[0]!;
    expect(member.route.freeCents.value).toBe(40_000);
    expect(member.unknowns).not.toContain('collection date');
  });
});
