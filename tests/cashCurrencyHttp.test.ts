/**
 * A sprint that is not in dollars, driven the way a person drives one.
 *
 * `activateCashMode` took a `currency` argument and left the column out of its
 * INSERT, so `053`'s `DEFAULT 'USD'` won. Activating in euros succeeded,
 * reported success, and stored dollars — and every figure afterwards was
 * correct arithmetic over the wrong label. **A default is what makes a dropped
 * argument invisible**, which is why nothing failed and no test caught it.
 *
 * It needs its own server because project creation is deliberately not an HTTP
 * route (§26) and `cashHttp` activates its only project in dollars on the way
 * past. A suite that drives a real server owns a port range no other suite can
 * reach, for the reason `helpers/ports.ts` records.
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
const PORT = pickPort(6900, 100);
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';
let adminCookie = '';
let project = '';

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
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
  return { status: response.status, body: body as T };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-eur-'));
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
}, 90_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const CASH = (): string => `/api/projects/${project}/cash`;

interface Position {
  currency: string;
  availableFundsCents: number;
  pipelineCents: number;
  otherCurrencies: string[];
}

describe('a sprint activated in euros keeps its money in euros', () => {
  it('stores the currency the person chose rather than the column default', async () => {
    const activated = await call<{ mode: { currency: string } }>('POST', `${CASH()}/mode`, {
      cookie: adminCookie,
      body: {
        objective: 'Maximize additional usable cash over the next few weeks.',
        currency: 'EUR',
      },
    });
    expect(activated.status).toBe(200);
    expect(activated.body.mode.currency).toBe('EUR');

    // Read back rather than echoed: the defect was a successful reply about a
    // row that said something else.
    const view = await call<{ myCash: { position: Position } }>('GET', CASH(), {
      cookie: adminCookie,
    });
    expect(view.body.myCash.position.currency).toBe('EUR');
  });

  it('refuses a currency this sprint does not keep, rather than adding it', async () => {
    const inDollars = await call<{ error: string }>('POST', `${CASH()}/money`, {
      cookie: adminCookie,
      body: {
        kind: 'CAPITAL_IN',
        amountCents: 50_000,
        currency: 'USD',
        idempotencyKey: 'dollar-capital',
      },
    });
    expect(inDollars.status).toBe(422);
    expect(inDollars.body.error).toContain('EUR');
  });

  it('completes the money journey in euros', async () => {
    const capital = await call('POST', `${CASH()}/money`, {
      cookie: adminCookie,
      body: {
        kind: 'CAPITAL_IN',
        amountCents: 50_000,
        currency: 'EUR',
        idempotencyKey: 'euro-capital',
      },
    });
    expect(capital.status).toBe(200);

    const settlement = await call('POST', `${CASH()}/money`, {
      cookie: adminCookie,
      body: {
        kind: 'SETTLEMENT',
        amountCents: 120_000,
        currency: 'EUR',
        verifiedReference: 'sepa-88412',
        idempotencyKey: 'euro-settlement',
      },
    });
    expect(settlement.status).toBe(200);

    const view = await call<{
      myCash: { position: Position };
      authority: { lines: string[] };
    }>('GET', CASH(), { cookie: adminCookie });
    expect(view.body.myCash.position.availableFundsCents).toBe(170_000);
    expect(view.body.myCash.position.currency).toBe('EUR');
    // Nothing was excluded from the figures, so nothing is named.
    expect(view.body.myCash.position.otherCurrencies).toEqual([]);
  });

  it('grants a commercial authority in the sprint’s currency and commits in it', async () => {
    const granted = await call<{ lines: string[] }>('POST', `${CASH()}/authority`, {
      cookie: adminCookie,
      body: {
        allowedActions: ['CONTACT_BUYER', 'RUN_PAID_TEST'],
        maxCommittedCents: 40_000,
        maxPerActionCents: 20_000,
        maxConcurrent: 2,
      },
    });
    expect(granted.status).toBe(200);
    // The server composes the sentence, and it says euros because the sprint
    // does — the grant never picks its own currency.
    expect(granted.body.lines.join(' ')).toContain('EUR');

    const committed = await call<{ commitment: { currency: string; amountCents: number } }>(
      'POST',
      `${CASH()}/commitments`,
      {
        cookie: adminCookie,
        body: {
          amountCents: 15_000,
          action: 'RUN_PAID_TEST',
          purpose: 'A bounded paid test',
          expectedResult: 'One qualified reply',
          stopCondition: 'No reply within a week',
          idempotencyKey: 'euro-commitment',
        },
      },
    );
    expect(committed.status).toBe(200);
    expect(committed.body.commitment.currency).toBe('EUR');

    const view = await call<{ myCash: { position: Position } }>('GET', CASH(), {
      cookie: adminCookie,
    });
    // €1,700 available, €150 held.
    expect(view.body.myCash.position.availableFundsCents).toBe(170_000);
    expect(view.body.myCash.position.otherCurrencies).toEqual([]);
  });

});
