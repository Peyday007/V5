/**
 * CONT-35 (S-0485): a reroute is reachable, and it actually sends.
 *
 * Finding F-REROUTE-UNREACHABLE: `continuationGate` asked
 * `decideCommitmentContinuation` with no alternatives, so REROUTE could never
 * be decided, and had it been the gate refused instead of sending. Here an
 * alternative a person declared (`alternatives.ts`) is read at the send path,
 * chosen only when it is permitted, contractually workable where that applies,
 * on a different channel than a suspended one, and backed by a usable adapter
 * — and the commitment is then performed through it, once. An attempt stays
 * where it started, so an unknown send through an alternative is never
 * followed by a second send through the recovered original.
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
import { COMMERCIAL_EFFECTS, commercialOperationsFor } from '../server/services/cash/effects.ts';
import { continuationAlternativesFor, declareContinuationAlternative } from '../server/services/cash/alternatives.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { runExternalEffect } from '../server/services/effects/external.ts';
import { resetSynthetic } from '../server/services/effects/synthetic.ts';
import { CONTINUITY_CLAUSE_OWNERS, OUTAGE_THRESHOLD } from '../server/services/effects/posture.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let seq = 0;
const nextKey = (): string => `reroute-key-${String(++seq).padStart(8, '0')}`;

const CONTACT_NS = COMMERCIAL_EFFECTS.CONTACT_BUYER.namespace;
const BACKUP = `${CONTACT_NS.name}.via.backup_mailer`;
const OTHER = `${CONTACT_NS.name}.via.second_account`;

interface Provider {
  sends: number;
  onSend: () => Promise<SendOutcome>;
  adapter: EffectAdapter;
}

function provider(namespace: string): Provider {
  const state: Provider = {
    sends: 0,
    onSend: async () => ({ kind: 'CONFIRMED', receiptRef: `${namespace}-msg-${state.sends}` }),
    adapter: null as unknown as EffectAdapter,
  };
  state.adapter = {
    name: `synthetic.${namespace}`,
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
  };
  registerAdapter(state.adapter);
  return state;
}

beforeEach(async () => {
  clearAdapters();
  resetSynthetic();
  projectId = (await freshProject()).project.id;
  await cashProject();
});

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

/** Definite outcomes on the primary contact namespace, written through the effects engine itself. */
async function outcomes(primary: Provider, outcome: SendOutcome, count: number): Promise<void> {
  primary.onSend = async () => outcome;
  for (let i = 0; i < count; i += 1) {
    await runExternalEffect({ adapter: primary.adapter, namespace: CONTACT_NS, projectId, key: nextKey(), businessId: `earlier-${seq}`, payload: { note: 'earlier send' }, principalType: 'HUMAN', principalId: 'usr_one' });
  }
  primary.sends = 0;
  primary.onSend = async () => ({ kind: 'CONFIRMED', receiptRef: `primary-msg-${primary.sends}` });
}

const SUSPENDED: SendOutcome = { kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false };
const DOWN: SendOutcome = { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true };

async function declare(piece: CashOpportunity, namespace: string, over: Partial<Parameters<typeof declareContinuationAlternative>[0]> = {}) {
  const declared = await declareContinuationAlternative({
    opportunityId: piece.id,
    action: 'CONTACT_BUYER',
    namespace,
    channel: 'phone',
    permitted: true,
    actorRef: userId,
    note: 'The buyer published this second address for intake requests.',
    ...over,
  });
  if (!declared.ok) throw new Error(declared.reason);
}

async function decisions(opportunityId: string): Promise<Record<string, unknown>[]> {
  const rows = await getDb().all<{ detail: string }>(
    `SELECT detail FROM cash_events WHERE project_id = ? AND opportunity_id = ? AND kind = 'CASH_CONTINUATION_DECIDED' ORDER BY created_at, id`,
    [projectId, opportunityId],
  );
  return rows.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

describe('a suspended account changes to a permitted channel, and the commitment is sent there', () => {
  it('reroutes to the declared channel and performs the contact through its adapter, once', async () => {
    const primary = provider(CONTACT_NS.name);
    const backup = provider(BACKUP);
    await outcomes(primary, SUSPENDED, 1);
    const piece = await qualified();
    await declare(piece, BACKUP);

    await advanceWithinAuthority(projectId);
    expect(primary.sends).toBe(0);
    expect(backup.sends).toBe(1);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const [decision] = await decisions(piece.id);
    expect(decision).toMatchObject({ action: 'CONTACT_BUYER', decision: 'REROUTE', to: BACKUP, health: 'CONSTRAINED', namespace: CONTACT_NS.name });
    const ops = (await commercialOperationsFor(projectId, piece.id)).filter((one) => one.action === 'CONTACT_BUYER');
    expect(ops.map((one) => [one.operation.namespace, one.operation.state])).toEqual([[BACKUP, 'SUCCEEDED']]);

    // A second pass sends nothing more: the contact is on the record.
    await advanceWithinAuthority(projectId);
    expect(backup.sends + primary.sends).toBe(1);
  });

  it('never bypasses a suspension through another account on the same channel', async () => {
    const primary = provider(CONTACT_NS.name);
    const sameChannel = provider(OTHER);
    await outcomes(primary, SUSPENDED, 1);
    const piece = await qualified();
    await declare(piece, OTHER, { channel: 'Email' });
    await declare(piece, BACKUP, { channel: null });

    await advanceWithinAuthority(projectId);
    expect(primary.sends + sameChannel.sends).toBe(0);
    const [decision] = await decisions(piece.id);
    expect(decision).toMatchObject({ decision: 'EXTERNAL_CONSTRAINT', to: null });
    expect(JSON.stringify(decision!['skipped'])).toMatch(/another account on the suspended channel/);
    expect(JSON.stringify(decision!['skipped'])).toMatch(/nobody has said which channel/);
  });

  it('does not move to an alternative nobody said is permitted, or one Brain cannot send through', async () => {
    const primary = provider(CONTACT_NS.name);
    await outcomes(primary, SUSPENDED, 1);
    const piece = await qualified();
    await declare(piece, OTHER, { permitted: null });
    await declare(piece, BACKUP); // permitted, but no adapter is registered for it

    const read = await continuationAlternativesFor(projectId, piece.id, 'CONTACT_BUYER');
    expect(read.find((one) => one.namespace === BACKUP)).toMatchObject({ permitted: true, performable: false });

    await advanceWithinAuthority(projectId);
    expect(primary.sends).toBe(0);
    const [decision] = await decisions(piece.id);
    expect(decision).toMatchObject({ decision: 'EXTERNAL_CONSTRAINT' });
    const skipped = JSON.stringify(decision!['skipped']);
    expect(skipped).toMatch(/nobody has said it is permitted/);
    expect(skipped).toMatch(/no usable integration is registered/);
  });
});

describe('a failed supplier is switched only when the contract allows it', () => {
  it('skips a supplier whose contract is unknown, and moves once the contract is declared workable', async () => {
    const primary = provider(CONTACT_NS.name);
    const backup = provider(BACKUP);
    await outcomes(primary, DOWN, OUTAGE_THRESHOLD);
    const piece = await qualified();
    await declare(piece, BACKUP, { requiresContract: true, contractuallyWorkable: null });

    await advanceWithinAuthority(projectId);
    expect(primary.sends + backup.sends).toBe(0);
    expect((await decisions(piece.id)).at(-1)).toMatchObject({ decision: 'WAIT_RECOVERABLE' });

    await declare(piece, BACKUP, { requiresContract: true, contractuallyWorkable: true });
    await advanceWithinAuthority(projectId);
    expect(primary.sends).toBe(0);
    expect(backup.sends).toBe(1);
    expect((await decisions(piece.id)).at(-1)).toMatchObject({ decision: 'REROUTE', to: BACKUP, health: 'OUTAGE' });
  });
});

describe('an attempt continues where it started', () => {
  it('never resends through the recovered original over an unknown send through the alternative', async () => {
    const primary = provider(CONTACT_NS.name);
    const backup = provider(BACKUP);
    await outcomes(primary, SUSPENDED, 1);
    const piece = await qualified();
    await declare(piece, BACKUP);
    backup.onSend = async () => ({ kind: 'UNCERTAIN', reason: 'the connection dropped after the request was written' });

    await advanceWithinAuthority(projectId);
    expect(backup.sends).toBe(1);
    const [op] = (await commercialOperationsFor(projectId, piece.id)).filter((one) => one.action === 'CONTACT_BUYER');
    expect(op!.operation).toMatchObject({ namespace: BACKUP, state: 'UNCERTAIN' });

    // The original recovers: its latest definite outcome is a success.
    await outcomes(primary, { kind: 'CONFIRMED', receiptRef: 'unrelated' }, 1);
    await advanceWithinAuthority(projectId);
    expect(primary.sends).toBe(0);
    expect(backup.sends).toBe(1);
    expect((await getOpportunity(piece.id))!.state).not.toBe('EXECUTING');
  });
});

describe('the clause owners name the path that now performs a reroute', () => {
  it('names the declared alternatives and the send through them', () => {
    for (const clause of ['change to a permitted acquisition channel', 'switch suppliers']) {
      const owner = CONTINUITY_CLAUSE_OWNERS.find((one) => one.clause.startsWith(clause));
      expect(owner?.owner).toContain('server/services/cash/alternatives.ts');
      expect(owner?.owner).toContain('sendCommercialEffect');
      expect(owner?.reader).toContain('CASH_CONTINUATION_ALTERNATIVE_DECLARED');
    }
  });
});

