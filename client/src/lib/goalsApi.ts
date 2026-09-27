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

  /**
   * What counts as finished, when it is due, and whether it is owed to
   * somebody. Never carries an owner: naming who a goal belongs to is a
   * membership question the server answers from its own rows, and this
   * method has nothing to say about it.
   */
  terms: (
    id: string,
    terms: { outcome?: string | null; dueAt?: string | null; commitment?: GoalCommitment },
  ): Promise<DecisionResult> =>
    api(path(id, '/terms'), { method: 'PATCH', body: JSON.stringify(terms) }),

  /** Restating what the goal is for, without touching its lifecycle. */
  objective: (id: string, objective: { intent?: string; outcome?: string | null }): Promise<DecisionResult> =>
    post(path(id, '/objective'), objective),

  /** This goal cannot finish before `otherGoalId` does. Refused if it would close a cycle. */
  dependsOn: (id: string, otherGoalId: string): Promise<{ link: WorkstreamLink; consequence: string }> =>
    post(path(id, '/depends-on'), { goalId: otherGoalId }),

  /**
   * Undo a dependency. A goal is a workstream, so its own id is a valid
   * workstream id on the register's correction route (§43) — there is no
   * separate "remove dependency" route to duplicate it.
   */
  removeDependency: (goalId: string, linkId: string, reason: string): Promise<{ superseded: boolean; linkId: string }> =>
    api(`/api/register/workstreams/${encodeURIComponent(goalId)}/links/${encodeURIComponent(linkId)}/supersede`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
