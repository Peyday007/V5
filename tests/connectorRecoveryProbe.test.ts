/**
 * The recovery probe: a quarantined, unattributed Routine obtains the proof
 * nothing else can obtain for it — without anybody guessing which OAuth client
 * is whose and without re-enabling the surface blind.
 *
 * Every case is walked through the real machinery: the probe bin is created
 * and pinned by `createProbeBin`, the fire is recorded where every arrival
 * reader looks, the session checks in through `checkIn` (admission, the pinned
 * guard, the arrival credit and the connector attribution all run), and the
 * outcome is settled exactly as the tick settles it. Only the provider's fire
 * endpoint is simulated.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createAccount, createRoutine, getRoutine, setRoutineState, unansweredFiresByRoutine } from '../server/repos/fleet.ts';
import { createWorker, grantMembership, recordIdentityEvent, setWorkerRouting } from '../server/repos/identity.ts';
import { findLiveToken, issueGrant, registerClient, touchToken } from '../server/repos/oauth.ts';
import { attachClient, bindRoutineConnector, connectorClient, ensureConnector } from '../server/repos/connectors.ts';
import { createBin, getBin, reopenNoShowDispatches } from '../server/repos/bins.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { connectorHealth, forgetRoutingHealth } from '../server/services/fleet/connectorHealth.ts';
import { recoverReauthorizedSurfaces } from '../server/services/fleet/connectorBinding.ts';
import { shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import {
  RECOVERY_PROBE_WINDOW_MS,
  RecoveryProbeRefused,
  settleRecoveryProbes,
  startRecoveryProbe,
  type Fire,
} from '../server/services/fleet/recoveryProbe.ts';
import {
  getRecoveryProbe,
  markRecoveryFired,
  recordRecoveryArrival,
  reserveRecoveryProbe,
  settleRecoveryProbe,
} from '../server/repos/recoveryProbes.ts';
import { parseOAuthToken } from '../server/services/identity/secrets.ts';
import type { BinManifest, Principal, WorkerScope } from '../server/domain/types.ts';

const RESOURCE = 'https://brain.example/mcp/factory';
let projectId = '';
let workerId = '';

interface Account {
  name: string;
  accountId: string;
  routineId: string;
  routineRef: string;
  clientId: string;
  accessId: string;
}

const NO_SHOW_REASON = shouldQuarantine({ consecutiveNoShows: 3, consecutiveFailures: 0 }).reason;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  forgetRoutingHealth();
  // One worker identity for every account: the exact shape in which "worker-10
  // arrived" proves nothing about whose connector it was.
  const worker = await createWorker({ name: 'factory-brain', createdByType: 'SYSTEM', createdById: 'test' });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:claim', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  // A Factory worker, as production's worker-10 is: an explicit, exhaustive
  // routing row naming the one repository it may be handed work in.
  await setWorkerRouting({
    workerId,
    families: ['FACTORY'],
    repositories: ['owner/fixture'],
    capabilities: [],
    reason: 'test',
    setBy: 'test',
  });
});

/** One Claude account: a quarantined, unattributed Routine and its own OAuth client, live and unattached. */
async function account(name: string, resource = RESOURCE): Promise<Account> {
  process.env[`SECRET_${name}`] = 'not-a-real-token';
  const acct = await createAccount({ provider: 'anthropic', name });
  const routine = await createRoutine({
    accountId: acct.id,
    routineRef: `trig_${name}`,
    name: `Factory ${name}`,
    tokenSecretName: `SECRET_${name}`,
    workerId,
  });
  await setRoutineState({ routineId: routine.id, from: 'ENABLED', to: 'QUARANTINED', reason: NO_SHOW_REASON });
  const client = await registerClient({
    clientName: `Factory Brain (${name})`,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    secretDigest: null,
    tokenAuthMethod: 'none',
  });
  const minted = await issueGrant({ clientId: client.clientId, workerId, scope: '', resource, now: Date.now() - 60_000 });
  const parsed = parseOAuthToken(minted.access)!;
  const live = (await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS'))!;
  return { name, accountId: acct.id, routineId: routine.id, routineRef: routine.routineRef, clientId: client.clientId, accessId: live.id };
}

/** The provider, accepting a fire and naming the session it started. */
function provider(session: string): { fire: Fire; fired: string[] } {
  const fired: string[] = [];
  return {
    fired,
    fire: async ({ target }) => {
      fired.push(target.routineId);
      return { ok: true, sessionRef: session, fireEventId: session, routineId: target.routineId };
    },
  };
}

/** A session checking in, authenticated with this account's access token, reporting a provider session. */
async function arrive(who: Account, sessionRef: string | null) {
  await touchToken(who.accessId); // the authentication of the request itself
  const principal: Principal = {
    type: 'WORKER',
    id: workerId,
    handle: 'worker-10',
    displayName: 'factory-brain',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: who.accessId,
    authMethod: 'OAUTH_BEARER',
    memberships: [
      {
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: ['project:read', 'queue:claim', 'queue:complete'],
        active: true,
      } as unknown as Principal['memberships'][number],
    ],
    requestId: `req_${who.name}`,
  };
  return checkIn({ principal, workerId, sessionRef });
}

/** Real work waiting in the same project, which a probe session must never be handed. */
async function realWork(): Promise<string> {
  const manifest: BinManifest = {
    objective: 'Real research work.',
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
    repository: { remote: 'https://github.com/owner/fixture', ref: 'main', baseSha: '', integrationBranch: '', pullRequest: null },
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: [],
  } as BinManifest;
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'real work',
    objective: 'real work',
    manifest,
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    priority: 9,
    workloadClass: 'FACTORY_UNITS',
  });
  return bin.id;
}

async function noShowEvents(routineId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM bin_events WHERE routine_id = ? AND event_type IN ('DISPATCH_NO_SHOW', 'DISPATCH_AUTH_NO_SHOW')",
    [routineId],
  );
  return Number(row?.n ?? 0);
}

const later = (): number => Date.now() + RECOVERY_PROBE_WINDOW_MS + 1_000;

describe('a recovery probe establishes attribution from its own fire', () => {
  it('an arrival authenticated as another worker is a conflict: nothing is adopted and the quarantine is not lifted', async () => {
    // Production, 2026-10-04: Brain Research A is bound to the research worker
    // on Cash Mode 1, and its Claude connector had been approved as a different
    // worker. The probe arrived healthy and the quarantine was lifted, so the
    // router went back to firing that worker's bins at a session handed none.
    // `attributeArrival` now refuses that arrival as a CONFLICT (dec6d83), so the
    // probe attributes nothing — and this pins the property the incident was
    // about: the surface stays out of routing.
    const airyn = await account('airyn');
    const stranger = await createWorker({ name: 'somebody-else', createdByType: 'SYSTEM', createdById: 'test' });
    const scopes: WorkerScope[] = ['project:read', 'queue:claim', 'queue:complete'];
    await grantMembership({ projectId, principalType: 'WORKER', principalId: stranger.id, role: 'MEMBER', scopes, grantedByType: 'SYSTEM', grantedById: 'test' });
    await setWorkerRouting({ workerId: stranger.id, families: ['FACTORY'], repositories: ['owner/fixture'], capabilities: [], reason: 'test', setBy: 'test' });
    const minted = await issueGrant({ clientId: airyn.clientId, workerId: stranger.id, scope: '', resource: RESOURCE, now: Date.now() - 60_000 });
    const parsed = parseOAuthToken(minted.access)!;
    const strangerAccess = (await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS'))!;

    const { fire } = provider('cse_MISBOUND1');
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire });
    await touchToken(strangerAccess.id);
    const principal = {
      type: 'WORKER',
      id: stranger.id,
      handle: 'worker-04',
      displayName: 'somebody-else',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: strangerAccess.id,
      authMethod: 'OAUTH_BEARER',
      memberships: [
        { projectId, principalType: 'WORKER', principalId: stranger.id, role: 'MEMBER', scopes, active: true },
      ],
      requestId: 'req_stranger',
    } as unknown as Principal;
    const arrival = await checkIn({ principal, workerId: stranger.id, sessionRef: 'cse_MISBOUND1' });
    expect(arrival.assigned).toBe(true);

    await settleRecoveryProbes();
    await settleRecoveryProbes(later());
    const settled = (await getRecoveryProbe(probe.id))!;
    // The contradiction is reported and nothing is attached to either worker.
    expect(settled.state).toBe('AMBIGUOUS');
    expect(settled.connectorId).toBeNull();
    expect(settled.outcome).toContain(workerId);
    expect(settled.outcome).toContain(stranger.id);
    // And the surface it was fired for stays out of routing.
    const routine = (await getRoutine(airyn.routineId))!;
    expect(routine.state).toBe('QUARANTINED');
    expect(routine.connectorId).toBeNull();
  });

  it('A/B: probes Airyn on a shared worker, binds only Airyn, and lifts the quarantine by itself', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    const real = await realWork();

    const { fire, fired } = provider('cse_AIRYN01');
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire });
    expect(probe.state).toBe('FIRED');
    expect(fired).toEqual(['trig_airyn']);
    // Not routed: the fire went to the quarantined surface, and only to it.
    expect((await getRoutine(airyn.routineId))!.state).toBe('QUARANTINED');

    // The session the fire started arrives, spelling its session the way a
    // worker does. It is handed the probe bin — not the real work beside it.
    const arrival = await arrive(airyn, 'claude-code-session_AIRYN01');
    expect(arrival.assigned).toBe(true);
    if (arrival.assigned) expect(arrival.assignment.binId).toBe(probe.binId);
    expect((await getBin(real))!.state).toBe('READY');

    await settleRecoveryProbes();
    const settled = (await getRecoveryProbe(probe.id))!;
    expect(settled.state).toBe('HEALTHY');
    expect(settled.clientId).toBe(airyn.clientId);
    expect(settled.connectorId).not.toBeNull();

    const airynRoutine = (await getRoutine(airyn.routineId))!;
    expect(airynRoutine.connectorId).toBe(settled.connectorId);
    expect(airynRoutine.state).toBe('ENABLED'); // nobody ran fleet set-state
    expect((await connectorHealth(settled.connectorId!))!.state).toBe('HEALTHY');

    // Caleb shares the worker and is untouched: still quarantined, still
    // unattributed, his client attached to nothing.
    const calebRoutine = (await getRoutine(caleb.routineId))!;
    expect(calebRoutine.state).toBe('QUARANTINED');
    expect(calebRoutine.connectorId).toBeNull();
    expect(await connectorClient(caleb.clientId)).toBeNull();
  });

  it('C: a connector proven to need consent is reported, with no ordinary no-show charged', async () => {
    const caleb = await account('caleb');
    const connector = await ensureConnector({ accountId: caleb.accountId, resource: '/mcp/factory', workerId });
    await attachClient({ clientId: caleb.clientId, connectorId: connector.id, source: 'OPERATOR' });
    await bindRoutineConnector(caleb.routineId, connector.id);
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'OAUTH_TOKEN',
      targetType: 'OAUTH',
      targetId: workerId,
      result: 'DENIED',
      metadata: { clientId: caleb.clientId, grant: 'refresh_token', reason: 'REVOKED' },
    });
    expect((await connectorHealth(connector.id))!.state).toBe('HUMAN_REAUTH_REQUIRED');

    const probe = await startRecoveryProbe({ routineRef: caleb.routineRef, requestedById: 'usr_admin', fire: provider('cse_CALEB01').fire });
    // Nothing arrives: a session whose connector cannot authenticate never checks in.
    expect(await reopenNoShowDispatches(0, 50)).toEqual([]);
    await settleRecoveryProbes(later());

    const settled = (await getRecoveryProbe(probe.id))!;
    expect(settled.state).toBe('REAUTH_REQUIRED');
    expect(settled.connectorId).toBe(connector.id);
    expect(settled.nextAction).toContain(`connectors reconnect ${connector.id}`);
    expect(await noShowEvents(caleb.routineId)).toBe(0);
    expect((await unansweredFiresByRoutine()).get(caleb.routineId) ?? 0).toBe(0);
    expect((await getBin(probe.binId!))!.state).toBe('CANCELLED');
  });

  it('D: a session that starts and never reaches Brain attaches nothing and charges nothing', async () => {
    const airyn = await account('airyn');
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_SILENT').fire });

    // The no-show pass leaves the probe alone, even long after the fire.
    expect(await reopenNoShowDispatches(0, 50)).toEqual([]);
    await settleRecoveryProbes(later());

    const settled = (await getRecoveryProbe(probe.id))!;
    expect(settled.state).toBe('NO_MCP');
    expect(settled.connectorId).toBeNull();
    expect(settled.nextAction).toContain('probe trig_airyn again');
    const routine = (await getRoutine(airyn.routineId))!;
    expect(routine.state).toBe('QUARANTINED');
    expect(routine.connectorId).toBeNull();
    expect(await connectorClient(airyn.clientId)).toBeNull();
    expect(await noShowEvents(airyn.routineId)).toBe(0);
    // The Brain's probe slot is free again.
    const next = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_SECOND').fire });
    expect(next.state).toBe('FIRED');
  });

  it('E: an arrival that does not prove one connector attaches nothing', async () => {
    // Caleb's research connector (worker-04) sits at the same endpoint the
    // Factory session arrives on as worker-10. Same person, two workers: not
    // one connector, and the probe will not weld them together.
    const caleb = await account('caleb', 'https://brain.example/mcp');
    const research = await createWorker({ name: 'research-caleb', createdByType: 'SYSTEM', createdById: 'test' });
    const researchConnector = await ensureConnector({ accountId: caleb.accountId, resource: '/mcp', workerId: research.id });

    const probe = await startRecoveryProbe({ routineRef: caleb.routineRef, requestedById: 'usr_admin', fire: provider('cse_CALEBF').fire });
    const arrival = await arrive(caleb, 'session_CALEBF');
    expect(arrival.assigned).toBe(true);
    await settleRecoveryProbes();

    const settled = (await getRecoveryProbe(probe.id))!;
    expect(settled.state).toBe('AMBIGUOUS');
    expect(settled.outcome).toContain('two workers are not one connector');
    expect(await connectorClient(caleb.clientId)).toBeNull();
    expect((await getRoutine(caleb.routineId))!.connectorId).toBeNull();
    expect((await getRoutine(caleb.routineId))!.state).toBe('QUARANTINED');
    const rows = await getDb().all<{ client_id: string }>('SELECT client_id FROM connector_clients WHERE connector_id = ?', [
      researchConnector.id,
    ]);
    expect(rows).toEqual([]);
  });

  it('F: a replayed or stale probe session binds nothing and is handed nothing', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    const real = await realWork();
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_STALE').fire });
    await settleRecoveryProbes(later()); // never arrived: NO_MCP, bin retired
    expect((await getRecoveryProbe(probe.id))!.state).toBe('NO_MCP');

    // The session turns up late, or somebody replays its id with another account's credential.
    const late = await arrive(caleb, 'claude-code-session_STALE');
    expect(late.assigned).toBe(false);
    expect((await getBin(real))!.state).toBe('READY');
    await settleRecoveryProbes(later());
    expect((await getRecoveryProbe(probe.id))!.state).toBe('NO_MCP');
    expect(await connectorClient(caleb.clientId)).toBeNull();
    expect(await connectorClient(airyn.clientId)).toBeNull();
    expect((await getRoutine(airyn.routineId))!.connectorId).toBeNull();
  });

  it('G: another Routine cannot take or use a probe meant for someone else, and probes run one at a time', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_ONLYAIRYN').fire });

    // A second probe while one is live is refused outright.
    await expect(
      startRecoveryProbe({ routineRef: caleb.routineRef, requestedById: 'usr_admin', fire: provider('cse_X').fire }),
    ).rejects.toBeInstanceOf(RecoveryProbeRefused);

    // Caleb's own session (not the probe's) is not offered Airyn's probe bin.
    const caleb1 = await arrive(caleb, 'claude-code-session_CALEBOWN');
    expect(caleb1.assigned).toBe(false);
    expect((await getBin(probe.binId!))!.state).toBe('READY');
    await settleRecoveryProbes();
    expect((await getRecoveryProbe(probe.id))!.state).toBe('FIRED');
    expect((await getRoutine(caleb.routineId))!.connectorId).toBeNull();
    expect(await connectorClient(caleb.clientId)).toBeNull();
  });

  it('H: reconnect after a probe restores the same connector, and the quarantine lifts by itself', async () => {
    const caleb = await account('caleb');
    const connector = await ensureConnector({ accountId: caleb.accountId, resource: '/mcp/factory', workerId });
    await attachClient({ clientId: caleb.clientId, connectorId: connector.id, source: 'OPERATOR' });
    await bindRoutineConnector(caleb.routineId, connector.id);
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'OAUTH_TOKEN',
      targetType: 'OAUTH',
      targetId: workerId,
      result: 'DENIED',
      metadata: { clientId: caleb.clientId, grant: 'refresh_token', reason: 'REVOKED' },
    });
    const probe = await startRecoveryProbe({ routineRef: caleb.routineRef, requestedById: 'usr_admin', fire: provider('cse_H').fire });
    await settleRecoveryProbes(later());
    expect((await getRecoveryProbe(probe.id))!.state).toBe('REAUTH_REQUIRED');

    // The person reconnects: Claude registers a new client, consent attaches it
    // to the connector it was bound to, and a grant is issued.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await registerClient({
      clientName: 'Factory Brain (caleb, again)',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    await attachClient({ clientId: fresh.clientId, connectorId: connector.id, source: 'OPERATOR' });
    await issueGrant({ clientId: fresh.clientId, workerId, scope: '', resource: RESOURCE });
    forgetRoutingHealth();

    expect((await connectorHealth(connector.id))!.state).toBe('HEALTHY');
    expect(await recoverReauthorizedSurfaces()).toEqual([caleb.routineId]);
    const routine = (await getRoutine(caleb.routineId))!;
    expect(routine.state).toBe('ENABLED');
    expect(routine.connectorId).toBe(connector.id);
  });
});

describe('an arrival that reports no session during a probe', () => {
  it('is offered nothing, attributes nothing, and settles the probe as AMBIGUOUS rather than NO_MCP', async () => {
    const airyn = await account('airyn');
    const real = await realWork();
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_NOREF').fire });

    // It may be the probe's own session that left session_ref out. It must not
    // be handed real work on a surface Brain quarantined.
    const arrival = await arrive(airyn, null);
    expect(arrival.assigned).toBe(false);
    expect((await getBin(real))!.state).toBe('READY');

    await settleRecoveryProbes(later());
    const settled = (await getRecoveryProbe(probe.id))!;
    expect(settled.state).toBe('AMBIGUOUS');
    expect(settled.outcome).toContain('no provider session');
    expect(await connectorClient(airyn.clientId)).toBeNull();
    expect((await getRoutine(airyn.routineId))!.connectorId).toBeNull();
  });

  it('does not hold up a surface whose client already belongs to a connector', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    const connector = await ensureConnector({ accountId: caleb.accountId, resource: '/mcp/factory', workerId });
    await attachClient({ clientId: caleb.clientId, connectorId: connector.id, source: 'OPERATOR' });
    const real = await realWork();
    await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_A2').fire });

    const arrival = await arrive(caleb, null);
    expect(arrival.assigned).toBe(true);
    if (arrival.assigned) expect(arrival.assignment.binId).toBe(real);
  });
});

describe('a lift that did not happen', () => {
  it('is re-derived by the tick when the process stopped between proving and lifting', async () => {
    const airyn = await account('airyn');
    const connector = await ensureConnector({ accountId: airyn.accountId, resource: '/mcp/factory', workerId });
    await attachClient({ clientId: airyn.clientId, connectorId: connector.id, source: 'OBSERVED_ARRIVAL' });
    await bindRoutineConnector(airyn.routineId, connector.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const probe = (await reserveRecoveryProbe({
      routineId: airyn.routineId,
      accountId: airyn.accountId,
      workerId,
      requestedById: 'usr_admin',
      authorityChannel: 'SHELL',
      expiresAt: new Date(Date.now() + RECOVERY_PROBE_WINDOW_MS).toISOString(),
    }))!;
    await markRecoveryFired(probe.id, 'cse_CRASH');
    await recordRecoveryArrival(probe.id, { credentialId: airyn.accessId, clientId: airyn.clientId, arrivedAt: new Date().toISOString() });
    // Claimed HEALTHY, then the process died before setRoutineState.
    await settleRecoveryProbe(probe.id, 'FIRED', { to: 'HEALTHY', connectorId: connector.id, outcome: 'Proven' });
    expect((await getRoutine(airyn.routineId))!.state).toBe('QUARANTINED');

    await settleRecoveryProbes();
    expect((await getRoutine(airyn.routineId))!.state).toBe('ENABLED');
  });
});

describe('what a probe refuses', () => {
  it('will not probe a surface a person switched off, or one with nothing to recover', async () => {
    const airyn = await account('airyn');
    await setRoutineState({ routineId: airyn.routineId, from: 'QUARANTINED', to: 'DRAINING', reason: 'operator drained it' });
    await expect(
      startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: provider('cse_N').fire }),
    ).rejects.toThrow(/DRAINING/);
  });

  it('records a provider refusal without touching attribution or the surface', async () => {
    const airyn = await account('airyn');
    const refused: Fire = async ({ target }) => ({
      ok: false,
      kind: 'AUTH',
      message: '401 token not authorized',
      retryAfterMs: null,
      routineId: target.routineId,
    });
    const probe = await startRecoveryProbe({ routineRef: airyn.routineRef, requestedById: 'usr_admin', fire: refused });
    expect(probe.state).toBe('PROVIDER_REFUSED');
    expect((await getBin(probe.binId!))!.state).toBe('CANCELLED');
    const routine = (await getRoutine(airyn.routineId))!;
    expect(routine.state).toBe('QUARANTINED');
    expect(routine.connectorId).toBeNull();
  });
});

describe('a mechanism something calls', () => {
  it('is settled by the dispatch tick, not only by the operator command', async () => {
    const { readFileSync } = await import('node:fs');
    const loop = readFileSync('server/services/dispatch/loop.ts', 'utf8');
    expect(loop).toContain("await import('../fleet/recoveryProbe.ts')");
    expect(loop).toContain('await settleRecoveryProbes()');
  });
});
