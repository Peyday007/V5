import { useEffect, useState } from 'react';
import { GameCard } from './GameCard.tsx';

/**
 * Whatever Forge is waiting for, with a control for every kind of choice it can ask: buttons,
 * plays at priority, attackers/defenders/blockers, mana sources, targets and other selections,
 * single and multiple choices, ordering, damage/amount division, numbers and text. If a decision
 * ever arrives with no actions, the panel says so rather than leaving the player stuck.
 */
export function DecisionPanel({ state, submit, busy, onCard }: { state: any; submit: (a: any) => void; busy: boolean; onCard: (id: number) => void }) {
  const d = state.decision;
  if (!d) {
    if (state.status === 'over') return null;
    return <div className="decision waiting" role="status"><span className="spinner" /> {state.status === 'busy' ? 'Opponents are acting…' : 'Waiting for Forge…'}</div>;
  }
  const acts: any[] = d.actions ?? [];
  const by = (cat: string) => acts.filter((a) => a.category === cat);
  const buttons = by('button');
  const plays = acts.filter((a) => ['land', 'spell', 'ability'].includes(a.category));
  const other = acts.filter((a) => !['button', 'land', 'spell', 'ability', 'answer'].includes(a.category));
  const kindTitle: Record<string, string> = {
    PassPriority: 'You have priority', Attack: 'Declare attackers', Block: 'Declare blockers', ConfirmMulligan: 'Keep or mulligan?',
    PayManaOfCostPayment: 'Pay the cost', PayManaOfManaCost: 'Pay the cost', SelectTargets: 'Choose targets',
  };
  return (
    <section className="decision" aria-label="Your decision" data-revision={state.revision}>
      <h3>{kindTitle[d.type] ?? 'Forge asks'}</h3>
      <p className="prompt">{d.prompt}</p>
      {/command zone/i.test(d.prompt) && d.type === 'Confirm' && (
        <p className="muted small">Yes returns your commander to the command zone, so you can cast it again later; each cast from there costs {'{2}'} more. No leaves it where it went.</p>
      )}
      {d.kind === 'dialog' ? <Dialog d={d} submit={submit} busy={busy} onCard={onCard} /> : (
        <>
          {d.offeredCards?.length > 0 && (
            <div className="offered">{d.offeredCards.map((c: any) => (
              <span key={c.id} data-action={`card:${c.id}`}><GameCard c={c} selectable selected={acts.some((a) => a.id === `card:${c.id}` && a.selected)} onClick={() => submit({ id: `card:${c.id}` })} /></span>
            ))}</div>
          )}
          {plays.length > 0 && (
            <div className="plays">
              <h4>You can</h4>
              {plays.map((a) => (
                <button key={a.id} data-action={a.id} disabled={busy} className={a.affordable === false || a.hasTargets === false ? 'play dim' : 'play'} onClick={() => submit({ id: a.id })} title={a.text}>
                  {a.label}{a.cost ? <span className="cost"> {a.cost}</span> : null}
                  {a.affordable === false && <em> — can't pay now</em>}
                  {a.hasTargets === false && <em> — no legal target</em>}
                </button>
              ))}
            </div>
          )}
          {other.length > 0 && (
            <div className="plays">
              {groupLabel(other).map(([label, list]) => (
                <div key={label}><h4>{label}</h4>{list.map((a) => (
                  <button key={a.id} data-action={a.id} disabled={busy} className={a.selected ? 'play on' : 'play'} aria-pressed={a.selected ? true : undefined} onClick={() => submit({ id: a.id })}>{a.selected ? '✓ ' : ''}{a.label}</button>
                ))}</div>
              ))}
            </div>
          )}
          <div className="buttons">
            {buttons.map((a) => <button key={a.id} data-action={a.id} disabled={busy} className={a.id === 'ok' ? 'primary' : ''} onClick={() => submit({ id: a.id })}>{a.label}</button>)}
          </div>
          {acts.length === 0 && <p className="warn">Forge is waiting but offered no action. This should not happen — please report it; you can concede from the menu.</p>}
        </>
      )}
    </section>
  );
}

function groupLabel(list: any[]): Array<[string, any[]]> {
  const names: Record<string, string> = { attacker: 'Creatures', defender: 'Attack whom', blocker: 'Your blockers', manaSource: 'Tap for mana', manaPool: 'Floating mana', select: 'Choose' };
  const m = new Map<string, any[]>();
  for (const a of list) m.set(names[a.category] ?? a.category, [...(m.get(names[a.category] ?? a.category) ?? []), a]);
  return [...m.entries()];
}

function Dialog({ d, submit, busy, onCard }: { d: any; submit: (a: any) => void; busy: boolean; onCard: (id: number) => void }) {
  const acts: any[] = d.actions;
  const ids = acts.map((a) => a.id);
  const options: any[] = d.options ?? [];
  const [picked, setPicked] = useState<number[]>([]);
  const [order, setOrder] = useState<number[]>(() => options.map((o) => o.index));
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [text, setText] = useState(d.initial ?? '');
  useEffect(() => { setPicked([]); setOrder(options.map((o) => o.index)); setAmounts({}); setText(d.initial ?? ''); }, [d]);

  const optionButton = (o: any) => (
    <span key={o.index} className="opt-wrap">
      <button data-action={`opt:${o.index}`} disabled={busy} className="play" onClick={() => submit({ id: `opt:${o.index}` })}>{o.label}</button>
      {o.cardId !== undefined && <button className="link small" onClick={() => onCard(o.cardId)} aria-label={`Explain ${o.label}`}>ⓘ</button>}
    </span>
  );

  if (ids.includes('choose')) {
    const ok = picked.length >= d.min && picked.length <= d.max;
    return (
      <div className="dialog">
        <p className="muted small">Choose {d.min === d.max ? d.min : `${d.min}–${d.max}`}.</p>
        {options.map((o) => (
          <label key={o.index} className="check"><input type="checkbox" checked={picked.includes(o.index)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.index] : picked.filter((x) => x !== o.index))} /> {o.label}
            {o.cardId !== undefined && <button className="link small" onClick={() => onCard(o.cardId)}>ⓘ</button>}</label>
        ))}
        <button data-action="choose" className="primary" disabled={!ok || busy} onClick={() => submit({ id: 'choose', values: picked })}>Confirm ({picked.length})</button>
      </div>
    );
  }
  if (ids.includes('order')) {
    const move = (i: number, dir: number) => { const n = [...order]; const j = i + dir; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setOrder(n); };
    const take = d.max < options.length || d.min < options.length;
    const count = Math.max(d.min, Math.min(d.max, picked.length ? picked[0]! : d.max));
    return (
      <div className="dialog">
        <p className="muted small">Put them in order (first = top / first).</p>
        {take && (
          <label className="assign">How many to choose ({d.min}–{d.max}): the first ones in the list are used
            <input type="number" min={d.min} max={d.max} value={count} onChange={(e) => setPicked([Math.max(d.min, Math.min(d.max, Number(e.target.value) || 0))])} />
          </label>
        )}
        <ol className="order">{order.map((idx, i) => {
          const o = options.find((x) => x.index === idx)!;
          return <li key={idx}><span>{o.label}</span><button onClick={() => move(i, -1)} aria-label="Move up">↑</button><button onClick={() => move(i, 1)} aria-label="Move down">↓</button></li>;
        })}</ol>
        <button data-action="order" className="primary" disabled={busy} onClick={() => submit({ id: 'order', values: order.slice(0, count) })}>Confirm order</button>
      </div>
    );
  }
  if (ids.includes('assign')) {
    const sum = Object.values(amounts).reduce((a, b) => a + b, 0);
    return (
      <div className="dialog">
        <p className="muted small">Distribute exactly {d.total}{d.atLeastOne ? ' (at least 1 each)' : ''}. Assigned: {sum}.</p>
        {options.map((o) => (
          <label key={o.index} className="assign">{o.label}
            <input type="number" min={0} max={d.total} value={amounts[o.index] ?? 0} onChange={(e) => setAmounts({ ...amounts, [o.index]: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
        ))}
        <button data-action="assign" className="primary" disabled={sum !== d.total || busy} onClick={() => submit({ id: 'assign', amounts })}>Confirm</button>
      </div>
    );
  }
  if (ids.includes('submit')) {
    return (
      <div className="dialog">
        <input type={d.type === 'number' ? 'number' : 'text'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Answer" />
        <div className="buttons"><button data-action="submit" className="primary" disabled={busy} onClick={() => submit({ id: 'submit', text: String(text) })}>Submit</button><button data-action="cancel" onClick={() => submit({ id: 'cancel' })}>Cancel</button></div>
      </div>
    );
  }
  return (
    <div className="dialog options">
      {options.map(optionButton)}
      {ids.includes('none') && <button data-action="none" disabled={busy} onClick={() => submit({ id: 'none' })}>Choose nothing</button>}
      {ids.includes('cancel') && <button data-action="cancel" disabled={busy} onClick={() => submit({ id: 'cancel' })}>Cancel</button>}
    </div>
  );
}
