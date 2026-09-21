/**
 * The hosted plane's sessions, read back from rows Brain wrote.
 *
 * The defect these exist for is not that a ceiling was unobserved. It is that
 * Brain observed every one of them — fired the Routine, leased the bin, timed
 * the lease and stamped the terminal event — and nothing read any of it into
 * `factory_sessions`, which is the one table `metrics.ts` asks the question of.
 * So the first assertion below is the defect itself, and every assertion after
 * it was run against the unswept campaign first, where they fail with
 * `UNKNOWN` and `0`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import {
  approveChangeRequest,
  ensureCampaign,
  ensureChangeRequest,
  patchCampaign,
} from '../server/repos/factory.ts';
import { assignNextBin, createBin, finishBin, getBin, releaseBin } from '../server/repos/bins.ts';
import { listSessions } from '../server/repos/factoryFleet.ts';
import { campaignMetrics } from '../server/services/factory/metrics.ts';
import { tickRemoteCampaign } from '../server/services/factory/remoteLoop.ts';
import {
  episodesOf,
  recordObservedSessions,
  ROLE_OF_BIN_KIND,
} from '../server/services/factory/sessions.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import {
  claimDispatchIntent,
  ensureDispatchIntent,
  markDispatchRoutine,
  markDispatchSent,
} from '../server/repos/bins.ts';
import type { BinEvent } from '../server/domain/types.ts';

const REMOTE = 'https://github.com/Peyday007/V5';
const BASE = 'a'.repeat(40);

let fixture: TestProject;

function event(over: Partial<BinEvent>): BinEvent {
  return {
    id: 'bev_x',
    eventType: 'BIN_ASSIGNED',
    at: '2026-09-21T00:00:00.000Z',
    binId: 'bin_1',
    projectId: null,
    layerId: null,
    orchestrationId: null,
    workItemId: null,
    workerId: 'wkr_1',
    sessionRef: null,
    routineRef: null,
    routineVersion: null,
    fireEventId: null,
    provider: null,
    leaseId: 'lease_1',
    leaseGeneration: 1,
    attempt: 1,
    durationMs: null,
    measures: {},
    outcome: null,
    reason: null,
    isProxy: false,
    accountId: null,
    routineId: null,
    evidenceClass: null,
    workloadClass: null,
    ...over,
  } as BinEvent;
}

describe('pairing an assignment with the event that ended it', () => {
  it('reads one episode per lease, with both ends of its interval', () => {
    const episodes = episodesOf([
      event({ at: '2026-09-21T00:00:00.000Z', leaseId: 'l1', leaseGeneration: 1 }),
      event({
        eventType: 'BIN_TERMINAL',
        at: '2026-09-21T00:05:00.000Z',
        leaseId: 'l1',
        leaseGeneration: 1,
        outcome: 'COMPLETE',
      }),
    ]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.state).toBe('FINISHED');
    expect(episodes[0]?.startedAt).toBe('2026-09-21T00:00:00.000Z');
    expect(episodes[0]?.endedAt).toBe('2026-09-21T00:05:00.000Z');
    expect(episodes[0]?.durationMs).toBe(300_000);
  });

  it('reads a retaken bin as two sessions rather than one long one', () => {
    const episodes = episodesOf([
      event({ at: '2026-09-21T00:00:00.000Z', leaseId: 'l1', leaseGeneration: 1 }),
      event({
        eventType: 'BIN_RELEASED',
        at: '2026-09-21T00:01:00.000Z',
        leaseId: 'l1',
        leaseGeneration: 1,
        outcome: 'RELEASED',
      }),
      event({
        eventType: 'BIN_TAKEOVER',
        at: '2026-09-21T00:02:00.000Z',
        leaseId: 'l2',
        leaseGeneration: 2,
      }),
      event({
        eventType: 'BIN_TERMINAL',
        at: '2026-09-21T00:03:00.000Z',
        leaseId: 'l2',
        leaseGeneration: 2,
        outcome: 'COMPLETE',
      }),
    ]);
    expect(episodes.map((one) => one.state)).toEqual(['ABANDONED', 'FINISHED']);
    expect(episodes.map((one) => one.leaseGeneration)).toEqual([1, 2]);
  });

  /*
   * The honesty requirement, and the direction it errs in. A lease that simply
   * expired leaves no close event at all, so Brain does not know when that
   * session stopped — and an invented end would put an interval into a
   * concurrency sweep that nobody measured. Skipping it makes the overlap a
   * floor, which is the safe direction for a ceiling.
   */
  it('leaves an assignment with no close event out rather than inventing an end', () => {
    expect(episodesOf([event({ leaseId: 'l1', leaseGeneration: 1 })])).toHaveLength(0);
  });

  it('never reports a stage it cannot name a role for', () => {
    expect(ROLE_OF_BIN_KIND['RESEARCH_FRAGMENT']).toBeUndefined();
    expect(ROLE_OF_BIN_KIND['FACTORY_REVIEW']).toBe('REVIEWER');
  });
});

describe('what the hosted plane ran, recorded from Brain’s own rows', () => {
  beforeEach(async () => {
    fixture = await freshProject();
  });

  async function campaign(): Promise<string> {
    const user = await createUser({
      email: `sessions-${Math.random().toString(36).slice(2)}@brain.invalid`,
      displayName: 'Sessions',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
      createdByType: 'SYSTEM',
      createdById: 't',
    });
    const { changeRequest } = await ensureChangeRequest({
      projectId: fixture.project.id,
      submissionKey: `sessions-${Date.now()}`,
      objective: 'Measure what the hosted plane actually ran.',
      expectedOutcome: 'A concurrency figure that is a reading rather than a blank.',
      nonGoals: [],
      acceptanceConditions: [
        { id: 'c1', statement: 'it is measured', verification: 'npm test', mandatory: true },
      ],
      repository: REMOTE,
      repositoryRoot: null,
      baseBranch: 'production',
      baseSha: BASE,
      environment: 'LOCAL',
      riskClass: 'LOW',
      mutationScope: ['server/**'],
      deploymentPolicy: 'NONE',
      rollbackRequirement: 'none',
      verificationCommands: ['npm test'],
    });
    await approveChangeRequest({
      changeRequestId: changeRequest.id,
      via: 'PERSON',
      userId: user.id,
      authorityId: null,
    });
    const { campaign: made } = await ensureCampaign({
      changeRequestId: changeRequest.id,
      projectId: fixture.project.id,
      baseSha: BASE,
      laneTarget: 2,
      laneTargetReason: 'initial',
      executionMode: 'REMOTE',
      integrationBranch: 'factory/campaign/test',
      pullRequest: null,
    });
    return made.id;
  }

  async function stageBin(campaignId: string, kind: string, unitKey: string): Promise<string> {
    const bin = await createBin({
      projectId: fixture.project.id,
      kind,
      title: `${kind} for a measurement`,
      objective: 'Do the stage.',
      manifest: {
        objective: 'Do the stage.',
        why: 'measuring concurrency',
        lineage: {
          projectId: fixture.project.id,
          layerId: null,
          goal: null,
          orchestrationId: null,
        },
        units: [
          { key: unitKey, establishes: 'a result', input: '{}', transform: kind, dependsOn: [] },
        ],
        acceptableSources: [],
        excludedSources: [],
        evidence: ['a result'],
        outputs: ['one result'],
        authorizedActions: ['do the stage'],
        prohibitedActions: ['anything else'],
        budgetUnits: null,
        retry: { maxAttempts: 2, backoffSeconds: 60 },
        stoppingConditions: ['a result per unit'],
      },
      completionContract: 'FACTORY_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      factoryCampaignId: campaignId,
    });
    return bin.id;
  }

  /** One worker taking one bin and finishing it: exactly one session episode. */
  async function runBin(binId: string, workerId: string, sessionRef: string): Promise<void> {
    const assigned = await assignNextBin({
      workerId,
      projectIds: [fixture.project.id],
      sessionRef,
    });
    expect(assigned?.bin.id, 'the bin the fixture meant to hand out').toBe(binId);
    const bin = await getBin(binId);
    if (!bin || !bin.leaseId) throw new Error('the bin was not leased');
    await finishBin(
      {
        binId,
        leaseId: bin.leaseId,
        leaseGeneration: bin.leaseGeneration,
        workerId,
      },
      { state: 'COMPLETE', reason: 'the stage is done' },
    );
  }

  it('records nothing before the sweep, which is the defect itself', async () => {
    const campaignId = await campaign();
    const worker = await createWorker({ name: `w-${Date.now()}`, createdByType: 'SYSTEM', createdById: 't' });
    const binId = await stageBin(campaignId, 'FACTORY_UNITS', 'u1');
    await runBin(binId, worker.id, 'cse_one');

    const before = await campaignMetrics(campaignId);
    expect(before.concurrencyEvidence).toBe('UNKNOWN');
    expect(before.maxObservedConcurrency).toBe(0);
    expect(before.sessions.total).toBe(0);
  });

  it('reads the finished assignment into a session, and says so once', async () => {
    const campaignId = await campaign();
    const worker = await createWorker({ name: `w-${Date.now()}`, createdByType: 'SYSTEM', createdById: 't' });
    const binId = await stageBin(campaignId, 'FACTORY_UNITS', 'u1');
    await runBin(binId, worker.id, 'cse_one');

    const first = await recordObservedSessions(campaignId);
    expect(first.recorded).toBe(1);

    const sessions = await listSessions(campaignId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.role).toBe('IMPLEMENTER');
    expect(sessions[0]?.state).toBe('FINISHED');
    expect(sessions[0]?.workerId).toBe(worker.id);
    expect(sessions[0]?.binId).toBe(binId);
    expect(sessions[0]?.endedAt).not.toBeNull();

    // Idempotent by the episode, not by a flag: a second pass writes nothing.
    const second = await recordObservedSessions(campaignId);
    expect(second.recorded).toBe(0);
    expect(second.alreadyRecorded).toBe(1);
    expect(await listSessions(campaignId)).toHaveLength(1);

    const after = await campaignMetrics(campaignId);
    expect(after.concurrencyEvidence).toBe('MEASURED');
    expect(after.maxObservedConcurrency).toBe(1);
  });

  /*
   * The reading the whole change exists for: two stages genuinely overlapping.
   * Both bins are leased before either is finished, so the sweep must report a
   * peak of two — and it must get there from the events rather than from the
   * number of sessions, which a campaign of two sequential episodes also has.
   */
  it('measures a real overlap as an overlap, and sequential work as sequential', async () => {
    const campaignId = await campaign();
    const one = await createWorker({ name: `w1-${Date.now()}`, createdByType: 'SYSTEM', createdById: 't' });
    const two = await createWorker({ name: `w2-${Date.now()}`, createdByType: 'SYSTEM', createdById: 't' });
    const binA = await stageBin(campaignId, 'FACTORY_UNITS', 'a');
    const binB = await stageBin(campaignId, 'FACTORY_UNITS', 'b');

    /*
     * Real sessions last minutes and these last microseconds, so the fixture
     * separates them by a few milliseconds. Without it every event carries one
     * timestamp, both intervals are zero-length at the same instant, and
     * `maxOverlap` correctly reports that two sessions which merely *touched*
     * were not concurrent — which would be the sweep being right about a
     * fixture that could not express the thing under test.
     */
    const apart = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

    const assignedA = await assignNextBin({
      workerId: one.id,
      projectIds: [fixture.project.id],
      sessionRef: 'cse_a',
    });
    await apart();
    const assignedB = await assignNextBin({
      workerId: two.id,
      projectIds: [fixture.project.id],
      sessionRef: 'cse_b',
    });
    if (!assignedA || !assignedB) throw new Error('both bins should have been handed out');
    expect(assignedA.bin.id).not.toBe(assignedB.bin.id);

    for (const [worker, assigned] of [
      [one, assignedA],
      [two, assignedB],
    ] as const) {
      await apart();
      const live = await getBin(assigned.bin.id);
      if (!live || !live.leaseId) throw new Error('not leased');
      await finishBin(
        {
          binId: live.id,
          leaseId: live.leaseId,
          leaseGeneration: live.leaseGeneration,
          workerId: worker.id,
        },
        { state: 'COMPLETE', reason: 'done' },
      );
    }

    await recordObservedSessions(campaignId);
    const metrics = await campaignMetrics(campaignId);
    expect(metrics.sessions.total).toBe(2);
    expect(metrics.concurrencyEvidence).toBe('MEASURED');
    expect(metrics.maxObservedConcurrency).toBe(2);
    expect([binA, binB]).toContain((await listSessions(campaignId))[0]?.binId);
  });

  /*
   * A mechanism nothing calls is not a mechanism, and this repository has had
   * to write that sentence seven times. So the sweep is asserted *through the
   * tick* rather than by calling it — the cancelled path, because it reaches
   * `sweepSessionsInto` without a forge and because a cancelled campaign's
   * sessions happened too: what stops being true when a campaign is cancelled
   * is that anything more will happen, not that Brain fired nobody.
   */
  it('is run by the tick rather than only by a caller who remembers it', async () => {
    const campaignId = await campaign();
    const worker = await createWorker({
      name: `w-${Math.random().toString(36).slice(2)}`,
      createdByType: 'SYSTEM',
      createdById: 't',
    });
    const binId = await stageBin(campaignId, 'FACTORY_UNITS', 'u1');
    await runBin(binId, worker.id, 'cse_ticked');
    await patchCampaign(campaignId, { state: 'CANCELLED' });

    expect(await listSessions(campaignId)).toHaveLength(0);
    const report = await tickRemoteCampaign(campaignId);
    expect(report.state).toBe('CANCELLED');
    expect(await listSessions(campaignId)).toHaveLength(1);
    expect(report.notes.join(' ')).toContain('execution session(s) recorded');
  });

  /*
   * The account is Brain's own record of which surface it fired, never anything
   * the worker said. With no dispatch row there is nothing to read, and the
   * answer is UNKNOWN rather than a plausible default — §23's arithmetic on a
   * fiction, refused at the column that would carry it.
   */
  it('attributes the account from the dispatch Brain sent, and says UNKNOWN when it sent none', async () => {
    const campaignId = await campaign();
    const worker = await createWorker({ name: `w-${Date.now()}`, createdByType: 'SYSTEM', createdById: 't' });
    const unattributed = await stageBin(campaignId, 'FACTORY_REVIEW', 'r');
    await runBin(unattributed, worker.id, 'cse_unattributed');
    await recordObservedSessions(campaignId);
    expect((await listSessions(campaignId))[0]?.accountRef).toBe('UNKNOWN');

    const account = await createAccount({ provider: 'claude', name: 'measured-account' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: `trig_${Math.random().toString(36).slice(2)}`,
      name: 'Factory surface',
      tokenSecretName: `BRAIN_ROUTINE_TOKEN_TEST_${Math.random().toString(36).slice(2)}`,
      tokenDigest: 'x'.repeat(64),
      capabilities: ['repository'],
      workerId: worker.id,
    });

    const attributed = await stageBin(campaignId, 'FACTORY_INTEGRATE', 'i');
    const bin = await getBin(attributed);
    if (!bin) throw new Error('no bin');
    await ensureDispatchIntent(bin);
    const claimed = await claimDispatchIntent();
    expect(claimed?.binId).toBe(bin.id);
    if (!claimed) throw new Error('no intent');
    // The dispatcher records where a fire is aimed before it fires it, so the
    // fixture does too: a test that skipped it would be asserting against rows
    // production never produces.
    await markDispatchRoutine(claimed.id, routine.id);
    await markDispatchSent(claimed.id, {
      routineRef: routine.routineRef,
      routineId: routine.id,
      accountId: account.id,
      sessionRef: 'cse_fired_by_brain',
      fireEventId: 'fire_1',
    });
    await runBin(attributed, worker.id, 'cse_worker_said_something_else');
    await recordObservedSessions(campaignId);

    const integrator = (await listSessions(campaignId)).find((one) => one.role === 'INTEGRATOR');
    expect(integrator?.accountRef).toBe('measured-account');
    // Brain's own record of the fire wins over what the worker reported.
    expect(integrator?.externalSessionId).toBe('cse_fired_by_brain');
  });
});
