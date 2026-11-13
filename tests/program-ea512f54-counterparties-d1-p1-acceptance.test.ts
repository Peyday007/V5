import { describe, expect, it } from 'vitest';
import type { Counterparty, Fact } from '../server/services/labor/counterparties/ladder.ts';
import type { ReservationEvent } from '../server/services/labor/counterparties/reservations.ts';
import { readTransaction, reservationKey, type TransactionInput } from '../server/services/labor/counterparties/transaction.ts';
import { providerCounterparty } from '../server/services/cash/providers/counterparty.ts';
import { readLadder } from '../server/services/labor/counterparties/ladder.ts';

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

const input = (candidates: Counterparty[], events: ReservationEvent[] = [], over: Partial<TransactionInput> = {}): TransactionInput => ({
  commitment, candidates, events, businessId: 'biz-1', window: W,
  authorityRequired: ['RESERVE_CAPACITY'], authorityHeld: ['RESERVE_CAPACITY'], at: '2026-11-13T12:00:00Z',
  source: 'sourced buyer request', ...over,
});
const outcome = (e: ReservationEvent, kind: 'FAILED' | 'PERFORMED', at: string): ReservationEvent => ({ ...e, kind, at });

describe('CP-31 acceptance: a sourced contractor-delivered transaction', () => {
  it('names a primary and an alternative, verified versus pending facts, and compares cost, capacity and timing', () => {
    const a = party('crew-a', quoted(900, 5, 4));
    const b = party('crew-b', [...quoted(800, 9, 3).filter((f) => f.dimension !== 'price'), p('price', 700)], 'region-b');
    const c = party('crew-c', LISTED);
    const reading = readTransaction(input([c, b, a]));
    expect(reading.source).toBe('sourced buyer request');
    expect(reading.primary?.counterpartyId).toBe('crew-a');
    expect(reading.alternative?.counterpartyId).toBe('crew-b');
    const bFacts = reading.facts.find((f) => f.counterpartyId === 'crew-b')!;
    expect(bFacts.verified).not.toContain('price');
    expect(bFacts.pending).toContainEqual({ dimension: 'price', state: 'PENDING' });
    const bRow = reading.compared.find((r) => r.counterpartyId === 'crew-b')!;
    expect(bRow.figures.cost).toEqual({ value: null, claimed: 700, status: 'PENDING' }); // a pending price is not cheaper
    const aRow = reading.compared.find((r) => r.counterpartyId === 'crew-a')!;
    expect(aRow.figures).toMatchObject({ cost: { value: 900 }, capacity: { value: 4 }, timing: { value: 5 } });
  });

  it('reports a sale not deliverable while its best fulfiller is only listed, willing, capable or quoted', () => {
    for (const facts of [LISTED, WILLING, CAPABLE, quoted(900, 5, 4)]) {
      const reading = readTransaction(input([party('crew-a', facts)]));
      expect(reading.deliverability.deliverable).toBe(false);
    }
    // Even a reservation is not a contract.
    const r1 = readTransaction(input([party('crew-a', quoted(900, 5, 4))]));
    expect(r1.reserve.permitted).toBe(true);
    const held = r1.reserve.permitted ? r1.reserve.event! : null;
    const r2 = readTransaction(input([party('crew-a', quoted(900, 5, 4))], [held!]));
    expect(r2.deliverability).toMatchObject({ deliverable: false, counterpartyId: 'crew-a', holdState: 'HELD' });
  });

  it('does not reserve without the required authority, and names the authority that is missing', () => {
    const reading = readTransaction(input([party('crew-a', quoted(900, 5, 4))], [], { authorityHeld: [] }));
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'MISSING_AUTHORITY', missingAuthority: ['RESERVE_CAPACITY'] });
  });

  it('does not reserve a fulfiller that has not quoted', () => {
    const reading = readTransaction(input([party('crew-a', CAPABLE)]));
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'NOT_QUOTED' });
  });

  it('walks the whole demonstration: reserve, contract, primary failure, one transfer, no double-commit, honest deliverability', () => {
    const a = party('crew-a', contracted(900, 5, 4));
    const b = party('crew-b', contracted(950, 6, 3), 'region-b');
    const first = readTransaction(input([a, b]));
    expect(first.primary?.counterpartyId).toBe('crew-a');
    if (!first.reserve.permitted || !first.reserve.event) throw new Error('expected a reserve');
    const held = first.reserve.event;
    expect(held.key).toBe(reservationKey('job-1', 'crew-a'));

    let events: ReservationEvent[] = [held];
    const live = readTransaction(input([a, b], events));
    expect(live.deliverability).toMatchObject({ deliverable: true, counterpartyId: 'crew-a' });
    expect(live.transfer.applicable).toBe(false); // no report, no transfer
    expect(live.reserve).toMatchObject({ permitted: true, duplicate: true }); // the same key counts once

    // The primary reports a failure: the sale is no longer deliverable on it, and a transfer is planned.
    events = [...events, outcome(held, 'FAILED', '2026-11-14T00:00:00Z')];
    const failed = readTransaction(input([a, b], events, { at: '2026-11-14T01:00:00Z' }));
    expect(failed.deliverability.deliverable).toBe(false);
    expect(failed.transfer).toMatchObject({ applicable: true, from: 'crew-a', to: 'crew-b' });
    if (failed.transfer.plan?.action !== 'TRANSFER') throw new Error('expected a transfer');
    expect(failed.transfer.plan.events.map((e) => [e.kind, e.counterpartyId])).toEqual([['RELEASED', 'crew-a'], ['RESERVED', 'crew-b']]);

    events = [...events, ...failed.transfer.plan.events];
    const after = readTransaction(input([a, b], events, { at: '2026-11-14T02:00:00Z' }));
    expect(after.doubleCommitted).toEqual([]);
    expect(after.deliverability).toMatchObject({ deliverable: true, counterpartyId: 'crew-b' });
    // Planning again transfers nothing a second time: the primary is released, not failed.
    expect(after.transfer.applicable).toBe(false);
    // And nothing reserves crew-a again while crew-b carries the job.
    const again = readTransaction(input([party('crew-a', contracted(100, 1, 9)), b], events));
    expect(again.reserve).toMatchObject({ permitted: false, reason: 'ALREADY_HELD' });
  });

  it('refuses a transfer the authority held does not cover', () => {
    const a = party('crew-a', contracted(900, 5, 4));
    const b = party('crew-b', contracted(950, 6, 3));
    const held = readTransaction(input([a, b]));
    if (!held.reserve.permitted || !held.reserve.event) throw new Error('expected a reserve');
    const events = [held.reserve.event, outcome(held.reserve.event, 'FAILED', '2026-11-14T00:00:00Z')];
    const reading = readTransaction(input([a, b], events, { authorityHeld: [] }));
    expect(reading.transfer.plan).toMatchObject({ action: 'REFUSED', reason: 'MISSING_AUTHORITY' });
  });

  it('never books capacity another business already holds', () => {
    const a = party('crew-a', contracted(900, 5, 2));
    const other: ReservationEvent = {
      kind: 'RESERVED', key: 'job-9:crew-a', counterpartyId: 'crew-a', commitmentId: 'job-9', businessId: 'biz-2',
      units: 1, ...W, authorityHeld: ['RESERVE_CAPACITY'], at: '2026-11-12T00:00:00Z',
    };
    const reading = readTransaction(input([a], [other]));
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'CAPACITY' });
  });
});

describe('a configured software-service provider is a counterparty', () => {
  it('reads its facts from the existing provider status line', () => {
    const cp = providerCounterparty({
      area: 'MESSAGING', capability: 'SEND_A_MESSAGE', state: 'CONNECTED', provider: 'instantly', mode: null, detail: '', nextAction: '',
    })!;
    expect(cp).toMatchObject({ id: 'provider:messaging:instantly', kind: 'software service', humanOperator: false });
    const ladder = readLadder(cp);
    expect(ladder.stage).toBe('WILLINGNESS'); // listed and willing; qualifications, a quote and a contract are not asserted
    expect(cp.facts.find((f) => f.dimension === 'willingness')?.evidence).toMatch(/commercialProviderStatus/);
  });

  it('is pending when configured but not registered, and absent when no provider is chosen', () => {
    const pending = providerCounterparty({ area: 'INVOICES', capability: 'ISSUE_AN_INVOICE', state: 'MISSING', provider: 'stripe', mode: 'TEST', detail: '', nextAction: '' })!;
    expect(readLadder(pending).stage).toBe('LISTING');
    expect(pending.facts.find((f) => f.dimension === 'mode')?.value).toBe('TEST');
    expect(providerCounterparty({ area: 'PAYMENTS', capability: 'TAKE_A_PAYMENT', state: 'MISSING', provider: null, mode: null, detail: '', nextAction: '' })).toBeNull();
  });
});
