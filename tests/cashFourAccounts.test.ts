/**
 * Four private operations that must not be able to see each other.
 *
 * Cash Mode's privacy boundary is not a new mechanism — it is a
 * `project_memberships` row read through `decideProjectAccess`, which every
 * other surface in Brain already uses. That is the argument for it, and it is
 * also the reason it is worth driving at four accounts rather than one: a
 * boundary that separates nothing is exactly what §27 found when one worker
 * identity served every surface, and a single-tenant test cannot tell the
 * difference.
 *
 * So four people, four projects, four sprints, and every question asked over
 * HTTP as the person asking it. What is held to:
 *
 *   * each account sees its own operation and nobody else's, and the refusal
 *     for somebody else's project is byte-identical to the refusal for a
 *     project that does not exist — invariant 23, where a status code that
 *     matches while the body differs is still an oracle;
 *   * an idempotency key is not a way to reach another account's record,
 *     because the scope is built from server facts and the caller contributes
 *     nothing to it;
 *   * compatible openings proceed together, bounded by the concurrency a
 *     person set and by no count this code invented;
 *   * a declined opening can be offered privately to another operation,
 *     carrying the opening and none of the first owner's working;
 *   * and one account executing does not close the same opening for another,
 *     because there is no shared row to close.
 *
 * Nothing here contacts a buyer, takes a live payment or fires a worker.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  COMMERCIAL_ACTIONS,
} from '../server/services/cash/authority.ts';
import {
  beginExecution,
  capture,
  decline,
  fillCard,
  markReady,
  reoffer,
} from '../server/services/cash/opportunities.ts';
import { actionKey } from '../server/services/cash/opportunities.ts';
import { getOpportunity, listOpportunities } from '../server/repos/cashPortfolio.ts';
import { listCommitments } from '../server/repos/cashAuthority.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

interface Account {
  name: string;
  userId: string;
  projectId: string;
}

let accounts: Account[] = [];
let server: Server | null = null;
let port = 0;

function principalFor(account: Account): Principal {
  return {
    type: 'HUMAN',
    id: account.userId,
    handle: `${account.name}@example.test`,
    displayName: account.name,
    // Deliberately not a Brain administrator. A Brain administrator reaches
    // every project by design, so the four daily accounts must not be one —
    // §30 records that as a deployment fact, and this is the test that would
    // stop meaning anything if it were forgotten.
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `ses_${account.name}`,
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: `mem_${account.name}`,
        projectId: account.projectId,
        principalType: 'HUMAN',
        principalId: account.userId,
        role: 'ADMIN',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

/**
 * Whoever the next request is from.
 *
 * A module-level variable the middleware reads, which is only sound while
 * exactly one request is in flight — and in a suite about four people not
 * seeing each other's records, a request silently attributed to the wrong one
 * would make every assertion here meaningless while still passing. So two
 * overlapping calls are a loud failure rather than a race: the tests below are
 * strictly sequential and this is what keeps that a fact rather than a habit.
 */
let speaking: Account | null = null;
let inFlight = false;

async function as(
  account: Account,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any; text: string }> {
  if (inFlight) {
    throw new Error(
      'Two requests overlapped, so the principal this suite attributes them to is ambiguous. ' +
        'Await each call before making the next one.',
    );
  }
  inFlight = true;
  speaking = account;
  try {
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
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
  return { status: response.status, body: parsed as any, text };
  } finally {
    inFlight = false;
  }
}

async function grantTo(account: Account, maxConcurrent = 3): Promise<void> {
  await createAuthority({
    projectId: account.projectId,
    ownerUserId: account.userId,
    createdByUserId: account.userId,
    name: `${account.name}'s commercial authority`,
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000,
    maxPerActionCents: 100_000,
    maxConcurrent,
    currency: 'USD',
  });
}

/** An opening whose card is complete, so it can reach READY. */
async function readyOpening(account: Account, title: string): Promise<string> {
  const captured = await capture({
    projectId: account.projectId,
    actorRef: account.userId,
    ownerUserId: account.userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: account.userId,
    patch: {
      payer: 'The manager who signs',
      reachableChannel: 'The address on the notice',
      buyingSignal: 'Asked for a fixed quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope repair',
      acceptanceCondition: 'It works and a test enquiry arrives',
      priceCents: 60_000,
      deliveryMethod: 'One afternoon',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  const ready = await markReady({ opportunityId: captured.value.id, actorRef: account.userId });
  if (!ready.ok) throw new Error(ready.reason);
  return captured.value.id;
}

beforeEach(async () => {
  const first = await freshProject();
  accounts = [];
  for (const [index, name] of ['ana', 'ben', 'cleo', 'dev'].entries()) {
    const user = await createUser({
      email: `${name}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      displayName: name,
      password: 'correct horse battery staple',
    });
    const project =
      index === 0
        ? first.project
        : await createProject({
            name: `${name}'s operation`,
            slug: `${name}-${Math.random().toString(36).slice(2, 8)}`,
          });
    await grantMembership({
      projectId: project.id,
      principalType: 'HUMAN',
      principalId: user.id,
      role: 'ADMIN',
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    const account = { name, userId: user.id, projectId: project.id };
    expect(
      (
        await activate({
          projectId: project.id,
          ownerUserId: user.id,
          actorUserId: user.id,
          objective: `${name} wants more usable cash over the next few weeks.`,
        })
      ).ok,
    ).toBe(true);
    accounts.push(account);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principalFor(speaking ?? accounts[0]!),
      requestId: newRequestId(),
      method: req.method,
      path: `/api${req.path}`,
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
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  speaking = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('four operations, four walls', () => {
  it('shows each person their own operation and nobody else’s', async () => {
    for (const account of accounts) {
      await readyOpening(account, `${account.name}'s opening`);
    }

    for (const account of accounts) {
      const mine = await as(account, 'GET', '/cash/operations');
      expect(mine.status).toBe(200);
      expect(mine.body.operations.map((one: { projectId: string }) => one.projectId)).toEqual([
        account.projectId,
      ]);

      const view = await as(account, 'GET', `/projects/${account.projectId}/cash`);
      expect(view.status).toBe(200);
      const titles = view.body.myCurrentWork.placements.map(
        (one: { opportunity: { title: string } }) => one.opportunity.title,
      );
      expect(titles).toEqual([`${account.name}'s opening`]);
    }
  });

  it('refuses another account’s project in the same words as one that does not exist', async () => {
    const [ana, ben] = accounts as [Account, Account];

    const theirs = await as(ana, 'GET', `/projects/${ben.projectId}/cash`);
    const invented = await as(ana, 'GET', '/projects/prj_does_not_exist/cash');

    expect(theirs.status).toBe(404);
    expect(invented.status).toBe(404);
    // The body too, not only the status: a status code that matches while the
    // body differs is still an oracle for enumerating a Brain you cannot see.
    expect(theirs.text).toBe(invented.text);
  });

  it('will not let an idempotency key reach another account’s commitment', async () => {
    const [ana, ben] = accounts as [Account, Account];
    await grantTo(ana);
    await grantTo(ben);

    // Each of them has their own money, because a commitment has to fit the
    // funds that are actually there.
    for (const [account, amount] of [[ana, 100_000], [ben, 100_000]] as const) {
      const funded = await as(account, 'POST', `/projects/${account.projectId}/cash/money`, {
        kind: 'CAPITAL_IN',
        amountCents: amount,
        currency: 'USD',
        verifiedReference: `opening-balance-${account.name}`,
        idempotencyKey: `capital:${account.name}`,
      });
      expect(funded.status).toBe(200);
    }

    const shared = 'the-same-key-both-typed';
    const hers = await as(ana, 'POST', `/projects/${ana.projectId}/cash/commitments`, {
      action: 'RUN_PAID_TEST',
      amountCents: 12_000,
      purpose: 'A test of the intake path',
      expectedResult: 'One reply',
      stopCondition: 'No reply in a week',
      idempotencyKey: shared,
    });
    expect(hers.status).toBe(200);

    const his = await as(ben, 'POST', `/projects/${ben.projectId}/cash/commitments`, {
      action: 'RUN_PAID_TEST',
      amountCents: 34_000,
      purpose: 'Something entirely his own',
      expectedResult: 'A quote',
      stopCondition: 'No answer by Friday',
      idempotencyKey: shared,
    });
    expect(his.status).toBe(200);

    // His own, at his own amount — not a replay of hers, which is what a
    // caller-contributed scope would have produced.
    expect(his.body.commitment.amountCents).toBe(34_000);
    expect(his.body.commitment.projectId).toBe(ben.projectId);
    expect(his.body.commitment.id).not.toBe(hers.body.commitment.id);
    expect(his.text).not.toContain('A test of the intake path');

    expect((await listCommitments(ana.projectId)).map((one) => one.amountCents)).toEqual([
      12_000,
    ]);
    expect((await listCommitments(ben.projectId)).map((one) => one.amountCents)).toEqual([
      34_000,
    ]);
  });

  it('lets compatible openings proceed together, bounded by what a person set and nothing else', async () => {
    const [ana] = accounts as [Account];
    await grantTo(ana, 3);

    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await readyOpening(ana, `Opening ${index}`));
    }

    // Three proceed, because three is the concurrency this person chose.
    for (const id of ids.slice(0, 3)) {
      const began = await beginExecution({
        opportunityId: id,
        actorRef: ana.userId,
        firstAction: {
          action: 'CONTACT_BUYER',
          performedBy: 'PERSON',
          detail: 'Replied to the notice by hand.',
          requestKey: actionKey(id, 'CONTACT_BUYER', '1'),
        },
      });
      expect(began.ok).toBe(true);
    }
    expect(
      (await listOpportunities({ projectId: ana.projectId, states: ['EXECUTING'] })).length,
    ).toBe(3);

    // The fourth waits on the slot, and the refusal says *capacity* rather
    // than anything about the opening — there is no count in this code that a
    // person did not set.
    const fourth = await beginExecution({
      opportunityId: ids[3]!,
      actorRef: ana.userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Replied to the notice by hand.',
        requestKey: actionKey(ids[3]!, 'CONTACT_BUYER', '1'),
      },
    });
    expect(fourth.ok).toBe(false);
    if (fourth.ok) throw new Error('unreachable');
    expect(fourth.reason).toContain('execution slots are taken');
    expect(fourth.reason).toContain('fulfilment capacity');
    // And the two still waiting are untouched rather than closed.
    for (const id of ids.slice(3)) {
      expect((await getOpportunity(id))!.state).toBe('READY');
    }
  });

  it('offers a declined opening to another operation, carrying none of the first owner’s working', async () => {
    const [ana, , cleo] = accounts as [Account, Account, Account];
    const id = await readyOpening(ana, 'A published intake repair');

    const passed = await decline({
      opportunityId: id,
      actorUserId: ana.userId,
      reason: 'Not the kind of work I want this month.',
    });
    expect(passed.ok).toBe(true);

    const offered = await reoffer({
      opportunityId: id,
      toProjectId: cleo.projectId,
      toOwnerUserId: cleo.userId,
      actorUserId: ana.userId,
      reason: 'It suits her setup better.',
    });
    expect(offered.ok).toBe(true);
    if (!offered.ok) throw new Error('unreachable');

    const copy = offered.value;
    expect(copy.projectId).toBe(cleo.projectId);
    expect(copy.reofferedFromId).toBe(id);
    // The opening travelled; the working did not. Her payer notes and her
    // quoted price are hers.
    expect(copy.payer).toBeNull();
    expect(copy.priceCents).toBeNull();
    expect(copy.acceptanceCondition).toBeNull();

    // And the first owner keeps the whole of her own record.
    const original = (await getOpportunity(id))!;
    expect(original.state).toBe('DECLINED');
    expect(original.declinedReason).toContain('Not the kind of work');
    expect(original.priceCents).toBe(60_000);

    // Each of them works exactly one of the two rows.
    const hers = await as(ana, 'GET', `/projects/${ana.projectId}/cash`);
    const theirs = await as(cleo, 'GET', `/projects/${cleo.projectId}/cash`);
    const held = (view: { body: any }): string[] =>
      view.body.myCurrentWork.placements.map((one: { opportunity: { id: string } }) => one.opportunity.id);
    expect(held(hers)).toEqual([id]);
    expect(held(theirs)).toEqual([copy.id]);

    /*
     * Her history names the copy and the project she sent it to, and that is
     * right rather than a leak: she made that decision, and §30 says nothing
     * moves between private operations without a row naming who moved it and
     * why. What must not travel is the other direction — nothing of hers
     * reaches the operation she offered it to.
     */
    expect(hers.text).toContain(copy.id);

    /*
     * The copy carries the id it came from, and that is provenance rather than
     * a leak — but only because the id is not an oracle. So this asks: holding
     * it, can she read it? She gets the same refusal, in the same words, as for
     * an id nobody ever issued.
     */
    expect(theirs.text).toContain(id);
    const reaching = await as(cleo, 'GET', `/cash/opportunities/${id}`);
    const invented = await as(cleo, 'GET', '/cash/opportunities/cop_never_issued');
    expect(reaching.status).toBe(404);
    expect(reaching.text).toBe(invented.text);

    // And none of her working came with it: not the price, not the payer, and
    // not the reason she passed.
    expect(theirs.text).not.toContain('Not the kind of work');
    expect(theirs.text).not.toContain('The manager who signs');
    expect(theirs.text).not.toContain('60000');
  });

  it('does not close an opening for one account because another is working it', async () => {
    const [ana, ben] = accounts as [Account, Account];
    await grantTo(ana);

    // The same published request, found independently by two operations —
    // which is the ordinary case, because an opening is a row per project
    // rather than one object several people hold.
    const hers = await readyOpening(ana, 'Intake form repair, posted publicly');
    const his = await readyOpening(ben, 'Intake form repair, posted publicly');
    expect(hers).not.toBe(his);

    const began = await beginExecution({
      opportunityId: hers,
      actorRef: ana.userId,
      firstAction: {
        action: 'CONTACT_BUYER',
        performedBy: 'PERSON',
        detail: 'Replied to the notice by hand.',
        requestKey: actionKey(hers, 'CONTACT_BUYER', '1'),
      },
    });
    expect(began.ok).toBe(true);

    // His is exactly as it was: no shared state, so there is nothing for her
    // decision to close. Parallel fulfilment is a fact about the rows rather
    // than a policy anybody has to enforce.
    const mine = (await getOpportunity(his))!;
    expect(mine.state).toBe('READY');
    expect(mine.exhaustedAt).toBeNull();
    expect(mine.expiresAt).toBeNull();

    const view = await as(ben, 'GET', `/projects/${ben.projectId}/cash`);
    expect(view.status).toBe(200);
    expect(
      view.body.myCurrentWork.placements.map(
        (one: { opportunity: { state: string } }) => one.opportunity.state,
      ),
    ).toEqual(['READY']);
  });
});
