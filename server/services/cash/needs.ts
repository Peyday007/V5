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
import { createNeed, getNeed, listNeeds, settleNeed } from '../../repos/cashPortfolio.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import type { CashNeed } from '../../domain/types.ts';
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
}): Promise<Outcome<CashNeed>> {
  const fields = {
    blockedAction: input.blockedAction.trim(),
    whyItMatters: input.whyItMatters.trim(),
    recommendedPath: input.recommendedPath.trim(),
    setupEffort: input.setupEffort.trim(),
    nextStep: input.nextStep.trim(),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value) continue;
    return refuse(
      `A need has to name the blocked action, why it matters, the recommended way forward, the ` +
        `setup effort and the exact next step. "${name}" is empty, and a need with a blank there ` +
        'is a blocked label rather than something somebody can act on.',
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

  const need = await createNeed({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    ...fields,
    expectedCostCents: input.expectedCostCents ?? null,
  });

  await recordCashEvent({
    projectId: input.projectId,
    opportunityId: input.opportunityId ?? null,
    kind: 'CASH_NEED_RAISED',
    actorRef: input.actorRef,
    summary: `Blocked: ${fields.blockedAction}. Recommended: ${fields.recommendedPath}.`,
    detail: { nextStep: fields.nextStep, expectedCostCents: input.expectedCostCents ?? null },
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
