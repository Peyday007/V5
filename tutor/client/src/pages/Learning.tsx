import { useEffect, useState } from 'react';
import { api } from '../api.ts';

/** The lightweight learning profile: concepts practised, recurring misunderstandings, what to revisit. */
export function LearningPage() {
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.learning().then(setP).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="page"><p className="error">{err}</p></div>;
  if (!p) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className="page narrow">
      <h1>What you're learning</h1>
      <section className="panel">
        <h2>Revisit</h2>
        {p.revisit.length === 0 ? <p className="muted">Nothing flagged yet. Refused actions in a game are recorded here.</p> : <div className="chips">{p.revisit.map((r: string) => <span key={r} className="chip warn-chip">{r}</span>)}</div>}
      </section>
      <section className="panel">
        <h2>Concepts practised</h2>
        {p.concepts.length === 0 ? <p className="muted">Play a practice game and this fills in.</p> : (
          <table className="concepts">
            <thead><tr><th>Concept</th><th>Practised</th><th>Misunderstood</th><th>Last note</th></tr></thead>
            <tbody>{p.concepts.map((c: any) => (
              <tr key={c.concept}><td>{c.label}</td><td>{c.practiced}</td><td>{c.misunderstood}</td><td className="small">{c.lastNote ?? ''}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {p.notYetPracticed.length > 0 && (
        <section className="panel">
          <h2>Not practised yet</h2>
          <div className="chips">{p.notYetPracticed.map((c: string) => <span key={c} className="chip">{c}</span>)}</div>
        </section>
      )}
    </div>
  );
}
