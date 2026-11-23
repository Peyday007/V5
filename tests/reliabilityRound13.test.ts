/**
 * planningReliability round 13.
 *
 * - A counted market already holds the buyers who agreed: two signed of
 *   exactly two leaves none to ask, so agreed money is never counted again as
 *   fresh buyers (`buyersLeft`, `bestCaseReach`).
 * - A measured ceiling is not a search gap (§65, §95): when every held opening
 *   is bounded by a market research counted whole, or by the goal's own
 *   capital and deadline, and together they fall short even with every buyer
 *   agreeing, the goal is infeasible on what is held, the conclusion names the
 *   target to lower to (and the capital or deadline that would reach it), and
 *   the search for openings outside those markets continues. An unmeasured
 *   opening keeps the §65 behaviour: no conclusion.
 * - Agreed money whose settlement is unknown needs no sale, so the goal is not
 *   out of reach by arithmetic when it alone covers the target.
 * - An exact price stated 16% from the card is a second figure, not the card's
 *   restated: only a hedged or rounded figure sits the full ratio away.
 * - A quoted supplier is never the buyer, and a fulfiller is read without its
 *   description ("the owner's former employer").
 * - "Landscape designers" buy design work; landscaping is the physical service.
 * - A count may carry an ampersand: "12 B&B owners" counts buyers.
 */
import { describe, expect, it } from 'vitest';
import { agreedInReach, continuationOf, heldCeiling, judgeHeldMarkets } from '../server/services/goals/plan.ts';
import { bestCaseReach, buyersLeft, priceContradiction, type ModelInput, type ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { namesThePayer } from '../server/services/goals/pathways.ts';
import { operatingFit } from '../server/domain/operatingModel.ts';
import { readVolume } from '../server/services/cash/volume.ts';

const fact = (value: number | null, provenance: ModelInput['provenance'] = 'EVIDENCE'): ModelInput =>
  ({ value, low: value, high: value, provenance, source: null, note: '' }) as ModelInput;

function opening(over: {
  price?: number | null;
  cost?: number;
  capital?: number;
  days?: number | null;
  agreed?: number[];
  volume?: number | null;
  counted?: boolean;
  repeatable?: boolean;
}): ModelledOpportunity {
  const agreed = over.agreed ?? [];
  const repeatable = over.repeatable ?? over.volume !== undefined;
  const volume = over.volume ?? null;
  return {
    opportunity: { id: `cop_${Math.random().toString(36).slice(2)}`, title: 'A workbook', expiresAt: null } as unknown as ModelledOpportunity['opportunity'],
    index: 0,
    repeatable,
    price: fact(over.price === undefined ? 1000 : over.price, over.price === null ? 'UNKNOWN' : 'EVIDENCE'),
    directCost: fact(over.cost ?? 0),
    capital: fact(over.capital ?? 0),
    daysToCash: over.days === null ? fact(null, 'UNKNOWN') : fact(over.days ?? 10),
    hours: fact(1),
    volume: volume === null ? fact(repeatable ? null : 1, repeatable ? 'UNKNOWN' : 'ASSUMPTION') : fact(volume),
    prospects: repeatable && volume !== null && over.counted !== false ? volume : null,
    agreed: agreed.length > 0,
    agreedValue: agreed.reduce((a, b) => a + b, 0),
    agreedDeals: agreed.length,
    competitiveAward: false,
  } as unknown as ModelledOpportunity;
}

describe('buyersLeft: the agreements are part of a counted market', () => {
  it('leaves nobody to ask when every counted buyer signed', () => {
    const one = opening({ price: 2400, agreed: [2400, 2400], volume: 2 });
    expect(buyersLeft(one)).toBe(0);
    // Before: 2 agreed + 2 "fresh" = $9,600 read as reachable against a $5,050 target.
    expect(bestCaseReach(one, 5050, 105, true)).toBe(4800);
  });
  it('reads an order rate whole: it counts deals, not buyers', () => {
    expect(buyersLeft(opening({ agreed: [1000], volume: 5, counted: false }))).toBe(5);
  });
});

describe('judgeHeldMarkets: a measured ceiling, not a short pool', () => {
  const limits = { daysLeft: 60, capitalCeiling: null };
  it('names TARGET when the whole counted market falls short', () => {
    const c = judgeHeldMarkets({ openings: [opening({ price: 180, volume: 12 })], remaining: 3100, net: false, limits, required: 0.9 });
    expect(c?.relax.map((r) => r.constraint)).toEqual(['TARGET']);
    expect(c?.relax[0]!.suggestion).toContain('$2,160');
    expect(c?.heldMarkets).toBe(true);
  });
  it('reads a net target net of direct costs', () => {
    const one = opening({ price: 6000, cost: 4010, agreed: [6000, 6000, 6000, 6000, 6000, 6000], volume: 6 });
    expect(judgeHeldMarkets({ openings: [one], remaining: 15600, net: true, limits, required: 0.9 })?.relax[0]!.constraint).toBe('TARGET');
    expect(judgeHeldMarkets({ openings: [one], remaining: 15600, net: false, limits, required: 0.9 })).toBeNull();
  });
  it('draws no conclusion while any opening is unmeasured (§65)', () => {
    const counted = opening({ price: 180, volume: 12 });
    expect(judgeHeldMarkets({ openings: [counted, opening({ price: 500, volume: null })], remaining: 3100, net: false, limits, required: 0.9 })).toBeNull();
    expect(judgeHeldMarkets({ openings: [counted, opening({ price: 500 })], remaining: 3100, net: false, limits, required: 0.9 })).toBeNull();
    expect(judgeHeldMarkets({ openings: [opening({ price: null, volume: 12 })], remaining: 3100, net: false, limits, required: 0.9 })).toBeNull();
    expect(judgeHeldMarkets({ openings: [opening({ price: 180, volume: 12, counted: false })], remaining: 3100, net: false, limits, required: 0.9 })).toBeNull();
    // A contested price is not a measurement: the lots it prices bound nothing.
    const contested = opening({ price: 3750, cost: 2050, capital: 6335, days: 22 });
    (contested.price as ModelInput) = { value: null, low: 2300, high: 3750, provenance: 'ASSUMPTION', source: null, note: 'contested' } as ModelInput;
    expect(heldCeiling(contested, true, { daysLeft: 60, capitalCeiling: 7000 })).toBeNull();
  });
  it('names the capital and the deadline that would reach it when the limits bind', () => {
    const lots = opening({ price: 7000, cost: 4200, capital: 4200, days: 15, agreed: [7000, 7000] });
    expect(heldCeiling(lots, false, { daysLeft: 27, capitalCeiling: 5400 })).toBe(7000);
    expect(heldCeiling(lots, false, null)).toBeNull();
    const c = judgeHeldMarkets({ openings: [lots], remaining: 8400, net: false, limits: { daysLeft: 27, capitalCeiling: 5400 }, required: 0.9 });
    expect(c?.relax.map((r) => r.constraint)).toEqual(['CAPITAL', 'DEADLINE', 'TARGET']);
    expect(c?.relax[0]!.suggestion).toContain('$8,400');
    expect(c?.relax[1]!.suggestion).toContain('30 days');
  });
  it('a lot over the ceiling or settling after the deadline brings nothing', () => {
    expect(heldCeiling(opening({ capital: 4700, agreed: [8000] }), false, { daysLeft: 54, capitalCeiling: 2850 })).toBe(0);
    expect(heldCeiling(opening({ days: 70, agreed: [8000] }), false, { daysLeft: 54, capitalCeiling: null })).toBe(0);
  });
  it('keeps the search for other openings going', () => {
    const c = continuationOf({ achieved: false, daysLeft: 30, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: 'NOT_SUPPORTED', heldMarkets: true });
    expect(c.continues).toBe(true);
    expect(continuationOf({ achieved: false, daysLeft: 30, outcomeRecorded: false, policy: 'SQUEEZE', acceptance: 'NOT_SUPPORTED' }).continues).toBe(false);
  });
});

describe('agreedInReach: agreed money needs no sale', () => {
  it('counts agreements whose settlement is unknown or inside the window', () => {
    expect(agreedInReach([opening({ days: null, agreed: [2600, 2600, 2600, 2600, 2600] }), opening({ days: 2, agreed: [600] })], 8, false)).toBe(13600);
    expect(agreedInReach([opening({ days: 20, agreed: [2600] })], 8, false)).toBe(0);
  });
});

describe('priceContradiction: an exact second figure is a second price', () => {
  it('contests a card 16% from an exact figure, either way', () => {
    expect(priceContradiction(1350, '$1,570', 'USD')?.stated).toBe(1570);
    expect(priceContradiction(1570, '$1,350', 'USD')?.stated).toBe(1350);
  });
  it('still reads a rounded or hedged figure as the card restated', () => {
    expect(priceContradiction(950, '$1,000', 'USD')).toBeNull();
    expect(priceContradiction(900, 'about $1,050 a project', 'USD')).toBeNull();
    expect(priceContradiction(1000, '$1,000', 'USD')).toBeNull();
    expect(priceContradiction(1020, '$1,000', 'USD')).toBeNull();
  });
});

describe('namesThePayer: a quoted party and its description', () => {
  it('reads a quoted supplier as a supplier, whatever its name shares with the buyers', () => {
    expect(namesThePayer('Ridgeway Anglers (seller quote)', 'Fly-fishing anglers')).toBe(false);
  });
  it('reads the party without its description', () => {
    expect(namesThePayer('Harbor Freight Lines (the owner\'s former employer)', 'Pottery studio owners')).toBe(false);
  });
  it('still reads the buyers named as fulfiller as the buyer', () => {
    expect(namesThePayer('the studio owners themselves', 'Pottery studio owners')).toBe(true);
  });
});

describe('operatingFit: landscape designers are buyers, landscaping is work', () => {
  it('does not read design work for landscape designers as physical', () => {
    expect(operatingFit({ title: 'Pricing review sessions for landscape architects', fulfillmentOwner: 'The owner, personally' }).kind).not.toBe('OWNER_PHYSICAL');
  });
  it('still reads landscaping as a physical service', () => {
    expect(operatingFit({ title: 'Weekly landscaping for office parks', fulfillmentOwner: 'The owner, personally' }).kind).toBe('OWNER_PHYSICAL');
    expect(operatingFit({ title: 'Landscape maintenance for HOAs', fulfillmentOwner: 'The owner, personally' }).kind).toBe('OWNER_PHYSICAL');
  });
});

describe('readVolume: a count whose words carry an ampersand', () => {
  it('counts "B&B owners" as buyers', () => {
    expect(readVolume('Exactly 9 B&B owners operate in the county; each buys at most one this season.', 60, 'B&B owners', 'bed-and-breakfast inns')?.buyers).toBe(9);
  });
});
