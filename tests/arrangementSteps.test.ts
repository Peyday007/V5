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
import { leadingArrangement, measuredReplyOf, planSteps, replyKill, unestimatedLead, type NextTest } from '../server/services/goals/plan.ts';
import type { Reconstruction } from '../server/services/goals/reconstruction.ts';
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
    // The step is an act, not the bare name of the missing link (production, 2026-11-19: step 12 read "an offer and a price").
    expect(before[0]!.label).toBe('Establish an offer and a price');
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
    ]);
    const [buyers, settlement, reach, supply, offer, collect, order, deliver] = steps;
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
    // The goal's generic "Establish an offer and a price" is not appended: the arrangement's offer step establishes it (production, 2026-11-19).
    expect(steps.some((s) => s.label.startsWith('Establish'))).toBe(false);
    expect(steps.every((s) => s.kill.length > 0)).toBe(true);
  });

  it('a goal step the arrangement does not establish runs beside it from day 0, listed first, the sequence renumbered behind it', () => {
    const demand: NextTest = { link: 'CURRENT_DEMAND', test: 'Find a dated sign that local businesses need postcards now.', by: 'BRAIN', blocker: null };
    const steps = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: demand, permissionsMissing: [], arrangement: { arrangement: postcard, context: { currency: 'USD', daysLeft: 30, capitalBeforeProof: 375 } } });
    expect(steps[0]).toMatchObject({ order: 1, label: 'Establish a dated sign they need it now', kind: 'RESEARCH', startDay: { low: 0, high: 0 }, cost: 0 });
    expect(steps[0]!.detail).toMatch(/^The goal's own search, run in parallel with the plan's other steps/);
    expect(steps.map((s) => s.order)).toEqual(steps.map((_, i) => i + 1));
    const reach = steps.find((s) => s.label.startsWith('Reach'))!;
    expect(reach.requires).toEqual([steps.find((s) => s.label === 'Research the buyers')!.order]);
    // A person's own decision about the goal is never dropped, whatever the arrangement establishes.
    const owner: NextTest = { ...generic, by: 'PERSON', blocker: 'the owner decides how much may be committed' };
    expect(planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: owner, permissionsMissing: [], arrangement: { arrangement: postcard, context: { currency: 'USD', daysLeft: 30, capitalBeforeProof: 375 } } })[0]!.owner).toBe('PERSON');
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

/**
 * Production, 2026-11-19 (release cb6d27b5, goals wst_7b4fcbb5f2384f31b6c3 and
 * wst_db2e2e0e5204477692d5): steps 7–11 carried no day, every cost was 0, step
 * 12 was labelled "an offer and a price", every step was [BRAIN], and a single
 * named buyer ("Artisanal Sudoku", a Substack publication that pays $50 a
 * puzzle) was to be "built into a list from a published directory".
 */
describe('a leading arrangement\'s steps can be followed on a schedule', () => {
  /** The production shape: Brain produces it, presold to a threshold, run again for a fresh group, one named buyer. */
  const sudoku = arrangement({
    key: '88ba66b2ee5c',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' },
    demand: { name: 'Artisanal Sudoku', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_as' },
    unknownParts: ['buyers', 'value', 'days_to_cash', 'cost', 'repeat_rate', 'conversion'],
  });
  const input = (value: number | null, low: number | null, high: number | null, provenance = 'EVIDENCE', inferred?: object) =>
    ({ value, low, high, provenance, source: null, note: 'test', ...(inferred ? { inferred } : {}) });
  const collect = ['QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT', 'a billing provider'];

  it('before: with no model values, no execution step pretends a day or a cost, and each says what establishes it', () => {
    const steps = arrangementSteps(sudoku, { ...ctx, collect });
    const by = (l: string) => steps.find((s) => s.label.startsWith(l))!;
    expect(by('Reach')!.startDay).toEqual({ low: 2, high: 2 });
    expect(by('Reach')!.when).toMatch(/once its research \(step 1\) has answered, about 2 days/);
    expect(by('Validate the offer')!.startDay).toEqual({ low: 2, high: 2 });
    for (const label of ['Collect payment', 'Deliver and confirm', 'Run the next group']) {
      expect(by(label).startDay).toBeNull();
      expect(by(label).when).toMatch(/days to usable cash, which Research settlement \(step \d\) establishes/);
    }
    expect(by('Deliver and confirm').detail).toMatch(/Direct cost per deal is not yet established: Research the cost per deal \(step \d\)/);
    // No cost is pretended either: a stage the model holds no cost for is unestablished (null), never 0 (production, 2026-11-19).
    expect(steps.every((s) => s.cost === null || s.cost === 0)).toBe(true);
    for (const label of ['Reach', 'Validate the offer', 'Collect payment', 'Run the next group']) expect(by(label).cost, label).toBeNull();
  });

  it('(a)(b) with the model holding days to usable cash and direct cost, every step has a day and a cost from those same values', () => {
    const modelled = {
      daysToCash: input(null, null, null, 'UNKNOWN', { justified: true, tier: 'COMPARABLE', p10: 5, p50: 7, p90: 10, observations: 2 }),
      directCost: input(40, 40, 40),
      capital: input(null, null, null, 'UNKNOWN'),
    } as unknown as ModelledOpportunity;
    const ondelivery = { ...sudoku, design: { ...sudoku.design, funding: 'ON_DELIVERY' as const, aggregation: 'SINGLE' as const }, buyerTerms: { timing: 'ARREARS' as const, basis: 'stated' } };
    const steps = arrangementSteps(ondelivery, { ...ctx, collect, modelled });
    const by = (l: string) => steps.find((s) => s.label.startsWith(l))!;
    expect(by('Validate the offer').startDay).toEqual({ low: 2, high: 2 });
    // The offer's day plus the model's 5–10 days to usable cash (estimated).
    expect(by('Collect payment')).toMatchObject({ startDay: { low: 7, high: 12 }, withinLimits: true });
    expect(by('Collect payment').when).toMatch(/day 7–12: the offer's day plus 5–10 days to usable cash \(estimated\)/);
    // Delivery falls inside days to usable cash; the model holds no separate delivery time.
    expect(by('Deliver and confirm').startDay).toEqual({ low: 2, high: 12 });
    // Brain's own direct cost, paid before an invoiced buyer pays, is money committed first, checked against the limit.
    expect(by('Deliver and confirm')).toMatchObject({ cost: 40, owner: 'PERSON', withinLimits: true });
    expect(by('Deliver and confirm').detail).toMatch(/Direct cost per deal about USD 40 \(proven\), paid before the buyer pays, inside the USD 375 allowed before proof/);
    expect(by('Run the next group').startDay).toEqual({ low: 7, high: 12 });
    // Over the limit, the step says so.
    const dear = { ...modelled, directCost: input(500, 500, 500) } as unknown as ModelledOpportunity;
    expect(arrangementSteps(ondelivery, { ...ctx, collect, modelled: dear }).find((s) => s.label === 'Deliver and confirm')).toMatchObject({ cost: 500, withinLimits: false });
    // On a presale the buyer's money pays it: nothing of the owner's is committed first, and the cost is still stated.
    const presold = arrangementSteps(sudoku, { ...ctx, collect, modelled }).find((s) => s.label === 'Deliver and confirm')!;
    expect(presold).toMatchObject({ cost: 0, startDay: { low: 7, high: 12 } });
    expect(presold.detail).toMatch(/USD 40 \(proven\), paid from the buyer's payment/);
  });

  it('(b) an order with no stress figure takes the model\'s money tied up, against the before-proof limit', () => {
    const modelled = { capital: input(450, 450, 450) } as unknown as ModelledOpportunity;
    const order = arrangementSteps({ ...subcontract, stress: { exposure: 'SAFE', worstCaseCents: null, failures: [] } }, { ...ctx, modelled }).find((s) => s.label.startsWith('Order'))!;
    expect(order).toMatchObject({ cost: 450, owner: 'PERSON', withinLimits: false });
    expect(order.detail).toMatch(/up to USD 450 paid before buyers pay \(the model's money tied up \(proven\)\), OVER the USD 375 allowed before proof/);
  });

  it('(d) a step only the owner can do is the owner\'s: a payment account to collect, a commission agreement to sign', () => {
    const steps = arrangementSteps(sudoku, { ...ctx, collect });
    expect(steps.find((s) => s.label === 'Collect payment')).toMatchObject({ owner: 'PERSON' });
    expect(steps.find((s) => s.label === 'Collect payment')!.ownerReason).toMatch(/payment account in the owner's name \(a billing provider\)/);
    // A permission alone, with the account in place, leaves collection to Brain.
    expect(arrangementSteps(sudoku, { ...ctx, collect: ['QUOTE_AND_INVOICE'] }).find((s) => s.label === 'Collect payment')).toMatchObject({ owner: 'BRAIN', ownerReason: null });
    const broker = arrangement({ design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' }, supply: { name: 'Print shops', claimId: null, from: 'INDUSTRY_MAP', ref: 'n' } });
    expect(arrangementSteps(broker, ctx).find((s) => s.label.startsWith('Get written terms'))).toMatchObject({ owner: 'PERSON', ownerReason: "a commission agreement signed in the owner's name" });
    expect(arrangementSteps(subcontract, ctx).find((s) => s.label.startsWith('Get written terms'))).toMatchObject({ owner: 'BRAIN' });
  });

  it('(e) one named organisation is contacted at its own address, never "built into a list" or counted', () => {
    const steps = arrangementSteps(sudoku, ctx);
    expect(steps[0]!.question).toMatch(/who at "Artisanal Sudoku" decides this purchase/);
    expect(steps[0]!.question).not.toMatch(/how many buyers of exactly this kind exist/);
    const reach = steps.find((s) => s.label.startsWith('Reach'))!;
    expect(reach.detail).toMatch(/^Contact "Artisanal Sudoku" directly at its published address/);
    expect(reach.detail).not.toMatch(/Build the list/);
    // A population is still listed.
    expect(arrangementSteps(postcard, ctx).find((s) => s.label.startsWith('Reach'))!.detail).toMatch(/^Build the list of "Local businesses"/);
  });

  it('planSteps keeps an arrangement\'s own sequence when its steps have days', () => {
    const steps = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: generic, permissionsMissing: ['CONTACT_BUYER', ...collect], arrangement: { arrangement: sudoku, context: { currency: 'USD', daysLeft: 59, capitalBeforeProof: 375 } } });
    const reach = steps.find((s) => s.label.startsWith('Reach'))!;
    const offer = steps.find((s) => s.label.startsWith('Validate'))!;
    expect(reach.dependsOn).toBeNull();
    expect(offer.dependsOn).toBe(reach.order);
    // The arrangement's own research and offer establish the offer and its price: no trailing "Establish an offer and a price".
    expect(steps.at(-1)!.label).toBe('Run the next group');
    expect(steps.some((s) => s.label === 'Establish an offer and a price')).toBe(false);
  });
});

/**
 * Transfer test, 2026-11-19 (goals wst_fa4761773e4441b89e5a,
 * wst_4f0c312400e1425dab2e): a presale to buyers stated to pay in arrears, a
 * plan whose cash lands after a 14-day window scheduled as if it settled, a
 * plan that spent none of the USD 25,000 allowed without saying so, and a
 * reply kill criterion that printed a reach as a reply rate.
 */
describe('steps agree with the settlement terms, the window, the capital and the measured record', () => {
  const va = arrangement({
    key: '84d346f614da',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' },
    demand: { name: 'state veterans agencies', claimId: null, from: 'INDUSTRY_MAP', ref: 'n_va' },
    buyerTerms: { timing: 'ARREARS', basis: 'map node names a competitive award ("procurement"): paid after it is won and the work delivered' },
  });

  it('(2) a presale over buyers who pay in arrears says so, validates it first, and schedules no settlement', () => {
    const steps = arrangementSteps(va, { ...ctx, daysLeft: 14 });
    expect(steps[0]!.detail).toMatch(/^This arrangement contradicts its buyers' terms: it presells, but "state veterans agencies" are stated to pay in arrears/);
    const offer = steps.find((s) => s.label.startsWith('Validate the offer'))!;
    expect(offer.kind).toBe('VALIDATE');
    expect(offer.question).toMatch(/will they pay before delivery, against their stated terms/);
    const collect = steps.find((s) => s.label === 'Collect payment')!;
    expect(collect).toMatchObject({ startDay: null, basis: 'ASSUMPTION' });
    expect(collect.when).toMatch(/^not scheduled: the design presells, but "state veterans agencies" are stated to pay in arrears.*step \d+\) shows they will pay in advance/);
    expect(steps.find((s) => s.label === 'Run the next group')!.startDay).toBeNull();
  });

  it('(2) the simulation\'s own days to usable cash schedule the steps as an assumption, and a plan that cannot settle in the window is not scheduled', () => {
    const population = { ...va, buyerTerms: undefined, design: { ...va.design, funding: 'ON_DELIVERY' as const } };
    // Inside the window: scheduled from the days the plan was scored on, labelled as the simulation's assumption.
    const inside = arrangementSteps(population, { ...ctx, daysLeft: 30, simulatedDays: { p10: 5, p50: 9, p90: 20 } });
    const collect = inside.find((s) => s.label === 'Collect payment')!;
    expect(collect).toMatchObject({ startDay: { low: 5, high: 20 }, basis: 'ASSUMPTION', withinLimits: true });
    expect(collect.when).toMatch(/swept by the plan's simulation: an assumption, not established/);
    // The production shape: days p50 31 against 14 days left.
    const late = arrangementSteps(population, { ...ctx, daysLeft: 14, simulatedDays: { p10: 20, p50: 31, p90: 45 } });
    expect(late[0]!.detail).toMatch(/^This arrangement cannot settle inside the deadline: cash is usable on day 20–45 at the soonest .* after the 14 days left/);
    for (const label of ['Collect payment', 'Deliver and confirm', 'Run the next group']) {
      const step = late.find((s) => s.label === label)!;
      expect(step.startDay, label).toBeNull();
      expect(step.when, label).toMatch(/not scheduled: cash would be usable on day 20–45 .* after the 14 days left/);
    }
    expect(late.find((s) => s.label === 'Collect payment')!.withinLimits).toBe(false);
  });

  it('(3) the steps state the capital the plan deploys against what the goal allows', () => {
    const steps = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: generic, permissionsMissing: [], capital: { allowed: 25_000, currency: 'USD' } });
    expect(steps[0]!.detail).toMatch(/^This plan commits USD 0 of the USD 25,000 the goal allows: none of its steps spends money\./);
    const withOrder = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: generic, permissionsMissing: [], arrangement: { arrangement: subcontract, context: { currency: 'USD', daysLeft: 90, capitalBeforeProof: 375 } }, capital: { allowed: 375, currency: 'USD' } });
    expect(withOrder[0]!.detail).toMatch(/^This plan commits USD 600 of the USD 375 the goal allows, plus \d+ step\(s\) whose cost the model does not establish — OVER the limit\./);
  });

  it('a reply kill criterion compares a reply rate with the measured reply rate, never with a reach', () => {
    const r = { requiredReply: null, required: 0.9, floor: { reach: 0.056 } } as unknown as Reconstruction;
    const measured = measuredReplyOf({ measuredRates: { sent: 4_970, replies: 35, opportunities: 5, bounced: 0, low: 0.0011, high: 0.007 } as never });
    const kill = replyKill(r, measured);
    expect(kill).not.toMatch(/5\.6%/);
    expect(kill).toMatch(/^reply rate under 0\.11% after 5,000 sends, the low end of the measured record \(the measured record is 0\.11%–0\.7% over 4,970 sends\)/);
    expect(replyKill(r, null)).toMatch(/an assumption: no reply rate has been measured for this outreach/);
    const needs = replyKill({ ...r, requiredReply: 0.02 } as Reconstruction, measured);
    expect(needs).toMatch(/reply rate under 2% after 500 sends .*the plan needs 2% .*the measured record is 0\.11%–0\.7% over 4,970 sends/);
  });

  it('(1) one named organisation never leads: it is its opening\'s buyer, not a population', () => {
    const one = arrangement({ key: 'one', demand: { name: 'St Louis Development Corporation', claimId: null, from: 'INDUSTRY_MAP', ref: 'n' } });
    // Nor does another arrangement stand in for it: the steps are the lead's own or none (goal wst_7b4f, 2026-11-19).
    expect(leadingArrangement([one, postcard], { portfolio: null, candidateIds: ['arr_one'] })).toBeNull();
    expect(leadingArrangement([one, postcard], { portfolio: null })!.key).toBe('postcard-pool');
    expect(leadingArrangement([one], { portfolio: null })).toBeNull();
  });
});
