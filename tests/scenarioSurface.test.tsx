/**
 * The Scenarios screen over the real route over the real database.
 *
 * The jsdom-by-hand construction and the real socket are
 * `laborSurface.test.tsx`'s, for its reason: a component over a scripted
 * `fetch` passes for a control that posts a field the route does not take.
 *
 * What is asserted here: the read-only demonstration renders as a labelled
 * simulation — never as money earned, and a sweep never as a probability — and
 * a person can save a copy, run it, and see the run land as a row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { scenarioRouter } from '../server/routes/scenario.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { getDb } from '../server/db/database.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'DOMParser'] as const) {
  Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { ScenariosView } = await import('../client/src/russell/Scenarios.tsx');

let projectId = '';
let userId = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

function principal(): Principal {
  return {
    type: 'HUMAN', id: userId, handle: 'owner@example.test', displayName: 'The owner', isBrainAdmin: false,
    mustChangePassword: false, credentialId: 'ses_browser', authMethod: 'SESSION_COOKIE',
    memberships: [{ id: 'mem', projectId, principalType: 'HUMAN', principalId: userId, role: 'MEMBER', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test', grantedAt: '2026-01-01T00:00:00.000Z', active: true } as ProjectMembership],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `scn-ui-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'The owner', password: 'correct horse battery staple' })).id;
  await grantMembership({ projectId, principalType: 'HUMAN', principalId: userId, role: 'MEMBER', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test' });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    attachContext(req, { principal: principal(), requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
    next();
  });
  app.use('/api', scenarioRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error), detail: error?.detail });
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

describe('the Scenarios screen', () => {
  it('renders the read-only demonstration as a labelled simulation, never as earned money or a probability', async () => {
    await act(async () => { render(createElement(ScenariosView, { projectId })); });
    await waitFor(() => expect(screen.getByText(/Result — simulated, illustrative inputs/)).toBeTruthy(), { timeout: 15_000 });
    expect(screen.getByText(/Sweep \(Latin hypercube\).*not probabilities/)).toBeTruthy();
    expect(screen.getByText(/of tested scenarios/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/estimated probability/);
    for (const label of ['Premium price, contractors', 'Volume price, employees', 'Balanced, hybrid crew', 'Lean test']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Trade-offs')).toBeTruthy();
    expect(screen.getByText('What to find out next')).toBeTruthy();
    expect(screen.getAllByText('Hypothetical').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByText(/Read-only\. Every input is illustrative/)).toBeTruthy();
    // The demonstration is editable only as a copy: its range inputs are not offered.
    expect(screen.queryByLabelText('Enquiries per month minimum')).toBeNull();
  });

  it('lets a person save an editable copy, run it, and see the run land as a row', async () => {
    await act(async () => { render(createElement(ScenariosView, { projectId })); });
    await waitFor(() => expect(screen.getByText(/Result — simulated/)).toBeTruthy(), { timeout: 15_000 });
    await act(async () => { fireEvent.click(screen.getAllByRole('button').find((b) => /Save an editable copy of the demonstration/.test(b.textContent ?? ''))!); });
    await waitFor(() => expect(screen.getByLabelText('Enquiries per month minimum')).toBeTruthy(), { timeout: 15_000 });
    const evaluations = screen.getByLabelText(/Evaluations/) as HTMLInputElement;
    fireEvent.change(evaluations, { target: { value: '2000' } });
    await act(async () => { fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === 'Run scenarios')!); });
    await waitFor(() => expect(screen.getByText(/2,000 evaluations: 500 scenarios × 4 strategies/)).toBeTruthy(), { timeout: 15_000 });
    const rows = await getDb().all<{ state: string; evaluations: number | string }>('SELECT state, evaluations FROM scenario_runs');
    expect(rows).toEqual([{ state: 'COMPLETE', evaluations: expect.anything() }]);
    expect(Number(rows[0]!.evaluations)).toBe(2000);
  });
});
