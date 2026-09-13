// @vitest-environment jsdom
/**
 * The question Brain will not guess past, rendered where the person asked.
 *
 * `softwareTarget.ts` composed the sentence and `turn.ts` carried it onto the
 * message row from the day both were written — and **nothing read it**. A person
 * whose message named two projects got an ordinary reply and no card, with no
 * way to learn that Brain had stopped on purpose or what would unstop it. That
 * is §24's recurring defect at a new surface: a state that says waiting which
 * nobody can resolve is not waiting, it is stuck.
 *
 * So this drives the real `Conversation` against a scripted server and reads the
 * screen, for the reason `softwareDecisionCard` exists: the server test can pass
 * in full while the sentence never reaches a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Conversation } from '../client/src/russell/Conversation.tsx';

const CONVERSATION = 'rcv_1';
const THREAD = `GET /api/russell/conversations/${CONVERSATION}`;

let routes: Record<string, unknown> = {};

function thread(over: Record<string, unknown> = {}): unknown {
  return {
    conversation: {
      id: CONVERSATION,
      ownerUserId: 'usr_1',
      title: 'A thread',
      visibility: 'SHARED',
      projectId: 'prj_1',
      attachmentSource: 'PERSON',
      collectionId: null,
      collectionSource: null,
      legacyConversationId: null,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    },
    turns: [],
    software: [],
    clarification: null,
    ...over,
  };
}

beforeEach(() => {
  routes = { [THREAD]: thread() };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const body = routes[key];
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the question Brain is waiting on', () => {
  it('is absent when there is nothing to ask', async () => {
    routes[THREAD] = thread({
      clarification: null,
      software: [
        {
          request: { id: 'rsw_1', title: 'Live total on checkout' },
          campaign: null,
          pullRequestUrl: null,
          line: 'Waiting for you to authorize it. Nothing has been spent.',
          awaitingPerson: true,
        },
      ],
    });
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);
    // Wait for the load to land on something, so "absent" is a reading rather
    // than a race with the fetch.
    await screen.findByText('Live total on checkout');
    expect(document.querySelector('.rs-thread-clarify')).toBeNull();
  });

  it('renders the server’s own sentence, and composes none of its own', async () => {
    const question =
      'This conversation is about Deal Dispatch, and you have named V4. Which one should the ' +
      'change be made in? I have not written anything down yet.';
    routes[THREAD] = thread({
      clarification: { kind: 'AMBIGUOUS_PROJECT', question },
    });

    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);

    const shown = await screen.findByText(question);
    expect(shown).toBeTruthy();
    /*
     * The exact string, not a paraphrase of it: the sentence names what Brain
     * refused and what would settle it, and a browser that rewrote either would
     * be describing a rule it does not enforce.
     */
    expect(shown.textContent).toBe(question);
    expect(shown.closest('.rs-thread-clarify')?.getAttribute('data-kind')).toBe(
      'AMBIGUOUS_PROJECT',
    );
  });

  it('renders the missing-referent question too', async () => {
    routes[THREAD] = thread({
      clarification: {
        kind: 'NO_REFERENT',
        question: 'I do not know what "that" is. Say what should change and I will write it down.',
      },
    });
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);
    expect(await screen.findByText(/what "that" is/)).toBeTruthy();
  });

  /**
   * A quiet sentence rather than an alert.
   *
   * `role="status"` because it is information a person may act on when they are
   * ready, and `role="alert"` would interrupt a screen reader mid-sentence for a
   * refusal that costs nothing. The loud treatment belongs to the authorization
   * card, which is the decision that actually spends something.
   */
  it('announces itself politely', async () => {
    routes[THREAD] = thread({
      clarification: { kind: 'NO_PROJECT', question: 'Which site is this about?' },
    });
    render(<Conversation conversationId={CONVERSATION} showComposer={false} />);
    const shown = await screen.findByText('Which site is this about?');
    expect(shown.getAttribute('role')).toBe('status');
  });
});
