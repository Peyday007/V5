/**
 * Selective deepening (KNOW-25-1, S-0358): from many cheap candidate
 * relationships, choose the few worth an LLM read or a costly verification.
 *
 * Cheap algorithms (the feed screen, `extract.ts`'s deterministic extractors)
 * may find a million candidate links. Promoting all of them spends the scarce
 * lane on routine work; promoting by a keyword list makes a category a
 * whitelist (R01-A1, §18.1). Neither happens here. Each candidate is judged on
 * numbers only:
 *
 *   expected value of information = decision value at stake × effective uncertainty
 *   score                         = EVI × (1 + novelty)
 *
 * where a recorded contradiction raises effective uncertainty (two sources
 * disagree, so what is believed is less settled than either says). A candidate
 * is *eligible* only when its score exceeds the cost of deepening it: a
 * routine, certain or low-value link is never worth the read, however many of
 * them there are. Among eligible candidates the threshold is derived from the
 * score distribution and the measured available capacity: the lowest score
 * that still fits within capacity. More capacity lowers it, less raises it.
 *
 * Wording never enters: a candidate's text is carried for the caller's record
 * and is not read. Candidates with identical numbers get identical decisions —
 * a tie that does not fit entirely within capacity is held together rather than
 * split by order or by text.
 *
 * Pure. The caller records each returned judgment (with its reasons) on the
 * row it already owns; this module has no store, no scheduler and no queue
 * (§10.3, §20.4).
 */

export interface DeepeningCandidate {
  /** The caller's identifier for the candidate (a feed item, a fact, a link). */
  id: string;
  /** Economic value of the decision this candidate could change, in the caller's unit (e.g. dollars). */
  decisionValue: number;
  /** 0..1: how unsettled the candidate's truth is given the cheap evidence. */
  uncertainty: number;
  /** 0..1: how far from what Brain has already understood (0 = routine, 1 = wholly new). */
  novelty: number;
  /** Whether a contradiction with other evidence is recorded against it. */
  contradicted?: boolean;
  /** Free text. Carried for the caller's record; never read by the decision. */
  statement?: string;
}

export interface DeepeningOptions {
  /** Measured available capacity: how many deepening reads can be afforded now. */
  capacity: number;
  /** Cost of one deepening read, in the same unit as `decisionValue`. Defaults to 0. */
  costPerDeepening?: number;
}

export interface DeepeningDecision {
  id: string;
  promote: boolean;
  score: number;
  expectedValueOfInformation: number;
  reasons: string[];
}

export interface DeepeningResult {
  decisions: DeepeningDecision[];
  /** The score a candidate had to reach to be promoted; null when nothing could be. */
  threshold: number | null;
  capacity: number;
  eligible: number;
  promoted: number;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const round = (n: number): number => Math.round(n * 1e9) / 1e9;

/** A recorded contradiction halves the remaining certainty. */
export function effectiveUncertainty(c: Pick<DeepeningCandidate, 'uncertainty' | 'contradicted'>): number {
  const u = clamp01(c.uncertainty);
  return c.contradicted ? 1 - (1 - u) * 0.5 : u;
}

export function scoreCandidate(c: DeepeningCandidate): { evi: number; score: number } {
  const evi = round(nonNeg(c.decisionValue) * effectiveUncertainty(c));
  return { evi, score: round(evi * (1 + clamp01(c.novelty))) };
}

export function selectForDeepening(candidates: readonly DeepeningCandidate[], options: DeepeningOptions): DeepeningResult {
  const capacity = Math.max(0, Math.trunc(Number.isFinite(options.capacity) ? options.capacity : 0));
  const cost = nonNeg(options.costPerDeepening ?? 0);
  const scored = candidates.map((c) => ({ c, ...scoreCandidate(c) }));

  const eligibleScores = scored.filter((s) => s.score > cost).map((s) => s.score).sort((a, b) => b - a);
  // The lowest score whose whole tie group still fits within capacity.
  let threshold: number | null = null;
  if (capacity > 0) {
    let i = 0;
    while (i < eligibleScores.length) {
      const s = eligibleScores[i]!;
      let j = i;
      while (j < eligibleScores.length && eligibleScores[j] === s) j += 1;
      if (j > capacity) break;
      threshold = s;
      i = j;
    }
  }

  const decisions = scored.map(({ c, evi, score }): DeepeningDecision => {
    const reasons = [
      `expected value of information ${evi} = decision value ${nonNeg(c.decisionValue)} × effective uncertainty ${round(effectiveUncertainty(c))}${c.contradicted ? ' (raised by a recorded contradiction)' : ''}`,
      `score ${score} = EVI × (1 + novelty ${clamp01(c.novelty)})`,
    ];
    let promote = false;
    if (score <= cost) reasons.push(`held: score ${score} does not exceed the cost of deepening ${cost} (routine, certain or low-value)`);
    else if (capacity === 0) reasons.push('held: no deepening capacity is available now');
    else if (threshold === null || score < threshold)
      reasons.push(
        threshold === null
          ? `held: the highest-value tie group exceeds capacity ${capacity}`
          : `held: score ${score} is below the capacity-derived threshold ${threshold} (capacity ${capacity})`,
      );
    else {
      promote = true;
      reasons.push(`promoted: score ${score} reaches the capacity-derived threshold ${threshold} (capacity ${capacity})`);
    }
    return { id: c.id, promote, score, expectedValueOfInformation: evi, reasons };
  });

  return {
    decisions,
    threshold,
    capacity,
    eligible: eligibleScores.length,
    promoted: decisions.filter((d) => d.promote).length,
  };
}
