/**
 * `npm run verify:hosted` — prove the live Brain's identity and authorization
 * work, against the real deployment, over the real internet.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Step 4's test suite is green and proves nothing about the hosted Brain. It
 * runs against SQLite and a loopback socket; the deployment runs against
 * Supabase Postgres behind Fly's edge with TLS, a proxy and a cookie that only
 * a real browser origin ever sees. Those are different programs in every way
 * that authorization can go wrong, and the honest verdict on "is the live Brain
 * actually shut" cannot come from a test that never touched it.
 *
 * The alternative was a person following a list of curl commands, which is the
 * thing this project has been removing since Step 3, and which nobody would
 * ever run twice.
 *
 * ---------------------------------------------------------------------------
 * Why it runs inside the container
 * ---------------------------------------------------------------------------
 *
 * A hosted authorization test needs two capabilities at once: it must be able
 * to *mint* principals — a member, a non-member, a worker with a credential —
 * and it must reach the public URL as an outsider would. Anything running from
 * a laptop or a CI runner has the second and not the first, and gets the first
 * only by being handed an administrator's password, which puts a live
 * credential into a second system for the rest of time.
 *
 * Inside the container, both are free. The database is already open and the
 * public URL is one HTTPS call away, so the fixtures are created server-side
 * and every assertion is still made from outside, through the edge, exactly as
 * an attacker would arrive. No credential is stored anywhere, and none is
 * printed: every secret here is generated at the start of the run and disabled
 * at the end of it.
 *
 * ---------------------------------------------------------------------------
 * What it does not do
 * ---------------------------------------------------------------------------
 *
 * It never touches a real project's rows. The one project it needs a *member*
 * of is its own, created once and reused; the project it must be refused is the
 * real one, and the only thing it ever does with that is ask for it and be told
 * it does not exist.
 *
 * It deletes nothing. The fixtures are disabled rather than removed, because
 * `identity_events` records what happened to them and a cascade that erased the
 * subject of an audit row would be the thing invariant 5 forbids.
 */
import crypto from 'node:crypto';
import { describePersistence, persistenceConfig } from '../server/config.ts';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import {
  createUser,
  createWorker,
  getUserByEmail,
  getWorkerByName,
  grantMembership,
  issueWorkerCredential,
  revokeCredential,
  revokeSessionsForUser,
  setUserDisabled,
  setUserPassword,
  setWorkerStatus,
} from '../server/repos/identity.ts';
import { createProject, getProjectBySlug, listProjects } from '../server/repos/projects.ts';
import type { Project } from '../server/domain/types.ts';

/* ------------------------------------------------------------------------ */
/* The fixtures                                                              */
/* ------------------------------------------------------------------------ */

/**
 * `.invalid` is reserved by RFC 2606 and can never be a real address, so these
 * accounts cannot collide with a person's and cannot be mailed by accident.
 */
const MEMBER_EMAIL = 'verification-member@brain.invalid';
const WORKER_NAME = 'verification-worker';
const FIXTURE_SLUG = 'verification-scope';

/** Long enough that the run is not testing the password policy by accident. */
function freshPassword(): string {
  return `V-${crypto.randomBytes(24).toString('base64url')}`;
}

/* ------------------------------------------------------------------------ */
/* The report                                                                */
/* ------------------------------------------------------------------------ */

interface Check {
  name: string;
  detail: string;
  ok: boolean;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** An expectation about one response, stated as the status it must have. */
function expectStatus(name: string, actual: number, expected: number, note = ''): void {
  record(name, actual === expected, `${actual}${actual === expected ? '' : ` (wanted ${expected})`}${note ? ` · ${note}` : ''}`);
}

/* ------------------------------------------------------------------------ */
/* Talking to the live Brain                                                 */
/* ------------------------------------------------------------------------ */

interface Reply {
  status: number;
  body: string;
  cookie: string | null;
  json: unknown;
}

let base = '';

async function call(
  path: string,
  init: { method?: string; cookie?: string; bearer?: string; body?: unknown; origin?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.cookie) headers['cookie'] = init.cookie;
  if (init.bearer) headers['authorization'] = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  // A cookie-authenticated mutation carries an Origin in a browser, and the
  // server refuses one that does not match. Sending the real origin is what a
  // browser does; sending none is what a cross-site form does, and there is a
  // check below for exactly that difference.
  if (init.origin) headers['origin'] = init.origin;

  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
  });
  const body = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* not every response is JSON, and that is not a failure of this helper */
  }
  return {
    status: response.status,
    body,
    cookie: response.headers.get('set-cookie'),
    json,
  };
}

/** The `brain_session=…` pair from a Set-Cookie, without its attributes. */
function sessionPair(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = /(^|,\s*)(brain_session=[^;]+)/.exec(setCookie);
  return match ? (match[2] ?? null) : null;
}

/* ------------------------------------------------------------------------ */
/* Setting the fixtures up                                                   */
/* ------------------------------------------------------------------------ */

interface Fixtures {
  memberPassword: string;
  memberId: string;
  scope: Project;
  holdout: Project | null;
  credential: string;
  credentialId: string;
  secondCredential: string;
  secondCredentialId: string;
  expiredCredential: string;
  expiredCredentialId: string;
  workerId: string;
}

async function setUp(): Promise<Fixtures> {
  // The project this run is a member of. Created once and reused, so repeated
  // verification does not litter the Brain with projects.
  const scope =
    (await getProjectBySlug(FIXTURE_SLUG)) ??
    (await createProject({
      name: 'Verification scope',
      slug: FIXTURE_SLUG,
      description:
        'Created by scripts/verify-hosted.ts. It exists so hosted authorization can be ' +
        'proven against a project that is not a real one. Safe to ignore.',
    }));

  // The project this run must be *refused*. Whichever real project exists —
  // never written to, never read beyond its id, only asked for and denied.
  const holdout = (await listProjects()).find((project) => project.id !== scope.id) ?? null;

  const memberPassword = freshPassword();
  const existing = await getUserByEmail(MEMBER_EMAIL);
  let memberId: string;
  if (existing) {
    await setUserPassword(existing.id, memberPassword, { mustChangePassword: false });
    if (existing.disabled) await setUserDisabled(existing.id, false);
    // Every session a previous run left behind, ended: this run's assertions
    // are about this run's cookie.
    await revokeSessionsForUser(existing.id);
    memberId = existing.id;
  } else {
    const created = await createUser({
      email: MEMBER_EMAIL,
      displayName: 'Hosted verification',
      password: memberPassword,
      isBrainAdmin: false,
      mustChangePassword: false,
    });
    memberId = created.id;
  }

  await grantMembership({
    projectId: scope.id,
    principalType: 'HUMAN',
    principalId: memberId,
    role: 'MEMBER',
    grantedByType: 'SYSTEM',
    grantedById: 'verify-hosted',
  });

  const worker =
    (await getWorkerByName(WORKER_NAME)) ??
    (await createWorker({
      name: WORKER_NAME,
      displayName: 'Hosted verification worker',
      workerType: 'GENERIC',
      description: 'Created by scripts/verify-hosted.ts. Disabled between runs.',
      createdByType: 'SYSTEM',
      createdById: 'verify-hosted',
    }));
  await setWorkerStatus(worker.id, 'ACTIVE');

  await grantMembership({
    projectId: scope.id,
    principalType: 'WORKER',
    principalId: worker.id,
    // Read only. A worker that could write would be testing a wider grant than
    // the narrowest one that proves authentication works.
    role: null,
    scopes: ['project:read', 'documents:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'verify-hosted',
  });

  const issued = await issueWorkerCredential({
    workerId: worker.id,
    issuedByType: 'SYSTEM',
    issuedById: 'verify-hosted',
  });
  // A second, so revocation can be proven without ending the run's own access.
  const second = await issueWorkerCredential({
    workerId: worker.id,
    issuedByType: 'SYSTEM',
    issuedById: 'verify-hosted',
  });
  const expired = await issueWorkerCredential({
    workerId: worker.id,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    issuedByType: 'SYSTEM',
    issuedById: 'verify-hosted',
  });

  return {
    memberPassword,
    memberId,
    scope,
    holdout,
    credential: issued.plaintext,
    credentialId: issued.credential.id,
    secondCredential: second.plaintext,
    secondCredentialId: second.credential.id,
    expiredCredential: expired.plaintext,
    expiredCredentialId: expired.credential.id,
    workerId: worker.id,
  };
}

/* ------------------------------------------------------------------------ */
/* The checks                                                                */
/* ------------------------------------------------------------------------ */

async function anonymousIsRefused(fixtures: Fixtures): Promise<void> {
  console.log('\nAnonymous callers');

  const health = await call('/healthz');
  expectStatus('liveness answers without a credential', health.status, 200);

  const projects = await call('/api/projects');
  expectStatus('the project list refuses an anonymous caller', projects.status, 401);

  const readiness = await call('/api/health');
  expectStatus('the readiness report refuses an anonymous caller', readiness.status, 401);

  const named = await call(`/api/projects/${fixtures.scope.id}`);
  expectStatus('a project by id refuses an anonymous caller', named.status, 401);

  const admin = await call('/api/admin/users');
  expectStatus('the administration API refuses an anonymous caller', admin.status, 401);

  // The one thing that must stay open, or nobody can ever sign in.
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  record('the sign-in page itself is reachable', page.status === 200, `${page.status}`);

  // Nothing about the installation may leak before authentication.
  const leaked = [readiness.body, projects.body, admin.body].join(' ');
  const names = ['supabase', 'postgres', 'pooler', 'BRAIN_', 'bucket'];
  const found = names.filter((name) => leaked.toLowerCase().includes(name.toLowerCase()));
  record(
    'a refusal says nothing about where this Brain keeps its data',
    found.length === 0,
    found.length === 0 ? 'nothing named' : `leaked: ${found.join(', ')}`,
  );
}

async function humanAuthentication(fixtures: Fixtures): Promise<string> {
  console.log('\nSigning in');

  const wrong = await call('/api/auth/login', {
    method: 'POST',
    origin: base,
    body: { email: MEMBER_EMAIL, password: `${fixtures.memberPassword}x` },
  });
  expectStatus('the wrong password is refused', wrong.status, 401);

  const unknown = await call('/api/auth/login', {
    method: 'POST',
    origin: base,
    body: { email: 'nobody-at-all@brain.invalid', password: 'irrelevant-but-long-enough' },
  });
  expectStatus('an unknown address is refused', unknown.status, 401);
  record(
    'a wrong password and an unknown address are refused identically',
    wrong.body === unknown.body,
    wrong.body === unknown.body ? 'same response' : 'the two refusals differ, which enumerates accounts',
  );

  const good = await call('/api/auth/login', {
    method: 'POST',
    origin: base,
    body: { email: MEMBER_EMAIL, password: fixtures.memberPassword },
  });
  expectStatus('the right password is accepted', good.status, 200);

  const raw = good.cookie ?? '';
  record('the session cookie is HttpOnly', /httponly/i.test(raw), raw ? 'set' : 'no cookie at all');
  // `Secure` is only correct over TLS: a local http run must not fail for
  // refusing to set a flag the browser would then never send back.
  if (base.startsWith('https://')) {
    record('the session cookie is Secure', /;\s*secure/i.test(raw), '');
  } else {
    record('the session cookie is Secure', true, 'not applicable over http; skipped');
  }
  record('the session cookie is SameSite=Lax', /samesite=lax/i.test(raw), '');
  record(
    'the session cookie is not the session secret in readable form',
    !raw.includes(fixtures.memberPassword),
    '',
  );

  const cookie = sessionPair(good.cookie);
  if (!cookie) {
    record('a usable session cookie came back', false, 'no brain_session pair in Set-Cookie');
    return '';
  }
  record('a usable session cookie came back', true, '');

  const session = await call('/api/auth/session', { cookie });
  const authenticated =
    session.status === 200 &&
    typeof session.json === 'object' &&
    session.json !== null &&
    (session.json as { authenticated?: unknown }).authenticated === true;
  record('the cookie identifies the account on the next request', authenticated, `${session.status}`);

  return cookie;
}

async function humanAuthorization(fixtures: Fixtures, cookie: string): Promise<void> {
  console.log('\nWhat a member may and may not reach');
  if (!cookie) {
    record('member authorization', false, 'skipped: there was no session to test with');
    return;
  }

  const list = await call('/api/projects', { cookie });
  expectStatus('a member may list projects', list.status, 200);
  const projects = ((list.json as { projects?: { id: string }[] })?.projects ?? []).map((p) => p.id);
  record(
    'the list contains the project it is a member of',
    projects.includes(fixtures.scope.id),
    `${projects.length} project(s) visible`,
  );

  if (fixtures.holdout) {
    record(
      'the list does not contain the project it is not a member of',
      !projects.includes(fixtures.holdout.id),
      projects.includes(fixtures.holdout.id) ? 'the holdout was visible' : 'holdout absent',
    );

    const denied = await call(`/api/projects/${fixtures.holdout.id}`, { cookie });
    expectStatus(
      'asking for that project by id is refused',
      denied.status,
      404,
      'and 404 rather than 403, so it is not an oracle',
    );

    const missing = await call('/api/projects/prj_does_not_exist_at_all', { cookie });
    record(
      'a project that exists-but-is-forbidden is indistinguishable from one that does not exist',
      denied.status === missing.status,
      `forbidden ${denied.status} · absent ${missing.status}`,
    );

    const files = await call(`/files/${fixtures.holdout.slug}/documents/anything.pdf`, { cookie });
    record(
      'a document under that project is refused too',
      files.status === 404 || files.status === 403,
      `${files.status}`,
    );
  } else {
    record('a second project existed to be refused', false, 'only one project in this Brain');
  }

  const own = await call(`/api/projects/${fixtures.scope.id}`, { cookie });
  expectStatus('the project it is a member of is served', own.status, 200);

  const admin = await call('/api/admin/users', { cookie });
  expectStatus('the administration API is refused to a member', admin.status, 404);

  // A cookie without a matching Origin is a cross-site request, and a mutation
  // is exactly where that matters.
  const forged = await call('/api/projects', {
    method: 'POST',
    cookie,
    origin: 'https://not-this-brain.example',
    body: { name: 'forged' },
  });
  record(
    'a cookie-authenticated mutation from another origin is refused',
    forged.status === 403 || forged.status === 401,
    `${forged.status}`,
  );
}

async function workerAuthentication(fixtures: Fixtures): Promise<void> {
  console.log('\nWorker credentials');

  const good = await call('/api/projects', { bearer: fixtures.credential });
  expectStatus('a valid worker credential authenticates', good.status, 200);
  const visible = ((good.json as { projects?: { id: string }[] })?.projects ?? []).map((p) => p.id);
  record(
    'the worker sees only the project it was granted',
    visible.length === 1 && visible[0] === fixtures.scope.id,
    `${visible.length} project(s)`,
  );

  if (fixtures.holdout) {
    const denied = await call(`/api/projects/${fixtures.holdout.id}`, { bearer: fixtures.credential });
    expectStatus('the worker is refused a project it was not granted', denied.status, 404);
  }

  // Read scopes only, so a write must be refused even inside its own project.
  const write = await call(`/api/projects/${fixtures.scope.id}`, {
    method: 'PATCH',
    bearer: fixtures.credential,
    body: { description: 'a worker with read scopes should not be able to write this' },
  });
  record(
    'a read-scoped worker may not write',
    write.status === 404 || write.status === 403,
    `${write.status}`,
  );

  const prefix = fixtures.credential.split('.')[0] ?? '';
  const wrongSecret = await call('/api/projects', {
    bearer: `${prefix}.${crypto.randomBytes(24).toString('base64url')}`,
  });
  expectStatus('a real prefix with the wrong secret is refused', wrongSecret.status, 401);

  const nonsense = await call('/api/projects', { bearer: 'brnw_0123456789abcdef.not-a-real-secret' });
  expectStatus('an invented credential is refused', nonsense.status, 401);

  const notEvenShaped = await call('/api/projects', { bearer: 'hello' });
  expectStatus('a malformed credential is refused', notEvenShaped.status, 401);

  const expired = await call('/api/projects', { bearer: fixtures.expiredCredential });
  expectStatus('an expired credential is refused', expired.status, 401);

  // Revocation, proven to take effect on the very next request rather than at
  // some later renewal.
  const beforeRevoke = await call('/api/projects', { bearer: fixtures.secondCredential });
  expectStatus('the second credential works before it is revoked', beforeRevoke.status, 200);
  await revokeCredential(fixtures.secondCredentialId, 'hosted verification');
  const afterRevoke = await call('/api/projects', { bearer: fixtures.secondCredential });
  expectStatus('and is refused on the next request after revocation', afterRevoke.status, 401);

  const asHuman = await call('/api/auth/session', { bearer: fixtures.credential });
  const notAPerson =
    asHuman.status !== 200 ||
    (typeof asHuman.json === 'object' &&
      asHuman.json !== null &&
      (asHuman.json as { authenticated?: unknown }).authenticated !== true);
  record('a worker credential does not make the caller a person', notAPerson, `${asHuman.status}`);
}

async function revocationEndsAccess(fixtures: Fixtures, cookie: string): Promise<void> {
  console.log('\nTaking access away');

  // Disabling the worker must refuse the credential that was working a line ago.
  await setWorkerStatus(fixtures.workerId, 'DISABLED');
  const disabledWorker = await call('/api/projects', { bearer: fixtures.credential });
  expectStatus('disabling a worker refuses its credential immediately', disabledWorker.status, 401);

  if (cookie) {
    const beforeLogout = await call('/api/projects', { cookie });
    expectStatus('the session still works before signing out', beforeLogout.status, 200);
    await call('/api/auth/logout', { method: 'POST', cookie, origin: base });
    const afterLogout = await call('/api/projects', { cookie });
    expectStatus('signing out ends the session immediately', afterLogout.status, 401);
  }

  // Disabling the account must refuse the password that was working a line ago.
  await setUserDisabled(fixtures.memberId, true);
  const disabledLogin = await call('/api/auth/login', {
    method: 'POST',
    origin: base,
    body: { email: MEMBER_EMAIL, password: fixtures.memberPassword },
  });
  expectStatus('a disabled account cannot sign in', disabledLogin.status, 401);
}

/* ------------------------------------------------------------------------ */
/* Running it                                                                */
/* ------------------------------------------------------------------------ */

function resolveBase(): string {
  const explicit = process.argv[2] ?? process.env['BRAIN_PUBLIC_URL'] ?? '';
  if (explicit) return explicit.replace(/\/+$/, '');
  const app = process.env['FLY_APP_NAME'];
  if (app) return `https://${app}.fly.dev`;
  throw new Error(
    'No public URL. Pass one as the first argument, or set BRAIN_PUBLIC_URL. ' +
      'This checks the Brain from outside, so it needs the address the outside uses.',
  );
}

async function main(): Promise<void> {
  base = resolveBase();

  console.log('Hosted verification');
  console.log(`  Target      ${base}`);
  const described = describePersistence(persistenceConfig());
  console.log(`  Database    ${described.database.provider} · ${described.database.target}`);
  console.log(`  Documents   ${described.storage.provider} · ${described.storage.target}`);
  console.log('');

  await initDatabase();

  let failed = false;
  try {
    const fixtures = await setUp();
    console.log(`  Scope       ${fixtures.scope.slug}`);
    console.log(`  Holdout     ${fixtures.holdout ? fixtures.holdout.slug : '(none — only one project)'}`);

    await anonymousIsRefused(fixtures);
    const cookie = await humanAuthentication(fixtures);
    await humanAuthorization(fixtures, cookie);
    await workerAuthentication(fixtures);
    await revocationEndsAccess(fixtures, cookie);

    // Whatever happened above, the fixtures do not stay usable.
    await revokeCredential(fixtures.credentialId, 'hosted verification finished');
    await revokeCredential(fixtures.expiredCredentialId, 'hosted verification finished');
    await setUserDisabled(fixtures.memberId, true);
    await setWorkerStatus(fixtures.workerId, 'DISABLED');

    const passed = checks.filter((check) => check.ok).length;
    failed = passed !== checks.length;
    console.log('');
    console.log(`${passed}/${checks.length} checks passed.`);
    if (failed) {
      console.log('');
      for (const check of checks.filter((c) => !c.ok)) console.log(`  FAILED  ${check.name} — ${check.detail}`);
    }
    console.log('');
    console.log('The verification account and worker are disabled again. No credential was printed.');
    // A marker, because this runs through `flyctl ssh console` and an exit code
    // that has to survive an SSH session, a shell and a CLI is a fragile thing
    // to hang a security verdict on. A line either says PASS or it does not.
    console.log(`HOSTED-VERIFICATION: ${failed ? 'FAIL' : 'PASS'} ${passed}/${checks.length}`);
  } catch (error) {
    failed = true;
    console.error('\nHosted verification could not complete.');
    console.error(error instanceof Error ? error.message : String(error));
    console.log('HOSTED-VERIFICATION: FAIL could-not-complete');
  } finally {
    await closeDatabase();
  }

  process.exit(failed ? 1 : 0);
}

void main();
