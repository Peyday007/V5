/**
 * Raising and lowering the target, from evidence rather than from confidence.
 *
 * Two rules decide everything here, and both come from what Step 10 measured:
 *
 *   1. **A provider refusal is capacity evidence, not misconduct.** Step 10's
 *      rung 30 had every dispatch refused; Brain paused, kept every bin, and
 *      resumed by itself. Nothing about that was a fault, and a scaler that
 *      treated a 429 as a reason to quarantine an account would have destroyed
 *      a working fleet for being busy.
 *
 *   2. **A no-show is different from a refusal.** A refusal is the provider
 *      saying no. A no-show is a session that was created and never checked in,
 *      which in Step 10 meant the surface could not authorize — a configuration
 *      fault on that one Routine that no amount of retrying fixes. So the two
 *      counters are separate and only one of them can quarantine.
 *
 * The scaler proposes; it does not write policy behind the operator's back
 * unless auto-scale is on for that scope, and it can never exceed the ceiling
 * the operator set. A manual target may exceed what the scaler would have
 * recommended — that is the point of the operator being able to push — but
 * nothing here or there can exceed a provider refusal.
 */
import type { FleetPolicy } from '../../domain/types.ts';

export interface ScaleSignals {
  /** Bins eligible to run right now. */
  queueDepth: number;
  /** Activations started and not yet visibly finished. */
  inFlight: number;
  /** Fires the provider refused in the recent window. */
  recentRefusals: number;
  /** Sessions created that never checked in, in the recent window. */
  recentNoShows: number;
  /** Completions Brain accepted in the recent window. */
  recentCompletions: number;
}

export type ScaleDirection = 'RAISE' | 'LOWER' | 'HOLD';

export interface ScaleProposal {
  direction: ScaleDirection;
  from: number;
  to: number;
  reason: string;
  /** True when the proposal may be applied without asking a person. */
  automatic: boolean;
}

/**
 * What the target should be, given what just happened.
 *
 * Deliberately conservative in one direction and not the other: it raises by
 * one and lowers by half. A fleet that over-fires spends a scarce, slowly
 * replenishing budget; a fleet that under-fires loses only throughput, and
 * Step 10 established that a throttled fleet loses throughput rather than work.
 * The asymmetry is that fact expressed as arithmetic.
 */
export function proposeScale(input: {
  policy: FleetPolicy | null;
  signals: ScaleSignals;
  now: string;
}): ScaleProposal {
  const { policy, signals } = input;
  const from = policy?.target ?? 0;
  const ceiling = policy?.autoScaleCeiling ?? null;
  const automatic = Boolean(policy?.autoScale);

  if (policy?.paused) {
    return { direction: 'HOLD', from, to: from, reason: 'The fleet is paused.', automatic: false };
  }

  // Refusals first. A provider wall outranks every other signal, including a
  // deep queue — especially a deep queue, which is exactly when the temptation
  // to push through one would be strongest.
  if (signals.recentRefusals > 0) {
    const to = Math.max(1, Math.floor(from / 2));
    return {
      direction: to < from ? 'LOWER' : 'HOLD',
      from,
      to,
      reason:
        `${signals.recentRefusals} provider refusal(s) in the window. The wall is real and ` +
        'policy cannot argue with it; halving the target until it clears.',
      automatic,
    };
  }

  if (signals.recentNoShows > 0 && signals.recentCompletions === 0) {
    const to = Math.max(1, Math.floor(from / 2));
    return {
      direction: to < from ? 'LOWER' : 'HOLD',
      from,
      to,
      reason:
        `${signals.recentNoShows} fired session(s) never checked in and nothing completed. ` +
        'Firing more would spend the budget discovering the same thing.',
      automatic,
    };
  }

  if (signals.queueDepth > signals.inFlight && signals.recentCompletions > 0) {
    const wanted = from + 1;
    const to = ceiling === null ? wanted : Math.min(wanted, ceiling);
    if (to <= from) {
      return {
        direction: 'HOLD',
        from,
        to: from,
        reason:
          `Queue is deeper than the target but the automatic ceiling is ${ceiling}. ` +
          'Raise the ceiling, or raise the target manually, to go further.',
        automatic,
      };
    }
    return {
      direction: 'RAISE',
      from,
      to,
      reason:
        `${signals.queueDepth} eligible bins against ${signals.inFlight} in flight, with ` +
        `${signals.recentCompletions} recent completion(s) and no refusals.`,
      automatic,
    };
  }

  return {
    direction: 'HOLD',
    from,
    to: from,
    reason: 'Queue depth is within the current target, or nothing has completed to learn from.',
    automatic,
  };
}

/**
 * When repeated failure means this one surface should stop being chosen.
 *
 * Proportional, and the proportions matter. One failed session condemns
 * nothing. Repeated *no-shows* quarantine, because a session that starts and
 * never arrives is a permission or connector fault that will repeat forever at
 * one activation each. Repeated *refusals* never quarantine, however many there
 * are — that is an account at its ceiling, and the remedy is the retry window
 * the provider already gave us.
 */
export const NO_SHOW_QUARANTINE_THRESHOLD = 3;
export const FAILURE_QUARANTINE_THRESHOLD = 5;

export function shouldQuarantine(routine: {
  consecutiveNoShows: number;
  consecutiveFailures: number;
}): { quarantine: boolean; reason: string } {
  if (routine.consecutiveNoShows >= NO_SHOW_QUARANTINE_THRESHOLD) {
    return {
      quarantine: true,
      reason:
        `${routine.consecutiveNoShows} consecutive fired sessions never checked in. That is a ` +
        'surface that cannot authorize, and every further fire costs an activation to learn it ' +
        'again. Recover it once the surface is fixed.',
    };
  }
  if (routine.consecutiveFailures >= FAILURE_QUARANTINE_THRESHOLD) {
    return {
      quarantine: true,
      reason:
        `${routine.consecutiveFailures} consecutive fire failures that were not rate limits. ` +
        'The trigger is wrong, revoked, deleted or paused; retrying will not fix any of those.',
    };
  }
  return { quarantine: false, reason: '' };
}

/*
 * ---------------------------------------------------------------------------
 * Applying it: account targets that follow the evidence
 * ---------------------------------------------------------------------------
 *
 * `proposeScale` had no caller, so an account's concurrency was whatever a
 * person last typed. Production 2026-11-10: the one usable Factory surface sat
 * at its account's target of 4 with Factory bins waiting on
 * ACCOUNT_TARGETS_REACHED, completions arriving and no provider refusal — the
 * exact case the proposal raises for — and nothing raised it.
 *
 * Only a scope whose policy has auto-scale on is written, never above the
 * ceiling a person set, and only for an account that is actually at its
 * target with work waiting on it. A provider refusal halves it, so the
 * account's real limit is found from the provider's answers rather than
 * assumed, and found again when it changes.
 */
export const AUTO_SCALE_INTERVAL_MS = 10 * 60_000;
const AUTO_SCALE_WINDOW_MS = 60 * 60_000;
let lastAutoScale = 0;

export interface AutoScaleStep {
  accountId: string;
  direction: ScaleDirection;
  from: number;
  to: number;
  reason: string;
}

export async function autoScaleAccounts(now = new Date(), force = false): Promise<AutoScaleStep[]> {
  if (!force && now.getTime() - lastAutoScale < AUTO_SCALE_INTERVAL_MS) return [];
  lastAutoScale = now.getTime();
  const { currentPolicies, policyKey, setPolicy, listAccounts, listRoutines } = await import('../../repos/fleet.ts');
  const { inFlightByRoutine, productivityByAccount } = await import('./candidates.ts');
  const { getDb } = await import('../../db/database.ts');
  const policies = await currentPolicies();
  const accounts = await listAccounts();
  const routines = await listRoutines();
  const perRoutine = await inFlightByRoutine(now.getTime());
  const productivity = await productivityByAccount(now.getTime(), new Map(routines.map((r) => [r.id, r.accountId])));
  const since = new Date(now.getTime() - AUTO_SCALE_WINDOW_MS).toISOString();
  // Work waiting on a target: intents still pending whose last refusal was the target.
  const waiting = Number(
    (
      await getDb().get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bin_dispatch
          WHERE state = 'PENDING' AND last_error_kind = 'ACCOUNT_TARGETS_REACHED'`,
      )
    )?.n ?? 0,
  );
  const steps: AutoScaleStep[] = [];
  for (const account of accounts) {
    const policy = policies.get(policyKey('ACCOUNT', account.id)) ?? null;
    if (!policy?.autoScale || policy.paused) continue;
    let inFlight = 0;
    for (const routine of routines) if (routine.accountId === account.id) inFlight += perRoutine.get(routine.id) ?? 0;
    const counted = productivity.get(account.id);
    const refused = account.lastRefusalAt !== null && account.lastRefusalAt >= since ? 1 : 0;
    // Raising is asked only of an account that is at its target: one with room is not what holds the work.
    const atTarget = inFlight >= policy.target;
    const proposal = proposeScale({
      policy,
      signals: {
        queueDepth: atTarget ? inFlight + waiting : 0,
        inFlight,
        recentRefusals: refused,
        recentNoShows: counted?.unproductive ?? 0,
        recentCompletions: counted?.productive ?? 0,
      },
      now: now.toISOString(),
    });
    if (proposal.direction === 'HOLD' || !proposal.automatic || proposal.to === proposal.from) continue;
    await setPolicy({
      scope: 'ACCOUNT',
      scopeId: account.id,
      target: proposal.to,
      autoScale: true,
      autoScaleCeiling: policy.autoScaleCeiling,
      minReserve: policy.minReserve,
      paused: false,
      actor: 'brain:auto-scale',
      reason: proposal.reason,
    });
    steps.push({ accountId: account.id, direction: proposal.direction, from: proposal.from, to: proposal.to, reason: proposal.reason });
  }
  return steps;
}

/** Tests: let the next call run. */
export function resetAutoScale(): void {
  lastAutoScale = 0;
}
