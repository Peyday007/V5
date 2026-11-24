/**
 * Brain's HTTP API, from the browser, with the person's own session.
 *
 * Every number on every page arrives through here from a Brain route. Nothing
 * is computed, cached across sessions or invented in the Command Center: a page
 * that has no answer says so.
 */

export class BrainError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    const flagged =
      !!body && typeof body === 'object' && (body as { retryable?: unknown }).retryable === true;
    this.retryable = flagged || status === 0 || status === 502 || status === 503 || status === 504;
  }
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    const isCode = typeof r.error === 'string' && /^[a-z_]+$/.test(r.error);
    if (isCode && typeof r.message === 'string' && r.message.trim()) return r.message;
    if (r.error === 'temporarily_unavailable')
      return 'Brain could not reach its database just now. It will try again shortly.';
    if (typeof r.error === 'string' && r.error.trim()) return r.error;
    if (typeof r.message === 'string' && r.message.trim()) return r.message;
  }
  if (typeof body === 'string' && body.trim() && !body.trim().startsWith('<'))
    return body.slice(0, 300);
  return fallback;
}

export async function brain<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new BrainError('Brain could not be reached just now. It will try again shortly.', 0, null);
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new BrainError(
      messageFrom(payload, `${response.status} ${response.statusText || 'Request failed'}`),
      response.status,
      payload
    );
  }
  return payload as T;
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return brain<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

/** One of Brain's read-only operator tools, through `/api/command/read/:tool`. */
export async function readTool<T>(tool: string, args: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(args).toString();
  const result = await brain<{ value: T }>(
    `/api/command/read/${encodeURIComponent(tool)}${query ? `?${query}` : ''}`
  );
  return result.value;
}

export const enc = encodeURIComponent;
