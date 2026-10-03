/**
 * The connector lifecycle: the cycle this exists to end is
 *
 *   healthy -> refresh reply lost -> client stops -> Routine fires -> no MCP ->
 *   no check-in -> no-show -> quarantine -> person reconnects -> repeat.
 *
 * Each case below is one link of it, asserted from rows. The refresh half is in
 * `oauthRefreshRecovery.test.ts`; this is the identity, the health, the
 * dispatch and the recovery.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createAccount, createRoutine, getRoutine, setRoutineState, unansweredFiresByRoutine } from '../server/repos/fleet.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import {
  CONCURRENT_REFRESH_LEEWAY_MS,
  findLiveToken,
  findPresentedToken,
  issueGrant,
  registerClient,
  revokeTokenChain,
  revokeTokensForClients,
  rotateRefreshToken,
  touchToken,
} from '../server/repos/oauth.ts';
import { attachClient, connectorClient, ensureConnector, getConnector, bindRoutineConnector } from '../server/repos/connectors.ts';
import {
  AUTH_NO_SHOW_LIMIT,
  connectorHealth,
  forgetRoutingHealth,
} from '../server/services/fleet/connectorHealth.ts';
import {
  observeConnectorArrival,
  reconcileConnectorBindings,
  recoverReauthorizedSurfaces,
} from '../server/services/fleet/connectorBinding.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  markDispatchRoutine,
  markDispatchSent,
  reopenNoShowDispatches,
} from '../server/repos/bins.ts';
import { fleetSnapshot } from '../server/services/dispatch/candidates.ts';
import { surfaceIneligibility } from '../server/services/dispatch/router.ts';
import { recordIdentityEvent } from '../server/repos/identity.ts';
import { parseOAuthToken } from '../server/services/identity/secrets.ts';
import { shouldQuarantine } from '../server/services/dispatch/scaler.ts';
import type { BinManifest } from '../server/domain/types.ts';

const RESOURCE = 'https://brain.example/mcp/factory';
let projectId = '';
let workerId = '';

interface Account {
  accountId: string;
  routineId: string;
  clientId: string;
  connectorId: string;
  refresh: string;
  access: string;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  forgetRoutingHealth();
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
});

/** One Claude account: its Routine, its own OAuth client and its own grant, all for one shared worker. */
async function account(name: string): Promise<Account> {
  process.env[`SECRET_${name}`] = 'not-a-real-token';
  const acct = await createAccount({ provider: 'anthropic', name });
  const routine = await createRoutine({
    accountId: acct.id,
    routineRef: `trig_${name}`,
    name: `Factory ${name}`,
    tokenSecretName: `SECRET_${name}`,
    workerId,
  });
  const client = await registerClient({
    clientName: `Factory Brain (${name})`,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    secretDigest: null,
    tokenAuthMethod: 'none',
  });
  const minted = await issueGrant({ clientId: client.clientId, workerId, scope: '', resource: RESOURCE });
  const connector = await ensureConnector({ accountId: acct.id, resource: '/mcp/factory', workerId });
  await attachClient({ clientId: client.clientId, connectorId: connector.id, source: 'OPERATOR' });
  await bindRoutineConnector(routine.id, connector.id);
  return {
    accountId: acct.id,
    routineId: routine.id,
    clientId: client.clientId,
    connectorId: connector.id,
    refresh: minted.refresh,
    access: minted.access,
  };
}

async function use(access: string): Promise<void> {
  const parsed = parseOAuthToken(access)!;
  const live = await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS');
  if (!live) throw new Error('access token not live');
  await touchToken(live.id);
}

async function rotate(refresh: string, now?: number) {
  const parsed = parseOAuthToken(refresh)!;
  const found = (await findPresentedToken(parsed.prefix, parsed.secret, 'REFRESH'))!;
  return rotateRefreshToken({ tokenId: found.id, presentedSecret: parsed.secret, ...(now ? { now } : {}) });
}

/** Shift this client's history `ms` into the past, keeping its order — as if nobody picked the reply up. */
async function age(clientId: string, ms: number): Promise<void> {
  const rows = await getDb().all<{ id: string; created_at: string; last_used_at: string | null }>(
    'SELECT id, created_at, last_used_at FROM oauth_tokens WHERE client_id = ?',
    [clientId],
  );
  const back = (iso: string | null): string | null => (iso ? new Date(Date.parse(iso) - ms).toISOString() : null);
  for (const row of rows) {
    await getDb().run('UPDATE oauth_tokens SET created_at = ?, last_used_at = ?, first_used_at = ? WHERE id = ?', [
      back(row.created_at),
      back(row.last_used_at),
      back(row.last_used_at),
      row.id,
    ]);
  }
}

function manifest(): BinManifest {
  return {
    objective: 'A bin a surface is fired for.',
    why: 'The lifecycle needs a fire to go unanswered.',
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

/** Brain fires the Routine for a bin, and the in-flight window closes with nobody arriving. */
async function unansweredFire(routineId: string): Promise<void> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'fired, unanswered',
    objective: 'go unanswered',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  await ensureDispatchIntent(bin);
  const intent = (await claimDispatchIntent())!;
  await markDispatchRoutine(intent.id, routineId);
  await markDispatchSent(intent.id, { routineRef: 'trig_x', routineId, projectId });
  await getDb().run('UPDATE bin_dispatch SET sent_at = ? WHERE id = ?', [
    new Date(Date.now() - 2 * 3_600_000).toISOString(),
    intent.id,
  ]);
  await reopenNoShowDispatches(60 * 60_000, 50);
}

async function eventsOf(type: string, routineId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM bin_events WHERE event_type = ? AND routine_id = ?',
    [type, routineId],
  );
  return Number(row!.n);
}

describe('one identity per connector, even when every account is worker-10', () => {
  it('I. reads Airyn’s and Caleb’s connectors independently although both authenticate as one worker', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    await use(caleb.access);
    // Airyn's client presents a refresh token Brain will not honour.
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'OAUTH_TOKEN',
      targetType: 'OAUTH',
      targetId: workerId,
      result: 'DENIED',
      metadata: { clientId: airyn.clientId, grant: 'refresh_token', reason: 'REVOKED' },
    });
    const a = (await connectorHealth(airyn.connectorId))!;
    const c = (await connectorHealth(caleb.connectorId))!;
    expect(a.state).toBe('HUMAN_REAUTH_REQUIRED');
    expect(a.reason).toBe('CLIENT_HOLDS_REFUSED_CREDENTIAL');
    expect(c.state).toBe('HEALTHY');

    // And routing reads the same answer: Airyn's surface is not fired, Caleb's is.
    const snapshot = await fleetSnapshot();
    const byRoutine = new Map(snapshot.candidates.map((x) => [x.routine.id, x]));
    expect(surfaceIneligibility(byRoutine.get(airyn.routineId)!)).toContain('connector needs re-authorization');
    expect(surfaceIneligibility(byRoutine.get(caleb.routineId)!)).toBeNull();
  });

  it('attributes a client from an arrival only when it is provably the fired session', async () => {
    const airyn = await account('airyn');
    await account('caleb');
    // A second client nobody has attributed, arriving on Airyn's Routine.
    const stray = await registerClient({
      clientName: 'stray',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    const minted = await issueGrant({ clientId: stray.clientId, workerId, scope: '', resource: RESOURCE });
    const parsed = parseOAuthToken(minted.access)!;
    const token = (await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS'))!;

    // Worker-10 is in two accounts, so an unproven arrival proves nothing.
    expect(
      await observeConnectorArrival({ routineId: airyn.routineId, workerId, credentialId: token.id, proven: false }),
    ).toBe('NOT_EVIDENCE');
    // A matched provider session is proof, and a second observation changes nothing.
    expect(
      await observeConnectorArrival({ routineId: airyn.routineId, workerId, credentialId: token.id, proven: true }),
    ).toBe('BOUND');
    expect(
      await observeConnectorArrival({ routineId: airyn.routineId, workerId, credentialId: token.id, proven: true }),
    ).toBe('ALREADY');
    const connector = await getDb().get<{ connector_id: string }>(
      'SELECT connector_id FROM connector_clients WHERE client_id = ?',
      [stray.clientId],
    );
    expect(connector?.connector_id).toBe(airyn.connectorId);
  });

  it('a reconnect’s new OAuth client attaches to the same logical connector and its Routines', async () => {
    const airyn = await account('airyn');
    const fresh = await registerClient({
      clientName: 'Factory Brain (airyn, reconnected)',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    expect(await attachClient({ clientId: fresh.clientId, connectorId: airyn.connectorId, source: 'BOUND_INVITATION' })).toBe(
      'ATTACHED',
    );
    // The reconnect comes after the original grant, as it does in production.
    await age(airyn.clientId, 60_000);
    await issueGrant({ clientId: fresh.clientId, workerId, scope: '', resource: RESOURCE });
    const health = (await connectorHealth(airyn.connectorId))!;
    expect(health.clientIds).toEqual(expect.arrayContaining([airyn.clientId, fresh.clientId]));
    expect(health.currentClientId).toBe(fresh.clientId);
    expect((await getRoutine(airyn.routineId))!.connectorId).toBe(airyn.connectorId);
    // And a client is never re-pointed to another connector silently.
    const caleb = await account('caleb');
    expect(await attachClient({ clientId: fresh.clientId, connectorId: caleb.connectorId, source: 'OPERATOR' })).toBe(
      'CONFLICT',
    );
  });

  it('derives bindings for connectors that existed before, and refuses an ambiguous one', async () => {
    const acctA = await createAccount({ provider: 'anthropic', name: 'owner' });
    const routine = await createRoutine({
      accountId: acctA.id,
      routineRef: 'trig_owner',
      name: 'Brain Research A',
      tokenSecretName: 'X',
      workerId,
    });
    const client = await registerClient({
      clientName: 'cloud-brain',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    const minted = await issueGrant({ clientId: client.clientId, workerId, scope: '', resource: 'https://brain.example/mcp' });
    const parsed = parseOAuthToken(minted.access)!;
    const token = (await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS'))!;
    await getDb().run(
      `INSERT INTO worker_sessions (session_ref, worker_id, routine_id, account_id, bin_id, lease_generation, observed_at)
       VALUES (?, ?, ?, ?, 'bin_x', 1, ?)`,
      [token.id, workerId, routine.id, acctA.id, new Date().toISOString()],
    );
    const result = await reconcileConnectorBindings();
    expect(result.attached).toBe(1);
    const bound = (await getRoutine(routine.id))!;
    expect(bound.connectorId).not.toBeNull();
    const connector = (await getConnector(bound.connectorId!))!;
    expect(connector.resource).toBe('/mcp');
    expect(connector.accountId).toBe(acctA.id);

    // The same client observed under a second account is ambiguous: no guess.
    const other = await registerClient({
      clientName: 'shared?',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    const otherMint = await issueGrant({ clientId: other.clientId, workerId, scope: '', resource: RESOURCE });
    const op = parseOAuthToken(otherMint.access)!;
    const ot = (await findLiveToken(op.prefix, op.secret, 'ACCESS'))!;
    const acctB = await createAccount({ provider: 'anthropic', name: 'friend' });
    for (const acct of [acctA.id, acctB.id]) {
      await getDb().run(
        `INSERT INTO worker_sessions (session_ref, worker_id, routine_id, account_id, bin_id, lease_generation, observed_at)
         VALUES (?, ?, ?, ?, 'bin_y', 1, ?)`,
        [`${ot.id}-${acct}`, workerId, routine.id, acct, new Date().toISOString()],
      );
    }
    // Two observations of the same token cannot share a session_ref, so the
    // second account is recorded against a sibling access token of that client.
    const second = await issueGrant({ clientId: other.clientId, workerId, scope: '', resource: RESOURCE });
    const sp = parseOAuthToken(second.access)!;
    const st = (await findLiveToken(sp.prefix, sp.secret, 'ACCESS'))!;
    await getDb().run('UPDATE worker_sessions SET session_ref = ? WHERE session_ref = ?', [ot.id, `${ot.id}-${acctA.id}`]);
    await getDb().run('UPDATE worker_sessions SET session_ref = ? WHERE session_ref = ?', [st.id, `${ot.id}-${acctB.id}`]);
    const again = await reconcileConnectorBindings();
    expect(again.ambiguous).toContain(other.clientId);
  });
});

describe('a shared worker’s unproven arrivals attribute nothing', () => {
  it('does not attach a client from sessions recorded under one of several accounts the worker serves', async () => {
    const airyn = await account('airyn');
    await account('caleb'); // the worker now serves two accounts
    const stray = await registerClient({
      clientName: 'Factory Brain (who?)',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    const minted = await issueGrant({ clientId: stray.clientId, workerId, scope: '', resource: RESOURCE });
    const parsed = parseOAuthToken(minted.access)!;
    const token = (await findLiveToken(parsed.prefix, parsed.secret, 'ACCESS'))!;
    // Recorded under Airyn's account because Airyn's Routine was the one fired.
    await getDb().run(
      `INSERT INTO worker_sessions (session_ref, worker_id, routine_id, account_id, bin_id, lease_generation, observed_at)
       VALUES (?, ?, ?, ?, 'bin_s', 1, ?)`,
      [token.id, workerId, airyn.routineId, airyn.accountId, new Date().toISOString()],
    );
    await reconcileConnectorBindings();
    expect(await connectorClient(stray.clientId)).toBeNull();
  });
});

describe('an auth failure is not a no-show', () => {
  it('H. charges an unanswered fire at a recoverable connector to auth, then asks for consent at the limit', async () => {
    const airyn = await account('airyn');
    await use(airyn.access);
    // Claude refreshes; the reply is lost; nothing is ever picked up.
    await rotate(airyn.refresh);
    await age(airyn.clientId, CONCURRENT_REFRESH_LEEWAY_MS + 60_000);
    expect((await connectorHealth(airyn.connectorId))!.state).toBe('REFRESH_RECOVERABLE');

    for (let i = 0; i < AUTH_NO_SHOW_LIMIT; i += 1) await unansweredFire(airyn.routineId);
    expect(await eventsOf('DISPATCH_AUTH_NO_SHOW', airyn.routineId)).toBe(AUTH_NO_SHOW_LIMIT);
    expect(await eventsOf('DISPATCH_NO_SHOW', airyn.routineId)).toBe(0);
    // The quarantine count does not see them.
    expect((await unansweredFiresByRoutine()).get(airyn.routineId) ?? 0).toBe(0);

    const health = (await connectorHealth(airyn.connectorId))!;
    expect(health.state).toBe('HUMAN_REAUTH_REQUIRED');
    expect(health.reason).toBe('CLIENT_STOPPED_RETRYING');
  });

  it('still counts a real no-show at a healthy connector, so a dead surface is still quarantined', async () => {
    const caleb = await account('caleb');
    await use(caleb.access);
    for (let i = 0; i < 3; i += 1) await unansweredFire(caleb.routineId);
    expect(await eventsOf('DISPATCH_NO_SHOW', caleb.routineId)).toBe(3);
    const count = (await unansweredFiresByRoutine()).get(caleb.routineId) ?? 0;
    expect(shouldQuarantine({ consecutiveNoShows: count, consecutiveFailures: 0 }).quarantine).toBe(true);
  });
});

describe('recovery needs nobody but the person who consents', () => {
  it('a lost reply self-heals on the next retry and the connector reads healthy again', async () => {
    const owner = await account('owner');
    await use(owner.access);
    const lost = await rotate(owner.refresh);
    await age(owner.clientId, CONCURRENT_REFRESH_LEEWAY_MS + 60_000);
    expect((await connectorHealth(owner.connectorId))!.state).toBe('REFRESH_RECOVERABLE');
    // The Routine's next session retries 68 minutes later with the old token.
    const retried = await rotate(owner.refresh, Date.now() + 68 * 60_000);
    expect(retried.ok && lost.ok && retried.minted.refresh === lost.minted.refresh).toBe(true);
    if (retried.ok) await use(retried.minted.access);
    expect((await connectorHealth(owner.connectorId))!.state).toBe('HEALTHY');
  });

  /*
   * The CI gate on 8462042e failed the test above with HEALTHY: the grant and
   * its successor were written in one millisecond, and the tip was chosen by
   * time with a random-id tiebreak. Forced here rather than hoped for.
   */
  it('reads the lineage, not the clock, when a grant and its successor share a millisecond', async () => {
    const owner = await account('owner');
    await use(owner.access);
    const lost = await rotate(owner.refresh);
    expect(lost.ok).toBe(true);
    const refreshes = await getDb().all<{ id: string; parent_token_id: string | null }>(
      "SELECT id, parent_token_id FROM oauth_tokens WHERE client_id = ? AND kind = 'REFRESH'",
      [owner.clientId],
    );
    const grant = refreshes.find((one) => one.parent_token_id === null)!;
    const successor = refreshes.find((one) => one.parent_token_id === grant.id)!;
    const at = new Date(Date.now() - CONCURRENT_REFRESH_LEEWAY_MS - 60_000).toISOString();
    await getDb().run('UPDATE oauth_tokens SET created_at = ? WHERE client_id = ?', [at, owner.clientId]);
    // And the id order that made the old query pick the grant: the successor
    // renamed to sort below it, with its access token following it.
    const lowId = 'oat_00000000000000000000';
    expect(lowId < grant.id).toBe(true);
    await getDb().run('UPDATE oauth_tokens SET parent_token_id = ? WHERE parent_token_id = ?', [lowId, successor.id]);
    await getDb().run('UPDATE oauth_tokens SET id = ? WHERE id = ?', [lowId, successor.id]);
    await getDb().run(
      'UPDATE oauth_tokens SET last_used_at = ?, first_used_at = ? WHERE client_id = ? AND last_used_at IS NOT NULL',
      [at, at, owner.clientId],
    );
    expect((await connectorHealth(owner.connectorId))!.state).toBe('REFRESH_RECOVERABLE');
  });

  it('G. an explicitly revoked authorization needs consent, and stays refused', async () => {
    const airyn = await account('airyn');
    const parsed = parseOAuthToken(airyn.refresh)!;
    const found = (await findPresentedToken(parsed.prefix, parsed.secret, 'REFRESH'))!;
    await revokeTokenChain(found.id);
    const health = (await connectorHealth(airyn.connectorId))!;
    expect(health.state).toBe('HUMAN_REAUTH_REQUIRED');
    expect(health.reason).toBe('CONSENT_REVOKED');
    expect((await rotate(airyn.refresh)).ok).toBe(false);
  });

  it('taking back one account’s connector leaves a sibling on the same worker untouched', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    await use(caleb.access);
    await revokeTokensForClients([airyn.clientId]);
    expect((await connectorHealth(airyn.connectorId))!.reason).toBe('CONSENT_REVOKED');
    expect((await connectorHealth(caleb.connectorId))!.state).toBe('HEALTHY');
    await use(caleb.access);
  });

  it('a no-show quarantine lifts by itself once its own connector is re-authorized — and not a sibling’s', async () => {
    const airyn = await account('airyn');
    const caleb = await account('caleb');
    const reason = shouldQuarantine({ consecutiveNoShows: 3, consecutiveFailures: 0 }).reason;
    for (const one of [airyn, caleb]) {
      await setRoutineState({ routineId: one.routineId, from: 'ENABLED', to: 'QUARANTINED', reason });
    }
    // Backdate the quarantine so the new consent is unambiguously after it.
    await getDb().run('UPDATE fleet_routines SET updated_at = ?', [new Date(Date.now() - 60_000).toISOString()]);
    // Only Caleb's connector is re-authorized: a fresh consent on its own client.
    await issueGrant({ clientId: caleb.clientId, workerId, scope: '', resource: RESOURCE });
    // Airyn's newest token predates the quarantine.
    await getDb().run('UPDATE oauth_tokens SET created_at = ? WHERE client_id = ?', [
      new Date(Date.now() - 120_000).toISOString(),
      airyn.clientId,
    ]);

    const recovered = await recoverReauthorizedSurfaces();
    expect(recovered).toEqual([caleb.routineId]);
    expect((await getRoutine(caleb.routineId))!.state).toBe('ENABLED');
    expect((await getRoutine(airyn.routineId))!.state).toBe('QUARANTINED');
  });

  it('a sibling Routine using the shared connector is not re-authorization: only a new consent lifts it', async () => {
    const owner = await account('owner');
    // A second Routine in the same account shares the one connector.
    const sibling = await createRoutine({
      accountId: owner.accountId,
      routineRef: 'trig_owner_b',
      name: 'Research B',
      tokenSecretName: 'SECRET_owner',
      workerId,
    });
    await bindRoutineConnector(sibling.id, owner.connectorId);
    const reason = shouldQuarantine({ consecutiveNoShows: 3, consecutiveFailures: 0 }).reason;
    await setRoutineState({ routineId: owner.routineId, from: 'ENABLED', to: 'QUARANTINED', reason });
    await getDb().run('UPDATE oauth_tokens SET created_at = ? WHERE client_id = ?', [
      new Date(Date.now() - 120_000).toISOString(),
      owner.clientId,
    ]);
    await getDb().run('UPDATE fleet_routines SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      owner.routineId,
    ]);
    // The sibling's ordinary session uses the connector after the quarantine.
    await use(owner.access);
    expect((await connectorHealth(owner.connectorId))!.state).toBe('HEALTHY');
    expect(await recoverReauthorizedSurfaces()).toEqual([]);
    expect((await getRoutine(owner.routineId))!.state).toBe('QUARANTINED');
  });

  it('a stale refresh token refused as reused does not strand a connector whose live chain is held', async () => {
    const owner = await account('owner');
    const first = await rotate(owner.refresh);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The real client moves on: it presents the successor.
    expect((await rotate(first.minted.refresh)).ok).toBe(true);
    // Somebody presents the original, long superseded token.
    const stale = await rotate(owner.refresh);
    expect(stale).toEqual({ ok: false, reason: 'REUSED' });
    await age(owner.clientId, 60_000);
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      actorId: null,
      action: 'OAUTH_TOKEN',
      targetType: 'WORKER',
      targetId: workerId,
      result: 'DENIED',
      metadata: { reason: 'REUSED', clientId: owner.clientId },
    });
    expect((await connectorHealth(owner.connectorId))!.state).not.toBe('HUMAN_REAUTH_REQUIRED');
  });

  it('never lifts a quarantine that was not for unanswered fires', async () => {
    const caleb = await account('caleb');
    await setRoutineState({ routineId: caleb.routineId, from: 'ENABLED', to: 'QUARANTINED', reason: 'AUTH 401 on the trigger' });
    await getDb().run('UPDATE fleet_routines SET updated_at = ?', [new Date(Date.now() - 60_000).toISOString()]);
    await issueGrant({ clientId: caleb.clientId, workerId, scope: '', resource: RESOURCE });
    expect(await recoverReauthorizedSurfaces()).toEqual([]);
  });
});
