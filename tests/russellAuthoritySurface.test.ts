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

/*
 * What the card sends now: a name, the one real limit, and a date.
 *
 * The three cumulative numbers are gone from the route entirely. They were
 * lifetime quotas on work a paid subscription performs, and a grant that
 * stopped after two pieces of research needed replenishing rather than
 * deciding anything.
 */
const APPROVED = {
  name: 'Deal Dispatch discovery research',
  maxConcurrent: 1,
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
    expect(view.suggested.maxConcurrent).toBe(1);
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
      // Continuous work, and the one limit that is real. A sentence promising
      // "at most 2 pieces of research" against a policy that stops at none
      // would be the card lying about the validator.
      expect(permits.some((line) => /as long as there is work worth doing/i.test(line))).toBe(true);
      expect(permits.some((line) => /at most 1 investigation at a time/i.test(line))).toBe(true);
      expect(permits.some((line) => /as many bounded questions as the evidence/i.test(line))).toBe(
        true,
      );
      expect(permits.some((line) => /at most \d+ (piece|pieces) of research/i.test(line))).toBe(
        false,
      );
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

describe('the agreed proposal, end to end', () => {
  /*
   * Exactly what the Approve button submits — the payload
   * `tests/russellShell.test.tsx` pins from the request body — posted at the
   * server and read back from the row.
   *
   * The two halves are asserted in different files because they are different
   * risks: the screen can send the wrong thing, and the server can store
   * something other than what it was sent. Proving one has never proved the
   * other, and the expiry is where that would show: a value silently widened
   * to unlimited, or pushed to the end of the day, reads identically on the
   * card that sent it.
   */
  const AS_THE_CARD_SENDS_IT = {
    name: 'Deal Dispatch discovery research',
    maxConcurrent: 1,
    expiresAt: '2026-10-06T00:00:00.000Z',
  };

  it('stores the agreed proposal exactly, expiry included', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, AS_THE_CARD_SENDS_IT);
      expect(result.status).toBe(200);
    });

    const goal = (await listGoals(projectId))[0]!;
    expect(goal.name).toBe('Deal Dispatch discovery research');
    expect(goal.allowedWork).toEqual(['RESEARCH']);
    expect(goal.maxConcurrent).toBe(1);
    /*
     * Uncapped, explicitly, and written by the server rather than sent. A
     * grant that could name its own policy would be a grant that could ration
     * itself — or not — on a caller's say-so.
     */
    expect(goal.workPolicy).toBe('UNCAPPED');
    // Zero in the three columns that no longer cap anything. Not a large
    // number pretending to be unlimited: the policy is what decides, and if it
    // were ever read wrongly these zeroes refuse the first mission rather than
    // hiding the mistake behind a ceiling nobody reaches.
    expect(goal.maxMissions).toBe(0);
    expect(goal.maxFragments).toBe(0);
    expect(goal.maxProbes).toBe(0);
    // The instant that was agreed, not the end of that day and not null.
    expect(goal.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(goal.state).toBe('ACTIVE');
    // Paid spending at zero, from the schema default rather than the request:
    // there is no field on this route that could raise it.
    expect(goal.maxExternalSpend).toBe(0);
    // And the prohibitions nobody supplies.
    expect(goal.prohibitions).toContain('PAID_OVERAGE');
    expect(goal.prohibitions).toContain('NEW_SPENDING');
  });

  it('reads back as a live permission with what it permits, and lapses on its own date', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      await call('POST', `/projects/${projectId}/authority`, AS_THE_CARD_SENDS_IT);
    });

    const live = await authorityFor({ projectId, now: '2026-09-08T00:00:00.000Z' });
    expect(live.grant).toBeTruthy();
    expect(live.grant!.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(live.grant!.permits.some((line) => /until 2026-10-06/.test(line))).toBe(true);

    // One second after it, it is gone — derived from the clock, with nothing
    // having had to run.
    const after = await authorityFor({ projectId, now: '2026-10-06T00:00:01.000Z' });
    expect(after.grant).toBeNull();
    expect(after.history[0]!.endedReason).toMatch(/date it was set to run until/i);
  });

  it('proposes the same thing every time it is read, and creates nothing by being read', async () => {
    const first = await authorityFor({ projectId });
    const second = await authorityFor({ projectId });
    expect(first.suggestedApproval).toEqual(second.suggestedApproval);
    // A rollout expiry that moved with the clock would mean refreshing the
    // page quietly extended what was about to be approved.
    expect(first.suggestedApproval.expiresAt).toBe('2026-10-06T00:00:00.000Z');
    expect(first.suggestedApproval.name).toBe('Deal Dispatch discovery research');
    expect(await listGoals(projectId)).toHaveLength(0);
  });
});

describe('the limits are refused rather than defaulted', () => {
  it('refuses a missing, fractional, negative or over-large number', async () => {
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      for (const bad of [
        { ...APPROVED, maxConcurrent: undefined },
        { ...APPROVED, maxConcurrent: 1.5 },
        { ...APPROVED, maxConcurrent: -1 },
        { ...APPROVED, maxConcurrent: 999 },
        { ...APPROVED, maxConcurrent: '1' },
        { ...APPROVED, name: '' },
      ]) {
        const result = await call('POST', `/projects/${projectId}/authority`, bad);
        expect(result.status, JSON.stringify(bad)).toBe(400);
      }
      // And none of them created anything.
      expect(await listGoals(projectId)).toHaveLength(0);
    });
  });

  it('ignores a cumulative quota somebody sends anyway', async () => {
    /*
     * There was a check here refusing "more at a time than in total", which
     * was the right refusal while a total existed. There is no total now, so
     * the interesting property is the other one: a caller who sends the old
     * fields — a stale client, a script, somebody trying — does not get them
     * back. The route reads `maxConcurrent` and nothing else.
     */
    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const result = await call('POST', `/projects/${projectId}/authority`, {
        ...APPROVED,
        maxMissions: 99,
        maxFragments: 99,
        maxProbes: 99,
      });
      expect(result.status).toBe(200);
    });
    const goal = (await listGoals(projectId))[0]!;
    expect(goal.workPolicy).toBe('UNCAPPED');
    expect(goal.maxMissions).toBe(0);
    expect(goal.maxFragments).toBe(0);
    expect(goal.maxProbes).toBe(0);
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
        maxConcurrent: 5,
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

describe('there is nothing to raise', () => {
  it('has no raise route at all, because there is no ceiling to reach', async () => {
    /*
     * There was one, and it was right for what it answered: "the standing
     * authority allows 2 missions in total" needed a reply that did not
     * silently refund the spend or mint a new grant. The escalation itself was
     * the defect. A subscription-backed Brain that stops after N pieces of
     * research and waits to be topped up is managing an allowance rather than
     * doing the work, and under the UNCAPPED policy there is no N.
     *
     * Kept as a test rather than deleted with the code: a raise control is
     * exactly the kind of thing that comes back, and a route that could move
     * `maxConcurrent` would be a way to raise simultaneous consumption from a
     * chat surface — which is a fleet decision with its own actor and reason.
     */
    const goalId = await withRoutes(personPrincipal(userId, projectId), async (call) => {
      const granted = await call('POST', `/projects/${projectId}/authority`, APPROVED);
      return granted.body.grant.id as string;
    });

    await withRoutes(personPrincipal(userId, projectId), async (call) => {
      for (const ceiling of ['maxMissions', 'maxFragments', 'maxProbes', 'maxConcurrent']) {
        const result = await call('POST', `/projects/${projectId}/authority/${goalId}/raise`, {
          ceiling,
          to: 99,
          reason: 'r',
        });
        expect(result.status, ceiling).toBe(404);
      }
    });

    const goals = await listGoals(projectId);
    expect(goals).toHaveLength(1);
    expect(goals[0]!.maxConcurrent).toBe(1);
    expect(goals[0]!.workPolicy).toBe('UNCAPPED');
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
     * One mission at a time, and the next one the moment it finishes — through
     * `reserve`, which is the only thing that decides. The surface changed and
     * the policy changed; the arbiter did neither.
     */
    const first = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k1' });
    expect(first.ok).toBe(true);
    // A second *while it runs* is refused, because concurrency is real.
    const overlapping = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k2' });
    expect(overlapping.ok).toBe(false);
    expect(overlapping.refusedBy).toBe('AT_ONCE');

    await getDb().run(`UPDATE russell_budget_reservations SET state = 'SETTLED' WHERE id = ?`, [
      first.reservation!.id,
    ]);
    const second = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k2' });
    expect(second.ok).toBe(true);
    await getDb().run(`UPDATE russell_budget_reservations SET state = 'SETTLED' WHERE id = ?`, [
      second.reservation!.id,
    ]);
    // The third is where a grant used to stop. It does not.
    const third = await reserve({ goalId, kind: 'MISSION', idempotencyKey: 'k3' });
    expect(third.ok).toBe(true);

    // And the panel counts what was actually spent, from the same table —
    // with no denominator to replenish.
    const view = await authorityFor({ projectId });
    expect(view.grant!.spend.maxMissions.used).toBe(3);
    expect(view.grant!.spend.maxMissions.limit).toBeNull();
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
