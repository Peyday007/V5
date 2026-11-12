/**
 * An executable bin whose only intent gave up is fired again, boundedly.
 *
 * ORIGINATED:IDLE_CAPACITY:engineering-watchdog — the watchdog recorded idle
 * capacity beside executable work in 126 of 144 ten-minute windows: "FACTORY:
 * 1 piece(s) of executable work and 2 free surface(s), and nothing is running
 * or arriving", "ROUTINES: 1 executable item(s), 14 eligible surface(s)". The
 * dispatch pass it asked for each time had nothing to send, because the bin's
 * one intent per (bin, generation) was `ABANDONED` after charged fire
 * failures, and nothing but a no-show abandonment was ever revived.
 *
 * These tests reproduce that state — a READY bin with attempts left, a free
 * surface, an abandoned intent, and the watchdog reading idle while the tick
 * fires nothing — and hold the fix: after the cool-off the tick re-arms the
 * intent and fires, and every bound still holds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker } from '../server/repos/fleet.ts';
import { createBin, ensureDispatchIntent, getBin, listBinEvents, listDispatchesForBin } from '../server/repos/bins.ts';
import { dispatchTick } from '../server/services/dispatch/loop.ts';
import {
  rearmStrandedIntents,
  STRANDED_REARM_AFTER_MS,
  STRANDED_REARM_CEILING,
} from '../server/services/dispatch/rearm.ts';
import { watchIdle } from '../server/services/engineering/watchdog.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { getDb } from '../server/db/database.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let fires = 0;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const account = await createAccount({ provider: 'anthropic', name: `rearm-${Math.random().toString(36).slice(2, 8)}` });
  const worker = await createWorker({
    name: `rearm-worker-${Math.random().toString(36).slice(2, 8)}`,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
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
    routineRef: `trig_rearm_${Math.random().toString(36).slice(2, 8)}`,
    name: 'rearm-routine',
    tokenSecretName: 'REARM_TEST_SECRET',
  });
  await bindRoutineWorker(routine.id, worker.id);
  process.env['REARM_TEST_SECRET'] = 'not-a-real-token';
  fires = 0;
  resetNetworkBlockCache();
  globalThis.fetch = (async () => {
    fires += 1;
    return new Response(JSON.stringify({ claude_code_session_id: `cse_rearm_${fires}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['REARM_TEST_SECRET'];
  resetNetworkBlockCache();
});

function manifest(): BinManifest {
  return {
    objective: 'Prove a stranded bin fires again.',
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
    title: 'A bin whose only intent gave up',
    objective: 'Prove it fires again',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  return bin.id;
}

/** The production state: the intent at the bin's generation spent its charged fires and gave up. */
async function abandon(
  binId: string,
  input: { agoMs: number; kind?: string; maxAttempts?: number; state?: string } = { agoMs: 0 },
): Promise<string> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = (await listDispatchesForBin(binId)).find((d) => d.leaseGeneration === bin.leaseGeneration)!;
  const at = new Date(Date.now() - input.agoMs).toISOString();
  const max = input.maxAttempts ?? 5;
  await getDb().run(
    `UPDATE bin_dispatch SET state = ?, attempt_count = ?, max_attempts = ?, last_error_kind = ?,
        last_error = 'five charged failures', next_attempt_at = ?, updated_at = ? WHERE id = ?`,
    [input.state ?? 'ABANDONED', max, max, input.kind ?? 'SERVER', at, at, intent.id],
  );
  return intent.id;
}

const pastCoolOff = STRANDED_REARM_AFTER_MS + 60_000;

describe('a READY bin whose only intent was abandoned', () => {
  it('reproduces the idle class: executable work, a free surface, and the tick fires nothing', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: 60_000 });

    const tick = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(tick.intentsCreated).toBe(0);
    expect(tick.fired).toBe(0);
    expect(fires).toBe(0);

    const reading = await watchIdle({ continueWork: false });
    expect(reading.executableWork).toBeGreaterThanOrEqual(1);
    expect(reading.eligibleCapacity).toBeGreaterThanOrEqual(1);
    expect(reading.idle).toBe(true);
  });

  it('is re-armed after the cool-off and fired by the ordinary tick', async () => {
    const binId = await readyBin();
    const dispatchId = await abandon(binId, { agoMs: pastCoolOff });

    const tick = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(tick.revivedStranded).toBe(1);
    expect(tick.fired).toBe(1);
    expect(fires).toBe(1);

    const intent = (await listDispatchesForBin(binId)).find((d) => d.id === dispatchId)!;
    expect(intent.state).toBe('SENT');
    // Raised, never reset: the history of what was charged stays readable.
    expect(intent.maxAttempts).toBe(10);
    const events = await listBinEvents(binId);
    expect(events.some((e) => e.eventType === 'DISPATCH_REARMED')).toBe(true);
  });

  it('re-arms once when two dispatchers ask at the same moment', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: pastCoolOff });
    const [a, b] = await Promise.all([rearmStrandedIntents(20), rearmStrandedIntents(20)]);
    expect(a.length + b.length).toBe(1);
  });
});

describe('what is never re-armed', () => {
  it('an intent abandoned inside the cool-off', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: 60_000 });
    expect(await rearmStrandedIntents(20)).toHaveLength(0);
  });

  it('a bin out of attempts of its own', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: pastCoolOff });
    await getDb().run('UPDATE bins SET attempt_count = max_attempts WHERE id = ?', [binId]);
    expect(await rearmStrandedIntents(20)).toHaveLength(0);
  });

  it('a bin whose fires are backed off', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: pastCoolOff });
    await getDb().run('UPDATE bins SET dispatch_not_before = ? WHERE id = ?', [
      new Date(Date.now() + 60 * 60_000).toISOString(),
      binId,
    ]);
    expect(await rearmStrandedIntents(20)).toHaveLength(0);
  });

  it('an intent that was sent rather than abandoned', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: pastCoolOff, state: 'SENT' });
    expect(await rearmStrandedIntents(20)).toHaveLength(0);
  });

  it('a no-show abandonment, which its own revival owns', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: pastCoolOff, kind: 'NO_SHOW' });
    expect(await rearmStrandedIntents(20)).toHaveLength(0);
  });

  it('an intent already at the ceiling', async () => {
    const binId = await readyBin();
    await abandon(binId, { agoMs: pastCoolOff, maxAttempts: STRANDED_REARM_CEILING });
    expect(await rearmStrandedIntents(20)).toHaveLength(0);
  });
});

describe('an abandonment whose cause will repeat', () => {
  // The fixture's fleet was written moments ago; in production the abandonment
  // came after the fleet's last write, so put the fleet's writes before it.
  beforeEach(async () => {
    const earlier = new Date(Date.now() - pastCoolOff - 60 * 60_000).toISOString();
    for (const table of ['fleet_routines', 'worker_routing', 'project_memberships']) {
      await getDb().run(`UPDATE ${table} SET updated_at = ?`, [earlier]);
    }
  });

  it('is not re-armed on the clock alone: a surface that refuses every fire is not asked again', async () => {
    for (const kind of ['AUTH', 'NOT_FOUND', 'PAUSED', 'NOT_CONFIGURED']) {
      const binId = await readyBin();
      await abandon(binId, { agoMs: pastCoolOff, kind });
      const rearmed = await rearmStrandedIntents(20);
      expect(rearmed.map((r) => r.binId)).not.toContain(binId);
    }
    const tick = await dispatchTick({ burst: 4, projectIds: [projectId] });
    expect(tick.revivedStranded).toBe(0);
    expect(fires).toBe(0);
  });

  it('is re-armed once the fleet has been written since it was abandoned', async () => {
    const binId = await readyBin();
    const dispatchId = await abandon(binId, { agoMs: pastCoolOff, kind: 'AUTH' });
    expect(await rearmStrandedIntents(20)).toHaveLength(0);

    // A person corrects the surface: any write to the fleet after the abandonment.
    await getDb().run('UPDATE fleet_routines SET updated_at = ?', [new Date().toISOString()]);

    const rearmed = await rearmStrandedIntents(20);
    expect(rearmed.map((r) => r.dispatchId)).toEqual([dispatchId]);
    expect(rearmed[0]!.previousErrorKind).toBe('AUTH');
  });

  it('a transient failure is still re-armed without any fleet write', async () => {
    for (const kind of ['SERVER', 'NETWORK', 'RATE_LIMIT', 'SUPERSEDED']) {
      const binId = await readyBin();
      await abandon(binId, { agoMs: pastCoolOff, kind });
      const rearmed = await rearmStrandedIntents(20);
      expect(rearmed.map((r) => r.binId)).toContain(binId);
    }
  });
});
