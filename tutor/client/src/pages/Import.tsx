import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { navigate } from '../App.tsx';
import { CardModal } from '../components/CardModal.tsx';
import { RecognizePanel } from '../components/Recognize.tsx';

const KIND_LABEL: Record<string, string> = {
  recognition: 'Card recognition — tell us which card you mean',
  format: 'Format / deckbuilding rules',
  'engine-support': 'Cards the selected Forge build cannot play',
  'engine-check': 'Forge\'s own deck check',
};

/**
 * Import and review. Paste or upload; every line is shown with what it resolved to; anything
 * uncertain is a question with its answer controls right here. Nothing is replaced silently.
 */
export function ImportPage({ deckId }: { deckId?: string }) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [choices, setChoices] = useState<any>({ names: {}, commander: undefined, removed: [] });
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [showImage, setShowImage] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sample = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('sample');
    if (deckId) {
      api.deck(deckId).then((d) => {
        setText(d.stored.sourceText); setName(d.stored.name);
        setChoices({ names: d.stored.choices.names ?? {}, commander: d.stored.choices.commander, removed: d.stored.choices.removed ?? [] });
        setResult({ deck: d.deck, report: d.report });
      }).catch((e) => setErr(e.message));
    } else if (sample) {
      api.fixtureText(sample).then((t) => { setText(t); setName('Hail, Caesar'); });
    }
  }, [deckId]);

  const check = async (c = choices, t = text) => {
    setBusy(true); setErr(null);
    try { setResult(await api.preview({ text: t, filename, choices: clean(c), format: 'commander' })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.saveDeck({ id: deckId, name: name || result?.deck?.name, text, filename, choices: clean(choices), format: 'commander' });
      navigate(`/decks/${r.stored.id}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.type.startsWith('image/')) { setShowImage(true); return; }
    const t = await f.text();
    setFilename(f.name); setText(t);
    if (!name) setName(f.name.replace(/\.(txt|csv|dec)$/i, ''));
    const fresh = { names: {}, commander: undefined, removed: [] };
    setChoices(fresh);
    check(fresh, t);
  };

  const setChoice = (patch: any) => { const c = { ...choices, ...patch }; setChoices(c); check(c); };
  const lines = result?.deck?.lines ?? [];
  const issuesByKind = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const i of result?.report?.issues ?? []) m.set(i.kind, [...(m.get(i.kind) ?? []), i]);
    return m;
  }, [result]);
  const lineIssue = (n: number) => (result?.report?.issues ?? []).filter((i: any) => i.lineNos.includes(n));
  const blocking = (result?.report?.issues ?? []).filter((i: any) => i.blocking);

  return (
    <div className="page">
      <h1>{deckId ? 'Edit deck' : 'Import a deck'}</h1>
      <div className="import-grid">
        <section className="panel">
          <label className="field">Deck name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Hail, Caesar" /></label>
          <label className="field">Format
            <select value="commander" onChange={() => undefined} aria-describedby="fmt-note">
              <option value="commander">Commander</option>
            </select>
          </label>
          <p id="fmt-note" className="muted small">Only Commander is implemented and verified. Other formats are not offered rather than checked loosely.</p>
          <label className="field">Decklist (paste)
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} spellCheck={false}
              placeholder={'Commander\n1 Caesar, Legion\'s Emperor\n\nDeck\n1 Mr. House, President and CEO\n1 Sol Ring (PIP) 239\n5 Plains\n…'} />
          </label>
          <div className="row">
            <button className="primary" disabled={!text.trim() || busy} onClick={() => check()}>{busy ? 'Checking…' : 'Check deck'}</button>
            <button onClick={() => fileRef.current?.click()}>Upload TXT / CSV / image</button>
            <button onClick={() => setShowImage((v) => !v)}>Screenshot or card photo</button>
            <input ref={fileRef} type="file" hidden accept=".txt,.csv,.dec,text/plain,text/csv,image/*" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
          {showImage && <RecognizePanel onText={(t) => { setText((prev) => (prev.trim() ? prev.trimEnd() + '\n' : '') + t); setShowImage(false); }} />}
          <p className="muted small">Accepted: MTG Arena/Moxfield/Archidekt style text (<code>1 Name (SET) 123</code>, section headers like Commander / Deck / Sideboard, <code>*CMDR*</code> markers) and CSV with a Name column.</p>
        </section>

        <section className="panel">
          {err && <p className="error">{err}</p>}
          {!result && <p className="muted">Check the deck to see how every line was recognized.</p>}
          {result && (
            <>
              <div className="summary">
                <span><strong>{result.report.counts.total}</strong> cards in deck</span>
                <span><strong>{result.report.counts.commander}</strong> commander</span>
                {result.report.counts.sideboard > 0 && <span>{result.report.counts.sideboard} outside the deck</span>}
                <span className={result.report.playable ? 'ok' : 'warn-text'}>{result.report.playable ? 'Ready to practice' : `${blocking.length} thing(s) to resolve before an accurate match`}</span>
              </div>
              <CommanderChoice result={result} choices={choices} onChoose={(ids) => setChoice({ commander: ids })} />
              {[...issuesByKind.entries()].map(([kind, list]) => (
                <div key={kind} className={`issues issues-${kind}`}>
                  <h3>{KIND_LABEL[kind] ?? kind}</h3>
                  <ul>{list.map((i: any, n: number) => (
                    <li key={n}><span>{i.message}</span><br /><span className="fix">Fix: {i.correction}</span>{!i.blocking && <span className="badge">note</span>}</li>
                  ))}</ul>
                </div>
              ))}
              <table className="lines">
                <thead><tr><th>#</th><th>Qty</th><th>Card</th><th>Section</th><th></th></tr></thead>
                <tbody>
                  {lines.map((l: any) => (
                    <tr key={l.lineNo} className={`st-${l.status}`}>
                      <td>{l.lineNo}</td>
                      <td>{l.quantity}</td>
                      <td>
                        {l.card ? <button className="link" onClick={() => setCard(l.card.id)}>{l.card.name}</button> : <span className="typed">{l.typedName}</span>}
                        {l.set && <span className="muted small"> {l.set}{l.number ? ` #${l.number}` : ''}</span>}
                        {l.message && <div className="small muted">{l.message}</div>}
                        {l.status !== 'resolved' && (
                          <LineFix line={l} onPick={(nm) => setChoice({ names: { ...choices.names, [l.lineNo]: nm } })} onRemove={() => setChoice({ removed: [...choices.removed, l.lineNo] })} />
                        )}
                        {lineIssue(l.lineNo).filter((i: any) => i.kind !== 'recognition').map((i: any, n: number) => <div key={n} className="small warn-text">{i.message}</div>)}
                      </td>
                      <td>{l.section}</td>
                      <td>{l.status === 'resolved' ? '✓' : '?'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {choices.removed.length > 0 && <p className="small muted">You removed line(s) {choices.removed.join(', ')}. <button className="link" onClick={() => setChoice({ removed: [] })}>Restore</button></p>}
              <div className="row sticky-actions">
                <button className="primary" disabled={busy} onClick={save}>Save deck</button>
                <span className="muted small">{result.report.playable ? 'Saved decks open without importing again.' : 'You can save now and resolve the rest later; practice unlocks when nothing blocking remains.'}</span>
              </div>
            </>
          )}
        </section>
      </div>
      {card && <CardModal cardRef={card} onClose={() => setCard(null)} />}
    </div>
  );
}

function clean(c: any) {
  return { names: c.names, commander: c.commander, removed: c.removed };
}

function LineFix({ line, onPick, onRemove }: { line: any; onPick: (n: string) => void; onRemove: () => void }) {
  const [typed, setTyped] = useState('');
  return (
    <div className="linefix">
      {line.candidates.map((c: string) => <button key={c} onClick={() => onPick(c)}>{c}</button>)}
      <input placeholder="Or type the exact name" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim()) onPick(typed.trim()); }} />
      <button disabled={!typed.trim()} onClick={() => onPick(typed.trim())}>Use</button>
      <button className="danger" onClick={onRemove}>Remove line</button>
    </div>
  );
}

function CommanderChoice({ result, choices, onChoose }: { result: any; choices: any; onChoose: (ids: string[]) => void }) {
  const deck = result.deck;
  const current: string[] = deck.commanderIds;
  const name = (id: string) => deck.lines.find((l: any) => l.card?.id === id)?.card?.name ?? id;
  return (
    <div className="commander-choice">
      <h3>Commander</h3>
      {current.length > 0 && <p>{current.map(name).join(' & ')} <span className="muted small">({deck.commanderSource === 'stated' ? 'from your list' : 'confirmed by you'})</span></p>}
      {current.length === 0 && <p className="warn-text">Not confirmed yet — choose it below. It is never guessed.</p>}
      {deck.commanderCandidates.length > 0 && (
        <div className="row wrap">
          {deck.commanderCandidates.map((c: any) => (
            <button key={c.id} className={current.includes(c.id) ? 'on' : ''} onClick={() => onChoose(current.includes(c.id) ? current.filter((x) => x !== c.id) : choices.commander?.length || deck.commanderSource === 'confirmed' ? [...current, c.id] : [c.id])}>
              {current.includes(c.id) ? '✓ ' : ''}{c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
