/**
 * A bin handed back for want of claimable work must not start another session.
 *
 * Production, 2026-10-17 (docs/FRIEND-ACCOUNT-USAGE-AUDIT-2026-10-17.md): the
 * VJN.com research packet held only work its dependencies or a backoff kept
 * unclaimable. Each fired session checked in, was handed the bin, found nothing
 * to claim and released it; the release advanced the generation, the new
 * generation earned a new dispatch intent, and the intent fired another of a
 * friend's Claude sessions. Five sessions in a row, 5,615 hand-backs in a week.
 *
 * These tests reproduce that shape and hold each part of the fix:
 *   - no intent and no fire while nothing in the bin is claimable;
 *   - a hand-back preserves the bin, its attempts and its work;
 *   - the moment an item becomes claimable the bin fires by itself;
 *   - a bin fired repeatedly in a short window is cooled off, not fired again;
 *   - an account past its hourly activation budget is not fired;
 *   - a Routine whose sessions cannot reach the web is not fired for research;
 *   - a fired session that never arrives is counted, but not during an outage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker, setPolicy } from '../server/repos/fleet.ts';
import { unarrivedOwnFiresByRoutine } from '../server/repos/fleet.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  assignNextBin,
  BIN_REFIRE_LIMIT,
  createBin,
  getBin,
  listDispatchesForBin,
  releaseBin,
} from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import {
  networkBlockedRoutines,
  resetNetworkBlockCache,
  accountActivationBudget,
} from '../server/services/dispatch/candidates.ts';
import { getDb } from '../server/db/database.ts';
import { newId } from '../server/repos/util.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let workerId = '';
let accountId = '';
let routineId = '';
let fires = 0;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  const account = await createAccount({ provider: 'anthropic', name: `loop-${Math.random().toString(36).slice(2, 8)}` });
  accountId = account.id;
  const worker = await createWorker({
    name: `loop-worker-${Math.random().toString(36).slice(2, 8)}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'research:write'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_loop_${Math.random().toString(36).slice(2, 8)}`,
    name: 'loop-routine',
    tokenSecretName: 'LOOP_TEST_SECRET',
  });
  routineId = routine.id;
  await bindRoutineWorker(routine.id, worker.id);
  process.env['LOOP_TEST_SECRET'] = 'not-a-real-token';
  fires = 0;
  resetNetworkBlockCache();
  globalThis.fetch = (async () => {
    fires += 1;
    return new Response(JSON.stringify({ claude_code_session_id: `cse_loop_${fires}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['LOOP_TEST_SECRET'];
  resetNetworkBlockCache();
});

function manifest(): BinManifest {
  return {
    objective: 'Research a packet',
    why: 'A research bin.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['claims'],
    outputs: ['a filed report'],
    authorizedActions: ['research'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is filed'],
  };
}

async function packet(status = 'RESEARCHING'): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a research question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'VJN.com-shaped packet',
    assignment: 'research it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await updateOrchestration(orchestration.id, {
    status: status as Parameters<typeof updateOrchestration>[1]['status'],
  });
  return orchestration.id;
}

async function researchBin(orchestrationId: string, maxAttempts = 5): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'a research packet',
    objective: 'research it',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts,
  });
  return bin.id;
}

async function itemAvailableAt(orchestrationId: string, availableAt: string): Promise<string> {
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_FRAGMENT',
    orchestrationId,
    availableAt,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  return item.id;
}

const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();
const aMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();

describe('a research bin with nothing claimable', () => {
  it('earns no intent and starts no session however many ticks pass', async () => {
    const orchestrationId = await packet();
    const binId = await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, inAnHour());

    for (let tick = 0; tick < 6; tick += 1) {
      const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
      expect(result.intentsCreated).toBe(0);
      expect(result.fired).toBe(0);
    }
    expect(fires).toBe(0);
    expect(await listDispatchesForBin(binId)).toHaveLength(0);
  });

  it('keeps its work and attempts when a session hands it back, and does not refire', async () => {
    const orchestrationId = await packet();
    const binId = await researchBin(orchestrationId);
    const itemId = await itemAvailableAt(orchestrationId, inAnHour());

    // The production cycle: a session arrives, is handed the bin, finds nothing, releases.
    const assigned = (await assignNextBin({ workerId, projectIds: [projectId] }))!;
    expect(assigned.bin.id).toBe(binId);
    const before = (await getBin(binId))!;
    expect(
      await releaseBin(
        { binId, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
        'no claimable work',
      ),
    ).toBe("OK");
    const after = (await getBin(binId))!;
    expect(after.state).toBe('READY');
    expect(after.leaseGeneration).toBe(before.leaseGeneration + 1);
    expect(after.attemptCount).toBe(before.attemptCount);
    const item = await getDb().get<{ state: string }>('SELECT state FROM work_items WHERE id = ?', [itemId]);
    expect(item?.state).toBe('QUEUED');

    // The new generation must not buy another session.
    for (let tick = 0; tick < 4; tick += 1) {
      const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
      expect(result.fired).toBe(0);
    }
    expect(fires).toBe(0);
  });

  it('fires by itself the moment its blocker clears', async () => {
    const orchestrationId = await packet();
    const binId = await researchBin(orchestrationId);
    const itemId = await itemAvailableAt(orchestrationId, inAnHour());
    expect((await dispatchTick({ burst: 4, projectIds: [projectId] })).fired).toBe(0);

    await getDb().run('UPDATE work_items SET available_at = ? WHERE id = ?', [aMinuteAgo(), itemId]);
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.intentsCreated).toBe(1);
    expect(result.fired).toBe(1);
    expect(fires).toBe(1);
    const dispatches = await listDispatchesForBin(binId);
    expect(dispatches.some((one) => one.state === 'SENT')).toBe(true);
  });

  it('still fires a filed packet with nothing open, so a session can close the bin', async () => {
    const orchestrationId = await packet('COMPLETE');
    await researchBin(orchestrationId);
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(1);
  });
});

describe('a healthy bin', () => {
  it('with claimable work is fired and handed to the arriving worker', async () => {
    const orchestrationId = await packet();
    const binId = await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    expect((await dispatchTick({ burst: 4, projectIds: [projectId] })).fired).toBe(1);
    const assigned = await assignNextBin({ workerId, projectIds: [projectId] });
    expect(assigned?.bin.id).toBe(binId);
    // The lease still excludes a second worker.
    const other = await createWorker({ name: `other-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 'test' });
    await grantMembership({
      projectId,
      principalType: 'WORKER',
      principalId: other.id,
      role: 'MEMBER',
      scopes: ['project:read', 'queue:claim', 'research:write'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    expect(await assignNextBin({ workerId: other.id, projectIds: [projectId] })).toBeNull();
  });
});

describe('repeated fires at one bin', () => {
  it('are cooled off after the limit rather than fired again', async () => {
    const orchestrationId = await packet();
    const binId = await researchBin(orchestrationId, 20);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    // Three recent sessions already started for this bin at earlier generations.
    const now = new Date().toISOString();
    for (let gen = 0; gen < BIN_REFIRE_LIMIT; gen += 1) {
      await getDb().run(
        `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
           next_attempt_at, routine_id, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, 'SENT', 1, 5, ?, ?, ?, ?, ?)`,
        [newId('bdi'), binId, gen, now, null, now, now, now],
      );
    }
    await getDb().run('UPDATE bins SET lease_generation = ? WHERE id = ?', [BIN_REFIRE_LIMIT, binId]);

    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(fires).toBe(0);
    const bin = (await getBin(binId))!;
    expect(bin.state).toBe('READY');
    expect(Date.parse(bin.dispatchNotBefore ?? '')).toBeGreaterThan(Date.now());
    const deferred = (await listDispatchesForBin(binId)).find((one) => one.leaseGeneration === BIN_REFIRE_LIMIT);
    expect(deferred?.lastErrorKind).toBe('BIN_REFIRE_GUARD');
  });
});

describe("an account's hourly activation budget", () => {
  it('stops firing once the budget of sessions has started', async () => {
    await setPolicy({ scope: 'ACCOUNT', scopeId: accountId, target: 3, actor: 'test', reason: 'cap' });
    const budget = accountActivationBudget(3);
    // Outside the in-flight window, so only the hourly budget can refuse.
    const now = new Date(Date.now() - 45 * 60_000).toISOString();
    for (let index = 0; index < budget; index += 1) {
      const done = await createBin({
        projectId,
        kind: 'RESEARCH_PACKET',
        title: `done ${index}`,
        objective: 'done',
        manifest: manifest(),
        completionContract: 'RESEARCH_PACKET_V1',
        createdByType: 'SYSTEM',
        createdById: 'test',
        ready: false,
      });
      await getDb().run("UPDATE bins SET state = 'COMPLETE' WHERE id = ?", [done.id]);
      await getDb().run(
        `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
           next_attempt_at, routine_id, created_at, updated_at, sent_at)
         VALUES (?, ?, 0, 'SENT', 1, 5, ?, ?, ?, ?, ?)`,
        [newId('bdi'), done.id, now, routineId, now, now, now],
      );
    }
    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(result.unrouted['ACCOUNT_TARGETS_REACHED']).toBe(1);
    expect(fires).toBe(0);
  });
});

async function blockedFragment(orchestrationId: string, index: number, reason: string, status = 'BLOCKED'): Promise<void> {
  const now = new Date().toISOString();
  const fragmentId = newId('frg');
  await getDb().run(
    `INSERT INTO research_fragments (id, orchestration_id, project_id, layer_id, fragment_index,
       fragment_key, question, status, blocked_reason, accepted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fragmentId,
      orchestrationId,
      projectId,
      layerId,
      index,
      `f${index}`,
      'a question',
      status,
      status === 'BLOCKED' ? reason : null,
      status === 'ACCEPTED' ? now : null,
      now,
      now,
    ],
  );
  await getDb().run(
    `INSERT INTO research_passes (id, orchestration_id, fragment_id, pass_key, ordinal, provider,
       prompt, prompt_sha256, started_at, executor_routine_id)
     VALUES (?, ?, ?, 'FRAGMENT', ?, 'WORKER', 'p', 'h', ?, ?)`,
    [newId('rps'), orchestrationId, fragmentId, index, now, routineId],
  );
}

describe('a Routine whose sessions cannot reach the web', () => {
  it('is not fired for research after repeated network blocks', async () => {
    const orchestrationId = await packet();
    for (let index = 0; index < 3; index += 1) {
      await blockedFragment(orchestrationId, index, 'No network egress to source hosts (ENOTFOUND)');
    }
    expect((await networkBlockedRoutines(Date.now())).has(routineId)).toBe(true);
    resetNetworkBlockCache();

    const other = await packet();
    await researchBin(other);
    await itemAvailableAt(other, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(result.unrouted['NO_SURFACE_SERVES_THIS_FAMILY']).toBe(1);
    expect(fires).toBe(0);
  });

  it('is eligible again once one of its fragments is accepted', async () => {
    const orchestrationId = await packet();
    for (let index = 0; index < 3; index += 1) {
      await blockedFragment(orchestrationId, index, 'getaddrinfo ENOTFOUND example.org');
    }
    await blockedFragment(orchestrationId, 9, '', 'ACCEPTED');
    expect((await networkBlockedRoutines(Date.now())).has(routineId)).toBe(false);
  });
});

async function event(type: string, at: string, sessionRef: string, routine: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, session_ref, routine_id, measures)
     VALUES (?, ?, ?, ?, ?, '{}')`,
    [newId('bev'), type, at, sessionRef, routine],
  );
}

describe('a fired session that never arrives', () => {
  it('counts against its Routine when other sessions were arriving', async () => {
    const fired = new Date(Date.now() - 45 * 60_000).toISOString();
    await event('DISPATCH_SENT', fired, 'cse_never', routineId);
    // Somebody else's session arrived inside the window, so Brain was answering.
    await event('DISPATCH_SESSION_ARRIVED', new Date(Date.now() - 40 * 60_000).toISOString(), 'cse_other', null);
    expect((await unarrivedOwnFiresByRoutine()).get(routineId)).toBe(1);
  });

  it('is not counted when nothing arrived anywhere, which is an outage rather than a no-show', async () => {
    const fired = new Date(Date.now() - 45 * 60_000).toISOString();
    await event('DISPATCH_SENT', fired, 'cse_never', routineId);
    expect((await unarrivedOwnFiresByRoutine()).get(routineId) ?? 0).toBe(0);
  });

  it('is not counted once its own session arrived', async () => {
    const fired = new Date(Date.now() - 45 * 60_000).toISOString();
    await event('DISPATCH_SENT', fired, 'cse_came', routineId);
    await event('DISPATCH_SESSION_ARRIVED', new Date(Date.now() - 44 * 60_000).toISOString(), 'cse_came', routineId);
    expect((await unarrivedOwnFiresByRoutine()).get(routineId) ?? 0).toBe(0);
  });
});
