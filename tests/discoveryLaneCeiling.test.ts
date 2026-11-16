import { describe, expect, it } from 'vitest';
import { LANE_LIFT_MAX, laneAdaptiveCeiling } from '../server/services/cash/discoveryAuthority.ts';

const lane = (spare: number, waiting: number, pressure: { db: boolean; cpu: number } | null = { db: false, cpu: 0.5 }) => ({ spare, waiting, pressure });

describe('a discovery grant follows the free lane headroom (§78, §86)', () => {
  it('grows a full grant while the lane has spare and nothing queued', () => {
    expect(laneAdaptiveCeiling({ floor: 6, current: 6, live: 6, lane: lane(3, 0) }).target).toBe(9);
    expect(laneAdaptiveCeiling({ floor: 6, current: 6, live: 6, lane: lane(8, 0) }).target).toBe(10);
  });
  it('does not grow a grant with free slots', () => {
    expect(laneAdaptiveCeiling({ floor: 6, current: 10, live: 4, lane: lane(8, 0) }).target).toBe(10);
  });
  it('shrinks toward the floor when the queue backs up or the database is saturated', () => {
    expect(laneAdaptiveCeiling({ floor: 6, current: 14, live: 14, lane: lane(0, 12) }).target).toBe(12);
    expect(laneAdaptiveCeiling({ floor: 6, current: 7, live: 7, lane: lane(5, 0, { db: true, cpu: 0.2 }) }).target).toBe(6);
    expect(laneAdaptiveCeiling({ floor: 6, current: 10, live: 10, lane: lane(2, 3, { db: false, cpu: 0.99 }) }).target).toBe(9);
  });
  it('never drops below the floor nor rises past the lift bound', () => {
    expect(laneAdaptiveCeiling({ floor: 6, current: 6, live: 6, lane: lane(0, 50) }).target).toBe(6);
    const top = 6 + LANE_LIFT_MAX;
    expect(laneAdaptiveCeiling({ floor: 6, current: top, live: top, lane: lane(8, 0) }).target).toBe(top);
  });
  it('returns to the floor when the lane cannot be read', () => {
    expect(laneAdaptiveCeiling({ floor: 6, current: 20, live: 20, lane: null }).target).toBe(6);
  });
});
