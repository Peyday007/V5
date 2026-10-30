/**
 * The trust lifecycle of a search method.
 *
 * PROPOSED -> TESTING -> PROVEN, and DEMOTED / RETIRED. Trust moves only on
 * recorded verified results (confirmed or rejected), never on volume and never
 * because somebody said so: a PROPOSED method has no route to PROVEN that
 * skips TESTING, and every move is a compare-and-swap on the state read.
 */
import {
  getSearchMethod,
  listMethodRuns,
  listSearchMethods,
  recordMethodRun,
  setMethodTrust,
} from '../../../repos/searchMethods.ts';
import type {
  MethodTrustState,
  RunExecutor,
  RunOutcome,
  SearchMethod,
  SearchMethodRun,
  SearchReader,
} from '../../../domain/searchIntelligence.ts';
import { methodMetrics } from './metrics.ts';

/** Verified results needed before a method can be called proven or demoted. */
export const MIN_VERIFIED_FOR_TRUST = 10;
export const PROVEN_PRECISION = 0.7;
export const DEMOTE_PRECISION = 0.5;

/** The only moves there are. Anything else is refused. */
const ALLOWED: Record<MethodTrustState, readonly MethodTrustState[]> = {
  PROPOSED: ['TESTING', 'RETIRED'],
  TESTING: ['PROVEN', 'DEMOTED', 'RETIRED'],
  PROVEN: ['DEMOTED', 'RETIRED'],
  DEMOTED: ['TESTING', 'RETIRED'],
  RETIRED: [],
};

export function mayMove(from: MethodTrustState, to: MethodTrustState): boolean {
  return ALLOWED[from].includes(to);
}

/** The state the recorded runs support, or null when they support no move. Pure. */
export function trustSupportedBy(
  state: MethodTrustState,
  runs: readonly SearchMethodRun[],
): { to: MethodTrustState; reason: string } | null {
  const m = methodMetrics(runs);
  if (state === 'PROPOSED') {
    return m.verified > 0
      ? { to: 'TESTING', reason: `${m.verified} verified result(s) recorded` }
      : null;
  }
  if (m.verified < MIN_VERIFIED_FOR_TRUST || m.precision === null) return null;
  if (state === 'TESTING' && m.precision >= PROVEN_PRECISION) {
    return { to: 'PROVEN', reason: `precision ${m.precision.toFixed(2)} over ${m.verified} verified results` };
  }
  if ((state === 'TESTING' || state === 'PROVEN') && m.precision < DEMOTE_PRECISION) {
    return { to: 'DEMOTED', reason: `precision ${m.precision.toFixed(2)} over ${m.verified} verified results` };
  }
  if (state === 'DEMOTED' && m.precision >= PROVEN_PRECISION) {
    return { to: 'TESTING', reason: `precision recovered to ${m.precision.toFixed(2)} over ${m.verified} verified results` };
  }
  return null;
}

/** Move a method's trust if its runs support a move. Returns the state it now holds. */
export async function settleTrust(reader: SearchReader, methodId: string): Promise<SearchMethod | null> {
  const method = await getSearchMethod(reader, methodId);
  if (!method) return null;
  const supported = trustSupportedBy(method.trustState, await listMethodRuns(reader, methodId));
  if (supported && mayMove(method.trustState, supported.to)) {
    await setMethodTrust(methodId, method.trustState, supported.to, supported.reason);
    return getSearchMethod(reader, methodId);
  }
  return method;
}

/**
 * Record a run, then let it move trust if it earned that. The method must be
 * visible to the reader: a run against somebody else's private method is
 * refused as not found.
 */
export async function recordRunAndSettle(
  reader: SearchReader,
  input: {
    methodId: string;
    executor: RunExecutor;
    outcome: RunOutcome;
    failureCause?: string | null;
    examined?: number;
    surfaced?: number;
    confirmed?: number;
    rejected?: number;
  },
): Promise<{ run: SearchMethodRun; method: SearchMethod } | null> {
  if (!(await getSearchMethod(reader, input.methodId))) return null;
  const run = await recordMethodRun(input);
  const method = (await settleTrust(reader, input.methodId))!;
  return { run, method };
}

/** Retire a method. A person's or caller's decision, so it is the one move not read from runs. */
export async function retireMethod(reader: SearchReader, methodId: string, reason: string): Promise<boolean> {
  const method = await getSearchMethod(reader, methodId);
  if (!method || !mayMove(method.trustState, 'RETIRED')) return false;
  return setMethodTrust(methodId, method.trustState, 'RETIRED', reason);
}

/**
 * Methods that may be called proven. A method reads as proven only if its
 * stored state is PROVEN *and* its recorded runs still support it, so a state
 * written some other way cannot make a method look earned.
 */
export async function provenMethods(reader: SearchReader): Promise<SearchMethod[]> {
  const out: SearchMethod[] = [];
  for (const method of await listSearchMethods(reader, { trustState: 'PROVEN' })) {
    const m = methodMetrics(await listMethodRuns(reader, method.id));
    if (m.verified >= MIN_VERIFIED_FOR_TRUST && m.precision !== null && m.precision >= DEMOTE_PRECISION) out.push(method);
  }
  return out;
}
