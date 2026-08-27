/**
 * The MCP gateway, written as an attack and as a conformance check.
 *
 * Every assertion runs against a **real server process** over a **real socket**
 * — `spawn` plus `fetch`, not an in-process handler. That is deliberate and the
 * brief insists on it: a supertest proves the handler, and the things most
 * likely to be wrong here live outside the handler. Header validation, body
 * limits, the 405s, the access-gate exemption, whether the SPA fallback eats
 * `/mcp`, and whether the endpoint is mounted before the 10 MiB body parser are
 * all properties of the *wiring*, and an in-process test would pass with every
 * one of them broken.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { DENIAL_REASONS } from '../server/domain/types.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 6100 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const MCP = `${BASE}/mcp`;
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let adminCookie = '';
let projectA = '';
let projectB = '';
/** Full scopes in project A. */
let workerSecret = '';
let workerCredentialId = '';
/** Reads only: no queue:claim, no queue:complete. */
let readOnlySecret = '';
/** A worker in project B, used to prove cross-project isolation. */
let strangerSecret = '';
/** Issued and then revoked. */
let revokedSecret = '';

/* ------------------------------------------------------------------------ */
/* Plumbing                                                                  */
/* ------------------------------------------------------------------------ */

interface Result<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function api<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
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
  return { status: response.status, body: body as T, headers: response.headers };
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in for ${email} failed: ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** A well-formed modern envelope, which individual tests then break on purpose. */
function envelope(
  method: string,
  params: Record<string, unknown> = {},
  id: number | string | null = 1,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const named = typeof params['name'] === 'string' ? (params['name'] as string) : null;
  const body: Record<string, unknown> = {
    jsonrpc: '2.0',
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientInfo': { name: 'brain-test-client', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  if (id !== null) body['id'] = id;
  return {
    body,
    headers: {
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(named ? { 'mcp-name': named } : {}),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
  };
}

interface RpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** POST a modern message, optionally with the envelope mutated first. */
async function mcp(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    bearer?: string | null;
    id?: number | string | null;
    headers?: Record<string, string | undefined>;
    rawBody?: unknown;
    origin?: string;
  } = {},
): Promise<Result<RpcResponse>> {
  const built = envelope(method, params, options.id === undefined ? 1 : options.id);
  const headers: Record<string, string> = { ...built.headers };
  const bearer = options.bearer === undefined ? workerSecret : options.bearer;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (options.origin) headers.origin = options.origin;
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  const response = await fetch(MCP, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.rawBody === undefined ? built.body : options.rawBody),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: response.status, body: body as RpcResponse, headers: response.headers };
}

/** Call a tool and hand back the structured result, whatever it says. */
async function tool(
  name: string,
  args: Record<string, unknown> = {},
  bearer: string | null = workerSecret,
): Promise<{ status: number; isError: boolean; structured: Record<string, unknown>; raw: RpcResponse }> {
  const response = await mcp('tools/call', { name, arguments: args }, { bearer });
  const result = response.body.result ?? {};
  return {
    status: response.status,
    isError: result['isError'] === true,
    structured: (result['structuredContent'] ?? {}) as Record<string, unknown>,
    raw: response.body,
  };
}

async function grant(project: string, principalId: string, body: Record<string, unknown>): Promise<void> {
  const result = await api('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId, ...body },
  });
  if (result.status !== 200) throw new Error(`grant failed: ${JSON.stringify(result.body)}`);
}

async function makeWorker(
  name: string,
  project: string,
  scopes: string[],
): Promise<{ id: string; secret: string; credentialId: string }> {
  const worker = await api<{ worker: { id: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name, displayName: name },
  });
  const id = worker.body.worker.id;
  await grant(project, id, { principalType: 'WORKER', scopes });
  const issued = await api<{ secret: string; credential: { id: string } }>(
    'POST',
    `/api/admin/workers/${id}/credentials`,
    { cookie: adminCookie, body: {} },
  );
  return { id, secret: issued.body.secret, credentialId: issued.body.credential.id };
}

async function enqueue(project: string, note = 'hello'): Promise<string> {
  const result = await api<{ item: { id: string } }>('POST', `/api/projects/${project}/work`, {
    cookie: adminCookie,
    body: { workType: 'SYNTHETIC_ECHO', payload: { note } },
  });
  if (result.status !== 200) throw new Error(`enqueue failed: ${JSON.stringify(result.body)}`);
  return result.body.item.id;
}

interface Claim {
  workItemId: string;
  leaseId: string;
  leaseGeneration: number;
}

async function claimOne(bearer = workerSecret): Promise<Claim> {
  const result = await tool('brain_claim_work', { limit: 1 }, bearer);
  const claimed = (result.structured['claimed'] ?? []) as Claim[];
  const first = claimed[0];
  if (!first) throw new Error(`nothing claimed: ${JSON.stringify(result.structured)}`);
  return first;
}

/* ------------------------------------------------------------------------ */
/* Setup                                                                     */
/* ------------------------------------------------------------------------ */

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-'));
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
        // The outer shared-token gate, deliberately ON for this suite: `/mcp`
        // must be reachable *through* it, because an MCP client has one
        // Authorization header and it has to carry the worker credential.
        BRAIN_ACCESS_TOKEN: 'outer-gate-token-for-tests',
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

  // The admin path goes through the outer gate, so every /api call in this
  // suite needs the Basic header too. Only /mcp is exempt.
  const gate = Buffer.from(`brain:outer-gate-token-for-tests`).toString('base64');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(BASE) && !url.startsWith(MCP)) {
      const headers = new Headers(init?.headers);
      if (!headers.has('authorization')) headers.set('authorization', `Basic ${gate}`);
      return originalFetch(input, { ...init, headers });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP);
  await api('POST', '/api/auth/password', {
    cookie: bootstrapCookie,
    body: { currentPassword: BOOTSTRAP, newPassword: ADMIN_PASSWORD },
  });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  const seeded = await api<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
  projectA = seeded.body.projects[0]!.id;

  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  projectB = (await createProject({ name: 'Somebody Elses Project' })).id;
  await closeDatabase();

  const full = await makeWorker('mcp-worker-a', projectA, [
    'project:read',
    'documents:read',
    'queue:read',
    'queue:claim',
    'queue:heartbeat',
    'queue:complete',
  ]);
  workerSecret = full.secret;
  workerCredentialId = full.credentialId;

  const reader = await makeWorker('mcp-reader', projectA, ['project:read', 'queue:read']);
  readOnlySecret = reader.secret;

  const stranger = await makeWorker('mcp-stranger', projectB, [
    'project:read',
    'queue:read',
    'queue:claim',
    'queue:complete',
  ]);
  strangerSecret = stranger.secret;

  const doomed = await makeWorker('mcp-revoked', projectA, ['project:read']);
  revokedSecret = doomed.secret;
  const revoke = await api('POST', `/api/admin/workers/${doomed.id}/credentials/${doomed.credentialId}/revoke`, {
    cookie: adminCookie,
    body: {},
  });
  if (revoke.status !== 200) throw new Error(`revoke failed: ${JSON.stringify(revoke.body)}`);
}, 90_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    await closeDatabase();
  } catch {
    /* already closed */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------ */
/* 1. The endpoint                                                           */
/* ------------------------------------------------------------------------ */

describe('the endpoint', () => {
  it('answers POST at exactly one path', async () => {
    const response = await mcp('server/discover');
    expect(response.status).toBe(200);
    expect(response.body.result?.['supportedVersions']).toEqual([MODERN, LEGACY]);
  });

  it('refuses GET with 405, because the GET stream was removed in this revision', async () => {
    const response = await fetch(MCP, { headers: { authorization: `Bearer ${workerSecret}` } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses DELETE with 405, because sessions were removed with it', async () => {
    const response = await fetch(MCP, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${workerSecret}` },
    });
    expect(response.status).toBe(405);
  });

  it('is reachable through the outer shared-token gate without a Basic header', async () => {
    // The whole point of the exemption. If this fails, an MCP client cannot
    // connect to a gated Brain at all, because it has one Authorization header.
    const response = await fetch(MCP, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerSecret}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'server/discover',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(envelope('server/discover').body),
    });
    expect(response.status).toBe(200);
  });

  it('is not swallowed by the SPA fallback', async () => {
    const response = await fetch(MCP, { headers: { authorization: `Bearer ${workerSecret}` } });
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('refuses a body over its own 1 MiB limit, not the application-wide 10 MiB one', async () => {
    const huge = { ...envelope('tools/list').body };
    (huge['params'] as Record<string, unknown>)['padding'] = 'x'.repeat(2 * 1024 * 1024);
    const response = await fetch(MCP, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerSecret}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify(huge),
    });
    expect(response.status).toBe(413);
  });

  it('refuses a batch, because this revision defines one request per POST', async () => {
    const response = await mcp('tools/list', {}, { rawBody: [envelope('tools/list').body] });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(-32600);
  });

  it('answers malformed JSON with a parse error rather than a stack trace', async () => {
    const response = await fetch(MCP, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerSecret}`,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/list',
      },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32700);
  });
});

/* ------------------------------------------------------------------------ */
/* 2. Authentication                                                         */
/* ------------------------------------------------------------------------ */

describe('authentication', () => {
  it('refuses a request with no credential', async () => {
    const response = await mcp('server/discover', {}, { bearer: null });
    expect(response.status).toBe(401);
  });

  it('refuses an unknown credential with the same body as a malformed one', async () => {
    const unknown = await mcp('server/discover', {}, { bearer: 'brnw_0123456789abcdef.notarealsecretvalue' });
    const malformed = await mcp('server/discover', {}, { bearer: 'not-a-brain-credential' });
    expect(unknown.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(malformed.body));
  });

  it('refuses a revoked credential', async () => {
    const response = await mcp('server/discover', {}, { bearer: revokedSecret });
    expect(response.status).toBe(401);
  });

  it('points at OAuth metadata that actually resolves', async () => {
    // Step 7 asserted the opposite, and was right to: advertising a flow that
    // does not exist sends a conformant client round a loop it cannot finish.
    // Step 8 built the flow, so the pointer is now true — and it is the only
    // way an MCP client discovers where to authenticate.
    //
    // The assertion is deliberately stronger than "a header is present": it
    // follows the pointer and requires the document to be real, because a
    // header naming a 404 would be exactly the lie the old test guarded.
    const response = await mcp('server/discover', {}, { bearer: null });
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('resource_metadata=');

    const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(url).toBeTruthy();
    const metadata = await fetch(url!);
    expect(metadata.status).toBe(200);
    const document = (await metadata.json()) as Record<string, unknown>;
    expect(document['resource']).toBe(MCP);
    expect(Array.isArray(document['authorization_servers'])).toBe(true);
  });

  it('refuses a session cookie even when it is perfectly valid', async () => {
    // A browser is not an MCP client. Accepting the cookie would put a
    // CSRF-reachable credential on a mutating JSON-RPC endpoint.
    const response = await fetch(MCP, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify(envelope('server/discover').body),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a credential smuggled through the query string', async () => {
    const response = await fetch(`${MCP}?access_token=${encodeURIComponent(workerSecret)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN,
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify(envelope('server/discover').body),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a browser origin, which is the DNS-rebinding control', async () => {
    const response = await mcp('server/discover', {}, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('checks the origin before it checks the credential', async () => {
    // A rebinding attempt should not get to present a credential and learn
    // whether it was any good.
    const response = await mcp('server/discover', {}, { bearer: null, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('allows a request with no origin at all, which is every non-browser client', async () => {
    const response = await mcp('server/discover');
    expect(response.status).toBe(200);
  });
});

/* ------------------------------------------------------------------------ */
/* 3. Protocol conformance                                                   */
/* ------------------------------------------------------------------------ */

describe('the 2026-07-28 protocol', () => {
  it('implements server/discover, which this revision makes mandatory', async () => {
    const result = (await mcp('server/discover')).body.result ?? {};
    expect(result['supportedVersions']).toEqual([MODERN, LEGACY]);
    expect(result['capabilities']).toEqual({ tools: { listChanged: false } });
    expect(typeof result['instructions']).toBe('string');
  });

  it('declares no capability it does not implement', async () => {
    const capabilities = ((await mcp('server/discover')).body.result?.['capabilities'] ?? {}) as Record<string, unknown>;
    // Absent, not present-and-empty: an empty `resources` would send a client
    // looking for a resources/list that answers -32601.
    expect(capabilities['resources']).toBeUndefined();
    expect(capabilities['prompts']).toBeUndefined();
    expect(capabilities['logging']).toBeUndefined();
    expect(capabilities['completions']).toBeUndefined();
  });

  it('puts resultType on every result', async () => {
    for (const method of ['server/discover', 'tools/list']) {
      expect((await mcp(method)).body.result?.['resultType']).toBe('complete');
    }
    const call = await mcp('tools/call', { name: 'brain_whoami', arguments: {} });
    expect(call.body.result?.['resultType']).toBe('complete');
  });

  it('puts ttlMs and cacheScope on the cacheable results', async () => {
    for (const method of ['server/discover', 'tools/list']) {
      const result = (await mcp(method)).body.result ?? {};
      expect(typeof result['ttlMs']).toBe('number');
      // Private without exception: every result is shaped by the caller's own
      // memberships, so no shared intermediary may serve one to another.
      expect(result['cacheScope']).toBe('private');
    }
  });

  it('identifies itself in the result _meta', async () => {
    const meta = ((await mcp('tools/list')).body.result?.['_meta'] ?? {}) as Record<string, unknown>;
    expect(meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 'brain', version: '1.0.0' });
  });

  it('returns tools in a deterministic order', async () => {
    const first = ((await mcp('tools/list')).body.result?.['tools'] ?? []) as { name: string }[];
    const second = ((await mcp('tools/list')).body.result?.['tools'] ?? []) as { name: string }[];
    expect(first.map((t) => t.name)).toEqual(second.map((t) => t.name));
    expect(first.length).toBeGreaterThan(0);
  });

  it('answers an unknown method with -32601 and 404', async () => {
    const response = await mcp('resources/list');
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe(-32601);
  });

  it('answers a notification with 202 and no body', async () => {
    const response = await mcp('tools/list', {}, { id: null });
    expect(response.status).toBe(202);
  });
});

/* ------------------------------------------------------------------------ */
/* 4. Header and version validation                                          */
/* ------------------------------------------------------------------------ */

describe('header and version validation', () => {
  it('refuses an unsupported version with -32022 and the versions it does speak', async () => {
    const response = await mcp(
      'tools/list',
      {},
      {
        headers: { 'mcp-protocol-version': '1900-01-01' },
        rawBody: (() => {
          const built = envelope('tools/list').body;
          const params = built['params'] as Record<string, unknown>;
          const meta = params['_meta'] as Record<string, unknown>;
          meta['io.modelcontextprotocol/protocolVersion'] = '1900-01-01';
          return built;
        })(),
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(-32022);
    expect(response.body.error?.data).toEqual({ supported: [MODERN, LEGACY], requested: '1900-01-01' });
  });

  it('refuses a mismatched Mcp-Method with -32020', async () => {
    const response = await mcp('tools/list', {}, { headers: { 'mcp-method': 'tools/call' } });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(-32020);
  });

  it('refuses a mismatched MCP-Protocol-Version header with -32020', async () => {
    // The body says 2026-07-28 and the header says 2025-11-25. Both are
    // supported versions, so this is a mismatch rather than an unknown version
    // — and that ordering matters, because the two have different codes.
    const response = await mcp('tools/list', {}, { headers: { 'mcp-protocol-version': LEGACY } });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(-32020);
  });

  it('refuses a missing Mcp-Method header', async () => {
    const response = await mcp('tools/list', {}, { headers: { 'mcp-method': undefined } });
    expect(response.body.error?.code).toBe(-32020);
  });

  it('refuses a mismatched Mcp-Name on tools/call', async () => {
    const response = await mcp(
      'tools/call',
      { name: 'brain_whoami', arguments: {} },
      { headers: { 'mcp-name': 'brain_list_projects' } },
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(-32020);
  });

  it('refuses a missing Mcp-Name on tools/call', async () => {
    const response = await mcp('tools/call', { name: 'brain_whoami', arguments: {} }, { headers: { 'mcp-name': undefined } });
    expect(response.body.error?.code).toBe(-32020);
  });

  it('decodes the base64 sentinel before comparing Mcp-Name to the body', async () => {
    // A conformant client encodes a name it cannot represent in ASCII. A server
    // that compared the raw header would reject a perfectly valid request.
    const encoded = `=?base64?${Buffer.from('brain_whoami', 'utf8').toString('base64')}?=`;
    const response = await mcp('tools/call', { name: 'brain_whoami', arguments: {} }, { headers: { 'mcp-name': encoded } });
    expect(response.status).toBe(200);
    expect(response.body.result?.['isError']).toBe(false);
  });

  it('refuses a sentinel that does not actually decode', async () => {
    const response = await mcp(
      'tools/call',
      { name: 'brain_whoami', arguments: {} },
      { headers: { 'mcp-name': '=?base64?!!!not-base64!!!?=' } },
    );
    expect(response.body.error?.code).toBe(-32020);
  });

  it('refuses a body with no _meta protocol version, since there is no handshake to have set one', async () => {
    const built = envelope('tools/list').body;
    const params = built['params'] as Record<string, unknown>;
    delete params['_meta'];
    // Without modern `_meta` this is not a modern request at all, so it falls
    // to the legacy front-end — which refuses it as an uninitialised call
    // rather than serving it. Either way it does not succeed.
    const response = await mcp('tools/list', {}, { rawBody: built });
    expect(response.status).not.toBe(200);
  });

  it('requires clientCapabilities to be declared on every request', async () => {
    const built = envelope('tools/list').body;
    const params = built['params'] as Record<string, unknown>;
    const meta = params['_meta'] as Record<string, unknown>;
    delete meta['io.modelcontextprotocol/clientCapabilities'];
    const response = await mcp('tools/list', {}, { rawBody: built });
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe(-32600);
  });
});

/* ------------------------------------------------------------------------ */
/* 5. What this revision removed                                             */
/* ------------------------------------------------------------------------ */

describe('the removed session machinery', () => {
  it('never mints a session id', async () => {
    const response = await mcp('server/discover');
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('ignores an Mcp-Session-Id a legacy client sends, rather than echoing it', async () => {
    const response = await mcp('tools/list', {}, { headers: { 'mcp-session-id': 'pretend-session' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('ignores Last-Event-ID, because streams are not resumable in this revision', async () => {
    const response = await mcp('tools/list', {}, { headers: { 'last-event-id': '42' } });
    expect(response.status).toBe(200);
  });

  it('serves a second request with no memory of the first', async () => {
    // Statelessness, demonstrated rather than asserted: no handshake happened,
    // and a tools/call works as the very first message on a fresh connection.
    const response = await mcp('tools/call', { name: 'brain_whoami', arguments: {} }, { id: 99 });
    expect(response.body.result?.['isError']).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* 6. Authorization                                                          */
/* ------------------------------------------------------------------------ */

describe('authorization', () => {
  it('shows every caller the identical tool list', async () => {
    const full = ((await mcp('tools/list')).body.result?.['tools'] ?? []) as { name: string }[];
    const reader = ((await mcp('tools/list', {}, { bearer: readOnlySecret })).body.result?.['tools'] ?? []) as {
      name: string;
    }[];
    // The list is not a security boundary. Filtering it would make it a
    // permission oracle and would leave the real check one forgotten filter
    // away from being skipped.
    expect(reader.map((t) => t.name)).toEqual(full.map((t) => t.name));
  });

  it('refuses a tool the caller lacks the scope for, even though it is listed', async () => {
    const result = await tool('brain_claim_work', { limit: 1 }, readOnlySecret);
    expect(result.isError).toBe(true);
  });

  it('gives a forbidden project and an absent one byte-identical answers', async () => {
    const forbidden = await tool('brain_get_project', { project_id: projectB });
    const absent = await tool('brain_get_project', { project_id: 'prj_0000000000000000' });
    expect(forbidden.isError).toBe(true);
    expect(absent.isError).toBe(true);
    // Invariant 23: the *body* must match, not only the status. Step 4 had to
    // amend it after exactly this leak was found in the HTTP resolvers.
    expect(JSON.stringify(forbidden.structured)).toBe(JSON.stringify(absent.structured));
  });

  it('never names the id it refused', async () => {
    const result = await tool('brain_get_project', { project_id: projectB });
    expect(JSON.stringify(result.structured)).not.toContain(projectB);
  });

  it('lists only the projects the caller may reach', async () => {
    const result = await tool('brain_list_projects');
    const projects = (result.structured['projects'] ?? []) as { id: string }[];
    expect(projects.map((p) => p.id)).toContain(projectA);
    expect(projects.map((p) => p.id)).not.toContain(projectB);
  });

  it('resolves a work item to its own project rather than to one the caller names', async () => {
    const itemInA = await enqueue(projectA, 'for the isolation test');
    // The stranger holds queue:read — in project B. Naming A's item must not
    // work, because the project comes from the row.
    const result = await tool('brain_get_work_item', { work_item_id: itemInA }, strangerSecret);
    expect(result.isError).toBe(true);
  });

  it('refuses a claim from a worker holding the scope in no project', async () => {
    const result = await tool('brain_claim_work', { limit: 1 }, readOnlySecret);
    expect(result.isError).toBe(true);
    // "No claimable work" and "you may not claim" must not be the same answer —
    // a revoked worker would otherwise poll forever against an apparently idle
    // queue while whoever debugs it reads "no work".
    expect(String(result.structured['error'] && (result.structured['error'] as Record<string, unknown>)['category'])).toBe(
      'NOT_FOUND',
    );
  });

  it('refuses to narrow a claim to a project the worker has no claim on', async () => {
    const result = await tool('brain_claim_work', { project_id: projectB, limit: 1 });
    expect(result.isError).toBe(true);
  });

  it('exposes no tool that administers anything', async () => {
    const tools = ((await mcp('tools/list')).body.result?.['tools'] ?? []) as { name: string }[];
    const names = tools.map((t) => t.name);
    // Enqueue, cancel and resolve are ADMIN and name no worker scope. A leaked
    // worker credential must not be able to create work for the fleet or decide
    // what an unknown outcome meant.
    for (const forbidden of ['enqueue', 'cancel', 'resolve', 'sql', 'exec', 'fetch', 'file', 'shell']) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 7. The queue, over MCP                                                    */
/* ------------------------------------------------------------------------ */

describe('operating the queue', () => {
  it('claims, heartbeats and completes an item', async () => {
    await enqueue(projectA, 'the happy path');
    const claim = await claimOne();
    expect(claim.leaseId).toBeTruthy();

    const beat = await tool('brain_heartbeat_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    });
    expect(beat.isError).toBe(false);

    const done = await tool('brain_complete_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
      summary: 'done',
    });
    expect(done.isError).toBe(false);
    expect(done.structured['state']).toBe('SUCCEEDED');
  });

  it('answers an empty queue with an empty list rather than an error', async () => {
    // Drain first, so this is genuinely the idle case.
    for (let i = 0; i < 5; i += 1) {
      const result = await tool('brain_claim_work', { limit: 10 });
      const claimed = (result.structured['claimed'] ?? []) as Claim[];
      if (claimed.length === 0) break;
      for (const claim of claimed) {
        await tool('brain_release_work', {
          work_item_id: claim.workItemId,
          lease_id: claim.leaseId,
          lease_generation: claim.leaseGeneration,
        });
        await api('POST', `/api/work/${claim.workItemId}/cancel`, { cookie: adminCookie, body: { reason: 'draining' } });
      }
    }
    const result = await tool('brain_claim_work', { limit: 1 });
    expect(result.isError).toBe(false);
    expect(result.structured['claimed']).toEqual([]);
  });

  it('never publishes a lease id to a reader who is not the owner', async () => {
    await enqueue(projectA, 'lease privacy');
    const claim = await claimOne();
    const seen = await tool('brain_get_work_item', { work_item_id: claim.workItemId }, readOnlySecret);
    expect(seen.isError).toBe(false);
    const item = seen.structured['item'] as Record<string, unknown>;
    expect(item['hasLease']).toBe(true);
    expect(JSON.stringify(item)).not.toContain(claim.leaseId);
    await tool('brain_release_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    });
  });

  it('ignores a worker id in the arguments and uses the authenticated one', async () => {
    await enqueue(projectA, 'identity');
    const claim = await claimOne();
    const result = await tool(
      'brain_complete_work',
      {
        work_item_id: claim.workItemId,
        lease_id: claim.leaseId,
        lease_generation: claim.leaseGeneration,
        // Not a parameter of this tool. `additionalProperties: false` and the
        // fact that ownership comes from the principal both have to hold.
        worker_id: 'wrk_somebody_else',
      },
      workerSecret,
    );
    // Either refused as an unknown argument or completed as the real worker —
    // never completed *as somebody else*.
    if (!result.isError) expect(result.structured['state']).toBe('SUCCEEDED');
  });

  it('refuses a stale generation with FENCE_LOST', async () => {
    await enqueue(projectA, 'fencing');
    const claim = await claimOne();
    const result = await tool('brain_complete_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration + 1,
    });
    expect(result.isError).toBe(true);
    expect((result.structured['error'] as Record<string, unknown>)['category']).toBe('FENCE_LOST');
    await tool('brain_release_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    });
  });

  it('refuses a forged lease id with FENCE_LOST', async () => {
    await enqueue(projectA, 'forgery');
    const claim = await claimOne();
    const result = await tool('brain_complete_work', {
      work_item_id: claim.workItemId,
      lease_id: 'lse_not_the_real_one',
      lease_generation: claim.leaseGeneration,
    });
    expect(result.isError).toBe(true);
    expect((result.structured['error'] as Record<string, unknown>)['category']).toBe('FENCE_LOST');
    await tool('brain_release_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    });
  });

  it('refuses an unknown failure category rather than guessing the closest one', async () => {
    await enqueue(projectA, 'categories');
    const claim = await claimOne();
    const result = await tool('brain_fail_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
      category: 'SOMETHING_INVENTED',
    });
    expect(result.isError).toBe(true);
    expect((result.structured['error'] as Record<string, unknown>)['category']).toBe('INVALID_INPUT');
    await tool('brain_release_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    });
  });
});

/* ------------------------------------------------------------------------ */
/* 8. Idempotency                                                            */
/* ------------------------------------------------------------------------ */

describe('idempotency', () => {
  it('replays a repeated completion instead of performing it twice', async () => {
    await enqueue(projectA, 'idempotent completion');
    const claim = await claimOne();
    const args = {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
      summary: 'first',
    };
    const first = await tool('brain_complete_work', args);
    expect(first.isError).toBe(false);
    expect(first.structured['state']).toBe('SUCCEEDED');

    // The same logical operation, again. The derived key is the work item and
    // the operation, so this is the same key — and the fence has gone with the
    // completion, so a second *effect* is impossible either way.
    const second = await tool('brain_complete_work', args);
    expect(second.structured['state']).toBe('ALREADY_RECORDED');
  });

  it('derives the same key whether or not the caller supplies one', async () => {
    await enqueue(projectA, 'derived keys');
    const claim = await claimOne();
    const base = {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    };
    const first = await tool('brain_complete_work', base);
    expect(first.isError).toBe(false);
    // A different *summary* must not create a different operation: a result is
    // an output, and outputs do not belong in an identity. Step 6 found this
    // one the hard way.
    const second = await tool('brain_complete_work', { ...base, summary: 'a completely different summary' });
    expect(second.structured['state']).toBe('ALREADY_RECORDED');
  });

  it('refuses a malformed idempotency key rather than ignoring it', async () => {
    await enqueue(projectA, 'bad key');
    const claim = await claimOne();
    const result = await tool('brain_complete_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
      idempotency_key: 'has spaces and $ymbols',
    });
    expect(result.isError).toBe(true);
    expect((result.structured['error'] as Record<string, unknown>)['category']).toBe('INVALID_INPUT');
    await tool('brain_release_work', {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    });
  });

  it('refuses an Idempotency-Key HTTP header, which would name a request rather than an effect', async () => {
    const response = await mcp('tools/list', {}, { headers: { 'idempotency-key': 'looks-legitimate' } });
    // Honouring it would give the caller a property it does not have: one POST
    // is one message, and the key belongs to the effect, not the transport.
    expect(response.status).toBe(400);
  });

  it('suppresses concurrent duplicates down to one effect', async () => {
    await enqueue(projectA, 'concurrent duplicates');
    const claim = await claimOne();
    const args = {
      work_item_id: claim.workItemId,
      lease_id: claim.leaseId,
      lease_generation: claim.leaseGeneration,
    };
    const results = await Promise.all([
      tool('brain_complete_work', args),
      tool('brain_complete_work', args),
      tool('brain_complete_work', args),
      tool('brain_complete_work', args),
    ]);
    const executed = results.filter((r) => r.structured['state'] === 'SUCCEEDED');
    // Exactly one performed the effect. The rest replayed, were told an
    // equivalent request was in flight, or found it already recorded — every
    // one of which is a correct answer, and none of which is a second effect.
    expect(executed.length).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* 9. Bounds                                                                 */
/* ------------------------------------------------------------------------ */

describe('bounds', () => {
  it('clamps a page size instead of honouring an enormous one', async () => {
    const result = await tool('brain_list_work', { project_id: projectA, limit: 100000 });
    expect(result.isError).toBe(false);
    const items = (result.structured['items'] ?? []) as unknown[];
    expect(items.length).toBeLessThanOrEqual(200);
  });

  it('refuses a page size that is not a positive integer rather than coercing it', async () => {
    const result = await tool('brain_list_work', { project_id: projectA, limit: -1 });
    expect(result.isError).toBe(true);
  });

  it('refuses an unknown work item state rather than silently dropping it', async () => {
    const result = await tool('brain_list_work', { project_id: projectA, states: ['RUNNING'] });
    expect(result.isError).toBe(true);
    expect((result.structured['error'] as Record<string, unknown>)['category']).toBe('INVALID_INPUT');
  });

  it('reports a document it cannot read as unreadable rather than as empty', async () => {
    const documents = await api<{ documents: { id: string }[] }>('GET', `/api/projects/${projectA}/documents`, {
      cookie: adminCookie,
    });
    const first = documents.body?.documents?.[0];
    if (!first) return; // the seed has no documents; nothing to assert here
    const result = await tool('brain_get_document_text', { document_id: first.id });
    expect(result.isError).toBe(false);
    // Whichever it is, it says so. What it must never do is return `text: ""`
    // for a document that was never successfully extracted.
    if (result.structured['readable'] === false) {
      expect(result.structured['text']).toBeNull();
      expect(typeof result.structured['reason']).toBe('string');
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 10. Audit                                                                 */
/* ------------------------------------------------------------------------ */

describe('the audit trail', () => {
  it('records every tool call, and records no argument', async () => {
    await tool('brain_get_plan', { project_id: projectA });

    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    try {
      const rows = await getDb().all<{ action: string; target_id: string; metadata: string; result: string }>(
        "SELECT action, target_id, metadata, result FROM identity_events WHERE action = 'MCP_TOOL_CALL' ORDER BY created_at DESC",
        [],
      );
      expect(rows.length).toBeGreaterThan(0);
      const plan = rows.find((row) => row.target_id === 'brain_get_plan');
      expect(plan).toBeTruthy();
      expect(plan?.result).toBe('SUCCESS');

      // Counts, categories and ids only. Never an argument, never a passage,
      // never a payload, never a credential.
      for (const row of rows) {
        expect(row.metadata).not.toContain(workerSecret);
        expect(row.metadata).not.toContain('arguments');
        expect(row.metadata).not.toContain('project_id');
      }
    } finally {
      await closeDatabase();
    }
  });

  it('records a refused credential but not the credential', async () => {
    await mcp('server/discover', {}, { bearer: 'brnw_0123456789abcdef.wrongsecretvaluehere' });

    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    try {
      const rows = await getDb().all<{ reason: string; metadata: string }>(
        "SELECT reason, metadata FROM identity_events WHERE action = 'MCP_AUTHENTICATE'",
        [],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // A category from the closed set, never what was tried. Asserting one
        // specific category would be wrong: this table also holds the REVOKED
        // row from the revoked-credential test, and both are correct answers.
        // What matters is that the reason is a category at all and that the
        // secret is nowhere in the row.
        expect(DENIAL_REASONS as readonly string[]).toContain(row.reason);
        expect(JSON.stringify(row)).not.toContain('wrongsecretvaluehere');
      }
      // And the specific one this test provoked is present.
      expect(rows.some((row) => row.reason === 'INVALID_CREDENTIALS')).toBe(true);
    } finally {
      await closeDatabase();
    }
  });

  it('records which credential made a successful call, by id and never by secret', async () => {
    await tool('brain_whoami');
    await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
    try {
      const row = await getDb().get<{ credential_id: string }>(
        "SELECT credential_id FROM identity_events WHERE action = 'MCP_TOOL_CALL' AND target_id = 'brain_whoami' ORDER BY created_at DESC LIMIT 1",
        [],
      );
      expect(row?.credential_id).toBe(workerCredentialId);
    } finally {
      await closeDatabase();
    }
  });
});
