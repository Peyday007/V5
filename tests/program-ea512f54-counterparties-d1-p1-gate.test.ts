/**
 * CP-31 repair (repair-hold-refusal-does-not-gate-send): when the recorder refused a provider's
 * capacity hold — the window fully held across businesses, or the project's grant not held — the
 * send still went out, unheld, so the over-booking was invisible to every reading. A refused hold
 * now refuses the send before the provider is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { clearAdapters, type EffectAdapter, type EffectRequest, type SendOutcome } from '../server/services/effects/adapter.ts';
import {
  providerCounterpartyId,
  recordProviderAttempt,
  recordingCounterparty,
  refusalOutcome,
  type ProviderSeat,
} from '../server/services/cash/providers/counterpartyRecord.ts';
import { holdsFrom, recordedReservationEvents } from '../server/services/labor/counterparties/reservations.ts';

let capacity: number | null = 1;
const seat: ProviderSeat = {
  area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: async () => capacity,
};
const ID = providerCounterpartyId(seat);

let day = 0;
let AT = '';
beforeEach(() => {
  clearAdapters();
  capacity = 1;
  day += 1;
  AT = new Date(Date.UTC(2033, 0, day, 12)).toISOString();
});
afterEach(() => clearAdapters());

async function business(granted: boolean, another = false): Promise<string> {
  const projectId = another
    ? (await createProject({ name: `Gate business ${Math.random().toString(36).slice(2, 8)}` })).id
    : (await freshProject()).project.id;
  const userId = (await createUser({ email: `cp31g-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  if (granted) {
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
    });
  }
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value.id;
}

const request = (opportunityId: string): EffectRequest => ({ providerKey: null, businessId: `cash:${opportunityId}:CONTACT_BUYER:1`, payload: {} });

/** A provider call that counts whether it was made. */
function counted(outcome: SendOutcome): { calls: () => number; send: () => Promise<SendOutcome> } {
  let n = 0;
  return { calls: () => n, send: async () => { n += 1; return outcome; } };
}

describe('a refused hold refuses the send', () => {
  it('the last unit of shared capacity goes to one business; the other is not sent, and nothing is over-booked', async () => {
    const a = await business(true);
    const b = await business(true, true);
    // An unknown outcome keeps its hold (invariant 26), so the window's one unit stays taken.
    const first = counted({ kind: 'UNCERTAIN', reason: 'no answer' });
    expect((await recordProviderAttempt(seat, request(a), first.send, () => AT)).recorded.outcome).toBe('UNKNOWN');
    const second = counted({ kind: 'CONFIRMED', receiptRef: 'lead-b' });
    const { outcome, recorded } = await recordProviderAttempt(seat, request(b), second.send, () => AT);
    expect(second.calls()).toBe(0);
    expect(outcome).toMatchObject({ kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true });
    expect(recorded.refusedSend).toBe('CAPACITY');
    expect(recorded.outcome).toBeNull();
    // One unit of capacity, one hold: the ledger carries exactly the send that was made.
    const holds = holdsFrom(await recordedReservationEvents([ID]));
    expect(holds.map((h) => h.state)).toEqual(['HELD']);
  });

  it('without the live grant the provider is never called, and the refusal is terminal', async () => {
    capacity = 5;
    const opportunityId = await business(false);
    const call = counted({ kind: 'CONFIRMED', receiptRef: 'x' });
    const { outcome, recorded } = await recordProviderAttempt(seat, request(opportunityId), call.send, () => AT);
    expect(call.calls()).toBe(0);
    expect(outcome).toMatchObject({ kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false });
    expect(recorded.refusedSend).toBe('MISSING_AUTHORITY');
    expect(await recordedReservationEvents([ID])).toHaveLength(0);
  });

  it('capacity the provider does not report is not invented and does not stop the send', async () => {
    capacity = null;
    const opportunityId = await business(true);
    const call = counted({ kind: 'CONFIRMED', receiptRef: 'y' });
    const { outcome, recorded } = await recordProviderAttempt(seat, request(opportunityId), call.send, () => AT);
    expect(call.calls()).toBe(1);
    expect(outcome).toEqual({ kind: 'CONFIRMED', receiptRef: 'y' });
    expect(recorded.hold).toMatchObject({ ok: false, reason: 'CAPACITY_UNKNOWN' });
    expect(recorded.refusedSend ?? null).toBeNull();
  });

  it('the wrapped adapter the boot registers applies the same gate', async () => {
    const a = await business(true);
    const b = await business(true, true);
    let calls = 0;
    const inner: EffectAdapter = {
      name: 'test.gate', namespace: 'test.gate', effectClass: 'IDEMPOTENT',
      send: async () => { calls += 1; return { kind: 'UNCERTAIN', reason: 'no answer' }; },
    } as unknown as EffectAdapter;
    const wrapped = recordingCounterparty(inner, seat);
    expect((await wrapped.send(request(a))).kind).toBe('UNCERTAIN');
    expect((await wrapped.send(request(b))).kind).toBe('REJECTED');
    expect(calls).toBe(1);
  });

  it('maps every refusal to a definite answer, and lets the unheld cases through', () => {
    expect(refusalOutcome(null)).toBeNull();
    expect(refusalOutcome({ ok: true, duplicate: false, event: null })).toBeNull();
    expect(refusalOutcome({ ok: false, reason: 'CAPACITY_UNKNOWN' })).toBeNull();
    expect(refusalOutcome({ ok: false, reason: 'KEY_CONFLICT', detail: 'x' })).toMatchObject({ kind: 'REJECTED', retryable: false });
    expect(refusalOutcome({ ok: false, reason: 'INVALID', detail: 'x' })).toMatchObject({ kind: 'REJECTED', retryable: false });
  });
});
