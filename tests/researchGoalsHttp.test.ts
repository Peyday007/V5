/**
 * The research-goals door, driven over a real socket, and the derived reason a
 * goal has stopped. Each property lives in the route or in the derivation, so a
 * service test cannot see it: who may open one, that money is refused rather
 * than dropped, that another project's goal is the same 404 as an invented id,
 * and which ceiling the sentence names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { researchRouter } from '../server/routes/research.ts';
import { reserve, reserveGoalPacket } from '../server/repos/russellAuthority.ts';
import { getDb } from '../server/db/database.ts';
import { createLayer } from '../server/repos/layers.ts';
import { advanceResearchGoals } from '../server/services/research/goalContinuation.ts';
import { goalBudgetViewFor, stoppingReason } from '../server/services/research/goalBudgetView.ts';
import type { Principal, ProjectRole } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
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
  const fresh = await freshProject();
  projectId = fresh.project.id;
  layerId = fresh.layers[0]!.id;
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
  app.use('/api', researchRouter);
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


const future = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const base0 = () => ({ name: 'Budgeted research', maxPackets: 2, maxFragments: 3, deadline: future() });
const list = () => `/api/projects/${projectId}/research-goals`;

describe('the research goals door', () => {
  it('lets an ADMIN person create a goal and read it back with zero usage', async () => {
    const created = await call('POST', list(), base0());
    expect(created.status).toBe(200);
    expect(created.body.goal.authorizedBy).toBe(userId);
    const read = await call('GET', list());
    expect(read.status).toBe(200);
    expect(read.body.goals).toHaveLength(1);
    const goal = read.body.goals[0];
    expect(goal.packets).toMatchObject({ used: 0, ceiling: 2 });
    expect(goal.fragments).toMatchObject({ committed: 0, ceiling: 3 });
    expect(goal.stoppedBy).toBeNull();
    expect(goal.stoppingSentence).toMatch(/Nothing stops it/);
  });

  it('refuses a plain member, a viewer and a worker, and a worker even for reads', async () => {
    current = human('MEMBER');
    expect((await call('POST', list(), base0())).status).toBe(404);
    current = human('VIEWER');
    expect((await call('POST', list(), base0())).status).toBe(404);
    expect((await call('GET', list())).status).toBe(200);
    current = worker();
    expect((await call('POST', list(), base0())).status).toBeGreaterThanOrEqual(400);
    expect((await call('GET', list())).status).toBeGreaterThanOrEqual(400);
    current = human('ADMIN');
    expect((await call('GET', list())).body.goals).toHaveLength(0);
  });

  it('refuses money and unknown fields instead of dropping them', async () => {
    for (const extra of [{ externalSpendCents: 100 }, { paidOveragesEnabled: true }, { externalSpendCents: 0 }, { surprise: 1 }]) {
      const result = await call('POST', list(), { ...base0(), ...extra });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await call('GET', list())).body.goals).toHaveLength(0);
  });

  it('takes the authorizing user from the principal, never a field', async () => {
    const result = await call('POST', list(), { ...base0(), createdByUserId: 'usr_someone_else' });
    expect(result.status).toBe(400);
  });

  it('answers another project’s goal exactly as an invented id', async () => {
    const theirs = await createResearchGoalFor(otherProjectId);
    const forbidden = await call('POST', `${list()}/${theirs}/revoke`, {});
    const absent = await call('POST', `${list()}/rgl_doesnotexist0000/revoke`, {});
    expect(forbidden.status).toBe(404);
    expect(forbidden.text).toBe(absent.text);
    expect((await goalBudgetViewFor(theirs))?.state).toBe('ACTIVE');
    expect((await call('GET', list())).text).not.toContain(theirs);
  });

  it('opens a goal Brain continues by itself when it names an assignment and a layer', async () => {
    // The continuation pass reads only goals with an assignment, so a door that
    // could not set one would leave continuation reachable from tests alone.
    const assignment = 'How many people work in outsourced telemarketing, and where.';
    const created = await call('POST', list(), { ...base0(), assignment, layerId });
    expect(created.status).toBe(200);
    const id = created.body.goal.goalId;
    const row = await getDb().get<{ research_assignment: string | null; research_layer_id: string | null }>(
      'SELECT research_assignment, research_layer_id FROM russell_goals WHERE id = ?',
      [id],
    );
    expect(row).toEqual({ research_assignment: assignment, research_layer_id: layerId });
    const report = await advanceResearchGoals();
    expect(report.considered).toBe(1);
    expect(report.skipped.find((one) => one.goalId === id)?.reason ?? '').not.toMatch(/no layer/);
  });

  it('refuses half of an assignment, and another project\u2019s layer', async () => {
    const theirLayer = await createLayer({ projectId: otherProjectId, name: 'Theirs', orderIndex: 0 });
    for (const extra of [
      { assignment: 'A question' },
      { layerId },
      { assignment: 'A question', layerId: theirLayer.id },
      { assignment: '', layerId },
    ]) {
      const result = await call('POST', list(), { ...base0(), ...extra });
      expect(result.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await call('GET', list())).body.goals).toHaveLength(0);
  });

  it('revokes at ADMIN only, and says REVOKED afterwards', async () => {
    const id = (await call('POST', list(), base0())).body.goal.goalId;
    current = human('MEMBER');
    expect((await call('POST', `${list()}/${id}/revoke`, {})).status).toBe(404);
    current = human('ADMIN');
    const revoked = await call('POST', `${list()}/${id}/revoke`, { reason: 'done' });
    expect(revoked.status).toBe(200);
    expect(revoked.body.goal.stoppedBy).toBe('REVOKED');
    expect((await call('POST', `${list()}/${id}/revoke`, {})).status).toBe(409);
  });
});

async function createResearchGoalFor(project: string): Promise<string> {
  const { createResearchGoal } = await import('../server/repos/russellAuthority.ts');
  const goal = await createResearchGoal({
    projectId: project,
    ownerUserId: userId,
    createdByUserId: userId,
    ...base0(),
  });
  return goal.id;
}

describe('the derived stopping reason', () => {
  it('reads PACKETS when the packet ceiling is used', async () => {
    const id = await createResearchGoalFor(projectId);
    await reserveGoalPacket({ goalId: id, packetKey: 'a', projectId });
    expect((await goalBudgetViewFor(id))?.stoppedBy).toBeNull();
    await reserveGoalPacket({ goalId: id, packetKey: 'b', projectId });
    const view = await goalBudgetViewFor(id);
    expect(view?.stoppedBy).toBe('PACKETS');
    expect(view?.stoppingSentence).toMatch(/packet ceiling.*your decision/);
  });

  it('reads FRAGMENTS when the fragment ceiling is committed', async () => {
    const id = await createResearchGoalFor(projectId);
    for (const key of ['f1', 'f2', 'f3']) await reserve({ goalId: id, kind: 'FRAGMENT', idempotencyKey: key });
    const view = await goalBudgetViewFor(id);
    expect(view?.stoppedBy).toBe('FRAGMENTS');
    expect(view?.stoppingSentence).toMatch(/fragment ceiling.*your decision/);
  });

  it('reads DEADLINE once Brain’s clock is past it', async () => {
    const id = await createResearchGoalFor(projectId);
    const later = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const view = await goalBudgetViewFor(id, later);
    expect(view?.stoppedBy).toBe('DEADLINE');
    expect(view?.stoppingSentence).toMatch(/deadline.*your decision/);
  });

  it('reads PAUSED and REVOKED from state, and nothing when headroom remains', () => {
    const status = {
      goalId: 'x', name: 'n', state: 'ACTIVE' as const,
      packets: { used: 1, reserved: 1, ceiling: 2 }, fragments: { committed: 0, ceiling: 3 },
      deadline: future(), authorizedBy: 'u', createdAt: 'then',
    };
    expect(stoppingReason(status).stoppedBy).toBeNull();
    expect(stoppingReason({ ...status, state: 'PAUSED' }).stoppedBy).toBe('PAUSED');
    expect(stoppingReason({ ...status, state: 'REVOKED' }).stoppedBy).toBe('REVOKED');
  });
});
