/**
 * Idempotency over HTTP, written as an attack.
 *
 * `idempotency.test.ts` proves the engine. This proves the wiring: that a key
 * in a URL is refused rather than ignored, that a replay re-authorizes instead
 * of handing back a stored answer, that a worker whose lease has gone cannot
 * commit an effect, and that a redelivered work item finds the effect it
 * already performed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6100 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const ALICE_PASSWORD = 'alice-password-000001';

let adminCookie = '';
let aliceCookie = '';
let aliceId = '';
let projectA = '';
let projectB = '';
let workerCredential = '';
let rivalCredential = '';

let keySeq = 0;
const nextKey = (): string => `http-key-${String(++keySeq).padStart(8, '0')}`;

interface Result<T = unknown> {
  status: number;
  body: T;
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: {
    cookie?: string;
    bearer?: string;
    body?: unknown;
    idempotencyKey?: string;
    rawKeyHeader?: string;
  } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie && method !== 'GET') headers.origin = BASE;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.rawKeyHeader !== undefined) headers['idempotency-key'] = options.rawKeyHeader;
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

async function grant(project: string, principalId: string, body: Record<string, unknown>): Promise<void> {
  const result = await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId, ...body },
  });
  if (result.status !== 200) throw new Error(`grant failed: ${JSON.stringify(result.body)}`);
}

async function makeWorker(name: string, project: string): Promise<string> {
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name, displayName: name },
  });
  await grant(project, worker.body.worker.id, {
    principalType: 'WORKER',
    scopes: ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  return issued.body.secret;
}

async function enqueue(
  project: string,
  options: { key?: string; note?: string } = {},
): Promise<Result<{ item: { id: string }; replayed?: boolean }>> {
  return await call('POST', `/api/projects/${project}/work`, {
    cookie: adminCookie,
    idempotencyKey: options.key,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note: options.note ?? 'hello' } },
  });
}

interface Claim {
  workItemId: string;
  leaseId: string;
  leaseGeneration: number;
}

async function claim(bearer: string): Promise<Claim[]> {
  const result = await call<{ claimed: Claim[] }>('POST', '/api/work/claim', {
    bearer,
    body: { limit: 25 },
  });
  return result.body?.claimed ?? [];
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-idem-'));
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

  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email: 'alice@example.invalid', displayName: 'Alice', password: 'temporary-password-01' },
  });
  aliceId = created.body.user.id;
  const first = await signIn('alice@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: ALICE_PASSWORD },
  });
  aliceCookie = await signIn('alice@example.invalid', ALICE_PASSWORD);
  await grant(projectA, aliceId, { principalType: 'HUMAN', role: 'MEMBER' });

  workerCredential = await makeWorker('idem-worker', projectA);
  rivalCredential = await makeWorker('idem-rival', projectA);
}, 90_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('where a key may arrive', () => {
  it('refuses a key in the query string rather than ignoring it', async () => {
    // Ignoring it would leave the caller believing they had idempotency.
    const result = await call('POST', `/api/projects/${projectA}/work?idempotency_key=abcdefgh`, {
      cookie: adminCookie,
      body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toMatch(/header/i);
  });

  it('refuses a malformed key', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: adminCookie,
      rawKeyHeader: 'has spaces and !!',
      body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    });
    expect(result.status).toBe(400);
  });

  it('refuses a key that is too short', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: adminCookie,
      rawKeyHeader: 'tiny',
      body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    });
    expect(result.status).toBe(400);
  });

  it('refuses a key that is too long', async () => {
    const result = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: adminCookie,
      rawKeyHeader: 'x'.repeat(300),
      body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    });
    expect(result.status).toBe(400);
  });

  it('still works without a key, creating an item each time', async () => {
    // Unprotected is the documented behaviour of an unkeyed request, not an
    // accident: enqueueing twice on purpose is a real thing to want.
    const one = await enqueue(projectA);
    const two = await enqueue(projectA);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(one.body.item.id).not.toBe(two.body.item.id);
  });
});

describe('a keyed mutation', () => {
  it('executes once and replays afterwards', async () => {
    const key = nextKey();
    const first = await enqueue(projectA, { key });
    const second = await enqueue(projectA, { key });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
  });

  it('creates exactly one work item from eight concurrent duplicates', async () => {
    const key = nextKey();
    const replies = await Promise.all(Array.from({ length: 8 }, () => enqueue(projectA, { key })));

    const created = replies.filter((reply) => reply.status === 200).map((r) => r.body.item?.id);
    const distinct = new Set(created.filter(Boolean));
    expect(distinct.size).toBe(1);
    // Everybody who did not get the item was told it was already running.
    for (const reply of replies) {
      if (reply.status !== 200) expect(reply.status).toBe(409);
    }
  });

  it('refuses the same key with a different request', async () => {
    const key = nextKey();
    await enqueue(projectA, { key, note: 'original' });
    const conflicting = await enqueue(projectA, { key, note: 'different' });
    expect(conflicting.status).toBe(409);
    expect(JSON.stringify(conflicting.body)).toContain('FINGERPRINT_CONFLICT');
    // And it does not disclose what the original request was.
    expect(JSON.stringify(conflicting.body)).not.toContain('original');
  });

  it('keeps the same key independent in another project', async () => {
    const key = nextKey();
    const inA = await enqueue(projectA, { key });
    const inB = await enqueue(projectB, { key });
    expect(inA.status).toBe(200);
    expect(inB.status).toBe(200);
    expect(inA.body.item.id).not.toBe(inB.body.item.id);
  });
});

describe('replay re-authorizes', () => {
  it('refuses to replay to a principal who has lost the project', async () => {
    // Alice can read project A, so she can be shown a work item there. Take
    // that away, and the replay must not hand her the result anyway just
    // because the original request was allowed.
    const key = nextKey();
    const first = await enqueue(projectA, { key });
    expect(first.status).toBe(200);

    await call(
      'DELETE',
      `/api/admin/projects/${projectA}/members/HUMAN/${aliceId}`,
      { cookie: adminCookie, body: {} },
    );

    const replay = await call('POST', `/api/projects/${projectA}/work`, {
      cookie: aliceCookie,
      idempotencyKey: key,
      body: { workType: 'SYNTHETIC_ECHO', payload: { note: 'hello' } },
    });
    // She cannot even resolve the project any more, so she gets the same 404 as
    // a project that does not exist.
    expect(replay.status).toBe(404);

    await grant(projectA, aliceId, { principalType: 'HUMAN', role: 'MEMBER' });
  });
});

describe('committing an effect under a lease', () => {
  it('commits once, and a redelivery replays instead of repeating', async () => {
    const created = await enqueue(projectA, { key: nextKey(), note: 'effect' });
    const id = created.body.item.id;

    const mine = (await claim(workerCredential)).find((c) => c.workItemId === id);
    expect(mine).toBeTruthy();

    const commit = await call<{ committed: boolean; replayed: boolean }>(
      'POST',
      `/api/work/${id}/effect`,
      {
        bearer: workerCredential,
        body: { leaseId: mine!.leaseId, leaseGeneration: mine!.leaseGeneration, summary: 'done' },
      },
    );
    expect(commit.status).toBe(200);
    expect(commit.body.replayed).toBe(false);

    // The same worker, the same lease, sending it again — the shape a retry
    // takes when a response is lost.
    const again = await call<{ replayed: boolean }>('POST', `/api/work/${id}/effect`, {
      bearer: workerCredential,
      body: { leaseId: mine!.leaseId, leaseGeneration: mine!.leaseGeneration, summary: 'done' },
    });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
  });

  it('refuses a worker whose lease was reclaimed', async () => {
    const created = await enqueue(projectA, { key: nextKey(), note: 'fence' });
    const id = created.body.item.id;
    const mine = (await claim(workerCredential)).find((c) => c.workItemId === id)!;

    // Expire the lease and let somebody else take it, exactly as a reclaim does.
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    await getDb().run(
      "UPDATE work_items SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      [id],
    );
    await closeDatabase();
    const theirs = (await claim(rivalCredential)).find((c) => c.workItemId === id);
    expect(theirs).toBeTruthy();

    const stale = await call('POST', `/api/work/${id}/effect`, {
      bearer: workerCredential,
      body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration, summary: 'stale' },
    });
    expect(stale.status).toBe(409);

    // And the new owner can still commit it, once.
    const fresh = await call('POST', `/api/work/${id}/effect`, {
      bearer: rivalCredential,
      body: {
        leaseId: theirs!.leaseId,
        leaseGeneration: theirs!.leaseGeneration,
        summary: 'the real one',
      },
    });
    expect(fresh.status).toBe(200);
  });

  it('refuses to commit an effect for cancelled work', async () => {
    const created = await enqueue(projectA, { key: nextKey(), note: 'cancelled' });
    const id = created.body.item.id;
    const mine = (await claim(workerCredential)).find((c) => c.workItemId === id)!;

    await call('POST', `/api/work/${id}/cancel`, {
      cookie: adminCookie,
      body: { reason: 'no longer needed' },
    });

    const late = await call('POST', `/api/work/${id}/effect`, {
      bearer: workerCredential,
      body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration, summary: 'too late' },
    });
    expect(late.status).toBe(409);
  });
});

describe('inspecting and resolving operations', () => {
  it('is refused to an ordinary member and to a worker', async () => {
    const created = await enqueue(projectA, { key: nextKey() });
    expect(created.status).toBe(200);

    const asMember = await call('GET', `/api/projects/${projectA}/operations`, {
      cookie: aliceCookie,
    });
    expect(asMember.status).toBe(404);

    const asWorker = await call('GET', `/api/projects/${projectA}/operations`, {
      bearer: workerCredential,
    });
    expect(asWorker.status).toBe(404);
  });

  it('shows an administrator the operation without its key or payload', async () => {
    const key = nextKey();
    await enqueue(projectA, { key, note: 'a-distinctive-note' });
    const listed = await call<{ operations: Record<string, unknown>[] }>(
      'GET',
      `/api/projects/${projectA}/operations`,
      { cookie: adminCookie },
    );
    expect(listed.status).toBe(200);
    const serialized = JSON.stringify(listed.body);
    // Neither the key the caller sent nor the request it described.
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain('a-distinctive-note');
  });

  it('refuses to resolve an operation that is not uncertain', async () => {
    const created = await enqueue(projectA, { key: nextKey() });
    const listed = await call<{ operations: { id: string; state: string }[] }>(
      'GET',
      `/api/projects/${projectA}/operations`,
      { cookie: adminCookie },
    );
    const succeeded = listed.body.operations.find((o) => o.state === 'SUCCEEDED');
    expect(succeeded).toBeTruthy();
    expect(created.status).toBe(200);

    const resolved = await call('POST', `/api/operations/${succeeded!.id}/resolve`, {
      cookie: adminCookie,
      body: { as: 'FAILED', reason: 'trying to overwrite a success' },
    });
    expect(resolved.status).toBe(409);
  });

  it('gives the same answer for another project’s operation as for one that does not exist', async () => {
    const listed = await call<{ operations: { id: string }[] }>(
      'GET',
      `/api/projects/${projectA}/operations`,
      { cookie: adminCookie },
    );
    const real = listed.body.operations[0]!.id;

    // Alice is a member of A but not an administrator, so both are refused
    // identically — she learns nothing about which ids exist.
    const forbidden = await call('GET', `/api/operations/${real}`, { cookie: aliceCookie });
    const absent = await call('GET', '/api/operations/idop_no_such_operation', {
      cookie: aliceCookie,
    });
    expect(forbidden.status).toBe(absent.status);
    expect(JSON.stringify(forbidden.body)).toBe(JSON.stringify(absent.body));
  });
});

describe('anonymous callers', () => {
  it('are refused every effect and operation route', async () => {
    for (const [method, route] of [
      ['GET', `/api/projects/${projectA}/operations`],
      ['GET', '/api/operations/idop_anything'],
      ['POST', '/api/operations/idop_anything/resolve'],
      ['POST', '/api/work/wki_anything/effect'],
    ] as const) {
      const result = await call(method, route, { body: method === 'POST' ? {} : undefined });
      expect(result.status, `${method} ${route}`).toBe(401);
    }
  });
});
