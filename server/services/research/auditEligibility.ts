/**
 * Who may perform an audit role, decided by Brain before the work is leased.
 *
 * ---------------------------------------------------------------------------
 * The minimum, and why it has no topology in it
 * ---------------------------------------------------------------------------
 *
 * The threat an independent audit exists to defeat is **one model context
 * reviewing its own work**. Three distinct authenticated sessions defeat it, so
 * that is the floor: every pair of roles must differ at `SESSION`, and nothing
 * below counts an account, a worker or a Routine.
 *
 * An earlier version required `ACCOUNT` between the two arguers. It defeated
 * the same threat and it also fused a *property of the system* with a
 * *temporary fact about the fleet* — so losing a subscription made a finished
 * product unfinished, and a blocked board created pressure to weaken the
 * control rather than to provision. That correction is recorded here and in
 * CLAUDE.md §23 rather than applied silently: the old rule was not wrong about
 * the danger, it was wrong about what the danger required.
 *
 * Stronger separation is a *preference*, not a requirement. The ladder is
 * `ACCOUNT > WORKER > ROUTINE > SESSION`; `auditAdmission.rankSurfacesFor`
 * reaches for the strongest a fleet can supply, `independence.strongestSeparation`
 * reports what was actually achieved, and neither may round up.
 *
 * ---------------------------------------------------------------------------
 * Elasticity
 * ---------------------------------------------------------------------------
 *
 * No count appears below. The requirement is "this role's session differs from
 * the session that ran the other role", which one Routine satisfies by being
 * activated three times and twenty accounts satisfy the same way. Adding
 * surfaces widens the eligible set and raises the achievable tier; removing
 * one narrows it and lowers the tier; neither changes a rule and neither
 * decides whether a packet can finish.
 */
import type { ResearchPass } from '../../domain/types.ts';
import type { AuditRole } from '../queue/workTypes.ts';
import {
  INDEPENDENCE_POLICY_VERSION,
  lineageFromPasses,
  SEPARATION_LADDER,
  type AuditLineage,
  type IndependenceLevel,
  type SeparationTier,
} from './independence.ts';

/** The ordinals the roles occupy, mirroring `independence.ts`. */
const ROLE_BY_ORDINAL_LOCAL: Record<number, AuditRole> = {
  5: 'PRIMARY',
  6: 'ADVERSARIAL',
  7: 'JUDGE',
};

/** Is `a` a stricter separation than `b`? `NONE` is never stricter. */
function stricter(a: SeparationTier, b: IndependenceLevel): boolean {
  if (b === 'NONE') return true;
  const rank = (tier: string): number => SEPARATION_LADDER.indexOf(tier as SeparationTier);
  const ra = rank(a);
  const rb = rank(b);
  if (ra < 0 || rb < 0) return false;
  // The ladder runs strongest-first, so a lower index is a stricter tier.
  return ra < rb;
}

/**
 * The hard minimum, per pair.
 *
 * ---------------------------------------------------------------------------
 * A recorded correction to the original two-account requirement
 * ---------------------------------------------------------------------------
 *
 * This constant used to read `PRIMARY_ADVERSARIAL: 'ACCOUNT'`, which fused two
 * different things: the *threat* the audit exists to stop, and the *topology*
 * that happened to be registered when it was written. The threat is **one model
 * context reviewing its own work**. Three distinct authenticated sessions
 * defeat that. Requiring two accounts defeated it too, but it also made
 * completion depend on a named friend's subscription — so a fleet losing an
 * account made a finished product unfinished, which is not a property an
 * acceptance gate should have.
 *
 * So the minimum is `SESSION` on every pair, and cross-account diversity is a
 * **stronger optional assurance tier** the allocator reaches for when the fleet
 * can supply it. This is a deliberate product-owner correction and it is
 * written down as one rather than applied quietly: the earlier rule was not
 * wrong about the danger, it was wrong about what the danger required.
 *
 * A caller still cannot choose the level. `requiredTier` may only ever make a
 * mission *stricter* than this floor — never looser — and that is checked
 * rather than trusted.
 */
export const AUDIT_SEPARATION_MINIMUM: Record<string, IndependenceLevel> = {
  PRIMARY_ADVERSARIAL: 'SESSION',
  JUDGE_PRIMARY: 'SESSION',
  JUDGE_ADVERSARIAL: 'SESSION',
  /*
   * ---------------------------------------------------------------------
   * The author of the report is a party to its audit, and was not.
   * ---------------------------------------------------------------------
   *
   * These three are a **strengthening**, added after a production reading
   * asked a question the matrix could not answer: the recovered session
   * reported completing "synthesis redo and PRIMARY audit", and nothing in
   * this file could say whether that was one context reviewing its own work.
   *
   * It could not say because the matrix had no entry for it.
   * `lineageFromPasses` has always extracted the SYNTHESIS pass's lineage —
   * and labelled it `role: 'PRIMARY'`, which is the original intent written
   * down — but all three of its callers destructured `{ audits }` and threw
   * the synthesis away. So the three audit roles were separated from each
   * other and **none of them was separated from the author of the thing they
   * were auditing.** A mechanism nothing calls is not a mechanism; this one
   * was extracted, typed, and read by nobody.
   *
   * That is not a subtle gap. §23 states the threat in one sentence — *one
   * model context reviewing its own work* — and a session that writes the
   * synthesis and then files the PRIMARY audit is the literal instance of it.
   * The three-way separation made the *reviewers* independent of each other
   * while leaving every one of them free to be the author.
   *
   * All three roles are named rather than just PRIMARY, because the reason is
   * about authorship rather than about which role happens to read first: an
   * adversarial critic of its own report and a judge of its own report are the
   * same defect one step along.
   */
  SYNTHESIS_PRIMARY: 'SESSION',
  SYNTHESIS_ADVERSARIAL: 'SESSION',
  SYNTHESIS_JUDGE: 'SESSION',
};

/**
 * Everyone the matrix can separate: the three audit roles and the author.
 *
 * `AuditRole` stays exactly what it was — the roles a worker can be *assigned*
 * — because SYNTHESIS is not one of those. Widening it would make
 * `brain_claim_work` able to ask for a role that does not exist.
 */
export type SeparationParty = AuditRole | 'SYNTHESIS';

/**
 * Kept as an alias so nothing that read the old name silently reads nothing.
 * It is the same object: there is one minimum, not two.
 */
export const SIGNED_AUDIT_MATRIX = AUDIT_SEPARATION_MINIMUM;

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
  /**
   * Why not, safe to return to the caller.
   *
   * Names the pair and the dimension and never the value, because the session
   * dimension is a credential identifier.
   */
  reasons: string[];
  /**
   * The pairs that were compared and the dimension each used.
   *
   * `against` is a `SeparationParty` rather than an `AuditRole` because the
   * author of the report is one of the parties now. It is not a role anything
   * can be assigned — see `SeparationParty` — it is a party to the comparison.
   */
  applied: { pair: string; level: IndependenceLevel; against: SeparationParty }[];
  /** The offending values, for Brain's own log. Never returned to a caller. */
  conflicts: { pair: string; level: IndependenceLevel; dimension: string; value: string }[];
}

function dimensionOf(level: IndependenceLevel): (l: AuditLineage | ExecutorLineage) => string | null {
  switch (level) {
    case 'ACCOUNT':
      return (l) => l.accountId;
    case 'WORKER':
      return (l) => l.workerId;
    case 'ROUTINE':
      // A tier of its own, never a synonym for worker: one account may hold
      // several Routines and one worker may be bound to several, so collapsing
      // them would compare the wrong thing in both directions.
      return (l) => l.routineId;
    case 'SESSION':
    default:
      return (l) => l.sessionRef;
  }
}

function noun(level: IndependenceLevel): string {
  return level === 'ACCOUNT'
    ? 'account'
    : level === 'WORKER'
      ? 'worker'
      : level === 'ROUTINE'
        ? 'Routine'
        : 'session';
}

/** Which matrix entry governs this pair of parties, in either order. */
function pairKey(a: SeparationParty, b: SeparationParty): string | null {
  const set = new Set<SeparationParty>([a, b]);
  if (set.has('PRIMARY') && set.has('ADVERSARIAL')) return 'PRIMARY_ADVERSARIAL';
  if (set.has('JUDGE') && set.has('PRIMARY')) return 'JUDGE_PRIMARY';
  if (set.has('JUDGE') && set.has('ADVERSARIAL')) return 'JUDGE_ADVERSARIAL';
  // The author against each reviewer. Order-independent like the rest: the
  // question is whether two parties are the same context, not who asked first.
  if (set.has('SYNTHESIS') && set.has('PRIMARY')) return 'SYNTHESIS_PRIMARY';
  if (set.has('SYNTHESIS') && set.has('ADVERSARIAL')) return 'SYNTHESIS_ADVERSARIAL';
  if (set.has('SYNTHESIS') && set.has('JUDGE')) return 'SYNTHESIS_JUDGE';
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
 * tell" must never read the same as "we checked". At the floor that costs
 * nothing — every authenticated request has a session — so failing closed
 * narrows only the missions that asked for more than the floor.
 */
export function auditEligibility(input: {
  role: AuditRole;
  executor: ExecutorLineage;
  passes: ResearchPass[];
  /** A mission may demand more than the floor. It may never demand less. */
  requiredTier?: SeparationTier;
}): EligibilityVerdict {
  const { role, executor, passes, requiredTier } = input;
  /*
   * The author is read out alongside the reviewers, and that is the whole of
   * the correction this file's matrix comment records. `lineageFromPasses` has
   * always returned both; every caller took `{ audits }` and dropped the other
   * half on the floor, so the three reviewers were separated from each other
   * and none of them from the session that wrote the thing being reviewed.
   */
  const { audits, synthesisAttempts } = lineageFromPasses(passes);
  /*
   * `lineageFromPasses` labels the synthesis lineage `role: 'PRIMARY'` — the
   * original intent, written into a field nothing read. It is relabelled here
   * rather than there, because `checkIndependence` compares that object's
   * `sessionRef` and never its role, and changing the shared shape to fix a
   * label would be a change to a module this one only reads from.
   */
  const parties: { party: SeparationParty; lineage: AuditLineage }[] = [
    ...audits.map((a) => ({ party: a.role as SeparationParty, lineage: a })),
    // Every completed attempt, not only the newest. A session that wrote a
    // superseded synthesis argued the report into the shape the current one
    // inherits, so it is an author of what is being reviewed.
    ...synthesisAttempts.map((a) => ({ party: 'SYNTHESIS' as SeparationParty, lineage: a })),
  ];
  const reasons: string[] = [];
  const applied: EligibilityVerdict['applied'] = [];
  const conflicts: EligibilityVerdict['conflicts'] = [];

  /*
   * The judge waits.
   *
   * A judge that can start before the arguments are in is not judging between
   * them — it is a third opinion that happens to be labelled. So `JUDGE` is
   * refused until both other roles have a `COMPLETE` pass, which is also what
   * makes their outputs immutable: a completed pass is never rewritten, only
   * superseded by a new attempt, and an attempt cannot start while this one
   * holds the role.
   */
  if (role === 'JUDGE') {
    const done = new Set(
      passes
        .filter((pass) => pass.status === 'COMPLETE')
        .map((pass) => ROLE_BY_ORDINAL_LOCAL[pass.ordinal])
        .filter((r): r is AuditRole => Boolean(r)),
    );
    const waitingFor = (['PRIMARY', 'ADVERSARIAL'] as const).filter((r) => !done.has(r));
    if (waitingFor.length > 0) {
      reasons.push(
        `JUDGE may not begin until ${waitingFor.join(' and ')} ${
          waitingFor.length === 1 ? 'has' : 'have'
        } completed, so that what it judges is settled and immutable.`,
      );
    }
  }

  for (const { party, lineage: recorded } of parties) {
    if (party === role) continue;
    const key = pairKey(role, party);
    if (!key) continue;
    const floor = AUDIT_SEPARATION_MINIMUM[key]!;
    /*
     * The stricter of the two wins, and `requiredTier` is only consulted to
     * *raise* the bar. A mission asking for less than the floor gets the
     * floor, which is why this is a max rather than an assignment.
     */
    const level: IndependenceLevel = requiredTier && stricter(requiredTier, floor) ? requiredTier : floor;
    applied.push({ pair: key, level, against: party });

    const read = dimensionOf(level);
    /*
     * Empty is absent, not distinct.
     *
     * `lineageForWorker` represents a missing credential as `''` rather than
     * null, and its own comment explains why: two sessions that both lacked
     * one would otherwise compare equal. But the opposite error is worse and
     * was live until a test caught it — an empty string compared
     * *unequal* to every real credential, so a caller with no session at all
     * looked perfectly separated from one that had authenticated. Both
     * directions are now the same answer: unknown, and refused.
     */
    const blank = (value: string | null): string | null => (value === '' ? null : value);
    const mine = blank(read(executor));
    const theirs = blank(read(recorded));

    if (mine === null || theirs === null) {
      reasons.push(
        `${role} cannot be compared with ${party}: one of them has no ${noun(level)} ` +
          `recorded, and unrecorded lineage is not evidence of independence.`,
      );
      continue;
    }
    if (mine === theirs) {
      /*
       * No identifier in the sentence.
       *
       * The session dimension *is* the credential the request authenticated
       * with, so printing "shared the same session (cred_…)" would put a
       * credential identifier into a refusal an untrusted caller reads. The
       * reason says which pair and which dimension, which is everything the
       * caller needs to act; the value stays in `conflicts`, which Brain logs
       * and never returns.
       */
      reasons.push(
        `${role} would share the same ${noun(level)} as ${party}, ` +
          `which ${key} requires to differ.`,
      );
      conflicts.push({ pair: key, level, dimension: noun(level), value: mine });
    }
  }

  return {
    eligible: reasons.length === 0,
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    reasons,
    applied,
    conflicts,
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
export function auditMatrixVerdict(
  passes: ResearchPass[],
  /**
   * The mission's own stronger tier, if it declared one. Same rule as at
   * admission: it may only raise, so a packet cannot be stored under a weaker
   * separation than the one it asked to be judged by. Absent means the floor.
   */
  requiredTier?: SeparationTier,
): EligibilityVerdict {
  const { audits, synthesisAttempts } = lineageFromPasses(passes);
  const reasons: string[] = [];
  const applied: EligibilityVerdict['applied'] = [];
  const conflicts: EligibilityVerdict['conflicts'] = [];
  /*
   * Keyed by party, not by role, and the author is in it.
   *
   * The matrix is walked by splitting each key on `_`, so a `SYNTHESIS_*` entry
   * looks up `SYNTHESIS` here. Without a row for it both sides of every author
   * pair would be `undefined` and the loop would `continue` — the three new
   * entries would be in the constant, reported as applied by nothing, and
   * enforced nowhere. That is the same shape as the defect they exist to fix,
   * one file along, which is why it is written down rather than assumed.
   */
  const byParty = new Map<SeparationParty, AuditLineage[]>();
  for (const lineage of audits) byParty.set(lineage.role, [lineage]);
  // Several, because a redo leaves more than one completed synthesis and each
  // of them is an author. A role is singular within a round by construction.
  if (synthesisAttempts.length > 0) byParty.set('SYNTHESIS', synthesisAttempts);

  for (const [key, floor] of Object.entries(SIGNED_AUDIT_MATRIX)) {
    const level: IndependenceLevel =
      requiredTier && stricter(requiredTier, floor!) ? requiredTier : floor!;
    const [left, right] = key.split('_') as [SeparationParty, SeparationParty];
    const lefts = byParty.get(left) ?? [];
    const rights = byParty.get(right) ?? [];
    if (lefts.length === 0 || rights.length === 0) continue;
    applied.push({ pair: key, level, against: right });
    const read = dimensionOf(level);
    for (const a of lefts) {
      for (const b of rights) {
    // The third site that must agree that empty is absent. Three comparisons
    // of the same rule is two too many, and this is the one that guards
    // storage — the one it would be worst to leave behind.
    const blank = (value: string | null): string | null => (value === '' ? null : value);
        const ka = blank(read(a));
        const kb = blank(read(b));
        if (ka === null || kb === null) {
          reasons.push(
            `${left} and ${right} cannot be compared: one recorded no ${noun(level)}.`,
          );
          continue;
        }
        if (ka === kb) {
          reasons.push(`${left} and ${right} shared the same ${noun(level)}.`);
          conflicts.push({ pair: key, level, dimension: noun(level), value: ka });
        }
      }
    }
  }

  return {
    eligible: reasons.length === 0,
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    reasons,
    applied,
    conflicts,
  };
}
