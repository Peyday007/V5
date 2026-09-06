/**
 * The conversation. This is the default way into Brain.
 *
 * Three things about it are deliberate and are what the behaviour tests hold in
 * place:
 *
 *   - **Nothing is optimistic.** A person's own message appears because the
 *     server stored it and said so, and Russell's reply appears as a *pending*
 *     turn carrying the server's own reason. There is no bubble that appears
 *     first and is corrected later.
 *   - **A pending turn ends.** It resolves into an answer, or into a plainly
 *     stated failure. A spinner with no ending is not waiting, it is stuck, and
 *     the server side of this was built so that this side never has to guess.
 *   - **The thread is re-read, never patched.** After saying something the view
 *     reloads the turns from the server, so what a person sees is what is
 *     stored rather than what the client hoped would be.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RussellApi } from '../lib/russellApi.ts';
import type { RussellMessage } from '../lib/russellApi.ts';
import { turnLabel } from './present.ts';
import { useAsync } from './useAsync.ts';
import { ApiError } from '../lib/api.ts';

/** How often an unanswered turn asks the server whether it has been answered. */
const PENDING_POLL_MS = 4_000;

export function Conversation({ conversationId }: { conversationId: string }): JSX.Element {
  const thread = useAsync(() => RussellApi.thread(conversationId), [conversationId]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  const turns = thread.data?.turns ?? [];
  const waiting = turns.some((turn) => turn.status === 'PENDING');

  /*
   * Only while something is pending.
   *
   * A poll that runs all the time is a poll nobody notices is broken, and it
   * costs a request every few seconds for a screen where nothing is happening.
   * The condition is the state itself, so the polling stops the moment the
   * fleet answers.
   */
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => thread.reload(), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, thread]);

  useEffect(() => {
    // Guarded rather than called: `scrollIntoView` is not universal, and a
    // conversation that throws while trying to be polite about scrolling is
    // worse than one that does not scroll.
    const anchor = bottom.current;
    if (anchor && typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ block: 'end' });
    }
  }, [turns.length]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setProblem(null);
    try {
      await RussellApi.say(conversationId, content);
      // Cleared only after the server accepted it. Clearing first would lose a
      // person's words to a network error.
      setDraft('');
      thread.reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause.message
          : 'That did not send. Nothing was lost — try again.',
      );
    } finally {
      setSending(false);
    }
  }, [conversationId, draft, sending, thread]);

  if (thread.loading && turns.length === 0) {
    return <p className="rs-state rs-state-loading">Opening the conversation…</p>;
  }
  if (thread.error) {
    return (
      <p className="rs-state rs-state-forbidden" role="alert">
        {thread.error.status === 404
          ? 'This is not a conversation you can open.'
          : `Could not open the conversation. ${thread.error.message}`}
      </p>
    );
  }

  return (
    <div className="rs-conversation">
      <ol className="rs-turns" aria-live="polite" aria-label="Conversation">
        {turns.map((turn) => (
          <Turn
            key={turn.id}
            turn={turn}
            conversationId={conversationId}
            onRetried={() => thread.reload()}
          />
        ))}
      </ol>
      <div ref={bottom} />

      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}

      <form
        className="rs-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="rs-visually-hidden" htmlFor="rs-say">
          Say something to Russell
        </label>
        <textarea
          id="rs-say"
          value={draft}
          rows={2}
          placeholder="Say something…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift-enter is a newline. Both are ordinary
            // expectations and neither should require reaching for a mouse.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={sending || draft.trim().length === 0}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function Turn({
  turn,
  conversationId,
  onRetried,
}: {
  turn: RussellMessage;
  conversationId: string;
  onRetried: () => void;
}): JSX.Element {
  const label = turnLabel(turn.status, turn.pendingReason, turn.pendingDetail);
  const [retrying, setRetrying] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  /*
   * The button only a failed turn gets.
   *
   * Before this, the failure sentence said "ask me again" and meant it
   * literally: the person had to retype their question, because a settled turn
   * cannot be re-settled. That is the right remedy when the question was the
   * problem and the wrong one when the worker was refused over a rule it had
   * never been told — which is what actually happened, twice, on two days.
   *
   * The server decides whether the retry is allowed and refuses in a sentence,
   * so this shows the refusal rather than hiding the button. A control that
   * disappears when it would not work tells a person nothing about why.
   */
  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setRefused(null);
    try {
      await RussellApi.retry(conversationId, turn.id);
      onRetried();
    } catch (cause) {
      setRefused(
        cause instanceof ApiError
          ? cause.message
          : 'That did not go through. Nothing was lost — try again.',
      );
    } finally {
      setRetrying(false);
    }
  }, [conversationId, onRetried, retrying, turn.id]);

  return (
    <li className={`rs-turn rs-turn-${turn.role.toLowerCase()}`}>
      <span className="rs-turn-who">{turn.role === 'USER' ? 'You' : 'Russell'}</span>
      {turn.content ? <p className="rs-turn-body">{turn.content}</p> : null}
      {label ? (
        <p className={`rs-turn-status rs-turn-${turn.status.toLowerCase()}`}>{label}</p>
      ) : null}
      {turn.status === 'FAILED' && turn.role === 'RUSSELL' ? (
        <button type="button" className="rs-turn-retry" onClick={() => void retry()} disabled={retrying}>
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      ) : null}
      {refused ? (
        <p className="rs-state rs-state-error" role="alert">
          {refused}
        </p>
      ) : null}
    </li>
  );
}
