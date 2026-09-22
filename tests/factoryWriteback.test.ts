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
import {
  recordCampaignOutcome,
  listCampaignsPendingOutcome,
  FACTORY_CAMPAIGN_OUTCOME,
} from '../server/services/factory/writeback.ts';
import { tickAllCampaigns } from '../server/services/factory/loop.ts';
import { createWorkstream, linkWorkstream, listAllLiveLinks } from '../server/repos/register.ts';
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
async function completeCampaign(options?: { prUrl?: string; prRef?: string }): Promise<string> {
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
    ...(options?.prUrl ? { prUrl: options.prUrl } : {}),
    ...(options?.prRef ? { prRef: options.prRef } : {}),
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

async function stream(): Promise<string> {
  const workstream = await createWorkstream({
    projectId: fixture.project.id,
    title: 'A piece of work',
    intent: 'The outcome somebody actually asked for.',
    purpose: 'CAPABILITY',
    createdByUserId: approverId,
  });
  return workstream.id;
}

/**
 * Gives `repoRoot` a real, parseable remote, so a campaign submitted against
 * it carries a `changeRequest.repository` the forge module will actually read
 * from rather than the local fixture path. Without this every campaign in
 * this file refuses `observeCampaignPullRequestMerge` at the door — which is
 * exactly right for every test that never touches the merge observer, and
 * exactly wrong for the handful below that mean to exercise it.
 */
async function addRealRemote(): Promise<void> {
  await run('git', ['remote', 'add', 'origin', 'https://github.com/Peyday007/V5'], { cwd: repoRoot });
}

/**
 * Answers `/repos/Peyday007/V5/pulls/:number` with a fixed `merged` value, on
 * `BRAIN_FORGE_API_BASE` so `readPullRequest` calls this rather than the real
 * forge. Scoped and restored per test rather than in a file-wide `beforeEach`,
 * because only the tests exercising `observeCampaignPullRequestMerge` need it.
 */
function stubForgePull(number: number, merged: boolean): { restore: () => void } {
  const realFetch = globalThis.fetch;
  const realBase = process.env['BRAIN_FORGE_API_BASE'];
  process.env['BRAIN_FORGE_API_BASE'] = 'https://forge.test';
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const pull = /\/pulls\/(\d+)$/.exec(url);
    if (pull && Number(pull[1]) === number) {
      return json({
        number,
        state: merged ? 'closed' : 'open',
        merged,
        html_url: `https://github.com/Peyday007/V5/pull/${number}`,
        title: 'a pull request',
        updated_at: '2026-09-22T00:00:00Z',
        head: { sha: 'c'.repeat(40), ref: `factory/${number}` },
        base: { ref: 'main' },
      });
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = realFetch;
      if (realBase === undefined) delete process.env['BRAIN_FORGE_API_BASE'];
      else process.env['BRAIN_FORGE_API_BASE'] = realBase;
    },
  };
}

describe('recordCampaignOutcome attests a finished campaign\'s pull request', () => {
  it('A01: creates exactly one live PULL_REQUEST/EVIDENCE link per workstream, across repeated calls', async () => {
    const campaignId = await completeCampaign({
      prUrl: 'https://github.com/Peyday007/V5/pull/4200',
      prRef: '#4200',
    });
    const workstreamId = await stream();
    await linkWorkstream({
      workstreamId,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });

    await recordCampaignOutcome(campaignId);
    // The existing idempotent-write test above already proves the
    // project-history side stays single-row across repeats; calling this a
    // second and third time proves the same is true of the new link.
    await recordCampaignOutcome(campaignId);
    await recordCampaignOutcome(campaignId);

    const links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(1);
    expect(links[0]?.ref).toBe('https://github.com/Peyday007/V5/pull/4200');
    expect(links[0]?.relation).toBe('EVIDENCE');
    expect(links[0]?.recordedBy).toBe('BRAIN');
  });

  it('A02: leaves no PULL_REQUEST link when the campaign carries no prUrl', async () => {
    const campaignId = await completeCampaign();
    const workstreamId = await stream();
    await linkWorkstream({
      workstreamId,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });

    await recordCampaignOutcome(campaignId);

    const links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(0);
  });

  it('A02: leaves an unrelated workstream untouched', async () => {
    const campaignId = await completeCampaign({
      prUrl: 'https://github.com/Peyday007/V5/pull/4201',
      prRef: '#4201',
    });
    const unrelatedId = await stream();
    // No CAMPAIGN link at all to this campaign.

    await recordCampaignOutcome(campaignId);

    const links = await listAllLiveLinks([unrelatedId]);
    expect(links.filter((link) => link.kind === 'PULL_REQUEST')).toHaveLength(0);
    expect(links).toHaveLength(0);
  });

  it('A04: attests merged: false and state: open, never inferred from the URL text', async () => {
    const campaignId = await completeCampaign({
      // The URL text itself would read as a merged, closed request if it were
      // ever inspected for its words — which is exactly why this module must
      // never do that.
      prUrl: 'https://github.com/Peyday007/V5/pull/9999-closed-and-merged',
      prRef: '#9999',
    });
    const workstreamId = await stream();
    await linkWorkstream({
      workstreamId,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });

    await recordCampaignOutcome(campaignId);

    const links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(1);
    expect(links[0]?.detail.merged).toBe(false);
    expect(links[0]?.detail.state).toBe('open');
    expect(links[0]?.detail.attestedBy).toBe('factory-campaign');
    expect(typeof links[0]?.detail.attestedAt).toBe('string');
  });

  /**
   * A01, the case a reviewer found unproven: the objective's own scenario is
   * a person *noticing* finished work and filing a workstream for it, which
   * happens after a campaign's outcome has already landed at least as often
   * as before. Before this fix, `listCampaignsPendingOutcome`'s only
   * condition was "the outcome event does not exist yet" — so a campaign
   * whose outcome had already been recorded dropped out of every periodic
   * tick's selection for good, and a workstream linked to it afterward could
   * never reach `attestCampaignPullRequest` through any automatic path.
   *
   * This drives the real production entrance — `tickAllCampaigns`, not a
   * direct call to `recordCampaignOutcome` — because a direct call would only
   * prove the writer still works and say nothing about whether the loop that
   * is supposed to reach it actually does.
   */
  it('A01: a workstream linked after the outcome already landed still gets attested, via the real tick loop', async () => {
    const campaignId = await completeCampaign({
      prUrl: 'https://github.com/Peyday007/V5/pull/4210',
      prRef: '#4210',
    });

    // The ordinary automatic path: the tick reaches this campaign and
    // records its outcome while nobody has filed a workstream against it yet.
    const first = await recordCampaignOutcome(campaignId);
    expect(first.recorded).toBe(true);

    // A person notices the finished work only afterward, and files it.
    const workstreamId = await stream();
    await linkWorkstream({
      workstreamId,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'PERSON',
      recordedByUserId: approverId,
    });

    // The campaign's own outcome is already recorded, so the old query's
    // sole condition would have excluded it here.
    const pending = await listCampaignsPendingOutcome();
    expect(pending.some((one) => one.id === campaignId)).toBe(true);

    // The actual periodic loop, run more than once, exactly as production
    // runs it every few seconds.
    await tickAllCampaigns();
    await tickAllCampaigns();

    const links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(1);
    expect(links[0]?.ref).toBe('https://github.com/Peyday007/V5/pull/4210');
    expect(links[0]?.relation).toBe('EVIDENCE');
    expect(links[0]?.detail.merged).toBe(false);
  });

  it('A02: a campaign nobody has ever linked a workstream to never re-enters the pending list once its outcome is recorded', async () => {
    const campaignId = await completeCampaign({
      prUrl: 'https://github.com/Peyday007/V5/pull/4211',
      prRef: '#4211',
    });
    await recordCampaignOutcome(campaignId);

    const pending = await listCampaignsPendingOutcome();
    expect(pending.some((one) => one.id === campaignId)).toBe(false);
  });

  it('does not keep offering a campaign once every linked workstream is attested and confirmed merged', async () => {
    await addRealRemote();
    const campaignId = await completeCampaign({
      prUrl: 'https://github.com/Peyday007/V5/pull/4212',
      prRef: '#4212',
    });
    const workstreamId = await stream();
    await linkWorkstream({
      workstreamId,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });

    const stub = stubForgePull(4212, true);
    try {
      await recordCampaignOutcome(campaignId);
    } finally {
      stub.restore();
    }
    // The workstream was linked before the outcome ran, so it was attested in
    // the same call, and the forge already says merged — both halves of what
    // this campaign owes the register are settled, so it has nothing left to
    // answer for.
    const pending = await listCampaignsPendingOutcome();
    expect(pending.some((one) => one.id === campaignId)).toBe(false);

    const links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(1);
    expect(links[0]?.detail.merged).toBe(true);
    expect(links[0]?.detail.attestedBy).toBe('pull-request-merge-observation');
  });

  it('keeps offering a campaign whose attested pull request has not been confirmed merged, and the real tick corrects it the moment the forge says it has', async () => {
    await addRealRemote();
    const campaignId = await completeCampaign({
      prUrl: 'https://github.com/Peyday007/V5/pull/4213',
      prRef: '#4213',
    });
    const workstreamId = await stream();
    await linkWorkstream({
      workstreamId,
      kind: 'CAMPAIGN',
      ref: campaignId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
    });

    // The ordinary automatic path, with the forge still reporting the request
    // open: attestation is written, the merge check runs and finds nothing to
    // correct, and — this is the finding a reviewer raised — the campaign
    // stays a candidate rather than dropping out having never been settled.
    let stub = stubForgePull(4213, false);
    try {
      await tickAllCampaigns();
    } finally {
      stub.restore();
    }
    let links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(1);
    expect(links[0]?.detail.merged).toBe(false);
    let pending = await listCampaignsPendingOutcome();
    expect(pending.some((one) => one.id === campaignId)).toBe(true);

    // Time passes; somebody merges it. The very next tick — through
    // `tickAllCampaigns`, the real production entrance, not a direct call to
    // `observeCampaignPullRequestMerge` — is what makes this a repair rather
    // than a second copy of the capability the previous round already built.
    stub = stubForgePull(4213, true);
    try {
      await tickAllCampaigns();
    } finally {
      stub.restore();
    }
    links = (await listAllLiveLinks([workstreamId])).filter((link) => link.kind === 'PULL_REQUEST');
    expect(links).toHaveLength(1);
    expect(links[0]?.detail.merged).toBe(true);
    expect(links[0]?.detail.attestedBy).toBe('pull-request-merge-observation');
    pending = await listCampaignsPendingOutcome();
    expect(pending.some((one) => one.id === campaignId)).toBe(false);
  });
});
