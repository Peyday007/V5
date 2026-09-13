/**
 * The invitation journey over a real socket.
 *
 * Every claim in this file is about authorization and about what a caller can
 * actually reach, and neither is answerable from inside the process that decides
 * them — the same reason `authorization.test.ts` and `connectedSites.test.ts`
 * drive a real server. The in-process half, which is about stored state and the
 * guarded statement, is `projectInvitations.test.ts`. Both exist because they
 * fail separately: a correct service reached by no route protects nothing, and a
 * guarded route calling a wrong service protects nothing either.
 *
 * What it is really testing is the set of ways this could be a worse mistake
 * than the direct membership grant it supplements: a machine that could invite
 * people, a member who could, a token recorded in a URL, an invitation id that
 * answers differently depending on whether it exists, a link that works twice,
 * and a refusal a token holder can read a Brain's shape out of.
 *
 * Port range 6700-6799, which no other suite reaches —
 * `deploymentOwnership.test.ts` refuses an overlap, because `/healthz` is
 * unauthenticated and a collision shows up as an unexplained 401 rather than as
 * a bound port.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The `tsx` CLI, found by walking up rather than by a built path.
 *
 * `path.join(REPO_ROOT, 'node_modules', …)` is right exactly when the checkout
 * owns its dependencies, and wrong in a git worktree — where `node_modules`
 * lives in the main checkout and Node finds it by walking up. This walks up the
 * same way. It is not `createRequire().resolve()` because tsx's `exports` map
 * does not publish that subpath, and a resolver that throws on a package it can
 * plainly see is worse than the loop.
 */
function findTsxCli(): string {
  let dir = REPO_ROOT;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('tsx is not installed anywhere above this suite.');
    dir = parent;
  }
}
const TSX_CLI = findTsxCli();
const PORT = 6700 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir: string;
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';
const INVITED_PASSWORD = 'invited-password-00001';

let adminCookie = '';
let memberCookie = '';
let project = '';
let workerBearer = '';

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

async function startServer(): Promise<void> {
  server = spawn(
    process.execPath,
    [TSX_CLI, path.join(REPO_ROOT, 'server', 'index.ts')],
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

const INVITATIONS = (): string => `/api/russell/projects/${project}/invitations`;

interface IssuedBody {
  invitation: { id: string; invitedEmail: string; role: string };
  invitationUrl: string;
  expiresAt: string;
  accountExists: boolean;
  whatHappensNext: string;
  replaced: number;
}

function tokenOf(url: string): string {
  return url.split('#')[1] ?? '';
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-invite-'));
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

  /*
   * A second project would be the cleanest boundary here and there is no route
   * that makes one: creating a project is `npm run admin` on a terminal (§26),
   * deliberately. So the "nothing outside it" half is asserted against the
   * surfaces that do exist over HTTP — Brain-wide administration, and project
   * administration on the very project the person was invited to — and the
   * cross-project denial is driven from rows in `projectInvitations.test.ts`
   * and in the Step 12B acceptance reporter, both of which can make one.
   */

  // Somebody on the project who does not administer it.
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: {
      email: 'member@example.invalid',
      displayName: 'Member',
      password: 'temporary-password-01',
    },
  });
  const first = await signIn('member@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: MEMBER_PASSWORD },
  });
  memberCookie = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: created.body.user.id, principalType: 'HUMAN', role: 'MEMBER' },
  });

  // A worker with real scopes and real membership, so the refusal below is
  // demonstrably by principal type rather than by a missing scope.
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'an-invitation-worker', displayName: 'Machine' },
  });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      scopes: ['project:read', 'work:claim', 'queue:claim'],
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

describe('who may invite', () => {
  it('refuses a machine by principal type, however it is configured', async () => {
    const list = await call('GET', INVITATIONS(), { bearer: workerBearer });
    const invite = await call('POST', INVITATIONS(), {
      bearer: workerBearer,
      body: { email: 'never@example.invalid', role: 'ADMIN' },
    });
    expect(list.status).toBe(404);
    expect(invite.status).toBe(404);
  });

  it('refuses a member who does not administer the project, as a missing project', async () => {
    const invite = await call('POST', INVITATIONS(), {
      cookie: memberCookie,
      body: { email: 'never@example.invalid', role: 'MEMBER' },
    });
    const missing = await call('POST', '/api/russell/projects/prj_nothing_here/invitations', {
      cookie: memberCookie,
      body: { email: 'never@example.invalid', role: 'MEMBER' },
    });
    expect(invite.status).toBe(404);
    // Absent and forbidden are one answer, body included.
    expect(invite.text).toBe(missing.text);

    // And reading the list is the same level, because a pending invitation
    // names an address belonging to somebody who is not on the project yet.
    const list = await call('GET', INVITATIONS(), { cookie: memberCookie });
    expect(list.status).toBe(404);
    expect(list.text).toBe(missing.text);
  });

  it('refuses an anonymous caller', async () => {
    expect((await call('GET', INVITATIONS())).status).toBe(401);
    expect(
      (await call('POST', INVITATIONS(), { body: { email: 'x@example.invalid' } })).status,
    ).toBe(401);
  });

  it('lets an administrator read the list, and reading creates nothing', async () => {
    const before = await call<{ invitations: unknown[]; roles: string[]; defaultRole: string }>(
      'GET',
      INVITATIONS(),
      { cookie: adminCookie },
    );
    expect(before.status).toBe(200);
    // The contract travels with the view rather than being restated in the
    // client, so the roles a person is offered are the roles the server accepts.
    expect(before.body.roles).toContain('MEMBER');
    expect(before.body.defaultRole).toBe('MEMBER');
    const again = await call<{ invitations: unknown[] }>('GET', INVITATIONS(), {
      cookie: adminCookie,
    });
    expect(again.body.invitations.length).toBe(before.body.invitations.length);
  });
});

describe('the invitation journey', () => {
  let token = '';
  let invitationId = '';

  it('issues a link whose token is only ever in the fragment', async () => {
    const issued = await call<IssuedBody>('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'Invited.Person@Example.Invalid' },
    });
    expect(issued.status).toBe(201);
    token = tokenOf(issued.body.invitationUrl);
    invitationId = issued.body.invitation.id;

    expect(token.startsWith('brnv_')).toBe(true);
    // Nothing a server or a proxy records contains it.
    expect(issued.body.invitationUrl.split('#')[0]).toMatch(/\/invite$/);
    expect(issued.body.invitationUrl.split('#')[0]).not.toContain(token);
    // The address is normalised once, at the boundary.
    expect(issued.body.invitation.invitedEmail).toBe('invited.person@example.invalid');
    // Unsaid role is the prefilled default rather than a guess.
    expect(issued.body.invitation.role).toBe('MEMBER');
    expect(issued.body.accountExists).toBe(false);
    expect(issued.body.whatHappensNext).toMatch(/no Brain account yet/);
  });

  it('never hands the token back on any later read', async () => {
    const list = await call('GET', INVITATIONS(), { cookie: adminCookie });
    expect(list.text).not.toContain(token);
    const who = await call('GET', `/api/russell/projects/${project}/who`, {
      cookie: adminCookie,
    });
    expect(who.text).not.toContain(token);
    const events = await call('GET', '/api/admin/identity-events?limit=200', {
      cookie: adminCookie,
    });
    expect(events.text).not.toContain(token);
    // The invitation is on the audit by id, which is the thing that may be named.
    expect(events.text).toContain(invitationId);
  });

  it('shows the pending invitation to an administrator of the project and to nobody else', async () => {
    const asAdmin = await call<{ invitations: { email: string }[] | null }>(
      'GET',
      `/api/russell/projects/${project}/who`,
      { cookie: adminCookie },
    );
    expect(asAdmin.body.invitations?.some((e) => e.email === 'invited.person@example.invalid')).toBe(
      true,
    );
    const asMember = await call<{ invitations: unknown | null }>(
      'GET',
      `/api/russell/projects/${project}/who`,
      { cookie: memberCookie },
    );
    // Null rather than an empty list: a different answer, not a filtered one.
    expect(asMember.body.invitations).toBeNull();
  });

  it('previews without a session and without consuming the invitation', async () => {
    const preview = await call<{
      projectName: string;
      role: string;
      invitedEmail: string;
      accountNeeded: boolean;
      acceptable: boolean;
    }>('POST', '/api/invitations/preview', { body: { token } });
    expect(preview.status).toBe(200);
    expect(preview.body.role).toBe('MEMBER');
    expect(preview.body.invitedEmail).toBe('invited.person@example.invalid');
    expect(preview.body.accountNeeded).toBe(true);
    expect(preview.body.acceptable).toBe(true);

    // Still live afterwards: opening a link a person may lose must not spend it.
    const again = await call('POST', '/api/invitations/preview', { body: { token } });
    expect(again.status).toBe(200);
  });

  it('accepts, and the membership is the role the invitation named', async () => {
    const accepted = await call<{
      projectId: string;
      role: string;
      createdAccount: boolean;
      signInRequired: boolean;
      email: string;
    }>('POST', '/api/invitations/accept', {
      body: {
        token,
        password: INVITED_PASSWORD,
        displayName: 'An invited collaborator',
        // Neither of these is read. The role comes from the invitation and Brain
        // administration is not something a project invitation may confer.
        role: 'OWNER',
        isBrainAdmin: true,
      },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.role).toBe('MEMBER');
    expect(accepted.body.createdAccount).toBe(true);
    expect(accepted.body.signInRequired).toBe(true);
    expect(accepted.body.email).toBe('invited.person@example.invalid');
    // Accepting hands out no session: no cookie, and nothing else to sign in with.
    expect(accepted.text).not.toContain('Set-Cookie');

    const members = await call<{ members: { principalId: string; role: string | null }[] }>(
      'GET',
      `/api/admin/projects/${project}/members`,
      { cookie: adminCookie },
    );
    expect(members.body.members.some((m) => m.role === 'MEMBER')).toBe(true);
  });

  it('lets the new person reach what that role permits, and nothing more', async () => {
    const cookie = await signIn('invited.person@example.invalid', INVITED_PASSWORD);

    // READ on the project they were invited to.
    expect((await call('GET', `/api/projects/${project}`, { cookie })).status).toBe(200);
    // WRITE, which MEMBER carries.
    expect(
      (await call('GET', `/api/russell/projects/${project}/who`, { cookie })).status,
    ).toBe(200);
    // Not ADMIN: membership administration is refused as a missing project.
    const asAdmin = await call('POST', INVITATIONS(), {
      cookie,
      body: { email: 'chain@example.invalid' },
    });
    expect(asAdmin.status).toBe(404);
    // Brain-wide administration was not conferred either.
    expect((await call('GET', '/api/admin/users', { cookie })).status).toBe(404);
  });

  it('refuses a second redemption in the same body an unknown token gets', async () => {
    const again = await call('POST', '/api/invitations/accept', {
      body: { token, password: INVITED_PASSWORD },
    });
    const unknown = await call('POST', '/api/invitations/accept', {
      body: { token: 'brnv_0123456789abcdef.cccccccccccccccccccccccccccccccc' },
    });
    const malformed = await call('POST', '/api/invitations/accept', { body: { token: 'nonsense' } });
    const absent = await call('POST', '/api/invitations/accept', { body: {} });

    expect(again.status).toBe(404);
    // Byte-identical, not merely the same status.
    expect(again.text).toBe(unknown.text);
    expect(again.text).toBe(malformed.text);
    expect(again.text).toBe(absent.text);
    // And it names a remedy rather than a reason.
    expect(again.text).toMatch(/Ask whoever invited you to send a new one/);
  });
});

describe('an invitation id is not an oracle', () => {
  it('answers a real id and a guessed one identically, to a caller not entitled to either', async () => {
    const real = await call<IssuedBody>('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'oracle@example.invalid', role: 'VIEWER' },
    });
    expect(real.status).toBe(201);

    // The member is on this project and does not administer it, so both of
    // these must read the same — an id that exists and an id that does not.
    const asksAboutReal = await call('POST', `${INVITATIONS()}/${real.body.invitation.id}/withdraw`, {
      cookie: memberCookie,
      body: {},
    });
    const asksAboutNothing = await call(
      'POST',
      `${INVITATIONS()}/pinv_0000000000000000000/withdraw`,
      { cookie: memberCookie, body: {} },
    );
    expect(asksAboutReal.status).toBe(404);
    // Byte-identical, not merely the same status: a body that differed would be
    // the oracle the status code was hidden to prevent.
    expect(asksAboutReal.text).toBe(asksAboutNothing.text);

    /*
     * An administrator's own miss is a *different* sentence, and that is the
     * two boundaries §24 describes rather than a leak.
     *
     * The project gate refuses the member before an invitation id is ever
     * looked at, so every id they can name — real, withdrawn or invented —
     * reads identically. An administrator has passed that gate and can already
     * list every invitation on the project, so telling them one of their own
     * ids is absent discloses nothing they could not read directly. What must
     * still be indistinguishable for them is an id belonging to a project they
     * do *not* administer, which needs a second project and therefore lives in
     * `projectInvitations.test.ts`, where one can be made without a route.
     */
    const adminMissOne = await call('POST', `${INVITATIONS()}/pinv_1111111111111111111/withdraw`, {
      cookie: adminCookie,
      body: {},
    });
    const adminMissTwo = await call('POST', `${INVITATIONS()}/pinv_2222222222222222222/withdraw`, {
      cookie: adminCookie,
      body: {},
    });
    expect(adminMissOne.status).toBe(404);
    expect(adminMissOne.text).toBe(adminMissTwo.text);
    expect(adminMissOne.text).not.toBe(asksAboutNothing.text);

    // Nothing happened to the real one: a refused withdrawal changes no rows.
    const stillThere = await call<{ invitations: { id: string; state: string }[] }>(
      'GET',
      INVITATIONS(),
      { cookie: adminCookie },
    );
    expect(stillThere.body.invitations.find((e) => e.id === real.body.invitation.id)?.state).toBe(
      'PENDING',
    );
  });
});

describe('withdrawing, and inviting again', () => {
  it('withdraws before use, and the link is then refused identically', async () => {
    const issued = await call<IssuedBody>('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'withdrawn@example.invalid', role: 'VIEWER' },
    });
    const token = tokenOf(issued.body.invitationUrl);

    const withdrawn = await call<{ withdrawn: boolean; alreadyFinished: boolean }>(
      'POST',
      `${INVITATIONS()}/${issued.body.invitation.id}/withdraw`,
      { cookie: adminCookie, body: {} },
    );
    expect(withdrawn.body.withdrawn).toBe(true);

    const refused = await call('POST', '/api/invitations/accept', { body: { token } });
    const unknown = await call('POST', '/api/invitations/accept', {
      body: { token: 'brnv_0123456789abcdef.dddddddddddddddddddddddddddddddd' },
    });
    expect(refused.text).toBe(unknown.text);

    // Withdrawing twice is not an error; it says there was nothing to do.
    const again = await call<{ withdrawn: boolean; alreadyFinished: boolean }>(
      'POST',
      `${INVITATIONS()}/${issued.body.invitation.id}/withdraw`,
      { cookie: adminCookie, body: {} },
    );
    expect(again.body.withdrawn).toBe(false);
    expect(again.body.alreadyFinished).toBe(true);
  });

  it('replaces an unused invitation to the same address rather than accumulating', async () => {
    const first = await call<IssuedBody>('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'again@example.invalid', role: 'MEMBER' },
    });
    const second = await call<IssuedBody>('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'again@example.invalid', role: 'VIEWER' },
    });
    expect(second.body.replaced).toBe(1);

    const old = await call('POST', '/api/invitations/accept', {
      body: { token: tokenOf(first.body.invitationUrl) },
    });
    expect(old.status).toBe(404);

    const list = await call<{ invitations: { email: string; state: string; role: string }[] }>(
      'GET',
      INVITATIONS(),
      { cookie: adminCookie },
    );
    const live = list.body.invitations.filter(
      (e) => e.email === 'again@example.invalid' && e.state === 'PENDING',
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.role).toBe('VIEWER');
  });

  it('refuses an address that is not one', async () => {
    const bad = await call('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'not-an-address' },
    });
    expect(bad.status).toBe(400);
    const badRole = await call('POST', INVITATIONS(), {
      cookie: adminCookie,
      body: { email: 'fine@example.invalid', role: 'SUPERUSER' },
    });
    expect(badRole.status).toBe(400);
  });
});
