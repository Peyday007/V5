/**
 * Recorded failure class OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595:
 * independent ready units queued behind the lane target.
 *
 * The tuner used to rise one lane per tick on clean evidence, so a plan with
 * six disjoint units and six free slots started three (INITIAL_LANE_TARGET) and
 * left the rest waiting for later ticks — development time spent queueing. A
 * clean rise now meets the waiting independent demand in one step; every
 * lowering branch keeps its precedence and its one-lane step.
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  tuneLaneTarget,
  INITIAL_LANE_TARGET,
  MAX_LANE_TARGET,
  type SchedulableUnit,
  type SchedulerEvidence,
} from '../server/services/factory/scheduler.ts';
import type { WorkerSlot } from '../server/services/factory/registry.ts';

const clean: SchedulerEvidence = {
  firstPassSuccessRate: null,
  overlapRefusals: 0,
  rateLimitedSessions: 0,
  maxObservedConcurrency: 0,
  mergedUnits: 0,
  failedUnits: 0,
};

const slot = (over: Partial<WorkerSlot> = {}): WorkerSlot => ({
  workerId: 'w1',
  name: 'w1',
  kind: 'LOCAL_CLI',
  accountRef: 'a1',
  model: 'sonnet',
  modelClass: 'FAST',
  capabilities: ['IMPLEMENT'],
  freeSlots: 1,
  running: 0,
  availability: 'AVAILABLE',
  rateLimitedUntil: null,
  ...over,
});

const unit = (key: string, ownedPaths: string[]): SchedulableUnit => ({
  id: key,
  unitKey: key,
  kind: 'IMPLEMENTATION',
  role: 'IMPLEMENTER',
  modelClass: 'FAST',
  ownedPaths,
  criticalPath: false,
  downstreamCount: 0,
  priority: 5,
  risk: 'LOW',
  attempt: 0,
  maxAttempts: 3,
});

describe('lane target catch-up (OPERATOR:RESOURCE_ALLOCATION:591a21ff74213595)', () => {
  it('rises to the waiting independent demand in one step', () => {
    const tuned = tuneLaneTarget(3, clean, 6, 6);
    expect(tuned.target).toBe(6);
    expect(tuned.reason).toMatch(/6 independent unit\(s\) waiting/);
  });

  it('accepts first-pass success at the 0.6 bar', () => {
    expect(tuneLaneTarget(3, { ...clean, firstPassSuccessRate: 0.6, mergedUnits: 5 }, 6, 6).target).toBe(6);
  });

  it('never exceeds MAX_LANE_TARGET or the free slots', () => {
    expect(tuneLaneTarget(3, clean, 12, 12).target).toBe(MAX_LANE_TARGET);
    expect(tuneLaneTarget(3, clean, 6, 4).target).toBe(4);
  });

  it('holds when demand is at or below the current target', () => {
    for (const demand of [0, 2, 3]) {
      const held = tuneLaneTarget(3, clean, demand, 8);
      expect(held.target).toBe(3);
      expect(held.reason).toMatch(/unchanged/);
    }
  });

  it('does not rise on middling first-pass success', () => {
    expect(tuneLaneTarget(3, { ...clean, firstPassSuccessRate: 0.5, mergedUnits: 5 }, 6, 6).target).toBe(3);
  });

  it('lowering branches keep precedence and step down by exactly one', () => {
    const refused = tuneLaneTarget(5, { ...clean, rateLimitedSessions: 1 }, 10, 10);
    expect(refused.target).toBe(4);
    expect(refused.reason).toMatch(/provider refusal/);

    const contended = tuneLaneTarget(5, { ...clean, overlapRefusals: 4, mergedUnits: 1 }, 10, 10);
    expect(contended.target).toBe(4);
    expect(contended.reason).toMatch(/overlapping ownership/);

    const weak = tuneLaneTarget(5, { ...clean, firstPassSuccessRate: 0.3, mergedUnits: 4 }, 10, 10);
    expect(weak.target).toBe(4);
    expect(weak.reason).toMatch(/first-pass success/);
  });

  it('decide() starts six disjoint ready units in a single decision', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => unit(k, [`src/${k}/**`]));
    const decision = decide({
      at: '2026-11-24T00:00:00.000Z',
      campaignId: 'c1',
      laneTarget: INITIAL_LANE_TARGET,
      candidates,
      live: [],
      slots: [
        slot({ workerId: 'w1', name: 'w1', freeSlots: 3 }),
        slot({ workerId: 'w2', name: 'w2', freeSlots: 3 }),
      ],
      evidence: clean,
      implementedBy: {},
    });
    expect(decision.laneTarget).toBe(6);
    expect(decision.assignments.length).toBe(6);
    expect(decision.refusals.filter((r) => /lane target/.test(r.reason))).toEqual([]);
  });

  it('still serialises overlapping units after the rise', () => {
    const decision = decide({
      at: '2026-11-24T00:00:00.000Z',
      campaignId: 'c1',
      laneTarget: INITIAL_LANE_TARGET,
      candidates: [
        unit('a', ['src/a/**']),
        unit('b', ['src/shared/**']),
        unit('c', ['src/c/**']),
        unit('d', ['src/d/**']),
        unit('e', ['src/e/**']),
      ],
      live: [{ unitId: 'z', workerId: 'w9', ownedPaths: ['src/shared/thing.ts'] }],
      slots: [slot({ freeSlots: 6 })],
      evidence: clean,
      implementedBy: {},
    });
    expect(decision.assignments.map((a) => a.unitId).sort()).toEqual(['a', 'c', 'd', 'e']);
    expect(decision.refusals.find((r) => r.unitId === 'b')?.reason).toMatch(/overlaps/);
  });
});
