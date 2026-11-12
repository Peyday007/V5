/**
 * Compare two or more methods for one subject on the same data.
 *
 * The caller supplies the item set and what each method surfaced, confirmed
 * and rejected from it, so every method is judged on identical items. A method
 * that reports something outside the shared set is refused rather than
 * counted. The result is ranked by precision, never by volume.
 *
 * A comparison that is accepted is recorded — `search_method_comparisons` with
 * one `search_method_comparison_entries` row per method carrying its rank and
 * metrics on the shared data — so a later decision reads which method
 * outranked which and why, rather than a printout nobody kept. A refused
 * comparison writes nothing.
 *
 * Where it is recorded: the scope the caller names, or else the narrowest one
 * the reader holds — its one project, else its user, else GENERAL. A GENERAL
 * comparison is refused if the shared data it names holds anything private.
 */
import { getLearnedSubject, getSearchMethod, listMethodComparisons, recordMethodComparison } from '../../../repos/searchMethods.ts';
import { scopeProblem, type ScopeRef, type SearchReader } from '../../../domain/searchIntelligence.ts';
import { PrivateDataRefused } from '../../knowledge/scope/privacy.ts';
import { rankByPrecision, type MethodMetrics } from './metrics.ts';

export interface MethodResult {
  surfaced: readonly string[];
  confirmed: readonly string[];
  rejected: readonly string[];
}

export interface MethodComparison {
  /** The stored comparison's id. */
  id: string;
  createdAt: string;
  scope: ScopeRef;
  subjectId: string;
  items: number;
  ranking: { methodId: string; metrics: MethodMetrics }[];
  /** The one-line reason the first outranks the second. */
  decidedBy: string;
}

export type CompareResult = { ok: true; comparison: MethodComparison } | { ok: false; reason: string };

/** The narrowest scope the reader holds: its one project, else its user, else GENERAL. */
export function comparisonScopeFor(reader: SearchReader): ScopeRef {
  if (reader.projectIds.length === 1) return { scope: 'PROJECT', projectId: reader.projectIds[0]! };
  if (reader.userId) return { scope: 'USER', userId: reader.userId };
  return { scope: 'GENERAL' };
}

/** The learned subject's key when the id names one the reader can see; otherwise null. */
async function subjectKeyOf(reader: SearchReader, subjectId: string | null): Promise<string | null> {
  if (!subjectId) return null;
  return (await getLearnedSubject(reader, subjectId))?.subjectKey ?? null;
}

/** Whether a method stated for `methodSubject` is for the subject the caller named. */
export async function sameSubject(reader: SearchReader, methodSubject: string | null, requested: string): Promise<boolean> {
  if (!methodSubject) return false;
  if (methodSubject === requested) return true;
  const [a, b] = await Promise.all([subjectKeyOf(reader, methodSubject), subjectKeyOf(reader, requested)]);
  return a !== null && a === b;
}

export async function compareMethods(
  reader: SearchReader,
  input: {
    subjectId: string;
    items: readonly string[];
    results: Readonly<Record<string, MethodResult>>;
    /** Where to record it; defaults to `comparisonScopeFor(reader)`. */
    scope?: ScopeRef;
  },
): Promise<CompareResult> {
  const scope = input.scope ?? comparisonScopeFor(reader);
  const scopeRefusal = scopeProblem(scope);
  if (scopeRefusal) return { ok: false, reason: scopeRefusal };
  if (scope.scope === 'PROJECT' && !reader.projectIds.includes(scope.projectId ?? '')) {
    return { ok: false, reason: 'A comparison can be recorded only in a project the reader holds.' };
  }
  if (scope.scope === 'USER' && reader.userId !== (scope.userId ?? null)) {
    return { ok: false, reason: 'A comparison can be recorded only for the reader\'s own user.' };
  }
  const ids = Object.keys(input.results);
  if (ids.length < 2) return { ok: false, reason: 'A comparison needs at least two methods.' };
  const items = new Set(input.items);
  if (items.size === 0) return { ok: false, reason: 'A comparison needs the shared data it was run on.' };
  for (const id of ids) {
    const method = await getSearchMethod(reader, id);
    if (!method) return { ok: false, reason: 'A compared method was not found.' };
    if (!(await sameSubject(reader, method.subjectId, input.subjectId))) {
      return { ok: false, reason: 'Every compared method must be for the same subject.' };
    }
    const r = input.results[id]!;
    const surfaced = new Set(r.surfaced);
    for (const x of [...r.surfaced, ...r.confirmed, ...r.rejected]) {
      if (!items.has(x)) return { ok: false, reason: 'A method reported an item that is not in the shared data.' };
    }
    for (const x of [...r.confirmed, ...r.rejected]) {
      if (!surfaced.has(x)) return { ok: false, reason: 'A result was judged that the method never surfaced.' };
    }
    if (r.confirmed.some((x) => r.rejected.includes(x))) {
      return { ok: false, reason: 'An item cannot be both confirmed and rejected.' };
    }
  }
  const ranked = rankByPrecision(
    ids.map((id) => {
      const r = input.results[id]!;
      const confirmed = new Set(r.confirmed).size;
      const rejected = new Set(r.rejected).size;
      const verified = confirmed + rejected;
      return {
        id,
        metrics: {
          runs: 1, examined: items.size, surfaced: new Set(r.surfaced).size, confirmed, rejected, verified,
          precision: verified > 0 ? confirmed / verified : null, outcomes: {},
        } satisfies MethodMetrics,
      };
    }),
  );
  const [a, b] = ranked;
  const decidedBy =
    a!.metrics.precision === null
      ? 'Nothing was verified, so no method outranks another.'
      : b!.metrics.precision === null
        ? 'The first has a measured precision and the second has none.'
        : a!.metrics.precision !== b!.metrics.precision
          ? `Precision ${a!.metrics.precision.toFixed(2)} against ${b!.metrics.precision.toFixed(2)}; volume was not considered.`
          : 'Equal precision; the one with more verified results ranks first.';
  let stored;
  try {
    stored = await recordMethodComparison({
      ...scope,
      subjectId: input.subjectId,
      itemRefs: [...items],
      decidedBy,
      entries: ranked.map((x) => ({
        methodId: x.id,
        examined: x.metrics.examined,
        surfaced: x.metrics.surfaced,
        confirmed: x.metrics.confirmed,
        rejected: x.metrics.rejected,
        verified: x.metrics.verified,
        precision: x.metrics.precision,
      })),
    });
  } catch (err) {
    if (err instanceof PrivateDataRefused) return { ok: false, reason: err.message };
    throw err;
  }
  return {
    ok: true,
    comparison: {
      id: stored.id,
      createdAt: stored.createdAt,
      scope: { scope: stored.scope, projectId: stored.projectId, userId: stored.userId },
      subjectId: input.subjectId,
      items: items.size,
      ranking: ranked.map((x) => ({ methodId: x.id, metrics: x.metrics })),
      decidedBy,
    },
  };
}

/** What one method filed from the shared data: the items it surfaced, and which of them were confirmed or rejected. */
export interface SubjectMethodYield {
  methodId: string;
  surfaced: readonly string[];
  confirmed: readonly string[];
  rejected: readonly string[];
}

/**
 * Compare, without anybody asking, every method for one subject on the data
 * they share — called whenever a run of a subject's method is recorded.
 *
 * The shared data is the union of what the methods surfaced, so each is judged
 * on the same items: what it confirmed and rejected among them, ranked by
 * precision. Nothing is recorded unless at least two methods for the subject
 * have surfaced something, or when the latest comparison for the subject in
 * this scope already covered exactly these items and methods — a tick that
 * learned nothing new writes nothing.
 */
export async function autoCompareSubject(
  reader: SearchReader,
  input: { subjectId: string; scope: ScopeRef; yields: readonly SubjectMethodYield[] },
): Promise<CompareResult | null> {
  const live = input.yields.filter((y) => y.surfaced.length > 0);
  if (new Set(live.map((y) => y.methodId)).size < 2) return null;
  const items = [...new Set(live.flatMap((y) => y.surfaced))].sort();
  const results: Record<string, MethodResult> = {};
  for (const y of live) {
    const surfaced = new Set(y.surfaced);
    results[y.methodId] = {
      surfaced: [...surfaced],
      confirmed: [...new Set(y.confirmed)].filter((x) => surfaced.has(x)),
      rejected: [...new Set(y.rejected)].filter((x) => surfaced.has(x) && !y.confirmed.includes(x)),
    };
  }
  const methodIds = Object.keys(results).sort();
  const [latest] = await listMethodComparisons(reader, { subjectId: input.subjectId, limit: 1 });
  if (
    latest &&
    latest.scope === input.scope.scope &&
    (latest.projectId ?? null) === (input.scope.projectId ?? null) &&
    [...latest.itemRefs].sort().join('\n') === items.join('\n') &&
    latest.entries.map((e) => e.methodId).sort().join('\n') === methodIds.join('\n')
  ) {
    return null;
  }
  return compareMethods(reader, { subjectId: input.subjectId, items, results, scope: input.scope });
}
