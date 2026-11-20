/**
 * Multidirectional reasoning (§101): one goal, examined from many genuinely
 * different directions, with the directions themselves open-ended.
 *
 * §99's reconstruction loop changes one dimension at a time and combines the
 * changes greedily. That finds the strongest plan along one path; it cannot
 * look at the problem *differently*. Here a **direction** is a way of reasoning
 * about the goal — forward from what is held, backward from the target, out
 * from the middle of the best plan, through a binding constraint, a resource,
 * a relationship, an inversion — or one Brain's own model invented. Stances
 * are strings, not an enum: the model may name a stance nobody wrote down,
 * and it is kept and scored like any other.
 *
 * What makes a direction testable is that it is written as a **program** of
 * transforms over the plan's own openings (`Transform`). The vocabulary is
 * small and every transform is honest: an operator (§99's costed changes, now
 * pointable at any opening), a price change that pays for itself in close
 * rate, a concentration or a drop. Nothing can raise a reply or close rate by
 * declaring it. So a model's idea is judged by the one engine, cheaply, and an
 * idea that only works by assuming success does not win.
 *
 * The loop:
 *   1. Generate. Cheap algorithms derive directions from the problem's own
 *      data (each opening, each binding factor, each budget, each lever); the
 *      library supplies what worked before; the model invents methods. A
 *      signature over the program (factors bucketed) drops meaningless
 *      variations, so the count is distinct lines of reasoning, not prompts.
 *   2. Screen every direction at a few hundred worlds, concurrently.
 *   3. Evolve. The leaders challenge, modify, combine and replace one
 *      another: pairs from different stances are combined, leaders are
 *      mutated (another target, another budget), and every survivor is
 *      challenged — its conversion assumptions halved — so the winner is the
 *      plan that holds, not the one that only works if everything goes right.
 *      Generations stop when nothing improves materially.
 *   4. Conclude. The strongest robust direction, whether it replaced the
 *      strategy §99 built, the stances that produced improvements, the
 *      directions the model invented that improved the plan, and the questions
 *      the directions could not answer from the openings held.
 *
 * The budget is the problem's: the number of directions grows with the
 * openings, operators and binding factors and with how far the plan is from
 * its requirement, up to `MAX_DIRECTIONS`. A plan that already meets its
 * requirement is not explored.
 */
import type { ModelledOpportunity } from '../../cash/goalScenario.ts';
import type { InventedDesign } from '../../cash/construct.ts';
import { AGGREGATION, coherent, FUNDING, REPEAT, STRUCTURE_KEYS, STRUCTURES, type Design } from '../../cash/properties.ts';
import type { PlannedOpening } from '../portfolio.ts';
import type { Dimension, StrategyChange, StrategyOperator, StrategyState, VariantReading } from '../reconstruction.ts';
import { renderSweep, type VariableSweep } from './variables.ts';
import { rankValue, valuePerInterested, isEstablished } from './rank.ts';

export const MAX_DIRECTIONS = 120;
export const MIN_DIRECTIONS = 12;
/** Directions carried from one generation to the next. */
export const LEADERS = 8;
export const MAX_GENERATIONS = 4;
/** Price elasticity a price change pays in close rate: an assumption, stated, until selling measures it. */
export const PRICE_ELASTICITY = 1.2;
/** The challenge every leader must survive: its conversion halved. */
export const CHALLENGE_FACTOR = 0.5;
/**
 * A direction may replace §99's plan only if, challenged, it still reaches at
 * least this share of the requirement — or if what it holds on no assumed move
 * beats the plan as held (§101, C-15). Half the requirement: a plan that falls
 * below that once its conversion is halved or its assumptions are taken away
 * rests on them, and the challenge exists to stop such a plan winning.
 */
export const WINNER_ALPHA = 0.5;
/** Evaluations an exploration may spend per direction its budget allows: screening, challenges and generations together. */
export const EVALUATIONS_PER_DIRECTION = 4;
/** No exploration spends more evaluations than this, whatever its budget. */
export const MAX_EVALUATIONS = 400;
/** Nor more time than this (production evaluations cost about a second each). */
export const DEFAULT_MAX_MS = 3 * 60_000;
/**
 * Reserve entries a model's brief lists, strongest first. The reserve now also
 * holds every opening a reconstruction does not move (hundreds on production,
 * `MOVABLE_UNRANKED`); a brief listing them all is a prompt of hundreds of lines
 * for moves the strongest few already represent. Every entry stays reachable
 * by the seeded and mutated INCLUDE moves.
 */
export const BRIEF_RESERVE = 16;

export type Field = 'price' | 'close' | 'respond' | 'volume' | 'daysToCash' | 'directCost';
/** Which openings a transform touches. `id:<opportunityId>` names one. */
export type Scope = 'ALL' | 'OUTREACH' | 'SMALL_TICKET' | 'LARGE_TICKET' | 'FAST_CASH' | 'SLOW_CASH' | 'TOP' | 'REST' | `id:${string}`;

export type Transform =
  /** One of §99's costed operators by key (or key prefix), optionally pointed at an opening. */
  | { op: 'OPERATOR'; key: string; target?: string }
  /** Raise or lower price; close moves the other way by the stated elasticity. */
  | { op: 'PRICE'; factor: number; scope: Scope }
  /** Concentrate the plan's capacity on its strongest `count` openings. */
  | { op: 'FOCUS'; count: number }
  /** Leave openings out, freeing the capacity and money they used. */
  | { op: 'DROP'; scope: Scope }
  /** A stress: move a field against the plan. Used to challenge, never to win. */
  | { op: 'STRESS'; field: Field; factor: number; scope: Scope }
  /**
   * Bring in a constructed arrangement the compose's screen cut (lens S, S-6):
   * `key` is its opening id in `ExploreContext.reserve`. It enters on its own
   * reconstructed estimates, sharing its population's market, and the engine
   * judges the plan with it like any other.
   */
  | { op: 'INCLUDE'; key: string };

export type Origin = 'ALGORITHM' | 'MODEL' | 'LIBRARY' | 'RECOMBINED' | 'MUTATED';

export interface Direction {
  /** Canonical, factor-bucketed form of the program: two directions with one signature are one line of reasoning. */
  signature: string;
  name: string;
  /** How it reasons. Open-ended: a model may name a stance nobody wrote down. */
  stance: string;
  origin: Origin;
  /** In one or two sentences, the reasoning the program expresses. */
  thinking: string;
  /** The assumption of the current plan this direction challenges, when it names one. */
  challenges?: string;
  /** Start from the plan as held (a full reconstruction) or from §99's strongest plan (a modification). */
  from: 'BASELINE' | 'GREEDY';
  program: Transform[];
  parents?: string[];
  /** A question the openings held cannot answer, which this direction needs answered. */
  ask?: string;
  /**
   * A transaction design for a buyer population the model proposed (S-11):
   * composed by the construction path when the model's methods arrive, and
   * brought into the plan by an INCLUDE of the arrangement it composes to.
   */
  design?: InventedDesign;
}

export interface DirectionReading {
  direction: Direction;
  reading: VariantReading;
  /** The weaker of its conversion halved and its assumptions removed: what it holds if its assumptions are wrong. */
  challenged: VariantReading | null;
  /** The same plan with every assumed move taken away. */
  bare?: VariantReading | null;
  /** The ranking score: reach and challenged reach weighed equally, so a fragile plan ranks below a robust one. */
  score: number;
  generation: number;
  applied: boolean;
  /** The state the direction was evaluated on: the winner is adopted exactly as judged. */
  state?: StrategyState;
}

export interface Exploration {
  budget: number;
  /** Distinct directions evaluated. */
  directions: number;
  stances: string[];
  byOrigin: Record<Origin, number>;
  generations: number;
  threads: number;
  evaluations: number;
  elapsedMs: number;
  /** What ended it: nothing left improving, or one of its bounds. */
  stopped: 'CONVERGED' | 'EVALUATIONS' | 'TIME';
  baseline: { reach: number; settledP50: number };
  greedy: { reach: number; settledP50: number; score: number; challengedReach: number };
  /** The strongest robust direction, or null when none beat §99's plan. */
  winner: DirectionReading | null;
  /** True when a direction replaced the strategy §99 built (a different plan, not a refinement). */
  replaced: boolean;
  /** The leaders after the last generation, strongest first. */
  leaders: DirectionReading[];
  /** Every direction evaluated, for the learning record. */
  all: DirectionReading[];
  /** Stance → [directions, improved over the plan as held, best lift]. */
  stanceYield: Array<{ stance: string; directions: number; improved: number; bestLift: number }>;
  /** Directions the model invented that improved the plan. */
  discoveries: DirectionReading[];
  /** Questions directions raised that the openings held cannot answer. */
  asks: string[];
  /**
   * The role each opening and reserve arrangement played in this problem
   * (`@RANK:k` by value per interested buyer, `@RESERVE:k`), so a learned
   * method is recorded without this goal's ids and transfers to another (S-8).
   */
  roles?: Record<string, string>;
  /** The model's part: calls made, methods proposed, methods refused as off-shape or unexecutable, and why each invented design was refused. */
  model: { calls: number; proposed: number; refused: number; error: string | null; rejections?: string[] };
  /** The variable sweep (§102) whose strategies entered this exploration, when one ran. */
  sweep?: VariableSweep | null;
  sentence: string;
}

export interface ExploreContext {
  base: StrategyState;
  greedy: StrategyState;
  greedyReading: VariantReading;
  baselineReading: VariantReading;
  operators: StrategyOperator[];
  /** Operators re-pointed at one opening, for directions that name a target. */
  operatorsFor: (target: string) => StrategyOperator[];
  /** Evaluates a state; `screen` uses fewer worlds. Cached by the change set. */
  evaluate: (state: StrategyState, screen: boolean, tag?: string) => Promise<VariantReading>;
  required: number;
  remaining: number;
  daysLeft: number;
  /** Factors ranked by what binds (§99's diagnosis). */
  binding: Array<{ factor: string; liftReach: number }>;
  structural: boolean;
  threads: number;
  /** What worked before, best first (`learning.ts`). */
  library?: Direction[];
  /** What each stance has yielded across goals (`loadStancePrior`): the seed budget is allocated by it (S-10). */
  stancePrior?: StancePrior;
  /** The model's methods, already parsed; generated concurrently with the screen. */
  invent?: (brief: InventBrief) => Promise<{ directions: Direction[]; calls: number; proposed: number; refused: number; error: string | null; rejections?: string[] }>;
  /**
   * Composes a design the model invented through the construction path into
   * an estimated opening, or says why it cannot be one (S-11). Absent, the
   * model is not offered designs.
   */
  design?: (spec: InventedDesign) => PlannedOpening | { refused: string };
  /** Wall-clock budget for the whole exploration. */
  maxMs?: number;
  now?: () => number;
  /**
   * The variable sweep that ran over this plan (§102): its strongest
   * strategies enter the pool first, as directions the engine judges like
   * any other.
   */
  sweep?: VariableSweep | null;
  /** Constructed arrangements the compose's screen cut, strongest first: what an INCLUDE move may bring in (S-6). */
  reserve?: PlannedOpening[];
  /**
   * Openings the reconstruction holds in the reserve instead of moving them
   * (`MOVABLE_UNRANKED`). They are still the problem's openings, so the budget
   * counts them as it did when every one was moved: bounding what each
   * evaluation carries must not also shrink how widely the plan is explored.
   */
  heldOpenings?: number;
}

/** What the model is told about the problem. */
export interface InventBrief {
  remaining: number;
  daysLeft: number;
  required: number;
  baseline: { reach: number; settledP50: number };
  greedy: { reach: number; settledP50: number; changes: string[] };
  binding: Array<{ factor: string; liftReach: number }>;
  structural: boolean;
  openings: Array<{ id: string; title: string; price: number | null; close: number | null; respond: number | null; volume: number | null; daysToCash: number | null; outreach: boolean; agreed: boolean }>;
  operators: Array<{ key: string; dimension: string }>;
  /** Constructed arrangements outside the plan that an INCLUDE step may bring in. */
  reserve?: Array<{ id: string; title: string; price: number | null; repeatable: boolean }>;
  /** Present when a method may carry a new transaction design: the vocabulary it is written in (S-11). */
  designs?: { structures: Array<{ key: string; label: string }>; funding: readonly string[]; aggregation: readonly string[]; repeat: readonly string[] };
  /** Stances already covered, so the model is asked for ones that are not. */
  stancesTried: string[];
  /** Methods that worked best before. */
  bestKnown: Array<{ name: string; stance: string; thinking: string }>;
}

// ---------------------------------------------------------------- helpers

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function mid(input: ModelledOpportunity['price']): number | null {
  if (input.value !== null) return input.value;
  if (input.inferred) return input.inferred.p50;
  if (input.low !== null && input.high !== null) return (input.low + input.high) / 2;
  return input.low ?? input.high ?? null;
}

function outreach(o: ModelledOpportunity): boolean {
  return o.repeatable && o.agreedValue === 0 && !o.channel;
}


function scaleInput(input: ModelledOpportunity['price'], k: number, cap = Infinity): ModelledOpportunity['price'] {
  const f = (x: number | null) => (x === null ? null : Math.min(cap, x * k));
  return { ...input, value: f(input.value), low: f(input.low), high: f(input.high), distribution: undefined, inferred: undefined };
}

/**
 * A scope as a person reads it in a change's description: the opening's own
 * title for `id:…`, words for the rest. The scope stays the change's key
 * (`drop@id:…`); its description is what a plan's step and candidate read
 * (transfer test, 2026-11-19: a step read "Leave out 1 opening(s)
 * (id:arr_71e8904fcb7c)" — NO_INTERNAL_KEYS, `planIntegrity`). Pure.
 */
export function scopeWords(scope: Scope, openings: readonly ModelledOpportunity[]): string {
  if (scope.startsWith('id:')) {
    const id = scope.slice(3);
    const hit = openings.find((o) => o.opportunity.id === id || o.opportunity.id.startsWith(`${id}~`));
    return hit ? `"${hit.opportunity.title.slice(0, 80)}"` : 'one named opening';
  }
  const words: Record<string, string> = {
    ALL: 'all of them',
    OUTREACH: 'those sold by outreach',
    SMALL_TICKET: 'the small tickets',
    LARGE_TICKET: 'the large tickets',
    FAST_CASH: 'those that pay soonest',
    SLOW_CASH: 'those that pay latest',
    TOP: 'the strongest third',
    REST: 'all but the strongest third',
  };
  return words[scope] ?? 'a group of them';
}

/** The openings a scope names, among those a strategy may still change (agreed money is never touched). */
export function inScope(openings: ModelledOpportunity[], scope: Scope, remaining: number): Set<string> {
  const open = openings.filter((o) => o.agreedValue === 0);
  const ids = (xs: ModelledOpportunity[]) => new Set(xs.map((o) => o.opportunity.id));
  if (scope.startsWith('id:')) {
    const id = scope.slice(3);
    return ids(open.filter((o) => o.opportunity.id === id || o.opportunity.id.startsWith(`${id}~`)));
  }
  const ranked = [...open].sort((a, b) => valuePerInterested(b) - valuePerInterested(a));
  const share = remaining / 20;
  const days = (o: ModelledOpportunity) => mid(o.daysToCash) ?? 0;
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
  const mDays = median(open.map(days));
  switch (scope) {
    case 'ALL':
      return ids(open);
    case 'OUTREACH':
      return ids(open.filter(outreach));
    case 'SMALL_TICKET':
      return ids(open.filter((o) => (mid(o.price) ?? 0) > 0 && (mid(o.price) ?? 0) < share));
    case 'LARGE_TICKET':
      return ids(open.filter((o) => (mid(o.price) ?? 0) >= share));
    case 'FAST_CASH':
      return ids(open.filter((o) => days(o) <= mDays));
    case 'SLOW_CASH':
      return ids(open.filter((o) => days(o) > mDays));
    case 'TOP':
      return ids(ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3))));
    case 'REST':
      return ids(ranked.slice(Math.max(1, Math.ceil(ranked.length / 3))));
    default:
      return new Set();
  }
}

/** The price change a direction may make: from a quarter to four times — of the card's own unit price, however many moves reach it. */
export const clampPrice = (k: number) => Math.min(4, Math.max(0.25, k));

/**
 * Move one opening's unit price by `k`, held to ×0.25–×4 of the card's own
 * price across every move that has touched it (price steps and transaction
 * shapes alike), so moves never compound past the clamp (production,
 * 2026-11-14: ×1.3 · ×3.38 · ×4 = ×17.6 on one opening). The demand curve
 * moves both ways: close rate and the deals the market takes each move by
 * k^-elasticity (assumed until selling measures it). Returns the factor
 * actually applied (1 when the opening is already at the clamp).
 */
export function repriceOpening(o: PlannedOpening, k: number, why = 'price', anyPrice = false): { opening: PlannedOpening; applied: number } {
  /*
   * A price move multiplies a price somebody established. A price nobody has
   * established is a question for research, never a number to scale: goal C
   * (production 2026-11-20) led at 25.3% by raising a constructed postcard
   * arrangement's unestablished $349 ×3.75 on an assumed elasticity, against
   * 8.3% as held — an unknown read in the plan's favour (invariant 39).
   */
  // A transaction shape's discount (part of the deal it reshapes) and the binding-factor probe (a sensitivity, never a plan) move any price.
  if (!anyPrice && !isEstablished(o.price)) return { opening: o, applied: 1 };
  const terms = o.terms ?? { priceFactor: 1, shape: null, units: 1 };
  const target = clampPrice(terms.priceFactor * k);
  const applied = target / terms.priceFactor;
  if (Math.abs(applied - 1) < 1e-9) return { opening: o, applied: 1 };
  const demand = Math.pow(applied, -PRICE_ELASTICITY);
  const note = `${why} ×${applied.toFixed(2)} (unit price ×${target.toFixed(2)} of the card's): assumed ×${demand.toFixed(2)} (elasticity ${PRICE_ELASTICITY})`;
  return {
    opening: {
      ...o,
      price: scaleInput(o.price, applied),
      close: { ...scaleInput(o.close, demand, 1), provenance: 'ASSUMPTION', note: `${o.close.note}; close ${note}` },
      volume: { ...scaleInput(o.volume, demand), provenance: 'ASSUMPTION', note: `${o.volume.note}; deals the market takes ${note}` },
      terms: { ...terms, priceFactor: target },
    },
    applied,
  };
}

/**
 * The family a transform belongs to: a program holds at most one move per
 * family (one capacity purchase per lever, one acquisition per lever and
 * target, one partner per target, one transaction shape, one price line, one
 * focus). Null for a challenge.
 */
export function familyOf(t: Transform): string | null {
  switch (t.op) {
    case 'OPERATOR': {
      const base = t.key.split('@')[0]!;
      if (t.key.startsWith('acquisition:')) return `${base}>${t.target ?? ''}`;
      if (t.key.startsWith('partner:')) return `partner>${t.target ?? ''}`;
      if (t.key.startsWith('transaction:')) return 'transaction';
      return base;
    }
    case 'PRICE':
      return 'price';
    case 'FOCUS':
      return 'focus';
    case 'DROP':
      return `drop:${t.scope}`;
    case 'STRESS':
      return null;
    case 'INCLUDE':
      return `include:${t.key}`;
  }
}

const bucket = (k: number) => Math.round(Math.log2(Math.max(1e-6, k)) * 2) / 2;

function token(t: Transform): string {
  switch (t.op) {
    case 'OPERATOR':
      return `op:${t.key}${t.target ? `>${t.target}` : ''}`;
    case 'PRICE':
      return `price:${bucket(clampPrice(t.factor))}@${t.scope}`;
    case 'FOCUS':
      return `focus:${Math.max(1, Math.round(t.count))}`;
    case 'DROP':
      return `drop:${t.scope}`;
    case 'STRESS':
      return `stress:${t.field}:${bucket(t.factor)}@${t.scope}`;
    case 'INCLUDE':
      return `include:${t.key}`;
  }
}

/** Two programs with one signature are one line of reasoning, however they were worded. */
export function signatureOf(from: Direction['from'], program: Transform[]): string {
  return `${from}|${[...new Set(program.map(token))].sort().join('+')}`;
}

export function tokens(d: Direction): Set<string> {
  return new Set(d.program.map(token));
}

/** Jaccard distance between two directions' programs: 0 identical, 1 nothing shared. */
export function distance(a: Direction, b: Direction): number {
  const x = tokens(a);
  const y = tokens(b);
  if (a.from !== b.from && x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  const union = x.size + y.size - inter;
  return union === 0 ? (a.from === b.from ? 0 : 1) : 1 - inter / union;
}

export function makeDirection(d: Omit<Direction, 'signature'>): Direction {
  return { ...d, signature: signatureOf(d.from, d.program) };
}

/**
 * How many directions the problem justifies: more openings, operators and
 * binding factors, and a wider gap to the requirement, justify more. A plan
 * at its requirement justifies none.
 */
export function explorationBudget(input: { openings: number; operators: number; binding: number; reach: number; required: number; structural: boolean; accepted?: boolean }): number {
  // `reach` is what the plan holds once challenged: a plan that only reaches its requirement if every assumption is right is still short.
  const gap = Math.max(0, input.required - input.reach);
  if (input.accepted || gap <= 0) return 0;
  const complexity = input.openings + input.operators + 3 * input.binding;
  const value = Math.min(1, gap / Math.max(0.01, input.required));
  const n = Math.round(complexity * (0.8 + 2 * value) * (input.structural ? 1.25 : 1));
  return Math.max(MIN_DIRECTIONS, Math.min(MAX_DIRECTIONS, n));
}

// ---------------------------------------------------------------- applying a program

export interface Applied {
  state: StrategyState;
  /** Transforms that could not apply here (an operator with nothing to change, a scope that is empty). */
  skipped: number;
}

/** Run a direction's program on a starting state. Pure. */
export function applyProgram(
  start: StrategyState,
  program: Transform[],
  ctx: Pick<ExploreContext, 'operators' | 'operatorsFor' | 'remaining' | 'reserve'>,
  /** Leave out every transform whose change is an assumption: the plan as it stands on estimates alone. */
  skipAssumed = false,
): Applied {
  let s: StrategyState = start;
  let skipped = 0;
  const change = (dimension: Dimension, label: string, detail: string, basis: StrategyChange['basis']): StrategyChange => ({ dimension, label, detail, cost: 0, basis, startDay: { low: 0, high: 0 } });
  const record = (next: StrategyState, t: Transform): StrategyState => ({ ...next, program: [...(s.program ?? []), t] });
  for (const t of program) {
    if (t.op === 'OPERATOR') {
      const pool = t.target ? ctx.operatorsFor(t.target) : ctx.operators;
      const op = pool.find((o) => o.key === t.key) ?? pool.find((o) => o.key.startsWith(t.key));
      // An operator does nothing twice: it returns null when its move is already made (or a larger one of its family is),
      // and replaces a smaller move of its family, appending the replacement last.
      const next = op ? op.apply(s) : null;
      if (!next || next === s) {
        skipped++;
        continue;
      }
      if (skipAssumed && next.changes[next.changes.length - 1]!.basis === 'ASSUMPTION') continue;
      s = record(next, t);
      continue;
    }
    if (t.op === 'PRICE') {
      if (skipAssumed) continue;
      const k = clampPrice(t.factor);
      const ids = inScope(s.openings, t.scope, ctx.remaining);
      if (ids.size === 0 || Math.abs(k - 1) < 0.05) {
        skipped++;
        continue;
      }
      // One running factor per opening across every price and transaction move: a second move cannot carry it past the clamp.
      let moved = 0;
      const openings = s.openings.map((o) => {
        if (!ids.has(o.opportunity.id)) return o;
        const r = repriceOpening(o, k);
        if (Math.abs(r.applied - 1) >= 0.05) moved++;
        return r.applied === 1 ? o : r.opening;
      });
      if (moved === 0) {
        skipped++;
        continue;
      }
      const demandK = Math.pow(k, -PRICE_ELASTICITY);
      s = record(
        {
          ...s,
          openings,
          changes: [...s.changes, change('PRICE', `price×${k.toFixed(2)}@${t.scope}`, `${k > 1 ? 'raise' : 'lower'} price ×${k.toFixed(2)} on ${moved} opening(s) (${scopeWords(t.scope, s.openings)}), each held within ×0.25–×4 of its card's unit price; close rate and the deals the market takes assumed to move ×${demandK.toFixed(2)} until selling measures it`, 'ASSUMPTION')],
        },
        t,
      );
      continue;
    }
    if (t.op === 'FOCUS') {
      const n = Math.max(1, Math.round(t.count));
      const open = s.openings.filter((o) => o.agreedValue === 0);
      // One concentration per plan: a second focus is the first one renamed.
      if (open.length <= n || s.changes.some((c) => c.dimension === 'PORTFOLIO' && c.label.startsWith('focus:'))) {
        skipped++;
        continue;
      }
      const keep = new Set([...open].sort((a, b) => valuePerInterested(b) - valuePerInterested(a)).slice(0, n).map((o) => o.opportunity.id));
      s = record(
        {
          ...s,
          openings: s.openings.filter((o) => o.agreedValue > 0 || keep.has(o.opportunity.id)),
          changes: [...s.changes, change('PORTFOLIO', `focus:${n}`, `concentrate outreach and money on the ${n} opening(s) that settle most per interested buyer, and drop ${open.length - n}`, 'ESTIMATE')],
        },
        t,
      );
      continue;
    }
    if (t.op === 'INCLUDE') {
      const one = ctx.reserve?.find((o) => o.opportunity.id === t.key);
      if (!one || s.openings.some((o) => o.opportunity.id === t.key)) {
        skipped++;
        continue;
      }
      // A design the model invented is a hypothesis about structure: the plan without it is what holds on no assumption (S-11).
      const invented = !!one.estimated?.invented;
      if (skipAssumed && invented) continue;
      s = record(
        {
          ...s,
          openings: [...s.openings, one],
          changes: [...s.changes, change('PORTFOLIO', `include:${t.key}`, `bring in "${one.opportunity.title.slice(0, 80)}", ${invented ? "a design Brain's model invented, composed by construction, every input of it unestablished" : one.estimated ? 'a constructed arrangement the first cut left out, on its reconstructed estimates' : 'an opening the reconstruction held outside the openings it moves, on its own estimates'}`, invented ? 'ASSUMPTION' : 'ESTIMATE')],
        },
        t,
      );
      continue;
    }
    if (t.op === 'DROP') {
      const ids = inScope(s.openings, t.scope, ctx.remaining);
      if (ids.size === 0 || ids.size >= s.openings.filter((o) => o.agreedValue === 0).length) {
        skipped++;
        continue;
      }
      s = record(
        {
          ...s,
          openings: s.openings.filter((o) => !ids.has(o.opportunity.id)),
          changes: [...s.changes, change('PORTFOLIO', `drop@${t.scope}`, `leave out ${ids.size} opening(s) (${scopeWords(t.scope, s.openings)}), freeing the capacity and money they held`, 'ESTIMATE')],
        },
        t,
      );
      continue;
    }
    // STRESS: a challenge, recorded as one so it can never pass as a plan.
    const ids = inScope(s.openings, t.scope, ctx.remaining);
    if (ids.size === 0) {
      skipped++;
      continue;
    }
    const k = Math.max(0.05, t.factor);
    const against = t.field === 'daysToCash' || t.field === 'directCost' ? Math.max(1, k) : Math.min(1, k);
    s = {
      ...s,
      openings: s.openings.map((o) => (ids.has(o.opportunity.id) ? { ...o, [t.field]: scaleInput(o[t.field], against, t.field === 'close' || t.field === 'respond' ? 1 : Infinity) } : o)),
      changes: [...s.changes, change('EVIDENCE', `stress:${t.field}×${against.toFixed(2)}@${t.scope}`, `challenge: ${t.field} ×${against.toFixed(2)} on ${scopeWords(t.scope, s.openings)}`, 'ASSUMPTION')],
    };
  }
  return { state: s, skipped };
}

/** The challenge: the same plan with every conversion it relies on halved. */
export function challengeProgram(): Transform[] {
  return [
    { op: 'STRESS', field: 'close', factor: CHALLENGE_FACTOR, scope: 'ALL' },
    { op: 'STRESS', field: 'respond', factor: CHALLENGE_FACTOR, scope: 'ALL' },
  ];
}

// ---------------------------------------------------------------- algorithmic generation

/**
 * Directions derived by cheap algorithms from the problem's own data. Each
 * generator is a way of reasoning, and the number of directions each yields
 * is set by the problem (one per opening, per binding factor, per lever) —
 * not by a list of prompts.
 */
export function seedDirections(ctx: Pick<ExploreContext, 'base' | 'greedy' | 'operators' | 'binding' | 'remaining' | 'structural' | 'reserve'>): Direction[] {
  const out: Direction[] = [];
  const add = (d: Omit<Direction, 'signature' | 'origin'>) => out.push(makeDirection({ ...d, origin: 'ALGORITHM' }));
  const openings = ctx.base.openings.filter((o) => o.agreedValue === 0);
  const ranked = [...openings].sort((a, b) => valuePerInterested(b) - valuePerInterested(a));
  const sellable = ranked.filter((o) => outreach(o) && (mid(o.price) ?? 0) > 0);
  const ops = ctx.operators;
  const byDim = (d: string) => ops.filter((o) => o.dimension === d);
  const greedyKeys = ctx.greedy.changes.map((c) => c.label);
  const title = (o: ModelledOpportunity) => o.opportunity.title.slice(0, 50);

  // BACKWARD: from the remaining amount, the fewest deals that could settle it → the openings large enough to matter, with what it takes to sell them.
  const large = ranked.filter((o) => (mid(o.price) ?? 0) * Math.max(1, mid(o.volume) ?? 1) >= ctx.remaining / 4);
  for (let n = 1; n <= Math.min(4, large.length); n++) {
    add({ name: `Backward: the ${n} opening(s) big enough to carry the target`, stance: 'BACKWARD', thinking: `Start from ${Math.round(ctx.remaining)} still to raise and keep only openings that could each carry a quarter of it, so capacity is not spread over openings that cannot matter.`, from: 'BASELINE', program: [{ op: 'FOCUS', count: n }] });
  }
  if (large.length > 0)
    for (const op of [...byDim('ACQUISITION'), ...byDim('CAPACITY')].slice(0, 6))
      add({ name: `Backward: carry the target with ${op.key}`, stance: 'BACKWARD', thinking: 'Work back from the deals needed to the buyers needed, and buy the reach those buyers require.', from: 'BASELINE', program: [{ op: 'FOCUS', count: Math.max(1, Math.min(3, large.length)) }, { op: 'OPERATOR', key: op.key }] });

  // FORWARD: from each held opening, what it becomes when everything available is put behind it.
  for (const o of sellable.slice(0, 8)) {
    add({ name: `Forward: build on "${title(o)}" through a partner`, stance: 'FORWARD', thinking: 'Start from an opening already held and extend it through someone who already serves its buyers.', from: 'BASELINE', program: [{ op: 'OPERATOR', key: 'partner:', target: o.opportunity.id }] });
    const inbound = byDim('ACQUISITION')[0];
    if (inbound) add({ name: `Forward: buy demand for "${title(o)}"`, stance: 'FORWARD', thinking: 'Start from an opening already held and buy buyers who are already asking for it.', from: 'BASELINE', program: [{ op: 'OPERATOR', key: inbound.key.split('@')[0]!, target: o.opportunity.id }] });
  }

  // MIDDLE-OUT: from §99's strongest plan, take each change away and put each alternative in its place.
  for (const label of greedyKeys) {
    const without = ctx.greedy.changes.filter((c) => c.label !== label);
    const program: Transform[] = without.map((c) => ({ op: 'OPERATOR', key: opKeyOf(c, ops) })).filter((t): t is Transform & { op: 'OPERATOR' } => !!t.key);
    add({ name: `Middle-out: the plan without ${label}`, stance: 'MIDDLE_OUT', thinking: `Start from the strongest plan and ask whether ${label} carries its weight.`, from: 'BASELINE', program });
    const dim = ctx.greedy.changes.find((c) => c.label === label)?.dimension;
    const own = opKeyOf(ctx.greedy.changes.find((c) => c.label === label)!, ops);
    for (const alt of ops.filter((o) => o.dimension === dim && o.key !== own).slice(0, 3)) add({ name: `Middle-out: ${alt.key} in place of ${label}`, stance: 'MIDDLE_OUT', thinking: 'Keep the shape of the strongest plan and swap one of its moves for another of the same kind.', from: 'BASELINE', program: [...program, { op: 'OPERATOR', key: alt.key }] });
  }

  // CONSTRAINT: each binding factor, attacked by every operator that moves it.
  const dimsFor: Record<string, string[]> = { VOLUME: ['CAPACITY', 'ACQUISITION', 'PARTNER'], REPLY: ['ACQUISITION', 'PARTNER'], CLOSE: ['PARTNER'], PRICE: ['TRANSACTION'], CASH_TIMING: ['CASH_TIMING', 'CAPITAL'], CAPITAL: ['CAPITAL'], MARKET_SIZE: ['ACQUISITION', 'PARTNER', 'TRANSACTION'] };
  for (const b of ctx.binding.filter((x) => x.liftReach > 0).slice(0, 4)) {
    for (const op of (dimsFor[b.factor] ?? []).flatMap(byDim).slice(0, 5)) add({ name: `Constraint: relieve ${b.factor} with ${op.key}`, stance: 'CONSTRAINT', thinking: `${b.factor} binds (lift ${pct(b.liftReach)}); change what moves it instead of hoping the estimate is wrong.`, from: 'GREEDY', program: [{ op: 'OPERATOR', key: op.key }] });
    if (b.factor === 'PRICE' || b.factor === 'MARKET_SIZE') for (const k of [1.5, 2.5]) add({ name: `Constraint: price ×${k} where tickets are small`, stance: 'CONSTRAINT', thinking: 'Fewer deals at a higher price need less market and less capacity; the close rate pays for it.', from: 'GREEDY', program: [{ op: 'PRICE', factor: k, scope: 'SMALL_TICKET' }] });
  }

  // RESOURCE: what the money the owner set aside buys when spent on each lever alone.
  for (const op of [...byDim('CAPACITY'), ...byDim('ACQUISITION')]) add({ name: `Resource: spend on ${op.key}`, stance: 'RESOURCE', thinking: 'Start from the money and capacity available and ask what each use of them buys.', from: 'BASELINE', program: [{ op: 'OPERATOR', key: op.key }] });

  // RELATIONSHIP: each opening sold through someone who already holds its buyers.
  for (const o of sellable.slice(0, 6)) add({ name: `Relationship: "${title(o)}" through a partner, financed by the buyer`, stance: 'RELATIONSHIP', thinking: 'Somebody already sells to these buyers; sell through them and let the buyer fund the work.', from: 'GREEDY', program: [{ op: 'OPERATOR', key: 'partner:', target: o.opportunity.id }, { op: 'OPERATOR', key: 'capital:prepaid' }] });

  // INVERSION: what would make the plan fail, removed.
  add({ name: 'Inversion: drop what settles slowly', stance: 'INVERSION', thinking: 'A plan fails when cash arrives after the deadline; remove the slow openings and ask for deposits on the rest.', from: 'GREEDY', program: [{ op: 'DROP', scope: 'SLOW_CASH' }, { op: 'OPERATOR', key: 'timing:deposit' }] });
  add({ name: 'Inversion: drop the small tickets', stance: 'INVERSION', thinking: 'A plan fails when capacity is spent on deals too small to matter; free it for the large ones.', from: 'GREEDY', program: [{ op: 'DROP', scope: 'SMALL_TICKET' }] });
  add({ name: 'Inversion: never wait for a buyer\'s money', stance: 'INVERSION', thinking: 'A plan fails when the owner\'s money runs out first; make every buyer prepay.', from: 'GREEDY', program: [{ op: 'OPERATOR', key: 'capital:prepaid' }, { op: 'OPERATOR', key: 'timing:deposit' }] });

  // OPPORTUNITY: openings the plan left out, given a channel of their own.
  const rest = ranked.filter((o) => !ctx.greedy.openings.some((g) => g.opportunity.id === o.opportunity.id) || inScope(ctx.base.openings, 'REST', ctx.remaining).has(o.opportunity.id));
  for (const o of rest.filter(outreach).slice(0, 5)) add({ name: `Opportunity: give "${title(o)}" its own channel`, stance: 'OPPORTUNITY', thinking: 'An opening the plan under-used may only lack a way to reach its buyers.', from: 'GREEDY', program: [{ op: 'OPERATOR', key: 'partner:', target: o.opportunity.id }] });

  // TRANSACTION: change what is sold, not to whom.
  for (const op of byDim('TRANSACTION')) add({ name: `Transaction: ${op.key} on the strongest plan`, stance: 'TRANSACTION', thinking: 'Sell more per buyer instead of more buyers.', from: 'GREEDY', program: [{ op: 'OPERATOR', key: op.key }] });
  add({ name: 'Transaction: premium on the top openings', stance: 'TRANSACTION', thinking: 'The openings that settle most per buyer may bear a higher price.', from: 'GREEDY', program: [{ op: 'PRICE', factor: 1.5, scope: 'TOP' }] });

  // PORTFOLIO: concentrate or spread.
  for (const n of [2, 3, 5]) if (openings.length > n) add({ name: `Portfolio: concentrate on ${n}`, stance: 'PORTFOLIO', thinking: 'Shared capacity spread thin may reach nothing; concentrate it.', from: 'GREEDY', program: [{ op: 'FOCUS', count: n }] });

  // INCLUSION: a constructed arrangement the first cut left out, added — or in place of the weakest estimate held (S-6).
  const weakestEstimate = [...openings].filter((o) => o.estimated).sort((a, b) => valuePerInterested(a) - valuePerInterested(b) || (a.opportunity.id < b.opportunity.id ? -1 : 1))[0];
  for (const r of ctx.reserve ?? []) {
    add({ name: `Inclusion: bring in "${title(r)}"`, stance: 'INCLUSION', thinking: 'The first cut ranked arrangements cheaply; let the engine judge one it left out beside the strongest plan.', from: 'GREEDY', program: [{ op: 'INCLUDE', key: r.opportunity.id }] });
    if (weakestEstimate) add({ name: `Inclusion: "${title(r)}" in place of "${title(weakestEstimate)}"`, stance: 'INCLUSION', thinking: 'A cut arrangement may beat the weakest one admitted; swap them and let the engine decide.', from: 'GREEDY', program: [{ op: 'INCLUDE', key: r.opportunity.id }, { op: 'DROP', scope: `id:${weakestEstimate.opportunity.id}` }] });
  }
  return out;
}

// ---------------------------------------------------------------- seed budget by stance (lens S, S-10)

/** A stance's record across every goal, as the learning store holds it. */
export interface StanceRecord {
  tries: number;
  improvements: number;
  wins: number;
}
export type StancePrior = Record<string, StanceRecord>;

/** Each stance keeps at least this share of an even split of the seed budget, however poorly it has done. */
export const STANCE_FLOOR = 0.5;

/** The posterior mean of a stance's chance to improve the plan: Beta(1, 1) updated by its credited tries. */
export function stancePosterior(r: StanceRecord | undefined): number {
  const tries = Math.max(0, r?.tries ?? 0);
  return (1 + Math.min(tries, Math.max(0, r?.improvements ?? 0))) / (2 + tries);
}

/**
 * How many of `slots` seeds each stance gets. Every stance first receives its
 * floor — `STANCE_FLOOR` of an even share, at least one, never more than it
 * has seeds — strongest posterior first, so a budget smaller than the number
 * of stances still goes to the best; the rest is split in proportion to each
 * stance's posterior. With no record every stance is even.
 */
export function stanceQuotas(available: Map<string, number>, slots: number, prior: StancePrior = {}): Map<string, number> {
  const post = new Map([...available.keys()].map((s) => [s, stancePosterior(prior[s])]));
  const order = [...available.keys()].sort((a, b) => post.get(b)! - post.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  const quota = new Map(order.map((s) => [s, 0]));
  if (order.length === 0 || slots <= 0) return quota;
  let left = slots;
  const floor = Math.max(1, Math.floor((STANCE_FLOOR * slots) / order.length));
  for (const s of order) {
    const give = Math.min(floor, available.get(s)!, left);
    quota.set(s, give);
    left -= give;
  }
  while (left > 0) {
    const open = order.filter((s) => quota.get(s)! < available.get(s)!);
    if (open.length === 0) break;
    const weight = open.reduce((n, s) => n + post.get(s)!, 0);
    let given = 0;
    for (const s of open) {
      const g = Math.min(Math.floor((left * post.get(s)!) / weight), available.get(s)! - quota.get(s)!);
      quota.set(s, quota.get(s)! + g);
      given += g;
    }
    // Shares below one seed each: the strongest stance with room takes the next.
    if (given === 0) {
      quota.set(open[0]!, quota.get(open[0]!)! + 1);
      given = 1;
    }
    left -= given;
  }
  return quota;
}

/**
 * The seeds in the order the pool takes them: each stance's quota for `slots`
 * interleaved strongest stance first, then every seed left over in the order
 * it was generated, for slots near-copies free up. Without this the pool took
 * the seeds in generation order, so the same stances filled it every read.
 */
export function allocateSeeds(seeds: Direction[], slots: number, prior: StancePrior = {}): Direction[] {
  const byStance = new Map<string, Direction[]>();
  for (const d of seeds) byStance.set(d.stance, [...(byStance.get(d.stance) ?? []), d]);
  const quota = stanceQuotas(new Map([...byStance].map(([s, ds]) => [s, ds.length])), slots, prior);
  const first: Direction[] = [];
  const most = Math.max(0, ...quota.values());
  for (let r = 0; r < most; r++) for (const [s, q] of quota) if (r < q) first.push(byStance.get(s)![r]!);
  const taken = new Set(first);
  return [...first, ...seeds.filter((d) => !taken.has(d))];
}

function opKeyOf(c: StrategyChange, ops: StrategyOperator[]): string {
  // A change names the operator that wrote it; an older change is matched by its label.
  if (c.op) return c.op;
  const op = ops.find((o) => o.dimension === c.dimension && (o.key.endsWith(`:${c.label}`) || o.key.split(':')[1] === c.label));
  return op?.key ?? '';
}

/** A plan as the program that builds it from the plan as held: its recorded moves, or its operators when it records none. */
export function programOf(state: StrategyState, ops: StrategyOperator[]): Transform[] {
  if (state.program) return state.program;
  return state.changes.map((c) => ({ op: 'OPERATOR' as const, key: opKeyOf(c, ops) })).filter((t) => t.key);
}

// ---------------------------------------------------------------- evolution

/** Combine two directions of different stances: both programs, from the stronger start. */
export function recombine(a: Direction, b: Direction): Direction {
  // One move per family: a move of `b` whose family `a` already holds (another budget, another price, another shape) is dropped, not stacked.
  const held = new Set(a.program.map(familyOf).filter((f): f is string => !!f));
  const program = [...a.program, ...b.program.filter((t) => !a.program.some((x) => token(x) === token(t)) && !(familyOf(t) !== null && held.has(familyOf(t)!)))];
  return makeDirection({
    name: `${a.name.slice(0, 60)} + ${b.name.slice(0, 60)}`,
    stance: a.stance === b.stance ? a.stance : `${a.stance}+${b.stance}`,
    origin: 'RECOMBINED',
    thinking: `Combines "${a.name}" with "${b.name}".`,
    // The stronger parent's start: a full reconstruction combined with a refinement stays a reconstruction.
    from: a.from,
    program,
    parents: [a.signature, b.signature],
  });
}

/** Modify a direction: re-point an operator at another opening, take a step back, or start it from scratch. */
export function mutate(d: Direction, ctx: Pick<ExploreContext, 'base' | 'operators' | 'reserve'>, salt: number): Direction[] {
  const out: Direction[] = [];
  const ids = ctx.base.openings.filter(outreach).map((o) => o.opportunity.id);
  const reserveIds = (ctx.reserve ?? []).map((o) => o.opportunity.id);
  d.program.forEach((t, i) => {
    if (t.op === 'INCLUDE' && reserveIds.length > 1) {
      const other = reserveIds[(reserveIds.indexOf(t.key) + 1 + salt) % reserveIds.length]!;
      if (other !== t.key && !d.program.some((x) => x.op === 'INCLUDE' && x.key === other)) out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name} (another cut arrangement)`, program: d.program.map((x, j) => (j === i ? { ...t, key: other } : x)), parents: [d.signature] }));
    }
    if (t.op === 'OPERATOR' && t.target && ids.length > 1) {
      const other = ids[(ids.indexOf(t.target) + 1 + salt) % ids.length]!;
      if (other !== t.target) out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name} (re-pointed)`, program: d.program.map((x, j) => (j === i ? { ...t, target: other } : x)), parents: [d.signature] }));
    }
    if (t.op === 'OPERATOR' && t.key.includes('@')) {
      const family = t.key.split('@')[0]!;
      const siblings = ctx.operators.filter((o) => o.key.startsWith(`${family}@`) && o.key !== t.key);
      const sib = siblings[salt % Math.max(1, siblings.length)];
      if (sib) out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name} (${sib.key.split('@')[1]} budget)`, program: d.program.map((x, j) => (j === i ? { ...t, key: sib.key } : x)), parents: [d.signature] }));
    }
    // A price step past the clamp is the same move under another name, so it is not a new direction.
    if (t.op === 'PRICE' && clampPrice(t.factor * 1.5) > clampPrice(t.factor)) {
      const next = clampPrice(t.factor * 1.5);
      out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name.replace(/ \(price ×[0-9.]+\)/g, '')} (price ×${next.toFixed(2)})`, program: d.program.map((x, j) => (j === i ? { ...t, factor: next } : x)), parents: [d.signature] }));
    }
    if (t.op === 'FOCUS') out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name} (${t.count + 1})`, program: d.program.map((x, j) => (j === i ? { ...t, count: t.count + 1 } : x)), parents: [d.signature] }));
  });
  if (d.program.length > 1) out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name} (without its last move)`, program: d.program.slice(0, -1), parents: [d.signature] }));
  // Replace rather than refine: the same idea rebuilt from the plan as held.
  if (d.from === 'GREEDY') out.push(makeDirection({ ...d, origin: 'MUTATED', name: `${d.name} (rebuilt from scratch)`, from: 'BASELINE', parents: [d.signature] }));
  return out;
}

// ---------------------------------------------------------------- the loop

const MATERIAL = 0.02;

export function scoreOf(reading: VariantReading, challenged: VariantReading | null): number {
  if (!reading.feasible) return -1;
  const held = challenged?.feasible ? challenged.reach : 0;
  // Reach and challenged reach weigh equally; between equals, fewer assumptions win, then median cash.
  const assumed = reading.changes.filter((c) => c.basis === 'ASSUMPTION' && c.dimension !== 'EVIDENCE').length;
  return 0.5 * reading.reach + 0.5 * held - 0.002 * assumed + 1e-9 * reading.settledP50;
}

export async function exploreDirections(ctx: ExploreContext): Promise<Exploration> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const wallStarted = Date.now();
  // Depth is bounded by evaluations, so the same inputs explore the same way on a busy or an idle machine,
  // and by the clock, because an evaluation on production's data costs about a second (Goals plan
  // 42938331961, 2026-11-11: an exploration bounded only between generations ran past 20 minutes).
  // Both are checked before every evaluation, in chunks no wider than the threads can run at once.
  const maxMs = ctx.maxMs ?? DEFAULT_MAX_MS;
  let evaluationCap = MAX_EVALUATIONS;
  const late = () => now() - started > maxMs || evaluations >= evaluationCap;
  const chunk = Math.max(2, ctx.threads * 2);
  /** Run `fn` over `rows` in chunks, stopping before a chunk once the exploration is out of evaluations or time. */
  const inChunks = async <T, R>(rows: T[], fn: (row: T) => Promise<R>): Promise<R[]> => {
    const out: R[] = [];
    for (let i = 0; i < rows.length && !late(); i += chunk) out.push(...(await Promise.all(rows.slice(i, i + chunk).map(fn))));
    return out;
  };
  const seen = new Map<string, DirectionReading>();
  const all: DirectionReading[] = [];
  let evaluations = 0;
  const model = { calls: 0, proposed: 0, refused: 0, error: null as string | null };

  // The role each opening plays here, for learning that transfers across goals (S-8).
  const roles = rolesOf(ctx);
  const roleIds = new Map([...Object.entries(roles)].map(([id, role]) => [role, id]));

  // The model invents while the cheap seeds are screened: the two run at the same time.
  const brief = inventBrief(ctx);
  const invented = ctx.invent ? ctx.invent(brief).catch((e: unknown) => ({ directions: [] as Direction[], calls: 0, proposed: 0, refused: 0, error: String((e as Error)?.message ?? e) })) : null;

  // §99's plan as a program, so every direction runs from the plan as held and can be challenged move by move.
  const greedyProgram: Transform[] = programOf(ctx.greedy, ctx.operators);
  const full = (d: Direction): Transform[] => (d.from === 'GREEDY' ? [...greedyProgram, ...d.program] : d.program);
  const start = (_d: Direction) => ctx.base;
  const run = async (batch: Direction[], generation: number): Promise<DirectionReading[]> => {
    const fresh = batch.filter((d) => !seen.has(d.signature));
    const results = await inChunks(
      fresh,
      async (d) => {
        if (seen.has(d.signature) || late()) return null;
        const placeholder = { direction: d } as DirectionReading;
        seen.set(d.signature, placeholder);
        const { state, skipped } = applyProgram(start(d), full(d), ctx);
        const applied = skipped < full(d).length || full(d).length === 0;
        if (!applied || (d.from === 'GREEDY' && (state.program?.length ?? state.changes.length) <= greedyProgram.length)) {
          seen.delete(d.signature);
          return null;
        }
        evaluations++;
        const reading = await ctx.evaluate(state, true);
        const out: DirectionReading = { direction: d, reading, challenged: null, score: scoreOf(reading, null), generation, applied, state };
        seen.set(d.signature, out);
        return out;
      },
    );
    // In the batch's own order, never the order threads finished in: ties must break the same way every read.
    const kept = results.filter((x): x is DirectionReading => !!x);
    all.push(...kept);
    return kept;
  };
  // Strongest first, so a budget that runs out leaves the weakest unchallenged (an unchallenged direction scores as if it held nothing).
  const challenge = async (rows: DirectionReading[]) => {
    await inChunks(
      [...rows].sort((a, b) => b.reading.reach - a.reading.reach),
      async (r) => {
        if (r.challenged || !r.reading.feasible || late()) return;
        const c = await challengeOf(full(r.direction));
        r.challenged = c.weaker;
        r.bare = c.bare;
        r.score = scoreOf(r.reading, r.challenged);
      },
    );
  };

  /**
   * The challenge every leader must survive: the weaker of (a) its conversion
   * halved and (b) every move that rests on an assumption taken away. A plan
   * that only reaches the target if its assumptions hold ranks below one that
   * holds without them.
   */
  const challengeOf = async (program: Transform[]): Promise<{ weaker: VariantReading; bare: VariantReading }> => {
    evaluations += 2;
    const [halved, bare] = await Promise.all([
      ctx.evaluate(applyProgram(ctx.base, [...program, ...challengeProgram()], ctx).state, true, ' @challenge'),
      ctx.evaluate(applyProgram(ctx.base, program, ctx, true).state, true, ' @no-assumptions'),
    ]);
    return { weaker: halved.reach <= bare.reach ? halved : bare, bare };
  };
  /** A reading the plausibility critic flagged is kept for the record, but never leads and never wins (C-4). */
  const plausible = (r: DirectionReading) => !(r.reading.implausible?.length);
  /**
   * C-15: a direction may replace §99's plan only if it holds once challenged — its challenged reach at least
   * WINNER_ALPHA of the requirement — or what it holds on no assumed move beats the plan as held.
   */
  const eligible = (r: DirectionReading) =>
    plausible(r) && !!r.challenged && (r.challenged.reach >= ctx.required * WINNER_ALPHA || (!!r.bare && r.bare.feasible && r.bare.reach >= ctx.baselineReading.reach + MATERIAL));

  // The plan §99 built is a direction too, and it is challenged like every other.
  const greedyDirection = makeDirection({ name: 'Greedy: §99 one dimension at a time', stance: 'GREEDY', origin: 'ALGORITHM', thinking: 'Change the dimension that helps most, then the next, while each helps.', from: 'GREEDY', program: [] });
  const greedyRow: DirectionReading = { direction: greedyDirection, reading: ctx.greedyReading, challenged: null, score: 0, generation: 0, applied: true };
  const greedyChallenge = await challengeOf(greedyProgram);
  greedyRow.challenged = greedyChallenge.weaker;
  greedyRow.bare = greedyChallenge.bare;
  greedyRow.score = scoreOf(ctx.greedyReading, greedyRow.challenged);
  const budget = explorationBudget({ openings: ctx.base.openings.length + (ctx.heldOpenings ?? 0), operators: ctx.operators.length, binding: ctx.binding.filter((b) => b.liftReach > 0).length, reach: Math.min(ctx.greedyReading.reach, greedyRow.challenged?.reach ?? 0), required: ctx.required, structural: ctx.structural });
  evaluationCap = Math.min(MAX_EVALUATIONS, evaluations + EVALUATIONS_PER_DIRECTION * budget);

  // 1–2. Generate and screen: the library first (what worked), then the cheap seeds, kept distinct.
  // The sweep's strategies first: each is the best of tens of thousands of combinations by its own objective (§102).
  const swept = ctx.sweep?.directions ?? [];
  // A learned method names roles, not this goal's ids (S-8): resolved here, and one that names what this problem lacks is dropped, never given a slot.
  const library = (ctx.library ?? []).map((d) => resolveRoles(d, roleIds)).filter((d): d is Direction => !!d);
  // The seeds' share of the budget is allocated by stance, by what each stance has yielded across goals (S-10).
  const seeds = allocateSeeds(seedDirections(ctx), Math.max(0, budget - library.length), ctx.stancePrior);
  const pool = budget > 0 ? distinct([...swept, ...library, ...seeds], budget + swept.length) : [];
  await run(pool, 1);

  // The model's directions join as soon as they arrive.
  const rejections: string[] = [];
  if (invented && budget > 0) {
    // Best-effort: the lane never holds the read past the exploration's own clock (wall time, whatever `now` says).
    const wait = Math.max(1, maxMs - (Date.now() - wallStarted));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const got = await Promise.race([
      invented,
      new Promise<{ directions: Direction[]; calls: number; proposed: number; refused: number; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ directions: [], calls: 0, proposed: 0, refused: 0, error: `the model lane did not answer within the exploration's ${Math.round(maxMs / 1000)} s clock` }), wait);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    model.calls = got.calls;
    model.proposed = got.proposed;
    model.refused = got.refused;
    model.error = got.error;
    rejections.push(...(('rejections' in got ? got.rejections : undefined) ?? []));
    // A method carrying a new design is composed first: its arrangement joins the reserve its INCLUDE reads (S-11).
    const composed = composeInventedDesigns(got.directions, ctx);
    model.refused += composed.rejections.length;
    rejections.push(...composed.rejections);
    if (composed.reserve.length) ctx = { ...ctx, reserve: [...(ctx.reserve ?? []), ...composed.reserve] };
    const room = Math.max(0, budget - all.length) + Math.ceil(budget / 4);
    await run(distinct(composed.directions, room, all.map((r) => r.direction)), 1);
  }

  // 3. Evolve: the leaders challenge, combine, modify and replace one another.
  // Every direction that improves the plan as held is challenged, not only the most optimistic: a robust plan is often not the one with the highest reach.
  const improving = (rows: DirectionReading[]) => rows.filter((r) => r.reading.feasible && r.reading.reach >= ctx.baselineReading.reach + MATERIAL);
  await challenge(improving(all));
  let leaders: DirectionReading[];
  leaders = diverseLeaders([greedyRow, ...all.filter(plausible)]);
  let generations = 1;
  let bestScore = leaders[0]?.score ?? greedyRow.score;
  for (let g = 2; g <= MAX_GENERATIONS && budget > 0 && !late(); g++) {
    const parents = leaders.filter((l) => l !== greedyRow);
    const children: Direction[] = [];
    for (let i = 0; i < parents.length; i++)
      for (let j = i + 1; j < parents.length; j++) {
        const a = parents[i]!.direction;
        const b = parents[j]!.direction;
        if (a.stance !== b.stance && distance(a, b) > 0.5) children.push(recombine(a, b));
      }
    parents.forEach((p, i) => children.push(...mutate(p.direction, ctx, g + i)));
    const room = Math.max(LEADERS, Math.ceil(budget / 3));
    const evaluated = await run(distinct(children, room, all.map((r) => r.direction)), g);
    if (evaluated.length === 0) break;
    generations = g;
    await challenge(improving(evaluated));
    leaders = diverseLeaders([greedyRow, ...all.filter(plausible)]);
    const top = leaders[0]?.score ?? bestScore;
    if (top < bestScore + MATERIAL / 2) break;
    bestScore = top;
  }

  // 4. Conclude.
  const ranked = rank([greedyRow, ...all]);
  // The strongest direction that may win: plausible, and holding once challenged (C-4, C-15).
  const top = ranked.find((r) => r === greedyRow || eligible(r)) ?? greedyRow;
  const winner = top !== greedyRow && top.score > greedyRow.score + MATERIAL / 4 ? top : null;
  const baseReach = ctx.baselineReading.reach;
  const stanceOf = (s: string) => s.split('+');
  const stanceMap = new Map<string, { directions: number; improved: number; bestLift: number }>();
  for (const r of all)
    for (const s of stanceOf(r.direction.stance)) {
      const row = stanceMap.get(s) ?? { directions: 0, improved: 0, bestLift: -1 };
      row.directions++;
      const lift = r.reading.reach - baseReach;
      if (lift >= MATERIAL) row.improved++;
      row.bestLift = Math.max(row.bestLift, lift);
      stanceMap.set(s, row);
    }
  const stanceYield = [...stanceMap.entries()].map(([stance, v]) => ({ stance, ...v })).sort((a, b) => b.improved - a.improved || b.bestLift - a.bestLift);
  const discoveries = rank(all.filter((r) => r.direction.origin === 'MODEL' && r.reading.reach - baseReach >= MATERIAL)).slice(0, 10);
  const asks = [...new Set([...(ctx.sweep?.asks ?? []), ...all.map((r) => r.direction.ask).filter((a): a is string => !!a && a.length > 10)])].slice(0, 6);
  const byOrigin: Record<Origin, number> = { ALGORITHM: 0, MODEL: 0, LIBRARY: 0, RECOMBINED: 0, MUTATED: 0 };
  for (const r of all) byOrigin[r.direction.origin]++;
  const replaced = !!winner && winner.direction.from === 'BASELINE';
  const stances = [...stanceMap.keys()];
  const elapsedMs = now() - started;
  const stopped: Exploration['stopped'] = evaluations >= evaluationCap ? 'EVALUATIONS' : elapsedMs > maxMs ? 'TIME' : 'CONVERGED';
  const sentence =
    `${all.length} distinct direction(s) across ${stances.length} stance(s) (${byOrigin.MODEL} from Brain's model, ${byOrigin.LIBRARY} from what worked before, ${byOrigin.RECOMBINED + byOrigin.MUTATED} by combining and modifying leaders) over ${generations} generation(s); ` +
    (winner
      ? `"${winner.direction.name}" (${winner.direction.stance}) ${replaced ? 'replaced' : 'improved'} §99's plan: reach ${pct(winner.reading.reach)} and ${pct(winner.challenged?.reach ?? 0)} with its conversion halved, against ${pct(ctx.greedyReading.reach)} and ${pct(greedyRow.challenged?.reach ?? 0)}.`
      : `none beat §99's plan once challenged (${pct(ctx.greedyReading.reach)}, ${pct(greedyRow.challenged?.reach ?? 0)} with its conversion halved).`) +
    ` ${evaluations} evaluation(s) in ${Math.round(elapsedMs / 1000)} s; stopped ${stopped === 'CONVERGED' ? 'when nothing improved' : stopped === 'TIME' ? 'at its time bound' : 'at its evaluation bound'}.`;
  return {
    budget,
    directions: all.length,
    stances,
    byOrigin,
    generations,
    threads: ctx.threads,
    evaluations,
    elapsedMs,
    stopped,
    baseline: { reach: ctx.baselineReading.reach, settledP50: ctx.baselineReading.settledP50 },
    greedy: { reach: ctx.greedyReading.reach, settledP50: ctx.greedyReading.settledP50, score: greedyRow.score, challengedReach: greedyRow.challenged?.reach ?? 0 },
    winner,
    replaced,
    leaders: diverseLeaders(ranked.filter((r) => r === greedyRow || plausible(r))),
    all,
    stanceYield,
    discoveries,
    asks,
    model: rejections.length ? { ...model, rejections: rejections.slice(0, 20) } : model,
    roles,
    sweep: ctx.sweep ?? null,
    sentence: ctx.sweep ? `${sentence} Variable sweep: ${ctx.sweep.variations.toLocaleString('en-US')} variation(s) read, ${swept.length} strategy(ies) handed to the engine.` : sentence,
  };
}

function rank(rows: DirectionReading[]): DirectionReading[] {
  return [...rows].sort((a, b) => b.score - a.score || b.reading.reach - a.reading.reach || b.reading.settledP50 - a.reading.settledP50 || (a.direction.signature < b.direction.signature ? -1 : a.direction.signature > b.direction.signature ? 1 : 0));
}

/** The strongest directions that are not near-copies of a stronger one: leaders must disagree to challenge one another. */
export function diverseLeaders(rows: DirectionReading[], n = LEADERS): DirectionReading[] {
  const out: DirectionReading[] = [];
  for (const r of rank(rows)) {
    if (out.length >= n) break;
    if (out.some((k) => distance(k.direction, r.direction) < 0.34 && Math.abs(k.score - r.score) < 0.01)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Keep directions that are distinct lines of reasoning: a signature already
 * held is dropped, and so is one within a small distance of a kept direction
 * of the same stance — a near-copy is a variation, not a new direction.
 */
export function distinct(candidates: Direction[], max: number, held: Direction[] = []): Direction[] {
  const kept: Direction[] = [];
  const sigs = new Set(held.map((d) => d.signature));
  for (const d of candidates) {
    if (kept.length >= max) break;
    if (sigs.has(d.signature)) continue;
    if ([...kept, ...held].some((k) => k.stance === d.stance && k.from === d.from && distance(k, d) < 0.2)) continue;
    sigs.add(d.signature);
    kept.push(d);
  }
  return kept;
}

// ---------------------------------------------------------------- roles: methods that transfer across goals (S-8)

const ROLE = '@';

/**
 * The role each opening plays in this problem: `@RANK:k` for the k-th open
 * opening by value per interested buyer (unknowns at their low end), and
 * `@RESERVE:k` for the k-th constructed arrangement in reserve. A method
 * recorded in roles ("a partner on the strongest opening") applies to any
 * goal; one recorded with ids applied only to the goal that found it.
 */
export function rolesOf(ctx: Pick<ExploreContext, 'base' | 'reserve'>): Record<string, string> {
  const roles: Record<string, string> = {};
  [...ctx.base.openings]
    .filter((o) => o.agreedValue === 0)
    .sort((a, b) => valuePerInterested(b) - valuePerInterested(a) || (a.opportunity.id < b.opportunity.id ? -1 : 1))
    .forEach((o, i) => (roles[o.opportunity.id] = `${ROLE}RANK:${i + 1}`));
  (ctx.reserve ?? []).forEach((o, i) => (roles[o.opportunity.id] = `${ROLE}RESERVE:${i + 1}`));
  return roles;
}

/** Map every opening a program names through `map`; null when one cannot be mapped. A clone (`id~suffix`) keeps its suffix. */
function mapIds(program: Transform[], map: (id: string) => string | undefined): Transform[] | null {
  const one = (id: string): string | undefined => {
    const [head, ...rest] = id.split('~');
    const mapped = map(head!);
    return mapped === undefined ? undefined : [mapped, ...rest].join('~');
  };
  const out: Transform[] = [];
  for (const t of program) {
    if (t.op === 'OPERATOR' && t.target) {
      const target = one(t.target);
      if (target === undefined) return null;
      out.push({ ...t, target });
    } else if ((t.op === 'PRICE' || t.op === 'DROP' || t.op === 'STRESS') && t.scope.startsWith('id:')) {
      const id = one(t.scope.slice(3));
      if (id === undefined) return null;
      out.push({ ...t, scope: `id:${id}` });
    } else if (t.op === 'INCLUDE') {
      const key = one(t.key);
      if (key === undefined) return null;
      out.push({ ...t, key });
    } else out.push(t);
  }
  return out;
}

/** A direction with its ids replaced by the roles they played; null when it names an opening no role covers. */
export function abstractDirection(d: Direction, roles: Record<string, string>): Direction | null {
  const program = mapIds(d.program, (id) => (id.startsWith(ROLE) ? id : roles[id]));
  return program ? makeDirection({ ...d, program }) : null;
}

/**
 * A learned direction resolved onto this problem: each role to the opening
 * playing it here. An older method recorded with ids resolves only where those
 * ids exist. Null when it names a role or an opening this problem lacks.
 */
export function resolveRoles(d: Direction, roleIds: Map<string, string>): Direction | null {
  const ids = new Set(roleIds.values());
  const program = mapIds(d.program, (id) => (id.startsWith(ROLE) ? roleIds.get(id) : ids.has(id) ? id : undefined));
  if (!program) return null;
  return program === d.program ? d : makeDirection({ ...d, program });
}

export function inventBrief(ctx: ExploreContext): InventBrief {
  const n = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
  return {
    remaining: Math.round(ctx.remaining),
    daysLeft: ctx.daysLeft,
    required: ctx.required,
    baseline: { reach: n(ctx.baselineReading.reach)!, settledP50: Math.round(ctx.baselineReading.settledP50) },
    greedy: { reach: n(ctx.greedyReading.reach)!, settledP50: Math.round(ctx.greedyReading.settledP50), changes: ctx.greedy.changes.map((c) => `${c.dimension}: ${c.detail}`.slice(0, 160)) },
    binding: ctx.binding.slice(0, 7).map((b) => ({ factor: b.factor, liftReach: n(b.liftReach)! })),
    structural: ctx.structural,
    openings: [...ctx.base.openings]
      .sort((a, b) => valuePerInterested(b) - valuePerInterested(a))
      .slice(0, 14)
      .map((o) => ({ id: o.opportunity.id, title: o.opportunity.title.slice(0, 80), price: n(mid(o.price)), close: n(mid(o.close)), respond: n(mid(o.respond)), volume: n(mid(o.volume)), daysToCash: n(mid(o.daysToCash)), outreach: outreach(o), agreed: o.agreedValue > 0 })),
    operators: ctx.operators.map((o) => ({ key: o.key, dimension: o.dimension })),
    ...(ctx.reserve?.length ? { reserve: ctx.reserve.slice(0, BRIEF_RESERVE).map((o) => ({ id: o.opportunity.id, title: o.opportunity.title.slice(0, 80), price: n(rankValue(o.price)), repeatable: o.repeatable })) } : {}),
    ...(ctx.design ? { designs: { structures: STRUCTURE_KEYS.map((key) => ({ key, label: STRUCTURES[key].label })), funding: FUNDING, aggregation: AGGREGATION, repeat: REPEAT } } : {}),
    stancesTried: ['BACKWARD', 'FORWARD', 'MIDDLE_OUT', 'CONSTRAINT', 'RESOURCE', 'RELATIONSHIP', 'INVERSION', 'OPPORTUNITY', 'TRANSACTION', 'PORTFOLIO', 'INCLUSION', ...new Set((ctx.library ?? []).map((d) => d.stance))],
    bestKnown: (ctx.library ?? []).slice(0, 6).map((d) => ({ name: d.name, stance: d.stance, thinking: d.thinking })),
  };
}

// ---------------------------------------------------------------- parsing a model's methods

const FIELDS: readonly Field[] = ['price', 'close', 'respond', 'volume', 'daysToCash', 'directCost'];
const SCOPES = ['ALL', 'OUTREACH', 'SMALL_TICKET', 'LARGE_TICKET', 'FAST_CASH', 'SLOW_CASH', 'TOP', 'REST'];

/** A closed-vocabulary word as a model writes it: case, spaces and hyphens are form, not meaning. */
const word = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim().toUpperCase().replace(/[\s-]+/g, '_') : null);
/** A number a model wrote as a number or as a numeric string. */
const numberOf = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
/** An opening or arrangement id as a model writes it: bare, or with the `id:` a scope uses. */
const idOf = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim().replace(/^id:/i, '') : null);

/**
 * Whether a model's `design` field says "no design". The prompt marked the
 * design optional, and models answer an optional object with `null`, `{}`,
 * `""` or a placeholder rather than leaving the key out. Production,
 * 2026-11-14 (plan-0008): 4 calls, 16 methods proposed, 16 refused as
 * off-shape — a method carrying such an empty design was refused as a
 * malformed design although it proposed none, and every other refusal was
 * silent, so nothing recorded why. An object that names a structure or a
 * buyer population is an attempt at a design and is judged as one; anything
 * else is the absence of one.
 */
function noDesign(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === false) return true;
  if (typeof raw === 'string') return !raw.trim() || /^(none|null|n\/a|optional|\.\.\.|\{\.\.\.optional\})$/i.test(raw.trim());
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const x = raw as Record<string, unknown>;
  const said = (k: string) => typeof x[k] === 'string' && (x[k] as string).trim().length > 0;
  return !said('structure') && !said('base') && !said('population');
}

/**
 * Validate a model's answer into directions. Off-shape methods are refused,
 * never repaired, and every refusal says why; a transform naming an operator
 * or opening that does not exist is refused with it. A model may name any
 * stance. Form is read leniently — the case of a vocabulary word, a number
 * written as a string, an id with or without its `id:`, an empty optional
 * design — because none of that changes what the method means.
 */
/** Remove commas that close nothing (`[1,2,]`, `{"a":1,}`), outside strings. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** The end (exclusive) of the balanced `{…}` or `[…]` opening at `start`, strings respected; null when it never closes. */
function balancedEnd(text: string, start: number): number | null {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) return i + 1;
    }
  }
  return null;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  for (const t of [text, stripTrailingCommas(text)]) {
    try {
      return { ok: true, value: JSON.parse(t) };
    } catch {
      /* next form */
    }
  }
  return { ok: false };
}

/**
 * The JSON payload inside a model's answer (F9.2, production 2026-11-15: the
 * free switchboard answered half the reasoning calls with something other than
 * bare JSON). Reasoning blocks (`<think>…</think>`) are dropped; a fenced
 * ```json block is read first; otherwise the outermost balanced `{…}` or `[…]`
 * that parses, with commas that close nothing tolerated. When the answer was
 * cut off mid-list, the complete method objects before the cut are kept.
 * `undefined` when nothing in it is JSON.
 */
export function extractJsonPayload(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
  const candidates: string[] = [];
  for (const m of cleaned.matchAll(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
  candidates.push(cleaned.trim());
  for (const c of candidates) {
    const whole = tryJson(c);
    if (whole.ok) return whole.value;
  }
  // The outermost balanced span that parses, earliest first; a span that does not parse is stepped into.
  let span: unknown;
  for (const c of candidates) {
    for (let i = 0, tries = 0; i < c.length && tries < 200 && span === undefined; i++) {
      if (c[i] !== '{' && c[i] !== '[') continue;
      tries++;
      const end = balancedEnd(c, i);
      if (end === null) continue;
      const got = tryJson(c.slice(i, end));
      if (got.ok && got.value && typeof got.value === 'object') span = got.value;
    }
    if (span !== undefined) break;
  }
  if (span !== undefined && (Array.isArray(span) || 'methods' in (span as object))) return span;
  // Cut off before the list closed: keep each complete method object that came before the cut
  // (the span above is then only the first of them).
  const salvaged = salvageMethods(cleaned);
  return salvaged ?? span;
}

function salvageMethods(cleaned: string): { methods: unknown[] } | undefined {
  const list = /"methods"\s*:\s*\[/.exec(cleaned);
  if (list) {
    const methods: unknown[] = [];
    let i = list.index + list[0].length;
    while (i < cleaned.length) {
      while (i < cleaned.length && /[\s,]/.test(cleaned[i]!)) i++;
      if (cleaned[i] !== '{') break;
      const end = balancedEnd(cleaned, i);
      if (end === null) break;
      const got = tryJson(cleaned.slice(i, end));
      if (!got.ok) break;
      methods.push(got.value);
      i = end;
    }
    if (methods.length) return { methods };
  }
  return undefined;
}

/** What a model wrote instead of `{"methods":[…]}`, read as that list when its shape says it is one. */
function methodsOf(body: unknown): unknown {
  const isMethod = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x) && ('program' in x || 'stance' in x || 'thinking' in x);
  if (Array.isArray(body)) {
    // `[{"methods":[…]}]` is the object wrapped; `[{name, stance, …}, …]` is the list itself.
    if (body.length === 1 && body[0] && typeof body[0] === 'object' && Array.isArray((body[0] as { methods?: unknown }).methods)) return (body[0] as { methods: unknown }).methods;
    return body;
  }
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    if ('methods' in r) return r['methods'];
    if (isMethod(r)) return [r];
    // One list under another name (`strategies`, `answer`), or the object one level down (`{"result":{"methods":[…]}}`).
    const values = Object.values(r);
    const lists = values.filter((v) => Array.isArray(v) && v.length > 0 && v.every(isMethod));
    if (lists.length === 1) return lists[0];
    const nested = values.filter((v) => v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { methods?: unknown }).methods));
    if (nested.length === 1) return (nested[0] as { methods: unknown }).methods;
  }
  return undefined;
}

/** The first 80 characters of an answer, on one line, for a refusal that says what was received. */
function answerHead(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function parseInvented(text: string, brief: Pick<InventBrief, 'operators' | 'openings' | 'reserve' | 'designs'>): { directions: Direction[]; proposed: number; refused: number; rejections: string[] } {
  if (!text.trim()) return { directions: [], proposed: 0, refused: 1, rejections: ['the answer is empty'] };
  const body = extractJsonPayload(text);
  if (body === undefined) return { directions: [], proposed: 0, refused: 1, rejections: [`the answer is not JSON (begins: "${answerHead(text)}")`] };
  const methods = methodsOf(body);
  if (!Array.isArray(methods)) return { directions: [], proposed: 0, refused: 1, rejections: ['the answer holds no "methods" list'] };
  const rejections: string[] = [];
  const ops = new Set(brief.operators.map((o) => o.key));
  const opKey = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    const k = raw.trim();
    for (const c of [k, k.toLowerCase()]) if (ops.has(c) || (c.length >= 4 && [...ops].some((o) => o.startsWith(c)))) return c;
    return null;
  };
  const ids = new Set(brief.openings.map((o) => o.id));
  const reserve = new Set((brief.reserve ?? []).map((o) => o.id));
  const scopeOf = (raw: unknown): Scope | null => {
    if (raw === undefined || raw === null || raw === '') return 'ALL';
    const id = idOf(raw);
    if (id && ids.has(id)) return `id:${id}` as Scope;
    const w = word(raw);
    return w && SCOPES.includes(w) ? (w as Scope) : null;
  };
  const directions: Direction[] = [];
  let refused = 0;
  const refuse = (name: string, why: string) => {
    refused++;
    rejections.push(`"${name || 'unnamed'}": ${why}`);
  };
  for (const m of methods.slice(0, 16)) {
    const r = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim().slice(0, 120) : '';
    const stance = typeof r['stance'] === 'string' ? r['stance'].trim().toUpperCase().replace(/[^A-Z0-9_+-]+/g, '_').slice(0, 40) : '';
    const thinking = typeof r['thinking'] === 'string' ? r['thinking'].trim().slice(0, 400) : '';
    // A method may carry a new transaction design for a buyer population (S-11), when the brief offered the vocabulary.
    const designed = noDesign(r['design']) ? null : brief.designs ? parseDesign(r['design']) : { refused: 'designs are not offered in this read' };
    if (designed && 'refused' in designed) {
      refuse(name, designed.refused);
      continue;
    }
    const program = Array.isArray(r['program']) ? r['program'] : r['program'] === undefined || r['program'] === null ? [] : null;
    if (!name || !stance || !thinking) {
      refuse(name, `it has no ${[!name && 'name', !stance && 'stance', !thinking && 'thinking'].filter(Boolean).join(', ')}`);
      continue;
    }
    if (!program) {
      refuse(name, 'its program is not a list of steps');
      continue;
    }
    if (program.length === 0 && !designed) {
      refuse(name, 'its program is empty and it carries no design');
      continue;
    }
    if (program.length > 6) {
      refuse(name, `its program has ${program.length} steps; at most 6 are read`);
      continue;
    }
    const transforms: Transform[] = [];
    let bad: string | null = null;
    for (const t of program) {
      const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      const op = word(x['op']);
      if (op === 'OPERATOR') {
        const key = opKey(x['key']);
        const target = x['target'] === undefined || x['target'] === null || x['target'] === '' ? null : idOf(x['target']);
        if (!key) bad = `its step names operator "${String(x['key']).slice(0, 60)}", which is not one of the operators offered`;
        else if (target !== null && !ids.has(target)) bad = `its step points operator ${key} at "${String(x['target']).slice(0, 60)}", which is not an opening held`;
        else transforms.push({ op: 'OPERATOR', key, ...(target !== null ? { target } : {}) });
      } else if (op === 'PRICE') {
        const factor = numberOf(x['factor']);
        const scope = scopeOf(x['scope']);
        if (factor === null || factor <= 0.2 || factor > 5) bad = `its PRICE factor ${String(x['factor']).slice(0, 20)} is outside 0.25-4`;
        else if (!scope) bad = `its PRICE scope "${String(x['scope']).slice(0, 60)}" is not a scope or an opening held`;
        else transforms.push({ op: 'PRICE', factor, scope });
      } else if (op === 'FOCUS') {
        const count = numberOf(x['count']);
        if (count === null || count < 1) bad = 'its FOCUS step names no count of at least 1';
        else transforms.push({ op: 'FOCUS', count: Math.round(count) });
      } else if (op === 'DROP') {
        const scope = scopeOf(x['scope']);
        if (!scope) bad = `its DROP scope "${String(x['scope']).slice(0, 60)}" is not a scope or an opening held`;
        else transforms.push({ op: 'DROP', scope });
      } else if (op === 'INCLUDE') {
        const key = idOf(x['key']);
        if (!key || !reserve.has(key)) bad = `its INCLUDE names "${String(x['key']).slice(0, 60)}", which is not an arrangement outside the plan`;
        else transforms.push({ op: 'INCLUDE', key });
      } else bad = `its step "${String(x['op']).slice(0, 30)}" is outside the vocabulary (OPERATOR, PRICE, FOCUS, DROP, INCLUDE)`;
      if (bad) break;
    }
    if (bad) {
      refuse(name, bad);
      continue;
    }
    if (transforms.length === 0 && !designed) {
      refuse(name, 'its program holds no step');
      continue;
    }
    const from = word(r['from']) === 'BASELINE' ? 'BASELINE' : 'GREEDY';
    const ask = typeof r['ask'] === 'string' && r['ask'].trim().length > 10 ? r['ask'].trim().slice(0, 300) : undefined;
    const challenges = typeof r['challenges'] === 'string' ? r['challenges'].trim().slice(0, 200) : undefined;
    directions.push(makeDirection({ name, stance, origin: 'MODEL', thinking, from, program: transforms, ...(ask ? { ask } : {}), ...(challenges ? { challenges } : {}), ...(designed ? { design: designed } : {}) }));
  }
  return { directions, proposed: methods.length, refused, rejections };
}

/** A closed-vocabulary value, read by its key in any case, or by its label. */
const oneOf = <T extends string>(xs: readonly T[], x: unknown, labels?: Readonly<Record<string, { label: string }>>): T | null => {
  const w = word(x);
  if (w && (xs as readonly string[]).includes(w)) return w as T;
  if (labels && typeof x === 'string') {
    const t = x.trim().toLowerCase();
    const hit = xs.find((k) => labels[k]?.label.toLowerCase() === t);
    if (hit) return hit;
  }
  return null;
};

/**
 * A model's design, checked for shape only: the four parts of the design
 * tuple from their closed vocabularies, a coherent combination, and a buyer
 * population in words. Any number it carries is ignored — a design is
 * structure, never a figure. Refused with the reason, never repaired.
 */
export function parseDesign(raw: unknown): InventedDesign | { refused: string } {
  if (!raw || typeof raw !== 'object') return { refused: 'its design is not an object' };
  const x = raw as Record<string, unknown>;
  const base = oneOf(STRUCTURE_KEYS, x['structure'] ?? x['base'], STRUCTURES);
  if (!base) return { refused: `its design names no structure of ${STRUCTURE_KEYS.join(', ')}` };
  const funding = oneOf(FUNDING, x['funding'] ?? 'ON_DELIVERY');
  const aggregation = oneOf(AGGREGATION, x['aggregation'] ?? (base === 'POOL' ? 'POOLED_BUYERS' : 'SINGLE'));
  const repeat = oneOf(REPEAT, x['repeat'] ?? 'ONE_OFF');
  if (!funding || !aggregation || !repeat) return { refused: 'its design uses a funding, aggregation or repeat outside the vocabulary' };
  const design: Design = { base, funding, aggregation, repeat };
  if (!coherent(design)) return { refused: `its design ${base}/${funding}/${aggregation}/${repeat} cannot exist (incoherent)` };
  const population = typeof x['population'] === 'string' ? x['population'].trim().slice(0, 120) : '';
  if (population.length < 3) return { refused: 'its design names no buyer population' };
  const need = typeof x['need'] === 'string' && x['need'].trim().length >= 3 ? x['need'].trim().slice(0, 120) : null;
  return { design, population, need };
}

/**
 * Compose every invented design through the construction path (S-11): a
 * design that composes becomes a reserve opening, and its method gains the
 * INCLUDE that brings it in; one that does not is dropped with the reason.
 * Methods without a design pass through. The same design over the same buyers
 * composes once.
 */
export function composeInventedDesigns(directions: Direction[], ctx: Pick<ExploreContext, 'design' | 'reserve'>): { directions: Direction[]; reserve: PlannedOpening[]; rejections: string[] } {
  const out: Direction[] = [];
  const reserve: PlannedOpening[] = [];
  const rejections: string[] = [];
  const held = new Set((ctx.reserve ?? []).map((o) => o.opportunity.id));
  for (const d of directions) {
    if (!d.design) {
      out.push(d);
      continue;
    }
    if (!ctx.design) {
      rejections.push(`"${d.name}": no construction path is offered in this read`);
      continue;
    }
    let made: PlannedOpening | { refused: string };
    try {
      made = ctx.design(d.design);
    } catch (error) {
      made = { refused: `construction failed: ${String((error as Error)?.message ?? error).slice(0, 120)}` };
    }
    if ('refused' in made) {
      rejections.push(`"${d.name}": ${made.refused}`);
      continue;
    }
    const id = made.opportunity.id;
    if (!held.has(id)) {
      held.add(id);
      reserve.push(made);
    }
    out.push(makeDirection({ ...d, program: [...d.program.filter((t) => !(t.op === 'INCLUDE' && t.key === id)), { op: 'INCLUDE', key: id }] }));
  }
  return { directions: out, reserve, rejections };
}

void FIELDS;

/** The exploration, as lines for `goals plan`. */
export function renderExploration(x: Exploration, limit = 10): string[] {
  const lines: string[] = [];
  const v = (r: VariantReading | null) => (r ? `${pct(r.reach)}` : '—');
  lines.push(`  explore   ${x.sentence}`);
  lines.push(`    budget  ${x.budget} direction(s) justified by the problem · ${x.evaluations} evaluation(s) on ${x.threads} thread(s) · origin ${Object.entries(x.byOrigin).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ')}`);
  lines.push(`    model   ${x.model.calls} call(s), ${x.model.proposed} method(s) proposed, ${x.model.refused} refused as off-shape${x.model.error ? ` · ${x.model.error.slice(0, 120)}` : ''}`);
  // Why, so a refusal rate is read from the plan rather than guessed (F9.2).
  for (const why of (x.model.rejections ?? []).slice(0, 3)) lines.push(`    refused ${why.slice(0, 160)}`);
  for (const s of x.stanceYield.slice(0, 14)) lines.push(`    stance  ${s.stance.padEnd(22)} ${String(s.directions).padStart(3)} direction(s), ${s.improved} improved the plan as held, best lift ${pct(s.bestLift)}`);
  for (const l of x.leaders.slice(0, limit)) lines.push(`    leader  ${(l === x.winner ? '*' : ' ')} [${l.direction.origin.toLowerCase()} · ${l.direction.stance}] ${l.direction.name.slice(0, 80)} → reach ${v(l.reading)}, challenged ${v(l.challenged)}`);
  for (const d of x.discoveries.slice(0, 5)) lines.push(`    found   [model] ${d.direction.name.slice(0, 80)} — ${d.direction.thinking.slice(0, 160)} → reach ${v(d.reading)}`);
  for (const a of x.asks) lines.push(`    ask     ${a}`);
  if (x.sweep) {
    const engine = new Map(x.all.map((r) => [r.direction.signature, { reach: r.reading.reach, settledP50: r.reading.settledP50 }]));
    lines.push(...renderSweep(x.sweep, engine));
  }
  return lines;
}
