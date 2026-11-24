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
