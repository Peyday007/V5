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
import type { Principal, WorkerScope } from '../domain/types.ts';
import {
  WORK_FAILURE_CATEGORIES,
  WORK_ITEM_STATES,
  type WorkFailureCategory,
  type WorkItemState,
} from '../domain/types.ts';
import { decideProjectAccess, visibleProjectIds, type AccessLevel } from '../services/identity/policy.ts';
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
  type OwnershipProof,
  type LeaseResult,
} from '../repos/workQueue.ts';
import { getDocument, listDocuments } from '../repos/documents.ts';
import { readableText, retrieveEvidence } from '../services/documents/retrieval.ts';
import {
  EffectFenceLost,
  OperationConflict,
  OperationInProgress,
  runIdempotent,
  TerminalEffectFailure,
  type OperationNamespace,
} from '../services/effects/engine.ts';
import { logicalEffectKey, assertValidKey, InvalidIdempotencyKey } from '../services/effects/fingerprint.ts';
import { ToolError, conflictError, invalidInput, notFoundError, notPermitted } from './errors.ts';
import {
  MAX_DOCUMENT_TEXT_CHARS,
  MAX_PASSAGES,
  bound,
  pageSize,
} from './limits.ts';

/* ------------------------------------------------------------------------ */
/* The shape of a tool                                                       */
/* ------------------------------------------------------------------------ */

export interface ToolContext {
  principal: Principal;
  requestId: string;
}

export interface ToolOutcome {
  /** The structured result. Bounded by the executor before it leaves. */
  value: Record<string, unknown>;
  /** Which project this call touched, for the audit row. Null when Brain-wide. */
  projectId: string | null;
  /** Set when the effect was replayed rather than performed. */
  replayed?: boolean;
  /** The Step 6 operation, when there was one. */
  operationId?: string;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  /**
   * The schema's hints to a model. `readOnlyHint` is the load-bearing one: a
   * client may reasonably decide to call read-only tools without asking, and
   * mislabelling a mutation here would be a lie with consequences.
   */
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

/* ------------------------------------------------------------------------ */
/* Argument reading                                                          */
/* ------------------------------------------------------------------------ */

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(`${field} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidInput(`${field} must be a string when present.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requiredInteger(args: Record<string, unknown>, field: string): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidInput(`${field} is required and must be an integer.`);
  }
  return value;
}

function optionalInteger(args: Record<string, unknown>, field: string): number | null {
  const value = args[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidInput(`${field} must be an integer when present.`);
  }
  return value;
}

/**
 * A caller-supplied idempotency key, validated or refused.
 *
 * Refused rather than ignored, for the same reason `effects/http.ts` refuses a
 * key in a query string: a caller that sent a malformed key believes it has a
 * property it does not have, and quietly dropping it leaves the belief in
 * place. It is optional because for every mutating tool here the logical key is
 * derivable from server-controlled facts anyway — see `keyFor`.
 */
function optionalIdempotencyKey(args: Record<string, unknown>): string | null {
  const value = args['idempotency_key'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidInput('idempotency_key must be a string.');
  try {
    return assertValidKey(value.trim());
  } catch (error) {
    if (error instanceof InvalidIdempotencyKey) throw invalidInput(error.message);
    throw error;
  }
}

/* ------------------------------------------------------------------------ */
/* Authorization                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The one authorization call, made at execution time.
 *
 * Deliberately delegates to the same `decideProjectAccess` every HTTP route
 * uses. There is no MCP policy module and there must never be one: two rule
 * sets mean two answers to "may this principal do this", and the looser one
 * gets found first.
 *
 * A denial is `NOT_FOUND`, always, with a message that names nothing. A project
 * a worker may not see is indistinguishable from one that does not exist —
 * invariant 23, and the reason Step 4 had to amend it was that the two had
 * differed by their *body* while sharing a status.
 */
async function authorize(
  principal: Principal,
  projectId: string,
  level: AccessLevel,
  scope?: WorkerScope,
): Promise<void> {
  const decision = decideProjectAccess(principal, projectId, level, scope);
  if (!decision.allowed) throw notFoundError();
}

/**
 * Resolve a work item and authorize the project it *actually* belongs to.
 *
 * The project comes from the row, never from an argument. A worker cannot reach
 * another project's item by naming a project it does have, because the project
 * it names is not consulted.
 */
async function requireOwnedItem(
  principal: Principal,
  workItemId: string,
  scope: WorkerScope,
): Promise<Awaited<ReturnType<typeof getWorkItem>>> {
  const item = await getWorkItem(workItemId);
  // Absent and forbidden take the same branch on purpose: authorizing first and
  // then reporting "not found" for a real miss would still leak the difference
  // through timing of the two paths, so both end here.
  if (!item) throw notFoundError();
  await authorize(principal, item.projectId, 'WRITE', scope);
  return item;
}

/** The authenticated worker, or a refusal. Never an id the caller sent. */
function workerOnly(principal: Principal): string {
  if (principal.type !== 'WORKER') {
    throw notPermitted();
  }
  return principal.id;
}

/* ------------------------------------------------------------------------ */
/* Lease proof and refusals                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Ownership is proved, not asserted.
 *
 * The worker id comes from the authenticated principal; the lease id and
 * generation come from what the claim handed back. A body field naming a worker
 * is ignored — Step 5's rule, and the whole reason the claim returns a
 * generation at all.
 */
function proofFrom(
  args: Record<string, unknown>,
  workItemId: string,
  workerId: string,
): OwnershipProof {
  return {
    workItemId,
    workerId,
    leaseId: requiredString(args, 'lease_id'),
    leaseGeneration: requiredInteger(args, 'lease_generation'),
  };
}

/**
 * Every lease refusal is one shape.
 *
 * A worker whose lease was reclaimed, one that never held it, and one asking
 * about an item that finished get the same category and the same sentence. The
 * rejection reason goes to the audit row, which Brain reads, and not to the
 * caller, which is what would otherwise learn the queue's state one guess at a
 * time.
 */
function refuseLease(result: Extract<LeaseResult, { ok: false }>): never {
  throw new ToolError('FENCE_LOST', 'This lease is not current for that work item.', {
    rejection: result.rejection,
  });
}

/* ------------------------------------------------------------------------ */
/* Idempotency for the mutating tools                                        */
/* ------------------------------------------------------------------------ */

/**
 * Namespaces are named for the *operation*, not for the door it came through.
 *
 * `queue.complete` rather than `mcp.queue.complete`, because the identity of
 * "complete work item X" does not change with the transport that asked for it.
 * If a later step wraps the HTTP routes in idempotency too, they join this
 * namespace rather than opening a second one that means the same thing.
 *
 * `principalScope: 'PROJECT'` because completing one work item is one intent
 * however many principals arrive at it — which is exactly the question that
 * field exists to answer.
 */
const COMPLETE_NAMESPACE: OperationNamespace = {
  name: 'queue.complete',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'STANDARD',
};

const FAIL_NAMESPACE: OperationNamespace = {
  name: 'queue.fail',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'STANDARD',
};

const RELEASE_NAMESPACE: OperationNamespace = {
  name: 'queue.release',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'STANDARD',
};

/**
 * The key for a queue mutation.
 *
 * Derived from the work item and which operation it is, and from nothing else.
 * Not the lease, not the attempt, not the generation, not the credential, not
 * the request, not the clock — a key that changes on the retry is not an
 * idempotency key, and every one of those changes on a retry. Step 6's
 * invariant 27, inherited rather than re-earned.
 *
 * A caller-supplied key is honoured when given, because a caller with its own
 * notion of one request is entitled to say so; but nothing *requires* one,
 * because the derived key is already stable.
 */
function keyFor(namespace: OperationNamespace, workItemId: string, supplied: string | null): string {
  if (supplied) return supplied;
  return logicalEffectKey({ workItemId, namespace: namespace.name });
}

/**
 * Run a queue mutation under Step 6, with the lease as the fence.
 *
 * The fence is re-proved as a guarded write inside the effect's own
 * transaction, so the queue-state change and the operation record land together
 * or not at all. A `SELECT` here would leave a window; that is why
 * `proveLeaseOwnership` is an `UPDATE`.
 */
async function idempotentQueueMutation(
  input: {
    namespace: OperationNamespace;
    principal: Principal;
    projectId: string;
    proof: OwnershipProof;
    suppliedKey: string | null;
    requestId: string;
    /** The semantic input. Inputs identify an operation; outputs never do. */
    payload: Record<string, unknown>;
  },
  effect: () => Promise<LeaseResult>,
): Promise<{ value: Record<string, unknown>; replayed: boolean; operationId: string }> {
  const key = keyFor(input.namespace, input.proof.workItemId, input.suppliedKey);
  try {
    const outcome = await runIdempotent<{ workItemId: string; state: string }>(
      {
        namespace: input.namespace,
        projectId: input.projectId,
        key,
        payload: input.payload,
        principalType: input.principal.type,
        principalId: input.principal.id,
        correlationId: input.requestId,
        fence: input.proof,
      },
      async () => {
        const result = await effect();
        if (!result.ok) {
          throw new TerminalEffectFailure(
            'NOT_AUTHORIZED',
            'The work item could not be changed under this lease.',
          );
        }
        return {
          resultRef: result.item.id,
          resultStatus: 200,
          resultSummary: result.item.state,
          value: { workItemId: result.item.id, state: result.item.state },
        };
      },
    );

    switch (outcome.status) {
      case 'EXECUTED':
        return { value: { ...outcome.value }, replayed: false, operationId: outcome.operation.id };
      case 'REPLAYED':
        // The case this whole mechanism exists for: a redelivered item finding
        // the effect it already performed. Not an error, and not a second one.
        return {
          value: { workItemId: input.proof.workItemId, state: 'ALREADY_RECORDED' },
          replayed: true,
          operationId: outcome.operation.id,
        };
      case 'UNCERTAIN':
        throw new ToolError(
          'RECONCILIATION_REQUIRED',
          'An earlier attempt at this operation had an unknown outcome. ' +
            'It must be resolved by an administrator before it can be retried.',
          { operationId: outcome.operation.id },
        );
      case 'TERMINAL_FAILURE':
        throw conflictError('That operation has already failed and will not be retried.', {
          operationId: outcome.operation.id,
        });
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error instanceof EffectFenceLost) {
      throw new ToolError('FENCE_LOST', 'This lease is no longer current.');
    }
    if (error instanceof OperationConflict) {
      // Never discloses the earlier payload. Only that the key is taken.
      throw conflictError('That idempotency key has already been used for a different request.');
    }
    if (error instanceof OperationInProgress) {
      throw new ToolError('IN_PROGRESS', 'An equivalent request is already being processed.');
    }
    throw error;
  }
}

/* ------------------------------------------------------------------------ */
/* Shapes returned to the caller                                             */
/* ------------------------------------------------------------------------ */

/**
 * What a caller may see about a work item.
 *
 * The lease id is published **only** to the worker the claim handed it to, at
 * claim time. It is proof of ownership, and a reader permitted to look at the
 * queue is not thereby its owner — the same reasoning `publicItem` in
 * `routes/work.ts` applies, kept identical here on purpose.
 */
function publicItem(item: NonNullable<Awaited<ReturnType<typeof getWorkItem>>>): Record<string, unknown> {
  return {
    id: item.id,
    projectId: item.projectId,
    workType: item.workType,
    state: item.state,
    priority: item.priority,
    availableAt: item.availableAt,
    payload: item.payload,
    requiredScopes: item.requiredScopes,
    attemptCount: item.attemptCount,
    maxAttempts: item.maxAttempts,
    leaseGeneration: item.leaseGeneration,
    hasLease: item.leaseId !== null,
    workerId: item.workerId,
    leasedAt: item.leasedAt,
    heartbeatAt: item.heartbeatAt,
    leaseExpiresAt: item.leaseExpiresAt,
    resultRef: item.resultRef,
    resultSummary: item.resultSummary,
    failureCategory: item.failureCategory,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
  };
}

/* ------------------------------------------------------------------------ */
/* The tools                                                                 */
/* ------------------------------------------------------------------------ */

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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
      limit: optionalInteger(args, 'limit') ?? 1,
      leaseMs: optionalInteger(args, 'lease_ms') ?? undefined,
      requestId,
    });

    return {
      // One claim may span projects, so the audit row records the project only
      // when the answer is unambiguous.
      projectId: claimed.length === 1 ? (claimed[0]?.projectId ?? null) : null,
      value: { claimed },
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
    'Give an item back without failing it — you are shutting down, or it is not yours to do. ' +
    'It returns to the queue immediately. Idempotent by work item.',
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
