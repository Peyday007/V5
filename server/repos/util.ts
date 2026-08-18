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
