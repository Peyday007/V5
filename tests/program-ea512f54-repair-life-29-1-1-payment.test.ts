/**
 * LIFE-29-1 repair: a payment the provider confirmed on a piece with no
 * agreement on record — a transaction that skipped straight to paying — records
 * its agreement through the one writer (`recordAgreement`), with the provider's
 * receipt as PROVIDER_RECORD evidence, once. The commitment model then reads it
 * as contract signed and payment authorized, never as funds settled, and a term
 * nobody stated is never invented: a need names it instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { getOpportunity, listNeeds, transitionOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { agreementsFor } from '../server/repos/cashJourney.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { COMMERCIAL_EFFECTS, sendCommercialEffect, type PaymentTerms } from '../server/services/cash/effects.ts';
import { applyEffectOutcome, paymentTermsKey, prepare } from '../server/services/cash/perform.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { clearAdapters, registerAdapter, type EffectAdapter } from '../server/services/effects/adapter.ts';
import { CASH_OPPORTUNITY_STATES } from '../server/domain/types.ts';

let projectId = '';
let opportunityId = '';
let authorityId = '';
let receipts = 0;

function chargeProvider(): void {
  const adapter: EffectAdapter = {
    name: 'synthetic.accept_payment.life291',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: COMMERCIAL_EFFECTS.ACCEPT_PAYMENT.namespace.name,
    validate: (payload) => {
      if (payload === null || typeof payload !== 'object') throw new Error('not an object');
      return payload as Record<string, unknown>;
    },
    fingerprintInputs: (payload) => payload,
    send: async () => ({ kind: 'CONFIRMED', receiptRef: `pay-life291-${++receipts}` }),
  };
  registerAdapter(adapter);
}

beforeEach(async () => {
  receipts = 0;
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const userId = (
    await createUser({
      email: `life291p-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect(
    (await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok,
  ).toBe(true);
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Bookkeeping cleanup, paid up front', mechanism: 'OTHER', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  opportunityId = captured.value.id;
  await updateOpportunity(opportunityId, {
    payer: 'Acme Dental',
    offer_scope: 'Reconcile twelve months of books.',
    acceptance_condition: 'The owner signs off the reconciled ledger.',
    price_cents: 90_000,
  });
  expect(await transitionOpportunity({ id: opportunityId, from: [...CASH_OPPORTUNITY_STATES], to: 'EXECUTING' })).toBe(true);
  authorityId = (
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'grant',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 200_000,
      maxPerActionCents: 100_000,
      maxConcurrent: 3,
      currency: 'USD',
    })
  ).id;
  chargeProvider();
});

afterEach(() => clearAdapters());

async function takePayment(amountCents: number, terms: PaymentTerms | null, occurrence = '1') {
  const opportunity = (await getOpportunity(opportunityId))!;
  const outcome = await sendCommercialEffect({
    action: 'ACCEPT_PAYMENT',
    projectId,
    opportunityId,
    occurrence,
    payload: { payer: 'Acme Dental', amountCents, currency: 'USD', invoiceReference: null },
    authorityId,
    amountCents,
    stateAtSend: opportunity.state,
    subjectRef: null,
    terms,
  });
  const result = await applyEffectOutcome({ opportunity, action: 'ACCEPT_PAYMENT', occurrence, outcome, actorRef: 'BRAIN', amountCents });
  return { outcome, result, opportunity };
}

const kinds = async (kind: string) =>
  (await listMoneyEntries({ projectId, opportunityId, limit: 500 })).filter((one) => one.kind === kind);

describe('a payment that skips straight past agreement', () => {
  it('prepares a charge for the price on the card, carrying the stated terms', async () => {
    const prepared = await prepare('ACCEPT_PAYMENT', (await getOpportunity(opportunityId))!);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.amountCents).toBe(90_000);
    expect(prepared.value.terms).toEqual({
      deliverable: 'Reconcile twelve months of books.',
      acceptanceCondition: 'The owner signs off the reconciled ledger.',
    });
  });

  it('refuses to prepare a charge when the card leaves a term unstated', async () => {
    await updateOpportunity(opportunityId, { acceptance_condition: null });
    const prepared = await prepare('ACCEPT_PAYMENT', (await getOpportunity(opportunityId))!);
    expect(prepared.ok).toBe(false);
  });

  it('records exactly one PROVIDER_RECORD agreement and one PIPELINE_AGREED, and a replay records none', async () => {
    const terms = { deliverable: 'Reconcile twelve months of books.', acceptanceCondition: 'The owner signs off the reconciled ledger.' };
    const first = await takePayment(90_000, terms);
    expect(first.result.kind).toBe('RECORDED');
    const agreements = await agreementsFor(opportunityId);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      evidenceKind: 'PROVIDER_RECORD',
      evidenceRef: 'pay-life291-1',
      amountCents: 90_000,
      deliverable: terms.deliverable,
      acceptanceCondition: terms.acceptanceCondition,
      state: 'AGREED',
    });
    expect(await kinds('PIPELINE_AGREED')).toHaveLength(1);
    expect(await kinds('CUSTOMER_PAYMENT')).toHaveLength(1);

    // The same operation read again — the tick, or a second press — writes nothing.
    await applyEffectOutcome({ opportunity: first.opportunity, action: 'ACCEPT_PAYMENT', occurrence: '1', outcome: first.outcome, actorRef: 'BRAIN', amountCents: 90_000 });
    const replay = await takePayment(90_000, terms);
    expect(replay.result.kind).toBe('RECORDED');
    expect(await agreementsFor(opportunityId)).toHaveLength(1);
    expect(await kinds('PIPELINE_AGREED')).toHaveLength(1);
    expect(await kinds('CUSTOMER_PAYMENT')).toHaveLength(1);

    // The commitment model reads it: signed and authorized, not settled.
    const reading = await readCommitments({ projectId, opportunityId, currency: 'USD' });
    expect(reading.stages.CONTRACT_SIGNED.state).toBe('REACHED');
    expect(reading.stages.PAYMENT_AUTHORIZED.state).toBe('REACHED');
    expect(reading.stages.FUNDS_SETTLED.state).not.toBe('REACHED');
    expect(commitmentProblem(reading, { payments: 90_000, settlements: 0 })).toBeNull();

    // Settlement is a separate fact from a separate source, and only it settles funds.
    const settled = await recordMoneyEvent({
      projectId,
      opportunityId,
      kind: 'SETTLEMENT',
      amountCents: 90_000,
      currency: 'USD',
      verifiedReference: 'payout-life291-1',
      idempotencyKey: `settlement:${opportunityId}:payout-life291-1`,
      actorRef: 'BRAIN',
    });
    expect(settled.ok).toBe(true);
    const after = await readCommitments({ projectId, opportunityId, currency: 'USD' });
    expect(after.stages.FUNDS_SETTLED.state).toBe('REACHED');
    expect(commitmentProblem(after, { payments: 90_000, settlements: 90_000 })).toBeNull();
  });

  it('records no agreement for a payment whose acceptance condition was unstated, and names the missing term on a need', async () => {
    await takePayment(90_000, { deliverable: 'Reconcile twelve months of books.', acceptanceCondition: null });
    expect(await agreementsFor(opportunityId)).toHaveLength(0);
    expect(await kinds('PIPELINE_AGREED')).toHaveLength(0);
    expect(await kinds('CUSTOMER_PAYMENT')).toHaveLength(1);
    const needs = (await listNeeds({ projectId })).filter((one) => one.requestKey === paymentTermsKey(opportunityId, 'pay-life291-1'));
    expect(needs).toHaveLength(1);
    expect(needs[0]!.whyItMatters).toContain('what counts as acceptance');
    expect(needs[0]!.whyItMatters).not.toContain('what is being delivered');
  });

  it('records no agreement for a payment whose deliverable was unstated, and names it', async () => {
    await takePayment(90_000, { deliverable: null, acceptanceCondition: 'The owner signs off the reconciled ledger.' });
    expect(await agreementsFor(opportunityId)).toHaveLength(0);
    const needs = (await listNeeds({ projectId })).filter((one) => one.requestKey === paymentTermsKey(opportunityId, 'pay-life291-1'));
    expect(needs).toHaveLength(1);
    expect(needs[0]!.whyItMatters).toContain('what is being delivered');
  });

  it('adds nothing when the payment was drawn against an agreement already on record', async () => {
    const terms = { deliverable: 'Reconcile twelve months of books.', acceptanceCondition: 'The owner signs off the reconciled ledger.' };
    await takePayment(45_000, terms, '1');
    expect(await agreementsFor(opportunityId)).toHaveLength(1);
    // A second payment, against that agreement, carries no terms.
    await takePayment(45_000, null, '2');
    expect(await agreementsFor(opportunityId)).toHaveLength(1);
    expect(await kinds('PIPELINE_AGREED')).toHaveLength(1);
    expect((await listNeeds({ projectId })).filter((one) => one.requestKey?.startsWith('payment-terms:'))).toHaveLength(0);
  });
});
