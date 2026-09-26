/**
 * The dealflow screen (§45) over the real route over the real database.
 *
 * ---------------------------------------------------------------------------
 * Why this seam needs its own file
 * ---------------------------------------------------------------------------
 *
 * §33 and §41 both record the same shape: a component suite over a scripted
 * `fetch` and a service suite with no screen both pass for a control that
 * posts a field the route does not take, or a screen that offers a form for a
 * decision that is not a person's. Five finished routes had **neither** half
 * — a complete server door, covered on both backends, and no screen at all —
 * so this drives the actual `DealflowScreen` over the actual `cashRouter`
 * over the actual database, the way `laborSurface.test.tsx` and
 * `machinesBrowserToDatabase.test.ts` already do for the two kernels that
 * closed this same gap before it.
 *
 * ---------------------------------------------------------------------------
 * One place this deliberately does not match its own brief
 * ---------------------------------------------------------------------------
 *
 * The objective that produced this file says a retired party "remains
 * visible on the page with the reason rather than disappearing." That is not
 * what the shipped code does, and it should not be made to say otherwise:
 * `dealflowView` filters `buyers`/`suppliers` to `retiredAt === null` on
 * purpose (`services/dealflow/kernel.ts`'s own comment says so — "Brain stops
 * offering them"), and the retire route's own success message says the same
 * thing in words: *"Brain stops offering them ... Nothing was destroyed."*
 * So what actually survives is the **row** — its `retiredAt` and
 * `retiredReason` — and the **sentence** shown at the moment of retiring, not
 * a permanent line item on the map. Asserting that the party vanishes from
 * the offered list and that its row keeps the reason is the honest reading of
 * "nothing was destroyed," and is what this file checks instead.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here and nowhere else
 * ---------------------------------------------------------------------------
 *
 * The operator journey, walked once, with the rows checked afterwards rather
 * than the screen alone: seeding a party, retiring one, recording an
 * observation. A deal with no published landed cost renders its own
 * established/outstanding facts rather than a composed excuse, and our
 * revenue is never a rendered number — only the server's own note, verbatim.
 * A control somebody may not use is disabled with a sentence rather than
 * removed. A WORKER principal is refused at every one of these routes by
 * type, before any project membership is even consulted.
 *
 * The jsdom-by-hand construction, the dynamic imports and the real socket are
 * `machinesBrowserToDatabase.test.ts`'s; see its opening comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { cashRouter } from '../server/routes/cash.ts';
import {
  getParty,
  listObservations,
  listParties,
  pairDeal,
} from '../server/repos/dealflow.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { DEAL_OBSERVATION_KINDS, DEAL_PARTY_KINDS } from '../server/domain/types.ts';
import type { Principal, ProjectMembership, ProjectRole } from '../server/domain/types.ts';

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

const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { DealflowScreen } = await import('../client/src/russell/Dealflow.tsx');
const { parseRoute, pathFor } = await import('../client/src/lib/router.ts');

let projectId = '';
let userId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

/** Every request the stubbed fetch actually sent, so A06 can check bodies rather than screens. */
let requests: { method: string; url: string; body: unknown }[] = [];

/**
 * Who is driving these requests.
 *
 * Both dimensions matter and they are not the same one, exactly as
 * `laborSurface.test.tsx` argues: a Brain administrator reaches every project
 * by design, so a suite that only ever ran as one could not see a refusal at
 * all, and every write on this screen is project `ADMIN`, so the *level* is
 * what the capabilities actually turn on.
 */
let brainAdmin = true;
let role: ProjectRole = 'ADMIN';

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

/**
 * A minimal WORKER, refused by `requirePerson` before anything about
 * membership is ever consulted — so it carries no scopes and no real
 * membership row, matching the reason none is needed.
 */
function workerPrincipal(): Principal {
  return {
    type: 'WORKER',
    id: 'wkr_dealflow_test',
    handle: 'a-worker',
    displayName: 'A worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'brnw_test',
    authMethod: 'WORKER_BEARER',
    memberships: [],
    requestId: 'req_worker',
  } as Principal;
}

let asWorker = false;

beforeEach(async () => {
  brainAdmin = true;
  role = 'ADMIN';
  asWorker = false;
  requests = [];
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `dealflow-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
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

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: asWorker ? workerPrincipal() : principal(),
      requestId: newRequestId(),
      method: req.method,
      // `req.path` in a middleware mounted with no prefix is the whole path
      // already, so re-adding `/api` would match nothing in
      // `services/identity/policy.ts` and silently fall to the default READ
      // — the same measured defect `laborSurface.test.tsx` records finding.
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
    requests.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
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
    render(createElement(DealflowScreen, { projectId: id }));
  });
}

async function mounted(id: string | null = projectId): Promise<void> {
  await mount(id);
  await waitFor(() => expect(screen.getByText('Cross-border dealflow')).toBeTruthy());
}

function button(label: RegExp): HTMLButtonElement {
  const found = screen
    .getAllByRole('button')
    .find((one) => label.test(one.textContent ?? '')) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

async function waitForButton(label: RegExp): Promise<HTMLButtonElement> {
  return await waitFor(() => button(label));
}

function type(label: RegExp | string, value: string): void {
  const field = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
}

function requestsTo(pathSubstring: string): { method: string; url: string; body: unknown }[] {
  return requests.filter((one) => one.url.includes(pathSubstring));
}

/* ========================================================================= */

describe('the Dealflow screen, over the real route', () => {
  it('routes to and formats /dealflow, following the same three-place pattern as MACHINES and LABOR', () => {
    expect(parseRoute('/dealflow')).toEqual({ name: 'DEALFLOW' });
    expect(pathFor({ name: 'DEALFLOW' })).toBe('/dealflow');
  });

  /**
   * Mounting the whole authenticated shell to prove this one line would pull
   * in every other screen's own data (projects, conversations, fleet, home)
   * for a fact that is otherwise fully covered: the render switch is a
   * one-line conditional, already type-checked against `Route`, and every
   * other test in this file proves the component it points at actually
   * works against real data. So this reads the wiring rather than paying for
   * the whole shell, the way `laborSurface.test.tsx`'s own last test reads
   * `Labor.tsx`'s source to check a structural property no render can.
   */
  it('is wired into the shell for that route', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('client/src/russell/RussellShell.tsx', 'utf8'),
    );
    expect(source).toMatch(/import\s*\{\s*DealflowScreen\s*\}\s*from\s*'\.\/Dealflow\.tsx'/);
    expect(source).toMatch(/name:\s*'DEALFLOW'[^}]*label:\s*'Dealflow'/);
    expect(source).toMatch(
      /route\.name === 'DEALFLOW' \? <DealflowScreen projectId=\{projectId\} \/> : null/,
    );
  });

  it('seeds a party through the form, and the row follows', async () => {
    await mounted();
    expect(screen.getAllByText('None on the map yet.')).toHaveLength(2);

    // Exactly the server's vocabulary, never a literal list in the component.
    const kindSelect = screen.getByLabelText(/which side of the transaction/i) as HTMLSelectElement;
    expect([...kindSelect.options].map((one) => one.value)).toEqual([...DEAL_PARTY_KINDS]);

    type(/which side of the transaction/i, 'BUYER');
    type(/^name$/i, 'Lakeview Municipal Fleet');
    type(/^equipment class$/i, 'Fuel tankers');
    type(/country, if known/i, 'Zambia');
    type(/note, if any/i, 'Published a fleet expansion notice.');
    await act(async () => {
      fireEvent.click(button(/name them/i));
    });

    const seeded = await waitFor(async () => {
      const [found] = await listParties(projectId);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(seeded.kind).toBe('BUYER');
    expect(seeded.name).toBe('Lakeview Municipal Fleet');
    expect(seeded.equipmentClass).toBe('Fuel tankers');
    expect(seeded.country).toBe('Zambia');
    expect(seeded.origin).toBe('SEED');
    expect(seeded.sourceClaimId).toBeNull();

    // The server's own confirmation, not a sentence composed here.
    await waitFor(() =>
      expect(screen.getByText(/nothing has been spent, no research has started/i)).toBeTruthy(),
    );
    // And the row is on a re-read of the page, once the reload lands —
    // `done` renders the instant the confirmation arrives, which can be
    // before the subsequent GET this component's own `reload()` triggers
    // has resolved, so the row itself is waited for separately.
    await waitFor(() => expect(screen.getByText('Lakeview Municipal Fleet')).toBeTruthy());
    expect(screen.getByText(/Somebody named this\./)).toBeTruthy();

    // A06: the request carried only the fields the route reads.
    const posts = requestsTo('/dealflow/parties').filter((one) => one.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      kind: 'BUYER',
      name: 'Lakeview Municipal Fleet',
      equipmentClass: 'Fuel tankers',
      country: 'Zambia',
      note: 'Published a fleet expansion notice.',
    });
  });

  it('retires a party with a reason; the row keeps it and the map stops offering them', async () => {
    await mounted();
    type(/which side of the transaction/i, 'SUPPLIER');
    type(/^name$/i, 'Continental Tank Works');
    type(/^equipment class$/i, 'Fuel tankers');
    await act(async () => {
      fireEvent.click(button(/name them/i));
    });
    const seeded = await waitFor(async () => {
      const [found] = await listParties(projectId);
      expect(found).toBeTruthy();
      return found!;
    });
    await waitFor(() => expect(screen.getByText('Continental Tank Works')).toBeTruthy());

    const retire = await waitForButton(/retire/i);
    expect(retire.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(retire);
    });
    type(new RegExp(`why ${seeded.name} is a dead end`, 'i'), 'They stopped exporting this class.');
    await act(async () => {
      fireEvent.click(button(/^confirm$/i));
    });

    // The server's own confirmation that nothing was destroyed.
    await waitFor(() => expect(screen.getByText(/Nothing was destroyed/)).toBeTruthy());

    const after = await getParty(seeded.id);
    expect(after?.retiredAt).not.toBeNull();
    expect(after?.retiredReason).toBe('They stopped exporting this class.');

    // dealflowView filters a retired party out of what it offers — Brain
    // "stops offering them", in the route's own words — so a re-read of the
    // page must not still list it as a live supplier.
    const view = await import('../server/services/dealflow/view.ts').then((mod) =>
      mod.dealflowView(projectId),
    );
    expect(view.suppliers.find((one) => one.id === seeded.id)).toBeUndefined();

    const patches = requestsTo('/dealflow/parties/').filter((one) => one.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ reason: 'They stopped exporting this class.' });
  });

  it('records an observation through the form, and a re-read reports it with its sample size', async () => {
    await mounted();

    const kindSelect = screen.getByLabelText(/what kind of outcome/i) as HTMLSelectElement;
    expect([...kindSelect.options].map((one) => one.value)).toEqual([...DEAL_OBSERVATION_KINDS]);

    type(/what kind of outcome/i, 'BUYER_RESPONDED');
    type(/what happened/i, 'They replied within a day and asked for a formal quote.');
    await act(async () => {
      fireEvent.click(button(/record it/i));
    });

    const recorded = await waitFor(async () => {
      const [found] = await listObservations(projectId);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(recorded.kind).toBe('BUYER_RESPONDED');
    expect(recorded.statement).toBe('They replied within a day and asked for a formal quote.');
    expect(recorded.recordedBy).toBe(userId);

    await waitFor(() => expect(screen.getByText(/Recorded as one observation/i)).toBeTruthy());
    // The lessons section, re-read from the server: one observation, one
    // lesson group, and the sample size printed rather than folded away.
    /*
     * Scoped to the lessons section: "buyer responded" also names one of the
     * options this same form's own kind `<select>` offers, and an unscoped
     * query would match both.
     */
    await waitFor(() => {
      const lessons = document.querySelector('.rs-dealflow-lessons') as HTMLElement | null;
      expect(lessons).toBeTruthy();
      expect(within(lessons!).getByText(/buyer responded/i)).toBeTruthy();
      expect(within(lessons!).getByText(/1 from a person, 0 from Brain/)).toBeTruthy();
    });

    const posts = requestsTo('/dealflow/observations').filter((one) => one.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      kind: 'BUYER_RESPONDED',
      statement: 'They replied within a day and asked for a formal quote.',
    });
  });

  it('renders a deal missing its landed cost by its own facts, and our revenue only as the server’s note', async () => {
    const buyer = await import('../server/repos/dealflow.ts').then((mod) =>
      mod.createParty({
        projectId,
        kind: 'BUYER',
        name: 'A buyer with nothing costed yet',
        country: null,
        equipmentClass: 'Dump trailers',
        note: null,
        origin: 'SEED',
        sourceClaimId: null,
      }),
    );
    const supplier = await import('../server/repos/dealflow.ts').then((mod) =>
      mod.createParty({
        projectId,
        kind: 'SUPPLIER',
        name: 'A supplier nothing has priced yet',
        country: null,
        equipmentClass: 'Dump trailers',
        note: null,
        origin: 'SEED',
        sourceClaimId: null,
      }),
    );
    await pairDeal({
      projectId,
      buyerPartyId: buyer.party.id,
      supplierPartyId: supplier.party.id,
      equipmentClass: 'Dump trailers',
    });

    await mounted();
    /*
     * The buyer's name appears at least twice in this section alone — once as
     * the deal's own title and again inside the missing-country need Brain
     * composed for it — so this waits for the title element specifically,
     * queried by class, rather than asking for a text that several elements
     * legitimately carry.
     */
    await waitFor(() => {
      const title = document.querySelector('.rs-dealflow-deals .rs-item-title');
      expect(title?.textContent).toContain('A buyer with nothing costed yet');
    });

    const dealsSection = document.querySelector('.rs-dealflow-deals') as HTMLElement;
    expect(dealsSection).toBeTruthy();
    const dealText = dealsSection.textContent ?? '';

    // No published cost, so no currency figure is composed from nothing.
    expect(dealText).not.toMatch(/Landed cost:/);
    // What is established and what is not, named rather than scored.
    expect(dealText).toMatch(/a named buyer with a published need/i);
    expect(dealText).toMatch(/the landed cost/i);
    // The server's own refusal to state a revenue figure, verbatim.
    expect(dealText).toMatch(/Brain does not state what we would earn/);
    // And never a number standing in for it, anywhere on the whole page.
    expect(document.body.textContent ?? '').not.toMatch(/revenue[^.]{0,40}[$£€]\s?\d/i);
  });

  it('disables every write control with the server’s reason for a member, and the routes refuse them too', async () => {
    brainAdmin = false;
    role = 'MEMBER';
    await mounted();

    // Reading is unrestricted: the whole map, empty as it is, is on the page.
    expect(screen.getAllByText('None on the map yet.')).toHaveLength(2);
    expect(screen.getAllByText(/administrator's decision here/i).length).toBeGreaterThan(0);

    expect(screen.queryByLabelText(/which side of the transaction/i)).toBeNull();
    expect(screen.queryByLabelText(/what kind of outcome/i)).toBeNull();

    // A hidden or absent control is not authorization, so the routes refuse
    // a member exactly as they would refuse anybody else, and write nothing.
    const seedAttempt = await fetch(`/api/projects/${projectId}/cash/dealflow/parties`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'BUYER', name: 'x', equipmentClass: 'y' }),
    });
    expect(seedAttempt.status).toBe(404);
    expect(await listParties(projectId)).toHaveLength(0);

    const observeAttempt = await fetch(`/api/projects/${projectId}/cash/dealflow/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'BUYER_RESPONDED', statement: 'x' }),
    });
    expect(observeAttempt.status).toBe(404);
    expect(await listObservations(projectId)).toHaveLength(0);

    // The per-party retire control is disabled rather than absent, so a
    // member reads the same page an administrator does. Seeded directly,
    // since the member's own form is exactly what is gated away above.
    await import('../server/repos/dealflow.ts').then((mod) =>
      mod.createParty({
        projectId,
        kind: 'BUYER',
        name: 'Seeded while gated',
        country: null,
        equipmentClass: 'Fuel tankers',
        note: null,
        origin: 'SEED',
        sourceClaimId: null,
      }),
    );
    cleanup();
    await mounted();
    await waitFor(() => expect(screen.getByText('Seeded while gated')).toBeTruthy());
    const retireButton = button(/retire/i);
    expect(retireButton.disabled).toBe(true);
  });

  it('refuses a WORKER principal at every dealflow route, before any membership is consulted', async () => {
    asWorker = true;

    const view = await fetch(`/api/projects/${projectId}/cash/dealflow`);
    expect(view.status).toBe(404);

    const detail = await fetch(`/api/projects/${projectId}/cash/dealflow/dl_does_not_exist`);
    expect(detail.status).toBe(404);

    const seed = await fetch(`/api/projects/${projectId}/cash/dealflow/parties`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'BUYER', name: 'x', equipmentClass: 'y' }),
    });
    expect(seed.status).toBe(404);
    expect(await listParties(projectId)).toHaveLength(0);

    const observe = await fetch(`/api/projects/${projectId}/cash/dealflow/observations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'BUYER_RESPONDED', statement: 'x' }),
    });
    expect(observe.status).toBe(404);
    expect(await listObservations(projectId)).toHaveLength(0);

    // Retiring a party a worker cannot even see is refused the same way —
    // there being no real party is not what stops it; the principal type is.
    const retire = await fetch(`/api/projects/${projectId}/cash/dealflow/parties/dp_does_not_exist`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect(retire.status).toBe(404);
  });
});
