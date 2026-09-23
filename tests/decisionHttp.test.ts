/**
 * The decision brief over HTTP, written as an attack.
 *
 * `decisionJourney.test.ts` proves the service. This proves what a person's
 * browser actually receives: that asking in a conversation answers with the
 * brief in the same request, that the thread payload carries the **live**
 * brief with its step so nothing has to be joined across screens, and that an
 * objective id reaches nobody who may not read its project — in the same body a
 * missing one gets.
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


beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-decision-'));
  await startServer();
  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
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
    body: { name: 'a-research-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: worker.body.worker.id, principalType: 'WORKER', scopes: ['project:read'] },
  });
  const issued = await call<{ secret: string }>('POST', `/api/admin/workers/${worker.body.worker.id}/credentials`, {
    cookie: adminCookie,
    body: {},
  });
  workerBearer = issued.body.secret;

  const activated = await call('POST', `/api/projects/${project}/cash/mode`, { cookie: adminCookie, body: {} });
  expect(activated.status).toBe(200);
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

interface Brief {
  objective: { id: string; statement: string; sourceKind: string; conversationId: string | null };
  verdict: string;
  headline: string;
  reasons: string[];
  watch: { continueIf: string | null; reviseIf: string | null; stopIf: string | null };
}

let objectiveId = '';

describe('asking Russell what can be done', () => {
  it('answers in the request, and the thread carries the live brief', async () => {
    const opened = await call<{ id: string }>('POST', '/api/russell/conversations', {
      cookie: memberCookie,
      body: { projectId: project, title: 'Cash' },
    });
    expect(opened.status).toBeLessThan(300);
    const conversationId = opened.body.id;

    const said = await call<{ pending: { status: string; content: string; produced: Record<string, unknown> }; dispatched: boolean }>(
      'POST',
      `/api/russell/conversations/${conversationId}/turns`,
      { cookie: memberCookie, body: { content: 'What can we actually do?' } },
    );
    expect(said.status).toBe(202);
    expect(said.body.dispatched).toBe(false);
    expect(said.body.pending.status).toBe('COMPLETE');
    expect(said.body.pending.content).toMatch(/Cash Mode sprint/);

    const thread = await call<{ objectives: Brief[] }>('GET', `/api/russell/conversations/${conversationId}`, {
      cookie: memberCookie,
    });
    expect(thread.status).toBe(200);
    expect(thread.body.objectives).toHaveLength(1);
    const brief = thread.body.objectives[0]!;
    expect(brief.objective.sourceKind).toBe('CASH_MODE');
    expect(brief.objective.conversationId).toBe(conversationId);
    // An empty portfolio is a justified stop, never a shortlist filled with nothing.
    expect(brief.verdict).toBe('STOP');
    expect(brief.headline).toMatch(/no candidate path/i);
    objectiveId = brief.objective.id;

    const listed = await call<{ objectives: Brief[] }>('GET', `/api/russell/projects/${project}/objectives`, {
      cookie: memberCookie,
    });
    expect(listed.body.objectives.map((one) => one.objective.id)).toEqual([objectiveId]);
  });

  it('refuses an objective to an outsider in the same body a missing one gets', async () => {
    const theirs = await call('GET', `/api/russell/objectives/${objectiveId}`, { cookie: outsiderCookie });
    const missing = await call('GET', '/api/russell/objectives/obj_doesnotexist0000000', { cookie: outsiderCookie });
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(theirs.text).toBe(missing.text);
    const advance = await call('POST', `/api/russell/objectives/${objectiveId}/advance`, { cookie: outsiderCookie, body: {} });
    expect(advance.status).toBe(404);
    expect(advance.text).toBe(missing.text);
  });

  it('refuses a machine and an anonymous caller', async () => {
    const machine = await call('GET', `/api/russell/objectives/${objectiveId}`, { bearer: workerBearer });
    expect(machine.status).toBeGreaterThanOrEqual(400);
    const anonymous = await call('GET', `/api/russell/objectives/${objectiveId}`);
    expect(anonymous.status).toBe(401);
  });

  it('lets a member re-check it, and closing keeps the row', async () => {
    const again = await call<{ brief: Brief; changed: boolean }>('POST', `/api/russell/objectives/${objectiveId}/advance`, {
      cookie: memberCookie,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    const closed = await call('POST', `/api/russell/objectives/${objectiveId}/close`, {
      cookie: memberCookie,
      body: { reason: 'Finished with this for now.' },
    });
    expect(closed.status).toBe(200);
    const read = await call<{ brief: Brief }>('GET', `/api/russell/objectives/${objectiveId}`, { cookie: memberCookie });
    expect(read.status).toBe(200);
  });
});
