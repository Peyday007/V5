/**
 * The execution plane: a hosted factory with no checkout of its own.
 *
 * Everything here is about one question — *can Brain believe what a worker
 * somewhere else says it did, without holding the tree?* — so every test below
 * either proves a refusal or proves that a belief was answered by the repository
 * rather than by the report.
 *
 * The forge is stubbed rather than reached, and the stub is the point: each test
 * decides exactly what the repository says and then checks that Brain's decision
 * follows from that and from nothing else. A test that let the real forge answer
 * would be testing GitHub's uptime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import {
  advanceUnitAttempt,
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  getCampaign,
  getUnitByKey,
  listUnits,
  markImplemented,
  claimUnits,
} from '../server/repos/factory.ts';
import {
  assignNextBin,
  createBin,
  finishBin,
  getBin,
  listBins,
  putBinUnitResult,
} from '../server/repos/bins.ts';
import { binAdmission } from '../server/services/bins/service.ts';
import { recordFactoryEvent } from '../server/repos/factoryFleet.ts';
import {
  decideRepository,
  listRepositoryGrants,
} from '../server/services/factory/repositoryEnvelope.ts';
import {
  parseDeliveryReport,
  parseIntegrationReport,
  parseUnitReport,
} from '../server/services/factory/remoteReport.ts';
import {
  campaignSpecFor,
  executionModeFor,
  reviewLineage,
  roundBaseFor,
  verifyIntegrationReport,
  verifyUnitReport,
} from '../server/services/factory/remote.ts';
import { parseRemote } from '../server/services/factory/forge.ts';
import { validatePlan } from '../server/services/factory/planner.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import type { FactoryChangeRequest } from '../server/domain/factory.ts';
import type { Principal } from '../server/domain/types.ts';

const OAKWOOD = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

let fixture: TestProject;
let realFetch: typeof globalThis.fetch;
/** A real person, because approving is a person's act and the row has a key. */
let approverId = '';

/** What the stub forge should answer, per path fragment. */
interface ForgeScript {
  branches?: Record<string, string>;
  compares?: Record<string, { files: string[]; status: string }>;
  pulls?: { number: number; headRef: string; headSha: string; baseRef: string }[];
  files?: Record<string, string>;
  checks?: { name: string; status: string; conclusion: string | null }[];
}

function stubForge(script: ForgeScript): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const branch = /\/git\/ref\/heads\/(.+)$/.exec(url);
    if (branch) {
      const name = decodeURIComponent(branch[1] ?? '');
      const sha = script.branches?.[name];
      return sha
        ? json({ ref: `refs/heads/${name}`, object: { sha } })
        : json({ message: 'Not Found' }, 404);
    }
    const compare = /\/compare\/(.+)\.\.\.(.+)$/.exec(url);
    if (compare) {
      const key = `${decodeURIComponent(compare[1] ?? '')}...${decodeURIComponent(compare[2] ?? '')}`;
      const answer = script.compares?.[key];
      if (!answer) return json({ message: 'Not Found' }, 404);
      return json({
        status: answer.status,
        ahead_by: 1,
        base_commit: { sha: decodeURIComponent(compare[1] ?? '') },
        files: answer.files.map((filename) => ({ filename })),
      });
    }
    if (url.includes('/pulls?')) {
      const head = /head=([^&]+)/.exec(url);
      const wanted = decodeURIComponent(head?.[1] ?? '').split(':')[1] ?? '';
      const found = (script.pulls ?? []).filter((pull) => pull.headRef === wanted);
      return json(
        found.map((pull) => ({
          number: pull.number,
          state: 'open',
          html_url: `https://github.com/x/y/pull/${pull.number}`,
          title: 'an open request',
          updated_at: '2026-09-11T00:00:00Z',
          head: { sha: pull.headSha, ref: pull.headRef },
          base: { ref: pull.baseRef },
        })),
      );
    }
    const pull = /\/pulls\/(\d+)$/.exec(url);
    if (pull) {
      const number = Number(pull[1]);
      const found = (script.pulls ?? []).find((candidate) => candidate.number === number);
      if (!found) return json({ message: 'Not Found' }, 404);
      return json({
        number,
        state: 'open',
        html_url: `https://github.com/x/y/pull/${number}`,
        title: 'an open request',
        updated_at: '2026-09-11T00:00:00Z',
        head: { sha: found.headSha, ref: found.headRef },
        base: { ref: found.baseRef },
      });
    }
    if (url.includes('/check-runs')) {
      return json({ check_runs: script.checks ?? [] });
    }
    const contents = /\/contents\/([^?]+)/.exec(url);
    if (contents) {
      const name = decodeURIComponent(contents[1] ?? '');
      const body = script.files?.[name];
      if (body === undefined) return json({ message: 'Not Found' }, 404);
      return json({ content: Buffer.from(body, 'utf8').toString('base64'), encoding: 'base64' });
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return json({ default_branch: 'main' });
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  fixture = await freshProject();
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  approverId = (
    await createUser({
      email: `approver-${Math.random().toString(36).slice(2)}@example.test`,
      displayName: 'An approver',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
      createdByType: 'SYSTEM',
      createdById: 't',
    })
  ).id;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  await teardown();
});

/* ========================================================================= */

describe('the repository envelope', () => {
  it('authorizes the repository it names and refuses one it does not', () => {
    expect(decideRepository(OAKWOOD).ok).toBe(true);
    // Trailing slash, .git suffix and case are all the same repository.
    expect(decideRepository(`${OAKWOOD}.git`).ok).toBe(true);
    expect(decideRepository(`${OAKWOOD}/`).ok).toBe(true);
    expect(decideRepository(OAKWOOD.toUpperCase()).ok).toBe(true);

    const refused = decideRepository('https://github.com/Peyday007/V5');
    expect(refused.ok).toBe(false);
    expect(refused.grant).toBeNull();
  });

  it('refuses without enumerating what else it would have allowed', () => {
    const refused = decideRepository('https://github.com/someone/else');
    expect(refused.reason).toBeTruthy();
    // A refusal that listed the authorized set would describe the factory's
    // reach to a caller with no business knowing it.
    for (const grant of listRepositoryGrants()) {
      expect(refused.reason).not.toContain(grant.remote);
    }
  });

  it('keeps the factory out of its own repository', () => {
    expect(listRepositoryGrants().some((grant) => /\/V5$/i.test(grant.remote))).toBe(false);
  });
});

/* ========================================================================= */

describe('a remote is parsed structurally, never guessed at', () => {
  it('takes an https github remote naming exactly one owner and repository', () => {
    expect(parseRemote(OAKWOOD)?.slug).toBe('Peyday007/oakwood-junk-removal');
    expect(parseRemote(`${OAKWOOD}.git`)?.slug).toBe('Peyday007/oakwood-junk-removal');
  });

  it('refuses anything else', () => {
    expect(parseRemote('git@github.com:a/b.git')).toBeNull();
    expect(parseRemote('https://gitlab.com/a/b')).toBeNull();
    expect(parseRemote('https://github.com/a')).toBeNull();
    expect(parseRemote('https://github.com/a/b/c')).toBeNull();
    expect(parseRemote('')).toBeNull();
  });
});

/* ========================================================================= */

describe('a report is refused whole, never partly believed', () => {
  const unit = {
    unitKey: 'u',
    outcome: 'IMPLEMENTED',
    branch: 'b',
    headSha: HEAD,
    filesChanged: ['x.ts'],
    commands: [{ command: 'npm test', exitCode: 0 }],
    summary: 'did it',
  };

  it('refuses a unit report carrying a field the contract does not define', () => {
    const parsed = parseUnitReport({ ...unit, confidence: 0.9 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(' ')).toContain('confidence');
  });

  it('refuses a head that is not a commit sha', () => {
    expect(parseUnitReport({ ...unit, headSha: 'HEAD' }).ok).toBe(false);
    expect(parseUnitReport({ ...unit, headSha: HEAD.toUpperCase() }).ok).toBe(false);
  });

  it('refuses a BLOCKED unit that does not say why', () => {
    expect(parseUnitReport({ ...unit, outcome: 'BLOCKED' }).ok).toBe(false);
    expect(
      parseUnitReport({ ...unit, outcome: 'BLOCKED', blockedReason: 'no network' }).ok,
    ).toBe(true);
  });

  const integration = {
    outcome: 'IMPLEMENTED',
    integrationBranch: 'factory/campaign/c',
    headSha: HEAD,
    merged: [{ unitKey: 'u', branch: 'b', headSha: BASE }],
    conflicts: [],
    commands: [{ command: 'npm test', exitCode: 0 }],
    summary: 'merged one',
  };

  it('refuses an integration that names one unit twice', () => {
    const parsed = parseIntegrationReport({
      ...integration,
      merged: [
        { unitKey: 'u', branch: 'b', headSha: BASE },
        { unitKey: 'u', branch: 'b2', headSha: HEAD },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('refuses an integration that claims to have landed nothing', () => {
    expect(parseIntegrationReport({ ...integration, merged: [] }).ok).toBe(false);
    // The honest form of that is BLOCKED with a reason, and it is accepted.
    expect(
      parseIntegrationReport({
        ...integration,
        outcome: 'BLOCKED',
        merged: [],
        blockedReason: '`npm test` exited 1 on the merged tree',
      }).ok,
    ).toBe(true);
  });

  it('refuses a delivered pull request with no number', () => {
    expect(
      parseDeliveryReport({
        outcome: 'IMPLEMENTED',
        pullRequest: null,
        headSha: HEAD,
        action: 'UPDATED',
        summary: 'done',
      }).ok,
    ).toBe(false);
    expect(
      parseDeliveryReport({
        outcome: 'IMPLEMENTED',
        pullRequest: 1,
        headSha: HEAD,
        action: 'UPDATED',
        summary: 'done',
      }).ok,
    ).toBe(true);
  });
});

/* ========================================================================= */

describe('a unit is believed only as far as the forge confirms it', () => {
  const repository = parseRemote(OAKWOOD)!;
  const report = {
    unitKey: 'u',
    outcome: 'IMPLEMENTED' as const,
    branch: 'factory/c/u/a1',
    headSha: HEAD,
    filesChanged: ['index.html'],
    commands: [],
    summary: 's',
    blockedReason: null,
  };

  it('refuses a branch Brain did not name', async () => {
    stubForge({});
    const verdict = await verifyUnitReport(
      repository,
      { branch: 'factory/c/u/a2', baseSha: BASE, ownedPaths: ['**'] },
      report,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('factory/c/u/a2');
  });

  it('refuses a file the unit does not own, and names it', async () => {
    stubForge({
      branches: { 'factory/c/u/a1': HEAD },
      compares: { [`${BASE}...${HEAD}`]: { files: ['index.html', 'deploy.sh'], status: 'ahead' } },
    });
    const verdict = await verifyUnitReport(
      repository,
      { branch: 'factory/c/u/a1', baseSha: BASE, ownedPaths: ['index.html'] },
      report,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('deploy.sh');
  });

  it('fails closed when the forge truncates the file list', async () => {
    const many = Array.from({ length: 300 }, (_, index) => `src/file-${index}.ts`);
    stubForge({
      branches: { 'factory/c/u/a1': HEAD },
      compares: { [`${BASE}...${HEAD}`]: { files: many, status: 'ahead' } },
    });
    const verdict = await verifyUnitReport(
      repository,
      { branch: 'factory/c/u/a1', baseSha: BASE, ownedPaths: ['src/**'] },
      report,
    );
    // Every one of those files is inside the declared scope. It is still refused,
    // because a capped list cannot prove the thing the check exists to prove.
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('truncated');
  });

  it('accepts a report the repository agrees with', async () => {
    stubForge({
      branches: { 'factory/c/u/a1': HEAD },
      compares: { [`${BASE}...${HEAD}`]: { files: ['index.html'], status: 'ahead' } },
    });
    const verdict = await verifyUnitReport(
      repository,
      { branch: 'factory/c/u/a1', baseSha: BASE, ownedPaths: ['index.html'] },
      report,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.files).toEqual(['index.html']);
  });
});

/* ========================================================================= */

describe('an integration must carry the work it names', () => {
  const repository = parseRemote(OAKWOOD)!;
  const unitHead = 'c'.repeat(40);
  const integrationHead = 'd'.repeat(40);
  const report = {
    outcome: 'IMPLEMENTED' as const,
    integrationBranch: 'factory/campaign/c1',
    headSha: integrationHead,
    merged: [{ unitKey: 'u', branch: 'factory/c1/u/a1', headSha: unitHead }],
    conflicts: [],
    commands: [{ command: 'npm test', exitCode: 0 }],
    summary: 'merged',
    blockedReason: null,
  };
  const expected = {
    integrationBranch: 'factory/campaign/c1',
    baseSha: BASE,
    units: [{ unitKey: 'u', headSha: unitHead, ownedPaths: ['index.html'] }],
  };

  it('refuses an integration commit that does not contain the unit', async () => {
    stubForge({
      branches: { 'factory/campaign/c1': integrationHead },
      compares: {
        [`${unitHead}...${integrationHead}`]: { files: [], status: 'diverged' },
        [`${BASE}...${integrationHead}`]: { files: ['index.html'], status: 'ahead' },
      },
    });
    const verdict = await verifyIntegrationReport(repository, expected, report);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('diverged');
    expect(verdict.carried).toEqual([]);
  });

  it('refuses an integration that touched a path no merged unit declared', async () => {
    stubForge({
      branches: { 'factory/campaign/c1': integrationHead },
      compares: {
        [`${unitHead}...${integrationHead}`]: { files: [], status: 'ahead' },
        [`${BASE}...${integrationHead}`]: {
          files: ['index.html', '.github/workflows/deploy.yml'],
          status: 'ahead',
        },
      },
    });
    const verdict = await verifyIntegrationReport(repository, expected, report);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('deploy.yml');
  });

  it('refuses a commit the forge does not agree the branch is at', async () => {
    stubForge({
      branches: { 'factory/campaign/c1': 'e'.repeat(40) },
      compares: {
        [`${unitHead}...${'e'.repeat(40)}`]: { files: [], status: 'ahead' },
        [`${BASE}...${'e'.repeat(40)}`]: { files: ['index.html'], status: 'ahead' },
      },
    });
    const verdict = await verifyIntegrationReport(repository, expected, report);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('Brain believes the repository');
  });

  it('accepts one the repository agrees with, and says what it carried', async () => {
    stubForge({
      branches: { 'factory/campaign/c1': integrationHead },
      compares: {
        [`${unitHead}...${integrationHead}`]: { files: [], status: 'identical' },
        [`${BASE}...${integrationHead}`]: { files: ['index.html'], status: 'ahead' },
      },
    });
    const verdict = await verifyIntegrationReport(repository, expected, report);
    expect(verdict.ok).toBe(true);
    expect(verdict.carried).toEqual(['u']);
  });
});

/* ========================================================================= */

describe('how a campaign is created is derived, never supplied', () => {
  async function contract(over: Partial<FactoryChangeRequest> = {}): Promise<FactoryChangeRequest> {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `k-${Math.random().toString(36).slice(2)}`,
      objective: 'Make something true that is not true now.',
      expectedOutcome: 'A person would see it.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline the request',
      verificationCommands: ['npm test'],
      ...over,
    });
    return changeRequest;
  }

  it('reads REMOTE from the absence of a checkout, not from a flag', async () => {
    expect(executionModeFor(await contract())).toBe('REMOTE');
    expect(executionModeFor(await contract({ repositoryRoot: '/some/checkout' }))).toBe('LOCAL');
  });

  it('continues the pull request whose head the contract is pinned at', async () => {
    stubForge({
      pulls: [
        { number: 1, headRef: 'factory/campaign/old', headSha: BASE, baseRef: 'main' },
      ],
    });
    const spec = await campaignSpecFor(await contract({ baseBranch: 'factory/campaign/old' }));
    expect(spec.pullRequest).toBe(1);
    expect(spec.integrationBranch).toBe('factory/campaign/old');
    expect(spec.note).toContain('#1');
  });

  it('opens a new one when the branch is nobody\'s head', async () => {
    stubForge({ pulls: [] });
    const spec = await campaignSpecFor(await contract());
    expect(spec.pullRequest).toBeNull();
    expect(spec.integrationBranch).toBeNull();
  });
});

/* ========================================================================= */

describe('a plan may not reach where the repository grant forbids', () => {
  it('refuses a unit owning a path the grant puts out of reach', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'forbidden',
      objective: 'Change the deployment workflow.',
      expectedOutcome: 'It deploys differently.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'it deploys', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    const plan = {
      units: [
        {
          key: 'deploy-change',
          kind: 'IMPLEMENTATION',
          title: 'Change the deploy workflow',
          objective: 'Rewrite the deployment workflow so that it deploys somewhere else entirely.',
          acceptance: ['the workflow changed'],
          ownedPaths: ['.github/workflows/deploy.yml'],
          requiredContext: [],
          verification: ['npm test'],
          expectedArtifact: 'a changed workflow',
          risk: 'LOW',
          criticalPath: true,
          dependsOn: [],
          serves: ['A01'],
        },
      ],
    };
    const validation = validatePlan(plan, changeRequest);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('out of the factory');
  });
});

/* ========================================================================= */

describe('the hosted tick hands out one stage at a time', () => {
  let campaignId = '';
  let workerId = '';

  beforeEach(async () => {
    workerId = (await createWorker({ name: 'fleet-one', createdByType: 'SYSTEM', createdById: 't' }))
      .id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'tick',
      objective: 'Guard the quote form against silent breakage.',
      expectedOutcome: 'npm test fails when the form contract breaks.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'the suite asserts the form', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: approverId, authorityId: null });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 2,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    campaignId = campaign.id;
  });

  it('creates one plan bin, and a second tick creates no second one', async () => {
    stubForge({});
    const first = await tickRemoteCampaign(campaignId);
    expect(first.created.some((entry) => entry.startsWith('plan:'))).toBe(true);

    const second = await tickRemoteCampaign(campaignId);
    expect(second.created).toEqual([]);
    const bins = await listBins({ projectId: fixture.project.id });
    expect(bins.filter((bin) => bin.kind === 'FACTORY_PLAN')).toHaveLength(1);
  });

  it('waits for an integrator rather than reviewing work that is only implemented', async () => {
    stubForge({});
    // A unit that has been implemented on its own branch but not integrated.
    const unit = await ensureUnit({
      campaignId,
      unitKey: 'form-contract',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the form contract',
      objective: 'Assert the quote form posts over https to an absolute endpoint.',
      acceptance: ['the suite fails when the endpoint is relative'],
      ownedPaths: ['test/form.test.js'],
      requiredContext: [],
      verification: ['npm test'],
      expectedArtifact: 'a test file',
      risk: 'LOW',
      criticalPath: true,
      priority: 5,
      modelClass: 'FAST',
    });
    const { promoteReadyUnits } = await import('../server/repos/factory.ts');
    await promoteReadyUnits(campaignId);
    const [held] = await claimUnits({
      campaignId,
      workerId,
      unitIds: [unit.unit.id],
      leaseMs: 60_000,
    });
    await markImplemented(
      {
        unitId: unit.unit.id,
        workerId,
        leaseId: held!.leaseId,
        leaseGeneration: held!.leaseGeneration,
      },
      {
        branch: 'factory/x/form-contract/a1',
        headSha: HEAD,
        baseSha: BASE,
        worktreePath: null,
        workerSummary: 'pushed',
        terminalResult: { outcome: 'IMPLEMENTED' },
      },
    );

    const report = await tickRemoteCampaign(campaignId);
    expect(report.created.some((entry) => entry.startsWith('integrate:'))).toBe(true);
    // And not a review: a unit that is only implemented is not part of the
    // campaign yet, so there is nothing for a reviewer to read.
    expect(report.created.some((entry) => entry.startsWith('review:'))).toBe(false);
    expect((await getCampaign(campaignId))?.state).toBe('INTEGRATING');
  });

  it('does not move the campaign head when a unit report is not confirmed', async () => {
    stubForge({ branches: {} });
    const before = await getCampaign(campaignId);
    expect(roundBaseFor(before!)).toBe(BASE);
    expect(before?.integrationSha).toBeNull();
  });
});

/* ========================================================================= */

describe('a refused unit costs an attempt', () => {
  it('charges a READY unit once and stops at its ceiling', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'attempts',
      objective: 'Something bounded enough to judge.',
      expectedOutcome: 'It is visible.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    const created = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'u',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'A unit',
      objective: 'Do one bounded thing that can be judged.',
      acceptance: ['it is done'],
      ownedPaths: ['index.html'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a change',
      risk: 'LOW',
      criticalPath: false,
      priority: 5,
      modelClass: 'FAST',
    });
    // Not READY yet, so nothing is charged: a unit nobody has handed out has
    // nothing to charge for.
    const unit = await getUnitByKey(campaign.id, 'u');
    expect(unit?.state).toBe('BLOCKED');
    expect(await advanceUnitAttempt(created.unit.id)).toBe(false);

    const { promoteReadyUnits } = await import('../server/repos/factory.ts');
    await promoteReadyUnits(campaign.id);
    expect((await getUnitByKey(campaign.id, 'u'))?.state).toBe('READY');

    expect(await advanceUnitAttempt(created.unit.id)).toBe(true);
    expect((await getUnitByKey(campaign.id, 'u'))?.attempt).toBe(1);
    // And it stops at the ceiling rather than charging forever.
    const max = (await getUnitByKey(campaign.id, 'u'))!.maxAttempts;
    for (let i = 1; i < max; i += 1) await advanceUnitAttempt(created.unit.id);
    expect(await advanceUnitAttempt(created.unit.id)).toBe(false);
    expect((await getUnitByKey(campaign.id, 'u'))?.attempt).toBe(max);
  });
});

/* ========================================================================= */

describe('a worker that finishes a factory bin has its report read from rows', () => {
  it('stores the plan a worker submits and leaves it for the loop to validate', async () => {
    stubForge({});
    const workerId = (
      await createWorker({ name: 'fleet-two', createdByType: 'SYSTEM', createdById: 't' })
    ).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'drain',
      objective: 'Guard the lead path against silent breakage.',
      expectedOutcome: 'The suite fails when it breaks.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'the suite asserts it', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: approverId, authorityId: null });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    await tickRemoteCampaign(campaign.id);

    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_PLAN');
    const proof = {
      binId: assigned!.bin.id,
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
      workerId,
    };
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'plan',
      value: JSON.stringify({
        units: [
          {
            key: 'form-contract',
            kind: 'TEST',
            title: 'Assert the quote form contract',
            objective:
              'Add a test that fails when the quote form stops posting over https to an ' +
              'absolute endpoint.',
            acceptance: ['the suite fails when the endpoint is relative'],
            ownedPaths: ['test/form.test.js'],
            requiredContext: [],
            verification: ['npm test'],
            expectedArtifact: 'a test file',
            risk: 'LOW',
            criticalPath: true,
            dependsOn: [],
            serves: ['A01'],
          },
        ],
      }),
      contentHash: 'h1',
      leaseId: proof.leaseId,
      leaseGeneration: proof.leaseGeneration,
    });
    expect(await finishBin(proof, { state: 'COMPLETE', reason: 'planned' })).toBe('OK');

    const report = await tickRemoteCampaign(campaign.id);
    expect(report.ingested.some((entry) => entry.startsWith('plan:'))).toBe(true);
    const units = await listUnits(campaign.id);
    expect(units.map((unit) => unit.unitKey)).toEqual(['form-contract']);
  });
});

/* ========================================================================= */

describe('a reviewer is independent by lineage, or it is refused', () => {
  let campaignId = '';

  beforeEach(async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'lineage',
      objective: 'Something with a review to judge it.',
      expectedOutcome: 'A person sees it.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true },
      ],
      repository: OAKWOOD,
      repositoryRoot: '',
      baseBranch: 'main',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'decline',
      verificationCommands: ['npm test'],
    });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    campaignId = campaign.id;
    // One unit implemented by session A, on worker W1. This is the ledger the
    // independence decision is read from.
    await recordFactoryEvent({
      campaignId,
      kind: 'UNIT_IMPLEMENTED',
      evidenceClass: 'MEASURED',
      sessionId: 'cred-session-A',
      workerId: 'wkr-one',
      detail: { unitKey: 'u' },
    });
  });

  it('refuses the session that wrote the code', async () => {
    const verdict = await reviewLineage(campaignId, {
      sessionId: 'cred-session-A',
      workerId: 'wkr-one',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('cred-session-A');
  });

  it('refuses a reviewer whose session cannot be established at all', async () => {
    // Unknown lineage fails closed: "we could not tell" must never read the same
    // as "we checked".
    const verdict = await reviewLineage(campaignId, { sessionId: null, workerId: 'wkr-two' });
    expect(verdict.ok).toBe(false);
  });

  it('accepts a different session and reports only the tier it earned', async () => {
    const same = await reviewLineage(campaignId, {
      sessionId: 'cred-session-B',
      workerId: 'wkr-one',
    });
    expect(same.ok).toBe(true);
    // Same worker identity, different session: the floor, and not rounded up.
    expect(same.independence).toBe('SESSION_SEPARATED');

    const stronger = await reviewLineage(campaignId, {
      sessionId: 'cred-session-B',
      workerId: 'wkr-two',
    });
    expect(stronger.ok).toBe(true);
    expect(stronger.independence).toBe('WORKER_SEPARATED');
  });
});

/* ========================================================================= */

describe('a bin is not handed to a surface that cannot do it', () => {
  it('refuses a worker whose Routine lacks a capability the bin requires', async () => {
    const workerId = (
      await createWorker({ name: 'no-push', createdByType: 'SYSTEM', createdById: 't' })
    ).id;
    const credential = 'cred-no-push';
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'FACTORY_UNITS',
      title: 'Work that needs a push',
      objective: 'Implement something and push it.',
      manifest: {
        objective: 'Implement something and push it.',
        why: 'a test',
        lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
        units: [{ key: 'u', establishes: 'a branch', input: '{}', transform: 'FACTORY_UNIT', dependsOn: [] }],
        acceptableSources: [],
        excludedSources: [],
        evidence: ['a pushed branch'],
        outputs: ['one result'],
        authorizedActions: ['push the branch Brain named'],
        prohibitedActions: ['anything else'],
        budgetUnits: null,
        retry: { maxAttempts: 2, backoffSeconds: 60 },
        stoppingConditions: ['a result per unit'],
      },
      completionContract: 'FACTORY_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredCapabilities: ['repository', 'repository-write'],
      ready: true,
    });

    const admit = await binAdmission({
      workerId,
      principal: {
        type: 'WORKER',
        id: workerId,
        credentialId: credential,
        displayName: 'no-push',
        isBrainAdmin: false,
        scopes: [],
        memberships: [],
      } as unknown as Principal,
    });
    const verdict = await admit((await getBin(bin.id))!);
    // No registered Routine resolves for this worker, so what it can reach is
    // unknown — and unknown is refused rather than assumed.
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('repository-write');
  });
});
