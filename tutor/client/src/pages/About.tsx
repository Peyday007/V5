import { useEffect, useState } from 'react';
import { api } from '../api.ts';

/** What this tutor is running on, honestly: engine, card catalog, rules version, coach, attribution. */
export function AboutPage() {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.status().then(setS).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="page"><p className="error">{err}</p></div>;
  if (!s) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className="page narrow">
      <h1>About this tutor</h1>
      <section className="panel">
        <h2>Sources in use</h2>
        <dl className="stats">
          <dt>Rules engine</dt>
          <dd>{s.engine.reachable ? `Forge ${s.engine.version} · revision ${s.engine.revision} · ${s.engine.cards} cards` : <span className="error">Not reachable. {s.engine.setup}</span>}</dd>
          <dt>Card catalog</dt>
          <dd>{s.catalog.cards ? `${s.catalog.cards} Oracle cards from Scryfall, updated ${s.catalog.updatedAt}` : 'Not loaded — run npm run cards:sync'}</dd>
          <dt>Comprehensive Rules</dt>
          <dd>{s.rules.rules ? <>{s.rules.effective} · {s.rules.rules} rules, {s.rules.glossary} glossary entries · <a href={s.rules.url} target="_blank" rel="noreferrer">source</a></> : 'Not loaded — run npm run cards:sync'}</dd>
          <dt>Formats</dt>
          <dd>{s.games.map((g: any) => `${g.label}: ${g.formats.map((f: any) => f.label).join(', ')}`).join(' · ')}</dd>
          <dt>Coach</dt>
          <dd>{s.coach.configured ? s.coach.model : 'Not configured'} — {s.coach.note}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Attribution</h2>
        <ul>{s.attribution.map((a: string) => <li key={a}>{a}</li>)}</ul>
      </section>
    </div>
  );
}
