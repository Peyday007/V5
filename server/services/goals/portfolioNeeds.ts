/**
 * The goal tick sends what its portfolio could not establish (CAUSAL-14-4,
 * CAUSAL-14-7; review F2-2).
 *
 * `evaluateGoalPortfolio` names two kinds of decision-critical gap: the
 * causal graph's `decisionUnknowns` (each labelled research or an authorized
 * action) and the best combination's missing market history. Before, both
 * were only appended as text to `GoalPortfolio.missing`, and only a person
 * POSTing to `routes/causal.ts` ever handed one to an owner — so the
 * autonomous goal tick computed where each unknown should go and sent none.
 *
 * This is the tick's hand-off, through the owners that already exist and
 * nothing else (§10.3):
 *
 *   - every decision unknown goes through `sendNeeds` (services/quant/needs.ts),
 *     whose key is built from the graph's identity — here the goal and the
 *     opening, never anything a caller sent (invariant 27) — and the unknown's
 *     own wording, so the next tick reads the open row back;
 *   - every history gap of an opening in the best combination goes through
 *     `requestMarketHistory`, keyed per opening and kind as it already is.
 *
 * Idempotent by those keys: a goal read every thirty minutes raises each need
 * once. An owner's refusal is counted and returned, never dropped and never
 * counted as sent.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { sendNeeds, type Need } from '../quant/needs.ts';
import { requestMarketHistory } from '../quant/history.ts';
import type { DecisionUnknown, GoalPortfolio } from './portfolio.ts';

/**
 * Asking a counterparty is contacting the buyer: the commercial authority an
 * action-routed unknown needs, so one grant is found across every need it blocks.
 */
export const COUNTERPARTY_PERMISSION = 'CONTACT_BUYER';

export interface PortfolioNeedsDeps {
  sendNeeds?: typeof sendNeeds;
  requestMarketHistory?: typeof requestMarketHistory;
  getOpportunity?: typeof getOpportunity;
}

export interface PortfolioNeedsSent {
  /** Needs an owner now holds (new or read back). */
  sent: number;
  /** Of those, the ones this call wrote. */
  created: number;
  /** History gaps handed to research. */
  historyRequested: number;
  /** Refusals from an owner, with their reasons. */
  refused: string[];
}

/** The graph a decision unknown belongs to: the goal's view of one opening. */
export function goalGraphScope(goalId: string, opportunityId: string): string {
  return `goal:${goalId}:opening:${opportunityId}`;
}

/** A decision unknown in the shape the needs owner takes. */
export function needOf(one: DecisionUnknown): Need {
  return one.sendTo === 'research'
    ? { subject: one.unknown, question: `What is ${one.unknown}?`, route: 'RESEARCH', permissions: [] }
    : { subject: one.unknown, question: `Ask the counterparty ${one.unknown}`, route: 'AUTHORIZED_ACTION', permissions: [COUNTERPARTY_PERMISSION] };
}

/**
 * Hand a goal portfolio's decision unknowns and the best combination's
 * missing market history to their owners.
 */
export async function sendPortfolioNeeds(
  input: { goalId: string; projectId: string; portfolio: GoalPortfolio | null; actorRef?: string },
  deps: PortfolioNeedsDeps = {},
): Promise<PortfolioNeedsSent> {
  const send = deps.sendNeeds ?? sendNeeds;
  const request = deps.requestMarketHistory ?? requestMarketHistory;
  const read = deps.getOpportunity ?? getOpportunity;
  const actorRef = input.actorRef ?? 'BRAIN';
  const out: PortfolioNeedsSent = { sent: 0, created: 0, historyRequested: 0, refused: [] };
  const portfolio = input.portfolio;
  if (!portfolio) return out;

  const byOpening = new Map<string, DecisionUnknown[]>();
  for (const one of portfolio.causal?.decisionUnknowns ?? []) {
    const list = byOpening.get(one.opportunityId) ?? [];
    list.push(one);
    byOpening.set(one.opportunityId, list);
  }
  for (const [opportunityId, unknowns] of byOpening) {
    const delivered = await send({
      projectId: input.projectId,
      actorRef,
      graphScope: goalGraphScope(input.goalId, opportunityId),
      needs: unknowns.map(needOf),
    });
    for (const one of delivered) {
      if (one.sent) {
        out.sent += 1;
        if (one.created) out.created += 1;
      } else out.refused.push(`${one.subject}: ${one.reason}`);
    }
  }

  // The history the best combination lacks is what assurance.researchNeeds names.
  const best = new Set(portfolio.best?.members.map((one) => one.opportunityId) ?? []);
  for (const history of portfolio.marketHistory ?? []) {
    if (!best.has(history.opportunityId) || history.gaps.length === 0) continue;
    const opportunity = await read(history.opportunityId);
    // An estimate of a constructed arrangement has no opening row yet; its research is the construction's.
    if (!opportunity || opportunity.projectId !== input.projectId) continue;
    const result = await request({ projectId: input.projectId, actorRef, opportunity, history });
    out.historyRequested += result.requested.length;
    out.sent += result.requested.length;
    for (const one of result.refused) out.refused.push(`market history ${one.kind} for ${opportunity.id}: ${one.reason}`);
  }
  return out;
}
