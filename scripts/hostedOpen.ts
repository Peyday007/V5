/**
 * Open the hosted verifier's database and document store, waiting out a
 * capacity refusal instead of reporting it as a failed deployment.
 *
 * The verifier runs inside the machine a Deploy has just restarted, and opens
 * its own connections while the new Brain is opening its pool. Supabase's
 * session pooler allows fifteen clients and its storage API answers 429
 * `too_many_connections` during that burst. Deploys 41288661910, 41370423114,
 * 41380565503 and 41416175495 all released correctly and then went red on
 * exactly this: the pass before the restart died opening its connection
 * (`EMAXCONNSESSION`, or storage `HTTP 429`), never ran a check and never left
 * its beacon, so the pass after the restart failed on "no beacon found" too. A
 * release that worked was reported as broken, and somebody was sent to look.
 *
 * Only a refusal that says "not now" is waited out, a bounded number of times.
 * A wrong password, a missing bucket or any other answer is thrown at once, so
 * nothing this verifier is for is weakened.
 */
import { bootRetryDelay } from '../server/bootRetry.ts';

const TRANSIENT = /EMAXCONNSESSION|max clients reached|too_many_connections|SlowDown|HTTP 429|ECONNRESET|ETIMEDOUT|ECONNREFUSED|Connection terminated unexpectedly/i;

/** Four waits: 15 s, 30 s, 60 s, 120 s — under four minutes in all. */
export const HOSTED_OPEN_ATTEMPTS = 5;

/** Whether an error is the store or pooler declining for now, by its own words. */
export function isTransientRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = (error as { detail?: unknown }).detail;
  const status = (error as { status?: unknown }).status;
  if (status === 429) return true;
  return TRANSIENT.test(`${error.message}\n${typeof detail === 'string' ? detail : ''}`);
}

export async function openPatiently<T>(
  label: string,
  open: () => Promise<T>,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? HOSTED_OPEN_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.log(line));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await open();
    } catch (error) {
      if (attempt >= attempts || !isTransientRefusal(error)) throw error;
      const wait = Math.min(bootRetryDelay(attempt), 120_000);
      log(
        `  ${label} declined for now (${(error as Error).message.slice(0, 120)}); ` +
          `attempt ${attempt}/${attempts}, waiting ${Math.round(wait / 1000)}s`,
      );
      await sleep(wait);
    }
  }
}
