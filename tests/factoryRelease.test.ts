/**
 * Automatic release of a Factory campaign: the gate, the attempt state machine,
 * the plan Brain hands the release workflow, verification inside the released
 * Brain, and the one status a person reads.
 *
 * The forge is stubbed at `fetch`; everything else is the real repository layer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { approveObjective, inferRisk, submitObjective } from '../server/services/factory/contract.ts';
import { run } from '../server/services/factory/git.ts';
import { ensureCampaign, factoryNow, getCampaign, patchCampaign } from '../server/repos/factory.ts';
import { recordReview } from '../server/repos/factoryFleet.ts';
import { getDb } from '../server/db/database.ts';
import { decideRelease, excludedPathsIn } from '../server/services/factory/release/gate.ts';
import { advanceRelease, mayMerge, planRelease, releaseWaitFor } from '../server/services/factory/release/plan.ts';
import {
  authorizeAutomaticRelease,
  ReleaseGrantError,
  validateLiveChecks,
  withdrawAutomaticRelease,
} from '../server/services/factory/release/grant.ts';
import { deriveOutcome, objectiveOutcome } from '../server/services/factory/release/outcome.ts';
import { verifyLive, type VerifyDeps } from '../server/services/factory/release/verify.ts';
import { latestRun, listRuns, openRun } from '../server/repos/factoryRelease.ts';
import { forbiddenPathsFor } from '../server/services/factory/forbidden.ts';
import { scanDiff } from '../scripts/release-scan.ts';
import {
  MAX_CANCELLED_DEPLOYS,
  deployRefusedAtTip,
  deployReleased,
  deploySuperseded,
  readDeploy,
  judgeReleasedVerdict,
  verificationFromLog,
  onCancelledDeploy,
  onProductionMoved,
} from '../scripts/factory-release.ts';
import type { FactoryCampaign, FactoryChangeRequest } from '../server/domain/factory.ts';
import type { ReleaseGrant, ReleaseRun } from '../server/domain/factoryRelease.ts';

const REMOTE = 'https://github.com/Peyday007/V5';
const HEAD = 'a'.repeat(40);

let fixture: TestProject;
let repoRoot: string;
let adminId: string;

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
  adminId = (
    await createUser({
      email: 'factory-release-admin@test.local',
      displayName: 'Factory Release Admin',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

async function approved(objective = 'Show a friendly greeting line on the Build page.'): Promise<FactoryChangeRequest> {
  const submitted = await submitObjective({
    projectId: fixture.project.id,
    objective,
    expectedOutcome: 'The Build page shows the greeting.',
    acceptanceConditions: [{ statement: 'the Build page shows the greeting', verification: 'open the page' }],
    repositoryRoot: repoRoot,
    mutationScope: ['client/**'],
  });
  const done = await approveObjective({ changeRequestId: submitted.changeRequest.id, via: 'PERSON', userId: adminId });
  expect(done.ok).toBe(true);
  // A hosted campaign names its remote; the fixture pins locally, so say so in the row.
  await getDb().run('UPDATE factory_change_requests SET repository = ? WHERE id = ?', [REMOTE, done.changeRequest.id]);
  return { ...done.changeRequest, repository: REMOTE };
}

async function completeCampaign(changeRequest: FactoryChangeRequest, verdict: 'PASS' | 'CHANGES_REQUIRED' = 'PASS') {
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 1,
    laneTargetReason: 'initial',
  });
  await recordReview({
    campaignId: campaign.id,
    round: 1,
    scope: 'CAMPAIGN',
    unitId: null,
    reviewerSessionId: 's-review',
    reviewedSha: HEAD,
    verdict,
    summary: 'read it',
    independence: 'SESSION_SEPARATED',
    findings: [],
  });
  await patchCampaign(campaign.id, {
    state: 'COMPLETE',
    integrationSha: HEAD,
    finishedAt: factoryNow(),
    prUrl: `${REMOTE}/pull/77`,
    prRef: '#77',
  });
  return (await getCampaign(campaign.id)) as FactoryCampaign;
}

/** The forge, as the tests need it: one pull request, open, and a compare listing `files`. */
function stubForge(files: string[], opts: { merged?: boolean; truncated?: boolean } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/pulls/77')) {
        return new Response(
          JSON.stringify({
            number: 77,
            state: opts.merged ? 'closed' : 'open',
            merged: opts.merged === true,
            html_url: `${REMOTE}/pull/77`,
            head: { sha: HEAD, ref: 'factory/x' },
            base: { ref: 'production' },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/compare/')) {
        const list = opts.truncated ? Array.from({ length: 300 }, (_, i) => `client/f${i}.ts`) : files;
        return new Response(
          JSON.stringify({ ahead_by: 1, status: 'ahead', files: list.map((filename) => ({ filename })) }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }),
  );
}

async function grant(changeRequestId: string): Promise<ReleaseGrant> {
  const { grant } = await authorizeAutomaticRelease({
    changeRequestId,
    userId: adminId,
    channel: 'SHELL',
    executedByRef: null,
    reason: 'release it when it passes',
    pagePath: '/build',
    liveChecks: [{ kind: 'BUNDLE_TEXT', text: 'greeting' }],
  });
  return grant;
}

describe('the release gate', () => {
  it('refuses every reserved change class, whatever the grant says', () => {
    for (const file of [
      'server/db/migrations/200_x.sql',
      'server/services/identity/policy.ts',
      'server/services/cash/authority.ts',
      '.github/workflows/deploy.yml',
      'fly.toml',
      'package.json',
      'server/services/factory/release/gate.ts',
      'scripts/factory-release.ts',
      // The gate's own inputs: what its patterns match, the changed-file list it
      // classifies, whether the review passed, and where a grant is guarded.
      'server/services/factory/glob.ts',
      'server/services/factory/forge.ts',
      'server/services/factory/campaignView.ts',
      'server/services/factory/review.ts',
      'server/routes/factory.ts',
      'server/repos/factory.ts',
      'scripts/factory.sh',
      // What the gate runs to decide the tests passed.
      'scripts/test-impacted.mjs',
      'vitest.config.ts',
      'tsconfig.json',
      'scripts/test-postgres.sh',
      '.claude/settings.json',
    ]) {
      expect(excludedPathsIn([file])).toEqual([file]);
    }
    expect(excludedPathsIn(['client/src/russell/Build.tsx', 'server/services/russell/home.ts'])).toEqual([]);
  });

  it('a campaign can never own the machinery that releases it', () => {
    const forbidden = forbiddenPathsFor(REMOTE);
    for (const owned of ['server/services/factory/release/**', 'scripts/factory-release.ts', 'scripts/release-scan.ts']) {
      expect(forbidden).toContain(owned);
    }
  });

  it('names every reason it refuses, and only passes when none hold', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    const theGrant = await grant(changeRequest.id);
    const review = {
      id: 'r', campaignId: campaign.id, round: 1, scope: 'CAMPAIGN' as const, unitId: null,
      reviewerSessionId: 's', reviewedSha: HEAD, verdict: 'PASS' as const, summary: '', independence: 'SESSION_SEPARATED' as const, createdAt: '',
    };
    const base = {
      campaign, changeRequest, grant: theGrant, latestReview: review, openFindings: [],
      releasableRepository: 'Peyday007/V5', repositorySlug: 'Peyday007/V5',
      changedFiles: ['client/src/russell/Build.tsx'], changedFilesTruncated: false,
    };
    expect(decideRelease(base)).toMatchObject({ eligible: true, reasons: [] });
    expect(decideRelease({ ...base, grant: null }).reasons.join(' ')).toMatch(/not authorized automatic release/);
    expect(decideRelease({ ...base, changeRequest: { ...changeRequest, riskClass: 'MEDIUM' } }).eligible).toBe(false);
    expect(decideRelease({ ...base, latestReview: { ...review, verdict: 'CHANGES_REQUIRED' } }).eligible).toBe(false);
    expect(decideRelease({ ...base, latestReview: { ...review, independence: 'UNKNOWN' } }).eligible).toBe(false);
    expect(decideRelease({ ...base, latestReview: { ...review, reviewedSha: 'b'.repeat(40) } }).eligible).toBe(false);
    expect(decideRelease({ ...base, openFindings: [{} as never] }).eligible).toBe(false);
    expect(decideRelease({ ...base, changedFilesTruncated: true }).eligible).toBe(false);
    expect(decideRelease({ ...base, changedFiles: null }).eligible).toBe(false);
    expect(decideRelease({ ...base, repositorySlug: 'Peyday007/other' }).eligible).toBe(false);
    expect(decideRelease({ ...base, changedFiles: ['server/db/migrations/1.sql'] }).excludedPathsTouched).toEqual([
      'server/db/migrations/1.sql',
    ]);
  });
});

describe('risk inference', () => {
  it('reads whole words, so a release or a test file name is not a lease', () => {
    expect(inferRisk('Add tests/buildReleaseSentence.test.tsx and release it, please')).toBe('LOW');
    expect(inferRisk('Shorten the work item lease')).toBe('MEDIUM');
    expect(inferRisk('Add a route for the briefing')).toBe('MEDIUM');
    expect(inferRisk('Rename the queues')).toBe('MEDIUM');
    expect(inferRisk('Add a migration for the new table')).toBe('HIGH');
  });
});

describe('the grant', () => {
  it('is a person’s, LOW risk only, and validates its live checks exactly', async () => {
    const low = await approved();
    const first = await grant(low.id);
    const again = await authorizeAutomaticRelease({
      changeRequestId: low.id, userId: adminId, channel: 'BROWSER', executedByRef: null, reason: 'again',
    });
    expect(again.created).toBe(false);
    expect(again.grant.id).toBe(first.id);

    const high = await approved('Run a database migration that drops the old table.');
    expect(high.riskClass).toBe('HIGH');
    await expect(
      authorizeAutomaticRelease({ changeRequestId: high.id, userId: adminId, channel: 'SHELL', executedByRef: null, reason: 'x' }),
    ).rejects.toBeInstanceOf(ReleaseGrantError);

    expect(() => validateLiveChecks([{ kind: 'HTTP', path: '/healthz', expectStatus: 200, extra: 1 }])).toThrow(/unknown field/);
    expect(() => validateLiveChecks([{ kind: 'HTTP', path: 'https://evil.example/' }])).toThrow(/path on this Brain/);
    expect(() => validateLiveChecks([{ kind: 'SHELL', command: 'rm -rf /' }])).toThrow(/HTTP or BUNDLE_TEXT/);
  });
});

describe('the release plan and its state machine', () => {
  it('opens one attempt, refuses a reserved change once, and resumes an attempt in flight', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    stubForge(['client/src/russell/Build.tsx']);

    const plan = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf1' });
    expect(plan.action?.action).toBe('RELEASE');
    expect(plan.action?.prNumber).toBe(77);
    expect(plan.action?.headSha).toBe(HEAD);
    const runId = plan.action?.runId ?? '';

    // A second pass resumes the same attempt rather than opening another.
    const again = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf2' });
    expect(again.action).toMatchObject({ action: 'RESUME', runId, state: 'GATING' });
    expect((await listRuns(campaign.id)).length).toBe(1);

    // The database refuses a second in-flight attempt even from a racing caller.
    const racing = await openRun({
      campaignId: campaign.id, changeRequestId: changeRequest.id, grantId: (await latestRun(campaign.id))!.grantId,
      headSha: HEAD, attempt: 2, state: 'GATING', refusal: [], workflowRunId: null,
    });
    expect(racing.created).toBe(false);

    // Guarded moves: out of order is refused, in order moves.
    expect((await advanceRelease({ runId, to: 'DEPLOYING', deployRunId: '9' })).moved).toBe(false);
    expect((await advanceRelease({ runId, to: 'MERGED', mergeSha: 'c'.repeat(40) })).moved).toBe(true);
    expect((await advanceRelease({ runId, to: 'MERGED', mergeSha: 'd'.repeat(40) })).moved).toBe(false);
    expect((await advanceRelease({ runId, to: 'DEPLOYING', deployRunId: '9' })).moved).toBe(true);
    // A Deploy evicted before it started is replaced, and the attempt records the one that carries the merge.
    expect((await advanceRelease({ runId, to: 'DEPLOYING', deployRunId: '8' })).moved).toBe(true);
    expect((await latestRun(campaign.id))!.deployRunId).toBe('8');
    expect((await advanceRelease({ runId, to: 'DEPLOYING', deployRunId: '9' })).moved).toBe(true);

    // A worker restart: the workflow that held it is gone; the next pass resumes at DEPLOYING.
    const resumed = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf3' });
    expect(resumed.action).toMatchObject({ action: 'RESUME', state: 'DEPLOYING', deployRunId: '9', mergeSha: 'c'.repeat(40) });

    expect((await advanceRelease({ runId, to: 'VERIFYING' })).moved).toBe(true);
    expect((await objectiveOutcome(campaign)).status).toBe('RELEASING');
    expect((await advanceRelease({ runId, to: 'LIVE', verification: { ok: true } })).moved).toBe(true);
    const live = await objectiveOutcome((await getCampaign(campaign.id))!);
    expect(live).toMatchObject({ status: 'LIVE', pageUrl: '/build', needsPerson: false });

    // Finished: nothing more to do for this head.
    expect((await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf4' })).action).toBeNull();
  });

  it('records a refusal once and shows it as a person’s blocker', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    stubForge(['client/a.tsx', 'server/db/migrations/999_x.sql']);
    const plan = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null });
    expect(plan.action).toBeNull();
    const runs = await listRuns(campaign.id);
    expect(runs.map((one) => one.state)).toEqual(['REFUSED']);
    await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null });
    expect((await listRuns(campaign.id)).length).toBe(1);
    const outcome = await objectiveOutcome(campaign);
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.needsPerson).toBe(true);
    expect(outcome.blocker).toMatch(/reserved for a person/);
  });

  it('does not refuse on a forge that did not answer, and leaves a person-merged request alone', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })));
    expect((await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null })).action).toBeNull();
    expect(await listRuns(campaign.id)).toEqual([]);
    stubForge(['client/a.tsx'], { merged: true });
    expect((await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null })).action).toBeNull();
    expect(await listRuns(campaign.id)).toEqual([]);
  });

  it('retries a runner failure on the same head, never a verdict about the work', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    stubForge(['client/a.tsx']);
    const first = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null });
    await advanceRelease({ runId: first.action!.runId, to: 'FAILED', failureStage: 'INFRA', failureDetail: 'runner lost' });
    expect((await objectiveOutcome(campaign)).status).toBe('RELEASING');
    const second = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null });
    expect(second.action?.action).toBe('RELEASE');
    await advanceRelease({ runId: second.action!.runId, to: 'FAILED', failureStage: 'GATE', failureDetail: 'tests failed' });
    expect((await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: null })).action).toBeNull();
    const outcome = await objectiveOutcome(campaign);
    expect(outcome).toMatchObject({ status: 'BLOCKED', needsPerson: true });
    expect(outcome.blocker).toBe('tests failed');
  });
});

describe('a pass asked about one campaign knows whether waiting is worth it (FAC-5)', () => {
  it('stops at once for a campaign with no grant, and names the way to give one', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    stubForge(['client/src/russell/Build.tsx']);
    const plan = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf' });
    expect(plan.action).toBeNull();
    const wait = await releaseWaitFor(campaign.id);
    expect(wait.wait).toBe(false);
    expect(wait.reason).toMatch(/no automatic-release grant/);
    expect(wait.reason).toMatch(/authorize-release/);
    // Nothing was recorded for it: no attempt holds the campaign.
    expect(await listRuns(campaign.id)).toEqual([]);
  });

  it('keeps waiting for a granted campaign that is not COMPLETE yet, and releases it once it is', async () => {
    const changeRequest = await approved();
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    await grant(changeRequest.id);
    const pending = await releaseWaitFor(campaign.id);
    expect(pending.wait).toBe(true);
    expect(pending.reason).toMatch(/once it is COMPLETE/);
    await completeCampaign(changeRequest);
    stubForge(['client/src/russell/Build.tsx']);
    const plan = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf' });
    expect(plan.action?.action).toBe('RELEASE');
  });

  it('a grant given after an early exit is recognised by the next pass', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    stubForge(['client/src/russell/Build.tsx']);
    expect((await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf1' })).action).toBeNull();
    expect((await releaseWaitFor(campaign.id)).wait).toBe(false);
    await grant(changeRequest.id);
    const later = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf2' });
    expect(later.action).toMatchObject({ action: 'RELEASE', campaignId: campaign.id });
  });

  it('says there is nothing to wait for about an unknown or cancelled campaign', async () => {
    expect((await releaseWaitFor('fcp_nonexistent')).wait).toBe(false);
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    await patchCampaign(campaign.id, { state: 'CANCELLED' });
    expect((await releaseWaitFor(campaign.id)).wait).toBe(false);
  });

  it('the workflow stops polling on that answer, and keeps the old wait for an older image', () => {
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    const ask = workflow.slice(workflow.indexOf('      - name: Ask'), workflow.indexOf('  gate:'));
    expect(ask).toMatch(/campaign_flag="--campaign \$campaign"/);
    expect(ask).toMatch(/\*\[!A-Za-z0-9_-\]\*\) ;;/);
    expect(ask).toMatch(/RELEASE-WAIT: /);
    expect(ask).toMatch(/jq -r '\.wait'\)" = "false" \]; then[\s\S]*?break/);
    expect(ask).toMatch(/tries=15/);
    const cli = fs.readFileSync('scripts/factory.ts', 'utf8');
    expect(cli).toMatch(/RELEASE-WAIT: \$\{JSON\.stringify\(await releaseWaitFor\(campaignId\)\)\}/);
  });
});

describe('verification inside the released Brain', () => {
  const page = '<html><script type="module" src="/assets/index-x.js"></script></html>';
  function deps(over: Partial<VerifyDeps> & { bundle?: string; health?: number } = {}): VerifyDeps {
    return {
      revision: 'c'.repeat(40),
      baseUrl: 'http://127.0.0.1:9',
      contains: async () => true,
      fetch: (async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/healthz')) return new Response('ok', { status: over.health ?? 200 });
        if (url.endsWith('/')) return new Response(page, { status: 200 });
        if (url.includes('/assets/index-x.js')) return new Response(over.bundle ?? 'a greeting here', { status: 200 });
        return new Response('nope', { status: 404 });
      }) as typeof fetch,
      ...over,
    };
  }
  const checks = [{ kind: 'BUNDLE_TEXT' as const, text: 'greeting' }];

  it('is LIVE only when the revision, health and every live check agree', async () => {
    expect((await verifyLive(deps(), { mergeSha: 'c'.repeat(40), liveChecks: checks })).live).toBe(true);
    expect((await verifyLive(deps({ bundle: 'old code' }), { mergeSha: 'c'.repeat(40), liveChecks: checks })).live).toBe(false);
    expect((await verifyLive(deps({ health: 503 }), { mergeSha: 'c'.repeat(40), liveChecks: checks })).live).toBe(false);
    expect((await verifyLive(deps({ revision: null }), { mergeSha: 'c'.repeat(40), liveChecks: [] })).live).toBe(false);
    expect(
      (await verifyLive(deps({ revision: 'e'.repeat(40), contains: async () => false }), { mergeSha: 'c'.repeat(40), liveChecks: [] })).live,
    ).toBe(false);
    expect(
      (await verifyLive(deps({ revision: 'e'.repeat(40), contains: async () => null }), { mergeSha: 'c'.repeat(40), liveChecks: [] })).live,
    ).toBe(false);
  });
});

describe('the status a person reads', () => {
  const campaign = { state: 'EXECUTING', stageDetail: 'two units running', integrationSha: HEAD, prUrl: null, blockerKind: null, blockerDetail: null } as unknown as FactoryCampaign;
  it('maps every stage, and a PR alone is never LIVE', () => {
    expect(deriveOutcome({ campaign, grant: null, latestRun: null, origin: null }).status).toBe('BUILDING');
    expect(deriveOutcome({ campaign: { ...campaign, state: 'ASSEMBLING' }, grant: null, latestRun: null, origin: null }).status).toBe('VERIFYING');
    const complete = { ...campaign, state: 'COMPLETE', prUrl: `${REMOTE}/pull/77` } as FactoryCampaign;
    const manual = deriveOutcome({ campaign: complete, grant: null, latestRun: null, origin: null });
    expect(manual).toMatchObject({ status: 'BLOCKED', needsPerson: true });
    const grantRow = { revokedAt: null, pagePath: '/build' } as ReleaseGrant;
    expect(deriveOutcome({ campaign: complete, grant: grantRow, latestRun: null, origin: null }).status).toBe('VERIFYING');
    const merged = { state: 'MERGED', headSha: HEAD } as ReleaseRun;
    expect(deriveOutcome({ campaign: complete, grant: grantRow, latestRun: merged, origin: null }).status).toBe('RELEASING');
    const stale = { state: 'LIVE', headSha: 'f'.repeat(40) } as ReleaseRun;
    expect(deriveOutcome({ campaign: complete, grant: grantRow, latestRun: stale, origin: null }).status).not.toBe('LIVE');
    const surface = { ...campaign, state: 'BLOCKED', blockerKind: 'NO_HEALTHY_EXECUTION_SURFACE', blockerDetail: 'no surface' } as FactoryCampaign;
    expect(deriveOutcome({ campaign: surface, grant: null, latestRun: null, origin: null })).toMatchObject({
      status: 'BLOCKED',
      needsPerson: false,
      blocker: 'no surface',
    });
  });
});

describe('the last moment a merge can be stopped', () => {
  it('refuses the merge once the owner withdraws the grant during the gate', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    stubForge(['client/src/russell/Build.tsx']);
    const plan = await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf1' });
    const runId = plan.action?.runId ?? '';
    expect(await mayMerge(runId)).toEqual({ ok: true, reasons: [] });

    expect(await withdrawAutomaticRelease({ changeRequestId: changeRequest.id, userId: adminId, reason: 'not today' })).toBe(true);
    const answer = await mayMerge(runId);
    expect(answer.ok).toBe(false);
    expect(answer.reasons.join(' ')).toMatch(/withdrew automatic release/);

    // The workflow records that as a non-retryable GATE failure, which Brain shows as a person's blocker.
    expect((await advanceRelease({ runId, to: 'FAILED', failureStage: 'GATE', failureDetail: answer.reasons.join(' ') })).moved).toBe(true);
    const outcome = await objectiveOutcome(campaign);
    expect(outcome).toMatchObject({ status: 'BLOCKED', needsPerson: true });
    // With the grant gone the objective reads as a person's to merge; the attempt keeps why it stopped.
    expect(outcome.blocker).toMatch(/person’s decision/);
    expect((await latestRun(campaign.id))?.failureDetail).toMatch(/withdrew/);
    expect((await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf2' })).action).toBeNull();
  });

  it('refuses the merge when the campaign moved to another head after the gate', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    stubForge(['client/src/russell/Build.tsx']);
    const runId = (await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf1' })).action?.runId ?? '';
    await patchCampaign(campaign.id, { integrationSha: 'e'.repeat(40) });
    expect((await mayMerge(runId)).reasons.join(' ')).toMatch(/another head/);
  });

  it('a runner failure past the attempt ceiling reads as a blocker, not as "will be tried again"', async () => {
    const changeRequest = await approved();
    const campaign = await completeCampaign(changeRequest);
    const base = { id: 'rr', campaignId: campaign.id, headSha: HEAD, state: 'FAILED', failureStage: 'INFRA', failureDetail: 'runner died' } as ReleaseRun;
    const grantRow = await grant(changeRequest.id);
    expect(deriveOutcome({ campaign, grant: grantRow, latestRun: { ...base, attempt: 1 }, origin: null }).status).toBe('RELEASING');
    expect(deriveOutcome({ campaign, grant: grantRow, latestRun: { ...base, attempt: 3 }, origin: null })).toMatchObject({ status: 'BLOCKED', needsPerson: true });
  });

  it('a rollback whose revert could not land stays FAILED with what a person must do', async () => {
    const changeRequest = await approved();
    await completeCampaign(changeRequest);
    await grant(changeRequest.id);
    stubForge(['client/src/russell/Build.tsx']);
    const runId = (await planRelease({ releasableRepository: 'Peyday007/V5', workflowRunId: 'wf1' })).action?.runId ?? '';
    await advanceRelease({ runId, to: 'MERGED', mergeSha: 'c'.repeat(40) });
    await advanceRelease({ runId, to: 'DEPLOYING', deployRunId: '9' });
    await advanceRelease({ runId, to: 'VERIFYING' });
    // Verification failed: FAILED first, which is what lets ROLLED_BACK follow.
    expect((await advanceRelease({ runId, to: 'ROLLED_BACK' })).moved).toBe(false);
    expect((await advanceRelease({ runId, to: 'FAILED', failureStage: 'VERIFY', failureDetail: 'verification failed' })).moved).toBe(true);
    const restamped = await advanceRelease({ runId, to: 'FAILED', failureStage: 'VERIFY', failureDetail: 'the revert is open as pull request #12; a person merges it' });
    expect(restamped.moved).toBe(true);
    expect(restamped.run?.failureDetail).toMatch(/pull request #12/);
  });
});

describe('the release workflow’s own readings', () => {
  it('scans for reserved paths and credentials in added lines', () => {
    expect(scanDiff(['client/a.tsx'], ['const greeting = "hi";']).ok).toBe(true);
    expect(scanDiff(['fly.toml'], []).ok).toBe(false);
    expect(scanDiff(['client/a.tsx'], [`const k = "ghp_${'x'.repeat(36)}";`]).ok).toBe(false);
    expect(scanDiff([], []).ok).toBe(false);
  });

  it('reads whether a Deploy run released from its own steps', () => {
    expect(deployReleased([{ name: 'Record what was released', conclusion: 'success' }])).toBe(true);
    expect(deployReleased([{ name: 'Record what was released', conclusion: 'skipped' }])).toBe(false);
    expect(deployReleased([{ name: 'Deploy', conclusion: 'failure' }])).toBe(false);
  });

  it('never rolls back for a Deploy that was cancelled rather than failed', () => {
    // Evicted from the pending slot by a newer Deploy that contains the merge: adopt it.
    expect(onCancelledDeploy({ released: false, successorRunId: 435, cancelledSoFar: 1 })).toEqual({ kind: 'ADOPT', runId: 435 });
    // Cancelled after the image was released: verify the live Brain, which decides.
    expect(onCancelledDeploy({ released: true, successorRunId: null, cancelledSoFar: 1 })).toEqual({ kind: 'VERIFY' });
    // Nothing else deploys it: dispatch again, a bounded number of times.
    expect(onCancelledDeploy({ released: false, successorRunId: null, cancelledSoFar: 1 })).toEqual({ kind: 'REDISPATCH' });
    expect(onCancelledDeploy({ released: false, successorRunId: null, cancelledSoFar: MAX_CANCELLED_DEPLOYS })).toEqual({ kind: 'STOP' });
    // And the script still rolls back a Deploy that genuinely failed.
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    const body = script.slice(script.indexOf('async function fromDeploying'), script.indexOf('async function fromMerged'));
    expect(body).toMatch(/watched\.conclusion === 'cancelled'/);
    expect(body).toMatch(/stage: 'DEPLOY'[\s\S]*rollBack\(/);
  });

  it('merges onto a moved production only when the movement is disjoint from the change', () => {
    const change = ['client/src/russell/Build.tsx', 'tests/buildRepositoriesReleaseSentence.test.tsx'];
    const ok = { fastForward: true, changeFiles: change, remergedCleanly: true };
    expect(onProductionMoved({ ...ok, productionFiles: ['server/services/cash/x.ts', 'CLAUDE.md'] })).toEqual({ ok: true });
    // Production touched a file the change touches: the tested tree says nothing about the combination.
    const overlap = onProductionMoved({ ...ok, productionFiles: ['client/src/russell/Build.tsx'] });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.reason).toMatch(/Build\.tsx/);
    // A rewound branch, an unclean re-merge or an empty change re-gate as before.
    expect(onProductionMoved({ ...ok, fastForward: false, productionFiles: ['a.ts'] }).ok).toBe(false);
    expect(onProductionMoved({ ...ok, remergedCleanly: false, productionFiles: ['a.ts'] }).ok).toBe(false);
    expect(onProductionMoved({ ...ok, changeFiles: [], productionFiles: ['a.ts'] }).ok).toBe(false);
    // And the forge's merge must still produce exactly the tree Brain expected.
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    expect(script).toMatch(/treeOf\(mergeSha\) !== expectedTree/);
  });

  it('a pull request that is not a Factory campaign never takes the release slot', () => {
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    const group = /^concurrency:\n(?:.*\n)*?\s*group:\s*(.+)$/m.exec(workflow)?.[1] ?? '';
    // A run that can release anything shares the one group; an ignored pull request event does not.
    expect(group.startsWith('brain-factory-release')).toBe(true);
    expect(group).toMatch(/github\.event_name == 'pull_request_target'/);
    expect(group).toMatch(/startsWith\(github\.event\.pull_request\.head\.ref, 'factory\/campaign\/'\)/);
    expect(group).toMatch(/github\.run_id/);
    // The same condition the plan job applies, so the two cannot disagree about what is ignored.
    expect(workflow).toMatch(/startsWith\(github\.event\.pull_request\.head\.ref, 'factory\/campaign\/'\) &&\s*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  });

  it('does not roll back for a hosted-verification failure the previous release already had, or an unknown', () => {
    const base = { released: true, complete: true, failing: ['the Brain keeps answering while a run executes'] };
    // The same condition failed before the merge: not the change's doing.
    expect(judgeReleasedVerdict({ released: true, complete: true, failing: ['the Brain keeps answering while a run executes'] }, base).countsAgainst).toBe(false);
    // A condition that was passing before is the change's, and still rolls back.
    const added = judgeReleasedVerdict({ released: true, complete: true, failing: ['a new check'] }, base);
    expect(added.countsAgainst).toBe(true);
    // A verification that never reached a verdict is unknown (Deploy 444: Supabase 429), not a failure.
    expect(judgeReleasedVerdict({ released: true, complete: false, failing: ['the work left before the restart is still there'] }, null).countsAgainst).toBe(false);
    expect(judgeReleasedVerdict(null, null).countsAgainst).toBe(false);
    // A complete failure with nothing to compare against still counts, as does an unnamed one.
    expect(judgeReleasedVerdict({ released: true, complete: true, failing: ['x'] }, null).countsAgainst).toBe(true);
    expect(judgeReleasedVerdict({ released: true, complete: true, failing: ['x'] }, { ...base, complete: false, failing: ['x'] }).countsAgainst).toBe(true);
    expect(judgeReleasedVerdict({ released: true, complete: true, failing: [] }, base).countsAgainst).toBe(true);
    // Deploy records the names it compares, and the release reads them only for a released, failed Deploy.
    const deploy = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(deploy).toMatch(/'failing': sorted\(failing\)/);
    expect(deploy).toMatch(/'complete': complete/);
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    expect(script).toMatch(/watched\.conclusion === 'failure' && watched\.released/);
    // And a rollback whose revert did not land never prints ROLLED_BACK.
    expect(script).toMatch(/rolled \? `RELEASE: ROLLED_BACK \$\{action\.runId\}` : `RELEASE: FAILED \$\{action\.runId\}`/);
  });

  it('reads an older release\'s failures from its log, and a tip refusal as nothing released', () => {
    const log = [
      '2026-10-11T21:47:21.07Z HOSTED-VERIFICATION: FAIL 262/263',
      '2026-10-11T21:47:21.07Z   FAIL  a run past its 20 s budget is ended — state=COMPLETE wall=20540ms',
      '2026-10-11T21:47:21.08Z   FAILED  a run past its 20 s budget is ended — state=COMPLETE',
      '2026-10-11T21:47:21.09Z   FAIL  the Brain keeps answering — healthz max=8400ms',
      "2026-10-11T21:47:21.09Z [36;1m  grep -E '^ *(FAIL|Hosted verification could not complete)' file",
    ].join('\n');
    expect(verificationFromLog(log, true)).toEqual({
      released: true,
      complete: true,
      failing: ['a run past its 20 s budget is ended', 'the Brain keeps answering'],
    });
    expect(verificationFromLog('x HOSTED-VERIFICATION: FAIL could-not-complete', true).complete).toBe(false);
    expect(verificationFromLog('nothing printed', true).complete).toBe(false);
    expect(deployRefusedAtTip([{ name: 'The ref must still be the canonical tip, now', conclusion: 'failure' }])).toBe(true);
    expect(deployRefusedAtTip([{ name: 'The ref must still be the canonical tip, now', conclusion: 'success' }])).toBe(false);
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    expect(readDeploy({ conclusion: 'failure', released: false, refusedAtTip: true, superseded: false })).toBe('NOT_RELEASED');
    expect(script).toMatch(/const notReleasedNoVerdict = reading === 'NOT_RELEASED'/);
  });

  it('every Deploy, however it was dispatched, wakes a waiting Factory release exactly once (FAC-4)', () => {
    // A Deploy dispatched with GITHUB_TOKEN raises no workflow_run, so the release's own trigger
    // could never fire for the Deploy a release dispatched itself — the hand-off covers that one.
    // A Deploy a person dispatched raises workflow_run, so handing off there too made two passes.
    const deploy = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
    const job = deploy.slice(deploy.indexOf('\n  hand-off:'));
    expect(job).toMatch(/needs: deploy/);
    expect(job).toMatch(/if: \$\{\{ always\(\) && \(github\.triggering_actor \|\| github\.actor\) == 'github-actions\[bot\]' \}\}/);
    const release0 = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    expect(release0).toMatch(/^  workflow_run:\n    workflows: \[Deploy\]\n    types: \[completed\]/m);
    expect(job).toMatch(/actions: write/);
    expect(job).toMatch(/gh workflow run factory-release\.yml/);
    // It dispatches and holds nothing else: no environment, no deployment credential.
    expect(job).not.toMatch(/environment:|FLY_API_TOKEN|contents: write/);
    const release = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    expect(release).toMatch(/workflow_dispatch:/);
  });

  it('asks for its own resume after a failure, a bounded number of times', () => {
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    const step = workflow.slice(workflow.indexOf('Ask for the pass that resumes this one'));
    expect(step).toMatch(/if: \$\{\{ failure\(\) \}\}/);
    expect(step).toMatch(/"\$DEPTH" -ge 3/);
    expect(step).toMatch(/gh workflow run factory-release\.yml --ref production/);
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    // A transient forge error is retried rather than ending the run.
    expect(script).toMatch(/attempt <= 5/);
    // A Deploy whose head merely contains the merge is adopted, not refused.
    expect(script).toMatch(/merge-base', '--is-ancestor'/);
  });

  it('is triggered by the Factory’s own pull request, from the base branch, and by nobody else’s', () => {
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    // pull_request_target runs the base branch's workflow file, never the PR's.
    expect(workflow).toMatch(/^  pull_request_target:/m);
    expect(workflow).not.toMatch(/^  pull_request:/m);
    expect(workflow).not.toMatch(/^  push:/m);
    expect(workflow).toContain("startsWith(github.event.pull_request.head.ref, 'factory/campaign/')");
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    // The release job runs only the trusted checkout of the canonical branch.
    const release = workflow.slice(workflow.indexOf('  release:'));
    expect(release).toMatch(/ref: production/);
    expect(release).not.toMatch(/github\.event\.pull_request\.head\.sha/);
  });

  it('the workflow never force-pushes, never runs flyctl deploy, and runs the change only without secrets', () => {
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    expect(workflow).not.toMatch(/--force|-f\s+origin|\+refs\/heads/);
    expect(script).not.toMatch(/'--force'|'-f'|\+refs\/heads/);
    expect(workflow).not.toMatch(/^\s*flyctl\s+deploy\b/m);
    // A job or step conditioned on always() cannot be cancelled, so nobody could stop a release.
    expect(workflow.split('\n').filter((line) => /^\s*if:.*always\(\)/.test(line))).toEqual([]);
    expect(script).not.toMatch(/'deploy',\s*'--app'/);
    const gate = workflow.slice(workflow.indexOf('  gate:'), workflow.indexOf('  release:'));
    expect(gate).not.toMatch(/secrets\./);
    expect(gate).toMatch(/persist-credentials: false/);
    expect(gate).toMatch(/contents: read/);
    expect(gate).toMatch(/npm run test:impacted/);
  });

  it('every test gate finishes before anything merges, the Postgres half included', () => {
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    const gate = workflow.slice(workflow.indexOf('  gate:'), workflow.indexOf('  release:'));
    const release = workflow.slice(workflow.indexOf('  release:'));
    // The whole suite against Postgres runs in the gate, from the trusted copy of the cluster script.
    expect(gate).toMatch(/sh \.\.\/trusted\/scripts\/test-postgres\.sh run -- npx vitest run/);
    expect(gate).toMatch(/POSTGRES: \$\{\{ steps\.postgres\.outcome \}\}/);
    // The release job runs only after the gate; nothing in it starts a test suite alongside Deploy.
    expect(release).toMatch(/needs: \[plan, gate\]/);
    // It never runs or dispatches the suite itself; it may only attest, as the
    // `brain/postgres-suite` status, the tree its own gate already ran it on (FAC-7).
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    for (const text of [release, script]) {
      expect(text).not.toMatch(/postgres-suite\.yml|workflow run postgres-suite|test-postgres\.sh/);
    }
    expect(script).toMatch(/POSTGRES_STATUS_CONTEXT = 'brain\/postgres-suite'/);
    expect(script).toMatch(/if \(!movedNote\) await attestPostgres\(mergeSha\)/);
    expect(release).toMatch(/statuses: write/);
  });

  it('merges through the pull request, never by pushing to the protected branch', () => {
    const script = fs.readFileSync('scripts/factory-release.ts', 'utf8');
    expect(script).toMatch(/'PUT',\s*`\/repos\/\$\{REPO\}\/pulls\/\$\{action\.prNumber\}\/merge`/);
    expect(script).not.toMatch(/refs\/heads\/production/);
    // The merge is asked about immediately before it happens, and the merged tree must be the tested tree.
    expect(script.indexOf("brain(['release-may-merge'")).toBeGreaterThan(-1);
    // The tree it must be is the gated tree, or the reviewed head re-merged onto a moved production.
    expect(script).toMatch(/let expectedTree = treeOf\(gated\)/);
    expect(script).toMatch(/treeOf\(mergeSha\) !== expectedTree/);
    const workflow = fs.readFileSync('.github/workflows/factory-release.yml', 'utf8');
    expect(workflow).toMatch(/pull-requests: write/);
  });

  it('the Postgres runner never puts its cluster where its owner cannot reach it', () => {
    const runner = fs.readFileSync('scripts/test-postgres.sh', 'utf8');
    expect(runner).toMatch(/if \[ "\$\(id -u\)" = "0" \] \|\| \[ "\$\{#TMP_BASE\}" -gt 60 \]; then\n\s*TMP_BASE=\/tmp/);
  });
});
