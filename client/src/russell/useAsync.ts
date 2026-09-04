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
  error: { status: number; message: string } | null;
  reload(): void;
}

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (generation.current !== mine) return;
        setData(value);
        setLoading(false);
      },
      (cause: unknown) => {
        if (generation.current !== mine) return;
        setData(null);
        setError(
          cause instanceof ApiError
            ? { status: cause.status, message: cause.message }
            : { status: 0, message: cause instanceof Error ? cause.message : String(cause) },
        );
        setLoading(false);
      },
    );
    // `load` is rebuilt on every render by design; the caller's deps decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload };
}
