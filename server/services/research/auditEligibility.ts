/**
 * Who may perform an audit role, decided by Brain before the work is leased.
 *
 * ---------------------------------------------------------------------------
 * The signed matrix, and why it is not one level
 * ---------------------------------------------------------------------------
 *
 * `independence.ts` can compare a set of passes at one dimension. The contract
 * Step 11 is actually signed against is not one dimension — it is two, and
 * reading it as one is what produced a rule the fleet could never satisfy:
 *
 *   L9  "PRIMARY and ADVERSARIAL run concurrently through **different
 *        accounts**"                                        -> ACCOUNT
 *   L10 "JUDGE runs after both, on independent lineage;
 *        **same-session lineage refused**"                  -> SESSION
 *
 * Applying ACCOUNT to all three pairs demands three pairwise-distinct accounts
 * and is unsatisfiable on a two-account fleet. Applying WORKER to all three
 * demands three worker identities, and a worker identity is per-Routine, so it
 * is unsatisfiable too. Neither is what was signed. The signed contract asks for
 * account separation between the two arguers and session separation for the
 * judge, and **two accounts satisfy that exactly**: PRIMARY on one account,
 * ADVERSARIAL on the other, JUDGE on either in a third session.
 *
 * So the matrix is per-pair, and it is a constant here rather than an argument,
 * because a caller that could choose the level is a caller that could lower it.
 *
 * ---------------------------------------------------------------------------
 * Elasticity
 * ---------------------------------------------------------------------------
 *
 * No count appears below. The requirement is "the account differs from the one
 * that ran the other argument" and "the session differs from both", which is
 * satisfied by two accounts and by twenty. Adding accounts widens the set of
 * eligible surfaces; removing one narrows it; neither changes a rule.
 */
import type { ResearchPass } from '../../domain/types.ts';
import type { AuditRole } from '../queue/workTypes.ts';
import {
  INDEPENDENCE_POLICY_VERSION,
  lineageFromPasses,
  type AuditLineage,
  type IndependenceLevel,
} from './independence.ts';

/** The pairs the contract names, and the dimension each is separated on. */
export const SIGNED_AUDIT_MATRIX: Record<string, IndependenceLevel> = {
  PRIMARY_ADVERSARIAL: 'ACCOUNT',
  JUDGE_PRIMARY: 'SESSION',
  JUDGE_ADVERSARIAL: 'SESSION',
};

/** The lineage a candidate executor would bring, all of it server-derived. */
export interface ExecutorLineage {
  workerId: string;
  routineId: string | null;
  accountId: string | null;
  /**
   * The credential this request authenticated with.
   *
   * Server-derived and per-activation: an OAuth access token is minted per
   * worker session and rotated, which CF-8 measured (85 rotated, 85 used). It
   * is never a body field, so a Routine cannot present someone else's session
   * to make itself eligible — which is the whole reason independence is decided
   * here rather than in a Routine's instructions.
   */
  sessionRef: string;
}

export interface EligibilityVerdict {
  eligible: boolean;
  policyVersion: string;
  /** Why not, in the words a refusal is recorded with. */
  reasons: string[];
  /** The pairs that were compared and the dimension each used. */
  applied: { pair: string; level: IndependenceLevel; against: AuditRole }[];
}

function dimensionOf(level: IndependenceLevel): (l: AuditLineage | ExecutorLineage) => string | null {
  switch (level) {
    case 'ACCOUNT':
      return (l) => l.accountId;
    case 'WORKER':
      return (l) => l.workerId;
    case 'SESSION':
    default:
      return (l) => l.sessionRef;
  }
}

function noun(level: IndependenceLevel): string {
  return level === 'ACCOUNT' ? 'account' : level === 'WORKER' ? 'worker' : 'session';
}

/** Which matrix entry governs this pair of roles, in either order. */
function pairKey(a: AuditRole, b: AuditRole): string | null {
  const set = new Set([a, b]);
  if (set.has('PRIMARY') && set.has('ADVERSARIAL')) return 'PRIMARY_ADVERSARIAL';
  if (set.has('JUDGE') && set.has('PRIMARY')) return 'JUDGE_PRIMARY';
  if (set.has('JUDGE') && set.has('ADVERSARIAL')) return 'JUDGE_ADVERSARIAL';
  return null;
}

/**
 * May this executor take this role on this packet?
 *
 * Decided against the lineage already recorded for the packet's other roles.
 * A role with no counterpart yet recorded has nothing to conflict with and is
 * eligible — the constraint binds the second and third role, which is the only
 * place it can bind.
 *
 * **Unknown lineage fails closed.** An executor whose account cannot be
 * resolved is refused for a pair governed at ACCOUNT, because "we could not
 * tell" must never read the same as "we checked". That is deliberate and it is
 * why registering a Routine binds its worker: an unregistered surface is not
 * eligible to argue.
 */
export function auditEligibility(input: {
  role: AuditRole;
  executor: ExecutorLineage;
  passes: ResearchPass[];
}): EligibilityVerdict {
  const { role, executor, passes } = input;
  const { audits } = lineageFromPasses(passes);
  const reasons: string[] = [];
  const applied: EligibilityVerdict['applied'] = [];

  for (const recorded of audits) {
    if (recorded.role === role) continue;
    const key = pairKey(role, recorded.role);
    if (!key) continue;
    const level = SIGNED_AUDIT_MATRIX[key]!;
    applied.push({ pair: key, level, against: recorded.role });

    const read = dimensionOf(level);
    const mine = read(executor);
    const theirs = read(recorded);

    if (mine === null || theirs === null) {
      reasons.push(
        `${role} cannot be compared with ${recorded.role}: one of them has no ${noun(level)} ` +
          `recorded, and unrecorded lineage is not evidence of independence.`,
      );
      continue;
    }
    if (mine === theirs) {
      reasons.push(
        `${role} would share the same ${noun(level)} (${mine}) as ${recorded.role}, ` +
          `which ${key} requires to differ.`,
      );
    }
  }

  return {
    eligible: reasons.length === 0,
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    reasons,
    applied,
  };
}

/**
 * The same matrix applied to a finished set of passes, for the refusal that
 * guards storage.
 *
 * Separate from `auditEligibility` because the questions differ: that one asks
 * "may this executor start", this one asks "is what actually ran compliant".
 * A packet can pass the first and fail the second — a lease can expire and be
 * retaken by a surface that was eligible when it claimed and is not once
 * another role has run — so the verdict is checked again where state moves.
 */
export function auditMatrixVerdict(passes: ResearchPass[]): EligibilityVerdict {
  const { audits } = lineageFromPasses(passes);
  const reasons: string[] = [];
  const applied: EligibilityVerdict['applied'] = [];
  const byRole = new Map<AuditRole, AuditLineage>();
  for (const lineage of audits) byRole.set(lineage.role, lineage);

  for (const [key, level] of Object.entries(SIGNED_AUDIT_MATRIX)) {
    const [left, right] = key.split('_') as [AuditRole, AuditRole];
    const a = byRole.get(left);
    const b = byRole.get(right);
    if (!a || !b) continue;
    applied.push({ pair: key, level, against: right });
    const read = dimensionOf(level);
    const ka = read(a);
    const kb = read(b);
    if (ka === null || kb === null) {
      reasons.push(
        `${left} and ${right} cannot be compared: one recorded no ${noun(level)}.`,
      );
      continue;
    }
    if (ka === kb) reasons.push(`${left} and ${right} shared the same ${noun(level)} (${ka}).`);
  }

  return {
    eligible: reasons.length === 0,
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    reasons,
    applied,
  };
}
