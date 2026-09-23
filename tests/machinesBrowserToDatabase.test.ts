/**
 * The Machines screen over the real route over the real database.
 *
 * `cashBrowserToDatabase.test.ts` records why this seam needs its own file: a
 * component suite over a scripted `fetch` and a service suite with no screen
 * both pass for a control that posts a field the route does not take, or a
 * screen that shows a verdict the service did not compose. The seam between
 * them is where those live.
 *
 * Two properties are asserted here and nowhere else.
 *
 * **The screen shows the service's own verdict and the service's own
 * explanation, verbatim.** Not a mapped synonym, not a re-derivation — the same
 * sentence, so a person reading the screen and an operator reading
 * `npm run manufacturing -- show` are reading one answer. §29 records what two
 * readers of one fact cost.
 *
 * **There is no back door.** The screen offers no control that marks a
 * capability held from what research established, and the route refuses one
 * without a stated reason. A capability a machine *teaches* is never one this
 * company holds, and a UI is the easiest place for that to quietly stop being
 * true.
 *
 * The jsdom-by-hand construction, the `.ts` extension and the dynamic imports
 * are all for `cashBrowserToDatabase`'s reasons; see its opening comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { startProgramme } from '../server/services/manufacturing/program.ts';
import { seedCategory } from '../server/services/manufacturing/declare.ts';
import { programmeView } from '../server/services/manufacturing/view.ts';
import { listCapabilities, getProgram } from '../server/repos/manufacturing.ts';
import { manufacturingRouter } from '../server/routes/manufacturing.ts';
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

const { cleanup, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { MachinesView } = await import('../client/src/russell/Machines.tsx');

const OBJECTIVE =
  'Build a manufacturing company able to move from powered equipment into mobility and ' +
  'industrial machinery, entering only where demand and a route are demonstrated.';

let projectId = '';
let userId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

/**
 * Whether the person driving these requests administers the whole Brain.
 *
 * True for every test here but the refusal ones, because a Brain administrator
 * reaches every project by design — which means nothing is ever forbidden to
 * them, and a suite that only ever runs as one cannot see a refusal at all.
 * Reset in `beforeEach`, so a block that lowers it cannot leak into the next.
 */
let brainAdmin = true;

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
  brainAdmin = true;
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `machines-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      /*
       * The path the policy module matches on, which is the one the request
       * already carries. `req.path` in a middleware registered with no mount
       * path is the whole path, so prefixing `/api` again yields `/api/api/…`,
       * which matches no pattern in `services/identity/policy.ts` and falls
       * silently to the default `READ` — every write in this harness would then
       * be authorized at the wrong level, and a refusal asserted against one
       * would be vacuous.
       */
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', manufacturingRouter);
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
    render(createElement(MachinesView, { projectId }));
  });
  await waitFor(() => expect(screen.getByText('Manufacturing programme')).toBeTruthy());
}

describe('the Machines screen, over the real route', () => {
  it('shows the service’s own verdict and explanation, word for word', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });

    // What the service says, taken before the screen is rendered.
    const view = (await programmeView(projectId))!;
    const reading = view.ladder.find(
      (one) => one.path.at(-1) === 'Commercial pressure washers',
    )!;
    expect(reading.verdict).toBe('UNEXAMINED');

    await mount();

    // The category, and the service's own sentence about it — not a synonym
    // composed here, and not a status the screen decided for itself.
    // It appears as the category heading and again in the rounds table; both
    // are the same name from the same row rather than two opinions.
    expect(screen.getAllByText(/Commercial pressure washers/).length).toBeGreaterThan(0);
    /*
     * `getAllBy`, because the same server sentence legitimately appears twice.
     *
     * Once on the category card, and once as the READINESS factor inside the
     * frontier's collapsed factor list — which is the point rather than a
     * duplication defect: both are the *server's* string, so the two places a
     * person can read it cannot disagree. A screen that composed a shorter
     * version for one of them is exactly what §29 keeps having to remove.
     */
    expect(screen.getAllByText(reading.because).length).toBeGreaterThan(0);

    // Every condition's own sentence, all five of them — the fifth being what
    // entering costs, which a verdict that could not see it was silent about.
    expect(reading.conditions).toHaveLength(5);
    for (const condition of reading.conditions) {
      // Same reason as above: a condition's sentence is also the frontier's
      // factor sentence, from one server string rather than two.
      expect(
        screen.getAllByText(condition.because).length,
        `${condition.condition} is not on the screen`,
      ).toBeGreaterThan(0);
    }

    // And the objective a person wrote, rather than a paraphrase.
    expect(screen.getByText(OBJECTIVE)).toBeTruthy();
  }, 120000);

  it('reports the programme state and the objective from the row', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await mount();
    expect(screen.getByText(/Running/)).toBeTruthy();
  }, 120000);

  it('offers no control that marks a capability held from research', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await mount();

    /*
     * Nothing on this screen records a holding while research is all there is.
     *
     * The declare control appears only against a decision the service itself
     * raised — a category where everything research can settle is settled and
     * only holding is not. An unexamined ladder raises none, so the control is
     * absent rather than merely disabled: §33 records what a form offered
     * against Brain's own work costs, and this is the same rule read forwards.
     */
    expect(screen.queryByRole('button', { name: /Record as held/i })).toBeNull();
    expect(screen.getByText(/no claim can establish that, and nothing here infers it/i)).toBeTruthy();
  }, 120000);

  it('refuses a holding with no stated reason, at the route rather than the screen', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    const program = await getProgram(projectId);

    // Post straight at the route, which is what a control nothing renders is
    // still reachable by. The refusal has to be the server's.
    const response = await fetch(`/api/projects/${projectId}/manufacturing/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chassis engineering', note: '   ' }),
    });
    expect(response.ok).toBe(false);
    expect(String((await response.json()).error)).toMatch(/records how it came to/i);

    // And nothing was written.
    expect(await listCapabilities(program!.id)).toHaveLength(0);
  }, 120000);

  it('records a holding through the route, and the screen then says so', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    const response = await fetch(`/api/projects/${projectId}/manufacturing/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'small engine integration',
        note: 'Two engine engineers hired in March, and a running prototype.',
      }),
    });
    expect(response.ok).toBe(true);

    await mount();
    expect(screen.getByText('small engine integration')).toBeTruthy();
    expect(screen.getByText(/Two engine engineers hired in March/)).toBeTruthy();
    // The word the service uses, so held and not-held stay plainly apart.
    expect(screen.getAllByText('held').length).toBeGreaterThan(0);
  }, 120000);
});


/**
 * The three decisions that are a person's, driven from the screen through the
 * real route to the real row.
 *
 * ---------------------------------------------------------------------------
 * Why these need a seam test and not a component test
 * ---------------------------------------------------------------------------
 *
 * A component suite over a scripted `fetch` passes for a control that posts a
 * field the route does not take, and a service suite with no screen passes for
 * a route nothing renders a control for. Both of those are how a control
 * becomes decorative. Here the button is pressed, the request crosses a real
 * socket to the real router, and the assertion is on the **row**.
 *
 * `cashBrowserToDatabase` records the production instance: a control that
 * posted a field the route did not read, with every server test passing.
 */
describe('the decisions that are a person’s, from the screen to the row', () => {
  async function mountFresh(): Promise<void> {
    await act(async () => {
      render(createElement(MachinesView, { projectId }));
    });
  }

  /**
   * Type into a controlled field the way a person does.
   *
   * Assigning `.value` directly is invisible to React: its value tracker sees
   * no change and the `input` event is dropped, so `onChange` never runs and
   * the button stays disabled. Going through the prototype setter is what
   * makes this a keystroke rather than a DOM mutation — and this test exists
   * precisely to catch a control that does not do what pressing it looks like
   * it does.
   */
  function type(field: Element, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }

  it('starts a programme from the screen, and stores the objective a person typed', async () => {
    await mountFresh();
    await waitFor(() => expect(screen.getByText('No manufacturing programme')).toBeTruthy());

    // Nothing exists yet, and reading the screen created nothing.
    expect(await getProgram(projectId)).toBeNull();

    /*
     * The card arrives prefilled and the objective is behind a disclosure,
     * which is §24's shape: a decision is a proposal to approve rather than a
     * form to fill in. So the objective has to be revealed before it can be
     * replaced, and this drives it exactly as a person would.
     *
     * This test used to drive a second start card this branch had added, with
     * its own confirmation step. Production had already shipped one, and the
     * duplicate was removed rather than kept: two controls doing one thing is
     * the two-readers defect at a screen. What is asserted here is what the
     * live control does — a press starts it — rather than a confirmation that
     * no longer exists, because asserting a control that is not there is a
     * vacuous guard that reads as coverage.
     */
    await act(async () => {
      screen.getByText('Change the objective').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });

    const box = dom.window.document.getElementById('machines-objective');
    expect(box).toBeTruthy();
    await act(async () => {
      type(box!, OBJECTIVE);
    });

    await act(async () => {
      screen.getByText('Start the programme').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });
    await waitFor(async () => expect(await getProgram(projectId)).not.toBeNull());

    const program = (await getProgram(projectId))!;
    // The person's own sentence, stored as typed.
    expect(program.objective).toBe(OBJECTIVE);
    // And the directive the server read for itself, rather than one a request
    // named: the path is a server constant and the digest is computed from the
    // bytes it opened.
    expect(program.blueprintPath).toBe('blueprints/MANUFACTURING-EMPIRE-KERNEL.md');
    expect(program.blueprintSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);

  it('pauses without confirming, and archives only with it', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await mount();

    await act(async () => {
      screen.getByText('Pause').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });
    await waitFor(async () => expect((await getProgram(projectId))!.state).toBe('PAUSED'));
    // And the screen's own reload of it, before anything else is pressed. The
    // row reaches PAUSED before the re-read lands, and a press in between is
    // wiped by the re-render that follows it; under a loaded runner that is
    // what made this fail with the confirmation nowhere on the page.
    await screen.findByText('Resume', {}, { timeout: 10_000 });

    // Archiving withdraws an authorization, so it asks first. One press arms it.
    await act(async () => {
      screen.getByText('Archive').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });
    expect((await getProgram(projectId))!.state).toBe('PAUSED');
    expect(await screen.findByText(/withdraw its research authority/)).toBeTruthy();

    await act(async () => {
      screen.getByText('Yes').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      );
    });
    await waitFor(async () => expect((await getProgram(projectId))!.state).toBe('ARCHIVED'));

    // Nothing was destroyed by archiving: the objective and the directive are
    // exactly where they were, and reactivating writes the grant again.
    const program = (await getProgram(projectId))!;
    expect(program.objective).toBe(OBJECTIVE);
    expect(program.blueprintSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);

  /**
   * The screen offers no control that answers a Brain-owned question.
   *
   * §33 records what a form asking a person to attest to Brain's own work
   * costs, twice. The only free-text controls here are the three things
   * research genuinely cannot establish — an objective, a capability holding,
   * and a decision this kernel cannot make — and none of them is a fact about
   * the world Brain could look up.
   */
  it('offers no control that answers something research could settle', async () => {
    await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: OBJECTIVE,
    });
    await seedCategory({ projectId, name: 'Commercial pressure washers', actorRef: userId });
    await mount();

    // Nothing invites a person to supply demand, a route, a price or a firm.
    for (const forbidden of [
      /who is buying/i,
      /what does entering cost/i,
      /add a firm/i,
      /record a figure/i,
      /mark this done/i,
    ]) {
      expect(screen.queryByPlaceholderText(forbidden), String(forbidden)).toBeNull();
    }

    // And there is no control that marks a capability held from what research
    // established — the one that exists demands a sentence saying how it came
    // to be true, and appears only against a decision the service raised.
    expect(screen.queryByText(/Record as held/)).toBeNull();
  }, 60000);
});

/**
 * One 404 at this door, and it is the project's.
 *
 * The route used to compose a second refusal of its own — *this project has no
 * manufacturing programme* — which is the same status as `requireProject`'s and
 * a different body, so the pair was an oracle in exactly the half invariant 23
 * names: *"including the body of the refusal, not only its status"*. The hosted
 * gate compared the two bodies and reported it on every deploy; nothing in the
 * suite could see it, because every test here reads a project it may read.
 *
 * These drive the real route over a real socket against a real database, and
 * assert the property from both sides of the boundary: what a member is
 * entitled to know about their own project, and what two refusals must not let
 * anybody tell apart.
 */
describe('one 404 at the manufacturing door, and it is the project’s', () => {
  it('answers a readable project with no programme rather than refusing it', async () => {
    const answer = await fetch(`/api/projects/${projectId}/manufacturing`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ programme: null });
  }, 60000);

  it('offers to start one from that answer, rather than from a 404', async () => {
    await act(async () => {
      render(createElement(MachinesView, { projectId }));
    });
    await waitFor(() => expect(screen.getByText('No manufacturing programme')).toBeTruthy());
  }, 60000);

  /**
   * The pair that has to be indistinguishable.
   *
   * A real project this person is not a member of, against an id that is not a
   * project at all. Compared whole rather than by status, because the status
   * matched the entire time the oracle existed.
   */
  it('gives a project that is not yours the body an invented id gets', async () => {
    const other = await freshProject();
    // Not a Brain administrator, or nothing would be forbidden: that role
    // reaches every project by design (§34), which is exactly why the defect
    // this asserts was invisible to every other test in this file.
    brainAdmin = false;

    const forbidden = await fetch(`/api/projects/${other.project.id}/manufacturing`);
    const invented = await fetch(`/api/projects/prj_${'0'.repeat(32)}/manufacturing`);

    expect(forbidden.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(await forbidden.text()).toBe(await invented.text());
  }, 60000);

  /**
   * And the screen behind the refusal does not offer to start a programme on
   * somebody else's project.
   *
   * That is what the old shape produced: the client branched on `status ===
   * 404`, so *no programme yet* and *not your project* rendered the identical
   * Start card, and pressing it could only ever be refused. §35: a control that
   * cannot succeed should not be offered.
   */
  it('shows the server’s refusal rather than a Start button, for a project that is not yours', async () => {
    const other = await freshProject();
    brainAdmin = false;
    await act(async () => {
      render(createElement(MachinesView, { projectId: other.project.id }));
    });
    await waitFor(() => expect(screen.getByText(/No project with that id/)).toBeTruthy());
    expect(screen.queryByText('No manufacturing programme')).toBeNull();
    expect(screen.queryByText(/Start the programme/)).toBeNull();
  }, 60000);
});
