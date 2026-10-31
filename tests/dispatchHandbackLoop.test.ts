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
 *   - an account whose recent sessions did no work is not fired, and one whose
 *     sessions are productive is never refused for how many it started;
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
  classifyStart,
  productivityByAccount,
  resetProductivityCache,
  ARRIVAL_SETTLE_MS,
  UNPRODUCTIVE_STARTS_THRESHOLD,
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

/** A finished bin with one SENT fire at `sentAt`, as a session that started for it. */
async function pastFire(input: { sentAt: string; session: string; generation?: number }): Promise<string> {
  const done = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: `past ${input.session}`,
    objective: 'done',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: false,
  });
  const generation = input.generation ?? 0;
  await getDb().run("UPDATE bins SET state = 'COMPLETE', lease_generation = ? WHERE id = ?", [
    generation + 1,
    done.id,
  ]);
  await getDb().run(
    `INSERT INTO bin_dispatch (id, bin_id, lease_generation, state, attempt_count, max_attempts,
       next_attempt_at, routine_id, session_ref, created_at, updated_at, sent_at)
     VALUES (?, ?, ?, 'SENT', 1, 5, ?, ?, ?, ?, ?, ?)`,
    [newId('bdi'), done.id, generation, input.sentAt, routineId, input.session, input.sentAt, input.sentAt, input.sentAt],
  );
  return done.id;
}

async function binEvent(input: {
  type: string;
  at: string;
  binId?: string | null;
  generation?: number | null;
  session?: string | null;
  outcome?: string | null;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO bin_events (id, event_type, at, bin_id, lease_generation, session_ref, outcome, measures)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
    [
      newId('bev'),
      input.type,
      input.at,
      input.binId ?? null,
      input.generation ?? null,
      input.session ?? null,
      input.outcome ?? null,
    ],
  );
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe('the adaptive account control: only unproductive starts count', () => {
  beforeEach(() => resetProductivityCache());

  it('classifies a start from what its session did, and judges no outage', () => {
    const now = Date.now();
    const old = now - ARRIVAL_SETTLE_MS - 60_000;
    const base = { sentAtMs: old, nowMs: now, arrived: true, brainAnswering: true };
    expect(classifyStart({ ...base, leases: [{ productive: true, live: false }] })).toBe('PRODUCTIVE');
    expect(classifyStart({ ...base, leases: [{ productive: false, live: true }] })).toBe('PENDING');
    expect(classifyStart({ ...base, leases: [{ productive: false, live: false }] })).toBe('UNPRODUCTIVE_NO_WORK');
    // Brain handed the session nothing it could do: not the account's failure.
    expect(classifyStart({ ...base, leases: [{ productive: false, live: false, withheldByBrain: true }] })).toBe('NOT_JUDGED');
    expect(
      classifyStart({ ...base, leases: [{ productive: false, live: false, withheldByBrain: true }, { productive: false, live: false }] }),
    ).toBe('UNPRODUCTIVE_NO_WORK');
    expect(classifyStart({ ...base, leases: [{ productive: true, live: false, withheldByBrain: true }] })).toBe('PRODUCTIVE');
    expect(classifyStart({ ...base, leases: [] })).toBe('UNPRODUCTIVE_NO_WORK');
    expect(classifyStart({ ...base, arrived: false, leases: [] })).toBe('UNPRODUCTIVE_NEVER_ARRIVED');
    // Nothing arrived from anywhere: Brain's outage, charged to nobody.
    expect(classifyStart({ ...base, arrived: false, brainAnswering: false, leases: [] })).toBe('NOT_JUDGED');
    // Too recent to judge.
    expect(classifyStart({ ...base, sentAtMs: now - 60_000, arrived: false, leases: [] })).toBe('PENDING');
  });

  it('refuses an account whose sessions repeatedly never arrived', async () => {
    for (let index = 0; index < UNPRODUCTIVE_STARTS_THRESHOLD; index += 1) {
      const sent = minutesAgo(40 - index);
      await pastFire({ sentAt: sent, session: `cse_never_${index}` });
      // Somebody else's session arrived inside its window, so Brain was answering.
      await binEvent({ type: 'DISPATCH_SESSION_ARRIVED', at: minutesAgo(38 - index), session: `cse_other_${index}` });
    }
    const counted = await productivityByAccount(Date.now(), new Map([[routineId, accountId]]));
    expect(counted.get(accountId)?.unproductive).toBe(UNPRODUCTIVE_STARTS_THRESHOLD);

    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(result.unrouted['ACCOUNT_SESSIONS_UNPRODUCTIVE']).toBe(1);
    expect(fires).toBe(0);
  });

  it('refuses an account whose sessions keep handing work back unclaimed', async () => {
    for (let index = 0; index < UNPRODUCTIVE_STARTS_THRESHOLD; index += 1) {
      const session = `cse_handback_${index}`;
      const binId = await pastFire({ sentAt: minutesAgo(10 + index), session });
      // It arrived, was handed the bin at the next generation, and the lease
      // ended (the bin moved on) without a claim.
      await binEvent({ type: 'BIN_ASSIGNED', at: minutesAgo(9 + index), binId, generation: 1, session: `claude-code-session_handback_${index}` });
      await binEvent({ type: 'BIN_RELEASED', at: minutesAgo(9 + index), binId, generation: 1 });
    }
    const counted = await productivityByAccount(Date.now(), new Map([[routineId, accountId]]));
    expect(counted.get(accountId)?.unproductive).toBe(UNPRODUCTIVE_STARTS_THRESHOLD);
    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(result.unrouted['ACCOUNT_SESSIONS_UNPRODUCTIVE']).toBe(1);
  });

  it('does not count a session Brain handed nothing it could do against its account', async () => {
    for (let index = 0; index < UNPRODUCTIVE_STARTS_THRESHOLD + 2; index += 1) {
      const session = `cse_withheld_${index}`;
      const binId = await pastFire({ sentAt: minutesAgo(10 + index), session });
      await binEvent({ type: 'BIN_ASSIGNED', at: minutesAgo(9 + index), binId, generation: 1, session });
      // Brain's own audit independence rule, or nothing claimable yet: the
      // session took the bin and Brain withheld the work, then handed it back.
      await binEvent({
        type: 'BIN_ITEM_WITHHELD',
        at: minutesAgo(9 + index),
        binId,
        generation: 1,
        outcome: index % 2 === 0 ? 'REFUSED_BY_ADMISSION' : 'NOT_CLAIMABLE',
      });
      await binEvent({ type: 'BIN_RELEASED', at: minutesAgo(9 + index), binId, generation: 1 });
    }
    const counted = await productivityByAccount(Date.now(), new Map([[routineId, accountId]]));
    expect(counted.get(accountId)?.unproductive ?? 0).toBe(0);
    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.unrouted['ACCOUNT_SESSIONS_UNPRODUCTIVE'] ?? 0).toBe(0);
  });

  it('never refuses an account for how many productive sessions it started', async () => {
    // Far more starts in the hour than the old fixed budget allowed (6 per slot).
    for (let index = 0; index < 20; index += 1) {
      const session = `cse_worked_${index}`;
      const binId = await pastFire({ sentAt: minutesAgo(50 - index), session });
      await binEvent({ type: 'BIN_ASSIGNED', at: minutesAgo(49 - index), binId, generation: 1, session });
      await binEvent({ type: 'BIN_ITEM_CLAIMED', at: minutesAgo(49 - index), binId, generation: 1 });
    }
    const counted = await productivityByAccount(Date.now(), new Map([[routineId, accountId]]));
    expect(counted.get(accountId)).toMatchObject({ productive: 20, unproductive: 0 });

    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(1);
    expect(result.unrouted['ACCOUNT_SESSIONS_UNPRODUCTIVE'] ?? 0).toBe(0);
  });

  it('does not count a fire during an outage, when nothing arrived from anywhere', async () => {
    for (let index = 0; index < UNPRODUCTIVE_STARTS_THRESHOLD + 2; index += 1) {
      await pastFire({ sentAt: minutesAgo(40 - index), session: `cse_outage_${index}` });
    }
    const counted = await productivityByAccount(Date.now(), new Map([[routineId, accountId]]));
    expect(counted.get(accountId)?.unproductive ?? 0).toBe(0);
    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    expect((await dispatchTick({ burst: 4, projectIds: [projectId] })).fired).toBe(1);
  });

  it('still honours a person-set account target for productive work', async () => {
    await setPolicy({ scope: 'ACCOUNT', scopeId: accountId, target: 1, actor: 'test', reason: 'cap' });
    // One live activation in flight on this account.
    const orchestrationId = await packet();
    await researchBin(orchestrationId);
    await itemAvailableAt(orchestrationId, aMinuteAgo());
    expect((await dispatchTick({ burst: 4, projectIds: [projectId] })).fired).toBe(1);
    const second = await packet();
    await researchBin(second);
    await itemAvailableAt(second, aMinuteAgo());
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(result.unrouted['ACCOUNT_TARGETS_REACHED']).toBe(1);
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

  it("recognises a session's own words for having no web, not only the error codes", async () => {
    const orchestrationId = await packet();
    const words = [
      "This session's environment refuses outbound web access, so no source could be opened.",
      'This surface has no outbound web access: DNS resolution fails for every host.',
      "This session's network environment refuses outbound connections to the source.",
    ];
    for (let index = 0; index < words.length; index += 1) await blockedFragment(orchestrationId, index, words[index]!);
    expect((await networkBlockedRoutines(Date.now())).has(routineId)).toBe(true);
  });

  it('takes a session at its word after one block when it says its whole network is refused', async () => {
    const orchestrationId = await packet();
    await blockedFragment(orchestrationId, 0, "This session's environment refuses outbound web access, so no source could be opened.");
    expect((await networkBlockedRoutines(Date.now())).has(routineId)).toBe(true);
  });

  it('does not take one missing host as a web-less surface', async () => {
    const orchestrationId = await packet();
    await blockedFragment(orchestrationId, 0, 'getaddrinfo ENOTFOUND gone-site.example');
    expect((await networkBlockedRoutines(Date.now())).has(routineId)).toBe(false);
  });

  it('is still fired for research that needs no sources: an audit, a synthesis', async () => {
    const orchestrationId = await packet();
    for (let index = 0; index < 3; index += 1) {
      await blockedFragment(orchestrationId, index, 'No network egress to source hosts (ENOTFOUND)');
    }
    resetNetworkBlockCache();

    const other = await packet();
    await researchBin(other);
    await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      orchestrationId: other,
      payload: { role: 'PRIMARY' },
      availableAt: aMinuteAgo(),
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(1);
    expect(fires).toBe(1);
  });

  it('is not fired for a bin whose open work mixes an audit with a fragment', async () => {
    const orchestrationId = await packet();
    for (let index = 0; index < 3; index += 1) {
      await blockedFragment(orchestrationId, index, 'No network egress to source hosts (ENOTFOUND)');
    }
    resetNetworkBlockCache();

    const other = await packet();
    await researchBin(other);
    await itemAvailableAt(other, aMinuteAgo());
    await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      orchestrationId: other,
      payload: { role: 'PRIMARY' },
      availableAt: aMinuteAgo(),
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const result = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(result.fired).toBe(0);
    expect(fires).toBe(0);
  });

  it('stays blocked past the six-hour burst while nothing it researched was accepted, and is retested after a day', async () => {
    const orchestrationId = await packet();
    for (let index = 0; index < 3; index += 1) {
      await blockedFragment(orchestrationId, index, 'No network egress to source hosts (ENOTFOUND)');
    }
    const hours = (n: number) => Date.now() + n * 60 * 60_000;
    resetNetworkBlockCache();
    expect((await networkBlockedRoutines(hours(12))).has(routineId)).toBe(true);
    resetNetworkBlockCache();
    expect((await networkBlockedRoutines(hours(25))).has(routineId)).toBe(false);
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
