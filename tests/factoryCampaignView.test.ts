/**
 * campaignView.ts, against a campaign built directly through the repositories.
 *
 * No git repository and no contract service here: this unit only reads rows,
 * so the fixture below writes the rows it needs by hand rather than routing
 * through submitObjective/installPlan, which belong to units this campaign
 * does not own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { ensureCampaign, ensureChangeRequest, ensureUnit } from '../server/repos/factory.ts';
import { recordReview } from '../server/repos/factoryFleet.ts';
import {
  acceptanceConditionStatus,
  integratedUnits,
  latestReview,
  loadCampaignView,
  openFindings,
  pendingRelease,
  totalUnits,
  type CampaignView,
} from '../server/services/factory/campaignView.ts';
import type { FactoryCampaign } from '../server/domain/factory.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

afterEach(async () => {
  await teardown();
});

async function buildCampaign(): Promise<FactoryCampaign> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: 'campaign-view-fixture',
    objective: 'Prove campaignView reads what the rows say.',
    expectedOutcome: 'A view reflects units, reviews and findings.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'A01 has an open finding', verification: 'read it', mandatory: true },
      { id: 'A02', statement: 'A02 has never been reviewed', verification: 'read it', mandatory: true },
    ],
    repository: '/tmp/not-a-real-repo',
    baseBranch: 'main',
    baseSha: 'deadbeef',
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['src/**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'decline the pull request',
    verificationCommands: [],
  });

  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 3,
    laneTargetReason: 'initial',
  });

  // Rows written directly at the state they need to be found in: this unit
  // reads the state machine's output and does not exercise the state machine.
  await ensureUnit({
    campaignId: campaign.id,
    unitKey: 'integrated-one',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'integrated one',
    objective: 'o',
    acceptance: ['a'],
    ownedPaths: ['src/one.txt'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'INTEGRATED',
  });
  await ensureUnit({
    campaignId: campaign.id,
    unitKey: 'integrated-two',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'integrated two',
    objective: 'o',
    acceptance: ['a'],
    ownedPaths: ['src/two.txt'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'INTEGRATED',
  });
  await ensureUnit({
    campaignId: campaign.id,
    unitKey: 'superseded-one',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'superseded one',
    objective: 'o',
    acceptance: ['a'],
    ownedPaths: ['src/three.txt'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'SUPERSEDED',
  });

  // Round 1: the older review, with an open finding against A01.
  await recordReview({
    campaignId: campaign.id,
    round: 1,
    scope: 'CAMPAIGN',
    reviewerSessionId: 's1',
    reviewedSha: 'sha1',
    verdict: 'CHANGES_REQUIRED',
    summary: 'A01 is not satisfied yet.',
    independence: 'SESSION_SEPARATED',
    findings: [
      {
        key: 'a01-missing',
        severity: 'MAJOR',
        category: 'correctness',
        statement: 'A01 is not yet true',
        evidence: 'src/one.txt:1',
        acceptanceConditionId: 'A01',
      },
    ],
  });

  // Round 2: the newer review. Still not a pass, and it names no finding at
  // all — A02 stays unreviewed rather than passing by omission.
  await recordReview({
    campaignId: campaign.id,
    round: 2,
    scope: 'CAMPAIGN',
    reviewerSessionId: 's2',
    reviewedSha: 'sha2',
    verdict: 'CHANGES_REQUIRED',
    summary: 'Still not there.',
    independence: 'SESSION_SEPARATED',
    findings: [],
  });

  return campaign;
}

describe('loadCampaignView', () => {
  it('returns null for a campaign id that does not resolve', async () => {
    expect(await loadCampaignView('fcp_does_not_exist')).toBeNull();
  });

  it('reads the campaign, its units, its reviews and its findings', async () => {
    const campaign = await buildCampaign();
    const view = await loadCampaignView(campaign.id);
    expect(view).not.toBeNull();
    const v = view as CampaignView;
    expect(v.campaign.id).toBe(campaign.id);
    expect(v.units).toHaveLength(3);
    expect(v.reviews).toHaveLength(2);
    expect(v.findings).toHaveLength(1);
  });
});

describe('the derivations', () => {
  it('picks the highest review round, not the last array element', async () => {
    const campaign = await buildCampaign();
    const view = (await loadCampaignView(campaign.id)) as CampaignView;
    const latest = latestReview(view);
    expect(latest?.round).toBe(2);
    expect(latest?.summary).toBe('Still not there.');
  });

  it('counts INTEGRATED units and excludes SUPERSEDED ones from the total', async () => {
    const campaign = await buildCampaign();
    const view = (await loadCampaignView(campaign.id)) as CampaignView;
    expect(integratedUnits(view)).toBe(2);
    expect(totalUnits(view)).toBe(2);
  });

  it('lists the open finding', async () => {
    const campaign = await buildCampaign();
    const view = (await loadCampaignView(campaign.id)) as CampaignView;
    const open = openFindings(view);
    expect(open).toHaveLength(1);
    expect(open[0]?.acceptanceConditionId).toBe('A01');
  });

  it('has no pending release when none was requested', async () => {
    const campaign = await buildCampaign();
    const view = (await loadCampaignView(campaign.id)) as CampaignView;
    expect(pendingRelease(view)).toBeNull();
  });

  it('reports NOT_MET for a condition an open finding names, and UNVERIFIED for one never reviewed clean', async () => {
    const campaign = await buildCampaign();
    const view = (await loadCampaignView(campaign.id)) as CampaignView;
    const statuses = acceptanceConditionStatus(view);
    expect(statuses).toHaveLength(2);

    const a01 = statuses.find((s) => s.id === 'A01');
    expect(a01?.status).toBe('NOT_MET');
    expect(a01?.basis).toMatch(/A01/);

    const a02 = statuses.find((s) => s.id === 'A02');
    expect(a02?.status).toBe('UNVERIFIED');
  });
});
