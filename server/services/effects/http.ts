/**
 * The request side of idempotency.
 *
 * Two rules shape this file, and both come from things that go wrong in
 * practice rather than from taste.
 *
 * **The key arrives in a header, never a query parameter.** Query strings are
 * written to proxy logs, kept in browser history and forwarded in `Referer`.
 * Supporting them "for convenience" would make the convenient way the leaky
 * one, which is the same argument that keeps credentials out of URLs elsewhere
 * in this project. A key in the query string is refused outright rather than
 * quietly ignored, because silently ignoring it would mean the caller believes
 * it has idempotency and does not.
 *
 * **A replay re-reads and re-authorizes.** It does not hand back a stored
 * response body. The operation record keeps a *reference* to the canonical
 * record, and replay fetches that record through the same authorization as any
 * other read — so a principal who has since lost access to the project gets
 * nothing, even though the original request was allowed. Storing the response
 * would have made that impossible to enforce, which is why nothing stores one.
 */
import type { Request } from 'express';
import { conflict, badRequest } from '../../routes/helpers.ts';
import { InvalidIdempotencyKey, assertValidKey } from './fingerprint.ts';
import {
  OperationConflict,
  OperationInProgress,
  runIdempotent,
  type ExecutionResult,
  type RunInput,
} from './engine.ts';
import type { IdempotencyOperation } from '../../domain/types.ts';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Names that would mean somebody tried to pass the key through the URL. */
const QUERY_ALIASES = ['idempotency_key', 'idempotencyKey', 'idempotency-key'];

/**
 * The key for this request, or null when none was supplied.
 *
 * Refuses a key in the query string rather than ignoring it: a caller who put
 * it there believes they have idempotency, and letting the request through
 * would give them the belief without the property.
 */
export function idempotencyKeyOf(req: Request): string | null {
  for (const alias of QUERY_ALIASES) {
    if ((req.query as Record<string, unknown>)[alias] !== undefined) {
      throw badRequest(
        'An idempotency key must be sent in the Idempotency-Key header, not in the URL. ' +
          'Query strings are logged by proxies and kept in browser history.',
      );
    }
  }
  const header = req.header(IDEMPOTENCY_HEADER);
  if (header === undefined) return null;
  try {
    return assertValidKey(header.trim());
  } catch (error) {
    if (error instanceof InvalidIdempotencyKey) throw badRequest(error.message);
    throw error;
  }
}

export interface IdempotentRouteInput<T> extends Omit<RunInput, 'key'> {
  key: string;
  /**
   * Re-read the canonical record and re-check the caller's authorization.
   *
   * Called on replay instead of returning anything stored. Returning null means
   * the record is gone or the caller may no longer see it, which is reported as
   * a conflict rather than as the original success — a replay that leaks a
   * result to somebody who lost access would be worse than no replay at all.
   */
  replay: (operation: IdempotencyOperation) => Promise<T | null>;
}

/** What the caller gets back, plus how it was produced. */
export interface IdempotentReply<T> {
  value: T;
  replayed: boolean;
  operationId: string;
}

export async function runIdempotentRequest<T>(
  input: IdempotentRouteInput<T>,
  execute: (context: { operation: IdempotencyOperation }) => Promise<ExecutionResult<T>>,
): Promise<IdempotentReply<T>> {
  try {
    const outcome = await runIdempotent<T>(input, async (context) => await execute(context));

    switch (outcome.status) {
      case 'EXECUTED':
        return { value: outcome.value, replayed: false, operationId: outcome.operation.id };
      case 'REPLAYED': {
        const replayed = await input.replay(outcome.operation);
        if (replayed === null) {
          throw conflict(
            'That operation has already completed, and its result is not available to you now.',
            { reason: 'REPLAY_UNAVAILABLE' },
          );
        }
        return { value: replayed, replayed: true, operationId: outcome.operation.id };
      }
      case 'UNCERTAIN':
        throw conflict(
          'An earlier attempt at this operation had an unknown outcome. ' +
            'It must be resolved by an administrator before it can be retried.',
          { reason: 'RECONCILIATION_REQUIRED', operationId: outcome.operation.id },
        );
      case 'TERMINAL_FAILURE':
        throw conflict('That operation has already failed and will not be retried.', {
          reason: 'ALREADY_TERMINAL',
          category: outcome.operation.failureCategory,
          operationId: outcome.operation.id,
        });
    }
  } catch (error) {
    if (error instanceof OperationConflict) {
      // Never discloses the earlier payload — only that the key is taken.
      throw conflict('That idempotency key has already been used for a different request.', {
        reason: 'FINGERPRINT_CONFLICT',
      });
    }
    if (error instanceof OperationInProgress) {
      throw conflict('An equivalent request is already being processed.', {
        reason: 'IN_PROGRESS',
        operationId: error.operation.id,
      });
    }
    throw error;
  }
}
