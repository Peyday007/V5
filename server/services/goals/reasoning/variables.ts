/**
 * Variable exploration (§102): a goal's plan read sweeps tens to hundreds of
 * thousands of combinations of the variables that shape it — money committed,
 * price, deal size, channel and capacity, partner and fulfilment, financing,
 * cash timing, which openings are combined — and, separately, the world's
 * conditions it cannot choose (reply and close rate, market size, geography,
 * supplier cost, time available).
 *
 * It is the §101 exploration's front end, not a second planner. The Monte
 * Carlo engine (`evaluateGoalPortfolio`) costs about a second an evaluation on
 * production, so it can judge a few hundred directions. Ordinary code can
 * judge a combination in microseconds with a closed-form reading of the same
 * model (`fastReading`: expected deals per opening under a shared-capacity
 * allocation, money limits, and a lognormal spread from each input's range).
 * The sweep uses that reading to rank the space, and hands only the strongest
 * distinct strategies to the engine as directions; the engine decides. No
 * model call is spent on a calculation.
 *
 * The search, each stage cheap enough to run inside one plan read:
 *   1. Discover the variables from the problem: every operator family §99
 *      costed becomes a decision variable with its budgets and targets as
 *      levels; price and composition are levels over the plan's own scopes;
 *      every input an opening holds as a wide range becomes a condition.
 *   2. Screen a deterministic sample and measure each variable's main effect;
 *      a variable whose levels change nothing is fixed, so the factorial is
 *      not spent on it.
 *   3. Enumerate the remaining factorial up to `MAX_VARIATIONS`, equivalent
 *      combinations (the same resulting plan) counted once.
 *   4. Attack the result from several directions — forward from the money in
 *      hand, backward from the target, middle-out from §99's plan, through the
 *      bottleneck, by challenging every assumption, and from the perspectives
 *      of cash, floor, speed and capital — each its own objective. The leaders
 *      are recombined and mutated by local search, with search effort given to
 *      the approaches that are improving, until nothing improves.
 *   5. Separate what is commercially supported (decisions inside evidence)
 *      from what is only mathematically possible (a condition moved, or an
 *      assumed move), and work backward from the strongest supported strategy
 *      to the value each condition would need for the requirement — inside or
 *      outside what is evidenced.
 *
 * It never invents demand: a condition is only ever read at the ends of the
 * range the evidence states (or moved explicitly, and then labelled
 * mathematical). A direction carries only decisions.
 */
import type { ModelInput, ModelledOpportunity } from '../../cash/goalScenario.ts';
import type { StrategyOperator, StrategyState } from '../reconstruction.ts';
import type { PlannedOpening } from '../portfolio.ts';
import { clampPrice, inScope, makeDirection, PRICE_ELASTICITY, type Direction, type Scope, type Transform } from './directions.ts';

/** No sweep evaluates more combinations than this. */
export const MAX_VARIATIONS = 250_000;
/** Nor runs longer than this. */
export const DEFAULT_SWEEP_MS = 60_000;
/**
 * The share of the time bound each stage may use up to, cumulatively: the screen, the factorial, local search, then
 * the conditions. Production, 2026-11-11 (Goals plan 43003547180): one bound for the whole sweep let the factorial take
 * all 49 s, and local search and the conditions read nothing.
 */
export const STAGE_SHARES = { screen: 0.1, factorial: 0.55, local: 0.75, conditions: 1 } as const;
/** Combinations screened to measure each variable's main effect. */
export const SCREEN_SAMPLE = 4_000;
/** A variable whose best level lifts the score by less than this is fixed at its first level. */
export const MIN_EFFECT = 0.002;
/** Directions the sweep hands the engine. */
export const SWEEP_DIRECTIONS = 14;
/**
 * The fast reading's stand-in for "proof arrives": a purchase made only after
 * proof is counted at this share of what it adds. A ranking device only — the
 * engine decides world by world whether proof came.
 */
export const PROOF_SHARE = 0.5;
/** Factors a condition is read at: the range the evidence states, and then outside it (mathematical only). */
export const CONDITION_FACTORS = [0.5, 1, 2] as const;

export type Kind = 'DECISION' | 'CONDITION';
export type Family =
  | 'MONEY_CAPACITY'
  | 'CHANNEL'
  | 'PARTNER'
  | 'DEAL_SIZE'
  | 'FINANCING'
  | 'CASH_TIMING'
  | 'PRICE'
  | 'COMBINATION'
  | 'DEMAND'
  | 'CONVERSION'
  | 'MARKET'
  | 'SUPPLY'
  | 'TIME'
  | 'OTHER';

export interface Level {
  label: string;
  transforms: Transform[];
  /** ASSUMPTION: the move itself is assumed (a price change's close, a partner's referrals). */
  assumed: boolean;
}

export interface Variable {
  key: string;
  family: Family;
  kind: Kind;
  levels: Level[];
  /** Where the variable came from: an operator §99 costed, a scope of the plan, or a range on an opening. */
  discoveredFrom: string;
  /** Best main-effect lift of any level over the first, measured by the screen. */
  effect: number;
  fixed: boolean;
}

export interface Condition {
  key: string;
  family: Family;
  field: 'respond' | 'close' | 'volume' | 'price' | 'daysToCash' | 'directCost' | 'contacts' | 'days';
  /** `ALL`, or one opening's id. */
  scope: string;
  discoveredFrom: string;
}

export interface FastReading {
  feasible: boolean;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  reach: number;
  committed: number;
  /** What holds the plan down: shared capacity, the market, money or time. */
  binding: 'CAPACITY' | 'MARKET' | 'CAPITAL' | 'TIME' | 'CONVERSION' | 'NONE';
}

export interface Strategy {
  approach: string;
  /** Level index per decision variable. */
  levels: number[];
  /** Conditions moved (mathematical only when any is not 1). */
  conditions: Record<string, number>;
  reading: FastReading;
  challenged: FastReading;
  score: number;
  supported: boolean;
  assumptions: string[];
  label: string;
}

export interface Requirement {
  condition: string;
  family: Family;
  /** The multiple of the evidenced middle the requirement needs; null when no multiple up to ×20 reaches it. */
  needed: number | null;
  /** The top of what the evidence states, as a multiple of its middle. */
  evidencedTop: number;
  inEvidence: boolean;
}

export interface VariableSweep {
  variables: Array<Pick<Variable, 'key' | 'family' | 'kind' | 'discoveredFrom' | 'effect' | 'fixed'> & { levels: number }>;
  conditions: Condition[];
  /** Size of the full decision space before pruning. */
  space: number;
  /** Distinct combinations evaluated by the fast reading, conditions included. */
  variations: number;
  /** Combinations that turned out to be the same plan as one already read, and were not counted again. */
  equivalent: number;
  screened: number;
  factorial: number;
  local: number;
  conditionReads: number;
  elapsedMs: number;
  stopped: 'COMPLETE' | 'VARIATIONS' | 'TIME';
  approaches: Array<{ approach: string; evaluated: number; improved: number; best: number }>;
  baseline: FastReading;
  greedy: FastReading;
  bestSupported: Strategy | null;
  bestMathematical: Strategy | null;
  /** The strongest distinct strategies, one per approach where they differ. */
  strategies: Strategy[];
  requirements: Requirement[];
  /** The per-opening conditions whose range moves the strongest strategy most: the evidence to get first. */
  sensitive: Array<{ condition: string; swing: number }>;
  bottleneck: FastReading['binding'];
  directions: Direction[];
  /** Questions only the world can answer, from the requirements outside evidence. */
  asks: string[];
  sentence: string;
}

export interface SweepContext {
  base: StrategyState;
  greedy: StrategyState;
  operators: StrategyOperator[];
  operatorsFor: (target: string) => StrategyOperator[];
  remaining: number;
  daysLeft: number;
  required: number;
  /** The outreach a day the plan starts with. */
  contactsPerDay: ModelInput;
  limits: { beforeProof: number | null; perWeek: number | null; capitalCeiling: number | null };
  maxMs?: number;
  maxVariations?: number;
  now?: () => number;
}

// ---------------------------------------------------------------- the fast reading

const mid = (x: ModelInput): number | null => {
  if (x.value !== null) return x.value;
  if (x.inferred) return x.inferred.p50;
  if (x.low !== null && x.high !== null) return (x.low + x.high) / 2;
  return x.low ?? x.high ?? null;
};
const lo = (x: ModelInput) => x.low ?? x.inferred?.p10 ?? x.value ?? mid(x) ?? 0;
const hi = (x: ModelInput) => x.high ?? x.inferred?.p90 ?? x.value ?? mid(x) ?? 0;
/** The squared coefficient of variation of a uniform draw over an input's range. */
const cv2 = (x: ModelInput) => {
  const m = mid(x) ?? 0;
  if (m <= 0) return 0;
  const w = hi(x) - lo(x);
  return (w * w) / (12 * m * m);
};

/** An opening reduced to numbers: what the fast reading needs, computed once per state. */
interface Compiled {
  id: string;
  kind: 'AGREED' | 'ONE_OFF' | 'SHARED' | 'CHANNEL';
  agreed: number;
  price: number;
  respond: number;
  close: number;
  volume: number;
  days: number;
  cost: number;
  perDay: number;
  capital: number;
  refused: boolean;
  /** Its direct cost is paid from the buyer's prepayment: exempt from the ceiling, never from the cash kept. */
  funded: boolean;
  /** The market it sells into: a clone shares its original's (Q-6). */
  market: string;
  /** Unit price as a multiple of the card's, across every move so far (held within ×0.25–×4). */
  priceFactor: number;
  /** A deposit's middle share and the day it arrives, when one is asked. */
  deposit: { share: number; days: number } | null;
  /** Sells only once a purchase after proof is made: read at PROOF_SHARE in the fast reading. */
  gated: boolean;
  /** Squared coefficient of variation of a deal count's drivers, and of price. */
  cvDeals: number;
  cvPrice: number;
  vpi: number;
}

export interface Limits {
  remaining: number;
  daysLeft: number;
  contacts: number;
  cvContacts: number;
  startingCapital: number | null;
  beforeProof: number | null;
  spendCeiling: number;
  ceiling: number;
}

function capitalOf(o: ModelledOpportunity, beforeProof: number | null): { amount: number; refused: boolean } {
  const established = o.capital.value !== null || !!o.capital.inferred?.justified;
  const amount = o.capital.value ?? (o.capital.inferred?.justified ? o.capital.inferred.p50 : hi(o.capital));
  if (beforeProof === null || amount <= beforeProof + 1e-9) return { amount, refused: false };
  if (established) return { amount, refused: true };
  const floor = lo(o.capital);
  return floor > beforeProof + 1e-9 ? { amount, refused: true } : { amount: (floor + beforeProof) / 2, refused: false };
}

export function compile(state: StrategyState, beforeProof: number | null): Compiled[] {
  return state.openings.map((o: PlannedOpening) => {
    const kind: Compiled['kind'] = o.agreedValue > 0 ? 'AGREED' : !o.repeatable ? 'ONE_OFF' : o.channel ? 'CHANNEL' : 'SHARED';
    const cap = capitalOf(o, beforeProof);
    const c = {
      id: o.opportunity.id,
      kind,
      agreed: o.agreedValue,
      price: Math.max(0, mid(o.price) ?? 0),
      respond: Math.min(1, Math.max(0, mid(o.respond) ?? 0)),
      close: Math.min(1, Math.max(0, mid(o.close) ?? 0)),
      volume: Math.max(0, mid(o.volume) ?? (o.repeatable ? 0 : 1)),
      days: Math.max(0, mid(o.daysToCash) ?? 0),
      cost: Math.max(0, mid(o.directCost) ?? 0),
      perDay: o.channel ? Math.max(0, mid(o.channel.perDay) ?? 0) : 0,
      capital: cap.amount,
      refused: cap.refused,
      funded: !!o.fundedByBuyer,
      market: o.marketKey ?? o.opportunity.id,
      priceFactor: o.terms?.priceFactor ?? 1,
      deposit: o.deposit && o.repeatable && o.agreedValue === 0 ? { share: (o.deposit.low + o.deposit.high) / 2, days: o.deposit.days } : null,
      gated: !!o.gate,
      cvDeals: cv2(o.respond) + cv2(o.close) + (o.channel ? cv2(o.channel.perDay) : 0),
      cvPrice: cv2(o.price),
      vpi: 0,
    };
    c.vpi = c.price * c.close * c.respond;
    return c;
  });
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export interface Adjust {
  respond?: number;
  close?: number;
  volume?: number;
  price?: number;
  directCost?: number;
  daysToCash?: number;
  contacts?: number;
  days?: number;
  capital?: number;
  /** Only these opening ids are adjusted (all when omitted). */
  only?: string;
}

/**
 * The closed-form reading of one compiled plan: expected settled cash, its
 * spread, the share of worlds that reach the remaining amount, and what binds.
 * Shared outreach is allocated to the openings that settle most per contact
 * until each one's market is exhausted (the continuous form of the engine's
 * share choice); one-offs and agreed money add directly; money limits drop
 * the weakest openings per dollar tied up.
 */
export function fastReading(rows: Compiled[], L: Limits, committed: number, adj: Adjust = {}): FastReading {
  if (committed > L.ceiling + 1e-9) return { feasible: false, mean: 0, p10: 0, p50: 0, p90: 0, reach: 0, committed, binding: 'CAPITAL' };
  const days = L.daysLeft * (adj.days ?? 1);
  const k = (id: string, f: number | undefined) => (f === undefined || (adj.only && adj.only !== id && !id.startsWith(`${adj.only}~`)) ? 1 : f);
  let capitalLeft = L.startingCapital === null ? Infinity : Math.max(0, L.startingCapital - Math.min(committed, L.beforeProof ?? committed)) * (adj.capital ?? 1);
  let contactsLeft = L.contacts * (adj.contacts ?? 1);
  let mean = 0;
  let varIndep = 0;
  let sdShared = 0;
  let spend = 0;
  let capacityBound = false;
  let marketBound = false;
  let capitalBound = false;
  let timeBound = false;
  // Highest value per contact first; agreed and one-off money does not compete for contacts.
  const order = rows.map((r, i) => i).sort((a, b) => rows[b]!.vpi - rows[a]!.vpi || (rows[a]!.id < rows[b]!.id ? -1 : 1));
  // One market, however many ways it is reached: what an opening sells comes out of what its clones can (Q-6).
  const marketLeft = new Map<string, number>();
  let ceilingSpend = 0;
  for (const i of order) {
    const r = rows[i]!;
    if (r.refused) continue;
    if (r.kind === 'AGREED') {
      mean += r.agreed;
      continue;
    }
    const price = r.price * k(r.id, adj.price);
    const close = Math.min(1, r.close * k(r.id, adj.close));
    const respond = Math.min(1, r.respond * k(r.id, adj.respond));
    const dCash = r.days * k(r.id, adj.daysToCash);
    // With a deposit a sale made later still pays its deposit in time; only its balance must wait for the opening's own timing.
    const dFirst = r.deposit ? Math.min(dCash, r.deposit.days * k(r.id, adj.daysToCash)) : dCash;
    if (dFirst > days) {
      timeBound = true;
      continue;
    }
    const inTime = r.deposit ? r.deposit.share + (1 - r.deposit.share) * (Math.max(0, days - dCash) / Math.max(1e-9, days - dFirst)) : 1;
    if (r.capital > capitalLeft + 1e-9) {
      capitalBound = true;
      continue;
    }
    let deals: number;
    if (r.kind === 'ONE_OFF') {
      deals = close;
      const v = close * (1 - close) * price * price;
      varIndep += v;
    } else {
      const selling = Math.max(0, days - dFirst);
      const left = marketLeft.get(r.market) ?? r.volume * k(r.id, adj.volume);
      const volume = Math.min(r.volume * k(r.id, adj.volume), left);
      const perContact = respond * close;
      if (perContact <= 0 || selling <= 0 || volume <= 0) continue;
      if (r.kind === 'CHANNEL') {
        deals = Math.min(volume, r.perDay * selling * perContact * (r.gated ? PROOF_SHARE : 1));
        if (deals >= volume - 1e-9) marketBound = true;
      } else {
        const want = volume / perContact / selling;
        const take = Math.min(contactsLeft, want);
        if (take <= 0) {
          capacityBound = true;
          continue;
        }
        contactsLeft -= take;
        deals = take * selling * perContact;
        if (take < want - 1e-9) capacityBound = true;
        else marketBound = true;
      }
      marketLeft.set(r.market, Math.max(0, left - deals));
      const sd = deals * price * Math.sqrt(r.cvDeals + r.cvPrice + (r.kind === 'SHARED' ? L.cvContacts : 0));
      // Count noise: a Poisson number of deals.
      varIndep += deals * price * price;
      if (r.kind === 'SHARED') sdShared += sd;
      else varIndep += sd * sd;
    }
    capitalLeft -= r.capital;
    mean += deals * price * inTime;
    // Every direct cost leaves the cash kept; only the owner's own money counts against the ceiling (Q-3).
    const cost = deals * r.cost * k(r.id, adj.directCost);
    spend += cost;
    if (!r.funded) ceilingSpend += cost;
  }
  // Direct costs beyond what may be spent cannot be fulfilled: the excess settles nothing.
  if (ceilingSpend > L.spendCeiling - committed && ceilingSpend > 0) {
    const f = Math.max(0, Math.max(0, L.spendCeiling - committed) / ceilingSpend);
    mean *= f;
    spend *= f;
    capitalBound = true;
  }
  // Openings drawing on the shared outreach move together (the engine's correlation); half their spread is common.
  const variance = varIndep + 0.5 * sdShared * sdShared;
  if (mean <= 0) return { feasible: true, mean: 0, p10: 0, p50: 0, p90: 0, reach: 0, committed, binding: capitalBound ? 'CAPITAL' : timeBound ? 'TIME' : 'CONVERSION' };
  const s2 = Math.log(1 + variance / (mean * mean));
  const s = Math.sqrt(s2);
  const mu = Math.log(mean) - s2 / 2;
  const q = (z: number) => Math.exp(mu + z * s);
  // The target is cash kept: settled cash must also cover the direct costs and what was committed (Q-3).
  const need = L.remaining + spend + Math.max(0, committed);
  const reach = L.remaining <= 0 ? 1 : s > 0 ? 1 - phi((Math.log(need) - mu) / s) : mean >= need ? 1 : 0;
  const binding: FastReading['binding'] = capacityBound ? 'CAPACITY' : marketBound ? 'MARKET' : capitalBound ? 'CAPITAL' : timeBound ? 'TIME' : 'CONVERSION';
  return { feasible: true, mean, p10: q(-1.2816), p50: q(0), p90: q(1.2816), reach, committed, binding };
}

/** Reach and its challenge weigh equally, as in §101; cash breaks ties among plans that reach nothing yet. */
export function fastScore(r: FastReading, c: FastReading, assumed: number, remaining: number): number {
  if (!r.feasible) return -1;
  return 0.5 * r.reach + 0.5 * c.reach + 0.1 * Math.min(1, r.mean / Math.max(1, remaining)) + 0.05 * Math.min(1, c.mean / Math.max(1, remaining)) - 0.002 * assumed;
}

// ---------------------------------------------------------------- discovering the variables

const family = (key: string): Family => {
  if (key.startsWith('capacity:')) return 'MONEY_CAPACITY';
  if (key.startsWith('acquisition:')) return 'CHANNEL';
  if (key.startsWith('partner:')) return 'PARTNER';
  if (key.startsWith('transaction:')) return 'DEAL_SIZE';
  if (key.startsWith('capital:')) return 'FINANCING';
  if (key.startsWith('timing:')) return 'CASH_TIMING';
  return 'OTHER';
};

/** Opening ids worth pointing a channel at: the strongest few per contact, so levels stay meaningful. */
function targets(state: StrategyState, n: number): string[] {
  return state.openings
    .filter((o) => o.repeatable && o.agreedValue === 0 && !o.channel && (mid(o.price) ?? 0) > 0)
    .sort((a, b) => (mid(b.price) ?? 0) * (mid(b.close) ?? 0) * (mid(b.respond) ?? 0) - (mid(a.price) ?? 0) * (mid(a.close) ?? 0) * (mid(a.respond) ?? 0) || (a.opportunity.id < b.opportunity.id ? -1 : 1))
    .slice(0, n)
    .map((o) => o.opportunity.id);
}

/**
 * The decision variables this problem has, read from the operators it was
 * given and the openings it holds. Nothing here names a business or a goal:
 * another goal with other levers discovers other variables.
 */
export function discoverVariables(ctx: Pick<SweepContext, 'base' | 'operators' | 'operatorsFor'>): Variable[] {
  const vars: Variable[] = [];
  const none: Level = { label: 'as held', transforms: [], assumed: false };
  const byFamily = new Map<Family, StrategyOperator[]>();
  for (const op of ctx.operators) {
    const f = family(op.key);
    byFamily.set(f, [...(byFamily.get(f) ?? []), op]);
  }
  const tgt = targets(ctx.base, 4);
  const assumedOp = (op: StrategyOperator, s: StrategyState) => {
    const next = op.apply(s);
    return !!next && next.changes[next.changes.length - 1]?.basis === 'ASSUMPTION';
  };
  for (const [f, ops] of byFamily) {
    const levels: Level[] = [none];
    // Financing and cash timing are switches; capacity is a budget; channels and partners are also pointed at an opening.
    if (f === 'FINANCING' || f === 'CASH_TIMING' || f === 'DEAL_SIZE' || f === 'MONEY_CAPACITY') {
      for (const op of ops) levels.push({ label: op.key, transforms: [{ op: 'OPERATOR', key: op.key }], assumed: assumedOp(op, ctx.base) });
    } else {
      for (const op of ops)
        for (const t of tgt.length ? tgt : [undefined]) {
          const pointed = t ? ctx.operatorsFor(t).find((o) => o.key === op.key) : op;
          if (!pointed || !pointed.apply(ctx.base)) continue;
          levels.push({ label: t ? `${op.key}>${t}` : op.key, transforms: [{ op: 'OPERATOR', key: op.key, ...(t ? { target: t } : {}) }], assumed: assumedOp(pointed, ctx.base) });
        }
    }
    if (levels.length > 1) vars.push({ key: f.toLowerCase(), family: f, kind: 'DECISION', levels, discoveredFrom: `${ops.length} costed operator(s): ${ops.map((o) => o.key).slice(0, 4).join(', ')}`, effect: 0, fixed: false });
  }
  // Price: a factor over each scope of the plan that holds openings. Close moves the other way (elasticity, assumed).
  const open = ctx.base.openings.filter((o) => o.agreedValue === 0);
  const scopes: Scope[] = (['ALL', 'SMALL_TICKET', 'TOP', 'REST'] as Scope[]).filter((s) => {
    const n = inScope(ctx.base.openings, s, 1e9).size;
    return n > 0 && (s === 'ALL' || n < open.length);
  });
  const priceLevels: Level[] = [none];
  for (const s of scopes) for (const f of [0.6, 0.8, 1.25, 1.6, 2.5, 4]) priceLevels.push({ label: `price×${f}@${s}`, transforms: [{ op: 'PRICE', factor: clampPrice(f), scope: s }], assumed: true });
  if (priceLevels.length > 1) vars.push({ key: 'price', family: 'PRICE', kind: 'DECISION', levels: priceLevels, discoveredFrom: `${scopes.length} scope(s) of the plan's openings`, effect: 0, fixed: false });
  // Composition: which openings are combined, by concentration or by leaving a class out.
  const comp: Level[] = [none];
  for (const n of [1, 2, 3, 5, 8]) if (open.length > n) comp.push({ label: `focus:${n}`, transforms: [{ op: 'FOCUS', count: n }], assumed: false });
  for (const s of ['SMALL_TICKET', 'SLOW_CASH', 'LARGE_TICKET', 'FAST_CASH'] as Scope[]) {
    const n = inScope(ctx.base.openings, s, 1e9).size;
    if (n > 0 && n < open.length) comp.push({ label: `drop@${s}`, transforms: [{ op: 'DROP', scope: s }], assumed: false });
  }
  if (comp.length > 1) vars.push({ key: 'combination', family: 'COMBINATION', kind: 'DECISION', levels: comp, discoveredFrom: `${open.length} opening(s) that can be combined or left out`, effect: 0, fixed: false });
  return vars;
}

/**
 * The conditions: what the world decides. The global ones every goal has, and
 * one for each input an opening holds as a range wide enough to matter
 * (top over bottom ≥ 2) — discovered from the openings, never listed.
 */
export function discoverConditions(state: StrategyState): Condition[] {
  const out: Condition[] = [
    { key: 'reply', family: 'DEMAND', field: 'respond', scope: 'ALL', discoveredFrom: 'every outreach opening: the share of buyers contacted who answer' },
    { key: 'close', family: 'CONVERSION', field: 'close', scope: 'ALL', discoveredFrom: 'every opening: the share of interested buyers who pay' },
    { key: 'market', family: 'MARKET', field: 'volume', scope: 'ALL', discoveredFrom: 'deals the market can take: more geography or more buyer types' },
    { key: 'ticket', family: 'MARKET', field: 'price', scope: 'ALL', discoveredFrom: 'what a buyer pays at the same close rate' },
    { key: 'supplier-cost', family: 'SUPPLY', field: 'directCost', scope: 'ALL', discoveredFrom: 'what fulfilment costs' },
    { key: 'cash-speed', family: 'TIME', field: 'daysToCash', scope: 'ALL', discoveredFrom: 'how fast a sale becomes usable cash' },
    { key: 'outreach-capacity', family: 'DEMAND', field: 'contacts', scope: 'ALL', discoveredFrom: 'buyers reachable a day' },
    { key: 'time-available', family: 'TIME', field: 'days', scope: 'ALL', discoveredFrom: 'days until the deadline' },
  ];
  const fields: Array<[Condition['field'], keyof ModelledOpportunity, Family]> = [
    ['respond', 'respond', 'DEMAND'],
    ['close', 'close', 'CONVERSION'],
    ['volume', 'volume', 'MARKET'],
    ['price', 'price', 'MARKET'],
    ['directCost', 'directCost', 'SUPPLY'],
    ['daysToCash', 'daysToCash', 'TIME'],
  ];
  for (const o of state.openings) {
    if (o.agreedValue > 0) continue;
    for (const [field, key, fam] of fields) {
      const x = o[key] as ModelInput;
      const l = lo(x);
      const h = hi(x);
      if (l > 0 && h / l >= 2) out.push({ key: `${field}:${o.opportunity.id}`, family: fam, field, scope: o.opportunity.id, discoveredFrom: `${o.opportunity.title.slice(0, 50)}: ${field} ${+l.toPrecision(3)}–${+h.toPrecision(3)}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the sweep

const APPROACHES = ['FORWARD', 'BACKWARD', 'MIDDLE_OUT', 'BOTTLENECK', 'CHALLENGE', 'PERSPECTIVE:CASH', 'PERSPECTIVE:FLOOR', 'PERSPECTIVE:SPEED', 'PERSPECTIVE:CAPITAL', 'COMBINE'] as const;

/** Families that relieve a binding constraint. */
const RELIEVES: Record<FastReading['binding'], Family[]> = {
  CAPACITY: ['MONEY_CAPACITY', 'CHANNEL', 'PARTNER'],
  MARKET: ['CHANNEL', 'PARTNER', 'DEAL_SIZE', 'PRICE'],
  CAPITAL: ['FINANCING', 'COMBINATION'],
  TIME: ['CASH_TIMING', 'COMBINATION'],
  CONVERSION: ['PARTNER', 'CHANNEL', 'PRICE'],
  NONE: [],
};

const yieldNow = () => new Promise<void>((r) => setImmediate(r));
/** The longest the sweep holds the event loop between yields: requests are served between slices (§63). */
export const SLICE_MS = 8;

export async function sweepVariables(ctx: SweepContext): Promise<VariableSweep> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const maxMs = ctx.maxMs ?? DEFAULT_SWEEP_MS;
  const maxVar = ctx.maxVariations ?? MAX_VARIATIONS;
  const ceiling = ctx.limits.capitalCeiling ?? ctx.limits.perWeek ?? ctx.limits.beforeProof ?? 0;
  const perWeek = Math.min(ctx.limits.perWeek ?? ceiling, ceiling);
  const beforeProof = Math.min(ctx.limits.beforeProof ?? perWeek, perWeek);
  const L0 = (contacts: ModelInput): Limits => ({
    remaining: ctx.remaining,
    daysLeft: ctx.daysLeft,
    contacts: mid(contacts) ?? 0,
    cvContacts: cv2(contacts),
    startingCapital: ctx.limits.perWeek ?? ctx.limits.beforeProof ?? ctx.limits.capitalCeiling,
    beforeProof: ctx.limits.beforeProof,
    spendCeiling: ceiling,
    ceiling,
  });

  // Yield by elapsed time, not by count: one read can cost a microsecond or, when it builds a new operator state, a millisecond.
  let sliceStart = performance.now();
  const breathe = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return;
    await yieldNow();
    sliceStart = performance.now();
  };
  const variables = discoverVariables(ctx);
  const conditions = discoverConditions(ctx.base);
  const space = variables.reduce((n, v) => n * v.levels.length, 1);

  // Operators pointed at a target, built once.
  const pointed = new Map<string, StrategyOperator[]>();
  const opsFor = (t: string) => {
    let x = pointed.get(t);
    if (!x) pointed.set(t, (x = ctx.operatorsFor(t)));
    return x;
  };
  // States after the operator part of a combination, memoized by that part: the expensive objects are built once.
  const opVars = variables.map((v, i) => ({ v, i })).filter(({ v }) => v.levels.some((l) => l.transforms.some((t) => t.op === 'OPERATOR')));
  const restVars = variables.map((v, i) => ({ v, i })).filter(({ v }) => !opVars.some((o) => o.v === v));
  const stateCache = new Map<string, { state: StrategyState; rows: Compiled[]; L: Limits; assumed: number } | null>();
  const operatorState = (levels: number[]) => {
    const key = opVars.map(({ i }) => levels[i]).join(',');
    if (stateCache.has(key)) return stateCache.get(key)!;
    let s = ctx.base;
    let assumed = 0;
    for (const { v, i } of opVars) {
      const level = v.levels[levels[i]!]!;
      for (const t of level.transforms) {
        if (t.op !== 'OPERATOR') continue;
        const pool = t.target ? opsFor(t.target) : ctx.operators;
        const op = pool.find((o) => o.key === t.key);
        const next = op?.apply(s) ?? null;
        if (!next || next === s) {
          if (stateCache.size < 20_000) stateCache.set(key, null);
          return null;
        }
        if (next.changes[next.changes.length - 1]!.basis === 'ASSUMPTION') assumed++;
        s = next;
      }
    }
    // Capacity bought after proof is read at PROOF_SHARE of what it adds; the engine decides world by world.
    const late = s.changes.filter((c) => c.afterProof && c.dimension === 'CAPACITY' && c.contacts);
    const L = L0(s.contactsPerDay ?? ctx.contactsPerDay);
    for (const c of late) L.contacts += PROOF_SHARE * ((c.contacts!.low + c.contacts!.high) / 2);
    const out = { state: s, rows: compile(s, ctx.limits.beforeProof), L, assumed };
    if (stateCache.size < 20_000) stateCache.set(key, out);
    return out;
  };
  const scopeCache = new Map<string, Set<string>>();
  const scopeIds = (key: string, state: StrategyState, scope: Scope) => {
    const k = `${key}|${scope}`;
    let x = scopeCache.get(k);
    if (!x) scopeCache.set(k, (x = inScope(state.openings, scope, ctx.remaining)));
    return x;
  };

  /** Apply the non-operator levels on the compiled rows: price, focus, drop. Returns null when a level has nothing to change. */
  const finish = (levels: number[]): { rows: Compiled[]; L: Limits; committed: number; assumed: number; sig: string } | null => {
    const os = operatorState(levels);
    if (!os) return null;
    let rows = os.rows;
    let assumed = os.assumed;
    const opKey = opVars.map(({ i }) => levels[i]).join(',');
    const sig: string[] = [opKey];
    for (const { v, i } of restVars) {
      const level = v.levels[levels[i]!]!;
      for (const t of level.transforms) {
        if (t.op === 'PRICE') {
          const ids = scopeIds(opKey, os.state, t.scope);
          if (ids.size === 0) return null;
          // The same running clamp as the engine's programs: unit price within ×0.25–×4 of the card's, with a bundle's discount
          // counted, and the demand curve moving close rate and market volume together (Q-1, Q-2).
          const asked = clampPrice(t.factor);
          rows = rows.map((r) => {
            if (!ids.has(r.id)) return r;
            const target = clampPrice(r.priceFactor * asked);
            const k = target / r.priceFactor;
            const ck = Math.pow(k, -PRICE_ELASTICITY);
            const close = Math.min(1, r.close * ck);
            return { ...r, price: r.price * k, close, volume: r.volume * ck, priceFactor: target, vpi: r.price * k * close * r.respond };
          });
          const k = asked;
          assumed++;
          sig.push(`p${t.scope}${k}`);
        } else if (t.op === 'FOCUS') {
          const open = rows.filter((r) => r.kind !== 'AGREED');
          if (open.length <= t.count) return null;
          const keep = new Set([...open].sort((a, b) => b.price * b.close - a.price * a.close || (a.id < b.id ? -1 : 1)).slice(0, t.count).map((r) => r.id));
          rows = rows.filter((r) => r.kind === 'AGREED' || keep.has(r.id));
          sig.push(`f${[...keep].sort().join('/')}`);
        } else if (t.op === 'DROP') {
          const ids = scopeIds(opKey, os.state, t.scope);
          const open = rows.filter((r) => r.kind !== 'AGREED');
          const dropped = open.filter((r) => ids.has(r.id));
          if (dropped.length === 0 || dropped.length >= open.length) return null;
          rows = rows.filter((r) => !ids.has(r.id));
          sig.push(`d${dropped.map((r) => r.id).sort().join('/')}`);
        }
      }
    }
    // The plan itself, not the route to it: two combinations that leave the same openings at the same terms are one variation.
    return { rows, L: os.L, committed: os.state.committed, assumed, sig: `${os.state.committed.toFixed(0)}|${os.L.contacts.toFixed(1)}|${rows.map((r) => `${r.id}:${r.price.toFixed(2)}:${r.close.toFixed(5)}:${r.volume.toFixed(2)}:${r.days.toFixed(2)}:${r.funded ? 1 : 0}:${r.deposit ? 1 : 0}`).join(',')}` };
  };

  // Combinations are keyed by number, not string: a sweep of 250,000 holds two sets of numbers, not 250,000 objects.
  const radix = variables.map((v) => v.levels.length);
  const code = (levels: number[]) => levels.reduce((n, l, i) => n * radix[i]! + l, 0);
  const hash = (s: string) => {
    // FNV-1a over 52 bits: collisions are negligible at this count, and a collision only skips one read.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return (h1 * 1048576 + (h2 & 0xfffff));
  };
  const visited = new Set<number>();
  const sigSeen = new Set<number>();
  let variations = 0;
  let equivalent = 0;
  let conditionReads = 0;
  let stageEnd: number = STAGE_SHARES.screen;
  let timeCut = false;
  const late = () => {
    if (variations >= maxVar) return true;
    if (now() - started <= maxMs * stageEnd) return false;
    timeCut = true;
    return true;
  };
  const challengeAdj: Adjust = { respond: 0.5, close: 0.5 };
  const labelOf = (levels: number[]) => variables.map((v, i) => (levels[i] ? v.levels[levels[i]!]!.label : '')).filter(Boolean).join(' + ') || 'as held';
  const assumptionsOf = (levels: number[]) => variables.flatMap((v, i) => (levels[i] && v.levels[levels[i]!]!.assumed ? [v.levels[levels[i]!]!.label] : []));
  const assumedCount = (levels: number[]) => levels.reduce((n, l, i) => n + (l && variables[i]!.levels[l]!.assumed ? 1 : 0), 0);

  const evalLevels = (levels: number[], approach: string): (Strategy & { sigHash: number }) | null => {
    const f = finish(levels);
    if (!f) return null;
    const reading = fastReading(f.rows, f.L, f.committed);
    const challenged = fastReading(f.rows, f.L, f.committed, challengeAdj);
    const n = assumedCount(levels);
    return { approach, levels: [...levels], conditions: {}, reading, challenged, score: fastScore(reading, challenged, n, ctx.remaining), supported: n === 0, assumptions: [], label: '', sigHash: hash(f.sig) };
  };
  const materialize = (s: Strategy): Strategy => ({ ...s, label: s.label || labelOf(s.levels), assumptions: s.assumptions.length ? s.assumptions : assumptionsOf(s.levels) });

  // What the search keeps: the strongest few thousand by score, and each objective's leader, streamed.
  const POOL = 3000;
  let pool: Strategy[] = [];
  let poolFloor = -Infinity;
  const speedOf = (s: Strategy): number => {
    const f = finish(s.levels);
    return f ? fastReading(f.rows, f.L, f.committed, { days: 0.5 }).mean / ctx.remaining : 0;
  };
  const objective: Record<(typeof APPROACHES)[number], (s: Strategy) => number> = {
    FORWARD: (s) => (s.supported && s.reading.committed <= beforeProof + 1e-9 ? s.score : -1),
    BACKWARD: (s) => s.reading.reach + 0.1 * Math.min(1, s.reading.mean / ctx.remaining),
    MIDDLE_OUT: (s) => s.score - 0.01 * s.levels.reduce((n, l, i) => n + (l !== greedyLevels[i] ? 1 : 0), 0),
    BOTTLENECK: (s) => s.score,
    CHALLENGE: (s) => s.challenged.reach + 0.1 * Math.min(1, s.challenged.mean / ctx.remaining) - 0.01 * assumedCount(s.levels),
    'PERSPECTIVE:CASH': (s) => s.reading.mean,
    'PERSPECTIVE:FLOOR': (s) => s.reading.p10,
    'PERSPECTIVE:SPEED': (s) => speedOf(s) + 0.01 * s.score,
    'PERSPECTIVE:CAPITAL': (s) => s.reading.mean / (1 + s.reading.committed),
    COMBINE: (s) => s.score,
  };
  /** Objectives cheap enough to follow on every read; the rest choose from the pool. */
  const STREAMED = ['FORWARD', 'BACKWARD', 'CHALLENGE', 'PERSPECTIVE:CASH', 'PERSPECTIVE:FLOOR', 'PERSPECTIVE:CAPITAL'] as const;
  const streamed = new Map<string, { s: Strategy; v: number }>();
  const offer = (s: Strategy) => {
    if (!s.reading.feasible) return;
    if (s.score > poolFloor || pool.length < POOL) {
      pool.push(s);
      if (pool.length > POOL * 2) {
        pool.sort((a, b) => b.score - a.score || code(a.levels) - code(b.levels));
        pool = pool.slice(0, POOL);
        poolFloor = pool[pool.length - 1]!.score;
      }
    }
    for (const a of STREAMED) {
      const v = objective[a](s);
      const held = streamed.get(a);
      if (v > -1 && (!held || v > held.v + 1e-12)) streamed.set(a, { s, v });
    }
  };
  const read = (levels: number[], approach: string): Strategy | null => {
    const lk = code(levels);
    const fresh = !visited.has(lk);
    if (fresh && late()) return null;
    visited.add(lk);
    const st = evalLevels(levels, approach);
    if (!st || !fresh) return st;
    // The same plan reached by another combination is one variation, not two.
    if (sigSeen.has(st.sigHash)) {
      equivalent++;
      return st;
    }
    sigSeen.add(st.sigHash);
    variations++;
    offer(st);
    return st;
  };

  const zero = variables.map(() => 0);
  const baseline = read(zero, 'BASELINE')!;
  // §99's plan in the variable space: each of its changes matched to the level that makes it.
  const greedyLevels = variables.map((v) => {
    const idx = v.levels.findIndex((l, j) => j > 0 && l.transforms.length > 0 && l.transforms.every((t) => t.op === 'OPERATOR' && !t.target && ctx.greedy.changes.some((c) => (c.op ? c.op === t.key : t.key.endsWith(`:${c.label}`) || t.key.split(':')[1] === c.label))));
    return Math.max(0, idx);
  });
  const greedy = read(greedyLevels, 'MIDDLE_OUT') ?? baseline;

  // 2. Screen: a deterministic sample, and each level's mean score.
  let rng = 0x9e3779b9;
  const rand = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) / 4294967296;
  };
  const sums = variables.map((v) => v.levels.map(() => ({ n: 0, s: 0 })));
  const sample = Math.min(SCREEN_SAMPLE, space);
  let screened = 0;
  for (let i = 0; i < sample * 3 && screened < sample && !late(); i++) {
    await breathe();
    const levels = variables.map((v) => Math.floor(rand() * v.levels.length));
    const st = read(levels, 'SCREEN');
    if (!st) continue;
    screened++;
    levels.forEach((l, j) => {
      sums[j]![l]!.n++;
      sums[j]![l]!.s += st.score;
    });
  }
  const meanOf = (j: number, l: number) => (sums[j]![l]!.n ? sums[j]![l]!.s / sums[j]![l]!.n : -Infinity);
  variables.forEach((v, j) => {
    const means = v.levels.map((_, l) => meanOf(j, l));
    const seenMeans = means.filter((m) => m > -Infinity);
    const first = means[0]! > -Infinity ? means[0]! : Math.min(...seenMeans);
    v.effect = seenMeans.length ? Math.max(0, Math.max(...seenMeans) - first) : 0;
  });

  stageEnd = STAGE_SHARES.factorial;
  // 3. The factorial over what matters. While it is larger than the budget, the level that screened weakest against its
  // own variable's "as held" goes, across all variables; a variable left with only "as held" is fixed (it changed nothing).
  const live = variables.map((v) => v.levels.map((_, j) => j));
  const size = () => live.reduce((n, l) => n * l.length, 1);
  const budgetFactorial = Math.max(1, Math.floor((maxVar - variations) * 0.6));
  while (size() > budgetFactorial) {
    let pickJ = -1;
    let pickL = -1;
    let pickV = Infinity;
    live.forEach((ls, j) => {
      const base0 = meanOf(j, 0);
      for (const l of ls) {
        if (l === 0) continue;
        const v = meanOf(j, l) - (base0 > -Infinity ? base0 : 0);
        if (v < pickV || (v === pickV && (j > pickJ || (j === pickJ && l > pickL)))) {
          pickV = v;
          pickJ = j;
          pickL = l;
        }
      }
    });
    if (pickJ < 0) break;
    live[pickJ] = live[pickJ]!.filter((x) => x !== pickL);
  }
  variables.forEach((v, j) => (v.fixed = live[j]!.length === 1 && v.levels.length > 1));
  let factorial = 0;
  const idx = live.map(() => 0);
  const total = size();
  // The cheap variables (price, composition) turn fastest, so one built operator state serves every combination of them.
  const turn = [...restVars.map(({ i }) => i), ...opVars.map(({ i }) => i)];
  for (let c = 0; c < total && !late(); c++) {
    const before = variations;
    read(idx.map((x, j) => live[j]![x]!), 'FACTORIAL');
    if (variations > before) factorial++;
    for (const j of turn) {
      idx[j]!++;
      if (idx[j]! < live[j]!.length) break;
      idx[j] = 0;
    }
    await breathe();
  }

  stageEnd = STAGE_SHARES.local;
  // 4. Many directions over the same space: each approach is an objective, and some a constraint.
  const argmax = (rows: Strategy[], f: (s: Strategy) => number, keep: (s: Strategy) => boolean = () => true) => {
    let top: Strategy | null = null;
    let tv = -Infinity;
    for (const s of rows) {
      if (!s.reading.feasible || !keep(s)) continue;
      const v = f(s);
      if (v > tv + 1e-12 || (Math.abs(v - tv) <= 1e-12 && top && code(s.levels) < code(top.levels))) {
        top = s;
        tv = v;
      }
    }
    return top;
  };
  const leadersNow = () => [...pool, ...[...streamed.values()].map((x) => x.s)];
  let bottleneck: FastReading['binding'] = (argmax(leadersNow(), (s) => s.score) ?? baseline).reading.binding;
  const relieves = (s: Strategy) => s.levels.some((l, i) => l > 0 && RELIEVES[bottleneck].includes(variables[i]!.family));
  const keepFor = (a: (typeof APPROACHES)[number]) => (a === 'BOTTLENECK' ? relieves : a === 'FORWARD' ? (s: Strategy) => objective.FORWARD(s) > -1 : () => true);
  const best = new Map<string, Strategy>();
  for (const a of APPROACHES) {
    const p = (STREAMED as readonly string[]).includes(a) ? streamed.get(a)?.s ?? null : argmax(leadersNow(), objective[a], keepFor(a));
    if (p) best.set(a, p);
  }
  if (!best.has('MIDDLE_OUT')) best.set('MIDDLE_OUT', greedy);
  const yieldOf = new Map<string, { evaluated: number; improved: number; best: number }>(APPROACHES.map((a) => [a, { evaluated: 0, improved: 0, best: 0 }]));

  // Keep improving: every one-level move around each approach's leader, and crossover between leaders.
  // Effort goes first to the approaches that have been improving (an upper confidence bound).
  let local = 0;
  for (let round = 0; round < 12 && !late(); round++) {
    let improvedAny = false;
    const totalTries = [...yieldOf.values()].reduce((n, y) => n + y.evaluated, 0) + 1;
    const u = (y: { evaluated: number; improved: number }) => (y.improved + 1) / (y.evaluated + 1) + Math.sqrt(Math.log(totalTries + 1) / (y.evaluated + 1));
    const order = [...APPROACHES].sort((a, b) => u(yieldOf.get(b)!) - u(yieldOf.get(a)!) || (a < b ? -1 : 1));
    bottleneck = (argmax(leadersNow(), (s) => s.score) ?? baseline).reading.binding;
    for (const a of order.slice(0, Math.max(3, order.length - round))) {
      const leader = best.get(a);
      if (!leader || late()) continue;
      const f = objective[a];
      const keep = keepFor(a);
      const y = yieldOf.get(a)!;
      let top = leader;
      let tv = f(leader);
      const candidates: number[][] = [];
      variables.forEach((v, i) => v.levels.forEach((_, j) => j !== leader.levels[i] && candidates.push(leader.levels.map((l, k) => (k === i ? j : l)))));
      if (a === 'COMBINE') {
        const ls = [...best.values()];
        for (let p = 0; p < ls.length; p++) for (let q = p + 1; q < ls.length; q++) for (let m = 0; m < 4; m++) candidates.push(ls[p]!.levels.map((l, k) => (rand() < 0.5 ? l : ls[q]!.levels[k]!)));
      }
      for (const c of candidates) {
        if (late()) break;
        await breathe();
        const before = variations;
        const st = read(c, a);
        if (variations > before) {
          local++;
          y.evaluated++;
        }
        if (!st || !st.reading.feasible || !keep(st)) continue;
        const v = f(st);
        if (v > tv + 1e-9) {
          top = st;
          tv = v;
        }
      }
      if (top !== leader) {
        y.improved++;
        improvedAny = true;
        best.set(a, top);
      }
      await yieldNow();
    }
    if (!improvedAny) break;
  }
  for (const a of APPROACHES) yieldOf.get(a)!.best = best.get(a)?.score ?? 0;

  const ranked = [...new Set([...pool, ...best.values(), ...[...streamed.values()].map((x) => x.s)])].filter((s) => s.reading.feasible).sort((a, b) => b.score - a.score || code(a.levels) - code(b.levels));
  const supportedRow = ranked.find((s) => s.supported);
  const bestSupported = supportedRow ? materialize(supportedRow) : null;
  const bestDecision = ranked[0] ? materialize(ranked[0]) : null;
  bottleneck = (bestDecision ?? baseline).reading.binding;
  stageEnd = STAGE_SHARES.conditions;
  // 5a. Conditions: the strongest strategies read with the world more favourable than evidenced. Whatever only works then is
  // mathematically possible, not commercially supported. Each global condition is held, moved ×1.5 or moved ×2 (÷ for costs and delays).
  // The world is moved under the supported strategies: "what would have to be true for a plan Brain can defend today".
  const leaders = [...new Set([bestSupported, ...ranked.filter((s) => s.supported).slice(0, 5), ...[...best.values()].filter((s) => s.supported), bestDecision, ...best.values()].filter((s): s is Strategy => !!s))].slice(0, 12);
  const globalConds = conditions.filter((c) => c.scope === 'ALL');
  let bestMathematical: Strategy | null = null;
  const adjFor = (c: Condition, f: number): Adjust => ({ [c.field]: f, ...(c.scope !== 'ALL' ? { only: c.scope } : {}) }) as Adjust;
  const inverse = (c: Condition) => c.field === 'daysToCash' || c.field === 'directCost';
  const STEPS = [1, 1.5, 2] as const;
  const reaches = (s: Strategy) => s.reading.reach >= ctx.required;
  const moves = (s: Strategy) => Object.keys(s.conditions).length;
  // Reaching the requirement first; then the fewest conditions moved, the smallest moves, the strongest.
  const mathBetter = (a: Strategy, b: Strategy | null) => {
    if (!b) return true;
    if (reaches(a) !== reaches(b)) return reaches(a);
    if (!reaches(a)) return a.reading.reach > b.reading.reach + 1e-9;
    const sa = Object.values(a.conditions).reduce((n, v) => n + Math.abs(Math.log(v)), 0);
    const sb = Object.values(b.conditions).reduce((n, v) => n + Math.abs(Math.log(v)), 0);
    return moves(a) < moves(b) || (moves(a) === moves(b) && (sa < sb - 1e-9 || (Math.abs(sa - sb) <= 1e-9 && a.score > b.score)));
  };
  outer: for (const s of leaders) {
    const f = finish(s.levels);
    if (!f) continue;
    const combos = Math.pow(STEPS.length, globalConds.length);
    for (let c = 1; c < combos; c++) {
      if (late()) break outer;
      let x = c;
      const adj: Adjust = {};
      const moved: Record<string, number> = {};
      for (const cond of globalConds) {
        const step = STEPS[x % STEPS.length]!;
        x = Math.floor(x / STEPS.length);
        if (step === 1) continue;
        const fct = inverse(cond) ? 1 / step : step;
        Object.assign(adj, adjFor(cond, fct));
        moved[cond.key] = fct;
      }
      conditionReads++;
      variations++;
      const reading = fastReading(f.rows, f.L, f.committed, adj);
      const challenged = fastReading(f.rows, f.L, f.committed, { ...adj, respond: (adj.respond ?? 1) * 0.5, close: (adj.close ?? 1) * 0.5 });
      const st: Strategy = { ...s, approach: 'CONDITIONS', conditions: moved, reading, challenged, score: fastScore(reading, challenged, assumedCount(s.levels) + Object.keys(moved).length, ctx.remaining), supported: false, assumptions: [], label: '' };
      if (s.supported && mathBetter(st, bestMathematical)) bestMathematical = st;
      await breathe();
    }
  }
  if (bestMathematical) {
    const m: Strategy = materialize(bestMathematical);
    const moved = Object.entries(bestMathematical.conditions);
    bestMathematical = { ...m, label: `${m.label} | world: ${moved.map(([k, v]) => `${k}×${+v.toFixed(2)}`).join(', ')}`, assumptions: [...m.assumptions, ...moved.map(([k, v]) => `${k} ×${+v.toFixed(2)} of the evidenced middle`)] };
  }

  // 5b. Backward from the requirement: the multiple each condition would need, on the strongest supported strategy.
  const anchor = bestSupported ?? bestDecision ?? baseline;
  const af = finish(anchor.levels);
  const requirements: Requirement[] = [];
  const sensitive: VariableSweep['sensitive'] = [];
  if (af) {
    const evidencedTop = (c: Condition): number => {
      const rows = af.rows.filter((r) => r.kind !== 'AGREED');
      if (c.field === 'contacts') return ctx.contactsPerDay.high !== null && (mid(ctx.contactsPerDay) ?? 0) > 0 ? ctx.contactsPerDay.high / mid(ctx.contactsPerDay)! : 1;
      if (c.field === 'days') return 1;
      const xs = ctx.base.openings.filter((o) => o.agreedValue === 0 && rows.some((r) => r.id === o.opportunity.id) && (c.scope === 'ALL' || o.opportunity.id === c.scope));
      const key = c.field as keyof ModelledOpportunity;
      const ratios = xs.map((o) => {
        const x = o[key] as ModelInput;
        const m = mid(x) ?? 0;
        return m > 0 ? (c.field === 'daysToCash' || c.field === 'directCost' ? m / Math.max(1e-9, lo(x)) : hi(x) / m) : 1;
      });
      return ratios.length ? Math.min(...ratios) : 1;
    };
    for (const c of globalConds) {
      const at = (m: number) => {
        conditionReads++;
        variations++;
        return fastReading(af.rows, af.L, af.committed, adjFor(c, inverse(c) ? 1 / m : m)).reach;
      };
      let needed: number | null = null;
      if (at(1) >= ctx.required) needed = 1;
      else if (at(20) >= ctx.required) {
        let a = 1;
        let b = 20;
        for (let i = 0; i < 24; i++) {
          const m = Math.sqrt(a * b);
          if (at(m) >= ctx.required) b = m;
          else a = m;
        }
        needed = b;
      }
      const top = evidencedTop(c);
      requirements.push({ condition: c.key, family: c.family, needed, evidencedTop: top, inEvidence: needed !== null && needed <= top + 1e-9 });
    }
    // Per-opening conditions: the swing between the bottom and top of each evidenced range.
    for (const c of conditions.filter((x) => x.scope !== 'ALL')) {
      const o = ctx.base.openings.find((x) => x.opportunity.id === c.scope);
      if (!o) continue;
      const x = o[c.field as keyof ModelledOpportunity] as ModelInput;
      const m = mid(x) ?? 0;
      if (m <= 0) continue;
      const lowR = fastReading(af.rows, af.L, af.committed, { ...adjFor(c, lo(x) / m) });
      const highR = fastReading(af.rows, af.L, af.committed, { ...adjFor(c, hi(x) / m) });
      conditionReads += 2;
      variations += 2;
      sensitive.push({ condition: c.key, swing: Math.abs(highR.mean - lowR.mean) });
    }
    sensitive.sort((a, b) => b.swing - a.swing || (a.condition < b.condition ? -1 : 1));
  }

  // Directions for the engine: each approach's leader, carrying decisions only, distinct.
  const toDirection = (s: Strategy, approach: string): Direction | null => {
    const program: Transform[] = s.levels.flatMap((l, i) => variables[i]!.levels[l]!.transforms);
    if (program.length === 0) return null;
    return makeDirection({
      name: `Variables (${approach.toLowerCase()}): ${s.label}`.slice(0, 200),
      stance: `VARIABLE:${approach}`,
      origin: 'ALGORITHM',
      thinking: `Swept ${variations} combinations of ${variables.length} decision variable(s); this is the strongest by the ${approach.toLowerCase()} objective (fast reading: mean ${Math.round(s.reading.mean)}, reach ${(s.reading.reach * 100).toFixed(1)}%, halved conversion ${(s.challenged.reach * 100).toFixed(1)}%).`,
      from: 'BASELINE',
      program,
    });
  };
  const dirs: Direction[] = [];
  const sigs = new Set<string>();
  const pushDir = (s: Strategy | null | undefined, a: string) => {
    if (!s) return;
    const d = toDirection(materialize(s), a);
    if (d && !sigs.has(d.signature)) {
      sigs.add(d.signature);
      dirs.push(d);
    }
  };
  pushDir(bestSupported, 'SUPPORTED');
  pushDir(bestDecision, 'BEST');
  for (const [a, s] of best) pushDir(s, a);
  // Then the ranking, skipping a strategy that reads the same as one already handed over: the engine's reads go to different plans.
  const handed: FastReading[] = [bestSupported, bestDecision, ...best.values()].filter((s): s is Strategy => !!s).map((s) => s.reading);
  for (const s of ranked) {
    if (dirs.length >= SWEEP_DIRECTIONS) break;
    if (handed.some((h) => Math.abs(h.mean - s.reading.mean) <= 0.005 * Math.max(1, h.mean) && Math.abs(h.reach - s.reading.reach) < 0.005)) continue;
    handed.push(s.reading);
    pushDir(s, 'RANKED');
  }
  const strategies = [...new Map([...best.entries()].map(([a, s]) => [code(s.levels), materialize({ ...s, approach: a })])).values()].sort((a, b) => b.score - a.score);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const money = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
  const asks = requirements
    .filter((r) => !r.inEvidence && r.needed !== null)
    .sort((a, b) => (a.needed ?? 99) / Math.max(1, a.evidencedTop) - (b.needed ?? 99) / Math.max(1, b.evidencedTop))
    .slice(0, 3)
    .map((r) => `What evidence shows ${r.condition} at ×${r.needed!.toFixed(2)} of today's middle estimate (evidence reaches ×${r.evidencedTop.toFixed(2)})?`);
  const elapsedMs = now() - started;
  const stopped: VariableSweep['stopped'] = variations >= maxVar ? 'VARIATIONS' : timeCut ? 'TIME' : 'COMPLETE';
  const sentence =
    `${variations.toLocaleString('en-US')} variation(s) of ${variables.length} decision variable(s) (space ${space.toLocaleString('en-US')}) and ${conditions.length} condition(s), ${equivalent.toLocaleString('en-US')} equivalent combination(s) not re-read; ` +
    `fast reading: as held mean ${money(baseline.reading.mean)}, reach ${pct(baseline.reading.reach)}; §99's plan ${money(greedy.reading.mean)}, ${pct(greedy.reading.reach)}; ` +
    `strongest supported ${bestSupported ? `${money(bestSupported.reading.mean)}, ${pct(bestSupported.reading.reach)} (${bestSupported.label})` : 'none'}; ` +
    `strongest overall ${bestDecision ? `${money(bestDecision.reading.mean)}, ${pct(bestDecision.reading.reach)}, ${bestDecision.assumptions.length} assumption(s)` : 'none'}; ` +
    `${bottleneck.toLowerCase()} binds; ${requirements.filter((r) => r.inEvidence).length}/${requirements.length} condition(s) could carry the requirement inside evidence.`;
  return {
    variables: variables.map((v) => ({ key: v.key, family: v.family, kind: v.kind, discoveredFrom: v.discoveredFrom, effect: v.effect, fixed: v.fixed, levels: v.levels.length })),
    conditions,
    space,
    variations,
    equivalent,
    screened,
    factorial,
    local,
    conditionReads,
    elapsedMs,
    stopped,
    approaches: [...yieldOf.entries()].map(([approach, y]) => ({ approach, ...y })),
    baseline: baseline.reading,
    greedy: greedy.reading,
    bestSupported,
    bestMathematical,
    strategies,
    requirements,
    sensitive: sensitive.slice(0, 8),
    bottleneck,
    directions: dirs.slice(0, SWEEP_DIRECTIONS),
    asks,
    sentence,
  };
}

/** The sweep, as lines for `goals plan`. */
export function renderSweep(x: VariableSweep, engine?: Map<string, { reach: number; settledP50: number }>): string[] {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
  const lines: string[] = [];
  lines.push(`  variables ${x.sentence}`);
  lines.push(`    counts  screened ${x.screened.toLocaleString('en-US')} · factorial ${x.factorial.toLocaleString('en-US')} · local ${x.local.toLocaleString('en-US')} · conditions ${x.conditionReads.toLocaleString('en-US')} · ${Math.round(x.elapsedMs / 1000)} s · ${x.stopped.toLowerCase()}`);
  for (const v of x.variables) lines.push(`    var     ${v.kind.toLowerCase().padEnd(9)} ${v.family.padEnd(15)} ${String(v.levels).padStart(3)} level(s) effect ${v.effect.toFixed(3)}${v.fixed ? ' (fixed: no effect)' : ''} · ${v.discoveredFrom.slice(0, 90)}`);
  lines.push(`    conds   ${x.conditions.length} condition(s): ${x.conditions.filter((c) => c.scope === 'ALL').map((c) => c.key).join(', ')} + ${x.conditions.filter((c) => c.scope !== 'ALL').length} discovered on openings`);
  for (const a of x.approaches) lines.push(`    approach ${a.approach.padEnd(20)} ${String(a.evaluated).padStart(6)} local read(s), improved ${a.improved}×, best score ${a.best.toFixed(3)}`);
  for (const s of x.strategies.slice(0, 8)) lines.push(`    strategy [${s.approach}${s.supported ? '' : ' · assumed'}] ${s.label.slice(0, 110)} → mean ${money(s.reading.mean)}, p10 ${money(s.reading.p10)}, reach ${pct(s.reading.reach)}, halved ${pct(s.challenged.reach)}, commits ${money(s.reading.committed)}`);
  if (x.bestMathematical) lines.push(`    math    only if the world differs: ${x.bestMathematical.label.slice(0, 140)} → reach ${pct(x.bestMathematical.reading.reach)}, mean ${money(x.bestMathematical.reading.mean)}`);
  for (const r of x.requirements) lines.push(`    needs   ${r.condition.padEnd(18)} ${r.needed === null ? 'no multiple up to ×20 reaches the requirement' : `×${r.needed.toFixed(2)}`} · evidence reaches ×${r.evidencedTop.toFixed(2)} · ${r.inEvidence ? 'SUPPORTED' : 'needs evidence (mathematical only)'}`);
  for (const s of x.sensitive.slice(0, 5)) lines.push(`    evidence ${s.condition.padEnd(40)} swings mean by ${money(s.swing)} across its range`);
  if (engine) for (const d of x.directions) {
    const e = engine.get(d.signature);
    if (e) lines.push(`    engine  ${d.stance.padEnd(22)} ${d.name.slice(0, 90)} → engine reach ${pct(e.reach)}, p50 ${money(e.settledP50)}`);
  }
  return lines;
}
