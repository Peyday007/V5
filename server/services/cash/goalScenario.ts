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
import { cashOutcomeLessons, INBOUND_MIN_VISITORS, LESSON_MIN_SAMPLE } from './journey/learning.ts';
import { isTestFirstPlay } from './tier.ts';
import { readTrialVolume, readVolume } from './volume.ts';
import { frontierTiers } from './shared.ts';
import type { CashMechanism, CashOpportunity, CashCardFact } from '../../domain/types.ts';
import { STRUCTURES } from './properties.ts';
import { COMPETITIVE_AWARD } from './paymentTiming.ts';
import { PROVIDER_PAYOUT_DAYS } from './money.ts';
import { SCENARIO_LIMITS, type ScenarioModelDefinition, type ScenarioVariable, type SourceRef, type StrategySpec, type VariableProvenance } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';
import type { TargetReading } from '../goals/target.ts';
import { inferCashQuantity, loadCashKnowledge, type CashKnowledge, type CashQuantity, type InferenceTarget } from '../quant/knowledge.ts';
import { inputSample, toScenarioInput, toScenarioInputScaled, type InputSample } from '../quant/export.ts';
import { CONTACTS_PER_DAY_BOUNDS, evaluateGoalPortfolio, heldEvaluation, measuredRateInput, type GoalPortfolio, type PlannedOpening, type RestructureEvidence, type UnpricedPopulation } from '../goals/portfolio.ts';
import { SPREAD_FLOOR } from '../quant/pool.ts';
import type { Estimate, EvidenceTier } from '../../domain/quant.ts';
import type { VariableSpec } from '../../domain/scenario.ts';
import { brainComparablePrices, capabilityPart, composeInvented, fittedDeliverable, provedDeliverable, inventionContext, nextInputQuestion, payerKey, TRANSFER_MATERIAL, type ConstructedArrangement, type InventedDesign } from './construct.ts';
import { buyerPopulationName, namesABuyerPopulation } from '../../domain/industry.ts';
import { unmodelledVerdict } from './unmodelledVerdict.ts';
import { agreedCostUnits, agreedToward, costedDeals, costPerDeal, countsNet, directCostTerm, perDealToward } from './towardTarget.ts';

export { agreedCostUnits, agreedToward, costedDeals, costPerDeal, countsNet, directCostTerm, perDealToward };
export { TRANSFER_MATERIAL };

/**
 * Phase timings for a plan read, printed as they happen when BRAIN_PLAN_TRACE is
 * set (the Goals workflow sets it). Production, 2026-11-02: the read went from
 * 15 s to past the workflow's 15-minute bound, while the same code reads a
 * 25-opening plan locally in 0.7 s — only a timing taken where it is slow can
 * say which phase it is.
 */
let lastTrace: { scope: string; label: string; at: number } | null = null;

/** The last stage any plan trace reached, for a heartbeat that says where a long read is (goal C, 2026-11-19). */
export function lastPlanTrace(): { scope: string; label: string; at: number } | null {
  return lastTrace;
}

export function planTrace(scope: string, env = process.env): (label: string) => void {
  if (!env['BRAIN_PLAN_TRACE']) return () => {};
  const start = Date.now();
  let last = start;
  lastTrace = { scope, label: 'start', at: start };
  return (label) => {
    const now = Date.now();
    console.error(`  trace ${scope} +${now - last}ms (${now - start}ms) ${label}`);
    last = now;
    lastTrace = { scope, label, at: now };
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
  /**
   * A price that is a broker's or referrer's take of the buyer's price
   * (`commissionRevenue`): the share's range and whether anything filed
   * establishes it. Unestablished, the plan names the commission — not the
   * buyer's price — as the research it needs (`inputEvidence`).
   */
  takeShare?: { low: number; high: number; basis: CommissionReading['basis']; established: boolean };
}

/** The card's text columns a transaction pathway shows, and the card fact each is answered by. */
export const CARD_COLUMN_FACT = { payer: 'payer', buyingSignal: 'buyingEvidence', reachableChannel: 'access', offerScope: 'offer', fulfillmentOwner: 'fulfillment' } as const;
export type CardColumn = keyof typeof CARD_COLUMN_FACT;

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
  /**
   * The fulfilment route a reconstructed strategy re-costed this opening to
   * (§99 FULFILMENT): the supplier route it engages and whether the cost it
   * now carries is this deliverable's own evidence or an assumption. Set only
   * by the reconstruction, never by a card.
   */
  fulfilment?: { route: string; basis: 'ESTIMATE' | 'ASSUMPTION' };
  opportunity: CashOpportunity;
  index: number;
  tier: string;
  repeatable: boolean;
  /** Major units of the goal's currency. */
  price: ModelInput;
  capital: ModelInput;
  /**
   * Hours of work the owner performs on one deal — never the work the deal
   * needs from whoever performs it. The goal's hours are the owner's
   * (`target.hoursCeiling`), and this is what they bound.
   */
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
  /**
   * Every prospect the market holds inside the window, when research counted the
   * buyers themselves (`VolumeReading.counted` BUYERS): the buyers times how often
   * each buys. A measured rate is a share of prospects asked, so it can win at
   * most this many times that rate — 320 gift shops at 0.25% are under one order,
   * however many more offers a plan would like to send. Null when the volume is
   * an order rate (which counts deals made, not prospects) or is not established.
   */
  prospects?: number | null;
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
   * Where each text column of the card stands (W2, 2026-11-17): its card fact's
   * kind through `kindToProvenance` — EVIDENCE only for a gated claim, a
   * proposal or a person's word an ASSUMPTION, no fact UNKNOWN. A filled
   * column is never proof by being filled. Absent on an arrangement, which has no card.
   */
  columns?: Partial<Record<CardColumn, VariableProvenance>>;
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
  /**
   * The arrangement's price is the plan's decision variable (`priceAsVariable`):
   * nothing establishes what its buyers pay, but its supply cost was observed, so
   * the break-even and the price the target needs are computed and the price is
   * swept between them as an assumption. Absent on everything else.
   */
  priceVariable?: PriceVariable;
  /**
   * A BROKER or REFERRAL design keeps only a commission or fee on a sale its
   * supplier makes (`commissionRevenue`): `price` is that take per deal, and
   * this records the share, how it is known and the buyer's price it is a
   * share of. Absent on every design Brain is paid the buyer's price for.
   */
  commission?: CommissionReading;
}

/** The id an estimated arrangement takes in a goal model. Never a row. */
export const ARRANGEMENT_ID_PREFIX = 'arr_';
export function isArrangementId(id: string): boolean {
  return id.startsWith(ARRANGEMENT_ID_PREFIX);
}
/** At most this many constructed arrangements enter one goal model as estimates. */
export const MAX_ESTIMATED_ARRANGEMENTS = 12;

/**
 * What converting an arrangement reads: its project and currency, and the
 * project's evidence (`loadCashKnowledge`) when the caller holds it. Without
 * knowledge every unestablished link is swept, as before.
 */
export interface ArrangementInput {
  projectId: string;
  currency: string;
  knowledge?: CashKnowledge | null;
  now?: Date;
  /** Days the goal has left: what an inferred monthly deal volume is scaled to (30 when unstated). */
  daysLeft?: number | null;
  /** What the goal still needs, in major units: what a price-variable arrangement's required price is read against. */
  remaining?: number | null;
}

/**
 * The project's openings by who pays, keyed by the map's buyer identity — the
 * payer as named and the population it is filed under — built once per set of
 * openings (W2c, 2026-11-17). Before, every arrangement re-keyed every opening
 * (`payerKey`, `buyerPopulationName`): 400 arrangements × 1,000 openings was
 * 800,000 regex-heavy readings a plan pass. Ids keep the openings' order.
 */
const payerIndexCache = new WeakMap<ReadonlyMap<string, CashOpportunity>, { size: number; index: Map<string, string[]> }>();
export function openingsByPayer(opportunities: ReadonlyMap<string, CashOpportunity>): Map<string, string[]> {
  const hit = payerIndexCache.get(opportunities);
  if (hit && hit.size === opportunities.size) return hit.index;
  const index = new Map<string, string[]>();
  for (const o of opportunities.values()) {
    if (o.duplicateOfId || !o.payer) continue;
    for (const key of new Set([payerKey(o.payer), payerKey(buyerPopulationName(o.payer))])) {
      if (!key) continue;
      const ids = index.get(key);
      if (ids) ids.push(o.id);
      else index.set(key, [o.id]);
    }
  }
  payerIndexCache.set(opportunities, { size: opportunities.size, index });
  return index;
}

/**
 * The opening the knowledge inference reads an arrangement as (F2): its own
 * id, its sector, its price band, and the mechanism its structure is already
 * held as — the one its buyers' related openings are sold through when they
 * are, else its precedent's, else the structure's first. A structure held as
 * no mechanism stays OTHER, so every observation is broad: bounds, never a
 * distribution. Only `inferCashQuantity`'s context reads it; it is never a row.
 * Pure.
 */
export function arrangementTarget(one: ConstructedArrangement, knowledge: Pick<CashKnowledge, 'opportunities' | 'projectId'>, price: ModelInput, currency: string): InferenceTarget {
  const held: readonly string[] = one.structure ? (STRUCTURES[one.structure]?.alreadyHeldAs ?? []) : [];
  /*
   * The openings of these very buyers (W2b): its related openings, and any
   * opening whose payer is this population by the map's identity. What is
   * evidenced on them is evidence about the arrangement's own buyers, so the
   * inference reads it as its own (`sameBuyer`) instead of only through
   * project-wide comparables.
   */
  const buyer = payerKey(one.demand.name);
  const sameBuyer = new Set((one.relatedOpenings ?? []).filter((id) => knowledge.opportunities.has(id)));
  if (buyer) for (const id of openingsByPayer(knowledge.opportunities).get(buyer) ?? []) sameBuyer.add(id);
  const counts = new Map<string, number>();
  const signals = new Map<string, number>();
  for (const id of sameBuyer) {
    const o = knowledge.opportunities.get(id);
    if (o?.mechanism && held.includes(o.mechanism)) counts.set(o.mechanism, (counts.get(o.mechanism) ?? 0) + 1);
    if (o?.opportunitySignal) signals.set(o.opportunitySignal, (signals.get(o.opportunitySignal) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const related = top(counts);
  const precedent = one.precedent ? knowledge.opportunities.get(one.precedent.opportunityId)?.mechanism : undefined;
  const mechanism = related ?? (precedent && held.includes(precedent) ? precedent : undefined) ?? held[0] ?? 'OTHER';
  const p50 = price.inferred?.p50 ?? price.value ?? null;
  return {
    id: `${ARRANGEMENT_ID_PREFIX}${one.key}`,
    projectId: knowledge.projectId,
    title: one.label,
    mechanism,
    industry: one.sector,
    // These buyers' own buying signal, when their openings state one.
    opportunitySignal: top(signals) ?? null,
    priceCents: p50 !== null && p50 > 0 ? Math.round(p50 * 100) : null,
    currency,
    duplicateOfId: null,
    sameBuyer: [...sameBuyer].sort(),
  } as unknown as InferenceTarget;
}

/**
 * A constructed arrangement as a model candidate, from its reconstructed value
 * alone — or null when nothing reconstructs its value, or its known worst case
 * breaks the limits. Price is the reconstruction's own p10–p50–p90; everything
 * else nobody has established is swept, exactly as for an opening with nothing
 * on its card. A recurring design is repeatable, with its volume a range from
 * one deal, never a number assumed. Pure.
 */
export function estimatedFromArrangement(one: ConstructedArrangement, input: ArrangementInput & { beforeProofCents: number | null }): ModelledOpportunity | null {
  const { p10, p50, p90 } = one.value;
  if (one.stress.exposure === 'EXCEEDS') return null;
  // A MECHANISM value is a pool of other buyers' prices, not these buyers': it
  // is no price, and a cost or capital swept from its top would be borrowed too
  // (PRICE-POOL, 2026-11-14). Like UNKNOWN, it stays a research target — unless
  // the supply cost was observed, when the price becomes the plan's decision
  // variable, bounded by the break-even and the target (`priceAsVariable`).
  if (one.value.tier === 'UNKNOWN' || one.value.tier === 'MECHANISM' || !(p50 > 0) || !(p90 >= p10)) return priceAsVariable(one, input);
  // Provenance: the claims (or facts, or openings) the reconstruction read, carried on the note.
  const from = one.value.sources?.length ? `: ${one.value.sources.slice(0, 6).join(', ')}${one.value.sources.length > 6 ? ', …' : ''}` : '';
  const ref: SourceRef = { kind: 'OTHER', ref: `arrangement:${one.key}`, note: `${one.value.tier} reconstruction from ${one.value.observations} observation(s) of these buyers${from}` };
  // A transfer carries a design to buyers who differ from the precedent's on every material dimension
  // nobody has bridged: until a sourced adjustment bridges one, its price range is widened, never narrowed (S-12).
  const transfer = transferOf(one);
  // F4: a price these very buyers' sources state per slot was observed for this design's own unit, not carried
  // from the precedent, so the precedent's unbridged differences neither widen it nor disqualify it. The other
  // links keep the transfer (it is still carried on the opening).
  const priceTransfer = one.value.perParticipant ? null : transfer;
  const widen = priceTransfer && priceTransfer.unbridged.length > 0 ? Math.exp(SPREAD_FLOOR.COMPARABLE * Z90) : 1;
  const low = Math.max(0.01, p10 / widen);
  const high = Math.max(low + 0.01, p90 * widen);
  // Accepted evidence about what these buyers pay, justified as a distribution by the reconstruction (F2): the
  // price is that evidence. A transfer nobody has bridged, a price paid under another payment mechanism (GH2), or
  // bounds alone, stays the assumption swept below.
  const unbridged = priceTransfer && priceTransfer.unbridged.length ? `transferred from "${priceTransfer.precedent}" with ${priceTransfer.unbridged.join(', ')} not bridged` : null;
  const notEvidence = [one.value.notEvidence ?? null, unbridged].filter((why): why is string => !!why);
  const evidence = notEvidence.length === 0 ? one.value.evidence : undefined;
  if (evidence) {
    const { values, low: eLow, high: eHigh, ...sample } = evidence;
    const evidenced: ModelInput = {
      value: null,
      low: eLow,
      high: Math.max(eLow + 0.01, eHigh),
      provenance: 'EVIDENCE',
      source: ref,
      note: `evidenced (${one.value.tier}, ${one.value.observations} obs. of these buyers${from}): p10 ${p10} p50 ${p50} p90 ${p90}`,
      distribution: { kind: 'EMPIRICAL', values },
      inferred: { tier: one.value.tier as EvidenceTier, justified: true, p10, p50, p90, observations: one.value.observations, ...sample },
    };
    return arrangementOpening(one, input, evidenced, evidenced.high!, transfer);
  }
  const price: ModelInput = {
    value: null,
    low,
    high,
    provenance: 'ASSUMPTION',
    source: ref,
    note:
      `reconstructed (${one.value.tier}, ${one.value.observations} obs. of these buyers${from}), not shown paid: p10 ${p10} p50 ${p50} p90 ${p90}` +
      (one.value.notEvidence ? `; ${one.value.notEvidence}` : '') +
      (unbridged ? `; ${unbridged}, so swept ${Math.round(low)}–${Math.round(high)}` : ''),
    // Swept over the reconstruction's range: an estimate carries no distribution (only evidence may). A price
    // that is not evidence of these buyers under this design is ASSUMED, never a comparable (GH2): the
    // reconstruction's tier described its observations, not what they establish here.
    inferred: { tier: notEvidence.length ? 'ASSUMED' : (one.value.tier as EvidenceTier), justified: false, p10, p50, p90, observations: one.value.observations },
  };
  return arrangementOpening(one, input, price, high, transfer);
}

/** Participants one shared run is read at: a run's size is a decision nobody has made, so each is reported, none assumed. */
export const RUN_SLOT_GRID = [6, 12, 24, 48] as const;

/** One participant count of a shared run and what each participant must pay at it. */
export interface PriceAtSlots {
  slots: number;
  /** The price per slot that only covers the run's observed cost. */
  breakEven: number;
  /** The price per slot one run of this many needs to collect the remaining amount over its cost; null when the remaining amount is not known. */
  forTarget: number | null;
}

/** An arrangement whose price is the decision variable: what its observed cost and the target require of the price. */
export interface PriceVariable {
  arrangementKey: string;
  label: string;
  /** The observed fixed cost of one shared run, and the claims it rests on. */
  runCost: { p10: number; p50: number; p90: number; tier: string; observations: number; sources: string[] };
  remaining: number | null;
  /** Per participant count of one run. */
  prices: PriceAtSlots[];
  /** The swept price range: the break-even at the most participants to the target price at the fewest. */
  swept: { low: number; high: number };
  /** Always the price: the one input that decides whether the arrangement covers its cost and reaches the target. */
  blocking: 'PRICE';
  /** Price is assumed and swept; nothing about it is certified. */
  basis: 'ASSUMPTION';
  sentence: string;
}

/**
 * A pooled arrangement nobody has priced for its own buyers, but whose shared
 * run's cost was observed (production 2026-11-18: the postcard broker
 * 2821cce3c372, `fixed_cost_per_run` 4675 from clm_9cf1f15c), as a model
 * candidate with its price as the decision variable — or null when nothing
 * prices it and no cost was observed, which stays a research question.
 *
 * Before, an UNKNOWN value dropped the arrangement from the goal model, so
 * the one observed number about it — what a run costs — was never read. A
 * competent planner treats the unknown price as the variable: the break-even
 * price (run cost ÷ participants) and the price one run needs for the target
 * ((remaining + run cost) ÷ participants) are computed at each participant
 * count (`RUN_SLOT_GRID`), and the price is swept log-uniformly from the
 * break-even at the most participants to the target price at the fewest. It is
 * an ASSUMPTION, tier ASSUMED, never justified: the arrangement competes on
 * what it would contribute at a price research has not found, and certifies
 * nothing (`inputEvidence`). The price is the blocking unknown, named as such.
 * Pure.
 */
export function priceAsVariable(one: ConstructedArrangement, input: ArrangementInput): ModelledOpportunity | null {
  const run = one.fixedCost;
  if (one.design.aggregation !== 'POOLED_BUYERS' || !run || !(run.p50 > 0)) return null;
  if (one.stress.exposure === 'EXCEEDS') return null;
  const remaining = input.remaining !== undefined && input.remaining !== null && input.remaining > 0 ? input.remaining : null;
  const cents = (x: number) => Math.round(x * 100) / 100;
  const prices: PriceAtSlots[] = RUN_SLOT_GRID.map((slots) => ({
    slots,
    breakEven: cents(run.p50 / slots),
    forTarget: remaining === null ? null : cents((remaining + run.p50) / slots),
  }));
  const most = RUN_SLOT_GRID[RUN_SLOT_GRID.length - 1]!;
  const fewest = RUN_SLOT_GRID[0]!;
  const low = Math.max(0.01, run.p50 / most);
  const high = Math.max(low + 0.01, remaining === null ? Math.max(run.p50, run.p90) / fewest : (remaining + run.p50) / fewest);
  const a = Math.log(low);
  const b = Math.log(high);
  const values = Array.from({ length: LOG_GRID_POINTS }, (_, i) => Math.exp(a + ((i + 0.5) / LOG_GRID_POINTS) * (b - a)));
  const from = run.sources.length ? ` (${run.sources.slice(0, 6).join(', ')})` : '';
  const money = (x: number) => `${input.currency === 'USD' ? '$' : `${input.currency} `}${Math.round(x).toLocaleString('en-US')}`;
  const ref = prices.find((p) => p.slots === 12) ?? prices[0]!;
  const sentence =
    `Price is the blocking assumption: nothing establishes what these buyers pay. One shared run costs ${money(run.p50)} (${run.tier.toLowerCase()}, ${run.observations} obs.${from}), ` +
    `so ${prices.map((p) => `${p.slots} slots need ≥ ${money(p.breakEven)}`).join(', ')} per slot just to cover the run` +
    (remaining === null
      ? '.'
      : `; to collect the ${money(remaining)} still needed from one run, ${ref.slots} slots need ${money(ref.forTarget!)} each (${prices.filter((p) => p !== ref).map((p) => `${p.slots}: ${money(p.forTarget!)}`).join(', ')}).`) +
    ` The price is swept ${money(low)}–${money(high)} as an assumption; nothing is certified until a buyer's price is.`;
  const price: ModelInput = {
    value: null,
    low,
    high,
    provenance: 'ASSUMPTION',
    source: { kind: 'OTHER', ref: `arrangement:${one.key}`, note: `price as the decision variable over an observed run cost${from}` },
    note: sentence,
    distribution: { kind: 'EMPIRICAL', values },
    inferred: { tier: 'ASSUMED', justified: false, p10: low, p50: Math.sqrt(low * high), p90: high, observations: 0 },
  };
  const opening = arrangementOpening(one, input, price, high, transferOf(one));
  return {
    ...opening,
    priceVariable: {
      arrangementKey: one.key,
      label: one.label,
      runCost: { p10: run.p10, p50: run.p50, p90: run.p90, tier: run.tier, observations: run.observations, sources: [...run.sources] },
      remaining,
      prices,
      swept: { low: cents(low), high: cents(high) },
      blocking: 'PRICE',
      basis: 'ASSUMPTION',
      sentence,
    },
  };
}

/**
 * The payment terms a constructed arrangement inherits from its buyers'
 * evidence, as a terms sentence the settlement and financing readers parse;
 * null when nothing stated them (unknown, never prepaid — invariant 39). Pure.
 */
export function inheritedTerms(one: Pick<ConstructedArrangement, 'buyerTerms'>): string | null {
  const t = one.buyerTerms;
  if (!t || t.timing === 'UNKNOWN') return null;
  // The basis is carried on the arrangement; the sentence holds only the words the readers parse, so a basis
  // quoting other terms can never flip it.
  if (t.timing === 'ARREARS') return 'paid in arrears, after delivery, as these buyers\' evidence states';
  /*
   * The share that arrives before delivery is carried, never widened: a deposit
   * read as "paid in advance" would let the financing and restructuring readers
   * take the whole price as the buyer's money (invariant 39).
   */
  if (t.share === undefined || t.share === 1) return 'paid in advance, as these buyers\' evidence states';
  if (t.share === null) return 'a deposit before delivery, its share not stated, as these buyers\' evidence states';
  return `${Math.round(t.share * 1000) / 10}% paid before delivery as a deposit, the balance on delivery, as these buyers' evidence states`;
}

/**
 * The share of the buyer's price a broker or referrer is swept over when
 * nothing filed for these buyers establishes it. A stated convention, not
 * evidence: low, so an unknown commission is never read as the whole price
 * (invariant 39), and an assumption the plan cannot certify anything on.
 */
export const COMMISSION_SWEEP = { low: 0.05, high: 0.2 } as const;

/** What a broker's or referrer's revenue per deal is a share of, and how that share is known. */
export interface CommissionReading {
  /** The share of the buyer's price Brain keeps: its range and middle. */
  low: number;
  p50: number;
  high: number;
  /**
   * EVIDENCE: a distribution the take rates filed for these buyers justify.
   * FILED: take rates filed for these buyers, with no stated sample, swept
   * over their range. ASSUMPTION: nothing filed; swept `COMMISSION_SWEEP`.
   */
  basis: 'EVIDENCE' | 'FILED' | 'ASSUMPTION';
  /** Something filed for these buyers states the share; an ASSUMPTION never does. */
  established: boolean;
  /** The claims or facts the share rests on (`claim:…`, `fact:…`). */
  sources: string[];
  /** The buyer's price per deal it is a share of — what the supplier is paid, not Brain. */
  buyerPrice: { low: number | null; high: number | null; provenance: VariableProvenance };
  sentence: string;
}

/** True for a design paid a commission or fee on a sale its supplier makes: the buyer's price is not its revenue. */
export function takesCommission(one: Pick<ConstructedArrangement, 'design'>): boolean {
  return one.design.base === 'BROKER' || one.design.base === 'REFERRAL';
}

/** An even grid over [low, high]: on the log scale when both are positive (a share and a price are magnitudes). */
function gridOver(low: number, high: number, n = LOG_GRID_POINTS): number[] {
  if (!(high > low)) return [low];
  if (low > 0) {
    const a = Math.log(low);
    const b = Math.log(high);
    return Array.from({ length: n }, (_, i) => Math.exp(a + ((i + 0.5) / n) * (b - a)));
  }
  return Array.from({ length: n }, (_, i) => low + ((i + 0.5) / n) * (high - low));
}

/** At most `n` evenly spaced quantiles of `xs`. */
function thinned(xs: readonly number[], n: number): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length <= n) return sorted;
  return Array.from({ length: n }, (_, i) => sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / n) * sorted.length))]!);
}

/** The product of two independent draws, as `LOG_GRID_POINTS` quantiles of every pairing. */
function productQuantiles(a: readonly number[], b: readonly number[]): number[] {
  const xs = thinned(a, 64);
  const ys = thinned(b, 64);
  const all = xs.flatMap((x) => ys.map((y) => x * y)).sort((p, q) => p - q);
  return thinned(all, LOG_GRID_POINTS);
}

/** A spec with every money figure multiplied by one share; a categorical spec has none, so none. */
function scaledSpec(spec: VariableSpec, f: number): VariableSpec | undefined {
  switch (spec.kind) {
    case 'FIXED':
      return { kind: 'FIXED', value: spec.value * f };
    case 'RANGE':
      return { kind: 'RANGE', min: spec.min * f, max: spec.max * f };
    case 'TRIANGULAR':
      return { kind: 'TRIANGULAR', min: spec.min * f, mode: spec.mode * f, max: spec.max * f };
    case 'NORMAL':
      return { kind: 'NORMAL', mean: spec.mean * f, sd: spec.sd * f, min: spec.min * f, max: spec.max * f };
    case 'EMPIRICAL':
      return { kind: 'EMPIRICAL', values: spec.values.map((v) => v * f) };
    default:
      return undefined;
  }
}

/**
 * A BROKER or REFERRAL design's revenue per deal: the commission or fee Brain
 * keeps, never the buyer's whole price. The supplier fulfils and is paid the
 * rest, so counting the buyer's price as Brain's revenue overstated these
 * designs many times over and ranked them above designs Brain produces itself
 * on money Brain would never collect (invariant 39: the commission, an
 * unknown, read as 100%).
 *
 *   * Take rates filed for these buyers (`ConstructedArrangement.commission`)
 *     are the share: as evidence where the reconstruction justifies a
 *     distribution, else swept over their filed range, with those claims as
 *     its provenance.
 *   * Nothing filed: the share is swept `COMMISSION_SWEEP` (5%–20%) as an
 *     assumption, marked unestablished, so the plan asks for the commission
 *     (`takeShare`, read by `inputEvidence`) and certifies nothing on it.
 *
 * The take is the share times the buyer's price, drawn independently. It is
 * evidence only when both the price and the share are. Pure.
 */
export function commissionRevenue(one: Pick<ConstructedArrangement, 'commission' | 'design'>, price: ModelInput, currency = 'USD'): { revenue: ModelInput; commission: CommissionReading } {
  const c = one.commission;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const money = (x: number | null) => (x === null ? 'unknown' : `${currency === 'USD' ? '$' : `${currency} `}${Math.round(x).toLocaleString('en-US')}`);
  const who = one.design.base === 'REFERRAL' ? 'a referrer' : 'a broker';
  let reading: Omit<CommissionReading, 'buyerPrice' | 'sentence'>;
  let rates: number[];
  if (c && c.tier !== 'UNKNOWN' && c.p90 > 0) {
    if (c.evidence) {
      const low = Math.max(0, Math.min(1, c.evidence.low));
      const high = Math.min(1, Math.max(low, c.evidence.high));
      reading = { low, p50: Math.min(high, Math.max(low, c.p50)), high, basis: 'EVIDENCE', established: true, sources: [...c.sources] };
      rates = c.evidence.values.filter((v) => Number.isFinite(v)).map((v) => Math.min(1, Math.max(0, v)));
    } else {
      const low = Math.max(0, Math.min(1, c.p10));
      const high = Math.min(1, Math.max(low, c.p90));
      reading = { low, p50: Math.min(high, Math.max(low, c.p50)), high, basis: 'FILED', established: true, sources: [...c.sources] };
      rates = gridOver(low, high);
    }
  } else {
    const { low, high } = COMMISSION_SWEEP;
    reading = { low, p50: Math.sqrt(low * high), high, basis: 'ASSUMPTION', established: false, sources: [] };
    rates = gridOver(low, high);
  }
  if (rates.length === 0) rates = [reading.p50];
  const priceLow = price.low ?? price.value;
  const priceHigh = price.high ?? price.value;
  const from = reading.sources.length ? ` (${reading.sources.slice(0, 6).join(', ')})` : '';
  const sentence =
    reading.basis === 'ASSUMPTION'
      ? `Brain keeps only ${who}'s commission, never the buyer's ${money(priceLow)}–${money(priceHigh)}: nothing filed establishes what share ${who} keeps here, so it is swept ${pct(reading.low)}–${pct(reading.high)} of the buyer's price as an assumption until research finds the commission suppliers of this work pay`
      : `Brain keeps only ${who}'s commission: ${pct(reading.low)}–${pct(reading.high)} of the buyer's ${money(priceLow)}–${money(priceHigh)}, the take rate filed for these buyers (${c!.tier}, ${c!.observations} obs.${from})${reading.basis === 'FILED' ? ', published without a sample, so swept over that range' : ''}`;
  const point = rates.length === 1 || reading.low === reading.high;
  let distribution: VariableSpec | undefined;
  if (point) distribution = price.distribution ? scaledSpec(price.distribution, reading.p50) : undefined;
  else {
    const priceValues = price.distribution?.kind === 'EMPIRICAL' ? price.distribution.values : priceLow !== null && priceHigh !== null ? gridOver(priceLow, priceHigh) : [];
    distribution = priceValues.length > 0 ? { kind: 'EMPIRICAL', values: productQuantiles(priceValues, rates) } : undefined;
  }
  const evidenced = price.provenance === 'EVIDENCE' && reading.basis === 'EVIDENCE';
  const provenance: VariableProvenance = evidenced ? 'EVIDENCE' : price.provenance === 'UNKNOWN' ? 'UNKNOWN' : 'ASSUMPTION';
  const at = (x: number | null, share: number) => (x === null ? null : x * share);
  const values = distribution?.kind === 'EMPIRICAL' ? [...distribution.values].sort((a, b) => a - b) : null;
  const q = (p: number, fallback: number) => (values && values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))]! : fallback);
  const inferred = price.inferred
    ? {
        ...price.inferred,
        tier: reading.basis === 'ASSUMPTION' ? ('ASSUMED' as EvidenceTier) : price.inferred.tier,
        justified: price.inferred.justified && evidenced,
        p10: q(0.1, price.inferred.p10 * reading.low),
        p50: q(0.5, price.inferred.p50 * reading.p50),
        p90: q(0.9, price.inferred.p90 * reading.high),
      }
    : undefined;
  const revenue: ModelInput = {
    value: price.value === null || !point ? null : price.value * reading.p50,
    low: at(priceLow, reading.low),
    high: at(priceHigh, reading.high),
    provenance,
    source: price.source,
    note: `${sentence}; the buyer's price: ${price.note}`,
    ...(distribution ? { distribution } : {}),
    ...(inferred ? { inferred } : {}),
    takeShare: { low: reading.low, high: reading.high, basis: reading.basis, established: reading.established },
  };
  return { revenue, commission: { ...reading, buyerPrice: { low: priceLow, high: priceHigh, provenance: price.provenance }, sentence } };
}

/**
 * A constructed arrangement as a model candidate on a price already read: the
 * links nobody has established swept exactly as for an opening with nothing on
 * its card. Shared by the estimated and the invented conversions. A broker's
 * or referrer's price is read as the commission it keeps (`commissionRevenue`),
 * and its direct cost and capital as an intermediary's: the supplier fulfils
 * from the buyer's money, so neither the supplier's cost nor its run is
 * subtracted from the commission a second time. Pure.
 */
function arrangementOpening(
  one: ConstructedArrangement,
  input: ArrangementInput,
  price: ModelInput,
  high: number,
  transfer: ReturnType<typeof transferOf>,
  invented = false,
  /**
   * The price a blind direct cost is a share of, and what the note calls it.
   * Defaults to the top of the price's range; a price swept over other buyers'
   * prices passes its own geometric middle instead (`sweptOverOtherPrices`).
   */
  costScale: { value: number; what: string } = { value: high, what: 'the top price' },
): ModelledOpportunity {
  const ref: SourceRef = price.source ?? { kind: 'OTHER', ref: `arrangement:${one.key}` };
  const worst = one.stress.worstCaseCents === null ? null : one.stress.worstCaseCents / 100;
  // A broker or referrer keeps a share of the buyer's price; the supplier fulfils and keeps the rest.
  const take = takesCommission(one) ? commissionRevenue(one, price, input.currency) : null;
  const costBasis = take ? { value: costScale.value * take.commission.high, what: `the top commission at ${costScale.what}` } : costScale;
  /*
   * F2 (2026-11-17): every link below was a hard-coded sweep, so accepted
   * research about these buyers could never move a plan built from
   * arrangements. Each now reads the project's evidence through the one
   * inference path found openings use (`inferOr`), on the population the
   * arrangement sells to (`arrangementTarget`); where nothing bears on it the
   * sweep is unchanged.
   */
  const knowledge = input.knowledge ?? null;
  const now = input.now ?? new Date();
  const target = knowledge ? arrangementTarget(one, knowledge, price, input.currency) : null;
  const infer = (quantity: CashQuantity, fallback: ModelInput, scale = 1, what = ''): ModelInput => (target ? inferOr(knowledge, quantity, target, now, fallback, scale, what) : fallback);
  const capital: ModelInput = take
    ? { value: null, low: 0, high: 0.01, provenance: 'ASSUMPTION', source: ref, note: 'a broker or referrer advances nothing: the buyer pays the supplier, who fulfils from that money; not yet established in practice' }
    : one.stress.exposure === 'SAFE'
      ? { value: null, low: 0, high: 0.01, provenance: 'ASSUMPTION', source: ref, note: 'the design spends nothing of ours before buyers commit; not yet established in practice' }
      : worst !== null
        ? unknown(0, Math.max(0.01, worst), `the design's known worst case is ${worst}; swept from nothing to it`)
        : ownMechanismCapital(infer('capitalShare', unknown(0, high, 'nobody has established the money tied up; swept from nothing to the top price'), high, ' as a share of the top price'), high);
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
    // The terms its buyers' evidence states (an RFP population pays in arrears), so the plan and the
    // reconstruction's financing lever read them as they read a found opening's; none stated stays unknown.
    paymentTerms: inheritedTerms(one),
  } as unknown as CashOpportunity;
  return {
    opportunity,
    index: 0,
    tier: 'ESTIMATE',
    repeatable,
    price: take ? take.revenue : price,
    capital,
    hours: ownerHoursOf(one, ref) ?? infer('hours', unknown(1, 40, 'nobody has established who performs the work or the owner hours it takes; swept from 1 to 40 owner hours per deal')),
    // The design's own payment structure first; other openings' time to cash only where it does not settle when money moves.
    daysToCash: structuralDaysToCash(one, ref, input.daysLeft) ?? infer('daysToCash', unknown(3, 60, 'nobody has established when the money would settle; swept from 3 to 60 days')),
    close: arrangementClose(one, ref) ?? infer('close', unknown(0.02, 0.5, 'no buyer has been asked yet; swept from 2% to 50% of buyers agreeing')),
    respond: infer('respond', unknown(0.002, 0.15, 'nobody has established how many prospects of this kind reply; swept from 0.2% to 15%')),
    // The supplier pays a shared run out of the buyer's money; only a design that buys the run itself bears its cost.
    directCost:
      (take ? null : (pooledRunCostPerDeal(one) ?? reconstructedSupplyCostPerDeal(one))) ??
      infer('costShare', unknown(0, Math.max(0.01, costBasis.value * 0.6), `nobody has established the direct cost; swept from nothing to 60% of ${costBasis.what}`), costBasis.value, ` as a share of ${costBasis.what}`),
    // A repeating design's deals in the window, from these buyers' own stated volume only (a market's size never transfers).
    volume: repeatable
      ? infer(
          'dealsPerMonth',
          unknown(1, MAX_BUYERS_OFFERED, `a ${one.design.repeat.toLowerCase().replace('_', ' ')} design repeats, but nobody has established how many buyers exist; swept from 1 deal`),
          Math.max(1, input.daysLeft ?? 30) / 30,
          ' over the days left',
        )
      : known(1, 'ASSUMPTION', ref, 'a one-off design is one deal'),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
    estimated: { arrangementKey: one.key, tier: price.inferred?.tier ?? one.value.tier, observations: price.inferred?.observations ?? one.value.observations, ...(transfer ? { transfer } : {}), ...(invented ? { invented: true } : {}) },
    ...(take ? { commission: take.commission } : {}),
  };
}

/**
 * The owner hours one deal of a constructed design takes, where the design
 * itself establishes who performs the work; null where it does not.
 *
 * Production 2026-11-20 (goal wst_7b4fcbb5f2384f31b6c3, "capital 3000 ·
 * hours 0"): every constructed arrangement read its hours as "nobody has
 * established the hours; swept from 1 to 40 per deal", and the screen set that
 * against the goal's hours — the owner's. An unknown amount of work was read
 * as the owner's labour, so all 404 designs were cut "one deal needs at least
 * 1 hours, more than the 0 this goal has", including those Brain produces and
 * those a supplier fulfils. The owner does no physical work (§91) and Brain
 * is the default producer (§41); approving a send or a quote is not hours.
 *
 *   - PRODUCE over a deliverable Brain has proved for these buyers
 *     (`provedDeliverable`): Brain performs it — 0 owner hours.
 *   - A supply design (BROKER, REFERRAL, SUBCONTRACT, POOL) whose supply part
 *     names a supplier from the project's map or event graph: that supplier
 *     fulfils, and Brain only messages, invoices and records — 0 owner hours.
 *   - Anything else — a capability no proved deliverable matched, a supplier
 *     nobody named (reverse construction's "asked of the world"), no supply
 *     part at all — establishes no performer: null, and the caller keeps the
 *     conservative sweep (invariant 39), so a goal with no owner hours still
 *     cuts it and it stays a research or acquisition question.
 *
 * Whether Brain can actually execute each step is decided elsewhere
 * (planIntegrity's EXECUTABLE_BY_BRAIN, goals/stepExecutor.ts) and is not
 * read or changed here. Pure.
 */
export function ownerHoursOf(one: Pick<ConstructedArrangement, 'design' | 'supply'>, source: SourceRef | null = null): ModelInput | null {
  const def = STRUCTURES[one.design.base];
  if (!def) return null;
  const supply = one.supply;
  if (!def.needsSupply) {
    if (!provedDeliverable(supply)) return null;
    return known(0, 'ASSUMPTION', source, `Brain performs the work (${supply!.name}), a deliverable it has proved; the owner's approvals are not hours: 0 owner hours per deal`);
  }
  if (!supply || supply.from === 'CAPABILITY' || supply.from === 'REVERSE' || !supply.name.trim()) return null;
  return known(0, 'ASSUMPTION', source, `the supplier "${supply.name}" fulfils, and Brain only messages, invoices and records; the owner's approvals are not hours: 0 owner hours per deal`);
}

/**
 * The owner hours one deal of a found opening takes when Brain performs it,
 * or null where nothing establishes that.
 *
 * Production 2026-11-21 (plan read 44860552332, goal wst_7b4fcbb5f2384f31b6c3,
 * "hours 0"): cop_c46683c4a7ba4d6b80ad's pathway read "fulfilled by Brain
 * produces it: website", yet its model hours were the blind 1–40 owner-hour
 * sweep, so the portfolio and every gate strategy refused it as "no performer
 * is established". A constructed design over the same proved deliverable
 * already reads 0 owner hours (`ownerHoursOf`); a found opening was denied it.
 *
 * The evidence is exactly `provedDeliverable`'s: Brain's capability fitted by
 * `fittedDeliverable` to the opening's need (its offer, else its title — the
 * need construction reads from an opening) or its payer, over the deliverables
 * the capability frame proves (`delivers`). Only when the card names nobody
 * else to do the work and states no hours of its own; anything else — no
 * proved match, an empty frame, a named fulfiller — is null, and the caller
 * keeps the conservative sweep (invariant 39). Pure.
 */
export function foundOwnerHours(
  o: Pick<CashOpportunity, 'id' | 'offerScope' | 'title' | 'payer' | 'fulfillmentOwner' | 'humanHours'>,
  delivers: readonly string[],
  source: SourceRef | null = null,
): ModelInput | null {
  if (o.humanHours !== null || o.fulfillmentOwner?.trim()) return null;
  const capability = capabilityPart(delivers);
  if (!capability) return null;
  const needName = (o.offerScope ?? o.title ?? '').trim();
  const need = needName ? { name: needName, claimId: null, from: 'OPENING' as const, ref: o.id, path: '' } : null;
  const demand = { name: (o.payer ?? '').trim(), claimId: null, from: 'OPENING' as const, ref: o.id, path: '' };
  const fitted = fittedDeliverable(capability, delivers, demand, need);
  if (!provedDeliverable(fitted)) return null;
  return known(0, 'ASSUMPTION', source, `Brain performs the work (${fitted.name.slice(0, 160)}), a deliverable it has proved; the owner's approvals are not hours: 0 owner hours per deal`);
}

/**
 * What one participant's deal costs in a pooled design whose shared run's
 * fixed cost research established (B1j's `arrangement.fixedCost`), or null.
 *
 * Production 2026-11-18 (D4): arrangement 2821cce3c372 carried fixed run cost
 * p50 4675 from the accepted claim clm_9cf1f15c, and no goal-model input read
 * it. A model deal is one buyer's slot, so its direct cost was the blind
 * "nothing to 60% of the top price" sweep — a margin of at least 40% assumed
 * on every slot, whatever the run costs. The moment a slot price is filed, the
 * plan would have modelled a $395 slot as earning $158–$395 while one $4,675
 * run shared by ten buyers costs each $467.
 *
 * A participant's share is the run's cost over however many share the run,
 * and nobody has established that count: swept log-uniformly (a share is a
 * magnitude) from the run's low cost spread over the most buyers the model
 * ever offers to (`MAX_BUYERS_OFFERED`) up to its high cost borne by one. An
 * assumption with the run cost's claims as its source, never evidence, so it
 * establishes nothing and the share stays a research question. Pure.
 */
export function pooledRunCostPerDeal(one: Pick<ConstructedArrangement, 'key' | 'design' | 'fixedCost'>): ModelInput | null {
  const run = one.fixedCost;
  if (one.design.aggregation !== 'POOLED_BUYERS' || !run || !(run.p50 > 0)) return null;
  const top = Math.max(run.p50, run.p90);
  const low = Math.max(0.01, Math.min(run.p50, run.p10 > 0 ? run.p10 : run.p50) / MAX_BUYERS_OFFERED);
  const high = Math.max(low + 0.01, top);
  const a = Math.log(low);
  const b = Math.log(high);
  const values = Array.from({ length: LOG_GRID_POINTS }, (_, i) => Math.exp(a + ((i + 0.5) / LOG_GRID_POINTS) * (b - a)));
  const from = run.sources.length ? `: ${run.sources.slice(0, 6).join(', ')}` : '';
  return {
    value: null,
    low,
    high,
    provenance: 'ASSUMPTION',
    source: { kind: 'OTHER', ref: `arrangement:${one.key}`, note: `fixed cost of one shared run (${run.tier}, ${run.observations} obs.${from})` },
    note:
      `one shared run costs p10 ${Math.round(run.p10)} p50 ${Math.round(run.p50)} p90 ${Math.round(run.p90)} (${run.tier}, ${run.observations} obs.${from}); ` +
      `a participant pays a share of it, and nobody has established how many share one run, so swept log-uniformly ${Math.round(low * 100) / 100}–${Math.round(high)} per deal`,
    distribution: { kind: 'EMPIRICAL', values },
    inferred: { tier: 'ASSUMED', justified: false, p10: low, p50: Math.sqrt(low * high), p90: high, observations: run.observations },
  };
}

/**
 * What one deal of a design that pays its supplier per deal costs, read from
 * the supply cost construction reconstructed from the rates research filed
 * for these buyers (`arrangement.supplyCost`), or null.
 *
 * Production fresh plan reads, 2026-11-21 (goals C, $100K and $5K/mo): COST
 * was the dominant lever on every one, because a MARGIN design whose supply
 * cost the quant engine had reconstructed from filed subcontractor rates
 * still entered the model as the blind "nothing to 60% of the top price"
 * sweep — the reconstruction reached only the stress check.
 *
 * A number nobody published is reconstructed from the mechanism and says how
 * far it travelled (§79). EVIDENCE only where the reconstruction is DIRECT and
 * justifies a distribution, entered as the price evidence is. Anything else —
 * COMPARABLE, COMPONENT, MECHANISM, or bounds alone — is an ASSUMPTION swept
 * over the reconstruction's own p10–p90 (never narrower), naming its tier,
 * its observation count and its sources: reconstructed, not established, so
 * it certifies nothing (invariant 39). Pure.
 */
export function reconstructedSupplyCostPerDeal(one: Pick<ConstructedArrangement, 'key' | 'design' | 'supplyCost'>): ModelInput | null {
  const c = one.supplyCost;
  if (one.design.aggregation === 'POOLED_BUYERS' || !c || !(c.p90 > 0) || !(c.p90 >= c.p10)) return null;
  const from = c.sources.length ? `: ${c.sources.slice(0, 6).join(', ')}${c.sources.length > 6 ? ', …' : ''}` : '';
  const source: SourceRef = { kind: 'OTHER', ref: `arrangement:${one.key}`, note: `supply cost per deal reconstructed (${c.tier}, ${c.observations} obs.${from})` };
  const stated = `what one deal pays its supplier, reconstructed from rates filed for these buyers (${c.tier}, ${c.observations} obs.${from}): p10 ${Math.round(c.p10 * 100) / 100} p50 ${Math.round(c.p50 * 100) / 100} p90 ${Math.round(c.p90 * 100) / 100}`;
  if (c.tier === 'DIRECT' && c.evidence) {
    const { values, low, high, ...sample } = c.evidence;
    return {
      value: null,
      low: Math.max(0, Math.min(low, c.p10)),
      high: Math.max(low + 0.01, high, c.p90),
      provenance: 'EVIDENCE',
      source,
      note: `evidenced ${stated}`,
      distribution: { kind: 'EMPIRICAL', values },
      inferred: { tier: 'DIRECT', justified: true, p10: c.p10, p50: c.p50, p90: c.p90, observations: c.observations, ...sample },
    };
  }
  const low = Math.max(0, c.p10);
  return {
    value: null,
    low,
    high: Math.max(low + 0.01, c.p90),
    provenance: 'ASSUMPTION',
    source,
    note: `${stated}; reconstructed, not established (${c.tier.toLowerCase()} evidence), so swept over that range`,
    inferred: { tier: c.tier as EvidenceTier, justified: false, p10: c.p10, p50: c.p50, p90: c.p90, observations: c.observations },
  };
}

/**
 * The close rate a constructed arrangement's own buyers are published at (R3):
 * the `account_win_rate` facts filed for them, reconstructed into its demand
 * side's `conversion`. A distribution the reconstruction justifies (a sized
 * rate) is evidence, entered as the price evidence is; published rates with no
 * stated sample locate it, so it is swept over their reconstructed p10–p90 as
 * an assumption, never as a probability. Null when none is filed: the close
 * rate is then inferred or swept as before. Pure.
 */
/**
 * Days from a buyer's interest to a signed agreement paid by invoice, for a
 * design sold by Brain's own offer (the selling path: reply, quote, agree).
 * No row measures it yet; a stated sweep, never evidence.
 */
export const AGREE_DAYS = { low: 1, high: 7 } as const;

/**
 * Days to usable cash read from when the design itself says money moves, or
 * null where the structure does not settle it and the caller keeps the
 * comparable inference.
 *
 * Production plan run 44826035355 (goal wst_7b4f, "Collect $10K within 30
 * days", 19 days left): every constructed design's days to cash was inferred
 * from the project's own time-to-first-cash records — government award cycles
 * among them — so the range was long-tailed (middle ~9 days, top ~400). The
 * engine reads an unestablished input no better than its range's centre
 * (portfolio.ts `sampler`, E4a), so every design read ~200 days and none could
 * settle inside 19, while the plan's own sensitivity named days to cash at the
 * bottom of its range as the binding lever. For a design whose buyer pays at
 * agreement, an award's wait is not a comparable: it describes another
 * payment structure.
 *
 *   - PREPAID: cash = time to agree (`AGREE_DAYS`) + the payment provider's
 *     payout (`PROVIDER_PAYOUT_DAYS`, Stripe's documented first payout).
 *   - THRESHOLD_PRESALE: money is held until enough buyers have joined, which
 *     the design's own kill rule bounds by the window (refund otherwise): cash
 *     from the soonest agreement to the window's end, plus the payout.
 *   - ON_DELIVERY (paid on delivery, in arrears or on net terms): the
 *     structure does not say how long — null, the comparables decide.
 *   - A funding nobody stated, or buyers whose own evidence says they pay in
 *     arrears or only a deposit (a presale over them contradicts itself:
 *     arrangementSteps' TERMS_CONFLICT): null. A structure is never read more
 *     favourably than what is stated about who pays.
 *
 * Always an ASSUMPTION derived from the stated structure, its assumptions
 * named, never EVIDENCE: the first sale measures it. Pure.
 */
export function structuralDaysToCash(one: Pick<ConstructedArrangement, 'design' | 'buyerTerms'>, ref: SourceRef | null, daysLeft?: number | null): ModelInput | null {
  const funding = one.design?.funding;
  if (funding !== 'PREPAID' && funding !== 'THRESHOLD_PRESALE') return null;
  const terms = one.buyerTerms;
  if (terms?.timing === 'ARREARS') return null;
  if (terms?.timing === 'PREPAID' && terms.share !== undefined && terms.share !== 1) return null;
  const pay = PROVIDER_PAYOUT_DAYS;
  const agree = `${AGREE_DAYS.low}–${AGREE_DAYS.high} days from interest to a signed, invoiced agreement (assumed: no sale has measured it)`;
  const payout = `${pay.low}–${pay.high} days for the payment to become usable funds (${pay.source})`;
  if (funding === 'PREPAID') {
    return {
      value: null,
      low: AGREE_DAYS.low + pay.low,
      high: AGREE_DAYS.high + pay.high,
      provenance: 'ASSUMPTION',
      source: ref,
      note: `derived from the design's stated structure: each buyer pays the whole price at agreement, so cash is ${agree} plus ${payout}; not established until the first sale measures it`,
    };
  }
  const window = Math.max(AGREE_DAYS.high, Math.round(daysLeft ?? 30));
  return {
    value: null,
    low: AGREE_DAYS.low + pay.low,
    high: window + pay.high,
    provenance: 'ASSUMPTION',
    source: ref,
    note: `derived from the design's stated structure: buyers prepay into a presale that is bought only once enough have joined, inside the ${window}-day selling window or refunded, so cash is ${agree} at the soonest and the window's end at the latest, plus ${payout}; how fast it fills is not established`,
  };
}

function arrangementClose(one: ConstructedArrangement, ref: SourceRef): ModelInput | null {
  const c = one.conversion;
  if (!c) return null;
  const from = c.sources.length ? `: ${c.sources.slice(0, 6).join(', ')}` : '';
  const stated = `close rate filed for these buyers (${c.tier}, ${c.observations} obs.${from}): p10 ${c.p10} p50 ${c.p50} p90 ${c.p90}`;
  if (c.evidence) {
    const { values, low, high, ...sample } = c.evidence;
    return {
      value: null,
      low: Math.max(0, low),
      high: Math.min(1, Math.max(low + 0.0001, high)),
      provenance: 'EVIDENCE',
      source: ref,
      note: stated,
      distribution: { kind: 'EMPIRICAL', values },
      inferred: { tier: c.tier as EvidenceTier, justified: true, p10: c.p10, p50: c.p50, p90: c.p90, observations: c.observations, ...sample },
    };
  }
  const low = Math.max(0.0001, Math.min(1, c.p10));
  return {
    value: null,
    low,
    high: Math.min(1, Math.max(low + 0.0001, c.p90)),
    provenance: 'ASSUMPTION',
    source: ref,
    note: `${stated}; published without a sample, so swept over that range`,
    inferred: { tier: c.tier as EvidenceTier, justified: false, p10: c.p10, p50: c.p50, p90: c.p90, observations: c.observations },
  };
}

/**
 * A design Brain's reasoning model invented (S-11), composed by the one
 * construction path, as a model candidate — or the reason it cannot be one.
 *
 * Where its reconstruction holds what *these* buyers paid, it enters exactly
 * as an estimated arrangement does. Otherwise nothing establishes its price,
 * and it is not given one: it is swept log-uniformly across the prices other
 * buyers in this project are published as paying, only while they lie within
 * one order of magnitude (`comparablePricesFor`) — MECHANISM bounds,
 * provenance UNKNOWN — so the engine can say what the design would
 * contribute if research found these buyers pay like those, and nothing it
 * contributes can certify a plan (every link is unestablished, `inputEvidence`).
 * With no published price in the project at all, nothing bounds it, and it
 * stays a research question. Nothing the model said is a number here. Pure.
 */
export function inventedFromArrangement(
  one: ConstructedArrangement,
  input: ArrangementInput & { beforeProofCents: number | null; otherPrices: readonly number[] },
): PlannedOpening | { refused: string } {
  if (one.stress.exposure === 'EXCEEDS') return { refused: "its known worst case exceeds the goal's limits" };
  const marketKey = populationMarket(one.demand.ref);
  const estimated = estimatedFromArrangement(one, input);
  if (estimated)
    return { ...estimated, marketKey, opportunity: { ...estimated.opportunity, title: `Invented: ${one.label}`.slice(0, 200) }, estimated: { ...estimated.estimated!, invented: true } };
  const comparable = comparablePricesFor(one, input.otherPrices.map((value) => ({ value, industry: null })), input.currency);
  if ('refused' in comparable) return { refused: `${comparable.refused}, so the design stays a research question` };
  return sweptOverOtherPrices(one, input, comparable.prices, true, comparable.scope);
}

/** Points on the log-uniform grid a swept price is drawn from. */
const LOG_GRID_POINTS = 41;

/**
 * A design nothing prices for its own buyers, swept across the prices
 * comparable buyers are published as paying: log-uniform between their p10 and
 * p90 (a price is a magnitude, and uniform over a band spanning orders of
 * magnitude is a draw from its top — F4, 2026-11-15), provenance UNKNOWN, tier
 * MECHANISM, so it competes on what it would contribute *if* research found
 * these buyers pay like those, and can never certify a plan. With no published
 * price at all, it is refused with that reason. Pure.
 */
function sweptOverOtherPrices(
  one: ConstructedArrangement,
  input: ArrangementInput,
  otherPrices: readonly number[],
  invented: boolean,
  scope = 'in this project',
): PlannedOpening | { refused: string } {
  const prices = otherPrices.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  const what = invented ? 'the design' : 'the arrangement';
  if (prices.length === 0) return { refused: `nothing bounds what these buyers pay: neither the project nor the Brain's validated findings hold a published price, so ${what} stays a research question` };
  const low = logQuantile(prices, 0.1);
  const high = Math.max(low + 0.01, logQuantile(prices, 0.9));
  const p50 = Math.sqrt(low * high);
  // Log-uniform between p10 and p90: an even grid on the log scale, resampled by the engine (`sampler`, `atQuantile`).
  const a = Math.log(low);
  const b = Math.log(high);
  const values = Array.from({ length: LOG_GRID_POINTS }, (_, i) => Math.exp(a + ((i + 0.5) / LOG_GRID_POINTS) * (b - a)));
  const price: ModelInput = {
    value: null,
    low,
    high,
    provenance: 'UNKNOWN',
    source: { kind: 'OTHER', ref: `arrangement:${one.key}`, note: `${invented ? 'an invented design' : 'a constructed arrangement'}: no figure from these buyers` },
    note: `${invented ? 'invented design' : 'constructed arrangement'}: nothing establishes what these buyers pay; swept log-uniformly ${Math.round(low)}–${Math.round(high)} (p10–p90 of the ${prices.length} price(s) other buyers ${scope} are published as paying; mechanism bounds, not these buyers')`,
    // A sweep's shape, not evidence: provenance UNKNOWN and `justified: false` keep it from establishing anything.
    distribution: { kind: 'EMPIRICAL', values },
    inferred: { tier: 'MECHANISM', justified: false, p10: low, p50, p90: high, observations: prices.length },
  };
  /*
   * Production 2026-11-19: the blind direct cost was "nothing to 60% of the
   * top price", and the top of a swept price is the p90 of other buyers'
   * prices. The engine draws price and cost independently, so a world at a
   * low price paid a cost scaled to the pool's top: $42–$156,737 swept gave a
   * price p50 of $2,569 against a cost p50 of $47,021. The cost is a share of
   * this arrangement's own price, so its scale is the price's geometric middle
   * — the sweep's median — and at the median the cost reads at the same
   * nothing-to-60% share as any opening's (PRICE-POOL: a cost swept from a
   * pool's top is borrowed). Capital keeps the top: it bounds exposure.
   */
  const costScale = { value: p50, what: "the swept price's geometric middle" };
  return { ...arrangementOpening(one, input, price, high, null, invented, costScale), marketKey: populationMarket(one.demand.ref) };
}

/** The `q` quantile of sorted positive values, interpolated on the log scale. Pure. */
function logQuantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const at = q * (sorted.length - 1);
  const i = Math.floor(at);
  const lo = sorted[i]!;
  const hi = sorted[Math.min(sorted.length - 1, i + 1)]!;
  return Math.exp(Math.log(lo) + (at - i) * (Math.log(hi) - Math.log(lo)));
}

/** A price another buyer in the project is published as paying: the sector, mechanism and payer it was paid in. */
export interface ComparablePrice {
  value: number;
  industry: string | null;
  mechanism?: CashMechanism | null;
  payer?: string | null;
  /** A price from the Brain's validated findings rather than this project's rows (`brainComparablePrices`, §31). */
  brain?: boolean;
}
const normSector = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** A comparable set needs at least this many prices of the same kind. */
export const SECTOR_PRICES_MIN = 2;
/**
 * The widest p90/p10 a set of other buyers' prices may span and still be read
 * as one comparable price: one order of magnitude. Production, 2026-11-15: the
 * project-wide fallback spanned $15–$325K, uniform over it, and a dog-groomer
 * arrangement averaged ~$160K a deal and led reach and research priority (F4).
 */
export const COMPARABLE_SPREAD_MAX = 10;

/**
 * The prices a constructed arrangement with no price of its own is swept
 * across, or why there are none (Surge B, F4). Comparable means comparable:
 * the same sector; else the same structure (openings of a mechanism the
 * arrangement's structure is already held as); else the same kind of buyer;
 * else the project's prices — and in every scope, the sector included, only a
 * set within one order of magnitude (`COMPARABLE_SPREAD_MAX`). A wider pool is no comparable
 * price, and the arrangement stays out with that reason. With no published
 * price at all the set is empty, and the sweep refuses. Never a price for
 * these buyers — a bound. Pure.
 */
/**
 * A payer's two buyer keys — as named, and the population it is filed under —
 * read once per payer (W15): `comparablePricesFor` runs once per arrangement
 * over every published price, so the same few hundred payers were re-keyed
 * hundreds of times a plan pass. Pure in the payer; bounded, emptied when full.
 */
const BUYER_KEYS_MAX = 8_192;
const buyerKeys = new Map<string, readonly [string, string]>();
function buyerKeysOf(payer: string): readonly [string, string] {
  const hit = buyerKeys.get(payer);
  if (hit) return hit;
  const keys = [payerKey(payer), payerKey(buyerPopulationName(payer))] as const;
  if (buyerKeys.size >= BUYER_KEYS_MAX) buyerKeys.clear();
  buyerKeys.set(payer, keys);
  return keys;
}

export function comparablePricesFor(
  one: Pick<ConstructedArrangement, 'sector'> & Partial<Pick<ConstructedArrangement, 'structure' | 'demand'>>,
  prices: readonly ComparablePrice[],
  currency = 'USD',
): { prices: number[]; scope: string } | { refused: string } {
  const usable = prices.filter((p) => Number.isFinite(p.value) && p.value > 0);
  /*
   * The project's own prices first, by the chain below. Only a project that
   * holds none reads the Brain's validated findings (§31), by the same chain,
   * each scope saying where its prices came from.
   */
  const own = usable.filter((p) => !p.brain);
  const fromBrain = own.length === 0 && usable.some((p) => p.brain);
  const valid = fromBrain ? usable : own;
  const where = fromBrain ? " among the Brain's validated findings" : '';
  const tight = (xs: readonly number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return logQuantile(sorted, 0.9) / logQuantile(sorted, 0.1) <= COMPARABLE_SPREAD_MAX;
  };
  const money = (x: number) => `${currency === 'USD' ? '$' : `${currency} `}${Math.round(x).toLocaleString('en-US')}`;
  const span = (xs: readonly number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return `${money(sorted[0]!)}–${money(sorted[sorted.length - 1]!)}`;
  };
  /*
   * The same sector is held to the same order of magnitude as every other
   * scope. Production 2026-11-19: one sector's published prices ran $42 to
   * $156,737 (p10–p90), and every unpriced arrangement in it was swept across
   * them — a price p50 of $2,569 that belongs to no buyer, and a plan reading
   * p50 $185,840 at 0.4% reach for a $100K goal. A sector label names an
   * industry, not a deal: a $40 consumable and a $150K contract share one. A
   * wider set is no comparable price; the narrower scopes below are tried, and
   * with none the price stays the research question.
   */
  const sector = normSector(one.sector);
  const same = sector ? valid.filter((p) => normSector(p.industry) === sector).map((p) => p.value) : [];
  if (same.length >= SECTOR_PRICES_MIN && tight(same)) return { prices: same, scope: `in the same sector (${one.sector})${where}` };
  const wideSector = same.length >= SECTOR_PRICES_MIN ? `; in the same sector (${one.sector}) they span ${span(same)}` : '';
  const held: readonly string[] = one.structure ? (STRUCTURES[one.structure]?.alreadyHeldAs ?? []) : [];
  const structure = held.length ? valid.filter((p) => p.mechanism && held.includes(p.mechanism)).map((p) => p.value) : [];
  if (structure.length >= SECTOR_PRICES_MIN && tight(structure)) return { prices: structure, scope: `with the same structure (${one.structure})${where}` };
  // The same kind of buyer by the map's identity: plurals folded (`payerKey`), and a named
  // organisation read as the population the map files it under (`buyerPopulationName`).
  const buyer = payerKey(one.demand?.name);
  const sameBuyer = (payer: string | null | undefined) => !!payer && buyerKeysOf(payer).includes(buyer);
  const buyers = buyer ? valid.filter((p) => sameBuyer(p.payer)).map((p) => p.value) : [];
  if (buyers.length >= SECTOR_PRICES_MIN && tight(buyers)) return { prices: buyers, scope: `paid by the same kind of buyer (${one.demand!.name})${where}` };
  const all = valid.map((p) => p.value);
  if (all.length === 0 || tight(all)) return { prices: all, scope: fromBrain ? "in the Brain's validated findings (other projects' sourced claims)" : 'in this project' };
  return { refused: `no comparable price: published prices for other buyers${where} span ${span(all)}${wideSector}` };
}

/**
 * The composer an exploration hands invented designs to (§101, S-11): reads
 * the construction context once, then composes each design through
 * `composeInvented` and converts it with `inventedFromArrangement`.
 */
export async function inventedDesigner(input: Parameters<typeof inventionContext>[0]): Promise<(spec: InventedDesign) => PlannedOpening | { refused: string }> {
  const ctx = await inventionContext(input);
  // The project's evidence, read once, so an invented design's links read it as a constructed one's do (W2b).
  const knowledge = await loadCashKnowledge(input.projectId).catch(() => null);
  const now = input.now ?? new Date();
  const otherPrices = ctx.priced.filter((o) => o.value.kind === 'POINT').map((o) => (o.value as { value: number }).value);
  return (spec) => {
    const made = composeInvented(spec, ctx);
    if ('refused' in made) return made;
    return inventedFromArrangement(made, { projectId: input.projectId, currency: input.currency, beforeProofCents: ctx.limits.capitalBeforeProofCents, otherPrices, knowledge, now, daysLeft: ctx.limits.daysLeft });
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
 *     score read both as "the whole goal"). One deal is credited at most what
 *     the goal still needs, before its chance is applied: a price above the
 *     goal is never read through an unknown close.
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
/** Of the model's arrangement slots, at most this many go to the goal's held leaders first (P4). */
export const LEADER_SLOTS = 4;
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
  /**
   * Why the goal's own terms leave it out, or null when it can fit them: its
   * money cannot settle before the deadline, it ties up more than the goal
   * allows, one deal needs more hours than the goal has, or every deal loses
   * money at the middle readings. Read from the stated bounds only: an unknown
   * is never a reason to cut, only a reason to read lower.
   */
  misfit: string | null;
  /**
   * Set when a deal loses money at the middle readings only because its direct
   * cost is the blind sweep (nothing to 60% of the top price, nobody having
   * established it): not cut, since nothing shows the loss, but read as
   * keeping nothing at the middle, so it can enter only as an upside bet.
   */
  flag: string | null;
  /** The share of its swept up-front money the goal's capital covers (1 when the goal states no limit). */
  capitalFit: number;
  /** True when it ties money up before buyers commit and the goal's stated capital covers all of it. */
  usesCapital: boolean;
}

/**
 * The goal's own terms a screen reads (§102 on one arrangement): days left,
 * what is still needed, the outreach capacity, and — when the goal states
 * them — the money it allows up front and the hours it has. Null is "not
 * stated", which constrains nothing; zero is a stated limit.
 */
export interface GoalFit {
  remaining: number;
  daysLeft: number;
  contactsPerDay: number;
  /** Money the goal allows tied up before proof (major units), or null when nobody stated it. */
  capital?: number | null;
  /** The owner's hours the goal has, or null when nobody stated them: what a deal's owner hours (`hours`) are read against. */
  hours?: number | null;
}

/** P(x ≤ limit) for x uniform over the input's range; 1 when no limit is stated. */
function shareWithin(x: ModelInput, limit: number | null | undefined, slack = 0.01): number {
  if (limit === null || limit === undefined) return 1;
  const a = x.low ?? x.value ?? 0;
  const b = Math.max(a, x.high ?? x.value ?? a);
  if (b <= limit + slack) return 1;
  if (a > limit) return 0;
  return Math.max(0, Math.min(1, (limit - a) / (b - a)));
}

/** The middle of an input: its stated value, its inferred p50, else the middle of its range. */
function middle(x: ModelInput): number | null {
  if (x.value !== null) return x.value;
  if (x.inferred) return x.inferred.p50;
  if (x.low !== null && x.high !== null) return (x.low + x.high) / 2;
  return x.low ?? x.high ?? null;
}

/**
 * Why one deal of this opening loses money at the middle of both readings, or
 * null. Production transfer test, release ca2efe4d: a constructed homeowner
 * deal priced at a $2,569 p50 carried a direct cost swept from nothing to 60%
 * of the top of its price range — p50 $47,021 — so every deal it adds loses
 * about $44K, and it still took a model slot. The cost is not lowered (nothing
 * established it): the estimate is left out with this reason, and stays a
 * research question. Pure.
 */
export function losesMoneyPerDeal(one: Pick<ModelledOpportunity, 'price' | 'directCost' | 'agreedValue'>): string | null {
  if (one.agreedValue > 0) return null;
  const price = middle(one.price);
  const cost = middle(one.directCost);
  if (price === null || cost === null || !(cost > 0) || cost < price) return null;
  return `every deal loses money at the middle readings: direct cost p50 ${Math.round(cost)} against price p50 ${Math.round(price)}`;
}

/** An input at the unfavourable end of its range for a cost-like quantity (hours, money out). */
function unfavourableHigh(x: ModelInput): number {
  const lo = x.low ?? x.value ?? 0;
  const hi = x.high ?? x.value ?? lo;
  if (x.value !== null && x.provenance !== 'UNKNOWN') return x.value;
  return hi - SCREEN_QUANTILE * (hi - lo);
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
  input: GoalFit,
): ArrangementScreen {
  const { p10, p50, p90 } = arrangement.value;
  const position = TIER_PRICE_POSITION[arrangement.value.tier] ?? 0;
  // A transfer's widened range (S-12) is the price it is read on.
  // A broker or referrer keeps only its commission: the buyer's price is read at the share's conservative reading.
  const c = one.commission;
  const share = !c ? 1 : c.basis === 'EVIDENCE' ? c.p50 : c.low + SCREEN_QUANTILE * (c.high - c.low);
  const low = Math.min(p10, c ? (c.buyerPrice.low ?? p10) : (one.price.low ?? p10));
  const price = (low + position * (p50 - low)) * share;
  const top = p90 * share;
  const close = conservative(one.close);
  const respond = conservative(one.respond);
  const { selling, inTime } = sellingDays(one.daysToCash, input.daysLeft);
  /*
   * The goal's own shape (production transfer test, release ca2efe4d: six
   * goals from $2K in 14 days to $50K with $25K capital all admitted the same
   * 12 arrangements). Hours: a goal that states its hours sells at most the
   * deals those hours cover at an unfavourable reading of hours per deal.
   * Capital: the share of the swept up-front money the goal's stated capital
   * covers scales the reading (P(capital ≤ allowed), as `sellingDays` reads
   * the deadline), and a design whose worst case the goal's capital covers
   * whole is not discounted for exposure — the owner allowed that money.
   */
  const hoursPerDeal = unfavourableHigh(one.hours);
  const byHours = input.hours === null || input.hours === undefined ? Infinity : hoursPerDeal > 0 ? input.hours / hoursPerDeal : Infinity;
  const deals = Math.min(byHours, one.repeatable ? Math.min(conservative(one.volume), input.contactsPerDay * selling * respond * close) : close * inTime);
  const capitalFit = shareWithin(one.capital, input.capital);
  const usesCapital = arrangement.stress.exposure !== 'SAFE' && input.capital !== null && input.capital !== undefined && input.capital > 0 && capitalFit >= 1;
  const covered = usesCapital && arrangement.stress.exposure === 'BOUNDED';
  const weight = (covered ? 1 : (EXPOSURE_WEIGHT[arrangement.stress.exposure] ?? 0)) * capitalFit;
  /*
   * One deal puts at most what the goal still needs toward it, and that cap is
   * taken on the deal before its chance, never on the expectation after it
   * (production 2026-11-20, goal wst_7b4fcbb5f2384f31b6c3: one-offs priced
   * $54K–$104K against $10K still needed read close × in-time × the whole
   * price, so a nominal price the goal cannot use outranked designs it could;
   * a $3M one-off at close 0.26 read as the whole goal). Expected contribution
   * is P(deal) × min(price, remaining): the part of a price above the goal is
   * never credited to an unknown close (invariant 39).
   */
  const read = (unit: number) => Math.min(input.remaining, Math.max(0, deals * Math.min(unit, input.remaining) * weight));
  const money = (x: number) => Math.round(x).toLocaleString('en-US');
  const daysLow = one.daysToCash.low ?? one.daysToCash.value;
  const capitalLow = one.capital.low ?? one.capital.value;
  const hoursLow = one.hours.low ?? one.hours.value;
  const misfit =
    daysLow !== null && daysLow > input.daysLeft
      ? `its money settles no sooner than ${Math.round(daysLow)} days, after the ${input.daysLeft} this goal has left`
      : input.capital !== null && input.capital !== undefined && capitalFit <= 0
        ? `it ties up ${capitalLow !== null && capitalLow > 0 ? `at least ${money(capitalLow)}` : `money (swept ${money(capitalLow ?? 0)}–${money(one.capital.high ?? one.capital.value ?? 0)})`} before money comes in, and this goal allows ${money(input.capital)}`
        : input.hours !== null && input.hours !== undefined && hoursLow !== null && hoursLow > input.hours
          ? `one deal needs at least ${Math.round(hoursLow)} owner hours, more than the ${Math.round(input.hours)} owner hours this goal has`
          : null;
  // A deal losing money at the middle readings: cut when something established its cost; read at the
  // margin when the cost is only the blind sweep anchored on the top price (production arr_0a5793917577).
  const loss = misfit ? null : losesMoneyPerDeal(one);
  const blindCost = one.directCost.provenance === 'UNKNOWN' && !one.directCost.inferred;
  const lossMisfit = loss && !blindCost ? loss : null;
  const flag = loss && blindCost ? `${loss} (the cost is a blind sweep nobody established), so it is read as keeping nothing at the middle and enters only on its upside` : null;
  const costMid = middle(one.directCost) ?? 0;
  const fitNote = [
    input.capital !== null && input.capital !== undefined ? `capital: ${Math.round(capitalFit * 100)}% of its swept up-front money within the ${money(input.capital)} allowed${covered ? ', worst case covered' : ''}` : null,
    Number.isFinite(byHours) ? `owner hours: at most ${byHours.toFixed(1)} deal(s) in ${Math.round(input.hours!)} h at ${hoursPerDeal.toFixed(1)} h/deal` : null,
  ].filter(Boolean);
  return {
    value: misfit || lossMisfit || flag ? 0 : read(price),
    upside: misfit || lossMisfit ? 0 : read(flag ? Math.max(0, Math.max(price, top) - costMid) : Math.max(price, top)),
    basis: `${deals.toFixed(2)} deal(s) in ${input.daysLeft} days × ${Math.round(price)} (${arrangement.value.tier}: ${Math.round(position * 100)}% of the way from p10 to p50${c ? `, × a ${Math.round(share * 1000) / 10}% commission (${c.basis.toLowerCase()})` : ''}) × ${weight.toFixed(2)} for ${arrangement.stress.exposure.toLowerCase()} exposure; unknown links at their ${Math.round(SCREEN_QUANTILE * 100)}th percentile${fitNote.length ? `; ${fitNote.join('; ')}` : ''}`,
    misfit: misfit ?? lossMisfit,
    flag,
    capitalFit,
    usesCapital,
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
  /** The kept arrangement the model reads it exactly as (`modelledTwinKey`): one strategy, this design an alternative way to run it. */
  sameModelAs?: string;
}
/** A design of the same buyers the model reads exactly as a kept one: how it would be run differently, which the plan's numbers do not price. */
export interface ArrangementAlternative {
  arrangementKey: string;
  label: string;
  differs: string;
}
/** A constructed arrangement that did, and which slot it took. */
export interface ArrangementPick {
  arrangementKey: string;
  label: string;
  population: string;
  screen: number;
  upside: number;
  /** `LEADER` (held from the goal's last readings), `STRUCTURE:<base>` or `PAID:<funding>/<repeat>` (the strongest of its kind), `PRICE_VARIABLE`, `CAPITAL` (the strongest design using the goal's stated up-front money), `UPSIDE`, or `SCREEN`. */
  slot: string;
  basis: string;
  /** Designs of the same buyers the model reads identically, recorded here rather than entered as members of their own. */
  alternatives?: ArrangementAlternative[];
}
export interface ArrangementSelection {
  /** Constructed arrangements read. */
  considered: number;
  picked: ArrangementPick[];
  /** The strongest cut ones first, at most `CUT_RECORDED`. */
  cut: ArrangementCut[];
  cutCount: number;
  /**
   * Every cut, counted by its reason (`cutReasonClass`), most first: the
   * counts sum to `cutCount`, so no cut is discarded unseen when only the
   * strongest `CUT_RECORDED` are named (invariant 47).
   */
  reasons: Array<{ reason: string; count: number }>;
  /** The buyer populations of the designs refused for want of a price, most designs first (`UnpricedPopulation`). */
  unpriced: UnpricedPopulation[];
}

/**
 * A cut's reason as a class: the arrangement keys, quoted names and figures
 * that make each reason specific are taken out, and a modelled twin's long
 * account of how it differs is left on the cut itself. Pure.
 *
 * Production 2026-11-20 (goal wst_7b4fcbb5f2384f31b6c3, run 44826035355):
 * "9 of 404 … (395 cut)" was traced with the reasons of only the 40 cuts
 * `CUT_RECORDED` names — 28 for owner hours, 11 modelled twins — so about 355
 * cuts carried no reason anyone could read, and the trace's own digit
 * normalisation turned the twins' keys into "NbNdfcbN".
 */
export function cutReasonClass(reason: string): string {
  return reason
    .replace(/, so it is that strategy run another way: .*$/, ', so it is that strategy run another way')
    .replace(/\b(?:arr_)?[0-9a-f]{12}\b/g, 'another design')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d[\d,.]*/g, 'N');
}

const designKey = (a: ConstructedArrangement) => `${a.design.base}/${a.design.funding}/${a.design.aggregation}/${a.design.repeat}`;
const paidKey = (a: ConstructedArrangement) => `${a.design.funding}/${a.design.repeat}`;
/** The market every design over one buyer population shares in the engine. */
export const populationMarket = (population: string) => `${ARRANGEMENT_ID_PREFIX}market:${population}`;

/**
 * Everything the goal model reads of a modelled opening, with its identity
 * (id, title, key, the notes and source refs that name it) left out: two
 * openings with one twin key are one line to the engine. Pure.
 *
 * Production 2026-11-20 (wst_db2e2e0e5204477692d5): three designs over
 * "Local businesses buying a slot on a shared direct-mail postcard" — PRODUCE
 * prepaid, BROKER threshold presale, POOL threshold presale, all recurring —
 * entered the model as three members. `arrangementOpening` reads a design only
 * through its exposure, whether it repeats and a pooled run's observed cost;
 * with all three SAFE, recurring and unpriced (one MECHANISM sweep over the
 * same comparables), every input was the same draw. The engine split outreach
 * 50/25/25 across indistinguishable offers, read them as partly independent
 * risk, and the three took every design slot their buyers had.
 */
export function modelledTwinKey(one: PlannedOpening): string {
  const input = (x: ModelInput | undefined) => (x ? { value: x.value, low: x.low, high: x.high, provenance: x.provenance, distribution: x.distribution ?? null, inferred: x.inferred ?? null, takeShare: x.takeShare ?? null } : null);
  const o = one.opportunity;
  const { arrangementKey: _key, ...estimated } = one.estimated ?? ({ arrangementKey: '' } as NonNullable<ModelledOpportunity['estimated']>);
  const pv = one.priceVariable;
  return JSON.stringify([
    one.marketKey ?? o.id,
    one.tier,
    one.repeatable,
    ...(['price', 'capital', 'hours', 'daysToCash', 'close', 'respond', 'directCost', 'volume'] as const).map((k) => input(one[k])),
    one.agreed,
    one.agreedValue,
    one.agreedDeals,
    one.fulfilledBy ? [one.fulfilledBy.value, one.fulfilledBy.provenance] : null,
    one.competitiveAward,
    one.channel ? { ...one.channel, perDay: input(one.channel.perDay) } : null,
    one.fundedByBuyer ?? false,
    one.fulfilment ?? null,
    one.stakeDeals ?? null,
    one.gate ?? null,
    one.deposit ?? null,
    one.terms ?? null,
    estimated,
    pv ? [pv.runCost, pv.prices, pv.swept, pv.remaining] : null,
    one.commission ? [one.commission.basis, one.commission.low, one.commission.high, one.commission.buyerPrice] : null,
    [o.mechanism, o.industry, o.currency, o.paymentTerms ?? null, o.fulfillmentOwner ?? null, o.peakFundingCents ?? null, o.projectId],
  ]);
}

/** How a design differs from the kept one it is modelled exactly as, in a reader's words. Pure. */
function designDifference(kept: ConstructedArrangement, twin: ConstructedArrangement): string {
  const parts: string[] = [];
  const who = (a: ConstructedArrangement) => (STRUCTURES[a.design.base].needsSupply ? 'a supplier fulfils' : 'Brain fulfils');
  if (kept.design.base !== twin.design.base) parts.push(`${STRUCTURES[twin.design.base].label} (${who(twin)}) rather than ${STRUCTURES[kept.design.base].label} (${who(kept)})`);
  if (kept.design.funding !== twin.design.funding) parts.push(`money moves ${twin.design.funding} rather than ${kept.design.funding}`);
  if (kept.design.aggregation !== twin.design.aggregation) parts.push(`buyers ${twin.design.aggregation} rather than ${kept.design.aggregation}`);
  if (kept.design.repeat !== twin.design.repeat) parts.push(`repeats ${twin.design.repeat} rather than ${kept.design.repeat}`);
  if ((kept.need?.ref ?? null) !== (twin.need?.ref ?? null)) parts.push(`the need "${twin.need?.name ?? 'unspecified'}"`);
  if ((kept.supply?.ref ?? null) !== (twin.supply?.ref ?? null)) parts.push(`the supply "${twin.supply?.name ?? 'unspecified'}"`);
  return parts.length ? parts.join('; ') : 'nothing but its construction key';
}

/**
 * Which constructed arrangements enter the model, and why the rest do not.
 *
 * Production (lens S, 2026-11-14): every repeatable design scored exactly the
 * remaining amount and the tie broke on the opportunity id — a sha256 of the
 * key — so which 12 of up to 404 designs a plan could ever use was a coin
 * flip, and a strong DIRECT design the engine preferred was routinely cut,
 * after which no later stage could bring it back. Now:
 *
 *   1. every candidate is screened quantitatively (`screenArrangement`) on
 *      the goal's own terms — its days, what it still needs, and the capital
 *      and hours it states — and one that cannot fit them (money settling
 *      only after the deadline, capital beyond what it allows, a deal needing
 *      more hours than it has, or every deal losing money) is cut with that
 *      reason, leader or not; the rest are ordered by that reading, then
 *      evidence tier, observations, exposure and the constructor's own order
 *      — never by id; when the goal states capital, the strongest design that
 *      puts it to work takes a `CAPITAL` slot;
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
  input: ArrangementInput & {
    beforeProofCents: number | null;
    remaining: number;
    exclusions: Parameters<typeof excludedBy>[1];
    limit?: number;
    daysLeft?: number | null;
    contactsPerDay?: number;
    /** Money the goal allows tied up before proof (major units); null or absent when nobody stated it. */
    capitalAvailable?: number | null;
    /** The owner's hours the goal has (`target.hoursCeiling`); null or absent when nobody stated them. */
    hoursAvailable?: number | null;
    /**
     * Prices other buyers in the project are published as paying. An
     * arrangement nothing prices for its own buyers is swept across them
     * (MECHANISM bounds, never certifiable) instead of being cut; without
     * any, it stays out with that reason.
     */
    otherPrices?: readonly ComparablePrice[];
  },
): { openings: PlannedOpening[]; reserve: PlannedOpening[]; selection: ArrangementSelection; conversions: Map<string, ModelledOpportunity | null> } {
  const limit = input.limit ?? MAX_ESTIMATED_ARRANGEMENTS;
  // Each arrangement's `estimatedFromArrangement`, as read here: the plan candidate reuses it rather than converting again (W2c).
  const conversions = new Map<string, ModelledOpportunity | null>();
  const daysLeft = input.daysLeft && input.daysLeft > 0 ? input.daysLeft : 30;
  const contactsPerDay = input.contactsPerDay ?? CONTACTS_PER_DAY_BOUNDS.low;
  const cut: ArrangementCut[] = [];
  type Value = ConstructedArrangement['value'];
  type Row = { arrangement: ConstructedArrangement; one: PlannedOpening; screen: ArrangementScreen; order: number; population: string; value: Value };
  const rows: Row[] = [];
  /*
   * Production 2026-11-19 (release e1daa132): once comparable pools were held
   * to one order of magnitude (#1136), ~304 of 307 designs per goal were cut
   * here as "no comparable price", and the cut was the only record — nothing
   * turned it into a question, so price bound every goal and no plan reading
   * carried a research row about it. Each refused design's buyers are noted
   * with the construction's own price question; the goal tick sends one per
   * population (`sendPortfolioNeeds`), whose declared answer files the price
   * every design over those buyers reads.
   */
  const unpriced = new Map<string, UnpricedPopulation>();
  const noteUnpriced = (arrangement: ConstructedArrangement) => {
    const held = unpriced.get(arrangement.demand.ref);
    if (held) return void (held.designs += 1);
    const ask = nextInputQuestion(arrangement, input.currency, input.exclusions);
    if (!ask || ask.part !== 'value') return;
    unpriced.set(arrangement.demand.ref, { population: arrangement.demand.ref, buyer: arrangement.demand.name, designs: 1, arrangementKey: arrangement.key, label: arrangement.label, question: ask.question });
  };
  arrangements.forEach((arrangement, order) => {
    const population = arrangement.demand.ref;
    const no = (reason: string) => cut.push({ arrangementKey: arrangement.key, label: arrangement.label, population, screen: null, upside: null, reason });
    // Judged on what the arrangement is — its label, sector and buyer — never on its research question,
    // which carries Brain's own instructions ("leave out government contracts", "the owner does no
    // physical work") and so matched every exclusion: production read 0 of 404 (2026-11-06).
    const what = `${arrangement.label} ${arrangement.sector ?? ''} ${arrangement.demand.name}`;
    /*
     * One organisation is a payer, not a population (production, 2026-11-19:
     * arr_53ae6fed770b, built over "GitHub", led almost every goal's plan). An
     * arrangement read back from the library, constructed before
     * `namesABuyerPopulation` refused such names, is cut here with the reason,
     * so it can never take a slot, lead a candidate or name a plan's steps.
     */
    if (!namesABuyerPopulation(arrangement.demand.name)) return no(`its buyers ("${arrangement.demand.name.slice(0, 80)}") name one organisation or no buyer at all, not a population a list can be built of`);
    if (excludedBy(what, input.exclusions)) return no("the goal's owner excluded what it is");
    if (breaksOperatingModel(operatingFit({ title: arrangement.label, offerScope: arrangement.demand.name }))) return no('it breaks the operating model');
    if (arrangement.stress.exposure === 'EXCEEDS') return no('its known worst case exceeds the limits');
    let one: ModelledOpportunity | null = estimatedFromArrangement(arrangement, input);
    conversions.set(arrangement.key, one);
    let value: Value = arrangement.value;
    let screenValue: Value | null = null;
    if (one?.priceVariable) {
      // Price is the decision variable: the screen reads it at its break-even floor, never inside the
      // range (invariant 39), and the upside at the price the target needs.
      const inf = one.price.inferred!;
      value = { tier: 'ASSUMED', p10: inf.p10, p50: inf.p50, p90: inf.p90, observations: 0 };
      screenValue = { ...value, p50: inf.p10 };
    }
    if (!one) {
      /*
       * Nothing prices it for its own buyers (UNKNOWN, or a MECHANISM pool
       * PRICE-POOL refused as their price). Production, 2026-11-15: after
       * PRICE-POOL kept other payers' prices out of each arrangement's own
       * reconstruction, almost no arrangement's buyers had a price of their
       * own, so all 404 were cut here as "nothing reconstructs its value" and
       * the plan compared 11 found openings and 0 constructed estimates. It
       * enters instead swept across the prices comparable buyers are published
       * as paying — honest MECHANISM bounds, provenance UNKNOWN, which
       * `inputEvidence` never lets certify a plan — the path S-11 built for
       * invented designs. With no published price anywhere, it stays out.
       */
      const comparable = comparablePricesFor(arrangement, input.otherPrices ?? [], input.currency);
      if ('refused' in comparable) {
        noteUnpriced(arrangement);
        return no(`nothing reconstructs its value, and ${comparable.refused}`);
      }
      const swept = sweptOverOtherPrices(arrangement, input, comparable.prices, false, comparable.scope);
      if ('refused' in swept) {
        noteUnpriced(arrangement);
        return no(`nothing reconstructs its value, and ${swept.refused}`);
      }
      one = swept;
      const inf = swept.price.inferred!;
      value = { tier: 'MECHANISM', p10: inf.p10, p50: inf.p50, p90: inf.p90, observations: inf.observations };
      // Nothing prices these buyers: the screen reads them at the lowest comparable price, never
      // at a point inside other buyers' range, so a sweep never outranks an evidenced price (invariant 39).
      const floor = Math.min(...comparable.prices);
      screenValue = { ...value, p10: floor, p50: floor };
    }
    // One buyer population is one market however many designs reach it: the engine caps their deals together.
    const planned: PlannedOpening = { ...one, marketKey: populationMarket(population) };
    const screen = screenArrangement(one, { value: screenValue ?? value, stress: arrangement.stress }, { remaining: input.remaining, daysLeft, contactsPerDay, capital: input.capitalAvailable ?? null, hours: input.hoursAvailable ?? null });
    // The goal's own terms leave it out, whatever it led with before: recorded with the reason, never a slot.
    if (screen.misfit) return void cut.push({ arrangementKey: arrangement.key, label: arrangement.label, population, screen: 0, upside: 0, reason: `it does not fit this goal: ${screen.misfit}` });
    rows.push({ arrangement, one: planned, screen, order, population, value });
  });
  const byScreen = (a: Row, b: Row) =>
    b.screen.value - a.screen.value ||
    (TIER_RANK[a.value.tier] ?? 9) - (TIER_RANK[b.value.tier] ?? 9) ||
    b.value.observations - a.value.observations ||
    (EXPOSURE_RANK[a.arrangement.stress.exposure] ?? 9) - (EXPOSURE_RANK[b.arrangement.stress.exposure] ?? 9) ||
    a.order - b.order;
  rows.sort(byScreen);
  // The same design over the same buyers is one estimate: only its strongest reading competes —
  // or the goal's leader, which the last readings picked over the rest (P4).
  const designs = new Set<string>(rows.filter((r) => r.arrangement.leader).map((r) => `${r.population}|${designKey(r.arrangement)}`));
  const candidates = rows.filter((r) => {
    if (r.arrangement.leader) return true;
    const key = `${r.population}|${designKey(r.arrangement)}`;
    if (!designs.has(key)) {
      designs.add(key);
      return true;
    }
    cut.push({ arrangementKey: r.arrangement.key, label: r.arrangement.label, population: r.population, screen: r.screen.value, upside: r.screen.upside, reason: 'the same design over the same buyers is already read' });
    return false;
  });
  /*
   * A different design over the same buyers that the model reads exactly as
   * one already in is the same strategy to the plan (`modelledTwinKey`): the
   * engine could only split outreach across identical draws and read them as
   * partly independent risk. The first-ranked (a leader first) enters; each
   * twin is recorded on it as an alternative way to run it, with what differs,
   * and cut with that reason, so its slot goes to other buyers and it is never
   * discarded unseen (invariant 47). A design the model does tell apart — a
   * different exposure, repeat, run cost or price — still enters on its own.
   */
  const twinOf = new Map<Row, Row>();
  const firstByTwin = new Map<string, Row>();
  for (const r of [...candidates.filter((x) => x.arrangement.leader), ...candidates.filter((x) => !x.arrangement.leader)]) {
    const key = modelledTwinKey(r.one);
    const kept = firstByTwin.get(key);
    if (kept) twinOf.set(r, kept);
    else firstByTwin.set(key, r);
  }
  const alternativesOf = new Map<Row, ArrangementAlternative[]>();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const r = candidates[i]!;
    const kept = twinOf.get(r);
    if (!kept) continue;
    candidates.splice(i, 1);
    const differs = designDifference(kept.arrangement, r.arrangement);
    alternativesOf.set(kept, [{ arrangementKey: r.arrangement.key, label: r.arrangement.label, differs }, ...(alternativesOf.get(kept) ?? [])]);
    cut.push({
      arrangementKey: r.arrangement.key,
      label: r.arrangement.label,
      population: r.population,
      screen: r.screen.value,
      upside: r.screen.upside,
      reason: `the model reads it exactly as ${kept.arrangement.key} over the same buyers (same price, cost, close, capital and market), so it is that strategy run another way: ${differs}`,
      sameModelAs: kept.arrangement.key,
    });
  }
  const taken = new Map<Row, string>();
  const perPopulation = new Map<string, number>();
  const take = (r: Row, slot: string): boolean => {
    if (taken.has(r) || taken.size >= limit) return false;
    if ((perPopulation.get(r.population) ?? 0) >= DESIGNS_PER_POPULATION) return false;
    taken.set(r, slot);
    perPopulation.set(r.population, (perPopulation.get(r.population) ?? 0) + 1);
    return true;
  };
  // 1a. The goal's leaders (P4): what its last readings picked or led with enters first, strongest first,
  // within `LEADER_SLOTS`. Construction already holds them through the cap; without this the model's few
  // slots dropped them on screens saturated at the remaining amount, decided by which others were composed.
  let leaders = 0;
  for (const r of candidates) {
    if (leaders >= LEADER_SLOTS) break;
    if (r.arrangement.leader && take(r, 'LEADER')) leaders += 1;
  }
  // 1b. The strongest arrangement whose price is the decision variable over an observed supply cost: the
  // only kind holding an observed number about itself, so its break-even is always read by the engine.
  const variable = candidates.find((r) => r.one.priceVariable);
  if (variable) take(variable, 'PRICE_VARIABLE');
  // 1c. When the goal states money it allows up front, the strongest design that puts it to work — one
  // that ties money up before buyers commit, all of it within what the goal allows — so the engine
  // compares using the capital with leaving it idle ($50K goal with $25K capital, transfer test: none did).
  const capitalUser = candidates.find((r) => r.screen.usesCapital && r.screen.value > 0 && !taken.has(r));
  if (capitalUser) take(capitalUser, 'CAPITAL');
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
          : r.screen.flag && r.screen.value <= 0
            ? r.screen.flag
            : r.screen.value <= 0
            ? 'it settles nothing by the deadline at the conservative reading'
            : `below the cut: screens ${Math.round(r.screen.value)} against ${Math.round(weakest)} for the weakest of the ${picked.length} kept`,
    });
  cut.sort((a, b) => (b.screen ?? -1) - (a.screen ?? -1) || a.arrangementKey.localeCompare(b.arrangementKey));
  const reasons = new Map<string, number>();
  for (const c of cut) {
    const reason = cutReasonClass(c.reason);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    openings: picked.map((r) => r.one),
    reserve: left.filter((r) => r.screen.value > 0).slice(0, RESERVE_ARRANGEMENTS).map((r) => r.one),
    conversions,
    selection: {
      considered: arrangements.length,
      picked: picked.map((r) => ({ arrangementKey: r.arrangement.key, label: r.arrangement.label, population: r.population, screen: r.screen.value, upside: r.screen.upside, slot: taken.get(r)!, basis: [r.screen.basis, r.screen.flag, r.one.priceVariable?.sentence].filter(Boolean).join('. '), ...(alternativesOf.has(r) ? { alternatives: alternativesOf.get(r)! } : {}) })),
      cut: cut.slice(0, CUT_RECORDED),
      cutCount: cut.length,
      // Stable: most first, then the order the strongest cut of each class was met in.
      reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      // Stable: most designs first, then the constructor's order (a Map keeps insertion order and sort is stable).
      unpriced: [...unpriced.values()].sort((a, b) => b.designs - a.designs).slice(0, CUT_RECORDED),
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
export { COMPETITIVE_AWARD };

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
  /** Each arrangement's conversion as selection read it, null where it has none: what plan candidates reuse (W2c). */
  arrangementConversions?: ReadonlyMap<string, ModelledOpportunity | null> | null;
  /**
   * The keys of the constructed arrangements inside the goal's own scope
   * (`arrangementOutOfScope`: its one industry, its recurring unit, its days
   * and up-front money). A plan never leads with one outside it (plan integrity, `planIntegrity`).
   */
  arrangementsInScope?: string[];
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

/**
 * An inbound offer's money-committed count, read from what a person or a sourced
 * claim recorded on the card's `conversionRates` field: "12 pre-orders from 240
 * unique visitors", "9 paid deposits out of 310 visitors", "31 pledges of 500
 * unique visitors".
 *
 * Only money commits: a pre-order, deposit, pledge, paid order or purchase. A
 * signup, a waitlist join, a click or a fake-door "buy now" is interest, not
 * purchase (no published study measures how well those predict buying, and the
 * practitioner guides say a signup overstates willingness to pay —
 * kromatic.com/real-startup-book/landing-page-smoke-test), so it never matches
 * and is never fed in as a close rate. The denominator is unique visitors, the
 * smoke test's own measure. Null when the text states no such count.
 */
export function readInboundCommitments(text: string): { paid: number; visitors: number; unit: string } | null {
  const num = (raw: string) => Number(raw.replace(/,/g, ''));
  const match = /(\d[\d,]*)\s+(?:paid\s+|money[- ]committed\s+)?(pre-?orders?|deposits?|pledges?|paid orders?|purchases?)\b[^.;]*?\b(?:from|of|out of|among|per)\s+(\d[\d,]*)\s+(?:unique\s+)?visitors?\b/i.exec(text);
  if (!match) return null;
  const paid = num(match[1]!);
  const visitors = num(match[3]!);
  if (!Number.isFinite(paid) || !Number.isFinite(visitors) || visitors <= 0 || paid > visitors) return null;
  return { paid, visitors, unit: match[2]!.toLowerCase() };
}

/**
 * A measured win rate on priced offers, read from the card's `conversionRates`
 * field: "6 wins from 40 quotes", "3 signed out of 18 proposals", "9 contracts
 * awarded of 52 bids". Each trial is a priced offer an identified buyer
 * received, and each success a buyer who accepted it — the same trial and the
 * same outcome as an agreement per contact in Brain's own outreach record, so
 * it is read as the opening's measured close on the same floor
 * (LESSON_MIN_SAMPLE offers), its sample size carried in the measured
 * interval rather than discarded. A visitor or a click is not a priced
 * offer: those stay with `readInboundCommitments` and its visitor floor. Null
 * when the text states no such count.
 *
 * Agreements per buyer contacted ("6 agreements from 40 contacts", "9 orders
 * of 30 stores asked") are the same measurement (planningReliability round 4):
 * each contact is an identified buyer asked for this offer and each agreement
 * one who said yes — exactly the trial and outcome of `cash_outcomes`, which
 * Brain's own record already reads as a measured close. Before, only a quote,
 * proposal or bid was a trial, so an outreach play's own measured rate was
 * dropped and its conversion read as unknown.
 *
 * Orders per member offered ("14 orders from 520 members") are the same
 * measurement again (planningReliability round 5): each member is an identified
 * buyer on a list the offer went to, and each order one who bought — a share
 * of a counted list, never of anonymous traffic. Dropping it read a measured
 * play's conversion as unknown. A membership the offer has already saturated
 * is not thereby passed: the rate is a share of prospects, so
 * `prospectsAsked` bounds what it can still win by the members that exist. The
 * size of a group ("18 orders from a 14,000-member group") is still not a
 * count of members offered, and is not read.
 */
export function readOfferWins(text: string): { won: number; offers: number; unit: string } | null {
  const num = (raw: string) => Number(raw.replace(/,/g, ''));
  const match = /(\d[\d,]*)\s+(?:[a-z-]+\s+){0,2}?(wins?|won|signed|accepted|awarded|agreements?|agreed|contracts?|deals?|jobs?|orders?|sales?|bookings?|clients?|customers?)\b[^.;]*?\b(?:from|of|out of|among|on|across)\s+(\d[\d,]*)\s+(?:[a-z-]+\s+){0,2}?(quotes?|quotations?|proposals?|bids?|estimates?|tenders?|priced offers?|offers? sent|pitches|contacts?|contacted|asked|approached|members?)\b/i.exec(text);
  if (!match) return null;
  const won = num(match[1]!);
  const offers = num(match[3]!);
  if (!Number.isFinite(won) || !Number.isFinite(offers) || offers <= 0 || won > offers) return null;
  return { won, offers, unit: match[4]!.toLowerCase() };
}

/**
 * Paid deals per ad click, read from the card's `conversionRates` field: "46
 * bookings from 520 clicks", "12 paid orders out of 900 ad clicks"
 * (planningReliability round 6). A click is the traffic a paid booking was
 * measured on — the denominator, exactly as a unique visitor is a landing
 * page's — so the outcome is a deal that was paid for and the click is never
 * the outcome: "60 clicks on buy now" stays interest, not purchase. It is read
 * on the visitor floor (INBOUND_MIN_VISITORS), because a click is anonymous
 * traffic, not a priced offer an identified buyer received; below the floor it
 * is an anecdote and the conversion stays unknown. Before, a booking per click
 * matched neither reader, so a play whose own ads had measured hundreds of
 * clicks read its conversion as never asked. Null when the text states no
 * such count.
 */
export function readClickConversions(text: string): { paid: number; clicks: number; unit: string } | null {
  const num = (raw: string) => Number(raw.replace(/,/g, ''));
  const match = /(\d[\d,]*)\s+(?:paid\s+)?(bookings?|orders?|sales|purchases?|jobs?|pre-?orders?|deposits?)\b[^.;]*?\b(?:from|of|out of|among|per)\s+(\d[\d,]*)\s+(?:[a-z-]+\s+){0,2}?clicks?\b/i.exec(text);
  if (!match) return null;
  const paid = num(match[1]!);
  const clicks = num(match[3]!);
  if (!Number.isFinite(paid) || !Number.isFinite(clicks) || clicks <= 0 || paid > clicks) return null;
  return { paid, clicks, unit: match[2]!.toLowerCase() };
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
function inferOr(knowledge: CashKnowledge | null, quantity: CashQuantity, opportunity: InferenceTarget, now: Date, fallback: ModelInput, scale = 1, what = ''): ModelInput {
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
 * The money an opening ties up, inferred only where its own mechanism speaks
 * (F6, 2026-11-15). An inference resting on other mechanisms' openings (tier
 * MECHANISM: a grant's outlay read off resale and auction openings) says
 * nothing about this one: it is UNKNOWN and swept from nothing to the price,
 * never a floor that refuses the opening. Pure.
 */
export function ownMechanismCapital(inferred: ModelInput, top: number): ModelInput {
  if (inferred.inferred?.tier !== 'MECHANISM') return inferred;
  return unknown(0, top, 'only openings of other mechanisms state the money tied up, which is no evidence about this one; swept from nothing to the whole price');
}

/**
 * A reconstructed estimate as a model input: the one conversion every caller
 * uses, so the evidence it carries (tier, observations, and the sample the
 * assurance redraws from, Q2-1/Q2-12) is never dropped by a hand-built copy.
 */
export function estimateInput(est: Estimate, scale = 1, what = ''): ModelInput {
  // The samples are scaled inside the export, from the estimate's one sorted copy (W2c): never copied and re-sorted per reader.
  const scaled: Estimate = scale === 1 ? est : { ...est, p05: est.p05 * scale, p10: est.p10 * scale, p50: est.p50 * scale, p90: est.p90 * scale, p95: est.p95 * scale };
  const exported = toScenarioInputScaled(est, scaled, scale);
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

/**
 * How far from every figure a price fact states the card's price may sit
 * before the fact contradicts it rather than restating it.
 */
export const PRICE_CONTRADICTION_RATIO = 1.5;

/**
 * Whether the price fact contradicts the card's price: it states one or more
 * whole-deal figures and the card's figure is more than
 * PRICE_CONTRADICTION_RATIO away from all of them (planningReliability fam-07,
 * ho-13: a card at $600 read as evidence while its source said $60). A fact
 * that states no whole-deal figure, or one the card's figure agrees with,
 * contradicts nothing. Returns the stated figure nearest the card.
 */
export function priceContradiction(cardMajor: number, factText: string, currency: string): { stated: number; text: string } | null {
  const figures = readMoneyFigures(factText, currency).filter((one) => !one.perUnit).map((one) => one.cents / 100).filter((one) => one > 0);
  if (figures.length === 0 || !(cardMajor > 0)) return null;
  const agrees = figures.some((one) => cardMajor <= one * PRICE_CONTRADICTION_RATIO && cardMajor * PRICE_CONTRADICTION_RATIO >= one);
  if (agrees) return null;
  const nearest = figures.reduce((best, one) => (Math.abs(Math.log(one / cardMajor)) < Math.abs(Math.log(best / cardMajor)) ? one : best));
  return { stated: nearest, text: `"${factText.slice(0, 120)}"` };
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

/**
 * Everything the model needs to know about one opportunity, read from its rows.
 * Exported so its branches can be driven through the real card-fact read
 * (tests/inboundBuyerValidationA10K.test.ts drives the inbound one).
 */
export async function modelOpportunity(
  opportunity: CashOpportunity,
  index: number,
  tier: string,
  currency: string,
  lessons: Awaited<ReturnType<typeof cashOutcomeLessons>>,
  knowledge: CashKnowledge | null = null,
  now: Date = new Date(),
  windowDays = 30,
  /** The deliverables Brain's capability frame proves (`executionFrame`): a found opening asking for one is Brain's to perform. */
  delivers: readonly string[] = [],
): Promise<ModelledOpportunity | { reason: string }> {
  const fact = await cardFactMap(opportunity.id, opportunity.projectId ?? undefined);
  const ref: SourceRef = { kind: 'CASH_OPPORTUNITY', ref: opportunity.id };

  // Price: the column, else the low end of a published revenue range.
  let price: ModelInput | null = null;
  if (opportunity.priceCents !== null && opportunity.priceCents > 0) {
    const priceFact = fact('price');
    const p = kindToProvenance(priceFact);
    const card = opportunity.priceCents / 100;
    const contradiction = priceFact ? priceContradiction(card, priceFact.value, currency) : null;
    price = contradiction
      ? {
          // The card's figure is not evidence when the price fact's own figure contradicts it: the
          // price is contested, and the plan reads it at its lower end until somebody settles it.
          value: null,
          low: Math.min(card, contradiction.stated),
          high: Math.max(card, contradiction.stated),
          provenance: 'ASSUMPTION',
          source: p.source ?? ref,
          note: `contested: the card says ${card}, but the price fact states ${contradiction.text}; settle the price before planning on it`,
        }
      : known(card, p.provenance === 'UNKNOWN' ? 'ASSUMPTION' : p.provenance, p.source ?? ref, 'the price on the card');
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
        : ownMechanismCapital(inferOr(knowledge, 'capitalShare', opportunity, now, unknown(0, top, 'nobody has established the money tied up; swept from nothing to the whole price'), top, ' as a share of the top price'), top);

  const hoursFact = fact('hours');
  const hours =
    opportunity.humanHours !== null
      ? known(opportunity.humanHours, hoursFact ? kindToProvenance(hoursFact).provenance : 'ASSUMPTION', ref, 'hours of work per deal')
      : foundOwnerHours(opportunity, delivers, ref) ?? unknown(1, 40, 'nobody has established the hours; swept from 1 to 40 per deal');

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
  // An inbound offer's own money-committed count (pre-orders, deposits, pledges
  // against unique visitors), recorded on the card's conversionRates field.
  const inboundFact = fact('conversionRates');
  const inbound = inboundFact && inboundFact.kind !== 'RECOMMENDATION' ? readInboundCommitments(inboundFact.value) : null;
  // An agreement is one buyer's yes, and is counted as that money — never as a
  // rate the next buyer will match. More buyers need a measured rate of their own.
  // Below the directional floor the inbound count is an anecdote: it never becomes a measured rate, and the
  // close falls back to Brain's own record or stays unknown (invariant 39), never a favourable reading.
  const inboundMeasured = inbound !== null && inbound.visitors >= INBOUND_MIN_VISITORS;
  // A win rate on priced offers is a per-offer measurement, read on the floor Brain's own record uses.
  const offerWins = !inboundMeasured && inboundFact && inboundFact.kind !== 'RECOMMENDATION' ? readOfferWins(inboundFact.value) : null;
  const offersMeasured = offerWins !== null && offerWins.offers >= LESSON_MIN_SAMPLE;
  // Paid deals per ad click: traffic, like a visitor, so read on the visitor floor.
  const clickWins = !inboundMeasured && !offersMeasured && inboundFact && inboundFact.kind !== 'RECOMMENDATION' ? readClickConversions(inboundFact.value) : null;
  const clicksMeasured = clickWins !== null && clickWins.clicks >= INBOUND_MIN_VISITORS;
  let close: ModelInput;
  if (clickWins && clicksMeasured) {
    close = {
      ...measuredRateInput({ trials: clickWins.clicks, low: clickWins.paid, high: clickWins.paid }),
      provenance: 'HISTORICAL',
      source: kindToProvenance(inboundFact).source,
      note: `measured on this offer's own ads: ${clickWins.paid} paid ${clickWins.unit} from ${clickWins.clicks} clicks`,
    };
  } else if (offerWins && offersMeasured) {
    close = {
      ...measuredRateInput({ trials: offerWins.offers, low: offerWins.won, high: offerWins.won }),
      provenance: 'HISTORICAL',
      source: kindToProvenance(inboundFact).source,
      note: `measured on this offer's own sales: ${offerWins.won} accepted of ${offerWins.offers} ${offerWins.unit}`,
    };
  } else if (inbound && inboundMeasured) {
    // Paid commitments per unique visitor are this opening's own measured close: no outreach, no reply step.
    close = {
      ...measuredRateInput({ trials: inbound.visitors, low: inbound.paid, high: inbound.paid }),
      provenance: 'HISTORICAL',
      source: kindToProvenance(inboundFact).source,
      note: `measured on this offer's own inbound page: ${inbound.paid} money-committed ${inbound.unit} from ${inbound.visitors} unique visitors`,
    };
  } else if (lesson) {
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
  // Agreements per contact (or paid commitments per visitor) already include whether the person replied.
  const respond: ModelInput = clickWins && clicksMeasured
    ? known(1, 'HISTORICAL', close.source, 'the measured rate is paid deals per ad click, which includes showing interest')
    : offerWins && offersMeasured
    ? known(1, 'HISTORICAL', close.source, 'the measured rate is accepted offers per priced offer, which includes replying')
    : inbound && inboundMeasured
    ? known(1, 'HISTORICAL', close.source, 'the measured rate is paid commitments per unique visitor, which includes showing interest')
    : lesson
    ? known(1, 'HISTORICAL', close.source, 'the measured rate is agreements per contact, which includes replying')
    : inferOr(knowledge, 'respond', opportunity, now, unknown(0.002, 0.15, 'nobody has established how many prospects of this kind reply; swept from 0.2% to 15%'));

  const volumeFact = fact('buyerVolume');
  // A count of what the payer holds ("3,400 boats" for boat owners) counts buyers too.
  /*
   * The unit the measured rate was taken on (planningReliability round 6): a
   * win rate per bid is a share of the solicitations bid on, and a booking
   * rate per click a share of the clicks, so a volume research stated in that
   * same unit ("60 RFQs a month", "9,000 forecast clicks") counts the
   * prospects that rate applies to — read only when the volume states no
   * buyer or order count of its own.
   */
  const trialUnit = clickWins && clicksMeasured ? 'clicks' : offerWins && offersMeasured ? offerWins.unit : inbound && inboundMeasured ? 'visitors' : null;
  const counted = volumeFact
    ? readVolume(volumeFact.value, windowDays, opportunity.payer, opportunity.industry ?? null) ?? (trialUnit ? readTrialVolume(volumeFact.value, windowDays, trialUnit) : null)
    : null;
  /*
   * A price per period already contains how often the buyer is served
   * (planningReliability round 4): a shop paying $180 a month for weekly
   * sharpening is one subscription, not four purchases a month. Read from a
   * count of buyers, a recurring price's deals are the buyers, each holding one
   * subscription — never the buyers times the service's own frequency.
   */
  const perPeriodPrice = recurringRevenue(fact('price')?.value ?? null, opportunity.title);
  const volumeRead =
    counted && perPeriodPrice && counted.counted === 'BUYERS' && counted.buyers !== null && counted.everyDays !== null && counted.deals > counted.buyers
      ? { ...counted, deals: counted.buyers, basis: `${counted.buyers} reachable buyers, each holding one subscription at the price per period (its own service frequency is inside that price)` }
      : counted;
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
  /*
   * A volume statement that states no count (planningReliability round 4: "leagues
   * probably re-line fields every few weekends") says research looked at a market
   * of buyers and did not size it. That is an unknown volume — a repeatable play
   * whose MARKET_VOLUME link is missing — never one deal: reading it as a one-off
   * passed the volume link ("a one-off needs its one buyer") on a question
   * nobody answered, and then called the target unreachable at one sale
   * (invariant 39). It still counts no second sale: the volume is swept and the
   * link stays open until research sizes it.
   */
  const unsizedMarket = !!volumeFact && volumeRead === null;
  const repeatable = isTestFirstPlay(opportunity) || (volumeRead !== null && volumeRead.deals > 1 && volumeFact!.kind === 'EVIDENCE') || estimatedRepeat || unsizedMarket;
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
    prospects: repeatable && !estimatedRepeat && volumeRead?.counted === 'BUYERS' && volume.value !== null && (volume.provenance === 'EVIDENCE' || volume.provenance === 'HISTORICAL') ? volume.value : null,
    agreed: agreements.length > 0,
    agreedValue: agreements.reduce((sum, one) => sum + one.amountCents, 0) / 100,
    agreedDeals: agreements.length,
    fulfilledBy,
    columns: Object.fromEntries((Object.keys(CARD_COLUMN_FACT) as CardColumn[]).map((column) => [column, kindToProvenance(fact(CARD_COLUMN_FACT[column])).provenance])),
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
export function bestCaseReach(one: ModelledOpportunity, remaining: number, daysLeft: number, established = false, net = false): number {
  const late = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && one.daysToCash.value > daysLeft;
  if (late) return 0;
  // An award nobody has shown pays inside the window does not count as reach:
  // first it must be won, then delivered, then paid on the buyer's terms.
  if (one.competitiveAward && !(one.daysToCash.provenance === 'EVIDENCE' || one.daysToCash.provenance === 'HISTORICAL')) return 0;
  const price = one.price.high ?? one.price.value ?? 0;
  // The best case on a net target is still net: each deal at its top price less its lowest cost.
  const each = perDealToward(one, price, net, 'LOW');
  const held = agreedToward(one, net, 'LOW');
  let deals = one.repeatable ? Math.min(MAX_BUYERS_OFFERED, Math.ceil(Math.max(0, remaining - held) / Math.max(1, each))) : one.agreedValue > 0 ? 0 : 1;
  if (established && one.repeatable) deals = Math.min(deals, volumeEstablished(one) ? one.volume.value ?? 1 : 1);
  return Math.max(0, Math.min(remaining, held + deals * each));
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
/* ------------------------------------------------------------------------ *
 * What the goal's own words confine its plan to (`goalScope`, target.ts).   *
 * ------------------------------------------------------------------------ */

const SCOPE_STOP = new Set(['and', 'the', 'for', 'of', 'in', 'services', 'service', 'industry', 'sector', 'market', 'business']);

/** The words that name an industry: "commercial cleaning" → ["commercial", "cleaning"]. */
function industryWords(industry: string): string[] {
  return industry.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !SCOPE_STOP.has(w));
}

/**
 * Whether a text names the goal's industry: every word of the industry's name
 * appears in it. Pure. An opening's own `industry` decides when it has one;
 * only an opening with none is read from its title and buyer.
 */
export function namesIndustry(industry: string, text: string | null | undefined): boolean {
  const words = industryWords(industry);
  if (!text || words.length === 0) return false;
  const have = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return words.every((w) => have.has(w) || have.has(`${w}s`) || (w.endsWith('s') && have.has(w.slice(0, -1))));
}

/** A price stated per period, or a retainer or subscription: revenue that recurs from the same buyer. Pure. */
const RECURRING_PRICE = /\b(?:a|per|each|every)\s+(?:month|year|quarter|week)\b|\/\s?(?:mo|month|yr|year)\b|\bmonthly\b|\bquarterly\b|\bannual(?:ly)?\b|\bretainer\b|\bsubscription\b|\brecurring\b/i;
export function recurringRevenue(priceStatement: string | null | undefined, title: string | null | undefined): boolean {
  return RECURRING_PRICE.test(priceStatement ?? '') || /\b(?:retainer|subscription|monthly)\b/i.test(title ?? '');
}

/**
 * Why a goal's scope leaves an opening out of its plan, or null when it is in.
 * A required industry keeps only that industry's openings; a monthly
 * recurring target keeps only openings whose revenue recurs, because a
 * one-off sale adds nothing to a run-rate. Neither is an exclusion anywhere
 * else (§105): the opening stays in the project, and every other goal reads it.
 */
export function outOfGoalScope(
  scope: TargetReading['scope'],
  opening: { industry: string | null; title: string; payer: string | null },
  recurring: boolean,
): string | null {
  if (!scope) return null;
  if (scope.industry) {
    const named = opening.industry ? namesIndustry(scope.industry, opening.industry) : namesIndustry(scope.industry, `${opening.title} ${opening.payer ?? ''}`);
    if (!named) return `outside the one industry this goal names (${scope.industry})${opening.industry ? `: it is ${opening.industry}` : ''}`;
  }
  if (scope.recurring === 'MONTHLY' && !recurring) {
    return 'pays once: this goal counts a monthly recurring run-rate, which a one-off sale does not move';
  }
  return null;
}

/** What the goal's scope reads of a held opening: its industry, whether its price recurs, and its own stated days to cash. */
export interface HeldTerms {
  industry: string | null;
  title: string;
  recurring: boolean;
  days: number | null;
  /** What its own card says one deal ties up before it pays (major units), or null. */
  capital: number | null;
}

/** The same scope over a constructed arrangement: its sector and buyers for an industry, its design or what it sells for recurrence. */
export function arrangementOutOfScope(
  scope: TargetReading['scope'],
  arrangement: ConstructedArrangement,
  openings: ReadonlyMap<string, HeldTerms>,
  daysLeft: number | null = null,
  upFront: number | null = null,
): string | null {
  /*
   * The deadline: what it sells is a held opening whose own card says the
   * money takes longer than the days left. Selling it under another design
   * does not make the lot arrive sooner (rehearsal, 2026-11-18: a 7-day goal's
   * plan brought in a fee on a 21-day equipment resale).
   */
  const need = arrangement.need?.from === 'OPENING' ? openings.get(arrangement.need.ref) : undefined;
  if (daysLeft !== null && need?.days != null && need.days > daysLeft) return `what it sells ("${need.title.slice(0, 60)}") takes ${need.days} days to cash, after the ${daysLeft} left`;
  // Up-front money: a design in which Brain delivers that need itself buys what the need's own card says it ties up.
  if (upFront !== null && need?.capital != null && need.capital > upFront && !STRUCTURES[arrangement.design.base].needsSupply) {
    return `delivering what it sells ("${need.title.slice(0, 60)}") ties up ${Math.round(need.capital)} before money comes in, more than the ${Math.round(upFront)} this goal allows`;
  }
  if (!scope) return null;
  const sources = [arrangement.need, arrangement.demand, arrangement.supply].filter((p): p is NonNullable<typeof p> => !!p && p.from === 'OPENING').map((p) => openings.get(p.ref)).filter((o): o is NonNullable<typeof o> => !!o);
  if (scope.industry) {
    const named =
      namesIndustry(scope.industry, arrangement.sector) ||
      sources.some((o) => namesIndustry(scope.industry!, o.industry ?? o.title)) ||
      namesIndustry(scope.industry, `${arrangement.label} ${arrangement.demand.name}`);
    if (!named) return `outside the one industry this goal names (${scope.industry})`;
  }
  if (scope.recurring === 'MONTHLY') {
    /*
     * What it sells decides: a held opening's own price says whether its buyers
     * pay again. Renaming a one-off's design a subscription evidences nothing
     * about those buyers paying monthly (its price was paid once, GH2), so only
     * a need no held opening prices is read from the design.
     */
    const sold = arrangement.need?.from === 'OPENING' ? openings.get(arrangement.need.ref) : undefined;
    const recurs = sold ? sold.recurring : arrangement.design.repeat === 'SUBSCRIPTION';
    if (!recurs) return 'its revenue does not recur from the same buyer: this goal counts a monthly recurring run-rate';
  }
  return null;
}

export async function composeGoalModel(input: { goal: Workstream; target: TargetReading; now?: Date; arrangements?: readonly ConstructedArrangement[]; delivers?: readonly string[] }): Promise<GoalModel> {
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
  /*
   * The messaging provider's capacity and measured rates are two network reads the portfolio
   * needs only at its end; asked now, they answer while the rows below are read instead of after.
   */
  const instantly = Promise.all([instantlyCapacity().catch(() => null), instantlyMeasuredRates().catch(() => null)]);
  // The goal plan owns the freshness bar; read lazily, because the plan imports this module.
  const freshDays = (await import('../goals/plan.ts')).RECOMMENDATION_POLICY.demandFreshDays;
  // The tier is all the plan reads of the frontier (`frontierTiers`: the same derivation, without the rest of it).
  const tiers = await frontierTiers(target.projectId);
  trace(`shared frontier: ${tiers.size} opening(s)`);
  const tierOf = new Map([...tiers].map(([id, one]) => [id, one.tier as string]));
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
  // What the goal's own words confine it to (an industry, recurring revenue): this goal's plan only (§105).
  const scope = target.scope;
  const scoped = new Map<string, HeldTerms>();
  for (const opportunity of live) {
    const fact = await cardFactMap(opportunity.id, opportunity.projectId ?? undefined);
    const ttc = fact('timeToFirstCash')?.value;
    scoped.set(opportunity.id, { industry: opportunity.industry ?? null, title: opportunity.title, recurring: recurringRevenue(fact('price')?.value ?? null, opportunity.title), days: ttc ? readDays(ttc) : null, capital: opportunity.peakFundingCents !== null ? opportunity.peakFundingCents / 100 : null });
  }
  for (const opportunity of ordered) {
    const tier = tierOf.get(opportunity.id) ?? 'SIGNAL';
    const outOfScope = IN_FLIGHT.has(opportunity.state) ? null : outOfGoalScope(scope, opportunity, scoped.get(opportunity.id)?.recurring ?? false);
    if (outOfScope) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `left out by the goal's own terms: ${outOfScope}` });
      continue;
    }
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
    const modelled = await modelOpportunity(opportunity, 0, tier, target.currency, lessons, knowledge, input.now ?? new Date(), target.daysLeft, input.delivers ?? []);
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
  let arrangementConversions: Map<string, ModelledOpportunity | null> | null = null;
  let reserve: PlannedOpening[] = [];
  const upFrontCents = target.capitalBeforeProofCents ?? target.capitalCeilingCents;
  const upFrontLimit = upFrontCents === null ? null : upFrontCents / 100;
  const inScope = (input.arrangements ?? []).filter((one) => !arrangementOutOfScope(scope, one, scoped, target.daysLeft, upFrontLimit));
  if (inScope.length) {
    // What construction reads as held prices (`heldEvidence`), from the openings already loaded: no new query.
    const ownPrices = live
      .filter((one) => one.payer && one.priceCents !== null && one.priceCents > 0 && !excludedBy(`${one.title} ${one.payer ?? ''} ${one.industry ?? ''}`, exclusions))
      .map((one) => ({ value: one.priceCents! / 100, industry: one.industry, mechanism: one.mechanism, payer: one.payer }));
    const selected = selectEstimatedArrangements(inScope, {
      projectId: target.projectId,
      currency: target.currency,
      beforeProofCents: target.capitalBeforeProofCents,
      remaining: target.remainingCents / 100,
      exclusions,
      daysLeft: target.daysLeft,
      // The goal's own money and hours shape which arrangements fit it (transfer test, release ca2efe4d).
      capitalAvailable: upFrontLimit,
      hoursAvailable: target.hoursCeiling,
      // The evidence the found openings were just inferred from: an arrangement's links read it the same way (F2).
      knowledge,
      now: input.now ?? new Date(),
      otherPrices: ownPrices.length > 0
        ? ownPrices
        : // Read only when the project holds none of its own (`comparablePricesFor`): a fresh project's goal is not blind to what the Brain validated (§31).
          await brainComparablePrices({ projectId: target.projectId, currency: target.currency }, (text) => !excludedBy(text, exclusions)).catch(() => []),
    });
    estimates.push(...selected.openings);
    arrangementSelection = selected.selection;
    arrangementConversions = selected.conversions;
    reserve = selected.reserve;
    // Every cut by its reason, not only the `CUT_RECORDED` named on the model: the counts sum to the cut count.
    const why = selected.selection.reasons;
    trace(
      `estimated arrangements: ${selected.openings.length} of ${inScope.length} in the goal's scope (of ${input.arrangements?.length ?? 0}) (${selected.selection.cutCount} cut, ${reserve.length} in reserve)` +
        (why.length ? `; cuts: ${why.map(({ reason, count }) => `${count}× ${reason}`).join(' · ')}` : ''),
    );
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
    /*
     * The accepted, sourced answers to this goal's restructuring questions
     * (§93), filed against the opening and mechanism each question named: a
     * held-out opening is re-read on them (`evidencedRestructuring`). An
     * unanswered mechanism carries nothing, so it restructures nothing.
     */
    const { restructureEvidenceOf } = await import('../goals/portfolioNeeds.ts');
    const answered = await restructureEvidenceOf(target.projectId, goal.id).catch(() => new Map<string, RestructureEvidence[]>());
    const withAnswers = (one: PlannedOpening): PlannedOpening => {
      const evidence = answered.get(one.opportunity.id);
      return evidence?.length ? { ...one, restructureEvidence: evidence } : one;
    };
    portfolioInput = {
      openings: [...candidates, ...estimates].map(withAnswers),
      remaining: remainingMajor,
      daysLeft: target.daysLeft,
      capitalCeiling: target.capitalCeilingCents === null ? null : target.capitalCeilingCents / 100,
      beforeProof: target.capitalBeforeProofCents === null ? null : target.capitalBeforeProofCents / 100,
      perWeek: target.capitalPerWeekCents === null ? null : target.capitalPerWeekCents / 100,
      resources: target.resources,
      // The owner's hours, which the gate's model and the arrangement screen read too: one reading of the goal's hours.
      hours: target.hoursCeiling,
      measuredCapacity: (await instantly)[0],
      measuredRates: (await instantly)[1],
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
    // Unchanged inputs read the same portfolio: evaluated once, not on every re-read (`heldEvaluation`).
    portfolio = await heldEvaluation(portfolioInput, async (one) => {
      const evaluator = sharedEvaluator();
      try {
        return await evaluator.evaluate(one);
      } finally {
        await evaluator.close();
      }
    });
    trace('quant portfolio');
    // What the plan could not price, beside what it could read, for the goal tick to send (`sendPortfolioNeeds`).
    if (portfolio && arrangementSelection?.unpriced.length) portfolio = { ...portfolio, unpriced: arrangementSelection.unpriced };
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
      // What was modelled instead, when constructed estimates were: the found openings are not the whole reading.
      ...refuse(unmodelledVerdict(live.length, portfolio, target.currency)),
      portfolio,
      portfolioInput,
      estimates,
      arrangementSelection,
      arrangementConversions,
      arrangementsInScope: inScope.map((one) => one.key),
    };
  }

  const variables: ScenarioVariable[] = [
    variable('remaining', 'Still needed to reach the target', target.currency, known(target.remainingCents / 100, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}`, note: 'target less what the ledger shows' }, 'target less the ledger')),
    variable('days_left', 'Days until the goal is due', 'days', known(target.daysLeft, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}` }, 'the goal row')),
    variable(
      'hours_available',
      'Owner hours available before the deadline',
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
      variable(`${o}_hours`, `${name}: owner hours per deal`, 'hours', one.hours),
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
      { key: `${o}_spend`, label: `${name}: direct costs`, kind: 'COST', expr: directCostTerm(o, one) },
    );
    // Money is tied up per deal taken, not per buyer asked.
    exposure.push(`(${o}_won + ${one.agreedDeals}) * ${o}_capital`);
    labour.push(`${o}_won * ${o}_hours`);
    cashIn.push(`(${o}_agreed + ${o}_won * ${o}_price) * ${o}_in`);
    slowest.push(`if(${o}_n + ${o}_agreed > 0, ${o}_days, 0)`);
  }
  derived.push({ key: 'settled_in_window', label: 'Cash settled before the deadline', unit: target.currency, expr: cashIn.join(' + ') });
  const metrics: NonNullable<ScenarioModelDefinition['metrics']> = [
    // The target is cash kept: what settles in time less the direct costs of the deals that earned it, agreed ones included (§99 Q-3; `costedDeals`).
    { key: 'goal_met', label: 'Reaches the target in time', unit: 'flag', expr: `if(settled_in_window - (${included.map((one) => directCostTerm(`o${one.index}`, one)).join(' + ') || '0'}) >= remaining, 1, 0)`, better: 'HIGHER' },
    { key: 'settled', label: 'Settled before the deadline', unit: target.currency, expr: 'settled_in_window', better: 'HIGHER' },
    { key: 'exposure', label: 'Money tied up', unit: target.currency, expr: exposure.join(' + '), better: 'LOWER', role: 'CAPITAL_EXPOSURE' },
    { key: 'labour', label: 'Owner hours of work', unit: 'hours', expr: labour.join(' + '), better: 'LOWER', role: 'LABOR_HOURS' },
    { key: 'days', label: 'Slowest money to settle', unit: 'days', expr: slowest.length > 1 ? `max(${slowest.join(', ')})` : slowest[0]!, better: 'LOWER', role: 'DAYS_TO_CASH' },
  ];
  const constraints: NonNullable<ScenarioModelDefinition['constraints']> = [
    { key: 'hours', label: 'Within the owner hours available', expr: `${labour.join(' + ')} - hours_available`, op: '<=', value: 0 },
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
  // A net target sizes every strategy on money kept a deal, never on its price (`perDealToward`).
  const net = countsNet(target.metric);
  const dealsFor = (one: ModelledOpportunity) => dealsForGoal(one, target.remainingCents / 100, net);
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
        gap -= agreedToward(one, net);
      } else if (!one.repeatable) {
        if (price <= 0) continue;
        set[`o${one.index}_n`] = 1;
        gap -= perDealToward(one, price, net);
      } else {
        set[`o${one.index}_n`] = buyersToOffer(one, gap, net);
        gap = 0;
      }
      used.push(one);
    }
    if (used.length > 1) add({ key, label: `${label}: ${used.map((one) => one.opportunity.title.slice(0, 30)).join(' + ')}`.slice(0, 160), set });
  };
  if (included.length > 1) {
    const reach = (one: ModelledOpportunity) => bestCaseReach(one, target.remainingCents / 100, target.daysLeft!, false, net);
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
    arrangementConversions,
    arrangementsInScope: inScope.map((one) => one.key),
    refusal: null,
    portfolio,
    portfolioInput,
  };
}

/** The buyers a single-opening plan asks, for a judgement made outside the engine. `net`: the target counts money kept. */
export function dealsForGoal(one: ModelledOpportunity, remainingMajor: number, net = false): number {
  const gap = Math.max(0, remainingMajor - agreedToward(one, net));
  if (gap === 0) return 0;
  if (!one.repeatable) return one.agreedValue > 0 ? 0 : 1;
  return buyersToOffer(one, gap, net);
}

/**
 * How many buyers a repeatable play offers to for `gap` of money still needed.
 *
 * With a measured close rate the number follows from it: the deals needed
 * divided by the cautious end of the measured rate (the same end the plan's
 * conservative figure reads), and never fewer than the fixed multiple below, so a plan whose evidence covers the target is
 * never refused because it asked a fixed multiple of the buyers it needs
 * (planningReliability fam-01, ho-01, ho-06, ho-11: a measured 10% against a
 * fixed 4× never reached the target with 400 buyers evidenced). It is capped
 * where the volume research established is exhausted — volume ÷ the cautious
 * close, past which another buyer asked wins nothing more (a cap of the volume
 * itself confused buyers asked with deals won: 85 deliveries a month at 7%
 * would be offered to 85 buyers and win 6) — or, with no established volume,
 * by the most a strategy ever offers. It never falls below the fixed multiple,
 * so a market too small for the deals needed still reads as too small. With no measured
 * rate the strategy offers OUTREACH_MULTIPLE times the deals needed: a choice
 * it makes and states, never an assumption about how many will say yes.
 */
export function buyersToOffer(one: Pick<ModelledOpportunity, 'price' | 'close' | 'volume' | 'repeatable'> & Partial<Pick<ModelledOpportunity, 'directCost'>>, gap: number, net = false): number {
  if (gap <= 0) return 0;
  const price = one.price.value ?? one.price.low ?? 1;
  // On a net target a deal adds its price less its cost: the deals needed are the gap ÷ that, never ÷ the price.
  const each = net && one.directCost ? perDealToward({ directCost: one.directCost }, price, true) : price;
  const needed = Math.ceil(gap / Math.max(1, each));
  const fixed = Math.min(MAX_BUYERS_OFFERED, needed * OUTREACH_MULTIPLE);
  const close = measuredClose(one);
  if (close === null) return fixed;
  const want = Math.ceil(needed / Math.min(1, close) - 1e-9);
  // The market's deals bound what offering more can win: past volume ÷ close, another buyer asked adds nothing.
  const volume = volumeEstablished(one) && one.volume.value !== null ? Math.floor(one.volume.value) : null;
  const cap = volume === null ? MAX_BUYERS_OFFERED : Math.ceil(volume / Math.min(1, close) - 1e-9);
  // Never fewer than the fixed multiple: the volume link reads the deals a strategy needs back from what it offers.
  return Math.max(fixed, Math.min(cap, want));
}

/**
 * The cautious end of a measured (HISTORICAL) close rate, or null when the
 * close is not measured or not positive. The one reading both directions of
 * the offers rule use: `buyersToOffer` sizes offers from it and
 * `dealsFromOffers` reads the deals back from it, so the two cannot drift.
 */
export function measuredClose(one: Pick<ModelledOpportunity, 'close'>): number | null {
  if (one.close.provenance !== 'HISTORICAL') return null;
  const close = one.close.value !== null ? Math.min(one.close.value, one.close.low ?? one.close.value) : one.close.low;
  return close !== null && close > 0 ? close : null;
}

/**
 * The deals a repeatable play needs, read back from the buyers it offers to —
 * the inverse of `buyersToOffer` (planningReliability, 2026-11-21). Offers
 * follow the measured close when it is under 1 / OUTREACH_MULTIPLE, so the
 * deals read back are buyers × that close; otherwise the fixed multiple
 * governed and they are buyers ÷ OUTREACH_MULTIPLE. With no measured close,
 * buyers ÷ OUTREACH_MULTIPLE. Before this the plan read buyers ÷ 4 whatever
 * the close, so offers sized to a measured 10% read as 2.5× the deals they
 * win. Where offers were capped at the volume, the deals read back are the
 * most the market holds, and the conservative figure says the target is
 * short. Pure.
 */
export function dealsFromOffers(one: Pick<ModelledOpportunity, 'close'>, buyers: number): number {
  if (!(buyers > 0)) return 0;
  const close = measuredClose(one);
  const rate = close !== null ? Math.min(1 / OUTREACH_MULTIPLE, close) : 1 / OUTREACH_MULTIPLE;
  return Math.ceil(buyers * rate - 1e-9);
}
