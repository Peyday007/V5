/**
 * The one post-sale model, walked from a buyer's agreement to what the deal
 * taught (docs/POST-SALE.md).
 *
 * Every journey drives the real services against the real repositories and the
 * real ledger. What is simulated is the outside world only: a Factory campaign
 * finishing (a patched campaign row), a research mission filing (mission rows)
 * and a refund provider (a registered effect adapter). The assertions that
 * matter most are absences: no second piece of work, no second money entry, no
 * completion while anything is outstanding, no refund sent twice, no lesson
 * written twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import {
  actionKey,
  advance,
  archiveOpportunity,
  beginExecution,
  capture,
  fillCard,
  markReady,
  recordMoneyEvent,
} from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { cashPosition, contributionFrom } from '../server/services/cash/money.ts';
import { recordAgreement, releaseAgreement } from '../server/services/cash/journey/deal.ts';
import {
  advanceFulfillment,
  answerRefund,
  authorizeRefund,
  declare,
  readObligation,
  readObligations,
  recordCost,
  recordEvent,
  retryWork,
} from '../server/services/cash/journey/fulfillment.ts';
import { collectable, dealPosition } from '../server/services/cash/journey/position.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { cashOutcomeLessons, LESSON_MIN_SAMPLE, measuredByMechanism } from '../server/services/cash/journey/learning.ts';
import { requestInvoice, runInvoicing } from '../server/services/cash/invoicing.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import { ISSUE_INVOICE_NAMESPACE, REFUND_NAMESPACE } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { approveObjective } from '../server/services/factory/contract.ts';
import { ensureCampaign, factoryNow, listChangeRequests, patchCampaign } from '../server/repos/factory.ts';
import { getAgreement, outcomesFor } from '../server/repos/cashJourney.ts';
import { listInvoices, moveInvoice } from '../server/repos/cashInvoices.ts';
import { fulfillmentEvents } from '../server/repos/cashFulfillment.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getOperation, operationsByCorrelation } from '../server/repos/idempotency.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';

const exec = promisify(execFile);

let projectId = '';
let userId = '';
let repoRoot = '';

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `postsale-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const activated = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(activated.ok).toBe(true);
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000,
    maxPerActionCents: 200_000,
    maxConcurrent: 5,
    currency: 'USD',
  });
});

afterEach(() => {
  clearAdapters();
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  repoRoot = '';
});

/* ------------------------------------------------------------------------ */

async function executing(title = 'A paid intake repair', priceCents = 75_000, mechanism = 'EXPLICIT_PAID_REQUEST'): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: mechanism as 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs',
      reachableChannel: 'Replied on Tuesday',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `The owner's answer to ${field}.`, decidedBy: userId });
  }
  expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
  const began = await beginExecution({
    opportunityId: id,
    actorRef: userId,
    firstAction: {
      action: 'CONTACT_BUYER',
      performedBy: 'PERSON',
      detail: 'Sent the scope and price.',
      reference: `msg-${id}`,
      requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

async function agree(opportunityId: string, amountCents = 75_000, deliverable = 'Repair the intake form'): Promise<CashAgreement> {
  const done = await recordAgreement({
    opportunityId,
    amountCents,
    currency: 'USD',
    deliverable,
    acceptanceCondition: 'Form submits and a test enquiry arrives',
    evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `email-${opportunityId}-${deliverable}`,
    actorRef: userId,
  });
  if (!done.ok) throw new Error(done.reason);
  return done.value;
}

async function money(
  opportunityId: string,
  kind: 'CUSTOMER_PAYMENT' | 'SETTLEMENT' | 'REFUND',
  amountCents: number,
  reference: string,
): Promise<{ ok: boolean; reason?: string }> {
  const written = await recordMoneyEvent({
    projectId,
    opportunityId,
    kind,
    amountCents,
    currency: 'USD',
    verifiedReference: reference,
    idempotencyKey: `${kind}:${opportunityId}:${reference}`,
    actorRef: userId,
  });
  return written.ok ? { ok: true } : { ok: false, reason: written.reason };
}

const event = (agreement: CashAgreement, kind: string, evidenceRef: string | null = `ev-${kind}`, detail = kind.toLowerCase()) =>
  recordEvent({ projectId, agreementId: agreement.id, kind, detail, evidenceRef, actorRef: userId });

async function person(agreement: CashAgreement, kind: 'PERSON' | 'SUPPLIER' = 'PERSON') {
  const done = await declare({
    projectId,
    agreementId: agreement.id,
    kind,
    performer: kind === 'SUPPLIER' ? 'Contractor' : 'The owner',
    supplierName: kind === 'SUPPLIER' ? 'Contractor Ltd' : null,
    actorRef: userId,
  });
  if (!done.ok) throw new Error(done.reason);
  return done.value;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = await getDb().all<{ n: number }>(sql, params as never);
  return Number(rows[0]?.n ?? 0);
}

const ledgerCount = (opportunityId: string, kind: string) =>
  count('SELECT COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? AND kind = ?', [opportunityId, kind]);

async function openNeedKeys(): Promise<string[]> {
  return (await listNeeds({ projectId, states: ['OPEN'] }))
    .map((one) => one.requestKey ?? '')
    .filter((key) => key.startsWith('fulfillment:'))
    .sort();
}

function refundProvider(send: () => Promise<SendOutcome>): { sends: () => number; payloads: Record<string, unknown>[] } {
  let sends = 0;
  const payloads: Record<string, unknown>[] = [];
  registerAdapter({
    name: 'test.refund',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: REFUND_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (request) => {
      sends += 1;
      payloads.push(request.payload as Record<string, unknown>);
      return send();
    },
  });
  return { sends: () => sends, payloads };
}

async function position(opportunityId: string) {
  return await dealPosition({ opportunity: (await getOpportunity(opportunityId))!, currency: 'USD' });
}

/* ------------------------------------------------------------------------ */

describe('the canonical journey: agreement → invoice → payment → fulfillment → acceptance → settlement → contribution → learning', () => {
  it('walks one deal end to end, restarted twice, with every fact written once', async () => {
    const id = await executing();

    // Agreement: needs evidence; the ledger entry is written with it, once.
    expect(
      (
        await recordAgreement({
          opportunityId: id,
          amountCents: 75_000,
          currency: 'USD',
          deliverable: 'Repair the intake form',
          acceptanceCondition: 'Form submits',
          evidenceKind: 'WRITTEN_ACCEPTANCE',
          evidenceRef: '  ',
          actorRef: userId,
        })
      ).ok,
    ).toBe(false);
    const agreement = await agree(id);
    await agree(id); // the same agreement again is the same row
    expect(await ledgerCount(id, 'PIPELINE_AGREED')).toBe(1);

    // The obligation is asked for, once, and settled when declared.
    await Promise.all([advanceFulfillment(projectId), advanceFulfillment(projectId)]);
    expect(await openNeedKeys()).toEqual([`fulfillment:requirement:${agreement.id}`]);
    await person(agreement);
    await advanceFulfillment(projectId);
    expect(await openNeedKeys()).toEqual([]);

    // Invoice: the agreement's amount, and never more.
    const invoice = await requestInvoice({
      projectId,
      opportunityId: id,
      customerName: 'Owner',
      customerEmail: 'owner@buyer.example',
      taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31',
      actorRef: userId,
    });
    expect(invoice.ok && invoice.value.amountCents).toBe(75_000);

    await restartDatabase();

    // Payment: earned, not cash; partial keeps the rest outstanding.
    expect((await money(id, 'CUSTOMER_PAYMENT', 30_000, 'ch_part')).ok).toBe(true);
    let deal = await position(id);
    expect(deal.paymentState).toBe('PARTIALLY_PAID');
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(0);
    expect((await money(id, 'CUSTOMER_PAYMENT', 45_000, 'ch_rest')).ok).toBe(true);
    // One provider reference is one payment, whatever key it arrives under.
    expect(
      (
        await recordMoneyEvent({
          projectId,
          opportunityId: id,
          kind: 'CUSTOMER_PAYMENT',
          amountCents: 45_000,
          currency: 'USD',
          verifiedReference: 'ch_rest',
          idempotencyKey: 'another-key-same-charge',
          actorRef: userId,
        })
      ).ok,
    ).toBe(false);
    expect(await ledgerCount(id, 'CUSTOMER_PAYMENT')).toBe(2);

    // Fulfillment: work complete is not delivered; partial is not whole;
    // delivered is not accepted.
    expect((await event(agreement, 'WORK_COMPLETE')).ok).toBe(true);
    expect((await readObligation(agreement)).delivery.state).toBe('NOT_DELIVERED');
    expect((await event(agreement, 'PARTIALLY_DELIVERED', 'ev-part-1', 'the form, without email routing')).ok).toBe(true);
    expect((await getOpportunity(id))!.state).toBe('DELIVERING');
    let obligation = await readObligation(agreement);
    expect(obligation.delivery.state).toBe('PARTIAL');
    expect((await event(agreement, 'ACCEPTED')).ok).toBe(false);
    expect((await event(agreement, 'DELIVERED')).ok).toBe(true);
    obligation = await readObligation(agreement);
    expect([obligation.delivery.state, obligation.acceptance.state, obligation.complete]).toEqual([
      'DELIVERED',
      'AWAITING_ACCEPTANCE',
      false,
    ]);

    await restartDatabase();
    expect((await event(agreement, 'ACCEPTED')).ok).toBe(true);
    expect((await readObligation(agreement)).complete).toBe(true);
    // Completion is closed: nothing more is recorded except refunds.
    expect((await event(agreement, 'FAILED')).ok).toBe(false);

    // Not collected: paid but not settled is not cash.
    await advanceJourney(projectId);
    expect((await getOpportunity(id))!.state).toBe('DELIVERING');
    expect(collectable(await position(id)).ok).toBe(false);

    // Settlement: never more than was paid; one entry, and a fee is a cost once.
    expect((await money(id, 'SETTLEMENT', 80_000, 'po_too_much')).ok).toBe(false);
    expect((await money(id, 'SETTLEMENT', 75_000, 'po_1')).ok).toBe(true);
    expect((await recordCost({ projectId, agreementId: agreement.id, kind: 'INTERNAL_COST', amountCents: 2_475, detail: 'provider fee', reference: 'fee_1', actorRef: userId })).ok).toBe(true);
    expect((await recordCost({ projectId, agreementId: agreement.id, kind: 'INTERNAL_COST', amountCents: 2_475, detail: 'provider fee', reference: 'fee_1', actorRef: userId })).ok).toBe(true);
    expect(await ledgerCount(id, 'COST')).toBe(1);

    await advanceJourney(projectId);
    await advanceJourney(projectId);
    expect((await getOpportunity(id))!.state).toBe('COLLECTED');

    // Contribution: payments − refunds − costs − owed, from one formula.
    deal = await position(id);
    expect(deal.pnl.contributionCents).toBe(72_525);
    expect(deal.pnl.contributionCents).toBe(
      contributionFrom({ payments: 75_000, refunds: 0, costs: 2_475, unpaidCommitments: 0 }),
    );
    expect((await cashPosition({ projectId, opportunityId: id, currency: 'USD' })).completedContributionCents).toBe(72_525);

    // Learning: from terminal evidence, once, however many passes ask.
    const before = await outcomesFor({ projectId, opportunityId: id });
    await advanceJourney(projectId);
    await advanceJourney(projectId);
    const after = await outcomesFor({ projectId, opportunityId: id });
    expect(after.length).toBe(before.length);
    expect(after.filter((one) => one.kind === 'REALIZED_CONTRIBUTION').map((one) => one.valueCents)).toEqual([72_525]);
    expect(after.every((one) => one.basis.length > 0)).toBe(true);
    expect(after.some((one) => one.kind === 'FULFILLMENT_DURATION')).toBe(true);
  }, 60_000);
});

describe('agreement and invoice', () => {
  it('writes the agreement and its ledger entry as one decision, and the money route cannot fake either', async () => {
    const id = await executing();
    const agreement = await agree(id, 40_000);
    // A bare PIPELINE_AGREED, even under a key that looks like an agreement's.
    for (const key of ['agreed:x', `agreement:${agreement.id}`, 'agreement:cag_invented']) {
      const forged = await recordMoneyEvent({
        projectId,
        opportunityId: id,
        kind: 'PIPELINE_AGREED',
        amountCents: 99_000,
        currency: 'USD',
        idempotencyKey: key,
        actorRef: userId,
      });
      expect(forged.ok).toBe(false);
    }
    // A release only of a released agreement.
    const early = await recordMoneyEvent({
      projectId,
      opportunityId: id,
      kind: 'PIPELINE_RELEASED',
      amountCents: 40_000,
      currency: 'USD',
      idempotencyKey: `agreement-released:${agreement.id}`,
      actorRef: userId,
    });
    expect(early.ok).toBe(false);
    expect((await cashPosition({ projectId, currency: 'USD' })).pipelineCents).toBe(40_000);
  });

  it('invoices what is still owed — never money already paid — and bills again after a void', async () => {
    const id = await executing();
    await agree(id, 50_000);
    expect((await money(id, 'CUSTOMER_PAYMENT', 20_000, 'bank-20')).ok).toBe(true);
    const terms = {
      projectId,
      opportunityId: id,
      customerName: 'Owner',
      customerEmail: 'owner@buyer.example',
      taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31',
      actorRef: userId,
    };
    const first = await requestInvoice(terms);
    expect(first.ok && first.value.amountCents).toBe(30_000);
    if (!first.ok) return;
    // The provider voids it: history, and the agreement may be billed again.
    expect(await moveInvoice({ id: first.value.id, from: 'DRAFTED', to: 'VOID', patch: { stateReason: 'test void' } })).toBe(true);
    const second = await requestInvoice(terms);
    expect(second.ok && second.value.id).not.toBe(first.value.id);
    expect(second.ok && second.value.amountCents).toBe(30_000);
    expect(await listInvoices({ projectId, opportunityId: id })).toHaveLength(2);
    // Everything paid: nothing to invoice.
    expect((await money(id, 'CUSTOMER_PAYMENT', 30_000, 'bank-30')).ok).toBe(true);
    if (second.ok) await moveInvoice({ id: second.value.id, from: 'DRAFTED', to: 'VOID', patch: { stateReason: 'paid by bank' } });
    expect((await requestInvoice(terms)).ok).toBe(false);
  });

  it('money paid outside an invoice is never billed again, across two agreements', async () => {
    const id = await executing();
    await agree(id, 100_000, 'First half');
    await agree(id, 100_000, 'Second half');
    expect((await money(id, 'CUSTOMER_PAYMENT', 150_000, 'bank-150')).ok).toBe(true);
    const terms = (pipelineEntryId: string) => ({
      projectId,
      opportunityId: id,
      pipelineEntryId,
      customerName: 'Owner',
      customerEmail: 'owner@buyer.example',
      taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31',
      actorRef: userId,
    });
    const entries = (await getDb().all<{ id: string }>(
      "SELECT id FROM cash_money_entries WHERE opportunity_id = ? AND kind = 'PIPELINE_AGREED' ORDER BY created_at, id",
      [id],
    )).map((one) => one.id);
    const first = await requestInvoice(terms(entries[0]!));
    expect(first.ok && first.value.amountCents).toBe(50_000);
    // The old rule took the larger of billed and paid and billed 50k again here.
    expect((await requestInvoice(terms(entries[1]!))).ok).toBe(false);
    const billed = (await listInvoices({ projectId, opportunityId: id })).reduce((sum, one) => sum + one.amountCents, 0);
    expect(billed).toBe(50_000);
  });

  it('one payment recorded two ways is not counted twice', async () => {
    const id = await executing();
    await agree(id, 50_000);
    expect((await money(id, 'CUSTOMER_PAYMENT', 50_000, 'stripe-ch-1')).ok).toBe(true);
    const again = await money(id, 'CUSTOMER_PAYMENT', 50_000, 'INV-0001');
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already recorded as paid/);
    expect((await position(id)).pnl.contributionCents).toBe(50_000);
  });

  /** An issued invoice for the first live agreement, as the provider would leave it. */
  async function issuedInvoice(id: string, providerInvoiceId: string) {
    const [first] = await getDb().all<{ id: string }>(
      "SELECT id FROM cash_money_entries WHERE opportunity_id = ? AND kind = 'PIPELINE_AGREED' ORDER BY created_at, id",
      [id],
    );
    const drafted = await requestInvoice({
      projectId,
      opportunityId: id,
      pipelineEntryId: first!.id,
      customerName: 'Owner',
      customerEmail: 'owner@buyer.example',
      taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31',
      actorRef: userId,
    });
    if (!drafted.ok) throw new Error(drafted.reason);
    expect(await moveInvoice({ id: drafted.value.id, from: 'DRAFTED', to: 'ISSUED', patch: { providerInvoiceId } })).toBe(true);
    return drafted.value;
  }

  const providerRead = (id: string, invoiceId: string, amountCents: number, chargeId: string) =>
    recordMoneyEvent({
      projectId,
      opportunityId: id,
      kind: 'CUSTOMER_PAYMENT',
      amountCents,
      currency: 'USD',
      verifiedReference: chargeId,
      idempotencyKey: `invoice-payment:${invoiceId}`,
      actorRef: 'BRAIN',
      paidInvoiceId: invoiceId,
    });

  it('a hand-recorded payment names the invoice it pays, so the next agreement is still billed and the provider read is not a second payment', async () => {
    const id = await executing();
    await agree(id, 100_000, 'First half');
    await agree(id, 100_000, 'Second half');
    const invoice = await issuedInvoice(id, 'in_A');
    expect(invoice.amountCents).toBe(100_000);
    // Unattributed while the invoice is unpaid: refused, naming why.
    const bare = await money(id, 'CUSTOMER_PAYMENT', 100_000, 'bank-xyz');
    expect(bare.ok).toBe(false);
    expect(bare.reason).toMatch(/issued invoice still unpaid/);
    const named = await recordMoneyEvent({
      projectId,
      opportunityId: id,
      kind: 'CUSTOMER_PAYMENT',
      amountCents: 100_000,
      currency: 'USD',
      verifiedReference: 'bank-xyz',
      idempotencyKey: `payment:${id}:bank-xyz`,
      actorRef: userId,
      appliesTo: { invoiceId: invoice.id },
    });
    expect(named.ok).toBe(true);
    const [paid] = await listInvoices({ projectId, opportunityId: id });
    expect(paid!.state).toBe('PAID');
    // The second agreement is still billable (the review's under-billing case).
    expect((await position(id)).pnl.invoiceableCents).toBe(100_000);
    // The provider later reads the same money under its own reference: the
    // payment the invoice already names, not a second one.
    const read = await providerRead(id, invoice.id, 100_000, 'ch_A');
    expect(read.ok).toBe(true);
    expect(await ledgerCount(id, 'CUSTOMER_PAYMENT')).toBe(1);
  });

  it('a payment the provider confirmed is recorded even past the agreed total, so its invoice can settle', async () => {
    const id = await executing();
    await agree(id, 100_000);
    const invoice = await issuedInvoice(id, 'in_B');
    // A person records a transfer they say arrived outside the invoice.
    const outside = await recordMoneyEvent({
      projectId,
      opportunityId: id,
      kind: 'CUSTOMER_PAYMENT',
      amountCents: 100_000,
      currency: 'USD',
      verifiedReference: 'bank-1',
      idempotencyKey: `payment:${id}:bank-1`,
      actorRef: userId,
      appliesTo: 'OUTSIDE_INVOICES',
    });
    expect(outside.ok).toBe(true);
    // The buyer also paid the invoice: real money, recorded and visible as an overpayment.
    const read = await providerRead(id, invoice.id, 100_000, 'ch_B');
    expect(read.ok).toBe(true);
    const [paid] = await listInvoices({ projectId, opportunityId: id });
    expect(paid!.state).toBe('PAID');
    expect((await position(id)).pnl.customerPaymentsCents).toBe(200_000);
    // A second hand entry past the agreed total is still refused.
    expect((await money(id, 'CUSTOMER_PAYMENT', 1_000, 'bank-2')).ok).toBe(false);
  });

  it('an agreement released while its invoice was being sent leaves the provider’s invoice visible, not void', async () => {
    const id = await executing();
    const agreement = await agree(id, 40_000);
    let released = false;
    registerAdapter({
      name: 'test.invoice',
      effectClass: 'EXTERNAL_OPAQUE',
      namespace: ISSUE_INVOICE_NAMESPACE.name,
      validate: (payload) => payload as Record<string, unknown>,
      fingerprintInputs: (payload) => payload,
      send: async () => {
        // The release lands while the request is at the provider.
        released = (await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer withdrew.', actorRef: userId })).ok;
        return { kind: 'CONFIRMED', receiptRef: 'in_live_1' };
      },
    });
    const drafted = await requestInvoice({
      projectId,
      opportunityId: id,
      customerName: 'Owner',
      customerEmail: 'owner@buyer.example',
      taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31',
      actorRef: userId,
    });
    expect(drafted.ok).toBe(true);
    await runInvoicing(projectId);
    expect(released).toBe(true);
    const [invoice] = await listInvoices({ projectId, opportunityId: id });
    expect(invoice!.state).toBe('ISSUED');
    expect(invoice!.providerInvoiceId).toBe('in_live_1');
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).map((one) => one.requestKey);
    expect(needs).toContain(`void-released:${invoice!.id}`);
  });

  it('the buyer disappears after agreement: release writes its own entry and nothing is owed', async () => {
    const id = await executing();
    const agreement = await agree(id, 60_000);
    await person(agreement);
    const released = await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer stopped answering.', actorRef: userId });
    expect(released.ok).toBe(true);
    expect(await ledgerCount(id, 'PIPELINE_RELEASED')).toBe(1);
    expect((await position(id)).pnl.agreedRevenueCents).toBe(0);
    const obligation = await readObligation((await getAgreement(agreement.id))!);
    expect(obligation.stage).toBe('RELEASED');
    expect((await event(obligation.agreement, 'DELIVERED')).ok).toBe(false);
    expect((await advance({ opportunityId: id, to: 'COLLECTED', actorRef: userId })).ok).toBe(false);
  });
});

describe('fulfillment', () => {
  it('reads software completion from the Factory and never from a person', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postsale-repo-'));
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 's', scripts: { test: 'node -e "0"' } }));
    fs.mkdirSync(path.join(repoRoot, 'server'));
    fs.writeFileSync(path.join(repoRoot, 'server', 'one.txt'), 'one\n');
    for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'p@t'], ['config', 'user.name', 'P'], ['add', '-A'], ['commit', '-m', 'i', '--no-verify']]) {
      await exec('git', args, { cwd: repoRoot });
    }
    const id = await executing('A booking widget');
    const agreement = await agree(id, 75_000, 'Ship the booking widget');
    expect(
      (
        await declare({
          projectId,
          agreementId: agreement.id,
          kind: 'SOFTWARE',
          performer: 'The Software Factory',
          repositoryRoot: repoRoot,
          mutationScope: ['server/**'],
          actorRef: userId,
        })
      ).ok,
    ).toBe(true);
    await Promise.all([advanceFulfillment(projectId), advanceFulfillment(projectId)]);
    await advanceFulfillment(projectId);
    const requests = await listChangeRequests(projectId);
    expect(requests).toHaveLength(1);
    expect((await readObligation(agreement)).work.state).toBe('AWAITING_APPROVAL');
    expect((await event(agreement, 'WORK_COMPLETE', 'trust me')).ok).toBe(false);
    expect((await event(agreement, 'DELIVERED', 'too early')).ok).toBe(false);
    expect((await approveObjective({ changeRequestId: requests[0]!.id, via: 'PERSON', userId })).ok).toBe(true);
    const { campaign } = await ensureCampaign({
      changeRequestId: requests[0]!.id,
      projectId,
      baseSha: requests[0]!.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    await patchCampaign(campaign.id, { state: 'COMPLETE', integrationSha: 'abc', finishedAt: factoryNow(), prUrl: 'https://example/pr/7' });
    const built = await readObligation(agreement);
    expect([built.work.state, built.work.artifact, built.complete]).toEqual(['COMPLETE', 'https://example/pr/7', false]);
  });

  it('a rejection is not complete, a redelivery is a new round, and a recorded failure is final', async () => {
    const id = await executing();
    const agreement = await agree(id);
    await person(agreement);
    await event(agreement, 'WORK_COMPLETE');
    await event(agreement, 'DELIVERED', 'ev-delivered');
    expect((await event(agreement, 'REJECTED', 'buyer: still broken')).ok).toBe(true);
    let obligation = await readObligation(agreement);
    expect([obligation.stage, obligation.delivery.state, obligation.complete]).toEqual(['REJECTED', 'PARTIAL', false]);
    expect((await event(agreement, 'ACCEPTED')).ok).toBe(false);
    // The identical redelivery after a rejection is a new row, not the old one.
    expect((await event(agreement, 'DELIVERED', 'ev-delivered')).ok).toBe(true);
    obligation = await readObligation(agreement);
    expect(obligation.acceptance.state).toBe('AWAITING_ACCEPTANCE');
    expect((await fulfillmentEvents(obligation.fulfillment!.id)).filter((one) => one.kind === 'DELIVERED')).toHaveLength(2);
    expect((await event(agreement, 'FAILED', null, 'The buyer cancelled.')).ok).toBe(true);
    obligation = await readObligation(agreement);
    expect([obligation.stage, obligation.complete]).toEqual(['FAILED', false]);
    expect((await event(agreement, 'DELIVERED', 'ev-3')).ok).toBe(false);
    expect((await advance({ opportunityId: id, to: 'COLLECTED', actorRef: userId })).ok).toBe(false);
  });

  it('retries failed research work as a new attempt and keeps the failed one', async () => {
    const id = await executing();
    const agreement = await agree(id, 20_000, 'A sourced price survey');
    await declare({ projectId, agreementId: agreement.id, kind: 'RESEARCH', performer: 'Brain research', actorRef: userId });
    await advanceFulfillment(projectId);
    const firstRef = (await readObligation(agreement)).work.ref!;
    const { mission } = await launchMission({ projectId, visibility: 'SHARED', candidateId: firstRef, objective: 'Survey', whyNow: 'owed', idempotencyKey: `m-${firstRef}` });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'FAILED' });
    expect((await readObligation(agreement)).failure?.kind).toBe('WORK_FAILED');
    // Two retries at once release it once.
    const both = await Promise.all([
      retryWork({ projectId, agreementId: agreement.id, reason: 'Narrower question', actorRef: userId }),
      retryWork({ projectId, agreementId: agreement.id, reason: 'Narrower question', actorRef: userId }),
    ]);
    expect(both.filter((one) => one.ok)).toHaveLength(1);
    await advanceFulfillment(projectId);
    const retried = await readObligation(agreement);
    expect(retried.fulfillment!.workAttempt).toBe(1);
    expect(retried.work.ref).not.toBe(firstRef);
    expect(retried.failure).toBeNull();
    // The failed attempt's mission is still there.
    const second = await launchMission({ projectId, visibility: 'SHARED', candidateId: retried.work.ref!, objective: 'Survey', whyNow: 'owed', idempotencyKey: `m-${retried.work.ref}` });
    await linkMission({ missionId: second.mission.id, documentId: 'doc_survey', auditId: 'aud_survey' });
    await transitionMission({ missionId: second.mission.id, from: 'PLANNED', to: 'DONE' });
    expect((await readObligation(agreement)).work).toMatchObject({ state: 'COMPLETE', artifact: 'doc_survey' });
  });

  it('two agreements are two obligations: one delivered does not deliver the other', async () => {
    const id = await executing();
    const a = await agree(id, 30_000, 'Part one');
    const b = await agree(id, 20_000, 'Part two');
    for (const one of [a, b]) await person(one);
    for (const kind of ['WORK_COMPLETE', 'DELIVERED', 'ACCEPTED']) await event(a, kind);
    await money(id, 'CUSTOMER_PAYMENT', 50_000, 'ch_all');
    await money(id, 'SETTLEMENT', 50_000, 'po_all');
    const deal = await position(id);
    expect(deal.delivered).toBe(false);
    expect(collectable(deal).ok).toBe(false);
    for (const kind of ['WORK_COMPLETE', 'DELIVERED', 'ACCEPTED']) await event(b, kind);
    expect(collectable(await position(id)).ok).toBe(true);
  });
});

describe('supplier costs', () => {
  it('counts a supplier liability once, through a cost change and payment', async () => {
    const id = await executing();
    const agreement = await agree(id, 90_000);
    await person(agreement, 'SUPPLIER');
    const cost = (kind: string, amountCents: number, detail: string, reference: string | null = null) =>
      recordCost({ projectId, agreementId: agreement.id, kind, amountCents, detail, reference, actorRef: userId });
    expect((await cost('SUPPLIER_COMMITMENT', 30_000, 'Quoted job')).ok).toBe(true);
    expect((await cost('SUPPLIER_COMMITMENT', 30_000, 'Quoted job')).ok).toBe(true);
    expect((await position(id)).pnl.unpaidCommitmentsCents).toBe(30_000);
    // The supplier now costs less; never by more than is owed.
    expect((await cost('SUPPLIER_COST_REDUCED', 40_000, 'Too much')).ok).toBe(false);
    expect((await cost('SUPPLIER_COST_REDUCED', 5_000, 'Re-quoted lower')).ok).toBe(true);
    expect((await position(id)).pnl.unpaidCommitmentsCents).toBe(25_000);
    // Two payments at once close what was owed once.
    const paid = await Promise.all([
      cost('SUPPLIER_PAYMENT', 25_000, 'Paid the job', 'bank-1'),
      cost('SUPPLIER_PAYMENT', 25_000, 'Paid the job', 'bank-1'),
    ]);
    expect(paid.every((one) => one.ok)).toBe(true);
    const deal = await position(id);
    expect(deal.pnl).toMatchObject({ unpaidCommitmentsCents: 0, incrementalCostsCents: 25_000 });
    expect(await ledgerCount(id, 'COST')).toBe(1);
    expect(deal.pnl.contributionCents).toBe(-25_000);
  });
});

describe('refunds', () => {
  async function paidAndDelivered(amount = 50_000) {
    const id = await executing();
    const agreement = await agree(id, amount);
    await person(agreement);
    await money(id, 'CUSTOMER_PAYMENT', amount, `ch-${id}`);
    return { id, agreement };
  }

  it('cannot exceed what is refundable, counting refunds still unresolved', async () => {
    const { id, agreement } = await paidAndDelivered();
    const refund = (amountCents: number, reason: string) =>
      authorizeRefund({ projectId, agreementId: agreement.id, amountCents, reason, actorRef: userId });
    expect((await refund(60_000, 'too much')).ok).toBe(false);
    expect((await refund(30_000, 'half')).ok).toBe(true); // pending: no adapter
    expect((await refund(30_000, 'the rest')).ok).toBe(false); // 50k − 30k pending = 20k
    // The bare money route cannot refund an agreed deal at all.
    expect((await money(id, 'REFUND', 10_000, 're-bare')).ok).toBe(false);
    expect(await openNeedKeys()).toEqual([`fulfillment:refund:${(await readObligation(agreement)).fulfillment!.id}:${(await readObligation(agreement)).refunds[0]!.refundKey}`]);
  });

  it('two refunds authorized at once never add up to more than was paid', async () => {
    const { agreement } = await paidAndDelivered();
    const results = await Promise.all([
      authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 30_000, reason: 'first', actorRef: userId }),
      authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 30_000, reason: 'second', actorRef: userId }),
    ]);
    expect(results.filter((one) => one.ok)).toHaveLength(1);
  });

  it('a confirmed refund writes one REFUND with the provider receipt and carries the payment reference out', async () => {
    const provider = refundProvider(async () => ({ kind: 'CONFIRMED', receiptRef: 're_1' }));
    expect((await readCapability('ISSUE_A_REFUND')).state).toBe('PRESENT');
    const { id, agreement } = await paidAndDelivered();
    const done = await authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 10_000, reason: 'late', actorRef: userId });
    expect(done.ok && done.value.refunds[0]!.state).toBe('CONFIRMED');
    expect(provider.payloads[0]).toMatchObject({ paymentReferences: [`ch-${id}`] });
    await advanceFulfillment(projectId);
    await authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 10_000, reason: 'late', actorRef: userId });
    expect(provider.sends()).toBe(1);
    expect(await ledgerCount(id, 'REFUND')).toBe(1);
  });

  it('an unknown refund is never resent, and a person’s answer closes the effect itself', async () => {
    const provider = refundProvider(async () => ({ kind: 'UNCERTAIN', reason: 'the connection reset after the request left' }));
    const { id, agreement } = await paidAndDelivered();
    const sent = await authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 20_000, reason: 'broken', actorRef: userId });
    expect(sent.ok && sent.value.refunds[0]!.state).toBe('UNKNOWN');
    for (let i = 0; i < 3; i += 1) await advanceFulfillment(projectId);
    await restartDatabase();
    await advanceFulfillment(projectId);
    expect(provider.sends()).toBe(1);
    // Unknown still counts against what is refundable.
    expect((await authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 40_000, reason: 'more', actorRef: userId })).ok).toBe(false);
    const refundKey = sent.ok ? sent.value.refunds[0]!.refundKey : '';
    const answered = await answerRefund({ projectId, agreementId: agreement.id, refundKey, answer: 'not-sent', reference: 'provider shows none', actorRef: userId });
    expect(answered.ok).toBe(true);
    const ops = await operationsByCorrelation({ projectId, namespaces: [REFUND_NAMESPACE.name], correlationPrefix: 'refund:' });
    expect((await getOperation(ops[0]!.id))!.state).toBe('FAILED');
    expect(await ledgerCount(id, 'REFUND')).toBe(0);
    expect(provider.sends()).toBe(1);
  });

  it('a person’s answer cannot race Brain’s own send, and a provider’s terminal answer is not contradicted', async () => {
    const { id, agreement } = await paidAndDelivered();
    // Authorized while no refund integration existed: a person was asked.
    const authorized = await authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 10_000, reason: 'late', actorRef: userId });
    const refundKey = authorized.ok ? authorized.value.refunds[0]!.refundKey : '';
    // Then one is connected. Brain sends it; a person confirming first would
    // be paid out twice.
    const provider = refundProvider(async () => ({ kind: 'CONFIRMED', receiptRef: 're_9' }));
    const early = await answerRefund({ projectId, agreementId: agreement.id, refundKey, answer: 'confirm', reference: 'manual-1', actorRef: userId });
    expect(early.ok).toBe(false);
    await advanceFulfillment(projectId);
    expect(provider.sends()).toBe(1);
    expect(await ledgerCount(id, 'REFUND')).toBe(1);
    // The provider said it happened; it is not recorded as not sent.
    const contradict = await answerRefund({ projectId, agreementId: agreement.id, refundKey, answer: 'not-sent', reference: 'nothing', actorRef: userId });
    expect(contradict.ok).toBe(false);
    expect(await ledgerCount(id, 'REFUND')).toBe(1);
  });

  it('a failure after payment asks what is owed back, and a failed refund does not answer it', async () => {
    const { agreement } = await paidAndDelivered();
    await event(agreement, 'FAILED', null, 'Could not be done.');
    await advanceFulfillment(projectId);
    const fid = (await readObligation(agreement)).fulfillment!.id;
    expect(await openNeedKeys()).toContain(`fulfillment:refund-decision:${fid}`);
    const refunded = await authorizeRefund({ projectId, agreementId: agreement.id, amountCents: 50_000, reason: 'failed', actorRef: userId });
    const key = refunded.ok ? refunded.value.refunds[0]!.refundKey : '';
    await answerRefund({ projectId, agreementId: agreement.id, refundKey: key, answer: 'not-sent', reference: 'card expired', actorRef: userId });
    await advanceFulfillment(projectId);
    expect(await openNeedKeys()).toContain(`fulfillment:refund-decision:${fid}`);
  });
});

describe('restart, concurrency and learning', () => {
  it('concurrent ticks open one obligation of work, one need set and no duplicate events', async () => {
    const id = await executing();
    const agreement = await agree(id);
    await Promise.all([advanceJourney(projectId), advanceJourney(projectId), advanceJourney(projectId)]);
    expect(await openNeedKeys()).toEqual([`fulfillment:requirement:${agreement.id}`]);
    expect(await count("SELECT COUNT(*) AS n FROM cash_events WHERE project_id = ? AND kind = 'CASH_NEED_RAISED'", [projectId])).toBe(1);
    await person(agreement);
    await Promise.all([advanceJourney(projectId), advanceJourney(projectId)]);
    expect(await count("SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_FULFILLMENT_OPENED'", [id])).toBe(1);
  });

  it('a collected deal archived later is not learned as a failure', async () => {
    const id = await executing();
    const agreement = await agree(id, 20_000);
    await person(agreement);
    for (const kind of ['WORK_COMPLETE', 'DELIVERED', 'ACCEPTED']) await event(agreement, kind);
    await money(id, 'CUSTOMER_PAYMENT', 20_000, 'ch-a');
    await money(id, 'SETTLEMENT', 20_000, 'po-a');
    await advanceJourney(projectId);
    expect((await getOpportunity(id))!.state).toBe('COLLECTED');
    expect((await archiveOpportunity({ opportunityId: id, actorRef: userId, reason: 'Filed away.' })).ok).toBe(true);
    await advanceJourney(projectId);
    await advanceJourney(projectId);
    const outcomes = await outcomesFor({ projectId, opportunityId: id });
    expect(outcomes.filter((one) => one.kind === 'FAILURE_REASON')).toHaveLength(0);
    expect(outcomes.filter((one) => one.kind === 'REALIZED_CONTRIBUTION')).toHaveLength(1);
  });

  it('a lesson needs a sample on both sides of the ratio before it can steer ranking', async () => {
    const opportunities: string[] = [];
    for (let i = 0; i < LESSON_MIN_SAMPLE; i += 1) opportunities.push(await executing(`Piece ${i}`, 10_000));
    await advanceJourney(projectId);
    let lessons = await cashOutcomeLessons(projectId);
    // Contacts alone are not enough: nothing ended.
    expect(measuredByMechanism(lessons)).toEqual({});
    // One finished deal over three contacts is still one deal.
    const one = opportunities[0]!;
    const agreement = await agree(one, 10_000);
    await person(agreement);
    for (const kind of ['WORK_COMPLETE', 'DELIVERED', 'ACCEPTED']) await event(agreement, kind);
    await money(one, 'CUSTOMER_PAYMENT', 10_000, 'ch-1');
    await money(one, 'SETTLEMENT', 10_000, 'po-1');
    await advanceJourney(projectId);
    await advanceJourney(projectId);
    lessons = await cashOutcomeLessons(projectId);
    expect(lessons[0]!.completed).toBe(1);
    expect(measuredByMechanism(lessons)).toEqual({});
  });
});
