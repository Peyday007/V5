/**
 * The watchdog counts idle capacity from the dispatcher's own answer, and the
 * pass it asks for ends a capacity wait (ORIGINATED:IDLE_CAPACITY:engineering-watchdog,
 * attempt 2).
 *
 * The recorded class: "ROUTINES: 1 executable item(s), 13 eligible surface(s),
 * 0 active against a target of 12: capacity is unexplainedly idle", in 181 of
 * 144 windows, each answered with a dispatch pass that fired nothing. Held
 * here: a bin deferred only because every surface was at its target is idle
 * capacity, the watchdog's pass fires it, and the next window records nothing;
 * a bin held by an operator wait is named as held rather than called idle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAccount, createRoutine, bindRoutineWorker } from '../server/repos/fleet.ts';
import { createBin, ensureDispatchIntent, getBin, listDispatchesForBin, markDispatchDeferred } from '../server/repos/bins.ts';
import { IDLE_RECORD_WINDOW_MS, watchIdle, watchUtilization } from '../server/services/engineering/watchdog.ts';
import { resetNetworkBlockCache } from '../server/services/dispatch/candidates.ts';
import { SENT_EXPLAINS_FOR_MS } from '../server/services/dispatch/conservation.ts';
import { getDb } from '../server/db/database.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let fires = 0;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const suffix = Math.random().toString(36).slice(2, 8);
  const account = await createAccount({ provider: 'anthropic', name: `wdc-${suffix}` });
  const worker = await createWorker({ name: `wdc-worker-${suffix}`, createdByType: 'SYSTEM', createdById: 'test' });
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
    routineRef: `trig_wdc_${suffix}`,
    name: 'wdc-routine',
    tokenSecretName: 'WDC_TEST_SECRET',
  });
  await bindRoutineWorker(routine.id, worker.id);
  process.env['WDC_TEST_SECRET'] = 'not-a-real-token';
  fires = 0;
  resetNetworkBlockCache();
  globalThis.fetch = (async () => {
    fires += 1;
    return new Response(JSON.stringify({ claude_code_session_id: `cse_wdc_${fires}` }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['WDC_TEST_SECRET'];
  resetNetworkBlockCache();
});

function manifest(): BinManifest {
  return {
    objective: 'Prove the watchdog feeds idle capacity.',
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

async function deferredBin(refusal: string): Promise<string> {
  const created = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'A bin deferred while the fleet was full',
    objective: 'Prove the watchdog feeds it',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const bin = (await getBin(created.id))!;
  await ensureDispatchIntent(bin);
  const intent = (await listDispatchesForBin(bin.id)).find((d) => d.leaseGeneration === bin.leaseGeneration)!;
  await markDispatchDeferred(intent.id, { refusal, message: `deferred on ${refusal}`, retryAfterMs: 10 * 60_000 });
  return bin.id;
}

async function routineIdleRows(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK' AND attempted_action LIKE 'ROUTINES:%'",
  );
  return Number(row?.n ?? 0);
}

describe('the recorded idle class, read and continued by the watchdog', () => {
  it('reads a capacity deferral beside a free surface as idle, fires it, and records nothing next window', async () => {
    await deferredBin('ACCOUNT_TARGETS_REACHED');

    const first = await watchUtilization({});
    const routines = first.pools.find((one) => one.pool === 'ROUTINES')!;
    expect(routines.waiting).toBe(1);
    expect(routines.idle).toBe(true);
    expect(first.recorded).toContain('ROUTINES');
    expect(first.continued).toContain('ROUTINES');
    // The pass the watchdog asked for sent the work; before, it found nothing due.
    expect(fires).toBeGreaterThanOrEqual(1);
    expect(await routineIdleRows()).toBe(1);

    // The next window: the bin's fire is out and awaiting its session — a wait,
    // not idle capacity — so no second fault is recorded.
    const later = new Date(Date.now() + IDLE_RECORD_WINDOW_MS + 60_000);
    const next = await watchUtilization({ continueWork: false, now: later });
    expect(next.pools.find((one) => one.pool === 'ROUTINES')!.idle).toBe(false);
    expect(next.recorded).not.toContain('ROUTINES');
    expect(await routineIdleRows()).toBe(1);
  });

  it('names an operator-wait deferral as held rather than calling capacity idle', async () => {
    await deferredBin('NO_SURFACE_SERVES_THIS_PROJECT');

    const reading = await watchIdle({ continueWork: false });
    expect(reading.executableWork).toBe(0);
    expect(reading.idle).toBe(false);
    expect(reading.reason).not.toMatch(/unexplainedly idle/);
    expect(reading.held).toMatch(/DEFERRED \(NO_SURFACE_SERVES_THIS_PROJECT\)/);
    expect(reading.reason).toMatch(/Held, not idle: 1 DEFERRED \(NO_SURFACE_SERVES_THIS_PROJECT\)/);
    expect(fires).toBe(0);
  });

  it('holds a young unanswered fire as a wait, and reads one past the in-flight window as idle', async () => {
    // A fire that never arrived and that the no-show pass never reopened. While
    // it is young it explains the wait; once it is older than the in-flight
    // window it holds no slot anywhere, and calling it a hold would hide the
    // continuation path stalling.
    const binId = await deferredBin('ACCOUNT_TARGETS_REACHED');
    const sentAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await getDb().run(
      "UPDATE bin_dispatch SET state = 'SENT', sent_at = ?, next_attempt_at = ?, last_error_kind = NULL WHERE bin_id = ?",
      [sentAt, sentAt, binId],
    );

    const young = await watchIdle({ continueWork: false });
    expect(young.executableWork).toBe(0);
    expect(young.idle).toBe(false);
    expect(young.held).toMatch(/SENT_AWAITING_ARRIVAL/);

    const stale = new Date(Date.parse(sentAt) + SENT_EXPLAINS_FOR_MS + 60_000);
    const old = await watchIdle({ continueWork: false, now: stale });
    expect(old.executableWork).toBe(1);
    expect(old.idle).toBe(true);
    expect(old.held).not.toMatch(/SENT/);
    expect(fires).toBe(0);
  });

  it('still counts an abandoned intent beside a READY bin as idle, so no bar is lowered', async () => {
    const binId = await deferredBin('ACCOUNT_TARGETS_REACHED');
    await getDb().run("UPDATE bin_dispatch SET state = 'ABANDONED', last_error_kind = 'SERVER' WHERE bin_id = ?", [binId]);

    const reading = await watchIdle({ continueWork: false });
    expect(reading.executableWork).toBe(1);
    expect(reading.idle).toBe(true);
  });
});
