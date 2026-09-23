/**
 * One bounded request to a provider, and nothing that could leak.
 *
 * Every provider call in this kernel goes through here for two reasons, and
 * both are about what an error is allowed to carry.
 *
 * **A URL may contain a credential.** ntfy's topic is its secret and it is in
 * the read path; a Stripe or Resend URL carries an object id. So nothing this
 * module throws, returns or logs includes the URL, a header or a body: an
 * error names the provider, the operation and the category — `TIMEOUT`,
 * `TRANSPORT`, an HTTP status — and that is all (invariant 22, §17).
 *
 * **A timeout is not evidence** (§20). A request that did not come back is
 * reported as `TRANSPORT` with `sent: true`, so the caller cannot mistake "we
 * heard nothing" for "nothing happened". What the caller does with that is the
 * effect class's decision, not this module's.
 */
export interface ProviderReply {
  status: number;
  /** Parsed JSON when the body was JSON; the raw text otherwise, capped. */
  json: unknown;
  text: string;
  /** Seconds the provider asked us to wait, when it said. */
  retryAfterSeconds: number | null;
}

export class ProviderTransportError extends Error {
  /** True: the request left, so the outcome is unknown rather than negative. */
  readonly sent = true;
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly category: 'TIMEOUT' | 'TRANSPORT',
  ) {
    super(`${provider} ${operation}: ${category === 'TIMEOUT' ? 'no reply in time' : 'the connection failed'}`);
    this.name = 'ProviderTransportError';
  }
}

export const PROVIDER_TIMEOUT_MS = 20_000;

/** Tests replace this; production uses the platform fetch. */
let fetcher: typeof fetch = (...args) => fetch(...args);

export function setProviderFetch(next: typeof fetch | null): void {
  fetcher = next ?? ((...args) => fetch(...args));
}

export async function providerRequest(input: {
  provider: string;
  operation: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<ProviderReply> {
  let response: Response;
  try {
    response = await fetcher(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new ProviderTransportError(
      input.provider,
      input.operation,
      name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT',
    );
  }
  let text = '';
  try {
    text = (await response.text()).slice(0, 200_000);
  } catch {
    throw new ProviderTransportError(input.provider, input.operation, 'TRANSPORT');
  }
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  return {
    status: response.status,
    json,
    text,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

/**
 * A provider's own error message, reduced to something safe to store.
 *
 * Providers put the offending value in their messages ("Invalid email:
 * someone@…"), so only the provider's error *code or type* is kept, never its
 * prose — the same reason `failureDetail.ts` keeps categories rather than text.
 */
export function providerErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const nested = record['error'];
  if (nested && typeof nested === 'object') {
    const inner = nested as Record<string, unknown>;
    for (const key of ['code', 'type']) {
      if (typeof inner[key] === 'string') return String(inner[key]).slice(0, 80);
    }
  }
  for (const key of ['name', 'code', 'type']) {
    if (typeof record[key] === 'string') return String(record[key]).slice(0, 80);
  }
  return null;
}
