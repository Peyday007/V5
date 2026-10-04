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
import { recordPerformed } from '../server/services/cash/journey/deal.ts';
import {
  agreementsFor,
  fulfilmentsFor,
  invoicesFor,
  observationsFor,
  outcomesFor,
} from '../server/repos/cashJourney.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import {
  clearAdapters,
  registerAdapter,
  type EffectAdapter,
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
      reachableChannel: 'The address on the notice',
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
}

/**
 * The sandbox provider boundary. Its send counter lives in a module-level map
 * keyed by the operation, so a "restart" that forgets the adapter does not
 * forget how many times the outside world was actually asked.
 */
const outside: Record<string, Record<string, unknown>[]> = {};
function provider(action: keyof typeof COMMERCIAL_EFFECTS, prefix: string): Provider {
  outside[action] ??= [];
  const state: Provider = {
    sends: outside[action]!,
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `${prefix}-${state.sends.length}` }),
  };
  const adapter: EffectAdapter = {
    name: `sandbox.${action.toLowerCase()}`,
    effectClass: 'EXTERNAL_OPAQUE',
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
  const work = await act(pieceId, 'fulfil', {
    agreementId,
    path: 'PERSON',
    workKind: 'EXTERNAL',
    workRef: 'the operator repairs the form',
  });
  expect(work.status).toBe(200);
  const fulfilmentId = work.body.fulfilment.id as string;
  expect((await act(pieceId, 'performed', { fulfilmentId, evidence: 'form fixed; three test submissions sent' })).status).toBe(200);
  expect((await act(pieceId, 'observe', { kind: 'DELIVERY_ACCEPTED', evidenceRef: 'buyer reply: all three arrived' })).status).toBe(200);
  return fulfilmentId;
}

describe('F01: the sandbox first-dollar journey', () => {
  it('discovers, contacts, agrees, invoices, collects, fulfils, settles and learns — restarted twice, nothing doubled', async () => {
    resetOutside();
    await granted();
    let contact = provider('CONTACT_BUYER', 'msg');
    let invoice = provider('QUOTE_AND_INVOICE', 'inv');
    let payment = provider('ACCEPT_PAYMENT', 'pay');
    const piece = await qualified();

    // READY_TO_TEST → a real action. The tick reaches the buyer through the
    // adapter with the exact offer text and its version; EXECUTING because a
    // receipt exists, never because a state changed.
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    expect(contact.sends).toHaveLength(1);
    expect(contact.sends[0]).toMatchObject({
      offerText: expect.stringContaining('To: The operations manager, who signs'),
      offerVersion: expect.stringMatching(/^offer-[0-9a-f]{16}$/),
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
    payment = provider('ACCEPT_PAYMENT', 'pay');
    await operate(projectId);
    expect(contact.sends).toHaveLength(1);

    // The agreement: amount, deliverable, acceptance condition, evidence.
    const agreement = await agree(piece.id, 120_000, reply.body.observation.id);

    // Invoice exactly what is invoiceable against that agreement.
    const nextOccurrence = async () =>
      (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    const invoiced = await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await nextOccurrence() });
    expect(invoiced.status).toBe(200);
    expect(invoice.sends).toEqual([expect.objectContaining({ amountCents: 120_000, agreementId: agreement.id })]);
    // A second invoice for the same agreement is refused: nothing left to bill.
    const again = await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await nextOccurrence() });
    expect(again.status).toBe(422);
    expect(invoice.sends).toHaveLength(1);

    // Restart #2, between the invoice and the payment.
    await restart();
    contact = provider('CONTACT_BUYER', 'msg');
    invoice = provider('QUOTE_AND_INVOICE', 'inv');
    payment = provider('ACCEPT_PAYMENT', 'pay');
    await operate(projectId);
    expect(invoice.sends).toHaveLength(1);
    expect(await invoicesFor(piece.id)).toEqual([
      expect.objectContaining({ amountCents: 120_000, agreementId: agreement.id, providerRef: 'inv-1', state: 'ISSUED' }),
    ]);

    // The customer pays the outstanding invoice. Earned, not cash.
    const paid = await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: await nextOccurrence() });
    expect(paid.status).toBe(200);
    expect(payment.sends).toEqual([expect.objectContaining({ amountCents: 120_000, invoiceReference: 'inv-1' })]);
    let deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('PAID_UNSETTLED');
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(0);

    // Fulfilment: work created, performed, accepted on evidence.
    await fulfilAndAccept(piece.id, agreement.id);
    expect((await getOpportunity(piece.id))!.state).toBe('DELIVERING');
    // Not yet collected: the payment has not settled.
    await operate(projectId);
    expect((await fulfilmentsFor(piece.id))[0]!.state).toBe('DELIVERED');
    expect((await getOpportunity(piece.id))!.state).toBe('DELIVERING');

    // Settlement: the payment becoming cash, never a second sale.
    const overSettled = await money({
      opportunityId: piece.id,
      kind: 'SETTLEMENT',
      amountCents: 240_000,
      verifiedReference: 'payout-double',
      idempotencyKey: `settlement:${piece.id}:payout-double`,
    });
    expect(overSettled.status).toBe(422);
    const settled = await money({
      opportunityId: piece.id,
      kind: 'SETTLEMENT',
      amountCents: 120_000,
      verifiedReference: 'payout-1',
      idempotencyKey: `settlement:${piece.id}:payout-1`,
    });
    expect(settled.status).toBe(200);

    // One incremental cost, paid once.
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

    // Brain moves it to collected by itself, and learns from it.
    await operate(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('COLLECTED');
    await operate(projectId);

    // Profit and loss, from rows, each cost once.
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.stage).toBe('COMPLETE');
    expect(deal.pnl).toMatchObject({
      agreedRevenueCents: 120_000,
      invoicedCents: 120_000,
      customerPaymentsCents: 120_000,
      settledCashCents: 120_000,
      unsettledCents: 0,
      incrementalCostsCents: 10_000,
      unpaidCommitmentsCents: 0,
      contributionCents: 110_000,
      owedByBuyerCents: 0,
      invoiceableCents: 0,
    });
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.availableFundsCents).toBe(110_000);
    expect(position.deployableCents).toBe(110_000);

    // No duplicate effects, across two restarts and several ticks.
    expect([outside.CONTACT_BUYER!.length, outside.QUOTE_AND_INVOICE!.length, outside.ACCEPT_PAYMENT!.length]).toEqual([1, 1, 1]);
    expect(await moneyCount(piece.id)).toEqual({
      PIPELINE_AGREED: 1,
      CUSTOMER_PAYMENT: 1,
      SETTLEMENT: 1,
      COST: 1,
    });
    expect(await agreementsFor(piece.id)).toHaveLength(1);
    expect(await invoicesFor(piece.id)).toHaveLength(1);
    expect(await fulfilmentsFor(piece.id)).toHaveLength(1);
    expect((await actionsFor(piece.id)).map((one) => one.action)).toEqual([
      'CONTACT_BUYER',
      'QUOTE_AND_INVOICE',
      'ACCEPT_PAYMENT',
    ]);

    // What it taught, measured, and labelled as one result.
    const learned = await outcomesFor({ projectId, opportunityId: piece.id });
    expect(learned.map((one) => one.kind).sort()).toEqual(
      ['ACCEPTED_PRICE', 'ACTUAL_COST', 'CONTACT_RESULT', 'FULFILMENT_DURATION', 'OFFERED_PRICE', 'REALIZED_CONTRIBUTION', 'TIME_TO_AGREEMENT'].sort(),
    );
    expect(learned.find((one) => one.kind === 'CONTACT_RESULT')!.valueText).toBe('BUYER_ACCEPTED');
    expect(learned.find((one) => one.kind === 'REALIZED_CONTRIBUTION')!.valueCents).toBe(110_000);
    const [lesson] = await cashOutcomeLessons(projectId);
    expect(lesson).toMatchObject({ mechanism: 'EXPLICIT_PAID_REQUEST', contacts: 1, answered: 1, agreements: 1, completed: 1, anecdote: true });

    // The owner's one surface says all of it, from the server.
    const page = (await call('GET', `/api/projects/${projectId}/cash`)).body;
    const shown = page.myCurrentWork.journey.deals.find((one: any) => one.opportunityId === piece.id);
    expect(shown).toMatchObject({ stage: 'COMPLETE', paymentState: 'SETTLED' });
    expect(page.myCurrentWork.journey.totals).toMatchObject({ settledCashCents: 120_000, contributionCents: 110_000 });
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
    expect((await outcomesFor({ projectId, opportunityId: piece.id })).find((one) => one.kind === 'CONTACT_RESULT')!.valueText).toBe('BUYER_SILENT');
    const page = (await call('GET', `/api/projects/${projectId}/cash`)).body;
    const deal = page.myCurrentWork.journey.deals.find((one: any) => one.opportunityId === piece.id);
    expect(deal.next[0]).toMatchObject({ owner: 'PERSON' });
    expect(await moneyCount(piece.id)).toEqual({});
  });

  it('F03: the buyer disappears after agreeing — the invoice expires and the agreement is released by an entry', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const agreement = await agree(piece.id, 80_000);
    // Interest is not an agreement; an agreement with no evidence is refused.
    expect((await act(piece.id, 'agree', { amountCents: 80_000, deliverable: 'x', acceptanceCondition: 'y', evidenceKind: 'SEEMED_INTERESTED', evidenceRef: 'call' })).status).toBe(422);
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const invoiced = await act(piece.id, 'record-invoice', { agreementId: agreement.id, amountCents: 80_000, providerRef: 'INV-77', dueAt: due });
    expect(invoiced.status).toBe(200);
    // A second invoice beyond the agreement is refused.
    expect((await act(piece.id, 'record-invoice', { agreementId: agreement.id, amountCents: 1, providerRef: 'INV-78' })).status).toBe(422);
    await advanceJourney(projectId, new Date(Date.now() + 2 * 86_400_000));
    expect((await invoicesFor(piece.id))[0]!.state).toBe('EXPIRED');
    let deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl.owedByBuyerCents).toBe(0);
    expect(deal.pnl.invoiceableCents).toBe(80_000);

    const released = await act(piece.id, 'release-agreement', { agreementId: agreement.id, reason: 'The buyer stopped answering after agreeing.' });
    expect(released.status).toBe(200);
    expect((await act(piece.id, 'release-agreement', { agreementId: agreement.id, reason: 'again' })).status).toBe(200);
    await advanceJourney(projectId);
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl.agreedRevenueCents).toBe(0);
    expect((await cashPosition({ projectId, currency: 'USD' })).pipelineCents).toBe(0);
    expect(await moneyCount(piece.id)).toEqual({ PIPELINE_AGREED: 1, PIPELINE_RELEASED: 1 });
    // A release is not something the money route can write by itself.
    expect((await money({ opportunityId: piece.id, kind: 'PIPELINE_RELEASED', amountCents: 1, idempotencyKey: 'sneaky' })).status).toBe(422);
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

  it('F05: the payment fails at the provider — still owed, nothing paid, nothing collected', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    provider('QUOTE_AND_INVOICE', 'inv');
    const pay = provider('ACCEPT_PAYMENT', 'pay');
    pay.onSend = async () => ({ kind: 'REJECTED', category: 'PROVIDER_REJECTED', detail: 'card declined', retryable: false });
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 50_000);
    const occ = async () => (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    expect((await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await occ() })).status).toBe(200);
    const tried = await act(piece.id, 'perform', { action: 'ACCEPT_PAYMENT', expectedOccurrence: await occ() });
    expect(tried.body.result.kind).toBe('FAILED');
    const deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('OUTSTANDING');
    expect(deal.pnl).toMatchObject({ owedByBuyerCents: 50_000, customerPaymentsCents: 0 });
    expect((await act(piece.id, 'collect')).status).toBe(422);
  });

  it('F06: the invoice outcome is unknown — no invoice row, no resend; settled by a person, exactly one', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const inv = provider('QUOTE_AND_INVOICE', 'inv');
    inv.onSend = async () => ({ kind: 'UNCERTAIN', reason: 'the connection reset after the request left' });
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await agree(piece.id, 60_000);
    const occ = async () => (await call('GET', `/api/projects/${projectId}/cash`)).body.myCurrentWork.records[piece.id].nextOccurrence;
    const first = await act(piece.id, 'perform', { action: 'QUOTE_AND_INVOICE', expectedOccurrence: await occ() });
    expect(first.body.result.kind).toBe('UNCERTAIN');
    expect(await invoicesFor(piece.id)).toEqual([]);
    await restart();
    provider('QUOTE_AND_INVOICE', 'inv');
    await operate(projectId);
    expect(outside.QUOTE_AND_INVOICE!.length).toBe(1);
    expect(await invoicesFor(piece.id)).toEqual([]);
    const resolved = await act(piece.id, 'resolve-effect', {
      operationId: first.body.result.operationId,
      happened: true,
      receiptRef: 'INV-CHECKED-1',
      note: 'Checked the invoicing provider; it was issued.',
    });
    expect(resolved.status).toBe(200);
    await operate(projectId);
    expect(await invoicesFor(piece.id)).toEqual([expect.objectContaining({ amountCents: 60_000, providerRef: 'INV-CHECKED-1' })]);
    expect(outside.QUOTE_AND_INVOICE!.length).toBe(1);
  });

  it('F07: partial payment, partial delivery and a refund — every figure from rows, no figure doubled', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const whole = await agree(piece.id, 100_000);
    expect((await act(piece.id, 'record-invoice', { agreementId: whole.id, amountCents: 100_000, providerRef: 'INV-100' })).status).toBe(200);
    expect((await money({ opportunityId: piece.id, kind: 'CUSTOMER_PAYMENT', amountCents: 40_000, verifiedReference: 'pi-40', idempotencyKey: `payment:${piece.id}:pi-40` })).status).toBe(200);
    let deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.paymentState).toBe('PARTIALLY_PAID');
    expect(deal.pnl.owedByBuyerCents).toBe(60_000);

    // Only part is delivered: the whole agreement is released and the part
    // agreed afresh, so no row is edited and the first agreement stays readable.
    expect((await act(piece.id, 'release-agreement', { agreementId: whole.id, reason: 'Scope cut to the first form.' })).status).toBe(200);
    const part = await agree(piece.id, 40_000);
    await fulfilAndAccept(piece.id, part.id);
    await advanceJourney(projectId);
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ agreedRevenueCents: 40_000, owedByBuyerCents: 0, invoiceableCents: 0 });
    expect((await invoicesFor(piece.id))[0]!.state).toBe('VOID');
    expect(deal.paymentState).toBe('PAID_UNSETTLED');

    // A refund of part of it: never more than was paid.
    expect((await money({ opportunityId: piece.id, kind: 'REFUND', amountCents: 50_000, verifiedReference: 're-50', idempotencyKey: `refund:${piece.id}:re-50` })).status).toBe(422);
    expect((await money({ opportunityId: piece.id, kind: 'REFUND', amountCents: 10_000, verifiedReference: 're-10', idempotencyKey: `refund:${piece.id}:re-10` })).status).toBe(200);
    expect((await money({ opportunityId: piece.id, kind: 'SETTLEMENT', amountCents: 40_000, verifiedReference: 'po-40', idempotencyKey: `settlement:${piece.id}:po-40` })).status).toBe(422);
    expect((await money({ opportunityId: piece.id, kind: 'SETTLEMENT', amountCents: 30_000, verifiedReference: 'po-30', idempotencyKey: `settlement:${piece.id}:po-30` })).status).toBe(200);
    deal = await dealPosition({ opportunity: (await getOpportunity(piece.id))!, currency: 'USD' });
    expect(deal.pnl).toMatchObject({ customerPaymentsCents: 40_000, refundsCents: 10_000, settledCashCents: 30_000, contributionCents: 30_000 });
    expect(deal.paymentState).toBe('PARTIALLY_PAID');
    // Paid net 30,000 against 40,000 agreed: not collectable.
    expect((await act(piece.id, 'collect')).status).toBe(422);
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.availableFundsCents).toBe(20_000); // settled 30,000 − refunded 10,000
  });

  it('F08: fulfilment fails — the buyer rejects the work and nothing collects', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const agreement = await agree(piece.id, 30_000);
    const work = await act(piece.id, 'fulfil', { agreementId: agreement.id, path: 'CONTRACTOR', workKind: 'EXTERNAL', workRef: 'subcontractor job 12' });
    expect((await act(piece.id, 'performed', { fulfilmentId: work.body.fulfilment.id, evidence: 'the contractor says it is done' })).status).toBe(200);
    expect((await act(piece.id, 'observe', { kind: 'DELIVERY_REJECTED', evidenceRef: 'buyer: submissions still bounce' })).status).toBe(200);
    await advanceJourney(projectId);
    expect((await fulfilmentsFor(piece.id))[0]).toMatchObject({ state: 'FAILED' });
    expect((await act(piece.id, 'collect')).status).toBe(422);
    await advanceJourney(projectId);
    expect((await outcomesFor({ projectId, opportunityId: piece.id })).some((one) => one.kind === 'FAILURE_REASON')).toBe(true);
    // A second attempt is a new fulfilment, and the failure stays on the record.
    expect((await act(piece.id, 'fulfil', { agreementId: agreement.id, path: 'PERSON', workKind: 'EXTERNAL', workRef: 'the operator redoes it' })).status).toBe(200);
    expect(await fulfilmentsFor(piece.id)).toHaveLength(2);
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
    expect((await act(piece.id, 'observe', { kind: 'SUPPLIER_COST_CHANGED', amountCents: 25_000, evidenceRef: 'contractor revised quote' })).status).toBe(200);
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

  it('F10: Brain-delivered research is read as performed from its mission, never attested', async () => {
    await granted();
    provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const agreement = await agree(piece.id, 20_000);
    const idea = await createCandidate({ projectId, title: 'The answer the buyer is paying for', statement: 'Establish it from published sources.' });
    const work = await act(piece.id, 'fulfil', { agreementId: agreement.id, path: 'BRAIN_RESEARCH', workKind: 'RUSSELL_CANDIDATE', workRef: idea.id });
    expect(work.status).toBe(200);
    // Not attested by a person.
    expect((await recordPerformed({ fulfilmentId: work.body.fulfilment.id, evidence: 'trust me', actorRef: userId })).ok).toBe(false);
    // Nothing performed while the mission runs.
    const { mission } = await launchMission({ projectId, visibility: 'SHARED', objective: 'Answer it', whyNow: 'A customer paid for it', idempotencyKey: `mission:${idea.id}`, candidateId: idea.id });
    await advanceJourney(projectId);
    expect((await fulfilmentsFor(piece.id))[0]!.state).toBe('CREATED');
    expect(await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'DONE' })).toBe(true);
    await advanceJourney(projectId);
    expect((await fulfilmentsFor(piece.id))[0]).toMatchObject({ state: 'PERFORMED', performedEvidence: expect.stringContaining(mission.id) });
  });
});
