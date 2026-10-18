/**
 * The puzzle screen's one control, from the screen through the real route to a row.
 *
 * A format reaches SELLABLE only on a recorded HUMAN_EDIT_PASSED, and nothing in
 * the product could send one. The harness is laborSurface's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { cashRouter } from '../server/routes/cash.ts';
import { listPuzzleObservations } from '../server/repos/puzzle.ts';
import type { PuzzleView } from '../server/services/puzzle/view.ts';
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

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { PuzzlesView } = await import('../client/src/russell/Puzzles.tsx');

let projectId = '';
let userId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

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
    email: `puzzles-${Math.random().toString(36).slice(2, 10)}@example.test`,
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
    // The view is scripted, because reaching PRODUCTIZABLE takes a researched
    // channel and a qualified product; the write is the real route.
    if (url.endsWith('/cash/puzzles') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
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

let view: Partial<PuzzleView> = {};

function viewWith(rung: string, remedy: string): Partial<PuzzleView> {
  return {
    rightNow: {
      formatsOnMap: 1,
      formatsBrainCanMake: 1,
      systems: 1,
      validPuzzles: 40,
      qualifiedProducts: 2,
      promoted: 0,
      collectedCents: 0,
      currency: null,
      furthest: null,
    },
    maturity: [
      {
        formatKey: 'sudoku',
        name: 'Sudoku',
        rung: rung as never,
        remedy: remedy as never,
        reached: [],
        waitingOn: 'Nobody has read or played a sample of what this system produces.',
        evidence: { validPuzzles: 40, products: 2, buyers: 1 } as never,
        limitation: null as never,
      },
    ],
    recent: [],
    needsPerson: [],
    nextAction: 'Read a sample.',
  };
}

describe('the puzzle read a person records', () => {
  it('posts HUMAN_EDIT_PASSED for the format through the real route, and the row exists', async () => {
    view = viewWith('PRODUCTIZABLE', 'PERSON');
    await act(async () => {
      render(createElement(PuzzlesView, { projectId }));
    });
    const box = await waitFor(() => screen.getByLabelText('What you read of Sudoku'));
    fireEvent.change(box, { target: { value: 'Solved puzzles 1 and 90 of the Vol. 1 PDF; one solution each.' } });
    const press = screen
      .getAllByRole('button')
      .find((one) => /Record that a person read it/.test(one.textContent ?? ''))!;
    await act(async () => {
      fireEvent.click(press);
    });
    await waitFor(() => expect(screen.getByText(/the one thing that can move a format to SELLABLE/)).toBeTruthy());
    const rows = await listPuzzleObservations(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'HUMAN_EDIT_PASSED', formatKey: 'sudoku', recordedBy: userId });
  });

  it('offers no control where a reading would move nothing', async () => {
    view = viewWith('VALIDATABLE', 'PERSON');
    await act(async () => {
      render(createElement(PuzzlesView, { projectId }));
    });
    await waitFor(() => expect(screen.getByText('Sudoku')).toBeTruthy());
    expect(screen.queryByLabelText('What you read of Sudoku')).toBeNull();
  });
});
