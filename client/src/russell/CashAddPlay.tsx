/**
 * "Add a play": put an opening a person names into this sprint's portfolio.
 *
 * Until this existed the capture route had no control on the page, so the only
 * openings a sprint could hold were the ones discovery found. A person who knew
 * exactly which play they wanted run had nowhere to say so, and a worker cannot
 * say it for them — §22, a machine may not create its own work.
 *
 * The four plays arrive prefilled (§24: a proposal to approve, not a form to
 * fill in), and a play already in the portfolio says so instead of offering a
 * second copy. A custom play is the same call with the fields typed. Nothing
 * here decides anything: the route re-checks the person, the project write and
 * whether the sprint is open to new openings, and its refusal is shown as the
 * server wrote it.
 */
import { useState } from 'react';
import { CASH_MECHANISMS } from '../../../server/domain/types.ts';
import { CashApi } from '../lib/cashApi.ts';
import { CASH_PLAYS, PLAY_SOURCE, type CashPlay } from './cashPlays.ts';

export function AddPlay({
  projectId,
  currency,
  existingTitles,
  onChanged,
}: {
  projectId: string;
  currency: string;
  existingTitles: readonly string[];
  onChanged(): void;
}): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [mechanism, setMechanism] = useState<string>('OTHER');
  const [nextAction, setNextAction] = useState('');

  const have = new Set(existingTitles.map((one) => one.trim().toLowerCase()));

  async function add(key: string, body: Parameters<typeof CashApi.capture>[1]): Promise<boolean> {
    setBusy(key);
    setProblem(null);
    setDone(null);
    try {
      const result = await CashApi.capture(projectId, body);
      setDone(`“${result.opportunity.title}” added. ${result.message}`);
      onChanged();
      return true;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addPlay(play: CashPlay): Promise<void> {
    await add(play.key, {
      title: play.title,
      mechanism: play.mechanism,
      currency,
      industry: play.industry,
      source: PLAY_SOURCE,
      nextAction: play.nextAction,
      stopRule: play.stopRule,
    });
  }

  async function addCustom(): Promise<void> {
    const added = await add('custom', {
      title: title.trim(),
      mechanism,
      currency,
      source: PLAY_SOURCE,
      ...(nextAction.trim() ? { nextAction: nextAction.trim() } : {}),
    });
    if (!added) return;
    setTitle('');
    setNextAction('');
  }

  return (
    <details className="rs-cash-add-play">
      <summary>Add a play</summary>
      <p className="rs-hint">
        A play enters the portfolio like anything discovery found: Brain fills its card, researches
        what is missing, and acts only inside the standing commercial grant. Adding one spends
        nothing and contacts nobody.
      </p>
      <ul className="rs-list">
        {CASH_PLAYS.map((play) => {
          const added = have.has(play.title.trim().toLowerCase());
          return (
            <li key={play.key} className="rs-row" data-play={play.key}>
              <span className="rs-item-title">{play.title}</span>
              <span className="rs-item-meta">{play.summary}</span>
              {added ? (
                <span className="rs-item-meta">Already in this portfolio.</span>
              ) : (
                <button type="button" disabled={busy !== null} onClick={() => void addPlay(play)}>
                  {busy === play.key ? 'Adding…' : 'Add this play'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="rs-cash-actions">
        <label className="rs-field-label" htmlFor="cash-play-title">
          Or name your own play
        </label>
        <input id="cash-play-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <label className="rs-field-label" htmlFor="cash-play-mechanism">
          How it makes money
        </label>
        <select
          id="cash-play-mechanism"
          value={mechanism}
          onChange={(event) => setMechanism(event.target.value)}
        >
          {CASH_MECHANISMS.map((one) => (
            <option key={one} value={one}>
              {one.toLowerCase().replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <label className="rs-field-label" htmlFor="cash-play-next">
          First step (optional)
        </label>
        <input id="cash-play-next" value={nextAction} onChange={(event) => setNextAction(event.target.value)} />
        <button
          type="button"
          disabled={busy !== null || title.trim().length < 4}
          onClick={() => void addCustom()}
        >
          {busy === 'custom' ? 'Adding…' : 'Add play'}
        </button>
      </div>
      {problem ? <p className="rs-state rs-state-error">{problem}</p> : null}
      {done ? <p className="rs-hint">{done}</p> : null}
    </details>
  );
}
