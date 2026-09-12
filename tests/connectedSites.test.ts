/**
 * Connecting a site from the surface a person already uses — and proving the
 * console it replaced is gone.
 *
 * ---------------------------------------------------------------------------
 * What this is really testing
 * ---------------------------------------------------------------------------
 *
 * Connecting Deal Dispatch used to be three screens and one silent trap: the
 * middle screen asked which of two jobs the worker did, and the wrong answer
 * produced the same 404 a missing project gives — invariant 23 working exactly
 * as designed, and indistinguishable from a broken deployment.
 *
 * So the whole journey is one action now, and these are the ways that could be
 * a worse mistake than the thing it replaced: an identity made twice, a scope
 * set that drifts from the constant, a credential that outlives its rotation, a
 * secret that turns up in a read, a machine that can issue itself one, and a
 * console that quietly still answers.
 *
 * It drives a real server over HTTP for the same reason `connect.test.ts` does:
 * every claim here is about authorization and about what a caller can actually
 * reach, and neither is answerable from inside the process that decides them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_SOURCE_SYSTEMS } from '../server/domain/types.ts';
import { isKnownSite, siteFor } from '../server/services/connect/sites.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import os from 'node:os';

const REPO_ROOT_FOR_SITES = fileURLToPath(new URL('..', import.meta.url));

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir: string;
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';

let adminCookie = '';
let memberCookie = '';
let project = '';
/** A worker credential, to prove a machine cannot reach any of this. */
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

const SITES = () => `/api/russell/projects/${project}/sites`;
const CONNECT = () => `${SITES()}/deal-dispatch/connect`;
const RECORDS = () => `/api/projects/${project}/connect/deal-dispatch/records`;

interface SiteStatus {
  system: string;
  name: string;
  state: string;
  stateReason: string;
  workerName: string;
  workerId: string | null;
  scopes: string[] | null;
  scopesCorrect: boolean;
  liveCredentials: number;
  lastUsedAt: string | null;
  records: number;
}

interface ConnectResult {
  status: SiteStatus;
  secret: string;
  createdIdentity: boolean;
  repairedScopes: boolean;
  revokedCredentials: number;
  instruction: { reason: string; variables: { name: string; value: string | null; secret: boolean }[] };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sites-'));
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

  // Somebody on the project who is not an administrator of it.
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email: 'member@example.invalid', displayName: 'Member', password: 'temporary-password-01' },
  });
  const first = await signIn('member@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: 'temporary-password-01', newPassword: MEMBER_PASSWORD },
  });
  memberCookie = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: created.body.user.id, principalType: 'USER', role: 'MEMBER' },
  });

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'a-research-worker', displayName: 'Research' },
  });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: {
      principalId: worker.body.worker.id,
      principalType: 'WORKER',
      scopes: ['project:read', 'work:claim'],
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

describe('the operator console is gone', () => {
  /*
   * Not "hidden", not "renamed", not "kept for emergencies". These fail if the
   * route ever answers as a console again, whoever is asking.
   */
  const PATHS = ['/operator', '/operator/', '/operator/credentials', '/operator/workers'];

  it('answers an anonymous caller with nothing that is a console', async () => {
    for (const route of PATHS) {
      const result = await call(route === '/operator/credentials' ? 'POST' : 'GET', route);
      expect([404, 401]).toContain(result.status);
      expect(result.text).not.toMatch(/<form/i);
      expect(result.text).not.toMatch(/Issue a credential|Create a worker|operator console/i);
    }
  });

  it('answers a Brain administrator the same way — it is not break-glass', async () => {
    for (const route of PATHS) {
      const result = await call(route === '/operator/credentials' ? 'POST' : 'GET', route, {
        cookie: adminCookie,
      });
      expect(result.status).toBe(404);
      expect(result.text).not.toMatch(/<form/i);
    }
  });

  it('does not redirect somewhere that answers as a console either', async () => {
    const result = await call('GET', '/operator', { cookie: adminCookie });
    expect(result.status).toBe(404);
    expect(result.status).not.toBe(303);
    expect(result.status).not.toBe(302);
  });
});

describe('connecting a site', () => {
  it('refuses a machine by principal type, however it is configured', async () => {
    const list = await call('GET', SITES(), { bearer: workerBearer });
    const connect = await call('POST', CONNECT(), { bearer: workerBearer });
    expect(list.status).toBe(404);
    expect(connect.status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    expect((await call('GET', SITES())).status).toBe(401);
    expect([401, 404]).toContain((await call('POST', CONNECT())).status);
  });

  it('lets a person see the site before anything exists, and creates nothing by looking', async () => {
    const before = await call<{ sites: SiteStatus[] }>('GET', SITES(), { cookie: adminCookie });
    expect(before.status).toBe(200);
    const site = before.body.sites.find((entry) => entry.system === 'DEAL_DISPATCH')!;
    expect(site.state).toBe('NOT_CONNECTED');
    expect(site.workerId).toBeNull();
    expect(site.liveCredentials).toBe(0);

    const again = await call<{ sites: SiteStatus[] }>('GET', SITES(), { cookie: adminCookie });
    expect(again.body.sites[0]!.workerId).toBeNull();
  });

  it('refuses a member who does not administer the project', async () => {
    const result = await call('POST', CONNECT(), { cookie: memberCookie });
    expect(result.status).toBe(404);
  });

  it('makes the identity, the permissions and the credential in one action', async () => {
    const result = await call<ConnectResult>('POST', CONNECT(), { cookie: adminCookie });
    expect(result.status).toBe(200);
    expect(result.body.createdIdentity).toBe(true);
    expect(result.body.status.workerName).toBe('deal-dispatch');
    // The scope set is the constant, not a choice anybody made.
    expect(result.body.status.scopes!.slice().sort()).toEqual(['external:sync', 'project:read']);
    expect(result.body.status.scopesCorrect).toBe(true);
    expect(result.body.status.liveCredentials).toBe(1);
    expect(result.body.secret).toMatch(/^brnw_/);
    // Brain is ready and the site has not called. Those are different facts.
    expect(result.body.status.state).toBe('AWAITING_FIRST_CALL');

    // The one manual step is named, with the project and the address filled in
    // and the secret deliberately absent from the variable list.
    const names = result.body.instruction.variables.map((v) => v.name);
    expect(names).toEqual(['BRAIN_URL', 'BRAIN_TOKEN', 'BRAIN_PROJECT_ID']);
    const token = result.body.instruction.variables.find((v) => v.name === 'BRAIN_TOKEN')!;
    expect(token.secret).toBe(true);
    expect(token.value).toBeNull();
    expect(
      result.body.instruction.variables.find((v) => v.name === 'BRAIN_PROJECT_ID')!.value,
    ).toBe(project);
  });

  it('issues a credential that actually authorizes the connector, and nothing more', async () => {
    const connected = await call<ConnectResult>('POST', CONNECT(), { cookie: adminCookie });
    const bearer = connected.body.secret;

    const sync = await call('POST', RECORDS(), {
      bearer,
      body: {
        records: [
          {
            sourceRecordType: 'OPPORTUNITY',
            sourceRecordId: 'opp_one',
            sourceVersion: '2026-09-01T10:00:00.000Z',
            title: 'A real record',
            summary: 'Delivered by the site itself.',
          },
        ],
      },
    });
    expect(sync.status).toBe(200);

    // The scope set is two verbs, so it must not reach anything else. Russell's
    // own surface refuses it by principal type; the project API by scope.
    expect((await call('GET', SITES(), { bearer })).status).toBe(404);
    expect((await call('POST', CONNECT(), { bearer })).status).toBe(404);
  });

  it('reads as connected once the site has actually called, not before', async () => {
    const after = await call<SiteStatus>('GET', `${SITES()}/deal-dispatch`, {
      cookie: adminCookie,
    });
    expect(after.body.state).toBe('CONNECTED');
    expect(after.body.lastUsedAt).not.toBeNull();
    expect(after.body.records).toBeGreaterThan(0);
    expect(after.body.stateReason).toContain('last authenticated');
  });

  it('reuses the identity rather than making a second one, and rotates the secret', async () => {
    const before = await call<SiteStatus>('GET', `${SITES()}/deal-dispatch`, {
      cookie: adminCookie,
    });
    const first = await call<ConnectResult>('POST', CONNECT(), { cookie: adminCookie });
    const oldBearer = first.body.secret;
    const second = await call<ConnectResult>('POST', CONNECT(), { cookie: adminCookie });

    expect(second.body.createdIdentity).toBe(false);
    expect(second.body.status.workerId).toBe(before.body.workerId);
    expect(second.body.revokedCredentials).toBe(1);
    expect(second.body.secret).not.toBe(oldBearer);
    // Never two live credentials: rotating because you believe one is
    // compromised must not leave it working.
    expect(second.body.status.liveCredentials).toBe(1);
    expect((await call('POST', RECORDS(), { bearer: oldBearer, body: { records: [] } })).status)
      .toBe(401);
    expect((await call('POST', RECORDS(), { bearer: second.body.secret, body: { records: [] } })).status)
      .toBe(200);
  });

  it('never hands the secret back on a read, or writes it where one could find it', async () => {
    const issued = await call<ConnectResult>('POST', CONNECT(), { cookie: adminCookie });
    const secret = issued.body.secret;
    expect(secret).toMatch(/^brnw_/);

    const status = await call<SiteStatus>('GET', `${SITES()}/deal-dispatch`, {
      cookie: adminCookie,
    });
    expect(JSON.stringify(status.body)).not.toContain(secret);

    /*
     * The *secret*, not the string `brnw_`.
     *
     * A credential is a prefix plus a random tail, and only the tail is
     * secret — the prefix is the lookup key `findCredentialByPrefix` needs to
     * find the row at all, and the admin API records it deliberately. Asserting
     * on the substring would have failed on an identifier while saying nothing
     * about the thing that matters, which is a test that looks strict and is
     * not. `connectSite` records neither: its identity event carries a
     * credential *id*.
     */
    const audit = await call<{ events: { metadata: Record<string, unknown> }[] }>(
      'GET',
      '/api/admin/identity-events?limit=200',
      { cookie: adminCookie },
    );
    expect(JSON.stringify(audit.body)).not.toContain(secret);
    const connectEvents = audit.body.events.filter(
      (event) => (event as unknown as { action: string }).action === 'CONNECT_SITE',
    );
    expect(connectEvents.length).toBeGreaterThan(0);
    for (const event of connectEvents) {
      expect(Object.keys(event.metadata)).not.toContain('prefix');
      expect(JSON.stringify(event.metadata)).not.toMatch(/brnw_/);
    }

    expect(serverLog).not.toContain(secret);
  });

  it('disconnects without destroying anything, and reconnects', async () => {
    const live = await call<SiteStatus>('GET', `${SITES()}/deal-dispatch`, { cookie: adminCookie });
    const recordsBefore = live.body.records;

    const off = await call<SiteStatus>('POST', `${SITES()}/deal-dispatch/disconnect`, {
      cookie: adminCookie,
      body: { reason: 'Testing the way out.' },
    });
    expect(off.status).toBe(200);
    expect(off.body.state).toBe('DISCONNECTED');
    expect(off.body.liveCredentials).toBe(0);
    // §5: the records the site delivered are the project's, and stay.
    expect(off.body.records).toBe(recordsBefore);
    expect(off.body.workerId).not.toBeNull();

    const back = await call<ConnectResult>('POST', CONNECT(), { cookie: adminCookie });
    expect(back.body.createdIdentity).toBe(false);
    expect(back.body.status.state).toBe('AWAITING_FIRST_CALL');
    expect(
      (await call('POST', RECORDS(), { bearer: back.body.secret, body: { records: [] } })).status,
    ).toBe(200);
  });

  it('refuses a site it does not know, indistinguishably from a route that is not there', async () => {
    const unknown = await call<{ error: string }>('POST', `${SITES()}/salesforce/connect`, {
      cookie: adminCookie,
    });
    expect(unknown.status).toBe(404);
  });
});

/* ==========================================================================
 * The site's name means one thing, and every reader must agree what
 * ========================================================================== */

/*
 * `external_records.source_system` stores what `EXTERNAL_SOURCE_SYSTEMS` says —
 * `DEAL_DISPATCH` — and `services/connect/sites.ts` is the one module that
 * canonicalises a person's spelling of it, by replacing hyphens and
 * upper-casing. `scripts/connect-report.ts` reimplemented that as
 * `.toLowerCase()`, which produces `deal-dispatch`: a value no row can hold.
 *
 * So the one reader a person uses to check on a connected site reported
 * `records 0 registered` and `rejections 0` for a site that had sixty connector
 * events and had updated records ninety minutes earlier. Everything keyed on
 * the site was wrong; the events list was right because it reads
 * `project_events` by type and never touches `source_system` — which is exactly
 * what made the output look coherent.
 *
 * Pinned on the source because the property is *which normalisation the script
 * uses*, and a test that ran the script would need a populated Brain to show
 * the difference. §29: a rule applied by one of two readers is worse than none.
 */
describe('every reader canonicalises a site name the same way', () => {
  const report = fs.readFileSync(
    path.join(REPO_ROOT_FOR_SITES, 'scripts', 'connect-report.ts'),
    'utf8',
  );

  it('the stored vocabulary is upper case with underscores', () => {
    for (const system of EXTERNAL_SOURCE_SYSTEMS) {
      expect(system).toBe(system.toUpperCase());
      expect(system).not.toContain('-');
    }
  });

  it('canonicalising accepts every spelling a person writes and lands on the stored one', () => {
    for (const spelling of ['deal-dispatch', 'deal_dispatch', 'DEAL_DISPATCH', 'Deal-Dispatch']) {
      expect(siteFor(spelling).system).toBe('DEAL_DISPATCH');
    }
  });

  it('the report never lower-cases the site into a value no row can hold', () => {
    // The exact defect: `.toLowerCase()` applied to the site name.
    expect(report).not.toMatch(/flag\('site'\)[^\n]*toLowerCase\(\)/);
    // And it uses the module that owns the vocabulary.
    expect(report).toContain("from '../server/services/connect/sites.ts'");
    expect(report).toMatch(/siteFor\(/);
  });

  it('an unknown site is refused by name rather than reported as holding nothing', () => {
    expect(isKnownSite('NOT_A_SITE')).toBe(false);
    // Reporting zero for a site that cannot exist is the same lie in a smaller
    // font, so the script must fail rather than query.
    expect(report).toContain('CONNECT-REPORT: FAIL');
    expect(report).toMatch(/No site called/);
  });
});
