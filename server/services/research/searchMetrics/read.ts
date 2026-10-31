/**
 * Per-method metrics from rows, for any target: cash buckets, feeds, or a
 * method Brain learned for something that is not cash at all. Reads only what
 * the reader's scope may see.
 */
import { listMethodRuns, listSearchMethods } from '../../../repos/searchMethods.ts';
import type { SearchReader, SearchMethod } from '../../../domain/searchIntelligence.ts';
import { computeMethodMetrics, trustInput, type MethodMetrics, type MethodTrustInput } from './compute.ts';

export interface MethodReading {
  method: SearchMethod;
  metrics: MethodMetrics;
  trust: MethodTrustInput;
}

/**
 * `downstream` maps a method key to outcomes known elsewhere (for cash, the
 * bucket's useful and qualified counts from discoveryYield). A method absent
 * from it has no downstream reading, which is null, not zero.
 */
export async function readMethodMetrics(
  reader: SearchReader,
  opts: { downstream?: ReadonlyMap<string, { useful: number; qualified: number; duplicates?: number }> } = {},
): Promise<MethodReading[]> {
  const out: MethodReading[] = [];
  for (const method of await listSearchMethods(reader)) {
    const runs = await listMethodRuns(reader, method.id);
    const known = opts.downstream?.get(method.methodKey);
    const metrics = computeMethodMetrics(method.id, runs, {
      duplicates: known?.duplicates ?? null,
      downstream: known ? { useful: known.useful, qualified: known.qualified } : null,
    });
    out.push({ method, metrics, trust: trustInput(metrics) });
  }
  return out;
}
