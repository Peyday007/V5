/**
 * A model route's health, asked of the route itself — never of a work item.
 *
 * CAP-16-3, structural review (episode 4). Three repairs tuned the route breaker
 * in `worker.ts` (a consecutive count, then a failure ratio, then a durable
 * restore) and r01.cap-16-3 still read 57–67% of six hours' lane outcomes as
 * provider failures (2026-11-16 00:17Z → 2026-11-22 06:45Z). The breaker was
 * never the structure at fault: a held route was re-probed by admitting a real
 * work item onto it, and each provider failure cooled only that one item, so a
 * route outage was discovered once per re-probe and once per queued item — and
 * every discovery was a `FREE_LANE_ITEM` "model call failed" row, a lease, a
 * release and a re-queue. One outage was recorded as many item outcomes however
 * the breaker was tuned.
 *
 * Here a route is probed with one minimal completion through the lane's own
 * `Completer` — the same provider path, credentials and fallback the items use,
 * no new provider and no paid API — and the answer is recorded once, as a
 * `FREE_LANE_ROUTE_PROBE` row in the lane's existing `bin_events` store. No work
 * item is claimed, leased, released or failed by it. Nothing is hidden: a
 * failed probe is a provider failure, and the stage measurement counts it as one.
 *
 * Extends the free-lane owner: no new table, scheduler or queue. The worker's
 * tick decides when a held route is due (`nextReprobeDelay`) and feeds the
 * outcome to its breaker (`recordRouteOutcome`).
 */
import { recordBinEvent } from '../../repos/bins.ts';
import { redactCredentials } from '../effects/failureDetail.ts';
import type { Completer, LaneConfig } from '../cheap/lane.ts';

/** The `bin_events.event_type` a route probe is recorded under. */
export const ROUTE_PROBE_EVENT = 'FREE_LANE_ROUTE_PROBE';

/** The first re-probe of a held route, and the cap the backoff doubles up to. */
export const REPROBE_FIRST_MS = 5 * 60_000;
export const REPROBE_MAX_MS = 60 * 60_000;

/** A probe answers in seconds or the route is not healthy enough to be given work. */
export const PROBE_TIMEOUT_MS = 60_000;

const PROBE_SYSTEM = 'You are a health check. Reply with the JSON object you are asked for and nothing else.';
const PROBE_PROMPT = 'Reply exactly {"ok":true}';

/**
 * How long a held route waits before its next probe, given how many probes in a
 * row it has failed: 5 minutes, doubling, capped at an hour. Monotone; a
 * negative or non-finite count is read as none. Pure.
 */
export function nextReprobeDelay(consecutiveFailedProbes: number): number {
  const n = Number.isFinite(consecutiveFailedProbes) && consecutiveFailedProbes > 0 ? Math.floor(consecutiveFailedProbes) : 0;
  // 2^n overflows past the cap long before it loses precision; stop doubling at the cap.
  if (n >= 10) return REPROBE_MAX_MS;
  return Math.min(REPROBE_MAX_MS, REPROBE_FIRST_MS * 2 ** n);
}

export interface RouteProbeInput {
  completer: Completer;
  config: LaneConfig;
  /** The route (slot model) probed, as `FREE_LANE_ITEM` reasons name it. */
  model: string;
  /** Names the cause of a failure (`worker.ts` `classifyRouteFailure`), injected so this module does not import the worker. */
  classify: (message: string) => string;
  /** Cuts credentials out of a provider's message (`worker.ts` `redactSecrets`); credential redaction is applied in any case. */
  redact?: (text: string) => string;
  /** The worker and session the probe is attributed to, when there is one. */
  workerId?: string | null;
  sessionRef?: string | null;
  now?: () => number;
}

export interface RouteProbeResult {
  ok: boolean;
  /** The classified cause of a failed probe; null when it answered. */
  cause: string | null;
  /** The reason recorded, in the `FREE_LANE_ITEM` shape: `model <route>` or `model <route>: model call failed [cause]: …`. */
  reason: string;
  elapsedMs: number;
}

/**
 * Asks a route one minimal question and records the answer as one
 * `FREE_LANE_ROUTE_PROBE` row. Any reply at all is an answering route — whether
 * the model writes good work is judged on the work, not here. Never throws:
 * a throwing completer is a failed probe, and the row write never throws.
 */
export async function probeRoute(input: RouteProbeInput): Promise<RouteProbeResult> {
  const clock = input.now ?? Date.now;
  const redact = input.redact ?? ((text: string) => text);
  const started = clock();
  let ok = false;
  let cause: string | null = null;
  let reason = `model ${input.model}`;
  let servedBy: string | null = null;
  try {
    await input.completer({ ...input.config, timeoutMs: Math.min(input.config.timeoutMs || PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS) }, input.model, PROBE_SYSTEM, PROBE_PROMPT, {
      maxTokens: 16,
      // On a GPU slot a failed GPU call falls back to the free model; the row says which one answered.
      onServed: (served) => {
        servedBy = served;
      },
    });
    ok = true;
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    cause = input.classify(message);
    const detail = redactCredentials(redact(message)).slice(0, 200);
    reason = `model ${input.model}: model call failed [${cause}]: ${detail}`.slice(0, 480);
  }
  const elapsedMs = Math.max(0, clock() - started);
  await recordBinEvent({
    eventType: ROUTE_PROBE_EVENT,
    workerId: input.workerId ?? null,
    sessionRef: input.sessionRef ?? null,
    outcome: ok ? 'OK' : 'FAILED',
    reason,
    durationMs: elapsedMs,
    evidenceClass: 'MEASURED',
    measures: { route: input.model, ...(servedBy ? { servedBy } : {}), ...(cause ? { cause } : {}) },
  });
  return { ok, cause, reason, elapsedMs };
}
