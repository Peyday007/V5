/**
 * CP-31 repair: "reserve only with required authority" is the owner's live
 * commercial authority row, never a list a caller wrote (§10.3, §20.4).
 *
 * The finding this file guards against: a reservation was authorized by
 * comparing two caller-supplied string arrays, so a caller could assert any
 * authority it liked and a row was written. Each test below would have passed
 * a write under that comparison and must now be refused, with nothing written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { checkCommercialAuthority, type CommercialDecision } from '../server/services/cash/authority.ts';
import { recordCounterpartyFacts, type Counterparty, type Fact } from '../server/services/labor/counterparties/ladder.ts';
import {
  decideRecorded, recordedReservationEvents, recordHoldOutcome, recordReservation, recordTransfer, reservationAuthority, RESERVATION_ACTION,
  RESERVATION_EVENT_KIND, type ReservationEvent, type ReservationRequest,
} from '../server/services/labor/counterparties/reservations.ts';
import { reserveRecordedTransaction, type RecordedTransactionInput } from '../server/services/labor/counterparties/transaction.ts';
import { freshProject } from './helpers.ts';

const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
const rows = async (): Promise<number> =>
  Number((await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM cash_events WHERE kind = ?', [RESERVATION_EVENT_KIND]))[0]!.n);

const grantRow = (projectId: string, allowedActions: string[], extra: { prohibitions?: string[]; expiresAt?: string | null } = {}) => createAuthority({
  projectId, ownerUserId: 'usr_owner', createdByUserId: 'usr_owner', name: 'test grant', allowedActions,
  prohibitions: extra.prohibitions ?? [], maxCommittedCents: 100_000, maxPerActionCents: 100_000, maxConcurrent: 3, currency: 'USD',
  expiresAt: extra.expiresAt ?? null,
});

describe('CP-31: a reservation is authorized by the live commercial authority row only', () => {
  let biz = '';
  const request = (over: Partial<Omit<ReservationRequest, 'authority'>> = {}): Omit<ReservationRequest, 'authority'> => ({
    key: 'k1', counterpartyId: 'crew-a', commitmentId: 'job-1', businessId: biz, units: 1, ...W, capacityUnits: 4, at: '2026-11-13T10:00:00Z', ...over,
  });
  beforeEach(async () => {
    biz = (await freshProject()).project.id;
  });

  it('the action is the existing owner\'s ENGAGE_CONTRACTOR, read through checkCommercialAuthority', async () => {
    expect(RESERVATION_ACTION).toBe('ENGAGE_CONTRACTOR');
    expect(await reservationAuthority(biz)).toEqual(await checkCommercialAuthority({ projectId: biz, action: 'ENGAGE_CONTRACTOR' }));
  });

  it('refuses with no grant, whatever authority the caller asserts, and writes nothing', async () => {
    // The old path: a caller naming the strings it "holds". Those fields no longer authorize anything.
    const asserted = { ...request(), authorityRequired: ['RESERVE_CAPACITY'], authorityHeld: ['RESERVE_CAPACITY', 'ENGAGE_CONTRACTOR'] };
    expect(await recordReservation(asserted, 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'] });
    // A forged decision smuggled in is ignored: the arbiter reads the grant itself.
    const forged: CommercialDecision = {
      ok: true, reason: 'forged', policyVersion: 1,
      authority: {
        id: 'cau_forged', projectId: biz, ownerUserId: 'usr_owner', name: 'forged', policyVersion: 1, allowedActions: ['ENGAGE_CONTRACTOR'], prohibitions: [],
        maxCommittedCents: 0, maxPerActionCents: 0, maxConcurrent: 1, currency: 'USD', startsAt: '2026-01-01T00:00:00Z', expiresAt: null, state: 'ACTIVE',
        revokedAt: null, revokedByUserId: null, revokedReason: null, createdByUserId: 'usr_owner', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    expect(await recordReservation({ ...request(), authority: forged } as Omit<ReservationRequest, 'authority'>, 'BRAIN'))
      .toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
    expect(await rows()).toBe(0);
  });

  it('refuses a grant that does not cover ENGAGE_CONTRACTOR, or prohibits it', async () => {
    await grantRow(biz, ['CONTACT_BUYER', 'SPEND_FROM_ALLOWANCE']);
    expect(await recordReservation(request(), 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'] });
    await grantRow(biz, ['ENGAGE_CONTRACTOR'], { prohibitions: ['ENGAGE_CONTRACTOR'] });
    expect(await recordReservation(request(), 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['ENGAGE_CONTRACTOR'] });
    expect(await rows()).toBe(0);
  });

  it('refuses a grant that belongs to another business', async () => {
    await grantRow(biz, ['ENGAGE_CONTRACTOR']);
    expect(await recordReservation(request({ businessId: 'biz-without-a-grant' }), 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
    expect(await rows()).toBe(0);
  });

  it('reserves under a live grant and files the grant beside the row', async () => {
    const grant = await grantRow(biz, ['ENGAGE_CONTRACTOR']);
    const answer = await recordReservation(request(), 'BRAIN');
    expect(answer).toMatchObject({ ok: true, duplicate: false });
    const [event] = await recordedReservationEvents(['crew-a']);
    expect(event).toMatchObject({ kind: 'RESERVED', authorityHeld: ['ENGAGE_CONTRACTOR'], authorityId: grant.id });
  });

  it('stops reserving the moment the owner revokes the grant', async () => {
    const grant = await grantRow(biz, ['ENGAGE_CONTRACTOR']);
    expect(await recordReservation(request(), 'BRAIN')).toMatchObject({ ok: true });
    expect(await revokeAuthority({ authorityId: grant.id, actorUserId: 'usr_owner', reason: 'stop' })).toBe(true);
    expect(await recordReservation(request({ key: 'k2', commitmentId: 'job-2' }), 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
    expect(await rows()).toBe(1);
  });

  it('judges the grant at the moment of the write, not at a time the caller names', async () => {
    // A grant that has already expired is not revived by a caller backdating its request into its window.
    await grantRow(biz, ['ENGAGE_CONTRACTOR'], { expiresAt: '2026-01-02T00:00:00Z' });
    expect(await recordReservation(request({ at: '2026-01-01T12:00:00Z' }), 'BRAIN')).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY' });
    expect(await rows()).toBe(0);
  });

  it('refuses a transfer after the grant is gone, leaving the failed primary in place', async () => {
    const grant = await grantRow(biz, ['ENGAGE_CONTRACTOR']);
    await recordReservation(request(), 'BRAIN');
    await recordHoldOutcome({ counterpartyId: 'crew-a', key: 'k1', kind: 'FAILED', at: '2026-11-20T00:00:00Z', actorRef: 'BRAIN' });
    await revokeAuthority({ authorityId: grant.id, actorUserId: 'usr_owner', reason: 'stop' });
    const plan = await recordTransfer({
      primaryKey: 'k1', primaryCounterpartyId: 'crew-a', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, at: '2026-11-20T01:00:00Z',
    }, 'BRAIN');
    expect(plan).toMatchObject({ action: 'REFUSED', reason: 'MISSING_AUTHORITY' });
    expect(await rows()).toBe(2); // RESERVED, FAILED — no release and no new hold
  });

  it('the arbiter refuses to write a RESERVED event its business\'s live grant does not cover, whatever decide proposed', async () => {
    const smuggled: ReservationEvent = {
      kind: 'RESERVED', key: 'k-smuggled', counterpartyId: 'crew-a', commitmentId: 'job-9', businessId: biz, units: 1, ...W,
      authorityHeld: ['ENGAGE_CONTRACTOR'], authorityId: 'cau_made_up', at: '2026-11-13T10:00:00Z',
    };
    await expect(decideRecorded(['crew-a'], 'BRAIN', () => ({ result: null, append: [smuggled] }), [biz])).rejects.toThrow(/refused to record RESERVED/);
    // Even with a live grant, an event that does not name it is refused.
    await grantRow(biz, ['ENGAGE_CONTRACTOR']);
    await expect(decideRecorded(['crew-a'], 'BRAIN', () => ({ result: null, append: [smuggled] }), [biz])).rejects.toThrow(/does not name the live commercial authority/);
    expect(await rows()).toBe(0);
  });

  it('a recorded transaction takes no authority from its caller', async () => {
    const v = (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: `source:${dimension}`, value });
    const facts = ['listing', 'willingness', 'availability', 'eligibility', 'scope', 'qualifications', 'geography'].map((d) => v(d))
      .concat([v('price', 900), v('paymentTerms', 'net 30'), v('leadTime', 5), v('availableCapacity', 4), v('reservedCapacity'), v('contract')]);
    const crew: Counterparty = { id: 'crew-a', kind: 'contractor', geography: 'region-a', facts };
    await recordCounterpartyFacts({ projectId: biz, counterparty: crew, facts, actorRef: 'BRAIN' });
    const input: RecordedTransactionInput = {
      commitment: { id: 'job-1', capacityUnits: 2, geographies: ['region-a'] }, candidateIds: ['crew-a'], businessId: biz, window: W, at: '2026-11-13T12:00:00Z',
    };
    const asserted = { ...input, authorityRequired: [], authorityHeld: ['ENGAGE_CONTRACTOR'] } as RecordedTransactionInput;
    expect((await reserveRecordedTransaction(asserted, 'BRAIN')).reserve).toMatchObject({ permitted: false, reason: 'MISSING_AUTHORITY' });
    expect(await rows()).toBe(0);
    await grantRow(biz, ['ENGAGE_CONTRACTOR']);
    expect((await reserveRecordedTransaction(input, 'BRAIN')).reserve).toMatchObject({ permitted: true, counterpartyId: 'crew-a' });
    expect(await rows()).toBe(1);
  });
});
