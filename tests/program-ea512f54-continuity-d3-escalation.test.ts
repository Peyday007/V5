/**
 * CONT-35 (S-0485), finding F-ESCALATION-REACHES-NOBODY.
 *
 * ESCALATE_TIME_CRITICAL says "a person is told now". A cash event on the
 * piece's history is not telling anybody: the review reads needs. So the
 * continuation gate raises one — through `raiseNeed`, the existing owner —
 * for a time-critical commitment and for an external constraint, once per
 * piece/action/decision however many ticks decide it again, and the need is
 * settled by reading whether the action has since been recorded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority, listAuthorities } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { resetSynthetic } from '../server/services/effects/synthetic.ts';
import { OUTAGE_THRESHOLD } from '../server/services/effects/posture.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { recordAction } from '../server/repos/cashActions.ts';
import { readNeedCondition } from '../server/services/cash/conditions.ts';
import { continuationEffectKey } from '../server/services/cash/perform.ts';
let projectId = '';
let userId = '';
let seq = 0;
const nextKey = (): string => `escalation-key-${String(++seq).padStart(8, '0')}`;

beforeEach(async () => {
  clearAdapters();
  resetSynthetic();
  projectId = (await freshProject()).project.id;
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
    email: `escalation-${Math.random().toString(36).slice(2, 10)}@example.test`,
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


async function continuationNeeds(opportunityId: string) {
  return (await listNeeds({ projectId })).filter(
    (need) => need.opportunityId === opportunityId && (need.requestKey ?? '').startsWith('effect-continuation:'),
  );
}

describe('a continuation decision only a person can act on reaches the review', () => {
  beforeEach(cashProject);

  it('raises one need for a time-critical commitment, however many ticks decide it', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true }, OUTAGE_THRESHOLD);
    const urgent = await qualified();
    await updateOpportunity(urgent.id, { deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString() } as never);

    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);

    const needs = await continuationNeeds(urgent.id);
    expect(needs).toHaveLength(1);
    const [need] = needs;
    expect(need!.state).toBe('OPEN');
    expect(need!.requestKey).toBe(continuationEffectKey(urgent.id, 'CONTACT_BUYER', 'ESCALATE_TIME_CRITICAL'));
    expect(need!.whyItMatters).toMatch(/due/);
    expect(need!.completionCondition).toMatch(/CONTACT_BUYER/);

    // Not settled by anybody's word: it holds only once the contact is recorded.
    expect(await readNeedCondition(need!)).toMatchObject({ holds: false });
    const [authority] = await listAuthorities(projectId);
    await recordAction({
      projectId,
      opportunityId: urgent.id,
      authorityId: authority!.id,
      action: 'CONTACT_BUYER',
      performedBy: 'PERSON',
      reference: 'phoned-the-buyer',
      detail: 'Reached the buyer by phone.',
      confirmedBy: userId,
      requestKey: 'escalation-manual-contact',
    });
    expect(await readNeedCondition(need!)).toMatchObject({ holds: true });
  });

  it('raises a need for an external constraint, and none for a recoverable wait', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false }, 1);
    const constrained = await qualified();
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    const needs = await continuationNeeds(constrained.id);
    expect(needs.map((n) => n.requestKey)).toEqual([continuationEffectKey(constrained.id, 'CONTACT_BUYER', 'EXTERNAL_CONSTRAINT')]);
  });

  it('raises nothing for an outage a wait recovers from', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true }, OUTAGE_THRESHOLD);
    const waiting = await qualified();
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    expect(await continuationNeeds(waiting.id)).toHaveLength(0);
  });
});
