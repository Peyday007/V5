/**
 * An executable bin whose only intent gave up is re-armed, boundedly.
 *
 * Dispatch keeps exactly one intent per (bin, lease generation):
 * `ensureDispatchIntent` inserts `ON CONFLICT DO NOTHING`, and the tick only
 * creates intents for bins that hold none at their current generation. So when
 * that one intent is `ABANDONED` — its fires charged to the bin until
 * `markDispatchFailed` ran out of attempts — a bin that is still READY at the
 * same generation, with attempts of its own left and claimable work, is never
 * fired again. That is an edge-driven gap in a loop that must be level-driven:
 * the watchdog then reads "executable work and free surfaces, nothing running
 * or arriving" window after window, and the dispatch pass it asks for has
 * nothing to send (ORIGINATED:IDLE_CAPACITY:engineering-watchdog, 126 of 144
 * windows in 24 h).
 *
 * `reviveAbandonedNoShowDispatches` already answers this for intents that gave
 * up on unanswered fires (`last_error_kind = 'NO_SHOW'`). This answers every
 * other abandonment the same way, with the same bound, so the two together
 * cover every `ABANDONED` intent and neither touches the other's rows:
 *
 *   - a cool-off (`BIN_REFIRE_COOLDOWN_MS` since the intent was abandoned);
 *   - the ceiling is *raised*, never reset, so the attempt history stays
 *     readable, and an intent at `REVIVED_CEILING` is never selected again —
 *     a bin that fails every fire costs two more rounds, not a loop;
 *   - only a bin the dispatcher itself would fire now: `DISPATCHABLE_SQL`,
 *     `FIREABLE_SQL` and `workReadySql`, at the intent's own generation, with
 *     no recovery probe holding it.
 *
 * The re-armed intent then meets every gate a new one meets — the refire
 * guard, routing, audit fit, Brain-only admission and the fire-slot CAS. And
 * the change is one conditional UPDATE, so two dispatchers re-arm it once.
 */
import { getDb } from '../../db/database.ts';
import {
  ABANDONED_REVIVE_AFTER_MS,
  BIN_REFIRE_COOLDOWN_MS,
  DISPATCHABLE_SQL,
  FIREABLE_SQL,
  MAX_ABANDONED_REVIVALS,
  binNow,
  recordBinEvent,
  workReadySql,
} from '../../repos/bins.ts';

/** One re-arm adds one intent's worth of fires, as a revival does. */
export const STRANDED_REARM_STEP = 5;
/** Every intent starts at 5; past this it has no re-arm left (same bound as a no-show revival). */
export const STRANDED_REARM_CEILING = 5 + STRANDED_REARM_STEP * MAX_ABANDONED_REVIVALS;
/** The longer of the two cool-offs: a stranded intent never refires faster than the refire guard allows. */
export const STRANDED_REARM_AFTER_MS = Math.max(BIN_REFIRE_COOLDOWN_MS, ABANDONED_REVIVE_AFTER_MS);

export interface RearmedIntent {
  dispatchId: string;
  binId: string;
  previousErrorKind: string | null;
}

export async function rearmStrandedIntents(
  limit = 20,
  afterMs: number = STRANDED_REARM_AFTER_MS,
): Promise<RearmedIntent[]> {
  const now = binNow();
  const before = new Date(Date.parse(now) - Math.max(0, afterMs)).toISOString();
  /*
   * The bin side is the dispatcher's own predicate, asked of `bins` alone so
   * its unqualified columns cannot be read against `bin_dispatch` (which has a
   * `state`, an `attempt_count` and a `max_attempts` of its own).
   */
  const bins = await getDb().all<{ id: string; project_id: string; lease_generation: number }>(
    `SELECT bins.id AS id, bins.project_id AS project_id, bins.lease_generation AS lease_generation
       FROM bins
      WHERE ${DISPATCHABLE_SQL} AND ${FIREABLE_SQL} AND ${workReadySql('bins.')}
        AND NOT EXISTS (SELECT 1 FROM connector_recovery_probes p WHERE p.bin_id = bins.id)
        AND EXISTS (
          SELECT 1 FROM bin_dispatch d
           WHERE d.bin_id = bins.id AND d.lease_generation = bins.lease_generation
             AND d.state = 'ABANDONED' AND COALESCE(d.last_error_kind, '') <> 'NO_SHOW'
             AND d.updated_at <= ? AND d.max_attempts < ?)
      ORDER BY bins.priority DESC, bins.created_at, bins.id
      LIMIT ?`,
    [now, now, now, now, before, STRANDED_REARM_CEILING, Math.max(1, limit)],
  );
  const out: RearmedIntent[] = [];
  for (const bin of bins) {
    const intent = await getDb().get<{ id: string; last_error_kind: string | null }>(
      `SELECT id, last_error_kind FROM bin_dispatch
        WHERE bin_id = ? AND lease_generation = ? AND state = 'ABANDONED'`,
      [bin.id, bin.lease_generation],
    );
    if (!intent) continue;
    const result = await getDb().run(
      `UPDATE bin_dispatch
          SET state = 'PENDING', max_attempts = max_attempts + ?, next_attempt_at = ?, updated_at = ?,
              last_error = 'Re-armed: the bin is still executable and its only intent had given up, so nothing else would ever fire for it.'
        WHERE id = ? AND state = 'ABANDONED' AND COALESCE(last_error_kind, '') <> 'NO_SHOW'
          AND updated_at <= ? AND max_attempts < ?`,
      [STRANDED_REARM_STEP, now, now, intent.id, before, STRANDED_REARM_CEILING],
    );
    if (result.changes !== 1) continue;
    await recordBinEvent({
      eventType: 'DISPATCH_REARMED',
      binId: bin.id,
      projectId: bin.project_id,
      leaseGeneration: bin.lease_generation,
      outcome: 'PENDING',
      reason:
        `An intent abandoned on ${intent.last_error_kind ?? 'an unknown failure'} while its bin stayed ` +
        'executable, asked once more after a cool-off.',
      evidenceClass: 'MEASURED',
    });
    out.push({ dispatchId: intent.id, binId: bin.id, previousErrorKind: intent.last_error_kind });
  }
  return out;
}
