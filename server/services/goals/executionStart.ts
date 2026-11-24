/**
 * The start of a goal's commercial execution window (§119).
 *
 * Execution starts when a grant first authorizes buyer-facing work for the
 * goal's project (`EXECUTION_ACTIONS`: contacting a buyer, quoting or
 * invoicing, accepting a payment). Until then the window is not consumed:
 * planning, engineering and research are preparation. The start is the
 * grant's own `startsAt`, recorded once on the goal (`startGoalExecution`,
 * guarded), with a GOAL_EXECUTION_STARTED event. Two callers keep it true: the
 * grant route, at the moment of the grant, and the goal tick, for a grant
 * written by any other path.
 */
import { liveAuthority } from '../../repos/cashAuthority.ts';
import { startGoalExecution, unstartedExecutionGoals } from '../../repos/goals.ts';
import { recordWorkstreamEvent } from '../../repos/register.ts';
import { anchoredDueAt, startsExecution, EXECUTION_ACTIONS } from '../../domain/executionWindow.ts';

/** Start the window of every unstarted goal on `projectId` (or every project) whose live grant authorizes execution. */
export async function startExecutionWindows(input: { projectId?: string | null; actorRef: string; at?: string }): Promise<string[]> {
  const started: string[] = [];
  for (const goal of await unstartedExecutionGoals(input.projectId ?? null)) {
    if (!goal.target_project_id) continue;
    const grant = await liveAuthority(goal.target_project_id, input.at);
    if (!grant || !startsExecution(grant.allowedActions)) continue;
    const startedAt = grant.startsAt;
    const dueAt = anchoredDueAt(startedAt, goal.execution_window_days);
    if (!(await startGoalExecution(goal.id, startedAt, dueAt))) continue;
    await recordWorkstreamEvent({
      workstreamId: goal.id,
      kind: 'GOAL_EXECUTION_STARTED',
      summary: `Commercial execution was authorized (${grant.allowedActions.filter((a) => (EXECUTION_ACTIONS as readonly string[]).includes(a)).join(', ')}): the ${goal.execution_window_days}-day window runs from ${startedAt.slice(0, 10)} to ${dueAt.slice(0, 10)}.`,
      detail: { authorityId: grant.id, startedAt, dueAt, windowDays: goal.execution_window_days },
      actorRef: input.actorRef,
    });
    started.push(goal.id);
  }
  return started;
}
