/**
 * Whether real, independent audit lineage exists — decided from rows.
 *
 * `independence.ts` compares a set of passes. `auditEligibility.ts` decides
 * whether a worker may take an audit item *before* it is leased. Neither of
 * them answers the acceptance question, which is different and narrower:
 *
 *   **Has an audit actually run, in production, across genuinely separate
 *   accounts and sessions — and can that be shown without trusting anything
 *   the submitter said about itself?**
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
 * Nine conditions, evaluated in order, and the verdict is `PASS` only when
 * every one is met. Anything else — a missing row, an unreadable value, an
 * unreachable database — is `BLOCKED` naming the first condition that failed.
 * "We could not tell" never reads the same as "we checked", which is the rule
 * `independence.ts` already applies one level down.
 *
 * The conditions are chosen so that the cheap ways to fake a pass do not work:
 *
 *   - **Two accounts that share a credential are one account.** The digests
 *     have to differ, so registering the same subscription twice under two
 *     names fails rather than doubling the fleet on paper.
 *   - **A lineage column is a claim until it agrees with the binding.** Each
 *     pass's account must be the account its *worker* actually resolves to
 *     through `fleet_routines`, so a hand-written `executor_account_id` naming
 *     the account somebody wanted is refused.
 *   - **A session is a credential or it is nothing.** Each `session_ref` must
 *     exist as a real OAuth token or worker credential belonging to that same
 *     worker, so an invented session string cannot separate a judge from
 *     anybody.
 *   - **A packet that filed nothing did not audit anything.** The passes must
 *     belong to an orchestration that filed a document with bytes recorded, so
 *     a bare set of pass rows is not evidence of an audit.
 *   - **The guard itself has to still refuse.** The signed matrix is compared
 *     to its expected shape and the refusal is exercised live, so weakening the
 *     control in order to satisfy this evaluator makes this evaluator fail.
 *
 * There is no override, no environment variable, no caller-supplied label and
 * no argument that shortens this. The only way to reach `PASS` is for the
 * production rows to be there — which is the point, because the gate exists to
 * be unsatisfiable by the thing it constrains.
 */
import { getDb } from '../../db/database.ts';
import { auditEligibility } from './auditEligibility.ts';
import { SIGNED_AUDIT_MATRIX } from './auditEligibility.ts';
import type { IndependenceLevel } from './independence.ts';

/** One requirement, and whether the rows meet it. */
export interface IndependenceCondition {
  key: string;
  met: boolean;
  /** Safe to print. Names counts and ids, never a credential or a digest. */
  detail: string;
}

export interface IndependenceEvidence {
  verdict: 'PASS' | 'BLOCKED';
  /** The exact condition that is missing, or null when every one is met. */
  missing: string | null;
  conditions: IndependenceCondition[];
}

/** The shape the signed contract has. A different one is a different contract. */
const EXPECTED_MATRIX: Record<string, IndependenceLevel> = {
  PRIMARY_ADVERSARIAL: 'ACCOUNT',
  JUDGE_PRIMARY: 'SESSION',
  JUDGE_ADVERSARIAL: 'SESSION',
};

/** The ordinals the three audit roles occupy, mirroring `independence.ts`. */
const ROLE_ORDINALS = { PRIMARY: 5, ADVERSARIAL: 6, JUDGE: 7 } as const;

interface LineageRow {
  orchestration_id: string;
  ordinal: number;
  executor_worker_id: string | null;
  executor_account_id: string | null;
  executor_session_ref: string | null;
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return getDb().all<T>(sql, params as never[]);
}

export async function auditIndependenceEvidence(): Promise<IndependenceEvidence> {
  const conditions: IndependenceCondition[] = [];

  /** Record one condition and say whether the walk may continue. */
  const require = (key: string, met: boolean, detail: string): boolean => {
    conditions.push({ key, met, detail });
    return met;
  };

  const settle = (): IndependenceEvidence => {
    const failed = conditions.find((condition) => !condition.met);
    return {
      verdict: failed ? 'BLOCKED' : 'PASS',
      missing: failed ? `${failed.key} — ${failed.detail}` : null,
      conditions,
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
    const actualKeys = Object.keys(SIGNED_AUDIT_MATRIX).sort();
    const matrixIntact =
      matrixKeys.length === actualKeys.length &&
      matrixKeys.every(
        (key, index) =>
          key === actualKeys[index] && SIGNED_AUDIT_MATRIX[key] === EXPECTED_MATRIX[key],
      );
    if (
      !require(
        'SIGNED_MATRIX_INTACT',
        matrixIntact,
        matrixIntact
          ? 'PRIMARY/ADVERSARIAL separated by account, JUDGE by session'
          : 'the signed audit matrix is not the one this gate was written against',
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 2. The guard still refuses a same-lineage audit.
     *
     * Exercised rather than assumed: a synthetic executor that shares the
     * primary's account is offered to the real eligibility function, and it has
     * to say no. This is the negative case the contract names, and checking it
     * live means a refactor that removed the refusal cannot leave this gate
     * reporting a pass it has no basis for.
     * ------------------------------------------------------------------- */
    const sameAccount = auditEligibility({
      role: 'ADVERSARIAL',
      executor: {
        workerId: 'wkr_probe',
        routineId: 'rtn_probe',
        accountId: 'acct_shared',
        sessionRef: 'cred_probe_b',
      },
      passes: [
        {
          passKey: 'AUDIT',
          ordinal: ROLE_ORDINALS.PRIMARY,
          status: 'COMPLETE',
          executorWorkerId: 'wkr_other',
          executorRoutineId: 'rtn_other',
          executorAccountId: 'acct_shared',
          executorSessionRef: 'cred_probe_a',
        } as never,
      ],
    });
    if (
      !require(
        'SAME_LINEAGE_REFUSAL_PRESERVED',
        !sameAccount.eligible,
        sameAccount.eligible
          ? 'the eligibility guard admitted an adversarial audit on the primary’s own account'
          : 'a shared-account adversarial audit is still refused',
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 3. Two accounts, and two genuinely different credentials.
     *
     * The digest is what makes them different. Two names over one subscription
     * would satisfy a count and satisfy nothing else, so the count is not what
     * is asked for.
     * ------------------------------------------------------------------- */
    const surfaces = await rows<{ account_id: string; worker_id: string | null; token_digest: string | null }>(
      `SELECT r.account_id, r.worker_id, r.token_digest
         FROM fleet_routines r
         JOIN fleet_accounts a ON a.id = r.account_id
        WHERE r.token_digest IS NOT NULL AND r.token_digest <> ''
          AND a.state IN ('ENABLED','DRAINING')
          AND r.state IN ('ENABLED','DRAINING')`,
    );
    const digestsByAccount = new Map<string, Set<string>>();
    for (const surface of surfaces) {
      const set = digestsByAccount.get(surface.account_id) ?? new Set<string>();
      set.add(surface.token_digest!);
      digestsByAccount.set(surface.account_id, set);
    }
    const allDigests = surfaces.map((surface) => surface.token_digest!);
    const digestsAreDistinct = new Set(allDigests).size === allDigests.length;
    if (
      !require(
        'DISTINCT_ACCOUNT_CREDENTIALS',
        digestsByAccount.size >= 2 && digestsAreDistinct,
        digestsByAccount.size < 2
          ? `only ${digestsByAccount.size} routable account(s) hold a registered credential`
          : digestsAreDistinct
            ? `${digestsByAccount.size} accounts, each with its own credential`
            : 'two registered surfaces share one credential, so they are one account',
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 4. Distinct worker identities, each bound to exactly one account.
     *
     * A worker whose Routines span accounts has no resolvable account, which
     * `lineageForWorker` already fails closed on. Here it would also mean the
     * separation cannot be established afterwards, so it is refused by name
     * rather than left to produce a null further down.
     * ------------------------------------------------------------------- */
    const accountsByWorker = new Map<string, Set<string>>();
    for (const surface of surfaces) {
      if (!surface.worker_id) continue;
      const set = accountsByWorker.get(surface.worker_id) ?? new Set<string>();
      set.add(surface.account_id);
      accountsByWorker.set(surface.worker_id, set);
    }
    const boundWorkers = [...accountsByWorker.entries()].filter(([, accounts]) => accounts.size === 1);
    const activeWorkers = boundWorkers.length
      ? await rows<{ id: string }>(
          `SELECT id FROM workers
            WHERE status = 'ACTIVE' AND disabled_at IS NULL
              AND id IN (${boundWorkers.map(() => '?').join(',')})`,
          boundWorkers.map(([workerId]) => workerId),
        )
      : [];
    const usableAccounts = new Set(
      boundWorkers
        .filter(([workerId]) => activeWorkers.some((worker) => worker.id === workerId))
        .map(([, accounts]) => [...accounts][0]!),
    );
    if (
      !require(
        'DISTINCT_BOUND_WORKERS',
        activeWorkers.length >= 2 && usableAccounts.size >= 2,
        activeWorkers.length < 2
          ? `${activeWorkers.length} active worker identit(y/ies) are bound to a registered Routine`
          : usableAccounts.size < 2
            ? 'the bound workers all resolve to one account'
            : `${activeWorkers.length} bound workers across ${usableAccounts.size} accounts`,
      )
    ) {
      return settle();
    }

    /* ---------------------------------------------------------------------
     * 5. Three completed audit passes exist, with lineage recorded.
     * ------------------------------------------------------------------- */
    const passes = await rows<LineageRow>(
      `SELECT orchestration_id, ordinal, executor_worker_id, executor_account_id, executor_session_ref
         FROM research_passes
        WHERE status = 'COMPLETE'
          AND ordinal IN (?, ?, ?)
          AND executor_worker_id IS NOT NULL
          AND executor_account_id IS NOT NULL
          AND executor_session_ref IS NOT NULL
          AND executor_session_ref <> ''
        ORDER BY orchestration_id, ordinal`,
      [ROLE_ORDINALS.PRIMARY, ROLE_ORDINALS.ADVERSARIAL, ROLE_ORDINALS.JUDGE],
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
      const mismatched = three.filter((pass) => {
        const accounts = accountsByWorker.get(pass.executor_worker_id!);
        return !accounts || accounts.size !== 1 || ![...accounts].includes(pass.executor_account_id!);
      });
      if (
        !check(
          'LINEAGE_MATCHES_BINDING',
          mismatched.length === 0,
          mismatched.length === 0
            ? 'every pass names the account its worker is actually bound to'
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

      /* 8. The separation the signed matrix asks for. */
      const accountsDiffer = primary.executor_account_id !== adversarial.executor_account_id;
      const judgeSessionDiffers =
        judge.executor_session_ref !== primary.executor_session_ref &&
        judge.executor_session_ref !== adversarial.executor_session_ref;
      if (
        !check(
          'INDEPENDENT_LINEAGE',
          accountsDiffer && judgeSessionDiffers,
          !accountsDiffer
            ? 'PRIMARY and ADVERSARIAL ran on the same account'
            : !judgeSessionDiffers
              ? 'the JUDGE ran in a session that also argued'
              : 'PRIMARY and ADVERSARIAL on different accounts, JUDGE in a third session',
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
