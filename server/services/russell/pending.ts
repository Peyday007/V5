/**
 * What a pending turn is actually waiting for.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to close
 * ---------------------------------------------------------------------------
 *
 * `beginTurn` stores one sentence on the pending row — "Russell is thinking — a
 * worker is picking this up" — and that sentence is written *before* anything
 * has picked anything up. It is a prediction, and it never changes. So a turn
 * whose bin was never dispatched, whose Routine refused, whose fleet is paused,
 * or which is waiting on a person, shows a person the same reassuring line
 * forever.
 *
 * The owner watched exactly that happen for half an hour. **A pending state
 * that cannot become wrong is not an explanation, it is a spinner with a
 * caption**, and §24's rule that the interface is never optimistic applies to
 * the caption too.
 *
 * ---------------------------------------------------------------------------
 * What this does instead, and what it deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * It is a **read-side projection**. It reads the bin behind the turn and that
 * bin's latest dispatch intent, and turns the pair into a sentence describing
 * the condition the turn is genuinely in right now. It writes nothing, moves
 * nothing, and takes no decision — so it cannot be the reason a turn changes
 * state, and a bug in here costs a worse sentence rather than a lost answer.
 *
 * The stored `pending_reason` column is left exactly as it is. It records what
 * was true when the turn was created and stays part of the row's history; this
 * is what is *shown*, on a separate view-only field, so the two can never be
 * confused for one another.
 *
 * It names no internal resource. Not the bin id, not the Routine, not the
 * session, not the account — a person has no use for any of them, and the
 * conversation route already refuses to hand back a bin id for that reason.
 * "A worker" is the whole vocabulary.
 */
import { getDb } from '../../db/database.ts';
import type { RussellMessage } from '../../domain/types.ts';

/**
 * Past this, a person is told how long it has been.
 *
 * Two minutes rather than thirty seconds: the fleet's own tick is 30s and a
 * dispatch plus an activation is legitimately a minute or two, so counting
 * earlier would report ordinary latency as a delay.
 */
const MENTION_ELAPSED_AFTER_MS = 2 * 60_000;

interface TurnCondition {
  messageId: string;
  binState: string | null;
  terminalReason: string | null;
  dispatchState: string | null;
  dispatchError: string | null;
  createdAt: string;
}

/**
 * The condition of every pending turn in one query.
 *
 * `LEFT JOIN` on the dispatch, because a bin with no intent yet is one of the
 * cases worth distinguishing — it is the difference between "nobody has called
 * a worker" and "a worker was called and has not turned up".
 *
 * The dispatch chosen is the one at the bin's current generation, which is the
 * only one that can still produce an arrival: an intent from an earlier
 * generation belongs to a lease that has already expired or been cancelled, and
 * reporting its state would describe a run that is over.
 */
async function conditions(messageIds: string[]): Promise<Map<string, TurnCondition>> {
  const out = new Map<string, TurnCondition>();
  if (messageIds.length === 0) return out;

  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = await getDb().all<{
    message_id: string;
    bin_state: string | null;
    terminal_reason: string | null;
    dispatch_state: string | null;
    last_error_kind: string | null;
    created_at: string;
  }>(
    `SELECT m.id                AS message_id,
            b.state             AS bin_state,
            b.terminal_reason   AS terminal_reason,
            d.state             AS dispatch_state,
            d.last_error_kind   AS last_error_kind,
            m.created_at        AS created_at
       FROM russell_messages m
       LEFT JOIN bins b
              ON b.created_by_id = 'russell:turn:' || m.id
       LEFT JOIN bin_dispatch d
              ON d.bin_id = b.id AND d.lease_generation = b.lease_generation
      WHERE m.id IN (${placeholders})`,
    messageIds,
  );

  for (const row of rows) {
    out.set(row.message_id, {
      messageId: row.message_id,
      binState: row.bin_state,
      terminalReason: row.terminal_reason,
      dispatchState: row.dispatch_state,
      dispatchError: row.last_error_kind,
      createdAt: row.created_at,
    });
  }
  return out;
}

/** "4 minutes", "1 hour", "2 hours" — never a decimal, never a bare number. */
function elapsed(sinceIso: string, now: number): string | null {
  const ms = now - Date.parse(sinceIso);
  if (!Number.isFinite(ms) || ms < MENTION_ELAPSED_AFTER_MS) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * One sentence for one condition.
 *
 * Every branch says what is true *and*, where a person can do something about
 * it, what that is. The two branches that matter most are the ones the old
 * static string covered up: a bin nobody has dispatched, and a dispatch that
 * ran out of attempts. Both used to read as "a worker is picking this up".
 */
export function explain(condition: TurnCondition | undefined, now: number): string {
  if (!condition) return 'Russell is working on this.';
  const waited = elapsed(condition.createdAt, now);
  const since = waited ? ` It has been waiting ${waited}.` : '';

  // A pending turn with no bin never reached the fleet at all. It is the one
  // case where nothing is running and nothing ever will be, so it must never
  // read as patience.
  if (!condition.binState) {
    return `This one did not reach a worker, so nothing is running for it. Ask me again and I will pick it up.${since}`;
  }

  switch (condition.binState) {
    case 'DRAFT':
      return `Russell is still preparing this one; it has not been released to a worker yet.${since}`;
    case 'READY':
      if (condition.dispatchState === 'ABANDONED') {
        return `Russell could not reach a worker for this one after several attempts, so it is waiting for the fleet to come back.${since}`;
      }
      if (condition.dispatchState === 'SENT') {
        return `A worker has been called for this and has not started yet.${since}`;
      }
      if (condition.dispatchState === 'SENDING') {
        return `Russell is calling a worker for this now.${since}`;
      }
      if (condition.dispatchState === 'PENDING') {
        return `This is queued and a worker has not been called yet.${since}`;
      }
      return `This is waiting to be handed to a worker.${since}`;
    case 'LEASED':
      return `A worker is working on this now.${since}`;
    case 'NEEDS_HUMAN':
      return condition.terminalReason
        ? `This needs a decision from you before it can go on: ${condition.terminalReason}`
        : 'This needs a decision from you before it can go on. It is in Needs You.';
    case 'COMPLETE':
    case 'FAILED':
    case 'CANCELLED':
      // The loop closes these within a tick. Saying so is better than either
      // the old prediction or a silence a person would read as a hang.
      return `The run has finished and Russell is storing the answer.${since}`;
    default:
      return `Russell is working on this.${since}`;
  }
}

/**
 * Attach a live explanation to every pending turn in a list.
 *
 * Returns new objects; the rows handed in are not mutated, so a caller that
 * also writes one of them cannot accidentally persist a projection. A turn that
 * is not `PENDING` is returned untouched — a settled turn has an answer, and an
 * explanation beside it would be noise.
 */
export async function withPendingDetail(
  turns: RussellMessage[],
  now: number = Date.now(),
): Promise<RussellMessage[]> {
  const pendingIds = turns.filter((turn) => turn.status === 'PENDING').map((turn) => turn.id);
  if (pendingIds.length === 0) return turns;

  const found = await conditions(pendingIds);
  return turns.map((turn) =>
    turn.status === 'PENDING' ? { ...turn, pendingDetail: explain(found.get(turn.id), now) } : turn,
  );
}
