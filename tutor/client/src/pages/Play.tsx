import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { GameCard } from '../components/GameCard.tsx';
import { DecisionPanel } from '../components/DecisionPanel.tsx';
import { TutorPanel } from '../components/TutorPanel.tsx';
import { CardModal } from '../components/CardModal.tsx';

const PHASES: Array<[string, string]> = [
  ['UNTAP', 'Untap'], ['UPKEEP', 'Upkeep'], ['DRAW', 'Draw'], ['MAIN1', 'Main 1'], ['COMBAT_BEGIN', 'Begin combat'],
  ['COMBAT_DECLARE_ATTACKERS', 'Attackers'], ['COMBAT_DECLARE_BLOCKERS', 'Blockers'], ['COMBAT_DAMAGE', 'Damage'],
  ['COMBAT_END', 'End combat'], ['MAIN2', 'Main 2'], ['END_OF_TURN', 'End'], ['CLEANUP', 'Cleanup'],
];

/** A practice match: the real Forge game, as the human sees it. */
export function PlayPage({ matchId }: { matchId: string }) {
  const [state, setState] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<any>(null);
  const [focusCard, setFocusCard] = useState<number | null>(null);
  const [coachMode, setCoachModeState] = useState('teach');
  const [zone, setZone] = useState<{ title: string; cards: any[] } | null>(null);
  const [showAuto, setShowAuto] = useState(false);
  const [showTutor, setShowTutor] = useState(true);
  const revRef = useRef(0);
  const seenTypes = useRef(new Set<string>());
  const [autoAsk, setAutoAsk] = useState<string | null>(null);
  const prevDecisionSeq = useRef(-1);
  const curDecisionSeq = useRef(-1);

  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    const loop = async () => {
      while (live) {
        try {
          const s = await api.state(matchId, revRef.current, 20000, ctl.signal);
          if (!live) return;
          if (s.revision !== revRef.current) {
            revRef.current = s.revision;
            setState(s);
            setCoachModeState(s.coachMode);
            if (s.decision) {
              prevDecisionSeq.current = curDecisionSeq.current;
              curDecisionSeq.current = s.log?.length ? s.log[s.log.length - 1].seq : -1;
              if (!seenTypes.current.has(s.decision.type)) { seenTypes.current.add(s.decision.type); setAutoAsk(`${s.decision.type}:${s.revision}`); }
            }
          }
          setErr(null);
          if (s.status === 'over') { await new Promise((r) => setTimeout(r, 3000)); }
        } catch (e: any) {
          if (!live) return;
          setErr(e.message);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };
    loop();
    return () => { live = false; ctl.abort(); };
  }, [matchId]);

  const submit = useCallback(async (action: any, revision?: number) => {
    if (!state) return;
    setBusy(true); setActErr(null); setCardMenu(null);
    try { await api.act(matchId, revision ?? state.revision, action); }
    catch (e: any) { setActErr(/earlier position/.test(e.message) ? 'The game moved on before that click arrived, so nothing changed. Choose again from the options shown now.' : e.message); }
    finally { setBusy(false); }
  }, [state, matchId]);

  const setCoachMode = (m: string) => { setCoachModeState(m); api.coachMode(matchId, m).catch(() => undefined); };

  if (!state) return <div className="page"><p className="muted"><span className="spinner" /> Starting the game in Forge…</p>{err && <p className="error">{err}</p>}</div>;
  if (!state.players) return <div className="page"><p className="muted">Setting up the table…</p></div>;

  const me = state.players.find((p: any) => p.isHuman);
  const opps = state.players.filter((p: any) => !p.isHuman);
  const acts: any[] = state.decision?.actions ?? [];
  const actsFor = (id: number) => acts.filter((a) => a.cardId === id);
  const nameById = new Map<number, string>();
  for (const p of state.players) for (const z of ['battlefield', 'hand', 'command', 'graveyard', 'exile']) for (const c of p[z] ?? []) nameById.set(c.id, c.name);
  const openCard = (c: any) => setCardMenu(c);

  const zoneRow = (p: any) => (
    <div className="zones">
      <button onClick={() => setZone({ title: `${p.name} — graveyard`, cards: p.graveyard })}>Graveyard {p.graveyard.length}</button>
      <button onClick={() => setZone({ title: `${p.name} — exile`, cards: p.exile })}>Exile {p.exile.length}</button>
      <span className="pill">Library {p.libraryCount}</span>
      <span className="pill">Hand {p.handCount}</span>
    </div>
  );

  const board = (p: any) => {
    const lands = p.battlefield.filter((c: any) => c.isLand);
    const rest = p.battlefield.filter((c: any) => !c.isLand);
    return (
      <>
        <div className="bf-row nonland">{rest.length ? rest.map((c: any) => <GameCard key={c.id} c={c} selectable={actsFor(c.id).length > 0} onClick={() => openCard(c)} />) : <span className="muted small">No creatures or other permanents</span>}</div>
        <div className="bf-row lands" aria-label="Lands">{lands.map((c: any) => <GameCard key={c.id} c={c} small selectable={actsFor(c.id).length > 0} onClick={() => openCard(c)} />)}</div>
      </>
    );
  };

  const playerHead = (p: any) => (
    <div className="phead">
      <strong>{p.name}{p.id === state.activePlayerId ? (p.isHuman ? ' · your turn' : ' · their turn') : ''}{p.lost ? ' · out' : ''}</strong>
      <span className="life" aria-label={`${p.life} life`}>♥ {p.life}</span>
      {p.poison > 0 && <span className="pill">☠ {p.poison}</span>}
      {Object.entries(p.counters ?? {}).map(([k, v]) => <span key={k} className="pill">{String(v)} {k}</span>)}
      {Object.keys(p.manaPool ?? {}).length > 0 && <span className="pill">Mana {Object.entries(p.manaPool).map(([k, v]) => `${v}${k}`).join(' ')}</span>}
      {p.commanderDamageTaken?.map((d: any) => <span key={d.commander} className="pill cmd-dmg">{d.damage}/21 from {d.commander}</span>)}
    </div>
  );

  const commandZone = (p: any) => (
    <div className="command">
      {p.commanders.map((c: any) => {
        const card = [...p.command, ...p.battlefield, ...p.graveyard, ...p.exile].find((x: any) => x.id === c.cardId);
        return (
          <div key={c.cardId} className="cmd">
            {card && c.zone === 'COMMAND' ? <GameCard c={card} small selectable={actsFor(c.cardId).length > 0} onClick={() => openCard(card)} /> : null}
            <span className="small">{c.name}: {c.zone.toLowerCase()} · tax {'{'}{c.tax}{'}'}</span>
          </div>
        );
      })}
    </div>
  );

  const phaseIdx = PHASES.findIndex(([k]) => k === state.phase);
  return (
    <div className="board">
      <div className="phasebar" aria-label="Turn and phase">
        <span>Turn {state.turn} · <strong>{state.players.find((p: any) => p.id === state.activePlayerId)?.name ?? '—'}</strong></span>
        <ol className="phases">{PHASES.map(([k, l], i) => <li key={k} className={i === phaseIdx ? 'on' : i < phaseIdx ? 'past' : ''}>{l}</li>)}</ol>
        <span>Priority: <strong>{state.players.find((p: any) => p.id === state.priorityPlayerId)?.name ?? '—'}</strong></span>
        <span className="muted small">{state.gameType === 'Commander' ? (state.players.length === 2 ? 'Two-player Commander practice' : `${state.players.length}-player Commander`) : state.gameType}</span>
      </div>

      <div className="play-grid">
        <div className="table">
          {opps.map((p: any) => (
            <section key={p.id} className={`seat opp ${p.id === state.activePlayerId ? 'active' : ''}`}>
              {playerHead(p)}{commandZone(p)}{board(p)}{zoneRow(p)}
              {p.revealedHand?.length > 0 && <div className="small muted">Revealed from hand: {p.revealedHand.map((c: any) => c.name).join(', ')}</div>}
            </section>
          ))}

          <section className="middle">
            <div className="stack" aria-label="Stack">
              <h4>Stack {state.stack.length ? `(${state.stack.length}, top first)` : '(empty)'}</h4>
              {state.stack.map((x: any) => (
                <div key={x.id} className="stack-item">
                  {x.source && <GameCard c={x.source} small onClick={() => x.source.oracleId && setModal(x.source.oracleId)} />}
                  <span>{x.description}</span>
                </div>
              ))}
            </div>
            {state.combat?.length > 0 && (
              <div className="combat" aria-label="Combat">
                <h4>Combat</h4>
                {state.combat.map((c: any) => (
                  <div key={c.attackerId} className="small">{nameById.get(c.attackerId)} → {c.defender}{c.blockerIds.length ? `, blocked by ${c.blockerIds.map((b: number) => nameById.get(b)).join(', ')}` : ', unblocked'}</div>
                ))}
              </div>
            )}
          </section>

          <section className={`seat me ${me.id === state.activePlayerId ? 'active' : ''}`}>
            {playerHead(me)}{commandZone(me)}{board(me)}{zoneRow(me)}
            <h4 className="hand-head">Your hand ({me.hand.length})</h4>
            <div className="hand" aria-label="Your hand">
              {me.hand.map((c: any) => <GameCard key={c.id} c={c} selectable={actsFor(c.id).some((a) => a.affordable !== false && a.hasTargets !== false)} onClick={() => openCard(c)} />)}
            </div>
          </section>
        </div>

        <div className="side">
          {state.status === 'over' ? (
            <section className="decision over">
              <h3>Game over</h3>
              <p>{state.outcome?.humanWon ? 'You won!' : `${state.outcome?.winner ?? 'Someone'} won.`} {state.outcome?.turns ? `(${state.outcome.turns} turns)` : ''}</p>
              <a className="button primary" href={`#/review/${matchId}`}>Review this game</a>
            </section>
          ) : (
            <DecisionPanel state={state} submit={submit} busy={busy} onCard={(id) => { const n = nameById.get(id); if (n) setModal(n); }} />
          )}
          {actErr && <p className="error" role="alert">{actErr} <button className="link" onClick={() => setFocusCard(null)}>Ask the tutor why</button></p>}
          {state.notices?.length > 0 && <p className="notice small">{String(state.notices[state.notices.length - 1]).replace(/=+ [^=]+ =+,?\s*/g, '')}</p>}
          <div className="row wrap">
            <button className="small" onClick={() => setShowTutor((v) => !v)}>{showTutor ? 'Hide tutor' : 'Show tutor'}</button>
            <button className="small" onClick={() => setShowAuto((v) => !v)}>Automation</button>
            <button className="small danger" onClick={() => { if (confirm('Concede this game?')) api.concede(matchId); }}>Concede</button>
          </div>
          {showAuto && <Automation matchId={matchId} settings={state.automation} />}
          {showTutor && (
            <TutorPanel matchId={matchId} state={state} coachMode={coachMode} setCoachMode={setCoachMode} sinceSeq={prevDecisionSeq.current}
              onChoose={(id, rev) => submit({ id }, rev)} onExplainCard={(ref) => setModal(ref)} focusCardId={focusCard} autoAsk={autoAsk} />
          )}
          <details className="log" open>
            <summary>Game log</summary>
            <ol>{[...state.log].reverse().slice(0, 60).map((l: any) => <li key={l.seq} className={`log-${l.type}`}>{l.message}</li>)}</ol>
          </details>
        </div>
      </div>

      {cardMenu && (
        <div className="modal-back" onClick={() => setCardMenu(null)} role="presentation">
          <div className="menu" role="dialog" aria-label={cardMenu.name} onClick={(e) => e.stopPropagation()}>
            <div className="menu-head">{cardMenu.image && <img src={cardMenu.image} alt={cardMenu.name} />}<strong>{cardMenu.name}</strong></div>
            {actsFor(cardMenu.id).map((a) => (
              <button key={a.id} className="play" disabled={busy} onClick={() => submit({ id: a.id })}>{a.label}{a.affordable === false ? ' (can\'t pay now)' : ''}{a.hasTargets === false ? ' (no target)' : ''}</button>
            ))}
            {cardMenu.controllerId === me.id && <button onClick={() => { setFocusCard(cardMenu.id); setShowTutor(true); setCardMenu(null); }}>Why can't I play this? (ask the tutor)</button>}
            {!cardMenu.hidden && <button onClick={() => { setModal(cardMenu.oracleId ?? cardMenu.name); setCardMenu(null); }}>Explain this card</button>}
            <button onClick={() => setCardMenu(null)}>Close</button>
          </div>
        </div>
      )}
      {zone && (
        <div className="modal-back" onClick={() => setZone(null)} role="presentation">
          <div className="modal" role="dialog" aria-label={zone.title} onClick={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setZone(null)} aria-label="Close">×</button>
            <h3>{zone.title}</h3>
            <div className="zone-cards">{zone.cards.length ? zone.cards.map((c) => <GameCard key={c.id} c={c} onClick={() => { setZone(null); openCard(c); }} />) : <p className="muted">Empty.</p>}</div>
          </div>
        </div>
      )}
      {modal && <CardModal cardRef={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

function Automation({ matchId, settings }: { matchId: string; settings: any }) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const save = (n: any) => { setS(n); api.automation(matchId, n).catch(() => undefined); };
  const toggle = (key: 'stopsMyTurn' | 'stopsTheirTurn', ph: string) => {
    const list: string[] = s[key];
    save({ ...s, [key]: list.includes(ph) ? list.filter((x) => x !== ph) : [...list, ph] });
  };
  const phases = PHASES.filter(([k]) => !['UNTAP', 'CLEANUP'].includes(k));
  return (
    <div className="automation panel">
      <p className="small">Forge always stops when something is on the stack or you must choose. These settings only skip routine priority stops with an empty stack.</p>
      <label className="check"><input type="checkbox" checked={s.autoPassNoResponses} onChange={(e) => save({ ...s, autoPassNoResponses: e.target.checked })} /> Auto-pass when I have no affordable response to something on the stack</label>
      <table className="auto"><thead><tr><th>Stop at</th><th>My turn</th><th>Their turns</th></tr></thead>
        <tbody>{phases.map(([k, l]) => (
          <tr key={k}><td>{l}</td>
            <td><input type="checkbox" checked={s.stopsMyTurn.includes(k)} onChange={() => toggle('stopsMyTurn', k)} aria-label={`Stop at ${l} on my turn`} /></td>
            <td><input type="checkbox" checked={s.stopsTheirTurn.includes(k)} onChange={() => toggle('stopsTheirTurn', k)} aria-label={`Stop at ${l} on their turns`} /></td></tr>
        ))}</tbody></table>
    </div>
  );
}
