/**
 * A person naming a workflow, naming a task, or retiring one.
 *
 * ---------------------------------------------------------------------------
 * The one origin Brain may never write
 * ---------------------------------------------------------------------------
 *
 * `SEED` is a decision, and §2 of the brief is explicit about what kind: *if
 * this business were invented today with Brain available from its first day,
 * how would it operate?* That is a design act. A Brain that could name its own
 * workflows would be deciding what the business is, which is §22's rule at the
 * table that decides who does the work and §38's at the table that decides
 * where Brain looks.
 *
 * ---------------------------------------------------------------------------
 * Declaring spends nothing and starts nothing
 * ---------------------------------------------------------------------------
 *
 * It creates rows. The kernel decides when a task is asked about, the standing
 * authority decides whether that may run, the approval envelope decides what
 * may be planned, and the evidence gate decides what may be claimed. A
 * workflow declared on a project with no authority sits there until somebody
 * grants one, and reading it costs nothing either.
 */
import {
  createTask,
  createWorkflow,
  getTask,
  getWorkflow,
  retireTask,
  retireWorkflow,
} from '../../repos/labor.ts';
import { recordEvent } from '../../repos/events.ts';
import type { LaborTask, LaborWorkflow } from '../../domain/types.ts';

const DECLARED = 'LABOR_DECLARED';
const RETIRED = 'LABOR_RETIRED';

export async function declareWorkflow(input: {
  projectId: string;
  name: string;
  description: string | null;
  opportunityId: string | null;
  actorRef: string;
}): Promise<{ workflow: LaborWorkflow; created: boolean }> {
  const result = await createWorkflow({
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    origin: 'SEED',
    opportunityId: input.opportunityId,
    declaredByRef: input.actorRef,
  });
  if (result.created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'labor_workflow',
      entityId: result.workflow.id,
      eventType: DECLARED,
      payload: {
        name: result.workflow.name,
        origin: 'SEED',
        opportunityId: input.opportunityId,
        declaredByRef: input.actorRef,
      },
    });
  }
  return result;
}

export async function declareTask(input: {
  projectId: string;
  workflowId: string;
  name: string;
  output: string;
  capabilityId: string | null;
  actorRef: string;
}): Promise<{ task: LaborTask; created: boolean } | null> {
  const workflow = await getWorkflow(input.workflowId);
  // The same 404 a workflow that never existed gives, because a workflow id in
  // somebody else's operation must not be distinguishable from an invented
  // one — invariant 23, at a foreign key.
  if (!workflow || workflow.projectId !== input.projectId) return null;

  const result = await createTask({
    projectId: input.projectId,
    workflowId: workflow.id,
    name: input.name,
    output: input.output,
    origin: 'SEED',
    capabilityId: input.capabilityId,
    declaredByRef: input.actorRef,
  });
  if (result.created) {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'labor_task',
      entityId: result.task.id,
      eventType: DECLARED,
      payload: {
        name: result.task.name,
        workflowId: workflow.id,
        origin: 'SEED',
        capabilityId: input.capabilityId,
        declaredByRef: input.actorRef,
      },
    });
  }
  return result;
}

/**
 * A person deciding this is no longer how the work is done.
 *
 * Never a delete. A retired workflow keeps its tasks, its allocation history
 * and every necessity answer ever recorded, which is what stops the same one
 * arriving again as a fresh derivation on the next tick — with all of that
 * gone. `retireNode` makes the identical argument one kernel along.
 */
export async function retire(input: {
  projectId: string;
  what: 'WORKFLOW' | 'TASK';
  id: string;
  reason: string;
  actorRef: string;
}): Promise<{ retired: boolean; name: string } | null> {
  if (input.what === 'WORKFLOW') {
    const workflow = await getWorkflow(input.id);
    if (!workflow || workflow.projectId !== input.projectId) return null;
    const retired = await retireWorkflow(workflow.id, input.reason);
    if (retired) await record(input, workflow.name);
    return { retired, name: workflow.name };
  }
  const task = await getTask(input.id);
  if (!task || task.projectId !== input.projectId) return null;
  const retired = await retireTask(task.id, input.reason);
  if (retired) await record(input, task.name);
  return { retired, name: task.name };
}

async function record(
  input: { projectId: string; what: 'WORKFLOW' | 'TASK'; id: string; reason: string; actorRef: string },
  name: string,
): Promise<void> {
  await recordEvent({
    projectId: input.projectId,
    entityType: input.what === 'WORKFLOW' ? 'labor_workflow' : 'labor_task',
    entityId: input.id,
    eventType: RETIRED,
    payload: { name, reason: input.reason, retiredByRef: input.actorRef },
  });
}
