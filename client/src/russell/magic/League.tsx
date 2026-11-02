/**
 * League and Matchups: the saved workspace of the same engine.
 *
 * Every opponent deck is a chain of versions: the baseline is never rewritten,
 * and an observed commander or revealed card is a new version on top of it.
 * Unknowns stay UNKNOWN. A suggestion for the next $10 is never a purchase.
 */
import { useState } from 'react';
import {
  MagicApi,
  formatCents,
  type EliminationAttribution,
  type GameInput,
  type LeagueDeckView,
  type LeagueDetail,
  type NextTenResponse,
  type ObservationKind,
  type PlayerView,
  type RuleView,
} from '../../lib/magicApi.ts';
import { useAsync } from '../useAsync.ts';
import { ErrorLine, Gate, Num, errorText } from './shared.tsx';

const today = (): string => new Date().toISOString().slice(0, 10);

function text(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function DeckVersionLine({ v }: { v: LeagueDeckView }): JSX.Element {
  const listLabel = typeof v.detail.listLabel === 'string' ? v.detail.listLabel : null;
  const prior = typeof v.detail.priorCommander === 'string' ? v.detail.priorCommander : null;
  const revealed = Array.isArray(v.detail.revealed) ? (v.detail.revealed as string[]) : [];
  return (
    <li>
      v{v.versionNumber}
      {v.isBaseline ? ' (baseline)' : ''}: commander {v.commander ?? 'UNKNOWN'} · product {v.product ?? 'UNKNOWN'} ·{' '}
      <span data-status={v.cardListStatus}>
        {v.cardListStatus === 'VERIFIED' ? 'verified card list' : v.cardListStatus === 'HYPOTHESIS' ? 'hypothesis' : 'unverified cardlist'}
      </span>
      {listLabel ? ` (${listLabel})` : ''}
      {prior ? <span className="rs-meta"> · printed commander: {prior}</span> : null}
      {v.detail.needsRevalidation === true ? <span className="rs-meta"> · needs revalidation</span> : null}
      {revealed.length ? <span className="rs-meta"> · revealed: {revealed.join(', ')}</span> : null}
      {v.sourceCitation ? (
        <div className="rs-meta">
          Source: {v.sourceCitation}
          {v.sourceDate ? ` (${v.sourceDate})` : ''}
        </div>
      ) : null}
      {v.observedAt ? <span className="rs-meta"> · observed {v.observedAt}</span> : null}
    </li>
  );
}

function PlayerCard({ player, versions }: { player: PlayerView; versions: LeagueDeckView[] }): JSX.Element {
  return (
    <li className="rs-magic-player" aria-label={player.label}>
      <strong>
        {player.ordinal}. {player.label}
      </strong>{' '}
      <span className="rs-meta">
        {player.isOwner ? 'your deck' : player.status === 'PROVISIONAL' ? 'provisional' : 'confirmed'}
      </span>
      {versions.length === 0 ? (
        <div>Commander: UNKNOWN · no deck recorded</div>
      ) : (
        <ol className="rs-magic-versions">
          {versions.map((v) => (
            <DeckVersionLine key={v.id} v={v} />
          ))}
        </ol>
      )}
      {player.unknowns.length > 0 ? <div className="rs-meta">Unknown: {player.unknowns.join('; ')}</div> : null}
      {player.notes ? <div className="rs-meta">{player.notes}</div> : null}
    </li>
  );
}

/** A value edits as JSON when it is not a plain string, so a number stays a number. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function RuleRow({ leagueId, rule, onSaved }: { leagueId: string; rule: RuleView; onSaved: () => void }): JSX.Element {
  const [value, setValue] = useState(text(rule.value));
  const [status, setStatus] = useState<RuleView['status']>(rule.status);
  const [error, setError] = useState<string | null>(null);
  const changed = value !== text(rule.value) || status !== rule.status;
  return (
    <li>
      <strong>{rule.ruleKey}</strong> — <span data-status={rule.status}>{rule.status}</span>
      {rule.note ? <span className="rs-meta"> {rule.note}</span> : null}
      <label>
        Value of {rule.ruleKey}
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label>
        Status of {rule.ruleKey}
        <select value={status} onChange={(e) => setStatus(e.target.value as RuleView['status'])}>
          <option value="CONFIRMED">CONFIRMED</option>
          <option value="PENDING">PENDING</option>
          <option value="ASSUMED">ASSUMED</option>
        </select>
      </label>
      <button
        type="button"
        disabled={!changed}
        onClick={() => {
          setError(null);
          MagicApi.setRule(leagueId, rule.ruleKey, { value: parseValue(value), status, note: rule.note }).then(
            onSaved,
            (cause: unknown) => setError(errorText(cause)),
          );
        }}
      >
        Save {rule.ruleKey}
      </button>
      <ErrorLine message={error} />
    </li>
  );
}

function RuleEditor({ detail, onSaved }: { detail: LeagueDetail; onSaved: () => void }): JSX.Element {
  return (
    <section className="rs-card" aria-label="League rules">
      <h3>Rules</h3>
      <p className="rs-meta">
        Pod size {detail.league.pod_size}, starting life {detail.league.starting_life}. A PENDING or ASSUMED rule is not
        confirmed; edit it when it is.
      </p>
      <ul>
        {detail.rules.map((rule) => (
          <RuleRow key={`${rule.ruleKey}-${rule.updatedAt}`} leagueId={detail.league.id} rule={rule} onSaved={onSaved} />
        ))}
      </ul>
    </section>
  );
}

const DETAIL_FIELD: Record<ObservationKind, { key: string; label: string }> = {
  REVEALED_CARD: { key: 'card', label: 'Card revealed' },
  COMMANDER: { key: 'commander', label: 'Commander seen' },
  PURCHASE: { key: 'card', label: 'What they bought' },
  RESULT: { key: 'text', label: 'Result' },
  NOTE: { key: 'text', label: 'Note' },
};

function ObservationForm({ detail, onSaved }: { detail: LeagueDetail; onSaved: () => void }): JSX.Element {
  const [playerId, setPlayerId] = useState('');
  const [kind, setKind] = useState<ObservationKind>('REVEALED_CARD');
  const [label, setLabel] = useState<'OBSERVED' | 'HYPOTHESIS'>('OBSERVED');
  const [value, setValue] = useState('');
  const [observedOn, setObservedOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const field = DETAIL_FIELD[kind];
  return (
    <section className="rs-card" aria-label="Record an observation">
      <h3>Record what you saw</h3>
      <p className="rs-meta">
        An observed commander or revealed card adds a version to that opponent’s deck; earlier versions are kept. A hypothesis
        is recorded and versions nothing. Nothing here is a purchase unless you saw one.
      </p>
      <label>
        Player
        <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
          <option value="">Whole pod</option>
          {detail.players
            .filter((p) => !p.isOwner)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as ObservationKind)}>
          <option value="REVEALED_CARD">Revealed card</option>
          <option value="COMMANDER">Commander</option>
          <option value="PURCHASE">Purchase</option>
          <option value="RESULT">Result</option>
          <option value="NOTE">Note</option>
        </select>
      </label>
      <label>
        Certainty
        <select value={label} onChange={(e) => setLabel(e.target.value as 'OBSERVED' | 'HYPOTHESIS')}>
          <option value="OBSERVED">Observed</option>
          <option value="HYPOTHESIS">Hypothesis</option>
        </select>
      </label>
      <label>
        {field.label}
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label>
        Observed on
        <input type="date" value={observedOn} onChange={(e) => setObservedOn(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={!value.trim() || !observedOn}
        onClick={() => {
          setError(null);
          setSaved(null);
          MagicApi.addObservation(detail.league.id, {
            playerId: playerId || null,
            kind,
            label,
            detail: { [field.key]: value.trim() },
            observedOn,
          }).then(
            (out) => {
              setValue('');
              setSaved(
                out.version
                  ? `Recorded. ${detail.players.find((p) => p.id === out.version?.playerId)?.label ?? 'That deck'} is now on version ${out.version.versionNumber}.`
                  : 'Recorded. No deck version changed.',
              );
              onSaved();
            },
            (cause: unknown) => setError(errorText(cause)),
          );
        }}
      >
        Save observation
      </button>
      {saved ? <p role="status">{saved}</p> : null}
      <ErrorLine message={error} />
    </section>
  );
}

const ATTRIBUTIONS: { value: EliminationAttribution; text: string }[] = [
  { value: 'OWN_SOURCE', text: 'Their own source' },
  { value: 'FORCED_ATTACK', text: 'Forced (goaded) attack' },
  { value: 'HOUSE_RULE', text: 'House rule' },
  { value: 'UNASSIGNED', text: 'Unassigned' },
];

interface ElimDraft {
  eliminated: string;
  credited: string;
  cause: string;
  attribution: EliminationAttribution;
  points: string;
}

function GameForm({ detail, onSaved }: { detail: LeagueDetail; onSaved: () => void }): JSX.Element {
  const [playedOn, setPlayedOn] = useState(today());
  const [participants, setParticipants] = useState<string[]>([]);
  const [outcome, setOutcome] = useState('');
  const [turns, setTurns] = useState('');
  const [notes, setNotes] = useState('');
  const [elims, setElims] = useState<ElimDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const label = (id: string): string => detail.players.find((p) => p.id === id)?.label ?? id;
  const toggle = (id: string): void =>
    setParticipants((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const patch = (i: number, change: Partial<ElimDraft>): void =>
    setElims((cur) => cur.map((e, j) => (j === i ? { ...e, ...change } : e)));
  const elimsValid = elims.every((e) => e.eliminated && Number.isInteger(Number(e.points)));
  const submit = (): void => {
    setError(null);
    setSaved(null);
    const input: GameInput = {
      playedOn,
      turns: turns.trim() === '' ? null : Number.parseInt(turns, 10) || null,
      outcome,
      notes,
      participants: participants.map((playerId, seat) => ({ playerId, seat })),
      eliminations: elims.map((e, orderIndex) => ({
        eliminatedPlayerId: e.eliminated,
        orderIndex,
        causeSource: e.cause,
        creditedPlayerId: e.credited || null,
        sourceControllerPlayerId: e.credited || null,
        points: Number(e.points),
        attribution: e.attribution,
      })),
    };
    MagicApi.logGame(detail.league.id, input).then(
      () => {
        setSaved('Game saved.');
        setOutcome('');
        setNotes('');
        setTurns('');
        setElims([]);
        setParticipants([]);
        onSaved();
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  };
  return (
    <section className="rs-card" aria-label="Log a game">
      <h3>Log a game</h3>
      <label>
        Date played
        <input type="date" value={playedOn} onChange={(e) => setPlayedOn(e.target.value)} />
      </label>
      <fieldset>
        <legend>Who played</legend>
        {detail.players.map((p) => (
          <label key={p.id}>
            <input type="checkbox" checked={participants.includes(p.id)} onChange={() => toggle(p.id)} /> {p.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Eliminations, in order</legend>
        {elims.length === 0 ? <p className="rs-meta">None added yet.</p> : null}
        {elims.map((e, i) => (
          <div key={i} className="rs-magic-elim">
            <label>
              Elimination {i + 1}: who was eliminated
              <select value={e.eliminated} onChange={(ev) => patch(i, { eliminated: ev.target.value })}>
                <option value="">Choose…</option>
                {participants.map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Elimination {i + 1}: credited to
              <select value={e.credited} onChange={(ev) => patch(i, { credited: ev.target.value })}>
                <option value="">Nobody</option>
                {participants.map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Elimination {i + 1}: cause
              <input value={e.cause} onChange={(ev) => patch(i, { cause: ev.target.value })} />
            </label>
            <label>
              Elimination {i + 1}: attribution
              <select
                value={e.attribution}
                onChange={(ev) => patch(i, { attribution: ev.target.value as EliminationAttribution })}
              >
                {ATTRIBUTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.text}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Elimination {i + 1}: points
              <input inputMode="numeric" value={e.points} onChange={(ev) => patch(i, { points: ev.target.value })} />
            </label>
            <button type="button" onClick={() => setElims((cur) => cur.filter((_, j) => j !== i))}>
              Remove elimination {i + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={participants.length < 2}
          onClick={() =>
            setElims((cur) => [
              ...cur,
              { eliminated: '', credited: '', cause: '', attribution: 'OWN_SOURCE', points: cur.length >= 2 ? '2' : '1' },
            ])
          }
        >
          Add an elimination
        </button>
      </fieldset>
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
      <button type="button" disabled={!playedOn || participants.length < 2 || !elimsValid} onClick={submit}>
        Save game
      </button>
      {saved ? <p role="status">{saved}</p> : null}
      <ErrorLine message={error} />
    </section>
  );
}

function GamesPanel({ detail, nonce }: { detail: LeagueDetail; nonce: number }): JSX.Element {
  const query = useAsync(() => MagicApi.games(detail.league.id), [detail.league.id, nonce]);
  const label = (id: string | null): string => (id ? detail.players.find((p) => p.id === id)?.label ?? id : 'nobody');
  return (
    <section className="rs-card" aria-label="Games">
      <h3>Games and standings</h3>
      <Gate query={query} what="the games">
        {({ games, standings }) => (
          <>
            {standings.length === 0 ? (
              <p className="rs-empty">No games logged yet.</p>
            ) : (
              <table className="rs-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Points</th>
                    <th>Games</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((s) => (
                    <tr key={s.player}>
                      <td>{label(s.player)}</td>
                      <td>{s.points}</td>
                      <td>{s.games}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ul>
              {games.map((g) => (
                <li key={g.id}>
                  {g.playedOn}: {g.outcome || 'no outcome recorded'}
                  {g.turns !== null ? `, ${g.turns} turns` : ''} — {g.participants.map((p) => label(p.player_id)).join(', ')}
                  <ol>
                    {g.eliminations.map((e) => (
                      <li key={e.id}>
                        {label(e.eliminated_player_id)} eliminated by {e.cause_source || 'unstated cause'} ({e.attribution}) —{' '}
                        {Number(e.points)} point(s) to {label(e.credited_player_id)}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          </>
        )}
      </Gate>
    </section>
  );
}

function NextTenPanel({ leagueId }: { leagueId: string }): JSX.Element {
  const [result, setResult] = useState<NextTenResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="rs-card" aria-label="Next ten dollars">
      <h3>The next $10</h3>
      <p className="rs-meta">One-for-one swaps into your current league deck. Suggestions are not purchases.</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          MagicApi.nextTen(leagueId)
            .then(setResult, (cause: unknown) => setError(errorText(cause)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Evaluating…' : 'Evaluate next $10'}
      </button>
      <ErrorLine message={error} />
      {result ? (
        <div>
          <p className="rs-meta">
            Allowance {formatCents(result.allowanceCents)}. Current deck composite: <Num n={result.baseline} as="plain" />
          </p>
          <p role="note">{result.note}</p>
          {result.suggestions.length === 0 ? (
            <p className="rs-empty">No swap within the allowance improves the deck.</p>
          ) : (
            <ol>
              {result.suggestions.map((s) => (
                <li key={`${s.add}-${s.cut}`}>
                  Suggestion: +{s.add} / −{s.cut} · {formatCents(s.price.cents)}{' '}
                  <strong data-flag={s.priceFlag}>
                    {s.priceFlag === 'VERIFIED' ? 'verified price' : s.priceFlag === 'ESTIMATE' ? 'estimate price' : 'unpriced'}
                  </strong>
                  {s.printing ? ` (${s.printing.setCode.toUpperCase()} ${s.printing.collectorNumber})` : ''} · gain{' '}
                  <Num n={{ value: s.gain, label: 'HEURISTIC_SCORE' }} as="plain" />
                  {s.gainPerDollar !== null ? (
                    <>
                      {' '}
                      · per dollar <Num n={{ value: s.gainPerDollar, label: 'HEURISTIC_SCORE' }} as="plain" />
                    </>
                  ) : null}
                  <div className="rs-meta">
                    {s.approvable ? 'Approvable' : 'Not approvable'}: {s.reason}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}

function observationText(detailJson: string): string {
  try {
    const d = JSON.parse(detailJson) as Record<string, unknown>;
    return Object.values(d).map(text).join(', ');
  } catch {
    return detailJson;
  }
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
  const [nonce, setNonce] = useState(0);
  const changed = (): void => {
    query.reload();
    setNonce((n) => n + 1);
  };
  return (
    <Gate query={query} what="the league">
      {(detail) =>
        detail === null ? (
          <p className="rs-empty">The league workspace is not available yet. Reload to seed it.</p>
        ) : (
          <div className="rs-stack">
            <section className="rs-card" aria-label="League">
              <h3>{detail.league.name}</h3>
              <p className="rs-meta">
                Pod size {detail.league.pod_size} · starting life {detail.league.starting_life} · {detail.players.length} players
              </p>
              <ul className="rs-magic-players">
                {detail.players.map((p) => (
                  <PlayerCard key={p.id} player={p} versions={detail.decks[p.id] ?? []} />
                ))}
              </ul>
            </section>
            <RuleEditor detail={detail} onSaved={changed} />
            <NextTenPanel leagueId={detail.league.id} />
            <section className="rs-card" aria-label="Weekly ledger">
              <h3>Weekly ledger and purchases</h3>
              <p className="rs-meta">Only recorded adds, cuts and purchases appear here. A suggestion is not a purchase.</p>
              {detail.ledger.length === 0 ? (
                <p className="rs-empty">No weekly changes recorded.</p>
              ) : (
                <ul>
                  {detail.ledger.map((l) => (
                    <li key={l.id}>
                      Week of {l.week_start}: +{l.card_in || '—'} / −{l.card_out || '—'} — {formatCents(Number(l.value_cents))} (
                      {l.price_status === 'ESTIMATE' ? 'estimate' : 'confirmed'})
                    </li>
                  ))}
                </ul>
              )}
              {detail.purchases.length === 0 ? (
                <p className="rs-empty">No purchases recorded.</p>
              ) : (
                <ul>
                  {detail.purchases.map((p) => (
                    <li key={p.id}>
                      {p.purchased_on}: {p.description} — {formatCents(Number(p.cost_cents))} (
                      {p.price_status === 'ESTIMATE' ? 'estimate' : 'confirmed'})
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <ObservationForm detail={detail} onSaved={changed} />
            <section className="rs-card" aria-label="Observations">
              <h3>Observations</h3>
              {detail.observations.length === 0 ? (
                <p className="rs-empty">Nothing observed yet.</p>
              ) : (
                <ul>
                  {detail.observations.map((o) => (
                    <li key={o.id}>
                      {o.observed_on}: {o.player_id ? detail.players.find((p) => p.id === o.player_id)?.label ?? 'a player' : 'pod'}{' '}
                      — {o.kind} ({o.label}): {observationText(o.detail)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <GameForm detail={detail} onSaved={changed} />
            <GamesPanel detail={detail} nonce={nonce} />
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
    <section className="rs-card" aria-label="Matchups">
      <h3>Matchups</h3>
      <p className="rs-meta">The target is league points per game, not raw win rate.</p>
      <Gate query={query} what="matchups">
        {(view) =>
          view === null ? (
            <p className="rs-empty">No league to read matchups from.</p>
          ) : (
            <>
              <p>
                {view.owner.label} (commander {view.owner.commander ?? 'UNKNOWN'})
                {view.owner.unknownCards > 0 ? ` — ${view.owner.unknownCards} card(s) not in the catalog were not read` : ''}.
              </p>
              <ul>
                <li>
                  Goad in a pod: <strong>{view.owner.goadInPod.goad}</strong> — {view.owner.goadInPod.note}
                </li>
                <li>
                  Goad in 1v1: <strong>{view.owner.goadIn1v1.goad}</strong> — {view.owner.goadIn1v1.note}
                </li>
                <li>Own life loss: {view.owner.ownLifeLossTrigger}</li>
              </ul>
              <table className="rs-table">
                <thead>
                  <tr>
                    <th>Opponent</th>
                    <th>Commander</th>
                    <th>Card list</th>
                    <th>Attack-only defence stops them?</th>
                    <th>Record</th>
                  </tr>
                </thead>
                <tbody>
                  {view.opponents.map((o) => (
                    <tr key={o.playerId}>
                      <td>{o.label}</td>
                      <td>{o.commander}</td>
                      <td>{o.cardListStatus}</td>
                      <td>
                        {o.attackOnlyDefenseStopsThem ? 'yes' : 'no'}
                        {o.goadAgainstThem ? <div className="rs-meta">{o.goadAgainstThem}</div> : null}
                      </td>
                      <td>
                        {o.record.games} game(s) together ·{' '}
                        {o.record.ownerPointsPerGame === null ? (
                          <>
                            no points-per-game yet ({o.record.label})
                          </>
                        ) : (
                          <>
                            your points per game <Num n={{ value: o.record.ownerPointsPerGame, label: o.record.label }} as="plain" />
                          </>
                        )}{' '}
                        <span className="rs-meta">n = {o.record.games}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="rs-meta">{view.note}</p>
            </>
          )
        }
      </Gate>
    </section>
  );
}
