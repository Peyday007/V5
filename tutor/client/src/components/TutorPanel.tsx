import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';

/**
 * The tutor beside the board. Every answer is tied to the revision it was asked about; when the
 * position changes, a recommendation is discarded and other answers are marked as earlier.
 * A recommended action is never applied by the tutor — the player chooses it, and the server
 * re-checks it against Forge's current legal actions.
 */
export function TutorPanel({ matchId, state, coachMode, setCoachMode, sinceSeq, onChoose, onExplainCard, focusCardId, autoAsk }: {
  matchId: string; state: any; coachMode: string; setCoachMode: (m: string) => void; sinceSeq: number;
  onChoose: (actionId: string, revision: number) => void; onExplainCard: (ref: string) => void; focusCardId: number | null; autoAsk: string | null;
}) {
  const [answer, setAnswer] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [whyCard, setWhyCard] = useState<number | null>(null);
  const lastAuto = useRef<string | null>(null);
  const me = state.players?.find((p: any) => p.isHuman);
  const myCards = [...(me?.hand ?? []), ...(me?.command ?? []), ...(me?.battlefield ?? []).filter((c: any) => !c.isLand)];

  useEffect(() => { if (focusCardId !== null) setWhyCard(focusCardId); }, [focusCardId]);
  // An answer stays current while the decision it was about is still open; the bridge may redraw
  // the same choice under a newer revision when only the log or the board changed.
  const since = state.decision ? (state.decisionSince ?? state.revision) : state.revision;
  useEffect(() => {
    // Discard stale hints when the position changes.
    setAnswer((a: any) => (a && a.revision < since ? (a.question === 'recommend' ? null : { ...a, stale: true }) : a));
  }, [since]);

  const ask = async (question: string, extra: any = {}) => {
    setBusy(question); setErr(null);
    try {
      const a = await api.tutor(matchId, { question, revision: state.revision, sinceSeq, ...extra });
      setAnswer(a);
    } catch (e: any) { setErr(e.body?.stale ? 'The position changed while asking — ask again.' : e.message); }
    finally { setBusy(null); }
  };

  useEffect(() => {
    if (autoAsk && coachMode === 'teach' && lastAuto.current !== autoAsk && state.decision) {
      lastAuto.current = autoAsk;
      ask('options');
    }
  }, [autoAsk, coachMode, state.revision]);

  const rec = answer?.recommendation;
  const recLive = rec && !answer.stale && rec.revision >= since && rec.revision <= state.revision && state.decision?.actions?.some((a: any) => a.id === rec.actionId);
  return (
    <aside className="tutor" aria-label="Tutor">
      <div className="tutor-head">
        <h3>Tutor</h3>
        <select value={coachMode} onChange={(e) => setCoachMode(e.target.value)} aria-label="Coach mode">
          <option value="teach">Teach me</option>
          <option value="hints">Hints</option>
          <option value="practice">Practice (quiet)</option>
        </select>
      </div>
      {coachMode === 'practice' && !answer && <p className="muted small">Practice mode: the tutor stays quiet. Ask if you need to; a review follows the game.</p>}
      <div className="tutor-buttons">
        <button disabled={!!busy || !state.decision} onClick={() => ask('options')}>What can I do?</button>
        <button disabled={!!busy || !state.decision} onClick={() => ask('recommend')}>What would you recommend, and why?</button>
        <button disabled={!!busy} onClick={() => ask('what-happened')}>What just happened?</button>
        <div className="why">
          <select value={whyCard ?? ''} onChange={(e) => setWhyCard(e.target.value ? Number(e.target.value) : null)} aria-label="Card to ask about">
            <option value="">Pick one of your cards…</option>
            {myCards.map((c: any) => <option key={c.id} value={c.id}>{c.name} ({c.zone.toLowerCase()})</option>)}
          </select>
          <button disabled={!!busy || whyCard === null} onClick={() => ask('why', { cardId: whyCard })}>Why can't I play this?</button>
          <button disabled={whyCard === null} onClick={() => { const c = myCards.find((x: any) => x.id === whyCard); if (c) onExplainCard(c.oracleId ?? c.name); }}>Explain this card</button>
        </div>
      </div>
      {busy && <p className="muted"><span className="spinner" /> Thinking…</p>}
      {err && <p className="error">{err}</p>}
      {answer && (
        <div className={answer.stale ? 'answer stale' : 'answer'}>
          {answer.stale && <p className="muted small">This was about an earlier position.</p>}
          {rec && (
            <div className="rec">
              <p className="rec-line"><strong>Recommended:</strong> {rec.label ?? 'make this choice yourself'}</p>
              <p><strong>Why:</strong> {rec.reason}</p>
              {rec.consequence && <p><strong>Then:</strong> {rec.consequence}</p>}
              <p className="muted small">{rec.source === 'model' ? `Judgment from ${answer.model.label} — a recommendation, not a proven best move.` : 'Rule-of-thumb hint (no language model configured) — a starting point, not a proven best move.'}</p>
              {rec.actionId && <button className="primary" disabled={!recLive} onClick={() => onChoose(rec.actionId, rec.revision)}>{recLive ? 'Choose this' : 'No longer available'}</button>}
              {rec.alternatives?.length > 0 && (
                <details><summary>Alternatives</summary><ul>{rec.alternatives.map((a: any) => <li key={a.actionId}><strong>{a.label}</strong> — {a.why}</li>)}</ul></details>
              )}
            </div>
          )}
          {answer.explanation && (
            <div className="expl">
              <p><strong>{answer.explanation.headline}</strong></p>
              {answer.modelText && <p>{answer.modelText}</p>}
              <ul>{answer.explanation.points.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>
              {answer.explanation.rules?.length > 0 && (
                <details><summary>Rules ({answer.explanation.rules.map((r: any) => r.number).join(', ')})</summary>
                  {answer.explanation.rules.map((r: any) => <p key={r.number} className="rule"><span>{r.number}</span> {r.text}</p>)}
                </details>
              )}
            </div>
          )}
          <p className="muted small">
            {answer.model.configured ? (answer.model.used ? `Model: ${answer.model.label}.` : '') : 'Live model coaching is not configured on this server; answers above come from Forge and the rules.'}
            {answer.model.error && <span className="warn-text"> {answer.model.error}</span>}
          </p>
        </div>
      )}
    </aside>
  );
}
