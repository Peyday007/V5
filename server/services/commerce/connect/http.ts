/**
 * The one network door the commerce connections use (§74).
 *
 * `providerRequest` already classifies an answer the way the effects engine
 * needs — a timeout or a 5xx is UNKNOWN, never a failure — so this module only
 * holds which `fetch` to use. Tests replace it with a fake provider; nothing
 * else does.
 */
import { providerRequest, type FetchLike, type ProviderAnswer } from '../../cash/providers/http.ts';

let current: FetchLike = (url, init) => fetch(url, init);

export function commerceFetch(): FetchLike {
  return current;
}

/** Tests only: route every commerce call to a fake provider. */
export function setCommerceFetch(next: FetchLike | null): void {
  current = next ?? ((url, init) => fetch(url, init));
}

export async function request(input: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}): Promise<ProviderAnswer> {
  return await providerRequest({ fetch: current, ...input });
}

export type { ProviderAnswer };
