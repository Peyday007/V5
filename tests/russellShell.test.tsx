// @vitest-environment jsdom
/**
 * The shell, tested for behaviour rather than markup.
 *
 * What is asserted here is the set of things a person notices when they are
 * wrong, and which no server test can catch:
 *
 *   - the default address is Russell, not the old console;
 *   - a pending turn shows the server's own reason and does not pretend to be
 *     an answer, and a failed one says so instead of spinning forever;
 *   - nothing is optimistic — a message appears because the server stored it;
 *   - loading, empty and forbidden are three different screens;
 *   - a stale reading is labelled with its age rather than shown as current;
 *   - the navigation is a rail on a desktop and a bar on a phone;
 *   - the old console is reachable, one click away, behind a secondary menu.
 *
 * `fetch` is replaced with a scripted one rather than mocked per-module, so the
 * components go through the same `api()` they use in production — including its
 * error handling, which is where the forbidden case is actually decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import {
  emptyMessage,
  listState,
  freshnessLabel,
  navigationMode,
  turnLabel,
} from '../client/src/russell/present.ts';
import { parseRoute, pathFor } from '../client/src/lib/router.ts';

// React 18 wants to be told this is an act-capable environment; without it
// every update logs a warning that hides real ones.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* --------------------------------------------------------------------------
 * The decisions, without a browser
 * ------------------------------------------------------------------------ */

describe('a view state is decided in one place', () => {
  it('never confuses loading with empty', () => {
    const loading = listState({ loading: true, error: null, items: null, noun: 'work' });
    const empty = listState({ loading: false, error: null, items: [], noun: 'work' });
    expect(loading.phase).toBe('LOADING');
    expect(empty.phase).toBe('EMPTY');
    expect(loading.message).not.toBe(empty.message);
  });

  it('never confuses forbidden with empty, and does not claim the work is absent', () => {
    const forbidden = listState({
      loading: false,
      error: { status: 404, message: 'No project with that id.' },
      items: null,
      noun: 'work',
    });
    expect(forbidden.phase).toBe('FORBIDDEN');
    // The server deliberately cannot say whether it is absent or forbidden, so
    // the interface must not invent an answer either.
    expect(forbidden.message).not.toMatch(/no work|none|does not exist/i);
    expect(forbidden.message).toMatch(/access/i);
  });

  it('distinguishes the six kinds of empty rather than collapsing them', () => {
    /*
     * The addendum's requirement, and the reason it is a requirement: the
     * remedies are completely different. Wait; look somewhere else; connect
     * something; refresh; report an outage; ask for access. "Nothing yet"
     * points at none of them, and a person who reads it over real data
     * concludes the Brain is broken or empty when it is neither.
     */
    const reasons = [
      'EMPTY',
      'NOTHING_ACTIVE',
      'NOT_CONNECTED',
      'STALE',
      'UNAVAILABLE',
      'FORBIDDEN',
    ] as const;
    const sentences = reasons.map((reason) => emptyMessage(reason, 'work'));
    // Five distinct sentences from six reasons: exactly one pair coincides, and
    // which pair is the point of the next test.
    expect(new Set(sentences).size).toBe(5);
    expect(emptyMessage('NOTHING_ACTIVE', 'work')).toMatch(/none of it is active/);
    expect(emptyMessage('NOT_CONNECTED', 'work')).toMatch(/records exist/);
  });

  it('gives forbidden and unavailable word-for-word the same sentence', () => {
    // §23 at the last hop. The server cannot distinguish "you may not" from
    // "it is not there", and two different sentences here would rebuild the
    // oracle the server refused to be.
    expect(emptyMessage('FORBIDDEN', 'work')).toBe(emptyMessage('UNAVAILABLE', 'work'));
  });

  it('uses the server’s own empty reason when it gave one', () => {
    const nothingActive = listState({
      loading: false,
      error: null,
      items: [],
      noun: 'work',
      emptyReason: 'NOTHING_ACTIVE' as const,
    });
    const genuinelyEmpty = listState({ loading: false, error: null, items: [], noun: 'work' });
    expect(nothingActive.message).not.toBe(genuinelyEmpty.message);
  });

  it('offers a retry only where retrying could help', () => {
    const broken = listState({
      loading: false,
      error: { status: 500, message: 'boom' },
      items: null,
      noun: 'work',
    });
    const forbidden = listState({
      loading: false,
      error: { status: 404, message: 'nope' },
      items: null,
      noun: 'work',
    });
    expect(broken.retryable).toBe(true);
    expect(forbidden.retryable).toBe(false);
  });
});

describe('a reading says how old it is', () => {
  it('labels a stale reading with its age rather than showing it as current', () => {
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    const label = freshnessLabel({
      freshness: 'STALE',
      asOf: '2026-09-04T11:47:00.000Z',
      now,
    });
    expect(label).toMatch(/13 minutes ago/);
    expect(label).toMatch(/could not refresh/);
  });

  it('says plainly when it cannot read at all', () => {
    expect(freshnessLabel({ freshness: 'UNAVAILABLE', asOf: null })).toMatch(/cannot read/i);
  });

  it('says a current reading is current, rather than saying nothing', () => {
    expect(freshnessLabel({ freshness: 'CURRENT', asOf: null })).toBe('Up to date.');
  });
});

describe('a pending turn', () => {
  it('carries the server’s reason and never invents one', () => {
    expect(turnLabel('PENDING', 'Russell is thinking — a worker is picking this up.')).toBe(
      'Russell is thinking — a worker is picking this up.',
    );
  });

  it('ends, one way or the other', () => {
    expect(turnLabel('FAILED', null)).toMatch(/could not answer/i);
    expect(turnLabel('COMPLETE', null)).toBeNull();
  });

  it('prefers the live condition over the sentence stored when it began', () => {
    /*
     * The order is the fix. `pendingReason` is written before anything has
     * happened and never changes, so it stays reassuring while a turn is
     * stranded; `pendingDetail` is derived on the read path from the bin and
     * its dispatch. Falling back the other way round would show the reassuring
     * one by default, which is the defect rather than the repair.
     */
    expect(
      turnLabel(
        'PENDING',
        'Russell is thinking — a worker is picking this up.',
        'Russell could not reach a worker for this one after several attempts.',
      ),
    ).toMatch(/could not reach a worker/);
  });

  it('falls back to the stored reason when the server sent no live detail', () => {
    expect(turnLabel('PENDING', 'Russell is thinking.', null)).toBe('Russell is thinking.');
    expect(turnLabel('PENDING', null, null)).toBe('Russell is thinking.');
  });
});

describe('addresses are real links', () => {
  it('round-trips every section', () => {
    for (const path of ['/', '/work', '/projects', '/knowledge', '/fleet', '/needs-you', '/legacy']) {
      expect(pathFor(parseRoute(path))).toBe(path);
    }
    expect(pathFor(parseRoute('/conversation/rcv_1'))).toBe('/conversation/rcv_1');
  });

  it('does not quietly turn an unknown address into the home page', () => {
    // A stale bookmark that showed something else is how a person ends up sure
    // they are looking at the thing they asked for.
    expect(parseRoute('/nope').name).toBe('NOT_FOUND');
  });
});

describe('the layout follows the viewport', () => {
  it('is a rail on a desktop and a bar on a phone', () => {
    expect(navigationMode(1280)).toBe('RAIL');
    expect(navigationMode(390)).toBe('BAR');
    // The breakpoint itself is a phone.
    expect(navigationMode(720)).toBe('BAR');
    expect(navigationMode(721)).toBe('RAIL');
  });
});

/* --------------------------------------------------------------------------
 * The shell, in a browser
 * ------------------------------------------------------------------------ */

interface Reply {
  status?: number;
  body: unknown;
}

let routes: Record<string, Reply | (() => Reply)> = {};
let calls: string[] = [];

function reply(route: string): Reply {
  const found = routes[route];
  if (!found) return { status: 404, body: { error: 'No such route.' } };
  return typeof found === 'function' ? found() : found;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    const answer = reply(key);
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
});

const USER = { id: 'usr_1', email: 'a@b.test', displayName: 'Ada', isBrainAdmin: false, mustChangePassword: false };
const PROJECT = { id: 'prj_1', name: 'Deal Dispatch', slug: 'deal-dispatch' };

function baseRoutes(overrides: Record<string, Reply | (() => Reply)> = {}): void {
  routes = {
    'GET /api/auth/session': { body: { authenticated: true, user: USER } },
    'GET /api/projects': { body: { projects: [PROJECT] } },
    'GET /api/russell/conversations': { body: { conversations: [{ id: 'rcv_1', title: 'A thread' }] } },
    'GET /api/russell/conversations/rcv_1': {
      body: { conversation: { id: 'rcv_1', title: 'A thread' }, turns: [] },
    },
    'GET /api/russell/projects/prj_1/briefing': {
      body: {
        briefing: {
          focus: 'Russell is watching Deal Dispatch.',
          progress: {
            stage: 'OPERATIONAL',
            headline: 'Operational — 3 of 8 settled.',
            completed: [],
            missing: [],
            ratio: { done: 3, total: 8 },
            blockedBy: [],
          },
          latest: null,
          next: 'Russell has nothing queued.',
          needsYou: 'You are not needed.',
          openRequests: 0,
        },
        focusLayer: null,
        cycle: { state: 'RUNNING', pausedReason: null },
      },
    },
    'GET /api/russell/projects/prj_1/needs-you': { body: { requests: [] } },
    ...overrides,
  };
}

async function mount(): Promise<void> {
  const { default: Root } = await import('../client/src/Root.tsx');
  await act(async () => {
    render(<Root />);
  });
}

describe('opening Brain', () => {
  it('lands on Russell, not on the old console', async () => {
    baseRoutes();
    await mount();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Russell' })).toBeTruthy());
    // The three-pane console's own chrome is not on screen.
    expect(screen.queryByText(/Master Planner/i)).toBeNull();
  });

  it('shows the briefing in its fixed order, with no percentage', async () => {
    baseRoutes();
    await mount();
    await waitFor(() => expect(screen.getByText(/Russell is watching Deal Dispatch/)).toBeTruthy());
    expect(screen.getByText('Operational — 3 of 8 settled.')).toBeTruthy();
    expect(screen.getByText('You are not needed.')).toBeTruthy();
    // A counted fraction is fine; a percentage is not, because nothing behind
    // it has that resolution.
    expect(document.body.textContent ?? '').not.toMatch(/\d+\s?%/);
  });

  it('still renders a briefing from an older server rather than blanking', async () => {
    /*
     * A cached bundle against a restarted Brain. The field used to be one
     * sentence; a component that threw on it would show a person nothing at
     * all, which is worse than showing them the older sentence.
     */
    baseRoutes({
      'GET /api/russell/projects/prj_1/briefing': {
        body: {
          briefing: {
            focus: 'Russell is watching Deal Dispatch.',
            progress: 'Some of this is settled.',
            latest: null,
            next: 'Russell has nothing queued.',
            needsYou: 'You are not needed.',
            openRequests: 0,
          },
          focusLayer: null,
          cycle: null,
        },
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByText('Some of this is settled.')).toBeTruthy());
  });

  it('keeps the old console one click away behind a secondary menu', async () => {
    baseRoutes();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'More' })).toBeTruthy());
    // Not on screen until asked for: it is available, not the default.
    expect(screen.queryByRole('menuitem', { name: 'Full console' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
    });
    expect(screen.getByRole('menuitem', { name: 'Full console' })).toBeTruthy();
  });

  it('can start a conversation, which nothing in the shell could do before', async () => {
    /*
     * The shell opens a person's *most recent* thread and creates one only when
     * they have none. With one thread in existence there was therefore no way
     * to begin a second — which made the frozen acceptance scenario's "a new
     * conversation" impossible to satisfy from the interface, and made the
     * product unusable for the ordinary act of starting a new subject.
     */
    let created = false;
    baseRoutes({
      'POST /api/russell/conversations': () => {
        created = true;
        return { body: { id: 'rcv_2', title: 'New conversation' } };
      },
      'GET /api/russell/conversations/rcv_2': {
        body: { conversation: { id: 'rcv_2', title: 'New conversation' }, turns: [] },
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    });
    await waitFor(() => expect(created).toBe(true));
    expect(window.location.pathname).toBe('/conversation/rcv_2');
  });

  it('offers a way back to a thread that is not the newest', async () => {
    // Two threads and no picker is a shell where the older one is reachable
    // only by knowing its id. One `select`; collections are Step 12B.
    baseRoutes({
      'GET /api/russell/conversations': {
        body: {
          conversations: [
            { id: 'rcv_1', title: 'A thread' },
            { id: 'rcv_9', title: 'An older thread' },
          ],
        },
      },
      'GET /api/russell/conversations/rcv_9': {
        body: { conversation: { id: 'rcv_9', title: 'An older thread' }, turns: [] },
      },
    });
    await mount();
    const picker = await waitFor(() => screen.getByLabelText('Open a conversation'));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'rcv_9' } });
    });
    expect(window.location.pathname).toBe('/conversation/rcv_9');
  });

  it('shows no picker when there is only one thread to pick', async () => {
    baseRoutes();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy());
    expect(screen.queryByLabelText('Open a conversation')).toBeNull();
  });

  it('offers the operator console only to a Brain administrator', async () => {
    baseRoutes({
      'GET /api/auth/session': { body: { authenticated: true, user: { ...USER, isBrainAdmin: false } } },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'More' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
    });
    expect(screen.queryByRole('menuitem', { name: 'Operator console' })).toBeNull();
  });
});

describe('saying something', () => {
  it('does not show the message until the server stored it', async () => {
    let stored = false;
    baseRoutes({
      'POST /api/russell/conversations/rcv_1/turns': () => {
        stored = true;
        return { status: 202, body: { userMessage: null, pending: null, attachedProjectId: null, dispatched: true } };
      },
      'GET /api/russell/conversations/rcv_1': () => ({
        body: {
          conversation: { id: 'rcv_1', title: 'A thread' },
          turns: stored
            ? [
                { id: 'm1', role: 'USER', content: 'hello there', status: 'COMPLETE', pendingReason: null },
                { id: 'm2', role: 'RUSSELL', content: '', status: 'PENDING', pendingReason: 'Russell is thinking.' },
              ]
            : [],
        },
      }),
    });
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Say something to Russell')).toBeTruthy());

    const box = screen.getByLabelText('Say something to Russell');
    await act(async () => {
      fireEvent.change(box, { target: { value: 'hello there' } });
    });
    // Typing alone puts nothing in the thread. Scoped to the thread itself,
    // because the words are of course in the box a person typed them into.
    const thread = (): HTMLElement => screen.getByRole('list', { name: 'Conversation' });
    expect(within(thread()).queryByText('hello there')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    await waitFor(() => expect(within(thread()).getByText('hello there')).toBeTruthy());
    // And Russell's side is a pending turn carrying the server's own reason,
    // not an answer the client made up.
    expect(screen.getByText('Russell is thinking.')).toBeTruthy();
  });

  it('keeps the words when sending fails, and says so', async () => {
    baseRoutes({
      'POST /api/russell/conversations/rcv_1/turns': { status: 500, body: { error: 'the server fell over' } },
    });
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Say something to Russell')).toBeTruthy());

    const box = screen.getByLabelText('Say something to Russell') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: 'do not lose this' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Nothing optimistic, and nothing lost.
    expect(box.value).toBe('do not lose this');
  });

  it('shows a failed turn as failed rather than spinning forever', async () => {
    baseRoutes({
      'GET /api/russell/conversations/rcv_1': {
        body: {
          conversation: { id: 'rcv_1', title: 'A thread' },
          turns: [
            { id: 'm1', role: 'USER', content: 'anything', status: 'COMPLETE', pendingReason: null },
            {
              id: 'm2',
              role: 'RUSSELL',
              content: 'I could not answer that one.',
              status: 'FAILED',
              pendingReason: null,
            },
          ],
        },
      },
    });
    await mount();
    // The *status* line, specifically. A failed turn has to be labelled as
    // failed, not merely happen to contain a sentence saying so.
    await waitFor(() =>
      expect(document.querySelector('.rs-turn-status.rs-turn-failed')?.textContent).toMatch(
        /could not answer/i,
      ),
    );
    expect(document.querySelector('.rs-turn-pending')).toBeNull();
  });
});

describe('the thin views', () => {
  it('says a project it cannot open is not something you can see', async () => {
    baseRoutes({
      'GET /api/russell/projects/prj_1/work': { status: 404, body: { error: 'No project with that id.' } },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Work/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Work/ }));
    });
    await waitFor(() => expect(screen.getByText(/not something you can open/i)).toBeTruthy());
    expect(screen.queryByText(/no work yet/i)).toBeNull();
  });

  it('says an empty list is empty, which is a different screen', async () => {
    baseRoutes({ 'GET /api/russell/projects/prj_1/work': { body: { missions: [] } } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Work/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Work/ }));
    });
    await waitFor(() => expect(screen.getByText(/no work yet/i)).toBeTruthy());
  });

  it('shows a badge only when a person is actually needed', async () => {
    baseRoutes({
      'GET /api/russell/projects/prj_1/needs-you': {
        body: {
          requests: [
            {
              id: 'rhr_1',
              authorityNeeded: 'Approve spending on the next packet',
              whyNotRussell: 'Russell may not authorize spending.',
              recommendation: null,
              choices: [{ key: 'yes', label: 'Go ahead' }],
              urgency: 'BLOCKING',
              state: 'OPEN',
            },
          ],
        },
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByLabelText('1 waiting')).toBeTruthy());
  });

  it('deep-links straight into a section', async () => {
    baseRoutes({ 'GET /api/russell/projects/prj_1/knowledge': { body: { knowledge: [] } } });
    window.history.pushState({}, '', '/knowledge');
    await mount();
    await waitFor(() => expect(screen.getByText(/no findings yet/i)).toBeTruthy());
  });

  it('says there is nothing at an address it does not know', async () => {
    baseRoutes();
    window.history.pushState({}, '', '/somewhere-else');
    await mount();
    await waitFor(() => expect(screen.getByText(/nothing at that address/i)).toBeTruthy());
  });
});
