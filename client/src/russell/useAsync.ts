/**
 * One async read, with its state kept honestly.
 *
 * Every view in the shell needs the same thing — call something, hold what
 * came back, and be able to say which of loading / ready / empty / forbidden /
 * error it is in. Written once so that no screen invents its own version and
 * gets the forbidden case wrong.
 *
 * The reload guard matters: a response that arrives after the caller moved on
 * is dropped rather than rendered, because showing the previous project's work
 * under the current project's heading is worse than showing nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api.ts';

export interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  /**
   * `retryable` says the failure is one asking again can fix (a database that
   * did not answer, a restart, a dropped connection). While it is true the hook
   * is already asking again on a bounded backoff — see `RETRY_DELAYS_MS`.
   */
  error: { status: number; message: string; retryable: boolean } | null;
  reload(): void;
}

/**
 * How long to wait before asking again after a temporary failure.
 *
 * Bounded on purpose: four attempts over about a minute and a quarter, then
 * the screen stays on the retrying state with its button. A page that polled a
 * struggling database for ever would be adding load to the condition it is
 * waiting out — Integration 3's rule that a dashboard must not create database
 * pressure to look live.
 */
export const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000] as const;

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AsyncResult<T>['error']>(null);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  /** Automatic retries spent since the last success or the last manual reload. */
  const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True only for a run the retry timer started. */
  const automatic = useRef(false);

  useEffect(() => {
    const mine = ++generation.current;
    // A new subject (deps changed) or a person pressing Try again gets a fresh
    // retry budget; an automatic retry spends the one it has. And an automatic
    // retry keeps the "retrying" state on screen rather than flickering to
    // "loading" and back every few seconds.
    if (automatic.current) {
      automatic.current = false;
    } else {
      retries.current = 0;
      setLoading(true);
      setError(null);
    }
    load().then(
      (value) => {
        if (generation.current !== mine) return;
        retries.current = 0;
        setData(value);
        setLoading(false);
      },
      (cause: unknown) => {
        if (generation.current !== mine) return;
        const next =
          cause instanceof ApiError
            ? { status: cause.status, message: cause.message, retryable: cause.retryable }
            : {
                status: 0,
                message: cause instanceof Error ? cause.message : String(cause),
                retryable: false,
              };
        // A temporary failure keeps what was already on screen: blanking a
        // page because one re-read hit a busy database is worse than showing
        // the last answer with a note that it is being refreshed.
        if (!next.retryable) setData(null);
        setError(next);
        setLoading(false);
        const delay = RETRY_DELAYS_MS[retries.current];
        if (next.retryable && delay !== undefined) {
          retries.current += 1;
          timer.current = setTimeout(() => {
            automatic.current = true;
            setNonce((value) => value + 1);
          }, delay);
        }
      },
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // `load` is rebuilt on every render by design; the caller's deps decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    automatic.current = false;
    setNonce((value) => value + 1);
  }, []);
  return { data, loading, error, reload };
}
