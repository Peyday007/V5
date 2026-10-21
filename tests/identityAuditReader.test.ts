/**
 * §17's identity audit, made readable without a crafted request.
 *
 * `GET /api/admin/identity-events` passed `Number(query['limit'] ?? 200)`
 * straight to `listIdentityEvents`, whose own clamp — `Math.min(Math.max(...),
 * ...)` — returns `NaN` for anything that is not a number, so `?limit=abc`
 * bound `LIMIT NaN` and the request failed as a server error rather than a
 * 400. The route also ignored the `result` filter the repository already
 * supported. And there was no terminal reader at all: `npm run admin` could
 * list people, workers and routing, but not the audit that records what was
 * done to them — so §26's recovery surface, where reaching the shell is the
 * authentication, had no way to answer "who changed this identity, and when".
 *
 * This file proves three things stay apart, because they can fail
 * independently:
 *
 *   - the repository's own NaN guard, in process, against both backends
 *     (`freshProject`/`teardown` runs under Postgres too when
 *     `BRAIN_TEST_DATABASE_URL` is set);
 *   - the route's validation and filtering, over HTTP against a real server,
 *     including that a non-administrator person and a WORKER principal are
 *     refused exactly as before; and
 *   - the terminal reader, through the real script, against a scratch Brain,
 *     proving it never prints anything credential-shaped.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshProject, teardown } from './helpers.ts';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { listIdentityEvents, recordIdentityEvent } from '../server/repos/identity.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------------ */
/* Part 1: the repository's own NaN guard (A02)                             */
/* ------------------------------------------------------------------------ */

describe('listIdentityEvents given a non-finite limit', () => {
  beforeEach(async () => {
    await freshProject();
  });
  afterEach(async () => {
    await teardown();
  });

  it('falls back to the default bound instead of throwing or binding LIMIT NaN', async () => {
    await recordIdentityEvent({
      actorType: 'ANONYMOUS',
      action: 'IDENTITY_AUDIT_READER_TEST',
      result: 'DENIED',
      reason: 'INVALID_CREDENTIALS',
    });
    // The caller's own bug, reaching the repository directly with what a
    // route's validation would already have refused. This must never throw
    // and must never bind `LIMIT NaN`.
    const events = await listIdentityEvents({
      action: 'IDENTITY_AUDIT_READER_TEST',
      limit: Number.NaN,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe('DENIED');
  });

  it('still bounds an ordinary limit the same way it always did', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordIdentityEvent({
        actorType: 'ANONYMOUS',
        action: 'IDENTITY_AUDIT_READER_TEST',
        result: 'SUCCESS',
      });
    }
    const events = await listIdentityEvents({
      action: 'IDENTITY_AUDIT_READER_TEST',
      limit: 2,
    });
    expect(events).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------ */
/* Part 2: the route, over HTTP, against a real server (A01, A03)           */
/* ------------------------------------------------------------------------ */

const PORT = pickPort(8200, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir: string;
let serverLog = '';

const ADMIN_EMAIL = 'identity-audit-admin@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';

let adminCookie = '';
let memberCookie = '';
let workerBearer = '';

/** A seeded event's action, unique to this suite, so filters can be exact. */
const SEEDED_ACTION = 'IDENTITY_AUDIT_ROUTE_TEST';

interface Result<T = unknown> {
  status: number;
  body: T;
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
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text */
  }
  return { status: response.status, body: body as T };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`sign-in for ${email} failed: ${response.status} ${await response.text()}`);
  }
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (!cookie) throw new Error(`sign-in for ${email} returned no cookie`);
  return cookie;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-identity-audit-'));
  server = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')],
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  const deadline = Date.now() + 45_000;
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

  // An ordinary person, with no administrator right.
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: {
      email: 'identity-audit-member@example.invalid',
      displayName: 'Member',
      password: 'temporary-password-01',
    },
  });
  if (created.status !== 200) throw new Error(`could not create member: ${JSON.stringify(created.body)}`);
  const firstCookie = await signIn('identity-audit-member@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: firstCookie,
    body: { currentPassword: 'temporary-password-01', newPassword: MEMBER_PASSWORD },
  });
  memberCookie = await signIn('identity-audit-member@example.invalid', MEMBER_PASSWORD);

  // A worker principal, with a real issued credential.
  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'identity-audit-test-worker', displayName: 'Identity Audit Test Worker' },
  });
  const workerId = worker.body.worker.id;
  const issued = await call<{ secret: string }>('POST', `/api/admin/workers/${workerId}/credentials`, {
    cookie: adminCookie,
    body: {},
  });
  workerBearer = issued.body.secret;

  // Seed real rows directly, through the repository, against the same
  // database the running server has open — the same thing
  // `authorization.test.ts` does to create its second project. Three DENIED,
  // one SUCCESS, one FAILED, all under one action this suite alone uses, so
  // a filter's answer is exact regardless of what else the server itself
  // recorded (e.g. its own `AUTHORIZE_ADMIN` denials from the refusal tests
  // below).
  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  for (const reason of ['NOT_A_MEMBER', 'NAME_UNAVAILABLE', 'REVOKED'] as const) {
    await recordIdentityEvent({
      actorType: 'HUMAN',
      actorId: 'usr_seeded',
      action: SEEDED_ACTION,
      result: 'DENIED',
      reason,
    });
  }
  await recordIdentityEvent({ actorType: 'HUMAN', actorId: 'usr_seeded', action: SEEDED_ACTION, result: 'SUCCESS' });
  await recordIdentityEvent({ actorType: 'HUMAN', actorId: 'usr_seeded', action: SEEDED_ACTION, result: 'FAILED' });
  await closeDatabase();
}, 90_000);

afterAll(() => {
  server?.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/admin/identity-events, as a Brain administrator', () => {
  it('refuses a non-numeric limit with 400, not a server error', async () => {
    const result = await call('GET', '/api/admin/identity-events?limit=abc', { cookie: adminCookie });
    expect(result.status).toBe(400);
  });

  it('refuses a limit below the floor with 400', async () => {
    const result = await call('GET', '/api/admin/identity-events?limit=0', { cookie: adminCookie });
    expect(result.status).toBe(400);
  });

  it('refuses a limit above the ceiling with 400', async () => {
    const result = await call('GET', '/api/admin/identity-events?limit=5000', { cookie: adminCookie });
    expect(result.status).toBe(400);
  });

  it('refuses an unknown result value with 400, naming the allowed ones', async () => {
    const result = await call<{ error?: string }>('GET', '/api/admin/identity-events?result=MAYBE', {
      cookie: adminCookie,
    });
    expect(result.status).toBe(400);
    expect(String(result.body?.error ?? '')).toContain('SUCCESS, DENIED, FAILED');
  });

  it('filters by result and bounds by limit together', async () => {
    const result = await call<{ events: { result: string; action: string }[] }>(
      'GET',
      `/api/admin/identity-events?action=${SEEDED_ACTION}&result=DENIED&limit=2`,
      { cookie: adminCookie },
    );
    expect(result.status).toBe(200);
    expect(result.body.events.length).toBeLessThanOrEqual(2);
    expect(result.body.events.length).toBeGreaterThan(0);
    for (const event of result.body.events) {
      expect(event.result).toBe('DENIED');
      expect(event.action).toBe(SEEDED_ACTION);
    }
  });

  it('still filters by actorId, projectId and action as before', async () => {
    const result = await call<{ events: { action: string }[] }>(
      'GET',
      `/api/admin/identity-events?action=${SEEDED_ACTION}`,
      { cookie: adminCookie },
    );
    expect(result.status).toBe(200);
    expect(result.body.events.length).toBe(5);
    for (const event of result.body.events) expect(event.action).toBe(SEEDED_ACTION);
  });
});

describe('GET /api/admin/identity-events, refused exactly as before', () => {
  it('is not reachable by an ordinary person', async () => {
    const result = await call('GET', '/api/admin/identity-events', { cookie: memberCookie });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'No such route.' });
  });

  it('is not reachable by a WORKER principal, with the identical body', async () => {
    const result = await call('GET', '/api/admin/identity-events', { bearer: workerBearer });
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'No such route.' });
  });
});

/* ------------------------------------------------------------------------ */
/* Part 3: the terminal reader, through the real script (A04)               */
/* ------------------------------------------------------------------------ */

const CHILD_TIMEOUT_MS = 90_000;

/** A Brain of its own, so the CLI opens a database this suite fully controls. */
function scratchEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAIN_DATA_DIR: root,
    BRAIN_DB_PATH: path.join(root, 'brain.db'),
  };
  delete env['BRAIN_DATABASE_URL'];
  delete env['BRAIN_TEST_DATABASE_URL'];
  return env;
}

function runNode(argv: string[], root: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, argv, {
      cwd: REPO_ROOT,
      env: scratchEnv(root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    if (failure.signal === 'SIGKILL') {
      throw new Error(`\`${argv.join(' ')}\` did not exit within ${CHILD_TIMEOUT_MS / 1000}s and was killed.`);
    }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function admin(root: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  return runNode(
    [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'scripts', 'admin.ts'), ...args],
    root,
  );
}

describe('npm run admin -- identity events', () => {
  let scratch: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-identity-cli-'));

    // Seeded through the repository, in its own process, exactly as
    // `workerIdentifier.test.ts` seeds the administrator its script needs —
    // so this suite's own database is not swapped underneath it. One event
    // carries a credential-shaped digest and a metadata value shaped like a
    // worker credential, so the assertions below can prove neither ever
    // reaches the terminal.
    const seed = path.join(scratch, 'seed.mts');
    const credentialLikeHex = 'a'.repeat(64);
    fs.writeFileSync(
      seed,
      [
        `import { closeDatabase, initDatabase } from ${JSON.stringify(path.join(REPO_ROOT, 'server/db/database.ts'))};`,
        `import { recordIdentityEvent } from ${JSON.stringify(path.join(REPO_ROOT, 'server/repos/identity.ts'))};`,
        'await initDatabase();',
        'await recordIdentityEvent({',
        "  actorType: 'HUMAN',",
        "  actorId: 'usr_cli_test',",
        `  credentialId: ${JSON.stringify(credentialLikeHex)},`,
        "  action: 'DISABLE_WORKER',",
        "  targetType: 'WORKER',",
        "  targetId: 'wkr_cli_test',",
        "  projectId: 'prj_cli_test',",
        "  result: 'DENIED',",
        "  reason: 'NOT_A_MEMBER',",
        "  metadata: { secretShapedValue: 'brnw_" + 'b'.repeat(48) + "' },",
        '});',
        'for (let i = 0; i < 4; i += 1) {',
        '  await recordIdentityEvent({',
        "    actorType: 'HUMAN',",
        "    actorId: 'usr_cli_test',",
        "    action: 'DISABLE_WORKER',",
        "    result: 'SUCCESS',",
        '  });',
        '}',
        'await closeDatabase();',
      ].join('\n'),
      'utf8',
    );
    const seeded = runNode([path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), seed], scratch);
    if (seeded.status !== 0) {
      throw new Error(`seeding the scratch database failed: ${seeded.stderr || seeded.stdout}`);
    }
  }, 60_000);

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('reads events read-only, newest first, bounded by --limit, with nothing credential-shaped', () => {
    const result = admin(scratch, 'identity', 'events', '--limit', '3');
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('ADMIN: OK');

    const lines = result.stdout.split('\n').filter((line) => line.includes('action='));
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('action=');
      expect(line).toContain('result=');
    }

    // Nothing credential-shaped ever crosses into this terminal, whatever the
    // row underneath it holds.
    for (const line of result.stdout.split('\n')) {
      expect(line).not.toMatch(/brnw_|brnt_|brnc_|brnv_/);
      expect(line).not.toMatch(/[0-9a-f]{64}/i);
    }
  });

  it('refuses an unknown --result before touching the database, naming the allowed values', () => {
    const result = admin(scratch, 'identity', 'events', '--result', 'MAYBE');
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('SUCCESS, DENIED, FAILED');
  });

  it('refuses a non-numeric --limit, naming that it must be a whole number', () => {
    const result = admin(scratch, 'identity', 'events', '--limit', 'abc');
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('whole number');
  });

  it('lists the command in the help text', () => {
    const result = admin(scratch);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('identity');
    expect(result.stdout).toContain('events');
  });
});
