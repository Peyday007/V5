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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ModernMcpClient } from './mcpModernClient.ts';
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
import { createProject, getProjectBySlug, listProjects, updateProject } from '../server/repos/projects.ts';
import {
  cancelWork,
  claimWork,
  completeWork,
  enqueueWork,
  getWorkItem,
  releaseWork,
} from '../server/repos/workQueue.ts';
import { getDb } from '../server/db/database.ts';
import { createLayer, listLayers } from '../server/repos/layers.ts';
import { getDocument } from '../server/repos/documents.ts';
import { listCoverage } from '../server/repos/reconciliation.ts';
import { listAuditsByProject } from '../server/repos/audits.ts';
import {
  currentFragments,
  getOrchestration,
  listClaimsForFragment,
} from '../server/repos/research.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { readObject } from '../server/services/storage.ts';
import { startPacket } from '../server/services/research/startPacket.ts';
import { approvePlan } from '../server/services/research/packetRunner.ts';
import type { Project, WorkerScope } from '../server/domain/types.ts';

/* ------------------------------------------------------------------------ */
/* The fixtures                                                              */
/* ------------------------------------------------------------------------ */

/**
 * `.invalid` is reserved by RFC 2606 and can never be a real address, so these
 * accounts cannot collide with a person's and cannot be mailed by accident.
 */
const MEMBER_EMAIL = 'verification-member@brain.invalid';
const OWNER_EMAIL = 'verification-owner@brain.invalid';
const WORKER_NAME = 'verification-worker';
const RESEARCH_WORKER_NAME = 'verification-worker-research';
const FIXTURE_SLUG = 'verification-scope';
const VERIFICATION_LAYER_NAME = 'Verification Layer';
const VERIFICATION_LAYER_SLUG = 'verification-layer';

/**
 * What the verification worker needs to run a whole packet.
 *
 * Listed rather than taken from a constant, so a scope quietly added to
 * `WORKER_SCOPES` does not silently widen what this run grants itself.
 */
const RESEARCH_SCOPES: WorkerScope[] = [
  'project:read',
  'documents:read',
  'research:read',
  'research:propose',
  'research:write',
  'claims:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
];

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
  init: {
    method?: string;
    cookie?: string;
    bearer?: string;
    body?: unknown;
    origin?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [name, value] of Object.entries(init.extraHeaders ?? {})) headers[name] = value;
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
  /**
   * A third worker, the only one granted the research scopes.
   *
   * Deliberately not the one above. That grant is read-only on purpose — it is
   * the narrowest grant that proves authentication works, and several checks
   * turn on it being refused. Widening it to run a packet would quietly delete
   * those checks while leaving them green.
   */
  researchCredential: string;
  researchCredentialId: string;
  researchWorkerId: string;
  /** A second, independent worker, so a hosted claim can actually be a race. */
  rivalCredential: string;
  rivalWorkerId: string;
  /**
   * A project administrator, for the verification project only.
   *
   * Enqueueing and inspecting operations are ADMIN-level, and the member
   * account must stay an ordinary member so the checks that it *cannot* do
   * those things keep meaning something. Two accounts, two authorities.
   */
  adminCookie: string;
  adminId: string;
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

  // The project administrator. OWNER of the verification project and nothing
  // else — deliberately not a Brain administrator, so the isolation checks
  // above still have something to isolate.
  const ownerPassword = freshPassword();
  const existingOwner = await getUserByEmail(OWNER_EMAIL);
  let ownerId: string;
  if (existingOwner) {
    await setUserPassword(existingOwner.id, ownerPassword, { mustChangePassword: false });
    if (existingOwner.disabled) await setUserDisabled(existingOwner.id, false);
    await revokeSessionsForUser(existingOwner.id);
    ownerId = existingOwner.id;
  } else {
    ownerId = (
      await createUser({
        email: OWNER_EMAIL,
        displayName: 'Hosted verification owner',
        password: ownerPassword,
        isBrainAdmin: false,
        mustChangePassword: false,
      })
    ).id;
  }
  await grantMembership({
    projectId: scope.id,
    principalType: 'HUMAN',
    principalId: ownerId,
    role: 'OWNER',
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
    scopes: ['project:read', 'documents:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
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

  // A second worker with the same grant. Two credentials competing over the
  // public edge is the only way to prove atomic claiming *hosted*: one worker
  // claiming twice would pass against a queue with no concurrency control at
  // all.
  const rival =
    (await getWorkerByName(`${WORKER_NAME}-rival`)) ??
    (await createWorker({
      name: `${WORKER_NAME}-rival`,
      displayName: 'Hosted verification worker (rival)',
      workerType: 'GENERIC',
      description: 'Created by scripts/verify-hosted.ts. Disabled between runs.',
      createdByType: 'SYSTEM',
      createdById: 'verify-hosted',
    }));
  await setWorkerStatus(rival.id, 'ACTIVE');
  await grantMembership({
    projectId: scope.id,
    principalType: 'WORKER',
    principalId: rival.id,
    role: null,
    scopes: ['project:read', 'documents:read', 'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'],
    grantedByType: 'SYSTEM',
    grantedById: 'verify-hosted',
  });
  const rivalIssued = await issueWorkerCredential({
    workerId: rival.id,
    issuedByType: 'SYSTEM',
    issuedById: 'verify-hosted',
  });

  // The research worker. Every scope a packet needs and nothing else.
  const researcher =
    (await getWorkerByName(RESEARCH_WORKER_NAME)) ??
    (await createWorker({
      name: RESEARCH_WORKER_NAME,
      displayName: 'Hosted verification research worker',
      workerType: 'GENERIC',
      description: 'Created by scripts/verify-hosted.ts. Disabled between runs.',
      createdByType: 'SYSTEM',
      createdById: 'verify-hosted',
    }));
  await setWorkerStatus(researcher.id, 'ACTIVE');
  await grantMembership({
    projectId: scope.id,
    principalType: 'WORKER',
    principalId: researcher.id,
    role: null,
    scopes: RESEARCH_SCOPES,
    grantedByType: 'SYSTEM',
    grantedById: 'verify-hosted',
  });
  const researchIssued = await issueWorkerCredential({
    workerId: researcher.id,
    issuedByType: 'SYSTEM',
    issuedById: 'verify-hosted',
  });

  // Sign the owner in over the real edge, the same way anything else would.
  const ownerLogin = await call('/api/auth/login', {
    method: 'POST',
    origin: base,
    body: { email: OWNER_EMAIL, password: ownerPassword },
  });
  const ownerCookie = sessionPair(ownerLogin.cookie) ?? '';
  // Said out loud, because an empty cookie here does not fail here: it fails
  // twelve unrelated checks later, each reporting 401 for a reason that has
  // nothing to do with what they were testing. A fixture that did not work is
  // its own result.
  record(
    'the verification project owner can sign in, so the fixtures are usable',
    ownerCookie.length > 0,
    ownerCookie.length > 0 ? 'signed in' : `login returned ${ownerLogin.status}: ${ownerLogin.body.slice(0, 120)}`,
  );

  return {
    adminCookie: ownerCookie,
    adminId: ownerId,
    rivalCredential: rivalIssued.plaintext,
    rivalWorkerId: rival.id,
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
    researchCredential: researchIssued.plaintext,
    researchCredentialId: researchIssued.credential.id,
    researchWorkerId: researcher.id,
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
    // The body as well as the status. Comparing only the status is what let a
    // real oracle through: both were 404 while the messages differed, so the
    // refusal still confirmed which ids exist.
    record(
      'a project that exists-but-is-forbidden is indistinguishable from one that does not exist',
      denied.status === missing.status && denied.body === missing.body,
      denied.status === missing.status && denied.body === missing.body
        ? `both ${denied.status}, identical body`
        : `forbidden ${denied.status} ${denied.body} · absent ${missing.status} ${missing.body}`,
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

  // Not just a 200: the parts of the application that existed before this step
  // still run on the live Brain. Fetching a project drives the planner, the
  // layer repository and the state engine in one request, so a schema change
  // that broke any of them shows up here rather than the next time somebody
  // opens the site.
  const shape = own.json as { project?: unknown; layers?: unknown[]; plan?: unknown } | null;
  record(
    'the existing project, layer and planner path still works',
    !!shape?.project && Array.isArray(shape.layers) && !!shape.plan,
    shape?.project ? `${(shape.layers ?? []).length} layer(s), plan present` : 'incomplete response',
  );

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

/* ------------------------------------------------------------------------ */
/* Step 9: a whole research packet, over the deployed endpoint                */
/* ------------------------------------------------------------------------ */

/**
 * The packet lifecycle, end to end, against the live Brain.
 *
 * Everything else in this file proves the *boundary*: who may call, what they
 * are refused, that a lease is a compare-and-swap and an effect happens once.
 * None of it proves that a worker can actually put research into the Brain,
 * which is the entire point of Step 9 and until now had only ever run against
 * SQLite on a loopback socket.
 *
 * The difference is not cosmetic. This path writes through the storage layer
 * (a bucket in cloud mode, not a folder), reads extracted text back out of it
 * for the coverage decision, and takes ten tool calls over TLS through the
 * edge — and the first time it ran here it found that `brain_submit_audit`
 * advertised an adversarial schema its own validator rejected, so no
 * worker-driven packet could ever have reached a judge.
 *
 * It spends nothing. Every claim is supplied by this script, so the run
 * exercises the gate rather than a provider.
 */
async function researchChecks(fixtures: Fixtures): Promise<void> {
  console.log('');
  console.log('A research packet, end to end, over the deployed endpoint');

  const worker = new ModernMcpClient({
    url: `${base}/mcp`,
    credential: fixtures.researchCredential,
    clientName: 'brain-hosted-verification-research',
  });

  // A layer to file into. Reused across runs like the project is.
  const layers = await listLayers(fixtures.scope.id);
  const layer =
    layers.find((candidate) => candidate.slug === VERIFICATION_LAYER_SLUG) ??
    (await createLayer({
      projectId: fixtures.scope.id,
      name: VERIFICATION_LAYER_NAME,
      slug: VERIFICATION_LAYER_SLUG,
      orderIndex: layers.length,
    }));

  /**
   * Start the packet server-side, exactly as the console does.
   *
   * Deliberately not over MCP. Creating work is a project write and no worker
   * scope grants it — a worker that could manufacture its own packets could
   * manufacture work nobody asked for. That refusal is asserted below.
   */
  const started = await startPacket({
    projectId: fixtures.scope.id,
    layerId: layer.id,
    title: `Hosted verification packet ${new Date().toISOString()}`,
    assignment:
      'A bounded question used only to prove the packet lifecycle against the deployed Brain. ' +
      'Every claim in it is supplied by the verification script, so nothing is researched and ' +
      'no allowance is spent.',
    approval: { mode: 'PER_PACKET' },
    startedBy: { kind: 'PERSON', id: fixtures.adminId },
  });
  const orchestrationId = started.orchestration.id;

  record(
    'starting a packet queues one planning job and researches nothing',
    started.advanced.enqueued.length === 1 &&
      started.advanced.enqueued[0]?.workType === 'RESEARCH_PLAN',
    started.advanced.enqueued.map((entry) => entry.workType).join(', ') || 'nothing queued',
  );
  record(
    'and reads the archive before creating anything',
    typeof started.archive.documentsRead === 'number' &&
      typeof started.archive.documentsUnreadable === 'number',
    `${started.archive.claims} claim(s) across ${started.archive.documentsRead} readable document(s)`,
  );

  /* --- The plan ---------------------------------------------------------- */

  const planClaim = await claimResearch(fixtures, 'RESEARCH_PLAN');
  if (!planClaim) {
    record('a worker claims the planning job over MCP', false, 'nothing claimable');
    return;
  }
  record('a worker claims the planning job over MCP', true, planClaim.workItemId);

  const assignment = await worker.call('brain_get_assignment', {
    work_item_id: planClaim.workItemId,
  });
  const assignmentView = assignment['assignment'] as Record<string, unknown> | undefined;
  record(
    'and is handed the assignment, and no prompt',
    Boolean(assignmentView) && !('prompt' in (assignmentView ?? {})),
    Object.keys(assignmentView ?? {}).join(', ') || 'nothing',
  );

  await worker.call('brain_checkpoint_work', {
    ...proofOf(planClaim),
    note: 'Hosted verification: read the assignment.',
  });

  const proposed = await worker.call('brain_propose_fragments', {
    ...proofOf(planClaim),
    rationale: 'One fragment, because this run is proving the lifecycle rather than a question.',
    fragments: [
      {
        key: 'hosted-verification-fragment',
        question: 'Does the deployed Brain record a claim, gate it, and file the result?',
        geography: 'Not applicable',
        timeframe: '2026',
        required_evidence: ['a supplied fixture claim'],
        acceptable_source_types: ['verification fixture'],
        completion_criteria: ['one claim recorded, gated and cited in a filed report'],
        min_independent_sources: 1,
        why_it_matters: 'Nothing else in this file proves a worker can write research.',
      },
    ],
  });
  record(
    'proposes fragments, and the coverage check runs against the live archive',
    Array.isArray(proposed['alreadyAnswered']) && typeof proposed['archive'] === 'object',
    `${String(proposed['proposed'])} proposed · ` +
      `${(proposed['alreadyAnswered'] as unknown[] | undefined)?.length ?? '?'} already answered`,
  );

  // Every proposed fragment has a persisted coverage decision behind it. A
  // fragment created without one is §13 skipped rather than satisfied.
  const coverage = await listCoverage(orchestrationId);
  record(
    'and records a coverage decision for every fragment it proposed',
    coverage.length >= 1,
    `${coverage.length} coverage row(s): ${coverage.map((row) => row.status).join(', ')}`,
  );

  await worker.call('brain_complete_work', { ...proofOf(planClaim), summary: 'plan proposed' });

  const planned = await currentFragments(orchestrationId);
  record(
    'and leaves them PLANNED, so nothing researches an unapproved plan',
    planned.length > 0 && planned.every((fragment) => fragment.status === 'PLANNED'),
    planned.map((fragment) => fragment.status).join(', ') || 'no fragments',
  );
  record(
    'with no research queued behind them',
    (await listWorkItems(fixtures.scope.id, { limit: 200 })).every(
      (item) => item.orchestrationId !== orchestrationId || item.workType !== 'RESEARCH_FRAGMENT',
    ),
    'no RESEARCH_FRAGMENT item exists yet',
  );

  /* --- Approval, which is a person -------------------------------------- */

  await approvePlan({ orchestrationId, approvedByUserId: fixtures.adminId });

  /* --- The research, and the gate --------------------------------------- */

  const fragmentClaim = await claimResearch(fixtures, 'RESEARCH_FRAGMENT');
  if (!fragmentClaim) {
    record('approval queues the research', false, 'nothing claimable after approval');
    return;
  }
  record('approval queues the research', true, fragmentClaim.workItemId);

  await worker.call('brain_submit_claims', {
    ...proofOf(fragmentClaim),
    claims: [
      {
        claim: 'The deployed Brain records a worker claim through the storage layer it is configured with.',
        claim_type: 'SOURCED_FACT',
        source_url: 'https://example.invalid/hosted-verification-fixture',
        source_title: 'Hosted verification fixture',
        source_publisher: 'scripts/verify-hosted.ts',
        source_date: '2026-01-01',
        evidence_excerpt: 'Supplied by the verification script rather than researched.',
        evidence_locator: 'fixture',
        evidence_lane: 'a supplied fixture claim',
        retrieved_at: '2026-01-01',
        confidence: 0.9,
        primary_source: true,
      },
      {
        // The one that must not survive. Nothing supports it, and the gate —
        // not the worker, and not this script — is what decides that.
        claim: 'Everybody agrees this is true and it needs no support.',
        claim_type: 'UNSUPPORTED_ASSERTION',
      },
    ],
  });

  const stored = await listClaimsForFragment(planned[0]!.id);
  record(
    'a submitted claim is stored unaccepted, whatever the worker said about it',
    stored.length === 2 && stored.every((claim) => !claim.accepted),
    `${stored.length} claim(s), ${stored.filter((claim) => claim.accepted).length} accepted on arrival`,
  );

  await worker.call('brain_complete_work', { ...proofOf(fragmentClaim), summary: 'claims in' });

  const verifyClaim = await claimResearch(fixtures, 'RESEARCH_VERIFY');
  if (!verifyClaim) {
    record('the gate runs as its own pass', false, 'no RESEARCH_VERIFY item');
    return;
  }
  const gated = await worker.call('brain_submit_verification', {
    ...proofOf(verifyClaim),
    verdicts: stored.map((claim) => ({
      claim_id: claim.id,
      supports_claim: claim.claimType !== 'UNSUPPORTED_ASSERTION',
      geography: 'MATCH',
      timeframe: 'MATCH',
      population: 'MATCH',
      definitions: 'MATCH',
      note: claim.claimType === 'UNSUPPORTED_ASSERTION' ? 'Nothing supports it.' : 'Reads directly.',
    })),
    sufficiency: 'SUFFICIENT',
  });

  const afterGate = await listClaimsForFragment(planned[0]!.id);
  const accepted = afterGate.filter((claim) => claim.accepted);
  record(
    'the gate accepts the sourced claim and refuses the unsupported one',
    accepted.length === 1 && accepted[0]?.claimType === 'SOURCED_FACT',
    `${accepted.length} accepted of ${afterGate.length} · integrity ${String(gated['integrity'])}`,
  );
  record(
    'and keeps the refusal reason on the claim it rejected',
    afterGate.some((claim) => !claim.accepted && (claim.rejectionReason ?? '').length > 0),
    afterGate.find((claim) => !claim.accepted)?.rejectionReason?.slice(0, 60) ?? 'no reason recorded',
  );

  await worker.call('brain_complete_work', { ...proofOf(verifyClaim), summary: 'gated' });

  /* --- The synthesis, and what it may cite ------------------------------ */

  const synthClaim = await claimResearch(fixtures, 'RESEARCH_SYNTHESIZE');
  if (!synthClaim) {
    record('an accepted fragment queues the synthesis', false, 'no RESEARCH_SYNTHESIZE item');
    return;
  }

  const rejected = afterGate.find((claim) => !claim.accepted);
  let citedRejected = false;
  try {
    await worker.call('brain_submit_synthesis', {
      ...proofOf(synthClaim),
      report: `A report that cites something the gate refused [${rejected?.id}].`,
      cited_claim_ids: [rejected?.id ?? 'clm_missing'],
    });
    citedRejected = true;
  } catch {
    /* refused, which is the point */
  }
  record(
    'a report citing a refused claim is refused, over the wire',
    !citedRejected,
    citedRejected ? 'it was filed' : 'refused',
  );

  const filed = await worker.call('brain_submit_synthesis', {
    ...proofOf(synthClaim),
    report: `The deployed Brain recorded and gated a worker's claim [${accepted[0]?.id}].`,
    cited_claim_ids: accepted.map((claim) => claim.id),
  });
  const withDocument = await getOrchestration(orchestrationId);
  record(
    'and a report citing only accepted claims is filed as a document',
    typeof withDocument?.documentId === 'string' && withDocument.documentId.length > 0,
    String(filed['canonicalName'] ?? withDocument?.documentId ?? 'nothing filed'),
  );

  // Filed through the storage layer the deployment is configured with, which
  // is a bucket in cloud mode. A row without bytes is not a filed document.
  if (withDocument?.documentId) {
    const document = await getDocument(withDocument.documentId);
    let readable = false;
    try {
      readable = document?.filesystemPath
        ? (await readObject(document.filesystemPath)).byteLength > 0
        : false;
    } catch {
      readable = false;
    }
    record(
      'whose bytes come back out of the configured document store',
      readable,
      readable ? `${document?.canonicalName}` : 'the stored object could not be read back',
    );
  }

  await worker.call('brain_complete_work', { ...proofOf(synthClaim), summary: 'filed' });

  /* --- The three audit roles -------------------------------------------- */

  const GAP = {
    classification: 'TARGETED_RESEARCH_GAP',
    title: 'The question this fixture deliberately does not answer',
    detail: 'The packet proves the mechanism rather than settling a subject.',
    research_question: 'What would a real packet on this subject have to establish?',
  };

  let auditRolesRun = 0;
  for (const role of ['PRIMARY', 'ADVERSARIAL', 'JUDGE'] as const) {
    const auditClaim = await claimResearch(fixtures, 'RESEARCH_AUDIT');
    if (!auditClaim) break;
    const body =
      role === 'PRIMARY'
        ? { primary: { assignment_satisfied: 'PARTIAL', candidate_gaps: [GAP], notes: 'Fixture packet.' } }
        : role === 'ADVERSARIAL'
          ? {
              adversarial: {
                attacks: [
                  {
                    attack: 'The packet rests on a single supplied claim.',
                    assessment: 'VALID',
                    reasoning: 'It is a fixture, and a fixture is not evidence about the world.',
                  },
                ],
                strongest_reason_not_to_advance: 'Nothing here was researched.',
              },
            }
          : {
              judge: {
                verdict: 'MORE_RESEARCH',
                summary: 'The mechanism works; the subject is unanswered.',
                next_action: 'Run a real packet.',
                gap_classifications: [GAP],
                foundational_gap_count: 0,
                targeted_research_runs_required: 1,
                synthesis_ready: false,
                freeze_ready: false,
                confidence: 0.5,
              },
            };
    const result = await worker.call('brain_submit_audit', { ...proofOf(auditClaim), ...body });
    if (result['role'] === role) auditRolesRun += 1;
    if (role !== 'JUDGE') {
      record(
        `the ${role} audit pass records findings and moves nothing`,
        result['advancesState'] === false,
        `advancesState ${String(result['advancesState'])}`,
      );
    } else {
      record(
        'and only the judge records a verdict',
        result['verdict'] === 'MORE_RESEARCH',
        `verdict ${String(result['verdict'])}`,
      );
    }
    await worker.call('brain_complete_work', { ...proofOf(auditClaim), summary: `${role} in` });
  }
  record(
    'all three audit roles ran, strictly in order',
    auditRolesRun === 3,
    `${auditRolesRun}/3`,
  );

  const audits = await listAuditsByProject(fixtures.scope.id);
  record(
    'and the verdict is stored as a structured record, not as prose',
    audits.length > 0 && audits[0]!.gaps.length > 0,
    audits.length > 0 ? `${audits[0]!.verdict} · ${audits[0]!.gaps.length} gap(s)` : 'no audit row',
  );

  /* --- What a worker still may not do ----------------------------------- */

  let manufactured = false;
  try {
    await worker.call('brain_propose_fragments', {
      work_item_id: 'wki_not_mine',
      lease_id: 'wls_x',
      lease_generation: 1,
      fragments: [
        {
          key: 'forged',
          question: 'Can a worker create its own work?',
          required_evidence: ['none'],
          completion_criteria: ['none'],
        },
      ],
    });
    manufactured = true;
  } catch {
    /* refused, which is the point */
  }
  record(
    'and a worker still cannot write into an item it does not hold',
    !manufactured,
    manufactured ? 'it succeeded' : 'refused',
  );
}

/** Claim one research item of a type, as the worker, through the queue. */
async function claimResearch(
  fixtures: Fixtures,
  workType: string,
): Promise<{ workItemId: string; leaseId: string; leaseGeneration: number } | null> {
  const [claimed] = await claimWork({
    workerId: fixtures.researchWorkerId,
    scopes: [{ projectId: fixtures.scope.id, scopes: RESEARCH_SCOPES }],
    workTypes: [workType],
  });
  return claimed
    ? {
        workItemId: claimed.workItemId,
        leaseId: claimed.leaseId,
        leaseGeneration: claimed.leaseGeneration,
      }
    : null;
}

function proofOf(claimed: { workItemId: string; leaseId: string; leaseGeneration: number }): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
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
/* The distributed queue (Step 5)                                            */
/* ------------------------------------------------------------------------ */

/** Push a lease into the past, the way an unresponsive worker would. */
async function expireLeaseOf(workItemId: string): Promise<void> {
  await getDb().run(
    "UPDATE work_items SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    [workItemId],
  );
  await getDb().run(
    "UPDATE work_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE work_item_id = ? AND ended_at IS NULL",
    [workItemId],
  );
}

interface HostedClaim {
  workItemId: string;
  leaseId: string;
  leaseGeneration: number;
}

async function claimAs(bearer: string, body: Record<string, unknown> = {}): Promise<HostedClaim[]> {
  const reply = await call('/api/work/claim', { method: 'POST', bearer, body });
  const claimed = (reply.json as { claimed?: HostedClaim[] } | null)?.claimed;
  return Array.isArray(claimed) ? claimed : [];
}

/**
 * Everything this harness left behind on an earlier run, cancelled.
 *
 * The verification scope accumulates work items every deploy, and nothing ever
 * consumed them: a run seeds a few, claims what it needs, and leaves the rest
 * queued forever. That pile is why two separate checks here have failed with
 * "it was not handed out" — a claim asks for 25 items and the one it wants is
 * behind a hundred it does not.
 *
 * Priority 9 was the fix both times, and it is a workaround: it keeps working
 * only while priority-9 items get consumed, and it puts the burden on whoever
 * adds the next check to remember. This is the actual repair. Every check in
 * this file is about claiming, fencing or authorization, and none of them is
 * about the queue's history — so the history is cleared first and each run
 * starts from the same place.
 *
 * Only this scope, which exists for nothing else, and only items this harness
 * created. Cancellation rather than deletion, because it goes through the same
 * guarded path everything else does and leaves the attempt history readable.
 */
async function drainPreviousRuns(fixtures: Fixtures): Promise<void> {
  const stale = await getDb().all<{ id: string }>(
    `SELECT id FROM work_items
      WHERE project_id = ? AND created_by_id = 'verify-hosted'
        AND state IN ('QUEUED', 'LEASED')`,
    [fixtures.scope.id],
  );
  for (const row of stale) {
    await cancelWork(row.id, 'superseded by a later verification run');
  }
  if (stale.length > 0) {
    console.log(`  ....  cleared ${stale.length} work item(s) left by earlier runs`);
  }
}

async function queueChecks(fixtures: Fixtures, cookie: string): Promise<void> {
  console.log('\nThe distributed queue');
  await drainPreviousRuns(fixtures);

  /**
   * Seed one item, at a priority that puts it at the front of the queue.
   *
   * The priority is not decoration, and getting it wrong cost a red deploy.
   *
   * A claim takes candidates `ORDER BY priority DESC, available_at, created_at`
   * and stops at a bounded window. The verification project is reused across
   * every run and accumulates leftover QUEUED items — the persistence beacon
   * deliberately leaves one behind each time. So a freshly seeded item is the
   * *newest*, sorts last, and once the backlog passed ten rows the two racing
   * workers filled up on older items and never reached the contested one. Both
   * claimed work; neither claimed *that* work, and the check read "0 leases
   * issued" as though atomic claiming had broken.
   *
   * It looked like flakiness because the first pass drained ten items and the
   * second could then reach the new one. It was not flaky. It was a backlog
   * crossing a threshold, and it would have failed every deploy from then on.
   *
   * Priority 9 makes the check independent of whatever is already queued, which
   * is what a check of *claiming* should be — the backlog is a property of the
   * fixture, not of the thing under test.
   */
  const seed = async (note: string, over: { maxAttempts?: number } = {}): Promise<string> => {
    const item = await enqueueWork({
      projectId: fixtures.scope.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note },
      priority: 9,
      requiredScopes: ['queue:claim'],
      maxAttempts: over.maxAttempts,
      createdByType: 'SYSTEM',
      createdById: 'verify-hosted',
    });
    return item.id;
  };

  // --- anonymous ---------------------------------------------------------
  const anonClaim = await call('/api/work/claim', { method: 'POST', body: {} });
  expectStatus('the queue refuses an anonymous claim', anonClaim.status, 401);

  // --- enqueue authority -------------------------------------------------
  const workerEnqueue = await call(`/api/projects/${fixtures.scope.id}/work`, {
    method: 'POST',
    bearer: fixtures.credential,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note: 'a worker should not be able to do this' } },
  });
  expectStatus('a worker may not create work', workerEnqueue.status, 404);

  const memberEnqueue = await call(`/api/projects/${fixtures.scope.id}/work`, {
    method: 'POST',
    cookie,
    origin: base,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note: 'nor may an ordinary member' } },
  });
  expectStatus('an ordinary member may not create work', memberEnqueue.status, 404);

  const shell = await call(`/api/projects/${fixtures.scope.id}/work`, {
    method: 'POST',
    bearer: fixtures.credential,
    body: { workType: 'RUN_SHELL_COMMAND', payload: { cmd: 'id' } },
  });
  record(
    'there is no work type that means "run this"',
    shell.status === 404 || shell.status === 400,
    `${shell.status}`,
  );

  // --- competing claim ---------------------------------------------------
  const contested = await seed('two workers want this');
  const [mine, theirs] = await Promise.all([
    claimAs(fixtures.credential, { limit: 5 }),
    claimAs(fixtures.rivalCredential, { limit: 5 }),
  ]);
  const winners = [...mine, ...theirs].filter((c) => c.workItemId === contested);
  record(
    'two workers racing over the edge produce exactly one lease',
    winners.length === 1,
    `${winners.length} lease(s) issued`,
  );
  const held = winners[0];
  if (!held) {
    record('the contested item was claimed at all', false, 'no worker got it');
    return;
  }
  const owner = mine.some((c) => c.workItemId === contested)
    ? fixtures.credential
    : fixtures.rivalCredential;
  const stranger = owner === fixtures.credential ? fixtures.rivalCredential : fixtures.credential;

  const row = await getWorkItem(contested);
  record(
    'the claim advanced the attempt and the fencing generation exactly once',
    row?.attemptCount === 1 && row?.leaseGeneration === 1,
    `attempt ${row?.attemptCount}, generation ${row?.leaseGeneration}`,
  );

  // --- heartbeats --------------------------------------------------------
  const beat = await call(`/api/work/${contested}/heartbeat`, {
    method: 'POST',
    bearer: owner,
    body: { leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
  });
  expectStatus('the owner may extend its lease', beat.status, 200);

  const foreign = await call(`/api/work/${contested}/heartbeat`, {
    method: 'POST',
    bearer: stranger,
    body: { leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
  });
  expectStatus('another worker may not extend it', foreign.status, 409);

  const guessed = await call(`/api/work/${contested}/heartbeat`, {
    method: 'POST',
    bearer: owner,
    body: { leaseId: 'wls_invented_out_of_thin_air', leaseGeneration: held.leaseGeneration },
  });
  expectStatus('a guessed lease id is refused', guessed.status, 409);

  // --- expiry and reclaim ------------------------------------------------
  await expireLeaseOf(contested);
  const lateBeat = await call(`/api/work/${contested}/heartbeat`, {
    method: 'POST',
    bearer: owner,
    body: { leaseId: held.leaseId, leaseGeneration: held.leaseGeneration },
  });
  expectStatus('an expired lease cannot be revived by a late heartbeat', lateBeat.status, 409);

  const reclaimed = (await claimAs(stranger, { limit: 25 })).find(
    (c) => c.workItemId === contested,
  );
  record(
    'an expired lease is reclaimed by another worker',
    reclaimed !== undefined,
    reclaimed ? 'reclaimed' : 'nobody could take it',
  );
  record(
    'the reclaim issued a higher fencing generation and a new lease id',
    !!reclaimed &&
      reclaimed.leaseGeneration > held.leaseGeneration &&
      reclaimed.leaseId !== held.leaseId,
    reclaimed ? `generation ${held.leaseGeneration} -> ${reclaimed.leaseGeneration}` : '',
  );

  // --- the stale owner ---------------------------------------------------
  for (const [label, route] of [
    ['complete', 'complete'],
    ['fail', 'fail'],
    ['release', 'release'],
  ] as const) {
    const stale = await call(`/api/work/${contested}/${route}`, {
      method: 'POST',
      bearer: owner,
      body: { leaseId: held.leaseId, leaseGeneration: held.leaseGeneration, category: 'UNKNOWN' },
    });
    expectStatus(`the previous owner may not ${label} after reclaim`, stale.status, 409);
  }

  if (reclaimed) {
    const done = await call(`/api/work/${contested}/complete`, {
      method: 'POST',
      bearer: stranger,
      body: {
        leaseId: reclaimed.leaseId,
        leaseGeneration: reclaimed.leaseGeneration,
        summary: 'echoed',
      },
    });
    expectStatus('the current owner may complete it', done.status, 200);

    const again = await call(`/api/work/${contested}/complete`, {
      method: 'POST',
      bearer: stranger,
      body: { leaseId: reclaimed.leaseId, leaseGeneration: reclaimed.leaseGeneration },
    });
    expectStatus('completing twice is refused', again.status, 409);
  }

  // --- retry and terminal failure ---------------------------------------
  /**
   * Through `seed`, and that is the whole fix.
   *
   * This enqueued directly at the default priority, which is the *same bug*
   * `seed`'s own comment above describes and which cost a red deploy once
   * already. It was fixed in one place and missed here, and it duly failed —
   * "the failing item was claimed: it was not handed out" — on the first pass
   * of a deploy whose second pass, against a queue the first pass had drained,
   * passed. Which is what made it look like flakiness both times.
   *
   * There is now one enqueue helper in this function and it sets the priority,
   * so the next check somebody adds cannot reintroduce it a third time.
   */
  const failingId = await seed('this one fails', { maxAttempts: 1 });
  const toFail = (await claimAs(fixtures.credential, { limit: 25 })).find(
    (c) => c.workItemId === failingId,
  );
  if (toFail) {
    const failed = await call(`/api/work/${failingId}/fail`, {
      method: 'POST',
      bearer: fixtures.credential,
      body: {
        leaseId: toFail.leaseId,
        leaseGeneration: toFail.leaseGeneration,
        category: 'WORKER_ERROR',
      },
    });
    expectStatus('a worker may report failure', failed.status, 200);
    const after = await getWorkItem(failingId);
    record(
      'the last attempt failing is terminal, not another retry',
      after?.state === 'FAILED' && after?.failureCategory === 'ATTEMPTS_EXHAUSTED',
      `${after?.state} · ${after?.failureCategory}`,
    );
  } else {
    record('the failing item was claimed', false, 'it was not handed out');
  }

  // --- cancellation ------------------------------------------------------
  const doomed = await seed('cancel me');
  const doomedClaim = (await claimAs(fixtures.credential, { limit: 25 })).find(
    (c) => c.workItemId === doomed,
  );
  const cancelled = await cancelWork(doomed, 'hosted verification');
  record('an administrator can cancel leased work', cancelled.ok, '');
  if (doomedClaim) {
    const zombie = await call(`/api/work/${doomed}/complete`, {
      method: 'POST',
      bearer: fixtures.credential,
      body: { leaseId: doomedClaim.leaseId, leaseGeneration: doomedClaim.leaseGeneration },
    });
    expectStatus('a cancelled item cannot be completed by its old owner', zombie.status, 409);
  }
  const afterCancel = await getWorkItem(doomed);
  record(
    'cancellation is terminal and not reclaimable',
    afterCancel?.state === 'CANCELLED',
    `${afterCancel?.state}`,
  );

  // --- isolation ---------------------------------------------------------
  if (fixtures.holdout) {
    const theirWork = await enqueueWork({
      projectId: fixtures.holdout.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'belongs to the real project' },
      requiredScopes: ['queue:claim'],
      createdByType: 'SYSTEM',
      createdById: 'verify-hosted',
    });
    const peek = await call(`/api/work/${theirWork.id}`, { bearer: fixtures.credential });
    const absent = await call('/api/work/wki_no_such_item_exists', { bearer: fixtures.credential });
    expectStatus('a work item in another project is refused', peek.status, 404);
    record(
      'and is indistinguishable from a work item that does not exist',
      peek.status === absent.status && peek.body === absent.body,
      peek.body === absent.body ? 'identical body' : `${peek.body} vs ${absent.body}`,
    );

    const narrowed = await claimAs(fixtures.credential, { projectId: fixtures.holdout.id });
    record(
      'a worker cannot claim into a project it is not a member of',
      narrowed.length === 0,
      `${narrowed.length} claim(s)`,
    );
    await cancelWork(theirWork.id, 'hosted verification cleanup');
  }

  // --- metrics -----------------------------------------------------------
  const metrics = await call(`/api/projects/${fixtures.scope.id}/work/metrics`, { cookie });
  expectStatus('a member may read queue metrics for its own project', metrics.status, 200);
  const anonMetrics = await call(`/api/projects/${fixtures.scope.id}/work/metrics`);
  expectStatus('and an anonymous caller may not', anonMetrics.status, 401);
}



/* ------------------------------------------------------------------------ */
/* Idempotency and safe effects (Step 6)                                     */
/* ------------------------------------------------------------------------ */

/**
 * A fresh key namespace for every run.
 *
 * The counter alone was not enough: it resets with the process, so the second
 * run of this script reused the first run's keys, every keyed mutation replayed
 * instead of executing, and the checks that assert "this is an original
 * execution" failed. The deploy runs this twice, so a harness that only works
 * the first time is a harness that fails every deploy.
 *
 * Deliberately unlike the persistence beacon, which must survive between runs.
 * Keys must not; results must.
 */
const RUN_NONCE = crypto.randomBytes(6).toString('hex');
let hostedKeySeq = 0;
function hostedKey(label: string): string {
  hostedKeySeq += 1;
  return `hosted-${label}-${RUN_NONCE}-${String(hostedKeySeq).padStart(4, '0')}`;
}

async function enqueueWithKey(
  fixtures: Fixtures,
  cookie: string,
  key: string | null,
  note: string,
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (key) headers['idempotency-key'] = key;
  return await call(`/api/projects/${fixtures.scope.id}/work`, {
    method: 'POST',
    cookie,
    origin: base,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note } },
    extraHeaders: headers,
  });
}

async function effectChecks(
  fixtures: Fixtures,
  adminCookie: string,
  memberCookie: string,
): Promise<void> {
  console.log('\nIdempotency and safe effects');

  // --- where a key may arrive -------------------------------------------
  const inQuery = await call(
    `/api/projects/${fixtures.scope.id}/work?idempotency_key=abcdefghij`,
    { method: 'POST', cookie: adminCookie, origin: base, body: { workType: 'SYNTHETIC_ECHO', payload: {} } },
  );
  expectStatus('a key in the URL is refused rather than ignored', inQuery.status, 400);

  const malformed = await call(`/api/projects/${fixtures.scope.id}/work`, {
    method: 'POST',
    cookie: adminCookie,
    origin: base,
    body: { workType: 'SYNTHETIC_ECHO', payload: {} },
    extraHeaders: { 'idempotency-key': 'has spaces !!' },
  });
  expectStatus('a malformed key is refused', malformed.status, 400);

  // --- original and replay ----------------------------------------------
  const key = hostedKey('replay');
  const first = await enqueueWithKey(fixtures, adminCookie, key, 'idempotent');
  expectStatus('a keyed mutation executes', first.status, 200);
  const firstId = (first.json as { item?: { id?: string }; replayed?: boolean } | null)?.item?.id;
  const firstReplayed = (first.json as { replayed?: boolean } | null)?.replayed;
  record('and reports itself as an original execution', firstReplayed === false, `${firstReplayed}`);

  const second = await enqueueWithKey(fixtures, adminCookie, key, 'idempotent');
  const secondBody = second.json as { item?: { id?: string }; replayed?: boolean } | null;
  expectStatus('a repeat of the same key is accepted', second.status, 200);
  record(
    'and returns the same work item without creating another',
    secondBody?.item?.id === firstId && secondBody?.replayed === true,
    `${secondBody?.item?.id === firstId ? 'same item' : 'DIFFERENT item'}, replayed ${secondBody?.replayed}`,
  );

  // --- concurrent duplicates --------------------------------------------
  const raceKey = hostedKey('race');
  const raced = await Promise.all(
    Array.from({ length: 6 }, () => enqueueWithKey(fixtures, adminCookie, raceKey, 'raced')),
  );
  const ids = raced
    .map((reply) => (reply.json as { item?: { id?: string } } | null)?.item?.id)
    .filter((id): id is string => typeof id === 'string');
  record(
    'six concurrent duplicates over the edge create exactly one work item',
    new Set(ids).size === 1,
    `${new Set(ids).size} distinct item(s) from ${raced.length} request(s)`,
  );
  record(
    'and every request that did not get it was told so, not failed',
    raced.every((reply) => reply.status === 200 || reply.status === 409),
    raced.map((r) => r.status).join(' '),
  );

  // --- fingerprint conflict ---------------------------------------------
  const conflict = await enqueueWithKey(fixtures, adminCookie, key, 'a-completely-different-note');
  expectStatus('the same key with a different request is refused', conflict.status, 409);
  record(
    'and the refusal does not disclose the earlier request',
    !conflict.body.includes('idempotent'),
    '',
  );

  // --- isolation ---------------------------------------------------------
  if (fixtures.holdout) {
    const elsewhere = await call(`/api/projects/${fixtures.holdout.id}/work`, {
      method: 'POST',
      cookie: adminCookie,
      origin: base,
      body: { workType: 'SYNTHETIC_ECHO', payload: { note: 'idempotent' } },
      extraHeaders: { 'idempotency-key': key },
    });
    // Authorization is decided before idempotency is even considered, so a key
    // is never a way to reach a project. That the same key is *independent*
    // across projects is a property of the scope hash and is proven in the unit
    // suite; what matters here is that holding one buys no access.
    expectStatus(
      'a key does not open a project the caller may not touch',
      elsewhere.status,
      404,
    );
  }

  // --- committing under a lease -----------------------------------------
  const target = await enqueueWithKey(fixtures, adminCookie, hostedKey('effect'), 'under a lease');
  const targetId = (target.json as { item?: { id?: string } } | null)?.item?.id;
  if (!targetId) {
    record('a work item was created to commit an effect against', false, 'none');
    return;
  }
  const claimed = await claimAs(fixtures.credential, { limit: 25 });
  const mine = claimed.find((c) => c.workItemId === targetId);
  record('a worker claimed it', mine !== undefined, mine ? 'claimed' : 'not claimed');
  if (!mine) return;

  const commit = await call(`/api/work/${targetId}/effect`, {
    method: 'POST',
    bearer: fixtures.credential,
    body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration, summary: 'committed' },
  });
  expectStatus('the owner commits the effect', commit.status, 200);
  record(
    'and it is recorded as an original execution',
    (commit.json as { replayed?: boolean } | null)?.replayed === false,
    '',
  );

  const redelivered = await call(`/api/work/${targetId}/effect`, {
    method: 'POST',
    bearer: fixtures.credential,
    body: { leaseId: mine.leaseId, leaseGeneration: mine.leaseGeneration, summary: 'committed' },
  });
  record(
    'a redelivery replays the effect rather than repeating it',
    redelivered.status === 200 &&
      (redelivered.json as { replayed?: boolean } | null)?.replayed === true,
    `${redelivered.status}, replayed ${(redelivered.json as { replayed?: boolean } | null)?.replayed}`,
  );

  // --- a stale lease cannot commit ---------------------------------------
  const fenced = await enqueueWithKey(fixtures, adminCookie, hostedKey('fence'), 'fenced');
  const fencedId = (fenced.json as { item?: { id?: string } } | null)?.item?.id;
  if (fencedId) {
    const held = (await claimAs(fixtures.credential, { limit: 25 })).find(
      (c) => c.workItemId === fencedId,
    );
    if (held) {
      await expireLeaseOf(fencedId);
      const stolen = (await claimAs(fixtures.rivalCredential, { limit: 25 })).find(
        (c) => c.workItemId === fencedId,
      );
      const stale = await call(`/api/work/${fencedId}/effect`, {
        method: 'POST',
        bearer: fixtures.credential,
        body: { leaseId: held.leaseId, leaseGeneration: held.leaseGeneration, summary: 'stale' },
      });
      expectStatus('a worker whose lease was reclaimed cannot commit an effect', stale.status, 409);
      if (stolen) {
        const fresh = await call(`/api/work/${fencedId}/effect`, {
          method: 'POST',
          bearer: fixtures.rivalCredential,
          body: {
            leaseId: stolen.leaseId,
            leaseGeneration: stolen.leaseGeneration,
            summary: 'the real one',
          },
        });
        expectStatus('and the current owner still can', fresh.status, 200);
      }
    }
  }

  // --- the operation record ----------------------------------------------
  const operations = await call(`/api/projects/${fixtures.scope.id}/operations`, {
    cookie: adminCookie,
  });
  expectStatus('an administrator can inspect operations', operations.status, 200);
  record(
    'and the record contains neither the key nor the request it described',
    !operations.body.includes(key) && !operations.body.includes('a-completely-different-note'),
    '',
  );

  const anonOperations = await call(`/api/projects/${fixtures.scope.id}/operations`);
  expectStatus('an anonymous caller cannot', anonOperations.status, 401);

  const memberOperations = await call(`/api/projects/${fixtures.scope.id}/operations`, {
    cookie: memberCookie,
  });
  record(
    'nor can an ordinary member of the project',
    memberOperations.status === 404 || memberOperations.status === 401,
    `${memberOperations.status}`,
  );
}

/* ------------------------------------------------------------------------ */
/* The MCP gateway, from outside                                             */
/* ------------------------------------------------------------------------ */

/**
 * Step 7's live proof.
 *
 * Two genuine external MCP clients are pointed at the deployed URL: the
 * official SDK's own client, which speaks the legacy era and is what every MCP
 * client in existence is built on, and the hand-written 2026-07-28 client in
 * `scripts/mcpModernClient.ts`, because no SDK can speak that revision yet.
 *
 * Run from inside the container and out through the public hostname, for the
 * reason every hosted check here works that way: this is the only place that
 * can both mint a test principal and arrive from outside. A check that talked
 * to 127.0.0.1 would skip the load balancer, the TLS termination and the proxy
 * headers, which is most of what can actually be wrong about a remote gateway.
 */
async function mcpChecks(fixtures: Fixtures): Promise<void> {
  console.log('');
  console.log('The MCP gateway, driven by real external clients');

  const url = `${base}/mcp`;

  /* --- The hand-written 2026-07-28 client ------------------------------- */

  const modern = new ModernMcpClient({
    url,
    credential: fixtures.credential,
    clientName: 'brain-hosted-verification',
  });

  const discovered = await modern.discover();
  expectStatus('a modern client discovers the deployed Brain', discovered.status, 200);
  record(
    'and is told both protocol eras',
    JSON.stringify(discovered.result?.supportedVersions) === JSON.stringify(['2026-07-28', '2025-11-25']),
    JSON.stringify(discovered.result?.supportedVersions ?? null),
  );

  const listed = await modern.listTools();
  const modernNames = (listed.result?.tools ?? []).map((tool) => tool.name);
  record('and lists the permanent tool surface', modernNames.length > 0, `${modernNames.length} tool(s)`);

  /**
   * Step 9's tools are on the deployed surface, and every one of them is there.
   *
   * Named individually rather than counted. A count passes when a tool is
   * renamed, and renaming a tool the connector already knows is exactly the
   * change that would break a live worker without breaking anything here.
   */
  const RESEARCH_TOOL_NAMES = [
    'brain_get_assignment',
    'brain_checkpoint_work',
    'brain_propose_fragments',
    'brain_submit_claims',
    'brain_submit_verification',
    'brain_report_contradiction',
    'brain_report_blocker',
    'brain_submit_synthesis',
    'brain_get_audit_brief',
    'brain_submit_audit',
  ];
  const missingResearch = RESEARCH_TOOL_NAMES.filter((name) => !modernNames.includes(name));
  record(
    'including every research tool, so a worker can write what it finds',
    missingResearch.length === 0,
    missingResearch.length === 0 ? `${RESEARCH_TOOL_NAMES.length} present` : `missing ${missingResearch.join(', ')}`,
  );

  /**
   * A worker cannot submit research into a project it has no membership in,
   * and the refusal says nothing about whether that project exists.
   *
   * The scope fixture holds a membership; `fixtures.other` deliberately does
   * not. This is the same oracle test the queue checks run, applied to the
   * surface that can now write evidence.
   */
  const strayClaim = await modern.callTool('brain_submit_claims', {
    work_item_id: 'wki_not_a_real_item',
    lease_id: 'wls_x',
    lease_generation: 1,
    claims: [{ claim: 'this must never be recorded' }],
  });
  record(
    'and refuses a research submission against an item it does not hold',
    strayClaim.result?.isError === true,
    `isError ${String(strayClaim.result?.isError)}`,
  );
  record(
    'with the cache fields this revision requires',
    typeof listed.result?.ttlMs === 'number' && listed.result?.cacheScope === 'private',
    `ttlMs ${String(listed.result?.ttlMs)} · ${String(listed.result?.cacheScope)}`,
  );

  const whoami = await modern.callTool('brain_whoami');
  record(
    'and calls a tool over TLS, through the load balancer',
    whoami.result?.isError === false && whoami.result?.resultType === 'complete',
    `resultType ${String(whoami.result?.resultType)}`,
  );

  /* --- The official SDK client, over the same URL ----------------------- */

  const sdk = new Client({ name: 'brain-hosted-verification-sdk', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${fixtures.credential}` } },
  });

  let sdkConnected = false;
  let sdkNames: string[] = [];
  try {
    await sdk.connect(transport);
    sdkConnected = true;
    const sdkTools = await sdk.listTools();
    sdkNames = sdkTools.tools.map((tool) => tool.name);
    record('the official SDK client connects to the deployed Brain', true, 'initialize completed');
  } catch (error) {
    record('the official SDK client connects to the deployed Brain', false, String(error).slice(0, 160));
  }

  if (sdkConnected) {
    record(
      'and is served the identical tool surface',
      JSON.stringify(sdkNames) === JSON.stringify(modernNames),
      `${sdkNames.length} tool(s)`,
    );

    const queued = await call(`/api/projects/${fixtures.scope.id}/work`, {
      method: 'POST',
      cookie: fixtures.adminCookie,
      origin: base,
      body: { workType: 'SYNTHETIC_ECHO', payload: { note: 'mcp hosted verification' } },
    });
    record('a work item is queued for it', queued.status === 200, String(queued.status));

    try {
      const claimResult = await sdk.callTool({ name: 'brain_claim_work', arguments: { limit: 1 } });
      const claimed =
        (claimResult.structuredContent as { claimed?: { workItemId: string; leaseId: string; leaseGeneration: number }[] })
          ?.claimed ?? [];
      record('and the SDK client claims it', claimed.length === 1, `${claimed.length} claimed`);

      const lease = claimed[0];
      if (lease) {
        const beat = await sdk.callTool({
          name: 'brain_heartbeat_work',
          arguments: {
            work_item_id: lease.workItemId,
            lease_id: lease.leaseId,
            lease_generation: lease.leaseGeneration,
          },
        });
        record('heartbeats the lease it was given', beat.isError !== true, 'lease extended');

        const args = {
          work_item_id: lease.workItemId,
          lease_id: lease.leaseId,
          lease_generation: lease.leaseGeneration,
          summary: 'completed by a real external MCP client',
        };
        const done = await sdk.callTool({ name: 'brain_complete_work', arguments: args });
        const state = (done.structuredContent as { state?: string })?.state;
        record('and completes it', done.isError !== true && state === 'SUCCEEDED', String(state));

        // The property Step 6 exists for, exercised through Step 7's boundary.
        const again = await sdk.callTool({ name: 'brain_complete_work', arguments: args });
        const replayState = (again.structuredContent as { state?: string })?.state;
        record(
          'a repeat of that completion replays rather than performing a second effect',
          replayState === 'ALREADY_RECORDED',
          String(replayState),
        );
      }

      // Authorization at execution time, not by hiding the tool.
      const forbidden = await sdk.callTool({
        name: 'brain_get_project',
        arguments: { project_id: 'prj_0000000000000000' },
      });
      record('a tool it may not use is listed and still refuses', forbidden.isError === true, 'isError true');
    } finally {
      await sdk.close().catch(() => undefined);
    }
  }

  /* --- The refusals ----------------------------------------------------- */

  const anonymous = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'server/discover',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  expectStatus('the live gateway refuses a request with no credential', anonymous.status, 401);

  /**
   * Step 7 checked that no OAuth pointer was emitted, because none was served.
   * Step 8 serves one, so the check is inverted — and strengthened: the pointer
   * is followed, and the document it names has to be real. A header naming a
   * 404 would be the same lie the old check was guarding against.
   */
  const challenge = anonymous.headers.get('www-authenticate') ?? '';
  record(
    'and points a client at where to authenticate',
    challenge.includes('resource_metadata='),
    challenge ? 'WWW-Authenticate present' : 'missing',
  );
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  if (metadataUrl) {
    const metadata = await fetch(metadataUrl);
    const document = metadata.ok ? ((await metadata.json()) as Record<string, unknown>) : {};
    record(
      'and that metadata document actually resolves',
      metadata.status === 200 && document['resource'] === url,
      `${metadata.status} · ${String(document['resource'] ?? 'none')}`,
    );
  } else {
    record('and that metadata document actually resolves', false, 'no pointer to follow');
  }

  const expired = new ModernMcpClient({ url, credential: fixtures.expiredCredential });
  expectStatus('and refuses an expired credential', (await expired.discover()).status, 401);

  const browser = new ModernMcpClient({
    url,
    credential: fixtures.credential,
    headerOverrides: { origin: 'https://evil.example' },
  });
  expectStatus('and refuses a browser origin, live', (await browser.discover()).status, 403);

  const getStream = await fetch(url, { headers: { authorization: `Bearer ${fixtures.credential}` } });
  expectStatus('and answers GET with 405, because that stream was removed', getStream.status, 405);
  record(
    'and never mints a session id',
    getStream.headers.get('mcp-session-id') === null,
    'no Mcp-Session-Id',
  );

  const mismatched = new ModernMcpClient({
    url,
    credential: fixtures.credential,
    headerOverrides: { 'mcp-method': 'tools/call' },
  });
  const headerReply = await mismatched.listTools();
  record(
    'and refuses a header that disagrees with the body',
    headerReply.status === 400 && headerReply.error?.code === -32020,
    `${headerReply.status} · ${String(headerReply.error?.code)}`,
  );

  const oldVersion = new ModernMcpClient({
    url,
    credential: fixtures.credential,
    headerOverrides: { 'mcp-protocol-version': '1900-01-01' },
  });
  const versionReply = await oldVersion.listTools();
  record(
    'and refuses an unsupported version with the ones it does speak',
    versionReply.status === 400 && (versionReply.error?.code === -32020 || versionReply.error?.code === -32022),
    `${versionReply.status} · ${String(versionReply.error?.code)}`,
  );

  /**
   * A perfectly valid credential must not open a project it is not a member of.
   *
   * The first version of this check pointed the *rival* worker at the scope
   * project and expected a refusal — which was wrong, and the harness caught
   * it. That worker is deliberately a full member of the same project, because
   * it exists so a hosted claim can be a real race between two workers. It got
   * a 200 because it is entitled to one.
   *
   * The property actually worth proving is the holdout: a live credential,
   * pointed at a project nobody granted it, gets the same answer as if that
   * project did not exist — and the *body* has to match, not only the status,
   * because that is the leak Step 4 found in the HTTP resolvers.
   */
  if (fixtures.holdout) {
    const outsider = new ModernMcpClient({ url, credential: fixtures.credential });
    const forbiddenProject = await outsider.callTool('brain_get_project', { project_id: fixtures.holdout.id });
    const absentProject = await outsider.callTool('brain_get_project', { project_id: 'prj_0000000000000000' });
    record(
      'a live credential cannot open a project it was never granted',
      forbiddenProject.result?.isError === true,
      forbiddenProject.result?.isError === true ? 'isError true' : `status ${forbiddenProject.status}`,
    );
    record(
      'and that refusal is byte-identical to one for a project that does not exist',
      JSON.stringify(forbiddenProject.result?.structuredContent) ===
        JSON.stringify(absentProject.result?.structuredContent),
      'same body',
    );
    record(
      'and never names the id it refused',
      !JSON.stringify(forbiddenProject.result ?? {}).includes(fixtures.holdout.id),
      'id not echoed',
    );
  } else {
    // Said out loud rather than silently skipped: a run with only one project
    // cannot prove cross-project isolation, and a harness that quietly drops a
    // check reads as "covered" when it was not.
    record(
      'cross-project isolation over MCP',
      true,
      'not exercised — this Brain has only one project',
    );
  }
}

/* ------------------------------------------------------------------------ */
/* The persistence beacon                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Proving that queue state survives a restart, rather than assuming it.
 *
 * Running the checks twice proves the queue works twice. It says nothing about
 * persistence unless something *stopped* in between — and the workflow's
 * restart used to be a side effect of removing the bootstrap secrets, which
 * silently stopped happening the moment those secrets were gone. The run still
 * printed "either side of a restart". That is the kind of claim that decays
 * into a lie without anybody editing a line.
 *
 * So: the first pass deliberately leaves three work items behind, one in each
 * durable state, including a *live lease*. The machine is then restarted. The
 * second pass asserts all three are exactly where they were — same states, same
 * fencing generation, same attempt count, attempt history intact.
 *
 * Nothing in the container can fake that. The process that created them is
 * gone.
 */
const BEACON = 'verify-hosted-beacon';

async function clearBeacons(): Promise<void> {
  const rows = await getDb().all<{ id: string }>(
    'SELECT id FROM work_items WHERE correlation_id LIKE ?',
    [`${BEACON}%`],
  );
  for (const row of rows) {
    await getDb().run('DELETE FROM work_leases WHERE work_item_id = ?', [row.id]);
    await getDb().run('DELETE FROM work_items WHERE id = ?', [row.id]);
  }
}

interface BeaconShape {
  leasedGeneration: number;
  leasedAttempts: number;
}

async function leaveBeacon(fixtures: Fixtures): Promise<BeaconShape> {
  await clearBeacons();

  // Priority 9 for the same reason the queue checks use it: this claims 25 and
  // looks for two specific items among them, so a backlog ahead of them would
  // make the beacon silently fail to be set up. It has not yet; the exposure is
  // identical and closing it is one field.
  const make = async (suffix: string) =>
    await enqueueWork({
      projectId: fixtures.scope.id,
      workType: 'SYNTHETIC_ECHO',
      payload: { note: 'persistence beacon' },
      priority: 9,
      requiredScopes: ['queue:claim'],
      correlationId: `${BEACON}:${suffix}`,
      createdByType: 'SYSTEM',
      createdById: 'verify-hosted',
    });

  await make('queued');
  const toLease = await make('leased');
  const toFinish = await make('done');

  // A live lease, held for an hour, so the restart genuinely interrupts an
  // owner rather than tidily finding everything finished.
  const claimed = await claimWork({
    workerId: fixtures.workerId,
    scopes: [{ projectId: fixtures.scope.id, scopes: ['queue:claim'] }],
    workTypes: ['SYNTHETIC_ECHO'],
    limit: 25,
    leaseMs: 60 * 60 * 1000,
  });
  const leased = claimed.find((c) => c.workItemId === toLease.id);
  const finished = claimed.find((c) => c.workItemId === toFinish.id);

  if (finished) {
    await completeWork(
      {
        workItemId: finished.workItemId,
        workerId: fixtures.workerId,
        leaseId: finished.leaseId,
        leaseGeneration: finished.leaseGeneration,
      },
      { summary: 'beacon' },
    );
  }
  // Anything else this claim swept up goes back, so only the three beacons are
  // left in the states this says they are in.
  for (const other of claimed) {
    if (other.workItemId === toLease.id || other.workItemId === toFinish.id) continue;
    await releaseWork({
      workItemId: other.workItemId,
      workerId: fixtures.workerId,
      leaseId: other.leaseId,
      leaseGeneration: other.leaseGeneration,
    });
  }

  return {
    leasedGeneration: leased?.leaseGeneration ?? -1,
    leasedAttempts: leased?.attemptNumber ?? -1,
  };
}

/**
 * @param required true after the workflow's restart, where a missing beacon is
 *   a real failure. False for a standalone run, where there may simply never
 *   have been a previous pass — and a check that fails the first time somebody
 *   runs it by hand teaches people to ignore it.
 */
async function checkBeacon(required: boolean): Promise<void> {
  console.log('\nSurviving a restart');

  const byCorrelation = async (suffix: string) =>
    await getDb().get<{
      id: string;
      state: string;
      lease_generation: number;
      attempt_count: number;
      lease_expires_at: string | null;
    }>('SELECT * FROM work_items WHERE correlation_id = ?', [`${BEACON}:${suffix}`]);

  const queued = await byCorrelation('queued');
  const leased = await byCorrelation('leased');
  const done = await byCorrelation('done');

  if (!queued || !leased || !done) {
    if (!required) {
      console.log('  ....  no previous pass left anything here; nothing to compare');
      return;
    }
    record(
      'the work left before the restart is still there',
      false,
      'no beacon found — the pass before the restart did not leave one, or it did not survive',
    );
    return;
  }
  record('the work left before the restart is still there', true, 'all three found');
  record('queued work is still queued', queued.state === 'QUEUED', queued.state);
  record('finished work is still finished', done.state === 'SUCCEEDED', done.state);
  record(
    'a live lease survived the restart, still owned and still counting down',
    leased.state === 'LEASED' && leased.lease_expires_at !== null,
    `${leased.state}, expires ${leased.lease_expires_at ?? 'never'}`,
  );
  record(
    'the fencing generation and attempt count are unchanged',
    Number(leased.lease_generation) === 1 && Number(leased.attempt_count) === 1,
    `generation ${leased.lease_generation}, attempt ${leased.attempt_count}`,
  );

  const attempts = await getDb().all<{ id: string; ended_at: string | null }>(
    'SELECT * FROM work_leases WHERE work_item_id = ?',
    [leased.id],
  );
  record(
    'its attempt history survived too, still open',
    attempts.length === 1 && attempts[0]?.ended_at === null,
    `${attempts.length} attempt row(s)`,
  );

  await clearBeacons();
}

/* ------------------------------------------------------------------------ */
/* Running it                                                                */
/* ------------------------------------------------------------------------ */

type Phase = 'leave' | 'check' | 'both';

/**
 * Which side of the restart this pass is on.
 *
 * `both` is the default, for a manual run: check whatever a previous run left,
 * then leave a fresh beacon. The workflow is explicit — `--leave-beacon` before
 * the restart, `--check-beacon` after — so the assertion is about *this* run's
 * restart rather than about whatever happened to be lying around.
 */
function resolvePhase(): Phase {
  const argv = process.argv.slice(2);
  if (argv.includes('--check-beacon')) return 'check';
  if (argv.includes('--leave-beacon')) return 'leave';
  return 'both';
}

function resolveBase(): string {
  const explicit =
    process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    process.env['BRAIN_PUBLIC_URL'] ??
    '';
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

    const phase = resolvePhase();
    console.log(`  Phase       ${phase === 'leave' ? 'before the restart' : phase === 'check' ? 'after the restart' : 'standalone'}`);

    // Before anything else creates work: was the previous pass's work still
    // here when this process started?
    if (phase === 'check' || phase === 'both') await checkBeacon(phase === 'check');

    await anonymousIsRefused(fixtures);
    const cookie = await humanAuthentication(fixtures);
    await humanAuthorization(fixtures, cookie);
    await workerAuthentication(fixtures);
    await queueChecks(fixtures, cookie);
    await effectChecks(fixtures, fixtures.adminCookie, cookie);
    // Step 7. Before revocation, because it needs a live credential.
    await mcpChecks(fixtures);
    // Step 9. Also before revocation: it needs the same live credential.
    await researchChecks(fixtures);
    await revocationEndsAccess(fixtures, cookie);

    // Last, so the beacon is not swept up by the checks above.
    if (phase === 'leave' || phase === 'both') {
      const shape = await leaveBeacon(fixtures);
      console.log('');
      console.log(
        `Left three work items behind for the pass after the restart ` +
          `(a live lease at generation ${shape.leasedGeneration}, attempt ${shape.leasedAttempts}).`,
      );
    }

    // Whatever happened above, the fixtures do not stay usable.
    await revokeCredential(fixtures.credentialId, 'hosted verification finished');
    await revokeCredential(fixtures.researchCredentialId, 'hosted verification finished');
    await revokeCredential(fixtures.expiredCredentialId, 'hosted verification finished');
    await setUserDisabled(fixtures.memberId, true);
    await setUserDisabled(fixtures.adminId, true);
    await setWorkerStatus(fixtures.workerId, 'DISABLED');
    await setWorkerStatus(fixtures.rivalWorkerId, 'DISABLED');
    await setWorkerStatus(fixtures.researchWorkerId, 'DISABLED');
    // Archived rather than left ACTIVE, so it can never be picked as anybody's
    // default project and never sits in a list beside the real work. The next
    // run finds it by slug regardless of status and reuses it.
    await updateProject(fixtures.scope.id, { status: 'ARCHIVED' });

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
