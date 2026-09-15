/**
 * One journey with nothing scripted between the button and the row.
 *
 * `cashSection.test.tsx` renders the real screen over a scripted `fetch`, and
 * `cashIntegrationPass.test.ts` drives the real routes with no screen. Both are
 * worth having and neither can see the seam between them — a control that posts
 * a field name the route does not take, a patch key the client maps wrongly, a
 * figure the screen sends as a string, an answer that lands and leaves the page
 * saying what it said before. Every one of those passes both suites.
 *
 * So this mounts the actual `CashSection`, points `fetch` at a real Express app
 * holding the actual `cashRouter` over the actual database, and presses the
 * controls. Nothing between the click and the row is a fixture: the review
 * items come from `cashView`, the labels come from the server, the requests are
 * real HTTP, and what is asserted afterwards is the row and then the screen.
 *
 * Three answers, which is what the acceptance asks for and no more — this is a
 * seam check, not a second end-to-end framework:
 *
 *   * a card answer, which is a person's decision landing in a column,
 *   * funding, which is a money entry the ledger derives from,
 *   * and a need resolution, which is the one that has to be verified rather
 *     than taken on the word of whoever pressed it.
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
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { getNeed, getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

/**
 * A browser, assembled here rather than declared at the top of the file.
 *
 * The per-file jsdom directive every other component suite carries cannot be
 * used here, and the reason is worth writing down because it cost an hour: the
 * web transform rewrites `import.meta.url` to an http URL, `server/env.ts`
 * resolves the repository root out of it with `fileURLToPath`, and importing
 * any server module then fails before a test runs. Every component suite in
 * this repository therefore imports client code only — which is exactly the
 * seam this file exists to cross.
 *
 * And the directive must not be *named* here either. Vitest reads it out of
 * the first comment block in the file, so a sentence explaining why it is not
 * used sets it, and the file it is written in is the one it breaks.
 *
 * It is a `.ts` file for the same reason: Vitest applies the web transform to
 * every `.tsx` module whatever the environment says, so the one piece of JSX
 * this needs is written as `createElement` instead.
 *
 * So the environment stays `node`, the database and the routes are the real
 * ones, and the document is built by hand. The globals go in before React
 * Testing Library is loaded, which is why the imports below are dynamic:
 * `@testing-library/dom` reads `window` as it initialises.
 */
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
let userId = '';
let server: Server | null = null;
/** The real one, taken before the stub replaces it. */
const realFetch = globalThis.fetch;

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
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

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
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

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
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

  // Port 0: the operating system picks, so this suite cannot collide with any
  // other one's range — the failure mode the conventions warn about, where a
  // second suite's readiness probe finds the first suite's server and signs in
  // against a different Brain.
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  // The one substitution, and it is the address rather than the answer. The
  // client asks for a relative path because it believes it is in a browser
  // being served by Brain; this says where that Brain is.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    return await realFetch(
      url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url,
      init,
    );
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
    render(createElement(CashSection, { projectId }));
  });
  await waitFor(() => expect(screen.getByText('Pipeline')).toBeTruthy());
}

/** Open the control behind one review item, by the label the server wrote. */
async function press(label: RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name: label });
  await act(async () => {
    fireEvent.click(button);
  });
}

async function type(label: RegExp, value: string): Promise<void> {
  const field = await screen.findByLabelText(label);
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

async function confirm(): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: /^Confirm$/ });
  await act(async () => {
    fireEvent.click(buttons[buttons.length - 1]!);
  });
}

/** An opening whose card is answered except for one thing a person decides. */
async function openingMissingItsOffer(): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'A published intake repair request',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
  });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: userId,
    patch: {
      payer: 'The operations manager, who signs',
      reachableChannel: 'The address on the notice',
      buyingSignal: 'Asked for a fixed quote to repair the intake form',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  return captured.value.id;
}

describe('the screen, the route and the row', () => {
  it('lands a card answer in the column, and the page stops asking for it', async () => {
    const id = await openingMissingItsOffer();
    await mount();

    // The item the server composed, by the title the server composed.
    await waitFor(() =>
      expect(screen.getAllByText(/card with no offer/i).length).toBeGreaterThan(0),
    );
    await press(/Answer the offer on this card/i);
    await type(/card with no offer/i, 'One fixed-scope repair of the published intake form');
    await confirm();

    // The row, first: this is the assertion the UI suite cannot make.
    await waitFor(async () =>
      expect((await getOpportunity(id))!.offerScope).toBe(
        'One fixed-scope repair of the published intake form',
      ),
    );

    // And then the screen, because an answer that lands and leaves the page
    // saying what it said before is §29's defect at this surface.
    await waitFor(() =>
      expect(
        screen.getAllByText(/It is yours now, so Brain will not propose over it/i).length,
      ).toBeGreaterThan(0),
    );
    await waitFor(() => expect(screen.queryAllByText(/card with no offer/i)).toEqual([]));
  });

  it('records funding as a ledger entry, and the position is recomputed from it', async () => {
    // A shortfall is what puts the funding control on the page: reserves with
    // nothing behind them make deployable cash negative.
    const app = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const seeded = await realFetch(`${app}/api/projects/${projectId}/cash/money`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'RESERVE',
        amountCents: 50_000,
        currency: 'USD',
        description: 'Held back for the quarter',
        idempotencyKey: 'reserve:quarter',
      }),
    });
    expect(seeded.status).toBe(200);

    await mount();
    // Said in more than one place on the page — the summary line and the
    // decision card — so this asks that it is said at all rather than once.
    await waitFor(() =>
      expect(screen.getAllByText(/Deployable cash is negative/i).length).toBeGreaterThan(0),
    );

    await press(/Record the funding, or release a commitment/i);
    await type(/How much, in USD cents/i, '80000');
    await type(/The reference it can be traced by/i, 'bank-2026-0915-11');
    await confirm();

    await waitFor(async () => {
      const funding = (await listMoneyEntries({ projectId })).find(
        (one) => one.verifiedReference === 'bank-2026-0915-11',
      );
      expect(funding?.kind).toBe('CAPITAL_IN');
      // The number arrived as a number, not as the string the input held.
      expect(funding?.amountCents).toBe(80_000);
    });

    // Derived, never stored: the shortfall line is gone because the ledger
    // changed, not because the client recomputed anything.
    await waitFor(() => expect(screen.queryAllByText(/Deployable cash is negative/i)).toEqual([]));
  });

  it('refuses a need answer that claims a condition which does not hold, in the browser', async () => {
    const id = await openingMissingItsOffer();
    const raised = await raiseNeed({
      projectId,
      opportunityId: id,
      actorRef: 'BRAIN',
      blockedAction: 'Take the payment for this',
      whyItMatters: 'Nothing here can collect money.',
      recommendedPath: 'Open a payment processor account',
      nextStep: 'Sign up and record the key',
      setupEffort: 'An afternoon, once',
      completionCondition: 'TAKE_A_PAYMENT reads PRESENT',
      blocksState: 'EXECUTING',
      requestKey: `capability:${id}:TAKE_A_PAYMENT`,
    });
    expect(raised.ok).toBe(true);

    await mount();
    await waitFor(() =>
      expect(screen.getAllByText(/Take the payment for this/i).length).toBeGreaterThan(0),
    );

    await press(/Mark this done, and say what you did/i);
    await type(/What did you do\?/i, 'Done.');
    await confirm();

    // A written explanation is not a working integration, and the refusal
    // reaches the person rather than the server log.
    await waitFor(() =>
      expect(screen.getAllByText(/still reads MISSING/i).length).toBeGreaterThan(0),
    );
    expect((await getNeed(raised.ok ? raised.value.id : ''))!.state).toBe('OPEN');

    // Saying what is actually being done instead is the honest route, and it
    // is recorded as that rather than as the condition having been met.
    await type(
      /If the integration is still missing/i,
      'Taking payment by bank transfer outside Brain for now',
    );
    await confirm();

    await waitFor(async () => {
      const settled = (await listNeeds({ projectId, states: ['RESOLVED'] }))[0];
      expect(settled?.verifiedBy).toBe('PERSON_SUBSTITUTE');
    });
  });
});
