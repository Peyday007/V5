/**
 * The authority decision, on the surface a person actually uses.
 *
 * It was on the operator console. That was a mistake rather than a design:
 * §22 puts buttons there so a *machine* cannot create its own work, and
 * applying that to the person who owns the project sent their own decision out
 * of Russell and into an administration surface §24 had already taken off the
 * normal route.
 *
 * What these check is that moving it changed the *surface* and nothing about
 * the *authorization*. The enforcement — `checkAuthority`, `reserve`, and the
 * two ceilings mutation 13 separated — is untouched and is exercised through
 * the real launch path at the end, so a grant made here bounds work exactly as
 * one made anywhere else did.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { russellRouter } from '../server/routes/russell.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { authorityFor, AUTHORITY_LIMITS } from '../server/services/russell/authority.ts';
import { listGoals, reserve } from '../server/repos/russellAuthority.ts';
import { listEvents } from '../server/repos/events.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let otherProjectId = '';
let userId = '';
let strangerId = '';
let workerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const owner = await createUser({
    email: `owner-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = owner.id;
  const stranger = await createUser({
    email: `stranger-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Somebody else',
    password: 'correct horse battery staple',
  });
  strangerId = stranger.id;
  workerId = (
    await createWorker({ name: `w-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' })
  ).id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  otherProjectId = '';
});

function personPrincipal(id: string, memberOf: string | null): Principal {
  return {
    type: 'HUMAN',
    id,
    handle: 'p@example.test',
    displayName: 'A person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: memberOf
      ? [
          {
            id: 'mem',
            projectId: memberOf,
            principalType: 'HUMAN',
            principalId: id,
            role: 'MEMBER',
            scopes: ['project:read'],
            grantedByType: 'SYSTEM',
            grantedById: 'test',
            grantedAt: '2026-01-01T00:00:00.000Z',
            active: true,
          } as ProjectMembership,
        ]
      : [],
    requestId: 'req',
  } as Principal;
}

function machinePrincipal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'a worker',
    displayName: 'A worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_test',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: ['project:read', 'project:write'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

async function withRoutes<T>(
  principal: Principal,
  fn: (
    call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>,
  ) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal,
      requestId: newRequestId(),
      method: req.method,
      path: `/api/russell${req.path}`,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api/russell', russellRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({
      error: String(error?.message ?? error),
    });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/russell${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* left as text */
      }
      return { status: response.status, body: parsed as any };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const APPROVED = {
  name: 'Deal Dispatch discovery research',
  maxMissions: 2,
  maxConcurrent: 1,
  maxFragments: 12,
  maxProbes: 3,
  expiresAt: null,
};

describe('a person grants it inside Russell', () => {
  it('says plainly that Russell may do nothing, before anybody decides', async () => {
    const view = await authorityFor({ projectId });
    expect(view.grant).toBeNull();
    // Not an error and not an empty screen: a project with no grant is an
    // ordinary state, and the sentence says what Russell *will* still do.
    expect(view.headline).toMatch(/may not start research/i);
    expect(view.headline).toMatch(/capture ideas/i);
    expect(view.suggested.maxMissions).toBe(2);
    expect(view.suggestedApproval.name).toMatch(/discovery research$/);
    expect(view.suggestedApproval.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(await listGoals(projectId)).toHaveLength(0);
  });

  it('records the grant against the authenticated person, not a field', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, {
        ...APPROVED,
        // Ignored. There is no body field either id can be read from, here or
        // in createGoal — which is what makes "who authorized this" answerable.
        ownerUserId: strangerId,
      });
      expect(result.status).toBe(200);
      expect(result.body.grant.grantedBy).toBe('The owner');
    });
    const goals = await listGoals(projectId);
    expect(goals).toHaveLength(1);
    expect(goals[0]!.ownerUserId).toBe(userId);
    expect(goals[0]!.createdByUserId).toBe(userId);
    // One class of work, from the constant. A grant that could name its own
    // class could authorize something the screen never described.
    expect(goals[0]!.allowedWork).toEqual(['RESEARCH']);
  });

  it('describes what it permits in sentences the server composed', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, APPROVED);
      const permits: string[] = result.body.grant.permits;
      expect(permits.some((line) => /at most 2 pieces of research/i.test(line))).toBe(true);
      expect(permits.some((line) => /at most 1 at a time/i.test(line))).toBe(true);
      expect(permits.some((line) => /until you withdraw/i.test(line))).toBe(true);
      // And what it can never do, whatever the numbers say.
      const never: string[] = result.body.grant.neverPermits;
      expect(never.some((line) => /spend money/i.test(line))).toBe(true);
      expect(never.some((line) => /widen its own access/i.test(line))).toBe(true);
    });
  });

  it('writes the decision into the project’s own history', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      await call('POST', `/projects/${projectId}/authority`, APPROVED);
    });
    const events = await listEvents(projectId, 50);
    const granted = events.find((event) => event.eventType === 'RUSSELL_AUTHORITY_GRANTED');
    expect(granted).toBeTruthy();
    expect(granted!.payload['grantedByUserId']).toBe(userId);
    expect(granted!.payload['surface']).toBe('RUSSELL');
  });
});

describe('the limits are refused rather than defaulted', () => {
  it('refuses a missing, fractional, negative or over-large number', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      for (const bad of [
        { ...APPROVED, maxMissions: undefined },
        { ...APPROVED, maxMissions: 1.5 },
        { ...APPROVED, maxMissions: -1 },
        { ...APPROVED, maxMissions: 999 },
        { ...APPROVED, maxProbes: '3' },
        { ...APPROVED, name: '' },
      ]) {
        const result = await call('POST', `/projects/${projectId}/authority`, bad);
        expect(result.status, JSON.stringify(bad)).toBe(400);
      }
      // And none of them created anything.
      expect(await listGoals(projectId)).toHaveLength(0);
    });
  });

  it('refuses more at a time than in total, which is incoherent rather than strict', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, {
        ...APPROVED,
        maxMissions: 1,
        maxConcurrent: 2,
      });
      expect(result.status).toBe(400);
      expect(String(result.body.error)).toMatch(/more at a time than/i);
    });
  });

  it('refuses an expiry in the past, which would grant nothing', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, {
        ...APPROVED,
        expiresAt: '2020-01-01T00:00:00.000Z',
      });
      expect(result.status).toBe(400);
    });
  });

  it('will not quietly replace a live grant', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      expect((await call('POST', `/projects/${projectId}/authority`, APPROVED)).status).toBe(200);
      const second = await call('POST', `/projects/${projectId}/authority`, {
        ...APPROVED,
        maxMissions: 50,
      });
      expect(second.status).toBe(400);
      expect(String(second.body.error)).toMatch(/withdraw it first/i);
    });
    // Two active grants would make "the limits you set" ambiguous and
    // checkAuthority's choice an accident of ordering.
    expect((await listGoals(projectId)).filter((g) => g.state === 'ACTIVE')).toHaveLength(1);
  });
});

describe('the gate did not move with the surface', () => {
  it('refuses a person who is not a member, the same way it refuses a missing project', async () => {
    const mine = await withRoutes(personPrincipal(userId, projectId), (call) =>
      call('GET', `/projects/prj_does_not_exist/authority`),
    );
    const theirs = await withRoutes(personPrincipal(strangerId, null), (call) =>
      call('GET', `/projects/${projectId}/authority`),
    );
    expect(theirs.status).toBe(mine.status);
    expect(JSON.stringify(theirs.body)).toBe(JSON.stringify(mine.body));
    expect(theirs.status).toBe(404);
  });

  it('refuses a machine by principal type, however its membership is configured', async () => {
    // The worker below is a member of this project *with project:write*. §22's
    // real concern — a machine creating its own authority — is refused here by
    // type rather than by scope, which is the stronger check and the one this
    // move had to preserve.
    await withRoutes(machinePrincipal(), async (call) => {
      expect((await call('GET', `/projects/${projectId}/authority`)).status).toBe(404);
      expect((await call('POST', `/projects/${projectId}/authority`, APPROVED)).status).toBe(404);
    });
    expect(await listGoals(projectId)).toHaveLength(0);
  });
});

describe('withdrawing it', () => {
  it('stops new work, keeps the record, and says why', async () => {
    const goalId = await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const granted = await call('POST', `/projects/${projectId}/authority`, APPROVED);
      return granted.body.grant.id as string;
    });

    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const empty = await call('POST', `/projects/${projectId}/authority/${goalId}/revoke`, {});
      expect(empty.status).toBe(400);

      const result = await call('POST', `/projects/${projectId}/authority/${goalId}/revoke`, {
        reason: 'the question turned out to be answered already',
      });
      expect(result.status).toBe(200);
      expect(result.body.grant).toBeNull();
      // Withdrawn, not erased: it is in the history with the reason.
      expect(result.body.history).toHaveLength(1);
      expect(result.body.history[0].endedReason).toMatch(/answered already/);
    });

    const revoked = (await listGoals(projectId))[0]!;
    expect(revoked.state).toBe('REVOKED');
    expect(revoked.revokedByUserId).toBe(userId);
  });

  it('refuses a grant belonging to another project as absent', async () => {
    const goalId = await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const granted = await call('POST', `/projects/${projectId}/authority`, APPROVED);
      return granted.body.grant.id as string;
    });
    const result = await withRoutes(personPrincipal(userId, projectId), (call) =>
      call('POST', `/projects/prj_elsewhere/authority/${goalId}/revoke`, { reason: 'x' }),
    );
    expect(result.status).toBe(404);
  });
});

describe('enforcement is unchanged', () => {
  it('bounds work through the same reservation path a console grant did', async () => {
    const goalId = await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const granted = await call('POST', `/projects/${projectId}/authority`, APPROVED);
      return granted.body.grant.id as string;
    });

    /*
     * Two missions permitted, a third refused — through `reserve`, which is the
     * only thing that decides. The surface changed; the arbiter did not.
     */
    const first = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k1' });
    expect(first.ok).toBe(true);
    await getDb().run(`UPDATE russell_budget_reservations SET state = 'SETTLED' WHERE id = ?`, [
      first.reservation!.id,
    ]);
    const second = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k2' });
    expect(second.ok).toBe(true);
    await getDb().run(`UPDATE russell_budget_reservations SET state = 'SETTLED' WHERE id = ?`, [
      second.reservation!.id,
    ]);
    const third = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k3' });
    expect(third.ok).toBe(false);

    // And the panel counts what was actually spent, from the same table.
    const view = await authorityFor({ projectId });
    expect(view.grant!.spend.maxMissions.used).toBe(2);
    expect(view.grant!.spend.maxMissions.limit).toBe(2);
  });

  it('treats an expired grant as absent without anything having to run', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, {
        ...APPROVED,
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      expect(result.status).toBe(200);
    });
    // Asked as of a moment after it lapses. Expiry is derived from the clock
    // rather than swept, so nothing has to have run for it to be true.
    const later = await authorityFor({ projectId, now: '2031-01-01T00:00:00.000Z' });
    expect(later.grant).toBeNull();
    expect(later.history[0]!.endedReason).toMatch(/date it was set to run until/i);
  });
});

describe('the limits a person sets are the limits the validator enforces', () => {
  it('offers no limit the server would refuse', async () => {
    // The manifest lesson applied to a form: the contract shown and the
    // contract enforced are generated from one object, so a fourth surprise of
    // that shape has to get past a test first.
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const atMaximum = Object.fromEntries(
        AUTHORITY_LIMITS.map((limit) => [limit.key, limit.max]),
      ) as Record<string, number>;
      const result = await call('POST', `/projects/${projectId}/authority`, {
        name: 'everything at its ceiling',
        ...atMaximum,
        expiresAt: null,
      });
      expect(result.status).toBe(200);
    });
  });
});
