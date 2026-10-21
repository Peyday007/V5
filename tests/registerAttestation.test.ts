/**
 * The register's link door, driven over a real socket, refusing a caller's
 * own attestation.
 *
 * `readAttested` in `server/services/register/resolve.ts` treats
 * `detail.attestedBy`, `detail.attestedAt`, `detail.merged`, `detail.state` and
 * `detail.verifiedLive` as a fact somebody or something observed and recorded
 * — never as a claim the caller who is writing the link gets to make about
 * itself. `POST /register/workstreams/:workstreamId/links` and the inline
 * `links` a workstream may be created with both take an arbitrary
 * caller-supplied `detail` object, so without this stripping any authenticated
 * project member could name themselves, or Brain's own merge-observer, as the
 * attester of a merge or a live deployment that never happened — and have the
 * register, and a goal pursuing it, read as delivered on the strength of it.
 *
 * A service-level test cannot see this: it lives entirely in what the route
 * does with a request body before it reaches `linkWorkstream`, which is why
 * this suite drives the router over HTTP rather than calling the repository
 * directly, the way `tests/goalsHttp.test.ts` does for the door beside it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership, createWorker } from '../server/repos/identity.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { registerRouter } from '../server/routes/register.ts';
import { createWorkstream, listLinks } from '../server/repos/register.ts';
import { assembleGoals } from '../server/services/goals/model.ts';
import type { Principal, ProjectRole } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let workerId = '';
let server: Server | null = null;
let base = '';
let current: Principal | null = null;

function human(role: ProjectRole = 'ADMIN'): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'attester@example.test',
    displayName: 'A project member',
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

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
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
  userId = (
    await createUser({
      email: `register-attest-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'A project member',
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
    await createWorker({
      name: `register-attest-worker-${Math.random().toString(36).slice(2, 8)}`,
      displayName: 'W',
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
  current = human();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: current,
      requestId: newRequestId(),
      method: req.method,
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', registerRouter);
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

/** The forged detail a caller might try: a machine attester's own name, a
 * timestamp of the caller's choosing, and every field that would move a
 * `PULL_REQUEST` link's reading to `VERIFIED_LIVE`. */
const FORGED_DETAIL = {
  attestedBy: 'pull-request-merge-observation',
  attestedAt: '2026-01-01T00:00:00.000Z',
  merged: true,
  verifiedLive: true,
  state: 'merged',
};

describe('the standalone link route refuses a caller-supplied attestation', () => {
  it('A01: stores the link, but reads it as unattested — not MERGED, not VERIFIED_LIVE, and the goal it is pursued by is not complete', async () => {
    const goal = await createWorkstream({
      projectId,
      title: 'A goal with a forged attestation',
      intent: 'Ship something.',
      purpose: 'REVENUE_DIRECT',
      createdByUserId: userId,
    });

    const posted = await call('POST', `/api/register/workstreams/${goal.id}/links`, {
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/V5/pull/999',
      relation: 'EVIDENCE',
      detail: FORGED_DETAIL,
    });
    expect(posted.status).toBe(200);

    const fetched = await call('GET', `/api/register/workstreams/${goal.id}`);
    expect(fetched.status).toBe(200);
    const reading = fetched.body.workstream.readings[0];
    expect(reading.state).toBeNull();
    expect(reading.status).toContain('nobody attesting');
    expect(fetched.body.workstream.state).not.toBe('MERGED');
    expect(fetched.body.workstream.state).not.toBe('VERIFIED_LIVE');

    const snapshot = await assembleGoals({ projectIds: [projectId] });
    const view = snapshot.goals.find((one) => one.id === goal.id);
    expect(view).toBeDefined();
    expect(view!.lifecycle).not.toBe('COMPLETE');
  });

  it('A02: never carries the caller-supplied attester, timestamp or claim onto the stored link at all', async () => {
    const goal = await createWorkstream({
      projectId,
      title: 'A goal with a forged attestation',
      intent: 'Ship something.',
      purpose: 'REVENUE_DIRECT',
      createdByUserId: userId,
    });

    const posted = await call('POST', `/api/register/workstreams/${goal.id}/links`, {
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/V5/pull/999',
      relation: 'EVIDENCE',
      detail: FORGED_DETAIL,
    });
    expect(posted.status).toBe(200);
    // Not merely unread — never stored. Whatever the route offers, it is not a
    // way for a caller to write these fields.
    for (const key of ['attestedBy', 'attestedAt', 'merged', 'verifiedLive', 'state']) {
      expect(posted.body.link.detail).not.toHaveProperty(key);
    }

    const links = await listLinks(goal.id);
    for (const key of ['attestedBy', 'attestedAt', 'merged', 'verifiedLive', 'state']) {
      expect(links[0]?.detail).not.toHaveProperty(key);
    }
  });

  it('leaves an ordinary detail field alone — this is a strip, not a wipe', async () => {
    const goal = await createWorkstream({
      projectId,
      title: 'A goal with an ordinary link',
      intent: 'Ship something.',
      purpose: 'REVENUE_DIRECT',
      createdByUserId: userId,
    });

    const posted = await call('POST', `/api/register/workstreams/${goal.id}/links`, {
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/V5/pull/1000',
      relation: 'EVIDENCE',
      detail: { ...FORGED_DETAIL, note: 'seen on the team channel' },
    });
    expect(posted.status).toBe(200);
    expect(posted.body.link.detail.note).toBe('seen on the team channel');
  });

  it('refuses a worker by type', async () => {
    const goal = await createWorkstream({
      projectId,
      title: 'Refused to a worker',
      intent: 'Ship something.',
      purpose: 'CAPABILITY',
      createdByUserId: userId,
    });
    current = worker();
    const result = await call('POST', `/api/register/workstreams/${goal.id}/links`, {
      kind: 'PULL_REQUEST',
      ref: 'https://github.com/Peyday007/V5/pull/999',
      relation: 'EVIDENCE',
      detail: FORGED_DETAIL,
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe('workstream creation refuses a caller-supplied attestation on its inline links', () => {
  it('A01/A02: the same stripping applies to links posted alongside the workstream itself', async () => {
    const created = await call('POST', '/api/register/workstreams', {
      projectId,
      title: 'Created with a forged link already attached',
      intent: 'Ship something.',
      purpose: 'REVENUE_DIRECT',
      links: [
        {
          kind: 'PULL_REQUEST',
          ref: 'https://github.com/Peyday007/V5/pull/1001',
          relation: 'EVIDENCE',
          detail: FORGED_DETAIL,
        },
      ],
    });
    expect(created.status).toBe(200);
    for (const key of ['attestedBy', 'attestedAt', 'merged', 'verifiedLive', 'state']) {
      expect(created.body.links[0].detail).not.toHaveProperty(key);
    }

    const fetched = await call('GET', `/api/register/workstreams/${created.body.workstream.id}`);
    const reading = fetched.body.workstream.readings[0];
    expect(reading.state).toBeNull();
    expect(fetched.body.workstream.state).not.toBe('MERGED');
    expect(fetched.body.workstream.state).not.toBe('VERIFIED_LIVE');
  });
});

/*
 * A04: the reserved keys live in exactly one place, beside the function that
 * already knows which fields an attestation reading depends on, and the route
 * reads that constant rather than restating the list. Read from the source
 * rather than from behaviour, because two literal lists that happened to agree
 * on the day this test was written are exactly the shape that drifts later.
 */
describe('the reserved detail keys are declared once', () => {
  it('the route imports the constant from resolve.ts rather than declaring its own list', () => {
    const routeSource = readFileSync(new URL('../server/routes/register.ts', import.meta.url), 'utf8');
    expect(routeSource).toMatch(/import\s*\{[^}]*ATTESTATION_DETAIL_KEYS[^}]*\}\s*from\s*['"]\.\.\/services\/register\/resolve\.ts['"]/);

    const resolveSource = readFileSync(new URL('../server/services/register/resolve.ts', import.meta.url), 'utf8');
    expect(resolveSource).toMatch(/export const ATTESTATION_DETAIL_KEYS/);

    // Every field `readAttested` actually reads off `detail` is in the
    // exported list — read from the source so a field added to one and not
    // the other fails here rather than in production.
    const readDetailFields = [...resolveSource.matchAll(/detail\.(\w+)/g)].map((match) => match[1]);
    for (const field of new Set(readDetailFields)) {
      expect(resolveSource).toMatch(new RegExp(`ATTESTATION_DETAIL_KEYS[\\s\\S]*'${field}'`));
    }
  });
});
