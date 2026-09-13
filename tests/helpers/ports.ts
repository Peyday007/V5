/**
 * A port a suite's own `fetch` is willing to talk to.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to close, which cost three full test runs to find
 * ---------------------------------------------------------------------------
 *
 * `tests/factoryPersistence.test.ts` picked `6600 + random(100)` and failed
 * intermittently with "server never became healthy" after a ten-minute wait —
 * while its own captured boot log showed fifty migrations applied, the
 * administrator created, and the banner printed. The banner is `listen`'s own
 * callback, so the server was genuinely listening the whole time.
 *
 * The WHATWG fetch specification refuses a **bad port** before it opens a
 * socket, and Node's `fetch` implements it. `6665`–`6669`, `6679` and `6697`
 * are on that list, so `fetch('http://localhost:6668/healthz')` throws
 * `TypeError: fetch failed` with `cause: Error: bad port` — always, on a
 * perfectly healthy server. A `catch {}` in the polling loop swallowed the
 * cause and the loop simply retried for ten minutes.
 *
 * The three failing runs picked **6665, 6668 and 6666**; the run that passed
 * picked something else. Reproduced directly before this was written:
 *
 *     6664 -> connect ECONNREFUSED      6668 -> bad port
 *     6665 -> bad port                  6670 -> connect ECONNREFUSED
 *
 * Two hypotheses were tested and refuted on the way, and both are worth
 * recording because each *looked* right. **CPU starvation**: eight busy loops
 * on four cores make that suite take 14.5s against 4.6s quiet — three times
 * slower, not the hundred and thirty a ten-minute timeout needs. **A child
 * that died after booting**: an exit watcher was added and never fired. A
 * third diagnostic — a raw TCP connect to the port — would have *succeeded*
 * and produced a fourth wrong answer, "listening but not answering HTTP",
 * because the server was listening and it was the client that refused.
 *
 * ---------------------------------------------------------------------------
 * Why a shared helper rather than a fix in one file
 * ---------------------------------------------------------------------------
 *
 * Two other suites are exposed to the same lottery: `mcpExternalClient` can
 * pick `6000` and `oauth` can pick `6566`, both of which are on the list. A
 * per-file fix leaves those two waiting to fail, and this repository has
 * written down four times already that a rule applied by one of several
 * readers is worse than none.
 */

/**
 * The ports `fetch` refuses outright, from the WHATWG fetch specification's
 * bad-port list. Copied in full rather than filtered to the ranges in use:
 * a future suite picks a new range, and a list that had been trimmed to
 * today's ranges would quietly stop protecting it.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/**
 * One port from `[base, base + span)` that `fetch` will actually dial.
 *
 * Deterministic in its refusal rather than its choice: the port is still
 * random, so two suites that overlapped would still be caught by colliding,
 * and `deploymentOwnership` still refuses overlapping ranges. What is no
 * longer random is whether the port is usable at all.
 *
 * Throws when the whole range is blocked, because silently returning a
 * blocked port is how this cost three runs in the first place — a range with
 * no usable port is a mistake in the range, and it should say so at the first
 * import rather than one time in ten.
 */
export function pickPort(base: number, span: number): number {
  const usable: number[] = [];
  for (let port = base; port < base + span; port += 1) {
    if (!FETCH_BLOCKED_PORTS.has(port)) usable.push(port);
  }
  if (usable.length === 0) {
    throw new Error(
      `every port in [${base}, ${base + span}) is on the fetch bad-port list, so no server ` +
        'started here could ever be reached. Choose a different range.',
    );
  }
  return usable[Math.floor(Math.random() * usable.length)]!;
}
