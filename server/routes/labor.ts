/**
 * The labor kernel's door.
 *
 * Every route resolves through `requireProject`, which is `decideProjectAccess`
 * against the authenticated principal, so absent and forbidden are the same 404
 * **with the same body** — invariant 23, where the thing being hidden is who
 * does somebody else's work.
 *
 * Every handler additionally calls `requirePerson`. A worker is already refused
 * at the writes by level and by `MISSING_SCOPE`; this refuses it by *type*, at
 * the reads as well, because no membership configuration turns a machine into a
 * person and "who should be employed here" is the last place to find that out.
 * Two independent guards, because a guard on one entrance is not a guard.
 *
 * There is **no labor policy module and there must never be one.** Which level
 * each of these needs is declared in `services/identity/policy.ts` beside every
 * other route, for §21's reason: a second security model is a second thing to
 * keep correct, and it is always the weaker one that decides.
 *
 * The handlers are thin on purpose. Every decision below is made in
 * `services/labor/`; these resolve the project, hand over the principal, and
 * turn a refusal into a status.
 */
import { Router } from 'express';
import {
  badRequest,
  bodyOf,
  handler,
  notFound,
  optionalString,
  pathId,
  requirePerson,
  requireProject,
  requiredString,
  unprocessable,
} from './helpers.ts';
import { getOpportunity } from '../repos/cashPortfolio.ts';
import { getTask } from '../repos/labor.ts';
import { declareTask, declareWorkflow, retire } from '../services/labor/declare.ts';
import { assignByPerson } from '../services/labor/assign.ts';
import { laborView } from '../services/labor/view.ts';
import { isHumanNecessityReason, isProductionLayer, layerIsHuman } from '../domain/labor.ts';
import { HUMAN_NECESSITY_REASONS, PRODUCTION_LAYERS } from '../domain/types.ts';

export const laborRouter = Router();

/* --------------------------------------------------------------------------
 * Reading it
 *
 * Any project member's, and deliberately so. Who does the work here, why they
 * are still necessary, what Brain is close to absorbing and what is holding it
 * are exactly the things a person working on this project needs to be able to
 * see without asking an administrator.
 * ------------------------------------------------------------------------ */

laborRouter.get(
  '/projects/:projectId/labor',
  handler(async (req) => {
    requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    return laborView(project.id);
  }),
);

/* --------------------------------------------------------------------------
 * Naming a workflow or a task
 *
 * ADMIN plus `requirePerson`, the pair every membership-shaped decision
 * already carries — and for a related reason. `SEED` is the one origin Brain
 * itself may never write, because §2 of the brief is a design act rather than
 * a derivation: deciding what a business does is not something rows answer.
 *
 * Declaring spends nothing and starts nothing. It creates a row; the kernel
 * decides when it is asked about, the standing authority decides whether that
 * may run, and the evidence gate decides what may be claimed.
 * ------------------------------------------------------------------------ */

laborRouter.post(
  '/projects/:projectId/labor/workflows',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const opportunityId = optionalString(body['opportunityId'], 'opportunityId') ?? null;
    if (opportunityId) {
      const opportunity = await getOpportunity(opportunityId);
      if (!opportunity || opportunity.projectId !== project.id) {
        // The same 404 an opening that never existed gives, because an id in
        // somebody else's operation must not be distinguishable from an
        // invented one — invariant 23, at a foreign key.
        throw notFound('No opening with that id.');
      }
    }

    const result = await declareWorkflow({
      projectId: project.id,
      name: requiredString(body['name'], 'name'),
      description: optionalString(body['description'], 'description') ?? null,
      opportunityId,
      actorRef: principal.id,
    });

    return {
      workflow: result.workflow,
      created: result.created,
      message: result.created
        ? `${result.workflow.name} is on the labor map. Nothing has been spent and no research ` +
          'has started; Brain decides when to ask who should produce each of its tasks.'
        : `${result.workflow.name} was already on the map, so nothing changed.`,
    };
  }),
);

laborRouter.post(
  '/projects/:projectId/labor/workflows/:workflowId/tasks',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const result = await declareTask({
      projectId: project.id,
      workflowId: pathId(req, 'workflowId'),
      name: requiredString(body['name'], 'name'),
      // Question 1 of the necessity test. Required here rather than defaulted,
      // because every other question is about this output and a task without
      // one cannot be assessed at all.
      output: requiredString(body['output'], 'output'),
      capabilityId: optionalString(body['capabilityId'], 'capabilityId') ?? null,
      actorRef: principal.id,
    });
    if (!result) throw notFound('No workflow with that id.');

    return {
      task: result.task,
      created: result.created,
      message: result.created
        ? `${result.task.name} is a task in this workflow. Nobody has decided who produces it ` +
          'yet, and Brain will not decide that on an absence.'
        : `${result.task.name} was already a task in this workflow, so nothing changed.`,
    };
  }),
);

/* --------------------------------------------------------------------------
 * Recording who produces a task
 *
 * A person may record any layer, including one Brain would refuse to record
 * for itself — somebody is entitled to say *we are doing it this way for now*
 * and have that be true. The one thing refused is a human layer with no
 * reason, which is the schema's own CHECK: the six classes exist so that every
 * human role can say which one it is, and a role that cannot name one is the
 * habit this kernel exists to stop inheriting.
 * ------------------------------------------------------------------------ */

laborRouter.post(
  '/projects/:projectId/labor/tasks/:taskId/allocation',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const body = bodyOf(req);

    const task = await getTask(pathId(req, 'taskId'));
    if (!task || task.projectId !== project.id) throw notFound('No task with that id.');

    const layerRaw = requiredString(body['productionLayer'], 'productionLayer');
    if (!isProductionLayer(layerRaw)) {
      // A value outside the closed set refuses the whole thing rather than
      // being coerced — `proposal.ts`' rule, at the column that decides who
      // does the work. It is a *value* rather than a field: no route in this
      // repository refuses an unknown body key, and §24's field rule is about
      // a model's proposal, where an invented field means the thing that
      // produced it cannot be trusted about the rest either.
      throw badRequest(
        `"${layerRaw}" is not a kind of producer this map holds. The set is fixed in code: ` +
          `${PRODUCTION_LAYERS.join(', ')}.`,
      );
    }

    const reasonRaw = optionalString(body['necessityReason'], 'necessityReason') ?? null;
    if (reasonRaw !== null && !isHumanNecessityReason(reasonRaw)) {
      throw badRequest(
        `"${reasonRaw}" is not one of the six reasons a human role is recorded under: ` +
          `${HUMAN_NECESSITY_REASONS.join(', ')}. There is deliberately no reason meaning ` +
          '"this is how it has always been done".',
      );
    }

    const outcome = await assignByPerson({
      projectId: project.id,
      task,
      productionLayer: layerRaw,
      necessityReason: reasonRaw,
      rationale: requiredString(body['rationale'], 'rationale'),
      actorRef: principal.id,
    });
    if (!outcome.ok) throw unprocessable(outcome.reason);

    return {
      allocation: outcome.allocation,
      changed: outcome.changed,
      message: outcome.changed
        ? `${task.name} is produced by ${outcome.allocation.productionLayer}. The previous ` +
          'decision keeps its row, which is what lets Brain say later that a role was ' +
          'compressed.'
        : `${task.name} was already recorded that way, so nothing was written — a second ` +
          'identical row would only make the history harder to read.',
      // Said on every write, because it is the one thing a caller might
      // reasonably think this route does and it does not.
      note: layerIsHuman(outcome.allocation.productionLayer)
        ? 'Recording that a person produces this engages nobody. Brain contacts, quotes for ' +
          'and hires exactly as many people as it did before, which is none.'
        : undefined,
    };
  }),
);

/* --------------------------------------------------------------------------
 * Retiring one
 *
 * Never a delete. The allocation history and every necessity answer stay
 * exactly where they are, which is what stops the same workflow arriving again
 * as a fresh derivation with all of that gone.
 * ------------------------------------------------------------------------ */

laborRouter.patch(
  '/projects/:projectId/labor/workflows/:workflowId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const result = await retire({
      projectId: project.id,
      what: 'WORKFLOW',
      id: pathId(req, 'workflowId'),
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
      actorRef: principal.id,
    });
    if (!result) throw notFound('No workflow with that id.');
    return retirementMessage(result);
  }),
);

laborRouter.patch(
  '/projects/:projectId/labor/tasks/:taskId',
  handler(async (req) => {
    const principal = requirePerson();
    const project = await requireProject(pathId(req, 'projectId'));
    const result = await retire({
      projectId: project.id,
      what: 'TASK',
      id: pathId(req, 'taskId'),
      reason: requiredString(bodyOf(req)['reason'], 'reason'),
      actorRef: principal.id,
    });
    if (!result) throw notFound('No task with that id.');
    return retirementMessage(result);
  }),
);

function retirementMessage(result: { retired: boolean; name: string }) {
  return {
    retired: result.retired,
    message: result.retired
      ? `${result.name} is no longer how the work is done. Nothing was destroyed: every ` +
        'allocation decision and every necessity answer is exactly where it was, which is ' +
        'what stops it arriving again as a fresh derivation.'
      : `${result.name} was already retired, and the reason first recorded stands.`,
  };
}
