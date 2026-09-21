/**
 * The PIN door, over a real socket, and the journey that creates one.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists for
 * ---------------------------------------------------------------------------
 *
 * The sign-in screen offered one credential — a passkey — and this Brain's only
 * administrator had never successfully presented one. Their browser answered
 * *"the operation either timed out or was not allowed"*, which is WebAuthn's
 * single refusal for every reason it has, and there was nothing else on the
 * screen. The owner could not get into their own Brain.
 *
 * So this walks exactly the path out of that, against a live server: the
 * password they still hold, at `/recovery`'s route, then six digits, then the
 * ordinary door. Everything the owner is about to do in production is done here
 * first, in the same order, over HTTP.
 *
 * ---------------------------------------------------------------------------
 * What it asserts that a unit test could not
 * ---------------------------------------------------------------------------
 *
 * **The throttle survives a restart.** That is the whole reason it is rows
 * rather than a `Map`, and the only way to see it is to stop the process and
 * start it again — which is also what every deploy does, so an in-memory
 * counter would hand an attacker their budget back on a schedule.
 *
 * **The refusals are byte-identical.** An unknown identity, an account with no
 * PIN and a wrong PIN are one sentence, because six digits makes *which
 * identities exist* worth learning.
 *
 * **Setting a PIN ends the other sessions**, which is a fact about rows in a
 * second browser rather than about the response to the request that did it.
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
const PORT = pickPort(7700, 100);
const BASE = `http://localhost:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

/** The owner as production actually has one: a password, and nothing else. */
const OWNER_EMAIL = 'owner@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
/**
 * The password the owner chooses for themselves, replacing the deployment
 * secret's.
 *
 * The bootstrapped account carries `must_change_password`, and the guard
 * answers 403 to everything outside `/api/auth/*` until it is cleared — which
 * is correct and unchanged, and is why the recovery screen puts the password
 * change *before* the PIN. Skipping it here would be testing a state the
 * product never leaves somebody in.
 */
const OWNER_PASSWORD = 'owner-password-000001';
const OWNER_PIN = '246813';
const REPLACEMENT_PIN = '975310';

let ownerId = '';

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
  const setCookie = response.headers.get('set-cookie') ?? '';
  return {
    status: response.status,
    body: body as T,
    text,
    cookie: setCookie.split(';')[0] ?? '',
    setCookie,
  };
}

async function startServer(): Promise<void> {
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

function pinSignIn(identity: string, pin: string): Promise<Result<{ user?: { id: string } }>> {
  return call<{ user?: { id: string } }>('POST', '/api/auth/pin', { body: { identity, pin } });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-pin-'));
  await startServer();
}, 120_000);

afterAll(async () => {
  await stopServer();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the owner, who has a password and no PIN', () => {
  let recoveryCookie = '';

  it('cannot sign in with a PIN, because there is none to present', async () => {
    const attempt = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    expect(attempt.status).toBe(401);
  });

  it('is accepted at the recovery door by the password they already hold', async () => {
    const bootstrap = await call<{ user: { id: string; hasPin: boolean } }>(
      'POST',
      '/api/auth/login',
      { body: { email: OWNER_EMAIL, password: BOOTSTRAP_PASSWORD } },
    );
    expect(bootstrap.status).toBe(200);
    ownerId = bootstrap.body.user.id;
    expect(ownerId).toMatch(/^usr_/);
    // The screen says *create* or *replace* from this, and from nothing else.
    expect(bootstrap.body.user.hasPin).toBe(false);

    // The password change the recovery screen puts first for an account
    // carrying a password somebody else chose. Unchanged by any of this, and
    // still what clears the guard.
    expect(
      (
        await call('POST', '/api/auth/password', {
          cookie: bootstrap.cookie,
          body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: OWNER_PASSWORD },
        })
      ).status,
    ).toBe(200);

    const signedIn = await call<{ user: { hasPin: boolean } }>('POST', '/api/auth/login', {
      body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    expect(signedIn.status).toBe(200);
    recoveryCookie = signedIn.cookie;
  });

  it('refuses a PIN that is not six digits, and says so rather than refusing', async () => {
    for (const bad of ['12345', '1234567', '12345a', '', '  1234', null, 123_456]) {
      const attempt = await call<{ error: string }>('POST', '/api/auth/pin/set', {
        cookie: recoveryCookie,
        body: { pin: bad },
      });
      expect(attempt.status, `${JSON.stringify(bad)} was accepted`).toBe(400);
      // Malformed is deliberately its own answer: the rule is printed above the
      // box, so it reveals nothing, and telling somebody who typed five digits
      // that their PIN is *wrong* is how they burn attempts on a typo.
      expect(attempt.body.error).toMatch(/exactly 6 digits/i);
    }
  });

  it('creates the PIN on the same account, and says nothing about it afterwards', async () => {
    const saved = await call('POST', '/api/auth/pin/set', {
      cookie: recoveryCookie,
      body: { pin: OWNER_PIN },
    });
    expect(saved.status).toBe(200);

    const session = await call<{ user: { id: string; hasPin: boolean } }>(
      'GET',
      '/api/auth/session',
      { cookie: recoveryCookie },
    );
    expect(session.body.user.id).toBe(ownerId);
    expect(session.body.user.hasPin).toBe(true);
    // A boolean and never the value. The digits must not appear in any
    // response, at any depth, whatever the field is called.
    expect(session.text).not.toContain(OWNER_PIN);
  });

  it('then signs in through the ordinary door, with no device anywhere in it', async () => {
    const signedIn = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.id).toBe(ownerId);

    const session = await call<{ authenticated: boolean; user: { id: string } }>(
      'GET',
      '/api/auth/session',
      { cookie: signedIn.cookie },
    );
    expect(session.body.authenticated).toBe(true);
    expect(session.body.user.id).toBe(ownerId);
  });

  it('keeps its administration, memberships and identity through all of it', async () => {
    const signedIn = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    const me = await call<{
      principal: { id: string; isBrainAdmin: boolean };
    }>('GET', '/api/auth/me', { cookie: signedIn.cookie });
    expect(me.body.principal.id).toBe(ownerId);
    expect(me.body.principal.isBrainAdmin).toBe(true);
    // Exercised rather than inferred from the flag: the point of preserving
    // administration is being able to use it.
    expect((await call('GET', '/api/admin/users', { cookie: signedIn.cookie })).status).toBe(200);
  });

  it('opens a session that lasts weeks rather than a working day', async () => {
    const signedIn = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    /*
     * `Max-Age` is what makes it survive closing the browser. The credential is
     * different from a passkey; how long somebody should stay signed in to
     * their own Brain is not.
     */
    const maxAge = Number(/Max-Age=(\d+)/.exec(signedIn.setCookie)?.[1] ?? '0');
    expect(maxAge).toBeGreaterThan(21 * 24 * 60 * 60);
    expect(signedIn.setCookie).toContain('HttpOnly');
    expect(signedIn.setCookie).toContain('SameSite=Lax');
  });

  it('signs the person out, and the session stops working', async () => {
    const signedIn = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    expect((await call('POST', '/api/auth/logout', { cookie: signedIn.cookie, body: {} })).status).toBe(200);
    const after = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: signedIn.cookie,
    });
    expect(after.body.authenticated).toBe(false);
  });
});

describe('what the door says when it refuses', () => {
  it('answers a wrong PIN, an unknown identity and one with no PIN identically', async () => {
    // A second account, with no PIN, so all three conditions are real.
    const owner = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    await call('POST', '/api/admin/users', {
      cookie: owner.cookie,
      body: {
        email: 'no-pin@example.invalid',
        displayName: 'Nobody With A Pin',
        password: 'temporary-password-01',
      },
    });

    const wrong = await pinSignIn(OWNER_EMAIL, '000001');
    const unknown = await pinSignIn('nobody-at-all@example.invalid', '000001');
    const noPin = await pinSignIn('no-pin@example.invalid', '000001');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(noPin.status).toBe(401);
    // The same *body*, not merely the same status. A status that matches while
    // the body differs is still an oracle — and here it would say both that an
    // identity exists and whether it has set a PIN.
    expect(wrong.text).toBe(unknown.text);
    expect(wrong.text).toBe(noPin.text);
  });

  it('refuses a malformed PIN without spending an attempt on it', async () => {
    const malformed = await pinSignIn(OWNER_EMAIL, '12345');
    expect(malformed.status).toBe(400);
    // Still right afterwards: a typo must not cost the person their budget.
    expect((await pinSignIn(OWNER_EMAIL, OWNER_PIN)).status).toBe(200);
  });
});

describe('the throttle, which is the whole strength of six digits', () => {
  /** A fresh account, so the ladder is climbed against nobody else's counter. */
  const email = 'throttled@example.invalid';
  const pin = '135791';

  it('locks the account out after repeated failures, and says nothing a guesser could use', async () => {
    const owner = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
      cookie: owner.cookie,
      body: { email, displayName: 'Throttled', password: 'temporary-password-01' },
    });
    expect(created.status).toBe(200);

    /*
     * Created by an administrator, so it carries `must_change_password`. The
     * recovery screen clears that before it offers the PIN, so this does too —
     * a PIN set on top of an unreplaced deployment password would leave
     * somebody able to sign in and refused everywhere, which is the state the
     * product deliberately does not produce.
     */
    const first = await call('POST', '/api/auth/login', {
      body: { email, password: 'temporary-password-01' },
    });
    await call('POST', '/api/auth/password', {
      cookie: first.cookie,
      body: { currentPassword: 'temporary-password-01', newPassword: 'their-own-password-01' },
    });
    const theirs = await call('POST', '/api/auth/login', {
      body: { email, password: 'their-own-password-01' },
    });
    await call('POST', '/api/auth/pin/set', { cookie: theirs.cookie, body: { pin } });

    /*
     * Climbed to the top of the ladder. Every rung answers identically, so
     * there is nothing in the responses to tell them apart by — which is the
     * property, and is why the lockout is proved by what it *does* below
     * rather than by a status code that announces it.
     *
     * This used to break out on a `429` and assert its `retryAt`. That was a
     * second sentence for one way of failing, reachable only when the identity
     * resolves, so three wrong guesses separated a real member from an
     * invented name. The replacement is strictly stronger: it asserts the
     * lockout refuses the **correct** PIN, which is the whole of what a
     * lockout is for and which the old assertion never checked.
     */
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const refused = await call('POST', '/api/auth/pin', {
        body: { identity: email, pin: '000002' },
      });
      expect(refused.status).toBe(401);
    }

    // The lockout, observed as a lockout: the right PIN does not get in.
    const rightPin = await call('POST', '/api/auth/pin', {
      body: { identity: email, pin },
    });
    expect(rightPin.status, 'the ladder never produced a cooldown').toBe(401);

    /*
     * And byte-identical to the two refusals that must not be distinguishable
     * from it. A wrong PIN on a real account, an identity that does not exist,
     * and this account cooling off are one answer — status and body.
     */
    const wrong = await pinSignIn(OWNER_EMAIL, '000009');
    const unknown = await pinSignIn('nobody-at-all@example.invalid', '000009');
    expect(rightPin.status).toBe(wrong.status);
    expect(rightPin.status).toBe(unknown.status);
    expect(rightPin.text).toBe(wrong.text);
    expect(rightPin.text).toBe(unknown.text);
    expect(rightPin.text).not.toContain(email);
  }, 60_000);

  it('holds the lockout across a restart, because it is rows and not memory', async () => {
    /*
     * The condition this exists for: a Brain restarts on every deploy, so an
     * in-memory counter is a budget an attacker gets back on a schedule.
     *
     * Asserted on the **correct** PIN either side of the restart, for the
     * reason above: a refusal of the right credential is the lockout, and it
     * is the only form of it a caller can observe now that every refusal reads
     * the same.
     */
    const before = await call('POST', '/api/auth/pin', { body: { identity: email, pin } });
    expect(before.status).toBe(401);

    await stopServer();
    await startServer();

    const after = await call('POST', '/api/auth/pin', { body: { identity: email, pin } });
    expect(after.status, 'the lockout did not survive the restart').toBe(401);
  }, 120_000);

  it('is cleared by setting a new PIN, because the old one is gone', async () => {
    // A cooldown earned against a credential nobody holds any more is a
    // punishment for nothing. The password door is how this account reaches it.
    const theirs = await call('POST', '/api/auth/login', {
      body: { email, password: 'their-own-password-01' },
    });
    expect(theirs.status).toBe(200);
    const saved = await call('POST', '/api/auth/pin/set', {
      cookie: theirs.cookie,
      body: { pin: '864209' },
    });
    expect(saved.status).toBe(200);

    expect((await pinSignIn(email, '864209')).status).toBe(200);
  }, 60_000);
});

describe('resetting a PIN', () => {
  it('replaces it, and ends every other session that account holds', async () => {
    // Two browsers signed in with the current PIN.
    const first = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    const second = await pinSignIn(OWNER_EMAIL, OWNER_PIN);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // A third, at the recovery door, which is where a forgotten PIN is replaced.
    const recovery = await call('POST', '/api/auth/login', {
      body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    expect(recovery.status).toBe(200);
    const reset = await call('POST', '/api/auth/pin/set', {
      cookie: recovery.cookie,
      body: { pin: REPLACEMENT_PIN },
    });
    expect(reset.status).toBe(200);

    // The two PIN sessions are gone: replacing a credential is what somebody
    // does when they think the old one may be in the wrong hands.
    for (const gone of [first.cookie, second.cookie]) {
      const session = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
        cookie: gone,
      });
      expect(session.body.authenticated).toBe(false);
    }
    // The one that did it survives, so nobody is signed out of the tab they
    // are typing in.
    const still = await call<{ authenticated: boolean }>('GET', '/api/auth/session', {
      cookie: recovery.cookie,
    });
    expect(still.body.authenticated).toBe(true);

    expect((await pinSignIn(OWNER_EMAIL, OWNER_PIN)).status).toBe(401);
    expect((await pinSignIn(OWNER_EMAIL, REPLACEMENT_PIN)).status).toBe(200);
  }, 60_000);
});

describe('what the PIN door does not change', () => {
  it('refuses a disabled account whatever it presents', async () => {
    const owner = await pinSignIn(OWNER_EMAIL, REPLACEMENT_PIN);
    const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
      cookie: owner.cookie,
      body: {
        email: 'disabled-pin@example.invalid',
        displayName: 'Disabled With A Pin',
        password: 'temporary-password-01',
      },
    });
    const first = await call('POST', '/api/auth/login', {
      body: { email: 'disabled-pin@example.invalid', password: 'temporary-password-01' },
    });
    await call('POST', '/api/auth/password', {
      cookie: first.cookie,
      body: { currentPassword: 'temporary-password-01', newPassword: 'their-own-password-02' },
    });
    const theirs = await call('POST', '/api/auth/login', {
      body: { email: 'disabled-pin@example.invalid', password: 'their-own-password-02' },
    });
    await call('POST', '/api/auth/pin/set', { cookie: theirs.cookie, body: { pin: '112233' } });
    expect((await pinSignIn('disabled-pin@example.invalid', '112233')).status).toBe(200);

    expect(
      (
        await call('POST', `/api/admin/users/${created.body.user.id}/disabled`, {
          cookie: owner.cookie,
          body: { disabled: true },
        })
      ).status,
    ).toBe(200);

    expect((await pinSignIn('disabled-pin@example.invalid', '112233')).status).toBe(401);
  }, 60_000);

  it('leaves a worker credential exactly where it was', async () => {
    const owner = await pinSignIn(OWNER_EMAIL, REPLACEMENT_PIN);
    const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
      cookie: owner.cookie,
      body: { name: 'pin-era-worker', displayName: 'Pin era worker' },
    });
    expect(worker.status).toBe(200);
    const issued = await call<{ secret: string }>(
      'POST',
      `/api/admin/workers/${worker.body.worker.id}/credentials`,
      { cookie: owner.cookie, body: {} },
    );
    expect(issued.status).toBe(200);

    const response = await fetch(`${BASE}/api/auth/me`, {
      headers: { authorization: `Bearer ${issued.body.secret}` },
    });
    const principal = (await response.json()) as { principal: { type: string; id: string } };
    expect(response.status).toBe(200);
    expect(principal.principal.type).toBe('WORKER');
    expect(principal.principal.id).toBe(worker.body.worker.id);
  }, 60_000);

  it('does not let a PIN be set for anybody but the caller', async () => {
    // There is no identity field on the route at all, so the only way to ask
    // is to send one and watch it be ignored.
    const owner = await pinSignIn(OWNER_EMAIL, REPLACEMENT_PIN);
    const attempt = await call('POST', '/api/auth/pin/set', {
      cookie: owner.cookie,
      body: { pin: '444555', identity: 'throttled@example.invalid', userId: 'usr_somebody' },
    });
    expect(attempt.status).toBe(200);
    // The owner's PIN moved; the other account's did not.
    expect((await pinSignIn(OWNER_EMAIL, '444555')).status).toBe(200);
    expect((await pinSignIn('throttled@example.invalid', '444555')).status).toBe(401);
    expect((await pinSignIn('throttled@example.invalid', '864209')).status).toBe(200);
  }, 60_000);

  it('refuses an unauthenticated caller trying to set one', async () => {
    const attempt = await call<{ error: string }>('POST', '/api/auth/pin/set', {
      body: { pin: '999888' },
    });
    expect(attempt.status).toBe(401);
    expect(attempt.body.error).toBe('Not authorized.');
  });
});

describe('a member who joins by link', () => {
  it('sets a PIN from the link and is signed in, with no device anywhere', async () => {
    const owner = await pinSignIn(OWNER_EMAIL, '444555');
    const slot = await call<{ enrollment: { token: string; userId: string } }>(
      'POST',
      '/api/members',
      { cookie: owner.cookie, body: { displayName: 'Link Member' } },
    );
    expect(slot.status).toBe(200);

    const enrolled = await call<{ user: { id: string } }>('POST', '/api/enroll/pin', {
      body: { token: slot.body.enrollment.token, pin: '303030' },
    });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.user.id).toBe(slot.body.enrollment.userId);
    expect(enrolled.cookie).not.toBe('');

    // The link is spent, whichever credential it was spent on.
    const again = await call('POST', '/api/enroll/pin', {
      body: { token: slot.body.enrollment.token, pin: '404040' },
    });
    expect(again.status).toBe(404);

    /*
     * And they sign in by **display name**, because a member enrolled from a
     * link holds no address at all. An email-only door would have handed this
     * person a PIN they could never present.
     */
    const signedIn = await call<{ user?: { id: string } }>('POST', '/api/auth/pin', {
      body: { identity: 'Link Member', pin: '303030' },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.id).toBe(slot.body.enrollment.userId);
  }, 60_000);
});
