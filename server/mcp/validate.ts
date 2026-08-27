/**
 * Deciding whether a request is admissible, before deciding what it means.
 *
 * The 2026-07-28 revision mirrors selected body fields into HTTP headers so
 * that load balancers and gateways can route on them without parsing JSON, and
 * then requires the server to prove the two agree. That requirement is a
 * security control rather than a tidiness one, and the schema says why:
 *
 *   > This prevents potential security vulnerabilities when different
 *   > components in the network rely on different sources of truth (e.g., a
 *   > load balancer routing on the header value while the MCP server executes
 *   > based on the body value).
 *
 * Brain sits behind exactly such a balancer. A request whose header says
 * `brain_list_projects` and whose body says `brain_complete_work` is a request
 * that was rate-limited, routed and logged as one thing and would execute as
 * another. It is refused.
 */
import type { Request } from 'express';
import {
  HEADER_METHOD,
  HEADER_NAME,
  HEADER_PROTOCOL_VERSION,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  decodeHeaderValue,
  eraOf,
  headerMismatch,
  invalidRequest,
  isSupportedVersion,
  unsupportedProtocolVersion,
  type JsonRpcId,
  type JsonRpcRequest,
  type ProtocolEra,
} from './protocol.ts';

/** The methods whose `Mcp-Name` header is required, and where its value lives. */
const NAMED_METHODS: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
};

export interface ClientIdentity {
  name: string | null;
  version: string | null;
}

export interface ValidatedRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  protocolVersion: string;
  era: ProtocolEra;
  client: ClientIdentity;
  /** Declared per request. Never carried over from a previous one. */
  capabilities: Record<string, unknown>;
  /** True when the body carried no `id`, i.e. it is a notification. */
  isNotification: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this body shaped like a modern request at all?
 *
 * Used by the endpoint to choose an era before validating, because the two eras
 * disagree about what a valid request even is. A legacy `initialize` carries no
 * `_meta` protocol version; a modern request must.
 */
export function looksModern(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const params = body['params'];
  if (!isPlainObject(params)) return false;
  const meta = params['_meta'];
  if (!isPlainObject(meta)) return false;
  return typeof meta[META_PROTOCOL_VERSION] === 'string';
}

/** The id, salvaged from a body that may be anything at all, for the error response. */
export function idOf(body: unknown): JsonRpcId {
  if (!isPlainObject(body)) return null;
  const id = body['id'];
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

/**
 * Read one header, decoding the Base64 sentinel if it carries one.
 *
 * A value that claims the sentinel and does not decode is a malformed header,
 * which the revision lists among the header-validation failures — so it is a
 * `HeaderMismatch`, not an absent header.
 */
function headerValue(req: Request, name: string): string | null | undefined {
  const raw = req.header(name);
  if (raw === undefined) return undefined;
  const decoded = decodeHeaderValue(raw);
  return decoded;
}

/**
 * Validate a modern request: JSON-RPC shape, `_meta`, version, and the headers.
 *
 * Order is deliberate. The version is checked before the headers that must
 * match it, and both before anything looks at what the method wants, so that a
 * client sending a version we do not speak learns that rather than learning
 * about a header requirement that only exists in versions it is not using.
 */
export function validateModernRequest(req: Request, body: unknown): ValidatedRequest {
  if (!isPlainObject(body)) {
    throw invalidRequest('A request body must be a single JSON-RPC object.');
  }
  if (body['jsonrpc'] !== '2.0') {
    throw invalidRequest('A request must declare "jsonrpc": "2.0".');
  }
  if (Array.isArray(body)) {
    throw invalidRequest('This revision defines one request per POST, not a batch.');
  }

  const method = body['method'];
  if (typeof method !== 'string' || method.length === 0) {
    throw invalidRequest('A request must name a method.');
  }

  const rawId = body['id'];
  const isNotification = rawId === undefined;
  if (!isNotification && typeof rawId !== 'string' && typeof rawId !== 'number' && rawId !== null) {
    throw invalidRequest('A request id must be a string, a number or null.');
  }
  const id: JsonRpcId = isNotification ? null : (rawId as JsonRpcId);

  const params = body['params'];
  if (!isPlainObject(params)) {
    throw invalidRequest('A request must carry a params object holding its _meta.');
  }

  const meta = params['_meta'];
  if (!isPlainObject(meta)) {
    throw invalidRequest(
      'A request must carry _meta with io.modelcontextprotocol/protocolVersion.',
    );
  }

  const declared = meta[META_PROTOCOL_VERSION];
  if (typeof declared !== 'string' || declared.length === 0) {
    throw invalidRequest(
      'A request must declare io.modelcontextprotocol/protocolVersion in its _meta.',
    );
  }

  // Unsupported before mismatched. A client speaking a version we do not have
  // gets the list it needs to retry; telling it about a header rule for a
  // version it is not using would be a worse answer to a better question.
  if (!isSupportedVersion(declared)) throw unsupportedProtocolVersion(declared);

  const headerVersion = headerValue(req, HEADER_PROTOCOL_VERSION);
  if (headerVersion === undefined) {
    throw headerMismatch('the MCP-Protocol-Version header is required and was not sent');
  }
  if (headerVersion === null) {
    throw headerMismatch('the MCP-Protocol-Version header is malformed');
  }
  if (headerVersion !== declared) {
    // Never echoes the two values. Naming them would put caller-controlled
    // strings into a log line and buy the caller nothing it did not send.
    throw headerMismatch(
      'the MCP-Protocol-Version header does not match io.modelcontextprotocol/protocolVersion in the body',
    );
  }

  const headerMethod = headerValue(req, HEADER_METHOD);
  if (headerMethod === undefined) {
    throw headerMismatch('the Mcp-Method header is required and was not sent');
  }
  if (headerMethod === null) throw headerMismatch('the Mcp-Method header is malformed');
  if (headerMethod !== method) {
    throw headerMismatch('the Mcp-Method header does not match the method in the body');
  }

  const nameField = NAMED_METHODS[method];
  if (nameField) {
    const bodyValue = params[nameField];
    if (typeof bodyValue !== 'string' || bodyValue.length === 0) {
      throw invalidRequest(`A ${method} request must carry params.${nameField}.`);
    }
    const headerName = headerValue(req, HEADER_NAME);
    if (headerName === undefined) {
      throw headerMismatch('the Mcp-Name header is required for this method and was not sent');
    }
    if (headerName === null) throw headerMismatch('the Mcp-Name header is malformed');
    if (headerName !== bodyValue) {
      throw headerMismatch('the Mcp-Name header does not match the name in the body');
    }
  }

  // Required, and required to be an object. An absent one is a client that has
  // not been updated; an empty one is a client declaring no optional
  // capabilities, which is both legal and by far the common case here.
  const capabilities = meta[META_CLIENT_CAPABILITIES];
  if (!isPlainObject(capabilities)) {
    throw invalidRequest(
      'A request must declare io.modelcontextprotocol/clientCapabilities in its _meta, ' +
        'as an object. An empty object means no optional capabilities.',
    );
  }

  const era = eraOf(declared);
  if (!era) throw unsupportedProtocolVersion(declared);

  return {
    id,
    method,
    params,
    protocolVersion: declared,
    era,
    client: clientIdentity(meta[META_CLIENT_INFO]),
    capabilities,
    isNotification,
  };
}

/**
 * The client's self-description, bounded and never trusted.
 *
 * The schema is explicit that this value is self-reported and unverified, that
 * servers SHOULD NOT change behaviour on it and SHOULD NOT use it for security
 * decisions. Brain does neither: it is read for the audit row and truncated,
 * because it is a caller-controlled string on its way to a log.
 */
function clientIdentity(value: unknown): ClientIdentity {
  if (!isPlainObject(value)) return { name: null, version: null };
  const name = value['name'];
  const version = value['version'];
  return {
    name: typeof name === 'string' ? name.slice(0, 120) : null,
    version: typeof version === 'string' ? version.slice(0, 60) : null,
  };
}

/** The `params` of a validated request, as a plain record, minus the protocol's own `_meta`. */
export function argumentsOf(request: ValidatedRequest): Record<string, unknown> {
  const args = request.params['arguments'];
  return isPlainObject(args) ? args : {};
}

export function asJsonRpcRequest(body: unknown): JsonRpcRequest | null {
  if (!isPlainObject(body)) return null;
  if (body['jsonrpc'] !== '2.0') return null;
  if (typeof body['method'] !== 'string') return null;
  return body as unknown as JsonRpcRequest;
}
