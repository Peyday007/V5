/**
 * Reading and writing a fragment's dependencies, in both shapes.
 *
 * The column is TEXT holding JSON and it is not migrated. Rows written before
 * typed dependencies existed hold `["trigger"]`; rows written after hold
 * `[{"key":"trigger","kind":"CONDITIONAL"}]`. Both parse here, and a bare
 * string reads as `HARD`.
 *
 * That default is the conservative one and it is deliberate. Every dependency
 * the Brain has ever stored was written by a planner that meant "this blocks",
 * because blocking was the only thing a dependency could do. Backfilling them
 * to `CONDITIONAL` would have rewritten history to say something no planner
 * decided, and would have quietly unblocked work somebody's evidence bar was
 * relying on.
 */
import { DEPENDENCY_KINDS, type DependencyKind, type FragmentDependency } from './types.ts';

function isKind(value: unknown): value is DependencyKind {
  return typeof value === 'string' && (DEPENDENCY_KINDS as readonly string[]).includes(value);
}

/** One entry, from either shape. Anything unrecognisable is dropped rather than guessed at. */
function parseOne(entry: unknown): FragmentDependency | null {
  if (typeof entry === 'string') {
    const key = entry.trim();
    return key ? { key, kind: 'HARD' } : null;
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const key = typeof record['key'] === 'string' ? record['key'].trim() : '';
  if (!key) return null;
  return { key, kind: isKind(record['kind']) ? record['kind'] : 'HARD' };
}

export function parseDependencies(value: unknown): FragmentDependency[] {
  const raw = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];
  const out: FragmentDependency[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = parseOne(entry);
    // A key named twice is one dependency. The stronger kind wins: a fragment
    // declared both HARD and SEQUENCING on the same key is blocked by it.
    if (!parsed) continue;
    const existing = out.find((candidate) => candidate.key === parsed.key);
    if (existing) {
      if (rank(parsed.kind) > rank(existing.kind)) existing.kind = parsed.kind;
      continue;
    }
    if (seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    out.push(parsed);
  }
  return out;
}

function rank(kind: DependencyKind): number {
  return kind === 'HARD' ? 2 : kind === 'CONDITIONAL' ? 1 : 0;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/** Always written in the typed shape, so what is stored says what was meant. */
export function serializeDependencies(dependencies: FragmentDependency[]): string {
  return JSON.stringify(dependencies.map(({ key, kind }) => ({ key, kind })));
}

/** Accepts what a caller has, whichever shape it is in. */
export function toDependencies(
  value: readonly (string | FragmentDependency)[] | undefined | null,
): FragmentDependency[] {
  return parseDependencies(value ?? []);
}

/** The keys only, for the callers that just need to know what is named. */
export function dependencyKeys(dependencies: FragmentDependency[]): string[] {
  return dependencies.map((dependency) => dependency.key);
}

/** The keys that actually block: everything else may proceed alongside. */
export function blockingKeys(dependencies: FragmentDependency[]): string[] {
  return dependencies.filter((d) => d.kind === 'HARD').map((d) => d.key);
}

/** The keys whose outcome the dependent must carry as a stated condition. */
export function conditionalKeys(dependencies: FragmentDependency[]): string[] {
  return dependencies.filter((d) => d.kind === 'CONDITIONAL').map((d) => d.key);
}
