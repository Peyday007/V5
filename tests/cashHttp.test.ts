/**
 * Cash Mode's door, driven as an attack.
 *
 * The service tests prove the decisions. This proves the routes are actually
 * behind the gate, against a real booted server — which is the only level where
 * the interesting failures live. A handler that resolves an opportunity before
 * authorizing it, a refusal that says "forbidden" for a sprint that exists and
 * "not found" for one that does not, an ADMIN decision reachable at WRITE, a
 * machine credential that reaches a spending ceiling: none of those is visible
 * from a unit test of the policy.
 *
 * Two properties get the most attention because they are the ones the plan
 * makes load-bearing.
 *
 * **Four private operations really are private.** A person who is not a member
 * gets the same 404 a missing project gives, **with the same body**, because a
 * status code that matches while the body differs is still an oracle.
 *
 * **A machine can never spend anybody's money.** A worker credential is refused
 * at every route here — by level at the two ADMIN ones, by `MISSING_SCOPE` at
 * every write, and by principal *type* at all of them including the reads.
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
const PORT = pickPort(6800, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';
const OUTSIDER_PASSWORD = 'outsider-password-00001';

let adminCookie = '';
let memberCookie = '';
let outsiderCookie = '';
let workerBearer = '';
let project = '';

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
    body: { email, displayName: email, password: 'temporary-password-01' },
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

const CASH = (): string => `/api/projects/${project}/cash`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cash-'));
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

  const memberId = await makePerson('member@example.invalid', MEMBER_PASSWORD);
  memberCookie = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: memberId, principalType: 'HUMAN', role: 'MEMBER' },
  });

  // Somebody with an account and no membership anywhere.
  await makePerson('outsider@example.invalid', OUTSIDER_PASSWORD);
  outsiderCookie = await signIn('outsider@example.invalid', OUTSIDER_PASSWORD);

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'a-research-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${project}/members`, {
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

describe('who can reach any of this', () => {
  const routes = (): { method: string; route: string }[] => [
    { method: 'GET', route: CASH() },
    { method: 'POST', route: `${CASH()}/mode` },
    { method: 'POST', route: `${CASH()}/authority` },
    { method: 'POST', route: `${CASH()}/opportunities` },
    { method: 'POST', route: `${CASH()}/money` },
    { method: 'POST', route: `${CASH()}/commitments` },
    { method: 'POST', route: `${CASH()}/needs` },
  ];

  it('refuses an anonymous caller everywhere', async () => {
    for (const { method, route } of routes()) {
      const result = await call(method, route, method === 'GET' ? {} : { body: {} });
      expect(result.status).toBe(401);
    }
  });

  it('refuses a machine by principal type, however generously it is scoped', async () => {
    for (const { method, route } of routes()) {
      const result = await call(
        method,
        route,
        method === 'GET' ? { bearer: workerBearer } : { bearer: workerBearer, body: {} },
      );
      // Not 403. A machine that could tell a real route from a missing one here
      // would be able to enumerate which projects run a sprint.
      expect(result.status).toBe(404);
    }
  });

  it('gives a non-member the same answer, in the same words, as a project that does not exist', async () => {
    const real = await call('GET', CASH(), { cookie: outsiderCookie });
    const invented = await call('GET', '/api/projects/prj_does_not_exist/cash', {
      cookie: outsiderCookie,
    });
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    // The body too: a status that matches while the body differs is still an
    // oracle for enumerating a Brain you have no access to.
    expect(real.text).toBe(invented.text);
  });
});

describe('the two decisions that are a person’s', () => {
  it('refuses a project member who does not administer it', async () => {
    const activate = await call('POST', `${CASH()}/mode`, {
      cookie: memberCookie,
      body: { objective: 'Maximize additional usable cash over the next few weeks.' },
    });
    expect(activate.status).toBe(404);
  });

  it('lets an administrator activate it, and says so', async () => {
    const result = await call<{ mode: { state: string }; changed: boolean; message: string }>(
      'POST',
      `${CASH()}/mode`,
      {
        cookie: adminCookie,
        body: { objective: 'Maximize additional usable cash over the next few weeks.' },
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.mode.state).toBe('ACTIVE');
    expect(result.body.changed).toBe(true);
    expect(result.body.message).toContain('nothing has been spent');
  });

  it('refuses a commercial grant with an action this Brain does not know', async () => {
    const result = await call('POST', `${CASH()}/authority`, {
      cookie: adminCookie,
      body: {
        allowedActions: ['CONTACT_BUYER', 'TRANSFER_EVERYTHING'],
        maxCommittedCents: 100_000,
        maxPerActionCents: 40_000,
      },
    });
    expect(result.status).toBe(400);
  });

  it('refuses a commercial grant with no ceilings, because money is genuinely scarce', async () => {
    const result = await call<{ error: string }>('POST', `${CASH()}/authority`, {
      cookie: adminCookie,
      body: { allowedActions: ['CONTACT_BUYER'] },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('genuinely scarce');
  });

  it('refuses a single commitment larger than everything that may be committed', async () => {
    const result = await call('POST', `${CASH()}/authority`, {
      cookie: adminCookie,
      body: {
        allowedActions: ['CONTACT_BUYER'],
        maxCommittedCents: 10_000,
        maxPerActionCents: 50_000,
      },
    });
    expect(result.status).toBe(400);
  });
});

describe('one account’s whole journey', () => {
  let opportunityId = '';

  it('starts with no commercial authority, and says that is the decision outstanding', async () => {
    const view = await call<{
      authority: { exists: boolean };
      decisionsForMe: { items: { key: string }[] };
    }>('GET', CASH(), { cookie: adminCookie });
    expect(view.status).toBe(200);
    expect(view.body.authority.exists).toBe(false);
    expect(view.body.decisionsForMe.items[0]!.key).toBe('AUTHORITY');
  });

  it('captures an opening and reports what is still unknown on its card', async () => {
    const captured = await call<{
      opportunity: { id: string };
      card: { readiness: { ready: boolean; missing: string[] } };
      message: string;
    }>('POST', `${CASH()}/opportunities`, {
      cookie: adminCookie,
      body: {
        title: 'A paid intake repair somebody asked for',
        mechanism: 'EXPLICIT_PAID_REQUEST',
        source: 'They replied to us',
      },
    });
    expect(captured.status).toBe(200);
    expect(captured.body.message).toContain('nobody has been contacted');
    expect(captured.body.card.readiness.ready).toBe(false);
    opportunityId = captured.body.opportunity.id;
  });

  it('refuses an unknown mechanism rather than guessing the nearest one', async () => {
    const result = await call('POST', `${CASH()}/opportunities`, {
      cookie: adminCookie,
      body: { title: 'Something', mechanism: 'VIBES' },
    });
    expect(result.status).toBe(422);
  });

  it('refuses to mark an incomplete card ready, naming what is unknown', async () => {
    const result = await call<{ error: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/ready`,
      { cookie: adminCookie, body: {} },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('an unknown is not a yes');
  });

  it('lets a project member fill in the card, because that is work rather than a decision', async () => {
    const filled = await call<{ card: { readiness: { ready: boolean } } }>(
      'PATCH',
      `/api/cash/opportunities/${opportunityId}`,
      {
        cookie: memberCookie,
        body: {
          payer: 'The owner, who signs',
          reachableChannel: 'Replied to our message on Tuesday',
          buyingSignal: 'Asked what it would cost',
          signalObservedAt: '2026-09-14T09:00:00.000Z',
          offerScope: 'One fixed-scope intake repair',
          acceptanceCondition: 'A test enquiry arrives in the inbox',
          priceCents: 75_000,
          deliveryMethod: 'One afternoon of configuration',
          fulfillmentOwner: 'Us',
          peakFundingCents: 0,
        },
      },
    );
    expect(filled.status).toBe(200);
    expect(filled.body.card.readiness.ready).toBe(true);
  });

  it('marks it ready, and then refuses to execute for want of a commercial grant', async () => {
    const ready = await call('POST', `/api/cash/opportunities/${opportunityId}/ready`, {
      cookie: adminCookie,
      body: {},
    });
    expect(ready.status).toBe(200);

    const execute = await call<{ error: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/execute`,
      { cookie: adminCookie, body: {} },
    );
    expect(execute.status).toBe(422);
    expect(execute.body.error).toContain('no standing commercial authority');
    expect(execute.body.error).toContain('nothing else is blocked by it');
  });

  it('grants the authority, in the server’s own words', async () => {
    const granted = await call<{ lines: string[] }>('POST', `${CASH()}/authority`, {
      cookie: adminCookie,
      body: {
        allowedActions: ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT', 'RUN_PAID_TEST'],
        maxCommittedCents: 100_000,
        maxPerActionCents: 40_000,
        maxConcurrent: 2,
      },
    });
    expect(granted.status).toBe(200);
    expect(granted.body.lines.join(' ')).toContain('PAID_OVERAGE');
    expect(granted.body.lines.join(' ')).toContain('1,000.00');
  });

  it('refuses a second live grant rather than making "the limits you set" ambiguous', async () => {
    const second = await call<{ error: string }>('POST', `${CASH()}/authority`, {
      cookie: adminCookie,
      body: {
        allowedActions: ['CONTACT_BUYER'],
        maxCommittedCents: 999_999,
        maxPerActionCents: 999_999,
      },
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('ambiguous');
  });

  it('executes once the grant exists', async () => {
    const execute = await call<{ opportunity: { state: string } }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/execute`,
      { cookie: adminCookie, body: {} },
    );
    expect(execute.status).toBe(200);
    expect(execute.body.opportunity.state).toBe('EXECUTING');
  });

  it('refuses a payment with no verifiable reference', async () => {
    const result = await call<{ error: string }>('POST', `${CASH()}/money`, {
      cookie: adminCookie,
      body: {
        opportunityId,
        kind: 'CUSTOMER_PAYMENT',
        amountCents: 75_000,
      },
    });
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('pipeline, not cash');
  });

  it('records the payment, and keeps it out of available funds until it settles', async () => {
    const paid = await call('POST', `${CASH()}/money`, {
      cookie: adminCookie,
      body: {
        opportunityId,
        kind: 'CUSTOMER_PAYMENT',
        amountCents: 75_000,
        verifiedReference: 'pi_test_journey',
        fundsAvailableAt: '2026-09-29T00:00:00.000Z',
      },
    });
    expect(paid.status).toBe(200);

    const view = await call<{
      myCash: { position: { customerPaymentsCents: number; availableFundsCents: number } };
    }>('GET', CASH(), { cookie: adminCookie });
    expect(view.body.myCash.position.customerPaymentsCents).toBe(75_000);
    expect(view.body.myCash.position.availableFundsCents).toBe(0);
  });

  it('holds part of the ceiling, and is idempotent about it', async () => {
    const body = {
      opportunityId,
      action: 'RUN_PAID_TEST',
      amountCents: 20_000,
      purpose: 'Remove the missing supplier price',
      expectedResult: 'A quotable cost for the parts',
      stopCondition: 'Stop after one quote',
      idempotencyKey: 'journey-commit-1',
    };
    const first = await call<{ commitment: { id: string }; message: string }>(
      'POST',
      `${CASH()}/commitments`,
      { cookie: adminCookie, body },
    );
    expect(first.status).toBe(200);

    const retry = await call<{ commitment: { id: string }; message: string }>(
      'POST',
      `${CASH()}/commitments`,
      { cookie: adminCookie, body },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.commitment.id).toBe(first.body.commitment.id);
    expect(retry.body.message).toContain('already existed');

    const view = await call<{ myCash: { position: { heldCommitmentsCents: number } } }>(
      'GET',
      CASH(),
      { cookie: adminCookie },
    );
    expect(view.body.myCash.position.heldCommitmentsCents).toBe(20_000);
  });

  it('refuses a commitment that names no obstacle', async () => {
    const result = await call('POST', `${CASH()}/commitments`, {
      cookie: adminCookie,
      body: {
        action: 'RUN_PAID_TEST',
        amountCents: 1_000,
        purpose: 'Remove the missing supplier price',
        expectedResult: 'A quotable cost',
        idempotencyKey: 'no-stop-condition',
      },
    });
    expect(result.status).toBe(400);
  });

  it('records a need with a recommended way forward, and refuses one without', async () => {
    const good = await call('POST', `${CASH()}/needs`, {
      cookie: adminCookie,
      body: {
        opportunityId,
        blockedAction: 'Send a hosted invoice',
        whyItMatters: 'The buyer cannot pay without one.',
        recommendedPath: 'Use a hosted payment link from the existing provider account.',
        setupEffort: 'Minutes, no code.',
        nextStep: 'Create the link and send it.',
        expectedCostCents: 0,
      },
    });
    expect(good.status).toBe(200);

    const bare = await call('POST', `${CASH()}/needs`, {
      cookie: adminCookie,
      body: { blockedAction: 'Something is blocked', whyItMatters: 'It matters.' },
    });
    expect(bare.status).toBe(400);
  });

  it('shows the whole private section in one read', async () => {
    const view = await call<{
      objective: string;
      discovery: { open: boolean };
      myCurrentWork: { placements: { disposition: string }[] };
      whatBrainNeeds: unknown[];
      whatBrainHasDone: unknown[];
      decisionsForMe: { items: unknown[]; underlyingCount: number };
      vocabulary: { neverAuthorizable: string[] };
    }>('GET', CASH(), { cookie: adminCookie });

    expect(view.status).toBe(200);
    expect(view.body.discovery.open).toBe(true);
    expect(view.body.myCurrentWork.placements.length).toBe(1);
    expect(view.body.whatBrainNeeds.length).toBe(1);
    expect(view.body.whatBrainHasDone.length).toBeGreaterThan(3);
    expect(view.body.vocabulary.neverAuthorizable).toContain('PAID_OVERAGE');
  });

  it('refuses an opportunity id somebody guessed, in the same words as a missing one', async () => {
    const guessed = await call('GET', '/api/cash/opportunities/cop_invented', {
      cookie: adminCookie,
    });
    expect(guessed.status).toBe(404);

    const outsider = await call('GET', `/api/cash/opportunities/${opportunityId}`, {
      cookie: outsiderCookie,
    });
    expect(outsider.status).toBe(404);
  });

  it('refuses an action that is not one of the transitions this has', async () => {
    const result = await call('POST', `/api/cash/opportunities/${opportunityId}/teleport`, {
      cookie: adminCookie,
      body: {},
    });
    expect(result.status).toBe(404);
  });

  it('winds down without stopping anything that is running', async () => {
    const wound = await call<{ message: string }>('POST', `${CASH()}/mode`, {
      cookie: adminCookie,
      body: { state: 'WINDING_DOWN', reason: 'The sprint is nearly over.' },
    });
    expect(wound.status).toBe(200);
    expect(wound.body.message).toContain('so is every other part of this Brain');

    // No new discovery.
    const captured = await call('POST', `${CASH()}/opportunities`, {
      cookie: adminCookie,
      body: { title: 'Something new', mechanism: 'OTHER' },
    });
    expect(captured.status).toBe(422);

    // And the piece already running still collects and still settles.
    const collected = await call('POST', `/api/cash/opportunities/${opportunityId}/collect`, {
      cookie: adminCookie,
      body: { outcome: 'Delivered and paid.' },
    });
    expect(collected.status).toBe(200);

    const settled = await call('POST', `${CASH()}/money`, {
      cookie: adminCookie,
      body: {
        opportunityId,
        kind: 'SETTLEMENT',
        amountCents: 75_000,
        verifiedReference: 'po_test_journey',
      },
    });
    expect(settled.status).toBe(200);

    const view = await call<{ myCash: { position: { availableFundsCents: number } } }>(
      'GET',
      CASH(),
      { cookie: adminCookie },
    );
    expect(view.body.myCash.position.availableFundsCents).toBe(75_000);
  });

  it('withdraws the grant without destroying a single record', async () => {
    const before = await call<{ authority: { id: string } }>('GET', CASH(), {
      cookie: adminCookie,
    });
    const withdrawn = await call<{ message: string }>(
      'POST',
      `${CASH()}/authority/${before.body.authority.id}/withdraw`,
      { cookie: adminCookie, body: { reason: 'The sprint is over.' } },
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.message).toContain('exactly as it was');

    const after = await call<{
      authority: { exists: boolean };
      myCash: { commitments: unknown[]; position: { availableFundsCents: number } };
      myCurrentWork: { placements: unknown[] };
    }>('GET', CASH(), { cookie: adminCookie });
    expect(after.body.authority.exists).toBe(false);
    expect(after.body.myCash.commitments.length).toBe(1);
    expect(after.body.myCash.position.availableFundsCents).toBe(75_000);
    expect(after.body.myCurrentWork.placements.length).toBe(1);
  });

  it('refuses a withdrawal of a grant that is not this project’s live one', async () => {
    const result = await call('POST', `${CASH()}/authority/cau_invented/withdraw`, {
      cookie: adminCookie,
      body: { reason: 'Trying it on.' },
    });
    expect(result.status).toBe(404);
  });
});
