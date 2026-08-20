/**
 * The plan, before anything is spent on it.
 *
 * Research costs the user's allowance and their afternoon, and the most
 * expensive mistake is answering the wrong question carefully. So this screen
 * shows what Brain understood the goal to be, what the archive already answers,
 * what it believes the real gaps are, and exactly which jobs it proposes — and
 * lets the user fix any of it before the first job runs.
 */
import { useCallback, useState } from 'react';
import type { ResearchPlanReview } from '../lib/api.ts';
import { Api } from '../lib/api.ts';
import { Pill } from './Badge.tsx';

function Group(props: {
  title: string;
  note: string;
  items: ResearchPlanReview['gaps'];
  onReverify?: (requirementId: string) => void;
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <section className="card">
      <h4>
        {props.title} <span className="mono muted">({props.items.length})</span>
      </h4>
      <p className="small muted">{props.note}</p>
      <ul className="small review-list">
        {props.items.map((item) => (
          <li key={item.requirement.id}>
            <strong>{item.requirement.statement}</strong>
            {item.reasons.length > 0 ? <div className="muted">{item.reasons.join(' ')}</div> : null}
            {item.evidence.length > 0 ? (
              <div className="muted">
                {item.evidence.length} archive claim(s):{' '}
                {item.evidence
                  .slice(0, 2)
                  .map((claim) => claim.claim.slice(0, 80))
                  .join(' · ')}
              </div>
            ) : null}
            {props.onReverify ? (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => props.onReverify?.(item.requirement.id)}
              >
                VERIFY THIS ANYWAY
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ResearchReview(props: {
  review: ResearchPlanReview;
  onChanged(review: ResearchPlanReview): void;
}): JSX.Element {
  const { review } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[]>([]);
  const [newRequirement, setNewRequirement] = useState('');
  const [removed, setRemoved] = useState<string[]>([]);

  const decide = useCallback(
    async (decisions: Parameters<typeof Api.decideResearchReview>[1]): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result = await Api.decideResearchReview(review.orchestration.id, decisions);
        setApplied(result.applied);
        props.onChanged(result.review);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [props, review.orchestration.id],
  );

  const interpretation = review.interpretation;

  return (
    <div className="research-review">
      <section className="card">
        <h4>What Brain understood the goal to be</h4>
        <p className="small">{interpretation.primaryQuestion ?? interpretation.assignment}</p>
        <div className="row wrap">
          {interpretation.geography ? <Pill label="GEOGRAPHY" value={interpretation.geography} /> : null}
          {interpretation.timeframe ? <Pill label="TIMEFRAME" value={interpretation.timeframe} /> : null}
          {interpretation.population ? <Pill label="POPULATION" value={interpretation.population} /> : null}
        </div>
        {interpretation.definitions.length > 0 ? (
          <ul className="small muted review-list">
            {interpretation.definitions.map((entry) => (
              <li key={entry.term}>
                <strong>{entry.term}</strong>: {entry.definition}
              </li>
            ))}
          </ul>
        ) : null}
        {interpretation.excluded.length > 0 ? (
          <p className="small muted">Out of scope: {interpretation.excluded.join(', ')}</p>
        ) : null}
        {interpretation.ambiguities.length > 0 ? (
          <div className="warn small">
            Not settled by the assignment alone:{' '}
            {interpretation.ambiguities.map((entry) => entry.question).join(' · ')}
          </div>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() =>
              void decide({
                boundary: {
                  geography: interpretation.geography ?? undefined,
                  timeframe: interpretation.timeframe ?? undefined,
                  population: interpretation.population ?? undefined,
                },
              })
            }
          >
            CONFIRM THE SCOPE
          </button>
        </div>
      </section>

      <Group
        title="Already answered by the archive"
        note="These will not be researched again. If you do not believe one of them, ask for it to be verified."
        items={review.alreadyAnswered}
        onReverify={(id) => void decide({ forceReverify: [id] })}
      />
      <Group
        title="Partly answered"
        note="Some evidence exists, but not enough of it, or not from independent publishers."
        items={review.partial}
      />
      <Group
        title="Out of date"
        note="The archive answers these, but from evidence newer sources have overtaken."
        items={review.stale}
      />
      <Group
        title="Contradicted"
        note="The archive disagrees with itself here. Anything built on either claim is unsafe until it is settled."
        items={review.contradicted}
      />
      <Group
        title="Claimed but not supported"
        note="The archive states these without evidence that stands up on its own."
        items={review.unsupported}
      />
      <Group
        title="Genuine gaps"
        note="Nothing in the project answers these, so they are what the research is actually for."
        items={review.gaps}
      />
      <Group
        title="Somebody else's job"
        note="Real requirements, but not research: another layer, an implementation detail, or a tuning decision."
        items={review.ownedElsewhere}
      />

      <section className="card">
        <h4>
          What it proposes to run <span className="mono muted">({review.jobs.length} job(s))</span>
        </h4>
        <ul className="small review-list">
          {review.jobs.map((job) => (
            <li key={job.index}>
              <strong>
                Job {job.index + 1} · {job.jobKind.toLowerCase()}
              </strong>
              <div className="muted">{job.rationale}</div>
              <div className="row wrap">
                {job.fragmentKeys.map((key) => {
                  const entry = review.fragments.find((item) => item.fragment.fragmentKey === key);
                  const dropped = removed.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`btn btn--small ${dropped ? 'btn--ghost' : ''}`}
                      title={entry ? `${entry.tier}: ${entry.tierReason}` : key}
                      onClick={() =>
                        setRemoved((current) =>
                          current.includes(key)
                            ? current.filter((item) => item !== key)
                            : [...current, key],
                        )
                      }
                    >
                      {dropped ? '✕ ' : ''}
                      {key}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        {review.dependencyCycles.length > 0 ? (
          <div className="warn small">
            These fragments depend on each other in a circle, so one of them has to run first:{' '}
            {review.dependencyCycles.map((cycle) => cycle.join(' → ')).join(' | ')}
          </div>
        ) : null}
        {removed.length > 0 ? (
          <div className="row">
            <span className="small muted">{removed.length} fragment(s) marked to skip.</span>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => {
                void decide({ removeFragments: removed });
                setRemoved([]);
              }}
            >
              REMOVE THEM
            </button>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h4>Anything missing?</h4>
        <div className="row">
          <input
            className="input"
            placeholder="Something the goal needs that Brain did not list"
            value={newRequirement}
            onChange={(event) => setNewRequirement(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--small"
            disabled={busy || newRequirement.trim().length === 0}
            onClick={() => {
              void decide({ addRequirements: [{ statement: newRequirement.trim() }] });
              setNewRequirement('');
            }}
          >
            ADD REQUIREMENT
          </button>
        </div>
      </section>

      {applied.length > 0 ? (
        <ul className="small ok review-list">
          {applied.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {error ? <div className="error small">{error}</div> : null}

      <div className="row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !review.approvalRequired}
          onClick={() => void decide({ approve: true })}
        >
          {review.approvalRequired ? 'APPROVE AND START RESEARCH' : 'APPROVED'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void decide({ approve: true, autoApprove: true })}
        >
          APPROVE, AND DO NOT ASK AGAIN FOR THIS RUN
        </button>
      </div>
      <p className="small muted">
        Nothing has been spent yet. Approving is what starts the jobs; the plan stays on this page
        either way.
      </p>
    </div>
  );
}
