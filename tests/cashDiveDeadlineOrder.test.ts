/**
 * ORIGINATED:MISSED_OPPORTUNITY:DISCOVERED — 14 of 14 dated openings (federal
 * solicitations N0010426QAC01 'DUST PLUG', 140LL027Q0005 'Signage Project for
 * Garnet Hill Recreation Area') expired while still DISCOVERED. The dive order
 * never read `expiresAt`, so a dated opening waited behind older undated ones
 * until it entered the 72h runway, where it can no longer be dived.
 */
import { describe, expect, it } from 'vitest';
import type { CashOpportunity } from '../server/domain/types.ts';
import {
  CAPACITY_DEFERRAL_EVENT,
  capacityDeferralCandidates,
  compareDiveValue,
  deadlineAtDiscovery,
  diveOrder,
  recordCapacityDeferrals,
  type DiveValueFacts,
} from '../server/services/cash/validation.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { freshProject } from './helpers.ts';
import { DIVE_RUNWAY_MS, closesWithin } from '../server/services/cash/worthResearching.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();

interface Row {
  opportunity: CashOpportunity;
  value: DiveValueFacts;
}

function row(input: {
  id: string;
  createdAt: string;
  expiresAt?: string | null;
  mechanism?: string | null;
  crossesTier?: boolean;
}): Row {
  const opportunity = {
    id: input.id,
    title: input.id,
    expiresAt: input.expiresAt ?? null,
    mechanism: input.mechanism ?? null,
    discoveryRoundId: null,
  } as unknown as CashOpportunity;
  const value: DiveValueFacts = {
    id: input.id,
    createdAt: input.createdAt,
    reconsidered: false,
    crossesTier: input.crossesTier ?? true,
    mechanismYield: 'UNMEASURED',
    stage: 'SCREEN',
    capital: 'UNKNOWN',
    timeToCashDays: null,
    answered: 0,
  } as DiveValueFacts;
  return { opportunity, value };
}

const none = () => false;

/** The band order as it stood at 7819a27: `expiresAt` never consulted. */
function oldOrder(opts: { dropped?: (o: CashOpportunity) => boolean; forGoal?: (o: CashOpportunity) => boolean } = {}) {
  const dropped = opts.dropped ?? none;
  const forGoal = opts.forGoal ?? none;
  const band = (o: CashOpportunity) =>
    dropped(o) ? 3 : forGoal(o) ? 0 : o.mechanism === 'TEMPORARY_EXPLOIT' ? 1 : 2;
  return (a: CashOpportunity, b: CashOpportunity) => band(a) - band(b);
}

function select(rows: Row[], order: (a: CashOpportunity, b: CashOpportunity) => number, room: number): string[] {
  const sorted = [...rows].sort((a, b) => compareDiveValue(a.value, b.value));
  sorted.sort((a, b) => order(a.opportunity, b.opportunity));
  return sorted.slice(0, room).map((r) => r.opportunity.id);
}

describe('dive order reads a recorded closing date (EDF)', () => {
  it('reproduces the miss: a dated opening 10 days out is dived before older undated ones, before the runway', () => {
    const room = 3;
    const undated = Array.from({ length: room }, (_, i) =>
      row({ id: `ongoing-${i}`, createdAt: `2026-09-0${i + 1}T00:00:00.000Z`, crossesTier: true }),
    );
    // Lower decision value (no tier crossing) and newer than every undated one.
    const solicitation = row({
      id: 'N0010426QAC01',
      createdAt: '2026-10-19T00:00:00.000Z',
      expiresAt: at(10 * DAY),
      crossesTier: false,
    });
    expect(closesWithin(solicitation.opportunity.expiresAt, NOW)).toBe(false);
    const rows = [...undated, solicitation];

    expect(select(rows, oldOrder(), room)).not.toContain('N0010426QAC01');
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select(rows, order, room)).toContain('N0010426QAC01');
  });

  it('orders dated openings in one band by earliest closing, regardless of decision value', () => {
    const later = row({ id: 'later', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: at(20 * DAY), crossesTier: true });
    const sooner = row({ id: 'sooner', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-28', crossesTier: false });
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select([later, sooner], order, 2)).toEqual(['sooner', 'later']);
  });

  it('keeps undated openings in decision-value order, goal openings first and dropped ones last', () => {
    const a = row({ id: 'a', createdAt: '2026-09-01T00:00:00.000Z', crossesTier: true });
    const b = row({ id: 'b', createdAt: '2026-08-01T00:00:00.000Z', crossesTier: false });
    const goal = row({ id: 'goal', createdAt: '2026-10-10T00:00:00.000Z', crossesTier: false });
    const junk = row({ id: 'junk', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: at(5 * DAY), crossesTier: true });
    const dated = row({ id: 'dated', createdAt: '2026-10-10T00:00:00.000Z', expiresAt: at(8 * DAY), crossesTier: false });
    const order = diveOrder({
      now: NOW,
      dropped: (o) => o.id === 'junk',
      forGoal: (o) => o.id === 'goal',
      shortWindow: none,
    });
    expect(select([a, b, goal, junk, dated], order, 5)).toEqual(['goal', 'dated', 'a', 'b', 'junk']);
  });

  it('does not promote an opening already inside the runway, and leaves the runway unchanged', () => {
    expect(DIVE_RUNWAY_MS).toBe(72 * 60 * 60 * 1000);
    const inside = row({ id: 'inside', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: at(DAY), crossesTier: false });
    const undated = row({ id: 'undated', createdAt: '2026-10-02T00:00:00.000Z', crossesTier: true });
    const order = diveOrder({ now: NOW, dropped: none, forGoal: none, shortWindow: none });
    expect(select([inside, undated], order, 2)).toEqual(['undated', 'inside']);
  });
});

/**
 * Review of the EDF change (2026-11-12): the diagnosis "they waited behind
 * undated openings for a slot" was asserted without rows. N0010426QAC01 was
 * posted 2026-10-19 and changed on 2026-10-22, inside the 72h runway from the
 * day it was filed: no order could have saved it. These pin the two facts the
 * diagnosis needs — which misses an order could have prevented at all, and a
 * row showing a slot was actually contended while one of those waited.
 */
describe('a deadline miss is attributed to capacity only when a row shows it', () => {
  const opening = (id: string, createdAt: string, expiresAt: string | null) =>
    ({ id, title: id, createdAt, expiresAt, mechanism: null, discoveryRoundId: null }) as unknown as CashOpportunity;

  it('calls an opening filed inside its own runway unsaveable by any order', () => {
    // Filed 2026-10-19, closing 2026-10-22 (end of day): under 72h of slack once the runway is subtracted.
    const navy = opening('N0010426QAC01', '2026-10-19T18:00:00.000Z', '2026-10-21');
    expect(deadlineAtDiscovery(navy).kind).toBe('INSIDE_RUNWAY_AT_DISCOVERY');
    // It never gets an EDF key, so no order could have moved it ahead.
    expect(capacityDeferralCandidates([navy], new Set(), navy.createdAt)).toEqual([]);
  });

  it('calls an opening filed with time to spare orderable, with its slack', () => {
    const blm = opening('140LL027Q0005', '2026-10-15T00:00:00.000Z', '2026-10-30');
    const reading = deadlineAtDiscovery(blm);
    expect(reading.kind).toBe('ORDERABLE');
    if (reading.kind !== 'ORDERABLE') throw new Error('unreachable');
    expect(reading.slackMs).toBe(Date.parse('2026-10-30T23:59:59.999Z') - DIVE_RUNWAY_MS - Date.parse(blm.createdAt));
    expect(deadlineAtDiscovery(opening('undated', blm.createdAt, null)).kind).toBe('UNDATED');
  });

  it('picks only dated, saveable, unstarted openings as deferred, earliest deadline first', () => {
    const now = '2026-10-16T00:00:00.000Z';
    const rows = [
      opening('later', '2026-10-01T00:00:00.000Z', '2026-11-20'),
      opening('undated', '2026-10-01T00:00:00.000Z', null),
      opening('inside', '2026-10-01T00:00:00.000Z', '2026-10-17'),
      opening('started', '2026-10-01T00:00:00.000Z', '2026-10-25'),
      opening('sooner', '2026-10-01T00:00:00.000Z', '2026-10-30'),
    ];
    expect(capacityDeferralCandidates(rows, new Set(['started']), now).map((one) => one.id)).toEqual(['sooner', 'later']);
    expect(capacityDeferralCandidates(rows, new Set(), now, 1).map((one) => one.id)).toEqual(['started']);
  });

  it('records one deferral row per opening, lane and close, and a changed close is a new row', async () => {
    const { project } = await freshProject();
    const now = '2026-10-16T00:00:00.000Z';
    const blm = opening('cop_blm_test', '2026-10-15T00:00:00.000Z', '2026-10-30');
    const capacity = { room: 0, limitedBy: 'OPERATOR' };
    expect(await recordCapacityDeferrals({ projectId: project.id, lane: 'DIVE', waiting: [blm], now, capacity })).toBe(1);
    expect(await recordCapacityDeferrals({ projectId: project.id, lane: 'DIVE', waiting: [blm], now, capacity })).toBe(0);
    expect(
      await recordCapacityDeferrals({ projectId: project.id, lane: 'ENGINE_QUESTION', waiting: [blm], now, capacity: {} }),
    ).toBe(1);
    const amended = { ...blm, expiresAt: '2026-11-06' } as CashOpportunity;
    expect(await recordCapacityDeferrals({ projectId: project.id, lane: 'DIVE', waiting: [amended], now, capacity })).toBe(1);

    const rows = await cashEventsOfKind(blm.id, CAPACITY_DEFERRAL_EVENT);
    expect(rows).toHaveLength(3);
    const dive = rows.find((one) => (one.detail as { lane?: string; expiresAt?: string }).expiresAt === '2026-10-30' && (one.detail as { lane?: string }).lane === 'DIVE');
    expect(dive?.detail).toMatchObject({
      lane: 'DIVE',
      expiresAt: '2026-10-30',
      atDiscovery: 'ORDERABLE',
      room: 0,
      limitedBy: 'OPERATOR',
      latestStart: new Date(Date.parse('2026-10-30T23:59:59.999Z') - DIVE_RUNWAY_MS).toISOString(),
    });
  });
});
