/**
 * Rendering a page that needs JavaScript, in a browser that does not run here.
 *
 * Brain's machine has 2 GB and a record of out-of-memory kills (fly.toml), and its
 * image deliberately carries no browser (`design/renderRuntime.ts`). So the browser
 * is Microsoft's Playwright MCP server, run as its own Fly app on the private
 * network (`.github/workflows/browser.yml`), and Brain is a client of it over
 * MCP's streamable HTTP transport. It is reached only when
 * `BRAIN_BROWSER_MCP_URL` is set; without it this answers "not configured" and the
 * source-access layer moves on.
 *
 * What this does and does not change:
 *
 *  - The address is validated by Brain exactly as a direct read is
 *    (`checkDestination`) before the browser is asked, and the page's final
 *    address is validated again after: a page that ended somewhere not public is
 *    refused, whatever it rendered.
 *  - It reads what a person's browser would show. It does not sign in, solve a
 *    challenge, or recover a page the site removed.
 *  - Bounded: two renders at a time from this process, one navigation limit, one
 *    session per render (`--isolated` on the server, so nothing carries between
 *    pages), and the session is closed in a `finally`.
 */
import { createHash } from 'node:crypto';
import { checkDestination, MAX_TEXT_CHARS, systemResolver, type Resolver, type SourceFetch } from './fetchForWorker.ts';

export const BROWSER_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT = 2;

export function browserMcpUrl(): string | null {
  const raw = (process.env.BRAIN_BROWSER_MCP_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
}

let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** The JSON-RPC payload of an MCP HTTP reply, which may be plain JSON or one SSE event. */
export function rpcPayload(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  const candidates = trimmed.startsWith('{')
    ? [trimmed]
    : trimmed
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
  for (const one of candidates.reverse()) {
    try {
      const parsed = JSON.parse(one) as Record<string, unknown>;
      if (parsed && (parsed['result'] !== undefined || parsed['error'] !== undefined)) return parsed;
    } catch {
      // not this line
    }
  }
  return null;
}

/** The value `browser_evaluate` returned, from its text result. */
export function evaluateResult(payload: Record<string, unknown>): unknown {
  const result = payload['result'] as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  const text = (result?.content ?? []).map((one) => one.text ?? '').join('\n');
  if (result?.isError) throw new Error(text.slice(0, 200) || 'the browser reported an error');
  const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
  const raw = (match ? match[1]! : text).trim();
  let value: unknown = JSON.parse(raw);
  // The page returns a JSON string so the shape survives the tool's own serialisation.
  if (typeof value === 'string') value = JSON.parse(value);
  return value;
}

type Http = (url: string, init: RequestInit) => Promise<Response>;

class McpSession {
  private session: string | null = null;
  private id = 0;
  constructor(
    private readonly endpoint: string,
    private readonly http: Http,
    private readonly signal: AbortSignal,
  ) {}

  async request(method: string, params: Record<string, unknown>, notify = false): Promise<Record<string, unknown> | null> {
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params };
    const response = await this.http(this.endpoint, {
      method: 'POST',
      signal: this.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify(body),
    });
    this.session = response.headers.get('mcp-session-id') ?? this.session;
    const text = await response.text();
    if (notify) return null;
    if (!response.ok) throw new Error(`browser server answered ${response.status}`);
    const payload = rpcPayload(text);
    if (!payload) throw new Error('browser server reply was not JSON-RPC');
    if (payload['error']) throw new Error(`browser server error: ${JSON.stringify(payload['error']).slice(0, 160)}`);
    return payload;
  }

  async close(): Promise<void> {
    if (!this.session) return;
    await this.http(this.endpoint, { method: 'DELETE', headers: { 'mcp-session-id': this.session }, signal: AbortSignal.timeout(5_000) }).catch(
      () => undefined,
    );
  }
}

const PAGE_TEXT =
  '() => JSON.stringify({ url: location.href, title: document.title, ' +
  'text: document.body ? document.body.innerText : "" })';

/** Render one public page in the separate browser and return its visible text. Never throws. */
export async function renderInBrowser(
  requestedUrl: string,
  options: { endpoint?: string | null; http?: Http; resolve?: Resolver; now?: () => Date; timeoutMs?: number } = {},
): Promise<SourceFetch> {
  const endpoint = options.endpoint === undefined ? browserMcpUrl() : options.endpoint;
  const resolve = options.resolve ?? systemResolver;
  const now = options.now ?? (() => new Date());
  const refused = (reason: 'NETWORK_ERROR' | 'TIMEOUT' | 'EMPTY' | 'ADDRESS_NOT_PUBLIC' | 'HTTP_ERROR', detail: string, finalUrl: string | null): SourceFetch => ({
    readable: false,
    requestedUrl,
    finalUrl,
    status: null,
    retrievedAt: now().toISOString(),
    reason,
    detail: detail.slice(0, 200),
  });
  if (!endpoint) return refused('NETWORK_ERROR', 'no browser is configured (BRAIN_BROWSER_MCP_URL)', null);
  const checked = await checkDestination(requestedUrl, resolve);
  if (!checked.ok) {
    return { readable: false, requestedUrl, finalUrl: null, status: null, retrievedAt: now().toISOString(), reason: checked.reason, detail: checked.detail };
  }
  return slot(async () => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? BROWSER_TIMEOUT_MS);
    const mcp = new McpSession(endpoint, options.http ?? (globalThis.fetch as Http), signal);
    try {
      await mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'brain-source-reader', version: '1.0' },
      });
      await mcp.request('notifications/initialized', {}, true);
      const nav = await mcp.request('tools/call', { name: 'browser_navigate', arguments: { url: checked.url.toString() } });
      const navResult = nav?.['result'] as { isError?: boolean; content?: { text?: string }[] } | undefined;
      if (navResult?.isError) {
        return refused('HTTP_ERROR', `the browser could not open the page: ${(navResult.content ?? []).map((c) => c.text ?? '').join(' ')}`, null);
      }
      // A page that renders its content after load gets a moment, then is read as it stands.
      await mcp.request('tools/call', { name: 'browser_wait_for', arguments: { time: 2 } }).catch(() => null);
      const evaluated = await mcp.request('tools/call', { name: 'browser_evaluate', arguments: { function: PAGE_TEXT } });
      const page = evaluateResult(evaluated ?? {}) as { url?: unknown; title?: unknown; text?: unknown };
      const finalUrl = typeof page.url === 'string' ? page.url : checked.url.toString();
      const landed = await checkDestination(finalUrl, resolve);
      if (!landed.ok) return refused('ADDRESS_NOT_PUBLIC', `the page ended somewhere not public (${landed.reason})`, null);
      const whole = String(page.text ?? '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim();
      if (!whole) return refused('EMPTY', 'the rendered page had no visible text', finalUrl);
      const text = whole.slice(0, MAX_TEXT_CHARS);
      return {
        readable: true,
        requestedUrl,
        finalUrl,
        status: 200,
        contentType: 'text/html; rendered',
        retrievedAt: now().toISOString(),
        sha256: createHash('sha256').update(whole).digest('hex'),
        text,
        truncated: text.length < whole.length,
        totalChars: whole.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /abort|timeout/i.test(message) || (error instanceof Error && error.name === 'TimeoutError');
      return refused(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', `browser: ${message}`, null);
    } finally {
      await mcp.close();
    }
  });
}
