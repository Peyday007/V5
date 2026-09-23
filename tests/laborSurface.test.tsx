/**
 * The Labor screen over the real route over the real database.
 *
 * ---------------------------------------------------------------------------
 * Why this seam needs its own file
 * ---------------------------------------------------------------------------
 *
 * `cashBrowserToDatabase.test.ts` records the reason and §33 records what it
 * cost in production: a component suite over a scripted `fetch` and a service
 * suite with no screen both pass for a control that posts a field the route
 * does not take, or a screen that renders a form for a decision that is not a
 * person's. The seam between them is where those live, and this kernel had
 * *neither* half — a complete server door, covered on both backends, and no
 * screen at all. Nothing in any browser called any of it.
 *
 * ---------------------------------------------------------------------------
 * What is asserted here and nowhere else
 * ---------------------------------------------------------------------------
 *
 * **The operator journey, walked once.** A person opens an empty map, names a
 * workflow, names a task in it, records that a person produces it and why, and
 * then records that Brain does — and every one of those is a real POST through
 * the real route, checked afterwards against the rows rather than against what
 * the screen said. §24 and §30 both record the same lesson: a test that
 * arranges its own starting state cannot tell a mechanism from a function
 * nobody calls, which is exactly what this kernel's whole surface was.
 *
 * **An unknown is never rendered as a number.** Four of §11's figures are
 * `UNKNOWN` and will stay so until somebody builds the measurement. A zero
 * there would be quoted in a decision about whether to keep employing
 * somebody, so the assertion is on the words rather than on the styling.
 *
 * **A control somebody may not use is disabled with the server's reason.** Not
 * removed — §35 — so an ordinary member sees the same page an administrator
 * does, with the sentence saying which decision is not theirs.
 *
 * The jsdom-by-hand construction, the dynamic imports and the real socket are
 * all `machinesBrowserToDatabase`'s; see its opening comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { laborRouter } from '../server/routes/labor.ts';
import { listWorkflows, listTasks, listAllocations } from '../server/repos/labor.ts';
import { laborView } from '../server/services/labor/view.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
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
const { LaborView } = await import('../client/src/russell/Labor.tsx');

let projectId = '';
let userId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

/**
 * Who is driving these requests.
 *
 * Both dimensions matter and they are not the same one. A Brain administrator
 * reaches every project by design, so a suite that only ever ran as one could
 * not see a refusal at all; and every decision on this screen is project
 * `ADMIN`, so the *level* is what the capabilities actually turn on. Reset in
 * `beforeEach`, so a block that lowers either cannot leak into the next.
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

beforeEach(async () => {
  brainAdmin = true;
  role = 'ADMIN';
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `labor-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
       * already carries.
       *
       * `req.path` in a middleware registered with no mount path is the **whole**
       * path — `/api/projects/x/labor/workflows` — so prefixing `/api` again
       * yields `/api/api/…`, which matches no pattern in
       * `services/identity/policy.ts` and silently falls to the default `READ`.
       * Every write in this harness would then be authorized at the wrong level,
       * and a refusal asserted against it would be vacuous — which §41 already
       * records as worse than no guard, because it reads as coverage. Measured
       * rather than reasoned: the member-level refusal below answered 200 with
       * the doubled prefix and 404 without it.
       */
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', laborRouter);
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

async function mount(id: string | null = projectId): Promise<void> {
  await act(async () => {
    render(createElement(LaborView, { projectId: id }));
  });
}

/** The heading every populated render carries, so a mount can be waited on. */
async function mounted(id: string | null = projectId): Promise<void> {
  await mount(id);
  await waitFor(() => expect(screen.getByText('Who does the work')).toBeTruthy());
}

function button(label: RegExp): HTMLButtonElement {
  const found = screen
    .getAllByRole('button')
    .find((one) => label.test(one.textContent ?? '')) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`no button matching ${label}`);
  return found;
}

/**
 * The same lookup, waited for.
 *
 * A control that appears because a *re-read* landed is not on the screen the
 * instant the press that caused it returns, and a test that assumed otherwise
 * would fail on a slow machine and pass on a fast one. Waiting is not a
 * weakening: the assertion is still that the control exists.
 */
async function waitForButton(label: RegExp): Promise<HTMLButtonElement> {
  return await waitFor(() => button(label));
}

/** Type into the field whose label says this, the way a person does. */
function type(label: string, value: string): void {
  const field = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
}

/* ========================================================================= */

describe('the Labor screen, over the real route', () => {
  it('shows the four states a reader can be in', async () => {
    // No project: not an error and not an empty map. A different sentence,
    // because "open a project" and "this project has nothing on it" send a
    // person to two different places.
    await mount(null);
    expect(screen.getByText(/Open a project to see who does its work/)).toBeTruthy();
    cleanup();

    /*
     * An id that is not a project, which is the same 404 a project somebody may
     * not read gives — invariant 23, where the thing being hidden is who does
     * somebody else's work. So the screen renders the *server's* sentence and
     * must not claim the map is empty or that access was refused: it cannot
     * tell, and neither may the last hop.
     */
    await mount('prj_0000000000000000000000000');
    await waitFor(() => expect(screen.getByText(/No project with that id/)).toBeTruthy());
    cleanup();

    // A readable project with nothing on it: the server's own summary, which is
    // the same sentence `npm run report:labor` prints.
    const empty = await laborView(projectId);
    expect(empty.summary).toMatch(/Nothing is on the labor map yet/);
    await mounted();
    expect(screen.getByText(empty.summary)).toBeTruthy();
    // And the one thing a person can do about it is on the screen.
    expect(button(/Name it/)).toBeTruthy();
  });

  it('walks the journey a person actually takes, and the rows follow', async () => {
    await mounted();

    /* --- naming a workflow ------------------------------------------------ */
    type('Workflow name', 'Quoting a junk removal job');
    await act(async () => {
      fireEvent.click(button(/Name it/));
    });
    await waitFor(async () => {
      expect((await listWorkflows(projectId)).map((one) => one.name)).toContain(
        'Quoting a junk removal job',
      );
    });
    // The server's own sentence, not a confirmation composed here — and it is
    // the one that says declaring spends nothing.
    await waitFor(() =>
      expect(screen.getByText(/Nothing has been spent and no research has started/)).toBeTruthy(),
    );

    /* --- naming a task in it ---------------------------------------------- */
    await waitFor(() => expect(screen.getByLabelText('Task name')).toBeTruthy());
    type('Task name', 'Price the load');
    type('What one completed output is', 'One quoted price a customer can accept');
    await act(async () => {
      fireEvent.click(button(/Name the task/));
    });
    const task = await waitFor(async () => {
      const [found] = await listTasks(projectId);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(task.name).toBe('Price the load');
    expect(task.output).toBe('One quoted price a customer can accept');

    /* --- a task nobody has decided is counted apart ----------------------- */
    await waitFor(() => expect(screen.getByText(/Nobody has decided who produces this/)).toBeTruthy());
    const undecided = await laborView(projectId);
    expect(undecided.economics[0]?.undecided).toBe(1);
    expect(undecided.economics[0]?.humanTasks).toBe(0);
    expect(undecided.economics[0]?.machineTasks).toBe(0);
    // Never folded into either side: a workflow whose one task nobody has
    // looked at is not automated and has no human role either.
    expect(undecided.economics[0]?.fullyAutomated).toBe(false);

    /* --- recording that a person produces it ------------------------------ */
    const record = await waitForButton(/Record who produces/);
    await act(async () => {
      fireEvent.click(record);
    });
    const layer = screen.getByLabelText('Produced by') as HTMLSelectElement;
    // The vocabulary is the server's, so the set offered and the set the route
    // validates against are one object.
    expect([...layer.options].map((one) => one.value)).toContain('SPECIALIST_PROFESSIONAL');
    fireEvent.change(layer, { target: { value: 'SPECIALIST_PROFESSIONAL' } });
    // A human layer demands a reason, and the form knows which layers those are
    // because the server said — never because a name reads like a person.
    const reason = await waitFor(
      () => screen.getByLabelText('Which reason makes a person necessary') as HTMLSelectElement,
    );
    fireEvent.change(reason, { target: { value: 'HUMAN_INTERFACE' } });
    type('Why', 'Quoting is a negotiation and the customer is standing there.');
    await act(async () => {
      fireEvent.click(button(/Record it/));
    });

    const allocations = await waitFor(async () => {
      const found = (await listAllocations(projectId)).filter((one) => one.taskId === task.id);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(allocations[0]?.productionLayer).toBe('SPECIALIST_PROFESSIONAL');
    expect(allocations[0]?.necessityReason).toBe('HUMAN_INTERFACE');

    /*
     * The note the server attaches to every human allocation, shown verbatim.
     * It is the one thing a person might reasonably think this screen does and
     * it does not, so a reassurance composed here would be the wrong reader of
     * the most consequential sentence on the page.
     */
    await waitFor(() =>
      expect(screen.getByText(/Recording that a person produces this engages nobody/)).toBeTruthy(),
    );

    // And the role is now on the map with what backs it — which is
    // `ASSERTED` rather than `PERSON`: somebody recorded who produces the
    // task, and nothing answered the question of why a person is necessary.
    /*
     * Scoped to the roles section, because two sections legitimately carry the
     * reason and an unscoped query stopped naming which one it meant.
     *
     * The second element is the **capacity need**, not a label the form
     * offered — this comment said the latter, and the correction is recorded
     * here rather than quietly applied, because a comment that misnames the
     * other match sends the next reader to look at form lifecycle when the
     * answer is a second section. Re-measured on this tree rather than argued:
     * the two elements carrying the words are `STRONG|human interface` and
     * `P.rs-item-meta|The role exists for human interface.`, which is what
     * deploy 317's own failure dump listed too. `capacityNeeds` carries
     * `allocation.necessityReason` the moment a human layer is recorded with
     * nothing published about sourcing it, so recording the role writes both
     * at once and the second one is permanent rather than transient.
     *
     * `waitFor` resolves on its first successful poll, so the unscoped query
     * passed only while that poll landed in the gap between the two renders
     * and threw the moment a runner was loaded enough for both to be there.
     * `getAllByText` would also have made it pass and is the weaker reading:
     * it is satisfied by the needs section alone, which says nothing about
     * the role having reached the map.
     */
    await waitFor(() => {
      const roles = document.querySelector('.rs-labor-roles') as HTMLElement | null;
      expect(roles).toBeTruthy();
      expect(within(roles!).getByText(/human interface/)).toBeTruthy();
    });

    /*
     * And the correction their fix leaves behind, which is the half of mine
     * that does not overlap.
     *
     * Two sessions found this race independently; the one on `production`
     * ships, which is this repository's own rule about a number that landed
     * first. What it preserves is the comment three lines up, and that comment
     * has never been true: it claims the backing is `PERSON` "because somebody
     * answered the question", and no assertion here has ever read the backing
     * — `/human interface/` did not, and `not.toBe('RESEARCH')` below is
     * satisfied by `ASSERTED` and `PERSON` alike.
     *
     * It is `ASSERTED`, and the product is right. Recording *who produces* a
     * task writes an allocation, not a `labor_necessity_answers` row, and
     * `HUMAN_INTERFACE` is one of the reasons `questionAnsweredBy` settles
     * nothing for. So a person has said a person is necessary and nothing
     * backs that, which is exactly the distinction the field exists to keep.
     *
     * An assertion weak enough to pass either way is what let the comment
     * beside it drift, so this reads the sentence the screen actually renders.
     */
    const role = within(
      document.querySelector('.rs-labor-roles') as HTMLElement,
    ).getByText(/Necessary because of/);
    expect(role.textContent).toMatch(/human interface/);
    expect(role.textContent).toMatch(/nothing — the reason is asserted/);
    const withRole = await laborView(projectId);
    expect(withRole.humanDependencies).toHaveLength(1);
    // Pinned exactly rather than as "not RESEARCH", which ASSERTED and PERSON
    // both satisfy: the value that is true here is the one worth guarding.
    expect(withRole.humanDependencies[0]?.backing).toBe('ASSERTED');

    /* --- and then moving it to Brain -------------------------------------- */
    const again = await waitForButton(/Record who produces/);
    await act(async () => {
      fireEvent.click(again);
    });
    fireEvent.change(screen.getByLabelText('Produced by'), { target: { value: 'BRAIN' } });
    // No reason is asked for, because the schema does not demand one.
    expect(screen.queryByLabelText('Which reason makes a person necessary')).toBeNull();
    type('Why', 'The pricing rule is published and Brain applies it.');
    await act(async () => {
      fireEvent.click(button(/Record it/));
    });

    const moved = await waitFor(async () => {
      const view = await laborView(projectId);
      expect(view.roleCompression.length).toBeGreaterThan(0);
      return view;
    });
    // Both directions are reportable and this one is a compression; the
    // superseded decision keeps its row, which is the only reason this reading
    // can exist at all.
    expect(moved.roleCompression[0]?.direction).toBe('COMPRESSED');
    expect(moved.roleCompression[0]?.from).toBe('SPECIALIST_PROFESSIONAL');
    expect(moved.roleCompression[0]?.to).toBe('BRAIN');
    expect(
      (await listAllocations(projectId)).filter((one) => one.taskId === task.id).length,
    ).toBe(2);
    await waitFor(() => expect(screen.getByText(/specialist professional → brain/)).toBeTruthy());
  });

  it('renders an unmeasured figure as unmeasured, never as a number', async () => {
    await mounted();
    const view = await laborView(projectId);
    const unknown = view.measurements.filter((one) => one.evidence === 'UNKNOWN');
    // The four §11 asks for and Brain cannot take. If this number ever falls,
    // something started reporting a figure nobody measured.
    expect(unknown.map((one) => one.key).sort()).toEqual([
      'costPerOutput',
      'errorRate',
      'humanHours',
      'timePerOutput',
    ]);

    for (const figure of unknown) {
      const label = screen.getByText(figure.label);
      const row = label.parentElement!;
      // The words, rather than the styling: an italic zero is still a zero.
      expect(row.textContent).toContain('not measured');
      expect(row.textContent).not.toMatch(/\b0\b/);
      // And what would measure it, so the row is a task rather than a blank.
      expect(screen.getByText(figure.note)).toBeTruthy();
    }

    // The counted ones are still counted, so this is not a screen that simply
    // refuses to show numbers.
    const measured = view.measurements.find((one) => one.key === 'tasks')!;
    expect(measured.evidence).toBe('MEASURED');
    expect(measured.value).toBe(0);
  });

  it('disables what is not yours with the server’s reason rather than removing it', async () => {
    brainAdmin = false;
    role = 'MEMBER';
    await mounted();

    // The whole map is readable — which is the point of the read being the
    // default level: who does the work here is what a person working on this
    // project most needs to see without asking an administrator.
    const view = await laborView(projectId);
    expect(screen.getByText(view.summary)).toBeTruthy();
    expect(screen.getByText('What is measured, and what is not')).toBeTruthy();

    // And the decisions are present as refusals rather than absent, so the page
    // has the same shape for both readers and the sentence says which decision
    // is not theirs.
    expect(screen.getByText('Name a workflow')).toBeTruthy();
    expect(screen.queryByLabelText('Workflow name')).toBeNull();
    expect(
      screen.getByText(/decisions an administrator of this project makes/),
    ).toBeTruthy();

    // A hidden button is not authorization, so the route refuses it too.
    const refused = await fetch(`/api/projects/${projectId}/labor/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Something a member tried to name' }),
    });
    expect(refused.status).toBe(404);
    expect(await listWorkflows(projectId)).toHaveLength(0);
  });

  it('offers only the decisions the domain reserves to a person', async () => {
    /*
     * The one thing this screen must never grow.
     *
     * §33 records what a card asking a person to attest to Brain's own work
     * cost: a `BRAIN_RESEARCH` requirement with an answer box under it, and
     * whatever was typed recorded as a fact that outranks anything Brain later
     * establishes. The necessity questions are Brain's to research, and there
     * is deliberately no route that answers one — so there must be no control
     * here that looks as though there were.
     */
    await mounted();
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('client/src/russell/Labor.tsx', 'utf8'),
    );
    const posts = [...source.matchAll(/api<[^>]*>\(\s*`([^`]+)`/g)].map((match) => match[1]!);
    for (const path of posts) {
      expect(
        /\/labor(\/workflows|\/tasks\/[^/]+\/allocation|$)/.test(path.replace(/\$\{[^}]*\}/g, 'x')),
        `${path} is not one of the labor kernel's own routes`,
      ).toBe(true);
    }
    // Nothing on this screen posts a necessity answer, because nothing can.
    expect(source).not.toMatch(/necessity\/(answer|questions)/);
  });
});
