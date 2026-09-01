/**
 * The primitives every tool is built from.
 *
 * This file exists so that there is exactly one of each of them. Step 9 added a
 * second file of tools, and the failure mode worth engineering against is not
 * that the second file would be wrong on the day it was written — it is that
 * two copies of an authorization call, an ownership proof or an idempotency
 * wrapper drift, and the looser copy is the one an attacker finds.
 *
 * So `authorize` is the only authorization call, `requireOwnedItem` is the only
 * way a tool resolves a work item, `proofFrom` is the only place a lease proof
 * is assembled, and `idempotentEffect` is the only path a mutation takes. A
 * tool file that wanted to do any of those differently would have to say so out
 * loud by not importing from here.
 */
import type { ClaimedWork, Principal, WorkerScope } from '../domain/types.ts';
import { decideProjectAccess, type AccessLevel } from '../services/identity/policy.ts';
import {
  getWorkItem,
  type OwnershipProof,
  type LeaseResult,
} from '../repos/workQueue.ts';
import {
  EffectFenceLost,
  OperationConflict,
  OperationInProgress,
  runIdempotent,
  TerminalEffectFailure,
  type OperationNamespace,
} from '../services/effects/engine.ts';
import { logicalEffectKey, assertValidKey, InvalidIdempotencyKey } from './../services/effects/fingerprint.ts';
import { ToolError, conflictError, invalidInput, notFoundError, notPermitted } from './errors.ts';
import { workType } from '../services/queue/workTypes.ts';

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
 *
 * It lives in the toolkit rather than beside `brain_claim_work` because
 * `brain_bin_next_item` hands out the same items and needs the same answer,
 * and the two tool modules must not import each other to share one function.
 */
export function describeClaimed(item: ClaimedWork): Record<string, unknown> {
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

export function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(`${field} is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidInput(`${field} must be a string when present.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function requiredInteger(args: Record<string, unknown>, field: string): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidInput(`${field} is required and must be an integer.`);
  }
  return value;
}

export function optionalInteger(args: Record<string, unknown>, field: string): number | null {
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
export function optionalIdempotencyKey(args: Record<string, unknown>): string | null {
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
export async function authorize(
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
export async function requireOwnedItem(
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
export function workerOnly(principal: Principal): string {
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
export function proofFrom(
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
export function refuseLease(result: Extract<LeaseResult, { ok: false }>): never {
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
export const COMPLETE_NAMESPACE: OperationNamespace = {
  name: 'queue.complete',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'STANDARD',
};

export const FAIL_NAMESPACE: OperationNamespace = {
  name: 'queue.fail',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'STANDARD',
};

export const RELEASE_NAMESPACE: OperationNamespace = {
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
export function keyFor(
  namespace: OperationNamespace,
  workItemId: string,
  supplied: string | null,
  discriminator?: string,
): string {
  if (supplied) return supplied;
  return logicalEffectKey({ workItemId, namespace: namespace.name, discriminator });
}

/**
 * Run a queue mutation under Step 6, with the lease as the fence.
 *
 * The fence is re-proved as a guarded write inside the effect's own
 * transaction, so the queue-state change and the operation record land together
 * or not at all. A `SELECT` here would leave a window; that is why
 * `proveLeaseOwnership` is an `UPDATE`.
 */
export interface FencedEffectInput {
  namespace: OperationNamespace;
  principal: Principal;
  projectId: string;
  proof: OwnershipProof;
  suppliedKey: string | null;
  requestId: string;
  /** The semantic input. Inputs identify an operation; outputs never do. */
  payload: Record<string, unknown>;
  /**
   * Set when one work item carries more than one distinct effect — a fragment
   * item submits claims and later reports a blocker, and those are two
   * operations rather than one repeated. Never derived from what the caller
   * sent; it names which operation this is, not what it contains.
   */
  discriminator?: string;
}

/** What an effect hands back for the operation record and for the caller. */
export interface EffectResult {
  resultRef: string;
  resultSummary: string;
  value: Record<string, unknown>;
}

/**
 * Run any fenced mutation under Step 6.
 *
 * The general form, which `idempotentQueueMutation` is one caller of. The fence
 * is re-proved as a guarded write inside the effect's own transaction, so the
 * state change and the operation record land together or not at all — a
 * `SELECT` here would leave a window.
 *
 * A replay never returns the original response body. Nothing stores one, on
 * purpose: a principal who lost access between the first call and the replay
 * must not be handed the result of the first.
 */
export async function idempotentEffect(
  input: FencedEffectInput,
  effect: () => Promise<EffectResult>,
): Promise<{ value: Record<string, unknown>; replayed: boolean; operationId: string }> {
  const key = keyFor(input.namespace, input.proof.workItemId, input.suppliedKey, input.discriminator);
  try {
    const outcome = await runIdempotent<Record<string, unknown>>(
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
        return {
          resultRef: result.resultRef,
          resultStatus: 200,
          resultSummary: result.resultSummary,
          value: result.value,
        };
      },
    );

    switch (outcome.status) {
      case 'EXECUTED':
        return { value: { ...outcome.value }, replayed: false, operationId: outcome.operation.id };
      case 'REPLAYED':
        // The case this whole mechanism exists for: a redelivered item finding
        // the effect it already performed. Not an error, and not a second one.
        //
        // The body is deliberately the same three fields for every effect. The
        // original response was never stored, so there is nothing else honest
        // to return, and inventing a reconstruction would be worse than saying
        // plainly that this already happened.
        return {
          value: {
            workItemId: input.proof.workItemId,
            state: 'ALREADY_RECORDED',
            recordedAt: outcome.operation.completedAt ?? outcome.operation.createdAt,
          },
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

/**
 * The queue's own mutations, over `idempotentEffect`.
 *
 * A lease result is not an `EffectResult`, so the translation lives here rather
 * than in every caller: a refusal becomes a terminal effect failure, because a
 * mutation the lease did not permit is not something to retry into.
 */
export async function idempotentQueueMutation(
  input: FencedEffectInput,
  effect: () => Promise<LeaseResult>,
): Promise<{ value: Record<string, unknown>; replayed: boolean; operationId: string }> {
  return await idempotentEffect(input, async () => {
    const result = await effect();
    if (!result.ok) {
      throw new TerminalEffectFailure(
        'NOT_AUTHORIZED',
        'The work item could not be changed under this lease.',
      );
    }
    return {
      resultRef: result.item.id,
      resultSummary: result.item.state,
      value: { workItemId: result.item.id, state: result.item.state },
    };
  });
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
export function publicItem(item: NonNullable<Awaited<ReturnType<typeof getWorkItem>>>): Record<string, unknown> {
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

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
