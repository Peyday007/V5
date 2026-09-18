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
 * Three presses, which is what the acceptance asks for and no more — this is a
 * seam check, not a second end-to-end framework. Two of them are now
 * **absences**, which is the same seam read the other way: a control gated on
 * a field the server does not actually send would pass a scripted-`fetch`
 * suite and still draw a box in production, so the gate is asserted where the
 * value comes off the real card through the real route.
 *
 *   * the card's blanks, which are Brain's work and offer nobody a text box,
 *   * funding, which is a money entry the ledger derives from and is the one
 *     genuine person control left on this page,
 *   * and a Brain-owned need, which stays open because nothing here may close
 *     it on somebody's word.
 *
 * Nothing here contacts a buyer, takes a live payment, or fires a worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { EXECUTION_THESIS } from './helpers/cashTier.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { getNeed, getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { cardFact } from '../server/repos/cashCardFacts.ts';
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
    render(createElement(CashSection, { projectId, isBrainAdmin: false }));
  });
  await waitFor(() => expect(screen.getByText('Pipeline')).toBeTruthy());
}

/** Open the control behind one review item, by the label the server wrote. */
/**
 * The first control with this name, because a qualified piece is drawn twice.
 *
 * It appears once under *Best opportunities* and once in the full portfolio,
 * which is a summary and its detail rather than two opinions — so pressing
 * the first is pressing the one a person actually sees first. A `findByRole`
 * that refused on the ambiguity would be the test asserting a layout it has
 * no view about.
 */
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

async function confirm(): Promise<void> {
  const buttons = await screen.findAllByRole('button', { name: /^Confirm$/ });
  await act(async () => {
    fireEvent.click(buttons[0]!);
  });
}

/**
 * An opening answered except for two things: the offer, and one question the
 * card asks that has no column at all.
 *
 * The second is the point of this fixture now. `ENGINE_FIELDS` are
 * `cash_card_facts` rows, so before the card grew a control for them the
 * bounded deep dive was the only thing that could answer one — and the tier
 * requires them, so a person who knew the answer had nowhere to put it.
 */
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
      /*
       * And the execution thesis. `markReady` asks for both now: the twelve
       * short-card fields are what a bounded *test* turns on, and these are
       * what a *decision* turns on. They have no column, so a person
       * answering one is a `PERSON` row in `cash_card_facts`.
       */
      ...EXECUTION_THESIS,
      // Left unanswered on purpose: it has no column, so it is the case a
      // person could not answer at all until the card grew a control for it.
      eligibility: undefined,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  return captured.value.id;
}

describe('the screen, the route and the row', () => {
  it('shows a blank on the card as Brain’s work, with nothing for a person to fill in', async () => {
    /*
     * The form this replaces asked the person to type an answer under every
     * blank on the card, and there were two of them worth separating: `offer`
     * has a column on the opportunity, and `eligibility` has none at all. Both
     * are `BRAIN_PROPOSES` or `BRAIN_RESEARCH`, so neither is a person's to
     * answer, and the screen must offer no way to.
     *
     * It is asserted here rather than only in `cashSection` because that suite
     * scripts `fetch`: a control gated on a field the server does not actually
     * send would pass there and render a box in production. Here the `owner`
     * comes off the real `evidenceCard` through the real route.
     */
    const id = await openingMissingItsOffer();
    await mount();

    await press(/Show the full card/i);

    // Both blanks are still shown, and still say what would answer them —
    // what went is the box, not the question.
    await waitFor(() =>
      expect(screen.getAllByText(/State one outcome, one scope/i).length).toBeGreaterThan(0),
    );
    expect(
      screen.getAllByText(/what published rule decides whether a supplier/i).length,
    ).toBeGreaterThan(0);

    expect(screen.queryAllByRole('button', { name: /Answer the/i })).toEqual([]);
    expect(screen.queryAllByLabelText(/^Offer$/i)).toEqual([]);
    expect(screen.queryAllByLabelText(/^Eligibility and permission$/i)).toEqual([]);
    // By the id the removed control used, rather than by counting every text
    // box on the page: the authority form legitimately has several, and an
    // assertion that broke when one was added there would be the wrong test.
    expect(document.querySelectorAll('[id^="cash-engine-"]').length).toBe(0);

    // And reading the page moved nothing: both are still unanswered, in the
    // column and in the facts table.
    expect((await getOpportunity(id))!.offerScope).toBeNull();
    expect(await cardFact(id, 'eligibility')).toBeNull();
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

  it('leaves a Brain-owned need open, with no way for a person to close it', async () => {
    /*
     * This is the form the correction was named for. It asked *"what did you
     * do?"* under a need whose own row says Brain raised it — both callers of
     * `raiseNeed` pass `actorRef: BRAIN` — so a person answering it was
     * attesting to work they had not done.
     *
     * The need stays exactly where it was: shown as Brain's work, open, and
     * still reached by `reconcileCapabilityNeeds`, which closes it the moment
     * the capability reads `PRESENT` — having checked, rather than been told.
     * Removing the control resolves nothing and advances nothing, which is the
     * half of this worth asserting against the row.
     */
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
    const needId = raised.ok ? raised.value.id : '';

    await mount();

    // It is on the page, under Brain's work, with the remedy it carries.
    await waitFor(() =>
      expect(screen.getAllByText(/Take the payment for this/i).length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText(/Open a payment processor account/i).length).toBeGreaterThan(0);

    // And nothing anywhere offers to mark it done.
    expect(screen.queryAllByRole('button', { name: /Mark this done/i })).toEqual([]);
    expect(screen.queryAllByText(/What did you do\?/i)).toEqual([]);
    expect(screen.queryAllByText(/If the integration is still missing/i)).toEqual([]);

    // The row is untouched, so Brain's own path still reaches it.
    expect((await getNeed(needId))!.state).toBe('OPEN');
    expect((await getNeed(needId))!.verifiedBy).toBeNull();
    expect(await listNeeds({ projectId, states: ['RESOLVED'] })).toEqual([]);
  });
});

/**
 * And the reason it can refuse, pinned so it cannot quietly stop being true.
 *
 * The test above observes the refusal. What made the refusal impossible before
 * was not the logic — it was *reachability*: the reader was registered by a
 * side effect of importing a module the route path never loads, so whether a
 * person's answer got checked depended on what else happened to be in the
 * process. A behavioural test cannot see that, because a suite that imports
 * the registering module passes either way.
 *
 * Two properties, and between them there is nothing left to forget:
 *
 *   * what settles a condition is **statically reachable** from the route a
 *     browser calls, so loading the route loads the reader;
 *   * there is **no registration seam at all**, so there is no module whose
 *     absence could disable the check.
 *
 * Deliberately not pinned: that `operate.ts` is unreachable from the route.
 * That is true today and is incidental — the durable property is that the
 * check does not depend on it.
 */
describe('the check is reachable rather than registered', () => {
  const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

  /** Every module a static `import` from `entry` can reach. */
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      let source: string;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        return;
      }
      const relative = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/g;
      for (const match of source.matchAll(relative)) {
        const resolved = path.resolve(path.dirname(file), match[1]!);
        if (fs.existsSync(resolved)) walk(resolved);
      }
    };
    walk(entry);
    return seen;
  }

  it('loads the condition reader by loading the route', () => {
    const reachable = reachableFrom(path.join(ROOT, 'server/routes/cash.ts'));
    expect(reachable.has(path.join(ROOT, 'server/services/cash/conditions.ts'))).toBe(true);
  });

  /*
   * And by the edge that decides it, which is stricter than the one above.
   *
   * Reachability alone is satisfied by any module on the route path importing
   * `conditions.ts` — `answers.ts` does, for `questionKey` — so the first
   * assertion stayed green when `closeNeed` was changed to reach its reader
   * through a dynamic import, which is the shape the original defect had. What
   * has to be true is that the module *doing the checking* resolves its reader
   * statically, so there is no moment at which `closeNeed` exists and the
   * reader does not.
   */
  it('resolves it where the check happens, statically', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server/services/cash/needs.ts'), 'utf8');
    expect(source).toMatch(/^import \{[^}]*\breadNeedCondition\b[^}]*\} from '\.\/conditions\.ts';$/m);
    expect(source).not.toMatch(/await import\(\s*['"]\.\/conditions\.ts['"]/);
  });

  it('has no way to register a reader, so there is none to forget', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (full === path.join(ROOT, 'tests/cashBrowserToDatabase.test.ts')) continue;
        if (/useConditionReader|ConditionReader/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'server'));
    walk(path.join(ROOT, 'tests'));
    expect(offenders).toEqual([]);
  });
});
