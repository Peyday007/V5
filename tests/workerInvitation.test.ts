/**
 * Connecting a Claude account that is not yours, to one worker, once.
 *
 * The consent screen requires a Brain administrator. So connecting somebody
 * else's account would otherwise mean standing at their keyboard or making them
 * an administrator — and an administrator can create workers, grant any project
 * and issue credentials. The people lending an account hold no research here and
 * need no login, so the approval moves earlier instead of the machine moving.
 *
 * The factory already had this flow for a repository worker. What was missing
 * was any surface at all for a **research** worker: `createInvitation` had one
 * production caller, `services/factory/onboard.ts`, which is repository-scoped
 * and writes a routing row confining the worker to repository work. The
 * documented procedure said to "mint the invitation the same way", meaning a
 * screen on the operator console that no longer exists.
 *
 * So `POST /api/admin/workers/:workerId/invitations` reuses that security model
 * rather than restating it, and this suite is about the ways it could be weaker
 * than the thing it copied:
 *
 *   - an invitation that granted something, rather than connecting an identity
 *     whose reach was already decided;
 *   - one that could be approved for a different worker than it names;
 *   - one that outlived its use, its expiry, or its replacement;
 *   - one an ordinary member could mint;
 *   - two connectors ending up as one worker, which is what makes a routing
 *     boundary keyed on the worker separate nothing.
 *
 * It drives a real server over HTTP, because the guard, the cookie, the consent
 * screen and the redemption are four different layers and only the wire sees
 * all of them.
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

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(7100, 100);
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let log = '';
let adminCookie = '';
let memberCookie = '';
let clientId = '';
let projectOne = '';
let projectTwo = '';
let firstHandle = '';
let workerOne = '';
let workerTwo = '';

async function call<T = any>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // A browser sends this on a mutating request, and a cookie without it is a
  // CSRF surface the guard refuses before any authorization runs — so omitting
  // it here would test the wrong refusal.
  if (method !== 'GET') headers.origin = BASE;
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: response.status, body: body as T };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
}

/** Open an invitation link and return the cookie it hands the browser. */
async function openInvite(url: string): Promise<{ status: number; cookie: string; body: string }> {
  const response = await fetch(url, { redirect: 'manual' });
  const body = await response.text();
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { status: response.status, cookie, body };
}

/** Approve, carrying whatever cookie the caller has — an invite or a session. */
async function approve(
  challenge: string,
  options: { cookie: string; worker: string },
): Promise<{ status: number; code: string | null; body: string }> {
  const response = await fetch(`${BASE}/oauth/authorize/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      cookie: options.cookie,
    },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: '',
      worker_id: options.worker,
    }).toString(),
    redirect: 'manual',
  });
  const body = await response.text();
  const location = response.headers.get('location');
  let code: string | null = null;
  if (location) {
    try {
      code = new URL(location).searchParams.get('code');
    } catch {
      code = null;
    }
  }
  return { status: response.status, code, body };
}

async function exchange(body: Record<string, string>): Promise<Record<string, any>> {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { raw: text };
  }
}

/** Who a bearer actually is, asked of the Brain rather than assumed. */
async function whoami(bearer: string): Promise<Record<string, any>> {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'brain_whoami',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      origin: BASE,
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
          'io.modelcontextprotocol/clientInfo': { name: 'invite-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const parsed = (await response.json()) as any;
  return parsed?.result?.structuredContent ?? {};
}

async function invite(
  workerId: string,
  projectId: string,
  cookie = adminCookie,
): Promise<{ status: number; body: any }> {
  return await call('POST', `/api/admin/workers/${workerId}/invitations`, {
    cookie,
    body: { projectId },
  });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-invite-'));
  server = spawn(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(REPO_ROOT, 'server', 'index.ts'),
    ],
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
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        BRAIN_PROVIDER: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const first = await signIn(ADMIN_EMAIL, BOOTSTRAP);
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  // An ordinary person, who administers nothing.
  const member = await call('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: {
      email: 'member@example.invalid',
      displayName: 'An ordinary member',
      password: MEMBER_PASSWORD,
    },
  });
  expect(member.status).toBe(200);
  /*
   * And they finish becoming an ordinary member.
   *
   * An administrator-set password arrives with `mustChangePassword`, and the
   * guard refuses everything else until it is changed — so a member left in
   * that state would prove the password rule rather than the admin rule, which
   * is the refusal this suite is actually about.
   */
  const firstMember = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: firstMember,
    body: { currentPassword: MEMBER_PASSWORD, newPassword: 'member-password-000002' },
  });
  memberCookie = await signIn('member@example.invalid', 'member-password-000002');

  const projects = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  projectOne = projects.body.projects[0]!.id;

  const second = spawnAdmin(['projects', 'create', 'Second operation', '--admin', ADMIN_EMAIL]);
  projectTwo = second.trim().split(/\s+/)[0] ?? '';
  expect(projectTwo).toMatch(/^prj_/);

  for (const [name, target] of [
    ['research-worker-one', projectOne],
    ['research-worker-two', projectTwo],
  ] as const) {
    const created = await call('POST', '/api/admin/workers', {
      cookie: adminCookie,
      body: { name, displayName: name },
    });
    expect(created.status).toBe(200);
    const id = created.body.worker.id as string;
    if (name.endsWith('one')) workerOne = id;
    else workerTwo = id;
    const granted = await call('POST', `/api/admin/projects/${target}/members`, {
      cookie: adminCookie,
      body: { principalType: 'WORKER', principalId: id, scopes: ['project:read', 'queue:read'] },
    });
    expect(granted.status).toBe(200);
  }

  // A public client, registered the way the connector registers itself.
  const registered = await call('POST', '/oauth/register', {
    body: {
      client_name: 'Claude',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(registered.status).toBe(201);
  clientId = registered.body.client_id;
}, 180_000);

function spawnAdmin(args: string[]): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('npx', ['tsx', path.join(REPO_ROOT, 'scripts', 'admin.ts'), ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_DB_PATH: undefined },
    encoding: 'utf8',
  });
}

afterAll(async () => {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!server.killed) server.kill('SIGKILL');
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('who may mint one', () => {
  it('refuses an ordinary member the way it refuses everyone who is not an administrator', async () => {
    const refused = await invite(workerOne, projectOne, memberCookie);
    // `requireBrainAdmin` throws "No such route": a surface that announces
    // itself to whoever guesses the path is a map of what to attack.
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain(workerOne);
  });

  it('refuses an unauthenticated caller', async () => {
    const refused = await call('POST', `/api/admin/workers/${workerOne}/invitations`, {
      body: { projectId: projectOne },
    });
    expect(refused.status).toBe(401);
  });

  it('refuses a worker this Brain does not have', async () => {
    const refused = await invite('wkr_not_a_real_worker', projectOne);
    expect(refused.status).toBe(404);
  });
});

describe('what it is bound to', () => {
  it('refuses a project the worker holds no membership on', async () => {
    // The invitation connects an identity rather than granting one, so a
    // worker that cannot reach the project would connect to nothing.
    const refused = await invite(workerOne, projectTwo);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('holds no active membership');
  });

  it('issues one for the project the worker actually holds, and shows the link once', async () => {
    const issued = await invite(workerOne, projectOne);
    expect(issued.status).toBe(200);
    expect(issued.body.invitationUrl).toContain('/oauth/invite/');
    expect(issued.body.invitation.workerId).toBe(workerOne);
    expect(issued.body.invitation.projectId).toBe(projectOne);

    // Nothing anywhere returns the token again: only a prefix and a digest are
    // stored, so this is the one time it exists.
    const events = await call('GET', '/api/admin/identity-events', { cookie: adminCookie });
    const token = (issued.body.invitationUrl as string).split('/oauth/invite/')[1]!;
    expect(JSON.stringify(events.body)).not.toContain(token);
  });

  it('grants nothing: the worker reaches exactly what it did before', async () => {
    const before = await call('GET', `/api/admin/projects/${projectTwo}/members`, {
      cookie: adminCookie,
    });
    await invite(workerOne, projectOne);
    const after = await call('GET', `/api/admin/projects/${projectTwo}/members`, {
      cookie: adminCookie,
    });
    // Still not on the other project, and still not an administrator.
    expect(JSON.stringify(after.body)).toEqual(JSON.stringify(before.body));
    expect(JSON.stringify(after.body)).not.toContain(workerOne);
  });

  it('refuses one that has expired, without saying that is what happened', async () => {
    const issued = await invite(workerOne, projectOne);
    expect(issued.status).toBe(200);

    /*
     * Aged in the database rather than waited out.
     *
     * The TTL is a week, so the only honest alternative to reaching into the
     * row is exposing a lifetime knob on the route — a control nobody issuing
     * an invitation needs, added solely to make a test convenient.
     */
    // Through `process.getBuiltinModule` rather than `import`, for the reason
    // `server/db/driver.ts` gives: `node:sqlite` is not in every bundler's
    // builtin list, so a specifier either form of import can see is one Vite
    // tries to resolve at transform time and cannot.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'brain.db'));
    try {
      db.prepare('UPDATE worker_invitations SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 60_000).toISOString(),
        issued.body.invitation.id as string,
      );
    } finally {
      db.close();
    }

    const dead = await openInvite(issued.body.invitationUrl);
    expect(dead.body).toContain('cannot be used');

    /*
     * And it is the *same* answer an invented token gets.
     *
     * Unknown, revoked, redeemed and expired are one message — which one it
     * was is information about somebody else's invitation — so the property
     * worth asserting is that the bodies match, not that some word is absent.
     * The page names every possibility precisely so that it discloses none.
     */
    const invented = await openInvite(`${BASE}/oauth/invite/wki_0000000000000000.notarealsecret`);
    expect(dead.body).toBe(invented.body);
  });

  it('keeps at most one live invitation, so a mislaid link stops working', async () => {
    const first = await invite(workerOne, projectOne);
    const second = await invite(workerOne, projectOne);
    expect(second.body.revokedInvitations).toBeGreaterThanOrEqual(1);

    const dead = await openInvite(first.body.invitationUrl);
    const alive = await openInvite(second.body.invitationUrl);
    expect(dead.body).toContain('cannot be used');
    expect(alive.status).toBe(200);
  });
});

describe('the journey it exists for', () => {
  it('connects one named worker, once, and the token is that worker', async () => {
    const issued = await invite(workerOne, projectOne);
    const opened = await openInvite(issued.body.invitationUrl);
    expect(opened.status).toBe(200);
    // It connects nothing by itself — it tells the browser which worker it may
    // connect.
    expect(opened.cookie).toBeTruthy();

    const { verifier, challenge } = pkce();
    const approved = await approve(challenge, { cookie: opened.cookie, worker: workerOne });
    expect(approved.code).toBeTruthy();

    const token = await exchange({
      grant_type: 'authorization_code',
      code: approved.code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(token['access_token']).toBeTruthy();

    // The principal is the worker, never the administrator who authorized it.
    /*
     * The principal is the worker, never the administrator who authorized it.
     *
     * Asserted on the handle because `brain_whoami` deliberately does not
     * return an id — it says what the credential is and what it reaches, and
     * nothing about anything it does not already have.
     */
    const who = await whoami(token['access_token']);
    expect(who['principalType']).toBe('WORKER');
    // The neutral label, not the handle whoever issued the invitation typed.
    // What matters here is that it is *this* worker's identity and reaches
    // this worker's project — see the second connector below, which must get a
    // different one.
    expect(who['handle']).toMatch(/^worker-\d\d$/);
    expect(who['handle']).not.toBe('research-worker-one');
    expect((who['memberships'] as any[]).map((one) => one.projectId)).toEqual([projectOne]);
    firstHandle = who['handle'] as string;

    // And the link is spent.
    const reused = await openInvite(issued.body.invitationUrl);
    expect(reused.body).toContain('cannot be used');
  });

  it('refuses an approval for a worker the invitation does not name', async () => {
    const issued = await invite(workerOne, projectOne);
    const opened = await openInvite(issued.body.invitationUrl);
    const { challenge } = pkce();

    // The invitation names the worker. The form is a form, and a form can be
    // edited — so the worker is taken from the invitation and a mismatch is
    // refused outright rather than quietly corrected.
    const refused = await approve(challenge, { cookie: opened.cookie, worker: workerTwo });
    expect(refused.code).toBeNull();
    expect(refused.status).toBe(403);
  });

  it('gives each accepted connector its own worker identity', async () => {
    // Two invitations, two workers, two clients — which is what keeps a
    // boundary keyed on the authenticated worker able to separate anything.
    const second = await call('POST', '/oauth/register', {
      body: {
        client_name: 'Claude, second connector',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(second.status).toBe(201);
    const otherClient = second.body.client_id as string;
    expect(otherClient).not.toBe(clientId);

    const issuedTwo = await invite(workerTwo, projectTwo);
    const opened = await openInvite(issuedTwo.body.invitationUrl);
    const { verifier, challenge } = pkce();

    const response = await fetch(`${BASE}/oauth/authorize/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: BASE,
        cookie: opened.cookie,
      },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: otherClient,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: '',
        worker_id: workerTwo,
      }).toString(),
      redirect: 'manual',
    });
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    const token = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: otherClient,
      code_verifier: verifier,
    });

    const who = await whoami(token['access_token']);
    expect(who['principalType']).toBe('WORKER');
    // Two connectors, two identities — not one worker wearing two labels,
    // which is what keeps a boundary keyed on the worker able to separate
    // anything. And it reaches its own project and only its own.
    expect(who['handle']).toMatch(/^worker-\d\d$/);
    expect(who['handle']).not.toBe(firstHandle);
    expect(who['handle']).not.toBe('research-worker-two');
    expect((who['memberships'] as any[]).map((one) => one.projectId)).toEqual([projectTwo]);
  });
});
