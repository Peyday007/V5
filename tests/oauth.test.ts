/**
 * The OAuth authorization server, written as an attack.
 *
 * One property matters more than all the others here and it is asserted from
 * several directions:
 *
 *   **A token resolves to the worker, never to the human who approved it.**
 *
 * Everything else in this file exists because getting OAuth subtly wrong is
 * easy and the failure modes are quiet: an open redirector, a replayable code,
 * a PKCE check that can be skipped by omitting a field, a client that can swap
 * its own identity at the token step. Each of those is a real, published way to
 * turn an authorization server into a credential dispenser.
 *
 * Run against a real server process over a real socket, because the discovery
 * documents, the redirect and the form posts are transport behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_SCOPES } from '../server/domain/types.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6500 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';

let adminCookie = '';
let memberCookie = '';
let projectId = '';
let workerId = '';
let orphanWorkerId = '';
let clientId = '';

interface Reply<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function api<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown; bearer?: string } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
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
    /* html pages are not json, and that is not a failure of this helper */
  }
  return { status: response.status, body: body as T, headers: response.headers };
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

/** A PKCE pair, generated the way a conformant client would. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeForm(
  challenge: string,
  extra: Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: '',
    ...extra,
  });
}

/** Approve as the administrator and return the redirect's code, or null. */
async function approve(
  challenge: string,
  options: { cookie?: string; worker?: string; extra?: Record<string, string> } = {},
): Promise<{ status: number; location: string | null; code: string | null }> {
  const form = authorizeForm(challenge, {
    worker_id: options.worker ?? workerId,
    ...(options.extra ?? {}),
  });
  const response = await fetch(`${BASE}/oauth/authorize/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      ...(options.cookie === undefined ? { cookie: adminCookie } : options.cookie ? { cookie: options.cookie } : {}),
    },
    body: form.toString(),
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  let code: string | null = null;
  if (location) {
    try {
      code = new URL(location).searchParams.get('code');
    } catch {
      code = null;
    }
  }
  return { status: response.status, location, code };
}

async function exchange(body: Record<string, string>): Promise<Reply<Record<string, string>>> {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: response.status, body: parsed as Record<string, string>, headers: response.headers };
}

/** A full, honest authorization: approve, then exchange with the right verifier. */
async function connectedToken(worker = workerId): Promise<string> {
  const { verifier, challenge } = pkce();
  const approved = await approve(challenge, { worker });
  if (!approved.code) throw new Error(`approval produced no code: ${approved.status}`);
  const token = await exchange({
    grant_type: 'authorization_code',
    code: approved.code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  const access = token.body['access_token'];
  if (!access) throw new Error(`token exchange failed: ${JSON.stringify(token.body)}`);
  return access;
}

/** One MCP tool call, using whatever bearer is given. */
async function callTool(
  bearer: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; structured: Record<string, unknown>; isError: boolean }> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as { result?: Record<string, unknown> };
  const result = parsed.result ?? {};
  return {
    status: response.status,
    structured: (result['structuredContent'] ?? {}) as Record<string, unknown>,
    // A transport refusal is an error too.
    //
    // `isError` comes off the JSON-RPC `result`, and a 401 or 403 has no result
    // at all — so a plain `result['isError'] === true` reads false both when the
    // call succeeded and when it was rejected outright. Every
    // `expect(...isError).toBe(false)` in these suites is a "prove this works
    // before we break it" line, and that is precisely where a false pass does
    // the most damage: it makes the refusal on the next line look like proof of
    // something when nothing was ever working.
    isError: result['isError'] === true || !response.ok,
  };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-oauth-'));
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

  // An ordinary member, to prove that approving a connection is administrative.
  const member = await api<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email: 'member@example.invalid', displayName: 'Member', password: 'temporary-password-01' },
  });
  const first = await signIn('member@example.invalid', 'temporary-password-01');
  await api('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: MEMBER_PASSWORD },
  });
  memberCookie = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalId: member.body.user.id, principalType: 'HUMAN', role: 'MEMBER' },
  });

  const worker = await api<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'claude-max-worker-01', displayName: 'Claude Max Worker 01' },
  });
  workerId = worker.body.worker.id;
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: {
      principalId: workerId,
      principalType: 'WORKER',
      scopes: ['project:read', 'documents:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
    },
  });

  // A worker with no membership at all, to prove a pointless connection is caught.
  const orphan = await api<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'orphan-worker', displayName: 'Orphan' },
  });
  orphanWorkerId = orphan.body.worker.id;

  const registered = await api<{ client_id: string }>('POST', '/oauth/register', {
    body: { client_name: 'Claude', redirect_uris: [REDIRECT] },
  });
  clientId = registered.body.client_id;
}, 90_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ */

describe('discovery', () => {
  it('publishes protected resource metadata, which the MCP profile makes mandatory', async () => {
    const reply = await api<Record<string, unknown>>('GET', '/.well-known/oauth-protected-resource');
    expect(reply.status).toBe(200);
    expect(reply.body['resource']).toBe(`${BASE}/mcp`);
    expect(reply.body['authorization_servers']).toEqual([BASE]);
  });

  it('publishes authorization server metadata naming every endpoint it serves', async () => {
    const reply = await api<Record<string, unknown>>('GET', '/.well-known/oauth-authorization-server');
    expect(reply.status).toBe(200);
    expect(reply.body['authorization_endpoint']).toBe(`${BASE}/oauth/authorize`);
    expect(reply.body['token_endpoint']).toBe(`${BASE}/oauth/token`);
    expect(reply.body['registration_endpoint']).toBe(`${BASE}/oauth/register`);
  });

  it('advertises S256 only, because plain is refused', async () => {
    const reply = await api<Record<string, unknown>>('GET', '/.well-known/oauth-authorization-server');
    // Advertising a method the authorize endpoint rejects would be advertising
    // something that does not work.
    expect(reply.body['code_challenge_methods_supported']).toEqual(['S256']);
  });

  it('points an unauthenticated MCP caller at the metadata', async () => {
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(response.status).toBe(401);
    // Without this header a conformant client has nothing to go on and simply
    // fails. It is the whole discovery chain.
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('serves discovery through the outer access gate without a second password', async () => {
    // A Basic prompt in front of the document that says how to authenticate
    // would make the flow undiscoverable.
    const reply = await api('GET', '/.well-known/oauth-protected-resource');
    expect(reply.status).toBe(200);
  });
});

describe('client registration', () => {
  it('registers a public client with no secret, for PKCE alone', async () => {
    const reply = await api<Record<string, unknown>>('POST', '/oauth/register', {
      body: { client_name: 'Some client', redirect_uris: [REDIRECT] },
    });
    expect(reply.status).toBe(201);
    expect(typeof reply.body['client_id']).toBe('string');
    expect(reply.body['client_secret']).toBeUndefined();
  });

  it('refuses a registration with no redirect', async () => {
    const reply = await api('POST', '/oauth/register', { body: { client_name: 'No redirect' } });
    expect(reply.status).toBe(400);
  });

  it('refuses a non-https redirect that is not localhost', async () => {
    const reply = await api('POST', '/oauth/register', {
      body: { client_name: 'Insecure', redirect_uris: ['http://evil.example/cb'] },
    });
    expect(reply.status).toBe(400);
  });
});

describe('the consent screen', () => {
  it('asks an unauthenticated visitor to sign in to the Brain', async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Sign in to the Brain');
  });

  it('shows the signed-in administrator what access it is granting', async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`, {
      headers: { cookie: adminCookie },
    });
    const html = await response.text();
    expect(html).toContain('Connect a worker');
    // The decision is only meaningful if the access is on screen beside it.
    expect(html).toContain('claude-max-worker-01');
    expect(html).toContain('queue:claim');
  });

  it('refuses an unknown client without redirecting anywhere', async () => {
    const { challenge } = pkce();
    const query = authorizeForm(challenge);
    query.set('client_id', 'brnc_not_registered');
    const response = await fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('refuses an unregistered redirect by rendering, never by bouncing to it', async () => {
    const { challenge } = pkce();
    const query = authorizeForm(challenge);
    query.set('redirect_uri', 'https://evil.example/steal');
    const response = await fetch(`${BASE}/oauth/authorize?${query}`, { redirect: 'manual' });
    // Redirecting an error to an unvalidated URI is exactly how an open
    // redirector is built.
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('refuses a request with no PKCE challenge', async () => {
    const query = authorizeForm('');
    query.delete('code_challenge');
    const response = await fetch(`${BASE}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
  });

  it('refuses code_challenge_method=plain', async () => {
    const { challenge } = pkce();
    const query = authorizeForm(challenge);
    query.set('code_challenge_method', 'plain');
    const response = await fetch(`${BASE}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
  });

  it('refuses any response_type but code', async () => {
    const { challenge } = pkce();
    const query = authorizeForm(challenge);
    query.set('response_type', 'token');
    const response = await fetch(`${BASE}/oauth/authorize?${query}`);
    expect(response.status).toBe(400);
  });
});

describe('who may approve', () => {
  it('lets a Brain administrator approve', async () => {
    const { challenge } = pkce();
    const approved = await approve(challenge);
    expect(approved.status).toBe(302);
    expect(approved.code).toBeTruthy();
  });

  it('refuses an anonymous approval', async () => {
    const { challenge } = pkce();
    const approved = await approve(challenge, { cookie: '' });
    expect(approved.status).toBe(403);
    expect(approved.code).toBeNull();
  });

  it('refuses an ordinary member, because this is an administrative act', async () => {
    // Choosing which identity a remote client may act as is the same authority
    // as creating the worker.
    const { challenge } = pkce();
    const approved = await approve(challenge, { cookie: memberCookie });
    expect(approved.status).toBe(403);
    expect(approved.code).toBeNull();
  });

  it('refuses a worker bearer token trying to approve its own connection', async () => {
    const access = await connectedToken();
    const response = await fetch(`${BASE}/oauth/authorize/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE,
        authorization: `Bearer ${access}`,
      },
      body: authorizeForm(pkce().challenge, { worker_id: workerId }).toString(),
      redirect: 'manual',
    });
    // A machine widening its own access is the thing this must never allow.
    expect(response.status).toBe(403);
  });

  it('refuses a cross-site form post', async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        cookie: adminCookie,
      },
      body: authorizeForm(challenge, { worker_id: workerId }).toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(403);
  });

  it('refuses to connect a worker that is a member of nothing', async () => {
    const { challenge } = pkce();
    const approved = await approve(challenge, { worker: orphanWorkerId });
    // Not a security hole — it just could not do anything — but silently
    // issuing a useless token turns into a puzzling refusal much later.
    expect(approved.status).toBe(400);
    expect(approved.code).toBeNull();
  });
});

describe('the token exchange', () => {
  it('issues an access and a refresh token for a correct verifier', async () => {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    expect(token.body['token_type']).toBe('Bearer');
    expect(token.body['access_token']).toMatch(/^brnt_/);
    expect(token.body['refresh_token']).toMatch(/^brnt_/);
  });

  it('refuses a wrong PKCE verifier', async () => {
    const { challenge } = pkce();
    const approved = await approve(challenge);
    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: crypto.randomBytes(48).toString('base64url'),
    });
    expect(token.status).toBe(400);
    expect(token.body['error']).toBe('invalid_grant');
  });

  it('refuses an omitted verifier rather than skipping the check', async () => {
    const { challenge } = pkce();
    const approved = await approve(challenge);
    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(token.status).toBe(400);
  });

  it('refuses a code redeemed twice', async () => {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const body = {
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    expect((await exchange(body)).status).toBe(200);
    // Redeemed by a guarded UPDATE, so an intercepted code is usable at most
    // once even if two requests arrive together.
    const second = await exchange(body);
    expect(second.status).toBe(400);
    expect(second.body['error']).toBe('invalid_grant');
  });

  it('refuses a code presented by a different client', async () => {
    const other = await api<{ client_id: string }>('POST', '/oauth/register', {
      body: { client_name: 'Other', redirect_uris: [REDIRECT] },
    });
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: other.body.client_id,
      code_verifier: verifier,
    });
    expect(token.status).toBe(400);
  });

  it('refuses a mismatched redirect_uri at the token step', async () => {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: 'https://claude.ai/api/mcp/other_callback',
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token.status).toBe(400);
  });

  it('refuses an unknown grant type', async () => {
    const token = await exchange({ grant_type: 'password', client_id: clientId });
    expect(token.status).toBe(400);
    expect(token.body['error']).toBe('unsupported_grant_type');
  });

  it('rotates a refresh token and revokes the one it replaced', async () => {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const first = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    const refresh = first.body['refresh_token']!;

    const second = await exchange({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(second.status).toBe(200);
    expect(second.body['access_token']).toBeTruthy();

    // A stolen copy is usable at most once, and its reuse is visible.
    const reused = await exchange({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId });
    expect(reused.status).toBe(400);
  });

  it('never lets an access token be used as a refresh token', async () => {
    const access = await connectedToken();
    const token = await exchange({ grant_type: 'refresh_token', refresh_token: access, client_id: clientId });
    expect(token.status).toBe(400);
  });
});

describe('the invariant: a token is the worker, not the approver', () => {
  it('resolves to the worker that was chosen on the consent screen', async () => {
    const access = await connectedToken();
    const who = await callTool(access, 'brain_whoami');
    expect(who.isError).toBe(false);
    // The administrator approved it. The administrator is not who it is.
    expect(who.structured['principalType']).toBe('WORKER');
    expect(who.structured['handle']).toBe('claude-max-worker-01');
  });

  it('carries the workerscopes, not the administrator’s authority', async () => {
    const access = await connectedToken();
    const who = await callTool(access, 'brain_whoami');
    const memberships = (who.structured['memberships'] ?? []) as { projectId: string; scopes: string[] }[];
    expect(memberships.length).toBe(1);
    expect(memberships[0]!.projectId).toBe(projectId);
    // An administrator can reach every project. This token reaches one.
    expect(memberships[0]!.scopes).not.toContain('research:write');
  });

  it('cannot reach a project the worker is not a member of', async () => {
    const access = await connectedToken();
    const denied = await callTool(access, 'brain_get_project', { project_id: 'prj_0000000000000000' });
    expect(denied.isError).toBe(true);
  });

  it('cannot use an administrator-only operation', async () => {
    const access = await connectedToken();
    // A worker administers nothing, whatever the token was approved by.
    const reply = await api('POST', '/api/admin/workers', {
      bearer: access,
      body: { name: 'self-made', displayName: 'Self made' },
    });
    expect(reply.status).toBe(404);
  });

  it('is refused at the browser API, because a worker is not a person', async () => {
    const access = await connectedToken();
    const reply = await api('GET', '/api/admin/users', { bearer: access });
    expect(reply.status).toBe(404);
  });
});

describe('lifecycle', () => {
  it('stops working the moment its worker is disabled', async () => {
    const disposable = await api<{ worker: { id: string } }>('POST', '/api/admin/workers', {
      cookie: adminCookie,
      body: { name: 'short-lived-worker', displayName: 'Short lived' },
    });
    const id = disposable.body.worker.id;
    await api('POST', `/api/admin/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { principalId: id, principalType: 'WORKER', scopes: ['project:read'] },
    });
    const access = await connectedToken(id);
    expect((await callTool(access, 'brain_whoami')).isError).toBe(false);

    const disable = await api('POST', `/api/admin/workers/${id}/disabled`, {
      cookie: adminCookie,
      body: { disabled: true },
    });
    // Asserted, because the first version of this test called a route that does
    // not exist. It got a 404, the worker was never disabled, and the test then
    // "failed" for the right reason by accident — which would have read as a
    // security bug in the token path rather than a typo in the test.
    expect(disable.status).toBe(200);

    // Read live on every request, so this lands on the next call rather than
    // when the token happens to expire.
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${access}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses an invented token exactly as it refuses a revoked one', async () => {
    const invented = 'brnt_0123456789abcdef.notarealsecretvaluehere';
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${invented}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(response.status).toBe(401);
  });

  it('still accepts a Step 7 worker credential, which was not replaced', async () => {
    const issued = await api<{ secret: string }>('POST', `/api/admin/workers/${workerId}/credentials`, {
      cookie: adminCookie,
      body: {},
    });
    const who = await callTool(issued.body.secret, 'brain_whoami');
    expect(who.isError).toBe(false);
    expect(who.structured['handle']).toBe('claude-max-worker-01');
  });
});

describe('secrets', () => {
  it('never returns a token or a code in a page', async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`, {
      headers: { cookie: adminCookie },
    });
    const html = await response.text();
    expect(html).not.toContain('brnt_');
    expect(html).not.toContain(adminCookie.split('=')[1] ?? 'IMPOSSIBLE');
  });

  it('marks the token response no-store', async () => {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token.headers.get('cache-control')).toContain('no-store');
  });

  it('puts the code in the redirect and nowhere else', async () => {
    const { challenge } = pkce();
    const approved = await approve(challenge);
    expect(approved.code).toBeTruthy();
    expect(approved.location!.startsWith(REDIRECT)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* The operator console                                                      */
/* ------------------------------------------------------------------------ */

describe('the operator console', () => {
  async function operatorPage(options: { cookie?: string; bearer?: string } = {}): Promise<{
    status: number;
    html: string;
  }> {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    const response = await fetch(`${BASE}/operator`, { headers });
    return { status: response.status, html: await response.text() };
  }

  async function post(
    route: string,
    fields: Record<string, string | string[]>,
    options: { cookie?: string; bearer?: string; origin?: string } = {},
  ): Promise<{ status: number; html: string }> {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (Array.isArray(value)) value.forEach((v) => form.append(name, v));
      else form.append(name, value);
    }
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      origin: options.origin ?? BASE,
    };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    const response = await fetch(`${BASE}${route}`, { method: 'POST', headers, body: form.toString() });
    return { status: response.status, html: await response.text() };
  }

  it('shows an administrator the workers and their access', async () => {
    const shown = await operatorPage({ cookie: adminCookie });
    expect(shown.status).toBe(200);
    expect(shown.html).toContain('claude-max-worker-01');
    expect(shown.html).toContain('Create a worker');
  });

  it('offers a sign-in form to somebody who is not signed in', async () => {
    // The first version returned a bare 404 here, which hid the console from
    // strangers and also told an administrator whose session had expired that
    // the page did not exist, with nothing to click. A control that is
    // indistinguishable from a broken deployment costs more than it saves.
    //
    // This discloses nothing: the Brain already serves a sign-in page at its
    // root to the whole internet.
    const anonymous = await operatorPage();
    expect(anonymous.status).toBe(401);
    expect(anonymous.html).toContain('Sign in');
  });

  it('still does not exist for somebody signed in who may not be here', async () => {
    // The case that must stay hidden: a caller who has already proved they are
    // not an administrator learns nothing about whether this path is anything.
    const member = await operatorPage({ cookie: memberCookie });
    expect(member.status).toBe(404);
    expect(member.html).not.toContain('Sign in');
    expect(member.html).not.toContain('Create a worker');
  });

  it('signs an administrator in and lands them on the console', async () => {
    const form = new URLSearchParams({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const response = await fetch(`${BASE}/operator/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/operator');
    expect(response.headers.get('set-cookie')).toContain('brain_session=');
  });

  it('refuses a wrong password with one message', async () => {
    const form = new URLSearchParams({ email: ADMIN_EMAIL, password: 'not-the-password-01' });
    const response = await fetch(`${BASE}/operator/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('were not accepted');
  });

  it('is refused to a worker holding a perfectly good token', async () => {
    const access = await connectedToken();
    // A machine reaching the screen that grants credentials is the single worst
    // thing this console could allow.
    expect((await operatorPage({ bearer: access })).status).toBe(404);
  });

  it('creates an empty project to point a worker at', async () => {
    // Until this existed the only project was the seeded one holding real
    // research, so the only way to give a test worker somewhere to work would
    // have been to grant it that.
    const made = await post('/operator/projects', { name: 'Step 8 Acceptance' }, { cookie: adminCookie });
    expect(made.status).toBe(200);
    expect(made.html).toContain('Step 8 Acceptance');

    const again = await post('/operator/projects', { name: 'Step 8 Acceptance' }, { cookie: adminCookie });
    expect(again.status).toBe(409);
  });

  it('refuses a project name that is not one', async () => {
    expect((await post('/operator/projects', { name: 'x' }, { cookie: adminCookie })).status).toBe(400);
  });

  it('will not let anybody but an administrator create a project', async () => {
    expect((await post('/operator/projects', { name: 'Sneaky' }, { cookie: memberCookie })).status).toBe(404);
    const access = await connectedToken();
    expect((await post('/operator/projects', { name: 'Sneakier' }, { bearer: access })).status).toBe(404);
  });

  it('creates a worker, and refuses a duplicate name', async () => {
    const made = await post('/operator/workers', { name: 'console-made-worker', displayName: 'Console Made' }, { cookie: adminCookie });
    expect(made.status).toBe(200);
    expect(made.html).toContain('console-made-worker');

    const again = await post('/operator/workers', { name: 'console-made-worker', displayName: 'Again' }, { cookie: adminCookie });
    expect(again.status).toBe(409);
  });

  it('refuses a canonical name that is not one', async () => {
    const bad = await post('/operator/workers', { name: 'Not A Name!', displayName: 'x' }, { cookie: adminCookie });
    expect(bad.status).toBe(400);
  });

  it('can take a project away again, not only give one', async () => {
    // Granting without revoking is a ratchet rather than access control. This
    // console was one, and the first mis-set dropdown granted a test worker the
    // project holding real research with no way back from the screen that did
    // it.
    const granted = await post(
      '/operator/memberships',
      { worker_id: workerId, project_id: projectId, scopes: ['project:read'] },
      { cookie: adminCookie },
    );
    expect(granted.status).toBe(200);

    const access = await connectedToken();
    expect((await callTool(access, 'brain_whoami')).isError).toBe(false);

    const revoked = await post(
      '/operator/memberships/revoke',
      { worker_id: workerId, project_id: projectId },
      { cookie: adminCookie },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.html).toContain('can no longer reach');

    // It lands on the next call rather than at the next sign-in: memberships
    // are read per request, so there is nothing to expire and nothing to
    // reconnect. The same token now sees no projects at all.
    const who = await callTool(access, 'brain_whoami');
    expect(who.isError).toBe(false);
    expect((who.structured['memberships'] as unknown[]).length).toBe(0);

    // Put it back for the tests that follow.
    await post(
      '/operator/memberships',
      {
        worker_id: workerId,
        project_id: projectId,
        scopes: ['project:read', 'documents:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
      },
      { cookie: adminCookie },
    );
  });

  it('will not let anybody but an administrator take a project away', async () => {
    expect(
      (await post('/operator/memberships/revoke', { worker_id: workerId, project_id: projectId }, { cookie: memberCookie }))
        .status,
    ).toBe(404);
    const access = await connectedToken();
    expect(
      (await post('/operator/memberships/revoke', { worker_id: workerId, project_id: projectId }, { bearer: access }))
        .status,
    ).toBe(404);
  });

  it('offers every scope that exists, so a new one cannot go missing from the picker', async () => {
    // The picker is grouped by hand for legibility, which means a scope added
    // to WORKER_SCOPES later would simply not appear — ungrantable, with
    // nothing to notice. Grouping buys clarity; this is what it costs.
    const shown = await operatorPage({ cookie: adminCookie });
    for (const scope of WORKER_SCOPES) {
      expect(shown.html, `the picker is missing ${scope}`).toContain(`value="${scope}"`);
    }
  });

  it('makes the operator choose a project rather than defaulting to one', async () => {
    // A select with no placeholder is pre-set to its first option, so a form
    // submitted without opening the dropdown grants whatever sorts first. That
    // is exactly how a worker meant for a throwaway project was granted the one
    // holding real research.
    const shown = await operatorPage({ cookie: adminCookie });
    expect(shown.html).toContain('<option value="" disabled selected>');
  });

  it('refuses an unknown scope rather than dropping it', async () => {
    // Silently ignoring a typo would look like a successful narrower grant.
    const bad = await post(
      '/operator/memberships',
      { worker_id: workerId, project_id: projectId, scopes: ['queue:read', 'queue:invented'] },
      { cookie: adminCookie },
    );
    expect(bad.status).toBe(400);
  });

  it('queues a bounded work item for a worker to claim', async () => {
    // The gap this closes: an operator with a connected worker and an empty
    // queue had nothing to point it at, and the only way to put an item there
    // was curl — a terminal, for the operation whose whole point is proving the
    // browser path works.
    const queued = await post(
      '/operator/work',
      { project_id: projectId, note: 'Step 8 acceptance item' },
      { cookie: adminCookie },
    );
    expect(queued.status).toBe(200);
    expect(queued.html).toContain('A worker holding queue:claim there can take it');

    // Not merely rendered — the item is really in the queue, read back from the
    // authoritative Brain rather than from the page that claimed to have made it.
    const listed = await api<{ items: { workType: string; state: string; payload: { note?: string } }[] }>(
      'GET',
      `/api/projects/${projectId}/work?state=QUEUED`,
      { cookie: adminCookie },
    );
    expect(listed.status).toBe(200);
    const mine = listed.body.items.find((item) => item.payload.note === 'Step 8 acceptance item');
    expect(mine).toBeTruthy();
    expect(mine!.workType).toBe('SYNTHETIC_ECHO');
    expect(mine!.state).toBe('QUEUED');
  });

  it('records what the id actually names, rather than calling everything a worker', async () => {
    // The console's audit helper hard-coded WORKER, which was true for every
    // operation it originally had and became a lie the moment it gained two
    // that act on something else. An audit row you cannot read back correctly
    // is worse than no row: it resolves to a worker that does not exist.
    const audit = await api<{ events: { action: string; targetType: string | null; targetId: string | null }[] }>(
      'GET',
      '/api/admin/identity-events?limit=200',
      { cookie: adminCookie },
    );
    expect(audit.status).toBe(200);

    const enqueued = audit.body.events.find((event) => event.action === 'QUEUE_ENQUEUE');
    expect(enqueued?.targetType).toBe('WORK_ITEM');

    const created = audit.body.events.find((event) => event.action === 'CREATE_PROJECT');
    expect(created?.targetType).toBe('PROJECT');

    // And the operation that really is about a worker still says so.
    const granted = audit.body.events.find((event) => event.action === 'GRANT_MEMBERSHIP');
    expect(granted?.targetType).toBe('WORKER');
  });

  it('will not queue work into a project that does not exist', async () => {
    const missing = await post(
      '/operator/work',
      { project_id: 'prj_does_not_exist', note: 'nowhere' },
      { cookie: adminCookie },
    );
    expect(missing.status).toBe(404);
  });

  it('will not let a worker queue its own work, however good its token', async () => {
    // A machine that could create its own work could also create work nobody
    // asked for. The console refuses a bearer token outright, and the HTTP
    // route refuses it in policy — both, because either alone is one mistake
    // away from being skipped.
    const access = await connectedToken();
    expect((await post('/operator/work', { project_id: projectId }, { bearer: access })).status).toBe(404);

    // First prove the refusal below is about *enqueueing* rather than about
    // this project. The worker is a full member of it holding queue:claim, and
    // reading the same project's queue works — so a blanket "no access here"
    // cannot be what produces the 404.
    const reading = await fetch(`${BASE}/api/projects/${projectId}/work?state=QUEUED`, {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(reading.status).toBe(200);

    const direct = await fetch(`${BASE}/api/projects/${projectId}/work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` },
      body: JSON.stringify({ workType: 'SYNTHETIC_ECHO', payload: { note: 'self-dealt' } }),
    });
    expect(direct.status).toBe(404);
  });

  it('will not let an ordinary member queue work from the console', async () => {
    expect((await post('/operator/work', { project_id: projectId }, { cookie: memberCookie })).status).toBe(404);
  });

  it('refuses a cross-site post', async () => {
    const forged = await post(
      '/operator/workers',
      { name: 'forged-worker', displayName: 'Forged' },
      { cookie: adminCookie, origin: 'https://evil.example' },
    );
    expect(forged.status).toBe(404);
  });

  it('shows an issued credential exactly once, and never again', async () => {
    const issued = await post('/operator/credentials', { worker_id: workerId }, { cookie: adminCookie });
    expect(issued.status).toBe(200);
    const shown = /brnw_[0-9a-f]{16}\.[A-Za-z0-9_-]+/.exec(issued.html)?.[0];
    expect(shown).toBeTruthy();

    // It works, so it really was the credential and not a placeholder.
    const who = await callTool(shown!, 'brain_whoami');
    expect(who.isError).toBe(false);

    // And it is nowhere on the page the next time it is loaded.
    const later = await operatorPage({ cookie: adminCookie });
    expect(later.html).not.toContain(shown!);
  });

  it('ends live connections when a worker is disabled', async () => {
    const created = await post('/operator/workers', { name: 'ending-worker', displayName: 'Ending' }, { cookie: adminCookie });
    expect(created.status).toBe(200);
    const list = await api<{ workers: { id: string; name: string }[] }>('GET', '/api/admin/workers', {
      cookie: adminCookie,
    });
    const target = list.body.workers.find((w) => w.name === 'ending-worker')!;
    await api('POST', `/api/admin/projects/${projectId}/members`, {
      cookie: adminCookie,
      body: { principalId: target.id, principalType: 'WORKER', scopes: ['project:read'] },
    });

    const access = await connectedToken(target.id);
    expect((await callTool(access, 'brain_whoami')).isError).toBe(false);

    const disabled = await post(
      `/operator/workers/${target.id}/disabled`,
      { disabled: 'true' },
      { cookie: adminCookie },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.html).toContain('connection(s) were ended');

    const after = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${access}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(after.status).toBe(401);
  });
});
