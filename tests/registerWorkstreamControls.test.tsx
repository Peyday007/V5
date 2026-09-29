// @vitest-environment jsdom
/**
 * A workstream on the Register screen is correctable: edit, mark a link wrong,
 * archive, and read its history — each write reloading the view, each refusal
 * shown as the server's own sentence.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Register } from '../client/src/russell/Register.tsx';
import type { RegisterView, WorkstreamView } from '../client/src/lib/registerApi.ts';

interface Reply {
  status?: number;
  body: unknown;
}
let routes: Record<string, Reply> = {};
let calls: string[] = [];
let bodies: Record<string, unknown> = {};

const WS: WorkstreamView = {
  id: 'wks_1',
  projectId: null,
  title: 'Original title',
  intent: 'Original intent',
  purpose: 'CAPABILITY',
  purposeLabel: 'A capability',
  state: 'IN_PROGRESS',
  stateEvidence: 'a campaign is running',
  readings: [
    {
      linkId: 'lnk_1',
      kind: 'CAMPAIGN',
      status: 'EXECUTING',
      evidence: 'unit 1 of 2',
      missing: false,
    } as WorkstreamView['readings'][number],
  ],
  sources: [],
  blockers: [],
  ownerAction: null,
  nextAction: null,
  archivedAt: null,
  updatedAt: '2026-09-29T00:00:00.000Z',
};

const VIEW: RegisterView = {
  answers: { pursuingMoney: [], beingBuilt: ['wks_1'], running: ['wks_1'], blocked: [], needsYou: [], shipped: [] },
  workstreams: [WS],
  unfiled: [],
  unknown: 0,
  generatedAt: '2026-09-29T00:00:00.000Z',
} as unknown as RegisterView;

beforeEach(() => {
  calls = [];
  bodies = {};
  routes = { 'GET /api/register': { body: VIEW } };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push(key);
    if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body) as unknown;
    const answer = routes[key] ?? { status: 404, body: { error: 'No such route.' } };
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => JSON.stringify(answer.body),
    } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function shown(): Promise<void> {
  render(<Register projectId={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: /Running/ }));
  await screen.findByText('Original title');
}
const registerReads = (): number => calls.filter((c) => c === 'GET /api/register').length;

describe('Register workstream controls', () => {
  it('A01: editing sends PATCH with the edited fields, then re-reads the register', async () => {
    routes['PATCH /api/register/workstreams/wks_1'] = { body: { workstream: WS } };
    await shown();
    const before = registerReads();
    fireEvent.click(screen.getByRole('button', { name: 'Edit what this is' }));
    fireEvent.change(screen.getByDisplayValue('Original title'), { target: { value: 'New title' } });
    fireEvent.change(screen.getByDisplayValue('Original intent'), { target: { value: 'New intent' } });
    fireEvent.click(screen.getByLabelText(/Pursuing money/));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(registerReads()).toBe(before + 1));
    expect(bodies['PATCH /api/register/workstreams/wks_1']).toEqual({
      title: 'New title',
      intent: 'New intent',
      purpose: 'REVENUE_DIRECT',
    });
  });

  it('A02: supersede and archive need a reason and send it', async () => {
    routes['POST /api/register/workstreams/wks_1/links/lnk_1/supersede'] = { body: { superseded: true } };
    routes['POST /api/register/workstreams/wks_1/archive'] = { body: { workstream: WS } };
    await shown();
    fireEvent.click(screen.getByRole('button', { name: /what it is made of/ }));

    fireEvent.click(screen.getByRole('button', { name: 'This link is wrong' }));
    const mark = screen.getByRole('button', { name: 'Mark it wrong' }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/This link is wrong: why/), { target: { value: 'wrong row' } });
    expect(mark.disabled).toBe(false);
    fireEvent.click(mark);
    await waitFor(() =>
      expect(bodies['POST /api/register/workstreams/wks_1/links/lnk_1/supersede']).toEqual({ reason: 'wrong row' }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]!);
    const archive = screen.getByRole('button', { name: 'Archive it' }) as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Archive: why/), { target: { value: 'done with it' } });
    fireEvent.click(archive);
    await waitFor(() =>
      expect(bodies['POST /api/register/workstreams/wks_1/archive']).toEqual({ reason: 'done with it' }),
    );
  });

  it('A03: history makes no request until opened, then lists event summaries', async () => {
    routes['GET /api/register/workstreams/wks_1'] = {
      body: {
        workstream: WS,
        corrections: [],
        events: [
          { id: 'e1', workstreamId: 'wks_1', kind: 'WORKSTREAM_AMENDED', summary: 'A person changed it.', detail: {}, actorRef: 'p', createdAt: '2026-09-29T01:00:00.000Z' },
        ],
      },
    };
    await shown();
    expect(calls).not.toContain('GET /api/register/workstreams/wks_1');
    fireEvent.click(screen.getByRole('button', { name: /Show history/ }));
    expect(await screen.findByText(/A person changed it\./)).toBeTruthy();
    expect(calls).toContain('GET /api/register/workstreams/wks_1');
  });

  it('A04: a refused write shows the server sentence verbatim', async () => {
    routes['PATCH /api/register/workstreams/wks_1'] = {
      status: 404,
      body: { error: 'There is nothing here for you to see.' },
    };
    await shown();
    fireEvent.click(screen.getByRole('button', { name: 'Edit what this is' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('There is nothing here for you to see.')).toBeTruthy();
  });
});
