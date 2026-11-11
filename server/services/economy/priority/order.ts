/**
 * Which research gets premium capacity first.
 *
 * Not a mechanism of its own. Research is ordered by the goal ranking that
 * dispatch already uses — `rankGoals` in `services/goals/priority.ts`, whose
 * rank `goals/tick.ts` maps to bin priority — so this module only re-exports
 * that owner under the names the economy surface reads. A second ordering here
 * could disagree with the one the dispatcher actually applies.
 */
export { orderResearch } from '../../goals/priority.ts';
export type {
  PriorityFacts as GoalSetting,
  ResearchDemand,
  OrderedResearch as OrderedDemand,
} from '../../goals/priority.ts';
export type { PriorityCriterion as OrderCriterion } from '../../../domain/goals.ts';
