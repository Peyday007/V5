/**
 * Brain owning a goal over time, with nobody supervising the handoffs.
 *
 * Every property here is asserted against the rows the dispatcher and the
 * assigner actually read — `listDispatchableBins`, `assignNextBin`, the bin's
 * own lease, attempts and generation — rather than against what the goal view
 * says about them, because the defect this module exists to prevent is a goal
 * page that says "paused" beside a fleet still firing at the work.
 *
 *   1. A pause holds the work and a resume releases it, on the tick, with no
 *      stage button — and the work keeps its lease, attempts and generation.
 *   2. A goal waiting on another goal is released the first pass after that
 *      goal completes.
 *   3. Capacity follows each owner's goals in order, and the reason is the
 *      first fact that separates two goals.
 *   4. A cancelled goal destroys nothing and still names what it owes.
 *   5. A decision that needs a person says what each answer causes, what waits
 *      on it, and what Brain does afterwards.
 *   6. One person's goals never appear in another person's reading.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import {
  assignNextBin,
  countDispatches,
  createBin,
  ensureDispatchIntent,
  supersedeStaleIntents,
  getBin,
  listDispatchableBins,
} from '../server/repos/bins.ts';
import { createWorkstream, linkWorkstream, listWorkstreamEvents, supersedeLink } from '../server/repos/register.ts';
import { launchMission, linkMission, askHuman, transitionMission } from '../server/repos/russellMissions.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import { briefFrom } from '../server/services/goals/briefing.ts';
import { advanceGoals } from '../server/services/goals/tick.ts';
import { cancel, changeObjective, pause, resume, setTerms } from '../server/services/goals/decide.ts';
import { compareGoals, rankGoals } from '../server/services/goals/priority.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let otherProjectId = '';
let ownerId = '';
let workerId = '';

function manifest(projectId: string): BinManifest {
  return {
    objective: 'Establish a small set of values Brain can check for itself.',
    why: 'To exercise goal ownership without spending research allowance.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [
      { key: 'unit-1', establishes: 'The transform of input 1', input: 'one', transform: 'sha256', dependsOn: [] },
    ],
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

/** A goal pursuing one mission, whose bin is real and dispatchable. */
async function goalWithWork(input: {
  project?: string;
  title?: string;
  purpose?: 'REVENUE_DIRECT' | 'REVENUE_ENABLING' | 'CAPABILITY' | 'LONG_TERM';
  owner?: string;
}) {
  const project = input.project ?? projectId;
  const bin = await createBin({
    projectId: project,
    kind: 'DETERMINISTIC_CHECK',
    title: 'Checkable work',
    objective: 'Establish a value.',
    manifest: manifest(project),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const { mission } = await launchMission({
    projectId: project,
    visibility: 'SHARED',
    objective: `Answer the question behind ${input.title ?? 'a goal'}.`,
    whyNow: 'A goal pursues it.',
    idempotencyKey: `mission-${bin.id}`,
  });
  await linkMission({ missionId: mission.id, binId: bin.id });
  const goal = await createWorkstream({
    projectId: project,
    title: input.title ?? 'A goal',
    intent: 'The outcome somebody actually asked for.',
    purpose: input.purpose ?? 'CAPABILITY',
    createdByUserId: input.owner ?? ownerId,
  });
  await linkWorkstream({ workstreamId: goal.id, kind: 'MISSION', ref: mission.id, relation: 'PURSUES', recordedBy: 'PERSON' });
  return { goal, bin, mission };
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  otherProjectId = (await createProject({ name: `Another operation ${Math.random().toString(36).slice(2, 7)}` })).id;
  ownerId = (
    await createUser({
      email: `goal-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
  workerId = (await createWorker({ name: `goal-worker-${Math.random().toString(36).slice(2, 8)}`, displayName: 'Worker', createdByType: 'SYSTEM', createdById: 'test' })).id;
});

async function dispatchable(): Promise<string[]> {
  return (await listDispatchableBins()).map((bin) => bin.id);
}

describe('a pause means the work stops, and a resume needs no button', () => {
  it('holds the bin on the tick, keeps everything about it, and releases it on the next tick after resume', async () => {
    const { goal, bin } = await goalWithWork({ title: 'Pausable' });
    expect(await dispatchable()).toContain(bin.id);

    expect((await pause(goal.id, 'not this week', 'person:test')).ok).toBe(true);
    // The decision alone moves nothing: the tick is what makes it true.
    expect(await dispatchable()).toContain(bin.id);
    const report = await advanceGoals();
    expect(report.held).toContainEqual({ binId: bin.id, goalId: goal.id, reason: 'GOAL_PAUSED' });

    const held = await getBin(bin.id);
    expect(held?.heldByWorkstreamId).toBe(goal.id);
    expect(await dispatchable()).not.toContain(bin.id);
    // The assigner refuses it too — a hold on one of two readers is not a hold.
    expect(await assignNextBin({ workerId, projectIds: [projectId] })).toBeNull();
    expect(held?.attemptCount).toBe(bin.attemptCount);
    expect(held?.leaseGeneration).toBe(bin.leaseGeneration);

    const snapshot = await assembleGoals({ projectIds: [projectId] });
    const view = snapshot.goals.find((one) => one.id === goal.id)!;
    expect(view.lifecycle).toBe('PAUSED');
    expect(view.waiting.kind).toBe('PAUSED');
    expect(view.next.by).toBe('PERSON');
    expect(view.work[0]?.heldReason).toBe('GOAL_PAUSED');

    const resumed = await resume(goal.id, 'person:test');
    expect(resumed.ok).toBe(true);
    expect(resumed.consequence).toMatch(/release/);
    const after = await advanceGoals();
    expect(after.released.map((one) => one.binId)).toContain(bin.id);
    expect(await dispatchable()).toContain(bin.id);
    const assigned = await assignNextBin({ workerId, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(bin.id);

    const kinds = (await listWorkstreamEvents(goal.id)).map((one) => one.kind);
    expect(kinds).toEqual(expect.arrayContaining(['GOAL_PAUSED', 'GOAL_WORK_HELD', 'GOAL_RESUMED', 'GOAL_WORK_RELEASED']));
  });

  it('gives the bin back its fire when the hold is released', async () => {
    const { goal, bin } = await goalWithWork({ title: 'Fired, paused, resumed' });
    const fresh = await getBin(bin.id);
    expect(await ensureDispatchIntent(fresh!)).toBe(true);
    await pause(goal.id, 'hold it', 'person:test');
    await advanceGoals();
    // The dispatcher's own supersede pass retires the intent of a held bin.
    expect(await supersedeStaleIntents()).toBeGreaterThan(0);
    expect(await countDispatches(bin.id, 'PENDING')).toBe(0);
    // And the uniqueness on (bin, generation) means a fresh one cannot be written.
    expect(await ensureDispatchIntent((await getBin(bin.id))!)).toBe(false);

    await resume(goal.id, 'person:test');
    await advanceGoals();
    expect(await countDispatches(bin.id, 'PENDING')).toBe(1);
    expect(await supersedeStaleIntents()).toBe(0);
  });

  it('leaves a worker already inside the bin to finish, keeping its lease', async () => {
    const { goal, bin } = await goalWithWork({ title: 'In flight' });
    const assigned = await assignNextBin({ workerId, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(bin.id);
    await pause(goal.id, 'stop starting new work', 'person:test');
    await advanceGoals();
    const row = await getBin(bin.id);
    expect(row?.state).toBe('LEASED');
    expect(row?.leaseId).toBe(assigned?.leaseId);
    expect(row?.heldByWorkstreamId).toBe(goal.id);
  });

  it('never holds work another live goal is still pursuing', async () => {
    const { goal, mission, bin } = await goalWithWork({ title: 'Shared one' });
    const other = await createWorkstream({
      projectId,
      title: 'Somebody else wants it too',
      intent: 'Another outcome served by the same mission.',
      purpose: 'CAPABILITY',
      createdByUserId: ownerId,
    });
    await linkWorkstream({ workstreamId: other.id, kind: 'MISSION', ref: mission.id, relation: 'PURSUES', recordedBy: 'PERSON' });
    await pause(goal.id, 'mine can wait', 'person:test');
    await advanceGoals();
    expect((await getBin(bin.id))?.heldByWorkstreamId).toBeNull();
  });
});

describe('a goal that waits on another starts by itself when the other completes', () => {
  it('holds the dependent work, then releases it the pass after the dependency delivers', async () => {
    const first = await createWorkstream({
      projectId,
      title: 'Ship the thing',
      intent: 'The prerequisite.',
      purpose: 'REVENUE_ENABLING',
      createdByUserId: ownerId,
    });
    const pending = await linkWorkstream({
      workstreamId: first.id,
      kind: 'DEPLOY',
      ref: 'deploy-1',
      relation: 'PURSUES',
      recordedBy: 'PERSON',
    });
    const { goal: second, bin } = await goalWithWork({ title: 'Use the thing' });
    await linkWorkstream({ workstreamId: second.id, kind: 'WORKSTREAM', ref: first.id, relation: 'DEPENDS_ON', recordedBy: 'PERSON' });

    await advanceGoals();
    expect((await getBin(bin.id))?.heldReason).toBe('WAITING_ON_DEPENDENCY');
    let view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === second.id)!;
    expect(view.waiting.kind).toBe('DEPENDENCY');
    expect(view.dependencies[0]).toMatchObject({ goalId: first.id, met: false });

    // The dependency delivers: an attested, verified deployment.
    await supersedeLink(pending.id, 'the deployment is now attested');
    await linkWorkstream({
      workstreamId: first.id,
      kind: 'DEPLOY',
      ref: 'deploy-1',
      relation: 'PURSUES',
      detail: { attestedBy: 'operator', attestedAt: new Date().toISOString(), verifiedLive: true },
      recordedBy: 'PERSON',
    });
    const report = await advanceGoals();
    expect(report.released).toContainEqual(expect.objectContaining({ binId: bin.id, why: 'every goal it depended on has completed' }));
    expect(await dispatchable()).toContain(bin.id);
    view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === second.id)!;
    expect(view.dependencies[0]?.met).toBe(true);
    const firstView = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === first.id)!;
    expect(firstView.lifecycle).toBe('COMPLETE');
    expect(firstView.evidence[0]?.evidence).toMatch(/attested by operator/);
  });
});

describe('capacity follows an owner’s goals in order, and says why', () => {
  it('puts a customer commitment first and moves the bins to match', async () => {
    const plain = await goalWithWork({ title: 'Ordinary', purpose: 'REVENUE_DIRECT' });
    const owed = await goalWithWork({ title: 'Owed', purpose: 'LONG_TERM' });
    await setTerms(owed.goal.id, { commitment: 'CUSTOMER', dueAt: '2026-10-01T00:00:00.000Z' }, 'person:test');

    const report = await advanceGoals();
    expect((await getBin(owed.bin.id))?.priority).toBe(8);
    expect((await getBin(plain.bin.id))?.priority).toBe(7);
    expect(report.moved.map((one) => one.goalId)).toEqual(expect.arrayContaining([owed.goal.id, plain.goal.id]));

    const views = (await assembleGoals({ projectIds: [projectId] })).goals;
    const owedView = views.find((one) => one.id === owed.goal.id)!;
    expect(owedView.priority?.rank).toBe(0);
    expect(owedView.priority?.aboveNext?.criterion).toBe('COMMITMENT');
    expect(owedView.priority?.aboveNext?.reason).toMatch(/customer/);
    const plainView = views.find((one) => one.id === plain.goal.id)!;
    expect(plainView.priority?.lastMove?.reason).toMatch(/customer/);

    // Idempotent: a second pass moves nothing and records nothing.
    const again = await advanceGoals();
    expect(again.reprioritized).toEqual([]);
    expect(again.moved).toEqual([]);
  });

  it('never ranks one owner-and-project against another', () => {
    const base = { workable: true, commitment: 'NONE' as const, dueAt: null, purpose: 'CAPABILITY' as const, dependents: 0, createdAt: '2026-01-01' };
    const ranked = rankGoals([
      { ...base, id: 'a', ownerKey: 'p1:alice', commitment: 'CUSTOMER' },
      { ...base, id: 'b', ownerKey: 'p2:bob' },
    ]);
    expect(ranked.find((one) => one.id === 'a')?.rank).toBe(0);
    expect(ranked.find((one) => one.id === 'b')?.rank).toBe(0);
  });

  it('never lets an unknown deadline outrank a stated one', () => {
    const base = { ownerKey: 'k', workable: true, commitment: 'NONE' as const, purpose: 'CAPABILITY' as const, dependents: 0, createdAt: '2026-01-01' };
    const result = compareGoals({ ...base, id: 'x', dueAt: null }, { ...base, id: 'y', dueAt: '2026-12-01' });
    expect(result).toEqual({ criterion: 'DEADLINE', order: 1 });
  });
});

describe('cancelling destroys nothing and ends no obligation', () => {
  it('holds the work, keeps it reinstatable, and says the customer is still owed', async () => {
    const { goal, bin } = await goalWithWork({ title: 'Owed to somebody' });
    await setTerms(goal.id, { commitment: 'CUSTOMER' }, 'person:test');
    const result = await cancel(goal.id, 'the customer changed their mind about scope', 'person:test');
    expect(result.consequence).toMatch(/still outstanding/);
    await advanceGoals();
    const row = await getBin(bin.id);
    expect(row?.state).toBe('READY');
    expect(row?.heldReason).toBe('GOAL_CANCELLED');
    const view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === goal.id)!;
    expect(view.lifecycle).toBe('CANCELLED');
    expect(view.next.action).toMatch(/customer obligation/);
    expect(view.next.by).toBe('PERSON');
  });

  it('keeps the old objective when it changes, and leaves the work it started running', async () => {
    const { goal } = await goalWithWork({ title: 'Changing' });
    const result = await changeObjective(goal.id, { intent: 'A narrower outcome.' }, 'person:test');
    expect(result.consequence).toMatch(/keep going/);
    const events = await listWorkstreamEvents(goal.id);
    const changed = events.find((one) => one.kind === 'GOAL_OBJECTIVE_CHANGED')!;
    expect((changed.detail.before as { intent: string }).intent).toBe('The outcome somebody actually asked for.');
  });
});

describe('Needs You holds only a person’s decision, fully prepared', () => {
  it('names the answers, what each causes, what waits, and what Brain does next', async () => {
    const { goal, mission } = await goalWithWork({ title: 'Stopped at a decision' });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'NEEDS_HUMAN', waitingOn: 'a person' });
    await askHuman({
      projectId,
      missionId: mission.id,
      authorityNeeded: 'Whether to accept a report that settles four of five questions.',
      whyNotRussell: 'Filing short is a person’s call.',
      recommendation: 'RECORD_GAPS',
      choices: [
        { key: 'RECORD_GAPS', label: 'File it with the gap recorded', consequence: 'The report is filed and the gap stays visible.' },
        { key: 'STOP', label: 'Stop', consequence: 'Nothing more is researched; everything found is kept.' },
      ],
      resumeKey: `test-${mission.id}`,
    });
    const view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === goal.id)!;
    expect(view.waiting.kind).toBe('PERSON');
    const decision = view.decisions[0]!;
    expect(decision.kind).toBe('HUMAN_REQUEST');
    expect(decision.proposedAction).toMatch(/File it with the gap recorded/);
    expect(decision.choices.map((one) => one.consequence)).toHaveLength(2);
    expect(decision.waitingWork.join(' ')).toMatch(mission.id);
    expect(decision.afterAnswer).toMatch(/next tick/);
    const briefing = briefFrom([view], new Date().toISOString());
    expect(briefing.decisions).toHaveLength(1);
    expect(briefing.headline).toMatch(/1 decision/);
  });

  it('never asks a person about a goal Brain is simply working on', async () => {
    const { goal } = await goalWithWork({ title: 'Just running' });
    const view = (await assembleGoals({ projectIds: [projectId] })).goals.find((one) => one.id === goal.id)!;
    expect(view.decisions).toEqual([]);
    expect(view.next.by).toBe('BRAIN');
    expect(view.waiting.kind).toBe('CAPACITY');
  });
});

describe('one operation’s goals stay in that operation', () => {
  it('reads nothing from a project the caller cannot see', async () => {
    const mine = await goalWithWork({ title: 'Mine' });
    const theirs = await goalWithWork({ title: 'Theirs', project: otherProjectId });
    await linkWorkstream({ workstreamId: mine.goal.id, kind: 'WORKSTREAM', ref: theirs.goal.id, relation: 'DEPENDS_ON', recordedBy: 'PERSON' });
    const snapshot = await assembleGoals({ projectIds: [projectId] });
    expect(snapshot.goals.map((one) => one.id)).not.toContain(theirs.goal.id);
    const view = snapshot.goals.find((one) => one.id === mine.goal.id)!;
    // The dependency is reported as unreadable, never described.
    expect(view.dependencies[0]).toEqual({ goalId: theirs.goal.id, title: null, lifecycle: null, met: null });
    expect(JSON.stringify(snapshot.goals)).not.toContain('Theirs');
  });
});
