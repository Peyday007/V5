/**
 * The Puzzles screen over the real route over the real database.
 *
 * ---------------------------------------------------------------------------
 * Why this seam needs its own file
 * ---------------------------------------------------------------------------
 *
 * `tests/laborSurface.test.tsx` records the reason and §33 records what it
 * cost in production: a component suite over a scripted `fetch` and a service
 * suite with no screen both pass for a control that posts a field the route
 * does not take, or a screen that renders a form for a decision that is not a
 * person's. The seam between them is where those live, and the puzzle kernel
 * had *neither* half — a complete server door, covered on both backends, and
 * no screen at all. Nothing in any browser called any of it.
 *
 * The jsdom-by-hand construction, the dynamic imports and the real socket are
 * `tests/machinesBrowserToDatabase.test.ts`'s; `laborSurface.test.tsx` already
 * borrows them for the identical reason, and this file borrows them from
 * there rather than restating a third copy.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here and nowhere else, one block per acceptance condition
 * ---------------------------------------------------------------------------
 *
 * A01 — the whole response renders verbatim: `rightNow`'s counts, every
 *       ledger entry (not only the top five), the dollar-book verdict, what
 *       needs a person and the next action.
 * A02 — an unmeasured figure renders as *not measured*, with its note, and
 *       never as the digit 0.
 * A03 — seeding a format, retiring one, and recording a `HUMAN_EDIT_PASSED`
 *       observation each post exactly the fields their route reads, and a
 *       refused request shows the server's own message.
 * A04 — opening a real instance renders the reproduced message verbatim, and
 *       a 404 — an absent project or an absent instance — renders the same
 *       not-available state either way.
 * A05 — `parseRoute`/`pathFor` round-trip `/puzzles`, and `RussellShell`
 *       renders `PuzzlesView` for it.
 * A06 — a compile-time guard: `puzzleApi`'s declared response type is the
 *       server's `PuzzleView`, not a copy of it, so a server rename or
 *       addition fails this suite's typecheck rather than being silently
 *       dropped by a client holding a stale shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { runPuzzleKernel } from '../server/services/puzzle/kernel.ts';
import { puzzleView } from '../server/services/puzzle/view.ts';
import {
  listPuzzleFormats,
  listPuzzleInstances,
  listPuzzleObservations,
} from '../server/repos/puzzle.ts';
import { parseRoute, pathFor } from '../client/src/lib/router.ts';
import type { Principal, ProjectMembership, ProjectRole } from '../server/domain/types.ts';

/*
 * A06, resolved at compile time rather than at runtime.
 *
 * `getPuzzleView`'s declared return type is imported type-only from the
 * server's own `PuzzleView` in `client/src/lib/puzzleApi.ts`, never restated
 * — so this assertion is trivially true today and is what fails the moment
 * that stops being so: a client that started declaring its own copy of the
 * shape instead of re-exporting the server's would compile happily and this
 * would refuse to. `Equal` is exact rather than merely assignable in either
 * direction, which is what a wider or narrower client type would slip past.
 */
import type { getPuzzleView } from '../client/src/lib/puzzleApi.ts';
import type { PuzzleView } from '../server/services/puzzle/view.ts';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;
type _PuzzleViewKeysMatch = Expect<Equal<Awaited<ReturnType<typeof getPuzzleView>>, PuzzleView>>;

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

const { cleanup, fireEvent, render, screen, waitFor, within } = await import(
  '@testing-library/react'
);
const { act, createElement } = await import('react');
const { PuzzlesView } = await import('../client/src/russell/Puzzles.tsx');
const { RussellShell } = await import('../client/src/russell/RussellShell.tsx');

let projectId = '';
let userId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

/** Every request the harness's own fetch stub actually sent. */
let requestLog: { method: string; url: string; body: unknown }[] = [];

let brainAdmin = true;
let role: ProjectRole = 'MEMBER';

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: brainAdmin,
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
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  brainAdmin = true;
  role = 'MEMBER';
  requestLog = [];
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `puzzle-surface-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      /*
       * The path the policy module matches on, which is the one the request
       * already carries. `req.path` in a middleware registered with no mount
       * path is the whole path, and prefixing it with `/api` a second time
       * would match no pattern in `services/identity/policy.ts` and silently
       * fall to the default `READ` — `laborSurface.test.tsx` measured what
       * that vacuity cost.
       */
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
  const port = (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    requestLog.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return await realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function mount(id: string | null = projectId): Promise<void> {
  await act(async () => {
    render(createElement(PuzzlesView, { projectId: id }));
  });
}

/** The heading every render carries — active sprint or not — so a mount can be waited on. */
async function mounted(id: string | null = projectId): Promise<void> {
  await mount(id);
  await waitFor(() => expect(screen.getByText('Puzzle products')).toBeTruthy());
}

/** The heading that appears only once the active view's sections have rendered. */
async function mountedActive(id: string | null = projectId): Promise<void> {
  await mount(id);
  await waitFor(() => expect(document.querySelector('.rs-puzzles-ledger')).toBeTruthy());
}

function button(label: RegExp): HTMLButtonElement {
  const found = screen
    .getAllByRole('button')
    .find((one) => label.test(one.textContent ?? '')) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

function type(label: string, value: string): void {
  const field = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
  fireEvent.change(field, { target: { value } });
}

/** Every request this harness sent to a path, in order — for asserting exact posted bodies. */
function requestsTo(pathSuffix: string): { method: string; body: unknown }[] {
  return requestLog
    .filter((one) => one.url.includes(pathSuffix))
    .map((one) => ({ method: one.method, body: one.body }));
}

function serverPort(): number {
  return (server!.address() as AddressInfo).port;
}

/** A direct call to the real server, bypassing the harness's own request log — for setup only. */
async function directPost(path: string, body: unknown): Promise<Response> {
  return await realFetch(`http://127.0.0.1:${serverPort()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function activateSprint(): Promise<void> {
  const activated = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(activated.ok).toBe(true);
}

/* ========================================================================= */

describe('the Puzzles screen, over the real route', () => {
  it('A01 renders the whole response verbatim from an active, populated sprint', async () => {
    await activateSprint();
    const seedResponse = await directPost(
      `/api/projects/${projectId}/cash/puzzles/formats`,
      { name: 'word search', note: null },
    );
    expect(seedResponse.status).toBe(200);
    await runPuzzleKernel(projectId);

    const view = await puzzleView(projectId);
    // A ledger with more members than the top five, so "every ledger entry"
    // and "the top five" are actually different claims to check.
    expect(view.ledger.length).toBeGreaterThan(5);
    expect(view.topFive.length).toBeLessThanOrEqual(5);
    expect(view.topFive.length).toBeLessThan(view.ledger.length);

    await mountedActive();

    // rightNow's counts, each rendered exactly — pluralized the way the
    // component itself pluralizes, so this does not assume a particular
    // batch size. Scoped to the counts list itself, because "N valid
    // puzzles" and "N qualified products" are load-bearing phrases repeated
    // verbatim elsewhere on the page (the maturity ladder, "being made now"),
    // and a query over the whole document cannot tell those repeats apart.
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    const counts = within(document.querySelector('.rs-puzzles-counts') as HTMLElement);
    expect(
      counts.getByText(`${plural(view.rightNow.formatsOnMap, 'format')} on the map`),
    ).toBeTruthy();
    expect(
      counts.getByText(plural(view.rightNow.systems, 'system'), { exact: false }),
    ).toBeTruthy();
    expect(
      counts.getByText(`${view.rightNow.validPuzzles} valid puzzle`, { exact: false }),
    ).toBeTruthy();
    expect(
      counts.getByText(`${view.rightNow.qualifiedProducts} qualified product`, { exact: false }),
    ).toBeTruthy();
    expect(counts.getByText(`${view.rightNow.promoted} promoted to the portfolio`)).toBeTruthy();

    // Every ledger entry, not only the top five: the "whole ledger" list
    // holds exactly `view.ledger.length` rows and every title in it, and the
    // top-five list is strictly smaller — proving neither list is silently
    // filtering the other down to nothing.
    const ledgerSection = document.querySelector('.rs-puzzles-ledger') as HTMLElement;
    const topFiveList = ledgerSection.querySelector('.rs-puzzles-topfive') as HTMLElement;
    const wholeLedgerList = [...ledgerSection.querySelectorAll('ul.rs-puzzles-list')].find(
      (one) => !one.classList.contains('rs-puzzles-topfive'),
    ) as HTMLElement;
    expect(wholeLedgerList.querySelectorAll('.rs-puzzles-route').length).toBe(view.ledger.length);
    expect(topFiveList.querySelectorAll('.rs-puzzles-route').length).toBe(view.topFive.length);
    for (const entry of view.ledger) {
      expect(wholeLedgerList.textContent).toContain(entry.route.title);
    }

    // The dollar-book verdict, needs-a-person and the next action, verbatim.
    // Needs-a-person is scoped to its own section: several ledger routes
    // legitimately share the identical "nobody has established who pays"
    // sentence as their own `next` hint, so the same words appear more than
    // once on the page and an unscoped query cannot tell the repeats apart.
    expect(screen.getByText(view.dollarBook.verdict)).toBeTruthy();
    const needsPersonSection = within(
      document.querySelector('.rs-puzzles-needsperson') as HTMLElement,
    );
    for (const one of view.needsPerson) {
      expect(needsPersonSection.getByText(one.what)).toBeTruthy();
      expect(needsPersonSection.getByText(one.why)).toBeTruthy();
    }
    expect(screen.getByText(view.nextAction)).toBeTruthy();
  }, 60_000);

  it('A02 never renders an unmeasured figure as the digit 0', async () => {
    await activateSprint();
    await mountedActive();
    const view = await puzzleView(projectId);

    // §48 guarantees these three stay UNKNOWN: nothing has been physically
    // produced, nothing settled, and no editorial hours are recorded. Real
    // readings rather than a scripted stand-in, which is what makes "never
    // renders as 0" a claim about this screen rather than about a fixture.
    const unknownLeverage = [
      ['Setup to unit yield', view.leverage.setupToUnitYield],
      ['Contribution per setup', view.leverage.contributionPerSetup],
      ['Valid puzzles per editorial hour', view.leverage.validPuzzlesPerEditorialHour],
    ] as const;
    for (const [label, reading] of unknownLeverage) {
      expect(reading.evidence).toBe('UNKNOWN');
      expect(reading.value).toBeNull();
      // `<dt>`/`<dd>` alternate as direct siblings under one `<dl>`, so the
      // reading for *this* label is the very next element rather than
      // anything found by searching the whole list from the `<dt>`'s parent.
      const term = screen.getByText(label);
      const row = term.nextElementSibling as HTMLElement;
      expect(row.textContent).toContain('not measured');
      expect(row.textContent).not.toMatch(/\b0\b/);
      expect(row.textContent).toContain(reading.note);
    }

    // The quality pass rate is UNKNOWN by design, for the same reason —
    // scoped to its own reading row rather than the whole section, because
    // the section's other lines are genuine *measured* counts (0 defects, 0
    // complaints) and are correctly allowed to say so.
    expect(view.quality.passRate.value).toBeNull();
    const passRateRow = document.querySelector(
      '.rs-puzzles-quality .rs-puzzles-reading',
    ) as HTMLElement;
    expect(passRateRow.textContent).toContain('not measured');
    expect(passRateRow.textContent).not.toMatch(/\b0\b/);
  }, 30_000);

  it('A03 walks seeding, retiring and recording an observation, posting exactly the declared fields', async () => {
    await activateSprint();
    await mountedActive();

    /* --- seeding a format ---------------------------------------------- */
    type('Format name', 'cryptic crossword');
    type('Note', 'Named from the operator surface.');
    await act(async () => {
      fireEvent.click(button(/Name it/));
    });
    await waitFor(() => expect(screen.getByText(/is on the map/)).toBeTruthy());
    const seedRequests = requestsTo('/cash/puzzles/formats').filter(
      (one) => one.method === 'POST',
    );
    expect(seedRequests).toHaveLength(1);
    // Exactly the two fields the route reads — nothing this screen is not
    // told to send, and nothing dropped that was typed.
    expect(seedRequests[0]?.body).toEqual({
      name: 'cryptic crossword',
      note: 'Named from the operator surface.',
    });

    const [format] = await waitFor(async () => {
      const found = await listPuzzleFormats(projectId);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(format!.name).toBe('cryptic crossword');
    expect(format!.retiredAt).toBeNull();

    /* --- a refused retirement shows the server's own message ------------ */
    type('Format id', 'fmt_does_not_exist_00000000000000');
    type('Reason', 'Checking the refusal path first.');
    await act(async () => {
      fireEvent.click(button(/Retire it/));
    });
    await waitFor(() => expect(screen.getByText('No format with that id.')).toBeTruthy());
    expect((await listPuzzleFormats(projectId))[0]?.retiredAt).toBeNull();

    /* --- retiring the real one -------------------------------------------- */
    type('Format id', format!.id);
    type('Reason', 'Nobody has published a single cryptic crossword rate in a month.');
    await act(async () => {
      fireEvent.click(button(/Retire it/));
    });
    await waitFor(() => expect(screen.getByText(/reads it as a dead end/)).toBeTruthy());
    const retireRequests = requestsTo(`/cash/puzzles/formats/${format!.id}`).filter(
      (one) => one.method === 'PATCH',
    );
    expect(retireRequests).toHaveLength(1);
    expect(retireRequests[0]?.body).toEqual({
      reason: 'Nobody has published a single cryptic crossword rate in a month.',
    });
    const retired = (await listPuzzleFormats(projectId)).find((one) => one.id === format!.id);
    expect(retired?.retiredAt).not.toBeNull();
    expect(retired?.retiredReason).toBe(
      'Nobody has published a single cryptic crossword rate in a month.',
    );

    /* --- seeding a second format so a HUMAN_EDIT_PASSED observation has
       something to name, and recording it -------------------------------- */
    type('Format name', 'word search');
    type('Note', '');
    await act(async () => {
      fireEvent.click(button(/Name it/));
    });
    await waitFor(() =>
      expect(
        screen.getByLabelText('Format (optional)') as HTMLSelectElement,
      ).toBeTruthy(),
    );
    const formatSelect = await waitFor(() => {
      const select = screen.getByLabelText('Format (optional)') as HTMLSelectElement;
      const hasIt = [...select.options].some((option) => option.textContent === 'word search');
      expect(hasIt).toBe(true);
      return select;
    });
    fireEvent.change(formatSelect, { target: { value: 'word search' } });
    fireEvent.change(screen.getByLabelText('What happened') as HTMLSelectElement, {
      target: { value: 'HUMAN_EDIT_PASSED' },
    });
    type('What happened, in words', 'Read twenty of them by hand. Nothing was ambiguous.');
    await act(async () => {
      fireEvent.click(button(/Record it/));
    });
    await waitFor(() =>
      expect(
        screen.getByText(/the one thing that can move a format to SELLABLE/),
      ).toBeTruthy(),
    );
    const obsRequests = requestsTo('/cash/puzzles/observations').filter(
      (one) => one.method === 'POST',
    );
    expect(obsRequests).toHaveLength(1);
    // Exactly what the form actually set: no productId and no route were
    // chosen, so neither key should be present at all.
    expect(obsRequests[0]?.body).toEqual({
      kind: 'HUMAN_EDIT_PASSED',
      statement: 'Read twenty of them by hand. Nothing was ambiguous.',
      format: 'word search',
    });

    const observations = await listPuzzleObservations(projectId);
    const recorded = observations.find((one) => one.kind === 'HUMAN_EDIT_PASSED');
    expect(recorded).toBeTruthy();
    expect(recorded?.statement).toBe('Read twenty of them by hand. Nothing was ambiguous.');
    expect(recorded?.formatKey).toBe('word search');
  }, 60_000);

  it('A04 opens a real instance and renders the reproduced message verbatim', async () => {
    await activateSprint();
    await directPost(`/api/projects/${projectId}/cash/puzzles/formats`, {
      name: 'word search',
      note: null,
    });
    await runPuzzleKernel(projectId);
    const [instance] = await listPuzzleInstances({ projectId, state: 'VALID' });
    expect(instance).toBeTruthy();

    await mountedActive();
    type('Instance id', instance!.id);
    await act(async () => {
      fireEvent.click(button(/Open it/));
    });

    /*
     * The exact sentence the route composes, rendered whole. The generator
     * has not changed underneath this row inside one test, so `reproduced`
     * is true here — the not-reproduced sentence is the same rendering path
     * (`reading.message`, passed straight through) taking the other string
     * the route can return, which `puzzleKernel.test.ts` already exercises
     * directly against the generator; what this screen adds is that whatever
     * string comes back is shown whole, and that is proven by this one.
     */
    await waitFor(() =>
      expect(
        screen.getByText(
          'Rendered from its specification, and it hashes to what was recorded when it was ' +
            'validated.',
        ),
      ).toBeTruthy(),
    );
    expect(document.querySelector('.rs-puzzles-ok')).toBeTruthy();
    expect(document.querySelector('.rs-puzzles-mismatch')).toBeNull();

    /* --- a puzzle nobody wrote is the same not-available state a project
       nobody may read gets -------------------------------------------------- */
    type('Instance id', 'puz_does_not_exist_0000000000000000');
    await act(async () => {
      fireEvent.click(button(/Open it/));
    });
    await waitFor(() => expect(screen.getByText('No puzzle with that id.')).toBeTruthy());
  }, 60_000);

  it('A04 renders a project nobody may read as the same not-available state', async () => {
    await mount('prj_0000000000000000000000000');
    await waitFor(() => expect(screen.getByText('No project with that id.')).toBeTruthy());
    expect(document.querySelector('.rs-puzzles-notavailable')).toBeTruthy();

    cleanup();
    await mount(null);
    expect(screen.getByText('Open a project to see its puzzle kernel.')).toBeTruthy();

    cleanup();
    await mounted();
    expect(
      screen.getByText(/This project holds no sprint, so nothing here has run/),
    ).toBeTruthy();
  });
});

/* ========================================================================= */

describe('A05 the puzzle address', () => {
  it('round-trips through parseRoute and pathFor', () => {
    expect(parseRoute('/puzzles')).toEqual({ name: 'PUZZLES' });
    expect(pathFor({ name: 'PUZZLES' })).toBe('/puzzles');
    expect(pathFor(parseRoute('/puzzles'))).toBe('/puzzles');
  });

  it('is what RussellShell renders for the PUZZLES route', async () => {
    // No sprint activated: `PuzzlesView` renders its simplest card, which is
    // enough to prove *which* component the shell put in the main column —
    // the active view is exercised in full against the real database above.
    const USER = {
      id: userId,
      email: 'owner@example.test',
      displayName: 'The owner',
      isBrainAdmin: false,
      mustChangePassword: false,
    };
    const port = (server!.address() as AddressInfo).port;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === '/api/projects') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ projects: [{ id: projectId, name: 'Test project', slug: 'test' }] }),
        } as Response;
      }
      if (url === '/api/russell/conversations') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ conversations: [{ id: 'rcv_1', title: 'A thread' }] }),
        } as Response;
      }
      if (url.startsWith(`/api/russell/projects/${projectId}/needs-you`)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ requests: [], software: [], repositories: [] }),
        } as Response;
      }
      if (url.startsWith(`/api/russell/projects/${projectId}/authority`)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ grant: null }),
        } as Response;
      }
      return await realFetch(
        url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url,
        init,
      );
    });

    const navigation = { route: { name: 'PUZZLES' as const }, go: () => {} };
    await act(async () => {
      render(createElement(RussellShell, { navigation, user: USER, onSignedOut: () => {} }));
    });
    await waitFor(() =>
      expect(
        screen.getByText(/This project holds no sprint, so nothing here has run/),
      ).toBeTruthy(),
    );
    // Rendered inside the shell's own main content column, not a stray copy
    // somewhere else on the page.
    expect(document.querySelector('main.rs-main .rs-puzzles-empty')).toBeTruthy();
  });
});

/* ========================================================================= */

describe('A06 the client type is the server type, not a copy of it', () => {
  // The compile-time assertion above (`_PuzzleViewKeysMatch`) is the actual
  // guard: if `npm run typecheck` passes, `getPuzzleView`'s declared return
  // type is exactly the server's `PuzzleView`. This runtime check exists only
  // so the guard shows up as a test rather than as an unreferenced type that
  // a future edit could delete without anything failing.
  it('is asserted at compile time, and this keeps the assertion referenced', () => {
    const _referenced: _PuzzleViewKeysMatch = true;
    expect(_referenced).toBe(true);
  });
});
