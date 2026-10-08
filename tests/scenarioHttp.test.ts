/**
 * The scenario door and its rows, over a real socket and a real database.
 *
 * What a pure engine test cannot see: that a model and its runs persist and
 * survive a restart, that a run records the exact definition it evaluated even
 * after the model changes, that a re-run reproduces the stored digest, that an
 * abandoned RUNNING row reads as interrupted, and the boundary — a worker is
 * refused by type, and another project's model is the same 404 with the same
 * body as one that does not exist (invariant 23). Runs on both backends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject, restartDatabase } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { scenarioRouter } from '../server/routes/scenario.ts';
import { getDb } from '../server/db/database.ts';
import { insertScenarioRun, getScenarioRun } from '../server/repos/scenario.ts';
import { readRunState } from '../server/services/scenario/service.ts';
import type { Principal, ProjectRole } from '../server/domain/types.ts';

let projectId = '';
let otherProjectId = '';
let userId = '';
let server: Server | null = null;
let base = '';
let current: Principal | null = null;

function human(role: ProjectRole = 'MEMBER'): Principal {
  return {
    type: 'HUMAN', id: userId, handle: 'owner@example.test', displayName: 'The owner', isBrainAdmin: false,
    mustChangePassword: false, credentialId: 'ses_browser', authMethod: 'SESSION_COOKIE',
    memberships: [{ id: 'mem', projectId, principalType: 'HUMAN', principalId: userId, role, scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test', grantedAt: '2026-01-01T00:00:00.000Z', active: true }],
    requestId: 'req',
  } as Principal;
}

function worker(): Principal {
  return {
    type: 'WORKER', id: 'wkr_test', handle: 'a-worker', displayName: 'A worker', isBrainAdmin: false,
    mustChangePassword: false, credentialId: 'cre_worker', authMethod: 'WORKER_BEARER',
    memberships: [{ id: 'mem-w', projectId, principalType: 'WORKER', principalId: 'wkr_test', role: null, scopes: ['project:read', 'research:write'], grantedByType: 'SYSTEM', grantedById: 'test', grantedAt: '2026-01-01T00:00:00.000Z', active: true }],
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
  otherProjectId = (await createProject({ name: `Elsewhere ${Math.random().toString(36).slice(2, 7)}` })).id;
  userId = (await createUser({ email: `scn-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'The owner', password: 'correct horse battery staple' })).id;
  await grantMembership({ projectId, principalType: 'HUMAN', principalId: userId, role: 'MEMBER', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test' });
  current = human();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    attachContext(req, { principal: current, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', scenarioRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error), detail: error?.detail });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('the scenario door', () => {
  it('serves a read-only demonstration that writes no row', async () => {
    const demo = await call('GET', `/api/projects/${projectId}/scenarios/demonstration`);
    expect(demo.status).toBe(200);
    expect(demo.body.result.simulated).toBe(true);
    expect(demo.body.result.evaluations).toBe(50_000);
    expect(demo.body.definition.illustrative).toBe(true);
    const models = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM scenario_models');
    const runs = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM scenario_runs');
    expect(Number(models!.n)).toBe(0);
    expect(Number(runs!.n)).toBe(0);
  });

  it('saves a model, runs it, keeps the definition the run used, and reproduces it after a restart', async () => {
    const saved = await call('POST', `/api/projects/${projectId}/scenarios`, { fromDemonstration: true });
    expect(saved.status).toBe(200);
    const modelId = saved.body.model.id as string;

    const ran = await call('POST', `/api/projects/${projectId}/scenarios/${modelId}/runs`, { options: { seed: 99, evaluations: 4000 }, label: 'first' });
    expect(ran.status).toBe(200);
    expect(ran.body.run.reading).toBe('COMPLETE');
    const runId = ran.body.run.id as string;
    const digest = ran.body.run.resultDigest as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // The model changes; the run still resolves to the definition it evaluated.
    const definition = saved.body.model.definition;
    definition.variables.find((v: any) => v.key === 'materials').spec = { kind: 'RANGE', min: 50, max: 90 };
    const revised = await call('PATCH', `/api/projects/${projectId}/scenarios/${modelId}`, { definition });
    expect(revised.status).toBe(200);

    await restartDatabase();

    const read = await call('GET', `/api/projects/${projectId}/scenarios/${modelId}/runs/${runId}`);
    expect(read.status).toBe(200);
    expect(read.body.run.config.definition.variables.find((v: any) => v.key === 'materials').spec).toEqual({ kind: 'RANGE', min: 15, max: 45 });
    expect(read.body.run.result.strategies).toHaveLength(4);

    const again = await call('POST', `/api/projects/${projectId}/scenarios/${modelId}/runs/${runId}/reproduce`);
    expect(again.status).toBe(200);
    expect(again.body.reproduction.reproduced).toBe(true);
    expect(again.body.reproduction.recomputedDigest).toBe(digest);

    const list = await call('GET', `/api/projects/${projectId}/scenarios/${modelId}`);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0].result).toBeNull();
    expect(list.body.model.definition.variables.find((v: any) => v.key === 'materials').spec.min).toBe(50);
  });

  it('refuses an invalid model with every problem named, and records a failed run as FAILED', async () => {
    const bad = await call('POST', `/api/projects/${projectId}/scenarios`, {
      definition: { title: 'Bad', currency: 'USD', horizon: 'x', variables: [{ key: 'a', label: 'a', unit: '', provenance: 'ASSUMPTION', controllable: false, spec: { kind: 'NORMAL', mean: 1, sd: 1, min: 0, max: 2 } }], lines: [{ key: 'l', label: 'l', kind: 'REVENUE', expr: 'b' }], strategies: [{ key: 's', label: 's', set: {} }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.detail.problems.length).toBeGreaterThanOrEqual(2);

    const saved = await call('POST', `/api/projects/${projectId}/scenarios`, { fromDemonstration: true });
    const modelId = saved.body.model.id as string;
    const refused = await call('POST', `/api/projects/${projectId}/scenarios/${modelId}/runs`, { options: { evaluations: 50_001 } });
    expect(refused.status).toBe(400);
    const mc = await call('POST', `/api/projects/${projectId}/scenarios/${modelId}/runs`, { options: { basis: 'MONTE_CARLO', evaluations: 100 } });
    expect(mc.status).toBe(200);
    expect(mc.body.run.reading).toBe('FAILED');
    expect(mc.body.run.failure).toMatch(/Monte Carlo needs every sampled input/);
  });

  it('reads a run abandoned by a dead process as interrupted, not as working', async () => {
    const saved = await call('POST', `/api/projects/${projectId}/scenarios`, { fromDemonstration: true });
    const runId = await insertScenarioRun({
      modelId: saved.body.model.id, projectId, label: null, seed: 1, evaluations: 10,
      config: { definition: saved.body.model.definition, options: { seed: 1, evaluations: 10 } },
      configHash: 'x', engineVersion: 'scenario-engine/1', createdById: userId,
    });
    await getDb().run('UPDATE scenario_runs SET started_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', runId]);
    const run = (await getScenarioRun(runId))!;
    expect(readRunState(run)).toBe('INTERRUPTED');
    const read = await call('GET', `/api/projects/${projectId}/scenarios/${saved.body.model.id}/runs/${runId}`);
    expect(read.body.run.reading).toBe('INTERRUPTED');
  });

  it('refuses a worker by type, and answers another project’s model exactly as one that does not exist', async () => {
    const theirs = await call('POST', `/api/projects/${projectId}/scenarios`, { fromDemonstration: true });
    // Move it to another project, as if somebody else saved it there.
    await getDb().run('UPDATE scenario_models SET project_id = ? WHERE id = ?', [otherProjectId, theirs.body.model.id]);
    const forbidden = await call('GET', `/api/projects/${projectId}/scenarios/${theirs.body.model.id}`);
    const absent = await call('GET', `/api/projects/${projectId}/scenarios/scm_doesnotexist00000000`);
    expect(forbidden.status).toBe(404);
    expect(forbidden.text).toBe(absent.text);
    const otherProject = await call('GET', `/api/projects/${otherProjectId}/scenarios/${theirs.body.model.id}`);
    expect(otherProject.status).toBe(404);

    current = worker();
    for (const [method, path] of [
      ['GET', `/api/projects/${projectId}/scenarios`],
      ['GET', `/api/projects/${projectId}/scenarios/demonstration`],
      ['POST', `/api/projects/${projectId}/scenarios`],
    ] as const) {
      const result = await call(method, path, method === 'POST' ? { fromDemonstration: true } : undefined);
      expect(result.status, `${method} ${path}`).toBe(404);
    }
  });
});
