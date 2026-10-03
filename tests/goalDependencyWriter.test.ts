/**
 * One writer for a goal dependency, and the one cycle rule it applies.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { goalsRouter } from '../server/routes/goals.ts';
import { createWorkstream, listLinks, listWorkstreamEvents } from '../server/repos/register.ts';
import { changeObjective, clearDependency, setDependency } from '../server/services/goals/decide.ts';
import type { Principal } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let server: Server | null = null;
let base = '';

function human(): Principal {
  return {
    type: 'HUMAN', id: userId, handle: 'o@example.test', displayName: 'Owner', isBrainAdmin: false,
    mustChangePassword: false, credentialId: 'ses', authMethod: 'SESSION_COOKIE',
    memberships: [{ id: 'm', projectId, principalType: 'HUMAN', principalId: userId, role: 'ADMIN', scopes: ['project:read'],
      grantedByType: 'SYSTEM', grantedById: 'test', grantedAt: '2026-01-01T00:00:00.000Z', active: true }],
    requestId: 'req',
  } as Principal;
}

const goal = (title: string) =>
  createWorkstream({ projectId, title, intent: 'An outcome.', purpose: 'CAPABILITY', createdByUserId: userId });
const who = () => ({ actorRef: `person:${userId}`, userId });

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `dw-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  await grantMembership({ projectId, principalType: 'HUMAN', principalId: userId, role: 'ADMIN', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, { principal: human(), requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', goalsRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

describe('setDependency', () => {
  it('refuses self and a transitive cycle, writing nothing', async () => {
    const a = await goal('A'), b = await goal('B'), c = await goal('C');
    expect((await setDependency(a.id, a.id, who())).ok).toBe(false);
    expect((await setDependency(a.id, b.id, who())).ok).toBe(true);
    expect((await setDependency(b.id, c.id, who())).ok).toBe(true);
    const events = (await listWorkstreamEvents(c.id)).length;
    const result = await setDependency(c.id, a.id, who());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('That would make the two goals wait on each other for ever.');
    expect(await listLinks(c.id)).toHaveLength(0);
    expect((await listWorkstreamEvents(c.id)).length).toBe(events);
  });

  it('writes one labelled link and one event carrying dependsOn and linkId', async () => {
    const a = await goal('A'), b = await goal('Bee');
    expect((await setDependency(a.id, b.id, who())).ok).toBe(true);
    const links = (await listLinks(a.id)).filter((l) => l.relation === 'DEPENDS_ON');
    expect(links).toHaveLength(1);
    expect(links[0]!.label).toBe('Bee');
    const ev = (await listWorkstreamEvents(a.id)).filter((e) => e.kind === 'GOAL_DEPENDENCY_SET');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ dependsOn: b.id, linkId: links[0]!.id });
  });

  it('the route and the terminal both call it and neither links DEPENDS_ON directly', () => {
    for (const file of ['server/routes/goals.ts', 'scripts/goals.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src).toContain('setDependency(');
      expect(src).not.toMatch(/linkWorkstream\(\{[^}]*DEPENDS_ON/s);
    }
  });

  it('the HTTP route refuses a three-goal cycle with 400', async () => {
    const a = await goal('A'), b = await goal('B'), c = await goal('C');
    const post = (from: string, to: string) =>
      fetch(`${base}/api/goals/${from}/depends-on`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goalId: to }) });
    expect((await post(a.id, b.id)).status).toBe(200);
    expect((await post(b.id, c.id)).status).toBe(200);
    const res = await post(c.id, a.id);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('That would make the two goals wait on each other for ever.');
  });

  it('clearDependency supersedes the live link and records LINK_SUPERSEDED, keeping the row', async () => {
    const a = await goal('A'), b = await goal('B');
    await setDependency(a.id, b.id, who());
    const live = (await listLinks(a.id)).find((l) => l.relation === 'DEPENDS_ON')!;
    const result = await clearDependency(a.id, b.id, 'no longer needed', `person:${userId}`);
    expect(result.ok).toBe(true);
    expect((await listLinks(a.id)).filter((l) => l.relation === 'DEPENDS_ON')).toHaveLength(0);
    expect((await listLinks(a.id, { includeSuperseded: true })).some((l) => l.id === live.id)).toBe(true);
    const ev = (await listWorkstreamEvents(a.id)).filter((e) => e.kind === 'LINK_SUPERSEDED');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail).toMatchObject({ linkId: live.id });
    // A second attempt finds no live link and writes nothing.
    const again = await clearDependency(a.id, b.id, 'again', `person:${userId}`);
    expect(again.ok).toBe(false);
    expect((await listWorkstreamEvents(a.id)).filter((e) => e.kind === 'LINK_SUPERSEDED')).toHaveLength(1);
  });

  it('clearDependency refuses a missing reason or a missing link, writing nothing', async () => {
    const a = await goal('A'), b = await goal('B');
    expect((await clearDependency(a.id, b.id, 'why', `person:${userId}`)).ok).toBe(false);
    await setDependency(a.id, b.id, who());
    expect((await clearDependency(a.id, b.id, '  ', `person:${userId}`)).ok).toBe(false);
    expect((await listLinks(a.id)).filter((l) => l.relation === 'DEPENDS_ON')).toHaveLength(1);
    expect((await listWorkstreamEvents(a.id)).filter((e) => e.kind === 'LINK_SUPERSEDED')).toHaveLength(0);
  });

  it('changeObjective records the change and refuses an empty one', async () => {
    const a = await goal('A');
    expect((await changeObjective(a.id, {}, `person:${userId}`)).ok).toBe(false);
    expect((await changeObjective(a.id, { intent: 'A new outcome.' }, `person:${userId}`)).ok).toBe(true);
    expect((await listWorkstreamEvents(a.id)).filter((e) => e.kind === 'GOAL_OBJECTIVE_CHANGED')).toHaveLength(1);
  });

  it('the terminal routes undepend through clearDependency and objective through changeObjective', () => {
    const src = readFileSync('scripts/goals.ts', 'utf8');
    expect(src).toContain('clearDependency(');
    expect(src).toContain('changeObjective(');
    expect(src).not.toContain('supersedeLink(');
  });
});
