/**
 * One tool call, from arguments to a `CallToolResult`.
 *
 * Everything that must happen for *every* tool lives here rather than in the
 * tools: the rate slot, the audit row, the result bound, and the translation
 * from a refusal into something the caller can read. A tool that had to
 * remember to do any of those would eventually be a tool that forgot.
 */
import { recordIdentityEvent } from '../repos/identity.ts';
import type { Principal } from '../domain/types.ts';
import { ToolError } from './errors.ts';
import { assertResultWithinBounds, takeRateSlot } from './limits.ts';
import { findTool, type ToolContext } from './tools.ts';

export interface CallInput {
  toolName: string;
  args: Record<string, unknown>;
  principal: Principal;
  requestId: string;
  /** For the audit row. Self-reported by the client and never trusted. */
  clientName: string | null;
  protocolVersion: string;
  userAgent: string | null;
  remoteAddr: string | null;
}

/**
 * Write the audit row for one call.
 *
 * Metadata carries counts, categories and ids only. Never arguments, never
 * document text, never a passage, never a payload, never a key, never a
 * credential — the same rule `routes/work.ts` already follows, and the reason
 * it is repeated here rather than shared is that the two are separate
 * boundaries and a shared helper would make it easy to widen both at once.
 */
async function audit(input: {
  call: CallInput;
  projectId: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordIdentityEvent({
      actorType: input.call.principal.type,
      actorId: input.call.principal.id,
      credentialId: input.call.principal.credentialId,
      action: 'MCP_TOOL_CALL',
      targetType: 'MCP_TOOL',
      targetId: input.call.toolName,
      projectId: input.projectId,
      result: input.result,
      requestId: input.call.requestId,
      metadata: {
        protocolVersion: input.call.protocolVersion,
        client: input.call.clientName,
        ...input.metadata,
      },
      userAgent: input.call.userAgent,
      remoteAddr: input.call.remoteAddr,
    });
  } catch {
    // Losing the record of a call is bad; turning the call into a failure
    // because the record could not be written is worse. The database being
    // unreachable is about to be loud in its own right.
  }
}

/**
 * A refusal, shaped as a result rather than as a protocol error.
 *
 * The schema is explicit that tool-originated errors belong in the result so
 * the consumer can see them and self-correct. An authorization refusal
 * delivered as a transport failure is one the caller cannot reason about.
 *
 * The text is the `ToolError`'s message and nothing else — no detail object is
 * merged into the human-readable line, because the detail is where operational
 * facts live and the line is what an untrusted caller reads.
 */
function errorResult(error: ToolError): CallToolBody {
  return {
    content: [{ type: 'text', text: error.message }],
    structuredContent: { error: { category: error.category, message: error.message, ...error.detail } },
    isError: true,
  };
}

/**
 * The unexpected case.
 *
 * A thrown Error that is not a `ToolError` is a bug, and its message may carry
 * a connection string, a file path or a SQL fragment. None of that reaches the
 * caller: it gets a fixed sentence, and the audit row records only that the
 * category was internal. The real error is left to the process log, which is
 * Brain's to read.
 */
function internalResult(): CallToolBody {
  return {
    content: [{ type: 'text', text: 'That call could not be completed.' }],
    structuredContent: { error: { category: 'UNAVAILABLE', message: 'That call could not be completed.' } },
    isError: true,
  };
}

/**
 * The era-neutral body of a `CallToolResult`.
 *
 * Deliberately *without* `resultType`, `_meta` or the cache fields: those are
 * 2026-07-28's envelope, and stamping them onto a result bound for a
 * 2025-11-25 client would be sending it fields from a revision it does not
 * implement. Each front-end wraps this in the envelope its own era defines,
 * which is the one place the two eras are allowed to differ.
 */
export interface CallToolBody {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
  isError: boolean;
}

export interface CallOutput {
  result: CallToolBody;
}

/**
 * Execute one tool call.
 *
 * Never throws for an ordinary refusal — the refusal is the result. It throws
 * only for `tools/call` naming a tool that does not exist, which is a failure
 * to *find* the tool and therefore a protocol error, and the dispatcher turns
 * it into one.
 */
export async function callTool(input: CallInput): Promise<CallOutput> {
  const tool = findTool(input.toolName);
  if (!tool) {
    // Deliberately *not* audited as a denial: the tool list is public to any
    // authenticated caller, so asking for a name that is not on it discloses
    // nothing and is more likely a stale client than an attack.
    throw new ToolError('NOT_FOUND', `No tool named ${JSON.stringify(input.toolName)}.`);
  }

  // The slot is taken before any work and released in `finally`, so a tool that
  // throws cannot leak concurrency. Exceeding the limit is itself a ToolError,
  // which means a throttled caller gets a readable answer rather than a
  // connection that appears to hang.
  let slot;
  try {
    slot = takeRateSlot(input.principal.credentialId);
  } catch (error) {
    if (error instanceof ToolError) {
      await audit({
        call: input,
        projectId: null,
        result: 'DENIED',
        metadata: { category: error.category },
      });
      return { result: errorResult(error) };
    }
    throw error;
  }

  try {
    const context: ToolContext = { principal: input.principal, requestId: input.requestId };
    const outcome = await tool.run(input.args, context);

    // The last gate before anything leaves. A result over the bound is refused
    // rather than cut, because truncating a JSON structure cannot be reported
    // honestly — the caller would parse it as complete.
    assertResultWithinBounds(outcome.value);

    await audit({
      call: input,
      projectId: outcome.projectId,
      result: 'SUCCESS',
      metadata: {
        ...(outcome.replayed === undefined ? {} : { replayed: outcome.replayed }),
        ...(outcome.operationId ? { operationId: outcome.operationId } : {}),
      },
    });

    return {
      result: {
        // Both shapes, deliberately. `structuredContent` is what a program
        // reads; the text block is what a model reads, and a client that
        // supports only one of the two still gets the answer.
        content: [{ type: 'text', text: JSON.stringify(outcome.value, null, 2) }],
        structuredContent: outcome.value,
        isError: false,
      },
    };
  } catch (error) {
    if (error instanceof ToolError) {
      await audit({
        call: input,
        projectId: null,
        result: error.category === 'NOT_PERMITTED' || error.category === 'NOT_FOUND' ? 'DENIED' : 'FAILED',
        // The category is recorded here and not disclosed differently to the
        // caller: NOT_FOUND and NOT_PERMITTED read identically on the wire and
        // differ only in this row, which Brain owns.
        metadata: { category: error.category },
      });
      return { result: errorResult(error) };
    }
    // eslint-disable-next-line no-console
    console.error('[mcp] tool call failed', input.toolName, error);
    await audit({
      call: input,
      projectId: null,
      result: 'FAILED',
      metadata: { category: 'INTERNAL' },
    });
    return { result: internalResult() };
  } finally {
    slot.release();
  }
}
