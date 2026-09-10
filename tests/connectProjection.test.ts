/**
 * The projection, walked through every state a record can be in.
 *
 * `connect.test.ts` proves the loop over HTTP with real credentials. This one
 * moves the *rows* Russell moves — a judgment recorded, a mission launched, a
 * mission finishing — and asks the projection what it says. That is the half
 * that cannot be tested through the door: the site never sees a mission, so a
 * wrong derivation here would look like nothing at all from outside.
 *
 * The rule being defended is §24's, at a new altitude: a state that says
 * "waiting" which nobody can resolve is not waiting, it is stuck. Every state
 * below either moves on its own or names what would move it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { syncRecords, runCommand, refreshProjections, projectionFor, researchQuestion } from '../server/services/connect/service.ts';
import { findExternalRecord } from '../server/repos/externalRecords.ts';
import { recordJudgment, getCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, transitionMission, askHuman, recordKnowledge } from '../server/repos/russellMissions.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createUser } from '../server/repos/identity.ts';
import { RESEARCH_WORK } from '../server/services/russell/authority.ts';
import { nowIso } from '../server/repos/util.ts';

let ctx: TestProject;

const DELIVERY = {
  sourceRecordType: 'OPPORTUNITY',
  sourceRecordId: 'opp_alpha',
  sourceVersion: '2026-09-01T10:00:00.000Z',
  title: 'Roof replacement across 40 units',
  summary: 'A property manager needs 40 roofs replaced before winter.',
  sourceRef: '/opportunities/opp_alpha',
  attributes: {
    stage: 'QUALIFYING',
    primaryBlocker: 'no confirmed roofing capacity in the county',
    missingInformation: ['crew availability', 'permit lead time'],
    location: 'Oakland County',
  },
};

async function register(): Promise<void> {
  await syncRecords({
    projectId: ctx.project.id,
    sourceSystem: 'DEAL_DISPATCH',
    records: [DELIVERY],
  });
}

async function projection() {
  const view = await projectionFor({
    projectId: ctx.project.id,
    sourceSystem: 'DEAL_DISPATCH',
    sourceRecordId: 'opp_alpha',
  });
  if (!view) throw new Error('the record vanished');
  return view;
}

/** A standing authority, as a person would grant it in Russell. */
async function authorize(): Promise<string> {
  const owner = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.invalid`,
    displayName: 'Owner',
    password: 'a-generated-password-for-tests',
    isBrainAdmin: true,
  });
  const goal = await createGoal({
    projectId: ctx.project.id,
    ownerUserId: owner.id,
    createdByUserId: owner.id,
    name: 'Deal Dispatch research',
    allowedWork: [RESEARCH_WORK],
    maxConcurrent: 1,
    workPolicy: 'UNCAPPED',
    maxMissions: 0,
    maxFragments: 0,
    maxProbes: 0,
    expiresAt: null,
  });
  return goal.id;
}

async function commandIt(): Promise<string> {
  const result = await runCommand({
    projectId: ctx.project.id,
    sourceSystem: 'DEAL_DISPATCH',
    sourceRecordId: 'opp_alpha',
    command: 'RESEARCH_FURTHER',
    actor: { label: 'Dana Reyes' },
  });
  return result.candidateId;
}

beforeEach(async () => {
  ctx = await freshProject();
});

afterEach(async () => {
  await teardown();
});

describe('the six answers', () => {
  it('starts at NOT_EVALUATED with the one thing that can be done', async () => {
    await register();
    const view = await projection();
    expect(view.state).toBe('NOT_EVALUATED');
    expect(view.nextAction?.command).toBe('RESEARCH_FURTHER');
    expect(view.priority).toBeNull();
    expect(view.research).toBeNull();
  });

  it('names the missing authority instead of a queue nobody is in', async () => {
    await register();
    await commandIt();
    const view = await projection();
    expect(view.state).toBe('NEEDS_PERSON');
    expect(view.stateReason).toContain('no standing authority');
    expect(view.nextAction).toBeNull();
  });

  it('is QUEUED once a person has authorised research on the project', async () => {
    await register();
    await authorize();
    await commandIt();
    const view = await projection();
    expect(view.state).toBe('QUEUED');
    expect(view.stateReason).toContain('has not yet formed a view');
  });

  it('carries Brain’s own ranking and reason once it has formed one', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();
    await recordJudgment({
      candidateId,
      state: 'QUEUED',
      priority: 'MUST_DO',
      confidence: 80,
      reason: 'The county has one roofing crew and the permit window closes in six weeks.',
      judgment: {},
    });
    const view = await projection();
    expect(view.state).toBe('QUEUED');
    expect(view.priority).toBe('Must do');
    expect(view.priorityRank).toBe(1);
    expect(view.confidence).toBe(80);
    expect(view.reason).toContain('permit window');
  });

  it('is IN_PROGRESS while a mission is running, and says so', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();
    const { mission } = await launchMission({
      projectId: ctx.project.id,
      visibility: 'SHARED',
      objective: 'Establish roofing capacity in Oakland County',
      whyNow: 'the permit window closes',
      idempotencyKey: `test-${candidateId}`,
      candidateId,
    });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'LAUNCHING' });
    await transitionMission({ missionId: mission.id, from: 'LAUNCHING', to: 'RUNNING' });

    const view = await projection();
    expect(view.state).toBe('IN_PROGRESS');
    expect(view.research?.missionId).toBe(mission.id);
    expect(view.research?.objective).toContain('roofing capacity');
  });

  it('is NEEDS_PERSON with the actual question when a mission stops on one', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();
    const { mission } = await launchMission({
      projectId: ctx.project.id,
      visibility: 'SHARED',
      objective: 'Establish roofing capacity',
      whyNow: 'now',
      idempotencyKey: `test-${candidateId}`,
      candidateId,
    });
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: 'NEEDS_HUMAN',
      waitingOn: 'a decision about which county to treat as in scope',
    });
    await askHuman({
      projectId: ctx.project.id,
      visibility: 'SHARED',
      missionId: mission.id,
      candidateId,
      authorityNeeded: 'Which county should this cover?',
      whyNotRussell: 'the assignment named two and they disagree',
      choices: [
        { key: 'oakland', label: 'Oakland only', consequence: 'Narrows the search to one county.' },
      ],
      urgency: 'WHENEVER',
      resumeKey: `resume-${mission.id}`,
    });

    const view = await projection();
    expect(view.state).toBe('NEEDS_PERSON');
    expect(view.stateReason).toContain('Which county');
  });

  it('is FAILED with the reason that was actually recorded', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();
    const { mission } = await launchMission({
      projectId: ctx.project.id,
      visibility: 'SHARED',
      objective: 'Establish roofing capacity',
      whyNow: 'now',
      idempotencyKey: `test-${candidateId}`,
      candidateId,
    });
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: 'FAILED',
      terminalReason: 'every source for county permit lead times was unreachable from the worker',
    });

    const view = await projection();
    expect(view.state).toBe('FAILED');
    expect(view.stateReason).toContain('unreachable');
    expect(view.nextAction).toBeNull();
  });

  it('is COMPLETED, with the conclusion the project now holds', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();
    const layer = await ctx.layerByName('Discovery Logic');
    const { mission } = await launchMission({
      projectId: ctx.project.id,
      layerId: layer.id,
      visibility: 'SHARED',
      objective: 'Establish roofing capacity',
      whyNow: 'now',
      idempotencyKey: `test-${candidateId}`,
      candidateId,
    });
    await recordKnowledge({
      projectId: ctx.project.id,
      layerId: layer.id,
      visibility: 'SHARED',
      kind: 'CONCLUSION',
      statement: 'Two licensed roofing crews serve the county, both booked into November.',
      detail: null,
      provenance: {},
      authorType: 'PIPELINE',
      confidence: 'ESTABLISHED',
      asOf: nowIso(),
      missionId: mission.id,
      conversationId: null,
    });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'DONE' });

    const view = await projection();
    expect(view.state).toBe('COMPLETED');
    expect(view.research?.conclusion).toContain('Two licensed roofing crews');
    expect(view.research?.filedUnder).toBe('How we find opportunities');
  });

  it('is COMPLETED when the archive already answered it, rather than pretending to work', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();
    await recordJudgment({
      candidateId,
      state: 'PARKED',
      priority: 'PARKED',
      reason: 'The project already holds the answer: the county lists two licensed crews.',
      judgment: {},
    });
    const view = await projection();
    expect(view.state).toBe('COMPLETED');
    expect(view.stateReason).toContain('already holds the answer');
  });
});

describe('the delta feed', () => {
  it('touches a record when its work moves, and not otherwise', async () => {
    await register();
    await authorize();
    const candidateId = await commandIt();

    // The first refresh writes the stamp. It is a change from nothing, so it
    // touches; every refresh after it must not.
    await refreshProjections({});
    const settled = await findExternalRecord('DEAL_DISPATCH', 'opp_alpha');
    const quiet = await refreshProjections({});
    expect(quiet.touched).toEqual([]);
    const unchanged = await findExternalRecord('DEAL_DISPATCH', 'opp_alpha');
    expect(unchanged!.updatedAt).toBe(settled!.updatedAt);

    // Now something actually happens.
    const { mission } = await launchMission({
      projectId: ctx.project.id,
      visibility: 'SHARED',
      objective: 'Establish roofing capacity',
      whyNow: 'now',
      idempotencyKey: `test-${candidateId}`,
      candidateId,
    });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });

    const moved = await refreshProjections({});
    expect(moved.touched).toContain(settled!.id);
    const after = await findExternalRecord('DEAL_DISPATCH', 'opp_alpha');
    expect(after!.updatedAt > settled!.updatedAt).toBe(true);
    // And the imported content is untouched: a touch may never overwrite a version.
    expect(after!.sourceVersion).toBe(settled!.sourceVersion);
    expect(after!.title).toBe(settled!.title);
  });

  it('leaves a record nobody has commanded entirely alone', async () => {
    await register();
    const before = await findExternalRecord('DEAL_DISPATCH', 'opp_alpha');
    const result = await refreshProjections({});
    expect(result.touched).toEqual([]);
    const after = await findExternalRecord('DEAL_DISPATCH', 'opp_alpha');
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });
});

describe('what Brain asks itself', () => {
  it('composes the research question from the record, never from the site', async () => {
    await register();
    const record = await findExternalRecord('DEAL_DISPATCH', 'opp_alpha');
    const question = researchQuestion(record!);
    expect(question).toContain('Roof replacement across 40 units');
    expect(question).toContain('Oakland County');
    expect(question).toContain('no confirmed roofing capacity');
    expect(question).toContain('crew availability');
  });

  it('folds a second command on the same record into the same idea', async () => {
    await register();
    await authorize();
    const first = await commandIt();
    const second = await commandIt();
    expect(second).toBe(first);
    const candidate = await getCandidate(first);
    expect(candidate?.state).not.toBe('MERGED');
  });
});
