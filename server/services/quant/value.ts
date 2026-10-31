/**
 * Which unknown is worth learning: the value of information, measured.
 *
 * Given paired samples — each input's value and each action's score in the
 * same simulated world — the expected value of perfect information about one
 * input (EVPPI) is how much better the best action would be on average if that
 * input were known before choosing, compared with choosing now:
 *
 *     Σ_bins  P(bin) · max_a E[score_a | bin]   −   max_a E[score_a]
 *
 * estimated by sorting the worlds into quantile bins of that input. It is zero
 * exactly when the same action is best in every bin — the input cannot change
 * the decision, so researching it is spending to learn nothing actionable
 * (§79: abandon a question whose answer would not change the decision).
 *
 * Over a SWEEP the "expectation" is over tested conditions, not a probability,
 * and the caller must say so; the ranking of which input matters most is still
 * meaningful, which is what it is used for.
 */

export interface InformationInput {
  key: string;
  values: ArrayLike<number>;
}

export interface InformationAction {
  key: string;
  scores: ArrayLike<number>;
}

export interface InputValue {
  key: string;
  /** Expected gain in score from knowing this input before choosing. */
  value: number;
  /** True when the best action differs between bins of this input. */
  changesDecision: boolean;
  /** The best action in each bin, low values first. */
  bestByBin: string[];
}

export interface InformationValue {
  baseline: { action: string; expected: number };
  /** With every input known at once — the ceiling on what research could buy. */
  perfect: number;
  inputs: InputValue[];
  worlds: number;
}

export const INFORMATION_BINS = 10;
/** Gains smaller than this share of the score's range are read as no gain. */
export const NEGLIGIBLE_SHARE = 1e-6;
/** A bin switches action only when the paired gain clears this many standard errors. */
export const SIGNIFICANCE = 2;

export function informationValue(input: { inputs: InformationInput[]; actions: InformationAction[]; bins?: number }): InformationValue {
  const actions = input.actions;
  if (actions.length === 0) throw new Error('Information value needs at least one action.');
  const n = actions[0]!.scores.length;
  const bins = Math.max(2, Math.min(input.bins ?? INFORMATION_BINS, n));
  const mean = (scores: ArrayLike<number>, idx: ArrayLike<number> | null) => {
    let sum = 0;
    const count = idx ? idx.length : n;
    for (let i = 0; i < count; i++) sum += scores[idx ? idx[i]! : i]!;
    return count === 0 ? 0 : sum / count;
  };
  const expected = actions.map((one) => mean(one.scores, null));
  let best = 0;
  for (let a = 1; a < actions.length; a++) if (expected[a]! > expected[best]!) best = a;
  const baseline = expected[best]!;
  let perfect = 0;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (const one of actions) {
      const s = one.scores[i]!;
      if (s > m) m = s;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    perfect += m;
  }
  perfect = perfect / n - baseline;
  const negligible = Math.max(1e-12, (hi - lo) * NEGLIGIBLE_SHARE);

  const out: InputValue[] = [];
  for (const variable of input.inputs) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => variable.values[a]! - variable.values[b]!);
    let gain = 0;
    const bestByBin: string[] = [];
    for (let b = 0; b < bins; b++) {
      const from = Math.floor((b * n) / bins);
      const to = Math.floor(((b + 1) * n) / bins);
      const idx = order.slice(from, to);
      if (idx.length === 0) continue;
      // Switch from the baseline only where the gain is real: a paired mean
      // difference more than two standard errors above zero. Taking the
      // largest bin mean outright rewards noise — every bin "finds" a better
      // action by chance, and an irrelevant input reads as worth knowing.
      const baseScores = actions[best]!.scores;
      let top = mean(baseScores, idx);
      let topAction = best;
      let topGain = 0;
      actions.forEach((one, a) => {
        if (a === best) return;
        let sum = 0;
        let sq = 0;
        for (const i of idx) {
          const d = one.scores[i]! - baseScores[i]!;
          sum += d;
          sq += d * d;
        }
        const m = sum / idx.length;
        const variance = Math.max(0, sq / idx.length - m * m);
        const se = Math.sqrt(variance / Math.max(1, idx.length - 1));
        if (m > topGain && m > SIGNIFICANCE * se) {
          topGain = m;
          topAction = a;
        }
      });
      top += topGain;
      gain += (idx.length / n) * top;
      bestByBin.push(actions[topAction]!.key);
    }
    const value = Math.max(0, gain - baseline);
    out.push({ key: variable.key, value: value <= negligible ? 0 : value, changesDecision: new Set(bestByBin).size > 1 && value > negligible, bestByBin });
  }
  out.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  return { baseline: { action: actions[best]!.key, expected: baseline }, perfect: Math.max(0, perfect), inputs: out, worlds: n };
}
