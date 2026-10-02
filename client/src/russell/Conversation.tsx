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
import type {
  SoftwareClarification,
  SoftwareRepositoryChoice,
  SoftwareRequestView,
} from '../../../server/services/russell/software.ts';
import { turnLabel } from './present.ts';
import { useAsync } from './useAsync.ts';
import { ApiError } from '../lib/api.ts';

/** How often an unanswered turn asks the server whether it has been answered. */
const PENDING_POLL_MS = 4_000;

/** How often a thread with a change under way re-reads it. */
const BUILDING_POLL_MS = 20_000;

/**
 * What this conversation asked to have built, reported back into it — from the
 * card that authorizes it to the release that confirms it.
 *
 * The point of the whole path is that a person says what they want changed and
 * then finds out what happened *here*, rather than having to know that a
 * different page exists. So the decisions that are theirs are made here too:
 * authorizing a proposed change, and — once it is built, reviewed and opened as
 * a pull request — the release decision, with exactly what would be released
 * laid out in front of it.
 *
 * Everything shown is the server's own derivation. Nothing about a campaign or
 * a release is re-derived in the browser, because two surfaces inferring their
 * own status from the same rows is how a person reads two different answers.
 */
function SoftwareTrail({
  software,
  repositories,
  onAnswered,
}: {
  software: SoftwareRequestView[];
  repositories: SoftwareRepositoryChoice[];
  onAnswered(): void;
}): JSX.Element | null {
  if (software.length === 0) return null;
  return (
    <section className="rs-thread-software" aria-label="Changes asked for in this conversation">
      <h3>Changes you asked for here</h3>
      <ul>
        {software.map((entry) => (
          <li key={entry.request.id} className="rs-thread-software-item">
            <SoftwareEntry entry={entry} repositories={repositories} onAnswered={onAnswered} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SoftwareEntry({
  entry,
  repositories,
  onAnswered,
}: {
  entry: SoftwareRequestView;
  repositories: SoftwareRepositoryChoice[];
  onAnswered(): void;
}): JSX.Element {
  const { request, delivery } = entry;
  const [grantId, setGrantId] = useState(repositories.length === 1 ? repositories[0]?.grantId ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [reason, setReason] = useState('');
  /*
   * What success is, as a proposal the person edits and approves. The server
   * will not invent conditions and the factory will not start without them, so
   * the ones sent are exactly the ones on the screen when Authorize is pressed.
   */
  const [conditions, setConditions] = useState(() =>
    (request.acceptanceConditions ?? []).map((condition) => ({ ...condition })),
  );
  const usable = conditions.filter((c) => c.statement.trim().length >= 8 && c.verification.trim().length >= 4);
  const choice = repositories.find((candidate) => candidate.grantId === grantId) ?? null;
  const proposed = request.state === 'PROPOSED';

  async function act(run: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      onAnswered();
    } catch (cause) {
      setProblem(cause instanceof ApiError ? cause.message : 'That did not go through. Nothing changed.');
    } finally {
      setBusy(false);
    }
  }

  const release = delivery?.release as ReleaseSnapshot | null | undefined;

  return (
    <article className="rs-thread-software-entry">
      <strong>{request.title}</strong>
      <span className="rs-thread-software-line">{entry.line}</span>
      {entry.awaitingPerson ? <span className="rs-thread-software-needs">Needs you</span> : null}

      {proposed ? (
        <div className="rs-thread-software-proposal">
          <p>{request.objective}</p>
          <p className="rs-hint">Afterwards: {request.expectedOutcome}</p>
          <fieldset className="rs-thread-software-done">
            <legend>Done means — yours to change before you authorize</legend>
            {conditions.map((condition, index) => (
              <div key={index} className="rs-thread-software-condition">
                <label>
                  <span>What must be true</span>
                  <textarea
                    rows={2}
                    value={condition.statement}
                    onChange={(event) =>
                      setConditions((current) =>
                        current.map((c, i) => (i === index ? { ...c, statement: event.target.value } : c)),
                      )
                    }
                  />
                </label>
                <label>
                  <span>How it is checked</span>
                  <input
                    value={condition.verification}
                    onChange={(event) =>
                      setConditions((current) =>
                        current.map((c, i) => (i === index ? { ...c, verification: event.target.value } : c)),
                      )
                    }
                  />
                </label>
              </div>
            ))}
          </fieldset>
          {request.liveCheck ? (
            <p className="rs-hint">
              After release, Brain checks in production that {request.liveCheck.path} serves
              &ldquo;{request.liveCheck.contains}&rdquo;.
            </p>
          ) : null}
          {repositories.length === 0 ? (
            <p className="rs-state rs-state-empty">
              There is nowhere to run this yet from here: this project has not been given a
              repository you can authorize. Onboard one on Build → Repositories.
            </p>
          ) : (
            <>
              {repositories.length > 1 ? (
                <label className="rs-software-where">
                  <span>Where should this happen?</span>
                  <select value={grantId} onChange={(event) => setGrantId(event.target.value)}>
                    <option value="">Choose a repository…</option>
                    {repositories.map((candidate) => (
                      <option key={candidate.grantId} value={candidate.grantId}>
                        {candidate.repositoryId}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {choice ? (
                <p className="rs-software-scope">
                  {choice.scopeSentence} Anything outside that is rejected whole, and nothing is
                  merged or deployed without you.
                </p>
              ) : null}
              <div className="rs-software-actions">
                <button
                  type="button"
                  className="rs-primary"
                  disabled={busy || !choice || usable.length === 0}
                  onClick={() =>
                    void act(() =>
                      RussellApi.authorizeSoftware(request.id, { grantId, acceptanceConditions: usable }),
                    )
                  }
                >
                  {busy ? 'Authorizing…' : 'Authorize'}
                </button>
                <button
                  type="button"
                  className="rs-button"
                  disabled={busy}
                  onClick={() => void act(() => RussellApi.declineSoftware(request.id, 'Not wanted.'))}
                >
                  Not this
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {release ? (
        <ReleaseCard
          release={release}
          latestChecks={(delivery?.latestChecks as { checks?: ChecksReading } | null)?.checks ?? null}
          waiting={delivery?.releaseDecisionWaiting === true}
        />
      ) : entry.pullRequestUrl ? (
        <a href={entry.pullRequestUrl} rel="noreferrer noopener" target="_blank">
          Review the pull request
        </a>
      ) : null}

      {delivery?.releaseDecisionWaiting ? (
        <div className="rs-software-actions">
          {release?.pullRequest?.url ? (
            <a className="rs-primary" href={release.pullRequest.url} rel="noreferrer noopener" target="_blank">
              Review and merge on GitHub to release
            </a>
          ) : null}
          {refusing ? (
            <form
              className="rs-thread-software-refuse"
              onSubmit={(event) => {
                event.preventDefault();
                void act(() => RussellApi.refuseRelease(request.id, reason));
              }}
            >
              <label>
                <span>Why not? (kept with the decision)</span>
                <textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} />
              </label>
              <button type="submit" className="rs-button" disabled={busy}>
                {busy ? 'Recording…' : 'Refuse this release'}
              </button>
            </form>
          ) : (
            <button type="button" className="rs-button" disabled={busy} onClick={() => setRefusing(true)}>
              Refuse this release…
            </button>
          )}
        </div>
      ) : null}

      {delivery && delivery.timeline.some((step) => step.text) ? (
        <details className="rs-thread-software-timeline">
          <summary>What has happened ({delivery.timeline.filter((step) => step.text).length})</summary>
          <ol>
            {delivery.timeline
              .filter((step) => step.text)
              .map((step, index) => (
                <li key={index}>
                  <time dateTime={step.at}>{step.at.slice(0, 16).replace('T', ' ')}</time>{' '}
                  {step.byPerson ? 'You: ' : ''}
                  {step.text}
                </li>
              ))}
          </ol>
        </details>
      ) : null}

      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}
    </article>
  );
}

interface ChecksReading {
  state: 'NONE' | 'PENDING' | 'FAILED' | 'PASSED' | 'UNREADABLE';
  total: number;
  failed: string[];
}

/** The release card's shape, as `softwareDelivery.ts` records it. */
interface ReleaseSnapshot {
  pullRequest?: { number?: number; url?: string; title?: string; baseRef?: string; headRef?: string };
  headSha?: string;
  headIsIntegration?: boolean;
  files?: { path: string; status: string; additions: number; deletions: number }[];
  filesTotal?: number | null;
  filesTruncated?: boolean | null;
  additions?: number;
  deletions?: number;
  checks?: ChecksReading;
  review?: { verdict: string; independence: string; round: number; summary: string } | null;
  openFindings?: number;
  unitsIntegrated?: number;
  acceptanceConditions?: { statement: string; verification: string }[];
  liveCheck?: { path: string; contains: string } | null;
  releasesBrain?: boolean;
}

function checksWords(checks: ChecksReading | null | undefined): string {
  if (!checks) return 'Not read.';
  switch (checks.state) {
    case 'PASSED':
      return `All ${checks.total} passed.`;
    case 'FAILED':
      return `${checks.failed.length} of ${checks.total} failed: ${checks.failed.join(', ')}.`;
    case 'PENDING':
      return `Still running (${checks.total} reported).`;
    case 'NONE':
      return 'None reported — an absence, not a pass.';
    default:
      return 'Could not be read.';
  }
}

/**
 * Exactly what would be released, as the forge described it when the pull
 * request became ready — so the decision is made on the change rather than on a
 * summary of it.
 */
function ReleaseCard({
  release,
  latestChecks,
  waiting,
}: {
  release: ReleaseSnapshot;
  latestChecks: ChecksReading | null;
  waiting: boolean;
}): JSX.Element {
  const pr = release.pullRequest ?? {};
  const files = release.files ?? [];
  return (
    <div className="rs-thread-release" aria-label="What would be released">
      <h4>{waiting ? 'What merging would release' : 'What was put up for release'}</h4>
      <p>
        <a href={pr.url} rel="noreferrer noopener" target="_blank">
          Pull request #{pr.number}
        </a>
        {pr.title ? ` — ${pr.title}` : ''}. Into <code>{pr.baseRef}</code> from <code>{pr.headRef}</code>, head{' '}
        <code>{(release.headSha ?? '').slice(0, 12)}</code>
        {release.headIsIntegration ? ', the exact commit Brain integrated and had reviewed.' : '.'}
      </p>
      <p>
        {release.filesTotal ?? files.length} file(s), +{release.additions ?? 0}/−{release.deletions ?? 0}
        {release.filesTruncated ? ' (the forge truncated the list)' : ''}.
      </p>
      <ul className="rs-thread-release-files">
        {files.map((file) => (
          <li key={file.path}>
            <code>{file.path}</code> <span className="rs-hint">{file.status} +{file.additions}/−{file.deletions}</span>
          </li>
        ))}
      </ul>
      <p>
        Independent review:{' '}
        {release.review
          ? `${release.review.verdict} (${release.review.independence}, round ${release.review.round}).`
          : 'none recorded.'}{' '}
        Open findings: {release.openFindings ?? 0}. Units integrated: {release.unitsIntegrated ?? 0}.
      </p>
      <p>Repository checks on it: {checksWords(latestChecks ?? release.checks)}</p>
      {release.acceptanceConditions && release.acceptanceConditions.length > 0 ? (
        <>
          <p>It was built to make these true:</p>
          <ul className="rs-thread-software-conditions">
            {release.acceptanceConditions.map((condition, index) => (
              <li key={index}>{condition.statement}</li>
            ))}
          </ul>
        </>
      ) : null}
      {waiting ? (
        <p className="rs-hint">
          Merging the pull request is the release decision, and it is yours: Brain does not merge.
          {release.releasesBrain ? ' The next deploy of production carries it, and Brain reports here when it is serving it' : ''}
          {release.releasesBrain && release.liveCheck
            ? ` and checks that ${release.liveCheck.path} serves “${release.liveCheck.contains}”.`
            : release.releasesBrain
              ? '.'
              : ''}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one thing Brain declined to guess, in the server's own words.
 *
 * It renders a sentence and composes none of its own — the same rule the
 * authorization card follows, for the same reason: a screen that paraphrased a
 * refusal would eventually paraphrase it wrongly. It is absent far more often
 * than present, because an ordinary refusal needs no answer and a prompt under
 * every remark is how a person learns to stop reading them.
 */
function Clarification({
  clarification,
}: {
  clarification: SoftwareClarification | null;
}): JSX.Element | null {
  if (!clarification) return null;
  return (
    <p className="rs-thread-clarify" role="status" data-kind={clarification.kind}>
      {clarification.question}
    </p>
  );
}

export function Conversation({
  conversationId,
  showComposer = true,
  reloadToken = 0,
}: {
  conversationId: string;
  /**
   * Whether this view carries its own input.
   *
   * False when the shell's docked command bar is present, because two
   * identical text boxes on one screen is the failure the thread picker
   * already had once: a person cannot tell which one does what, and they use
   * the wrong one. One input, one place.
   */
  showComposer?: boolean;
  /** Bumped by whoever sent a message from outside, to re-read the thread. */
  reloadToken?: number;
}): JSX.Element {
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

  /*
   * A change being built is also something happening, just slower: its stages,
   * the release card and the release itself arrive as the factory and the forge
   * move. So while one is under way the thread re-reads at a walking pace, and
   * stops when every change here has reached an end.
   */
  const building = (thread.data?.software ?? []).some(
    (entry) =>
      entry.request.state === 'AUTHORIZED' &&
      !['RELEASE_REFUSED', 'CLOSED_UNMERGED', 'CANCELLED', 'RELEASED', 'LIVE_VERIFIED', 'LIVE_CHECK_FAILED', 'DEPLOY_UNOBSERVABLE'].includes(
        entry.delivery?.phase ?? 'RUNNING',
      ),
  );
  useEffect(() => {
    if (!building || waiting) return;
    const timer = setInterval(() => thread.reload(), BUILDING_POLL_MS);
    return () => clearInterval(timer);
  }, [building, waiting, thread]);

  /*
   * Somebody said something from the command bar.
   *
   * The bar posts and then bumps this, rather than patching a turn in here:
   * the same rule the composer already follows, so what a person sees is what
   * the server stored rather than what the client hoped.
   */
  const seen = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === seen.current) return;
    seen.current = reloadToken;
    thread.reload();
  }, [reloadToken, thread]);

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
      <SoftwareTrail
        software={thread.data?.software ?? []}
        repositories={thread.data?.repositories ?? []}
        onAnswered={() => thread.reload()}
      />
      <Clarification clarification={thread.data?.clarification ?? null} />
      <div ref={bottom} />

      {problem ? (
        <p className="rs-state rs-state-error" role="alert">
          {problem}
        </p>
      ) : null}

      {showComposer ? (
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
      ) : null}
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
      <span className="rs-turn-who">
        {turn.role === 'USER' ? 'You' : turn.role === 'SYSTEM' ? 'Brain' : 'Russell'}
      </span>
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
