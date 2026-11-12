import { analyzeDeck, type AnalysisCard, type AnalysisResult } from '../analysis/analyze.ts';
import { tagCard, type Role } from '../analysis/tags.ts';
import { OBJECTIVES, type DeckLine, type Objective, type ObjectiveScore, type Weights } from './types.ts';

export const DEFAULT_WEIGHTS: Weights = {
  consistency: 1, earlyDevelopment: 1, threatsAnswered: 1, survival: 1,
  independentClosing: 1, pointsPotential: 1, price: 1, preferenceMatch: 1,
};

export function normalizeWeights(w?: Partial<Weights>): Weights {
  const merged: Weights = { ...DEFAULT_WEIGHTS };
  for (const o of OBJECTIVES) {
    const v = w?.[o];
    if (v !== undefined && Number.isFinite(v) && v >= 0) merged[o] = v;
  }
  const sum = OBJECTIVES.reduce((s, o) => s + merged[o], 0);
  if (sum === 0) return { ...DEFAULT_WEIGHTS };
  return merged;
}

export function toAnalysisCards(deck: DeckLine[]): AnalysisCard[] {
  return deck
    .filter((l) => l.quantity > 0)
    .map((l) => ({
      name: l.card.name,
      quantity: l.quantity,
      zone: l.zone,
      typeLine: l.card.typeLine,
      manaCost: l.card.manaCost,
      cmc: l.card.cmc,
      oracleText: l.card.oracleText,
      producedMana: l.card.producedMana?.filter((c): c is 'W' | 'U' | 'B' | 'R' | 'G' => c !== 'C'),
      entersTapped: l.card.entersTapped,
    }));
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface ScoreContext {
  format: OptimizeFormat;
  opponents?: number;
  preferredRoles: Role[];
  priceCeilingCents: number | null;
}
type OptimizeFormat = 'COMMANDER' | 'STANDARD';

/** The eight objectives for one deck. Pure and deterministic: no simulation, no clock. */
export function scoreObjectives(
  deck: DeckLine[], costCents: number, ctx: ScoreContext,
): { objectives: Record<Objective, ObjectiveScore>; analysis: AnalysisResult } {
  const a = analyzeDeck({
    format: ctx.format, cards: toAnalysisCards(deck), opponents: ctx.opponents, simulationRuns: 0,
  });
  const t = (turn: number) => a.byTurn.find((x) => x.turn === turn);
  const exact = 'EXACT_PROBABILITY' as const;
  const heur = 'HEURISTIC_SCORE' as const;

  const keepable = a.openingHand.keepable.value;
  const ramp3 = t(3)?.atLeastOneRamp.value ?? 0;
  const draw4 = t(4)?.atLeastOneDraw.value ?? 0;
  const reliance = a.scores.singleCardReliance.value;
  const consistency: ObjectiveScore = {
    value: r3(mean([keepable, ramp3, draw4, reliance])),
    label: heur,
    components: [
      { name: 'keepable opening hand', value: r3(keepable), label: exact },
      { name: 'ramp by turn 3', value: r3(ramp3), label: exact },
      { name: 'card draw by turn 4', value: r3(draw4), label: exact },
      { name: 'single-card reliance', value: r3(reliance), label: heur },
    ],
    uncertainty: 'Three exact probabilities over the library, averaged with one heuristic; the average is a score, not a probability.',
  };

  const land3 = t(3)?.threeLandsAndRamp.value ?? 0;
  const land4 = t(4)?.threeLandsAndRamp.value ?? 0;
  const earlyDevelopment: ObjectiveScore = {
    value: r3(mean([land3, land4])),
    label: heur,
    components: [
      { name: 'three lands and ramp by turn 3', value: r3(land3), label: exact },
      { name: 'three lands and ramp by turn 4', value: r3(land4), label: exact },
    ],
    uncertainty: 'Joint exact probabilities (a card counted once), averaged; a score.',
  };

  const types = ['creature', 'artifact', 'enchantment', 'planeswalker'] as const;
  const answered = types.map((ty) => ({ ty, v: a.answers.find((x) => x.type === ty)?.byTurn6.value ?? 0 }));
  const threatsAnswered: ObjectiveScore = {
    value: r3(mean(answered.map((x) => x.v))),
    label: heur,
    components: answered.map((x) => ({ name: `answer to a ${x.ty} by turn 6`, value: r3(x.v), label: exact })),
    uncertainty: 'Exact per type, given the answer tags; whether an answer is good enough is not modelled.',
  };

  const protect = (a.counts['lifegain'] ?? 0) + (a.counts['counter'] ?? 0) + (a.counts['protection'] ?? 0) + (a.counts['sweeper'] ?? 0);
  const protectShare = clamp01(protect / 10);
  const survival: ObjectiveScore = {
    value: r3(mean([a.scores.sweepResilience.value, protectShare])),
    label: heur,
    components: [
      { name: 'sweep resilience', value: r3(a.scores.sweepResilience.value), label: heur },
      { name: 'lifegain, counters, protection and sweepers against ten', value: r3(protectShare), label: heur },
    ],
    uncertainty: 'Counts of tagged cards; says nothing about opposing decks.',
  };

  const independentClosing: ObjectiveScore = {
    value: r3(a.scores.closing.value),
    label: heur,
    components: [{ name: 'finishers and noncombat drain against eight', value: r3(a.scores.closing.value), label: heur }],
    uncertainty: a.scores.closing.note ?? 'Heuristic, not a win rate.',
  };

  const drain = a.counts['drain'] ?? 0;
  const pointsPotential: ObjectiveScore = {
    value: r3(clamp01(drain / 5)),
    label: heur,
    components: [{ name: 'noncombat drain sources against five', value: r3(clamp01(drain / 5)), label: heur }],
    uncertainty: 'Counts sources that can eliminate without combat; real points depend on who is credited.',
  };

  const price: ObjectiveScore = {
    value: r3(ctx.priceCeilingCents ? clamp01(1 - costCents / ctx.priceCeilingCents) : 1 / (1 + costCents / 1000)),
    label: heur,
    components: [{ name: 'cents spent on additions', value: costCents, label: exact }],
    uncertainty: 'Scryfall prices are estimates; only a confirmed price is a verified one.',
  };

  let pref = 0;
  if (ctx.preferredRoles.length) {
    const main = deck.filter((l) => l.zone === 'main' && l.quantity > 0);
    const total = main.reduce((s, l) => s + l.quantity, 0);
    const hit = main
      .filter((l) => tagCard({ name: l.card.name, typeLine: l.card.typeLine, oracleText: l.card.oracleText, cmc: l.card.cmc }).roles.some((r) => ctx.preferredRoles.includes(r)))
      .reduce((s, l) => s + l.quantity, 0);
    pref = total ? hit / total : 0;
  }
  const preferenceMatch: ObjectiveScore = {
    value: r3(pref),
    label: heur,
    components: [{ name: `share of the library in ${ctx.preferredRoles.join(', ') || 'no preferred roles'}`, value: r3(pref), label: heur }],
    uncertainty: 'Share of cards carrying a preferred role tag.',
  };

  return {
    analysis: a,
    objectives: { consistency, earlyDevelopment, threatsAnswered, survival, independentClosing, pointsPotential, price, preferenceMatch },
  };
}

export function composite(objs: Record<Objective, { value: number }>, weights: Weights, skip: Objective[] = []): number {
  let num = 0;
  let den = 0;
  for (const o of OBJECTIVES) {
    if (skip.includes(o)) continue;
    num += objs[o].value * weights[o];
    den += weights[o];
  }
  return den === 0 ? 0 : r3(num / den);
}

export function dominates(a: Record<Objective, { value: number }>, b: Record<Objective, { value: number }>): boolean {
  let strictly = false;
  for (const o of OBJECTIVES) {
    if (a[o].value < b[o].value) return false;
    if (a[o].value > b[o].value) strictly = true;
  }
  return strictly;
}
