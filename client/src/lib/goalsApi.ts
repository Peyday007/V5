/**
 * Goals, over HTTP.
 *
 * Thin by design, like `registerApi`: every sentence, state and count here is
 * the server's, and the shapes are imported from the server rather than
 * restated, because a client holding its own copy of a contract is a second
 * contract and the copy is the one that drifts. Type-only, so nothing of the
 * server reaches the bundle.
 */
import { api } from './api.ts';
import type { GoalBriefing } from '../../../server/services/goals/briefing.ts';
import type { GoalDecision, GoalView } from '../../../server/services/goals/model.ts';
import type { DecisionResult } from '../../../server/services/goals/decide.ts';
import type { WorkstreamEvent } from '../../../server/domain/register.ts';
import type { GoalPrioritySnapshot } from '../../../server/domain/goals.ts';

export type { DecisionResult, GoalBriefing, GoalDecision, GoalPrioritySnapshot, GoalView };

const path = (id: string, tail = '') => `/api/goals/${encodeURIComponent(id)}${tail}`;
const post = <T>(url: string, body: unknown = {}): Promise<T> =>
  api<T>(url, { method: 'POST', body: JSON.stringify(body) });

export const GoalsApi = {
  briefing: (): Promise<{ briefing: GoalBriefing; goals: GoalView[] }> => api('/api/goals'),
  goal: (id: string): Promise<{ goal: GoalView; events: WorkstreamEvent[]; priorityHistory: GoalPrioritySnapshot[] }> =>
    api(path(id)),
  pause: (id: string, reason: string): Promise<DecisionResult> => post(path(id, '/pause'), { reason }),
  resume: (id: string): Promise<DecisionResult> => post(path(id, '/resume')),
  cancel: (id: string, reason: string): Promise<DecisionResult> => post(path(id, '/cancel'), { reason }),
  reinstate: (id: string): Promise<DecisionResult> => post(path(id, '/reinstate')),
};
