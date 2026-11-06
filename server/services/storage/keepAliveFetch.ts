/**
 * A `fetch` for the document store that keeps its connections.
 *
 * Production, 2026-11-06 (connection reports after #548 and #554): the Brain
 * process was on the CPU 51–58 s of every minute, about 15 s of it opening TLS
 * connections, and the newest process opened 847 TLS sockets in 3.4 minutes
 * (246 a minute) to the Supabase storage host. Node's built-in `fetch` reuses a
 * connection only for back-to-back calls: a burst of parallel existence checks
 * (a recompute lists every layer's folder at once) opens one connection per
 * request, and any connection idle for four seconds is closed, so every
 * recompute paid a fresh handshake per request. The event-loop stalls that
 * read as "the database is overloaded" were largely this.
 *
 * So the store gets its own `https.Agent`: connections are kept for a minute
 * and at most eight are open, so a burst queues on warm connections instead of
 * handshaking new ones. The return value is a standard `Response` with a
 * streamed body, so the provider's callers are unchanged.
 */
import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { Readable } from 'node:stream';

export const STORE_MAX_SOCKETS = 8;
export const STORE_KEEP_ALIVE_MS = 60_000;
/**
 * A response at most this large is read whole before it is handed back, so its
 * socket returns to the pool at once whatever the caller does with it.
 *
 * With a bounded agent a response nobody reads holds its socket for good —
 * built-in fetch let the garbage collector reclaim one, an `https.Agent` does
 * not — and several callers rightly ignore a body (a successful upload, a
 * delete, a 404). Eight such sockets and every storage call would wait. Only a
 * larger GET is streamed, and the idle bound below ends one nobody finishes.
 */
export const STORE_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
/** A socket that moves no bytes for this long is destroyed: unread, or a store that stopped answering. */
export const STORE_IDLE_MS = 45_000;

const httpsAgent = new Agent({ keepAlive: true, maxSockets: STORE_MAX_SOCKETS, maxFreeSockets: STORE_MAX_SOCKETS, timeout: STORE_KEEP_ALIVE_MS });
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: STORE_MAX_SOCKETS, maxFreeSockets: STORE_MAX_SOCKETS, timeout: STORE_KEEP_ALIVE_MS });

const NO_BODY = new Set([101, 204, 205, 304]);

function idleMs(): number {
  const raw = Number(process.env['BRAIN_STORE_IDLE_MS'] ?? '');
  return Number.isFinite(raw) && raw >= 50 ? raw : STORE_IDLE_MS;
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function bodyBytes(body: RequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError('keepAliveFetch sends string or byte bodies only');
}

export const keepAliveFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const secure = url.protocol === 'https:';
    const body = bodyBytes(init.body);
    const headers = headerRecord(init.headers);
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(body.byteLength);
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const req = (secure ? httpsRequest : httpRequest)(
      url,
      { method: init.method ?? 'GET', headers, agent: secure ? httpsAgent : httpAgent, ...(signal ? { signal } : {}) },
      (res) => {
        res.on('error', () => undefined);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const one of Array.isArray(value) ? value : [value]) responseHeaders.append(key, one);
        }
        const status = res.statusCode ?? 500;
        if (NO_BODY.has(status) || init.method === 'HEAD') {
          res.resume();
          resolve(new Response(null, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }));
          return;
        }
        const length = Number(res.headers['content-length'] ?? NaN);
        const stream = (init.method ?? 'GET') === 'GET' && !(Number.isFinite(length) && length <= STORE_BUFFER_LIMIT_BYTES);
        if (stream) {
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status,
              statusText: res.statusMessage ?? '',
              headers: responseHeaders,
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: responseHeaders })),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(idleMs(), () => req.destroy(new Error(`the document store sent nothing for ${Math.round(idleMs() / 1000)} s`)));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
