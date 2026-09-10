/**
 * The seed kernel, against a real repository.
 *
 * Every test here uses a real git repository in a temporary directory, real
 * worktrees and real commits. The only thing scripted is the worker itself —
 * replaced through the executor seam — because what these tests are about is
 * whether the factory reads the repository correctly, and a mocked repository
 * would be the factory reading its own assumptions back.
 *
 * Reverting any of the repairs these cover should make the matching test fail:
 * the claim's compare-and-swap, the ownership exclusion, the attempt refund on a
 * provider refusal, the integrator's scope rejection, the review's independence
 * floor and its verdict cross-check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  claimUnits,
  deferUnit,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  addDependency,
  getUnit,
  failUnit,
  listUnits,
  markImplemented,
  promoteReadyUnits,
  refundAttempt,
  findDependencyCycle,
  pathsOverlap,
  plusMs,
  factoryNow,
  recordCheckpoint,
  latestCheckpoint,
  claimCampaignTick,
  approveChangeRequest,
} from '../server/repos/factory.ts';
import {
  abandonOrphanedSessions,
  listFindings,
  recordReview,
  listSessions,
  openSession,
  registerWorker,
  workerLoad,
} from '../server/repos/factoryFleet.ts';
import { createUser } from '../server/repos/identity.ts';
import { submitObjective, approveObjective, amendContract } from '../server/services/factory/contract.ts';
import { validatePlan, installPlan } from '../server/services/factory/planner.ts';
import { checkOwnership, matchesGlob, integrateUnit } from '../server/services/factory/integrate.ts';
import { gatingFindings, queueRepairs, reconcileRepairs } from '../server/services/factory/repair.ts';
import { decideIndependence, parseReview } from '../server/services/factory/review.ts';
import { maxOverlap, computeMetrics } from '../server/services/factory/metrics.ts';
import { decide, tuneLaneTarget, chooseWorker } from '../server/services/factory/scheduler.ts';
import { parseWorkerReport } from '../server/services/factory/prompts.ts';
import { run, gitOrThrow, ensureWorktree, commitAll } from '../server/services/factory/git.ts';
import type { FactoryChangeRequest } from '../server/domain/factory.ts';

let fixture: TestProject;
let repoRoot: string;
/** A real person, because an approval references one and the schema means it. */
let approverId: string;

/** A small real repository: a package.json with scripts, and a file to change. */
async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-repo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { typecheck: 'node -e "0"', test: 'node -e "0"' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'one.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'src', 'two.txt'), 'two\n');
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Factory Test'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

beforeEach(async () => {
  fixture = await freshProject();
  repoRoot = await makeRepository();
  approverId = (
    await createUser({
      email: 'factory-approver@test.local',
      displayName: 'Factory Approver',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

async function approvedChangeRequest(
  overrides: Partial<{ mutationScope: string[]; objective: string }> = {},
): Promise<FactoryChangeRequest> {
  const submitted = await submitObjective({
    projectId: fixture.project.id,
    objective: overrides.objective ?? 'Make the first file say something else, and prove it.',
    expectedOutcome: 'src/one.txt contains the new text.',
    acceptanceConditions: [
      { statement: 'src/one.txt contains the new text', verification: 'read the file' },
    ],
    repositoryRoot: repoRoot,
    mutationScope: overrides.mutationScope,
  });
  const approved = await approveObjective({
    changeRequestId: submitted.changeRequest.id,
    via: 'PERSON',
    userId: approverId,
  });
  expect(approved.ok).toBe(true);
  return approved.changeRequest;
}

describe('the contract', () => {
  it('derives the pin and the verification commands from the repository', async () => {
    const submitted = await submitObjective({
      projectId: fixture.project.id,
      objective: 'Change the first file so the outcome is visible.',
      expectedOutcome: 'The file changed.',
      acceptanceConditions: [{ statement: 'the file changed', verification: 'read it' }],
      repositoryRoot: repoRoot,
    });
    const head = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
    expect(submitted.changeRequest.baseSha).toBe(head);
    expect(submitted.changeRequest.baseBranch).toBe('main');
    expect(submitted.changeRequest.verificationCommands).toEqual(['npm run typecheck', 'npm test']);
    expect(submitted.changeRequest.externalSpendPolicy).toBe('PROHIBITED');
  });

  it('makes one change request and one campaign out of a duplicate submission', async () => {
    const first = await submitObjective({
      projectId: fixture.project.id,
      objective: 'Exactly the same ask, submitted twice by a person in a hurry.',
      expectedOutcome: 'One campaign.',
      acceptanceConditions: [{ statement: 'one campaign exists', verification: 'count them' }],
      repositoryRoot: repoRoot,
    });
    const second = await submitObjective({
      projectId: fixture.project.id,
      // Whitespace and case differ; the ask does not.
      objective: '  Exactly the SAME ask, submitted twice by a person in a hurry.  ',
      expectedOutcome: 'One campaign.',
      acceptanceConditions: [{ statement: 'one campaign exists', verification: 'count them' }],
      repositoryRoot: repoRoot,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.changeRequest.id).toBe(first.changeRequest.id);

    const one = await ensureCampaign({
      changeRequestId: first.changeRequest.id,
      projectId: fixture.project.id,
      baseSha: first.changeRequest.baseSha,
      laneTarget: 3,
      laneTargetReason: 'initial',
    });
    const two = await ensureCampaign({
      changeRequestId: second.changeRequest.id,
      projectId: fixture.project.id,
      baseSha: second.changeRequest.baseSha,
      laneTarget: 3,
      laneTargetReason: 'initial',
    });
    expect(one.created).toBe(true);
    expect(two.created).toBe(false);
    expect(two.campaign.id).toBe(one.campaign.id);
    // The branch comes from the campaign's own id, so two campaigns can never
    // collide on one — which they did when it was a truncated submission key.
    expect(one.campaign.integrationBranch).toBe(`factory/campaign/${one.campaign.id}`);
  });

  it('refuses to approve an objective whose success is undefined', async () => {
    const submitted = await submitObjective({
      projectId: fixture.project.id,
      objective: 'Do something worthwhile to the repository.',
      expectedOutcome: 'Something is different.',
      repositoryRoot: repoRoot,
    });
    const approved = await approveObjective({
      changeRequestId: submitted.changeRequest.id,
      via: 'PERSON',
      userId: approverId,
    });
    expect(approved.ok).toBe(false);
    expect(approved.reason).toMatch(/no acceptance conditions/i);
  });

  it('refuses a factory amendment to what success means, and records a permitted one', async () => {
    const changeRequest = await approvedChangeRequest();

    const refused = await amendContract({
      changeRequestId: changeRequest.id,
      campaignId: null,
      field: 'acceptance_conditions',
      newValue: [],
      reason: 'they were inconvenient',
      actorType: 'FACTORY',
      actorId: null,
      affectedWork: [],
    });
    expect(refused.ok).toBe(false);

    const widened = await amendContract({
      changeRequestId: changeRequest.id,
      campaignId: null,
      field: 'mutation_scope',
      newValue: ['**', '../elsewhere/**'],
      reason: 'it needed more reach',
      actorType: 'FACTORY',
      actorId: null,
      affectedWork: [],
    });
    expect(widened.ok).toBe(false);

    const narrowed = await amendContract({
      changeRequestId: changeRequest.id,
      campaignId: null,
      field: 'mutation_scope',
      newValue: ['src/**'],
      reason: 'the objective only needs src',
      actorType: 'FACTORY',
      actorId: null,
      affectedWork: [],
    });
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) {
      expect(narrowed.amendment.oldValue).toContain('**');
      expect(narrowed.amendment.newValue).toContain('src/**');
      expect(narrowed.amendment.toContractVersion).toBe(2);
    }
  });
});

describe('the planner', () => {
  it('refuses a plan that invents a command, climbs out of scope, or has a cycle', async () => {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const validation = validatePlan(
      {
        units: [
          {
            key: 'one',
            kind: 'IMPLEMENTATION',
            title: 'one',
            objective: 'Change the first file so that the campaign objective is satisfied.',
            acceptance: ['it changed'],
            ownedPaths: ['src/one.txt'],
            requiredContext: [],
            verification: ['rm -rf /'],
            expectedArtifact: 'a commit',
            risk: 'LOW',
            criticalPath: false,
            modelClass: 'FAST',
            dependsOn: ['two'],
            serves: ['A01'],
          },
          {
            key: 'two',
            kind: 'IMPLEMENTATION',
            title: 'two',
            objective: 'Change a file somewhere else entirely, which is out of scope here.',
            acceptance: ['it changed'],
            ownedPaths: ['server/secret.ts'],
            requiredContext: [],
            verification: [],
            expectedArtifact: 'a commit',
            risk: 'LOW',
            criticalPath: false,
            modelClass: 'FAST',
            dependsOn: ['one'],
            serves: [],
            sneakyExtraField: true,
          },
        ],
      },
      changeRequest,
    );
    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toMatch(/not one of the repository's verification commands/);
    expect(validation.errors.join('\n')).toMatch(/outside the approved mutation scope/);
    expect(validation.errors.join('\n')).toMatch(/unknown field/);
    expect(validation.errors.join('\n')).toMatch(/cycle/);
  });

  it('installs a graph, reports overlap, and promotes only what is unblocked', async () => {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 3,
      laneTargetReason: 'initial',
    });

    const validation = validatePlan(
      {
        units: [
          {
            key: 'interface',
            kind: 'INTERFACE',
            title: 'shared interface',
            objective: 'Establish the shared shape both implementations will build behind.',
            acceptance: ['the interface exists'],
            ownedPaths: ['src/shared.txt'],
            requiredContext: [],
            verification: ['npm run typecheck'],
            expectedArtifact: 'a file',
            risk: 'LOW',
            criticalPath: true,
            modelClass: 'STRONGEST',
            dependsOn: [],
            serves: ['A01'],
          },
          {
            key: 'impl-a',
            kind: 'IMPLEMENTATION',
            title: 'first implementation',
            objective: 'Implement the first half behind the interface that was just established.',
            acceptance: ['it works'],
            ownedPaths: ['src/one.txt'],
            requiredContext: [],
            verification: [],
            expectedArtifact: 'a commit',
            risk: 'LOW',
            criticalPath: false,
            modelClass: 'FAST',
            dependsOn: ['interface'],
            serves: ['A01'],
          },
          {
            key: 'impl-b',
            kind: 'IMPLEMENTATION',
            title: 'second implementation',
            objective: 'Implement the second half behind the interface that was established.',
            acceptance: ['it works'],
            ownedPaths: ['src/two.txt'],
            requiredContext: [],
            verification: [],
            expectedArtifact: 'a commit',
            risk: 'LOW',
            criticalPath: false,
            modelClass: 'FAST',
            dependsOn: ['interface'],
            serves: ['A01'],
          },
        ],
      },
      changeRequest,
    );
    expect(validation.ok).toBe(true);
    expect(validation.uncoveredConditions).toEqual([]);

    const installed = await installPlan(campaign.id, validation.units);
    expect(installed.created).toBe(3);
    expect(installed.cycle).toBeNull();
    // Only the interface is unblocked; the two implementations wait for it to be
    // integrated rather than merely implemented.
    expect(installed.promoted).toBe(1);

    const again = await installPlan(campaign.id, validation.units);
    expect(again.created).toBe(0);
    expect(again.existing).toBe(3);
  });
});

describe('claiming', () => {
  async function campaignWithUnits(): Promise<{ campaignId: string; unitIds: string[] }> {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 3,
      laneTargetReason: 'initial',
    });
    const first = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'alpha',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'alpha',
      objective: 'alpha',
      acceptance: ['a'],
      ownedPaths: ['src/one.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    const second = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'beta',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'beta',
      objective: 'beta',
      acceptance: ['b'],
      // Deliberately overlapping with alpha's surface.
      ownedPaths: ['src/**'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    return { campaignId: campaign.id, unitIds: [first.unit.id, second.unit.id] };
  }

  it('lets exactly one of two claimants win the same unit', async () => {
    const { campaignId, unitIds } = await campaignWithUnits();
    const [left, right] = await Promise.all([
      claimUnits({ campaignId, workerId: 'w1', unitIds: [unitIds[0] ?? ''], limit: 1 }),
      claimUnits({ campaignId, workerId: 'w2', unitIds: [unitIds[0] ?? ''], limit: 1 }),
    ]);
    expect(left.length + right.length).toBe(1);
    const winner = [...left, ...right][0];
    expect(winner?.attempt).toBe(1);
    expect(winner?.leaseGeneration).toBe(1);
  });

  it('never leases two units whose mutation surfaces overlap', async () => {
    const { campaignId, unitIds } = await campaignWithUnits();
    const first = await claimUnits({ campaignId, workerId: 'w1', unitIds: [unitIds[0] ?? ''] });
    expect(first.length).toBe(1);

    const skips: string[] = [];
    const second = await claimUnits({
      campaignId,
      workerId: 'w2',
      unitIds: [unitIds[1] ?? ''],
      onSkip: (_unit, reason) => skips.push(reason),
    });
    expect(second.length).toBe(0);
    expect(skips.join(' ')).toMatch(/overlaps/);
  });

  it('treats an expired lease as claimable work, and credits the takeover', async () => {
    const { campaignId, unitIds } = await campaignWithUnits();
    const claimed = await claimUnits({
      campaignId,
      workerId: 'w1',
      unitIds: [unitIds[0] ?? ''],
      leaseMs: 30_000,
    });
    expect(claimed.length).toBe(1);

    // Expire it the way time would.
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(`UPDATE factory_work_units SET lease_expires_at = ? WHERE id = ?`, [
      plusMs(factoryNow(), -60_000),
      unitIds[0] ?? '',
    ]);

    const takeover = await claimUnits({ campaignId, workerId: 'w2', unitIds: [unitIds[0] ?? ''] });
    expect(takeover.length).toBe(1);
    expect(takeover[0]?.takeoverFrom).toBe('w1');
    expect(takeover[0]?.attempt).toBe(2);

    // The first worker comes back holding the old generation and matches nothing.
    const fenced = await markImplemented(
      {
        unitId: unitIds[0] ?? '',
        workerId: 'w1',
        leaseId: claimed[0]?.leaseId ?? '',
        leaseGeneration: claimed[0]?.leaseGeneration ?? 0,
      },
      {
        branch: 'b',
        headSha: 'deadbeef',
        baseSha: 'cafe',
        worktreePath: null,
        workerSummary: 'I finished',
        terminalResult: null,
      },
    );
    expect(fenced.ok).toBe(false);
  });

  it('refunds the attempt a provider refusal spent', async () => {
    const { campaignId, unitIds } = await campaignWithUnits();
    const claimed = await claimUnits({ campaignId, workerId: 'w1', unitIds: [unitIds[0] ?? ''] });
    const taken = claimed[0];
    expect(taken?.attempt).toBe(1);

    const until = plusMs(factoryNow(), 60_000);
    const deferred = await deferUnit(
      {
        unitId: taken?.unit.id ?? '',
        workerId: 'w1',
        leaseId: taken?.leaseId ?? '',
        leaseGeneration: taken?.leaseGeneration ?? 0,
      },
      until,
      'the provider refused the session',
    );
    expect(deferred.ok).toBe(true);
    expect(await refundAttempt(taken?.unit.id ?? '', 1)).toBe(true);

    const unit = await getUnit(taken?.unit.id ?? '');
    expect(unit?.attempt).toBe(0);
    expect(unit?.state).toBe('READY');
    expect(unit?.notBefore).toBe(until);

    // Deferred work is not claimable work, and that is not a failure.
    const again = await claimUnits({ campaignId, workerId: 'w2', unitIds: [taken?.unit.id ?? ''] });
    expect(again.length).toBe(0);
  });

  it('keeps failure history across attempts and retires an exhausted unit', async () => {
    const { campaignId, unitIds } = await campaignWithUnits();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimUnits({ campaignId, workerId: 'w1', unitIds: [unitIds[0] ?? ''] });
      expect(claimed.length).toBe(1);
      await failUnit(
        {
          unitId: unitIds[0] ?? '',
          workerId: 'w1',
          leaseId: claimed[0]?.leaseId ?? '',
          leaseGeneration: claimed[0]?.leaseGeneration ?? 0,
        },
        { category: 'NO_CHANGE_PRODUCED', detail: `attempt ${attempt} produced nothing`, retryable: true },
      );
    }
    const unit = await getUnit(unitIds[0] ?? '');
    expect(unit?.state).toBe('FAILED');
    expect(unit?.attempt).toBe(3);
    const fourth = await claimUnits({ campaignId, workerId: 'w1', unitIds: [unitIds[0] ?? ''] });
    expect(fourth.length).toBe(0);
  });

  it('lets one dispatcher hold the campaign tick', async () => {
    const { campaignId } = await campaignWithUnits();
    const [a, b] = await Promise.all([
      claimCampaignTick(campaignId, 'd1'),
      claimCampaignTick(campaignId, 'd2'),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
  });
});

describe('checkpoints', () => {
  it('hands the newest investigation to whoever resumes', async () => {
    const changeRequest = await approvedChangeRequest();
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'resumable',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'resumable',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/**'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    await recordCheckpoint({
      campaignId: campaign.id,
      unitId: unit.id,
      attempt: 1,
      sessionId: 's1',
      workerId: 'w1',
      established: 'the parser is the problem',
      commits: ['abc123'],
      testsRun: ['npm run typecheck'],
      unresolved: 'the second branch still throws',
      nextAction: 'handle the empty case in parse()',
    });
    await recordCheckpoint({
      campaignId: campaign.id,
      unitId: unit.id,
      attempt: 2,
      sessionId: 's2',
      workerId: 'w2',
      established: 'the empty case is handled',
      commits: ['def456'],
      testsRun: ['npm test'],
      unresolved: '',
      nextAction: '',
    });
    const latest = await latestCheckpoint(unit.id);
    expect(latest?.attempt).toBe(2);
    expect(latest?.established).toContain('empty case');
  });
});

describe('ownership and integration', () => {
  it('matches globs the way a unit owner would expect', () => {
    expect(matchesGlob('server/services/factory/loop.ts', 'server/services/factory/**')).toBe(true);
    expect(matchesGlob('server/services/factory', 'server/services/factory/**')).toBe(true);
    expect(matchesGlob('server/repos/factory.ts', 'server/services/factory/**')).toBe(false);
    expect(matchesGlob('src/one.txt', 'src/*.txt')).toBe(true);
    expect(matchesGlob('src/deep/one.txt', 'src/*.txt')).toBe(false);
    expect(matchesGlob('anything/at/all', '**')).toBe(true);
  });

  it('sees the overlap two units would fight over', () => {
    expect(pathsOverlap(['server/services/factory/**'], ['server/services/factory/loop.ts'])).toBe(true);
    expect(pathsOverlap(['server/repos/factory.ts'], ['server/services/factory/**'])).toBe(false);
  });

  it('rejects a diff that reached outside the unit, whole', async () => {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'narrow',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'narrow',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/one.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });

    // A worker that wrote outside its own surface.
    const worktreePath = path.join(os.tmpdir(), `factory-wt-${Date.now()}`);
    const branch = 'factory/test/wide';
    await ensureWorktree(repoRoot, { path: worktreePath, branch, baseSha: changeRequest.baseSha });
    fs.writeFileSync(path.join(worktreePath, 'src', 'one.txt'), 'changed\n');
    fs.writeFileSync(path.join(worktreePath, 'src', 'two.txt'), 'also changed\n');
    const head = await commitAll(worktreePath, 'touch both files');
    expect(head).toBeTruthy();

    const claimed = await claimUnits({ campaignId: campaign.id, workerId: 'w1', unitIds: [unit.id] });
    await markImplemented(
      {
        unitId: unit.id,
        workerId: 'w1',
        leaseId: claimed[0]?.leaseId ?? '',
        leaseGeneration: claimed[0]?.leaseGeneration ?? 0,
      },
      {
        branch,
        headSha: head ?? '',
        baseSha: changeRequest.baseSha,
        worktreePath,
        workerSummary: 'did the thing',
        terminalResult: null,
      },
    );

    const fresh = (await listUnits(campaign.id))[0];
    expect(fresh?.state).toBe('IMPLEMENTED');
    const result = await integrateUnit({
      repoRoot,
      campaign,
      changeRequest,
      unit: fresh ?? unit,
    });
    expect(result.outcome).toBe('REJECTED');
    expect(result.rejectedPaths).toContain('src/two.txt');
    const after = await getUnit(unit.id);
    expect(after?.failureCategory).toBe('OUT_OF_SCOPE_MUTATION');
    expect(after?.state).toBe('READY');
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it('merges a diff that stayed inside the unit, and unblocks what waited on it', async () => {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    const first = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'first',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'first',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/one.txt'],
      requiredContext: [],
      verification: ['npm run typecheck'],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    const second = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'second',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'second',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/two.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
    });
    await addDependency(campaign.id, second.unit.id, first.unit.id, 'second needs first');
    await promoteReadyUnits(campaign.id);
    expect((await getUnit(second.unit.id))?.state).toBe('BLOCKED');

    const worktreePath = path.join(os.tmpdir(), `factory-wt-ok-${Date.now()}`);
    const branch = 'factory/test/narrow';
    await ensureWorktree(repoRoot, { path: worktreePath, branch, baseSha: changeRequest.baseSha });
    fs.writeFileSync(path.join(worktreePath, 'src', 'one.txt'), 'the new text\n');
    const head = await commitAll(worktreePath, 'change only what I own');

    const claimed = await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [first.unit.id],
    });
    await markImplemented(
      {
        unitId: first.unit.id,
        workerId: 'w1',
        leaseId: claimed[0]?.leaseId ?? '',
        leaseGeneration: claimed[0]?.leaseGeneration ?? 0,
      },
      {
        branch,
        headSha: head ?? '',
        baseSha: changeRequest.baseSha,
        worktreePath,
        workerSummary: 'changed one file',
        terminalResult: null,
      },
    );

    const unit = await getUnit(first.unit.id);
    const result = await integrateUnit({ repoRoot, campaign, changeRequest, unit: unit! });
    expect(result.outcome).toBe('MERGED');
    expect(result.verification.every((entry) => entry.exitCode === 0)).toBe(true);
    expect((await getUnit(first.unit.id))?.state).toBe('INTEGRATED');
    // Integration, not implementation, is what unblocks downstream work.
    expect((await getUnit(second.unit.id))?.state).toBe('READY');

    // A redelivered integration does not produce a second merge commit.
    const refreshed = (await import('../server/repos/factory.ts')).getCampaign;
    const campaignNow = await refreshed(campaign.id);
    const again = await integrateUnit({
      repoRoot,
      campaign: campaignNow!,
      changeRequest,
      unit: (await getUnit(first.unit.id))!,
    });
    expect(again.outcome).toBe('ALREADY_MERGED');
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });
});

describe('independent review', () => {
  it('refuses the session that wrote the code, and never rounds a tier up', () => {
    const implementers = [{ sessionId: 's1', workerId: 'w1', accountRef: 'a1' }];
    expect(decideIndependence({ sessionId: 's1', workerId: 'w1', accountRef: 'a1' }, implementers)).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(
      decideIndependence({ sessionId: 's2', workerId: 'w1', accountRef: 'a1' }, implementers),
    ).toEqual(expect.objectContaining({ ok: true, tier: 'SESSION_SEPARATED' }));
    expect(
      decideIndependence({ sessionId: 's2', workerId: 'w2', accountRef: 'a1' }, implementers),
    ).toEqual(expect.objectContaining({ ok: true, tier: 'WORKER_SEPARATED' }));
    expect(
      decideIndependence({ sessionId: 's2', workerId: 'w2', accountRef: 'a2' }, implementers),
    ).toEqual(expect.objectContaining({ ok: true, tier: 'ACCOUNT_SEPARATED' }));
    // A predicted session is allocator reasoning, not evidence.
    expect(
      decideIndependence({ sessionId: 'future:w9', workerId: 'w9', accountRef: 'a9' }, implementers),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it('reads a verdict exactly, or refuses to read one at all', () => {
    expect(parseReview('I think it basically passes.').ok).toBe(false);
    expect(parseReview('```factory-review\n{"verdict":"looks fine"}\n```').ok).toBe(false);
    expect(
      parseReview(
        '```factory-review\n{"verdict":"PASS","summary":"ok","findings":[' +
          '{"key":"k","severity":"BLOCKER","statement":"this is broken badly","evidence":"x.ts:1"}]}\n```',
      ).ok,
    ).toBe(false);
    const good = parseReview(
      '```factory-review\n{"verdict":"CHANGES_REQUIRED","summary":"one defect",' +
        '"findings":[{"key":"No Caller!","severity":"MAJOR","category":"dead-code",' +
        '"statement":"nothing calls the new function","evidence":"server/x.ts:10",' +
        '"acceptanceConditionId":"A01","suggestedPaths":["server/x.ts"]}]}\n```',
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.review.verdict).toBe('CHANGES_REQUIRED');
      expect(good.review.findings[0]?.key).toBe('no-caller');
      expect(good.review.findings[0]?.suggestedPaths).toEqual(['server/x.ts']);
    }
  });

  it('refuses a finding with no evidence', () => {
    const parsed = parseReview(
      '```factory-review\n{"verdict":"CHANGES_REQUIRED","findings":[' +
        '{"key":"vibes","severity":"MAJOR","statement":"this feels wrong to me"}]}\n```',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/no evidence/);
  });
});

describe('the scheduler', () => {
  const slot = (over: Partial<Parameters<typeof chooseWorker>[1][number]> = {}) => ({
    workerId: 'w1',
    name: 'w1',
    kind: 'LOCAL_CLI' as const,
    accountRef: 'a1',
    model: 'sonnet',
    modelClass: 'FAST' as const,
    capabilities: ['IMPLEMENT' as const],
    freeSlots: 1,
    running: 0,
    availability: 'AVAILABLE' as const,
    rateLimitedUntil: null,
    ...over,
  });

  const unit = (over: Partial<Parameters<typeof decide>[0]['candidates'][number]> = {}) => ({
    id: 'u1',
    unitKey: 'u1',
    kind: 'IMPLEMENTATION' as const,
    role: 'IMPLEMENTER' as const,
    modelClass: 'FAST' as const,
    ownedPaths: ['src/one.txt'],
    criticalPath: false,
    downstreamCount: 0,
    priority: 5,
    risk: 'LOW' as const,
    attempt: 0,
    maxAttempts: 3,
    ...over,
  });

  const evidence = {
    firstPassSuccessRate: null,
    overlapRefusals: 0,
    rateLimitedSessions: 0,
    maxObservedConcurrency: 0,
    mergedUnits: 0,
    failedUnits: 0,
  };

  it('fills as many independent lanes as the graph and the fleet allow', () => {
    const decision = decide({
      at: factoryNow(),
      campaignId: 'c1',
      laneTarget: 3,
      candidates: [
        unit({ id: 'a', unitKey: 'a', ownedPaths: ['src/a/**'] }),
        unit({ id: 'b', unitKey: 'b', ownedPaths: ['src/b/**'] }),
        unit({ id: 'c', unitKey: 'c', ownedPaths: ['src/c/**'] }),
      ],
      live: [],
      slots: [slot({ workerId: 'w1', name: 'w1', freeSlots: 2 }), slot({ workerId: 'w2', name: 'w2', freeSlots: 2 })],
      evidence,
      implementedBy: {},
    });
    expect(decision.assignments.length).toBe(3);
    // Spread rather than stacked on one worker.
    expect(new Set(decision.assignments.map((a) => a.workerId)).size).toBe(2);
  });

  it('serialises overlapping work instead of launching a lane onto it', () => {
    const decision = decide({
      at: factoryNow(),
      campaignId: 'c1',
      laneTarget: 3,
      candidates: [unit({ id: 'a', unitKey: 'a', ownedPaths: ['src/shared/**'] })],
      live: [{ unitId: 'z', workerId: 'w9', ownedPaths: ['src/shared/thing.ts'] }],
      slots: [slot({ freeSlots: 4 })],
      evidence,
      implementedBy: {},
    });
    expect(decision.assignments.length).toBe(0);
    expect(decision.refusals[0]?.reason).toMatch(/overlaps/);
  });

  it('says so when there is nowhere to run, in the words the remedy uses', () => {
    const decision = decide({
      at: factoryNow(),
      campaignId: 'c1',
      laneTarget: 3,
      candidates: [unit()],
      live: [],
      slots: [],
      evidence,
      implementedBy: {},
    });
    expect(decision.assignments.length).toBe(0);
    expect(decision.refusals[0]?.reason).toMatch(/NO_HEALTHY_EXECUTION_SURFACE/);
  });

  it('lowers the lane target on a provider refusal and raises it on clean throughput', () => {
    const lowered = tuneLaneTarget(4, { ...evidence, rateLimitedSessions: 2 }, 8, 8);
    expect(lowered.target).toBe(3);
    expect(lowered.reason).toMatch(/provider refusal/);

    const raised = tuneLaneTarget(
      3,
      { ...evidence, firstPassSuccessRate: 0.9, mergedUnits: 5 },
      6,
      6,
    );
    expect(raised.target).toBe(4);

    const held = tuneLaneTarget(3, evidence, 1, 1);
    expect(held.target).toBe(3);
    expect(held.reason).toMatch(/unchanged/);
  });

  it('prefers the strongest model for a reviewer and a worker that did not implement', () => {
    const chosen = chooseWorker(unit({ role: 'REVIEWER' }), [
      slot({ workerId: 'impl', name: 'impl', capabilities: ['IMPLEMENT', 'REVIEW'], modelClass: 'FAST' }),
      slot({ workerId: 'fresh', name: 'fresh', capabilities: ['REVIEW'], modelClass: 'STRONGEST' }),
    ], { preferNotWorkers: ['impl'] });
    expect(chosen.slot?.workerId).toBe('fresh');
  });
});

describe('metrics', () => {
  it('reports the concurrency that genuinely overlapped, never the declared sum', () => {
    expect(
      maxOverlap([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 12, end: 20 },
      ]),
    ).toBe(2);
    // Two sessions that merely touched were not concurrent.
    expect(
      maxOverlap([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]),
    ).toBe(1);
    expect(maxOverlap([])).toBe(0);
  });

  it('counts an unmeasured fleet as unknown rather than as zero', () => {
    const metrics = computeMetrics({
      campaignId: 'c1',
      units: [],
      sessions: [],
      integrations: [],
      events: [],
      reviews: [],
      findings: [],
    });
    expect(metrics.concurrencyEvidence).toBe('UNKNOWN');
    expect(metrics.firstPassSuccessRate).toBeNull();
  });
});

describe('worker reports', () => {
  it('reads the last block a worker wrote, and survives one it could not write', () => {
    const report = parseWorkerReport(
      'Some prose.\n```factory-report\n{"summary":"first"}\n```\nmore\n' +
        '```factory-report\n{"summary":"second","commits":["abc"],"blocked":false}\n```',
    );
    expect(report?.summary).toBe('second');
    expect(report?.commits).toEqual(['abc']);
    expect(parseWorkerReport('no block at all')).toBeNull();
  });
});

describe('repairs', () => {
  it('closes a finding when its repair integrated, and leaves one whose repair failed open', async () => {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 2,
      laneTargetReason: 'initial',
    });
    const stored = await recordReview({
      campaignId: campaign.id,
      round: 1,
      scope: 'CAMPAIGN',
      reviewerSessionId: null,
      reviewedSha: 'a'.repeat(40),
      verdict: 'CHANGES_REQUIRED',
      summary: 'two defects',
      independence: 'WORKER_SEPARATED',
      findings: [
        {
          key: 'fixed-one',
          severity: 'MAJOR',
          category: 'correctness',
          statement: 'the first defect, which a repair will fix',
          evidence: 'src/one.txt:1',
        },
        {
          key: 'stuck-one',
          severity: 'MAJOR',
          category: 'correctness',
          statement: 'the second defect, whose repair will run out of attempts',
          evidence: 'src/two.txt:1',
        },
      ],
    });
    expect(stored.findings.length).toBe(2);

    const queued = await queueRepairs(campaign, changeRequest);
    expect(queued.queued.length).toBe(2);
    // A second pass queues nothing: one finding, one repair.
    expect((await queueRepairs(campaign, changeRequest)).queued.length).toBe(0);

    const repairs = (await listUnits(campaign.id)).filter((unit) => unit.kind === 'REPAIR');
    expect(repairs.length).toBe(2);
    const landed = repairs.find((unit) => unit.unitKey.includes('fixed-one'));
    const stuck = repairs.find((unit) => unit.unitKey.includes('stuck-one'));

    // One repair integrates; the other spends every attempt.
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(`UPDATE factory_work_units SET state = 'INTEGRATED' WHERE id = ?`, [
      landed?.id ?? '',
    ]);
    await getDb().run(
      `UPDATE factory_work_units SET state = 'FAILED', attempt = max_attempts WHERE id = ?`,
      [stuck?.id ?? ''],
    );

    const reconciled = await reconcileRepairs(campaign.id);
    expect(reconciled.repaired).toBe(1);
    expect(reconciled.exhausted.length).toBe(1);

    const findings = await listFindings(campaign.id);
    expect(findings.find((f) => f.findingKey === 'fixed-one')?.state).toBe('REPAIRED');
    // A defect nobody fixed is not a defect that went away.
    expect(findings.find((f) => f.findingKey === 'stuck-one')?.state).toBe('REPAIR_QUEUED');
    expect((await gatingFindings(campaign.id)).map((f) => f.findingKey)).toEqual(['stuck-one']);
  });
});

describe('recovery', () => {
  it('frees the phantom capacity a dead dispatcher left behind', async () => {
    const changeRequest = await approvedChangeRequest({ mutationScope: ['src/**'] });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 2,
      laneTargetReason: 'initial',
    });
    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'orphaned',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'orphaned',
      objective: 'o',
      acceptance: ['a'],
      ownedPaths: ['src/one.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });

    const claimed = await claimUnits({ campaignId: campaign.id, workerId: 'w1', unitIds: [unit.id] });
    expect(claimed.length).toBe(1);
    const session = await openSession({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: 'w1',
      accountRef: 'a1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'sonnet',
    });
    // While the unit is genuinely leased, the session is real work and the slot
    // it holds is really held.
    expect(await abandonOrphanedSessions()).toBe(0);
    expect((await workerLoad()).get('w1')).toBe(1);

    // The dispatcher dies: the lease expires and is reclaimed, and nothing closes
    // the session. Without this, `workerLoad` counts it forever.
    await failUnit(
      {
        unitId: unit.id,
        workerId: 'w1',
        leaseId: claimed[0]?.leaseId ?? '',
        leaseGeneration: claimed[0]?.leaseGeneration ?? 0,
      },
      { category: 'WORKER_LOST', detail: 'the dispatcher died', retryable: true },
    );
    expect(await abandonOrphanedSessions()).toBe(1);
    expect((await workerLoad()).get('w1')).toBeUndefined();
    const sessions = await listSessions(campaign.id);
    expect(sessions.find((s) => s.id === session.id)?.state).toBe('ABANDONED');
    // The row stays, with a reason. Nothing is deleted.
    expect(sessions.length).toBe(1);
  });
});

describe('the registry', () => {
  it('keeps a credential out of the row it is registered against', async () => {
    const { worker } = await registerWorker({
      name: 'probe-worker',
      kind: 'LOCAL_CLI',
      accountRef: 'a1',
      model: 'sonnet',
      capabilities: ['IMPLEMENT'],
      repositories: ['*'],
      credentialRef: 'BRAIN_FACTORY_SECRET',
      credentialValue: 'super-secret-value',
    });
    expect(worker.credentialRef).toBe('BRAIN_FACTORY_SECRET');
    expect(worker.credentialDigest).toHaveLength(64);
    expect(JSON.stringify(worker)).not.toContain('super-secret-value');
  });
});

describe('approval', () => {
  it('stamps an approval once', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'once',
      objective: 'Approve me exactly one time.',
      expectedOutcome: 'One approval.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'it happened', verification: 'look', mandatory: true },
      ],
      repository: repoRoot,
      baseBranch: 'main',
      baseSha: await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']),
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['src/**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline the pull request',
      verificationCommands: [],
    });
    expect(await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: null, authorityId: null })).toBe(true);
    expect(await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: null, authorityId: null })).toBe(false);
  });
});

describe('cycles', () => {
  it('finds a cycle in installed rows, not only in a proposed plan', async () => {
    const changeRequest = await approvedChangeRequest();
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    const a = await ensureUnit({
      campaignId: campaign.id, unitKey: 'a', kind: 'IMPLEMENTATION', role: 'IMPLEMENTER',
      title: 'a', objective: 'a', acceptance: ['a'], ownedPaths: ['src/a'],
      requiredContext: [], verification: [], expectedArtifact: 'x',
    });
    const b = await ensureUnit({
      campaignId: campaign.id, unitKey: 'b', kind: 'IMPLEMENTATION', role: 'IMPLEMENTER',
      title: 'b', objective: 'b', acceptance: ['b'], ownedPaths: ['src/b'],
      requiredContext: [], verification: [], expectedArtifact: 'x',
    });
    await addDependency(campaign.id, a.unit.id, b.unit.id);
    await addDependency(campaign.id, b.unit.id, a.unit.id);
    expect(await findDependencyCycle(campaign.id)).not.toBeNull();
    expect(await listFindings(campaign.id)).toEqual([]);
  });
});
