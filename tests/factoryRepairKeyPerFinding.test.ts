/**
 * Finding keys are numbered per review: a second review's `F1` is a different
 * finding from the first review's `F1`. Production 2026-11-11, fcp_ef7bb04a: the
 * second review's MAJOR `F1` got the first one's key `repair-F1`, was attached to
 * that already-INTEGRATED unit, and was marked REPAIRED on a commit that never
 * touched it. Each finding now gets its own repair unit.
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
import { queueRepairs, reconcileRepairs } from '../server/services/factory/repair.ts';

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

async function campaignWithTwoReviewsNamingF1() {
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
    submissionKey: `dupkey-${Math.random()}`,
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
  const finding = (round: number, severity: 'MINOR' | 'MAJOR', statement: string) =>
    recordReview({
      campaignId: campaign.id,
      round,
      scope: 'CAMPAIGN',
      reviewerSessionId: `cse_reviewer_${round}`,
      reviewedSha: BASE,
      verdict: 'CHANGES_REQUIRED',
      independence: 'SESSION_SEPARATED',
      summary: 'one finding',
      findings: [{ key: 'F1', severity, category: 'edge-case', statement, evidence: 'src/work.ts' }],
    });
  return { campaign, changeRequest, finding };
}

describe('two reviews that both number a finding F1', () => {
  it('gives the second F1 its own repair, and never closes it on the first one\'s commit', async () => {
    const { campaign, changeRequest, finding } = await campaignWithTwoReviewsNamingF1();
    await finding(1, 'MINOR', 'A CRLF line break is no longer rejoined in src/work.ts.');
    const first = await queueRepairs(campaign, changeRequest);
    expect(first.queued.map((q) => q.unitKey)).toEqual(['repair-F1']);
    await getDb().run(`UPDATE factory_work_units SET state = 'INTEGRATED', head_sha = ? WHERE campaign_id = ? AND unit_key = 'repair-F1'`, ['b'.repeat(40), campaign.id]);
    await reconcileRepairs(campaign.id);

    await finding(2, 'MAJOR', 'Extractors in src/work.ts flatten line breaks before normalisation.');
    const second = await queueRepairs(campaign, changeRequest);
    expect(second.queued).toHaveLength(1);
    expect(second.queued[0]!.unitKey).toBe('repair-F1-2');
    const unit = (await getUnitByKey(campaign.id, 'repair-F1-2'))!;
    expect(unit.state).not.toBe('INTEGRATED');

    await reconcileRepairs(campaign.id);
    const major = (await listFindings(campaign.id)).find((f) => f.severity === 'MAJOR')!;
    expect(major.state).not.toBe('REPAIRED');
  });
});
