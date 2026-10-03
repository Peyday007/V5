/**
 * A signed-in member reconnecting their own connector, with no invitation left.
 *
 * Production, 2026-10-03 08:37Z: Airyn pressed Reconnect. Claude registered a
 * fresh OAuth client and opened `/oauth/authorize` in a browser already signed
 * in to Brain as him; both of his invitations had been spent connecting the
 * first time; and Brain rendered "Sign in to connect a worker" to somebody who
 * was signed in. Nothing proceeded until an administrator issued a third link.
 *
 * This suite reproduces that shape — two members on one shared worker, each
 * with their own logical connector established the way production establishes
 * one (a member-bound invitation consented on an earlier client) — and then
 * asserts the reconnect restores *that* connector without an administrator, and
 * refuses every way it could reach someone else's.
 *
 * Run against a real server over a real socket: the consent page, the form post
 * and the redirect are transport behaviour.
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
import { createInvitation } from '../server/repos/invitations.ts';
import { generateInvitationToken } from '../server/services/identity/secrets.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(8200, 100);
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
let workerId = '';
let workerLabel = '';

interface Member {
  id: string;
  cookie: string;
  connectorId: string;
  /** The client the first connection created — the one a lost refresh broke. */
  oldClientId: string;
  /** That client's refresh token, which Claude would present to refresh. */
  oldRefresh: string;
}
let airyn: Member;
let caleb: Member;
let stranger: { id: string; cookie: string };
let dana: Member;
let otherWorkerId = '';

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

async function createMember(email: string, name: string): Promise<{ id: string; cookie: string }> {
  const created = await api<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName: name, password: 'temporary-password-01' },
  });
  const first = await signIn(email, 'temporary-password-01');
  await api('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: 'member-password-000001' },
  });
  const cookie = await signIn(email, 'member-password-000001');
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalId: created.body.user.id, principalType: 'HUMAN', role: 'MEMBER' },
  });
  return { id: created.body.user.id, cookie };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function register(name: string): Promise<string> {
  const registered = await api<{ client_id: string }>('POST', '/oauth/register', {
    body: { client_name: name, redirect_uris: [REDIRECT] },
  });
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
  const form = authorizeQuery(clientId, challenge, { worker_id: options.worker ?? workerId, ...(options.extra ?? {}) });
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

/**
 * A member's connector, established the way production establishes one: a
 * logical connector, a member-bound invitation naming it, consented on the
 * member's first OAuth client, and a token issued and used. The invitation is
 * spent by that consent — which is exactly the state Airyn was in.
 */
async function connectMember(person: { id: string; cookie: string }, account: string): Promise<Member> {
  const connectorId = `cnr_${account}`;
  const token = await withDb(async () => {
    const admin = await getDb().get<{ id: string }>('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO connectors (id, account_id, resource, worker_id, label, created_at, updated_at)
       VALUES (?, ?, '/mcp', ?, NULL, ?, ?)`,
      [connectorId, `acct_${account}`, workerId, now, now],
    );
    const generated = generateInvitationToken();
    await createInvitation({
      workerId,
      tokenPrefix: generated.prefix,
      tokenDigest: generated.digest,
      createdByUserId: admin!.id,
      kind: 'ADDITIONAL',
      intendedUserId: person.id,
      connectorId,
    });
    return generated.plaintext;
  });
  const oldClientId = await register(`Claude (${account}, first)`);
  const approved = await approve(oldClientId, `${person.cookie}; brain_invite=${encodeURIComponent(token)}`);
  if (!approved.code) throw new Error(`first connection for ${account} produced no code: ${approved.status}`);
  const tokens = await exchange(oldClientId, approved.code, approved.verifier);
  if (!tokens['access_token']) throw new Error(`first exchange failed: ${JSON.stringify(tokens)}`);
  return { ...person, connectorId, oldClientId, oldRefresh: tokens['refresh_token']! };
}

async function invitationCount(): Promise<number> {
  return withDb(async () => (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM worker_invitations'))!.n);
}

async function pageEvents(clientId: string): Promise<Record<string, unknown>[]> {
  return withDb(async () => {
    const rows = await getDb().all<{ metadata: string }>(
      `SELECT metadata FROM identity_events WHERE action = 'OAUTH_AUTHORIZE_PAGE' AND target_id = ? ORDER BY created_at`,
      [clientId],
    );
    return rows.map((row) => JSON.parse(row.metadata) as Record<string, unknown>);
  });
}

/* -- setup ----------------------------------------------------------------- */

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-member-reconnect-'));
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

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP);
  await api('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const seeded = await api<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
  projectId = seeded.body.projects[0]!.id;

  // One worker shared by two members' Claude accounts: worker-10's shape.
  const worker = await api<{ worker: { id: string; label: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'factory-brain', displayName: 'Factory Brain' },
  });
  workerId = worker.body.worker.id;
  workerLabel = worker.body.worker.label;
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalId: workerId, principalType: 'WORKER', scopes: ['project:read', 'queue:read'] },
  });

  airyn = await connectMember(await createMember('airyn@example.invalid', 'Airyn'), 'airyn');
  caleb = await connectMember(await createMember('caleb@example.invalid', 'Caleb'), 'caleb');
  stranger = await createMember('stranger@example.invalid', 'Stranger');
  dana = await connectMember(await createMember('dana@example.invalid', 'Dana'), 'dana');
  const other = await api<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'research-brain', displayName: 'Research Brain' },
  });
  otherWorkerId = other.body.worker.id;
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalId: otherWorkerId, principalType: 'WORKER', scopes: ['project:read'] },
  });
}, 120_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* -- tests ----------------------------------------------------------------- */

describe('a signed-in member reconnecting their own connector', () => {
  let newClientId = '';

  it('restores the same connector on a fresh client, with no administrator and no invitation', async () => {
    const invitationsBefore = await invitationCount();
    // Both members' invitations were spent by their first connection.
    expect(
      await withDb(async () =>
        (await getDb().get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM worker_invitations WHERE redeemed_at IS NULL AND revoked_at IS NULL',
        ))!.n,
      ),
    ).toBe(0);

    newClientId = await register('Claude (airyn, reconnected)');
    const page = await authorizePage(newClientId, airyn.cookie);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain('Sign in to connect a worker');
    expect(page.html).toContain(`Reconnect ${workerLabel}`);
    expect(page.html).toContain(airyn.connectorId);
    expect(page.html).not.toContain(caleb.connectorId);
    // One worker, pre-bound: no list to choose from.
    expect(page.html.match(/name="worker_id"/g)?.length).toBe(1);

    const approved = await approve(newClientId, airyn.cookie);
    expect(approved.code).not.toBeNull();
    // Approval alone attaches nothing: a client id is public, so the binding
    // waits for the holder of the verifier and the client's secret.
    expect(
      await withDb(async () => getDb().get('SELECT 1 FROM connector_clients WHERE client_id = ?', [newClientId])),
    ).toBeUndefined();
    const tokens = await exchange(newClientId, approved.code!, approved.verifier);
    expect(tokens['access_token']).toBeTruthy();
    expect(tokens['refresh_token']).toBeTruthy();

    // The token is used, and MCP authenticates it as the connector's worker.
    const call = await whoami(tokens['access_token']!);
    expect(call.status).toBe(200);
    expect(call.worker).toMatchObject({ principalType: "WORKER", handle: workerLabel });

    await withDb(async () => {
      const attached = await getDb().get<{ connector_id: string; source: string }>(
        'SELECT connector_id, source FROM connector_clients WHERE client_id = ?',
        [newClientId],
      );
      expect(attached).toEqual({ connector_id: airyn.connectorId, source: 'MEMBER_RECONNECT' });
      // Both clients are history under one connector.
      const clients = await getDb().all<{ client_id: string }>(
        'SELECT client_id FROM connector_clients WHERE connector_id = ? ORDER BY attached_at',
        [airyn.connectorId],
      );
      expect(clients.map((one) => one.client_id)).toEqual([airyn.oldClientId, newClientId]);
      // No new logical connector.
      const connectors = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM connectors');
      expect(connectors!.n).toBe(3);
    });
    expect(await invitationCount()).toBe(invitationsBefore);
  });

  it('leaves the other member’s connector on the same worker untouched', async () => {
    await withDb(async () => {
      const calebClients = await getDb().all<{ client_id: string }>(
        'SELECT client_id FROM connector_clients WHERE connector_id = ?',
        [caleb.connectorId],
      );
      expect(calebClients.map((one) => one.client_id)).toEqual([caleb.oldClientId]);
      const revoked = await getDb().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NOT NULL',
        [caleb.oldClientId],
      );
      expect(revoked!.n).toBe(0);
    });
    // And Caleb's own reconnect resolves to Caleb's connector, not Airyn's.
    const calebNew = await register('Claude (caleb, reconnected)');
    const page = await authorizePage(calebNew, caleb.cookie);
    expect(page.html).toContain(caleb.connectorId);
    expect(page.html).not.toContain(airyn.connectorId);
  });

  it('refuses another member on a client that is already that member’s connector', async () => {
    // Caleb's browser, Airyn's reconnected client.
    const page = await authorizePage(newClientId, caleb.cookie);
    expect(page.status).toBe(403);
    expect(page.html).not.toContain('Sign in to connect a worker');
    const approved = await approve(newClientId, caleb.cookie);
    expect(approved.code).toBeNull();
    expect(approved.status).toBe(403);
    await withDb(async () => {
      const attached = await getDb().get<{ connector_id: string }>(
        'SELECT connector_id FROM connector_clients WHERE client_id = ?',
        [newClientId],
      );
      expect(attached!.connector_id).toBe(airyn.connectorId);
    });
  });

  it('refuses a request asking for more than the connector was ever granted', async () => {
    const client = await register('Claude (airyn, wider)');
    const approved = await approve(client, airyn.cookie, { extra: { scope: 'admin:all' } });
    expect(approved.code).toBeNull();
    expect(approved.status).toBe(403);
  });

  it('refuses a request for another endpoint, where the member has no connector', async () => {
    const client = await register('Claude (airyn, factory endpoint)');
    const page = await authorizePage(client, airyn.cookie, { resource: `${BASE}/mcp/factory` });
    expect(page.status).toBe(403);
    expect(page.html).toContain('cannot determine which connector you are reconnecting');
    const approved = await approve(client, airyn.cookie, { extra: { resource: `${BASE}/mcp/factory` } });
    expect(approved.code).toBeNull();
  });

  it('never shows a signed-in member the sign-in page, and says what to do instead', async () => {
    const client = await register('Claude (stranger)');
    const page = await authorizePage(client, stranger.cookie);
    expect(page.status).toBe(403);
    expect(page.html).not.toContain('Sign in to connect a worker');
    expect(page.html).toContain('This account is signed in');
    expect(page.html).toContain('cannot determine which connector you are reconnecting');
    expect(page.html).toContain('connectors reconnect');
    // Signed out, the sign-in page is still the right answer.
    const anonymous = await authorizePage(client, '');
    expect(anonymous.html).toContain('Sign in to connect a worker');
  });

  it('records who was signed in, the connector, the endpoint and the reason on every decision', async () => {
    const restored = await pageEvents(newClientId);
    const offered = restored.find((one) => one['decision'] === 'MEMBER_RECONNECT');
    expect(offered).toMatchObject({
      userId: airyn.id,
      clientId: newClientId,
      endpoint: '/mcp',
      connectorIds: [airyn.connectorId],
    });
    expect(String(offered!['reason'])).toContain('consent on invitation');
    const refusedCaleb = restored.find((one) => one['decision'] === 'SIGNED_IN_UNRESOLVED');
    expect(refusedCaleb).toMatchObject({ userId: caleb.id, reason: 'CLIENT_ATTACHED_ELSEWHERE' });

    const client = await register('Claude (audit, anonymous)');
    await authorizePage(client, '');
    const anonymous = await pageEvents(client);
    expect(anonymous[0]).toMatchObject({ decision: 'SIGN_IN', userId: null, endpoint: '/mcp' });

    // No row of any decision carries a token, a code or a secret.
    const all = await withDb(async () =>
      getDb().all<{ metadata: string }>(`SELECT metadata FROM identity_events WHERE action LIKE 'OAUTH%'`),
    );
    for (const row of all) expect(row.metadata).not.toMatch(/brno_|brnr_|code_verifier|client_secret/);
  });

  it('refuses a forged worker on the member path', async () => {
    const client = await register('Claude (airyn, forged worker)');
    const approved = await approve(client, airyn.cookie, { worker: otherWorkerId });
    expect(approved.code).toBeNull();
    expect(approved.status).toBe(403);
  });

  it('refuses a member holding an invitation bound to somebody else', async () => {
    const token = await withDb(async () => {
      const admin = await getDb().get<{ id: string }>('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
      const generated = generateInvitationToken();
      await createInvitation({
        workerId,
        tokenPrefix: generated.prefix,
        tokenDigest: generated.digest,
        createdByUserId: admin!.id,
        kind: 'ADDITIONAL',
        intendedUserId: airyn.id,
        connectorId: airyn.connectorId,
      });
      return generated.plaintext;
    });
    const client = await register('Claude (caleb, holding airyn’s link)');
    const approved = await approve(client, `${caleb.cookie}; brain_invite=${encodeURIComponent(token)}`);
    expect(approved.code).toBeNull();
    expect(approved.status).toBe(403);
    // Left unspent for the person it is for, then withdrawn so it does not
    // count as an unused invitation in later cases.
    await withDb(async () => {
      await getDb().run(
        `UPDATE worker_invitations SET revoked_at = ? WHERE intended_user_id = ? AND redeemed_at IS NULL`,
        [new Date().toISOString(), airyn.id],
      );
    });
  });

  it('does not undo a withdrawal, even after Claude’s refresh was refused', async () => {
    // An administrator withdraws Caleb's connector; Claude then tries to
    // refresh and is refused, which is the ordinary sequence after a revocation
    // and the one that flips the health verdict to a refused credential.
    await withDb(async () => {
      const { revokeTokensForClients } = await import('../server/repos/oauth.ts');
      await revokeTokensForClients([caleb.oldClientId]);
    });
    const refused = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: caleb.oldRefresh,
        client_id: caleb.oldClientId,
      }).toString(),
    });
    expect(refused.status).toBe(400);
    const client = await register('Claude (caleb, after withdrawal)');
    const page = await authorizePage(client, caleb.cookie);
    expect(page.status).toBe(403);
    expect(page.html).toContain('explicitly withdrawn');
    expect((await pageEvents(client))[0]).toMatchObject({ reason: 'CONSENT_REVOKED', userId: caleb.id });
    const approved = await approve(client, caleb.cookie);
    expect(approved.code).toBeNull();
  });

  it('gives a member who handed the connection back no claim to it', async () => {
    await withDb(async () => {
      const now = new Date().toISOString();
      await getDb().run(
        `INSERT INTO capacity_connections
           (id, user_id, connector_name, routine_name, secret_name, account_id, worker_id, state, created_at, updated_at)
         VALUES ('ccn_dana', ?, 'Brain (dana)', 'Dana routine', 'SECRET_DANA', 'acct_dana', ?, 'REVOKED', ?, ?)`,
        [dana.id, workerId, now, now],
      );
    });
    const client = await register('Claude (dana, after giving it back)');
    const page = await authorizePage(client, dana.cookie);
    expect(page.status).toBe(403);
    expect((await pageEvents(client))[0]).toMatchObject({ reason: 'NO_CONNECTOR_FOR_MEMBER', userId: dana.id });
  });

  it('does not guess between two connectors a member could be reconnecting', async () => {
    // A second connector of Airyn's at the same endpoint, established the same
    // way the first was: an administrator's invitation bound to him.
    const second = await connectMember(
      { id: airyn.id, cookie: airyn.cookie },
      'airyn_second',
    );
    const client = await register('Claude (airyn, ambiguous)');
    const page = await authorizePage(client, airyn.cookie);
    expect(page.status).toBe(403);
    expect(page.html).toContain('more than one connector at this endpoint');
    const approved = await approve(client, airyn.cookie);
    expect(approved.code).toBeNull();
    const events = await pageEvents(client);
    expect(events[0]).toMatchObject({ decision: 'SIGNED_IN_UNRESOLVED', reason: 'AMBIGUOUS_CONNECTORS', userId: airyn.id });
    expect((events[0]!['connectorIds'] as string[]).sort()).toEqual([airyn.connectorId, second.connectorId].sort());
  });
});
