// @vitest-environment jsdom
/**
 * Integration 3 — the product surfaces, driven through the real shell.
 *
 * `fetch` is scripted rather than modules mocked, so every component goes
 * through the same `api()` it uses in production — including the error path,
 * which is where a database that did not answer has to become "retrying" and
 * never "not authorized".
 *
 * What is asserted is what a person would notice when it is wrong: the six
 * primary destinations in their order at both widths, everything demoted still
 * one tap away, research followed without an id on the primary screen, Needs
 * you grouped by kind with a real action, connection states that keep
 * "reconnect" for a connector whose authorization is genuinely gone, Build in
 * plain words, Cash's first blocker as a sentence, and Home's summary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { listState } from '../client/src/russell/present.ts';
import { ApiError, api } from '../client/src/lib/api.ts';
import { FirstBlocker } from '../client/src/russell/Cash.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`;
    calls.push(key);
    const found = routes[key];
    const answer: Reply = !found
      ? { status: 404, body: { error: 'No such route.' } }
      : typeof found === 'function'
        ? found()
        : found;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => JSON.stringify(answer.body),
    } as Response;
  });
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

const USER = { id: 'usr_1', email: 'a@b.test', displayName: 'Ada', isBrainAdmin: false, mustChangePassword: false };
const PROJECT = { id: 'prj_1', name: 'Deal Dispatch', slug: 'deal-dispatch' };

const CATEGORIES = [
  { key: 'AUTHORITY', label: 'Permission to act' },
  { key: 'BUDGET', label: 'Budget and ceilings' },
  { key: 'JUDGMENT', label: 'Your judgment' },
  { key: 'RESEARCH_JUDGMENT', label: 'Research that needs your judgment' },
  { key: 'BUYER', label: 'Buyers and agreements' },
  { key: 'INVOICE', label: 'Invoice details' },
  { key: 'FINANCIAL', label: 'Money that needs a person' },
  { key: 'RELEASE', label: 'Approve, merge or release a build' },
  { key: 'CONNECTION', label: 'Connections and accounts' },
  { key: 'OTHER', label: 'Other decisions' },
];

function item(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'x',
    category: 'JUDGMENT',
    title: 'A decision',
    reason: 'Because it is yours.',
    ifIgnored: 'It waits.',
    requestedAction: 'Decide.',
    affects: 'This project',
    continuing: 'Brain carries on with everything else meanwhile.',
    urgency: 'BLOCKING',
    since: null,
    action: { type: 'OPEN', destination: 'CASH', label: 'Open Cash' },
    ...over,
  };
}

const INBOX = 'GET /api/russell/needs-you/inbox?projectId=prj_1';

function baseRoutes(over: Record<string, Reply | (() => Reply)> = {}): void {
  routes = {
    'GET /api/auth/session': { body: { authenticated: true, user: USER } },
    'GET /api/projects': { body: { projects: [PROJECT] } },
    'GET /api/russell/conversations': { body: { conversations: [{ id: 'rcv_1', title: 'A thread' }] } },
    'GET /api/russell/conversations/rcv_1': { body: { conversation: { id: 'rcv_1', title: 'A thread' }, turns: [] } },
    'GET /api/russell/collections?projectId=prj_1': { body: { collections: [] } },
    [INBOX]: { body: { items: [], categories: CATEGORIES, unreadable: [] } },
    'GET /api/russell/summary?projectId=prj_1': {
      body: {
        summary: {
          cash: { sentence: 'USD 120.00 received, USD 80.00 earned after costs.', detail: '1 ready to test.', retrying: false },
          research: { sentence: '2 being researched now, 1 finished.', detail: null, retrying: false },
          build: { sentence: '1 being built.', detail: null, retrying: false },
        },
      },
    },
    ...over,
  };
}

async function mount(): Promise<void> {
  const { default: Root } = await import('../client/src/Root.tsx');
  await act(async () => {
    render(<Root />);
  });
}

const PRIMARY = ['Home', 'Cash', 'Research', 'Build', 'Needs you', 'Who'];

describe('navigation is six destinations, and nothing useful was lost', () => {
  it('shows the six primary destinations in order on a desktop', async () => {
    baseRoutes();
    await mount();
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const groups = within(nav).getAllByRole('list');
    const primary = within(groups[0]!).getAllByRole('button').map((one) => one.textContent?.replace(/\d+$/, '').trim());
    expect(primary).toEqual(PRIMARY);
  });

  it('keeps the same six on a phone, with everything else one tap away in More', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    baseRoutes();
    await mount();
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const primary = within(within(nav).getAllByRole('list')[0]!)
      .getAllByRole('button')
      .map((one) => one.textContent?.replace(/\d+$/, '').trim());
    expect(primary).toEqual(PRIMARY);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
    });
    for (const name of [
      'All work',
      'Ideas',
      'What Brain knows',
      'Connected sites',
      'Machines',
      'Labor',
      'People & capacity',
      'Your devices',
      'Full console',
      'Sign out',
      'Search',
    ]) {
      expect(screen.getByRole('menuitem', { name }), name).toBeTruthy();
    }
  });

  it('opens Research at its own address', async () => {
    baseRoutes({
      'GET /api/projects/prj_1/research/overview': {
        body: {
          overview: { goals: [], other: [], counts: {}, technicalHidden: 0, headline: 'Brain is not researching anything in this project right now.' },
        },
      },
    });
    await mount();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Research' }));
    });
    expect(window.location.pathname).toBe('/research');
    expect(await screen.findByText(/not researching anything/)).toBeTruthy();
  });
});

describe('Home says what Brain is doing for you', () => {
  it('leads with what needs you, then money, research and building', async () => {
    baseRoutes({
      [INBOX]: { body: { items: [item({ id: 'a' }), item({ id: 'b' })], categories: CATEGORIES, unreadable: [] } },
    });
    await mount();
    expect(await screen.findByText(/2 things need your decision\./)).toBeTruthy();
    expect(screen.getByText('USD 120.00 received, USD 80.00 earned after costs.')).toBeTruthy();
    expect(screen.getByText('2 being researched now, 1 finished.')).toBeTruthy();
    expect(screen.getByText('1 being built.')).toBeTruthy();
    // The badge and the line come from one reading.
    expect(screen.getByLabelText('2 waiting')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Money/ }));
    });
    expect(window.location.pathname).toBe('/cash');
  });
});

describe('Research is followed by its questions, not its rows', () => {
  const overview = {
    goals: [
      {
        budget: {
          goalId: 'rgl_1',
          name: 'Who buys county records',
          state: 'ACTIVE',
          packets: { used: 1, reserved: 0, ceiling: 3 },
          fragments: { committed: 4, ceiling: 10 },
          deadline: '2026-12-01T00:00:00.000Z',
          authorizedBy: 'usr_1',
          createdAt: '2026-10-01T00:00:00.000Z',
          authorizedByName: 'Ada',
          stoppedBy: null,
          stoppingSentence: 'Nothing stops it: every ceiling still has headroom and the deadline has not passed.',
        },
        packets: [
          {
            id: 'orc_secret_id',
            title: 'Which counties sell their rolls',
            goalId: 'rgl_1',
            status: 'SYNTHESIZING',
            kind: 'RUNNING',
            phase: 'Writing up what the evidence established.',
            reason: null,
            questions: { total: 4, answered: 3, open: 1, refused: 0 },
            acceptedClaims: 9,
            filed: false,
            documentId: null,
            verdict: null,
            attempt: 1,
            updatedAt: '2026-10-06T10:00:00.000Z',
          },
        ],
        counts: {},
      },
    ],
    other: [
      {
        id: 'orc_two',
        title: 'A question from a conversation',
        goalId: null,
        status: 'INTERRUPTED',
        kind: 'RETRYING',
        phase: 'Interrupted; Brain is resuming it from where it stopped.',
        reason: null,
        questions: { total: 0, answered: 0, open: 0, refused: 0 },
        acceptedClaims: 0,
        filed: false,
        documentId: null,
        verdict: null,
        attempt: 2,
        updatedAt: '2026-10-06T10:00:00.000Z',
      },
    ],
    counts: { RUNNING: 1, WAITING: 0, RETRYING: 1, NEEDS_YOU: 0, STOPPED: 0, DONE: 0 },
    technicalHidden: 2,
    headline: '1 being researched now, 1 continuing by itself.',
  };

  it('shows goal → budget → packets → evidence, with ids only behind Details', async () => {
    baseRoutes({ 'GET /api/projects/prj_1/research/overview': { body: { overview } } });
    window.history.pushState({}, '', '/research');
    await mount();
    expect(await screen.findByRole('heading', { name: 'Who buys county records' })).toBeTruthy();
    expect(screen.getByText(/1 of 3 research runs, 4 of 10 questions/)).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Retrying automatically')).toBeTruthy();
    expect(screen.getByText(/3 of 4 questions answered, 1 still open · 9 facts established from sources/)).toBeTruthy();
    expect(screen.getByText(/2 technical runs are not shown/)).toBeTruthy();
    // The id is in the document, but only inside a closed disclosure.
    const id = screen.getByText('orc_secret_id');
    expect(id.closest('details')).toBeTruthy();
    expect(screen.queryByText('SYNTHESIZING', { exact: true })?.closest('details')).toBeTruthy();
  });

  it('says a database that did not answer is temporary, in words, and never an authorization problem', async () => {
    baseRoutes({
      'GET /api/projects/prj_1/research/overview': {
        status: 503,
        body: { error: 'temporarily_unavailable', message: 'Brain is temporarily unable to check credentials.', retryable: true },
      },
    });
    window.history.pushState({}, '', '/research');
    await mount();
    const note = await screen.findByText(/trying again by itself/);
    expect(note.className).toMatch(/rs-state-retrying/);
    expect(document.body.textContent).not.toMatch(/temporarily_unavailable/);
    expect(note.textContent).not.toMatch(/authori|reconnect|sign in/i);
  });
});

describe('Needs you holds what genuinely needs a person, grouped by kind', () => {
  it('groups by kind, says why, what happens if ignored and what to do, and its action is real', async () => {
    baseRoutes({
      [INBOX]: {
        body: {
          items: [
            item({ id: 'cash', category: 'INVOICE', title: 'Request the invoice for USD 500.00 agreed', affects: 'Gutter cleaning' }),
            item({
              id: 'release',
              category: 'RELEASE',
              title: 'Approve the release of a finished build',
              action: { type: 'OPEN', destination: 'BUILD', label: 'Open Build' },
            }),
          ],
          categories: CATEGORIES,
          unreadable: [{ source: 'cash', temporary: true }],
        },
      },
      'GET /api/russell/projects/prj_1/needs-you': { body: { requests: [], software: [], repositories: [] } },
      'GET /api/russell/projects/prj_1/authority': { status: 404, body: { error: 'x' } },
    });
    window.history.pushState({}, '', '/needs-you');
    await mount();
    const invoice = await screen.findByRole('region', { name: 'Invoice details' });
    expect(within(invoice).getByText('Request the invoice for USD 500.00 agreed')).toBeTruthy();
    expect(within(invoice).getByText('It waits.')).toBeTruthy();
    expect(within(invoice).getByText('Gutter cleaning')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Approve, merge or release a build' })).toBeTruthy();
    // A source that could not be read is temporary, and asks nobody to reconnect.
    const note = screen.getByText(/could not check cash just now/);
    expect(note.textContent).toMatch(/temporary/);
    expect(document.body.textContent).not.toMatch(/reconnect/i);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Build' }));
    });
    expect(window.location.pathname).toBe('/build');
  });

  it('reads as settled when nothing needs a person', async () => {
    baseRoutes({
      'GET /api/russell/projects/prj_1/needs-you': { body: { requests: [], software: [], repositories: [] } },
      'GET /api/russell/projects/prj_1/authority': { status: 404, body: { error: 'x' } },
    });
    window.history.pushState({}, '', '/needs-you');
    await mount();
    expect(await screen.findByRole('heading', { name: 'Nothing needs your decision' })).toBeTruthy();
  });
});

describe('Who keeps reconnect for authorization that is genuinely gone', () => {
  function surface(name: string, connection: string, because?: string) {
    return { routineId: name, name, accountId: 'acc', accountName: 'Caleb’s Claude', health: 'HEALTHY', connection, proven: true, ...(because ? { because } : {}) };
  }

  it('labels the six states apart, and only one of them asks for a reconnect', async () => {
    baseRoutes({
      'GET /api/people': {
        body: {
          you: { userId: 'usr_1', isBrainAdmin: false },
          people: { rows: [], joined: 0, invited: 0 },
          capacity: {
            eligibleNow: 1,
            proven: 1,
            waiting: 0,
            unavailable: 0,
            target: null,
            surfaces: [
              surface('Research A', 'HEALTHY'),
              surface('Research B', 'RETRYING'),
              surface('Research C', 'REAUTH_REQUIRED', 'its Claude connector’s authorization is gone.'),
              surface('Research D', 'QUARANTINED'),
              surface('Research E', 'DISABLED'),
              surface('Research F', 'SETTING_UP'),
            ],
            historical: [],
          },
          contributed: { surfaces: [], usable: 0, total: 0 },
          me: { state: 'HEALTHY' },
          contract: { mcpUrl: '', bootstrapRepository: '' },
        },
      },
      'GET /api/people/me/claude': { status: 503, body: { error: 'temporarily_unavailable' } },
      'GET /api/russell/projects/prj_1/who': { status: 404, body: { error: 'x' } },
      'GET /api/projects/prj_1/fleet': { status: 404, body: { error: 'x' } },
    });
    window.history.pushState({}, '', '/fleet');
    await mount();
    const panel = await screen.findByRole('region', { name: 'Claude account Caleb’s Claude' });
    for (const label of ['Healthy', 'Retrying', 'Reconnect required', 'Quarantined', 'Disabled', 'Setting up']) {
      expect(within(panel).getByText(label), label).toBeTruthy();
    }
    const rows = within(panel).getAllByRole('listitem');
    const retrying = rows.find((row) => row.textContent?.includes('Research B'))!;
    expect(retrying.textContent).not.toMatch(/reconnect/i);
    expect(screen.getByText(/1 needs reconnecting/)).toBeTruthy();
  });
});

describe('the shared error path', () => {
  it('shows the server’s sentence rather than a code, and marks it retryable', async () => {
    routes = {
      'GET /x': { status: 503, body: { error: 'temporarily_unavailable', message: 'Try again shortly.', retryable: true } },
      'GET /y': { status: 503, body: { error: 'temporarily_unavailable' } },
      'GET /z': { status: 404, body: { error: 'No project with that id.' } },
    };
    const caught = async (path: string) => {
      try {
        await api(path);
      } catch (error) {
        return error as ApiError;
      }
      throw new Error('expected a failure');
    };
    const x = await caught('/x');
    expect(x.message).toBe('Try again shortly.');
    expect(x.retryable).toBe(true);
    const y = await caught('/y');
    expect(y.message).not.toMatch(/temporarily_unavailable/);
    expect(y.retryable).toBe(true);
    const z = await caught('/z');
    expect(z.retryable).toBe(false);
    expect(listState({ loading: false, error: { status: 503, message: x.message, retryable: true }, items: null, noun: 'work' }).phase).toBe('RETRYING');
    expect(listState({ loading: false, error: { status: 404, message: z.message, retryable: false }, items: null, noun: 'work' }).phase).toBe('FORBIDDEN');
  });
});

describe('Cash says why a piece is stuck, not only where', () => {
  it('names the first blocker, what answers it and whose it is', () => {
    render(
      <FirstBlocker
        tier={{
          tier: 'SIGNAL',
          toAdvance: [{ key: 'payer', label: 'Payer', task: 'Find who pays for this work.', owner: 'BRAIN_RESEARCH' }],
        }}
      />,
    );
    expect(screen.getByText(/Still evidence because payer is not established yet\./)).toBeTruthy();
    expect(screen.getByText(/Find who pays for this work\. Brain is researching it\./)).toBeTruthy();
  });

  it('says nothing when nothing blocks the next tier', () => {
    const { container } = render(<FirstBlocker tier={{ tier: 'READY_TO_TEST', toAdvance: [] }} />);
    expect(container.textContent).toBe('');
  });
});
