/** My Decks, Exports and Collection: the deck store's three faces. */
import { useState } from 'react';
import {
  MagicApi,
  formatCents,
  type DeckDetail,
  type DeckDiff,
  type ImportResult,
  type MagicFormat,
  type ValidationView,
} from '../../lib/magicApi.ts';
import { useAsync } from '../useAsync.ts';
import { ErrorLine, Gate, StaleNote, errorText } from './shared.tsx';

export function ImportForm({ onDone }: { onDone: (deckId: string | null) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<MagicFormat>('COMMANDER');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const out = await MagicApi.importDeck({ name, format, text });
      setResult(out);
      if (out.deck && out.issues.length === 0) onDone(out.deck.id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rs-card" aria-label="Import a deck">
      <h3>Import a deck</h3>
      <p className="rs-meta">One card per line: a count, then the name. Use Commander, Deck and Sideboard headings.</p>
      <label>
        Deck name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value as MagicFormat)}>
          <option value="COMMANDER">Commander</option>
          <option value="STANDARD">Standard</option>
        </select>
      </label>
      <label>
        Card list
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="button" disabled={busy || !name.trim() || !text.trim()} onClick={() => void submit()}>
        {busy ? 'Importing…' : 'Import'}
      </button>
      <ErrorLine message={error} />
      {result && result.issues.length > 0 ? (
        <div role="alert" className="rs-magic-issues">
          <p>
            {result.deck ? 'Imported with problems to resolve:' : 'Nothing was imported. Resolve these first:'}
          </p>
          <ul>
            {result.issues.map((issue) => (
              <li key={`${issue.line}-${issue.kind}`}>
                Line {issue.line}: <strong>{issue.kind.toLowerCase()}</strong> — {issue.message}
                {issue.candidates?.length ? ` (could be: ${issue.candidates.join('; ')})` : ''}
              </li>
            ))}
          </ul>
          {result.deck ? (
            <button type="button" onClick={() => onDone(result.deck?.id ?? null)}>
              Open the imported deck
            </button>
          ) : null}
        </div>
      ) : null}
      <StaleNote freshness={result?.freshness} />
    </section>
  );
}

function DeckPanel({ id }: { id: string }): JSX.Element {
  const query = useAsync<DeckDetail>(() => MagicApi.deck(id), [id]);
  const [validation, setValidation] = useState<ValidationView | null>(null);
  const [diff, setDiff] = useState<DeckDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Gate query={query} what="this deck">
      {(deck) => (
        <section className="rs-card" aria-label={`Deck ${deck.name}`}>
          <h3>{deck.name}</h3>
          <p className="rs-meta">
            {deck.format.toLowerCase()} · version {deck.versionNumber ?? '—'} · {deck.cardCount} cards ·{' '}
            {deck.cardListStatus === 'VERIFIED' ? 'verified card list' : 'unverified cardlist'}
          </p>
          <StaleNote freshness={deck.freshness} />
          <div className="rs-magic-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setValidation(await MagicApi.validate(deck.id)))}
            >
              Validate
            </button>
            <button
              type="button"
              disabled={busy || deck.versions.length < 2}
              onClick={() =>
                void run(async () => {
                  await MagicApi.undo(deck.id);
                  setDiff(null);
                  query.reload();
                })
              }
            >
              Undo to previous version
            </button>
            <button
              type="button"
              disabled={busy || deck.versions.length < 2}
              onClick={() =>
                void run(async () => {
                  const [latest, previous] = deck.versions;
                  if (latest && previous) setDiff(await MagicApi.diff(deck.id, previous.versionNumber, latest.versionNumber));
                })
              }
            >
              Show last change
            </button>
          </div>
          <ErrorLine message={error} />
          {validation ? (
            <div className={validation.ok ? 'rs-magic-ok' : 'rs-magic-issues'} role="status">
              <p>
                {validation.ok ? 'Legal' : 'Not legal'} as of {validation.analysisDate} (legality data from{' '}
                {validation.legalitySnapshotAt ?? 'an unknown date'}).
              </p>
              <ul>
                {validation.issues.map((issue, i) => (
                  <li key={i}>
                    {issue.severity === 'ERROR' ? 'Error' : 'Warning'}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {diff ? (
            <div aria-label="Version diff">
              <p>
                Version {diff.from} → {diff.to}
              </p>
              <ul>
                {diff.added.map((c) => (
                  <li key={`a-${c.zone}-${c.name}`}>Add {c.quantity} {c.name}</li>
                ))}
                {diff.cut.map((c) => (
                  <li key={`c-${c.zone}-${c.name}`}>Cut {c.quantity} {c.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <table className="rs-table">
            <thead>
              <tr>
                <th>Zone</th>
                <th>Qty</th>
                <th>Card</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {deck.cards.map((card) => (
                <tr key={`${card.zone}-${card.name}`}>
                  <td>{card.zone}</td>
                  <td>{card.quantity}</td>
                  <td>{card.name}</td>
                  <td>
                    {formatCents(card.priceCents)}
                    {card.priceStatus ? ` (${card.priceStatus === 'ESTIMATE' ? 'estimate' : 'confirmed'})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Gate>
  );
}

export function DecksSection({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}): JSX.Element {
  const list = useAsync(() => MagicApi.decks(), []);
  return (
    <div className="rs-stack">
      <Gate query={list} what="your decks">
        {({ decks, freshness }) => (
          <section className="rs-card">
            <h3>My Decks</h3>
            <StaleNote freshness={freshness} />
            {decks.length === 0 ? (
              <p className="rs-empty">No decks yet. Describe one in Design, or import a list below.</p>
            ) : (
              <ul className="rs-magic-decklist">
                {decks.map((deck) => (
                  <li key={deck.id}>
                    <button
                      type="button"
                      aria-pressed={selected === deck.id}
                      onClick={() => onSelect(selected === deck.id ? null : deck.id)}
                    >
                      {deck.name}
                    </button>{' '}
                    <span className="rs-meta">
                      {deck.format.toLowerCase()} · {deck.cardCount} cards
                      {deck.cardListStatus === 'UNVERIFIED' ? ' · unverified cardlist' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </Gate>
      {selected ? <DeckPanel id={selected} /> : null}
      <ImportForm
        onDone={(id) => {
          list.reload();
          if (id) onSelect(id);
        }}
      />
    </div>
  );
}

export function ExportsSection(): JSX.Element {
  const list = useAsync(() => MagicApi.decks(), []);
  const [text, setText] = useState<{ name: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="rs-card">
      <h3>Exports</h3>
      <Gate query={list} what="your decks">
        {({ decks }) =>
          decks.length === 0 ? (
            <p className="rs-empty">Nothing to export yet.</p>
          ) : (
            <ul className="rs-magic-decklist">
              {decks.map((deck) => (
                <li key={deck.id}>
                  {deck.name}{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      MagicApi.exportDeck(deck.id).then(
                        (out) => setText({ name: deck.name, body: out.text }),
                        (cause: unknown) => setError(errorText(cause)),
                      );
                    }}
                  >
                    Export as text
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Gate>
      <ErrorLine message={error} />
      {text ? (
        <label>
          {text.name} (plain text)
          <textarea readOnly rows={12} value={text.body} onFocus={(e) => e.currentTarget.select()} />
        </label>
      ) : null}
    </section>
  );
}

export function CollectionSection(): JSX.Element {
  const query = useAsync(() => MagicApi.collection(), []);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'OWNED' | 'PROXY'>('OWNED');
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="rs-card">
      <h3>Collection</h3>
      <p className="rs-meta">Owned and proxy cards are kept apart from deck membership. A proxy never counts as a purchase.</p>
      <Gate query={query} what="your collection">
        {({ entries }) =>
          entries.length === 0 ? (
            <p className="rs-empty">Your collection is empty.</p>
          ) : (
            <ul>
              {entries.map((e) => (
                <li key={e.id}>
                  {e.quantity} × {e.name} — {e.status === 'OWNED' ? 'owned' : 'proxy'}
                </li>
              ))}
            </ul>
          )
        }
      </Gate>
      <label>
        Card name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as 'OWNED' | 'PROXY')}>
          <option value="OWNED">Owned</option>
          <option value="PROXY">Proxy</option>
        </select>
      </label>
      <label>
        Quantity
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        />
      </label>
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => {
          setError(null);
          MagicApi.setCollection({ name: name.trim(), status, quantity }).then(
            () => {
              setName('');
              query.reload();
            },
            (cause: unknown) => setError(errorText(cause)),
          );
        }}
      >
        Add to collection
      </button>
      <ErrorLine message={error} />
    </section>
  );
}
