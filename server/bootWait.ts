/**
 * Waiting for a cloud dependency at boot, instead of giving up on the first
 * slow answer.
 *
 * Deploy #319 (2026-09-23) is the reason this exists. The new image started,
 * its one bucket probe got `HTTP 544 {"error":"DatabaseTimeout"}` from
 * Supabase's storage API, and `main()` handed that single answer to
 * `serveMigrationFailure` — an error server that answers 500 to everything,
 * `/healthz` included, **for the life of the process**. Nothing ever asked the
 * bucket again. So the machine reached `started`, Fly's health check stayed
 * critical, `flyctl deploy` timed out after five minutes, and the machine stayed
 * unhealthy until something restarted it. The previous image had done exactly
 * the same thing eight minutes earlier, on the same 544.
 *
 * The error server is right for a *configuration* failure — a missing bucket,
 * a rejected key, a wrong host — because nothing will change until a person
 * changes something, and the page says what. It is wrong for a failure that
 * ends by itself: that is a Brain that could have booted a minute later and
 * instead reports itself broken until somebody notices.
 *
 * So a transient failure is asked again, with a capped backoff and a line in
 * the log every time, and the boot continues the moment the dependency
 * answers. Two things do not change:
 *
 * - **Nothing falls back** (§18). Waiting is not serving: nothing listens on the
 *   port while Brain waits, so the platform's health check is honestly failing
 *   rather than reporting a Brain that cannot reach its data as up.
 * - **A configuration failure is not retried.** It is thrown straight through
 *   to the error page, on the first attempt, exactly as before.
 *
 * There is deliberately no attempt ceiling. A ceiling would end in either the
 * error page — the defect this replaces — or an exit that the platform restarts
 * into the same wait. The dependency being down is the whole of the reason the
 * Brain is not ready, and the moment it is not down the Brain is.
 */

export interface WaitOptions {
  /** Delays between attempts, in milliseconds; the last one repeats. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** 2s, 4s, 8s, 15s, then every 30s. */
export const BOOT_WAIT_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000, 30_000];

/** True only of an error that carries `transient: true` — both configuration errors can. */
export function isTransientBootFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { transient?: unknown }).transient === true
  );
}

/**
 * Run `attempt` until it succeeds or fails for a reason that is not transient.
 * A non-transient failure is rethrown unchanged, on whichever attempt it
 * happens, so the caller's error handling sees exactly what it saw before.
 */
export async function untilAvailable<T>(
  what: string,
  attempt: () => Promise<T>,
  options: WaitOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? BOOT_WAIT_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? ((line: string) => console.error(line));

  for (let failures = 0; ; failures += 1) {
    try {
      const value = await attempt();
      if (failures > 0) {
        log(`[brain] ${what} answered after ${failures} failed attempt(s); continuing the boot.`);
      }
      return value;
    } catch (error) {
      if (!isTransientBootFailure(error)) throw error;
      const delay = delays[Math.min(failures, delays.length - 1)] ?? 30_000;
      const message = error instanceof Error ? error.message : String(error);
      const detail = (error as { detail?: unknown }).detail;
      log(
        `[brain] ${what} did not answer (attempt ${failures + 1}): ${message}` +
          (typeof detail === 'string' && detail ? ` ${detail}` : '') +
          ` Not serving and not falling back; asking again in ${Math.round(delay / 1000)}s.`,
      );
      await sleep(delay);
    }
  }
}
