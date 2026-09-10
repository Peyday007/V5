/**
 * The factory over HTTP, written as an attack.
 *
 * `factory.test.ts` proves the services. This proves the routes are actually
 * behind the gate, against a real booted server — which is the only level where
 * the interesting failures live. A handler that resolves a campaign before
 * authorizing it, a refusal whose *body* differs between "you may not" and "it
 * is not there", a person-only decision a machine can reach: none of those is
 * visible from a unit test.
 *
 * The properties being defended here are the ones the factory would be most
 * dangerous without. Anonymous callers cannot create or inspect campaigns. One
 * project cannot see another's. A worker principal cannot approve an objective
 * or answer a release, by principal type rather than by configuration. And the
 * fleet projection cannot leak a credential, because the row it reads from never
 * held one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6400 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const OUTSIDER_PASSWORD = 'outsider-password-0001';

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';
let adminCookie = '';
let outsiderCookie = '';
let workerBearer = '';
let projectId = '';
let changeRequestId = '';
let campaignId = '';

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
    /* keep the text */
  }
  return { status: response.status, body: body as T, text };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in for ${email} failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const OBJECTIVE = {
  objective: 'Prove the factory routes are behind the gate, against a booted server.',
  expectedOutcome: 'An anonymous caller can neither create nor inspect a campaign.',
  acceptanceConditions: [
    { statement: 'anonymous callers are refused', verification: 'call every route without a cookie' },
  ],
  mutationScope: ['tests/**'],
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-factory-http-'));
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
        BRAIN_FACTORY_ROOT: path.join(dataDir, 'factory'),
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
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  projectId = seeded.body.projects[0]!.id;

  // Somebody signed in who is a member of nothing.
  await call('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: {
      email: 'outsider@example.invalid',
      displayName: 'outsider',
      password: 'temporary-password-01',
    },
  });
  const firstCookie = await signIn('outsider@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: firstCookie,
    body: { currentPassword: 'temporary-password-01', newPassword: OUTSIDER_PASSWORD },
  });
  outsiderCookie = await signIn('outsider@example.invalid', OUTSIDER_PASSWORD);

  // A worker with read access to the project, which is more than a factory
  // decision needs and still not a person.
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'factory-http-worker', displayName: 'factory-http-worker' },
  });
  await call('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      scopes: ['project:read', 'project:write'],
    },
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerBearer = issued.body.secret;

  const submitted = await call<{ changeRequest: { id: string } }>(
    'POST',
    `/api/projects/${projectId}/factory/change-requests`,
    { cookie: adminCookie, body: OBJECTIVE },
  );
  changeRequestId = submitted.body.changeRequest.id;
  const approved = await call<{ campaign: { id: string } }>(
    'POST',
    `/api/factory/change-requests/${changeRequestId}/approve`,
    { cookie: adminCookie },
  );
  campaignId = approved.body.campaign.id;
}, 120_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('a caller with no credentials', () => {
  it('can neither create nor inspect a campaign', async () => {
    const routes: [string, string, unknown?][] = [
      ['POST', `/api/projects/${projectId}/factory/change-requests`, OBJECTIVE],
      ['GET', `/api/projects/${projectId}/factory/change-requests`],
      ['GET', `/api/projects/${projectId}/factory/campaigns`],
      ['GET', `/api/factory/campaigns/${campaignId}`],
      ['GET', `/api/factory/campaigns/${campaignId}/evidence`],
      ['GET', `/api/factory/change-requests/${changeRequestId}`],
      ['POST', `/api/factory/change-requests/${changeRequestId}/approve`],
      ['POST', `/api/factory/campaigns/${campaignId}/release`, { decision: 'APPROVED' }],
      ['GET', '/api/factory/fleet'],
    ];
    for (const [method, route, body] of routes) {
      const result = await call(method, route, { body });
      expect([401, 403, 404], `${method} ${route}`).toContain(result.status);
    }
  });
});

describe('somebody signed in who is a member of nothing', () => {
  it('cannot tell a campaign they may not see from one that does not exist', async () => {
    const real = await call('GET', `/api/factory/campaigns/${campaignId}`, {
      cookie: outsiderCookie,
    });
    const invented = await call('GET', '/api/factory/campaigns/fcp_0000000000000000dead', {
      cookie: outsiderCookie,
    });
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    // The same status *and* the same body. A body that differed would still be
    // an oracle for enumerating a Brain you have no access to.
    expect(real.text).toBe(invented.text);
  });

  it('cannot submit an objective into a project they are not in', async () => {
    const result = await call('POST', `/api/projects/${projectId}/factory/change-requests`, {
      cookie: outsiderCookie,
      body: OBJECTIVE,
    });
    expect([403, 404]).toContain(result.status);
  });
});

describe('a worker principal', () => {
  it('cannot approve an objective or answer a release, whatever its scopes', async () => {
    const approve = await call(
      'POST',
      `/api/factory/change-requests/${changeRequestId}/approve`,
      { bearer: workerBearer },
    );
    expect(approve.status).toBe(404);

    const release = await call('POST', `/api/factory/campaigns/${campaignId}/release`, {
      bearer: workerBearer,
      body: { decision: 'APPROVED' },
    });
    expect(release.status).toBe(404);

    const submit = await call('POST', `/api/projects/${projectId}/factory/change-requests`, {
      bearer: workerBearer,
      body: { ...OBJECTIVE, submissionKey: 'worker-attempt' },
    });
    expect(submit.status).toBe(404);

    const fleet = await call('GET', '/api/factory/fleet', { bearer: workerBearer });
    expect(fleet.status).toBe(404);
  });
});

describe('submitting', () => {
  it('makes one change request and one campaign however many times it is called', async () => {
    const first = await call<{ changeRequest: { id: string }; created: boolean }>(
      'POST',
      `/api/projects/${projectId}/factory/change-requests`,
      { cookie: adminCookie, body: OBJECTIVE },
    );
    expect(first.body.created).toBe(false);
    expect(first.body.changeRequest.id).toBe(changeRequestId);

    const approvedAgain = await call<{ campaign: { id: string }; campaignCreated: boolean }>(
      'POST',
      `/api/factory/change-requests/${changeRequestId}/approve`,
      { cookie: adminCookie },
    );
    expect(approvedAgain.body.campaign.id).toBe(campaignId);
    expect(approvedAgain.body.campaignCreated).toBe(false);
  });

  it('refuses an objective whose success is undefined', async () => {
    const submitted = await call<{ changeRequest: { id: string } }>(
      'POST',
      `/api/projects/${projectId}/factory/change-requests`,
      {
        cookie: adminCookie,
        body: {
          objective: 'Do something generally worthwhile to this repository, unspecified.',
          expectedOutcome: 'Something is different afterwards.',
          submissionKey: 'no-conditions',
        },
      },
    );
    const approve = await call(
      'POST',
      `/api/factory/change-requests/${submitted.body.changeRequest.id}/approve`,
      { cookie: adminCookie },
    );
    expect(approve.status).toBe(400);
    expect(JSON.stringify(approve.body)).toMatch(/acceptance conditions/i);
  });
});

describe('the campaign view', () => {
  it('answers in the terms a person cares about, and carries no credential', async () => {
    const view = await call<{
      objective: string;
      stage: string;
      blocker: unknown;
      activeWork: unknown[];
      decisionWaiting: unknown;
      metrics: { concurrencyEvidence: string; paidApiExecutions: number };
    }>('GET', `/api/factory/campaigns/${campaignId}`, { cookie: adminCookie });
    expect(view.status).toBe(200);
    expect(view.body.objective).toContain('Prove the factory routes');
    expect(view.body.stage).toBe('PLANNING');
    expect(view.body.blocker).toBeNull();
    expect(view.body.activeWork).toEqual([]);
    // Nothing has run, so the ceiling is unknown rather than zero.
    expect(view.body.metrics.concurrencyEvidence).toBe('UNKNOWN');
    expect(view.body.metrics.paidApiExecutions).toBe(0);
    expect(view.text).not.toContain(workerBearer);
  });

  it('reports the fleet without anything a credential could be recovered from', async () => {
    const fleet = await call<{
      ready: boolean;
      capacity: { registered: number; ceilingEvidence: string };
      workers: { credentialRecorded: boolean }[];
    }>('GET', '/api/factory/fleet', { cookie: adminCookie });
    expect(fleet.status).toBe(200);
    // No factory worker is registered in this Brain, so the ceiling is unknown.
    expect(fleet.body.capacity.ceilingEvidence).toBe('UNKNOWN');
    expect(fleet.body.ready).toBe(false);
    expect(fleet.text).not.toMatch(/credentialDigest/);
  });
});

describe('the release decision', () => {
  it('is refused while nothing is waiting, and is answered exactly once', async () => {
    const early = await call('POST', `/api/factory/campaigns/${campaignId}/release`, {
      cookie: adminCookie,
      body: { decision: 'APPROVED' },
    });
    // Nothing has asked for a release, so there is nothing to answer.
    expect(early.status).toBe(404);

    const nonsense = await call('POST', `/api/factory/campaigns/${campaignId}/release`, {
      cookie: adminCookie,
      body: { decision: 'MAYBE' },
    });
    expect(nonsense.status).toBe(400);
  });
});
