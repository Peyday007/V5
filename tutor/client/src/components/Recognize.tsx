import { useState } from 'react';
import { api } from '../api.ts';

/**
 * Screenshot of a decklist, or a photo of cards → an editable preview. Every line can be
 * corrected or dropped before anything is added to the list; nothing is added automatically.
 */
export function RecognizePanel({ onText }: { onText: (t: string) => void }) {
  const [kind, setKind] = useState<'decklist' | 'cards'>('decklist');
  const [preview, setPreview] = useState<string | null>(null);
  const [rows, setRows] = useState<Array<{ keep: boolean; quantity: number; name: string; status: string; candidates: string[]; text: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<any>(null);

  const read = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setBusy(true); setRows([]);
    const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });
    setPreview(url);
    try {
      const out = await api.recognize({ image: url, kind });
      setMeta(out);
      const fromModel = (out.modelNames ?? []).map((n: string) => ({ keep: true, quantity: 1, name: n, status: 'model', candidates: [n], text: '(vision model)' }));
      setRows([...fromModel, ...out.lines.map((l: any) => ({ keep: l.status !== 'unreadable', quantity: l.quantity, name: l.status === 'exact' ? l.candidates[0] : l.name, status: l.status, candidates: l.candidates, text: l.text }))]);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const set = (i: number, patch: any) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const kept = rows.filter((r) => r.keep && r.name.trim());

  return (
    <div className="recognize">
      <div className="row wrap">
        <label><input type="radio" checked={kind === 'decklist'} onChange={() => setKind('decklist')} /> Decklist screenshot</label>
        <label><input type="radio" checked={kind === 'cards'} onChange={() => setKind('cards')} /> Photo of cards</label>
        <input type="file" accept="image/*" capture="environment" onChange={(e) => read(e.target.files?.[0])} aria-label="Choose an image" />
      </div>
      {busy && <p className="muted">Reading the image… (the first run downloads the OCR model)</p>}
      {err && <p className="error">{err}</p>}
      {preview && <img className="recog-img" src={preview} alt="Uploaded" />}
      {rows.length > 0 && (
        <>
          <p className="muted small">{meta?.note} Engine: {meta?.engine}{meta?.modelNames?.length ? ' + vision model' : ''}.</p>
          <table className="lines">
            <thead><tr><th>Use</th><th>Qty</th><th>Card name</th><th>Read as</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={`st-${r.status === 'exact' || r.status === 'model' ? 'resolved' : 'ambiguous'}`}>
                  <td><input type="checkbox" checked={r.keep} onChange={(e) => set(i, { keep: e.target.checked })} aria-label={`Use ${r.name}`} /></td>
                  <td><input className="qty" type="number" min={1} value={r.quantity} onChange={(e) => set(i, { quantity: Number(e.target.value) || 1 })} /></td>
                  <td>
                    <input value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
                    {r.status === 'close' && <div className="row wrap small">Did you mean {r.candidates.map((c) => <button key={c} onClick={() => set(i, { name: c, status: 'exact' })}>{c}</button>)}</div>}
                    {r.status === 'unreadable' && <div className="small warn-text">Could not match a card — fix the name or untick it.</div>}
                  </td>
                  <td className="small muted">{r.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="primary" disabled={!kept.length} onClick={() => onText(kept.map((r) => `${r.quantity} ${r.name.trim()}`).join('\n'))}>Add {kept.length} line(s) to the decklist</button>
        </>
      )}
      {!busy && meta && rows.length === 0 && <p className="muted">No card names could be read from that image.</p>}
    </div>
  );
}
