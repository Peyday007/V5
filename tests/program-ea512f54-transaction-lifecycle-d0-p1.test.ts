/**
 * LIFE-29: a transaction as a changing system of commitments (29-1), revenue
 * realization and aftercare (29-2), exceptions with remedies and a rehearsed
 * failure path (29-3).
 *
 * Every assertion is on the pure derivations, over rows shaped as the
 * obligation reader and the money ledger return them. No clause is tested by
 * restating the code: each one names the claim it holds against.
 */
import { describe, expect, it } from 'vitest';
import type { CashMoneyEntry } from '../server/domain/types.ts';
import type { ObligationReading } from '../server/services/cash/journey/fulfillment.ts';
import {
  COMMITMENT_STAGES,
  deriveCommitments,
  type CommitmentReading,
} from '../server/services/cash/deliverables/commitments.ts';
import {
  aftercareEvidence,
  deriveDeliveryPlan,
  readRealization,
  recordAftercare,
  type Party,
  type ScopeItem,
} from '../server/services/cash/deliverables/realization.ts';
import {
  COMMITTING_REMEDIES,
  carryOutApprovedRefund,
  detectExceptions,
  quantifyConsequence,
  selectRemedy,
  traceCase,
  type DetectedException,
  type ExceptionSignal,
  type RemedyAuthority,
} from '../server/services/cash/deliverables/exceptions.ts';
import type { CapabilityState } from '../server/services/cash/capabilities.ts';

const NOW = '2026-06-10T00:00:00.000Z';
const OPP = 'opp_1';

let seq = 0;
function entry(kind: string, amountCents: number, over: Partial<CashMoneyEntry> = {}): CashMoneyEntry {
  seq += 1;
  return {
    id: `me_${seq}`,
    projectId: 'prj',
    opportunityId: OPP,
    commitmentId: null,
    idempotencyKey: null,
    payloadFingerprint: null,
    kind: kind as CashMoneyEntry['kind'],
    amountCents,
    currency: 'USD',
    verifiedReference: null,
    fundsAvailableAt: null,
    occurredAt: `2026-06-0${Math.min(9, 1 + (seq % 8))}T00:00:00.000Z`,
    note: null,
    recordedBy: 'test',
    createdAt: NOW,
    ...over,
  };
}

function obligation(id: string, amountCents: number, over: Record<string, unknown> = {}): ObligationReading {
  const o = {
    opportunityId: OPP,
    agreement: {
      id,
      projectId: 'prj',
      opportunityId: OPP,
      amountCents,
      currency: 'USD',
      deliverable: 'the deliverable',
      acceptanceCondition: 'buyer signs off',
      evidenceKind: 'SIGNED_AGREEMENT',
      evidenceRef: 'doc-1',
      observationId: null,
      state: 'AGREED',
      releasedReason: null,
      releasedBy: null,
      releasedAt: null,
      requestKey: 'k',
      recordedBy: 'person',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
    fulfillment: null,
    work: { state: 'COMPLETE', ref: 'prov-1', artifact: 'pr#1', detail: 'done' },
    delivery: { state: 'NOT_DELIVERED', portions: [], evidence: null, deliveredAt: null },
    acceptance: { state: 'AWAITING_DELIVERY', condition: 'buyer signs off', evidence: null, reason: null },
    refunds: [],
    failure: null,
    stage: 'IN_PROGRESS',
    complete: false,
    outstanding: ['not delivered'],
    brainNext: [],
    personNext: [],
    ...over,
  };
  return o as unknown as ObligationReading;
}

const accepted = (id: string, cents: number) =>
  obligation(id, cents, {
    delivery: { state: 'DELIVERED', portions: [{ detail: 'all', evidence: 'ev', at: '2026-06-03T00:00:00.000Z' }], evidence: 'ev', deliveredAt: '2026-06-03T00:00:00.000Z' },
    acceptance: { state: 'ACCEPTED', condition: 'buyer signs off', evidence: 'sign', reason: null },
    outstanding: [],
    complete: true,
  });

const derive = (obligations: ObligationReading[], entries: CashMoneyEntry[], extra: Partial<Parameters<typeof deriveCommitments>[0]> = {}) =>
  deriveCommitments({ opportunityId: OPP, currency: 'USD', obligations, entries, now: NOW, ...extra });

/* ------------------------------------------------------------------ 29-1 */
describe('LIFE-29-1: no single "sale made" flag', () => {
  it('exposes six separate readings and no boolean that stands for a sale', () => {
    const r = derive([], []);
    expect([...COMMITMENT_STAGES]).toEqual(['CONTRACT_SIGNED', 'PAYMENT_AUTHORIZED', 'FUNDS_SETTLED', 'WORK_ACCEPTED', 'MARGIN_EARNED', 'CASH_AVAILABLE']);
    expect(Object.keys(r.stages).sort()).toEqual([...COMMITMENT_STAGES].sort());
    for (const key of Object.keys(r)) expect(key).not.toMatch(/sale|sold|made/i);
    expect(r.nextStage).toBe('CONTRACT_SIGNED');
  });

  it('keeps contract, authorized payment, settled funds and acceptance apart', () => {
    const entries = [entry('PIPELINE_AGREED', 10_000), entry('CUSTOMER_PAYMENT', 10_000)];
    const r = derive([obligation('a1', 10_000)], entries);
    expect(r.stages.CONTRACT_SIGNED.state).toBe('REACHED');
    expect(r.stages.PAYMENT_AUTHORIZED.state).toBe('REACHED');
    // paid is not usable, not accepted, not earned, not available to reinvest
    expect(r.stages.FUNDS_SETTLED.state).not.toBe('REACHED');
    expect(r.stages.WORK_ACCEPTED.state).not.toBe('REACHED');
    expect(r.stages.MARGIN_EARNED.state).toBe('NOT_REACHED');
    expect(r.stages.CASH_AVAILABLE.state).toBe('NOT_REACHED');
    expect(r.stages.FUNDS_SETTLED.missing[0]).toContain('not yet usable');
    expect(r.nextStage).toBe('FUNDS_SETTLED');
  });

  it('reaches every stage only when each one is true on its own evidence', () => {
    const entries = [
      entry('PIPELINE_AGREED', 10_000),
      entry('CUSTOMER_PAYMENT', 10_000),
      entry('SETTLEMENT', 10_000),
      entry('COST', 2_000),
    ];
    const r = derive([accepted('a1', 10_000)], entries);
    for (const s of COMMITMENT_STAGES) expect(r.stages[s].state).toBe('REACHED');
    expect(r.stages.MARGIN_EARNED.amountCents).toBe(8_000);
    expect(r.stages.CASH_AVAILABLE.amountCents).toBe(8_000);
    expect(r.nextStage).toBeNull();
  });

  it('margin is never taken from a payment and is net of money still owed a supplier', () => {
    const paidOnly = derive([obligation('a1', 10_000)], [entry('PIPELINE_AGREED', 10_000), entry('CUSTOMER_PAYMENT', 10_000), entry('SETTLEMENT', 10_000)]);
    expect(paidOnly.stages.MARGIN_EARNED.state).toBe('NOT_REACHED');

    const entries = [
      entry('PIPELINE_AGREED', 10_000),
      entry('CUSTOMER_PAYMENT', 10_000),
      entry('SETTLEMENT', 10_000),
      entry('UNPAID_COMMITMENT', 3_000, { commitmentId: 'sup-1' }),
    ];
    const r = derive([accepted('a1', 10_000)], entries);
    expect(r.stages.MARGIN_EARNED.amountCents).toBe(7_000);
    expect(r.owedToSuppliers).toHaveLength(1);
    expect(r.owedToSuppliers[0]).toMatchObject({ owedCents: 3_000, overpaidCents: 0 });
    expect(r.owedToSuppliers[0]!.party).toEqual({ role: 'supplier', ref: 'sup-1' });
  });

  it('a paid-off or released supplier commitment is no longer owed; an overpayment is not negative debt', () => {
    const entries = [
      entry('UNPAID_COMMITMENT', 3_000, { commitmentId: 's1' }),
      entry('COMMITMENT_PAID', 3_000, { commitmentId: 's1' }),
      entry('UNPAID_COMMITMENT', 1_000, { commitmentId: 's2' }),
      entry('COMMITMENT_RELEASED', 1_000, { commitmentId: 's2' }),
      entry('UNPAID_COMMITMENT', 500, { commitmentId: 's3' }),
      entry('COMMITMENT_PAID', 800, { commitmentId: 's3' }),
    ];
    const r = derive([], entries);
    expect(r.owedToSuppliers.map((o) => o.party.ref)).toEqual(['s3']);
    expect(r.owedToSuppliers[0]).toMatchObject({ owedCents: 0, overpaidCents: 300 });
  });

  it('money owed back to the customer counts unconfirmed refunds and payment beyond what was agreed', () => {
    const o = obligation('a1', 10_000, {
      refunds: [{ refundKey: 'r1', amountCents: 1_500, reason: 'partial', state: 'PENDING', reference: null, authorizedAt: '2026-06-05T00:00:00.000Z', outcomeDetail: null }],
    });
    const r = derive([o], [entry('PIPELINE_AGREED', 10_000), entry('CUSTOMER_PAYMENT', 12_000)]);
    expect(r.owedToCustomers.unconfirmedRefundCents).toBe(1_500);
    expect(r.owedToCustomers.receivedBeyondAgreedCents).toBe(2_000);
    expect(r.owedToCustomers.totalCents).toBe(3_500);
  });

  it('an undone payment reads REVERSED, not "never happened"', () => {
    const r = derive([obligation('a1', 10_000)], [entry('PIPELINE_AGREED', 10_000), entry('CUSTOMER_PAYMENT', 10_000), entry('REFUND', 10_000)]);
    expect(r.stages.PAYMENT_AUTHORIZED.state).toBe('REVERSED');
  });

  it('a released agreement is let go, and the stage records that it was reached then undone', () => {
    const released = obligation('a1', 10_000, {});
    (released.agreement as { releasedAt: string | null }).releasedAt = '2026-06-04T00:00:00.000Z';
    (released.agreement as { releasedReason: string | null }).releasedReason = 'buyer withdrew';
    const r = derive([released], []);
    expect(r.stages.CONTRACT_SIGNED.state).toBe('REVERSED');
    expect(r.transitions.find((t) => t.id === 'agreement:a1')).toMatchObject({ outcome: 'RELEASED', outcomeDetail: 'buyer withdrew' });
  });

  it('entries in another currency are named and left out, never summed in', () => {
    const r = derive([], [entry('CUSTOMER_PAYMENT', 5_000), entry('CUSTOMER_PAYMENT', 99_999, { currency: 'EUR' })]);
    expect(r.otherCurrencies).toEqual(['EUR']);
    expect(r.stages.PAYMENT_AUTHORIZED.amountCents).toBe(5_000);
  });

  it('each transition carries who, what, by when, terms, evidence and outcome; unstated is null, not invented', () => {
    const r = derive([obligation('a1', 10_000)], []);
    const agreement = r.transitions.find((t) => t.id === 'agreement:a1')!;
    expect(agreement.duty.holder).toEqual({ role: 'recorder', ref: 'person' });
    expect(agreement.duty.action).toMatch(/Agree/);
    expect(agreement.deadline).toBeNull();
    expect(agreement.terms.join(' ')).toContain('acceptance: buyer signs off');
    expect(agreement.evidence).toEqual(['SIGNED_AGREEMENT:doc-1']);
    expect(agreement.outcome).toBe('DONE');
    const noWork = derive([obligation('a2', 1, { work: { state: 'NOT_CREATED', ref: null, artifact: null, detail: 'none' } })], []);
    expect(noWork.transitions.find((t) => t.id === 'work:a2')!.duty.holder).toBeNull();
  });

  it('supports skipped steps: payment with no agreement row, and acceptance with no payment', () => {
    const payOnly = derive([], [entry('CUSTOMER_PAYMENT', 100)]);
    expect(payOnly.stages.CONTRACT_SIGNED.state).toBe('NOT_REACHED');
    expect(payOnly.transitions.some((t) => t.kind === 'payment')).toBe(true);
    const acceptOnly = derive([accepted('a1', 500)], []);
    expect(acceptOnly.stages.WORK_ACCEPTED.state).toBe('REACHED');
    expect(acceptOnly.stages.PAYMENT_AUTHORIZED.state).toBe('NOT_REACHED');
  });

  it('supports milestones, a rejected-and-redelivered restart, and a branch from the work', () => {
    const o = obligation('a1', 10_000, {
      delivery: {
        state: 'PARTIAL',
        portions: [
          { detail: 'part one', evidence: 'e1', at: '2026-06-02T00:00:00.000Z' },
          { detail: 'part two', evidence: 'e2', at: '2026-06-03T00:00:00.000Z' },
        ],
        evidence: null,
        deliveredAt: null,
      },
      acceptance: { state: 'REJECTED', condition: 'c', evidence: null, reason: 'wrong format' },
    });
    const r = derive([o], []);
    const d1 = r.transitions.find((t) => t.id === 'delivery:a1:1')!;
    const d2 = r.transitions.find((t) => t.id === 'delivery:a1:2')!;
    expect(d1.milestone).toBe('portion 1 of 2');
    expect(d2.milestone).toBe('portion 2 of 2');
    expect(d2.restartOf).toBe('delivery:a1:1');
    expect(d1.restartOf).toBeNull();
    expect(d1.branchOf).toBe('work:a1');
    expect(r.stages.WORK_ACCEPTED.state).toBe('REVERSED');
  });

  it('supports several purchasers and providers at once, deduplicated by role and ref', () => {
    const r = derive(
      [obligation('a1', 4_000), obligation('a2', 6_000)],
      [],
      {
        declared: [
          { id: 'd1', kind: 'agreement', action: 'Sign', holder: { role: 'purchaser', ref: 'buyer-A' } },
          { id: 'd2', kind: 'agreement', action: 'Sign', holder: { role: 'purchaser', ref: 'buyer-B' } },
          { id: 'd3', kind: 'agreement', action: 'Sign', holder: { role: 'purchaser', ref: 'buyer-A' } },
          { id: 'd4', kind: 'work', action: 'Do', parties: [{ role: 'provider', ref: 'p1' }, { role: 'provider', ref: 'p2' }] },
        ],
      },
    );
    const purchasers = r.parties.filter((p) => p.role === 'purchaser').map((p) => p.ref);
    expect(purchasers).toEqual(['buyer-A', 'buyer-B']);
    // prov-1 comes from both obligations' work rows and is listed once
    expect(r.parties.filter((p) => p.role === 'provider').map((p) => p.ref)).toEqual(['p1', 'p2', 'prov-1']);
    expect(r.stages.CONTRACT_SIGNED.amountCents).toBe(0); // from the ledger, not guessed from the rows
  });

  it('free-text kinds and roles are accepted: nothing is a whitelist', () => {
    const r = derive([], [], {
      declared: [{ id: 'x', kind: 'kiln firing slot', action: 'Fire the batch', holder: { role: 'potter', ref: 'p' }, deadline: '2026-06-20T00:00:00.000Z' }],
    });
    expect(r.transitions.find((t) => t.id === 'x')).toMatchObject({ kind: 'kiln firing slot', deadline: '2026-06-20T00:00:00.000Z' });
  });

  it('a declared step never overrides a row with the same id', () => {
    const r = derive([obligation('a1', 10_000)], [], { declared: [{ id: 'agreement:a1', kind: 'agreement', action: 'forged', outcome: 'FAILED' }] });
    const t = r.transitions.filter((x) => x.id === 'agreement:a1');
    expect(t).toHaveLength(1);
    expect(t[0]!.outcome).toBe('DONE');
  });

  it('overdue is a function of its inputs: a pending past-deadline duty, not a done one, not a future one', () => {
    const declared = [
      { id: 'late', kind: 'delivery', action: 'Deliver', deadline: '2026-06-05T00:00:00.000Z' },
      { id: 'done', kind: 'delivery', action: 'Deliver', deadline: '2026-06-05T00:00:00.000Z', outcome: 'DONE' as const },
      { id: 'future', kind: 'delivery', action: 'Deliver', deadline: '2026-07-01T00:00:00.000Z' },
      { id: 'undated', kind: 'delivery', action: 'Deliver' },
    ];
    expect(derive([], [], { declared }).overdue).toEqual(['late']);
    expect(derive([], [], { declared, now: '2026-06-01T00:00:00.000Z' }).overdue).toEqual([]);
  });

  it('carries external dependencies as stated and the same rows derive the same reading', () => {
    const dependencies = [{ kind: 'cancellation provision', detail: '48h notice', satisfied: false }];
    const a = derive([obligation('a1', 100)], [entry('PIPELINE_AGREED', 100)], { dependencies });
    expect(a.dependencies).toEqual(dependencies);
    const e = [entry('PIPELINE_AGREED', 100)];
    expect(derive([obligation('a1', 100)], e)).toEqual(derive([obligation('a1', 100)], e));
  });
});

/* ------------------------------------------------------------------ 29-2 */
const present = new Map<string, CapabilityState>([['MAKE_DOC', 'PRESENT'], ['MAKE_VIDEO', 'MISSING']]);
const scope: ScopeItem[] = [
  { key: 'doc', promise: 'a report', capabilityId: 'MAKE_DOC' },
  { key: 'video', promise: 'a film', capabilityId: 'MAKE_VIDEO', after: ['doc'] },
];

describe('LIFE-29-2: delivery derived from real scope', () => {
  it('derives steps from the scope in dependency order, and none from no scope', () => {
    const plan = deriveDeliveryPlan({ scope: [...scope].reverse(), parties: [], readings: present });
    expect(plan.steps.map((s) => s.key)).toEqual(['doc', 'video']);
    const empty = deriveDeliveryPlan({ scope: [], parties: [], readings: present });
    expect(empty.steps).toEqual([]);
    expect(empty.executable).toBe(false);
    expect(empty.problems.join(' ')).toMatch(/no scope/);
  });

  it('assigns Brain only a capability that reads PRESENT; unproven is UNASSIGNED and says why', () => {
    const plan = deriveDeliveryPlan({ scope, parties: [], readings: present });
    expect(plan.steps[0]).toMatchObject({ status: 'ASSIGNED', fulfiller: { kind: 'BRAIN_CAPABILITY', ref: 'MAKE_DOC' } });
    expect(plan.steps[1]).toMatchObject({ status: 'UNASSIGNED', fulfiller: null });
    expect(plan.steps[1]!.reasons.join(' ')).toContain('MISSING');
    expect(plan.unassigned).toEqual(['video']);
    expect(plan.executable).toBe(false);
  });

  it('an unread capability is UNKNOWN, never taken as present', () => {
    const plan = deriveDeliveryPlan({ scope: [{ key: 'x', promise: 'p', capabilityId: 'NEVER_READ' }], parties: [], readings: new Map() });
    expect(plan.steps[0]!.status).toBe('UNASSIGNED');
    expect(plan.steps[0]!.reasons.join(' ')).toContain('UNKNOWN');
  });

  it('never assigns the buyer as fulfiller, even when the buyer says they can do it', () => {
    const buyer: Party = { id: 'b', name: 'Acme', role: 'BUYER', canPerform: ['video', 'doc'] };
    const plan = deriveDeliveryPlan({ scope, parties: [buyer], readings: present });
    expect(plan.steps.every((s) => s.fulfiller?.ref !== 'b')).toBe(true);
    expect(plan.steps[1]).toMatchObject({ status: 'REFUSED', fulfiller: null });
    expect(plan.steps[1]!.reasons.join(' ')).toContain('is the buyer and cannot be the fulfiller');
    expect(plan.refused).toEqual(['video']);
    expect(plan.executable).toBe(false);
  });

  it('prefers an existing supplier over a sourced provider when Brain lacks the capability', () => {
    const parties: Party[] = [
      { id: 'prov', name: 'Prov', role: 'PROVIDER', canPerform: ['video'] },
      { id: 'sup', name: 'Sup', role: 'SUPPLIER', canPerform: ['video'] },
    ];
    const plan = deriveDeliveryPlan({ scope, parties, readings: present });
    expect(plan.steps[1]!.fulfiller).toEqual({ kind: 'EXISTING_SUPPLIER', ref: 'sup' });
    expect(plan.executable).toBe(true);
    const onlyProv = deriveDeliveryPlan({ scope, parties: [parties[0]!], readings: present });
    expect(onlyProv.steps[1]!.fulfiller).toEqual({ kind: 'SOURCED_PROVIDER', ref: 'prov' });
  });

  it('licensed responsibility stays with the licensed provider or accountable person, never Brain', () => {
    const lic: ScopeItem[] = [{ key: 'filing', promise: 'a tax filing', capabilityId: 'MAKE_DOC', accountable: true }];
    const noHolder = deriveDeliveryPlan({ scope: lic, parties: [], readings: present });
    expect(noHolder.steps[0]).toMatchObject({ status: 'UNASSIGNED', fulfiller: null });
    expect(noHolder.steps[0]!.reasons.join(' ')).toContain('licensed or accountable');
    // an unlicensed supplier does not absorb it either
    const unlicensed = deriveDeliveryPlan({ scope: lic, parties: [{ id: 's', name: 'S', role: 'SUPPLIER', canPerform: ['filing'] }], readings: present });
    expect(unlicensed.steps[0]!.fulfiller).toBeNull();
    const licensed = deriveDeliveryPlan({ scope: lic, parties: [{ id: 'cpa', name: 'CPA', role: 'SUPPLIER', licensed: true, canPerform: ['filing'] }], readings: present });
    expect(licensed.steps[0]).toMatchObject({ fulfiller: { kind: 'ACCOUNTABLE_PERSON', ref: 'cpa' } });
    expect(licensed.steps[0]!.responsibility).toContain('remains accountable');
  });

  it('refuses a scope that is duplicated, dangling or cyclic', () => {
    const dup = deriveDeliveryPlan({ scope: [scope[0]!, scope[0]!], parties: [], readings: present });
    expect(dup.problems.join(' ')).toContain('stated twice');
    const dangling = deriveDeliveryPlan({ scope: [{ key: 'a', promise: 'p', after: ['zz'] }], parties: [], readings: present });
    expect(dangling.problems.join(' ')).toContain('zz');
    const cycle = deriveDeliveryPlan({ scope: [{ key: 'a', promise: 'p', after: ['b'] }, { key: 'b', promise: 'p', after: ['a'] }], parties: [], readings: present });
    expect(cycle.problems.join(' ')).toContain('cycle');
    expect(cycle.executable).toBe(false);
  });
});

describe('LIFE-29-2: delivery and acceptance evidence, redo, truthful accounting', () => {
  const plan = deriveDeliveryPlan({
    scope: [{ key: 'a', promise: 'A', capabilityId: 'MAKE_DOC' }, { key: 'b', promise: 'B', capabilityId: 'MAKE_DOC' }],
    parties: [],
    readings: present,
  });
  const del = (stepKey: string, at = '2026-06-02T00:00:00.000Z', evidence = 'ev') => ({ stepKey, deliveredAt: at, evidence });
  const acc = (stepKey: string, outcome: 'ACCEPTED' | 'REJECTED', at = '2026-06-03T00:00:00.000Z', evidence = 'sig') => ({ stepKey, outcome, at, evidence });

  it('is realized only when every step is delivered and accepted with evidence and no redo is open', () => {
    const r = readRealization({ plan, deliveries: [del('a'), del('b')], acceptances: [acc('a', 'ACCEPTED'), acc('b', 'ACCEPTED')], redos: [] });
    expect(r.realized).toBe(true);
    const partial = readRealization({ plan, deliveries: [del('a'), del('b')], acceptances: [acc('a', 'ACCEPTED')], redos: [] });
    expect(partial.realized).toBe(false);
    expect(partial.awaitingAcceptance).toEqual(['b']);
  });

  it('refuses a record with no evidence or for a step the plan does not have, and names it', () => {
    const r = readRealization({ plan, deliveries: [del('a', undefined, '  '), del('ghost')], acceptances: [], redos: [] });
    expect(r.delivered).toEqual([]);
    expect(r.refusedRecords).toHaveLength(2);
    expect(r.refusedRecords.join(' ')).toContain('no such step');
  });

  it('an acceptance older than the delivery it judged does not accept the newer delivery', () => {
    const r = readRealization({
      plan,
      deliveries: [del('a', '2026-06-05T00:00:00.000Z'), del('b')],
      acceptances: [acc('a', 'ACCEPTED', '2026-06-03T00:00:00.000Z'), acc('b', 'ACCEPTED')],
      redos: [],
    });
    expect(r.accepted).toEqual(['b']);
    expect(r.awaitingAcceptance).toEqual(['a']);
    expect(r.realized).toBe(false);
  });

  it('a rejection is an open redo even when the agreement states none, and blocks realization', () => {
    const r = readRealization({ plan, deliveries: [del('a'), del('b')], acceptances: [acc('a', 'ACCEPTED'), acc('b', 'REJECTED')], redos: [] });
    expect(r.rejected).toEqual(['b']);
    expect(r.redoObligations).toEqual([expect.objectContaining({ stepKey: 'b', open: true })]);
    expect(r.realized).toBe(false);
  });

  it('a stated redo obligation stays open until the step is accepted', () => {
    const redos = [{ stepKey: 'a', obligation: 'fix typos within 7 days' }];
    const open = readRealization({ plan, deliveries: [del('a'), del('b')], acceptances: [acc('b', 'ACCEPTED')], redos });
    expect(open.redoObligations[0]!.open).toBe(true);
    const closed = readRealization({ plan, deliveries: [del('a'), del('b')], acceptances: [acc('a', 'ACCEPTED'), acc('b', 'ACCEPTED')], redos });
    expect(closed.redoObligations[0]!.open).toBe(false);
    expect(closed.realized).toBe(true);
  });

  it('accounting is exact when valid and null, with the reason, when it is not', () => {
    const ok = readRealization({ plan, deliveries: [], acceptances: [], redos: [], accounting: { billedCents: 1_000, receivedCents: 800, refundedCents: 100, costCents: 900 } });
    expect(ok.accounting).toMatchObject({ collectedCents: 700, contributionCents: -200, owedToUsCents: 200 });
    const none = readRealization({ plan, deliveries: [], acceptances: [], redos: [] });
    expect(none.accounting.collectedCents).toBeNull();
    expect(none.accounting.unknowns).toContain('no accounting figures stated');
    const bad = readRealization({ plan, deliveries: [], acceptances: [], redos: [], accounting: { billedCents: 1.5, receivedCents: 0, refundedCents: 0, costCents: 0 } });
    expect(bad.accounting.contributionCents).toBeNull();
    const over = readRealization({ plan, deliveries: [], acceptances: [], redos: [], accounting: { billedCents: 100, receivedCents: 100, refundedCents: 200, costCents: 0 } });
    expect(over.accounting.unknowns.join(' ')).toContain('refunds exceed');
  });
});

describe('LIFE-29-2: aftercare is economic evidence, and absence is unknown', () => {
  const at = '2026-06-08T00:00:00.000Z';
  it('keeps every relationship kind, with stated values and scores only where stated', () => {
    const r = recordAftercare([
      { kind: 'RENEWAL', partyId: 'c1', at, evidence: 'signed', valueCents: 5_000 },
      { kind: 'UPSELL', partyId: 'c1', at, evidence: 'email', valueCents: 1_000 },
      { kind: 'SATISFACTION', partyId: 'c2', at, evidence: 'survey', score: 0.8 },
      { kind: 'TRUST_OR_REPUTATION', partyId: 'c2', at, evidence: 'review', score: 0.4 },
      { kind: 'REFERRAL', partyId: 'c3', at, evidence: 'intro' },
    ]);
    expect(r.refused).toEqual([]);
    expect(r.repeatPartyIds).toEqual(['c1', 'c3']);
    expect(r.statedRepeatValueCents).toBe(6_000);
    expect(r.meanScore).toBeCloseTo(0.6);
    expect(recordAftercare([]).meanScore).toBeNull();
    expect(recordAftercare([]).statedRepeatValueCents).toBeNull();
  });

  it('refuses unevidenced, unknown, out-of-range or malformed records instead of coercing them', () => {
    const r = recordAftercare([
      { kind: 'RENEWAL', partyId: 'c1', at, evidence: '' },
      { kind: 'NOPE' as never, partyId: 'c1', at, evidence: 'x' },
      { kind: 'SATISFACTION', partyId: 'c1', at, evidence: 'x', score: 1.5 },
      { kind: 'RENEWAL', partyId: 'c1', at, evidence: 'x', valueCents: -5 },
      { kind: 'RENEWAL', partyId: '', at, evidence: 'x' },
      { kind: 'RENEWAL', partyId: 'c1', at: 'yesterday-ish', evidence: 'x' },
    ]);
    expect(r.evidence).toEqual([]);
    expect(r.refused).toHaveLength(6);
  });

  it('feeds deal construction per counterparty; a counterparty with none is simply absent (unknown)', () => {
    const e = aftercareEvidence(
      recordAftercare([
        { kind: 'SATISFACTION', partyId: 'c2', at, evidence: 'survey', score: 0.9 },
        { kind: 'RENEWAL', partyId: 'c1', at, evidence: 'signed', valueCents: 700 },
      ]),
    );
    expect(e).toEqual([
      { partyId: 'c1', repeat: true, statedValueCents: 700, evidenceCount: 1 },
      { partyId: 'c2', repeat: false, statedValueCents: null, evidenceCount: 1 },
    ]);
    expect(e.find((x) => x.partyId === 'never-bought')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ 29-3 */
const NO_AUTH: RemedyAuthority = { standing: [], approved: [] };

function reading(): CommitmentReading {
  return derive(
    [obligation('a1', 10_000)],
    [entry('PIPELINE_AGREED', 10_000), entry('CUSTOMER_PAYMENT', 10_000), entry('SETTLEMENT', 10_000), entry('UNPAID_COMMITMENT', 2_500, { commitmentId: 'sup-1' })],
    { dependencies: [{ kind: 'cancellation provision', detail: '48h notice' }, { kind: 'delivery location', detail: 'warehouse 4' }] },
  );
}

describe('LIFE-29-3: exceptions are detected as state changes', () => {
  it('detects a missed date from an overdue pending duty', () => {
    const r = derive([], [], { declared: [{ id: 'ship', kind: 'delivery', action: 'Ship', deadline: '2026-06-01T00:00:00.000Z', holder: { role: 'supplier', ref: 's' } }] });
    const found = detectExceptions(r);
    expect(found).toEqual([expect.objectContaining({ kind: 'MISSED_DATE', source: 'ROWS', transitionId: 'ship', raisedBy: { role: 'supplier', ref: 's' } })]);
  });

  it('detects a rejected delivery as a dispute carrying the amount in dispute', () => {
    const r = derive([obligation('a1', 10_000, { acceptance: { state: 'REJECTED', condition: 'c', evidence: 'e', reason: 'wrong colour' } })], []);
    const found = detectExceptions(r).filter((e) => e.kind === 'DISPUTE');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: 'ROWS', disputedCents: 10_000 });
    expect(found[0]!.detail).toContain('wrong colour');
  });

  it('detects a released commitment as a cancellation', () => {
    const released = obligation('a1', 10_000);
    (released.agreement as { releasedAt: string | null }).releasedAt = '2026-06-04T00:00:00.000Z';
    (released.agreement as { releasedReason: string | null }).releasedReason = 'customer cancelled';
    const found = detectExceptions(derive([released], []));
    expect(found.some((e) => e.kind === 'CANCELLATION' && e.detail.includes('customer cancelled'))).toBe(true);
  });

  it('detects a failed payment-stage transition as a payment failure', () => {
    const r = derive([], [], { declared: [{ id: 'pay1', kind: 'payment', action: 'Pay', stage: 'PAYMENT_AUTHORIZED', outcome: 'FAILED', outcomeDetail: 'card declined', amountCents: 4_000 }] });
    const found = detectExceptions(r);
    expect(found).toEqual([expect.objectContaining({ kind: 'PAYMENT_FAILURE', detail: 'payment: card declined', disputedCents: 4_000 })]);
  });

  it('takes a stated scope change with its value delta, keeping rows-detected and stated apart', () => {
    const signals: ExceptionSignal[] = [{ kind: 'SCOPE_CHANGE', at: '2026-06-06T00:00:00.000Z', detail: 'buyer cut two items', evidence: ['email-9'], valueDeltaCents: -3_000 }];
    const found = detectExceptions(derive([], []), signals);
    expect(found).toEqual([expect.objectContaining({ kind: 'SCOPE_CHANGE', source: 'STATED', valueDeltaCents: -3_000, evidence: ['email-9'] })]);
  });

  it('finds nothing in a healthy transaction', () => {
    const healthy = derive([accepted('a1', 100)], [entry('PIPELINE_AGREED', 100), entry('CUSTOMER_PAYMENT', 100), entry('SETTLEMENT', 100)]);
    expect(detectExceptions(healthy)).toEqual([]);
  });
});

describe('LIFE-29-3: consequences are quantified, and unstated stays null', () => {
  const dispute: DetectedException = { id: 'd', kind: 'DISPUTE', source: 'STATED', at: null, transitionId: null, detail: 'x', evidence: [], raisedBy: null, valueDeltaCents: null, disputedCents: 4_000 };

  it('counts refund exposure, supplier debt and binding terms; leaves non-binding terms out', () => {
    const c = quantifyConsequence(reading(), dispute);
    expect(c.refundExposureCents).toBe(10_000);
    expect(c.owedToSuppliersCents).toBe(2_500);
    expect(c.cashAtRiskCents).toBe(12_500);
    expect(c.disputedCents).toBe(4_000);
    expect(c.bindingTerms).toEqual(['cancellation provision: 48h notice']);
  });

  it('adds a stated value reduction to cash at risk', () => {
    const c = quantifyConsequence(reading(), { ...dispute, kind: 'SCOPE_CHANGE', valueDeltaCents: -3_000 });
    expect(c.cashAtRiskCents).toBe(15_500);
  });

  it('with no customer money recorded, exposure and cash at risk are null with a stated reason', () => {
    const c = quantifyConsequence(derive([], []), dispute);
    expect(c.refundExposureCents).toBeNull();
    expect(c.cashAtRiskCents).toBeNull();
    expect(c.unknowns.join(' ')).toContain('refund exposure is not stated');
  });
});

describe('LIFE-29-3: remedy selection stays inside authority', () => {
  const missed: DetectedException = { id: 'm', kind: 'MISSED_DATE', source: 'ROWS', at: null, transitionId: null, detail: 'late', evidence: [], raisedBy: null, valueDeltaCents: null, disputedCents: null };
  const dispute: DetectedException = { ...missed, id: 'dp', kind: 'DISPUTE', disputedCents: 4_000 };
  const select = (exception: DetectedException, facts = {}, authority: RemedyAuthority = NO_AUTH) =>
    selectRemedy({ reading: reading(), exception, facts, authority });

  it('chooses nothing without authority and names the one approval that is missing', () => {
    const s = select(missed, { rescheduleWindowAvailable: true });
    expect(s.chosen).toBeNull();
    expect(s.needs).toContain('standing authority for RESCHEDULE');
    expect(s.options.find((o) => o.remedy === 'RESCHEDULE')).toMatchObject({ feasible: true, withinAuthority: false });
  });

  it('chooses a feasible remedy that standing authority covers', () => {
    const s = select(missed, { rescheduleWindowAvailable: true }, { standing: ['RESCHEDULE'], approved: [] });
    expect(s.chosen?.remedy).toBe('RESCHEDULE');
    expect(s.needs).toBeNull();
  });

  it('never takes a remedy that is not feasible, whatever the authority', () => {
    const s = select(missed, {}, { standing: ['RESCHEDULE', 'SUBSTITUTE_PROVIDER', 'ESCALATE'], approved: [] });
    expect(s.chosen).toBeNull();
    expect(s.options.filter((o) => ['RESCHEDULE', 'SUBSTITUTE_PROVIDER', 'ESCALATE'].includes(o.remedy)).every((o) => !o.feasible && !o.withinAuthority)).toBe(true);
  });

  it('a committing remedy is never taken on standing authority alone, only on a named approval', () => {
    expect([...COMMITTING_REMEDIES].sort()).toEqual(['APPROVED_REFUND', 'ORDERLY_CANCELLATION', 'RENEGOTIATE_SCOPE']);
    const standingOnly = select(dispute, {}, { standing: ['APPROVED_REFUND', 'RENEGOTIATE_SCOPE'], approved: [] });
    expect(standingOnly.chosen).toBeNull();
    expect(standingOnly.needs).toContain('commits the company');
    const approved = select(dispute, {}, { standing: [], approved: [{ remedy: 'APPROVED_REFUND', approvedBy: 'peyton' }] });
    expect(approved.chosen?.remedy).toBe('APPROVED_REFUND');
  });

  it('an approval with a ceiling does not cover a remedy that costs more', () => {
    const s = select(dispute, {}, { standing: [], approved: [{ remedy: 'APPROVED_REFUND', approvedBy: 'peyton', ceilingCents: 1_000 }] });
    expect(s.chosen).toBeNull();
    expect(s.needs).toContain('peyton');
    expect(s.needs).toContain('4000');
  });

  it('refuses a refund when no customer money was collected', () => {
    const empty = selectRemedy({ reading: derive([], []), exception: dispute, facts: {}, authority: { standing: [], approved: [{ remedy: 'APPROVED_REFUND', approvedBy: 'p' }] } });
    expect(empty.options.find((o) => o.remedy === 'APPROVED_REFUND')).toMatchObject({ feasible: false, withinAuthority: false });
  });

  it('picks the cheapest authorized remedy and keeps unrelated work and settled obligations safe', () => {
    const s = select(dispute, { partialDeliveryPossible: true, escalationPath: true }, { standing: ['PARTIAL_DELIVERY', 'ESCALATE'], approved: [] });
    expect(s.chosen?.remedy).toBe('ESCALATE'); // stated cost 0 sorts before unstated
    expect(s.safeWork.join(' ')).toContain('honour supplier commitments already made');
  });

  it("a spending remedy is standing only when its stated cost fits under the grant's per-action ceiling", () => {
    const grant = { id: 'g', name: 'grant', policyVersion: 1 };
    const supplierOwed = reading(); // owes a supplier 2_500
    const inside = selectRemedy({ reading: supplierOwed, exception: missed, facts: { substituteProviderAvailable: true }, authority: { standing: ['SUBSTITUTE_PROVIDER'], approved: [], standingCeilingCents: 5_000, grant } });
    expect(inside.chosen?.remedy).toBe('SUBSTITUTE_PROVIDER');
    expect(inside.chosen?.authorizedBy).toContain('ENGAGE_CONTRACTOR');
    const over = selectRemedy({ reading: supplierOwed, exception: missed, facts: { substituteProviderAvailable: true }, authority: { standing: ['SUBSTITUTE_PROVIDER'], approved: [], standingCeilingCents: 1_000, grant } });
    expect(over.chosen).toBeNull();
    expect(over.needs).toContain('1000 cents per action');
  });

  it('the refund executor refuses without a named approver and above the approved ceiling, before touching any store', async () => {
    const base = { projectId: 'p', agreementId: 'a1', amountCents: 500, reason: 'dispute' };
    await expect(carryOutApprovedRefund({ ...base, approval: null })).resolves.toMatchObject({ ok: false });
    await expect(carryOutApprovedRefund({ ...base, approval: { approvedBy: '  ' } })).resolves.toMatchObject({ ok: false });
    const over = await carryOutApprovedRefund({ ...base, approval: { approvedBy: 'peyton', ceilingCents: 100 } });
    expect(over).toMatchObject({ ok: false });
    expect((over as { reason: string }).reason).toContain('100');
  });
});

describe('LIFE-29-3: the rehearsed failure-path trace', () => {
  const failedPayment = [{ id: 'pay1', kind: 'payment', action: 'Pay', stage: 'PAYMENT_AUTHORIZED' as const, outcome: 'FAILED' as const, outcomeDetail: 'card declined', holder: { role: 'buyer', ref: 'buyer-A' }, at: '2026-06-04T00:00:00.000Z' }];
  const entries = [entry('PIPELINE_AGREED', 10_000), entry('CUSTOMER_PAYMENT', 10_000), entry('SETTLEMENT', 10_000)];
  const r = derive([obligation('a1', 10_000)], entries, { declared: failedPayment });
  const selections = detectExceptions(r).map((exception) => selectRemedy({ reading: r, exception, facts: { alternateCollectionChannel: true }, authority: { standing: ['ALTERNATE_COLLECTION'], approved: [] } }));

  it('is a valid trace of a sourced case with a failure and a recovery decision', () => {
    const exceptionId = selections[0]!.exception.id;
    const t = traceCase({ sourceRef: 'order-77', reading: r, entries, selections, recovered: [{ exceptionId, remedy: 'ALTERNATE_COLLECTION', at: '2026-06-05T00:00:00.000Z', by: 'brain' }] });
    expect(t.valid).toBe(true);
    expect(t.sourceRef).toBe('order-77');
    const kinds = new Set(t.steps.map((s) => s.kind));
    for (const k of ['STATE_CHANGE', 'OBLIGATION', 'IDENTITY', 'MONEY', 'EXCEPTION', 'AUTHORITY', 'RECOVERY']) expect(kinds.has(k as never)).toBe(true);
    expect(t.steps.some((s) => s.kind === 'IDENTITY' && s.ref === 'buyer-A')).toBe(true);
    expect(t.steps.filter((s) => s.kind === 'MONEY')).toHaveLength(entries.length);
    expect(t.steps.find((s) => s.kind === 'AUTHORITY')!.detail).toContain('ALTERNATE_COLLECTION is within authority');
    const times = t.steps.map((s) => s.at ?? '9999');
    expect([...times].sort()).toEqual(times);
  });

  it('records which authority was missing when no remedy was allowed', () => {
    const none = detectExceptions(r).map((exception) => selectRemedy({ reading: r, exception, facts: { alternateCollectionChannel: true }, authority: NO_AUTH }));
    const t = traceCase({ sourceRef: 'order-77', reading: r, entries, selections: none });
    expect(t.valid).toBe(true);
    expect(t.steps.find((s) => s.kind === 'AUTHORITY')!.detail).toContain('no remedy within authority');
    expect(t.steps.some((s) => s.kind === 'RECOVERY')).toBe(false);
  });

  it('refuses to call itself a trace without a source, without transitions, or without a failure path', () => {
    expect(traceCase({ sourceRef: null, reading: r, entries, selections }).valid).toBe(false);
    expect(traceCase({ sourceRef: '   ', reading: r, entries, selections }).refusals.join(' ')).toContain('no source');
    const noFailure = traceCase({ sourceRef: 'order-77', reading: r, entries, selections: [] });
    expect(noFailure.valid).toBe(false);
    expect(noFailure.refusals.join(' ')).toContain('no failure path');
    const empty = traceCase({ sourceRef: 'x', reading: derive([], []), entries: [], selections });
    expect(empty.refusals.join(' ')).toContain('no transitions');
  });
});
