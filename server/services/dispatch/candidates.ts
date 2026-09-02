/**
 * What the router needs to know, read from rows.
 *
 * Kept apart from `router.ts` on purpose. The router is a pure function so a
 * decision can be replayed and argued with; this is the impure half that goes
 * and gets the numbers. Separating them is what makes "why did this bin go to
 * that account" answerable from a recorded input rather than from a re-run
 * against a database that has since moved.
 */
import { getDb } from '../../db/database.ts';
import {
  currentPolicy,
  effectiveTarget,
  listAccounts,
  listRoutines,
} from '../../repos/fleet.ts';
import { resolveToken } from './fire.ts';
import type { RoutingCandidate } from './router.ts';
import type { FleetAccount, FleetPolicy } from '../../domain/types.ts';

/**
 * How long a sent activation counts as in flight.
 *
 * Not a timeout and not a lease — those belong to the bin. This is only the
 * window in which a fire we made is still plausibly a running session, for the
 * purpose of not starting more than the target allows. Too short and Brain
 * over-fires; too long and it under-fires after a quiet failure. Thirty minutes
 * is longer than every activation Step 10 measured (the longest drained seven
 * bins in 107 seconds) and short enough that a dead session frees its slot
 * within one operator's attention span.
 */
export const IN_FLIGHT_WINDOW_MS = 30 * 60_000;

export interface FleetSnapshot {
  candidates: RoutingCandidate[];
  fleetPolicy: FleetPolicy | null;
  fleetInFlight: number;
  /** Routines registered but skipped because their secret is not deployed. */
  missingSecrets: { routineId: string; secretName: string }[];
}

/**
 * Activations started and not yet visibly finished, per Routine.
 *
 * Counted from `bin_dispatch` rather than from bins, because the question is
 * "how many sessions did we start" and a session exists from the moment the
 * provider accepted the fire — before any bin is leased, and still while one is
 * being drained. Counting leased bins instead would read zero in the window
 * between firing and check-in, which is exactly when over-firing happens.
 */
export async function inFlightByRoutine(nowMs: number): Promise<Map<string, number>> {
  const since = new Date(nowMs - IN_FLIGHT_WINDOW_MS).toISOString();
  const rows = await getDb().all<{ routine_id: string | null; n: number }>(
    `SELECT d.routine_id AS routine_id, COUNT(*) AS n
       FROM bin_dispatch d
       JOIN bins b ON b.id = d.bin_id
      WHERE d.state = 'SENT' AND d.sent_at >= ?
        AND b.state NOT IN ('COMPLETE','CANCELLED','FAILED')
      GROUP BY d.routine_id`,
    [since],
  );
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.routine_id) out.set(row.routine_id, Number(row.n));
  }
  return out;
}

/**
 * Everything the router needs, assembled once per tick.
 *
 * A Routine whose secret is not present in this deployment is left out of the
 * candidate list and reported separately. That is a real state — a row can be
 * registered before its secret is set, or a secret can be rotated away — and
 * treating it as "eligible but will fail" would spend the fleet's scarce fire
 * budget discovering it.
 */
export async function fleetSnapshot(now = new Date()): Promise<FleetSnapshot> {
  const nowIso = now.toISOString();
  const [accounts, routines, fleetPolicy, perRoutine] = await Promise.all([
    listAccounts(),
    listRoutines(),
    currentPolicy('FLEET', null),
    inFlightByRoutine(now.getTime()),
  ]);

  const accountById = new Map<string, FleetAccount>(accounts.map((a) => [a.id, a]));
  const perAccount = new Map<string, number>();
  for (const routine of routines) {
    const n = perRoutine.get(routine.id) ?? 0;
    perAccount.set(routine.accountId, (perAccount.get(routine.accountId) ?? 0) + n);
  }

  const candidates: RoutingCandidate[] = [];
  const missingSecrets: { routineId: string; secretName: string }[] = [];

  for (const routine of routines) {
    const account = accountById.get(routine.accountId);
    if (!account) continue;
    if (!resolveToken(routine.tokenSecretName)) {
      missingSecrets.push({ routineId: routine.id, secretName: routine.tokenSecretName });
      continue;
    }
    const [routinePolicy, accountPolicy] = await Promise.all([
      currentPolicy('ROUTINE', routine.id),
      currentPolicy('ACCOUNT', account.id),
    ]);
    candidates.push({
      routine,
      account,
      routineInFlight: perRoutine.get(routine.id) ?? 0,
      accountInFlight: perAccount.get(account.id) ?? 0,
      routineTarget: routinePolicy ? effectiveTarget(routinePolicy, nowIso).target : null,
      accountTarget: accountPolicy ? effectiveTarget(accountPolicy, nowIso).target : null,
    });
  }

  let fleetInFlight = 0;
  for (const n of perRoutine.values()) fleetInFlight += n;

  return { candidates, fleetPolicy, fleetInFlight, missingSecrets };
}
