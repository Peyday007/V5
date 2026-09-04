/**
 * Whether real, independent audit lineage exists — decided from rows.
 *
 * `independence.ts` compares a set of passes. `auditEligibility.ts` decides
 * whether a worker may take an audit item *before* it is leased. Neither of
 * them answers the acceptance question, which is different and narrower:
 *
 *   **Has an audit actually run, in production, in three genuinely separate
 *   authenticated sessions — and can that be shown without trusting anything
 *   the submitter said about itself?**
 *
 * The question used to say *across two accounts*, and that was corrected. The
 * threat an independent audit exists to defeat is **one model context
 * reviewing its own work**, and three distinct authenticated sessions defeat
 * it. Two accounts also defeated it, and additionally made a finished product
 * unfinished whenever one particular subscription was unavailable — a property
 * no acceptance gate should have. Account separation is a stronger optional
 * assurance tier; it is measured and reported here, never required.
 *
 * That question needs its own evaluator, because the two above are checks that
 * run *during* the work and are satisfied by whatever lineage is presented,
 * while this one is asked afterwards and has to be hostile to the possibility
 * that the lineage was manufactured.
 *
 * ---------------------------------------------------------------------------
 * Fail-closed, and what that costs
 * ---------------------------------------------------------------------------
 *
 * The conditions are evaluated in order and the verdict is `PASS` only when
 * every one is met. A missing row, an unreadable value or an unreachable
 * database is `BLOCKED`, naming the first condition that failed. "We could not
 * tell" never reads the same as "we checked", which is the rule
 * `independence.ts` already applies one level down. The single exception is an
 * audit that has simply not been run yet, which is `NOT_RUN` — see the verdict
 * type below for why that distinction is load-bearing rather than cosmetic.
 *
 * The conditions are chosen so that the cheap ways to fake a pass do not work:
 *
 *   - **A session is a credential or it is nothing.** Each `session_ref` must
 *     exist as a real OAuth token or worker credential belonging to that same
 *     worker, so an invented session string cannot separate a judge from
 *     anybody. Three of them must be distinct, which is the floor.
 *   - **A predicted session is not a session.** `future:<routineId>` is how the
 *     allocator reasons about an activation that has not happened yet. Three
 *     placeholders would look perfectly distinct while nothing had ever
 *     authenticated, so they are refused by name.
 *   - **A lineage column is a claim until it agrees with the binding.** A
 *     pass's account must be the account its *worker* actually resolves to
 *     through `fleet_routines`, so a hand-written `executor_account_id` naming
 *     the account somebody wanted is refused. It contributes to the tier that
 *     gets *reported*, never to whether the gate passes.
 *   - **A judge that went first judged nothing.** The three completion stamps
 *     must put the judge last.
 *   - **A packet that filed nothing did not audit anything.** The passes must
 *     belong to an orchestration that filed a document with bytes recorded, so
 *     a bare set of pass rows is not evidence of an audit.
 *   - **The guard itself has to still refuse.** The separation minimum is
 *     compared to its expected shape and a same-session refusal is exercised
 *     live, so weakening the control in order to satisfy this evaluator makes
 *     this evaluator fail.
 *
 * What the achieved tier is used for is reporting, and only reporting. A
 * same-account result is labelled `SESSION_SEPARATED` and is never described as
 * cross-account independent.
 *
 * There is no override, no environment variable, no caller-supplied label and
 * no argument that shortens this. The only way to reach `PASS` is for the
 * production rows to be there — which is the point, because the gate exists to
 * be unsatisfiable by the thing it constrains.
 */
import { getDb } from '../../db/database.ts';
import { auditEligibility } from './auditEligibility.ts';
import { AUDIT_SEPARATION_MINIMUM } from './auditEligibility.ts';
import {
  SEPARATION_LABELS,
  strongestSeparation,
  type IndependenceLevel,
  type SeparationTier,
} from './independence.ts';

/** One requirement, and whether the rows meet it. */
export interface IndependenceCondition {
  key: string;
  met: boolean;
  /** Safe to print. Names counts and ids, never a credential or a digest. */
  detail: string;
}

export interface IndependenceEvidence {
  /**
   * Three answers, not two.
   *
   * `NOT_RUN` is the difference between *nothing has happened yet* and
   * *something is wrong*, and collapsing them is the defect this file was
   * built to stop reproducing: a gate that reads BLOCKED when the fleet is
   * healthy, the control is intact and the audit has simply not been run yet
   * names no remedy and invites being weakened to move it.
   */
  verdict: 'PASS' | 'NOT_RUN' | 'BLOCKED';
  /** The exact condition that is missing, or null when every one is met. */
  missing: string | null;
  conditions: IndependenceCondition[];
  /** What was actually achieved. Never rounded up, null when nothing was. */
  achieved: SeparationTier | null;
}

/** The shape the signed contract has. A different one is a different contract. */
const EXPECTED_MATRIX: Record<string, IndependenceLevel> = {
  PRIMARY_ADVERSARIAL: 'SESSION',
  JUDGE_PRIMARY: 'SESSION',
  JUDGE_ADVERSARIAL: 'SESSION',
};

/** The ordinals the three audit roles occupy, mirroring `independence.ts`. */
const ROLE_ORDINALS = { PRIMARY: 5, ADVERSARIAL: 6, JUDGE: 7 } as const;

interface LineageRow {
  orchestration_id: string;
  ordinal: number;
  completed_at: string | null;
  executor_worker_id: string | null;
  executor_routine_id: string | null;
  executor_account_id: string | null;
  executor_session_ref: string | null;
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return getDb().all<T>(sql, params as never[]);
}

export async function auditIndependenceEvidence(
  /**
   * Restrict the search to these orchestrations.
   *
   * Without it the evaluator answers "has *an* audit ever run here", which any
   * historical packet satisfies. The acceptance reporter passes the
   * orchestrations reached from the frozen Step 12A mission, so a Step 10/11
   * packet — however genuine its own lineage — cannot stand in for the mission
   * under acceptance. An empty array means *no orchestration in scope*, which
   * is a different fact from `undefined` and is reported as such rather than
   * silently widening to everything.
   */
  onlyOrchestrations?: readonly string[],
): Promise<IndependenceEvidence> {
  const conditions: IndependenceCondition[] = [];

  /** Record one condition and say whether the walk may continue. */
  const require = (key: string, met: boolean, detail: string): boolean => {
    conditions.push({ key, met, detail });
    return met;
  };

  let achieved: SeparationTier | null = null;
  const settle = (): IndependenceEvidence => {
    const failed = conditions.find((condition) => !condition.met);
    if (!failed) return { verdict: 'PASS', missing: null, conditions, achieved };
    /*
     * One condition means "not yet", and only one: every check before it has
     * passed, so the control is intact and a surface exists — the audit simply
     * has not been run. Everything else means something is actually wrong.
     */
    const notYet = failed.key === 'AUDIT_PASSES_RECORDED';
    return {
      verdict: notYet ? 'NOT_RUN' : 'BLOCKED',
      missing: `${failed.key} — ${failed.detail}`,
      conditions,
      achieved,
    };
  };

  try {
    /* ---------------------------------------------------------------------
     * 1. The control is intact.
     *
     * Compared before anything is read, because every condition below is only
     * meaningful while the rule they are evidence for still exists. Somebody
     * who weakened the matrix to make an audit eligible would find that this
     * fails first.
     * ------------------------------------------------------------------- */
    const matrixKeys = Object.keys(EXPECTED_MATRIX).sort();
    const actualKeys = Object.keys(AUDIT_SEPARATION_MINIMUM).sort();
    const matrixIntact =
      matrixKeys.length === actualKeys.length &&
      matrixKeys.every(
        (key, index) =>
          key === actualKeys[index] && AUDIT_SEPARATION_MINIMUM[key] === EXPECTED_MATRIX[key],
      );
    if (
      !require(
        'SIGNED_MATRIX_INTACT',
        matrixIntact,
        matrixIntact
          ? 'all three role pairs separated by session, the corrected floor'
          : 'the audit separation minimum is not the one this gate was written against',
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 2. The guard still refuses a second role in one session.
     *
     * Exercised rather than assumed: a synthetic executor presenting the
     * session the primary already used is offered to the real eligibility
     * function, and it has to say no. That is the actual threat — one model
     * context arguing with itself — and it is the negative case the corrected
     * contract names. Checking it live means a refactor that removed the
     * refusal cannot leave this gate reporting a pass it has no basis for.
     *
     * It used to probe a shared *account* with two different sessions. Under
     * the correction that case is legitimately eligible, so probing it would
     * have made this condition fail forever and blocked the gate on the very
     * topology the correction exists to permit.
     * ------------------------------------------------------------------- */
    const sameSession = auditEligibility({
      role: 'ADVERSARIAL',
      executor: {
        workerId: 'wkr_probe',
        routineId: 'rtn_probe',
        accountId: 'acct_probe',
        sessionRef: 'cred_probe_a',
      },
      passes: [
        {
          passKey: 'AUDIT',
          ordinal: ROLE_ORDINALS.PRIMARY,
          status: 'COMPLETE',
          executorWorkerId: 'wkr_other',
          executorRoutineId: 'rtn_other',
          executorAccountId: 'acct_other',
          executorSessionRef: 'cred_probe_a',
        } as never,
      ],
    });
    if (
      !require(
        'SAME_LINEAGE_REFUSAL_PRESERVED',
        !sameSession.eligible,
        sameSession.eligible
          ? 'the eligibility guard admitted an adversarial audit in the primary’s own session'
          : 'a second audit role in one session is still refused',
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 3. There is somewhere for an audit to run at all.
     *
     * This replaced a two-account requirement, and the replacement is a
     * correction rather than a relaxation. A fleet with no Routine that holds
     * a credential and has ever been bound cannot run an audit for reasons
     * that have nothing to do with independence — so it says
     * `NO_HEALTHY_EXECUTION_SURFACE`, which is the operational truth, instead
     * of naming a missing account or a missing person.
     * ------------------------------------------------------------------- */
    const healthy = await rows<{ account_id: string; worker_id: string | null }>(
      `SELECT r.account_id, r.worker_id
         FROM fleet_routines r
         JOIN fleet_accounts a ON a.id = r.account_id
        WHERE r.token_digest IS NOT NULL AND r.token_digest <> ''
          AND r.worker_id IS NOT NULL
          AND a.state IN ('ENABLED','DRAINING')
          AND r.state IN ('ENABLED','DRAINING')`,
    );
    if (
      !require(
        'NO_HEALTHY_EXECUTION_SURFACE',
        healthy.length > 0,
        healthy.length > 0
          ? `${healthy.length} Routine(s) hold a credential and a bound worker`
          : 'no Routine holds both a credential and a bound worker identity',
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 5. Three completed audit passes exist, with lineage recorded.
     * ------------------------------------------------------------------- */
    if (onlyOrchestrations && onlyOrchestrations.length === 0) {
      require(
        'AUDIT_PASSES_RECORDED',
        false,
        'no orchestration is in the acceptance scope, so no audit can belong to it',
      );
      return settle();
    }
    const scoped = onlyOrchestrations
      ? ` AND orchestration_id IN (${onlyOrchestrations.map(() => '?').join(', ')})`
      : '';
    const passes = await rows<LineageRow>(
      `SELECT orchestration_id, ordinal, completed_at,
              executor_worker_id, executor_routine_id, executor_account_id, executor_session_ref
         FROM research_passes
        WHERE status = 'COMPLETE'
          AND ordinal IN (?, ?, ?)
          AND executor_worker_id IS NOT NULL
          AND executor_account_id IS NOT NULL
          AND executor_session_ref IS NOT NULL
          AND executor_session_ref <> ''${scoped}
        ORDER BY orchestration_id, ordinal`,
      [
        ROLE_ORDINALS.PRIMARY,
        ROLE_ORDINALS.ADVERSARIAL,
        ROLE_ORDINALS.JUDGE,
        ...(onlyOrchestrations ?? []),
      ],
    );
    const byOrchestration = new Map<string, Map<number, LineageRow>>();
    for (const pass of passes) {
      const set = byOrchestration.get(pass.orchestration_id) ?? new Map<number, LineageRow>();
      // Latest wins on a re-run; ordering above makes that deterministic.
      set.set(pass.ordinal, pass);
      byOrchestration.set(pass.orchestration_id, set);
    }
    const complete = [...byOrchestration.entries()].filter(
      ([, set]) =>
        set.has(ROLE_ORDINALS.PRIMARY) && set.has(ROLE_ORDINALS.ADVERSARIAL) && set.has(ROLE_ORDINALS.JUDGE),
    );
    if (
      !require(
        'AUDIT_PASSES_RECORDED',
        complete.length >= 1,
        complete.length >= 1
          ? `${complete.length} packet(s) recorded all three audit roles with lineage`
          : 'no packet has recorded all three audit roles with complete lineage',
      )
    ) {
      return settle();
    }

    /*
     * From here every remaining condition is asked of the *same* packet, so a
     * pass is one real audit rather than parts of several. The first packet
     * that satisfies all of them wins; the reasons from the last one examined
     * are what a refusal reports.
     */
    let winner: string | null = null;
    let lastReasons: IndependenceCondition[] = [];

    for (const [orchestrationId, set] of complete) {
      const local: IndependenceCondition[] = [];
      const check = (key: string, met: boolean, detail: string): boolean => {
        local.push({ key, met, detail });
        return met;
      };

      const primary = set.get(ROLE_ORDINALS.PRIMARY)!;
      const adversarial = set.get(ROLE_ORDINALS.ADVERSARIAL)!;
      const judge = set.get(ROLE_ORDINALS.JUDGE)!;
      const three = [primary, adversarial, judge];

      /* 6. Every lineage column agrees with the binding it claims. */
      const accountsByWorker = new Map<string, Set<string>>();
      for (const surface of healthy) {
        if (!surface.worker_id) continue;
        const set = accountsByWorker.get(surface.worker_id) ?? new Set<string>();
        set.add(surface.account_id);
        accountsByWorker.set(surface.worker_id, set);
      }
      const mismatched = three.filter((pass) => {
        const accounts = accountsByWorker.get(pass.executor_worker_id!);
        // A worker bound to several accounts has no single account to agree
        // with, so its *account* claim cannot be checked and is not trusted —
        // but that no longer disqualifies the audit, because the session floor
        // does not depend on it.
        return accounts !== undefined && accounts.size === 1 && ![...accounts].includes(pass.executor_account_id!);
      });
      if (
        !check(
          'LINEAGE_MATCHES_BINDING',
          mismatched.length === 0,
          mismatched.length === 0
            ? 'no pass names an account its worker is not bound to'
            : `${mismatched.length} pass(es) name an account their worker is not bound to`,
        )
      ) {
        lastReasons = local;
        continue;
      }

      /* 7. Every session ref is a real credential belonging to that worker. */
      let realSessions = 0;
      for (const pass of three) {
        const found = await rows<{ total: number }>(
          `SELECT (
             (SELECT COUNT(*) FROM oauth_tokens WHERE id = ? AND worker_id = ?) +
             (SELECT COUNT(*) FROM worker_credentials WHERE id = ? AND worker_id = ?)
           ) AS total`,
          [
            pass.executor_session_ref,
            pass.executor_worker_id,
            pass.executor_session_ref,
            pass.executor_worker_id,
          ],
        );
        if (Number(found[0]?.total ?? 0) > 0) realSessions += 1;
      }
      if (
        !check(
          'SESSIONS_ARE_REAL_CREDENTIALS',
          realSessions === three.length,
          realSessions === three.length
            ? 'all three sessions resolve to a credential issued to that worker'
            : `${three.length - realSessions} session reference(s) do not resolve to a credential of that worker`,
        )
      ) {
        lastReasons = local;
        continue;
      }

      /*
       * 7b. No predicted session survived into the evidence.
       *
       * `future:<routineId>` is how the allocator reasons about an activation
       * that has not happened. It is a prediction and must never become the
       * proof: three placeholders would look perfectly distinct while no
       * session had ever authenticated.
       */
      const predicted = three.filter((pass) => pass.executor_session_ref!.startsWith('future:'));
      if (
        !check(
          'SESSIONS_ARE_REAL_ACTIVATIONS',
          predicted.length === 0,
          predicted.length === 0
            ? 'every session reference is a real authenticated activation'
            : `${predicted.length} pass(es) carry a predicted session rather than a real one`,
        )
      ) {
        lastReasons = local;
        continue;
      }

      /*
       * 8. Three distinct sessions — the hard minimum — and the truthful tier.
       *
       * The floor is what makes this gate independent of topology: three
       * authenticated sessions defeat one context reviewing its own work,
       * which is the threat. The achieved tier is recorded alongside and is
       * never rounded up.
       */
      const tier = strongestSeparation(
        three.map((pass, index) => ({
          role: (['PRIMARY', 'ADVERSARIAL', 'JUDGE'] as const)[index]!,
          workerId: pass.executor_worker_id,
          // Read from the row rather than passed as null. A Routine is a tier
          // of its own — one account may hold several and one worker may be
          // bound to several — so reporting it as absent would collapse
          // ROUTINE_SEPARATED into SESSION_SEPARATED and understate what the
          // fleet actually achieved.
          routineId: pass.executor_routine_id,
          accountId: pass.executor_account_id,
          sessionRef: pass.executor_session_ref,
        })),
      );
      if (
        !check(
          'THREE_DISTINCT_SESSIONS',
          tier !== null,
          tier !== null
            ? `separation achieved: ${SEPARATION_LABELS[tier]}`
            : 'two of the three roles ran in the same session',
        )
      ) {
        lastReasons = local;
        continue;
      }
      achieved = tier;

      /* 8b. The judge did not argue, and did not go first. */
      const ordered =
        Date.parse(judge.completed_at ?? '') >= Date.parse(primary.completed_at ?? '') &&
        Date.parse(judge.completed_at ?? '') >= Date.parse(adversarial.completed_at ?? '');
      if (
        !check(
          'JUDGE_RAN_LAST',
          ordered,
          ordered
            ? 'the judge completed after both arguments'
            : 'the judge completed before an argument it was meant to judge',
        )
      ) {
        lastReasons = local;
        continue;
      }

      /* 9. The packet filed something. An audit of nothing is not an audit. */
      const filed = await rows<{ total: number }>(
        `SELECT COUNT(*) AS total
           FROM research_orchestrations o
           JOIN documents d ON d.id = o.document_id
          WHERE o.id = ? AND d.file_size IS NOT NULL AND d.file_size > 0
            AND d.file_hash IS NOT NULL AND d.file_missing = 0`,
        [orchestrationId],
      );
      if (
        !check(
          'AUDITED_PACKET_WAS_FILED',
          Number(filed[0]?.total ?? 0) > 0,
          Number(filed[0]?.total ?? 0) > 0
            ? 'the audited packet filed a document with bytes recorded'
            : 'the audited packet has no filed document with bytes',
        )
      ) {
        lastReasons = local;
        continue;
      }

      winner = orchestrationId;
      lastReasons = local;
      break;
    }

    for (const condition of lastReasons) conditions.push(condition);
    if (!winner && lastReasons.length === 0) {
      // Defensive: `complete` was non-empty, so this cannot normally happen.
      // Recorded rather than assumed away, because a silent empty result here
      // would read as a pass.
      require('AUDIT_PASSES_RECORDED', false, 'no packet could be examined');
    }
    return settle();
  } catch (error) {
    // An unreadable database is not a pass. It is not a failure of the audit
    // either, so it is reported as the blocking condition it is.
    conditions.push({
      key: 'EVIDENCE_READABLE',
      met: false,
      detail: `the lineage could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return settle();
  }
}
