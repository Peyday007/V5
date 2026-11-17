/**
 * A discovery grant feeds a GPU surge (§78, §86, §98).
 *
 * Production, 2026-11-17 08:28Z: an H200 serving gpt-oss-120b (up to 128
 * sequences) ran two jobs, the free lane read "no research waiting", and 568
 * ideas waited beside a discovery grant of 16. Two readings held the grant:
 * the lane's room counted the GPU as its decayed target (3 slots, 3 busy, no
 * spare), and "the grant is full" was an instant (13 of 16 held between
 * launch ticks) rather than the demand it stands for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { LANE_GROW_STEP_MAX, LANE_LIFT_MAX, laneAdaptiveCeiling } from '../server/services/cash/discoveryAuthority.ts';
import { freeLaneProvenSlots, freeLaneSpareSurfaces, provenSlots, SAFETY_CEILING } from '../server/services/freeLane/capacity.ts';
import { launchableInProject } from '../server/services/russell/loop.ts';

/*
 * The subject here is the GPU's served room, not the database pool's share of
 * it — `provenSlots` above pins the share. A test Postgres keeps a small pool,
 * which would make the share bind where production's does not, so the pool is
 * read as unknown on both backends.
 */
vi.mock('../server/db/database.ts', async (original) => ({
  ...(await original<typeof import('../server/db/database.ts')>()),
  databasePoolReadings: () => null,
}));

const lane = (spare: number, waiting: number, slots?: number, pressure: { db: boolean; cpu: number } | null = { db: false, cpu: 0.5 }) => ({
  spare,
  waiting,
  pressure,
  ...(slots === undefined ? {} : { slots }),
});

describe('the grant grows on demand, not on an instant', () => {
  it('grows while ideas wait beyond its free slots and it is within a step of full (13 of 16, 568 waiting)', () => {
    const next = laneAdaptiveCeiling({ floor: 12, current: 16, live: 13, lane: lane(8, 0), waitingIdeas: 568 });
    expect(next.target).toBe(16 + LANE_GROW_STEP_MAX);
    expect(next.why).toContain('568 launchable idea(s)');
  });
  it('does not grow when its free slots cover the waiting ideas', () => {
    expect(laneAdaptiveCeiling({ floor: 12, current: 16, live: 13, lane: lane(8, 0), waitingIdeas: 3 }).target).toBe(16);
  });
  it('does not grow a grant far below full: its launches are failing for another reason', () => {
    expect(laneAdaptiveCeiling({ floor: 6, current: 20, live: 4, lane: lane(8, 0), waitingIdeas: 500 }).target).toBe(20);
  });
  it('still shrinks under database or CPU pressure with ideas waiting', () => {
    expect(laneAdaptiveCeiling({ floor: 12, current: 20, live: 20, lane: lane(8, 0, 130, { db: true, cpu: 0.2 }), waitingIdeas: 568 }).target).toBe(18);
    expect(laneAdaptiveCeiling({ floor: 12, current: 20, live: 20, lane: lane(8, 3, 130, { db: false, cpu: 0.99 }), waitingIdeas: 568 }).target).toBe(18);
  });
});

describe("the bound follows the lane's proven room", () => {
  it('lifts past LANE_LIFT_MAX when the lane proves more slots, step by step', () => {
    const top = 12 + LANE_LIFT_MAX;
    expect(laneAdaptiveCeiling({ floor: 12, current: top, live: top, lane: lane(8, 0) }).target).toBe(top);
    expect(laneAdaptiveCeiling({ floor: 12, current: top, live: top, lane: lane(8, 0, 130) }).target).toBe(top + LANE_GROW_STEP_MAX);
    expect(laneAdaptiveCeiling({ floor: 12, current: 12 + 130, live: 142, lane: lane(8, 0, 130) }).target).toBe(142);
  });
  it('keeps LANE_LIFT_MAX when the lane proves fewer slots', () => {
    const top = 6 + LANE_LIFT_MAX;
    expect(laneAdaptiveCeiling({ floor: 6, current: top, live: top, lane: lane(8, 0, 10) }).target).toBe(top);
  });
});

describe("a GPU's served sequences are proven room", () => {
  it('counts the batch the pod serves, bounded by the runaway guard and the database share', () => {
    expect(provenSlots({ target: 3, stableHigh: 1, served: null, share: null })).toBe(3);
    expect(provenSlots({ target: 3, stableHigh: 1, served: 128, share: null })).toBe(128);
    expect(provenSlots({ target: 3, stableHigh: 1, served: 128, share: 15 })).toBe(15);
    expect(provenSlots({ target: 3, stableHigh: 1, served: 128, share: null, ceiling: 64 })).toBe(64);
    expect(provenSlots({ target: 3, stableHigh: 1, served: 1000, share: null })).toBe(SAFETY_CEILING);
    expect(provenSlots({ target: 20, stableHigh: 26, served: 8, share: 4 })).toBe(26);
  });
});

describe('the lane reading with a GPU configured', () => {
  let play: TestProject;
  const env = { BRAIN_RUNPOD_URL: 'https://pod.test', BRAIN_RUNPOD_MODE: 'primary', BRAIN_RUNPOD_MODEL: 'openai/gpt-oss-120b', BRAIN_CHEAP_LLM_URL: 'http://lane.test/v1', BRAIN_CHEAP_LLM_MODELS: 'auto/best-coding' };
  beforeEach(async () => {
    play = await freshProject();
    Object.assign(process.env, env);
  });
  afterEach(() => {
    for (const key of Object.keys(env)) delete process.env[key];
  });

  it('opens room beside an idle H200 whose target decayed to 3 (production, 2026-11-17)', async () => {
    await getDb().run('DELETE FROM free_lane_capacity', []);
    await getDb().run(
      "INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('runpod/openai/gpt-oss-120b', 3, 1, '2026-11-17T08:28:00Z', 'no research waiting'), ('auto/best-coding', 2, 1, '2026-11-17T08:28:00Z', 'no research waiting')",
      [],
    );
    // Before: 3 + 2 slots of room, the most a reading opened was one surface.
    expect(await freeLaneProvenSlots()).toBeGreaterThanOrEqual(32);
    expect(await freeLaneSpareSurfaces()).toBe(8);
  });

  it('counts a project\'s launchable ideas with the launch predicate', async () => {
    expect(await launchableInProject(play.project.id)).toBe(0);
  });
});
