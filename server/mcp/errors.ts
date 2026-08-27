/**
 * What a tool is allowed to say when it refuses.
 *
 * The distinction this file exists to hold is the one the schema draws:
 *
 *   > Any errors that originate from the tool SHOULD be reported inside the
 *   > result object, with `isError` set to true, _not_ as an MCP protocol-level
 *   > error response. Otherwise, the LLM would not be able to see that an error
 *   > occurred and self-correct.
 *
 * So an authorization refusal is a *result*, not a protocol error. That is not
 * a weakening: the caller still gets nothing, and the audit row still records a
 * denial. It means the consumer that has to react to the refusal can actually
 * see it, instead of it being swallowed by a transport layer as a failed call.
 *
 * Protocol errors — unknown method, header mismatch, unsupported version — stay
 * protocol errors, because those are failures to *admit* the call rather than
 * outcomes of it.
 */

/**
 * The closed set. A category is a fact about the shape of the refusal, and
 * every one of them is safe to hand to an untrusted caller.
 */
export const TOOL_ERROR_CATEGORIES = [
  /** The thing is not there, or is not yours. Deliberately one category. */
  'NOT_FOUND',
  /** You are authenticated, and this is not something you may do. */
  'NOT_PERMITTED',
  /** The arguments did not typecheck against the tool's schema. */
  'INVALID_INPUT',
  /** The state moved under you: already terminal, already cancelled. */
  'CONFLICT',
  /** Your lease is gone. Someone else owns this now, or nobody does. */
  'FENCE_LOST',
  /** An equivalent request is running. Wait, do not duplicate it. */
  'IN_PROGRESS',
  /** An earlier attempt ended unknown. A person must resolve it. */
  'RECONCILIATION_REQUIRED',
  /** You went over a bound. */
  'LIMIT_EXCEEDED',
  /** Brain could not answer right now. Not your fault, and retryable. */
  'UNAVAILABLE',
] as const;

export type ToolErrorCategory = (typeof TOOL_ERROR_CATEGORIES)[number];

/**
 * A refusal a tool may produce.
 *
 * `message` is written for a reader and carries **no** identifiers the caller
 * did not already send, no SQL, no stack, no provider text and no payload. The
 * audit row is where the detail goes, because Brain owns that and the caller
 * does not read it.
 */
export class ToolError extends Error {
  readonly category: ToolErrorCategory;
  readonly detail: Record<string, unknown>;

  constructor(category: ToolErrorCategory, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.category = category;
    this.detail = detail;
  }
}

/**
 * The one sentence that answers both "there is no such thing" and "there is,
 * and it is not yours".
 *
 * Step 4 found this leak in the HTTP resolvers — an absent project said
 * `No project with id "prj_abc".` and a forbidden one said
 * `No project with that id.`, both under a 404, which is an oracle for
 * enumerating a Brain you have no access to. Invariant 23 was amended to say
 * the *body* must match too. The same rule applies here, and this constant is
 * how it is kept: one string, used by both paths, naming nothing.
 */
export const NOT_FOUND_MESSAGE = 'No such resource, or it is not available to you.';

export function notFoundError(): ToolError {
  return new ToolError('NOT_FOUND', NOT_FOUND_MESSAGE);
}

export function notPermitted(): ToolError {
  // Distinct from NOT_FOUND on purpose, and only used where the caller already
  // demonstrably knows the resource exists — a work item it holds the lease on,
  // its own principal. Never used to answer "may I see this project", which is
  // always NOT_FOUND.
  return new ToolError('NOT_PERMITTED', 'That is not something this credential may do.');
}

export function invalidInput(message: string): ToolError {
  return new ToolError('INVALID_INPUT', message);
}

export function conflictError(message: string, detail: Record<string, unknown> = {}): ToolError {
  return new ToolError('CONFLICT', message, detail);
}

export function limitExceeded(message: string, detail: Record<string, unknown> = {}): ToolError {
  return new ToolError('LIMIT_EXCEEDED', message, detail);
}
