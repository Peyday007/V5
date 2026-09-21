/**
 * Which verdict a reader wants to see first.
 *
 * Its own module rather than a constant inside one of its readers, because it
 * has two — the surface, which sorts the ladder with it, and `priority.ts`,
 * which reads it as the strongest of its factors. §27's `negation.ts` is the
 * precedent and the reason: a rule kept inside one of its two callers is a
 * cycle waiting to be found by whichever file loads first, and the fix costs a
 * file.
 *
 * A `Record` over the whole union rather than an array, so a verdict added
 * later is a compile error until somebody says where it ranks. An array would
 * have let `indexOf` return `-1` and sort an unnamed verdict silently to the
 * top — §27 records what two collections that must be total between them cost,
 * and this is the same shape at a sort.
 *
 * It decides no evidence and no verdict: `readiness.ts` derives those from
 * rows, and this says only which order to read them in.
 */
import type { EntryVerdict } from './readiness.ts';

export const VERDICT_ORDER: Readonly<Record<EntryVerdict, number>> = Object.freeze({
  ENTER: 0,
  // Directly under ENTER, because it is one question away from it and every
  // other verdict below is a capability, a route or a buyer away.
  COST_UNKNOWN: 1,
  BUILD_CAPABILITY_FIRST: 2,
  NO_ROUTE_FOUND: 3,
  INVESTIGATING: 4,
  UNEXAMINED: 5,
  NO_DEMAND_FOUND: 6,
  RETIRED: 7,
});
