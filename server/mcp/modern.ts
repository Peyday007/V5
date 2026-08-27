/**
 * The 2026-07-28 dispatcher.
 *
 * Stateless by construction: there is no handshake to have completed, no
 * session to look up, and nothing here remembers a previous request. Each call
 * arrives carrying its own protocol version and capabilities, is authorized
 * against rows read this request, and leaves nothing behind.
 *
 * Three methods, because three is what this revision requires of a server that
 * offers tools and nothing else:
 *
 *   server/discover  — MUST be implemented. Advertises versions and capabilities.
 *   tools/list       — the permanent surface.
 *   tools/call       — the whole point.
 *
 * Everything else is `-32601` with a `404`, which is exactly how a dual-era
 * client tells a modern server that lacks a method from a server that is not
 * an MCP endpoint at all.
 */
import type { Principal } from '../domain/types.ts';
import { callTool } from './execute.ts';
import { ToolError } from './errors.ts';
import {
  DISCOVER_TTL_MS,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_LIST_TTL_MS,
  cacheableResult,
  completeResult,
  invalidParams,
  methodNotFound,
  serverCapabilities,
  type JsonRpcResponse,
} from './protocol.ts';
import { describeTools } from './tools.ts';
import { argumentsOf, type ValidatedRequest } from './validate.ts';

export interface DispatchContext {
  principal: Principal;
  requestId: string;
  userAgent: string | null;
  remoteAddr: string | null;
}

/**
 * Answer one validated modern request.
 *
 * Returns null for a notification, which the transport turns into `202 Accepted`
 * with no body. This revision defines no client-to-server notification over
 * Streamable HTTP, so in practice that path is only reached by a client sending
 * something the core protocol does not define — accepted and dropped rather
 * than answered, because a notification has no id to answer to.
 */
export async function dispatchModern(
  request: ValidatedRequest,
  context: DispatchContext,
): Promise<JsonRpcResponse | null> {
  if (request.isNotification) return null;

  switch (request.method) {
    case 'server/discover':
      return ok(request, discoverResult());

    case 'tools/list':
      return ok(request, toolsListResult());

    case 'tools/call':
      return ok(request, await toolsCallResult(request, context));

    default:
      throw methodNotFound(request.method);
  }
}

function ok(request: ValidatedRequest, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id: request.id, result };
}

/**
 * What Brain is, and what it can speak.
 *
 * `supportedVersions` comes from the same array the validator accepts, so the
 * advertisement cannot drift from the behaviour — a server that lists a version
 * it then refuses is worse than one that lists fewer.
 */
function discoverResult(): Record<string, unknown> {
  return cacheableResult(
    {
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: serverCapabilities(),
      instructions: SERVER_INSTRUCTIONS,
      serverInfo: SERVER_INFO,
    },
    DISCOVER_TTL_MS,
  );
}

/**
 * The tool list, identical for every caller.
 *
 * No filtering by principal, deliberately — see the note at the top of
 * `tools.ts`. `cacheScope` is nevertheless `private`, because a client caching
 * this alongside results it computed for one credential should not share the
 * cache entry across authorization contexts.
 */
function toolsListResult(): Record<string, unknown> {
  return cacheableResult({ tools: describeTools() }, TOOL_LIST_TTL_MS);
}

async function toolsCallResult(
  request: ValidatedRequest,
  context: DispatchContext,
): Promise<Record<string, unknown>> {
  const name = request.params['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw invalidParams('A tools/call request must name a tool.');
  }

  try {
    const outcome = await callTool({
      toolName: name,
      args: argumentsOf(request),
      principal: context.principal,
      requestId: context.requestId,
      clientName: request.client.name,
      protocolVersion: request.protocolVersion,
      userAgent: context.userAgent,
      remoteAddr: context.remoteAddr,
    });
    // The modern envelope goes on here, at the era boundary, and nowhere else.
    return completeResult({ ...outcome.result });
  } catch (error) {
    // `callTool` throws only when the tool itself was not found, which is a
    // failure to *find* the tool rather than an outcome of running it — and the
    // schema puts that one in the protocol error, not in the result.
    if (error instanceof ToolError && error.category === 'NOT_FOUND') {
      throw methodNotFound(`tools/call ${name}`);
    }
    throw error;
  }
}
