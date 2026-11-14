import { beforeEach, describe, expect, it } from 'vitest';
import {
  counterpartyLedger, doubleCommitted, holdsFrom, planTransfer, recordedReservationEvents, recordHoldOutcome, recordReservation,
  recordTransfer, remainingCapacity, reserve, RESERVATION_EVENT_KIND, withoutAuthority,
  type AuthorityReading, type ReservationEvent, type ReservationRequest,
} from '../server/services/labor/counterparties/reservations.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';

/** A real commercial grant on a project, written through the owner's own repository. */
async function grant(projectId: string, allowedActions: readonly string[] = [...COMMERCIAL_ACTIONS]): Promise<string> {
  const userId = (await createUser({ email: `cp31-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  return (await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...allowedActions], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
  })).id;
}

const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
const req = (over: Partial<ReservationRequest> = {}): ReservationRequest => ({
  key: 'k1', counterpartyId: 'crew-a', commitmentId: 'job-1', businessId: 'biz-1', units: 3, ...W,
  capacityUnits: 4, at: '2026-11-13T10:00:00Z', ...over,
});
/** The owner's reading as the pure decisions receive it; on rows only `authorityFor` makes one. */
const held = (businessId = 'biz-1'): AuthorityReading => ({
  businessId, action: 'ENGAGE_CONTRACTOR', held: true, reason: 'within the standing commercial authority', authorityId: 'cau_test', policyVersion: 1,
});
const take = (events: ReservationEvent[], r: ReservationRequest): ReservationEvent[] => {
  const a = reserve(events, r, held(r.businessId));
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
    const second = reserve(events, req({ key: 'k2', businessId: 'biz-2', commitmentId: 'job-2', units: 2 }), held('biz-2'));
    expect(second).toMatchObject({ ok: false, reason: 'CAPACITY', remaining: 1 });
    expect((second as { holders: unknown[] }).holders).toEqual([{ commitmentId: 'job-1', businessId: 'biz-1', units: 3 }]);
  });

  it('allows a non-overlapping window and a fitting amount', () => {
    const events = take([], req());
    expect(reserve(events, req({ key: 'k2', businessId: 'biz-2', commitmentId: 'job-2', units: 1 }), held('biz-2')).ok).toBe(true);
    expect(reserve(events, req({ key: 'k3', commitmentId: 'job-3', windowStart: W.windowEnd, windowEnd: '2026-12-15T00:00:00Z' }), held()).ok).toBe(true);
  });

  it('refuses without the required authority and names it', () => {
    expect(reserve([], req(), withoutAuthority('biz-1'))).toEqual({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'], detail: 'no commercial authority was read' });
  });

  it('refuses an authority read for a different business than the hold is for', () => {
    expect(reserve([], req(), held('biz-2'))).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'], detail: 'the authority read is for biz-2, not biz-1' });
  });

  it('takes nothing a caller says it holds: authority strings on the request are not read', () => {
    const asserted = { ...req(), authorityRequired: ['ENGAGE_CONTRACTOR'], authorityHeld: ['ENGAGE_CONTRACTOR'] } as unknown as ReservationRequest;
    expect(reserve([], asserted, withoutAuthority('biz-1'))).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
  });

  it('does not reserve against capacity nobody has evidenced', () => {
    expect(reserve([], req({ capacityUnits: null }), held())).toEqual({ ok: false, reason: 'CAPACITY_UNKNOWN' });
  });

  it('counts a repeated logical key once, and refuses the key reused with other terms', () => {
    const events = take([], req());
    expect(reserve(events, req(), held())).toEqual({ ok: true, duplicate: true, event: null });
    expect(holdsFrom([...events, ...events])).toHaveLength(1);
    expect(reserve(events, req({ units: 1 }), held())).toMatchObject({ ok: false, reason: 'KEY_CONFLICT' });
  });

  it('applies an outcome read back before its own RESERVED row (same-millisecond rows come back in either order)', () => {
    const [reserved] = take([], req({ at: '2026-11-20T00:00:00Z' }));
    const failed: ReservationEvent = { ...reserved!, kind: 'FAILED' };
    expect(holdsFrom([failed, reserved!]).map((h) => h.state)).toEqual(['FAILED']);
    expect(holdsFrom([reserved!, failed]).map((h) => h.state)).toEqual(['FAILED']);
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
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, at: '2026-11-20T01:00:00Z' }, held());
    expect(plan.action).toBe('TRANSFER');
    const after = [...events, ...(plan as { events: ReservationEvent[] }).events];
    expect(holdsFrom(after).find((h) => h.key === 'k1')?.state).toBe('RELEASED');
    expect(holdsFrom(after).find((h) => h.key === 'k1-alt')?.state).toBe('HELD');
    expect(doubleCommitted(after)).toEqual([]);
    expect(remainingCapacity(after, 'crew-a', 4, W).remaining).toBe(4);
  });

  it('reports an unknown outcome as unknown and neither transfers nor releases', () => {
    const events = take([], req());
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, at: '2026-11-20T01:00:00Z' }, withoutAuthority('biz-1'));
    expect(plan.action).toBe('UNKNOWN');
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(1);
  });

  it('refuses a transfer the alternative has no room for, leaving the primary held', () => {
    let events = take([], req());
    events = outcome(events, 'k1', 'FAILED', '2026-11-20T00:00:00Z');
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 2, at: '2026-11-20T01:00:00Z' }, held());
    expect(plan).toMatchObject({ action: 'REFUSED', reason: 'CAPACITY' });
  });

  it('refuses a transfer the authority reading does not cover, leaving the primary failed and nothing held', () => {
    let events = take([], req());
    events = outcome(events, 'k1', 'FAILED', '2026-11-20T00:00:00Z');
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, at: '2026-11-20T01:00:00Z' }, withoutAuthority('biz-1'));
    expect(plan).toMatchObject({ action: 'REFUSED', reason: 'MISSING_AUTHORITY' });
  });
});

// ---------------------------------------------------------------------------
// The recorded half: real rows, one arbiter
// ---------------------------------------------------------------------------

describe('reservations, recorded', () => {
  let bizA = '';
  let bizB = '';
  beforeEach(async () => {
    bizA = (await freshProject()).project.id;
    bizB = (await createProject({ name: 'Second business' })).id;
    await grant(bizA);
    await grant(bizB);
  });

  it('writes each event as an append-only cash_events row on the counterparty ledger, readable across businesses', async () => {
    const first = await recordReservation(req({ businessId: bizA }), 'BRAIN');
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const rows = await getDb().all<{ project_id: string; opportunity_id: string; kind: string; actor_ref: string }>(
      'SELECT project_id, opportunity_id, kind, actor_ref FROM cash_events WHERE kind = ?', [RESERVATION_EVENT_KIND],
    );
    expect(rows).toEqual([{ project_id: bizA, opportunity_id: counterpartyLedger('crew-a'), kind: RESERVATION_EVENT_KIND, actor_ref: 'BRAIN' }]);
    // A second business is refused on the capacity the first one holds, read from the row.
    const second = await recordReservation(req({ key: 'k2', businessId: bizB, commitmentId: 'job-2', units: 2 }), 'BRAIN');
    expect(second).toMatchObject({ ok: false, reason: 'CAPACITY', remaining: 1, holders: [{ commitmentId: 'job-1', businessId: bizA, units: 3 }] });
    // The repeat of the same logical key writes nothing.
    expect(await recordReservation(req({ businessId: bizA }), 'BRAIN')).toEqual({ ok: true, duplicate: true, event: null });
    expect(await recordedReservationEvents(['crew-a'])).toHaveLength(1);
  });

  it('lets exactly one of two concurrent businesses take the last capacity', async () => {
    const answers = await Promise.all([
      recordReservation(req({ key: 'race-1', businessId: bizA, commitmentId: 'job-1', units: 3 }), 'BRAIN'),
      recordReservation(req({ key: 'race-2', businessId: bizB, commitmentId: 'job-2', units: 3 }), 'BRAIN'),
    ]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok && a.reason === 'CAPACITY')).toHaveLength(1);
    const events = await recordedReservationEvents(['crew-a']);
    expect(events).toHaveLength(1);
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(1);
  });

  it('records a reported failure, then transfers in one transaction, and never on silence', async () => {
    await recordReservation(req({ businessId: bizA }), 'BRAIN');
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

// ---------------------------------------------------------------------------
// The repair: authority is the owner's live grant, never the caller's word
// ---------------------------------------------------------------------------

describe('reservations, recorded, under the live commercial grant', () => {
  let biz = '';
  beforeEach(async () => {
    biz = (await freshProject()).project.id;
  });

  it('refuses a business with no grant, whatever the caller puts on the request, and writes nothing', async () => {
    const asserted = { ...req({ businessId: biz }), authorityRequired: ['ENGAGE_CONTRACTOR'], authorityHeld: ['ENGAGE_CONTRACTOR'] } as unknown as ReservationRequest;
    const answer = await recordReservation(asserted, 'BRAIN');
    expect(answer).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'], detail: 'no standing commercial authority exists for this project' });
    expect(await recordedReservationEvents(['crew-a'])).toEqual([]);
  });

  it('refuses a grant that does not cover ENGAGE_CONTRACTOR, and holds under one that does, recording the grant', async () => {
    await grant(biz, ['CONTACT_BUYER', 'QUOTE_AND_INVOICE']);
    expect(await recordReservation(req({ businessId: biz }), 'BRAIN'))
      .toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'], detail: 'the commercial authority does not cover ENGAGE_CONTRACTOR' });
    expect(await recordedReservationEvents(['crew-a'])).toEqual([]);

    const other = (await createProject({ name: 'Granted business' })).id;
    const authorityId = await grant(other);
    expect(await recordReservation(req({ businessId: other }), 'BRAIN')).toMatchObject({ ok: true, duplicate: false });
    const [event] = await recordedReservationEvents(['crew-a']);
    expect(event).toMatchObject({ kind: 'RESERVED', authorityHeld: ['ENGAGE_CONTRACTOR'], authorityId });
  });

  it('stops reserving the moment the grant is revoked', async () => {
    const authorityId = await grant(biz);
    expect(await recordReservation(req({ businessId: biz }), 'BRAIN')).toMatchObject({ ok: true });
    const user = (await createUser({ email: `cp31-r-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    await revokeAuthority({ authorityId, actorUserId: user, reason: 'stop committing contractors' });
    expect(await recordReservation(req({ businessId: biz, key: 'k2', commitmentId: 'job-2', units: 1 }), 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
    expect(await recordedReservationEvents(['crew-a'])).toHaveLength(1);
  });

  it('refuses the transfer after a failure when the failed hold\'s business has lost its grant', async () => {
    const authorityId = await grant(biz);
    await recordReservation(req({ businessId: biz }), 'BRAIN');
    await recordHoldOutcome({ counterpartyId: 'crew-a', key: 'k1', kind: 'FAILED', at: '2026-11-20T00:00:00Z', actorRef: 'BRAIN' });
    const user = (await createUser({ email: `cp31-t-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    await revokeAuthority({ authorityId, actorUserId: user, reason: 'withdrawn' });
    const transfer = { primaryKey: 'k1', primaryCounterpartyId: 'crew-a', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, at: '2026-11-20T01:00:00Z' };
    expect(await recordTransfer(transfer, 'BRAIN')).toMatchObject({ action: 'REFUSED', reason: 'MISSING_AUTHORITY' });
    expect(holdsFrom(await recordedReservationEvents(['crew-a', 'crew-b'])).map((h) => [h.key, h.state])).toEqual([['k1', 'FAILED']]);
  });
});
