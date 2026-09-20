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

  it('carries a tier reading, and the reading carries no value', async () => {
    /*
     * The tier is what separates *evidence Brain found* from *work somebody
     * could do*, and a member reading the frontier without it is reading every
     * record with no way to tell those two apart — the distinction §33 built
     * `tier.ts` for. So it crosses.
     *
     * What makes that safe is not a promise, it is the shape: a `TierReading`
     * is a tier, two static sentences from `SIGNAL_MEANING`, the requirements
     * still open as `{ key, label, task, owner }` — every one of those a
     * constant looked up per field — and two counts. **No branch of it
     * interpolates a value.** This asserts it against the live payload rather
     * than against a reading of the source, because the guarantee that matters
     * is what actually left the server.
     */
    const view = await call<{ opportunities: { tier: Record<string, unknown> }[] }>(
      'GET',
      CASH(),
      { cookie: memberCookie },
    );
    const tiers = view.body.opportunities.map((one) => one.tier);
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      expect(['SIGNAL', 'CANDIDATE', 'QUALIFIED', 'READY_TO_TEST']).toContain(tier['tier']);
      expect(typeof tier['answered']).toBe('number');
      /*
       * No figure anywhere in a tier reading. A price, an exposure or a margin
       * arriving inside a `summary` or a `task` would be the whole boundary
       * leaking through the one field that was argued to be names and counts.
       */
      const text = JSON.stringify(tier);
      expect(text).not.toMatch(/75000/);
      expect(text).not.toMatch(/Marguerite Vance/);
      expect(text).not.toMatch(/[$£€]\s?\d/);
    }
  });

  it('carries the possibility space, and no value of any answer in it', async () => {
    /*
     * The whole ledger crosses in names and counts, for the reason the tier
     * does one line up: a member reading a list of openings with no way to see
     * that one of them has nine live ways of being taken and another has one is
     * reading half the frontier. What makes it safe is the same shape argument
     * — the shared projection is built from the columns it names, and every one
     * of them is a name, a status, a rank or a count.
     *
     * Asserted against the **live payload** rather than against a reading of
     * the source, because the guarantee that matters is what actually left the
     * server.
     */
    /*
     * The space is populated first, so this is not vacuously true.
     *
     * An empty ledger carries no figure either, and a boundary assertion that
     * passes because nothing was sent is the kind of green that teaches
     * somebody to stop believing it — §29's own rule about a warning that
     * cries wolf, read the other way round.
     *
     * Seeded over HTTP rather than by calling the enumeration, because the
     * enumeration runs on the durable tick and this suite drives a server it
     * does not share a database handle with. The case where a *figure* reaches
     * a path — the discovery's own price, carried onto the one method its old
     * `mechanism` column stood for — is proved against the composed projection
     * in `tests/monetizationLedger.test.ts`, which does hold the rows.
     */
    for (const method of ['REFERRAL_FEE', 'INTELLIGENCE_REPORT']) {
      const seeded = await call('POST', `/api/projects/${root}/cash/monetization/paths`, {
        cookie: adminCookie,
        body: { method, opportunityId },
      });
      expect(seeded.status, `seeding ${method}`).toBe(200);
    }

    const view = await call<{
      monetization: {
        total: number;
        paths: { id: string; status: string; rank: number; openQuestions: unknown[] }[];
        topPathIds: string[];
        byStatus: Record<string, number>;
      };
    }>('GET', CASH(), { cookie: memberCookie });

    const space = view.body.monetization;
    expect(space).toBeTruthy();
    expect(space.total).toBeGreaterThan(1);
    expect(space.topPathIds.length).toBeGreaterThan(0);
    expect(typeof space.total).toBe('number');
    expect(Array.isArray(space.paths)).toBe(true);
    expect(space.total).toBe(space.paths.length);
    expect(space.topPathIds.length).toBeLessThanOrEqual(5);

    const text = JSON.stringify(space);
    for (const forbidden of [
      'amountCents',
      'days',
      'margin',
      'economics',
      'risks',
      'basis',
      'assumptions',
      'uncertainty',
      'value',
    ]) {
      expect(text, forbidden).not.toContain(`"${forbidden}":`);
    }
    // And none of the owner's own figures by their literal values.
    expect(text).not.toMatch(/75000/);
    expect(text).not.toMatch(/Marguerite Vance/);
    expect(text).not.toMatch(/[$£€]\s?\d/);
  });

  it('counts the tiers, and counts them over the records it sent', async () => {
    const view = await call<{
      byTier: Record<string, number>;
      opportunities: { id: string; tier: { tier: string } }[];
      best: { id: string }[];
    }>('GET', CASH(), { cookie: memberCookie });

    for (const which of ['SIGNAL', 'CANDIDATE', 'QUALIFIED', 'READY_TO_TEST']) {
      expect(view.body.byTier[which]).toBe(
        view.body.opportunities.filter((one) => one.tier.tier === which).length,
      );
    }
    /*
     * And `best` is a subset of what was sent, rather than a separate answer:
     * the server picks it with `chooseBest`, the same function the owner's
     * `assemble` calls, so both pages name the same openings.
     */
    const ids = new Set(view.body.opportunities.map((one) => one.id));
    for (const one of view.body.best) expect(ids.has(one.id)).toBe(true);
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

/**
 * View parity, at the boundary that decides it.
 *
 * The client's own suite asserts that the two roles render one skeleton. What
 * it cannot assert is that they are rendering **one set of facts**, because a
 * component test scripts both payloads itself. This does: it reads the live
 * server as an administrator and as an ordinary member and holds the shared
 * block of one against the whole of the other.
 *
 * This is the property the whole correction rests on. Two readers of one fact
 * disagree eventually — that has been true of a column, a status line, a review
 * card and a projection in this repository already — so the owner's page does
 * not derive its shared sections from its private blocks. It is handed the same
 * object a member is handed, by the same function, and this is what would fail
 * the day somebody re-derived one of them.
 */
describe('both roles are shown the same shared frontier, byte for byte', () => {
  it('embeds in the owner’s payload exactly what a member is sent', async () => {
    const owner = await call<{ scope: string; frontier: Record<string, unknown> }>(
      'GET',
      CASH(),
      { cookie: adminCookie },
    );
    const member = await call<Record<string, unknown>>('GET', CASH(), { cookie: memberCookie });

    expect(owner.body.scope).toBe('FULL');
    expect(member.body['scope']).toBe('SHARED');

    /*
     * `scope` and `capabilities` are the envelope rather than the frontier —
     * they say how it was asked for and what may be pressed, and they are
     * correctly different. Everything else must be identical.
     */
    const { scope: _s, capabilities: _c, ...frontier } = member.body;
    expect(owner.body.frontier).toEqual(frontier);
  });

  it('tells each role what it may press, and tells a member it may press nothing', async () => {
    const owner = await call<{ capabilities: Record<string, boolean> }>('GET', CASH(), {
      cookie: adminCookie,
    });
    const member = await call<{ capabilities: Record<string, boolean> }>('GET', CASH(), {
      cookie: memberCookie,
    });

    expect(owner.body.capabilities).toEqual({
      mayAdminister: true,
      mayGrantAuthority: true,
      mayViewPrivateJob: true,
      mayActOnJob: true,
    });
    /*
     * All four false, including the two reads. A shared payload has no private
     * block for a control to act on, so this is the boundary restated rather
     * than a second opinion about it.
     */
    expect(member.body.capabilities).toEqual({
      mayAdminister: false,
      mayGrantAuthority: false,
      mayViewPrivateJob: false,
      mayActOnJob: false,
    });
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
    /*
     * `INVITATION` first. The journey used to start at the connector, and a
     * member who followed it was refused at a consent screen that looks for an
     * administrator before it looks for an invitation — so the step that was
     * genuinely first was the one nobody was told about.
     */
    expect(keys).toEqual([
      'INVITATION',
      'CONNECTOR',
      'ROUTINE',
      'TRIGGER',
      'SECRET',
      'PROBE',
      'HEALTHY',
    ]);
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

/**
 * The release gate proves the boundary from the wrong side of it.
 *
 * ---------------------------------------------------------------------------
 * Why this reads the repository rather than behaviour
 * ---------------------------------------------------------------------------
 *
 * Everything above drives a real server over a real socket and is the right
 * instrument for the seam itself. It cannot answer the question the correction
 * actually asked, which is whether the *deployed* Brain serves the frontier to
 * a real member — and §11 was explicit that an administrator's screenshot does
 * not settle it, because the administrator was never refused.
 *
 * `scripts/verify-hosted.ts` is the one caller that runs against the released
 * image, signed in as `verification-member@brain.invalid`: a real authenticated
 * person holding no membership on the cash root and no administrator rights.
 * So the live proof belongs there, and this asserts it is still there — because
 * nothing in the suite executes that script, which is exactly how §33's
 * `geography_basis` defect reached production with the whole suite green.
 */
describe('the live proof is in the gate that runs on the deployed image', () => {
  const script = fs.readFileSync(
    fileURLToPath(new URL('../scripts/verify-hosted.ts', import.meta.url)),
    'utf8',
  );

  it('reads the shared frontier as the member, and is actually called', () => {
    expect(script).toContain('async function sharedCashBoundary(');
    // Declared and never called is the failure mode this file keeps meeting.
    expect(script).toContain('await sharedCashBoundary(fixtures, cookie);');
    expect(script).toContain("call('/api/cash/mode'");
    expect(script).toMatch(/projects\/\$\{rootId\}\/cash/);
  });

  it('asserts the private half did not cross, by name', () => {
    // The money keys are the ones the first version of the projection leaked,
    // by passing `deployableCents` into a function that composes a sentence
    // out of it. A shape assertion that named no field would not have caught it.
    for (const forbidden of [
      'myCash',
      'deployableCents',
      'commitments',
      'decisionsForMe',
      // The possibility ledger's own private half: the structured figure every
      // money answer carries, the derived margin, and the risks quoted out of
      // answers.
      'amountCents',
      'margin',
      'risks',
    ]) {
      expect(script, forbidden).toContain(`'${forbidden}'`);
    }
  });

  it('reads the possibility space positively, not only by its absences', () => {
    /*
     * "No figure crossed" is also true of a projection that sent nothing, so
     * the gate reads that the space is there as well as that its values are
     * not — the same reason the grant is asserted PRESENT-or-ABSENT rather
     * than merely being absent.
     */
    expect(script).toContain('the monetization possibility space crossed, in names and counts');
  });

  it('proves the refusals are still refusals, and the decisions still the owner’s', () => {
    expect(script).toContain('the member holds no membership on the cash root');
    expect(script).toContain("another operation's Cash is refused exactly as a missing one is");
    expect(script).toContain('a member cannot activate or wind down the sprint');
    expect(script).toContain('a member cannot grant commercial authority');
  });
});
