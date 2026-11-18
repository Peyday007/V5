/**
 * P2, production 2026-11-18 (goal wst_7b4fcbb5f2384f31b6c3): a constructed
 * round asked every unknown part of an arrangement at once, and research
 * answered the easiest. Round cdr_4c03f5a51e57411d8f67 on the postcard
 * arrangement 2821cce3c372 (mpx_a8f5f34d435f48af9a57) asked for the slot price
 * and the run cost together and returned the run cost alone ($4,675,
 * cfa_ca236ebb), so the value stayed UNKNOWN and the goal model dropped the
 * arrangement. The next round asks one input — the one that blocks the model —
 * in the unit and wording its filer reads.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { composeInvented, inventionContext, nextInputQuestion, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { claimPricesSupply } from '../server/services/industry/expand.ts';
import { readMoneyFigures } from '../server/services/cash/figures.ts';
import { searchQueries } from '../server/services/freeLane/worker.ts';

const SIDES = {
  demand: 'Local businesses buying a slot on a shared direct-mail postcard',
  supply: 'Commercial printers and mail houses that print and enter EDDM mailings on order',
};

/** 2821cce3c372 as production composed it after the run cost was filed: value UNKNOWN, run cost one comparable. */
const POSTCARD: Pick<ConstructedArrangement, 'origin' | 'design' | 'demand' | 'need' | 'supply' | 'value' | 'unknownParts'> = {
  origin: 'FORWARD',
  design: { base: 'BROKER', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' },
  demand: { name: SIDES.demand, claimId: null, from: 'INDUSTRY_MAP', ref: 'node:buyer', path: 'BUYER_TYPE:local businesses' },
  need: null,
  supply: { name: SIDES.supply, claimId: 'clm_supply', from: 'INDUSTRY_MAP', ref: 'node:supply', path: 'SUPPLIER:commercial printers' },
  value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
  unknownParts: ['buyers', 'need_rate', 'conversion', 'value', 'supply_cost', 'supply_units', 'cost', 'fixed_cost', 'min_participants', 'prepay_share', 'repeat_rate'],
};

describe('P2: a constructed round asks the one input that blocks the arrangement', () => {
  it('asks the postcard arrangement for the slot price, in USD per slot, for its own buyers — and nothing else', () => {
    const next = nextInputQuestion(POSTCARD, 'USD');
    expect(next).not.toBeNull();
    expect(next!.part).toBe('value');
    expect(next!.factKey).toBe('price_per_unit');
    const q = next!.question;
    expect(q).toContain(`What does one buyer described as "${SIDES.demand}" pay, in USD, for one slot`);
    expect(q).toContain('‘$N per slot’');
    expect(q).toMatch(/rate cards and price lists of sellers who already sell such slots/);
    expect(q).toContain(`structural_subject price_per_unit, structural_qualifier "${SIDES.demand}"`);
    expect(q).toMatch(/asks for one figure only/);
    // One input: no run cost, no buyer count, no close rate, no position decomposition.
    expect(q).not.toMatch(/fixed cost of one shared run|how many buyers of exactly this kind|share of buyers approached|position by position/);
    // The supply's words are not in it: a slot price quoted in them would be filed as a cost (`claimPricesSupply`).
    expect(q).not.toMatch(/EDDM|printer|mail house/i);
  });

  it('an answer in the asked form is filed as these buyers’ per-slot price, not as a supply cost', () => {
    const answer = 'Local businesses pay $395 per slot on a shared direct-mail postcard mailed to 10,000 homes.';
    const figures = readMoneyFigures(answer, 'USD').filter((one) => one.cents > 0);
    expect(figures.find((one) => one.cents === 39_500)).toMatchObject({ perUnit: true, perParticipant: true });
    expect(claimPricesSupply(answer, SIDES)).toBe(false);
  });

  it('the free lane searches the buyer once, not twice', () => {
    const queries = searchQueries(nextInputQuestion(POSTCARD, 'USD')!.question, []);
    expect(queries[0]).toBe(SIDES.demand);
  });

  it('once the price is read, asks the next filed input, one at a time, in its filer’s wording', () => {
    const priced = { ...POSTCARD, value: { tier: 'COMPARABLE' as const, p10: 300, p50: 395, p90: 500, observations: 2 } };
    const conversion = nextInputQuestion(priced, 'USD')!;
    expect(conversion.part).toBe('conversion');
    expect(conversion.question).toContain('‘a close rate of N%’');
    expect(conversion.question).toContain('structural_subject account_win_rate');
    const buyers = nextInputQuestion({ ...priced, unknownParts: priced.unknownParts.filter((p) => p !== 'conversion') }, 'USD')!;
    expect(buyers.part).toBe('buyers');
    expect(buyers.question).toContain('‘There are N <buyers> in <market>’');
    const run = nextInputQuestion({ ...priced, unknownParts: ['supply_cost', 'fixed_cost', 'min_participants'] }, 'USD')!;
    // A pooled design's cost is its run: no per-deal supply cost is asked, and the run is quoted in the supplier's own words.
    expect(run.part).toBe('fixed_cost');
    expect(run.question).toContain(`"${SIDES.supply}"`);
    expect(run.question).toMatch(/total \$T/);
    // A price read but not yet justified as a distribution is asked again before the run cost.
    expect(nextInputQuestion({ ...priced, unknownParts: ['value', 'fixed_cost'] }, 'USD')!.part).toBe('value');
    // A MECHANISM value is no price these buyers pay: still the value first.
    expect(nextInputQuestion({ ...priced, value: { ...priced.value, tier: 'MECHANISM' } }, 'USD')!.part).toBe('value');
  });

  it('leaves the full question when no filed input is missing, or the arrangement has no buyer yet', () => {
    const priced = { ...POSTCARD, value: { tier: 'DIRECT' as const, p10: 300, p50: 395, p90: 500, observations: 4 } };
    expect(nextInputQuestion({ ...priced, unknownParts: ['min_participants', 'prepay_share'] }, 'USD')).toBeNull();
    expect(nextInputQuestion({ ...POSTCARD, origin: 'REVERSE' }, 'USD')).toBeNull();
  });

  it('the composer’s own question bundles the inputs; the round asks the value alone', async () => {
    const fixture = await freshProject();
    const ctx = await inventionContext({ projectId: fixture.project.id, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 22, now: new Date('2026-11-18T12:00:00.000Z') });
    const made = composeInvented({ design: POSTCARD.design, population: SIDES.demand, need: null }, ctx);
    if ('refused' in made) throw new Error(made.refused);
    expect(made.value.tier).toBe('UNKNOWN');
    // Before: one question asking the price, the run cost and the rest together.
    expect(made.question).toMatch(/what buyers of this kind are published as paying for it/);
    expect(made.question).toMatch(/the fixed cost of one shared run/);
    const next = nextInputQuestion(made, 'USD')!;
    expect(next.part).toBe('value');
    expect(next.question).toContain(`"${SIDES.demand}" pay, in USD, for one slot`);
    expect(next.question).not.toMatch(/fixed cost of one shared run/);
  });
});
