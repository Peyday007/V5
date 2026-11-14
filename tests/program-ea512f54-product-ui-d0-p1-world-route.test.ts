/**
 * The world's read model, against a real booted server (UI-27-2).
 *
 * Rows are written straight into the server's own database, exactly as the
 * queue, the bins and the ledger would have written them, and the route is read
 * over HTTP. What is proved: the answer is drawn from those rows; WORKING needs
 * a live lease with a heartbeat while queued, held, expired and failed jobs keep
 * their own states; money stays in separate classes with sources and a pipeline
 * is never received; every fact carries an href and a change time, and what is
 * missing is named; and the door is the project routes' own — anonymous 401, a
 * machine and an outsider the same 404 body as a project that does not exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickPort } from './helpers/ports.ts';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaseIsLive, campaignState, researchState, opportunityState, invoiceState, WORLD_STATES, goalWorldState, goalProgress } from '../server/routes/world.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = pickPort(8900, 100);
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
let aliveWorker = '';
let goneWorker = '';

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

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3_600_000;

function seed(): void {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'brain.db'));
  try {
    const now = iso(0);
    const item = db.prepare(
      `INSERT INTO work_items (id, project_id, work_type, state, available_at, lease_id, worker_id, leased_at, heartbeat_at, lease_expires_at, failure_category, created_by_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HUMAN', ?, ?)`,
    );
    // A live lease with a heartbeat: the only thing that may be WORKING.
    item.run('wi_live', project, 'RESEARCH_FRAGMENT', 'LEASED', now, 'wls_live', aliveWorker, iso(-HOUR / 6), iso(-60_000), iso(HOUR), null, now, now);
    // A lease that ran out and nobody reclaimed: unverified, never busy.
    item.run('wi_expired', project, 'RESEARCH_FRAGMENT', 'LEASED', now, 'wls_old', goneWorker, iso(-3 * HOUR), iso(-2 * HOUR), iso(-HOUR), null, now, now);
    item.run('wi_queued', project, 'RESEARCH_FRAGMENT', 'QUEUED', now, null, null, null, null, null, null, now, now);
    item.run('wi_failed', project, 'RESEARCH_FRAGMENT', 'FAILED', now, null, null, null, null, null, 'PERMANENT', now, now);

    db.prepare(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, paused_at, paused_reason, created_at, updated_at) VALUES ('wst_x', ?, 'A paused goal', 'i', 'CAPABILITY', ?, 'owner paused it', ?, ?)`,
    ).run(project, now, now, now);
    // An open goal nobody has pointed at any work: the goal model says so, and the world must too.
    db.prepare(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at) VALUES ('wst_open', ?, 'An open goal', 'i', 'CAPABILITY', ?, ?)`,
    ).run(project, now, now);
    const bin = db.prepare(
      `INSERT INTO bins (id, project_id, kind, title, objective, completion_contract, state, held_by_workstream_id, held_reason, created_by_type, created_at, updated_at)
       VALUES (?, ?, 'FACTORY_UNITS', ?, 'o', 'FACTORY_UNITS_V1', ?, ?, ?, 'HUMAN', ?, ?)`,
    );
    bin.run('bin_ready', project, 'A ready bin', 'READY', null, null, now, now);
    bin.run('bin_held', project, 'A held bin', 'READY', 'wst_x', 'GOAL_PAUSED', now, now);
    bin.run('bin_human', project, 'A bin needing a person', 'NEEDS_HUMAN', null, null, now, now);

    const money = db.prepare(
      `INSERT INTO cash_money_entries (id, project_id, kind, amount_cents, currency, occurred_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`,
    );
    money.run('cme_paid', project, 'CUSTOMER_PAYMENT', 12_000, 'USD', now, now);
    money.run('cme_agreed', project, 'PIPELINE_AGREED', 90_000, 'USD', now, now);
    money.run('cme_cost', project, 'COST', 3_000, 'USD', now, now);
    money.run('cme_eur', project, 'CUSTOMER_PAYMENT', 500, 'EUR', now, now);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-world-'));
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

  const worker = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', { cookie: adminCookie, body: { name: 'a-world-worker', displayName: 'World' } });
  await call('POST', `/api/admin/projects/${project}/members`, {
    cookie: adminCookie,
    body: { principalId: worker.body.worker.id, principalType: 'WORKER', scopes: ['project:read', 'work:claim'] },
  });
  const issued = await call<{ secret: string }>('POST', `/api/admin/workers/${worker.body.worker.id}/credentials`, { cookie: adminCookie, body: {} });
  workerBearer = issued.body.secret;
  aliveWorker = worker.body.worker.id;
  const second = await call<{ worker: { id: string } }>('POST', '/api/admin/workers', { cookie: adminCookie, body: { name: 'a-gone-worker', displayName: 'Gone' } });
  goneWorker = second.body.worker.id;

  seed();
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

const WORLD = () => `/api/projects/${project}/world`;

describe('the door is the project routes\' own', () => {
  it('refuses an anonymous caller', async () => {
    expect((await call('GET', WORLD())).status).toBe(401);
  });

  it('answers an outsider and a machine exactly as it answers a project that does not exist', async () => {
    const real = await call('GET', WORLD(), { cookie: outsiderCookie });
    const invented = await call('GET', '/api/projects/prj_does_not_exist/world', { cookie: outsiderCookie });
    expect(real.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(real.text).toBe(invented.text);
    expect(real.text).not.toContain(project);
    const machine = await call('GET', WORLD(), { bearer: workerBearer });
    expect(machine.status).toBe(404);
  });

  it('changes nothing: the route has no write verb', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call(method, WORLD(), { cookie: memberCookie, body: {} })).status).toBe(404);
    }
  });
});

describe('the world is drawn from real rows', () => {
  it('carries the contract version and the generation time', async () => {
    const r = await call('GET', WORLD(), { cookie: memberCookie });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(Date.parse(r.body.generatedAt)).toBeGreaterThan(0);
    expect(r.body.projectId).toBe(project);
    expect(r.body.viewer.canRead).toBe(true);
  });

  it('WORKING only with a live lease and heartbeat; queued, expired, failed and held keep their own states', async () => {
    const { body } = await call('GET', WORLD(), { cookie: memberCookie });
    const byId = new Map<string, any>(body.facts.map((f: any) => [f.recordId, f]));
    expect(byId.get('wi_live').state).toBe('WORKING');
    expect(byId.get('wi_expired').state).toBe('UNKNOWN');
    expect(byId.get('wi_expired').blocker).toMatch(/unverified/);
    expect(byId.get('wi_queued').state).toBe('WAITING');
    expect(byId.get('wi_failed').state).toBe('FAILED');
    expect(byId.get('bin_ready').state).toBe('WAITING');
    expect(byId.get('bin_held').state).toBe('BLOCKED');
    expect(byId.get('bin_human').state).toBe('NEEDS_APPROVAL');
    for (const f of body.facts) expect(WORLD_STATES).toContain(f.state);
    const working = body.facts.filter((f: any) => f.state === 'WORKING').map((f: any) => f.recordId);
    // The live unit, and the one worker whose live lease proves it.
    expect(working.sort()).toEqual(['wi_live', aliveWorker].sort());
  });

  it('counts only workers holding a live lease', async () => {
    const { body } = await call('GET', WORLD(), { cookie: memberCookie });
    expect(body.workingCount).toBe(1);
    const states = Object.fromEntries(body.workers.map((w: any) => [w.workerId, w.state]));
    expect(states).toEqual({ [aliveWorker]: 'WORKING', [goneWorker]: 'UNKNOWN' });
  });

  it('every fact and explanation links to a record and says when it changed, and names what is missing', async () => {
    const { body } = await call('GET', WORLD(), { cookie: memberCookie });
    expect(body.facts.length).toBeGreaterThan(0);
    for (const f of body.facts) {
      expect(typeof f.href).toBe('string');
      expect(f.href.startsWith('/api/')).toBe(true);
      expect(f.source.table).toBeTruthy();
      expect(['FRESH', 'STALE', 'MISSING']).toContain(f.freshness);
      expect(Array.isArray(f.missing)).toBe(true);
      if (!f.startedAt) expect(f.missing).toContain('startedAt');
      if (!f.owner) expect(f.missing).toContain('owner');
    }
    expect(body.facts.find((f: any) => f.recordId === 'wi_queued').missing).toEqual(expect.arrayContaining(['owner', 'startedAt']));
    expect(body.explanations.length).toBeGreaterThan(0);
    for (const e of body.explanations) {
      expect(e.href).toBeTruthy();
      expect(e.recordId).toBeTruthy();
      expect('lastChangedAt' in e).toBe(true);
    }
    expect(body.explanations.map((e: any) => e.recordId)).toEqual(expect.arrayContaining(['bin_held', 'bin_human', 'wi_failed']));
  });
});

describe('money stays in its classes', () => {
  it('keeps every class separate, with ledger sources, and never sums across them or across currencies', async () => {
    const { body } = await call('GET', WORLD(), { cookie: memberCookie });
    const classes = body.money.map((m: any) => m.class);
    expect(classes).toEqual(['received', 'due', 'spent', 'reserved', 'invested', 'transferred', 'projected', 'simulated']);
    const of = (cls: string) => body.money.find((m: any) => m.class === cls);
    expect(of('received').lines.map((l: any) => [l.kind, l.currency, l.amountCents]).sort()).toEqual([
      ['CUSTOMER_PAYMENT', 'EUR', 500],
      ['CUSTOMER_PAYMENT', 'USD', 12_000],
    ]);
    expect(of('projected').lines.map((l: any) => [l.kind, l.amountCents])).toEqual([['PIPELINE_AGREED', 90_000]]);
    expect(of('spent').lines.map((l: any) => [l.kind, l.amountCents])).toEqual([['COST', 3_000]]);
    for (const m of body.money) {
      for (const l of m.lines) {
        expect(l.source.table).toBeTruthy();
        expect('total' in l).toBe(false);
      }
      expect('total' in m).toBe(false);
    }
  });

  it('never labels a projected or simulated amount received, and an empty class says why rather than reading zero', async () => {
    const { body } = await call('GET', WORLD(), { cookie: memberCookie });
    const received = body.money.find((m: any) => m.class === 'received');
    expect(received.lines.every((l: any) => l.kind === 'CUSTOMER_PAYMENT')).toBe(true);
    const simulated = body.money.find((m: any) => m.class === 'simulated');
    expect(simulated.lines).toEqual([]);
    expect(simulated.missing).toMatch(/ledger/);
    const reserved = body.money.find((m: any) => m.class === 'reserved');
    expect(reserved.lines).toEqual([]);
    expect(reserved.missing).toBeTruthy();
  });
});

describe('state mappings, one record word at a time', () => {
  it('a lease with no heartbeat, or past its expiry, is not live', () => {
    const now = Date.now();
    expect(leaseIsLive({ leaseId: 'l', heartbeatAt: null, leaseExpiresAt: iso(HOUR) }, now)).toBe(false);
    expect(leaseIsLive({ leaseId: 'l', heartbeatAt: iso(0), leaseExpiresAt: iso(-1) }, now)).toBe(false);
    expect(leaseIsLive({ leaseId: null, heartbeatAt: iso(0), leaseExpiresAt: iso(HOUR) }, now)).toBe(false);
    expect(leaseIsLive({ leaseId: 'l', heartbeatAt: iso(0), leaseExpiresAt: iso(HOUR) }, now)).toBe(true);
  });

  it('active research and campaigns are WORKING only with a live lease', () => {
    expect(researchState('RESEARCHING', false)).toBe('WAITING');
    expect(researchState('RESEARCHING', true)).toBe('WORKING');
    expect(researchState('AWAITING_APPROVAL', true)).toBe('NEEDS_APPROVAL');
    expect(researchState('COMPLETE_WITH_GAPS', false)).toBe('BLOCKED');
    expect(campaignState('EXECUTING', false)).toBe('WAITING');
    expect(campaignState('EXECUTING', true)).toBe('WORKING');
    expect(campaignState('BLOCKED', true)).toBe('BLOCKED');
  });

  it('an offer is not a sale and an issued invoice is not cash', () => {
    for (const s of ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING']) expect(opportunityState(s)).toBe('WAITING');
    expect(opportunityState('COLLECTED')).toBe('SUCCEEDED');
    expect(invoiceState('ISSUED')).toBe('WAITING');
    expect(invoiceState('UNCERTAIN')).toBe('UNKNOWN');
    expect(invoiceState('PAID')).toBe('SUCCEEDED');
  });
});

describe('a goal reads its state and progress from the goal model', () => {
  it('an open goal is not UNKNOWN with progress missing; it carries the goal model\'s derivation', async () => {
    const { body } = await call('GET', WORLD(), { cookie: memberCookie });
    const goals = body.facts.filter((f: any) => f.kind === 'GOAL');
    expect(goals.map((g: any) => g.recordId)).toEqual(expect.arrayContaining(['wst_x', 'wst_open']));
    for (const g of goals) {
      expect(g.missing).not.toContain('progress (read at the goal record)');
      expect(typeof g.progress).toBe('string');
      expect(g.progress.length).toBeGreaterThan(0);
    }
    const open = goals.find((g: any) => g.recordId === 'wst_open');
    const fromModel = await call('GET', '/api/goals/wst_open', { cookie: memberCookie });
    expect(fromModel.status).toBe(200);
    expect(open.recordState.startsWith(fromModel.body.goal.lifecycle)).toBe(true);
    expect(open.progress).toContain(fromModel.body.goal.lifecycleReason);
    expect(open.nextAction).toBe(fromModel.body.goal.next.action);
    expect(open.state).not.toBe('UNKNOWN');
    const paused = goals.find((g: any) => g.recordId === 'wst_x');
    expect(paused.state).toBe('BLOCKED');
    expect(paused.blocker).toContain('owner paused it');
  });

  it('maps every derived goal reading to a state that is true of it', () => {
    const base = {
      lifecycle: 'ACTIVE' as const,
      lifecycleReason: 'r',
      state: 'UNKNOWN' as const,
      stateEvidence: 'e',
      waiting: { kind: 'NOTHING' as const, detail: '', since: null },
      work: [] as any[],
      blockers: [] as any[],
      decisions: [] as any[],
      target: null,
      pausedReason: null,
      cancelledReason: null,
    };
    expect(goalWorldState({ ...base, lifecycle: 'COMPLETE' }).state).toBe('SUCCEEDED');
    expect(goalWorldState({ ...base, lifecycle: 'CANCELLED' }).state).toBe('IDLE');
    expect(goalWorldState({ ...base, lifecycle: 'PAUSED', pausedReason: 'x' })).toEqual({ state: 'BLOCKED', blocker: 'paused: x' });
    expect(goalWorldState({ ...base, waiting: { kind: 'PERSON', detail: 'answer it', since: null } }).state).toBe('NEEDS_APPROVAL');
    expect(goalWorldState({ ...base, blockers: [{ text: 'b' }] as any[] }).state).toBe('BLOCKED');
    // Queued work is waiting; only a worker holding a live lease makes a goal WORKING.
    expect(goalWorldState({ ...base, state: 'IN_PROGRESS', work: [{ workerOnIt: false }] as any[] }).state).toBe('WAITING');
    expect(goalWorldState({ ...base, state: 'IN_PROGRESS', work: [{ workerOnIt: true }] as any[] }).state).toBe('WORKING');
    expect(goalWorldState({ ...base, state: 'VERIFIED_LIVE' }).state).toBe('SUCCEEDED');
    expect(goalWorldState({ ...base, waiting: { kind: 'NOTHING_LINKED', detail: '', since: null } }).state).toBe('IDLE');
    expect(goalWorldState({ ...base, waiting: { kind: 'CAPACITY', detail: '', since: null } }).state).toBe('WAITING');
    expect(goalWorldState(base).state).toBe('UNKNOWN');
    expect(goalProgress({ ...base, state: 'IN_PROGRESS' })).toContain('register IN_PROGRESS (e)');
  });
});
