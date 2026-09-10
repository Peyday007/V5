/**
 * The three round-2 repairs the round-3 reviewer found were asserted by nothing.
 *
 * Its finding was precise and worth quoting rather than paraphrasing: *"a revert
 * of any of them would leave the suite green"*. That is the one property a
 * repair must not have — the assignment's own verification standard is that
 * reverting a critical repair makes its test fail — so each block below is
 * written to fail against the code as it was before the repair, and only that.
 *
 *   1. `tickAllCampaigns` runs `recoverAll` **before** it ticks anything, so a
 *      live campaign whose own tick returns before reaching recovery is still
 *      recovered. Delete the bulk pass and the session below stays `RUNNING`.
 *   2. `tickAllCampaigns` also ticks every terminal campaign still missing its
 *      Brain writeback — a set `listLiveCampaigns` deliberately excludes, so
 *      nothing else would ever reach it. Drop `listCampaignsPendingOutcome`
 *      from the batch and the outcome event is never written.
 *   3. `UNATTACHED_SESSION_STALE_MS` is 90 minutes rather than the 10 that
 *      abandoned live reviewers mid-pass. The existing recovery test passes its
 *      own bound explicitly, which is why it could not see this: only a call
 *      that takes the default can.
 *
 * These were written by hand in the outer session rather than by a factory
 * worker, because they close findings the factory had already recorded against
 * a campaign it had finished. `docs/FACTORY-0-EVIDENCE.md` says so in the same
 * words; a test about honesty that misreported its own provenance would be an
 * odd thing to leave behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  approveChangeRequest,
  claimUnits,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  factoryNow,
  getCampaign,
  listLiveCampaigns,
  patchCampaign,
  plusMs,
} from '../server/repos/factory.ts';
import { getSession, openSession } from '../server/repos/factoryFleet.ts';
import { getDb } from '../server/db/database.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import { tickAllCampaigns, tickCampaign } from '../server/services/factory/loop.ts';
import { recoverCampaign } from '../server/services/factory/recovery.ts';
import { gitOrThrow, run } from '../server/services/factory/git.ts';
import type { FactoryChangeRequest } from '../server/domain/factory.ts';

let fixture: TestProject;
let repoRoot = '';

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-bulk-repo-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'subject' }, null, 2));
  fs.writeFileSync(path.join(root, 'src.txt'), 'one\n');
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.email', 'factory@test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Factory Bulk Test'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

async function makeChangeRequest(submissionKey: string): Promise<FactoryChangeRequest> {
  const headSha = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey,
    objective: 'Prove the batch tick reaches campaigns a single tick cannot.',
    expectedOutcome: 'Nothing is stranded by the path its own tick returns before.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'nothing is stranded', verification: 'read the rows', mandatory: true },
    ],
    repository: repoRoot,
    baseBranch: 'main',
    baseSha: headSha,
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['src.txt'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: [],
  });
  return changeRequest;
}

beforeEach(async () => {
  fixture = await freshProject();
  repoRoot = await makeRepository();
});

afterEach(async () => {
  await teardown();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('the batch tick recovers campaigns their own tick returns before reaching', () => {
  it('closes a dead session on a campaign whose contract is not approved', async () => {
    // Deliberately never approved: `runTick` refuses at CONTRADICTORY_CONTRACT
    // and returns, which is above the line where it would have recovered. So
    // this campaign's own tick can never clean up after a dead process, and the
    // batch pass is the only thing that can.
    const changeRequest = await makeChangeRequest('bulk-unapproved');
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    await patchCampaign(campaign.id, { state: 'EXECUTING', stageDetail: 'mid-flight when it died' });

    const { unit } = await ensureUnit({
      campaignId: campaign.id,
      unitKey: 'alpha',
      kind: 'IMPLEMENTATION',
      role: 'IMPLEMENTER',
      title: 'alpha',
      objective: 'alpha',
      acceptance: ['it works'],
      ownedPaths: ['src.txt'],
      requiredContext: [],
      verification: [],
      expectedArtifact: 'a commit',
      state: 'READY',
    });
    const session = await openSession({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'test-model',
    });
    const claimed = await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [unit.id],
      sessionId: session.id,
      leaseMs: 30_000,
    });
    expect(claimed.length).toBe(1);
    await getDb().run(`UPDATE factory_work_units SET lease_expires_at = ? WHERE id = ?`, [
      plusMs(factoryNow(), -60_000),
      unit.id,
    ]);

    // Its own tick: refused before recovery, so the dead session survives it.
    const single = await tickCampaign(campaign.id, { repoRoot });
    expect(single.blocker?.kind).toBe('CONTRADICTORY_CONTRACT');
    expect((await getSession(session.id))?.state).toBe('RUNNING');

    // The batch: recovery runs across every live campaign first.
    await tickAllCampaigns({ repoRoot });
    expect((await getSession(session.id))?.state).toBe('ABANDONED');
  });
});

describe('the batch tick reaches a terminal campaign whose writeback never landed', () => {
  it('writes the outcome event nothing else would ever have written', async () => {
    const changeRequest = await makeChangeRequest('bulk-pending-outcome');
    expect(
      await approveChangeRequest({
        changeRequestId: changeRequest.id,
        via: 'PERSON',
        userId: null,
        authorityId: null,
      }),
    ).toBe(true);

    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    // Exactly the shape a crash between the COMPLETE patch and the writeback
    // insert leaves behind: finished, and absent from Brain's history.
    await patchCampaign(campaign.id, {
      state: 'COMPLETE',
      stageDetail: 'finished before the writeback landed',
      finishedAt: factoryNow(),
    });
    expect(await listEventsByEntity('FACTORY_CAMPAIGN', campaign.id)).toHaveLength(0);

    // Nothing that walks live campaigns can reach it.
    expect((await listLiveCampaigns()).map((c) => c.id)).not.toContain(campaign.id);

    await tickAllCampaigns({ repoRoot });

    const events = await listEventsByEntity('FACTORY_CAMPAIGN', campaign.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('FACTORY_CAMPAIGN_COMPLETED');

    // And still one after a second batch: the retry is idempotent, which is the
    // half of the repair that makes retrying it safe at all.
    await tickAllCampaigns({ repoRoot });
    expect(await listEventsByEntity('FACTORY_CAMPAIGN', campaign.id)).toHaveLength(1);
    expect((await getCampaign(campaign.id))?.state).toBe('COMPLETE');
  });
});

describe('the default stale bound for an unattached session', () => {
  it('leaves a thirty-minute reviewer alone and closes a hundred-minute one', async () => {
    const changeRequest = await makeChangeRequest('bulk-stale-default');
    const { campaign } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: changeRequest.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });

    const live = await openSession({
      campaignId: campaign.id,
      unitId: null,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 0,
      role: 'REVIEWER',
      model: 'test-model',
    });
    const dead = await openSession({
      campaignId: campaign.id,
      unitId: null,
      workerId: 'w2',
      accountRef: 'acc-1',
      attempt: 0,
      role: 'REVIEWER',
      model: 'test-model',
    });
    await getDb().run(`UPDATE factory_sessions SET started_at = ? WHERE id = ?`, [
      plusMs(factoryNow(), -30 * 60 * 1000),
      live.id,
    ]);
    await getDb().run(`UPDATE factory_sessions SET started_at = ? WHERE id = ?`, [
      plusMs(factoryNow(), -100 * 60 * 1000),
      dead.id,
    ]);

    // No `staleAfterMs`: the point is the default, and a test that supplies its
    // own bound cannot tell 90 minutes from 10.
    const report = await recoverCampaign(campaign.id);
    expect(report.sessionsClosed).toBe(1);
    expect((await getSession(live.id))?.state).toBe('RUNNING');
    expect((await getSession(dead.id))?.state).toBe('ABANDONED');
  });
});
