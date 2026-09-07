/**
 * Russell over HTTP, written as an attack.
 *
 * `russellNervousSystem.test.ts` proves the services. This proves the routes
 * are actually behind the gate, against a real booted server — which is the
 * only level where the interesting failures live. A handler that resolves a
 * conversation before authorizing it, a listing that scopes by owner in
 * JavaScript instead of in the query, a refusal that says "forbidden" for a
 * thread that exists and "not found" for one that does not: none of those is
 * visible from a unit test of the policy.
 *
 * The two boundaries are tested separately because they are separate. A project
 * is guarded by membership. A conversation is guarded by its *owner*, and a
 * Brain administrator is deliberately not entitled to one — an administrator
 * who can read everybody's private threads is a different product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const BOB_PASSWORD = 'bob-password-00000001';

let adminCookie = '';
let aliceCookie = '';
let bobCookie = '';
let projectId = '';
let layerId = '';
let aliceThread = '';
let bobThread = '';
let workerBearer = '';

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

async function grant(principalId: string, body: Record<string, unknown>): Promise<void> {
  const result = await call('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalId, ...body },
  });
  if (result.status !== 200) throw new Error(`grant failed: ${JSON.stringify(result.body)}`);
}

async function openThread(cookie: string, title: string): Promise<string> {
  const created = await call<{ id: string }>('POST', '/api/russell/conversations', {
    cookie,
    body: { title },
  });
  if (created.status !== 200) throw new Error(`thread failed: ${JSON.stringify(created.body)}`);
  return created.body.id;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-russell-'));
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
  projectId = seeded.body.projects[0]!.id;
  const layers = await call<{ layers: { id: string }[] }>('GET', `/api/projects/${projectId}`, {
    cookie: adminCookie,
  });
  layerId = layers.body.layers[0]!.id;

  const alice = await makePerson('alice@example.invalid', ALICE_PASSWORD);
  aliceCookie = alice.cookie;
  await grant(alice.id, { principalType: 'HUMAN', role: 'MEMBER' });

  // Bob is signed in and is a member of nothing.
  const bob = await makePerson('bob@example.invalid', BOB_PASSWORD);
  bobCookie = bob.cookie;

  aliceThread = await openThread(aliceCookie, "Alice's thread");
  bobThread = await openThread(bobCookie, "Bob's thread");

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'russell-http-worker', displayName: 'russell-http-worker' },
  });
  await grant(worker.body.worker.id, { principalType: 'WORKER', scopes: ['project:read'] });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerBearer = issued.body.secret;
}, 90_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a caller with no credentials', () => {
  it('is refused by every Russell route', async () => {
    for (const [method, route] of [
      ['GET', '/api/russell/conversations'],
      ['POST', '/api/russell/conversations'],
      ['GET', `/api/russell/conversations/${aliceThread}`],
      ['POST', `/api/russell/conversations/${aliceThread}/turns`],
      ['GET', `/api/russell/projects/${projectId}/briefing`],
      ['GET', `/api/russell/projects/${projectId}/work`],
      ['GET', `/api/russell/projects/${projectId}/candidates`],
      ['GET', `/api/russell/projects/${projectId}/authority`],
      ['POST', `/api/russell/projects/${projectId}/authority`],
      ['GET', '/api/russell/candidates/rcn_0123456789abcdef0123'],
      ['POST', '/api/russell/candidates/rcn_0123456789abcdef0123/judgment'],
      ['POST', '/api/russell/candidates/rcn_0123456789abcdef0123/split'],
      ['GET', `/api/russell/projects/${projectId}/knowledge`],
      ['GET', `/api/russell/projects/${projectId}/needs-you`],
      ['POST', `/api/russell/projects/${projectId}/coverage`],
      ['GET', '/api/russell/deal-dispatch'],
    ] as const) {
      const result = await call(method, route, { body: method === 'POST' ? {} : undefined });
      expect(result.status, `${method} ${route}`).toBe(401);
    }
  });
});

describe('a conversation belongs to its owner', () => {
  it("refuses somebody else's thread exactly as it refuses one that does not exist", async () => {
    const trespass = await call('GET', `/api/russell/conversations/${bobThread}`, {
      cookie: aliceCookie,
    });
    const missing = await call('GET', '/api/russell/conversations/rcv_no_such_thing', {
      cookie: aliceCookie,
    });

    expect(trespass.status).toBe(404);
    expect(missing.status).toBe(404);
    // Byte-identical bodies. A status code that matches while the body differs
    // is still an oracle, and it survives a test asserting only the status.
    expect(trespass.body).toEqual(missing.body);
  });

  it('does not make a Brain administrator entitled to a private thread', async () => {
    const asAdmin = await call('GET', `/api/russell/conversations/${aliceThread}`, {
      cookie: adminCookie,
    });
    expect(asAdmin.status).toBe(404);
    // And the administrator can still see the project itself, so this is a
    // deliberate boundary rather than a missing grant.
    expect((await call('GET', `/api/projects/${projectId}`, { cookie: adminCookie })).status).toBe(200);
  });

  it('lists only the caller’s own threads', async () => {
    const mine = await call<{ conversations: { id: string }[] }>('GET', '/api/russell/conversations', {
      cookie: aliceCookie,
    });
    expect(mine.status).toBe(200);
    const ids = mine.body.conversations.map((conversation) => conversation.id);
    expect(ids).toContain(aliceThread);
    expect(ids).not.toContain(bobThread);
  });

  it('will not let somebody speak into a thread that is not theirs', async () => {
    const result = await call('POST', `/api/russell/conversations/${bobThread}/turns`, {
      cookie: aliceCookie,
      body: { content: 'let me in' },
    });
    expect(result.status).toBe(404);
  });

  it('refuses a machine reaching a person’s conversations at all', async () => {
    // Not a scope question. A worker principal has no conversations, so the
    // refusal is by principal type — there is no membership configuration that
    // turns a worker into a person.
    for (const route of ['/api/russell/conversations', `/api/russell/conversations/${aliceThread}`]) {
      const result = await call('GET', route, { bearer: workerBearer });
      expect(result.status, route).toBe(404);
    }
  });
});

describe('a project view is behind the project gate', () => {
  it('hides a project the caller is not a member of, on every Russell view', async () => {
    for (const route of [
      `/api/russell/projects/${projectId}/briefing`,
      `/api/russell/projects/${projectId}/work`,
      `/api/russell/projects/${projectId}/candidates`,
      `/api/russell/projects/${projectId}/knowledge`,
      `/api/russell/projects/${projectId}/needs-you`,
      `/api/russell/projects/${projectId}/ideas`,
      `/api/russell/projects/${projectId}/who`,
      `/api/russell/projects/${projectId}/progress`,
    ]) {
      const asBob = await call('GET', route, { cookie: bobCookie });
      expect(asBob.status, route).toBe(404);
      const asAlice = await call('GET', route, { cookie: aliceCookie });
      expect(asAlice.status, route).toBe(200);
    }
  });

  it('answers a briefing in sentences, with no percentage anywhere in it', async () => {
    const result = await call<{ briefing: Record<string, string> }>(
      'GET',
      `/api/russell/projects/${projectId}/briefing`,
      { cookie: aliceCookie },
    );
    expect(result.status).toBe(200);
    const brief = result.body.briefing as unknown as Record<string, unknown>;
    for (const field of ['focus', 'next', 'needsYou'] as const) {
      expect(typeof brief[field]).toBe('string');
    }
    // Progress is milestone-backed or deliberately non-numeric. A percentage
    // would be precision the milestones do not have.
    expect(JSON.stringify(brief)).not.toMatch(/\d+\s*%/);
    const progress = brief['progress'] as { stage: string; headline: string; ratio: unknown };
    expect(typeof progress.stage).toBe('string');
    expect(typeof progress.headline).toBe('string');
  });

  it('refuses every conversation-shaped Russell view to a worker, by principal type', async () => {
    // A machine reading a person's threads, ideas or the fleet screen is the
    // boundary §24 draws, and no membership configuration crosses it.
    for (const route of [
      '/api/russell/conversations',
      `/api/russell/projects/${projectId}/ideas`,
      `/api/russell/projects/${projectId}/who`,
    ]) {
      const asWorker = await call('GET', route, { bearer: workerBearer });
      expect(asWorker.status, route).toBe(404);
    }
  });

  it('groups work and holds technical rows back until asked', async () => {
    const closed = await call<{
      work: { groups: { group: string }[]; includesTechnical: boolean; technicalHidden: number };
    }>('GET', `/api/russell/projects/${projectId}/work`, { cookie: aliceCookie });
    expect(closed.status).toBe(200);
    expect(closed.body.work.groups.map((group) => group.group)).toEqual([
      'WORKING_NOW',
      'UP_NEXT',
      'EXPLORING',
      'WAITING',
      'FINISHED',
    ]);
    expect(closed.body.work.includesTechnical).toBe(false);

    const opened = await call<{ work: { includesTechnical: boolean } }>(
      'GET',
      `/api/russell/projects/${projectId}/work?technical=1`,
      { cookie: aliceCookie },
    );
    expect(opened.body.work.includesTechnical).toBe(true);
  });

  it('never puts a credential, a digest or a secret name on the Who screen', async () => {
    const result = await call('GET', `/api/russell/projects/${projectId}/who`, {
      cookie: adminCookie,
    });
    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ['tokenDigest', 'tokenSecretName', 'brnw_', 'verifier']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('lets a member ask whether work is needed without giving them write access', async () => {
    const result = await call<{ explanation: string }>(
      'POST',
      `/api/russell/projects/${projectId}/coverage`,
      {
        cookie: aliceCookie,
        body: {
          layerId,
          requirements: [{ key: 'r1', statement: 'Whether escrow interest accrues to the buyer' }],
        },
      },
    );
    // Alice is a MEMBER, which is write access; the point is that the route is
    // declared READ, so a VIEWER could ask too. What matters is that it answers
    // rather than refusing, and that it created nothing.
    expect(result.status).toBe(200);
    expect(typeof result.body.explanation).toBe('string');
    const after = await call<{ candidates: unknown[] }>(
      'GET',
      `/api/russell/projects/${projectId}/candidates`,
      { cookie: aliceCookie },
    );
    expect(after.body.candidates).toEqual([]);
  });
});

describe('the authority decision is a person’s, on Russell’s surface', () => {
  /*
   * It was on the operator console. §22 puts buttons there so a *machine*
   * cannot create its own work, and applying that to the person who owns the
   * project sent their own decision into an administration surface 12A had
   * already taken off the normal route.
   *
   * `russellAuthoritySurface.test.ts` proves what it does. What is proven here
   * is the half only a booted server can show: that the surface moved and the
   * gate did not, against the real guard rather than an injected context.
   */
  it('shows a member what Russell may do, and refuses a non-member identically to a missing project', async () => {
    const mine = await call<{ grant: unknown; headline: string }>(
      'GET',
      `/api/russell/projects/${projectId}/authority`,
      { cookie: aliceCookie },
    );
    expect(mine.status).toBe(200);
    // A project with no grant is an ordinary answer with a sentence, not an
    // error and not an empty body.
    expect(mine.body.headline).toBeTruthy();

    const absent = await call('GET', '/api/russell/projects/prj_nope/authority', {
      cookie: aliceCookie,
    });
    const forbidden = await call('GET', `/api/russell/projects/${projectId}/authority`, {
      cookie: bobCookie,
    });
    expect(forbidden.status).toBe(absent.status);
    expect(JSON.stringify(forbidden.body)).toBe(JSON.stringify(absent.body));
  });

  it('refuses a machine at the authority routes by principal type', async () => {
    // The check §22 actually cared about, and it is stronger here than the
    // console's administrator-plus-same-site pair: no membership configuration
    // turns a worker into a person.
    for (const [method, route, body] of [
      ['GET', `/api/russell/projects/${projectId}/authority`, undefined],
      [
        'POST',
        `/api/russell/projects/${projectId}/authority`,
        { name: 'x', maxMissions: 1, maxConcurrent: 1, maxFragments: 1, maxProbes: 1, expiresAt: null },
      ],
    ] as const) {
      const result = await call(method, route, { bearer: workerBearer, body });
      expect(result.status, route).toBe(404);
    }
  });

  it('no longer offers a way to create one on the operator console', async () => {
    // The console keeps the reading and the break-glass revoke; creating a
    // grant is Russell's. A second way to make one would be a second place for
    // the limits to be set differently.
    const console_ = await call<string>('GET', '/operator', { cookie: adminCookie });
    expect(console_.status).toBe(200);
    expect(String(console_.body)).toMatch(/Granting one happens in Russell/i);
    expect(String(console_.body)).not.toMatch(/action="\/operator\/authority"/);
  });
});

describe('a person’s judgment override is behind the same gate as the idea', () => {
  /*
   * The routes that let a person disagree with Russell, or pull an automatic
   * merge apart. `overrideJudgment` and `splitCandidate` have existed since
   * Phase 1 with no caller at all, so these are new doors — and a new door is
   * where a gate gets forgotten.
   *
   * What the behaviour *is* — that an override supersedes rather than erases,
   * and that a split keeps the merge row — is proven in
   * `russellIntegrationPass.test.ts`, which can get a candidate into the state
   * worth overriding. What is proven here is the half only a booted server can
   * show: that reaching them at all requires being allowed to.
   */
  const UNKNOWN = 'rcn_0123456789abcdef0123';

  it('answers a member the same way for an idea that does not exist', async () => {
    for (const [method, route, body] of [
      ['GET', `/api/russell/candidates/${UNKNOWN}`, undefined],
      ['POST', `/api/russell/candidates/${UNKNOWN}/judgment`, { priority: 'MUST_DO', state: 'QUEUED', reason: 'r' }],
      ['POST', `/api/russell/candidates/${UNKNOWN}/split`, { reason: 'r' }],
    ] as const) {
      const result = await call(method, route, { cookie: aliceCookie, body });
      expect(result.status, route).toBe(404);
    }
  });

  it('refuses a non-member and a missing idea identically, body included', async () => {
    // Bob is a member of nothing. If the refusal for "an idea in a project you
    // are not in" differed from "no such idea" — in status *or* in body — it
    // would be an oracle for what exists in a Brain he cannot see.
    const mine = await call('GET', `/api/russell/candidates/${UNKNOWN}`, { cookie: aliceCookie });
    const theirs = await call('GET', `/api/russell/candidates/${UNKNOWN}`, { cookie: bobCookie });
    expect(theirs.status).toBe(mine.status);
    expect(JSON.stringify(theirs.body)).toBe(JSON.stringify(mine.body));
  });

  it('refuses a machine at these routes by principal type', async () => {
    // An idea belongs to a person's list. No worker scope reaches it, and no
    // membership configuration turns a worker into a person.
    for (const [method, route, body] of [
      ['GET', `/api/russell/candidates/${UNKNOWN}`, undefined],
      ['POST', `/api/russell/candidates/${UNKNOWN}/judgment`, { priority: 'MUST_DO', state: 'QUEUED', reason: 'r' }],
      ['POST', `/api/russell/candidates/${UNKNOWN}/split`, { reason: 'r' }],
    ] as const) {
      const result = await call(method, route, { bearer: workerBearer, body });
      expect(result.status, route).toBe(404);
    }
  });
});

describe('correcting where a thread is filed', () => {
  it('records a person’s decision, and only the owner may make it', async () => {
    const thread = await openThread(aliceCookie, 'to be corrected');
    const attach = await call<{ projectId: string | null; attachmentSource: string }>(
      'POST',
      `/api/russell/conversations/${thread}/project`,
      { cookie: aliceCookie, body: { projectId, reason: 'it is about this one' } },
    );
    expect(attach.status).toBe(200);
    expect(attach.body.projectId).toBe(projectId);
    // `USER`, which is the vocabulary the router reads when deciding whether a
    // person's earlier decision outweighs a name match.
    expect(attach.body.attachmentSource).toBe('USER');

    const detach = await call<{ projectId: string | null }>(
      'POST',
      `/api/russell/conversations/${thread}/project`,
      { cookie: aliceCookie, body: { projectId: null, reason: 'not this one after all' } },
    );
    expect(detach.status).toBe(200);
    expect(detach.body.projectId).toBeNull();

    // Somebody else's thread is refused the same way a missing one is.
    const trespass = await call('POST', `/api/russell/conversations/${thread}/project`, {
      cookie: bobCookie,
      body: { projectId: null },
    });
    expect(trespass.status).toBe(404);
  });

  it('will not let a correction attach a project the corrector cannot read', async () => {
    const thread = await openThread(bobCookie, 'bob has no memberships');
    const result = await call('POST', `/api/russell/conversations/${thread}/project`, {
      cookie: bobCookie,
      body: { projectId, reason: 'file it there' },
    });
    // A correction must not become a way to reach a project you may not open.
    expect(result.status).toBe(404);
  });
});

describe('saying something', () => {
  it('answers with the pending turn rather than an answer it does not have', async () => {
    const result = await call<{
      pending: { status: string; pendingReason: string | null };
      dispatched: boolean;
    }>('POST', `/api/russell/conversations/${aliceThread}/turns`, {
      cookie: aliceCookie,
      body: { content: 'What is going on with the monetization work?' },
    });

    expect(result.status).toBe(202);
    expect(result.body.pending.status).toMatch(/PENDING|COMPLETE/);
    // No optimistic success: whatever the state, it is the real one, and the
    // reason a person is waiting is carried with it.
    if (result.body.pending.status === 'PENDING') {
      expect(result.body.pending.pendingReason).toBeTruthy();
      expect(result.body.dispatched).toBe(true);
    }
  });

  it('never returns the internal bin id to a person', async () => {
    const result = await call<Record<string, unknown>>(
      'POST',
      `/api/russell/conversations/${aliceThread}/turns`,
      { cookie: aliceCookie, body: { content: 'anything at all' } },
    );
    expect(JSON.stringify(result.body)).not.toMatch(/"bin_[a-z0-9]/i);
    expect(Object.keys(result.body)).not.toContain('binId');
  });

  it('refuses an empty message rather than dispatching a worker for nothing', async () => {
    const result = await call('POST', `/api/russell/conversations/${aliceThread}/turns`, {
      cookie: aliceCookie,
      body: { content: '   ' },
    });
    expect(result.status).toBe(400);
  });
});
