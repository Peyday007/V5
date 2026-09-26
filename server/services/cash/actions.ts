/**
 * A commercial action, after execution has already begun.
 *
 * `beginExecution`'s own `firstAction` branch records exactly one action and
 * moves the piece `READY -> EXECUTING`; that is the whole of its shape, and it
 * does not run twice. Everything a person actually does after that — sending
 * the quote, issuing the invoice, accepting the payment — is a further action
 * on a piece already `EXECUTING` or `DELIVERING`, and nothing moves its state.
 *
 * So this is `firstAction`'s decision with the transition removed: refuse a
 * piece that has not started or has already finished, refuse an action outside
 * the closed vocabulary, ask the same standing grant `beginExecution` asks, and
 * record it once. `recordAction`'s own idempotency (`ON CONFLICT DO NOTHING`
 * on `(project_id, request_key)`) is what makes a retry after a lost response
 * the same outcome rather than a second row.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { recordAction } from '../../repos/cashActions.ts';
import { recordCashEvent } from '../../repos/cashMode.ts';
import { COMMERCIAL_ACTIONS, checkCommercialAuthority, isCommercialAction } from './authority.ts';
import { refuse, type Outcome } from './opportunities.ts';
import type { CashActionPerformer, CashOpportunity } from '../../domain/types.ts';

/**
 * Record one further commercial action on an opportunity already in flight.
 *
 * Deliberately calls no transition function: `EXECUTING` and `DELIVERING` are
 * where this applies and neither one changes because of it. State does not
 * move here — only history does.
 */
export async function recordFurtherAction(input: {
  opportunityId: string;
  actorRef: string;
  action: string;
  performedBy: CashActionPerformer;
  detail: string;
  reference?: string | null;
  /** Server-built. See `actionKey`: nothing the caller sent contributes. */
  requestKey: string;
}): Promise<Outcome<CashOpportunity>> {
  const opportunity = await getOpportunity(input.opportunityId);
  if (!opportunity) return refuse('No opportunity with that id.');

  if (opportunity.state !== 'EXECUTING' && opportunity.state !== 'DELIVERING') {
    return refuse(
      `This is ${opportunity.state.toLowerCase()}. A further commercial action can only be ` +
        'recorded once execution has begun and before the money has been collected.',
    );
  }

  /*
   * The action recorded is the action authorized, and it is a closed set.
   * `beginExecution`'s own reasoning, unchanged: checking one action and
   * storing whatever the caller called it would leave the record saying one
   * thing and the grant having permitted another.
   */
  if (!isCommercialAction(input.action)) {
    return refuse(
      `"${input.action}" is not an action this Brain knows how to authorize. A commercial action ` +
        `is one of: ${COMMERCIAL_ACTIONS.join(', ')}.`,
    );
  }

  const decision = await checkCommercialAuthority({
    projectId: opportunity.projectId,
    action: input.action,
  });
  if (!decision.ok || !decision.authority) {
    return refuse(
      `Recording this means acting on this opening, and ${decision.reason}. That is a decision for ` +
        'the person whose account this is; nothing else is blocked by it.',
    );
  }

  const performed = await recordAction({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    authorityId: decision.authority.id,
    action: input.action,
    performedBy: input.performedBy,
    reference: input.reference ?? null,
    detail: input.detail,
    confirmedBy: input.actorRef,
    requestKey: input.requestKey,
  });
  if (performed.created) {
    await recordCashEvent({
      projectId: opportunity.projectId,
      opportunityId: opportunity.id,
      kind: 'CASH_ACTION_RECORDED',
      actorRef: input.actorRef,
      summary: `${input.action} was performed by ${input.performedBy.toLowerCase()}.`,
      detail: {
        actionId: performed.action.id,
        reference: performed.action.reference,
        authorityId: decision.authority.id,
      },
    });
  }

  return {
    ok: true,
    value: opportunity,
    message: performed.created ? 'Recorded.' : 'Already recorded.',
  };
}
