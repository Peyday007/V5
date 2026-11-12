/**
 * The goals door, driven over a real socket.
 *
 * Three properties a service test cannot see, because each lives in the route:
 * a worker is refused by type, reads included; another operation's goal is the
 * same 404 with the same body as one that does not exist (invariant 23); and a
 * member who may read but not write a project cannot pause its goals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { goalsRouter } from '../server/routes/goals.ts';
import { createWorkstream } from '../server/repos/register.ts';
import type { Principal, ProjectRole } from '../server/domain/types.ts';

let projectId = '';
let otherProjectId = '';
let userId = '';
let workerId = '';
let server: Server | null = null;
let base = '';
let current: Principal | null = null;

function human(role: ProjectRole = 'ADMIN'): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_browser',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role,
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      },
    ],
    requestId: 'req',
  } as Principal;
}

function worker(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'a-worker',
    displayName: 'A worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cre_worker',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem-w',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: null,
        scopes: ['project:read', 'research:write'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      },
    ],
    requestId: 'req',
  } as Principal;
}

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  otherProjectId = (await createProject({ name: `Somebody else ${Math.random().toString(36).slice(2, 7)}` })).id;
  userId = (
    await createUser({
      email: `goals-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  workerId = (
    await createWorker({ name: `goals-worker-${Math.random().toString(36).slice(2, 8)}`, displayName: 'W', createdByType: 'SYSTEM', createdById: 'test' })
  ).id;
  current = human();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, { principal: current, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', goalsRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function goalIn(project: string, title: string) {
  return await createWorkstream({ projectId: project, title, intent: 'An outcome.', purpose: 'CAPABILITY', createdByUserId: userId });
}

describe('the goals door', () => {
  it('refuses a worker by type, reads included', async () => {
    const goal = await goalIn(projectId, 'Mine');
    current = worker();
    for (const [method, path, body] of [
      ['GET', '/api/goals', undefined],
      ['GET', `/api/goals/${goal.id}`, undefined],
      ['POST', `/api/goals/${goal.id}/pause`, { reason: 'x' }],
      ['POST', `/api/goals/${goal.id}/resume`, {}],
    ] as const) {
      const result = await call(method, path, body);
      expect(result.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(result.status).not.toBe(200);
    }
  });

  it('answers another operation’s goal exactly as it answers one that does not exist', async () => {
    const theirs = await goalIn(otherProjectId, 'Their private goal');
    const forbidden = await call('GET', `/api/goals/${theirs.id}`);
    const absent = await call('GET', '/api/goals/wst_doesnotexist0000000');
    expect(forbidden.status).toBe(404);
    expect(forbidden.text).toBe(absent.text);
    const pauseForbidden = await call('POST', `/api/goals/${theirs.id}/pause`, { reason: 'x' });
    const pauseAbsent = await call('POST', '/api/goals/wst_doesnotexist0000000/pause', { reason: 'x' });
    expect(pauseForbidden.text).toBe(pauseAbsent.text);

    const briefing = await call('GET', '/api/goals');
    expect(briefing.status).toBe(200);
    expect(briefing.text).not.toContain('Their private goal');
  });

  it('lets a reader read and not decide', async () => {
    const goal = await goalIn(projectId, 'Readable');
    current = human('VIEWER');
    expect((await call('GET', `/api/goals/${goal.id}`)).status).toBe(200);
    expect((await call('POST', `/api/goals/${goal.id}/pause`, { reason: 'x' })).status).toBe(404);
  });

  it('pauses, refuses a cycle, and reports what the decision will cause', async () => {
    const one = await goalIn(projectId, 'One');
    const two = await goalIn(projectId, 'Two');
    const paused = await call('POST', `/api/goals/${one.id}/pause`, { reason: 'later' });
    expect(paused.body.ok).toBe(true);
    expect(paused.body.consequence).toMatch(/holds every live bin/);
    expect((await call('POST', `/api/goals/${one.id}/depends-on`, { goalId: two.id })).status).toBe(200);
    const cycle = await call('POST', `/api/goals/${two.id}/depends-on`, { goalId: one.id });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toMatch(/wait on each other/);
  });
});

describe('the industry construction door (§92)', () => {
  const DETROIT = 'I want to enter last-mile logistics in Metro Detroit. I have $10,000-$30,000 available. I want to start generating revenue quickly, without personally making deliveries.';

  it('reads, replans under overrides, and records what operating taught', async () => {
    const goal = await createWorkstream({ projectId, title: 'Detroit', intent: DETROIT, purpose: 'LONG_TERM', createdByUserId: userId });
    const read = await call('GET', `/api/goals/${goal.id}/construction`);
    expect(read.status).toBe(200);
    expect(read.body.construction.decision.headline).toMatch(/^Enter as: /);
    expect(read.body.construction.execution.firstTransaction).toBeTruthy();

    const replan = await call('POST', `/api/goals/${goal.id}/construction`, { capitalLow: 500, capitalHigh: 900 });
    expect(replan.status).toBe(200);
    expect(replan.body.construction.intent.capital).toEqual({ low: 500, high: 900 });
    expect(replan.body.seeded).toBeNull();
    expect((await call('POST', `/api/goals/${goal.id}/construction`, { control: ['NOT_A_KIND'] })).status).toBe(400);

    const recorded = await call('POST', `/api/goals/${goal.id}/construction/facts`, { key: 'price_per_unit', segment: 'local_merchants', low: 15, high: 16, measures: 'quoted by a pharmacy' });
    expect(recorded.status).toBe(200);
    expect(recorded.body.fact.status).toBe('OBSERVED');
    expect(recorded.body.construction.learning.observed).toHaveLength(1);
    expect((await call('POST', `/api/goals/${goal.id}/construction/facts`, { key: 'made_up', low: 1, measures: 'x' })).status).toBe(400);
  });

  it('refuses a worker, lets a viewer read but not record, and hides another operation’s goal', async () => {
    const goal = await createWorkstream({ projectId, title: 'Detroit', intent: DETROIT, purpose: 'LONG_TERM', createdByUserId: userId });
    const theirs = await goalIn(otherProjectId, 'Theirs');
    expect((await call('GET', `/api/goals/${theirs.id}/construction`)).text).toBe((await call('GET', '/api/goals/wst_doesnotexist0000000/construction')).text);
    current = human('VIEWER');
    expect((await call('GET', `/api/goals/${goal.id}/construction`)).status).toBe(200);
    expect((await call('POST', `/api/goals/${goal.id}/construction/facts`, { key: 'price_per_unit', low: 1, measures: 'x' })).status).toBe(404);
    expect((await call('POST', `/api/goals/${goal.id}/construction`, { seed: true })).status).toBe(404);
    current = worker();
    expect((await call('GET', `/api/goals/${goal.id}/construction`)).status).toBeGreaterThanOrEqual(400);
  });
});

/*
 * The hosted verification is the only thing that proves this boundary against
 * production, and its first version skipped the comparison on every deploy:
 * it asked the verification administrator for a foreign goal, and that
 * administrator only administers the verification project. A skipped
 * comparison read as a pass. Nothing in the suite runs the harness, so the
 * guard reads it.
 */
describe('the hosted verification of the goals boundary', () => {
  it('is called, proves both halves against goals it files itself, and never touches a real one', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../scripts/verify-hosted.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/await goalsBoundary\(/);
    const start = source.indexOf('async function goalsBoundary');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\nasync function ', start + 10));
    // Both goals are the harness's own, in two verification projects.
    expect(body.match(/createWorkstream\(/g)?.length).toBe(2);
    expect(body).toMatch(/FOREIGN_FIXTURE_SLUG/);
    expect(body).toMatch(/purpose: 'TECHNICAL'/);
    // The readable half is asserted, not only the refusal.
    expect(body).toMatch(/does read the goal in its own project/);
    expect(body).toMatch(/byte-identical/);
    // Never a real goal chosen from the rows, and never the administrator who
    // could not see one.
    expect(body).not.toMatch(/listWorkstreams\(/);
    expect(body).not.toMatch(/adminCookie/);
    // No branch that skips the comparison and records a pass.
    expect(body).not.toMatch(/skipped'/);
    // Archived in a finally, so a failing check still leaves no live goal.
    expect(body).toMatch(/finally \{[\s\S]*archiveWorkstream\(own\.id[\s\S]*archiveWorkstream\(foreign\.id/);
  });
});
