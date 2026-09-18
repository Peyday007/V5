/**
 * The sharing boundary, driven against a real server.
 *
 * ---------------------------------------------------------------------------
 * The demonstrated defect
 * ---------------------------------------------------------------------------
 *
 * An ordinary enrolled member opening `/cash` in production was told:
 *
 *     There is nothing here for you to see. That is the same answer a project
 *     that does not exist gives, on purpose.
 *
 * The owner, at the same instant, saw the active shared frontier. That is the
 * shape of defect that survives longest: it is invisible from the only screen
 * anybody is looking at, and every row underneath it reads as healthy.
 *
 * The cause was that `GET /api/projects/:id/cash` resolved through
 * `requireProject`, which asks `decideProjectAccess` whether the caller is a
 * member of *that project*. The shared frontier is a project; a person who had
 * joined the Brain held no membership row on it; and a Brain administrator
 * reaches every project by design. So the refusal was invariant 23 working
 * exactly as designed, at a door where absent-versus-forbidden was not what was
 * being asked.
 *
 * ---------------------------------------------------------------------------
 * What this suite is for
 * ---------------------------------------------------------------------------
 *
 * It is driven as an *attack* and as a *member*, at the level where the
 * interesting failures live: a payload that says the right thing and carries
 * one field too many, a refusal whose body differs from the refusal beside it,
 * an administrator's control reachable at member level.
 *
 * The redaction assertions are deliberately written against the **serialized
 * payload** rather than against named fields. A test that checked
 * `body.myCash === undefined` would pass a payload that had moved the ledger
 * one key along.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTION_THESIS } from './helpers/cashTier.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/*
 * 7400, and not 7300, which was this suite's first choice.
 *
 * `tests/mcpConnectorPaths.test.ts` on an open pull request already holds
 * 7300, and two suites on one range do not fail loudly: `/healthz` is
 * deliberately unauthenticated, so the second suite's readiness probe finds the
 * first suite's server, waits happily for it, and then signs in against a Brain
 * with a different bootstrap administrator — which reports 401 and reads as a
 * broken sign-in. `deploymentOwnership` refuses overlapping ranges at the
 * merge, which is what caught the last one.
 */
const PORT = pickPort(7400, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';
const SECOND_PASSWORD = 'second-password-000001';

let adminCookie = '';
/** An enrolled member of this Brain with no membership on any project. */
let memberCookie = '';
let secondCookie = '';
let secondId = '';
let workerBearer = '';
let root = '';
let opportunityId = '';

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

async function makePerson(email: string, password: string): Promise<string> {
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName: email.split('@')[0], password: 'temporary-password-01' },
  });
  const first = await signIn(email, 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: password },
  });
  return created.body.user.id;
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

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-shared-cash-'));
  await startServer();

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  /*
   * Two enrolled members of this Brain, **neither of them a member of any
   * project**. That is the production shape exactly: people join the Brain and
   * nobody grants them a membership on the internal Cash root, because the
   * whole point of a shared frontier is that they should not need one.
   */
  await makePerson('airyn@example.invalid', MEMBER_PASSWORD);
  memberCookie = await signIn('airyn@example.invalid', MEMBER_PASSWORD);
  secondId = await makePerson('caleb@example.invalid', SECOND_PASSWORD);
  secondCookie = await signIn('caleb@example.invalid', SECOND_PASSWORD);

  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  const seededProject = seeded.body.projects[0]!.id;

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'a-research-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${seededProject}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      // Generously scoped on purpose: the refusal must not depend on the worker
      // being under-configured.
      scopes: ['project:read', 'work:claim', 'work:complete', 'research:propose', 'external:sync'],
    },
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerBearer = issued.body.secret;

  // One frontier, started the way a person starts it.
  const started = await call('POST', '/api/cash/activate', { cookie: adminCookie, body: {} });
  expect(started.status).toBe(200);
  const mode = await call<{ root: { projectId: string } }>('GET', '/api/cash/mode', {
    cookie: adminCookie,
  });
  root = mode.body.root.projectId;

  // One opening, carried all the way to CLAIMED with its commercial terms
  // filled in, so the redaction has something real to redact.
  const captured = await call<{ opportunity: { id: string } }>(
    'POST',
    `/api/projects/${root}/cash/opportunities`,
    {
      cookie: adminCookie,
      body: {
        title: 'A paid intake repair somebody asked for',
        mechanism: 'EXPLICIT_PAID_REQUEST',
        source: 'They replied to us',
      },
    },
  );
  opportunityId = captured.body.opportunity.id;
  await call('PATCH', `/api/cash/opportunities/${opportunityId}`, {
    cookie: adminCookie,
    body: {
      payer: 'Marguerite Vance, who signs',
      reachableChannel: 'Replied to our message on Tuesday',
      buyingSignal: 'Asked what it would cost',
      signalObservedAt: '2026-09-14T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'A test enquiry arrives in the inbox',
      priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
      /*
       * And the execution thesis, because `markReady` asks for both: the short
       * card is what a bounded *test* turns on and these are what a *decision*
       * turns on. Without them the piece stays at `EVIDENCE_CARD`, which the
       * shared view reports as `BEING_QUALIFIED` — correctly, and it would have
       * left the redaction assertions below exercising an unclaimed piece.
       */
      ...EXECUTION_THESIS,
    },
  });
  const ready = await call('POST', `/api/cash/opportunities/${opportunityId}/ready`, {
    cookie: adminCookie,
    body: {},
  });
  expect(ready.status, ready.text).toBe(200);
  /*
   * A commercial grant, because a money entry needs one — and because the
   * shared view has to be able to say a grant *exists* without saying anything
   * about its ceilings.
   */
  const granted = await call('POST', `/api/projects/${root}/cash/authority`, {
    cookie: adminCookie,
    body: {
      allowedActions: ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'],
      maxCommittedCents: 100_000,
      maxPerActionCents: 40_000,
      maxConcurrent: 2,
    },
  });
  expect(granted.status, granted.text).toBe(200);

  const money = await call('POST', `/api/projects/${root}/cash/money`, {
    cookie: adminCookie,
    body: {
      kind: 'CUSTOMER_PAYMENT',
      amountCents: 41_700,
      currency: 'USD',
      verifiedReference: 'stripe_pi_0001',
      note: 'A payment that cleared',
      idempotencyKey: 'a-payment-that-cleared-0001',
    },
  });
  expect(money.status, money.text).toBe(200);
}, 180_000);

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

const CASH = (): string => `/api/projects/${root}/cash`;

/* -------------------------------------------------------------------------- */

describe('the shared frontier really is shared', () => {
  it('gives the owner the whole sprint', async () => {
    const view = await call<{ scope: string; myCash: unknown; authority: unknown }>('GET', CASH(), {
      cookie: adminCookie,
    });
    expect(view.status).toBe(200);
    expect(view.body.scope).toBe('FULL');
    expect(view.body.myCash).toBeTruthy();
    expect(view.body.authority).toBeTruthy();
  });

  /**
   * The defect, in one assertion.
   *
   * A person who joined this Brain and was granted no project membership at all
   * — which is every member in production — reads the frontier.
   */
  it('gives an ordinary enrolled member the shared read model', async () => {
    const view = await call<{ scope: string; counts: { total: number } }>('GET', CASH(), {
      cookie: memberCookie,
    });
    expect(view.status).toBe(200);
    expect(view.body.scope).toBe('SHARED');
    expect(view.body.counts.total).toBeGreaterThan(0);
  });

  it('never answers an enrolled member with the project-not-found concealment', async () => {
    const view = await call<{ error?: string }>('GET', CASH(), { cookie: memberCookie });
    expect(view.status).not.toBe(404);
    expect(view.text).not.toMatch(/No project with that id/);
  });

  it('shows the same opportunities and the same research counts to both', async () => {
    const owner = await call<{
      myCurrentWork: { placements: { opportunity: { id: string } }[] };
      roadmap: { rounds: { total: number } };
    }>('GET', CASH(), { cookie: adminCookie });
    const member = await call<{
      opportunities: { id: string }[];
      roadmap: { rounds: { total: number } };
    }>('GET', CASH(), { cookie: memberCookie });

    const ownerIds = owner.body.myCurrentWork.placements.map((one) => one.opportunity.id).sort();
    const memberIds = member.body.opportunities.map((one) => one.id).sort();
    expect(memberIds).toEqual(ownerIds);
    expect(member.body.roadmap.rounds.total).toBe(owner.body.roadmap.rounds.total);
  });

  it('gives two different members the same shared reading', async () => {
    const first = await call<{ counts: unknown }>('GET', CASH(), { cookie: memberCookie });
    const second = await call<{ counts: unknown }>('GET', CASH(), { cookie: secondCookie });
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });
});

describe('the refusals that must not have moved', () => {
  it('still refuses an unauthenticated caller', async () => {
    const view = await call('GET', CASH());
    expect(view.status).toBe(401);
  });

  /**
   * A machine is refused by **type**, reads included.
   *
   * §22's rule: no membership configuration turns a worker into a person, and a
   * research worker holding `project:read` on the root must not thereby be
   * handed the portfolio.
   */
  it('still refuses a machine, in the same words a missing project gives it', async () => {
    const real = await call('GET', CASH(), { bearer: workerBearer });
    const invented = await call('GET', '/api/projects/prj_does_not_exist/cash', {
      bearer: workerBearer,
    });
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    // The body too. A status that matches while the body differs is still an
    // oracle.
    expect(real.text).toBe(invented.text);
  });

  it('refuses a session that is not a session', async () => {
    const view = await call('GET', CASH(), { cookie: 'brain_session=not-a-real-session' });
    expect(view.status).toBe(401);
  });

  /**
   * Widening the read did not widen it to *any* project.
   *
   * The subject is the server-resolved root and never a project id the caller
   * chose, so asking about somebody else's project is answered by
   * `decideProjectAccess` exactly as before.
   */
  it('gives a member nothing about a project that is not the shared root', async () => {
    const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
      cookie: adminCookie,
    });
    const other = seeded.body.projects.map((one) => one.id).find((id) => id !== root);
    expect(other).toBeTruthy();
    const real = await call('GET', `/api/projects/${other}/cash`, { cookie: memberCookie });
    const invented = await call('GET', '/api/projects/prj_does_not_exist/cash', {
      cookie: memberCookie,
    });
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(real.text).toBe(invented.text);
  });

  it('refuses a disabled account outright, wherever it points', async () => {
    const throwaway = await makePerson('leaving@example.invalid', 'leaving-password-00001');
    const cookie = await signIn('leaving@example.invalid', 'leaving-password-00001');
    expect((await call('GET', CASH(), { cookie })).status).toBe(200);

    const disabled = await call('POST', `/api/admin/users/${throwaway}/disabled`, {
      cookie: adminCookie,
      body: { disabled: true },
    });
    expect(disabled.status).toBe(200);
    const after = await call('GET', CASH(), { cookie });
    // Not a shared read and not a redacted one: authentication itself fails,
    // because membership is read on every request rather than baked into a
    // session.
    expect(after.status).toBe(401);
  });
});

describe('what a shared reader may never be handed', () => {
  async function shared(): Promise<string> {
    return (await call('GET', CASH(), { cookie: memberCookie })).text;
  }

  it('carries no money, no ledger and no position', async () => {
    const text = await shared();
    expect(text).not.toMatch(/deployableCents/);
    expect(text).not.toMatch(/myCash/);
    expect(text).not.toMatch(/stripe_pi_0001/);
    expect(text).not.toMatch(/41700/);
  });

  it('carries no commercial grant beyond whether one exists', async () => {
    const view = await call<{ commercialGrant: string }>('GET', CASH(), { cookie: memberCookie });
    expect(view.body.commercialGrant).toMatch(/PRESENT|ABSENT/);
    expect(view.text).not.toMatch(/maxCommittedCents/);
    expect(view.text).not.toMatch(/maxPerActionCents/);
    expect(view.text).not.toMatch(/allowedActions/);
  });

  it('carries no commercial term of anybody else’s job', async () => {
    const text = await shared();
    // The values the owner filled in. Every one of them is that job's.
    expect(text).not.toMatch(/Marguerite Vance/);
    expect(text).not.toMatch(/75000/);
    expect(text).not.toMatch(/One fixed-scope intake repair/);
    expect(text).not.toMatch(/One afternoon of configuration/);
    expect(text).not.toMatch(/priceCents/);
  });

  it('carries no decisions belonging to one person', async () => {
    const text = await shared();
    expect(text).not.toMatch(/decisionsForMe/);
    expect(text).not.toMatch(/forecast/);
  });

  it('carries no free-text activity, only counts', async () => {
    const view = await call<{ activity: { kind: string; count: number }[] }>('GET', CASH(), {
      cookie: memberCookie,
    });
    expect(view.body.activity.length).toBeGreaterThan(0);
    for (const one of view.body.activity) {
      expect(typeof one.count).toBe('number');
      expect(Object.keys(one).sort()).toEqual(['count', 'kind', 'mostRecentAt']);
    }
  });

  /**
   * A claimed opportunity is **redacted rather than hidden**.
   *
   * Another member has to know a piece is taken — otherwise two of them
   * research the same opening, which is the waste this whole boundary exists to
   * avoid — and must not learn whose job it is or what it is being sold for.
   */
  it('says a claimed opportunity is claimed, and nothing about the job', async () => {
    const view = await call<{
      opportunities: {
        id: string;
        availability: string;
        title: string;
        ownerUserId?: string;
      }[];
    }>('GET', CASH(), { cookie: memberCookie });
    const one = view.body.opportunities.find((each) => each.id === opportunityId);
    expect(one).toBeTruthy();
    expect(one!.availability).toBe('CLAIMED');
    expect(one!.title).toBe('A paid intake repair somebody asked for');
    expect(one!.ownerUserId).toBeUndefined();
    expect(view.text).not.toMatch(/ownerUserId/);
  });

  /**
   * A false figure is a worse leak than a true one.
   *
   * The first version of the shared projection reused `placements()` and passed
   * it `deployableCents: 0`, so a qualified piece needing funding would have
   * been described — in Brain's own voice, to every member — as waiting on cash
   * the operation might well have had. Nobody reading it could have told it was
   * wrong. The shared reason is derived from the piece's own state, its
   * dependency and its card, and has no branch that can name a figure.
   */
  it('never explains a piece by naming an amount it was not told', async () => {
    const view = await call<{ opportunities: { because: string }[] }>('GET', CASH(), {
      cookie: memberCookie,
    });
    for (const one of view.body.opportunities) {
      expect(one.because, one.because).not.toMatch(/\bcents\b/);
      expect(one.because, one.because).not.toMatch(/deployable/i);
      expect(one.because, one.because).not.toMatch(/\d{3,}/);
    }
    // And no disposition at all: that is a recommendation to whoever owns the
    // job rather than a fact about the frontier.
    expect(view.text).not.toMatch(/"disposition"/);
  });

  it('still resolves every claim to its own evidence', async () => {
    const view = await call<{
      opportunities: { sourceClaimId: string | null; qualification: { missing: string[] } }[];
    }>('GET', CASH(), { cookie: memberCookie });
    // The provenance a member needs in order to check a finding rather than
    // take Brain's word for it, and the machine's own progress by field name.
    expect(view.body.opportunities[0]).toHaveProperty('sourceClaimId');
    expect(Array.isArray(view.body.opportunities[0]!.qualification.missing)).toBe(true);
  });
});

describe('a member may read and may not decide', () => {
  const decisions = (): { method: string; route: string }[] => [
    { method: 'POST', route: '/api/cash/activate' },
    { method: 'POST', route: `${CASH()}/mode` },
    { method: 'POST', route: `${CASH()}/authority` },
    { method: 'POST', route: `${CASH()}/money` },
    { method: 'POST', route: `${CASH()}/commitments` },
    { method: 'POST', route: `${CASH()}/opportunities` },
  ];

  it('refuses every one of them to an ordinary member, and creates nothing', async () => {
    const before = await call<{ counts: { total: number } }>('GET', CASH(), {
      cookie: memberCookie,
    });
    for (const { method, route } of decisions()) {
      const result = await call(method, route, { cookie: memberCookie, body: {} });
      expect([401, 404], `${method} ${route}`).toContain(result.status);
    }
    const after = await call<{ counts: { total: number } }>('GET', CASH(), {
      cookie: memberCookie,
    });
    expect(after.body.counts.total).toBe(before.body.counts.total);
  });

  it('refuses winding the sprint down', async () => {
    const result = await call('POST', `${CASH()}/mode`, {
      cookie: memberCookie,
      body: { state: 'WINDING_DOWN', reason: 'because I can' },
    });
    expect(result.status).toBe(404);
    // And the sprint is still running.
    const still = await call<{ mode: { state: string } }>('GET', CASH(), { cookie: adminCookie });
    expect(still.body.mode.state).toBe('ACTIVE');
  });
});

/* -------------------------------------------------------------------------- */

describe('People & capacity is its own door', () => {
  it('lets every enrolled member read it', async () => {
    const page = await call<{
      you: { isBrainAdmin: boolean };
      people: { rows: { displayName: string }[] };
      capacity: { eligibleNow: number };
      me: { state: string };
    }>('GET', '/api/people', { cookie: memberCookie });
    expect(page.status).toBe(200);
    expect(page.body.you.isBrainAdmin).toBe(false);
    expect(page.body.people.rows.length).toBeGreaterThan(0);
    expect(typeof page.body.capacity.eligibleNow).toBe('number');
    expect(page.body.me.state).toBe('NOT_STARTED');
  });

  it('refuses a machine by type, at the reads as well', async () => {
    for (const route of ['/api/people', '/api/people/me/claude', '/api/people/connections']) {
      expect((await call('GET', route, { bearer: workerBearer })).status).toBe(404);
    }
    expect(
      (await call('POST', '/api/people/me/claude/probe', { bearer: workerBearer, body: {} })).status,
    ).toBe(404);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await call('GET', '/api/people')).status).toBe(401);
  });

  it('gives every member their own Claude setup journey', async () => {
    const mine = await call<{ steps: { key: string; copy?: { value: string }[] }[] }>(
      'GET',
      '/api/people/me/claude',
      { cookie: memberCookie },
    );
    expect(mine.status).toBe(200);
    const keys = mine.body.steps.map((one) => one.key);
    expect(keys).toEqual(['CONNECTOR', 'ROUTINE', 'TRIGGER', 'SECRET', 'PROBE', 'HEALTHY']);
    // Every value a person has to paste is carried as its own copyable string,
    // never as a sentence they have to select part of.
    const connector = mine.body.steps.find((one) => one.key === 'CONNECTOR')!;
    expect(connector.copy?.some((one) => one.value.endsWith('/mcp'))).toBe(true);
  });

  /**
   * The journey is yours by **principal**, not by a path segment.
   *
   * There is no id a member could substitute, which is a stronger guarantee
   * than a check on one: there is nothing to forget to compare.
   */
  it('gives two members two different setups, and neither can address the other', async () => {
    const mine = await call<{ connection: { secretName: string } }>('GET', '/api/people/me/claude', {
      cookie: memberCookie,
    });
    const theirs = await call<{ connection: { secretName: string } }>(
      'GET',
      '/api/people/me/claude',
      { cookie: secondCookie },
    );
    expect(mine.body.connection.secretName).not.toBe(theirs.body.connection.secretName);

    // And the one route that names somebody else is an administrator's.
    const reach = await call('POST', `/api/people/${secondId}/claude/invitation`, {
      cookie: memberCookie,
      body: {},
    });
    const invented = await call('POST', '/api/people/usr_invented/claude/invitation', {
      cookie: memberCookie,
      body: {},
    });
    expect(reach.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(reach.text).toBe(invented.text);
  });

  it('keeps the administrator’s connection list away from an ordinary member', async () => {
    expect((await call('GET', '/api/people/connections', { cookie: memberCookie })).status).toBe(
      404,
    );
    const admin = await call<{ connections: { secretName: string }[] }>(
      'GET',
      '/api/people/connections',
      { cookie: adminCookie },
    );
    expect(admin.status).toBe(200);
    // Names of deployment variables and trigger ids. No value of any kind.
    expect(admin.text).not.toMatch(/Bearer/i);
    expect(admin.text).not.toMatch(/sk-ant/);
  });

  it('keeps operator-depth capacity detail out of a member\u2019s reading', async () => {
    const member = await call<{ capacity: { surfaces: { detail?: unknown }[] } }>(
      'GET',
      '/api/people',
      { cookie: memberCookie },
    );
    /*
     * Their **own** secret name is on the page, and has to be: it is the one
     * thing they send to an administrator, and a journey that would not name it
     * is a journey that cannot be finished. What must not be there is anybody
     * else's, and the operator-depth block on every capacity surface.
     */
    expect(member.body.capacity.surfaces.every((one) => one.detail === undefined)).toBe(true);
    expect(member.text).not.toMatch(/"routineRef"/);
    expect(member.text).not.toMatch(/"totalFires"/);
    expect(member.text).not.toMatch(/"excluded"/);
    const theirs = await call<{ connection: { secretName: string } }>(
      'GET',
      '/api/people/me/claude',
      { cookie: secondCookie },
    );
    expect(member.text).not.toContain(theirs.body.connection.secretName);

    // An administrator gets the same reading with the diagnostics on it.
    const admin = await call<{ capacity: { surfaces: { detail?: unknown }[] } }>(
      'GET',
      '/api/people',
      { cookie: adminCookie },
    );
    expect(admin.status).toBe(200);
    expect(admin.body).toHaveProperty('people.excluded');
  });

  /**
   * Reading either page performs no effect of any kind.
   *
   * Asserted against the queue and the bins rather than against a comment: the
   * one row a read creates is the one that assigns a member their three names,
   * and nothing else is written by looking at anything.
   */
  it('registers, enqueues, claims and fires nothing', async () => {
    const before = await call<{ items: { id: string }[] }>(
      'GET',
      `/api/projects/${root}/work?limit=200`,
      { cookie: adminCookie },
    );
    const capacityBefore = await call<{ capacity: { eligibleNow: number } }>('GET', '/api/people', {
      cookie: adminCookie,
    });

    for (let i = 0; i < 3; i += 1) {
      await call('GET', '/api/people', { cookie: memberCookie });
      await call('GET', CASH(), { cookie: memberCookie });
      await call('GET', '/api/people/me/claude', { cookie: memberCookie });
    }

    const after = await call<{ items: { id: string }[] }>(
      'GET',
      `/api/projects/${root}/work?limit=200`,
      { cookie: adminCookie },
    );
    expect(after.body.items.map((one) => one.id)).toEqual(before.body.items.map((one) => one.id));

    const capacityAfter = await call<{ capacity: { eligibleNow: number } }>('GET', '/api/people', {
      cookie: adminCookie,
    });
    expect(capacityAfter.body.capacity.eligibleNow).toBe(capacityBefore.body.capacity.eligibleNow);
  });

  it('refuses a credential where a trigger id belongs', async () => {
    const result = await call<{ error: string }>('POST', '/api/people/me/claude/trigger', {
      cookie: memberCookie,
      body: { triggerRef: 'sk-ant-api03-something-that-looks-like-a-key' },
    });
    expect(result.status).toBe(422);
    expect(result.body.error).toMatch(/never the credential/i);
    // Nothing was stored, so nothing has to be scrubbed.
    const mine = await call('GET', '/api/people/me/claude', { cookie: memberCookie });
    expect(mine.text).not.toMatch(/sk-ant/);
  });
});

describe('the active sprint keeps running throughout', () => {
  it('is still ACTIVE, with its opportunities and its money intact', async () => {
    const view = await call<{
      mode: { state: string };
      myCash: { position: { customerPaymentsCents: number } };
      myCurrentWork: { placements: unknown[] };
    }>('GET', CASH(), { cookie: adminCookie });
    expect(view.body.mode.state).toBe('ACTIVE');
    expect(view.body.myCurrentWork.placements.length).toBeGreaterThan(0);
    expect(view.body.myCash.position.customerPaymentsCents).toBe(41_700);
  });
});
