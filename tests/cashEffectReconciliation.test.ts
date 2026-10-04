/**
 * A provider confirmed it; the record did not land. Brain finishes the record
 * by itself, once, and never asks the provider again.
 *
 * Before this, `applyEffectOutcome` returned PERFORMED_NOT_RECORDED and kept
 * nothing: a write that failed, a process that died between the receipt and
 * the record, a grant revoked while the send was in flight, or a piece moved
 * while it was in flight all left a SUCCEEDED operation with a receipt on it
 * and no action — and the only way back was somebody pressing the same button
 * again. Each test below drives the real routes, the real tick (`operate`)
 * and the real database, with a synthetic adapter at the provider boundary
 * and, for A and E, one injected write failure in the action repository.
 *
 *   A — confirmed, then the local write fails: one send, the receipt kept,
 *       the next tick records it once.
 *   B — the process dies after the provider confirmed: a restarted tick
 *       records it without sending again.
 *   C — the grant is revoked while the send is in flight: the effect is
 *       recorded under the grant it was sent with; nothing new can be sent.
 *   D — the piece is archived while the send is in flight: recorded, no
 *       transition invented, and an open need says so.
 *   E — a payment: one CUSTOMER_PAYMENT for the amount sent, no settlement,
 *       and repeated passes change no figure.
 *   F — a second recovery pass writes nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const failures = vi.hoisted(() => ({ recordAction: 0 }));
vi.mock('../server/repos/cashActions.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/cashActions.ts')>();
  return {
    ...actual,
    recordAction: async (input: Parameters<typeof actual.recordAction>[0]) => {
      if (failures.recordAction > 0) {
        failures.recordAction -= 1;
        throw new Error('the database went away (injected)');
      }
      return await actual.recordAction(input);
    },
  };
});

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { archiveOpportunity, capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { advanceWithinAuthority, operate } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { actionsFor } from '../server/repos/cashActions.ts';
import { listMoneyEntries, totalsByKind } from '../server/repos/cashLedger.ts';
import { COMMERCIAL_EFFECTS, commercialOperationsFor, sendCommercialEffect } from '../server/services/cash/effects.ts';
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
let authorityId = '';
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
    credentialId: 'ses_reconcile',
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
  failures.recordAction = 0;
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `reconcile-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
  const granted = await createAuthority({
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
  authorityId = granted.id;

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
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  failures.recordAction = 0;
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
  onSend: (payload: Record<string, unknown>) => Promise<SendOutcome>;
}

/** A synthetic provider that confirms with a fresh receipt unless told otherwise. */
function provider(action: keyof typeof COMMERCIAL_EFFECTS, prefix: string): Provider {
  const state: Provider = {
    sends: [],
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `${prefix}-${state.sends.length}` }),
  };
  const adapter: EffectAdapter = {
    name: `synthetic.${action.toLowerCase()}`,
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

const act_ = (opportunityId: string, action: string, body: unknown = {}) =>
  call('POST', `/api/cash/opportunities/${opportunityId}/${action}`, body);

async function nextOccurrence(opportunityId: string): Promise<string> {
  const read = await call('GET', `/api/projects/${projectId}/cash`);
  expect(read.status).toBe(200);
  return read.body.myCurrentWork.records[opportunityId].nextOccurrence as string;
}

async function attemptsOnPage(opportunityId: string): Promise<{ status: string; receiptRef: string | null }[]> {
  const read = await call('GET', `/api/projects/${projectId}/cash`);
  return read.body.myCurrentWork.records[opportunityId].attempts;
}

/** A READY piece the tick has reached the buyer on, with an amount agreed. */
async function executingWithAgreement(): Promise<CashOpportunity> {
  provider('CONTACT_BUYER', 'msg');
  const piece = await qualified();
  await advanceWithinAuthority(projectId);
  expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
  // What was agreed, with its evidence: an invoice bills an agreement, never
  // a bare amount (`journey/deal.ts`).
  const agreed = await call('POST', `/api/cash/opportunities/${piece.id}/agree`, {
    amountCents: 120_000,
    deliverable: 'The work on the card.',
    acceptanceCondition: 'The buyer confirms it in writing.',
    evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `email-${piece.id}`,
  });
  expect(agreed.status).toBe(200);
  return piece;
}

/** Everything a recovery pass could write, counted. */
async function footprint(opportunityId: string): Promise<Record<string, number>> {
  const db = getDb();
  const count = async (sql: string, params: unknown[]) =>
    Number((await db.all<{ n: number }>(sql, params as never[]))[0]?.n ?? 0);
  return {
    actions: await count('SELECT COUNT(*) AS n FROM cash_actions WHERE opportunity_id = ?', [opportunityId]),
    money: await count('SELECT COUNT(*) AS n FROM cash_money_entries WHERE project_id = ?', [projectId]),
    // The events a recovery could write. The tick's other passes keep their
    // own once-per-project history (the work-model reclassification lands on
    // the first pass), which says nothing about effects either way.
    events: await count(
      `SELECT COUNT(*) AS n FROM cash_events
        WHERE project_id = ?
          AND (kind LIKE 'CASH_EFFECT_%'
               OR kind IN ('CASH_ACTION_RECORDED', 'CASH_MONEY_RECORDED', 'CASH_NEED_RAISED'))`,
      [projectId],
    ),
    needs: await count('SELECT COUNT(*) AS n FROM cash_needs WHERE project_id = ?', [projectId]),
    operations: await count('SELECT COUNT(*) AS n FROM idempotency_operations WHERE project_id = ?', [projectId]),
  };
}

async function eventsOfKind(kind: string): Promise<number> {
  const rows = await getDb().all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cash_events WHERE project_id = ? AND kind = ?',
    [projectId, kind],
  );
  return Number(rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------------------- */

describe('A: confirmed, then the local write fails', () => {
  it('sends once, keeps the receipt, and the next tick records it once', async () => {
    const piece = await executingWithAgreement();
    const invoice = provider('QUOTE_AND_INVOICE', 'inv');

    failures.recordAction = 1;
    const pressed = await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(pressed.status).toBe(200);
    expect(pressed.body.result).toMatchObject({ kind: 'PERFORMED_NOT_RECORDED', receiptRef: 'inv-1' });
    expect(invoice.sends).toHaveLength(1);

    // The receipt is retained on the operation, and the page says so.
    const [operation] = (await commercialOperationsFor(projectId, piece.id)).filter(
      (one) => one.action === 'QUOTE_AND_INVOICE',
    );
    expect(operation!.operation).toMatchObject({ state: 'SUCCEEDED', resultRef: 'inv-1' });
    expect((await actionsFor(piece.id)).filter((one) => one.action === 'QUOTE_AND_INVOICE')).toEqual([]);
    expect((await attemptsOnPage(piece.id)).find((one) => one.receiptRef === 'inv-1')!.status).toBe('UNRECORDED');

    // The durable tick finishes it, with nobody pressing anything.
    await operate(projectId);
    const invoices = (await actionsFor(piece.id)).filter((one) => one.action === 'QUOTE_AND_INVOICE');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ performedBy: 'BRAIN', reference: 'inv-1', authorityId });
    expect(invoice.sends).toHaveLength(1);
    expect(await eventsOfKind('CASH_EFFECT_RECONCILED')).toBe(1);
    expect((await attemptsOnPage(piece.id)).find((one) => one.receiptRef === 'inv-1')!.status).toBe('PERFORMED');

    // F: and the pass after that writes nothing at all.
    const before = await footprint(piece.id);
    await operate(projectId);
    expect(await footprint(piece.id)).toEqual(before);
    expect(invoice.sends).toHaveLength(1);
  });
});

describe('B: the process dies after the provider confirmed', () => {
  it('a restarted tick records it without sending again', async () => {
    const piece = await executingWithAgreement();
    const invoice = provider('QUOTE_AND_INVOICE', 'inv');

    // Exactly the state a crash leaves: the provider was called, the operation
    // reads SUCCEEDED with its receipt, and nothing after it ever ran.
    const outcome = await sendCommercialEffect({
      action: 'QUOTE_AND_INVOICE',
      projectId,
      opportunityId: piece.id,
      occurrence: await nextOccurrence(piece.id),
      payload: { payer: 'The operations manager, who signs', amountCents: 120_000, currency: 'USD' },
      authorityId,
      amountCents: 120_000,
      stateAtSend: 'EXECUTING',
    });
    expect(outcome.status).toBe('CONFIRMED');
    expect((await actionsFor(piece.id)).filter((one) => one.action === 'QUOTE_AND_INVOICE')).toEqual([]);

    // A new process: the adapter is registered afresh, and the tick runs.
    clearAdapters();
    const restarted = provider('QUOTE_AND_INVOICE', 'inv');
    await operate(projectId);
    await operate(projectId);

    const invoices = (await actionsFor(piece.id)).filter((one) => one.action === 'QUOTE_AND_INVOICE');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ reference: 'inv-1', performedBy: 'BRAIN' });
    expect(invoice.sends).toHaveLength(1);
    expect(restarted.sends).toHaveLength(0);
    expect(await eventsOfKind('CASH_EFFECT_RECONCILED')).toBe(1);
  });
});

describe('C: the grant is revoked while the send is in flight', () => {
  it('records the invoice under the grant it was sent with, and nothing new can be sent', async () => {
    const piece = await executingWithAgreement();
    const invoice = provider('QUOTE_AND_INVOICE', 'inv');
    const payment = provider('ACCEPT_PAYMENT', 'pay');
    invoice.onSend = async () => {
      expect(await revokeAuthority({ authorityId, actorUserId: userId, reason: 'Stop now.' })).toBe(true);
      return { kind: 'CONFIRMED', receiptRef: 'inv-1' };
    };

    const pressed = await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(pressed.status).toBe(200);
    expect(pressed.body.result.kind).toBe('RECORDED');
    const invoices = (await actionsFor(piece.id)).filter((one) => one.action === 'QUOTE_AND_INVOICE');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ reference: 'inv-1', authorityId, performedBy: 'BRAIN' });

    // The revocation stops the next effect, from a person and from the tick.
    const next = await act_(piece.id, 'perform', {
      action: 'ACCEPT_PAYMENT',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(next.status).toBe(422);
    expect(String(next.body.error ?? next.body.reason ?? JSON.stringify(next.body))).toMatch(/authori/i);
    await operate(projectId);
    expect(payment.sends).toHaveLength(0);
    expect(invoice.sends).toHaveLength(1);
  });

  it('a contact confirmed after a revocation is recorded, and the piece is not reached again', async () => {
    const contact = provider('CONTACT_BUYER', 'msg');
    const piece = await qualified();
    contact.onSend = async () => {
      await revokeAuthority({ authorityId, actorUserId: userId, reason: 'Stop now.' });
      return { kind: 'CONFIRMED', receiptRef: 'msg-1' };
    };
    await advanceWithinAuthority(projectId);

    // Recorded as done, and the transition the revocation now refuses is not invented.
    const after = (await getOpportunity(piece.id))!;
    expect(after.state).toBe('READY');
    expect(await actionsFor(piece.id)).toEqual([
      expect.objectContaining({ action: 'CONTACT_BUYER', reference: 'msg-1', authorityId }),
    ]);
    const open = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) =>
      one.requestKey?.startsWith(`effect-unapplied:${piece.id}:CONTACT_BUYER:`),
    );
    expect(open).toHaveLength(1);

    // A person pressing "reach the buyer" on it now is refused, not a second message.
    const again = await act_(piece.id, 'perform', {
      action: 'CONTACT_BUYER',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(again.status).toBe(422);
    expect(contact.sends).toHaveLength(1);

    // And a grant made again moves it on from the contact already recorded — never a second contact.
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Cash Mode commercial authority, again',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
    await operate(projectId);
    await operate(projectId);
    expect(contact.sends).toHaveLength(1);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    expect(await actionsFor(piece.id)).toHaveLength(1);
    // The need that said it was waiting is settled from the row, not left standing.
    const settled = (await listNeeds({ projectId })).find((one) => one.id === open[0]!.id)!;
    expect(settled).toMatchObject({ state: 'RESOLVED', verifiedBy: 'BRAIN_READ_THE_ROW' });
  });
});

describe('D: the piece moves while the send is in flight', () => {
  it('records the invoice, invents no transition, and an open need says why', async () => {
    const piece = await executingWithAgreement();
    const invoice = provider('QUOTE_AND_INVOICE', 'inv');
    invoice.onSend = async () => {
      const archived = await archiveOpportunity({
        opportunityId: piece.id,
        actorRef: userId,
        reason: 'The buyer withdrew; reopen if they come back.',
      });
      expect(archived.ok).toBe(true);
      return { kind: 'CONFIRMED', receiptRef: 'inv-1' };
    };

    const pressed = await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(pressed.status).toBe(200);
    expect(pressed.body.result.kind).toBe('RECORDED');

    expect((await getOpportunity(piece.id))!.state).toBe('ARCHIVED');
    expect((await actionsFor(piece.id)).filter((one) => one.action === 'QUOTE_AND_INVOICE')).toEqual([
      expect.objectContaining({ reference: 'inv-1', performedBy: 'BRAIN' }),
    ]);
    const open = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) =>
      one.requestKey?.startsWith(`effect-unapplied:${piece.id}:QUOTE_AND_INVOICE:`),
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.whyItMatters).toMatch(/inv-1/);
    expect(open[0]!.whyItMatters).toMatch(/archived/);

    // Nothing more happens on later passes: no resend, no second action, no second need.
    const before = await footprint(piece.id);
    await operate(projectId);
    await operate(projectId);
    expect(await footprint(piece.id)).toEqual(before);
    expect(invoice.sends).toHaveLength(1);
  });
});

describe('E: a payment confirmed and not recorded', () => {
  it('becomes one payment for the amount sent, never a settlement, and stays one', async () => {
    const piece = await executingWithAgreement();
    provider('QUOTE_AND_INVOICE', 'inv');
    const payment = provider('ACCEPT_PAYMENT', 'pay');
    expect(
      (
        await act_(piece.id, 'perform', {
          action: 'QUOTE_AND_INVOICE',
          expectedOccurrence: await nextOccurrence(piece.id),
        })
      ).body.result.kind,
    ).toBe('RECORDED');

    failures.recordAction = 1;
    const pressed = await act_(piece.id, 'perform', {
      action: 'ACCEPT_PAYMENT',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(pressed.body.result).toMatchObject({ kind: 'PERFORMED_NOT_RECORDED', receiptRef: 'pay-1' });
    expect(payment.sends).toEqual([expect.objectContaining({ amountCents: 120_000 })]);
    expect((await listMoneyEntries({ projectId, limit: 50 })).filter((one) => one.kind === 'CUSTOMER_PAYMENT')).toEqual([]);

    // A revocation after the money was taken does not unsay that it was taken.
    await revokeAuthority({ authorityId, actorUserId: userId, reason: 'Stop now.' });

    // And a person, on the page meanwhile, cannot take it a second time.
    const again = await act_(piece.id, 'perform', {
      action: 'ACCEPT_PAYMENT',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    expect(again.status).toBe(422);
    expect(payment.sends).toHaveLength(1);

    await operate(projectId);
    const totals = await totalsByKind({ projectId, opportunityId: piece.id, currency: 'USD' });
    expect(Number(totals.CUSTOMER_PAYMENT ?? 0)).toBe(120_000);
    expect(Number(totals.SETTLEMENT ?? 0)).toBe(0);
    const payments = (await listMoneyEntries({ projectId, limit: 50 })).filter(
      (one) => one.kind === 'CUSTOMER_PAYMENT',
    );
    expect(payments).toEqual([expect.objectContaining({ amountCents: 120_000, verifiedReference: 'pay-1' })]);
    expect((await actionsFor(piece.id)).filter((one) => one.action === 'ACCEPT_PAYMENT')).toEqual([
      expect.objectContaining({ reference: 'pay-1', authorityId }),
    ]);

    // F: repeated recovery changes no total and writes nothing.
    const before = await footprint(piece.id);
    await operate(projectId);
    await operate(projectId);
    expect(await footprint(piece.id)).toEqual(before);
    expect(await totalsByKind({ projectId, opportunityId: piece.id, currency: 'USD' })).toEqual(totals);
    expect(payment.sends).toHaveLength(1);
  });

  it('a payment whose action landed and whose ledger entry did not is finished, not doubled', async () => {
    const piece = await executingWithAgreement();
    provider('QUOTE_AND_INVOICE', 'inv');
    const payment = provider('ACCEPT_PAYMENT', 'pay');
    await act_(piece.id, 'perform', {
      action: 'QUOTE_AND_INVOICE',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    await act_(piece.id, 'perform', {
      action: 'ACCEPT_PAYMENT',
      expectedOccurrence: await nextOccurrence(piece.id),
    });
    // A partial record: the ledger entry removed after the fact, as though its
    // write had been the one that failed.
    await getDb().run(
      `DELETE FROM cash_money_entries WHERE project_id = ? AND kind = 'CUSTOMER_PAYMENT'`,
      [projectId],
    );
    await operate(projectId);
    await operate(projectId);
    const payments = (await listMoneyEntries({ projectId, limit: 50 })).filter(
      (one) => one.kind === 'CUSTOMER_PAYMENT',
    );
    expect(payments).toEqual([expect.objectContaining({ amountCents: 120_000, verifiedReference: 'pay-1' })]);
    expect((await actionsFor(piece.id)).filter((one) => one.action === 'ACCEPT_PAYMENT')).toHaveLength(1);
    expect(payment.sends).toHaveLength(1);
  });
});
