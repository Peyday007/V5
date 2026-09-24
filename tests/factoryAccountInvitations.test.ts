/**
 * Several Claude accounts for one factory worker, each invited on its own link.
 *
 * Commissioning a Factory pool means one link per account, sent to several
 * people at once, while the repository is already READY. Two defects stood in
 * the way and both are pinned here, over the wire, because the guard, the
 * invitation cookie, the Brain session and the consent screen are four layers
 * and only a real server sees all of them:
 *
 *   - the only control that issued a link lived in the not-ready branch of the
 *     Build card (pinned in `buildRepositories.test.tsx`), and the only server
 *     path that issued one — onboarding — withdrew every other unused link for
 *     the worker, so link B killed link A before its recipient opened it;
 *   - nothing tied a link to the person it was sent to.
 *
 * What it holds to: several links outstanding at once; each redeemable
 * independently and in parallel; single use; expiry and withdrawal; a bound
 * link refused for a browser signed in as somebody else, and for one signed in
 * as nobody, without being spent; re-onboarding leaves member links alone; an
 * already-connected research account and an already-connected factory account
 * keep working throughout; and no token reaches the audit or the server log.
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
const PORT = pickPort(8100, 100);
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const ADMIN_EMAIL = 'owner@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let log = '';
let adminCookie = '';
let clientId = '';
let projectId = '';
let grantId = '';
let factoryWorkerId = '';
const friends: Record<'A' | 'B' | 'C', { id: string; cookie: string }> = {
  A: { id: '', cookie: '' },
  B: { id: '', cookie: '' },
  C: { id: '', cookie: '' },
};
/** Bearers minted before any member link existed; they must keep working. */
let researchBearer = '';
let factoryBearer = '';
let researchWorkerId = '';
/** What `brain_whoami` calls each worker; it answers with a handle, not an id. */
let researchHandle = '';
let factoryHandle = '';
const issuedTokens: string[] = [];

async function call<T = any>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
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
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function openInvite(url: string, cookie = ''): Promise<{ status: number; cookie: string; body: string }> {
  const response = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const body = await response.text();
  return { status: response.status, cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '', body };
}

async function approve(
  challenge: string,
  cookie: string,
  worker: string,
): Promise<{ status: number; code: string | null; body: string }> {
  const response = await fetch(`${BASE}/oauth/authorize/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, cookie },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: '',
      worker_id: worker,
    }).toString(),
    redirect: 'manual',
  });
  const body = await response.text();
  const location = response.headers.get('location');
  return { status: response.status, code: location ? new URL(location).searchParams.get('code') : null, body };
}

async function exchange(code: string, verifier: string): Promise<string> {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }).toString(),
  });
  const parsed = (await response.json()) as Record<string, string>;
  if (!parsed['access_token']) throw new Error(`no token: ${JSON.stringify(parsed)}`);
  return parsed['access_token'];
}

/** Connect through an invitation, from a browser holding `session` (or none). */
async function connect(url: string, session: string, worker: string): Promise<{ status: number; body: string; bearer: string | null }> {
  const opened = await openInvite(url, session);
  if (opened.status !== 200) return { status: opened.status, body: opened.body, bearer: null };
  const cookie = [opened.cookie, session].filter(Boolean).join('; ');
  const { verifier, challenge } = pkce();
  const approved = await approve(challenge, cookie, worker);
  if (!approved.code) return { status: approved.status, body: approved.body, bearer: null };
  return { status: approved.status, body: approved.body, bearer: await exchange(approved.code, verifier) };
}

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
          'io.modelcontextprotocol/clientInfo': { name: 'factory-invite-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const parsed = (await response.json()) as any;
  return parsed?.result?.structuredContent ?? {};
}

const invitationsRoute = (): string =>
  `/api/projects/${projectId}/factory/repositories/${grantId}/invitations`;

async function issue(member: 'A' | 'B' | 'C'): Promise<{ id: string; url: string }> {
  const issued = await call('POST', invitationsRoute(), {
    cookie: adminCookie,
    body: { intendedUserId: friends[member].id },
  });
  expect(issued.status).toBe(200);
  const url = issued.body.invitationUrl as string;
  issuedTokens.push(url.split('/oauth/invite/')[1]!);
  return { id: issued.body.invitation.id as string, url };
}

async function statusOf(id: string): Promise<string> {
  const listed = await call('GET', invitationsRoute(), { cookie: adminCookie });
  expect(listed.status).toBe(200);
  const found = (listed.body.invitations as { id: string; status: string }[]).find((one) => one.id === id);
  return found?.status ?? 'MISSING';
}

function withDb<T>(fn: (db: any) => T): T {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'brain.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-factory-invites-'));
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

  // Three friends who already have Brain accounts. None is an administrator.
  for (const key of ['A', 'B', 'C'] as const) {
    const email = `friend-${key.toLowerCase()}@example.invalid`;
    const created = await call('POST', '/api/admin/users', {
      cookie: adminCookie,
      body: { email, displayName: `Friend ${key}`, password: `friend-${key}-password-0001` },
    });
    expect(created.status).toBe(200);
    friends[key].id = created.body.user.id as string;
    const firstSession = await signIn(email, `friend-${key}-password-0001`);
    await call('POST', '/api/auth/password', {
      cookie: firstSession,
      body: { currentPassword: `friend-${key}-password-0001`, newPassword: `friend-${key}-password-0002` },
    });
    friends[key].cookie = await signIn(email, `friend-${key}-password-0002`);
  }

  const projects = await call<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
  projectId = projects.body.projects[0]!.id;

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

  // An existing research connection, made through the research invitation path.
  const research = await call('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'research-friend-a', displayName: 'research-friend-a' },
  });
  researchWorkerId = research.body.worker.id as string;
  await call('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalType: 'WORKER', principalId: researchWorkerId, scopes: ['project:read', 'queue:read'] },
  });
  const researchInvite = await call('POST', `/api/admin/workers/${researchWorkerId}/invitations`, {
    cookie: adminCookie,
    body: { projectId },
  });
  expect(researchInvite.status).toBe(200);
  const researchConnected = await connect(researchInvite.body.invitationUrl as string, '', researchWorkerId);
  researchBearer = researchConnected.bearer ?? '';
  expect(researchBearer).not.toBe('');

  // Onboard the repository, and connect the first factory account on its link.
  const repositories = await call('GET', `/api/projects/${projectId}/factory/repositories`, { cookie: adminCookie });
  grantId = repositories.body.repositories[0].grantId as string;
  const onboarded = await call('POST', `/api/projects/${projectId}/factory/repositories/${grantId}/onboard`, {
    cookie: adminCookie,
    body: { scopeKind: 'WHOLE_REPOSITORY' },
  });
  expect(onboarded.status).toBe(200);
  factoryWorkerId = onboarded.body.onboarding.workerId as string;
  const factoryConnected = await connect(onboarded.body.invitationUrl as string, '', factoryWorkerId);
  factoryBearer = factoryConnected.bearer ?? '';
  expect(factoryBearer).not.toBe('');

  researchHandle = (await whoami(researchBearer))['handle'] as string;
  factoryHandle = (await whoami(factoryBearer))['handle'] as string;
  expect(researchHandle).toMatch(/^worker-/);
  expect(factoryHandle).toMatch(/^worker-/);
  expect(factoryHandle).not.toBe(researchHandle);
}, 180_000);

afterAll(async () => {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!server.killed) server.kill('SIGKILL');
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('several links for one worker, outstanding at once', () => {
  it('issuing link B leaves link A live, and re-onboarding leaves both live', async () => {
    const a = await issue('A');
    const b = await issue('B');
    expect(a.url).not.toBe(b.url);
    expect(await statusOf(a.id)).toBe('WAITING');
    expect(await statusOf(b.id)).toBe('WAITING');

    // Re-onboarding is a repair of the worker; it must not withdraw a friend's link.
    const again = await call('POST', `/api/projects/${projectId}/factory/repositories/${grantId}/onboard`, {
      cookie: adminCookie,
      body: { scopeKind: 'WHOLE_REPOSITORY' },
    });
    expect(again.status).toBe(200);
    expect(again.body.onboarding.workerId).toBe(factoryWorkerId);
    expect(await statusOf(a.id)).toBe('WAITING');
    expect(await statusOf(b.id)).toBe('WAITING');

    // And each friend connects, in parallel, only as the factory worker.
    const [connectedA, connectedB] = await Promise.all([
      connect(a.url, friends.A.cookie, factoryWorkerId),
      connect(b.url, friends.B.cookie, factoryWorkerId),
    ]);
    expect(connectedA.bearer).not.toBeNull();
    expect(connectedB.bearer).not.toBeNull();
    expect(connectedA.bearer).not.toBe(connectedB.bearer);
    // Both are the one factory worker the repository already had — not a new
    // identity, and not the research one.
    expect((await whoami(connectedA.bearer!))['handle']).toBe(factoryHandle);
    expect((await whoami(connectedB.bearer!))['handle']).toBe(factoryHandle);
    expect(await statusOf(a.id)).toBe('CONNECTED');
    expect(await statusOf(b.id)).toBe('CONNECTED');

    // Single use: the same link, the same member, a second time, is refused.
    const replay = await connect(a.url, friends.A.cookie, factoryWorkerId);
    expect(replay.bearer).toBeNull();
    expect(replay.status).toBe(400);
  });

  it('writes nothing about the worker when issuing, and records who each link was for', async () => {
    const before = withDb((db) => ({
      routing: JSON.stringify(db.prepare('SELECT * FROM worker_routing WHERE worker_id = ?').all(factoryWorkerId)),
      members: JSON.stringify(
        db.prepare('SELECT * FROM project_memberships WHERE principal_id = ?').all(factoryWorkerId),
      ),
    }));
    const c = await issue('C');
    const after = withDb((db) => ({
      routing: JSON.stringify(db.prepare('SELECT * FROM worker_routing WHERE worker_id = ?').all(factoryWorkerId)),
      members: JSON.stringify(
        db.prepare('SELECT * FROM project_memberships WHERE principal_id = ?').all(factoryWorkerId),
      ),
      row: db.prepare('SELECT kind, intended_user_id, worker_id FROM worker_invitations WHERE id = ?').get(c.id),
    }));
    expect(after.routing).toBe(before.routing);
    expect(after.members).toBe(before.members);
    expect(after.row).toEqual({ kind: 'ADDITIONAL', intended_user_id: friends.C.id, worker_id: factoryWorkerId });
  });
});

describe('a link bound to a member', () => {
  it('is refused for a browser signed in as a different member, and is not spent', async () => {
    const link = await issue('C');
    const wrong = await connect(link.url, friends.B.cookie, factoryWorkerId);
    expect(wrong.bearer).toBeNull();
    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain('different Brain member');
    expect(await statusOf(link.id)).toBe('WAITING');

    // Nor for a browser signed in as nobody.
    const anonymous = await connect(link.url, '', factoryWorkerId);
    expect(anonymous.bearer).toBeNull();
    expect(anonymous.status).toBe(403);
    expect(await statusOf(link.id)).toBe('WAITING');

    // The right member, in the same situation, connects.
    const right = await connect(link.url, friends.C.cookie, factoryWorkerId);
    expect(right.bearer).not.toBeNull();
    expect(await statusOf(link.id)).toBe('CONNECTED');
  });

  it('says on the link page what to do before connecting, without naming anybody', async () => {
    const link = await issue('A');
    const opened = await openInvite(link.url);
    expect(opened.status).toBe(200);
    expect(opened.body).toContain('One step before you connect');
    expect(opened.body).not.toContain('Friend A');
    const signedIn = await openInvite(link.url, friends.A.cookie);
    expect(signedIn.body).toContain('You are ready to connect');
  });

  it('cannot approve a different worker than it names', async () => {
    const link = await issue('A');
    const opened = await openInvite(link.url, friends.A.cookie);
    const { challenge } = pkce();
    const refused = await approve(challenge, `${opened.cookie}; ${friends.A.cookie}`, researchWorkerId);
    expect(refused.status).toBe(403);
    expect(refused.code).toBeNull();
    expect(await statusOf(link.id)).toBe('WAITING');
  });
});

describe('expiry and withdrawal', () => {
  it('a withdrawn link connects nothing, and withdrawing it touches no other link', async () => {
    const keep = await issue('A');
    const drop = await issue('B');
    const withdrawn = await call('POST', `${invitationsRoute()}/${drop.id}/withdraw`, {
      cookie: adminCookie,
    });
    expect(withdrawn.body).toEqual({ withdrawn: true });
    expect(await statusOf(drop.id)).toBe('WITHDRAWN');
    expect(await statusOf(keep.id)).toBe('WAITING');
    const tried = await connect(drop.url, friends.B.cookie, factoryWorkerId);
    expect(tried.bearer).toBeNull();
    expect(tried.status).toBe(400);
  });

  it('an expired link connects nothing, and says so as a dead link', async () => {
    const link = await issue('A');
    withDb((db) =>
      db.prepare('UPDATE worker_invitations SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 60_000).toISOString(),
        link.id,
      ),
    );
    expect(await statusOf(link.id)).toBe('EXPIRED');
    const tried = await connect(link.url, friends.A.cookie, factoryWorkerId);
    expect(tried.bearer).toBeNull();
    expect(tried.status).toBe(400);
  });
});

describe('who may issue one', () => {
  it('refuses an ordinary member exactly as a missing route', async () => {
    const refused = await call('POST', invitationsRoute(), {
      cookie: friends.A.cookie,
      body: { intendedUserId: friends.A.id },
    });
    expect(refused.status).toBe(404);
    const reading = await call('GET', invitationsRoute(), { cookie: friends.A.cookie });
    expect(reading.status).toBe(404);
  });

  it('refuses a link for somebody who is not a member of this Brain', async () => {
    const refused = await call('POST', invitationsRoute(), {
      cookie: adminCookie,
      body: { intendedUserId: 'usr_not_a_real_person' },
    });
    expect(refused.status).toBe(422);
  });
});

describe('what is preserved', () => {
  it('the research and factory accounts connected before any of this still work', async () => {
    expect((await whoami(researchBearer))['handle']).toBe(researchHandle);
    expect((await whoami(factoryBearer))['handle']).toBe(factoryHandle);
  });

  it('no invitation token reaches the audit, the list or the server log', async () => {
    expect(issuedTokens.length).toBeGreaterThan(3);
    const events = JSON.stringify((await call('GET', '/api/admin/identity-events', { cookie: adminCookie })).body);
    const listed = JSON.stringify((await call('GET', invitationsRoute(), { cookie: adminCookie })).body);
    for (const token of issuedTokens) {
      expect(events).not.toContain(token);
      expect(listed).not.toContain(token);
      expect(log).not.toContain(token);
    }
    expect(events).toContain('ISSUE_FACTORY_INVITATION');
  });
});
