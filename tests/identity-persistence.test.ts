/**
 * Identity outlives the process that created it.
 *
 * The whole point of Step 3 was that the Brain's state stopped living on one
 * computer. Identity is state, so the same has to be true of it — and the way
 * to find out is not to reason about where the rows are, but to kill the server
 * and ask a different one.
 *
 * So this file starts a server, creates people, workers, credentials and
 * memberships through the real API, kills it, starts a **second** server
 * against the same storage, and checks that every one of those decisions still
 * holds. A revoked credential that came back to life across a redeploy would be
 * the worst possible failure of this step, and it is the one thing a
 * single-process test cannot rule out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { requestContext, requireAuthentication } from '../server/routes/guard.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN_EMAIL = 'keeper@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-02';
const ADMIN_PASSWORD = 'keeper-password-000002';
const ALICE_PASSWORD = 'alice-across-restarts';

let dataDir: string;
let current: ChildProcessByStdio<null, Readable, Readable> | null = null;
let log = '';

/** What the first server created, checked against the second. */
let projectId = '';
let aliceId = '';
let workerId = '';
let liveCredential = '';
let revokedCredential = '';

function startServer(): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(
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
        // Set for both boots on purpose: the second one must ignore them,
        // because a Brain that already has accounts is not an empty one.
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
  return child;
}

async function waitForHealthy(): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function stopServer(): Promise<void> {
  if (!current) return;
  const child = current;
  current = null;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8_000);
  });
  // And wait for the port to actually be free.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`${BASE}/healthz`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      return;
    }
  }
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
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
    /* keep it */
  }
  return { status: response.status, body: body as T };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed for ${email}: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-persist-'));
  current = startServer();
  await waitForHealthy();

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const projects = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  projectId = projects.body.projects[0]!.id;

  const alice = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email: 'alice2@example.invalid', displayName: 'Alice', password: 'temporary-pass-0001' },
  });
  aliceId = alice.body.user.id;
  const aliceFirst = await signIn('alice2@example.invalid', 'temporary-pass-0001');
  await call('POST', '/api/auth/password', {
    cookie: aliceFirst,
    body: { currentPassword: 'temporary-pass-0001', newPassword: ALICE_PASSWORD },
  });
  await call('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalType: 'HUMAN', principalId: aliceId, role: 'MEMBER' },
  });

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'persistent-worker' },
  });
  workerId = worker.body.worker.id;
  await call('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalType: 'WORKER', principalId: workerId, scopes: ['project:read'] },
  });

  const live = await call<{ secret: string }>('POST', `/api/admin/workers/${workerId}/credentials`, {
    cookie: adminCookie,
    body: {},
  });
  liveCredential = live.body.secret;

  const doomed = await call<{ secret: string; credential: { id: string } }>(
    'POST',
    `/api/admin/workers/${workerId}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  revokedCredential = doomed.body.secret;
  await call('POST', `/api/admin/workers/${workerId}/credentials/${doomed.body.credential.id}/revoke`, {
    cookie: adminCookie,
  });

  // Everything above was decided by a process that is about to stop existing.
  await stopServer();
  current = startServer();
  await waitForHealthy();
}, 150_000);

afterAll(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('a second instance, on the same storage', () => {
  it('knows the people the first one created', async () => {
    const cookie = await signIn('alice2@example.invalid', ALICE_PASSWORD);
    const me = await call<{ principal: { id: string; memberships: unknown[] } }>(
      'GET',
      '/api/auth/me',
      { cookie },
    );
    expect(me.status).toBe(200);
    expect(me.body.principal.id).toBe(aliceId);
    // Including what they may reach: the membership is state, not a session fact.
    expect(me.body.principal.memberships).toHaveLength(1);
    expect((await call('GET', `/api/projects/${projectId}`, { cookie })).status).toBe(200);
  });

  it('still refuses the password the first one replaced', async () => {
    const stale = await call('POST', '/api/auth/login', {
      body: { email: 'alice2@example.invalid', password: 'temporary-pass-0001' },
    });
    expect(stale.status).toBe(401);
  });

  it('honours a credential issued before the restart', async () => {
    const me = await call<{ principal: { type: string; handle: string } }>('GET', '/api/auth/me', {
      bearer: liveCredential,
    });
    expect(me.status).toBe(200);
    expect(me.body.principal.type).toBe('WORKER');
    expect(me.body.principal.handle).toBe('persistent-worker');
  });

  it('still refuses one that was revoked before the restart', async () => {
    // The failure this test exists for: revocation kept in memory would come
    // back as permission the moment the process restarted, and a redeploy is
    // the most ordinary thing that happens to a deployed Brain.
    const me = await call('GET', '/api/auth/me', { bearer: revokedCredential });
    expect(me.status).toBe(401);
  });

  it('does not bootstrap a second administrator over the top of the first', async () => {
    // The bootstrap variables were still set for this boot. A Brain with
    // accounts is not an empty one, so they must have done nothing — and the
    // administrator's password must still be the one they chose, not the one in
    // the deployment secret.
    const withBootstrapPassword = await call('POST', '/api/auth/login', {
      body: { email: ADMIN_EMAIL, password: BOOTSTRAP_PASSWORD },
    });
    expect(withBootstrapPassword.status).toBe(401);

    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const users = await call<{ users: unknown[] }>('GET', '/api/admin/users', { cookie });
    expect(users.status).toBe(200);
    // The administrator, Alice, and nobody the second boot invented.
    expect(users.body.users).toHaveLength(2);
  });

  it('never printed a credential while doing any of it', () => {
    expect(log).not.toContain(liveCredential);
    expect(log).not.toContain(revokedCredential);
    expect(log).not.toContain(ADMIN_PASSWORD);
    expect(log).not.toContain(ALICE_PASSWORD);
    expect(log).not.toContain(BOOTSTRAP_PASSWORD);
  });
});

describe('when the database cannot answer', () => {
  it('refuses rather than letting the request through', async () => {
    // Real, not mocked: the database is genuinely closed underneath a real
    // guard, and the question is what the guard does when it cannot find out
    // who is asking. The only safe answer is "no".
    const dbPath = path.join(dataDir, 'failclosed.db');
    await initDatabase({ dbPath });
    const app = express();
    app.use(requestContext());
    app.use('/api', requireAuthentication());
    app.get('/api/secret', (_req, res) => res.json({ leaked: true }));

    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    try {
      // A syntactically valid credential, so the guard gets as far as asking the
      // database about it.
      const okay = await fetch(`http://127.0.0.1:${port}/api/secret`, {
        headers: { authorization: 'Bearer brnw_0011223344556677.aaaaaaaaaaaaaaaaaaaa' },
      });
      expect(okay.status).toBe(401);

      await closeDatabase();

      const afterClose = await fetch(`http://127.0.0.1:${port}/api/secret`, {
        headers: { authorization: 'Bearer brnw_0011223344556677.aaaaaaaaaaaaaaaaaaaa' },
      });
      // 503, not 200. Not "assume it is fine", not "fall back to a local file".
      expect(afterClose.status).toBe(503);
      expect(await afterClose.text()).not.toContain('leaked');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
