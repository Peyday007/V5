/**
 * The surface a session came from, recovered from the routing rows that already
 * prove it.
 *
 * `worker_sessions` is written at the moment a fired session arrives and takes
 * the bin that fire was for. That is the right place to observe it and it only
 * observes forward: every activation that arrived before the table existed left
 * no row, so every `research_passes.executor_account_id` written before it is
 * null — including the passes of packets that were, in fact, genuinely
 * independent. `A11_INDEPENDENT_AUDIT` reads those rows, so the attribution
 * being missing looks exactly like the audit not having happened.
 *
 * Two answers were available and only one of them is honest about which:
 *
 *   - **Run another audit round after the fix.** Correct, and it leaves every
 *     historical packet permanently unattributable.
 *   - **Recover the attribution, but only where append-only rows establish it.**
 *     Which is this file.
 *
 * Nothing here infers, prefers or defaults. The chain is entirely rows Brain
 * wrote itself, and it is walked twice because one of the two links is live
 * state and the other is history.
 *
 * **The live arm**, for a session still holding its bin:
 *
 *     research_passes.executor_session_ref
 *       = bins.lease_credential_id            the credential that took the bin
 *       -> bin_dispatch (SENT, routine_id)    the fire that produced it
 *       -> fleet_routines.account_id          the account that Routine is under
 *
 * **The durable arm**, for every session that has since let go. `bins` is
 * current state: `lease_credential_id` is overwritten on the next assignment
 * and set to NULL on release and on completion, so for a finished bin the live
 * arm finds nothing at all — which is most of history, and is exactly the case
 * this file exists for.
 *
 *     research_passes.executor_session_ref
 *       = work_leases.credential_id           append-only: who held this item
 *       -> the bin that item was reachable in the queue's own scope rule
 *       -> bin_events (BIN_ASSIGNED)          the arrival this claim followed
 *       -> bin_dispatch at generation - 1     the fire that arrival superseded
 *       -> fleet_routines.account_id
 *
 * `work_leases` is append-only by design — "a failed attempt is evidence, not
 * something to tidy away" — so the second arm still answers months later.
 *
 * `BIN_ASSIGNED` rather than any arrival: a `BIN_TAKEOVER` session took an
 * expired lease, so the fire at that generation was the *previous* owner's and
 * crediting this session to it would attribute a session to a fire that did not
 * produce it. `creditDispatchArrival` refuses a takeover for the same reason,
 * and the same refusal is kept here rather than restated as an exception.
 *
 * Every link is a fact Brain recorded at the time rather than a lookup over how
 * the fleet happens to be wired now. In particular it is **not** the static
 * worker -> Routine binding, which is the thing that could not answer this in
 * the first place: one worker identity bound to two Routines under two accounts
 * has two candidates, and choosing between them would be the guess this whole
 * mechanism exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * What it refuses
 * ---------------------------------------------------------------------------
 *
 *   - **More than one Routine fired the bins a credential took**, across both
 *     arms together. Ambiguous, so nothing is written and the session is
 *     reported as unresolved. "We could not tell" must never read the same as
 *     "we checked".
 *   - **A Routine with no account.** Same rule, one link further down.
 *   - **A dispatch at or after the lease's own generation.** That intent was
 *     created for a *later* assignment, so it did not produce this session; the
 *     one that did is at a generation the assignment has already superseded.
 *   - **A pass that already names an account.** Every write is guarded on the
 *     column still being null, so a recovered value can never replace a
 *     recorded one — §5, at a column.
 *   - **A predicted session.** `future:<routineId>` is allocator reasoning and
 *     resolves to no credential, so it is excluded by name rather than by
 *     failing to match.
 *
 * It is idempotent and self-limiting: once a session is observed and a pass is
 * attributed, both queries stop returning them, so the ordinary steady state is
 * two indexed reads that find nothing.
 */
import { getDb } from '../../db/database.ts';
import { getRoutine, getWorkerSession, recordWorkerSession } from '../../repos/fleet.ts';

export interface LineageRecovery {
  /** Sessions newly observed, with the surface the routing rows named. */
  sessions: { sessionRef: string; routineId: string; accountId: string }[];
  /** Passes whose account was filled in from one of those observations. */
  passes: { passId: string; accountId: string }[];
  /**
   * Sessions the rows could not settle, and why — never silently dropped,
   * because an attribution that cannot be established is a fact worth reading.
   */
  unresolved: { sessionRef: string; reason: string }[];
}

const EMPTY: LineageRecovery = { sessions: [], passes: [], unresolved: [] };

/**
 * Recover what the routing rows prove, and nothing else.
 *
 * @param limit how many sessions and passes to examine in one pass. Bounded for
 *   the reason every other reconciliation step is: a backlog must not turn one
 *   tick into a crawl.
 */
export async function recoverExecutionLineage(limit = 25): Promise<LineageRecovery> {
  const bounded = Math.max(1, Math.min(200, limit));
  const report: LineageRecovery = { sessions: [], passes: [], unresolved: [] };

  /* -----------------------------------------------------------------------
   * 1. Sessions that took a bin and were never observed.
   *
   * Driven from `research_passes` rather than from every bin ever leased: the
   * question this answers is which *audit lineage* is missing, and recovering
   * a session that no pass refers to would be work with no reader.
   * --------------------------------------------------------------------- */
  const candidates = await getDb().all<{ session_ref: string; worker_id: string }>(
    `SELECT DISTINCT p.executor_session_ref AS session_ref, p.executor_worker_id AS worker_id
       FROM research_passes p
      WHERE p.executor_account_id IS NULL
        AND p.executor_worker_id IS NOT NULL
        AND p.executor_session_ref IS NOT NULL
        AND p.executor_session_ref <> ''
        AND p.executor_session_ref NOT LIKE 'future:%'
        AND NOT EXISTS (
          SELECT 1 FROM worker_sessions s WHERE s.session_ref = p.executor_session_ref
        )
      ORDER BY p.executor_session_ref
      LIMIT ?`,
    [bounded],
  );

  for (const candidate of candidates) {
    /*
     * Every fire that produced a bin this credential went on to hold.
     *
     * `d.lease_generation < b.lease_generation` is the whole of the ordering
     * rule: an assignment reads the dispatch at the generation it is about to
     * supersede, so the intent that produced this session is always at a lower
     * generation than the lease it created. An intent at or above it belongs to
     * a later assignment and would attribute this session to a fire that had
     * not happened when it arrived.
     */
    const fires = await getDb().all<{ routine_id: string; bin_id: string; lease_generation: number }>(
      `SELECT DISTINCT d.routine_id, d.bin_id, d.lease_generation
         FROM bins b
         JOIN bin_dispatch d ON d.bin_id = b.id
        WHERE b.lease_credential_id = ?
          AND b.worker_id = ?
          AND d.state = 'SENT'
          AND d.routine_id IS NOT NULL
          AND d.lease_generation < b.lease_generation

        UNION

       /*
        * The durable arm. work_leases keeps every claim this credential ever
        * made, and the arrival it followed is the newest BIN_ASSIGNED for
        * that bin, by that worker, at or before the claim — which is the same
        * pairing creditDispatchArrival makes live, reconstructed from the
        * events instead of from a column that has since been cleared.
        *
        * The generation arithmetic is that function's, unchanged: an
        * assignment reads the dispatch at the generation it is about to
        * supersede and then writes generation + 1, so the fire is at
        * e.lease_generation - 1.
        */
       SELECT DISTINCT d.routine_id, d.bin_id, d.lease_generation
         FROM work_leases wl
         JOIN work_items wi ON wi.id = wl.work_item_id
         /*
          * The queue's own bin-scope rule, not wi.bin_id alone.
          *
          * A bin naming an orchestration is a lease on that packet, so it
          * reaches the packet's untagged work — and research items are exactly
          * that: enqueueResearchItem sets orchestration_id and leaves
          * bin_id null. Joining on the column alone therefore matched none of
          * them, which is every audit pass there is, so the arm found nothing
          * for the one session it was written to recover.
          */
         JOIN bins b ON (wi.bin_id = b.id OR (wi.bin_id IS NULL AND wi.orchestration_id = b.orchestration_id))
         JOIN bin_events e ON e.bin_id = b.id
                          AND e.event_type = 'BIN_ASSIGNED'
                          AND e.worker_id = wl.worker_id
                          AND e.at <= wl.claimed_at
         JOIN bin_dispatch d ON d.bin_id = e.bin_id
                            AND d.lease_generation = e.lease_generation - 1
                            AND d.state = 'SENT'
                            AND d.routine_id IS NOT NULL
        WHERE wl.credential_id = ?
          AND wl.worker_id = ?
          AND e.at = (
            SELECT MAX(e2.at) FROM bin_events e2
             WHERE e2.bin_id = e.bin_id
               AND e2.event_type = 'BIN_ASSIGNED'
               AND e2.worker_id = wl.worker_id
               AND e2.at <= wl.claimed_at
          )

        ORDER BY 3`,
      [candidate.session_ref, candidate.worker_id, candidate.session_ref, candidate.worker_id],
    );
    if (fires.length === 0) {
      report.unresolved.push({
        sessionRef: candidate.session_ref,
        reason:
          'no dispatch Brain sent names a Routine for any bin this session took or claimed work in',
      });
      continue;
    }
    const routines = new Set(fires.map((fire) => fire.routine_id));
    if (routines.size > 1) {
      report.unresolved.push({
        sessionRef: candidate.session_ref,
        reason: `${routines.size} Routines fired the bins this session took, so which one started it is not established`,
      });
      continue;
    }
    const first = fires[0]!;
    const routine = await getRoutine(first.routine_id);
    if (!routine?.accountId) {
      report.unresolved.push({
        sessionRef: candidate.session_ref,
        reason: 'the Routine that fired it resolves to no account',
      });
      continue;
    }
    await recordWorkerSession({
      sessionRef: candidate.session_ref,
      workerId: candidate.worker_id,
      routineId: routine.id,
      accountId: routine.accountId,
      binId: first.bin_id,
      leaseGeneration: first.lease_generation,
    });
    report.sessions.push({
      sessionRef: candidate.session_ref,
      routineId: routine.id,
      accountId: routine.accountId,
    });
  }

  /* -----------------------------------------------------------------------
   * 2. Passes whose session is now observed.
   *
   * Separate from step 1 rather than folded into it, because a session may have
   * been observed live — by a later arrival, or by a Brain that already had the
   * table — while the passes written before that observation still carry null.
   * --------------------------------------------------------------------- */
  const passes = await getDb().all<{
    id: string;
    executor_worker_id: string;
    executor_session_ref: string;
    executor_routine_id: string | null;
  }>(
    `SELECT id, executor_worker_id, executor_session_ref, executor_routine_id
       FROM research_passes
      WHERE executor_account_id IS NULL
        AND executor_worker_id IS NOT NULL
        AND executor_session_ref IS NOT NULL
        AND executor_session_ref <> ''
        AND executor_session_ref NOT LIKE 'future:%'
      ORDER BY started_at, rowid
      LIMIT ?`,
    [bounded],
  );

  for (const pass of passes) {
    const observed = await getWorkerSession(pass.executor_session_ref);
    // The worker has to match. A credential that resolves to a different worker
    // than the pass recorded is a contradiction between two rows, and filling
    // one in from the other would settle it by preference.
    if (!observed || observed.workerId !== pass.executor_worker_id) continue;
    const result = await getDb().run(
      `UPDATE research_passes
          SET executor_account_id = ?,
              executor_routine_id = COALESCE(executor_routine_id, ?)
        WHERE id = ? AND executor_account_id IS NULL`,
      [observed.accountId, observed.routineId, pass.id],
    );
    if (result.changes === 1) {
      report.passes.push({ passId: pass.id, accountId: observed.accountId });
    }
  }

  return report;
}

/** Nothing to recover, in the shape a caller reads. Exported for tests. */
export const NO_LINEAGE_RECOVERY = EMPTY;
