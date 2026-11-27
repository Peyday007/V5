/**
 * Regressions for the app-session plan checker (server/domain/sessionPlanning.ts `checkRevision`) found in the
 * 2026-11-26 held-out evaluation: a step's cost omitted from the ledger, owner hours beyond the goal's allowance,
 * a delivery given to someone other than the opening's recorded fulfiller, and a capability record that was absent.
 * And the grader reading the same records (bench/planningReliability/session.ts).
 */
import { describe, expect, it } from 'vitest';
import { cashTrace, checkRevision, conditionProblems, contractDigest, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';
import { observeSession } from '../bench/planningReliability/session.ts';
import { grade } from '../bench/planningReliability/grade.ts';
import { PUBLIC_CASES } from '../bench/planningReliability/cases.ts';

const terms = {
  targetCents: 1_000_000, currency: 'USD', metric: 'COLLECTED_CASH', windowDays: 28,
  totalSpendCapCents: 200_000, preProofSpendCapCents: null, exposureCapCents: 200_000,
  proofCondition: 'two paid orders', ownerHoursPerWeek: 0, ownerPhysicalWork: 'FORBIDDEN' as const,
  exclusions: [], evidenceExclusions: [],
};
const contract: GoalContract = { goalId: 'g', words: 'w', source: { kind: 'OWNER_MESSAGE', ref: 'r', at: '2026-11-27' }, terms: terms as never, explanations: {}, version: 1, digest: contractDigest({ goalId: 'g', words: 'w', terms: terms as never }) };
const CAPS = [{ id: 'SEND_EMAIL', state: 'PRESENT' }];
const exec = (operation: string, performedBy: 'BRAIN' | 'PROVIDER' | 'OWNER', capabilities = CAPS) => ({ operation, performedBy, provider: null, capabilities, routine: true });
const brain = (over: Partial<BrainFacts> = {}): BrainFacts => ({ admittedOpportunityIds: ['o1'], integrity: [], completed: true, error: null, fulfilment: { o1: { by: 'BRAIN', name: null, capability: 'PRODUCE_SPREADSHEET', capabilityState: 'PRESENT' } }, hoursCeiling: null, ...over });

function plan(over: Partial<PlanRevisionInput> = {}): PlanRevisionInput {
  return {
    goalId: 'g', contractDigest: contract.digest, parentRevisionId: null, stance: 'EXECUTABLE',
    strategy: { title: 's', opportunityIds: ['o1'], why: 'w' }, alternatives: [],
    steps: [
      { id: 'reach', kind: 'REACH', label: 'email buyers', performer: 'BRAIN', costCents: 10_000, day: 1, dependsOn: null, evidence: ['q'], executor: exec('REACH_BUYERS', 'BRAIN') },
      { id: 'collect', kind: 'COLLECT', label: 'collect', performer: 'BRAIN', costCents: 0, day: 5, dependsOn: 'reach', evidence: ['q'], executor: exec('COLLECT_PAYMENT', 'BRAIN') },
      { id: 'deliver', kind: 'DELIVER', label: 'Brain produces it', performer: 'BRAIN', costCents: 20_000, day: 6, dependsOn: 'collect', evidence: ['q'], executor: exec('BRAIN_PRODUCES', 'BRAIN', [{ id: 'PRODUCE_SPREADSHEET', state: 'PRESENT' }]) },
    ],
    cash: [
      { day: 1, kind: 'SPEND', amountCents: 10_000, label: 'list', stepId: 'reach' },
      { day: 5, kind: 'RECEIPT', amountCents: 1_100_000, label: 'orders', settlesDay: 6 },
      { day: 6, kind: 'SPEND', amountCents: 20_000, label: 'delivery', stepId: 'deliver' },
    ],
    proofDay: null, quantities: [], sources: [], validation: null, noPlan: null, reach: null, answers: [],
    ...over,
  };
}
const codes = (r: PlanRevisionInput, b: BrainFacts = brain()) => checkRevision(contract, r, b, '2026-11-27').map((p) => p.code);

describe('every step cost and obligation reconciles to the cash ledger', () => {
  it('passes a plan whose costed steps are each paid exactly by their linked outflows', () => {
    expect(codes(plan())).toEqual([]);
  });

  it('refuses a $100,000 delivery step against a $2,000 budget when its cost is omitted from cash (regression)', () => {
    const r = plan();
    r.steps[2] = { ...r.steps[2]!, costCents: 10_000_000 };
    r.cash = r.cash.filter((e) => e.stepId !== 'deliver');
    const c = codes(r);
    expect(c).toContain('STEP_COST_UNRECONCILED');
    expect(c).toContain('TOTAL_SPEND_OVER');
  });

  it('refuses a cost counted twice, a commitment linked to no step, and an outflow naming a step that does not exist', () => {
    expect(codes(plan({ cash: [...plan().cash, { day: 7, kind: 'SPEND', amountCents: 20_000, label: 'delivery again', stepId: 'deliver' }] }))).toContain('STEP_COST_UNRECONCILED');
    expect(codes(plan({ cash: [...plan().cash, { day: 2, kind: 'COMMIT', amountCents: 5_000, label: 'revision allowance' }] }))).toContain('CASH_UNLINKED');
    expect(codes(plan({ cash: [...plan().cash, { day: 2, kind: 'COMMIT', amountCents: 5_000, label: 'x', stepId: 'nope' }] }))).toContain('CASH_UNLINKED');
  });

  it('accepts a commitment released and paid against the same step as one obligation', () => {
    const r = plan({ cash: [
      { day: 1, kind: 'SPEND', amountCents: 10_000, label: 'list', stepId: 'reach' },
      { day: 2, kind: 'COMMIT', amountCents: 20_000, label: 'delivery booked', stepId: 'deliver' },
      { day: 5, kind: 'RECEIPT', amountCents: 1_100_000, label: 'orders', settlesDay: 6 },
      { day: 6, kind: 'RELEASE', amountCents: 20_000, label: 'booking settled', stepId: 'deliver' },
      { day: 6, kind: 'SPEND', amountCents: 20_000, label: 'delivery paid', stepId: 'deliver' },
    ] });
    expect(codes(r)).not.toContain('STEP_COST_UNRECONCILED');
  });
});

describe("the owner's own float is funding, never revenue (2026-11-27 run, world f10)", () => {
  const open = { ...terms, totalSpendCapCents: null, exposureCapCents: null };
  const c2: GoalContract = { ...contract, terms: open as never, digest: contractDigest({ goalId: 'g', words: 'w', terms: open as never }) };
  const floatPlan = (cash: PlanRevisionInput['cash']) => plan({ contractDigest: c2.digest, cash, steps: plan().steps.map((s) => ({ ...s, costCents: s.id === 'deliver' ? 6_000 : 0 })) });
  const delivery = { day: 5, kind: 'SPEND' as const, amountCents: 6_000, label: 'reports', stepId: 'deliver' };
  const sales = { day: 6, kind: 'RECEIPT' as const, amountCents: 480_000, label: 'three courses', settlesDay: 15 };

  it('a cost paid before receipts settle is a shortfall when nothing funds it', () => {
    expect(checkRevision(c2, floatPlan([delivery, sales]), brain(), '2026-11-27').map((p) => p.code)).toContain('CASH_SHORTFALL');
  });

  it('a stated owner float covers it, and collected cash and net stay the customers\' money alone', () => {
    const r = floatPlan([{ day: 1, kind: 'FUNDING', amountCents: 6_000, label: 'owner float' }, delivery, sales]);
    expect(checkRevision(c2, r, brain(), '2026-11-27').map((p) => p.code)).not.toContain('CASH_SHORTFALL');
    const t = cashTrace(r, open);
    expect(t.collectedCents).toBe(480_000);
    expect(t.refundsCents).toBe(0);
    expect(t.ownerFundedCents).toBe(6_000);
    expect(t.netCents).toBe(474_000);
    expect(t.maxExposureCents).toBe(6_000); // the owner's $60 is still at risk until the courses pay
  });

  it('a float does not lift a stated exposure cap', () => {
    const capped = { ...terms, totalSpendCapCents: null, exposureCapCents: 0 };
    expect(cashTrace(floatPlan([{ day: 1, kind: 'FUNDING', amountCents: 6_000, label: 'owner float' }, delivery, sales]), capped).maxExposureCents).toBe(6_000);
  });
});

describe('owner hours and fulfilment responsibility', () => {
  it('refuses forty owner delivery hours when the goal allows none a week (regression), and states the performer mismatch', () => {
    const r = plan();
    r.steps[2] = { ...r.steps[2]!, performer: 'OWNER', ownerHours: 40, executor: exec('OWNER_TASK', 'OWNER', []) };
    const c = codes(r);
    expect(c).toContain('OWNER_HOURS_OVER');
    expect(c).toContain('PERFORMER_MISMATCH');
  });

  it('allows owner hours inside the goal’s stated allowance, and refuses an owner step with no hours', () => {
    const r = plan();
    r.steps.push({ id: 'call', kind: 'OTHER', label: 'one call', performer: 'OWNER', costCents: 0, day: 2, dependsOn: null, evidence: ['q'], ownerHours: 2, executor: exec('OWNER_TASK', 'OWNER', []) });
    const allowed = { ...contract, terms: { ...contract.terms, ownerHoursPerWeek: 3 } } as GoalContract;
    expect(checkRevision(allowed, r, brain(), '2026-11-27').map((p) => p.code)).not.toContain('OWNER_HOURS_OVER');
    r.steps[3] = { ...r.steps[3]!, ownerHours: null };
    expect(checkRevision(allowed, r, brain(), '2026-11-27').map((p) => p.code)).toContain('STEP_FIELD_ABSENT');
  });

  it('refuses a delivery nobody is established to fulfil, and one given to Brain that a provider fulfils', () => {
    expect(codes(plan(), brain({ fulfilment: { o1: { by: 'NOBODY', name: null, capability: null, capabilityState: null } } }))).toContain('FULFILMENT_UNESTABLISHED');
    expect(codes(plan(), brain({ fulfilment: { o1: { by: 'PROVIDER', name: 'MedCourier', capability: null, capabilityState: null } } }))).toContain('PERFORMER_MISMATCH');
  });
});

describe('unknown owner availability stays unknown — never zero, never unlimited (2026-11-27 frozen run, n14)', () => {
  const unstated = { ...terms, ownerHoursPerWeek: null };
  const cU: GoalContract = { ...contract, terms: unstated as never, digest: contractDigest({ goalId: 'g', words: 'w', terms: unstated as never }) };
  const withOwnerWork = (stance: PlanRevisionInput['stance']) => {
    const r = plan({ contractDigest: cU.digest, stance, ...(stance === 'CONDITIONAL' ? { validation: { proof: 'owner confirms 15 hours by day 1', stop: ['owner declines'], continue: ['confirmed'] } } : {}) });
    r.steps[2] = { ...r.steps[2]!, performer: 'OWNER', ownerHours: 15, label: 'owner files the reports', executor: exec('OWNER_TASK', 'OWNER', []) };
    return r;
  };
  const codesU = (r: PlanRevisionInput) => checkRevision(cU, r, brain({ fulfilment: { o1: { by: 'OWNER', name: null, capability: null, capabilityState: null } }, hoursCeiling: null }), '2026-11-27').map((p) => p.code);

  it('an EXECUTABLE plan resting on owner hours the goal never states is at most CONDITIONAL, and is not refused as over a limit', () => {
    const c = codesU(withOwnerWork('EXECUTABLE'));
    expect(c).toContain('UNKNOWN_IN_EXECUTABLE');
    expect(c).not.toContain('OWNER_HOURS_OVER');
  });

  it('the same plan, CONDITIONAL on the owner confirming the hours, raises no owner-hours problem', () => {
    const c = codesU(withOwnerWork('CONDITIONAL'));
    expect(c).not.toContain('OWNER_HOURS_OVER');
    expect(c).not.toContain('UNKNOWN_IN_EXECUTABLE');
  });

  it('control: a stated allowance of zero is a limit, and the same hours are refused', () => {
    const r = plan();
    r.steps[2] = { ...r.steps[2]!, performer: 'OWNER', ownerHours: 15, executor: exec('OWNER_TASK', 'OWNER', []) };
    expect(codes(r, brain({ fulfilment: { o1: { by: 'OWNER', name: null, capability: null, capabilityState: null } } }))).toContain('OWNER_HOURS_OVER');
  });
});

describe('an opening Brain excluded is built on only with a stated dispute (2026-11-27 frozen run, fx-15)', () => {
  const excludedBrain = brain({ excluded: { o1: 'not a sale: its payer is a program' } });
  it('refuses a plan on an excluded opening that never says why the exclusion is wrong', () => {
    expect(codes(plan(), excludedBrain)).toContain('EXCLUSION_DISPUTE_UNSTATED');
  });
  it('control: the same plan with the dispute stated from the card passes that check; an unexcluded opening needs none', () => {
    const disputed = plan({ disagreements: [{ opportunityId: 'o1', link: 'EXCLUSION', reason: 'the payer is commercial beekeepers who buy; the program is only what they register with (card payer)' }] });
    expect(codes(disputed, excludedBrain)).not.toContain('EXCLUSION_DISPUTE_UNSTATED');
    expect(codes(plan())).not.toContain('EXCLUSION_DISPUTE_UNSTATED');
  });
});

describe('capability records', () => {
  it('never passes a Brain step whose capability record is missing, and refuses one Brain does not hold', () => {
    const r = plan();
    r.steps[0] = { ...r.steps[0]!, executor: null };
    expect(codes(r)).toContain('CAPABILITY_UNREAD');
    const s = plan();
    s.steps[2] = { ...s.steps[2]!, executor: exec('BRAIN_PRODUCES', 'BRAIN', [{ id: 'PRODUCE_VIDEO', state: 'NOT_DECLARED' }]) };
    expect(codes(s)).toContain('CAPABILITY_NOT_HELD');
  });

  it('the grader reads a missing executor record as an undeclared capability, not as a pass', () => {
    const c = PUBLIC_CASES.find((one) => one.id === 'fam-01-property-executable')!;
    const r = plan({ strategy: { title: 's', opportunityIds: ['opp_p'], why: 'w' }, chain: [{ opportunityId: 'opp_p', missing: [] }], members: [{ opportunityId: 'opp_p', deals: 9, price: 600, directCost: 10, capital: 0 }] });
    const scope = { scope: { targetCents: 500_000, daysLeft: 30, hoursCeiling: null, industry: null, recurring: null, hoursPerWeek: null }, openings: [], excluded: [] };
    const keyOf = (id: string) => (id === 'opp_p' ? 'property' : id);
    const withRecords = grade(c, observeSession(r, scope, keyOf));
    expect(withRecords.e2e.failures).not.toContain('BRAIN_CAPABILITY_NOT_HELD');
    const stripped = { ...r, steps: r.steps.map((s) => ({ ...s, executor: null })) };
    expect(grade(c, observeSession(stripped, scope, keyOf)).e2e.failures).toContain('BRAIN_CAPABILITY_NOT_HELD');
  });
});

describe('the grader reads a paid, costed subcontractor delivery as the supplier payment (2026-11-27 run, f07 and ho-11)', () => {
  const c = PUBLIC_CASES.find((one) => one.id === 'fam-08-cleaning-industry-scope')!;
  const scope = { scope: { targetCents: 500_000, daysLeft: 45, hoursCeiling: null, industry: null, recurring: null, hoursPerWeek: null }, openings: [], excluded: [] };
  const keyOf = (id: string) => (id === 'opp_c' ? 'cleaning' : id);
  const crew = (cash: PlanRevisionInput['cash']) => plan({
    strategy: { title: 's', opportunityIds: ['opp_c'], why: 'w' }, chain: [{ opportunityId: 'opp_c', missing: [] }],
    members: [{ opportunityId: 'opp_c', deals: 2, price: 3000, directCost: 1500, capital: 0 }],
    steps: [
      { id: 'collect', kind: 'COLLECT', label: 'invoice both contractors', performer: 'BRAIN', costCents: 0, day: 3, dependsOn: null, evidence: ['q'], executor: exec('COLLECT_PAYMENT', 'BRAIN') },
      { id: 'deliver', kind: 'DELIVER', label: 'BrightCrew cleans both sites', performer: 'BrightCrew Cleaning LLC', costCents: 300_000, day: 12, dependsOn: 'collect', evidence: ['q'], executor: exec('SUPPLIER_DELIVERS', 'PROVIDER', []) },
    ],
    cash,
  });
  const receipt = { day: 3, kind: 'RECEIPT' as const, amountCents: 600_000, label: 'two cleanups', settlesDay: 10 };
  const missing = (r: PlanRevisionInput) => grade(c, observeSession(r, scope, keyOf)).e2e.gaps.concat(grade(c, observeSession(r, scope, keyOf)).e2e.failures);

  it('a delivery step carrying the crew’s cost and paid by a linked outflow is the supplier payment', () => {
    expect(missing(crew([receipt, { day: 12, kind: 'SPEND', amountCents: 300_000, label: 'pay BrightCrew', stepId: 'deliver' }]))).not.toContain('CHAIN_STEP_MISSING');
  });

  it('control: the same delivery with no outflow paying it still has no supplier payment', () => {
    expect(missing(crew([receipt]))).toContain('CHAIN_STEP_MISSING');
  });
});

describe('a reviewer’s condition names its record, and the author answers it against the records (2026-11-27 run: r01, f02, f10)', () => {
  const card = { o1: [{ field: 'conversionRates', kind: 'EVIDENCE' }, { field: 'buyerVolume', kind: 'EVIDENCE' }, { field: 'demandEstimate', kind: 'RECOMMENDATION' }] };
  const rev = { strategy: { title: 's', opportunityIds: ['o1'], why: 'w' }, chain: [{ opportunityId: 'o1', missing: [] }] };

  it('refuses a condition with neither a supporting record nor a genuinely missing prerequisite', () => {
    expect(conditionProblems([{ opportunityId: 'o1', link: 'CONVERSION', basis: 'EVIDENCE', field: 'nothingLikeThis', why: 'unit mismatch' }], rev, card)).toHaveLength(1);
    expect(conditionProblems([{ opportunityId: 'o1', link: 'CONVERSION', basis: 'MISSING_PREREQUISITE', field: 'conversionRates', why: 'per-visitor' }], rev, card)[0]).toContain('not missing');
    expect(conditionProblems([{ opportunityId: 'o1', link: 'CONVERSION', basis: 'EVIDENCE', field: 'conversionRates', why: ' ' }], rev, card)).toHaveLength(1);
    expect(conditionProblems([{ opportunityId: 'oX', link: 'CONVERSION', basis: 'EVIDENCE', field: 'conversionRates', why: 'w' }], rev, card).join(' ')).toContain('does not weigh that opening');
  });

  it('controls: a condition citing the card fact, or a prerequisite the card does not hold as evidence, is recorded', () => {
    expect(conditionProblems([{ opportunityId: 'o1', link: 'MARKET_VOLUME', basis: 'EVIDENCE', field: 'buyerVolume', why: 'the count is the category across 40 sellers' }], rev, card)).toEqual([]);
    expect(conditionProblems([{ opportunityId: 'o1', link: 'MARKET_VOLUME', basis: 'MISSING_PREREQUISITE', field: 'contactSource', why: 'whether the 60 contacts came from the same list decides the fresh count' }], rev, card)).toEqual([]);
    expect(conditionProblems([{ opportunityId: 'o1', link: 'MARKET_VOLUME', basis: 'MISSING_PREREQUISITE', field: 'demandEstimate', why: 'only an estimate is on the card' }], rev, card)).toEqual([]);
  });

  const cond = { opportunityId: 'o1', link: 'CONVERSION', basis: 'EVIDENCE' as const, field: 'conversionRates', why: 'measured per page visitor, while the reach is email' };
  const facts = { o1: card.o1 };
  const withCond = (over: Partial<BrainFacts> = {}) => brain({ facts, reviewConditions: [cond], links: { o1: [{ link: 'CONVERSION', ok: true, basis: "measured on this offer's own inbound page" }] }, ...over });
  const chainPlan = (missing: string[], answers: PlanRevisionInput['answers'], disagreements: PlanRevisionInput['disagreements'] = []) =>
    plan({ chain: [{ opportunityId: 'o1', missing }], answers, disagreements, ...(missing.length ? { stance: 'CONDITIONAL' as const, resolves: missing, validation: { proof: 'p', stop: ['s'], continue: ['c'] } } : {}) });
  const unanswered = (r: PlanRevisionInput) => checkRevision(contract, r, withCond(), '2026-11-27').filter((p) => p.code === 'REVIEW_CONDITION_UNANSWERED');

  it('refuses a revision that leaves a condition unanswered, decides it with no record, or decides one way and charts the other', () => {
    expect(unanswered(chainPlan([], []))).toHaveLength(1);
    expect(unanswered(chainPlan(['CONVERSION'], [{ finding: 'f', resolution: 'accepted', condition: 0, decision: 'ACCEPTED', records: [] }], [{ opportunityId: 'o1', link: 'CONVERSION', reason: 'reviewer said so' }]))).toHaveLength(1);
    expect(unanswered(chainPlan([], [{ finding: 'f', resolution: 'accepted', condition: 0, decision: 'ACCEPTED', records: ['conversionRates'] }]))).toHaveLength(1);
    expect(unanswered(chainPlan(['CONVERSION'], [{ finding: 'f', resolution: 'rebutted', condition: 0, decision: 'REBUTTED', records: ['conversionRates'] }], [{ opportunityId: 'o1', link: 'CONVERSION', reason: 'x' }]))).toHaveLength(1);
  });

  it('controls: a rebuttal against the card and Brain’s basis, and an acceptance that charts the gap, both pass', () => {
    expect(unanswered(chainPlan([], [{ finding: 'f', resolution: 'the rate was measured on the page the email links to', condition: 0, decision: 'REBUTTED', records: ['conversionRates', 'brain:CONVERSION'] }]))).toEqual([]);
    expect(unanswered(chainPlan(['CONVERSION'], [{ finding: 'f', resolution: 'the card gives no email rate', condition: 0, decision: 'ACCEPTED', records: ['conversionRates'] }], [{ opportunityId: 'o1', link: 'CONVERSION', reason: 'conversionRates is per visitor' }]))).toEqual([]);
    // No review conditions: nothing to answer.
    expect(checkRevision(contract, chainPlan([], []), brain({ facts }), '2026-11-27').map((p) => p.code)).not.toContain('REVIEW_CONDITION_UNANSWERED');
  });
});

describe('missing evidence is a gap, never an arithmetic ceiling (2026-11-27 run: fx-04, mv-01)', () => {
  const facts = { o1: [{ field: 'buyerVolume', kind: 'EVIDENCE' }, { field: 'timeToFirstCash', kind: 'EVIDENCE' }, { field: 'demandEstimate', kind: 'RECOMMENDATION' }] };
  const noPlan = (missing: string[], constraints: PlanRevisionInput['constraints']) => plan({
    stance: 'NO_PLAN', steps: [], cash: [], alternatives: [{ title: 'a', why: 'w' }],
    noPlan: { decisiveGap: 'g', resolution: 'r', decisiveLinks: missing }, chain: [{ opportunityId: 'o1', missing }], resolves: missing, constraints,
  });
  const ceiling = (r: PlanRevisionInput) => checkRevision(contract, r, brain({ facts }), '2026-11-27').filter((p) => p.code === 'CONSTRAINT_FROM_MISSING_EVIDENCE').length;

  it('refuses a TARGET ceiling when the price is not established (fx-04: a contradicted price)', () => {
    expect(ceiling(noPlan(['OFFER_AND_PRICE', 'MARKET_VOLUME'], [{ constraint: 'TARGET', suggestion: 'lower the target', basis: [{ opportunityId: 'o1', field: 'buyerVolume' }] }]))).toBeGreaterThan(0);
  });

  it('refuses a TARGET ceiling on an uncounted market: no basis, or only an estimate cited', () => {
    expect(ceiling(noPlan(['MARKET_VOLUME'], [{ constraint: 'TARGET', suggestion: 'lower the target' }]))).toBe(1);
    expect(ceiling(noPlan(['MARKET_VOLUME'], [{ constraint: 'TARGET', suggestion: 'lower the target', basis: [{ opportunityId: 'o1', field: 'demandEstimate' }] }]))).toBe(1);
  });

  it('refuses a TARGET ceiling read from the openings on file when nothing counts the market (acceptance run 2026-11-27, ac-15: one $3,500 RFQ against $12,000)', () => {
    // The author judged MARKET_VOLUME established for the one-off ("one buyer, one deal") and cited only the price.
    expect(ceiling(noPlan(['CONVERSION'], [{ constraint: 'TARGET', suggestion: 'relax the target to $3,500', basis: [{ opportunityId: 'o1', field: 'price' }] }]))).toBe(1);
    const detail = checkRevision(contract, noPlan(['CONVERSION'], [{ constraint: 'TARGET', suggestion: 'x', basis: [{ opportunityId: 'o1', field: 'price' }] }]), brain({ facts }), '2026-11-27').find((p) => p.code === 'CONSTRAINT_FROM_MISSING_EVIDENCE')!.detail;
    expect(detail).toMatch(/counted market.*buyerVolume/);
    // Control: the same judgement with the counted market cited is a real limit (ac-20: 380 dealerships × $500).
    expect(ceiling(noPlan(['CONVERSION'], [{ constraint: 'TARGET', suggestion: 'about $190,000', basis: [{ opportunityId: 'o1', field: 'buyerVolume' }, { opportunityId: 'o1', field: 'price' }] }]))).toBe(0);
  });

  it('controls: a counted market with an established price, and a measured settlement delay, are real limits', () => {
    expect(ceiling(noPlan(['MARKET_VOLUME'], [{ constraint: 'TARGET', suggestion: 'about $2,400', basis: [{ opportunityId: 'o1', field: 'buyerVolume' }] }]))).toBe(0);
    expect(ceiling(noPlan(['SETTLES_IN_TIME'], [{ constraint: 'DEADLINE', suggestion: '75 days', basis: [{ opportunityId: 'o1', field: 'timeToFirstCash' }] }]))).toBe(0);
    // A no-plan with no constraint is unaffected.
    expect(ceiling(noPlan(['MARKET_VOLUME'], []))).toBe(0);
  });
});

describe('review independence', () => {
  it('treats one id, or one authenticated credential, as one executor whatever kind it declares', async () => {
    const { sameExecutor } = await import('../server/domain/planReady.ts');
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'wkr_a/s1', model: null }, { kind: 'MODEL', id: 'wkr_a/s1', model: null })).toBe(true);
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'wkr_a/s1', model: null }, { kind: 'MODEL', id: 'wkr_a/reviewer', model: null })).toBe(true);
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'wkr_a/s1', model: null }, { kind: 'MODEL', id: 'wkr_b/reviewer', model: null })).toBe(false);
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'author', model: null }, { kind: 'MODEL', id: 'reviewer', model: null })).toBe(false);
  });
});

describe('the session’s chain judgement against Brain’s, and what resolves an unknown', () => {
  const linksAllOk = { o1: ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'MARKET_VOLUME', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'].map((link) => ({ link, ok: true, basis: link === 'CONVERSION' ? "measured on this offer's own inbound page: 22 money-committed pre-orders from 200 unique visitors" : 'evidenced' })) };

  it('refuses a link Brain establishes being dropped silently, and accepts the disagreement once its reason is stated', () => {
    const conditional = plan({ stance: 'CONDITIONAL', chain: [{ opportunityId: 'o1', missing: ['CONVERSION'] }], resolves: ['CONVERSION'], validation: { proof: 'two paid', stop: ['none by day 10'], continue: ['two paid'] } });
    const c = codes(conditional, brain({ links: linksAllOk }));
    expect(c).toContain('CHAIN_DISAGREEMENT_UNSTATED');
    const detail = checkRevision(contract, conditional, brain({ links: linksAllOk }), '2026-11-27').find((p) => p.code === 'CHAIN_DISAGREEMENT_UNSTATED')!.detail;
    expect(detail).toContain("this offer's own inbound page");
    const reasoned = { ...conditional, disagreements: [{ opportunityId: 'o1', link: 'CONVERSION', reason: 'the page rate was measured on inbound visitors; this plan reaches buyers by cold email' }] };
    expect(codes(reasoned, brain({ links: linksAllOk }))).not.toContain('CHAIN_DISAGREEMENT_UNSTATED');
  });

  it('refuses treating a link Brain finds unestablished as established without stating the evidence', () => {
    const links = { o1: linksAllOk.o1.map((l) => (l.link === 'OFFER_AND_PRICE' ? { ...l, ok: false, basis: 'the price is a bounty reward, not a purchase' } : l)) };
    expect(codes(plan({ chain: [{ opportunityId: 'o1', missing: [] }] }), brain({ links }))).toContain('CHAIN_DISAGREEMENT_UNSTATED');
  });

  it('requires a no-plan’s decisive gap as chain links that are missing and measured by `resolves` (mv-01 regression)', () => {
    const noPlan = (over: Partial<PlanRevisionInput>): PlanRevisionInput => plan({
      stance: 'NO_PLAN', strategy: { title: 'no plan', opportunityIds: [], why: 'w' }, steps: [], cash: [], alternatives: [{ title: 'a', why: 'b' }],
      noPlan: { decisiveGap: 'the $10,000 figure is a bounty reward, not a price', resolution: 'find a sourced purchase price' }, ...over,
    });
    expect(codes(noPlan({ chain: [{ opportunityId: 'o1', missing: ['MARKET_VOLUME'] }], resolves: ['MARKET_VOLUME'] }))).toContain('RESOLUTION_UNNAMED');
    const named = { decisiveGap: 'bounty, not a price', resolution: 'find a sourced purchase price', decisiveLinks: ['OFFER_AND_PRICE'] };
    expect(codes(noPlan({ noPlan: named, chain: [{ opportunityId: 'o1', missing: ['MARKET_VOLUME'] }], resolves: ['MARKET_VOLUME'] }))).toContain('RESOLUTION_UNNAMED');
    expect(codes(noPlan({ noPlan: named, chain: [{ opportunityId: 'o1', missing: ['OFFER_AND_PRICE', 'MARKET_VOLUME'] }], resolves: ['MARKET_VOLUME'] }))).toContain('RESOLUTION_UNNAMED');
    expect(codes(noPlan({ noPlan: named, chain: [{ opportunityId: 'o1', missing: ['OFFER_AND_PRICE', 'MARKET_VOLUME'] }], resolves: ['OFFER_AND_PRICE', 'MARKET_VOLUME'] }))).not.toContain('RESOLUTION_UNNAMED');
  });

  it('requires a conditional plan’s validation to measure every link its members are missing', () => {
    const r = plan({ stance: 'CONDITIONAL', chain: [{ opportunityId: 'o1', missing: ['CONVERSION', 'MARKET_VOLUME'] }], resolves: ['CONVERSION'], validation: { proof: 'p', stop: ['s'], continue: ['c'] } });
    expect(codes(r)).toContain('RESOLUTION_UNNAMED');
    expect(codes({ ...r, resolves: ['CONVERSION', 'MARKET_VOLUME'] })).not.toContain('RESOLUTION_UNNAMED');
  });
});

describe('a conditional plan names its decisive link, and a discovered opening cites where it was found (acceptance run 2026-11-27, discovery worlds)', () => {
  const conditional = (over: Partial<PlanRevisionInput> = {}) => plan({
    stance: 'CONDITIONAL', chain: [{ opportunityId: 'o1', missing: ['OFFER_AND_PRICE', 'CONVERSION', 'SETTLES_IN_TIME'] }],
    resolves: ['OFFER_AND_PRICE', 'CONVERSION', 'SETTLES_IN_TIME'],
    validation: { proof: '5 prepaid by day 5', stop: ['none by day 5'], continue: ['5 prepaid'], decides: ['CONVERSION'] },
    ...over,
  });
  const decisive = (r: PlanRevisionInput) => codes(r).filter((c) => c === 'CONDITIONAL_DECISIVE_UNNAMED').length;

  it('refuses a conditional plan that charts every unknown and singles out none', () => {
    expect(decisive(conditional({ validation: { proof: 'p', stop: ['s'], continue: ['c'] } }))).toBe(1);
  });
  it('refuses a decisive link that is not missing, or that the test does not measure', () => {
    expect(decisive(conditional({ validation: { proof: 'p', stop: ['s'], continue: ['c'], decides: ['FULFILMENT'] } }))).toBe(1);
    expect(decisive(conditional({ resolves: ['OFFER_AND_PRICE'], validation: { proof: 'p', stop: ['s'], continue: ['c'], decides: ['CONVERSION'] } }))).toBeGreaterThan(0);
  });
  it('control: a named decisive link the chain misses and the test measures passes', () => {
    expect(decisive(conditional())).toBe(0);
  });

  const discovered = brain({ discovered: ['o1'] });
  const unsourced = (r: PlanRevisionInput, b = discovered) => checkRevision(contract, r, b, '2026-11-27').filter((p) => p.code === 'DISCOVERY_UNSOURCED').length;
  const card = { id: 's1', url: 'https://brain.local/card/o1#price', dated: null, claim: 'price', population: 'p', matchesBuyer: true, opportunityId: 'o1' };
  const page = { id: 's2', url: 'https://www.example.org/directory/local-movers', dated: '2026-11-20', claim: 'lists 420 moving companies', population: 'movers', matchesBuyer: true, opportunityId: 'o1' };
  it('refuses a plan on a session-discovered opening whose only citation is Brain’s own card', () => {
    expect(unsourced(conditional({ sources: [card] }))).toBe(1);
    expect(unsourced(conditional({ sources: [] }))).toBe(1);
  });
  it('controls: a public page about the opening passes; an opening filed by research (not discovered by the session) needs none', () => {
    expect(unsourced(conditional({ sources: [card, page] }))).toBe(0);
    expect(unsourced(conditional({ sources: [card] }), brain())).toBe(0);
  });
});
