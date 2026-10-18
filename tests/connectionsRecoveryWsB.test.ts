/**
 * Check-ins and connection recovery under ordinary disruption (WS-B of the
 * 2026-10-12 failure inventory): CON-1, CON-2, CON-3, CON-5, CON-6, CON-7,
 * INF-6a and INF-6e, each pinned by the behaviour that was wrong.
 *
 * Driven through the real check-in, the real assignment swap, the real probe
 * settlement, the real alerts and the real dispatch tick. Slowness and failure
 * are injected at the database the app is using, exactly where production met
 * them; only the provider's fire is simulated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { Database } from '../server/db/types.ts';
import { asControlPlane, noteInfraFailure, recentInfraFailures, resetInfraCounters } from '../server/db/infra.ts';
import { createAccount, createRoutine, getRoutine, setRoutineState } from '../server/repos/fleet.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import {
  findLiveToken,
  findPresentedToken,
  issueGrant,
  registerClient,
  rotateRefreshToken,
  touchToken,
} from '../server/repos/oauth.ts';
import { attachClient, bindRoutineConnector, ensureConnector } from '../server/repos/connectors.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  getBin,
  markDispatchRoutine,
  markDispatchSent,
  recordBinEvent,
} from '../server/repos/bins.ts';
import { getRecoveryProbe, reserveRecoveryProbe, settleRecoveryProbe } from '../server/repos/recoveryProbes.ts';
import { createProject } from '../server/repos/projects.ts';
import { checkIn, databaseUnderPressure } from '../server/services/bins/service.ts';
import { forgetRoutingHealth, lastGrantForConnector } from '../server/services/fleet/connectorHealth.ts';
import {
  CONSISTENT_RIGHT_SESSIONS,
  MIXED_ARRIVALS_REASON_MARK,
  WRONG_WORKER_MARK,
  arrivalMix,
  quarantineWrongWorkerSurfaces,
  wrongWorkerRemedy,
} from '../server/services/fleet/arrivalIdentity.ts';
import {
  AUTO_PROBE_LIMIT,
  AUTO_RECOVERY_ACTOR,
  OUTAGE_PROBE_ALLOWANCE,
  autoProbeQuarantinedSurfaces,
  autoRecoveryExhausted,
} from '../server/services/fleet/autoRecovery.ts';
import { connectionAlerts } from '../server/services/fleet/connectionAlerts.ts';
import {
  BRAIN_OUTAGE_HEALTH,
  MIXED_ARRIVALS_MARK,
  RECOVERY_PROBE_WINDOW_MS,
  probeAmbiguousByOutage,
  settleRecoveryProbes,
  startRecoveryProbe,
  type Fire,
} from '../server/services/fleet/recoveryProbe.ts';
import { NO_SHOW_QUARANTINE_MARK, recoverReauthorizedSurfaces } from '../server/services/fleet/connectorBinding.ts';
import { forgetInFlight, inFlightByRoutine } from '../server/services/dispatch/candidates.ts';
import { forgetUnansweredRead, dispatchTick as runDispatchTick } from '../server/services/dispatch/loop.ts';
import { shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import { parseOAuthToken } from '../server/services/identity/secrets.ts';
import type { BinManifest, Principal, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = ['project:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];
const NO_SHOW_REASON = shouldQuarantine({ consecutiveNoShows: 3, consecutiveFailures: 0 }).reason;
const PAST_GRACE = (): number => Date.now() + 3 * 60_000;

let projectId = '';
let research = '';
let other = '';

/* ------------------------------------------------------------------------ */
/* Injection at the database the app is using                                */
/* ------------------------------------------------------------------------ */

let restore: (() => void) | null = null;

/** Statements matching `when` are delayed by `ms`, or fail with `error`, until `restore()`. */
function intercept(when: (sql: string) => boolean, effect: { delayMs?: number; error?: () => Error }): void {
  const db = getDb() as Database & Record<string, unknown>;
  const originals = { all: db.all, get: db.get, run: db.run };
  const touch = async (sql: string): Promise<void> => {
    if (!when(sql)) return;
    if (effect.delayMs) await new Promise((resolve) => setTimeout(resolve, effect.delayMs));
    if (effect.error) throw effect.error();
  };
  db.all = (async (sql: string, params?: never[]) => {
    await touch(sql);
    return originals.all.call(db, sql, params);
  }) as Database['all'];
  db.get = (async (sql: string, params?: never[]) => {
    await touch(sql);
    return originals.get.call(db, sql, params);
  }) as Database['get'];
  db.run = (async (sql: string, params?: never[]) => {
    await touch(sql);
    return originals.run.call(db, sql, params);
  }) as Database['run'];
  restore = () => {
    db.all = originals.all;
    db.get = originals.get;
    db.run = originals.run;
    restore = null;
  };
}

/** Count statements matching `when` until the returned function is called. */
function countStatements(when: (sql: string) => boolean): () => number {
  let n = 0;
  intercept((sql) => {
    if (when(sql)) n += 1;
    return false;
  }, {});
  return () => n;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  forgetRoutingHealth();
  forgetInFlight();
  forgetUnansweredRead();
  resetInfraCounters();
  research = (await createWorker({ name: 'research-shared', createdByType: 'SYSTEM', createdById: 'test' })).id;
  other = (await createWorker({ name: 'airyn-factory', createdByType: 'SYSTEM', createdById: 'test' })).id;
  await member(research, projectId);
  await setWorkerRouting({ workerId: research, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
});

afterEach(() => {
  restore?.();
  delete process.env['BRAIN_INFLIGHT_REUSE_MS'];
  resetInfraCounters();
});

async function member(workerId: string, project: string): Promise<void> {
  await grantMembership({
    projectId: project,
    principalType: 'WORKER',
    principalId: workerId,
    role: 'MEMBER',
    scopes: SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
}

const MANIFEST = (project: string): BinManifest =>
  ({
    objective: 'Research work.',
    why: 'it is real',
    lineage: { projectId: project, layerId: null, goal: null, orchestrationId: null },
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

async function readyBin(project = projectId): Promise<string> {
  const bin = await createBin({
    projectId: project,
    kind: 'DETERMINISTIC_CHECK',
    title: 'research',
    objective: 'research',
    manifest: MANIFEST(project),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 5,
  });
  return bin.id;
}

function principal(workerId: string, accessId = 'oat_test', projects = [projectId]): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: accessId,
    authMethod: 'OAUTH_BEARER',
    memberships: projects.map((p) => ({ projectId: p, principalType: 'WORKER', principalId: workerId, role: 'MEMBER', scopes: SCOPES, active: true })),
    requestId: 'req_test',
  } as unknown as Principal;
}

interface Surface {
  accountId: string;
  routineId: string;
  routineRef: string;
}

async function surface(name: string, workerId: string): Promise<Surface> {
  process.env[`SECRET_${name}`] = 'not-a-real-token';
  const acct = await createAccount({ provider: 'anthropic', name });
  const routine = await createRoutine({
    accountId: acct.id,
    routineRef: `trig_${name}`,
    name: `Research ${name}`,
    tokenSecretName: `SECRET_${name}`,
    workerId,
  });
  return { accountId: acct.id, routineId: routine.id, routineRef: routine.routineRef };
}

async function connector(workerId: string, resource: string): Promise<{ accessId: string; clientId: string }> {
  const client = await registerClient({
    clientName: `connector ${workerId} ${resource}`,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    secretDigest: null,
    tokenAuthMethod: 'none',
  });
  const minted = await issueGrant({ clientId: client.clientId, workerId, scope: '', resource, now: Date.now() - 60_000 });
  const parsed = parseOAuthToken(minted.access)!;
  return { accessId: (await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS'))!.id, clientId: client.clientId };
}

async function fire(binId: string, s: Surface, session: string): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = await claimDispatchIntent();
  expect(intent?.binId).toBe(binId);
  await markDispatchRoutine(intent!.id, s.routineId);
  await markDispatchSent(intent!.id, { routineRef: s.routineRef, routineId: s.routineId, sessionRef: session, projectId: bin.projectId });
}

async function arrive(workerId: string, accessId: string, session: string, memberOf: string[]) {
  await touchToken(accessId);
  return checkIn({ principal: principal(workerId, accessId, memberOf), workerId, sessionRef: session });
}

/* ------------------------------------------------------------------------ */
/* CON-1 · the whole check-in path is bounded, and a lease is never hidden   */
/* ------------------------------------------------------------------------ */

const CANDIDATE_READ = (sql: string): boolean => /FROM bins/.test(sql) && /LIMIT 25/.test(sql);
const SWAP = (sql: string): boolean => /UPDATE bins/.test(sql) && /attempt_count = attempt_count \+ 1/.test(sql);

describe('CON-1: check-in is bounded before the swap and truthful after it', () => {
  it('a slow candidate read answers RETRY_LATER at the deadline, and the abandoned read can never take a lease', async () => {
    const binId = await readyBin();
    intercept(CANDIDATE_READ, { delayMs: 400 });
    const started = Date.now();
    const result = await checkIn({ principal: principal(research), workerId: research, sessionRef: 'cse_slow_read', deadline: Date.now() + 120 });
    expect(Date.now() - started).toBeLessThan(380);
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
    // The abandoned call finishes its read in the background — and is refused at admission.
    await sleep(600);
    restore!();
    const bin = (await getBin(binId))!;
    expect(bin.state).toBe('READY');
    expect(bin.attemptCount).toBe(0);
    expect(bin.workerId).toBeNull();
  });

  it('a slow routing read is bounded by the same deadline', async () => {
    await readyBin();
    intercept((sql) => /FROM worker_routing/.test(sql), { delayMs: 400 });
    const result = await checkIn({ principal: principal(research), workerId: research, sessionRef: 'cse_slow_routing', deadline: Date.now() + 120 });
    restore!();
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
  });

  it('a swap admitted before the deadline is waited for and reported, however slow it is', async () => {
    const binId = await readyBin();
    intercept(SWAP, { delayMs: 400 });
    const result = await checkIn({ principal: principal(research), workerId: research, sessionRef: 'cse_slow_swap', deadline: Date.now() + 150 });
    restore!();
    expect(result.assigned).toBe(true);
    const bin = (await getBin(binId))!;
    expect(bin.state).toBe('LEASED');
    if (result.assigned) expect(bin.leaseId).toBe(result.assignment.leaseId);
  });

  it('does not run the factory derivation while the database is under pressure', async () => {
    expect(databaseUnderPressure()).toBe(false);
    noteInfraFailure('STATEMENT_TIMEOUT', 'test');
    expect(databaseUnderPressure()).toBe(true);
    const counted = countStatements((sql) => /FROM factory_campaigns/.test(sql));
    const result = await checkIn({ principal: principal(research), workerId: research, sessionRef: 'cse_pressure' });
    const factoryReads = counted();
    restore!();
    // Nothing was ready and nothing was derived: an ordinary answer, not a retry.
    expect(result).toEqual({ assigned: false, reason: 'NO_READY_BINS' });
    expect(factoryReads).toBe(0);
    // Pressure is a window, not a verdict for ever.
    expect(databaseUnderPressure(Date.now() + 2 * 60_000)).toBe(false);
  });

  it('past half its budget, check-in asks again rather than starting the derivation', async () => {
    // No bin: the first assignment finds nothing. A slow routing read spends half the budget.
    intercept((sql) => /FROM worker_routing/.test(sql), { delayMs: 150 });
    const counted = (() => {
      let n = 0;
      const db = getDb() as Database & Record<string, unknown>;
      const all = db.all;
      db.all = (async (sql: string, params?: never[]) => {
        if (/FROM factory_campaigns/.test(sql)) n += 1;
        return all.call(db, sql, params);
      }) as Database['all'];
      return () => n;
    })();
    const result = await checkIn({ principal: principal(research), workerId: research, sessionRef: 'cse_half', deadline: Date.now() + 250 });
    restore!();
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
    expect(counted()).toBe(0);
  });
});

/* ------------------------------------------------------------------------ */
/* CON-7 · a workload failure is recorded on the workload plane              */
/* ------------------------------------------------------------------------ */

describe('CON-7: choosing work records its failures as WORKLOAD', () => {
  it('a pool exhaustion inside chooseWork is attributed to the workload pool, not CONTROL', async () => {
    await readyBin();
    intercept((sql) => /FROM worker_routing/.test(sql), { error: () => new Error('timeout exceeded when trying to connect') });
    // Entered on the control plane, exactly as the brain_check_in tool enters it.
    const result = await asControlPlane(() => checkIn({ principal: principal(research), workerId: research, sessionRef: 'cse_con7' }));
    restore!();
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
    const felt = recentInfraFailures().filter((o) => o.surface === 'check_in:choose');
    expect(felt.length).toBeGreaterThan(0);
    expect(felt.every((o) => o.workloadClass === 'WORKLOAD')).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* CON-2 · rotation reads the immutable lineage outside its transaction      */
/* ------------------------------------------------------------------------ */

describe('CON-2: the rotation transaction no longer walks the lineage', () => {
  it('a retried rotation is answered with the same successor, and the ancestor walk runs before BEGIN', async () => {
    const client = await registerClient({ clientName: 'rotation', redirectUris: ['https://claude.ai/cb'], secretDigest: null, tokenAuthMethod: 'none' });
    const grant = await issueGrant({ clientId: client.clientId, workerId: research, scope: '', resource: 'https://brain.example/mcp' });
    // Two rotations deep, so the lineage has an ancestor to walk.
    const first = parseOAuthToken(grant.refresh)!;
    const firstRow = (await findPresentedToken(first.prefix, first.secret, 'REFRESH'))!;
    const r1 = await rotateRefreshToken({ tokenId: firstRow.id, presentedSecret: first.secret });
    expect(r1.ok).toBe(true);
    const second = parseOAuthToken((r1 as { minted: { refresh: string } }).minted.refresh)!;
    const secondRow = (await findPresentedToken(second.prefix, second.secret, 'REFRESH'))!;
    const r2 = await rotateRefreshToken({ tokenId: secondRow.id, presentedSecret: second.secret });
    expect(r2.ok).toBe(true);

    // Record, for each lineage read, whether a transaction was open on the adapter.
    const db = getDb() as Database & Record<string, unknown> & { inTransaction?: () => boolean };
    const inside: boolean[] = [];
    const get = db.get;
    db.get = (async (sql: string, params?: never[]) => {
      if (/SELECT parent_token_id, created_at FROM oauth_tokens WHERE id = \?/.test(sql)) {
        inside.push(typeof db.inTransaction === 'function' ? db.inTransaction() : false);
      }
      return get.call(db, sql, params);
    }) as Database['get'];
    restore = () => {
      db.get = get;
      restore = null;
    };
    // The lost reply: the same token presented again.
    const again = await rotateRefreshToken({ tokenId: secondRow.id, presentedSecret: second.secret });
    restore!();
    expect(again.ok).toBe(true);
    if (again.ok && r2.ok) {
      expect(again.outcome).toBe('REDELIVERED');
      expect(again.minted.refresh).toBe(r2.minted.refresh);
    }
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((one) => one === false)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* CON-3 · mixed arrivals do not flap                                        */
/* ------------------------------------------------------------------------ */

async function probeArrivingAs(s: Surface, workerId: string, accessId: string, session: string, memberOf: string[]) {
  const stub: Fire = async ({ target }) => ({ ok: true, sessionRef: session, fireEventId: 'f', routineId: target.routineId });
  const probe = await startRecoveryProbe({ routineRef: s.routineRef, requestedById: 'usr_admin', fire: stub });
  await arrive(workerId, accessId, session, memberOf);
  await settleRecoveryProbes(Date.now() + RECOVERY_PROBE_WINDOW_MS + 1_000);
  return (await getRecoveryProbe(probe.id))!;
}

describe('CON-3: a Routine whose sessions arrive as both workers is not lifted by one right probe', () => {
  it('mixed arrivals keep the quarantine, name the remedy, and lift only after consecutive right sessions', async () => {
    const s = await surface('airyn-2c', research);
    const right = await connector(research, 'https://brain.example/mcp/factory');
    const wrong = await connector(other, 'https://brain.example/mcp');

    // Ordinary fires: right, then wrong — the 2-C pattern.
    await fire(await readyBin(), s, 'cse_2C_1');
    expect((await arrive(research, right.accessId, 'cse_2C_1', [projectId])).assigned).toBe(true);
    await fire(await readyBin(), s, 'cse_2C_2');
    await arrive(other, wrong.accessId, 'cse_2C_2', []);
    expect(await quarantineWrongWorkerSurfaces(PAST_GRACE())).toEqual([s.routineId]);
    const quarantined = (await getRoutine(s.routineId))!;
    expect(quarantined.stateReason).toContain(WRONG_WORKER_MARK);
    expect(quarantined.stateReason).toContain(MIXED_ARRIVALS_REASON_MARK);

    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.problem).toBe('MIXED_WORKERS');
    expect(alert.who).toBe('ACCOUNT_OWNER');
    expect(alert.action).toContain('remove');

    // A right probe proves the connector, and does not lift a mixed Routine.
    const p1 = await probeArrivingAs(s, research, right.accessId, 'cse_2C_P1', [projectId]);
    expect(p1.state).toBe('HEALTHY');
    expect(p1.outcome).toContain(MIXED_ARRIVALS_MARK);
    expect((await getRoutine(s.routineId))!.state).toBe('QUARANTINED');
    // The re-derivation in the tick does not lift it either.
    await settleRecoveryProbes();
    expect((await getRoutine(s.routineId))!.state).toBe('QUARANTINED');

    for (let i = 2; i < CONSISTENT_RIGHT_SESSIONS; i += 1) {
      await probeArrivingAs(s, research, right.accessId, `cse_2C_P${i}`, [projectId]);
      expect((await getRoutine(s.routineId))!.state).toBe('QUARANTINED');
    }
    // The Nth right session in a row since the last wrong one lifts it.
    const last = await probeArrivingAs(s, research, right.accessId, `cse_2C_P${CONSISTENT_RIGHT_SESSIONS}`, [projectId]);
    expect(last.state).toBe('HEALTHY');
    expect((await getRoutine(s.routineId))!.state).toBe('ENABLED');
  });

  it('a wrong arrival between right probes resets the count', async () => {
    const s = await surface('airyn-reset', research);
    const right = await connector(research, 'https://brain.example/mcp/factory');
    const wrong = await connector(other, 'https://brain.example/mcp');
    await fire(await readyBin(), s, 'cse_R_1');
    await arrive(research, right.accessId, 'cse_R_1', [projectId]);
    await fire(await readyBin(), s, 'cse_R_2');
    await arrive(other, wrong.accessId, 'cse_R_2', []);
    await quarantineWrongWorkerSurfaces(PAST_GRACE());
    await probeArrivingAs(s, research, right.accessId, 'cse_R_P1', [projectId]);
    await probeArrivingAs(s, research, right.accessId, 'cse_R_P2', [projectId]);
    // The third probe's session chooses the wrong connector.
    await probeArrivingAs(s, other, wrong.accessId, 'cse_R_P3', []);
    const mix = await arrivalMix(s.routineId);
    expect(mix.rightSinceLastWrong).toBe(0);
    await probeArrivingAs(s, research, right.accessId, 'cse_R_P4', [projectId]);
    expect((await getRoutine(s.routineId))!.state).toBe('QUARANTINED');
  });

  it('a clean switch — only wrong, then right — is a corrected configuration and lifts at once', async () => {
    const s = await surface('airyn-switch', research);
    const right = await connector(research, 'https://brain.example/mcp/factory');
    const wrong = await connector(other, 'https://brain.example/mcp');
    await fire(await readyBin(), s, 'cse_SW_1');
    await arrive(other, wrong.accessId, 'cse_SW_1', []);
    await quarantineWrongWorkerSurfaces(PAST_GRACE());
    const reason = (await getRoutine(s.routineId))!.stateReason ?? '';
    expect(reason).toContain(WRONG_WORKER_MARK);
    expect(reason).not.toContain(MIXED_ARRIVALS_REASON_MARK);
    const probe = await probeArrivingAs(s, research, right.accessId, 'cse_SW_P1', [projectId]);
    expect(probe.state).toBe('HEALTHY');
    expect((await getRoutine(s.routineId))!.state).toBe('ENABLED');
  });

  it('no evidence is not proof of correction: a wrong-worker quarantine with no right session since stays', async () => {
    const s = await surface('airyn-none', research);
    const wrong = await connector(other, 'https://brain.example/mcp');
    await fire(await readyBin(), s, 'cse_N_1');
    await arrive(other, wrong.accessId, 'cse_N_1', []);
    await quarantineWrongWorkerSurfaces(PAST_GRACE());
    const mix = await arrivalMix(s.routineId);
    expect(mix).toMatchObject({ right: 0, wrong: 1, rightSinceLastWrong: 0 });
  });
});

/* ------------------------------------------------------------------------ */
/* CON-5 · alerts that a person can act on                                   */
/* ------------------------------------------------------------------------ */

describe('CON-5a: the wrong-worker remedy names connectors by what Claude shows, from verified bindings', () => {
  it('names each connector by its URL and label, resolved from bindings rather than the URL wording', async () => {
    const s = await surface('airyn-2b', research);
    // Production's inversion: /mcp authorizes as the factory worker, /mcp/factory as the research one.
    const rightConnector = await ensureConnector({ accountId: s.accountId, resource: 'https://brain.example/mcp/factory', workerId: research, label: 'Brain (Airyn)' });
    const wrongConnector = await ensureConnector({ accountId: s.accountId, resource: 'https://brain.example/mcp', workerId: other });
    const wrong = await connector(other, 'https://brain.example/mcp');
    await attachClient({ clientId: wrong.clientId, connectorId: wrongConnector.id, source: 'OPERATOR' });
    const routine = (await getRoutine(s.routineId))!;
    const remedy = await wrongWorkerRemedy({
      routine,
      expectedWorkerId: research,
      arrivedWorkerId: other,
      clientId: wrong.clientId,
      endpoint: '/mcp',
      mixed: false,
    });
    expect(remedy).toContain(`the Brain connector at ${rightConnector.resource} ("Brain (Airyn)")`);
    expect(remedy).toContain(`the Brain connector at ${wrongConnector.resource}`);
    expect(remedy).toContain('verified');
    const mixed = await wrongWorkerRemedy({ routine, expectedWorkerId: research, arrivedWorkerId: other, clientId: wrong.clientId, endpoint: '/mcp', mixed: true });
    expect(mixed).toContain(`remove the Brain connector at ${wrongConnector.resource}`);
  });

  it('says no connector is verified yet rather than guessing from an endpoint', async () => {
    const s = await surface('airyn-unknown', research);
    const routine = (await getRoutine(s.routineId))!;
    const remedy = await wrongWorkerRemedy({ routine, expectedWorkerId: research, arrivedWorkerId: other, clientId: null, endpoint: '/mcp/factory', mixed: false });
    expect(remedy).toContain('none in this Claude account is verified yet');
  });
});

describe('CON-5b: OUT_OF_SCOPE only when the project is what refuses the work', () => {
  it('a member of the waiting work’s project refused for its repository is not told to grant the project', async () => {
    const factory = (await createWorker({ name: 'factory-1', createdByType: 'SYSTEM', createdById: 'test' })).id;
    await member(factory, projectId);
    await setWorkerRouting({ workerId: factory, families: ['FACTORY'], repositories: ['owner/other'], capabilities: [], reason: 'test', setBy: 'test' });
    const s = await surface('factory-1', factory);
    await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'factory work',
      objective: 'change code',
      manifest: { ...MANIFEST(projectId), repository: { remote: 'https://github.com/owner/fixture' } } as unknown as BinManifest,
      completionContract: 'DETERMINISTIC_UNITS_V1',
      workloadClass: 'FACTORY_UNITS',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    } as never);
    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId);
    expect(alert).toBeDefined();
    expect(alert!.problem).toBe('CANNOT_TAKE_WAITING_WORK');
    expect(alert!.action).not.toContain('access grant');
    expect(alert!.action).toContain('Repository');
    expect(alert!.detail).toContain('membership is not what refuses');
  });

  it('a worker outside the project is still OUT_OF_SCOPE, with the grant as its remedy', async () => {
    const tests = await createProject({ name: 'Step 10 acceptance', slug: 'step-10-acceptance' } as never);
    const caleb = (await createWorker({ name: 'caleb', createdByType: 'SYSTEM', createdById: 'test' })).id;
    await member(caleb, tests.id);
    await setWorkerRouting({ workerId: caleb, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
    const s = await surface('caleb-3a', caleb);
    await readyBin();
    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.problem).toBe('OUT_OF_SCOPE');
    expect(alert.action).toContain('access grant');
  });
});

describe('CON-5c: ordinary fires, probe fires and arrivals are three facts', () => {
  it('an idle surface that a probe fired and a session reached is not described as wholly inactive', async () => {
    const tests = await createProject({ name: 'Elsewhere', slug: 'elsewhere' } as never);
    const caleb = (await createWorker({ name: 'caleb-c', createdByType: 'SYSTEM', createdById: 'test' })).id;
    await member(caleb, tests.id);
    await setWorkerRouting({ workerId: caleb, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
    const s = await surface('caleb-3c', caleb);
    const token = await connector(caleb, 'https://brain.example/mcp');
    // A probe (not an ordinary fire) and the session it started arriving.
    await probeArrivingAs(s, caleb, token.accessId, 'cse_3C_P1', [tests.id]);
    await readyBin();
    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.activity?.lastOrdinaryFireAt).toBeNull();
    expect(alert.activity?.lastProbeFireAt).not.toBeNull();
    expect(alert.activity?.lastArrivalAt).not.toBeNull();
    expect(alert.detail).toContain('a recovery probe fired');
    expect(alert.detail).toContain('last session arrived');
  });
});

/* ------------------------------------------------------------------------ */
/* CON-6 · Brain's own outage is not the surface's recovery budget            */
/* ------------------------------------------------------------------------ */

async function settledProbe(routineId: string, accountId: string, at: number, outcome: { to: 'AMBIGUOUS' | 'NO_MCP'; health?: string; outcome: string }) {
  const probe = (await reserveRecoveryProbe({
    routineId,
    accountId,
    workerId: research,
    requestedById: AUTO_RECOVERY_ACTOR,
    authorityChannel: 'SYSTEM',
    expiresAt: new Date(at + RECOVERY_PROBE_WINDOW_MS).toISOString(),
  }))!;
  await getDb().run('UPDATE connector_recovery_probes SET created_at = ? WHERE id = ?', [new Date(at).toISOString(), probe.id]);
  await settleRecoveryProbe(probe.id, 'FIRING', { to: outcome.to, health: outcome.health ?? null, outcome: outcome.outcome });
  return probe.id;
}

describe('CON-6: an outage-ambiguous probe is not counted against the surface', () => {
  it('outage probes do not exhaust the budget; worker-failed probes still do', async () => {
    const s = await surface('caleb-3b', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    let clock = Date.now();
    // Three counted failures and one outage: not exhausted.
    for (let i = 0; i < AUTO_PROBE_LIMIT - 1; i += 1) {
      clock += 60_000;
      await settledProbe(s.routineId, s.accountId, clock, { to: 'NO_MCP', outcome: 'nothing arrived' });
    }
    clock += 60_000;
    await settledProbe(s.routineId, s.accountId, clock, {
      to: 'AMBIGUOUS',
      health: BRAIN_OUTAGE_HEALTH,
      outcome: 'The provider started x, and Brain itself was failing while that session would have arrived.',
    });
    expect(await autoRecoveryExhausted()).toEqual([]);
    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.problem).toBe('RECOVERING');
    expect(alert.who).toBe('NOBODY');
    // A fourth real failure exhausts it — ambiguity is not exempt in general.
    clock += 60_000;
    await settledProbe(s.routineId, s.accountId, clock, { to: 'NO_MCP', outcome: 'nothing arrived' });
    expect((await autoRecoveryExhausted()).map((e) => e.routineId)).toEqual([s.routineId]);
  });

  it('a legacy outage probe, settled before the mark existed, is recognised from the sentence Brain wrote', async () => {
    expect(
      probeAmbiguousByOutage({
        state: 'AMBIGUOUS',
        health: null,
        outcome: 'The provider started cse_x, and Brain itself was failing while that session would have arrived (its database did not answer, or it was restarting).',
      }),
    ).toBe(true);
    // Other ambiguity is not exempt: a fire that threw before the provider answered.
    expect(probeAmbiguousByOutage({ state: 'AMBIGUOUS', health: null, outcome: 'The fire threw before the provider answered (x).' })).toBe(false);
    expect(probeAmbiguousByOutage({ state: 'NO_MCP', health: BRAIN_OUTAGE_HEALTH, outcome: null })).toBe(false);
  });

  it('the allowance bounds uncounted outages, so a recurring "outage" still reaches a person', async () => {
    const s = await surface('caleb-loop', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    let clock = Date.now();
    for (let i = 0; i < OUTAGE_PROBE_ALLOWANCE + AUTO_PROBE_LIMIT; i += 1) {
      clock += 60_000;
      await settledProbe(s.routineId, s.accountId, clock, { to: 'AMBIGUOUS', health: BRAIN_OUTAGE_HEALTH, outcome: 'outage' });
    }
    const exhausted = await autoRecoveryExhausted();
    expect(exhausted.map((e) => e.routineId)).toEqual([s.routineId]);
    // And it does not tell the account owner to reconnect anything.
    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.who).toBe('OPERATOR');
    expect(alert.action.toLowerCase()).not.toContain('reconnect');
    // ...and it says Brain still checks it daily, rather than "spent" (Caleb 3-D, 2026-10-16).
    expect(alert.detail).toContain('Brain checks it again by itself at');
    expect(alert.detail).not.toContain("Brain's own automatic probes are spent");
  });

  it('a probe that ends inconclusive by outage is followed by the next eligible healthy-time probe', async () => {
    const s = await surface('caleb-next', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    let n = 0;
    const stub: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_NEXT${(n += 1)}`, fireEventId: 'f', routineId: target.routineId });
    const due = Date.now() + 16 * 60_000;
    // While Brain is felt failing, no probe is started at all.
    noteInfraFailure('POOLER_CHECKOUT_TIMEOUT', 'test', new Date(due - 60_000));
    expect(await autoProbeQuarantinedSurfaces({ force: true, fire: stub, now: due })).toBeNull();
    resetInfraCounters();
    const first = await autoProbeQuarantinedSurfaces({ force: true, fire: stub, now: due });
    expect(first).not.toBeNull();
    // Recorded at the instant the tick asked (the test clock), as production's would be.
    await getDb().run('UPDATE connector_recovery_probes SET created_at = ? WHERE id = ?', [new Date(due).toISOString(), first!]);
    await settleRecoveryProbe(first!, 'FIRED', { to: 'AMBIGUOUS', health: BRAIN_OUTAGE_HEALTH, outcome: 'outage' });
    // Not straight away (the backoff still applies), but at the same tier: not escalated.
    expect(await autoProbeQuarantinedSurfaces({ force: true, fire: stub, now: due + 60_000 })).toBeNull();
    const next = await autoProbeQuarantinedSurfaces({ force: true, fire: stub, now: due + 16 * 60_000 });
    expect(next).not.toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* INF-6a · the reauthorization pass reads one grant before any health       */
/* ------------------------------------------------------------------------ */

describe('INF-6a: no health computation for a quarantined surface until a grant is newer', () => {
  it('skips the identity_events scans with no new grant, and recovers when one arrives', async () => {
    const s = await surface('reauth', research);
    const old = await connector(research, 'https://brain.example/mcp');
    const made = await ensureConnector({ accountId: s.accountId, resource: '/mcp', workerId: research });
    await attachClient({ clientId: old.clientId, connectorId: made.id, source: 'OPERATOR' });
    await bindRoutineConnector(s.routineId, made.id);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: `${NO_SHOW_QUARANTINE_MARK} — test` });

    const scans = countStatements((sql) => /FROM identity_events/.test(sql));
    expect(await recoverReauthorizedSurfaces()).toEqual([]);
    expect(scans()).toBe(0);
    restore!();

    // A person re-consents: a new grant on the connector's client.
    await sleep(5);
    await issueGrant({ clientId: old.clientId, workerId: research, scope: '', resource: 'https://brain.example/mcp' });
    expect(await lastGrantForConnector(made.id)).not.toBeNull();
    expect(await recoverReauthorizedSurfaces()).toEqual([s.routineId]);
    expect((await getRoutine(s.routineId))!.state).toBe('ENABLED');
  });
});

/* ------------------------------------------------------------------------ */
/* INF-6e · dispatch heads read when something changed                       */
/* ------------------------------------------------------------------------ */

describe('INF-6e: the in-flight count and the no-show count are re-read on change', () => {
  it('reuses an unchanged in-flight count, and sees a new fire at once', async () => {
    process.env['BRAIN_INFLIGHT_REUSE_MS'] = '60000';
    forgetInFlight();
    const s = await surface('inflight', research);
    const now = Date.now();
    expect((await inFlightByRoutine(now)).get(s.routineId) ?? 0).toBe(0);
    const joins = countStatements((sql) => /JOIN bins b ON b.id = d.bin_id/.test(sql));
    await inFlightByRoutine(now + 1_000);
    expect(joins()).toBe(0);
    restore!();
    await fire(await readyBin(), s, 'cse_IF_1');
    expect((await inFlightByRoutine(Date.now())).get(s.routineId)).toBe(1);
  });

  it('the in-flight reuse is bounded in time, so a finished bin is seen within the interval', async () => {
    process.env['BRAIN_INFLIGHT_REUSE_MS'] = '50';
    forgetInFlight();
    const s = await surface('inflight-fall', research);
    const binId = await readyBin();
    await fire(binId, s, 'cse_IF_2');
    expect((await inFlightByRoutine(Date.now())).get(s.routineId)).toBe(1);
    await getDb().run("UPDATE bins SET state = 'COMPLETE' WHERE id = ?", [binId]);
    await sleep(80);
    expect((await inFlightByRoutine(Date.now())).get(s.routineId) ?? 0).toBe(0);
  });

  it('a no-show written since the last read still quarantines on the next tick', async () => {
    const s = await surface('noshow', research);
    // First tick reads (nothing to judge).
    await runDispatchTick();
    for (let i = 0; i < 3; i += 1) {
      const binId = await readyBin();
      await recordBinEvent({
        eventType: 'DISPATCH_NO_SHOW',
        binId,
        projectId,
        leaseGeneration: 0,
        routineId: s.routineId,
        routineRef: s.routineRef,
        outcome: 'NO_SHOW',
        reason: 'test',
      } as never);
    }
    const ticked = await runDispatchTick();
    expect(ticked.quarantinedForNoShow).toContain(s.routineId);
  });

  it('with no new no-show the full count is not re-read', async () => {
    await runDispatchTick();
    const reads = countStatements((sql) => /event_type = 'DISPATCH_NO_SHOW'/.test(sql) && /GROUP BY e.routine_id/.test(sql));
    await runDispatchTick();
    expect(reads()).toBe(0);
  });
});
