/** Pieces every Magic subsection uses: labelled numbers, stale and error states. */
import type { Freshness, Labelled, LabelledNumber } from '../../lib/magicApi.ts';
import { RETRY_DELAYS_MS, type AsyncResult } from '../useAsync.ts';

const LABEL_TEXT: Record<string, string> = {
  EXACT_PROBABILITY: 'Exact probability',
  MODEL_ESTIMATE: 'Model estimate',
  HEURISTIC_SCORE: 'Heuristic score — not a win rate',
  EMPIRICAL_MATCH_RESULT: 'Empirical match result',
};

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** A number with the kind of claim it is. A bare number is never rendered. */
export function Num({
  n,
  as = 'percent',
}: {
  n: (LabelledNumber | Labelled) & { low?: number; high?: number };
  as?: 'percent' | 'plain';
}): JSX.Element {
  const shown = as === 'percent' ? percent(n.value) : String(Math.round(n.value * 100) / 100);
  return (
    <span className="rs-magic-num" data-label={n.label}>
      <strong>{shown}</strong>
      {n.low !== undefined && n.high !== undefined ? (
        <span className="rs-magic-ci">
          {' '}
          ({as === 'percent' ? `${percent(n.low)}–${percent(n.high)}` : `${n.low}–${n.high}`})
        </span>
      ) : null}
      <span className="rs-magic-tag"> {LABEL_TEXT[n.label] ?? n.label}</span>
    </span>
  );
}

export function StaleNote({ freshness }: { freshness?: Freshness }): JSX.Element | null {
  if (!freshness) return null;
  if (!freshness.stale) {
    return freshness.fetchedAt ? (
      <p className="rs-magic-fresh">Card data fetched {freshness.fetchedAt}.</p>
    ) : null;
  }
  return (
    <p className="rs-magic-stale" role="status">
      Stale: the card source did not answer, so this uses the cached index
      {freshness.fetchedAt ? ` from ${freshness.fetchedAt}` : ''}. {freshness.note ?? ''}
    </p>
  );
}

/** Loading, forbidden, retrying and failed are four different screens. */
export function Gate<T>({
  query,
  children,
  what,
}: {
  query: AsyncResult<T>;
  children: (data: T) => JSX.Element;
  what: string;
}): JSX.Element {
  const { data, loading, error } = query;
  if (error && !data) {
    if (error.retryable) {
      return (
        <p className="rs-empty rs-magic-error" role="alert">
          Retrying: {error.message}{' '}
          <button type="button" onClick={query.reload}>
            Try again now
          </button>
        </p>
      );
    }
    return (
      <p className="rs-empty rs-magic-error" role="alert">
        {error.status === 404 ? `There is nothing here for you to see.` : error.message}{' '}
        <button type="button" onClick={query.reload}>
          Try again
        </button>
      </p>
    );
  }
  if (loading && !data) return <p className="rs-empty">Reading {what}…</p>;
  if (!data) return <p className="rs-empty">Reading {what}…</p>;
  return (
    <>
      {error ? (
        <p className="rs-magic-stale" role="status">
          Could not refresh ({error.message}); showing the last answer.
        </p>
      ) : null}
      {children(data)}
    </>
  );
}

export function ErrorLine({ message }: { message: string | null }): JSX.Element | null {
  return message ? (
    <p className="rs-magic-error" role="alert">
      {message}
    </p>
  ) : null;
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export { RETRY_DELAYS_MS };
