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
import { MCP_PATHS } from '../server/mcp/endpoint.ts';
import { CONNECTOR_SCOPES, WORKER_SCOPES } from '../server/domain/types.ts';
import type { WorkerScope } from '../server/domain/types.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(6500, 100);
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
// The neutral labels Brain assigned. Every screen names a worker by these;
// the handles above are lookup keys and appear on no page. See migration 074.
let workerLabel = '';
let orphanLabel = '';
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
/** Identity events of one action, read from the shared file between requests. */
async function eventsOf(
  action: string,
): Promise<{ target_id: string | null; result: string; metadata: Record<string, unknown> }[]> {
  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  try {
    const rows = await getDb().all<{ target_id: string | null; result: string; metadata: string }>(
      'SELECT target_id, result, metadata FROM identity_events WHERE action = ?',
      [action],
    );
    return rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> }));
  } finally {
    await closeDatabase();
  }
}

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

  const worker = await api<{ worker: { id: string; label: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'claude-max-worker-01', displayName: 'Claude Max Worker 01' },
  });
  workerId = worker.body.worker.id;
  workerLabel = worker.body.worker.label;
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: {
      principalId: workerId,
      principalType: 'WORKER',
      scopes: ['project:read', 'documents:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
    },
  });

  // A worker with no membership at all, to prove a pointless connection is caught.
  const orphan = await api<{ worker: { id: string; label: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'orphan-worker', displayName: 'Orphan' },
  });
  orphanWorkerId = orphan.body.worker.id;
  orphanLabel = orphan.body.worker.label;

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

describe('an invitation in an administrator\u2019s browser', () => {
  /*
   * The correction this exists to pin, in one sentence: **a chooser is not
   * evidence that the invitation link was opened wrongly.**
   *
   * `/oauth/authorize` looks for a signed-in administrator *before* it looks
   * for an invitation, and deliberately so — an invitation stands in for an
   * administrator's approval, and somebody who already is one has that
   * authority in their own right. Folding the two together would be the thing
   * `invitedApproval` warns against, and it would also stop an administrator
   * connecting a worker their browser happens to hold a stale invitation for.
   *
   * The defect was the silence. Onboarding told people a list meant the link
   * had not been opened in that browser, so the person who had just pressed
   * Onboard — signed in, by definition — was sent round the flow again looking
   * for a fault that was not there. The screen now names the held invitation
   * and preselects its worker, and the instruction says so.
   *
   * Two things must stay true, and both are asserted: the invitation is
   * **display only** on this path, and it is **not spent** by it.
   */
  async function inviteCookieFor(
    worker: string,
  ): Promise<{ cookie: string; id: string; token: string }> {
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    try {
      const admin = await getDb().get<{ id: string }>('SELECT id FROM users WHERE email = ?', [
        ADMIN_EMAIL,
      ]);
      const token = generateInvitationToken();
      const invitation = await createInvitation({
        workerId: worker,
        tokenPrefix: token.prefix,
        tokenDigest: token.digest,
        createdByUserId: admin!.id,
      });
      return {
        cookie: `brain_invite=${encodeURIComponent(token.plaintext)}`,
        id: invitation.id,
        token: token.plaintext,
      };
    } finally {
      await closeDatabase();
    }
  }

  async function isLive(id: string): Promise<boolean> {
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    try {
      const row = await getDb().get<{ redeemed_at: string | null }>(
        'SELECT redeemed_at FROM worker_invitations WHERE id = ?',
        [id],
      );
      return row !== undefined && row.redeemed_at === null;
    } finally {
      await closeDatabase();
    }
  }

  it('still shows the chooser, and says which worker the invitation names', async () => {
    const held = await inviteCookieFor(orphanWorkerId);
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`, {
      headers: { cookie: `${adminCookie}; ${held.cookie}` },
    });
    const html = await response.text();

    // The chooser, not the single-worker invited screen: the administrator's
    // own authority is what this page runs on.
    expect(html).toContain('Connect a worker');
    expect(html).toContain(workerLabel);
    // By its neutral identity, never by the handle somebody typed: this is the
    // screen where an identity is chosen, so a name that implies whose account
    // it is, is how the wrong one gets picked.
    expect(html).not.toContain('claude-max-worker-01');
    // And the answer to "why am I being shown a list".
    expect(html).toContain('This browser holds an invitation for');
    expect(html).toContain(orphanLabel);
    expect(html).not.toContain('orphan-worker');
    expect(html).toContain('the invitation is not used');
    // Preselected, so the ordinary case is one click.
    expect(html).toMatch(new RegExp(`value="${orphanWorkerId}" selected`));

    // Reading the screen spends nothing.
    expect(await isLive(held.id)).toBe(true);
  });

  it('does not let the held invitation decide who is connected', async () => {
    /*
     * Display only. The administrator posts a different worker and gets that
     * worker — the invitation neither authorized it nor constrained it, and it
     * is still unspent afterwards. On the *invited* path the posted id is
     * checked against the invitation and a mismatch is refused outright; that
     * rule is unchanged and is asserted elsewhere in this file.
     */
    const held = await inviteCookieFor(orphanWorkerId);
    const { challenge, verifier } = pkce();
    const approved = await approve(challenge, {
      cookie: `${adminCookie}; ${held.cookie}`,
      worker: workerId,
    });
    expect(approved.code).not.toBeNull();

    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token.status).toBe(200);
    expect(await isLive(held.id)).toBe(true);
  });

  it('names every address the endpoint answers on, so the recipient is not sent to a refusal', async () => {
    /*
     * Claude keys its connector registry by URL, so a page that named exactly
     * one address was an instruction the second connector could not follow.
     * Read from `MCP_PATHS` rather than restated, because a mounted path this
     * page did not mention is a person told to use a URL that is refused.
     */
    const held = await inviteCookieFor(orphanWorkerId);
    const response = await fetch(`${BASE}/oauth/invite/${encodeURIComponent(held.token)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const mcpPath of MCP_PATHS) {
      expect(html, mcpPath).toContain(`<code>${BASE}${mcpPath}</code>`);
    }
    expect(html).toContain('the same endpoint under different names');
    // Opening still spends nothing.
    expect(await isLive(held.id)).toBe(true);
  });

  it('keeps the single-worker screen for somebody who is not signed in', async () => {
    // The invited path is untouched by the change above: no chooser, no list,
    // and the worker named rather than offered.
    const held = await inviteCookieFor(orphanWorkerId);
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`, {
      headers: { cookie: held.cookie },
    });
    const html = await response.text();
    expect(html).not.toContain('Connect a worker');
    expect(html).toContain('connecting on an invitation');
    expect(html).toContain(orphanLabel);
    expect(html).not.toContain('orphan-worker');
    expect(html).not.toContain(workerLabel);
    expect(html).not.toContain('claude-max-worker-01');
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
  it('sends an unauthenticated visitor to sign in, names the credential that works, and asks for nothing', async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('Sign in to connect a worker');
    // Where a reconnect ended is recorded, so a failed one is not silent.
    const shown = (await eventsOf('OAUTH_AUTHORIZE_PAGE')).filter((row) => row.target_id === clientId);
    expect(shown.map((row) => row.metadata['shown'])).toContain('SIGN_IN');
    /*
     * And it names the credential the served screen actually asks for.
     *
     * This page told people to press **Sign in with your device** and said the
     * Brain has no sign-in form. Both were true before a six-digit PIN replaced
     * the passkey and neither has been since: the screen is a form, it takes a
     * name and a PIN, and there is no device button to press. A member who
     * followed it met a PIN box with nothing to type and no way to find out
     * why — and this assertion pinned the wrong instruction in place, which is
     * why it survived the migration that made it false.
     */
    expect(html).not.toContain('Sign in with your device');
    expect(html).not.toContain('no sign-in form');
    expect(html).toContain('six-digit PIN');
    /*
     * And it collects nothing. This page used to carry an address and a
     * password and post them to `/api/auth/login`, which was the one surface
     * still offering a password as an ordinary way in — see
     * `services/identity/passwordDoor.ts`. The operator is in a browser on this
     * Brain's own origin, so the Brain is one tab away and **Continue** is this
     * same request re-asked with its parameters intact.
     */
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="email"');
    expect(html).toContain('/oauth/authorize');
  });

  it('shows the signed-in administrator what access it is granting', async () => {
    const { challenge } = pkce();
    const response = await fetch(`${BASE}/oauth/authorize?${authorizeForm(challenge)}`, {
      headers: { cookie: adminCookie },
    });
    const html = await response.text();
    expect(html).toContain('Connect a worker');
    // The decision is only meaningful if the access is on screen beside it —
    // and the worker is named by what it is, not by whom it sounds like.
    expect(html).toContain(workerLabel);
    expect(html).not.toContain('claude-max-worker-01');
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

  /** A connected client's first token response, from a fresh authorization. */
  async function firstPair(): Promise<Record<string, string>> {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    const first = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    return first.body;
  }

  const refresh = (token: string): Promise<Reply<Record<string, string>>> =>
    exchange({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId });

  it('rotates a refresh token, and refuses its replay once the replacement has itself been redeemed', async () => {
    const original = (await firstPair())['refresh_token']!;
    const second = await refresh(original);
    expect(second.status).toBe(200);
    // The client carried on with what it was given, and rotated again later.
    expect((await callTool(second.body['access_token']!, 'brain_whoami')).isError).toBe(false);
    const third = await refresh(second.body['refresh_token']!);
    expect(third.status).toBe(200);

    // A stolen copy of the first token is now provably stale, and its reuse is visible.
    const reused = await refresh(original);
    expect(reused.status).toBe(400);
    expect((await callTool(third.body['access_token']!, 'brain_whoami')).isError).toBe(false);

    // Visible means recorded: a refused refresh is the step after which a
    // connector reports it "stopped working", and it used to leave no row.
    const refusals = await eventsOf('OAUTH_TOKEN');
    expect(
      refusals.some(
        (row) =>
          row.result === 'DENIED' && row.metadata['clientId'] === clientId && row.metadata['reason'] === 'REUSED',
      ),
    ).toBe(true);
  });

  /*
   * The 2026-09-27, 09-30, 10-01 and 10-03 incidents. A refresh committed on the
   * server and its response never reached the client, so the client retried
   * with the token it still held. The retry is answered with the *same*
   * successor, as often as the reply is lost, so there is only ever one
   * credential for the client to end up holding.
   */
  it('answers a refresh whose response was lost with the same successor, as often as it is lost', async () => {
    const original = (await firstPair())['refresh_token']!;
    const lost = await refresh(original); // committed; the client never saw it
    expect(lost.status).toBe(200);

    const retried = await refresh(original);
    expect(retried.status).toBe(200);
    expect(retried.body['refresh_token']).toBe(lost.body['refresh_token']);
    expect((await callTool(retried.body['access_token']!, 'brain_whoami')).isError).toBe(false);
    const again = await refresh(original);
    expect(again.body['refresh_token']).toBe(lost.body['refresh_token']);

    // The recovered chain carries on normally, and then the original is stale.
    const next = await refresh(retried.body['refresh_token']!);
    expect(next.status).toBe(200);
    expect((await refresh(original)).status).toBe(400);
  });

  it('gives two refreshes racing with one token one successor, which both sessions can use', async () => {
    const original = (await firstPair())['refresh_token']!;
    const [a, b] = await Promise.all([refresh(original), refresh(original)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body['refresh_token']).toBe(b.body['refresh_token']);
    for (const reply of [a, b]) {
      expect((await callTool(reply.body['access_token']!, 'brain_whoami')).isError).toBe(false);
    }
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
    // And what it answers with is the *neutral* identity, never the handle
    // whoever created the row happened to type. A worker called after a person
    // made every reader treat `brain_whoami` as a statement about whose Claude
    // account had run the session, which it has never been — see migration 074.
    expect(who.structured['handle']).toMatch(/^worker-\d\d$/);
    expect(who.structured['handle']).not.toBe('claude-max-worker-01');
    expect(who.structured['displayName']).not.toBe('claude-max-worker-01');
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
    // Both eras answer with the same neutral identity: the label is a property
    // of the worker row, so it cannot differ by which credential was presented.
    expect(who.structured['handle']).toMatch(/^worker-\d\d$/);
    expect(who.structured['handle']).not.toBe('claude-max-worker-01');
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
/* The operator console, and the fact that it is gone                        */
/* ------------------------------------------------------------------------ */

/**
 * There used to be nine hundred lines here.
 *
 * They tested a server-rendered console that created workers, granted them
 * projects, issued their credentials, queued work, started packets and
 * archived identities — and the argument for it was that it was the surface
 * you need when the client bundle is broken.
 *
 * That argument was wrong in a way worth writing down. The console mixed two
 * different kinds of thing. Some were decisions a person makes about their own
 * project, and those belong on the surface they already use: connecting a site
 * and its credential are in Connected sites, what Russell may spend and
 * whether to approve a plan are in Needs You, identities and capacity are in
 * Who. The rest was internal machinery, and a browser page for the inside of
 * the Brain is a standing invitation to operate it by hand — which is exactly
 * how the first mis-set dropdown granted a test worker the project holding
 * real research.
 *
 * So the machinery is `npm run admin`, where reaching the shell is the
 * authentication, and the page is gone. What is left here is the assertion
 * that it is gone *for everybody*: a console that answered an administrator
 * and nobody else would be the same page with an extra step.
 */
describe('the operator console is gone', () => {
  const ROUTES = ['/operator', '/operator/', '/operator/workers', '/operator/credentials'];

  it('is not there for anybody who is not signed in', async () => {
    for (const route of ROUTES) {
      const response = await fetch(`${BASE}${route}`);
      expect([401, 404]).toContain(response.status);
      const body = await response.text();
      expect(body).not.toMatch(/<form/i);
      expect(body).not.toMatch(/Issue a credential|Create a worker/i);
    }
  });

  it('is not there for a Brain administrator either — it is not break-glass', async () => {
    for (const route of ROUTES) {
      const response = await fetch(`${BASE}${route}`, { headers: { cookie: adminCookie } });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(/<form/i);
    }
  });

  it('is not there for a worker holding a perfectly good token', async () => {
    const access = await connectedToken();
    const response = await fetch(`${BASE}/operator`, {
      headers: { authorization: `Bearer ${access}` },
    });
    expect(response.status).toBe(404);
  });

  it('does not redirect somewhere that answers as a console instead', async () => {
    const response = await fetch(`${BASE}/operator`, {
      headers: { cookie: adminCookie },
      redirect: 'manual',
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('accepts no form post at any of its old addresses', async () => {
    for (const route of ['/operator/workers', '/operator/memberships', '/operator/credentials', '/operator/projects']) {
      const response = await fetch(`${BASE}${route}`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=should-not-exist&displayName=Nope',
      });
      expect(response.status).toBe(404);
    }
    // And nothing was made by asking.
    const workers = await fetch(`${BASE}/api/admin/workers`, { headers: { cookie: adminCookie } });
    expect(await workers.text()).not.toContain('should-not-exist');
  });
});
