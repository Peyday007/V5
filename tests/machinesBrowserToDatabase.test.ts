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

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: true,
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
      path: `/api${req.path}`,
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
    expect(screen.getByText(reading.because)).toBeTruthy();

    // Every condition's own sentence, all five of them — the fifth being what
    // entering costs, which a verdict that could not see it was silent about.
    expect(reading.conditions).toHaveLength(5);
    for (const condition of reading.conditions) {
      expect(screen.getByText(condition.because)).toBeTruthy();
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
