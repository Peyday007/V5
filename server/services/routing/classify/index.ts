/** Classify a unit of work and write the decision, with its reasons and alternatives, to the ledger. */
import { recordDecision } from '../../../repos/workRouting.ts';
import type { ClassifyInput, RoutingChoice } from '../types.ts';
import { classifyWork } from './classify.ts';
import { noticeRepeats } from '../repeats/repeats.ts';

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
  // Work a model ran whose shape code could do (a closed answer, or structured
  // input) is counted for conversion. Advisory: noticing never blocks the work.
  if (choice.resource !== 'CODE' && (input.requirements.closedAnswerSet || input.requirements.structuredInput)) {
    try { await noticeRepeats(input.projectId, input.workKind); } catch { /* advisory */ }
  }
  return { ...choice, decisionId: recorded.id };
}
