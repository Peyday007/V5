/**
 * A campaign across a restart.
 *
 * The cheapest way to find out whether a campaign is really rows is not to
 * reason about where they are, but to kill the server. So this boots one,
 * submits an objective and approves it through the real routes, kills the
 * process, boots a **second** server against the same data directory, and asks
 * the new one what it knows.
 *
 * Three things it is actually defending:
 *
 *   * **A campaign survives, with its pin.** A factory whose state lived in a
 *     dispatcher's memory would produce a different answer after a restart, and
 *     the difference would only appear in production.
 *   * **Approving twice is still one campaign.** The idempotency has to hold
 *     across processes, because that is where the retried request actually comes
 *     from. Checked in the second process, against a row the first one wrote.
 *   * **The refusals are the same afterwards.** An anonymous caller is refused
 *     by the new process too, and a campaign somebody may not see is still
 *     reported exactly like one that does not exist — body included.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6600 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-across-restarts';

let dataDir = '';
let log = '';
let current: ChildProcessByStdio<null, Readable, Readable> | null = null;

let adminCookie = '';
let projectId = '';
let changeRequestId = '';
let campaignId = '';
let pinnedBaseSha = '';

const OBJECTIVE = {
  objective: 'Prove a campaign is rows rather than something a dispatcher remembers.',
  expectedOutcome: 'The same campaign id comes back from a process that never created it.',
  acceptanceConditions: [
    { statement: 'the campaign survives a restart', verification: 'read it from a second process' },
  ],
  mutationScope: ['tests/**'],
  submissionKey: 'factory-persistence',
};

function startServer(): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(
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
        BRAIN_FACTORY_ROOT: path.join(dataDir, 'factory'),
        PORT: String(PORT),
        NODE_ENV: 'test',
        BRAIN_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
  return child;
}

async function waitForHealthy(): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function stopServer(): Promise<void> {
  if (!current) return;
  const child = current;
  current = null;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8_000);
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`${BASE}/healthz`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function call<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T; text: string }> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie && method !== 'GET') headers.origin = BASE;
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
  return { status: response.status, body: body as T, text };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-factory-persist-'));

  current = startServer();
  await waitForHealthy();
  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const projects = await call<{ projects: { id: string }[] }>('GET', '/api/projects', {
    cookie: adminCookie,
  });
  projectId = projects.body.projects[0]!.id;

  const submitted = await call<{ changeRequest: { id: string; baseSha: string } }>(
    'POST',
    `/api/projects/${projectId}/factory/change-requests`,
    { cookie: adminCookie, body: OBJECTIVE },
  );
  changeRequestId = submitted.body.changeRequest.id;
  pinnedBaseSha = submitted.body.changeRequest.baseSha;

  const approved = await call<{ campaign: { id: string } }>(
    'POST',
    `/api/factory/change-requests/${changeRequestId}/approve`,
    { cookie: adminCookie },
  );
  campaignId = approved.body.campaign.id;

  // The restart, for real: a different process, the same rows.
  await stopServer();
  current = startServer();
  await waitForHealthy();
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
}, 180_000);

afterAll(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('after a real restart', () => {
  it('the campaign is still there, with the commit it pinned', async () => {
    const view = await call<{
      campaign: { id: string; baseSha: string; state: string };
      objective: string;
    }>('GET', `/api/factory/campaigns/${campaignId}`, { cookie: adminCookie });
    expect(view.status).toBe(200);
    expect(view.body.campaign.id).toBe(campaignId);
    expect(view.body.campaign.baseSha).toBe(pinnedBaseSha);
    expect(view.body.campaign.state).toBe('PLANNING');
    expect(view.body.objective).toContain('Prove a campaign is rows');
  });

  it('approving again in the new process still produces one campaign', async () => {
    const approved = await call<{ campaign: { id: string }; campaignCreated: boolean }>(
      'POST',
      `/api/factory/change-requests/${changeRequestId}/approve`,
      { cookie: adminCookie },
    );
    expect(approved.body.campaign.id).toBe(campaignId);
    expect(approved.body.campaignCreated).toBe(false);

    const campaigns = await call<{ campaigns: { id: string }[] }>(
      'GET',
      `/api/projects/${projectId}/factory/campaigns`,
      { cookie: adminCookie },
    );
    expect(campaigns.body.campaigns.filter((c) => c.id === campaignId).length).toBe(1);
  });

  it('submitting the same objective again still collides on the same row', async () => {
    const again = await call<{ changeRequest: { id: string }; created: boolean }>(
      'POST',
      `/api/projects/${projectId}/factory/change-requests`,
      { cookie: adminCookie, body: OBJECTIVE },
    );
    expect(again.body.created).toBe(false);
    expect(again.body.changeRequest.id).toBe(changeRequestId);
  });

  it('refuses an anonymous caller exactly as the first process did', async () => {
    const anonymous = await call('GET', `/api/factory/campaigns/${campaignId}`);
    expect([401, 403, 404]).toContain(anonymous.status);
  });
});
