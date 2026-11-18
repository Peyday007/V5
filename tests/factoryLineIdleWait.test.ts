/**
 * The line's "idle" is the dispatcher's "would fire", not "is READY".
 *
 * Recorded failure class OPERATOR:RECURRING_OPERATIONAL_FAILURE:3f6ee83968764da2
 * (capacity output 2026-11-18T16:47:13): the FACTORY pool read idle=true with
 * waiting=1, running=0, capacity=1 — "1 piece(s) of executable work and 1 free
 * surface(s), and nothing is running or arriving. That is a fault, not a wait."
 * The line counted every READY factory bin as executable, while the dispatcher
 * deliberately does not start a session for a bin under a fire backoff or with a
 * deferred intent. These tests pin that such a bin reads as a wait with the
 * dispatcher's reason, and that a bin the dispatcher would fire still reads as
 * the fault it is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/services/dispatch/candidates.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/candidates.ts')>();
  const surface = {
    routine: {
      id: 'rtn_line_idle',
      name: 'Factory surface',
      routineRef: 'trig_line_idle',
      capabilities: ['repository'],
      state: 'ENABLED',
    },
    account: { name: 'Factory account', state: 'ENABLED' },
    routineInFlight: 0,
    routineTarget: 1,
    accountInFlight: 0,
    accountTarget: 1,
  };
  const snapshot = async () => ({ candidates: [surface], missingSecrets: [] });
  return { ...actual, fleetSnapshot: snapshot, sharedFleetSnapshot: snapshot };
});
vi.mock('../server/services/dispatch/router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/router.ts')>();
  return { ...actual, surfaceIneligibility: () => null };
});

import { freshProject, teardown, type TestProject } from './helpers.ts';
import { ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { createUser } from '../server/repos/identity.ts';
import {
  admitQueued,
  IDLE_REPORT_AFTER_MS,
  LINE_EVENT_KINDS,
  observeIdle,
  queueObjective,
  readLine,
  resetIdleObservation,
} from '../server/services/factory/line.ts';
import { listFactoryEvents } from '../server/repos/factoryFleet.ts';
import {
  createBin,
  ensureDispatchIntent,
  getBin,
  listDispatchesForBin,
  markDispatchDeferred,
} from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { STRANDED_REARM_CEILING } from '../server/services/dispatch/rearm.ts';

let fixture: TestProject;
let adminId = '';

beforeEach(async () => {
  fixture = await freshProject();
  resetIdleObservation();
  const admin = await createUser({
    email: `line-idle-${Math.random().toString(36).slice(2, 10)}@test.local`,
    displayName: 'The approver',
    password: 'a-long-enough-password',
    isBrainAdmin: true,
  });
  adminId = admin.id;
});

afterEach(async () => {
  await teardown();
});

/** One working campaign with one READY stage bin, as the recorded reading had. */
async function campaignWithReadyStage(): Promise<string> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `line-idle-${Math.random().toString(36).slice(2)}`,
    objective: 'Objective idle',
    expectedOutcome: 'Outcome idle',
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: 'idle holds', verification: 'npm test', mandatory: true }],
    repository: 'not-a-forge-remote',
    baseBranch: 'production',
    baseSha: 'a'.repeat(40),
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: ['server/line-idle/**'],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: [],
  });
  await queueObjective({ changeRequestId: changeRequest.id, userId: adminId, priority: 1 });
  const campaignId = (await admitQueued()).admitted[0]!.campaignId;
  await patchCampaign(campaignId, { state: 'EXECUTING' });
  // Admission may have made a first stage bin already; the reading is about one.
  await getDb().run(`DELETE FROM bins WHERE factory_campaign_id = ?`, [campaignId]);
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_PLAN',
    title: 'plan',
    objective: 'Plan the stage.',
    manifest: {
      objective: 'Plan the stage.',
      why: 'line idle test',
      lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'plan', establishes: 'a plan', input: '{}', transform: 'FACTORY_PLAN', dependsOn: [] }],
      acceptableSources: [],
      excludedSources: [],
      evidence: ['a plan'],
      outputs: ['one plan'],
      authorizedActions: ['plan'],
      prohibitedActions: ['anything else'],
      budgetUnits: null,
      retry: { maxAttempts: 2, backoffSeconds: 60 },
      stoppingConditions: ['a plan'],
    },
    completionContract: 'FACTORY_PLAN_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    factoryCampaignId: campaignId,
  });
  return bin.id;
}

describe('a READY factory bin the dispatcher is waiting on is a wait, not idle', () => {
  it('reads a bin under a fire backoff as waiting with the backoff time, and opens no idle interval', async () => {
    const binId = await campaignWithReadyStage();
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await getDb().run(`UPDATE bins SET dispatch_not_before = ? WHERE id = ?`, [until, binId]);

    const line = await readLine();
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.active.leasedBins).toBe(0);
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).not.toMatch(/That is a fault, not a wait/);
    expect(line.because).toContain(`fire backoff until ${until}`);
    expect(line.waiting?.bins).toBe(1);

    const t0 = new Date();
    await observeIdle(line, t0);
    await observeIdle(line, new Date(t0.getTime() + IDLE_REPORT_AFTER_MS + 1000));
    expect(await listFactoryEvents(null, { kinds: [LINE_EVENT_KINDS.idleStarted] })).toHaveLength(0);
  });

  it('reads a bin whose current intent the dispatcher deferred as waiting with the refusal and its time', async () => {
    const binId = await campaignWithReadyStage();
    const bin = (await getBin(binId))!;
    await ensureDispatchIntent(bin);
    const intent = (await listDispatchesForBin(binId)).at(-1)!;
    await markDispatchDeferred(intent.id, {
      refusal: 'ALL_SURFACES_AT_TARGET',
      message: 'no surface can take it now',
      retryAfterMs: 10 * 60_000,
    });

    const line = await readLine();
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/dispatch deferred \(ALL_SURFACES_AT_TARGET\) until \d{4}-/);
  });

  it('still reads a bin the dispatcher would fire, beside a free surface with nothing running, as the fault', async () => {
    await campaignWithReadyStage();
    const line = await readLine();
    expect(line.executable.readyBins).toBe(1);
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).toMatch(/That is a fault, not a wait/);
  });
});

/*
 * Repair F3 of the same campaign: a bin whose current-generation intent is
 * past PENDING. Some of those the dispatcher is still working on (a claimed
 * send, an abandonment inside its re-arm cool-off) — a wait with its time. The
 * rest no dispatcher pass will ever fire again (superseded, or abandoned at the
 * re-arm ceiling) — still the fault, now named, and not a reason for the remote
 * loop to ask the dispatcher for a pass every twenty seconds.
 */
async function intentFor(binId: string, set: string, params: unknown[]): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = (await listDispatchesForBin(binId)).at(-1)!;
  await getDb().run(`UPDATE bin_dispatch SET ${set} WHERE id = ?`, [...params, intent.id] as never[]);
}

describe('a READY factory bin whose intent is past PENDING', () => {
  it('reads an abandonment inside its re-arm cool-off as the dispatcher waiting, with the re-arm time', async () => {
    const binId = await campaignWithReadyStage();
    await intentFor(binId, `state = 'ABANDONED', last_error_kind = 'SERVER', max_attempts = 5, updated_at = ?`, [
      new Date().toISOString(),
    ]);
    const line = await readLine();
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/its intent gave up \(SERVER\); the dispatcher re-arms it after \d{4}-/);
  });

  it('reads an abandonment whose cool-off has passed as work the dispatcher will act on', async () => {
    const binId = await campaignWithReadyStage();
    await intentFor(binId, `state = 'ABANDONED', last_error_kind = 'SERVER', max_attempts = 5, updated_at = ?`, [
      new Date(Date.now() - 24 * 3_600_000).toISOString(),
    ]);
    const line = await readLine();
    expect(line.unexplainedIdle).toBe(true);
    expect(line.stranded?.bins).toBe(0);
  });

  it('reads a claimed send as the dispatcher waiting on its own fire', async () => {
    const binId = await campaignWithReadyStage();
    await intentFor(binId, `state = 'SENDING', next_attempt_at = ?`, [new Date(Date.now() + 60_000).toISOString()]);
    const line = await readLine();
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/a fire is being sent \(claim held until \d{4}-/);
  });

  it('names an intent abandoned at the re-arm ceiling as stranded, and keeps reading it as the fault', async () => {
    const binId = await campaignWithReadyStage();
    await intentFor(binId, `state = 'ABANDONED', last_error_kind = 'NO_SHOW', max_attempts = ?, updated_at = ?`, [
      STRANDED_REARM_CEILING,
      new Date(Date.now() - 24 * 3_600_000).toISOString(),
    ]);
    const line = await readLine();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.stranded?.bins).toBe(1);
    expect(line.because).toMatch(/That is a fault, not a wait/);
    expect(line.because).toContain('1 of them nothing in the dispatcher will fire again');
    expect(line.because).toContain(`re-arm ceiling of ${STRANDED_REARM_CEILING} fires`);
  });

  it('names a superseded intent as stranded', async () => {
    const binId = await campaignWithReadyStage();
    await intentFor(binId, `state = 'SUPERSEDED'`, []);
    const line = await readLine();
    expect(line.unexplainedIdle).toBe(true);
    expect(line.stranded?.bins).toBe(1);
    expect(line.because).toContain('its only intent at this generation was superseded');
  });
});
