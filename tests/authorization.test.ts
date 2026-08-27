/**
 * The threat model, over HTTP, against the real server.
 *
 * `identity.test.ts` proves the decisions are right. This proves they are
 * actually reached — by every route, over a real socket, with real cookies and
 * real bearer tokens. The two can fail independently, and the interesting
 * failure is the one this file catches: a correct policy that some route
 * forgot to consult.
 *
 * Everything below is written as an attack rather than as a feature. The
 * question is never "does an authorized user get their data", which the API
 * suite already answers; it is "does anybody else".
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
import { createLayer } from '../server/repos/layers.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5600 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir: string;
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const ALICE_PASSWORD = 'alice-password-000001';
const BOB_PASSWORD = 'bob-password-00000001';
const VIEWER_PASSWORD = 'viewer-password-00001';

/** Cookies, by role. */
let adminCookie = '';
let aliceCookie = '';
let bobCookie = '';
let viewerCookie = '';

/** Ids discovered or created during setup. */
let projectA = '';
let projectB = '';
let projectASlug = '';
let projectBSlug = '';
let layerA = '';
let layerB = '';
let aliceId = '';
let bobId = '';
let viewerId = '';
let workerId = '';
let workerCredential = '';
let workerCredentialId = '';

interface Result<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; bearer?: string; body?: unknown; origin?: string } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.origin) headers.origin = options.origin;
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
    /* keep the text */
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in for ${email} failed: ${response.status} ${await response.text()}`);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (!cookie) throw new Error(`sign-in for ${email} returned no cookie`);
  return cookie;
}

/** Create a person through the administrative API, then give them their own password. */
async function makePerson(
  email: string,
  displayName: string,
  password: string,
): Promise<{ id: string; cookie: string }> {
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName, password: 'temporary-password-01' },
  });
  if (created.status !== 200) throw new Error(`could not create ${email}: ${JSON.stringify(created.body)}`);

  const firstCookie = await signIn(email, 'temporary-password-01');
  const changed = await call('POST', '/api/auth/password', {
    cookie: firstCookie,
    body: { currentPassword: 'temporary-password-01', newPassword: password },
  });
  if (changed.status !== 200) throw new Error(`could not set a password for ${email}`);
  return { id: created.body.user.id, cookie: await signIn(email, password) };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-authz-'));
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
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
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

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  // A second project, so "may not see it" has something to be about. Created
  // straight in the database the server is using, because there is no
  // create-project route and inventing one for a test would be inventing
  // surface area.
  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  const seeded = await call<{ projects: { id: string; slug: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  projectA = seeded.body.projects[0]!.id;
  projectASlug = seeded.body.projects[0]!.slug;
  const other = await createProject({ name: 'Somebody Elses Project' });
  projectB = other.id;
  projectBSlug = other.slug;
  const otherLayer = await createLayer({
    projectId: projectB,
    name: 'Their Layer',
    orderIndex: 1,
  });
  layerB = otherLayer.id;
  await closeDatabase();

  const detail = await call<{ layers: { id: string }[] }>('GET', `/api/projects/${projectA}`, {
    cookie: adminCookie,
  });
  layerA = detail.body.layers[0]!.id;

  const alice = await makePerson('alice@example.invalid', 'Alice', ALICE_PASSWORD);
  aliceId = alice.id;
  aliceCookie = alice.cookie;
  const bob = await makePerson('bob@example.invalid', 'Bob', BOB_PASSWORD);
  bobId = bob.id;
  bobCookie = bob.cookie;
  const viewer = await makePerson('viewer@example.invalid', 'Viewer', VIEWER_PASSWORD);
  viewerId = viewer.id;
  viewerCookie = viewer.cookie;

  // Alice writes in project A. Bob owns project B. The viewer only reads A.
  const grant = async (project: string, principalId: string, body: Record<string, unknown>) => {
    const result = await call('POST', `/api/admin/projects/${project}/members`, {
      cookie: adminCookie,
      body: { principalId, ...body },
    });
    if (result.status !== 200) {
      throw new Error(`grant failed (${result.status}): ${JSON.stringify(result.body)}`);
    }
  };
  await grant(projectA, aliceId, { principalType: 'HUMAN', role: 'MEMBER' });
  await grant(projectB, bobId, { principalType: 'HUMAN', role: 'OWNER' });
  await grant(projectA, viewerId, { principalType: 'HUMAN', role: 'VIEWER' });

  // One worker, with the two scopes it is expected to have and nothing else.
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'test-runner', displayName: 'Test Runner' },
  });
  workerId = worker.body.worker.id;
  await grant(projectA, workerId, {
    principalType: 'WORKER',
    scopes: ['project:read', 'research:read'],
  });
  const issued = await call<{ secret: string; credential: { id: string } }>(
    'POST',
    `/api/admin/workers/${workerId}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerCredential = issued.body.secret;
  workerCredentialId = issued.body.credential.id;
}, 90_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('a caller with no credentials', () => {
  it('is refused every route that says anything about this Brain', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/health'],
      ['GET', '/api/projects'],
      ['GET', `/api/projects/${projectA}`],
      ['GET', `/api/projects/${projectA}/plan`],
      ['GET', `/api/layers/${layerA}`],
      ['GET', `/api/projects/${projectA}/documents`],
      ['GET', `/api/projects/${projectA}/events`],
      ['GET', '/api/providers'],
      ['GET', '/api/admin/users'],
      ['POST', `/api/projects/${projectA}/recompute`],
      ['GET', '/api/research/readiness'],
      ['GET', `/api/research/orc_anything/stream`],
      ['GET', `/files/${projectASlug}/documents/anything.pdf`],
    ];
    for (const [method, route] of routes) {
      const result = await call(method, route);
      expect(result.status, `${method} ${route}`).toBe(401);
      expect(JSON.stringify(result.body), route).not.toContain('Deal Dispatch');
    }
  });

  it('can still reach liveness, and learns nothing from it', async () => {
    const response = await fetch(`${BASE}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('ok');
    expect(body).not.toMatch(/postgres|supabase|brain|version/i);
  });

  it('is told the same thing whatever it got wrong', async () => {
    const noSuchUser = await call('POST', '/api/auth/login', {
      body: { email: 'nobody@example.invalid', password: 'whatever-it-is-01' },
    });
    const wrongPassword = await call('POST', '/api/auth/login', {
      body: { email: 'alice@example.invalid', password: 'not-alices-password' },
    });
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(JSON.stringify(noSuchUser.body)).toBe(JSON.stringify(wrongPassword.body));
  });
});

describe('a credential in the wrong place', () => {
  it('is refused in a query string rather than accepted', async () => {
    const result = await call('GET', `/api/projects?token=${encodeURIComponent(workerCredential)}`, {
      cookie: adminCookie,
    });
    // Even with a perfectly good cookie: the presence of a credential in the URL
    // is itself the problem, because that is what ends up in logs and referers.
    expect(result.status).toBe(401);
  });

  it('is refused when it is malformed, expired-looking or simply invented', async () => {
    for (const bearer of [
      'not-a-credential',
      'brnw_deadbeefdeadbeef.invented-secret-value',
      `${workerCredential}x`,
      workerCredential.slice(0, -1),
      workerCredential.replace('brnw_', 'brnx_'),
    ]) {
      const result = await call('GET', `/api/projects/${projectA}`, { bearer });
      expect(result.status, bearer.slice(0, 20)).toBe(401);
    }
  });
});

describe('one person, one project', () => {
  it('lets Alice work in hers', async () => {
    const detail = await call<{ project: { id: string } }>('GET', `/api/projects/${projectA}`, {
      cookie: aliceCookie,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.project.id).toBe(projectA);

    const recompute = await call('POST', `/api/projects/${projectA}/recompute`, {
      cookie: aliceCookie,
    });
    expect(recompute.status).toBe(200);
  });

  it('tells her the other one does not exist', async () => {
    const detail = await call<{ error: string }>('GET', `/api/projects/${projectB}`, {
      cookie: aliceCookie,
    });
    expect(detail.status).toBe(404);
    // Not 403. A distinguishable refusal is an oracle: it confirms the id is
    // real, which is the one thing guessing was trying to establish.
    expect(detail.body.error).not.toMatch(/forbidden|not allowed|permission/i);
  });

  it('hides it from the listing rather than refusing the listing', async () => {
    const mine = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
      cookie: aliceCookie,
    });
    expect(mine.status).toBe(200);
    expect(mine.body.projects.map((p) => p.id)).toEqual([projectA]);

    const bobs = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
      cookie: bobCookie,
    });
    expect(bobs.body.projects.map((p) => p.id)).toEqual([projectB]);

    // The count itself is information, and neither of them learns the other's.
    expect(mine.body.projects).toHaveLength(1);
    expect(bobs.body.projects).toHaveLength(1);
  });

  it('refuses a nested resource that belongs to somebody else', async () => {
    // A layer id with no project anywhere in the path — the direct-object case.
    const layer = await call('GET', `/api/layers/${layerB}`, { cookie: aliceCookie });
    expect(layer.status).toBe(404);

    // And the same id is fine for the person who owns it, which is what makes
    // the refusal above about authorization rather than about a broken id.
    const forBob = await call('GET', `/api/layers/${layerB}`, { cookie: bobCookie });
    expect(forBob.status).toBe(200);
  });

  it('refuses document bytes from another project even by direct path', async () => {
    const stolen = await call('GET', `/files/${projectBSlug}/documents/anything.pdf`, {
      cookie: aliceCookie,
    });
    expect(stolen.status).toBe(404);
  });

  it('cannot be talked into acting as somebody else', async () => {
    // Every shape of "I am really Bob" the API offers: a body field, a header,
    // a query parameter. None of them contributes to the principal.
    const attempts = [
      call('GET', `/api/projects/${projectB}`, { cookie: aliceCookie, body: undefined }),
      call('POST', `/api/projects/${projectB}/recompute`, {
        cookie: aliceCookie,
        body: { userId: bobId, principalId: bobId, projectId: projectA },
      }),
      call('GET', `/api/projects/${projectB}?principalId=${bobId}`, { cookie: aliceCookie }),
    ];
    for (const attempt of attempts) {
      expect((await attempt).status).toBe(404);
    }
  });
});

describe('a reader who is only a reader', () => {
  it('reads', async () => {
    const detail = await call('GET', `/api/projects/${projectA}`, { cookie: viewerCookie });
    expect(detail.status).toBe(200);
  });

  it('cannot change anything', async () => {
    const mutations: [string, string, unknown][] = [
      ['POST', `/api/projects/${projectA}/recompute`, undefined],
      ['POST', `/api/projects/${projectA}/reconcile`, undefined],
      ['PATCH', `/api/layers/${layerA}`, { notes: 'mine now' }],
      ['POST', `/api/layers/${layerA}/freeze`, {}],
    ];
    for (const [method, route, body] of mutations) {
      const result = await call(method, route, { cookie: viewerCookie, body });
      expect(result.status, `${method} ${route}`).toBe(404);
    }
  });

  it('cannot administer the project it can read', async () => {
    const patched = await call('PATCH', `/api/projects/${projectA}`, {
      cookie: viewerCookie,
      body: { name: 'Renamed' },
    });
    expect(patched.status).toBe(404);
  });
});

describe('a project member is not an administrator', () => {
  it('cannot reach the identity surface', async () => {
    for (const cookie of [aliceCookie, bobCookie, viewerCookie]) {
      expect((await call('GET', '/api/admin/users', { cookie })).status).toBe(404);
      expect((await call('GET', '/api/admin/workers', { cookie })).status).toBe(404);
      expect(
        (await call('POST', '/api/admin/workers', { cookie, body: { name: 'mine' } })).status,
      ).toBe(404);
    }
  });

  it('cannot turn on paid overages for the whole installation', async () => {
    const result = await call('POST', '/api/providers/connections/antigravity/paid-overage', {
      cookie: aliceCookie,
      body: { enabled: true },
    });
    expect(result.status).toBe(404);
  });

  it('cannot administer a project it merely owns elsewhere', async () => {
    // Bob owns B. That grants him nothing at all about A.
    const patched = await call('PATCH', `/api/projects/${projectA}`, {
      cookie: bobCookie,
      body: { name: 'Bobs Now' },
    });
    expect(patched.status).toBe(404);
  });

  it('sees a health report with nothing about the installation in it', async () => {
    const asMember = await call<Record<string, unknown>>('GET', '/api/health', {
      cookie: aliceCookie,
    });
    expect(asMember.status).toBe(200);
    expect(asMember.body.databasePath).toBeUndefined();
    expect(asMember.body.dataRoot).toBeUndefined();
    expect(asMember.body.driver).toBeUndefined();

    const asAdmin = await call<Record<string, unknown>>('GET', '/api/health', {
      cookie: adminCookie,
    });
    expect(asAdmin.body.databasePath).toBeDefined();
  });
});

describe('a worker', () => {
  it('is recognised as itself, and reads what its scopes allow', async () => {
    const me = await call<{ principal: { type: string; handle: string } }>('GET', '/api/auth/me', {
      bearer: workerCredential,
    });
    expect(me.status).toBe(200);
    expect(me.body.principal.type).toBe('WORKER');
    expect(me.body.principal.handle).toBe('test-runner');

    const project = await call('GET', `/api/projects/${projectA}`, { bearer: workerCredential });
    expect(project.status).toBe(200);
  });

  it('is refused a scope it was not given', async () => {
    // It holds project:read and research:read. Not documents:read.
    const documents = await call('GET', `/files/${projectASlug}/documents/anything.pdf`, {
      bearer: workerCredential,
    });
    expect(documents.status).toBe(404);
  });

  it('cannot write anything, because no write scope names a route it holds', async () => {
    const result = await call('POST', `/api/projects/${projectA}/recompute`, {
      bearer: workerCredential,
    });
    expect(result.status).toBe(404);
  });

  it('cannot administer, whatever it is asked', async () => {
    expect((await call('GET', '/api/admin/users', { bearer: workerCredential })).status).toBe(404);
    expect(
      (await call('PATCH', `/api/projects/${projectA}`, {
        bearer: workerCredential,
        body: { name: 'x' },
      })).status,
    ).toBe(404);
  });

  it('is refused a project it was never granted', async () => {
    expect((await call('GET', `/api/projects/${projectB}`, { bearer: workerCredential })).status).toBe(
      404,
    );
  });
});

describe('revocation takes effect now, not at the next sign-in', () => {
  it('for a membership', async () => {
    const spare = await makePerson('spare@example.invalid', 'Spare', 'spare-password-000001');
    await call('POST', `/api/admin/projects/${projectA}/members`, {
      cookie: adminCookie,
      body: { principalType: 'HUMAN', principalId: spare.id, role: 'MEMBER' },
    });
    expect((await call('GET', `/api/projects/${projectA}`, { cookie: spare.cookie })).status).toBe(
      200,
    );

    await call('DELETE', `/api/admin/projects/${projectA}/members/HUMAN/${spare.id}`, {
      cookie: adminCookie,
    });

    // Same cookie, same session, no new sign-in anywhere.
    expect((await call('GET', `/api/projects/${projectA}`, { cookie: spare.cookie })).status).toBe(
      404,
    );
  });

  it('for a worker credential', async () => {
    const second = await call<{ secret: string; credential: { id: string } }>(
      'POST',
      `/api/admin/workers/${workerId}/credentials`,
      { cookie: adminCookie, body: {} },
    );
    expect((await call('GET', '/api/auth/me', { bearer: second.body.secret })).status).toBe(200);

    await call('POST', `/api/admin/workers/${workerId}/credentials/${second.body.credential.id}/revoke`, {
      cookie: adminCookie,
    });
    expect((await call('GET', '/api/auth/me', { bearer: second.body.secret })).status).toBe(401);
    // And the original one still works: revoking one is not revoking all.
    expect((await call('GET', '/api/auth/me', { bearer: workerCredential })).status).toBe(200);
  });

  it('for a whole worker, even with a credential that was never revoked', async () => {
    const created = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
      cookie: adminCookie,
      body: { name: 'doomed-worker' },
    });
    const doomedId = created.body.worker.id;
    const issued = await call<{ secret: string }>('POST', `/api/admin/workers/${doomedId}/credentials`, {
      cookie: adminCookie,
      body: {},
    });
    expect((await call('GET', '/api/auth/me', { bearer: issued.body.secret })).status).toBe(200);

    await call('POST', `/api/admin/workers/${doomedId}/disabled`, {
      cookie: adminCookie,
      body: { disabled: true },
    });
    expect((await call('GET', '/api/auth/me', { bearer: issued.body.secret })).status).toBe(401);
  });

  it('for a person, mid-session', async () => {
    const doomed = await makePerson('doomed@example.invalid', 'Doomed', 'doomed-password-00001');
    expect((await call('GET', '/api/auth/me', { cookie: doomed.cookie })).status).toBe(200);

    await call('POST', `/api/admin/users/${doomed.id}/disabled`, {
      cookie: adminCookie,
      body: { disabled: true },
    });
    expect((await call('GET', '/api/auth/me', { cookie: doomed.cookie })).status).toBe(401);
    // And they cannot simply sign in again.
    const retry = await call('POST', '/api/auth/login', {
      body: { email: 'doomed@example.invalid', password: 'doomed-password-00001' },
    });
    expect(retry.status).toBe(401);
  });
});

describe('credentials never come back', () => {
  it('are shown once and are absent from every listing afterwards', async () => {
    const listed = await call<{ workers: { credentials: unknown[] }[] }>('GET', '/api/admin/workers', {
      cookie: adminCookie,
    });
    expect(listed.status).toBe(200);
    const dump = JSON.stringify(listed.body);
    expect(dump).not.toContain(workerCredential);
    expect(dump).not.toContain(workerCredential.split('.')[1]);
    // The prefix is there, because it is how a person recognises which is which.
    expect(dump).toContain(workerCredential.split('.')[0]);
  });

  it('are absent from the identity audit', async () => {
    const events = await call<{ events: unknown[] }>('GET', '/api/admin/identity-events?limit=500', {
      cookie: adminCookie,
    });
    expect(events.status).toBe(200);
    const dump = JSON.stringify(events.body);
    expect(dump).not.toContain(workerCredential);
    expect(dump).not.toContain(ADMIN_PASSWORD);
    expect(dump).not.toContain(ALICE_PASSWORD);
    expect(dump).not.toContain(BOOTSTRAP_PASSWORD);
  });

  it('are absent from everything the server has printed', () => {
    expect(serverLog).not.toContain(workerCredential);
    expect(serverLog).not.toContain(ADMIN_PASSWORD);
    expect(serverLog).not.toContain(BOOTSTRAP_PASSWORD);
    expect(serverLog).not.toContain(ALICE_PASSWORD);
  });

  it('rotate without either credential being invalid at the same moment', async () => {
    const rotated = await call<{ secret: string; credential: { id: string; rotatedFrom: string } }>(
      'POST',
      `/api/admin/workers/${workerId}/credentials`,
      { cookie: adminCookie, body: { rotatedFrom: workerCredentialId, revokeAfter: true } },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.credential.rotatedFrom).toBe(workerCredentialId);
    // The new one works and the old one is now refused — in that order, which is
    // what a rotation has to mean for a worker that is mid-job.
    expect((await call('GET', '/api/auth/me', { bearer: rotated.body.secret })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { bearer: workerCredential })).status).toBe(401);
    workerCredential = rotated.body.secret;
    workerCredentialId = rotated.body.credential.id;
  });
});

describe('the last administrator', () => {
  it('cannot be disabled while they are the last one', async () => {
    const users = await call<{ users: { id: string; email: string; isBrainAdmin: boolean }[] }>(
      'GET',
      '/api/admin/users',
      { cookie: adminCookie },
    );
    const admins = users.body.users.filter((user) => user.isBrainAdmin);
    expect(admins).toHaveLength(1);

    const refused = await call<{ error: string }>(
      'POST',
      `/api/admin/users/${admins[0]!.id}/disabled`,
      { cookie: adminCookie, body: { disabled: true } },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/last enabled Brain administrator/i);

    // And is still able to administer, which is the point of refusing.
    expect((await call('GET', '/api/admin/users', { cookie: adminCookie })).status).toBe(200);
  });
});

describe('cross-site request forgery', () => {
  it('refuses a cookie-authenticated mutation carrying somebody else’s origin', async () => {
    const forged = await call('POST', `/api/projects/${projectA}/recompute`, {
      cookie: aliceCookie,
      origin: 'https://not-this-brain.example',
    });
    expect(forged.status).toBe(403);
  });

  it('allows one from this origin', async () => {
    const legitimate = await call('POST', `/api/projects/${projectA}/recompute`, {
      cookie: aliceCookie,
      origin: BASE,
    });
    expect(legitimate.status).toBe(200);
  });

  it('does not apply it to bearer credentials, which no browser sends by itself', async () => {
    const result = await call('GET', '/api/auth/me', {
      bearer: workerCredential,
      origin: 'https://not-this-brain.example',
    });
    expect(result.status).toBe(200);
  });
});

describe('a temporary password is temporary', () => {
  it('blocks everything except changing it', async () => {
    await call('POST', '/api/admin/users', {
      cookie: adminCookie,
      body: { email: 'fresh@example.invalid', displayName: 'Fresh', password: 'issued-password-01' },
    });
    const cookie = await signIn('fresh@example.invalid', 'issued-password-01');

    const blocked = await call<{ code: string }>('GET', `/api/projects/${projectA}`, { cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await call('POST', '/api/auth/password', {
      cookie,
      body: { currentPassword: 'issued-password-01', newPassword: 'chosen-password-0001' },
    });
    expect(changed.status).toBe(200);

    // Still not a member of anything, so still 404 — but no longer 403, which is
    // the difference between "cannot yet" and "may not".
    const after = await call('GET', `/api/projects/${projectA}`, { cookie });
    expect(after.status).toBe(404);
  });
});

describe('signing out', () => {
  it('ends that session and no other', async () => {
    const first = await signIn('alice@example.invalid', ALICE_PASSWORD);
    const second = await signIn('alice@example.invalid', ALICE_PASSWORD);

    await call('POST', '/api/auth/logout', { cookie: first });

    expect((await call('GET', '/api/auth/me', { cookie: first })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { cookie: second })).status).toBe(200);
  });
});

/**
 * The client's first call on every page load, and the one that decides whether
 * a person sees their Brain or a sign-in form.
 *
 * It was exempt from the guard entirely, which is not the same exemption it
 * needed. Authentication never ran for it, so it answered `authenticated:
 * false` to a valid cookie every time, and a signed-in person was shown the
 * sign-in form again on every refresh. Nothing in the suite noticed, because
 * every other test authenticates by sending a cookie to a route that requires
 * one — this is the only route that must accept both answers.
 */
describe('asking who I am', () => {
  it('recognises a valid session', async () => {
    const cookie = await signIn('alice@example.invalid', ALICE_PASSWORD);
    const session = await call<{ authenticated: boolean; user: { email: string } | null }>(
      'GET',
      '/api/auth/session',
      { cookie },
    );
    expect(session.status).toBe(200);
    expect(session.body.authenticated).toBe(true);
    expect(session.body.user?.email).toBe('alice@example.invalid');
  });

  it('answers without refusing when there is no credential at all', async () => {
    const session = await call<{ authenticated: boolean; user: unknown }>(
      'GET',
      '/api/auth/session',
    );
    expect(session.status).toBe(200);
    expect(session.body.authenticated).toBe(false);
    expect(session.body.user).toBeNull();
  });

  it('answers without refusing when the credential is stale', async () => {
    const cookie = await signIn('alice@example.invalid', ALICE_PASSWORD);
    await call('POST', '/api/auth/logout', { cookie });

    const session = await call<{ authenticated: boolean }>('GET', '/api/auth/session', { cookie });
    expect(session.status).toBe(200);
    expect(session.body.authenticated).toBe(false);
  });

  // A worker is a principal, but it is not a person, and the client's sign-in
  // decision must not be reachable by one.
  it('does not report a worker as a signed-in person', async () => {
    const session = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      bearer: workerCredential,
    });
    expect(session.body.authenticated).toBe(false);
  });
});
