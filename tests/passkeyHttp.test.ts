/**
 * The passkey door, over a real socket.
 *
 * The service tests prove the decisions. This proves the routes are behind the
 * guard that is supposed to let them through and the guards that are supposed
 * to stop them — which is the level where the interesting failures live. A
 * correct enrollment service reachable only by somebody already signed in
 * protects nobody; an administrator-only member list that any signed-in person
 * can read protects nobody either.
 *
 * Three things get the most attention.
 *
 * **The five unauthenticated paths are exactly five.** Enrollment and passkey
 * sign-in must be reachable by somebody holding no credential — that is the
 * whole journey — and nothing else new may be.
 *
 * **The activation gate is a route, not a disabled button.** §17's rule that a
 * hidden control is not authorization, at the one click the readiness count
 * exists for.
 *
 * **A refusal is one body.** Absent, expired, spent and fabricated are
 * byte-identical, because the difference between them is an oracle.
 *
 * It is driven at `localhost` rather than `127.0.0.1` on purpose: WebAuthn binds
 * a credential to an origin, and `relyingPartyFrom` refuses anything that is
 * neither https nor localhost — so a suite that used the address would be
 * testing the refusal rather than the journey.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { authenticator } from './helpers/authenticator.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(7200, 100);
const BASE = `http://localhost:${PORT}`;
const RP_ID = 'localhost';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const PLAIN_PASSWORD = 'ordinary-password-00001';

let adminCookie = '';
let plainCookie = '';

interface Result<T = unknown> {
  status: number;
  body: T;
  text: string;
  cookie: string;
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
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
  return {
    status: response.status,
    body: body as T,
    text,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
  };
}

async function signIn(email: string, password: string): Promise<string> {
  const result = await call('POST', '/api/auth/login', { body: { email, password } });
  if (result.status !== 200) throw new Error(`sign-in for ${email} failed: ${result.status}`);
  return result.cookie;
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

/** Create a slot and carry its link the way an administrator would. */
async function newSlot(displayName: string): Promise<{ token: string; userId: string; id: string }> {
  const created = await call<{ enrollment: { token: string; userId: string; enrollmentId: string } }>(
    'POST',
    '/api/members',
    { cookie: adminCookie, body: { displayName } },
  );
  expect(created.status).toBe(200);
  return {
    token: created.body.enrollment.token,
    userId: created.body.enrollment.userId,
    id: created.body.enrollment.enrollmentId,
  };
}

/** The browser half of an enrollment: options, create, complete. */
async function enrol(token: string, credentialId: string) {
  const options = await call<{ challenge: string }>('POST', '/api/enroll/options', {
    body: { token },
  });
  expect(options.status).toBe(200);
  const device = authenticator({ rpId: RP_ID, credentialId });
  const made = device.register(options.body.challenge, { origin: BASE });
  const done = await call<{ user: { id: string } }>('POST', '/api/enroll/complete', {
    body: { token, challenge: options.body.challenge, ...made, label: 'A phone' },
  });
  return { done, device };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-passkey-'));
  await startServer();

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  /*
   * An ordinary signed-in person with no Brain administration.
   *
   * Their password is changed before anything else: an account created by an
   * administrator carries `must_change_password`, and the guard answers 403 to
   * everything until it is cleared — which would make every refusal below pass
   * for the wrong reason.
   */
  await call('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: {
      email: 'ordinary@example.invalid',
      displayName: 'Ordinary',
      password: 'temporary-password-01',
    },
  });
  const firstCookie = await signIn('ordinary@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: firstCookie,
    body: { currentPassword: 'temporary-password-01', newPassword: PLAIN_PASSWORD },
  });
  plainCookie = await signIn('ordinary@example.invalid', PLAIN_PASSWORD);
  const proof = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
    cookie: plainCookie,
  });
  if (!proof.body.authenticated) throw new Error('the ordinary person never became usable');
}, 120_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('what an uninvited caller can reach', () => {
  it('lets the three enrollment routes and the two sign-in routes through the guard', async () => {
    /*
     * "Through the guard" is not "not 401": `/auth/passkey/verify` answers 401
     * itself when an assertion does not check out, and the two would be
     * indistinguishable by status. What separates them is the body — the guard
     * says `Not authorized.` and a route that ran says its own sentence — so
     * that is what is asserted.
     */
    for (const route of [
      '/api/enroll/preview',
      '/api/enroll/options',
      '/api/enroll/complete',
      '/api/auth/passkey/options',
      '/api/auth/passkey/verify',
    ]) {
      const result = await call<{ error?: string }>('POST', route, {
        body: { token: 'inv_nope_000000000000' },
      });
      expect(result.body?.error, `${route} was refused by the guard`).not.toBe('Not authorized.');
    }
  });

  it('reaches nothing else new without a credential', async () => {
    for (const [method, route] of [
      ['GET', '/api/members'],
      ['POST', '/api/members'],
      ['GET', '/api/me/passkeys'],
      ['POST', '/api/me/passkeys/options'],
      ['POST', '/api/cash/activate'],
    ] as const) {
      const result = await call<{ error?: string }>(
        method,
        route,
        method === 'GET' ? {} : { body: {} },
      );
      expect(result.status, `${method} ${route} answered ${result.status}`).toBe(401);
      expect(result.body?.error).toBe('Not authorized.');
    }
  });

  it('answers a fabricated link exactly as it answers a real one that is gone', async () => {
    const withdrawn = await newSlot('Withdrawn person');
    await call('POST', `/api/members/enrollments/${withdrawn.id}/revoke`, {
      cookie: adminCookie,
      body: { reason: 'Sent to the wrong address.' },
    });

    const fabricated = await call('POST', '/api/enroll/preview', {
      body: { token: 'inv_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    const gone = await call('POST', '/api/enroll/preview', { body: { token: withdrawn.token } });
    expect(fabricated.status).toBe(gone.status);
    // The same *body*, not only the same status: a status that matches while
    // the body differs is still an oracle.
    expect(fabricated.text).toBe(gone.text);
  });
});

describe('the whole journey, as the person takes it', () => {
  it('opens the link, sees their name, registers a device and is signed in', async () => {
    const slot = await newSlot('Second person');

    const preview = await call<{ displayName: string }>('POST', '/api/enroll/preview', {
      body: { token: slot.token },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.displayName).toBe('Second person');

    const { done, device } = await enrol(slot.token, 'journey-device-00000');
    expect(done.status).toBe(200);
    expect(done.body.user.id).toBe(slot.userId);
    // Enrollment ends inside the Brain, not at a second sign-in screen.
    expect(done.cookie).toMatch(/^[^=]+=/);

    const session = await call<{ authenticated: boolean; user: { displayName: string; email: string | null } }>(
      'GET',
      '/api/auth/session',
      { cookie: done.cookie },
    );
    expect(session.body.authenticated).toBe(true);
    expect(session.body.user.displayName).toBe('Second person');
    expect(session.body.user.email).toBeNull();

    // Their own devices, listed to them.
    const mine = await call<{ passkeys: { label: string; originKind: string }[] }>(
      'GET',
      '/api/me/passkeys',
      { cookie: done.cookie },
    );
    expect(mine.body.passkeys).toHaveLength(1);
    expect(mine.body.passkeys[0]!.originKind).toBe('ENROLLMENT');

    // And the same device signs them in again from a cold browser.
    const options = await call<{ challenge: string }>('POST', '/api/auth/passkey/options');
    const assertion = device.assert(options.body.challenge, { origin: BASE, signCount: 1 });
    const verified = await call<{ user: { id: string } }>('POST', '/api/auth/passkey/verify', {
      body: { credentialId: device.credentialId, challenge: options.body.challenge, ...assertion },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.user.id).toBe(slot.userId);
    expect(verified.cookie).not.toBe('');
  });

  it('refuses a replayed assertion, because the challenge is spent', async () => {
    const slot = await newSlot('Replay person');
    const { device } = await enrol(slot.token, 'replay-device-000000');

    const options = await call<{ challenge: string }>('POST', '/api/auth/passkey/options');
    const assertion = device.assert(options.body.challenge, { origin: BASE, signCount: 1 });
    const body = { credentialId: device.credentialId, challenge: options.body.challenge, ...assertion };

    expect((await call('POST', '/api/auth/passkey/verify', { body })).status).toBe(200);
    const second = await call('POST', '/api/auth/passkey/verify', { body });
    expect(second.status).toBe(401);
  });

  it('will not let somebody revoke their only device', async () => {
    const slot = await newSlot('Only-device person');
    const { done } = await enrol(slot.token, 'only-device-0000000');
    const mine = await call<{ passkeys: { id: string }[] }>('GET', '/api/me/passkeys', {
      cookie: done.cookie,
    });
    const revoked = await call<{ error: string }>(
      'POST',
      `/api/me/passkeys/${mine.body.passkeys[0]!.id}/revoke`,
      { cookie: done.cookie, body: { reason: 'Changing phones.' } },
    );
    expect(revoked.status).toBe(422);
    expect(revoked.body.error).toMatch(/only registered device/i);
  });

  it('gives somebody else\'s passkey the answer a missing one gives', async () => {
    const mine = await newSlot('Owner of a device');
    const { done } = await enrol(mine.token, 'theirs-device-000000');
    const listed = await call<{ passkeys: { id: string }[] }>('GET', '/api/me/passkeys', {
      cookie: done.cookie,
    });

    const nosy = await call('POST', `/api/me/passkeys/${listed.body.passkeys[0]!.id}/revoke`, {
      cookie: plainCookie,
      body: { reason: 'Curious.' },
    });
    const invented = await call('POST', '/api/me/passkeys/pky_does_not_exist/revoke', {
      cookie: plainCookie,
      body: { reason: 'Curious.' },
    });
    expect(nosy.status).toBe(404);
    expect(nosy.text).toBe(invented.text);
  });
});

describe('administering members', () => {
  it('belongs to a Brain administrator, and an ordinary member gets nothing', async () => {
    const listed = await call('GET', '/api/members', { cookie: plainCookie });
    const created = await call('POST', '/api/members', {
      cookie: plainCookie,
      body: { displayName: 'Somebody I invited myself' },
    });
    /*
     * 404, not 403. Invariant 23: a resource somebody may not have is reported
     * as one that does not exist, so a person who is not a Brain administrator
     * cannot learn from the refusal that there is anything here to administer.
     */
    expect(listed.status).toBe(404);
    expect(created.status).toBe(404);
    expect(listed.text).toBe(created.text);
  });

  it('shows the administrator link states without ever showing a token', async () => {
    const slot = await newSlot('Listed person');
    const listing = await call<{ links: { id: string; state: string }[] }>('GET', '/api/members', {
      cookie: adminCookie,
    });
    expect(listing.status).toBe(200);
    expect(listing.body.links.find((one) => one.id === slot.id)?.state).toBe('LIVE');
    expect(listing.text).not.toContain(slot.token);
  });
});

describe('starting Cash Mode below four of four', () => {
  /*
   * The readiness count no longer gates activation. It was the owner's
   * decision to wait for everybody rather than a property of the system, and
   * it has been withdrawn — so what this proves is the narrow thing that
   * changed and the wide thing that did not.
   *
   * The wide thing matters more: removing a gate is exactly the change that
   * quietly removes its neighbours, because they sit in the same handler. So
   * every other refusal on this route is asserted *while the counts are still
   * short*, which is the only state in which a leftover readiness check could
   * hide behind a different one.
   */

  it('still refuses an unauthenticated caller, and a person who is not a Brain administrator', async () => {
    const anonymous = await call<{ error?: string }>('POST', '/api/cash/activate', { body: {} });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body?.error).toBe('Not authorized.');

    /*
     * 404 rather than 403: invariant 23, unchanged. `requireBrainAdmin` is what
     * produces it, and it sits above the readiness check that was removed — so
     * this is the assertion that the removal did not take the guard above it
     * along. It is compared against the *other* administrator-only route rather
     * than against a path that does not exist, because a missing route names
     * the path it could not find; what must match here is the refusal a person
     * without administration gets, wherever they meet it.
     */
    const ordinary = await call<{ error?: string }>('POST', '/api/cash/activate', {
      cookie: plainCookie,
      body: {},
    });
    const elsewhere = await call<{ error?: string }>('GET', '/api/members', {
      cookie: plainCookie,
    });
    expect(ordinary.status).toBe(404);
    expect(elsewhere.status).toBe(404);
    expect(ordinary.text).toBe(elsewhere.text);

    // And none of those refusals created anything.
    const after = await call<{ mode: unknown }>('GET', '/api/cash/mode', { cookie: adminCookie });
    expect(after.body.mode).toBeNull();
  });

  it('lets a Brain administrator start it while the counts are short', async () => {
    /*
     * The four-of-four count was the owner's decision to wait for everybody
     * rather than a property of the system, and §32 withdrew the lock. What
     * went with it, one change later, is the *reading* from this route: who has
     * joined and how many surfaces can be fired are true of the whole Brain
     * rather than of a sprint, so they are on People & capacity and this
     * payload no longer carries them.
     *
     * That absence is asserted, because a route that still sent a count nothing
     * reads is a count that would eventually be believed by something.
     */
    const before = await call<{ mode: unknown; readiness?: unknown }>('GET', '/api/cash/mode', {
      cookie: adminCookie,
    });
    expect(before.status).toBe(200);
    expect(before.body.mode).toBeNull();
    expect(before.body.readiness).toBeUndefined();

    const started = await call<{ mode: { projectId: string } | null; changed: boolean }>(
      'POST',
      '/api/cash/activate',
      { cookie: adminCookie, body: {} },
    );
    expect(started.status).toBe(200);
    expect(started.body.changed).toBe(true);
    expect(started.body.mode).not.toBeNull();

    const after = await call<{ mode: unknown; readiness?: unknown }>('GET', '/api/cash/mode', {
      cookie: adminCookie,
    });
    expect(after.body.mode).not.toBeNull();
    expect(after.body.readiness).toBeUndefined();
  });

  it('still starts exactly one, so a second press changes nothing', async () => {
    const again = await call<{ changed: boolean; message: string }>('POST', '/api/cash/activate', {
      cookie: adminCookie,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.message).toMatch(/has been running since/i);
  });
});
