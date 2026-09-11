import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toBool(value: number | null | undefined): boolean {
  return value === 1;
}

export function fromBool(value: boolean | undefined): number {
  return value ? 1 : 0;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Slugify a layer or project name into a stable filesystem/URL-safe key. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

/**
 * Build `SET a = ?, b = ?` from a patch object, skipping undefined values so
 * partial updates never clobber columns the caller did not mention.
 */
export function buildUpdate(
  patch: Record<string, unknown>,
): { clause: string; values: unknown[] } {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  return {
    clause: keys.map((k) => `${k} = ?`).join(', '),
    values: keys.map((k) => patch[k]),
  };
}

/**
 * The earlier of a computed retry point and a bound, with a floor under both.
 *
 * Timestamps here are ISO-8601 UTC strings, so string order is time order and
 * the comparison needs no parsing — the same property `external_records`
 * normalises its source versions for.
 *
 * `bound` may be null, which means the caller has no opinion and the computed
 * value is the answer unchanged. When it is present the result is never later
 * than it, so a refusal cannot be honoured past the moment it can stop being
 * true; and never earlier than `floor`, so a bound already in the past cannot
 * turn a backoff into a per-tick retry.
 */
export function retryAtWithin(computed: string, bound: string | null, floor: string): string {
  const chosen = bound !== null && bound < computed ? bound : computed;
  return chosen < floor ? floor : chosen;
}
