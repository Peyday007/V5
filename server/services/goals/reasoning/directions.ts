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
import type { Dimension, StrategyChange, StrategyOperator, StrategyState, VariantReading } from '../reconstruction.ts';

export const MAX_DIRECTIONS = 120;
export const MIN_DIRECTIONS = 12;
/** Directions carried from one generation to the next. */
export const LEADERS = 8;
export const MAX_GENERATIONS = 4;
/** Price elasticity a price change pays in close rate: an assumption, stated, until selling measures it. */
export const PRICE_ELASTICITY = 1.2;
/** The challenge every leader must survive: its conversion halved. */
export const CHALLENGE_FACTOR = 0.5;
/** Evaluations an exploration may spend per direction its budget allows: screening, challenges and generations together. */
export const EVALUATIONS_PER_DIRECTION = 4;
/** No exploration spends more evaluations than this, whatever its budget. */
export const MAX_EVALUATIONS = 400;
/** Nor more time than this (production evaluations cost about a second each). */
export const DEFAULT_MAX_MS = 3 * 60_000;

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
  | { op: 'STRESS'; field: Field; factor: number; scope: Scope };

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
}

export interface DirectionReading {
  direction: Direction;
  reading: VariantReading;
  /** The same plan with its conversion halved: what it holds if its assumptions are wrong. */
  challenged: VariantReading | null;
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
  /** The model's part: calls made, methods proposed, methods refused as off-shape or unexecutable. */
  model: { calls: number; proposed: number; refused: number; error: string | null };
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
  /** The model's methods, already parsed; generated concurrently with the screen. */
  invent?: (brief: InventBrief) => Promise<{ directions: Direction[]; calls: number; proposed: number; refused: number; error: string | null }>;
  /** Wall-clock budget for the whole exploration. */
  maxMs?: number;
  now?: () => number;
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

function valuePerInterested(o: ModelledOpportunity): number {
  return (mid(o.price) ?? 0) * (mid(o.close) ?? 0);
}

function scaleInput(input: ModelledOpportunity['price'], k: number, cap = Infinity): ModelledOpportunity['price'] {
  const f = (x: number | null) => (x === null ? null : Math.min(cap, x * k));
  return { ...input, value: f(input.value), low: f(input.low), high: f(input.high), distribution: undefined, inferred: undefined };
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

/** The price change a direction may make: from a quarter to four times. */
export const clampPrice = (k: number) => Math.min(4, Math.max(0.25, k));

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
  ctx: Pick<ExploreContext, 'operators' | 'operatorsFor' | 'remaining'>,
  /** Leave out every transform whose change is an assumption: the plan as it stands on estimates alone. */
  skipAssumed = false,
): Applied {
  let s: StrategyState = start;
  let skipped = 0;
  const change = (dimension: Dimension, label: string, detail: string, basis: StrategyChange['basis']): StrategyChange => ({ dimension, label, detail, cost: 0, basis, startDay: { low: 0, high: 0 } });
  for (const t of program) {
    if (t.op === 'OPERATOR') {
      const pool = t.target ? ctx.operatorsFor(t.target) : ctx.operators;
      const op = pool.find((o) => o.key === t.key) ?? pool.find((o) => o.key.startsWith(t.key));
      // An operator already applied is not applied twice: its label is in the change set.
      const next = op ? op.apply(s) : null;
      if (!next || next.changes.length === s.changes.length || s.changes.some((c) => c.label === next.changes[next.changes.length - 1]!.label && c.dimension === next.changes[next.changes.length - 1]!.dimension)) {
        skipped++;
        continue;
      }
      if (skipAssumed && next.changes[next.changes.length - 1]!.basis === 'ASSUMPTION') continue;
      s = next;
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
      const closeK = Math.pow(k, -PRICE_ELASTICITY);
      s = {
        ...s,
        openings: s.openings.map((o) =>
          ids.has(o.opportunity.id)
            ? { ...o, price: scaleInput(o.price, k), close: { ...scaleInput(o.close, closeK, 1), provenance: 'ASSUMPTION', note: `${o.close.note}; price ×${k.toFixed(2)}: close assumed ×${closeK.toFixed(2)} (elasticity ${PRICE_ELASTICITY})` } }
            : o,
        ),
        changes: [...s.changes, change('PRICE', `price×${k.toFixed(2)}@${t.scope}`, `${k > 1 ? 'raise' : 'lower'} price ×${k.toFixed(2)} on ${ids.size} opening(s) (${t.scope}); close assumed to move ×${closeK.toFixed(2)} until selling measures it`, 'ASSUMPTION')],
      };
      continue;
    }
    if (t.op === 'FOCUS') {
      const n = Math.max(1, Math.round(t.count));
      const open = s.openings.filter((o) => o.agreedValue === 0);
      if (open.length <= n) {
        skipped++;
        continue;
      }
      const keep = new Set([...open].sort((a, b) => valuePerInterested(b) - valuePerInterested(a)).slice(0, n).map((o) => o.opportunity.id));
      s = {
        ...s,
        openings: s.openings.filter((o) => o.agreedValue > 0 || keep.has(o.opportunity.id)),
        changes: [...s.changes, change('PORTFOLIO', `focus:${n}`, `concentrate outreach and money on the ${n} opening(s) that settle most per interested buyer, and drop ${open.length - n}`, 'ESTIMATE')],
      };
      continue;
    }
    if (t.op === 'DROP') {
      const ids = inScope(s.openings, t.scope, ctx.remaining);
      if (ids.size === 0 || ids.size >= s.openings.filter((o) => o.agreedValue === 0).length) {
        skipped++;
        continue;
      }
      s = {
        ...s,
        openings: s.openings.filter((o) => !ids.has(o.opportunity.id)),
        changes: [...s.changes, change('PORTFOLIO', `drop@${t.scope}`, `leave out ${ids.size} opening(s) (${t.scope}), freeing the capacity and money they held`, 'ESTIMATE')],
      };
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
      changes: [...s.changes, change('EVIDENCE', `stress:${t.field}×${against.toFixed(2)}@${t.scope}`, `challenge: ${t.field} ×${against.toFixed(2)} on ${t.scope}`, 'ASSUMPTION')],
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
export function seedDirections(ctx: Pick<ExploreContext, 'base' | 'greedy' | 'operators' | 'binding' | 'remaining' | 'structural'>): Direction[] {
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
    for (const alt of ops.filter((o) => o.dimension === dim && !o.key.endsWith(label)).slice(0, 3)) add({ name: `Middle-out: ${alt.key} in place of ${label}`, stance: 'MIDDLE_OUT', thinking: 'Keep the shape of the strongest plan and swap one of its moves for another of the same kind.', from: 'BASELINE', program: [...program, { op: 'OPERATOR', key: alt.key }] });
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
  return out;
}

function opKeyOf(c: StrategyChange, ops: StrategyOperator[]): string {
  // An operator's key ends with the change label it writes (capacity:x@375 writes x@375).
  const op = ops.find((o) => o.dimension === c.dimension && (o.key.endsWith(`:${c.label}`) || o.key.split(':')[1] === c.label));
  return op?.key ?? '';
}

// ---------------------------------------------------------------- evolution

/** Combine two directions of different stances: both programs, from the stronger start. */
export function recombine(a: Direction, b: Direction): Direction {
  const program = [...a.program, ...b.program.filter((t) => !a.program.some((x) => token(x) === token(t)))];
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
export function mutate(d: Direction, ctx: Pick<ExploreContext, 'base' | 'operators'>, salt: number): Direction[] {
  const out: Direction[] = [];
  const ids = ctx.base.openings.filter(outreach).map((o) => o.opportunity.id);
  d.program.forEach((t, i) => {
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

  // The model invents while the cheap seeds are screened: the two run at the same time.
  const brief = inventBrief(ctx);
  const invented = ctx.invent ? ctx.invent(brief).catch((e: unknown) => ({ directions: [] as Direction[], calls: 0, proposed: 0, refused: 0, error: String((e as Error)?.message ?? e) })) : null;

  // §99's plan as a program, so every direction runs from the plan as held and can be challenged move by move.
  const greedyProgram: Transform[] = ctx.greedy.changes.map((c) => ({ op: 'OPERATOR' as const, key: opKeyOf(c, ctx.operators) })).filter((t) => t.key);
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
        if (!applied || (d.from === 'GREEDY' && state.changes.length <= greedyProgram.length)) {
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
        r.challenged = await challengeOf(full(r.direction));
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
  const challengeOf = async (program: Transform[]): Promise<VariantReading> => {
    evaluations += 2;
    const [halved, bare] = await Promise.all([
      ctx.evaluate(applyProgram(ctx.base, [...program, ...challengeProgram()], ctx).state, true, ' @challenge'),
      ctx.evaluate(applyProgram(ctx.base, program, ctx, true).state, true, ' @no-assumptions'),
    ]);
    return halved.reach <= bare.reach ? halved : bare;
  };

  // The plan §99 built is a direction too, and it is challenged like every other.
  const greedyDirection = makeDirection({ name: 'Greedy: §99 one dimension at a time', stance: 'GREEDY', origin: 'ALGORITHM', thinking: 'Change the dimension that helps most, then the next, while each helps.', from: 'GREEDY', program: [] });
  const greedyRow: DirectionReading = { direction: greedyDirection, reading: ctx.greedyReading, challenged: null, score: 0, generation: 0, applied: true };
  greedyRow.challenged = await challengeOf(greedyProgram);
  greedyRow.score = scoreOf(ctx.greedyReading, greedyRow.challenged);
  const budget = explorationBudget({ openings: ctx.base.openings.length, operators: ctx.operators.length, binding: ctx.binding.filter((b) => b.liftReach > 0).length, reach: Math.min(ctx.greedyReading.reach, greedyRow.challenged?.reach ?? 0), required: ctx.required, structural: ctx.structural });
  evaluationCap = Math.min(MAX_EVALUATIONS, evaluations + EVALUATIONS_PER_DIRECTION * budget);

  // 1–2. Generate and screen: the library first (what worked), then the cheap seeds, kept distinct.
  const pool = budget > 0 ? distinct([...(ctx.library ?? []), ...seedDirections(ctx)], budget) : [];
  await run(pool, 1);

  // The model's directions join as soon as they arrive.
  if (invented && budget > 0) {
    const got = await invented;
    model.calls = got.calls;
    model.proposed = got.proposed;
    model.refused = got.refused;
    model.error = got.error;
    const room = Math.max(0, budget - all.length) + Math.ceil(budget / 4);
    await run(distinct(got.directions, room, all.map((r) => r.direction)), 1);
  }

  // 3. Evolve: the leaders challenge, combine, modify and replace one another.
  // Every direction that improves the plan as held is challenged, not only the most optimistic: a robust plan is often not the one with the highest reach.
  const improving = (rows: DirectionReading[]) => rows.filter((r) => r.reading.feasible && r.reading.reach >= ctx.baselineReading.reach + MATERIAL);
  await challenge(improving(all));
  let leaders: DirectionReading[];
  leaders = diverseLeaders([greedyRow, ...all]);
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
    leaders = diverseLeaders([greedyRow, ...all]);
    const top = leaders[0]?.score ?? bestScore;
    if (top < bestScore + MATERIAL / 2) break;
    bestScore = top;
  }

  // 4. Conclude.
  const ranked = rank([greedyRow, ...all]);
  const top = ranked[0]!;
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
  const asks = [...new Set(all.map((r) => r.direction.ask).filter((a): a is string => !!a && a.length > 10))].slice(0, 5);
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
    leaders: diverseLeaders(ranked),
    all,
    stanceYield,
    discoveries,
    asks,
    model,
    sentence,
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
    stancesTried: ['BACKWARD', 'FORWARD', 'MIDDLE_OUT', 'CONSTRAINT', 'RESOURCE', 'RELATIONSHIP', 'INVERSION', 'OPPORTUNITY', 'TRANSACTION', 'PORTFOLIO', ...new Set((ctx.library ?? []).map((d) => d.stance))],
    bestKnown: (ctx.library ?? []).slice(0, 6).map((d) => ({ name: d.name, stance: d.stance, thinking: d.thinking })),
  };
}

// ---------------------------------------------------------------- parsing a model's methods

const FIELDS: readonly Field[] = ['price', 'close', 'respond', 'volume', 'daysToCash', 'directCost'];
const SCOPES = ['ALL', 'OUTREACH', 'SMALL_TICKET', 'LARGE_TICKET', 'FAST_CASH', 'SLOW_CASH', 'TOP', 'REST'];

/**
 * Validate a model's answer into directions. Off-shape methods are refused,
 * never repaired; a transform naming an operator or opening that does not
 * exist is refused with it. A model may name any stance.
 */
export function parseInvented(text: string, brief: Pick<InventBrief, 'operators' | 'openings'>): { directions: Direction[]; proposed: number; refused: number } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return { directions: [], proposed: 0, refused: 0 };
  let body: unknown;
  try {
    body = JSON.parse(match[0]);
  } catch {
    return { directions: [], proposed: 0, refused: 1 };
  }
  const methods = (body as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) return { directions: [], proposed: 0, refused: 1 };
  const ops = new Set(brief.operators.map((o) => o.key));
  const opPrefix = (k: string) => ops.has(k) || [...ops].some((o) => o.startsWith(k) && k.length >= 4);
  const ids = new Set(brief.openings.map((o) => o.id));
  const directions: Direction[] = [];
  let refused = 0;
  for (const m of methods.slice(0, 16)) {
    const r = m as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim().slice(0, 120) : '';
    const stance = typeof r['stance'] === 'string' ? r['stance'].trim().toUpperCase().replace(/[^A-Z0-9_+-]+/g, '_').slice(0, 40) : '';
    const thinking = typeof r['thinking'] === 'string' ? r['thinking'].trim().slice(0, 400) : '';
    const program = Array.isArray(r['program']) ? r['program'] : null;
    if (!name || !stance || !thinking || !program || program.length === 0 || program.length > 6) {
      refused++;
      continue;
    }
    const transforms: Transform[] = [];
    let bad = false;
    for (const t of program) {
      const x = t as Record<string, unknown>;
      const scope = typeof x['scope'] === 'string' ? x['scope'] : 'ALL';
      const scopeOk = SCOPES.includes(scope) || (scope.startsWith('id:') && ids.has(scope.slice(3)));
      if (x['op'] === 'OPERATOR' && typeof x['key'] === 'string' && opPrefix(x['key']) && (x['target'] === undefined || (typeof x['target'] === 'string' && ids.has(x['target'])))) {
        transforms.push({ op: 'OPERATOR', key: x['key'], ...(typeof x['target'] === 'string' ? { target: x['target'] } : {}) });
      } else if (x['op'] === 'PRICE' && typeof x['factor'] === 'number' && x['factor'] > 0.2 && x['factor'] <= 5 && scopeOk) {
        transforms.push({ op: 'PRICE', factor: x['factor'], scope: scope as Scope });
      } else if (x['op'] === 'FOCUS' && typeof x['count'] === 'number' && x['count'] >= 1) {
        transforms.push({ op: 'FOCUS', count: Math.round(x['count']) });
      } else if (x['op'] === 'DROP' && scopeOk) {
        transforms.push({ op: 'DROP', scope: scope as Scope });
      } else bad = true;
    }
    if (bad || transforms.length === 0) {
      refused++;
      continue;
    }
    const from = r['from'] === 'BASELINE' ? 'BASELINE' : 'GREEDY';
    const ask = typeof r['ask'] === 'string' && r['ask'].trim().length > 10 ? r['ask'].trim().slice(0, 300) : undefined;
    const challenges = typeof r['challenges'] === 'string' ? r['challenges'].trim().slice(0, 200) : undefined;
    directions.push(makeDirection({ name, stance, origin: 'MODEL', thinking, from, program: transforms, ...(ask ? { ask } : {}), ...(challenges ? { challenges } : {}) }));
  }
  return { directions, proposed: methods.length, refused };
}

void FIELDS;

/** The exploration, as lines for `goals plan`. */
export function renderExploration(x: Exploration, limit = 10): string[] {
  const lines: string[] = [];
  const v = (r: VariantReading | null) => (r ? `${pct(r.reach)}` : '—');
  lines.push(`  explore   ${x.sentence}`);
  lines.push(`    budget  ${x.budget} direction(s) justified by the problem · ${x.evaluations} evaluation(s) on ${x.threads} thread(s) · origin ${Object.entries(x.byOrigin).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ')}`);
  lines.push(`    model   ${x.model.calls} call(s), ${x.model.proposed} method(s) proposed, ${x.model.refused} refused as off-shape${x.model.error ? ` · ${x.model.error.slice(0, 120)}` : ''}`);
  for (const s of x.stanceYield.slice(0, 14)) lines.push(`    stance  ${s.stance.padEnd(22)} ${String(s.directions).padStart(3)} direction(s), ${s.improved} improved the plan as held, best lift ${pct(s.bestLift)}`);
  for (const l of x.leaders.slice(0, limit)) lines.push(`    leader  ${(l === x.winner ? '*' : ' ')} [${l.direction.origin.toLowerCase()} · ${l.direction.stance}] ${l.direction.name.slice(0, 80)} → reach ${v(l.reading)}, challenged ${v(l.challenged)}`);
  for (const d of x.discoveries.slice(0, 5)) lines.push(`    found   [model] ${d.direction.name.slice(0, 80)} — ${d.direction.thinking.slice(0, 160)} → reach ${v(d.reading)}`);
  for (const a of x.asks) lines.push(`    ask     ${a}`);
  return lines;
}
