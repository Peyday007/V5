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
import type { WorkstreamEvent, WorkstreamLink } from '../../../server/domain/register.ts';
import type { GoalCommitment, GoalPrioritySnapshot } from '../../../server/domain/goals.ts';

export type { DecisionResult, GoalBriefing, GoalCommitment, GoalDecision, GoalPrioritySnapshot, GoalView };

/**
 * What a person may say about a goal's terms from this surface. The route also
 * takes `ownerUserId`, but naming an owner is a membership decision this client
 * does not make, so it is deliberately absent and is never sent.
 */
export interface GoalTermsInput {
  outcome?: string | null;
  dueAt?: string | null;
  commitment?: GoalCommitment;
}

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
  terms: (id: string, { outcome, dueAt, commitment }: GoalTermsInput): Promise<DecisionResult> =>
    api(path(id, '/terms'), { method: 'PATCH', body: JSON.stringify({ outcome, dueAt, commitment }) }),
  objective: (id: string, body: { intent?: string; outcome?: string | null }): Promise<DecisionResult> =>
    post(path(id, '/objective'), { intent: body.intent, outcome: body.outcome }),
  /** The route answers with the live link it recorded, not a DecisionResult. */
  dependsOn: (id: string, otherGoalId: string): Promise<{ link: WorkstreamLink; consequence: string }> =>
    post(path(id, '/depends-on'), { goalId: otherGoalId }),
  /** A goal is a workstream, so its id is a workstreamId on the register's supersede route. */
  removeDependency: (goalId: string, linkId: string, reason: string): Promise<{ superseded: boolean; linkId: string }> =>
    post(
      `/api/register/workstreams/${encodeURIComponent(goalId)}/links/${encodeURIComponent(linkId)}/supersede`,
      { reason },
    ),
};
