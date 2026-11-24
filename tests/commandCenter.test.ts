/**
 * The Command Center's read door (server/routes/command.ts), driven over a
 * real socket.
 *
 * What the door must never become: a way to run a mutating tool from a
 * browser, a way for a worker to reach the operator outside MCP, or a second
 * authorization. Each test pins one of those.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { COMMAND_READ_TOOLS, commandReadable, commandRouter } from '../server/routes/command.ts';
import { operatorProjects } from '../server/mcp/operatorTools.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { getDb } from '../server/db/database.ts';
import { readResearchBacklog, retireObsoleteIdeas } from '../server/services/research/backlog.ts';
import { findTool } from '../server/mcp/tools.ts';
import type { Principal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let server: Server | null = null;
let base = '';
let current: Principal | null = null;

function membership(principalType: 'HUMAN' | 'WORKER', principalId: string, role: 'ADMIN' | null) {
  return {
    id: `mem-${principalType}`,
    projectId,
    principalType,
    principalId,
    role,
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    active: true,
  };
}

function human(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `ses_${Math.random().toString(36).slice(2, 10)}`,
    authMethod: 'SESSION_COOKIE',
    memberships: [membership('HUMAN', userId, 'ADMIN')],
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
    memberships: [membership('WORKER', workerId, null)],
    requestId: 'req',
  } as Principal;
}

async function get(path: string) {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `command-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'The owner',
      password: 'correct horse battery staple',
    })
  ).id;
  workerId = (
    await createWorker({ name: `command-worker-${Math.random().toString(36).slice(2, 8)}`, displayName: 'W', createdByType: 'SYSTEM', createdById: 'test' })
  ).id;
  current = human();
  const app = express();
  app.use((req, _res, next) => {
    attachContext(req, { principal: current, requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', commandRouter);
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

describe('the Command Center read door', () => {
  it('lists only tools that exist and are annotated read-only', () => {
    for (const name of COMMAND_READ_TOOLS) {
      const tool = findTool(name);
      expect(tool, name).not.toBeNull();
      expect(tool!.annotations.readOnlyHint, name).toBe(true);
      expect(commandReadable(name), name).toBe(true);
    }
  });

  it('refuses a mutating tool and an unknown tool with the same 404', async () => {
    const mutating = await get('/api/command/read/brain_operator_inventory');
    const decide = await get('/api/command/read/brain_operator_decide');
    const unknown = await get('/api/command/read/brain_nothing_here');
    expect(mutating.status).toBe(404);
    expect(decide.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(mutating.body).toEqual(unknown.body);
    expect(decide.body).toEqual(unknown.body);
  });

  it('refuses a worker by type, even for a read', async () => {
    current = worker();
    const response = await get('/api/command/read/brain_operator_capacity');
    expect(response.status).toBe(404);
  });

  it('refuses a request with no principal', async () => {
    current = null;
    const response = await get('/api/command/read/brain_operator_capacity');
    expect(response.status).toBe(404);
  });

  it("serves a person the tool's own value, through the tool's own authorization", async () => {
    const goals = await get('/api/command/read/brain_operator_goals');
    expect(goals.status).toBe(200);
    expect(Array.isArray(goals.body.value.goals)).toBe(true);
    const capacity = await get('/api/command/read/brain_operator_capacity');
    expect(capacity.status).toBe(200);
    expect(capacity.body.value).toHaveProperty('source');
  });

  it('answers a refusal from the tool as a refusal, not as data', async () => {
    const plan = await get('/api/command/read/brain_operator_goal_plan?goal_id=wst_does_not_exist');
    expect(plan.status).toBe(422);
    expect(plan.body.refused).toBe(true);
    expect(plan.body.value).toBeUndefined();
  });
});

function owner(): Principal {
  // The owner's real shape on production (2026-11-24): a Brain administrator with no memberships.
  return { ...human(), isBrainAdmin: true, memberships: [] } as Principal;
}

function viewer(): Principal {
  const p = human();
  return { ...p, memberships: [{ ...p.memberships[0]!, role: 'VIEWER' }] } as Principal;
}

describe('operator rights follow the access policy', () => {
  it('gives a Brain administrator with no memberships every project, as the policy does', async () => {
    const projects = await operatorProjects(owner());
    expect(projects).toContain(projectId);
  });

  it('still refuses a viewer and a worker without operator:act', async () => {
    expect(await operatorProjects(viewer())).not.toContain(projectId);
    expect(await operatorProjects(worker())).toEqual([]);
  });

  it("serves the owner the operator's readings through the read door", async () => {
    current = owner();
    const engineering = await get('/api/command/read/brain_operator_engineering');
    expect(engineering.status).toBe(200);
    expect(Array.isArray(engineering.body.value.engineering)).toBe(true);
    const deficiencies = await get('/api/command/read/brain_operator_deficiencies');
    expect(deficiencies.status).toBe(200);
  });
});

describe('reports, backlog and resources', () => {
  it('serves the owner every stored report section', async () => {
    current = owner();
    const reports = await get('/api/command/reports');
    expect(reports.status).toBe(200);
    for (const key of ['inventory', 'engineering', 'deficiencies', 'runs', 'learnings', 'hourly', 'audits', 'interventions']) {
      expect(reports.body[key], key).toBeDefined();
      expect(reports.body[key].ok, key).toBe(true);
    }
  });

  it('refuses reports and the backlog to a viewer and to a worker with the same 404', async () => {
    for (const who of [viewer(), worker()]) {
      current = who;
      expect((await get('/api/command/reports')).status).toBe(404);
      expect((await get('/api/command/backlog')).status).toBe(404);
    }
  });

  it("serves the owner the Factory's operational state, and refuses a viewer", async () => {
    current = owner();
    const factory = await get('/api/command/factory');
    expect(factory.status).toBe(200);
    expect(typeof factory.body.line.because).toBe('string');
    expect(Array.isArray(factory.body.corrections)).toBe(true);
    expect(Array.isArray(factory.body.completed)).toBe(true);
    current = viewer();
    expect((await get('/api/command/factory')).status).toBe(404);
  });

  it('serves resources to anyone who can read a project', async () => {
    current = viewer();
    const resources = await get('/api/command/resources');
    expect(resources.status).toBe(200);
    expect(resources.body.resources.some((r: { key: string }) => r.key === 'GPU')).toBe(true);
  });
});

describe('the research backlog', () => {
  async function queued(title: string): Promise<string> {
    const idea = await createCandidate({ title, statement: `${title}.`, projectId });
    await getDb().run(`UPDATE russell_candidates SET state = 'QUEUED', priority = 'WORTH_DOING' WHERE id = ?`, [idea.id]);
    return idea.id;
  }

  it('classifies a withdrawn question and a duplicate as obsolete, retires them, and keeps their rows', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const moot = await queued(`Causal unknown: reply rate ${tag}`);
    const first = await queued(`Price of widgets ${tag}`);
    const twin = await queued(`Price of widgets ${tag}`);
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_needs (id, project_id, opportunity_id, blocked_action, why_it_matters, recommended_path, setup_effort, next_step, state, created_at, updated_at, candidate_id, request_key)
       VALUES (?, ?, NULL, 'x', 'x', 'x', 'x', 'x', 'WITHDRAWN', ?, ?, ?, ?)`,
      [`need_${tag}`, projectId, at, at, moot, `causal-${tag}`],
    );

    const reading = await readResearchBacklog();
    const reasons = Object.fromEntries(reading.obsoleteReasons.map((r) => [r.reason, r.count]));
    expect(reasons['QUESTION_WITHDRAWN']).toBeGreaterThanOrEqual(1);
    expect(reasons['DUPLICATE']).toBeGreaterThanOrEqual(1);

    const out = await retireObsoleteIdeas({ dryRun: false, actor: 'test' });
    const retired = new Set(out.retired.map((r) => r.id));
    expect(retired.has(moot)).toBe(true);
    expect(retired.has(twin)).toBe(true);
    expect(retired.has(first)).toBe(false);

    const states = await getDb().all<{ id: string; state: string }>(
      'SELECT id, state FROM russell_candidates WHERE id IN (?, ?, ?)',
      [moot, first, twin],
    );
    const byId = Object.fromEntries(states.map((r) => [r.id, r.state]));
    expect(byId[moot]).toBe('REJECTED');
    expect(byId[twin]).toBe('REJECTED');
    expect(byId[first]).toBe('QUEUED');
    const events = await getDb().all<{ payload: string }>(
      `SELECT payload FROM project_events WHERE project_id = ? AND event_type = 'RESEARCH_BACKLOG_RETIRED'`,
      [projectId],
    );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toContain(moot);
  });
});
