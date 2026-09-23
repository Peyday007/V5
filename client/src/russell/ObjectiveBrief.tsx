/**
 * The decision brief for one objective, live.
 *
 * Rendered from the server's own derivation on every read of the thread, so a
 * step that has since finished, a grant that has since been set or an opening
 * that has since closed shows here without anybody asking again. Every sentence
 * is the server's; this composes none of its own, because a screen that
 * paraphrased a recommendation would eventually paraphrase it wrongly.
 *
 * Four kinds of statement stay visibly apart — sourced, measured, Brain's
 * estimate, a person's decision — and an unknown is written as unknown. There
 * is no percentage and no score anywhere on it.
 */
import { useState } from 'react';
import type { DecisionBrief } from '../../../server/services/decision/brief.ts';
import { RussellApi } from '../lib/russellApi.ts';

const KIND: Record<string, string> = {
  FACT: 'sourced',
  MEASURED: 'measured',
  ESTIMATE: 'estimate',
  DECISION: 'decided',
  UNKNOWN: 'unknown',
};

const READING: Record<string, string> = {
  MET: 'met',
  NOT_MET: 'not met',
  UNKNOWN: 'unknown',
  NEEDS_PERSON: 'needs a person',
  NOT_APPLICABLE: 'n/a',
};

const STEP: Record<string, string> = {
  NOT_STARTED: 'Not started yet',
  RUNNING: 'Running',
  WAITING_ON_PERSON: 'Waiting on you',
  FINISHED: 'Finished',
  STOPPED: 'Stopped',
};

export function ObjectiveBrief({
  brief,
  onChanged,
}: {
  brief: DecisionBrief;
  onChanged?: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function recheck(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await RussellApi.advanceObjective(brief.objective.id);
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not re-check this objective.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rs-objective"
      aria-label={`Decision for: ${brief.objective.statement}`}
      data-verdict={brief.verdict}
    >
      <header className="rs-objective-head">
        <p className="rs-objective-label">
          Objective ·{' '}
          {brief.objective.sourceKind === 'CASH_MODE' ? 'recorded on the Cash Mode sprint' : 'as you stated it'}
        </p>
        <h3 className="rs-objective-statement">{brief.objective.statement}</h3>
        <p className="rs-objective-headline" role="status">
          {brief.headline}
        </p>
      </header>

      {brief.reasons.length > 0 ? (
        <ul className="rs-objective-reasons">
          {brief.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {brief.currentStep ? (
        <div className="rs-objective-step" data-status={brief.currentStep.status}>
          <span className="rs-objective-step-status">{STEP[brief.currentStep.status]}</span>
          <p>
            <strong>Next step:</strong> {brief.currentStep.step.description}
          </p>
          <p className="rs-objective-step-detail">{brief.currentStep.detail}</p>
        </div>
      ) : null}

      {brief.needsPerson.length > 0 ? (
        <div className="rs-objective-needs">
          <h4>Needs you or an integration</h4>
          <ul>
            {brief.needsPerson.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {brief.leading ? (
        <details className="rs-objective-leading" open={brief.verdict === 'RECOMMEND'}>
          <summary>
            Leading path: {brief.leading.title}
            <span className="rs-objective-standing"> — {brief.leading.standing.toLowerCase()}</span>
          </summary>
          <p>{brief.leading.because}</p>
          <table className="rs-objective-tests">
            <tbody>
              {brief.leading.tests
                .filter((test) => test.reading !== 'NOT_APPLICABLE')
                .map((test) => (
                  <tr key={test.criterion} data-reading={test.reading}>
                    <th scope="row">{test.criterion.toLowerCase()}</th>
                    <td>{READING[test.reading]}</td>
                    <td className="rs-objective-kind">{KIND[test.kind]}</td>
                    <td>
                      {test.statement}
                      {test.evidenceRef ? <code className="rs-objective-ref"> {test.evidenceRef}</code> : null}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {brief.leading.economics.length > 0 ? (
            <ul className="rs-objective-economics" aria-label="Economics and effort">
              {brief.leading.economics.map((figure) => (
                <li key={figure.label}>
                  {figure.label}: {figure.value ?? 'not established'}{' '}
                  <span className="rs-objective-kind">({KIND[figure.kind]})</span>
                  {figure.basis ? <span className="rs-objective-basis"> — {figure.basis}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}

      {brief.alternatives.length > 0 ? (
        <details className="rs-objective-alternatives">
          <summary>Alternatives ({brief.counts.live - 1} live)</summary>
          <ul>
            {brief.alternatives.map((alt) => (
              <li key={alt.ref}>
                <strong>{alt.title}</strong> — ranks lower because {alt.whyLower}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {brief.rejected.length > 0 ? (
        <details className="rs-objective-rejected">
          <summary>Rejected on evidence ({brief.rejected.length})</summary>
          <ul>
            {brief.rejected.map((one) => (
              <li key={one.ref}>
                <strong>{one.title}</strong> — {one.because}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="rs-objective-watch">
        <h4>What would change this</h4>
        <ul>
          {brief.watch.continueIf ? <li>Continue if {brief.watch.continueIf}</li> : null}
          {brief.watch.reviseIf ? <li>Revise if {brief.watch.reviseIf}</li> : null}
          {brief.watch.stopIf ? <li>Stop if {brief.watch.stopIf}</li> : null}
        </ul>
      </div>

      {brief.history.length > 1 ? (
        <details className="rs-objective-history">
          <summary>How the recommendation changed ({brief.history.length})</summary>
          <ol>
            {brief.history.map((one) => (
              <li key={one.id}>
                <time dateTime={one.createdAt}>{one.createdAt.slice(0, 16).replace('T', ' ')}</time> —{' '}
                {one.summary}
                {one.changedBecause ? <span className="rs-objective-basis"> ({one.changedBecause})</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      <footer className="rs-objective-foot">
        <button type="button" onClick={() => void recheck()} disabled={busy}>
          {busy ? 'Re-checking…' : 'Re-check now'}
        </button>
        {error ? <span role="alert">{error}</span> : null}
      </footer>
    </section>
  );
}
