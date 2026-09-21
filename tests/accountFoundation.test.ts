/**
 * One account, one identity, one way in — over a real socket.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists for
 * ---------------------------------------------------------------------------
 *
 * A member enrolled from a link holds **no address at all**, so the only thing
 * they can type at the sign-in screen is their display name. Nothing kept that
 * name unique, and `getPinCredentialByIdentity` refuses an ambiguous one by
 * design — `LIMIT 2`, and `null` unless exactly one row came back.
 *
 * Both halves are individually correct and together they are a locked door:
 *
 *   * an administrator invites a second *Caleb* — an ordinary thing to do,
 *     and the likeliest reason is re-inviting somebody whose first link
 *     expired;
 *   * from that moment **neither** Caleb can sign in;
 *   * the refusal is `PIN_REFUSED`, byte-identical to a wrong PIN, because
 *     invariant 23 is doing its job and must not say which of the reasons it
 *     was;
 *   * `peopleReading` says `READY` about both of them, which is the expensive
 *     direction — it tells an administrator that a locked-out person is fine;
 *   * and there is no rename anywhere in this repository, so the condition
 *     cannot be corrected through any surface at all.
 *
 * That last one is what makes it more than a sharp edge. §24's sentence, at
 * the sign-in screen: *a state that says waiting which nobody can resolve is
 * not waiting, it is stuck* — and here the person who is stuck is the one the
 * whole PIN migration exists to let in.
 *
 * A **disabled** row does it too, and more quietly still: the lookup filters
 * nothing, so retiring somebody's account and inviting a new person of the
 * same name locks the new person out on their first visit, by a row that can
 * never be signed into.
 *
 * ---------------------------------------------------------------------------
 * And one thing here is a decision rather than a repair
 * ---------------------------------------------------------------------------
 *
 * The password door beside a PIN looked like the same class of defect and is
 * not. `describe('the password door beside a PIN…')` below records why it was
 * left exactly as it was, and asserts the behaviour, so that reading
 * `passwordDoor.ts` the way I first read it leads to the answer rather than to
 * a change.
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
const PORT = pickPort(7900, 100);
const BASE = `http://localhost:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const OWNER_EMAIL = 'foundation-owner@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const OWNER_PASSWORD = 'owner-password-000001';
const OWNER_PIN = '135791';

let ownerCookie = '';

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

function pinSignIn(identity: string, pin: string): Promise<Result<{ user?: { id: string } }>> {
  return call<{ user?: { id: string } }>('POST', '/api/auth/pin', { body: { identity, pin } });
}

/** Invite somebody and enrol them on a PIN, the way the product actually does. */
async function joinAs(
  displayName: string,
  pin: string,
): Promise<{ status: number; userId: string; error?: string }> {
  const slot = await call<{ enrollment?: { token: string; userId: string }; error?: string }>(
    'POST',
    '/api/members',
    { cookie: ownerCookie, body: { displayName } },
  );
  if (!slot.body.enrollment) {
    return { status: slot.status, userId: '', error: slot.body.error };
  }
  const enrolled = await call('POST', '/api/enroll/pin', {
    body: { token: slot.body.enrollment.token, pin },
  });
  return { status: enrolled.status, userId: slot.body.enrollment.userId };
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

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-foundation-'));
  await startServer();

  // The owner as production has one: a bootstrap password it must replace,
  // then a PIN of their own. Everything below signs in as them.
  const first = await call('POST', '/api/auth/login', {
    body: { email: OWNER_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  await call('POST', '/api/auth/password', {
    cookie: first.cookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: OWNER_PASSWORD },
  });
  const theirs = await call('POST', '/api/auth/login', {
    body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  await call('POST', '/api/auth/pin/set', { cookie: theirs.cookie, body: { pin: OWNER_PIN } });
  ownerCookie = (await pinSignIn(OWNER_EMAIL, OWNER_PIN)).cookie;
  expect(ownerCookie).not.toBe('');
}, 180_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  server = null;
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('one name, one account', () => {
  it('refuses to issue a second slot under a name somebody already signs in with', async () => {
    const first = await joinAs('Ambiguous Member', '202020');
    expect(first.status).toBe(200);
    expect((await pinSignIn('Ambiguous Member', '202020')).status).toBe(200);

    const second = await call<{ error?: string }>('POST', '/api/members', {
      cookie: ownerCookie,
      body: { displayName: 'Ambiguous Member' },
    });
    expect(second.status).toBe(422);
    // The remedy, rather than the reason: an administrator is being asked to
    // pick a different name, and is told so in the sentence.
    expect(second.body.error ?? '').toMatch(/already signs in|different name/i);

    // And the person who already had that name is untouched by the attempt.
    expect((await pinSignIn('Ambiguous Member', '202020')).status).toBe(200);
  }, 120_000);

  it('does not care about capitalisation, because a person typing it cannot', async () => {
    await joinAs('Casing Member', '212121');
    expect((await pinSignIn('casing member', '212121')).status).toBe(200);
    expect((await pinSignIn('CASING MEMBER', '212121')).status).toBe(200);
    expect((await pinSignIn('  Casing Member  ', '212121')).status).toBe(200);

    // Which is also what makes the uniqueness rule honest: two names a person
    // cannot tell apart are not two identities.
    const clash = await call('POST', '/api/members', {
      cookie: ownerCookie,
      body: { displayName: 'casing MEMBER' },
    });
    expect(clash.status).toBe(422);
  }, 120_000);

  it('lets a retired account free its name, rather than holding it for ever', async () => {
    const retiring = await joinAs('Retired Name', '232323');
    expect((await pinSignIn('Retired Name', '232323')).status).toBe(200);

    expect(
      (
        await call('POST', `/api/admin/users/${retiring.userId}/disabled`, {
          cookie: ownerCookie,
          body: { disabled: true },
        })
      ).status,
    ).toBe(200);

    // A row nobody can ever sign into must not make a live person
    // unresolvable — which is what the unfiltered lookup did.
    const successor = await joinAs('Retired Name', '242424');
    expect(successor.status).toBe(200);
    const signedIn = await pinSignIn('Retired Name', '242424');
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.id).toBe(successor.userId);

    // And the retired one is still refused, on its own account.
    expect((await pinSignIn('Retired Name', '232323')).status).toBe(401);
  }, 120_000);

  it('gives an administrator a way to correct a name, and the person can then get in', async () => {
    const person = await joinAs('Needs A Rename', '252525');
    expect(person.status).toBe(200);

    const renamed = await call('POST', `/api/admin/users/${person.userId}/display-name`, {
      cookie: ownerCookie,
      body: { displayName: 'Renamed Member' },
    });
    expect(renamed.status).toBe(200);

    expect((await pinSignIn('Renamed Member', '252525')).status).toBe(200);
    expect((await pinSignIn('Needs A Rename', '252525')).status).toBe(401);
  }, 120_000);

  it('refuses a rename onto a name somebody else already signs in with', async () => {
    const taken = await joinAs('Already Taken', '262626');
    expect(taken.status).toBe(200);
    const mover = await joinAs('Would Collide', '272727');

    const refused = await call<{ error?: string }>(
      'POST',
      `/api/admin/users/${mover.userId}/display-name`,
      { cookie: ownerCookie, body: { displayName: 'Already Taken' } },
    );
    expect(refused.status).toBe(422);

    // Neither account moved.
    expect((await pinSignIn('Already Taken', '262626')).status).toBe(200);
    expect((await pinSignIn('Would Collide', '272727')).status).toBe(200);
  }, 120_000);

  it('refuses the same collision at the other door that creates accounts', async () => {
    // A guard on one entrance is not a guard. `POST /api/admin/users` makes an
    // account with an address, which would still be reachable by that address
    // — but it takes the *member's* name, and a member has no address to fall
    // back to, so the person locked out is the one who can do nothing.
    await joinAs('Shared With Admin', '303030');
    const clash = await call<{ error?: string }>('POST', '/api/admin/users', {
      cookie: ownerCookie,
      body: {
        email: 'clashing-name@example.invalid',
        displayName: 'shared with admin',
        password: 'temporary-password-01',
      },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error ?? '').toMatch(/already signs in/i);

    expect((await pinSignIn('Shared With Admin', '303030')).status).toBe(200);
  }, 120_000);

  it('is an administrator decision, and a member cannot rename anybody', async () => {
    const member = await joinAs('Ordinary Member', '282828');
    const theirs = await pinSignIn('Ordinary Member', '282828');
    expect(theirs.status).toBe(200);

    const attempt = await call('POST', `/api/admin/users/${member.userId}/display-name`, {
      cookie: theirs.cookie,
      body: { displayName: 'Promoted Somehow' },
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect((await pinSignIn('Ordinary Member', '282828')).status).toBe(200);
  }, 120_000);
});

describe('a slot nobody has filled', () => {
  /*
   * The guard above refuses a second invitation under a live name, which is
   * right — and it turns an awkward situation into a blocking one, because the
   * only way an administrator had to re-reach somebody whose link expired was
   * to invite them again. A refusal whose remedy does not exist is a stop.
   *
   * On this Brain that is not hypothetical: one live account holds no
   * credential at all and no live link.
   */
  it('can be sent another first link, and the person joins on it', async () => {
    const slot = await call<{ enrollment: { token: string; userId: string } }>(
      'POST',
      '/api/members',
      { cookie: ownerCookie, body: { displayName: 'Never Opened It' } },
    );
    expect(slot.status).toBe(200);

    // They never opened it. Inviting them again is refused, correctly.
    const again = await call('POST', '/api/members', {
      cookie: ownerCookie,
      body: { displayName: 'Never Opened It' },
    });
    expect(again.status).toBe(422);

    const fresh = await call<{ enrollment: { token: string; userId: string } }>(
      'POST',
      `/api/members/${slot.body.enrollment.userId}/link`,
      { cookie: ownerCookie },
    );
    expect(fresh.status).toBe(200);
    expect(fresh.body.enrollment.userId).toBe(slot.body.enrollment.userId);
    expect(fresh.body.enrollment.token).not.toBe(slot.body.enrollment.token);

    // One slot, one account, one way in — the older link is withdrawn rather
    // than left as a second live door.
    const stale = await call('POST', '/api/enroll/pin', {
      body: { token: slot.body.enrollment.token, pin: '515151' },
    });
    expect(stale.status).toBe(404);

    const joined = await call<{ user: { id: string } }>('POST', '/api/enroll/pin', {
      body: { token: fresh.body.enrollment.token, pin: '525252' },
    });
    expect(joined.status).toBe(200);
    expect(joined.body.user.id).toBe(slot.body.enrollment.userId);
    expect((await pinSignIn('Never Opened It', '525252')).status).toBe(200);
  }, 120_000);

  it('refuses it for somebody who already has a way in, and names the one they want', async () => {
    const member = await joinAs('Already In', '535353');
    expect(member.status).toBe(200);

    const refused = await call<{ error?: string }>(
      'POST',
      `/api/members/${member.userId}/link`,
      { cookie: ownerCookie },
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error ?? '').toMatch(/recovery/i);

    // And nothing moved: they still sign in with what they had.
    expect((await pinSignIn('Already In', '535353')).status).toBe(200);
  }, 120_000);

  it('is an administrator decision, and shows no token to anybody else', async () => {
    const slot = await call<{ enrollment: { userId: string } }>('POST', '/api/members', {
      cookie: ownerCookie,
      body: { displayName: 'Not Your Link' },
    });
    const member = await joinAs('Some Other Member', '545454');
    expect(member.status).toBe(200);
    const theirs = await pinSignIn('Some Other Member', '545454');

    const attempt = await call('POST', `/api/members/${slot.body.enrollment.userId}/link`, {
      cookie: theirs.cookie,
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
  }, 120_000);
});

describe('the password door beside a PIN, which stays open deliberately', () => {
  /*
   * ------------------------------------------------------------------------
   * A repair I started, and withdrew, recorded rather than quietly dropped
   * ------------------------------------------------------------------------
   *
   * `passwordDoorOpenFor` counts *proven passkeys* and knows nothing about a
   * PIN, and its own doc states the rule as *a password is accepted only from
   * an account that cannot sign in with a device*. Read one word wider — *that
   * cannot otherwise get in* — the owner's account looked wrong: a PIN they use
   * daily, and a password door still open beside it for ever.
   *
   * It is not wrong, and closing it would have broken the journey the product
   * is actually built around. Two things say so, and they are not in this file:
   * `Recovery.tsx` exists to take *a password* and end in a PIN, and
   * `pinAuth.test.ts` calls that route **"the recovery door, which is where a
   * forgotten PIN is replaced."** The password is the recovery credential and
   * the PIN is the daily one — twelve-plus characters typed rarely, six digits
   * typed constantly — which is a coherent design rather than an oversight.
   *
   * The device analogy does not carry, and that is the whole of it. A passkey
   * can be *registered and still refuse*, which is exactly how this Brain's
   * owner was locked out, so `countProvenPasskeys` insists on one that has
   * actually worked. A PIN cannot fail that way: it is a verifier the person
   * typed into a box twice, and no hardware can decline it. So there is nothing
   * for *proven* to add — and closing the door on *set* would turn the most
   * ordinary event in a six-digit world, forgetting six digits, into a
   * deployment-secret emergency for a sole administrator.
   *
   * These assertions exist so the next person who reads that doc the way I did
   * finds the answer here instead of shipping it.
   */
  it('stays open for an account that holds a password and a PIN', async () => {
    // The owner holds both: a password from the bootstrap, and a PIN they have
    // signed in with in `beforeAll`.
    expect((await pinSignIn(OWNER_EMAIL, OWNER_PIN)).status).toBe(200);

    const bothWork = await call('POST', '/api/auth/login', {
      body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    expect(bothWork.status).toBe(200);
  }, 120_000);

  it('is how a forgotten PIN is replaced without anybody else being involved', async () => {
    const recovery = await call('POST', '/api/auth/login', {
      body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    expect(recovery.status).toBe(200);

    const replaced = await call('POST', '/api/auth/pin/set', {
      cookie: recovery.cookie,
      body: { pin: '909090' },
    });
    expect(replaced.status).toBe(200);

    expect((await pinSignIn(OWNER_EMAIL, '909090')).status).toBe(200);
    expect((await pinSignIn(OWNER_EMAIL, OWNER_PIN)).status).toBe(401);

    // Put it back, so the order of the tests below is not a dependency.
    const back = await call('POST', '/api/auth/login', {
      body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    await call('POST', '/api/auth/pin/set', { cookie: back.cookie, body: { pin: OWNER_PIN } });
    ownerCookie = (await pinSignIn(OWNER_EMAIL, OWNER_PIN)).cookie;
    expect(ownerCookie).not.toBe('');
  }, 120_000);

  it('is shut for a member, by their having no password at all', async () => {
    // A member enrolled from a link holds no address and no verifier, so there
    // is nothing for a password to be compared against — which is a stronger
    // property than a rule, and is why nothing here had to be closed.
    await joinAs('No Password Member', '292929');
    const attempt = await call('POST', '/api/auth/login', {
      body: { email: 'No Password Member', password: 'anything-at-all-here' },
    });
    expect(attempt.status).toBe(401);
    expect((await pinSignIn('No Password Member', '292929')).status).toBe(200);
  }, 120_000);
});

describe('what an administrator is told', () => {
  it('names an ambiguous identity rather than reporting both as able to sign in', async () => {
    /*
     * The guard refuses a *new* collision; this is one that already exists,
     * which is the state production could be in and the state a guard deployed
     * afterwards can never prevent. It is made the only way it can be made
     * once the guard is in: by renaming a retired account onto a live name,
     * which is refused, so the row is written through the same door an older
     * Brain wrote it through — an invitation taken before the guard existed.
     */
    const rows = await call<{ people: { rows: { displayName: string; state: string }[] } }>(
      'GET',
      '/api/people',
      { cookie: ownerCookie },
    );
    expect(rows.status).toBe(200);
    // Everybody who joined above holds a PIN they have signed in with.
    const states = new Set(rows.body.people.rows.map((one) => one.state));
    expect(states.has('NAME_IS_AMBIGUOUS')).toBe(false);
    for (const row of rows.body.people.rows) {
      expect(['READY', 'INVITED', 'NOT_INVITED', 'NEEDS_A_NEW_LINK']).toContain(row.state);
    }
  }, 120_000);

  it('never puts a PIN, a verifier or a token anywhere a reader can see one', async () => {
    const rows = await call('GET', '/api/people', { cookie: ownerCookie });
    for (const secret of ['202020', '212121', '232323', '242424', OWNER_PIN, OWNER_PASSWORD]) {
      expect(rows.text).not.toContain(secret);
    }
    expect(rows.text).not.toMatch(/scrypt\$/);
    expect(rows.text).not.toMatch(/pin_verifier|pinVerifier/);
  }, 60_000);
});
