/**
 * The plan's challenge and Brain's existing model challenger are one path
 * (CHAL-33 repair F3).
 *
 * Brain already has an independent-model challenger: `operator/decisions.ts`
 * `challengeDecision`, which asks a second model to attack a decision cold and
 * name its hidden assumptions and a stronger alternative; `domain/planReady.ts`
 * reads its answer on an adoption as `hermes.challenge`. This module adds no
 * second challenger. It:
 *
 *   * routes the plan's own consequence tier to decide when that heavier
 *     challenge is required (`ChallengeSummary.modelChallenge`, deep only — a
 *     small reversible action is never sent to a second model);
 *   * when it is required, asks the existing challenger, through
 *     `challengeDecision` itself, with the plan stated as an `ADOPT_PLAN`
 *     decision; and
 *   * feeds the answer back into `challengePlan` as an `INDEPENDENT_MODEL`
 *     check, so a deep step is validated by a different model over different
 *     data, and a REVISE holds it with the assumption and the alternative the
 *     challenger named.
 */
import { reviewDecision, type DecisionInput } from '../../domain/decision.ts';
import type { OperatorModel } from '../../domain/operator.ts';
import { challengeDecision } from '../operator/decisions.ts';
import { challengePlan, type ChallengeSummary, type ModelChallenge, type PlanChallengeOptions } from './challenge.ts';
import type { PortfolioProblem, PortfolioResult } from './portfolio.ts';

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/**
 * The plan as the decision the existing challenger reads: execute the plan as
 * it stands (option 0, the adoption brief's convention), commit only the steps
 * the review has cleared, or commit nothing. Values are the plan's own
 * figures; nothing favourable is assumed for a figure it does not carry.
 */
export function planDecision(problem: PortfolioProblem, result: PortfolioResult, summary: ChallengeSummary, goalId: string | null = null): DecisionInput {
  const best = result.best;
  const reach = best?.reach ?? 0;
  const low = summary.kinds.CALIBRATED_PROBABILITY?.range?.low ?? null;
  const held = summary.steps.filter((s) => !s.mayProceed).map((s) => s.key);
  const evidence = [
    `scenario coverage ${pct(reach)} of ${summary.kinds.CALCULATED_SCENARIO.worlds ?? 'unstated'} worlds (a calculation, not a probability)`,
    low === null ? 'no calibrated probability' : `calibrated lower bound ${pct(low)}`,
    `review tier ${summary.scrutiny.tier}: ${summary.scrutiny.because.join('; ')}`,
    ...summary.exposures.map((e) => `shared ${e.kind.toLowerCase()} "${e.id}" across ${e.members.join(', ')}: reach ${pct(e.reachAsPlanned)} → ${pct(e.reachIfItFails)} if it fails`),
  ];
  return {
    kind: 'ADOPT_PLAN',
    goalId,
    question: `Commit the plan ${best?.keys.join(' + ') ?? '(none)'} towards ${problem.target} within ${problem.deadlineDays} days?`,
    options: [
      { action: `execute the plan as it stands: ${best?.keys.join(' + ') ?? 'none'}`, probability: low ?? 0, valueUsd: problem.target, costUsd: summary.action.potentialLoss, evidence: evidence.slice(0, 10) },
      { action: `commit only the steps already cleared (${summary.proceedNow.join(', ') || 'none'}) and hold ${held.join(', ') || 'nothing'}`, probability: low ?? 0, valueUsd: null, costUsd: null, evidence: summary.improvements.slice(0, 10) },
      { action: 'commit nothing yet', probability: 1, valueUsd: 0, costUsd: 0, evidence: [] },
    ],
    chosen: 0,
    assumptions: summary.findings.filter((f) => f.severity !== 'MINOR').map((f) => `${f.subject}: ${f.assumption}`).slice(0, 10).concat(summary.findings.length ? [] : ['the plan\'s samples represent the worlds it will meet']),
    whyNotHighestEv: 'the challenge is asked before commitment; the choice is the plan under review',
    prediction: { outcome: `${problem.target} collected`, probability: low ?? 0, horizonDays: Math.min(365, Math.max(1, Math.ceil(problem.deadlineDays))) },
    irreversible: summary.action.irreversible,
  };
}

export interface ModelChallengedPlan {
  summary: ChallengeSummary;
  /** Whether the existing challenger was asked: only when the tier required it. */
  asked: boolean;
  challenge: ModelChallenge | null;
}

/**
 * Challenge a plan, and when — and only when — its consequence requires the
 * heavier independent-model challenge, ask Brain's existing challenger and
 * re-read the plan with its verdict as an independent check. A challenger
 * that does not answer leaves the routing `due`; it is never read as a pass.
 */
export async function challengePlanWithModel(
  problem: PortfolioProblem,
  result: PortfolioResult,
  models: OperatorModel[],
  options: PlanChallengeOptions & { goalId?: string | null; fetchImpl?: typeof fetch; bounds?: Parameters<typeof challengeDecision>[4] } = {},
  challenger: typeof challengeDecision = challengeDecision,
): Promise<ModelChallengedPlan> {
  const { goalId, fetchImpl, bounds, ...planOptions } = options;
  const first = challengePlan(problem, result, planOptions);
  if (!first.modelChallenge.due) return { summary: first, asked: false, challenge: null };
  const input = planDecision(problem, result, first, goalId ?? null);
  const answer = await challenger(input, reviewDecision(input), models, fetchImpl ?? fetch, bounds ?? {});
  if (!answer) return { summary: first, asked: true, challenge: null };
  return { summary: challengePlan(problem, result, { ...planOptions, modelChallenge: answer }), asked: true, challenge: answer };
}
