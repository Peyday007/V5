/**
 * Whether the database is answering well enough for Brain to start optional
 * work, decided from what this process has already felt.
 *
 * Brain cannot see the database host's CPU or disk budget; it can see how long
 * its own statements took and how many of them the database could not answer.
 * On 2026-10-13 those two readings were unambiguous: statements that take
 * milliseconds in healthy time took 60–150 s, the server's sessions waited on
 * `LWLock:WALWrite`, and pool, pooler and statement timeouts were felt
 * throughout — while Brain's own pool wait and event loop stayed near zero. In
 * that state every optional pass Brain starts is one more writer queued behind
 * the same write-ahead log as the work somebody is waiting on.
 *
 * The limits are this deployment's own bounds, not a universal target:
 *
 * - **Enter** when, over the last two minutes, the 90th percentile of a
 *   statement's total time (pool wait plus response) is at least
 *   `POOL_CHECKOUT_TIMEOUT_MS` — the time a queued caller is allowed to wait for
 *   a connection before it fails — or when three or more statements could not
 *   be answered at all. Past that point the callers behind a slow statement
 *   are timing out, which is the condition load shedding exists for.
 * - **Leave** only after five continuous minutes below the failure count and
 *   with a 90th percentile below a fifth of the entry bound. The hysteresis is what stops
 *   shedding from oscillating: deferring optional work is itself what makes
 *   the numbers recover.
 * - **Too few samples is no reading.** Fewer than `MIN_SAMPLES` statements in
 *   the window decides nothing, so a quiet process never sheds on two slow
 *   queries and never leaves on silence.
 *
 * Shedding changes which passes *start*. It never cancels work in flight, never
 * touches a lease, a queue item, a reservation or an authorization, and every
 * deferred pass derives from rows, so the next tick at NORMAL picks up exactly
 * where it would have.
 */
import { databaseFailuresSince, stalledMsSince, statementTimesSince, type InfraFailureKind } from './infra.ts';

export type DatabasePressure = 'NORMAL' | 'SHEDDING';

/** The workload pool's checkout timeout (`server/db/adapters/postgres.ts`). */
export const POOL_CHECKOUT_TIMEOUT_MS = 10_000;
export const WINDOW_MS = 120_000;
export const ENTER_P90_MS = POOL_CHECKOUT_TIMEOUT_MS;
export const LEAVE_P90_MS = POOL_CHECKOUT_TIMEOUT_MS / 5;
export const ENTER_FAILURES = 3;
export const RECOVER_AFTER_MS = 5 * 60_000;
export const MIN_SAMPLES = 20;
/*
 * The process's own event loop is the other half of "not keeping up". On
 * 2026-11-12 (Deploy 43170557687, a5096e5) the database answered at a p90
 * under the entry bound while this process stalled 2–12 s at a time — 42–55 s
 * of CPU in every 60 s, a fifth of it garbage collection — and every caller
 * queued behind the stalls, health checks included. Optional passes kept
 * starting because only the database was read. Enter when the loop was held
 * for as long as a queued caller may wait, summed over the window; leave only
 * when the stalls are below the leave bound, under the same hysteresis.
 */
export const ENTER_STALLED_MS = POOL_CHECKOUT_TIMEOUT_MS;
export const LEAVE_STALLED_MS = LEAVE_P90_MS;

/**
 * The failures that mean the database is not keeping up. A lost connection is
 * deliberately not one: the pooler closes idle and broken clients in ordinary
 * operation, and production (2026-10-14, `d5fce97`) felt a steady few every two
 * minutes with a 90th percentile of 68 ms, which counted as overload kept Brain
 * shedding long after the stall that started it had passed. Real overload
 * still shows as timeouts and as the 90th percentile.
 */
export const OVERLOAD_KINDS: ReadonlySet<InfraFailureKind> = new Set([
  'POOL_CHECKOUT_TIMEOUT',
  'POOLER_CHECKOUT_TIMEOUT',
  'POOLER_REFUSED',
  'STATEMENT_TIMEOUT',
  'DATABASE_UNAVAILABLE',
]);

export interface PressureReading {
  state: DatabasePressure;
  /** Why it is in this state, in words a report can print. */
  reason: string;
  p90Ms: number | null;
  samples: number;
  /** Failures in the window that mean overload (`OVERLOAD_KINDS`). */
  failures: number;
  /** Every felt failure in the window, by kind, overload or not. */
  byKind: Partial<Record<InfraFailureKind, number>>;
  since: string;
}

interface Window {
  times: number[];
  failures: number;
  /** Event-loop stall time in the window (stalls of 2 s or more). */
  stalledMs?: number;
  byKind?: Partial<Record<InfraFailureKind, number>>;
}

function p90(times: number[]): number | null {
  if (times.length === 0) return null;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
}

/** Overloaded right now, by the entry rule. */
export function overloaded(window: Window): boolean {
  if (window.failures >= ENTER_FAILURES) return true;
  if ((window.stalledMs ?? 0) >= ENTER_STALLED_MS) return true;
  if (window.times.length < MIN_SAMPLES) return false;
  return (p90(window.times) ?? 0) >= ENTER_P90_MS;
}

/**
 * Healthy right now, by the stricter leave rule. Unknown is not healthy.
 *
 * Failures below the entry count do not hold it: a steady one or two in two
 * minutes beside a fast 90th percentile is not overload, and requiring none
 * at all made recovery depend on the quietest two minutes the pooler allows.
 */
export function healthy(window: Window): boolean {
  if (window.failures >= ENTER_FAILURES) return false;
  if ((window.stalledMs ?? 0) >= LEAVE_STALLED_MS) return false;
  if (window.times.length < MIN_SAMPLES) return false;
  return (p90(window.times) ?? Infinity) < LEAVE_P90_MS;
}

let state: DatabasePressure = 'NORMAL';
let since = Date.now();
let healthySince: number | null = null;
let reason = 'no pressure has been felt';
const listeners: ((reading: PressureReading) => void)[] = [];

/**
 * The current reading, advancing the state machine from this process's own
 * samples. Cheap: it reads two in-memory arrays and touches no database.
 */
export function databasePressure(now = Date.now()): PressureReading {
  const byKind = databaseFailuresSince(now - WINDOW_MS);
  let failures = 0;
  for (const [kind, n] of Object.entries(byKind)) if (OVERLOAD_KINDS.has(kind as InfraFailureKind)) failures += n ?? 0;
  return advance({ times: statementTimesSince(now - WINDOW_MS), failures, stalledMs: stalledMsSince(now - WINDOW_MS), byKind }, now);
}

/** The state machine over one window. Exported for tests. */
export function advance(window: Window, now: number): PressureReading {
  const reading = (): PressureReading => ({
    state,
    reason,
    p90Ms: p90(window.times),
    samples: window.times.length,
    failures: window.failures,
    byKind: window.byKind ?? {},
    since: new Date(since).toISOString(),
  });
  if (state === 'NORMAL') {
    if (overloaded(window)) {
      state = 'SHEDDING';
      since = now;
      healthySince = null;
      reason =
        window.failures >= ENTER_FAILURES
          ? `${window.failures} statement(s) the database could not answer in the last ${WINDOW_MS / 1000}s`
          : (window.stalledMs ?? 0) >= ENTER_STALLED_MS
            ? `this process's event loop was stalled ${Math.round(window.stalledMs! / 1000)}s of the last ${WINDOW_MS / 1000}s, at or past the ${ENTER_STALLED_MS}ms a queued caller may wait`
            : `90th-percentile statement time ${Math.round(p90(window.times)!)}ms over ${window.times.length} statements in the last ${WINDOW_MS / 1000}s, at or past the ${ENTER_P90_MS}ms a queued caller may wait`;
      notify(reading());
    }
    return reading();
  }
  if (!healthy(window)) {
    healthySince = null;
    return reading();
  }
  healthySince ??= now;
  if (now - healthySince >= RECOVER_AFTER_MS) {
    state = 'NORMAL';
    since = now;
    healthySince = null;
    reason = `recovered: ${RECOVER_AFTER_MS / 60_000} minutes with fewer than ${ENTER_FAILURES} overload failures per window and a 90th percentile under ${LEAVE_P90_MS}ms`;
    notify(reading());
  }
  return reading();
}

function notify(reading: PressureReading): void {
  console.log(`[brain] database pressure ${reading.state}: ${reading.reason}`);
  for (const listener of listeners) {
    try {
      listener(reading);
    } catch {
      // A listener is a convenience; the state is the reading.
    }
  }
}

export function onPressureChange(listener: (reading: PressureReading) => void): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Tests only. */
export function resetPressure(now = Date.now()): void {
  state = 'NORMAL';
  since = now;
  healthySince = null;
  reason = 'no pressure has been felt';
  throttleStarts.clear();
  throttleDeferrals.clear();
}

/*
 * Throttled rather than shed (2026-11-14). Some work is not optional even under
 * pressure: planning a live goal is what the goal is waiting on, and shedding
 * it switched planning off exactly when planning was the main stall (one
 * goal-plan scenario in six hours against a design of two an hour). Such work
 * runs under SHEDDING at most once per `SHEDDING_THROTTLE_INTERVAL_MS` and in
 * its smallest unit, never back to back, and each skipped start is counted so
 * the throttling is visible rather than silent.
 */
export const SHEDDING_THROTTLE_INTERVAL_MS = 20 * 60_000;

/** `RUN`: pressure is normal. `THROTTLED`: run its smallest unit. `DEFERRED`: wait. */
export type ThrottleDecision = 'RUN' | 'THROTTLED' | 'DEFERRED';

const throttleStarts = new Map<string, number>();
const throttleDeferrals = new Map<string, number>();

/**
 * Whether work that must not be shed may start now. At NORMAL it always may;
 * under SHEDDING the first call in each interval may start a throttled run,
 * and every other call is a counted deferral.
 */
export function throttleUnderPressure(
  name: string,
  now = Date.now(),
  intervalMs = SHEDDING_THROTTLE_INTERVAL_MS,
): ThrottleDecision {
  if (databasePressure(now).state !== 'SHEDDING') return 'RUN';
  const last = throttleStarts.get(name);
  if (last !== undefined && now - last < intervalMs) {
    throttleDeferrals.set(name, (throttleDeferrals.get(name) ?? 0) + 1);
    return 'DEFERRED';
  }
  throttleStarts.set(name, now);
  return 'THROTTLED';
}

/** How many starts each throttled pass has deferred in this process. */
export function throttledDeferrals(): Record<string, number> {
  return Object.fromEntries(throttleDeferrals);
}
