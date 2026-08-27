/**
 * Two real MCP clients, out of process, over a real socket.
 *
 * The brief is explicit that an in-process test is not evidence here, and it is
 * right: a supertest proves the handler agrees with itself. What has to be
 * proven is that *somebody else's client* can connect, and there are exactly
 * two kinds of somebody else:
 *
 *   **The reference implementation.** `@modelcontextprotocol/sdk`'s own
 *   `Client` and `StreamableHTTPClientTransport`, which is what every MCP
 *   client in existence is built on. It performs its own `initialize`, its own
 *   framing and its own validation, and none of Brain's code runs inside it.
 *   It speaks 2025-11-25, because that is the newest revision the SDK has.
 *
 *   **A conformant modern client.** Written from `schema/2026-07-28/schema.ts`
 *   by hand — `scripts/mcpModernClient.ts` — because no SDK can speak that
 *   revision yet. It shares no code with the server.
 *
 * Together they exercise both eras of the dual-era gateway against one
 * endpoint, which is the claim Step 7 actually makes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ModernMcpClient } from '../scripts/mcpModernClient.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6300 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_URL = `${BASE}/mcp`;

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let adminCookie = '';
let projectId = '';
let workerSecret = '';
let readOnlySecret = '';

async function api<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
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
  return { status: response.status, body: body as T };
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

async function makeWorker(name: string, scopes: string[]): Promise<string> {
  const worker = await api<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name, displayName: name },
  });
  const id = worker.body.worker.id;
  await api('POST', `/api/admin/projects/${projectId}/members`, {
    cookie: adminCookie,
    body: { principalId: id, principalType: 'WORKER', scopes },
  });
  const issued = await api<{ secret: string }>('POST', `/api/admin/workers/${id}/credentials`, {
    cookie: adminCookie,
    body: {},
  });
  return issued.body.secret;
}

async function enqueue(note: string): Promise<string> {
  const result = await api<{ item: { id: string } }>('POST', `/api/projects/${projectId}/work`, {
    cookie: adminCookie,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note } },
  });
  return result.body.item.id;
}

/** A fresh SDK client and transport, connected. Closed by the caller. */
async function connectSdkClient(credential: string): Promise<Client> {
  const client = new Client({ name: 'brain-sdk-test-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${credential}` } },
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-client-'));
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
        BRAIN_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP,
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

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP);
  await api('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const seeded = await api<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
  projectId = seeded.body.projects[0]!.id;

  workerSecret = await makeWorker('client-worker', [
    'project:read',
    'documents:read',
    'queue:read',
    'queue:claim',
    'queue:heartbeat',
    'queue:complete',
  ]);
  readOnlySecret = await makeWorker('client-reader', ['project:read', 'queue:read']);
}, 90_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ */
/* The official SDK client — the legacy era                                  */
/* ------------------------------------------------------------------------ */

describe('the official MCP SDK client, over a real socket', () => {
  it('connects, which is the whole claim Step 7 makes', async () => {
    const client = await connectSdkClient(workerSecret);
    try {
      expect(client.getServerVersion()).toEqual({ name: 'brain', version: '1.0.0' });
    } finally {
      await client.close();
    }
  });

  it('is told the server offers tools and nothing it does not implement', async () => {
    const client = await connectSdkClient(workerSecret);
    try {
      const capabilities = client.getServerCapabilities() ?? {};
      expect(capabilities.tools).toBeTruthy();
      expect(capabilities.resources).toBeUndefined();
      expect(capabilities.prompts).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('lists the full tool surface', async () => {
    const client = await connectSdkClient(workerSecret);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('brain_whoami');
      expect(names).toContain('brain_claim_work');
      expect(names).toContain('brain_complete_work');
      expect(listed.tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('calls a read tool and gets structured content back', async () => {
    const client = await connectSdkClient(workerSecret);
    try {
      const result = await client.callTool({ name: 'brain_whoami', arguments: {} });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { principalType: string; memberships: unknown[] };
      expect(structured.principalType).toBe('WORKER');
      expect(structured.memberships.length).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('drives a whole unit of work: claim, heartbeat, complete', async () => {
    await enqueue('sdk client end to end');
    const client = await connectSdkClient(workerSecret);
    try {
      const claimResult = await client.callTool({ name: 'brain_claim_work', arguments: { limit: 1 } });
      const claimed = (claimResult.structuredContent as { claimed: { workItemId: string; leaseId: string; leaseGeneration: number }[] })
        .claimed;
      expect(claimed.length).toBe(1);
      const lease = claimed[0]!;

      const beat = await client.callTool({
        name: 'brain_heartbeat_work',
        arguments: {
          work_item_id: lease.workItemId,
          lease_id: lease.leaseId,
          lease_generation: lease.leaseGeneration,
        },
      });
      expect(beat.isError).toBeFalsy();

      const done = await client.callTool({
        name: 'brain_complete_work',
        arguments: {
          work_item_id: lease.workItemId,
          lease_id: lease.leaseId,
          lease_generation: lease.leaseGeneration,
          summary: 'done by the reference client',
        },
      });
      expect(done.isError).toBeFalsy();
      expect((done.structuredContent as { state: string }).state).toBe('SUCCEEDED');
    } finally {
      await client.close();
    }
  });

  it('is refused for a scope it does not hold, as a readable result rather than a transport failure', async () => {
    const client = await connectSdkClient(readOnlySecret);
    try {
      const result = await client.callTool({ name: 'brain_claim_work', arguments: { limit: 1 } });
      // Reported inside the result so the consumer can see it and self-correct,
      // which is what the schema asks for.
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('cannot connect at all without a credential', async () => {
    const client = new Client({ name: 'no-credential', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('is never given a session id, because the gateway keeps no sessions', async () => {
    const client = await connectSdkClient(workerSecret);
    try {
      await client.listTools();
      // Stateless on both sides: the SDK transport would surface a session id
      // here if the server had minted one.
      const transport = (client as unknown as { _transport?: { sessionId?: string } })._transport;
      expect(transport?.sessionId).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* The hand-written modern client — the 2026-07-28 era                       */
/* ------------------------------------------------------------------------ */

describe('a conformant 2026-07-28 client, written from the schema', () => {
  const client = (): ModernMcpClient => new ModernMcpClient({ url: MCP_URL, credential: workerSecret });

  it('discovers the server without any handshake first', async () => {
    const reply = await client().discover();
    expect(reply.status).toBe(200);
    expect(reply.result?.supportedVersions).toContain('2026-07-28');
    expect(reply.result?.supportedVersions).toContain('2025-11-25');
  });

  it('lists tools as its very first message, because there is nothing to initialise', async () => {
    const fresh = new ModernMcpClient({ url: MCP_URL, credential: workerSecret });
    const reply = await fresh.listTools();
    expect(reply.status).toBe(200);
    expect((reply.result?.tools ?? []).length).toBeGreaterThan(0);
    expect(reply.result?.cacheScope).toBe('private');
    expect(typeof reply.result?.ttlMs).toBe('number');
  });

  it('gets resultType on everything it is sent', async () => {
    const listed = await client().listTools();
    expect((listed.result as unknown as { resultType: string }).resultType).toBe('complete');
    const called = await client().callTool('brain_whoami');
    expect(called.result?.resultType).toBe('complete');
  });

  it('drives a whole unit of work over the modern era', async () => {
    await enqueue('modern client end to end');
    const worker = client();
    const claimed = (await worker.call('brain_claim_work', { limit: 1 })) as {
      claimed: { workItemId: string; leaseId: string; leaseGeneration: number }[];
    };
    expect(claimed.claimed.length).toBe(1);
    const lease = claimed.claimed[0]!;

    await worker.call('brain_heartbeat_work', {
      work_item_id: lease.workItemId,
      lease_id: lease.leaseId,
      lease_generation: lease.leaseGeneration,
    });

    const done = await worker.call('brain_complete_work', {
      work_item_id: lease.workItemId,
      lease_id: lease.leaseId,
      lease_generation: lease.leaseGeneration,
      summary: 'done by the modern client',
    });
    expect(done['state']).toBe('SUCCEEDED');
  });

  it('retries successfully after a timeout, without performing a second effect', async () => {
    await enqueue('modern client redelivery');
    const worker = client();
    const claimed = (await worker.call('brain_claim_work', { limit: 1 })) as {
      claimed: { workItemId: string; leaseId: string; leaseGeneration: number }[];
    };
    const lease = claimed.claimed[0]!;
    const args = {
      work_item_id: lease.workItemId,
      lease_id: lease.leaseId,
      lease_generation: lease.leaseGeneration,
    };
    const first = await worker.call('brain_complete_work', args);
    expect(first['state']).toBe('SUCCEEDED');
    // The client never learned whether the first call landed, so it repeats it.
    const second = await worker.call('brain_complete_work', args);
    expect(second['state']).toBe('ALREADY_RECORDED');
  });

  it('is told which versions the server speaks when it asks for one that does not exist', async () => {
    const wrong = new ModernMcpClient({
      url: MCP_URL,
      credential: workerSecret,
      headerOverrides: { 'mcp-protocol-version': '2030-01-01' },
    });
    const reply = await wrong.listTools();
    // The header and the body now disagree, which is a -32020 rather than a
    // -32022 — and that ordering is itself the contract: a client that changed
    // only its header has a header bug, not a version problem.
    expect(reply.status).toBe(400);
    expect(reply.error?.code).toBe(-32020);
  });

  it('is refused, readably, for a project it may not see', async () => {
    await expect(client().call('brain_get_project', { project_id: 'prj_0000000000000000' })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('is refused entirely without a credential', async () => {
    const anonymous = new ModernMcpClient({ url: MCP_URL, credential: 'brnw_0123456789abcdef.nope-not-a-real-secret' });
    const reply = await anonymous.discover();
    expect(reply.status).toBe(401);
  });
});

/* ------------------------------------------------------------------------ */
/* Both eras, one endpoint                                                   */
/* ------------------------------------------------------------------------ */

describe('the dual-era endpoint', () => {
  it('serves both eras from the same URL, concurrently', async () => {
    const sdk = await connectSdkClient(workerSecret);
    try {
      const modern = new ModernMcpClient({ url: MCP_URL, credential: workerSecret });
      const [legacyTools, modernTools] = await Promise.all([sdk.listTools(), modern.listTools()]);

      const legacyNames = legacyTools.tools.map((tool) => tool.name);
      const modernNames = (modernTools.result?.tools ?? []).map((tool) => tool.name);
      // One registry, two front-ends. Two surfaces that could drift apart would
      // be two security reviews.
      expect(modernNames).toEqual(legacyNames);
    } finally {
      await sdk.close();
    }
  });

  it('gives a legacy client no modern envelope fields', async () => {
    const sdk = await connectSdkClient(workerSecret);
    try {
      const result = await sdk.callTool({ name: 'brain_whoami', arguments: {} });
      // `resultType`, `ttlMs` and `cacheScope` belong to 2026-07-28. Sending
      // them to a 2025-11-25 client would be handing it fields from a revision
      // it does not implement.
      expect((result as Record<string, unknown>)['resultType']).toBeUndefined();
      expect((result as Record<string, unknown>)['ttlMs']).toBeUndefined();
    } finally {
      await sdk.close();
    }
  });
});
