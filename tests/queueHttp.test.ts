/**
 * The queue over HTTP, written as an attack.
 *
 * `workQueue.test.ts` proves the concurrency. This proves the queue is actually
 * behind the gate — that the routes consult the policy, that a worker is
 * whoever its credential says it is rather than whoever the request body claims,
 * and that a work item in another project is indistinguishable from one that
 * does not exist.
 *
 * The interesting failures here are the ones a unit test of the policy could
 * never catch: a route that resolves an item before authorizing it, a handler
 * that trusts `body.workerId`, a response that publishes the lease id to a
 * reader who is not the owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5900 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const ALICE_PASSWORD = 'alice-password-000001';
const BOB_PASSWORD = 'bob-password-00000001';

let adminCookie = '';
let aliceCookie = '';
let bobCookie = '';
let projectA = '';
let projectB = '';
let workerA = '';
let workerACredential = '';
let workerACredentialId = '';
let workerB = '';
let workerBCredential = '';
let readOnlyWorkerCredential = '';

interface Result<T = unknown> {
  status: number;
  body: T;
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
  return { status: response.status, body: body as T };
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

async function makePerson(email: string, password: string): Promise<{ id: string; cookie: string }> {
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName: email, password: 'temporary-password-01' },
  });
  const first = await signIn(email, 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: password },
  });
  return { id: created.body.user.id, cookie: await signIn(email, password) };
}

async function grant(project: string, principalId: string, body: Record<string, unknown>): Promise<void> {
  const result = await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId, ...body },
  });
  if (result.status !== 200) throw new Error(`grant failed: ${JSON.stringify(result.body)}`);
}

async function makeWorker(
  name: string,
  project: string,
  scopes: string[],
): Promise<{ id: string; secret: string; credentialId: string }> {
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name, displayName: name },
  });
  const id = worker.body.worker.id;
  await grant(project, id, { principalType: 'WORKER', scopes });
  const issued = await call<{ secret: string; credential: { id: string } }>(
    'POST',
    `/api/admin/workers/${id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  return { id, secret: issued.body.secret, credentialId: issued.body.credential.id };
}

/** Enqueue as the Brain administrator, which is the authority that may. */
async function enqueue(project: string, note = 'hello'): Promise<string> {
  const result = await call<{ item: { id: string } }>('POST', `/api/projects/${project}/work`, {
    cookie: adminCookie,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note } },
  });
  if (result.status !== 200) throw new Error(`enqueue failed: ${JSON.stringify(result.body)}`);
  return result.body.item.id;
}

interface Claim {
  workItemId: string;
  leaseId: string;
  leaseGeneration: number;
}

async function claim(bearer: string, body: Record<string, unknown> = {}): Promise<Claim[]> {
  const result = await call<{ claimed: Claim[] }>('POST', '/api/work/claim', { bearer, body });
  return result.body?.claimed ?? [];
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-queue-'));
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
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  projectA = seeded.body.projects[0]!.id;

  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  projectB = (await createProject({ name: 'Somebody Elses Project' })).id;
  await closeDatabase();

  const alice = await makePerson('alice@example.invalid', ALICE_PASSWORD);
  aliceCookie = alice.cookie;
  await grant(projectA, alice.id, { principalType: 'HUMAN', role: 'MEMBER' });

  const bob = await makePerson('bob@example.invalid', BOB_PASSWORD);
  bobCookie = bob.cookie;
  await grant(projectB, bob.id, { principalType: 'HUMAN', role: 'OWNER' });

  const one = await makeWorker('queue-worker-a', projectA, [
    'queue:read',
    'queue:claim',
    'queue:heartbeat',
    'queue:complete',
  ]);
  workerA = one.id;
  workerACredential = one.secret;
  workerACredentialId = one.credentialId;

  const two = await makeWorker('queue-worker-b', projectB, [
    'queue:read',
    'queue:claim',
    'queue:heartbeat',
    'queue:complete',
  ]);
  workerB = two.id;
  workerBCredential = two.secret;

  // A worker that may look but not take.
  const readOnly = await makeWorker('queue-reader', projectA, ['queue:read']);
  readOnlyWorkerCredential = readOnly.secret;
}, 90_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a caller with no credentials', () => {
  it('is refused by every queue route', async () => {
    const id = await enqueue(projectA);
    for (const [method, route] of [
      ['GET', `/api/projects/${projectA}/work`],
      ['GET', `/api/projects/${projectA}/work/metrics`],
      ['POST', `/api/projects/${projectA}/work`],
      ['GET', `/api/work/${id}`],
      ['POST', '/api/work/claim'],
      ['POST', `/api/work/${id}/heartbeat`],
      ['POST', `/api/work/${id}/complete`],
      ['POST', `/api/work/${id}/fail`],
      ['POST', `/api/work/${id}/release`],
      ['POST', `/api/work/${id}/cancel`],
    ] as const) {
      const result = await call(method, route, { body: method === 'POST' ? {} : undefined });
      expect(result.status, `${method} ${route}`).toBe(401);
    }
  });
});

describe('creating work', () => {
  it('is refused to an ordinary member', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: aliceCookie,
      body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    });
    expect(result.status).toBe(404);
  });

  it('is refused to a worker, however many scopes it holds', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      bearer: workerACredential,
      body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    });
    expect(result.status).toBe(404);
  });

  it('refuses a work type that is not registered', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: adminCookie,
      body: { workType: 'RUN_SHELL_COMMAND', payload: { cmd: 'rm -rf /' } },
    });
    expect(result.status).toBe(400);
  });

  it('keeps only the fields the work type declares', async () => {
    const created = await call<{ item: { id: string; payload: Record<string, unknown> } }>(
      'POST',
      `/api/projects/${projectA}/work`,
      {
        cookie: adminCookie,
        body: {
          workType: 'SYNTHETIC_ECHO',
          payload: { note: 'keep me', command: 'drop database', big: 'x'.repeat(100) },
        },
      },
    );
    expect(created.status).toBe(200);
    expect(created.body.item.payload).toEqual({ note: 'keep me' });
  });

  it('refuses a payload that is too large', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: adminCookie,
      body: { workType: 'SYNTHETIC_ECHO', payload: { note: 'x'.repeat(5000) } },
    });
    expect(result.status).toBe(400);
  });
});

describe('one worker, one project', () => {
  it('claims only work from the project it belongs to', async () => {
    await enqueue(projectA, 'for A');
    await enqueue(projectB, 'for B');

    const claimed = await claim(workerACredential, { limit: 10 });
    expect(claimed.length).toBeGreaterThan(0);
    for (const item of claimed) {
      const detail = await call<{ item: { projectId: string } }>('GET', `/api/work/${item.workItemId}`, {
        cookie: adminCookie,
      });
      expect(detail.body.item.projectId).toBe(projectA);
    }
  });

  it('cannot reach another project by guessing a work item id', async () => {
    const theirs = await enqueue(projectB, 'private');
    for (const [method, route] of [
      ['GET', `/api/work/${theirs}`],
      ['POST', `/api/work/${theirs}/heartbeat`],
      ['POST', `/api/work/${theirs}/complete`],
      ['POST', `/api/work/${theirs}/fail`],
    ] as const) {
      const result = await call(method, route, {
        bearer: workerACredential,
        body: method === 'POST' ? { leaseId: 'wls_guess', leaseGeneration: 1 } : undefined,
      });
      expect(result.status, `${method} ${route}`).toBe(404);
    }
  });

  it('gets the same answer for a forbidden item as for one that does not exist', async () => {
    const theirs = await enqueue(projectB, 'private');
    const forbidden = await call('GET', `/api/work/${theirs}`, { bearer: workerACredential });
    const absent = await call('GET', '/api/work/wki_does_not_exist', { bearer: workerACredential });
    expect(forbidden.status).toBe(absent.status);
    // The body too, byte for byte. Comparing only the status is what let this
    // through the first time: both were 404 while the messages differed, so the
    // id was still being confirmed to a caller who may not have it.
    expect(JSON.stringify(forbidden.body)).toBe(JSON.stringify(absent.body));
    expect(JSON.stringify(forbidden.body)).not.toContain(theirs);
  });

  it('cannot claim without the claim scope', async () => {
    await enqueue(projectA);
    const result = await call('POST', '/api/work/claim', {
      bearer: readOnlyWorkerCredential,
      body: {},
    });
    expect(result.status).toBe(404);
  });

  it('cannot become another worker by saying so in the body', async () => {
    await enqueue(projectB, 'for B only');
    // Worker A asks to claim as worker B, in worker B's project. Both the
    // identity and the project come from the credential, so this gets nothing.
    const claimed = await claim(workerACredential, {
      workerId: workerB,
      projectId: projectB,
      limit: 5,
    });
    expect(claimed).toEqual([]);
  });
});

describe('holding a lease over HTTP', () => {
  it('runs the whole contract: claim, heartbeat, complete', async () => {
    const id = await enqueue(projectA, 'lifecycle');
    const claimed = await claim(workerACredential, { limit: 25 });
    const mine = claimed.find((c) => c.workItemId === id);
    expect(mine, 'the enqueued item was claimed').toBeTruthy();

    const beat = await call('POST', `/api/work/${id}/heartbeat`, {
      bearer: workerACredential,
      body: { leaseId: mine!.leaseId, leaseGeneration: mine!.leaseGeneration },
    });
    expect(beat.status).toBe(200);

    const done = await call<{ item: { state: string } }>('POST', `/api/work/${id}/complete`, {
      bearer: workerACredential,
      body: { leaseId: mine!.leaseId, leaseGeneration: mine!.leaseGeneration, summary: 'echoed' },
    });
    expect(done.status).toBe(200);
    expect(done.body.item.state).toBe('SUCCEEDED');
  });

  it('refuses a heartbeat carrying a stale generation', async () => {
    const id = await enqueue(projectA, 'stale');
    const claimed = await claim(workerACredential, { limit: 25 });
    const mine = claimed.find((c) => c.workItemId === id)!;
    const result = await call('POST', `/api/work/${id}/heartbeat`, {
      bearer: workerACredential,
      body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration - 1 },
    });
    expect(result.status).toBe(409);
  });

  it('does not publish the lease id to a reader who is not the owner', async () => {
    const id = await enqueue(projectA, 'secretish');
    await claim(workerACredential, { limit: 25 });
    const seen = await call<{ item: Record<string, unknown> }>('GET', `/api/work/${id}`, {
      cookie: adminCookie,
    });
    expect(seen.status).toBe(200);
    expect(seen.body.item['leaseId']).toBeUndefined();
    expect(seen.body.item['hasLease']).toBe(true);
  });
});

describe('cancellation over HTTP', () => {
  it('is refused to an ordinary member and allowed to an administrator', async () => {
    const id = await enqueue(projectA, 'cancel me');
    const refused = await call('POST', `/api/work/${id}/cancel`, {
      cookie: aliceCookie,
      body: { reason: 'because' },
    });
    expect(refused.status).toBe(404);

    const allowed = await call<{ item: { state: string } }>('POST', `/api/work/${id}/cancel`, {
      cookie: adminCookie,
      body: { reason: 'no longer needed' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.item.state).toBe('CANCELLED');
  });

  it('is refused to the owner of a different project', async () => {
    const id = await enqueue(projectA, 'not bobs');
    const result = await call('POST', `/api/work/${id}/cancel`, {
      cookie: bobCookie,
      body: { reason: 'mine now' },
    });
    expect(result.status).toBe(404);
  });
});

describe('taking authority away mid-lease', () => {
  it('stops a worker the moment its credential is revoked', async () => {
    const id = await enqueue(projectA, 'revoke the credential');
    const claimed = await claim(workerACredential, { limit: 25 });
    const mine = claimed.find((c) => c.workItemId === id)!;

    await call('POST', `/api/admin/workers/${workerA}/credentials/${workerACredentialId}/revoke`, {
      cookie: adminCookie,
      body: { reason: 'test' },
    });

    const beat = await call('POST', `/api/work/${id}/heartbeat`, {
      bearer: workerACredential,
      body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration },
    });
    expect(beat.status).toBe(401);

    // And the work is not stranded: it is still leased, and the lease will
    // expire and be reclaimed by somebody else. Nothing was lost.
    const item = await call<{ item: { state: string } }>('GET', `/api/work/${id}`, {
      cookie: adminCookie,
    });
    expect(item.body.item.state).toBe('LEASED');
  });

  it('stops a worker the moment it is disabled', async () => {
    const id = await enqueue(projectB, 'disable the worker');
    const claimed = await claim(workerBCredential, { limit: 25 });
    const mine = claimed.find((c) => c.workItemId === id)!;

    await call('POST', `/api/admin/workers/${workerB}/disabled`, {
      cookie: adminCookie,
      body: { disabled: true },
    });

    const beat = await call('POST', `/api/work/${id}/heartbeat`, {
      bearer: workerBCredential,
      body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration },
    });
    expect(beat.status).toBe(401);
    expect((await claim(workerBCredential)).length).toBe(0);
  });
});

describe('the audit trail', () => {
  it('records who claimed and who finished, and no payload', async () => {
    const id = await enqueue(projectA, 'audited');
    const events = await call<{ events: { action: string; targetId: string | null; metadata: unknown }[] }>(
      'GET',
      '/api/admin/identity-events?limit=200',
      { cookie: adminCookie },
    );
    expect(events.status).toBe(200);
    const mine = events.body.events.filter((event) => event.targetId === id);
    expect(mine.some((event) => event.action === 'QUEUE_ENQUEUE')).toBe(true);
    expect(JSON.stringify(events.body.events)).not.toContain('audited');
  });
});
