/**
 * One opportunity carried from READY to money settled, through the real
 * routes, services and database, with a synthetic adapter only at the
 * provider boundary.
 *
 * Every earlier suite proved a piece of this path: that Brain records a
 * contact only on a receipt (`cashBrainEffects`), that a person can record a
 * later action (`cashFurtherActions`), that a crashed effect is reconciled
 * (`effectsReconcileResume`), that "money is in" needs a settlement
 * (`cashMode`). None of them walked it end to end, which is how a step
 * nothing could reach hides — and three did: an UNCERTAIN commercial effect
 * could only be settled from a console route with an id somebody assembled by
 * hand; a process that died after sending left the operation reading
 * "in progress" for ever, so the crash reconciliation could not run; and
 * invoicing and taking a payment could never be performed by Brain at all.
 *
 *   J01 — READY → Brain contacts (CONFIRMED) → agreed amount → Brain invoices
 *         → a second press is refused, not a second invoice → Brain takes the
 *         payment → "money is in" refused until a settlement → settlement →
 *         COLLECTED, with every Cash figure derived from server rows.
 *   J02 — an ambiguous send: no action, no resend on the next pass, then the
 *         provider reconciles and exactly one action is recorded.
 *   J03 — the process dies after sending: the next pass takes over, asks the
 *         provider, and records one action without sending again.
 *   J04 — an opaque provider leaves it unknown: a person checks and says it
 *         happened, through the route the page calls; one action, no resend.
 *   J05 — a person says it did not happen, then asks Brain to try again: a
 *         new key, one more send, still exactly one action.
 *   J06 — a provider refusal is kept on an open need with its category, and
 *         the piece does not move.
 *   J07 — with no adapter registered, every one of the three reads MISSING and
 *         asking Brain to do it is refused, sending nothing.
 *   J08 — the page itself: the record shows the attempt, and the person
 *         settles it with the panel's own controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { actionsFor } from '../server/repos/cashActions.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import { COMMERCIAL_EFFECTS, commercialOperationsFor } from '../server/services/cash/effects.ts';
import {
  clearAdapters,
  registerAdapter,
  type EffectAdapter,
  type ReconcileOutcome,
  type SendOutcome,
} from '../server/services/effects/adapter.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type {
  CashOpportunity,
  EffectClass,
  Principal,
  ProjectMembership,
} from '../server/domain/types.ts';
import type { ExecutionRecord } from '../server/services/cash/record.ts';

/* ------------------------------------------------------------------------- */
/* A browser, for J08 only                                                    */
/* ------------------------------------------------------------------------- */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { CashSection } = await import('../client/src/russell/Cash.tsx');

/* ------------------------------------------------------------------------- */
/* The harness: the real router over the real database                        */
/* ------------------------------------------------------------------------- */

let projectId = '';
let userId = '';
let server: Server | null = null;
let base = '';
const realFetch = globalThis.fetch;

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_journey',
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
    email: `journey-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
        objective: 'Maximize additional usable cash over the next few weeks.',
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
      // `req.path` is already the whole path here; see cashBrowserToDatabase.
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', cashRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    return await realFetch(url.startsWith('/') ? `${base}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  clearAdapters();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function call<T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await realFetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

/* ------------------------------------------------------------------------- */
/* Fixtures: the grant, the piece, and the provider boundary                  */
/* ------------------------------------------------------------------------- */

/** The commercial grant is a person's decision; here it is the fixture. */
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
async function qualified(): Promise<CashOpportunity> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'A published intake repair request',
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
  /** Answers the next send; defaults to a fresh receipt. */
  onSend: (payload: Record<string, unknown>) => Promise<SendOutcome>;
  onReconcile: () => Promise<ReconcileOutcome>;
}

/** A synthetic provider behind one of the three operations, scripted per test. */
function provider(
  action: keyof typeof COMMERCIAL_EFFECTS,
  effectClass: EffectClass,
  prefix: string,
): Provider {
  const state: Provider = {
    sends: [],
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `${prefix}-${state.sends.length}` }),
    onReconcile: async () => ({ kind: 'INCONCLUSIVE', reason: 'not visible yet' }),
  };
  const adapter: EffectAdapter = {
    name: `synthetic.${action.toLowerCase()}`,
    effectClass,
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
    ...(effectClass === 'EXTERNAL_RECONCILABLE' ? { reconcile: async () => await state.onReconcile() } : {}),
  };
  registerAdapter(adapter);
  return state;
}

async function view(): Promise<any> {
  const read = await call('GET', `/api/projects/${projectId}/cash`);
  expect(read.status).toBe(200);
  return read.body;
}

async function record(opportunityId: string): Promise<ExecutionRecord> {
  const body = await view();
  const found = body.myCurrentWork.records?.[opportunityId] as ExecutionRecord | undefined;
  if (!found) throw new Error('the piece has no execution record on the page');
  return found;
}

const act_ = (opportunityId: string, action: string, body: unknown = {}) =>
  call('POST', `/api/cash/opportunities/${opportunityId}/${action}`, body);

/* ------------------------------------------------------------------------- */

describe('J01: READY to settled, through the real routes', () => {
  it('contacts, invoices, takes payment and settles, with every figure from rows', async () => {
    await granted();
    const contact = provider('CONTACT_BUYER', 'EXTERNAL_OPAQUE', 'msg');
    const invoice = provider('QUOTE_AND_INVOICE', 'EXTERNAL_OPAQUE', 'inv');
    const payment = provider('ACCEPT_PAYMENT', 'EXTERNAL_OPAQUE', 'pay');
    const piece = await qualified();

    // The tick marks it ready and reaches the buyer through the adapter.
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    expect(contact.sends).toHaveLength(1);
    let actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'CONTACT_BUYER', performedBy: 'BRAIN', reference: 'msg-1' });

    // Nothing agreed yet, so Brain will not invoice — and says why.
    let rec = await record(piece.id);
    const invoicing = rec.performable.find((one) => one.action === 'QUOTE_AND_INVOICE')!;
    expect(invoicing.available).toBe(false);
    expect(invoicing.reason).toMatch(/agreed/);
    const early = await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: rec.nextOccurrence,
    });
    expect(early.status).toBe(422);
    expect(invoice.sends).toHaveLength(0);

    // A person records what was agreed. Pipeline, not cash.
    const agreed = await call('POST', `/api/projects/${projectId}/cash/money`, {
      kind: 'PIPELINE_AGREED',
      amountCents: 120_000,
      opportunityId: piece.id,
      idempotencyKey: `agreed:${piece.id}:120000:`,
    });
    expect(agreed.status).toBe(200);

    rec = await record(piece.id);
    expect(rec.money).toMatchObject({ agreedCents: 120_000, paidCents: 0, outstandingCents: 120_000 });
    const invoiced = await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: rec.nextOccurrence,
    });
    expect(invoiced.status).toBe(200);
    expect(invoiced.body.result.kind).toBe('RECORDED');
    expect(invoice.sends).toEqual([
      expect.objectContaining({ amountCents: 120_000, currency: 'USD' }),
    ]);

    // The same press again — a double click, a retry after a lost response —
    // is refused, never a second invoice.
    const again = await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: rec.nextOccurrence,
    });
    expect(again.status).toBe(422);
    expect(invoice.sends).toHaveLength(1);

    rec = await record(piece.id);
    const paid = await act_(piece.id, 'perform', {
      action: 'ACCEPT_PAYMENT',
      expectedOccurrence: rec.nextOccurrence,
    });
    expect(paid.status).toBe(200);
    expect(payment.sends).toEqual([
      expect.objectContaining({ amountCents: 120_000, invoiceReference: 'inv-1' }),
    ]);
    const entries = await listMoneyEntries({ projectId, currency: 'USD', limit: 50 });
    const payments = entries.filter((one) => one.kind === 'CUSTOMER_PAYMENT');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountCents: 120_000, verifiedReference: 'pay-1' });

    // A payment is not settled money, so "money is in" is refused until it is.
    expect((await act_(piece.id, 'deliver')).status).toBe(200);
    expect((await act_(piece.id, 'collect')).status).toBe(422);
    const settled = await call('POST', `/api/projects/${projectId}/cash/money`, {
      kind: 'SETTLEMENT',
      amountCents: 120_000,
      verifiedReference: 'payout-1',
      opportunityId: piece.id,
      idempotencyKey: `settlement:${piece.id}:payout-1`,
    });
    expect(settled.status).toBe(200);
    expect((await act_(piece.id, 'collect')).status).toBe(200);
    expect((await getOpportunity(piece.id))!.state).toBe('COLLECTED');

    // Everything the page says, derived from rows by the server.
    const body = await view();
    expect(body.myCash.position).toMatchObject({
      pipelineCents: 120_000,
      customerPaymentsCents: 120_000,
      availableFundsCents: 120_000,
      deployableCents: 120_000,
    });
    rec = body.myCurrentWork.records[piece.id];
    expect(rec.money).toMatchObject({
      agreedCents: 120_000,
      paidCents: 120_000,
      settledCents: 120_000,
      outstandingCents: 0,
    });
    actions = await actionsFor(piece.id);
    expect(actions.map((one) => one.action)).toEqual([
      'CONTACT_BUYER',
      'QUOTE_AND_INVOICE',
      'ACCEPT_PAYMENT',
    ]);
    expect(actions.every((one) => one.performedBy === 'BRAIN')).toBe(true);
    expect(rec.attempts.every((one) => one.status === 'PERFORMED')).toBe(true);
    expect([contact.sends.length, invoice.sends.length, payment.sends.length]).toEqual([1, 1, 1]);
  });

  it('a person-recorded action stays distinguishable from a Brain-performed one', async () => {
    await granted();
    provider('CONTACT_BUYER', 'EXTERNAL_OPAQUE', 'msg');
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const rec = await record(piece.id);
    const recorded = await act_(piece.id, 'record-action', {
      action: 'QUOTE_AND_INVOICE',
      detail: 'Sent invoice 0042 by email myself.',
      reference: 'INV-0042',
    });
    expect(recorded.status).toBe(200);
    const actions = await actionsFor(piece.id);
    expect(actions.map((one) => one.performedBy)).toEqual(['BRAIN', 'PERSON']);
    expect((await record(piece.id)).nextOccurrence).toBe(String(Number(rec.nextOccurrence) + 1));
  });
});

describe('J02: an ambiguous send, then reconciliation', () => {
  it('records nothing, never resends, then records exactly one action', async () => {
    await granted();
    const contact = provider('CONTACT_BUYER', 'EXTERNAL_RECONCILABLE', 'msg');
    contact.onSend = async () => {
      throw new Error('socket hang up after the request was written');
    };
    const piece = await qualified();

    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toHaveLength(0);
    expect(contact.sends).toHaveLength(1);
    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    const unknown = needs.find((one) => (one.requestKey ?? '').startsWith('effect-uncertain:'));
    expect(unknown).toBeDefined();

    // The next pass asks the provider and does not send again.
    await advanceWithinAuthority(projectId);
    expect(contact.sends).toHaveLength(1);
    expect((await record(piece.id)).attempts[0]!.status).toBe('UNKNOWN');

    contact.onReconcile = async () => ({ kind: 'FOUND', receiptRef: 'msg-late' });
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.reference).toBe('msg-late');
    expect(contact.sends).toHaveLength(1);
    const after = await listNeeds({ projectId, states: ['OPEN'] });
    expect(after.some((one) => one.id === unknown!.id)).toBe(false);

    await advanceWithinAuthority(projectId);
    expect(await actionsFor(piece.id)).toHaveLength(1);
    expect(contact.sends).toHaveLength(1);
  });
});

describe('J03: the process dies after sending', () => {
  it('is taken over, reconciled, and recorded once — never sent twice', async () => {
    await granted();
    const contact = provider('CONTACT_BUYER', 'EXTERNAL_RECONCILABLE', 'msg');
    // The first send never returns: the executor is gone mid-call.
    contact.onSend = () => new Promise<SendOutcome>(() => {});
    const piece = await qualified();

    void advanceWithinAuthority(projectId);
    await vi.waitFor(async () => {
      const ops = await commercialOperationsFor(projectId, piece.id);
      expect(ops[0]?.operation.recoverAfter).toBeTruthy();
      expect(contact.sends).toHaveLength(1);
    });

    // Its attempt lease runs out. This is the clock, not a forged state.
    const [held] = await commercialOperationsFor(projectId, piece.id);
    await getDb().run('UPDATE idempotency_operations SET recover_after = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      held!.operation.id,
    ]);

    contact.onSend = async () => {
      throw new Error('must not be called: a crash is reconciled, not resent');
    };
    contact.onReconcile = async () => ({ kind: 'FOUND', receiptRef: 'msg-after-crash' });
    await advanceWithinAuthority(projectId);

    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.reference).toBe('msg-after-crash');
    expect(contact.sends).toHaveLength(1);
  });
});

describe('J04/J05: an opaque provider, settled by a person', () => {
  async function leftUnknown(): Promise<{ piece: CashOpportunity; contact: Provider; operationId: string }> {
    await granted();
    const contact = provider('CONTACT_BUYER', 'EXTERNAL_OPAQUE', 'msg');
    contact.onSend = async () => ({ kind: 'UNCERTAIN', reason: 'the gateway timed out' });
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    expect(contact.sends).toHaveLength(1);
    const rec = await record(piece.id);
    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0]!.status).toBe('UNKNOWN');
    return { piece, contact, operationId: rec.attempts[0]!.operationId };
  }

  it('J04: "it happened" needs the reference, then records one action and moves on', async () => {
    const { piece, contact, operationId } = await leftUnknown();

    const bare = await act_(piece.id, 'resolve-effect', {
      operationId,
      happened: true,
      note: 'Saw it in the provider log.',
    });
    expect(bare.status).toBe(422);

    // Another piece's attempt cannot be reached through this one.
    const stranger = await act_(piece.id, 'resolve-effect', {
      operationId: 'idop_not_this_pieces',
      happened: true,
      receiptRef: 'x',
      note: 'n',
    });
    expect(stranger.status).toBe(422);

    const settled = await act_(piece.id, 'resolve-effect', {
      operationId,
      happened: true,
      receiptRef: 'msg-checked',
      note: 'Delivered at 10:02 in the provider log.',
    });
    expect(settled.status).toBe(200);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ performedBy: 'BRAIN', reference: 'msg-checked', confirmedBy: userId });

    // Settled once; a second settlement is refused and nothing is resent.
    expect(
      (await act_(piece.id, 'resolve-effect', { operationId, happened: false, note: 'n' })).status,
    ).toBe(422);
    await advanceWithinAuthority(projectId);
    expect(contact.sends).toHaveLength(1);
    expect(await actionsFor(piece.id)).toHaveLength(1);
  });

  it('J05: "it did not happen", then a person asks Brain to try again — one more send', async () => {
    const { piece, contact, operationId } = await leftUnknown();
    const settled = await act_(piece.id, 'resolve-effect', {
      operationId,
      happened: false,
      note: 'Provider log shows it was never accepted.',
    });
    expect(settled.status).toBe(200);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');

    // The tick does not retry what a person closed: still one send.
    await advanceWithinAuthority(projectId);
    expect(contact.sends).toHaveLength(1);

    contact.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: 'msg-retry' });
    const rec = await record(piece.id);
    const retried = await act_(piece.id, 'perform', {
      action: 'CONTACT_BUYER',
      expectedOccurrence: rec.nextOccurrence,
    });
    expect(retried.status).toBe(200);
    expect(retried.body.result.kind).toBe('RECORDED');
    expect(contact.sends).toHaveLength(2);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.reference).toBe('msg-retry');
  });
});

describe('J06: a provider refusal', () => {
  it('records nothing, keeps the reason on a need, and does not move the piece', async () => {
    await granted();
    const contact = provider('CONTACT_BUYER', 'EXTERNAL_OPAQUE', 'msg');
    contact.onSend = async () => ({
      kind: 'REJECTED',
      category: 'VALIDATION',
      retryable: false,
      detail: 'the recipient address is not deliverable',
    });
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    expect(contact.sends).toHaveLength(1);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toHaveLength(0);
    const refused = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) =>
      (one.requestKey ?? '').startsWith('effect-failed:'),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.whyItMatters).toMatch(/VALIDATION/);
    expect((await record(piece.id)).attempts[0]!.status).toBe('REFUSED');
  });
});

describe('J07: no integration registered', () => {
  it('reads MISSING for all three and refuses to perform, sending nothing', async () => {
    await granted();
    for (const id of ['SEND_A_MESSAGE', 'ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT']) {
      expect((await readCapability(id)).state).toBe('MISSING');
    }
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    const rec = await record(piece.id);
    expect(rec.performable.find((one) => one.action === 'CONTACT_BUYER')!.available).toBe(false);
    const refused = await act_(piece.id, 'perform', {
      action: 'CONTACT_BUYER',
      expectedOccurrence: rec.nextOccurrence,
    });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/SEND_A_MESSAGE/);
    expect(await commercialOperationsFor(projectId, piece.id)).toHaveLength(0);
  });
});

describe('J08: the page settles an unknown with its own controls', () => {
  it('shows the attempt and records the person’s answer', async () => {
    await granted();
    const contact = provider('CONTACT_BUYER', 'EXTERNAL_OPAQUE', 'msg');
    contact.onSend = async () => ({ kind: 'UNCERTAIN', reason: 'the gateway timed out' });
    const piece = await qualified();
    await advanceWithinAuthority(projectId);

    await act(async () => {
      render(createElement(CashSection, { projectId, isBrainAdmin: false }));
    });
    await waitFor(() => expect(screen.getByText('Pipeline')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText(/the outcome is unknown/).length).toBeGreaterThan(0));

    const open = await screen.findAllByRole('button', { name: /Say what happened to this attempt/ });
    await act(async () => fireEvent.click(open[0]!));
    await act(async () =>
      fireEvent.click((await screen.findAllByRole('button', { name: /^It happened$/ }))[0]!),
    );
    await act(async () =>
      fireEvent.change((await screen.findAllByLabelText(/provider.s reference/))[0]!, {
        target: { value: 'msg-from-page' },
      }),
    );
    await act(async () =>
      fireEvent.change((await screen.findAllByLabelText(/What you checked/))[0]!, {
        target: { value: 'Seen in the provider dashboard.' },
      }),
    );
    await act(async () =>
      fireEvent.click((await screen.findAllByRole('button', { name: /^Confirm$/ }))[0]!),
    );

    await waitFor(async () => {
      expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    });
    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.reference).toBe('msg-from-page');
    expect(contact.sends).toHaveLength(1);
  });
});
