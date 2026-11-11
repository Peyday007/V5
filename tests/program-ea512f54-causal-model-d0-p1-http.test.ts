/**
 * The causal graph's door, against a real booted server (CAUSAL-14-4).
 *
 * The model tests prove the arithmetic; this proves the routes answer from the
 * graph, refuse a figure with no lineage, keep every claim version, and are
 * behind the gate: an anonymous caller is 401, a machine and a non-member get the
 * same 404 with the same body as a project that does not exist.
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
const PORT = pickPort(8500, 100);
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let dataDir = '';
let serverLog = '';

const ADMIN_EMAIL = 'root@example.invalid';
const BOOTSTRAP_PASSWORD = 'bootstrap-password-01';
const ADMIN_PASSWORD = 'administrator-password-01';
const MEMBER_PASSWORD = 'member-password-000001';
const OUTSIDER_PASSWORD = 'outsider-password-00001';

let adminCookie = '';
let memberCookie = '';
let outsiderCookie = '';
let workerBearer = '';
let project = '';

interface Result<T = any> {
  status: number;
  body: T;
  text: string;
}

async function call<T = any>(method: string, route: string, options: { cookie?: string; bearer?: string; body?: unknown } = {}): Promise<Result<T>> {
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

async function makePerson(email: string, password: string): Promise<string> {
  const created = await call<{ user: { id: string } }>('POST', '/api/admin/users', {
    cookie: adminCookie,
    body: { email, displayName: email, password: 'temporary-password-01' },
  });
  const first = await signIn(email, 'temporary-password-01');
  await call('POST', '/api/auth/password', { cookie: first, body: { currentPassword: 'temporary-password-01', newPassword: password } });
  return created.body.user.id;
}

async function startServer(): Promise<void> {
  server = spawn(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'server', 'index.ts')], {
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
  });
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

const CAUSAL = (): string => `/api/projects/${project}/causal`;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-causal-'));
  await startServer();
  const bootstrapCookie = await signIn(ADMIN_EMAIL, BOOTSTRAP_PASSWORD);
  await call('POST', '/api/auth/password', { cookie: bootstrapCookie, body: { currentPassword: BOOTSTRAP_PASSWORD, newPassword: ADMIN_PASSWORD } });
  adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const seeded = await call<{ projects: { id: string }[] }>('GET', '/api/projects', { cookie: adminCookie });
  project = seeded.body.projects[0]!.id;

  const memberId = await makePerson('member@example.invalid', MEMBER_PASSWORD);
  memberCookie = await signIn('member@example.invalid', MEMBER_PASSWORD);
  await call('POST', `/api/admin/projects/${project}/members`, { cookie: adminCookie, body: { principalId: memberId, principalType: 'HUMAN', role: 'MEMBER' } });
  await makePerson('outsider@example.invalid', OUTSIDER_PASSWORD);
  outsiderCookie = await signIn('outsider@example.invalid', OUTSIDER_PASSWORD);

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', { cookie: adminCookie, body: { name: 'a-causal-worker', displayName: 'Causal' } });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: worker.body.worker.id, principalType: 'WORKER', scopes: ['project:read', 'work:claim', 'work:complete', 'research:propose', 'external:sync'] },
  });
  const issued = await call<{ secret: string }>('POST', `/api/admin/workers/${worker.body.worker.id}/credentials`, { cookie: adminCookie, body: {} });
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

const fig = (value: number | null, status: string, extra: Record<string, unknown> = {}) => ({ value, status, source: status === 'UNKNOWN' ? undefined : 'ledger', ...extra });

const GRAPH = () => ({
  subject: 'a service',
  nodes: [
    { id: 'p', type: 'payer', label: 'Payer' },
    { id: 'o', type: 'offer', label: 'Offer' },
    { id: 'c', type: 'channel', label: 'Channel' },
  ],
  relations: [
    { id: 'r1', type: 'pays', from: 'p', to: 'o' },
    { id: 'r2', type: 'delivers', from: 'o', to: 'c' },
  ],
  actions: [
    { id: 'a1', label: 'Send invoice', actor: 'owner', permissions: ['none'], effect: 'invoice issued', timing: 'within 2 days', evidence: ['signed order'], completionCondition: 'invoice delivered', prerequisites: [] },
  ],
  routes: [
    {
      id: 'rt', payer: 'Acme', for: 'service', terms: 'net 30', channel: 'direct', invoicedAt: '2026-11-01', collectedAt: '2026-12-01',
      collectedCents: fig(100_000, 'OBSERVED'),
      heldAgainstCents: fig(20_000, 'CONTRACTED'),
      outflows: [{ to: 'supplier', reason: 'cost', amountCents: 30_000, at: '2026-11-15' }, { to: 'tax', reason: 'tax', amountCents: 5_000, at: null }],
    },
  ],
});

const CHAIN = () => ({
  startUnits: 1000,
  stages: [
    { name: 'reach', yield: { value: 0.5, status: 'OBSERVED', source: 's', unit: 'share' } },
    { name: 'buy', yield: { value: 0.1, status: 'OBSERVED', source: 's', unit: 'share' }, capacity: { value: 30, status: 'OBSERVED', source: 's', unit: 'units' } },
  ],
});

describe('who can reach the causal routes', () => {
  const routes = (): { method: string; route: string }[] => [
    { method: 'POST', route: `${CAUSAL()}/account` },
    { method: 'POST', route: `${CAUSAL()}/trace` },
    { method: 'POST', route: `${CAUSAL()}/claim` },
    { method: 'POST', route: `${CAUSAL()}/money-path` },
    { method: 'POST', route: `${CAUSAL()}/what-if` },
    { method: 'POST', route: `${CAUSAL()}/chain` },
    { method: 'POST', route: `${CAUSAL()}/decompose` },
    { method: 'POST', route: `${CAUSAL()}/construct` },
    { method: 'POST', route: `${CAUSAL()}/portfolio` },
    { method: 'POST', route: `${CAUSAL()}/graphs/k` },
    { method: 'GET', route: `${CAUSAL()}/graphs/k` },
  ];

  it('refuses an anonymous caller everywhere', async () => {
    for (const { method, route } of routes()) {
      const r = await call(method, route, method === 'GET' ? {} : { body: {} });
      expect(r.status, route).toBe(401);
    }
  });

  it('refuses a machine by principal type, as a 404, however it is scoped', async () => {
    for (const { method, route } of routes()) {
      const r = await call(method, route, method === 'GET' ? { bearer: workerBearer } : { bearer: workerBearer, body: {} });
      expect(r.status, route).toBe(404);
    }
  });

  it('gives a non-member the same 404 with the same body as a project that does not exist', async () => {
    for (const suffix of ['account', 'chain', 'decompose']) {
      const real = await call('POST', `${CAUSAL()}/${suffix}`, { cookie: outsiderCookie, body: { graph: GRAPH() } });
      const invented = await call('POST', `/api/projects/prj_does_not_exist/causal/${suffix}`, { cookie: outsiderCookie, body: { graph: GRAPH() } });
      expect(real.status, suffix).toBe(404);
      expect(invented.status, suffix).toBe(404);
      expect(real.text, suffix).toBe(invented.text);
    }
    const realGet = await call('GET', `${CAUSAL()}/graphs/k`, { cookie: outsiderCookie });
    const inventedGet = await call('GET', '/api/projects/prj_does_not_exist/causal/graphs/k', { cookie: outsiderCookie });
    expect([realGet.status, inventedGet.status]).toEqual([404, 404]);
    expect(realGet.text).toBe(inventedGet.text);
  });

  it('lets a project member read an account', async () => {
    const r = await call(`POST`, `${CAUSAL()}/account`, { cookie: memberCookie, body: { graph: GRAPH() } });
    expect(r.status).toBe(200);
  });
});

describe('account, trace and claim', () => {
  it('presents the whole graph and names what is unstated as research, never as done', async () => {
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: GRAPH() } });
    expect(r.status).toBe(200);
    expect(r.body.account.nodes).toHaveLength(3);
    expect(r.body.account.actions).toHaveLength(1);
    expect(r.body.account.routes[0].freeCents.value).toBe(45_000);
    expect(r.body.needs).toEqual([
      { subject: 'route rt: when tax is paid', question: 'What is the when tax is paid for route rt, and what evidences it?', route: 'RESEARCH', permissions: [] },
    ]);
    // Sent to an owner that acts on it, not merely named: a need in the review, written once
    // (an earlier request in this file may already have sent this graph's need).
    expect(r.body.sent).toEqual([{ subject: 'route rt: when tax is paid', sent: true, to: 'REVIEW_NEED', ref: expect.stringMatching(/^cnd_/), created: expect.any(Boolean) }]);
    const again = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: GRAPH() } });
    expect(again.body.sent).toEqual([{ ...r.body.sent[0], created: false }]);
  });

  it('a research need goes onto a named orchestration only when it is this project’s', async () => {
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: GRAPH(), orchestrationId: 'orc_absent' } });
    expect(r.status).toBe(404);
  });

  it('an action that needs a permission is a need for authorized action', async () => {
    const graph = GRAPH();
    graph.actions[0]!.permissions = ['billing:write'];
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph } });
    expect(r.body.needs.find((n: { route: string }) => n.route === 'AUTHORIZED_ACTION')).toMatchObject({ subject: 'action a1', permissions: ['billing:write'] });
    expect(r.body.sent.find((n: { subject: string }) => n.subject === 'action a1')).toMatchObject({ sent: true, to: 'REVIEW_NEED' });
  });

  it('an unknown claim is a research need', async () => {
    const graph = { ...GRAPH(), claims: [{ key: 'conversion', figure: { meaning: 'conversion', unit: 'share', status: 'UNKNOWN', value: null } }] };
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph } });
    expect(r.body.needs.map((n: { subject: string }) => n.subject)).toContain('claim conversion');
  });

  it('traces forward and backward', async () => {
    const forward = await call('POST', `${CAUSAL()}/trace`, { cookie: adminCookie, body: { graph: GRAPH(), from: 'p' } });
    expect(forward.body.trace.reached.map((x: { node: { id: string } }) => x.node.id)).toEqual(['o', 'c']);
    const backward = await call('POST', `${CAUSAL()}/trace`, { cookie: adminCookie, body: { graph: GRAPH(), from: 'c', direction: 'backward', maxDepth: 1 } });
    expect(backward.body.trace.reached.map((x: { node: { id: string } }) => x.node.id)).toEqual(['o']);
  });

  it('refuses a bad direction, a bad depth, and a node that is not there', async () => {
    expect((await call('POST', `${CAUSAL()}/trace`, { cookie: adminCookie, body: { graph: GRAPH(), from: 'p', direction: 'sideways' } })).status).toBe(400);
    expect((await call('POST', `${CAUSAL()}/trace`, { cookie: adminCookie, body: { graph: GRAPH(), from: 'p', maxDepth: 0 } })).status).toBe(400);
    expect((await call('POST', `${CAUSAL()}/trace`, { cookie: adminCookie, body: { graph: GRAPH(), from: 'zzz' } })).status).toBe(422);
  });

  it('returns the history of a claim and what replaced what', async () => {
    const graph = {
      ...GRAPH(),
      claims: [
        { key: 'price', figure: fig(10, 'OBSERVED') },
        { key: 'price', figure: fig(12, 'OBSERVED'), reason: 'new quote' },
      ],
    };
    const r = await call('POST', `${CAUSAL()}/claim`, { cookie: adminCookie, body: { graph, key: 'price' } });
    expect(r.status).toBe(200);
    expect(r.body.history.map((v: { figure: { value: number } }) => v.figure.value)).toEqual([10, 12]);
    expect(r.body.current.reason).toBe('new quote');
    expect((await call('POST', `${CAUSAL()}/claim`, { cookie: adminCookie, body: { graph, key: 'absent' } })).status).toBe(422);
  });
});

describe('a figure with no lineage is refused at the door', () => {
  it('refuses a figure with a value and no source', async () => {
    const graph = GRAPH();
    graph.routes[0]!.collectedCents = { value: 5, status: 'OBSERVED' } as never;
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph } });
    expect(r.status).toBe(422);
    expect(r.text).toContain('source');
  });

  it('refuses bounds on an assumed figure, and an unknown status', async () => {
    const bounded = GRAPH();
    bounded.routes[0]!.collectedCents = fig(5, 'ASSUMED', { bounds: { low: 1, high: 9 } }) as never;
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: bounded } })).status).toBe(422);
    const odd = GRAPH();
    odd.routes[0]!.collectedCents = fig(5, 'HOPED') as never;
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: odd } })).status).toBe(400);
  });

  it('an absent figure is unknown, never zero', async () => {
    const graph = GRAPH();
    delete (graph.routes[0] as Record<string, unknown>).heldAgainstCents;
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph } });
    expect(r.body.account.routes[0].freeCents.value).toBeNull();
    expect(r.body.needs.map((n: { subject: string }) => n.subject)).toContain('route rt: amount held against refund or fulfilment');
  });

  it('refuses an incomplete action and an undeclared node type', async () => {
    const action = GRAPH();
    action.actions[0]!.evidence = [];
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: action } })).status).toBe(422);
    const node = GRAPH();
    node.nodes[0]!.type = 'made_up';
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: node } })).status).toBe(422);
    const declared = { ...GRAPH(), nodeTypes: [{ name: 'made_up', reason: 'the arrangement needs it' }] };
    declared.nodes[0]!.type = 'made_up';
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: declared } })).status).toBe(200);
  });

  it('refuses a body that is not shaped like a graph', async () => {
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: 'nope' } })).status).toBe(400);
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: { nodes: 'x' } } })).status).toBe(400);
  });
});

describe('money path and what-if', () => {
  it('shows who pays, who receives first, what is owed and what is free', async () => {
    const r = await call('POST', `${CAUSAL()}/money-path`, { cookie: adminCookie, body: { graph: GRAPH() } });
    expect(r.status).toBe(200);
    const route = r.body.routes[0];
    expect(route).toMatchObject({ id: 'rt', payer: 'Acme', terms: 'net 30', channel: 'direct' });
    expect(route.receivesFirst).toMatchObject({ to: 'supplier' });
    expect(route.owedAfterward).toHaveLength(2);
    expect(route.reading.freeCents.value).toBe(45_000);
  });

  it('refuses a route that is not there or a graph with none', async () => {
    expect((await call('POST', `${CAUSAL()}/money-path`, { cookie: adminCookie, body: { graph: GRAPH(), route: 'zzz' } })).status).toBe(422);
    expect((await call('POST', `${CAUSAL()}/money-path`, { cookie: adminCookie, body: { graph: { subject: 'empty' } } })).status).toBe(422);
  });

  it('propagates a changed assumption and shows before, after and the delta', async () => {
    const r = await call('POST', `${CAUSAL()}/what-if`, {
      cookie: adminCookie,
      body: { graph: GRAPH(), changes: [{ kind: 'route', routeId: 'rt', set: { collectedCents: fig(60_000, 'OBSERVED'), payer: 'Other' } }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.before.routes[0].freeCents.value).toBe(45_000);
    expect(r.body.after.routes[0].freeCents.value).toBe(5_000);
    expect(r.body.changed.routes[0]).toMatchObject({ freeCentsBefore: 45_000, freeCentsAfter: 5_000, freeCentsDelta: -40_000 });
  });

  it('a change that opens a different route is a branch beside the original', async () => {
    const r = await call('POST', `${CAUSAL()}/what-if`, {
      cookie: adminCookie,
      body: { graph: GRAPH(), changes: [{ kind: 'route', routeId: 'rt', set: { payer: 'Partner', terms: 'prepaid' }, asBranch: 'rt-prepaid' }] },
    });
    expect(r.body.branches).toEqual(['rt-prepaid']);
    expect(r.body.after.routes.map((x: { route: string }) => x.route).sort()).toEqual(['rt', 'rt-prepaid']);
    expect(r.body.before.routes).toHaveLength(1);
  });

  it('added volume goes to the constraint that caps sales', async () => {
    const r = await call('POST', `${CAUSAL()}/what-if`, { cookie: adminCookie, body: { graph: GRAPH(), chain: CHAIN(), changes: [{ kind: 'volume', addUnits: 1000 }] } });
    expect(r.body.changed.bindingConstraintBefore).toBe('buy');
    expect(r.body.changed.outputUnitsBefore).toBe(30);
    expect(r.body.changed.outputUnitsAfter).toBe(30);
    expect(r.body.changed.bindingConstraintAfter).toBe('buy');
  });

  it('raising the cap lets the volume through', async () => {
    const r = await call('POST', `${CAUSAL()}/what-if`, {
      cookie: adminCookie,
      body: { graph: GRAPH(), chain: CHAIN(), changes: [{ kind: 'stage', stage: 'buy', set: { capacity: { value: 500, status: 'ASSUMED', source: 'owner', unit: 'units' } } }] },
    });
    expect(r.body.changed.outputUnitsBefore).toBe(30);
    expect(r.body.changed.outputUnitsAfter).toBeCloseTo(50);
  });

  it('added spend with no stated rate does not buy volume at the old rate: the output is unknown', async () => {
    const r = await call('POST', `${CAUSAL()}/what-if`, { cookie: adminCookie, body: { graph: GRAPH(), chain: CHAIN(), changes: [{ kind: 'spend', cents: 100_000 }] } });
    expect(r.body.changed.outputUnitsAfter).toBeNull();
    expect(r.body.needs.map((n: { subject: string }) => n.subject)).toContain('stage reach bought by added spend');
    const known = await call('POST', `${CAUSAL()}/what-if`, {
      cookie: adminCookie,
      body: { graph: GRAPH(), chain: CHAIN(), changes: [{ kind: 'spend', cents: 1000, unitsPerCent: { value: 1, status: 'ASSUMED', source: 'owner' } }, { kind: 'stage', stage: 'buy', set: { capacity: { value: 1e6, status: 'ASSUMED', source: 'owner' } } }] },
    });
    expect(known.body.changed.outputUnitsAfter).toBeCloseTo(100);
  });

  it('refuses nothing to change, an unknown kind, a missing chain and a missing target', async () => {
    const post = (body: unknown) => call('POST', `${CAUSAL()}/what-if`, { cookie: adminCookie, body });
    expect((await post({ graph: GRAPH() })).status).toBe(400);
    expect((await post({ graph: GRAPH(), changes: [{ kind: 'wish' }], chain: CHAIN() })).status).toBe(400);
    expect((await post({ graph: GRAPH(), changes: [{ kind: 'volume', addUnits: 5 }] })).status).toBe(422);
    expect((await post({ graph: GRAPH(), changes: [{ kind: 'route', routeId: 'zzz' }] })).status).toBe(422);
    expect((await post({ graph: GRAPH(), chain: CHAIN(), changes: [{ kind: 'stage', stage: 'zzz' }] })).status).toBe(422);
  });
});

describe('chain', () => {
  it('passes volume through every stage and names the cap', async () => {
    const r = await call('POST', `${CAUSAL()}/chain`, { cookie: adminCookie, body: { chain: CHAIN() } });
    expect(r.status).toBe(200);
    expect(r.body.reading.outputUnits).toBe(30);
    expect(r.body.reading.bindingConstraint).toBe('buy');
    expect(r.body.reading.stages[1].capped).toBe(true);
  });

  it('an unknown stage is a need and its output is unknown', async () => {
    const chain = CHAIN();
    (chain.stages[0] as Record<string, unknown>).yield = null;
    const r = await call('POST', `${CAUSAL()}/chain`, { cookie: adminCookie, body: { chain } });
    expect(r.body.reading.outputUnits).toBeNull();
    expect(r.body.needs[0].subject).toBe('stage reach');
  });

  it('refuses a missing chain, a negative start, an unnamed stage and a bad saturation', async () => {
    const post = (body: unknown) => call('POST', `${CAUSAL()}/chain`, { cookie: adminCookie, body });
    expect((await post({})).status).toBe(400);
    expect((await post({ chain: { startUnits: -1, stages: [] } })).status).toBe(400);
    expect((await post({ chain: { startUnits: 1, stages: [{ yield: null }] } })).status).toBe(400);
    expect((await post({ chain: { startUnits: 1, stages: [{ name: 'x', yield: null, saturationHalfAt: 0 }] } })).status).toBe(400);
  });
});

describe('decompose', () => {
  it('starts every link UNKNOWN, as a vocabulary and not a checklist', async () => {
    const r = await call('POST', `${CAUSAL()}/decompose`, { cookie: adminCookie, body: { business: { name: 'x' } } });
    expect(r.status).toBe(200);
    expect(r.body.subproblems).toHaveLength(10);
    expect(r.body.subproblems.every((s: { status: string; observable: string }) => s.status === 'UNKNOWN' && s.observable.length > 0)).toBe(true);
  });

  it('drops a link the caller says does not apply, with the reason, and fixes its dependants', async () => {
    const r = await call('POST', `${CAUSAL()}/decompose`, { cookie: adminCookie, body: { business: { name: 'x' }, notApplicable: [{ id: 'access', reason: 'buyers come to us' }] } });
    expect(r.body.subproblems.map((s: { id: string }) => s.id)).not.toContain('access');
    expect(r.body.subproblems.find((s: { id: string }) => s.id === 'purchase').dependsOn).toEqual(['capability']);
    expect(r.body.notApplicable).toEqual([{ id: 'access', reason: 'buyers come to us' }]);
  });

  it('adds the caller’s own subproblems and refuses what is malformed', async () => {
    const post = (body: unknown) => call('POST', `${CAUSAL()}/decompose`, { cookie: adminCookie, body });
    const ok = await post({ business: { name: 'x' }, subproblems: [{ id: 'licence-slot', question: 'Is a slot free?', observable: 'a registry entry', dependsOn: ['demand'] }] });
    expect(ok.body.subproblems.at(-1)).toMatchObject({ id: 'licence-slot', origin: 'supplied', status: 'UNKNOWN' });
    expect((await post({})).status).toBe(400);
    expect((await post({ business: { name: 'x' }, notApplicable: [{ id: 'demand' }] })).status).toBe(400);
    expect((await post({ business: { name: 'x' }, notApplicable: [{ id: 'nope', reason: 'r' }] })).status).toBe(400);
    expect((await post({ business: { name: 'x' }, subproblems: [{ id: 'Bad Id', question: 'q', observable: 'o' }] })).status).toBe(400);
    expect((await post({ business: { name: 'x' }, subproblems: [{ id: 'demand', question: 'q', observable: 'o' }] })).status).toBe(400);
    expect((await post({ business: { name: 'x' }, subproblems: [{ id: 'new-one', question: 'q' }] })).status).toBe(400);
    expect((await post({ business: { name: 'x' }, subproblems: [{ id: 'new-one', question: 'q', observable: 'o', dependsOn: ['ghost'] }] })).status).toBe(422);
  });
});

describe('stored graphs keep every version', () => {
  const claim = (value: number, reason?: string) => ({ key: 'price', figure: fig(value, 'OBSERVED'), ...(reason ? { reason } : {}) });

  it('appends a version per store, carrying earlier claims forward', async () => {
    const first = await call('POST', `${CAUSAL()}/graphs/g1`, { cookie: adminCookie, body: { graph: { ...GRAPH(), claims: [claim(10)] } } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ key: 'g1', version: 1 });
    const second = await call('POST', `${CAUSAL()}/graphs/g1`, { cookie: adminCookie, body: { graph: { ...GRAPH(), claims: [claim(12)] }, reason: 'new quote' } });
    expect(second.body.version).toBe(2);

    const latest = await call('GET', `${CAUSAL()}/graphs/g1`, { cookie: adminCookie });
    expect(latest.body.version).toBe(2);
    expect(latest.body.versions.map((v: { reason: string }) => v.reason)).toEqual(['', 'new quote']);
    expect(latest.body.account.claims.price.map((v: { figure: { value: number } }) => v.figure.value)).toEqual([10, 12]);

    const old = await call('GET', `${CAUSAL()}/graphs/g1?version=1`, { cookie: adminCookie });
    expect(old.body.version).toBe(1);
    expect(old.body.account.claims.price).toHaveLength(1);
  });

  it('an unchanged claim adds no version, and an unreasoned replacement says so', async () => {
    await call('POST', `${CAUSAL()}/graphs/g2`, { cookie: adminCookie, body: { graph: { ...GRAPH(), claims: [claim(1)] } } });
    await call('POST', `${CAUSAL()}/graphs/g2`, { cookie: adminCookie, body: { graph: { ...GRAPH(), claims: [claim(1)] } } });
    const same = await call('GET', `${CAUSAL()}/graphs/g2`, { cookie: adminCookie });
    expect(same.body.account.claims.price).toHaveLength(1);
    expect(same.body.versions).toHaveLength(2);
    expect(same.body.versions[1].reason).toBe('replaced without a stated reason');
  });

  it('answers questions from a stored graph by its key, latest or a named version', async () => {
    const latest = await call('POST', `${CAUSAL()}/claim`, { cookie: adminCookie, body: { graphKey: 'g1', key: 'price' } });
    expect(latest.body.current.figure.value).toBe(12);
    const v1 = await call('POST', `${CAUSAL()}/claim`, { cookie: adminCookie, body: { graphKey: 'g1', graphVersion: 1, key: 'price' } });
    expect(v1.body.history).toHaveLength(1);
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graphKey: 'g1', graphVersion: 9 } })).status).toBe(404);
    expect((await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graphKey: 'never-stored' } })).status).toBe(404);
    expect((await call('GET', `${CAUSAL()}/graphs/never-stored`, { cookie: adminCookie })).status).toBe(404);
    expect((await call('GET', `${CAUSAL()}/graphs/g1?version=9`, { cookie: adminCookie })).status).toBe(404);
  });

  it('refuses to store something that is not a graph, or a lineage-less one, and stores nothing', async () => {
    expect((await call('POST', `${CAUSAL()}/graphs/g3`, { cookie: adminCookie, body: {} })).status).toBe(400);
    const bad = GRAPH();
    bad.routes[0]!.collectedCents = { value: 1, status: 'OBSERVED' } as never;
    expect((await call('POST', `${CAUSAL()}/graphs/g3`, { cookie: adminCookie, body: { graph: bad } })).status).toBe(422);
    expect((await call('GET', `${CAUSAL()}/graphs/g3`, { cookie: adminCookie })).status).toBe(404);
  });

  it('a graph stored in one project is not readable from another’s key space by a non-member', async () => {
    const r = await call('GET', `${CAUSAL()}/graphs/g1`, { cookie: outsiderCookie });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('price');
  });
});

describe('Brain constructs the graph and links graphs across businesses (CAUSAL-14-1)', () => {
  const SPARSE = (subject: string, supplier: string) => ({
    subject,
    actions: [
      { id: 'ship', label: 'Ship order', actor: 'Ops lead', permissions: ['carrier account'], effect: 'order shipped', timing: 'same day', evidence: ['order row'], completionCondition: 'tracking number issued', externalDependencies: ['Carrier API'], prerequisites: [] },
    ],
    routes: [
      { id: 'sale', payer: 'Retail buyer', for: `${subject} order`, terms: 'prepaid', channel: 'storefront', invoicedAt: '2026-11-01', collectedAt: '2026-11-01',
        collectedCents: fig(50_000, 'OBSERVED'), heldAgainstCents: fig(5_000, 'CONTRACTED'),
        outflows: [{ to: supplier, reason: 'goods', amountCents: 20_000, at: '2026-11-03' }] },
    ],
  });

  it('the account names what the graph implies but does not hold, without adding it', async () => {
    const r = await call('POST', `${CAUSAL()}/account`, { cookie: adminCookie, body: { graph: SPARSE('shop', 'Mill Co') } });
    expect(r.status).toBe(200);
    expect(r.body.account.nodes).toHaveLength(0);
    expect(r.body.discovered.some((d: any) => d.kind === 'node' && d.node.label === 'Mill Co')).toBe(true);
  });

  it('constructs the variables, declares a missing type with its reason, and stores the expanded graph', async () => {
    const r = await call('POST', `${CAUSAL()}/construct`, { cookie: adminCookie, body: { graph: SPARSE('shop', 'Mill Co'), storeAs: 'built' } });
    expect(r.status).toBe(200);
    const labels = r.body.account.nodes.map((n: any) => n.label);
    for (const label of ['Retail buyer', 'shop order', 'storefront', 'Mill Co', 'Ops lead', 'carrier account', 'Carrier API']) expect(labels).toContain(label);
    expect(r.body.account.nodeTypes.find((t: any) => t.name === 'payee').reason).toMatch(/outflow/);
    expect(r.body.discovered.every((d: any) => typeof d.because === 'string' && d.because.length > 0)).toBe(true);
    expect(r.body.stored).toEqual({ key: 'built', version: 1 });
    const again = await call('POST', `${CAUSAL()}/construct`, { cookie: adminCookie, body: { graphKey: 'built' } });
    expect(again.body.discovered).toEqual([]);
    const back = await call('POST', `${CAUSAL()}/trace`, { cookie: adminCookie, body: { graphKey: 'built', from: 'payee:mill-co', direction: 'backward' } });
    expect(back.body.trace.reached.map((x: any) => x.node.label)).toContain('Retail buyer');
  });

  it('finds a supplier two businesses share and traces its failure into both', async () => {
    const r = await call('POST', `${CAUSAL()}/portfolio`, {
      cookie: adminCookie,
      body: {
        subject: 'holdings',
        members: [{ graph: SPARSE('shop', 'Mill Co') }, { graph: SPARSE('wholesale', 'mill co') }],
        links: [{ from: { graph: 'shop', node: 'offer:shop-order' }, to: { graph: 'wholesale', node: 'offer:wholesale-order' }, type: 'depends_on' }],
        trace: { from: 'portfolio::payee:mill-co', direction: 'forward' },
      },
    });
    expect(r.status).toBe(200);
    const mill = r.body.shared.find((s: any) => s.label === 'Mill Co');
    expect(mill.members.sort()).toEqual(['shop::payee:mill-co', 'wholesale::payee:mill-co']);
    const reached = r.body.trace.reached.map((x: any) => x.node.id);
    expect(reached).toEqual(expect.arrayContaining(['shop::payee:mill-co', 'wholesale::payee:mill-co']));
    expect(r.body.links).toHaveLength(1);
    expect(r.body.account.routes.map((x: any) => x.route).sort()).toEqual(['shop::sale', 'wholesale::sale']);
  });

  it('refuses a portfolio of one, a repeated member, and a link to a node that is not there', async () => {
    const one = await call('POST', `${CAUSAL()}/portfolio`, { cookie: adminCookie, body: { members: [{ graph: SPARSE('shop', 'Mill Co') }] } });
    expect(one.status).toBe(400);
    const twice = await call('POST', `${CAUSAL()}/portfolio`, { cookie: adminCookie, body: { members: [{ graph: SPARSE('shop', 'A') }, { graph: SPARSE('shop', 'B') }] } });
    expect(twice.status).toBe(422);
    const dangling = await call('POST', `${CAUSAL()}/portfolio`, {
      cookie: adminCookie,
      body: { members: [{ graph: SPARSE('shop', 'A') }, { graph: SPARSE('wholesale', 'B') }], links: [{ from: { graph: 'shop', node: 'nope' }, to: { graph: 'wholesale', node: 'offer:wholesale-order' }, type: 'depends_on' }] },
    });
    expect(dangling.status).toBe(422);
  });
});
