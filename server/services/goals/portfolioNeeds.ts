/**
 * Sending what a goal's portfolio says it does not know to the owners that act
 * on it, from the goal pass itself (CAUSAL-14-4, CAUSAL-14-7).
 *
 * `evaluateGoalPortfolio` names two kinds of decision-critical gap: the causal
 * graph's `decisionUnknowns` (each marked for research or for an authorized
 * action) and the market history a calibrated probability still lacks. Both
 * were only appended to `GoalPortfolio.missing` as text — the goal pass
 * computed them, labelled where they should go, and sent none of them; only a
 * person POSTing to `routes/causal.ts` ever reached `sendNeeds` or
 * `requestMarketHistory`. This hands them to those same functions on every
 * plan reading, so there is no queue, store or scheduler of its own (§10.3):
 *
 *   - a decision unknown goes through `sendNeeds`, under a graph scope built
 *     from the opening's own id, so its key is the same on every pass and in
 *     every goal that reads the opening (invariant 27);
 *   - a history gap goes through `requestMarketHistory`, keyed per opening and
 *     kind exactly as the route keys it.
 *
 * Asking again on the next pass writes nothing new. An estimated arrangement
 * has no opening row (its research is the constructed round, §82), and an
 * opening of another project is not this goal's to raise anything on, so both
 * are skipped. A refusal from an owner is reported, never dropped.
 */
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { isArrangementId } from '../cash/goalScenario.ts';
import { requestMarketHistory } from '../quant/history.ts';
import { sendNeeds, type Need } from '../quant/needs.ts';
import type { DecisionUnknown, GoalPortfolio } from './portfolio.ts';

export interface PortfolioNeedsReport {
  /** Needs handed to an owner that holds them now, whether newly written or already open there. */
  delivered: number;
  /** Of those, the ones known to be newly written this pass. */
  created: number;
  refused: Array<{ opportunityId: string; subject: string; reason: string }>;
}

export interface PortfolioNeedsDeps {
  getOpportunity?: typeof getOpportunity;
  sendNeeds?: typeof sendNeeds;
  requestMarketHistory?: typeof requestMarketHistory;
}

/** The graph identity a goal-pass need is keyed under: the opening's own, never anything a caller sent. */
export function openingGraphScope(opportunityId: string): string {
  return `opening:${opportunityId}`;
}

/** A decision unknown as the need `sendNeeds` takes. */
export function needOf(one: DecisionUnknown): Need {
  return {
    subject: one.unknown,
    question:
      one.sendTo === 'research'
        ? `Establish from published or recorded sources ${one.unknown}.`
        : `Ask the counterparty, under an authorized action, ${one.unknown}.`,
    route: one.sendTo === 'research' ? 'RESEARCH' : 'AUTHORIZED_ACTION',
    permissions: [],
  };
}

export async function sendPortfolioNeeds(
  input: { projectId: string; portfolio: GoalPortfolio | null; actorRef?: string },
  deps: PortfolioNeedsDeps = {},
): Promise<PortfolioNeedsReport> {
  const read = deps.getOpportunity ?? getOpportunity;
  const send = deps.sendNeeds ?? sendNeeds;
  const request = deps.requestMarketHistory ?? requestMarketHistory;
  const actorRef = input.actorRef ?? 'BRAIN';
  const report: PortfolioNeedsReport = { delivered: 0, created: 0, refused: [] };
  const portfolio = input.portfolio;
  if (!portfolio) return report;

  const opening = new Map<string, boolean>();
  const ours = async (opportunityId: string): Promise<boolean> => {
    if (isArrangementId(opportunityId)) return false;
    const known = opening.get(opportunityId);
    if (known !== undefined) return known;
    const row = await read(opportunityId);
    const mine = !!row && row.projectId === input.projectId;
    opening.set(opportunityId, mine);
    return mine;
  };

  const byOpening = new Map<string, Need[]>();
  for (const one of portfolio.causal?.decisionUnknowns ?? []) {
    const list = byOpening.get(one.opportunityId);
    if (list) list.push(needOf(one));
    else byOpening.set(one.opportunityId, [needOf(one)]);
  }
  for (const [opportunityId, needs] of byOpening) {
    if (!(await ours(opportunityId))) continue;
    const sent = await send({ projectId: input.projectId, actorRef, graphScope: openingGraphScope(opportunityId), needs });
    for (const one of sent) {
      if (!one.sent) {
        report.refused.push({ opportunityId, subject: one.subject, reason: one.reason });
        continue;
      }
      report.delivered += 1;
      if (one.created) report.created += 1;
    }
  }

  for (const history of portfolio.marketHistory ?? []) {
    if (history.gaps.length === 0 || !(await ours(history.opportunityId))) continue;
    const opportunity = await read(history.opportunityId);
    if (!opportunity) continue;
    const { requested, refused } = await request({ projectId: input.projectId, actorRef, opportunity, history });
    // `requestMarketHistory` reads an open need back under its key, so a repeat is delivered, not created.
    report.delivered += requested.length;
    for (const one of refused) report.refused.push({ opportunityId: history.opportunityId, subject: `market history: ${one.kind}`, reason: one.reason });
  }
  return report;
}
