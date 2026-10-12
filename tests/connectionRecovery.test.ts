/**
 * Connections that recover without a person, and the ones that name exactly
 * which person and what — reproduced from two production cases.
 *
 *   Airyn, 2026-10-11: four Research Routines registered for one worker whose
 *   Claude configuration selected another Brain connector (worker-12). Every
 *   fired session arrived, authenticated, was offered nothing, and was charged
 *   as a no-show; 115 fires each. Two recovery probes then reported NO_MCP.
 *
 *   Caleb: four Routines eligible on every screen, never fired since
 *   2026-09-19, because their worker serves only test projects.
 *
 * Walked through the real check-in, the real no-show pass, the real tick
 * derivations and the real probe settlement. Only the provider's fire is
 * simulated.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createAccount,
  createRoutine,
  getRoutine,
  repointRoutineWorker,
  setRoutineState,
  getRoutineByRef,
} from '../server/repos/fleet.ts';
import { createWorker, grantMembership, setWorkerRouting } from '../server/repos/identity.ts';
import { findLiveToken, issueGrant, registerClient, touchToken } from '../server/repos/oauth.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  getBin,
  markDispatchRoutine,
  markDispatchSent,
  reopenNoShowDispatches,
} from '../server/repos/bins.ts';
import { createProject } from '../server/repos/projects.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { forgetRoutingHealth } from '../server/services/fleet/connectorHealth.ts';
import {
  WRONG_WORKER_MARK,
  quarantineWrongWorkerSurfaces,
  recoverRebindedSurfaces,
} from '../server/services/fleet/arrivalIdentity.ts';
import {
  AUTO_PROBE_LIMIT,
  AUTO_RECOVERY_ACTOR,
  autoProbeQuarantinedSurfaces,
  autoRecoveryExhausted,
} from '../server/services/fleet/autoRecovery.ts';
import { connectionAlerts } from '../server/services/fleet/connectionAlerts.ts';
import { RECOVERY_PROBE_WINDOW_MS, settleRecoveryProbes, startRecoveryProbe, type Fire } from '../server/services/fleet/recoveryProbe.ts';
import { getRecoveryProbe } from '../server/repos/recoveryProbes.ts';
import { shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import { capacityReading, withoutDiagnostics } from '../server/services/fleet/capacity.ts';
import { parseOAuthToken } from '../server/services/identity/secrets.ts';
import type { BinManifest, Principal, WorkerScope } from '../server/domain/types.ts';

const RESEARCH_SCOPES: WorkerScope[] = ['project:read', 'queue:claim', 'queue:complete'];
const PAST_GRACE = (): number => Date.now() + 3 * 60_000;
const NO_SHOW_REASON = shouldQuarantine({ consecutiveNoShows: 3, consecutiveFailures: 0 }).reason;

let projectId = '';
/** The research worker the Routines were registered for (production's worker-05). */
let research = '';
/** The identity Airyn's Claude Routine actually authenticated as (production's worker-12). */
let other = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  forgetRoutingHealth();
  research = (await createWorker({ name: 'research-shared', createdByType: 'SYSTEM', createdById: 'test' })).id;
  other = (await createWorker({ name: 'airyn-other', createdByType: 'SYSTEM', createdById: 'test' })).id;
  await member(research, projectId);
  await setWorkerRouting({ workerId: research, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
});

async function member(workerId: string, project: string): Promise<void> {
  await grantMembership({
    projectId: project,
    principalType: 'WORKER',
    principalId: workerId,
    role: 'MEMBER',
    scopes: RESEARCH_SCOPES,
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

async function researchBin(project = projectId): Promise<string> {
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

/** An OAuth access token for this worker at this endpoint, as a Claude connector holds. */
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

/** Brain fires this Routine for this bin and the provider answers with a session. */
async function fire(binId: string, s: Surface, session: string): Promise<void> {
  const bin = (await getBin(binId))!;
  await ensureDispatchIntent(bin);
  const intent = await claimDispatchIntent();
  expect(intent?.binId).toBe(binId);
  await markDispatchRoutine(intent!.id, s.routineId);
  await markDispatchSent(intent!.id, { routineRef: s.routineRef, routineId: s.routineId, sessionRef: session, projectId: bin.projectId });
}

async function arrive(workerId: string, accessId: string, session: string | null, memberOf: string[]) {
  await touchToken(accessId);
  const principal = {
    type: 'WORKER',
    id: workerId,
    handle: workerId,
    displayName: workerId,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: accessId,
    authMethod: 'OAUTH_BEARER',
    memberships: memberOf.map((p) => ({ projectId: p, principalType: 'WORKER', principalId: workerId, role: 'MEMBER', scopes: RESEARCH_SCOPES, active: true })),
    requestId: `req_${session}`,
  } as unknown as Principal;
  return checkIn({ principal, workerId, sessionRef: session });
}

async function events(routineId: string, type: string): Promise<number> {
  const row = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM bin_events WHERE routine_id = ? AND event_type = ?', [
    routineId,
    type,
  ]);
  return Number(row?.n ?? 0);
}

describe('a Routine whose Claude connector authenticates as another worker (Airyn)', () => {
  it('is stopped after one activation, charged no no-show, and named for what it is', async () => {
    const airyn = await surface('airyn-2a', research);
    const wrong = await connector(other, 'https://brain.example/mcp/factory');
    const bin = await researchBin();

    await fire(bin, airyn, 'cse_AIRYN2A');
    // The session arrives as worker-12, which may take nothing here.
    const result = await arrive(other, wrong.accessId, 'claude-code-session_AIRYN2A', []);
    expect(result.assigned).toBe(false);
    expect(await events(airyn.routineId, 'DISPATCH_WRONG_WORKER')).toBe(1);

    // The no-show pass sees an answer, not silence.
    await reopenNoShowDispatches(0, 50);
    expect(await events(airyn.routineId, 'DISPATCH_NO_SHOW')).toBe(0);
    expect(await events(airyn.routineId, 'DISPATCH_AUTH_NO_SHOW')).toBe(0);

    // One fire is enough: the tick takes it out of routing with the cause.
    // Not inside the grace period: the same session may still check in through its other connector.
    expect(await quarantineWrongWorkerSurfaces()).toEqual([]);
    expect(await quarantineWrongWorkerSurfaces(PAST_GRACE())).toEqual([airyn.routineId]);
    const stopped = (await getRoutine(airyn.routineId))!;
    expect(stopped.state).toBe('QUARANTINED');
    expect(stopped.stateReason).toContain(WRONG_WORKER_MARK);
    expect(stopped.stateReason).toContain(other);
    expect(stopped.stateReason).toContain('/mcp/factory');
    expect(stopped.stateReason).toContain('not an expired authorization');
    // Brain never adopts the wrong identity by itself.
    expect(stopped.workerId).toBe(research);

    // A second tick moves nothing; a second check-in by the same session records nothing new.
    expect(await quarantineWrongWorkerSurfaces(PAST_GRACE())).toEqual([]);
    await arrive(other, wrong.accessId, 'cse_AIRYN2A', []);
    expect(await events(airyn.routineId, 'DISPATCH_WRONG_WORKER')).toBe(1);

    // Every surface names it the same way, and the account owner is who acts.
    const { alerts } = await connectionAlerts();
    const alert = alerts.find((a) => a.routineId === airyn.routineId)!;
    expect(alert.problem).toBe('WRONG_WORKER');
    expect(alert.who).toBe('ACCOUNT_OWNER');
    expect(alert.action).toContain('repoint-worker');
    const reading = await capacityReading();
    const row = reading.surfaces.find((s) => s.routineId === airyn.routineId)!;
    expect(row.requiredAction?.problem).toBe('WRONG_WORKER');
    // A member is told what to do without trigger refs or commands.
    const plain = withoutDiagnostics(reading).surfaces.find((s) => s.routineId === airyn.routineId)!;
    expect(plain.requiredAction?.what).not.toContain('trig_');
    expect(plain.requiredAction?.what).not.toContain('repoint-worker');
  });

  it('comes back by itself, bound to the right connector, once an operator registers it for the worker it ran as', async () => {
    const airyn = await surface('airyn-2b', research);
    const wrong = await connector(other, 'https://brain.example/mcp/factory');
    const bin = await researchBin();
    await fire(bin, airyn, 'cse_AIRYN2B');
    await arrive(other, wrong.accessId, 'cse_AIRYN2B', []);
    await quarantineWrongWorkerSurfaces(PAST_GRACE());
    expect((await getRoutine(airyn.routineId))!.state).toBe('QUARANTINED');

    // Not before the registration matches — even with the worker made eligible.
    await member(other, projectId);
    expect(await recoverRebindedSurfaces()).toEqual([]);

    // The operator's decision; Brain only notices that the two now agree.
    expect(
      await repointRoutineWorker({ routineId: airyn.routineId, expectedWorkerId: research, workerId: other, actor: 'test', reason: 'test' }),
    ).toBe(true);
    expect(await recoverRebindedSurfaces()).toEqual([airyn.routineId]);
    expect((await getRoutine(airyn.routineId))!.state).toBe('ENABLED');
    // And a forgiven surface is not re-quarantined on the same evidence.
    expect(await quarantineWrongWorkerSurfaces(PAST_GRACE())).toEqual([]);
    // Its next fire arrives as the worker it is now registered for, works, and binds its connector.
    await fire(await researchBin(), airyn, 'cse_AIRYN2B_NEXT');
    const next = await arrive(other, wrong.accessId, 'cse_AIRYN2B_NEXT', [projectId]);
    expect(next.assigned).toBe(true);
    const back = (await getRoutine(airyn.routineId))!;
    expect(back.state).toBe('ENABLED');
    expect(back.connectorId).not.toBeNull();
  });

  it('a recovery probe reports the wrong connector instead of NO_MCP', async () => {
    const airyn = await surface('airyn-2c', research);
    await setRoutineState({ routineId: airyn.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    const wrong = await connector(other, 'https://brain.example/mcp/factory');
    const fire: Fire = async ({ target }) => ({ ok: true, sessionRef: 'cse_PROBE2C', fireEventId: 'f', routineId: target.routineId });
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire });
    await arrive(other, wrong.accessId, 'session_PROBE2C', []);
    // Still waiting: a matching arrival through the other connector may follow.
    await settleRecoveryProbes();
    expect((await getRecoveryProbe(probe.id))!.state).toBe('FIRED');
    await settleRecoveryProbes(Date.now() + RECOVERY_PROBE_WINDOW_MS + 1_000);
    const settled = (await getRecoveryProbe(probe.id))!;
    expect(settled.state).toBe('AMBIGUOUS');
    expect(settled.outcome).toContain('the Claude Routine selects the wrong one');
    expect(settled.nextAction).toContain('repoint-worker');
    expect(settled.nextAction).not.toContain('reconnect Brain in Claude');
    // And the quarantine carries the proven cause, so the alert names the
    // account owner instead of "Nothing to do" (production, Caleb's Factory
    // surface 3, 2026-10-11).
    const after = (await getRoutineByRef(airyn.routineRef))!;
    expect(after.state).toBe('QUARANTINED');
    expect(after.stateReason).toContain(WRONG_WORKER_MARK);
    const alert = (await connectionAlerts()).alerts.find((one) => one.routineId === airyn.routineId)!;
    expect(alert.problem).toBe('WRONG_WORKER');
    expect(alert.who).toBe('ACCOUNT_OWNER');
  });
});

describe('a probe never rewrites a hold a person placed', () => {
  it('keeps an operator quarantine as written when the probe proves the wrong worker', async () => {
    const airyn = await surface('airyn-held', research);
    const held = 'operator hold: billing switch in progress';
    await setRoutineState({ routineId: airyn.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: held });
    const wrong = await connector(other, 'https://brain.example/mcp/factory');
    const fire: Fire = async ({ target }) => ({ ok: true, sessionRef: 'cse_HELD1', fireEventId: 'f', routineId: target.routineId });
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire });
    await arrive(other, wrong.accessId, 'session_HELD1', []);
    await settleRecoveryProbes(Date.now() + RECOVERY_PROBE_WINDOW_MS + 1_000);
    expect((await getRecoveryProbe(probe.id))!.state).toBe('AMBIGUOUS');
    expect((await getRoutineByRef(airyn.routineRef))!.stateReason).toBe(held);
  });
});

describe('the review findings, pinned', () => {
  it('a session holding both connectors, arriving through each, is not a wrong-connector Routine', async () => {
    const s = await surface('both', research);
    const wrong = await connector(other, 'https://brain.example/mcp/factory');
    const right = await connector(research, 'https://brain.example/mcp');
    await fire(await researchBin(), s, 'cse_BOTH1');
    await arrive(other, wrong.accessId, 'cse_BOTH1', []);
    await arrive(research, right.accessId, 'cse_BOTH1', [projectId]);
    expect(await quarantineWrongWorkerSurfaces(PAST_GRACE())).toEqual([]);
    expect((await getRoutine(s.routineId))!.state).toBe('ENABLED');
  });

  it('old wrong-worker evidence does not re-enable a later, unrelated quarantine', async () => {
    const s = await surface('later', research);
    const wrong = await connector(other, 'https://brain.example/mcp/factory');
    await fire(await researchBin(), s, 'cse_LATER1');
    await arrive(other, wrong.accessId, 'cse_LATER1', []);
    await quarantineWrongWorkerSurfaces(PAST_GRACE());
    await member(other, projectId);
    await repointRoutineWorker({ routineId: s.routineId, expectedWorkerId: research, workerId: other, actor: 'test', reason: 'test' });
    expect(await recoverRebindedSurfaces()).toEqual([s.routineId]);
    // Weeks later it stops answering for some other reason and is quarantined for no-shows.
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    expect(await recoverRebindedSurfaces()).toEqual([]);
    expect((await getRoutine(s.routineId))!.state).toBe('QUARANTINED');
  });

  it('an exhausted recovery does not ask for a reconnect without proof consent is gone', async () => {
    const s = await surface('silent', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    let n = 0;
    const fire: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_SIL${(n += 1)}`, fireEventId: 'f', routineId: target.routineId });
    let clock = Date.now();
    for (let i = 0; i < AUTO_PROBE_LIMIT; i += 1) {
      clock += 25 * 60 * 60_000;
      await autoProbeQuarantinedSurfaces({ force: true, fire, now: clock });
      await settleRecoveryProbes(clock + RECOVERY_PROBE_WINDOW_MS + 1_000);
    }
    const alert = (await connectionAlerts()).alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.problem).toBe('RECOVERY_EXHAUSTED');
    expect(alert.action.toLowerCase()).not.toContain('reconnect');
  });
});

describe('a session that arrived and took nothing is not a no-show', () => {
  it('the registered worker, arriving and handed nothing it may take', async () => {
    const s = await surface('race', research);
    const token = await connector(research, 'https://brain.example/mcp');
    const bin = await researchBin();
    await fire(bin, s, 'cse_RACE1');
    // The session authenticates as the right worker and its request carries no
    // project it may claim in — so it is handed nothing, and the bin stays
    // claimable at the fire's generation exactly as for a session that never came.
    const result = await arrive(research, token.accessId, 'cse_RACE1', []);
    expect(result.assigned).toBe(false);
    expect((await getBin(bin))!.state).toBe('READY');
    expect(await events(s.routineId, 'DISPATCH_SESSION_ARRIVED')).toBe(1);
    await reopenNoShowDispatches(0, 50);
    expect(await events(s.routineId, 'DISPATCH_NO_SHOW')).toBe(0);
    // And its connector is attributed from the proven arrival.
    expect((await getRoutine(s.routineId))!.connectorId).not.toBeNull();
  });
});

describe('a quarantine Brain derived is probed again by Brain', () => {
  const later = (from: number): number => from + RECOVERY_PROBE_WINDOW_MS + 1_000;

  it('probes after its backoff and lifts the quarantine when the session arrives', async () => {
    const s = await surface('auto-ok', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    const token = await connector(research, 'https://brain.example/mcp');
    const fire: Fire = async ({ target }) => ({ ok: true, sessionRef: 'cse_AUTO1', fireEventId: 'f', routineId: target.routineId });

    // Not straight away: it waits out the first backoff.
    expect(await autoProbeQuarantinedSurfaces({ force: true, fire })).toBeNull();
    const due = Date.now() + 16 * 60_000;
    const probeId = await autoProbeQuarantinedSurfaces({ force: true, fire, now: due });
    expect(probeId).not.toBeNull();
    const probe = (await getRecoveryProbe(probeId!))!;
    expect(probe.requestedById).toBe(AUTO_RECOVERY_ACTOR);

    await arrive(research, token.accessId, 'cse_AUTO1', [projectId]);
    await settleRecoveryProbes();
    expect((await getRecoveryProbe(probeId!))!.state).toBe('HEALTHY');
    expect((await getRoutine(s.routineId))!.state).toBe('ENABLED');
  });

  it('stops after its ceiling and hands it to the account owner', async () => {
    const s = await surface('auto-dead', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
    let n = 0;
    const fire: Fire = async ({ target }) => ({ ok: true, sessionRef: `cse_DEAD${(n += 1)}`, fireEventId: 'f', routineId: target.routineId });
    let clock = Date.now();
    const started: string[] = [];
    for (let i = 0; i < AUTO_PROBE_LIMIT + 2; i += 1) {
      clock += 25 * 60 * 60_000; // past any backoff
      const id = await autoProbeQuarantinedSurfaces({ force: true, fire, now: clock });
      if (!id) continue;
      started.push(id);
      await settleRecoveryProbes(later(clock)); // nothing arrives: NO_MCP
      expect((await getRecoveryProbe(id))!.state).toBe('NO_MCP');
    }
    expect(started).toHaveLength(AUTO_PROBE_LIMIT);
    expect((await getRoutine(s.routineId))!.state).toBe('QUARANTINED');
    const exhausted = await autoRecoveryExhausted();
    expect(exhausted.map((e) => e.routineId)).toEqual([s.routineId]);
    const { alerts, stalled } = await connectionAlerts();
    expect(alerts.find((a) => a.routineId === s.routineId)?.problem).toBe('RECOVERY_EXHAUSTED');
    expect(stalled.map((a) => a.accountId)).toEqual([s.accountId]);
  });

  it('never probes a surface a person took out of routing', async () => {
    const s = await surface('held', research);
    await setRoutineState({ routineId: s.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: 'operator hold' });
    const fire: Fire = async () => {
      throw new Error('must not fire');
    };
    expect(await autoProbeQuarantinedSurfaces({ force: true, fire, now: Date.now() + 48 * 60 * 60_000 })).toBeNull();
  });
});

describe('a healthy account with nothing it may take (Caleb)', () => {
  it('is named, for an operator, without anybody widening its scope', async () => {
    const tests = await createProject({ name: 'Step 10 acceptance', slug: 'step-10-acceptance' } as never);
    const caleb = (await createWorker({ name: 'caleb', createdByType: 'SYSTEM', createdById: 'test' })).id;
    await member(caleb, tests.id);
    await setWorkerRouting({ workerId: caleb, families: ['RESEARCH', 'GENERAL'], repositories: [], capabilities: [], reason: 'test', setBy: 'test' });
    const s = await surface('caleb-3a', caleb);
    await researchBin(); // waiting in a project Caleb's worker is not part of

    const { alerts } = await connectionAlerts();
    const alert = alerts.find((a) => a.routineId === s.routineId)!;
    expect(alert.problem).toBe('OUT_OF_SCOPE');
    expect(alert.who).toBe('OPERATOR');
    expect(alert.projects?.served).toEqual(['Step 10 acceptance']);
    // The sentence project administrators read names no project.
    expect(alert.detail).not.toContain('Step 10 acceptance');
    expect(alert.action).toContain('access grant');
    // Reading it changed nothing.
    const memberships = await getDb().all('SELECT * FROM project_memberships WHERE principal_id = ?', [caleb]);
    expect(memberships).toHaveLength(1);
  });

  it('a Factory surface idle beside research work is not out of scope', async () => {
    const factory = (await createWorker({ name: 'factory', createdByType: 'SYSTEM', createdById: 'test' })).id;
    await member(factory, projectId);
    await setWorkerRouting({ workerId: factory, families: ['FACTORY'], repositories: ['owner/fixture'], capabilities: [], reason: 'test', setBy: 'test' });
    const s = await surface('factory-idle', factory);
    await researchBin();
    const { alerts } = await connectionAlerts();
    expect(alerts.find((a) => a.routineId === s.routineId)).toBeUndefined();
  });
});
