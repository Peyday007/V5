import { beforeEach, describe, expect, it } from 'vitest';
import {
  counterpartyLedger, doubleCommitted, holdsFrom, planTransfer, recordedReservationEvents, recordHoldOutcome, recordReservation,
  recordTransfer, remainingCapacity, reserve, RESERVATION_EVENT_KIND,
  type ReservationEvent, type ReservationRequest,
} from '../server/services/labor/counterparties/reservations.ts';
import { getDb } from '../server/db/database.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { createProject } from '../server/repos/projects.ts';
import type { CommercialDecision } from '../server/services/cash/authority.ts';
import { freshProject } from './helpers.ts';

/** A decision as the authority owner (`checkCommercialAuthority`) returns it, for the pure layer. */
const grant = (businessId: string, allowedActions: string[] = ['ENGAGE_CONTRACTOR']): CommercialDecision => ({
  ok: true, reason: 'within the standing commercial authority', policyVersion: 1,
  authority: {
    id: `cau_${businessId}`, projectId: businessId, ownerUserId: 'usr_owner', name: 'test grant', policyVersion: 1, allowedActions, prohibitions: [],
    maxCommittedCents: 0, maxPerActionCents: 0, maxConcurrent: 1, currency: 'USD', startsAt: '2026-01-01T00:00:00Z', expiresAt: null, state: 'ACTIVE',
    revokedAt: null, revokedByUserId: null, revokedReason: null, createdByUserId: 'usr_owner', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
});
const NO_GRANT: CommercialDecision = { ok: false, authority: null, reason: 'no standing commercial authority exists for this project', policyVersion: null };

const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
const req = (over: Partial<ReservationRequest> = {}): ReservationRequest => {
  const businessId = over.businessId ?? 'biz-1';
  return {
    key: 'k1', counterpartyId: 'crew-a', commitmentId: 'job-1', businessId, units: 3, ...W,
    capacityUnits: 4, authority: grant(businessId), at: '2026-11-13T10:00:00Z', ...over,
  };
};
/** The recorded request: no authority field at all — the arbiter reads the live grant itself. */
const rec = (over: Partial<ReservationRequest> = {}): Omit<ReservationRequest, 'authority'> => {
  const { authority: _a, ...rest } = req(over);
  return rest;
};
const take = (events: ReservationEvent[], r: ReservationRequest): ReservationEvent[] => {
  const a = reserve(events, r);
  if (!a.ok || !a.event) throw new Error('expected a new reservation');
  return [...events, a.event];
};
const outcome = (events: ReservationEvent[], key: string, kind: 'FAILED' | 'RELEASED' | 'PERFORMED', at: string): ReservationEvent[] => {
  const h = holdsFrom(events).find((x) => x.key === key)!;
  return [...events, { kind, key, counterpartyId: h.counterpartyId, commitmentId: h.commitmentId, businessId: h.businessId, units: h.units, windowStart: h.windowStart, windowEnd: h.windowEnd, authorityHeld: [], at }];
};

describe('reservations', () => {
  it('refuses a second business on the same scarce capacity and names the holder', () => {
    const events = take([], req());
    const second = reserve(events, req({ key: 'k2', businessId: 'biz-2', commitmentId: 'job-2', units: 2 }));
    expect(second).toMatchObject({ ok: false, reason: 'CAPACITY', remaining: 1 });
    expect((second as { holders: unknown[] }).holders).toEqual([{ commitmentId: 'job-1', businessId: 'biz-1', units: 3 }]);
  });

  it('allows a non-overlapping window and a fitting amount', () => {
    const events = take([], req());
    expect(reserve(events, req({ key: 'k2', businessId: 'biz-2', commitmentId: 'job-2', units: 1 })).ok).toBe(true);
    expect(reserve(events, req({ key: 'k3', commitmentId: 'job-3', windowStart: W.windowEnd, windowEnd: '2026-12-15T00:00:00Z' })).ok).toBe(true);
  });

  it('refuses without the live commercial grant and names ENGAGE_CONTRACTOR', () => {
    expect(reserve([], req({ authority: NO_GRANT }))).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'] });
    expect(reserve([], req({ authority: null }))).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'] });
    // A grant that does not cover the action, or that belongs to another business, authorizes nothing.
    expect(reserve([], req({ authority: grant('biz-1', ['CONTACT_BUYER']) }))).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
    expect(reserve([], req({ authority: grant('biz-other') }))).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
  });

  it('does not reserve against capacity nobody has evidenced', () => {
    expect(reserve([], req({ capacityUnits: null }))).toEqual({ ok: false, reason: 'CAPACITY_UNKNOWN' });
  });

  it('counts a repeated logical key once, and refuses the key reused with other terms', () => {
    const events = take([], req());
    expect(reserve(events, req())).toEqual({ ok: true, duplicate: true, event: null });
    expect(holdsFrom([...events, ...events])).toHaveLength(1);
    expect(reserve(events, req({ units: 1 }))).toMatchObject({ ok: false, reason: 'KEY_CONFLICT' });
  });

  it('computes capacity from events: a release frees it, and no counter exists', () => {
    let events = take([], req());
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(1);
    events = outcome(events, 'k1', 'RELEASED', '2026-11-14T00:00:00Z');
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(4);
  });

  it('transfers to the alternative after a reported failure, releasing the primary, with no double commitment', () => {
    let events = take([], req());
    events = outcome(events, 'k1', 'FAILED', '2026-11-20T00:00:00Z');
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, authority: grant('biz-1'), at: '2026-11-20T01:00:00Z' });
    expect(plan.action).toBe('TRANSFER');
    const after = [...events, ...(plan as { events: ReservationEvent[] }).events];
    expect(holdsFrom(after).find((h) => h.key === 'k1')?.state).toBe('RELEASED');
    expect(holdsFrom(after).find((h) => h.key === 'k1-alt')?.state).toBe('HELD');
    expect(doubleCommitted(after)).toEqual([]);
    expect(remainingCapacity(after, 'crew-a', 4, W).remaining).toBe(4);
  });

  it('reports an unknown outcome as unknown and neither transfers nor releases', () => {
    const events = take([], req());
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, authority: grant('biz-1'), at: '2026-11-20T01:00:00Z' });
    expect(plan.action).toBe('UNKNOWN');
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(1);
  });

  it('refuses a transfer the alternative has no room for, leaving the primary held', () => {
    let events = take([], req());
    events = outcome(events, 'k1', 'FAILED', '2026-11-20T00:00:00Z');
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 2, authority: grant('biz-1'), at: '2026-11-20T01:00:00Z' });
    expect(plan).toMatchObject({ action: 'REFUSED', reason: 'CAPACITY' });
  });
});

// ---------------------------------------------------------------------------
// The recorded half: real rows, one arbiter
// ---------------------------------------------------------------------------

describe('reservations, recorded', () => {
  let bizA = '';
  let bizB = '';
  const engage = (projectId: string) => createAuthority({
    projectId, ownerUserId: 'usr_owner', createdByUserId: 'usr_owner', name: 'test grant', allowedActions: ['ENGAGE_CONTRACTOR'],
    prohibitions: [], maxCommittedCents: 100_000, maxPerActionCents: 100_000, maxConcurrent: 3, currency: 'USD',
  });
  beforeEach(async () => {
    bizA = (await freshProject()).project.id;
    bizB = (await createProject({ name: 'Recorded business B' })).id;
    await engage(bizA);
    await engage(bizB);
  });

  it('writes each event as an append-only cash_events row on the counterparty ledger, readable across businesses', async () => {
    const first = await recordReservation(rec({ businessId: bizA }), 'BRAIN');
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const rows = await getDb().all<{ project_id: string; opportunity_id: string; kind: string; actor_ref: string }>(
      'SELECT project_id, opportunity_id, kind, actor_ref FROM cash_events WHERE kind = ?', [RESERVATION_EVENT_KIND],
    );
    expect(rows).toEqual([{ project_id: bizA, opportunity_id: counterpartyLedger('crew-a'), kind: RESERVATION_EVENT_KIND, actor_ref: 'BRAIN' }]);
    // A second business is refused on the capacity the first one holds, read from the row.
    const second = await recordReservation(rec({ key: 'k2', businessId: bizB, commitmentId: 'job-2', units: 2 }), 'BRAIN');
    expect(second).toMatchObject({ ok: false, reason: 'CAPACITY', remaining: 1, holders: [{ commitmentId: 'job-1', businessId: bizA, units: 3 }] });
    // The repeat of the same logical key writes nothing.
    expect(await recordReservation(rec({ businessId: bizA }), 'BRAIN')).toEqual({ ok: true, duplicate: true, event: null });
    expect(await recordedReservationEvents(['crew-a'])).toHaveLength(1);
  });

  it('lets exactly one of two concurrent businesses take the last capacity', async () => {
    const answers = await Promise.all([
      recordReservation(rec({ key: 'race-1', businessId: bizA, commitmentId: 'job-1', units: 3 }), 'BRAIN'),
      recordReservation(rec({ key: 'race-2', businessId: bizB, commitmentId: 'job-2', units: 3 }), 'BRAIN'),
    ]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok && a.reason === 'CAPACITY')).toHaveLength(1);
    const events = await recordedReservationEvents(['crew-a']);
    expect(events).toHaveLength(1);
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(1);
  });

  it('records a reported failure, then transfers in one transaction, and never on silence', async () => {
    await recordReservation(rec({ businessId: bizA }), 'BRAIN');
    const transfer = { primaryKey: 'k1', primaryCounterpartyId: 'crew-a', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, at: '2026-11-20T01:00:00Z' };
    expect(await recordTransfer(transfer, 'BRAIN')).toMatchObject({ action: 'UNKNOWN' });
    expect(await recordedReservationEvents(['crew-a', 'crew-b'])).toHaveLength(1);

    expect(await recordHoldOutcome({ counterpartyId: 'crew-a', key: 'k1', kind: 'FAILED', at: '2026-11-20T00:00:00Z', actorRef: 'BRAIN' })).toMatchObject({ recorded: true });
    expect(await recordTransfer(transfer, 'BRAIN')).toMatchObject({ action: 'TRANSFER' });
    const after = await recordedReservationEvents(['crew-a', 'crew-b']);
    expect(holdsFrom(after).map((h) => [h.key, h.state]).sort()).toEqual([['k1', 'RELEASED'], ['k1-alt', 'HELD']]);
    expect(doubleCommitted(after)).toEqual([]);
    // Doing it again transfers nothing a second time.
    expect(await recordTransfer(transfer, 'BRAIN')).toMatchObject({ action: 'REFUSED', reason: 'NOT_FAILED' });
    expect(await recordedReservationEvents(['crew-a', 'crew-b'])).toHaveLength(after.length);
  });

  it('refuses an outcome for a hold that does not exist, and writes nothing', async () => {
    expect(await recordHoldOutcome({ counterpartyId: 'crew-a', key: 'nope', kind: 'FAILED', at: '2026-11-20T00:00:00Z', actorRef: 'BRAIN' }))
      .toMatchObject({ recorded: false, reason: 'NO_SUCH_HOLD' });
    expect(await recordedReservationEvents(['crew-a'])).toEqual([]);
  });
});
