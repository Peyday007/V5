/**
 * Who performs a plan's step, and whether it needs the owner's approval — two
 * readings, never one word (owner, 2026-11-20; `stepExecutor`, the
 * EXECUTABLE_BY_BRAIN rule of `planIntegrity`).
 *
 * Production plans read `[PERSON] Sell "…" through a partner who already
 * serves its buyers`, `[PERSON] 20 pre-warmed cold-email accounts … for $350`
 * and `[PERSON] Collect payment`: a signature, a payment and Brain's own
 * collection, each read as the owner's labor, and nothing said whether Brain
 * could perform any step. Every case below builds steps with the real builders
 * (`planSteps`, `arrangementSteps`) and checks them with the real checker.
 */
import { describe, expect, it } from 'vitest';
import { planIntegrity } from '../server/domain/planIntegrity.ts';
import type { ConstructedArrangement } from '../server/services/cash/construct.ts';
import type { ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { gateIntegrity, planSteps, type NextTest, type PlanAcceptance, type PlanReading, type PlanStep } from '../server/services/goals/plan.ts';
import { integrityInput } from '../server/services/goals/planIntegrityInput.ts';
import type { Reconstruction, StrategyChange } from '../server/services/goals/reconstruction.ts';
import { declaredInventory, executorLine, planExecution, stepExecutor, type CapabilityInventory } from '../server/services/goals/stepExecutor.ts';

const adoption = { source: 'RECONSTRUCTED' as const, hypothetical: false, reason: 'beats the plan as held' };
const recon = (changes: StrategyChange[]): Reconstruction => ({ best: { changes, members: ['Office cleaning referrals'] }, required: 0.9, requiredReply: null }) as unknown as Reconstruction;

/** The production plan's moves, as the reconstruction writes them (`reconstruction.ts`). */
const PREWARMED: StrategyChange = {
  dimension: 'CAPACITY',
  op: 'capacity:cold-email-prewarmed@350',
  label: '20 pre-warmed cold-email accounts',
  detail: '20 pre-warmed cold-email accounts on 4 domain(s) for $350, adding 100–500 sends a day',
  cost: 350,
  basis: 'ESTIMATE',
  startDay: { low: 0, high: 3 },
};
const PARTNER: StrategyChange = {
  dimension: 'PARTNER',
  op: 'partner:referral-partner',
  label: 'Sell "Office cleaning referrals" through a partner who already serves its buyers',
  detail: 'sell "Office cleaning referrals" through a partner who already serves its buyers (a supplier or complementary vendor), paying 10–30%; 0.05–0.5 referrals a day assumed until a partner is signed',
  cost: 0,
  basis: 'ASSUMPTION',
  startDay: { low: 3, high: 10 },
};
const PAID_SEARCH: StrategyChange = {
  dimension: 'ACQUISITION',
  op: 'acquisition:paid-search-inbound@300',
  label: 'Paid search leads for "Office cleaning referrals"',
  detail: 'buy about 4 paid search leads for $300, selling Office cleaning referrals',
  cost: 300,
  basis: 'ESTIMATE',
  startDay: { low: 2, high: 7 },
};

const accepted: PlanAcceptance = {
  status: 'ACCEPTED',
  required: 0.9,
  probability: { value: 0.95, lowerBound: 0.91, basis: 'EVIDENCED_PORTFOLIO', sample: 40, note: 'n' },
  accepted: { label: 'Office cleaning referrals', opportunityIds: [] },
  candidate: { label: 'Office cleaning referrals', opportunityIds: [], source: 'RECONSTRUCTED', settledP50: 12_000, reach: 0.95, reachBasis: 'PROBABILITY' },
  shortfalls: [],
  sentence: 'Accepted: the plan collects the target.',
  verdict: 'CONFIDENCE_VERIFIED',
} as PlanAcceptance;
const candidate = { ...accepted, status: 'CANDIDATE_ONLY', probability: null, accepted: null, sentence: 'A candidate.' } as PlanAcceptance;

function reading(steps: PlanStep[], acceptance: PlanAcceptance): PlanReading {
  return { goalId: 'wst_executability', verdict: acceptance.status === 'ACCEPTED' ? 'RECOMMENDABLE' : 'NEEDS_EVIDENCE', summary: acceptance.sentence, acceptance, steps, nextTest: null, portfolio: null } as unknown as PlanReading;
}
const executability = (steps: PlanStep[], acceptance: PlanAcceptance = accepted) =>
  planIntegrity(integrityInput(reading(steps, acceptance))).violations.filter((v) => v.rule === 'EXECUTABLE_BY_BRAIN');
const byLabel = (steps: PlanStep[], start: string) => steps.find((s) => s.label.startsWith(start))!;

/** A connected Brain: messaging, replies, lists, billing and inbox buying read usable. */
function connected(over: Partial<Record<string, CapabilityInventory['entries'][string]['state']>> = {}): CapabilityInventory {
  const inv = declaredInventory();
  for (const e of Object.values(inv.entries)) e.state = 'PRESENT';
  for (const [id, state] of Object.entries(over)) {
    const e = inv.entries[id];
    if (e && state) Object.assign(e, { state, remedy: 'Create and verify the Stripe account and save its secret key.', ownerOnly: true });
  }
  return { read: true, entries: inv.entries };
}

describe('every step names who performs it, read from what Brain has registered', () => {
  const steps = planSteps({ adoption, reconstruction: recon([PREWARMED, PARTNER]), sales: [], nextTest: null, permissionsMissing: [], capabilities: connected() });

  it('every step carries an executor record', () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.executor, s.label).toBeDefined();
  });

  it('the inbox purchase is Brain\'s acquisition through its inbox seller, and the $350 is an approval, not labor', () => {
    const e = byLabel(steps, '20 pre-warmed').executor!;
    expect(e).toMatchObject({ performedBy: 'BRAIN', operation: 'BUY_SENDING_CAPACITY', acquisition: true, routine: false });
    expect(e.via.join(' ')).toMatch(/Instantly|InboxKit/);
    expect(e.approval.reasons.map((r) => r.kind)).toEqual(['PAYMENT']);
    expect(executorLine(e)).toMatch(/^performed by Brain through .*; approval needed: yes \(payment: 350 from the owner's money/);
  });

  it('the partner is recruited by Brain\'s own outreach; the agreement is the owner\'s signature, once', () => {
    const e = byLabel(steps, 'Sell "Office cleaning referrals" through a partner').executor!;
    expect(e).toMatchObject({ performedBy: 'BRAIN', operation: 'RECRUIT_PARTNER' });
    expect(e.via.join(' ')).toMatch(/SEND_A_MESSAGE/);
    expect(e.provider).toMatch(/partner/);
    expect(e.approval.reasons).toEqual([expect.objectContaining({ kind: 'LEGAL_COMMITMENT', once: true })]);
  });

  it('selling and collecting are Brain\'s, through its messaging and billing integrations', () => {
    expect(byLabel(steps, 'Sell the plan').executor).toMatchObject({ performedBy: 'BRAIN', operation: 'SEND_OFFER', routine: true, approval: { needed: false } });
    const collect = byLabel(steps, 'Collect payment').executor!;
    expect(collect).toMatchObject({ performedBy: 'BRAIN', operation: 'COLLECT_PAYMENT', routine: true });
    expect(collect.via.join(' ')).toMatch(/Stripe/);
    expect(steps.some((s) => s.executor!.performedBy === 'OWNER')).toBe(false);
  });

  it('an accepted plan of these steps is executable: approvals listed, nothing refused', () => {
    expect(executability(steps)).toEqual([]);
    const x = planExecution(steps);
    expect(x.ownerWork).toEqual([]);
    expect(x.approvals.join(' | ')).toMatch(/payment: 350/);
    expect(x.approvals.join(' | ')).toMatch(/legal commitment \(once\)/);
  });

  it('an unconnected billing integration is a permission and a one-time credential approval, never the owner collecting', () => {
    const unconnected = planSteps({ adoption, reconstruction: recon([PARTNER]), sales: [], nextTest: null, permissionsMissing: ['ACCEPT_PAYMENT'], capabilities: connected({ ISSUE_AN_INVOICE: 'NOT_CONNECTED', TAKE_A_PAYMENT: 'NOT_CONNECTED' }) });
    const e = byLabel(unconnected, 'Collect payment').executor!;
    expect(e.performedBy).toBe('BRAIN');
    expect(e.permissions.join(' ')).toMatch(/Stripe connected/);
    expect(e.approval.reasons.map((r) => [r.kind, r.once])).toEqual([['CREDENTIAL', true], ['STANDING_GRANT', true]]);
    expect(executability(unconnected)).toEqual([]);
  });
});

describe('a capability nobody registered is never assumed', () => {
  it('buying paid leads needs an ad account no integration provides: CAPABILITY_MISSING, and an accepted plan is refused', () => {
    const steps = planSteps({ adoption, reconstruction: recon([PAID_SEARCH]), sales: [], nextTest: null, permissionsMissing: [], capabilities: connected() });
    const e = byLabel(steps, 'Buy about 4 paid search').executor!;
    expect(e).toMatchObject({ performedBy: 'CAPABILITY_MISSING', operation: 'BUY_PAID_LEADS' });
    expect(e.acquire.join(' ')).toMatch(/advertising or lead-marketplace account/);
    expect(executability(steps).map((v) => v.detail)).toEqual([expect.stringMatching(/^step \d+ \("Buy about 4 paid search.*no registered capability performs/)]);
    // A candidate is not refused for it: the rule binds a plan that would be accepted.
    expect(executability(steps, candidate)).toEqual([]);
    const gated = gateIntegrity(reading(steps, accepted), () => ({ continuation: { continues: true, reason: 'r', surplusForSuccessors: 0 } }));
    expect(gated.acceptance.status).toBe('CANDIDATE_ONLY');
    expect(gated.acceptance.shortfalls[0]).toMatch(/^EXECUTABLE_BY_BRAIN/);
  });

  it('the executor follows the registry, not the step\'s words: registering the capability makes the same step Brain\'s', () => {
    const inv = connected();
    inv.entries['BUY_PAID_LEADS'] = { id: 'BUY_PAID_LEADS', state: 'PRESENT', via: ['An ad account'], remedy: null, ownerOnly: false };
    const steps = planSteps({ adoption, reconstruction: recon([PAID_SEARCH]), sales: [], nextTest: null, permissionsMissing: [], capabilities: inv });
    expect(byLabel(steps, 'Buy about 4 paid search').executor).toMatchObject({ performedBy: 'BRAIN', via: ['An ad account (BUY_PAID_LEADS)'] });
    expect(executability(steps)).toEqual([]);
  });

  it('words in a step are not an operation: a planner decision that mentions a contract and a sign-in asks for no approval', () => {
    const words: StrategyChange = { dimension: 'PORTFOLIO', op: 'focus:2', label: 'Concentrate on two openings', detail: 'concentrate on the openings whose contract terms need no sign-in or log in', cost: 0, basis: 'ESTIMATE', startDay: { low: 0, high: 0 } };
    const steps = planSteps({ adoption, reconstruction: recon([words]), sales: [], nextTest: null, permissionsMissing: [], capabilities: connected() });
    expect(byLabel(steps, 'Concentrate').executor).toMatchObject({ performedBy: 'BRAIN', operation: 'PLAN_DECISION', via: ["the goal's planner"], approval: { needed: false } });
  });
});

describe('an arrangement whose work a supplier does, and whose orders Brain cannot pay', () => {
  const subcontract = {
    key: 'subclean',
    structure: 'SUBCONTRACT',
    design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    origin: 'FORWARD',
    sector: 'Cleaning',
    demand: { name: 'Property managers', claimId: null, from: 'INDUSTRY_MAP', ref: 'pop_pm' },
    need: { name: 'turnover cleaning', claimId: null, from: 'INDUSTRY_MAP', ref: 'need_clean' },
    supply: { name: 'Local cleaning crews', claimId: null, from: 'INDUSTRY_MAP', ref: 'sup_crews' },
    label: 'Property managers: turnover cleaning',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'SAFE', worstCaseCents: 20_000, failures: [] },
    evidenced: 0,
    value: { tier: 'ESTIMATE', p10: 150, p50: 200, p90: 250, observations: 3 },
    unknownParts: [],
    relatedOpenings: [],
    question: 'What do they pay?',
  } as unknown as ConstructedArrangement;
  const modelled = { daysToCash: { value: null, low: 5, high: 15, provenance: 'UNKNOWN', source: null, note: 'swept' } } as unknown as ModelledOpportunity;
  const steps = planSteps({
    adoption: { source: 'BASELINE', hypothetical: false, reason: 'held' },
    reconstruction: null,
    sales: [],
    nextTest: null,
    permissionsMissing: [],
    arrangement: { arrangement: subcontract, context: { currency: 'USD', daysLeft: 60, capitalBeforeProof: 500, modelled } },
    capabilities: connected(),
  });

  it('the supplier delivers (a provider), Brain confirming by message; ordering is a payment and an operation no integration performs', () => {
    expect(byLabel(steps, 'Deliver').executor).toMatchObject({ performedBy: 'PROVIDER', provider: '"Local cleaning crews"' });
    const order = byLabel(steps, 'Order').executor!;
    expect(order).toMatchObject({ performedBy: 'CAPABILITY_MISSING', operation: 'PAY_SUPPLIER', routine: true });
    expect(order.acquire.join(' ')).toMatch(/pay a supplier/);
    expect(order.approval.reasons.map((r) => r.kind)).toEqual(['PAYMENT']);
    expect(byLabel(steps, 'Reach').executor).toMatchObject({ performedBy: 'BRAIN', operation: 'REACH_BUYERS' });
  });

  it('accepted, it is refused for the order alone', () => {
    expect(executability(steps).map((v) => v.detail)).toEqual([expect.stringMatching(/\("Order the work from Local cleaning crews"\) needs what no registered capability performs/)]);
  });
});

describe('what the owner holds is an approval; routine work given to the owner is refused', () => {
  const baseline = { source: 'BASELINE' as const, hypothetical: false, reason: 'held' };

  it('a next test waiting on the owner\'s grant is Brain\'s sending, with the grant as an approval', () => {
    // goalPlan.test.ts, 2026-11-20: this exact next test read as routine owner labor in the first cut, and refused an accepted plan.
    const waiting: NextTest = { link: 'CONVERSION', test: 'A bounded offer test: send the offer to a few reachable buyers.', by: 'PERSON', blocker: 'Brain has no standing permission to contact buyers here. Grant CONTACT_BUYER.' };
    const steps = planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: waiting, permissionsMissing: [], capabilities: connected() });
    expect(steps[0]!.executor).toMatchObject({ performedBy: 'BRAIN', operation: 'SEND_OFFER' });
    expect(steps[0]!.executor!.approval.reasons).toEqual([expect.objectContaining({ kind: 'AUTHORITY', once: true })]);
    expect(executability(steps)).toEqual([]);
    const capital: NextTest = { link: 'ECONOMICS', test: 'Say how much this goal may commit.', by: 'PERSON', blocker: 'The owner has not said how much money this goal may commit.' };
    expect(planSteps({ adoption: baseline, reconstruction: null, sales: [], nextTest: capital, permissionsMissing: [], capabilities: connected() })[0]!.executor).toMatchObject({ performedBy: 'BRAIN', operation: 'PLAN_DECISION', approval: { needed: true } });
  });

  it('routine work the owner performs is refused on an accepted plan; one-off owner work is listed', () => {
    const steps = planSteps({ adoption: { source: 'RECONSTRUCTED', hypothetical: false, reason: 'r' }, reconstruction: recon([]), sales: [], nextTest: null, permissionsMissing: [], capabilities: connected() });
    const sell = byLabel(steps, 'Sell the plan');
    const byOwner = (routine: boolean) => steps.map((s) => (s === sell ? { ...s, executor: stepExecutor({ operation: 'OWNER_TASK', ownerTask: { why: 'the owner phones each buyer', routine } }) } : s));
    expect(executorLine(byOwner(true).find((s) => s.label === sell.label)!.executor!)).toMatch(/^performed by the owner \(the owner phones each buyer\) — ROUTINE work/);
    expect(executability(byOwner(true)).map((v) => v.detail)).toEqual([expect.stringMatching(/gives the owner routine work/)]);
    expect(executability(byOwner(false))).toEqual([]);
    expect(planExecution(byOwner(false)).ownerWork).toEqual([expect.stringMatching(/\(one-off\)$/)]);
  });
});

describe('the registry is the source', () => {
  it('declares what Brain can buy and send, and nothing that pays a supplier or buys ads', () => {
    const inv = declaredInventory();
    expect(inv.entries['BUY_SENDING_INBOXES']?.via).toEqual(expect.arrayContaining(['Instantly', 'InboxKit']));
    expect(inv.entries['SEND_A_MESSAGE']?.via).toContain('Instantly');
    expect(inv.entries['PAY_A_SUPPLIER']).toBeUndefined();
    expect(inv.entries['BUY_PAID_LEADS']).toBeUndefined();
    // A word with no reader and no integration (a signature) is not something Brain can do.
    expect(inv.entries['SIGN_AN_AGREEMENT']).toBeUndefined();
  });
});
