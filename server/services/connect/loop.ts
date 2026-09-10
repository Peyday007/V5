/**
 * Keeping the delta feed honest.
 *
 * A connected site asks "what has changed since I last looked", and the answer
 * is ordered by the link row's own timestamp. An import moves that timestamp;
 * a *mission* starting, an audit landing or a person answering a Needs You
 * request does not, because none of them touches the link. Without something
 * closing that gap a site would see imports promptly and research progress
 * never — which is the usual way a poll-based projection quietly goes wrong.
 *
 * So this tick derives the projection for the records that have one, compares
 * it to the last state the site could have seen, and touches the row only when
 * the answer has actually changed. Two properties follow, and both matter:
 *
 *   * a tick over an unchanged Brain writes nothing at all, so the feed stays
 *     quiet and the site's poll finds an empty page;
 *   * a state change becomes visible within one tick, without anything that
 *     moved the work having to remember to say so.
 *
 * It is a plain interval over two indexed reads. No model, no provider, no
 * network: an idle Brain spends nothing here, and nothing in it can start
 * paid work.
 */
import { refreshProjections } from './service.ts';

/**
 * Five seconds.
 *
 * The assignment's own target for an important state change is under five
 * seconds where existing infrastructure makes it practical, and here it does:
 * the tick is two indexed queries and a comparison. The site's own cadence is
 * the site's business — this only decides how quickly Brain is *able* to
 * answer, and being slower than the consumer would make the target
 * unreachable however often it asked.
 */
export const CONNECT_TICK_MS = 5_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startConnectRefresh(intervalMs = CONNECT_TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    // One tick at a time. A slow tick must not have a second one start behind
    // it and touch the same rows twice — harmless but noisy, and noise in a
    // delta feed is the thing a consumer cannot tell from a real change.
    if (running) return;
    running = true;
    void refreshProjections({})
      .catch(() => {
        /* swallowed: a throwing timer callback takes the process down, and an
           unattended Brain that dies because one projection could not be
           derived is worse than one that skips a tick. */
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
}

export function stopConnectRefresh(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
