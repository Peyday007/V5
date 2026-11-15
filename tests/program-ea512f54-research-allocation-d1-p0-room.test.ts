/**
 * RES-15-4 (A01): while the intermediation family declaration is current, the
 * research room is offered to intermediation work first — inside exactly the
 * room today's arithmetic computes — and a lapsed declaration changes nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOperatorMax,
  offerToFamily,
  researchRoomFrom,
  type ResearchCapacity,
} from '../server/services/cash/researchRoom.ts';
import { INTERMEDIATION_FAMILY, renewFamily } from '../server/services/cash/intermediationPositions.ts';

const capacity = (over: Partial<ResearchCapacity> = {}): ResearchCapacity => ({
  grantMax: 6,
  grantLive: 0,
  surfaces: 8,
  shedding: false,
  sheddingReason: null,
  ...over,
});

const CURRENT = '2026-12-01T00:00:00.000Z';
const LAPSED = '2027-03-01T00:00:00.000Z';
const KEY = INTERMEDIATION_FAMILY.key;

describe('research room offered to a current priority family first', () => {
  const readings: Array<[string, Partial<ResearchCapacity>, number, number]> = [
    ['plenty', {}, 0, 0],
    ['grant-bound', { grantLive: 4 }, 1, 0],
    ['surface-bound', { surfaces: 2 }, 1, 0],
    ['last slot', { grantLive: 5 }, 0, 0],
    ['unknown surfaces', { surfaces: null }, 0, 0],
    ['unlaunched', { surfaces: 3 }, 2, 2],
  ];

  it('intermediation work is offered the whole room, and never more than today', () => {
    for (const [, over, inFlight, unlaunched] of readings) {
      const today = researchRoomFrom({ capacity: capacity(over), inFlight, unlaunched });
      const given = researchRoomFrom({
        capacity: capacity(over),
        inFlight,
        unlaunched,
        family: { kind: KEY, familyWaiting: 5, now: CURRENT },
      });
      expect(given.room).toBe(today.room);
      expect(given.cap).toBe(today.cap);
      if (today.room > 0) {
        expect(given.family).toMatchObject({ key: KEY, given: 'FAMILY_FIRST', heldForFamily: 0 });
        expect(given.reason).toContain(KEY);
        expect(given.reason).toContain(INTERMEDIATION_FAMILY.why);
      }
    }
  });

  it('other optional research is offered only what waiting intermediation work leaves', () => {
    const today = researchRoomFrom({ capacity: capacity(), inFlight: 0, unlaunched: 0 });
    expect(today.room).toBe(5);
    const other = researchRoomFrom({
      capacity: capacity(),
      inFlight: 0,
      unlaunched: 0,
      family: { kind: 'DEEP_DIVE', familyWaiting: 3, now: CURRENT },
    });
    expect(other.room).toBe(2);
    expect(other.family).toMatchObject({ key: KEY, given: 'AFTER_FAMILY', heldForFamily: 3 });
    expect(other.reason).toMatch(/3 held for 3 waiting COMMERCIAL_INTERMEDIATION/);

    const swamped = researchRoomFrom({
      capacity: capacity(),
      inFlight: 0,
      unlaunched: 0,
      family: { kind: null, familyWaiting: 50, now: CURRENT },
    });
    expect(swamped.room).toBe(0);
    expect(swamped.family?.heldForFamily).toBe(5);

    const nothingWaiting = researchRoomFrom({
      capacity: capacity(),
      inFlight: 0,
      unlaunched: 0,
      family: { kind: 'DEEP_DIVE', familyWaiting: 0, now: CURRENT },
    });
    expect(nothingWaiting.room).toBe(5);
    expect(nothingWaiting.family?.heldForFamily).toBe(0);
  });

  it('family plus other never exceeds the room today computes', () => {
    for (const [, over, inFlight, unlaunched] of readings) {
      for (const waiting of [0, 1, 2, 7]) {
        const today = researchRoomFrom({ capacity: capacity(over), inFlight, unlaunched });
        const fam = researchRoomFrom({ capacity: capacity(over), inFlight, unlaunched, family: { kind: KEY, familyWaiting: waiting, now: CURRENT } });
        const other = researchRoomFrom({ capacity: capacity(over), inFlight, unlaunched, family: { kind: 'OTHER', familyWaiting: waiting, now: CURRENT } });
        const familyTakes = Math.min(fam.room, waiting);
        expect(familyTakes + other.room).toBeLessThanOrEqual(today.room);
        expect(other.room).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a lapsed declaration leaves researchRoomFrom exactly as today', () => {
    for (const [, over, inFlight, unlaunched] of readings) {
      const today = researchRoomFrom({ capacity: capacity(over), inFlight, unlaunched });
      for (const kind of [KEY, 'OTHER', null]) {
        const lapsed = researchRoomFrom({
          capacity: capacity(over),
          inFlight,
          unlaunched,
          family: { kind, familyWaiting: 4, now: LAPSED },
        });
        expect(lapsed).toStrictEqual(today);
      }
    }
    // Before it took effect is not current either.
    const early = researchRoomFrom({ capacity: capacity(), inFlight: 0, unlaunched: 0, family: { kind: 'OTHER', familyWaiting: 4, now: '2026-01-01' } });
    expect(early).toStrictEqual(researchRoomFrom({ capacity: capacity(), inFlight: 0, unlaunched: 0 }));
    // Renewal makes it current again: the family is not forever, nor gone forever.
    const renewed = researchRoomFrom({
      capacity: capacity(),
      inFlight: 0,
      unlaunched: 0,
      family: { kind: 'OTHER', familyWaiting: 4, now: LAPSED, declaration: renewFamily(INTERMEDIATION_FAMILY, '2027-06-01') },
    });
    expect(renewed.room).toBe(1);
  });

  it('SHEDDING, no grant and a full grant still start nothing', () => {
    for (const over of [{ shedding: true, sheddingReason: 'pool saturated' }, { grantMax: null }, { grantLive: 6 }]) {
      const today = researchRoomFrom({ capacity: capacity(over), inFlight: 0, unlaunched: 0 });
      const fam = researchRoomFrom({ capacity: capacity(over), inFlight: 0, unlaunched: 0, family: { kind: KEY, familyWaiting: 9, now: CURRENT } });
      expect(fam.room).toBe(0);
      expect(fam).toStrictEqual(today);
    }
    expect(researchRoomFrom({ capacity: capacity({ shedding: true }), inFlight: 0, unlaunched: 0, family: { kind: KEY, now: CURRENT } }).limitedBy).toBe('SHEDDING');
  });

  it('an operator ceiling still binds the family, and keeps the family reading', () => {
    const fam = researchRoomFrom({ capacity: capacity(), inFlight: 0, unlaunched: 0, family: { kind: KEY, familyWaiting: 5, now: CURRENT } });
    const capped = applyOperatorMax(fam, 1, 0);
    expect(capped.room).toBe(1);
    expect(capped.limitedBy).toBe('OPERATOR');
    expect(capped.family?.key).toBe(KEY);
  });

  it('offerToFamily on an empty room returns it untouched', () => {
    const none = researchRoomFrom({ capacity: capacity({ grantLive: 6 }), inFlight: 0, unlaunched: 0 });
    expect(offerToFamily(none, { kind: KEY, familyWaiting: 3, now: CURRENT })).toBe(none);
  });
});
