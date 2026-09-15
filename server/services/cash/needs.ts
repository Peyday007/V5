/**
 * A missing capability, with somewhere to go.
 *
 * The plan is exact about this and it is the whole of the module: an explicit
 * missing need is a valid execution state, and it must carry a **recommended
 * way forward** rather than a generic blocked label. So a need with no
 * recommendation and no next step is refused at creation rather than stored and
 * shown to somebody as "blocked".
 *
 * §24's sentence, at a new altitude: a state that says "waiting for a person"
 * which that person cannot resolve is not waiting, it is stuck. A need is the
 * answering transition's *description*, and one without it is the defect this
 * codebase has now recorded six times.
 *
 * **A need never stops unrelated work.** Nothing reads this table to decide
 * whether an opportunity may proceed. Brain continues independent work while a
 * need is open, which is what the plan means by "an explicit missing need is a
 * valid execution state".
 */
import {
  claimNeedContinuation,
  createNeed,
  getNeed,
  getOpportunity,
  listNeeds,
  needForKey,
  needsAwaitingContinuation,
  recordNeedContinuation,
  settleNeed,
} from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { readCapability } from './capabilities.ts';
import type { CashNeed, CashOpportunityState } from '../../domain/types.ts';
import type { Outcome } from './opportunities.ts';

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export async function raiseNeed(input: {
  projectId: string;
  opportunityId?: string | null;
  actorRef: string;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  expectedCostCents?: number | null;
  setupEffort: string;
  nextStep: string;
  /**
   * What settles it, in a form somebody can check.
   *
   * Required, for the reason `recommendedPath` and `nextStep` already are: a
   * need whose answer nobody can verify is a status rather than a remedy, and
   * `runContinuations` below reads exactly this to decide whether an answer
   * actually happened.
   */
  completionCondition: string;
  /** The opportunity transition waiting on it, when one is. */
  blocksState?: CashOpportunityState | null;
  /** The idea Brain started because of it, when it could start one. */
  candidateId?: string | null;
  /**
   * What makes this need the same need.
   *
   * With one, raising it twice returns the row that already exists rather than
   * filling the review with one entry per tick. Without one, every call is a
   * new need — which is right for something a person typed and wrong for
   * anything a loop derives.
   */
  requestKey?: string | null;
}): Promise<Outcome<CashNeed>> {
  const fields = {
    blockedAction: input.blockedAction.trim(),
    whyItMatters: input.whyItMatters.trim(),
    recommendedPath: input.recommendedPath.trim(),
    setupEffort: input.setupEffort.trim(),
    nextStep: input.nextStep.trim(),
    completionCondition: input.completionCondition.trim(),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value) continue;
    return refuse(
      `A need has to name the blocked action, why it matters, the recommended way forward, the ` +
        `setup effort, the exact next step and what would settle it. "${name}" is empty, and a ` +
        'need with a blank there is a blocked label rather than something somebody can act on.',
    );
  }
  if (
    input.expectedCostCents !== undefined &&
    input.expectedCostCents !== null &&
    (!Number.isFinite(input.expectedCostCents) ||
      Math.trunc(input.expectedCostCents) !== input.expectedCostCents ||
      input.expectedCostCents < 0)
  ) {
    return refuse('An expected cost is a whole number of cents, or null for "not known".');
  }

  if (input.opportunityId) {
    const opportunity = await getOpportunity(input.opportunityId);
    if (!opportunity || opportunity.projectId !== input.projectId) {
      return refuse('No opportunity with that id.');
    }
  }

  const key = input.requestKey?.trim() || null;
  if (key) {
    const existing = await needForKey(input.projectId, key);
    if (existing) {
      // The same condition, read back rather than raised again. A loop that
      // derives a need every tick must add one entry to the review, not one
      // per tick — and the caller wants the row either way, because it is what
      // the continuation is waiting on.
      return {
        ok: true,
        value: existing,
        message: 'This need was already raised. Nothing was added.',
      };
    }
  }

  const need = await createNeed({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    ...fields,
    expectedCostCents: input.expectedCostCents ?? null,
    blocksState: input.blocksState ?? null,
    candidateId: input.candidateId ?? null,
    requestKey: key,
  });

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    kind: 'CASH_NEED_RAISED',
    actorRef: input.actorRef,
    summary: `Blocked: ${fields.blockedAction}. Recommended: ${fields.recommendedPath}.`,
    detail: {
      nextStep: fields.nextStep,
      completionCondition: fields.completionCondition,
      blocksState: input.blocksState ?? null,
      expectedCostCents: input.expectedCostCents ?? null,
    },
  });

  return {
    ok: true,
    value: need,
    message:
      'Recorded, with a recommended way forward. Independent work carries on while this is open.',
  };
}

export async function closeNeed(input: {
  needId: string;
  to: 'RESOLVED' | 'WITHDRAWN';
  resolution: string;
  actorUserId: string;
}): Promise<Outcome<CashNeed>> {
  const need = await getNeed(input.needId);
  if (!need) return refuse('No need with that id.');
  const resolution = input.resolution.trim();
  if (!resolution) {
    return refuse('Say what was done, or why it is no longer needed. Both are worth keeping.');
  }
  const settled = await settleNeed({
    id: input.needId,
    to: input.to,
    resolution,
    actorUserId: input.actorUserId,
  });
  if (!settled) return refuse(`This need is already ${need.state.toLowerCase()}.`);

  await recordCashEvent({
    projectId: need.projectId,
    opportunityId: need.opportunityId,
    kind: `CASH_NEED_${input.to}`,
    actorRef: input.actorUserId,
    summary: resolution,
    detail: { needId: need.id, blockedAction: need.blockedAction },
  });
  const after = await getNeed(input.needId);
  return { ok: true, value: after!, message: 'Recorded.' };
}

export async function openNeeds(projectId: string): Promise<CashNeed[]> {
  return listNeeds({ projectId, states: ['OPEN'] });
}
