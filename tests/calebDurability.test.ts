/**
 * Caleb's account, run for simulated days, in the shape production holds it.
 *
 * Production, 2026-10-16: one Claude account, one Brain connector at `/mcp`
 * authorizing as his research worker (worker-04), and five Routines on it.
 * Caleb 3-A arrives and works. Caleb 3-B, 3-C and 3-D were quarantined for
 * no-shows on 10-12 and 10-14 and every recovery probe since has read NO_MCP
 * or was inconclusive, so all three are past the fast recovery budget and on
 * Brain's daily check. Factory surface 3 is registered for the Factory worker
 * (worker-10) and its session arrived as worker-04, through the research
 * connector, so it is quarantined as a wrong-worker surface.
 *
 * Caleb reported correcting the connectors in Claude. These cases establish
 * what Brain then does with no person pressing anything: whether the daily
 * check lifts each quarantine on the first session that arrives right, whether
 * the lifted Routines stay eligible through a week of refreshes, outages and
 * misses, and whether Factory surface 3 is recovered by a session as worker-10
 * and by nothing else. What they cannot establish is whether Claude starts
 * Caleb's sessions; only production fires measure that.
 *
 * The scaffolding is `airynDurability.test.ts`'s: the real check-in, no-show
 * pass, wrong-worker derivation, recovery probe and token rotation, with only
 * `Date` and the provider's fire simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createAccount, createRoutine, getRoutine, setRoutineState, unansweredFiresByRoutine } from '../server/repos/fleet.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { findLiveToken, issueGrant, registerClient, rotateRefreshToken, touchToken } from '../server/repos/oauth.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  getBin,
  markDispatchRoutine,
  markDispatchSent,
  reopenNoShowDispatches,
} from '../server/repos/bins.ts';
import { checkIn, requestCompletion, submitUnit } from '../server/services/bins/service.ts';
import { UNIT_TRANSFORMS } from '../server/services/bins/contracts.ts';
import { forgetRoutingHealth } from '../server/services/fleet/connectorHealth.ts';
import { quarantineWrongWorkerSurfaces, WRONG_WORKER_GRACE_MS } from '../server/services/fleet/arrivalIdentity.ts';
import {
  autoProbeQuarantinedSurfaces,
  autoRecoveryExhausted,
  nextAutoProbeAt,
  resetAutoRecoveryClock,
} from '../server/services/fleet/autoRecovery.ts';
import { settleRecoveryProbes, type Fire } from '../server/services/fleet/recoveryProbe.ts';
import { getRecoveryProbe } from '../server/repos/recoveryProbes.ts';
import { connectionAlerts } from '../server/services/fleet/connectionAlerts.ts';
import { shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import { noteInfraFailure, resetInfraCounters } from '../server/db/infra.ts';
import { settleInfraIncidents, startInfraIncidentRecorder, stopInfraIncidentRecorder } from '../server/services/infra/incidents.ts';
import { parseOAuthToken } from '../server/services/identity/secrets.ts';
import type { BinManifest, Principal, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = ['project:read', 'queue:claim', 'queue:complete'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NO_SHOW_REASON = '3 consecutive fired sessions never checked in. That is a surface failure, not a refusal.';

let projectId = '';
let research = ''; // worker-04: Caleb's research worker
let factory = ''; // worker-10: the shared Factory worker
let clock = 0;
/** Provider session ids are unique for ever; one counter across every loop. */
let probeSessions = 0;

function at(ms: number): void {
  clock = ms;
  vi.setSystemTime(ms);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(Date.parse('2026-11-02T00:00:00.000Z'));
  resetInfraCounters();
  resetAutoRecoveryClock();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  forgetRoutingHealth();
  research = (await createWorker({ name: 'caleb-research', createdByType: 'SYSTEM', createdById: 'test' })).id;
  factory = (await createWorker({ name: 'factory-brain', createdByType: 'SYSTEM', createdById: 'test' })).id;
  for (const w of [research, factory]) {
    await grantMembership({ projectId, principalType: 'WORKER', principalId: w, role: 'MEMBER', scopes: SCOPES, grantedByType: 'SYSTEM', grantedById: 'test' });
  }
  await setWorkerRouting({ workerId: research, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
  await setWorkerRouting({ workerId: factory, families: ['FACTORY', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
});

afterEach(async () => {
  stopInfraIncidentRecorder();
  await settleInfraIncidents().catch(() => undefined);
  vi.useRealTimers();
});

const MANIFEST = (): BinManifest =>
  ({
    objective: 'Research work.',
    why: 'it is real',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'u', establishes: 'x', input: 'v', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: [],
    outputs: [],
    authorizedActions: [],
    prohibitedActions: [],
    budgetUnits: 1,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: [],
  }) as unknown as BinManifest;

async function bin(): Promise<string> {
  return (
    await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'research',
      objective: 'research',
      manifest: MANIFEST(),
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      maxAttempts: 5,
    })
  ).id;
}

interface Routine {
  name: string;
  id: string;
  ref: string;
}

/** Caleb's account: 3-A to 3-D for the research worker, and Factory surface 3 for the Factory worker. */
async function caleb(): Promise<{ a: Routine; b: Routine; c: Routine; d: Routine; f3: Routine }> {
  const account = await createAccount({ provider: 'anthropic', name: 'Caleb' });
  const make = async (name: string, key: string, workerId: string): Promise<Routine> => {
    process.env[`SECRET_CALEB_${key}`] = 'not-a-real-token';
    const r = await createRoutine({ accountId: account.id, routineRef: `trig_caleb_${key}`, name, tokenSecretName: `SECRET_CALEB_${key}`, workerId });
    return { name, id: r.id, ref: r.routineRef };
  };
  return {
    a: await make('Caleb 3-A', '3A', research),
    b: await make('Caleb 3-B', '3B', research),
    c: await make('Caleb 3-C', '3C', research),
    d: await make('Caleb 3-D', '3D', research),
    f3: await make('Factory surface 3', 'F3', factory),
  };
}

interface Connector {
  clientId: string;
  accessId: string;
  refreshId: string;
  refreshSecret: string;
}

async function connector(workerId: string, resource: string): Promise<Connector> {
  const client = await registerClient({
    clientName: `caleb ${resource}`,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    secretDigest: null,
    tokenAuthMethod: 'none',
  });
  const minted = await issueGrant({ clientId: client.clientId, workerId, scope: '', resource, now: clock });
  return held(client.clientId, minted.access, minted.refresh);
}

async function held(clientId: string, access: string, refresh: string): Promise<Connector> {
  const a = parseOAuthToken(access)!;
  const r = parseOAuthToken(refresh)!;
  return {
    clientId,
    accessId: (await findLiveToken(a.prefix, a.secret, 'ACCESS'))!.id,
    refreshId: (await findLiveToken(r.prefix, r.secret, 'REFRESH'))!.id,
    refreshSecret: r.secret,
  };
}

async function refresh(c: Connector): Promise<Connector> {
  const rotated = await rotateRefreshToken({ tokenId: c.refreshId, presentedSecret: c.refreshSecret, now: clock });
  if (!rotated.ok) throw new Error(`refresh refused: ${rotated.reason}`);
  return held(c.clientId, rotated.minted.access, rotated.minted.refresh);
}

async function fire(r: Routine, session: string): Promise<string> {
  const binId = await bin();
  await getDb().run(`UPDATE bin_dispatch SET state = 'ABANDONED' WHERE state = 'PENDING'`);
  await ensureDispatchIntent((await getBin(binId))!);
  const intent = (await claimDispatchIntent())!;
  expect(intent.binId).toBe(binId);
  await markDispatchRoutine(intent.id, r.id);
  await markDispatchSent(intent.id, { routineRef: r.ref, routineId: r.id, sessionRef: `cse_${session}`, projectId });
  return binId;
}

function principal(workerId: string, c: Connector, session: string): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: c.accessId,
    authMethod: 'OAUTH_BEARER',
    memberships: [{ projectId, principalType: 'WORKER', principalId: workerId, role: 'MEMBER', scopes: SCOPES, active: true }],
    requestId: `req_${session}`,
  } as unknown as Principal;
}

/** A fired session checks in and finishes whatever it is given. */
async function arriveAndWork(workerId: string, c: Connector, session: string): Promise<boolean> {
  await touchToken(c.accessId);
  const result = await checkIn({ principal: principal(workerId, c, session), workerId, sessionRef: `session_${session}` });
  if (!result.assigned) return false;
  const a = result.assignment;
  const proof = { binId: a.binId, leaseId: a.leaseId, leaseGeneration: a.leaseGeneration, workerId };
  for (const unit of a.manifest.units) {
    await submitUnit({ workerId, proof, unitKey: unit.key, value: UNIT_TRANSFORMS[unit.transform]!(unit.input) });
  }
  return (await requestCompletion({ workerId, proof })).state === 'COMPLETE';
}

async function judge(): Promise<void> {
  await settleInfraIncidents();
  await reopenNoShowDispatches(30 * 60_000, 500);
  for (const [routineId, count] of await unansweredFiresByRoutine()) {
    const verdict = shouldQuarantine({ consecutiveNoShows: count, consecutiveFailures: 0 });
    if (!verdict.quarantine) continue;
    const routine = await getRoutine(routineId);
    if (routine?.state !== 'ENABLED') continue;
    await setRoutineState({ routineId, from: 'ENABLED', to: 'QUARANTINED', reason: verdict.reason });
  }
  await quarantineWrongWorkerSurfaces(clock);
}

async function state(r: Routine): Promise<string> {
  return (await getRoutine(r.id))!.state;
}

/**
 * Drive Brain's own recovery loop for `span` of simulated time, every five
 * minutes, the way the tick would. `arrival` decides, per probe, which worker
 * (if any) the probe's session arrives as, through which connector.
 */
async function recoveryLoop(
  span: number,
  arrival: (routineId: string) => { workerId: string; c: Connector } | null,
): Promise<Array<{ routineId: string; state: string; at: number }>> {
  const pending = new Map<string, string>(); // probe id -> routine id
  const fireProbe: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_PRB${(probeSessions += 1)}`, fireEventId: 'f', routineId: target.routineId });
  const out: Array<{ routineId: string; state: string; at: number }> = [];
  const end = clock + span;
  while (clock < end) {
    at(clock + 5 * 60_000);
    const id = await autoProbeQuarantinedSurfaces({ force: true, fire: fireProbe, now: clock });
    if (id) {
      const probe = (await getRecoveryProbe(id))!;
      pending.set(id, probe.routineId);
      const who = arrival(probe.routineId);
      if (who) {
        await touchToken(who.c.accessId);
        await checkIn({ principal: principal(who.workerId, who.c, `PRB${probeSessions}`), workerId: who.workerId, sessionRef: `session_PRB${probeSessions}` });
        at(clock + WRONG_WORKER_GRACE_MS + 1_000);
      }
    }
    await settleRecoveryProbes(clock);
    for (const [pid, routineId] of [...pending]) {
      const p = (await getRecoveryProbe(pid))!;
      if (p.state === 'FIRING' || p.state === 'FIRED') continue;
      out.push({ routineId, state: p.state, at: clock });
      pending.delete(pid);
    }
  }
  return out;
}

/** Bring 3-B, 3-C and 3-D to production's state: no-show quarantined, fast budget spent on NO_MCP. */
async function exhaustedSiblings(routines: Routine[]): Promise<void> {
  for (const r of routines) await setRoutineState({ routineId: r.id, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
  // Every probe Brain starts for them reads NO_MCP: Claude starts nothing that reaches Brain.
  await recoveryLoop(4 * DAY, () => null);
  const exhausted = new Set((await autoRecoveryExhausted()).map((e) => e.routineId));
  for (const r of routines) expect(exhausted.has(r.id)).toBe(true);
}

describe("Caleb's account over simulated time", () => {
  it('once Caleb fixes 3-B, 3-C and 3-D, Brain\'s daily check lifts each one with nobody pressing anything, and 3-A never notices', async () => {
    const { a, b, c, d } = await caleb();
    let conn = await connector(research, 'https://brain.example/mcp');
    await exhaustedSiblings([b, c, d]);
    expect(await state(a)).toBe('ENABLED');
    // 3-A keeps working throughout.
    at(clock + HOUR);
    await fire(a, 'a_before');
    expect(await arriveAndWork(research, conn, 'a_before')).toBe(true);

    // Each exhausted Routine has a next daily check, and the alert says so.
    for (const r of [b, c, d]) expect(await nextAutoProbeAt(r.id)).not.toBeNull();
    const { alerts } = await connectionAlerts(clock);
    for (const r of [b, c, d]) expect(alerts.find((x) => x.routineId === r.id)!.detail).toContain('checks it again by itself at');

    // Caleb corrects the Routines. From now on every session arrives as worker-04.
    conn = await refresh(conn);
    const settled = await recoveryLoop(3 * DAY, () => ({ workerId: research, c: conn }));
    for (const r of [b, c, d]) {
      expect(await state(r)).toBe('ENABLED');
      expect(settled.find((s) => s.routineId === r.id)?.state).toBe('HEALTHY');
    }
    // One probe each was enough: no Routine needed a second right session.
    for (const r of [b, c, d]) expect(settled.filter((s) => s.routineId === r.id)).toHaveLength(1);
    expect(await state(a)).toBe('ENABLED');
  });

  it('after the fix, a week of hourly work, hourly refreshes, Brain outages and isolated misses leaves all four eligible', async () => {
    const { a, b, c, d } = await caleb();
    const all = [a, b, c, d];
    let conn = await connector(research, 'https://brain.example/mcp');
    startInfraIncidentRecorder();
    const start = clock;
    let miss = 0;
    for (let h = 0; h < 7 * 24; h += 1) {
      at(start + h * HOUR);
      conn = await refresh(conn); // the access token's life is an hour
      const outage = h % 37 === 20; // Brain's database not answering for the hour
      for (const [i, r] of all.entries()) {
        await fire(r, `wk_${i}_${h}`);
        if (outage) {
          at(start + h * HOUR + (i + 1) * 60_000);
          noteInfraFailure('STATEMENT_TIMEOUT', 'mcp:authenticate');
          continue;
        }
        // An isolated miss on one Routine every 11 hours: Claude did not start it.
        if ((h + i) % 11 === 0) {
          miss += 1;
          continue;
        }
        expect(await arriveAndWork(research, conn, `wk_${i}_${h}`)).toBe(true);
      }
      at(start + h * HOUR + 45 * 60_000);
      await judge();
      for (const r of all) expect(await state(r)).toBe('ENABLED');
    }
    expect(miss).toBeGreaterThan(40);
  });

  it('Factory surface 3: a session as worker-04 quarantines it; one as worker-10 through a Factory connector lifts it; a worker-04 probe never does', async () => {
    const { a, f3 } = await caleb();
    const researchConn = await connector(research, 'https://brain.example/mcp');
    // Production's history: an early right arrival (10-04), then the Routine selected the research connector.
    const factoryElsewhere = await connector(factory, 'https://brain.example/mcp/factory'); // another account's Factory connector
    at(clock + HOUR);
    await fire(f3, 'f3_right_once');
    await arriveAndWork(factory, factoryElsewhere, 'f3_right_once');
    at(clock + HOUR);
    await fire(f3, 'f3_wrong');
    await arriveAndWork(research, researchConn, 'f3_wrong');
    at(clock + WRONG_WORKER_GRACE_MS + 60_000);
    await judge();
    expect(await state(f3)).toBe('QUARANTINED');
    expect((await getRoutine(f3.id))!.stateReason).toContain('different worker');
    expect(await state(a)).toBe('ENABLED');

    // Before any fix, Brain's own probes keep arriving as worker-04 and never lift it.
    const unfixed = await recoveryLoop(DAY, (rid) => (rid === f3.id ? { workerId: research, c: researchConn } : null));
    expect(unfixed.length).toBeGreaterThan(0);
    expect(await state(f3)).toBe('QUARANTINED');

    // Caleb adds a Brain connector at /mcp/factory, approved for worker-10, and selects it in Factory surface 3.
    const calebFactory = await connector(factory, 'https://brain.example/mcp/factory');
    const fixed = await recoveryLoop(3 * DAY, (rid) => (rid === f3.id ? { workerId: factory, c: calebFactory } : null));
    expect(await state(f3)).toBe('ENABLED');
    expect(fixed.every((s) => s.state === 'HEALTHY')).toBe(true);
    // 3-A, on the research connector, was never touched by any of it.
    expect(await state(a)).toBe('ENABLED');
  });

  it("Brain's outages during the recovery never count against Caleb's Routines or name him", async () => {
    const { b } = await caleb();
    await setRoutineState({ routineId: b.id, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    startInfraIncidentRecorder();
    // A day in which Brain feels a failure every few minutes: no probe is started at all.
    let started = 0;
    const fireProbe: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_OUT${(started += 1)}`, fireEventId: 'f', routineId: target.routineId });
    for (let m = 0; m < 24 * 60; m += 5) {
      at(clock + 5 * 60_000);
      noteInfraFailure('POOLER_CHECKOUT_TIMEOUT', 'test');
      await autoProbeQuarantinedSurfaces({ force: true, fire: fireProbe, now: clock });
    }
    expect(started).toBe(0);
    expect(await autoRecoveryExhausted()).toEqual([]);
  });
});
