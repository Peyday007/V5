/**
 * The first-dollar acceptance: one opportunity from ACTIVE Cash Mode to
 * collected, fulfilled, reconciled revenue, with the Brain restarted twice
 * mid-journey and every effect counted.
 *
 * Only the external provider boundary is simulated — three synthetic adapters
 * registered through `server/services/effects/adapter.ts`, exactly where a real
 * messaging, invoicing or payment integration registers. Everything inside
 * Brain is real: the Cash rows, the standing commercial grant, the opportunity
 * and its card, the effects engine and its idempotency ledger, the money
 * ledger, the journey tick's reconciliation, the fulfilment state machine,
 * and the routes a person's browser calls.
 *
 * A restart is `restartDatabase()` plus forgetting every adapter: the process
 * held nothing that mattered, so the rows have to carry the journey on their
 * own, and a re-registered provider must not be asked to do anything twice.
 *
 *   F01 — the sandbox first-dollar journey, end to end, restarted twice.
 *   F02 — the buyer disappears after contact: silence is derived, not invented.
 *   F03 — the buyer disappears after agreeing: the invoice expires, the
 *         agreement is released, and pipeline is undone by an entry.
 *   F04 — contact fails at the provider: nothing recorded, the piece holds.
 *   F05 — the payment fails at the provider: still owed, nothing paid.
 *   F06 — the invoice outcome is unknown: no invoice row, no resend, then a
 *         person settles it and exactly one invoice exists.
 *   F07 — partial payment, partial delivery and a refund, with every figure.
 *   F08 — fulfilment fails: the buyer rejects the work, nothing collects.
 *   F09 — the supplier's cost changes: the extra is a second commitment, and
 *         every cost is subtracted exactly once.
 *   F10 — Brain-delivered research: the work is read as performed from the
 *         mission's own row, and a person cannot attest to it instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import {
  capture,
  commitSpend,
  fillCard,
  recordMoneyEvent,
  settleSpend,
} from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { advanceWithinAuthority, operate } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';
import { actionsFor } from '../server/repos/cashActions.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { advanceJourney, RESPONSE_WINDOW_MS } from '../server/services/cash/journey/tick.ts';
import { dealPosition } from '../server/services/cash/journey/position.ts';
import { cashOutcomeLessons } from '../server/services/cash/journey/learning.ts';
import { readObligations } from '../server/services/cash/journey/fulfillment.ts';
import { agreementsFor, observationsFor, outcomesFor } from '../server/repos/cashJourney.ts';
import { draftInvoice, listInvoices, moveInvoice } from '../server/repos/cashInvoices.ts';
import { clearPaymentReader, registerPaymentReader } from '../server/services/cash/providers/payments.ts';
import type { InvoiceReading } from '../server/services/cash/providers/stripe.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import {
  clearAdapters,
  registerAdapter,
  type EffectAdapter,
  type ReconcileOutcome,
  type SendOutcome,
} from '../server/services/effects/adapter.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { CashOpportunity, Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let server: Server | null = null;
let base = '';

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_first_dollar',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'ADMIN',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `first-dollar-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  expect(
    (
      await activate({
        projectId,
        ownerUserId: userId,
        actorUserId: userId,
        objective: 'Take one legitimate opportunity to collected revenue.',
      })
    ).ok,
  ).toBe(true);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', cashRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  clearAdapters();
  clearPaymentReader();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function call<T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

const act = (opportunityId: string, action: string, body: unknown = {}) =>
  call('POST', `/api/cash/opportunities/${opportunityId}/${action}`, body);

const money = (body: Record<string, unknown>) => call('POST', `/api/projects/${projectId}/cash/money`, body);

async function granted(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/** A card complete enough that the tick marks it READY by itself. */
async function qualified(title = 'A published intake repair request'): Promise<CashOpportunity> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: 'BRAIN',
    patch: {
      payer: 'The operations manager, who signs',
      reachableChannel: 'ops@intake-buyer.example — the address on the notice',
      buyingSignal: 'Wanted: intake repair. Budget $1,200.',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  const piece = (await getOpportunity(captured.value.id))!;
  await applyProposal({ opportunity: piece, proposal: await proposeTerms(piece) });
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({
      projectId,
      opportunityId: piece.id,
      field,
      kind: 'EVIDENCE',
      value: `A published answer to ${field}.`,
      claimId: `clm_${field}`,
      decidedBy: 'BRAIN',
    });
  }
  return (await getOpportunity(piece.id))!;
}

interface Provider {
  sends: Record<string, unknown>[];
  onSend: (payload: Record<string, unknown>) => Promise<SendOutcome>;
  onReconcile: () => Promise<ReconcileOutcome>;
}

/**
 * The sandbox provider boundary. Its send counter lives in a module-level map
 * keyed by the operation, so a "restart" that forgets the adapter does not
 * forget how many times the outside world was actually asked.
 */
const outside: Record<string, Record<string, unknown>[]> = {};
function provider(
  action: keyof typeof COMMERCIAL_EFFECTS,
  prefix: string,
  effectClass: 'EXTERNAL_OPAQUE' | 'EXTERNAL_RECONCILABLE' = 'EXTERNAL_OPAQUE',
): Provider {
  outside[action] ??= [];
  const state: Provider = {
    sends: outside[action]!,
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `${prefix}-${state.sends.length}` }),
    onReconcile: async () => ({ kind: 'INCONCLUSIVE', reason: 'not visible yet' }),
  };
  const adapter: EffectAdapter = {
    name: `sandbox.${action.toLowerCase()}`,
    effectClass,
    ...(effectClass === 'EXTERNAL_RECONCILABLE' ? { reconcile: async () => await state.onReconcile() } : {}),
    namespace: COMMERCIAL_EFFECTS[action].namespace.name,
    validate: (payload) => {
      if (payload === null || typeof payload !== 'object') throw new Error('not an object');
      return payload as Record<string, unknown>;
    },
    fingerprintInputs: (payload) => payload,
    send: async (request) => {
      state.sends.push(request.payload);
      return await state.onSend(request.payload);
    },
  };
  registerAdapter(adapter);
  return state;
}

function resetOutside(): void {
  for (const key of Object.keys(outside)) delete outside[key];
  for (const key of Object.keys(ledger)) delete ledger[key];
}

/**
 * The provider's own account of each invoice, which the sandbox payment reader
 * answers from — the buyer paying a hosted page and the funds landing are both
 * things that happen *outside* Brain and that Brain only reads.
 */
const ledger: Record<string, InvoiceReading> = {};
function paymentReader(): void {
  registerPaymentReader({
    name: 'sandbox.invoice_payments',
    provider: 'sandbox',
    health: () => ({ usable: true, reason: 'sandbox' }),
    read: async (id) => ledger[id] ?? { kind: 'READ', status: 'open', hostedUrl: `https://pay.example/${id}`, number: `N-${id}`, amountPaidCents: 0, currency: 'USD', chargeId: null, paidAt: null, balance: null },
  });
}
function buyerPays(id: string, amountCents: number): void {
  ledger[id] = { kind: 'READ', status: 'paid', hostedUrl: null, number: `N-${id}`, amountPaidCents: amountCents, currency: 'USD', chargeId: `ch-${id}`, paidAt: new Date().toISOString(), balance: { id: `txn-${id}`, status: 'pending', currency: 'USD', amountCents, feeCents: 0, availableOn: null } };
}
function fundsLand(id: string, amountCents: number, feeCents: number): void {
  const read = ledger[id] as Extract<InvoiceReading, { kind: 'READ' }>;
  ledger[id] = { ...read, balance: { id: `txn-${id}`, status: 'available', currency: 'USD', amountCents, feeCents, availableOn: new Date().toISOString() } };
}
function providerSays(id: string, status: 'void' | 'uncollectible'): void {
  ledger[id] = { kind: 'READ', status, hostedUrl: null, number: `N-${id}`, amountPaidCents: 0, currency: 'USD', chargeId: null, paidAt: null, balance: null };
}
const TERMS = { customerName: 'Intake Buyer Ltd', customerEmail: 'accounts@intake-buyer.example', taxTreatment: 'NO_TAX_CHARGED', dueDate: '2099-01-31' };
async function requestInvoice(pieceId: string, body: Record<string, unknown> = TERMS) {
  return await call('POST', `/api/projects/${projectId}/cash/opportunities/${pieceId}/invoice`, body);
}
/** The tick's payment reads are rate-limited per invoice; step past it. */
let clock = Date.now();
async function tick(): Promise<void> {
  clock += 10 * 60 * 1000;
  await operate(projectId, new Date(clock).toISOString());
}

/** The process dies: the database is reopened and every adapter forgotten. */
async function restart(): Promise<void> {
  clearAdapters();
  await restartDatabase();
}

async function moneyCount(opportunityId: string): Promise<Record<string, number>> {
  const rows = await getDb().all<{ kind: string; n: number }>(
    'SELECT kind, COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? GROUP BY kind',
    [opportunityId],
  );
  return Object.fromEntries(rows.map((one) => [one.kind, Number(one.n)]));
}

async function agree(pieceId: string, amountCents: number, observationId?: string) {
  const agreed = await act(pieceId, 'agree', {
    amountCents,
    deliverable: 'Repair the intake form and confirm submissions arrive.',
    acceptanceCondition: 'Three test submissions arrive in the buyer’s inbox.',
    evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `buyer-email-${amountCents}`,
    ...(observationId ? { observationId } : {}),
  });
  expect(agreed.status).toBe(200);
  return agreed.body.agreement as { id: string; amountCents: number };
}

async function fulfilAndAccept(pieceId: string, agreementId: string): Promise<string> {
  const work = await act(pieceId, 'fulfil', { agreementId, kind: 'PERSON', performer: 'The operator' });
  expect(work.status).toBe(200);
  for (const [kind, evidenceRef] of [
    ['WORK_COMPLETE', 'form fixed; three test submissions sent'],
    ['DELIVERED', 'the repaired form, live'],
    ['ACCEPTED', 'buyer reply: all three arrived'],
  ] as const) {
    const done = await act(pieceId, 'obligation-event', { agreementId, kind, detail: kind.toLowerCase(), evidenceRef });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }
  return work.body.obligation.id as string;
}

describe('F01: the sandbox first-dollar journey', () => {
  it('discovers, contacts, agrees, invoices, collects, fulfils, settles and learns — restarted twice, nothing doubled', async () => {
    resetOutside();
    await granted();
    let contact = provider('CONTACT_BUYER', 'msg');
    let invoice = provider('QUOTE_AND_INVOICE', 'inv');
    paymentReader();
    const piece = await qualified();

    // READY_TO_TEST → a real action. The tick reaches the buyer through the
    // messaging adapter with the exact message and its version; EXECUTING
    // because a receipt exists, never because a state changed.
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    expect(contact.sends).toHaveLength(1);
    expect(contact.sends[0]).toMatchObject({
      to: 'ops@intake-buyer.example',
      text: expect.stringContaining('If you would rather not hear from us'),
      offerVersion: expect.stringMatching(/^offer-[0-9a-f]{16}$/),
      requestKey: expect.stringMatching(/^contact-buyer\./),
    });
    const [contacted] = await actionsFor(piece.id);
    expect(contacted).toMatchObject({ action: 'CONTACT_BUYER', performedBy: 'BRAIN', reference: 'msg-1' });

    // The buyer's reply is evidence, not hidden state.
    const reply = await act(piece.id, 'observe', {
      kind: 'BUYER_ACCEPTED',
      evidenceRef: 'buyer email 2026-10-04 "yes, go ahead at $1,200"',
    });
    expect(reply.status).toBe(200);

    // Restart #1, between the reply and the agreement.
    await restart();
    contact = provider('CONTACT_BUYER', 'msg');
    invoice = provider('QUOTE_AND_INVOICE', 'inv');
    paymentReader();
    await tick();
    expect(contact.sends).toHaveLength(1);

    // An invoice is refused until something is agreed — and a bare amount in
    // the ledger is not an agreement.
    expect((await requestInvoice(piece.id)).status).toBe(422);

    // The agreement: amount, deliverable, acceptance condition, evidence.
    const agreement = await agree(piece.id, 120_000, reply.body.observation.id);

    // The invoice: Brain's amount (the agreement's), the person's terms.
    const drafted = await requestInvoice(piece.id, { ...TERMS, amountCents: 1 });
    expect(drafted.status).toBe(200);
    expect(drafted.body.invoice).toMatchObject({ amountCents: 120_000, state: 'DRAFTED' });
    // A repeat is the same draft.
    expect((await requestInvoice(piece.id)).body.invoice.id).toBe(drafted.body.invoice.id);

    // The owner presses "have Brain do it": the same row, under its one key.
    const occurrence = async () =>
      (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    const issued = await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await occurrence() });
    expect(issued.status).toBe(200);
    expect(invoice.sends).toEqual([expect.objectContaining({ amountCents: 120_000, customerEmail: 'accounts@intake-buyer.example' })]);
    // A second press, and a tick, issue nothing more.
    expect((await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await occurrence() })).status).toBe(422);
    await tick();
    expect(invoice.sends).toHaveLength(1);

    // Restart #2, with the invoice out and unpaid.
    await restart();
    contact = provider('CONTACT_BUYER', 'msg');
    invoice = provider('QUOTE_AND_INVOICE', 'inv');
    paymentReader();
    await tick();
    expect(invoice.sends).toHaveLength(1);
    const [billed] = await listInvoices({ projectId, opportunityId: piece.id });
    expect(billed).toMatchObject({ state: 'ISSUED', providerInvoiceId: 'inv-1', amountCents: 120_000 });
    let deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('OUTSTANDING');
    expect(deal.pnl.owedByBuyerCents).toBe(120_000);

    // The buyer pays the hosted page. Brain reads it: earned, not cash.
    buyerPays('inv-1', 120_000);
    await tick();
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('PAID_UNSETTLED');
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(0);

    // Fulfilment: work created, performed, accepted on evidence.
    await fulfilAndAccept(piece.id, agreement.id);
    expect((await getOpportunity(piece.id))!.state).toBe('DELIVERING');
    await tick();
    expect((await readObligations(piece.id))[0]!.complete).toBe(true);
    // Not collected: the payment has not settled.
    expect((await getOpportunity(piece.id))!.state).toBe('DELIVERING');

    // A settlement larger than the payment is a second sale, and refused.
    expect(
      (
        await money({
          opportunityId: piece.id,
          kind: 'SETTLEMENT',
          amountCents: 240_000,
          verifiedReference: 'payout-double',
          idempotencyKey: `settlement:${piece.id}:payout-double`,
        })
      ).status,
    ).toBe(422);

    // The funds land at the provider, less its fee: one settlement, one fee.
    fundsLand('inv-1', 120_000, 3_510);
    await tick();

    // One incremental cost of our own, paid once.
    const held = await commitSpend({
      projectId,
      opportunityId: piece.id,
      action: 'PURCHASE_TOOL_OR_DATA',
      amountCents: 10_000,
      purpose: 'A form plugin licence the repair needs',
      expectedResult: 'The plugin is installed',
      stopCondition: 'One licence, no more',
      idempotencyKey: `plugin:${piece.id}`,
      actorRef: userId,
    });
    expect(held.ok).toBe(true);
    if (held.ok) expect((await settleSpend({ commitmentId: held.value.id, spentCents: 10_000, actorRef: userId })).ok).toBe(true);

    // Brain moved it to collected by itself, and learns from it.
    await tick();
    expect((await getOpportunity(piece.id))!.state).toBe('COLLECTED');
    await tick();

    // Profit and loss, from rows, each cost once.
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.stage).toBe('COMPLETE');
    expect(deal.pnl).toMatchObject({
      agreedRevenueCents: 120_000,
      invoicedCents: 120_000,
      customerPaymentsCents: 120_000,
      settledCashCents: 120_000,
      unsettledCents: 0,
      incrementalCostsCents: 13_510,
      unpaidCommitmentsCents: 0,
      contributionCents: 106_490,
      owedByBuyerCents: 0,
      invoiceableCents: 0,
    });
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.availableFundsCents).toBe(106_490);
    expect(position.deployableCents).toBe(106_490);

    // No duplicate effects, across two restarts and many ticks.
    expect([outside.CONTACT_BUYER!.length, outside.QUOTE_AND_INVOICE!.length]).toEqual([1, 1]);
    expect(await moneyCount(piece.id)).toEqual({
      PIPELINE_AGREED: 1,
      CUSTOMER_PAYMENT: 1,
      SETTLEMENT: 1,
      COST: 2,
    });
    expect(await agreementsFor(piece.id)).toHaveLength(1);
    expect(await listInvoices({ projectId, opportunityId: piece.id })).toEqual([
      expect.objectContaining({ state: 'SETTLED' }),
    ]);
    expect((await readObligations(piece.id)).filter((one) => one.fulfillment)).toHaveLength(1);
    expect((await actionsFor(piece.id)).map((one) => one.action)).toEqual(['CONTACT_BUYER', 'QUOTE_AND_INVOICE']);

    // What it taught, measured, and labelled as one result.
    const learned = await outcomesFor({ projectId, opportunityId: piece.id });
    expect([...new Set(learned.map((one) => one.kind))].sort()).toEqual(
      ['ACCEPTED_PRICE', 'ACTUAL_COST', 'CONTACT_RESULT', 'FULFILLMENT_DURATION', 'OFFERED_PRICE', 'REALIZED_CONTRIBUTION', 'TIME_TO_AGREEMENT'].sort(),
    );
    expect(learned.find((one) => one.kind === 'CONTACT_RESULT')!.valueText).toBe('BUYER_ACCEPTED');
    // The plugin cost landed after the deal collected: the first reading is
    // kept as history and the later one is the figure.
    expect(learned.filter((one) => one.kind === 'REALIZED_CONTRIBUTION').map((one) => one.valueCents)).toEqual([116_490, 106_490]);
    const [lesson] = await cashOutcomeLessons(projectId);
    expect(lesson).toMatchObject({
      mechanism: 'EXPLICIT_PAID_REQUEST',
      contacts: 1,
      answered: 1,
      agreements: 1,
      completed: 1,
      realizedContributionCents: 106_490,
      anecdote: true,
    });

    // The owner's one surface says all of it, from the server.
    const page = (await call('GET', `/api/projects/${projectId}/cash`)).body;
    const shown = page.myCurrentWork.journey.deals.find((one: any) => one.opportunityId === piece.id);
    expect(shown).toMatchObject({ stage: 'COMPLETE', paymentState: 'SETTLED' });
    expect(page.myCurrentWork.journey.totals).toMatchObject({ settledCashCents: 120_000, contributionCents: 106_490 });
  }, 120_000);
});

describe('failure, refund and partial paths', () => {
  beforeEach(() => resetOutside());

  it('F02: the buyer disappears after contact — silence is derived once, and nothing is agreed', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await advanceJourney(projectId, new Date(Date.now() + RESPONSE_WINDOW_MS - 60_000));
    expect((await observationsFor(piece.id)).filter((one) => one.kind === 'BUYER_SILENT')).toHaveLength(0);
    const later = new Date(Date.now() + RESPONSE_WINDOW_MS + 60_000);
    await advanceJourney(projectId, later);
    await advanceJourney(projectId, later);
    const silent = (await observationsFor(piece.id)).filter((one) => one.kind === 'BUYER_SILENT');
    expect(silent).toHaveLength(1);
    expect(silent[0]!.source).toBe('BRAIN');
    // A person cannot assert silence; Brain derives it.
    expect((await act(piece.id, 'observe', { kind: 'BUYER_SILENT', evidenceRef: 'nothing' })).status).toBe(422);
    // Silence is not terminal: nothing is learned from it while the deal is
    // open, so a late reply is learned as the reply rather than contradicting
    // a silence already written down.
    const contactResults = async () =>
      (await outcomesFor({ projectId, opportunityId: piece.id })).filter((one) => one.kind === 'CONTACT_RESULT');
    expect(await contactResults()).toHaveLength(0);
    expect((await act(piece.id, 'observe', { kind: 'BUYER_REPLIED', evidenceRef: 'late reply, day 9' })).status).toBe(200);
    await advanceJourney(projectId, later);
    await advanceJourney(projectId, later);
    expect((await contactResults()).map((one) => one.valueText)).toEqual(['BUYER_REPLIED']);
    const page = (await call('GET', `/api/projects/${projectId}/cash`)).body;
    const deal = page.myCurrentWork.journey.deals.find((one: any) => one.opportunityId === piece.id);
    expect(deal.next[0]).toMatchObject({ owner: 'PERSON' });
    expect(await moneyCount(piece.id)).toEqual({});
  });

  it('F03: the buyer disappears after agreeing — the invoice is voided at the provider and the agreement released by an entry', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const agreement = await agree(piece.id, 80_000);
    // Interest is not an agreement; an agreement with no evidence kind is refused.
    expect((await act(piece.id, 'agree', { amountCents: 80_000, deliverable: 'x', acceptanceCondition: 'y', evidenceKind: 'SEEMED_INTERESTED', evidenceRef: 'call' })).status).toBe(422);
    expect((await requestInvoice(piece.id)).status).toBe(200);
    await tick();
    expect((await listInvoices({ projectId, opportunityId: piece.id }))[0]!.state).toBe('ISSUED');

    // The buyer goes quiet and the agreement is released. The provider still
    // holds a payable invoice, so a need says to void it there — Brain does not
    // pretend it unsent anything.
    const released = await act(piece.id, 'release-agreement', { agreementId: agreement.id, reason: 'The buyer stopped answering after agreeing.' });
    expect(released.status).toBe(200);
    expect((await act(piece.id, 'release-agreement', { agreementId: agreement.id, reason: 'again' })).status).toBe(200);
    const page = (await call('GET', `/api/projects/${projectId}/cash`)).body;
    expect(page.whatBrainNeeds.some((one: any) => String(one.blockedAction).startsWith('Void invoice'))).toBe(true);
    providerSays('inv-1', 'void');
    await tick();
    expect((await listInvoices({ projectId, opportunityId: piece.id }))[0]!.state).toBe('VOID');
    const deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ agreedRevenueCents: 0, owedByBuyerCents: 0, invoiceableCents: 0 });
    expect((await cashPosition({ projectId, currency: 'USD' })).pipelineCents).toBe(0);
    expect(await moneyCount(piece.id)).toEqual({ PIPELINE_AGREED: 1, PIPELINE_RELEASED: 1 });
    // A release is not something the money route can write by itself.
    expect((await money({ opportunityId: piece.id, kind: 'PIPELINE_RELEASED', amountCents: 1, idempotencyKey: 'sneaky' })).status).toBe(422);
    // And a released agreement is not invoiced again.
    expect((await requestInvoice(piece.id)).status).toBe(422);
  });

  it('F04: contact fails at the provider — nothing recorded, nothing executing, a need names it', async () => {
    await granted();
    const contact = provider('CONTACT_BUYER', 'msg');
    contact.onSend = async () => ({ kind: 'REJECTED', category: 'PROVIDER_REJECTED', detail: 'mailbox does not exist', retryable: false });
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toEqual([]);
    expect((await act(piece.id, 'agree', { amountCents: 1_000, deliverable: 'x', acceptanceCondition: 'y', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: 'z' })).status).toBe(422);
  });

  it('F05: the payment fails — the buyer does not pay, the provider writes it off, nothing is cash', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 50_000);
    expect((await requestInvoice(piece.id)).status).toBe(200);
    await tick();
    // A failed card at the hosted page: the provider still says open.
    await tick();
    let deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('OUTSTANDING');
    expect(deal.pnl).toMatchObject({ owedByBuyerCents: 50_000, customerPaymentsCents: 0 });
    // There is no charge for Brain to perform: payment is read, not taken.
    const occ = (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    expect((await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: occ })).status).toBe(422);
    providerSays('inv-1', 'uncollectible');
    await tick();
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ owedByBuyerCents: 0, customerPaymentsCents: 0, invoiceableCents: 50_000 });
    expect((await act(piece.id, 'collect')).status).toBe(422);
    expect(await moneyCount(piece.id)).toEqual({ PIPELINE_AGREED: 1 });
  });

  it('F05b: Brain never charges beside an open invoice; once it is voided, the charge is the only payment', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    provider('ACCEPT_PAYMENT', 'pay');
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 100_000);
    expect((await requestInvoice(piece.id)).status).toBe(200);
    await tick();
    const [issued] = await listInvoices({ projectId, opportunityId: piece.id });
    expect(issued!.state).toBe('ISSUED');
    const record = async () => (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id];
    // Not offered, and refused if pressed anyway: the buyer pays the invoice.
    expect((await record()).brainCanDoNow).not.toContain('ACCEPT_PAYMENT');
    const refused = await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: (await record()).nextOccurrence });
    expect(refused.status).toBe(422);
    expect(outside.ACCEPT_PAYMENT ?? []).toHaveLength(0);
    // The invoice is voided at the provider; now Brain may charge directly.
    providerSays(issued!.providerInvoiceId!, 'void');
    await tick();
    expect((await listInvoices({ projectId, opportunityId: piece.id }))[0]!.state).toBe('VOID');
    const taken = await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: (await record()).nextOccurrence });
    expect(taken.status).toBe(200);
    expect(outside.ACCEPT_PAYMENT!).toHaveLength(1);
    expect(await moneyCount(piece.id)).toMatchObject({ CUSTOMER_PAYMENT: 1 });
    // Paid outside every invoice: the next agreement alone is billable.
    await agree(piece.id, 50_000);
    const deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl.invoiceableCents).toBe(50_000);
  });

  it('F05c: no invoice is requested or sent while Brain’s own charge is unresolved', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    const pay = provider('ACCEPT_PAYMENT', 'pay', 'EXTERNAL_RECONCILABLE');
    pay.onSend = async () => ({ kind: 'UNCERTAIN', reason: 'the connection reset after the charge left' });
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 100_000);
    const occ = (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    const charged = await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: occ });
    expect(charged.body.result.kind).toBe('UNCERTAIN');
    const asked = await requestInvoice(piece.id);
    expect(asked.status).toBe(422);
    expect(asked.body.error ?? JSON.stringify(asked.body)).toMatch(/still unresolved/);
    expect(await listInvoices({ projectId, opportunityId: piece.id })).toHaveLength(0);
    expect(outside.QUOTE_AND_INVOICE ?? []).toHaveLength(0);
  });

  it('F05d: a buyer who pays an invoice Brain’s charge already covered has a second payment on the record, and the next agreement stays billable', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    provider('ACCEPT_PAYMENT', 'pay');
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 100_000);
    const occ = (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    expect((await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: occ })).status).toBe(200);
    const [charge] = await getDb().all<{ id: string; pipeline: string }>(
      "SELECT e.id, (SELECT p.id FROM cash_money_entries p WHERE p.opportunity_id = e.opportunity_id AND p.kind = 'PIPELINE_AGREED') AS pipeline FROM cash_money_entries e WHERE e.opportunity_id = ? AND e.kind = 'CUSTOMER_PAYMENT'",
      [piece.id],
    );
    // The race the open-invoice refusal narrows: an invoice issued for the
    // same money while the charge was in flight, then paid by the charge.
    const { invoice } = await draftInvoice({
      projectId, opportunityId: piece.id, pipelineEntryId: charge!.pipeline, amountCents: 100_000, currency: 'USD',
      customerName: 'Intake Buyer Ltd', customerEmail: 'accounts@intake-buyer.example', taxTreatment: 'NO_TAX_CHARGED',
      dueDate: '2099-01-31', description: 'raced', requestedBy: 'test',
    });
    expect(await moveInvoice({ id: invoice.id, from: 'DRAFTED', to: 'ISSUED', patch: { provider: 'sandbox', providerInvoiceId: 'inv-race' } })).toBe(true);
    expect(await moveInvoice({ id: invoice.id, from: 'ISSUED', to: 'PAID', patch: { paymentEntryId: charge!.id, paidAt: new Date().toISOString() } })).toBe(true);
    // The buyer pays the invoice's page as well.
    buyerPays('inv-race', 100_000);
    fundsLand('inv-race', 100_000, 300);
    await tick();
    await tick();
    expect(await moneyCount(piece.id)).toMatchObject({ CUSTOMER_PAYMENT: 2, SETTLEMENT: 1 });
    const needs = await getDb().all<{ request_key: string }>("SELECT request_key FROM cash_needs WHERE project_id = ?", [projectId]);
    expect(needs.filter((one) => one.request_key === `invoice-paid-twice:${invoice.id}`)).toHaveLength(1);
    // The second payment is owed back, never credit against the next agreement.
    await agree(piece.id, 50_000);
    const deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl.invoiceableCents).toBe(50_000);
  });

  it('F06: the invoice outcome is unknown — no resend across a restart, then the provider confirms it once', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    let inv = provider('QUOTE_AND_INVOICE', 'inv', 'EXTERNAL_RECONCILABLE');
    inv.onSend = async () => ({ kind: 'UNCERTAIN', reason: 'the connection reset after the request left' });
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 60_000);
    expect((await requestInvoice(piece.id)).status).toBe(200);
    const occ = async () => (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    const first = await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await occ() });
    expect(first.body.result.kind).toBe('UNCERTAIN');
    expect((await listInvoices({ projectId, opportunityId: piece.id }))[0]!.state).toBe('UNCERTAIN');
    // A second invoice request finds the same row rather than a new one.
    expect((await requestInvoice(piece.id)).body.invoice.state).toBe('UNCERTAIN');
    await restart();
    inv = provider('QUOTE_AND_INVOICE', 'inv', 'EXTERNAL_RECONCILABLE');
    paymentReader();
    await tick();
    expect(outside.QUOTE_AND_INVOICE!.length).toBe(1);
    expect((await listInvoices({ projectId, opportunityId: piece.id }))[0]!.state).toBe('UNCERTAIN');
    // The provider answers the question it was asked: it does exist.
    inv.onReconcile = async () => ({ kind: 'FOUND', receiptRef: 'inv-found-1' });
    await tick();
    expect(await listInvoices({ projectId, opportunityId: piece.id })).toEqual([
      expect.objectContaining({ state: 'ISSUED', providerInvoiceId: 'inv-found-1', amountCents: 60_000 }),
    ]);
    expect(outside.QUOTE_AND_INVOICE!.length).toBe(1);
  });

  it('F07: partial payment, partial delivery and a refund — every figure from rows, no figure doubled', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    paymentReader();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const whole = await agree(piece.id, 100_000);
    expect((await requestInvoice(piece.id)).status).toBe(200);
    await tick();
    // The buyer pays part by bank transfer, recorded with its reference.
    // While an invoice is issued and unpaid, a hand-recorded payment must say
    // what it pays: unattributed, it cannot later be told from the provider's
    // own reading of the same money.
    expect((await money({ opportunityId: piece.id, kind: 'CUSTOMER_PAYMENT', amountCents: 40_000, verifiedReference: 'bank-40', idempotencyKey: `payment:${piece.id}:bank-40` })).status).toBe(422);
    // Part of the invoice, by transfer: not the invoice's whole payment.
    expect((await money({ opportunityId: piece.id, kind: 'CUSTOMER_PAYMENT', amountCents: 40_000, verifiedReference: 'bank-40', idempotencyKey: `payment:${piece.id}:bank-40`, outsideInvoices: true })).status).toBe(200);
    let deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('PARTIALLY_PAID');
    expect(deal.pnl.owedByBuyerCents).toBe(60_000);

    // Only part is delivered: the whole agreement is released, the part agreed
    // afresh, and the provider voids the original invoice.
    expect((await act(piece.id, 'release-agreement', { agreementId: whole.id, reason: 'Scope cut to the first form.' })).status).toBe(200);
    providerSays('inv-1', 'void');
    await tick();
    const part = await agree(piece.id, 40_000);
    await fulfilAndAccept(piece.id, part.id);
    await advanceJourney(projectId);
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ agreedRevenueCents: 40_000, owedByBuyerCents: 0, invoiceableCents: 0 });
    expect(deal.paymentState).toBe('PAID_UNSETTLED');

    // A refund of part of it goes through the obligation it pays back — never
    // the bare money route — and is never more than was paid.
    expect((await money({ opportunityId: piece.id, kind: 'REFUND', amountCents: 10_000, verifiedReference: 're-10', idempotencyKey: `manual-refund:${piece.id}:re-10` })).status).toBe(422);
    expect((await act(piece.id, 'refund', { agreementId: part.id, amountCents: 50_000, reason: 'Goodwill' })).status).toBe(422);
    const refunded = await act(piece.id, 'refund', { agreementId: part.id, amountCents: 10_000, reason: 'One form arrived late' });
    expect(refunded.status).toBe(200);
    const [refundKey] = refunded.body.obligation.refunds.map((one: { refundKey: string }) => one.refundKey);
    expect((await act(piece.id, 'refund-answer', { agreementId: part.id, refundKey, answer: 'confirm', reference: 're-10' })).status).toBe(200);
    expect((await money({ opportunityId: piece.id, kind: 'SETTLEMENT', amountCents: 40_000, verifiedReference: 'po-40', idempotencyKey: `settlement:${piece.id}:po-40` })).status).toBe(422);
    expect((await money({ opportunityId: piece.id, kind: 'SETTLEMENT', amountCents: 30_000, verifiedReference: 'po-30', idempotencyKey: `settlement:${piece.id}:po-30` })).status).toBe(200);
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ customerPaymentsCents: 40_000, refundsCents: 10_000, settledCashCents: 30_000, contributionCents: 30_000 });
    expect(deal.paymentState).toBe('PARTIALLY_PAID');
    // Paid net 30,000 against 40,000 agreed: not collectable.
    expect((await act(piece.id, 'collect')).status).toBe(422);
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(20_000);
  });

  it('F08: fulfilment fails — the buyer rejects the work, nothing collects, and a failure is learned', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const agreement = await agree(piece.id, 30_000);
    const step = (kind: string, evidenceRef: string) =>
      act(piece.id, 'obligation-event', { agreementId: agreement.id, kind, detail: kind.toLowerCase(), evidenceRef });
    expect((await act(piece.id, 'fulfil', { agreementId: agreement.id, kind: 'SUPPLIER', performer: 'Subcontractor', supplierName: 'Subcontractor Ltd' })).status).toBe(200);
    expect((await step('WORK_COMPLETE', 'the contractor says it is done')).status).toBe(200);
    expect((await step('DELIVERED', 'handed to the buyer')).status).toBe(200);
    expect((await step('REJECTED', 'buyer: submissions still bounce')).status).toBe(200);
    await advanceJourney(projectId);
    expect((await readObligations(piece.id))[0]).toMatchObject({ stage: 'REJECTED', complete: false });
    expect((await act(piece.id, 'collect')).status).toBe(422);
    // The supplier gives up: a recorded failure is final, and is learned once.
    expect((await step('SUPPLIER_FAILED', 'contractor withdrew')).status).toBe(200);
    expect((await step('DELIVERED', 'a second try')).status).toBe(422);
    await advanceJourney(projectId);
    await advanceJourney(projectId);
    expect((await outcomesFor({ projectId, opportunityId: piece.id })).filter((one) => one.kind === 'FAILURE_REASON')).toHaveLength(1);
  });

  it('F09: the supplier cost changes — the extra is a second commitment, each cost once', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    expect((await money({ kind: 'CAPITAL_IN', amountCents: 50_000, idempotencyKey: 'capital-1' })).status).toBe(200);
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 90_000);
    const commit = (amountCents: number, key: string) =>
      commitSpend({ projectId, opportunityId: piece.id, action: 'ENGAGE_CONTRACTOR', amountCents, purpose: 'The contractor who repairs it', expectedResult: 'The repair', stopCondition: 'This job only', idempotencyKey: key, actorRef: userId });
    const first = await commit(20_000, 'contractor-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Spending more than was held is a new commitment, not this one.
    expect((await settleSpend({ commitmentId: first.value.id, spentCents: 25_000, actorRef: userId })).ok).toBe(false);
    const extra = await commit(5_000, 'contractor-2');
    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    expect((await settleSpend({ commitmentId: first.value.id, spentCents: 20_000, actorRef: userId })).ok).toBe(true);
    expect((await settleSpend({ commitmentId: extra.value.id, spentCents: 5_000, actorRef: userId })).ok).toBe(true);
    const deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ incrementalCostsCents: 25_000, heldCommitmentsCents: 0, contributionCents: -25_000 });
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.availableFundsCents).toBe(25_000);
    expect(position.deployableCents).toBe(25_000);
    expect(position.heldCommitmentsCents).toBe(0);
  });

  it('F10: Brain-delivered research is read as complete from its mission, never attested', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const agreement = await agree(piece.id, 20_000);
    expect((await act(piece.id, 'fulfil', { agreementId: agreement.id, kind: 'RESEARCH', performer: 'Brain research' })).status).toBe(200);
    await advanceJourney(projectId);
    const [obligation] = await readObligations(piece.id);
    const idea = obligation!.work.ref!;
    expect(idea).toMatch(/^rcn_/);
    // Not attested by a person.
    expect((await act(piece.id, 'obligation-event', { agreementId: agreement.id, kind: 'WORK_COMPLETE', detail: 'trust me', evidenceRef: 'x' })).status).toBe(422);
    // Nothing complete while the mission runs.
    const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'Answer it', whyNow: 'A customer paid for it', idempotencyKey: `mission:${idea}`, candidateId: idea });
    expect((await readObligations(piece.id))[0]!.work.state).toBe('IN_PROGRESS');
    await linkMission({ missionId: mission.id, documentId: 'doc_answer', auditId: 'aud_answer' });
    expect(await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'DONE' })).toBe(true);
    expect((await readObligations(piece.id))[0]!.work).toMatchObject({ state: 'COMPLETE', artifact: 'doc_answer' });
  });
});
