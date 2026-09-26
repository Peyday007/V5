/**
 * Committing spend, and settling what it actually cost — over the real seam.
 *
 * The ceiling a person grants in the Authority card used to be spent by
 * nothing a person could press, and a hold that was actually spent could only
 * be released (which records nothing spent) rather than settled. Both server
 * routes — `commitSpend` and `settleSpend` — already existed and worked;
 * nothing in the client called either. This drives the real controls Brain's
 * MyCash section now offers, over a real Express app holding the actual
 * `cashRouter` over the actual database, the same shape as
 * `cashBrowserToDatabase.test.ts` beside it: nothing between the click and the
 * row is a fixture.
 *
 * It is a `.ts` file for the same reason that one is: Vitest applies the web
 * transform to every `.tsx` module whatever the environment says, so the one
 * piece of JSX this needs is written with `createElement`. And the per-file
 * jsdom directive every other component suite carries cannot be used here
 * either — the web transform rewrites `import.meta.url` to an http URL,
 * `server/env.ts` resolves the repository root out of it, and importing any
 * server module then fails before a test runs. So the environment stays
 * `node`, and the document is built by hand below.
 *
 * Three roles read this page, and each gets what it should:
 *
 *   * the owner, who may commit and settle under a standing grant;
 *   * an ordinary member of this Brain who is not a member of this project,
 *     who reads the shared frontier and none of the private money on it;
 *   * a worker, refused by type at both routes before anything is read.
 *
 * Nothing here contacts a buyer, takes a live payment, or fires a worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createAuthority, getCommitment, listCommitments } from '../server/repos/cashAuthority.ts';
import { COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { commitSpend, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { CashSection } = await import('../client/src/russell/Cash.tsx');

/** The same presentation the page uses, so an assertion reads what a person reads. */
function money(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${currency} ${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

let projectId = '';
let ownerId = '';
let memberId = '';
let server: Server | null = null;
let port = 0;
const realFetch = globalThis.fetch;

/** Which principal the next request is authenticated as. Reset every test. */
let speaking: 'OWNER' | 'MEMBER' | 'WORKER' = 'OWNER';

/** Every POST body this test has seen leave the browser, in order. */
let capturedBodies: { url: string; body: unknown }[] = [];
/** How many times the private view was re-read from the server. */
let viewFetchCount = 0;

function ownerPrincipal(): Principal {
  return {
    type: 'HUMAN',
    id: ownerId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_owner',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem_owner',
        projectId,
        principalType: 'HUMAN',
        principalId: ownerId,
        role: 'ADMIN',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req_owner',
  } as Principal;
}

/**
 * An ordinary enrolled member of this Brain, and nothing more.
 *
 * No membership row on this project at all — which is exactly the shape
 * `decideCashRead` answers `SHARED` for: a genuine person, reading the one
 * project that holds the shared frontier, who never reached it through
 * `decideProjectAccess`.
 */
function memberPrincipal(): Principal {
  return {
    type: 'HUMAN',
    id: memberId,
    handle: 'member@example.test',
    displayName: 'An ordinary member',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_member',
    authMethod: 'SESSION_COOKIE',
    memberships: [],
    requestId: 'req_member',
  } as Principal;
}

function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: 'wrk_1',
    handle: 'a-worker',
    displayName: 'A worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_worker',
    authMethod: 'WORKER_BEARER',
    memberships: [
      { projectId, role: null, scopes: ['project:read'], active: true },
    ] as unknown as Principal['memberships'],
    requestId: 'req_worker',
  } as Principal;
}

function principalFor(): Principal {
  if (speaking === 'MEMBER') return memberPrincipal();
  if (speaking === 'WORKER') return workerPrincipal();
  return ownerPrincipal();
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  speaking = 'OWNER';
  capturedBodies = [];
  viewFetchCount = 0;

  const owner = await createUser({
    email: `owner-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  ownerId = owner.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: ownerId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const member = await createUser({
    email: `member-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'An ordinary member',
    password: 'correct horse battery staple',
  });
  memberId = member.id;
  // Deliberately no `grantMembership` for the member: no row on this project
  // at all is the shape a SHARED reader actually has.

  expect(
    (
      await activate({
        projectId,
        ownerUserId: ownerId,
        actorUserId: ownerId,
        objective: 'Maximize additional usable cash over the next few weeks.',
      })
    ).ok,
  ).toBe(true);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principalFor(),
      requestId: newRequestId(),
      // The path the policy module matches on, which is the one the request
      // already carries. `req.path` in a middleware registered with no mount
      // path is the whole path, so prefixing `/api` again yields `/api/api/…`,
      // which matches no pattern in `services/identity/policy.ts` and falls
      // silently to the default `READ` — every write in this harness would
      // then be authorized at the wrong level, and a refusal asserted against
      // one would be vacuous.
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

  // Port 0: the operating system picks, so this suite cannot collide with any
  // other one's range.
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;

  // The one substitution, and it is the address rather than the answer, plus
  // a passive record of what left the browser — never a mock of the server.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (typeof init?.body === 'string') {
      try {
        capturedBodies.push({ url, body: JSON.parse(init.body) });
      } catch {
        capturedBodies.push({ url, body: init.body });
      }
    }
    if (/\/api\/projects\/[^/]+\/cash$/.test(url) && (!init?.method || init.method === 'GET')) {
      viewFetchCount += 1;
    }
    return await realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function mount(): Promise<void> {
  await act(async () => {
    render(createElement(CashSection, { projectId, isBrainAdmin: false }));
  });
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Cash' })).toBeTruthy());
}

async function type(label: RegExp, value: string): Promise<void> {
  const fields = await screen.findAllByLabelText(label);
  await act(async () => {
    fireEvent.change(fields[0]!, { target: { value } });
  });
}

async function press(label: RegExp): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: label });
  await act(async () => {
    fireEvent.click(buttons[0]!);
  });
}

/** A live grant, with a known, non-empty, non-exhaustive subset of actions. */
async function grantCommercialAuthority(): Promise<{ id: string; allowedActions: string[] }> {
  const allowedActions = [COMMERCIAL_ACTIONS[1]!, COMMERCIAL_ACTIONS[5]!]; // CONTACT_BUYER, RUN_PAID_TEST
  const authority = await createAuthority({
    projectId,
    ownerUserId: ownerId,
    createdByUserId: ownerId,
    name: 'test grant',
    allowedActions,
    prohibitions: [],
    maxCommittedCents: 100_000, // $1,000
    maxPerActionCents: 60_000, // $600
    maxConcurrent: 5,
    currency: 'USD',
  });
  return { id: authority.id, allowedActions };
}

/**
 * Real cash in the account, so a commitment has something to fit.
 *
 * `commit()` refuses whenever it would leave deployable cash negative — a
 * ceiling with nothing behind it authorizes spending on nothing, and every
 * commit test needs money to actually be there before it can be held.
 */
async function seedFunds(amountCents: number): Promise<void> {
  const funded = await recordMoneyEvent({
    projectId,
    kind: 'CAPITAL_IN',
    amountCents,
    currency: 'USD',
    verifiedReference: `seed-${Math.random().toString(36).slice(2, 10)}`,
    idempotencyKey: `seed:${Math.random().toString(36).slice(2, 10)}`,
    actorRef: ownerId,
  });
  expect(funded.ok).toBe(true);
}

async function fillCommitForm(input: {
  amount: string;
  purpose: string;
  expectedResult: string;
  stopCondition: string;
}): Promise<void> {
  await type(/^How much, in USD$/, input.amount);
  await type(/^Purpose$/, input.purpose);
  await type(/^What this is expected to produce$/, input.expectedResult);
  await type(/^Where it stops$/, input.stopCondition);
}

function heldCommitmentsDisplayed(): string {
  const row = screen.getByText('Held commitments').closest('tr');
  if (!row) throw new Error('No "Held commitments" row on the page.');
  return row.querySelectorAll('td')[0]!.textContent ?? '';
}

describe('committing spend, and settling it', () => {
  it('A01: a person with a live grant commits spend through the form', async () => {
    const { allowedActions } = await grantCommercialAuthority();
    await seedFunds(500_00);
    await mount();

    await fillCommitForm({
      amount: '200',
      purpose: 'Reach the buyer about the intake repair',
      expectedResult: 'A confirmed quote request',
      stopCondition: 'Stop after the first message',
    });
    await press(/^Commit$/);

    await waitFor(() =>
      expect(screen.getAllByText(/It counts against your ceiling/i).length).toBeGreaterThan(0),
    );

    const rows = await listCommitments(projectId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.state).toBe('HELD');
    expect(row.amountCents).toBe(20_000);
    expect(row.purpose).toBe('Reach the buyer about the intake repair');
    expect(row.expectedResult).toBe('A confirmed quote request');
    expect(row.stopCondition).toBe('Stop after the first message');

    // And the page shows it, under Commitments.
    await waitFor(() =>
      expect(
        screen.getAllByText(/Reach the buyer about the intake repair/i).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(new RegExp(money(20_000, 'USD').replace('.', '\\.'))).length).toBeGreaterThan(0);
    void allowedActions;
  });

  it('A02: settling moves it out of HELD, and the shown position is re-read from the server', async () => {
    await grantCommercialAuthority();
    await seedFunds(500_00);
    await mount();

    await fillCommitForm({
      amount: '200',
      purpose: 'Cover the printing run',
      expectedResult: 'Physical samples arrive',
      stopCondition: 'Stop at one run',
    });
    await press(/^Commit$/);
    await waitFor(() =>
      expect(screen.getAllByText(/Cover the printing run/i).length).toBeGreaterThan(0),
    );

    const before = await listCommitments(projectId);
    expect(before).toHaveLength(1);
    expect(heldCommitmentsDisplayed()).toBe(money(20_000, 'USD'));

    const fetchesBeforeSettle = viewFetchCount;

    await press(/^Settle$/);
    await type(/^What it actually cost, in USD$/, '150');
    await type(/^Note \(optional\)$/, 'Came in under the ceiling');
    await press(/^Confirm$/);

    await waitFor(() =>
      expect(screen.getAllByText(/Deployable cash is recomputed from the ledger/i).length).toBeGreaterThan(0),
    );

    const after = await getCommitment(before[0]!.id);
    expect(after!.state).toBe('SETTLED');
    expect(after!.spentCents).toBe(15_000);

    // A fresh GET happened — the figure did not just change on the client.
    expect(viewFetchCount).toBeGreaterThan(fetchesBeforeSettle);

    // What the page now shows is exactly what a fresh, independent read of the
    // server says right now — proof that the number came from the server
    // rather than from arithmetic performed in the browser.
    const fresh = await realFetch(`http://127.0.0.1:${port}/api/projects/${projectId}/cash`);
    const freshBody = (await fresh.json()) as { myCash: { position: { heldCommitmentsCents: number } } };
    await waitFor(() =>
      expect(heldCommitmentsDisplayed()).toBe(money(freshBody.myCash.position.heldCommitmentsCents, 'USD')),
    );
    expect(freshBody.myCash.position.heldCommitmentsCents).toBe(0);

    // And the settle request carried only what the route reads.
    const settleBody = capturedBodies.find((one) => /\/settle$/.test(one.url));
    expect(settleBody).toBeTruthy();
    expect(Object.keys(settleBody!.body as object).sort()).toEqual(['note', 'spentCents']);
  });

  it('A03: submitting the identical decision twice produces exactly one row', async () => {
    await grantCommercialAuthority();
    await seedFunds(500_00);
    await mount();

    const decision = {
      amount: '300',
      purpose: 'Remove the intake blocker',
      expectedResult: 'A working intake form',
      stopCondition: 'Stop after one attempt',
    };

    await fillCommitForm(decision);
    await press(/^Commit$/);
    await waitFor(() =>
      expect(screen.getAllByText(/It counts against your ceiling/i).length).toBeGreaterThan(0),
    );

    // The fields clear on success, so the identical decision has to be typed
    // again — this is a second press of the same button on the same form,
    // not a resubmission of a still-open one.
    await fillCommitForm(decision);
    await press(/^Commit$/);
    await waitFor(() =>
      expect(screen.getAllByText(/It counts against your ceiling|This commitment already existed/i).length).toBeGreaterThan(0),
    );

    const rows = await listCommitments(projectId);
    expect(rows).toHaveLength(1);

    const commitBodies = capturedBodies.filter(
      (one) => /\/cash\/commitments$/.test(one.url),
    );
    expect(commitBodies).toHaveLength(2);
    const key1 = (commitBodies[0]!.body as { idempotencyKey: string }).idempotencyKey;
    const key2 = (commitBodies[1]!.body as { idempotencyKey: string }).idempotencyKey;
    expect(key1).toBe(key2);
  });

  it('A04: with no live grant the form is unusable, and nothing is ever posted', async () => {
    // Deliberately no `grantCommercialAuthority()` call: no live commercial
    // authority exists on this project at all.
    await mount();

    await waitFor(() =>
      expect(
        screen.getAllByText(/no standing commercial authority authorizes any action yet/i).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryAllByRole('button', { name: /^Commit$/ })).toEqual([]);
    expect(screen.queryAllByLabelText(/^Purpose$/)).toEqual([]);

    expect(capturedBodies.filter((one) => /\/cash\/commitments$/.test(one.url))).toEqual([]);
    expect(await listCommitments(projectId)).toEqual([]);
  });

  it("A05: a member's shared page shows no commit or settle control, and no commitment amounts", async () => {
    const { allowedActions } = await grantCommercialAuthority();
    await seedFunds(500_00);
    // Set up as the owner, entirely off-screen — this test is about what a
    // member is shown, not about how the row got there.
    speaking = 'OWNER';
    const outcome = await commitSpend({
      projectId,
      action: allowedActions[0]!,
      amountCents: 23_700,
      purpose: 'A very particular obstacle only the owner should ever read',
      expectedResult: 'Something the owner alone sees',
      stopCondition: 'Stop once it is answered',
      idempotencyKey: 'member-visibility-check',
      actorRef: ownerId,
    });
    expect(outcome.ok).toBe(true);

    speaking = 'MEMBER';
    await mount();
    await waitFor(() =>
      expect(screen.getAllByText(/This is the shared frontier/i).length).toBeGreaterThan(0),
    );

    expect(screen.queryAllByRole('button', { name: /^Commit$/ })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^Settle$/ })).toEqual([]);
    expect(screen.queryAllByText(/A very particular obstacle only the owner should ever read/i)).toEqual([]);
    expect(
      screen.queryAllByText(new RegExp(money(23_700, 'USD').replace('.', '\\.'))),
    ).toEqual([]);
    expect(screen.queryAllByText('Held commitments')).toEqual([]);
  });

  it('A06: a worker is refused by type at both routes, and nothing moves', async () => {
    const { id: authorityId, allowedActions } = await grantCommercialAuthority();
    void authorityId;
    await seedFunds(500_00);

    speaking = 'OWNER';
    const created = await commitSpend({
      projectId,
      action: allowedActions[0]!,
      amountCents: 10_000,
      purpose: 'A hold a worker must not be able to touch',
      expectedResult: 'Nothing, from a worker',
      stopCondition: 'Stop immediately',
      idempotencyKey: 'worker-refusal-check',
      actorRef: ownerId,
    });
    expect(created.ok).toBe(true);
    const commitmentId = created.ok ? created.value.id : '';

    speaking = 'WORKER';
    const commitResponse = await realFetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/cash/commitments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: allowedActions[0],
          amountCents: 5_000,
          purpose: 'A worker trying to commit money',
          expectedResult: 'Should never happen',
          stopCondition: 'Never',
          idempotencyKey: 'worker-commit-attempt',
        }),
      },
    );
    expect(commitResponse.status).toBe(404);

    const settleResponse = await realFetch(
      `http://127.0.0.1:${port}/api/cash/commitments/${commitmentId}/settle`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spentCents: 5_000 }),
      },
    );
    expect(settleResponse.status).toBe(404);

    // Nothing moved: the one commitment a real owner made is exactly as it
    // was, and no second one was ever created.
    const rows = await listCommitments(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(commitmentId);
    expect(rows[0]!.state).toBe('HELD');
    expect(rows[0]!.amountCents).toBe(10_000);
  });

  it('A06b: the commit request body carries only the fields the route reads', async () => {
    await grantCommercialAuthority();
    await seedFunds(500_00);
    await mount();

    await fillCommitForm({
      amount: '50',
      purpose: 'Check the request shape',
      expectedResult: 'A body with no extra fields',
      stopCondition: 'Stop here',
    });
    await press(/^Commit$/);
    await waitFor(() =>
      expect(screen.getAllByText(/It counts against your ceiling/i).length).toBeGreaterThan(0),
    );

    const commitBody = capturedBodies.find((one) => /\/cash\/commitments$/.test(one.url));
    expect(commitBody).toBeTruthy();
    expect(Object.keys(commitBody!.body as object).sort()).toEqual(
      ['action', 'amountCents', 'expectedResult', 'idempotencyKey', 'purpose', 'stopCondition'].sort(),
    );
  });

  it('A04b: the commit form offers exactly the grant’s allowedActions', async () => {
    const { allowedActions } = await grantCommercialAuthority();
    await mount();

    const select = (await screen.findByLabelText(/^What this commits to$/)) as HTMLSelectElement;
    const offered = [...select.options].map((option) => option.value);
    expect(offered).toEqual(allowedActions);
  });
});
