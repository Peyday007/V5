/** Optimize: analysis (labelled numbers) and the multi-objective optimizer. */
import { useState } from 'react';
import {
  MagicApi,
  formatCents,
  parseDollars,
  type AnalysisView,
  type OptimizeView,
  type OptimizeWeights,
} from '../../lib/magicApi.ts';
import { useAsync } from '../useAsync.ts';
import { ErrorLine, Gate, Num, StaleNote, errorText } from './shared.tsx';

const WEIGHT_NAMES: [keyof OptimizeWeights, string][] = [
  ['consistency', 'Consistency'],
  ['earlyDevelopment', 'Early development'],
  ['threatsAnswered', 'Threats answered'],
  ['survival', 'Survival'],
  ['closing', 'Independent closing'],
  ['pointsPotential', 'Points potential'],
  ['price', 'Price'],
  ['preference', 'Preference match'],
];

const DEFAULT_WEIGHTS: OptimizeWeights = {
  consistency: 1, earlyDevelopment: 1, threatsAnswered: 1, survival: 1,
  closing: 1, pointsPotential: 1, price: 1, preference: 1,
};

export function OptimizeSection({ initialDeckId }: { initialDeckId: string | null }): JSX.Element {
  const decks = useAsync(() => MagicApi.decks(), []);
  const [picked, setPicked] = useState<string | null>(initialDeckId);
  const [weights, setWeights] = useState<OptimizeWeights>(DEFAULT_WEIGHTS);
  const [budget, setBudget] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [result, setResult] = useState<OptimizeView | null>(null);
  const [busy, setBusy] = useState<'analyze' | 'optimize' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const budgetCents = budget.trim() === '' ? null : parseDollars(budget);
  const budgetInvalid = budget.trim() !== '' && budgetCents === null;

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

  return (
    <div className="rs-stack">
      <section className="rs-card">
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
        <fieldset>
          <legend>Weights (adjustable — they change the ranking, never the rules)</legend>
          {WEIGHT_NAMES.map(([key, label]) => (
            <label key={key}>
              {label} {weights[key]}
              <input
                type="range"
                min={0}
                max={5}
                value={weights[key]}
                onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </fieldset>
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
                if (picked) setResult(await MagicApi.optimize({ deckId: picked, weights, budgetCents }));
              })
            }
          >
            {busy === 'optimize' ? 'Searching…' : 'Find upgrades'}
          </button>
        </div>
        <ErrorLine message={error} />
      </section>

      {analysis ? (
        <section className="rs-card" aria-label="Analysis">
          <h3>Analysis</h3>
          <StaleNote freshness={analysis.freshness} />
          <p className="rs-meta">{analysis.librarySize}-card library; the command zone is counted separately.</p>
          <p>
            Keepable opening hand: <Num n={analysis.openingHand.keepable} />
          </p>
          <ul>
            {Object.entries(analysis.scores).map(([name, value]) => (
              <li key={name}>
                {name}: <Num n={value} />
              </li>
            ))}
            {analysis.answers.map((a) => (
              <li key={a.type}>
                {a.type} answer by turn 6 ({a.count} in deck): <Num n={a.byTurn6} />
              </li>
            ))}
          </ul>
          {analysis.redundancy.some((r) => r.thin) ? (
            <p role="status">
              Thin: {analysis.redundancy.filter((r) => r.thin).map((r) => r.role).join(', ')}
            </p>
          ) : null}
          {analysis.simulation ? (
            <p className="rs-meta">
              Simulation: {analysis.simulation.runs} runs, seed {analysis.simulation.seed}
              {analysis.simulation.mulliganPolicy ? `, ${analysis.simulation.mulliganPolicy}` : ''}.
              {(analysis.simulation.assumptions ?? []).join(' ')}
            </p>
          ) : null}
          {analysis.notes.map((n) => (
            <p key={n} className="rs-meta">
              {n}
            </p>
          ))}
        </section>
      ) : null}

      {result ? (
        <section className="rs-card" aria-label="Optimizer result">
          <h3>Candidates against your unchanged deck</h3>
          <StaleNote freshness={result.freshness} />
          {result.rejected.count > 0 ? (
            <p className="rs-meta">
              {result.rejected.count} candidates were invalid before scoring ({result.rejected.reasons.join('; ')}).
            </p>
          ) : null}
          {result.candidates.length === 0 ? (
            <p className="rs-empty">No valid candidate beats the baseline inside your limits.</p>
          ) : (
            <ol>
              {result.candidates.map((c) => (
                <li key={c.id}>
                  <strong>{c.frontier ? 'Non-dominated: ' : ''}</strong>
                  add {c.adds.map((a) => `${a.name} (${formatCents(a.priceCents)}${a.priceStatus === 'ESTIMATE' ? ', estimate' : ''})`).join(', ') || 'nothing'}; cut{' '}
                  {c.cuts.map((x) => x.name).join(', ') || 'nothing'}; total {formatCents(c.totalCostCents)}
                  {c.gainPerDollar ? (
                    <>
                      {' '}
                      · gain per dollar <Num n={c.gainPerDollar} as="plain" />
                    </>
                  ) : null}
                  <ul>
                    {c.tradeoffs.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
