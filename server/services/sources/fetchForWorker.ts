/**
 * Reading a public source on a worker's behalf.
 *
 * Production, Cash Mode 1, 2026-10-30: the $10K goal's own search had run 30
 * rounds and abandoned 29. Nearly every stated reason was the same — the
 * worker's sandbox could not open the source (`getaddrinfo ENOTFOUND`, a proxy
 * `CONNECT 403`, "this session's network allowlist does not resolve…"), so
 * every claim went to the gate unread and the gate, correctly, refused it.
 * The worker always reaches Brain, because Brain is its connector; Brain's own
 * server reaches the public web. So the worker asks Brain to read the page.
 *
 * What this is, and what it is not:
 *
 *  - **It reads; it never judges.** It returns the bytes it fetched, as text,
 *    with the final URL, the status, the time and a hash. Whether that text
 *    supports a claim is still the verification pass's question and the gate's
 *    decision (§12) — nothing here touches either.
 *  - **It widens no envelope.** Which sources an assignment may cite is the
 *    approval envelope's, unchanged. This changes *who opens the page*, not
 *    which pages count.
 *  - **Public addresses only, decided after resolution.** A hostname is
 *    resolved and every address it resolves to must be public; each redirect
 *    hop is re-validated the same way, and a redirect is never followed
 *    blindly. Loopback, private, link-local (including cloud metadata),
 *    carrier-grade NAT, multicast and reserved ranges are refused, as are
 *    literal IPs in those ranges, credentials in the URL, and any port but
 *    80 and 443.
 *  - **Bounded everywhere.** One request at a time per hop, a 20-second limit,
 *    2 MB of body, 60 000 characters of text returned (truncation is always
 *    reported, never silent — a caller that reads half a page and believes it
 *    read the whole draws conclusions from an absence that is not there).
 *  - **An unreadable page is reported as unreadable**, with the reason, so the
 *    worker submits the claim with its retrieval state set rather than
 *    inferring the page (§12, §40: an unread source is not a refutation).
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 2_000_000;
export const MAX_TEXT_CHARS = 60_000;
export const MAX_REDIRECTS = 4;

export type FetchRefusal =
  | 'INVALID_URL'
  | 'SCHEME_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'ADDRESS_NOT_PUBLIC'
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'NOT_TEXT'
  | 'EMPTY';

export type SourceFetch =
  | {
      readable: true;
      requestedUrl: string;
      finalUrl: string;
      status: number;
      contentType: string;
      retrievedAt: string;
      sha256: string;
      text: string;
      truncated: boolean;
      totalChars: number;
    }
  | {
      readable: false;
      requestedUrl: string;
      finalUrl: string | null;
      status: number | null;
      retrievedAt: string;
      reason: FetchRefusal;
      detail: string;
    };

/** Parse an IPv4 dotted quad, or null. */
function ipv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((one, i) => Number.isInteger(one) && one >= 0 && one <= 255 && /^\d+$/.test(parts[i]!))
    ? octets
    : null;
}

/** Whether an address is somewhere this server may be pointed at. Pure. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = ipv4(address)!;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b! >= 16 && b! <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24 and 192.0.2.0/24 start here
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false; // documentation
    if (a === 203 && b === 0) return false; // documentation
    if (a! >= 224) return false; // multicast and reserved
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return false; // link-local
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // unique local
    if (lower.startsWith('ff')) return false; // multicast
    if (lower.startsWith('2001:db8')) return false; // documentation
    if (lower.startsWith('64:ff9b')) return false; // NAT64 can reach private IPv4
    return true;
  }
  return false;
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((one) => one.address);

export type HttpFetch = (url: string, init: { signal: AbortSignal; redirect: 'manual'; headers: Record<string, string> }) => Promise<Response>;

/** The URL, validated as somewhere a worker may ask Brain to look, or the refusal. */
export async function checkDestination(
  raw: string,
  resolve: Resolver,
): Promise<{ ok: true; url: URL } | { ok: false; reason: FetchRefusal; detail: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'INVALID_URL', detail: 'not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'SCHEME_NOT_ALLOWED', detail: `${url.protocol} is not http or https` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'CREDENTIALS_IN_URL', detail: 'a URL carrying credentials is refused' };
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    return { ok: false, reason: 'PORT_NOT_ALLOWED', detail: `port ${url.port} is not 80 or 443` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch (error) {
      return { ok: false, reason: 'DNS_FAILED', detail: error instanceof Error ? error.message.slice(0, 200) : 'did not resolve' };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: 'DNS_FAILED', detail: 'resolved to no address' };
  if (!addresses.every(isPublicAddress)) {
    return { ok: false, reason: 'ADDRESS_NOT_PUBLIC', detail: 'the host resolves to an address that is not public' };
  }
  return { ok: true, url };
}

/** Readable text from a body, by content type. Markup is removed; nothing is summarised. */
export function textOf(body: string, contentType: string): string {
  if (!/html|xml/i.test(contentType)) return body.replace(/\r\n/g, '\n').trim();
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

const READABLE_TYPE = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json))/i;

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      chunks.push(value.subarray(0, value.byteLength - (total - MAX_BODY_BYTES)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((one) => Buffer.from(one))).toString('utf8');
}

/** Fetch one public page for a worker. Never throws. */
export async function fetchForWorker(
  requestedUrl: string,
  options: { resolve?: Resolver; fetch?: HttpFetch; now?: () => Date } = {},
): Promise<SourceFetch> {
  const resolve = options.resolve ?? systemResolver;
  const http = options.fetch ?? (globalThis.fetch as unknown as HttpFetch);
  const now = options.now ?? (() => new Date());
  const refused = (reason: FetchRefusal, detail: string, finalUrl: string | null, status: number | null): SourceFetch => ({
    readable: false,
    requestedUrl,
    finalUrl,
    status,
    retrievedAt: now().toISOString(),
    reason,
    detail,
  });

  let current = requestedUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await checkDestination(current, resolve);
    if (!checked.ok) return refused(checked.reason, checked.detail, hop === 0 ? null : current, null);
    let response: Response;
    try {
      response = await http(checked.url.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        headers: {
          'user-agent': 'BrainSourceReader/1.0 (research; reads one public page per request)',
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeout = /abort|timeout/i.test(message) || (error instanceof Error && error.name === 'TimeoutError');
      return refused(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', message.slice(0, 200), current, null);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return refused('HTTP_ERROR', `redirect ${response.status} with no location`, current, response.status);
      current = new URL(location, checked.url).toString();
      continue;
    }
    if (!response.ok) {
      return refused('HTTP_ERROR', `the site answered ${response.status}`, current, response.status);
    }
    const contentType = response.headers.get('content-type') ?? 'text/plain';
    if (!READABLE_TYPE.test(contentType)) {
      return refused('NOT_TEXT', `content type ${contentType.slice(0, 80)} is not text this reader returns`, current, response.status);
    }
    let body: string | null;
    try {
      body = await readCapped(response);
    } catch (error) {
      return refused('NETWORK_ERROR', error instanceof Error ? error.message.slice(0, 200) : 'body could not be read', current, response.status);
    }
    const whole = textOf(body ?? '', contentType);
    if (!whole) return refused('EMPTY', 'the page had no readable text (it may need JavaScript)', current, response.status);
    const text = whole.slice(0, MAX_TEXT_CHARS);
    return {
      readable: true,
      requestedUrl,
      finalUrl: current,
      status: response.status,
      contentType: contentType.slice(0, 120),
      retrievedAt: now().toISOString(),
      sha256: createHash('sha256').update(whole).digest('hex'),
      text,
      truncated: text.length < whole.length,
      totalChars: whole.length,
    };
  }
  return refused('TOO_MANY_REDIRECTS', `more than ${MAX_REDIRECTS} redirects`, current, null);
}
