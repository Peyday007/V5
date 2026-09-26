/**
 * Brain records a performed commercial action only from an effect outcome.
 *
 * `advanceWithinAuthority`'s `CONTACT_BUYER` branch used to write a
 * `cash_actions` row the moment `SEND_A_MESSAGE` read `PRESENT`, composing the
 * detail itself and never calling into `server/services/effects` — so no
 * message was ever sent and nothing here could tell a real contact from a
 * fabricated one. Invariants 25 and 26: a claim is never permission to perform
 * an effect that is unsafe to repeat, and a timeout, reset or late error is
 * never treated as evidence that an effect did not happen.
 *
 * `PRESENT` now means a real effect adapter is registered for
 * `cash.contact_buyer`, and what gets recorded is the provider's own answer —
 * never a sentence Brain composed about itself.
 *
 *   A01 — with no adapter registered, the capability still reads MISSING and
 *         nothing is recorded, exactly as before.
 *   A02 — a CONFIRMED adapter: the action is recorded with the receipt as its
 *         reference, execution begins, and running the identical attempt again
 *         replays rather than sending a second time.
 *   A03 — an UNCERTAIN adapter: no action is recorded, execution does not
 *         begin, the opportunity stays READY, and an open need names the
 *         unknown outcome.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
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
import { readCapability } from '../server/services/cash/capabilities.ts';
import {
  CONTACT_BUYER_NAMESPACE,
  contactBuyerKey,
  sendContactBuyer,
} from '../server/services/cash/effects.ts';
import {
  clearAdapters,
  registerAdapter,
  type EffectAdapter,
  type SendOutcome,
} from '../server/services/effects/adapter.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `brain-effects-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
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
});

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

/** A card complete enough that `advanceWithinAuthority` marks it READY. */
async function readyToTest(): Promise<CashOpportunity> {
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

  const proposal = await proposeTerms(piece);
  await applyProposal({ opportunity: piece, proposal });
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

/** Every adapter here builds on this so every test states only what differs. */
function adapter(name: string, send: EffectAdapter['send']): EffectAdapter {
  return {
    name,
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: CONTACT_BUYER_NAMESPACE.name,
    validate: (payload) => {
      if (payload === null || typeof payload !== 'object') {
        throw new Error('A contact-buyer payload must be an object.');
      }
      return payload as Record<string, unknown>;
    },
    fingerprintInputs: (payload) => payload,
    send,
  };
}

// ---------------------------------------------------------------------------
// A01 — no adapter registered
// ---------------------------------------------------------------------------

describe('A01: with no effect adapter registered', () => {
  it('reads MISSING exactly as it did before this pass existed', async () => {
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('MISSING');
  });

  it('withholds, and records no action and no execution', async () => {
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId); // marks READY

    const advanced = await advanceWithinAuthority(projectId);
    const withheld = advanced.withheld.find((one) => one.opportunityId === piece.id)!;
    expect(withheld).toBeDefined();
    expect(withheld.because).toContain('SEND_A_MESSAGE');
    expect(withheld.because).toContain('nobody has been contacted');

    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toEqual([]);
    expect(advanced.took.some((one) => one.did === 'BEGAN_EXECUTION')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A02 — a CONFIRMED adapter
// ---------------------------------------------------------------------------

describe('A02: a CONFIRMED adapter', () => {
  it('reads PRESENT once registered, and MISSING with nothing registered', async () => {
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('MISSING');
    let sends = 0;
    registerAdapter(
      adapter('test.confirmed', async (request): Promise<SendOutcome> => {
        sends += 1;
        return { kind: 'CONFIRMED', receiptRef: `rcpt_${request.businessId}` };
      }),
    );
    expect((await readCapability('SEND_A_MESSAGE')).state).toBe('PRESENT');
    expect(sends).toBe(0); // reading the capability never sends anything
  });

  it('records the action with the receipt as its reference, and begins execution', async () => {
    registerAdapter(
      adapter('test.confirmed', async (request): Promise<SendOutcome> => ({
        kind: 'CONFIRMED',
        receiptRef: `rcpt_${request.businessId}`,
      })),
    );
    await granted();
    const piece = await readyToTest();
    // With a real adapter registered, marking ready and beginning execution
    // happen in one pass: `markReady` moves the piece to READY, and the same
    // call's second loop then finds it there. Unlike the MISSING-capability
    // tests, there is no second tick to make.
    const advanced = await advanceWithinAuthority(projectId);
    expect(advanced.took).toContainEqual(
      expect.objectContaining({ opportunityId: piece.id, did: 'BEGAN_EXECUTION' }),
    );
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');

    const actions = await actionsFor(piece.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe('CONTACT_BUYER');
    expect(actions[0]!.performedBy).toBe('BRAIN');
    expect(actions[0]!.reference).toBe(`rcpt_${piece.id}`);
  });

  it('run twice: the identical attempt replays rather than sending again', async () => {
    let sends = 0;
    registerAdapter(
      adapter('test.confirmed', async (request): Promise<SendOutcome> => {
        sends += 1;
        return { kind: 'CONFIRMED', receiptRef: `rcpt_${request.businessId}_${sends}` };
      }),
    );
    const request = {
      key: contactBuyerKey('opp_fixed', '1'),
      projectId,
      opportunityId: 'opp_fixed',
      payer: 'Somebody',
      channel: 'Their address',
    };

    const first = await sendContactBuyer(request);
    expect(first.status).toBe('CONFIRMED');
    const second = await sendContactBuyer(request);
    expect(second.status).toBe('REPLAYED');
    // The provider was asked once. The second call found the reservation the
    // first one made and never touched the adapter at all.
    expect(sends).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A03 — an UNCERTAIN adapter
// ---------------------------------------------------------------------------

describe('A03: an UNCERTAIN adapter', () => {
  it('records no action, begins nothing, and leaves the opportunity READY', async () => {
    registerAdapter(
      adapter('test.uncertain', async (): Promise<SendOutcome> => ({
        kind: 'UNCERTAIN',
        reason: 'the connection closed before a response',
      })),
    );
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId); // marks READY

    const advanced = await advanceWithinAuthority(projectId);
    const withheld = advanced.withheld.find((one) => one.opportunityId === piece.id)!;
    expect(withheld).toBeDefined();
    expect(withheld.because).toContain('outcome unknown');
    expect(advanced.took.some((one) => one.did === 'BEGAN_EXECUTION')).toBe(false);

    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toEqual([]);
  });

  it('raises an open need naming the unknown outcome', async () => {
    registerAdapter(
      adapter('test.uncertain', async (): Promise<SendOutcome> => ({
        kind: 'UNCERTAIN',
        reason: 'the connection closed before a response',
      })),
    );
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId); // marks READY
    await advanceWithinAuthority(projectId);

    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    const need = needs.find((one) => one.opportunityId === piece.id)!;
    expect(need).toBeDefined();
    expect(need.whyItMatters).toContain('unknown');
  });

  it('treats an adapter whose send() throws a timeout the same as one that returns UNCERTAIN', async () => {
    // `runExternalEffect` converts a thrown transport error into UNCERTAIN —
    // proven generically in tests/idempotency.test.ts — but nothing here had
    // exercised that conversion for cash.contact_buyer specifically. A send
    // that throws is exactly what a real timeout looks like from the caller's
    // side, and this Brain must treat it identically to a provider that
    // answers UNCERTAIN outright: no action recorded, no execution begun, the
    // opportunity stays READY, and an open need names the unknown outcome.
    registerAdapter(
      adapter('test.throws-timeout', async (): Promise<SendOutcome> => {
        throw new Error('timed out waiting for a response');
      }),
    );
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId); // marks READY

    const advanced = await advanceWithinAuthority(projectId);
    const withheld = advanced.withheld.find((one) => one.opportunityId === piece.id)!;
    expect(withheld).toBeDefined();
    expect(withheld.because).toContain('outcome unknown');
    expect(advanced.took.some((one) => one.did === 'BEGAN_EXECUTION')).toBe(false);

    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toEqual([]);

    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    const need = needs.find((one) => one.opportunityId === piece.id)!;
    expect(need).toBeDefined();
    expect(need.whyItMatters).toContain('unknown');
  });

  it('a second pass asks the same question rather than resending', async () => {
    let sends = 0;
    registerAdapter(
      adapter('test.uncertain', async (): Promise<SendOutcome> => {
        sends += 1;
        return { kind: 'UNCERTAIN', reason: 'the connection closed before a response' };
      }),
    );
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId); // marks READY
    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);

    // The key stays stable while no action has been recorded, so a second and
    // third pass find the same unresolved reservation and try to reconcile it
    // rather than sending a second and third time.
    expect(sends).toBe(1);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    expect(await actionsFor(piece.id)).toEqual([]);
  });
});
