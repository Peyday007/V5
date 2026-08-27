/**
 * A minimal MCP client for protocol revision 2026-07-28.
 *
 * This exists because no SDK can speak that revision. The official TypeScript
 * SDK's latest release declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` and
 * contains no reference to `2026-07-28`, so proving Brain's modern era works
 * requires a client written to the published schema by hand.
 *
 * **It imports nothing from `server/`, deliberately.** Every constant, header
 * name, `_meta` key and error code below was transcribed from
 * `schema/2026-07-28/schema.ts` and the Streamable HTTP transport page, not
 * from Brain's own modules. A client built out of the server's types would
 * prove only that the server agrees with itself; this one can disagree with it,
 * which is the entire point of having it.
 *
 * It is used by `tests/mcpExternalClient.test.ts` and by
 * `scripts/verify-hosted.ts`, so the same client that passes in CI is the one
 * pointed at the deployed Brain.
 */

export const MODERN_VERSION = '2026-07-28';

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcReply<T = Record<string, unknown>> {
  status: number;
  result?: T;
  error?: RpcError;
}

export interface ModernClientOptions {
  url: string;
  credential: string;
  clientName?: string;
  clientVersion?: string;
  /** Override headers, to exercise the server's validation. Tests only. */
  headerOverrides?: Record<string, string | undefined>;
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface CallToolReply {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
}

/**
 * The methods whose name is mirrored into `Mcp-Name`, and where it comes from.
 * A conformant client sends this header or the server refuses with -32020.
 */
const NAMED: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
};

/**
 * Encode a header value, using the Base64 sentinel when it cannot be carried
 * as plain ASCII. The markers are case-sensitive and must appear exactly.
 */
function encodeHeaderValue(value: string): string {
  const safe = /^[\x21-\x7e]*$/.test(value) && value.trim() === value && !value.startsWith('=?base64?');
  if (safe) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export class ModernMcpClient {
  private readonly options: ModernClientOptions;
  private nextId = 1;

  constructor(options: ModernClientOptions) {
    this.options = options;
  }

  /**
   * One request, as its own POST.
   *
   * There is no handshake to have completed and no session to carry: every
   * request declares its own version, identity and capabilities.
   */
  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<RpcReply<T>> {
    const id = this.nextId;
    this.nextId += 1;

    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [META_PROTOCOL_VERSION]: MODERN_VERSION,
          [META_CLIENT_INFO]: {
            name: this.options.clientName ?? 'brain-modern-client',
            version: this.options.clientVersion ?? '1.0.0',
          },
          // Required, and required to be an object. Empty means "no optional
          // capabilities", which is exactly true of this client.
          [META_CLIENT_CAPABILITIES]: {},
        },
      },
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Both, as the transport section requires: the server may answer with
      // either a single JSON object or an SSE stream.
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.options.credential}`,
      'mcp-protocol-version': MODERN_VERSION,
      'mcp-method': method,
    };

    const nameField = NAMED[method];
    if (nameField) {
      const value = params[nameField];
      if (typeof value === 'string') headers['mcp-name'] = encodeHeaderValue(value);
    }

    for (const [key, value] of Object.entries(this.options.headerOverrides ?? {})) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }

    const response = await fetch(this.options.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: { result?: T; error?: RpcError } = {};
    try {
      parsed = text ? (JSON.parse(text) as { result?: T; error?: RpcError }) : {};
    } catch {
      parsed = {};
    }

    const reply: RpcReply<T> = { status: response.status };
    if (parsed.result !== undefined) reply.result = parsed.result;
    if (parsed.error !== undefined) reply.error = parsed.error;
    return reply;
  }

  /** Servers MUST implement this. Clients MAY call it before anything else. */
  async discover(): Promise<RpcReply<{ supportedVersions: string[]; capabilities: Record<string, unknown>; instructions?: string }>> {
    return await this.request('server/discover');
  }

  async listTools(): Promise<RpcReply<{ tools: ToolDescriptor[]; ttlMs: number; cacheScope: string }>> {
    return await this.request('tools/list');
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<RpcReply<CallToolReply>> {
    return await this.request<CallToolReply>('tools/call', { name, arguments: args });
  }

  /**
   * The structured payload of a successful tool call, or a thrown error.
   *
   * Convenience for callers that want the happy path to read like a function
   * call. Anything that is not a clean success — a protocol error, an
   * `isError` result — throws, so a caller cannot mistake a refusal for data.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const reply = await this.callTool(name, args);
    if (reply.error) throw new Error(`${name}: protocol error ${reply.error.code} ${reply.error.message}`);
    if (!reply.result) throw new Error(`${name}: no result`);
    if (reply.result.isError) {
      const structured = reply.result.structuredContent as { error?: { category?: string; message?: string } } | undefined;
      throw new Error(`${name}: ${structured?.error?.category ?? 'ERROR'} ${structured?.error?.message ?? ''}`.trim());
    }
    return (reply.result.structuredContent ?? {}) as Record<string, unknown>;
  }
}
