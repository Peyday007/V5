/**
 * Asking again whether the cloud answers, after a boot where it did not.
 *
 * §18: cloud mode never falls back. A Postgres that cannot be reached or a
 * bucket that does not answer stops the boot with the reason — and until this
 * module, it stopped it **for ever**. The process served the error, Fly's
 * health checks marked the machine unhealthy, and nothing restarts a machine
 * for failing a health check. So a two-minute Supabase blip at the moment of a
 * deploy became an outage that lasted until somebody deployed again: deploys
 * 319, 324 and 334 each did exactly that, the last with the database answering
 * again within the hour and the Brain still serving `503` behind it.
 *
 * What §18 forbids is *falling back* — serving as healthy anything that is not
 * the real thing. Asking the real thing again is not that: every attempt runs
 * the identical proof (a real query, a real bucket listing), nothing is served
 * but the error until one succeeds, and the retry is bounded in how often it
 * asks rather than in how long it keeps asking, because an outage has no
 * deadline Brain could know.
 *
 * Pure over an injected clock and attempt, so the schedule is asserted rather
 * than slept through.
 */

export const BOOT_RETRY_FIRST_MS = 15_000;
export const BOOT_RETRY_MAX_MS = 5 * 60_000;

/** The wait before attempt `n` (1-based): doubling from the first, capped. */
export function bootRetryDelay(attempt: number): number {
  const doubled = BOOT_RETRY_FIRST_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(doubled, BOOT_RETRY_MAX_MS);
}

export interface BootRetryOptions<T> {
  /** The same proof boot ran. Throws while the cloud does not answer. */
  attempt: () => Promise<T>;
  /** Called exactly once, with the first proof that succeeded. */
  onRecovered: (value: T) => Promise<void>;
  /** Told about every failed attempt, so the log says the Brain is still asking. */
  onFailed?: (attempt: number, error: Error, nextDelayMs: number) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
}

/**
 * Keep proving until the proof holds, then hand over once. Returns a stop
 * function; nothing is asked after it is called.
 */
export function retryBoot<T>(options: BootRetryOptions<T>): () => void {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  let stopped = false;
  let attempt = 0;

  const next = (): void => {
    attempt += 1;
    schedule(() => void run(), bootRetryDelay(attempt));
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    let value: T;
    try {
      value = await options.attempt();
    } catch (error) {
      if (stopped) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      options.onFailed?.(attempt, failure, bootRetryDelay(attempt + 1));
      next();
      return;
    }
    if (stopped) return;
    stopped = true;
    await options.onRecovered(value);
  };

  next();
  return () => {
    stopped = true;
  };
}
