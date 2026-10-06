/**
 * The connection system under failure: Postgres → OAuth → token validation →
 * refresh → MCP authentication → whoami → check-in → no-show → quarantine →
 * recovery, with Brain's own database made to fail on purpose.
 *
 * The invariant every case serves: **a valid connector credential never becomes
 * "Not authorized" because Brain's database is busy, slow, restarting or
 * unavailable** — and Brain's own outage is never charged to a worker as a
 * no-show, never reaches a quarantine, and never asks a person to reconnect.
 *
 * Failures are injected at the database instance the app is using, so every
 * layer above it — repositories, the token endpoint, the MCP door, check-in —
 * runs exactly as in production and meets the error exactly where it would.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, postgresTestConnection } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import type { Database } from '../server/db/types.ts';
import {
  asControlPlane,
  classifyInfraFailure,
  infraFailureCounts,
  resetInfraCounters,
} from '../server/db/infra.ts';
import { PostgresAdapter } from '../server/db/adapters/postgres.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { CONCURRENT_REFRESH_LEEWAY_MS, issueGrant, registerClient } from '../server/repos/oauth.ts';
import { attachClient, bindRoutineConnector, ensureConnector } from '../server/repos/connectors.ts';
import { createAccount, createRoutine, unansweredFiresByRoutine } from '../server/repos/fleet.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  markDispatchRoutine,
  markDispatchSent,
  reopenNoShowDispatches,
} from '../server/repos/bins.ts';
import { connectorHealth, forgetRoutingHealth } from '../server/services/fleet/connectorHealth.ts';
import { mcpRouter } from '../server/mcp/endpoint.ts';
import { oauthRouter } from '../server/routes/oauth.ts';
import { requestContext, requireAuthentication } from '../server/routes/guard.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { authenticateRequest } from '../server/services/identity/authenticate.ts';
import { settleTokenTouches } from '../server/services/identity/tokenTouch.ts';
import {
  arrivalIncidentDuring,
  recordProcessStart,
  settleInfraIncidents,
  startInfraIncidentRecorder,
  stopInfraIncidentRecorder,
} from '../server/services/infra/incidents.ts';
import type { BinManifest, Principal } from '../server/domain/types.ts';
import { StorageConfigurationError } from '../server/services/storage/types.ts';
import { bootFailureApp } from '../server/bootFailure.ts';

/* ------------------------------------------------------------------------ */
/* Fault injection at the database the app is using                         */
/* ------------------------------------------------------------------------ */

/** The exact sentence `pg-pool` throws when a checkout waits too long. */
function poolTimeout(): Error {
  return new Error('timeout exceeded when trying to connect');
}

type Predicate = (sql: string) => boolean;
let restore: (() => void) | null = null;

/**
 * Make statements matching `when` fail with `error` until `restore()`.
 * `times` bounds how many fail, so a "brief outage" can heal on its own.
 */
function injectFault(when: Predicate, error: () => Error = poolTimeout, times = Infinity): void {
  const db = getDb() as Database & Record<string, unknown>;
  const originals = { all: db.all, get: db.get, run: db.run, exec: db.exec };
  let left = times;
  const trip = (sql: string): void => {
    if (left > 0 && when(sql)) {
      left -= 1;
      throw error();
    }
  };
  db.all = (async (sql: string, params?: never[]) => {
    trip(sql);
    return originals.all.call(db, sql, params);
  }) as Database['all'];
  db.get = (async (sql: string, params?: never[]) => {
    trip(sql);
    return originals.get.call(db, sql, params);
  }) as Database['get'];
  db.run = (async (sql: string, params?: never[]) => {
    trip(sql);
    return originals.run.call(db, sql, params);
  }) as Database['run'];
  restore = () => {
    db.all = originals.all;
    db.get = originals.get;
    db.run = originals.run;
    restore = null;
  };
}

const EVERYTHING: Predicate = () => true;

/* ------------------------------------------------------------------------ */
/* A Brain with a worker, a connector and an OAuth grant                      */
/* ------------------------------------------------------------------------ */

const RESOURCE = 'https://brain.example/mcp';
let projectId = '';
let workerId = '';
let server: http.Server | null = null;
let base = '';

interface Fixture {
  clientId: string;
  access: string;
  refresh: string;
  routineId: string;
  connectorId: string;
}

async function connector(name: string): Promise<Fixture> {
  process.env[`SECRET_${name}`] = 'not-a-real-token';
  const account = await createAccount({ provider: 'anthropic', name });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig_${name}`,
    name: `Research ${name}`,
    tokenSecretName: `SECRET_${name}`,
    workerId,
  });
  const client = await registerClient({
    clientName: `Brain (${name})`,
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    secretDigest: null,
    tokenAuthMethod: 'none',
  });
  const minted = await issueGrant({ clientId: client.clientId, workerId, scope: '', resource: RESOURCE });
  const made = await ensureConnector({ accountId: account.id, resource: '/mcp', workerId });
  await attachClient({ clientId: client.clientId, connectorId: made.id, source: 'OPERATOR' });
  await bindRoutineConnector(routine.id, made.id);
  return {
    clientId: client.clientId,
    access: minted.access,
    refresh: minted.refresh,
    routineId: routine.id,
    connectorId: made.id,
  };
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  forgetRoutingHealth();
  resetInfraCounters();
  const worker = await createWorker({ name: 'research-brain', createdByType: 'SYSTEM', createdById: 'test' });
  workerId = worker.id;
  await grantMembership({
    projectId,
    principalType: 'WORKER',
    principalId: worker.id,
    role: 'MEMBER',
    scopes: ['project:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const app = express();
  app.set('trust proxy', true);
  app.use(
    '/oauth',
    express.json({ limit: '64kb' }),
    express.urlencoded({ extended: false, limit: '64kb' }),
    oauthRouter(),
  );
  app.use('/mcp', mcpRouter());
  app.use(requestContext());
  app.use(requireAuthentication());
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  restore?.();
  stopInfraIncidentRecorder();
  await settleInfraIncidents().catch(() => undefined);
  await settleTokenTouches().catch(() => undefined);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const MODERN = '2026-07-28';

async function mcp(
  method: string,
  params: Record<string, unknown>,
  bearer: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const named = typeof params['name'] === 'string' ? (params['name'] as string) : null;
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(named ? { 'mcp-name': named } : {}),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'reliability-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: response.headers };
}

async function whoami(bearer: string) {
  return mcp('tools/call', { name: 'brain_whoami', arguments: {} }, bearer);
}

async function refresh(clientId: string, token: string) {
  const response = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token }).toString(),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, string>) : {}, headers: response.headers };
}

function manifest(): BinManifest {
  return {
    objective: 'A bin a surface is fired for.',
    why: 'The failure matrix needs a fire to go unanswered.',
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
  return (await readyBinRow()).id;
}

async function readyBinRow() {
  return createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'work for a session',
    objective: 'be claimed',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
}

/** Brain fires a Routine at a bin at `sentAt`, and nobody claims it in time. */
async function unansweredFire(
  routineId: string,
  sentAt: Date,
  sessionRef: string | null = null,
  windowMs = 60 * 60_000,
): Promise<string> {
  const bin = await readyBinRow();
  await ensureDispatchIntent(bin);
  const intent = (await claimDispatchIntent())!;
  await markDispatchRoutine(intent.id, routineId);
  await markDispatchSent(intent.id, { routineRef: 'trig_x', routineId, projectId, sessionRef });
  await getDb().run('UPDATE bin_dispatch SET sent_at = ? WHERE id = ?', [sentAt.toISOString(), intent.id]);
  await reopenNoShowDispatches(windowMs, 50);
  return intent.id;
}

async function eventsOf(type: string, routineId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM bin_events WHERE event_type = ? AND routine_id = ?',
    [type, routineId],
  );
  return Number(row!.n);
}

/* ------------------------------------------------------------------------ */
/* 0. What counts as infrastructure                                          */
/* ------------------------------------------------------------------------ */

describe('one classification of "the database could not answer"', () => {
  it('names every production shape, and nothing that is a real defect', () => {
    expect(classifyInfraFailure(poolTimeout())).toBe('POOL_CHECKOUT_TIMEOUT');
    expect(
      classifyInfraFailure(new Error('(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms in Session mode')),
    ).toBe('POOLER_CHECKOUT_TIMEOUT');
    expect(classifyInfraFailure(Object.assign(new Error('(EMAXCONNSESSION) max clients reached in session mode'), { code: 'XX000' }))).toBe(
      'POOLER_REFUSED',
    );
    expect(classifyInfraFailure(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(
      'STATEMENT_TIMEOUT',
    );
    expect(classifyInfraFailure(new Error('Connection terminated due to connection timeout'))).toBe('CONNECTION_LOST');
    expect(classifyInfraFailure(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).toBe(
      'DATABASE_UNAVAILABLE',
    );
    expect(classifyInfraFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe('CONNECTION_LOST');
    // A wrapped one is still found.
    expect(classifyInfraFailure(Object.assign(new Error('wrapped'), { cause: poolTimeout() }))).toBe('POOL_CHECKOUT_TIMEOUT');
    // Real defects are not infrastructure: calling them so would hide a bug behind a retry.
    expect(classifyInfraFailure(Object.assign(new Error('duplicate key value'), { code: '23505' }))).toBeNull();
    expect(classifyInfraFailure(new TypeError('x is undefined'))).toBeNull();
    expect(classifyInfraFailure(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* 1–4, 12. Authentication under database failure                            */
/* ------------------------------------------------------------------------ */

describe('a valid credential is never "Not authorized" because the database did not answer', () => {
  it('1. a healthy connector authenticates and whoami answers', async () => {
    const c = await connector('healthy');
    const answer = await whoami(c.access);
    expect(answer.status).toBe(200);
    const result = answer.body['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(false);
  });

  it('2–5. whoami during a database outage: retryable 503, never "Not authorized", and the same token works after', async () => {
    const c = await connector('outage');
    injectFault(EVERYTHING);
    const during = await whoami(c.access);
    expect(during.status).toBe(503);
    expect(during.headers.get('retry-after')).toBe('5');
    const error = during.body['error'] as Record<string, unknown>;
    expect(String(error['message'])).not.toMatch(/not authorized/i);
    expect(String(error['message'])).toMatch(/not an authorization failure/i);
    expect((error['data'] as Record<string, unknown>)['category']).toBe('INFRA_RETRYABLE');
    restore!();

    const after = await whoami(c.access);
    expect(after.status).toBe(200);
    // The connector reads exactly as it did: nothing about it was judged.
    await settleTokenTouches();
    expect((await connectorHealth(c.connectorId))!.state).toBe('HEALTHY');
    expect((await connectorHealth(c.connectorId))!.humanActionRequired).toBe(false);
  });

  it('a genuinely invalid token is still refused as unauthorized', async () => {
    await connector('real');
    const refused = await whoami('brnt_notatoken_notasecret');
    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.body)).toMatch(/Not authorized/);
  });

  it('the HTTP guard answers a database failure as temporarily unavailable, not "Not authorized."', async () => {
    const c = await connector('guard');
    injectFault(EVERYTHING);
    const response = await fetch(`${base}/api/ping`, { headers: { authorization: `Bearer ${c.access}` } });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('temporarily_unavailable');
    expect(JSON.stringify(body)).not.toMatch(/Not authorized/);
  });

  it('a bug inside authentication still serves nothing, and is not recorded as an outage that excuses no-shows', async () => {
    const c = await connector('bug');
    startInfraIncidentRecorder();
    injectFault((sql) => sql.includes('oauth_tokens'), () => new TypeError('x is undefined'));
    const during = await whoami(c.access);
    restore!();
    expect(during.status).toBe(503);
    await settleInfraIncidents();
    expect((await getDb().all('SELECT id FROM infra_incidents')).length).toBe(0);
  });

  it('a pool timeout at the MCP door is recorded as an arrival-path incident', async () => {
    const c = await connector('door');
    startInfraIncidentRecorder();
    const before = new Date(Date.now() - 1_000).toISOString();
    injectFault((sql) => sql.includes('oauth_tokens'));
    expect((await whoami(c.access)).status).toBe(503);
    restore!();
    await settleInfraIncidents();
    expect((await arrivalIncidentDuring(before))?.surface).toBe('mcp:authenticate@WORKLOAD');
  });

  it('a statement timeout inside authentication is still not an authorization verdict', async () => {
    const c = await connector('stmt');
    injectFault(
      (sql) => sql.includes('oauth_tokens'),
      () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const during = await whoami(c.access);
    expect(during.status).toBe(503);
    expect(JSON.stringify(during.body)).not.toMatch(/Not authorized/);
    expect(infraFailureCounts()).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */
/* 8–12. Refresh rotation under database failure                             */
/* ------------------------------------------------------------------------ */

describe('refresh survives the database failing around it', () => {
  it('8. a refresh during an outage is 503 temporarily_unavailable, and the retry rotates normally', async () => {
    const c = await connector('refresh');
    injectFault(EVERYTHING);
    const during = await refresh(c.clientId, c.refresh);
    expect(during.status).toBe(503);
    expect(during.body['error']).toBe('temporarily_unavailable');
    expect(during.headers.get('retry-after')).toBe('5');
    restore!();

    const after = await refresh(c.clientId, c.refresh);
    expect(after.status).toBe(200);
    expect(after.body['refresh_token']).toBeTruthy();
    // No refusal was recorded against the connector for the outage.
    const health = (await connectorHealth(c.connectorId))!;
    expect(health.lastRefusal).toBeNull();
  });

  it('9. a reply lost after Brain committed: the same refresh token answers with the same successor', async () => {
    const c = await connector('lost');
    const first = await refresh(c.clientId, c.refresh);
    expect(first.status).toBe(200);
    // The client never received `first`. It retries with what it holds.
    const retried = await refresh(c.clientId, c.refresh);
    expect(retried.status).toBe(200);
    expect(retried.body['refresh_token']).toBe(first.body['refresh_token']);
  });

  it('10. the same refresh token presented concurrently converges on one successor', async () => {
    const c = await connector('race');
    const answers = await Promise.all([refresh(c.clientId, c.refresh), refresh(c.clientId, c.refresh), refresh(c.clientId, c.refresh)]);
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(new Set(answers.map((a) => a.body['refresh_token'])).size).toBe(1);
  });

  it('11–12. an access token that expired during the outage is replaced by a refresh afterwards, identity unchanged', async () => {
    const c = await connector('expired');
    await getDb().run("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'ACCESS' AND client_id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      c.clientId,
    ]);
    injectFault(EVERYTHING);
    expect((await refresh(c.clientId, c.refresh)).status).toBe(503);
    restore!();
    const rotated = await refresh(c.clientId, c.refresh);
    expect(rotated.status).toBe(200);
    const answer = await whoami(rotated.body['access_token']!);
    expect(answer.status).toBe(200);
    const value = ((answer.body['result'] as Record<string, unknown>)['structuredContent'] ?? {}) as Record<string, unknown>;
    expect(value['principalType']).toBe('WORKER');
  });

  it('the use of a successor is recorded even when the first write of it fails', async () => {
    const c = await connector('touch');
    const rotated = await refresh(c.clientId, c.refresh);
    const usedAt = Date.now();
    // Every touch fails twice, then the database recovers.
    injectFault((sql) => sql.includes('UPDATE oauth_tokens') && sql.includes('first_used_at'), poolTimeout, 2);
    expect((await whoami(rotated.body['access_token']!)).status).toBe(200);
    await settleTokenTouches();
    restore!();
    const row = await getDb().get<{ first_used_at: string | null }>(
      "SELECT first_used_at FROM oauth_tokens WHERE kind = 'ACCESS' AND client_id = ? ORDER BY created_at DESC LIMIT 1",
      [c.clientId],
    );
    expect(row!.first_used_at).not.toBeNull();
    // Recorded at the moment of use, not the moment the retry landed.
    expect(Math.abs(Date.parse(row!.first_used_at!) - usedAt)).toBeLessThan(2_000);
    expect((await connectorHealth(c.connectorId))!.state).toBe('HEALTHY');
  });

  it('a use of the successor not yet written still reads as picked up', async () => {
    const c = await connector('held-use');
    const rotated = await refresh(c.clientId, c.refresh);
    expect(rotated.status).toBe(200);
    // Every touch fails for now: the use is held in memory.
    injectFault((sql) => sql.includes('UPDATE oauth_tokens') && sql.includes('first_used_at'));
    expect((await whoami(rotated.body['access_token']!)).status).toBe(200);
    const later = Date.now() + CONCURRENT_REFRESH_LEEWAY_MS + 60_000;
    const health = (await connectorHealth(c.connectorId, later))!;
    restore!();
    expect(health.state).toBe('HEALTHY');
    await settleTokenTouches();
  });

  it('20. a genuinely revoked credential still needs consent, and only that connector does', async () => {
    const revoked = await connector('revoked');
    const sibling = await connector('sibling');
    await getDb().run("UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'EXPLICIT' WHERE client_id = ?", [
      new Date().toISOString(),
      revoked.clientId,
    ]);
    expect((await whoami(revoked.access)).status).toBe(401);
    const health = (await connectorHealth(revoked.connectorId))!;
    expect(health.state).toBe('HUMAN_REAUTH_REQUIRED');
    expect(health.reason).toBe('CONSENT_REVOKED');
    expect((await connectorHealth(sibling.connectorId))!.humanActionRequired).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* 6, 14. Check-in establishes the session first                             */
/* ------------------------------------------------------------------------ */

function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'worker',
    displayName: 'worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'oat_test',
    authMethod: 'OAUTH_BEARER',
    memberships: [
      {
        projectId,
        role: 'MEMBER',
        scopes: ['project:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
        active: true,
      } as never,
    ],
    requestId: 'req_test',
  };
}

describe('a worker proving it is here does not wait on work selection', () => {
  it('6. admission timing out on a heavy query: the session is checked in and told to retry, not failed', async () => {
    startInfraIncidentRecorder();
    const before = new Date(Date.now() - 1_000).toISOString();
    await readyBin();
    injectFault(
      (sql) => /FROM bins/.test(sql) && /DISPATCHABLE|LIMIT 25|ORDER BY priority/.test(sql),
      () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const result = await checkIn({ principal: workerPrincipal(), workerId, sessionRef: 'cse_unserved' });
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
    restore!();
    // The arrival was recorded, with its session.
    await settleInfraIncidents();
    const incident = await getDb().get<{ kind: string; session_ref: string | null; affects_arrival: number }>(
      "SELECT kind, session_ref, affects_arrival FROM infra_incidents WHERE kind = 'UNSERVED_ARRIVAL'",
    );
    // Scoped to its own session: evidence that this fire was answered, not a fleet-wide excuse.
    expect(incident).toMatchObject({ kind: 'UNSERVED_ARRIVAL', session_ref: 'cse_unserved' });
    expect(Number(incident!.affects_arrival)).toBe(0);
    // A workload query timing out is not an outage that excuses anybody's no-show.
    expect(await arrivalIncidentDuring(before)).toBeNull();
    // And afterwards the same session is served normally.
    const served = await checkIn({ principal: workerPrincipal(), workerId, sessionRef: 'cse_unserved' });
    expect(served.assigned).toBe(true);
  });

  it('once the lease is taken, a database failure afterwards never turns the assignment into "nothing"', async () => {
    const binId = await readyBin();
    // Everything after the compare-and-swap fails: the re-read, the event, the arrival credit.
    injectFault(
      (sql) => /^SELECT \* FROM bins WHERE id = \?$/.test(sql.trim()) || sql.includes('INSERT INTO bin_events') || sql.includes('bin_dispatch'),
    );
    const result = await checkIn({ principal: workerPrincipal(), workerId, sessionRef: 'cse_leased' });
    restore!();
    expect(result.assigned).toBe(true);
    if (result.assigned) {
      expect(result.assignment.binId).toBe(binId);
      const row = await getDb().get<{ state: string; lease_id: string }>('SELECT state, lease_id FROM bins WHERE id = ?', [binId]);
      expect(row).toMatchObject({ state: 'LEASED', lease_id: result.assignment.leaseId });
    }
  });

  it('choosing past the budget answers RETRY_LATER instead of running into the client’s sixty seconds', async () => {
    await readyBin();
    const result = await checkIn({
      principal: workerPrincipal(),
      workerId,
      sessionRef: 'cse_slow',
      deadline: Date.now() - 1,
    });
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
  });

  it('14. check-in while the database is down fails only the establishing write, and says nothing about auth', async () => {
    injectFault(EVERYTHING);
    await expect(checkIn({ principal: workerPrincipal(), workerId })).rejects.toSatisfy(
      (error: unknown) => classifyInfraFailure(error) !== null,
    );
  });

  it('the brain_check_in tool answers RETRY_LATER as a retryable value, not an error', async () => {
    const c = await connector('tool');
    await readyBin();
    injectFault(
      (sql) => /FROM bins/.test(sql) && /ORDER BY priority/.test(sql),
      () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const answer = await mcp('tools/call', { name: 'brain_check_in', arguments: { session_ref: 'cse_tool' } }, c.access);
    restore!();
    expect(answer.status).toBe(200);
    const result = answer.body['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(false);
    const value = result['structuredContent'] as Record<string, unknown>;
    expect(value['reason']).toBe('RETRY_LATER');
    expect(value['retryable']).toBe(true);
    expect(String(value['message'])).toMatch(/not an authorization problem/);
  });

  it('a tool that meets a database failure says INFRA_RETRYABLE rather than "could not be completed"', async () => {
    const c = await connector('infra-tool');
    // Fails only the tool's own read, after authentication succeeded.
    injectFault((sql) => /FROM projects/.test(sql) && !/project_memberships/.test(sql));
    const answer = await mcp('tools/call', { name: 'brain_list_projects', arguments: {} }, c.access);
    restore!();
    expect(answer.status).toBe(200);
    const result = answer.body['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    const error = (result['structuredContent'] as Record<string, unknown>)['error'] as Record<string, unknown>;
    expect(error['kind']).toBe('INFRA_RETRYABLE');
    expect(error['retryable']).toBe(true);
    expect(String(error['message'])).toMatch(/not an authorization problem/);
  });

  it('a tool whose document store refused for now says RATE_OR_CAPACITY_RETRYABLE (deploy 403)', async () => {
    const c = await connector('store-tool');
    injectFault(
      (sql) => /FROM projects/.test(sql) && !/project_memberships/.test(sql),
      () => new StorageConfigurationError('The document store refused a listing (HTTP 429).', 'slow down', 429),
    );
    const answer = await mcp('tools/call', { name: 'brain_list_projects', arguments: {} }, c.access);
    restore!();
    const result = answer.body['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
    const error = (result['structuredContent'] as Record<string, unknown>)['error'] as Record<string, unknown>;
    expect(error['kind']).toBe('RATE_OR_CAPACITY_RETRYABLE');
    expect(error['retryable']).toBe(true);
    expect(String(error['message'])).not.toMatch(/could not be completed/);
  });

  it('a credential the store rejected is still an internal failure, not a retry', async () => {
    const c = await connector('store-cred');
    injectFault(
      (sql) => /FROM projects/.test(sql) && !/project_memberships/.test(sql),
      () => new StorageConfigurationError("The document store rejected Brain's credentials (HTTP 403).", '', 403),
    );
    const answer = await mcp('tools/call', { name: 'brain_list_projects', arguments: {} }, c.access);
    restore!();
    const result = answer.body['result'] as Record<string, unknown>;
    const error = (result['structuredContent'] as Record<string, unknown>)['error'] as Record<string, unknown>;
    expect(error['retryable']).not.toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* 7–9, 13, 15. No-shows, quarantine and restarts                             */
/* ------------------------------------------------------------------------ */

describe('Brain’s own outage is never a worker’s no-show', () => {
  it('13. a fire whose session met an authentication outage is an infra miss, not a no-show, and its attempt is refunded', async () => {
    const c = await connector('fired');
    startInfraIncidentRecorder();
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    // The session arrived during the outage and could not authenticate.
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_a', 'POOL_CHECKOUT_TIMEOUT', 'mcp:authenticate@WORKLOAD', ?, ?, 4, 1, ?)`,
      [new Date(sentAt.getTime() + 20_000).toISOString(), new Date(sentAt.getTime() + 90_000).toISOString(), new Date().toISOString()],
    );
    for (let i = 0; i < 3; i += 1) await unansweredFire(c.routineId, sentAt);
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)).toBe(3);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
    expect(await eventsOf('DISPATCH_AUTH_NO_SHOW', c.routineId)).toBe(0);
    expect((await unansweredFiresByRoutine()).get(c.routineId) ?? 0).toBe(0);
    const health = (await connectorHealth(c.connectorId))!;
    expect(health.humanActionRequired).toBe(false);
    const attempts = await getDb().all<{ attempt_count: number; state: string }>(
      'SELECT attempt_count, state FROM bin_dispatch WHERE routine_id = ?',
      [c.routineId],
    );
    for (const row of attempts) {
      expect(row.state).toBe('PENDING');
      expect(Number(row.attempt_count)).toBe(0);
    }
  });

  it('a workload-only incident does not excuse a surface that did not answer', async () => {
    const c = await connector('dead');
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_w', 'STATEMENT_TIMEOUT', 'mcp:brain_submit_audit@WORKLOAD', ?, ?, 1, 0, ?)`,
      [new Date(sentAt.getTime() + 20_000).toISOString(), new Date(sentAt.getTime() + 20_000).toISOString(), new Date().toISOString()],
    );
    for (let i = 0; i < 3; i += 1) await unansweredFire(c.routineId, sentAt);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(3);
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)).toBe(0);
  });

  it('an incident outside the arrival window does not excuse either', async () => {
    const c = await connector('outside');
    const sentAt = new Date(Date.now() - 3 * 3_600_000);
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_o', 'POOL_CHECKOUT_TIMEOUT', 'mcp:authenticate@WORKLOAD', ?, ?, 1, 1, ?)`,
      [new Date(sentAt.getTime() + 60 * 60_000).toISOString(), new Date(sentAt.getTime() + 61 * 60_000).toISOString(), new Date().toISOString()],
    );
    await unansweredFire(c.routineId, sentAt);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(1);
  });

  it('7–8. a restart window excuses the fires whose sessions arrived while the machine was being replaced', async () => {
    const c = await connector('restart');
    const lastAlive = new Date(Date.now() - 2 * 3_600_000);
    await getDb().run('INSERT INTO runtime_liveness (instance_id, started_at, alive_at) VALUES (?, ?, ?)', [
      'proc_previous',
      new Date(lastAlive.getTime() - 3_600_000).toISOString(),
      lastAlive.toISOString(),
    ]);
    const listening = new Date(lastAlive.getTime() + 3 * 60_000);
    const { gapMs } = await recordProcessStart(listening);
    expect(gapMs).toBe(3 * 60_000);
    // A fire just before the old process died; its session arrived into the gap.
    await unansweredFire(c.routineId, new Date(lastAlive.getTime() - 30_000));
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)).toBe(1);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
  });

  it('an unserved arrival excuses its own fire and nobody else’s', async () => {
    const served = await connector('own-session');
    const other = await connector('other-session');
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    // The fired session arrived, checked in, and could not be served.
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, session_ref, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_u', 'UNSERVED_ARRIVAL', 'check_in', 'session_abc', ?, ?, 1, 0, ?)`,
      [new Date(sentAt.getTime() + 30_000).toISOString(), new Date(sentAt.getTime() + 30_000).toISOString(), new Date().toISOString()],
    );
    // Brain recorded the fire's provider session as cse_abc; the worker reported session_abc.
    await unansweredFire(served.routineId, sentAt, 'cse_abc');
    await unansweredFire(other.routineId, sentAt, 'cse_somebody_else');
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', served.routineId)).toBe(1);
    expect(await eventsOf('DISPATCH_NO_SHOW', served.routineId)).toBe(0);
    // It is not a fleet-wide excuse: the other surface's miss is still a no-show.
    expect(await eventsOf('DISPATCH_NO_SHOW', other.routineId)).toBe(1);
    expect(await arrivalIncidentDuring(sentAt.toISOString())).toBeNull();
  });

  it('refunds a bounded number of times, then the dispatch budget applies — still never charged to the surface', async () => {
    const c = await connector('bounded');
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_b', 'POOL_CHECKOUT_TIMEOUT', 'mcp:authenticate', ?, ?, 1, 1, ?)`,
      [sentAt.toISOString(), new Date(sentAt.getTime() + 15 * 60_000).toISOString(), new Date().toISOString()],
    );
    const bin = await readyBinRow();
    await ensureDispatchIntent(bin);
    const intent = (await claimDispatchIntent())!;
    for (let round = 0; round < 8; round += 1) {
      await getDb().run(
        "UPDATE bin_dispatch SET state = 'SENT', routine_id = ?, sent_at = ?, attempt_count = attempt_count + 1 WHERE id = ?",
        [c.routineId, sentAt.toISOString(), intent.id],
      );
      await reopenNoShowDispatches(60 * 60_000, 50);
    }
    const row = await getDb().get<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM bin_dispatch WHERE id = ?',
      [intent.id],
    );
    // Three refunds, then attempts accumulate to the ceiling and the intent ends.
    expect(row!.state).toBe('ABANDONED');
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
    expect((await unansweredFiresByRoutine()).get(c.routineId) ?? 0).toBe(0);
  });

  it('evidence still waiting to be written counts: the no-show pass does not outrun the recorder', async () => {
    const c = await connector('unwritten');
    startInfraIncidentRecorder();
    const sentAt = new Date(Date.now() - 60_000);
    // The database will not take the incident row...
    injectFault((sql) => sql.includes('INSERT INTO infra_incidents'));
    const { noteInfraFailure } = await import('../server/db/infra.ts');
    noteInfraFailure('POOLER_CHECKOUT_TIMEOUT', 'mcp:authenticate');
    await new Promise((resolve) => setTimeout(resolve, 400));
    // ...and the pass runs before it could. The held row still excuses the miss.
    await unansweredFire(c.routineId, sentAt, null, 30_000);
    restore!();
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)).toBe(1);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
  });

  it('a session whose arrival could not even be written is still not a no-show', async () => {
    const c = await connector('establish');
    startInfraIncidentRecorder();
    const sentAt = new Date(Date.now() - 60_000);
    injectFault((sql) => sql.includes('UPDATE fleet_routines') && sql.includes('consecutive_no_shows = 0'));
    await expect(checkIn({ principal: workerPrincipal(), workerId, sessionRef: 'session_est' })).rejects.toBeTruthy();
    restore!();
    await settleInfraIncidents();
    await unansweredFire(c.routineId, sentAt, 'cse_est', 30_000);
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)).toBe(1);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
  });

  it('repeated failures of one kind on one surface stay one row, however many flushes it takes', async () => {
    startInfraIncidentRecorder();
    const { noteInfraFailure } = await import('../server/db/infra.ts');
    for (let round = 0; round < 3; round += 1) {
      noteInfraFailure('STATEMENT_TIMEOUT', 'mcp:authenticate');
      await settleInfraIncidents();
    }
    const rows = await getDb().all<{ occurrences: number }>("SELECT occurrences FROM infra_incidents WHERE kind = 'STATEMENT_TIMEOUT'");
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.occurrences)).toBe(3);
  });

  it('a pass that cannot read its evidence leaves the fire unjudged rather than charging it', async () => {
    const c = await connector('blind');
    // Inside twice the window, so the pass defers rather than reopening uncharged.
    const sentAt = new Date(Date.now() - 90 * 60_000);
    injectFault((sql) => sql.includes('FROM infra_incidents'));
    await unansweredFire(c.routineId, sentAt);
    restore!();
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
    const row = await getDb().get<{ state: string }>('SELECT state FROM bin_dispatch WHERE routine_id = ?', [c.routineId]);
    expect(row!.state).toBe('SENT');
    // Next tick, with the database answering, it is judged — and it is a real no-show.
    await reopenNoShowDispatches(60 * 60_000, 50);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(1);
  });

  it('a fire whose evidence stays unreadable past twice the window is reopened uncharged, not stranded', async () => {
    const c = await connector('stranded');
    const sentAt = new Date(Date.now() - 3 * 3_600_000);
    injectFault((sql) => sql.includes('FROM infra_incidents'));
    await unansweredFire(c.routineId, sentAt);
    restore!();
    const row = await getDb().get<{ state: string }>('SELECT state FROM bin_dispatch WHERE routine_id = ?', [c.routineId]);
    expect(row!.state).toBe('PENDING');
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
    expect(await eventsOf('DISPATCH_AUTH_NO_SHOW', c.routineId)).toBe(0);
  });

  it('a row being written is still evidence while the write is in flight', async () => {
    startInfraIncidentRecorder();
    const db = getDb() as Database & Record<string, unknown>;
    const original = db.run;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    db.run = (async (sql: string, params?: never[]) => {
      if (sql.includes('INSERT INTO infra_incidents')) {
        entered = true;
        await gate;
      }
      return original.call(db, sql, params);
    }) as Database['run'];
    try {
      const { noteInfraFailure } = await import('../server/db/infra.ts');
      const { heldArrivalEvidence } = await import('../server/services/infra/incidents.ts');
      const before = new Date(Date.now() - 1_000).toISOString();
      noteInfraFailure('POOL_CHECKOUT_TIMEOUT', 'oauth:token');
      for (let i = 0; i < 50 && !entered; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(entered).toBe(true);
      // Mid-write: neither in the table nor, before the fix, in memory.
      expect(heldArrivalEvidence(null, before)).not.toBeNull();
    } finally {
      release();
      db.run = original;
      await settleInfraIncidents();
    }
  });

  it('a failure in a background write is never itself an incident', async () => {
    startInfraIncidentRecorder();
    const before = new Date(Date.now() - 1_000).toISOString();
    injectFault((sql) => sql.includes('runtime_liveness'));
    const { touchLiveness } = await import('../server/services/infra/incidents.ts');
    await expect(touchLiveness(true)).rejects.toBeTruthy();
    restore!();
    await settleInfraIncidents();
    expect(await arrivalIncidentDuring(before)).toBeNull();
    const rows = await getDb().all('SELECT id FROM infra_incidents');
    expect(rows.length).toBe(0);
  });

  it('a felt failure on the control plane becomes an incident row, coalesced, without the database answering at first', async () => {
    startInfraIncidentRecorder();
    const before = new Date(Date.now() - 1_000).toISOString();
    // Every write fails twice: the recorder retries rather than losing it.
    injectFault((sql) => sql.includes('INSERT INTO infra_incidents'), poolTimeout, 2);
    await asControlPlane(async () => {
      try {
        await getDb().get('SELECT 1 AS failing_on_purpose FROM oauth_tokens WHERE 1 = 0');
      } catch {
        // expected
      }
    });
    // The fault above did not trip for this read: simulate the adapter's own note.
    const { noteInfraFailure } = await import('../server/db/infra.ts');
    for (let i = 0; i < 5; i += 1) noteInfraFailure('POOLER_CHECKOUT_TIMEOUT', 'mcp:authenticate');
    await settleInfraIncidents();
    restore?.();
    const rows = await getDb().all<{ occurrences: number; affects_arrival: number }>(
      "SELECT occurrences, affects_arrival FROM infra_incidents WHERE kind = 'POOLER_CHECKOUT_TIMEOUT'",
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.occurrences)).toBe(5);
    expect(Number(rows[0]!.affects_arrival)).toBe(1);
    expect(await arrivalIncidentDuring(before)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* 2–3, 15–17. The control plane is reserved, not merely preferred           */
/* ------------------------------------------------------------------------ */

const pg = postgresTestConnection();

describe.skipIf(!pg)('Postgres: the control plane has connections nobody else can take', () => {
  it('2–3. with every workload connection held, authentication and whoami still answer', async () => {
    const adapter = new PostgresAdapter({
      connectionString: pg!.connectionString,
      schema: pg!.schema,
      max: 6,
      connectionTimeoutMillis: 1_500,
    });
    try {
      const readings = adapter.poolReadings();
      expect(readings.control?.max).toBe(2);
      expect(readings.workload.max).toBe(4);

      // Four workload transactions that do not finish until released.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const holders = Array.from({ length: 4 }, () =>
        adapter.transaction(async () => {
          await adapter.get('SELECT 1 AS held');
          await held;
        }),
      );
      // Let them take their connections.
      for (let i = 0; i < 50 && adapter.poolReadings().workload.total < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(adapter.poolReadings().workload.idle).toBe(0);

      // Ordinary work waits and times out...
      await expect(adapter.get('SELECT 1 AS starved')).rejects.toThrow(/no free connection|timeout/i);
      // ...and the control plane answers at once, many times over.
      const started = Date.now();
      const answers = await Promise.all(
        Array.from({ length: 10 }, () => asControlPlane(() => adapter.get<{ ok: number }>('SELECT 1 AS ok'))),
      );
      expect(answers.every((a) => Number(a?.ok) === 1)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_500);
      // A control-plane transaction — a refresh rotation's shape — commits too.
      await asControlPlane(() => adapter.transaction(async () => adapter.get('SELECT 1 AS rotated')));

      release();
      await Promise.all(holders);
    } finally {
      await adapter.close();
    }
  });

  it('a control-plane connection whose transaction failed on infrastructure is destroyed, never pooled', async () => {
    const adapter = new PostgresAdapter({ connectionString: pg!.connectionString, schema: pg!.schema, max: 6 });
    try {
      await asControlPlane(() => adapter.get('SELECT 1 AS warm'));
      const pids = new Set<number>();
      const first = await asControlPlane(() => adapter.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
      pids.add(Number(first!.pid));
      await expect(
        asControlPlane(() =>
          adapter.transaction(async () => {
            await adapter.get('SELECT pg_backend_pid() AS pid');
            throw Object.assign(new Error('Connection terminated unexpectedly'), {});
          }),
        ),
      ).rejects.toThrow(/Connection terminated/);
      const readings = adapter.poolReadings();
      // The client that held the failed transaction is gone; nothing poisoned is idle.
      expect(readings.control!.total).toBeLessThanOrEqual(1);
      const after = await asControlPlane(() => adapter.get<{ ok: number }>('SELECT 1 AS ok'));
      expect(Number(after!.ok)).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it('a statement that fails keeps its control-plane connection, and the server bounds what the client gave up on', async () => {
    const adapter = new PostgresAdapter({ connectionString: pg!.connectionString, schema: pg!.schema, max: 6 });
    try {
      const first = await asControlPlane(() => adapter.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
      // A real SQL error outside a transaction used to release the client with
      // the error, which destroys it: the reservation re-dialled on every miss.
      await expect(asControlPlane(() => adapter.get('SELECT * FROM a_table_that_is_not_there'))).rejects.toThrow();
      const again = await asControlPlane(() => adapter.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
      expect(Number(again!.pid)).toBe(Number(first!.pid));
      const bounds = await asControlPlane(() =>
        adapter.get<{ s: string; l: string }>("SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l"),
      );
      expect(bounds).toMatchObject({ s: '12s', l: '5s' });
    } finally {
      await adapter.close();
    }
  });

  it('a pool too small to split is not split', () => {
    const adapter = new PostgresAdapter({ connectionString: pg!.connectionString, schema: pg!.schema, max: 2 });
    try {
      expect(adapter.poolReadings().control).toBeNull();
      expect(adapter.poolReadings().workload.max).toBe(2);
    } finally {
      void adapter.close();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 15–17. Concurrency on the app's own database                              */
/* ------------------------------------------------------------------------ */

describe('many sessions at once', () => {
  it('15–19. Research and Factory sessions on several accounts authenticate and check in concurrently, without cross-attribution', async () => {
    const accounts = await Promise.all(['a', 'b', 'c', 'd'].map((n) => connector(`multi-${n}`)));
    for (let i = 0; i < 4; i += 1) await readyBin();
    const answers = await Promise.all(
      accounts.flatMap((c, i) => [
        whoami(c.access),
        mcp('tools/call', { name: 'brain_check_in', arguments: { session_ref: `cse_multi_${i}` } }, c.access),
        refresh(c.clientId, c.refresh),
      ]),
    );
    for (const answer of answers) expect(answer.status).toBe(200);
    await settleTokenTouches();
    for (const c of accounts) {
      const health = (await connectorHealth(c.connectorId))!;
      expect(health.humanActionRequired).toBe(false);
      // Each connector still has exactly its own client.
      expect(health.clientIds).toEqual([c.clientId]);
    }
    // The tokens each client holds still authenticate as the one worker.
    const outcome = await authenticateRequest({
      header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${accounts[0]!.access}` : undefined),
      query: {},
    } as never);
    expect(outcome.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* The matrix: twenty cases, one row each                                    */
/* ------------------------------------------------------------------------ */

/**
 * Every case the closure is accountable for, driven through the real doors and
 * read back from the rows, one row per case — so the table printed at the end
 * is a reading of what happened, not a description of what should. Columns:
 * what the client saw, the connector's health, what the no-show pass wrote, how
 * far the surface moved towards quarantine, whether a person was asked to
 * reconnect, and whether the same connector worked again afterwards with its
 * identity unchanged.
 */
interface MatrixRow {
  case: string;
  client: string;
  connector: string;
  noShow: string;
  quarantine: number;
  reconnect: boolean;
  recovered: boolean;
}

const ECHECKOUT = (): Error =>
  Object.assign(
    new Error('(ECHECKOUTTIMEOUT) unable to check out connection from the pool after 15000ms in Session mode'),
    { code: 'XX000' },
  );
const STATEMENT = (): Error =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const TERMINATED = (): Error => new Error('Connection terminated due to connection timeout');

describe('the chaos matrix', () => {
  it('records all twenty cases; only a genuinely revoked credential asks for a person', async () => {
    startInfraIncidentRecorder();
    const rows: MatrixRow[] = [];
    const describeClient = (r: { status: number; body: Record<string, unknown> }): string => {
      const error = r.body['error'] as Record<string, unknown> | string | undefined;
      const category =
        typeof error === 'object' && error && 'data' in error
          ? String((error['data'] as Record<string, unknown>)['category'])
          : typeof error === 'string'
            ? error
            : '';
      return `${r.status}${category ? ` ${category}` : ''}`;
    };
    const observe = async (
      label: string,
      c: Fixture,
      client: string,
      recovered: boolean,
    ): Promise<void> => {
      await settleTokenTouches();
      await settleInfraIncidents();
      const health = (await connectorHealth(c.connectorId))!;
      const counts = [
        ['NO_SHOW', await eventsOf('DISPATCH_NO_SHOW', c.routineId)],
        ['AUTH', await eventsOf('DISPATCH_AUTH_NO_SHOW', c.routineId)],
        ['INFRA', await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)],
      ].filter(([, n]) => Number(n) > 0);
      rows.push({
        case: label,
        client,
        connector: health.state,
        noShow: counts.length === 0 ? '—' : counts.map(([k, n]) => `${k}×${n}`).join(' '),
        quarantine: (await unansweredFiresByRoutine()).get(c.routineId) ?? 0,
        reconnect: health.humanActionRequired,
        recovered,
      });
    };
    const ok = async (bearer: string): Promise<boolean> => (await whoami(bearer)).status === 200;
    const inOutage = (sentAt: Date, kind = 'POOL_CHECKOUT_TIMEOUT'): Promise<unknown> =>
      getDb().run(
        `INSERT INTO infra_incidents (id, kind, surface, started_at, ended_at, occurrences, affects_arrival, created_at)
         VALUES (?, ?, 'mcp:authenticate@CONTROL', ?, ?, 3, 1, ?)`,
        [`inc_${Math.random().toString(36).slice(2)}`, kind, new Date(sentAt.getTime() + 10_000).toISOString(), new Date(sentAt.getTime() + 120_000).toISOString(), new Date().toISOString()],
      );

    // 1. Healthy.
    {
      const c = await connector('m1');
      const r = await whoami(c.access);
      await observe('1 DB healthy', c, describeClient(r), await ok(c.access));
    }
    // 2. Slow: every statement answers, late.
    {
      const c = await connector('m2');
      const db = getDb() as Database & Record<string, unknown>;
      const original = db.get;
      db.get = (async (sql: string, params?: never[]) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return original.call(db, sql, params);
      }) as Database['get'];
      const r = await whoami(c.access);
      db.get = original;
      await observe('2 DB slow', c, describeClient(r), await ok(c.access));
    }
    // 3. Unavailable for a short outage: every statement fails, then heals.
    {
      const c = await connector('m3');
      injectFault(EVERYTHING, TERMINATED);
      const r = await whoami(c.access);
      const rr = await refresh(c.clientId, c.refresh);
      restore!();
      await observe('3 DB unavailable 30s', c, `${describeClient(r)}; refresh ${describeClient(rr)}`, await ok(c.access));
    }
    // 4. Unavailable for longer: auth, refresh, a fire and an arrival all fail inside it.
    {
      const c = await connector('m4');
      const sentAt = new Date(Date.now() - 2 * 3_600_000);
      await inOutage(sentAt);
      injectFault(EVERYTHING, TERMINATED);
      const r = await whoami(c.access);
      const rr = await refresh(c.clientId, c.refresh);
      restore!();
      await unansweredFire(c.routineId, sentAt);
      const after = await refresh(c.clientId, c.refresh);
      await observe('4 DB unavailable 2min', c, `${describeClient(r)}; refresh ${describeClient(rr)}`, after.status === 200 && (await ok(after.body['access_token']!)));
    }
    // 5. Pool saturated: Brain's own pool hands out nothing in time.
    {
      const c = await connector('m5');
      injectFault(EVERYTHING, poolTimeout);
      const r = await whoami(c.access);
      restore!();
      await observe('5 pool saturated', c, describeClient(r), await ok(c.access));
    }
    // 6. The pooler's checkout timeout.
    {
      const c = await connector('m6');
      injectFault(EVERYTHING, ECHECKOUT);
      const r = await whoami(c.access);
      const rr = await refresh(c.clientId, c.refresh);
      restore!();
      await observe('6 checkout timeout', c, `${describeClient(r)}; refresh ${describeClient(rr)}`, await ok(c.access));
    }
    // 7. A statement timeout while choosing work at check-in.
    {
      const c = await connector('m7');
      await readyBin();
      injectFault((sql) => /FROM bins/.test(sql) && /ORDER BY priority/.test(sql), STATEMENT);
      const r = await mcp('tools/call', { name: 'brain_check_in', arguments: { session_ref: 'cse_m7' } }, c.access);
      restore!();
      const value = ((r.body['result'] as Record<string, unknown>)['structuredContent'] ?? {}) as Record<string, unknown>;
      await observe('7 statement timeout at check-in', c, `${r.status} ${String(value['reason'])}`, await ok(c.access));
    }
    // 8. Brain restarting while an access token is presented: the request met
    //    the restarting process (503, see bootFailureAnswers), and the fire that
    //    produced it lands in the restart window.
    {
      const c = await connector('m8');
      const lastAlive = new Date(Date.now() - 90 * 60_000);
      await getDb().run('INSERT INTO runtime_liveness (instance_id, started_at, alive_at) VALUES (?, ?, ?)', [
        'proc_m8',
        new Date(lastAlive.getTime() - 3_600_000).toISOString(),
        lastAlive.toISOString(),
      ]);
      await recordProcessStart(new Date(lastAlive.getTime() + 2 * 60_000));
      await unansweredFire(c.routineId, new Date(lastAlive.getTime() - 30_000));
      // What the request that met the restarting process was answered.
      const restarting = bootFailureApp(new Error('The cloud did not answer.'), { retrying: true, databasePath: '-', dataRoot: '-' }).listen(0);
      await new Promise<void>((resolve) => restarting.once('listening', () => resolve()));
      const port = (restarting.address() as AddressInfo).port;
      const met = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${c.access}` } });
      const metBody = (await met.json()) as Record<string, unknown>;
      await new Promise<void>((resolve) => restarting.close(() => resolve()));
      await observe('8 restart during access-token use', c, `${describeClient({ status: met.status, body: metBody })} (restarting)`, await ok(c.access));
      await getDb().run("DELETE FROM runtime_liveness WHERE instance_id = 'proc_m8'");
    }
    // 9. Brain restarting inside a refresh: the rotation rolled back.
    {
      const c = await connector('m9');
      injectFault((sql) => sql.includes('INSERT INTO oauth_tokens'), TERMINATED, 1);
      const rr = await refresh(c.clientId, c.refresh);
      restore!();
      const again = await refresh(c.clientId, c.refresh);
      await observe('9 restart during refresh', c, `refresh ${describeClient(rr)}`, again.status === 200 && (await ok(again.body['access_token']!)));
    }
    // 10. A refresh reply lost after Brain committed.
    {
      const c = await connector('m10');
      const first = await refresh(c.clientId, c.refresh);
      const again = await refresh(c.clientId, c.refresh);
      expect(again.body['refresh_token']).toBe(first.body['refresh_token']);
      await observe('10 refresh response lost', c, `refresh ${again.status} same successor`, await ok(again.body['access_token']!));
    }
    // 11. Two refreshes of one token at once.
    {
      const c = await connector('m11');
      const [a, b] = await Promise.all([refresh(c.clientId, c.refresh), refresh(c.clientId, c.refresh)]);
      expect(a.body['refresh_token']).toBe(b.body['refresh_token']);
      await observe('11 simultaneous refreshes', c, `${a.status}/${b.status} one successor`, await ok(b.body['access_token']!));
    }
    // 12. A stale sibling presents the old refresh token after the chain moved on.
    {
      const c = await connector('m12');
      const first = await refresh(c.clientId, c.refresh);
      expect(await ok(first.body['access_token']!)).toBe(true);
      const second = await refresh(c.clientId, first.body['refresh_token']!);
      expect(await ok(second.body['access_token']!)).toBe(true);
      await settleTokenTouches();
      await getDb().run("UPDATE oauth_tokens SET first_used_at = ? WHERE client_id = ? AND first_used_at IS NOT NULL", [
        new Date(Date.now() - 10 * 60_000).toISOString(),
        c.clientId,
      ]);
      const stale = await refresh(c.clientId, c.refresh);
      await observe('12 stale sibling token', c, `stale refresh ${describeClient(stale)}`, await ok(second.body['access_token']!));
    }
    // 13. The access token expired during the outage.
    {
      const c = await connector('m13');
      await getDb().run("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'ACCESS' AND client_id = ?", [
        new Date(Date.now() - 1_000).toISOString(),
        c.clientId,
      ]);
      injectFault(EVERYTHING, ECHECKOUT);
      const rr = await refresh(c.clientId, c.refresh);
      restore!();
      const after = await refresh(c.clientId, c.refresh);
      await observe('13 token expired during outage', c, `refresh ${describeClient(rr)}`, after.status === 200 && (await ok(after.body['access_token']!)));
    }
    // 14. A Routine fired during the outage; its session could not authenticate.
    {
      const c = await connector('m14');
      const sentAt = new Date(Date.now() - 2 * 3_600_000);
      await inOutage(sentAt);
      for (let i = 0; i < 3; i += 1) await unansweredFire(c.routineId, sentAt);
      await observe('14 Routine fires during outage', c, '503 at the door (fleet-wide incident)', await ok(c.access));
    }
    // 15. A session reached check-in during the outage and could not be served.
    {
      const c = await connector('m15');
      const sentAt = new Date(Date.now() - 2 * 3_600_000);
      await getDb().run(
        `INSERT INTO infra_incidents (id, kind, surface, session_ref, started_at, ended_at, occurrences, affects_arrival, created_at)
         VALUES ('inc_m15', 'UNSERVED_ARRIVAL', 'check_in', 'claude-code-session_m15', ?, ?, 1, 0, ?)`,
        [new Date(sentAt.getTime() + 20 * 60_000).toISOString(), new Date(sentAt.getTime() + 20 * 60_000).toISOString(), new Date().toISOString()],
      );
      // Reported in the third spelling, at minute twenty: both used to be missed.
      await unansweredFire(c.routineId, sentAt, 'cse_m15');
      await observe('15 session arrives during outage', c, 'check-in RETRY_LATER (unserved arrival)', await ok(c.access));
    }
    // 16. Several research workers at once, with the pool failing intermittently.
    {
      const cs = await Promise.all(['m16a', 'm16b', 'm16c'].map((n) => connector(n)));
      injectFault((sql) => sql.includes('oauth_tokens'), poolTimeout, 2);
      const answers = await Promise.all(cs.map((c) => whoami(c.access)));
      restore!();
      const recovered = (await Promise.all(cs.map((c) => ok(c.access)))).every(Boolean);
      await observe('16 several research workers', cs[0]!, answers.map((a) => a.status).join('/'), recovered);
    }
    // 17–18. Research and Factory check in together while fleet reads run.
    {
      const research = await connector('m17r');
      const factory = await connector('m17f');
      await readyBin();
      await readyBin();
      const [a, b, health] = await Promise.all([
        mcp('tools/call', { name: 'brain_check_in', arguments: { session_ref: 'cse_m17r' } }, research.access),
        mcp('tools/call', { name: 'brain_check_in', arguments: { session_ref: 'cse_m17f' } }, factory.access),
        Promise.all([connectorHealth(research.connectorId), connectorHealth(factory.connectorId)]),
      ]);
      expect(health.every((h) => h !== null)).toBe(true);
      await observe('17 Research + Factory together', research, `${a.status}/${b.status}`, (await ok(research.access)) && (await ok(factory.access)));
      await observe('18 + Admin/Fleet reads', factory, `${a.status}/${b.status}`, await ok(factory.access));
    }
    // 19. One worker serving two surfaces; one surface's fire meets the outage.
    {
      const one = await connector('m19a');
      const two = await connector('m19b');
      const sentAt = new Date(Date.now() - 2 * 3_600_000);
      await inOutage(sentAt);
      await unansweredFire(one.routineId, sentAt);
      await observe('19 shared worker across surfaces', one, '503 at the door', (await ok(one.access)) && (await ok(two.access)));
    }
    // 20. Genuinely revoked.
    {
      const c = await connector('m20');
      await getDb().run("UPDATE oauth_tokens SET revoked_at = ?, revoked_reason = 'EXPLICIT' WHERE client_id = ?", [
        new Date().toISOString(),
        c.clientId,
      ]);
      const r = await whoami(c.access);
      await observe('20 genuinely revoked', c, `${r.status} Not authorized`, await ok(c.access));
    }

    // eslint-disable-next-line no-console
    console.table(rows);
    expect(rows).toHaveLength(20);
    for (const row of rows.filter((r) => !r.case.startsWith('20'))) {
      expect(row, row.case).toMatchObject({ reconnect: false, quarantine: 0, recovered: true });
      expect(row.connector, row.case).not.toBe('HUMAN_REAUTH_REQUIRED');
      expect(row.client, row.case).not.toMatch(/^401/);
      expect(row.noShow, row.case).not.toMatch(/NO_SHOW|AUTH/);
    }
    const revoked = rows.find((r) => r.case.startsWith('20'))!;
    expect(revoked).toMatchObject({ reconnect: true, connector: 'HUMAN_REAUTH_REQUIRED', recovered: false });
  });
});

/* ------------------------------------------------------------------------ */
/* The closure's own regressions                                             */
/* ------------------------------------------------------------------------ */

describe('the rest of the chain does not turn a database failure into a verdict', () => {
  it('a code exchange that met a database failure rolls back whole, so the same code still works', async () => {
    const { issueAuthorizationCode } = await import('../server/repos/oauth.ts');
    const { generateOpaqueSecret } = await import('../server/services/identity/secrets.ts');
    const crypto = await import('node:crypto');
    const client = await registerClient({
      clientName: 'Brain (exchange)',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      secretDigest: null,
      tokenAuthMethod: 'none',
    });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = generateOpaqueSecret();
    await issueAuthorizationCode({
      codeDigest: code.digest,
      clientId: client.clientId,
      workerId,
      approvedByUserId: 'usr_test',
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource: RESOURCE,
      scope: '',
    });
    const exchange = () =>
      fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.clientId,
          code: code.plaintext,
          code_verifier: verifier,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }).toString(),
      });
    // The grant's second insert fails: before, the code was already spent.
    injectFault((sql) => sql.includes('INSERT INTO oauth_tokens'), TERMINATED, 1);
    const during = await exchange();
    restore!();
    expect(during.status).toBe(503);
    expect(((await during.json()) as Record<string, unknown>)['error']).toBe('temporarily_unavailable');
    const after = await exchange();
    expect(after.status).toBe(200);
    const pair = (await after.json()) as Record<string, string>;
    expect((await whoami(pair['access_token']!)).status).toBe(200);
    // One grant, not a half-written one beside it.
    const roots = await getDb().all("SELECT id FROM oauth_tokens WHERE kind = 'REFRESH' AND client_id = ?", [client.clientId]);
    expect(roots).toHaveLength(1);
  });

  it('a routing read that fails is a retry, not "no work" and not a refusal on record', async () => {
    startInfraIncidentRecorder();
    await readyBin();
    injectFault((sql) => sql.includes('worker_routing'), ECHECKOUT);
    const result = await checkIn({ principal: workerPrincipal(), workerId, sessionRef: 'cse_routing' });
    restore!();
    expect(result).toEqual({ assigned: false, reason: 'RETRY_LATER' });
    expect((await getDb().all('SELECT * FROM bin_session_refusals')).length).toBe(0);
    await settleInfraIncidents();
    const unserved = await getDb().get<{ session_ref: string }>("SELECT session_ref FROM infra_incidents WHERE kind = 'UNSERVED_ARRIVAL'");
    expect(unserved?.session_ref).toBe('cse_routing');
  });

  it('a lease whose assignment row could not be written still leaves evidence that its session arrived', async () => {
    startInfraIncidentRecorder();
    await readyBin();
    injectFault((sql) => sql.includes('INSERT INTO bin_events') || sql.includes('bin_dispatch'), poolTimeout);
    const result = await checkIn({ principal: workerPrincipal(), workerId, sessionRef: 'claude-code-session_took_it' });
    restore!();
    expect(result.assigned).toBe(true);
    await settleInfraIncidents();
    const row = await getDb().get<{ session_ref: string; detail: string }>(
      "SELECT session_ref, detail FROM infra_incidents WHERE kind = 'UNSERVED_ARRIVAL'",
    );
    expect(row).toMatchObject({ session_ref: 'claude-code-session_took_it', detail: 'ARRIVED_ASSIGNMENT_UNRECORDED' });
    // The fire that produced it, recorded in the fire's spelling, is not a no-show.
    const c = await connector('took-it');
    await unansweredFire(c.routineId, new Date(Date.now() - 60 * 60_000), 'cse_took_it', 0);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
    expect(await eventsOf('DISPATCH_INFRA_NO_SHOW', c.routineId)).toBe(1);
  });

  it('a session that arrived later than fifteen minutes is still its own fire’s answer', async () => {
    const c = await connector('late');
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, session_ref, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_late', 'UNSERVED_ARRIVAL', 'check_in', 'session_late', ?, ?, 1, 0, ?)`,
      [new Date(sentAt.getTime() + 25 * 60_000).toISOString(), new Date(sentAt.getTime() + 25 * 60_000).toISOString(), new Date().toISOString()],
    );
    await unansweredFire(c.routineId, sentAt, 'cse_late');
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
  });

  it('no fire is judged while the restart window is still being established', async () => {
    const c = await connector('pending-restart');
    injectFault((sql) => sql.includes('runtime_liveness'), ECHECKOUT);
    await expect(recordProcessStart()).rejects.toThrow();
    restore!();
    // Within the defer limit the row is left SENT rather than charged.
    // Stale (past thirty minutes) and inside the defer limit (twice that).
    await unansweredFire(c.routineId, new Date(Date.now() - 40 * 60_000), null, 30 * 60_000);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(0);
    expect((await getDb().get<{ state: string }>("SELECT state FROM bin_dispatch WHERE routine_id = ?", [c.routineId]))!.state).toBe('SENT');
    // Once the window is known, judging resumes.
    await recordProcessStart();
    await reopenNoShowDispatches(30 * 60_000, 50);
    expect(await eventsOf('DISPATCH_NO_SHOW', c.routineId)).toBe(1);
  });

  it('a browser’s failed authentication does not excuse a fired session’s no-show', async () => {
    const c = await connector('browser');
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    await getDb().run(
      `INSERT INTO infra_incidents (id, kind, surface, started_at, ended_at, occurrences, affects_arrival, created_at)
       VALUES ('inc_http', 'POOL_CHECKOUT_TIMEOUT', 'http:auth@WORKLOAD', ?, ?, 1, 0, ?)`,
      [new Date(sentAt.getTime() + 20_000).toISOString(), new Date(sentAt.getTime() + 20_000).toISOString(), new Date().toISOString()],
    );
    startInfraIncidentRecorder();
    injectFault(EVERYTHING, poolTimeout);
    await fetch(`${base}/api/ping`, { headers: { authorization: `Bearer ${c.access}` } });
    restore!();
    await settleInfraIncidents();
    const recorded = await getDb().get<{ affects_arrival: number }>(
      "SELECT affects_arrival FROM infra_incidents WHERE surface LIKE 'http:auth%' AND id <> 'inc_http'",
    );
    expect(Number(recorded!.affects_arrival)).toBe(0);
  });

  it('work registered after commit runs after commit, in no transaction, and not at all after a rollback', async () => {
    const { afterCommit, inTransaction } = await import('../server/db/database.ts');
    const seen: string[] = [];
    await getDb().transaction(async () => {
      afterCommit(() => {
        seen.push(inTransaction() ? 'inside' : 'outside');
      });
      expect(seen).toEqual([]);
    });
    for (let i = 0; i < 20 && seen.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(['outside']);
    await expect(
      getDb().transaction(async () => {
        afterCommit(() => seen.push('rolled back'));
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual(['outside']);
  });
});
