/**
 * Design: a rough idea becomes a structured strategy, its conflicts named with
 * coherent alternatives and at most one question. Only a coherent strategy can
 * be built, and only from real catalog cards; the build is then saved as an
 * ordinary deck through the import route, so it is versioned like any other.
 */
import { useState } from 'react';
import {
  MagicApi,
  deckListText,
  formatCents,
  type BuildResponse,
  type BuiltCard,
  type DesignPlanResponse,
  type HardConstraintView,
  type ImportReport,
} from '../../lib/magicApi.ts';
import { ErrorLine, StaleNote, errorText } from './shared.tsx';
import { ValidationBlock } from './Decks.tsx';

function constraintText(c: HardConstraintView): string {
  switch (c.kind) {
    case 'format':
      return `format ${c.format.toLowerCase()}`;
    case 'budget':
      return `budget ${formatCents(c.cents)}`;
    case 'colors':
      return `colors ${c.colors.join('')}`;
    case 'exclude':
      return `exclude ${c.name}`;
    default:
      return 'owned cards only';
  }
}

const STATE_TEXT: Record<string, string> = {
  DRAFT: 'draft',
  NEEDS_DECISION: 'needs a decision',
  COHERENT: 'coherent — ready to build',
  BUILT: 'built',
};

/** Built cards grouped by the role the builder gave each one. */
function BuiltList({ cards }: { cards: BuiltCard[] }): JSX.Element {
  const groups = new Map<string, BuiltCard[]>();
  for (const c of cards) {
    const key = c.zone === 'commander' ? 'commander' : /\bland\b/i.test(c.card.typeLine) ? 'land' : c.role;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <div className="rs-magic-built">
      {[...groups.entries()].map(([role, list]) => (
        <div key={role}>
          <h4>
            {role} ({list.reduce((n, c) => n + c.quantity, 0)})
          </h4>
          <ul>
            {list.map((c) => (
              <li key={`${c.zone}-${c.card.name}`}>
                {c.quantity} × {c.card.name} <span className="rs-meta">— {c.card.typeLine}. {c.why}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function DesignSection({ onSaved }: { onSaved: (deckId: string) => void }): JSX.Element {
  const [text, setText] = useState('');
  const [utterance, setUtterance] = useState('');
  const [plan, setPlan] = useState<DesignPlanResponse | null>(null);
  const [built, setBuilt] = useState<BuildResponse | null>(null);
  const [deckName, setDeckName] = useState('');
  const [saved, setSaved] = useState<ImportReport | null>(null);
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
  /** A new plan invalidates whatever was built from the previous one. */
  const replan = (next: DesignPlanResponse): void => {
    setPlan(next);
    setBuilt(null);
    setSaved(null);
  };

  const intent = plan?.intent;
  const buildCards = built?.build.cards ?? [];

  return (
    <div className="rs-stack">
      <section className="rs-card" aria-label="Describe a deck">
        <h3>Describe a deck</h3>
        <label>
          What do you want the deck to do?
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void run(async () => replan(await MagicApi.designIntent(text.trim())))}
        >
          {busy ? 'Working…' : plan ? 'Start over with this text' : 'Structure this idea'}
        </button>
        <ErrorLine message={error} />
      </section>

      {plan && intent ? (
        <section className="rs-card" aria-label="Structured strategy">
          <h3>Strategy — {STATE_TEXT[plan.state] ?? plan.state}</h3>
          <dl className="rs-magic-fields">
            <dt>Format</dt>
            <dd>{intent.format.toLowerCase()}</dd>
            <dt>Primary outcome</dt>
            <dd>{intent.primaryOutcome}</dd>
            <dt>Archetypes</dt>
            <dd>{intent.archetypes.join(', ') || 'none detected'}</dd>
            <dt>Speed</dt>
            <dd>{intent.speed ?? 'not stated'}</dd>
            <dt>Win engines</dt>
            <dd>{intent.winEngines.join(', ') || 'none named yet'}</dd>
            <dt>Wanted roles</dt>
            <dd>{intent.secondaryPreferences.join(', ') || 'none'}</dd>
            <dt>Hard constraints</dt>
            <dd>{intent.hardConstraints.map(constraintText).join('; ') || 'none'}</dd>
            <dt>Adjustable weights</dt>
            <dd>
              {Object.entries(intent.weights)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}
            </dd>
            <dt>Risk</dt>
            <dd>{intent.risk}</dd>
            <dt>Budget</dt>
            <dd>{intent.budgetCents === null ? 'not set' : formatCents(intent.budgetCents)}</dd>
          </dl>
          {plan.assumptions.length > 0 ? (
            <div>
              <h4>Provisional assumptions</h4>
              <ul>
                {plan.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {plan.conflicts.length > 0 ? (
            <div role="alert" className="rs-magic-issues" aria-label="Conflicts">
              <h4>Goals that pull against each other</h4>
              <ul>
                {plan.conflicts.map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong> — {c.cost}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {plan.question ? (
            <p>
              <strong>One decision:</strong> {plan.question.text}
            </p>
          ) : null}
          {plan.alternatives.length > 0 ? (
            <div aria-label="Alternatives">
              <h4>Coherent alternatives</h4>
              <ul>
                {plan.alternatives.map((a) => (
                  <li key={a.id}>
                    <strong>{a.title}</strong>: {a.summary}
                    <ul>
                      {a.tradeoffs.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => replan(await MagicApi.designChoose(intent, a.id, plan.intentId)))
                      }
                    >
                      Choose “{a.title}”
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <label>
            Refine in your own words
            <input
              value={utterance}
              placeholder="e.g. under $50, no blue, owned cards only"
              onChange={(e) => setUtterance(e.target.value)}
            />
          </label>
          <div className="rs-magic-actions">
            <button
              type="button"
              disabled={busy || !utterance.trim()}
              onClick={() =>
                void run(async () => {
                  replan(await MagicApi.designRefine(intent, utterance.trim(), plan.intentId));
                  setUtterance('');
                })
              }
            >
              Refine
            </button>
            {plan.state === 'COHERENT' || plan.state === 'BUILT' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setSaved(null);
                    setBuilt(await MagicApi.designBuild(intent));
                  })
                }
              >
                Build
              </button>
            ) : (
              <span className="rs-meta">Resolve the conflict above before building.</span>
            )}
          </div>
        </section>
      ) : null}

      {built && intent ? (
        <section className="rs-card" aria-label="Built deck">
          <h3>Built from real cards ({buildCards.reduce((n, c) => n + c.quantity, 0)} cards)</h3>
          <StaleNote catalog={built.catalog} />
          {built.build.commander ? <p>Commander: {built.build.commander.name}</p> : null}
          {built.build.issues.length > 0 ? (
            <ul className="rs-magic-issues">
              {built.build.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
          {built.build.validation ? (
            <ValidationBlock validation={built.build.validation} />
          ) : (
            <p className="rs-magic-issues">The build was not validated.</p>
          )}
          <BuiltList cards={buildCards} />
          <label>
            Deck name
            <input value={deckName} onChange={(e) => setDeckName(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={busy || !deckName.trim() || buildCards.length === 0}
            onClick={() =>
              void run(async () => {
                const textList = deckListText(
                  buildCards.map((c) => ({ zone: c.zone, quantity: c.quantity, name: c.card.name })),
                );
                setSaved(await MagicApi.importDeck({ name: deckName.trim(), format: intent.format, text: textList }));
              })
            }
          >
            Save as a deck
          </button>
          {saved ? (
            <p role="status">
              Saved “{saved.deck.name}” as version {saved.version.versionNumber}
              {saved.clean ? '.' : ' — with problems; open it to see them.'}{' '}
              <button type="button" onClick={() => onSaved(saved.deck.id)}>
                Open the saved deck
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
