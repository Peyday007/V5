/**
 * A quarantine Brain derived is asked about again by Brain.
 *
 * The recovery probe (`recoveryProbe.ts`) already proves whether a quarantined
 * Routine's sessions can arrive, and already lifts a quarantine Brain derived
 * when one does — but only when an operator dispatched it. So every surface
 * that went quiet for a reason that later cleared by itself (a Claude-side
 * outage, a usage limit, the account owner fixing their connector) waited for
 * somebody to remember `connectors probe`, and in production that somebody was
 * the owner, repeatedly. This is the same probe, started by the tick.
 *
 * Bounded three ways, because each probe is a real activation out of a fixed
 * subscription allowance:
 *
 *   - **One probe in the Brain at a time**, which the UNIQUE `live` column
 *     already enforces; an operator's probe waits for a live automatic one to settle
 *     (at most `RECOVERY_PROBE_WINDOW_MS`) and then resets the count.
 *   - **A backoff per Routine** — 15 minutes after it was quarantined, then 1h,
 *     4h, 12h, 24h after each probe that did not prove it healthy.
 *   - **A ceiling.** After `AUTO_PROBE_LIMIT` consecutive automatic probes that
 *     did not prove it healthy, Brain stops and the surface is reported as
 *     needing a person (`autoRecoveryExhausted`), with the last probe's own
 *     next action. A person's action resets it: any re-enable, repoint or
 *     manual probe moves the boundary.
 *
 * Only quarantines Brain itself derived and a probe can disprove
 * (`liftableQuarantine`) — never a surface a person drained, gave back,
 * retired or held, and never a verification account. It changes no
 * registration, consent, membership or scope; what a probe proves is all that
 * lifts anything, through the probe's own settlement.
 */
import { getDb } from '../../db/database.ts';
import { getAccount, getRoutine, listRoutines } from '../../repos/fleet.ts';
import { liveRecoveryProbe } from '../../repos/recoveryProbes.ts';
import type { FleetRoutine } from '../../domain/types.ts';
import { liftableQuarantine, recoveryIneligibility, startRecoveryProbe, type Fire } from './recoveryProbe.ts';

export const AUTO_RECOVERY_ACTOR = 'brain:auto-recovery';
export const AUTO_PROBE_LIMIT = 4;
/** Wait before the first probe, then after each one that did not prove the surface healthy. */
export const AUTO_PROBE_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000];
const RUN_EVERY_MS = 60_000;

let lastRun = 0;

/** For tests. */
export function resetAutoRecoveryClock(): void {
  lastRun = 0;
}

interface ProbeHistory {
  /** Consecutive automatic probes since the boundary that did not prove it healthy. */
  failed: number;
  lastAt: string | null;
  lastNextAction: string | null;
  lastState: string | null;
}

/**
 * The automatic probes of this quarantine episode, newest first. The episode
 * starts when the Routine last left QUARANTINED (`no_shows_forgiven_at`, which
 * only a transition out of quarantine writes), and a person's own probe or a
 * HEALTHY one ends the count — so a person acting always buys a fresh budget.
 * `updated_at` is deliberately not the boundary: attribution and re-arming
 * touch it on their own, and a boundary that moved by itself would let the
 * ceiling never bind.
 */
async function historyFor(routine: FleetRoutine): Promise<ProbeHistory> {
  const rows = await getDb().all<{ state: string; created_at: string; next_action: string | null; requested_by_id: string }>(
    `SELECT state, created_at, next_action, requested_by_id FROM connector_recovery_probes
      WHERE routine_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20`,
    [routine.id, routine.noShowsForgivenAt ?? ''],
  );
  let failed = 0;
  let lastAt: string | null = null;
  let lastNextAction: string | null = null;
  let lastState: string | null = null;
  for (const row of rows) {
    if (row.requested_by_id !== AUTO_RECOVERY_ACTOR) break;
    if (row.state === 'HEALTHY') break;
    if (!lastAt) {
      lastAt = row.created_at;
      lastNextAction = row.next_action;
      lastState = row.state;
    }
    if (row.state === 'FIRING' || row.state === 'FIRED') continue;
    failed += 1;
  }
  return { failed, lastAt, lastNextAction, lastState };
}

/** May Brain probe this Routine by itself, and when? Null when never. */
async function dueAt(routine: FleetRoutine): Promise<{ at: number; history: ProbeHistory } | null> {
  if (routine.state !== 'QUARANTINED' || !liftableQuarantine(routine.stateReason)) return null;
  const account = await getAccount(routine.accountId);
  if (!account || account.kind !== 'CAPACITY') return null;
  if (await recoveryIneligibility(routine)) return null;
  const history = await historyFor(routine);
  if (history.failed >= AUTO_PROBE_LIMIT) return null;
  const base = history.lastAt ?? routine.updatedAt;
  const wait = AUTO_PROBE_BACKOFF_MS[Math.min(history.failed, AUTO_PROBE_BACKOFF_MS.length - 1)]!;
  return { at: Date.parse(base) + wait, history };
}

/**
 * Start at most one automatic recovery probe, for the Routine most overdue.
 * Returns the probe id, or null when nothing was due.
 */
export async function autoProbeQuarantinedSurfaces(options: { now?: number; fire?: Fire; force?: boolean } = {}): Promise<string | null> {
  const now = options.now ?? Date.now();
  if (!options.force && now - lastRun < RUN_EVERY_MS) return null;
  lastRun = now;
  if (await liveRecoveryProbe()) return null;
  let best: { routine: FleetRoutine; at: number } | null = null;
  for (const routine of await listRoutines()) {
    const due = await dueAt(routine);
    if (!due || due.at > now) continue;
    if (!best || due.at < best.at) best = { routine, at: due.at };
  }
  if (!best) return null;
  try {
    const probe = await startRecoveryProbe({
      routineRef: best.routine.routineRef,
      requestedById: AUTO_RECOVERY_ACTOR,
      authorityChannel: 'SYSTEM',
      ...(options.fire ? { fire: options.fire } : {}),
      now,
    });
    return probe.id;
  } catch {
    // Refused (another probe took the slot, the surface changed): next pass.
    return null;
  }
}

export interface ExhaustedRecovery {
  routineId: string;
  routineName: string;
  accountId: string;
  attempts: number;
  lastProbeState: string | null;
  lastProbeAt: string | null;
  nextAction: string | null;
}

/** Quarantines Brain has stopped probing by itself: the ones a person now has to look at. */
export async function autoRecoveryExhausted(): Promise<ExhaustedRecovery[]> {
  const out: ExhaustedRecovery[] = [];
  for (const routine of await listRoutines()) {
    if (routine.state !== 'QUARANTINED' || !liftableQuarantine(routine.stateReason)) continue;
    const account = await getAccount(routine.accountId);
    if (!account || account.kind !== 'CAPACITY') continue;
    const history = await historyFor(routine);
    if (history.failed < AUTO_PROBE_LIMIT) continue;
    out.push({
      routineId: routine.id,
      routineName: routine.name,
      accountId: routine.accountId,
      attempts: history.failed,
      lastProbeState: history.lastState,
      lastProbeAt: history.lastAt,
      nextAction: history.lastNextAction,
    });
  }
  return out;
}

/** When Brain will next probe this Routine by itself, or null if it will not. */
export async function nextAutoProbeAt(routineId: string): Promise<string | null> {
  const routine = await getRoutine(routineId);
  if (!routine) return null;
  const due = await dueAt(routine);
  return due ? new Date(due.at).toISOString() : null;
}
