/**
 * What one goals tick costs, and what it must not grow with.
 *
 * `advanceGoals` runs on every Russell tick — every thirty seconds, for ever —
 * and the hosted verification files two goals and archives them on each side
 * of every deploy's restart. So an archived goal is the one kind of row this
 * table gains without bound, and a tick that re-derived each one's linked work
 * would cost more on every deploy, against a database production found slow
 * enough on 2026-09-23 that its own pooler could not check a credential.
 *
 * An archived goal holds nothing and ranks nowhere; the only thing the tick
 * needs from it is that it exists, so a hold it left behind is released. The
 * assertion is about statements rather than the clock, so it holds anywhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, createWorker, grantMembership, setWorkerStatus } from '../server/repos/identity.ts';
import { createBin, ensureDispatchIntent, listDispatchesForBin, markDispatchFailed } from '../server/repos/bins.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { archiveWorkstream, createWorkstream, linkWorkstream, listWorkstreamEvents } from '../server/repos/register.ts';
import { getBin } from '../server/repos/bins.ts';
import { pause } from '../server/services/goals/decide.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { advanceGoals } from '../server/services/goals/tick.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let ownerId = '';

function manifest(project: string): BinManifest {
  return {
    objective: 'Establish a value Brain can check for itself.',
    why: 'To give a goal real linked work.',
    lineage: { projectId: project, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'unit-1', establishes: 'The transform of input 1', input: 'one', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ["a stored value matching Brain's own recomputation"],
    outputs: ['one unit result per declared unit'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['every declared unit has a verified result'],
  };
}

async function goalWithWork(title: string) {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'Checkable work',
    objective: 'Establish a value.',
    manifest: manifest(projectId),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const { mission } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: `Answer the question behind ${title}.`,
    whyNow: 'A goal pursues it.',
    idempotencyKey: `mission-${bin.id}`,
  });
  await linkMission({ missionId: mission.id, binId: bin.id });
  const goal = await createWorkstream({
    projectId,
    title,
    intent: 'The outcome somebody actually asked for.',
    purpose: 'CAPABILITY',
    createdByUserId: ownerId,
  });
  await linkWorkstream({ workstreamId: goal.id, kind: 'MISSION', ref: mission.id, relation: 'PURSUES', recordedBy: 'PERSON' });
  return { goal, bin };
}

async function statementsDuring(work: () => Promise<unknown>): Promise<number> {
  const db = getDb() as unknown as Record<'all' | 'get' | 'run', (...args: unknown[]) => unknown>;
  const originals = { all: db.all, get: db.get, run: db.run };
  let count = 0;
  for (const method of ['all', 'get', 'run'] as const) {
    const original = originals[method];
    db[method] = (...args: unknown[]) => {
      count += 1;
      return original.apply(db, args);
    };
  }
  try {
    await work();
  } finally {
    Object.assign(db, originals);
  }
  return count;
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  ownerId = (
    await createUser({
      email: `tick-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

describe('a goals tick', () => {
  it('costs nothing more for an archived goal, however many there are', async () => {
    await goalWithWork('The live one');
    await advanceGoals();
    const before = await statementsDuring(() => advanceGoals());

    for (let i = 0; i < 8; i += 1) {
      const { goal } = await goalWithWork(`Hosted verification ${i}`);
      await archiveWorkstream(goal.id, 'a verification fixture, finished with');
    }
    await advanceGoals();
    const after = await statementsDuring(() => advanceGoals());

    expect(after).toBe(before);
  });

  it('still releases a hold an archived goal left behind, and says why', async () => {
    const { goal, bin } = await goalWithWork('Paused, then archived');
    await pause(goal.id, 'not now', 'person:test');
    await advanceGoals();
    expect((await getBin(bin.id))?.heldByWorkstreamId).toBe(goal.id);

    await archiveWorkstream(goal.id, 'nobody wants this any more');
    const report = await advanceGoals();
    expect((await getBin(bin.id))?.heldByWorkstreamId).toBeNull();
    expect(report.released).toContainEqual({ binId: bin.id, goalId: goal.id, why: 'the goal is archived' });
    const events = await listWorkstreamEvents(goal.id, 20);
    expect(events.some((one) => one.kind === 'GOAL_WORK_RELEASED')).toBe(true);
  });

  it('reads the fleet once per tick, however many goals are blocked on it', async () => {
    /*
     * A blocked bin's remedy asks the router (fleetSnapshot), which is dozens
     * of statements. Asked per bin per goal per tick, the first release that
     * did so made every goals tick scale with the number of blocked bins —
     * while production's research fleet was quarantined and many were.
     */
    // Bound to a worker holding the project, as production's are, so the
    // remedy reaches the router's question rather than returning early — and
    // that worker disabled, so the surfaces are out of routing.
    const worker = await createWorker({ name: `tick-worker-${Math.random().toString(36).slice(2, 8)}`, displayName: 'Worker', createdByType: 'SYSTEM', createdById: 'test' });
    await grantMembership({ projectId, principalType: 'WORKER', principalId: worker.id, role: null, scopes: ['queue:read', 'queue:claim'], grantedByType: 'SYSTEM', grantedById: 'test' });
    await setWorkerStatus(worker.id, 'DISABLED');
    for (let i = 0; i < 6; i += 1) {
      const account = await createAccount({ name: `tick-acct-${i}-${Math.random().toString(36).slice(2, 6)}` });
      await createRoutine({
        accountId: account.id,
        routineRef: `trig_tick_${i}_${Math.random().toString(36).slice(2, 8)}`,
        name: `Tick surface ${i}`,
        tokenSecretName: `TICK_SECRET_${i}`,
        workerId: worker.id,
      });
      process.env[`TICK_SECRET_${i}`] = 'present-for-test';
    }
    const snapshotCost = await statementsDuring(() => fleetSnapshot());
    expect(snapshotCost).toBeGreaterThan(8);

    async function blockedGoal(title: string): Promise<void> {
      const { bin } = await goalWithWork(title);
      await ensureDispatchIntent((await getBin(bin.id))!);
      const intent = (await listDispatchesForBin(bin.id))[0]!;
      await markDispatchFailed(intent.id, { kind: 'NO_SURFACE_SERVES_THIS_PROJECT', message: 'none', refundAttempt: true });
    }
    await blockedGoal('Blocked 0');
    await advanceGoals();
    const one = await statementsDuring(() => advanceGoals());
    for (let i = 1; i < 5; i += 1) await blockedGoal(`Blocked ${i}`);
    await advanceGoals();
    const five = await statementsDuring(() => advanceGoals());
    // Four more blocked goals may cost their own rows, and not a fleet read each.
    expect((five - one) / 4).toBeLessThan(snapshotCost);
  });
});
