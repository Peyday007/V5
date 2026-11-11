import type { ModelInput } from '../../cash/goalScenario.ts';
import type { ActivityVariable, ConsumedVariable } from './types.ts';
import { CONSUMED_VARIABLES } from './types.ts';

/** Why a variable cannot be trusted as stated, or null when it can. */
export function variableProblem(v: ActivityVariable): string | null {
  if (v.state === 'VERIFIED' && !v.source) return 'VERIFIED needs a source';
  if (v.state === 'ESTIMATE' && !(v.basis && v.basis.trim())) return 'ESTIMATE needs its basis stated';
  if (v.state === 'UNKNOWN' && v.value !== null) return 'UNKNOWN may not carry a single value';
  if (v.state !== 'UNKNOWN' && v.value === null && (v.low === null || v.high === null)) return `${v.state} needs a value or a range`;
  if (v.low !== null && v.high !== null && v.low > v.high) return 'range is inverted';
  return null;
}

/**
 * A variable in the shape goalScenario.ts consumes. VERIFIED is EVIDENCE,
 * ESTIMATE is ASSUMPTION (so it is only ever swept, never given a
 * distribution), UNKNOWN stays UNKNOWN. A malformed variable is UNKNOWN with
 * the reason, never trusted.
 */
export function toModelInput(v: ActivityVariable, fallbackRange: { low: number; high: number }): ModelInput {
  const problem = variableProblem(v);
  if (problem || v.state === 'UNKNOWN') {
    return { value: null, low: fallbackRange.low, high: fallbackRange.high, provenance: 'UNKNOWN', source: null, note: problem ?? 'not established' };
  }
  const low = v.low ?? v.value;
  const high = v.high ?? v.value;
  return {
    value: v.value,
    low,
    high,
    provenance: v.state === 'VERIFIED' ? 'EVIDENCE' : 'ASSUMPTION',
    source: v.source,
    note: v.state === 'ESTIMATE' ? `estimate: ${v.basis}` : `${v.operatorBasis}`,
  };
}

export type ConsumedInputs = Record<ConsumedVariable, ModelInput>;

/** All six consumed inputs for one activity; any key not stated is UNKNOWN over the fallback range. */
export function consumedInputs(
  variables: ActivityVariable[],
  fallback: Record<ConsumedVariable, { low: number; high: number }>,
): ConsumedInputs {
  const out = {} as ConsumedInputs;
  for (const key of CONSUMED_VARIABLES) {
    const v = variables.find((x) => x.key === key);
    out[key] = v ? toModelInput(v, fallback[key]) : toModelInput({ activityId: '', key, state: 'UNKNOWN', value: null, low: null, high: null, source: null, basis: null, operatorBasis: 'REPRODUCIBLE_BY_NEW_OPERATOR' }, fallback[key]);
  }
  return out;
}

/**
 * Prefer the figure for a new operator over an established one: a goal is
 * pursued by someone starting out, and an incumbent's margin is not theirs.
 */
export function forNewOperator(variables: ActivityVariable[]): ActivityVariable[] {
  const byKey = new Map<string, ActivityVariable>();
  for (const v of variables) {
    const have = byKey.get(v.key);
    if (!have || (v.operatorBasis === 'REPRODUCIBLE_BY_NEW_OPERATOR' && have.operatorBasis !== 'REPRODUCIBLE_BY_NEW_OPERATOR')) byKey.set(v.key, v);
  }
  return [...byKey.values()];
}
