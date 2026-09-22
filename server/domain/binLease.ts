import { type CompletionContract } from './types.ts';

/**
 * The shortest lease a bin's own contract can plausibly be satisfied under.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * A bin's lease was chosen entirely by the arriving worker. `brain_check_in`
 * takes `lease_ms`, `brain_bin_heartbeat` takes it again, and `heartbeatBin`
 * writes `lease_expires_at = now + clampBinLeaseMs(leaseMs)` — an assignment,
 * not an extension. So a heartbeat can *shorten* a lease, and the floor it is
 * clamped to is `MIN_BIN_LEASE_MS`, thirty seconds.
 *
 * Which is the wrong way round. The worker cannot know what the work costs;
 * the **contract** can, because the contract is the thing that says what must
 * be satisfied. `FACTORY_INTEGRATION_V1` is satisfied by merging the unit
 * branches and running *this repository's own commands* on the merged tree —
 * `npm run typecheck, npm run lint, npm test, npm run build` — and a worker
 * blocked inside `npm test` cannot heartbeat while it runs.
 *
 * Measured on `fcp_189ea30c7ded4e7b9280`, from `factory_sessions`:
 *
 *   ARCHITECT   FACTORY_PLAN_V1          695s
 *   IMPLEMENTER FACTORY_UNITS_V1        1803s   ← thirty minutes
 *   IMPLEMENTER FACTORY_UNITS_V1          68s
 *   IMPLEMENTER FACTORY_UNITS_V1          63s
 *   INTEGRATOR  FACTORY_INTEGRATION_V1  1051s   ← seventeen and a half minutes
 *   REVIEWER                             1011s
 *
 * against a `DEFAULT_BIN_LEASE_MS` of fifteen. The 1051s integration survived
 * because every heartbeat happened to land. The next one did not:
 * `bin_43915e4f93ca4e3db111` was taken over at 07:56:35, renewed four times,
 * and was retired `NEEDS_HUMAN` at 08:09:41 — *before* `takeover + 15min`,
 * which is only reachable if a renewal set a shorter expiry than the takeover
 * had. The worker was still alive and still working: its heartbeat at 08:13:01
 * is on the bin's own events as `BIN_STALE_WRITE — heartbeat after lease
 * loss`. Thirteen minutes of a real integration, discarded, and the bin's last
 * attempt with it.
 *
 * ---------------------------------------------------------------------------
 * Why a floor rather than a beat
 * ---------------------------------------------------------------------------
 *
 * §27 reached this conclusion already, one object along, and paid two
 * production deploys to learn it: a beat does not rescue a long step, because
 * the lease ends `DEFAULT_LEASE_MS` after the beat was *issued* rather than
 * after it landed — so the remedy is "a lease taken at claim time, which never
 * needs extending", and `RESEARCH_LEASE_MS` is an hour. This is the same
 * sentence at the bin, and the third time this codebase has needed it.
 *
 * It is a floor rather than a value: a worker may still ask for **more**,
 * because a long session is its own business, and can no longer ask for less
 * than the work Brain is about to demand of it. That is this repository's
 * recurring rule — the guard belongs on the value the claimant does not
 * supply.
 *
 * ---------------------------------------------------------------------------
 * The numbers
 * ---------------------------------------------------------------------------
 *
 * An hour for the three factory stages whose work checks this repository out
 * and runs its commands: roughly twice the measured ceiling, and the same hour
 * `RESEARCH_LEASE_MS` already uses for the same reason. `null` everywhere else
 * means *the default*, so nothing about any other bin changes — a contract
 * whose worker submits a structured answer after reading rows is not the
 * shape this is for, and widening it would strand those bins for an hour
 * apiece when a worker dies, buying nothing.
 *
 * A `Record` over the whole union rather than a lookup with a fallback, so a
 * contract added later is a compile error until somebody says what its work
 * costs — the shape `REFUSAL_WAIT` and `ESTABLISHES` already use here.
 */
const HOUR_MS = 60 * 60 * 1000;

export const CONTRACT_MIN_LEASE_MS: Record<CompletionContract, number | null> = {
  RESEARCH_PACKET_V1: null,
  DETERMINISTIC_UNITS_V1: null,
  SURFACE_PROBE_V1: null,
  RUSSELL_TURN_V1: null,
  RUSSELL_LENS_V1: null,
  // Checks the repository out and reads it to decompose an objective. 695s measured.
  FACTORY_PLAN_V1: HOUR_MS,
  // Writes code in a checkout and runs what it needs to. 1803s measured.
  FACTORY_UNITS_V1: HOUR_MS,
  // Merges and runs the contract's own commands on the merged tree. 1051s measured.
  FACTORY_INTEGRATION_V1: HOUR_MS,
  // Opens one pull request from a body Brain composed. No suite runs here.
  FACTORY_DELIVERY_V1: null,
  BLUEPRINT_EXTRACTION_V1: null,
  BLUEPRINT_AUDIT_V1: null,
  DESIGN_REVIEW_V1: null,
  DESIGN_RENDER_V1: null,
};

/**
 * The floor for one bin's contract, or null when its work is the ordinary shape.
 *
 * Takes a plain string because the column is a string: a row written by an
 * older deployment, or by a contract this build does not know, must read as
 * "no floor" rather than throwing inside an assignment.
 */
export function contractLeaseFloorMs(contract: string): number | null {
  return CONTRACT_MIN_LEASE_MS[contract as CompletionContract] ?? null;
}
