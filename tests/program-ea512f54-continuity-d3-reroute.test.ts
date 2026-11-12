/**
 * CONT-35 (S-0485): REROUTE is reachable in production, and the send goes
 * through the alternative chosen.
 *
 * "Change to a permitted acquisition channel when an account is suspended" and
 * "switch suppliers if the original fails and an alternative is contractually
 * workable" were claimed as owned by the send path while `continuationGate`
 * never passed any alternatives, so `planContinuation` could not return
 * REROUTE — and had it, the gate refused instead of sending. These tests drive
 * the real tick (`advanceWithinAuthority`) and the real gate: the alternatives
 * are read from registered adapters that declare `alternateFor`, permission
 * and contract from the person's `CASH_CONTINUATION_ALTERNATIVE` records
 * (nothing recorded is not permitted), and a REROUTE sends exactly once
 * through the alternative, never through the original and never twice.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import {
  COMMERCIAL_EFFECTS,
  commercialOperationsFor,
  continuationPermissions,
  declareContinuationAlternative,
  performsAction,
} from '../server/services/cash/effects.ts';
import { continuationAlternatives } from '../server/services/cash/perform.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { CONTINUITY_CLAUSE_OWNERS, OUTAGE_THRESHOLD, planContinuation } from '../server/services/effects/posture.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let seq = 0;
const nextKey = (): string => `reroute-key-${String(++seq).padStart(8, '0')}`;

const CONTACT_NS = COMMERCIAL_EFFECTS.CONTACT_BUYER.namespace;
const ALT_NS = 'cash.contact_buyer.alt_channel';
const SAME_CHANNEL_NS = 'cash.contact_buyer.second_account';
const SUPPLIER_NS = 'cash.contact_buyer.supplier_b';

interface Provider {
  sends: number;
  onSend: () => Promise<SendOutcome>;
  adapter: EffectAdapter;
}

function provider(name: string, namespace: string, extra: Partial<EffectAdapter> = {}): Provider {
  const state: Provider = {
    sends: 0,
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `${name}-${state.sends}` }),
    adapter: null as unknown as EffectAdapter,
  };
  state.adapter = {
    name,
    effectClass: 'EXTERNAL_OPAQUE',
    namespace,
    validate: (payload) => {
      if (payload === null || typeof payload !== 'object') throw new Error('not an object');
      return payload as Record<string, unknown>;
    },
    fingerprintInputs: (payload) => payload,
    send: async () => {
      state.sends += 1;
      return await state.onSend();
    },
    ...extra,
  };
  registerAdapter(state.adapter);
  return state;
}

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  const user = await createUser({
    email: `reroute-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
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
});

async function qualified(): Promise<CashOpportunity> {
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'A published intake repair request', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
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
    await recordCardFact({ projectId, opportunityId: piece.id, field, kind: 'EVIDENCE', value: `A published answer to ${field}.`, claimId: `clm_${field}`, decidedBy: 'BRAIN' });
  }
  return (await getOpportunity(piece.id))!;
}

/** Earlier refusals on the original contact namespace, written through the effects engine itself. */
async function refusals(original: Provider, outcome: SendOutcome, count: number): Promise<void> {
  original.onSend = async () => outcome;
  for (let i = 0; i < count; i += 1) {
    await runExternalEffect({ adapter: original.adapter, namespace: CONTACT_NS, projectId, key: nextKey(), businessId: `earlier-${i}`, payload: { note: 'earlier send' }, principalType: 'HUMAN', principalId: 'usr_one' });
  }
  original.sends = 0;
  original.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: `original-${original.sends}` });
}

async function decisions(opportunityId: string): Promise<Record<string, unknown>[]> {
  const rows = await getDb().all<{ detail: string }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_CONTINUATION_DECIDED' ORDER BY created_at, id`,
    [projectId, opportunityId],
  );
  return rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

const SUSPENDED: SendOutcome = { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false };
const DOWN: SendOutcome = { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true };

describe('a suspended acquisition channel moves to a permitted one', () => {
  it('sends once through the permitted alternative channel, and records the move', async () => {
    const original = provider('original.email', CONTACT_NS.name, { channel: 'email' });
    const alt = provider('alt.sms', ALT_NS, { alternateFor: CONTACT_NS.name, channel: 'sms' });
    await refusals(original, SUSPENDED, 1);
    await declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: ALT_NS, permitted: true, contractuallyWorkable: null, actorRef: userId });
    const piece = await qualified();

    await advanceWithinAuthority(projectId);

    expect(original.sends).toBe(0);
    expect(alt.sends).toBe(1);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const [event] = await decisions(piece.id);
    expect(event).toMatchObject({ action: 'CONTACT_BUYER', decision: 'REROUTE', to: ALT_NS, namespace: CONTACT_NS.name, health: 'CONSTRAINED' });
    // The attempt is in the alternative's namespace under the commitment's own correlation, so every gate finds it.
    const ops = await commercialOperationsFor(projectId, piece.id);
    expect(ops.map((one) => one.operation.namespace)).toEqual([ALT_NS]);
    expect(ops[0]!.operation.state).toBe('SUCCEEDED');

    // A second tick sends nothing more: the commitment is on the record.
    await advanceWithinAuthority(projectId);
    expect(alt.sends).toBe(1);
    expect(original.sends).toBe(0);
  });

  it('does not move to an alternative nobody permitted, and says so', async () => {
    const original = provider('original.email', CONTACT_NS.name, { channel: 'email' });
    const alt = provider('alt.sms', ALT_NS, { alternateFor: CONTACT_NS.name, channel: 'sms' });
    await refusals(original, SUSPENDED, 1);
    const piece = await qualified();

    await advanceWithinAuthority(projectId);

    expect(alt.sends + original.sends).toBe(0);
    const [event] = await decisions(piece.id);
    expect(event).toMatchObject({ decision: 'EXTERNAL_CONSTRAINT' });
    expect(event!['skipped']).toEqual([{ namespace: ALT_NS, why: expect.stringContaining('nobody has said it is permitted') }]);
  });

  it('never bypasses a suspended channel through another account on it', async () => {
    const original = provider('original.email', CONTACT_NS.name, { channel: 'email' });
    const second = provider('second.email', SAME_CHANNEL_NS, { alternateFor: CONTACT_NS.name, channel: 'email' });
    await refusals(original, SUSPENDED, 1);
    await declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: SAME_CHANNEL_NS, permitted: true, contractuallyWorkable: null, actorRef: userId });
    const piece = await qualified();

    await advanceWithinAuthority(projectId);

    expect(second.sends + original.sends).toBe(0);
    const [event] = await decisions(piece.id);
    expect(event).toMatchObject({ decision: 'EXTERNAL_CONSTRAINT' });
    expect(JSON.stringify(event!['skipped'])).toContain('another account on the suspended channel');
  });
});

describe('a failed supplier moves only where the contract allows', () => {
  it('waits while the contract question is unanswered, and moves once it is answered yes', async () => {
    const original = provider('original.supplier', CONTACT_NS.name);
    const supplier = provider('supplier.b', SUPPLIER_NS, { alternateFor: CONTACT_NS.name, requiresContract: true });
    await refusals(original, DOWN, OUTAGE_THRESHOLD);
    await declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: SUPPLIER_NS, permitted: true, contractuallyWorkable: null, actorRef: userId });
    const piece = await qualified();

    await advanceWithinAuthority(projectId);
    expect(supplier.sends + original.sends).toBe(0);
    const [waiting] = await decisions(piece.id);
    expect(waiting).toMatchObject({ decision: 'WAIT_RECOVERABLE', health: 'OUTAGE' });
    expect(JSON.stringify(waiting!['skipped'])).toContain('nobody has established the contract allows it');

    // The later decision supersedes the earlier one by being later; both stay on the record.
    await declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: SUPPLIER_NS, permitted: true, contractuallyWorkable: true, actorRef: userId });
    expect((await continuationPermissions(projectId, 'CONTACT_BUYER')).get(SUPPLIER_NS)).toMatchObject({ permitted: true, contractuallyWorkable: true });
    await advanceWithinAuthority(projectId);
    expect(original.sends).toBe(0);
    expect(supplier.sends).toBe(1);
    expect((await decisions(piece.id)).at(-1)).toMatchObject({ decision: 'REROUTE', to: SUPPLIER_NS });
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
  });
});

describe('a moved commitment is never performed twice', () => {
  it('holds an attempt whose outcome at the alternative is unknown, instead of sending it anywhere again', async () => {
    const original = provider('original.email', CONTACT_NS.name, { channel: 'email' });
    const alt = provider('alt.sms', ALT_NS, { alternateFor: CONTACT_NS.name, channel: 'sms' });
    await refusals(original, SUSPENDED, 1);
    await declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: ALT_NS, permitted: true, contractuallyWorkable: null, actorRef: userId });
    alt.onSend = async () => {
      throw new Error('connection reset after the request left');
    };
    const piece = await qualified();

    await advanceWithinAuthority(projectId);
    expect(alt.sends).toBe(1);
    const [op] = await commercialOperationsFor(projectId, piece.id);
    expect(op!.operation.namespace).toBe(ALT_NS);
    expect(op!.operation.state).toBe('UNCERTAIN');

    // The original recovers; the attempt that may already have reached the buyer through the alternative is not resent through it.
    alt.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: 'alt-late' });
    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    expect(original.sends).toBe(0);
    expect(alt.sends).toBe(1);
    expect((await getOpportunity(piece.id))!.state).not.toBe('EXECUTING');
  });

  it('pins an attempt unsettled at the original there, rather than moving it', () => {
    const decision = planContinuation({
      namespace: CONTACT_NS.name,
      channel: 'email',
      health: { status: 'CONSTRAINED', reason: 'suspended' },
      unsettled: 0,
      timeCritical: false,
      currentUnsettledHere: 1,
      alternatives: [{ namespace: ALT_NS, channel: 'sms', permitted: true, contractuallyWorkable: null, requiresContract: false, status: 'HEALTHY' }],
    });
    expect(decision.action).not.toBe('REROUTE');
    expect(decision.skipped[0]!.why).toContain('may already have been accepted');
  });
});

describe('what the alternatives are read from', () => {
  it('lists each registered alternative with the recorded decision, unusable adapters as down', async () => {
    provider('original.email', CONTACT_NS.name, { channel: 'email' });
    provider('alt.sms', ALT_NS, { alternateFor: CONTACT_NS.name, channel: 'sms', health: () => ({ usable: false, reason: 'no key' }) });
    expect(await continuationAlternatives(projectId, 'CONTACT_BUYER')).toEqual([
      { namespace: ALT_NS, channel: 'sms', permitted: null, contractuallyWorkable: null, requiresContract: false, status: 'OUTAGE' },
    ]);
    expect(await continuationAlternatives(projectId, 'ACCEPT_PAYMENT')).toEqual([]);
    expect(performsAction('CONTACT_BUYER', ALT_NS)).toBe(true);
    expect(performsAction('ACCEPT_PAYMENT', ALT_NS)).toBe(false);
  });

  it('refuses to record a decision about something that cannot stand in for the action', async () => {
    provider('original.email', CONTACT_NS.name);
    await expect(
      declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: 'cash.nothing_registered', permitted: true, contractuallyWorkable: null, actorRef: userId }),
    ).rejects.toThrow(/No registered adapter/);
    await expect(
      declareContinuationAlternative({ projectId, action: 'CONTACT_BUYER', namespace: CONTACT_NS.name, permitted: true, contractuallyWorkable: null, actorRef: userId }),
    ).rejects.toThrow(/not an alternative/);
  });

  it('names the reading and the routing in the clause owners', () => {
    for (const clause of ['change to a permitted acquisition channel', 'switch suppliers']) {
      const owner = CONTINUITY_CLAUSE_OWNERS.find((one) => one.clause.startsWith(clause));
      expect(owner?.owner).toContain('CASH_CONTINUATION_ALTERNATIVE');
      expect(owner?.owner).toContain('continuationGate');
    }
  });
});
