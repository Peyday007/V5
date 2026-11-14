/**
 * The goal-to-transaction reasoning loop (§93).
 *
 * The plan (`plan.ts`) judged openings somebody found against the goal: an
 * opening with no buyer was "missing a link", and the next round was asked to
 * find a better opening. Nothing reasoned from the goal to the shape of the
 * transactions it needs, nothing turned a partial opening into a complete
 * transaction by constructing its missing component, and nothing said which
 * unknown, once known, would change the plan. On 2026-11-08 production read
 * NOT_VIABLE over 19 openings, most of them a provider's own price page —
 * evidence of what buyers pay a supplier, read only as "no buyer".
 *
 * This is one pure reading over what the plan already composed — the goal's
 * figures, the modelled openings and constructed estimates, the plan's own link
 * judgements and the quant portfolio's limits. Nothing here is a second
 * planner, simulator or queue: it reads, constructs and ranks, and its outputs
 * go through the doors that already exist (the goal round's question, path
 * research's needs, the sales list).
 *
 *  1. **Backward from the goal** (`requiredStructures`). For deal counts from
 *     one to a thousand, and for a recurring fee, the net each transaction must
 *     carry, the prospects that needs at the conversion bounds the model
 *     sweeps, the prospects a day that is against the shared outreach the
 *     portfolio models, and the days left to settle. A structure the outreach
 *     cannot carry even at the best conversion needs an inbound channel; one
 *     that cannot settle in time is impossible. Mathematical structures only —
 *     no sector, no business.
 *  2. **A transaction model per opening** (`pathwayOf`). Buyer and motivation,
 *     channel, offer, fulfiller, revenue, acquisition and fulfilment cost, net
 *     contribution, conversion, volume and frequency, time to cash, capital,
 *     dependencies, permissions and failure points — each PROVEN, ESTIMATED
 *     or UNKNOWN with the row or rule behind it. Nothing is invented: an
 *     unknown stays unknown, and is solved for (`breakEven`) instead.
 *  3. **Missing links are constructed** (`constructMoves`). Supply evidence
 *     with no buyer becomes a buyer-acquisition path against the supplier's
 *     own published price; demand with no supplier, a supplier-acquisition
 *     path with the most a supplier may cost; no margin, a change of role
 *     (referral, own production, bundle); slow cash, a payment structure; one
 *     small sale, the same deliverable to its population. Each move names the
 *     component, what it would take, the figure it must hit, and the card field
 *     whose research settles it.
 *  4. **The quantity shapes the search** (`fitOf`, `informationValue`). Each
 *     pathway is checked against the deals, prospects and days its share of
 *     the goal needs, and names the lever that fails first. Unknowns are
 *     ranked by how far their range moves the pathway's contribution, and
 *     whether that could move it into or out of the leading combination.
 *  5. **A living portfolio** (`livingPortfolio`). Executable pathways (every
 *     commercial link established or estimated with a basis; only a permission
 *     may block), constructed alternatives, contributions gross and net, the
 *     strongest combination under the shared outreach and capital, correlated
 *     groups, a fallback if the leader's group fails, and the gaps left.
 *     Provisional, and never a probability.
 *  6. **Its own failures** (`reasoningFailures`). Barren rounds with no usable
 *     offer is a construction problem; priced pathways with no channel an
 *     acquisition problem; reachable ones too slow a timing problem; small
 *     tickets with no volume a volume question; one gap across many pathways a
 *     method problem. Each is a `ResearchDiagnosis`, so the next round is
 *     asked differently through the door that already exists.
 */
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';
import type { GoalPortfolio } from './portfolio.ts';
import type { TargetReading } from './target.ts';
import type { ChainLink, ConsideredOpening } from './plan.ts';
import type { GoalRoundOutcome, ResearchDiagnosis } from './researchYield.ts';

/**
 * How far a property is established. `DENIED` is a known answer: something is
 * known not to hold (a permission not granted) — never read as lack of knowledge.
 */
export type FactStatus = 'PROVEN' | 'ESTIMATED' | 'UNKNOWN' | 'DENIED';

/** One property of a transaction, with how far it is established. */
export interface PathFact {
  /** A number in major units (or a share), or text; null when unknown. */
  value: number | string | null;
  low: number | null;
  high: number | null;
  status: FactStatus;
  basis: string;
}

/* ------------------------------------------------------------------ */
/* 1. Backward from the goal                                           */
/* ------------------------------------------------------------------ */

export const STRUCTURE_KINDS = ['HIGH_TICKET', 'MID_TICKET', 'HIGH_FREQUENCY', 'RECURRING', 'COMBINATION'] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

/**
 * The conversion bounds the goal model already sweeps for a prospect nobody has
 * measured (`goalScenario.ts`): reply 0.2–15 %, close 2–50 %. The structures
 * use the same bounds so the two never describe different worlds.
 */
export const CONVERSION_BOUNDS = { replyLow: 0.002, replyHigh: 0.15, closeLow: 0.02, closeHigh: 0.5 } as const;
/** Deal counts the backward pass solves for, one to a thousand. */
export const STRUCTURE_DEALS = [1, 3, 10, 30, 100, 300, 1000] as const;
/** Days a deal takes from the first contact to an agreement, at the least: a reply, then a yes. */
export const MIN_SALES_CYCLE_DAYS = 2;
/** A recurring flow is billed monthly, first payment at signing. */
export const RECURRING_CYCLE_DAYS = 30;
/** Below this share of the goal, one pathway is a contributor, not a plan. */
export const MATERIAL_SHARE = 0.1;

export interface StructureRequirement {
  kind: StructureKind;
  label: string;
  /** Transactions (or subscribers) needed to close the remaining gap. */
  deals: number;
  /** Net contribution each transaction must carry, in major units. */
  netPerDeal: number;
  /** Payments one recurring buyer makes before the deadline; one otherwise. */
  paymentsPerBuyer: number;
  /** Prospects needed at the best and the middle of the conversion bounds. */
  prospects: { best: number; middle: number };
  /** Prospects a day over the selling window, at the best and the middle. */
  perDay: { best: number; middle: number };
  sellingDays: number;
  /** The most one transaction may tie up before it pays, and in all at once. */
  capitalPerDeal: number | null;
  verdict: 'OUTREACH_CAN_CARRY' | 'ONLY_AT_BEST_CONVERSION' | 'NEEDS_INBOUND_CHANNEL' | 'IMPOSSIBLE';
  reason: string;
}

export interface GoalStructures {
  remaining: number;
  daysLeft: number;
  currency: string;
  outreachPerDay: { low: number; high: number; stated: boolean };
  structures: StructureRequirement[];
  /** The smallest net per deal the shared outreach can carry at the middle of the conversion bounds. */
  minimumNetForOutreach: number | null;
  /** One sentence the next search is given: what shape of transaction would close the gap. */
  searchBrief: string;
}

const geometric = (a: number, b: number) => Math.sqrt(a * b);

export function money(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  if (Math.abs(n) >= 100) return String(Math.round(n));
  return String(Math.round(n * 100) / 100);
}

/**
 * Which transaction structures could close the gap, from the goal's own figures.
 * Pure. A structure is rejected only for an arithmetic reason: it cannot settle
 * before the deadline, or it needs more prospects a day than any channel the
 * model knows of could carry even if every input were at its best.
 */
export function requiredStructures(input: {
  remaining: number;
  daysLeft: number | null;
  currency: string;
  perArrangement: number | null;
  spendCeiling: number | null;
  outreachPerDay: { low: number; high: number; stated: boolean };
}): GoalStructures {
  const remaining = Math.max(0, input.remaining);
  const daysLeft = Math.max(0, input.daysLeft ?? 0);
  const best = CONVERSION_BOUNDS.replyHigh * CONVERSION_BOUNDS.closeHigh;
  const middle = geometric(CONVERSION_BOUNDS.replyLow, CONVERSION_BOUNDS.replyHigh) * geometric(CONVERSION_BOUNDS.closeLow, CONVERSION_BOUNDS.closeHigh);
  const sellingDays = Math.max(0, daysLeft - MIN_SALES_CYCLE_DAYS);
  const capacity = input.outreachPerDay.high;
  const structures: StructureRequirement[] = [];
  const judge = (deals: number, settleDays: number) => {
    const prospects = { best: Math.ceil(deals / best), middle: Math.ceil(deals / middle) };
    const window = Math.max(1, sellingDays - settleDays);
    const perDay = { best: prospects.best / window, middle: prospects.middle / window };
    let verdict: StructureRequirement['verdict'];
    let reason: string;
    if (sellingDays - settleDays < 1) {
      verdict = 'IMPOSSIBLE';
      reason = `a sale takes at least ${MIN_SALES_CYCLE_DAYS} days and its money ${settleDays} more; ${daysLeft} are left`;
    } else if (perDay.middle <= capacity) {
      verdict = 'OUTREACH_CAN_CARRY';
      reason = `${money(perDay.middle)} prospects a day at the middle of the conversion bounds, inside the ${capacity} a day the shared outreach can reach`;
    } else if (perDay.best <= capacity) {
      verdict = 'ONLY_AT_BEST_CONVERSION';
      reason = `only if conversion is near its best: ${money(perDay.best)} prospects a day at the best bounds, ${money(perDay.middle)} at the middle, against ${capacity} a day — conversion is the decisive unknown, and only selling measures it`;
    } else {
      verdict = 'NEEDS_INBOUND_CHANNEL';
      reason = `${money(perDay.best)} prospects a day even at the best conversion, more than the ${capacity} outreach can reach: buyers must come to it (a marketplace listing, a storefront, a partner's list, search)`;
    }
    return { prospects, perDay, verdict, reason, window };
  };
  for (const deals of STRUCTURE_DEALS) {
    const kind: StructureKind = deals <= 3 ? 'HIGH_TICKET' : deals <= 30 ? 'MID_TICKET' : 'HIGH_FREQUENCY';
    // Larger, fewer deals are invoiced; small, frequent ones are paid at checkout.
    const settle = kind === 'HIGH_TICKET' ? 14 : kind === 'MID_TICKET' ? 7 : 2;
    const j = judge(deals, settle);
    structures.push({
      kind,
      label: `${deals} deal${deals === 1 ? '' : 's'} netting ${money(remaining / deals)} ${input.currency} each`,
      deals,
      netPerDeal: remaining / deals,
      paymentsPerBuyer: 1,
      prospects: j.prospects,
      perDay: j.perDay,
      sellingDays,
      capitalPerDeal: input.perArrangement === null ? null : input.spendCeiling === null ? input.perArrangement : Math.min(input.perArrangement, input.spendCeiling / deals),
      verdict: j.verdict,
      reason: j.reason,
    });
  }
  // A recurring flow: buyers billed at signing and again each cycle before the deadline.
  const payments = Math.max(1, 1 + Math.floor(Math.max(0, sellingDays - 2) / RECURRING_CYCLE_DAYS));
  for (const subscribers of [30, 100]) {
    const j = judge(subscribers, 2);
    structures.push({
      kind: 'RECURRING',
      label: `${subscribers} recurring buyers paying ${money(remaining / subscribers / payments)} ${input.currency} a cycle, ${payments} payment${payments === 1 ? '' : 's'} each before the deadline`,
      deals: subscribers,
      netPerDeal: remaining / subscribers / payments,
      paymentsPerBuyer: payments,
      prospects: j.prospects,
      perDay: j.perDay,
      sellingDays,
      capitalPerDeal: input.perArrangement,
      verdict: j.verdict,
      reason: payments === 1 ? `${j.reason}; with ${daysLeft} days left a recurring buyer pays once before the deadline, so it is a one-off here and an asset after` : j.reason,
    });
  }
  // A combination: half from a few large deals, half from many small ones, sharing the outreach.
  {
    const few = 3;
    const many = 100;
    const j = judge(few + many, 7);
    structures.push({
      kind: 'COMBINATION',
      label: `${few} deals netting ${money(remaining / 2 / few)} plus ${many} netting ${money(remaining / 2 / many)} ${input.currency}`,
      deals: few + many,
      netPerDeal: remaining / (few + many),
      paymentsPerBuyer: 1,
      prospects: j.prospects,
      perDay: j.perDay,
      sellingDays,
      capitalPerDeal: input.perArrangement,
      verdict: j.verdict,
      reason: `${j.reason}; two independent sources fail apart unless they share a buyer or a channel`,
    });
  }
  // The smallest net per deal outreach alone can carry at the middle of the conversion bounds.
  const window = Math.max(0, sellingDays - 7);
  const dealsByOutreach = capacity * window * middle;
  const minimumNetForOutreach = dealsByOutreach >= 1 ? remaining / dealsByOutreach : null;
  const inbound = structures.filter((one) => one.verdict === 'NEEDS_INBOUND_CHANNEL');
  const searchBrief =
    remaining <= 0
      ? ''
      : `Quantitatively, closing the ${money(remaining)} ${input.currency} still needed in ${daysLeft} days takes ` +
        (minimumNetForOutreach !== null
          ? `either deals netting at least about ${money(minimumNetForOutreach)} ${input.currency} each sold by direct outreach (about ${Math.max(1, Math.floor(dealsByOutreach))} deals at ${capacity} prospects a day and middling conversion)`
          : 'more deals than direct outreach can close in the time left')
        + (inbound.length > 0 ? `, or many smaller sales (${inbound[0]!.deals}+ at ${money(inbound[0]!.netPerDeal)}) through a channel where buyers come to the offer` : '')
        + `. At unmeasured cold-outreach conversion that is the arithmetic, so prefer buyers already asking for the work (a posted request, an open submission call, a marketplace where buyers post jobs), whose conversion is far above cold outreach`
        + `; each must settle within ${Math.max(1, daysLeft - MIN_SALES_CYCLE_DAYS)} days and tie up no more than ${input.perArrangement === null ? 'the goal allows' : `${money(input.perArrangement)} ${input.currency}`} before it pays. ` +
        `Report any buyer activity of that shape in any industry or place — including a supplier's published price that buyers pay today, which Brain can construct a competing or reselling offer against.`;
  return { remaining, daysLeft, currency: input.currency, outreachPerDay: input.outreachPerDay, structures, minimumNetForOutreach, searchBrief };
}

/* ------------------------------------------------------------------ */
/* 2. A transaction model per opening                                  */
/* ------------------------------------------------------------------ */

export const GAP_KINDS = [
  'NO_BUYER',
  'SUPPLY_WITHOUT_BUYER',
  'NO_CHANNEL',
  'NO_OFFER',
  'NO_PRICE',
  'NO_SUPPLIER',
  'NO_MARGIN',
  'SLOW_OR_UNKNOWN_CASH',
  'OVER_CAPITAL',
  'SMALL_TICKET_VOLUME_UNKNOWN',
  'ONE_BUYER',
  'CLOSED',
  'ONE_TRANSACTION_SHAPE',
  'REACH_SHORTFALL',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

export type MoveAction = 'SELL' | 'RESEARCH' | 'CONSTRUCT';

/** A way to create or acquire a missing component, re-quantified where the evidence allows. */
export interface ConstructionMove {
  gap: GapKind;
  /** The component the move creates or acquires, in plain words. */
  construct: string;
  /** The number it must hit for the pathway to carry its share, when one can be solved. */
  mustHit: string | null;
  /** The card field whose research settles the move, or null when only acting settles it. */
  field: 'payer' | 'access' | 'fulfillment' | 'revenueRange' | 'directCosts' | 'timeToFirstCash' | 'requiredCapital' | 'buyerVolume' | 'conversionRates' | null;
  /** The research question that settles it, phrased as the constructed transaction. */
  ask: string | null;
  action: MoveAction;
  /** The transaction the move would produce, re-quantified from the same evidence, when one can be. */
  variant: { label: string; revenuePerDeal: PathFact; costPerDeal: PathFact; net: PathFact } | null;
  /** Other transaction sizes and arrangements for the same deliverable, compared on cash collectible before the deadline. */
  shapes?: TransactionShape[];
}

/**
 * One way to sell the same deliverable: a single unit, a prepaid bundle, a
 * monthly retainer, or an implementation engagement. Every figure is the
 * unit's own evidence times a stated quantity — ESTIMATED until a buyer of
 * that size is evidenced — and `collectible` counts only what settles before
 * the deadline (a retainer's later months do not).
 */
export interface TransactionShape {
  kind: 'UNIT' | 'BUNDLE' | 'RETAINER' | 'IMPLEMENTATION';
  label: string;
  /** Price per transaction, major units. */
  price: number;
  units: number;
  /** What one such transaction puts toward the goal before the deadline, net of the bounded unit cost. */
  collectible: number;
  /** Transactions of this size that carry the whole gap. */
  dealsForGap: number;
  basis: string;
}

/** Bundle, retainer and implementation sizes, relative to one unit. Exploration bounds, not findings. */
export const SHAPE_MULTIPLES = { bundle: { units: 10, discount: 0.1 }, retainer: { unitsPerMonth: 4, discount: 0.15 }, implementation: { units: 5, setupUnits: 3 } } as const;

/**
 * The transaction sizes worth comparing for a priced deliverable (owner,
 * 2026-11-09: "do not freeze business models at one price, offer, buyer, or
 * delivery method"). Pure; ranked by what one transaction collects before
 * the deadline, so a larger arrangement that cannot settle in time does not
 * outrank a smaller one that can.
 */
export function transactionShapes(input: { unitPrice: number; unitCost: number | null; remaining: number; daysLeft: number; daysToCash: number | null }): TransactionShape[] {
  const { unitPrice, remaining } = input;
  if (!(unitPrice > 0)) return [];
  const cost = Math.max(0, input.unitCost ?? 0);
  const settles = input.daysToCash === null || input.daysToCash <= Math.max(0, input.daysLeft - MIN_SALES_CYCLE_DAYS);
  const months = Math.max(1, Math.floor(Math.max(0, input.daysLeft - MIN_SALES_CYCLE_DAYS) / RECURRING_CYCLE_DAYS) + 1);
  const b = SHAPE_MULTIPLES.bundle;
  const r = SHAPE_MULTIPLES.retainer;
  const i = SHAPE_MULTIPLES.implementation;
  const shape = (kind: TransactionShape['kind'], label: string, price: number, units: number, collectibleGross: number, basis: string): TransactionShape => {
    const collectible = settles ? Math.max(0, collectibleGross - cost * units) : 0;
    return { kind, label, price, units, collectible, dealsForGap: collectible > 0 ? Math.ceil(remaining / collectible) : Infinity, basis };
  };
  const retainerMonthly = unitPrice * r.unitsPerMonth * (1 - r.discount);
  const out = [
    shape('UNIT', 'one unit at the evidenced price', unitPrice, 1, unitPrice, 'the unit price on the card'),
    shape('BUNDLE', `a prepaid bundle of ${b.units} at ${b.discount * 100}% off`, unitPrice * b.units * (1 - b.discount), b.units, unitPrice * b.units * (1 - b.discount), `${b.units} units, paid at order`),
    shape('RETAINER', `a monthly retainer of ${r.unitsPerMonth} units, billed monthly in advance`, retainerMonthly, r.unitsPerMonth * months, retainerMonthly * months, `${months} month(s) billed before the deadline; later months do not count`),
    shape('IMPLEMENTATION', `an implementation engagement: setup and process design (${i.setupUnits} units' worth) plus ${i.units} delivered units, deposit at signature`, unitPrice * (i.units + i.setupUnits), i.units, unitPrice * (i.units + i.setupUnits), 'consulting and implementation priced from the unit, paid as a deposit and on delivery'),
  ];
  return out.sort((x, y) => y.collectible - x.collectible);
}

export interface TransactionFit {
  /** Deals at the middle net to carry the whole gap, and a tenth of it. */
  dealsForGap: number | null;
  dealsForShare: number | null;
  /** The most deals the pathway's own volume allows, when known or bounded. */
  dealsAvailable: number | null;
  /** Prospects a day its share needs at its middle conversion over its selling window. */
  prospectsPerDay: number | null;
  verdict: 'CARRIES_GAP' | 'CARRIES_SHARE' | 'TOO_SMALL_AS_IS' | 'UNPRICED' | 'CANNOT_SETTLE';
  /** The variable that fails first, and what changing it would take. */
  lever: { variable: 'PRICE' | 'VOLUME' | 'CHANNEL' | 'TIMING' | 'MECHANISM' | 'MARGIN' | null; change: string };
}

export interface TransactionPathway {
  opportunityId: string;
  title: string;
  origin: 'FOUND' | 'CONSTRUCTED';
  buyer: PathFact;
  motivation: PathFact;
  channel: PathFact;
  offer: PathFact;
  fulfiller: PathFact;
  revenuePerDeal: PathFact;
  acquisitionCost: PathFact;
  fulfilmentCost: PathFact;
  net: PathFact;
  conversion: PathFact;
  volume: PathFact;
  frequency: PathFact;
  daysToCash: PathFact;
  capital: PathFact;
  /** Rights and authorization: what this transaction may do under the permissions held; never a guess (§93). */
  rights: PathFact;
  /** Whether the fulfiller can deliver the volume this pathway needs; stated as an estimate only once a range can be justified, otherwise unknown. */
  capacity: PathFact;
  /** How the buyer is reached, and whether that waits on cold outreach (§93). */
  acquisition: { method: AcquisitionMethod; basis: string };
  /** The Brain capability that fulfils it, when Brain does. */
  producedBy: string | null;
  /** Capabilities and permissions the transaction depends on. */
  dependencies: string[];
  /** Permissions not yet granted: each blocks only its own action. */
  permissionsMissing: string[];
  /** Chain links the plan judged missing. */
  failurePoints: ChainLink[];
  gaps: GapKind[];
  moves: ConstructionMove[];
  fit: TransactionFit;
  /** Expected net contribution inside the window (p10/p50/p90 over the pathway's own bounds), major units. */
  contribution: { p10: number; p50: number; p90: number };
  /** Gross revenue at the same deals, before costs. */
  gross: { p10: number; p50: number; p90: number };
  /** Every commercial link established or estimated with a basis; only a permission may still block. */
  executable: boolean;
  /** Why it is not executable, when it is not. */
  notExecutable: string[];
  /** A group whose members fail together: the same buyer kind, or the same supplier. */
  correlationGroup: string;
  /** Tally of the fourteen commercial facts; `rights` and `capacity` are marked on their own and read beside it. */
  counts: { proven: number; estimated: number; unknown: number };
}

function statusOf(input: ModelInput): FactStatus {
  if (input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL') return input.value !== null ? 'PROVEN' : input.inferred ? 'ESTIMATED' : 'UNKNOWN';
  if (input.value !== null) return 'ESTIMATED';
  if (input.inferred) return 'ESTIMATED';
  return 'UNKNOWN';
}

function factOf(input: ModelInput): PathFact {
  const status = statusOf(input);
  const value = input.value ?? (input.inferred ? input.inferred.p50 : null);
  const low = input.value ?? (input.inferred ? input.inferred.p10 : input.low);
  const high = input.value ?? (input.inferred ? input.inferred.p90 : input.high);
  return { value, low, high, status, basis: input.note.slice(0, 200) };
}

function textFact(value: string | null | undefined, basis: string, status: FactStatus = 'PROVEN'): PathFact {
  const text = value?.trim() ? value.trim().slice(0, 240) : null;
  return text ? { value: text, low: null, high: null, status, basis } : { value: null, low: null, high: null, status: 'UNKNOWN', basis: `nothing on the card says ${basis}` };
}

/*
 * A geometric mean is undefined below zero, and clamping a negative bound to 1e-6 turned a range
 * that loses money into a hair above zero — so an unknown net (value null since r01.opp-04) read
 * as marginally profitable. A range reaching below zero takes its arithmetic middle instead, so a
 * loss stays a loss and the fit's MARGIN lever still comes from the range.
 */
const mid = (f: PathFact): number | null =>
  typeof f.value === 'number'
    ? f.value
    : f.low !== null && f.high !== null
      ? f.low < 0
        ? (f.low + f.high) / 2
        : geometric(Math.max(f.low, 1e-6), Math.max(f.high, 1e-6))
      : null;
const lowOf = (f: PathFact): number | null => (typeof f.value === 'number' && f.status === 'PROVEN' ? f.value : f.low);
const highOf = (f: PathFact): number | null => (typeof f.value === 'number' && f.status === 'PROVEN' ? f.value : f.high);

/** Words that mark evidence as a supplier describing its own price, not a buyer asking for one. */
export const SUPPLY_SIDE = /\b(?:publishes (?:a |its )?(?:per[- ]\w+ )?(?:price|pricing|rates?|fees?)|its (?:own )?pricing|pricing page|rate card|per[- ](?:word|minute|hour|page)\b.*\bpric|plans? start at|subscription costs?)/i;
/** A resale or an asset bought and sold is an arbitrage, not a supplier's price page. */
const RESALE = /\b(?:resale|resell|re-sell|ticket|auction|secondary market|StockX|marketplace listing)\b/i;
/** Words that mark a one-buyer opening: a single submission, a single listing. */
const ONE_BUYER = /\b(?:submissions?|this one publication|a single|one buyer|one listing)\b/i;

function supplyWithoutBuyer(one: ModelledOpportunity): boolean {
  const o = one.opportunity;
  const text = `${o.title} ${o.buyingSignal ?? ''} ${o.economicsNote ?? ''}`;
  const priced = one.price.value !== null || one.price.high !== null;
  if (!priced) return false;
  if (o.opportunitySignal === 'RESALABLE_ASSET_OPENING' || RESALE.test(text)) return false;
  if (o.opportunitySignal === 'PRICING_OR_INFORMATION_ASYMMETRY' && SUPPLY_SIDE.test(text)) return true;
  // A provider's own price page: the price is its, and nobody named pays us.
  return SUPPLY_SIDE.test(text) && (!o.payer || (o.title.toLowerCase().includes(o.payer.toLowerCase().split(/[ ,(]/)[0] ?? '\u0000') && SUPPLY_SIDE.test(o.title)));
}

/* ------------------------------------------------------------------ */
/* What Brain itself can produce, and how a buyer is reached          */
/* ------------------------------------------------------------------ */

/**
 * What Brain can produce itself, as the capability frame proves it
 * (`cash/capabilities.ts`: each deliverable kind's `available`) and the puzzle
 * registry generates (`puzzle/formats`: GENERATED, never AUTHORED). Labels,
 * never a claim about a buyer's bar.
 */
export interface BrainCapabilities {
  delivers: string[];
  puzzleFormats: string[];
}

/** The words that name each deliverable label's work. A label with no entry is never matched. */
const DELIVERS_WORDS: Record<string, RegExp> = {
  'business document': /\b(?:articles?|blog(?:s| posts?)?|copy(?:writing)?|content|ebooks?|white ?papers?|reports?|newsletters?|documents?|proposals?|guides?)\b/i,
  spreadsheet: /\b(?:spreadsheets?|excel|google sheets|financial models?|budget templates?)\b/i,
  presentation: /\b(?:slides?|decks?|presentations?|powerpoint)\b/i,
  'data operations': /\b(?:data entry|datasets?|data cleaning|lead lists?|list building|data enrichment)\b/i,
  website: /\b(?:websites?|landing pages?|web pages?)\b/i,
  programming: /\b(?:software|scripts?|automations?|plugins?|integrations?|apis?)\b/i,
  'graphic design': /\b(?:logos?|graphics?|banners?|illustrations?|thumbnails?|flyers?|infographics?)\b/i,
  '3D model': /\b3d models?\b/i,
};

/**
 * Whether Brain produces what a pathway sells, and which capability does.
 * Pure. A puzzle format counts only when the text does not qualify it as a
 * variant Brain's generator does not make (production, 2026-11-08: the one
 * "executable" sale asked for variant sudoku, and the generator makes classic
 * grids). Transcription, physical goods and a studio's job are never matched.
 */
export function brainProduces(text: string, caps: BrainCapabilities | null): string | null {
  if (!caps) return null;
  for (const format of caps.puzzleFormats) {
    const word = format.toLowerCase().replace(/[-_]/g, ' ');
    const re = new RegExp(`\\b${word.replace(/ /g, '[ -]?')}s?\\b`, 'i');
    if (!re.test(text)) continue;
    if (new RegExp(`\\bvariant[ -]?${word.replace(/ /g, '[ -]?')}`, 'i').test(text) || /\bvariant\b/i.test(text)) return null;
    return `${format} (Brain's generator, solver-checked)`;
  }
  if (/\b(?:transcri|audio|video|physical|deliver(?:y|ies) of goods|install)/i.test(text)) return null;
  for (const label of caps.delivers) {
    const re = DELIVERS_WORDS[label];
    if (re && re.test(text)) return label;
  }
  return null;
}

export const ACQUISITION_METHODS = ['DIRECT_DEMAND', 'MARKETPLACE', 'PARTNER', 'DIRECTORY', 'COLD_OUTREACH', 'UNKNOWN'] as const;
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];

/**
 * How a pathway's buyer is reached, from the channel and signal the evidence
 * names. Pure. Only COLD_OUTREACH spends the shared outreach capacity: a
 * buyer who published a request or a submission call is answered, a
 * marketplace brings buyers to the listing, and one partner agreement reaches
 * many buyers — so the cold-outreach ceiling binds none of them.
 */
export function acquisitionOf(channel: string | null, signal: string | null): { method: AcquisitionMethod; basis: string } {
  const both = `${channel ?? ''} ${signal ?? ''}`;
  if (/\b(?:submissions?|submit|apply|application|requests? for|rfq|quote form|accepts? (?:outside )?(?:submissions|pitches|proposals)|call for|posted (?:a|an) (?:request|job))\b/i.test(both)) {
    return { method: 'DIRECT_DEMAND', basis: 'the buyer publishes a request or a submission route: the offer answers a buyer who asked' };
  }
  if (/\b(?:referral|affiliate|reseller|partner program|white[- ]label|wholesale)\b/i.test(both)) return { method: 'PARTNER', basis: 'a partner or reseller programme reaches the buyers' };
  if (/\b(?:marketplace|etsy|amazon|ebay|gumroad|app store|storefront|listing)\b/i.test(both)) return { method: 'MARKETPLACE', basis: 'buyers come to a listing on a marketplace' };
  if (/\b(?:directory|registry|register of|association|member list|clutch)\b/i.test(both)) return { method: 'DIRECTORY', basis: 'a published directory lists the buyers; reaching them is outreach to a known list' };
  if (channel && channel.trim()) return { method: 'COLD_OUTREACH', basis: 'a published contact route, reached by outreach' };
  return { method: 'UNKNOWN', basis: 'no route to the buyer is established' };
}

/**
 * How much of a pathway's cash could be collected before the deadline, as a
 * rank — not its theoretical value (owner, 2026-11-08). Lexicographic, best
 * first: cash that settles in time (established, then unknown, never too
 * late), a fulfiller (Brain's own capability or a named one), a way to the
 * buyer that does not wait on cold outreach, more than one buyer, then the
 * pathway's own p90 contribution.
 */
export function collectibility(p: TransactionPathway, daysLeft: number): number[] {
  const settle = lowOf(p.daysToCash);
  const timing = p.gaps.includes('CLOSED') ? 0 : p.daysToCash.status !== 'UNKNOWN' && settle !== null ? (settle <= daysLeft - MIN_SALES_CYCLE_DAYS ? 3 : 0) : 1;
  const fulfil = p.fulfiller.status === 'UNKNOWN' ? 0 : 1;
  const reach = p.acquisition.method === 'UNKNOWN' ? 0 : p.acquisition.method === 'COLD_OUTREACH' || p.acquisition.method === 'DIRECTORY' ? 1 : 2;
  const many = p.frequency.value === 'repeats' || p.gaps.includes('SUPPLY_WITHOUT_BUYER') || p.gaps.includes('ONE_BUYER') ? 1 : 0;
  return [timing, fulfil, reach, many, p.contribution.p90];
}

export function byCollectibility(a: TransactionPathway, b: TransactionPathway, daysLeft: number): number {
  const x = collectibility(a, daysLeft);
  const y = collectibility(b, daysLeft);
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i]! - x[i]!;
  return 0;
}

/**
 * A pathway's transaction model from what the plan composed for it. Pure.
 * `remaining` and `daysLeft` are the goal's; `outreach` is the shared capacity
 * the portfolio models; `permissionsMissing` what this project's authority and
 * providers do not yet grant.
 */
export function pathwayOf(
  one: ModelledOpportunity,
  judged: Pick<ConsideredOpening, 'missing' | 'paysOnce' | 'competitiveAward' | 'volumeEstablished'> | null,
  input: { remaining: number; daysLeft: number; currency: string; perArrangement: number | null; outreachPerDay: number; permissionsMissing: string[]; now: Date; capabilities?: BrainCapabilities | null },
): TransactionPathway {
  const o = one.opportunity;
  const constructed = !!one.estimated;
  const est = (text: string | null, basis: string) => textFact(text, basis, 'ESTIMATED');
  const buyer = constructed ? est(o.title.replace(/^Constructed:\s*/i, ''), 'the constructed design names this buyer kind; no buyer has been found yet') : textFact(o.payer, 'who pays');
  const motivation = constructed
    ? { value: null, low: null, high: null, status: 'UNKNOWN' as const, basis: 'no dated buying signal yet: the design is a hypothesis about why they would buy' }
    : textFact(o.buyingSignal ? `${o.buyingSignal}${o.signalObservedAt ? ` (observed ${o.signalObservedAt.slice(0, 10)})` : ''}` : null, 'why the buyer pays now');
  const channel = textFact(o.reachableChannel, 'how the buyer is reached');
  const offer = textFact(o.offerScope, 'the offer');
  const named: PathFact = one.fulfilledBy
    ? { value: one.fulfilledBy.value.slice(0, 240), low: null, high: null, status: (one.fulfilledBy.provenance === 'EVIDENCE' || one.fulfilledBy.provenance === 'HISTORICAL' ? 'PROVEN' : 'ESTIMATED') as FactStatus, basis: 'the card names who does the work' }
    : textFact(o.fulfillmentOwner, 'who does the work');
  // The buyer is never its own fulfiller: a card naming the payer as who does the work names nobody (production, 2026-11-08).
  const payerWord = (o.payer ?? '').toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length > 3 && !['market', 'payer', 'english', 'language'].includes(w)) ?? null;
  if (named.status !== 'UNKNOWN' && payerWord && String(named.value).toLowerCase().includes(payerWord)) {
    named.value = null;
    named.status = 'UNKNOWN';
    named.basis = 'the card names the buyer itself as who does the work, which names nobody';
  }
  // Brain's own proven capability is a fulfiller nobody needs to find (§93): estimated, because the buyer's bar is not established.
  const produces = constructed ? null : brainProduces(`${o.offerScope ?? ''} ${o.title} ${o.buyingSignal ?? ''}`, input.capabilities ?? null);
  const fulfiller: PathFact =
    named.status === 'UNKNOWN' && produces
      ? { value: `Brain produces it: ${produces}`, low: null, high: null, status: 'ESTIMATED', basis: 'a capability Brain has proved it delivers; whether it meets this buyer\'s bar is not established' }
      : named;
  const acquisition = constructed ? { method: 'UNKNOWN' as AcquisitionMethod, basis: 'a constructed design: its buyers are not found yet' } : acquisitionOf(o.reachableChannel, o.buyingSignal ?? o.title);
  const revenuePerDeal = factOf(one.price);
  const fulfilmentCost = factOf(one.directCost);
  // Acquisition: owned outreach costs no cash; a paid channel's cost nobody has measured is unknown.
  const paidChannel = /\b(?:ads?|advertis|sponsor|paid|lead fee|per lead)\b/i.test(o.reachableChannel ?? '');
  const acquisitionCost: PathFact = o.reachableChannel
    ? paidChannel
      ? { value: null, low: null, high: null, status: 'UNKNOWN', basis: 'a paid channel whose cost per customer nobody has measured' }
      : { value: 0, low: 0, high: 0, status: 'ESTIMATED', basis: 'reached through an owned channel (email, form, listing): no cash cost per contact, only outreach capacity' }
    : { value: null, low: null, high: null, status: 'UNKNOWN', basis: 'no channel yet, so no cost to reach a buyer' };
  const netLow = lowOf(revenuePerDeal) !== null ? lowOf(revenuePerDeal)! - (highOf(fulfilmentCost) ?? lowOf(revenuePerDeal)!) - (acquisitionCost.high ?? 0) : null;
  const netHigh = highOf(revenuePerDeal) !== null ? highOf(revenuePerDeal)! - (lowOf(fulfilmentCost) ?? 0) - (acquisitionCost.low ?? 0) : null;
  const netMid = mid(revenuePerDeal) !== null ? mid(revenuePerDeal)! - (mid(fulfilmentCost) ?? 0) - (typeof acquisitionCost.value === 'number' ? acquisitionCost.value : 0) : null;
  const weakest = (a: FactStatus, b: FactStatus): FactStatus => (a === 'UNKNOWN' || b === 'UNKNOWN' ? 'UNKNOWN' : a === 'ESTIMATED' || b === 'ESTIMATED' ? 'ESTIMATED' : 'PROVEN');
  const netStatus: FactStatus = revenuePerDeal.status === 'UNKNOWN' ? 'UNKNOWN' : weakest(revenuePerDeal.status, fulfilmentCost.status === 'UNKNOWN' ? 'ESTIMATED' : fulfilmentCost.status);
  const net: PathFact = {
    // An unknown states no point value (§39, §93): with no price established, a midpoint of the
    // swept range is a guess, and it is never read as a favourable number (production r01.opp-04).
    value: netStatus === 'UNKNOWN' ? null : netMid,
    low: netLow,
    high: netHigh,
    status: netStatus,
    basis: fulfilmentCost.status === 'UNKNOWN' ? 'price less a direct cost nobody has established (swept)' : 'price less the direct cost',
  };
  const respond = factOf(one.respond);
  const close = factOf(one.close);
  const conversionStatus = weakest(respond.status, close.status);
  const conversion: PathFact = {
    // An unknown states no point value: the swept range below is all there is, and `mid` reads it from there (§93).
    value: conversionStatus !== 'UNKNOWN' && mid(respond) !== null && mid(close) !== null ? mid(respond)! * mid(close)! : null,
    low: lowOf(respond) !== null && lowOf(close) !== null ? lowOf(respond)! * lowOf(close)! : null,
    high: highOf(respond) !== null && highOf(close) !== null ? highOf(respond)! * highOf(close)! : null,
    status: conversionStatus,
    basis: `reply ${respond.status.toLowerCase()} × close ${close.status.toLowerCase()}: ${close.basis.slice(0, 120)}`,
  };
  const volume = factOf(one.volume);
  const frequency: PathFact = one.repeatable
    ? { value: 'repeats', low: null, high: null, status: volume.status === 'PROVEN' ? 'PROVEN' : 'ESTIMATED', basis: volume.basis }
    : { value: 'one-off', low: null, high: null, status: 'PROVEN', basis: judged?.paysOnce ? 'pays once by nature' : 'one deal' };
  const daysToCash = factOf(one.daysToCash);
  const capital = factOf(one.capital);
  // A permission held is a record; one not held is known, not unknown, and blocks only its own action — never an assumed yes.
  const rights: PathFact = input.permissionsMissing.length === 0
    ? { value: 'every permission this transaction depends on is granted', low: null, high: null, status: 'PROVEN', basis: 'the project\'s authority grants every action the transaction needs' }
    : { value: `not yet granted: ${input.permissionsMissing.join(', ')}`, low: null, high: null, status: 'DENIED', basis: 'each missing permission blocks only its own action; none is assumed granted' };
  // An estimate carries a justified range (§93). Nothing measures the volume a named fulfiller can deliver, so capacity is unknown either way; naming the fulfiller changes only what is said.
  const capacity: PathFact = {
    value: null,
    low: null,
    high: null,
    status: 'UNKNOWN',
    basis: fulfiller.status === 'UNKNOWN' ? 'nobody is named to fulfil it, so no delivery capacity is established' : 'a fulfiller is named; the volume it can deliver is not yet measured, so no range can be justified',
  };
  const dependencies = [...new Set([...o.requiredCapabilities, 'CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'])];
  const failurePoints = judged?.missing ?? [];

  /* gaps */
  const gaps: GapKind[] = [];
  const supply = !constructed && supplyWithoutBuyer(one);
  if (supply) gaps.push('SUPPLY_WITHOUT_BUYER');
  else if (buyer.status === 'UNKNOWN') gaps.push('NO_BUYER');
  if (channel.status === 'UNKNOWN') gaps.push('NO_CHANNEL');
  if (offer.status === 'UNKNOWN') gaps.push('NO_OFFER');
  if (revenuePerDeal.status === 'UNKNOWN') gaps.push('NO_PRICE');
  if (fulfiller.status === 'UNKNOWN') gaps.push('NO_SUPPLIER');
  if (netHigh !== null && netHigh <= 0) gaps.push('NO_MARGIN');
  else if (fulfilmentCost.status !== 'UNKNOWN' && mid(revenuePerDeal) !== null && mid(fulfilmentCost)! >= mid(revenuePerDeal)!) gaps.push('NO_MARGIN');
  const settleLow = lowOf(daysToCash);
  if (daysToCash.status === 'UNKNOWN' || (settleLow !== null && settleLow > input.daysLeft - MIN_SALES_CYCLE_DAYS)) gaps.push('SLOW_OR_UNKNOWN_CASH');
  if (input.perArrangement !== null && capital.status !== 'UNKNOWN' && (lowOf(capital) ?? 0) > input.perArrangement) gaps.push('OVER_CAPITAL');
  const priceMid = mid(revenuePerDeal);
  const smallTicket = priceMid !== null && priceMid < input.remaining * MATERIAL_SHARE;
  if (smallTicket && one.repeatable && volume.status !== 'PROVEN') gaps.push('SMALL_TICKET_VOLUME_UNKNOWN');
  // One buyer of a found opening is transferred to its population. Not a constructed design (its
  // round asks the population already), and not a resale: an arbitrage's "population" is more
  // stock bought first, which is capital, not buyers.
  const resale = o.opportunitySignal === 'RESALABLE_ASSET_OPENING' || RESALE.test(`${o.title} ${o.buyingSignal ?? ''}`);
  if (!constructed && !resale && !supply && !one.repeatable && !judged?.competitiveAward && (smallTicket || ONE_BUYER.test(o.title))) gaps.push('ONE_BUYER');
  if (o.expiresAt && Date.parse(o.expiresAt) < input.now.getTime()) gaps.push('CLOSED');

  const fit = fitOf({ net, conversion, volume, daysToCash, repeatable: one.repeatable, remaining: input.remaining, daysLeft: input.daysLeft, outreachPerDay: input.outreachPerDay, competitiveAward: !!judged?.competitiveAward, outreachBound: acquisition.method === 'COLD_OUTREACH' || acquisition.method === 'DIRECTORY' || acquisition.method === 'UNKNOWN' });
  // The quantity transforms the strategy (§93): a share that needs more prospects a day than the channel reaches is a channel problem, so the channel is what changes.
  if (fit.lever.variable === 'CHANNEL') gaps.push('REACH_SHORTFALL');
  const moves = constructMoves({ one, gaps, fit, revenuePerDeal, fulfilmentCost, net, remaining: input.remaining, daysLeft: input.daysLeft, currency: input.currency, constructed, permissionsMissing: input.permissionsMissing, produces, paysOnce: !!judged?.paysOnce || !!judged?.competitiveAward, daysToCash: lowOf(daysToCash) });
  const contribution = contributionOf({ net, conversion, volume, repeatable: one.repeatable, daysToCash, daysLeft: input.daysLeft, outreachPerDay: input.outreachPerDay, closed: gaps.includes('CLOSED') });
  const gross = contributionOf({ net: revenuePerDeal, conversion, volume, repeatable: one.repeatable, daysToCash, daysLeft: input.daysLeft, outreachPerDay: input.outreachPerDay, closed: gaps.includes('CLOSED') });
  const notExecutable: string[] = [];
  const blocking: GapKind[] = ['NO_BUYER', 'SUPPLY_WITHOUT_BUYER', 'NO_CHANNEL', 'NO_OFFER', 'NO_PRICE', 'NO_SUPPLIER', 'NO_MARGIN', 'OVER_CAPITAL', 'CLOSED'];
  for (const gap of gaps) if (blocking.includes(gap)) notExecutable.push(GAP_LABEL[gap]);
  if (constructed) notExecutable.push('constructed: no buyer of this kind has been found yet');
  if (daysToCash.status !== 'UNKNOWN' && settleLow !== null && settleLow > input.daysLeft - MIN_SALES_CYCLE_DAYS) notExecutable.push('settles after the deadline');
  const facts = [buyer, motivation, channel, offer, fulfiller, revenuePerDeal, acquisitionCost, fulfilmentCost, net, conversion, volume, frequency, daysToCash, capital];
  const counts = { proven: 0, estimated: 0, unknown: 0 };
  // `facts` are the fourteen commercial facts and none can be DENIED; `rights` (the only denial) and `capacity` are read beside the tally.
  for (const fact of facts) counts[fact.status === 'PROVEN' ? 'proven' : fact.status === 'ESTIMATED' ? 'estimated' : 'unknown'] += 1;
  const pathway: TransactionPathway = {
    opportunityId: o.id,
    title: o.title,
    origin: constructed ? 'CONSTRUCTED' : 'FOUND',
    buyer,
    motivation,
    channel,
    offer,
    fulfiller,
    revenuePerDeal,
    acquisitionCost,
    fulfilmentCost,
    net,
    conversion,
    volume,
    frequency,
    daysToCash,
    capital,
    rights,
    capacity,
    acquisition,
    producedBy: fulfiller.value !== null && String(fulfiller.value).startsWith('Brain produces it') ? produces : null,
    dependencies,
    permissionsMissing: input.permissionsMissing,
    failurePoints,
    gaps,
    moves,
    fit,
    contribution,
    gross,
    executable: notExecutable.length === 0,
    notExecutable,
    correlationGroup: correlationGroupOf(one),
    counts,
  };
  /*
   * One rule over every fact the pathway publishes: an UNKNOWN states no value (OPP-04, §39).
   * `net` above is the site production caught, and this is the defence for every other derived
   * fact — constructed designs, commission and unit-sale variants — so a new derivation cannot
   * reintroduce a point guess under an unknown. It runs on the assembled pathway, after
   * `constructMoves` copied facts into its variants, and `publishedFacts` is the one list of what
   * is published, so a variant is held to the rule rather than trusted to its source. The swept
   * low/high stay: fit and contribution have already read them, and a partial arrangement is kept
   * rather than abandoned.
   */
  for (const fact of publishedFacts(pathway)) if (fact.status === 'UNKNOWN' && fact.value !== null) fact.value = null;
  return pathway;
}

/** Every fact a pathway publishes: the fourteen commercial facts, rights, capacity, and each move variant's facts. Pure. */
export function publishedFacts(p: TransactionPathway): PathFact[] {
  return [
    p.buyer, p.motivation, p.channel, p.offer, p.fulfiller, p.revenuePerDeal, p.acquisitionCost, p.fulfilmentCost, p.net,
    p.conversion, p.volume, p.frequency, p.daysToCash, p.capital, p.rights, p.capacity,
    ...p.moves.flatMap((m) => (m.variant ? [m.variant.revenuePerDeal, m.variant.costPerDeal, m.variant.net] : [])),
  ];
}

export const GAP_LABEL: Record<GapKind, string> = {
  NO_BUYER: 'no buyer named',
  SUPPLY_WITHOUT_BUYER: 'a supplier\'s price with no buyer of ours',
  NO_CHANNEL: 'no way to reach the buyer',
  NO_OFFER: 'no specific offer',
  NO_PRICE: 'no price',
  NO_SUPPLIER: 'nobody named to fulfil it',
  NO_MARGIN: 'costs at least what it pays',
  SLOW_OR_UNKNOWN_CASH: 'cash timing unknown or too slow',
  OVER_CAPITAL: 'ties up more than one arrangement may',
  SMALL_TICKET_VOLUME_UNKNOWN: 'small per sale and volume unknown',
  ONE_BUYER: 'one buyer, one sale',
  CLOSED: 'closed',
  ONE_TRANSACTION_SHAPE: 'priced at one transaction size only',
  REACH_SHORTFALL: 'its share needs more buyers a day than the channel reaches',
};

/** The buyer kind, or the supplier, a pathway's failure is shared with. */
export function correlationGroupOf(one: ModelledOpportunity): string {
  const o = one.opportunity;
  const base = (o.payer ?? o.industry ?? o.title).toLowerCase();
  const words = base.replace(/^constructed:\s*/, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
  return words.slice(0, 2).join(' ') || 'unnamed';
}
const STOP = new Set(['market', 'reverse', 'their', 'with', 'from', 'that', 'this', 'buyers', 'buyer', 'several', 'states', 'publishes', 'which']);

/* ------------------------------------------------------------------ */
/* 3. Constructing the missing links                                   */
/* ------------------------------------------------------------------ */

function constructMoves(input: {
  one: ModelledOpportunity;
  gaps: GapKind[];
  fit: TransactionFit;
  revenuePerDeal: PathFact;
  fulfilmentCost: PathFact;
  net: PathFact;
  remaining: number;
  daysLeft: number;
  currency: string;
  constructed: boolean;
  permissionsMissing: string[];
  /** The Brain capability that would produce the deliverable, when one does. */
  produces?: string | null;
  /** It pays once by nature, so its size is its size. */
  paysOnce?: boolean;
  /** Days until its cash is usable, when known. */
  daysToCash?: number | null;
}): ConstructionMove[] {
  const { one, gaps, remaining, currency } = input;
  const o = one.opportunity;
  const subject = o.title.replace(/^Constructed:\s*/i, '').slice(0, 140);
  const share = remaining * MATERIAL_SHARE;
  const price = mid(input.revenuePerDeal);
  const moves: ConstructionMove[] = [];
  const unknownFact = (basis: string): PathFact => ({ value: null, low: null, high: null, status: 'UNKNOWN', basis });

  if (gaps.includes('SUPPLY_WITHOUT_BUYER') && price !== null) {
    const ref = input.revenuePerDeal;
    // The supplier's price is what its buyers pay today: a ceiling for a competing offer, and a cost for a resale.
    moves.push({
      gap: 'SUPPLY_WITHOUT_BUYER',
      construct: `Sell the same deliverable to the supplier's own buyers below its published ${money(price)} ${currency}, ${input.produces ? `produced by Brain (${input.produces})` : 'producing it ourselves or through a cheaper provider'}`,
      mustHit: `at ${money(price * 0.7)} ${currency} (30% under the published price) a sale nets ${money(price * 0.7)} less our cost per sale; ${Math.ceil(share / Math.max(0.01, price * 0.7))} sales carry a tenth of the gap at no cost, so our cost per sale must stay well under ${money(price * 0.7)}`,
      field: 'payer',
      ask:
        `"${subject}" is a supplier's published price, which shows what buyers pay for this today. Name the kinds of business or household that buy exactly this deliverable, ` +
        'where each publicly asks for it (a job board, a marketplace category, a forum, a directory), one dated example of one of them asking, and how many such buyers a directory or marketplace counts.',
      action: 'CONSTRUCT',
      variant: {
        label: `Compete for its buyers at about 70% of ${money(price)} ${currency}`,
        revenuePerDeal: { value: price * 0.7, low: price * 0.5, high: price * 0.9, status: 'ESTIMATED', basis: `50–90% of the supplier's published price (${ref.status.toLowerCase()})` },
        costPerDeal: input.produces
          ? { value: null, low: 0, high: price * 0.1, status: 'ESTIMATED', basis: `produced by Brain's own ${input.produces} pipeline: no supplier is paid, and model spend per unit is not yet measured (bounded at a tenth of the price)` }
          : unknownFact('our own cost to produce it, or a cheaper provider\'s rate: not yet established'),
        net: input.produces
          ? { value: price * 0.7 * 0.95, low: price * 0.5 - price * 0.1, high: price * 0.9, status: 'ESTIMATED', basis: 'price at 50–90% of the supplier\'s, less Brain\'s bounded production spend' }
          : unknownFact('price less a cost nobody has established'),
      },
    });
    // One agreement with a business that already sells to these buyers reaches many of them (§93): not cold outreach.
    moves.push({
      gap: 'SUPPLY_WITHOUT_BUYER',
      construct: 'Reach these buyers through a partner who already serves them: a reseller, white-label partner, agency or platform marketplace that buys this deliverable wholesale for its own clients',
      mustHit: `one partner buying ${Math.ceil(share / Math.max(0.01, price * 0.7))} units at 70% of ${money(price)} ${currency} carries a tenth of the gap`,
      field: 'access',
      ask:
        `"${subject}" publishes what buyers pay a supplier for this deliverable. Name the kinds of business that buy it wholesale to resell to their own clients (agencies, resellers, white-label programmes, platform marketplaces for vendors), ` +
        'the published wholesale or partner rates they pay, how many such businesses a directory counts, and where each publishes how to become its supplier or partner.',
      action: 'CONSTRUCT',
      variant: null,
    });
    moves.push({
      gap: 'SUPPLY_WITHOUT_BUYER',
      construct: 'Refer buyers to the supplier for a commission (an affiliate or partner programme), so no fulfilment cost falls on us',
      mustHit: `at a 10–30% commission a referral nets ${money(price * 0.1)}–${money(price * 0.3)}; ${Math.ceil(share / Math.max(0.01, price * 0.2))} referrals carry a tenth of the gap at 20%`,
      field: 'revenueRange',
      ask: `Does the supplier in "${subject}" publish a referral, affiliate, reseller or partner programme? State its commission or reseller discount, how it pays out and after how many days, with the page.`,
      action: 'RESEARCH',
      variant: {
        label: 'Refer its buyers for a commission',
        revenuePerDeal: { value: price * 0.2, low: price * 0.1, high: price * 0.3, status: 'ESTIMATED', basis: 'a 10–30% referral commission on the published price, until the programme\'s own rate is read' },
        costPerDeal: { value: 0, low: 0, high: 0, status: 'ESTIMATED', basis: 'the supplier fulfils; we only refer' },
        net: { value: price * 0.2, low: price * 0.1, high: price * 0.3, status: 'ESTIMATED', basis: 'the commission' },
      },
    });
  } else if (gaps.includes('NO_BUYER')) {
    moves.push({
      gap: 'NO_BUYER',
      construct: 'Acquire a buyer: name who pays for this and where they ask',
      mustHit: price !== null ? `${Math.ceil(share / Math.max(0.01, price))} buyers at ${money(price)} ${currency} carry a tenth of the gap` : null,
      field: 'payer',
      ask: `For "${subject}", name the business or household that pays for it, where it publicly asks for the work, and one dated example of it doing so.`,
      action: 'RESEARCH',
      variant: null,
    });
  }
  if (gaps.includes('NO_CHANNEL')) {
    moves.push({
      gap: 'NO_CHANNEL',
      construct: 'Construct an acquisition path: the published place these buyers can be reached (a listing, an inbox, a form, a marketplace, a partner\'s list)',
      mustHit: input.fit.prospectsPerDay !== null ? `about ${money(input.fit.prospectsPerDay)} prospects a day for its share` : null,
      field: 'access',
      ask: `For "${subject}", where can this buyer be reached directly — a published email, an application or quote form, a marketplace where buyers post requests, or a partner who sells to them — with the page.`,
      action: 'RESEARCH',
      variant: null,
    });
  }
  if (gaps.includes('NO_SUPPLIER')) {
    moves.push({
      gap: 'NO_SUPPLIER',
      construct: 'Construct a supplier-acquisition path: an independent provider or tool that performs the work while this operation sells and coordinates it — or, where Brain nearly produces it, the capability built through Factory',
      mustHit: price !== null ? `a provider at no more than about ${money(price * 0.7)} ${currency} a job (70% of the price) leaves a 30% margin; ${Math.ceil(share / Math.max(0.01, price * 0.3))} jobs at that margin carry a tenth of the gap` : null,
      field: 'fulfillment',
      ask: `For "${subject}", name the kind of independent provider, contractor, wholesaler or tool that performs or produces this, where they are found, and their published rate per job.`,
      action: 'RESEARCH',
      variant: null,
    });
  }
  if (gaps.includes('NO_MARGIN') && price !== null) {
    moves.push({
      gap: 'NO_MARGIN',
      construct: 'Change the transaction role: take a referral fee instead of fulfilling, bundle it with work that carries the margin, or sell to the buyer at the buyer-side price instead of to the intermediary',
      mustHit: `a role whose cost per sale is under ${money(price)} ${currency}`,
      field: 'revenueRange',
      ask: `In "${subject}" the published figures leave no margin for the role modelled. What do the end buyers of this deliverable pay for it directly (not the intermediary's rate), and does anyone pay a referral fee for introducing them? State each figure with its page.`,
      action: 'CONSTRUCT',
      variant: null,
    });
  }
  if (gaps.includes('SLOW_OR_UNKNOWN_CASH')) {
    moves.push({
      gap: 'SLOW_OR_UNKNOWN_CASH',
      construct: 'Settle faster: card payment at order, a deposit at agreement, or milestone billing, where buyers of this kind already pay that way',
      mustHit: `money usable within ${Math.max(1, input.daysLeft - MIN_SALES_CYCLE_DAYS)} days of the first contact`,
      field: 'timeToFirstCash',
      ask: `For "${subject}", how do buyers of this kind pay — card at checkout, deposit, prepayment, invoice terms — and how many days from agreement until the money is usable? State it with the page.`,
      action: 'RESEARCH',
      variant: null,
    });
  }
  if (gaps.includes('OVER_CAPITAL')) {
    moves.push({
      gap: 'OVER_CAPITAL',
      construct: 'Restructure the cash: take the buyer\'s prepayment or deposit before paying the supplier, or a threshold presale, so nothing of ours is tied up first',
      mustHit: 'nothing of ours out before the buyer pays',
      field: 'requiredCapital',
      ask: `For "${subject}", do suppliers in this trade accept payment after the customer pays, or on net terms, and do buyers pay a deposit up front? State the terms with the page.`,
      action: 'RESEARCH',
      variant: null,
    });
  }
  if (gaps.includes('SMALL_TICKET_VOLUME_UNKNOWN') && price !== null) {
    moves.push({
      gap: 'SMALL_TICKET_VOLUME_UNKNOWN',
      construct: 'Research achievable volume instead of excluding it: count the buyers and how often each buys',
      mustHit: `${Math.ceil(share / Math.max(0.01, price))} sales at ${money(price)} ${currency} carry a tenth of the gap; ${Math.ceil(remaining / Math.max(0.01, price))} carry all of it`,
      field: 'buyerVolume',
      ask: `For "${subject}", count how many buyers of exactly this kind exist and can be reached through a published channel, and how often one buys (weekly, monthly, yearly), each as a number with its source.`,
      action: 'RESEARCH',
      variant: null,
    });
  }
  if (gaps.includes('ONE_BUYER') && price !== null && !gaps.includes('CLOSED')) {
    moves.push({
      gap: 'ONE_BUYER',
      construct: 'Sell the same deliverable to the population of buyers like this one (a transfer), instead of to the one buyer found',
      mustHit: `${Math.ceil(share / Math.max(0.01, price))} buyers like it at ${money(price)} ${currency} carry a tenth of the gap`,
      field: 'buyerVolume',
      ask: `"${subject}" is one buyer paying ${money(price)} ${currency}. List other buyers of exactly this deliverable that pay for it — each with its page and its published rate — and how many such buyers a directory or marketplace counts.`,
      action: 'CONSTRUCT',
      variant: { label: 'The same deliverable to buyers like it', revenuePerDeal: { ...input.revenuePerDeal }, costPerDeal: { ...input.fulfilmentCost }, net: { ...input.net } },
    });
  }
  if (gaps.includes('REACH_SHORTFALL')) {
    const need = input.fit.prospectsPerDay;
    moves.push({
      gap: 'REACH_SHORTFALL',
      construct: 'Change the acquisition channel: a marketplace listing, a partner or reseller that already sells to these buyers, or buyers who publish requests, instead of more cold contact',
      mustHit: need === null ? null : `a channel that brings about ${Math.ceil(need)} prospects a day for a tenth of the gap, against what cold outreach reaches`,
      field: 'access',
      ask: `For "${subject}", where do buyers of this kind already ask for or buy it (a marketplace category, a platform, a partner that serves them, published requests), how many reach it each day or week, and how are they reached there? State each with its page.`,
      action: 'CONSTRUCT',
      variant: null,
    });
  }
  // The same deliverable at other transaction sizes, unless one unit already carries the gap.
  if (price !== null && !gaps.includes('CLOSED') && !gaps.includes('NO_MARGIN') && !gaps.includes('NO_PRICE') && input.fit.verdict !== 'CARRIES_GAP' && !input.paysOnce) {
    const shapes = transactionShapes({ unitPrice: price, unitCost: mid(input.fulfilmentCost), remaining, daysLeft: input.daysLeft, daysToCash: input.daysToCash ?? null });
    const top = shapes[0];
    if (top && top.kind !== 'UNIT') {
      moves.push({
        gap: 'ONE_TRANSACTION_SHAPE',
        construct: `Sell the same deliverable at other transaction sizes — ${shapes.filter((one) => one.kind !== 'UNIT').map((one) => one.label).join('; ')} — and keep whichever collects most before the deadline`,
        mustHit: `${top.label}: ${Number.isFinite(top.dealsForGap) ? top.dealsForGap : '∞'} such deal(s) carry the whole gap, against ${Number.isFinite(shapes.find((one) => one.kind === 'UNIT')?.dealsForGap ?? Infinity) ? shapes.find((one) => one.kind === 'UNIT')!.dealsForGap : '∞'} single units`,
        field: 'revenueRange',
        ask:
          `"${subject}" sells one unit at about ${money(price)} ${currency}. Do buyers of this deliverable buy it as a prepaid bundle, a monthly retainer, or an implementation/consulting engagement? ` +
          'State each published package price, what it includes, how it is paid (card at order, deposit, monthly in advance), and how many buyers of that size a directory or marketplace counts, with the page.',
        action: 'CONSTRUCT',
        variant: {
          label: top.label,
          revenuePerDeal: { value: top.price, low: top.price * 0.5, high: top.price, status: 'ESTIMATED', basis: top.basis },
          costPerDeal: { value: null, low: 0, high: (mid(input.fulfilmentCost) ?? 0) * top.units, status: 'ESTIMATED', basis: `${top.units} unit(s) at the unit's cost` },
          net: { value: top.collectible, low: top.collectible * 0.5, high: top.collectible, status: 'ESTIMATED', basis: 'price less the units\' cost, counted only if it settles before the deadline' },
        },
        shapes,
      });
    }
  }
  // Sell what can be sold: a missing permission blocks the send, never the rest.
  // Nobody named to fulfil it is not an offer anyone can responsibly make.
  const sellable = !gaps.some((gap) => ['NO_BUYER', 'SUPPLY_WITHOUT_BUYER', 'NO_CHANNEL', 'NO_OFFER', 'NO_PRICE', 'NO_SUPPLIER', 'NO_MARGIN', 'OVER_CAPITAL', 'CLOSED'].includes(gap)) && !input.constructed;
  if (sellable) {
    moves.unshift({
      gap: 'NO_BUYER',
      construct: input.permissionsMissing.length > 0 ? `Offer it for an actual sale once ${input.permissionsMissing.join(', ')} is granted; everything else proceeds now` : 'Offer it for an actual sale now',
      mustHit: null,
      field: null,
      ask: null,
      action: 'SELL',
      variant: null,
    });
  }
  return moves;
}

/* ------------------------------------------------------------------ */
/* 4. The quantity shapes the search                                   */
/* ------------------------------------------------------------------ */

function fitOf(input: {
  net: PathFact;
  conversion: PathFact;
  volume: PathFact;
  daysToCash: PathFact;
  repeatable: boolean;
  remaining: number;
  daysLeft: number;
  outreachPerDay: number;
  competitiveAward: boolean;
  /** Whether this pathway's buyers are reached by the shared cold outreach; a marketplace, a partner or a buyer who asked is not. */
  outreachBound?: boolean;
}): TransactionFit {
  const net = mid(input.net);
  const conv = mid(input.conversion);
  const settle = lowOf(input.daysToCash);
  if (settle !== null && input.daysToCash.status !== 'UNKNOWN' && settle > input.daysLeft - MIN_SALES_CYCLE_DAYS) {
    return { dealsForGap: null, dealsForShare: null, dealsAvailable: null, prospectsPerDay: null, verdict: 'CANNOT_SETTLE', lever: { variable: 'TIMING', change: `its money arrives in ${money(settle)} days at the soonest, after the deadline: a deposit or card payment at order would bring it inside` } };
  }
  if (net === null) return { dealsForGap: null, dealsForShare: null, dealsAvailable: null, prospectsPerDay: null, verdict: 'UNPRICED', lever: { variable: 'PRICE', change: 'establish what buyers pay before anything else about it is worth solving' } };
  if (net <= 0) return { dealsForGap: null, dealsForShare: null, dealsAvailable: null, prospectsPerDay: null, verdict: 'TOO_SMALL_AS_IS', lever: { variable: 'MARGIN', change: 'it nets nothing per sale in the role modelled: change the role (refer, produce, bundle) or the price' } };
  const dealsForGap = Math.ceil(input.remaining / net);
  const dealsForShare = Math.ceil((input.remaining * MATERIAL_SHARE) / net);
  const available = input.repeatable ? highOf(input.volume) : 1;
  const window = Math.max(1, input.daysLeft - MIN_SALES_CYCLE_DAYS - Math.max(0, settle ?? 0));
  const prospectsPerDay = conv !== null && conv > 0 ? dealsForShare / conv / window : null;
  let verdict: TransactionFit['verdict'];
  let lever: TransactionFit['lever'];
  const cap = available ?? Infinity;
  if (cap >= dealsForGap && (prospectsPerDay === null || input.outreachBound === false || prospectsPerDay * 10 <= input.outreachPerDay)) {
    verdict = 'CARRIES_GAP';
    lever = { variable: null, change: 'nothing: its own volume and the outreach could carry the whole gap if its unknowns hold' };
  } else if (cap >= dealsForShare) {
    verdict = 'CARRIES_SHARE';
    if (prospectsPerDay !== null && prospectsPerDay > input.outreachPerDay && input.outreachBound !== false) lever = { variable: 'CHANNEL', change: `its share needs ${money(prospectsPerDay)} prospects a day against ${input.outreachPerDay} by cold outreach: a marketplace listing, a partner who already sells to these buyers, or buyers who publish requests` };
    else lever = { variable: 'VOLUME', change: `carries a tenth of the gap; ${dealsForGap} deals would carry all of it, so how many buyers exist decides how much more` };
  } else {
    verdict = 'TOO_SMALL_AS_IS';
    lever = !input.repeatable
      ? input.competitiveAward
        ? { variable: 'MECHANISM', change: 'an award pays once: only a different mechanism around the same evidence makes it larger' }
        : { variable: 'VOLUME', change: `one sale of ${money(net)} is ${money((net / input.remaining) * 100)}% of the gap: sell the same deliverable to buyers like this one` }
      : { variable: 'PRICE', change: `at most ${money(cap)} deals at ${money(net)}: a higher-value offer (a bundle, a retainer) or a larger buyer population` };
  }
  return { dealsForGap, dealsForShare, dealsAvailable: available === Infinity ? null : available, prospectsPerDay, verdict, lever };
}

/** What a pathway could put toward the goal inside the window, over its own bounds. Major units, net. */
function contributionOf(input: {
  net: PathFact;
  conversion: PathFact;
  volume: PathFact;
  repeatable: boolean;
  daysToCash: PathFact;
  daysLeft: number;
  outreachPerDay: number;
  closed: boolean;
}): { p10: number; p50: number; p90: number } {
  if (input.closed) return { p10: 0, p50: 0, p90: 0 };
  const at = (net: number | null, conv: number | null, volume: number | null, settle: number | null) => {
    if (net === null || net <= 0 || conv === null) return 0;
    const window = Math.max(0, input.daysLeft - MIN_SALES_CYCLE_DAYS - Math.max(0, settle ?? 0));
    if (window <= 0) return 0;
    // Expected deals, as the portfolio's demand model counts them: a one-off is its one buyer
    // asked once; a repeatable line gets a third of the shared outreach, capped by its volume.
    const deals = input.repeatable ? Math.min(volume ?? Infinity, (input.outreachPerDay / 3) * window * conv) : Math.min(1, conv);
    return Math.max(0, deals) * net;
  };
  const settleHigh = highOf(input.daysToCash);
  const settleLow = lowOf(input.daysToCash);
  return {
    p10: at(lowOf(input.net), lowOf(input.conversion), lowOf(input.volume), settleHigh),
    p50: at(mid(input.net), mid(input.conversion), mid(input.volume), mid(input.daysToCash)),
    p90: at(highOf(input.net), highOf(input.conversion), highOf(input.volume), settleLow),
  };
}

export interface InformationValue {
  opportunityId: string;
  title: string;
  variable: 'price' | 'directCost' | 'conversion' | 'volume' | 'daysToCash';
  /** The card field research would settle, or null when only selling reveals it. */
  field: ConstructionMove['field'];
  /** How far the pathway's contribution moves across the variable's range, major units, capped at the gap. */
  swing: number;
  /** Whether the high end would bring it into the leading combination, or the low end drop it out. */
  changesPlan: boolean;
  reason: string;
}

/**
 * Which unknowns could change the plan, largest swing first. Pure: each
 * variable not PROVEN is moved from its low to its high with the others at
 * their middle, and the change in the pathway's contribution is its value.
 */
export function informationValue(pathways: TransactionPathway[], input: { remaining: number; daysLeft: number; outreachPerDay: number; leaders: Set<string>; marginal: number }): InformationValue[] {
  const out: InformationValue[] = [];
  const FIELD: Record<InformationValue['variable'], InformationValue['field']> = { price: 'revenueRange', directCost: 'directCosts', conversion: 'conversionRates', volume: 'buyerVolume', daysToCash: 'timeToFirstCash' };
  for (const p of pathways) {
    if (p.gaps.includes('CLOSED')) continue;
    const base = { net: p.net, conversion: p.conversion, volume: p.volume, repeatable: p.frequency.value === 'repeats', daysToCash: p.daysToCash, daysLeft: input.daysLeft, outreachPerDay: input.outreachPerDay, closed: false };
    const pin = (f: PathFact, v: number | null): PathFact => ({ ...f, value: v, low: v, high: v, status: 'PROVEN' });
    const vary: [InformationValue['variable'], PathFact, (f: PathFact) => Partial<typeof base>][] = [
      ['price', p.revenuePerDeal, (f) => ({ net: { ...p.net, value: mid(f) === null ? null : mid(f)! - (mid(p.fulfilmentCost) ?? 0), low: null, high: null } })],
      ['directCost', p.fulfilmentCost, (f) => ({ net: { ...p.net, value: mid(p.revenuePerDeal) === null ? null : mid(p.revenuePerDeal)! - (mid(f) ?? 0), low: null, high: null } })],
      ['conversion', p.conversion, (f) => ({ conversion: f })],
      ['volume', p.volume, (f) => ({ volume: f })],
      ['daysToCash', p.daysToCash, (f) => ({ daysToCash: f })],
    ];
    for (const [variable, fact, apply] of vary) {
      if (fact.status === 'PROVEN') continue;
      if (variable === 'volume' && p.frequency.value !== 'repeats') continue;
      const lo = lowOf(fact);
      const hi = highOf(fact);
      if (lo === null || hi === null || lo === hi) continue;
      // Cost moves the opposite way to the others.
      const goodEnd = variable === 'directCost' || variable === 'daysToCash' ? lo : hi;
      const badEnd = variable === 'directCost' || variable === 'daysToCash' ? hi : lo;
      const good = contributionOf({ ...base, ...apply(pin(fact, goodEnd)) }).p50;
      const bad = contributionOf({ ...base, ...apply(pin(fact, badEnd)) }).p50;
      const swing = Math.min(input.remaining, Math.max(0, good - bad));
      if (swing <= 0) continue;
      const leader = input.leaders.has(p.opportunityId);
      const changesPlan = leader ? bad < input.marginal : good > input.marginal;
      out.push({
        opportunityId: p.opportunityId,
        title: p.title,
        variable,
        field: variable === 'conversion' && p.origin === 'FOUND' ? 'conversionRates' : FIELD[variable],
        swing,
        changesPlan,
        reason: `${variable} from ${money(badEnd)} to ${money(goodEnd)} moves its contribution from ${money(bad)} to ${money(good)}${changesPlan ? (leader ? ', enough to drop it from the leading combination' : ', enough to bring it into the leading combination') : ''}`,
      });
    }
  }
  return out.sort((a, b) => Number(b.changesPlan) - Number(a.changesPlan) || b.swing - a.swing);
}

/* ------------------------------------------------------------------ */
/* 5. A living portfolio                                               */
/* ------------------------------------------------------------------ */

export interface PathwayCombination {
  members: string[];
  /** Net contribution p10/p50/p90 summed, with a correlated group's second member at half weight. */
  net: { p10: number; p50: number; p90: number };
  gross: { p10: number; p50: number; p90: number };
  /** The share of the gap its middle reaches. */
  coverage: number;
  /** What is left if the largest correlated group fails. */
  ifLeadGroupFails: number;
  groups: string[];
  capital: number | null;
}

export interface LivingPortfolio {
  executable: string[];
  constructed: string[];
  leading: PathwayCombination | null;
  fallback: PathwayCombination | null;
  /** The remaining evidence and execution gaps of the leading combination, counted. */
  gaps: { gap: GapKind; label: string; pathways: number }[];
  /** Permissions every sale still needs. */
  permissions: string[];
  note: string;
}

const MAX_MEMBERS = 6;

export function combine(pathways: TransactionPathway[], input: { remaining: number; capitalCeiling: number | null; exclude?: Set<string> }): PathwayCombination | null {
  const pool = pathways
    .filter((p) => !input.exclude?.has(p.correlationGroup) && p.contribution.p90 > 0 && !p.gaps.includes('CLOSED') && !p.gaps.includes('NO_MARGIN'))
    .sort((a, b) => b.contribution.p50 - a.contribution.p50 || b.contribution.p90 - a.contribution.p90);
  if (pool.length === 0) return null;
  const members: TransactionPathway[] = [];
  const seen = new Map<string, number>();
  let capital = 0;
  let capitalKnown = true;
  for (const p of pool) {
    if (members.length >= MAX_MEMBERS) break;
    const tied = lowOf(p.capital);
    if (tied === null) capitalKnown = false;
    if (input.capitalCeiling !== null && tied !== null && capital + tied > input.capitalCeiling) continue;
    members.push(p);
    capital += tied ?? 0;
    seen.set(p.correlationGroup, (seen.get(p.correlationGroup) ?? 0) + 1);
  }
  // Every candidate ties up more than the ceiling allows: there is no combination.
  if (members.length === 0) return null;
  const weight = new Map<string, number>();
  const counted = new Map<string, number>();
  for (const p of members) {
    const n = counted.get(p.correlationGroup) ?? 0;
    weight.set(p.opportunityId, n === 0 ? 1 : 0.5);
    counted.set(p.correlationGroup, n + 1);
  }
  const sum = (pick: (p: TransactionPathway) => number) => Math.min(input.remaining, members.reduce((s, p) => s + pick(p) * weight.get(p.opportunityId)!, 0));
  const byGroup = new Map<string, number>();
  for (const p of members) byGroup.set(p.correlationGroup, (byGroup.get(p.correlationGroup) ?? 0) + p.contribution.p50 * weight.get(p.opportunityId)!);
  const largest = Math.max(0, ...byGroup.values());
  const net = { p10: sum((p) => p.contribution.p10), p50: sum((p) => p.contribution.p50), p90: sum((p) => p.contribution.p90) };
  return {
    members: members.map((p) => p.opportunityId),
    net,
    gross: { p10: sum((p) => p.gross.p10), p50: sum((p) => p.gross.p50), p90: sum((p) => p.gross.p90) },
    coverage: input.remaining > 0 ? net.p50 / input.remaining : 1,
    ifLeadGroupFails: Math.max(0, net.p50 - largest),
    groups: [...seen.keys()],
    capital: capitalKnown ? capital : null,
  };
}

export function livingPortfolio(pathways: TransactionPathway[], input: { remaining: number; capitalCeiling: number | null }): LivingPortfolio {
  const leading = combine(pathways, input);
  let fallback: PathwayCombination | null = null;
  if (leading) {
    const byId = new Map(pathways.map((p) => [p.opportunityId, p]));
    const lead = byId.get(leading.members[0]!)!;
    fallback = combine(pathways, { ...input, exclude: new Set([lead.correlationGroup]) });
  }
  const members = new Set(leading?.members ?? []);
  const counts = new Map<GapKind, number>();
  for (const p of pathways) if (members.has(p.opportunityId)) for (const gap of p.gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  const permissions = [...new Set(pathways.flatMap((p) => p.permissionsMissing))];
  return {
    executable: pathways.filter((p) => p.executable).map((p) => p.opportunityId),
    constructed: pathways.filter((p) => p.origin === 'CONSTRUCTED' || p.moves.some((m) => m.variant)).map((p) => p.opportunityId),
    leading,
    fallback,
    gaps: [...counts.entries()].map(([gap, n]) => ({ gap, label: GAP_LABEL[gap], pathways: n })).sort((a, b) => b.pathways - a.pathways),
    permissions,
    note: 'A provisional portfolio over each pathway\'s own bounds — never a probability. Executable means every commercial link is established or estimated with a basis; a missing permission blocks only the send.',
  };
}

/* ------------------------------------------------------------------ */
/* 6. Its own reasoning failures                                       */
/* ------------------------------------------------------------------ */

export const REASONING_CAUSES = ['CONSTRUCTION_FAILURE', 'ACQUISITION_FAILURE', 'CASH_TIMING_FAILURE', 'VOLUME_UNRESEARCHED', 'REPEATED_GAP'] as const;
export type ReasoningCause = (typeof REASONING_CAUSES)[number];

/**
 * The failures of the method rather than of one opening. Pure. Each comes with
 * the instruction the next round is given, so the method changes, not one case.
 */
export function reasoningFailures(pathways: TransactionPathway[], rounds: GoalRoundOutcome[]): ResearchDiagnosis[] {
  const found = pathways.filter((p) => p.origin === 'FOUND');
  const out: ResearchDiagnosis[] = [];
  const settled = rounds.filter((r) => r.state !== 'OPEN');
  const offers = found.filter((p) => p.offer.status !== 'UNKNOWN' && p.buyer.status !== 'UNKNOWN' && !p.gaps.includes('SUPPLY_WITHOUT_BUYER')).length;
  if (settled.length >= 4 && found.length > 0 && offers / found.length < 0.25) {
    out.push({
      cause: 'CONSTRUCTION_FAILURE',
      evidence: `${settled.length} settled rounds and ${found.length} openings held produced ${offers} with both a buyer and a specific offer`,
      instruction:
        'Searching for a finished opening keeps failing, so construct one: report any one component of a transaction — buyers publicly paying for something, a supplier\'s published price, a provider with spare capacity — and Brain composes the missing parts (who buys, who fulfils, the role and price) from it.',
    });
  }
  const priced = found.filter((p) => p.revenuePerDeal.status !== 'UNKNOWN');
  const unreached = priced.filter((p) => p.channel.status === 'UNKNOWN' || p.gaps.includes('SUPPLY_WITHOUT_BUYER'));
  if (priced.length >= 3 && unreached.length / priced.length >= 0.5) {
    out.push({
      cause: 'ACQUISITION_FAILURE',
      evidence: `${unreached.length} of ${priced.length} priced pathways have no reachable buyer of ours`,
      instruction:
        'The prices are found but the buyers are not reachable, so for each kind of deliverable report where its buyers publicly ask for it — a request board, a marketplace category, an inbox on an official page, a partner who already sells to them — with one dated request.',
    });
  }
  const reachable = found.filter((p) => p.channel.status !== 'UNKNOWN');
  const slow = reachable.filter((p) => p.gaps.includes('SLOW_OR_UNKNOWN_CASH'));
  if (reachable.length >= 3 && slow.length / reachable.length >= 0.5) {
    out.push({
      cause: 'CASH_TIMING_FAILURE',
      evidence: `${slow.length} of ${reachable.length} reachable pathways settle too late or nobody knows when`,
      instruction: 'Deals are reachable but their cash timing is the barrier, so report how buyers of each kind pay (card at order, deposit, prepayment, net terms) and the days until the money is usable.',
    });
  }
  const small = pathways.filter((p) => p.gaps.includes('SMALL_TICKET_VOLUME_UNKNOWN') || p.gaps.includes('ONE_BUYER'));
  if (small.length >= 3) {
    out.push({
      cause: 'VOLUME_UNRESEARCHED',
      evidence: `${small.length} pathways are small per sale with their buyer count unknown`,
      instruction: 'Small sales are not excluded: for each, count how many buyers of exactly that kind exist and how often each buys, from a directory, register or marketplace count, so their total can be judged.',
    });
  }
  const counts = new Map<GapKind, number>();
  for (const p of found) for (const gap of p.gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  const [worst] = [...counts.entries()].filter(([gap]) => gap !== 'CLOSED').sort((a, b) => b[1] - a[1]);
  if (worst && worst[1] >= 3 && worst[1] / Math.max(1, found.length) >= 0.6) {
    out.push({
      cause: 'REPEATED_GAP',
      evidence: `${worst[1]} of ${found.length} openings fail the same way: ${GAP_LABEL[worst[0]]}`,
      instruction: `The same gap repeats across openings (${GAP_LABEL[worst[0]]}), so the method, not one case, changes: ${REPEATED_FIX[worst[0]]}`,
    });
  }
  return out;
}

const REPEATED_FIX: Record<GapKind, string> = {
  NO_BUYER: 'start each search from a buyer publicly asking and paying, not from a seller.',
  SUPPLY_WITHOUT_BUYER: 'treat a supplier\'s published price as the reference price its buyers pay, and report who those buyers are and where they ask.',
  NO_CHANNEL: 'report the place a buyer is reached together with the buyer.',
  NO_OFFER: 'state the exact deliverable a buyer would receive.',
  NO_PRICE: 'state what buyers pay for the exact deliverable, from completed sales or a competitor\'s price to the same buyers.',
  NO_SUPPLIER: 'name the independent provider or tool that performs the work with its rate.',
  NO_MARGIN: 'report the end buyer\'s price, not an intermediary\'s rate.',
  SLOW_OR_UNKNOWN_CASH: 'report the payment terms with every opening.',
  OVER_CAPITAL: 'prefer arrangements paid before the supplier is.',
  SMALL_TICKET_VOLUME_UNKNOWN: 'report the buyer count and purchase frequency with every small-ticket opening.',
  ONE_BUYER: 'report the population of buyers like the one found, not the one.',
  CLOSED: 'report only openings still open.',
  ONE_TRANSACTION_SHAPE: 'report the package, retainer and implementation prices buyers pay for the deliverable, not one unit price.',
  REACH_SHORTFALL: 'report where buyers of this kind already ask or are served (a marketplace category, a partner, published requests), not only how to contact them.',
};

/* ------------------------------------------------------------------ */
/* The whole reading                                                   */
/* ------------------------------------------------------------------ */

export interface PathwayReading {
  structures: GoalStructures;
  pathways: TransactionPathway[];
  portfolio: LivingPortfolio;
  informationValue: InformationValue[];
  failures: ResearchDiagnosis[];
  /** The next actions, best first: sell, construct, research — each its own action, so one block stops nothing else. */
  nextActions: { opportunityId: string; title: string; action: MoveAction; what: string; field: ConstructionMove['field']; ask: string | null; blockedBy: string[] }[];
  measures: {
    pathways: number;
    found: number;
    constructed: number;
    executable: number;
    /** Pathways no further engineering stands between and a sale: executable, or blocked only by a permission. */
    proceedWithoutEngineering: number;
    withReachableBuyer: number;
    withFulfiller: number;
    /** Pathways whose every needed permission is granted (a proven `rights`). */
    withRightsGranted: number;
    /** Pathways with a delivery capacity at least estimated (a `capacity` that is not unknown). */
    withCapacity: number;
    /** Of those, fulfilled by Brain's own proven capability. */
    producedByBrain: number;
    /** Pathways by how their buyers are reached. */
    acquisition: Record<AcquisitionMethod, number>;
    /** Fact counts across every pathway. */
    facts: { proven: number; estimated: number; unknown: number };
    /** Moves that construct a missing component (role flips, transfers, supplier or buyer acquisition). */
    constructionMoves: number;
    /** New transaction variants constructed from existing evidence. */
    variants: number;
    leadingNetP50: number;
    leadingCoverage: number;
  };
}

/** At most this many pathways are read (largest potential first), so the reading stays bounded. */
export const MAX_PATHWAYS = 40;
export const MAX_NEXT_ACTIONS = 12;

export function readPathways(input: {
  modelled: ModelledOpportunity[];
  considered: Pick<ConsideredOpening, 'opportunityId' | 'missing' | 'paysOnce' | 'competitiveAward' | 'volumeEstablished' | 'potentialReach' | 'supportedReach'>[];
  target: Pick<TargetReading, 'remainingCents' | 'daysLeft' | 'currency' | 'capitalCeilingCents' | 'capitalBeforeProofCents'>;
  portfolio: Pick<GoalPortfolio, 'limits'> | null;
  permissionsMissing: string[];
  rounds: GoalRoundOutcome[];
  now: Date;
  capabilities?: BrainCapabilities | null;
}): PathwayReading {
  const remaining = input.target.remainingCents / 100;
  const daysLeft = Math.max(0, input.target.daysLeft ?? 0);
  const contacts = input.portfolio?.limits.contactsPerDay;
  const outreach = { low: contacts?.low ?? 10, high: contacts?.value ?? contacts?.high ?? 60, stated: contacts?.value !== null && contacts?.value !== undefined };
  const perArrangement = input.portfolio?.limits.perArrangement ?? (input.target.capitalBeforeProofCents === null ? null : input.target.capitalBeforeProofCents / 100);
  const ceiling = input.portfolio?.limits.spendCeiling ?? (input.target.capitalCeilingCents === null ? null : input.target.capitalCeilingCents / 100);
  const structures = requiredStructures({ remaining, daysLeft, currency: input.target.currency, perArrangement, spendCeiling: ceiling, outreachPerDay: outreach });
  const judged = new Map(input.considered.map((c) => [c.opportunityId, c]));
  const potential = (one: ModelledOpportunity) => {
    const c = judged.get(one.opportunity.id);
    return Math.max(c?.supportedReach ?? 0, c?.potentialReach ?? 0, one.price.high ?? one.price.value ?? 0);
  };
  const chosen = [...input.modelled].sort((a, b) => potential(b) - potential(a)).slice(0, MAX_PATHWAYS);
  const pathways = chosen.map((one) =>
    pathwayOf(one, judged.get(one.opportunity.id) ?? null, { remaining, daysLeft, currency: input.target.currency, perArrangement, outreachPerDay: outreach.high, permissionsMissing: input.permissionsMissing, now: input.now, capabilities: input.capabilities ?? null }),
  );
  const portfolio = livingPortfolio(pathways, { remaining, capitalCeiling: ceiling });
  const leaders = new Set(portfolio.leading?.members ?? []);
  const byId = new Map(pathways.map((p) => [p.opportunityId, p]));
  const marginal = Math.min(...[...leaders].map((id) => byId.get(id)?.contribution.p50 ?? 0), Infinity);
  const information = informationValue(pathways, { remaining, daysLeft, outreachPerDay: outreach.high, leaders, marginal: Number.isFinite(marginal) ? marginal : 0 });
  const failures = reasoningFailures(pathways, input.rounds);
  // Next actions: sales first, then the construction moves on the pathways the plan rests on, then the information value.
  const order = [...pathways].sort((a, b) => Number(leaders.has(b.opportunityId)) - Number(leaders.has(a.opportunityId)) || b.contribution.p90 - a.contribution.p90);
  const nextActions: PathwayReading['nextActions'] = [];
  const push = (p: TransactionPathway, m: ConstructionMove) => {
    if (nextActions.some((n) => n.opportunityId === p.opportunityId && n.field === m.field && n.action === m.action)) return;
    nextActions.push({ opportunityId: p.opportunityId, title: p.title, action: m.action, what: m.construct, field: m.field, ask: m.ask, blockedBy: m.action === 'SELL' ? p.permissionsMissing : [] });
  };
  for (const p of order) for (const m of p.moves) if (m.action === 'SELL') push(p, m);
  // Constructions in the order their cash could be collected before the deadline, not their theoretical value.
  const collectible = [...pathways].sort((a, b) => byCollectibility(a, b, daysLeft));
  for (const p of collectible) for (const m of p.moves) if (m.action === 'CONSTRUCT') push(p, m);
  for (const v of information) {
    const p = byId.get(v.opportunityId);
    const m = p?.moves.find((one) => one.field === v.field);
    if (p && m) push(p, m);
  }
  for (const p of order) for (const m of p.moves) if (m.action === 'RESEARCH') push(p, m);
  const facts = { proven: 0, estimated: 0, unknown: 0 };
  for (const p of pathways) {
    facts.proven += p.counts.proven;
    facts.estimated += p.counts.estimated;
    facts.unknown += p.counts.unknown;
  }
  const constructionMoves = pathways.reduce((n, p) => n + p.moves.filter((m) => m.action === 'CONSTRUCT').length, 0);
  return {
    structures,
    pathways,
    portfolio,
    informationValue: information,
    failures,
    nextActions: nextActions.slice(0, MAX_NEXT_ACTIONS),
    measures: {
      pathways: pathways.length,
      found: pathways.filter((p) => p.origin === 'FOUND').length,
      constructed: pathways.filter((p) => p.origin === 'CONSTRUCTED').length,
      executable: pathways.filter((p) => p.executable).length,
      proceedWithoutEngineering: pathways.filter((p) => p.executable || p.moves.some((m) => m.action === 'SELL')).length,
      withReachableBuyer: pathways.filter((p) => p.channel.status !== 'UNKNOWN' && p.buyer.status !== 'UNKNOWN' && !p.gaps.includes('SUPPLY_WITHOUT_BUYER')).length,
      withFulfiller: pathways.filter((p) => p.fulfiller.status !== 'UNKNOWN').length,
      withRightsGranted: pathways.filter((p) => p.rights.status === 'PROVEN').length,
      withCapacity: pathways.filter((p) => p.capacity.status !== 'UNKNOWN').length,
      producedByBrain: pathways.filter((p) => p.producedBy !== null).length,
      acquisition: Object.fromEntries(ACQUISITION_METHODS.map((m) => [m, pathways.filter((p) => p.acquisition.method === m).length])) as Record<AcquisitionMethod, number>,
      facts,
      constructionMoves,
      variants: pathways.reduce((n, p) => n + p.moves.filter((m) => m.variant).length, 0),
      leadingNetP50: portfolio.leading?.net.p50 ?? 0,
      leadingCoverage: portfolio.leading?.coverage ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rendering, for the terminal and the Goals workflow                  */
/* ------------------------------------------------------------------ */

const S = (f: PathFact) => (f.status === 'PROVEN' ? 'P' : f.status === 'ESTIMATED' ? 'E' : '?');
const V = (f: PathFact) => (f.value === null ? (f.low !== null && f.high !== null ? `${money(f.low)}–${money(f.high)}` : '—') : typeof f.value === 'number' ? money(f.value) : String(f.value).slice(0, 60));

/** The reading as lines. Pure. P = proven, E = estimated, ? = unknown. */
export function renderPathways(reading: PathwayReading, limit = 12): string[] {
  const out: string[] = [];
  const s = reading.structures;
  const m = reading.measures;
  out.push(`  reasoning   goal-to-transaction loop (§93): ${m.pathways} pathway(s) (${m.found} found, ${m.constructed} constructed), ${m.executable} executable, ${m.proceedWithoutEngineering} can proceed without engineering, ${m.withReachableBuyer} with a reachable buyer, ${m.withFulfiller} with a fulfiller (${m.producedByBrain} by Brain's own capability), ${m.withRightsGranted} with every permission granted, ${m.withCapacity} with a delivery capacity at least estimated; reached by ${ACQUISITION_METHODS.filter((k) => m.acquisition[k] > 0).map((k) => `${k} ${m.acquisition[k]}`).join(' · ')}; facts P ${m.facts.proven} · E ${m.facts.estimated} · ? ${m.facts.unknown}; ${m.constructionMoves} construction move(s), ${m.variants} new variant(s)`);
  out.push(`    backward  ${money(s.remaining)} ${s.currency} in ${s.daysLeft} day(s), outreach ${s.outreachPerDay.low}–${s.outreachPerDay.high}/day${s.outreachPerDay.stated ? '' : ' (not stated; bounds)'}; outreach alone needs ≥ ${s.minimumNetForOutreach === null ? '∞' : money(s.minimumNetForOutreach)} net per deal`);
  for (const one of s.structures) out.push(`    structure ${one.kind.padEnd(14)} ${one.verdict.padEnd(21)} ${one.label} · ${money(one.perDay.middle)}/day middle, ${money(one.perDay.best)}/day best · ${one.reason.slice(0, 160)}`);
  const ordered = [...reading.pathways].sort((a, b) => b.contribution.p50 - a.contribution.p50 || b.contribution.p90 - a.contribution.p90);
  // The largest by contribution, then every pathway the loop is constructing something from.
  const shown = [...ordered.slice(0, Math.ceil(limit / 2))];
  for (const p of ordered) if (shown.length < limit * 2 && !shown.includes(p) && p.moves.some((m) => m.action === 'CONSTRUCT' || m.action === 'SELL')) shown.push(p);
  for (const p of shown) {
    out.push(`    pathway   ${p.opportunityId} ${p.origin} ${p.executable ? 'EXECUTABLE' : 'not executable'} · net p10/p50/p90 ${money(p.contribution.p10)}/${money(p.contribution.p50)}/${money(p.contribution.p90)} (gross p50 ${money(p.gross.p50)}) · rights ${S(p.rights)} · capacity ${S(p.capacity)} · fit ${p.fit.verdict}${p.fit.lever.variable ? ` lever ${p.fit.lever.variable}` : ''} · ${p.title.slice(0, 70)}`);
    out.push(`      model   buyer ${S(p.buyer)} ${V(p.buyer)} | why ${S(p.motivation)} | channel ${S(p.channel)} ${V(p.channel)} [${p.acquisition.method}] | offer ${S(p.offer)} | fulfils ${S(p.fulfiller)} ${V(p.fulfiller)}`);
    out.push(`      money   price ${S(p.revenuePerDeal)} ${V(p.revenuePerDeal)} | acquire ${S(p.acquisitionCost)} ${V(p.acquisitionCost)} | fulfil ${S(p.fulfilmentCost)} ${V(p.fulfilmentCost)} | net ${S(p.net)} ${V(p.net)} | convert ${S(p.conversion)} ${V(p.conversion)} | volume ${S(p.volume)} ${V(p.volume)} ${String(p.frequency.value)} | cash ${S(p.daysToCash)} ${V(p.daysToCash)}d | capital ${S(p.capital)} ${V(p.capital)}`);
    out.push(`      gaps    ${p.gaps.map((g) => GAP_LABEL[g]).join('; ') || 'none'}${p.permissionsMissing.length ? ` · permissions: ${p.permissionsMissing.join(', ')}` : ''} · ${p.fit.lever.change.slice(0, 140)}`);
    for (const move of p.moves.slice(0, 3)) out.push(`      ${move.action.toLowerCase().padEnd(9)} ${move.construct.slice(0, 150)}${move.mustHit ? ` — must hit: ${move.mustHit.slice(0, 160)}` : ''}${move.variant ? ` · variant: ${move.variant.label} (price ${S(move.variant.revenuePerDeal)} ${V(move.variant.revenuePerDeal)}, net ${S(move.variant.net)} ${V(move.variant.net)})` : ''}`);
  }
  const lead = reading.portfolio.leading;
  out.push(`    portfolio ${reading.portfolio.note}`);
  if (lead) {
    out.push(`      leading ${lead.members.join(' + ')} · net p10/p50/p90 ${money(lead.net.p10)}/${money(lead.net.p50)}/${money(lead.net.p90)} (gross p50 ${money(lead.gross.p50)}) · ${Math.round(lead.coverage * 1000) / 10}% of the gap at p50 · if its largest group fails ${money(lead.ifLeadGroupFails)} · capital ${lead.capital === null ? 'not established' : money(lead.capital)} · groups ${lead.groups.join(' / ')}`);
  } else out.push('      leading none: no pathway has a positive contribution yet');
  const fb = reading.portfolio.fallback;
  if (fb) out.push(`      fallback ${fb.members.join(' + ')} · net p50 ${money(fb.net.p50)} · without the leader's group`);
  out.push(`      gaps    ${reading.portfolio.gaps.map((g) => `${g.label} ×${g.pathways}`).join('; ') || 'none'}${reading.portfolio.permissions.length ? ` · still to grant: ${reading.portfolio.permissions.join(', ')}` : ''}`);
  for (const v of reading.informationValue.slice(0, 6)) out.push(`    unknown   ${v.changesPlan ? 'CHANGES PLAN' : 'swing'} ${money(v.swing)} · ${v.variable} → ${v.field ?? 'learned by selling'} · ${v.title.slice(0, 50)} · ${v.reason.slice(0, 140)}`);
  for (const f of reading.failures) out.push(`    method    ${f.cause}: ${f.evidence}`);
  // The exact sale each ready pathway proposes, and only what stops it (owner, 2026-11-08).
  for (const p of reading.pathways.filter((one) => one.moves.some((m) => m.action === 'SELL'))) {
    out.push(`    ready     ${p.opportunityId} SELL "${V(p.offer)}" to ${V(p.buyer)} via ${V(p.channel)} [${p.acquisition.method}] at ${V(p.revenuePerDeal)} ${''}(${p.revenuePerDeal.status}), fulfilled by ${V(p.fulfiller)} (${p.fulfiller.status}), cash ${V(p.daysToCash)}d (${p.daysToCash.status}) · needs only: ${p.permissionsMissing.join(', ') || 'nothing'}`);
  }
  for (const a of reading.nextActions) out.push(`    next      ${a.action} ${a.opportunityId} ${a.what.slice(0, 120)}${a.blockedBy.length ? ` (blocked only by ${a.blockedBy.join(', ')})` : ''}`);
  return out;
}
