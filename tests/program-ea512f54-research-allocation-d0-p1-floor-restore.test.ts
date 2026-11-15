/**
 * RES-07 / RES-15-5, round-5 repair (41b9a10): a floor raise is bounded,
 * recorded, and put back.
 *
 *  - floorBudgets caps each floor's raises at its shortfall's share of the
 *    queue (at least one while short, none when not);
 *  - holdFloors raises no more than that budget, counts raises it still holds
 *    against it, and records each raise as RESEARCH_FLOOR_RESERVED with the
 *    item's own priority;
 *  - once the purpose is back above its floor, every pass puts the item back
 *    to its owner's priority and records RESEARCH_FLOOR_RESTORED;
 *  - the restore is guarded: an item its owner moved, or a worker claimed,
 *    keeps what it has and is recorded as not restored.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { listImprovementEvents, recordImprovementEvent } from '../server/repos/improvement.ts';
import type { BinManifest } from '../server/domain/types.ts';
import {
  FLOOR_RESERVED_EVENT,
  FLOOR_RESTORED_EVENT,
  RESEARCH_ALLOCATION_DECIDED,
  advanceGoals,
  floorBudgets,
  forgetFloorOpenings,
  reallocateResearchIfDue,
  type FloorOpeners,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { forgetGoalReadings } from '../server/services/goals/plan.ts';
import { EXPLORATION_FLOOR, SYSTEM_HEALTH_FLOOR, type ResearchPurpose, type SharesInForce } from '../server/services/goals/researchAllocation.ts';

const shares = (over: Partial<Record<ResearchPurpose, number>>): Record<ResearchPurpose, number> => ({
  BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.3, OPERATING_SUPPORT: 0.15, SELF_IMPROVEMENT: 0.15, FORWARD_EXPLORATION: 0.2, ...over,
});

const quietOpeners: FloorOpeners = {
  async widenGoalSearch(goalIds) { return goalIds; },
  async openSystemHealth() { return []; },
};

describe('floorBudgets (pure)', () => {
  const inForce = (observed: Partial<Record<ResearchPurpose, number>>, urgentCommercialGoal = false): SharesInForce => ({
    shares: shares({}), observed: shares(observed), held: false, urgentCommercialGoal,
  });

  it('gives a short floor its shortfall share of the queue, rounded up', () => {
    // System health floor 0.10, observed 0.02: shortfall 0.08 of 20 queued = 1.6 → 2.
    expect(floorBudgets(inForce({ SELF_IMPROVEMENT: 0.02 }), 20).SYSTEM_HEALTH).toBe(2);
    expect(floorBudgets(inForce({ SELF_IMPROVEMENT: 0.02 }), 100).SYSTEM_HEALTH).toBe(8);
  });

  it('gives at least one while short, even on a tiny queue', () => {
    expect(floorBudgets(inForce({ SELF_IMPROVEMENT: 0.099 }), 3).SYSTEM_HEALTH).toBe(1);
    expect(floorBudgets(inForce({ SELF_IMPROVEMENT: 0.02 }), 0).SYSTEM_HEALTH).toBe(1);
  });

  it('gives nothing to a floor that is not short, and nothing to commercial without an urgent goal', () => {
    const b = floorBudgets(inForce({ SELF_IMPROVEMENT: 0.15, TRANSACTION_ROUTES: 0.01 }), 50);
    expect(b).toEqual({ EXPLORATION: 0, SYSTEM_HEALTH: 0, COMMERCIAL: 0 });
    expect(floorBudgets(inForce({ TRANSACTION_ROUTES: 0.05 }, true), 50).COMMERCIAL).toBe(Math.ceil((0.2 - 0.05) * 50));
  });

  it('gives nothing while the decision is held', () => {
    expect(floorBudgets({ ...inForce({ SELF_IMPROVEMENT: 0.0 }), held: true }, 50)).toEqual({ EXPLORATION: 0, SYSTEM_HEALTH: 0, COMMERCIAL: 0 });
  });
});

describe('advanceGoals bounds, records and undoes a floor raise', () => {
  let projectId: string;
  let seeded = 0;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    forgetFloorOpenings();
    forgetGoalReadings();
    const spent = { readYield: async () => { throw new Error('this hour is spent'); } } as unknown as ResearchAllocationPorts;
    await reallocateResearchIfDue({ goals: [] }, spent, { nowMs: Date.now(), force: true });
  });

  async function decide(observed: Record<ResearchPurpose, number>): Promise<void> {
    seeded += 1;
    await recordImprovementEvent({
      candidateId: null,
      kind: RESEARCH_ALLOCATION_DECIDED,
      detail: { fingerprint: `seed-${seeded}-${Math.random()}`, shares: shares({}), observed, held: false, floors: { exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR, commercial: null, perPurpose: 0.03 } },
      at: new Date(Date.now() + 60_000 + seeded * 1000).toISOString(),
    });
  }

  function manifest(): BinManifest {
    return {
      objective: 'Establish a value.', why: 'Exercise the floor.', lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'unit-1', establishes: 'The transform of input 1', input: 'one', transform: 'sha256', dependsOn: [] }],
      acceptableSources: [], excludedSources: [], evidence: ['a recomputed value'], outputs: ['one unit result'],
      authorizedActions: ['submit unit results'], prohibitedActions: ['anything with an external effect'], budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 30 }, stoppingConditions: ['every unit verified'],
    };
  }

  /** Queued free-lane research items serving SELF_IMPROVEMENT (a finished BRAIN_IMPROVEMENT bin). */
  async function improvementItems(n: number, priority: number): Promise<string[]> {
    const bin = await createBin({ projectId, kind: 'DETERMINISTIC_CHECK', title: 'Method check', objective: 'Establish a value.', manifest: manifest(), completionContract: 'DETERMINISTIC_UNITS_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true });
    await getDb().run(`UPDATE bins SET purpose = 'BRAIN_IMPROVEMENT', state = 'COMPLETE' WHERE id = ?`, [bin.id]);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', priority, binId: bin.id, createdByType: 'SYSTEM', createdById: 'test' })).id);
    return ids;
  }

  const priorityOf = async (id: string) => Number((await getDb().get<{ priority: number }>(`SELECT priority FROM work_items WHERE id = ?`, [id]))!.priority);
  const events = (kind: string) => listImprovementEvents({ kinds: [kind], limit: 100 });
  const below = () => shares({ SELF_IMPROVEMENT: 0.02 });
  const recovered = () => shares({ SELF_IMPROVEMENT: 0.15 });

  it('raises at most the shortfall share of the queue, and a held raise counts against the next pass', async () => {
    const ids = await improvementItems(20, 3);
    await decide(below());
    const first = await advanceGoals({ floorOpeners: quietOpeners });
    // shortfall 0.08 × 20 queued → 2, not the whole queue.
    expect(first.researchApplied?.floorReserved).toHaveLength(2);
    const raised = (await Promise.all(ids.map(priorityOf))).filter((p) => p === 8);
    expect(raised).toHaveLength(2);
    // The raise is recorded with the owner's own priority.
    const reserved = await events(FLOOR_RESERVED_EVENT);
    expect(reserved).toHaveLength(1);
    const items = (reserved[0]!.detail as { items: { workItemId: string; from: number; to: number }[] }).items;
    expect(items).toHaveLength(2);
    for (const it of items) expect(it).toEqual(expect.objectContaining({ from: 3, to: 8 }));
    // Same reading next pass: the two outstanding raises fill the budget, nothing more is raised.
    const second = await advanceGoals({ floorOpeners: quietOpeners });
    expect(second.researchApplied?.floorReserved).toEqual([]);
    expect((await Promise.all(ids.map(priorityOf))).filter((p) => p === 8)).toHaveLength(2);
    expect(await events(FLOOR_RESERVED_EVENT)).toHaveLength(1);
  });

  it('puts a raised item back to its owner’s priority once the floor recovers, and records it', async () => {
    const [id] = await improvementItems(1, 3);
    await decide(below());
    await advanceGoals({ floorOpeners: quietOpeners });
    expect(await priorityOf(id!)).toBe(8);
    await decide(recovered());
    const report = await advanceGoals({ floorOpeners: quietOpeners });
    expect(report.researchApplied?.belowFloor).not.toContain('SELF_IMPROVEMENT');
    expect(await priorityOf(id!)).toBe(3);
    expect(report.researchApplied?.floorRestored).toEqual([{ workItemId: id, from: 8, to: 3, restored: true }]);
    const restoredEvents = await events(FLOOR_RESTORED_EVENT);
    expect(restoredEvents).toHaveLength(1);
    // Restored once: a further pass has nothing outstanding to put back.
    const again = await advanceGoals({ floorOpeners: quietOpeners });
    expect(again.researchApplied?.floorRestored).toEqual([]);
    expect(await events(FLOOR_RESTORED_EVENT)).toHaveLength(1);
  });

  it('leaves an item its owner moved since the raise where the owner put it', async () => {
    const [id] = await improvementItems(1, 3);
    await decide(below());
    await advanceGoals({ floorOpeners: quietOpeners });
    await getDb().run(`UPDATE work_items SET priority = 5 WHERE id = ?`, [id!]);
    await decide(recovered());
    const report = await advanceGoals({ floorOpeners: quietOpeners });
    expect(await priorityOf(id!)).toBe(5);
    expect(report.researchApplied?.floorRestored).toEqual([{ workItemId: id, from: 8, to: 3, restored: false }]);
  });

  it('leaves an item a worker claimed since the raise alone', async () => {
    const [id] = await improvementItems(1, 3);
    await decide(below());
    await advanceGoals({ floorOpeners: quietOpeners });
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED' WHERE id = ?`, [id!]);
    await decide(recovered());
    const report = await advanceGoals({ floorOpeners: quietOpeners });
    expect(await priorityOf(id!)).toBe(8);
    expect(report.researchApplied?.floorRestored).toEqual([{ workItemId: id, from: 8, to: 3, restored: false }]);
  });

  it('does not put back a raise while its purpose is still below the floor', async () => {
    const [id] = await improvementItems(1, 3);
    await decide(below());
    await advanceGoals({ floorOpeners: quietOpeners });
    const report = await advanceGoals({ floorOpeners: quietOpeners });
    expect(await priorityOf(id!)).toBe(8);
    expect(report.researchApplied?.floorRestored).toEqual([]);
  });
});
