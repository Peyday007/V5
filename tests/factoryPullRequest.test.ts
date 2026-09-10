/**
 * The reviewable artifact's title and body, from rows rather than from a
 * worker's prose — and proof that assembling one cannot also publish one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  approveChangeRequest,
  claimUnits,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  markImplemented,
  markIntegrated,
} from '../server/repos/factory.ts';
import { recordReview } from '../server/repos/factoryFleet.ts';
import { loadCampaignView } from '../server/services/factory/campaignView.ts';
import { pullRequestFor, renderPullRequest } from '../server/services/factory/pullRequest.ts';

const MODULE_PATH = fileURLToPath(
  new URL('../server/services/factory/pullRequest.ts', import.meta.url),
);

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

afterEach(async () => {
  await teardown();
});

describe('the pull request', () => {
  it('carries every acceptance condition, the review verdict, and matches the pure renderer', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'pr-render',
      objective:
        'Give a reviewer a body that resolves entirely to rows, never to a worker\'s own summary of its work.',
      expectedOutcome: 'The rendered body carries both conditions, the verdict, and the open finding.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'the first condition is met', verification: 'read the code', mandatory: true },
        {
          id: 'A02',
          statement: 'the second condition is not met yet',
          verification: 'read the code',
          mandatory: true,
        },
      ],
      repository: '/tmp/does-not-matter',
      baseBranch: 'main',
      baseSha: 'base0000000000000000000000000000000000',
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['src/**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'Revert the integration branch and discard the campaign.',
      verificationCommands: ['npm run typecheck', 'npm test'],
    });
    expect(
      await approveChangeRequest({
        changeRequestId: changeRequest.id,
        via: 'PERSON',
        userId: null,
        authorityId: null,
      }),
    ).toBe(true);

    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'landed-unit',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'Land the first condition',
      objective: 'Change the file the first condition is about.',
      acceptance: ['the file changed'],
      ownedPaths: ['src/one.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    const claimed = await claimUnits({ campaignId: campaign.id, workerId: 'w1', unitIds: [unit.id] });
    expect(claimed.length).toBe(1);
    await markImplemented(
      {
        unitId: unit.id,
        workerId: 'w1',
        leaseId: claimed[0]?.leaseId ?? '',
        leaseGeneration: claimed[0]?.leaseGeneration ?? 0,
      },
      {
        branch: 'factory/unit/landed',
        headSha: 'feedfacecafefeedfacecafefeedfacecafefeed',
        baseSha: changeRequest.baseSha,
        worktreePath: null,
        workerSummary: 'Landed the change.',
        terminalResult: null,
      },
    );
    const integrationSha = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
    expect(await markIntegrated(unit.id, integrationSha)).toBe(true);

    const { review } = await recordReview({
      campaignId: campaign.id,
      round: 1,
      scope: 'CAMPAIGN',
      unitId: null,
      reviewerSessionId: 's-reviewer',
      reviewedSha: integrationSha,
      verdict: 'PASS',
      summary: 'The campaign objective was met.',
      independence: 'WORKER_SEPARATED',
      findings: [
        {
          key: 'second-condition-open',
          severity: 'MAJOR',
          category: 'coverage',
          statement: 'The second condition still has no evidence in the diff.',
          evidence: 'src/two.txt',
          acceptanceConditionId: 'A02',
        },
      ],
    });
    expect(review.verdict).toBe('PASS');

    const pr = await pullRequestFor(campaign.id);
    expect(pr).not.toBeNull();
    if (!pr) throw new Error('unreachable');

    // Every acceptance condition id appears, whatever its status.
    expect(pr.body).toContain('A01');
    expect(pr.body).toContain('A02');
    expect(pr.body).toContain('MET');
    expect(pr.body).toContain('NOT_MET');
    // The review verdict, at the tier it actually earned.
    expect(pr.body).toContain('PASS');
    expect(pr.body).toContain('WORKER_SEPARATED');
    // The unit that landed, and the finding still open.
    expect(pr.body).toContain('landed-unit');
    expect(pr.body).toContain('second-condition-open');
    // The rollback path, verbatim.
    expect(pr.body).toContain(changeRequest.rollbackRequirement);

    // The pure renderer over the same view produces exactly what pullRequestFor did.
    const view = await loadCampaignView(campaign.id);
    expect(view).not.toBeNull();
    if (view) {
      const direct = renderPullRequest(view);
      expect(direct.body).toBe(pr.body);
      expect(direct.title).toBe(pr.title);
    }

    expect(await pullRequestFor('no-such-campaign')).toBeNull();
  });

  it('cannot publish: its source has no network call, no shell-out, and no push', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/\bfetch\(|child_process|\bgit\b|push/);
  });
});
