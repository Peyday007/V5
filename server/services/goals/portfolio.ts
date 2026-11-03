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
import { optimizePortfolio, type Activity, type PortfolioReading } from '../quant/portfolio.ts';
import { makeRng } from '../scenario/random.ts';
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';

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
  /** What keeps the reading from being a probability, or the target from being reached. */
  missing: string[];
  searched: number;
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
  worlds?: number;
  seed?: number;
}): GoalPortfolio {
  const worlds = input.worlds ?? PORTFOLIO_WORLDS;
  const seed = input.seed ?? 20261103;
  const stated = statedContactsPerDay(input.resources);
  const contactsPerDay: ModelInput =
    stated !== null
      ? { value: stated, low: stated, high: stated, provenance: 'EVIDENCE', source: { kind: 'PERSON', ref: 'goal resources' }, note: 'the outreach a day the owner stated' }
      : { value: null, low: CONTACTS_PER_DAY_BOUNDS.low, high: CONTACTS_PER_DAY_BOUNDS.high, provenance: 'UNKNOWN', source: null, note: 'nobody has stated the outreach a day; swept' };
  /*
   * Money tied up before anything has been proved: the owner's per-week limit
   * is what may go out in the first week, before any cash can have returned,
   * so it is the portfolio's starting capital (owner, 2026-11-03: "about $750
   * tied up before proof"). Each arrangement on its own may start with at most
   * the before-proof limit ("about $375 initial individual outlay").
   */
  const startingCapital = input.perWeek ?? input.beforeProof ?? input.capitalCeiling;
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
    if (input.beforeProof !== null && capital.amount > input.beforeProof + 1e-9) {
      refused = capital.established
        ? `ties up ${Math.round(capital.amount)} at its start, more than the ${Math.round(input.beforeProof)} one arrangement may before it proves itself`
        : `the money it ties up is not established and could be up to ${Math.round(capital.amount)}, more than the ${Math.round(input.beforeProof)} one arrangement may before it proves itself`;
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
  if (best && best.reach < 0.9) {
    missing.push(`the best combination reaches the target in ${(best.reach * 100).toFixed(0)}% of worlds; more openings, or better-evidenced ones, are needed for 90%`);
  }
  if (!best) missing.push('no combination of the openings held can run inside the limits');
  return {
    basis,
    best,
    alternatives,
    demand,
    limits: {
      target: input.remaining,
      deadlineDays: input.daysLeft,
      startingCapital,
      perArrangement: input.beforeProof,
      spendCeiling: input.capitalCeiling,
      contactsPerDay: { value: stated, low: contactsPerDay.low ?? 0, high: contactsPerDay.high ?? 0, source: stated !== null ? 'stated by the owner on the goal' : 'not stated; swept' },
      correlation: SHARED_OUTREACH_CORRELATION,
    },
    missing,
    searched: result.searched,
  };
}
