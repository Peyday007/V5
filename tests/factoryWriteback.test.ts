/**
 * The one project-history row a finished campaign leaves behind, and the
 * idempotence that keeps a redelivered tick from writing a second one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import { createUser } from '../server/repos/identity.ts';
import { submitObjective, approveObjective } from '../server/services/factory/contract.ts';
import { run, gitOrThrow } from '../server/services/factory/git.ts';
import {
  ensureCampaign,
  ensureUnit,
  factoryNow,
  patchCampaign,
} from '../server/repos/factory.ts';
import { recordIntegration, recordReview } from '../server/repos/factoryFleet.ts';
import { recordCampaignOutcome, FACTORY_CAMPAIGN_OUTCOME } from '../server/services/factory/writeback.ts';
import type { FactoryChangeRequest } from '../server/domain/factory.ts';

let fixture: TestProject;
let repoRoot: string;
let approverId: string;

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-writeback-repo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { typecheck: 'node -e "0"', test: 'node -e "0"' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'one.txt'), 'one\n');
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
      email: 'factory-writeback-approver@test.local',
      displayName: 'Factory Writeback Approver',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    })
  ).id;
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

async function approvedChangeRequest(): Promise<FactoryChangeRequest> {
  const submitted = await submitObjective({
    projectId: fixture.project.id,
    objective: 'Change the first file so the outcome is visible.',
    expectedOutcome: 'src/one.txt contains the new text.',
    acceptanceConditions: [
      { statement: 'src/one.txt contains the new text', verification: 'read the file' },
    ],
    repositoryRoot: repoRoot,
    mutationScope: ['src/**'],
  });
  const approved = await approveObjective({
    changeRequestId: submitted.changeRequest.id,
    via: 'PERSON',
    userId: approverId,
  });
  expect(approved.ok).toBe(true);
  return approved.changeRequest;
}

/** A COMPLETE campaign with one integrated unit, a review and an open finding. */
async function completeCampaign(): Promise<string> {
  const changeRequest = await approvedChangeRequest();
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 1,
    laneTargetReason: 'initial',
  });

  const { unit } = await ensureUnit({
    campaignId: campaign.id,
    unitKey: 'only',
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: 'only',
    objective: 'change the file',
    acceptance: ['it changed'],
    ownedPaths: ['src/one.txt'],
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'INTEGRATED',
  });

  const integrationSha = 'deadbeefcafe';
  await recordIntegration({
    campaignId: campaign.id,
    unitId: unit.id,
    attempt: 1,
    outcome: 'MERGED',
    reason: 'stayed inside its surface',
    beforeSha: changeRequest.baseSha,
    afterSha: integrationSha,
  });

  const { review } = await recordReview({
    campaignId: campaign.id,
    round: 1,
    scope: 'CAMPAIGN',
    unitId: null,
    reviewerSessionId: 's-review',
    reviewedSha: integrationSha,
    verdict: 'CHANGES_REQUIRED',
    summary: 'one open issue',
    independence: 'SESSION_SEPARATED',
    findings: [
      {
        key: 'missing-test',
        severity: 'MAJOR',
        category: 'test-coverage',
        statement: 'nothing exercises the new behaviour',
        evidence: 'src/one.txt',
      },
    ],
  });
  expect(review.verdict).toBe('CHANGES_REQUIRED');

  await patchCampaign(campaign.id, {
    state: 'COMPLETE',
    integrationSha,
    finishedAt: factoryNow(),
  });

  return campaign.id;
}

describe('recordCampaignOutcome', () => {
  it('writes exactly one project-history row across two calls', async () => {
    const campaignId = await completeCampaign();

    const first = await recordCampaignOutcome(campaignId);
    expect(first.recorded).toBe(true);
    expect(first.event).not.toBeNull();

    const second = await recordCampaignOutcome(campaignId);
    expect(second.recorded).toBe(false);
    expect(second.event?.id).toBe(first.event?.id);

    const events = await listEventsByEntity('FACTORY_CAMPAIGN', campaignId);
    const outcomeEvents = events.filter((event) => event.eventType === FACTORY_CAMPAIGN_OUTCOME);
    expect(outcomeEvents.length).toBe(1);

    const payload = outcomeEvents[0]?.payload as Record<string, unknown>;
    expect(payload.reviewVerdict).toBe('CHANGES_REQUIRED');
    expect(payload.integrationSha).toBe('deadbeefcafe');
    expect(payload.unitsIntegrated).toBe(1);
    expect(payload.unitsTotal).toBe(1);
    expect(payload.independenceTier).toBe('SESSION_SEPARATED');
    expect(payload.openFindings).toEqual([
      { findingKey: 'missing-test', severity: 'MAJOR', statement: 'nothing exercises the new behaviour' },
    ]);
  });

  it('races concurrent calls against the reservation and still writes exactly one row', async () => {
    const campaignId = await completeCampaign();

    // Fired together rather than awaited one at a time: the sequential test
    // above only ever exercises the `already`-recorded fast path, because by
    // the time a second call starts, the first has long since committed. This
    // is the race that fast path cannot see — two callers reading no
    // recorded outcome yet and both reaching `runIdempotent` for the same
    // campaign — which is exactly what should land exactly one of them on
    // `EXECUTED` and turn the rest away as `REPLAYED` or already in progress,
    // by way of the `UNIQUE (scope_hash, key_fingerprint)` reservation rather
    // than by luck of ordering.
    const results = await Promise.all([
      recordCampaignOutcome(campaignId),
      recordCampaignOutcome(campaignId),
      recordCampaignOutcome(campaignId),
      recordCampaignOutcome(campaignId),
    ]);

    const winners = results.filter((result) => result.recorded);
    expect(winners.length).toBe(1);
    const winnerEvent = winners[0]?.event;
    expect(winnerEvent).not.toBeNull();

    for (const result of results) {
      if (result.recorded) continue;
      expect(['already recorded', 'writeback already in progress elsewhere']).toContain(
        result.reason,
      );
      // A caller that saw a row at all must see the one that actually landed
      // — never an invented one, and never a second.
      if (result.event) expect(result.event.id).toBe(winnerEvent?.id);
    }

    const events = await listEventsByEntity('FACTORY_CAMPAIGN', campaignId);
    const outcomeEvents = events.filter((event) => event.eventType === FACTORY_CAMPAIGN_OUTCOME);
    expect(outcomeEvents.length).toBe(1);
    expect(outcomeEvents[0]?.id).toBe(winnerEvent?.id);

    // A later, sequential call must find the same settled row rather than
    // reopening any question the race above already answered.
    const after = await recordCampaignOutcome(campaignId);
    expect(after.recorded).toBe(false);
    expect(after.event?.id).toBe(winnerEvent?.id);
  });

  it('refuses a campaign that has not finished', async () => {
    const changeRequest = await approvedChangeRequest();
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    const result = await recordCampaignOutcome(campaign.id);
    expect(result.recorded).toBe(false);
    expect(result.event).toBeNull();
    expect(result.reason).toMatch(/not in a terminal state|has not finished/);

    const events = await listEventsByEntity('FACTORY_CAMPAIGN', campaign.id);
    expect(events.length).toBe(0);
  });

  it('refuses a campaign that does not exist', async () => {
    const result = await recordCampaignOutcome('no-such-campaign');
    expect(result.recorded).toBe(false);
    expect(result.event).toBeNull();
    expect(result.reason).toMatch(/no such campaign/);
  });
});
