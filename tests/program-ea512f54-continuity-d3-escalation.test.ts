/**
 * CONT-35 (S-0485), finding F-ESCALATION-REACHES-NOBODY: an escalated
 * continuation reaches a person.
 *
 * `planContinuation` says ESCALATE_TIME_CRITICAL means "a person is told now".
 * `continuationGate` used to record only a `CASH_CONTINUATION_DECIDED` cash
 * event, which nothing reads — so a time-critical commitment, and an external
 * constraint no other service may bypass, sat in a history nobody opens. Both
 * now raise an open need through `raiseNeed`, the owner of "a person must act",
 * once per decision rather than once per tick.
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
import { getOpportunity, openNeedForKey, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { resetSynthetic } from '../server/services/effects/synthetic.ts';
import { OUTAGE_THRESHOLD } from '../server/services/effects/posture.ts';
import { continuationNeedKey, continuationNeedsAPerson } from '../server/services/cash/perform.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let seq = 0;
const nextKey = (): string => `escalation-key-${String(++seq).padStart(8, '0')}`;
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

beforeEach(async () => {
  clearAdapters();
  resetSynthetic();
  projectId = (await freshProject()).project.id;
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

async function refusals(provider: Provider, outcome: SendOutcome, count: number): Promise<void> {
  provider.onSend = async () => outcome;
  for (let i = 0; i < count; i += 1) {
    await runExternalEffect({ adapter: provider.adapter, namespace: CONTACT_NS, projectId, key: nextKey(), businessId: `earlier-${i}`, payload: { note: 'earlier send' }, principalType: 'HUMAN', principalId: 'usr_one' });
  }
  provider.sends = 0;
  provider.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: `msg-${provider.sends}` });
}

async function needsFor(opportunityId: string): Promise<{ id: string; request_key: string | null; state: string; recommended_path: string; next_step: string }[]> {
  return await getDb().all(
    `SELECT id, request_key, state, recommended_path, next_step FROM cash_needs WHERE project_id = ? AND opportunity_id = ?`,
    [projectId, opportunityId],
  );
}

async function continuationEvents(opportunityId: string): Promise<Record<string, unknown>[]> {
  const rows = await getDb().all<{ detail: string }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_CONTINUATION_DECIDED'`,
    [projectId, opportunityId],
  );
  return rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

describe('an escalated continuation reaches a person', () => {
  it('names exactly the decisions a person must act on', () => {
    expect(continuationNeedsAPerson('ESCALATE_TIME_CRITICAL')).toBe(true);
    expect(continuationNeedsAPerson('EXTERNAL_CONSTRAINT')).toBe(true);
    for (const other of ['PROCEED', 'HOLD_RECONCILE', 'REROUTE', 'WAIT_RECOVERABLE']) expect(continuationNeedsAPerson(other)).toBe(false);
  });

  it('raises an open need for a time-critical commitment, once, however many ticks read it', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false }, 1);
    const urgent = await qualified();
    await updateOpportunity(urgent.id, { deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString() } as never);

    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);

    const key = continuationNeedKey(urgent.id, 'CONTACT_BUYER', 'ESCALATE_TIME_CRITICAL');
    const need = await openNeedForKey(projectId, key);
    expect(need).not.toBeNull();
    expect(need!.opportunityId).toBe(urgent.id);
    expect(need!.recommendedPath).toMatch(/before the deadline/);
    expect((await needsFor(urgent.id)).filter((row) => row.request_key === key)).toHaveLength(1);

    const events = await continuationEvents(urgent.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'ESCALATE_TIME_CRITICAL', needId: need!.id });

    const raised = await getDb().all<{ id: string }>(
      `SELECT id FROM cash_events WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_NEED_RAISED'`,
      [projectId, urgent.id],
    );
    expect(raised.length).toBeGreaterThanOrEqual(1);
  });

  it('raises an open need for an external constraint no alternative may bypass', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false }, 1);
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    const need = await openNeedForKey(projectId, continuationNeedKey(piece.id, 'CONTACT_BUYER', 'EXTERNAL_CONSTRAINT'));
    expect(need).not.toBeNull();
    expect(need!.whyItMatters).toMatch(/refused for good/);
    expect((await continuationEvents(piece.id))[0]).toMatchObject({ decision: 'EXTERNAL_CONSTRAINT', needId: need!.id });
  });

  it('raises nothing for a recoverable outage, which resolves itself', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true }, OUTAGE_THRESHOLD);
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    expect((await continuationEvents(piece.id))[0]).toMatchObject({ decision: 'WAIT_RECOVERABLE', needId: null });
    expect((await needsFor(piece.id)).filter((row) => row.request_key?.startsWith('continuation:'))).toHaveLength(0);
  });

  it('tells a person about a decision recorded before escalations raised needs, then stops repeating it', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false }, 1);
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    const key = continuationNeedKey(piece.id, 'CONTACT_BUYER', 'EXTERNAL_CONSTRAINT');
    // Simulate a production row written before the fix: the decision recorded, no need, no needId.
    await getDb().run(`DELETE FROM cash_needs WHERE project_id = ? AND request_key = ?`, [projectId, key]);
    const rows = await getDb().all<{ id: string; detail: string }>(
      `SELECT id, detail FROM cash_events WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_CONTINUATION_DECIDED'`,
      [projectId, piece.id],
    );
    for (const row of rows) {
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      delete detail['needId'];
      await getDb().run(`UPDATE cash_events SET detail = ? WHERE id = ?`, [JSON.stringify(detail), row.id]);
    }

    await advanceWithinAuthority(projectId);
    expect(await openNeedForKey(projectId, key)).not.toBeNull();
    await advanceWithinAuthority(projectId);
    expect(await continuationEvents(piece.id)).toHaveLength(2);
    expect(provider.sends).toBe(0);
  });
});
