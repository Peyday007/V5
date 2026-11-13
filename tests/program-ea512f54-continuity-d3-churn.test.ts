/**
 * CONT-35 (S-0485, S-0486), repair F-TICK-EVENT-CHURN-AND-STARVATION.
 *
 * The tick asks the continuation gate of every held piece on every pass. Two
 * things must not follow from that:
 *
 * - the piece's history filling with one CASH_CONTINUATION_DECIDED row per
 *   pass for a decision that has not changed (the history page reads the
 *   newest 50, so the copies would evict real history); and
 * - held pieces using up MAX_CONTACTS_PER_PASS, so a viable, unaffected buyer
 *   waits behind pieces that wrote to nobody ("resumes viable unaffected work").
 *
 * Real tick, real database, a synthetic provider at the boundary.
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
import { MAX_CONTACTS_PER_PASS, advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { OUTAGE_THRESHOLD } from '../server/services/effects/posture.ts';
import { continuationSignature } from '../server/services/cash/perform.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let seq = 0;
const nextKey = (): string => `churn-key-${String(++seq).padStart(8, '0')}`;

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  await cashProject();
});

const CONTACT_NS = COMMERCIAL_EFFECTS.CONTACT_BUYER.namespace;

interface Provider {
  sends: number;
  onSend: () => Promise<SendOutcome>;
  adapter: EffectAdapter;
}

function contactProvider(): Provider {
  const state: Provider = {
    sends: 0,
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `msg-${state.sends}` }),
    adapter: null as unknown as EffectAdapter,
  };
  state.adapter = {
    name: 'synthetic.contact_buyer',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: CONTACT_NS.name,
    validate: (payload) => {
      if (payload === null || typeof payload !== 'object') throw new Error('not an object');
      return payload as Record<string, unknown>;
    },
    fingerprintInputs: (payload) => payload,
    send: async () => {
      state.sends += 1;
      return await state.onSend();
    },
  };
  registerAdapter(state.adapter);
  return state;
}

async function cashProject(): Promise<void> {
  const user = await createUser({
    email: `continuation-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
}

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

/** Earlier refusals on the contact namespace, written through the effects engine itself. */
async function refusals(provider: Provider, outcome: SendOutcome, count: number): Promise<void> {
  provider.onSend = async () => outcome;
  for (let i = 0; i < count; i += 1) {
    await runExternalEffect({ adapter: provider.adapter, namespace: CONTACT_NS, projectId, key: nextKey(), businessId: `earlier-${i}`, payload: { note: 'earlier send' }, principalType: 'HUMAN', principalId: 'usr_one' });
  }
  provider.sends = 0;
  provider.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: `msg-${provider.sends}` });
}

async function continuationEvents(opportunityId: string): Promise<Record<string, unknown>[]> {
  const rows = await getDb().all<{ detail: string }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_CONTINUATION_DECIDED'`,
    [projectId, opportunityId],
  );
  return rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}


describe('a held piece records its continuation decision once, not once per pass', () => {
  it('writes one row for an unchanged hold across many ticks, and a new one when the decision changes', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true }, OUTAGE_THRESHOLD);
    const piece = await qualified();

    for (let pass = 0; pass < 5; pass += 1) {
      const report = await advanceWithinAuthority(projectId);
      // Every pass still says why it was withheld; only the record is not repeated.
      expect(report.withheld.some((one) => one.opportunityId === piece.id && /down, which is recoverable/.test(one.because))).toBe(true);
    }
    expect(provider.sends).toBe(0);
    const held = await continuationEvents(piece.id);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ decision: 'WAIT_RECOVERABLE', health: 'OUTAGE' });

    // The commitment becomes time-critical: a different decision, recorded once.
    await updateOpportunity(piece.id, { deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString() } as never);
    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    const changed = await continuationEvents(piece.id);
    expect(changed.map((one) => one['decision'])).toEqual(['WAIT_RECOVERABLE', 'ESCALATE_TIME_CRITICAL']);
    expect(provider.sends).toBe(0);
  });

  it('identifies a decision by what it decided, never by its prose', () => {
    const one = { action: 'CONTACT_BUYER', occurrence: '1', decision: 'WAIT_RECOVERABLE', to: null, namespace: 'n', health: 'OUTAGE', unsettled: 0, timeCritical: false, reason: 'down since 10:00' };
    expect(continuationSignature(one)).toBe(continuationSignature({ ...one, reason: 'down since 10:05' }));
    expect(continuationSignature(one)).not.toBe(continuationSignature({ ...one, decision: 'HOLD_RECONCILE' }));
    expect(continuationSignature(one)).not.toBe(continuationSignature({ ...one, unsettled: 1 }));
  });
});

describe('held pieces do not use up the pass budget', () => {
  it('reaches a viable buyer behind pieces that the gates held back', async () => {
    const provider = contactProvider();
    // The provider refuses, retryably but not as an outage: each piece is left
    // waiting on a person's press, and the dependency is not down.
    provider.onSend = async () => ({ kind: 'REJECTED', category: 'PROVIDER_REJECTED', retryable: true });
    const heldPieces: CashOpportunity[] = [];
    for (let i = 0; i < MAX_CONTACTS_PER_PASS; i += 1) heldPieces.push(await qualified());
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(MAX_CONTACTS_PER_PASS);

    provider.sends = 0;
    provider.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: `msg-${provider.sends}` });
    const viable = await qualified();
    const report = await advanceWithinAuthority(projectId);

    // None of the held pieces is sent to again by the tick ...
    for (const piece of heldPieces) {
      expect(report.withheld.some((one) => one.opportunityId === piece.id && /when a person asks it to/.test(one.because))).toBe(true);
    }
    // ... and they did not spend the budget the viable buyer needed.
    expect(report.withheld.some((one) => /were already written to this pass/.test(one.because))).toBe(false);
    expect(provider.sends).toBe(1);
    expect((await getOpportunity(viable.id))!.state).toBe('EXECUTING');
  });

  it('still bounds what one pass actually sends', async () => {
    const provider = contactProvider();
    const pieces: CashOpportunity[] = [];
    for (let i = 0; i < MAX_CONTACTS_PER_PASS + 1; i += 1) pieces.push(await qualified());
    const report = await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(MAX_CONTACTS_PER_PASS);
    expect(report.withheld.filter((one) => /were already written to this pass/.test(one.because))).toHaveLength(1);
  });
});
