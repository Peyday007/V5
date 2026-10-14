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
 * - **Leave** only after five continuous minutes with no failure and a 90th
 *   percentile below a fifth of the entry bound. The hysteresis is what stops
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
import { databaseFailuresSince, statementTimesSince } from './infra.ts';

export type DatabasePressure = 'NORMAL' | 'SHEDDING';

/** The workload pool's checkout timeout (`server/db/adapters/postgres.ts`). */
export const POOL_CHECKOUT_TIMEOUT_MS = 10_000;
export const WINDOW_MS = 120_000;
export const ENTER_P90_MS = POOL_CHECKOUT_TIMEOUT_MS;
export const LEAVE_P90_MS = POOL_CHECKOUT_TIMEOUT_MS / 5;
export const ENTER_FAILURES = 3;
export const RECOVER_AFTER_MS = 5 * 60_000;
export const MIN_SAMPLES = 20;

export interface PressureReading {
  state: DatabasePressure;
  /** Why it is in this state, in words a report can print. */
  reason: string;
  p90Ms: number | null;
  samples: number;
  failures: number;
  since: string;
}

interface Window {
  times: number[];
  failures: number;
}

function p90(times: number[]): number | null {
  if (times.length === 0) return null;
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
}

/** Overloaded right now, by the entry rule. */
export function overloaded(window: Window): boolean {
  if (window.failures >= ENTER_FAILURES) return true;
  if (window.times.length < MIN_SAMPLES) return false;
  return (p90(window.times) ?? 0) >= ENTER_P90_MS;
}

/** Healthy right now, by the stricter leave rule. Unknown is not healthy. */
export function healthy(window: Window): boolean {
  if (window.failures > 0) return false;
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
  return advance(
    { times: statementTimesSince(now - WINDOW_MS), failures: databaseFailuresSince(now - WINDOW_MS) },
    now,
  );
}

/** The state machine over one window. Exported for tests. */
export function advance(window: Window, now: number): PressureReading {
  const reading = (): PressureReading => ({
    state,
    reason,
    p90Ms: p90(window.times),
    samples: window.times.length,
    failures: window.failures,
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
    reason = `recovered: ${RECOVER_AFTER_MS / 60_000} minutes with no failure and a 90th percentile under ${LEAVE_P90_MS}ms`;
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
}
