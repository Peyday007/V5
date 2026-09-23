/**
 * The learning door, over a real socket.
 *
 * Reading what Brain learned is any member's; withdrawing a lesson and deciding
 * a capability are ADMIN; a worker is refused by type whatever its scopes; and
 * absent and forbidden are one body. Every one of these is invisible to a
 * service test, because the service never sees who is asking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(8000, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';
const OUTSIDER_PASSWORD = 'outsider-password-00001';

let adminCookie = '';
let memberCookie = '';
let outsiderCookie = '';
let workerBearer = '';
let project = '';

interface Result<T = unknown> {
  status: number;
  body: T;
  text: string;
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
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
  return { status: response.status, body: body as T, text };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in for ${email} failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function makePerson(email: string, password: string): Promise<string> {
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName: email, password: 'temporary-password-01' },
  });
  const first = await signIn(email, 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: password },
  });
  return created.body.user.id;
}

async function startServer(): Promise<void> {
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
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        BRAIN_PROVIDER: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${serverLog}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const LEARNING = (): string => `/api/projects/${project}/learning`;
beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-learning-'));
  await startServer();

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  project = seeded.body.projects[0]!.id;

  const memberId = await makePerson('member@example.invalid', MEMBER_PASSWORD);
  memberCookie = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: memberId, principalType: 'HUMAN', role: 'MEMBER' },
  });

  await makePerson('outsider@example.invalid', OUTSIDER_PASSWORD);
  outsiderCookie = await signIn('outsider@example.invalid', OUTSIDER_PASSWORD);

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'a-learning-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      // Generously scoped on purpose: the refusal must not depend on the worker
      // being under-configured.
      scopes: ['project:read', 'work:claim', 'work:complete', 'research:propose', 'external:sync'],
    },
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerBearer = issued.body.secret;
}, 120_000);

afterAll(async () => {
  if (server) {
    const dying = server;
    server = null;
    dying.kill('SIGTERM');
    await new Promise((resolve) => {
      dying.on('exit', resolve);
      setTimeout(resolve, 5_000);
    });
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('the learning door', () => {
  it('serves a project member the reading, with no lesson invented on an empty Brain', async () => {
    const answer = await call<{ projectId: string; lessons: unknown[]; summary: { learned: string | null } }>(
      'GET',
      LEARNING(),
      { cookie: memberCookie },
    );
    expect(answer.status).toBe(200);
    expect(answer.body.projectId).toBe(project);
    expect(answer.body.lessons).toEqual([]);
    expect(answer.body.summary.learned).toBeNull();
  });

  it('refuses a member a correction, because withdrawing a lesson is ADMIN', async () => {
    const answer = await call('POST', `${LEARNING()}/corrections`, {
      cookie: memberCookie,
      body: { targetKind: 'LESSON', targetKey: 'CASH_DEEP_DIVE:NO_WORK_STREAK', action: 'WITHDRAW', reason: 'no' },
    });
    expect(answer.status).toBe(404);
  });

  it('answers an administrator correcting a lesson that does not exist with a 404, not a row', async () => {
    const answer = await call('POST', `${LEARNING()}/corrections`, {
      cookie: adminCookie,
      body: { targetKind: 'LESSON', targetKey: 'NOT:A:LESSON', action: 'WITHDRAW', reason: 'no' },
    });
    expect(answer.status).toBe(404);
  });

  it('refuses a worker by type on the read and on every write', async () => {
    for (const [method, route, body] of [
      ['GET', LEARNING(), undefined],
      ['POST', `${LEARNING()}/corrections`, { targetKind: 'LESSON', targetKey: 'x', action: 'WITHDRAW', reason: 'x' }],
      ['POST', `${LEARNING()}/capabilities/decide`, { blockerKey: 'x', route: 'PERSON', reason: 'x' }],
      ['POST', `${LEARNING()}/capabilities/landed`, { blockerKey: 'x', reason: 'x' }],
    ] as const) {
      const answer = await call(method, route, { bearer: workerBearer, body });
      expect(answer.status, `${method} ${route}`).toBeGreaterThanOrEqual(400);
      expect(answer.status).toBeLessThan(500);
    }
  });

  it('answers a project the caller may not read exactly as one that does not exist', async () => {
    const forbidden = await call('GET', LEARNING(), { cookie: outsiderCookie });
    const absent = await call('GET', '/api/projects/prj_0000000000000000000/learning', {
      cookie: outsiderCookie,
    });
    expect(forbidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(forbidden.text).toBe(absent.text);
  });
});
