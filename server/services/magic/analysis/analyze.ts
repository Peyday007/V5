/**
 * Deck analysis: the entrance POST /api/magic/analyze calls.
 *
 * Deterministic and code-first. The command zone is separate from the library:
 * every probability here is over `main` only (99 cards in Commander). Each
 * number carries its label; scores that are not probabilities say HEURISTIC_SCORE
 * and are never presented as win rates.
 */
import type { LabelledNumber, MagicFormat } from '../../../domain/magicTypes.ts';
import { labelExact, pAtLeast, pAtLeastOne, pJointAtLeast, pmf, toNumber, type CategoryCard } from './hypergeom.ts';
import { cardsSeen, parseCost, pCastable, type LandInfo, type ManaColor } from './mana.ts';
import { DEFAULT_MULLIGAN, simulate, type SimCard, type SimResult } from './simulate.ts';
import { answerTypes, tagCard, THREAT_TYPES, type AnswerType, type Role } from './tags.ts';

export interface AnalysisCard {
  name: string;
  quantity: number;
  zone: 'commander' | 'main' | 'sideboard';
  typeLine: string;
  manaCost?: string;
  cmc?: number;
  oracleText?: string;
  producedMana?: ManaColor[];
  entersTapped?: boolean;
}

export interface AnalyzeInput {
  format: MagicFormat;
  cards: AnalysisCard[];
  onThePlay?: boolean;
  seed?: number;
  simulationRuns?: number;
  /** Number of opponents; 1 changes how closing ability is read. */
  opponents?: number;
}

export type Labelled = LabelledNumber & { exact?: { num: string; den: string } };

export interface AnalysisResult {
  format: MagicFormat;
  librarySize: number;
  commanderZone: string[];
  counts: Record<string, number>;
  curve: { cmc: number; count: number }[];
  pips: Record<string, number>;
  sources: Record<string, number>;
  openingHand: {
    landDistribution: { lands: number; probability: Labelled }[];
    keepable: Labelled;
  };
  byTurn: {
    turn: number;
    cardsSeen: number;
    atLeastOneRamp: Labelled;
    atLeastOneDraw: Labelled;
    threeLandsAndRamp: Labelled;
  }[];
  answers: { type: AnswerType; count: number; byTurn6: Labelled }[];
  commanderCastable: { name: string; turn: number; probability: Labelled }[];
  redundancy: { role: Role; count: number; thin: boolean }[];
  singleCardReliance: { role: Role; card: string }[];
  scores: {
    sweepResilience: Labelled;
    closing: Labelled;
    singleCardReliance: Labelled;
  };
  simulation: SimResult | null;
  notes: string[];
}

const BASIC_COLOR: Record<string, ManaColor> = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' };

export function landInfoFor(card: AnalysisCard): LandInfo {
  let produces: ManaColor[] = card.producedMana ?? [];
  if (produces.length === 0) {
    const t = card.typeLine.toLowerCase();
    produces = Object.entries(BASIC_COLOR)
      .filter(([k]) => t.includes(k))
      .map(([, v]) => v);
  }
  if (produces.length === 0) {
    const set = new Set<ManaColor>();
    for (const m of (card.oracleText ?? '').matchAll(/\{([WUBRG])\}/g)) set.add(m[1] as ManaColor);
    if (/add \{[WUBRG]\}/i.test(card.oracleText ?? '')) produces = [...set];
  }
  const tapped = card.entersTapped ?? /enters (the battlefield )?tapped/i.test(card.oracleText ?? '');
  return { quantity: card.quantity, produces, entersTapped: tapped };
}

function heuristic(value: number, note: string): Labelled {
  return { value: Math.round(value * 1000) / 1000, label: 'HEURISTIC_SCORE', note };
}

export function analyzeDeck(input: AnalyzeInput): AnalysisResult {
  const onThePlay = input.onThePlay ?? true;
  const main = input.cards.filter((c) => c.zone === 'main');
  const commanders = input.cards.filter((c) => c.zone === 'commander');
  const librarySize = main.reduce((s, c) => s + c.quantity, 0);
  const notes: string[] = [];
  if (input.format === 'COMMANDER' && librarySize !== 99) {
    notes.push(`Library has ${librarySize} cards, not 99; probabilities are over what is listed.`);
  }

  const tagged = main.map((c) => ({
    card: c,
    roles: new Set<Role>(tagCard({ name: c.name, typeLine: c.typeLine, oracleText: c.oracleText, cmc: c.cmc }).roles),
    answers: answerTypes({ name: c.name, typeLine: c.typeLine, oracleText: c.oracleText }),
  }));
  const library: CategoryCard[] = tagged.map((t) => ({
    categories: [...t.roles, ...t.answers.map((a) => `answer:${a}`)],
    quantity: t.card.quantity,
  }));
  const countRole = (role: Role) => tagged.filter((t) => t.roles.has(role)).reduce((s, t) => s + t.card.quantity, 0);

  const counts: Record<string, number> = {};
  for (const role of ['land', 'ramp', 'draw', 'removal', 'sweeper', 'counter', 'lifegain', 'drain', 'threat', 'finisher', 'engine', 'protection', 'tutor', 'recursion'] as Role[]) {
    counts[role] = countRole(role);
  }

  // Curve and pips (non-lands).
  const curveMap = new Map<number, number>();
  const pips: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const t of tagged) {
    if (t.roles.has('land')) continue;
    const cost = parseCost(t.card.manaCost ?? '');
    const cmc = t.card.cmc ?? cost.cmc;
    curveMap.set(cmc, (curveMap.get(cmc) ?? 0) + t.card.quantity);
    for (const [color, n] of Object.entries(cost.pips)) pips[color] = (pips[color] ?? 0) + (n ?? 0) * t.card.quantity;
  }
  const curve = [...curveMap.entries()].sort((a, b) => a[0] - b[0]).map(([cmc, count]) => ({ cmc, count }));

  const landCards = tagged.filter((t) => t.roles.has('land')).map((t) => t.card);
  const lands = landCards.map(landInfoFor);
  const sources: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const l of lands) for (const c of l.produces) sources[c] = (sources[c] ?? 0) + l.quantity;

  // Opening hand.
  const landK = counts['land'] ?? 0;
  const dist = librarySize >= 7 ? pmf(librarySize, landK, 7) : [];
  const keepable = dist.length
    ? labelExact(
        dist.slice(2, 6).reduce((acc, r) => ({ num: acc.num * r.den + r.num * acc.den, den: acc.den * r.den }), { num: 0n, den: 1n }),
        'Opening seven holds 2 to 5 lands.',
      )
    : { value: 0, label: 'EXACT_PROBABILITY' as const };
  const openingHand = {
    landDistribution: dist.map((r, lands) => ({ lands, probability: labelExact(r) })),
    keepable: keepable as Labelled,
  };

  // By turn.
  const byTurn = librarySize >= 11
    ? [1, 2, 3, 4, 5, 6].map((turn) => {
        const n = Math.min(cardsSeen(turn, onThePlay), librarySize);
        return {
          turn,
          cardsSeen: n,
          atLeastOneRamp: labelExact(pAtLeastOne(librarySize, counts['ramp'] ?? 0, n), 'At least one ramp card drawn.'),
          atLeastOneDraw: labelExact(pAtLeastOne(librarySize, counts['draw'] ?? 0, n), 'At least one card-draw card drawn.'),
          threeLandsAndRamp: labelExact(
            pJointAtLeast(library, n, { land: 3, ramp: 1 }),
            'Joint event: at least 3 lands and at least 1 ramp, counting a card in both only once.',
          ),
        };
      })
    : [];

  // Answers by type, by turn 6.
  const answers = THREAT_TYPES.map((type) => {
    const k = tagged.filter((t) => t.answers.includes(type)).reduce((s, t) => s + t.card.quantity, 0);
    const n = Math.min(cardsSeen(6, onThePlay), librarySize);
    return { type, count: k, byTurn6: labelExact(librarySize ? pAtLeastOne(librarySize, k, n) : { num: 0n, den: 1n }, `At least one answer to a ${type} by turn 6.`) as Labelled };
  });

  // Commander castability.
  const commanderCastable = commanders.flatMap((c) =>
    librarySize >= 14
      ? [3, 4, 5, 6].map((turn) => ({
          name: c.name,
          turn,
          probability: pCastable(c.manaCost ?? '', lands, librarySize, turn, onThePlay) as Labelled,
        }))
      : [],
  );

  // Redundancy and reliance.
  const redundancyRoles: Role[] = ['ramp', 'draw', 'removal', 'sweeper', 'finisher', 'protection'];
  const redundancy = redundancyRoles.map((role) => ({ role, count: counts[role] ?? 0, thin: (counts[role] ?? 0) < 3 }));
  const singleCardReliance: { role: Role; card: string }[] = [];
  for (const role of ['ramp', 'draw', 'removal', 'finisher'] as Role[]) {
    const served = tagged.filter((t) => t.roles.has(role));
    const total = served.reduce((s, t) => s + t.card.quantity, 0);
    if (total === 1 && served[0]) singleCardReliance.push({ role, card: served[0].card.name });
  }

  // Heuristic scores.
  const threatCards = tagged.filter((t) => t.roles.has('threat') || t.roles.has('finisher'));
  const threatTotal = threatCards.reduce((s, t) => s + t.card.quantity, 0);
  const sweepSafe = threatCards
    .filter((t) => !/\bcreature\b/i.test(t.card.typeLine))
    .reduce((s, t) => s + t.card.quantity, 0) + (counts['drain'] ?? 0);
  const sweepResilience = heuristic(
    threatTotal + (counts['drain'] ?? 0) === 0 ? 0 : Math.min(1, sweepSafe / (threatTotal + (counts['drain'] ?? 0))),
    'Share of win sources that are not creatures a sweeper kills. Heuristic, not a probability.',
  );
  const opponents = input.opponents ?? 3;
  const closingSources = (counts['finisher'] ?? 0) + (counts['drain'] ?? 0);
  const closing = heuristic(
    Math.min(1, closingSources / 8),
    opponents === 1
      ? '1v1: counts finishers and noncombat drain; goad-style effects are not counted as protection.'
      : 'Counts finishers and noncombat drain against a target of eight. Heuristic, not a win rate.',
  );
  const reliance = heuristic(
    1 - Math.min(1, singleCardReliance.length / 4),
    'Fewer roles hanging on one card scores higher. Heuristic.',
  );

  let simulation: SimResult | null = null;
  if (input.simulationRuns && librarySize >= 14) {
    const sim: SimCard[] = [];
    for (const t of tagged) {
      for (let i = 0; i < t.card.quantity; i++) {
        sim.push({ name: t.card.name, isLand: t.roles.has('land'), isRamp: t.roles.has('ramp'), isDraw: t.roles.has('draw') });
      }
    }
    simulation = simulate(sim, {
      runs: input.simulationRuns,
      seed: input.seed ?? 1,
      turns: 6,
      onThePlay,
      mulligan: DEFAULT_MULLIGAN,
    });
  }

  void pAtLeast;
  void toNumber;
  return {
    format: input.format,
    librarySize,
    commanderZone: commanders.map((c) => c.name),
    counts,
    curve,
    pips,
    sources,
    openingHand,
    byTurn,
    answers,
    commanderCastable,
    redundancy,
    singleCardReliance,
    scores: { sweepResilience, closing, singleCardReliance: reliance },
    simulation,
    notes,
  };
}
