/**
 * The second connector door, and the one property that makes it safe.
 *
 * ---------------------------------------------------------------------------
 * Why there are two paths at all
 * ---------------------------------------------------------------------------
 *
 * Claude's connector registry is keyed by URL. Adding a second custom connector
 * that points at a URL an existing connector already holds is refused outright
 * — *"A connector with this URL already exists in your organization. Use the
 * existing connector instead of adding it again."* — and the screen has no
 * other field that could tell two connections apart. One Brain therefore cannot
 * be connected twice at one path, however correct its credential design is.
 *
 * That is a fact about the client, so the remedy is a second **name** for the
 * same endpoint. The danger of a second name is that it quietly becomes a
 * second **entrance**: something reads the path, and then a URL is a permission.
 * This suite exists to refuse that, and it is written the way `mcp.test.ts` is
 * written — a real server process over a real socket — because every property
 * here is a property of the *wiring*. Whether both paths are mounted, whether
 * the SPA fallback eats one of them, whether discovery resolves for each, and
 * whether the mount order lets a shorter path shadow a longer one are all
 * invisible to an in-process handler test.
 *
 * The claims, in the order they matter:
 *
 *   1. Both paths are the same endpoint — same eras, same tools, same refusals.
 *   2. **The authenticated credential decides who the caller is, and the URL
 *      contributes nothing.** A worker's token means the same thing at either
 *      door, and neither door widens or narrows what it may reach.
 *   3. A refusal is byte-identical at both, so the extra path is not an oracle.
 *   4. Discovery resolves for each, which is what a connector needs in order to
 *      find the authorization server at all.
 *   5. The set is closed: an unregistered sibling path is not an MCP endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { FACTORY_MCP_PATH, MCP_PATH, MCP_PATHS } from '../server/mcp/endpoint.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// 7300, because `tests/cashHttp.test.ts` took 6800 on production while this
// suite was on a branch. Two suites on one range do not fail loudly — `/healthz`
// is unauthenticated, so the second one's readiness probe finds the first one's
// server and then signs in against a Brain with a different bootstrap
// administrator, which reports 401 and reads as a broken sign-in.
// `deploymentOwnership` is what caught it at the merge.
const PORT = pickPort(7300, 100);
const BASE = `http://127.0.0.1:${PORT}`;
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

/** An unregistered sibling: the same prefix, and not an endpoint. */
const UNREGISTERED = '/mcp/research';

let server: ChildProcessByStdio<null, Readable, Readable>;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let adminCookie = '';
let researchProject = '';
let factoryProject = '';

/** A worker in the research project, with queue scopes. */
let researchSecret = '';
let researchName = '';
/** A worker in the factory project only, and read-only there. */
let factorySecret = '';
let factoryName = '';

/* ------------------------------------------------------------------------ */
/* Plumbing                                                                  */
/* ------------------------------------------------------------------------ */

interface Result<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

async function api<T = unknown>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Result<T>> {
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
  return { status: response.status, body: body as T, text, headers: response.headers };
}

interface RpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** A modern envelope, posted at whichever door the test names. */
async function mcp(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  bearer: string | null = null,
): Promise<Result<RpcResponse>> {
  const named = typeof params['name'] === 'string' ? (params['name'] as string) : null;
  const headers: Record<string, string> = {
    'mcp-protocol-version': MODERN,
    'mcp-method': method,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(named ? { 'mcp-name': named } : {}),
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'brain-path-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: response.status, body: body as RpcResponse, text, headers: response.headers };
}

async function tool(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
  bearer: string,
): Promise<{ status: number; isError: boolean; structured: Record<string, unknown> }> {
  const response = await mcp(endpoint, 'tools/call', { name, arguments: args }, bearer);
  const result = response.body.result ?? {};
  return {
    status: response.status,
    isError: result['isError'] === true || response.status >= 400,
    structured: (result['structuredContent'] ?? {}) as Record<string, unknown>,
  };
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

async function makeWorker(
  name: string,
  project: string,
  scopes: string[],
): Promise<{ id: string; label: string; secret: string }> {
  const worker = await api<{ worker: { id: string; label: string } }>('POST', '/api/admin/workers', {
    cookie: adminCookie,
    body: { name, displayName: name },
  });
  const id = worker.body.worker.id;
  const label = worker.body.worker.label;
  const granted = await api('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: id, principalType: 'WORKER', scopes },
  });
  if (granted.status !== 200) throw new Error(`grant failed: ${JSON.stringify(granted.body)}`);
  const issued = await api<{ secret: string }>('POST', `/api/admin/workers/${id}/credentials`, {
    cookie: adminCookie,
    body: {},
  });
  return { id, label, secret: issued.body.secret };
}

/* ------------------------------------------------------------------------ */
/* Setup                                                                     */
/* ------------------------------------------------------------------------ */

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-paths-'));
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
  researchProject = seeded.body.projects[0]!.id;

  await initDatabase({ dbPath: path.join(dataDir, 'brain.db') });
  factoryProject = (await createProject({ name: 'A Repository Project' })).id;
  await closeDatabase();

  // The *label* Brain assigned, not the handle typed above: a worker's
  // operational identity is neutral by construction, so a test that expected
  // the typed name back would be pinning the defect migration 074 removes.
  const researchWorker = await makeWorker('paths-research-worker', researchProject, [
    'project:read',
    'queue:read',
    'queue:claim',
  ]);
  researchName = researchWorker.label;
  researchSecret = researchWorker.secret;

  const factoryWorker = await makeWorker('paths-factory-worker', factoryProject, ['project:read']);
  factoryName = factoryWorker.label;
  factorySecret = factoryWorker.secret;
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
/* 1. One endpoint, two names                                                */
/* ------------------------------------------------------------------------ */

describe('one endpoint under two names', () => {
  it('declares the factory path as a second name and never as a second endpoint', () => {
    // The canonical path comes first, because the unsuffixed metadata document
    // describes it and `pathOf` falls back to it.
    expect(MCP_PATHS[0]).toBe(MCP_PATH);
    expect(MCP_PATHS).toContain(FACTORY_MCP_PATH);
    expect(FACTORY_MCP_PATH.startsWith(`${MCP_PATH}/`)).toBe(true);
  });

  it('answers server/discover with the same eras at both paths', async () => {
    for (const endpoint of MCP_PATHS) {
      const response = await mcp(endpoint, 'server/discover', {}, researchSecret);
      expect(response.status, endpoint).toBe(200);
      expect(response.body.result?.['supportedVersions'], endpoint).toEqual([MODERN, LEGACY]);
    }
  });

  it('offers the identical tool surface at both paths', async () => {
    const listed = await Promise.all(
      MCP_PATHS.map(async (endpoint) => {
        const response = await mcp(endpoint, 'tools/list', {}, researchSecret);
        const tools = (response.body.result?.['tools'] ?? []) as { name: string }[];
        return tools.map((entry) => entry.name).sort();
      }),
    );
    expect(listed[0]!.length).toBeGreaterThan(0);
    for (const names of listed) expect(names).toEqual(listed[0]);
  });

  it('refuses GET with 405 at both, so the SPA fallback has eaten neither', async () => {
    for (const endpoint of MCP_PATHS) {
      const response = await fetch(`${BASE}${endpoint}`, {
        headers: { authorization: `Bearer ${researchSecret}` },
      });
      expect(response.status, endpoint).toBe(405);
      expect(response.headers.get('allow'), endpoint).toBe('POST');
    }
  });

  it('applies the same transport rules at both — no browser origin, no Idempotency-Key', async () => {
    for (const endpoint of MCP_PATHS) {
      const origin = await fetch(`${BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          authorization: `Bearer ${researchSecret}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
      });
      expect(origin.status, endpoint).toBe(403);

      const keyed = await fetch(`${BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'not-honoured-here',
          authorization: `Bearer ${researchSecret}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
      });
      expect(keyed.status, endpoint).toBe(400);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 2. The credential decides, the URL does not                               */
/* ------------------------------------------------------------------------ */

describe('the credential decides who the caller is', () => {
  it('resolves each token to its own worker at whichever door it is presented', async () => {
    for (const endpoint of MCP_PATHS) {
      const research = await tool(endpoint, 'brain_whoami', {}, researchSecret);
      expect(research.isError, endpoint).toBe(false);
      expect(research.structured['handle'], endpoint).toBe(researchName);

      const factory = await tool(endpoint, 'brain_whoami', {}, factorySecret);
      expect(factory.isError, endpoint).toBe(false);
      expect(factory.structured['handle'], endpoint).toBe(factoryName);

      // Two workers, two identities, and neither is the handle somebody typed.
      expect(researchName, endpoint).not.toBe(factoryName);
      expect(researchName, endpoint).toMatch(/^worker-\d\d$/);
      expect(factoryName, endpoint).toMatch(/^worker-\d\d$/);
    }
  });

  it('gives a token exactly the same reach at both doors', async () => {
    /*
     * The claim in one assertion: the path is not a scope.
     *
     * A factory-path caller does not become a factory worker, and a
     * research-path caller does not lose its factory project. Both tokens are
     * asked what they can reach at both doors and must answer the same thing
     * four times.
     */
    const reach = async (endpoint: string, bearer: string): Promise<string[]> => {
      const result = await tool(endpoint, 'brain_list_projects', {}, bearer);
      expect(result.isError, `${endpoint} ${bearer.slice(0, 6)}`).toBe(false);
      const projects = (result.structured['projects'] ?? []) as { id: string }[];
      return projects.map((project) => project.id).sort();
    };

    const researchAtCanonical = await reach(MCP_PATH, researchSecret);
    const researchAtFactory = await reach(FACTORY_MCP_PATH, researchSecret);
    expect(researchAtFactory).toEqual(researchAtCanonical);
    expect(researchAtCanonical).toEqual([researchProject]);

    const factoryAtCanonical = await reach(MCP_PATH, factorySecret);
    const factoryAtFactoryDoor = await reach(FACTORY_MCP_PATH, factorySecret);
    expect(factoryAtFactoryDoor).toEqual(factoryAtCanonical);
    expect(factoryAtCanonical).toEqual([factoryProject]);
  });

  it('does not let the factory path reach a project the credential may not have', async () => {
    // The same 404-shaped refusal a real miss gets, at the door that might have
    // been mistaken for a way round it.
    for (const endpoint of MCP_PATHS) {
      const result = await tool(endpoint, 'brain_get_project', { projectId: researchProject }, factorySecret);
      expect(result.isError, endpoint).toBe(true);
    }
  });

  it('does not let the factory path grant a scope the membership withholds', async () => {
    // `queue:claim` is absent from the factory worker's membership. A URL that
    // could supply it would be a permission.
    for (const endpoint of MCP_PATHS) {
      const result = await tool(endpoint, 'brain_claim_work', { projectId: factoryProject, limit: 1 }, factorySecret);
      expect(result.isError, endpoint).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 3. A refusal is the same refusal                                          */
/* ------------------------------------------------------------------------ */

describe('refusals', () => {
  it('refuses an absent credential identically at both, and points each at its own metadata', async () => {
    const seen: string[] = [];
    for (const endpoint of MCP_PATHS) {
      const response = await mcp(endpoint, 'server/discover', {}, null);
      expect(response.status, endpoint).toBe(401);
      seen.push(response.text);
      // RFC 9728 puts the document for a resource with a path under that path,
      // and a connector with nothing to discover simply fails.
      expect(response.headers.get('www-authenticate'), endpoint).toContain(
        `resource_metadata="${BASE}/.well-known/oauth-protected-resource${endpoint}"`,
      );
    }
    // Byte-identical: the extra door tells an unauthenticated caller nothing
    // the canonical one does not.
    expect(new Set(seen).size).toBe(1);
  });

  it('refuses a garbage credential identically at both', async () => {
    const seen: string[] = [];
    for (const endpoint of MCP_PATHS) {
      const response = await mcp(endpoint, 'server/discover', {}, 'brnw_not-a-real-credential');
      expect(response.status, endpoint).toBe(401);
      seen.push(response.text);
    }
    expect(new Set(seen).size).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* 4. Discovery                                                              */
/* ------------------------------------------------------------------------ */

describe('discovery', () => {
  it('publishes protected resource metadata for every path it serves', async () => {
    for (const endpoint of MCP_PATHS) {
      const reply = await api<Record<string, unknown>>(
        'GET',
        `/.well-known/oauth-protected-resource${endpoint}`,
      );
      expect(reply.status, endpoint).toBe(200);
      expect(reply.body['resource'], endpoint).toBe(`${BASE}${endpoint}`);
      // One Brain, one authorization server. The paths differ in `resource` and
      // in nothing else, because they are two names for one endpoint.
      expect(reply.body['authorization_servers'], endpoint).toEqual([BASE]);
    }
  });

  it('keeps the unsuffixed document describing the canonical endpoint', async () => {
    const reply = await api<Record<string, unknown>>('GET', '/.well-known/oauth-protected-resource');
    expect(reply.status).toBe(200);
    expect(reply.body['resource']).toBe(`${BASE}${MCP_PATH}`);
  });

  it('points both paths at one authorization server, so one consent flow serves both', async () => {
    const reply = await api<Record<string, unknown>>('GET', '/.well-known/oauth-authorization-server');
    expect(reply.status).toBe(200);
    expect(reply.body['issuer']).toBe(BASE);
    expect(reply.body['authorization_endpoint']).toBe(`${BASE}/oauth/authorize`);
    expect(reply.body['token_endpoint']).toBe(`${BASE}/oauth/token`);
    // A connector registered at either door registers itself the same way and
    // refreshes the same way.
    expect(reply.body['grant_types_supported']).toEqual(['authorization_code', 'refresh_token']);
    expect(reply.body['code_challenge_methods_supported']).toEqual(['S256']);
  });
});

/* ------------------------------------------------------------------------ */
/* 5. The set is closed                                                      */
/* ------------------------------------------------------------------------ */

describe('the set of paths is closed', () => {
  it('does not serve MCP at an unregistered sibling path', async () => {
    expect(MCP_PATHS).not.toContain(UNREGISTERED);
    // Not a 405, which is what a mounted endpoint answers a GET with. Anything
    // else would mean a free-form label was being accepted.
    const get = await fetch(`${BASE}${UNREGISTERED}`);
    expect(get.status).toBe(404);
    expect(get.headers.get('allow')).toBeNull();

    // Not the client bundle either: `isServerPath` keeps the SPA fallback off
    // everything under `/mcp/`, so a probe of an unregistered door reads as the
    // absence it is rather than as HTML.
    expect((await get.text()).includes('<!doctype html')).toBe(false);

    const post = await mcp(UNREGISTERED, 'server/discover', {}, researchSecret);
    expect(post.status).toBe(404);
  });

  it('publishes no protected-resource metadata for a path it does not serve', async () => {
    const reply = await api('GET', `/.well-known/oauth-protected-resource${UNREGISTERED}`);
    expect(reply.status).toBe(404);
  });
});
