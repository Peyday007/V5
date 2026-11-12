/**
 * CONT-35 (S-0485): `planContinuation` has a production consumer.
 *
 * The clauses it owns — change to a permitted channel when an account is
 * suspended, switch suppliers only when contractually workable, preserve a
 * time-critical commitment — hold only if something that actually sends asks
 * it first. `decideCommitmentContinuation` reads the dependency's health and
 * the commitment's unsettled effects from the effect ledger and asks it; the
 * commercial send path (a person's press and the tick alike, through
 * `continuationGate`) sends only on PROCEED and records every other decision
 * as a `CASH_CONTINUATION_DECIDED` cash event with its reasons.
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
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { OPAQUE, opaqueAdapter, registerSyntheticAdapters, resetSynthetic, setFault, type Fault } from '../server/services/effects/synthetic.ts';
import type { OperationNamespace } from '../server/services/effects/engine.ts';
import {
  CONTINUITY_CLAUSE_OWNERS,
  OUTAGE_THRESHOLD,
  TIME_CRITICAL_WINDOW_MS,
  decideCommitmentContinuation,
  isTimeCritical,
} from '../server/services/effects/posture.ts';
import { runContinuityCommand } from '../server/services/effects/continuity.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let seq = 0;
const nextKey = (): string => `continuation-key-${String(++seq).padStart(8, '0')}`;

beforeEach(async () => {
  clearAdapters();
  resetSynthetic();
  projectId = (await freshProject()).project.id;
});

/* ------------------------------------------------------------------------- */
/* The decision, read from ledger rows                                        */
/* ------------------------------------------------------------------------- */

const OPAQUE_NS: OperationNamespace = { name: opaqueAdapter.namespace, version: 1, principalScope: 'PRINCIPAL', retention: 'PERMANENT' };

async function opaqueRun(fault: Fault, businessId: string): Promise<void> {
  setFault(OPAQUE, fault);
  await runExternalEffect({ adapter: opaqueAdapter, namespace: OPAQUE_NS, projectId, key: nextKey(), businessId, payload: { note: 'x' }, principalType: 'HUMAN', principalId: 'usr_one' });
  setFault(OPAQUE, 'NONE');
}

describe('decideCommitmentContinuation reads the ledger and asks planContinuation', () => {
  beforeEach(() => registerSyntheticAdapters());

  it('proceeds on a healthy dependency', async () => {
    await opaqueRun('NONE', 'biz-ok');
    const decision = await decideCommitmentContinuation({ projectId, namespace: OPAQUE_NS.name, channel: null, otherAttempt: () => false, deadline: null });
    expect(decision).toMatchObject({ action: 'PROCEED', unsettled: 0, timeCritical: false });
    expect(decision.health.status).toBe('HEALTHY');
  });

  it('waits out a recoverable outage, and escalates when the deadline is near', async () => {
    for (let i = 0; i < OUTAGE_THRESHOLD; i += 1) await opaqueRun('REJECT_RETRYABLE', `biz-down-${i}`);
    const waiting = await decideCommitmentContinuation({ projectId, namespace: OPAQUE_NS.name, channel: null, otherAttempt: () => false, deadline: null });
    expect(waiting.action).toBe('WAIT_RECOVERABLE');
    expect(waiting.health.status).toBe('OUTAGE');

    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const urgent = await decideCommitmentContinuation({ projectId, namespace: OPAQUE_NS.name, channel: null, otherAttempt: () => false, deadline: soon });
    expect(urgent).toMatchObject({ action: 'ESCALATE_TIME_CRITICAL', timeCritical: true });
  });

  it('holds a commitment whose earlier effect may have been accepted', async () => {
    await opaqueRun('THROW', 'biz-unknown');
    const held = await decideCommitmentContinuation({ projectId, namespace: OPAQUE_NS.name, channel: null, otherAttempt: () => true, deadline: null });
    expect(held).toMatchObject({ action: 'HOLD_RECONCILE', unsettled: 1 });
    // The attempt being made now is not its own reason to hold.
    const self = await decideCommitmentContinuation({ projectId, namespace: OPAQUE_NS.name, channel: null, otherAttempt: () => false, deadline: null });
    expect(self.unsettled).toBe(0);
  });

  it('is served by the continuity terminal', async () => {
    for (let i = 0; i < OUTAGE_THRESHOLD; i += 1) await opaqueRun('REJECT_RETRYABLE', `biz-cli-${i}`);
    const { code, out } = await runContinuityCommand(['continuation', '--project', projectId, '--namespace', OPAQUE_NS.name]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ action: 'WAIT_RECOVERABLE', namespace: OPAQUE_NS.name });
    expect((await runContinuityCommand(['continuation', '--project', projectId])).code).toBe(2);
  });

  it('reads a deadline as time-critical only inside the window', () => {
    const now = '2026-11-12T12:00:00.000Z';
    expect(isTimeCritical(null, now)).toBe(false);
    expect(isTimeCritical('not a date', now)).toBe(false);
    expect(isTimeCritical(new Date(Date.parse(now) + TIME_CRITICAL_WINDOW_MS - 1).toISOString(), now)).toBe(true);
    expect(isTimeCritical(new Date(Date.parse(now) + TIME_CRITICAL_WINDOW_MS + 60_000).toISOString(), now)).toBe(false);
  });

  it('names the production consumer as the owner of the channel, supplier and time-critical clauses', () => {
    for (const clause of ['change to a permitted acquisition channel', 'switch suppliers', 'preserve time-critical']) {
      const owner = CONTINUITY_CLAUSE_OWNERS.find((one) => one.clause.startsWith(clause));
      expect(owner?.owner).toContain('decideCommitmentContinuation');
      expect(owner?.reader).toContain('CASH_CONTINUATION_DECIDED');
    }
  });
});

/* ------------------------------------------------------------------------- */
/* The send path consumes it                                                  */
/* ------------------------------------------------------------------------- */

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

describe('the commercial send path asks planContinuation before it sends', () => {
  beforeEach(cashProject);

  it('reaches the buyer when the dependency is healthy, and records no continuation decision', async () => {
    const provider = contactProvider();
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(1);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    expect(await continuationEvents(piece.id)).toHaveLength(0);
  });

  it('does not send into a recoverable outage, and records why', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true }, OUTAGE_THRESHOLD);
    const piece = await qualified();
    const report = await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    expect((await getOpportunity(piece.id))!.state).not.toBe('EXECUTING');
    expect(report.withheld.some((one) => one.opportunityId === piece.id && /down, which is recoverable/.test(one.because))).toBe(true);
    const [event] = await continuationEvents(piece.id);
    expect(event).toMatchObject({ action: 'CONTACT_BUYER', decision: 'WAIT_RECOVERABLE', health: 'OUTAGE', namespace: CONTACT_NS.name });
  });

  it('treats a suspended account as an external constraint, and escalates a commitment due soon', async () => {
    const provider = contactProvider();
    await refusals(provider, { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false }, 1);
    const piece = await qualified();
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    expect((await continuationEvents(piece.id))[0]).toMatchObject({ decision: 'EXTERNAL_CONSTRAINT', health: 'CONSTRAINED' });

    const urgent = await qualified();
    await updateOpportunity(urgent.id, { deadline: new Date(Date.now() + 2 * 60 * 60_000).toISOString() } as never);
    await advanceWithinAuthority(projectId);
    expect(provider.sends).toBe(0);
    expect((await continuationEvents(urgent.id))[0]).toMatchObject({ decision: 'ESCALATE_TIME_CRITICAL', timeCritical: true });
  });
});
