/**
 * CONT-35 (S-0484, S-0486), repair F1: an effect interrupted at a dangerous
 * boundary — a payment whose send timed out after the provider may have
 * accepted it — is re-reconciled by Brain on its own, from the tick, without
 * anybody pressing the same button again and without sending a second time.
 *
 * Before this, `reconcileInterruptedEffect` had no production caller and the
 * tick's `recoverAbandonedEffects` skipped every UNCERTAIN operation, so the
 * only way an unknown was ever asked about again was a person re-running the
 * identical request. Each test drives the real route, the real tick
 * (`operate`) and the real database, with a synthetic provider at the
 * boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { getOpportunity, listNeeds, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { advanceWithinAuthority, operate } from '../server/services/cash/operate.ts';
import { UNCERTAIN_REASK_AFTER_MS } from '../server/services/cash/perform.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { actionsFor } from '../server/repos/cashActions.ts';
import { COMMERCIAL_EFFECTS, commercialOperationsFor } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type ReconcileOutcome } from '../server/services/effects/adapter.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { setExternalSendTimeoutForTests } from '../server/services/effects/external.ts';
import { getOperation } from '../server/repos/idempotency.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { CashOpportunity, IdempotencyOperation, Principal, ProjectMembership } from '../server/domain/types.ts';

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
    credentialId: 'ses_cont35_resume',
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
  projectId = (await freshProject()).project.id;
  const user = await createUser({
    email: `cont35-resume-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
  setExternalSendTimeoutForTests(null);
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
      reachableChannel: 'ops@intake-buyer.example — the address on the notice',
      buyingSignal: 'Wanted: intake repair. Budget $1,200.',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  const piece = (await getOpportunity(captured.value.id))!;
  await applyProposal({ opportunity: piece, proposal: await proposeTerms(piece) });
  await updateOpportunity(piece.id, {
    delivery_method: 'Delivered by the named operator, as the card describes.',
    fulfillment_owner: 'The named operator, with the owner reviewing',
  } as never);
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

/** A READY piece the tick has reached the buyer on, with an amount agreed. */
async function executingWithAgreement(): Promise<CashOpportunity> {
  let n = 0;
  registerAdapter({
    name: 'synthetic.contact_buyer',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: COMMERCIAL_EFFECTS.CONTACT_BUYER.namespace.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async () => ({ kind: 'CONFIRMED', receiptRef: `msg-${++n}` }),
  });
  const piece = await qualified();
  await advanceWithinAuthority(projectId);
  expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
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

interface SlowCharge {
  sends: unknown[];
  asks: number;
  /** What the provider answers when asked; switched by the test. */
  answer: ReconcileOutcome;
}

/** A payment provider whose send never answers in time, so the attempt is left UNCERTAIN. */
function slowCharge(options: { reconcilable: boolean }): SlowCharge {
  const state: SlowCharge = { sends: [], asks: 0, answer: { kind: 'ABSENT' } };
  registerAdapter({
    name: 'synthetic.slow_charge',
    effectClass: options.reconcilable ? 'EXTERNAL_RECONCILABLE' : 'EXTERNAL_OPAQUE',
    namespace: COMMERCIAL_EFFECTS.ACCEPT_PAYMENT.namespace.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (request) => {
      state.sends.push(request.payload);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { kind: 'CONFIRMED', receiptRef: 'pay-interrupted' };
    },
    ...(options.reconcilable
      ? {
          reconcile: async () => {
            state.asks += 1;
            return state.answer;
          },
        }
      : {}),
  });
  return state;
}

async function nextOccurrence(opportunityId: string): Promise<string> {
  const read = await call('GET', `/api/projects/${projectId}/cash`);
  expect(read.status).toBe(200);
  return read.body.myCurrentWork.records[opportunityId].nextOccurrence as string;
}

/** Press "take the payment" once and leave it interrupted: UNCERTAIN, the late answer never observed. */
async function interruptedPayment(piece: CashOpportunity): Promise<IdempotencyOperation> {
  setExternalSendTimeoutForTests(40);
  const pressed = await call('POST', `/api/cash/opportunities/${piece.id}/perform`, {
    action: 'ACCEPT_PAYMENT',
    expectedOccurrence: await nextOccurrence(piece.id),
  });
  expect(pressed.status).toBe(200);
  expect(pressed.body.result.kind).toBe('UNCERTAIN');
  // The provider's own answer arrives after nobody is waiting for it.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const [one] = (await commercialOperationsFor(projectId, piece.id)).filter((op) => op.action === 'ACCEPT_PAYMENT');
  expect(one!.operation.state).toBe('UNCERTAIN');
  return one!.operation;
}

/** As if the unknown had sat unchanged for longer than the re-ask interval. */
async function age(operationId: string): Promise<void> {
  const past = new Date(Date.now() - UNCERTAIN_REASK_AFTER_MS - 60_000).toISOString();
  await getDb().run('UPDATE idempotency_operations SET updated_at = ? WHERE id = ?', [past, operationId]);
}

const payments = async (opportunityId: string) =>
  (await actionsFor(opportunityId)).filter((one) => one.action === 'ACCEPT_PAYMENT');

const recoveredEvents = async () =>
  await getDb().all<{ detail: string }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND kind = 'CASH_EFFECT_RECOVERED'`,
    [projectId],
  );

/* ------------------------------------------------------------------------- */

describe('CONT-35 repair F1: the tick re-reconciles an interrupted, uncertain effect by itself', () => {
  it('settles an uncertain payment on the provider’s receipt, once, without sending again', async () => {
    const piece = await executingWithAgreement();
    const provider = slowCharge({ reconcilable: true });
    const operation = await interruptedPayment(piece);
    const asksAtInterrupt = provider.asks;
    const uncertainNeed = (await listNeeds({ projectId })).find((need) => need.state === 'OPEN' && need.blockedAction.startsWith('Confirm whether'));
    expect(uncertainNeed).toBeDefined();

    // The provider now has it. Inside the backoff the tick does not ask yet.
    provider.answer = { kind: 'FOUND', receiptRef: 'pay-interrupted' };
    await operate(projectId);
    expect(provider.asks).toBe(asksAtInterrupt);
    expect((await getOperation(operation.id))!.state).toBe('UNCERTAIN');

    // Once it has sat long enough, the tick asks — nobody pressed anything.
    await age(operation.id);
    await operate(projectId);
    expect(provider.asks).toBe(asksAtInterrupt + 1);
    expect(await getOperation(operation.id)).toMatchObject({ state: 'SUCCEEDED', resultRef: 'pay-interrupted' });
    expect(provider.sends).toHaveLength(1);
    expect(await payments(piece.id)).toHaveLength(1);
    // The unknown it left is settled, with what Brain knows.
    const after = (await listNeeds({ projectId })).find((need) => need.id === uncertainNeed!.id);
    expect(after!.state).not.toBe('OPEN');
    const events = (await recoveredEvents()).map((row) => JSON.parse(row.detail));
    expect(events).toEqual([expect.objectContaining({ operationId: operation.id, from: 'UNCERTAIN', result: 'RECORDED' })]);

    // A second pass writes nothing and asks nothing: it is settled.
    await operate(projectId);
    expect(provider.asks).toBe(asksAtInterrupt + 1);
    expect(provider.sends).toHaveLength(1);
    expect(await payments(piece.id)).toHaveLength(1);
    expect(await recoveredEvents()).toHaveLength(1);
  });

  it('leaves it UNCERTAIN when the provider cannot confirm it, records why, and re-arms the backoff', async () => {
    const piece = await executingWithAgreement();
    const provider = slowCharge({ reconcilable: true });
    const operation = await interruptedPayment(piece);
    const asksAtInterrupt = provider.asks;

    provider.answer = { kind: 'ABSENT' };
    await age(operation.id);
    const aged = (await getOperation(operation.id))!.updatedAt;
    await operate(projectId);
    expect(provider.asks).toBe(asksAtInterrupt + 1);
    const still = (await getOperation(operation.id))!;
    // ABSENT after a send nobody saw return is not proof nothing was sent.
    expect(still.state).toBe('UNCERTAIN');
    expect(still.uncertaintyReason).toMatch(/reconciliation applied at .*nothing was resent/);
    expect(still.updatedAt > aged).toBe(true);
    expect(provider.sends).toHaveLength(1);
    expect(await payments(piece.id)).toHaveLength(0);
    expect(await recoveredEvents()).toHaveLength(0);

    // The ask moved the row, so the very next tick waits rather than asking again.
    await operate(projectId);
    expect(provider.asks).toBe(asksAtInterrupt + 1);
    expect(provider.sends).toHaveLength(1);
  });

  it('never asks or sends for an unknown its provider cannot be asked about', async () => {
    const piece = await executingWithAgreement();
    const provider = slowCharge({ reconcilable: false });
    const operation = await interruptedPayment(piece);
    await age(operation.id);
    const before = (await getOperation(operation.id))!;
    await operate(projectId);
    expect(await getOperation(operation.id)).toMatchObject({
      state: 'UNCERTAIN',
      updatedAt: before.updatedAt,
      uncertaintyReason: before.uncertaintyReason,
    });
    expect(provider.sends).toHaveLength(1);
    expect(await payments(piece.id)).toHaveLength(0);
  });
});
