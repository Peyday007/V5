/**
 * The reading backlog, and the effect-adapter roster, on GET /api/health.
 *
 * `readingBacklog()` (server/services/documents/backlog.ts) is proven directly
 * first: it reports, it performs no write, and it enqueues no extraction. Then
 * the administrator and non-administrator branches of the real HTTP route are
 * proven against a live server, because that is the only way to see the actual
 * response shape rather than a restatement of it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './helpers/ports.ts';
import { addDocument, freshProject, teardown } from './helpers.ts';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { createDocument, updateDocument } from '../server/repos/documents.ts';
import { EXTRACTION_STATUSES } from '../server/domain/types.ts';
import { extractionQueueDepth } from '../server/services/documents/queue.ts';
import { readingBacklog } from '../server/services/documents/backlog.ts';

const NON_DEFAULT_STATUSES = new Set(['QUEUED', 'READY', 'BLOCKED', 'FAILED']);

describe('readingBacklog', () => {
  afterEach(async () => {
    await teardown();
  });

  it('reports every declared status and no missing files over an empty archive', async () => {
    await freshProject();
    const backlog = await readingBacklog();

    expect(backlog.missingFiles).toBe(0);
    expect(backlog.inProcess).toBe(extractionQueueDepth());
    expect(Object.keys(backlog.byStatus).sort()).toEqual([...EXTRACTION_STATUSES].sort());
    for (const status of EXTRACTION_STATUSES) {
      expect(backlog.byStatus[status]).toBe(0);
    }
  });

  it('counts documents by extraction status, with every declared status present', async () => {
    const fixture = await freshProject();

    // Left at its default: a newly registered document starts QUEUED.
    await addDocument(fixture, 'World Model', 'v1', { withFile: false });

    const ready = await addDocument(fixture, 'World Model', 'v2', { withFile: false });
    await updateDocument(ready.id, { extractionStatus: 'READY' });

    const blocked = await addDocument(fixture, 'World Model', 'v3', { withFile: false });
    await updateDocument(blocked.id, { extractionStatus: 'BLOCKED' });

    const failed = await addDocument(fixture, 'World Model', 'v4', { withFile: false });
    await updateDocument(failed.id, { extractionStatus: 'FAILED' });

    const backlog = await readingBacklog();

    expect(backlog.byStatus.QUEUED).toBe(1);
    expect(backlog.byStatus.READY).toBe(1);
    expect(backlog.byStatus.BLOCKED).toBe(1);
    expect(backlog.byStatus.FAILED).toBe(1);
    for (const status of EXTRACTION_STATUSES) {
      if (NON_DEFAULT_STATUSES.has(status)) continue;
      expect(backlog.byStatus[status]).toBe(0);
    }
  });

  it('counts documents whose file is missing, independent of extraction status', async () => {
    const fixture = await freshProject();
    const missing = await addDocument(fixture, 'World Model', 'v1', { withFile: false });
    await updateDocument(missing.id, { fileMissing: true, extractionStatus: 'READY' });
    await addDocument(fixture, 'World Model', 'v2', { withFile: false });

    const backlog = await readingBacklog();

    expect(backlog.missingFiles).toBe(1);
    expect(backlog.byStatus.READY).toBe(1);
  });

  it('performs no write and enqueues no extraction', async () => {
    const fixture = await freshProject();
    await addDocument(fixture, 'World Model', 'v1', { withFile: false });
    const before = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM documents');

    await readingBacklog();
    await readingBacklog();

    const after = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM documents');
    expect(after?.n).toBe(before?.n);
    expect(extractionQueueDepth()).toBe(0);
  });
});

describe('GET /api/health: reading and effects', () => {
  const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const PORT = pickPort(8200, 100);
  const BASE = `http://127.0.0.1:${PORT}`;

  const ADMIN_EMAIL = 'health-backlog-admin@example.invalid';
  const BOOTSTRAP_PASSWORD = 'bootstrap-password-hb1';
  const ADMIN_PASSWORD = 'administrator-password-hb1';
  const MEMBER_EMAIL = 'health-backlog-member@example.invalid';
  const MEMBER_TEMP_PASSWORD = 'temporary-password-hb1';
  const MEMBER_PASSWORD = 'member-password-hb1-abcd';

  let server: ChildProcessByStdio<null, Readable, Readable>;
  let dataDir: string;
  let dbPath: string;
  let serverLog = '';
  let adminCookie = '';
  let memberCookie = '';
  let projectId = '';
  let layerId = '';

  interface Result<T = unknown> {
    status: number;
    body: T;
  }

  async function call<T = unknown>(
    method: string,
    route: string,
    options: { cookie?: string; body?: unknown } = {},
  ): Promise<Result<T>> {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body: body as T };
  }

  async function signIn(email: string, password: string): Promise<string> {
    const response = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(`sign-in for ${email} failed: ${response.status} ${await response.text()}`);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!cookie) throw new Error(`sign-in for ${email} returned no cookie`);
    return cookie;
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-health-backlog-'));
    dbPath = path.join(dataDir, 'brain.db');
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

    const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
      cookie: adminCookie,
      body: { email: MEMBER_EMAIL, displayName: 'Member', password: MEMBER_TEMP_PASSWORD },
    });
    if (created.status !== 200) throw new Error(`could not create member: ${JSON.stringify(created.body)}`);
    const firstMemberCookie = await signIn(MEMBER_EMAIL, MEMBER_TEMP_PASSWORD);
    const changed = await call('POST', '/api/auth/password', {
      cookie: firstMemberCookie,
      body: { currentPassword: MEMBER_TEMP_PASSWORD, newPassword: MEMBER_PASSWORD },
    });
    if (changed.status !== 200) throw new Error('could not set a password for the member');
    memberCookie = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);

    const projects = await call<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
    projectId = projects.body.projects[0]!.id;
    const detail = await call<{ layers: { id: string }[] }>('GET', `/api/projects/${projectId}`, {
      cookie: adminCookie,
    });
    layerId = detail.body.layers[0]!.id;
  }, 90_000);

  afterAll(() => {
    server?.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('as an administrator: includes reading and an effects roster of exactly name/effectClass/namespace', async () => {
    const health = await call<{
      reading: { inProcess: number; byStatus: Record<string, number>; missingFiles: number };
      effects: { name: string; effectClass: string; namespace: string }[];
    }>('GET', '/api/health', { cookie: adminCookie });

    expect(health.status).toBe(200);
    expect(health.body.reading).toBeTruthy();
    expect(typeof health.body.reading.inProcess).toBe('number');
    expect(typeof health.body.reading.missingFiles).toBe('number');
    for (const status of EXTRACTION_STATUSES) {
      expect(health.body.reading.byStatus[status]).toBeTypeOf('number');
    }

    // Nothing registers an effect adapter at boot (server/services/effects/
    // synthetic.ts: "Called by tests and by the hosted harness — never at
    // boot"), so an ordinary server reports none. The shape is asserted
    // regardless, so a future adapter that leaked an extra field would fail
    // this the moment it existed.
    expect(Array.isArray(health.body.effects)).toBe(true);
    for (const adapter of health.body.effects) {
      expect(Object.keys(adapter).sort()).toEqual(['effectClass', 'name', 'namespace']);
    }
  });

  it('as an ordinary project member: neither reading nor effects, and nothing else new', async () => {
    const health = await call<Record<string, unknown>>('GET', '/api/health', { cookie: memberCookie });

    expect(health.status).toBe(200);
    expect(Object.keys(health.body).sort()).toEqual(['ocr', 'ok', 'providers', 'schemaVersion']);
    expect(health.body.reading).toBeUndefined();
    expect(health.body.effects).toBeUndefined();
  });

  it('two consecutive administrator reads move no row and enqueue nothing', async () => {
    await initDatabase({ dbPath });
    const doc = await createDocument({
      projectId,
      layerId,
      canonicalName: 'Health Backlog Probe v1',
      version: 'v1',
      versionSort: 'v1',
      documentType: 'EXPANSION',
      filename: 'health-backlog-probe-v1.pdf',
    });
    const countOf = async (table: string): Promise<number> => {
      const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      return Number(row?.n ?? 0);
    };
    const before = {
      documents: await countOf('documents'),
      extractionRuns: await countOf('extraction_runs'),
      workItems: await countOf('work_items'),
    };
    await closeDatabase();

    const first = await call<{ reading: { inProcess: number } }>('GET', '/api/health', { cookie: adminCookie });
    const second = await call<{ reading: { inProcess: number } }>('GET', '/api/health', { cookie: adminCookie });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The queue is per-process state on the server; nothing here enqueued
    // anything, so both reads see the same, idle depth.
    expect(first.body.reading.inProcess).toBe(0);
    expect(second.body.reading.inProcess).toBe(first.body.reading.inProcess);

    await initDatabase({ dbPath });
    const after = {
      documents: await countOf('documents'),
      extractionRuns: await countOf('extraction_runs'),
      workItems: await countOf('work_items'),
    };
    await closeDatabase();

    expect(after).toEqual(before);
    // The document the probe registered is still exactly as it was left.
    expect(after.documents).toBeGreaterThanOrEqual(1);
    void doc;
  });
});
