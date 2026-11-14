/**
 * A research round that ended without a report is a finished answer Brain
 * handles itself (§65), and one blocked path does not stop a targeted goal
 * whose other work is live.
 *
 * Production 2026-11-14: the $10K goal read BLOCKED, waiting on a PERSON for a
 * goal-round idea "Researched once and it produced no report", with 67 such
 * blockers ~320h old, while 15 READY bins waited.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createBin } from '../server/repos/bins.ts';
import { createWorkstream, getWorkstream, linkWorkstream } from '../server/repos/register.ts';
import { launchMission, linkMission } from '../server/repos/russellMissions.ts';
import { createCandidate, recordJudgment } from '../server/repos/russellCandidates.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

function manifest(project: string): BinManifest {
  return {
    objective: 'Establish a small set of values Brain can check for itself.',
    why: 'To exercise goal state without spending research allowance.',
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

async function targetedGoal(title: string) {
  const goal = await createWorkstream({ projectId, title, intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  const set = await setTarget({
    goal: (await getWorkstream(goal.id))!,
    metric: 'SETTLED_CASH',
    amountCents: 1_000_000,
    currency: 'USD',
    projectId,
    now: new Date(Date.now() - 60_000),
  });
  expect(set.ok).toBe(true);
  return goal;
}

async function linkReadyBin(goalId: string) {
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
    objective: 'Answer the question behind the goal.',
    whyNow: 'A goal pursues it.',
    idempotencyKey: `mission-${bin.id}`,
  });
  await linkMission({ missionId: mission.id, binId: bin.id });
  await linkWorkstream({ workstreamId: goalId, kind: 'MISSION', ref: mission.id, relation: 'PURSUES', recordedBy: 'BRAIN' });
  return bin;
}

async function linkParkedIdea(goalId: string, how: 'without-report' | 'genuine') {
  const candidate = await createCandidate({ projectId, visibility: 'SHARED', title: 'A goal-round idea', statement: `Sell the thing ${Math.random()}` });
  expect(
    await recordJudgment({
      candidateId: candidate.id,
      state: 'PARKED',
      priority: 'PARKED',
      reason:
        how === 'without-report'
          ? 'Researched once and it produced no report: the round ended'
          : 'Needs the owner to say whether a licence is held.',
      judgment: how === 'without-report' ? { researchedWithoutReport: { missionId: null, reason: 'the round ended' } } : {},
    }),
  ).toBe(true);
  await linkWorkstream({ workstreamId: goalId, kind: 'CANDIDATE', ref: candidate.id, relation: 'PURSUES', recordedBy: 'BRAIN' });
  return candidate;
}

async function goalView(id: string) {
  const { goals } = await assembleGoals({ projectIds: [projectId] });
  const goal = goals.find((one) => one.id === id);
  expect(goal).toBeDefined();
  return goal!;
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `parked-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash.' })).ok).toBe(true);
});

describe('a research round that ended without a report is not a person blocker', () => {
  it('a targeted goal linked to such a parked idea and a READY bin is not BLOCKED and does not wait on a person', async () => {
    const goal = await targetedGoal('Ten thousand');
    const parked = await linkParkedIdea(goal.id, 'without-report');
    await linkReadyBin(goal.id);

    const view = await goalView(goal.id);
    expect(view.state).not.toBe('BLOCKED');
    expect(view.waiting.kind).not.toBe('PERSON');
    expect(view.next.by).not.toBe('PERSON');
    expect(view.blockers.some((one) => one.ref === parked.id)).toBe(false);
    const reading = view.linked.find((one) => one.ref === parked.id);
    expect(reading?.state).toBeNull();
    expect(reading?.blocker).toBeNull();
    expect(reading?.status).toContain('round ended without a report');
  });

  it('a genuinely person-blocked link still reads blocked', async () => {
    const goal = await targetedGoal('Blocked for real');
    const parked = await linkParkedIdea(goal.id, 'genuine');

    const view = await goalView(goal.id);
    expect(view.state).toBe('BLOCKED');
    expect(view.waiting.kind).toBe('PERSON');
    expect(view.blockers.some((one) => one.ref === parked.id && one.by === 'PERSON')).toBe(true);
  });

  it('one genuinely blocked path does not make a targeted goal BLOCKED while other linked work is READY', async () => {
    const goal = await targetedGoal('Many paths');
    const parked = await linkParkedIdea(goal.id, 'genuine');
    await linkReadyBin(goal.id);

    const view = await goalView(goal.id);
    expect(view.state).not.toBe('BLOCKED');
    expect(view.waiting.kind).not.toBe('PERSON');
    // The blocked path is still listed, so nothing is hidden.
    expect(view.blockers.some((one) => one.ref === parked.id)).toBe(true);
  });
});
