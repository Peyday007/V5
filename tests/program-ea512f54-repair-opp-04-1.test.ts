/**
 * OPP-04 repair, episode 1: an unknown net states no value.
 *
 * Production, 2026-11-10: probe r01.opp-04 failed on goal wst_7b4fcbb5f2384f31b6c3, pathway
 * cop_c385c9d99a0943a1bdd0 — "net is unknown yet states the value -27231.387212474165". The price
 * was unknown (a swept range, no inference), so `net` was marked UNKNOWN, but `pathwayOf` still set
 * its value to the midpoint of the swept range. An unknown is never a point figure (§39, §93).
 *
 *   R01 — the production shape: unknown price, swept range, negative midpoint. net is UNKNOWN with
 *         value null, the swept low/high are kept, and the pathway passes pathwayProblem.
 *   R02 — the fit still reads the range: an all-negative range is a MARGIN problem, not a pathway
 *         that nets a hair above zero, and the pathway is kept, not dropped.
 *   R03 — a range crossing zero is still judged from its bounds and keeps a positive upside.
 *   R04 — an established price with an unknown direct cost stays ESTIMATED with a value.
 *   R05 — across every shape the builder produces, no UNKNOWN fact states a value.
 */
import { describe, expect, it } from 'vitest';
import { pathwayOf } from '../server/services/goals/pathways.ts';
import { pathwayProblem } from '../server/services/factory/program/release01/pathwaysProbe.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

const now = new Date();
const ctx = { remaining: 10_000, daysLeft: 30, currency: 'USD', perArrangement: 375, outreachPerDay: 60, permissionsMissing: [] as string[], now, capabilities: null };
const evidence = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: 'a gated claim' });
const unknown = (low: number, high: number): ModelInput => ({ value: null, low, high, provenance: 'UNKNOWN', source: null, note: 'swept' });

function opening(over: Record<string, unknown> = {}, card: Record<string, unknown> = {}): ModelledOpportunity {
  const o = {
    id: 'cop_c385c9d99a0943a1bdd0', projectId: 'prj_1', title: 'Equipment for a regional contractor', mechanism: 'BROKERED_SERVICE', industry: null,
    payer: 'Regional contractors', reachableChannel: 'published business email', buyingSignal: 'posted asking for it', signalObservedAt: null,
    offerScope: 'one delivery', priceCents: null, currency: 'USD', fulfillmentOwner: 'A named supplier', economicsNote: null, expiresAt: null,
    requiredCapabilities: [], opportunitySignal: null, state: 'EVIDENCE_CARD', ...card,
  } as unknown as CashOpportunity;
  return {
    opportunity: o, index: 1, tier: 'CANDIDATE', repeatable: false, price: unknown(10, 100), capital: evidence(0), hours: unknown(1, 2), daysToCash: evidence(9),
    close: unknown(0.02, 0.5), respond: unknown(0.002, 0.15), directCost: evidence(27_263), volume: unknown(1, 20), agreed: false, agreedValue: 0, agreedDeals: 0,
    fulfilledBy: null, competitiveAward: false, ...over,
  } as unknown as ModelledOpportunity;
}

describe('R01: the production shape', () => {
  it('marks net unknown with no value, keeps the swept range, and passes the probe rule', () => {
    const p = pathwayOf(opening(), null, ctx);
    expect(p.revenuePerDeal.status).toBe('UNKNOWN');
    expect(p.net.status).toBe('UNKNOWN');
    expect(p.net.value).toBeNull();
    expect(p.net.low).not.toBeNull();
    expect(p.net.high).not.toBeNull();
    expect(p.net.high!).toBeLessThan(0);
    expect(pathwayProblem(p)).toBeNull();
  });
});

describe('R02: the fit reads the range', () => {
  it('treats an all-negative unknown net as a margin problem, not a near-zero profit', () => {
    const p = pathwayOf(opening(), null, ctx);
    expect(p.fit.verdict).toBe('TOO_SMALL_AS_IS');
    expect(p.fit.lever.variable).toBe('MARGIN');
    expect(p.gaps).toContain('NO_MARGIN');
    expect(p.contribution.p50).toBe(0);
    // Kept, not abandoned: the pathway is still built and still says what to change.
    expect(p.opportunityId).toBe('cop_c385c9d99a0943a1bdd0');
    expect(p.moves.length).toBeGreaterThan(0);
  });
});

describe('R03: a range that crosses zero', () => {
  it('states no value, is judged from its bounds, and keeps its upside', () => {
    const p = pathwayOf(opening({ price: unknown(100, 5_000), directCost: evidence(1_000) }), null, ctx);
    expect(p.net.status).toBe('UNKNOWN');
    expect(p.net.value).toBeNull();
    expect(p.net.low!).toBeLessThan(0);
    expect(p.net.high!).toBeGreaterThan(0);
    expect(p.contribution.p90).toBeGreaterThan(0);
    expect(pathwayProblem(p)).toBeNull();
  });
});

describe('R04: established price, unknown direct cost', () => {
  it('stays ESTIMATED with a value (unchanged behaviour)', () => {
    const p = pathwayOf(opening({ price: evidence(900), directCost: unknown(50, 300) }), null, ctx);
    expect(p.net.status).toBe('ESTIMATED');
    expect(typeof p.net.value).toBe('number');
    expect(pathwayProblem(p)).toBeNull();
  });
});

describe('R05: no UNKNOWN fact states a value, whatever the shape', () => {
  const shapes: Array<[string, ModelledOpportunity]> = [
    ['production', opening()],
    ['repeatable unknown price', opening({ repeatable: true, price: unknown(5, 50), directCost: unknown(1, 10), volume: unknown(1, 500) })],
    ['inferred price', opening({ price: { ...unknown(10, 100), inferred: { tier: 'COMPARABLE', justified: false, p10: 12, p50: 40, p90: 90, observations: 1 } } })],
    ['constructed design', opening({ estimated: true }, { title: 'Constructed: a buyer kind' })],
    ['paid channel', opening({}, { reachableChannel: 'paid ads' })],
    ['no channel', opening({}, { reachableChannel: null })],
    ['unknown cash timing', opening({ daysToCash: unknown(3, 60), capital: unknown(0, 500) })],
  ];
  for (const [label, one] of shapes) {
    it(`holds for ${label}`, () => {
      const p = pathwayOf(one, null, ctx);
      for (const fact of [p.buyer, p.motivation, p.channel, p.offer, p.fulfiller, p.revenuePerDeal, p.acquisitionCost, p.fulfilmentCost, p.net, p.conversion, p.volume, p.frequency, p.daysToCash, p.capital, p.rights, p.capacity]) {
        if (fact.status === 'UNKNOWN') expect(fact.value).toBeNull();
      }
      expect(pathwayProblem(p)).toBeNull();
    });
  }
});
