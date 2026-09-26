/**
 * Recording a commercial action after execution has begun.
 *
 * `beginExecution`'s `firstAction` branch records exactly one action and moves
 * a piece `READY -> EXECUTING`. Everything after that — a quote, an invoice, a
 * payment accepted — has nowhere to land until this route: `record-action`
 * records a further action on a piece already `EXECUTING` or `DELIVERING`
 * without moving it anywhere.
 *
 * Driven over a real booted server, in the style of `tests/cashHttp.test.ts`:
 * the interesting failures — a route reachable at the wrong level, a body that
 * differs between "does not exist" and "not yours" — live at the HTTP layer
 * rather than in the service function alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXECUTION_THESIS } from './helpers/cashTier.ts';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(8000, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const OUTSIDER_PASSWORD = 'outsider-password-00001';

let adminCookie = '';
let outsiderCookie = '';
let workerBearer = '';
let project = '';
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cash-further-'));
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

  // Somebody with an account and no membership anywhere.
  await makePerson('outsider-further@example.invalid', OUTSIDER_PASSWORD);
  outsiderCookie = await signIn('outsider-further@example.invalid', OUTSIDER_PASSWORD);

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'a-further-action-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      // Generously scoped on purpose: the refusal must not depend on the
      // worker being under-configured.
      scopes: ['project:read', 'work:claim', 'work:complete', 'research:propose', 'external:sync'],
    },
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${worker.body.worker.id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  workerBearer = issued.body.secret;

  // Activate the sprint first: creating an opportunity needs an ACTIVE mode.
  const activated = await call('POST', `${CASH()}/mode`, {
    cookie: adminCookie,
    body: { objective: 'Maximize additional usable cash over the next few weeks.' },
  });
  expect(activated.status).toBe(200);

  // Grant commercial authority up front: every case in this file needs one,
  // and only the authority-shaped refusal below withholds a covered action.
  const granted = await call('POST', `${CASH()}/authority`, {
    cookie: adminCookie,
    body: {
      allowedActions: ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'],
      maxCommittedCents: 100_000,
      maxPerActionCents: 100_000,
      maxConcurrent: 2,
    },
  });
  expect(granted.status).toBe(200);

  // Capture, complete the card, mark ready, and execute — the same path
  // tests/cashHttp.test.ts's journey walks — so there is an EXECUTING piece to
  // record further actions on.
  const captured = await call<{ opportunity: { id: string } }>('POST', `${CASH()}/opportunities`, {
    cookie: adminCookie,
    body: {
      title: 'A paid repair somebody asked for',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      source: 'They replied to us',
    },
  });
  opportunityId = captured.body.opportunity.id;

  const filled = await call('PATCH', `/api/cash/opportunities/${opportunityId}`, {
    cookie: adminCookie,
    body: {
      payer: 'The owner, who signs',
      reachableChannel: 'Replied to our message on Tuesday',
      buyingSignal: 'Asked what it would cost',
      signalObservedAt: '2026-09-14T09:00:00.000Z',
      offerScope: 'One fixed-scope repair',
      acceptanceCondition: 'A test enquiry arrives in the inbox',
      priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
      ...EXECUTION_THESIS,
    },
  });
  expect(filled.status).toBe(200);

  const ready = await call('POST', `/api/cash/opportunities/${opportunityId}/ready`, {
    cookie: adminCookie,
    body: {},
  });
  expect(ready.status).toBe(200);

  const executed = await call<{ opportunity: { state: string } }>(
    'POST',
    `/api/cash/opportunities/${opportunityId}/execute`,
    {
      cookie: adminCookie,
      body: {
        action: 'CONTACT_BUYER',
        detail: 'Emailed the owner with a one-line scope and a price.',
        reference: 'msg-first-move',
      },
    },
  );
  expect(executed.status).toBe(200);
  expect(executed.body.opportunity.state).toBe('EXECUTING');
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

describe('recording a further commercial action', () => {
  it('refuses a worker principal, byte-identical to every other write here', async () => {
    const result = await call('POST', `/api/cash/opportunities/${opportunityId}/record-action`, {
      bearer: workerBearer,
      body: { action: 'QUOTE_AND_INVOICE', detail: 'Sent the invoice.' },
    });
    expect(result.status).toBe(404);
  });

  it('gives a caller without project access the same 404 a non-existent opportunity gives', async () => {
    const real = await call(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      { cookie: outsiderCookie, body: { action: 'QUOTE_AND_INVOICE', detail: 'Sent the invoice.' } },
    );
    const invented = await call(
      'POST',
      '/api/cash/opportunities/cop_does_not_exist/record-action',
      { cookie: outsiderCookie, body: { action: 'QUOTE_AND_INVOICE', detail: 'Sent the invoice.' } },
    );
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(real.text).toBe(invented.text);
  });

  it('refuses an action outside the closed commercial vocabulary', async () => {
    const result = await call<{ error: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      { cookie: adminCookie, body: { action: 'DO_WHATEVER_IT_TAKES', detail: 'Rang round.' } },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('not an action this Brain knows how to authorize');
  });

  it('refuses an action the standing grant does not cover', async () => {
    // The grant covers CONTACT_BUYER, QUOTE_AND_INVOICE and ACCEPT_PAYMENT —
    // not RUN_PAID_TEST — so a real commercial action outside it is still
    // refused for want of authorization rather than for an unknown vocabulary.
    const result = await call<{ error: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      { cookie: adminCookie, body: { action: 'RUN_PAID_TEST', detail: 'Ran a paid check.' } },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('does not cover RUN_PAID_TEST');
  });

  it('records the action once, over the real route, with one event and no state change', async () => {
    const before = await call<{ opportunity: { state: string }; history: { kind: string }[] }>(
      'GET',
      `/api/cash/opportunities/${opportunityId}`,
      { cookie: adminCookie },
    );
    expect(before.body.opportunity.state).toBe('EXECUTING');
    // One CASH_ACTION_RECORDED from `execute` in beforeAll.
    expect(before.body.history.filter((event) => event.kind === 'CASH_ACTION_RECORDED')).toHaveLength(
      1,
    );

    const recorded = await call<{ opportunity: { id: string; state: string }; message: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      {
        cookie: adminCookie,
        body: {
          action: 'QUOTE_AND_INVOICE',
          detail: 'Sent the quote and invoice for the agreed scope.',
          reference: 'inv-0001',
        },
      },
    );
    expect(recorded.status).toBe(200);
    expect(recorded.body.opportunity.state).toBe('EXECUTING');

    const after = await call<{
      opportunity: { state: string };
      history: { kind: string; summary: string }[];
    }>('GET', `/api/cash/opportunities/${opportunityId}`, { cookie: adminCookie });
    expect(after.body.opportunity.state).toBe('EXECUTING');
    const recordedEvents = after.body.history.filter((event) => event.kind === 'CASH_ACTION_RECORDED');
    expect(recordedEvents).toHaveLength(2);
    expect(recordedEvents.some((event) => event.summary.includes('QUOTE_AND_INVOICE'))).toBe(true);
  });

  it('records nothing new when the same request arrives again', async () => {
    const again = await call<{ opportunity: { state: string }; message: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      {
        cookie: adminCookie,
        body: {
          action: 'QUOTE_AND_INVOICE',
          detail: 'Sent the quote and invoice for the agreed scope.',
          reference: 'inv-0001',
        },
      },
    );
    expect(again.status).toBe(200);
    expect(again.body.message).toContain('Already recorded');

    const after = await call<{ history: { kind: string }[] }>(
      'GET',
      `/api/cash/opportunities/${opportunityId}`,
      { cookie: adminCookie },
    );
    expect(after.body.history.filter((event) => event.kind === 'CASH_ACTION_RECORDED')).toHaveLength(2);
  });

  it('records a genuine second occurrence of the same action, rather than deduping it against the first', async () => {
    // This is the finding itself: the Cash page sent the literal string
    // 'first' as `occurrence` on every confirm, so a second real invoice on
    // this same opportunity — different wording, a different reference —
    // built the identical request key as the first one and vanished behind a
    // silent "Already recorded". The key must now depend on what actually
    // happened rather than on a caller-supplied counter that never varied.
    const second = await call<{ opportunity: { state: string }; message: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      {
        cookie: adminCookie,
        body: {
          action: 'QUOTE_AND_INVOICE',
          detail: 'Sent a corrected invoice after the client asked for a split payment.',
          reference: 'inv-0002',
        },
      },
    );
    expect(second.status).toBe(200);
    expect(second.body.message).not.toContain('Already recorded');

    const after = await call<{ history: { kind: string; summary: string }[] }>(
      'GET',
      `/api/cash/opportunities/${opportunityId}`,
      { cookie: adminCookie },
    );
    // CONTACT_BUYER from `execute`, the first QUOTE_AND_INVOICE, and this one.
    const recordedEvents = after.body.history.filter((event) => event.kind === 'CASH_ACTION_RECORDED');
    expect(recordedEvents).toHaveLength(3);
    expect(
      recordedEvents.filter((event) => event.summary.includes('QUOTE_AND_INVOICE')),
    ).toHaveLength(2);
  });

  it('still dedupes an exact resubmission of that second occurrence', async () => {
    // Content-derived does not mean unprotected: a retry of the identical
    // detail and reference must still reach the row it already wrote rather
    // than adding a third QUOTE_AND_INVOICE nobody actually sent.
    const again = await call<{ message: string }>(
      'POST',
      `/api/cash/opportunities/${opportunityId}/record-action`,
      {
        cookie: adminCookie,
        body: {
          action: 'QUOTE_AND_INVOICE',
          detail: 'Sent a corrected invoice after the client asked for a split payment.',
          reference: 'inv-0002',
        },
      },
    );
    expect(again.status).toBe(200);
    expect(again.body.message).toContain('Already recorded');

    const after = await call<{ history: { kind: string }[] }>(
      'GET',
      `/api/cash/opportunities/${opportunityId}`,
      { cookie: adminCookie },
    );
    expect(after.body.history.filter((event) => event.kind === 'CASH_ACTION_RECORDED')).toHaveLength(3);
  });

  it('refuses a piece that has not started executing', async () => {
    const untouched = await call<{ opportunity: { id: string } }>(
      'POST',
      `${CASH()}/opportunities`,
      {
        cookie: adminCookie,
        body: {
          title: 'A second opening, still discovered',
          mechanism: 'EXPLICIT_PAID_REQUEST',
          source: 'Also replied',
        },
      },
    );
    const result = await call<{ error: string }>(
      'POST',
      `/api/cash/opportunities/${untouched.body.opportunity.id}/record-action`,
      { cookie: adminCookie, body: { action: 'QUOTE_AND_INVOICE', detail: 'Sent the invoice.' } },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('discovered');
  });

  it('refuses a terminal piece', async () => {
    const declined = await call<{ opportunity: { id: string } }>(
      'POST',
      `${CASH()}/opportunities`,
      {
        cookie: adminCookie,
        body: {
          title: 'A third opening, about to be declined',
          mechanism: 'EXPLICIT_PAID_REQUEST',
          source: 'Also replied',
        },
      },
    );
    const declinedId = declined.body.opportunity.id;
    const decline = await call('POST', `/api/cash/opportunities/${declinedId}/decline`, {
      cookie: adminCookie,
      body: { reason: 'Not worth pursuing.' },
    });
    expect(decline.status).toBe(200);

    const result = await call<{ error: string }>(
      'POST',
      `/api/cash/opportunities/${declinedId}/record-action`,
      { cookie: adminCookie, body: { action: 'QUOTE_AND_INVOICE', detail: 'Sent the invoice.' } },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('declined');
  });
});
