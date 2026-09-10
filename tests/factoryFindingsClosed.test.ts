/**
 * The three MINOR findings the bootstrap campaign's round-3 reviewer recorded as
 * limitations rather than repairs, closed — each pinned by the property the fix
 * actually adds, so reverting any one of them fails exactly one test here.
 *
 *   * `throughput-breakdown-omits-queue-time-and-concurrency` — A03 asked for
 *     queue time and maximum concurrency per worker, role and account. Two of
 *     those three figures were campaign-level only, and the per-entry fields did
 *     not exist at all: not even as UNKNOWN, which is the shape this module
 *     already uses for a number nobody measured.
 *   * `pull-request-body-duplicates-assemble-body` — two renderings of one
 *     campaign's pull request, disagreeing about acceptance-condition status and,
 *     with more than one review round, about the verdict.
 *   * `terminal-campaign-worktrees-never-pruned` — a finished campaign keeps a
 *     checkout per attempt forever, because the only callers of recovery could
 *     not see a campaign that was over.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  approveChangeRequest,
  claimUnits,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  factoryNow,
  listTerminalCampaigns,
  markImplemented,
  markIntegrated,
  patchCampaign,
} from '../server/repos/factory.ts';
import { openSession, closeSession, recordReview } from '../server/repos/factoryFleet.ts';
import { throughputReport } from '../server/services/factory/throughput.ts';
import { renderPullRequest } from '../server/services/factory/pullRequest.ts';
import { loadCampaignView } from '../server/services/factory/campaignView.ts';
import { assembleDeliverable } from '../server/services/factory/assemble.ts';
import { recoverAll } from '../server/services/factory/recovery.ts';
import {
  campaignWorkspace,
  ensureWorktree,
  gitOrThrow,
  listWorktrees,
  run,
} from '../server/services/factory/git.ts';
import type { FactoryCampaign, FactoryChangeRequest } from '../server/domain/factory.ts';

let fixture: TestProject;
let repoRoot = '';

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-findings-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'subject' }, null, 2));
  fs.writeFileSync(path.join(root, 'src.txt'), 'one\n');
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Factory Findings Test'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

async function makeApprovedRequest(submissionKey: string): Promise<FactoryChangeRequest> {
  const headSha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey,
    objective: 'Close the findings the reviewer recorded rather than repaired.',
    expectedOutcome: 'Each fix is asserted by something that fails when it is reverted.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'the report carries both figures', verification: 'read the entry', mandatory: true },
      { id: 'A02', statement: 'one renderer serves both readers', verification: 'compare the bodies', mandatory: true },
    ],
    repository: repoRoot,
    baseBranch: 'main',
    baseSha: headSha,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['src.txt'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: ['npm run typecheck'],
  });
  expect(
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: null,
      authorityId: null,
    }),
  ).toBe(true);
  return changeRequest;
}

async function makeCampaign(changeRequest: FactoryChangeRequest): Promise<FactoryCampaign> {
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 2,
    laneTargetReason: 'initial',
  });
  return campaign;
}

beforeEach(async () => {
  fixture = await freshProject();
  repoRoot = await makeRepository();
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('the throughput breakdown carries queue time and concurrency per entry', () => {
  it('measures each subject its own peak overlap and says why queue time is unknown', async () => {
    const changeRequest = await makeApprovedRequest('findings-throughput');
    const campaign = await makeCampaign(changeRequest);

    // Two sessions on one worker that genuinely overlap, and a third that does
    // not. A peak of two is therefore a fact about this worker, and the campaign
    // figure alone could not distinguish it from two workers running once each.
    const overlapping = [
      { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T10:30:00.000Z' },
      { start: '2026-01-01T10:15:00.000Z', end: '2026-01-01T10:45:00.000Z' },
      { start: '2026-01-01T12:00:00.000Z', end: '2026-01-01T12:10:00.000Z' },
    ];
    for (const window of overlapping) {
      const session = await openSession({
        campaignId: campaign.id,
        unitId: null,
        workerId: 'w1',
        accountRef: 'acct-1',
        attempt: 0,
        role: 'IMPLEMENTER',
        model: 'test-model',
      });
      const { getDb } = await import('../server/db/database.ts');
      await getDb().run(`UPDATE factory_sessions SET started_at = ?, ended_at = ? WHERE id = ?`, [
        window.start,
        window.end,
        session.id,
      ]);
      await closeSession(session.id, { state: 'FINISHED', exitReason: 'done' });
      await getDb().run(`UPDATE factory_sessions SET started_at = ?, ended_at = ? WHERE id = ?`, [
        window.start,
        window.end,
        session.id,
      ]);
    }

    const report = await throughputReport(campaign.id);
    const worker = report.perWorker.find((entry) => entry.id === 'w1');
    expect(worker).toBeDefined();
    expect(worker?.maxObservedConcurrency.value).toBe(2);
    expect(worker?.maxObservedConcurrency.evidence).toBe('MEASURED');

    const role = report.perRole.find((entry) => entry.id === 'IMPLEMENTER');
    expect(role?.maxObservedConcurrency.value).toBe(2);
    expect(role?.maxObservedConcurrency.evidence).toBe('MEASURED');

    const account = report.perAccountRef.find((entry) => entry.id === 'acct-1');
    expect(account?.maxObservedConcurrency.value).toBe(2);
    expect(account?.maxObservedConcurrency.evidence).toBe('MEASURED');

    // Queue time is present on every entry and honest on every entry: absent
    // would read as zero, and zero would be a measurement nobody took.
    for (const entry of [worker, role, account]) {
      expect(entry?.queueTime.total.value).toBeNull();
      expect(entry?.queueTime.total.evidence).toBe('UNKNOWN');
      expect(entry?.queueTime.samples.evidence).toBe('UNKNOWN');
      expect(entry?.queueTime.average.evidence).toBe('UNKNOWN');
      expect(entry?.queueTime.total.basis).toContain('queue time');
    }
  });
});

describe('one pull-request rendering, two readers', () => {
  it('the stored artifact and the route agree about acceptance, review and limitations', async () => {
    const changeRequest = await makeApprovedRequest('findings-one-renderer');
    const campaign = await makeCampaign(changeRequest);

    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'alpha',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'alpha',
      objective: 'alpha',
      acceptance: ['it works'],
      ownedPaths: ['src.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    const session = await openSession({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: 'w1',
      accountRef: 'acct-1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'test-model',
    });
    const claimed = await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [unit.id],
      sessionId: session.id,
      leaseMs: 60_000,
    });
    expect(claimed.length).toBe(1);

    // A real commit on a real branch, so the diff half of the body has something
    // to describe rather than being skipped.
    const branch = `factory/${campaign.id}/alpha/a1`;
    const worktree = path.join(campaignWorkspace(campaign.id), 'alpha-a1');
    await ensureWorktree(repoRoot, { branch, path: worktree, baseSha: campaign.baseSha });
    fs.appendFileSync(path.join(worktree, 'src.txt'), 'two\n');
    await run('git', ['add', '-A'], { cwd: worktree });
    await run('git', ['commit', '-m', 'alpha', '--no-verify'], { cwd: worktree });
    const headSha = await gitOrThrow(worktree, ['rev-parse', 'HEAD']);
    const implemented = await markImplemented(
      {
        unitId: unit.id,
        workerId: 'w1',
        leaseId: claimed[0]!.leaseId,
        leaseGeneration: claimed[0]!.leaseGeneration,
      },
      {
        branch,
        headSha,
        baseSha: campaign.baseSha,
        worktreePath: worktree,
        workerSummary: 'alpha landed',
        terminalResult: { produced: true },
      },
    );
    expect(implemented.ok).toBe(true);
    await gitOrThrow(repoRoot, ['branch', campaign.integrationBranch, headSha]);
    expect(await markIntegrated(unit.id, headSha)).toBe(true);
    await patchCampaign(campaign.id, { state: 'ASSEMBLING', integrationSha: headSha });

    // Two rounds, so "the latest review" is a claim that can be got wrong. The
    // old template took the last element of a newest-first list and therefore
    // reported the *older* verdict.
    await recordReview({
      campaignId: campaign.id,
      round: 1,
      scope: 'CAMPAIGN',
      reviewerSessionId: session.id,
      reviewedSha: headSha,
      verdict: 'CHANGES_REQUIRED',
      independence: 'SESSION_SEPARATED',
      summary: 'round one wanted changes',
      findings: [
        {
          key: 'needs-work',
          severity: 'MINOR',
          category: 'test-coverage',
          statement: 'a limitation that is recorded rather than closed',
          evidence: 'the reviewer said so',
          acceptanceConditionId: 'A01',
        },
      ],
    });
    await recordReview({
      campaignId: campaign.id,
      round: 2,
      scope: 'CAMPAIGN',
      reviewerSessionId: session.id,
      reviewedSha: headSha,
      verdict: 'PASS',
      independence: 'WORKER_SEPARATED',
      summary: 'round two passed',
      findings: [],
    });

    const view = await loadCampaignView(campaign.id);
    expect(view).not.toBeNull();
    const routeBody = renderPullRequest(view!).body;

    const assembled = await assembleDeliverable({
      repoRoot,
      campaign: (await loadCampaignView(campaign.id))!.campaign,
      changeRequest,
    });

    // The diff half differs by design — the route has no checkout. Everything a
    // reviewer reads about the *campaign* must not.
    for (const section of [
      '### Acceptance conditions',
      '### Independent review',
      '### Remaining limitations',
    ]) {
      const fromRoute = routeBody.slice(routeBody.indexOf(section)).split('\n###')[0];
      const fromArtifact = assembled.body.slice(assembled.body.indexOf(section)).split('\n###')[0];
      expect(fromArtifact).toBe(fromRoute);
    }

    // And specifically: the newest verdict, and a status on every condition.
    expect(assembled.body).toContain('Round 2: **PASS**');
    expect(assembled.body).not.toContain('Round 1:');
    expect(assembled.body).toMatch(/\*\*A01\*\*.*—/);
    // The limitation the reviewer left open appears as a limitation.
    expect(assembled.body).toContain('needs-work');
    // And the diff half, which only the artifact has.
    expect(assembled.body).toContain('### What landed');
    expect(routeBody).not.toContain('### What landed');
  });
});

describe('a campaign works in the checkout its contract names', () => {
  it('batch recovery prunes a worktree in the target repository with no root supplied', async () => {
    /*
     * The repository the objective is about is not the one the factory lives in,
     * and nothing in this test tells recovery where it is. Before the contract
     * carried the path, `recoverAll()` called without a root had nothing to list
     * worktrees in and quietly pruned nothing — a batch pass that reported
     * success by never looking.
     */
    const target = await makeRepository();
    try {
      const headSha = await gitOrThrow(target, ['rev-parse', 'HEAD']);
      const { changeRequest } = await ensureChangeRequest({
        projectId: fixture.project.id,
        submissionKey: 'findings-target-repo',
        objective: 'Work in a repository the factory does not live in.',
        expectedOutcome: 'Its worktrees are retired without anybody naming the path again.',
        nonGoals: [],
        acceptanceConditions: [
          { id: 'A01', statement: 'the contract carries the checkout', verification: 'read the row', mandatory: true },
        ],
        repository: 'https://example.invalid/target.git',
        repositoryRoot: target,
        baseBranch: 'main',
        baseSha: headSha,
        environment: 'LOCAL',
        riskClass: 'LOW',
        mutationScope: ['src.txt'],
        deploymentPolicy: 'NONE',
        rollbackRequirement: 'discard the branch',
        verificationCommands: [],
      });
      expect(changeRequest.repositoryRoot).toBe(target);

      const { campaign } = await ensureCampaign({
        changeRequestId: changeRequest.id,
        projectId: fixture.project.id,
        baseSha: headSha,
        laneTarget: 1,
        laneTargetReason: 'initial',
      });
      const { unit } = await ensureUnit({
        campaignId: campaign.id,
        unitKey: 'alpha',
        kind: 'IMPLEMENTATION',
        role: 'IMPLEMENTER',
        title: 'alpha',
        objective: 'alpha',
        acceptance: ['it works'],
        ownedPaths: ['src.txt'],
        requiredContext: [],
        verification: [],
        expectedArtifact: 'a commit',
        state: 'READY',
      });
      const worktree = path.join(campaignWorkspace(campaign.id), 'alpha-a1');
      await ensureWorktree(target, {
        branch: `factory/${campaign.id}/alpha/a1`,
        path: worktree,
        baseSha: headSha,
      });
      expect(fs.existsSync(worktree)).toBe(true);

      await patchCampaign(campaign.id, {
        state: 'COMPLETE',
        stageDetail: 'finished',
        finishedAt: factoryNow(),
        integrationSha: headSha,
      });
      const { getDb } = await import('../server/db/database.ts');
      await getDb().run(`UPDATE factory_work_units SET state = 'INTEGRATED' WHERE id = ?`, [unit.id]);

      // No options at all: the campaign has to supply its own answer.
      const reports = await recoverAll();
      const mine = reports.find((report) => report.campaignId === campaign.id);
      expect(mine?.worktreesPruned).toBe(1);
      expect(fs.existsSync(worktree)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('a finished campaign does not keep its checkouts forever', () => {
  it('recoverAll reaches a terminal campaign whose worktree is still on disk', async () => {
    const changeRequest = await makeApprovedRequest('findings-terminal-prune');
    const campaign = await makeCampaign(changeRequest);

    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'alpha',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'alpha',
      objective: 'alpha',
      acceptance: ['it works'],
      ownedPaths: ['src.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });

    const branch = `factory/${campaign.id}/alpha/a1`;
    const worktree = path.join(campaignWorkspace(campaign.id), 'alpha-a1');
    await ensureWorktree(repoRoot, { branch, path: worktree, baseSha: campaign.baseSha });
    expect(fs.existsSync(worktree)).toBe(true);

    // The unit is done and the campaign is over — which is exactly the shape no
    // caller of recovery could previously see.
    await patchCampaign(campaign.id, {
      state: 'COMPLETE',
      stageDetail: 'finished',
      finishedAt: factoryNow(),
      integrationSha: campaign.baseSha,
    });
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(`UPDATE factory_work_units SET state = 'INTEGRATED' WHERE id = ?`, [unit.id]);

    // It really is terminal, and nothing that walks live campaigns can see it.
    expect((await listTerminalCampaigns()).map((c) => c.id)).toContain(campaign.id);

    const reports = await recoverAll({ repoRoot });
    const mine = reports.find((report) => report.campaignId === campaign.id);
    expect(mine).toBeDefined();
    expect(mine?.worktreesPruned).toBe(1);
    // The campaign is still COMPLETE: pruning scratch is not re-deriving state.
    expect(mine?.stateRederived).toBeNull();

    expect(fs.existsSync(worktree)).toBe(false);
    const remaining = (await listWorktrees(repoRoot)).map((w) => path.resolve(w.path));
    expect(remaining).not.toContain(path.resolve(worktree));
  });
});
