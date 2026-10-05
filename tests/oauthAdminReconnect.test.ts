/**
 * An administrator reconnecting an existing research connector keeps its worker.
 *
 * Production, 2026-10-03 04:52–04:59Z: the owner reconnected the Brain Research
 * A research connector. Claude registered a fresh OAuth client, the consent
 * screen offered every worker in the Brain with nothing tying the new client to
 * the connector it replaced, and the approval posted another member's worker
 * (worker-04). Every token since authenticated as worker-04, and the first
 * proven arrival then *created* the Brain Research A connector as worker-04 and
 * bound the worker-05 Routine to it. Cash Mode 1 research — worker-05's — could
 * not run.
 *
 * This suite reproduces the shape: two accounts, one research connector each,
 * at one endpoint, on two different workers. A reconnect chooses a connector,
 * keeps its worker, attaches under the same logical connector, and cannot be
 * steered to the other account's worker; and an arrival as the wrong worker is
 * never adopted as a connector's identity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { attributeArrival } from '../server/services/fleet/connectorBinding.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(9850, 100);
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = `${BASE}/mcp`;

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

let adminCookie = '';
let projectId = '';

let researchWorker = { id: '', label: '' };
let calebWorker = { id: '', label: '' };
let ownerRoutineId = '';
const OWNER_CONNECTOR = 'cnr_owner_research';
const CALEB_CONNECTOR = 'cnr_caleb_research';

/* -- helpers --------------------------------------------------------------- */

async function api<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie && method !== 'GET') headers.origin = BASE;
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* html */
  }
  return { status: response.status, body: body as T };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed for ${email}: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Client secrets by client id, for the token step. */
const secrets = new Map<string, string>();

/** A confidential client, registered the way Claude's connector registers (client_secret_post). */
async function register(name: string, method: 'client_secret_post' | 'none' = 'client_secret_post'): Promise<string> {
  const registered = await api<{ client_id: string; client_secret?: string }>('POST', '/oauth/register', {
    body: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: method },
  });
  if (registered.body.client_secret) secrets.set(registered.body.client_id, registered.body.client_secret);
  return registered.body.client_id;
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: '',
    resource: RESOURCE,
    ...extra,
  });
}

async function authorizePage(
  clientId: string,
  cookie: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; html: string }> {
  const { challenge } = pkce();
  const response = await fetch(`${BASE}/oauth/authorize?${authorizeQuery(clientId, challenge, extra)}`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, html: await response.text() };
}

async function approve(
  clientId: string,
  cookie: string,
  options: { worker?: string; extra?: Record<string, string> } = {},
): Promise<{ status: number; code: string | null; verifier: string }> {
  const { verifier, challenge } = pkce();
  const form = authorizeQuery(clientId, challenge, { worker_id: options.worker ?? '', ...(options.extra ?? {}) });
  const response = await fetch(`${BASE}/oauth/authorize/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
    body: form.toString(),
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  return { status: response.status, code: location ? new URL(location).searchParams.get('code') : null, verifier };
}

async function exchange(clientId: string, code: string, verifier: string): Promise<Record<string, string>> {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      ...(secrets.has(clientId) ? { client_secret: secrets.get(clientId)! } : {}),
    }).toString(),
  });
  return (await response.json()) as Record<string, string>;
}

/** One authenticated MCP call with this bearer: does the token actually work? */
async function whoami(bearer: string): Promise<{ status: number; worker: unknown }> {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'brain_whoami',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'brain_whoami',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const parsed = (await response.json().catch(() => ({}))) as { result?: { structuredContent?: Record<string, unknown> } };
  return { status: response.status, worker: parsed.result?.structuredContent ?? null };
}

async function withDb<T>(work: () => Promise<T>): Promise<T> {
  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  try {
    return await work();
  } finally {
    await closeDatabase();
  }
}


async function setup(): Promise<void> {
  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP);
  await api('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const seeded = await api<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
  projectId = seeded.body.projects[0]!.id;

  const make = async (name: string, displayName: string): Promise<{ id: string; label: string }> => {
    // Named so that the other member's worker sorts *before* the owner's on a
    // list: a default or a slip on a bare chooser is exactly the failure.
    const created = await api<{ worker: { id: string; label: string } }>('POST', '/api/admin/workers', {
      cookie: adminCookie,
      body: { name, displayName },
    });
    await api('POST', `/api/admin/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { principalId: created.body.worker.id, principalType: 'WORKER', scopes: ['project:read', 'queue:read'] },
    });
    return created.body.worker;
  };
  calebWorker = await make('a-calebworker1', 'Caleb worker');
  researchWorker = await make('b-research-brain', 'Research Brain');

  await withDb(async () => {
    const now = new Date().toISOString();
    const owner = await createAccount({ name: 'Brain Research A' });
    const caleb = await createAccount({ name: 'Caleb' });
    const ownerRoutine = await createRoutine({
      accountId: owner.id, routineRef: 'trig_owner_a', name: 'Brain Research A', tokenSecretName: 'S_OWNER',
      workerId: researchWorker.id,
    });
    ownerRoutineId = ownerRoutine.id;
    const calebRoutine = await createRoutine({
      accountId: caleb.id, routineRef: 'trig_caleb_a', name: 'Caleb 3-A', tokenSecretName: 'S_CALEB',
      workerId: calebWorker.id,
    });
    for (const [id, account, worker] of [
      [OWNER_CONNECTOR, owner.id, researchWorker.id],
      [CALEB_CONNECTOR, caleb.id, calebWorker.id],
    ] as const) {
      await getDb().run(
        `INSERT INTO connectors (id, account_id, resource, worker_id, label, created_at, updated_at)
         VALUES (?, ?, '/mcp', ?, NULL, ?, ?)`,
        [id, account, worker, now, now],
      );
    }
    await getDb().run('UPDATE fleet_routines SET connector_id = ? WHERE id = ?', [OWNER_CONNECTOR, ownerRoutine.id]);
    await getDb().run('UPDATE fleet_routines SET connector_id = ? WHERE id = ?', [CALEB_CONNECTOR, calebRoutine.id]);
  });
}

async function approveTarget(
  clientId: string,
  target: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; code: string | null; verifier: string }> {
  const { verifier, challenge } = pkce();
  const form = authorizeQuery(clientId, challenge, { target, ...extra });
  const response = await fetch(`${BASE}/oauth/authorize/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: adminCookie },
    body: form.toString(),
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  return { status: response.status, code: location ? new URL(location).searchParams.get('code') : null, verifier };
}

async function connectorRow(id: string): Promise<{ worker_id: string }> {
  return withDb(async () => (await getDb().get<{ worker_id: string }>('SELECT worker_id FROM connectors WHERE id = ?', [id]))!);
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-admin-reconnect-'));
  server = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        BRAIN_DB_PATH: undefined,
        BRAIN_DATA_DIR: dataDir,
        PORT: String(PORT),
        NODE_ENV: 'test',
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await setup();
}, 120_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('an administrator reconnecting an existing research connector', () => {
  it('is offered the connectors at this endpoint, with nothing preselected', async () => {
    const clientId = await register('Claude (owner, reconnect)');
    const page = await authorizePage(clientId, adminCookie);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`value="${OWNER_CONNECTOR}"`);
    expect(page.html).toContain(`value="${CALEB_CONNECTOR}"`);
    expect(page.html).toContain(`Reconnect Brain Research A — keeps ${researchWorker.label}`);
    expect(page.html).toContain('<option value="" selected disabled>');
    // No worker option carries `selected`: a slip cannot become a binding.
    expect(page.html).not.toMatch(/<option value="wkr_[^"]*" selected/);
  });

  it('reconnects under the same logical connector, and the token authenticates as its worker', async () => {
    const clientId = await register('Claude (owner, reconnect 2)');
    const approved = await approveTarget(clientId, OWNER_CONNECTOR);
    expect(approved.code).not.toBeNull();
    const tokens = await exchange(clientId, approved.code!, approved.verifier);
    const call = await whoami(tokens['access_token']!);
    expect(call.status).toBe(200);
    expect(call.worker).toMatchObject({ principalType: 'WORKER', handle: researchWorker.label });
    await withDb(async () => {
      const attached = await getDb().get<{ connector_id: string }>(
        'SELECT connector_id FROM connector_clients WHERE client_id = ?',
        [clientId],
      );
      expect(attached?.connector_id).toBe(OWNER_CONNECTOR);
      expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM connectors'))!.n).toBe(2);
    });
    expect((await connectorRow(OWNER_CONNECTOR)).worker_id).toBe(researchWorker.id);
    expect((await connectorRow(CALEB_CONNECTOR)).worker_id).toBe(calebWorker.id);
  });

  it('refuses a form edited to carry another worker, and mints nothing', async () => {
    const clientId = await register('Claude (owner, tampered)');
    const approved = await approveTarget(clientId, OWNER_CONNECTOR, { worker_id: calebWorker.id });
    expect(approved.status).toBe(403);
    expect(approved.code).toBeNull();
    expect((await connectorRow(OWNER_CONNECTOR)).worker_id).toBe(researchWorker.id);
  });

  it('the other account at the same endpoint reconnects its own connector without stealing the owner’s', async () => {
    const clientId = await register('Claude (caleb, reconnect)');
    const approved = await approveTarget(clientId, CALEB_CONNECTOR);
    const tokens = await exchange(clientId, approved.code!, approved.verifier);
    expect((await whoami(tokens['access_token']!)).worker).toMatchObject({ handle: calebWorker.label });
    expect((await connectorRow(OWNER_CONNECTOR)).worker_id).toBe(researchWorker.id);
    // A client already attached to Caleb's connector cannot be re-aimed at the owner's.
    const again = await approveTarget(clientId, OWNER_CONNECTOR);
    expect(again.status).toBe(403);
    expect(again.code).toBeNull();
  });

  it('an arrival as the wrong worker is never adopted as a connector or a Routine binding', async () => {
    // The production shape: a token minted for Caleb's worker arriving at the
    // owner's Routine (registered for the research worker).
    const clientId = await register('Claude (owner, wrong worker)');
    const { verifier, challenge } = pkce();
    const form = authorizeQuery(clientId, challenge, { target: `${calebWorker.id}` });
    const response = await fetch(`${BASE}/oauth/authorize/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie: adminCookie },
      body: form.toString(),
      redirect: 'manual',
    });
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    await exchange(clientId, code, verifier);
    await withDb(async () => {
      await getDb().run('UPDATE fleet_routines SET connector_id = NULL WHERE id = ?', [ownerRoutineId]);
      await getDb().run('DELETE FROM connector_clients WHERE connector_id = ?', [OWNER_CONNECTOR]);
      await getDb().run('DELETE FROM connectors WHERE id = ?', [OWNER_CONNECTOR]);
      const token = await getDb().get<{ id: string }>(
        "SELECT id FROM oauth_tokens WHERE client_id = ? AND kind = 'ACCESS'",
        [clientId],
      );
      const outcome = await attributeArrival({
        routineId: ownerRoutineId,
        workerId: calebWorker.id,
        credentialId: token!.id,
        proven: true,
      });
      expect(outcome.outcome).toBe('CONFLICT');
      expect(outcome.reason).toContain(researchWorker.id);
      expect(await getDb().get("SELECT 1 FROM connectors WHERE resource = '/mcp' AND worker_id = ? AND id <> ?", [
        calebWorker.id,
        CALEB_CONNECTOR,
      ])).toBeUndefined();
      const routine = await getDb().get<{ connector_id: string | null }>(
        'SELECT connector_id FROM fleet_routines WHERE id = ?',
        [ownerRoutineId],
      );
      expect(routine?.connector_id).toBeNull();
    });
  });

  it('a connector enshrined as the wrong worker is restored to its Routines’ worker on reconnect', async () => {
    await withDb(async () => {
      const now = new Date().toISOString();
      const owner = await getDb().get<{ account_id: string }>('SELECT account_id FROM fleet_routines WHERE id = ?', [ownerRoutineId]);
      await getDb().run(
        `INSERT INTO connectors (id, account_id, resource, worker_id, label, created_at, updated_at)
         VALUES (?, ?, '/mcp', ?, NULL, ?, ?)`,
        [OWNER_CONNECTOR, owner!.account_id, calebWorker.id, now, now],
      );
      await getDb().run('UPDATE fleet_routines SET connector_id = ? WHERE id = ?', [OWNER_CONNECTOR, ownerRoutineId]);
    });
    const clientId = await register('Claude (owner, restore)');
    const page = await authorizePage(clientId, adminCookie);
    expect(page.html).toContain(`Reconnect Brain Research A — keeps ${researchWorker.label}`);
    const approved = await approveTarget(clientId, OWNER_CONNECTOR);
    const tokens = await exchange(clientId, approved.code!, approved.verifier);
    expect((await whoami(tokens['access_token']!)).worker).toMatchObject({ handle: researchWorker.label });
    expect((await connectorRow(OWNER_CONNECTOR)).worker_id).toBe(researchWorker.id);
  });
});
