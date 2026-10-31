/**
 * A failed repair of a non-gating finding does not stop a reviewed campaign.
 *
 * Production, fcp_0d2f161801a94944a18d, 2026-10-30: review PASS, five of six
 * units integrated, and a MINOR finding whose repair worker reported three
 * times that making the finding untrue would break the contract's own
 * acceptance condition. The campaign stopped at UNIT_EXHAUSTED_ATTEMPTS with no
 * answer short of retiring it. The finding now stays OPEN (so the pull request
 * still lists it) and the campaign goes on; a gating finding's failed repair
 * still blocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  getCampaign,
  getUnitByKey,
  promoteReadyUnits,
} from '../server/repos/factory.ts';
import { listFindings, recordReview } from '../server/repos/factoryFleet.ts';
import { getDb } from '../server/db/database.ts';
import { queueRepairs } from '../server/services/factory/repair.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';

const REPO = 'https://github.com/Peyday007/oakwood-junk-removal';
const BASE = 'a'.repeat(40);

let fixture: TestProject;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  fixture = await freshProject();
  realFetch = globalThis.fetch;
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env['BRAIN_FORGE_API_BASE'];
  await teardown();
});

async function reviewedCampaignWithFailedRepair(severity: 'MINOR' | 'MAJOR') {
  const approver = await createUser({
    email: `approver-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'An approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `nongating-${Math.random()}`,
    objective: 'Guard the published tree.',
    expectedOutcome: 'The suite fails when it breaks.',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'the suite asserts it', verification: 'npm test', mandatory: true }],
    repository: REPO,
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
  await approveChangeRequest({ changeRequestId: changeRequest.id, via: 'PERSON', userId: approver.id, authorityId: null });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: BASE,
    laneTarget: 1,
    laneTargetReason: 'test',
    executionMode: 'REMOTE',
  });
  await ensureUnit({
    campaignId: campaign.id,
    unitKey: 'the-work',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'work',
    objective: 'work',
    acceptance: [],
    ownedPaths: ['src/work.ts'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'INTEGRATED',
  });
  await recordReview({
    campaignId: campaign.id,
    round: 1,
    scope: 'CAMPAIGN',
    reviewerSessionId: 'cse_reviewer',
    reviewedSha: BASE,
    verdict: severity === 'MINOR' ? 'PASS' : 'CHANGES_REQUIRED',
    independence: 'SESSION_SEPARATED',
    summary: 'one finding',
    findings: [
      {
        key: 'by-design',
        severity,
        category: 'behaviour-change',
        statement: 'Something the contract itself asked for.',
        evidence: 'src/work.ts',
        acceptanceConditionId: 'A01',
      },
    ],
  });
  const queued = await queueRepairs(campaign, changeRequest);
  expect(queued.queued.length).toBe(1);
  await promoteReadyUnits(campaign.id);
  const repair = (await getUnitByKey(campaign.id, queued.queued[0]!.unitKey))!;
  await getDb().run(
    `UPDATE factory_work_units SET state = 'FAILED', attempt = max_attempts,
       failure_category = 'WORKER_ERROR', failure_detail = 'the finding contradicts the contract'
     WHERE id = ?`,
    [repair.id],
  );
  return campaign.id;
}

describe('a failed repair of a non-gating finding', () => {
  it('does not block the campaign, and leaves the finding open for the pull request', async () => {
    const campaignId = await reviewedCampaignWithFailedRepair('MINOR');
    await tickRemoteCampaign(campaignId);
    const after = await getCampaign(campaignId);
    expect(after?.state).not.toBe('BLOCKED');
    expect(after?.blockerKind).not.toBe('UNIT_EXHAUSTED_ATTEMPTS');
    const findings = await listFindings(campaignId);
    expect(findings).toHaveLength(1);
    expect(['OPEN', 'REPAIR_QUEUED']).toContain(findings[0]!.state);
  });

  it('still blocks when the finding is gating', async () => {
    const campaignId = await reviewedCampaignWithFailedRepair('MAJOR');
    await tickRemoteCampaign(campaignId);
    const after = await getCampaign(campaignId);
    expect(after?.state).toBe('BLOCKED');
    expect(after?.blockerKind).toBe('UNIT_EXHAUSTED_ATTEMPTS');
  });
});
