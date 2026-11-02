/**
 * Which openings a live goal's latest plan reading judged too small to matter.
 *
 * The goal's own research (`pathResearch.ts`) already skips an opening whose
 * most, with every buyer agreeing, is under a tenth of what the goal still
 * needs. Every other research spender — the card-gap questions, the deep dive,
 * the withdrawal pass — read `notWorthResearching` instead, which did not know
 * it. Production, 2026-11-02: the plan said "the Air Jordan resale: too small to
 * matter — at most 205 of 10000" while a fresh fragment asked what comparable
 * resales are published at. The reading is the owner of the judgement; this
 * only carries it to the screen, in memory, refreshed on every plan read.
 */
export const MIN_SHARE_WORTH_RESEARCHING = 0.1;

interface Judgement {
  goalId: string;
  potential: number;
  floor: number;
  at: number;
}

const byOpportunity = new Map<string, Map<string, Judgement>>();
/** A reading older than this no longer speaks for the goal (the tick re-reads every half hour). */
const STALE_MS = 3 * 60 * 60 * 1000;

/** Record one goal's judgement of every opening it considered. */
export function recordMateriality(goalId: string, remainingMajor: number, considered: ReadonlyArray<{ opportunityId: string; supportedReach: number; potentialReach: number | null }>, at = Date.now()): void {
  const floor = remainingMajor * MIN_SHARE_WORTH_RESEARCHING;
  for (const one of considered) {
    // No price at all says nothing about size: asking what buyers pay is how it gets one.
    if (one.potentialReach === null) {
      byOpportunity.get(one.opportunityId)?.delete(goalId);
      continue;
    }
    const potential = Math.max(one.supportedReach, one.potentialReach);
    if (!byOpportunity.has(one.opportunityId)) byOpportunity.set(one.opportunityId, new Map());
    byOpportunity.get(one.opportunityId)!.set(goalId, { goalId, potential, floor, at });
  }
}

/**
 * The opening is too small for every goal that judged it, recently, and at
 * least one did. Null when any goal could still use it or none has read it.
 */
export function tooSmallForGoals(opportunityId: string, now = Date.now()): { potential: number; floor: number } | null {
  const judged = [...(byOpportunity.get(opportunityId)?.values() ?? [])].filter((one) => now - one.at <= STALE_MS);
  if (judged.length === 0) return null;
  if (judged.some((one) => one.potential >= one.floor)) return null;
  const largest = judged.reduce((a, b) => (b.potential > a.potential ? b : a));
  return { potential: largest.potential, floor: largest.floor };
}

/** For tests. */
export function clearMateriality(): void {
  byOpportunity.clear();
}
