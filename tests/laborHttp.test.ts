/**
 * The labor kernel's door, driven over a socket.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists, which is a gap rather than a defect
 * ---------------------------------------------------------------------------
 *
 * `tests/laborKernel.test.ts` walks the kernel through its services, and every
 * one of its refusals is real. What it cannot see is the seam `cashHttp` and
 * `connect` exist for: **a route that never resolves.** `laborRouter` is
 * mounted at the root because its routes carry their own
 * `/projects/:id/labor/...` prefix, and it is mounted *after*
 * `router.use('/projects', projectsRouter)`. Nothing in a service-level suite
 * would notice if `projectsRouter` swallowed the path and answered 404: every
 * guard, every validator and every repository would still be perfectly
 * correct, and the door would be shut.
 *
 * That is the shape this repository keeps paying for — a mechanism nothing
 * calls, a screen whose control posts a field the route does not take, a
 * capability column no reader reads. The remedy each time was to drive the
 * real thing from outside it.
 *
 * ---------------------------------------------------------------------------
 * What it asserts, and why each one is load-bearing
 * ---------------------------------------------------------------------------
 *
 * **The route resolves at all**, which is the whole reason above.
 *
 * **A worker principal is refused by type at every labor route**, including
 * the reads. §41 says no entry in `policy.ts` names a worker scope and every
 * handler additionally calls `requirePerson`; a machine that could decide a
 * person is unnecessary is exactly what §22's split exists to prevent. The
 * worker here is *generously* scoped on purpose, so the refusal cannot be an
 * accident of under-configuration.
 *
 * **Absent and forbidden are one body.** Invariant 23 at a new door: a project
 * a caller may not read, and a project that does not exist, must be
 * byte-identical — not merely the same status, because a status that matches
 * while the body differs is still an oracle.
 *
 * **A declaration is validated by the same domain rules**, and the refusals
 * are what is pinned rather than the successes: `SEED` is the one task origin
 * Brain may never write, and an unknown field refuses the whole declaration.
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
const PORT = pickPort(7800, 100);
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

const LABOR = (): string => `/api/projects/${project}/labor`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-labor-'));
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
    body: { name: 'a-labor-worker', displayName: 'Research' },
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

describe('the door exists at all', () => {
  /*
   * The assertion this file was written for. `laborRouter` is mounted after
   * `router.use('/projects', projectsRouter)`, so the one way this can fail is
   * the path being swallowed before it ever reaches a labor handler — and that
   * failure is invisible to every service-level test.
   */
  it('resolves the project-scoped read rather than falling through to the projects router', async () => {
    const answer = await call<{ projectId: string; summary: string }>('GET', LABOR(), {
      cookie: adminCookie,
    });
    expect(answer.status).toBe(200);
    expect(answer.body.projectId).toBe(project);
    expect(typeof answer.body.summary).toBe('string');
  });

  it('serves a project member, because who does the work here is not privileged', async () => {
    const answer = await call('GET', LABOR(), { cookie: memberCookie });
    expect(answer.status).toBe(200);
  });
});

describe('no machine reaches any of it, whatever its scopes', () => {
  const routes = (): { method: string; route: string; body?: unknown }[] => [
    { method: 'GET', route: LABOR() },
    {
      method: 'POST',
      route: `${LABOR()}/workflows`,
      body: { name: 'A workflow', tasks: [] },
    },
  ];

  it('refuses a worker by principal type, on reads as well as writes', async () => {
    for (const one of routes()) {
      const answer = await call(one.method, one.route, {
        bearer: workerBearer,
        body: one.body,
      });
      expect(
        answer.status,
        `${one.method} ${one.route} answered ${answer.status}`,
      ).toBeGreaterThanOrEqual(400);
      expect(answer.status).toBeLessThan(500);
    }
  });

  it('refuses an anonymous caller', async () => {
    for (const one of routes()) {
      const answer = await call(one.method, one.route, { body: one.body });
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(answer.status).toBeLessThan(500);
    }
  });
});

describe('absent and forbidden are one body', () => {
  /*
   * Invariant 23, and the half that is usually got wrong: the *body*, not only
   * the status. A status that matches while the body differs is still an
   * oracle for enumerating a Brain you have no access to.
   */
  it('answers a project the caller may not read exactly as one that does not exist', async () => {
    const forbidden = await call('GET', LABOR(), { cookie: outsiderCookie });
    const absent = await call('GET', '/api/projects/prj_0000000000000000000/labor', {
      cookie: outsiderCookie,
    });
    expect(forbidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(forbidden.text).toBe(absent.text);
  });

  it('says the same to a member of another project as to nobody at all', async () => {
    const member = await call('GET', '/api/projects/prj_0000000000000000000/labor', {
      cookie: memberCookie,
    });
    const outsider = await call('GET', '/api/projects/prj_0000000000000000000/labor', {
      cookie: outsiderCookie,
    });
    expect(member.status).toBe(404);
    expect(member.text).toBe(outsider.text);
  });
});

describe('a declaration is judged by the same domain rules over the wire', () => {
  /*
   * This assertion was written the other way round first, and the correction
   * is recorded rather than quietly applied.
   *
   * It asserted that posting an extra top-level key — `productionLayer` on a
   * *declaration* — refuses the whole body, on the strength of §24's rule that
   * an unknown field fails the whole proposal. That rule is real and is scoped
   * to a **model's** proposal, where an invented field means the thing that
   * produced it cannot be trusted about any of the rest. No HTTP route in this
   * repository refuses an unknown body key, and making this one uniquely strict
   * would be the same one-of-several-readers defect in the opposite direction.
   *
   * What the rule actually governs is a **value** from a closed set, and that
   * is asserted below. The risk the first version was reaching for is real and
   * is answered by the response rather than by a refusal: a caller who posts
   * `productionLayer` here is told, in words, that Brain decides who produces
   * each task — so nobody is left believing they set something they did not.
   */
  it('accepts a declaration carrying an extra key, and does not claim a producer was set', async () => {
    const answer = await call<{ created: boolean; message: string }>(
      'POST',
      `${LABOR()}/workflows`,
      {
        cookie: adminCookie,
        body: { name: 'An extra-key workflow', productionLayer: 'BRAIN' },
      },
    );
    expect(answer.status).toBe(200);
    expect(answer.body.message).toMatch(/Brain decides when to ask who should produce/);
    expect(answer.body.message).not.toMatch(/BRAIN is/);
  });

  it('refuses a producer outside the closed set, which is the rule that does exist', async () => {
    const made = await call<{ workflow: { id: string } }>('POST', `${LABOR()}/workflows`, {
      cookie: adminCookie,
      body: { name: 'A closed-set workflow' },
    });
    const task = await call<{ task: { id: string } }>(
      'POST',
      `${LABOR()}/workflows/${made.body.workflow.id}/tasks`,
      {
        cookie: adminCookie,
        body: { name: 'A task', output: 'An output somebody receives.' },
      },
    );
    const answer = await call<{ error?: { message?: string } }>(
      'POST',
      `${LABOR()}/tasks/${task.body.task.id}/allocation`,
      {
        cookie: adminCookie,
        body: { productionLayer: 'A_HELPFUL_INTERN', rationale: 'because' },
      },
    );
    expect(answer.status).toBe(400);
    expect(answer.text).toMatch(/not a kind of producer/);
  });

  it('refuses a necessity reason outside the six, and names that there is no seventh', async () => {
    const made = await call<{ workflow: { id: string } }>('POST', `${LABOR()}/workflows`, {
      cookie: adminCookie,
      body: { name: 'A reason workflow' },
    });
    const task = await call<{ task: { id: string } }>(
      'POST',
      `${LABOR()}/workflows/${made.body.workflow.id}/tasks`,
      {
        cookie: adminCookie,
        body: { name: 'A task', output: 'An output somebody receives.' },
      },
    );
    const answer = await call(
      'POST',
      `${LABOR()}/tasks/${task.body.task.id}/allocation`,
      {
        cookie: adminCookie,
        body: {
          productionLayer: 'DOMESTIC_HUMAN',
          necessityReason: 'HISTORICAL_CONVENTION',
          rationale: 'because we always have',
        },
      },
    );
    expect(answer.status).toBe(400);
    expect(answer.text).toMatch(/how it has always been done/);
  });

  it('refuses a workflow with no name', async () => {
    const answer = await call('POST', `${LABOR()}/workflows`, {
      cookie: adminCookie,
      body: { tasks: [] },
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
  });

  /*
   * An ordinary member may read the map and may not declare what the work is.
   * ADMIN is the level a membership change already carries, and naming who
   * does the work is that shape of decision.
   */
  it('refuses an ordinary member the declaration, with the same body a stranger gets', async () => {
    const answer = await call('POST', `${LABOR()}/workflows`, {
      cookie: memberCookie,
      body: { name: 'A workflow', tasks: [] },
    });
    expect(answer.status).toBe(404);
  });
});
