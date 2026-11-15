/**
 * A priority family's window, as a recorded decision (RES-15-4, S-0148).
 *
 * `INTERMEDIATION_FAMILY` declares the family and the window it was first
 * given. That window used to be the whole story: `renewFamily` built a new
 * object nothing persisted, so the priority lapsed on a date written in the
 * source and the only way to keep it was to edit the code and redeploy.
 *
 * A renewal is now a row. `recordFamilyRenewal` appends one
 * `CASH_FAMILY_PRIORITY_RENEWED` cash event — who decided, the new review
 * date, why — and `familyDeclarationFor` applies the project's newest one over
 * the declaration, so every reader of the window (discovery order, the dive
 * pass, the commission pass) sees the same recorded decision. Nothing is
 * mutated and nothing is deleted: the declaration in code is the first grant,
 * and the events are the history of every renewal after it. A renewal with an
 * earlier date ends the priority sooner, which is how a person retires it
 * without a redeploy; the family itself is never made a forever-only market,
 * because every window still ends.
 *
 * The writer reuses `cash_events` (the same append-only store the emergency
 * stop uses) rather than adding a table or a scheduler (§10.3, §20.4).
 */
import { cashEventsOfKindInProject, cashNow, getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { getUser } from '../../repos/identity.ts';
import { INTERMEDIATION_FAMILY, renewFamily, type FamilyDeclaration } from './intermediationPositions.ts';

export const FAMILY_RENEWED_KIND = 'CASH_FAMILY_PRIORITY_RENEWED';

export type RenewalRefusal =
  | 'INVALID_REVIEW_DATE'
  | 'NOT_AFTER_SINCE'
  | 'REASON_REQUIRED'
  | 'NOT_AUTHORIZED';

export type RenewalResult =
  | { status: 'RECORDED'; declaration: FamilyDeclaration; eventId: string }
  | { status: 'REFUSED'; refusal: RenewalRefusal; message: string };

/** The newest recorded renewal of `declaration.key` in a project, applied over the declaration. */
export async function familyDeclarationFor(
  projectId: string,
  declaration: FamilyDeclaration = INTERMEDIATION_FAMILY,
): Promise<FamilyDeclaration> {
  const renewals = await cashEventsOfKindInProject(projectId, FAMILY_RENEWED_KIND);
  for (let i = renewals.length - 1; i >= 0; i -= 1) {
    const detail = renewals[i]!.detail;
    if (detail.familyKey !== declaration.key) continue;
    const reviewBy = typeof detail.reviewBy === 'string' ? detail.reviewBy : null;
    if (reviewBy && Number.isFinite(Date.parse(reviewBy))) return renewFamily(declaration, reviewBy);
  }
  return declaration;
}

/**
 * Record a person's decision to renew (or shorten) a family's priority window.
 *
 * Only an enabled Brain administrator or the owner of the project's Cash Mode
 * may decide it, and a reason is required: the renewal is an audit record, not
 * a toggle. The new review date must be a real date after the window began.
 */
export async function recordFamilyRenewal(input: {
  projectId: string;
  actorUserId: string;
  reviewBy: string;
  reason: string;
  declaration?: FamilyDeclaration;
}): Promise<RenewalResult> {
  const declaration = input.declaration ?? INTERMEDIATION_FAMILY;
  const reason = input.reason.trim();
  if (!reason) return { status: 'REFUSED', refusal: 'REASON_REQUIRED', message: 'A renewal needs a reason, so the record says why.' };
  const reviewAt = Date.parse(input.reviewBy);
  if (!Number.isFinite(reviewAt)) {
    return { status: 'REFUSED', refusal: 'INVALID_REVIEW_DATE', message: `${input.reviewBy} is not a date.` };
  }
  if (reviewAt <= Date.parse(declaration.since)) {
    return {
      status: 'REFUSED',
      refusal: 'NOT_AFTER_SINCE',
      message: `The review date must fall after the window began on ${declaration.since}.`,
    };
  }
  const user = await getUser(input.actorUserId);
  const mode = await getCashMode(input.projectId);
  const allowed = !!user && !user.disabledAt && (user.isBrainAdmin || (mode !== null && mode.ownerUserId === user.id));
  if (!allowed) {
    return {
      status: 'REFUSED',
      refusal: 'NOT_AUTHORIZED',
      message: 'Only an enabled Brain administrator or the owner of this project’s Cash Mode may renew a family’s priority.',
    };
  }
  const previous = await familyDeclarationFor(input.projectId, declaration);
  const reviewBy = new Date(reviewAt).toISOString();
  const event = await recordCashEvent({
    projectId: input.projectId,
    kind: FAMILY_RENEWED_KIND,
    actorRef: user!.id,
    summary: `${declaration.key} priority reviewed by ${reviewBy}: ${reason}`,
    detail: { familyKey: declaration.key, reviewBy, previousReviewBy: previous.reviewBy, since: declaration.since, reason, decidedAt: cashNow() },
  });
  return { status: 'RECORDED', declaration: renewFamily(declaration, reviewBy), eventId: event.id };
}
