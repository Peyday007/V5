/** Design: a rough idea becomes structured fields, conflicts and at most one question. */
import { useState } from 'react';
import { MagicApi, formatCents, type DesignIntentView } from '../../lib/magicApi.ts';
import { ErrorLine, errorText } from './shared.tsx';

export function DesignSection({ onBuilt }: { onBuilt: (deckId: string) => void }): JSX.Element {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [intent, setIntent] = useState<DesignIntentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const s = intent?.structured;
  return (
    <div className="rs-stack">
      <section className="rs-card">
        <h3>Describe a deck</h3>
        <label>
          What do you want the deck to do?
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void run(async () => setIntent(await MagicApi.design({ text })))}
        >
          {busy ? 'Working…' : intent ? 'Start over with this text' : 'Structure this idea'}
        </button>
        <ErrorLine message={error} />
      </section>
      {intent && s ? (
        <section className="rs-card" aria-label="Structured strategy">
          <h3>Strategy ({intent.state.toLowerCase().replace('_', ' ')})</h3>
          <dl className="rs-magic-fields">
            <dt>Format</dt>
            <dd>{s.format.toLowerCase()}</dd>
            <dt>Primary outcome</dt>
            <dd>{s.primaryOutcome}</dd>
            <dt>Archetypes</dt>
            <dd>{s.archetypes.join(', ') || 'none detected'}</dd>
            <dt>Win engines</dt>
            <dd>{s.winEngines.join(', ') || 'none named yet'}</dd>
            <dt>Hard constraints</dt>
            <dd>{s.hardConstraints.join('; ') || 'none'}</dd>
            <dt>Adjustable weights</dt>
            <dd>{s.adjustableWeights.map((w) => `${w.name} ${w.weight}`).join(', ') || 'none'}</dd>
            <dt>Risk</dt>
            <dd>{s.risk}</dd>
            <dt>Budget</dt>
            <dd>{s.budgetCents === null ? 'not set' : formatCents(s.budgetCents)}</dd>
          </dl>
          {intent.assumptions.length > 0 ? (
            <div>
              <h4>Provisional assumptions</h4>
              <ul>
                {intent.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {intent.conflicts.length > 0 ? (
            <div role="alert" className="rs-magic-issues">
              <h4>Goals that pull against each other</h4>
              <ul>
                {intent.conflicts.map((c) => (
                  <li key={c.title}>
                    <strong>{c.title}</strong> — {c.cost}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {intent.alternatives.length > 0 ? (
            <div>
              <h4>Coherent alternatives</h4>
              <ul>
                {intent.alternatives.map((a, i) => (
                  <li key={a.title}>
                    <strong>{a.title}</strong>: {a.tradeoffs.join('; ')}{' '}
                    <button
                      type="button"
                      disabled={busy || intent.state === 'NEEDS_DECISION'}
                      onClick={() =>
                        void run(async () => {
                          const out = await MagicApi.buildFromDesign(intent.id, i);
                          onBuilt(out.deck.id);
                        })
                      }
                    >
                      Build this one
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {intent.question ? (
            <div>
              <p>
                <strong>One decision:</strong> {intent.question}
              </p>
              <label>
                Your answer
                <input value={answer} onChange={(e) => setAnswer(e.target.value)} />
              </label>
              <button
                type="button"
                disabled={busy || !answer.trim()}
                onClick={() =>
                  void run(async () => {
                    setIntent(await MagicApi.design({ text, intentId: intent.id, answer }));
                    setAnswer('');
                  })
                }
              >
                Answer and refine
              </button>
            </div>
          ) : intent.state === 'COHERENT' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const out = await MagicApi.buildFromDesign(intent.id);
                  onBuilt(out.deck.id);
                })
              }
            >
              Build a deck from real cards
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
