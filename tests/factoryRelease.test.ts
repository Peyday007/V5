/**
 * Unattended release (CLAUDE.md §58): what may be released without a person,
 * the owner's authorization that allows it, and the reading that says whether a
 * change is actually live — never because a workflow said so.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import { run } from '../server/services/factory/git.ts';
import { ensureCampaign, patchCampaign } from '../server/repos/factory.ts';
import { listFactoryEvents, recordReview } from '../server/repos/factoryFleet.ts';
import { getDb } from '../server/db/database.ts';
import {
  classifyRelease,
  PROTECTED_CLASSES,
  PROTECTED_PATHS,
  protectedClassesOf,
} from '../server/services/factory/releaseEligibility.ts';
import {
  assessRelease,
  campaignsAwaitingRelease,
  observeRelease,
  observeReleases,
  RELEASE_EVENT_KINDS,
  resetReleaseObservationThrottle,
  type ReleaseDeps,
} from '../server/services/factory/release.ts';
import {
  insertReleaseAuthorization,
  liveReleaseAuthorization,
  revokeReleaseAuthorization,
} from '../server/repos/releaseAuthorizations.ts';
import { requirementFor } from '../server/services/identity/policy.ts';

describe('which changes may be released without a person', () => {
  it('releases ordinary product code, tests and docs', () => {
    const verdict = classifyRelease([
      'client/src/russell/Build.tsx',
      'server/services/factory/story.ts',
      'tests/factoryStory.test.ts',
      'docs/FACTORY.md',
    ]);
    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it.each([
    ['server/services/identity/secrets.ts', 'CREDENTIALS'],
    ['server/routes/oauth.ts', 'CREDENTIALS'],
    ['server/routes/guard.ts', 'SECURITY'],
    ['server/services/identity/policy.ts', 'SECURITY'],
    ['server/services/cash/authority.ts', 'FINANCIAL_AUTHORITY'],
    ['server/repos/cashLedger.ts', 'FINANCIAL_AUTHORITY'],
    ['.github/workflows/deploy.yml', 'DEPLOYMENT_CONTROLS'],
    ['fly.toml', 'DEPLOYMENT_CONTROLS'],
    ['server/db/migrations/999_x.sql', 'SCHEMA'],
    ['package-lock.json', 'DEPENDENCIES'],
  ] as const)('keeps %s manual as %s', (file, cls) => {
    const verdict = classifyRelease(['client/src/ok.tsx', file]);
    expect(verdict.eligible).toBe(false);
    expect(verdict.classes).toContain(cls);
  });

  it('cannot be widened by the change it judges: every file that decides a release is a deployment control', () => {
    for (const file of [
      'server/services/factory/releaseEligibility.ts',
      'server/services/factory/release.ts',
      'server/repos/releaseAuthorizations.ts',
      'scripts/release-eligibility.ts',
      'scripts/test-pg.mjs',
      '.github/workflows/factory-release.yml',
    ]) {
      expect(protectedClassesOf(file)).toContain('DEPLOYMENT_CONTROLS');
    }
  });

  it('is deny by default: anything outside the low-risk surface waits for a person', () => {
    expect(classifyRelease(['CLAUDE.md']).eligible).toBe(false);
    expect(classifyRelease(['scripts/admin.ts']).eligible).toBe(false);
    expect(classifyRelease(['some-new-dir/thing.ts']).reasons[0]?.kind).toBe('OUTSIDE_LOW_RISK_SURFACE');
  });

  it('refuses an empty change and a truncated file list rather than calling them safe', () => {
    expect(classifyRelease([]).reasons.map((r) => r.kind)).toEqual(['NOTHING_CHANGED']);
    expect(classifyRelease(['client/a.tsx'], { truncated: true }).eligible).toBe(false);
  });

  it('names every reason rather than the first', () => {
    const verdict = classifyRelease(['server/routes/guard.ts', 'server/routes/cash.ts', 'package.json']);
    expect(verdict.classes).toEqual(['SECURITY', 'FINANCIAL_AUTHORITY', 'DEPENDENCIES']);
  });

  it('declares paths for every protected class', () => {
    for (const cls of PROTECTED_CLASSES) expect(PROTECTED_PATHS[cls].length).toBeGreaterThan(0);
  });
});

describe('the authorization is a person’s, at ADMIN', () => {
  it('is an ADMIN write in the policy table, and so refused to a worker by type', () => {
    for (const suffix of ['', '/revoke']) {
      const requirement = requirementFor(
        'POST',
        `/api/projects/prj_x/factory/repositories/brain/release-authorization${suffix}`,
      );
      expect(requirement.level).toBe('ADMIN');
      expect(requirement.scope ?? null).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Rows and readings                                                          */
/* ------------------------------------------------------------------------- */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SERVING = 'c'.repeat(40);

let fixture: TestProject;
let repoRoot: string;
let approverId: string;

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-release-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'subject', scripts: {} }));
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'one.txt'), 'one\n');
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
      email: 'factory-release-owner@test.local',
      displayName: 'Factory Release Owner',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
  resetReleaseObservationThrottle();
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * A finished remote campaign with a delivered pull request. The change request
 * is submitted locally and then pointed at the Brain grant's remote, because
 * what is under test is the reading, not the submission.
 */
async function deliveredCampaign(options: { review?: 'PASS' | 'CHANGES_REQUIRED'; reviewedSha?: string } = {}) {
  const submitted = await submitObjective({
    projectId: fixture.project.id,
    objective: 'Change the client file so the release reading has something to read.',
    expectedOutcome: 'client/one.txt carries the new text.',
    acceptanceConditions: [{ statement: 'client/one.txt changed', verification: 'read the file' }],
    repositoryRoot: repoRoot,
    mutationScope: ['client/**'],
  });
  const approved = await approveObjective({
    changeRequestId: submitted.changeRequest.id,
    via: 'PERSON',
    userId: approverId,
  });
  expect(approved.ok).toBe(true);
  await getDb().run(`UPDATE factory_change_requests SET repository = ? WHERE id = ?`, [
    'https://github.com/Peyday007/V5',
    submitted.changeRequest.id,
  ]);
  const { campaign } = await ensureCampaign({
    changeRequestId: submitted.changeRequest.id,
    projectId: fixture.project.id,
    baseSha: submitted.changeRequest.baseSha,
    laneTarget: 1,
    laneTargetReason: 'initial',
  });
  await patchCampaign(campaign.id, {
    state: 'COMPLETE',
    prUrl: 'https://github.com/Peyday007/V5/pull/77',
    prRef: '#77',
    finishedAt: new Date().toISOString(),
  });
  await getDb().run(`UPDATE factory_campaigns SET execution_mode = 'REMOTE' WHERE id = ?`, [campaign.id]);
  if (options.review) {
    await recordReview({
      campaignId: campaign.id,
      round: 1,
      scope: 'CAMPAIGN',
      unitId: null,
      reviewerSessionId: 's-review',
      reviewedSha: options.reviewedSha ?? HEAD,
      verdict: options.review,
      summary: 'reviewed',
      independence: 'SESSION_SEPARATED',
      findings: [],
    });
  }
  return campaign.id;
}

interface ForgeState {
  merged: boolean;
  files: string[];
  servingContains: boolean;
}

function forge(state: ForgeState, serving: string | null = SERVING): ReleaseDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    servingRevision: serving,
    now: () => new Date(),
    async readPullRequest(_repository, number) {
      calls.push(`pr:${number}`);
      return {
        ok: true,
        status: 200,
        authenticated: true,
        reason: null,
        body: {
          number,
          state: state.merged ? 'closed' : 'open',
          headSha: HEAD,
          headRef: 'factory/x',
          baseRef: 'production',
          merged: state.merged,
          url: `https://github.com/Peyday007/V5/pull/${number}`,
          title: 't',
          updatedAt: '',
        },
      };
    },
    async compareCommits(_repository, base, head) {
      calls.push(`compare:${base}...${head}`);
      if (base === HEAD && head === serving) {
        return {
          ok: true,
          status: 200,
          authenticated: true,
          reason: null,
          body: {
            baseSha: HEAD,
            headSha: serving,
            aheadBy: 1,
            files: [],
            truncated: false,
            status: state.servingContains ? 'ahead' : 'diverged',
          },
        };
      }
      return {
        ok: true,
        status: 200,
        authenticated: true,
        reason: null,
        body: { baseSha: BASE, headSha: head, aheadBy: 1, files: state.files, truncated: false, status: 'ahead' },
      };
    },
  } as ReleaseDeps & { calls: string[] };
}

async function authorize() {
  return insertReleaseAuthorization({
    projectId: fixture.project.id,
    repositoryGrant: 'brain',
    grantedById: approverId,
    authorityChannel: 'BROWSER_SESSION',
    reason: 'low-risk product changes may ship unattended',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

describe('the owner’s standing release authorization', () => {
  it('is one live grant per repository, and revoking keeps the row', async () => {
    const first = await authorize();
    expect(first).not.toBeNull();
    expect(await authorize()).toBeNull();
    expect(await revokeReleaseAuthorization({
      projectId: fixture.project.id,
      repositoryGrant: 'brain',
      revokedById: approverId,
      reason: 'pausing',
    })).toBe(true);
    expect(await liveReleaseAuthorization(fixture.project.id, 'brain')).toBeNull();
    const rows = await getDb().all(`SELECT * FROM factory_release_authorizations`);
    expect(rows).toHaveLength(1);
  });

  it('does not count once expired, and a new grant closes the expired one rather than colliding', async () => {
    await insertReleaseAuthorization({
      projectId: fixture.project.id,
      repositoryGrant: 'brain',
      grantedById: approverId,
      authorityChannel: 'SHELL',
      reason: 'old',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await liveReleaseAuthorization(fixture.project.id, 'brain')).toBeNull();
    expect(await authorize()).not.toBeNull();
    const closed = await getDb().get<{ revoke_reason: string }>(
      `SELECT revoke_reason FROM factory_release_authorizations WHERE reason = 'old'`,
    );
    expect(closed?.revoke_reason).toBe('expired');
  });
});

describe('where a finished change stands on its way to production', () => {
  it('has nothing to release before a pull request exists', async () => {
    const campaignId = await deliveredCampaign();
    await patchCampaign(campaignId, { prUrl: null, prRef: null });
    const reading = await assessRelease(campaignId, forge({ merged: false, files: [], servingContains: false }));
    expect(reading.stage).toBe('NOT_DELIVERED');
  });

  it('is eligible only when the diff is low risk, the review passed at this head, and a person authorized it', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    await authorize();
    const reading = await assessRelease(
      campaignId,
      forge({ merged: false, files: ['client/one.txt'], servingContains: false }),
    );
    expect(reading.blockers).toEqual([]);
    expect(reading.stage).toBe('AUTO_RELEASE_ELIGIBLE');
    expect(reading.headSha).toBe(HEAD);
  });

  it('waits for a person without the authorization, and says so', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    const reading = await assessRelease(
      campaignId,
      forge({ merged: false, files: ['client/one.txt'], servingContains: false }),
    );
    expect(reading.stage).toBe('MANUAL_RELEASE_REQUIRED');
    expect(reading.blockers.map((b) => b.code)).toEqual(['NO_RELEASE_AUTHORIZATION']);
  });

  it('keeps a protected change manual whatever the authorization says', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    await authorize();
    const reading = await assessRelease(
      campaignId,
      forge({ merged: false, files: ['client/one.txt', 'server/services/cash/authority.ts'], servingContains: false }),
    );
    expect(reading.stage).toBe('MANUAL_RELEASE_REQUIRED');
    expect(reading.protectedClasses).toEqual(['FINANCIAL_AUTHORITY']);
  });

  it('refuses a review that read a different head, or did not pass', async () => {
    const stale = await deliveredCampaign({ review: 'PASS', reviewedSha: 'd'.repeat(40) });
    await authorize();
    const deps = forge({ merged: false, files: ['client/one.txt'], servingContains: false });
    expect((await assessRelease(stale, deps)).blockers.map((b) => b.code)).toContain('REVIEW_STALE');
    const failed = await deliveredCampaign({ review: 'CHANGES_REQUIRED' });
    expect((await assessRelease(failed, deps)).blockers.map((b) => b.code)).toContain('REVIEW_NOT_PASSED');
  });

  it('reads merged-but-not-serving as MERGED_NOT_LIVE, naming the deploy', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    const reading = await assessRelease(campaignId, forge({ merged: true, files: [], servingContains: false }));
    expect(reading.stage).toBe('MERGED_NOT_LIVE');
    expect(reading.blockers[0]?.owner).toBe('DEPLOY');
  });

  it('says LIVE only when the serving revision contains the head, and records it once', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    const deps = forge({ merged: true, files: [], servingContains: true });
    const first = await observeRelease(campaignId, deps);
    expect(first.reading.stage).toBe('LIVE');
    expect(first.recorded).toBe(true);
    const again = await observeRelease(campaignId, deps);
    expect(again.recorded).toBe(false);
    expect(await listFactoryEvents(campaignId, { kinds: [RELEASE_EVENT_KINDS.live] })).toHaveLength(1);
    // And a live campaign stops being asked about.
    expect((await campaignsAwaitingRelease()).map((c) => c.id)).not.toContain(campaignId);
  });

  it('cannot call anything live without knowing its own revision', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    const reading = await assessRelease(campaignId, forge({ merged: true, files: [], servingContains: true }, null));
    expect(reading.stage).toBe('MERGED_NOT_LIVE');
  });

  it('is read by the tick, throttled per campaign', async () => {
    const campaignId = await deliveredCampaign({ review: 'PASS' });
    const deps = forge({ merged: false, files: ['client/one.txt'], servingContains: false });
    expect(await observeReleases(deps)).toBe(1);
    expect(await observeReleases(deps)).toBe(0);
    const recorded = await listFactoryEvents(campaignId, { kinds: [RELEASE_EVENT_KINDS.assessed] });
    expect(recorded).toHaveLength(1);
    expect((recorded[0]?.detail as { stage?: string }).stage).toBe('MANUAL_RELEASE_REQUIRED');
  });
});
