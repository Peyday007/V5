/**
 * One bounded request to a commercial provider, and what its answer is
 * evidence of.
 *
 * Two rules decide the shape, and both are invariants rather than taste.
 *
 * **A timeout, a reset or a 5xx is not evidence that nothing happened**
 * (invariant 26). Each is reported as `UNCERTAIN`, and the effects engine then
 * asks the provider (if it can be asked) or stops for a person. Only an answer
 * the provider documents as "this was not processed" — a 4xx, or a 429 — is a
 * refusal, and only a 429 is a refusal it is safe to repeat.
 *
 * **No credential leaves this file in anything but the request header**
 * (invariant 22). The key is never in a URL, never in a returned detail, never
 * in a thrown message; a provider's error body is reduced to its own error
 * *type* and *code*, because provider messages sometimes echo the request, and
 * an echoed request is the kind of thing that ends up in an audit row.
 */
import type { EffectFailureCategory } from '../../../domain/types.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Long enough for a slow provider, short enough that a tick is not held. */
export const PROVIDER_TIMEOUT_MS = 20_000;

export type ProviderAnswer =
  | { kind: 'OK'; status: number; body: Record<string, unknown> }
  | {
      kind: 'REFUSED';
      status: number;
      category: EffectFailureCategory;
      /** True only where the provider documents that nothing was processed. */
      retryable: boolean;
      /** The provider's own error type/code, never its prose and never a value. */
      detail: string;
    }
  | { kind: 'UNKNOWN'; reason: string };

function safeCode(body: unknown): string {
  if (!body || typeof body !== 'object') return 'no error body';
  const error = (body as Record<string, unknown>).error;
  const source = error && typeof error === 'object' ? (error as Record<string, unknown>) : body;
  const parts: string[] = [];
  for (const field of ['type', 'code', 'name', 'decline_code']) {
    const value = (source as Record<string, unknown>)[field];
    // An identifier-shaped value only: a code, never a sentence that might
    // carry an address, an amount or an echoed key.
    if (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
      parts.push(`${field}=${value}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'no error code';
}

/**
 * What an HTTP status means about whether the provider did the work.
 *
 * `uncertainStatuses` lets a provider name the codes it documents as ambiguous
 * — Stripe's 409 is "another request with this key is in flight", which says
 * nothing about whether the first one landed.
 */
export function classify(
  status: number,
  body: unknown,
  uncertainStatuses: readonly number[] = [],
): ProviderAnswer {
  if (status >= 200 && status < 300) {
    return { kind: 'OK', status, body: (body ?? {}) as Record<string, unknown> };
  }
  if (status >= 500 || uncertainStatuses.includes(status)) {
    return {
      kind: 'UNKNOWN',
      reason: `the provider answered ${status} (${safeCode(body)}), which does not say whether it acted`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'REFUSED',
      status,
      category: 'NOT_AUTHORIZED',
      retryable: false,
      detail: `the provider refused the credential (${status}, ${safeCode(body)})`,
    };
  }
  if (status === 429) {
    return {
      kind: 'REFUSED',
      status,
      category: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
      detail: `the provider rate-limited the request (429, ${safeCode(body)}); nothing was processed`,
    };
  }
  return {
    kind: 'REFUSED',
    status,
    category: status === 400 || status === 422 ? 'INVALID_INPUT' : 'PROVIDER_REJECTED',
    retryable: false,
    detail: `the provider refused the request (${status}, ${safeCode(body)})`,
  };
}

export async function providerRequest(input: {
  fetch: FetchLike;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  uncertainStatuses?: readonly number[];
}): Promise<ProviderAnswer> {
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: 'error',
      signal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    // The request may have arrived. The error's own name is safe to keep;
    // its message is dropped in case a runtime ever puts the request in it.
    const name = error instanceof Error ? error.name : 'Error';
    return {
      kind: 'UNKNOWN',
      reason:
        name === 'TimeoutError' || name === 'AbortError'
          ? 'no answer before the timeout'
          : `the connection failed (${name})`,
    };
  }
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    // A 2xx whose body cannot be read is a request the provider accepted and
    // an answer we lost: the lost-response case, and therefore not a success.
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'UNKNOWN', reason: 'the provider accepted the request and its answer was unreadable' };
    }
  }
  return classify(response.status, body, input.uncertainStatuses);
}
