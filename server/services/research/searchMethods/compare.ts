/**
 * Compare two or more methods for one subject on the same data.
 *
 * The caller supplies the item set and what each method surfaced, confirmed
 * and rejected from it, so every method is judged on identical items. A method
 * that reports something outside the shared set is refused rather than
 * counted. The result is ranked by precision, never by volume.
 */
import { getSearchMethod } from '../../../repos/searchMethods.ts';
import type { SearchReader } from '../../../domain/searchIntelligence.ts';
import { rankByPrecision, type MethodMetrics } from './metrics.ts';

export interface MethodResult {
  surfaced: readonly string[];
  confirmed: readonly string[];
  rejected: readonly string[];
}

export interface MethodComparison {
  subjectId: string;
  items: number;
  ranking: { methodId: string; metrics: MethodMetrics }[];
  /** The one-line reason the first outranks the second. */
  decidedBy: string;
}

export type CompareResult = { ok: true; comparison: MethodComparison } | { ok: false; reason: string };

export async function compareMethods(
  reader: SearchReader,
  input: { subjectId: string; items: readonly string[]; results: Readonly<Record<string, MethodResult>> },
): Promise<CompareResult> {
  const ids = Object.keys(input.results);
  if (ids.length < 2) return { ok: false, reason: 'A comparison needs at least two methods.' };
  const items = new Set(input.items);
  if (items.size === 0) return { ok: false, reason: 'A comparison needs the shared data it was run on.' };
  for (const id of ids) {
    const method = await getSearchMethod(reader, id);
    if (!method) return { ok: false, reason: 'A compared method was not found.' };
    if (method.subjectId !== input.subjectId) {
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
  return {
    ok: true,
    comparison: {
      subjectId: input.subjectId,
      items: items.size,
      ranking: ranked.map((x) => ({ methodId: x.id, metrics: x.metrics })),
      decidedBy,
    },
  };
}
