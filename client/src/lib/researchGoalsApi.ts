/**
 * Research goals, over HTTP.
 *
 * Read-only and thin: every sentence, count and state is the server's, and the
 * shape is imported from the server rather than restated, because a client
 * holding its own copy of a contract is a second contract. Type-only, so
 * nothing of the server reaches the bundle. There is deliberately no function
 * here that raises a ceiling: the server's sentence says that is a person's
 * decision, and the way to act on it is a new goal.
 */
import { api } from './api.ts';
import type { GoalBudgetView, StoppingCeiling } from '../../../server/services/research/goalBudgetView.ts';

export type { GoalBudgetView, StoppingCeiling };

export const ResearchGoalsApi = {
  list: (projectId: string): Promise<{ goals: GoalBudgetView[] }> =>
    api(`/api/projects/${encodeURIComponent(projectId)}/research-goals`),
};
