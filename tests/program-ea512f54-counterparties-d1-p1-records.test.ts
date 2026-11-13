/** CP-31: counterparty facts and reservations on recorded rows, with one arbiter. */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { readLadder, recordCounterpartyFacts, recordedCounterparty, type Counterparty, type Fact } from '../server/services/labor/counterparties/ladder.ts';
import { recordHoldOutcome, type ReservationEvent } from '../server/services/labor/counterparties/reservations.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import {
  readRecordedTransaction, reservationKey, reserveRecordedTransaction, transferRecordedTransaction, type TransactionInput,
} from '../server/services/labor/counterparties/transaction.ts';

const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
const v = (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: `source:${dimension}`, value });
const p = (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'PENDING', evidence: null, value });

const LISTED = [v('listing')];
const WILLING = [...LISTED, v('willingness'), v('availability')];
const CAPABLE = [...WILLING, v('eligibility'), v('scope'), v('qualifications'), v('geography')];
const quoted = (price: number, lead: number, capacity: number) => [...CAPABLE, v('price', price), v('paymentTerms', 'net 30'), v('leadTime', lead), v('availableCapacity', capacity)];
const contracted = (price: number, lead: number, capacity: number) => [...quoted(price, lead, capacity), v('reservedCapacity'), v('contract')];

const party = (id: string, facts: Fact[], geography = 'region-a'): Counterparty => ({ id, kind: 'contractor', geography, facts });
const commitment = { id: 'job-1', capacityUnits: 2, geographies: ['region-a', 'region-b'] };

/** A real commercial grant on a project, written through the owner's own repository. */
async function grant(projectId: string, allowedActions: readonly string[] = [...COMMERCIAL_ACTIONS]): Promise<string> {
  const userId = (await createUser({ email: `cp31-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  return (await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...allowedActions], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
  })).id;
}

const input = (candidates: Counterparty[], events: ReservationEvent[] = [], over: Partial<TransactionInput> = {}): TransactionInput => ({
  commitment, candidates, events, businessId: 'biz-1', window: W,
  authority: { businessId: 'biz-1', action: 'ENGAGE_CONTRACTOR', held: true, reason: 'within', authorityId: null, policyVersion: 1 },
  at: '2026-11-13T12:00:00Z',
  source: 'sourced buyer request', ...over,
});

describe('CP-31 acceptance on recorded rows', () => {
  let biz = '';
  beforeEach(async () => {
    biz = (await freshProject()).project.id;
  });

  const record = (c: Counterparty) => recordCounterpartyFacts({ projectId: biz, counterparty: c, facts: c.facts, actorRef: 'BRAIN' });
  const recorded = (over: Partial<TransactionInput> = {}) => {
    const { candidates: _c, events: _e, authority: _a, ...rest } = input([], [], { businessId: biz, ...over });
    return { ...rest, candidateIds: ['crew-a', 'crew-b'] };
  };

  it('stores facts as rows and reads the same counterparty back, a correction beside the original', async () => {
    const a = party('crew-a', quoted(900, 5, 4));
    expect(await record(a)).toBe(a.facts.length);
    const back = await recordedCounterparty('crew-a');
    expect(back).toMatchObject({ id: 'crew-a', kind: 'contractor', geography: 'region-a' });
    expect(readLadder(back!).stage).toBe('QUOTE');
    // A withdrawn price lowers the stage without editing the earlier row.
    await recordCounterpartyFacts({ projectId: biz, counterparty: a, facts: [p('price', 900)], actorRef: 'BRAIN' });
    expect(readLadder((await recordedCounterparty('crew-a'))!).stage).toBe('CAPABILITY');
    const rows = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM cash_events WHERE kind = 'COUNTERPARTY_FACT'", []);
    expect(Number(rows[0]!.n)).toBe(a.facts.length + 1);
    expect(await recordedCounterparty('nobody')).toBeNull();
  });

  it('walks the demonstration on rows: reserve, failure, one transfer, no double-commit, honest deliverability', async () => {
    await record(party('crew-a', contracted(900, 5, 4)));
    await record(party('crew-b', contracted(950, 6, 3), 'region-b'));

    const before = await readRecordedTransaction(recorded());
    expect(before.primary?.counterpartyId).toBe('crew-a');
    expect(before.alternative?.counterpartyId).toBe('crew-b');
    expect(before.deliverability.deliverable).toBe(false);

    // Without the business's live grant nothing is written, whatever the caller passes.
    const asserted = { ...recorded(), authorityRequired: ['ENGAGE_CONTRACTOR'], authorityHeld: ['ENGAGE_CONTRACTOR'] } as ReturnType<typeof recorded>;
    const refused = await reserveRecordedTransaction(asserted, 'BRAIN');
    expect(refused.reserve).toMatchObject({ permitted: false, reason: 'MISSING_AUTHORITY', missingAuthority: ['ENGAGE_CONTRACTOR'] });
    expect(refused.authority).toMatchObject({ businessId: biz, held: false });
    expect((await readRecordedTransaction(recorded())).deliverability.holdState).toBeNull();
    // A grant that covers other actions is not one that commits contractor capacity.
    await grant(biz, ['CONTACT_BUYER']);
    expect((await reserveRecordedTransaction(recorded(), 'BRAIN')).reserve).toMatchObject({ permitted: false, reason: 'MISSING_AUTHORITY' });
    expect((await readRecordedTransaction(recorded())).deliverability.holdState).toBeNull();

    // The newest live grant covers it: now the reserve is taken, under that grant.
    const authorityId = await grant(biz);
    const reserved = await reserveRecordedTransaction(recorded(), 'BRAIN');
    expect(reserved.reserve.permitted && reserved.reserve.event).toMatchObject({ authorityHeld: ['ENGAGE_CONTRACTOR'], authorityId });
    expect(reserved.reserve).toMatchObject({ permitted: true, duplicate: false, counterpartyId: 'crew-a' });
    const live = await readRecordedTransaction(recorded());
    expect(live.deliverability).toMatchObject({ deliverable: true, counterpartyId: 'crew-a', holdState: 'HELD' });
    // Repeating the reserve writes no second row.
    expect((await reserveRecordedTransaction(recorded(), 'BRAIN')).reserve).toMatchObject({ permitted: true, duplicate: true });

    // No report: transferring is a no-op.
    expect((await transferRecordedTransaction(recorded(), 'BRAIN')).transfer.applicable).toBe(false);

    await recordHoldOutcome({ counterpartyId: 'crew-a', key: reservationKey('job-1', 'crew-a'), kind: 'FAILED', at: '2026-11-14T00:00:00Z', actorRef: 'BRAIN' });
    const failed = await readRecordedTransaction(recorded({ at: '2026-11-14T01:00:00Z' }));
    expect(failed.deliverability.deliverable).toBe(false); // a failed fulfiller is not reported as deliverable

    const moved = await transferRecordedTransaction(recorded({ at: '2026-11-14T01:00:00Z' }), 'BRAIN');
    expect(moved.transfer).toMatchObject({ applicable: true, from: 'crew-a', to: 'crew-b' });
    const after = await readRecordedTransaction(recorded({ at: '2026-11-14T02:00:00Z' }));
    expect(after.doubleCommitted).toEqual([]);
    expect(after.deliverability).toMatchObject({ deliverable: true, counterpartyId: 'crew-b' });
    // A second transfer and a second reserve both write nothing.
    await transferRecordedTransaction(recorded({ at: '2026-11-14T03:00:00Z' }), 'BRAIN');
    expect((await reserveRecordedTransaction(recorded(), 'BRAIN')).reserve).toMatchObject({ permitted: false, reason: 'ALREADY_HELD' });
    const rows = await getDb().all<{ n: number }>("SELECT COUNT(*) AS n FROM cash_events WHERE kind = 'COUNTERPARTY_RESERVATION'", []);
    expect(Number(rows[0]!.n)).toBe(4); // RESERVED a, FAILED a, RELEASED a, RESERVED b
  });
});
