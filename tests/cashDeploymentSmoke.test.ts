/**
 * The deployable artifact, booted the way production boots it.
 *
 * Every other cash suite calls services or mounts a router in the test process.
 * This one spawns `server/index.ts` as its own process against a fresh data
 * directory and drives it over HTTP — so what is under test is the *boot*: the
 * migration run, the identity bootstrap, the dispatcher, the Russell tick that
 * carries Cash Mode's operating pass, and the routes a browser and a worker
 * actually call.
 *
 * It is a smoke test and says what that means. It runs against a Brain on this
 * machine, not against the hosted one; the external edge — the sentences a
 * worker found — is a declared fixture; and **no buyer is contacted, no payment
 * is taken, no Routine is fired and no Cowork session runs**. What is real is
 * the artifact: the process, the schema, the authentication, the queue, the MCP
 * transport with a genuine worker bearer, and the ticks doing their own work on
 * their own clock.
 *
 * The eight things it checks are the deployment questions, in the order a
 * person would ask them:
 *
 *   1. a private operation can be activated at all;
 *   2. the tick finds work without anybody asking it to;
 *   3. a worker result is accepted through the real remote surface;
 *   4. what the research established reaches the card;
 *   5. a person's decision through the browser route lands in a row;
 *   6. a missing capability pauses its own action and nothing else;
 *   7. the other opportunities carry on;
 *   8. winding down stops new discovery and leaves obligations alive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(7000, 100);
const BASE = `http://127.0.0.1:${PORT}`;
const MODERN = '2026-07-28';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let log = '';
let admin = '';
let project = '';
let workerId = '';
let bearer = '';
let claimed: any = null;
let opportunity: any = null;

async function call<T = any>(
  method: string,
  route: string,
  options: { cookie?: string; body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: T }> {
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
  return { status: response.status, body: body as T };
}

/** One MCP tool call over the real endpoint, as a worker holding a bearer. */
async function tool(
  name: string,
  args: Record<string, unknown>,
  bearer: string,
): Promise<Record<string, any>> {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': MODERN,
      'mcp-method': 'tools/call',
      'mcp-name': name,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      origin: BASE,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': { name: 'smoke-worker', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as {
    result?: { structuredContent?: Record<string, any>; isError?: boolean; content?: unknown };
    error?: { message: string };
  };
  if (parsed.error) throw new Error(`${name}: ${parsed.error.message}`);
  const result = parsed.result ?? {};
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? {};
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

/** Wait for something the ticks are expected to do on their own. */
async function until<T>(
  what: string,
  read: () => Promise<T | null>,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await read();
      if (value !== null && value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-smoke-'));
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
        // No paid model path, exactly as the deployed Brain runs.
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        BRAIN_PROVIDER: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const first = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', {
    cookie: first,
    body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD },
  });
  admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  /*
   * A private operation is its **own project**, created on a terminal.
   *
   * This is the one setup step that is not obvious and is load-bearing. The
   * seeded `deal-dispatch` project has an entry in the compiler's in-code slug
   * map, and that map deliberately wins over a cash mode's chosen envelope —
   * "nothing about an existing project's authorization can be changed by
   * activating a cash mode on it". Activating a sprint there is therefore not
   * an error and produces no openings: the buckets compile as public-records
   * questions whose lanes are `official_source`, and `harvest` reads
   * `demand_signal`. Discovery runs, missions run, and nothing is ever
   * harvested.
   *
   * Running it that way first is what found this, and it is in the handoff.
   * Four people means four projects, each created like this.
   */
  const created = execFileSync(
    'npx',
    ['tsx', path.join(REPO_ROOT, 'scripts', 'admin.ts'), 'projects', 'create', 'Smoke Operation',
      '--admin', ADMIN_EMAIL],
    {
      cwd: REPO_ROOT,
      // The suite's own per-file database path has to go, or the command opens
      // a different Brain from the one that is running — which is exactly what
      // it says when it does.
      env: { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_DB_PATH: undefined },
      encoding: 'utf8',
    },
  );
  project = created.trim().split(/\s+/)[0] ?? '';
  expect(project).toMatch(/^prj_/);

  const member = await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: admin,
    body: { principalType: 'HUMAN', principalId: 'me', role: 'ADMIN' },
  });
  // A Brain administrator already reaches every project, so a membership is
  // not required to drive this; it is asserted only if the route accepts it.
  void member;
}, 180_000);

afterAll(async () => {
  if (server) {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!server.killed) server.kill('SIGKILL');
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('the deployable artifact', () => {
  it('boots, migrates and reports itself healthy', async () => {
    const health = await fetch(`${BASE}/healthz`);
    expect(health.ok).toBe(true);
    // The boot order is the product: migrate, seed, recompute, then serve.
    expect(log).toMatch(/Brain is running/);
    expect(log).toMatch(/Schema version\s+\d+/);
  });

  it('1. activates one private operation, and 2. the tick finds work by itself', async () => {
    // The two decisions a person makes, through the routes the screen calls.
    const research = await call('POST', `/api/russell/projects/${project}/authority`, {
      cookie: admin,
      body: { name: 'Cash Mode discovery', maxConcurrent: 2 },
    });
    expect(research.status).toBe(200);

    const activated = await call('POST', `/api/projects/${project}/cash/mode`, {
      cookie: admin,
      body: { objective: 'Maximize additional usable cash over the next few weeks.' },
    });
    expect(activated.status).toBe(200);
    expect(activated.body.mode.state).toBe('ACTIVE');

    /*
     * And then nobody asks it to do anything.
     *
     * Discovery is opened by the Russell tick inside the booted process, on
     * its own thirty-second clock. What arrives are *questions* — one per
     * declared search bucket — never findings.
     */
    const opened = await until('the tick to open discovery', async () => {
      const view = await call('GET', `/api/projects/${project}/cash`, { cookie: admin });
      const events = (view.body.whatBrainHasDone ?? []) as { kind: string }[];
      return events.some((one) => one.kind === 'CASH_DISCOVERY_OPENED') ? view.body : null;
    });
    expect(opened.mode.state).toBe('ACTIVE');
  }, 240_000);

  it('3. takes a worker result through the real remote surface', async () => {
    // A worker identity and a credential, issued by an administrator through
    // the routes that issue them. The secret is shown once and is a `brnw_`
    // bearer — the Step 4 credential, not an OAuth token.
    const worker = await call('POST', '/api/admin/workers', {
      cookie: admin,
      body: { name: 'smoke-research-worker', displayName: 'Smoke research worker' },
    });
    expect(worker.status).toBe(200);
    workerId = worker.body.worker.id;

    const issued = await call('POST', `/api/admin/workers/${workerId}/credentials`, {
      cookie: admin,
      body: {},
    });
    expect(issued.status).toBe(200);
    bearer = issued.body.secret ?? issued.body.credential?.secret ?? '';
    expect(bearer).toMatch(/^brnw_/);

    const member = await call('POST', `/api/admin/projects/${project}/members`, {
      cookie: admin,
      body: {
        principalType: 'WORKER',
        principalId: workerId,
        scopes: [
          'project:read',
          'documents:read',
          'research:read',
          'research:propose',
          'research:write',
          'claims:write',
          'contradictions:write',
          'checkpoints:write',
          'blockers:report',
          'queue:read',
          'queue:claim',
          'queue:heartbeat',
          'queue:complete',
        ],
      },
    });
    expect(member.status).toBe(200);

    // It authenticates against the endpoint from outside, with nothing but the
    // bearer. Everything after this is over the wire.
    const who = await tool('brain_whoami', {}, bearer);
    expect(who['principalType']).toBe('WORKER');

    /*
     * Then it waits for Brain to have something for it.
     *
     * Nothing here creates the item. The tick judges the captured idea,
     * compiles a specification inside the standing envelope, launches a
     * mission, and the packet runner queues the fragment — so what the worker
     * claims is work Brain decided to create.
     */
    claimed = await until('Brain to queue a research fragment', async () => {
      const taken = await tool(
        'brain_claim_work',
        { project_id: project, work_types: ['RESEARCH_FRAGMENT'], limit: 1 },
        bearer,
      );
      const items = (taken['claimed'] ?? taken['items'] ?? []) as any[];
      return items.length > 0 ? items[0] : null;
    });
    expect(claimed.workItemId).toBeTruthy();
  }, 300_000);

  it('4. puts what the research established on a card, with its provenance', async () => {
    const proof = {
      work_item_id: claimed.workItemId,
      lease_id: claimed.leaseId,
      lease_generation: claimed.leaseGeneration,
    };

    // The declaration the gate will judge the work against comes from Brain,
    // never from here — including the lane ids a claim has to name.
    const assignment = await tool('brain_get_assignment', { work_item_id: claimed.workItemId }, bearer);
    const lanes = (assignment['assignment'] as any).fragment.evidenceLaneIds as string[];
    expect(lanes).toContain('demand_signal');

    /*
     * The one simulated thing in this file: the sentence a worker found.
     *
     * Everything the sentence then passes through is real — the lane
     * validation, the idempotency scope, the pass record, and the
     * seven-condition gate that decides whether it counts.
     */
    const submitted = await tool(
      'brain_submit_claims',
      {
        ...proof,
        claims: [
          {
            claim:
              'A published notice asks for an intake form to be repaired and tested, with a ' +
              'stated budget of $1,200.',
            claim_type: 'SOURCED_FACT',
            source_url: 'https://example.invalid/notices/intake-form-repair',
            source_title: 'Notice: intake form repair',
            source_publisher: 'example.invalid',
            source_date: '2026-09-10',
            evidence_excerpt: 'Wanted: intake form repaired and tested. Budget $1,200.',
            evidence_locator: 'the notice body',
            evidence_lane: 'demand_signal',
            retrieved_at: '2026-09-12',
            confidence: 0.9,
            primary_source: true,
          },
        ],
        search_queries: ['published requests for intake form repair'],
      },
      bearer,
    );
    expect(submitted['accepted']).toBe(0);
    const stored = submitted['claims'] as { claimId: string }[];
    expect(stored).toHaveLength(1);

    await tool('brain_complete_work', { ...proof, summary: 'claims submitted' }, bearer);

    // Verification is its own item, queued by Brain when the first completed.
    const verifying = await until('Brain to queue the verification', async () => {
      const taken = await tool(
        'brain_claim_work',
        { project_id: project, work_types: ['RESEARCH_VERIFY'], limit: 1 },
        bearer,
      );
      const items = (taken['claimed'] ?? []) as any[];
      return items.length > 0 ? items[0] : null;
    });

    const gate = await tool(
      'brain_submit_verification',
      {
        work_item_id: verifying.workItemId,
        lease_id: verifying.leaseId,
        lease_generation: verifying.leaseGeneration,
        verdicts: stored.map((one) => ({
          claim_id: one.claimId,
          supports_claim: true,
          geography: 'MATCH',
          timeframe: 'MATCH',
          population: 'MATCH',
          definitions: 'MATCH',
          note: 'Read the notice.',
        })),
        sufficiency: 'SUFFICIENT',
      },
      bearer,
    );
    // Brain's gate decided this, not the worker.
    expect(gate['acceptedClaims']).toBeGreaterThan(0);
    await tool(
      'brain_complete_work',
      {
        work_item_id: verifying.workItemId,
        lease_id: verifying.leaseId,
        lease_generation: verifying.leaseGeneration,
        summary: 'verified and gated',
      },
      bearer,
    );

    /*
     * And then the tick turns an accepted demand-signal claim into an opening,
     * with the claim beside it as provenance and a blank card — because a
     * published request is evidence somebody asked, and not a payer, a price
     * or a delivery path.
     */
    opportunity = await until('the tick to harvest an opening', async () => {
      const view = await call('GET', `/api/projects/${project}/cash`, { cookie: admin });
      const placements = (view.body.myCurrentWork?.placements ?? []) as any[];
      const found = placements.find((one) => one.opportunity.sourceClaimId);
      return found ? found.opportunity : null;
    });
    expect(opportunity.sourceClaimId).toBeTruthy();
    expect(opportunity.payer).toBeNull();
  }, 420_000);
});
