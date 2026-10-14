import { useEffect, useState } from 'react';
import { api } from '../api.ts';

/** Tap any card: its image (both faces), current text, a plain explanation and how it fits the deck. */
export function CardModal({ cardRef, deckId, onClose, actions }: { cardRef: string; deckId?: string; onClose: () => void; actions?: React.ReactNode }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [face, setFace] = useState(0);
  useEffect(() => {
    let live = true;
    api.explainCard(cardRef, deckId).then((d) => live && (d.error ? setErr(d.error) : setData(d))).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [cardRef, deckId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const faces = data?.faces?.length ? data.faces : null;
  const img = faces ? faces[face]?.image ?? data?.image : data?.image;
  return (
    <div className="modal-back" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={data?.name ?? 'Card'} onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        {err && <p className="error">{err}</p>}
        {!data && !err && <p className="muted">Loading card…</p>}
        {data && (
          <div className="card-detail">
            <div className="card-detail-img">
              {img ? <img src={img} alt={faces ? faces[face].name : data.name} /> : <div className="card-ph big">{data.name}</div>}
              {faces && faces.length > 1 && (
                <button onClick={() => setFace((face + 1) % faces.length)}>Show {faces[(face + 1) % faces.length].name}</button>
              )}
            </div>
            <div className="card-detail-text">
              <h2>{data.name}</h2>
              <p className="muted">{data.typeLine} {data.manaCost && <span className="cost">{data.manaCost}</span>}</p>
              {actions}
              {(faces ?? [{ name: data.name, text: data.text }]).map((f: any) => (
                <div key={f.name} className="oracle">{faces && <strong>{f.name}</strong>}<p>{f.text}</p></div>
              ))}
              <h3>In plain language</h3>
              <ul>{data.plain.map((p: string) => <li key={p}>{p}</li>)}</ul>
              {data.inDeck?.length > 0 && (<><h3>In your deck</h3><ul>{data.inDeck.map((p: string) => <li key={p}>{p}</li>)}</ul></>)}
              {data.keywordRules?.some((k: any) => k.rule.length) && (
                <details><summary>Keyword rules</summary>
                  {data.keywordRules.map((k: any) => (
                    <div key={k.keyword}><strong>{k.keyword}</strong>{k.rule.map((r: any) => <p key={r.number} className="rule"><span>{r.number}</span> {r.text}</p>)}</div>
                  ))}
                </details>
              )}
              {data.rulings?.length > 0 && (
                <details><summary>Rulings ({data.rulings.length})</summary>
                  {data.rulings.map((r: any, i: number) => <p key={i} className="rule"><span>{r.published_at}</span> {r.comment}</p>)}
                </details>
              )}
              <p className="muted small">Commander legality: {data.legalities?.commander}. Text from Scryfall Oracle data{data.source ? <> — <a href={data.source} target="_blank" rel="noreferrer">Scryfall</a></> : null}.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
