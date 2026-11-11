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
  /**
   * What counts as finished, when it is due and who it is owed to. The owner is
   * deliberately not sent from here: who owns a goal is a separate decision with
   * its own membership check, and this call must never clear it by omission.
   */
  terms: (
    id: string,
    terms: { outcome?: string | null; dueAt?: string | null; commitment?: GoalCommitment },
  ): Promise<DecisionResult> =>
    api(path(id, '/terms'), {
      method: 'PATCH',
      body: JSON.stringify({ outcome: terms.outcome, dueAt: terms.dueAt, commitment: terms.commitment }),
    }),
  objective: (id: string, input: { intent?: string; outcome?: string | null }): Promise<DecisionResult> =>
    post(path(id, '/objective'), input),
  /** Declare that this goal cannot finish before `otherGoalId` does; the server refuses a cycle. */
  dependsOn: (id: string, otherGoalId: string): Promise<{ link: WorkstreamLink; consequence: string }> =>
    post(path(id, '/depends-on'), { goalId: otherGoalId }),
  /**
   * Undo a dependency. A goal is a workstream and a dependency is one of its
   * live links, so this is the register's correction, mirroring
   * `RegisterApi.supersede`: the link keeps its row and gains the reason.
   */
  removeDependency: (goalId: string, linkId: string, reason: string): Promise<{ superseded: boolean; linkId: string }> =>
    post(
      `/api/register/workstreams/${encodeURIComponent(goalId)}/links/${encodeURIComponent(linkId)}/supersede`,
      { reason },
    ),
};
