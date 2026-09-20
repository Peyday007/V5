/**
 * The work register, as a person reads it.
 *
 * It answers the six questions the owner actually asks — *what is pursuing
 * money, what is being built, what is running, what is blocked, what needs me,
 * what actually shipped* — and every one of those answers, every state word and
 * every sentence in it comes from the server's one projection. **Nothing here
 * derives anything.** §29 makes that argument at length and this is the surface
 * it was made about: a page that worked out its own status from the same graph
 * is how a person comes to read two different answers about one piece of work.
 *
 * Three things it deliberately does not draw:
 *
 *   * **No progress bar and no percentage.** A workstream's state is a word
 *     with the row that decided it printed beside it, and a bar over an unknown
 *     denominator is the invented precision §29 was rejected for.
 *   * **No badge, streak or celebration.** Shipped is a count and a list.
 *   * **No control a reader may not use rendered as absent.** The whole section
 *     renders for every member; what a caller may *do* is decided by the server
 *     when they try, and a refusal they could not have predicted is what
 *     teaches somebody a refusal is arbitrary.
 *
 * The `UNKNOWN` count is printed rather than folded into another number,
 * because *we could not tell* and *nothing is happening* are different answers
 * with different remedies.
 */
import { useCallback, useMemo, useState } from 'react';
import { useAsync } from './useAsync.ts';
import { listState } from './present.ts';
import { RegisterApi } from '../lib/registerApi.ts';
import type { RegisterView, UnfiledItem, WorkstreamPurpose, WorkstreamView } from '../lib/registerApi.ts';

/**
 * The six questions, in the order they are asked.
 *
 * `beingBuilt` is deliberately absent from this strip: it is the union of three
 * of the others, so showing it as a seventh number would make one workstream
 * count twice in a row of counts and teach a reader the numbers do not add up.
 */
const QUESTIONS: { key: keyof RegisterView['answers']; label: string; blank: string }[] = [
  { key: 'pursuingMoney', label: 'Pursuing money', blank: 'Nothing here is aimed at revenue yet.' },
  { key: 'running', label: 'Running', blank: 'Nothing is under way.' },
  { key: 'blocked', label: 'Blocked', blank: 'Nothing is stuck.' },
  { key: 'needsYou', label: 'Needs you', blank: 'Nothing is waiting on you.' },
  { key: 'shipped', label: 'Shipped', blank: 'Nothing has shipped yet.' },
];

const PURPOSE_CHOICES: { key: WorkstreamPurpose; label: string; meaning: string }[] = [
  { key: 'REVENUE_DIRECT', label: 'Pursuing money', meaning: 'success is money arriving' },
  {
    key: 'REVENUE_ENABLING',
    label: 'Clearing the way',
    meaning: 'it removes something standing between us and money',
  },
  { key: 'CAPABILITY', label: 'A capability', meaning: 'it makes new kinds of work possible' },
  { key: 'LONG_TERM', label: 'Longer term', meaning: 'it serves a goal further out' },
];

export function Register({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync(() => RegisterApi.view(), []);
  const [question, setQuestion] = useState<keyof RegisterView['answers']>('needsYou');
  const [filing, setFiling] = useState<UnfiledItem | null>(null);

  const view = query.data;
  const state = listState<WorkstreamView>({
    loading: query.loading,
    error: query.error,
    items: view?.workstreams ?? null,
    /*
     * The noun a refusal names, and it has to be this section's rather than
     * "workstream".
     *
     * The Work destination now renders two panels, and a reader who may open
     * neither would otherwise get *"…for access to see the workstream"* stacked
     * on *"…for access to see the work"* — two sentences that differ by one
     * word and read as one page repeating itself. §36 refuses to remove a
     * section because a reader may not see it, so the sections stay and the
     * sentences have to be told apart.
     */
    noun: 'work register',
    /*
     * The sentence slot, not the noun. `noun` fills *"There is no ${noun}
     * yet."*, so a sentence passed there comes out as a sentence inside a
     * sentence — the defect `present.ts` records at length.
     */
    explanation:
      view && view.unfiled.length > 0
        ? 'Nothing is filed yet, and there is work below that nobody has accounted for.'
        : null,
  });

  const byId = useMemo(
    () => new Map((view?.workstreams ?? []).map((one) => [one.id, one] as const)),
    [view],
  );

  const shown = (view?.answers[question] ?? [])
    .map((id) => byId.get(id))
    .filter((one): one is WorkstreamView => one !== undefined);

  const reload = query.reload;
  const onFiled = useCallback(() => {
    setFiling(null);
    reload();
  }, [reload]);

  return (
    <section className="rs-panel rs-register" aria-labelledby="rs-register-title">
      <h2 id="rs-register-title">The work register</h2>

      {state.phase !== 'READY' ? (
        <p
          className={`rs-state rs-state-${state.phase.toLowerCase()}`}
          role={state.phase === 'ERROR' ? 'alert' : undefined}
        >
          {state.message}
          {state.retryable ? (
            <button type="button" className="rs-retry" onClick={query.reload}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}

      {view ? (
        <>
          <ul className="rs-register-questions" role="tablist">
            {QUESTIONS.map((one) => {
              const count = view.answers[one.key].length;
              return (
                <li key={one.key}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={question === one.key}
                    className={`rs-register-question${question === one.key ? ' is-selected' : ''}`}
                    onClick={() => setQuestion(one.key)}
                  >
                    <span className="rs-register-question-label">{one.label}</span>
                    <span className="rs-count">{count}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {shown.length === 0 ? (
            <p className="rs-quiet">{QUESTIONS.find((one) => one.key === question)?.blank}</p>
          ) : (
            <ul className="rs-list">
              {shown.map((one) => (
                <li key={one.id}>
                  <WorkstreamCard workstream={one} />
                </li>
              ))}
            </ul>
          )}

          {view.unknown > 0 ? (
            <p className="rs-quiet rs-register-unknown">
              {view.unknown === 1
                ? 'One workstream has nothing linked to it, so Brain cannot say where it has got to.'
                : `${view.unknown} workstreams have nothing linked to them, so Brain cannot say where they have got to.`}
            </p>
          ) : null}

          {view.unfiled.length > 0 ? (
            <div className="rs-register-unfiled">
              <h3 className="rs-group-title">
                Work nobody has accounted for
                <span className="rs-count">{view.unfiled.length}</span>
              </h3>
              <p className="rs-quiet">
                Brain is holding these and cannot say what they are for. Filing one is a sentence
                about the outcome and a choice of why — neither of which Brain may compose for you.
              </p>
              <ul className="rs-list">
                {view.unfiled.map((item) => (
                  <li key={`${item.kind}:${item.ref}`}>
                    <div className="rs-card">
                      <p className="rs-card-title">{item.title}</p>
                      <p className="rs-quiet">
                        {item.kind.toLowerCase().replace(/_/g, ' ')} · {item.status}
                      </p>
                      <p className="rs-card-why">{item.why}</p>
                      <button type="button" className="rs-action" onClick={() => setFiling(item)}>
                        File this
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {filing ? (
            <FileOne
              item={filing}
              projectId={filing.projectId ?? projectId}
              onDone={onFiled}
              onCancel={() => setFiling(null)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * One workstream.
 *
 * The state word carries the row that decided it, at ordinary depth rather than
 * behind a disclosure, because a state a reader cannot check is a state they
 * have to take on trust — and this register's whole claim is that they do not
 * have to.
 */
function WorkstreamCard({ workstream }: { workstream: WorkstreamView }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rs-card rs-workstream rs-workstream-${workstream.state.toLowerCase()}`}>
      <p className="rs-card-title">{workstream.title}</p>
      <p className="rs-quiet">
        {workstream.purposeLabel} · {STATE_WORDS[workstream.state] ?? workstream.state}
      </p>
      <p className="rs-card-why">{workstream.intent}</p>

      <p className="rs-evidence">Because: {workstream.stateEvidence}</p>

      {workstream.ownerAction ? (
        <p className="rs-owner-action">
          <strong>You:</strong> {workstream.ownerAction}
        </p>
      ) : workstream.nextAction ? (
        <p className="rs-next-action">Next: {workstream.nextAction}</p>
      ) : null}

      {workstream.blockers.length > 0 ? (
        <ul className="rs-blockers">
          {workstream.blockers.map((blocker, index) => (
            <li key={index}>{blocker}</li>
          ))}
        </ul>
      ) : null}

      <button type="button" className="rs-disclosure" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} what it is made of
        <span className="rs-count">{workstream.readings.length}</span>
      </button>
      {open ? (
        <ul className="rs-list rs-readings">
          {workstream.readings.map((reading) => (
            <li key={reading.linkId} className={reading.missing ? 'rs-reading-missing' : undefined}>
              <span className="rs-reading-kind">{reading.kind.toLowerCase().replace(/_/g, ' ')}</span>{' '}
              {reading.status}
              <span className="rs-quiet"> — {reading.evidence}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The words, which are the client's one job here.
 *
 * The server sends a vocabulary and this renders it; it does not decide which
 * state anything is in, and there is no branch here that could.
 */
const STATE_WORDS: Record<string, string> = {
  UNKNOWN: 'nobody has said where this has got to',
  PROPOSED: 'proposed',
  IN_PROGRESS: 'running',
  PR_READY: 'waiting on a review',
  MERGED: 'merged',
  DEPLOYED: 'deployed',
  VERIFIED_LIVE: 'verified live',
  DONE: 'done',
  BLOCKED: 'blocked',
};

/**
 * Filing one thing.
 *
 * Two fields, both of them a person's: what outcome this is for, and why it is
 * worth doing. Brain supplies neither — §8's rule at the one place it would be
 * most tempting to break, because a composed intent would read like a decision
 * somebody made.
 */
function FileOne(props: {
  item: UnfiledItem;
  projectId: string | null;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { item, projectId, onDone, onCancel } = props;
  const [title, setTitle] = useState(item.title);
  const [intent, setIntent] = useState('');
  const [purpose, setPurpose] = useState<WorkstreamPurpose>('CAPABILITY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await RegisterApi.open({
        projectId,
        title,
        intent,
        purpose,
        links: [{ kind: item.kind, ref: item.ref, relation: 'PURSUES', label: item.title }],
      });
      onDone();
    } catch (cause) {
      // The words stay in the boxes. §29's rule that the interface is never
      // optimistic: a failed send keeps what somebody typed.
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="rs-card rs-file-one">
      <h3>File {item.title}</h3>
      <label className="rs-field">
        <span>What to call it</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="rs-field">
        <span>What outcome is this for?</span>
        <textarea
          value={intent}
          rows={3}
          placeholder="The thing that becomes true when this is done."
          onChange={(event) => setIntent(event.target.value)}
        />
      </label>
      <fieldset className="rs-field">
        <legend>Why is it worth doing?</legend>
        {PURPOSE_CHOICES.map((choice) => (
          <label key={choice.key} className="rs-choice">
            <input
              type="radio"
              name="purpose"
              checked={purpose === choice.key}
              onChange={() => setPurpose(choice.key)}
            />
            <span>
              <strong>{choice.label}</strong> — {choice.meaning}
            </span>
          </label>
        ))}
      </fieldset>
      {error ? (
        <p className="rs-state rs-state-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="rs-actions">
        <button
          type="button"
          className="rs-action"
          disabled={busy || intent.trim().length === 0 || title.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? 'Filing…' : 'File it'}
        </button>
        <button type="button" className="rs-action rs-action-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
