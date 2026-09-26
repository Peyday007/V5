/**
 * Research Intelligence, as a person reads it.
 *
 * Everything below is a field from the fetched `ResearchIntelligenceView`. No
 * sentence about what a disposition, a belief basis or a sufficiency verdict
 * *means* is composed here — the server already wrote the one sentence that
 * explains each of those (`whyItMatters`, `reason`, `detail`), and a second,
 * shorter version invented on this side is exactly the kind of paraphrase that
 * eventually disagrees with the thing it is paraphrasing.
 *
 * Four states, kept visibly apart rather than folded into one another:
 * loading, forbidden-or-absent (both surfaced by the route's 404, and
 * rendered identically — the server must not distinguish the two and neither
 * may this screen), a genuine transport error, and a packet that loaded and
 * turned out to hold nothing yet. A fifth, ordinary case — loaded with
 * something to show — is everything past that.
 */
import { getResearchIntelligence } from '../lib/researchIntelligenceApi.ts';
import type { QuestionView, ResearchIntelligenceView } from '../lib/researchIntelligenceApi.ts';
import { useAsync } from './useAsync.ts';
import { humanWhen, listState } from './present.ts';

/** Whether the fetched packet holds anything at all worth reading. */
function hasContent(view: ResearchIntelligenceView): boolean {
  return (
    view.understanding !== null ||
    view.next.length > 0 ||
    view.decisive.length > 0 ||
    view.settled.length > 0 ||
    view.retired.length > 0 ||
    view.needsPerson.length > 0 ||
    view.openContradictions.length > 0 ||
    view.changes.length > 0 ||
    view.lessons.length > 0
  );
}

/**
 * `beliefBasis: 'UNKNOWN'` and a null `belief` mean the same thing to a
 * reader — nothing is known yet — so both render as that one sentence rather
 * than a blank field or a stray `null`.
 */
function beliefText(question: QuestionView): string {
  if (question.beliefBasis === 'UNKNOWN' || question.belief === null) return 'not known yet';
  return `${question.belief} (${question.beliefBasis})`;
}

export function ResearchIntelligence({
  orchestrationId,
}: {
  orchestrationId: string;
}): JSX.Element {
  const query = useAsync(() => getResearchIntelligence(orchestrationId), [orchestrationId]);
  const view = query.data;
  const state = listState<ResearchIntelligenceView>({
    loading: query.loading,
    error: query.error,
    items: view === null ? null : hasContent(view) ? [view] : [],
    noun: 'this research packet',
  });

  if (state.phase !== 'READY' || !view) {
    return <p className={`rs-state rs-state-${state.phase.toLowerCase()}`}>{state.message}</p>;
  }

  return (
    <div className="rs-column">
      <p className="rs-eyebrow">Research intelligence</p>
      <h3 className="rs-view-title">What Brain believes it was asked, and where it stands</h3>

      {view.understanding ? <Understanding understanding={view.understanding} /> : null}

      {view.next.length > 0 ? (
        <section className="rs-group">
          <h4 className="rs-group-title">Agenda</h4>
          <ol className="rs-list">
            {view.next.map((entry) => (
              <li key={entry.key}>
                <p className="rs-item-title">{entry.question}</p>
                <p className="rs-item-meta">{entry.why}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <QuestionGroup title="Decisive" questions={view.decisive} />
      <QuestionGroup title="Settled" questions={view.settled} />
      <QuestionGroup title="Retired" questions={view.retired} />
      <QuestionGroup title="Needs a person" questions={view.needsPerson} />

      {view.openContradictions.length > 0 ? (
        <section className="rs-group">
          <h4 className="rs-group-title">
            Open contradictions
            <span className="rs-count">{view.openContradictions.length}</span>
          </h4>
          <ul className="rs-list">
            {view.openContradictions.map((one) => (
              <li key={one.claimId}>
                <div className="rs-row">
                  <span className="rs-item-title">{one.claimId}</span>
                  {one.challenged ? <span className="rs-pill">Challenged</span> : null}
                </div>
                {one.note ? <p className="rs-item-meta">{one.note}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.changes.length > 0 ? (
        <section className="rs-group">
          <h4 className="rs-group-title">What changed the plan</h4>
          <ul className="rs-list">
            {view.changes.map((change) => {
              const when = humanWhen(change.at);
              return (
                <li key={`${change.version}-${change.at}`}>
                  <div className="rs-row">
                    <span className="rs-item-title">
                      v{change.version} — {change.summary}
                    </span>
                    {when ? (
                      <time className="rs-item-meta" dateTime={change.at} title={when.exact}>
                        {when.text}
                      </time>
                    ) : null}
                  </div>
                  <p className="rs-item-meta">{change.reason}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Sufficiency sufficiency={view.sufficiency} />

      {view.lessons.length > 0 ? (
        <section className="rs-group rs-at-interested">
          <h4 className="rs-group-title">Lessons</h4>
          <ul className="rs-list">
            {view.lessons.map((lesson, index) => (
              <li key={index}>
                <p className="rs-item-title">{lesson.lesson}</p>
                <p className="rs-item-meta">{lesson.abstraction}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Understanding({
  understanding,
}: {
  understanding: NonNullable<ResearchIntelligenceView['understanding']>;
}): JSX.Element {
  return (
    <section className="rs-group">
      <h4 className="rs-group-title">Understanding</h4>
      <p className="rs-item-title">{understanding.outcomeSought}</p>
      {understanding.decisionSupported ? (
        <p className="rs-item-meta">{understanding.decisionSupported}</p>
      ) : null}
      <p className="rs-item-meta rs-at-interested">
        Stakes: {understanding.stakes} · Reversibility: {understanding.reversibility}
      </p>

      {understanding.nonGoals.length > 0 ? (
        <div>
          <p className="rs-item-meta">Not in scope</p>
          <ul className="rs-list">
            {understanding.nonGoals.map((one, index) => (
              <li key={index}>{one}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {understanding.assumptions.length > 0 ? (
        <div>
          <p className="rs-item-meta">Assumptions</p>
          <ul className="rs-list">
            {understanding.assumptions.map((one, index) => (
              <li key={index}>{one}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {understanding.searchableProperties.length > 0 ? (
        <div className="rs-at-interested">
          <p className="rs-item-meta">Properties search may generalise over</p>
          <ul className="rs-list">
            {understanding.searchableProperties.map((one, index) => (
              <li key={index}>{one}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {understanding.unexplainedExamples.length > 0 ? (
        <div className="rs-at-interested">
          <p className="rs-item-meta">
            Examples that named no property Brain could generalise from — not a whitelist
          </p>
          <ul className="rs-list">
            {understanding.unexplainedExamples.map((one, index) => (
              <li key={index}>{one}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="rs-ref rs-at-technical">
        version {understanding.version} · derived from {understanding.derivedFrom}
      </p>
    </section>
  );
}

function QuestionGroup({
  title,
  questions,
}: {
  title: string;
  questions: QuestionView[];
}): JSX.Element | null {
  if (questions.length === 0) return null;
  return (
    <section className="rs-group">
      <h4 className="rs-group-title">
        {title}
        <span className="rs-count">{questions.length}</span>
      </h4>
      <ul className="rs-list">
        {questions.map((question) => (
          <li key={question.key}>
            <Question question={question} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Question({ question }: { question: QuestionView }): JSX.Element {
  return (
    <article className="rs-card">
      <div className="rs-row">
        <span className="rs-item-title">{question.question}</span>
        <span className="rs-pill">{question.disposition}</span>
        {question.couldInvalidateEverything ? (
          <span className="rs-pill rs-pill-watch">Could invalidate everything</span>
        ) : null}
      </div>
      <p className="rs-item-meta">{question.whyItMatters}</p>
      {question.reason ? <p className="rs-item-meta">{question.reason}</p> : null}
      <p className="rs-item-meta">Belief: {beliefText(question)}</p>
      <p className="rs-ref rs-at-technical">
        depth {question.depth}
        {question.depthBasis ? ` (${question.depthBasis})` : ''} · origin {question.origin} ·{' '}
        {question.key}
      </p>
    </article>
  );
}

function Sufficiency({
  sufficiency,
}: {
  sufficiency: ResearchIntelligenceView['sufficiency'];
}): JSX.Element {
  return (
    <section className="rs-group">
      <h4 className="rs-group-title">Sufficiency</h4>
      <div className="rs-row">
        <span className="rs-pill">{sufficiency.verdict}</span>
      </div>
      <p className="rs-item-meta">{sufficiency.detail}</p>
      <p className="rs-item-meta rs-at-interested">
        {sufficiency.decisive.settled} of {sufficiency.decisive.total} decisive question(s)
        settled · {sufficiency.mandatory.covered} of {sufficiency.mandatory.total} mandatory
        requirement(s) covered
      </p>
      {sufficiency.blockers.length > 0 ? (
        <ul className="rs-list">
          {sufficiency.blockers.map((blocker, index) => (
            <li key={index} className="rs-item-meta">
              {blocker}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
