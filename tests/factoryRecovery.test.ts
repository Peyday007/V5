/**
 * Recovering a campaign whose process died, from rows alone.
 *
 * Every scenario here is set up with the same repository primitives the seed
 * kernel uses to reach these rows in the first place — `ensureCampaign`,
 * `ensureUnit`, `claimUnits`, `openSession` — so a test failure means
 * `recovery.ts` disagrees with what those primitives actually produce, not
 * with a fixture invented for convenience. Time is advanced the same way
 * `tests/factory.test.ts` already does: by writing the expired instant
 * directly, since nothing here is meant to wait in real time for a lease to
 * expire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import {
  claimUnits,
  ensureCampaign,
  ensureChangeRequest,
  ensureUnit,
  factoryNow,
  getCampaign,
  getUnit,
  listCheckpoints,
  patchCampaign,
  plusMs,
  recordCheckpoint,
} from '../server/repos/factory.ts';
import { getDb } from '../server/db/database.ts';
import { getSession, listFactoryEvents, listSessions, openSession } from '../server/repos/factoryFleet.ts';
import type { FactoryCampaign, FactoryChangeRequest } from '../server/domain/factory.ts';
import { recoverAll, recoverCampaign } from '../server/services/factory/recovery.ts';
import { campaignWorkspace, ensureWorktree, gitOrThrow, run } from '../server/services/factory/git.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

afterEach(async () => {
  await teardown();
});

async function makeChangeRequest(overrides: { submissionKey?: string } = {}): Promise<FactoryChangeRequest> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: overrides.submissionKey ?? `recovery-${Math.random().toString(36).slice(2)}`,
    objective: 'Prove recovery survives a dead process.',
    expectedOutcome: 'Nothing about history is lost.',
    nonGoals: [],
    acceptanceConditions: [
      { id: 'A01', statement: 'history survives', verification: 'read the rows', mandatory: true },
    ],
    repository: 'https://example.invalid/subject.git',
    baseBranch: 'main',
    baseSha: 'deadbeefcafefeed00000000000000000000000',
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['src/**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'revert the branch',
    verificationCommands: [],
  });
  return changeRequest;
}

async function makeCampaign(changeRequest: FactoryChangeRequest, laneTarget = 2): Promise<FactoryCampaign> {
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget,
    laneTargetReason: 'initial',
  });
  return campaign;
}

async function makeReadyUnit(campaignId: string, unitKey: string, ownedPaths: string[]) {
  const { unit } = await ensureUnit({
    campaignId,
    unitKey,
    kind: 'IMPLEMENTATION',
    role: 'IMPLEMENTER',
    title: unitKey,
    objective: unitKey,
    acceptance: ['it works'],
    ownedPaths,
    requiredContext: [],
    verification: [],
    expectedArtifact: 'a commit',
    state: 'READY',
  });
  return unit;
}

async function expireUnitLease(unitId: string): Promise<void> {
  await getDb().run(`UPDATE factory_work_units SET lease_expires_at = ? WHERE id = ?`, [
    plusMs(factoryNow(), -60_000),
    unitId,
  ]);
}

describe('recoverCampaign: sessions, leases and history', () => {
  it('closes a RUNNING session whose unit lease expired, reclaims the lease, and keeps the checkpoint', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);
    const unit = await makeReadyUnit(campaign.id, 'alpha', ['src/one.txt']);

    const session = await openSession({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'test-model',
    });
    expect(session.state).toBe('RUNNING');

    const claimed = await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [unit.id],
      sessionId: session.id,
      leaseMs: 30_000,
    });
    expect(claimed.length).toBe(1);
    const leasedUnit = await getUnit(unit.id);
    expect(leasedUnit?.leaseSessionId).toBe(session.id);

    // A worker checkpoint recorded before the process died. Recovery must
    // never touch it.
    const checkpoint = await recordCheckpoint({
      campaignId: campaign.id,
      unitId: unit.id,
      attempt: 1,
      sessionId: session.id,
      workerId: 'w1',
      established: 'Read the files that matter.',
      commits: [],
      testsRun: [],
      unresolved: 'the process died before finishing',
      nextAction: 'resume from here',
    });

    // Time passes the way it would if nothing had renewed the lease.
    await expireUnitLease(unit.id);

    const report = await recoverCampaign(campaign.id);
    expect(report.sessionsClosed).toBe(1);
    expect(report.leasesReclaimed).toBe(1);

    const closedSession = await getSession(session.id);
    expect(closedSession?.state).toBe('ABANDONED');

    /*
     * The lease is left exactly where it is, and that is the corrected contract
     * rather than a gap: an expired lease on a unit with attempts left is
     * claimable work, and the claim takes it as a *takeover* naming the worker
     * that died holding it. Sweeping the row to READY first leaves the same work
     * claimable and destroys the only record that a recovery happened.
     */
    const reclaimedUnit = await getUnit(unit.id);
    expect(reclaimedUnit?.state).toBe('LEASED');
    expect((reclaimedUnit?.leaseExpiresAt ?? '') < new Date().toISOString()).toBe(true);

    // The unit is claimable again — recovery did not leave it stranded — and the
    // claim credits the takeover, which is the evidence the sweep used to eat.
    const retaken = await claimUnits({ campaignId: campaign.id, workerId: 'w2', unitIds: [unit.id] });
    expect(retaken.length).toBe(1);
    expect(retaken[0]?.attempt).toBe(2);
    expect(retaken[0]?.takeoverFrom).toBe('w1');

    // History survived: the checkpoint from the dead attempt is still there.
    const checkpoints = await listCheckpoints(unit.id);
    expect(checkpoints.map((c) => c.id)).toContain(checkpoint.id);
    expect(checkpoints[0]?.unresolved).toBe('the process died before finishing');
  });

  it('leaves a session alone when its unit still holds a live, unexpired lease', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);
    const unit = await makeReadyUnit(campaign.id, 'alpha', ['src/one.txt']);

    const session = await openSession({
      campaignId: campaign.id,
      unitId: unit.id,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'test-model',
    });
    await claimUnits({
      campaignId: campaign.id,
      workerId: 'w1',
      unitIds: [unit.id],
      sessionId: session.id,
      leaseMs: 30 * 60 * 1000,
    });

    const report = await recoverCampaign(campaign.id);
    expect(report.sessionsClosed).toBe(0);
    expect(report.leasesReclaimed).toBe(0);

    const stillRunning = await getSession(session.id);
    expect(stillRunning?.state).toBe('RUNNING');
    const stillLeased = await getUnit(unit.id);
    expect(stillLeased?.state).toBe('LEASED');
  });

  it('closes an unattached session once it has run past the stale bound, and leaves a recent one alone', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);

    const stale = await openSession({
      campaignId: campaign.id,
      unitId: null,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 0,
      role: 'ARCHITECT',
      model: 'test-model',
    });
    await getDb().run(`UPDATE factory_sessions SET started_at = ? WHERE id = ?`, [
      plusMs(factoryNow(), -20 * 60 * 1000),
      stale.id,
    ]);

    const fresh = await openSession({
      campaignId: campaign.id,
      unitId: null,
      workerId: 'w2',
      accountRef: 'acc-1',
      attempt: 0,
      role: 'ARCHITECT',
      model: 'test-model',
    });

    const report = await recoverCampaign(campaign.id, { staleAfterMs: 10 * 60 * 1000 });
    expect(report.sessionsClosed).toBe(1);

    expect((await getSession(stale.id))?.state).toBe('ABANDONED');
    expect((await getSession(fresh.id))?.state).toBe('RUNNING');
  });

  it('re-derives an INTEGRATING campaign back to EXECUTING when nothing was actually implemented', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);
    await makeReadyUnit(campaign.id, 'alpha', ['src/one.txt']);
    await patchCampaign(campaign.id, { state: 'INTEGRATING' });

    const report = await recoverCampaign(campaign.id);
    expect(report.stateRederived).toEqual({ from: 'INTEGRATING', to: 'EXECUTING' });

    const patched = await getCampaign(campaign.id);
    expect(patched?.state).toBe('EXECUTING');

    const events = await listFactoryEvents(campaign.id, { kinds: ['CAMPAIGN_RECOVERED'] });
    expect(events.length).toBe(1);
    expect(events[0]?.detail['to']).toBe('EXECUTING');
  });

  it('leaves campaign state alone when the units already support it', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);
    const report = await recoverCampaign(campaign.id);
    expect(report.stateRederived).toBeNull();
    expect((await getCampaign(campaign.id))?.state).toBe('PLANNING');
  });

  it('returns an empty report for a campaign id that does not exist', async () => {
    const report = await recoverCampaign('fcp_does_not_exist');
    expect(report).toEqual({
      campaignId: 'fcp_does_not_exist',
      sessionsClosed: 0,
      leasesReclaimed: 0,
      worktreesPruned: 0,
      worktreesSkippedDirty: 0,
      stateRederived: null,
    });
  });
});

describe('recoverCampaign: worktree pruning', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-recovery-repo-'));
    fs.writeFileSync(path.join(repoRoot, 'file.txt'), 'one\n');
    await run('git', ['init', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'user.email', 'factory@test'], { cwd: repoRoot });
    await run('git', ['config', 'user.name', 'Factory Test'], { cwd: repoRoot });
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: repoRoot });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('removes a terminal unit worktree but leaves an active one and a dirty one in place', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);
    const head = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);

    const integrated = await makeReadyUnit(campaign.id, 'done', ['src/done.txt']);
    const active = await makeReadyUnit(campaign.id, 'active', ['src/active.txt']);
    const dirty = await makeReadyUnit(campaign.id, 'dirty', ['src/dirty.txt']);

    await getDb().run(`UPDATE factory_work_units SET state = 'INTEGRATED', attempt = 1 WHERE id = ?`, [
      integrated.id,
    ]);
    // A live lease, the way claiming actually produces one — not a hand-written
    // state, so the CHECK constraint tying LEASED to a real lease still holds.
    await claimUnits({ campaignId: campaign.id, workerId: 'w1', unitIds: [active.id], leaseMs: 30 * 60 * 1000 });
    await getDb().run(
      `UPDATE factory_work_units SET state = 'FAILED', attempt = 3, max_attempts = 3 WHERE id = ?`,
      [dirty.id],
    );

    const integratedPath = path.join(campaignWorkspace(campaign.id), 'done-a1');
    const activePath = path.join(campaignWorkspace(campaign.id), 'active-a1');
    const dirtyPath = path.join(campaignWorkspace(campaign.id), 'dirty-a3');

    await ensureWorktree(repoRoot, { path: integratedPath, branch: 'factory/done/a1', baseSha: head });
    await ensureWorktree(repoRoot, { path: activePath, branch: 'factory/active/a1', baseSha: head });
    await ensureWorktree(repoRoot, { path: dirtyPath, branch: 'factory/dirty/a3', baseSha: head });
    fs.writeFileSync(path.join(dirtyPath, 'uncommitted.txt'), 'not committed\n');

    const report = await recoverCampaign(campaign.id, { repoRoot });
    expect(report.worktreesPruned).toBe(1);
    expect(report.worktreesSkippedDirty).toBe(1);

    expect(fs.existsSync(integratedPath)).toBe(false);
    expect(fs.existsSync(activePath)).toBe(true);
    expect(fs.existsSync(dirtyPath)).toBe(true);
  });

  it('never touches worktrees when no repoRoot is given', async () => {
    const changeRequest = await makeChangeRequest();
    const campaign = await makeCampaign(changeRequest);
    const head = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
    const integrated = await makeReadyUnit(campaign.id, 'done', ['src/done.txt']);
    await getDb().run(`UPDATE factory_work_units SET state = 'INTEGRATED', attempt = 1 WHERE id = ?`, [
      integrated.id,
    ]);
    const integratedPath = path.join(campaignWorkspace(campaign.id), 'done-a1');
    await ensureWorktree(repoRoot, { path: integratedPath, branch: 'factory/done/a1', baseSha: head });

    const report = await recoverCampaign(campaign.id);
    expect(report.worktreesPruned).toBe(0);
    expect(fs.existsSync(integratedPath)).toBe(true);
  });
});

describe('recoverAll', () => {
  it('recovers every live campaign and skips terminal ones', async () => {
    const liveRequest = await makeChangeRequest({ submissionKey: 'live' });
    const liveCampaign = await makeCampaign(liveRequest);
    const liveUnit = await makeReadyUnit(liveCampaign.id, 'alpha', ['src/one.txt']);
    const liveSession = await openSession({
      campaignId: liveCampaign.id,
      unitId: liveUnit.id,
      workerId: 'w1',
      accountRef: 'acc-1',
      attempt: 1,
      role: 'IMPLEMENTER',
      model: 'test-model',
    });
    await claimUnits({
      campaignId: liveCampaign.id,
      workerId: 'w1',
      unitIds: [liveUnit.id],
      sessionId: liveSession.id,
      leaseMs: 30_000,
    });
    await expireUnitLease(liveUnit.id);

    const doneRequest = await makeChangeRequest({ submissionKey: 'done' });
    const doneCampaign = await makeCampaign(doneRequest);
    await patchCampaign(doneCampaign.id, { state: 'COMPLETE' });
    const doneSession = await openSession({
      campaignId: doneCampaign.id,
      unitId: null,
      workerId: 'w3',
      accountRef: 'acc-1',
      attempt: 0,
      role: 'ARCHITECT',
      model: 'test-model',
    });

    const reports = await recoverAll();
    const campaignIds = reports.map((r) => r.campaignId);
    expect(campaignIds).toContain(liveCampaign.id);
    expect(campaignIds).not.toContain(doneCampaign.id);

    const liveReport = reports.find((r) => r.campaignId === liveCampaign.id);
    expect(liveReport?.sessionsClosed).toBe(1);
    expect(liveReport?.leasesReclaimed).toBe(1);

    // A campaign already COMPLETE is not a live campaign, so recoverAll never
    // looked at it and its session is exactly as it was left.
    expect((await getSession(doneSession.id))?.state).toBe('RUNNING');
  });
});
