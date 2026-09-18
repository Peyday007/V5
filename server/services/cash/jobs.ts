/**
 * Who may see a job, and who may hold one.
 *
 * ---------------------------------------------------------------------------
 * Where the boundary is, and why it moved
 * ---------------------------------------------------------------------------
 *
 * Cash Mode's privacy used to be the project: four projects, four sprints, four
 * frontiers. That put the boundary before the Brain knew what an opportunity
 * was, what it required, or who was best placed to execute it — so it divided
 * *discovery*, which is the one thing that should never be divided. Evidence
 * about the world is not anybody's private state.
 *
 * The boundary is here instead. An opportunity and everything supporting it are
 * readable by every member of the root; a **job** over that opportunity carries
 * the owner, the budget, the credentials and the working state, and those are
 * restricted. So the same opportunity can be looked at by four people and
 * executed by one, without four copies of the research existing.
 *
 * ---------------------------------------------------------------------------
 * What this module refuses to do
 * ---------------------------------------------------------------------------
 *
 * It does not decide project access. `decideProjectAccess` still answers
 * whether a person may reach the root at all, and this runs *after* that,
 * narrowing — never widening. A person who cannot read the project cannot reach
 * a job in it whatever its visibility says, because they never get this far.
 *
 * It grants nothing. A job's budget is a ceiling *inside* the commercial grant
 * on the root, so a job can only ever be narrower than what a person already
 * authorized. There is no path here to authorize spending that the grant does
 * not already permit.
 */
import type { CashJob } from '../../domain/types.ts';

/**
 * May this person read this job's private working state?
 *
 * Deny-by-default, in the order that makes each answer cheap: the explicit
 * shared flag, then the owner, then the participant list. A Brain administrator
 * is deliberately **not** special-cased here — §26's rule that an administrator
 * is not entitled to somebody's private thread is the same rule, and a job
 * holds money decisions rather than a conversation.
 */
export function mayReadJob(
  job: CashJob,
  userId: string | null,
  /*
   * Passed in rather than read here, so this stays a pure function over rows
   * the caller already has — the property that makes `router.ts` answerable
   * after the fact, and the reason a decision like this is testable without a
   * database. The caller does one query for the job it is about to render.
   */
  participants: readonly string[],
): boolean {
  if (job.visibility === 'SHARED') return true;
  if (!userId) return false;
  if (job.ownerUserId === userId) return true;
  return participants.includes(userId);
}

/**
 * The job as somebody else is allowed to see it.
 *
 * A job that is not yours is not hidden — hiding it would make the portfolio
 * lie about what is being worked on, and "is anybody on this?" is exactly what
 * a shared frontier needs to answer. What is withheld is the private half: the
 * budget, the note and who holds it.
 *
 * That is a deliberate difference from invariant 23. The 404 rule is for a
 * resource whose *existence* is information; a live job on a shared opportunity
 * is not, because the opportunity it points at is already shared. Pretending
 * one does not exist would produce two people starting the same work.
 */
export interface RedactedJob {
  id: string;
  opportunityId: string;
  state: CashJob['state'];
  /** True when the reader may see the rest of it. */
  mine: boolean;
  /** Present only for a reader who may. */
  ownerUserId?: string | null;
  budgetCents?: number | null;
  currency?: string;
  note?: string | null;
  assignedAt?: string | null;
}

export function redactJob(
  job: CashJob,
  userId: string | null,
  participants: readonly string[],
): RedactedJob {
  const allowed = mayReadJob(job, userId, participants);
  if (!allowed) {
    return { id: job.id, opportunityId: job.opportunityId, state: job.state, mine: false };
  }
  return {
    id: job.id,
    opportunityId: job.opportunityId,
    state: job.state,
    mine: true,
    ownerUserId: job.ownerUserId,
    budgetCents: job.budgetCents,
    currency: job.currency,
    note: job.note,
    assignedAt: job.assignedAt,
  };
}

/**
 * What a job may commit, given the grant on the root.
 *
 * The narrower of the two, always. A job with no ceiling of its own is bounded
 * by the grant — which is why a job created before anybody set a budget is
 * still safe — and a job whose own ceiling is larger than the grant is bounded
 * by the grant, because a job cannot widen what a person authorized.
 */
export function jobCeilingCents(job: CashJob, grantCeilingCents: number | null): number | null {
  if (job.budgetCents === null) return grantCeilingCents;
  if (grantCeilingCents === null) return job.budgetCents;
  return Math.min(job.budgetCents, grantCeilingCents);
}
