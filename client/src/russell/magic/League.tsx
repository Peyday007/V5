/** League and Matchups: the saved workspace of the same engine. */
import { useState } from 'react';
import {
  MagicApi,
  formatCents,
  type LeagueDetail,
  type LeaguePlayerView,
} from '../../lib/magicApi.ts';
import { useAsync } from '../useAsync.ts';
import { ErrorLine, Gate, Num, errorText } from './shared.tsx';

function PlayerCard({ player }: { player: LeaguePlayerView }): JSX.Element {
  const deck = player.deck;
  return (
    <li className="rs-magic-player">
      <strong>
        {player.ordinal}. {player.label}
      </strong>{' '}
      <span className="rs-meta">
        {player.isOwner ? 'your deck' : player.status === 'PROVISIONAL' ? 'provisional' : 'confirmed'}
        {' · '}
        {deck?.cardListStatus === 'VERIFIED' ? 'verified card list' : 'unverified cardlist'}
      </span>
      <div>
        Commander: {deck?.commander ?? 'UNKNOWN'} · Product: {deck?.product ?? 'UNKNOWN'}
      </div>
      {deck?.sourceCitation ? (
        <div className="rs-meta">
          Source: {deck.sourceCitation}
          {deck.sourceDate ? ` (${deck.sourceDate})` : ''}
        </div>
      ) : null}
      {player.unknowns.length > 0 ? <div className="rs-meta">Unknown: {player.unknowns.join('; ')}</div> : null}
      {player.notes ? <div className="rs-meta">{player.notes}</div> : null}
    </li>
  );
}

function RuleEditor({ league, onSaved }: { league: LeagueDetail; onSaved: () => void }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <section className="rs-card" aria-label="League rules">
      <h3>Rules</h3>
      <p className="rs-meta">Pod size {league.podSize}, starting life {league.startingLife}. Anything not confirmed is editable.</p>
      <ul>
        {league.rules.map((rule) => (
          <li key={rule.ruleKey}>
            <label>
              {rule.ruleKey} — {rule.status.toLowerCase()}
              <input
                value={drafts[rule.ruleKey] ?? rule.value}
                onChange={(e) => setDrafts({ ...drafts, [rule.ruleKey]: e.target.value })}
              />
            </label>
            {rule.note ? <span className="rs-meta"> {rule.note}</span> : null}{' '}
            <button
              type="button"
              disabled={drafts[rule.ruleKey] === undefined || drafts[rule.ruleKey] === rule.value}
              onClick={() =>
                MagicApi.updateRule(league.id, rule.ruleKey, drafts[rule.ruleKey] ?? rule.value).then(
                  () => {
                    setDrafts({ ...drafts, [rule.ruleKey]: undefined as unknown as string });
                    onSaved();
                  },
                  (cause: unknown) => setError(errorText(cause)),
                )
              }
            >
              Save
            </button>
          </li>
        ))}
      </ul>
      <ErrorLine message={error} />
    </section>
  );
}

function GameForm({ league, onSaved }: { league: LeagueDetail; onSaved: () => void }): JSX.Element {
  const [playedOn, setPlayedOn] = useState('');
  const [outcome, setOutcome] = useState('');
  const [turns, setTurns] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="rs-card" aria-label="Log a game">
      <h3>Log a game</h3>
      <label>
        Date
        <input type="date" value={playedOn} onChange={(e) => setPlayedOn(e.target.value)} />
      </label>
      <label>
        Outcome
        <input value={outcome} onChange={(e) => setOutcome(e.target.value)} />
      </label>
      <label>
        Turns
        <input inputMode="numeric" value={turns} onChange={(e) => setTurns(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={!playedOn || !outcome.trim()}
        onClick={() =>
          MagicApi.logGame(league.id, {
            playedOn,
            outcome,
            turns: turns.trim() === '' ? null : Number.parseInt(turns, 10) || null,
            notes,
          }).then(
            () => {
              setOutcome('');
              setNotes('');
              onSaved();
            },
            (cause: unknown) => setError(errorText(cause)),
          )
        }
      >
        Save game
      </button>
      <ErrorLine message={error} />
    </section>
  );
}

function ObservationForm({ league, onSaved }: { league: LeagueDetail; onSaved: () => void }): JSX.Element {
  const [playerId, setPlayerId] = useState('');
  const [kind, setKind] = useState('REVEALED_CARD');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="rs-card" aria-label="Record an observation">
      <h3>Record what you saw</h3>
      <p className="rs-meta">Observations update the opponent's version; earlier versions are kept. Nothing here is a purchase unless you saw one.</p>
      <label>
        Player
        <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
          <option value="">Whole pod</option>
          {league.players.filter((p) => !p.isOwner).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="REVEALED_CARD">Revealed card</option>
          <option value="COMMANDER">Commander</option>
          <option value="PURCHASE">Purchase</option>
          <option value="RESULT">Result</option>
          <option value="NOTE">Note</option>
        </select>
      </label>
      <label>
        What you observed
        <textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={!detail.trim()}
        onClick={() =>
          MagicApi.addObservation(league.id, {
            playerId: playerId || null,
            kind,
            detail,
            label: 'OBSERVED',
          }).then(
            () => {
              setDetail('');
              onSaved();
            },
            (cause: unknown) => setError(errorText(cause)),
          )
        }
      >
        Save observation
      </button>
      <ErrorLine message={error} />
    </section>
  );
}

function useLeague() {
  return useAsync<LeagueDetail | null>(async () => {
    const { leagues } = await MagicApi.leagues();
    const first = leagues[0];
    return first ? await MagicApi.league(first.id) : null;
  }, []);
}

export function LeagueSection(): JSX.Element {
  const query = useLeague();
  return (
    <Gate query={query} what="the league">
      {(league) =>
        league === null ? (
          <p className="rs-empty">The league workspace is not available yet. Reload to seed it.</p>
        ) : (
          <div className="rs-stack">
            <section className="rs-card">
              <h3>{league.name}</h3>
              <ul className="rs-magic-players">
                {league.players.map((p) => (
                  <PlayerCard key={p.id} player={p} />
                ))}
              </ul>
            </section>
            <RuleEditor league={league} onSaved={query.reload} />
            <section className="rs-card" aria-label="Weekly ledger">
              <h3>Weekly ledger</h3>
              <p className="rs-meta">Only verified adds and cuts appear here. A suggestion is not a purchase.</p>
              {league.ledger.length === 0 ? (
                <p className="rs-empty">No verified changes recorded.</p>
              ) : (
                <ul>
                  {league.ledger.map((l) => (
                    <li key={l.id}>
                      {l.weekStart}: +{l.cardIn} / −{l.cardOut} — {formatCents(l.valueCents)}
                      {l.priceStatus === 'ESTIMATE' ? ' (estimate)' : ' (confirmed)'}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <ObservationForm league={league} onSaved={query.reload} />
            <GameForm league={league} onSaved={query.reload} />
            <section className="rs-card" aria-label="Games">
              <h3>Games</h3>
              {league.games.length === 0 ? (
                <p className="rs-empty">No games logged yet.</p>
              ) : (
                <ul>
                  {league.games.map((g) => (
                    <li key={g.id}>
                      {g.playedOn}: {g.outcome}
                      {g.turns !== null ? `, ${g.turns} turns` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )
      }
    </Gate>
  );
}

export function MatchupsSection(): JSX.Element {
  const query = useAsync(async () => {
    const { leagues } = await MagicApi.leagues();
    const first = leagues[0];
    return first ? await MagicApi.matchups(first.id) : null;
  }, []);
  return (
    <section className="rs-card">
      <h3>Matchups</h3>
      <p className="rs-meta">The target is expected league points per game, not raw win rate.</p>
      <Gate query={query} what="matchups">
        {(view) =>
          view === null ? (
            <p className="rs-empty">No league to read matchups from.</p>
          ) : (
            <>
              {view.rows.length === 0 ? (
                <p className="rs-empty">No games logged, so there are no empirical results yet.</p>
              ) : (
                <table className="rs-table">
                  <thead>
                    <tr>
                      <th>Opponent</th>
                      <th>Games</th>
                      <th>Expected points / game</th>
                      <th>Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.rows.map((r) => (
                      <tr key={r.opponentLabel}>
                        <td>{r.opponentLabel}</td>
                        <td>{r.games}</td>
                        <td>{r.expectedPoints ? <Num n={r.expectedPoints} as="plain" /> : '—'}</td>
                        <td>{r.winRate ? <Num n={r.winRate} /> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {view.hypotheses.length > 0 ? (
                <div>
                  <h4>Hypotheses — not confirmed purchases</h4>
                  <ul>
                    {view.hypotheses.map((h) => (
                      <li key={`${h.playerId}-${h.text}`}>
                        {h.text} (confidence {Math.round(h.confidence * 100)}%, hypothesis)
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )
        }
      </Gate>
    </section>
  );
}
