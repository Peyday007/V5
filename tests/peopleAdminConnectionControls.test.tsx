// @vitest-environment jsdom
/**
 * The two People-page decisions an administrator could only make from a
 * terminal: taking somebody else's connection back, and recording an existing
 * Routine as somebody's. Scripted fetch; every sentence is the server's.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../client/src/russell/ClaudeConnection.tsx', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ClaudeConnectionPanel: () => null,
}));
import { PeopleAndCapacityView } from '../client/src/russell/People.tsx';
import type { ConnectionSummary } from '../client/src/lib/peopleApi.ts';

interface Reply {
  status?: number;
  body: unknown;
}
let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const SUMMARY: ConnectionSummary = {
  userId: 'usr_airyn',
  displayName: 'Airyn',
  state: 'WAITING_FOR_ADMIN',
  secretName: 'BRAIN_ROUTINE_TOKEN_AIRYN',
  triggerRef: 'trig_airyn',
  routineId: null,
  failureReason: null,
  invitationRequestedAt: null,
  invitationIssuedAt: null,
  revokedAt: null,
  revokedReason: null,
  updatedAt: '2026-09-29T00:00:00.000Z',
};

const page = (isBrainAdmin: boolean): unknown => ({
  you: { userId: 'usr_root', isBrainAdmin },
  people: { rows: [], joined: 0, invited: 0 },
  capacity: { eligibleNow: 0, proven: 0, waiting: 0, unavailable: 0, target: null, surfaces: [], historical: [] },
  contributed: { surfaces: [], usable: 0, total: 0 },
  me: { state: 'NOT_STARTED' }, // the panel is stubbed; the page only needs it present
  contract: { mcpUrl: 'https://brain.example/mcp', bootstrapRepository: 'brain-worker-bootstrap' },
});

beforeEach(() => {
  calls = [];
  bodies = {};
  routes = {};
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push(key);
    if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body) as unknown;
    const found = routes[key];
    const answer: Reply = !found ? { status: 404, body: { error: 'No such route.' } } : typeof found === 'function' ? found() : found;
    const status = answer.status ?? 200;
    return { ok: status < 300, status, statusText: '', text: async () => JSON.stringify(answer.body) } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountAdmin(): Promise<void> {
  routes['GET /api/people'] = { body: page(true) };
  routes['GET /api/people/connections'] = { body: { connections: [SUMMARY] } };
  routes['GET /api/members'] = { body: { links: [] } };
  await act(async () => {
    render(<PeopleAndCapacityView />);
  });
  fireEvent.click(await screen.findByRole('button', { name: /Connections \(1\)/ }));
}

describe('administrator connection controls', () => {
  it('gates revoke on a reason, posts it, and re-reads', async () => {
    await mountAdmin();
    routes['POST /api/people/usr_airyn/claude/revoke'] = { body: {} };
    fireEvent.click(screen.getByRole('button', { name: 'Take this connection back' }));
    const confirm = screen.getByRole('button', { name: 'Confirm taking it back' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why are you taking it back/), { target: { value: 'lost device' } });
    expect(confirm.disabled).toBe(false);
    const before = calls.filter((c) => c === 'GET /api/people/connections').length;
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(bodies['POST /api/people/usr_airyn/claude/revoke']).toEqual({ reason: 'lost device' });
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/people/connections').length).toBeGreaterThan(before));
  });

  it('adopts a Routine and renders a refusal verbatim', async () => {
    await mountAdmin();
    routes['POST /api/people/usr_airyn/claude/adopt'] = { status: 422, body: { error: 'Brain has no Routine with that reference.' } };
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'usr_airyn' } });
    fireEvent.change(screen.getByLabelText('Routine reference'), { target: { value: 'trig_nope' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record this Routine' }));
    });
    expect(bodies['POST /api/people/usr_airyn/claude/adopt']).toEqual({ routineRef: 'trig_nope' });
    expect(await screen.findByText('Brain has no Routine with that reference.')).toBeTruthy();
  });

  it('shows neither control to a non-administrator', async () => {
    routes['GET /api/people'] = { body: page(false) };
    await act(async () => {
      render(<PeopleAndCapacityView />);
    });
    expect(screen.queryByText(/Record an existing Routine/)).toBeNull();
    expect(calls).not.toContain('GET /api/people/connections');
  });
});
