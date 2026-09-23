/**
 * What Brain learned from the outcomes of its own work, as a person reads it.
 *
 * Every sentence is the server's (`services/learning/view.ts`), for the reason
 * every Russell screen gives: a screen that paraphrased a lesson would
 * eventually paraphrase it wrongly, and then a person is reading one thing
 * while the launcher acts on another.
 *
 * Three rules the page keeps:
 *
 * * **An unknown is never a number.** A measure whose class is UNKNOWN renders
 *   as *not measured* beside what would measure it.
 * * **A lesson that changes nothing is shown, not hidden.** The anecdotes are
 *   the half that stop one vivid result becoming a rule, so they have their own
 *   section.
 * * **Every claim opens to its rows.** Outcome ids, decision ids and the
 *   prediction's provenance (recorded at the decision, or reconstructed later)
 *   are printed rather than summarised.
 */
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useAsync } from './useAsync.ts';
import type { LearningView } from '../../../server/services/learning/view.ts';

export function LearningPage({ projectId }: { projectId: string | null }): JSX.Element {
  const query = useAsync<LearningView | null>(
    async () => (projectId ? await api<LearningView>(`/api/projects/${projectId}/learning`) : null),
    [projectId],
  );
  if (!projectId) return <p className="rs-empty">Open a project to see what Brain learned in it.</p>;
  // The placeholder is for the first read only, so a reload never unmounts a
  // form somebody is part-way through (§29).
  if (query.loading && !query.data) return <p className="rs-empty">Reading outcomes…</p>;
  if (query.error) return <p className="rs-empty">{query.error.message}</p>;
  const view = query.data;
  if (!view) return <p className="rs-empty">Nothing to show.</p>;

  return (
    <div className="rs-view rs-learning">
      <h2 className="rs-view-title">Learning from outcomes</h2>

      <section className="rs-card" aria-label="What Brain learned">
        <h3>What Brain learned</h3>
        <p>{view.summary.learned ?? 'No lesson has cleared its floor yet, so nothing Brain does has changed.'}</p>
        {view.summary.doesDifferently ? (
          <>
            <h4>What it now does differently</h4>
            <p>{view.summary.doesDifferently}</p>
          </>
        ) : null}
        {view.summary.supportedBy ? (
          <>
            <h4>The observed outcome behind it</h4>
            <p>{view.summary.supportedBy}</p>
          </>
        ) : null}
        {view.summary.notConcluded ? (
          <>
            <h4>What Brain deliberately did not conclude</h4>
            <p>{view.summary.notConcluded}</p>
          </>
        ) : null}
      </section>

      <section className="rs-card" aria-label="Outcomes">
        <h3>Outcomes observed ({view.counts.total})</h3>
        <p className="rs-item-meta">
          {view.counts.SUCCEEDED} succeeded · {view.counts.PARTIAL} partial · {view.counts.FAILED} failed ·{' '}
          {view.counts.NOT_ATTEMPTED} never reached any work · {view.counts.ONGOING} ongoing
        </p>
        <ul className="rs-list">
          {view.outcomes.slice(0, 30).map(({ outcome, prediction, comparison }) => (
            <li key={outcome.id}>
              <strong>{outcome.result}</strong> <code>{outcome.id}</code> on <code>{outcome.subjectId}</code>{' '}
              (attempt {outcome.attempt}, {outcome.observedAt})
              <p className="rs-item-meta">{comparison}</p>
              {prediction ? (
                <p className="rs-item-meta">
                  Prediction <code>{prediction.id}</code> — {prediction.provenance === 'RECORDED' ? 'recorded when Brain decided' : 'reconstructed from the launch event afterwards'}: {prediction.basis}
                </p>
              ) : null}
              <ul className="rs-item-meta">
                {outcome.measures.map((measure) => (
                  <li key={measure.metric}>
                    {measure.metric}:{' '}
                    {measure.evidence === 'UNKNOWN' ? <em>not measured</em> : `${measure.value} ${measure.unit}`}{' '}
                    ({measure.evidence}) — {measure.source}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="rs-card" aria-label="Lessons">
        <h3>Lessons, with their samples</h3>
        <ul className="rs-list">
          {view.lessons.map((lesson) => (
            <li key={lesson.key}>
              <strong>{lesson.status}</strong> · {lesson.level} · <code>{lesson.key}</code>
              <p>{lesson.statement}</p>
              <p className="rs-item-meta">{lesson.effect}</p>
              <p className="rs-item-meta">
                {lesson.independent} independent observation(s). {lesson.independenceRule}
              </p>
              {lesson.outcomeIds.length > 0 ? (
                <p className="rs-item-meta">Rests on: {lesson.outcomeIds.join(', ')}</p>
              ) : null}
              <Correct projectId={projectId} targetKind="LESSON" targetKey={lesson.key} withdrawn={lesson.status === 'WITHDRAWN'} onDone={query.reload} />
            </li>
          ))}
        </ul>
      </section>

      <section className="rs-card" aria-label="Decisions a lesson changed">
        <h3>Decisions an outcome changed</h3>
        {view.decisions.length === 0 ? <p>No decision has been changed by a lesson yet.</p> : null}
        <ul className="rs-list">
          {view.decisions.map((decision) => (
            <li key={decision.id}>
              <code>{decision.id}</code> {decision.decision} at {decision.createdAt}: would have{' '}
              <strong>{decision.defaultChoice}</strong>, chose <strong>{decision.chosen}</strong>
              {decision.restsOnWithdrawnLesson ? ' — rests on a lesson a person has since withdrawn' : ''}
              <p className="rs-item-meta">{decision.reason}</p>
              <p className="rs-item-meta">Outcomes: {decision.outcomeIds.join(', ')}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="rs-card" aria-label="Watched facts">
        <h3>Facts Brain is watching</h3>
        <ul className="rs-list">
          {view.watches.map((watch) => (
            <li key={watch.id}>
              {watch.fact} ({watch.factRef}): <strong>{watch.lastValue ?? 'not read yet'}</strong> — {watch.why}
            </li>
          ))}
        </ul>
        {view.changes.length > 0 ? <h4>What changed</h4> : null}
        <ul className="rs-list">
          {view.changes.map((change) => (
            <li key={change.id}>
              {change.observedAt}: {change.whatChanged} <em>{change.proposal}</em>
            </li>
          ))}
        </ul>
      </section>

      <section className="rs-card" aria-label="Missing capabilities">
        <h3>Missing capabilities</h3>
        {view.capabilities.length === 0 ? <p>No limitation has recurred often enough to propose a change.</p> : null}
        {view.capabilities.map((proposal) => (
          <div key={proposal.blockerKey} className="rs-item">
            <p>
              <strong>{proposal.state}</strong> · {proposal.blockerClass} stopped {proposal.occurrences} attempt(s) on{' '}
              {proposal.subjects} subject(s), {proposal.firstSeenAt} to {proposal.lastSeenAt}.
            </p>
            <p className="rs-item-meta">Brain's own words for it: “{proposal.reason}”</p>
            <p>Unlocks: {proposal.unlocks}</p>
            <p className="rs-item-meta">{proposal.valueEvidence}</p>
            <ul className="rs-list">
              {proposal.options.map((option) => (
                <li key={option.route}>
                  <strong>{option.route}</strong> {option.viable ? '' : '(not viable) '}— {option.why} Cost ({option.cost.evidence}): {option.cost.text} First test: {option.firstTest}
                </li>
              ))}
            </ul>
            <p>
              Brain recommends <strong>{proposal.recommended ?? 'a reading first'}</strong>: {proposal.recommendedBecause}
            </p>
            <p className="rs-item-meta">
              Since it last occurred: {proposal.sinceLastSeen.attempts} attempt(s) settled,{' '}
              {proposal.sinceLastSeen.performedWork} performed work. {proposal.verification}
            </p>
            <Decide projectId={projectId} proposalKey={proposal.blockerKey} recommended={proposal.recommended} onDone={query.reload} />
            {proposal.state === 'APPROVED' ? (
              <Landed projectId={projectId} proposalKey={proposal.blockerKey} onDone={query.reload} />
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

function Correct(props: {
  projectId: string;
  targetKind: 'LESSON' | 'OUTCOME';
  targetKey: string;
  withdrawn: boolean;
  onDone: () => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const action = props.withdrawn ? 'REINSTATE' : 'WITHDRAW';
  return (
    <form
      className="rs-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void api<{ message: string }>(`/api/projects/${props.projectId}/learning/corrections`, {
          method: 'POST',
          body: JSON.stringify({ targetKind: props.targetKind, targetKey: props.targetKey, action, reason }),
        }).then(
          (result) => {
            setMessage(result.message);
            props.onDone();
          },
          (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
        );
      }}
    >
      <label>
        Why {action === 'WITHDRAW' ? 'this conclusion is wrong' : 'it should apply again'}
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button type="submit" disabled={!reason.trim()}>
        {action === 'WITHDRAW' ? 'Withdraw this lesson' : 'Reinstate'}
      </button>
      {message ? <p className="rs-item-meta">{message}</p> : null}
    </form>
  );
}

function Decide(props: {
  projectId: string;
  proposalKey: string;
  recommended: string | null;
  onDone: () => void;
}): JSX.Element {
  const [route, setRoute] = useState(props.recommended ?? 'PERSON');
  const [reason, setReason] = useState('');
  const [repository, setRepository] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="rs-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void api<{ message: string }>(`/api/projects/${props.projectId}/learning/capabilities/decide`, {
          method: 'POST',
          body: JSON.stringify({
            blockerKey: props.proposalKey,
            route,
            reason,
            ...(route === 'IMPLEMENT' && repository.trim() ? { repository: repository.trim() } : {}),
          }),
        }).then(
          (result) => {
            setMessage(result.message);
            props.onDone();
          },
          (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
        );
      }}
    >
      <label>
        Route
        <select value={route} onChange={(event) => setRoute(event.target.value)}>
          <option value="IMPLEMENT">Implement it (Software Factory)</option>
          <option value="CONNECT_SERVICE">Connect an existing service</option>
          <option value="PERSON">A person does it each time</option>
          <option value="DECLINE">Decline</option>
        </select>
      </label>
      {route === 'IMPLEMENT' ? (
        <label>
          Repository to submit to (optional)
          <input value={repository} onChange={(event) => setRepository(event.target.value)} />
        </label>
      ) : null}
      <label>
        Why
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button type="submit" disabled={!reason.trim()}>
        Record this decision
      </button>
      {message ? <p className="rs-item-meta">{message}</p> : null}
    </form>
  );
}

/**
 * "The change is live now." The one instant verification counts from, said by
 * a person because Brain cannot see a deploy from inside its own rows.
 */
function Landed(props: { projectId: string; proposalKey: string; onDone: () => void }): JSX.Element {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="rs-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void api<{ message: string }>(`/api/projects/${props.projectId}/learning/capabilities/landed`, {
          method: 'POST',
          body: JSON.stringify({ blockerKey: props.proposalKey, reason }),
        }).then(
          (result) => {
            setMessage(result.message);
            props.onDone();
          },
          (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
        );
      }}
    >
      <label>
        What went live
        <input value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <button type="submit" disabled={!reason.trim()}>
        The change is live now
      </button>
      {message ? <p className="rs-item-meta">{message}</p> : null}
    </form>
  );
}
