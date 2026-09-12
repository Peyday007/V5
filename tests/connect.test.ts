/**
 * The connected site's whole loop, against a real server over a real socket.
 *
 * `connectContract.test.ts` proves the parser is right. This proves the loop is
 * reached: a record registered once, a re-run that creates nothing, an older
 * copy that cannot regress a newer one, a projection that says the truth about
 * what Brain is doing, one typed command that stays one command however many
 * times it arrives, and every refusal being the same refusal.
 *
 * Written as the assignment's verification list rather than as a feature list,
 * because the interesting failures here are all "it worked and also did
 * something else": two Brain objects for one record, a second command hidden
 * behind a successful response, a projection that reads "in progress" for ever.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase, getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5600 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir: string;
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const OUTSIDER_PASSWORD = 'outsider-password-0001';

let adminCookie = '';
let outsiderCookie = '';
let outsiderId = '';
let projectA = '';
let projectB = '';
let siteWorkerId = '';
let siteBearer = '';
/** A worker with a membership but no `external:sync`. */
let plainWorkerId = '';
let plainBearer = '';

interface Result<T = unknown> {
  status: number;
  body: T;
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: {
    cookie?: string;
    bearer?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
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
        // No provider, no key. The whole point of the billing clause: nothing
        // in this loop may reach a paid model, and the server it is tested
        // against does not have one to reach.
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

async function stopServer(): Promise<void> {
  if (!server) return;
  const dying = server;
  server = null;
  dying.kill('SIGTERM');
  await new Promise((resolve) => {
    dying.on('exit', resolve);
    setTimeout(resolve, 5_000);
  });
}

/** One opportunity, as Deal Dispatch would send it. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceRecordType: 'OPPORTUNITY',
    sourceRecordId: 'opp_alpha',
    sourceVersion: '2026-09-01T10:00:00.000Z',
    title: 'Roof replacement across 40 units',
    summary: 'A property manager needs 40 roofs replaced before winter.',
    sourceRef: '/opportunities/opp_alpha',
    attributes: {
      stage: 'QUALIFYING',
      status: 'ACTIVE',
      estimatedValue: 240000,
      primaryBlocker: 'no confirmed roofing capacity in the county',
      missingInformation: ['crew availability', 'permit lead time'],
    },
    ...overrides,
  };
}

const SYNC = (project: string) => `/api/projects/${project}/connect/deal-dispatch/records`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-connect-'));
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
  projectA = seeded.body.projects[0]!.id;

  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  projectB = (await createProject({ name: 'Somebody elses project' })).id;
  await closeDatabase();

  // Somebody with no access to either project.
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email: 'outsider@example.invalid', displayName: 'Outsider', password: 'temporary-password-01' },
  });
  outsiderId = created.body.user.id;
  const firstCookie = await signIn('outsider@example.invalid', 'temporary-password-01');
  await call('POST', '/api/auth/password', {
    cookie: firstCookie,
    body: { currentPassword: 'temporary-password-01', newPassword: OUTSIDER_PASSWORD },
  });
  outsiderCookie = await signIn('outsider@example.invalid', OUTSIDER_PASSWORD);

  const grant = async (project: string, principalId: string, body: Record<string, unknown>) => {
    const result = await call('POST', `/api/admin/projects/${project}/members`, {
      cookie: adminCookie,
      body: { principalId, ...body },
    });
    if (result.status !== 200) {
      throw new Error(`grant failed (${result.status}): ${JSON.stringify(result.body)}`);
    }
  };

  // The site connector: project A only, and exactly the two scopes it needs.
  const siteWorker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'deal-dispatch-site', displayName: 'Deal Dispatch' },
  });
  siteWorkerId = siteWorker.body.worker.id;
  await grant(projectA, siteWorkerId, {
    principalType: 'WORKER',
    scopes: ['project:read', 'external:sync'],
  });
  const issued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${siteWorkerId}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  siteBearer = issued.body.secret;

  // A worker that is a member of the same project and holds no sync scope.
  const plain = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name: 'reader-only', displayName: 'Reader' },
  });
  plainWorkerId = plain.body.worker.id;
  await grant(projectA, plainWorkerId, {
    principalType: 'WORKER',
    scopes: ['project:read'],
  });
  const plainIssued = await call<{ secret: string }>(
    'POST',
    `/api/admin/workers/${plainWorkerId}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  plainBearer = plainIssued.body.secret;
}, 120_000);

afterAll(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('who may come in', () => {
  it('refuses an anonymous request', async () => {
    const result = await call('POST', SYNC(projectA), { body: { records: [record()] } });
    expect([401, 404]).toContain(result.status);
  });

  it('refuses a worker that holds no sync scope, as a 404', async () => {
    const result = await call('POST', SYNC(projectA), {
      bearer: plainBearer,
      body: { records: [record()] },
    });
    expect(result.status).toBe(404);
  });

  it('refuses another project with the same body as one that does not exist', async () => {
    const forbidden = await call<{ error: string }>('POST', SYNC(projectB), {
      bearer: siteBearer,
      body: { records: [record()] },
    });
    const absent = await call<{ error: string }>('POST', SYNC('prj_0000000000000000000'), {
      bearer: siteBearer,
      body: { records: [record()] },
    });
    expect(forbidden.status).toBe(404);
    expect(absent.status).toBe(404);
    // Invariant 23: the same body, not merely the same status.
    expect(forbidden.body.error).toBe(absent.body.error);
  });

  it('refuses a source system this Brain does not speak, indistinguishably', async () => {
    const result = await call<{ error: string }>(
      'POST',
      `/api/projects/${projectA}/connect/salesforce/records`,
      { bearer: siteBearer, body: { records: [record()] } },
    );
    expect(result.status).toBe(404);
  });
});

describe('the backfill', () => {
  it('imports an existing record exactly once', async () => {
    const result = await call<{
      imported: number; updated: number; unchanged: number; stale: number;
      rejected: unknown[]; total: number;
    }>('POST', SYNC(projectA), { bearer: siteBearer, body: { records: [record()] } });

    expect(result.status).toBe(200);
    expect(result.body.imported).toBe(1);
    expect(result.body.updated).toBe(0);
    expect(result.body.rejected).toEqual([]);
    expect(result.body.total).toBe(1);
  });

  it('creates zero duplicates when the whole backfill is run again', async () => {
    const again = await call<{ imported: number; unchanged: number; total: number }>(
      'POST',
      SYNC(projectA),
      { bearer: siteBearer, body: { records: [record()] } },
    );
    expect(again.body.imported).toBe(0);
    expect(again.body.unchanged).toBe(1);
    expect(again.body.total).toBe(1);
  });

  it('reports what it could not map instead of dropping it', async () => {
    const result = await call<{
      imported: number;
      rejected: { sourceRecordId: string | null; reason: string }[];
      total: number;
    }>('POST', SYNC(projectA), {
      bearer: siteBearer,
      body: {
        records: [
          record({ sourceRecordId: 'opp_beta' }),
          { sourceRecordType: 'OPPORTUNITY', title: 'no id here', sourceVersion: '2026-09-01T10:00:00Z' },
          record({ sourceRecordId: 'opp_gamma', sourceVersion: 'the day before yesterday' }),
        ],
      },
    });
    expect(result.body.imported).toBe(1);
    expect(result.body.rejected.map((entry) => entry.reason).sort()).toEqual([
      'MISSING_SOURCE_ID',
      'UNPARSEABLE_VERSION',
    ]);

    const listed = await call<{ rejections: { reason: string; occurrences: number }[] }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/rejections`,
      { bearer: siteBearer },
    );
    expect(listed.body.rejections.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a batch larger than the contract permits', async () => {
    const many = Array.from({ length: 201 }, (_, index) =>
      record({ sourceRecordId: `bulk_${index}` }),
    );
    const result = await call('POST', SYNC(projectA), {
      bearer: siteBearer,
      body: { records: many },
    });
    expect(result.status).toBe(400);
  });
});

describe('updating what the site already sent', () => {
  it('updates the correct Brain object when the source changes', async () => {
    const result = await call<{ updated: number; total: number }>('POST', SYNC(projectA), {
      bearer: siteBearer,
      body: {
        records: [
          record({
            sourceVersion: '2026-09-02T10:00:00.000Z',
            title: 'Roof replacement across 44 units',
          }),
        ],
      },
    });
    expect(result.body.updated).toBe(1);

    const projection = await call<{ record: { title: string; sourceVersion: string } }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { bearer: siteBearer },
    );
    expect(projection.body.record.title).toBe('Roof replacement across 44 units');
    expect(projection.body.record.sourceVersion).toBe('2026-09-02T10:00:00.000Z');
  });

  it('cannot be regressed by an older or reordered delivery', async () => {
    const stale = await call<{ stale: number; updated: number }>('POST', SYNC(projectA), {
      bearer: siteBearer,
      body: {
        records: [
          record({
            sourceVersion: '2026-09-01T10:00:00.000Z',
            title: 'Roof replacement across 40 units',
          }),
        ],
      },
    });
    expect(stale.body.stale).toBe(1);
    expect(stale.body.updated).toBe(0);

    const projection = await call<{ record: { title: string } }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { bearer: siteBearer },
    );
    expect(projection.body.record.title).toBe('Roof replacement across 44 units');
  });

  it('treats a redelivery of the identical content as no change at all', async () => {
    const first = await call<{ record: { lastUpdatedAt: string } }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { bearer: siteBearer },
    );
    await call('POST', SYNC(projectA), {
      bearer: siteBearer,
      body: {
        records: [
          record({
            sourceVersion: '2026-09-02T10:00:00.000Z',
            title: 'Roof replacement across 44 units',
          }),
        ],
      },
    });
    const second = await call<{ record: { lastUpdatedAt: string } }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { bearer: siteBearer },
    );
    expect(second.body.record.lastUpdatedAt).toBe(first.body.record.lastUpdatedAt);
  });
});

describe('what the site is told', () => {
  it('says NOT_EVALUATED, with the one thing that can be done about it', async () => {
    const projection = await call<{
      record: {
        brainId: string;
        state: string;
        stateReason: string;
        nextAction: { command: string } | null;
        priority: string | null;
      };
    }>('GET', `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`, {
      bearer: siteBearer,
    });
    expect(projection.body.record.state).toBe('NOT_EVALUATED');
    expect(projection.body.record.brainId).toMatch(/^ext_/);
    expect(projection.body.record.nextAction?.command).toBe('RESEARCH_FURTHER');
    expect(projection.body.record.priority).toBeNull();
    expect(projection.body.record.stateReason.length).toBeGreaterThan(0);
  });

  it('refuses a record that was never registered, with the same body as a forbidden one', async () => {
    const missing = await call<{ error: string }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_never`,
      { bearer: siteBearer },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('No record with that id.');
  });

  it('feeds a delta the site can page through with a cursor', async () => {
    const all = await call<{ records: { sourceRecordId: string }[]; cursor: string | null }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records?limit=200`,
      { bearer: siteBearer },
    );
    expect(all.body.records.length).toBeGreaterThanOrEqual(2);
    expect(all.body.cursor).not.toBeNull();

    const nothingNew = await call<{ records: unknown[] }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records?since=${encodeURIComponent(all.body.cursor!)}`,
      { bearer: siteBearer },
    );
    expect(nothingNew.body.records).toEqual([]);
  });

  it('is refused to a person with no access to the project', async () => {
    const result = await call(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { cookie: outsiderCookie },
    );
    expect(result.status).toBe(404);
  });

  it('is readable by an administrator of this Brain', async () => {
    const result = await call<{ record: { state: string } }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { cookie: adminCookie },
    );
    expect(result.status).toBe(200);
    expect(result.body.record.state).toBe('NOT_EVALUATED');
  });
});

describe('the one typed command', () => {
  const COMMAND = (project: string, id: string) =>
    `/api/projects/${project}/connect/deal-dispatch/records/${id}/commands`;

  it('refuses a command this Brain does not have', async () => {
    const result = await call('POST', COMMAND(projectA, 'opp_alpha'), {
      bearer: siteBearer,
      body: { command: 'DELETE_EVERYTHING' },
    });
    expect(result.status).toBe(400);
  });

  it('refuses an Idempotency-Key rather than ignoring it', async () => {
    const result = await call<{ error: string }>('POST', COMMAND(projectA, 'opp_alpha'), {
      bearer: siteBearer,
      body: { command: 'RESEARCH_FURTHER' },
      headers: { 'idempotency-key': 'something-the-caller-chose' },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('derives its own idempotency key');
  });

  it('refuses a worker without the sync scope, as a 404', async () => {
    const result = await call('POST', COMMAND(projectA, 'opp_alpha'), {
      bearer: plainBearer,
      body: { command: 'RESEARCH_FURTHER' },
    });
    expect(result.status).toBe(404);
  });

  it('produces one Brain action and moves the record off NOT_EVALUATED', async () => {
    const result = await call<{
      record: { state: string; stateReason: string };
      replayed: boolean;
      operationId: string;
    }>('POST', COMMAND(projectA, 'opp_alpha'), {
      bearer: siteBearer,
      body: { command: 'RESEARCH_FURTHER', actor: { label: 'Dana Reyes (Deal Manager)' } },
    });

    expect(result.status).toBe(200);
    expect(result.body.replayed).toBe(false);
    expect(result.body.record.state).not.toBe('NOT_EVALUATED');
    expect(result.body.operationId).toMatch(/^/);
  });

  it('names the missing authority rather than saying "queued" for ever', async () => {
    // No standing authority exists in this Brain yet, so the honest answer is
    // that a person has to authorise research — not that it is waiting a turn.
    const projection = await call<{ record: { state: string; stateReason: string } }>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { bearer: siteBearer },
    );
    expect(projection.body.record.state).toBe('NEEDS_PERSON');
    expect(projection.body.record.stateReason).toContain('authorise research');
  });

  it('stays one logical command however many times it is delivered', async () => {
    const second = await call<{ replayed: boolean; operationId: string }>(
      'POST',
      COMMAND(projectA, 'opp_alpha'),
      { bearer: siteBearer, body: { command: 'RESEARCH_FURTHER' } },
    );
    const third = await call<{ replayed: boolean; operationId: string }>(
      'POST',
      COMMAND(projectA, 'opp_alpha'),
      { bearer: siteBearer, body: { command: 'RESEARCH_FURTHER' } },
    );
    expect(second.body.replayed).toBe(true);
    expect(third.body.replayed).toBe(true);
    expect(third.body.operationId).toBe(second.body.operationId);

    // And one Brain object, counted from the rows rather than from the replies.
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    const ideas = await getDb().all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ?',
      [projectA],
    );
    const links = await getDb().all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_records WHERE source_record_id = 'opp_alpha'",
    );
    await closeDatabase();
    expect(Number(ideas[0]!.n)).toBe(1);
    expect(Number(links[0]!.n)).toBe(1);
  });

  it('refuses the command on a record that was never registered', async () => {
    const result = await call<{ error: string }>('POST', COMMAND(projectA, 'opp_never'), {
      bearer: siteBearer,
      body: { command: 'RESEARCH_FURTHER' },
    });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('No record with that id.');
  });

  it('spends nothing: no research packet, no queue item, no provider call', async () => {
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    const orchestrations = await getDb().all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM research_orchestrations WHERE project_id = ?',
      [projectA],
    );
    const work = await getDb().all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM work_items WHERE project_id = ?',
      [projectA],
    );
    await closeDatabase();
    expect(Number(orchestrations[0]!.n)).toBe(0);
    expect(Number(work[0]!.n)).toBe(0);
  });
});

describe('surviving a restart', () => {
  it('still produces one logical command after the server is restarted', async () => {
    await stopServer();
    await startServer();
    adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const again = await call<{ replayed: boolean }>(
      'POST',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha/commands`,
      { bearer: siteBearer, body: { command: 'RESEARCH_FURTHER' } },
    );
    expect(again.body.replayed).toBe(true);

    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    const ideas = await getDb().all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ?',
      [projectA],
    );
    await closeDatabase();
    expect(Number(ideas[0]!.n)).toBe(1);
  }, 120_000);

  it('has not lost or duplicated anything the site sent', async () => {
    const result = await call<{ imported: number; unchanged: number; total: number }>(
      'POST',
      SYNC(projectA),
      {
        bearer: siteBearer,
        body: {
          records: [
            record({
              sourceVersion: '2026-09-02T10:00:00.000Z',
              title: 'Roof replacement across 44 units',
            }),
            record({ sourceRecordId: 'opp_beta' }),
          ],
        },
      },
    );
    expect(result.body.imported).toBe(0);
    expect(result.body.unchanged).toBe(2);
    expect(result.body.total).toBe(2);
  });
});

describe('the storage reading, on the surface it belongs to', () => {
  it('is on the administrator health report and nowhere a member can see it', async () => {
    const asAdmin = await call<{ storage?: { headline: string; notes: string[] } }>(
      'GET',
      '/api/health',
      { cookie: adminCookie },
    );
    expect(asAdmin.body.storage).toBeTruthy();
    expect(asAdmin.body.storage!.headline.length).toBeGreaterThan(0);

    const asOutsider = await call<{ storage?: unknown }>('GET', '/api/health', {
      cookie: outsiderCookie,
    });
    expect(asOutsider.body.storage).toBeUndefined();
  });

  it('never puts a credential or a connection string in the reading', async () => {
    const asAdmin = await call<unknown>('GET', '/api/health', { cookie: adminCookie });
    const text = JSON.stringify(asAdmin.body);
    expect(text).not.toContain(siteBearer);
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('postgresql://');
  });
});

describe('nothing about the connector leaks', () => {
  it('never echoes the site credential back in any reply', async () => {
    const projection = await call<unknown>(
      'GET',
      `/api/projects/${projectA}/connect/deal-dispatch/records/opp_alpha`,
      { bearer: siteBearer },
    );
    expect(JSON.stringify(projection.body)).not.toContain(siteBearer);
  });

  it('never writes the site credential to the server log', () => {
    expect(serverLog).not.toContain(siteBearer);
    expect(serverLog).not.toContain(plainBearer);
  });

  it('records the worker id it authenticated, and not one the caller named', async () => {
    const result = await call<{ imported: number }>('POST', SYNC(projectA), {
      bearer: siteBearer,
      // A body field naming another worker contributes nothing: the principal
      // comes from the credential and from nowhere else.
      body: { records: [record({ sourceRecordId: 'opp_delta' })], workerId: plainWorkerId },
    });
    expect(result.body.imported).toBe(1);

    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    const rows = await getDb().all<{ actor_id: string | null }>(
      `SELECT actor_id FROM identity_events
        WHERE action = 'EXTERNAL_SYNC' ORDER BY created_at DESC LIMIT 1`,
    );
    await closeDatabase();
    expect(rows[0]?.actor_id).toBe(siteWorkerId);
    expect(rows[0]?.actor_id).not.toBe(plainWorkerId);
  });
});

describe('the person on the site is not the principal here', () => {
  it('records the actor label as attribution and nothing else', async () => {
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    const rows = await getDb().all<{ commanded_by_label: string | null }>(
      "SELECT commanded_by_label FROM external_records WHERE source_record_id = 'opp_alpha'",
    );
    const events = await getDb().all<{ payload: string }>(
      `SELECT payload FROM project_events
        WHERE event_type = 'EXTERNAL_COMMAND_ACCEPTED' ORDER BY created_at DESC LIMIT 1`,
    );
    await closeDatabase();
    expect(rows[0]?.commanded_by_label).toBe('Dana Reyes (Deal Manager)');
    expect(events[0]?.payload).toContain('Dana Reyes');
    // The outsider's id is nowhere near this: a label is not an identity.
    expect(events[0]?.payload).not.toContain(outsiderId);
  });
});
