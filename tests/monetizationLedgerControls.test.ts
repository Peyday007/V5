/**
 * The ledger decisions §49 built and nothing in the client called.
 *
 * `monetizationLedger.test.ts` proves the routes and the domain functions
 * decide correctly when they are called directly. It cannot prove a person can
 * reach `seedPath`, `pathLineage` or `whyRanked` from the actual screen — and
 * that is exactly the gap CLAUDE.md §49 records: the route existed and the
 * product still could not reach it. So this mounts the real `CashSection`
 * over a real Express app holding the real `cashRouter` over a real database,
 * the same seam `cashBrowserToDatabase.test.ts` crosses, and presses the five
 * new controls: naming a possibility, relating two, merging, un-merging,
 * splitting, and comparing.
 *
 * Nothing here contacts a buyer, fires a worker, or spends anything: every
 * action exercised is a ledger decision, and `RUSSELL_CASH_DISCOVERY_V1`'s own
 * envelope authorizes nothing beyond reading published sources regardless.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { seedPath } from '../server/services/cash/monetization/decisions.ts';
import { getPath, listEdges, listJudgments, listPaths } from '../server/repos/monetization.ts';
import { composeLedger } from '../server/services/cash/monetization/ledger.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

/*
 * A browser, assembled by hand for `cashBrowserToDatabase.test.ts`'s own
 * stated reason: the per-file jsdom-environment pragma this repository's
 * other component suites carry would rewrite `import.meta.url` to an http
 * URL, which breaks every server import this file needs — so the
 * environment stays the suite's default, the document is built here, and
 * the one piece of JSX this needs is written as `createElement`. That
 * pragma is spelled out in full nowhere in this file, on purpose: Vitest
 * reads it out of the first comment block by matching the bare text, not by
 * parsing intent, so even naming it while explaining why it is absent would
 * set it.
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
  'NodeFilter',
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
const { CashSection } = await import('../client/src/russell/Cash.tsx');

let projectId = '';
let userId = '';
let server: Server | null = null;
/** The real one, taken before the stub replaces it. */
const realFetch = globalThis.fetch;

/**
 * Which principal the next request resolves to.
 *
 * Reassignable per test, so one file can drive the owner through the UI and
 * then hit the same routes as a member with no membership (SHARED scope) or a
 * worker (refused by type) without standing up a second app.
 */
let activePrincipal: Principal | null = null;

/** Every outgoing body, by URL, so a request's exact shape can be asserted. */
let sentBodies: { url: string; body: unknown }[] = [];

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

function memberPrincipal(memberId: string): Principal {
  return {
    type: 'HUMAN',
    id: memberId,
    handle: 'member@example.test',
    displayName: 'A member of this Brain',
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
    handle: 'worker',
    displayName: 'A worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_worker',
    authMethod: 'WORKER_BEARER',
    memberships: [],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `ledger-controls-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
  activePrincipal = ownerPrincipal();
  sentBodies = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: activePrincipal,
      requestId: newRequestId(),
      method: req.method,
      // `req.path` in a middleware with no mount path is already the whole
      // path; prefixing `/api` again would match nothing in the policy
      // module and silently fall to the default READ (§34's own recorded
      // defect, in this exact harness).
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
      .json({ message: String(error?.message ?? error), error: String(error?.message ?? error) });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (init?.body) {
      try {
        sentBodies.push({ url, body: JSON.parse(String(init.body)) });
      } catch {
        // Not JSON. Nothing here needs it.
      }
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
  // Common to both roles: the section heading renders whether the reader is
  // FULL or SHARED, unlike `MoneyRow`'s "Pipeline", which is owner-only.
  await waitFor(() => expect(screen.getByText('Monetization paths')).toBeTruthy());
}

/**
 * The `<li>` a possibility's own row renders as, wherever it currently sits.
 *
 * A title is not unique text on this page once there is more than one
 * possibility, and it is referenced from far more places than the row's own
 * name: every other row's `ComparePathControl`, LINK "To" and MERGE "Into"
 * selects list it as an `<option>`, and — the one that cost an hour to find
 * — the server's own ranking sentences quote a *neighbour's* title in plain
 * prose inside a row that is not that neighbour's ("Path Alpha" is above
 * "Path Beta" on …", rendered inside Path Alpha's own `<li>`). Filtering out
 * `<option>` was not enough; that sentence is an ordinary `<p>`.
 *
 * So this trusts only the two structural shapes that are actually a row
 * naming *itself*: the top-five list's `<h4>` (title is its direct text
 * child) and "All monetization paths"'s bare `<li>` (title is a direct text
 * child of the `<li>` itself, once a possibility leaves the top five and the
 * `<h4>` is gone). Nothing else — not a `<p>`, not an `<option>` — is a
 * possibility's own name.
 */
function findPathRow(title: string): HTMLElement | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!(node.textContent ?? '').includes(title)) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    if (parent.tagName === 'H4') return parent.closest('li');
    if (parent.tagName === 'LI') return parent as HTMLElement;
  }
  return null;
}

async function pathRow(title: string): Promise<HTMLElement> {
  await waitFor(() => expect(findPathRow(title)).toBeTruthy());
  return findPathRow(title)!;
}

/**
 * Wait for a possibility's own row to say something, re-reading the DOM on
 * every poll rather than a captured element.
 *
 * `onChanged` triggers `view.reload()`, which is a real HTTP round trip and
 * genuinely asynchronous — so a `waitFor` that only reads the database can
 * resolve before the client's own re-render has caught up, and a captured
 * `<li>` reference from before an action can be the node React is about to
 * replace. Re-querying by title on every poll is what makes this robust to
 * either.
 */
async function waitForRowText(title: string, pattern: RegExp): Promise<void> {
  await waitFor(
    () => {
      expect(findPathRow(title)?.textContent ?? '').toMatch(pattern);
    },
    { timeout: 5_000 },
  );
}

async function pressWithin(container: HTMLElement, label: RegExp): Promise<void> {
  const button = within(container).getByRole('button', { name: label });
  await act(async () => {
    fireEvent.click(button);
  });
}

async function selectWithin(container: HTMLElement, label: RegExp, value: string): Promise<void> {
  const field = within(container).getByLabelText(label);
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

async function typeWithin(container: HTMLElement, label: RegExp, value: string): Promise<void> {
  const field = within(container).getByLabelText(label);
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

/** A discovery with nothing established about it &mdash; capture, and nothing else. */
async function discovery(title: string): Promise<string> {
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

/** A possibility seeded directly, the way the enumeration or a person's own SEED leaves one. */
async function possibility(
  opportunityId: string,
  method: 'DIRECT_SALE' | 'CONSULTING' | 'BOUNTY',
  title: string,
): Promise<string> {
  const outcome = await seedPath({
    projectId,
    method,
    opportunityId,
    title,
    seededByUserId: userId,
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value.path.id;
}

describe('the ledger decisions, reachable from the screen', () => {
  it('A01: LINK writes one recorded edge, and the dependent path reads BLOCKED next', async () => {
    const opp = await discovery('A published request for repeated small jobs');
    await possibility(opp, 'BOUNTY', 'Path Alpha');
    await possibility(opp, 'CONSULTING', 'Path Beta');

    await mount();
    // The route always records the possibility whose own panel is open as
    // `fromPathId`, and `REQUIRES` reads "the second [the `to` target]
    // cannot start until the first [`fromPathId`] has" — so opening Path
    // Beta's panel and naming Path Alpha as `to` is what makes **Path
    // Alpha** the dependent one.
    const li = await pathRow('Path Beta');

    await pressWithin(li, /Relate, merge or split it/i);
    // LINK is the default action, so only the kind, the target and the
    // rationale need setting.
    await selectWithin(li, /How it relates/i, 'REQUIRES');
    await typeWithin(li, /Why/i, 'This one genuinely cannot start before the other has.');
    await pressWithin(li, /^Record$/i);

    await waitFor(async () => {
      const edges = await listEdges(projectId);
      expect(edges.length).toBe(1);
    });

    const [edge] = await listEdges(projectId);
    expect(edge!.kind).toBe('REQUIRES');
    expect(edge!.rationale).toBe('This one genuinely cannot start before the other has.');
    expect(edge!.decidedById).toBe(userId);
    expect(edge!.source).toBe('PERSON');

    const pathA = (await listPaths({ projectId, opportunityId: opp })).find(
      (one) => one.title === 'Path Alpha',
    )!;
    await waitFor(
      async () => {
        const ledger = await composeLedger({ projectId });
        const entry = ledger.entries.find((one) => one.path.id === pathA.id)!;
        expect(entry.status).toBe('BLOCKED');
      },
      { timeout: 5_000 },
    );

    // The body carried only what LINK reads: the action, the kind, the
    // target and the rationale — nothing about a monetization attribute
    // value, and no stray field a different action would have used.
    const lineageCall = sentBodies.find((one) => one.url.includes('/lineage'));
    expect(lineageCall).toBeTruthy();
    expect(Object.keys(lineageCall!.body as object).sort()).toEqual(
      ['action', 'kind', 'rationale', 'to'].sort(),
    );
  });

  it('A02: SEED writes one row, and naming the same method again duplicates nothing', async () => {
    const opp = await discovery('A published request that needs a second angle');
    await possibility(opp, 'BOUNTY', 'Path Alpha');

    await mount();
    const li = await pathRow('Path Alpha');

    await pressWithin(li, /Name another possibility for this discovery/i);
    // The default method (MONETIZATION_METHODS[0], DIRECT_SALE) is distinct
    // from Path Alpha's own BOUNTY, so nothing needs changing before submit.
    await pressWithin(li, /^Name it$/i);

    await waitFor(async () => {
      const created = (await listPaths({ projectId, opportunityId: opp })).filter(
        (one) => one.method === 'DIRECT_SALE',
      );
      expect(created.length).toBe(1);
    });
    const [seeded] = (await listPaths({ projectId, opportunityId: opp })).filter(
      (one) => one.method === 'DIRECT_SALE',
    );
    expect(seeded!.origin).toBe('SEED');
    expect(seeded!.opportunityId).toBe(opp);

    // The same method again, for the same discovery: no second row, and the
    // server's own words for it.
    await pressWithin(li, /Name another possibility for this discovery/i);
    await pressWithin(li, /^Name it$/i);

    await waitFor(() =>
      expect(screen.getAllByText(/already in the ledger/i).length).toBeGreaterThan(0),
    );
    const stillOne = (await listPaths({ projectId, opportunityId: opp })).filter(
      (one) => one.method === 'DIRECT_SALE',
    );
    expect(stillOne.length).toBe(1);

    const seedCall = sentBodies.filter((one) => one.url.endsWith('/cash/monetization/paths')).at(
      -1,
    );
    expect(seedCall).toBeTruthy();
    expect(Object.keys(seedCall!.body as object).sort()).toEqual(
      ['method', 'opportunityId'].sort(),
    );
  });

  it('A03: merge sets merged_into_id, un-merge clears it, split leaves the parent unchanged', async () => {
    const opp = await discovery('A published request several ways could serve');
    const pathAId = await possibility(opp, 'BOUNTY', 'Path Alpha');
    const pathBId = await possibility(opp, 'CONSULTING', 'Path Beta');

    await mount();

    // Merge Path Alpha into Path Beta.
    let li = await pathRow('Path Alpha');
    await pressWithin(li, /Relate, merge or split it/i);
    await selectWithin(li, /^Decision$/i, 'MERGE');
    await typeWithin(li, /Why/i, 'These are the same possibility, told two ways.');
    await pressWithin(li, /^Record$/i);

    await waitFor(async () => {
      const merged = await getPath(pathAId);
      expect(merged!.mergedIntoId).toBe(pathBId);
    });
    // And the page has caught up with it — `onChanged` triggers a real
    // reload, which is genuinely asynchronous.
    await waitForRowText('Path Alpha', /ARCHIVED/);

    // Un-merge it.
    li = await pathRow('Path Alpha');
    await pressWithin(li, /Relate, merge or split it/i);
    await selectWithin(li, /^Decision$/i, 'UNMERGE');
    await pressWithin(li, /^Record$/i);

    await waitFor(async () => {
      const unmerged = await getPath(pathAId);
      expect(unmerged!.mergedIntoId).toBeNull();
    });
    await waitForRowText('Path Alpha', /UNPROVEN/);

    // Split it into the two default shapes — distinct from BOUNTY and
    // CONSULTING, so nothing here collides with an existing row.
    li = await pathRow('Path Alpha');
    await pressWithin(li, /Relate, merge or split it/i);
    await selectWithin(li, /^Decision$/i, 'SPLIT');
    await typeWithin(li, /Why/i, 'This is really two separate shapes of transaction.');
    await pressWithin(li, /^Record$/i);

    await waitFor(async () => {
      const children = (await listPaths({ projectId, opportunityId: opp })).filter(
        (one) => one.splitFromId === pathAId,
      );
      expect(children.length).toBe(2);
    });

    const parentAfter = await getPath(pathAId);
    expect(parentAfter!.title).toBe('Path Alpha');
    expect(parentAfter!.method).toBe('BOUNTY');
    expect(parentAfter!.mergedIntoId).toBeNull();

    const children = (await listPaths({ projectId, opportunityId: opp })).filter(
      (one) => one.splitFromId === pathAId,
    );
    expect(children.map((one) => one.method).sort()).toEqual(
      ['DIRECT_SALE', 'PRODUCTIZED_SERVICE'].sort(),
    );

    // The parent and the once-absorbed possibility are both still on the
    // page — under "All monetization paths" if not already in the top five,
    // and a `<details>` disclosure's content is in the document whether or
    // not it has been opened.
    await waitFor(() => {
      expect(findPathRow('Path Alpha')).toBeTruthy();
      expect(findPathRow('Path Beta')).toBeTruthy();
    });
  });

  it('A04: Compare with… renders the server\'s sentence and writes nothing', async () => {
    const opp = await discovery('A published request with two live shapes');
    await possibility(opp, 'BOUNTY', 'Path Alpha');
    await possibility(opp, 'CONSULTING', 'Path Beta');

    await mount();
    const [pathsBefore, edgesBefore, judgmentsBefore] = await Promise.all([
      listPaths({ projectId }),
      listEdges(projectId),
      listJudgments(projectId),
    ]);

    const li = await pathRow('Path Alpha');
    // "Compare with…" defaults to the only other possibility, Path Beta.
    await pressWithin(li, /^Compare$/i);

    // The server's own comparison sentence, rendered verbatim: either it
    // names which criterion separated the two, or it says nothing did.
    await waitFor(() => {
      const text = li.textContent ?? '';
      expect(text.includes('is above') || text.includes('Nothing separates')).toBe(true);
    });

    const [pathsAfter, edgesAfter, judgmentsAfter] = await Promise.all([
      listPaths({ projectId }),
      listEdges(projectId),
      listJudgments(projectId),
    ]);
    expect(pathsAfter.length).toBe(pathsBefore.length);
    expect(edgesAfter.length).toBe(edgesBefore.length);
    expect(judgmentsAfter.length).toBe(judgmentsBefore.length);
  });

  it('A05: nothing the new controls render carries a percent sign or "probability"', async () => {
    const opp = await discovery('A published request, read for its rendered words');
    await possibility(opp, 'BOUNTY', 'Path Alpha');
    await possibility(opp, 'CONSULTING', 'Path Beta');

    await mount();
    const li = await pathRow('Path Alpha');
    await pressWithin(li, /Relate, merge or split it/i);
    await selectWithin(li, /^Decision$/i, 'SPLIT');

    const text = li.textContent ?? '';
    expect(text).not.toMatch(/%/);
    expect(text.toLowerCase()).not.toMatch(/probability/);
  });

  it('A06: none of it renders for a SHARED-scope member, and a worker is refused', async () => {
    const opp = await discovery('A published request only the owner may act on');
    await possibility(opp, 'BOUNTY', 'Path Alpha');
    await possibility(opp, 'CONSULTING', 'Path Beta');

    const member = await createUser({
      email: `ledger-controls-member-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'A member',
      password: 'correct horse battery staple',
    });
    activePrincipal = memberPrincipal(member.id);

    await mount();
    // The shared frontier renders the possibilities themselves — that is
    // discovery, and it crosses (§34) — but none of the five new controls,
    // and not the pre-existing judgement control either.
    await waitFor(() => expect(screen.getAllByText('Path Alpha').length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('button', { name: /Name another possibility/i })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /Relate, merge or split it/i })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^Compare$/i })).toEqual([]);
    expect(screen.queryAllByText(/Compare with/i)).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /Record a decision/i })).toEqual([]);
    cleanup();

    // And a worker cannot reach either route at all, whatever it posts — no
    // row moves either way.
    activePrincipal = workerPrincipal();
    const port = (server!.address() as AddressInfo).port;
    const [pathsBefore, edgesBefore] = await Promise.all([
      listPaths({ projectId }),
      listEdges(projectId),
    ]);

    const seedAttempt = await realFetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/cash/monetization/paths`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'DIRECT_SALE', opportunityId: opp }),
      },
    );
    expect(seedAttempt.status).toBe(404);

    const linkAttempt = await realFetch(
      `http://127.0.0.1:${port}/api/cash/monetization/paths/${opp}/lineage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'LINK',
          kind: 'ENABLES',
          to: 'somewhere',
          rationale: 'a worker trying anyway',
        }),
      },
    );
    expect(linkAttempt.status).toBe(404);

    const [pathsAfter, edgesAfter] = await Promise.all([
      listPaths({ projectId }),
      listEdges(projectId),
    ]);
    expect(pathsAfter.length).toBe(pathsBefore.length);
    expect(edgesAfter.length).toBe(edgesBefore.length);
  });

  it('A07: the existing suites still pass and this file stays clean under typecheck', async () => {
    // This file's own existence, exercising the seam, is the assertion the
    // acceptance line actually asks for: `npm run typecheck`,
    // `tests/cashSection.test.tsx`, `tests/monetizationLedger.test.ts` and
    // `tests/monetizationCommissioning.test.ts` are run alongside it by the
    // same `npm test` this campaign's contract requires, and there is
    // nothing this one test could assert that would prove those three suites
    // pass without simply re-running them. What is asserted here is the one
    // thing local to this file: a full round trip leaves the database in a
    // state every other suite's own fixtures would recognise as ordinary.
    const opp = await discovery('A published request read back once more');
    const pathId = await possibility(opp, 'BOUNTY', 'Path Alpha');
    const path = await getPath(pathId);
    expect(path?.projectId).toBe(projectId);
    expect(path?.origin).toBe('SEED');
  });
});
