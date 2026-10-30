/** Classify a unit of work and write the decision, with its reasons and alternatives, to the ledger. */
import { recordDecision } from '../../../repos/workRouting.ts';
import type { ClassifyInput, RoutingChoice } from '../types.ts';
import { classifyWork } from './classify.ts';

export { classifyWork };

export async function classifyAndRecord(
  input: ClassifyInput,
): Promise<RoutingChoice & { decisionId: string }> {
  const choice = classifyWork(input);
  const recorded = await recordDecision({
    projectId: input.projectId,
    workKind: input.workKind,
    workRef: input.workRef ?? null,
    resource: choice.resource,
    reasons: choice.reasons,
    alternatives: choice.alternatives,
    general: input.general ?? false,
  });
  return { ...choice, decisionId: recorded.id };
}
