/**
 * RES-07 review finding F2: a protected floor holds in the running Brain, not
 * only in the recorded shares. When a purpose sits below its floor:
 *
 *  - queued research items serving it (the free lane's work among them) are
 *    raised to the floor priority, so the next slot that claims takes them;
 *  - when no live bin and no queued item serves it, the owner that opens that
 *    purpose's work is asked — the goal plan pass for exploration, the
 *    improvement loop for system health — once per decision;
 *  - only a still-queued item is touched (the UPDATE is guarded on QUEUED).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { recordImprovementEvent } from '../server/repos/improvement.ts';
import type { BinManifest } from '../server/domain/types.ts';
import {
  RESEARCH_ALLOCATION_DECIDED,
  advanceGoals,
  floorOpenPlan,
  forgetFloorOpenings,
  productionFloorOpeners,
  reallocateResearchIfDue,
  type FloorOpeners,
  type ResearchAllocationPorts,
} from '../server/services/goals/tick.ts';
import { floorResearchRequested, forgetGoalReadings } from '../server/services/goals/plan.ts';
import { EXPLORATION_FLOOR, SYSTEM_HEALTH_FLOOR, type ResearchPurpose } from '../server/services/goals/researchAllocation.ts';

const shares = (over: Partial<Record<ResearchPurpose, number>>): Record<ResearchPurpose, number> => ({
  BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.3, OPERATING_SUPPORT: 0.15, SELF_IMPROVEMENT: 0.15, FORWARD_EXPLORATION: 0.2, ...over,
});

function recordingOpeners() {
  const calls: { kind: 'goal' | 'health'; goalIds?: string[]; why: string }[] = [];
  const openers: FloorOpeners = {
    async widenGoalSearch(goalIds, why) {
      calls.push({ kind: 'goal', goalIds, why });
      return goalIds;
    },
    async openSystemHealth(why) {
      calls.push({ kind: 'health', why });
      return ['weakness:test'];
    },
  };
  return { calls, openers };
}

describe('floorOpenPlan (pure)', () => {
  it('opens only purposes nothing serves, and routes each to the owner that opens its work', () => {
    const plan = floorOpenPlan(['BROAD_DISCOVERY', 'FORWARD_EXPLORATION', 'SELF_IMPROVEMENT'], new Set(['BROAD_DISCOVERY']));
    expect(plan.unserved).toEqual(['FORWARD_EXPLORATION', 'SELF_IMPROVEMENT']);
    expect(plan.goalSearch).toEqual(['FORWARD_EXPLORATION']);
    expect(plan.systemHealth).toBe(true);
    expect(floorOpenPlan(['SELF_IMPROVEMENT'], new Set(['SELF_IMPROVEMENT']))).toEqual({ unserved: [], goalSearch: [], systemHealth: false });
  });
});

describe('advanceGoals makes a protected floor hold when no bin serves it (F2)', () => {
  let projectId: string;
  let seeded = 0;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    forgetFloorOpenings();
    forgetGoalReadings();
    // Spend this hour's decision pass so the seeded decision below is the one in force.
    const spent = { readYield: async () => { throw new Error('this hour is spent'); } } as unknown as ResearchAllocationPorts;
    await reallocateResearchIfDue({ goals: [] }, spent, { nowMs: Date.now(), force: true });
  });

  async function decide(observed: Record<ResearchPurpose, number>, fingerprint = `seed-${Math.random()}`): Promise<void> {
    seeded += 1;
    await recordImprovementEvent({
      candidateId: null,
      kind: RESEARCH_ALLOCATION_DECIDED,
      detail: { fingerprint, shares: shares({}), observed, held: false, floors: { exploration: EXPLORATION_FLOOR, systemHealth: SYSTEM_HEALTH_FLOOR, commercial: null, perPurpose: 0.03 } },
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

  /** A finished BRAIN_IMPROVEMENT bin whose queued free-lane research item still waits. */
  async function improvementItem(priority: number): Promise<string> {
    const bin = await createBin({ projectId, kind: 'DETERMINISTIC_CHECK', title: 'Method check', objective: 'Establish a value.', manifest: manifest(), completionContract: 'DETERMINISTIC_UNITS_V1', createdByType: 'SYSTEM', createdById: 'test', ready: true });
    await getDb().run(`UPDATE bins SET purpose = 'BRAIN_IMPROVEMENT', state = 'COMPLETE' WHERE id = ?`, [bin.id]);
    const item = await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', priority, binId: bin.id, createdByType: 'SYSTEM', createdById: 'test' });
    return item.id;
  }

  const priorityOf = async (id: string) => Number((await getDb().get<{ priority: number }>(`SELECT priority FROM work_items WHERE id = ?`, [id]))!.priority);

  it('reserves the next free-lane slots for queued work serving a below-floor purpose', async () => {
    const item = await improvementItem(3);
    const { calls, openers } = recordingOpeners();
    await decide(shares({ SELF_IMPROVEMENT: 0.02 }));
    const report = await advanceGoals({ floorOpeners: openers });
    expect(report.researchApplied?.belowFloor).toContain('SELF_IMPROVEMENT');
    expect(await priorityOf(item)).toBe(8);
    expect(report.researchApplied?.floorReserved).toContainEqual(expect.objectContaining({ workItemId: item, from: 3, to: 8 }));
    // Served by the queued item, so nothing new is opened for it.
    expect(report.researchApplied?.floorUnserved).not.toContain('SELF_IMPROVEMENT');
    expect(calls.filter((c) => c.kind === 'health')).toHaveLength(0);
  });

  it('touches only an item still queued: one a worker took or finished keeps its priority', async () => {
    const item = await improvementItem(3);
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED' WHERE id = ?`, [item]);
    await decide(shares({ SELF_IMPROVEMENT: 0.02 }));
    const report = await advanceGoals({ floorOpeners: recordingOpeners().openers });
    expect(await priorityOf(item)).toBe(3);
    expect(report.researchApplied?.floorReserved).toEqual([]);
  });

  it('opens system-health work through the improvement loop when nothing serves the floor, once per decision', async () => {
    const { calls, openers } = recordingOpeners();
    await decide(shares({ SELF_IMPROVEMENT: 0.02 }), 'fp-health');
    const report = await advanceGoals({ floorOpeners: openers });
    expect(report.researchApplied?.floorUnserved).toContain('SELF_IMPROVEMENT');
    expect(report.researchApplied?.floorOpened).toContainEqual(expect.objectContaining({ purpose: 'SELF_IMPROVEMENT', refs: ['weakness:test'] }));
    expect(calls.filter((c) => c.kind === 'health')).toHaveLength(1);
    // The same decision on the next pass does not ask again.
    const again = await advanceGoals({ floorOpeners: openers });
    expect(again.researchApplied?.floorOpened).toEqual([]);
    expect(calls.filter((c) => c.kind === 'health')).toHaveLength(1);
  });

  it('asks the goal plan pass to widen the active goals’ search when exploration is below its floor and nothing serves it', async () => {
    const { createUser } = await import('../server/repos/identity.ts');
    const { createWorkstream } = await import('../server/repos/register.ts');
    const owner = await createUser({ email: `floor-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    const goal = await createWorkstream({ projectId, title: 'Find openings', intent: 'Money.', purpose: 'CAPABILITY', createdByUserId: owner.id });
    await decide(shares({ BROAD_DISCOVERY: 0.02, FORWARD_EXPLORATION: 0.02 }));
    const { calls, openers } = recordingOpeners();
    const report = await advanceGoals({ floorOpeners: openers });
    expect(report.researchApplied?.floorUnserved).toEqual(expect.arrayContaining(['BROAD_DISCOVERY', 'FORWARD_EXPLORATION']));
    const asked = calls.filter((c) => c.kind === 'goal');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.goalIds).toContain(goal.id);
    expect(report.researchApplied?.floorOpened?.map((o) => o.purpose)).toEqual(expect.arrayContaining(['BROAD_DISCOVERY', 'FORWARD_EXPLORATION']));
  });

  it('the production opener leaves the request with the goal plan pass, which widens that goal on its next pass', async () => {
    await productionFloorOpeners.widenGoalSearch(['ws_floor_goal'], 'BROAD_DISCOVERY below the protected floor');
    expect(floorResearchRequested('ws_floor_goal')).toMatch(/BROAD_DISCOVERY/);
    forgetGoalReadings();
    expect(floorResearchRequested('ws_floor_goal')).toBeUndefined();
  });
});
