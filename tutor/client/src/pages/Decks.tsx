import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { navigate } from '../App.tsx';

export function DecksPage() {
  const [decks, setDecks] = useState<any[] | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [matches, setMatches] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.decks().then(setDecks).catch((e) => setErr(e.message));
    api.status().then(setStatus).catch(() => undefined);
    api.matches().then(setMatches).catch(() => undefined);
  }, []);
  return (
    <div className="page">
      <section className="hero">
        <h1>My decks</h1>
        <p>Import the deck you own, learn how it works, then practice it against Forge's AI with a tutor beside you.</p>
        <div className="row">
          <button className="primary" onClick={() => navigate('/import')}>Import a deck</button>
          <button onClick={() => navigate('/import?sample=hail-caesar')}>Try the Hail, Caesar sample</button>
        </div>
      </section>
      {status && !status.engine.reachable && <p className="warn">The Forge rules engine is not running. Decks can be imported and studied; practice needs it. {status.engine.setup}</p>}
      {status && status.catalog.cards === 0 && <p className="warn">The card catalog is empty. Run <code>npm run cards:sync</code> on the server.</p>}
      {err && <p className="error">{err}</p>}
      {decks === null && !err && <p className="muted">Loading…</p>}
      {decks && decks.length === 0 && <p className="muted">No saved decks yet.</p>}
      <div className="deck-grid">
        {decks?.map((d) => (
          <a key={d.id} className="deck-card" href={`#/decks/${d.id}`}>
            {d.commander[0]?.image ? <img src={d.commander[0].image} alt="" /> : <div className="card-ph">{d.commander[0]?.name ?? 'No commander'}</div>}
            <div>
              <strong>{d.name}</strong>
              <span className="muted">{d.commander.map((c: any) => c.name).join(' & ') || 'Commander not confirmed'} · {d.cards} cards</span>
              {d.unresolved > 0 && <span className="badge warnbadge">{d.unresolved} line(s) need you</span>}
            </div>
          </a>
        ))}
      </div>
      {matches.length > 0 && (
        <section>
          <h2>Recent practice</h2>
          <ul className="plain">
            {matches.slice(0, 8).map((m) => {
              const o = m.outcome ? JSON.parse(m.outcome) : null;
              return (
                <li key={m.id}>
                  <a href={m.endedAt ? `#/review/${m.id}` : `#/play/${m.id}`}>{m.deckName ?? 'Deck'} — {m.mode.replace('commander-', 'Commander ').replace('p', ' players')}</a>
                  <span className="muted"> {new Date(m.createdAt).toLocaleString()} {m.endedAt ? (o?.humanWon ? '· won' : '· finished') : '· in progress'}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
