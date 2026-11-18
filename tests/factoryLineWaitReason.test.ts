/**
 * A READY factory stage whose dispatch Brain deferred is a wait with a reason,
 * not executable work beside idle capacity.
 *
 * The defect this exists for was recorded in production on 2026-11-18: the
 * FACTORY pool read `waiting=1, running=0, capacity=1, idle=true` with "1
 * piece(s) of executable work and 1 free surface(s), and nothing is running or
 * arriving. That is a fault, not a wait." — while the bin's dispatch intent sat
 * `PENDING` on a recorded deferral the dispatcher would answer by itself. The
 * operator read that sentence as a RECURRING_OPERATIONAL_FAILURE and commissioned
 * a repair for a wait Brain had already explained. These tests pin both sides:
 * a live deferral reads as a named wait, and a READY bin with no deferral, or one
 * whose deferral has lapsed, still raises the fault.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { ensureCampaign, ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine, credentialDigest } from '../server/repos/fleet.ts';
import { createBin, ensureDispatchIntent, getBin, markDispatchDeferred, markDispatchFailed } from '../server/repos/bins.ts';
import { DISPATCH_DEFERRAL_KINDS, readLine, resetIdleObservation } from '../server/services/factory/line.ts';
import { getDb } from '../server/db/database.ts';
import { recordDeliveryProven } from './helpers/deliveryProven.ts';

const REPOSITORY = 'peyday007/v5';
const SECRET = 'LINE_WAIT_REASON_TOKEN';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
  resetIdleObservation();

  // One working Factory surface: a routed worker in the project, its account and
  // Routine, the delivery proof a repository-writing surface needs.
  const worker = await createWorker({ name: 'factory-line-wait', createdByType: 'SYSTEM', createdById: 'test' });
  await grantMembership({
    projectId: fixture.project.id,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await setWorkerRouting({
    workerId: worker.id,
    families: ['FACTORY'],
    repositories: [REPOSITORY],
    capabilities: ['repository', 'repository-write'],
    reason: 'the factory identity',
    setBy: 'test',
  });
  const account = await createAccount({ provider: 'anthropic', name: 'claude-line-wait' });
  process.env[SECRET] = 'token-line-wait';
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_line_wait',
    name: 'Factory line wait',
    tokenSecretName: SECRET,
    tokenDigest: credentialDigest('token-line-wait'),
    capabilities: ['repository', 'repository-write'],
  });
  await bindRoutineWorker(routine.id, worker.id);
  await recordDeliveryProven(routine.id, REPOSITORY);
});

afterEach(async () => {
  delete process.env[SECRET];
  await teardown();
});

/** A working campaign with one READY stage bin. */
async function readyStage(label: string): Promise<string> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `wait-${label}-${Math.random().toString(36).slice(2)}`,
    objective: `Objective ${label}`,
    expectedOutcome: `Outcome ${label}`,
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: `${label} holds`, verification: 'npm test', mandatory: true }],
    repository: 'not-a-forge-remote',
    baseBranch: 'production',
    baseSha: 'a'.repeat(40),
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: [`server/wait-${label}/**`],
    deploymentPolicy: 'NONE',
    rollbackRequirement: 'discard the branch',
    verificationCommands: [],
  });
  const { campaign } = await ensureCampaign({
    changeRequestId: changeRequest.id,
    projectId: fixture.project.id,
    baseSha: changeRequest.baseSha,
    laneTarget: 1,
    laneTargetReason: 'initial',
    executionMode: 'REMOTE',
  });
  await patchCampaign(campaign.id, { state: 'EXECUTING' });
  const bin = await createBin({
    projectId: fixture.project.id,
    kind: 'FACTORY_UNITS',
    title: 'units',
    objective: 'Do the stage.',
    manifest: {
      objective: 'Do the stage.',
      why: 'wait-reason test',
      lineage: { projectId: fixture.project.id, layerId: null, goal: null, orchestrationId: null },
      units: [{ key: 'u1', establishes: 'a result', input: '{}', transform: 'FACTORY_UNITS', dependsOn: [] }],
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
    factoryCampaignId: campaign.id,
  });
  return bin.id;
}

/** Put the bin's dispatch intent on a recorded deferral, as the dispatch loop does. */
async function defer(binId: string, refusal: string, retryAfterMs: number): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = await getDb().get<{ id: string }>(`SELECT id FROM bin_dispatch WHERE bin_id = ?`, [binId]);
  await markDispatchDeferred(intent!.id, { refusal, message: `deferred: ${refusal}`, retryAfterMs });
}

/** An instant off the live poll, so the reading takes its own fleet snapshot. */
const reading = () => readLine(new Date(Date.now() + 5_000));

describe('a deferred READY stage is a wait, not idle work', () => {
  it('reads a live deferral beside a free surface as a named wait, not the fault', async () => {
    const binId = await readyStage('deferred');
    await defer(binId, 'NO_CLAIMABLE_WORK', 10 * 60_000);
    const line = await reading();
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.executable.readyBins).toBe(0);
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/waiting out a recorded dispatch deferral \(NO_CLAIMABLE_WORK\)/);
    expect(line.because).toMatch(/lapses at \d{4}-\d{2}-\d{2}T/);
    expect(line.because).not.toMatch(/fault, not a wait/);
  });

  it('names an operator-resolved routing refusal the same way', async () => {
    const binId = await readyStage('scope');
    await defer(binId, 'NO_CAPABLE_SURFACE', 60 * 60_000);
    const line = await reading();
    expect(line.unexplainedIdle).toBe(false);
    expect(line.because).toMatch(/NO_CAPABLE_SURFACE/);
  });

  it('still raises the fault for a READY stage with no dispatch intent beside a free surface', async () => {
    await readyStage('undispatched');
    const line = await reading();
    expect(line.capacity.freeSurfaces).toBe(1);
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).toMatch(/That is a fault, not a wait\./);
  });

  it('still raises the fault once the deferral has lapsed with nothing having moved', async () => {
    const binId = await readyStage('lapsed');
    await defer(binId, 'NO_CLAIMABLE_WORK', 0);
    await getDb().run(`UPDATE bin_dispatch SET next_attempt_at = ? WHERE bin_id = ?`, [
      new Date(Date.now() - 60_000).toISOString(),
      binId,
    ]);
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
  });

  it('still raises the fault for a no-show reopen: an unanswered fire is not a deferral', async () => {
    const binId = await readyStage('no-show');
    await ensureDispatchIntent((await getBin(binId))!);
    // The shape the in-flight sweep leaves (bins.ts reopen): PENDING, NO_SHOW, a future retry.
    await getDb().run(
      `UPDATE bin_dispatch SET state = 'PENDING', next_attempt_at = ?, last_error_kind = 'NO_SHOW',
              last_error = 'Fired, and no worker ever claimed the bin before the in-flight window closed.'
        WHERE bin_id = ?`,
      [new Date(Date.now() + 30 * 60_000).toISOString(), binId],
    );
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).toMatch(/That is a fault, not a wait\./);
    expect(line.because).not.toMatch(/NO_SHOW/);
  });

  it('still raises the fault for a fire the provider refused, on its backoff', async () => {
    const binId = await readyStage('fire-failed');
    await ensureDispatchIntent((await getBin(binId))!);
    const intent = await getDb().get<{ id: string }>(`SELECT id FROM bin_dispatch WHERE bin_id = ?`, [binId]);
    await markDispatchFailed(intent!.id, { kind: 'HTTP_503', message: 'provider unavailable', retryAfterMs: 30 * 60_000 });
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
    expect(line.because).not.toMatch(/HTTP_503/);
  });

  it('names every refusal the dispatch loop defers with, and nothing else', () => {
    for (const kind of ['NO_CLAIMABLE_WORK', 'NO_ELIGIBLE_AUDIT_SESSION', 'BIN_REFIRE_GUARD', 'SLOT_LOST', 'NO_CAPABLE_SURFACE', 'ACCOUNT_SESSIONS_UNPRODUCTIVE']) {
      expect(DISPATCH_DEFERRAL_KINDS.has(kind)).toBe(true);
    }
    for (const kind of ['NO_SHOW', 'SUPERSEDED', 'HTTP_503', 'NOT_CONFIGURED']) expect(DISPATCH_DEFERRAL_KINDS.has(kind)).toBe(false);
  });

  it('keeps the fault when one stage is deferred and another is executable', async () => {
    const deferred = await readyStage('one-deferred');
    await defer(deferred, 'BIN_REFIRE_GUARD', 30 * 60_000);
    await readyStage('one-executable');
    const line = await reading();
    expect(line.executable.readyBins).toBe(1);
    expect(line.unexplainedIdle).toBe(true);
  });
});
