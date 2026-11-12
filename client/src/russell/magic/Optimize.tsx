/**
 * Optimize: swaps into a saved deck from cards a person names, under a price
 * ceiling, compared against the unchanged deck. Every score is a
 * HEURISTIC_SCORE and is labelled so; nothing here is a win rate.
 */
import { useState } from 'react';
import {
  MagicApi,
  formatCents,
  parseDollars,
  type OptimizeResponse,
  type ScoredBuild,
} from '../../lib/magicApi.ts';
import { useAsync } from '../useAsync.ts';
import { AnalysisBlock } from './Decks.tsx';
import { ErrorLine, Gate, Num, StaleNote, errorText } from './shared.tsx';
import type { AnalyzeResponse } from '../../lib/magicApi.ts';

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function BuildSummary({ build }: { build: ScoredBuild }): JSX.Element {
  return (
    <>
      {build.swaps.length === 0
        ? 'no changes'
        : build.swaps.map((s) => `+${s.add} (${formatCents(s.addPriceCents)}) / −${s.cut}`).join('; ')}
      {' · cost '}
      {formatCents(build.costCents)}
      {' · composite '}
      <Num n={build.composite} as="plain" />
    </>
  );
}

export function OptimizeSection({ initialDeckId }: { initialDeckId: string | null }): JSX.Element {
  const decks = useAsync(() => MagicApi.decks(), []);
  const [picked, setPicked] = useState<string | null>(initialDeckId);
  const [pool, setPool] = useState('');
  const [protect, setProtect] = useState('');
  const [budget, setBudget] = useState('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [result, setResult] = useState<OptimizeResponse | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'optimize' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const budgetCents = budget.trim() === '' ? null : parseDollars(budget);
  const budgetInvalid = budget.trim() !== '' && budgetCents === null;
  const poolNames = lines(pool);

  const run = async (kind: 'analyze' | 'optimize', action: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const opt = result?.optimization;
  return (
    <div className="rs-stack">
      <section className="rs-card" aria-label="Optimize a saved deck">
        <h3>Optimize a saved deck</h3>
        <Gate query={decks} what="your decks">
          {({ decks: list }) =>
            list.length === 0 ? (
              <p className="rs-empty">Save or import a deck first.</p>
            ) : (
              <label>
                Deck
                <select value={picked ?? ''} onChange={(e) => setPicked(e.target.value || null)}>
                  <option value="">Choose a deck…</option>
                  {list.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )
          }
        </Gate>
        <label>
          Cards to consider adding (one per line; leave empty to search every legal catalog card in the deck's colours)
          <textarea rows={5} value={pool} onChange={(e) => setPool(e.target.value)} />
        </label>
        <label>
          Cards never to cut (one per line, optional)
          <textarea rows={2} value={protect} onChange={(e) => setProtect(e.target.value)} />
        </label>
        <label>
          Price ceiling in dollars (optional, e.g. 10.00)
          <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
        </label>
        {budgetInvalid ? <p className="rs-magic-error">Enter dollars and cents, like 9.99.</p> : null}
        <div className="rs-magic-actions">
          <button
            type="button"
            disabled={!picked || busy !== null}
            onClick={() =>
              void run('analyze', async () => {
                if (picked) setAnalysis(await MagicApi.analyze({ deckId: picked }));
              })
            }
          >
            {busy === 'analyze' ? 'Analyzing…' : 'Analyze this deck'}
          </button>
          <button
            type="button"
            disabled={!picked || busy !== null || budgetInvalid}
            onClick={() =>
              void run('optimize', async () => {
                if (!picked) return;
                setResult(
                  await MagicApi.optimize({
                    deckId: picked,
                    ...(poolNames.length > 0 ? { poolNames } : {}),
                    constraints: { priceCeilingCents: budgetCents, protectedNames: lines(protect) },
                  }),
                );
              })
            }
          >
            {busy === 'optimize' ? 'Searching…' : 'Find upgrades'}
          </button>
        </div>
        <ErrorLine message={error} />
      </section>

      {analysis ? (
        <section className="rs-card">
          <AnalysisBlock analysis={analysis.analysis} catalog={analysis.catalog} />
        </section>
      ) : null}

      {result && opt ? (
        <section className="rs-card" aria-label="Optimizer result">
          <h3>Against your unchanged deck</h3>
          <StaleNote catalog={result.catalog} />
          {result.unknownPoolNames.length > 0 ? (
            <p className="rs-magic-issues" role="status">
              Not in the catalog, so not considered: {result.unknownPoolNames.join(', ')}.
            </p>
          ) : null}
          <p>
            Baseline{opt.baseline.valid ? '' : ' (not legal as it stands)'}: <BuildSummary build={opt.baseline.build} />
          </p>
          <p>
            Recommended: <BuildSummary build={opt.recommended} />
          </p>
          <p>{opt.comparison}</p>
          <h4>Upgrades, best gain per dollar first</h4>
          {opt.upgrades.length === 0 ? (
            <p className="rs-empty">No valid swap improves the deck inside your limits.</p>
          ) : (
            <ol>
              {opt.upgrades.map((u) => (
                <li key={`${u.swap.add}-${u.swap.cut}`}>
                  +{u.swap.add} / −{u.swap.cut} · {u.free ? 'already owned or free' : formatCents(u.costCents)} · gain{' '}
                  <Num n={{ value: u.gain, label: 'HEURISTIC_SCORE' }} as="plain" />
                  {u.gainPerDollar !== null ? (
                    <>
                      {' '}
                      · gain per dollar <Num n={{ value: u.gainPerDollar, label: 'HEURISTIC_SCORE' }} as="plain" />
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <h4>Non-dominated builds ({opt.frontier.length})</h4>
          <ul>
            {opt.frontier.map((b) => (
              <li key={b.key}>
                <BuildSummary build={b} />
              </li>
            ))}
          </ul>
          <p className="rs-meta">
            Searched {opt.searched.scored} builds over {opt.searched.levels} level(s); {opt.searched.rejected} rejected before
            scoring. {opt.notes.join(' ')}
          </p>
        </section>
      ) : null}
    </div>
  );
}
