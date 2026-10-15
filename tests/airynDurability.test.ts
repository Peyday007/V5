/**
 * Airyn's four Research Routines, run for simulated days.
 *
 * Production: Airyn 2-A to 2-D share one Claude account, one Brain connector
 * (`/mcp/factory`, authorizing as his research worker) and one registered
 * worker. They disconnected repeatedly — 115 wrong-worker fires each on
 * 2026-10-11, then a mixed-connector configuration — and checks that passed on
 * the day did not say whether they would stay connected.
 *
 * This walks the real check-in, the real no-show pass, the real wrong-worker and
 * recovery derivations, the real token rotation and the real bin completion, one
 * simulated hour at a time, with only the clock (`Date`) and the provider's fire
 * simulated. The no-show quarantine is the three statements `dispatchTick` runs,
 * called directly because the rest of the tick fires real Routines over HTTP.
 *
 * What it establishes: Brain's own state does not drift over thousands of
 * fires, outages, restarts and refreshes. What it cannot: whether Claude keeps
 * starting Airyn's sessions and keeps his connector attached for a week. That
 * is the provider's, and only elapsed production time measures it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createAccount,
  createRoutine,
  getRoutine,
  setRoutineState,
  unansweredFiresByRoutine,
} from '../server/repos/fleet.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { findLiveToken, issueGrant, registerClient, rotateRefreshToken, touchToken } from '../server/repos/oauth.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  getBin,
  listDispatchesForBin,
  markDispatchRoutine,
  markDispatchSent,
  reopenNoShowDispatches,
} from '../server/repos/bins.ts';
import { checkIn, requestCompletion, submitUnit } from '../server/services/bins/service.ts';
import { UNIT_TRANSFORMS } from '../server/services/bins/contracts.ts';
import { forgetRoutingHealth } from '../server/services/fleet/connectorHealth.ts';
import { quarantineWrongWorkerSurfaces, CONSISTENT_RIGHT_SESSIONS } from '../server/services/fleet/arrivalIdentity.ts';
import { AUTO_PROBE_LIMIT, autoProbeQuarantinedSurfaces, resetAutoRecoveryClock } from '../server/services/fleet/autoRecovery.ts';
import { RECOVERY_PROBE_WINDOW_MS, settleRecoveryProbes, type Fire } from '../server/services/fleet/recoveryProbe.ts';
import { shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import { noteInfraFailure, resetInfraCounters } from '../server/db/infra.ts';
import { settleInfraIncidents, startInfraIncidentRecorder, stopInfraIncidentRecorder } from '../server/services/infra/incidents.ts';
import { parseOAuthToken } from '../server/services/identity/secrets.ts';
import type { BinManifest, Principal, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = ['project:read', 'queue:claim', 'queue:complete'];
const HOUR = 3_600_000;
const NAMES = ['2-A', '2-B', '2-C', '2-D'] as const;

let projectId = '';
let research = '';
let factory = '';
let clock = 0;

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
  research = (await createWorker({ name: 'airyn-research', createdByType: 'SYSTEM', createdById: 'test' })).id;
  factory = (await createWorker({ name: 'airyn-factory', createdByType: 'SYSTEM', createdById: 'test' })).id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: research,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  await setWorkerRouting({ workerId: research, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
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

async function airyn(): Promise<Routine[]> {
  const account = await createAccount({ provider: 'anthropic', name: 'Airyn' });
  const out: Routine[] = [];
  for (const name of NAMES) {
    process.env[`SECRET_AIRYN_${name}`] = 'not-a-real-token';
    const r = await createRoutine({
      accountId: account.id,
      routineRef: `trig_airyn_${name}`,
      name: `Airyn ${name}`,
      tokenSecretName: `SECRET_AIRYN_${name}`,
      workerId: research,
    });
    out.push({ name: `Airyn ${name}`, id: r.id, ref: r.routineRef });
  }
  return out;
}

/** One Claude connector: a client, its current access token, and its refresh chain. */
interface Connector {
  clientId: string;
  accessId: string;
  refreshId: string;
  refreshSecret: string;
}

async function connector(workerId: string, resource: string): Promise<Connector> {
  const client = await registerClient({
    clientName: `airyn ${resource}`,
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

/** The connector's access token has expired: Claude presents the refresh token, exactly as the token endpoint would. */
async function refresh(c: Connector): Promise<Connector> {
  const rotated = await rotateRefreshToken({ tokenId: c.refreshId, presentedSecret: c.refreshSecret, now: clock });
  if (!rotated.ok) throw new Error(`refresh refused: ${rotated.reason}`);
  return held(c.clientId, rotated.minted.access, rotated.minted.refresh);
}

async function accessIsLive(c: Connector): Promise<boolean> {
  const row = await getDb().get<{ revoked_at: string | null; expires_at: string }>(
    'SELECT revoked_at, expires_at FROM oauth_tokens WHERE id = ?',
    [c.accessId],
  );
  return !!row && row.revoked_at === null && row.expires_at > new Date(clock).toISOString();
}

/** Brain fires this Routine for a fresh bin, and the provider answers with a session. */
async function fire(r: Routine, session: string): Promise<string> {
  const binId = await bin();
  // Scaffolding: intents the no-show pass reopened belong to fires already judged.
  await getDb().run(`UPDATE bin_dispatch SET state = 'ABANDONED' WHERE state = 'PENDING'`);
  await ensureDispatchIntent((await getBin(binId))!);
  const intent = (await claimDispatchIntent())!;
  expect(intent.binId).toBe(binId);
  await markDispatchRoutine(intent.id, r.id);
  await markDispatchSent(intent.id, { routineRef: r.ref, routineId: r.id, sessionRef: `cse_${session}`, projectId });
  return binId;
}

/** The fired session checks in (reporting the `session_` spelling, as Claude does) and finishes what it is given. */
async function arriveAndWork(workerId: string, c: Connector, session: string, memberOf: string[]): Promise<boolean> {
  await touchToken(c.accessId);
  const principal = {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: c.accessId,
    authMethod: 'OAUTH_BEARER',
    memberships: memberOf.map((p) => ({ projectId: p, principalType: 'WORKER', principalId: workerId, role: 'MEMBER', scopes: SCOPES, active: true })),
    requestId: `req_${session}`,
  } as unknown as Principal;
  const result = await checkIn({ principal, workerId, sessionRef: `session_${session}` });
  if (!result.assigned) return false;
  const a = result.assignment;
  const proof = { binId: a.binId, leaseId: a.leaseId, leaseGeneration: a.leaseGeneration, workerId };
  for (const unit of a.manifest.units) {
    await submitUnit({ workerId, proof, unitKey: unit.key, value: UNIT_TRANSFORMS[unit.transform]!(unit.input) });
  }
  const done = await requestCompletion({ workerId, proof });
  return done.state === 'COMPLETE';
}

/** The no-show half of `dispatchTick`, in its own order, at the simulated clock. */
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

async function count(type: string, routineId?: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bin_events WHERE event_type = ?${routineId ? ' AND routine_id = ?' : ''}`,
    routineId ? [type, routineId] : [type],
  );
  return Number(row?.n ?? 0);
}

describe("Airyn's four Routines over simulated time", () => {
  it('seven days of ordinary use: isolated misses, an outage, a restart and hourly refreshes leave all four eligible', async () => {
    const routines = await airyn();
    let c = await connector(research, 'https://brain.example/mcp/factory');
    startInfraIncidentRecorder();
    const start = clock;
    let completed = 0;
    let isolatedMisses = 0;
    const OUTAGE = new Set([50, 51]);
    const RESTART = 100;

    for (let h = 0; h < 7 * 24; h += 1) {
      at(start + h * HOUR);
      // Every hour the access token has expired; the connector refreshes once,
      // and every Routine's session presents the same new token.
      c = await refresh(c);

      for (const [i, r] of routines.entries()) {
        const session = `${i}_${h}`;
        await fire(r, session);
        at(start + h * HOUR + (i + 1) * 60_000);
        if (OUTAGE.has(h)) {
          // Brain's database does not answer while the session tries to arrive.
          noteInfraFailure('POOLER_CHECKOUT_TIMEOUT', 'mcp:authenticate');
          continue;
        }
        if (h === RESTART && i === 2) {
          // The process restarts while 2-C's session is arriving.
          noteInfraFailure('CONNECTION_LOST', 'check_in:establish');
          continue;
        }
        // An ordinary isolated miss: Claude did not start or deliver the session.
        if ((h * 7 + i * 5) % 17 === 0) {
          isolatedMisses += 1;
          continue;
        }
        if (await arriveAndWork(research, c, session, [projectId])) completed += 1;
      }

      at(start + h * HOUR + 45 * 60_000);
      await judge();
      for (const r of routines) {
        const now = (await getRoutine(r.id))!;
        expect(now.state, `${r.name} at hour ${h}`).toBe('ENABLED');
        // A counter that only ever goes up is a quarantine waiting to happen.
        expect((await unansweredFiresByRoutine()).get(r.id) ?? 0, `${r.name} unanswered at hour ${h}`).toBeLessThanOrEqual(1);
      }
    }

    expect(isolatedMisses).toBeGreaterThan(20);
    // A miss whose bin a sibling's session took before the pass looked is not
    // charged at all (see the masking case below); every other miss is charged once.
    const noShows = await count('DISPATCH_NO_SHOW');
    expect(noShows).toBeLessThanOrEqual(isolatedMisses);
    expect(noShows).toBeGreaterThanOrEqual(isolatedMisses - 3);
    // The outage and the restart are Brain's: charged to nobody.
    expect(await count('DISPATCH_INFRA_NO_SHOW')).toBe(OUTAGE.size * 4 + 1);
    expect(await count('DISPATCH_WRONG_WORKER')).toBe(0);
    expect(completed).toBe(7 * 24 * 4 - isolatedMisses - OUTAGE.size * 4 - 1);
    expect(await accessIsLive(c)).toBe(true);
  });

  it('a refresh by one Routine never breaks its siblings, even when two present the same refresh token', async () => {
    const routines = await airyn();
    let c = await connector(research, 'https://brain.example/mcp/factory');
    // Two sessions both find the access token expired and both present the
    // refresh token they hold. Both get an answer, and it is the same answer.
    const first = await rotateRefreshToken({ tokenId: c.refreshId, presentedSecret: c.refreshSecret, now: clock });
    const second = await rotateRefreshToken({ tokenId: c.refreshId, presentedSecret: c.refreshSecret, now: clock + 5_000 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(parseOAuthToken(second.minted.refresh)!.prefix).toBe(parseOAuthToken(first.minted.refresh)!.prefix);
    c = await held(c.clientId, second.minted.access, second.minted.refresh);
    for (const [i, r] of routines.entries()) {
      await fire(r, `race_${i}`);
      expect(await arriveAndWork(research, c, `race_${i}`, [projectId])).toBe(true);
    }
    at(clock + 45 * 60_000);
    await judge();
    for (const r of routines) expect((await getRoutine(r.id))!.state).toBe('ENABLED');
  });

  it('thirty-five days of hourly refreshes: the refresh chain slides and never needs a person', async () => {
    let c = await connector(research, 'https://brain.example/mcp/factory');
    const start = clock;
    for (let h = 1; h <= 35 * 24; h += 1) {
      at(start + h * HOUR);
      c = await refresh(c);
    }
    expect(await accessIsLive(c)).toBe(true);
    const row = await getDb().get<{ expires_at: string }>('SELECT expires_at FROM oauth_tokens WHERE id = ?', [c.refreshId]);
    // Past the original grant's thirty days, still valid for about thirty more.
    expect(Date.parse(row!.expires_at) - clock).toBeGreaterThan(29 * 24 * HOUR);
  });

  it('a long silence on one Routine quarantines it alone; Brain probes it back and its siblings never notice', async () => {
    const routines = await airyn();
    const c = await connector(research, 'https://brain.example/mcp/factory');
    const [a, b] = routines as [Routine, Routine, Routine, Routine];
    const start = clock;
    // 2-B's sessions stop reaching Brain for three hours; the others keep working.
    for (let h = 0; h < 3; h += 1) {
      at(start + h * HOUR);
      // The siblings are fired and served first, so 2-B's bin is still waiting
      // when the no-show pass looks at it (see the masking case below).
      for (const [i, r] of routines.entries()) {
        if (r.id === b.id) continue;
        await fire(r, `sil_${i}_${h}`);
        expect(await arriveAndWork(research, c, `sil_${i}_${h}`, [projectId])).toBe(true);
      }
      await fire(b, `sil_b_${h}`);
      at(start + h * HOUR + 45 * 60_000);
      await judge();
    }
    expect((await getRoutine(b.id))!.state).toBe('QUARANTINED');
    for (const r of routines) if (r.id !== b.id) expect((await getRoutine(r.id))!.state).toBe('ENABLED');

    // Claude starts delivering 2-B's sessions again. Brain probes it by itself.
    const probeFire: Fire = async ({ target }) => ({ ok: true, sessionRef: 'cse_PROBE_B', fireEventId: 'f', routineId: target.routineId });
    at(clock + 16 * 60_000);
    const probeId = await autoProbeQuarantinedSurfaces({ force: true, fire: probeFire, now: clock });
    expect(probeId).not.toBeNull();
    await touchToken(c.accessId);
    const principal = {
      type: 'WORKER', id: research, handle: research, displayName: research, isBrainAdmin: false, mustChangePassword: false,
      credentialId: c.accessId, authMethod: 'OAUTH_BEARER',
      memberships: [{ projectId, principalType: 'WORKER', principalId: research, role: 'MEMBER', scopes: SCOPES, active: true }],
      requestId: 'req_probe',
    } as unknown as Principal;
    await checkIn({ principal, workerId: research, sessionRef: 'session_PROBE_B' });
    await settleRecoveryProbes(clock);
    expect((await getRoutine(b.id))!.state).toBe('ENABLED');

    // Recovered means eligible: one more ordinary miss does not put it straight back.
    at(clock + HOUR);
    await fire(b, 'after_1');
    at(clock + 45 * 60_000);
    await judge();
    expect((await getRoutine(b.id))!.state).toBe('ENABLED');
    await fire(b, 'after_2');
    expect(await arriveAndWork(research, c, 'after_2', [projectId])).toBe(true);
    expect((await getRoutine(a.id))!.state).toBe('ENABLED');
  });

  it('a silent Routine whose bins its siblings absorb is charged late, not never', async () => {
    const routines = await airyn();
    const c = await connector(research, 'https://brain.example/mcp/factory');
    const b = routines[1]!;
    const start = clock;
    for (let h = 0; h < 6; h += 1) {
      at(start + h * HOUR);
      // 2-B is fired first and never arrives; the siblings' sessions take its bin.
      await fire(b, `mask_b_${h}`);
      for (const [i, r] of routines.entries()) {
        if (r.id === b.id) continue;
        await fire(r, `mask_${i}_${h}`);
        await arriveAndWork(research, c, `mask_${i}_${h}`, [projectId]);
      }
      at(start + h * HOUR + 45 * 60_000);
      await judge();
    }
    // A fire whose bin a sibling took is not charged — the work was done, and
    // nothing proves 2-B's session would not have come — so six silent fires are
    // charged as fewer than six. Detection is slower; it still happens.
    const charged = await count('DISPATCH_NO_SHOW', b.id);
    expect(charged).toBeLessThan(6);
    expect(charged).toBeGreaterThanOrEqual(3);
    expect((await getRoutine(b.id))!.state).toBe('QUARANTINED');
    for (const r of routines) if (r.id !== b.id) expect((await getRoutine(r.id))!.state).toBe('ENABLED');
  });

  it("Brain's own outages, however long, never quarantine a healthy Routine or spend its recovery budget", async () => {
    const routines = await airyn();
    startInfraIncidentRecorder();
    const start = clock;
    for (let h = 0; h < 12; h += 1) {
      at(start + h * HOUR);
      for (const [i, r] of routines.entries()) {
        await fire(r, `out_${i}_${h}`);
        at(start + h * HOUR + (i + 1) * 60_000);
        noteInfraFailure('STATEMENT_TIMEOUT', 'mcp:authenticate');
      }
      at(start + h * HOUR + 45 * 60_000);
      await judge();
      expect(await autoProbeQuarantinedSurfaces({ force: true, now: clock })).toBeNull();
    }
    for (const r of routines) {
      expect((await getRoutine(r.id))!.state).toBe('ENABLED');
      expect(await count('DISPATCH_NO_SHOW', r.id)).toBe(0);
    }
    expect(await count('DISPATCH_INFRA_NO_SHOW')).toBe(48);
  });

  it('the mixed-connector history, after Airyn corrects it: what lifts by itself and what needs one person', async () => {
    const routines = await airyn();
    const right = await connector(research, 'https://brain.example/mcp/factory');
    const wrong = await connector(factory, 'https://brain.example/mcp');
    const c = routines[2]!; // 2-C: interleaved right and wrong, as in production
    // Production's pattern: right, wrong, right, wrong.
    for (const [k, mixWrong] of [false, true, false, true].entries()) {
      at(clock + HOUR);
      await fire(c, `mix_${k}`);
      if (mixWrong) await arriveAndWork(factory, wrong, `mix_${k}`, []);
      else await arriveAndWork(research, right, `mix_${k}`, [projectId]);
    }
    at(clock + 5 * 60_000);
    await judge();
    expect((await getRoutine(c.id))!.state).toBe('QUARANTINED');

    // Airyn removes the wrong connector. Every session from now on arrives right.
    // Brain probes by itself; each probe is one session. Three in a row lift it.
    let n = 0;
    const probeFire: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_FIX${(n += 1)}`, fireEventId: 'f', routineId: target.routineId });
    let probes = 0;
    for (let step = 0; step < 10 && (await getRoutine(c.id))!.state === 'QUARANTINED'; step += 1) {
      at(clock + 25 * HOUR); // past any backoff
      const id = await autoProbeQuarantinedSurfaces({ force: true, fire: probeFire, now: clock });
      if (!id) break;
      probes += 1;
      await touchToken(right.accessId);
      const principal = {
        type: 'WORKER', id: research, handle: research, displayName: research, isBrainAdmin: false, mustChangePassword: false,
        credentialId: right.accessId, authMethod: 'OAUTH_BEARER',
        memberships: [{ projectId, principalType: 'WORKER', principalId: research, role: 'MEMBER', scopes: SCOPES, active: true }],
        requestId: `req_fix${n}`,
      } as unknown as Principal;
      await checkIn({ principal, workerId: research, sessionRef: `session_FIX${n}` });
      await settleRecoveryProbes(clock);
    }
    expect(probes).toBe(CONSISTENT_RIGHT_SESSIONS);
    expect(probes).toBeLessThan(AUTO_PROBE_LIMIT);
    expect((await getRoutine(c.id))!.state).toBe('ENABLED');

    // And once corrected it stays corrected: a day of ordinary fires, no re-quarantine
    // on the old wrong-worker evidence.
    for (let h = 0; h < 24; h += 1) {
      at(clock + HOUR);
      await fire(c, `fixed_${h}`);
      expect(await arriveAndWork(research, right, `fixed_${h}`, [projectId])).toBe(true);
      at(clock + 45 * 60_000);
      await judge();
      expect((await getRoutine(c.id))!.state).toBe('ENABLED');
    }
  });

  it('2-B in production: a corrected mixed Routine with one transient miss lifts within the hour, without spending its budget', async () => {
    const routines = await airyn();
    const right = await connector(research, 'https://brain.example/mcp/factory');
    const wrong = await connector(factory, 'https://brain.example/mcp');
    const b = routines[1]!;
    // Right sessions, then wrong ones: the Routine held both connectors.
    for (const [k, mixWrong] of [false, false, true].entries()) {
      at(clock + HOUR);
      await fire(b, `hist_${k}`);
      if (mixWrong) await arriveAndWork(factory, wrong, `hist_${k}`, []);
      else await arriveAndWork(research, right, `hist_${k}`, [projectId]);
    }
    at(clock + 5 * 60_000);
    await judge();
    expect((await getRoutine(b.id))!.state).toBe('QUARANTINED');

    // Airyn corrects it. The first probe after the correction is a transient
    // NO_MCP (production 17:50 and 18:06); every later session arrives right.
    let n = 0;
    let arriving = false;
    const probeFire: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_B${(n += 1)}`, fireEventId: 'f', routineId: target.routineId });
    const principal = () =>
      ({
        type: 'WORKER', id: research, handle: research, displayName: research, isBrainAdmin: false, mustChangePassword: false,
        credentialId: right.accessId, authMethod: 'OAUTH_BEARER',
        memberships: [{ projectId, principalType: 'WORKER', principalId: research, role: 'MEMBER', scopes: SCOPES, active: true }],
        requestId: `req_b${n}`,
      }) as unknown as Principal;
    const startedAt = clock;
    let firstRightAt: number | null = null;
    const outcomes: string[] = [];
    for (let minute = 0; minute < 48 * 60 && (await getRoutine(b.id))!.state === 'QUARANTINED'; minute += 5) {
      at(startedAt + minute * 60_000);
      const id = await autoProbeQuarantinedSurfaces({ force: true, fire: probeFire, now: clock });
      if (!id) {
        await settleRecoveryProbes(clock);
        continue;
      }
      if (arriving) {
        await touchToken(right.accessId);
        await checkIn({ principal: principal(), workerId: research, sessionRef: `session_B${n}` });
        firstRightAt ??= clock;
        await settleRecoveryProbes(clock);
        outcomes.push('HEALTHY');
      } else {
        at(clock + RECOVERY_PROBE_WINDOW_MS + 1_000);
        await settleRecoveryProbes(clock);
        outcomes.push('NO_MCP');
        arriving = true;
      }
    }
    expect((await getRoutine(b.id))!.state).toBe('ENABLED');
    expect(outcomes).toEqual(['NO_MCP', 'HEALTHY', 'HEALTHY', 'HEALTHY']);
    // The three right sessions are asked for at the shortest backoff, not 1h, 4h, 12h.
    expect(clock - firstRightAt!).toBeLessThan(HOUR);
  });

  it('a Routine that keeps choosing both connectors still reaches a person', async () => {
    const routines = await airyn();
    const right = await connector(research, 'https://brain.example/mcp/factory');
    const wrong = await connector(factory, 'https://brain.example/mcp');
    const b = routines[1]!;
    for (const [k, mixWrong] of [false, true].entries()) {
      at(clock + HOUR);
      await fire(b, `alt_${k}`);
      if (mixWrong) await arriveAndWork(factory, wrong, `alt_${k}`, []);
      else await arriveAndWork(research, right, `alt_${k}`, [projectId]);
    }
    at(clock + 5 * 60_000);
    await judge();
    // Every probe session alternates: right, right, wrong — never three in a row.
    let n = 0;
    const fire2: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_ALT${(n += 1)}`, fireEventId: 'f', routineId: target.routineId });
    let probes = 0;
    for (let step = 0; step < 60; step += 1) {
      at(clock + 25 * HOUR);
      const id = await autoProbeQuarantinedSurfaces({ force: true, fire: fire2, now: clock });
      if (!id) break;
      probes += 1;
      const isWrong = probes % 3 === 0;
      const c = isWrong ? wrong : right;
      const worker = isWrong ? factory : research;
      await touchToken(c.accessId);
      await checkIn({
        principal: {
          type: 'WORKER', id: worker, handle: worker, displayName: worker, isBrainAdmin: false, mustChangePassword: false,
          credentialId: c.accessId, authMethod: 'OAUTH_BEARER',
          memberships: isWrong ? [] : [{ projectId, principalType: 'WORKER', principalId: worker, role: 'MEMBER', scopes: SCOPES, active: true }],
          requestId: `req_alt${n}`,
        } as unknown as Principal,
        workerId: worker,
        sessionRef: `session_ALT${n}`,
      });
      at(clock + RECOVERY_PROBE_WINDOW_MS + 1_000);
      await settleRecoveryProbes(clock);
    }
    expect((await getRoutine(b.id))!.state).toBe('QUARANTINED');
    expect(probes).toBeLessThanOrEqual(AUTO_PROBE_LIMIT * CONSISTENT_RIGHT_SESSIONS + CONSISTENT_RIGHT_SESSIONS);
    expect(probes).toBeGreaterThan(AUTO_PROBE_LIMIT);
  });
});
