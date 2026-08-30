/**
 * The permanent tool surface.
 *
 * Three rules shaped every entry below, and they are worth stating before the
 * code because each one is a decision that could have gone the other way.
 *
 * **Every tool is a thin wrapper over a service that already exists.** Not one
 * of them reaches a capability no HTTP route reaches, and not one was invented
 * for MCP. A remote protocol that grows its own back door is a second security
 * model, and the second one is always the weaker.
 *
 * **The list is permanent and identical for every caller.** No dynamic
 * registration, no tool whose presence depends on who is asking. Hiding a tool
 * from a caller who may not use it would turn `tools/list` into a permission
 * oracle and would leave Brain one forgotten filter away from an unauthorized
 * call. Which tools a caller may *succeed* with is decided at execution time,
 * by `policy.ts`, exactly as it is for every HTTP route.
 *
 * **A worker may operate work; it may never administer anything.** Enqueueing,
 * cancelling and resolving an uncertain operation are all ADMIN, `policy.ts`
 * names no worker scope for any of them, and none of them appears here. A
 * leaked worker credential must not be able to create work for the fleet or to
 * decide what an unknown outcome meant.
 */
import type { ClaimedWork, WorkerScope } from '../domain/types.ts';
import {
  WORK_FAILURE_CATEGORIES,
  WORK_ITEM_STATES,
  type WorkFailureCategory,
  type WorkItemState,
} from '../domain/types.ts';
import { visibleProjectIds } from '../services/identity/policy.ts';
import { getProject, listProjects } from '../repos/projects.ts';
import { listLayers } from '../repos/layers.ts';
import { buildPlan, calculateNextAction } from '../services/planner.ts';
import {
  claimWork,
  completeWork,
  failWork,
  getWorkItem,
  heartbeatWork,
  listWorkItems,
  releaseWork,
  type ClaimScope,
} from '../repos/workQueue.ts';
import { getDocument, listDocuments } from '../repos/documents.ts';
import { workType } from '../services/queue/workTypes.ts';
import { readableText, retrieveEvidence } from '../services/documents/retrieval.ts';
import { conflictError, invalidInput, notFoundError } from './errors.ts';
import type { McpTool } from './toolkit.ts';
import { RESEARCH_TOOLS } from './researchTools.ts';
import { RESEARCH_METHOD, RESEARCH_METHOD_VERSION } from '../services/research/method.ts';
import {
  COMPLETE_NAMESPACE,
  FAIL_NAMESPACE,
  MUTATING,
  READ_ONLY,
  RELEASE_NAMESPACE,
  authorize,
  idempotentQueueMutation,
  optionalIdempotencyKey,
  optionalInteger,
  optionalString,
  proofFrom,
  publicItem,
  refuseLease,
  requireOwnedItem,
  requiredString,
  workerOnly,
} from './toolkit.ts';
import {
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_PASSAGES,
  bound,
  pageSize,
} from './limits.ts';

/* ------------------------------------------------------------------------ */
/* The primitives                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Argument reading, authorization, lease proof and idempotency all live in
 * `toolkit.ts`, so this file and `researchTools.ts` cannot come to different
 * answers about any of them. See that file's header for why that matters more
 * than the small indirection costs.
 */
export type { McpTool, ToolContext, ToolOutcome } from './toolkit.ts';

const whoami: McpTool = {
  name: 'brain_whoami',
  title: 'Who am I',
  description:
    'Describe the credential presented on this call: the principal, the projects it may ' +
    'reach and the scopes it holds in each. Call this first — it is the difference between ' +
    'a worker that knows what it may do and one that discovers it by being refused.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Who am I', ...READ_ONLY },
  // No scope required, and none should be: this discloses only what the caller
  // already proved by presenting the credential. It cannot be used to learn
  // about anything the credential does not already reach.
  run: async (_args, { principal }) => ({
    projectId: null,
    value: {
      principalType: principal.type,
      handle: principal.handle,
      displayName: principal.displayName,
      memberships: principal.memberships
        .filter((membership) => membership.active)
        .map((membership) => ({
          projectId: membership.projectId,
          role: membership.role,
          scopes: membership.scopes,
        })),
    },
  }),
};

const listProjectsTool: McpTool = {
  name: 'brain_list_projects',
  title: 'List projects',
  description:
    'The projects this credential can reach. Projects it cannot reach are absent rather ' +
    'than refused — the count itself is information, so you are shown yours and told ' +
    'nothing about the rest.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'List projects', ...READ_ONLY },
  run: async (_args, { principal }) => {
    const all = await listProjects();
    const visible = new Set(visibleProjectIds(principal, all.map((project) => project.id)));
    // Filtered, not refused. A worker with one project of five is shown one.
    const mine = all.filter((project) => visible.has(project.id));
    return {
      projectId: null,
      value: {
        projects: mine.map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
        })),
      },
    };
  },
};

const getProjectTool: McpTool = {
  name: 'brain_get_project',
  title: 'Get a project',
  description: 'A project and its layers, with each layer’s current status.',
  inputSchema: {
    type: 'object',
    properties: { project_id: { type: 'string', description: 'The project id.' } },
    required: ['project_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Get a project', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'READ', 'project:read');
    const project = await getProject(projectId);
    // Authorized but absent. Same refusal as unauthorized, so the two cannot be
    // told apart by a caller probing for which ids exist.
    if (!project) throw notFoundError();
    const layers = await listLayers(projectId);
    return {
      projectId,
      value: {
        project: { id: project.id, name: project.name, slug: project.slug },
        layers: layers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          status: layer.status,
          currentVersion: layer.currentVersion,
        })),
      },
    };
  },
};

const getPlanTool: McpTool = {
  name: 'brain_get_plan',
  title: 'Get the plan',
  description:
    'The Master Planner for a project: what is ready now, what is next, what is later and ' +
    'what is blocked, with the single next best action.',
  inputSchema: {
    type: 'object',
    properties: { project_id: { type: 'string', description: 'The project id.' } },
    required: ['project_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Get the plan', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'READ', 'project:read');
    const plan = await buildPlan(projectId);
    const brief = (items: typeof plan.now): Record<string, unknown>[] =>
      items.map((item) => ({
        layerId: item.layerId,
        layerName: item.layerName,
        status: item.status,
        title: item.title,
        actionType: item.actionType,
        targetVersion: item.targetVersion,
        missing: item.missing,
      }));
    return {
      projectId,
      value: {
        wave: plan.wave,
        now: brief(plan.now),
        next: brief(plan.next),
        later: brief(plan.later),
        blocked: brief(plan.blocked),
        nextBestAction: plan.nextBestActionText,
        generatedAt: plan.generatedAt,
      },
    };
  },
};

const nextActionTool: McpTool = {
  name: 'brain_next_action',
  title: 'Next best action',
  description: 'The single next best action for a project, or nothing if there is none.',
  inputSchema: {
    type: 'object',
    properties: { project_id: { type: 'string', description: 'The project id.' } },
    required: ['project_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Next best action', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'READ', 'project:read');
    const action = await calculateNextAction(projectId);
    return {
      projectId,
      value: {
        action: action
          ? {
              layerId: action.layerId,
              layerName: action.layerName,
              title: action.title,
              detail: action.detail,
              actionType: action.actionType,
              targetVersion: action.targetVersion,
              missing: action.missing,
            }
          : null,
      },
    };
  },
};

const listWorkTool: McpTool = {
  name: 'brain_list_work',
  title: 'List queued work',
  description: 'Work items in a project, newest-priority first. Reading only — this claims nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'The project id.' },
      states: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional state filter, e.g. ["QUEUED","LEASED"].',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size.' },
    },
    required: ['project_id'],
    additionalProperties: false,
  },
  annotations: { title: 'List queued work', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'READ', 'queue:read');
    const limit = pageSize(args['limit']);
    const rawStates = args['states'];
    if (rawStates !== undefined && !Array.isArray(rawStates)) {
      throw invalidInput('states must be an array of strings when present.');
    }
    // Matched exactly against the enum, and an unknown one is refused rather
    // than dropped. Silently ignoring `state: "RUNNING"` would answer a
    // different question than the one asked and look like an empty queue.
    const states: WorkItemState[] = [];
    for (const state of (rawStates ?? []) as unknown[]) {
      if (typeof state !== 'string' || !(WORK_ITEM_STATES as readonly string[]).includes(state)) {
        throw invalidInput('states must contain only known work item states.');
      }
      states.push(state as WorkItemState);
    }
    const items = await listWorkItems(projectId, { states, limit });
    const bounded = bound(items, limit);
    return {
      projectId,
      value: {
        items: bounded.items.map(publicItem),
        truncated: bounded.truncated,
        omitted: bounded.omitted,
      },
    };
  },
};

const getWorkItemTool: McpTool = {
  name: 'brain_get_work_item',
  title: 'Get a work item',
  description: 'One work item, by id.',
  inputSchema: {
    type: 'object',
    properties: { work_item_id: { type: 'string', description: 'The work item id.' } },
    required: ['work_item_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Get a work item', ...READ_ONLY },
  run: async (args, { principal }) => {
    const workItemId = requiredString(args, 'work_item_id');
    const item = await getWorkItem(workItemId);
    if (!item) throw notFoundError();
    // The project comes from the row. An argument naming a project would let a
    // caller pair an id it guessed with a project it holds.
    await authorize(principal, item.projectId, 'READ', 'queue:read');
    return { projectId: item.projectId, value: { item: publicItem(item) } };
  },
};

/**
 * What the work type means, handed over with the work.
 *
 * The registry's own header assumes "a worker that receives an item looks up
 * what that type means in its own code". That is right for a worker somebody
 * wrote; it is not right for the workers this Brain actually has, which read
 * the name `RESEARCH_PLAN` and have to infer the rest.
 *
 * So the registered description travels with the claim. It is not a prompt and
 * cannot become one: it is the type's own definition, authored here, from a
 * closed registry a caller cannot add to. The alternative is a capable model
 * guessing which tool a type calls for and finding out by being refused, which
 * costs an allowance to learn something the Brain already knew.
 */
function describeClaimed(item: ClaimedWork): Record<string, unknown> {
  let description: string | null = null;
  try {
    description = workType(item.workType).description;
  } catch {
    // A type that is no longer registered. The item still gets handed over —
    // refusing it here would strand work nobody can look at — and the worker is
    // told there is nothing to say about it rather than being told nothing.
    description = null;
  }
  return { ...item, workTypeDescription: description };
}

const claimWorkTool: McpTool = {
  name: 'brain_claim_work',
  title: 'Claim queued work',
  description:
    'Take up to `limit` items atomically and receive a lease for each. An empty list is a ' +
    'normal answer — an idle queue is not an error. Keep the lease_id and lease_generation ' +
    'from each claim: every later call about that item must present both.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Optional. Narrow to one project you already hold a claim scope on.',
      },
      work_types: { type: 'array', items: { type: 'string' }, description: 'Optional filter.' },
      orchestration_id: {
        type: 'string',
        description:
          'Optional. Take only work belonging to this research packet, so a session started to ' +
          'drain one packet cannot pick up unrelated work.',
      },
      bundle_key: {
        type: 'string',
        description:
          'Optional. Take only the fragments an assignment named as safely researched together.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many to take.' },
      lease_ms: { type: 'integer', minimum: 0, description: 'Requested lease length; the server clamps it.' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Claim queued work', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);

    // Eligibility is rebuilt from live memberships on every call. That is what
    // makes revocation take effect on the next call rather than at some later
    // re-handshake — a membership removed a second ago is simply not here.
    const scopes: ClaimScope[] = principal.memberships
      .filter((membership) => membership.active)
      .filter((membership) => (membership.scopes as WorkerScope[]).includes('queue:claim'))
      .map((membership) => ({
        projectId: membership.projectId,
        scopes: membership.scopes as WorkerScope[],
      }));

    // Holding the claim scope nowhere is an authorization answer, not an idle
    // queue, and the two must not look the same — otherwise a revoked worker
    // polls forever against a queue that appears permanently empty, and whoever
    // debugs it reads "no work" instead of "no longer permitted".
    if (scopes.length === 0) throw notFoundError();

    const requested = optionalString(args, 'project_id');
    const eligible = requested ? scopes.filter((scope) => scope.projectId === requested) : scopes;
    // Narrowing to a project this worker has no claim on is refused exactly as
    // holding no scope is, so the answer cannot be used to discover which
    // projects exist.
    if (requested && eligible.length === 0) throw notFoundError();

    const rawTypes = args['work_types'];
    if (rawTypes !== undefined && !Array.isArray(rawTypes)) {
      throw invalidInput('work_types must be an array of strings when present.');
    }

    const claimed = await claimWork({
      workerId,
      credentialId: principal.credentialId,
      scopes: eligible,
      workTypes: rawTypes as string[] | undefined,
      // Filters over rows the server holds, not a widening of reach: naming a
      // packet does not grant access to it. Authorization is still membership
      // and scopes, checked per item.
      orchestrationId: optionalString(args, 'orchestration_id'),
      bundleKey: optionalString(args, 'bundle_key'),
      limit: optionalInteger(args, 'limit') ?? 1,
      leaseMs: optionalInteger(args, 'lease_ms') ?? undefined,
      requestId,
    });

    return {
      // One claim may span projects, so the audit row records the project only
      // when the answer is unambiguous.
      projectId: claimed.length === 1 ? (claimed[0]?.projectId ?? null) : null,
      value: { claimed: claimed.map(describeClaimed) },
    };
  },
};

const heartbeatTool: McpTool = {
  name: 'brain_heartbeat_work',
  title: 'Heartbeat a lease',
  description:
    'Extend the lease on an item you hold. Do this well before lease_expires_at: an expired ' +
    'lease is claimable work, and another worker may take it.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      lease_ms: { type: 'integer', minimum: 0, description: 'Requested extension; the server clamps it.' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Heartbeat a lease', ...MUTATING },
  run: async (args, { principal }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), 'queue:heartbeat');
    if (!item) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);
    // Not wrapped in Step 6. A heartbeat has no effect to duplicate: it is a
    // guarded UPDATE that moves an expiry forward, and performing it twice is
    // indistinguishable from performing it once. Reserving an operation record
    // per heartbeat would write more rows than the work itself.
    const result = await heartbeatWork(proof, {
      leaseMs: optionalInteger(args, 'lease_ms') ?? undefined,
    });
    if (!result.ok) refuseLease(result);
    return {
      projectId: item.projectId,
      value: {
        workItemId: result.item.id,
        leaseGeneration: result.item.leaseGeneration,
        leaseExpiresAt: result.item.leaseExpiresAt,
      },
    };
  },
};

/**
 * Advance the packet a completed item belonged to, without letting that fail
 * the completion.
 *
 * Ordering matters here and the choice is deliberate. The completion is the
 * fact — the worker did the work, and the queue must record it. Deciding what
 * work should exist next is a consequence, and a consequence that throws must
 * not un-record the fact that caused it. So this runs after the effect has
 * committed, and a failure is logged rather than propagated.
 *
 * Nothing is lost when it does fail: `advancePacket` derives everything from
 * rows, so the next completion, the next approval or the next boot sweep
 * reaches the same conclusion. That is the whole reason it reads only
 * persisted state.
 */
async function advanceAfter(item: { orchestrationId: string | null }): Promise<void> {
  if (!item.orchestrationId) return;
  try {
    const { advancePacket } = await import('../services/research/packetRunner.ts');
    await advancePacket(item.orchestrationId);
  } catch (error) {
    console.error('[brain] could not advance the packet after a completion:', error);
  }
}

const completeTool: McpTool = {
  name: 'brain_complete_work',
  title: 'Complete a work item',
  description:
    'Record that an item succeeded. Idempotent by work item: if your lease expired after the ' +
    'work was done and the item was redelivered, calling this again replays the record ' +
    'rather than performing a second effect.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      result_ref: { type: 'string', description: 'An identifier for what was produced.' },
      summary: { type: 'string', description: 'A short human-readable summary.' },
      idempotency_key: {
        type: 'string',
        description: 'Optional. One is derived from the work item when you do not send one.',
      },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Complete a work item', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), 'queue:complete');
    if (!item) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);
    const resultRef = optionalString(args, 'result_ref');
    const summary = optionalString(args, 'summary');

    /**
     * Research work is done when it has recorded something, not when a worker
     * says so.
     *
     * An item whose entire purpose is to record a verification, completed
     * without a verification, is a contradiction — and the boundary is where
     * contradictions get refused rather than stored. Left accepted it poisons
     * the packet from above: the runner sees a finished item that moved
     * nothing, correctly stops for a person, and the only documented remedy is
     * re-planning, which discards the accepted research already inside it.
     *
     * This is not hypothetical. The first real packet died on exactly this: a
     * worker's budget ran out mid-verification and it completed the lease
     * instead of releasing it, stranding one gated fragment, one ungated one
     * and ten queued behind them.
     *
     * The remedy is in the message, because the worker can act on it: submit,
     * or release the lease so somebody else can. Releasing is the correct move
     * when you are out of budget, and it costs the packet nothing.
     */
    const { researchItemRecorded } = await import('../services/research/packetRunner.ts');
    if (!(await researchItemRecorded(item))) {
      throw conflictError(
        `This is a ${item.workType} item and nothing has been recorded against it, so completing ` +
          'it would end the work without doing it. Submit what you found first, or call ' +
          'brain_release_work to hand the item back — releasing is the right move when you are ' +
          'out of budget, and it leaves the packet able to continue.',
      );
    }

    const outcome = await idempotentQueueMutation(
      {
        namespace: COMPLETE_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        // The work item and which operation it is. Not the summary: a result is
        // an output, and putting an output into an identity makes a reclaimed
        // item's new owner look like a conflicting request. Step 6 found that
        // the hard way.
        payload: { workItemId: item.id, operation: 'complete' },
      },
      async () => await completeWork(proof, { resultRef, summary }),
    );

    await advanceAfter(item);

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const failTool: McpTool = {
  name: 'brain_fail_work',
  title: 'Fail a work item',
  description:
    'Record that an item failed, with a category. A retryable failure returns the item to the ' +
    'queue with backoff until it runs out of attempts. Idempotent by work item.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      category: {
        type: 'string',
        enum: [...WORK_FAILURE_CATEGORIES],
        description: 'Why it failed.',
      },
      detail: { type: 'string', description: 'A short detail. Never a stack trace.' },
      retryable: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation', 'category'],
    additionalProperties: false,
  },
  annotations: { title: 'Fail a work item', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), 'queue:complete');
    if (!item) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);

    const category = requiredString(args, 'category');
    // Matched exactly against the enum. No closest-match, no substring, no
    // inferred category — the same rule the audit engine applies to a model's
    // verdict, for the same reason.
    if (!(WORK_FAILURE_CATEGORIES as readonly string[]).includes(category)) {
      throw invalidInput('That is not a failure category.');
    }
    const retryable = args['retryable'];
    if (retryable !== undefined && typeof retryable !== 'boolean') {
      throw invalidInput('retryable must be a boolean when present.');
    }

    const outcome = await idempotentQueueMutation(
      {
        namespace: FAIL_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        // The category is an input — it is what the caller asked to record —
        // so unlike a summary it belongs in the identity.
        payload: { workItemId: item.id, operation: 'fail', category },
      },
      async () =>
        await failWork(proof, {
          category: category as WorkFailureCategory,
          detail: optionalString(args, 'detail'),
          retryable: retryable as boolean | undefined,
        }),
    );

    await advanceAfter(item);

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const releaseTool: McpTool = {
  name: 'brain_release_work',
  title: 'Release a work item',
  description:
    'Give an item back without failing it — you are shutting down, out of allowance, or it is ' +
    'not yours to do. It returns to the queue immediately and hands back the attempt, so ' +
    'releasing never uses the item up. Checkpoint first: what you established travels to ' +
    'whoever picks it up. Idempotent by work item.',
  inputSchema: {
    type: 'object',
    properties: {
      work_item_id: { type: 'string' },
      lease_id: { type: 'string' },
      lease_generation: { type: 'integer' },
      detail: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['work_item_id', 'lease_id', 'lease_generation'],
    additionalProperties: false,
  },
  annotations: { title: 'Release a work item', ...MUTATING },
  run: async (args, { principal, requestId }) => {
    const workerId = workerOnly(principal);
    const item = await requireOwnedItem(principal, requiredString(args, 'work_item_id'), 'queue:complete');
    if (!item) throw notFoundError();
    const proof = proofFrom(args, item.id, workerId);
    const detail = optionalString(args, 'detail');

    const outcome = await idempotentQueueMutation(
      {
        namespace: RELEASE_NAMESPACE,
        principal,
        projectId: item.projectId,
        proof,
        suppliedKey: optionalIdempotencyKey(args),
        requestId,
        payload: { workItemId: item.id, operation: 'release' },
      },
      async () => await releaseWork(proof, detail),
    );

    // A release changes what work is available, so the packet is re-derived —
    // the same as a completion and a failure. It was the one of the three that
    // did not, which is how a released verification left its packet reading
    // RESEARCHING with a dead item inside it and no recovery offered.
    await advanceAfter(item);

    return {
      projectId: item.projectId,
      value: outcome.value,
      replayed: outcome.replayed,
      operationId: outcome.operationId,
    };
  },
};

const documentTextTool: McpTool = {
  name: 'brain_get_document_text',
  title: 'Read a document',
  description:
    'The extracted text of a registered document, in pages, offset-paged. A document that ' +
    'could not be read is reported as unreadable — never as an empty document, because those ' +
    'are different facts and only Brain can tell them apart.',
  inputSchema: {
    type: 'object',
    properties: {
      document_id: { type: 'string' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset to resume from.' },
    },
    required: ['document_id'],
    additionalProperties: false,
  },
  annotations: { title: 'Read a document', ...READ_ONLY },
  run: async (args, { principal }) => {
    const documentId = requiredString(args, 'document_id');
    const document = await getDocument(documentId);
    if (!document) throw notFoundError();
    await authorize(principal, document.projectId, 'READ', 'documents:read');

    const { run, pages } = await readableText(documentId);

    // Only a run that reached READY or READY_WITH_WARNINGS is evidence.
    // Reporting a BLOCKED or INTERRUPTED document as an empty one would be the
    // false confidence the extraction gate exists to prevent.
    if (!run || (run.status !== 'READY' && run.status !== 'READY_WITH_WARNINGS')) {
      return {
        projectId: document.projectId,
        value: {
          documentId,
          readable: false,
          reason: run ? run.status : 'NEVER_EXTRACTED',
          text: null,
        },
      };
    }

    const whole = pages
      .map((page) => `[page ${page.pageNumber}]\n${page.blocks.map((block) => block.text).join('\n')}`)
      .join('\n\n');

    const offset = Math.max(0, optionalInteger(args, 'offset') ?? 0);
    const slice = whole.slice(offset, offset + MAX_DOCUMENT_TEXT_CHARS);
    const nextOffset = offset + slice.length;

    return {
      projectId: document.projectId,
      value: {
        documentId,
        readable: true,
        extractionStatus: run.status,
        offset,
        text: slice,
        // Truncation is always reported. A caller that received half a document
        // and believes it received all of it draws conclusions from an absence
        // that is not there.
        truncated: nextOffset < whole.length,
        nextOffset: nextOffset < whole.length ? nextOffset : null,
        totalChars: whole.length,
      },
    };
  },
};

const searchEvidenceTool: McpTool = {
  name: 'brain_search_evidence',
  title: 'Search evidence',
  description:
    'Find passages bearing on a question across a project’s readable documents. Returns the ' +
    'passages, the documents searched, and the documents that could not be read — an empty ' +
    'result over an unread document means "not read", not "not present".',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      query: { type: 'string', description: 'The question, in words.' },
      document_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Defaults to every document in the project.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['project_id', 'query'],
    additionalProperties: false,
  },
  annotations: { title: 'Search evidence', ...READ_ONLY },
  run: async (args, { principal }) => {
    const projectId = requiredString(args, 'project_id');
    await authorize(principal, projectId, 'READ', 'documents:read');
    const query = requiredString(args, 'query');

    const requested = args['document_ids'];
    if (requested !== undefined && !Array.isArray(requested)) {
      throw invalidInput('document_ids must be an array of strings when present.');
    }

    const inProject = await listDocuments(projectId);
    const allowed = new Set(inProject.map((document) => document.id));
    // A document id from another project is dropped rather than refused: the
    // refusal would confirm that the id exists somewhere, which is the same
    // oracle `authorize` closes.
    const documentIds = requested
      ? (requested as string[]).filter((id) => allowed.has(id))
      : [...allowed];

    const limit = Math.min(MAX_PASSAGES, optionalInteger(args, 'limit') ?? 5);
    const result = await retrieveEvidence({ documentIds, query, limit });

    return {
      projectId,
      value: {
        passages: result.passages.map((passage) => ({
          documentId: passage.documentId,
          documentLabel: passage.documentLabel,
          pageStart: passage.pageStart,
          pageEnd: passage.pageEnd,
          headingPath: passage.headingPath,
          quote: passage.quote,
          fromOcr: passage.fromOcr,
        })),
        searched: result.searched,
        // Never collapsed into the empty case. This is the whole point.
        unreadable: result.unreadable,
      },
    };
  },
};

/* ------------------------------------------------------------------------ */
/* The registry                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Declared in a fixed order, and served in it.
 *
 * The revision asks servers to return tools deterministically so clients can
 * cache and so prompt caches hit. An array literal is the simplest thing that
 * guarantees it — a `Map` built from an object would depend on insertion order
 * nobody is checking.
 */

/**
 * The standing research method, in full.
 *
 * `SERVER_INSTRUCTIONS` carries the summary into every client's context
 * automatically; this is the rest of it, for a worker about to research and
 * wanting the whole contract rather than the précis.
 *
 * No scope required, and none should be. It discloses nothing about any
 * project, credential or packet — it is the same text for every caller, and a
 * worker that cannot read how it is expected to work is a worker set up to fail
 * the gate for reasons nobody told it about.
 *
 * Versioned so a run can record which revision produced it, and served from the
 * same constant `docs/workers/WORKER-CONTRACT.md` is checked against.
 */
const researchMethodTool: McpTool = {
  name: 'brain_research_method',
  title: 'How Brain expects research to be done',
  description:
    'The standing research method: search breadth, reading full sources, source classification, ' +
    'recovering from blocked sources and reporting the ones you could not read, stating ' +
    'uncertainty, carrying conditions forward, and checking your own findings adversarially. ' +
    'Method only — it never says what to conclude.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Research method', ...READ_ONLY },
  run: async () => ({
    projectId: null,
    value: { version: RESEARCH_METHOD_VERSION, method: RESEARCH_METHOD },
  }),
};

export const TOOLS: readonly McpTool[] = [
  whoami,
  listProjectsTool,
  getProjectTool,
  getPlanTool,
  nextActionTool,
  listWorkTool,
  getWorkItemTool,
  claimWorkTool,
  heartbeatTool,
  completeTool,
  failTool,
  releaseTool,
  documentTextTool,
  searchEvidenceTool,
  researchMethodTool,
  // Step 9. In a second file because there are eight of them and this one was
  // already long, and in the *same* array because there is one surface. A
  // second registry would be a second place to forget something.
  ...RESEARCH_TOOLS,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): McpTool | null {
  return BY_NAME.get(name) ?? null;
}

/** The `tools/list` payload. Identical for every caller, by design. */
export function describeTools(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}
