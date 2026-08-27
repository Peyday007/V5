/**
 * The wire contract, and nothing else.
 *
 * This module holds the constants and shapes the 2026-07-28 revision defines,
 * transcribed from `schema/2026-07-28/schema.ts` rather than from memory or
 * from an SDK. That distinction is the reason the file exists: the official
 * TypeScript SDK tops out at `2025-11-25` and contains no reference to this
 * revision at all, so there is nothing to import and every rule below had to be
 * read off the published schema.
 *
 * Nothing here touches the database, the principal or a tool. It is the layer
 * that knows what a well-formed MCP message looks like, so that the layers
 * above can be about Brain instead.
 */

/* ------------------------------------------------------------------------ */
/* Versions                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The revision this gateway is built to. Stateless, no `initialize`, no
 * sessions, no GET stream, no SSE resumability.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * The newest revision the official SDK can speak, and therefore the newest one
 * any MCP client in existence can speak today.
 *
 * Serving it is not nostalgia. The specification's own compatibility matrix
 * marks "legacy client, modern server" as **Fails** with no fall-forward
 * mechanism available to the client — so a modern-only Brain would be a
 * conformant server that nothing could connect to.
 */
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';

/**
 * What `server/discover` advertises and what the dispatcher accepts, in one
 * array so the advertisement cannot drift from the behaviour. Newest first:
 * a client picking the head of the list picks the one we would rather serve.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
];

export function isSupportedVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/** Which era a version belongs to. The two are served by different front-ends. */
export type ProtocolEra = 'MODERN' | 'LEGACY';

export function eraOf(version: string): ProtocolEra | null {
  if (version === MODERN_PROTOCOL_VERSION) return 'MODERN';
  if (version === LEGACY_PROTOCOL_VERSION) return 'LEGACY';
  return null;
}

/* ------------------------------------------------------------------------ */
/* `_meta` keys                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The reserved keys the revision defines. Spelled out as constants because a
 * typo in one of these is a request that validates as "absent" rather than as
 * "wrong", which is the failure mode hardest to see in a test.
 */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/* ------------------------------------------------------------------------ */
/* Headers                                                                   */
/* ------------------------------------------------------------------------ */

export const HEADER_PROTOCOL_VERSION = 'mcp-protocol-version';
export const HEADER_METHOD = 'mcp-method';
export const HEADER_NAME = 'mcp-name';

/**
 * The sentinel a client wraps a header value in when it cannot be represented
 * as plain ASCII. Case-sensitive, and the markers must appear exactly.
 */
const BASE64_PREFIX = '=?base64?';
const BASE64_SUFFIX = '?=';

/**
 * Decode a header value that may carry the Base64 sentinel.
 *
 * Servers **MUST** decode before comparing to the body, which is the entire
 * reason this is not a plain string equality somewhere upstream: a client
 * sending a tool name with a non-ASCII character sends it encoded, and a server
 * comparing the raw header would reject a perfectly conformant request.
 *
 * Returns null when the value claims the sentinel but is not decodable — that
 * is a malformed header, not a value that happens to look like one.
 */
export function decodeHeaderValue(raw: string): string | null {
  if (!raw.startsWith(BASE64_PREFIX) || !raw.endsWith(BASE64_SUFFIX)) return raw;
  const inner = raw.slice(BASE64_PREFIX.length, raw.length - BASE64_SUFFIX.length);
  // `Buffer.from` is famously forgiving, so the round trip is the check: a
  // string that does not re-encode to itself was not valid base64.
  let decoded: string;
  try {
    const buffer = Buffer.from(inner, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== inner.replace(/=+$/, '')) return null;
    decoded = buffer.toString('utf8');
  } catch {
    return null;
  }
  return decoded;
}

/* ------------------------------------------------------------------------ */
/* Error codes                                                               */
/* ------------------------------------------------------------------------ */

/**
 * JSON-RPC's own range, unchanged.
 */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * The revision's own allocations, from the sub-range reserved for the
 * specification.
 *
 * These were renumbered in this revision — `HeaderMismatch` moved from -32001
 * to -32020, `MissingRequiredClientCapability` from -32003 to -32021 and
 * `UnsupportedProtocolVersion` from -32004 to -32022 — because -32000..-32019
 * is grandfathered to existing SDK usage. Using the old numbers would collide
 * with whatever an SDK already means by them.
 */
/**
 * Transport-level refusals: 401, 403, 405, 413, 503.
 *
 * JSON-RPC has no code for "you may not", and the three that look close are all
 * wrong: `-32603` (Internal error) blames the server for the caller's request,
 * `-32600` (Invalid Request) says the JSON was malformed when it parsed fine,
 * and `-32601` means the method is unknown when the method was never reached.
 *
 * So this comes from `-32000..-32019`, which this revision's error-code policy
 * reserves as implementation-defined precisely for cases the specification does
 * not name. `-32000` is also what the official SDK emits for its own
 * transport-level refusals ("Not Acceptable", "Bad Request: Server not
 * initialized"), so a client that recognises one recognises both.
 */
export const TRANSPORT_REFUSED = -32000;

export const HEADER_MISMATCH = -32020;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/* ------------------------------------------------------------------------ */
/* Message shapes                                                            */
/* ------------------------------------------------------------------------ */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export interface JsonRpcResultResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export type JsonRpcResponse = JsonRpcErrorResponse | JsonRpcResultResponse;

/**
 * An error that carries the HTTP status the revision requires alongside it.
 *
 * The pairing is normative rather than conventional — `400` for a header
 * mismatch, `400` for an unsupported version, `404` for an unknown method — and
 * a dual-era *client* uses exactly that pairing to tell a modern server from a
 * legacy one. Getting the status wrong would make a conformant client fall back
 * to `initialize` against a server that never needed it.
 */
export class McpProtocolError extends Error {
  readonly code: number;
  readonly status: number;
  readonly data: unknown;

  constructor(code: number, status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function parseError(message: string): McpProtocolError {
  return new McpProtocolError(PARSE_ERROR, 400, message);
}

export function invalidRequest(message: string): McpProtocolError {
  return new McpProtocolError(INVALID_REQUEST, 400, message);
}

export function methodNotFound(method: string): McpProtocolError {
  // 404, not 400. The revision is explicit, and the JSON-RPC body is what
  // distinguishes this from the 404 of a server that does not host an MCP
  // endpoint at all.
  return new McpProtocolError(METHOD_NOT_FOUND, 404, `Unknown method: ${method}`);
}

export function invalidParams(message: string): McpProtocolError {
  return new McpProtocolError(INVALID_PARAMS, 400, message);
}

export function headerMismatch(message: string): McpProtocolError {
  return new McpProtocolError(HEADER_MISMATCH, 400, `Header mismatch: ${message}`);
}

export function unsupportedProtocolVersion(requested: string): McpProtocolError {
  return new McpProtocolError(
    UNSUPPORTED_PROTOCOL_VERSION,
    400,
    'Unsupported protocol version',
    { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested },
  );
}

export function errorResponse(id: JsonRpcId, error: McpProtocolError): JsonRpcErrorResponse {
  const body: JsonRpcErrorBody = { code: error.code, message: error.message };
  if (error.data !== undefined) body.data = error.data;
  return { jsonrpc: '2.0', id, error: body };
}

/* ------------------------------------------------------------------------ */
/* Result envelopes                                                          */
/* ------------------------------------------------------------------------ */

/** Who is answering. Self-reported, for display and logs; never a security input. */
export const SERVER_INFO = { name: 'brain', version: '1.0.0' } as const;

/**
 * `resultType` is required on every result in this revision.
 *
 * Brain never returns `"input_required"`: the MRTR path exists so a server can
 * ask the client for sampling, elicitation or roots mid-call, and Brain never
 * needs input from a client — a tool has its arguments or it fails. So the
 * value is always `"complete"`, and that is a property of the design rather
 * than a shortcut.
 */
export function completeResult(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    resultType: 'complete',
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
  };
}

/**
 * How long a client may cache a list or read result, and who may cache it.
 *
 * `cacheScope` is `"private"` for everything Brain returns, without exception.
 * Every result here is shaped by the caller's own memberships and scopes, so a
 * shared intermediary serving one worker's `tools/list` to another would be
 * serving an answer computed for a different principal. `"public"` would be a
 * claim that the response contains no caller-specific data, and none of Brain's
 * do.
 */
export function cacheableResult(
  body: Record<string, unknown>,
  ttlMs: number,
): Record<string, unknown> {
  return completeResult({ ...body, ttlMs, cacheScope: 'private' });
}

/** Tool lists are stable — the set is permanent — but not immutable. Five minutes. */
export const TOOL_LIST_TTL_MS = 5 * 60 * 1000;

/** Discovery is the most stable thing here: versions and capabilities. An hour. */
export const DISCOVER_TTL_MS = 60 * 60 * 1000;

/**
 * What Brain can do, declared honestly.
 *
 * `resources`, `prompts`, `completions` and `logging` are **absent** rather
 * than present-and-empty, because absent is what the schema means by "does not
 * offer". Declaring an empty `resources` object would tell a client to go
 * looking for a `resources/list` that answers `-32601`.
 *
 * `tools.listChanged` is `false` and honestly so: the set is permanent, and
 * announcing changes would require `subscriptions/listen`, which this gateway
 * does not implement.
 */
export function serverCapabilities(): Record<string, unknown> {
  return { tools: { listChanged: false } };
}

export const SERVER_INSTRUCTIONS =
  'Brain is a research-operations platform. These tools read project state and ' +
  'operate the durable work queue: claim an item, heartbeat while working on it, ' +
  'then complete, fail or release it. Every call is authorized against the ' +
  'credential you presented, so a tool may be listed and still refuse. Mutating ' +
  'calls are idempotent by work item, so a retry after a timeout is safe and ' +
  'will not perform the effect twice.';
