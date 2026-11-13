import { describe, expect, it } from 'vitest';
import {
  doubleCommitted, holdsFrom, planTransfer, remainingCapacity, reserve,
  type ReservationEvent, type ReservationRequest,
} from '../server/services/labor/counterparties/reservations.ts';

const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
const req = (over: Partial<ReservationRequest> = {}): ReservationRequest => ({
  key: 'k1', counterpartyId: 'crew-a', commitmentId: 'job-1', businessId: 'biz-1', units: 3, ...W,
  capacityUnits: 4, authorityRequired: ['commit-spend'], authorityHeld: ['commit-spend'], at: '2026-11-13T10:00:00Z', ...over,
});
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

  it('refuses without the required authority and names it', () => {
    expect(reserve([], req({ authorityHeld: [] }))).toEqual({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['commit-spend'] });
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
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, authorityRequired: ['commit-spend'], authorityHeld: ['commit-spend'], at: '2026-11-20T01:00:00Z' });
    expect(plan.action).toBe('TRANSFER');
    const after = [...events, ...(plan as { events: ReservationEvent[] }).events];
    expect(holdsFrom(after).find((h) => h.key === 'k1')?.state).toBe('RELEASED');
    expect(holdsFrom(after).find((h) => h.key === 'k1-alt')?.state).toBe('HELD');
    expect(doubleCommitted(after)).toEqual([]);
    expect(remainingCapacity(after, 'crew-a', 4, W).remaining).toBe(4);
  });

  it('reports an unknown outcome as unknown and neither transfers nor releases', () => {
    const events = take([], req());
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 5, authorityRequired: [], authorityHeld: [], at: '2026-11-20T01:00:00Z' });
    expect(plan.action).toBe('UNKNOWN');
    expect(remainingCapacity(events, 'crew-a', 4, W).remaining).toBe(1);
  });

  it('refuses a transfer the alternative has no room for, leaving the primary held', () => {
    let events = take([], req());
    events = outcome(events, 'k1', 'FAILED', '2026-11-20T00:00:00Z');
    const plan = planTransfer(events, { primaryKey: 'k1', alternativeKey: 'k1-alt', alternativeCounterpartyId: 'crew-b', alternativeCapacityUnits: 2, authorityRequired: [], authorityHeld: [], at: '2026-11-20T01:00:00Z' });
    expect(plan).toMatchObject({ action: 'REFUSED', reason: 'CAPACITY' });
  });
});
