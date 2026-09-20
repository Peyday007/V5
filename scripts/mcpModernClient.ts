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

/**
 * How long one request may take before this client says so — **when it is what
 * ends the wait**, which measurement says is usually not the case.
 *
 * Matches `verify-hosted.ts`'s own bound deliberately: the two are the same
 * client talking to the same Brain, and a shorter one here would make the
 * release gate fail in two different places for one condition. What neither of
 * them can do is outlast undici's 300.9s header wait, because `AbortSignal`
 * does not raise it — see the request itself, which measures rather than
 * assumes which limit fired.
 */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * What to say when nothing answered, from what was observed.
 *
 * Pure, so the branch it draws is testable without a socket. It separates the
 * two limits `fetch` collapses, because their remedies are opposite and the
 * thrown error names neither: `UND_ERR_HEADERS_TIMEOUT` is undici's own
 * header wait, which `signal` does not raise, and an abort is this client's
 * bound actually being reached. The elapsed time is always reported, because
 * it is the only number in the sentence that was measured.
 */
export function describeTimeout(
  method: string,
  params: Record<string, unknown>,
  elapsedMs: number,
  error: unknown,
  cause: string | undefined,
): string {
  const named = typeof params['name'] === 'string' ? ` (${params['name']})` : '';
  const waited = `${(elapsedMs / 1000).toFixed(1)}s`;
  const message = error instanceof Error ? error.message : String(error);
  const limit =
    cause === 'UND_ERR_HEADERS_TIMEOUT'
      ? " undici's own header wait ended it, which this client's bound does not raise, so " +
        `the ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s limit below it was never reached.`
      : cause === 'TimeoutError' || message.includes('timed out')
        ? ` This client's own ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s limit ended it.`
        : '';
  return (
    `${method}${named} did not answer; nothing answered it after ${waited} ` +
    `(${message}${cause ? `, ${cause}` : ''}).${limit} The request was not refused.`
  );
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

    /*
     * An explicit bound with a named failure — **and the bound does not bind.**
     *
     * The paragraph this replaces said fifteen minutes is where the next
     * occurrence either finishes or fails naming the method and the wait. It
     * failed naming the method. It did not wait fifteen minutes, and it said
     * it had.
     *
     * `AbortSignal.timeout` bounds the *whole* request and does not raise
     * undici's `headersTimeout`, which is what actually ends a wait for a
     * server that has accepted the connection and not answered. Measured here
     * rather than recalled — a server that accepts and never replies, Node
     * 22.22.2, `AbortSignal.timeout(900_000)` — it throws after **300.9s**
     * with `UND_ERR_HEADERS_TIMEOUT`, which is §27's 300.8s default unchanged
     * by the signal. Raising it needs a `dispatcher`, which needs `undici` as
     * a dependency, and this repository has none.
     *
     * So the deploy of 2026-09-20 failed twice, and both readings are the
     * default rather than the bound: `brain_submit_audit` at **319.6s**
     * pre-restart, `brain_submit_synthesis` at **335.1s** after it. Two
     * different methods, which also refines §27's "always the judge step" —
     * it is whichever long call comes next.
     *
     * **A message that states a wait nobody waited is worse than the
     * unattributable `fetch failed` it replaced**, because it sends the next
     * reader looking for a fifteen-minute operation. So the sentence reports
     * the **observed** elapsed time, which is a measurement, and names the
     * limit that actually applied when undici's is the one that fired.
     *
     * **None of this is a fix for the slowness and it must not be read as
     * one.** How long the judge pass really takes is still unknown, and the
     * instrument that could answer it is a dispatcher rather than a signal.
     */
    let response: Response;
    const startedAt = Date.now();
    try {
      response = await fetch(this.options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new Error(describeTimeout(method, params, Date.now() - startedAt, error, cause), {
        cause: error,
      });
    }

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
