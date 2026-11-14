/**
 * A goal's scenario model, composed from Brain's own rows.
 *
 * The scenario engine (`services/scenario/`) is pure and knows nothing about
 * Cash. This is the adapter `docs/SCENARIOS.md` names as missing: it reads a
 * targeted goal, the project's live opportunities, their card facts, the
 * ledger and the measured outcome history, and writes a typed
 * `ScenarioModelDefinition` the existing engine runs. It copies no fact into a
 * second ledger — every variable carries a source reference back to the row
 * that owns it — and it invents no number:
 *
 *   * a figure on the card from a gated claim is `EVIDENCE`;
 *   * a person's figure or Brain's proposal is an `ASSUMPTION`, one value;
 *   * a measured rate from this Brain's own finished deals is `HISTORICAL`;
 *   * everything else is `UNKNOWN` and is a swept range whose bounds are named
 *     as a stress interval, never a guess at the truth.
 *
 * Because unknowns are swept, a run over them is a SWEEP and its shares are
 * coverage of tested conditions, not probabilities — the engine enforces that
 * and the plan reading repeats it.
 *
 * The money the model counts is the goal's own figure: for a settled-cash goal,
 * cash that both closes *and* settles before the deadline. A larger deal that
 * pays after the deadline contributes nothing, which is what lets a smaller,
 * faster plan beat a bigger, slower one.
 */
import { instantlyCapacity, instantlyMeasuredRates } from './providers/instantly.ts';
import { breaksOperatingModel, operatingFactsOf, operatingFit } from '../../domain/operatingModel.ts';
import { EXCLUSION_CLASSES, excludedBy, goalExclusions } from './exclusions.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactMap } from '../../repos/cashCardFacts.ts';
import { agreementsFor } from '../../repos/cashJourney.ts';
import { readMoneyFigures } from './figures.ts';
import { readDays } from './monetization/commissionPass.ts';
import { cashOutcomeLessons, LESSON_MIN_SAMPLE } from './journey/learning.ts';
import { isTestFirstPlay } from './tier.ts';
import { readVolume } from './volume.ts';
import { sharedFrontier } from './shared.ts';
import type { CashOpportunity, CashCardFact } from '../../domain/types.ts';
import { SCENARIO_LIMITS, type ScenarioModelDefinition, type ScenarioVariable, type SourceRef, type StrategySpec, type VariableProvenance } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';
import type { TargetReading } from '../goals/target.ts';
import { inferCashQuantity, loadCashKnowledge, type CashKnowledge, type CashQuantity } from '../quant/knowledge.ts';
import { inputSample, toScenarioInput, type InputSample } from '../quant/export.ts';
import { CONTACTS_PER_DAY_BOUNDS, evaluateGoalPortfolio, measuredRateInput, type GoalPortfolio, type PlannedOpening } from '../goals/portfolio.ts';
import { SPREAD_FLOOR } from '../quant/pool.ts';
import type { Estimate, EvidenceTier } from '../../domain/quant.ts';
import type { VariableSpec } from '../../domain/scenario.ts';
import { composeInvented, inventionContext, TRANSFER_MATERIAL, type ConstructedArrangement, type InventedDesign } from './construct.ts';
export { TRANSFER_MATERIAL };

/**
 * Phase timings for a plan read, printed as they happen when BRAIN_PLAN_TRACE is
 * set (the Goals workflow sets it). Production, 2026-11-02: the read went from
 * 15 s to past the workflow's 15-minute bound, while the same code reads a
 * 25-opening plan locally in 0.7 s — only a timing taken where it is slow can
 * say which phase it is.
 */
export function planTrace(scope: string, env = process.env): (label: string) => void {
  if (!env['BRAIN_PLAN_TRACE']) return () => {};
  const start = Date.now();
  let last = start;
  return (label) => {
    const now = Date.now();
    console.error(`  trace ${scope} +${now - last}ms (${now - start}ms) ${label}`);
    last = now;
  };
}

/** Variables the model declares once, and per opportunity. */
export const GOAL_MODEL_VARIABLES = 4;
export const OPPORTUNITY_MODEL_VARIABLES = 9;
/**
 * At most this many opportunities in one model, derived from the engine's own
 * variable limit rather than written beside it — a constant written beside it
 * was 5, which is 44 variables, and production refused the first real model.
 */
export const MAX_MODEL_OPPORTUNITIES = Math.floor((SCENARIO_LIMITS.maxVariables - GOAL_MODEL_VARIABLES) / OPPORTUNITY_MODEL_VARIABLES);
/** A repeatable play's strategy offers to this many times the buyers it needs. */
export const OUTREACH_MULTIPLE = 4;
/** And never more than this many buyers in one strategy. */
export const MAX_BUYERS_OFFERED = 200;

const LIVE = new Set(['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING']);
const IN_FLIGHT = new Set(['EXECUTING', 'DELIVERING']);
const TIER_ORDER: Record<string, number> = { READY_TO_TEST: 0, QUALIFIED: 1, CANDIDATE: 2, SIGNAL: 3 };

/** One quantity about one opportunity, with where it came from. */
export interface ModelInput {
  value: number | null;
  low: number | null;
  high: number | null;
  provenance: VariableProvenance;
  source: SourceRef | null;
  note: string;
  /**
   * A distribution or narrowed range the quantitative inference engine (§79)
   * reconstructed for an unknown from comparable or component evidence. `value`
   * stays null: an inferred number never establishes a link of the plan's
   * causal chain, it only replaces a blind sweep with an evidenced one.
   */
  distribution?: VariableSpec;
  /** `observations` counts studies; the evidence in events and populations is `InputSample` (Q2-2). */
  inferred?: { tier: EvidenceTier; justified: boolean; p10: number; p50: number; p90: number; observations: number } & Partial<InputSample>;
}

export interface ModelledOpportunity {
  /**
   * A buyer-acquisition channel of its own, instead of the shared cold
   * outreach: prospects a day it brings (paid inbound, a marketplace, a
   * partner), the capacity it draws on and the risk it shares. Set only by a
   * reconstructed strategy (§99), never by a card.
   */
  channel?: { label: string; perDay: ModelInput; resource: string; riskGroup: string };
  /**
   * The buyer pays before the supplier is paid, so its direct cost is funded
   * from the buyer's money rather than the owner's. Set only by a
   * reconstructed strategy (§99) and always as an assumption.
   */
  fundedByBuyer?: boolean;
  opportunity: CashOpportunity;
  index: number;
  tier: string;
  repeatable: boolean;
  /** Major units of the goal's currency. */
  price: ModelInput;
  capital: ModelInput;
  hours: ModelInput;
  daysToCash: ModelInput;
  close: ModelInput;
  /**
   * The share of prospects contacted who reply with interest, before any of
   * them buy — the first step of the quant engine's demand estimate
   * (`goals/portfolio.ts`). One when `close` was measured per contact, since
   * that measurement already contains it.
   */
  respond: ModelInput;
  directCost: ModelInput;
  /**
   * Deals the market can take inside the window: reachable buyers times how
   * often each buys, as research stated them (`volume.ts`). A one-off is one
   * deal. A repeatable play whose volume nobody has established is a swept
   * range here and a missing link in the plan — never a number a plan assumes.
   */
  volume: ModelInput;
  /** A live agreement already recorded for this opportunity. */
  agreed: boolean;
  /** What those agreements are worth, in major units: money a buyer has already agreed to. */
  agreedValue: number;
  /** How many live agreements that is: each one is a deal that may tie up money too. */
  agreedDeals: number;
  /**
   * Who does the work, when a source or a person has said so. Brain is one
   * possible fulfiller, never the only one: a partner, a subcontractor, a
   * supplier or the owner's own people fulfil just as well, and a plan that
   * only counted Brain's own deliverables could never contain a brokered,
   * logistics or resale opening.
   */
  fulfilledBy: { value: string; provenance: VariableProvenance; source: SourceRef | null } | null;
  /**
   * Money only comes after somebody else picks us: a bid, a tender, a
   * solicitation, a grant. That is a gate outside our control before any work,
   * a second wait after it for payment, and usually money spent to compete —
   * and it pays in one lump at the end, not little by little.
   */
  competitiveAward: boolean;
  /**
   * A constructed arrangement entered on its reconstructed estimates (§82),
   * not an opening anybody found. Every link of the plan's chain is missing for
   * it, so it can never make a plan recommendable; it competes only on what it
   * could contribute, which is what decides where research goes next.
   */
  estimated?: {
    arrangementKey: string;
    tier: string;
    observations: number;
    /** A transferred design's material dimensions and which are bridged (S-12). */
    transfer?: { precedent: string; material: string[]; bridged: string[]; unbridged: string[] };
    /** A design Brain's reasoning model invented (S-11): a hypothesis about structure, every input of it unestablished. */
    invented?: boolean;
  };
}

/** The id an estimated arrangement takes in a goal model. Never a row. */
export const ARRANGEMENT_ID_PREFIX = 'arr_';
export function isArrangementId(id: string): boolean {
  return id.startsWith(ARRANGEMENT_ID_PREFIX);
}
/** At most this many constructed arrangements enter one goal model as estimates. */
export const MAX_ESTIMATED_ARRANGEMENTS = 12;

/**
 * A constructed arrangement as a model candidate, from its reconstructed value
 * alone — or null when nothing reconstructs its value, or its known worst case
 * breaks the limits. Price is the reconstruction's own p10–p50–p90; everything
 * else nobody has established is swept, exactly as for an opening with nothing
 * on its card. A recurring design is repeatable, with its volume a range from
 * one deal, never a number assumed. Pure.
 */
export function estimatedFromArrangement(one: ConstructedArrangement, input: { projectId: string; currency: string; beforeProofCents: number | null }): ModelledOpportunity | null {
  const { p10, p50, p90 } = one.value;
  // A MECHANISM value is a pool of other buyers' prices, not these buyers': it
  // is no price, and a cost or capital swept from its top would be borrowed too
  // (PRICE-POOL, 2026-11-14). Like UNKNOWN, it stays a research target only.
  if (one.value.tier === 'UNKNOWN' || one.value.tier === 'MECHANISM' || !(p50 > 0) || !(p90 >= p10)) return null;
  if (one.stress.exposure === 'EXCEEDS') return null;
  const ref: SourceRef = { kind: 'OTHER', ref: `arrangement:${one.key}`, note: `${one.value.tier} reconstruction from ${one.value.observations} observation(s)` };
  // A transfer carries a design to buyers who differ from the precedent's on every material dimension
  // nobody has bridged: until a sourced adjustment bridges one, its price range is widened, never narrowed (S-12).
  const transfer = transferOf(one);
  const widen = transfer && transfer.unbridged.length > 0 ? Math.exp(SPREAD_FLOOR.COMPARABLE * Z90) : 1;
  const low = Math.max(0.01, p10 / widen);
  const high = Math.max(low + 0.01, p90 * widen);
  const price: ModelInput = {
    value: null,
    low,
    high,
    provenance: 'ASSUMPTION',
    source: ref,
    note:
      `reconstructed (${one.value.tier}, ${one.value.observations} obs.), not shown paid: p10 ${p10} p50 ${p50} p90 ${p90}` +
      (transfer && transfer.unbridged.length ? `; transferred from "${transfer.precedent}" with ${transfer.unbridged.join(', ')} not bridged, so swept ${Math.round(low)}–${Math.round(high)}` : ''),
    // Swept over the reconstruction's range: an estimate carries no distribution (only evidence may).
    inferred: { tier: one.value.tier as EvidenceTier, justified: false, p10, p50, p90, observations: one.value.observations },
  };
  return arrangementOpening(one, input, price, high, transfer);
}

/**
 * A constructed arrangement as a model candidate on a price already read: the
 * links nobody has established swept exactly as for an opening with nothing on
 * its card. Shared by the estimated and the invented conversions. Pure.
 */
function arrangementOpening(one: ConstructedArrangement, input: { projectId: string; currency: string }, price: ModelInput, high: number, transfer: ReturnType<typeof transferOf>, invented = false): ModelledOpportunity {
  const ref: SourceRef = price.source ?? { kind: 'OTHER', ref: `arrangement:${one.key}` };
  const worst = one.stress.worstCaseCents === null ? null : one.stress.worstCaseCents / 100;
  const capital: ModelInput =
    one.stress.exposure === 'SAFE'
      ? { value: null, low: 0, high: 0.01, provenance: 'ASSUMPTION', source: ref, note: 'the design spends nothing of ours before buyers commit; not yet established in practice' }
      : worst !== null
        ? unknown(0, Math.max(0.01, worst), `the design's known worst case is ${worst}; swept from nothing to it`)
        : unknown(0, high, 'nobody has established the money tied up; swept from nothing to the top price');
  const repeatable = one.design.repeat !== 'ONE_OFF';
  const opportunity = {
    id: `${ARRANGEMENT_ID_PREFIX}${one.key}`,
    projectId: input.projectId,
    title: `${invented ? 'Invented' : 'Constructed'}: ${one.label}`.slice(0, 200),
    mechanism: 'OTHER',
    industry: one.sector,
    source: null,
    payer: null,
    reachableChannel: null,
    buyingSignal: null,
    signalObservedAt: null,
    offerScope: null,
    priceCents: null,
    currency: input.currency,
    fulfillmentOwner: null,
    peakFundingCents: null,
    humanHours: null,
    expiresAt: null,
    duplicateOfId: null,
    requiredCapabilities: [],
    state: 'DISCOVERED',
    createdAt: new Date(0).toISOString(),
  } as unknown as CashOpportunity;
  return {
    opportunity,
    index: 0,
    tier: 'ESTIMATE',
    repeatable,
    price,
    capital,
    hours: unknown(1, 40, 'nobody has established the hours; swept from 1 to 40 per deal'),
    daysToCash: unknown(3, 60, 'nobody has established when the money would settle; swept from 3 to 60 days'),
    close: unknown(0.02, 0.5, 'no buyer has been asked yet; swept from 2% to 50% of buyers agreeing'),
    respond: unknown(0.002, 0.15, 'nobody has established how many prospects of this kind reply; swept from 0.2% to 15%'),
    directCost: unknown(0, Math.max(0.01, high * 0.6), 'nobody has established the direct cost; swept from nothing to 60% of the top price'),
    volume: repeatable
      ? unknown(1, MAX_BUYERS_OFFERED, `a ${one.design.repeat.toLowerCase().replace('_', ' ')} design repeats, but nobody has established how many buyers exist; swept from 1 deal`)
      : known(1, 'ASSUMPTION', ref, 'a one-off design is one deal'),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    estimated: { arrangementKey: one.key, tier: price.inferred?.tier ?? one.value.tier, observations: price.inferred?.observations ?? one.value.observations, ...(transfer ? { transfer } : {}), ...(invented ? { invented: true } : {}) },
  };
}

/**
 * A design Brain's reasoning model invented (S-11), composed by the one
 * construction path, as a model candidate — or the reason it cannot be one.
 *
 * Where its reconstruction holds what *these* buyers paid, it enters exactly
 * as an estimated arrangement does. Otherwise nothing establishes its price,
 * and it is not given one: it is swept across the prices other buyers in this
 * project are published as paying — MECHANISM bounds, provenance UNKNOWN,
 * never a distribution — so the engine can say what the design would
 * contribute if research found these buyers pay like those, and nothing it
 * contributes can certify a plan (every link is unestablished, `inputEvidence`).
 * With no published price in the project at all, nothing bounds it, and it
 * stays a research question. Nothing the model said is a number here. Pure.
 */
export function inventedFromArrangement(
  one: ConstructedArrangement,
  input: { projectId: string; currency: string; beforeProofCents: number | null; otherPrices: readonly number[] },
): PlannedOpening | { refused: string } {
  if (one.stress.exposure === 'EXCEEDS') return { refused: "its known worst case exceeds the goal's limits" };
  const marketKey = populationMarket(one.demand.ref);
  const estimated = estimatedFromArrangement(one, input);
  if (estimated)
    return { ...estimated, marketKey, opportunity: { ...estimated.opportunity, title: `Invented: ${one.label}`.slice(0, 200) }, estimated: { ...estimated.estimated!, invented: true } };
  const prices = input.otherPrices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (prices.length === 0) return { refused: 'nothing bounds what these buyers pay: the project holds no published price, so the design stays a research question' };
  const low = prices[0]!;
  const high = Math.max(low + 0.01, prices[prices.length - 1]!);
  const p50 = prices[Math.floor(prices.length / 2)]!;
  const price: ModelInput = {
    value: null,
    low,
    high,
    provenance: 'UNKNOWN',
    source: { kind: 'OTHER', ref: `arrangement:${one.key}`, note: 'an invented design: no figure from these buyers' },
    note: `invented design: nothing establishes what these buyers pay; swept ${Math.round(low)}–${Math.round(high)} across the ${prices.length} price(s) other buyers in this project are published as paying (mechanism bounds, not these buyers')`,
    inferred: { tier: 'MECHANISM', justified: false, p10: low, p50, p90: high, observations: prices.length },
  };
  return { ...arrangementOpening(one, input, price, high, null, true), marketKey };
}

/**
 * The composer an exploration hands invented designs to (§101, S-11): reads
 * the construction context once, then composes each design through
 * `composeInvented` and converts it with `inventedFromArrangement`.
 */
export async function inventedDesigner(input: Parameters<typeof inventionContext>[0]): Promise<(spec: InventedDesign) => PlannedOpening | { refused: string }> {
  const ctx = await inventionContext(input);
  const otherPrices = ctx.priced.filter((o) => o.value.kind === 'POINT').map((o) => (o.value as { value: number }).value);
  return (spec) => {
    const made = composeInvented(spec, ctx);
    if ('refused' in made) return made;
    return inventedFromArrangement(made, { projectId: input.projectId, currency: input.currency, beforeProofCents: ctx.limits.capitalBeforeProofCents, otherPrices });
  };
}

/**
 * What a transfer must bridge before its precedent's figures speak for its new
 * buyers (S-12). A design shown working for one buyer is evidence about that
 * buyer: the legal context, the payment terms buyers accept, how long they take
 * to decide, the money the arrangement ties up and how the buyers behave can
 * each differ for another population, and none of them is established for the
 * new one by the precedent. A dimension is bridged only by a sourced
 * adjustment; the constructor records none yet, so every one is unbridged and
 * the estimate's range is widened by the COMPARABLE spread floor.
 */
const Z90 = 1.2816;
export function transferOf(one: Pick<ConstructedArrangement, 'origin' | 'precedent'> & { bridged?: readonly string[] }): { precedent: string; material: string[]; bridged: string[]; unbridged: string[] } | null {
  if (one.origin !== 'TRANSFER' || !one.precedent) return null;
  const bridged = TRANSFER_MATERIAL.filter((d) => one.bridged?.includes(d));
  return { precedent: one.precedent.title, material: [...TRANSFER_MATERIAL], bridged, unbridged: TRANSFER_MATERIAL.filter((d) => !bridged.includes(d)) };
}

/**
 * The cheap quantitative screen an arrangement is ranked by before it may take
 * one of the model's slots (§102's closed form, on one arrangement alone):
 * the cash it would settle by the deadline, from its reconstructed price, the
 * strength of the evidence behind that price, and what it exposes.
 *
 *   * Price is read inside its reconstruction by evidence tier: DIRECT at its
 *     p50, weaker tiers nearer its p10 (`TIER_PRICE_POSITION`). Weaker
 *     evidence never ranks higher (invariant 39).
 *   * Every link nobody has established (reply, close, the deals the market
 *     takes) is read at a conservative quantile of its swept range
 *     (`SCREEN_QUANTILE`), never its middle, so an unknown never ranks higher.
 *     When the money arrives is integrated over its whole swept range.
 *   * A one-off is one deal at the close rate. A repeatable design sells
 *     through the shared outreach's low end over the days its money's delay
 *     leaves, up to what its market takes. Nothing saturates at the remaining
 *     amount before the final cap, so a $9,000 one-off and a $300 repeatable
 *     design are compared on what each settles (lens S, S-1/S-14: the old
 *     score read both as "the whole goal").
 *   * A worst case nobody has bounded keeps `EXPOSURE_WEIGHT` of the reading.
 *
 * `upside` is the same reading at the reconstruction's p90 price, the unknown
 * links still at their conservative quantile: what protects an unusual but
 * promising design is its own reconstructed spread, never an unknown read
 * high. It ranks; the engine decides. Pure.
 */
export const SCREEN_QUANTILE = 0.25;
export const TIER_PRICE_POSITION: Record<string, number> = { DIRECT: 1, COMPARABLE: 0.75, COMPONENT: 0.5, MECHANISM: 0.25, ASSUMED: 0, UNKNOWN: 0 };
export const EXPOSURE_WEIGHT: Record<string, number> = { SAFE: 1, BOUNDED: 0.9, UNKNOWN: 0.8, EXCEEDS: 0 };
const TIER_RANK: Record<string, number> = { DIRECT: 0, COMPARABLE: 1, COMPONENT: 2, MECHANISM: 3, ASSUMED: 4, UNKNOWN: 5 };
const EXPOSURE_RANK: Record<string, number> = { SAFE: 0, BOUNDED: 1, UNKNOWN: 2, EXCEEDS: 3 };
/** Of the model's arrangement slots, this many are held for the largest reconstructed upside. */
export const UPSIDE_SLOTS = 2;
/** At most this many structurally different designs of one buyer population, sharing one market. */
export const DESIGNS_PER_POPULATION = 3;
/** The next-best arrangements the cut leaves out, kept for a reasoning move that brings one in (§101 INCLUDE). */
export const RESERVE_ARRANGEMENTS = 6;
/** Cut arrangements recorded on the model by name; `cutCount` counts them all. */
export const CUT_RECORDED = 40;

export interface ArrangementScreen {
  /** Expected settled cash by the deadline at the conservative reading, capped at what is still needed. */
  value: number;
  /** The same at the reconstruction's p90 price. */
  upside: number;
  /** In one line, how the figure was read. */
  basis: string;
}

/** An input at the unfavourable quantile of its range when nobody established it; a stated figure as stated. */
function conservative(x: ModelInput): number {
  const lo = x.low ?? x.value ?? 0;
  const hi = x.high ?? x.value ?? lo;
  if (x.value !== null && x.provenance !== 'UNKNOWN') return x.value;
  return lo + SCREEN_QUANTILE * (hi - lo);
}

/** E[max(0, T − d)] and P(d ≤ T) for d uniform over the input's range: selling days left after the money's delay. */
function sellingDays(daysToCash: ModelInput, daysLeft: number): { selling: number; inTime: number } {
  const a = daysToCash.low ?? daysToCash.value ?? 0;
  const b = Math.max(a, daysToCash.high ?? daysToCash.value ?? a);
  if (b - a < 1e-9) return { selling: Math.max(0, daysLeft - a), inTime: daysLeft >= a ? 1 : 0 };
  if (daysLeft <= a) return { selling: 0, inTime: 0 };
  if (daysLeft >= b) return { selling: daysLeft - (a + b) / 2, inTime: 1 };
  return { selling: (daysLeft - a) ** 2 / (2 * (b - a)), inTime: (daysLeft - a) / (b - a) };
}

export function screenArrangement(
  one: ModelledOpportunity,
  arrangement: Pick<ConstructedArrangement, 'value' | 'stress'>,
  input: { remaining: number; daysLeft: number; contactsPerDay: number },
): ArrangementScreen {
  const { p10, p50, p90 } = arrangement.value;
  const position = TIER_PRICE_POSITION[arrangement.value.tier] ?? 0;
  // A transfer's widened range (S-12) is the price it is read on.
  const low = Math.min(p10, one.price.low ?? p10);
  const price = low + position * (p50 - low);
  const close = conservative(one.close);
  const respond = conservative(one.respond);
  const { selling, inTime } = sellingDays(one.daysToCash, input.daysLeft);
  const deals = one.repeatable ? Math.min(conservative(one.volume), input.contactsPerDay * selling * respond * close) : close * inTime;
  const weight = EXPOSURE_WEIGHT[arrangement.stress.exposure] ?? 0;
  const read = (unit: number) => Math.min(input.remaining, Math.max(0, deals * unit * weight));
  return {
    value: read(price),
    upside: read(Math.max(price, p90)),
    basis: `${deals.toFixed(2)} deal(s) × ${Math.round(price)} (${arrangement.value.tier}: ${Math.round(position * 100)}% of the way from p10 to p50) × ${weight} for ${arrangement.stress.exposure.toLowerCase()} exposure; unknown links at their ${Math.round(SCREEN_QUANTILE * 100)}th percentile`,
  };
}

/** A constructed arrangement that did not take one of the model's slots, and why (S-17). */
export interface ArrangementCut {
  arrangementKey: string;
  label: string;
  population: string;
  screen: number | null;
  upside: number | null;
  reason: string;
}
/** A constructed arrangement that did, and which slot it took. */
export interface ArrangementPick {
  arrangementKey: string;
  label: string;
  population: string;
  screen: number;
  upside: number;
  /** `STRUCTURE:<base>` or `PAID:<funding>/<repeat>` (the strongest of its kind), `UPSIDE`, or `SCREEN`. */
  slot: string;
  basis: string;
}
export interface ArrangementSelection {
  /** Constructed arrangements read. */
  considered: number;
  picked: ArrangementPick[];
  /** The strongest cut ones first, at most `CUT_RECORDED`. */
  cut: ArrangementCut[];
  cutCount: number;
}

const designKey = (a: ConstructedArrangement) => `${a.design.base}/${a.design.funding}/${a.design.aggregation}/${a.design.repeat}`;
const paidKey = (a: ConstructedArrangement) => `${a.design.funding}/${a.design.repeat}`;
/** The market every design over one buyer population shares in the engine. */
export const populationMarket = (population: string) => `${ARRANGEMENT_ID_PREFIX}market:${population}`;

/**
 * Which constructed arrangements enter the model, and why the rest do not.
 *
 * Production (lens S, 2026-11-14): every repeatable design scored exactly the
 * remaining amount and the tie broke on the opportunity id — a sha256 of the
 * key — so which 12 of up to 404 designs a plan could ever use was a coin
 * flip, and a strong DIRECT design the engine preferred was routinely cut,
 * after which no later stage could bring it back. Now:
 *
 *   1. every candidate is screened quantitatively (`screenArrangement`) and
 *      ordered by that reading, then evidence tier, observations, exposure and
 *      the constructor's own order — never by id;
 *   2. each base structure, then each way of being paid (funding × repeat),
 *      keeps its strongest design, so genuinely different strategies are not
 *      crowded out by many variants of one;
 *   3. `UPSIDE_SLOTS` go to the largest reconstructed upside not yet held;
 *   4. the rest fill by the screen;
 *
 * and up to `DESIGNS_PER_POPULATION` structurally different designs of one
 * buyer population may enter, all on one `marketKey`, so the engine chooses
 * the design and never sums the same buyers twice. Every cut arrangement is
 * recorded with its reading and its reason, and the next-best few are kept as
 * a reserve a reasoning move may bring in (§101). Deterministic. Pure.
 */
export function selectEstimatedArrangements(
  arrangements: readonly ConstructedArrangement[],
  input: {
    projectId: string;
    currency: string;
    beforeProofCents: number | null;
    remaining: number;
    exclusions: Parameters<typeof excludedBy>[1];
    limit?: number;
    daysLeft?: number | null;
    contactsPerDay?: number;
  },
): { openings: PlannedOpening[]; reserve: PlannedOpening[]; selection: ArrangementSelection } {
  const limit = input.limit ?? MAX_ESTIMATED_ARRANGEMENTS;
  const daysLeft = input.daysLeft && input.daysLeft > 0 ? input.daysLeft : 30;
  const contactsPerDay = input.contactsPerDay ?? CONTACTS_PER_DAY_BOUNDS.low;
  const cut: ArrangementCut[] = [];
  type Row = { arrangement: ConstructedArrangement; one: PlannedOpening; screen: ArrangementScreen; order: number; population: string };
  const rows: Row[] = [];
  arrangements.forEach((arrangement, order) => {
    const population = arrangement.demand.ref;
    const no = (reason: string) => cut.push({ arrangementKey: arrangement.key, label: arrangement.label, population, screen: null, upside: null, reason });
    // Judged on what the arrangement is — its label, sector and buyer — never on its research question,
    // which carries Brain's own instructions ("leave out government contracts", "the owner does no
    // physical work") and so matched every exclusion: production read 0 of 404 (2026-11-06).
    const what = `${arrangement.label} ${arrangement.sector ?? ''} ${arrangement.demand.name}`;
    if (excludedBy(what, input.exclusions)) return no("the goal's owner excluded what it is");
    if (breaksOperatingModel(operatingFit({ title: arrangement.label, offerScope: arrangement.demand.name }))) return no('it breaks the operating model');
    const one = estimatedFromArrangement(arrangement, input);
    if (!one) return no(arrangement.stress.exposure === 'EXCEEDS' ? 'its known worst case exceeds the limits' : 'nothing reconstructs its value');
    // One buyer population is one market however many designs reach it: the engine caps their deals together.
    const planned: PlannedOpening = { ...one, marketKey: populationMarket(population) };
    rows.push({ arrangement, one: planned, screen: screenArrangement(one, arrangement, { remaining: input.remaining, daysLeft, contactsPerDay }), order, population });
  });
  const byScreen = (a: Row, b: Row) =>
    b.screen.value - a.screen.value ||
    (TIER_RANK[a.arrangement.value.tier] ?? 9) - (TIER_RANK[b.arrangement.value.tier] ?? 9) ||
    b.arrangement.value.observations - a.arrangement.value.observations ||
    (EXPOSURE_RANK[a.arrangement.stress.exposure] ?? 9) - (EXPOSURE_RANK[b.arrangement.stress.exposure] ?? 9) ||
    a.order - b.order;
  rows.sort(byScreen);
  // The same design over the same buyers is one estimate: only its strongest reading competes.
  const designs = new Set<string>();
  const candidates = rows.filter((r) => {
    const key = `${r.population}|${designKey(r.arrangement)}`;
    if (!designs.has(key)) {
      designs.add(key);
      return true;
    }
    cut.push({ arrangementKey: r.arrangement.key, label: r.arrangement.label, population: r.population, screen: r.screen.value, upside: r.screen.upside, reason: 'the same design over the same buyers is already read' });
    return false;
  });
  const taken = new Map<Row, string>();
  const perPopulation = new Map<string, number>();
  const take = (r: Row, slot: string): boolean => {
    if (taken.has(r) || taken.size >= limit) return false;
    if ((perPopulation.get(r.population) ?? 0) >= DESIGNS_PER_POPULATION) return false;
    taken.set(r, slot);
    perPopulation.set(r.population, (perPopulation.get(r.population) ?? 0) + 1);
    return true;
  };
  // 2. One design per kind first, leaving the upside slots free.
  const diversityRoom = Math.max(0, limit - UPSIDE_SLOTS);
  const kinds: Array<[string, (a: ConstructedArrangement) => string]> = [
    ['STRUCTURE', (a) => a.design.base],
    ['PAID', paidKey],
  ];
  for (const [name, keyOf] of kinds) {
    const held = new Set([...taken.keys()].map((r) => keyOf(r.arrangement)));
    for (const r of candidates) {
      if (taken.size >= diversityRoom) break;
      const k = keyOf(r.arrangement);
      if (held.has(k) || r.screen.value <= 0) continue;
      if (take(r, `${name}:${k}`)) held.add(k);
    }
  }
  // 3. The largest reconstructed upside not yet held.
  let upsideTaken = 0;
  for (const r of candidates.filter((x) => !taken.has(x) && x.screen.upside > 0).sort((a, b) => b.screen.upside - a.screen.upside || byScreen(a, b))) {
    if (upsideTaken >= UPSIDE_SLOTS) break;
    if (take(r, 'UPSIDE')) upsideTaken++;
  }
  // 4. The rest by the screen.
  for (const r of candidates) {
    if (taken.size >= limit) break;
    if (r.screen.value > 0) take(r, 'SCREEN');
  }
  const picked = candidates.filter((r) => taken.has(r));
  const weakest = picked.length ? Math.min(...picked.map((r) => r.screen.value)) : 0;
  const left = candidates.filter((r) => !taken.has(r));
  for (const r of left)
    cut.push({
      arrangementKey: r.arrangement.key,
      label: r.arrangement.label,
      population: r.population,
      screen: r.screen.value,
      upside: r.screen.upside,
      reason:
        (perPopulation.get(r.population) ?? 0) >= DESIGNS_PER_POPULATION
          ? `its buyers already have ${DESIGNS_PER_POPULATION} designs in the model`
          : r.screen.value <= 0
            ? 'it settles nothing by the deadline at the conservative reading'
            : `below the cut: screens ${Math.round(r.screen.value)} against ${Math.round(weakest)} for the weakest of the ${picked.length} kept`,
    });
  cut.sort((a, b) => (b.screen ?? -1) - (a.screen ?? -1) || a.arrangementKey.localeCompare(b.arrangementKey));
  return {
    openings: picked.map((r) => r.one),
    reserve: left.filter((r) => r.screen.value > 0).slice(0, RESERVE_ARRANGEMENTS).map((r) => r.one),
    selection: {
      considered: arrangements.length,
      picked: picked.map((r) => ({ arrangementKey: r.arrangement.key, label: r.arrangement.label, population: r.population, screen: r.screen.value, upside: r.screen.upside, slot: taken.get(r)!, basis: r.screen.basis })),
      cut: cut.slice(0, CUT_RECORDED),
      cutCount: cut.length,
    },
  };
}

/** The arrangements `selectEstimatedArrangements` keeps, strongest screen first. */
export function pickEstimatedArrangements(arrangements: readonly ConstructedArrangement[], input: Parameters<typeof selectEstimatedArrangements>[1]): PlannedOpening[] {
  return selectEstimatedArrangements(arrangements, input).openings;
}

/**
 * Whether the opening is won by competing for an award. Read from the words
 * that name what it is — the title, the source and the published signal — and
 * deliberately narrow: a missed one is treated like any other opening, and a
 * wrong one only ranks lower and keeps Brain looking.
 */
export const COMPETITIVE_AWARD = /\b(rfp|rfq|rfi|rfx|tender|solicitation|bids?|bidding|grants?|cooperative agreements?|procurement|sam\.gov|notice of funding|funding opportunity|nofo)\b/i;

export function isCompetitiveAward(o: { title: string; source: string | null; buyingSignal: string | null; offerScope?: string | null }): boolean {
  return COMPETITIVE_AWARD.test([o.title, o.source, o.buyingSignal].filter(Boolean).join(' '));
}

export interface GoalModel {
  definition: ScenarioModelDefinition;
  included: ModelledOpportunity[];
  excluded: { opportunityId: string; title: string; reason: string }[];
  /**
   * Every opening that could be read at all, modelled or not. The engine fits
   * a few into one simulation; the gate still judges every one of these on
   * its own evidence, so the engine's limit never limits what Brain considers.
   */
  considered: ModelledOpportunity[];
  /** The constructed arrangements entered on their estimates (§82), for the reasoning loop (§93). */
  estimates?: ModelledOpportunity[];
  /** Which constructed arrangements took the estimate slots, by what reading, and every one cut with its reason (S-17). */
  arrangementSelection?: ArrangementSelection | null;
  /** Why nothing could be modelled, when nothing could. */
  refusal: string | null;
  /**
   * The quant engine's combined reading over every modelled opening: demand
   * estimated world by world and the combination most likely to reach the
   * target (`goals/portfolio.ts`). It decides which openings take the
   * simulation's slots. Null when nothing could be modelled.
   */
  portfolio: GoalPortfolio | null;
  /** Exactly what the portfolio was evaluated on, so a reconstruction (§99) re-reads the same plan. */
  portfolioInput?: Parameters<typeof evaluateGoalPortfolio>[0] | null;
}

function kindToProvenance(fact: CashCardFact | null): { provenance: VariableProvenance; source: SourceRef | null } {
  if (!fact) return { provenance: 'UNKNOWN', source: null };
  if (fact.kind === 'EVIDENCE') return { provenance: 'EVIDENCE', source: fact.claimId ? { kind: 'CLAIM', ref: fact.claimId } : { kind: 'CARD_FACT', ref: fact.id } };
  return { provenance: 'ASSUMPTION', source: { kind: 'CARD_FACT', ref: fact.id, note: fact.kind === 'PERSON' ? 'a person said so' : "Brain's proposal" } };
}

function known(value: number, provenance: VariableProvenance, source: SourceRef | null, note: string): ModelInput {
  return { value, low: value, high: value, provenance, source, note };
}

function unknown(low: number, high: number, note: string): ModelInput {
  return { value: null, low, high, provenance: 'UNKNOWN', source: null, note };
}

/**
 * An unknown, inferred from what the project already holds — or the blind
 * fallback range when nothing bears on it. `scale` turns a share of the price
 * into money at this opening's price.
 */
function inferOr(knowledge: CashKnowledge | null, quantity: CashQuantity, opportunity: CashOpportunity, now: Date, fallback: ModelInput, scale = 1, what = ''): ModelInput {
  if (!knowledge) return fallback;
  let est: Estimate | null = null;
  try {
    est = inferCashQuantity(knowledge, quantity, opportunity, now);
  } catch {
    est = null;
  }
  if (!est) return fallback;
  return estimateInput(est, scale, what);
}

/**
 * A reconstructed estimate as a model input: the one conversion every caller
 * uses, so the evidence it carries (tier, observations, and the sample the
 * assurance redraws from, Q2-1/Q2-12) is never dropped by a hand-built copy.
 */
export function estimateInput(est: Estimate, scale = 1, what = ''): ModelInput {
  const scaled: Estimate = scale === 1 ? est : { ...est, p05: est.p05 * scale, p10: est.p10 * scale, p50: est.p50 * scale, p90: est.p90 * scale, p95: est.p95 * scale, samples: est.samples.map((x) => x * scale) };
  const exported = toScenarioInput(scaled);
  return {
    value: null,
    low: scaled.p05,
    high: scaled.p95,
    provenance: exported.provenance,
    source: exported.sources[0] ?? null,
    note: `inferred${what}: ${exported.note}`,
    distribution: exported.spec,
    inferred: { tier: est.tier, justified: exported.provenance === 'EVIDENCE', p10: scaled.p10, p50: scaled.p50, p90: scaled.p90, observations: est.used.length, ...inputSample(est) },
  };
}

/** Wilson score interval for a rate measured as successes out of trials. */
export function wilson(successes: number, trials: number, z = 1.96): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/** Everything the model needs to know about one opportunity, read from its rows. */
async function modelOpportunity(
  opportunity: CashOpportunity,
  index: number,
  tier: string,
  currency: string,
  lessons: Awaited<ReturnType<typeof cashOutcomeLessons>>,
  knowledge: CashKnowledge | null = null,
  now: Date = new Date(),
  windowDays = 30,
): Promise<ModelledOpportunity | { reason: string }> {
  const fact = await cardFactMap(opportunity.id, opportunity.projectId ?? undefined);
  const ref: SourceRef = { kind: 'CASH_OPPORTUNITY', ref: opportunity.id };

  // Price: the column, else the low end of a published revenue range.
  let price: ModelInput | null = null;
  if (opportunity.priceCents !== null && opportunity.priceCents > 0) {
    const p = kindToProvenance(fact('price'));
    price = known(opportunity.priceCents / 100, p.provenance === 'UNKNOWN' ? 'ASSUMPTION' : p.provenance, p.source ?? ref, 'the price on the card');
  } else {
    const range = fact('revenueRange');
    const figures = range ? readMoneyFigures(range.value, currency).filter((one) => !one.perUnit) : [];
    if (range && figures.length > 0) {
      const values = figures.map((one) => one.cents / 100).sort((a, b) => a - b);
      const p = kindToProvenance(range);
      price = { value: null, low: values[0]!, high: values[values.length - 1]!, provenance: p.provenance, source: p.source, note: 'the revenue range the sources state' };
    }
  }
  if (!price) return { reason: 'no price on the card and no published revenue figure: research the price first' };
  const top = price.high ?? price.value ?? 0;

  const exposure = fact('exposure');
  // Research answers "how much goes out before any comes back" as requiredCapital.
  const capitalFact = fact('requiredCapital');
  const capitalFigures = capitalFact ? readMoneyFigures(capitalFact.value, currency).filter((one) => !one.perUnit) : [];
  const capital =
    opportunity.peakFundingCents !== null
      ? known(opportunity.peakFundingCents / 100, kindToProvenance(exposure).provenance === 'UNKNOWN' ? 'ASSUMPTION' : kindToProvenance(exposure).provenance, kindToProvenance(exposure).source ?? ref, 'money tied up before it pays')
      : capitalFigures.length > 0
        ? known(Math.max(...capitalFigures.map((one) => one.cents)) / 100, kindToProvenance(capitalFact).provenance, kindToProvenance(capitalFact).source, 'the most that goes out before any comes back')
        : inferOr(knowledge, 'capitalShare', opportunity, now, unknown(0, top, 'nobody has established the money tied up; swept from nothing to the whole price'), top, ' as a share of the top price');

  const hoursFact = fact('hours');
  const hours =
    opportunity.humanHours !== null
      ? known(opportunity.humanHours, hoursFact ? kindToProvenance(hoursFact).provenance : 'ASSUMPTION', ref, 'hours of work per deal')
      : unknown(1, 40, 'nobody has established the hours; swept from 1 to 40 per deal');

  const ttc = fact('timeToFirstCash');
  const ttcDays = ttc ? readDays(ttc.value) : null;
  const daysToCash =
    ttcDays !== null
      ? known(ttcDays, kindToProvenance(ttc).provenance, kindToProvenance(ttc).source, 'days from start to usable cash')
      : inferOr(knowledge, 'daysToCash', opportunity, now, unknown(3, 60, 'nobody has established when the money would settle; swept from 3 to 60 days'));

  const costFact = fact('directCosts');
  const costFigures = costFact ? readMoneyFigures(costFact.value, currency).filter((one) => !one.perUnit) : [];
  const directCost =
    costFigures.length > 0
      ? known(Math.max(...costFigures.map((one) => one.cents)) / 100, kindToProvenance(costFact).provenance, kindToProvenance(costFact).source, 'the highest published direct cost')
      : inferOr(knowledge, 'costShare', opportunity, now, unknown(0, Math.max(1, top * 0.6), 'nobody has established the direct cost; swept from nothing to 60% of the price'), top, ' as a share of the top price');

  const agreements = (await agreementsFor(opportunity.id, opportunity.projectId ?? undefined)).filter((one) => !one.releasedAt);
  const lesson = lessons.find((one) => one.mechanism === opportunity.mechanism && one.contacts >= LESSON_MIN_SAMPLE);
  // An agreement is one buyer's yes, and is counted as that money — never as a
  // rate the next buyer will match. More buyers need a measured rate of their own.
  let close: ModelInput;
  if (lesson) {
    // Brain's own record carries its counts, so the assurance reads it as a
    // sized sample (Surge B, Q2-4 follow-up), not as bounds without a size.
    close = {
      ...measuredRateInput({ trials: lesson.contacts, low: lesson.agreements, high: lesson.agreements }),
      provenance: 'HISTORICAL',
      source: { kind: 'OTHER', ref: `cash_outcomes:${opportunity.mechanism}`, note: `${lesson.agreements} agreements from ${lesson.contacts} contacts` },
      note: `measured on this Brain: ${lesson.agreements} of ${lesson.contacts} contacts agreed`,
    };
  } else {
    close = inferOr(knowledge, 'close', opportunity, now, unknown(0.02, 0.5, 'no buyer has been asked yet; swept from 2% to 50% of buyers agreeing'));
  }
  // Agreements per contact already include whether the contact replied.
  const respond: ModelInput = lesson
    ? known(1, 'HISTORICAL', close.source, 'the measured rate is agreements per contact, which includes replying')
    : inferOr(knowledge, 'respond', opportunity, now, unknown(0.002, 0.15, 'nobody has established how many prospects of this kind reply; swept from 0.2% to 15%'));

  const volumeFact = fact('buyerVolume');
  const volumeRead = volumeFact ? readVolume(volumeFact.value, windowDays) : null;
  /*
   * Repeatable is a fact about the market, not a category: a test-first play
   * is one by construction, and any other opening becomes one when research
   * establishes more than one deal inside the window. Nothing else may assume
   * a second sale.
   */
  /*
   * An estimate of repeat volume with a stated basis (Brain's RECOMMENDATION)
   * also makes an opening repeatable — but only as a range from one deal up to
   * the estimate, never as the estimate itself, and volume stays an
   * unestablished link. Production, 2026-11-06: requiring a sourced count before
   * a second sale could even be modelled made every opening a one-off, so the
   * plan was a heap of single small deals however much repeat business existed.
   */
  const estimatedRepeat = volumeRead !== null && volumeRead.deals > 1 && volumeFact!.kind === 'RECOMMENDATION';
  const repeatable = isTestFirstPlay(opportunity) || (volumeRead !== null && volumeRead.deals > 1 && volumeFact!.kind === 'EVIDENCE') || estimatedRepeat;
  const volume: ModelInput = !repeatable
    ? known(1, 'ASSUMPTION', ref, 'a one-off opening is one deal')
    : estimatedRepeat
      ? unknown(1, Math.min(MAX_BUYERS_OFFERED, volumeRead!.deals), `estimated, not established: ${volumeRead!.basis}; swept from 1 deal to the estimate`)
    : volumeRead && volumeFact
      ? known(volumeRead.deals, kindToProvenance(volumeFact).provenance, kindToProvenance(volumeFact).source, volumeRead.basis)
      : unknown(1, MAX_BUYERS_OFFERED, volumeFact
        ? 'the volume on the card states no count of buyers or orders; swept from 1 deal to the most a strategy offers'
        : 'nobody has established how many buyers exist or how often they buy; swept from 1 deal to the most a strategy offers');

  const fulfilmentFact = fact('fulfillment');
  const fulfilledBy =
    fulfilmentFact && fulfilmentFact.kind !== 'RECOMMENDATION' && opportunity.fulfillmentOwner
      ? { value: opportunity.fulfillmentOwner, ...kindToProvenance(fulfilmentFact) }
      : null;

  return {
    opportunity,
    index,
    tier,
    repeatable,
    price,
    capital,
    hours,
    daysToCash,
    close,
    respond,
    directCost,
    volume,
    agreed: agreements.length > 0,
    agreedValue: agreements.reduce((sum, one) => sum + one.amountCents, 0) / 100,
    agreedDeals: agreements.length,
    fulfilledBy,
    competitiveAward: agreements.length === 0 && isCompetitiveAward(opportunity),
  };
}

/**
 * The most this opening could put toward the goal inside the window, from
 * what is known: its agreed money, or its top price times the deals a
 * repeatable play could take, or one deal. Zero when it is known to settle too
 * late. A ranking key only — it is never shown as a forecast.
 */
/** A price buyers are shown to pay — a source or this Brain's own record — rather than a guess. */
export function priceSupported(one: Pick<ModelledOpportunity, 'price'>): boolean {
  return !one.price.inferred && (one.price.provenance === 'EVIDENCE' || one.price.provenance === 'HISTORICAL');
}

/** How many of an opening's money facts rest on a source or a measurement rather than a guess. */
export function evidenceCount(one: ModelledOpportunity): number {
  return [one.price, one.close, one.daysToCash, one.directCost, one.capital, one.hours].filter(
    (input) => !input.inferred && (input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL'),
  ).length;
}

/** Whether research has established how many deals the market can take. */
export function volumeEstablished(one: Pick<ModelledOpportunity, 'volume' | 'repeatable'>): boolean {
  return !one.repeatable || (one.volume.value !== null && (one.volume.provenance === 'EVIDENCE' || one.volume.provenance === 'HISTORICAL'));
}

/**
 * `established` counts a repeatable play's deals only up to the volume research
 * established — one deal when nobody has — so a supported reach never rests on
 * buyers nobody has shown exist. Without it the reach is the most the opening
 * could be worth if research confirms the volume.
 */
export function bestCaseReach(one: ModelledOpportunity, remaining: number, daysLeft: number, established = false): number {
  const late = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && one.daysToCash.value > daysLeft;
  if (late) return 0;
  // An award nobody has shown pays inside the window does not count as reach:
  // first it must be won, then delivered, then paid on the buyer's terms.
  if (one.competitiveAward && !(one.daysToCash.provenance === 'EVIDENCE' || one.daysToCash.provenance === 'HISTORICAL')) return 0;
  const price = one.price.high ?? one.price.value ?? 0;
  let deals = one.repeatable ? Math.min(MAX_BUYERS_OFFERED, Math.ceil(remaining / Math.max(1, price))) : one.agreedValue > 0 ? 0 : 1;
  if (established && one.repeatable) deals = Math.min(deals, volumeEstablished(one) ? one.volume.value ?? 1 : 1);
  return Math.min(remaining, one.agreedValue + deals * price);
}

function variable(key: string, label: string, unit: string, input: ModelInput): ScenarioVariable {
  const spec: VariableSpec =
    input.value !== null
      ? { kind: 'FIXED' as const, value: input.value }
      : input.distribution
        ? input.distribution
        : { kind: 'RANGE' as const, min: input.low ?? 0, max: Math.max(input.high ?? 0, (input.low ?? 0) + 1e-9) };
  return {
    key,
    label,
    unit,
    provenance: input.provenance,
    controllable: false,
    spec,
    sources: input.source ? [input.source] : [],
    note: input.note,
  };
}

/** Compose the model, or say exactly why there is nothing to model. */
export async function composeGoalModel(input: { goal: Workstream; target: TargetReading; now?: Date; arrangements?: readonly ConstructedArrangement[] }): Promise<GoalModel> {
  const { goal, target } = input;
  const excluded: GoalModel['excluded'] = [];
  const candidates: ModelledOpportunity[] = [];
  const refuse = (refusal: string): GoalModel => ({
    definition: { title: goal.title, currency: target.currency, horizon: 'until the goal is due', variables: [], lines: [], strategies: [] },
    included: [],
    excluded,
    considered: candidates,
    refusal,
    portfolio: null,
  });
  if (target.daysLeft === null) return refuse('The goal has no due date, so there is no window to count money inside. Set one with `goals terms --due`.');
  if (target.daysLeft <= 0) return refuse('The goal is past its due date.');
  if (target.achieved) return refuse('The target is already met.');

  const trace = planTrace('compose');
  // The goal plan owns the freshness bar; read lazily, because the plan imports this module.
  const freshDays = (await import('../goals/plan.ts')).RECOMMENDATION_POLICY.demandFreshDays;
  const frontier = await sharedFrontier({ projectId: target.projectId });
  trace(`shared frontier: ${frontier.opportunities.length} opening(s)`);
  const tierOf = new Map(frontier.opportunities.map((one) => [one.id, one.tier.tier as string]));
  const live = (await listOpportunities({ projectId: target.projectId })).filter(
    (one) => LIVE.has(one.state) && !one.duplicateOfId && one.currency === target.currency,
  );
  const ordered = live.sort((a, b) => {
    const fa = IN_FLIGHT.has(a.state) ? 0 : 1;
    const fb = IN_FLIGHT.has(b.state) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ta = TIER_ORDER[tierOf.get(a.id) ?? 'SIGNAL'] ?? 3;
    const tb = TIER_ORDER[tierOf.get(b.id) ?? 'SIGNAL'] ?? 3;
    if (ta !== tb) return ta - tb;
    const pa = a.priceCents !== null ? 0 : 1;
    const pb = b.priceCents !== null ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.createdAt.localeCompare(a.createdAt);
  });

  trace(`live openings: ${live.length}`);
  const lessons = await cashOutcomeLessons(target.projectId);
  trace('outcome lessons');
  // What the project already established about other openings, for inference.
  let knowledge: CashKnowledge | null = null;
  try {
    knowledge = await loadCashKnowledge(target.projectId);
  } catch {
    knowledge = null;
  }
  trace('cash knowledge');
  const included: ModelledOpportunity[] = [];
  // What the goal's owner said to leave out (§82): an excluded opening takes no slot, and says why.
  const exclusions = await goalExclusions(input.goal);
  for (const opportunity of ordered) {
    const tier = tierOf.get(opportunity.id) ?? 'SIGNAL';
    // A harvested opening's title is its structured name; what the source said
    // it is lives in its buying signal, so both are what the opening is.
    const excludedClass = IN_FLIGHT.has(opportunity.state) ? null : excludedBy(`${opportunity.title} ${opportunity.buyingSignal ?? ''} ${opportunity.payer ?? ''} ${opportunity.industry ?? ''}`, exclusions);
    if (excludedClass) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `left out by the goal: ${EXCLUSION_CLASSES[excludedClass].label}` });
      continue;
    }
    // The standing operating rule: a plan never rests on the owner's physical work.
    const fit = operatingFit(operatingFactsOf({ ...opportunity, title: [opportunity.title, opportunity.buyingSignal].filter(Boolean).join(' \n ') }));
    if (breaksOperatingModel(fit)) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `needs the owner's physical work: ${fit.because}` });
      continue;
    }
    if (tier === 'SIGNAL' && !IN_FLIGHT.has(opportunity.state)) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: 'evidence only: nobody has shown who would pay us' });
      continue;
    }
    // A closed opening can contribute nothing, so it must not take one of the
    // few slots a better one needs. Production, 2026-10-28: all four slots
    // went to auctions and a notice that had already closed, and the plan read
    // NOT_VIABLE for that reason alone.
    if (opportunity.expiresAt && Date.parse(opportunity.expiresAt) < (input.now ?? new Date()).getTime()) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `closed on ${opportunity.expiresAt.slice(0, 10)}` });
      continue;
    }
    const modelled = await modelOpportunity(opportunity, 0, tier, target.currency, lessons, knowledge, input.now ?? new Date(), target.daysLeft);
    trace(`modelled ${opportunity.id}`);
    if ('reason' in modelled) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: modelled.reason });
      continue;
    }
    // An observation with no end of its own is "now" only while it is fresh: a
    // one-off resale price seen in April contributes nothing in November.
    // Openings filed before the harvest gave such observations an expiry carry
    // none, so the age of the observation itself decides. A repeatable play is
    // a pattern rather than a moment, and work under way is not an observation.
    const observedMs = opportunity.signalObservedAt ? Date.parse(opportunity.signalObservedAt) : Number.NaN;
    if (
      !opportunity.expiresAt &&
      !Number.isNaN(observedMs) &&
      !IN_FLIGHT.has(opportunity.state) &&
      !modelled.repeatable &&
      !modelled.agreed &&
      (input.now ?? new Date()).getTime() - observedMs > freshDays * 86_400_000
    ) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `signal older than ${freshDays} days (seen ${opportunity.signalObservedAt!.slice(0, 10)})` });
      continue;
    }
    candidates.push(modelled);
  }
  /*
   * Constructed arrangements compete in the same portfolio on their
   * reconstructed estimates (owner, 2026-11-06). Before, they reached the plan
   * only after a research round filed an opening for them, so hundreds of
   * designs were never compared with the small openings that happened to be
   * found, and the plan was a heap of one-offs. They enter the quant
   * portfolio — the comparison of contribution that directs research — and
   * never the gate's slots: an estimate cannot displace an evidenced strategy
   * or be judged as an opening anybody found.
   */
  const estimates: ModelledOpportunity[] = [];
  let arrangementSelection: ArrangementSelection | null = null;
  let reserve: PlannedOpening[] = [];
  if (input.arrangements?.length) {
    const selected = selectEstimatedArrangements(input.arrangements, {
      projectId: target.projectId,
      currency: target.currency,
      beforeProofCents: target.capitalBeforeProofCents,
      remaining: target.remainingCents / 100,
      exclusions,
      daysLeft: target.daysLeft,
    });
    estimates.push(...selected.openings);
    arrangementSelection = selected.selection;
    reserve = selected.reserve;
    trace(`estimated arrangements: ${selected.openings.length} of ${input.arrangements.length} (${selected.selection.cutCount} cut, ${reserve.length} in reserve)`);
  }
  /*
   * Which openings take the engine's few slots is decided by what each could
   * put toward *this* goal, not by how far along it is. Production,
   * 2026-10-28: the slots went to the four "closest to a decision" — a $2.50
   * auction among them — and the plan could reach $415 of $10,000 however it
   * combined them. Money already agreed and work already under way come first,
   * then the largest reach inside the window, then the evidence tier.
   */
  const remainingMajor = target.remainingCents / 100;
  /*
   * The quant engine reads every modelled opening first (§79, owner
   * 2026-11-03): its demand estimate and the combination most likely to reach
   * the target decide which openings take the simulation's slots — members of
   * that combination first, then each by the cash its own demand settles.
   */
  let portfolio: GoalPortfolio | null = null;
  let portfolioInput: Parameters<typeof evaluateGoalPortfolio>[0] | null = null;
  if (candidates.length + estimates.length > 0) {
    portfolioInput = {
      openings: [...candidates, ...estimates],
      remaining: remainingMajor,
      daysLeft: target.daysLeft,
      capitalCeiling: target.capitalCeilingCents === null ? null : target.capitalCeilingCents / 100,
      beforeProof: target.capitalBeforeProofCents === null ? null : target.capitalBeforeProofCents / 100,
      perWeek: target.capitalPerWeekCents === null ? null : target.capitalPerWeekCents / 100,
      resources: target.resources,
      measuredCapacity: await instantlyCapacity().catch(() => null),
      measuredRates: await instantlyMeasuredRates().catch(() => null),
      /*
       * The knowledge this compose already read for the project, passed
       * explicitly (CAUSAL-14-7, review F4-2): left out, the portfolio fell back
       * to the module cache, so whether an opening's market history was acquired
       * depended on whether that cache was still warm. Null means the project's
       * evidence could not be read, reported as a research need, never guessed.
       */
      knowledge,
      // The next-best cut arrangements: never evaluated here, offered to the reasoning loop's INCLUDE move (§101, S-6).
      ...(reserve.length ? { reserve } : {}),
    };
    /*
     * The baseline evaluation is the same synchronous engine §101 moved onto worker threads:
     * run inline here it held the server's loop for seconds at a time (production, 2026-11-13:
     * 8–24 s event-loop stalls, ~20 s of CPU a minute in the quant engine, every database
     * socket and MCP call behind it timing out). On the shared pool it runs beside the loop;
     * the pool falls back to inline, yielding first, when it has no thread.
     */
    const { sharedEvaluator } = await import('../goals/reasoning/evaluatorPool.ts');
    const evaluator = sharedEvaluator();
    try {
      portfolio = await evaluator.evaluate(portfolioInput);
    } finally {
      await evaluator.close();
    }
    trace('quant portfolio');
  }
  const inBest = new Set(portfolio?.best?.members.map((one) => one.opportunityId) ?? []);
  const demandP50 = new Map((portfolio?.demand ?? []).map((one) => [one.opportunityId, one.refused ? -1 : one.revenue.p50]));
  candidates.sort(
    (a, b) =>
      (IN_FLIGHT.has(a.opportunity.state) || a.agreed ? 0 : 1) - (IN_FLIGHT.has(b.opportunity.state) || b.agreed ? 0 : 1) ||
      Number(inBest.has(b.opportunity.id)) - Number(inBest.has(a.opportunity.id)) ||
      (demandP50.get(b.opportunity.id) ?? 0) - (demandP50.get(a.opportunity.id) ?? 0) ||
      Number(a.competitiveAward) - Number(b.competitiveAward) ||
      // Reach at a price buyers are shown to pay comes before reach at a guess.
      (priceSupported(b) ? bestCaseReach(b, remainingMajor, target.daysLeft!, true) : 0) -
        (priceSupported(a) ? bestCaseReach(a, remainingMajor, target.daysLeft!, true) : 0) ||
      evidenceCount(b) - evidenceCount(a) ||
      bestCaseReach(b, remainingMajor, target.daysLeft!) - bestCaseReach(a, remainingMajor, target.daysLeft!) ||
      (TIER_ORDER[a.tier] ?? 3) - (TIER_ORDER[b.tier] ?? 3),
  );
  for (const one of candidates) {
    if (included.length >= MAX_MODEL_OPPORTUNITIES) {
      excluded.push({ opportunityId: one.opportunity.id, title: one.opportunity.title, reason: `the engine fits ${MAX_MODEL_OPPORTUNITIES} openings in one model and ${included.length} could reach more of this goal` });
      continue;
    }
    included.push({ ...one, index: included.length + 1 });
  }
  if (included.length === 0) {
    // Nothing found can be modelled; the portfolio of estimates still says where research would move the goal.
    return {
      ...refuse(
        live.length === 0
          ? 'There is no live opportunity in this project to build a plan from.'
          : 'No live opportunity is far enough along to model: each one is evidence only or has no price anywhere.',
      ),
      portfolio,
      portfolioInput,
      estimates,
      arrangementSelection,
    };
  }

  const variables: ScenarioVariable[] = [
    variable('remaining', 'Still needed to reach the target', target.currency, known(target.remainingCents / 100, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}`, note: 'target less what the ledger shows' }, 'target less the ledger')),
    variable('days_left', 'Days until the goal is due', 'days', known(target.daysLeft, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}` }, 'the goal row')),
    variable(
      'hours_available',
      'Working hours available before the deadline',
      'hours',
      target.hoursCeiling !== null
        ? known(target.hoursCeiling, 'EVIDENCE', { kind: 'PERSON', ref: `workstream:${goal.id}` }, 'the hours a person set')
        : unknown(20, 160, 'nobody has said how many hours are available; swept from 20 to 160'),
    ),
  ];
  /*
   * Capital is the goal's own, never a global default. When the owner has said
   * how much may be committed, that is the ceiling. When nobody has said, there
   * is no ceiling to break — the model reports how much each strategy ties up,
   * and the gate asks the owner, rather than reading the ledger's deployable
   * cash (often zero) as a decision nobody made. Permission to spend is still
   * the commercial authority's either way.
   */
  if (target.capitalCeilingCents !== null) {
    variables.push(
      variable('capital_ceiling', 'Money the owner said this goal may commit', target.currency, known(target.capitalCeilingCents / 100, 'EVIDENCE', { kind: 'PERSON', ref: `workstream:${goal.id}`, note: 'the ceiling a person set' }, 'the ceiling a person set')),
    );
  }
  const derived: NonNullable<ScenarioModelDefinition['derived']> = [];
  const lines: ScenarioModelDefinition['lines'] = [];
  const exposure: string[] = [];
  const labour: string[] = [];
  const cashIn: string[] = [];
  const slowest: string[] = [];
  for (const one of included) {
    const o = `o${one.index}`;
    const name = one.opportunity.title.slice(0, 50);
    variables.push(
      variable(`${o}_price`, `${name}: price`, target.currency, one.price),
      variable(`${o}_capital`, `${name}: money tied up per deal`, target.currency, one.capital),
      variable(`${o}_hours`, `${name}: hours per deal`, 'hours', one.hours),
      variable(`${o}_days`, `${name}: days to usable cash`, 'days', one.daysToCash),
      variable(`${o}_close`, `${name}: share of buyers who agree`, 'share', one.close),
      variable(`${o}_cost`, `${name}: direct cost per deal`, target.currency, one.directCost),
      variable(`${o}_volume`, `${name}: deals the market can take in the window`, 'deals', one.volume),
      variable(`${o}_agreed`, `${name}: already agreed by a buyer`, target.currency, known(one.agreedValue, 'EVIDENCE', { kind: 'CASH_OPPORTUNITY', ref: one.opportunity.id, note: 'recorded buyer agreements' }, 'money a buyer has agreed to')),
      {
        key: `${o}_n`,
        label: `${name}: buyers offered`,
        unit: 'buyers',
        provenance: 'ASSUMPTION',
        controllable: true,
        spec: { kind: 'FIXED', value: 0 },
        note: 'a choice the strategy makes',
      },
    );
    derived.push(
      { key: `${o}_won`, label: `${name}: deals won`, unit: 'deals', expr: `min(${o}_n * ${o}_close, ${o}_volume)` },
      { key: `${o}_in`, label: `${name}: settles before the deadline`, unit: 'flag', expr: `if(${o}_days <= days_left, 1, 0)` },
    );
    lines.push(
      { key: `${o}_cash`, label: `${name}: settled inside the window`, kind: 'REVENUE', expr: `(${o}_agreed + ${o}_won * ${o}_price) * ${o}_in` },
      { key: `${o}_spend`, label: `${name}: direct costs`, kind: 'COST', expr: `${o}_won * ${o}_cost` },
    );
    // Money is tied up per deal taken, not per buyer asked.
    exposure.push(`(${o}_won + ${one.agreedDeals}) * ${o}_capital`);
    labour.push(`${o}_won * ${o}_hours`);
    cashIn.push(`(${o}_agreed + ${o}_won * ${o}_price) * ${o}_in`);
    slowest.push(`if(${o}_n + ${o}_agreed > 0, ${o}_days, 0)`);
  }
  derived.push({ key: 'settled_in_window', label: 'Cash settled before the deadline', unit: target.currency, expr: cashIn.join(' + ') });
  const metrics: NonNullable<ScenarioModelDefinition['metrics']> = [
    // The target is cash kept: what settles in time less the direct costs of the deals that earned it (§99 Q-3).
    { key: 'goal_met', label: 'Reaches the target in time', unit: 'flag', expr: `if(settled_in_window - (${included.map((one) => `o${one.index}_won * o${one.index}_cost`).join(' + ') || '0'}) >= remaining, 1, 0)`, better: 'HIGHER' },
    { key: 'settled', label: 'Settled before the deadline', unit: target.currency, expr: 'settled_in_window', better: 'HIGHER' },
    { key: 'exposure', label: 'Money tied up', unit: target.currency, expr: exposure.join(' + '), better: 'LOWER', role: 'CAPITAL_EXPOSURE' },
    { key: 'labour', label: 'Hours of work', unit: 'hours', expr: labour.join(' + '), better: 'LOWER', role: 'LABOR_HOURS' },
    { key: 'days', label: 'Slowest money to settle', unit: 'days', expr: slowest.length > 1 ? `max(${slowest.join(', ')})` : slowest[0]!, better: 'LOWER', role: 'DAYS_TO_CASH' },
  ];
  const constraints: NonNullable<ScenarioModelDefinition['constraints']> = [
    { key: 'hours', label: 'Within the hours available', expr: `${labour.join(' + ')} - hours_available`, op: '<=', value: 0 },
  ];
  // A ceiling is compared against a variable, so it is written as a difference.
  if (target.capitalCeilingCents !== null) {
    constraints.unshift({ key: 'capital', label: 'Within the money the owner said this goal may commit', expr: `${exposure.join(' + ')} - capital_ceiling`, op: '<=', value: 0 });
  }

  const strategies: StrategySpec[] = [];
  // How many new buyers a strategy offers to. Agreed money needs none; a
  // one-off needs its one buyer; a repeatable play offers to OUTREACH_MULTIPLE
  // times as many buyers as the deals still needed — a choice the strategy
  // makes and states, not an assumption about how many will say yes.
  const dealsFor = (one: ModelledOpportunity) => {
    const gap = Math.max(0, target.remainingCents / 100 - one.agreedValue);
    if (gap === 0) return 0;
    if (!one.repeatable) return one.agreedValue > 0 ? 0 : 1;
    const price = one.price.value ?? one.price.low ?? 1;
    return Math.min(MAX_BUYERS_OFFERED, Math.ceil(gap / Math.max(1, price)) * OUTREACH_MULTIPLE);
  };
  const none = () => Object.fromEntries(included.map((one) => [`o${one.index}_n`, 0]));
  const add = (spec: StrategySpec) => {
    // Two strategies that ask the same thing of every opening are one strategy.
    const same = strategies.some((one) => canonical(one.set) === canonical(spec.set));
    if (!same && strategies.length < SCENARIO_LIMITS.maxStrategies) strategies.push(spec);
  };
  const canonical = (set: StrategySpec['set']) => JSON.stringify(Object.entries(set).sort(([a], [b]) => a.localeCompare(b)));
  /*
   * Combinations are built from the openings themselves, never from a split.
   * Each walks the openings in one order and asks each for only what is still
   * needed after the ones before it: money already agreed first, then a
   * one-off deal for its price, then a repeatable play for whatever remains.
   * So one opening may carry the whole goal, or several may share it in
   * whatever amounts they actually offer — and nothing is divided equally or
   * by template. The engine then evaluates the combination as one plan, with
   * the shared hours and money summed across it.
   */
  const combine = (key: string, label: string, order: ModelledOpportunity[]) => {
    let gap = target.remainingCents / 100;
    const set: StrategySpec['set'] = none();
    const used: ModelledOpportunity[] = [];
    for (const one of order) {
      if (gap <= 0) break;
      const price = one.price.value ?? one.price.low ?? 0;
      if (one.agreedValue > 0) {
        gap -= one.agreedValue;
      } else if (!one.repeatable) {
        if (price <= 0) continue;
        set[`o${one.index}_n`] = 1;
        gap -= price;
      } else {
        set[`o${one.index}_n`] = Math.min(MAX_BUYERS_OFFERED, Math.ceil(gap / Math.max(1, price)) * OUTREACH_MULTIPLE);
        gap = 0;
      }
      used.push(one);
    }
    if (used.length > 1) add({ key, label: `${label}: ${used.map((one) => one.opportunity.title.slice(0, 30)).join(' + ')}`.slice(0, 160), set });
  };
  if (included.length > 1) {
    const reach = (one: ModelledOpportunity) => bestCaseReach(one, target.remainingCents / 100, target.daysLeft!);
    combine('combine_reach', 'Combined, largest reach first', [...included].sort((a, b) => Number(b.agreed) - Number(a.agreed) || reach(b) - reach(a)));
    const days = (one: ModelledOpportunity) => (one.daysToCash.value !== null ? one.daysToCash.value : Number.POSITIVE_INFINITY);
    combine('combine_fast', 'Combined, fastest money first', [...included].sort((a, b) => Number(b.agreed) - Number(a.agreed) || days(a) - days(b) || reach(b) - reach(a)));
    const evidence = (one: ModelledOpportunity) =>
      [one.close, one.price, one.daysToCash, one.directCost, one.capital].filter((input) => input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL').length;
    combine('combine_evidence', 'Combined, best-evidenced first', [...included].sort((a, b) => Number(b.agreed) - Number(a.agreed) || evidence(b) - evidence(a) || reach(b) - reach(a)));
    add({
      key: 'basket_all',
      label: 'Every modelled opening at full reach',
      set: { ...none(), ...Object.fromEntries(included.map((one) => [`o${one.index}_n`, dealsFor(one)])) },
    });
  }
  // Single-opening strategies fill what the engine's strategy limit leaves, after
  // the combinations: with eight openings modelled, eight "only" strategies would
  // otherwise take every slot and no portfolio would ever be evaluated.
  for (const one of included) {
    add({
      key: `only_o${one.index}`,
      label: `Only: ${one.opportunity.title.slice(0, 60)}`,
      set: { ...none(), [`o${one.index}_n`]: dealsFor(one) },
    });
  }

  return {
    definition: {
      title: `Plan for: ${goal.title}`.slice(0, 120),
      description: `Composed from goal ${goal.id} and project ${target.projectId}. Counts ${target.metricLabel} that settles before the due date.`,
      currency: target.currency,
      horizon: `${target.daysLeft} days until the goal is due`,
      variables,
      derived,
      lines,
      metrics,
      constraints,
      strategies,
    },
    included,
    excluded,
    considered: candidates,
    estimates,
    arrangementSelection,
    refusal: null,
    portfolio,
    portfolioInput,
  };
}

/** The buyers a single-opening plan asks, for a judgement made outside the engine. */
export function dealsForGoal(one: ModelledOpportunity, remainingMajor: number): number {
  const gap = Math.max(0, remainingMajor - one.agreedValue);
  if (gap === 0) return 0;
  if (!one.repeatable) return one.agreedValue > 0 ? 0 : 1;
  const price = one.price.value ?? one.price.low ?? 1;
  return Math.min(MAX_BUYERS_OFFERED, Math.ceil(gap / Math.max(1, price)) * OUTREACH_MULTIPLE);
}
