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

/*
 * A renderer with no way in.
 *
 * `pullRequestFor` was reachable at `GET /factory/campaigns/:id/pull-request`
 * and by nothing else — no function in `client/src/lib/factoryApi.ts`, no
 * command on the factory door. On the hosted plane that is survivable, because
 * the request already exists on the forge and a person reads it there. On the
 * local plane it is the campaign's *whole deliverable*: `assemble.ts` renders
 * the body, stores it, and stops, because opening the request is a separately
 * authorized step somebody performs outside the factory — and that somebody had
 * nowhere to read what they were about to open.
 *
 * It reads the repository rather than calling anything, for
 * `operatorConsoleRemoved`'s reason: what has to exist is a *way in*, and a
 * passing service call cannot show you one. Every assertion here was run against
 * the command deleted, to watch it fail.
 */
describe('the way in', () => {
  const door = () => fs.readFileSync('scripts/factory.ts', 'utf8');

  /*
   * The command's own text, or a failure saying it is not there.
   *
   * Three of the four assertions below are negative — this must not read the
   * artifact, this must not publish — and a negative assertion over an empty
   * string passes for the wrong reason. Deleting the command made two of them
   * green, which is §41's vacuous guard exactly: it reads as coverage. So the
   * slice is taken here, once, and a missing command fails every one of them
   * rather than satisfying three.
   */
  const printer = (): string => {
    const source = door();
    const from = source.indexOf("case 'pull-request': {");
    const to = source.indexOf("case 'release': {");
    if (from === -1 || to === -1 || to <= from) {
      throw new Error('`scripts/factory.ts` has no `pull-request` command to read.');
    }
    return source.slice(from, to);
  };

  it('is a command on the factory door, and is advertised as one', () => {
    expect(printer()).toMatch(/pullRequestFor\(campaignId\)/);
    // A command nobody is told about is one nobody uses.
    const source = door();
    expect(source.slice(source.lastIndexOf('commands:'))).toMatch(/pull-request/);
  });

  it('renders from rows rather than reading back the stored snapshot', () => {
    /*
     * One derivation, three readers. `assemble.ts` records a `PR_BODY` artifact
     * at the moment it assembles, and this module's own header records what it
     * cost the last time two readers each had their own idea of the body: the
     * stored document and the live route made different claims about one
     * campaign and nothing reconciled them. A door that read the artifact would
     * be the third.
     */
    expect(printer()).not.toMatch(/PR_BODY|listArtifacts|readArtifact/);
  });

  it('says a campaign has no artifact rather than printing a blank one', () => {
    // `pullRequestFor` answers null for a campaign whose rows do not resolve
    // into a view. Printing that as an empty document would read as a campaign
    // whose artifact is empty, which is a different and reassuring claim.
    expect(printer()).toMatch(/no reviewable artifact/);
  });

  it('publishes nothing', () => {
    // The module's own guarantee, at the surface that reads it. The factory may
    // open a reviewable request and may never merge or publish one, and a door
    // that grew an outbound call would be that boundary depending on nobody
    // having called it.
    expect(printer()).not.toMatch(/fetch\(|octokit|forge\.|createPullRequest/);
  });
});
