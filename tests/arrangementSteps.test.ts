/**
 * Production, 2026-11-18 (goal wst_7b4fcbb5f2384f31b6c3): the plan's leading
 * candidate was a constructed arrangement, and its `steps` were one generic
 * line — "Discover, construct and research openings…" — with no execution.
 * A leading arrangement's known structure is now the plan's steps: who to
 * reach and how, supply and from whom, the offer and price, settlement and
 * timing against the limits, and kill criteria; every unknown part stays an
 * explicit research or validation step with its own question.
 */
import { describe, expect, it } from 'vitest';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import type { ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { arrangementSteps } from '../server/services/goals/arrangementSteps.ts';
import { leadingArrangement, planSteps, unestimatedLead, type NextTest } from '../server/services/goals/plan.ts';
import type { GoalPortfolio } from '../server/services/goals/portfolio.ts';

function arrangement(over: Partial<ConstructedArrangement>): ConstructedArrangement {
  return {
    key: 'k',
    structure: 'POOL',
    design: { base: 'POOL', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'ONE_OFF' },
    origin: 'FORWARD',
    precedent: null,
    sector: null,
    demand: { name: 'Local businesses', claimId: null, from: 'INDUSTRY_MAP', ref: 'n1' },
    need: null,
    supply: null,
    label: 'arrangement',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] },
    evidenced: 0,
    value: { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts: [],
    relatedOpenings: [],
    question: '',
    ...over,
  } as ConstructedArrangement;
}

/** The production shape: a pooled postcard presale, printers supplying, local businesses buying a slot. */
const postcard = arrangement({
  key: 'postcard-pool',
  label: 'Local businesses — shared direct-mail postcard: pool several buyers’ purchases with one supplier, presold',
  demand: { name: 'Local businesses', claimId: 'clm_1', from: 'INDUSTRY_MAP', ref: 'n_local' },
  need: { name: 'reaching households nearby', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_need' },
  supply: { name: 'Commercial printers', claimId: 'clm_2', from: 'INDUSTRY_MAP', ref: 'n_print' },
  stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] },
  value: { tier: 'COMPARABLE', p10: 150, p50: 250, p90: 400, observations: 4, perParticipant: true },
  fixedCost: { tier: 'COMPARABLE', p10: 900, p50: 1_400, p90: 2_200, observations: 3, sources: ['claim:c1'] },
  unknownParts: ['buyers', 'conversion', 'min_participants', 'prepay_share', 'refund_terms'],
});

/** A non-pooled design: own the buyer, pay a supplier per deal, invoiced on delivery. */
const subcontract = arrangement({
  key: 'bookkeeping-sub',
  structure: 'SUBCONTRACT',
  design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' },
  demand: { name: 'Dental practices', claimId: 'clm_3', from: 'INDUSTRY_MAP', ref: 'n_dent' },
  need: { name: 'monthly bookkeeping', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_book' },
  supply: { name: 'Freelance bookkeepers', claimId: 'clm_4', from: 'INDUSTRY_MAP', ref: 'n_bk' },
  stress: { exposure: 'EXCEEDS', worstCaseCents: 60_000, failures: [] },
  value: { tier: 'COMPARABLE', p10: 400, p50: 600, p90: 900, observations: 5 },
  conversion: { tier: 'COMPARABLE', p10: 0.02, p50: 0.04, p90: 0.07, observations: 3, sources: ['claim:c9'] },
  buyerTerms: { timing: 'ARREARS', basis: 'net-30 stated on the practices\' published terms' },
  unknownParts: ['supply_cost', 'repeat_rate'],
});

const ctx = { currency: 'USD', daysLeft: 30, capitalBeforeProof: 375, send: ['CONTACT_BUYER'], collect: ['QUOTE_AND_INVOICE'] };
const generic: NextTest = {
  link: 'OFFER_AND_PRICE',
  test: 'Discover, construct and research openings that can reach the 10000 USD still needed — the openings held reach at most 3249 USD — and establish each one\'s buyer, price, fulfilment, costs and settlement so the quant engine can combine them.',
  by: 'BRAIN',
  blocker: null,
};
const baseline = { source: 'BASELINE' as const, hypothetical: true, reason: 'does not beat the plan as held' };

describe('a leading arrangement becomes executable steps', () => {
  it('before: with no arrangement, the plan is one generic step and nothing to execute', () => {
    const before = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: generic, permissionsMissing: ['CONTACT_BUYER'] });
    expect(before).toHaveLength(1);
    expect(before[0]!.label).toBe('an offer and a price');
    expect(before[0]!.execution).toEqual([]);
  });

  it('the pooled postcard presale: buyers, printers, a presold slot, settlement before the order, kill criteria', () => {
    const steps = planSteps({
      adoption: baseline,
      reconstruction: null,
      sales: [],
      nextTest: generic,
      permissionsMissing: ['CONTACT_BUYER', 'QUOTE_AND_INVOICE'],
      arrangement: { arrangement: postcard, context: { currency: 'USD', daysLeft: 30, capitalBeforeProof: 375 } },
    });
    expect(steps.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'RESEARCH:Research the buyers',
      'RESEARCH:Research settlement',
      'EXECUTE:Reach Local businesses',
      'EXECUTE:Get written terms from Commercial printers',
      'VALIDATE:Validate the offer with Local businesses',
      'EXECUTE:Collect payment',
      'EXECUTE:Order the run from Commercial printers',
      'EXECUTE:Deliver and confirm',
      'RESEARCH:an offer and a price',
    ]);
    const [buyers, settlement, reach, supply, offer, collect, order, deliver, search] = steps;
    // Unknown parts are questions, each with its own words.
    expect(buyers!.question).toMatch(/how many buyers of exactly this kind exist/);
    expect(buyers!.question).toMatch(/how many buyers must join one shared run/);
    expect(settlement!.question).toMatch(/paying before delivery/);
    expect(settlement!.question).toMatch(/refunded if the run does not happen/);
    // Execution follows the research it needs, in order.
    expect(reach).toMatchObject({ dependsOn: null, requires: [buyers!.order], execution: ['CONTACT_BUYER'] });
    expect(supply!.detail).toMatch(/"Commercial printers".*price for one shared run/);
    expect(supply!.detail).toMatch(/USD 900–2,200/);
    expect(offer).toMatchObject({ dependsOn: supply!.order, basis: 'ASSUMPTION' });
    expect(offer!.detail).toMatch(/USD 150–400 per slot in a shared run, as a presale/);
    expect(offer!.question).toMatch(/what share of buyers approached/);
    expect(offer!.kill).toMatch(/minimum participants.*refund every buyer/);
    // A presale settles before the order, so the order ties up none of the owner's money.
    expect(collect!.order).toBeLessThan(order!.order);
    expect(collect!.execution).toEqual(['QUOTE_AND_INVOICE']);
    expect(collect!.detail).toMatch(/not yet established/);
    expect(order).toMatchObject({ cost: 0, owner: 'PERSON', withinLimits: true });
    expect(deliver!.detail).toMatch(/"Commercial printers" delivers/);
    // The goal's own search keeps running beside it.
    expect(search).toMatchObject({ kind: 'RESEARCH', dependsOn: null, startDay: { low: 0, high: 0 } });
    expect(steps.every((s) => s.kill.length > 0)).toBe(true);
  });

  it('a non-pooled subcontract: invoiced on delivery, the order over the before-proof limit, cash timing against the deadline', () => {
    const modelled = { daysToCash: { value: 35, low: 35, high: 35, provenance: 'EVIDENCE', source: null, note: 'net-30 after delivery' } } as unknown as ModelledOpportunity;
    const steps = arrangementSteps(subcontract, { ...ctx, modelled });
    expect(steps.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'RESEARCH:Research the supply',
      'RESEARCH:Research repeat purchases',
      'EXECUTE:Reach Dental practices',
      'EXECUTE:Get written terms from Freelance bookkeepers',
      'EXECUTE:Offer it to Dental practices',
      'EXECUTE:Order the work from Freelance bookkeepers',
      'EXECUTE:Deliver and confirm',
      'EXECUTE:Collect payment',
      'EXECUTE:Renew',
    ]);
    const byLabel = (l: string) => steps.find((s) => s.label.startsWith(l))!;
    expect(byLabel('Research the supply').question).toMatch(/"Freelance bookkeepers" supplying "Dental practices".*what the supplier is published as charging/);
    // Conversion is published for these buyers: the offer executes, and its kill is the published low end.
    expect(byLabel('Offer it').kill).toMatch(/fewer than 2% of the first 200 approached agree/);
    expect(byLabel('Offer it').detail).toMatch(/USD 400–900 per unit, paid on delivery/);
    // Money paid out first is the owner's, and this one breaks the before-proof limit.
    expect(byLabel('Order the work')).toMatchObject({ cost: 600, owner: 'PERSON', withinLimits: false });
    expect(byLabel('Order the work').detail).toMatch(/OVER the USD 375 allowed before proof/);
    // Settlement is read from the evidence, and it lands outside the window.
    expect(byLabel('Collect payment')).toMatchObject({ withinLimits: false });
    expect(byLabel('Collect payment').detail).toMatch(/in arrears.*35–35 days after agreement \(proven\), OUTSIDE the 30 days left/);
    expect(byLabel('Renew').requires).toEqual([byLabel('Research repeat purchases').order]);
  });

  it('a settlement nothing states is a research question, never assumed prepaid', () => {
    const steps = arrangementSteps({ ...subcontract, buyerTerms: undefined, unknownParts: [] }, ctx);
    expect(steps[0]).toMatchObject({ kind: 'RESEARCH', label: 'Research settlement' });
    expect(steps[0]!.question).toMatch(/days from agreement to money/);
  });

  it('leads with the arrangement the candidate or best combination holds, then the largest contributor', () => {
    const portfolio = { best: { members: [{ opportunityId: 'arr_bookkeeping-sub' }] }, demand: [] } as unknown as GoalPortfolio;
    expect(leadingArrangement([postcard, subcontract], { portfolio, candidateIds: [] })!.key).toBe('bookkeeping-sub');
    expect(leadingArrangement([postcard, subcontract], { portfolio, candidateIds: ['opp_1', 'arr_postcard-pool'] })!.key).toBe('postcard-pool');
    const demand = { best: null, demand: [{ opportunityId: 'arr_bookkeeping-sub', refused: false, revenue: { p50: 5_000 } }, { opportunityId: 'arr_postcard-pool', refused: false, revenue: { p50: 8_000 } }] } as unknown as GoalPortfolio;
    expect(leadingArrangement([subcontract, postcard], { portfolio: demand })!.key).toBe('postcard-pool');
    expect(leadingArrangement([], { portfolio: null })).toBeNull();
  });

  it('a lead nothing estimated says so on its first step: it is not presented as an estimated plan (production, 2026-11-18: 0 of 208 estimated)', () => {
    // Nothing estimated: construction's first rank leads, and the reading says that is all it is.
    expect(leadingArrangement([postcard, subcontract], { portfolio: null })!.key).toBe('postcard-pool');
    const none = unestimatedLead(postcard, 208, new Map());
    expect(none).toMatch(/^Not an estimated plan: none of the 208 constructed arrangement\(s\) could be estimated/);
    const steps = arrangementSteps(postcard, { ...ctx, unestimated: none });
    expect(steps[0]!.detail.startsWith(none!)).toBe(true);
    expect(steps.slice(1).every((s) => !s.detail.includes('Not an estimated plan'))).toBe(true);
    // Another arrangement estimated, this one not.
    expect(unestimatedLead(postcard, 208, new Map([['bookkeeping-sub', {}]]))).toMatch(/this arrangement holds no estimate/);
    // An estimated lead reads as before.
    expect(unestimatedLead(postcard, 208, new Map([['postcard-pool', {}]]))).toBeNull();
    expect(arrangementSteps(postcard, { ...ctx, unestimated: null })[0]!.detail).toBe(arrangementSteps(postcard, ctx)[0]!.detail);
  });
});
