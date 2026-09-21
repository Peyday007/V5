/**
 * Where a blocked campaign resumes, and why that is a question about rows.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists for
 * ---------------------------------------------------------------------------
 *
 * `NO_HEALTHY_EXECUTION_SURFACE` is raised from two places.
 * `planningStage` raises it when no free slot holds `ARCHITECT`, and the
 * campaign then has **no units at all**; execution raises it when there is
 * nothing to run an already-planned unit on. `unblockStage` resumed both into
 * `EXECUTING`, which is right for the second and wrong for the first.
 *
 * What the first one then did, observed by running it rather than by reading
 * it: a campaign with nothing planned walked `EXECUTING` → `INTEGRATING` →
 * `REVIEWING` on an empty diff and stopped at
 *
 *     UNIT_EXHAUSTED_ATTEMPTS: Nothing was integrated, so there is no change to
 *     review. A campaign with an empty diff has not produced software.
 *
 * Every word of which is true, and the diagnosis is wrong. Nothing was
 * integrated because nothing was ever *planned*, and an operator reading it
 * goes looking at attempts on units that do not exist. §27's own sentence: **a
 * warning that cries wolf is worse than no warning**, because it teaches a
 * reader to stop believing the one place that says a campaign is genuinely
 * stuck.
 *
 * The remedy is derived from the rows — a campaign with no units belongs in
 * `PLANNING` whatever took it out — rather than from a stored memory of which
 * stage blocked, which would be a second copy of a fact the units already
 * carry.
 *
 * Both halves are asserted, because a fix that sent *every* resume back to
 * planning would re-plan a campaign whose units are half integrated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  getCampaign,
  patchCampaign,
} from '../server/repos/factory.ts';
import { register } from '../server/services/factory/registry.ts';
import { approveObjective } from '../server/services/factory/contract.ts';
import { createUser } from '../server/repos/identity.ts';
import { tickCampaign } from '../server/services/factory/loop.ts';
import { run } from '../server/services/factory/git.ts';
import type { FactoryCampaign, FactoryChangeRequest } from '../server/domain/factory.ts';

let fixture: TestProject;
let repoRoot = '';

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'subject' }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'one.txt'), 'one\n');
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'unblock@test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Unblock Test'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
  return `${root}\u0000${head.stdout.trim()}`;
}

beforeEach(async () => {
  fixture = await freshProject();
  repoRoot = await makeRepository();
});

afterEach(async () => {
  await teardown();
  const [root] = repoRoot.split('\u0000');
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function blockedCampaign(): Promise<{
  campaign: FactoryCampaign;
  changeRequest: FactoryChangeRequest;
  root: string;
}> {
  const [root, head] = repoRoot.split('\u0000') as [string, string];
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `unblock-${Math.random().toString(36).slice(2)}`,
    objective: 'Prove a blocked campaign resumes where the work is.',
    expectedOutcome: 'The stage it resumes into matches what the rows say.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'it resumes correctly', verification: 'npm test', mandatory: true },
    ],
    repository: root,
    baseBranch: 'main',
    baseSha: head,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['src/**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'revert the branch',
    verificationCommands: [],
  });
  /*
   * Approved, because an unapproved objective is refused before `unblockStage`
   * is ever reached — the contract check runs first, and rightly: a campaign
   * cannot run against an objective nobody has frozen. Without this the suite
   * would assert on a refusal about approval while claiming to be about where a
   * blocked campaign resumes.
   */
  const approver = await createUser({
    email: `unblock-${Math.random().toString(36).slice(2, 10)}@test.local`,
    displayName: 'The approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  const approved = await approveObjective({
    changeRequestId: changeRequest.id,
    via: 'PERSON',
    userId: approver.id,
  });
  expect(approved.ok).toBe(true);

  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: head,
    laneTarget: 1,
    laneTargetReason: 'initial',
  });
  await patchCampaign(campaign.id, {
    state: 'BLOCKED',
    blockerKind: 'NO_HEALTHY_EXECUTION_SURFACE',
    blockerDetail: 'no free slot holds ARCHITECT',
  });
  const blocked = await getCampaign(campaign.id);
  return { campaign: blocked!, changeRequest, root };
}

describe('a campaign blocked for want of a surface', () => {
  it('resumes into PLANNING when nothing has been planned', async () => {
    const { campaign } = await blockedCampaign();

    // A surface exists again. This is the condition the blocker was waiting on.
    await register({
      name: `architect-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'LOCAL_CLI',
      accountRef: 'test',
      model: 'sonnet',
      modelClass: 'FAST',
      capabilities: ['ARCHITECT'],
      repositories: ['*'],
      maxConcurrency: 1,
    });

    /*
     * One tick, and the *stage* is what is asserted rather than what the
     * architect then did — this is about where the campaign was sent, and
     * dispatching a real planning pass is `factory.test.ts`'s business.
     */
    await tickCampaign(campaign.id, { maxDispatch: 0, planInstalled: true });
    const after = await getCampaign(campaign.id);
    expect(after?.state).toBe('PLANNING');
    expect(after?.blockerKind).toBeNull();
  });

  it('resumes into EXECUTING when units are already planned', async () => {
    const { campaign } = await blockedCampaign();
    await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'alpha',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'alpha',
      objective: 'do the thing',
      acceptance: ['it works'],
      ownedPaths: ['src/**'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });

    await register({
      name: `impl-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'LOCAL_CLI',
      accountRef: 'test',
      model: 'sonnet',
      modelClass: 'FAST',
      capabilities: ['IMPLEMENT'],
      repositories: ['*'],
      maxConcurrency: 1,
    });

    await tickCampaign(campaign.id, { maxDispatch: 0, planInstalled: true });
    const after = await getCampaign(campaign.id);
    // A campaign whose units are planned must not be sent back to planning:
    // re-planning work that is half integrated is the opposite defect.
    expect(after?.state).toBe('EXECUTING');
  });

  it('stays blocked while the surface is still missing', async () => {
    const { campaign } = await blockedCampaign();
    await tickCampaign(campaign.id, { maxDispatch: 0, planInstalled: true });
    const after = await getCampaign(campaign.id);
    expect(after?.state).toBe('BLOCKED');
    expect(after?.blockerKind).toBe('NO_HEALTHY_EXECUTION_SURFACE');
  });
});
