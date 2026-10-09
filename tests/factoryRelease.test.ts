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
import { advanceRelease, planRelease } from '../server/services/factory/release/plan.ts';
import { authorizeAutomaticRelease, ReleaseGrantError, validateLiveChecks } from '../server/services/factory/release/grant.ts';
import { deriveOutcome, objectiveOutcome } from '../server/services/factory/release/outcome.ts';
import { verifyLive, type VerifyDeps } from '../server/services/factory/release/verify.ts';
import { latestRun, listRuns, openRun } from '../server/repos/factoryRelease.ts';
import { forbiddenPathsFor } from '../server/services/factory/forbidden.ts';
import { scanDiff } from '../scripts/release-scan.ts';
import { deployReleased } from '../scripts/factory-release.ts';
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
});
