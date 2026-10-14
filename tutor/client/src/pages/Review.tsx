import { useEffect, useState } from 'react';
import { api } from '../api.ts';

/** After a match: a few meaningful decisions, illegal attempts kept apart from judgment calls, and one next lesson. */
export function ReviewPage({ matchId }: { matchId: string }) {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.review(matchId).then(setR).catch((e) => setErr(e.message)); }, [matchId]);
  if (err) return <div className="page"><p className="error">{err}</p></div>;
  if (!r) return <div className="page"><p className="muted">Building the review…</p></div>;
  const kindLabel: Record<string, string> = { 'illegal-attempt': 'Not legal', debatable: 'Judgment call', good: 'Went well' };
  return (
    <div className="page narrow">
      <h1>Game review</h1>
      {r.outcome ? (
        <p className="lead">{r.outcome.humanWon ? 'You won' : r.outcome.winner ? `${r.outcome.winner} won` : 'The game ended'}{r.outcome.turns ? ` on turn ${r.outcome.turns}` : ''}.</p>
      ) : <p className="muted">This game has not finished; the review covers what has happened so far.</p>}
      <section className="panel">
        <h2>Decisions worth a look</h2>
        {r.items.length === 0 && <p className="muted">Nothing stood out — no refused actions and no obviously idle main phases.</p>}
        <ul className="review-items">
          {r.items.map((i: any, n: number) => (
            <li key={n} className={`ri ${i.kind}`}>
              <span className="tag">{kindLabel[i.kind] ?? i.kind}</span>
              <strong>{i.title}</strong>{i.turn ? <span className="muted"> · turn {i.turn}</span> : null}
              <p>{i.detail}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel lesson">
        <h2>Your next lesson</h2>
        <p><strong>{r.lesson.title}</strong></p>
        <p>{r.lesson.why}</p>
        {r.lesson.cards.length > 0 && <div className="chips">{r.lesson.cards.map((c: string) => <span key={c} className="chip">{c}</span>)}</div>}
      </section>
      <section className="panel">
        <h2>By the numbers</h2>
        <dl className="stats">
          <dt>Actions</dt><dd>{r.stats.actions}</dd>
          <dt>Refused attempts</dt><dd>{r.stats.illegalAttempts}</dd>
          <dt>Main phases passed with castable spells</dt><dd>{r.stats.debatablePasses}</dd>
          <dt>Tutor questions</dt><dd>{r.stats.tutorQuestions}</dd>
          <dt>Recommendations followed</dt><dd>{r.stats.recommendationsFollowed} of {r.stats.recommendationsGiven}</dd>
        </dl>
        <p className="muted small">{r.note}</p>
      </section>
      <div className="row wrap"><a className="button" href="#/learning">See what to revisit</a><a className="button" href="#/">My decks</a></div>
    </div>
  );
}
