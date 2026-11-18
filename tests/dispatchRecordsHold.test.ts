/**
 * A claimable bin the dispatcher will not fire for says why, in a row.
 *
 * Production, 2026-11-18: the FACTORY pool read "1 piece(s) of executable work
 * and 1 free surface(s), and nothing is running or arriving. That is a fault,
 * not a wait." while its one READY factory bin sat under a fire backoff
 * (`dispatch_not_before` in the future). The dispatcher was right not to fire,
 * but `listDispatchableBinHeads` simply left the bin out, so it had no dispatch
 * intent at its generation and nothing anywhere recorded the wait. The operator
 * read that silence as a RECURRING_OPERATIONAL_FAILURE needing the owner.
 *
 * These tests reproduce that shape and hold each part of the fix:
 *   - the backed-off bin gets a PENDING intent deferred with BIN_REFIRE_GUARD
 *     until exactly its own `dispatch_not_before`, and nothing is fired;
 *   - once the backoff passes, the ordinary path fires it;
 *   - a bin out of attempts gets no intent, and one event names it;
 *   - the query that finds them reuses the dispatcher's own fragments.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { ensureCampaign, ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine, credentialDigest } from '../server/repos/fleet.ts';
import {
  createBin,
  getBin,
  listBinEvents,
  listDispatchesForBin,
  listHeldBinHeads,
} from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { getDb } from '../server/db/database.ts';
import { recordDeliveryProven } from './helpers/deliveryProven.ts';

const REPOSITORY = 'peyday007/v5';
const SECRET = 'DISPATCH_HOLD_TOKEN';
const realFetch = globalThis.fetch;

let fixture: TestProject;
let fires = 0;

beforeEach(async () => {
  fixture = await freshProject();
  // One working Factory surface beside the bin: a routed worker in the
  // project, its account and Routine, and the delivery proof a
  // repository-writing surface needs.
  const worker = await createWorker({ name: 'dispatch-hold', createdByType: 'SYSTEM', createdById: 'test' });
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
  const account = await createAccount({ provider: 'anthropic', name: `claude-hold-${Math.random().toString(36).slice(2, 8)}` });
  process.env[SECRET] = 'token-dispatch-hold';
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_hold_${Math.random().toString(36).slice(2, 8)}`,
    name: 'Factory hold',
    tokenSecretName: SECRET,
    tokenDigest: credentialDigest('token-dispatch-hold'),
    capabilities: ['repository', 'repository-write'],
  });
  await bindRoutineWorker(routine.id, worker.id);
  await recordDeliveryProven(routine.id, REPOSITORY);
  fires = 0;
  resetNetworkBlockCache();
  globalThis.fetch = (async () => {
    fires += 1;
    return new Response(JSON.stringify({ claude_code_session_id: `cse_hold_${fires}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env[SECRET];
  resetNetworkBlockCache();
  await teardown();
});

/** A working campaign with one READY factory stage bin. */
async function readyFactoryBin(label: string): Promise<string> {
  const { changeRequest } = await ensureChangeRequest({
    projectId: fixture.project.id,
    submissionKey: `hold-${label}-${Math.random().toString(36).slice(2)}`,
    objective: `Objective ${label}`,
    expectedOutcome: `Outcome ${label}`,
    nonGoals: [],
    acceptanceConditions: [{ id: 'A01', statement: `${label} holds`, verification: 'npm test', mandatory: true }],
    repository: 'not-a-forge-remote',
    baseBranch: 'production',
    baseSha: 'a'.repeat(40),
    environment: 'LOCAL',
    riskClass: 'LOW',
    mutationScope: [`server/hold-${label}/**`],
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
      why: 'dispatch-hold test',
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

const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString();
const aMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();

describe('a READY factory bin under a fire backoff', () => {
  it('had no intent and no recorded reason: the recorded failure class', async () => {
    const binId = await readyFactoryBin('before');
    const notBefore = inTenMinutes();
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [notBefore, binId]);

    // The state the line found: a READY bin, a free surface, and no row saying why.
    expect((await getBin(binId))!.state).toBe('READY');
    expect(await listDispatchesForBin(binId)).toHaveLength(0);
    expect((await listBinEvents(binId)).some((e) => e.eventType.startsWith('DISPATCH_'))).toBe(false);

    // And the query names it, with the reason the dispatcher has.
    const held = (await listHeldBinHeads()).find((one) => one.id === binId);
    expect(held?.holdReason).toBe('FIRE_BACKOFF');
    expect(held?.dispatchNotBefore).toBe(notBefore);
  });

  it('is given a PENDING intent deferred until exactly its backoff, and nothing is fired', async () => {
    const binId = await readyFactoryBin('deferred');
    const notBefore = inTenMinutes();
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [notBefore, binId]);

    const result = await dispatchTick({ burst: 4, projectIds: [fixture.project.id] });
    expect(result.fired).toBe(0);
    expect(fires).toBe(0);

    const bin = (await getBin(binId))!;
    const intents = await listDispatchesForBin(binId);
    expect(intents).toHaveLength(1);
    const [intent] = intents;
    expect(intent!.leaseGeneration).toBe(bin.leaseGeneration);
    expect(intent!.state).toBe('PENDING');
    expect(intent!.lastErrorKind).toBe('BIN_REFIRE_GUARD');
    expect(intent!.nextAttemptAt).toBe(notBefore);
    expect(intent!.attemptCount).toBe(0);
    // The backoff itself is untouched.
    expect(bin.dispatchNotBefore).toBe(notBefore);

    // A second tick neither duplicates the intent nor fires it early.
    expect((await dispatchTick({ burst: 4, projectIds: [fixture.project.id] })).fired).toBe(0);
    expect(await listDispatchesForBin(binId)).toHaveLength(1);
    expect(fires).toBe(0);
  });

  it('fires through the ordinary path once the backoff has passed', async () => {
    const binId = await readyFactoryBin('resumes');
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [inTenMinutes(), binId]);
    expect((await dispatchTick({ burst: 4, projectIds: [fixture.project.id] })).fired).toBe(0);

    // The clock passes the backoff: both the bin's and its intent's.
    const passed = aMinuteAgo();
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [passed, binId]);
    await getDb().run('UPDATE bin_dispatch SET next_attempt_at = ? WHERE bin_id = ?', [passed, binId]);

    const result = await dispatchTick({ burst: 4, projectIds: [fixture.project.id] });
    expect(result.fired).toBe(1);
    expect(fires).toBe(1);
    const intents = await listDispatchesForBin(binId);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.state).toBe('SENT');
  });
});

describe('a claimable bin out of attempts', () => {
  it('gets no intent, and one event names ATTEMPTS_EXHAUSTED', async () => {
    const binId = await readyFactoryBin('exhausted');
    await getDb().run('UPDATE bins SET attempt_count = max_attempts WHERE id = ?', [binId]);

    await dispatchTick({ burst: 4, projectIds: [fixture.project.id] });
    await dispatchTick({ burst: 4, projectIds: [fixture.project.id] });

    expect(await listDispatchesForBin(binId)).toHaveLength(0);
    expect(fires).toBe(0);
    const named = (await listBinEvents(binId)).filter(
      (e) => e.eventType === 'DISPATCH_UNROUTED' && e.outcome === 'ATTEMPTS_EXHAUSTED',
    );
    // Once per generation, not once per tick.
    expect(named).toHaveLength(1);
    expect(named[0]!.leaseGeneration).toBe((await getBin(binId))!.leaseGeneration);
  });
});

describe('the held-bin query', () => {
  it('composes the dispatcher’s own fragments rather than restating them', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../server/repos/bins.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function listHeldBinHeads');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('${DISPATCHABLE_SQL}');
    expect(body).toContain('${FIREABLE_SQL}');
    expect(body).toContain("${workReadySql('bins.')}");
    expect(body).toContain("${claimableStateSql('')}");
    // Restated predicates would read the columns directly.
    expect(body).not.toMatch(/attempt_count\s*</);
    expect(body).not.toMatch(/dispatch_not_before\s*(<=|IS NULL)/);
    // Positional parameters only, valid in both dialects.
    expect(body).not.toMatch(/\$\d/);
  });
});
