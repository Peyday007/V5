/**
 * Work no Factory worker may ever do is routed to the maintainer, not dispatched.
 *
 * Production, 2026-11-09 → 11-11: fcp_17725629's whole mutation scope was
 * `server/services/factory/release/outcome.ts`, which the V5 grant forbids to
 * every worker. Its plan bin was handed out 38 times; each worker read the grant,
 * reported "the only mutation-scope path is forbidden", and the bin went straight
 * back out, until the campaign parked on the owner. Now the tick asks first: no
 * plan bin is made, a waiting one is retired, and the campaign is BLOCKED
 * `PROTECTED_SCOPE` — the maintainer's, never the owner's. A scope with a
 * writable path is planned as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { approveChangeRequest, ensureCampaign, ensureChangeRequest, getCampaign } from '../server/repos/factory.ts';
import { listBins } from '../server/repos/bins.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import { forbiddenPathsFor, scopeOnlyForbidden } from '../server/services/factory/forbidden.ts';
import { BLOCKER_WAIT } from '../server/services/factory/line.ts';
import { deriveOutcome } from '../server/services/factory/release/outcome.ts';

const REPO = 'https://github.com/Peyday007/V5';
const BASE = 'b'.repeat(40);

let fixture: TestProject;
let adminId = '';
let seq = 0;

async function campaignWithScope(scope: string[]): Promise<string> {
  seq += 1;
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `protected-${seq}-${Date.now()}`,
    objective: `Objective ${seq}`,
    expectedOutcome: 'It lands.',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'it works', verification: 'npm test', mandatory: true }],
    repository: REPO,
    repositoryRoot: '',
    baseBranch: 'production',
    baseSha: BASE,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: scope,
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'revert',
    verificationCommands: ['npm test'],
  });
  await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: adminId, authorityId: null });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'REMOTE',
  });
  return campaign.id;
}

const planBins = async (campaignId: string) =>
  (await listBins({ projectId: fixture.project.id })).filter(
    (bin) => bin.kind === 'FACTORY_PLAN' && bin.factoryCampaignId === campaignId,
  );

beforeEach(async () => {
  fixture = await freshProject();
  adminId = (
    await createUser({
      email: `protected-${Math.random().toString(36).slice(2)}@example.test`,
      displayName: 'Admin',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
      createdByType: 'SYSTEM',
      createdById: 't',
    })
  ).id;
});

afterEach(async () => {
  await teardown();
});

describe('a protected scope is routed to the maintainer', () => {
  it('names a scope only when every glob lies inside a forbidden path', () => {
    const forbidden = forbiddenPathsFor(REPO);
    expect(scopeOnlyForbidden(['server/services/factory/release/outcome.ts'], forbidden)).toEqual([
      'server/services/factory/release/outcome.ts',
    ]);
    expect(scopeOnlyForbidden(['.claude/hooks/**', '.github/workflows/deploy.yml'], forbidden)).not.toBeNull();
    // A program campaign's scope always carries a writable test path; that is no way in (fcp_17725629).
    expect(
      scopeOnlyForbidden(['server/services/factory/release/outcome.ts', 'tests/program-ea512f54-GOV-17-3*.test.ts'], forbidden),
    ).toEqual(['server/services/factory/release/outcome.ts']);
    expect(scopeOnlyForbidden(['tests/**'], forbidden)).toBeNull();
    expect(scopeOnlyForbidden(['server/services/factory/release/outcome.ts', 'server/services/documents/**'], forbidden)).toBeNull();
    expect(scopeOnlyForbidden(['server/**'], forbidden)).toBeNull();
    expect(scopeOnlyForbidden([], forbidden)).toBeNull();
  });

  it('hands no worker the plan, parks it PROTECTED_SCOPE for the maintainer, and stays parked without churn', async () => {
    const id = await campaignWithScope(['server/services/factory/release/outcome.ts', 'tests/program-ea512f54-GOV-17-3*.test.ts']);
    const first = await tickRemoteCampaign(id);
    expect(first.state).toBe('BLOCKED');
    expect(await planBins(id)).toHaveLength(0);
    const campaign = (await getCampaign(id))!;
    expect(campaign.blockerKind).toBe('PROTECTED_SCOPE');
    expect(campaign.blockerDetail).toMatch(/maintainer/);
    expect(BLOCKER_WAIT.PROTECTED_SCOPE.wait).toBe('MAINTAINER');

    // Ticked again (a reauthorization, a dispatcher pass): still no bin, no rewrite.
    await tickRemoteCampaign(id);
    await tickRemoteCampaign(id);
    expect(await planBins(id)).toHaveLength(0);
    expect((await getCampaign(id))!).toMatchObject({ state: 'BLOCKED', blockerKind: 'PROTECTED_SCOPE', stageDetail: campaign.stageDetail });

    // What the waiting session reads: blocked, a named maintainer action, and not "until a person acts".
    const outcome = deriveOutcome({ campaign: (await getCampaign(id))!, grant: null, latestRun: null, origin: null });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.detail).toMatch(/maintainer/);
    expect(outcome.detail).not.toMatch(/person/);
    expect(outcome.personAction).toMatch(/^MAINTAINER:/);
  });

  it('a scope with a writable path is planned as before', async () => {
    const id = await campaignWithScope(['server/services/factory/release/outcome.ts', 'server/services/documents/**']);
    const report = await tickRemoteCampaign(id);
    expect(report.state).toBe('PLANNING');
    expect(await planBins(id)).toHaveLength(1);
  });
});
