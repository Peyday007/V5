/**
 * Idle capacity beside executable work, reproduced and closed
 * (ORIGINATED:IDLE_CAPACITY:engineering-watchdog, attempt 2).
 *
 * The recorded class: "1 executable item(s), 13 eligible surface(s), 0 active
 * against a target of 12: capacity is unexplainedly idle", in 181 of 144
 * ten-minute windows, with the dispatch pass the watchdog asked for firing
 * nothing. A bin whose one intent was deferred because every surface was at its
 * target keeps waiting out that timestamp after the fleet drains; the bin reads
 * executable and the pass has nothing due.
 *
 * Held here: the reading names that bin as held by its deferral rather than
 * counting it as fireable; a pass asked to conserve work makes it due and fires
 * it; and every deliberate hold — a rate limit's retry time, a paused fleet, an
 * operator wait, the refire guard, an audit session — is left where it is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker, setPolicy } from '../server/repos/fleet.ts';
import {
  createBin,
  ensureDispatchIntent,
  getBin,
  listBinEvents,
  listDispatchesForBin,
  markDispatchDeferred,
} from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import {
  CAPACITY_ENDED_REFUSALS,
  dispatchReadiness,
  pullForwardCapacityDeferred,
} from '../server/services/dispatch/conservation.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { getDb } from '../server/db/database.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let accountId = '';
let fires = 0;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const suffix = Math.random().toString(36).slice(2, 8);
  const account = await createAccount({ provider: 'anthropic', name: `conserve-${suffix}` });
  accountId = account.id;
  const worker = await createWorker({ name: `conserve-worker-${suffix}`, createdByType: 'SYSTEM', createdById: 'test' });
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
    routineRef: `trig_conserve_${suffix}`,
    name: 'conserve-routine',
    tokenSecretName: 'CONSERVE_TEST_SECRET',
  });
  await bindRoutineWorker(routine.id, worker.id);
  process.env['CONSERVE_TEST_SECRET'] = 'not-a-real-token';
  fires = 0;
  resetNetworkBlockCache();
  globalThis.fetch = (async () => {
    fires += 1;
    return new Response(JSON.stringify({ claude_code_session_id: `cse_conserve_${fires}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['CONSERVE_TEST_SECRET'];
  resetNetworkBlockCache();
});

function manifest(): BinManifest {
  return {
    objective: 'Prove free capacity ends a capacity wait.',
    why: 'Idle capacity beside executable work is a fault.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'unit-1', establishes: 'one value', input: 'a value', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a stored value'],
    outputs: ['one unit result'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a verified result'],
  };
}

async function readyBin(): Promise<string> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'A bin deferred while the fleet was full',
    objective: 'Prove it fires once a surface is free',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return bin.id;
}

/** Brain's own writer, as the tick calls it when routing refused for `refusal`. */
async function deferOn(binId: string, refusal: string, retryAfterMs = 10 * 60_000): Promise<string> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = (await listDispatchesForBin(binId)).find((d) => d.leaseGeneration === bin.leaseGeneration)!;
  await markDispatchDeferred(intent.id, { refusal, message: `deferred on ${refusal}`, retryAfterMs });
  return intent.id;
}

describe('the recorded idle class', () => {
  it('reads a capacity-deferred bin as held, and an unconserving pass fires nothing for it', async () => {
    const binId = await readyBin();
    await deferOn(binId, 'ACCOUNT_TARGETS_REACHED');

    const readiness = await dispatchReadiness();
    expect(readiness.executable.map((one) => one.binId)).not.toContain(binId);
    const hold = readiness.held.find((one) => one.binId === binId);
    expect(hold?.kind).toBe('DEFERRED');
    expect(hold?.cause).toBe('ACCOUNT_TARGETS_REACHED');

    // The failure: a free surface, the ordinary pass, and nothing sent.
    const tick = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(tick.fired).toBe(0);
    expect(fires).toBe(0);
  });

  it('is fired by a conserving pass once a surface is free', async () => {
    const binId = await readyBin();
    await deferOn(binId, 'ACCOUNT_TARGETS_REACHED');
    await deferOn(await readyBin(), 'FLEET_TARGET_REACHED');

    const tick = await dispatchTick({ burst: 4, projectIds: [projectId], conserve: true });
    expect(tick.conserved).toBe(2);
    expect(tick.fired).toBeGreaterThanOrEqual(1);
    expect(fires).toBeGreaterThanOrEqual(1);
    const events = await listBinEvents(binId);
    expect(events.some((e) => e.eventType === 'DISPATCH_CONSERVED')).toBe(true);
    // A pulled intent was claimed and fired, never charged as a failure.
    const intent = (await listDispatchesForBin(binId))[0]!;
    expect(intent.state).not.toBe('ABANDONED');
  });

  it('leaves every deliberate hold where it is', async () => {
    const held: Record<string, string> = {};
    for (const refusal of [
      'ALL_SURFACES_RATE_LIMITED',
      'FLEET_PAUSED',
      'ACCOUNT_SESSIONS_UNPRODUCTIVE',
      'NO_SURFACE_SERVES_THIS_PROJECT',
      'NO_ELIGIBLE_AUDIT_SESSION',
      'BIN_REFIRE_GUARD',
    ]) {
      const binId = await readyBin();
      held[binId] = await deferOn(binId, refusal);
    }
    const before = new Map(
      (await getDb().all<{ id: string; next_attempt_at: string }>('SELECT id, next_attempt_at FROM bin_dispatch')).map(
        (row) => [row.id, row.next_attempt_at],
      ),
    );

    const tick = await dispatchTick({ burst: 4, projectIds: [projectId], conserve: true });
    expect(tick.conserved).toBe(0);
    expect(tick.fired).toBe(0);
    expect(fires).toBe(0);
    for (const intentId of Object.values(held)) {
      const row = await getDb().get<{ next_attempt_at: string }>('SELECT next_attempt_at FROM bin_dispatch WHERE id = ?', [
        intentId,
      ]);
      expect(row?.next_attempt_at).toBe(before.get(intentId));
    }
    const readiness = await dispatchReadiness();
    for (const binId of Object.keys(held)) {
      expect(readiness.held.find((one) => one.binId === binId)?.kind).toBe('DEFERRED');
    }
  });

  it('ends only as many capacity waits as there is free capacity', async () => {
    // One free slot (the account's target is 1, nothing in flight) and three
    // intents deferred because the account was at its target. Asked against the
    // snapshot unchanged, every one of them routed and all three were made due.
    await setPolicy({ scope: 'ACCOUNT', scopeId: accountId, target: 1, actor: 'test', reason: 'one slot' });
    const intents: string[] = [];
    for (let i = 0; i < 3; i += 1) intents.push(await deferOn(await readyBin(), 'ACCOUNT_TARGETS_REACHED'));

    const tick = await dispatchTick({ burst: 4, projectIds: [projectId], conserve: true });
    expect(tick.conserved).toBe(1);
    expect(fires).toBeLessThanOrEqual(1);
    const stillDeferred = [];
    for (const intentId of intents) {
      const row = await getDb().get<{ next_attempt_at: string | null; state: string }>(
        'SELECT next_attempt_at, state FROM bin_dispatch WHERE id = ?',
        [intentId],
      );
      if (row?.state === 'PENDING' && row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.now()) {
        stillDeferred.push(intentId);
      }
    }
    expect(stillDeferred).toHaveLength(2);
  });

  it('does not pull forward a capacity deferral the router still refuses', async () => {
    const binId = await readyBin();
    const intentId = await deferOn(binId, 'ACCOUNT_TARGETS_REACHED');
    const pulled = await pullForwardCapacityDeferred({ routesNow: () => false });
    expect(pulled).toEqual([]);
    const row = await getDb().get<{ next_attempt_at: string }>('SELECT next_attempt_at FROM bin_dispatch WHERE id = ?', [
      intentId,
    ]);
    expect(Date.parse(row!.next_attempt_at)).toBeGreaterThan(Date.now());
  });

  it('only capacity targets are ended by free capacity', () => {
    expect([...CAPACITY_ENDED_REFUSALS].sort()).toEqual(['ACCOUNT_TARGETS_REACHED', 'FLEET_TARGET_REACHED']);
  });
});

describe('one predicate for executable work', () => {
  it('partitions every dispatchable, fireable, work-ready bin into fireable now or held', async () => {
    const fresh = await readyBin(); // no intent yet: the tick creates and claims one
    const due = await readyBin();
    const dueBin = (await getBin(due))!;
    await ensureDispatchIntent(dueBin); // PENDING, due now
    const deferred = await readyBin();
    await deferOn(deferred, 'ACCOUNT_TARGETS_REACHED');
    const sent = await readyBin();
    const sentIntent = await deferOn(sent, 'ACCOUNT_TARGETS_REACHED');
    // As `markDispatchSent` writes it: a SENT intent always carries its send time.
    await getDb().run("UPDATE bin_dispatch SET state = 'SENT', sent_at = ? WHERE id = ?", [
      new Date().toISOString(),
      sentIntent,
    ]);
    const abandoned = await readyBin();
    const abandonedIntent = await deferOn(abandoned, 'ACCOUNT_TARGETS_REACHED');
    await getDb().run("UPDATE bin_dispatch SET state = 'ABANDONED', last_error_kind = 'SERVER' WHERE id = ?", [
      abandonedIntent,
    ]);

    const readiness = await dispatchReadiness();
    const executable = new Set(readiness.executable.map((one) => one.binId));
    const held = new Map(readiness.held.map((one) => [one.binId, one.kind]));
    expect(executable.has(fresh)).toBe(true);
    expect(executable.has(due)).toBe(true);
    expect(held.get(deferred)).toBe('DEFERRED');
    expect(held.get(sent)).toBe('SENT_AWAITING_ARRIVAL');
    expect(held.get(abandoned)).toBe('ABANDONED');

    // A partition: every bin the dispatcher may fire is in exactly one side.
    const now = new Date().toISOString();
    const { DISPATCHABLE_SQL, FIREABLE_SQL, workReadySql } = await import('../server/repos/bins.ts');
    const all = await getDb().all<{ id: string }>(
      `SELECT bins.id AS id FROM bins WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')}`,
      [now, now, now, now],
    );
    for (const { id } of all) {
      expect(Number(executable.has(id)) + Number(held.has(id))).toBe(1);
    }
    expect(executable.size + held.size).toBe(all.length);
  });
});
