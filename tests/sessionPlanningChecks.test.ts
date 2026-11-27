/**
 * Regressions for the app-session plan checker (server/domain/sessionPlanning.ts `checkRevision`) found in the
 * 2026-11-26 held-out evaluation: a step's cost omitted from the ledger, owner hours beyond the goal's allowance,
 * a delivery given to someone other than the opening's recorded fulfiller, and a capability record that was absent.
 * And the grader reading the same records (bench/planningReliability/session.ts).
 */
import { describe, expect, it } from 'vitest';
import { checkRevision, contractDigest, type BrainFacts, type GoalContract, type PlanRevisionInput } from '../server/domain/sessionPlanning.ts';
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

describe('review independence', () => {
  it('treats one id, or one authenticated credential, as one executor whatever kind it declares', async () => {
    const { sameExecutor } = await import('../server/domain/planReady.ts');
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'wkr_a/s1', model: null }, { kind: 'MODEL', id: 'wkr_a/s1', model: null })).toBe(true);
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'wkr_a/s1', model: null }, { kind: 'MODEL', id: 'wkr_a/reviewer', model: null })).toBe(true);
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'wkr_a/s1', model: null }, { kind: 'MODEL', id: 'wkr_b/reviewer', model: null })).toBe(false);
    expect(sameExecutor({ kind: 'APP_SESSION', id: 'author', model: null }, { kind: 'MODEL', id: 'reviewer', model: null })).toBe(false);
  });
});
