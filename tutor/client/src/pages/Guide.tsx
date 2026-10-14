import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { navigate } from '../App.tsx';
import { CardModal } from '../components/CardModal.tsx';

/** The orientation for one deck, built from its own cards, and the way into practice. */
export function GuidePage({ deckId }: { deckId: string }) {
  const [deck, setDeck] = useState<any>(null);
  const [guide, setGuide] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [opponents, setOpponents] = useState(1);
  const [coachMode, setCoachMode] = useState('teach');
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    api.deck(deckId).then(setDeck).catch((e) => setErr(e.message));
    api.guide(deckId).then(setGuide).catch((e) => setErr(e.message));
  }, [deckId]);

  const start = async () => {
    setStarting(true); setErr(null);
    try {
      const m = await api.startMatch({ deckId, opponents, coachMode });
      navigate(`/play/${m.id}`);
    } catch (e: any) { setErr(e.message); setStarting(false); }
  };

  if (err && !deck) return <div className="page"><p className="error">{err}</p></div>;
  if (!deck || !guide) return <div className="page"><p className="muted">Loading deck…</p></div>;
  const report = deck.report;
  const blocking = report.issues.filter((i: any) => i.blocking);
  const roleNames = ['all', ...guide.roles.map((r: any) => r.label)];
  const shown = guide.cards.filter((c: any) => filter === 'all' || c.roles.some((r: string) => guide.roles.find((x: any) => x.role === r)?.label === filter));

  return (
    <div className="page">
      <div className="guide-head">
        {guide.commander?.image && <img className="cmd-img" src={guide.commander.image} alt={guide.commander.name} onClick={() => setCard(deck.deck.commanderIds[0])} />}
        <div>
          <h1>{deck.stored.name}</h1>
          <p className="muted">Commander · {report.counts.total} cards · {guide.mana.lands} lands</p>
          <div className="row wrap">
            <a className="button" href={`#/decks/${deckId}/edit`}>Edit / re-import</a>
            <button className="danger" onClick={async () => { if (confirm('Delete this saved deck?')) { await api.deleteDeck(deckId); navigate('/'); } }}>Delete</button>
          </div>
        </div>
      </div>

      <section className="panel practice">
        <h2>Practice this deck</h2>
        {blocking.length > 0 ? (
          <div className="warn">
            <p>An accurate match can't start yet:</p>
            <ul>{blocking.map((i: any, n: number) => <li key={n}>{i.message} <em>{i.correction}</em></li>)}</ul>
            <a className="button" href={`#/decks/${deckId}/edit`}>Resolve these</a>
          </div>
        ) : (
          <>
            <div className="row wrap">
              <label>Opponents
                <select value={opponents} onChange={(e) => setOpponents(Number(e.target.value))}>
                  <option value={1}>1 AI — two-player Commander practice (Commander rules, not Duel Commander)</option>
                  <option value={3}>3 AI — four-player Commander</option>
                </select>
              </label>
              <label>Coach
                <select value={coachMode} onChange={(e) => setCoachMode(e.target.value)}>
                  <option value="teach">Teach me — explain new decisions as they come up</option>
                  <option value="hints">Hints — explain only when I ask</option>
                  <option value="practice">Practice — stay quiet, review afterwards</option>
                </select>
              </label>
              <button className="primary" disabled={starting} onClick={start}>{starting ? 'Starting Forge match…' : 'Start practice'}</button>
            </div>
            <p className="muted small">Opponents play the other Fallout Commander precons with Forge's AI. Rules engine: Forge {report.engine.revision?.slice(0, 10)}.</p>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </section>

      <div className="guide-grid">
        <section className="panel">
          <h2>Game plan</h2>
          <ul>{guide.plan.map((p: string) => <li key={p}>{p}</li>)}</ul>
          <h3>How it wins</h3>
          <ul>{guide.winConditions.map((p: string) => <li key={p}>{p}</li>)}</ul>
        </section>
        {guide.commander && (
          <section className="panel">
            <h2>What {guide.commander.name} does</h2>
            <p className="oracle">{guide.commander.text}</p>
            <ul>{guide.commander.explanation.map((p: string) => <li key={p}>{p}</li>)}</ul>
          </section>
        )}
        <section className="panel">
          <h2>Opening hand and mulligans</h2>
          <ul>{guide.mulligan.map((p: string) => <li key={p}>{p}</li>)}</ul>
          <div className="curve" aria-label="Mana curve">
            {guide.curve.map((c: any) => (
              <div key={c.cmc} className="bar"><span style={{ height: `${Math.min(100, c.count * 6)}%` }} /><em>{c.count}</em><b>{c.cmc}</b></div>
            ))}
          </div>
          <p className="muted small">Mana curve of nonland cards (mana value).</p>
        </section>
        <section className="panel">
          <h2>Cards that work together</h2>
          <ul>{guide.interactions.map((i: any) => (
            <li key={i.how}>{i.how}<div className="chips">{i.cards.map((c: string) => <button key={c} className="chip" onClick={() => setCard(c)}>{c}</button>)}</div></li>
          ))}</ul>
        </section>
        <section className="panel">
          <h2>Key cards</h2>
          <div className="mini-grid">{guide.keyCards.map((c: any) => (
            <button key={c.id} className="mini-card" onClick={() => setCard(c.id)}>
              {c.image ? <img src={c.image} alt={c.name} loading="lazy" /> : <span>{c.name}</span>}
            </button>
          ))}</div>
        </section>
        <section className="panel">
          <h2>Keywords and mechanics in this deck</h2>
          {guide.keywords.map((k: any) => (
            <details key={k.keyword}>
              <summary><strong>{k.keyword}</strong> <span className="muted">· {k.count} card(s)</span></summary>
              {k.rule && <p className="rule"><span>{k.rule.number}</span> {k.rule.text}</p>}
              <div className="chips">{k.cards.map((c: string) => <button key={c} className="chip" onClick={() => setCard(c)}>{c}</button>)}</div>
            </details>
          ))}
        </section>
      </div>

      <section className="panel">
        <h2>All {report.counts.total} cards</h2>
        <div className="row wrap">{roleNames.map((r) => <button key={r} className={filter === r ? 'on chip' : 'chip'} onClick={() => setFilter(r)}>{r === 'all' ? 'All' : r}</button>)}</div>
        <div className="card-grid">
          {shown.map((c: any) => (
            <button key={c.id} className="tile" onClick={() => setCard(c.id)} title={c.name}>
              {c.image ? <img src={c.image} alt={c.name} loading="lazy" /> : <span className="card-ph">{c.name}</span>}
              {c.quantity > 1 && <span className="qty-badge">×{c.quantity}</span>}
            </button>
          ))}
        </div>
        <p className="muted small">{guide.sources.join(' · ')}</p>
      </section>
      {card && <CardModal cardRef={card} deckId={deckId} onClose={() => setCard(null)} />}
    </div>
  );
}
