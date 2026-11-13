/**
 * The goal's combined plan, from the quant engine (§79).
 *
 * The scenario sweep asks "if a strategy offered to N buyers and some share
 * agreed, what would settle?" — N is a choice and the share is a range, so it
 * can say what a plan *needs* but never how many sales the market would
 * actually give. The owner's assignment of 2026-11-03 asked for the second:
 * Brain's own engine estimating reachable demand, acquisition, conversion,
 * volume, price, costs, cash timing and downside, and the combined chance of
 * reaching the target with the dependencies between sources counted.
 *
 * So, world by world, each opening's demand is built from its inputs:
 *
 *   prospects contacted = the operation's outreach per day (a capacity every
 *                         opening shares) × its share of it × the days left to
 *                         sell before its cash could no longer settle in time
 *   interested          ~ Poisson(contacted × reply rate)
 *   deals               ~ Binomial(interested, close rate), capped by the
 *                         deals the market can take (`buyerVolume`)
 *   cash                = deals × price (+ money a buyer already agreed)
 *   spend               = deals × direct cost
 *
 * where every rate is the quant engine's estimate from verified research — a
 * published reply or close rate on an opening's card, discounted for how its
 * population differs (`quant/knowledge.ts`) — or Brain's own measured outcomes,
 * or, where nothing bears on it, the bounds the plan already sweeps.
 *
 * `quant/portfolio.ts` then searches the combinations: an opening is offered at
 * a quarter, half or all of the shared outreach, the shares may not exceed the
 * whole, openings that sell through that shared outreach fail together through
 * one risk factor, money tied up is recycled only as cash settles, a world whose
 * spending breaks the ceiling does not count, and only cash settled by the
 * deadline counts. Its answer is a probability only when every input rests on
 * evidence; otherwise it is coverage of the tested conditions and says so —
 * and says which inputs keep it from being one.
 */
import { optimizePortfolio, type Activity, type Assurance, type PortfolioReading, type Safeguard, type SafeguardEffect } from '../quant/portfolio.ts';
import { makeRng } from '../scenario/random.ts';
import { cachedCashKnowledge, type CashKnowledge } from '../quant/knowledge.ts';
import { acquireMarketHistory, historyEvidence, type MarketHistory } from '../quant/history.ts';
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';
import {
  addAction,
  addMoneyRoute,
  addNode,
  addRelation,
  createGraph,
  declareType,
  derive,
  expandToFixpoint,
  fullAccount,
  linkGraphs,
  makeFigure,
  passVolume,
  readMoneyRoute,
  recordClaim,
  trace as traceGraph,
  unknownFigure,
  type ChainReading,
  type ChainStage,
  type CausalGraph,
  type Figure,
  type FigureStatus,
  type MoneyRouteReading,
  type OperationalAction,
  type SharedDependency,
} from '../quant/graph.ts';
import { decompose, type Subproblem } from '../quant/decompose.ts';

export const PORTFOLIO_WORLDS = 2_000;
/** The shares of the shared outreach an opening may be given. */
export const OUTREACH_SHARES = [0.25, 0.5, 1] as const;
/**
 * How strongly openings selling through the same outreach move together. A
 * declared assumption, not a measurement: a bad sending week or a cold season
 * hits every line that shares the mailbox. It is stated on the reading.
 */
export const SHARED_OUTREACH_CORRELATION = 0.5;
/**
 * Prospects one online operation can contact a day when nobody has said: one
 * to two warmed mailboxes. Bounds only — the reading cannot be a probability
 * until a person states the real figure on the goal (`resources`).
 */
export const CONTACTS_PER_DAY_BOUNDS = { low: 10, high: 60 } as const;

export interface Spread {
  p10: number;
  p50: number;
  p90: number;
}

export interface DemandEstimate {
  opportunityId: string;
  title: string;
  repeatable: boolean;
  /** Prospects contacted inside the window, with all of the shared outreach. */
  contacted: Spread;
  interested: Spread;
  deals: Spread;
  revenue: Spread;
  spend: Spread;
  days: Spread;
  price: Spread;
  respond: Spread;
  close: Spread;
  /** Money tied up when it starts. */
  capitalAtStart: number;
  /** Every input rests on evidence or on this Brain's own measurements. */
  justified: boolean;
  /** Each input that does not, by name. */
  unestablished: string[];
  /** Why it cannot be part of any combination, when it cannot. */
  refused: string | null;
}

export interface PortfolioMember {
  opportunityId: string;
  title: string;
  /** Share of the shared outreach; null for a one-off that needs none. */
  share: number | null;
}

export interface PortfolioCombination {
  members: PortfolioMember[];
  /** Share of worlds reaching the target in time and inside the spending ceiling. */
  reach: number;
  settledP10: number;
  settledP50: number;
  settledP90: number;
  /** Share of worlds in which a member could not start for want of capital. */
  capitalShort: number;
  overSpend: number;
}

export interface GoalPortfolio {
  /** PROBABILITY only when every input of every member rests on evidence. */
  basis: 'PROBABILITY' | 'COVERAGE';
  /** Worlds each combination was evaluated over: the sample a reach's interval is read from. */
  worlds: number;
  best: PortfolioCombination | null;
  alternatives: PortfolioCombination[];
  demand: DemandEstimate[];
  limits: {
    target: number;
    deadlineDays: number;
    startingCapital: number | null;
    perArrangement: number | null;
    spendCeiling: number | null;
    contactsPerDay: { value: number | null; low: number; high: number; source: string };
    correlation: number;
  };
  /**
   * What the best combination's reach may be called, from the quant engine's
   * one judgment of it (`quant/portfolio.ts` `assess`): at least 90% only when
   * the lower bound over the smallest real sample behind any member clears it,
   * a defensible range when it does not, and "calibration unavailable" when an
   * input is unvalidated or states no sample. `basis` says whether the inputs
   * are evidence; this says what the number may claim (§95). Null when nothing
   * was searched.
   */
  assurance?: Assurance | null;
  /** The measured change to the downside of each candidate control, over the same worlds as the best combination. */
  safeguards?: SafeguardEffect[];
  /**
   * Each modelled opening's market history, acquired from the project's
   * research and outcomes (CAUSAL-14-7): bid/win record, transaction counts,
   * actual prices and spreads, their sources, and what is still to research.
   */
  marketHistory?: MarketHistory[];
  /**
   * The causal graph of the combination, built from this Brain's own rows
   * (CAUSAL-14-1..4): one graph per opening in it, the route to its money, the
   * volume passed through every bottleneck, and what is shared between them.
   */
  causal?: PortfolioCausal | null;
  /** What keeps the reading from being a probability, or the target from being reached. */
  missing: string[];
  searched: number;
}

/**
 * The independent real observations behind one opening's samples, or
 * undefined when any input that is drawn states none (invariant 39: an
 * unstated sample is never read as a large one). An inferred input carries the
 * observations it was reconstructed from; a fixed term (a price, a cost, days
 * to cash) is a fact rather than a draw and does not bound the sample; a fixed
 * behavioural rate (reply, close, the deals a market takes) is a rate somebody
 * measured on a sample nobody stated, so it does.
 */
const BEHAVIOURAL: ReadonlySet<keyof ModelledOpportunity> = new Set(['respond', 'close', 'volume']);
export function sampleSizeOf(one: ModelledOpportunity): number | undefined {
  if (one.agreedValue > 0) {
    // Money a buyer already agreed still draws whether, and when, it settles:
    // a signed contract is not settled cash, and the counterparty paying (or
    // defaulting) is behaviour measured on a sample, never a certainty. Only
    // a reconstructed record of real collections states that sample; a fixed
    // days-to-cash term says when payment is due, not that it arrives, so it
    // calibrates nothing (invariant 39).
    const days = one.daysToCash;
    return days.inferred ? days.inferred.observations : undefined;
  }
  const drawn: Array<keyof ModelledOpportunity> = one.repeatable ? INPUT_NAMES.map(([key]) => key) : ['price', 'daysToCash', 'close', 'directCost'];
  let n = Number.POSITIVE_INFINITY;
  for (const key of drawn) {
    const input = one[key] as ModelInput;
    if (input.inferred) n = Math.min(n, input.inferred.observations);
    else if (input.value === null || BEHAVIOURAL.has(key)) return undefined;
  }
  return n;
}

/**
 * The controls whose effect on the downside is measured against the best
 * combination, derived from the goal's own structure rather than from a list
 * of businesses: openings that share one outreach could be split onto
 * independent channels; money the ceiling allows beyond what may be tied up
 * before proof could be held back for contingency; and cash collected up front
 * (prepayment) halves the days to usable cash. Each is a question the engine
 * answers over identical worlds — none is assumed to help.
 */
export function candidateSafeguards(activities: readonly Activity[], startingCapital: number | null, capitalCeiling: number | null): Safeguard[] {
  const out: Safeguard[] = [];
  const shared = activities.filter((a) => a.riskGroup === 'shared-outreach').map((a) => a.key);
  if (new Set(shared.map((k) => k.split('@')[0])).size >= 2) {
    out.push({ key: 'independent-outreach-channels', kind: 'INDEPENDENT_CHANNEL', decorrelate: shared });
  }
  if (startingCapital !== null && capitalCeiling !== null && capitalCeiling > startingCapital) {
    out.push({ key: 'contingency-reserve', kind: 'CONTINGENCY', capitalBonus: capitalCeiling - startingCapital });
  }
  const slow = activities.filter((a) => a.days.some((d) => d > 0)).map((a) => a.key);
  if (slow.length > 0) out.push({ key: 'prepayment-terms', kind: 'FASTER_CASH_CYCLE', daysFactor: { activities: slow, factor: 0.5 } });
  return out;
}

/** Whether an input may be read as a distribution of the world rather than a range swept. */
export function established(input: ModelInput): boolean {
  if (input.provenance !== 'EVIDENCE' && input.provenance !== 'HISTORICAL') return false;
  return input.value !== null || (input.distribution !== undefined && input.distribution.kind !== 'RANGE');
}

/** One draw of an input, from its own distribution or its swept range. */
export function sampler(input: ModelInput, rng: () => number): () => number {
  if (input.value !== null) {
    const v = input.value;
    return () => v;
  }
  const d = input.distribution;
  if (d) {
    switch (d.kind) {
      case 'FIXED':
        return () => d.value;
      case 'EMPIRICAL':
        if (d.values.length > 0) return () => d.values[Math.min(d.values.length - 1, Math.floor(rng() * d.values.length))]!;
        break;
      case 'RANGE':
        return () => d.min + rng() * (d.max - d.min);
      case 'TRIANGULAR':
        return () => {
          const u = rng();
          const c = (d.mode - d.min) / Math.max(1e-12, d.max - d.min);
          return u < c ? d.min + Math.sqrt(u * (d.max - d.min) * (d.mode - d.min)) : d.max - Math.sqrt((1 - u) * (d.max - d.min) * (d.max - d.mode));
        };
      case 'NORMAL':
        return () => {
          const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
          return Math.min(d.max, Math.max(d.min, d.mean + d.sd * z));
        };
      default:
        break;
    }
  }
  const low = input.low ?? input.high ?? 0;
  const high = input.high ?? low;
  return () => low + rng() * (high - low);
}

function poisson(mean: number, rng: () => number): number {
  if (!(mean > 0)) return 0;
  if (mean < 30) {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = rng();
    while (p > limit) {
      k += 1;
      p *= rng();
    }
    return k;
  }
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * z));
}

function binomial(n: number, p: number, rng: () => number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n <= 400) {
    let k = 0;
    for (let i = 0; i < n; i++) if (rng() < p) k += 1;
    return k;
  }
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
  return Math.min(n, Math.max(0, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * z)));
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

/**
 * Prospects a day, as the goal's owner stated them in the goal's resources
 * ("40 emails a day", "60 contacts per day"), or null when nobody has.
 */
export function statedContactsPerDay(resources: string | null): number | null {
  if (!resources) return null;
  const match = /(\d{1,5})\s+(?:cold\s+)?(?:emails?|contacts?|messages?|prospects?|touches|outreach(?:es)?)\s+(?:a|per|each)\s+day\b/i.exec(resources);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return n > 0 ? n : null;
}

interface Worlds {
  cash: number[];
  days: number[];
  spend: number[];
  contacted: number[];
  interested: number[];
  deals: number[];
  price: number[];
  respond: number[];
  close: number[];
}

/** One opening's demand and cash, world by world, at one share of the shared outreach. */
export function demandWorlds(one: ModelledOpportunity, share: number, daysLeft: number, contactsPerDay: ModelInput, worlds: number, seed: number): Worlds {
  const rng = makeRng(seed, one.index * 97 + Math.round(share * 100));
  const draw = {
    price: sampler(one.price, rng),
    days: sampler(one.daysToCash, rng),
    respond: sampler(one.respond, rng),
    close: sampler(one.close, rng),
    cost: sampler(one.directCost, rng),
    volume: sampler(one.volume, rng),
    perDay: sampler(contactsPerDay, rng),
  };
  const out: Worlds = { cash: [], days: [], spend: [], contacted: [], interested: [], deals: [], price: [], respond: [], close: [] };
  for (let i = 0; i < worlds; i++) {
    const price = Math.max(0, draw.price());
    const days = Math.max(0, draw.days());
    const respond = Math.min(1, Math.max(0, draw.respond()));
    const close = Math.min(1, Math.max(0, draw.close()));
    const cost = Math.max(0, draw.cost());
    let contacted: number;
    let interested: number;
    let deals: number;
    if (one.agreedValue > 0) {
      // Money a buyer already agreed to needs no prospecting.
      contacted = 0;
      interested = 0;
      deals = 0;
    } else if (!one.repeatable) {
      // A one-off is one named buyer, who asked: the question is only whether they choose us.
      contacted = 1;
      interested = 1;
      deals = rng() < close ? 1 : 0;
    } else {
      // Only prospects contacted early enough for their cash to settle in time count.
      const sellingDays = Math.max(0, daysLeft - days);
      contacted = Math.floor(Math.max(0, draw.perDay()) * share * sellingDays);
      interested = poisson(contacted * respond, rng);
      deals = Math.min(binomial(interested, close, rng), Math.max(0, Math.floor(draw.volume())));
    }
    out.cash.push(one.agreedValue + deals * price);
    out.days.push(days);
    out.spend.push(deals * cost);
    out.contacted.push(contacted);
    out.interested.push(interested);
    out.deals.push(deals);
    out.price.push(price);
    out.respond.push(respond);
    out.close.push(close);
  }
  return out;
}

/** The money an opening ties up when it starts: established, or the top of its range (invariant 39). */
export function capitalAtStart(one: ModelledOpportunity): { amount: number; established: boolean } {
  if (one.capital.value !== null) return { amount: one.capital.value, established: true };
  if (one.capital.inferred?.justified) return { amount: one.capital.inferred.p50, established: true };
  return { amount: one.capital.high ?? one.capital.inferred?.p90 ?? 0, established: false };
}

const INPUT_NAMES: Array<[keyof ModelledOpportunity, string]> = [
  ['price', 'price'],
  ['daysToCash', 'days to usable cash'],
  ['respond', 'reply rate'],
  ['close', 'close rate'],
  ['directCost', 'direct cost'],
  ['volume', 'deals the market can take'],
];

export function evaluateGoalPortfolio(input: {
  openings: ModelledOpportunity[];
  remaining: number;
  daysLeft: number;
  capitalCeiling: number | null;
  beforeProof: number | null;
  perWeek: number | null;
  resources: string | null;
  /**
   * The outreach a day the owner's healthy sending accounts can carry, read
   * from the messaging provider (§94). Shared with the owner's other
   * campaigns, so it widens the swept range's top and is never Brain's own
   * figure; an owner's stated figure wins.
   */
  measuredCapacity?: { perDay: number; accounts: number } | null;
  /**
   * The project's research and outcomes, from which each opening's market
   * history is acquired (CAUSAL-14-7). Absent, the knowledge the same goal
   * tick already loaded is used; with neither, no history is acquired and
   * every opening says so as a research need.
   */
  knowledge?: CashKnowledge | null;
  worlds?: number;
  seed?: number;
}): GoalPortfolio {
  const worlds = input.worlds ?? PORTFOLIO_WORLDS;
  const seed = input.seed ?? 20261103;
  const stated = statedContactsPerDay(input.resources);
  const contactsPerDay: ModelInput =
    stated !== null
      ? { value: stated, low: stated, high: stated, provenance: 'EVIDENCE', source: { kind: 'PERSON', ref: 'goal resources' }, note: 'the outreach a day the owner stated' }
      : input.measuredCapacity && input.measuredCapacity.perDay > CONTACTS_PER_DAY_BOUNDS.low
        ? { value: null, low: CONTACTS_PER_DAY_BOUNDS.low, high: input.measuredCapacity.perDay, provenance: 'UNKNOWN', source: { kind: 'OTHER', ref: 'instantly:accounts' }, note: `up to ${input.measuredCapacity.perDay} a day across the owner's ${input.measuredCapacity.accounts} healthy Instantly sending accounts, shared with the owner's other campaigns; swept` }
        : { value: null, low: CONTACTS_PER_DAY_BOUNDS.low, high: CONTACTS_PER_DAY_BOUNDS.high, provenance: 'UNKNOWN', source: null, note: 'nobody has stated the outreach a day; swept' };
  /*
   * Money tied up before anything has been proved: the owner's per-week limit
   * is what may go out in the first week, before any cash can have returned,
   * so it is the portfolio's starting capital (owner, 2026-11-03: "about $750
   * tied up before proof"). Each arrangement on its own may start with at most
   * the before-proof limit ("about $375 initial individual outlay").
   */
  const startingCapital = input.perWeek ?? input.beforeProof ?? input.capitalCeiling;
  const knowledgeFor = (projectId: string): CashKnowledge | null =>
    input.knowledge !== undefined ? (input.knowledge && input.knowledge.projectId === projectId ? input.knowledge : null) : cachedCashKnowledge(projectId);
  const histories = new Map<string, MarketHistory>();
  const activities: Activity[] = [];
  const memberOf = new Map<string, PortfolioMember>();
  const demand: DemandEstimate[] = [];
  for (const one of input.openings) {
    const id = one.opportunity.id;
    const capital = capitalAtStart(one);
    const unestablished = INPUT_NAMES.filter(([key]) => !established(one[key] as ModelInput)).map(([, name]) => name);
    if (!capital.established) unestablished.push('money tied up');
    if (one.repeatable && stated === null) unestablished.push('outreach a day');
    let refused: string | null = null;
    /*
     * An established outlay over the per-arrangement limit is refused. An
     * unestablished one is not: production, 2026-11-06, refused every opening
     * priced above 375 because its unknown capital was swept up to the whole
     * price — a 1 500 brokered service was out while a 50 one-off stayed in,
     * which is a size bias, not a limit. Unless even its lowest bound breaks
     * the limit, it enters at the middle of the range the limit allows (the
     * expected outlay of the existing sweep, truncated at the limit its test is
     * held to), and "money tied up" stays unestablished. Spending itself is
     * still held to the limits by the commercial authority (`spending.ts`).
     */
    if (input.beforeProof !== null && capital.amount > input.beforeProof + 1e-9) {
      const floor = one.capital.low ?? one.capital.inferred?.p10 ?? 0;
      if (capital.established) {
        refused = `ties up ${Math.round(capital.amount)} at its start, more than the ${Math.round(input.beforeProof)} one arrangement may before it proves itself`;
      } else if (floor > input.beforeProof + 1e-9) {
        refused = `the money it ties up is not established and is at least ${Math.round(floor)}, more than the ${Math.round(input.beforeProof)} one arrangement may before it proves itself`;
      } else {
        capital.amount = (floor + input.beforeProof) / 2;
      }
    }
    const full = demandWorlds(one, 1, input.daysLeft, contactsPerDay, worlds, seed);
    demand.push({
      opportunityId: id,
      title: one.opportunity.title,
      repeatable: one.repeatable,
      contacted: spread(full.contacted),
      interested: spread(full.interested),
      deals: spread(full.deals),
      revenue: spread(full.cash),
      spend: spread(full.spend),
      days: spread(full.days),
      price: spread(full.price),
      respond: spread(full.respond),
      close: spread(full.close),
      capitalAtStart: capital.amount,
      justified: unestablished.length === 0,
      unestablished,
      refused,
    });
    if (refused) continue;
    const shares: number[] = one.repeatable && one.agreedValue === 0 ? [...OUTREACH_SHARES] : [0];
    // The outreach a day is drawn too: unless the owner stated it, it states no sample.
    const sampleSize = one.repeatable && one.agreedValue === 0 && stated === null ? undefined : sampleSizeOf(one);
    // The market's own historical record, acquired from the research and outcomes the project holds.
    const knowledge = knowledgeFor(one.opportunity.projectId);
    const history = knowledge ? acquireMarketHistory(knowledge, one.opportunity) : null;
    if (history) histories.set(id, history);
    const keys = shares.map((share) => `${id}@${share}`);
    for (const share of shares) {
      const w = share === 1 ? full : demandWorlds(one, share, input.daysLeft, contactsPerDay, worlds, seed);
      const key = `${id}@${share}`;
      memberOf.set(key, { opportunityId: id, title: one.opportunity.title, share: share > 0 ? share : null });
      activities.push({
        key,
        label: one.opportunity.title.slice(0, 80),
        cash: w.cash,
        days: w.days,
        spend: w.spend,
        justified: unestablished.length === 0,
        evidence: { ...(sampleSize !== undefined ? { sampleSize } : {}), ...(history ? { history: historyEvidence(history) } : {}) },
        capital: capital.amount,
        startDay: 0,
        ...(share > 0 ? { uses: { outreach: share }, riskGroup: 'shared-outreach' } : {}),
        excludes: keys.filter((other) => other !== key),
      });
    }
  }
  const result = optimizePortfolio({
    activities,
    target: input.remaining,
    deadlineDays: input.daysLeft,
    capacity: { outreach: 1 },
    ...(startingCapital !== null ? { startingCapital } : {}),
    ...(input.capitalCeiling !== null ? { spendCeiling: input.capitalCeiling } : {}),
    riskCorrelation: { 'shared-outreach': SHARED_OUTREACH_CORRELATION },
    safeguards: candidateSafeguards(activities, startingCapital, input.capitalCeiling),
    worlds,
    seed,
  });
  const combination = (reading: PortfolioReading): PortfolioCombination => ({
    members: reading.keys.map((key) => memberOf.get(key)!).filter(Boolean),
    reach: reading.reach,
    settledP10: reading.settledP10,
    settledP50: reading.settledP50,
    settledP90: reading.settledP90,
    capitalShort: reading.capitalShort,
    overSpend: reading.overSpend,
  });
  const best = result.best ? combination(result.best) : null;
  const seen = new Set<string>();
  const alternatives = result.ranked
    .filter((one) => one.feasible && one !== result.best)
    .map(combination)
    .filter((one) => {
      const key = one.members.map((m) => m.opportunityId).sort().join('|');
      if (seen.has(key) || key === (best?.members.map((m) => m.opportunityId).sort().join('|') ?? '')) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
  const memberIds = new Set(best?.members.map((one) => one.opportunityId) ?? []);
  const members = demand.filter((one) => memberIds.has(one.opportunityId));
  const basis: GoalPortfolio['basis'] = members.length > 0 && members.every((one) => one.justified) ? 'PROBABILITY' : 'COVERAGE';
  const missing: string[] = [];
  for (const one of members) if (!one.justified) missing.push(`${one.title.slice(0, 60)}: ${one.unestablished.join(', ')} not established`);
  // Whether the plan may claim 90% is the engine's one judgment, read over the evidence behind it — never the point reading.
  const assurance = result.assurance ?? null;
  if (best && assurance && !assurance.claimsAtLeast90) {
    missing.push(`the best combination reaches the target in ${(best.reach * 100).toFixed(0)}% of worlds, which is not a defensible 90%: ${assurance.reason}`);
  }
  if (!best) missing.push('no combination of the openings held can run inside the limits');
  // Historical data the best combination still lacks is targeted research, named, never assumed.
  for (const need of assurance?.researchNeeds ?? []) missing.push(`research: ${need}`);
  const causal = causalOf(
    input.openings.filter((one) => (memberIds.size > 0 ? memberIds.has(one.opportunity.id) : demand.some((d) => d.opportunityId === one.opportunity.id && !d.refused))),
    demand,
    input.daysLeft,
  );
  // What the graph's decision answers depend on and nobody established goes to research or to an authorized action, by name.
  for (const one of causal?.decisionUnknowns ?? []) missing.push(`${one.sendTo}: ${one.unknown}`);
  return {
    basis,
    worlds,
    best,
    alternatives,
    demand,
    limits: {
      target: input.remaining,
      deadlineDays: input.daysLeft,
      startingCapital,
      perArrangement: input.beforeProof,
      spendCeiling: input.capitalCeiling,
      contactsPerDay: { value: stated, low: contactsPerDay.low ?? 0, high: contactsPerDay.high ?? 0, source: stated !== null ? 'stated by the owner on the goal' : input.measuredCapacity && input.measuredCapacity.perDay > CONTACTS_PER_DAY_BOUNDS.low ? `measured: up to ${input.measuredCapacity.perDay}/day on ${input.measuredCapacity.accounts} healthy Instantly accounts (shared); swept` : 'not stated; swept' },
      correlation: SHARED_OUTREACH_CORRELATION,
    },
    assurance,
    marketHistory: [...histories.values()],
    causal,
    safeguards: result.safeguardEffects ?? [],
    missing,
    searched: result.searched,
  };
}

/* ------------------------------------------------------------------------- */
/* The causal graph, from Brain's own rows (CAUSAL-14-1..4)                  */
/* ------------------------------------------------------------------------- */

export interface OpeningCausal {
  opportunityId: string;
  title: string;
  nodes: number;
  relations: number;
  actions: number;
  /** Who pays, for what, under which terms, through which channel, and what is free to use (per deal, minor units). */
  route: MoneyRouteReading;
  /** Contacts passed through reply, close and the deals the market takes; revenue is read only from its output. */
  chain: ChainReading;
  /** Variables the graph implied and Brain added; each names what implied it. */
  discovered: string[];
  /** Inputs nobody has stated, shown as unknown rather than filled. */
  unknowns: string[];
  /**
   * The decision questions asked of this opening's own graph on every
   * evaluation (CAUSAL-14-4): each change propagated through the money route,
   * cash timing, capital and the chain of this opening and of every opening a
   * shared party or resource ties to it.
   */
  whatIf: WhatIfAnswer[];
  /**
   * An opening Brain itself would fulfil — an AI business — decomposed into the
   * observable causal subproblems that settle it (CAUSAL-14-7). Null when a
   * supplier or person fulfils it.
   */
  decomposition: Subproblem[] | null;
}

/** What one change does to one opening, before and after, through the figures it moves. */
export interface PropagatedEffect {
  opportunityId: string;
  title: string;
  /** Why the change reaches this opening: it is the opening changed, or the shared party or resource that ties it there. */
  via: string;
  before: Record<string, number | null>;
  after: Record<string, number | null>;
  note: string;
}

export interface WhatIfAnswer {
  id: string;
  opportunityId: string;
  question: string;
  change: string;
  effects: PropagatedEffect[];
  /** What in the graph the change stops or delays, read by tracing forward from what changed. */
  breaks: string[];
  /** A different route the change opens, added to the opening's graph beside the original when it is viable. */
  branch: { routeId: string; viable: boolean; why: string } | null;
  /** What the answer depends on that nobody has established, and where it is sent. */
  unknowns: DecisionUnknown[];
}

export interface DecisionUnknown {
  opportunityId: string;
  unknown: string;
  /** Research when evidence could settle it; an authorized action when only asking the counterparty can. */
  sendTo: 'research' | 'authorized action';
}

export interface PortfolioCausal {
  members: OpeningCausal[];
  /** One party or resource more than one opening depends on: a failure of it is every dependent's failure. */
  shared: SharedDependency[];
  /** The whole portfolio graph, unsummarised, for the owner who asks for the complete account. */
  account: ReturnType<typeof fullAccount> | null;
  /** Every decision-critical unknown the what-if answers depend on, each sent to research or to an authorized action. */
  decisionUnknowns: DecisionUnknown[];
}

const PROVENANCE_STATUS: Record<string, FigureStatus> = { EVIDENCE: 'EVIDENCED', HISTORICAL: 'OBSERVED', ASSUMPTION: 'ASSUMED', HYPOTHETICAL: 'ASSUMED' };

/** A model input as a figure: its lineage is the input's own source, and one with none is unknown, never a number. */
function figureOf(input: ModelInput, meaning: string, unit: string, scale = 1): Figure {
  const status = PROVENANCE_STATUS[input.provenance];
  const source = input.source ? `${input.source.kind}:${input.source.ref}` : input.note.trim() || null;
  if (!status || input.value === null || !source) return unknownFigure(meaning, unit, ['the input is stated with a source']);
  const bounded = status !== 'ASSUMED' && input.low !== null && input.high !== null && input.low <= input.value && input.value <= input.high;
  const made = makeFigure({
    meaning, unit, value: input.value * scale, status, source,
    bounds: bounded ? { low: (input.low as number) * scale, high: (input.high as number) * scale } : null,
    invalidatedBy: ['a newer outcome or research claim on this opening'],
  });
  return made.ok ? made.figure : unknownFigure(meaning, unit);
}

/** A stated row field, trimmed; null when nobody stated it. */
const stated = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
/** A stated list ("a; b, c" or one per line) as its items. */
const listed = (value: string | null | undefined): string[] =>
  (stated(value) ?? '').split(/\s*(?:;|\n|,)\s*/).map((one) => one.trim()).filter((one) => one.length >= 3);
const BRAIN_FULFILLER = /^(brain|ai|the ai|brain itself|brain's own)\b/i;
/** Money the opening ties up before it settles, in minor units; null when nobody stated it. */
const capitalCentsOf = (one: ModelledOpportunity): number | null =>
  one.opportunity.peakFundingCents ?? (one.capital.value !== null && one.capital.value > 0 ? Math.round(one.capital.value * 100) : null);

/**
 * How an opening reaches its money, read from its own row: whether a buyer has
 * already agreed, whether an award gate stands between us and the work, and
 * whether prospects have to be found and answer first. Nothing is assumed: an
 * opening with neither an agreement, an award gate nor a repeatable outreach
 * route is sold to the one buyer its row names.
 */
type Acquisition = 'AGREED' | 'AWARD' | 'OUTREACH' | 'NAMED_BUYER';
function acquisitionOf(one: ModelledOpportunity): Acquisition {
  if (one.agreed || one.agreedValue > 0) return 'AGREED';
  if (one.competitiveAward) return 'AWARD';
  if (one.repeatable) return 'OUTREACH';
  return 'NAMED_BUYER';
}

/** Who fulfils, as a source or a person stated it; null when nobody has. */
function fulfillerOf(one: ModelledOpportunity): string | null {
  return stated(one.fulfilledBy?.value) ?? stated(one.opportunity.fulfillmentOwner);
}

interface BuiltGraph {
  graph: CausalGraph;
  /** What discovery added, each naming what in the arrangement implied it. */
  discovered: string[];
}

/**
 * One opening's graph, from its own row and modelled inputs — never a fixed
 * template. Each node, relation, action and chain stage exists because a field
 * of this arrangement states or implies it: the payer, channel, offer scope,
 * acceptance condition, payment terms, fulfiller, delivery route, required
 * inputs and capabilities, deadline, money tied up, an award gate, an agreement
 * already made, a dependency on another opening. A role the seed vocabulary has
 * no word for is declared with the reason, and discovery then expands the graph
 * to its fixpoint from the routes and actions, so what Brain added is returned
 * by name. Nothing here comes from a caller.
 */
function buildCausalGraph(one: ModelledOpportunity): BuiltGraph {
  const o = one.opportunity;
  const g = createGraph(`opening:${o.id}`);
  const ok = (r: { ok: boolean }): void => void r;
  const node = (id: string, type: string, label: string, attributes: Record<string, string | number | boolean | null> = {}): void => ok(addNode(g, { id, type, label, attributes }));
  const relate = (id: string, type: string, from: string, to: string): void => {
    if (g.nodes.has(from) && g.nodes.has(to)) ok(addRelation(g, { id, type, from, to }));
  };
  const declare = (kind: 'node' | 'relation', name: string, reason: string): void => ok(declareType(g, kind, name, reason));

  const acquisition = acquisitionOf(one);
  const payer = stated(o.payer);
  const channel = stated(o.reachableChannel);
  const scope = stated(o.offerScope);
  const acceptance = stated(o.acceptanceCondition);
  const terms = stated(o.paymentTerms);
  const fulfiller = fulfillerOf(one);
  const external = fulfiller !== null && !BRAIN_FULFILLER.test(fulfiller);
  const delivery = stated(o.deliveryMethod);
  const deadline = stated(o.deadline);
  const capitalCents = capitalCentsOf(one);
  const days = one.daysToCash.value;
  const timing = terms ?? (days !== null ? `cash after about ${days} days` : '');

  // The offer is what the payer is paying for, in the row's words.
  node('offer', 'offer', scope ?? o.title, {
    mechanism: String(o.mechanism),
    signal: o.opportunitySignal ?? null,
    industry: o.industry ?? null,
    repeatable: one.repeatable,
    acquisition,
    ...(one.estimated ? { estimatedArrangement: one.estimated.arrangementKey } : {}),
  });
  if (payer) node('payer', 'payer', payer);
  if (channel) node('channel', 'channel', channel);
  if (payer && channel) relate('channel-reaches-payer', 'causes', 'channel', 'payer');
  if (payer) relate('payer-pays-offer', 'pays', 'payer', 'offer');
  node('payment', 'payment', terms ? `payment on ${terms}` : 'cleared payment', { daysToCash: days, terms });
  relate('offer-delivers-payment', 'delivers', 'offer', 'payment');

  // How a buyer is won is the arrangement's own, not a funnel every opening shares.
  if (acquisition === 'AGREED') {
    node('contract', 'contract', `agreement already recorded (${one.agreedDeals || 1})`, { agreedValue: one.agreedValue, deals: one.agreedDeals });
    relate('contract-obliges-offer', 'obliges', 'contract', 'offer');
    if (payer) relate('payer-signed-contract', 'authorizes', 'payer', 'contract');
  } else if (acquisition === 'AWARD') {
    node('award', 'approval', `award by ${payer ?? 'the awarding body'}`);
    relate('award-authorizes-offer', 'authorizes', 'award', 'offer');
    node('lost-award', 'failure_mode', 'the award goes to another bidder');
    relate('award-depends-on-loss', 'depends_on', 'award', 'lost-award');
  } else if (acquisition === 'OUTREACH') {
    node('reach', 'acquisition_event', `prospects reached${channel ? ` through ${channel}` : ''}`);
    if (channel) relate('channel-causes-reach', 'causes', 'channel', 'reach');
    relate('reach-causes-offer', 'causes', 'reach', 'offer');
    node('volume', 'capacity_limit', 'deals the market takes', { deals: one.volume.value });
    relate('volume-constrains-offer', 'constrains', 'volume', 'offer');
    node('no-reply', 'failure_mode', 'prospects do not answer');
    relate('reach-depends-on-reply', 'depends_on', 'reach', 'no-reply');
  } else {
    node('no-sale', 'failure_mode', `${payer ?? 'the named buyer'} does not choose us`);
    relate('offer-depends-on-choice', 'depends_on', 'offer', 'no-sale');
  }

  // Who does the work: a supplier the arrangement depends on, or Brain's own capability.
  if (external) {
    node('fulfiller', 'supplier', fulfiller as string);
    relate('fulfiller-delivers-offer', 'delivers', 'fulfiller', 'offer');
    node('supplier-fails', 'failure_mode', `${fulfiller} does not deliver`);
    relate('fulfiller-depends-on-failure', 'depends_on', 'fulfiller', 'supplier-fails');
  } else if (fulfiller) {
    node('fulfiller', 'capability', fulfiller);
    relate('fulfiller-delivers-offer', 'delivers', 'fulfiller', 'offer');
  }
  for (const [i, capability] of (o.requiredCapabilities ?? []).entries()) {
    node(`capability-${i + 1}`, 'capability', capability);
    relate(`offer-requires-capability-${i + 1}`, 'requires', 'offer', `capability-${i + 1}`);
  }
  for (const [i, input] of listed(o.requiredInputs).entries()) {
    node(`input-${i + 1}`, 'resource', input);
    relate(`offer-requires-input-${i + 1}`, 'requires', 'offer', `input-${i + 1}`);
  }
  if (delivery) {
    declare('node', 'delivery_route', 'The arrangement states how its output reaches the payer; no seed type names the route a delivery travels.');
    node('delivery', 'delivery_route', delivery);
    relate('offer-requires-delivery', 'requires', 'offer', 'delivery');
  }
  if (acceptance) {
    node('acceptance', 'acceptance_condition', acceptance);
    relate('payment-requires-acceptance', 'requires', 'payment', 'acceptance');
  }
  if (deadline) {
    node('deadline', 'time_dependency', `by ${deadline}`);
    relate('deadline-constrains-offer', 'constrains', 'deadline', 'offer');
  }
  if (capitalCents !== null && capitalCents > 0) {
    node('capital', 'resource', 'money tied up before it settles', { cents: capitalCents });
    relate('offer-requires-capital', 'requires', 'offer', 'capital');
  }
  if (stated(o.dependsOnId)) {
    declare('node', 'opening', 'This arrangement depends on another opening; no seed type names a business that belongs to the portfolio beside this one.');
    node('upstream', 'opening', `opening ${o.dependsOnId}`, { opportunityId: o.dependsOnId });
    relate('offer-depends-on-upstream', 'depends_on', 'offer', 'upstream');
  }

  // The operation, step by step, as this arrangement requires it.
  const evidence = [`cash_opportunity:${o.id}`, ...(o.sourceClaimId ? [`research_claim:${o.sourceClaimId}`] : [])];
  const permissions = ['the owner\'s approval of this opening'];
  const spending = 'the commercial authority\'s spending limits';
  const steps: string[] = [];
  const step = (action: Omit<OperationalAction, 'prerequisites' | 'evidence'> & { evidence?: string[] }): void => {
    const added = addAction(g, { ...action, prerequisites: steps.length > 0 ? [steps[steps.length - 1] as string] : [], evidence: action.evidence ?? evidence });
    if (added.ok) steps.push(action.id);
  };
  if (acquisition === 'OUTREACH') {
    step({
      id: 'reach', label: `reach buyers${channel ? ` through ${channel}` : ''}`, actor: 'Brain, for the owner', permissions: [...permissions, spending],
      effect: 'prospects hear of the offer and some answer', timing: 'inside the goal\'s window',
      externalDependencies: [channel ?? 'the owner\'s sending accounts'], completionCondition: 'an interested prospect has answered',
    });
  }
  if (acquisition === 'AWARD') {
    step({
      id: 'bid', label: `bid for ${o.title}`, actor: 'Brain, for the owner', permissions: [...permissions, spending],
      effect: 'a compliant bid is on file', timing: deadline ? `before ${deadline}` : 'before the solicitation closes',
      externalDependencies: [payer ?? 'the awarding body'], completionCondition: 'the award is announced',
    });
  }
  if (acquisition !== 'AGREED') {
    step({
      id: 'agree', label: `agree terms with ${payer ?? 'the buyer'}`, actor: 'Brain, for the owner', permissions,
      effect: `${payer ?? 'the buyer'} commits to pay for ${scope ?? o.title}`, timing: deadline ? `before ${deadline}` : 'inside the goal\'s window',
      externalDependencies: [payer ?? 'the buyer'], completionCondition: 'a signed or recorded agreement exists',
    });
  }
  if (capitalCents !== null && capitalCents > 0) {
    step({
      id: 'fund', label: 'commit the money the work ties up', actor: 'the owner, through the commercial authority', permissions: [spending],
      effect: `${(capitalCents / 100).toFixed(2)} ${o.currency} is committed until it settles`, timing: 'before fulfilment starts',
      externalDependencies: ['the owner\'s account'], completionCondition: 'the commitment is recorded inside its ceiling',
    });
  }
  step({
    id: 'fulfil', label: `deliver ${scope ?? o.title}${delivery ? ` by ${delivery}` : ''}`, actor: fulfiller ?? 'a fulfiller nobody has named yet', permissions: external ? [...permissions, spending] : permissions,
    effect: 'the output reaches the payer', timing: deadline ? `by ${deadline}` : 'not established',
    externalDependencies: [...(external ? [fulfiller as string] : []), ...listed(o.requiredInputs)], completionCondition: 'the output is delivered',
  });
  if (acceptance) {
    step({
      id: 'accept', label: 'obtain acceptance', actor: payer ?? 'the buyer', permissions: ['none'],
      effect: 'the delivery is accepted', timing: 'after delivery', externalDependencies: [payer ?? 'the buyer'], completionCondition: acceptance,
    });
  }
  step({
    id: 'collect', label: `collect from ${payer ?? 'the buyer'}`, actor: 'Brain, for the owner', permissions,
    effect: 'cash clears into the owner\'s account', timing: timing || 'days to cash not established',
    externalDependencies: [payer ?? 'the buyer'], completionCondition: 'the payment is cleared into the owner\'s account',
  });

  const price = figureOf(one.price, 'price per deal', 'cents', 100);
  const cost = figureOf(one.directCost, 'direct cost per deal', 'cents', 100);
  ok(addMoneyRoute(g, {
    id: 'sale',
    payer: payer ?? '',
    for: scope ?? o.title,
    terms: timing,
    channel: acquisition === 'AGREED' ? (channel ?? 'the agreement already recorded') : (channel ?? ''),
    invoicedAt: null,
    collectedAt: null,
    collectedCents: price,
    heldAgainstCents: unknownFigure('held against refund or fulfilment', 'cents', ['a refund or fulfilment term is stated']),
    outflows: cost.value === null ? [] : [{ to: external ? (fulfiller as string) : 'direct cost of delivery', reason: 'cost of one deal', amountCents: cost.value, at: null }],
  }));
  recordClaim(g, 'price', price);
  recordClaim(g, 'directCost', cost);
  if (acquisition === 'OUTREACH') recordClaim(g, 'respond', figureOf(one.respond, 'reply rate', 'ratio'));
  if (acquisition !== 'AGREED') recordClaim(g, 'close', figureOf(one.close, acquisition === 'AWARD' ? 'award rate' : 'close rate', 'ratio'));
  const expanded = expandToFixpoint(g);
  return { graph: g, discovered: expanded.ok ? expanded.value.map((d) => d.because) : [expanded.reason] };
}

/** One opening's graph, from its own row and modelled inputs. Nothing here comes from a caller. */
export function causalGraphOf(one: ModelledOpportunity): CausalGraph {
  return buildCausalGraph(one).graph;
}

/** The opening's own chain: only the stages its route to money passes through. */
function chainOf(one: ModelledOpportunity, contacts: number): ChainReading {
  const acquisition = acquisitionOf(one);
  const stages: ChainStage[] = [];
  if (acquisition === 'OUTREACH') {
    stages.push({ name: 'reply', yield: figureOf(one.respond, 'reply rate', 'ratio') });
    stages.push({ name: 'close', yield: figureOf(one.close, 'close rate', 'ratio'), capacity: figureOf(one.volume, 'deals the market takes', 'deals') });
  } else if (acquisition === 'AWARD') {
    stages.push({ name: 'award', yield: figureOf(one.close, 'award rate', 'ratio') });
  } else if (acquisition === 'NAMED_BUYER') {
    stages.push({ name: 'close', yield: figureOf(one.close, 'close rate', 'ratio') });
  }
  // An agreement already recorded passes no acquisition stage: its deals are the ones agreed.
  const start = acquisition === 'OUTREACH' ? contacts : acquisition === 'AGREED' ? Math.max(1, one.agreedDeals) : 1;
  return passVolume(start, stages);
}

/** The causal reading of the openings a combination holds, from the rows that built it; null when none. */
export function causalOf(openings: ModelledOpportunity[], demand: DemandEstimate[], daysLeft: number | null = null): PortfolioCausal | null {
  if (openings.length === 0) return null;
  const built = openings.map(buildCausalGraph);
  const graphs = built.map((one) => one.graph);
  const linked = graphs.length > 1 ? linkGraphs('portfolio', graphs) : null;
  const shared = linked && linked.ok ? linked.value.shared : [];
  const chains = openings.map((one) => chainOf(one, demand.find((d) => d.opportunityId === one.opportunity.id)?.contacted.p50 ?? 0));
  const routes = built.map(({ graph }) => readMoneyRoute([...graph.routes.values()][0]!));
  const context: WhatIfContext = { openings, graphs, chains, routes, shared, daysLeft };
  const members: OpeningCausal[] = openings.map((one, i) => {
    const { graph: g, discovered } = built[i] as BuiltGraph;
    const route = routes[i] as MoneyRouteReading;
    const whatIf = whatIfOf(context, i);
    return {
      opportunityId: one.opportunity.id,
      title: one.opportunity.title,
      nodes: g.nodes.size,
      relations: g.relations.size,
      actions: g.actions.size,
      route,
      chain: chains[i] as ChainReading,
      discovered,
      unknowns: [...route.gaps, ...whatIf.flatMap((answer) => answer.unknowns.map((one) => one.unknown))],
      whatIf,
      decomposition: decompositionOf(one, g),
    };
  });
  const seen = new Set<string>();
  const decisionUnknowns = members.flatMap((one) => one.whatIf.flatMap((answer) => answer.unknowns)).filter((one) => {
    const key = `${one.opportunityId}|${one.unknown}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    members,
    shared,
    // Built after the what-ifs, so a viable branch they opened is in the complete account.
    account: linked && linked.ok ? fullAccount((linkGraphs('portfolio', graphs) as { ok: true; value: { graph: CausalGraph } }).value.graph) : fullAccount(graphs[0] as CausalGraph),
    decisionUnknowns,
  };
}

/* ------------------------------------------------------------------------- */
/* Asking the graph: what-if, propagated across connected openings          */
/* ------------------------------------------------------------------------- */

interface WhatIfContext {
  openings: ModelledOpportunity[];
  graphs: CausalGraph[];
  chains: ChainReading[];
  routes: MoneyRouteReading[];
  shared: SharedDependency[];
  daysLeft: number | null;
}

/** The other openings a member node of opening i is shared with, through one party or resource. */
function sharedWith(context: WhatIfContext, i: number, node: string): { index: number; via: string }[] {
  const id = `${(context.graphs[i] as CausalGraph).subject}::${node}`;
  const out: { index: number; via: string }[] = [];
  for (const dep of context.shared) {
    if (!dep.members.includes(id)) continue;
    for (const member of dep.members) {
      const subject = member.slice(0, member.indexOf('::'));
      const index = context.graphs.findIndex((g) => g.subject === subject);
      if (index >= 0 && index !== i && !out.some((one) => one.index === index)) out.push({ index, via: `shares the ${dep.type} ${dep.label}` });
    }
  }
  return out;
}

const centsOf = (figure: Figure): number | null => (figure.status === 'UNKNOWN' ? null : figure.value);

/**
 * The decision questions the owner asks of a business, asked of this
 * opening's own graph on every evaluation rather than only when somebody posts
 * one: what changes if the buyer prepays, what breaks if the supplier is late,
 * where an added $1,000 of advertising goes. Each answer carries the change
 * through the money route, cash timing, capital and the chain, to this opening
 * and to every opening a shared party or resource ties to it; a change that
 * opens a different viable route adds it to the graph as a branch; and what the
 * answer depends on that nobody established is sent to research or to an
 * authorized action. Nothing is filled in: an unknown input makes its answer
 * unknown and says so.
 */
function whatIfOf(context: WhatIfContext, i: number): WhatIfAnswer[] {
  const one = context.openings[i] as ModelledOpportunity;
  const o = one.opportunity;
  const g = context.graphs[i] as CausalGraph;
  const chain = context.chains[i] as ChainReading;
  const reading = context.routes[i] as MoneyRouteReading;
  const base = [...g.routes.values()][0]!;
  const payer = stated(o.payer) ?? 'the buyer';
  const answers: WhatIfAnswer[] = [];
  const days = one.daysToCash.value;
  const capital = capitalCentsOf(one);
  const price = centsOf(base.collectedCents);
  const costKnown = base.outflows.every((out) => Number.isFinite(out.amountCents));
  const cost = costKnown ? base.outflows.reduce((sum, out) => sum + out.amountCents, 0) : null;

  // 1. Prepayment: the payer pays in full before delivery.
  if (!/\b(pre-?paid|prepay|up-?front|in advance)\b/i.test(base.terms)) {
    const unknowns: DecisionUnknown[] = [{ opportunityId: o.id, unknown: `whether ${payer} will pay in full before delivery`, sendTo: 'authorized action' }];
    const branchRoute = {
      ...base,
      id: 'sale:prepaid',
      terms: 'paid in full before delivery',
      heldAgainstCents: derive('held against fulfilment until delivery', 'cents', [base.collectedCents], ([p]) => p ?? 0),
    };
    const branchReading = readMoneyRoute(branchRoute);
    const capitalAfter = capital === null ? null : price === null ? null : Math.max(0, capital - price);
    const marginAfterDelivery = price !== null && cost !== null ? price - cost : null;
    const viable = marginAfterDelivery !== null && marginAfterDelivery >= 0;
    if (price === null) unknowns.push({ opportunityId: o.id, unknown: 'the price per deal', sendTo: 'research' });
    if (cost === null) unknowns.push({ opportunityId: o.id, unknown: 'the direct cost per deal', sendTo: 'research' });
    if (viable) addMoneyRoute(g, branchRoute);
    const freed = capital !== null && capitalAfter !== null ? capital - capitalAfter : null;
    const effects: PropagatedEffect[] = [{
      opportunityId: o.id, title: o.title, via: 'the opening changed',
      before: { freeCents: reading.freeCents.value, daysToCash: days, capitalCents: capital },
      after: { freeCents: branchReading.freeCents.value, freeCentsOnDelivery: marginAfterDelivery, daysToCash: days === null ? null : 0, capitalCents: capitalAfter },
      note: price === null
        ? 'the price is unknown, so neither the hold nor the capital it would free can be computed'
        : `the whole ${price} cents collected is held against fulfilment until delivery, then released; cash arrives at order instead of after ${days ?? 'an unknown number of'} days`,
    }];
    // Capital the prepayment frees is the goal's shared ceiling: every other opening that ties money up gets the room.
    if (freed !== null && freed > 0) {
      context.openings.forEach((other, j) => {
        const need = capitalCentsOf(other);
        if (j === i || need === null || need <= 0) return;
        effects.push({
          opportunityId: other.opportunity.id, title: other.opportunity.title, via: 'draws on the same capital ceiling',
          before: { capitalCents: need, ceilingRoomFreedCents: 0 }, after: { capitalCents: need, ceilingRoomFreedCents: freed },
          note: `${freed} cents of the ceiling this opening no longer ties up can fund ${need <= freed ? 'all' : 'part'} of this opening's ${need} cents`,
        });
      });
    }
    answers.push({
      id: `${o.id}:prepaid`, opportunityId: o.id,
      question: `What happens if ${payer} prepays?`,
      change: `terms "${base.terms || 'unstated'}" → paid in full before delivery`,
      effects, breaks: [],
      branch: {
        routeId: 'sale:prepaid', viable,
        why: viable
          ? `prepaid, the deal still leaves ${marginAfterDelivery} cents once delivery releases the hold, and cash arrives at order`
          : marginAfterDelivery === null ? 'not established: the price or the direct cost is unknown' : `prepaid, the deal still loses ${-marginAfterDelivery} cents after delivery`,
      },
      unknowns,
    });
  }

  // 2. The supplier is late: what stops, here and in every opening that depends on the same supplier.
  if (g.nodes.get('fulfiller')?.type === 'supplier') {
    const supplier = g.nodes.get('fulfiller')!.label;
    const traced = traceGraph(g, 'fulfiller', 'forward');
    const breaks = [...new Set((traced?.reached ?? []).filter((r) => r.node.type !== 'failure_mode').map((r) => `${r.node.type}: ${r.node.label}`))];
    for (const step of ['fulfil', 'accept', 'collect']) if (g.actions.has(step)) breaks.push(`action: ${g.actions.get(step)!.label}`);
    const affected = [{ index: i, via: `fulfilled by ${supplier}` }, ...sharedWith(context, i, 'fulfiller')];
    const effects: PropagatedEffect[] = affected.map(({ index, via }) => {
      const member = context.openings[index] as ModelledOpportunity;
      const d = member.daysToCash.value;
      const slack = context.daysLeft !== null && d !== null ? Math.max(0, Math.floor(context.daysLeft - d)) : null;
      return {
        opportunityId: member.opportunity.id, title: member.opportunity.title, via,
        before: { daysToCash: d, freeCentsPerDeal: (context.routes[index] as MoneyRouteReading).freeCents.value },
        after: { daysToCashPerDayLate: d === null ? null : 1, toleratesDelayDays: slack },
        note: slack === null
          ? 'each day the supplier is late moves collection a day later; when that passes the goal\'s deadline is unknown'
          : `each day late moves collection a day later; after ${slack} days late the cash lands past the goal's deadline and does not count`,
      };
    });
    answers.push({
      id: `${o.id}:supplier-late`, opportunityId: o.id,
      question: `What breaks if ${supplier} delivers late?`,
      change: `${supplier} delivers later than planned`,
      effects, breaks, branch: null,
      unknowns: [{ opportunityId: o.id, unknown: `how reliably ${supplier} delivers on time`, sendTo: 'research' }],
    });
  }

  // 3. An added $1,000 of advertising: where it goes, and whether a constraint stops it becoming sales.
  if (acquisitionOf(one) === 'OUTREACH') {
    const channel = stated(o.reachableChannel) ?? 'the outreach channel';
    const cap = chain.stages.find((stage) => stage.capped);
    const unknowns: DecisionUnknown[] = [];
    if (!cap) unknowns.push({ opportunityId: o.id, unknown: `how many buyers $1,000 of advertising reaches through ${channel}, and at what reply rate as spend grows`, sendTo: 'research' });
    const effects: PropagatedEffect[] = [{
      opportunityId: o.id, title: o.title, via: 'the opening changed',
      before: { outputUnits: chain.outputUnits },
      after: { outputUnits: cap ? chain.outputUnits : null },
      note: cap
        ? `${cap.name} already caps sales, so the $1,000 buys no more deals here`
        : 'the spend enters at reach; what it buys is unknown, so sales after it are unknown rather than the old rate scaled up',
    }];
    for (const { index, via } of sharedWith(context, i, 'channel')) {
      const other = context.chains[index] as ChainReading;
      effects.push({
        opportunityId: (context.openings[index] as ModelledOpportunity).opportunity.id, title: (context.openings[index] as ModelledOpportunity).opportunity.title, via,
        before: { outputUnits: other.outputUnits }, after: { outputUnits: null },
        note: 'the same channel carries this opening too: added spend competes for its buyers, so its sales after the change are unknown',
      });
    }
    answers.push({
      id: `${o.id}:advertising`, opportunityId: o.id,
      question: 'Where does an added $1,000 of advertising go?',
      change: `100000 cents more spent reaching buyers through ${channel}`,
      effects, breaks: [], branch: null, unknowns,
    });
  }
  return answers;
}

/**
 * An opening Brain itself fulfils is an AI business; it is decomposed into the
 * same observable causal subproblems as any other, with what its row already
 * says toward each attached and every one left UNKNOWN until observed.
 */
function decompositionOf(one: ModelledOpportunity, g: CausalGraph): Subproblem[] | null {
  const fulfiller = fulfillerOf(one);
  if (fulfiller === null || !BRAIN_FULFILLER.test(fulfiller)) return null;
  const o = one.opportunity;
  const route = [...g.routes.values()][0];
  const decomposed = decompose(new Map(), [], {
    demand: stated(o.payer),
    access: stated(o.reachableChannel),
    capability: `fulfilled by ${fulfiller}${o.requiredCapabilities.length > 0 ? `; needs ${o.requiredCapabilities.join(', ')}` : ''}`,
    'unit-cost': one.directCost.value === null ? null : `${one.directCost.value} ${o.currency} per deal (${one.directCost.provenance.toLowerCase()})`,
    capacity: one.volume.value === null ? null : `${one.volume.value} deals the market takes (${one.volume.provenance.toLowerCase()})`,
    purchase: one.agreed ? `${one.agreedDeals} agreement(s) recorded` : null,
    acceptance: stated(o.acceptanceCondition),
    payment: stated(o.paymentTerms),
    obligations: route && route.outflows.length > 0 ? route.outflows.map((out) => `${out.to}: ${out.reason}`).join('; ') : null,
    failure: null,
  });
  return decomposed.ok ? decomposed.subproblems : null;
}
