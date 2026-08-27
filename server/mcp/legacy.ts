/**
 * The 2025-11-25 front-end, over the official SDK.
 *
 * This exists because of a three-week gap: the current protocol revision is
 * `2026-07-28`, and the official TypeScript SDK — version 1.30.0, published the
 * day before that revision — declares `LATEST_PROTOCOL_VERSION = '2025-11-25'`
 * and contains no reference to the newer one at all. Every MCP client in
 * existence is built on that SDK or one of its siblings, so every client is a
 * legacy client, and the specification's own compatibility matrix marks
 * "legacy client, modern server" as **Fails** with no fall-forward available.
 *
 * A modern-only Brain would therefore be a conformant server that nothing could
 * connect to. The specification anticipated exactly this and permits the
 * resolution outright: *"A dual-era server MAY serve both eras concurrently on
 * the same endpoint or process."*
 *
 * So this module speaks the old protocol, and it does so through the reference
 * implementation rather than by hand — because for that revision there *is* a
 * reference implementation, and re-deriving a handshake somebody else has
 * already tested would be work with no upside.
 *
 * **It is stateless anyway.** The SDK offers a session mode and Brain does not
 * use it: `sessionIdGenerator: undefined` means no `Mcp-Session-Id` is minted,
 * echoed or validated. The gateway keeps no state in either era, so a restart
 * loses nothing and a revoked credential stops working on the next call rather
 * than at some later re-handshake.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { callTool } from './execute.ts';
import { ToolError } from './errors.ts';
import { LEGACY_PROTOCOL_VERSION, SERVER_INFO, SERVER_INSTRUCTIONS } from './protocol.ts';
import { describeTools } from './tools.ts';
import type { DispatchContext } from './modern.ts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A fresh server and transport for one request.
 *
 * Not an optimisation opportunity. The SDK enforces it — in stateless mode a
 * transport refuses to handle a second request — and it is also the property
 * that makes this front-end honest: nothing survives the response, so there is
 * no per-connection state for two Brain instances to disagree about.
 *
 * The principal is captured in the closure rather than read from a store,
 * because it was resolved by the endpoint from the credential on *this*
 * request. There is no lookup that could return a different one.
 */
function buildServer(context: DispatchContext): Server {
  const server = new Server(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    {
      // Only tools. `resources`, `prompts`, `logging` and `completions` are
      // absent rather than empty, so the SDK refuses those methods for us and a
      // client is never told to go looking for something that is not there.
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // The same registry the modern era serves, in the same order. Two tool
    // surfaces that could drift apart would be two security reviews.
    tools: describeTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = isPlainObject(request.params.arguments) ? request.params.arguments : {};

    try {
      const outcome = await callTool({
        toolName: name,
        args,
        principal: context.principal,
        requestId: context.requestId,
        clientName: legacyClientName(server),
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        userAgent: context.userAgent,
        remoteAddr: context.remoteAddr,
      });
      // The era-neutral body, with no modern envelope on it: `resultType` and
      // the cache fields belong to 2026-07-28, and a 2025-11-25 client should
      // not be handed fields from a revision it does not implement.
      //
      // Widened to a record because the SDK's `ServerResult` is a union whose
      // members carry index signatures; a closed interface matches none of
      // them, and the union's other arm (a task result) then dominates the
      // error message. This is a structural accommodation, not a cast away
      // from a type that was telling us something.
      const body: Record<string, unknown> = { ...outcome.result };
      return body;
    } catch (error) {
      // `callTool` throws only for a tool that does not exist. The SDK turns a
      // thrown error into a JSON-RPC error response, which is where the schema
      // says a failure to *find* a tool belongs.
      if (error instanceof ToolError) throw new Error(error.message);
      throw error;
    }
  });

  return server;
}

/** What the client called itself at `initialize`. Self-reported; audit only. */
function legacyClientName(server: Server): string | null {
  const version = server.getClientVersion();
  return version?.name ?? null;
}

/**
 * Serve one legacy request.
 *
 * The body is already parsed by Express, so it is passed in rather than read
 * from the stream — reading it twice would hang.
 */
export async function handleLegacy(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  context: DispatchContext,
): Promise<void> {
  const server = buildServer(context);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Both are closed when the response ends, whether it ended well or not. A
  // leaked transport per request would be a slow leak that only shows up under
  // the load a real fleet produces.
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
