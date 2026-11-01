/** My Decks, Exports and Collection: the deck store's three faces. */
import { useState } from 'react';
import {
  MagicApi,
  type AnalysisResult,
  type CatalogStatus,
  type DeckCardInput,
  type ImportReport,
  type MagicFormat,
  type MagicZone,
  type ValidationResult,
  type VersionDiff,
} from '../../lib/magicApi.ts';
import { useAsync } from '../useAsync.ts';
import { ErrorLine, Gate, Num, StaleNote, errorText } from './shared.tsx';

const ZONES: { zone: MagicZone; title: string }[] = [
  { zone: 'commander', title: 'Commander' },
  { zone: 'main', title: 'Main deck' },
  { zone: 'sideboard', title: 'Sideboard' },
];

function count(cards: DeckCardInput[]): number {
  return cards.reduce((n, c) => n + c.quantity, 0);
}

/** One validation, with the date it was judged as of and every issue it found. */
export function ValidationBlock({ validation }: { validation: ValidationResult }): JSX.Element {
  return (
    <div className={validation.ok ? 'rs-magic-ok' : 'rs-magic-issues'} role="status" aria-label="Validation">
      <p>
        <strong>{validation.ok ? 'Legal' : 'Not legal'}</strong> in {validation.format.toLowerCase()} as of{' '}
        {validation.analysisDate} (legality data from {validation.legalitySnapshotAt ?? 'an unknown date'}).{' '}
        {validation.counts.total} cards: {validation.counts.commander} commander, {validation.counts.main} main,{' '}
        {validation.counts.sideboard} sideboard.
        {validation.colorIdentity.length ? ` Color identity ${validation.colorIdentity.join('')}.` : ''}
      </p>
      {validation.issues.length > 0 ? (
        <ul>
          {validation.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>
              {issue.severity === 'ERROR' ? 'Error' : 'Warning'} ({issue.code}): {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What an import found wrong, line by line. A deck with problems is still saved, visibly. */
export function ImportProblems({ report }: { report: ImportReport }): JSX.Element | null {
  if (report.parseProblems.length === 0 && report.resolutionIssues.length === 0) return null;
  return (
    <div role="alert" className="rs-magic-issues" aria-label="Import problems">
      <p>Saved, but these lines need attention:</p>
      <ul>
        {report.parseProblems.map((p) => (
          <li key={`p-${p.line}`}>
            Line {p.line}: could not read “{p.text}” — {p.reason}
          </li>
        ))}
        {report.resolutionIssues.map((issue, i) => (
          <li key={`r-${issue.line ?? i}-${issue.name}`}>
            {issue.line !== undefined ? `Line ${issue.line}: ` : ''}
            <strong>{issue.code === 'UNKNOWN_CARD' ? 'unknown card' : issue.code === 'AMBIGUOUS_NAME' ? 'ambiguous name' : 'unknown printing'}</strong>{' '}
            “{issue.name}” — {issue.message}
            {issue.candidates?.length ? ` (could be: ${issue.candidates.map((c) => c.name).join('; ')})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ImportForm({ onDone }: { onDone: (deckId: string | null) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [format, setFormat] = useState<MagicFormat>('COMMANDER');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const out = await MagicApi.importDeck({ name: name.trim(), format, text });
      setResult(out);
      onDone(out.clean ? out.deck.id : null);
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
      {result ? (
        <div role="status">
          <p>
            Imported “{result.deck.name}” ({result.deck.cardListStatus === 'VERIFIED' ? 'verified card list' : 'unverified cardlist'},{' '}
            {count(result.version.cards)} cards resolved).
          </p>
          <ImportProblems report={result} />
          <ValidationBlock validation={result.validation} />
          <button type="button" onClick={() => onDone(result.deck.id)}>
            Open the imported deck
          </button>
        </div>
      ) : null}
    </section>
  );
}

const SCORE_TEXT: Record<string, string> = {
  sweepResilience: 'Sweeper resilience',
  closing: 'Closing ability',
  singleCardReliance: 'Single-card reliance',
};

/** Every number with the kind of claim it is; the composite is never a win rate. */
export function AnalysisBlock({ analysis, catalog }: { analysis: AnalysisResult; catalog?: CatalogStatus }): JSX.Element {
  return (
    <div aria-label="Analysis">
      <h4>Analysis</h4>
      <StaleNote catalog={catalog} />
      <p className="rs-meta">
        {analysis.librarySize}-card library
        {analysis.commanderZone.length ? `; command zone: ${analysis.commanderZone.join(', ')}` : ''}.
      </p>
      <p>
        Keepable opening hand: <Num n={analysis.openingHand.keepable} />
      </p>
      <ul>
        {Object.entries(analysis.scores).map(([name, value]) => (
          <li key={name}>
            {SCORE_TEXT[name] ?? name}: <Num n={value} as="plain" />
          </li>
        ))}
        {analysis.answers.map((a) => (
          <li key={a.type}>
            {a.type} answer by turn 6 ({a.count} in deck): <Num n={a.byTurn6} />
          </li>
        ))}
        {analysis.commanderCastable.map((c) => (
          <li key={`${c.name}-${c.turn}`}>
            {c.name} castable by turn {c.turn}: <Num n={c.probability} />
          </li>
        ))}
      </ul>
      {analysis.redundancy.some((r) => r.thin) ? (
        <p role="status">Thin: {analysis.redundancy.filter((r) => r.thin).map((r) => r.role).join(', ')}</p>
      ) : null}
      {analysis.simulation ? (
        <div>
          <p>
            Keep seven without a mulligan: <Num n={analysis.simulation.keepSeven} />
          </p>
          <p className="rs-meta">
            Simulation: {analysis.simulation.runs} runs, seed {analysis.simulation.seed}, London mulligan keeping {analysis.simulation.mulliganPolicy.minLands}–
            {analysis.simulation.mulliganPolicy.maxLands} lands.{' '}
            {analysis.simulation.assumptions.join(' ')}
          </p>
        </div>
      ) : null}
      {analysis.notes.map((n) => (
        <p key={n} className="rs-meta">
          {n}
        </p>
      ))}
    </div>
  );
}

function DiffBlock({ diff }: { diff: VersionDiff }): JSX.Element {
  const empty = diff.added.length + diff.removed.length + diff.changed.length === 0;
  return (
    <div aria-label="Version diff">
      {empty ? <p className="rs-meta">No difference between those versions.</p> : null}
      <ul>
        {diff.added.map((c) => (
          <li key={`a-${c.zone}-${c.cardName}`}>
            Added {c.quantity} {c.cardName} ({c.zone})
          </li>
        ))}
        {diff.removed.map((c) => (
          <li key={`r-${c.zone}-${c.cardName}`}>
            Removed {c.quantity} {c.cardName} ({c.zone})
          </li>
        ))}
        {diff.changed.map((c) => (
          <li key={`c-${c.zone}-${c.cardName}`}>
            {c.cardName} ({c.zone}): {c.from} → {c.to}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeckPanel({ id, onChanged }: { id: string; onChanged: () => void }): JSX.Element {
  const query = useAsync(() => MagicApi.deck(id), [id]);
  const versions = useAsync(() => MagicApi.versions(id), [id]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [analysis, setAnalysis] = useState<{ analysis: AnalysisResult; catalog: CatalogStatus } | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [commander, setCommander] = useState('');
  const [exported, setExported] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const reloadAll = (): void => {
    query.reload();
    versions.reload();
    setValidation(null);
    setAnalysis(null);
    onChanged();
  };
  const list = versions.data?.versions ?? [];
  return (
    <Gate query={query} what="this deck">
      {({ deck, version }) => (
        <section className="rs-card" aria-label={`Deck ${deck.name}`}>
          <h3>{deck.name}</h3>
          <p className="rs-meta">
            {deck.format.toLowerCase()} · version {version?.versionNumber ?? '—'} · {version ? count(version.cards) : 0} cards ·{' '}
            {deck.cardListStatus === 'VERIFIED' ? 'verified card list' : 'unverified cardlist'}
          </p>
          <div className="rs-magic-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setValidation((await MagicApi.validate(deck.id)).validation))}
            >
              Validate
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setAnalysis(await MagicApi.analyze({ deckId: deck.id })))}
            >
              Analyze
            </button>
            <button
              type="button"
              disabled={busy || !version?.parentVersionId}
              onClick={() =>
                void run(async () => {
                  const out = await MagicApi.undo(deck.id);
                  setDiff(null);
                  setNote(`Now on version ${out.version.versionNumber}. Nothing was deleted.`);
                  reloadAll();
                })
              }
            >
              Undo to previous version
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setExported((await MagicApi.exportDeck(deck.id)).text))}
            >
              Export
            </button>
          </div>
          <ErrorLine message={error} />
          {note ? <p role="status">{note}</p> : null}
          {validation ? <ValidationBlock validation={validation} /> : null}
          {analysis ? <AnalysisBlock analysis={analysis.analysis} catalog={analysis.catalog} /> : null}
          {exported !== null ? (
            <label>
              Exported list (plain text)
              <textarea readOnly rows={10} value={exported} onFocus={(e) => e.currentTarget.select()} />
            </label>
          ) : null}

          <div aria-label="Change commander">
            <label>
              New commander (two names separated by “&amp;” for partners)
              <input value={commander} onChange={(e) => setCommander(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={busy || !commander.trim()}
              onClick={() =>
                void run(async () => {
                  const names = commander.split('&').map((n) => n.trim()).filter(Boolean).slice(0, 2);
                  const out = await MagicApi.changeCommander(deck.id, names);
                  setCommander('');
                  reloadAll();
                  setValidation(out.validation);
                  setNote(
                    `Saved version ${out.version.versionNumber} with the new commander.` +
                      (out.issues.length ? ` Not resolved: ${out.issues.map((i) => i.name).join(', ')}.` : ''),
                  );
                })
              }
            >
              Change commander
            </button>
          </div>

          <div aria-label="Versions">
            <h4>Versions</h4>
            {list.length === 0 ? (
              <p className="rs-meta">Reading versions…</p>
            ) : (
              <ol>
                {list.map((v) => (
                  <li key={v.id}>
                    v{v.versionNumber}
                    {v.id === deck.currentVersionId ? ' (current)' : ''} — {v.reason || v.source}{' '}
                    <span className="rs-meta">{v.createdAt}</span>
                  </li>
                ))}
              </ol>
            )}
            {list.length >= 2 ? (
              <div className="rs-magic-actions">
                <label>
                  Compare from
                  <select value={from} onChange={(e) => setFrom(e.target.value)}>
                    <option value="">Choose…</option>
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.versionNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  to
                  <select value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">Choose…</option>
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.versionNumber}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || !from || !to || from === to}
                  onClick={() => void run(async () => setDiff((await MagicApi.diff(deck.id, from, to)).diff))}
                >
                  Show differences
                </button>
              </div>
            ) : null}
            {diff ? <DiffBlock diff={diff} /> : null}
          </div>

          {version ? (
            ZONES.filter(({ zone }) => version.cards.some((c) => c.zone === zone)).map(({ zone, title }) => {
              const cards = version.cards.filter((c) => c.zone === zone);
              return (
                <div key={zone} aria-label={title}>
                  <h4>
                    {title} ({count(cards)})
                  </h4>
                  <ul className="rs-magic-cards">
                    {cards.map((c) => (
                      <li key={`${zone}-${c.cardName}`}>
                        {c.quantity} × {c.cardName}
                        {c.oracleId ? '' : <span className="rs-meta"> — not in the catalog</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          ) : (
            <p className="rs-empty">This deck has no saved version.</p>
          )}
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
        {({ decks }) => (
          <section className="rs-card" aria-label="My Decks">
            <h3>My Decks</h3>
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
                      {deck.format.toLowerCase()}
                      {deck.cardListStatus === 'UNVERIFIED' ? ' · unverified cardlist' : ' · verified card list'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </Gate>
      {selected ? <DeckPanel id={selected} onChanged={list.reload} /> : null}
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
    <section className="rs-card" aria-label="Exports">
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
                    aria-label={`Export ${deck.name} as text`}
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
    <section className="rs-card" aria-label="Collection">
      <h3>Collection</h3>
      <p className="rs-meta">
        Owned and proxy cards are kept apart from deck membership. A proxy never counts as a purchase. Setting a quantity of 0
        removes a card.
      </p>
      <Gate query={query} what="your collection">
        {({ collection }) =>
          collection.length === 0 ? (
            <p className="rs-empty">Your collection is empty.</p>
          ) : (
            <ul>
              {collection.map((e) => (
                <li key={e.id}>
                  {e.quantity} × {e.card_name} — {e.status === 'OWNED' ? 'owned' : 'proxy'}
                  {e.oracle_id ? '' : ' (not in the catalog)'}
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
          min={0}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        />
      </label>
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => {
          setError(null);
          MagicApi.setCollection({ cardName: name.trim(), status, quantity }).then(
            () => {
              setName('');
              query.reload();
            },
            (cause: unknown) => setError(errorText(cause)),
          );
        }}
      >
        Save to collection
      </button>
      <ErrorLine message={error} />
    </section>
  );
}
