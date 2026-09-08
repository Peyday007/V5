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
let postedBodies: unknown[] = [];

function reply(route: string): Reply {
  const found = routes[route];
  if (!found) return { status: 404, body: { error: 'No such route.' } };
  return typeof found === 'function' ? found() : found;
}

beforeEach(() => {
  calls = [];
  postedBodies = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    if (init?.method === 'POST' && init.body) postedBodies.push(JSON.parse(String(init.body)));
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start a new one' })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a new one' }));
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
    const picker = await waitFor(() => screen.getByLabelText('Open'));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'rcv_9' } });
    });
    expect(window.location.pathname).toBe('/conversation/rcv_9');
  });

  it('shows no picker when there is only one thread to pick', async () => {
    baseRoutes();
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start a new one' })).toBeTruthy());
    expect(screen.queryByLabelText('Open')).toBeNull();
  });

  it('does not label the picker and the button with the same words', async () => {
    /*
     * The defect that sent one acceptance message into two threads. Every
     * thread this shell creates was titled "New conversation", so the picker's
     * selected option read "New conversation" beside a button reading "New
     * conversation" — one navigates, one creates, and nothing on screen said
     * which. Two clicks in twenty seconds, two threads.
     */
    baseRoutes({
      'GET /api/russell/conversations': {
        body: {
          conversations: [
            { id: 'rcv_1', title: 'A thread' },
            { id: 'rcv_9', title: 'An older thread' },
          ],
        },
      },
    });
    await mount();
    const picker = await waitFor(() => screen.getByLabelText('Open'));
    const button = screen.getByRole('button', { name: 'Start a new one' });
    const optionNames = Array.from(picker.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionNames).not.toContain(button.textContent);
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

  it('offers a way back from a failed turn instead of telling a person to retype it', async () => {
    let turns: unknown[] = [
      { id: 'm1', role: 'USER', content: 'anything', status: 'COMPLETE', pendingReason: null },
      {
        id: 'm2',
        role: 'RUSSELL',
        content: 'I could not answer that one.',
        status: 'FAILED',
        pendingReason: null,
      },
    ];
    baseRoutes({
      'GET /api/russell/conversations/rcv_1': () => ({
        body: { conversation: { id: 'rcv_1', title: 'A thread' }, turns },
      }),
      'POST /api/russell/conversations/rcv_1/turns/m2/retry': () => {
        // The server is the thing that creates the new attempt; the view only
        // re-reads. Nothing here is patched into place optimistically.
        turns = [
          ...turns,
          { id: 'm3', role: 'RUSSELL', content: '', status: 'PENDING', pendingReason: null,
            pendingDetail: 'This is waiting to be handed to a worker.' },
        ];
        return { status: 202, body: { pending: null, attempt: 2, dispatched: true } };
      },
    });
    await mount();

    const button = await waitFor(() => screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      fireEvent.click(button);
    });

    // It went to the retry route, and the thread was re-read rather than edited.
    expect(calls).toContain('POST /api/russell/conversations/rcv_1/turns/m2/retry');
    await waitFor(() =>
      expect(document.querySelector('.rs-turn-status.rs-turn-pending')?.textContent).toMatch(
        /waiting to be handed to a worker/i,
      ),
    );
    // The failed attempt is still on screen. A retry that hid it would hide the
    // only sign that anything went wrong.
    expect(document.querySelector('.rs-turn-status.rs-turn-failed')).toBeTruthy();
  });

  it('shows the server\'s refusal rather than hiding the button', async () => {
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
      'POST /api/russell/conversations/rcv_1/turns/m2/retry': {
        status: 400,
        body: { error: 'I have tried that one as many times as I am allowed to' },
      },
    });
    await mount();
    await act(async () => {
      fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Try again' })));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/as many times as I am allowed/i),
    );
  });

  it('offers nothing to retry on a turn that succeeded or is still running', async () => {
    baseRoutes({
      'GET /api/russell/conversations/rcv_1': {
        body: {
          conversation: { id: 'rcv_1', title: 'A thread' },
          turns: [
            { id: 'm1', role: 'USER', content: 'anything', status: 'COMPLETE', pendingReason: null },
            { id: 'm2', role: 'RUSSELL', content: 'Here you go.', status: 'COMPLETE', pendingReason: null },
            { id: 'm3', role: 'USER', content: 'and this', status: 'COMPLETE', pendingReason: null },
            { id: 'm4', role: 'RUSSELL', content: '', status: 'PENDING', pendingReason: 'thinking' },
          ],
        },
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByLabelText('Say something to Russell')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
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

  /*
   * The idea controls.
   *
   * These are the surface of two routes that had no caller at all until this
   * change: a person could read Russell's ranking and do nothing about it, and
   * an automatic merge had no visible undo. What is asserted is the part a
   * person notices when it is wrong — that the control is only offered where
   * the server would accept it, and that it refuses to send an unreasoned
   * decision rather than being refused after sending one.
   */
  function ideaMap(node: Record<string, unknown>): Record<string, unknown> {
    return {
      map: {
        rootId: 'site:prj_1',
        nodes: [
          {
            id: 'site:prj_1',
            level: 'SITE',
            parentId: null,
            title: 'Deal Dispatch',
            purpose: null,
            why: null,
            state: 'ACTIVE',
            stateLabel: 'Active',
            progress: { stage: 'OPERATIONAL', headline: 'x', completed: [], missing: [], ratio: null, blockedBy: [] },
            priority: null,
            priorityLabel: null,
            counts: { knowledge: 0, unknowns: 0, work: 0, conversations: 0, children: 1 },
            links: { projectId: 'prj_1', layerId: null, candidateId: null, conversationId: null },
            decision: { canOverride: false, canSplit: false, overriddenReason: null, mergedIn: 0 },
          },
          node,
        ],
        edges: [],
      },
      state: { items: [], emptyReason: null, explanation: null },
    };
  }

  const ORDINARY = {
    id: 'idea:rcn_1',
    level: 'REGULAR',
    parentId: 'site:prj_1',
    title: 'Assessment roll availability',
    purpose: 'establish whether counties publish assessment rolls',
    why: 'useful strengthening work with nothing blocking it',
    state: 'QUEUED',
    stateLabel: 'Queued',
    progress: { stage: 'FORMING', headline: 'x', completed: [], missing: [], ratio: null, blockedBy: [] },
    priority: 'WORTH_DOING',
    priorityLabel: 'Worth doing',
    counts: { knowledge: 0, unknowns: 0, work: 0, conversations: 0, children: 0 },
    links: { projectId: 'prj_1', layerId: null, candidateId: 'rcn_1', conversationId: null },
    decision: { canOverride: true, canSplit: false, overriddenReason: null, mergedIn: 0 },
  };

  /**
   * Open Ideas, then walk into the one node under the site.
   *
   * The walk matters: the constellation *selects* on a click and *focuses* on
   * the list button beneath it, and the decision panel follows focus rather
   * than selection — a person acts on the idea they have opened, not on one
   * they have glanced at. The list is rendered after the map, so the last
   * matching button is the one that focuses.
   */
  async function openIdeas(node: Record<string, unknown>): Promise<void> {
    baseRoutes({ 'GET /api/russell/projects/prj_1/ideas': { body: ideaMap(node) } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Ideas/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Ideas/ }));
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Deal Dispatch' })).toBeTruthy());
  }

  async function walkInto(title: RegExp): Promise<void> {
    await waitFor(() => expect(screen.getAllByRole('button', { name: title }).length).toBeGreaterThan(0));
    const buttons = screen.getAllByRole('button', { name: title });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]!);
    });
  }

  it('offers nothing to overrule on a site, which is not a judgment', async () => {
    await openIdeas(ORDINARY);
    // The site is in focus and is not something a person overrules, so the
    // panel is absent entirely rather than present and inert.
    expect(screen.queryByText(/A reason is needed/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Set this priority/i })).toBeNull();
  });

  it('offers the priority control on an ordinary idea, and refuses an empty reason', async () => {
    await openIdeas(ORDINARY);
    await walkInto(/Assessment roll availability/);

    await waitFor(() => expect(screen.getByText(/Why do you disagree with Russell/i)).toBeTruthy());
    const submit = screen.getByRole('button', { name: /Set this priority/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/A reason is needed/i)).toBeTruthy();

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Why do you disagree/i), {
        target: { value: 'valuation is blocked on this' },
      });
    });
    expect((screen.getByRole('button', { name: /Set this priority/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers the undo on a folded idea, and never the priority control', async () => {
    const folded = {
      ...ORDINARY,
      id: 'idea:rcn_2',
      title: 'Assessment rolls in bulk',
      state: 'MERGED',
      stateLabel: 'Folded into another idea',
      links: { ...ORDINARY.links, candidateId: 'rcn_2' },
      decision: { canOverride: false, canSplit: true, overriddenReason: null, mergedIn: 0 },
    };
    await openIdeas(folded);
    await walkInto(/Assessment rolls in bulk/);

    await waitFor(() => expect(screen.getByText(/Why are these different questions/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /These are different questions/i })).toBeTruthy();
    // A merged idea has no judgment to supersede, and the server refuses one.
    // Offering the control anyway would be a button that fails.
    expect(screen.queryByRole('button', { name: /Set this priority/i })).toBeNull();
  });

  /*
   * The authority decision, where a person actually goes for decisions.
   *
   * It was on the operator console until now, which put the project owner's own
   * choice behind an administration surface 12A had already taken off the
   * normal route. What is asserted here is the part a person notices: that the
   * screen says plainly what Russell may not do, and that the form refuses to
   * send a grant with no stated purpose rather than being refused after
   * sending one.
   */
  const NO_GRANT = {
    grant: null,
    suggestedApproval: { name: 'Deal Dispatch discovery research', expiresAt: '2026-10-06T00:00:00.000Z' },
    limits: [
      { key: 'maxMissions', label: 'Pieces of research, in total', meaning: 'How many separate investigations Russell may start before asking again.', max: 50, suggested: 2 },
      { key: 'maxConcurrent', label: 'At the same time', meaning: 'How many may be running at once. One means Russell finishes before it starts the next.', max: 20, suggested: 1 },
      { key: 'maxFragments', label: 'Questions inside them', meaning: 'The bounded sub-questions those investigations may break down into.', max: 200, suggested: 12 },
      { key: 'maxProbes', label: 'Cheap looks', meaning: 'Quick checks Russell may take before committing to a full investigation.', max: 50, suggested: 3 },
    ],
    history: [],
    headline:
      'Russell may not start research on this project. It will still read what you say, ' +
      'capture ideas and rank them — and it will park every one of them rather than spend ' +
      'anything you have not agreed to.',
    suggested: { maxMissions: 2, maxConcurrent: 1, maxFragments: 12, maxProbes: 3 },
  };

  const GRANTED = {
    grant: {
      id: 'rgl_1',
      name: 'Deal Dispatch discovery research',
      grantedBy: 'The owner',
      grantedAt: '2026-09-07T00:00:00.000Z',
      expiresAt: null,
      expired: false,
      permits: [
        'Start at most 2 pieces of research on this project',
        'Run at most 1 at a time',
        'Break them into at most 12 bounded questions',
        'Take at most 3 cheap looks before committing to one',
        'Do all of that until you withdraw this',
      ],
      neverPermits: ['Spend money, or turn on paid usage'],
      spend: {
        maxMissions: { used: 1, active: 1, limit: 2 },
        maxConcurrent: { used: 1, active: 1, limit: 1 },
        maxFragments: { used: 4, active: 0, limit: 12 },
        maxProbes: { used: 1, active: 0, limit: 3 },
      },
    },
    limits: [
      { key: 'maxMissions', label: 'Pieces of research, in total', meaning: 'How many separate investigations Russell may start before asking again.', max: 50, suggested: 2 },
      { key: 'maxConcurrent', label: 'At the same time', meaning: 'How many may be running at once. One means Russell finishes before it starts the next.', max: 20, suggested: 1 },
      { key: 'maxFragments', label: 'Questions inside them', meaning: 'The bounded sub-questions those investigations may break down into.', max: 200, suggested: 12 },
      { key: 'maxProbes', label: 'Cheap looks', meaning: 'Quick checks Russell may take before committing to a full investigation.', max: 50, suggested: 3 },
    ],
    history: [],
    headline: 'Russell may research on this project, within the limits you set on 2026-09-07.',
    suggested: { maxMissions: 2, maxConcurrent: 1, maxFragments: 12, maxProbes: 3 },
  };

  async function openNeedsYou(authority: unknown): Promise<void> {
    baseRoutes({ 'GET /api/russell/projects/prj_1/authority': { body: authority } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Needs you/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    });
  }

  it('says what Russell may not do, rather than showing an empty screen', async () => {
    await openNeedsYou(NO_GRANT);
    await waitFor(() => expect(screen.getByText(/may not start research/i)).toBeTruthy());
    // The reassuring half matters too: a person deciding this needs to know
    // what carries on without it.
    expect(screen.getByText(/capture ideas and rank them/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /What Russell may do on its own/i })).toBeTruthy();
  });

  it('offers one approval without asking the owner to configure the machinery', async () => {
    await openNeedsYou(NO_GRANT);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Approve$/ })).toBeTruthy());
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryByLabelText(/What are you allowing/i)).toBeNull();
    expect(screen.getByText(/2026-10-06 00:00:00 UTC/)).toBeTruthy();
    expect(screen.getByText(/No paid API spending/)).toBeTruthy();
    expect(calls.filter((call) => call.includes('POST') && call.includes('/authority'))).toHaveLength(0);

    routes['POST /api/russell/projects/prj_1/authority'] = () => {
      routes['GET /api/russell/projects/prj_1/authority'] = { body: GRANTED };
      return { body: GRANTED };
    };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Approve$/ })); });
    expect(postedBodies).toEqual([{
      name: 'Deal Dispatch discovery research', maxMissions: 2, maxConcurrent: 1,
      maxFragments: 12, maxProbes: 3, expiresAt: '2026-10-06T00:00:00.000Z',
    }]);
    await waitFor(() => expect(screen.getByRole('button', { name: /Withdraw this/ })).toBeTruthy());
  });

  it('lets the owner raise a limit before it becomes a wall', async () => {
    /*
     * The raise used to appear only once `used >= limit`, which reads as tidy
     * and costs the person a second visit: they cannot raise a ceiling they can
     * see coming, so it interrupts them mid-journey instead.
     *
     * What stays tied to actually being spent is the emphasis and the briefing
     * sentence — a limit that is blocking nothing is not a decision waiting.
     */
    await openNeedsYou(GRANTED);
    await waitFor(() => expect(screen.getByRole('button', { name: /Withdraw this/ })).toBeTruthy());

    // Reachable while there is still room, which is the whole point.
    const raise = screen.getAllByRole('button', { name: /^Raise$|^Raise this limit$/ })[0]!;
    fireEvent.click(raise);

    const to = screen.getByLabelText(/Raise .* to/i) as HTMLInputElement;
    // Prefilled one above where it is, so the ordinary answer is one click.
    expect(Number(to.value)).toBe(GRANTED.grant.spend.maxMissions.limit + 1);

    fireEvent.change(screen.getByLabelText(/^Why\?$/i), {
      target: { value: 'the follow-on needs one the original did not allow for' },
    });

    routes['POST /api/russell/projects/prj_1/authority/rgl_1/raise'] = { body: GRANTED };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Raise it to 3/ }));
    });

    // The exact body, asserted from the request rather than the screen.
    expect(postedBodies).toEqual([{
      ceiling: 'maxMissions',
      to: 3,
      reason: 'the follow-on needs one the original did not allow for',
    }]);
    expect(calls).toContain('POST /api/russell/projects/prj_1/authority/rgl_1/raise');
  });

  it('keeps editing optional and reflects changed limits in the permission being approved', async () => {
    await openNeedsYou(NO_GRANT);
    await waitFor(() => expect(screen.getByRole('button', { name: /Change limits/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Change limits/ }));
    expect((screen.getByLabelText(/Pieces of research, in total/i) as HTMLInputElement).value).toBe('2');
    fireEvent.change(screen.getByLabelText(/Pieces of research, in total/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/Permission ends/i), { target: { value: '2026-10-05T12:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Hide limits/ }));
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.getByText(/up to 1 investigations/)).toBeTruthy();
    expect(screen.getByText(/2026-10-05 12:30:00 UTC/)).toBeTruthy();
    routes['POST /api/russell/projects/prj_1/authority'] = { status: 403, body: { error: 'Permission refused' } };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Approve$/ })); });
    expect(postedBodies).toEqual([expect.objectContaining({ maxMissions: 1, expiresAt: '2026-10-05T12:30:00.000Z' })]);
    expect(screen.queryByRole('button', { name: /Withdraw this/ })).toBeNull();
    expect(screen.getByText(/Permission refused/)).toBeTruthy();
  });

  it('requires a purpose and expiry if the owner clears the proposed settings', async () => {
    await openNeedsYou(NO_GRANT);
    await waitFor(() => expect(screen.getByRole('button', { name: /Change limits/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Change limits/ }));
    fireEvent.change(screen.getByLabelText(/What are you allowing/i), { target: { value: '' } });
    expect((screen.getByRole('button', { name: /^Approve$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/What are you allowing/i), { target: { value: 'Research' } });
    fireEvent.change(screen.getByLabelText(/Permission ends/i), { target: { value: '' } });
    expect((screen.getByRole('button', { name: /^Approve$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an existing grant in the server’s words, and what it has spent', async () => {
    await openNeedsYou(GRANTED);
    await waitFor(() => expect(screen.getByText(/Start at most 2 pieces of research/i)).toBeTruthy());
    expect(screen.getByText(/Spend money, or turn on paid usage/i)).toBeTruthy();
    expect(screen.getByText(/Pieces of research, in total: 1 of 2/i)).toBeTruthy();
    // No form to make a second one while one is live.
    expect(screen.queryByRole('button', { name: /^Approve$/ })).toBeNull();
  });

  it('asks why before it withdraws one', async () => {
    await openNeedsYou(GRANTED);
    await waitFor(() => expect(screen.getByRole('button', { name: /Withdraw this/i })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Withdraw this/i }));
    });
    await waitFor(() => expect(screen.getByLabelText(/Why are you withdrawing/i)).toBeTruthy());
    expect((screen.getByRole('button', { name: /Withdraw it/i }) as HTMLButtonElement).disabled).toBe(true);
    // And it says what withdrawing does and does not touch.
    expect(screen.getByText(/already accepted stays/i)).toBeTruthy();
  });

  it('says the reading failed rather than showing no grant', async () => {
    baseRoutes({
      'GET /api/russell/projects/prj_1/authority': { status: 500, body: { error: 'nope' } },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Needs you/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    });
    // An unreadable authority must never render as "Russell may do nothing":
    // those are different facts and only one of them is a decision to make.
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy());
    expect(screen.queryByText(/may not start research/i)).toBeNull();
  });

  it('approves the whole proposal in one action, and sends exactly it', async () => {
    /*
     * The correction this proves. The previous version showed a blank purpose
     * and four empty number boxes: a person was configuring machinery rather
     * than answering a question. What Approve *submits* is the part a review
     * of the screen cannot see, so it is asserted from the request body.
     */
    baseRoutes({
      'GET /api/russell/projects/prj_1/authority': { body: NO_GRANT },
      'POST /api/russell/projects/prj_1/authority': { body: GRANTED },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Needs you/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Approve$/ })).toBeTruthy());

    // Nothing was created by reading the card.
    expect(calls.filter((c) => c.startsWith('POST /api/russell/projects/prj_1/authority'))).toHaveLength(0);
    // The detailed controls start hidden.
    expect(screen.queryByLabelText(/Pieces of research, in total/i)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    });

    await waitFor(() =>
      expect(calls.filter((c) => c.startsWith('POST /api/russell/projects/prj_1/authority'))).toHaveLength(1),
    );
    expect(postedBodies[postedBodies.length - 1]).toEqual({
      name: 'Deal Dispatch discovery research',
      maxMissions: 2,
      maxConcurrent: 1,
      maxFragments: 12,
      maxProbes: 3,
      // Exactly the agreed instant. Not rolled forward on a refresh, not
      // widened to unlimited, and not converted to the end of the day.
      expiresAt: '2026-10-06T00:00:00.000Z',
    });
  });

  it('states the class of work and the money, not only the numbers', async () => {
    await openNeedsYou(NO_GRANT);
    await waitFor(() => expect(screen.getByText(/Research only/i)).toBeTruthy());
    expect(screen.getByText(/No paid API spending/i)).toBeTruthy();
    // Every ceiling is a quantity *within* a class, so a card showing only the
    // numbers would be describing how much of something it never named.
    expect(screen.getByText(/up to 2 investigations/i)).toBeTruthy();
    expect(screen.getByText(/2026-10-06 00:00:00 UTC/)).toBeTruthy();
  });

  it('hides the detail until asked, and sends what the edits changed', async () => {
    baseRoutes({
      'GET /api/russell/projects/prj_1/authority': { body: NO_GRANT },
      'POST /api/russell/projects/prj_1/authority': { body: GRANTED },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Needs you/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Change limits/i })).toBeTruthy());

    const toggle = screen.getByRole('button', { name: /Change limits/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByRole('button', { name: /Hide limits/i }).getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Pieces of research, in total/i), {
        target: { value: '3' },
      });
    });
    // The summary is the same object the button submits, so an edit shows.
    expect(screen.getByText(/up to 3 investigations/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    });
    await waitFor(() => expect(postedBodies.length).toBeGreaterThan(0));
    expect((postedBodies[postedBodies.length - 1] as { maxMissions: number }).maxMissions).toBe(3);
  });

  it('shows the server’s refusal rather than appearing to have worked', async () => {
    baseRoutes({
      'GET /api/russell/projects/prj_1/authority': { body: NO_GRANT },
      'POST /api/russell/projects/prj_1/authority': {
        status: 400,
        body: { error: 'Russell cannot run more at a time than it is allowed to start in total.' },
      },
    });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Needs you/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Approve$/ })).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    });
    // The server's own words, and the card still offering the decision.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/more at a time than/i);
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeTruthy();
  });

  it('badges the outstanding approval, because it is a decision', async () => {
    // It counted only human-request rows, so the one permission that has to be
    // given before anything can run showed no badge at all.
    baseRoutes({ 'GET /api/russell/projects/prj_1/authority': { body: NO_GRANT } });
    await mount();
    await waitFor(() => expect(screen.getByLabelText('1 waiting')).toBeTruthy());
  });

  it('drops the badge once the permission exists', async () => {
    baseRoutes({ 'GET /api/russell/projects/prj_1/authority': { body: GRANTED } });
    await mount();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Needs you/ })).toBeTruthy());
    expect(screen.queryByLabelText(/waiting/)).toBeNull();
  });

  it('says there is nothing at an address it does not know', async () => {
    baseRoutes();
    window.history.pushState({}, '', '/somewhere-else');
    await mount();
    await waitFor(() => expect(screen.getByText(/nothing at that address/i)).toBeTruthy());
  });
});
