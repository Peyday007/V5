/**
 * The three opportunity transitions the server has always had, over the wire.
 *
 * `cashBrowserToDatabase.test.ts` proves the seam between the screen, the
 * route and the row for the controls that already existed; this is the same
 * seam for the three the server implemented and nothing called until now:
 * `archive`, `exhaust` and `reoffer`. The same reasoning applies —
 * `cashSection.test.tsx` scripts `fetch`, so a control gated on a field the
 * server does not actually send, or one that posts a key the route does not
 * read, passes there and still fails in production. Nothing between the
 * click and the row is a fixture here: the buttons come from the real
 * `Actions` component, the requests are real HTTP against the real
 * `cashRouter`, and what is asserted afterwards is the row.
 *
 * The document-and-import boilerplate below is copied from
 * `cashBrowserToDatabase.test.ts` rather than shared, because that file
 * explains exactly why it cannot be: naming the per-file jsdom environment
 * directive breaks `server/env.ts`'s `import.meta.url` resolution, so this has
 * to build its own document by hand, in a `.ts` file, with the same dynamic
 * imports. Naming it is exactly what that sentence must not do, and did — see
 * the file's own comment for why the directive is never spelled out even in
 * passing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture, decline } from '../server/services/cash/opportunities.ts';
import { getOpportunity, listOpportunities, transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import { listCashEventsFor } from '../server/repos/cashMode.ts';
import { cashRouter } from '../server/routes/cash.ts';
/*
 * The destination picker for `reoffer` calls `Api.projects()`, which is
 * `GET /api/projects` — a route `cashRouter` does not carry, because listing
 * every project a caller may see is not a Cash concern. Mounting the real
 * `projectsRouter` alongside it is what makes the option list in the test
 * exactly what the browser would actually receive, rather than a shape this
 * file guessed at.
 */
import { projectsRouter } from '../server/routes/projects.ts';
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

let projectId = '';
let otherProjectId = '';
let userId = '';
let server: Server | null = null;
/** The real one, taken before the stub replaces it. */
const realFetch = globalThis.fetch;

/** Every request the stub actually sent, with its parsed body. */
let sent: { url: string; method: string; body: unknown }[] = [];

/**
 * Which principal the middleware attaches, chosen per test rather than fixed
 * once — a mutable reference read at request time, so one test can act as the
 * owner, then as a SHARED-scope member, then as a worker, without a second
 * server.
 */
type Role = 'OWNER' | 'SHARED' | 'WORKER';
let role: Role = 'OWNER';

function ownerPrincipal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_browser',
    authMethod: 'SESSION_COOKIE',
    memberships: [projectId, otherProjectId].map(
      (id, index) =>
        ({
          id: `mem-${index}`,
          projectId: id,
          principalType: 'HUMAN',
          principalId: userId,
          role: 'ADMIN',
          scopes: ['project:read'],
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: '2026-01-01T00:00:00.000Z',
          active: true,
        }) as ProjectMembership,
    ),
    requestId: 'req',
  } as Principal;
}

/**
 * A genuine person who has joined this Brain and holds no membership on
 * either project — which is exactly what `decideCashRead` resolves to
 * `SHARED` for, per `server/services/cash/access.ts`.
 */
function sharedPrincipal(): Principal {
  return {
    type: 'HUMAN',
    id: 'usr_shared_member',
    handle: 'member@example.test',
    displayName: 'A member',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_member',
    authMethod: 'SESSION_COOKIE',
    memberships: [],
    requestId: 'req',
  } as Principal;
}

function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: 'wkr_test',
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
        principalId: 'wkr_test',
        role: 'MEMBER',
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

function principalFor(current: Role): Principal {
  if (current === 'SHARED') return sharedPrincipal();
  if (current === 'WORKER') return workerPrincipal();
  return ownerPrincipal();
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const other = await createProject({
    name: 'Another operation',
    slug: `other-${Math.random().toString(36).slice(2, 10)}`,
  });
  otherProjectId = other.id;

  const user = await createUser({
    email: `browser-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
  // The destination for `reoffer`: a project the same person may read, so the
  // refusal exercised below is the one `reoffer` names — "not running Cash
  // Mode" — rather than a 404 for a project they cannot see at all.
  await grantMembership({
    projectId: otherProjectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  expect(
    (
      await activate({
        projectId,
        ownerUserId: userId,
        actorUserId: userId,
        objective: 'Maximize additional usable cash over the next few weeks.',
      })
    ).ok,
  ).toBe(true);

  role = 'OWNER';
  sent = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principalFor(role),
      requestId: newRequestId(),
      method: req.method,
      // See `cashBrowserToDatabase.test.ts`: `req.path` in a middleware
      // registered with no mount path is the whole path already, so this must
      // not be prefixed with `/api` again.
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', cashRouter);
  app.use('/api/projects', projectsRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (init?.body !== undefined) {
      let body: unknown = init.body;
      if (typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          // left as the raw string; nothing here should ever send one
        }
      }
      sent.push({ url, method: init.method ?? 'GET', body });
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
  /*
   * "Everything in the portfolio" rather than `cashBrowserToDatabase.test.ts`'s
   * "Pipeline": that heading is inside `MyCash`, which takes the owner's
   * `CashView` directly and never renders for a SHARED reader, so it would
   * hang this file's SHARED-scope test forever. `Portfolio` takes `page`,
   * which every scope carries, and its heading only appears once the view has
   * actually loaded — the same strength of signal, without the scope.
   */
  await waitFor(() => expect(screen.getByText('Everything in the portfolio')).toBeTruthy());
}

/** The first control with this name. See `cashBrowserToDatabase.test.ts`. */
async function press(label: RegExp): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: label });
  await act(async () => {
    fireEvent.click(buttons[0]!);
  });
}

async function type(label: RegExp, value: string): Promise<void> {
  const fields = await screen.findAllByLabelText(label);
  await act(async () => {
    fireEvent.change(fields[0]!, { target: { value } });
  });
}

/**
 * Choose a destination in the "Which operation?" select, by the project's
 * name rather than its id.
 *
 * The list is fetched lazily, only once the control is opened (see the
 * `startAsking` comment in `client/src/russell/Cash.tsx`), so the option is
 * not necessarily in the DOM the instant the select renders. Waiting for the
 * option to exist before setting the select's value is what stops this
 * racing that fetch — setting a `<select>` to a value with no matching
 * `<option>` is silently ignored by the DOM rather than failing loudly.
 */
async function chooseDestination(projectName: string): Promise<void> {
  const selects = await screen.findAllByLabelText(/^Which operation\?$/i);
  const select = selects[0] as HTMLSelectElement;
  await waitFor(() => {
    expect(Array.from(select.options).some((option) => option.textContent === projectName)).toBe(
      true,
    );
  });
  const option = Array.from(select.options).find((one) => one.textContent === projectName)!;
  await act(async () => {
    fireEvent.change(select, { target: { value: option.value } });
  });
}

async function confirm(): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: /^Confirm$/ });
  await act(async () => {
    fireEvent.click(buttons[0]!);
  });
}

async function freshOpportunity(title: string): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  return captured.value.id;
}

describe('archiving', () => {
  it('moves the opportunity to ARCHIVED, records the event, and keeps the reason on the page', async () => {
    const id = await freshOpportunity('A published intake repair request');
    await mount();

    await press(/^Archive$/);
    await type(/^Why\?/i, 'The margin evaporated once shipping was quoted.');
    await confirm();

    await waitFor(async () => {
      const row = await getOpportunity(id);
      expect(row?.state).toBe('ARCHIVED');
      expect(row?.archivedReason).toBe('The margin evaporated once shipping was quoted.');
    });

    const events = await listCashEventsFor(id);
    expect(events.some((event) => event.kind === 'CASH_OPPORTUNITY_ARCHIVED')).toBe(true);

    // The reason is still on the page, as the disposition's own sentence —
    // `placements()` reports an archived opportunity's `because` as its
    // recorded `archivedReason`.
    await waitFor(() =>
      expect(
        screen.getAllByText(/The margin evaporated once shipping was quoted\./i).length,
      ).toBeGreaterThan(0),
    );

    const request = sent.find(
      (one) => one.method === 'POST' && one.url.endsWith(`/opportunities/${id}/archive`),
    );
    expect(request?.body).toEqual({ reason: 'The margin evaporated once shipping was quoted.' });
  });

  it('keeps Confirm disabled while the reason is empty, and sends nothing until it is not', async () => {
    await freshOpportunity('A published intake repair request');
    await mount();

    await press(/^Archive$/);
    const button = (await screen.findAllByRole('button', { name: /^Confirm$/ }))[0]! as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await type(/^Why\?/i, 'Not worth the shipping cost.');
    expect(button.disabled).toBe(false);

    expect(sent.some((one) => one.url.includes('/archive'))).toBe(false);
  });
});

describe('marking an opening exhausted', () => {
  it('sets exhausted_at and exhausted_reason, records the event, and the control is gone on the next render', async () => {
    const id = await freshOpportunity('A published intake repair request');
    await mount();

    await press(/^Mark exhausted$/);
    await type(/^Why\?/i, 'The buyer took the one-off and moved on.');
    await confirm();

    await waitFor(async () => {
      const row = await getOpportunity(id);
      expect(row?.exhaustedAt).not.toBeNull();
      expect(row?.exhaustedReason).toBe('The buyer took the one-off and moved on.');
    });

    const events = await listCashEventsFor(id);
    expect(events.some((event) => event.kind === 'CASH_OPENING_EXHAUSTED')).toBe(true);

    // Reached only while `exhaustedAt` is null, so a re-read must not offer it
    // again for the same piece.
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Mark exhausted$/ })).toEqual([]));

    const request = sent.find(
      (one) => one.method === 'POST' && one.url.endsWith(`/opportunities/${id}/exhaust`),
    );
    expect(request?.body).toEqual({ reason: 'The buyer took the one-off and moved on.' });
  });
});

describe('offering a declined opportunity to another operation', () => {
  it('is offered only for a DECLINED opportunity, and absent for DISCOVERED, READY and EXECUTING', async () => {
    await freshOpportunity('Still evidence, nothing decided');
    const readyId = await freshOpportunity('Answered enough to test');
    expect(await transitionOpportunity({ id: readyId, from: ['DISCOVERED'], to: 'READY' })).toBe(true);
    const executingId = await freshOpportunity('Already under way');
    expect(await transitionOpportunity({ id: executingId, from: ['DISCOVERED'], to: 'READY' })).toBe(true);
    expect(
      await transitionOpportunity({ id: executingId, from: ['READY'], to: 'EXECUTING' }),
    ).toBe(true);

    await mount();

    // The page has actually rendered the three pieces, so the assertion below
    // is about their absence rather than about the page still loading.
    await waitFor(() =>
      expect(screen.getAllByText(/Still evidence, nothing decided/i).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/Answered enough to test/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Already under way/i).length).toBeGreaterThan(0);

    // None of the three carries a DECLINED row, so the control has nothing to
    // attach to anywhere on the page.
    expect(screen.queryAllByRole('button', { name: /^Offer to another operation$/ })).toEqual([]);
  });

  it('renders the server refusal verbatim, creates nothing in the other project, and keeps the typed reason and destination', async () => {
    const id = await freshOpportunity('A published intake repair request');
    const declined = await decline({
      opportunityId: id,
      actorUserId: userId,
      reason: 'Not worth pursuing ourselves.',
    });
    expect(declined.ok).toBe(true);

    await mount();

    await press(/^Offer to another operation$/);
    await chooseDestination('Another operation');
    await type(/^Why\?/i, 'Somebody else might want this.');
    await confirm();

    await waitFor(() =>
      expect(
        screen.getAllByText(/That operation is not running Cash Mode, so it takes no openings\./i)
          .length,
      ).toBeGreaterThan(0),
    );

    // Nothing was created in the other project, and the original is untouched.
    expect(await listOpportunities({ projectId: otherProjectId })).toEqual([]);
    const row = await getOpportunity(id);
    expect(row?.state).toBe('DECLINED');

    // The typed reason and the chosen destination are still there — a refusal
    // is not a reason to make somebody retype what they already said.
    expect((await screen.findAllByLabelText(/^Why\?/i))[0]).toHaveProperty(
      'value',
      'Somebody else might want this.',
    );
    expect((await screen.findAllByLabelText(/^Which operation\?$/i))[0]).toHaveProperty(
      'value',
      otherProjectId,
    );

    const request = sent.find(
      (one) => one.method === 'POST' && one.url.endsWith(`/opportunities/${id}/reoffer`),
    );
    expect(request?.body).toEqual({
      toProjectId: otherProjectId,
      reason: 'Somebody else might want this.',
    });
  });

  it('keeps Confirm disabled until both a destination and a reason are given', async () => {
    const id = await freshOpportunity('A published intake repair request');
    const declined = await decline({ opportunityId: id, actorUserId: userId, reason: 'Passing.' });
    expect(declined.ok).toBe(true);

    await mount();
    await press(/^Offer to another operation$/);
    const button = (await screen.findAllByRole('button', { name: /^Confirm$/ }))[0]! as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await type(/^Why\?/i, 'Somebody else might want this.');
    expect(button.disabled).toBe(true);

    await chooseDestination('Another operation');
    expect(button.disabled).toBe(false);

    expect(sent.some((one) => one.url.includes('/reoffer'))).toBe(false);
  });
});

describe('the same boundary every other Cash control is held to', () => {
  it('renders none of the three controls for a SHARED-scope member', async () => {
    const id = await freshOpportunity('A published intake repair request');
    const declined = await decline({ opportunityId: id, actorUserId: userId, reason: 'Passing.' });
    expect(declined.ok).toBe(true);

    role = 'SHARED';
    await mount();
    await waitFor(() => expect(screen.getAllByText(/A published intake repair request/i).length).toBeGreaterThan(0));

    expect(screen.queryAllByRole('button', { name: /^Archive$/ })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^Mark exhausted$/ })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^Offer to another operation$/ })).toEqual([]);
  });

  it('refuses a WORKER principal on archive, exhaust and reoffer, with no row changed', async () => {
    const id = await freshOpportunity('A published intake repair request');
    const declined = await decline({ opportunityId: id, actorUserId: userId, reason: 'Passing.' });
    expect(declined.ok).toBe(true);
    const before = await getOpportunity(id);

    const port = (server!.address() as AddressInfo).port;
    const app = `http://127.0.0.1:${port}`;
    role = 'WORKER';

    for (const [action, body] of [
      ['archive', { reason: 'A worker should not be able to do this.' }],
      ['exhaust', { reason: 'A worker should not be able to do this.' }],
      ['reoffer', { toProjectId: otherProjectId, reason: 'A worker should not be able to do this.' }],
    ] as const) {
      const response = await realFetch(`${app}/api/cash/opportunities/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(404);
    }

    const after = await getOpportunity(id);
    expect(after).toEqual(before);
    expect(await listOpportunities({ projectId: otherProjectId })).toEqual([]);
  });
});
