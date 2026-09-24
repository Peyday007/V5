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
  UNIVERSAL_FORBIDDEN_PATHS,
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

/**
 * Register a worker as a factory surface for the repository under test.
 *
 * Needed explicitly now, and that is the architecture rather than test
 * bookkeeping: a worker with no routing row serves what its membership scopes
 * imply and never repository work, so a test that wants to be handed a factory
 * bin has to say which worker may be handed one — exactly as an operator does.
 */
async function registerFactoryWorker(workerId: string): Promise<void> {
  const { setWorkerRouting } = await import('../server/repos/identity.ts');
  await setWorkerRouting({
    workerId,
    families: ['FACTORY'],
    repositories: ['peyday007/oakwood-junk-removal'],
    capabilities: [],
    reason: 'a factory surface for the repository under test',
    setBy: 'test',
  });
}

/**
 * A minimally real principal for a factory surface.
 *
 * It has to carry memberships now, because the routing boundary reads the
 * project and the scopes from them — which is the point: a principal with no
 * membership may be handed nothing, and a test that passed one was testing a
 * caller that could not exist.
 */
function reviewerPrincipal(workerId: string): Parameters<typeof binAdmission>[0]['principal'] {
  return {
    type: 'WORKER',
    id: workerId,
    credentialId: 'cred-x',
    displayName: 'reviewer',
    isBrainAdmin: false,
    scopes: [],
    memberships: [
      {
        projectId: fixture.project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: ['queue:claim', 'queue:complete'],
        active: true,
      },
    ],
  } as unknown as Parameters<typeof binAdmission>[0]['principal'];
}

/* ========================================================================= */

describe('the repository envelope', () => {
  /*
   * Two repositories may never be pointed at, for two different reasons, and both
   * are asserted because both have been re-added by somebody who thought they had
   * a good argument. `V5` is where the factory lives, so a bad unit there is not
   * contained by declining a pull request. `oakwood-junk-removal` is **retired**:
   * its proof is finished and kept, and taking it out of active dispatch was a
   * standing decision of the operator's rather than a rule with a rationale to be
   * re-litigated. Spelling variants are refused too, because a normalisation the
   * envelope did not do is an authorization somebody spelled their way into.
   */
  it('refuses the repository that was retired, in every spelling', () => {
    for (const remote of [OAKWOOD, `${OAKWOOD}.git`, `${OAKWOOD}/`, OAKWOOD.toUpperCase()]) {
      const refused = decideRepository(remote);
      expect(refused.ok).toBe(false);
      expect(refused.grant).toBeNull();
    }
  });

  /**
   * **`V5` was on that list and is not any more, and the reason is a decision
   * rather than a discovery.** The refusal was the agent's own default — the
   * envelope said so at the time — and the operator has since named Brain as an
   * intended target, to be improved through isolated branches, independent
   * review and the existing controlled integration process.
   *
   * The normalisation still has to hold, which is why every spelling is asked:
   * a grant matched on one form and missed on another would be an authorization
   * that depends on how somebody typed it.
   */
  it('authorizes the repository it lives in, in every spelling', () => {
    for (const remote of [
      'https://github.com/Peyday007/V5',
      'https://github.com/Peyday007/V5.git',
      'https://github.com/Peyday007/V5/',
      'https://github.com/peyday007/v5',
    ]) {
      const decision = decideRepository(remote);
      expect(decision.ok, remote).toBe(true);
      expect(decision.grant?.id).toBe('brain');
    }
  });

  /*
   * What it authorizes is one checkout, and the properties that keep it one are
   * asserted rather than described. The grant must be an `owner/name` the router
   * can compare a manifest against — a grant whose remote no routing row could
   * ever match is a grant that authorizes nothing and says otherwise.
   *
   * **There is deliberately no target repository in here.** A grant says the
   * factory may be *pointed* at something; the only entry is the checkout an
   * unattended Routine attaches for its own connector permissions, so the factory
   * currently has a proving ground and nowhere to do real work. Naming a target is
   * a person's decision, and a test that quietly wanted a second entry is how the
   * retired one came back.
   */
  it('authorizes a checkout and one target, each identifiable to the router', async () => {
    const { repositoryIdOfRemote } = await import('../server/services/factory/onboard.ts');
    const grants = listRepositoryGrants();
    expect(grants.map((grant) => grant.id).sort()).toEqual(['brain', 'brain-worker-bootstrap']);

    for (const grant of grants) {
      expect(decideRepository(grant.remote).ok).toBe(true);
      expect(grant.remote.toLowerCase(), 'the retired repository stays out').not.toContain('oakwood');
      // A grant whose remote no routing row could ever match is a grant that
      // authorizes nothing and says otherwise.
      expect(repositoryIdOfRemote(grant.remote), grant.id).toBeTruthy();
    }

    const mount = grants.find((grant) => grant.id === 'brain-worker-bootstrap')!;
    // No unit may own the file that grants a fired worker its permissions, or one
    // diff takes out the fleet. It is on the universal floor as well as here.
    expect(mount.forbiddenPaths).toContain('.claude/**');
    expect(UNIVERSAL_FORBIDDEN_PATHS.some((p) => p.startsWith('.github/workflows/deploy'))).toBe(true);
  });

  /*
   * And a grant is only the first of three things. Authorizing a repository says
   * the factory may be *pointed* at it; a worker routing row says who may execute
   * it; the access itself is granted where that worker runs. The forbidden-path
   * floor is in the envelope rather than in each grant for the same reason — a
   * protection copied per repository is one that will be missing from one.
   */
  it('forbids the deployment pipeline, the git directory and the fleet’s own settings everywhere', () => {
    expect(UNIVERSAL_FORBIDDEN_PATHS).toContain('.github/workflows/deploy*');
    expect(UNIVERSAL_FORBIDDEN_PATHS).toContain('.git/**');
    // The file a fired worker reads to know it may call the connector. It was a
    // per-grant rule, and it belongs here because a protection copied per
    // repository is one that will be missing from one — which stops being
    // hypothetical the moment a second repository is ever authorized.
    expect(UNIVERSAL_FORBIDDEN_PATHS).toContain('.claude/**');
    for (const grant of listRepositoryGrants()) {
      expect([...grant.forbiddenPaths, ...UNIVERSAL_FORBIDDEN_PATHS]).toContain('.claude/**');
    }
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

  /**
   * The property that replaced "keep the factory out of its own repository".
   *
   * That one was an absence, and an absence stopped being available the moment
   * the operator named Brain as a target. What bounds it now is that a campaign
   * here cannot edit what authorizes it, what bounds it, or what deploys it — so
   * the failure mode declining a pull request does not contain is one a campaign
   * cannot reach in the first place.
   *
   * Asserted per path rather than as a count, because the useful failure is
   * "somebody removed the envelope from its own forbidden list" and a count
   * would pass while that happened.
   */
  it('keeps a campaign in Brain out of what authorizes, bounds and deploys it', () => {
    const brain = listRepositoryGrants().find((grant) => /\/V5$/i.test(grant.remote));
    expect(brain, 'Brain is an authorized target').toBeTruthy();
    for (const path of [
      // What authorizes it.
      'server/services/identity/**',
      'server/services/bins/routing.ts',
      // What bounds it.
      'server/services/factory/repositoryEnvelope.ts',
      'server/services/factory/projectScope.ts',
      'server/services/russell/probeEnvelope.ts',
      'server/services/research/approvalEnvelope.ts',
      // What deploys it. The whole workflows directory, because §28's lesson is
      // that a *second* workflow running flyctl deploy is how the guard is
      // bypassed, and a new file is not matched by a pattern naming the old one.
      '.github/workflows/**',
      '.github/CANONICAL_BRANCH',
      'fly.toml',
      'Dockerfile',
    ]) {
      expect(brain?.forbiddenPaths, `a campaign in Brain must never own ${path}`).toContain(path);
    }
    // And it still stops at a pull request a person merges, which is the
    // boundary every other repository has.
    expect(brain?.mayOpenPullRequest).toBe(true);
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

  /*
   * The one case the original schema could not express, and the one that actually
   * happened: a worker blocked before it pushed anything. It has a reason and no
   * commit, and demanding a commit of it turned a correct report into an exhausted
   * bin. Required of IMPLEMENTED, optional of BLOCKED — and a sha that is present
   * and malformed is still refused either way.
   */
  it('accepts a BLOCKED unit that pushed nothing, and still refuses a malformed sha', () => {
    const { headSha: _drop, ...withoutSha } = unit;
    expect(parseUnitReport({ ...withoutSha, outcome: 'IMPLEMENTED' }).ok).toBe(false);
    const blocked = parseUnitReport({
      ...withoutSha,
      outcome: 'BLOCKED',
      blockedReason: 'This execution surface has no credential for the remote.',
    });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.value.headSha).toBe('');
  });

  it('accepts a BLOCKED integration that pushed nothing', () => {
    const blocked = parseIntegrationReport({
      outcome: 'BLOCKED',
      integrationBranch: 'factory/campaign/c',
      merged: [],
      conflicts: [],
      commands: [],
      summary: 'nothing was merged',
      blockedReason: 'This execution surface has no credential for the remote.',
    });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.value.headSha).toBe('');
    // An integration that claims to have landed still has to name the commit.
    const landed = parseIntegrationReport({
      outcome: 'IMPLEMENTED',
      integrationBranch: 'factory/campaign/c',
      merged: [{ unitKey: 'u', branch: 'b', headSha: BASE }],
      conflicts: [],
      commands: [],
      summary: 'merged one',
    });
    expect(landed.ok).toBe(false);
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

  it('refuses a forbidden file even when the unit owns everything', async () => {
    /*
     * The binding half of the forbidden list: whatever the plan said, a file
     * the forge says moved inside a forbidden glob refuses the report. Owning
     * `**` is exactly the case the planner's check used to miss.
     */
    const brain = parseRemote('https://github.com/Peyday007/V5')!;
    stubForge({
      branches: { 'factory/c/u/a1': HEAD },
      compares: {
        [`${BASE}...${HEAD}`]: {
          files: ['client/src/russell/Home.tsx', '.github/workflows/deploy.yml'],
          status: 'ahead',
        },
      },
    });
    const verdict = await verifyUnitReport(
      brain,
      { branch: 'factory/c/u/a1', baseSha: BASE, ownedPaths: ['**'] },
      report,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('.github/workflows/deploy.yml');
    expect(verdict.problems.join(' ')).not.toContain('Home.tsx');

    // And the same diff without the forbidden file is accepted, so the refusal
    // above is about that file and nothing else.
    stubForge({
      branches: { 'factory/c/u/a1': HEAD },
      compares: { [`${BASE}...${HEAD}`]: { files: ['client/src/russell/Home.tsx'], status: 'ahead' } },
    });
    const clean = await verifyUnitReport(
      brain,
      { branch: 'factory/c/u/a1', baseSha: BASE, ownedPaths: ['**'] },
      report,
    );
    expect(clean.problems).toEqual([]);
    expect(clean.ok).toBe(true);
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

  it('refuses a forbidden file even when a merged unit owned everything', async () => {
    stubForge({
      branches: { 'factory/campaign/c1': integrationHead },
      compares: {
        [`${unitHead}...${integrationHead}`]: { files: [], status: 'ahead' },
        [`${BASE}...${integrationHead}`]: {
          files: ['index.html', '.claude/settings.json'],
          status: 'ahead',
        },
      },
    });
    const verdict = await verifyIntegrationReport(
      repository,
      { ...expected, units: [{ unitKey: 'u', headSha: unitHead, ownedPaths: ['**'] }] },
      report,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('.claude/settings.json');
    expect(verdict.problems.join(' ')).not.toContain('outside every merged unit');
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

  /**
   * Brain is a target now, and the declaration is not the control.
   *
   * `factoryExecutionPlane` already asserts the grant *lists* these paths, and a
   * list nothing reads is exactly what this repository keeps finding. So each one
   * is put through `validatePlan` as a unit that claims to own it, in the shape a
   * planning worker would actually submit — which is the only place the list
   * turns into a refusal.
   */
  describe('a campaign in Brain may not own what authorizes, bounds or deploys it', () => {
    const BRAIN_REMOTE = 'https://github.com/Peyday007/V5';

    async function planOwning(paths: string[]): Promise<ReturnType<typeof validatePlan>> {
      const { changeRequest } = await ensureChangeRequest({
        projectId: fixture.project.id,
        submissionKey: `brain-${paths.join('|')}`,
        objective: 'Improve a part of Brain.',
        expectedOutcome: 'It is better.',
        nonGoals: [],
        acceptanceConditions: [
          { id: 'A01', statement: 'it is better', verification: 'npm test', mandatory: true },
        ],
        repository: BRAIN_REMOTE,
        repositoryRoot: '',
        baseBranch: 'production',
        baseSha: BASE,
        environment: 'LOCAL',
        riskClass: 'LOW',
        mutationScope: ['**'],
        deploymentPolicy: 'NONE',
        rollbackRequirement: 'decline',
        verificationCommands: ['npm test'],
      });
      return validatePlan(
        {
          units: [
            {
              key: 'a-unit',
              kind: 'IMPLEMENTATION',
              title: 'A change',
              objective: 'Make one bounded change to Brain and prove it with a test.',
              acceptance: ['it is better'],
              ownedPaths: paths,
              requiredContext: [],
              verification: ['npm test'],
              expectedArtifact: 'a diff',
              risk: 'LOW',
              criticalPath: true,
              dependsOn: [],
              serves: ['A01'],
            },
          ],
        },
        changeRequest,
      );
    }

    for (const path of [
      'server/services/identity/policy.ts',
      'server/services/bins/routing.ts',
      'server/services/factory/repositoryEnvelope.ts',
      'server/services/factory/projectScope.ts',
      'server/services/russell/probeEnvelope.ts',
      'server/services/research/approvalEnvelope.ts',
      '.github/workflows/deploy.yml',
      // A *second* workflow, which is precisely the bypass §28 records: a
      // pattern naming the old file would have let this one through.
      '.github/workflows/ship-it-really-fast.yml',
      '.github/CANONICAL_BRANCH',
      'fly.toml',
      'Dockerfile',
      // Universal, and it must still apply inside a grant that adds its own.
      '.claude/settings.json',
    ]) {
      it(`refuses a unit owning ${path}`, async () => {
        const validation = await planOwning([path]);
        expect(validation.ok).toBe(false);
        expect(validation.errors.join(' ')).toContain('out of the factory');
      });
    }

    /*
     * A glob that *contains* a forbidden path owns it exactly as much as naming it
     * does. The check used to ask whether the owned glob, read as a literal path,
     * was inside a forbidden glob — so `**` passed, and a unit owning it could
     * then change the deploy workflow and pass ownership at integration.
     */
    for (const glob of [
      '**',
      '*',
      'server/**',
      'server/services/**',
      'server/services/identity/*.ts',
      '.github/**',
      '.github/workflows/*',
      '.claude/*',
    ]) {
      it(`refuses a unit owning the glob ${glob}, which reaches a forbidden path`, async () => {
        const validation = await planOwning([glob]);
        expect(validation.ok).toBe(false);
        expect(validation.errors.join(' ')).toContain('out of the factory');
      });
    }

    it('refuses the whole plan when one of several paths is out of reach', async () => {
      /*
       * A diff that reached outside its surface is rejected whole rather than
       * cherry-picked, and the same rule has to hold one step earlier: a unit
       * that owns four ordinary files and one envelope is not four-fifths
       * acceptable.
       */
      const validation = await planOwning([
        'client/src/russell/Home.tsx',
        'server/services/factory/repositoryEnvelope.ts',
      ]);
      expect(validation.ok).toBe(false);
    });

    it('allows ordinary product code, because a factory that could not change the product is not worth having', async () => {
      const validation = await planOwning([
        'client/src/russell/Home.tsx',
        'server/services/russell/home.ts',
        'tests/step12bProduct.test.ts',
      ]);
      expect(validation.errors, validation.errors.join(' ')).toEqual([]);
      expect(validation.ok).toBe(true);
    });

    it('lets a unit read what it may not own', async () => {
      /*
       * `requiredContext` is how a unit says which files it needs to have read,
       * and the forbidden list is about ownership rather than reading — a
       * reviewer of a change to the authorization model must be able to open it.
       */
      const { changeRequest } = await ensureChangeRequest({
        projectId: fixture.project.id,
        submissionKey: 'brain-reads',
        objective: 'Improve a part of Brain that has to agree with the policy module.',
        expectedOutcome: 'It agrees.',
        nonGoals: [],
        acceptanceConditions: [
          { id: 'A01', statement: 'it agrees', verification: 'npm test', mandatory: true },
        ],
        repository: BRAIN_REMOTE,
        repositoryRoot: '',
        baseBranch: 'production',
        baseSha: BASE,
        environment: 'LOCAL',
        riskClass: 'LOW',
        mutationScope: ['**'],
        deploymentPolicy: 'NONE',
        rollbackRequirement: 'decline',
        verificationCommands: ['npm test'],
      });
      const validation = validatePlan(
        {
          units: [
            {
              key: 'reads-policy',
              kind: 'IMPLEMENTATION',
              title: 'Agree with the policy module',
              objective: 'Make one bounded change that has to match what the policy module does.',
              acceptance: ['it agrees'],
              ownedPaths: ['server/routes/russell.ts'],
              requiredContext: ['server/services/identity/policy.ts'],
              verification: ['npm test'],
              expectedArtifact: 'a diff',
              risk: 'LOW',
              criticalPath: true,
              dependsOn: [],
              serves: ['A01'],
            },
          ],
        },
        changeRequest,
      );
      expect(validation.errors, validation.errors.join(' ')).toEqual([]);
      expect(validation.ok).toBe(true);
    });
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

  /*
   * The unhealthy-surface failure, said on the campaign rather than left on a
   * ledger.
   *
   * Production looked like this: a factory bin `READY`, a `DISPATCH_UNROUTED` row
   * saying no enabled Routine is bound to a worker that may be handed FACTORY
   * work, the campaign reading `PLANNING`, and every row healthy. The work was
   * fine and there was nobody to give it to, and nowhere a person could look that
   * said so. §24's sentence at the factory: a state that says waiting which
   * nobody can resolve is not waiting, it is stuck.
   */
  it('says on the campaign when a ready stage has nobody to give it to', async () => {
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const [plan] = (await listBins({ projectId: fixture.project.id })).filter(
      (bin) => bin.kind === 'FACTORY_PLAN',
    );
    expect(plan).toBeTruthy();

    const { ensureDispatchIntent, listDispatchesForBin, markDispatchDeferred } = await import(
      '../server/repos/bins.ts'
    );
    await ensureDispatchIntent(plan!);
    const [intent] = await listDispatchesForBin(plan!.id);
    await markDispatchDeferred(intent!.id, {
      refusal: 'NO_SURFACE_SERVES_THIS_FAMILY',
      message: 'no registered worker may be handed FACTORY work',
      retryAfterMs: 600_000,
    });

    await tickRemoteCampaign(campaignId);
    const blocked = (await getCampaign(campaignId))!;
    expect(blocked.blockerKind).toBe('NO_HEALTHY_EXECUTION_SURFACE');
    expect(blocked.blockerDetail).toContain('nobody to give it to');
    // The state stays truthful. The campaign *is* planning; saying BLOCKED would
    // throw away what happens when the surface arrives and then need a guess
    // about which state to restore.
    expect(blocked.state).toBe('PLANNING');

    // And the answering transition is derived, not scheduled: the condition stops
    // holding and the next tick takes the sentence away.
    const { markDispatchSent } = await import('../server/repos/bins.ts');
    await markDispatchSent(intent!.id, { sessionRef: 'cse_x', routineRef: 'trig_x' });
    await tickRemoteCampaign(campaignId);
    const cleared = (await getCampaign(campaignId))!;
    expect(cleared.blockerKind).toBeNull();
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

  /*
   * The production row this pins: `fcp_189ea30c7ded4e7b9280`'s round-1 review is
   * recorded WORKER_SEPARATED although every session on that campaign ran as one
   * worker. A finished bin cannot always say who finished it, so the hosted
   * acceptance recorded the implementer as the sentinel `unknown-worker` — and
   * the tier then compared the reviewer against a worker that does not exist
   * and found them different. An implementer nobody can name is not a different
   * worker; it is an unknown, and an unknown never rounds a tier up.
   */
  it('does not claim worker separation from an implementer whose worker is unknown', async () => {
    await recordFactoryEvent({
      campaignId,
      kind: 'UNIT_IMPLEMENTED',
      evidenceClass: 'MEASURED',
      sessionId: 'cred-session-C',
      workerId: 'unknown-worker',
      detail: { unitKey: 'v' },
    });
    const sentinel = await reviewLineage(campaignId, { sessionId: 'cred-session-B', workerId: 'wkr-two' });
    expect(sentinel.ok).toBe(true);
    expect(sentinel.independence).toBe('SESSION_SEPARATED');
  });

  it('does not claim worker separation past an implementing row that recorded no worker', async () => {
    await recordFactoryEvent({
      campaignId,
      kind: 'INTEGRATION_MERGED',
      evidenceClass: 'MEASURED',
      sessionId: 'cred-session-D',
      workerId: null,
      detail: { unitKey: 'u' },
    });
    const unnamed = await reviewLineage(campaignId, { sessionId: 'cred-session-B', workerId: 'wkr-two' });
    expect(unnamed.independence).toBe('SESSION_SEPARATED');
  });
});

/* ========================================================================= */

describe('a bin is handed out by scope, not by which surface Brain guessed', () => {
  /*
   * This file asserted twice that nothing could gate the assignment, and the
   * reasoning was about the wrong subject. Brain genuinely cannot attribute an
   * arrival to a **Routine** — `worker_sessions` is keyed by the credential and
   * the credential is per-connector — and a gate on that attribution refused the
   * only surface that could do the work.
   *
   * It can identify the arriving **worker**, because the worker id comes from the
   * authenticated principal, which is built entirely from rows the server owns. So
   * the capability dimension is still not guessed from a Routine, and the family
   * and repository dimensions are enforced from the worker's own routing row.
   *
   * Which is what production needed: one worker identity served every surface and
   * held membership on the research project, so a session started to implement a
   * repository checked in and was handed a Step 12A research item.
   */
  it('admits repository work to a worker registered for that repository', async () => {
    const workerId = (
      await createWorker({ name: 'unknown-surface', createdByType: 'SYSTEM', createdById: 't' })
    ).id;
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'FACTORY_UNITS',
      title: 'Work that needs a push',
      objective: 'Implement something and push it.',
      manifest: {
        objective: 'Implement something and push it.',
        why: 'a test',
        repository: {
          remote: OAKWOOD,
          ref: 'main',
          baseSha: BASE,
          integrationBranch: 'factory/campaign/x',
          pullRequest: null,
        },
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
    const principal = {
      type: 'WORKER',
      id: workerId,
      credentialId: 'cred-unknown',
      displayName: 'unknown-surface',
      isBrainAdmin: false,
      scopes: [],
      memberships: [
        {
          projectId: fixture.project.id,
          principalType: 'WORKER',
          principalId: workerId,
          role: 'MEMBER',
          scopes: ['queue:claim', 'queue:complete'],
          active: true,
        },
      ],
    } as unknown as Principal;

    // With no routing row this worker serves what its scopes imply — which is
    // never repository work, whatever capabilities the bin asks for.
    const unscoped = await binAdmission({ workerId, principal, sessionRef: 'provider-session-1' });
    const refused = await unscoped((await getBin(bin.id))!);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('FAMILY_NOT_SERVED');

    // Registered for this repository, the same arrival is admitted. The
    // capabilities it cannot be shown to carry are still not held against it.
    const { setWorkerRouting } = await import('../server/repos/identity.ts');
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['peyday007/oakwood-junk-removal'],
      capabilities: [],
      reason: 'a factory worker, for this repository only',
      setBy: 'test',
    });
    const scoped = await binAdmission({ workerId, principal, sessionRef: 'provider-session-1' });
    expect((await scoped((await getBin(bin.id))!)).ok).toBe(true);

    // And not for a repository it was not registered for.
    await setWorkerRouting({
      workerId,
      families: ['FACTORY'],
      repositories: ['someone/else'],
      capabilities: [],
      reason: 'authorized elsewhere',
      setBy: 'test',
    });
    const elsewhere = await binAdmission({ workerId, principal, sessionRef: 'provider-session-1' });
    const wrongRepo = await elsewhere((await getBin(bin.id))!);
    expect(wrongRepo.ok).toBe(false);
    expect(wrongRepo.reason).toContain('REPOSITORY_NOT_AUTHORIZED');
  });
});

/* ========================================================================= */

describe('the local loop does not tick a campaign the fleet is executing', () => {
  it('says so rather than looking for a checkout that is not there', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'two-loops',
      objective: 'Something the fleet is doing somewhere else.',
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

    const { tickCampaign } = await import('../server/services/factory/loop.ts');
    const report = await tickCampaign(campaign.id);
    expect(report.notes.join(' ')).toContain('executed by the fleet');
    // And it took no tick claim, so the remote loop's next pass is not blocked by
    // a lease this one left behind.
    expect(report.tickHeld).toBe(false);
    expect((await getCampaign(campaign.id))?.state).toBe('PLANNING');
  });
});

/* ========================================================================= */

describe('who produced a bin result is read from the row Brain wrote', () => {
  /*
   * This test exists to be run against **Postgres**, where it earns its place.
   * `workerSessionForBin` ordered by `rowid`, which `dialect.ts` rewrites to
   * `seq` — a column `worker_sessions` does not have on the cloud backend. Every
   * SQLite run passed and the statement threw in production, which made the
   * hosted factory's tick throw on every pass and left a completed bin
   * un-ingested with nothing saying why.
   */
  it('returns the newest observed arrival for a bin, in both dialects', async () => {
    const { recordWorkerSession, workerSessionForBin, createAccount, createRoutine } = await import(
      '../server/repos/fleet.ts'
    );
    const account = await createAccount({ name: `acct-${Math.random().toString(36).slice(2)}` });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: `trig_${Math.random().toString(36).slice(2)}`,
      name: 'a surface',
      tokenSecretName: 'NEVER_SET',
      tokenDigest: null,
      capabilities: ['repository'],
    });
    const workerId = (
      await createWorker({ name: 'arriver', createdByType: 'SYSTEM', createdById: 't' })
    ).id;

    expect(await workerSessionForBin('bin_nothing_here')).toBeNull();

    await recordWorkerSession({
      sessionRef: 'cred-first',
      workerId,
      routineId: routine.id,
      accountId: account.id,
      binId: 'bin_shared',
      leaseGeneration: 1,
    });
    await recordWorkerSession({
      sessionRef: 'cred-second',
      workerId,
      routineId: routine.id,
      accountId: account.id,
      binId: 'bin_shared',
      leaseGeneration: 2,
    });

    const observed = await workerSessionForBin('bin_shared');
    // A takeover is a second arrival on one bin, and the session that finished it
    // is the last one that took it.
    expect(observed?.leaseGeneration).toBe(2);
    expect(observed?.accountId).toBe(account.id);
  });
});

/* ========================================================================= */

describe('a unit out of attempts stops the campaign before any review', () => {
  it('blocks with the unit\'s own reason rather than reviewing an unimplemented tree', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'exhausted',
      objective: 'Something whose only unit will run out of attempts.',
      expectedOutcome: 'A person sees why it stopped.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
      unitKey: 'doomed',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'A unit that will not land',
      objective: 'Do one bounded thing that will keep being refused.',
      acceptance: ['it is done'],
      ownedPaths: ['index.html'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a change',
      risk: 'LOW',
      criticalPath: true,
      priority: 5,
      modelClass: 'FAST',
      state: 'FAILED',
    });
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(
      `UPDATE factory_work_units SET failure_category = ?, failure_detail = ? WHERE id = ?`,
      ['OUT_OF_SCOPE_MUTATION', '3 file(s) changed outside this unit\'s declared paths', created.unit.id],
    );

    stubForge({});
    const report = await tickRemoteCampaign(campaign.id);
    // Not a review: a reviewer asked to judge a tree nothing implemented would be
    // judging the base commit against a contract nobody satisfied.
    expect(report.created.some((entry) => entry.startsWith('review:'))).toBe(false);
    const after = await getCampaign(campaign.id);
    expect(after?.state).toBe('BLOCKED');
    expect(after?.blockerKind).toBe('UNIT_EXHAUSTED_ATTEMPTS');
    expect(after?.blockerDetail).toContain('declared paths');
  });

  /*
   * The answering transition, which did not exist: the blocker's remedy said
   * "raise its ceiling or replan the work" and nothing could raise a unit's
   * ceiling or move a FAILED unit back out, so the only way past was retiring
   * the whole campaign.
   */
  it('has an answer: a regrant raises the ceiling, keeps the history, and the next tick hands the unit out', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'exhausted-then-regranted',
      objective: 'Something whose only unit ran out of attempts on a condition since corrected.',
      expectedOutcome: 'It moves again without being retired.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
      unitKey: 'spent',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'A unit that spent its attempts',
      objective: 'Do one bounded thing.',
      acceptance: ['it is done'],
      ownedPaths: ['index.html'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a change',
      risk: 'LOW',
      criticalPath: true,
      priority: 5,
      modelClass: 'FAST',
      state: 'FAILED',
    });
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(
      `UPDATE factory_work_units
          SET attempt = max_attempts, failure_category = ?, failure_detail = ? WHERE id = ?`,
      ['WORKER_ERROR', 'the surface could not reach the repository', created.unit.id],
    );
    const spent = (await getUnitByKey(campaign.id, 'spent'))!;

    stubForge({});
    await tickRemoteCampaign(campaign.id);
    expect((await getCampaign(campaign.id))?.blockerKind).toBe('UNIT_EXHAUSTED_ATTEMPTS');

    const { regrantUnit } = await import('../server/services/factory/regrant.ts');
    // Refusals first: a code outside the closed set, and a "raise" that is not one.
    expect(
      (await regrantUnit({ campaignId: campaign.id, unitKey: 'spent', maxAttempts: spent.maxAttempts + 2, reasonCode: 'because', operator: 'operator:t' })).ok,
    ).toBe(false);
    expect(
      (await regrantUnit({ campaignId: campaign.id, unitKey: 'spent', maxAttempts: spent.maxAttempts, reasonCode: 'surface-blocked', operator: 'operator:t' })).ok,
    ).toBe(false);
    expect((await getUnitByKey(campaign.id, 'spent'))?.state).toBe('FAILED');

    const outcome = await regrantUnit({
      campaignId: campaign.id,
      unitKey: 'spent',
      maxAttempts: spent.maxAttempts + 2,
      reasonCode: 'surface-blocked',
      operator: 'operator:t',
    });
    expect(outcome).toEqual({ ok: true, from: spent.maxAttempts, to: spent.maxAttempts + 2, state: 'READY' });
    const regranted = (await getUnitByKey(campaign.id, 'spent'))!;
    // Raised, never reset: the attempt count and the reason it ran out stay.
    expect(regranted.attempt).toBe(spent.attempt);
    expect(regranted.failureDetail).toBe('the surface could not reach the repository');

    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const events = await listFactoryEvents(campaign.id, { kinds: ['UNIT_ATTEMPTS_REGRANTED'] });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ code: 'surface-blocked', from: spent.maxAttempts });

    const next = await tickRemoteCampaign(campaign.id);
    expect(next.created.some((entry) => entry.startsWith('units:'))).toBe(true);
    const moving = await getCampaign(campaign.id);
    expect(moving?.state).toBe('EXECUTING');
    expect(moving?.blockerKind).toBeNull();
  });
});

/* ========================================================================= */

describe('a review Brain refused spends the stage rather than looping it', () => {
  /*
   * A review bin whose report ingest refuses is COMPLETE — neither live nor
   * FAILED — so the stage handed out a fresh review bin on every tick for a
   * refusal that would recur, each one a real activation. Recorded once per bin,
   * the refused bins count toward the same ceiling a failure does.
   */
  it('counts refused COMPLETE bins toward MAX_BINS_PER_STAGE and nothing else', async () => {
    const { stalledStage } = await import('../server/services/factory/remoteLoop.ts');
    const at = '2026-09-24T00:00:00.000Z';
    const bin = (id: string, state: string) =>
      ({ id, kind: 'FACTORY_REVIEW', state, createdAt: at }) as unknown as import('../server/domain/types.ts').Bin;
    const bins = [bin('r1', 'COMPLETE'), bin('r2', 'COMPLETE'), bin('r3', 'COMPLETE')];
    // Three completed reviews Brain accepted are three rounds, not a stall.
    expect(stalledStage(bins, 'FACTORY_REVIEW', null)).toBeNull();
    expect(stalledStage(bins, 'FACTORY_REVIEW', null, new Set(['r1', 'r2']))).toBeNull();
    const stall = stalledStage(bins, 'FACTORY_REVIEW', null, new Set(['r1', 'r2', 'r3']));
    expect(stall?.detail).toContain('have failed on this campaign');
    // A re-authorization after them resets the count, as it does for failures.
    expect(stalledStage(bins, 'FACTORY_REVIEW', '2026-09-25T00:00:00.000Z', new Set(['r1', 'r2', 'r3']))).toBeNull();
  });
});

describe('an empty check-in derives only the caller’s campaigns', () => {
  it('ticks no campaign outside the projects it was given, and deriveReadyWork gives its own', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'scoped-derivation',
      objective: 'A campaign that belongs to one project only.',
      expectedOutcome: 'Nobody else’s check-in ticks it.',
      nonGoals: [],
      acceptanceConditions: [{ id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true }],
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
    await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    stubForge({});
    const { tickAllRemoteCampaigns } = await import('../server/services/factory/remoteLoop.ts');
    expect(await tickAllRemoteCampaigns({ projectIds: new Set(['prj_somebody_else']) })).toEqual([]);
    const mine = await tickAllRemoteCampaigns({ projectIds: new Set([fixture.project.id]) });
    expect(mine.map((one) => one.projectId)).toEqual([fixture.project.id]);

    const fs = await import('node:fs');
    const service = fs.readFileSync(new URL('../server/services/bins/service.ts', import.meta.url), 'utf8');
    expect(service).toMatch(/tickAllRemoteCampaigns\(\{ projectIds: scoped \}\)/);
    expect(service).toMatch(/dispatchTick\(\{ projectIds: \[bin\.projectId\] \}\)/);
  });
});

describe('a stage that failed its bins to exhaustion has a way back', () => {
  /*
   * `stalledStage` counted every FAILED bin the campaign ever had, so three
   * failed plan bins blocked it for good: a re-authorization was re-blocked on
   * the next tick by the same three rows, an amendment touches no bin, and a
   * FAILED bin is already terminal. The count now starts at the newest
   * re-authorization, the baseline the surface-block ceiling already used.
   */
  it('blocks after three failed plan bins, and a re-authorization hands the stage out again', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'plan-fails-three-times',
      objective: 'Something whose planning stage fails on a surface that is later fixed.',
      expectedOutcome: 'It plans once the surface is fixed.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
    });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });
    const { getDb } = await import('../server/db/database.ts');
    stubForge({});
    for (let round = 0; round < 3; round += 1) {
      const tick = await tickRemoteCampaign(campaign.id);
      const planBin = tick.created.find((entry) => entry.startsWith('plan:'));
      expect(planBin, `round ${round} made a plan bin`).toBeTruthy();
      await getDb().run(`UPDATE bins SET state = 'FAILED' WHERE id = ?`, [planBin!.slice('plan:'.length)]);
    }
    const stopped = await tickRemoteCampaign(campaign.id);
    expect(stopped.created).toEqual([]);
    const blocked = await getCampaign(campaign.id);
    expect(blocked?.state).toBe('BLOCKED');
    expect(blocked?.blockerDetail).toContain('have failed on this campaign');
    expect(blocked?.blockerDetail).toContain('stage-corrected');

    // Still blocked on the next tick: nothing has changed.
    expect((await tickRemoteCampaign(campaign.id)).created).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordFactoryEvent({
      campaignId: campaign.id,
      kind: 'FACTORY_STAGE_REAUTHORIZED',
      evidenceClass: 'MEASURED',
      detail: { operator: 'operator:t', code: 'stage-corrected' },
    });
    const resumed = await tickRemoteCampaign(campaign.id);
    expect(resumed.created.some((entry) => entry.startsWith('plan:'))).toBe(true);
    expect((await getCampaign(campaign.id))?.state).toBe('PLANNING');
    // Every failed bin keeps its row.
    const failed = await getDb().all<{ id: string }>(
      `SELECT id FROM bins WHERE factory_campaign_id = ? AND state = 'FAILED'`,
      [campaign.id],
    );
    expect(failed).toHaveLength(3);
  });
});

/* ========================================================================= */

describe('accepting a unit does not undo itself', () => {
  /*
   * The defect this pins, from the first real hosted campaign: the expected branch
   * name was derived from the unit's attempt, `acceptUnitReport` claims the unit,
   * and a claim increments the attempt — so the next tick re-verified the report
   * it had just accepted, refused it for naming the previous attempt's branch,
   * reopened the unit and charged another attempt. Three passes later a unit whose
   * work sat correctly on a confirmed commit had retired as FAILED.
   *
   * Two things make it impossible now, and both are asserted: the branch is read
   * back from the bin that handed it out, and only a unit still waiting for a
   * report is acted on.
   */
  let campaignId = '';
  let workerId = '';
  const unitHead = 'f'.repeat(40);

  beforeEach(async () => {
    workerId = (await createWorker({ name: 'impl', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'no-self-undo',
      objective: 'Guard the quote form against silent breakage.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    await ensureUnit({
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
  });

  it('leaves the unit implemented across repeated ticks over one completed bin', async () => {
    stubForge({});
    // One tick to hand the work out, so the bin records the branch it named.
    const handed = await tickRemoteCampaign(campaignId);
    expect(handed.created.some((entry) => entry.startsWith('units:'))).toBe(true);

    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_UNITS');
    const bin = assigned!.bin;
    const { declaredBranchFor } = await import('../server/services/factory/remote.ts');
    const branch = declaredBranchFor(bin, 'form-contract')!;
    expect(branch).toContain('form-contract');

    // The repository agrees with the report, on the branch the bin named.
    stubForge({
      branches: { [branch]: unitHead },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/form.test.js'], status: 'ahead' } },
    });
    await putBinUnitResult({
      binId: bin.id,
      unitKey: 'form-contract',
      value: JSON.stringify({
        unitKey: 'form-contract',
        outcome: 'IMPLEMENTED',
        branch,
        headSha: unitHead,
        filesChanged: ['test/form.test.js'],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'added the contract test',
      }),
      contentHash: 'h-impl',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        { binId: bin.id, leaseId: assigned!.leaseId, leaseGeneration: assigned!.leaseGeneration, workerId },
        { state: 'COMPLETE', reason: 'implemented' },
      ),
    ).toBe('OK');

    // First ingest accepts it.
    const first = await tickRemoteCampaign(campaignId);
    expect(first.ingested.some((entry) => entry.startsWith('units:'))).toBe(true);
    const { getUnitByKey } = await import('../server/repos/factory.ts');
    const afterFirst = await getUnitByKey(campaignId, 'form-contract');
    expect(afterFirst?.state).toBe('IMPLEMENTED');
    const chargedOnce = afterFirst!.attempt;

    // Two more ticks over the same completed bin change nothing: no second
    // verification, no refusal, no further attempt.
    await tickRemoteCampaign(campaignId);
    await tickRemoteCampaign(campaignId);
    const afterMore = await getUnitByKey(campaignId, 'form-contract');
    expect(afterMore?.state).toBe('IMPLEMENTED');
    expect(afterMore?.attempt).toBe(chargedOnce);
    expect(afterMore?.failureCategory).toBeNull();
  });

  /** Hand the unit out, and complete its bin with a report the forge confirms. */
  async function completeConfirmedReport(): Promise<string> {
    stubForge({});
    const handed = await tickRemoteCampaign(campaignId);
    expect(handed.created.some((entry) => entry.startsWith('units:'))).toBe(true);
    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    const bin = assigned!.bin;
    const { declaredBranchFor } = await import('../server/services/factory/remote.ts');
    const branch = declaredBranchFor(bin, 'form-contract')!;
    stubForge({
      branches: { [branch]: unitHead },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/form.test.js'], status: 'ahead' } },
    });
    await putBinUnitResult({
      binId: bin.id,
      unitKey: 'form-contract',
      value: JSON.stringify({
        unitKey: 'form-contract',
        outcome: 'IMPLEMENTED',
        branch,
        headSha: unitHead,
        filesChanged: ['test/form.test.js'],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'added the contract test',
      }),
      contentHash: 'h-impl',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    await finishBin(
      { binId: bin.id, leaseId: assigned!.leaseId, leaseGeneration: assigned!.leaseGeneration, workerId },
      { state: 'COMPLETE', reason: 'implemented' },
    );
    return bin.id;
  }

  /*
   * A confirmed report Brain could not record used to be a note and nothing
   * else: no row, no attempt, and the stage fired a fresh activation while the
   * completed report was still acceptable. The claim is made to refuse here by
   * deferring the unit, which is one of the real reasons `claimUnits` declines.
   */
  it('records a report it could not yet record, holds the stage, and accepts it once it can', async () => {
    const binId = await completeConfirmedReport();
    const { getDb } = await import('../server/db/database.ts');
    const { getUnitByKey } = await import('../server/repos/factory.ts');
    const before = (await getUnitByKey(campaignId, 'form-contract'))!;
    await getDb().run(`UPDATE factory_work_units SET not_before = ? WHERE id = ?`, [
      '2999-01-01T00:00:00.000Z',
      before.id,
    ]);

    const held = await tickRemoteCampaign(campaignId);
    expect(held.created).toEqual([]);
    expect(held.awaitingRecord).toBe(1);
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const refusals = await listFactoryEvents(campaignId, { kinds: ['UNIT_REFUSED'] });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.detail).toMatchObject({ stage: 'UNITS', binId, try: 1 });
    const unchanged = (await getUnitByKey(campaignId, 'form-contract'))!;
    expect(unchanged.state).toBe('READY');
    expect(unchanged.attempt).toBe(before.attempt);

    await getDb().run(`UPDATE factory_work_units SET not_before = NULL WHERE id = ?`, [before.id]);
    const accepted = await tickRemoteCampaign(campaignId);
    expect(accepted.ingested).toContain(`units:${binId}`);
    expect((await getUnitByKey(campaignId, 'form-contract'))?.state).toBe('IMPLEMENTED');
  });

  it('stops asking after a bounded number of tries, and charges the one attempt that bounds it', async () => {
    const binId = await completeConfirmedReport();
    const { getDb } = await import('../server/db/database.ts');
    const { getUnitByKey } = await import('../server/repos/factory.ts');
    const before = (await getUnitByKey(campaignId, 'form-contract'))!;
    await getDb().run(`UPDATE factory_work_units SET not_before = ? WHERE id = ?`, [
      '2999-01-01T00:00:00.000Z',
      before.id,
    ]);
    for (let tick = 0; tick < 5; tick += 1) await tickRemoteCampaign(campaignId);
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const failed = await listFactoryEvents(campaignId, { kinds: ['UNIT_FAILED'] });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toMatchObject({ binId });
    expect(String(failed[0]?.detail['detail'])).toContain('could not record');
    expect((await listFactoryEvents(campaignId, { kinds: ['UNIT_REFUSED'] }))).toHaveLength(4);
    const after = (await getUnitByKey(campaignId, 'form-contract'))!;
    expect(after.attempt).toBe(before.attempt + 1);
    // Judged once: more ticks over the same bin add nothing.
    await tickRemoteCampaign(campaignId);
    expect(await listFactoryEvents(campaignId, { kinds: ['UNIT_FAILED'] })).toHaveLength(1);
  });
});

/* ========================================================================= */

describe('an integration blocked before the work was judged costs the work nothing', () => {
  /*
   * The defect this pins is §23's correction one altitude down.
   *
   * A BLOCKED integration refused every implemented unit and charged each one an
   * attempt, whatever the blocker was. That is right for a conflict or a red
   * command: the branches disagree, or the contract rejects the tree they make,
   * and the thing that has to change is the code. It is wrong for a blocker the
   * integrator hit *before* judging anything — no credential for the remote, a
   * host that refused it — because nothing examined the work, so there is nothing
   * for the work to answer, and two forge-confirmed commits were being charged for
   * a condition that was never about them.
   *
   * Derived from the rows rather than from the sentence: no conflict and no
   * non-zero exit code means nothing judged the tree. A worker cannot declare
   * itself surface-blocked to dodge a failed verification, because the exit codes
   * it reported are what decide.
   */
  let campaignId = '';
  let implementer = '';
  let integrator = '';
  const unitHead = 'c'.repeat(40);

  async function implementOneUnit(): Promise<void> {
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const assigned = await assignNextBin({ workerId: implementer, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_UNITS');
    const { declaredBranchFor } = await import('../server/services/factory/remote.ts');
    const branch = declaredBranchFor(assigned!.bin, 'only-unit')!;
    stubForge({
      branches: { [branch]: unitHead },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/only.test.js'], status: 'ahead' } },
    });
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'only-unit',
      value: JSON.stringify({
        unitKey: 'only-unit',
        outcome: 'IMPLEMENTED',
        branch,
        headSha: unitHead,
        filesChanged: ['test/only.test.js'],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'implemented',
      }),
      contentHash: 'h-only',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        {
          binId: assigned!.bin.id,
          leaseId: assigned!.leaseId,
          leaseGeneration: assigned!.leaseGeneration,
          workerId: implementer,
        },
        { state: 'COMPLETE', reason: 'implemented' },
      ),
    ).toBe('OK');
    await tickRemoteCampaign(campaignId);
  }

  /** Hand the integrate bin to the integrator and complete it with this report. */
  async function integrateReporting(report: Record<string, unknown>): Promise<void> {
    const created = await tickRemoteCampaign(campaignId);
    expect(
      created.created.some((entry) => entry.startsWith('integrate:')) ||
        created.notes.some((note) => note.includes('integrator')),
    ).toBe(true);
    const assigned = await assignNextBin({ workerId: integrator, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_INTEGRATE');
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'integrate',
      value: JSON.stringify(report),
      contentHash: `h-int-${Math.random()}`,
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        {
          binId: assigned!.bin.id,
          leaseId: assigned!.leaseId,
          leaseGeneration: assigned!.leaseGeneration,
          workerId: integrator,
        },
        { state: 'COMPLETE', reason: 'reported' },
      ),
    ).toBe('OK');
    await tickRemoteCampaign(campaignId);
  }

  beforeEach(async () => {
    implementer = (await createWorker({ name: 'impl-i', createdByType: 'SYSTEM', createdById: 't' })).id;
    integrator = (await createWorker({ name: 'int-i', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `surface-block-${Math.random()}`,
      objective: 'Keep the published site free of repository-only files.',
      expectedOutcome: 'The suite fails when they appear.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    await ensureUnit({
      campaignId,
      unitKey: 'only-unit',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the published tree',
      objective: 'Assert the build publishes the site only.',
      acceptance: ['the suite fails when a repository-only file is published'],
      ownedPaths: ['test/only.test.js'],
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
    await implementOneUnit();
  });

  it('keeps the unit implemented when nothing judged the tree', async () => {
    const { getUnitByKey } = await import('../server/repos/factory.ts');
    const before = await getUnitByKey(campaignId, 'only-unit');
    expect(before?.state).toBe('IMPLEMENTED');

    await integrateReporting({
      outcome: 'BLOCKED',
      integrationBranch: 'factory/campaign/only',
      merged: [],
      conflicts: [],
      commands: [],
      summary: 'nothing was merged',
      blockedReason: 'This execution surface has no credential for the remote.',
    });

    const after = await getUnitByKey(campaignId, 'only-unit');
    expect(after?.state).toBe('IMPLEMENTED');
    expect(after?.attempt).toBe(before?.attempt);
    expect(after?.failureCategory).toBeNull();

    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const events = await listFactoryEvents(campaignId, { kinds: ['INTEGRATION_REJECTED'], limit: 20 });
    expect(events.length).toBe(1);
    expect((events[0]!.detail as { surface?: unknown }).surface).toBe(true);

    /*
     * And the same completed bin is not read again. A surface block deliberately
     * changes nothing, so "the units are no longer implemented" cannot be the
     * guard: without one keyed on the bin, every tick recorded another refusal
     * nothing new had happened to produce, and the ceiling counted from them would
     * trip on its own.
     */
    await tickRemoteCampaign(campaignId);
    await tickRemoteCampaign(campaignId);
    expect(
      (await listFactoryEvents(campaignId, { kinds: ['INTEGRATION_REJECTED'], limit: 20 })).length,
    ).toBe(1);
  });

  it('still refuses the unit when a command failed on the merged tree', async () => {
    const { getUnitByKey } = await import('../server/repos/factory.ts');
    const before = await getUnitByKey(campaignId, 'only-unit');

    await integrateReporting({
      outcome: 'BLOCKED',
      integrationBranch: 'factory/campaign/only',
      merged: [],
      conflicts: [],
      commands: [{ command: 'npm test', exitCode: 1 }],
      summary: 'the suite failed on the merged tree',
      blockedReason: '`npm test` exited 1 on the merged tree.',
    });

    const after = await getUnitByKey(campaignId, 'only-unit');
    expect(after?.state).toBe('READY');
    expect(after?.attempt).toBeGreaterThan(before!.attempt);
    expect(after?.failureCategory).toBe('VERIFICATION_FAILED');

    /*
     * And it stays refused. The implementation bin is still COMPLETE and still
     * holds the report Brain believed, and READY is exactly the state the ingest
     * acts on — so before the acceptance became idempotent by the bin, the very
     * next tick read that old report again and put the unit straight back to
     * IMPLEMENTED at the commit the integration had just refused. Refuse,
     * re-accept, integrate, refuse: a loop that looks like progress.
     */
    await tickRemoteCampaign(campaignId);
    await tickRemoteCampaign(campaignId);
    const later = await getUnitByKey(campaignId, 'only-unit');
    expect(later?.state).toBe('READY');
    expect(later?.attempt).toBe(after?.attempt);
  });

  /*
   * Deferred, never stopped — and this is the correction to the first version of
   * this rule rather than a softening of it. Brain cannot tell which surface will
   * arrive, so a stage only some surfaces can perform is offered to whoever turns
   * up. A hard ceiling counted in surface blocks is therefore reached by the
   * surface that *cannot* push, in minutes, before the one that can has had a
   * single turn — a livelock with a tidy blocker row on it. The stage has to still
   * be there when the right surface asks.
   */
  it('defers the stage after a surface block rather than stopping it', async () => {
    await integrateReporting({
      outcome: 'BLOCKED',
      integrationBranch: 'factory/campaign/only',
      merged: [],
      conflicts: [],
      commands: [],
      summary: 'nothing was merged',
      blockedReason: 'This execution surface has no credential for the remote.',
    });
    const report = await tickRemoteCampaign(campaignId);
    expect(report.state).not.toBe('BLOCKED');
    expect(report.notes.some((note) => note.includes('waiting'))).toBe(true);
    // Nothing new was handed out inside the cool-off, and nothing was destroyed.
    expect(report.created.length).toBe(0);
    const { getCampaign, getUnitByKey } = await import('../server/repos/factory.ts');
    expect((await getCampaign(campaignId))?.blockerKind).toBeNull();
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('IMPLEMENTED');
  });

  /*
   * And the stop has a way out, which is the whole difference between a ceiling and
   * a dead end. The count of surface-blocked integrations only ever rises, so
   * granting the repository somewhere else — the remedy the blocker itself names —
   * could not by itself change anything in this database. A person says it is
   * fixed, the count is taken from that moment, and the next tick re-derives
   * everything: if it was not fixed, the stage blocks again with the same reason.
   */
  it('hands the stage out again at once when a person says the condition is fixed', async () => {
    await integrateReporting({
      outcome: 'BLOCKED',
      integrationBranch: 'factory/campaign/only',
      merged: [],
      conflicts: [],
      commands: [],
      summary: 'nothing was merged',
      blockedReason: 'This execution surface has no credential for the remote.',
    });
    expect((await tickRemoteCampaign(campaignId)).notes.some((n) => n.includes('waiting'))).toBe(
      true,
    );

    const { recordFactoryEvent } = await import('../server/repos/factoryFleet.ts');
    const { FACTORY_EVENT_KINDS } = await import('../server/services/factory/metrics.ts');
    await recordFactoryEvent({
      campaignId,
      kind: FACTORY_EVENT_KINDS.stageReauthorized,
      evidenceClass: 'MEASURED',
      detail: { operator: 'operator:test', code: 'repository-granted' },
    });

    // The cool-off is counted from the newest surface block since the newest
    // re-authorization, so answering it clears the wait as well as the ceiling.
    const after = await tickRemoteCampaign(campaignId);
    expect(after.state).not.toBe('BLOCKED');
    expect(after.notes.some((note) => note.includes('waiting'))).toBe(false);
    expect(
      after.created.some((entry) => entry.startsWith('integrate:')) ||
        after.notes.some((note) => note.includes('integrator')),
    ).toBe(true);
  });
});

/* ========================================================================= */

describe('a finding whose repair landed is closed on this plane too', () => {
  /*
   * `reconcileRepairs` had exactly one caller — the in-process orchestrator — and
   * the hosted plane is the other runner. A rule applied by one of two runners is
   * worse than none, and §24 has recorded this exact shape before with
   * `reconcileAcceptedFragment`.
   *
   * Here it showed as a pull request. The repair integrated, its commit became the
   * request's head, the repository's own checks passed on it, and the body a person
   * reads still listed the finding under *remaining limitations* — because nothing
   * on this plane had ever moved it to REPAIRED. The evidence was right and the
   * sentence about it was wrong.
   */
  it('marks the finding repaired from the unit reaching INTEGRATED', async () => {
    const workerId = (await createWorker({ name: 'fix', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `repaired-${Math.random()}`,
      objective: 'Guard the published tree.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
    });
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 1,
      laneTargetReason: 'test',
      executionMode: 'REMOTE',
    });

    // A review with one finding, and the repair unit the finding produced.
    const { recordReview, listFindings } = await import('../server/repos/factoryFleet.ts');
    await recordReview({
      campaignId: campaign.id,
      round: 1,
      scope: 'CAMPAIGN',
      reviewerSessionId: 'cse_reviewer',
      reviewedSha: BASE,
      verdict: 'CHANGES_REQUIRED',
      independence: 'SESSION_SEPARATED',
      summary: 'one thing to fix',
      findings: [
        {
          key: 'ci-runs-only-the-floor',
          severity: 'MINOR',
          category: 'ci',
          statement: 'CI exercises only the declared floor.',
          evidence: '.github/workflows/ci.yml',
          acceptanceConditionId: 'A01',
        },
      ],
    });
    const { queueRepairs } = await import('../server/services/factory/repair.ts');
    const queued = await queueRepairs(campaign, changeRequest);
    expect(queued.queued.length).toBe(1);

    const { getUnitByKey, claimUnits, markImplemented, markIntegrated, promoteReadyUnits } =
      await import('../server/repos/factory.ts');
    await promoteReadyUnits(campaign.id);
    const unit = (await getUnitByKey(campaign.id, queued.queued[0]!.unitKey))!;
    const held = (
      await claimUnits({ campaignId: campaign.id, workerId, unitIds: [unit.id], leaseMs: 60_000 })
    )[0]!;
    await markImplemented(
      { unitId: unit.id, workerId, leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
      {
        branch: 'factory/x/repair/a1',
        headSha: 'd'.repeat(40),
        baseSha: BASE,
        worktreePath: null,
        workerSummary: 'repaired',
        terminalResult: { outcome: 'IMPLEMENTED', commands: [], filesForgeReported: [], filesWorkerReported: [] },
      },
    );
    await markIntegrated(unit.id, 'd'.repeat(40));

    // Before the tick the finding is still carried as open work.
    const beforeTick = await listFindings(campaign.id);
    // A finding exists to be carried; `every` over none would pass vacuously.
    expect(beforeTick.length).toBeGreaterThan(0);
    expect(beforeTick.every((f) => f.state !== 'REPAIRED')).toBe(true);

    stubForge({});
    await tickRemoteCampaign(campaign.id);

    const after = await listFindings(campaign.id);
    expect(after.length).toBe(1);
    expect(after[0]!.state).toBe('REPAIRED');
    expect(after[0]!.resolution ?? '').toContain('verified on the merged tree');
  });
});

/* ========================================================================= */

describe('a reviewer Brain fired is identified by the fire, not by what it says', () => {
  /*
   * `brain_check_in`'s `session_ref` is an **optional** argument whose schema used to
   * say it was "never used to decide anything" — while the review-independence floor
   * decided on it. So a worker that simply omitted the field was refused every
   * review, silently, with nothing in `bin_session_refusals` to say so because that
   * table is keyed by the session that is missing.
   *
   * Production did exactly that: Brain chose the right surface, fired it, the
   * provider created the session, and the review bin sat READY at nought attempts
   * with no row anywhere naming a reason. Brain knew which session it had fired the
   * whole time — it is on the dispatch row it wrote — which is where §24 says a
   * session identity comes from in the first place.
   */
  let campaignId = '';
  let workerId = '';
  let reviewBinId = '';

  beforeEach(async () => {
    workerId = (await createWorker({ name: 'rev-id', createdByType: 'SYSTEM', createdById: 't' })).id;
    await registerFactoryWorker(workerId);
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `review-id-${Math.random()}`,
      objective: 'Guard the published tree.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    const { createReviewBin } = await import('../server/services/factory/remote.ts');
    const bin = await createReviewBin(campaign, changeRequest, BASE, 1);
    reviewBinId = bin.id;
  });

  it('takes the session from the dispatch Brain sent when the worker reports none', async () => {
    const { ensureDispatchIntent, claimDispatchIntent, markDispatchSent, getBin } = await import(
      '../server/repos/bins.ts'
    );
    const bin = (await getBin(reviewBinId))!;

    // With no dispatch and nothing reported, the floor fails closed — it cannot
    // establish independence, so it does not assert it.
    const closed = await binAdmission({
      workerId,
      principal: reviewerPrincipal(workerId),
      sessionRef: null,
    });
    expect((await closed(bin)).ok).toBe(false);

    // Brain fires, and the provider's session id lands on Brain's own row.
    await ensureDispatchIntent(bin);
    const intent = await claimDispatchIntent();
    expect(intent).not.toBeNull();
    await markDispatchSent(intent!.id, {
      routineRef: 'trig_test',
      sessionRef: 'cse_fired_reviewer',
      fireEventId: 'cse_fired_reviewer',
    });

    // The same arrival, reporting nothing, is now identifiable and admitted.
    const admit = await binAdmission({
      workerId,
      principal: reviewerPrincipal(workerId),
      sessionRef: null,
    });
    expect((await admit((await getBin(reviewBinId))!)).ok).toBe(true);
  });

  it('records the fired session on the lease, so ingest judges the session admission admitted', async () => {
    /*
     * Admission falls back to the dispatched session; the lease stored only the
     * reported one. So a reviewer that reported none was admitted, reviewed,
     * completed — and was refused at ingest for "recorded no session", on a
     * COMPLETE bin nothing retries, with a new review bin fired every tick.
     */
    const { ensureDispatchIntent, claimDispatchIntent, markDispatchSent, getBin, assignNextBin } =
      await import('../server/repos/bins.ts');
    const bin = (await getBin(reviewBinId))!;
    await ensureDispatchIntent(bin);
    const intent = await claimDispatchIntent();
    await markDispatchSent(intent!.id, {
      routineRef: 'trig_test',
      sessionRef: 'cse_fired_reviewer',
      fireEventId: 'cse_fired_reviewer',
    });
    const assigned = await assignNextBin({
      workerId,
      projectIds: [fixture.project.id],
      credentialId: 'cred_reviewer_no_session',
      sessionRef: null,
    });
    expect(assigned?.bin.id).toBe(reviewBinId);
    expect((await getBin(reviewBinId))!.leaseSessionRef).toBe('cse_fired_reviewer');
  });

  it('still refuses the session that implemented the work, however it is identified', async () => {
    const { recordFactoryEvent: record } = await import('../server/repos/factoryFleet.ts');
    const { FACTORY_EVENT_KINDS } = await import('../server/services/factory/metrics.ts');
    await record({
      campaignId,
      kind: FACTORY_EVENT_KINDS.unitImplemented,
      evidenceClass: 'MEASURED',
      sessionId: 'cse_fired_reviewer',
      detail: { unitKey: 'u', binId: 'bin_x' },
    });
    const { ensureDispatchIntent, claimDispatchIntent, markDispatchSent, getBin } = await import(
      '../server/repos/bins.ts'
    );
    const bin = (await getBin(reviewBinId))!;
    await ensureDispatchIntent(bin);
    const intent = await claimDispatchIntent();
    await markDispatchSent(intent!.id, {
      routineRef: 'trig_test',
      sessionRef: 'cse_fired_reviewer',
      fireEventId: 'cse_fired_reviewer',
    });
    const admit = await binAdmission({
      workerId,
      principal: reviewerPrincipal(workerId),
      sessionRef: null,
    });
    const verdict = await admit((await getBin(reviewBinId))!);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason ?? '').toContain('implemented part of this campaign');
  });
});

/* ========================================================================= */

describe('a branch nobody was supposed to move is noticed, not punished', () => {
  /*
   * Every units bin's manifest prohibits pushing, merging into or otherwise moving
   * the campaign's integration branch, names the branch, and says integrating is a
   * separate bin judged by a session that implemented none of it. In production a
   * unit worker pushed its commit to its own branch *and* fast-forwarded the
   * campaign branch onto it. The content was exactly what the unit declared and
   * exactly what Brain would have integrated; the route was one nothing reviewed.
   *
   * **A prohibition in a prompt is not a control**, and Brain cannot make one — push
   * access is granted where the worker runs. So the control is that Brain reads the
   * branch, records what it finds on the campaign's own ledger, and tells the
   * integrator. It does not refuse: the integration still judges the whole range
   * from the base Brain recorded against the union of declared paths, and delivery
   * still refuses a pull request whose head is not the commit Brain integrated.
   */
  let campaignId = '';
  let workerId = '';
  const unitHead = 'a'.repeat(39) + '1';
  const moved = 'a'.repeat(39) + '2';
  let unitBranch = '';
  let integrationBranch = '';

  beforeEach(async () => {
    workerId = (await createWorker({ name: 'drift', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `drift-${Math.random()}`,
      objective: 'Guard the published tree.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    await ensureUnit({
      campaignId,
      unitKey: 'only-unit',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the published tree',
      objective: 'Assert the build publishes the site only.',
      acceptance: ['the suite fails when a repository-only file is published'],
      ownedPaths: ['test/only.test.js'],
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

    // One unit implemented and confirmed, so the next stage is the integration.
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    const { declaredBranchFor } = await import('../server/services/factory/remote.ts');
    unitBranch = declaredBranchFor(assigned!.bin, 'only-unit')!;
    integrationBranch = (await getCampaign(campaignId))!.integrationBranch;
    stubForge({
      branches: { [unitBranch]: unitHead },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/only.test.js'], status: 'ahead' } },
    });
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'only-unit',
      value: JSON.stringify({
        unitKey: 'only-unit',
        outcome: 'IMPLEMENTED',
        branch: unitBranch,
        headSha: unitHead,
        filesChanged: ['test/only.test.js'],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'implemented',
      }),
      contentHash: 'h-drift',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    await finishBin(
      {
        binId: assigned!.bin.id,
        leaseId: assigned!.leaseId,
        leaseGeneration: assigned!.leaseGeneration,
        workerId,
      },
      { state: 'COMPLETE', reason: 'implemented' },
    );
  });

  it('records the branch being somewhere Brain did not leave it, and still hands the stage out', async () => {
    // The integration branch has been moved by somebody who was not an integrator.
    stubForge({
      branches: { [unitBranch]: unitHead, [integrationBranch]: moved },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/only.test.js'], status: 'ahead' } },
    });
    const report = await tickRemoteCampaign(campaignId);
    expect(report.created.some((entry) => entry.startsWith('integrate:'))).toBe(true);
    expect(report.state).not.toBe('BLOCKED');
    expect(report.notes.some((note) => note.includes('Brain left it at'))).toBe(true);

    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const events = await listFactoryEvents(campaignId, {
      kinds: ['STALE_BASE_DETECTED'],
      limit: 10,
    });
    expect(events.length).toBe(1);
    const detail = events[0]!.detail as { brainLeftItAt?: unknown; forgeSaysItIsAt?: unknown };
    expect(detail.brainLeftItAt).toBe(BASE);
    expect(detail.forgeSaysItIsAt).toBe(moved);

    // And the integrator is told, in the bin it was handed.
    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_INTEGRATE');
    const spec = (assigned!.bin.manifest.units ?? [])[0];
    expect(spec?.establishes).toContain('Brain left it at');
  });

  it('says nothing when the branch is exactly where Brain left it', async () => {
    stubForge({
      branches: { [unitBranch]: unitHead, [integrationBranch]: BASE },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/only.test.js'], status: 'ahead' } },
    });
    const report = await tickRemoteCampaign(campaignId);
    expect(report.created.some((entry) => entry.startsWith('integrate:'))).toBe(true);
    expect(report.notes.some((note) => note.includes('Brain left it at'))).toBe(false);
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    expect(
      (await listFactoryEvents(campaignId, { kinds: ['STALE_BASE_DETECTED'], limit: 10 })).length,
    ).toBe(0);
  });
});

/* ========================================================================= */

describe('a check-in derives the next stage rather than saying there is nothing', () => {
  /*
   * The defect this pins cost an hour per stage in production, and nothing about
   * it looked wrong.
   *
   * A factory stage becomes available only when a tick reads what the last one
   * finished, and the loop ticks every twenty seconds — `index.ts` says that
   * interval exists so a stage becoming ready inside an activation is taken by the
   * worker that is still there. The worker did not wait twenty seconds. It
   * integrated two units, pushed, completed its bin, checked in again within the
   * same minute, was told NO_WORK because the tick had not run yet, and ended with
   * its own summary reading "awaiting next Brain check-in". The next stage became
   * ready seconds later and sat there until the next hourly activation.
   *
   * A timer is the wrong place to answer a question somebody is asking right now.
   */
  let campaignId = '';
  let workerId = '';
  let credentialId = '';
  const unitHead = 'e'.repeat(40);

  function session(cred: string): Principal {
    return {
      type: 'WORKER',
      id: workerId,
      handle: 'derive-worker',
      displayName: 'derive-worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: cred,
      authMethod: 'WORKER_BEARER',
      memberships: [
        {
          projectId: fixture.project.id,
          principalType: 'WORKER',
          principalId: workerId,
          role: 'MEMBER',
          scopes: ['queue:claim', 'queue:complete', 'research:write'],
          active: true,
        } as unknown as Principal['memberships'][number],
      ],
      requestId: `req_${cred}`,
    };
  }

  beforeEach(async () => {
    const worker = await createWorker({ name: 'derive', createdByType: 'SYSTEM', createdById: 't' });
    workerId = worker.id;
    await registerFactoryWorker(workerId);
    credentialId = `cred_${workerId}`;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `derive-${Math.random()}`,
      objective: 'Guard the published tree.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    await ensureUnit({
      campaignId,
      unitKey: 'only-unit',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the published tree',
      objective: 'Assert the build publishes the site only.',
      acceptance: ['the suite fails when a repository-only file is published'],
      ownedPaths: ['test/only.test.js'],
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
  });

  it('hands out the integration the worker just made possible, in the same check-in', async () => {
    const { checkIn } = await import('../server/services/bins/service.ts');
    stubForge({});

    // The units stage, taken and finished the way a worker finishes it.
    const first = await checkIn({ principal: session(credentialId), workerId, sessionRef: credentialId });
    expect(first.assigned).toBe(true);
    if (!first.assigned) return;
    expect(first.assignment.kind).toBe('FACTORY_UNITS');

    const bin = (await getBin(first.assignment.binId))!;
    const { declaredBranchFor } = await import('../server/services/factory/remote.ts');
    const branch = declaredBranchFor(bin, 'only-unit')!;
    stubForge({
      branches: { [branch]: unitHead },
      compares: { [`${BASE}...${unitHead}`]: { files: ['test/only.test.js'], status: 'ahead' } },
    });
    await putBinUnitResult({
      binId: bin.id,
      unitKey: 'only-unit',
      value: JSON.stringify({
        unitKey: 'only-unit',
        outcome: 'IMPLEMENTED',
        branch,
        headSha: unitHead,
        filesChanged: ['test/only.test.js'],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'implemented',
      }),
      contentHash: 'h-derive',
      leaseId: first.assignment.leaseId,
      leaseGeneration: first.assignment.leaseGeneration,
    });
    expect(
      await finishBin(
        {
          binId: bin.id,
          leaseId: first.assignment.leaseId,
          leaseGeneration: first.assignment.leaseGeneration,
          workerId,
        },
        { state: 'COMPLETE', reason: 'implemented' },
      ),
    ).toBe('OK');

    /*
     * And straight back for more, with no tick in between. Before the derivation
     * this answered NO_READY_BINS: the integration stage exists only once a tick
     * has read the report that was stored a second ago.
     */
    const second = await checkIn({
      principal: session(credentialId),
      workerId,
      sessionRef: credentialId,
    });
    expect(second.assigned).toBe(true);
    if (!second.assigned) return;
    expect(second.assignment.kind).toBe('FACTORY_INTEGRATE');
  });

  it('still says there is nothing when there is nothing', async () => {
    const { checkIn } = await import('../server/services/bins/service.ts');
    stubForge({});
    const { patchCampaign } = await import('../server/repos/factory.ts');
    await patchCampaign(campaignId, { state: 'CANCELLED' });
    const arrival = await checkIn({
      principal: session(credentialId),
      workerId,
      sessionRef: credentialId,
    });
    expect(arrival.assigned).toBe(false);
    if (!arrival.assigned) expect(arrival.reason).toBe('NO_READY_BINS');
  });
});

/* ========================================================================= */

describe('a unit value too large is refused, never truncated', () => {
  /*
   * The defect this pins cost a correct plan two attempts and a bin.
   * `putBinUnitResult` sliced the value to the cap, so a three-unit factory
   * decomposition was cut mid-JSON; the contract then told the worker "no plan was
   * submitted under unit key `plan`, or it was not valid JSON" — true of what was
   * stored and useless about why — and the worker re-submitted the same correct
   * plan until the bin retired at NEEDS_HUMAN.
   *
   * Truncation is the one outcome a worker cannot recover from, because it is
   * reported as success.
   */
  it('stores nothing and says what the limit is', async () => {
    const { putBinUnitResult, MAX_UNIT_VALUE_CHARS, listBinUnitResults } = await import(
      '../server/repos/bins.ts'
    );
    const workerId = (
      await createWorker({ name: 'verbose', createdByType: 'SYSTEM', createdById: 't' })
    ).id;
    const bin = await createBin({
      projectId: fixture.project.id,
      kind: 'FACTORY_PLAN',
      title: 'Plan something',
      objective: 'Propose a decomposition.',
      manifest: {
        objective: 'Propose a decomposition.',
        why: 'a test',
        lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
        units: [{ key: 'plan', establishes: 'a decomposition', input: '{}', transform: 'FACTORY_PLAN', dependsOn: [] }],
        acceptableSources: [],
        excludedSources: [],
        evidence: ['a submitted plan'],
        outputs: ['one result'],
        authorizedActions: ['read the repository'],
        prohibitedActions: ['write anything'],
        budgetUnits: null,
        retry: { maxAttempts: 2, backoffSeconds: 60 },
        stoppingConditions: ['a plan is stored'],
      },
      completionContract: 'FACTORY_PLAN_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    const assigned = await assignNextBin({ workerId, projectIds: [fixture.project.id] });
    expect(assigned?.bin.id).toBe(bin.id);

    // A value one character past the limit, and valid JSON right up to the end.
    const filler = 'x'.repeat(MAX_UNIT_VALUE_CHARS);
    const oversized = JSON.stringify({ units: [], note: filler });
    expect(oversized.length).toBeGreaterThan(MAX_UNIT_VALUE_CHARS);

    const outcome = await putBinUnitResult({
      binId: bin.id,
      unitKey: 'plan',
      value: oversized,
      contentHash: 'h-big',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(outcome.stored).toBe(false);
    expect(outcome.tooLarge?.limit).toBe(MAX_UNIT_VALUE_CHARS);
    expect(outcome.tooLarge?.received).toBe(oversized.length);
    // Nothing was written, so there is no half a plan for anything to misread.
    expect(await listBinUnitResults(bin.id)).toHaveLength(0);

    // And a value inside the limit still stores whole.
    const fits = JSON.stringify({ units: [], note: 'x'.repeat(100) });
    const stored = await putBinUnitResult({
      binId: bin.id,
      unitKey: 'plan',
      value: fits,
      contentHash: 'h-small',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(stored.stored).toBe(true);
    expect((await listBinUnitResults(bin.id))[0]?.value).toBe(fits);
  });

  it('is large enough for a realistic factory plan', async () => {
    const { MAX_UNIT_VALUE_CHARS } = await import('../server/repos/bins.ts');
    // Three units, each with the fields `validatePlan` requires, is the shape that
    // did not fit. The number is not sacred; being bigger than the thing it has to
    // hold is the point.
    const unit = {
      key: 'a-bounded-unit-key',
      kind: 'IMPLEMENTATION',
      title: 'A title a person would recognise',
      objective: 'x'.repeat(600),
      acceptance: ['y'.repeat(300), 'z'.repeat(300)],
      ownedPaths: ['scripts/build.mjs', 'test/**', 'package.json'],
      requiredContext: ['w'.repeat(200)],
      verification: ['npm test', 'npm run build'],
      expectedArtifact: 'v'.repeat(200),
      risk: 'LOW',
      criticalPath: true,
      dependsOn: [],
      serves: ['A01', 'A02'],
    };
    const plan = JSON.stringify({ units: [unit, unit, unit] });
    expect(plan.length).toBeLessThan(MAX_UNIT_VALUE_CHARS);
  });
});

/* ========================================================================= */

/**
 * A blocker is taken off when the stage it named can be handed out again.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists for
 * ---------------------------------------------------------------------------
 *
 * `noteSurfaceBlocker` states the rule in its own doc comment: a blocker is a
 * derived annotation beside a *truthful* state, and the answering transition is
 * free, because the condition stops being true and the next tick takes the
 * sentence away. `blockStage` is the half that did not obey it — it moves `state`
 * to BLOCKED, and nothing anywhere moved it back. The paths that merely wait for
 * a worker returned without writing a word, so whatever the last block wrote
 * stood for as long as the stage ran.
 *
 * Production, 2026-09-22, on `fcp_189ea30c7ded4e7b9280`. The integrate bin was
 * answered at 12:05:06 —
 *
 *     regrant raised=true attempts 2/2 -> 2/6
 *     reopened bin_43915e4f93ca4e3db111 NEEDS_HUMAN -> READY, generation 2 -> 3
 *
 * — and a worker was integrating on it twenty-three minutes later, at which point
 * `factory status` read:
 *
 *     campaign fcp_189ea30c7ded4e7b9280 BLOCKED — integration cannot be handed
 *     out again
 *     BLOCKER UNIT_EXHAUSTED_ATTEMPTS: Bin bin_43915e4f93ca4e3db111 is waiting
 *     for a person. It has its own answer; until it is given one this stage is
 *     not handed out again...
 *
 * It had been given one. **A status that contradicts the rows underneath it is
 * worse than no status**: it sends a reader to answer something that was answered
 * twenty-three minutes ago, and it teaches them to stop believing the one line
 * that says a campaign is genuinely stuck. §27 already records the same sentence
 * about a warning that cries wolf.
 *
 * Both halves are asserted, because a fix that cleared the blocker whenever a bin
 * existed would take the sentence off a stage that really is parked.
 */
describe('a stage blocker comes off when the stage can be handed out again', () => {
  let campaignId = '';
  let workerId = '';

  beforeEach(async () => {
    workerId = (await createWorker({ name: 'unstick', createdByType: 'SYSTEM', createdById: 't' }))
      .id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'unstick',
      objective: 'Guard the quote form against silent breakage.',
      expectedOutcome: 'npm test fails when the form contract breaks.',
      nonGoals: [],
      acceptanceConditions: [
        {
          id: 'A01',
          statement: 'the suite asserts the form',
          verification: 'npm test',
          mandatory: true,
        },
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
  });

  /** One implemented unit, so the integration stage is the live one. */
  async function anImplementedUnit(): Promise<void> {
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
  }

  /** The integrate bin this campaign's tick made, parked the way production's was. */
  async function theParkedIntegrateBin(): Promise<string> {
    stubForge({});
    await anImplementedUnit();
    await tickRemoteCampaign(campaignId);
    const [bin] = (await listBins({ projectId: fixture.project.id })).filter(
      (candidate) => candidate.kind === 'FACTORY_INTEGRATE',
    );
    expect(bin).toBeTruthy();
    const { terminateUnleasedBin } = await import('../server/repos/bins.ts');
    expect(
      await terminateUnleasedBin(
        bin!.id,
        bin!.leaseGeneration,
        'NEEDS_HUMAN',
        'The bin used all its attempts without satisfying FACTORY_INTEGRATION_V1.',
      ),
    ).toBe(true);
    const blocked = await tickRemoteCampaign(campaignId);
    expect(blocked.state).toBe('BLOCKED');
    const campaign = await getCampaign(campaignId);
    expect(campaign?.state).toBe('BLOCKED');
    expect(campaign?.blockerKind).toBe('UNIT_EXHAUSTED_ATTEMPTS');
    return bin!.id;
  }

  it('leaves the blocker on while the bin really is waiting for a person', async () => {
    await theParkedIntegrateBin();
    // A second tick changes nothing: nobody has answered it.
    await tickRemoteCampaign(campaignId);
    const campaign = await getCampaign(campaignId);
    expect(campaign?.state).toBe('BLOCKED');
    expect(campaign?.blockerKind).toBe('UNIT_EXHAUSTED_ATTEMPTS');
    expect(campaign?.blockerDetail ?? '').toContain('waiting for a person');
  });

  it('takes it off once the bin has been answered and can be handed out again', async () => {
    const binId = await theParkedIntegrateBin();

    // Exactly what `factory answer-bin` does in production.
    const { reopenParkedBin } = await import('../server/services/bins/service.ts');
    const reopened = await reopenParkedBin({
      binId,
      operator: 'operator:test',
      reason: 'Attempts spent on a Brain-side defect that left the bin nothing it could satisfy.',
    });
    expect(reopened.ok).toBe(true);

    const report = await tickRemoteCampaign(campaignId);
    const campaign = await getCampaign(campaignId);

    // The bin is claimable and an integrator may be handed it, so the campaign is
    // integrating rather than blocked, and no sentence anywhere says a person is
    // owed a decision.
    expect(campaign?.state).toBe('INTEGRATING');
    expect(campaign?.blockerKind).toBeNull();
    expect(campaign?.blockerDetail).toBeNull();
    expect(report.state).toBe('INTEGRATING');
    expect(report.stage ?? '').not.toContain('cannot be handed out again');

    // And nothing was destroyed to get there: the bin keeps its attempts and the
    // unit keeps its commit.
    const bin = await getBin(binId);
    expect(bin?.state).toBe('READY');
    const [unit] = await listUnits(campaignId);
    expect(unit?.state).toBe('IMPLEMENTED');
    expect(unit?.headSha).toBe(HEAD);
  });
});

/* ========================================================================= */

describe('a bin that completed after the ingest had its chance still holds its stage', () => {
  /*
   * The defect this pins cost two Cowork activations on one production campaign,
   * and every row it left behind read as healthy.
   *
   * `runRemoteTick` reads the bins twice — once at the top, so every COMPLETE one
   * is offered to its ingest, and again afterwards, to decide what the campaign
   * now needs. A worker completing a bin *between* those reads makes the stage
   * decision fall through a gap: "this bin is no longer live" is true in the
   * second read while "this bin's report has been read" is still false, so the
   * stage is handed out again for work the completed bin had in fact just done.
   *
   * Production, 2026-09-22, `fcp_189ea30c7ded4e7b9280`.
   * `bin_43915e4f93ca4e3db111` integrated `repair-late-link-never-attested` and
   * reached COMPLETE at 12:28:33.813Z. `bin_0b6cdc2502d54b75b8c1`, titled
   * *Integrate 1 unit(s)*, was READY at 12:28:35.895Z — 2.08 seconds later — and
   * assigned 3.8 seconds after that to the same Cowork session, which spent 1291
   * seconds re-merging an already merged branch. Brain then refused its report
   * twice, correctly: *"The report claims to have merged
   * \"repair-late-link-never-attested\", which is not one of the units this bin
   * was given."* The review stage did the same thing in the same campaign twenty
   * minutes later — `bin_c19cb071e0054316b540` ended 12:50:37.416Z and
   * `bin_5fb255777c7d4997878a` was taken 6.4 seconds after it.
   *
   * The completion's own compensating advance cannot close it, which is why the
   * fix is at this seam and not in `advanceFactoryAfter`: that advance takes the
   * same campaign compare-and-swap, so with a pass already in flight it declines
   * and leaves the work to the loop. **This test reproduces that precondition
   * rather than assuming it** — the tick is genuinely held by somebody else while
   * the bin completes, so the report is genuinely unread afterwards.
   */
  let campaignId = '';
  let implementer = '';
  let integrator = '';
  let integrationBranch = '';
  const unitHead = '4'.repeat(40);
  const integrationHead = '5'.repeat(40);

  beforeEach(async () => {
    implementer = (await createWorker({ name: 'impl-w', createdByType: 'SYSTEM', createdById: 't' })).id;
    integrator = (await createWorker({ name: 'int-w', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `pass-consistent-${Math.random()}`,
      objective: 'Keep the published site free of repository-only files.',
      expectedOutcome: 'The suite fails when they appear.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    integrationBranch = campaign.integrationBranch;
    await ensureUnit({
      campaignId,
      unitKey: 'only-unit',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the published tree',
      objective: 'Assert the build publishes the site only.',
      acceptance: ['the suite fails when a repository-only file is published'],
      ownedPaths: ['test/only.test.js'],
      requiredContext: [],
      verification: ['npm test'],
      expectedArtifact: 'a test file',
      risk: 'LOW',
      criticalPath: true,
      priority: 5,
      modelClass: 'FAST',
    });
    await registerFactoryWorker(implementer);
    await registerFactoryWorker(integrator);

    // One implemented unit, by the path a worker takes.
    const { promoteReadyUnits } = await import('../server/repos/factory.ts');
    await promoteReadyUnits(campaignId);
    const unit = (await getUnitByKey(campaignId, 'only-unit'))!;
    const held = (
      await claimUnits({ campaignId, workerId: implementer, unitIds: [unit.id], leaseMs: 60_000 })
    )[0]!;
    await markImplemented(
      { unitId: unit.id, workerId: implementer, leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
      {
        branch: `factory/${campaignId}/only-unit/a1`,
        headSha: unitHead,
        baseSha: BASE,
        worktreePath: null,
        workerSummary: 'implemented',
        terminalResult: { outcome: 'IMPLEMENTED', commands: [], filesForgeReported: [], filesWorkerReported: [] },
      },
    );
  });

  /** The forge agrees with an integration that really did carry the unit. */
  function forgeConfirmsTheIntegration(): void {
    stubForge({
      branches: { [integrationBranch]: integrationHead },
      compares: {
        [`${unitHead}...${integrationHead}`]: { files: ['test/only.test.js'], status: 'ahead' },
        [`${BASE}...${integrationHead}`]: { files: ['test/only.test.js'], status: 'ahead' },
      },
    });
  }

  it('does not offer the stage again for work whose report this pass has not read', async () => {
    forgeConfirmsTheIntegration();
    const created = await tickRemoteCampaign(campaignId);
    expect(created.created.some((entry) => entry.startsWith('integrate:'))).toBe(true);

    const assigned = await assignNextBin({ workerId: integrator, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_INTEGRATE');
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'integrate',
      value: JSON.stringify({
        outcome: 'IMPLEMENTED',
        integrationBranch,
        headSha: integrationHead,
        merged: [{ unitKey: 'only-unit', branch: `factory/${campaignId}/only-unit/a1`, headSha: unitHead }],
        conflicts: [],
        commands: [{ command: 'npm test', exitCode: 0 }],
        summary: 'merged and verified',
      }),
      contentHash: 'h-integrate',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });

    const { campaignBins, liveBinOfKind, binsThisPassMayJudge } = await import(
      '../server/services/factory/remote.ts'
    );
    const { claimCampaignTick, releaseCampaignTick } = await import('../server/repos/factory.ts');
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');

    // What a pass reads at the top, before it offers anything to the ingest.
    const offeredToIngest = await campaignBins(campaignId);
    expect(liveBinOfKind(offeredToIngest, 'FACTORY_INTEGRATE')?.id).toBe(assigned!.bin.id);

    /*
     * The completion lands with the campaign's tick genuinely held by somebody
     * else, which is the production precondition: `advanceFactoryAfter` takes the
     * same compare-and-swap, declines, and leaves the report unread.
     */
    const otherPass = await claimCampaignTick(campaignId, 'another-dispatcher');
    expect(otherPass.ok).toBe(true);
    expect(
      await finishBin(
        {
          binId: assigned!.bin.id,
          leaseId: assigned!.leaseId,
          leaseGeneration: assigned!.leaseGeneration,
          workerId: integrator,
        },
        { state: 'COMPLETE', reason: 'integrated' },
      ),
    ).toBe('OK');

    // The world the second read sees: the bin is COMPLETE and nothing has read it.
    const now = await campaignBins(campaignId);
    expect((await getBin(assigned!.bin.id))?.state).toBe('COMPLETE');
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('IMPLEMENTED');
    expect(
      (await listFactoryEvents(campaignId, { kinds: ['INTEGRATION_MERGED', 'INTEGRATION_REJECTED'] }))
        .length,
    ).toBe(0);

    // The defect, named rather than implied: on the newest read alone the stage
    // looks free, which is what handed production a second integrator.
    expect(liveBinOfKind(now, 'FACTORY_INTEGRATE')).toBeNull();

    // And the rule: this pass may not judge the stage free, because its ingest
    // never had the chance to read that bin.
    expect(liveBinOfKind(binsThisPassMayJudge(offeredToIngest, now), 'FACTORY_INTEGRATE')?.id).toBe(
      assigned!.bin.id,
    );

    // The next pass reads it COMPLETE at the top, ingests it, and the campaign
    // moves on — with exactly one integration bin ever made.
    await releaseCampaignTick(campaignId, 'another-dispatcher', otherPass.ok ? otherPass.generation : 0);
    forgeConfirmsTheIntegration();
    const ingested = await tickRemoteCampaign(campaignId);
    expect(ingested.ingested.some((entry) => entry.startsWith('integrate:'))).toBe(true);
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('INTEGRATED');
    const integrateBins = (await campaignBins(campaignId)).filter(
      (bin) => bin.kind === 'FACTORY_INTEGRATE',
    );
    expect(integrateBins).toHaveLength(1);
  });

  it('never carries a bin somebody has already answered forward as a blocker', async () => {
    /*
     * The narrow edge the predicate is scoped for. A bin that was `NEEDS_HUMAN`
     * when this pass began, was answered, and completed before the second read
     * must not be reported back as `NEEDS_HUMAN` — `stalledStage` would read that
     * as a stage waiting for a person and block a campaign whose bin had in fact
     * just been answered. Only a bin a stage was genuinely *waiting on* is
     * carried, which is what `isLiveBin` says and what `liveBinOfKind` already
     * meant by live.
     */
    const { binsThisPassMayJudge } = await import('../server/services/factory/remote.ts');
    const parked = {
      id: 'bin_parked',
      kind: 'FACTORY_INTEGRATE',
      state: 'NEEDS_HUMAN',
    } as unknown as Awaited<ReturnType<typeof getBin>> & object;
    const completed = { ...parked, state: 'COMPLETE' };
    const judged = binsThisPassMayJudge([parked as never], [completed as never]);
    expect(judged[0]?.state).toBe('COMPLETE');
  });

  it('carries nothing forward once the ingest has had its chance at that bin', async () => {
    /*
     * The other half, and the one that stops the fix becoming a stage that is
     * never handed out again. A bin already COMPLETE when the pass began was
     * offered to the ingest, so it is reported exactly as the table has it — and
     * a stage with nothing live is free to be handed out.
     */
    const { campaignBins, liveBinOfKind, binsThisPassMayJudge } = await import(
      '../server/services/factory/remote.ts'
    );
    forgeConfirmsTheIntegration();
    await tickRemoteCampaign(campaignId);
    const assigned = await assignNextBin({ workerId: integrator, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_INTEGRATE');
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'integrate',
      value: JSON.stringify({
        outcome: 'BLOCKED',
        integrationBranch,
        merged: [],
        conflicts: [],
        commands: [],
        summary: 'the remote refused this surface',
        blockedReason: 'no credential for the remote',
      }),
      contentHash: 'h-blocked',
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        {
          binId: assigned!.bin.id,
          leaseId: assigned!.leaseId,
          leaseGeneration: assigned!.leaseGeneration,
          workerId: integrator,
        },
        { state: 'COMPLETE', reason: 'blocked' },
      ),
    ).toBe('OK');

    // Both reads of a settled world agree, so nothing is substituted and the
    // stage is judged exactly as the table has it.
    const offeredToIngest = await campaignBins(campaignId);
    const now = await campaignBins(campaignId);
    expect(offeredToIngest.find((bin) => bin.id === assigned!.bin.id)?.state).toBe('COMPLETE');
    expect(liveBinOfKind(binsThisPassMayJudge(offeredToIngest, now), 'FACTORY_INTEGRATE')).toBeNull();
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('IMPLEMENTED');
  });
});

/* ========================================================================= */

describe('a completed integration bin that could not be ingested says so in the ledger', () => {
  /*
   * Four things go wrong at this seam and, before this, each of them was one
   * silent `return false`. The bin stayed COMPLETE, the units stayed
   * IMPLEMENTED, the stage was offered again, and the ledger recorded nothing —
   * so a reader watching a campaign make integration bins that never landed had
   * no first step, and could not tell a forge that would not answer from a report
   * nobody could read.
   *
   * §27 reported exactly this as an open reading rather than repairing it, on the
   * grounds that two of the paths were indistinguishable in the rows. They are
   * distinguishable now, and these are the regressions for it.
   *
   * What the tests are careful about is the half that is *not* the row: the retry
   * must survive. A record that stopped the ingest being attempted again would
   * turn one forge outage into a completed report nothing ever reads, and a
   * record the stage ceiling counted would retire a stage for a condition that
   * was never about the work.
   */
  let campaignId = '';
  let implementer = '';
  let integrator = '';
  let integrationBranch = '';
  let changeRequestId = '';
  const unitHead = '7'.repeat(40);
  const integrationHead = '8'.repeat(40);

  beforeEach(async () => {
    implementer = (await createWorker({ name: 'impl-r', createdByType: 'SYSTEM', createdById: 't' })).id;
    integrator = (await createWorker({ name: 'int-r', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `ingest-refusal-${Math.random()}`,
      objective: 'Something whose integration will be read and refused.',
      expectedOutcome: 'A reader can tell which of four things went wrong.',
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
    changeRequestId = changeRequest.id;
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    integrationBranch = campaign.integrationBranch;
    await ensureUnit({
      campaignId,
      unitKey: 'only-unit',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the published tree',
      objective: 'Assert the build publishes the site only.',
      acceptance: ['the suite fails when a repository-only file is published'],
      ownedPaths: ['test/only.test.js'],
      requiredContext: [],
      verification: ['npm test'],
      expectedArtifact: 'a test file',
      risk: 'LOW',
      criticalPath: true,
      priority: 5,
      modelClass: 'FAST',
    });
    await registerFactoryWorker(implementer);
    await registerFactoryWorker(integrator);

    const { promoteReadyUnits } = await import('../server/repos/factory.ts');
    await promoteReadyUnits(campaignId);
    const unit = (await getUnitByKey(campaignId, 'only-unit'))!;
    const held = (
      await claimUnits({ campaignId, workerId: implementer, unitIds: [unit.id], leaseMs: 60_000 })
    )[0]!;
    await markImplemented(
      { unitId: unit.id, workerId: implementer, leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
      {
        branch: `factory/${campaignId}/only-unit/a1`,
        headSha: unitHead,
        baseSha: BASE,
        worktreePath: null,
        workerSummary: 'implemented',
        terminalResult: { outcome: 'IMPLEMENTED', commands: [], filesForgeReported: [], filesWorkerReported: [] },
      },
    );
  });

  /** A forge that agrees the integration carried the unit. */
  function forgeConfirms(files: string[] = ['test/only.test.js']): void {
    stubForge({
      branches: { [integrationBranch]: integrationHead },
      compares: {
        [`${unitHead}...${integrationHead}`]: { files, status: 'ahead' },
        [`${BASE}...${integrationHead}`]: { files, status: 'ahead' },
      },
    });
  }

  /** The integration report a worker would submit for a real merge. */
  function goodReport(): string {
    return JSON.stringify({
      outcome: 'IMPLEMENTED',
      integrationBranch,
      headSha: integrationHead,
      merged: [{ unitKey: 'only-unit', branch: `factory/${campaignId}/only-unit/a1`, headSha: unitHead }],
      conflicts: [],
      commands: [{ command: 'npm test', exitCode: 0 }],
      summary: 'merged and verified',
    });
  }

  /**
   * Make the integrate bin, hand it to the integrator, submit `value`, complete
   * it — the whole path a worker takes, so the bin under test is a real one.
   */
  async function completedIntegrationBin(value: string): Promise<string> {
    forgeConfirms();
    await tickRemoteCampaign(campaignId);
    const assigned = await assignNextBin({ workerId: integrator, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_INTEGRATE');
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'integrate',
      value,
      contentHash: `h-${value.length}`,
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        {
          binId: assigned!.bin.id,
          leaseId: assigned!.leaseId,
          leaseGeneration: assigned!.leaseGeneration,
          workerId: integrator,
        },
        { state: 'COMPLETE', reason: 'submitted' },
      ),
    ).toBe('OK');
    return assigned!.bin.id;
  }

  async function refusals(): Promise<{ binId?: unknown; reason?: unknown; [key: string]: unknown }[]> {
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const events = await listFactoryEvents(campaignId, { kinds: ['INTEGRATION_NOT_INGESTED'] });
    return events.map((event) => (event.detail ?? {}) as Record<string, unknown>);
  }

  it('records a forge that would not confirm, once, without stopping the retry', async () => {
    const binId = await completedIntegrationBin(goodReport());

    // The forge answers nothing at all: the branch is 404 and no compare exists.
    stubForge({});
    const first = await tickRemoteCampaign(campaignId);
    expect(first.ingested.some((entry) => entry.startsWith('integrate:'))).toBe(false);
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('IMPLEMENTED');

    const [recorded, ...rest] = await refusals();
    expect(rest).toHaveLength(0);
    expect(recorded?.['reason']).toBe('FORGE_DID_NOT_CONFIRM');
    expect(recorded?.['binId']).toBe(binId);
    // The evidence, not just the category: what the forge actually said, which
    // unit was waiting, and the commit the report named.
    expect(String((recorded?.['problems'] as string[])[0])).toContain(integrationBranch);
    expect(recorded?.['units']).toEqual(['only-unit']);
    expect(recorded?.['reportedHeadSha']).toBe(integrationHead);
    expect(String(recorded?.['means'])).toContain('did not confirm');

    /*
     * The bound. A completed bin is re-read on every tick, so a row per pass would
     * be a fresh refusal every twenty seconds for the life of the campaign — the
     * exact cost `integrationAlreadyIngested` was written to stop one row along.
     */
    stubForge({});
    await tickRemoteCampaign(campaignId);
    await tickRemoteCampaign(campaignId);
    expect(await refusals()).toHaveLength(1);

    /*
     * And the half that makes it a record rather than a verdict: the retry
     * survives. A row read by `integrationAlreadyIngested` would have turned this
     * outage into a report nothing ever reads again.
     */
    forgeConfirms();
    const recovered = await tickRemoteCampaign(campaignId);
    expect(recovered.ingested.some((entry) => entry === `integrate:${binId}`)).toBe(true);
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('INTEGRATED');
    expect(await refusals()).toHaveLength(1);
  });

  it('does not count a refusal the ingest never judged towards the stage ceiling', async () => {
    await completedIntegrationBin(goodReport());
    stubForge({});
    await tickRemoteCampaign(campaignId);

    /*
     * `surfaceBlockedIntegrations` counts `INTEGRATION_REJECTED` rows carrying
     * `surface: true`, and that count is what blocks the stage at its ceiling.
     * These four refusals mean the ingest never got as far as judging the work, so
     * recording one there would retire a stage for a forge outage — §23's sentence
     * at a new row: a refusal is not misconduct.
     */
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    expect(
      await listFactoryEvents(campaignId, {
        kinds: ['INTEGRATION_REJECTED', 'INTEGRATION_MERGED'],
      }),
    ).toHaveLength(0);
    expect((await getCampaign(campaignId))?.state).not.toBe('BLOCKED');
  });

  it('records an unreadable report as its own reason, carrying what could not be read', async () => {
    const binId = await completedIntegrationBin('this is not an integration report');
    stubForge({});
    await tickRemoteCampaign(campaignId);

    const [recorded] = await refusals();
    expect(recorded?.['reason']).toBe('REPORT_UNUSABLE');
    expect(recorded?.['binId']).toBe(binId);
    expect((recorded?.['errors'] as unknown[]).length).toBeGreaterThan(0);
    expect(String(recorded?.['means'])).toContain('Nothing was judged');
    expect((await getUnitByKey(campaignId, 'only-unit'))?.state).toBe('IMPLEMENTED');
  });

  it('records a confirmed integration whose units something else had already moved', async () => {
    /*
     * The one route to this branch, and it is a race rather than a bad report.
     *
     * `verdict.ok` means every merge the report named cleared the forge, and the
     * parser refuses an `IMPLEMENTED` report that merged nothing — so `carried`
     * is never empty here. `markIntegrated` is guarded on the unit still being
     * `IMPLEMENTED` and this pass filtered on exactly that moments earlier, so
     * the only way every write matches nothing is that something moved the units
     * in between.
     *
     * So the test injects that, at the one instant it can happen: the forge call
     * inside `verifyIntegrationReport` sits between the filter and the write, and
     * the stub moves the unit while answering it. Reproducing the precondition
     * rather than asserting around it — the same discipline as the stage-race
     * regression above, which holds the campaign tick as another dispatcher.
     */
    const binId = await completedIntegrationBin(goodReport());
    const { getDb } = await import('../server/db/database.ts');
    forgeConfirms();
    const answering = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
      if (String(input).includes(`/compare/${BASE}...`)) {
        await getDb().run(
          `UPDATE factory_work_units SET state = 'INTEGRATED' WHERE campaign_id = ? AND unit_key = ?`,
          [campaignId, 'only-unit'],
        );
      }
      return await (answering as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
    }) as typeof globalThis.fetch;
    await tickRemoteCampaign(campaignId);

    const [recorded] = await refusals();
    expect(recorded?.['reason']).toBe('NO_UNIT_MOVED');
    expect(recorded?.['binId']).toBe(binId);
    // The fact that makes the row worth having: the forge agreed these units
    // were carried, and not one of them moved.
    expect(recorded?.['carried']).toEqual(['only-unit']);
    expect(recorded?.['units']).toEqual(['only-unit']);
    expect(String(recorded?.['means'])).toContain('something moved them');
    // And nothing was recorded as merged, because nothing this pass did merged it.
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    expect(await listFactoryEvents(campaignId, { kinds: ['INTEGRATION_MERGED'] })).toHaveLength(0);
  });

  it('is readable from the surface an operator asks "why is this not moving" on', async () => {
    /*
     * The half that makes a record a record.
     *
     * Every refusal above writes a row, and `factory_events` had **no reader on
     * any operator surface at all**: `campaignMetrics` aggregates it and
     * `surfaceBlockedIntegrations` counts one slice of it, and neither prints a
     * row. So giving each silent path a durable record would have closed the
     * defect one layer and reopened it the next — the row exists and nobody can
     * see it, which is the same sentence this whole repair is written from.
     *
     * Asserted by reading the door rather than by running it: what has to be
     * true is that `status` looks at these rows and that `events` exists to
     * print the rest, and a passing service call cannot show you either.
     */
    const binId = await completedIntegrationBin(goodReport());
    stubForge({});
    await tickRemoteCampaign(campaignId);
    const [recorded] = await refusals();
    expect(recorded?.['binId']).toBe(binId);

    const fs = await import('node:fs');
    const source = fs.readFileSync('scripts/factory.ts', 'utf8');
    const status = source.slice(source.indexOf("case 'status': {"), source.indexOf("case 'events': {"));
    expect(status, 'the status command must read the refusals').toMatch(
      /listFactoryEvents\([\s\S]*integrationNotIngested/,
    );
    // And the whole ledger has a door of its own, advertised where an operator
    // picks a command.
    expect(source).toMatch(/case 'events': \{/);
    expect(source.slice(source.lastIndexOf('commands:'))).toMatch(/events/);
  });

  it('records a repository this Brain cannot address', async () => {
    const binId = await completedIntegrationBin(goodReport());
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run('UPDATE factory_change_requests SET repository = ? WHERE id = ?', [
      'not a remote',
      changeRequestId,
    ]);
    await tickRemoteCampaign(campaignId);

    const [recorded] = await refusals();
    expect(recorded?.['reason']).toBe('REPOSITORY_UNREADABLE');
    expect(recorded?.['binId']).toBe(binId);
    expect(recorded?.['repository']).toBe('not a remote');
    expect(String(recorded?.['means'])).toContain('has to correct');
  });
});

/* ========================================================================= */

describe('a factory bin is checked against its own contract before it exists', () => {
  /*
   * `manifestProblems` opens by saying it is checked before a bin goes READY,
   * and had no caller in the repository — a guard described as running that did
   * not run, which is worse than an absent one because a reader concludes a bin
   * is validated and stops looking.
   *
   * Refusing at creation is cheap and refusing later is not: nothing has been
   * fired, no attempt charged and no worker activated, where the alternative is
   * `evaluateContract` discovering at completion that no evaluator was ever
   * registered for the contract — after a session has spent its time on it.
   *
   * The wider condition is left alone deliberately and asserted as left alone:
   * `createBin` is shared by every kernel in Brain, and wiring a refusal into it
   * would change research, cash, design and capability dispatch on the strength
   * of a factory audit.
   */
  it('refuses a manifest no evaluator could judge, and writes no row', async () => {
    const { createBin } = await import('../server/repos/bins.ts');
    const { manifestProblems } = await import('../server/services/bins/contracts.ts');
    const { listBins } = await import('../server/repos/bins.ts');

    const manifest = {
      objective: 'Something with a contract nothing can judge.',
      units: [],
      outputs: [],
      authorized: [],
      prohibitedActions: [],
    } as unknown as Parameters<typeof createBin>[0]['manifest'];

    // The rule itself, stated plainly: this manifest cannot be dispatched.
    expect(manifestProblems('NOT_A_REGISTERED_CONTRACT', manifest).length).toBeGreaterThan(0);

    const before = (await listBins({ projectId: fixture.project.id })).length;

    /*
     * `createBin` is the shared door and still accepts it — which is the
     * condition this test reports rather than closes. A bin created this way is
     * refused at `evaluateContract` instead, with a worker's time already spent.
     */
    const throughSharedDoor = await createBin({
      projectId: fixture.project.id,
      kind: 'FACTORY_PLAN',
      title: 'Unjudgeable',
      objective: 'Something with a contract nothing can judge.',
      manifest,
      completionContract: 'NOT_A_REGISTERED_CONTRACT' as never,
      priority: 5,
      createdByType: 'SYSTEM',
      createdById: 'test',
      maxAttempts: 1,
      ready: false,
    });
    expect(throughSharedDoor.id).toBeTruthy();

    /*
     * And the factory's own door does not. Asserted through the real entrance —
     * `createPlanBin` — rather than by calling the private wrapper, because what
     * has to be true is that the *five factory entrances* go through it.
     */
    const { createPlanBin } = await import('../server/services/factory/remote.ts');
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `manifest-guard-${Math.random()}`,
      objective: '',
      expectedOutcome: 'nothing, because an objective is required',
      nonGoals: [],
      acceptanceConditions: [],
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

    const refused = await createPlanBin(campaign, changeRequest).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused, 'an empty objective should have been refused at creation').toBeTruthy();
    expect(String((refused as Error).message)).toMatch(/could not be dispatched/);

    // One row from the shared door, none from the factory's.
    expect((await listBins({ projectId: fixture.project.id })).length).toBe(before + 1);
  });
});

describe('a completed delivery bin that could not be ingested says so in the ledger', () => {
  /*
   * The same four refusals one stage along, at the stage whose output is the
   * artifact a person acts on — and the first of them had no record of any kind.
   *
   * `ingestDeliverBin` had exactly the shape `ingestIntegrateBin` had before it
   * was repaired: an unreadable repository returning `false` in silence, and
   * three more whose only trace was `report.notes`, which lives as long as the
   * process. A campaign with no pull request and no ledger row saying why is the
   * condition §27 already paid to learn once. These are the regressions for it,
   * and each was run against its own defect first.
   *
   * What they are careful about is the same half: every caller still returns
   * `false`, so the bin stays un-ingested and the next tick tries again — a
   * record that stopped the retry would turn one forge outage into a delivery
   * nothing ever re-reads.
   */
  let campaignId = '';
  let implementer = '';
  let integrator = '';
  let deliverer = '';
  let integrationBranch = '';
  const unitHead = 'a'.repeat(40);
  const integrationHead = 'b'.repeat(40);

  beforeEach(async () => {
    implementer = (await createWorker({ name: 'impl-d', createdByType: 'SYSTEM', createdById: 't' })).id;
    integrator = (await createWorker({ name: 'int-d', createdByType: 'SYSTEM', createdById: 't' })).id;
    deliverer = (await createWorker({ name: 'del-d', createdByType: 'SYSTEM', createdById: 't' })).id;
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `deliver-refusal-${Math.random()}`,
      objective: 'Something whose delivery will be read and refused.',
      expectedOutcome: 'A reader can tell which of four things went wrong.',
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
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: approverId,
      authorityId: null,
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
    integrationBranch = campaign.integrationBranch;
    await ensureUnit({
      campaignId,
      unitKey: 'only-unit',
      kind: 'TEST',
      role: 'IMPLEMENTER',
      title: 'Assert the published tree',
      objective: 'Assert the build publishes the site only.',
      acceptance: ['the suite fails when a repository-only file is published'],
      ownedPaths: ['test/only.test.js'],
      requiredContext: [],
      verification: ['npm test'],
      expectedArtifact: 'a test file',
      risk: 'LOW',
      criticalPath: true,
      priority: 5,
      modelClass: 'FAST',
    });
    await registerFactoryWorker(implementer);
    await registerFactoryWorker(integrator);
    await registerFactoryWorker(deliverer);

    const { promoteReadyUnits, markIntegrated } = await import('../server/repos/factory.ts');
    await promoteReadyUnits(campaignId);
    const unit = (await getUnitByKey(campaignId, 'only-unit'))!;
    const held = (
      await claimUnits({ campaignId, workerId: implementer, unitIds: [unit.id], leaseMs: 60_000 })
    )[0]!;
    await markImplemented(
      { unitId: unit.id, workerId: implementer, leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
      {
        branch: `factory/${campaignId}/only-unit/a1`,
        headSha: unitHead,
        baseSha: BASE,
        worktreePath: null,
        workerSummary: 'implemented',
        terminalResult: { outcome: 'IMPLEMENTED', commands: [], filesForgeReported: [], filesWorkerReported: [] },
      },
    );
    await markIntegrated(unit.id, integrationHead);

    /*
     * The delivery stage's own precondition, written rather than walked: a
     * passing campaign review with nothing gating, over an integrated commit.
     * Walking the review stage as well would be testing the review stage.
     */
    const { patchCampaign } = await import('../server/repos/factory.ts');
    await patchCampaign(campaignId, { state: 'ASSEMBLING', integrationSha: integrationHead });
    const { recordReview } = await import('../server/repos/factoryFleet.ts');
    await recordReview({
      campaignId,
      round: 1,
      scope: 'CAMPAIGN',
      reviewerSessionId: 'cse_reviewer_d',
      reviewedSha: integrationHead,
      verdict: 'PASS',
      independence: 'SESSION_SEPARATED',
      summary: 'nothing gating',
      findings: [],
    });
  });

  /** The forge agrees the integration branch is at the reviewed commit. */
  function forgeConfirms(): void {
    stubForge({
      branches: { [integrationBranch]: integrationHead },
      compares: {
        [`${BASE}...${integrationHead}`]: { files: ['test/only.test.js'], status: 'ahead' },
      },
    });
  }

  async function refusals(): Promise<Record<string, unknown>[]> {
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    const events = await listFactoryEvents(campaignId, { kinds: ['DELIVERY_NOT_INGESTED'] });
    return events.map((event) => (event.detail ?? {}) as Record<string, unknown>);
  }

  /** Make the deliver bin, take it, submit `value`, complete it. */
  async function completedDeliveryBin(value: string): Promise<string> {
    forgeConfirms();
    await tickRemoteCampaign(campaignId);
    const assigned = await assignNextBin({ workerId: deliverer, projectIds: [fixture.project.id] });
    expect(assigned?.bin.kind).toBe('FACTORY_DELIVER');
    await putBinUnitResult({
      binId: assigned!.bin.id,
      unitKey: 'deliver',
      value,
      contentHash: `h-${value.length}`,
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
    });
    expect(
      await finishBin(
        {
          binId: assigned!.bin.id,
          leaseId: assigned!.leaseId,
          leaseGeneration: assigned!.leaseGeneration,
          workerId: deliverer,
        },
        { state: 'COMPLETE', reason: 'submitted' },
      ),
    ).toBe('OK');
    return assigned!.bin.id;
  }

  it('records a report it cannot read, once, without stopping the retry', async () => {
    const binId = await completedDeliveryBin('this is not a delivery report');

    const first = await tickRemoteCampaign(campaignId);
    expect(first.ingested.some((entry) => entry.startsWith('deliver:'))).toBe(false);

    const [recorded, ...rest] = await refusals();
    expect(rest).toHaveLength(0);
    expect(recorded?.['reason']).toBe('REPORT_UNUSABLE');
    expect(recorded?.['binId']).toBe(binId);
    // The evidence rather than only the category.
    expect(recorded?.['problems']).toBeDefined();

    // Read again on the next tick and not written twice: a completed bin is
    // re-read every pass, so a row per pass is a fresh refusal every twenty
    // seconds for the life of the campaign.
    await tickRemoteCampaign(campaignId);
    expect(await refusals()).toHaveLength(1);
  });

  it('records a worker that reported a blocker, separately from a forge that would not confirm', async () => {
    await completedDeliveryBin(
      JSON.stringify({
        outcome: 'BLOCKED',
        pullRequest: null,
        headSha: integrationHead,
        action: 'OPENED',
        summary: 'could not push',
        blockedReason: 'the surface refused a push to this repository',
      }),
    );

    await tickRemoteCampaign(campaignId);
    const [recorded] = await refusals();
    /*
     * Not a refusal by Brain, and named apart for exactly that reason: *the
     * worker could not do it* and *the forge would not confirm what it said*
     * send a reader to two different places.
     */
    expect(recorded?.['reason']).toBe('WORKER_REPORTED_BLOCKED');
    expect(String(recorded?.['blockedReason'])).toContain('refused a push');
  });

  it('records a forge that would not confirm the request', async () => {
    await completedDeliveryBin(
      JSON.stringify({
        outcome: 'IMPLEMENTED',
        pullRequest: 4242,
        headSha: integrationHead,
        action: 'OPENED',
        summary: 'opened it',
        blockedReason: null,
      }),
    );

    // The branch resolves; the pull request does not exist.
    stubForge({ branches: { [integrationBranch]: integrationHead }, pulls: [] });
    await tickRemoteCampaign(campaignId);

    const [recorded] = await refusals();
    expect(recorded?.['reason']).toBe('FORGE_DID_NOT_CONFIRM');
    expect(recorded?.['problems']).toBeDefined();
    expect(recorded?.['headSha']).toBe(integrationHead);
  });

  it('records a repository this Brain cannot address, which had no record at all', async () => {
    await completedDeliveryBin(
      JSON.stringify({
        outcome: 'IMPLEMENTED',
        pullRequest: 7,
        headSha: integrationHead,
        action: 'OPENED',
        summary: 'opened it',
        blockedReason: null,
      }),
    );

    /*
     * Written straight to the row, because the repository is immutable by
     * design — `amendContract` refuses it, and rightly. The production
     * condition this reproduces is not somebody editing it: it is a stored
     * remote that stopped being one Brain can parse, which is exactly why the
     * ingest asks rather than assuming.
     */
    const { getDb } = await import('../server/db/database.ts');
    const campaign = (await getCampaign(campaignId))!;
    await getDb().run(`UPDATE factory_change_requests SET repository = ? WHERE id = ?`, [
      'not-a-remote',
      campaign.changeRequestId,
    ]);

    await tickRemoteCampaign(campaignId);
    const [recorded] = await refusals();
    expect(recorded?.['reason']).toBe('REPOSITORY_UNREADABLE');
    expect(recorded?.['repository']).toBe('not-a-remote');
    // The sentence a reader gets, rather than only the code.
    expect(String(recorded?.['means'])).toContain('not one Brain can address');
  });

  it('is read by the operator surface that answers why a campaign has no pull request', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync('scripts/factory.ts', 'utf8');
    const status = source.slice(source.indexOf("case 'status': {"), source.indexOf("case 'events': {"));
    // A ledger nothing prints is the defect this row was written to close.
    expect(status).toMatch(/deliveryNotIngested/);
  });
});

/* ========================================================================= */

describe('a tick that throws leaves a row', () => {
  /*
   * `startFactoryRemoteLoop` keeps only whether a tick created anything and
   * ends in `.catch(() => undefined)`, so the "the tick threw" note it was given
   * was read by nobody and the campaign went on reading as its last stage.
   */
  it('records a failure once per message per hour, and a different message always', async () => {
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: 'tick-throws',
      objective: 'A campaign whose tick throws.',
      expectedOutcome: 'Somebody can see that it does.',
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
    const { recordTickFailure } = await import('../server/services/factory/remoteLoop.ts');
    const { listFactoryEvents } = await import('../server/repos/factoryFleet.ts');
    expect(await recordTickFailure(campaign.id, 'MANIFEST_REFUSED: too large')).toBe(true);
    expect(await recordTickFailure(campaign.id, 'MANIFEST_REFUSED: too large')).toBe(false);
    expect(await recordTickFailure(campaign.id, 'relation "x" does not exist')).toBe(true);
    const rows = await listFactoryEvents(campaign.id, { kinds: ['FACTORY_TICK_FAILED'] });
    expect(rows.map((row) => row.detail['message'])).toEqual([
      'MANIFEST_REFUSED: too large',
      'relation "x" does not exist',
    ]);
  });
});
