/**
 * The migration itself, driven the way it actually happens.
 *
 * ---------------------------------------------------------------------------
 * What this suite is for
 * ---------------------------------------------------------------------------
 *
 * `passkeyHttp` proves the passkey door works. `passkeyEnrollment` proves a
 * link is spent once. Neither could see the thing that was actually wrong,
 * which is that the live Brain's only administrator held a password and no
 * device — so the sign-in screen still offered a password, and removing the
 * form without doing anything else would have locked that account out.
 *
 * So this walks that account through it: signed in with the password it has,
 * registering a device against **the same user id**, and then refused that
 * password for ever after — with the administration, the memberships and the
 * history it had before still attached to the row that was always there.
 *
 * Three things it deliberately asserts as *absences*, because each is a way the
 * work could look finished and not be:
 *
 *   * the password refusal is **byte-identical** to a wrong password, because a
 *     door that says "that account uses a device" is an oracle for who has
 *     enrolled;
 *   * the migration creates **no second account**, which is the failure mode
 *     that would be invisible from the screen — the owner would sign in, see a
 *     Brain, and wonder where everything went;
 *   * a worker's bearer credential is **untouched** by any of it, because the
 *     one thing a human authentication change must not do is move the machine
 *     boundary.
 *
 * The server is restarted once, mid-suite, with `BRAIN_BREAK_GLASS` armed.
 * That is two answers for the price of one restart: a device session survives a
 * server restart, which is what a persistent session has to mean, and the
 * emergency switch re-opens a door that is otherwise shut for good.
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
const PORT = pickPort(7600, 100);
const BASE = `http://localhost:${PORT}`;
const RP_ID = 'localhost';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

/**
 * The owner, as the live Brain actually has one: a `PERSON` row, Brain
 * administrator, with a password and no device. The bootstrap variables are the
 * only way to produce that shape, which is why they are the fixture.
 */
const OWNER_EMAIL = 'owner@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const OWNER_PASSWORD = 'owner-password-000001';

let ownerId = '';
let ownerCookie = '';
/**
 * The owner's registered device, held for the whole suite.
 *
 * `authenticator()` makes a **fresh key pair** every call, so one rebuilt later
 * from the same credential id is a different device wearing the same name — it
 * would be refused, and the refusal would look exactly like the door being
 * shut. The thing under test has to be the device that was actually enrolled.
 */
let ownerDevice: ReturnType<typeof authenticator> | null = null;

interface Result<T = unknown> {
  status: number;
  body: T;
  text: string;
  cookie: string;
  setCookie: string;
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
  const setCookie = response.headers.get('set-cookie') ?? '';
  return {
    status: response.status,
    body: body as T,
    text,
    cookie: setCookie.split(';')[0] ?? '',
    setCookie,
  };
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<void> {
  serverLog = '';
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
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: OWNER_EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
        BRAIN_BREAK_GLASS: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        BRAIN_PROVIDER: undefined,
        ...extraEnv,
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

async function stopServer(): Promise<void> {
  server?.kill('SIGTERM');
  server = null;
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Register a device against whoever holds this session. */
async function addDevice(cookie: string, credentialId: string, label = 'A laptop') {
  const options = await call<{ challenge: string }>('POST', '/api/me/passkeys/options', {
    cookie,
    body: {},
  });
  expect(options.status).toBe(200);
  const device = authenticator({ rpId: RP_ID, credentialId });
  const made = device.register(options.body.challenge, { origin: BASE });
  const added = await call<{ passkey: { id: string } }>('POST', '/api/me/passkeys', {
    cookie,
    body: { challenge: options.body.challenge, label, ...made },
  });
  return { added, device };
}

/** Sign in with a device, from a browser holding nothing. */
async function signInWithDevice(
  device: ReturnType<typeof authenticator>,
  signCount: number,
): Promise<Result<{ user?: { id: string } }>> {
  const options = await call<{ challenge: string }>('POST', '/api/auth/passkey/options');
  const assertion = device.assert(options.body.challenge, { origin: BASE, signCount });
  return await call<{ user?: { id: string } }>('POST', '/api/auth/passkey/verify', {
    body: { credentialId: device.credentialId, challenge: options.body.challenge, ...assertion },
  });
}

async function password(email: string, secret: string): Promise<Result<unknown>> {
  return await call('POST', '/api/auth/login', { body: { email, password: secret } });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-passkey-only-'));
  await startServer();

  // The owner as they are today: password only, and a temporary one at that.
  const bootstrap = await password(OWNER_EMAIL, BOOTSTRAP_PASSWORD);
  expect(bootstrap.status).toBe(200);
  await call('POST', '/api/auth/password', {
    cookie: bootstrap.cookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: OWNER_PASSWORD },
  });
  const signedIn = await password(OWNER_EMAIL, OWNER_PASSWORD);
  ownerCookie = signedIn.cookie;
  const me = await call<{ user: { id: string } }>('GET', '/api/auth/session', {
    cookie: ownerCookie,
  });
  ownerId = me.body.user.id;
  expect(ownerId).toMatch(/^usr_/);
}, 120_000);

afterAll(async () => {
  await stopServer();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('migrating the account that already exists', () => {
  /**
   * Everything about the owner before the migration, so that afterwards the
   * question "is this the same account" is answered against a recorded value
   * rather than against a memory of what it probably was.
   */
  let before: {
    id: string;
    isBrainAdmin: boolean;
    memberships: number;
    users: number;
  };
  it('starts from a password-backed administrator with no device at all', async () => {
    const principal = await call<{
      principal: { id: string; isBrainAdmin: boolean; memberships: unknown[] };
    }>('GET', '/api/auth/me', { cookie: ownerCookie });
    const users = await call<{ users: unknown[] }>('GET', '/api/admin/users', {
      cookie: ownerCookie,
    });
    expect(users.status).toBe(200);
    const devices = await call<{ passkeys: unknown[] }>('GET', '/api/me/passkeys', {
      cookie: ownerCookie,
    });

    before = {
      id: principal.body.principal.id,
      isBrainAdmin: principal.body.principal.isBrainAdmin,
      memberships: principal.body.principal.memberships.length,
      users: users.body.users.length,
    };
    expect(before.isBrainAdmin).toBe(true);
    expect(devices.body.passkeys).toHaveLength(0);
  });

  it('registers a device against the same user id, creating no second account', async () => {
    const { added, device } = await addDevice(ownerCookie, 'owner-device-0000001', 'The laptop');
    ownerDevice = device;
    expect(added.status).toBe(200);

    const users = await call<{ users: unknown[] }>('GET', '/api/admin/users', {
      cookie: ownerCookie,
    });
    // The failure mode this exists for: a migration that "works" by making a
    // new owner beside the old one. Nothing about the screen would say so.
    expect(users.body.users.length).toBe(before.users);
  });

  it('signs that same account in with the device, and keeps its administration', async () => {
    const verified = await signInWithDevice(ownerDevice!, 1);
    expect(verified.status).toBe(200);
    expect(verified.body.user?.id).toBe(before.id);

    const principal = await call<{
      principal: { id: string; isBrainAdmin: boolean; memberships: unknown[] };
    }>('GET', '/api/auth/me', { cookie: verified.cookie });
    expect(principal.body.principal.id).toBe(before.id);
    expect(principal.body.principal.isBrainAdmin).toBe(before.isBrainAdmin);
    expect(principal.body.principal.memberships.length).toBe(before.memberships);

    // A Brain-administrator-only route, exercised rather than inferred from the
    // flag: the point of preserving administration is being able to use it.
    const members = await call('GET', '/api/members', { cookie: verified.cookie });
    expect(members.status).toBe(200);

    ownerCookie = verified.cookie;
  });

  it('then refuses that account its password, in the same words a wrong one gets', async () => {
    const right = await password(OWNER_EMAIL, OWNER_PASSWORD);
    const wrong = await password(OWNER_EMAIL, 'not-the-password-0001');
    const unknown = await password('nobody@example.invalid', OWNER_PASSWORD);

    expect(right.status).toBe(401);
    // The same body, not merely the same status. A status that matches while
    // the body differs is still an oracle — and this one would say both that
    // the account exists and that it holds a device.
    expect(right.text).toBe(wrong.text);
    expect(right.text).toBe(unknown.text);
  });

  it('refuses to let that account set a password either', async () => {
    const changed = await call('POST', '/api/auth/password', {
      cookie: ownerCookie,
      body: { currentPassword: OWNER_PASSWORD, newPassword: 'another-password-0001' },
    });
    expect(changed.status).toBe(400);
  });

  it('leaves the device session working throughout', async () => {
    const session = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: ownerCookie,
    });
    expect(session.body.authenticated).toBe(true);
  });
});

describe('the door, for everybody else', () => {
  it('still lets a machine identity in, because it has no device and never will', async () => {
    /*
     * `scripts/verify-hosted.ts` creates its identities with `kind: 'SYSTEM'`
     * and signs in as them over the real edge on every deploy. The rule here
     * says nothing about kinds — what keeps that working is that machinery
     * holds no passkey — and this is the check that would fail if the rule ever
     * became "refuse a person", which would refuse them too on the first
     * account somebody declared differently.
     */
    const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
      cookie: ownerCookie,
      body: {
        email: 'machinery@example.invalid',
        displayName: 'Machinery',
        password: 'temporary-password-01',
      },
    });
    expect(created.status).toBe(200);
    const signedIn = await password('machinery@example.invalid', 'temporary-password-01');
    expect(signedIn.status).toBe(200);
  });

  it('gives a passkey-only member nothing to put a password against', async () => {
    const slot = await call<{ enrollment: { token: string; userId: string } }>(
      'POST',
      '/api/members',
      { cookie: ownerCookie, body: { displayName: 'A member' } },
    );
    const options = await call<{ challenge: string }>('POST', '/api/enroll/options', {
      body: { token: slot.body.enrollment.token },
    });
    const device = authenticator({ rpId: RP_ID, credentialId: 'member-device-000001' });
    const made = device.register(options.body.challenge, { origin: BASE });
    const done = await call<{ user: { id: string } }>('POST', '/api/enroll/complete', {
      body: {
        token: slot.body.enrollment.token,
        challenge: options.body.challenge,
        label: 'A phone',
        ...made,
      },
    });
    expect(done.status).toBe(200);
    expect(done.body.user.id).toBe(slot.body.enrollment.userId);

    // No address, so there is nothing a password could even be presented for.
    const session = await call<{ user: { email: string | null } }>('GET', '/api/auth/session', {
      cookie: done.cookie,
    });
    expect(session.body.user.email).toBeNull();

    // And the password-change route refuses them the same way it refuses
    // everybody: a member cannot wander into a password flow by accident.
    const changed = await call('POST', '/api/auth/password', {
      cookie: done.cookie,
      body: { currentPassword: 'anything-at-all-01', newPassword: 'something-else-0001' },
    });
    expect(changed.status).toBe(400);
  });

  it('refuses a disabled account whatever it presents', async () => {
    const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
      cookie: ownerCookie,
      body: {
        email: 'disabled@example.invalid',
        displayName: 'Disabled',
        password: 'temporary-password-01',
      },
    });
    const first = await password('disabled@example.invalid', 'temporary-password-01');
    expect(first.status).toBe(200);

    const disabled = await call('POST', `/api/admin/users/${created.body.user.id}/disabled`, {
      cookie: ownerCookie,
      body: { disabled: true },
    });
    expect(disabled.status).toBe(200);

    const again = await password('disabled@example.invalid', 'temporary-password-01');
    expect(again.status).toBe(401);
    // And the session they already held stops working on its next request,
    // because the account is re-read rather than trusted from the cookie.
    const stale = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: first.cookie,
    });
    expect(stale.body.authenticated).toBe(false);
  });

  it('leaves a worker credential exactly where it was', async () => {
    const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
      cookie: ownerCookie,
      body: { name: 'unaffected-worker', displayName: 'Unaffected worker' },
    });
    expect(worker.status).toBe(200);
    const issued = await call<{ secret: string }>(
      'POST',
      `/api/admin/workers/${worker.body.worker.id}/credentials`,
      { cookie: ownerCookie, body: {} },
    );
    expect(issued.status).toBe(200);

    const whoami = await call<{ principal: { type: string; id: string } }>('GET', '/api/auth/me', {
      bearer: issued.body.secret,
    });
    expect(whoami.status).toBe(200);
    expect(whoami.body.principal.type).toBe('WORKER');
    expect(whoami.body.principal.id).toBe(worker.body.worker.id);
  });
});

describe('devices, sessions and what revoking one reaches', () => {
  let member: { token: string; userId: string };
  let first: ReturnType<typeof authenticator>;
  let replacementDevice: ReturnType<typeof authenticator> | null = null;
  let firstCookie = '';

  it('registers more than one device and signs in with either', async () => {
    const slot = await call<{ enrollment: { token: string; userId: string } }>(
      'POST',
      '/api/members',
      { cookie: ownerCookie, body: { displayName: 'Two devices' } },
    );
    member = slot.body.enrollment;

    const options = await call<{ challenge: string }>('POST', '/api/enroll/options', {
      body: { token: member.token },
    });
    first = authenticator({ rpId: RP_ID, credentialId: 'two-device-first-001' });
    const made = first.register(options.body.challenge, { origin: BASE });
    const done = await call('POST', '/api/enroll/complete', {
      body: { token: member.token, challenge: options.body.challenge, label: 'Phone', ...made },
    });
    expect(done.status).toBe(200);

    const { added, device: second } = await addDevice(
      done.cookie,
      'two-device-second-01',
      'Laptop',
    );
    expect(added.status).toBe(200);

    const bySecond = await signInWithDevice(second, 1);
    expect(bySecond.status).toBe(200);
    expect(bySecond.body.user?.id).toBe(member.userId);

    const byFirst = await signInWithDevice(first, 2);
    expect(byFirst.status).toBe(200);
    firstCookie = byFirst.cookie;

    const listed = await call<{ passkeys: { revokedAt: string | null }[] }>(
      'GET',
      '/api/me/passkeys',
      { cookie: firstCookie },
    );
    expect(listed.body.passkeys.filter((one) => !one.revokedAt)).toHaveLength(2);
  });

  it('gives a device session a lifetime measured in weeks, in the cookie itself', async () => {
    const options = await call<{ challenge: string }>('POST', '/api/auth/passkey/options');
    const assertion = first.assert(options.body.challenge, { origin: BASE, signCount: 3 });
    const verified = await call('POST', '/api/auth/passkey/verify', {
      body: {
        credentialId: first.credentialId,
        challenge: options.body.challenge,
        ...assertion,
      },
    });

    /*
     * `Max-Age` is what makes it survive closing the browser — a session cookie
     * without one dies with the tab, which is the friction this changed. It is
     * asserted as a number rather than a string so the check says what it
     * means: at least three weeks, rather than a working day.
     */
    const maxAge = Number(/Max-Age=(\d+)/.exec(verified.setCookie)?.[1] ?? '0');
    expect(maxAge).toBeGreaterThan(21 * 24 * 60 * 60);
    expect(verified.setCookie).toContain('HttpOnly');
    expect(verified.setCookie).toContain('SameSite=Lax');
  });

  it('ends only that device\'s sessions when it is revoked', async () => {
    const listed = await call<{ passkeys: { id: string; label: string }[] }>(
      'GET',
      '/api/me/passkeys',
      { cookie: firstCookie },
    );
    const laptop = listed.body.passkeys.find((one) => one.label === 'Laptop');
    const phone = listed.body.passkeys.find((one) => one.label === 'Phone');
    expect(laptop && phone).toBeTruthy();

    const revoked = await call('POST', `/api/me/passkeys/${laptop!.id}/revoke`, {
      cookie: firstCookie,
      body: { reason: 'Sold it.' },
    });
    expect(revoked.status).toBe(200);

    // The phone's session — the one this request is being made with — is
    // untouched. Losing one device is not a reason to sign out everywhere.
    const still = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: firstCookie,
    });
    expect(still.body.authenticated).toBe(true);
  });

  it('ends every session a person holds when a recovery link is issued', async () => {
    const recovery = await call('POST', `/api/members/${member.userId}/recovery`, {
      cookie: ownerCookie,
      body: { reason: 'They lost the phone.' },
    });
    expect(recovery.status).toBe(200);

    const after = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: firstCookie,
    });
    expect(after.body.authenticated).toBe(false);
  });

  it('lets the recovery link bring the same person back on a new device', async () => {
    const issued = await call<{ enrollment: { token: string; userId: string } }>(
      'POST',
      `/api/members/${member.userId}/recovery`,
      { cookie: ownerCookie, body: { reason: 'Second attempt.' } },
    );
    const options = await call<{ challenge: string }>('POST', '/api/enroll/options', {
      body: { token: issued.body.enrollment.token },
    });
    replacementDevice = authenticator({ rpId: RP_ID, credentialId: 'two-device-third-001' });
    const made = replacementDevice.register(options.body.challenge, { origin: BASE });
    const done = await call<{ user: { id: string } }>('POST', '/api/enroll/complete', {
      body: {
        token: issued.body.enrollment.token,
        challenge: options.body.challenge,
        label: 'New phone',
        ...made,
      },
    });
    expect(done.status).toBe(200);
    // The same person, not a replacement for them.
    expect(done.body.user.id).toBe(member.userId);
  });

  it('revokes the session when somebody signs out', async () => {
    // The phone was retired by the recovery, so it is refused — which is the
    // recovery working rather than an aside.
    expect((await signInWithDevice(first, 9)).status).toBe(401);

    const signedIn = await signInWithDevice(replacementDevice!, 1);
    expect(signedIn.status).toBe(200);

    const out = await call('POST', '/api/auth/logout', {
      cookie: signedIn.cookie,
      body: {},
    });
    expect(out.status).toBe(200);
    const after = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: signedIn.cookie,
    });
    expect(after.body.authenticated).toBe(false);
  });
});

describe('across a restart, and with break-glass armed', () => {
  it('keeps the owner signed in when the server comes back', async () => {
    await stopServer();
    await startServer();

    const session = await call<{ authenticated: boolean; user: { id: string } }>(
      'GET',
      '/api/auth/session',
      { cookie: ownerCookie },
    );
    // A session is a row, so a restart is not an event it has an opinion about.
    // That is what "survives a browser restart" has to rest on: the cookie
    // outliving the tab is only half of it.
    expect(session.body.authenticated).toBe(true);
    expect(session.body.user.id).toBe(ownerId);
  }, 120_000);

  it('still refuses the owner their password, because nothing was armed', async () => {
    expect((await password(OWNER_EMAIL, OWNER_PASSWORD)).status).toBe(401);
  });

  it('re-opens the door when the deployment arms it, and says so at boot', async () => {
    await stopServer();
    await startServer({ BRAIN_BREAK_GLASS: 'true' });

    const armed = await password(OWNER_EMAIL, OWNER_PASSWORD);
    expect(armed.status).toBe(200);
    // An emergency switch that is on has to be loud, every time it starts.
    expect(serverLog).toContain('BREAK-GLASS IS ARMED');

    // It opens a door; it does not lower one. A wrong password is still wrong.
    expect((await password(OWNER_EMAIL, 'still-not-it-000001')).status).toBe(401);
  }, 120_000);

  it('shuts again the moment it is unarmed', async () => {
    await stopServer();
    await startServer();
    expect((await password(OWNER_EMAIL, OWNER_PASSWORD)).status).toBe(401);
    // And the device still works, which is the whole point of the arrangement.
    const signedIn = await signInWithDevice(ownerDevice!, 12);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.id).toBe(ownerId);
  }, 120_000);
});
