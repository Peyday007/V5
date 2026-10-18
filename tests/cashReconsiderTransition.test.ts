/**
 * Reconsidering an archived or declined opportunity (OPPORTUNITY-INTELLIGENCE
 * §3.2(d)(e), assignment A), over the real `cashRouter` and the real rows.
 *
 * The properties that make reconsideration safe rather than a loophole, each
 * asserted against the row rather than against a response:
 *
 *   * it destroys nothing — the archive or decline reason, the conditions and
 *     the history all stay;
 *   * it is refused from every live state;
 *   * it never lands a piece in READY, whatever the caller asks for;
 *   * a worker principal is refused by type, and nothing moves;
 *   * a project the caller may not read answers the same 404, with the same
 *     body, as an id that does not exist;
 *   * the same change can never reconsider the same opportunity twice — the
 *     owner's replacement for a lifetime count.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { archiveOpportunity, capture, reconsider } from '../server/services/cash/opportunities.ts';
import { getOpportunity, transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import {
  consumeChange,
  recordReopenCondition,
  reconsiderationTriggersFor,
  reopenConditionsFor,
  requestReconsideration,
  triggerReopenCondition,
} from '../server/repos/cashReconsideration.ts';
import { listCashEventsFor } from '../server/repos/cashMode.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { parseBlockerKey } from '../server/domain/types.ts';
import type { CashOpportunityState, Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let foreignProjectId = '';
let userId = '';
let server: Server | null = null;
let base = '';
type Role = 'OWNER' | 'WORKER';
let role: Role = 'OWNER';

function membership(project: string, principalId: string, type: 'HUMAN' | 'WORKER'): ProjectMembership {
  return {
    id: `mem-${project}`,
    projectId: project,
    principalType: type,
    principalId,
    role: type === 'HUMAN' ? 'ADMIN' : 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
    grantedAt: '2026-01-01T00:00:00.000Z',
    active: true,
  } as ProjectMembership;
}

function principalFor(current: Role): Principal {
  if (current === 'WORKER') {
    return {
      type: 'WORKER',
      id: 'wkr_test',
      handle: 'a-worker',
      displayName: 'A worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'cre_worker',
      authMethod: 'WORKER_BEARER',
      memberships: [membership(projectId, 'wkr_test', 'WORKER')],
      requestId: 'req',
    } as Principal;
  }
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_owner',
    authMethod: 'SESSION_COOKIE',
    // Deliberately no membership on `foreignProjectId`.
    memberships: [membership(projectId, userId, 'HUMAN')],
    requestId: 'req',
  } as Principal;
}

async function post(route: string, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, text, json };
}

async function newPiece(project = projectId, title = 'An opening worth a look'): Promise<string> {
  const captured = await capture({
    projectId: project,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities: ['SEND_A_MESSAGE'],
  });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const foreign = await createProject({
    name: 'Somebody else’s operation',
    slug: `foreign-${Math.random().toString(36).slice(2, 10)}`,
  });
  foreignProjectId = foreign.id;
  const user = await createUser({
    email: `owner-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  for (const project of [projectId, foreignProjectId]) {
    const activated = await activate({
      projectId: project,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(activated.ok).toBe(true);
  }

  role = 'OWNER';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principalFor(role),
      requestId: newRequestId(),
      method: req.method,
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', cashRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('archiving records reopen conditions, and reconsidering destroys nothing', () => {
  it('pre-fills Brain’s proposal on archive and keeps the reason through a reconsideration', async () => {
    const id = await newPiece();
    const archived = await post(`/api/cash/opportunities/${id}/archive`, {
      reason: 'No way to message the buyer yet.',
    });
    expect(archived.status).toBe(200);

    // The proposal came from the row: SEND_A_MESSAGE is required and not PRESENT.
    const conditions = await reopenConditionsFor(id);
    expect(conditions.map((one) => one.blockerKey)).toEqual(['CAPABILITY:SEND_A_MESSAGE']);
    expect(conditions[0]!.recordedFrom).toBe('ARCHIVE');
    expect(conditions[0]!.observedAtRecord).toBe('MISSING');

    const back = await post(`/api/cash/opportunities/${id}/reconsider`, {
      reason: 'A messaging integration might be connected soon.',
    });
    expect(back.status).toBe(200);
    const after = (await getOpportunity(id))!;
    expect(after.state).toBe('DISCOVERED');
    expect(after.archivedReason).toBe('No way to message the buyer yet.');
    expect(after.diveEpochStartedAt).not.toBeNull();
    expect(after.reconsiderRequestedAt).not.toBeNull();
    expect(after.lastReconsiderChangeRef).toMatch(/^PERSON:/);
    // The condition row is still there, and the history has both events.
    expect(await reopenConditionsFor(id)).toHaveLength(1);
    const kinds = (await listCashEventsFor(id)).map((event) => event.kind);
    expect(kinds).toContain('CASH_OPPORTUNITY_ARCHIVED');
    expect(kinds).toContain('CASH_OPPORTUNITY_RECONSIDERED');
  });

  it('honours an explicit empty list as "nothing would reopen it"', async () => {
    const id = await newPiece();
    const archived = await post(`/api/cash/opportunities/${id}/archive`, {
      reason: 'Not for us.',
      reopenWhen: [],
    });
    expect(archived.status).toBe(200);
    expect(await reopenConditionsFor(id)).toHaveLength(0);
  });

  it('refuses a malformed reopen key before anything moves', async () => {
    const id = await newPiece();
    const refused = await post(`/api/cash/opportunities/${id}/archive`, {
      reason: 'Stop.',
      reopenWhen: ['WHENEVER:soon'],
    });
    expect(refused.status).toBe(422);
    expect((await getOpportunity(id))!.state).toBe('DISCOVERED');
    expect(await reopenConditionsFor(id)).toHaveLength(0);
  });

  it('records a decline’s named conditions and reconsiders from DECLINED', async () => {
    const id = await newPiece();
    const declined = await post(`/api/cash/opportunities/${id}/decline`, {
      reason: 'Needs a grant I have not given.',
      reopenWhen: ['AUTHORITY:CONTACT_BUYER', 'PERSON'],
    });
    expect(declined.status).toBe(200);
    expect((await reopenConditionsFor(id)).map((one) => one.blockerKey).sort()).toEqual([
      'AUTHORITY:CONTACT_BUYER',
      'PERSON',
    ]);
    const back = await post(`/api/cash/opportunities/${id}/reconsider`, {
      reason: 'Granted now.',
      to: 'EVIDENCE_CARD',
    });
    expect(back.status).toBe(200);
    const after = (await getOpportunity(id))!;
    expect(after.state).toBe('EVIDENCE_CARD');
    expect(after.declinedReason).toBe('Needs a grant I have not given.');
  });
});

describe('what reconsideration refuses', () => {
  it('is refused from every live state', async () => {
    const live: CashOpportunityState[] = ['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING', 'COLLECTED'];
    for (const state of live) {
      const id = await newPiece(projectId, `Live piece in ${state}`);
      if (state !== 'DISCOVERED') {
        expect(await transitionOpportunity({ id, from: ['DISCOVERED'], to: state })).toBe(true);
      }
      const refused = await post(`/api/cash/opportunities/${id}/reconsider`, { reason: 'Look again.' });
      expect(refused.status, state).toBe(422);
      expect((await getOpportunity(id))!.state).toBe(state);
    }
  });

  it('never lands in READY, whatever is asked for', async () => {
    const id = await newPiece();
    await archiveOpportunity({ opportunityId: id, actorRef: userId, reason: 'Stop.' });
    for (const to of ['READY', 'EXECUTING', 'COLLECTED']) {
      const refused = await post(`/api/cash/opportunities/${id}/reconsider`, { reason: 'Go.', to });
      expect(refused.status).toBe(400);
    }
    // And the service refuses it too, for a caller that skips the route.
    const direct = await reconsider({ opportunityId: id, actorUserId: userId, reason: 'Go.', to: 'READY' });
    expect(direct.ok).toBe(false);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');
  });

  it('refuses a worker principal by type, and nothing moves', async () => {
    const id = await newPiece();
    await archiveOpportunity({ opportunityId: id, actorRef: userId, reason: 'Stop.' });
    role = 'WORKER';
    const refused = await post(`/api/cash/opportunities/${id}/reconsider`, { reason: 'Machine says go.' });
    expect(refused.status).toBe(404);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');
    expect(await reconsiderationTriggersFor(id)).toHaveLength(0);
  });

  it('answers a project the caller may not read with the same 404 body as a missing id', async () => {
    const foreign = await newPiece(foreignProjectId, 'Somebody else’s opening');
    await archiveOpportunity({ opportunityId: foreign, actorRef: userId, reason: 'Stop.' });
    const forbidden = await post(`/api/cash/opportunities/${foreign}/reconsider`, { reason: 'Go.' });
    const missing = await post('/api/cash/opportunities/cop_doesnotexist0000/reconsider', {
      reason: 'Go.',
    });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(forbidden.text).toBe(missing.text);
    expect((await getOpportunity(foreign))!.state).toBe('ARCHIVED');
  });
});

describe('a change reconsiders a piece once', () => {
  it('the same change ref can never trigger the same opportunity twice', async () => {
    const id = await newPiece();
    await archiveOpportunity({
      opportunityId: id,
      actorRef: userId,
      reason: 'Waiting on messaging.',
      reopenWhen: ['CAPABILITY:SEND_A_MESSAGE'],
    });
    const [first] = await reopenConditionsFor(id);
    const ref = 'capabilities@2026-10-18T00:00:00.000Z';
    expect(await triggerReopenCondition({ conditionId: first!.id, changeRef: ref })).toBe(true);
    // The same condition, the same change: stamped once.
    expect(await triggerReopenCondition({ conditionId: first!.id, changeRef: ref })).toBe(false);

    // A person answers it.
    const back = await reconsider({
      opportunityId: id,
      actorUserId: userId,
      reason: 'Messaging is connected.',
      conditionId: first!.id,
    });
    expect(back.ok).toBe(true);
    expect((await getOpportunity(id))!.lastReconsiderChangeRef).toBe(ref);

    // Archived again with the same key: a new watch, which the old change cannot meet.
    await archiveOpportunity({
      opportunityId: id,
      actorRef: userId,
      reason: 'Still no buyer.',
      reopenWhen: ['CAPABILITY:SEND_A_MESSAGE'],
    });
    const live = (await reopenConditionsFor(id)).filter((one) => one.triggeredAt === null);
    expect(live).toHaveLength(1);
    expect(await triggerReopenCondition({ conditionId: live[0]!.id, changeRef: ref })).toBe(false);
    expect((await getReopenConditionsTriggered(id)).length).toBe(1);

    // Naming the first, already-answered condition again is refused too.
    const again = await reconsider({
      opportunityId: id,
      actorUserId: userId,
      reason: 'Once more.',
      conditionId: first!.id,
    });
    expect(again.ok).toBe(false);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');

    // A genuinely distinct change still can.
    expect(
      await triggerReopenCondition({ conditionId: live[0]!.id, changeRef: 'capabilities@2026-10-19T00:00:00.000Z' }),
    ).toBe(true);
  });

  it('a live request consumes its change once, and never touches a person’s archive', async () => {
    const id = await newPiece();
    const key = parseBlockerKey('CAPABILITY:SEND_A_MESSAGE');
    expect(await requestReconsideration({ projectId, opportunityId: id, changeRef: 'r1', blockerKey: key })).toBe(true);
    expect(await requestReconsideration({ projectId, opportunityId: id, changeRef: 'r1', blockerKey: key })).toBe(false);
    expect((await getOpportunity(id))!.lastReconsiderChangeRef).toBe('r1');

    await archiveOpportunity({ opportunityId: id, actorRef: userId, reason: 'Stop.' });
    expect(await requestReconsideration({ projectId, opportunityId: id, changeRef: 'r2' })).toBe(false);
    // The refused flag rolled its consumption back, so r2 is still unconsumed.
    expect(
      await consumeChange({ projectId, opportunityId: id, changeRef: 'r2', kind: 'LIVE_REQUEST' }),
    ).toBe(true);
    expect((await getOpportunity(id))!.state).toBe('ARCHIVED');
  });

  it('records one live watch per key, however many times it is named', async () => {
    const id = await newPiece();
    const key = parseBlockerKey('DATE:2026-12-01')!;
    const a = await recordReopenCondition({ projectId, opportunityId: id, blockerKey: key, recordedFrom: 'EXPIRY', actorRef: 'BRAIN' });
    const b = await recordReopenCondition({ projectId, opportunityId: id, blockerKey: key, recordedFrom: 'EXPIRY', actorRef: 'BRAIN' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.condition.id).toBe(a.condition.id);
  });
});

async function getReopenConditionsTriggered(id: string) {
  return (await reopenConditionsFor(id)).filter((one) => one.triggeredAt !== null);
}
