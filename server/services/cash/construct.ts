/**
 * Arrangements Brain constructs itself, from what it knows about the economy
 * (§81).
 *
 * Every other door into the portfolio asks the world for an opening somebody
 * already published: a request, a price gap, a stream of buyers. When those
 * cannot reach a goal however they are combined, Brain keeps asking the world —
 * and it also composes arrangements nobody has published, from parts it holds
 * independently of one another:
 *
 *   * a **buyer population** — a `BUYER_TYPE` on the industry map, or the payer
 *     a gated claim established on an opening;
 *   * a **need** — a `BOTTLENECK` the map records in that buyer's part of the
 *     economy, or what the payer is shown paying for;
 *   * a **way to fulfil it** — a `FULFILMENT_SOURCE` the map records there, or a
 *     deliverable Brain has proved it can produce in this process;
 *   * a **way to be paid** — a closed table of transaction structures (a fee for
 *     what Brain produces, a commission for connecting buyer and supply, a
 *     margin for owning the customer and paying supply, a referral fee paid by
 *     supply, a margin for pooling several buyers' purchases).
 *
 * A structure applies only where its parts exist, so nothing here names a
 * business and nothing is a template filled in per industry. An arrangement
 * that is merely an existing opening sold the way it already is, is left out:
 * the point is a mechanism Brain did not hold.
 *
 * Each arrangement is then decomposed with `composeArrangement` and resolved
 * by `reconstruct`: what Brain already holds about the buyer's prices becomes
 * the value's evidence, and every part nothing establishes is named. Those
 * named parts — how many buyers, how often they buy, what they pay, what
 * supply costs, when money settles — *are* the research question the round
 * asks, so the decomposition decides what is researched and an established
 * part is not asked again. What the world answers comes back through the
 * ordinary gate and harvest as an opening with a card, and the goal's model
 * reads it like any other.
 *
 * Nothing here is a fact. A constructed arrangement is a hypothesis with its
 * reconstruction attached, ranked lexicographically by what it needs that the
 * goal does not have and how much of it rests on gated claims; a weighted
 * score would need weights nobody set.
 */
import { breaksOperatingModel, operatingFit } from '../../domain/operatingModel.ts';
import { createHash } from 'node:crypto';
import { listNodes, listOtherProjectsLiveNodes } from '../../repos/industry.ts';
import { listOtherProjectsClaimFacts, listProjectConstructionFacts } from '../../repos/construction.ts';
import { eligibleClaimIds } from '../../repos/sharedFindings.ts';
import type { FactKey, FactStatus } from '../../domain/construction.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { paidOpportunityIds } from '../../repos/cashLedger.ts';
import { namesOnlyAPlace, statesNamedIn } from '../../domain/jurisdiction.ts';
import { buyerNameKey, namesABuyerPopulation } from '../../domain/industry.ts';
import { isNonPurchasePayment, wrongWayPrice } from '../../domain/paymentNature.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { composeArrangement, type Arrangement, type Levers, type Part } from '../quant/mechanism.ts';
import { leverageOfYielding, type ArrangementLeverage, type LeverageConstraints } from '../quant/leverage.ts';
import { reconstruct } from '../quant/reconstruct.ts';
import { inputSample, toScenarioInput, type InputSample } from '../quant/export.ts';
import { emptyLeverEvidence, leverEvidenceFrom, type LeverEvidence, type LeverPart } from '../quant/leverEvidence.ts';
import { claimSources, claimsByIds } from '../../repos/research.ts';
import type { CashCardFact, CashOpportunity, IndustryNode } from '../../domain/types.ts';
import type { Estimate, Observation } from '../../domain/quant.ts';
import { repeatBusinessObservations } from './deliverables/realization.ts';
import { brainProduces } from '../goals/pathways.ts';
import { readMoneyFigures } from './figures.ts';
import { combineTimings, openingTiming, timingOfText, type PaymentTimingReading } from './paymentTiming.ts';

import {
  allDesigns,
  defaultDesign,
  describeDesign,
  designFacts,
  designKey,
  designParts,
  DESIGN_PART_ASK,
  isDefaultDesign,
  PROPERTIES,
  propertiesOf,
  stressDesign,
  STRUCTURES,
  STRUCTURE_KEYS,
  targetProperties,
  type Design,
  type EconomicProperty,
  type GoalLimits,
  type StressReading,
  type Structure,
} from './properties.ts';
import { excludedBy, exclusionSentence, type ExclusionClass } from './exclusions.ts';
import { syncEventGraph, currentEventGraph, type EventGraphSync, type GraphHypothesis, type RuleId } from '../industry/eventGraph.ts';
import {
  ENTRY_POINTS,
  EVIDENCE_FIELDS,
  INTERMEDIATION_FAMILY,
  positionEvidenceGaps,
  positionsToExamine,
  type EvidenceBasis,
  type EvidenceField,
  type PositionFacts,
  type ResolvedPosition,
} from './intermediationPositions.ts';

export { STRUCTURES, STRUCTURE_KEYS, type Structure } from './properties.ts';

/** One part of an arrangement and where it came from. */
export interface Primitive {
  name: string;
  /** A gated claim behind it, or null for a proved capability, an opening's own words, or a part reverse construction asks the world for. */
  claimId: string | null;
  /**
   * `BRAIN_MAP`: a subject of the Brain's shared industry map (`brainMapNodes`)
   * that a project whose own map names too few buyers constructs from — the
   * shared root's discovery or a subject a validated finding evidences (§31,
   * §34). Its `ref` is its path, never another project's row id.
   */
  from: 'INDUSTRY_MAP' | 'BRAIN_MAP' | 'OPENING' | 'CAPABILITY' | 'REVERSE' | 'EVENT_GRAPH';
  ref: string;
  /**
   * What this part *is*, independent of any row id (K-7): a map node's kind and
   * the normalised names from its map root down to it, or an opening payer's
   * normalised industry and name. Two rows describing the same part — a node
   * retired and re-created, the same population read by a second goal — have
   * one path, so the arrangement built from them has one signature.
   */
  path?: string;
  /**
   * When the buyers this part names pay relative to delivery, where its own
   * source states it: a map node's description and the claim it was filed
   * from, or an opening's terms and whether it is won by award. Absent when
   * nothing stated decides it — unknown, never prepaid (invariant 39).
   */
  terms?: PaymentTimingReading;
}

/**
 * How an arrangement came to be composed (§82):
 *   FORWARD  — from parts the project holds, in their own part of the economy;
 *   TRANSFER — a design a held opening shows working, carried to a different buyer;
 *   REVERSE  — a design chosen for the properties the goal needs, whose buyers,
 *              need and supply the world is asked to supply.
 */
export type ConstructionOrigin = 'FORWARD' | 'TRANSFER' | 'REVERSE';

/**
 * What a precedent proves about its own buyers and not about another
 * population: each is a material difference a transfer must bridge.
 */
export const TRANSFER_MATERIAL = ['legal context', 'payment terms', 'sales cycle', 'capital', 'buyer behaviour'] as const;

/**
 * Card fields whose gated answer says what buyers pay: the price lane
 * (`revenueRange`), the short card's price, and published buying evidence.
 */
export const PRICE_SHOWN_FIELDS: readonly string[] = ['revenueRange', 'price', 'buyingEvidence'];

/**
 * The openings whose design is shown working, by evidence production actually
 * writes (F1, 2026-11-15). Either a buyer has paid on it (a customer payment,
 * net of refunds), or a gated claim established who pays *and* a gated claim
 * established that they pay for it at a price — EVIDENCE card facts, which the
 * deep dive's payer and price lanes and research answers write.
 *
 * The capture thesis is not read here, and that is deliberate: production only
 * ever writes it as Brain's RECOMMENDATION (`proposeEngineTerms`, composed from
 * the evidenced payer), so requiring it as EVIDENCE made every precedent
 * unreachable, and accepting the recommendation would let Brain's own proposal
 * stand as proof. A recommendation alone is never a precedent; neither is a
 * payer with no price, nor a price nobody is shown paying.
 */
export function shownWorking(
  facts: readonly Pick<CashCardFact, 'opportunityId' | 'field' | 'kind'>[],
  paid: ReadonlySet<string> = new Set(),
): Set<string> {
  const payer = new Set<string>();
  const price = new Set<string>();
  for (const one of facts) {
    if (one.kind !== 'EVIDENCE') continue;
    if (one.field === 'payer') payer.add(one.opportunityId);
    else if (PRICE_SHOWN_FIELDS.includes(one.field)) price.add(one.opportunityId);
  }
  const out = new Set(paid);
  for (const id of payer) if (price.has(id)) out.add(id);
  return out;
}

/** `shownWorking` over a project's rows: its card facts and its ledger. */
export async function shownWorkingIn(projectId: string, facts?: readonly CashCardFact[]): Promise<Set<string>> {
  return shownWorking(facts ?? (await cardFactsForProject(projectId)), await paidOpportunityIds(projectId));
}

/**
 * The designs held openings show working, by structure: an opening
 * `shownWorking` admits is a published precedent for its structure's design.
 * The first per structure, in the order given. Shared by goal construction and
 * the standing kernel's transfer asks (W-8), so both read one definition of a
 * precedent.
 */
export function heldPrecedents(
  opportunities: readonly CashOpportunity[],
  shown: ReadonlySet<string>,
): Map<Structure, CashOpportunity> {
  const out = new Map<Structure, CashOpportunity>();
  for (const o of opportunities) {
    if (!shown.has(o.id)) continue;
    for (const base of STRUCTURE_KEYS) {
      if ((STRUCTURES[base].alreadyHeldAs as readonly string[]).includes(o.mechanism) && !out.has(base)) out.set(base, o);
    }
  }
  return out;
}

export interface ConstructedArrangement {
  key: string;
  structure: Structure;
  /** The transaction design: who fulfils, who pays, how buyers aggregate, when money moves, what recurs. */
  design: Design;
  origin: ConstructionOrigin;
  /** A held opening whose evidenced design this one transfers, for TRANSFER. */
  precedent: { opportunityId: string; title: string } | null;
  /**
   * For TRANSFER: the material differences between the precedent's buyers and
   * these, none established by the precedent (S-12, G2). Each is unbridged
   * until a sourced adjustment bridges it; the research question names them.
   */
  differences?: Array<(typeof TRANSFER_MATERIAL)[number]>;
  sector: string | null;
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  label: string;
  /** Why it would be attractive, derived from the design — every one still to be established. */
  properties: EconomicProperty[];
  /** Of those, the ones the goal's limits ask for. */
  targetsMet: EconomicProperty[];
  /** Properties nobody targeted that the design adds anyway. */
  emergent: EconomicProperty[];
  /** What it loses when buyers, presales, payment, refunds or supply go wrong. */
  stress: StressReading;
  /** Parts resting on a gated claim. */
  evidenced: number;
  /** The decomposition, resolved. */
  value: Pick<Estimate, 'tier' | 'p10' | 'p50' | 'p90'> & {
    observations: number;
    /** The lineage of the observations the value was reconstructed from (`claim:…`, `fact:…`, `opp:…`): its provenance. */
    sources?: string[];
    /**
     * Present only when the reconstruction justifies a distribution (F2, 2026-11-17): the
     * engine's draw of what these buyers pay and the evidence it is worth, exported the one way
     * every inferred input is (`toScenarioInput`, `inputSample`). Without it the price stays an
     * ASSUMPTION swept over the range; with it, accepted price evidence reaches the plan.
     */
    evidence?: { values: number[]; low: number; high: number } & InputSample;
    /**
     * Why the observations the value was read from are no evidence of what
     * these buyers pay under this design (GH2): they were paid under another
     * payment mechanism — who pays, for what unit, how often. Present, the
     * plan sweeps the value as an ASSUMPTION and never as evidence.
     */
    notEvidence?: string;
    /**
     * Every observation the value rests on was stated by its source as one
     * participant's share of a shared purchase (`per slot`), for these very
     * buyers (F4): a pooled design's own unit, observed rather than carried
     * from a precedent. Absent, the value rests on anything else.
     */
    perParticipant?: true;
  };
  /**
   * The share of these buyers approached who agree, reconstructed from close
   * rates filed for them (`account_win_rate`, R3): the plan's close rate for
   * this arrangement. `evidence` only where the reconstruction justifies a
   * distribution — a published rate with no stated sample locates the rate and
   * never does (quant/pool.ts), so it is swept over its range as bounds.
   * Absent, nothing filed bears on it.
   */
  conversion?: Pick<Estimate, 'tier' | 'p10' | 'p50' | 'p90'> & { observations: number; sources: string[]; evidence?: NonNullable<ConstructedArrangement['value']['evidence']> };
  /**
   * A pooled design's fixed cost of one shared run, reconstructed from what
   * supply was observed charging for a whole run (`fixed_cost_per_run`, B1j)
   * and what runs for these buyers tied up, with the claims it rests on.
   * Absent, no run cost is filed for these buyers. A cost, never value: it
   * lowers the contribution and raises nothing.
   */
  fixedCost?: Pick<Estimate, 'tier' | 'p10' | 'p50' | 'p90'> & { observations: number; sources: string[] };
  /**
   * What one deal pays its supplier, for a design that is not pooled and pays
   * supply per deal (a MARGIN design: SUBCONTRACT, POOL with a single buyer),
   * reconstructed from the per-unit and per-run rates research filed for these
   * buyers (`contractor_rate_per_unit`, `fixed_cost_per_run`) and what their
   * openings tie up (§79). Present only where a filed rate was used and the
   * tier is not UNKNOWN; `evidence` only where the reconstruction justifies a
   * distribution. A cost, never value; and an estimate, never a verified
   * market fact unless DIRECT and justified (invariant 39). Absent, the plan
   * keeps its blind sweep.
   */
  supplyCost?: Pick<Estimate, 'tier' | 'p10' | 'p50' | 'p90'> & { observations: number; sources: string[]; evidence?: NonNullable<ConstructedArrangement['value']['evidence']> };
  /**
   * A BROKER or REFERRAL design's take: the share of these buyers' price an
   * intermediary keeps, reconstructed from the take rates filed for these
   * buyers (`broker_take_rate`), with the claims it rests on. The supplier
   * fulfils and keeps the rest, so this share — never the buyer's whole price —
   * is the design's revenue per deal (`commissionRevenue`, goalScenario.ts).
   * `evidence` only where the reconstruction justifies a distribution. Absent,
   * nothing filed bears on it, and the plan sweeps it conservatively as an
   * assumption (invariant 39: an unknown commission is never read as 100%).
   */
  commission?: Pick<Estimate, 'tier' | 'p10' | 'p50' | 'p90'> & { observations: number; sources: string[]; evidence?: NonNullable<ConstructedArrangement['value']['evidence']> };
  /** Parts nothing establishes yet: what the research round asks. */
  unknownParts: string[];
  /** Openings sharing this buyer, for the novelty check and the value evidence. */
  relatedOpenings: string[];
  question: string;
  /**
   * When these buyers pay relative to delivery, inherited from the evidence
   * the arrangement was composed from: its parts' sources and the openings
   * sharing its buyer. An RFP or award population pays in arrears; absent
   * means nothing stated it, and the plan reads it as unknown, never prepaid
   * (production 2026-11-15, goal wst_7b4fcbb5f2384f31b6c3).
   */
  buyerTerms?: PaymentTimingReading;
  /**
   * Repeat business this buyer population has already given Brain, read from
   * aftercare records (`deliverables/realization.ts`): how many stated values,
   * and their sum. Absent or zero is unknown, never "will not return" (LIFE-29-2).
   */
  repeatBusiness?: { observations: number; statedValueCents: number };
  /**
   * The arrangement's identity in the library (migration 152): its design and
   * its parts' paths, hashed — never a row id, never its wording. The same
   * structure composed by another goal, another process or after a restart is
   * one row (`monetization_paths.design_signature`).
   */
  signature?: string;
  /**
   * What research about it depends on: its parts' rows and claims, the
   * precedent it transfers, and the observations about this buyer's prices. A
   * refutation holds while this is unchanged; new evidence reopens it.
   */
  inputsDigest?: string;
  /**
   * The `inputsDigest` this composition had under the signature spelt from the
   * whole deliverables list (before the capability's identity was made
   * list-independent), present only when Brain produces it. Read once, by
   * `rememberArrangements`, to carry a verdict reached under the old spelling
   * onto the new one; never stored in the library.
   */
  legacyInputsDigest?: string;
  /** Everything its composition read, hashed: a stored arrangement composed under the same is reused rather than recomposed. */
  composedUnder?: string;
  /**
   * The goal's last readings picked it or led with it (`recentLeaderSignatures`,
   * P4). Construction composes it whatever the cap; the model's estimated
   * slots (`selectEstimatedArrangements`) admit it first, so a pass that
   * learned nothing new cannot drop it on a tie the rest of the pass decided.
   * Per pass and per goal: never stored in the library.
   */
  leader?: boolean;
  /**
   * Commercial leverage (S-0103, COM-13-2), on the `LEVERAGE_TRACED`
   * best-ranked arrangements: the levers the design uses — AI labor or a
   * supplier fulfilling, buyer prepayment where the design takes money early —
   * composed on the same parts and evidence as the decomposition above, every
   * combination traced through cash conversion, margin, supplier risk,
   * delivery capacity, liability, acquisition speed and repeatability, judged
   * against the cash the ledger says is deployable and the authority a person
   * granted, and its prepayment conditions verified. Never a revenue ceiling.
   */
  leverage?: ArrangementLeverage;
  /**
   * For an arrangement that needs supply, the alternative positions the same
   * transaction can be held from, each with its own research question
   * (RES-15-4; S-0148, S-0150). Absent for a structure Brain fulfils itself.
   */
  positionQuestions?: PositionResearchQuestion[];
}

/**
 * One decomposed research question at one exact position of an intermediated
 * transaction. `POSITION` asks the S-0150 fields still missing there plus the
 * position's contracts, rights, liabilities, restrictions and counterparty
 * expectations; `BUYER_ACCESS` and `CONVERSION` are asked separately when what
 * is established is only an asking price or a market size.
 */
export interface PositionResearchQuestion {
  kind: 'POSITION' | 'BUYER_ACCESS' | 'CONVERSION';
  /** The position as research holds it: its catalogue label, or the name Brain discovered. */
  position: string;
  catalogued: string | null;
  /** The S-0150 fields this question asks; empty for the separate access and conversion questions. */
  asks: EvidenceField[];
  /** The S-0150 fields already established for this arrangement, which are not asked again. */
  established: EvidenceField[];
  question: string;
  /** For a POSITION question, what to investigate contractually at exactly that position. */
  investigate?: string;
  /** For a BUYER_ACCESS or CONVERSION question, the gap itself. */
  ask?: string;
}

/** At most this many arrangements are composed per goal pass (they are ranked and few are asked). */
export const MAX_CONSTRUCTIONS = 400;
/**
 * How many of the best-ranked arrangements carry a traced leverage reading.
 * Tracing resolves every lever combination, several reconstructions each, so
 * it is paid where a plan reads and research asks — the top of the ranking —
 * rather than on all `MAX_CONSTRUCTIONS`, which was already the hot path.
 * Every design composes all the levers it can use (`designLevers`), up to
 * 2^7 = 128 combinations each, so the top four are traced in full rather than
 * twelve in part: measured on the wired test, twelve full traces were about
 * five times the construction pass, four about twice.
 */
export const LEVERAGE_TRACED = 4;
/** Reverse arrangements composed per pass: one per design that best fits the goal. */
export const MAX_REVERSE = 4;
/** Longest stretch construction holds the event loop before handing it back (2026-11-05 11.6 s stalls). */
export const YIELD_EVERY_MS = 25;

/**
 * Untrusted words are screened with their quotation marks removed. The screen
 * exempts a quoted span when the words before it attribute it to a source
 * (`actorScope.ts`), which is right for the opening's own buying signal Brain
 * quotes, but text from a record or a post is not Brain's attributed quotation:
 * it can carry its own lead-in (*the listing says: "purchase the list"*) and
 * would launder an instruction through the exemption. Without the marks the
 * quoted words are read exactly as the unquoted ones are.
 */
function unquoted(text: string): string {
  return text.replace(/["“”]/g, ' ');
}

function safeName(text: string): boolean {
  if (!text || text.length > 240) return false;
  if (statesNamedIn(text).length > 0) return false;
  // A place alone ("germany") is where, never a population of buyers or what they buy (production, 2026-11-18).
  if (namesOnlyAPlace(text)) return false;
  return Object.values(APPROVAL_ENVELOPES).every((envelope) => !describesOwnAction(`a buyer population: ${unquoted(text)}`, envelope.forbiddenActions));
}

/**
 * A name construction may build an arrangement's buyers from: safe, and a kind
 * of buyer a list can be built of (`namesABuyerPopulation`) — never the
 * leftover of a payer sentence ("paying", "Crucinova itself") or a party
 * nobody knows ("anonymous members of the public"), production 2026-11-19.
 * Read where the name is used, so rows already written are covered too.
 */
function safeBuyer(text: string): boolean {
  return safeName(text) && namesABuyerPopulation(text);
}

function clean(text: string): string {
  return text.replace(/[.,;:!?—–\n"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Which buyer population a payer names: the map's own identity (`buyerNameKey`,
 * plurals folded) over the normalised text, so "Dental practice" on an opening
 * and the map node "Dental practices" are one population, and an observation's
 * already-normalised payer reads the same as the raw name. A qualifier is
 * still a different population (PRICE-POOL holds).
 */
export const payerKey = (text: string | null | undefined): string => buyerNameKey(norm(text));

/**
 * The live map buyer type whose construction facts the plan reads as evidence
 * about the buyers `demandName` names (B1g, 2026-11-18): exactly the read
 * `constructionObservations` and `compose` make — a fact segmented to
 * `map_<node>` reaches an arrangement when the node is a live, safely named
 * BUYER_TYPE and `payerKey(node.name) === payerKey(demand.name)` — so a fact
 * filed against what this returns is one the plan holds for that arrangement,
 * whatever the arrangement's demand came from (the map, an opening, a model).
 * Null when no such node exists: then no fact the plan reads is about these
 * buyers, and none should be filed. The exact name first, then the oldest.
 */
export function planBuyerType(demandName: string | null | undefined, nodes: readonly IndustryNode[]): IndustryNode | null {
  const key = payerKey(demandName);
  if (!key) return null;
  const want = (demandName ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pool = nodes
    .filter((one) => one.kind === 'BUYER_TYPE' && !one.retiredAt && safeBuyer(one.name) && payerKey(one.name) === key)
    .sort((a, b) => Number(b.name.toLowerCase() === want) - Number(a.name.toLowerCase() === want) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return pool[0] ?? null;
}

function rootOf(node: IndustryNode, byId: Map<string, IndustryNode>): IndustryNode {
  let at = node;
  const seen = new Set<string>();
  while (at.parentId && byId.has(at.parentId) && !seen.has(at.id)) {
    seen.add(at.id);
    at = byId.get(at.parentId)!;
  }
  return at;
}

function keyOf(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 32);
}

/** A map node's kind and the normalised names from its root down to it. */
function nodePath(node: IndustryNode, byId: Map<string, IndustryNode>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let at: IndustryNode | undefined = node;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    names.unshift(norm(at.name));
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return `${node.kind}:${names.join('>')}`;
}

function partPath(part: Primitive | null): string {
  if (!part) return '-';
  return part.path ?? `${part.from}:${norm(part.name)}`;
}

/**
 * What "Brain produces it" is, as a part's identity: one capability, whatever
 * else the project's deliverables list holds. The list is the capability's
 * words (`name`), never its identity.
 *
 * Spelt from the whole list (`CAPABILITY:a>b>c`) until 2026-11-19, every
 * arrangement Brain produces took a new signature the moment an unrelated
 * deliverable was added: the goal's held leaders (`recentLeaderSignatures`)
 * stopped matching, research verdicts were left on a row nothing composed any
 * more, and the library's reuse missed. Forward, reverse and invented
 * composition all use this one part for every design Brain produces — none of
 * them picks a single deliverable — so the capability actually used is the
 * same one whichever deliverables sit beside it.
 */
export const BRAIN_CAPABILITY_PATH = 'CAPABILITY:BRAIN';

/** The capability part every design Brain produces is composed with, or null when no deliverable is proved. */
export function capabilityPart(delivers: readonly string[]): Primitive | null {
  return delivers.length > 0 ? { name: delivers.join(', '), claimId: null, from: 'CAPABILITY', ref: 'deliverables', path: BRAIN_CAPABILITY_PATH } : null;
}

/**
 * What Brain produces for these buyers: the one proved deliverable their need
 * or their name calls for, as the capability part's words — never the whole
 * list. Production transfer test (release ca2efe4d): every arrangement Brain
 * produces read "Brain produces it (spreadsheet, business document,
 * presentation, …)" whatever the buyer paid for, because the part's name was
 * the project's deliverables list. The identity stays the one capability
 * (`BRAIN_CAPABILITY_PATH`), so signatures, leaders and verdicts are
 * untouched; only the words change. When nothing these buyers are said to
 * need matches a deliverable Brain has proved, the deliverable is unknown and
 * says so: research names it, and nothing here picks one. Pure.
 */
export function fittedDeliverable(capability: Primitive, delivers: readonly string[], demand: Primitive, need: Primitive | null): Primitive {
  if (capability.from !== 'CAPABILITY') return capability;
  const named = (text: string | null | undefined) => (text ? brainProduces(text, { delivers: [...delivers], puzzleFormats: [] }) : null);
  const kind = named(need?.name) ?? named(demand.name);
  const name = kind
    ? need
      ? `${kind} for "${need.name}"`
      : `${kind} for ${demand.name}`
    : need
      ? `the deliverable "${need.name}" calls for ${UNMATCHED_DELIVERABLE}`
      : `what ${demand.name} pay for ${UNSPECIFIED_DELIVERABLE}`;
  return { ...capability, name };
}

/** The words `fittedDeliverable` gives a capability part no proved deliverable matched. */
const UNMATCHED_DELIVERABLE = '(not yet matched to one Brain has proved)';
const UNSPECIFIED_DELIVERABLE = '(not yet specified)';

/** Whether an arrangement Brain produces leaves what it produces unspecified: nothing named what these buyers pay for. Pure. */
export function unspecifiedDeliverable(one: Pick<ConstructedArrangement, 'supply'>): boolean {
  return one.supply?.from === 'CAPABILITY' && one.supply.name.includes(UNSPECIFIED_DELIVERABLE);
}

/**
 * Whether a supply part is a deliverable Brain has proved for these buyers:
 * Brain's capability, fitted by `fittedDeliverable` to one named proved
 * deliverable ("<deliverable> for <need or buyers>"). A capability part no
 * proved deliverable matched, or one still spelt as the whole deliverables
 * list (stored before fitting), is not — nobody has said which deliverable
 * Brain makes for them, so who performs the work stays unknown (invariant
 * 39). Read from the part as stored, so an arrangement the library reuses
 * answers the same as one composed now. Pure.
 */
export function provedDeliverable(part: Pick<Primitive, 'from' | 'name'> | null | undefined): boolean {
  if (!part || part.from !== 'CAPABILITY') return false;
  if (part.name.includes(UNMATCHED_DELIVERABLE) || part.name.includes(UNSPECIFIED_DELIVERABLE)) return false;
  return / for \S/.test(part.name);
}

/** The capability's path as it was spelt from the whole list, before 2026-11-19: only to recognise what was stored under it. */
function legacyCapabilityPath(delivers: readonly string[]): string {
  return `CAPABILITY:${delivers.map(norm).sort().join('>')}`;
}

/** A part's identity in a signature: its path, and for Brain's capability the one capability (`BRAIN_CAPABILITY_PATH`), however it was stored. */
function identityPath(part: Primitive | null): string {
  return part?.from === 'CAPABILITY' ? BRAIN_CAPABILITY_PATH : partPath(part);
}

/**
 * An arrangement's identity by structure (K-7): the design and, for buyer,
 * need and supply, what each part is — never a row id and never the label.
 * How it was found (forward, transferred, reversed) is not part of it: the
 * same mechanism reached two ways is one mechanism. A part Brain produces is
 * the one capability, never the deliverables list beside it, so a stored
 * arrangement whose capability was spelt from an older list re-signs to the
 * same signature (`libraryFor`).
 */
export function arrangementSignature(design: Design, demand: Primitive, need: Primitive | null, supply: Primitive | null): string {
  return digestOf(['arrangement/v1', designKey(design), identityPath(demand), identityPath(need), identityPath(supply)].join('|'));
}

/** The parts of a structure, in the words a researcher reads. */
export const PART_ASK: Record<string, string> = {
  buyers: 'how many buyers of exactly this kind exist and can be reached through a published directory, register or list, with its number',
  need_rate: 'how often one of them buys this (weekly, monthly, yearly or once)',
  conversion: 'what share of buyers approached in comparable published cases agreed',
  value: 'what buyers of this kind are published as paying for it, with figures and dates',
  commission: 'the commission share suppliers of this kind publish or accept for referred or brokered work',
  fee: 'the fee per buyer or per referral that is published for this kind of work',
  supply_cost: 'what the supplier is published as charging for one unit of the work',
  supply_units: 'how many suppliers of this kind exist and how much work each can take on',
  cost: 'any cost per deal to the arranger: platform fees, listing fees, insurance',
  ...DESIGN_PART_ASK,
};

export interface ConstructionInput {
  projectId: string;
  currency: string;
  /** Deliverable kinds Brain proved it can produce in this process, as people read them. */
  delivers: string[];
  /** The goal's capital ceiling, when the owner set one. */
  capitalCeilingCents: number | null;
  daysLeft: number;
  /** The goal's limits, for reverse construction and the stress test; derived from the two above when absent. */
  limits?: GoalLimits;
  /** Classes the goal's owner excluded (§82). */
  exclusions?: readonly ExclusionClass[];
  now?: Date;
  /** The goal this pass plans for: its last readings' leaders are always composed (P4). */
  goalId?: string;
}

const TIER_ORDER = ['DIRECT', 'COMPARABLE', 'COMPONENT', 'MECHANISM', 'ASSUMED', 'UNKNOWN'];
const EXPOSURE_ORDER: StressReading['exposure'][] = ['SAFE', 'BOUNDED', 'UNKNOWN', 'EXCEEDS'];

/** At most this many buyer populations, and needs, one sector takes from openings held only as evidence (F5). */
export const SIGNAL_PARTS_PER_SECTOR = 12;

/**
 * Openings held only as evidence feed construction as demand evidence (F5).
 *
 * An opening whose payer no gated claim established — most of them tier
 * SIGNAL, with no way of being paid worked out — is rightly not a found
 * opening (invariant 39), and is never one here. But the claim it was
 * harvested from still says a buyer of some kind has a need in some part of
 * the economy, which is exactly what a BUYER_TYPE or BOTTLENECK node on the
 * industry map says. Production, 2026-11-14: 282 of 418 live openings were
 * evidence only and fed neither construction nor transfer, so two thirds of
 * what Brain held was inert in planning.
 *
 * So its buyer (the opening's payer, or a payer card fact a source or a person gave) becomes
 * a buyer population and its offer or title a need, in its sector, under the
 * same part paths an evidenced payer uses (K-7) — the same population read
 * twice is one part, and evidencing its payer later keeps its signature. Each
 * part carries the opening's source claim as its evidence. Nothing about the
 * opening itself changes, and a part already present is not added twice.
 * Bounded per sector, most recently updated first, so one noisy sector cannot
 * flood the candidate count.
 */
function addSignalDemand(
  opportunities: readonly CashOpportunity[],
  facts: readonly { opportunityId: string; field: string; kind: string; value: unknown }[],
  evidencedPayer: ReadonlySet<string>,
  allowed: (text: string | null | undefined) => boolean,
  sector: (name: string | null) => { demand: Primitive[]; needs: Primitive[] },
): void {
  const payerFact = new Map<string, string>();
  // Brain's own proposal of a payer is not evidence of one; a person's answer or a source's is.
  for (const f of facts) if (f.field === 'payer' && f.kind !== 'RECOMMENDATION' && typeof f.value === 'string' && f.value.trim() && !payerFact.has(f.opportunityId)) payerFact.set(f.opportunityId, f.value.trim());
  const added = new Map<string, { demand: number; needs: number }>();
  const ordered = [...opportunities].filter((o) => !evidencedPayer.has(o.id)).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
  for (const o of ordered) {
    if (!allowed(o.title) || !allowed(o.industry)) continue;
    const key = norm(o.industry) || '-';
    const count = added.get(key) ?? { demand: 0, needs: 0 };
    const s = sector(o.industry);
    const payer = (o.payer && o.payer.trim()) || payerFact.get(o.id) || null;
    if (payer && safeBuyer(payer) && allowed(payer) && count.demand < SIGNAL_PARTS_PER_SECTOR && !s.demand.some((one) => norm(one.name) === norm(payer))) {
      s.demand.push({ name: clean(payer), claimId: o.sourceClaimId, from: 'OPENING', ref: o.id, path: `OPENING_PAYER:${norm(o.industry)}>${norm(payer)}`, ...termsOfOpening(o) });
      count.demand += 1;
    }
    const need = o.offerScope ?? o.title;
    if (safeName(need) && count.needs < SIGNAL_PARTS_PER_SECTOR && !s.needs.some((one) => norm(one.name) === norm(need))) {
      s.needs.push({ name: clean(need), claimId: o.sourceClaimId, from: 'OPENING', ref: o.id, path: `OPENING_NEED:${norm(o.industry)}>${norm(need)}`, ...termsOfOpening(o) });
      count.needs += 1;
    }
    added.set(key, count);
  }
}

/**
 * Kept event-graph constructions as construction parts (R3-F1, ALGO-16-1 item
 * 4): the graph's prune has already chosen which hypotheses deserve costly
 * investigation, and this hands exactly those to the composition every other
 * part goes through — so a graph construction reaches the goal's ranked
 * arrangements, its portfolio and the research questions asked about them.
 *
 * Per kept construction, in its neighborhood's sector: each named actor on
 * the wanting side (a stated buyer, or a record whose role is unknown) is a
 * buyer population, the neighborhood is the need, and each named supplier or
 * partner is a supply part. An actor its record does not name is not a part —
 * an item id is not a buyer anyone can ask about. Every part is `EVENT_GRAPH`
 * with no claim, so composition asks for its payer and supplier rather than
 * reading them as established (invariant 39). The same part from two
 * constructions is one part; bounded per sector like signal demand. Mutates
 * the sectors it is handed; reads nothing.
 */
export function addGraphParts(
  kept: readonly Pick<GraphConstruction, 'neighborhood' | 'hypothesisKey' | 'actors'>[],
  allowed: (text: string | null | undefined) => boolean,
  sector: (name: string | null) => { demand: Primitive[]; needs: Primitive[]; supply: Primitive[] },
): void {
  for (const one of kept) {
    const hood = norm(one.neighborhood);
    if (!hood || !safeName(one.neighborhood) || !allowed(one.neighborhood)) continue;
    const s = sector(one.neighborhood);
    const push = (list: Primitive[], name: string, path: string): void => {
      if (list.length >= SIGNAL_PARTS_PER_SECTOR || list.some((p) => p.path === path)) return;
      list.push({ name: clean(name), claimId: null, from: 'EVENT_GRAPH', ref: one.hypothesisKey, path });
    };
    push(s.needs, one.neighborhood, `GRAPH_NEED:${hood}`);
    for (const actor of one.actors) {
      const name = actor.name?.trim();
      if (!name || !safeName(name) || !allowed(name)) continue;
      if (actor.role !== 'SUPPLIER' && actor.role !== 'PARTNER' && !namesABuyerPopulation(name)) continue;
      if (actor.role === 'SUPPLIER' || actor.role === 'PARTNER') push(s.supply, name, `GRAPH_SUPPLY:${hood}>${norm(name)}`);
      else push(s.demand, name, `GRAPH_BUYER:${hood}>${norm(name)}`);
    }
  }
}

/**
 * Compose every arrangement the project's own rows support — forward from its
 * parts, transferred from designs held openings show working, and in reverse
 * from the properties the goal needs — decompose each, stress it, and rank
 * them. Pure over the rows it reads; writes nothing.
 */
export async function constructArrangements(input: ConstructionInput): Promise<ConstructedArrangement[]> {
  const now = input.now ?? new Date();
  const exclusions = input.exclusions ?? [];
  const limits: GoalLimits = input.limits ?? {
    daysLeft: input.daysLeft,
    remainingCents: Number.MAX_SAFE_INTEGER,
    capitalCeilingCents: input.capitalCeilingCents,
    capitalBeforeProofCents: null,
    bestReachCents: null,
  };
  const targets = targetProperties(limits).map((one) => one.property);
  const nodes = (await listNodes(input.projectId)).filter((one) => !one.retiredAt);
  const byId = new Map(nodes.map((one) => [one.id, one]));
  // A reward, prize, grant or rebate is no buyer and no need to construct a sale around (§116).
  const opportunities = (await listOpportunities({ projectId: input.projectId })).filter((one) => !one.duplicateOfId && one.state !== 'DECLINED' && one.state !== 'ARCHIVED' && !isNonPurchasePayment(openingPaymentText(one)));
  const facts = await cardFactsForProject(input.projectId);
  const evidencedPayer = new Set(facts.filter((one) => one.field === 'payer' && one.kind === 'EVIDENCE').map((one) => one.opportunityId));
  const shown = await shownWorkingIn(input.projectId, facts);
  const allowed = (text: string | null | undefined) => !excludedBy(text, exclusions);

  // Parts, grouped by the part of the economy they belong to.
  interface Sector { name: string | null; demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }
  const sectors = new Map<string, Sector>();
  const sector = (name: string | null): Sector => {
    const key = norm(name) || '-';
    if (!sectors.has(key)) sectors.set(key, { name, demand: [], needs: [], supply: [] });
    return sectors.get(key)!;
  };
  /*
   * A project whose own map names too few buyers to construct from — a goal
   * created in a fresh project — also reads the Brain's shared map (§31, §34):
   * production, 2026-11-19, two such goals constructed 4 reverse designs and
   * nothing else while the Brain held a map another goal built 16,262
   * candidates from. Decided from the nodes already read, so a project with a
   * map of its own pays nothing and constructs exactly as before.
   */
  const brain = nodes.filter((one) => one.kind === 'BUYER_TYPE').length < BRAIN_MAP_BELOW ? await brainMapNodes(input.projectId) : null;
  // The claims the map's nodes were filed from: what they state about how these buyers pay (an RFP, a deposit, net terms).
  const nodeClaims = new Map(
    (await claimsByIds([...nodes.map((one) => one.sourceClaimId), ...(brain?.nodes ?? []).map((one) => brain!.claimOf(one))].filter((one): one is string => !!one))).map((one) => [one.id, one]),
  );
  const addNode = (node: IndustryNode, tree: Map<string, IndustryNode>, from: 'INDUSTRY_MAP' | 'BRAIN_MAP', claimId: string | null): void => {
    if (!safeName(node.name) || !allowed(node.name)) return;
    if (node.kind === 'BUYER_TYPE' && !namesABuyerPopulation(node.name)) return;
    const root = rootOf(node, tree);
    if (!allowed(root.name)) return;
    const list = node.kind === 'BUYER_TYPE' ? 'demand' : node.kind === 'BOTTLENECK' ? 'needs' : node.kind === 'FULFILMENT_SOURCE' ? 'supply' : null;
    if (!list) return;
    const path = nodePath(node, tree);
    const parts = sector(root.name)[list];
    // The same subject in two projects' maps is one part, and a project's own row is the one kept.
    if (from === 'BRAIN_MAP' && parts.some((one) => one.path === path)) return;
    const claim = claimId ? nodeClaims.get(claimId) : undefined;
    const terms = combineTimings([
      timingOfText(node.description, `map node "${node.name.slice(0, 60)}"`),
      timingOfText(claim ? [claim.claim, claim.evidenceExcerpt].filter(Boolean).join(' ') : null, `claim ${claim?.id ?? ''}`.trim()),
    ]);
    parts.push({ name: clean(node.name), claimId, from, ref: from === 'BRAIN_MAP' ? `BRAIN:${path}` : node.id, path, ...(terms.timing !== 'UNKNOWN' ? { terms } : {}) });
  };
  for (const node of nodes) addNode(node, byId, 'INDUSTRY_MAP', node.sourceClaimId);
  for (const node of brain?.nodes ?? []) addNode(node, brain!.byId, 'BRAIN_MAP', brain!.claimOf(node));
  // A payer research established is a buyer population too, with what it pays for as its need.
  const byPayer = new Map<string, CashOpportunity[]>();
  for (const o of opportunities) {
    if (!o.payer || !evidencedPayer.has(o.id) || !safeBuyer(o.payer)) continue;
    if (!allowed(o.payer) || !allowed(o.title) || !allowed(o.industry)) continue;
    const k = `${norm(o.industry)}|${norm(o.payer)}`;
    byPayer.set(k, [...(byPayer.get(k) ?? []), o]);
  }
  for (const group of byPayer.values()) {
    const first = group[0]!;
    const s = sector(first.industry);
    if (!s.demand.some((one) => norm(one.name) === norm(first.payer))) s.demand.push({ name: clean(first.payer!), claimId: first.sourceClaimId, from: 'OPENING', ref: first.id, path: `OPENING_PAYER:${norm(first.industry)}>${norm(first.payer)}`, ...termsOfGroup(group) });
    const need = first.offerScope ?? first.title;
    if (safeName(need)) s.needs.push({ name: clean(need), claimId: first.sourceClaimId, from: 'OPENING', ref: first.id, path: `OPENING_NEED:${norm(first.industry)}>${norm(need)}`, ...termsOfGroup(group) });
  }
  addSignalDemand(opportunities, facts, evidencedPayer, allowed, sector);

  /*
   * Designs held openings show working, by structure: an opening a buyer paid
   * on, or whose payer and price gated claims established (`shownWorking`), is
   * a published precedent for that design. Carried to a different buyer it is a transfer — the
   * causal economics, not the business.
   */
  const precedentByBase = heldPrecedents(opportunities.filter((o) => allowed(o.title)), shown);

  const { priced, tiedUp, facts: factObs, capability, paysFor } = await heldEvidence(input, opportunities, allowed);
  // What each buyer population is shown paying for, wherever it was filed: a design whose own sector names no need takes it (`forEachCandidate`).
  const paidFor = paidForParts(opportunities, paysFor, allowed);
  /*
   * The same inputs construct the same arrangements, so a plan re-read whose map, openings,
   * facts and limits did not move reuses the last construction instead of composing up to
   * MAX_CONSTRUCTIONS designs again (production, 2026-11-14: ~11 s of quant CPU a minute on
   * the main thread, most of it identical re-construction, and the garbage it left behind).
   * Keyed by the day, as the reconstructions' recency is.
   */
  /*
   * What the library already holds about these structures (migration 152): a
   * research verdict ranks candidates before the cap cuts, and an
   * arrangement stored under exactly this composition's inputs is reused
   * rather than recomposed — after a restart, a deploy or by another goal.
   */
  const { known, reuse, held: leaders } = await libraryFor(input.projectId, input.goalId);
  const rotation = rotationWindow(now);
  /*
   * The relational event graph (ALGO-16-1 items 3–4): brought up to date with
   * the durable detection rows changed since the last pass — only their
   * neighborhoods recompute — and its hypotheses joined with the structures
   * they can be paid through, pruned on the goal's hard constraints. Every
   * result stays a hypothesis; it is reported beside this pass, never read as
   * a found opening.
   */
  const graphReport = await graphPass(input, exclusions, now);
  graphReports.set(input.projectId, graphReport);
  /*
   * The kept graph constructions are construction inputs, not a report beside
   * it (R3-F1): their buyers, need and suppliers become parts in their own
   * neighborhood's sector, so the same composition, ranking, portfolio and
   * research questions (`askConstructedArrangements`) that every other part
   * reaches, reach them. A part carries no gated claim, so its payer and
   * supplier stay questions for research to answer, never facts.
   */
  addGraphParts(graphReport.result.kept, allowed, sector);
  // What the rows state about each lever's parts, each payer's contract limit, and the real limits leverage is judged against (S-0103).
  const { leverEvidence, contractLimits } = await leverInputs(input, opportunities, facts, allowed);
  const constraints = await leverageConstraints(input, limits);
  const memoKey = createHash('sha256')
    .update(JSON.stringify({ day: now.toISOString().slice(0, 10), input: { ...input, now: undefined, limits: undefined }, limits, targets, exclusions, sectors: [...sectors.values()], precedent: [...precedentByBase.entries()].map(([k, o]) => [k, o.id]), priced, tiedUp, factObs, paidFor, leverEvidence, contractLimits, constraints, openings: opportunities.map((o) => [o.id, o.payer, o.mechanism, o.state, o.updatedAt]), known, leaders, rotation }))
    .digest('hex');
  const held = constructionMemo.get(memoKey);
  if (held && Date.now() - held.at < CONSTRUCTION_MEMO_MS) return structuredClone(held.result);
  const job: ConstructionJob = { sectors: [...sectors.values()], opportunities, precedent: [...precedentByBase.entries()], capability, paidFor, priced, tiedUp, facts: factObs, leverEvidence, contractLimits, input, limits, targets, exclusions, now, constraints, known, reuse, held: leaders, rotation };
  // How many candidates the parts support, against how many are composed, and why each composed one was: the cut is reported, never silent (K-2).
  const selection = selectCandidates(job);
  const { considered } = selection;
  /*
   * Composing is synchronous quantitative work — several reconstructions per
   * design, up to `MAX_CONSTRUCTIONS` designs. Run in one stretch it held
   * Node's only event loop for 11.6 s in production (2026-11-05 23:29Z and
   * 23:33Z, both processes, inside russell:goal-plans); run in 25 ms slices it
   * was still ~11 s of the main thread's CPU a minute (2026-11-14), and a
   * single design's reconstructions could exceed a slice. It runs on the
   * evaluator pool's niced threads, the same ones that judge the plan (§101),
   * and inline — yielding every `YIELD_EVERY_MS` — only when no thread can
   * start. Either way it is the one `composeConstruction`.
   */
  let ranked: ConstructedArrangement[];
  const plan = compositionPlan(job, selection);
  if (plan.filter((one) => !one.stored).length + MAX_REVERSE <= INLINE_COMPOSITIONS) {
    ranked = await composeConstruction(job, YIELD_EVERY_MS, plan);
  } else {
    const { sharedEvaluator } = await import('../goals/reasoning/evaluatorPool.ts');
    const evaluator = sharedEvaluator();
    try {
      ranked = evaluator.construct ? await evaluator.construct(job) : await composeConstruction(job, YIELD_EVERY_MS, plan);
    } finally {
      await evaluator.close();
    }
  }
  // The goal's leaders are marked, so the model's few slots hold them as construction did (P4).
  const leading = new Set(leaders);
  for (const one of ranked) {
    if (one.signature && leading.has(one.signature)) one.leader = true;
    else delete one.leader;
  }
  constructionMemo.set(memoKey, { at: Date.now(), result: structuredClone(ranked) });
  dropStale(constructionMemo, CONSTRUCTION_MEMO_MS);
  while (constructionMemo.size > CONSTRUCTION_MEMO_MAX) constructionMemo.delete(constructionMemo.keys().next().value!);
  const reusable = new Set(reuse.map(([under]) => under));
  constructionReports.set(input.projectId, {
    considered,
    composed: selection.selected.length,
    cut: Math.max(0, considered - selection.selected.length),
    held: selection.held,
    evidenced: selection.evidenced,
    evidencedCut: selection.evidencedCut,
    rotated: selection.rotated,
    neverComposed: selection.neverComposed,
    reused: ranked.filter((one) => one.composedUnder !== undefined && reusable.has(one.composedUnder)).length,
    at: now.toISOString(),
  });
  return ranked;
}

/** The published prices, money tied up and proved capability every composition reads. */
async function heldEvidence(input: ConstructionInput, opportunities: CashOpportunity[], allowed: (text: string | null | undefined) => boolean): Promise<{ priced: Observation[]; tiedUp: Observation[]; facts: FactObservations; capability: Primitive | null; paysFor: PaidFor[] }> {
  // Published prices the project holds, as observations about the buyers who paid them.
  const priced = opportunities
    .filter((one) => one.payer && one.priceCents && one.priceCents > 0 && one.currency === input.currency && allowed(one.title) && !isNonPurchasePayment(openingPaymentText(one)))
    .map((one): Observation => ({
      id: `opp:${one.id}`,
      value: { kind: 'POINT', value: one.priceCents! / 100 },
      context: { payer: norm(one.payer), industry: norm(one.industry), arrangement: 'held' },
      lineage: [one.sourceClaimId ? `claim:${one.sourceClaimId}` : `opp:${one.id}`],
      source: one.sourceClaimId ? { kind: 'CLAIM', ref: one.sourceClaimId } : { kind: 'CASH_OPPORTUNITY', ref: one.id },
      measures: `the price on "${one.title.slice(0, 60)}"`,
    }));
  // Repeat business a delivered, accepted deal's buyer gave afterwards: new economic evidence about what that payer pays (LIFE-29-2).
  const repeat = await repeatBusinessObservations(input.projectId, input.currency);
  priced.push(...repeat);
  // What research observed these buyers pay, filed as construction facts (F2): the same priced path.
  const facts = await constructionObservations(input, allowed);
  priced.push(...facts.priced);
  // What deals for these buyers tied up before money came in: evidence for a run's or a deal's exposure.
  const tiedUp = opportunities
    .filter((one) => one.payer && one.peakFundingCents !== null && one.peakFundingCents > 0 && one.currency === input.currency && allowed(one.title))
    .map((one): Observation => ({
      id: `cap:${one.id}`,
      value: { kind: 'POINT', value: one.peakFundingCents! / 100 },
      context: { payer: norm(one.payer), industry: norm(one.industry), arrangement: 'held' },
      lineage: [one.sourceClaimId ? `claim:${one.sourceClaimId}` : `opp:${one.id}`],
      source: one.sourceClaimId ? { kind: 'CLAIM', ref: one.sourceClaimId } : { kind: 'CASH_OPPORTUNITY', ref: one.id },
      measures: `money tied up on "${one.title.slice(0, 60)}"`,
    }));
  const capability = capabilityPart(input.delivers);
  return { paysFor: facts.paysFor, priced, tiedUp, facts: { unitCost: facts.unitCost, volume: facts.volume, conversion: facts.conversion, buyers: facts.buyers, ...(facts.runCost.length > 0 ? { runCost: facts.runCost } : {}), ...(facts.commission.length > 0 ? { commission: facts.commission } : {}) }, capability };
}

/**
 * What the project's rows say about each lever's own parts (S-0103): buyer
 * prepayment willingness, refund obligations, when funds are usable, a
 * supplier's capacity, failures and payment terms, AI labor's cost and
 * throughput, and when buyers settle — read from the EVIDENCE card facts
 * research filed and the openings' published payment terms, so an answer to
 * the prepayment question construction asks changes the next reading.
 *
 * And a contract's transaction limit ("enforce actual … contract
 * constraints"), per payer, read from the same rows: the terms an opening
 * states and the evidence facts beside it. A payer whose rows state no
 * maximum has an unknown contract limit — a question, never unlimited.
 */
async function leverInputs(
  input: Pick<ConstructionInput, 'currency' | 'daysLeft'>,
  opportunities: readonly CashOpportunity[],
  cardFacts: readonly CashCardFact[],
  allowed: (text: string | null | undefined) => boolean,
): Promise<{ leverEvidence: LeverEvidence; contractLimits: ContractLimits }> {
  const leverFacts = cardFacts.filter((one) => one.kind === 'EVIDENCE');
  const openings = opportunities.filter((one) => allowed(one.title));
  const leverSources = await claimSources([...leverFacts.map((one) => one.claimId), ...opportunities.map((one) => one.sourceClaimId)].filter((one): one is string => !!one));
  const leverEvidence = leverEvidenceFrom({ opportunities: openings, facts: leverFacts, sources: leverSources, currency: input.currency, periodDays: input.daysLeft });
  const contractLimits = contractLimitsFrom({ opportunities: openings, facts: leverFacts, periodDays: input.daysLeft });
  return { leverEvidence, contractLimits };
}

/** Construction facts that bear on a composition beyond its price: what supply costs per unit, how much one buyer buys, how many there are and what share agree. */
export interface FactObservations {
  /** What supply is paid per unit for these buyers' work: a margin design's supply cost. */
  unitCost: Observation[];
  /** Units one of these buyers buys in the goal window: the demand side's need rate. */
  volume: Observation[];
  /**
   * The share of these buyers approached who bought (`account_win_rate`): the
   * demand side's `conversion`, "share of reached buyers who agree"
   * (quant/mechanism.ts). Absent reads as none filed (R3).
   */
  conversion?: Observation[];
  /**
   * How many buyers of this kind a stated market holds (`accounts_reachable`):
   * the demand side's `buyers`, "buyers who have the need" — a count, never the
   * `reach` share, which stays unknown until outreach measures it (R3).
   */
  buyers?: Observation[];
  /**
   * What supply charges for one whole run (`fixed_cost_per_run`, B1j): a pooled
   * design's `fixed_cost` — what the run costs whether one buyer or many share
   * it — and, for a design that buys one run per deal, what supply is paid per
   * deal. Absent reads as none filed.
   */
  runCost?: Observation[];
  /**
   * The share of these buyers' price an intermediary keeps
   * (`broker_take_rate`): a BROKER or REFERRAL design's commission. Absent
   * reads as none filed, and the commission stays an unknown swept low.
   */
  commission?: Observation[];
}

/** Fact keys read as a price these buyers pay, a unit cost of serving them, a volume they buy, a share who agree and how many there are. */
const FACT_PRICE_KEYS: readonly FactKey[] = ['price_per_unit'];
const FACT_COST_KEYS: readonly FactKey[] = ['contractor_rate_per_unit'];
const FACT_RUN_COST_KEYS: readonly FactKey[] = ['fixed_cost_per_run'];
const FACT_VOLUME_KEYS: readonly FactKey[] = ['account_units_per_month'];
const FACT_CONVERSION_KEYS: readonly FactKey[] = ['account_win_rate'];
const FACT_BUYERS_KEYS: readonly FactKey[] = ['accounts_reachable'];
/*
 * A take rate is filed per role, not per buyer segment (`FACT_KEYS`), so it is
 * read for these buyers when it is segmented to them or, unsegmented, was filed
 * by a round about their buyer-type node — never handed to any other buyers.
 */
const FACT_COMMISSION_KEYS: readonly FactKey[] = ['broker_take_rate'];
/** Only what was seen: a sourced claim that reports its source (OBSERVED) or a person's attestation (VERIFIED). */
const FACT_EVIDENCE_STATUSES: readonly FactStatus[] = ['OBSERVED', 'VERIFIED'];

/**
 * Project-level construction facts (W-5) about a buyer type on the map, as
 * observations about the buyers that node names (F2, 2026-11-15). Before this
 * the arrangement builder priced from opening columns alone, and a figure
 * research filed for "Independent restaurants" never reached an arrangement
 * whose buyers are exactly those.
 *
 * Only a fact segmented to one map buyer (`map_<node id>`) is read, so a
 * figure about one population is never handed to another (PRICE-POOL), and
 * only an OBSERVED or VERIFIED one: an estimate or an assumption is not
 * evidence of what these buyers pay. Each carries its observation date and
 * validity (W-10), so the reconstruction ages it as it ages any other. Money
 * facts are recorded in USD (`FACT_KEYS` units) and are read only for a USD
 * goal: a figure is never converted at a rate nobody chose. The lineage is the
 * claim, so a fact and the opening priced from the same claim count once.
 */
export async function constructionObservations(
  input: Pick<ConstructionInput, 'projectId' | 'currency' | 'daysLeft'>,
  allowed: (text: string | null | undefined) => boolean = () => true,
): Promise<{ priced: Observation[]; unitCost: Observation[]; runCost: Observation[]; volume: Observation[]; conversion: Observation[]; buyers: Observation[]; commission: Observation[]; paysFor: PaidFor[] }> {
  const out = { priced: [] as Observation[], unitCost: [] as Observation[], runCost: [] as Observation[], volume: [] as Observation[], conversion: [] as Observation[], buyers: [] as Observation[], commission: [] as Observation[], paysFor: [] as PaidFor[] };
  // The buyer-type node a fact is about: its segment, or — for a take rate filed unsegmented — the node its round was about.
  const nodeOf = (one: { key: FactKey; segment?: string | null; nodeId?: string | null }): string | null =>
    one.segment?.startsWith('map_') ? one.segment.slice('map_'.length) : !one.segment && FACT_COMMISSION_KEYS.includes(one.key) ? (one.nodeId ?? null) : null;
  const facts = (await listProjectConstructionFacts(input.projectId)).filter((one) => FACT_EVIDENCE_STATUSES.includes(one.status) && nodeOf(one) !== null);
  if (facts.length === 0) return out;
  const all = await listNodes(input.projectId);
  const byId = new Map(all.map((one) => [one.id, one]));
  const usd = input.currency.toUpperCase() === 'USD';
  const windowMonths = Math.max(1, input.daysLeft) / 30;
  // The source claims of the price facts, read once: whether each states its figure per participant (F4).
  const priceClaims = new Map(
    (await claimsByIds([...new Set(facts.filter((one) => FACT_PRICE_KEYS.includes(one.key) && one.sourceClaimId).map((one) => one.sourceClaimId!))])).map((one) => [one.id, one.claim]),
  );
  for (const fact of facts) {
    const node = byId.get(nodeOf(fact)!);
    if (!node || node.retiredAt || node.kind !== 'BUYER_TYPE' || !safeBuyer(node.name) || !allowed(node.name)) continue;
    const root = rootOf(node, byId);
    if (!allowed(root.name)) continue;
    const kind = FACT_PRICE_KEYS.includes(fact.key)
      ? 'priced'
      : FACT_COST_KEYS.includes(fact.key)
        ? 'unitCost'
        : FACT_RUN_COST_KEYS.includes(fact.key)
          ? 'runCost'
          : FACT_VOLUME_KEYS.includes(fact.key)
          ? 'volume'
          : FACT_CONVERSION_KEYS.includes(fact.key)
            ? 'conversion'
            : FACT_BUYERS_KEYS.includes(fact.key)
              ? 'buyers'
              : FACT_COMMISSION_KEYS.includes(fact.key)
                ? 'commission'
                : null;
    if (!kind) continue;
    // Only money is in USD; a share and a count mean the same in any goal's currency.
    if ((kind === 'priced' || kind === 'unitCost' || kind === 'runCost') && !usd) continue;
    // A volume is per month, read over the window; a share and a count are not per anything.
    const scale = kind === 'volume' ? windowMonths : 1;
    const low = Math.min(fact.low, fact.high) * scale;
    const high = Math.max(fact.low, fact.high) * scale;
    if (!(high > 0)) continue;
    // A share above the whole is no share (the filer refuses one; a person's attestation is held to the same).
    if ((kind === 'conversion' || kind === 'commission') && high > 1) continue;
    // A rate per word or per hour is not what one purchase costs: read beside a plan's price it would widen one range across units.
    if (kind === 'priced' && statesMeasuredRate(fact.sourceClaimId ? priceClaims.get(fact.sourceClaimId) : undefined, low, high)) continue;
    // A reward, grant, rebate or wage is not what anyone pays for a deliverable (audit 2026-11-23: GitHub's $10,000 bug-bounty reward was read as the price GitHub pays).
    if (kind === 'priced' && isNonPurchasePayment(fact.sourceClaimId ? (priceClaims.get(fact.sourceClaimId) ?? fact.measures) : fact.measures)) continue;
    // A fee the selling side pays, or a supplier's own input cost, runs the other way: it is never what this population pays (Task E, 2026-11-24).
    if (kind === 'priced' && wrongWayPrice(fact.sourceClaimId ? (priceClaims.get(fact.sourceClaimId) ?? fact.measures) : fact.measures, node.name)) continue;
    // What the figure is a price of, in its source's words: what these buyers are shown paying for (`paidForParts`).
    if (kind === 'priced' && fact.measures?.trim()) out.paysFor.push({ payer: node.name, name: fact.measures, claimId: fact.sourceClaimId ?? null, ref: `fact:${fact.id}` });
    out[kind].push({
      id: `fact:${fact.id}`,
      value: low === high ? { kind: 'POINT', value: low } : { kind: 'RANGE', low, high },
      context: { payer: norm(node.name), industry: norm(root.name), arrangement: 'held' },
      lineage: [fact.sourceClaimId ? `claim:${fact.sourceClaimId}` : `fact:${fact.id}`],
      source: fact.sourceClaimId ? { kind: 'CLAIM', ref: fact.sourceClaimId } : { kind: 'OTHER', ref: `construction_fact:${fact.id}` },
      observedAt: fact.observedAt ?? null,
      validUntil: fact.validUntil ?? null,
      measures: `${fact.key}${kind === 'volume' ? ` over ${Math.round(windowMonths * 10) / 10} month(s)` : ''}: ${fact.measures.slice(0, 120)}`,
      ...(kind === 'priced' && statesParticipantShare(fact.sourceClaimId ? priceClaims.get(fact.sourceClaimId) : undefined, low, high) ? { unit: 'PARTICIPANT_SHARE' as const } : {}),
    });
  }
  return out;
}

/**
 * What other projects' validated findings say buyers pay (§31): a
 * `price_per_unit` construction fact another project filed about one of its
 * map's buyer types, OBSERVED or VERIFIED, whose source claim is an eligible
 * shared finding right now (`eligibleClaimIds`). A validated finding belongs
 * to the Brain; the row another project filed from it is only its structured
 * reading, so nothing that project decided (an opening, a quote, a price it
 * would charge — §34's private commercial terms) is read here.
 *
 * Read only as comparable prices a project with no published price of its own
 * sweeps an unpriced arrangement across (`comparablePricesFor`): mechanism
 * bounds, provenance UNKNOWN, never a price for any arrangement's own buyers
 * and never anything that certifies. Production, 2026-11-18: two goals in
 * fresh projects cut all 208 arrangements because "the project holds no
 * published price" while the Brain held validated ones. USD only, as every
 * money fact is filed (a figure is never converted at a rate nobody chose).
 * A range is read at its geometric middle (a price is a magnitude).
 */
export async function brainComparablePrices(
  input: Pick<ConstructionInput, 'projectId' | 'currency'>,
  allowed: (text: string | null | undefined) => boolean = () => true,
): Promise<{ value: number; industry: string | null; payer: string; brain: true }[]> {
  if (input.currency.toUpperCase() !== 'USD') return [];
  const facts = (await listOtherProjectsClaimFacts(input.projectId, FACT_PRICE_KEYS)).filter((one) => FACT_EVIDENCE_STATUSES.includes(one.status) && one.segment?.startsWith('map_') && one.projectId);
  if (facts.length === 0) return [];
  const eligible = await eligibleClaimIds(facts.map((one) => one.sourceClaimId!));
  const claimText = new Map((await claimsByIds([...new Set(facts.filter((one) => eligible.has(one.sourceClaimId!)).map((one) => one.sourceClaimId!))])).map((one) => [one.id, one.claim]));
  const out: { value: number; industry: string | null; payer: string; brain: true }[] = [];
  const nodesOf = new Map<string, Map<string, IndustryNode>>();
  for (const fact of facts) {
    if (!eligible.has(fact.sourceClaimId!)) continue;
    let byId = nodesOf.get(fact.projectId!);
    if (!byId) {
      byId = new Map((await listNodes(fact.projectId!)).map((one) => [one.id, one]));
      nodesOf.set(fact.projectId!, byId);
    }
    const node = byId.get(fact.segment!.slice('map_'.length));
    if (!node || node.retiredAt || node.kind !== 'BUYER_TYPE' || !safeBuyer(node.name) || !allowed(node.name)) continue;
    const root = rootOf(node, byId);
    if (!allowed(root.name)) continue;
    const low = Math.min(fact.low, fact.high);
    const high = Math.max(fact.low, fact.high);
    if (!(low > 0)) continue;
    // A rate per word or per hour bounds no purchase's price (`statesMeasuredRate`).
    if (statesMeasuredRate(claimText.get(fact.sourceClaimId!), low, high)) continue;
    out.push({ value: low === high ? low : Math.sqrt(low * high), industry: root.name, payer: node.name, brain: true });
  }
  return out;
}

/** Below this many live buyer types of its own, a project's construction also reads the Brain's map (`brainMapNodes`). */
export const BRAIN_MAP_BELOW = 3;

/** What an arrangement composed from the Brain's map says about where its parts came from. */
export const BRAIN_MAP_SENTENCE =
  "Its parts come from the Brain's shared industry map (the shared frontier's discovery and other projects' validated findings), not from this project's own research.";

/** The construction fact keys whose rows evidence a map subject (what `constructionObservations` reads). */
const FACT_EVIDENCE_KEYS: readonly FactKey[] = [...FACT_PRICE_KEYS, ...FACT_COST_KEYS, ...FACT_RUN_COST_KEYS, ...FACT_VOLUME_KEYS, ...FACT_CONVERSION_KEYS, ...FACT_BUYERS_KEYS];

/**
 * The Brain's shared industry map, as a project other than its holders reads
 * it: the buyer types, bottlenecks and fulfilment sources of
 *
 *   - the shared frontier's root (`findCashRoot`) — discovery is one shared
 *     frontier, filed under the root, and private only once an opening becomes
 *     an execution job (§34, `root.ts`); and
 *   - any other project, where a validated finding evidences the subject: the
 *     node was filed from a claim that is an eligible shared finding right now,
 *     or an OBSERVED/VERIFIED construction fact segmented to it was (§31,
 *     `eligibleClaimIds`, the rule `brainComparablePrices` reads).
 *
 * A subject is a population, a need or a source of supply — evidence about the
 * world. Nothing an operation decided is read: no opening, quote, price it
 * would charge, ledger or grant (§34's private commercial terms). `byId` holds
 * every other live node so a subject's sector is named by its own map's root;
 * an ancestor is only a name and never a part. `claimOf` gives a subject's
 * claim only while it is an eligible finding, so an unvalidated or contested
 * claim establishes nothing in the asking project. Read only when the asking
 * project's own map names fewer than `BRAIN_MAP_BELOW` buyers; its figures
 * reach a plan only as comparable prices (`brainComparablePrices`), MECHANISM
 * bounds that never certify.
 */
export async function brainMapNodes(projectId: string): Promise<{ nodes: IndustryNode[]; byId: Map<string, IndustryNode>; claimOf: (node: IndustryNode) => string | null }> {
  const none = { nodes: [], byId: new Map<string, IndustryNode>(), claimOf: () => null };
  const others = await listOtherProjectsLiveNodes(projectId);
  if (others.length === 0) return none;
  const { findCashRoot } = await import('./root.ts');
  const root = await findCashRoot().catch(() => null);
  const rootId = root && root.id !== projectId ? root.id : null;
  const facts = (await listOtherProjectsClaimFacts(projectId, FACT_EVIDENCE_KEYS)).filter((one) => FACT_EVIDENCE_STATUSES.includes(one.status) && one.segment?.startsWith('map_') && one.projectId);
  const eligible = await eligibleClaimIds([...others.map((one) => one.sourceClaimId), ...facts.map((one) => one.sourceClaimId)].filter((one): one is string => !!one));
  const byId = new Map(others.map((one) => [one.id, one]));
  const evidenced = new Set(
    facts
      .filter((one) => eligible.has(one.sourceClaimId!) && byId.get(one.segment!.slice('map_'.length))?.projectId === one.projectId)
      .map((one) => one.segment!.slice('map_'.length)),
  );
  const nodes = others.filter(
    (one) =>
      (one.kind === 'BUYER_TYPE' || one.kind === 'BOTTLENECK' || one.kind === 'FULFILMENT_SOURCE') &&
      (one.projectId === rootId || evidenced.has(one.id) || (!!one.sourceClaimId && eligible.has(one.sourceClaimId))),
  );
  return { nodes, byId, claimOf: (node) => (node.sourceClaimId && eligible.has(node.sourceClaimId) ? node.sourceClaimId : null) };
}

/**
 * Whether a price fact's own source claim states that very figure as one
 * participant's share of a shared purchase (`$395 for a slot`, F4). Only the
 * claim's words decide, and only a figure inside the fact's range: a
 * whole-run total, a supply quote or a campaign price never states it. Pure.
 */
export function statesParticipantShare(claim: string | null | undefined, low: number, high: number): boolean {
  if (!claim) return false;
  return readMoneyFigures(claim, 'USD').some((one) => one.perParticipant === true && one.cents / 100 >= low - 0.005 && one.cents / 100 <= high + 0.005);
}

/**
 * Whether a price fact's own source claim states that very figure as a rate
 * per a measured quantity of the work — per word, page, hour, minute
 * (`readMoneyFigures`' `perMeasure`). Every price the plan reads is what one
 * payer pays for one purchase (`a_value`), and one purchase is such a rate
 * times a quantity nobody stated, so the figure is no evidence of it and is
 * not read as one (invariant 39: the quantity is never assumed). Production,
 * 2026-11-20 (prj_22fb4fec, map_ind_42887b66ff1e476990b4): WriterAccess's
 * "$0.04 per word", "$0.05 per word" and "$449 per month" answered one
 * population's price question and the plan read one price of
 * $0.00007–$9,576 per deal. The fact row stays; only this reading of it is
 * refused, and a price that only a rate answered stays a question. Only a
 * figure inside the fact's range is judged, and only when every such figure
 * is a measured rate: a claim stating the total for one purchase beside its
 * rate is that total. Pure.
 */
export function statesMeasuredRate(claim: string | null | undefined, low: number, high: number): boolean {
  if (!claim) return false;
  const inRange = readMoneyFigures(claim, 'USD').filter((one) => one.cents / 100 >= low - 0.005 && one.cents / 100 <= high + 0.005);
  return inRange.length > 0 && inRange.every((one) => one.perMeasure === true);
}

// ---------------------------------------------------------------- designs a model invents (lens S, S-11)

/**
 * A transaction design a reasoning model proposed for a buyer population the
 * project may not hold (§101): the design tuple, who pays, and optionally what
 * they pay for. It is a hypothesis about structure, never a figure: nothing a
 * model says becomes a price, a rate or a count.
 */
export interface InventedDesign {
  design: Design;
  /** The buyer population, in the model's words. */
  population: string;
  /** What they pay to have dealt with, when the model named it. */
  need: string | null;
}

/** Everything composing an invented design reads, gathered once per exploration. */
export interface InventionContext {
  opportunities: CashOpportunity[];
  priced: Observation[];
  tiedUp: Observation[];
  facts?: FactObservations;
  /** What the rows state about each lever's own parts (S-0103); absent reads as nothing stated. */
  leverEvidence?: LeverEvidence;
  /** Per payer, the transaction limit stated terms impose; absent reads as nothing stated. */
  contractLimits?: ContractLimits;
  capability: Primitive | null;
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
}

/** Read what an invented design is composed against: the same rows `constructArrangements` reads, without its enumeration. */
export async function inventionContext(input: ConstructionInput): Promise<InventionContext> {
  const now = input.now ?? new Date();
  const exclusions = input.exclusions ?? [];
  const limits: GoalLimits = input.limits ?? { daysLeft: input.daysLeft, remainingCents: Number.MAX_SAFE_INTEGER, capitalCeilingCents: input.capitalCeilingCents, capitalBeforeProofCents: null, bestReachCents: null };
  const allowed = (text: string | null | undefined) => !excludedBy(text, exclusions);
  // A reward, prize, grant or rebate is no buyer and no need to construct a sale around (§116).
  const opportunities = (await listOpportunities({ projectId: input.projectId })).filter((one) => !one.duplicateOfId && one.state !== 'DECLINED' && one.state !== 'ARCHIVED' && !isNonPurchasePayment(openingPaymentText(one)));
  const { priced, tiedUp, facts, capability } = await heldEvidence(input, opportunities, allowed);
  const { leverEvidence, contractLimits } = await leverInputs(input, opportunities, await cardFactsForProject(input.projectId), allowed);
  return { opportunities, priced, tiedUp, facts, leverEvidence, contractLimits, capability, input, limits, targets: targetProperties(limits).map((one) => one.property), exclusions, now };
}

/**
 * Compose a model's invented design through the one construction path
 * (`compose`), exactly as a forward arrangement is composed — the population
 * is a part the world is asked for (`from: 'REVERSE'`), so nothing about it is
 * evidenced until research establishes it, and what these buyers pay is
 * reconstructed only from published prices *these* buyers paid. Refused, with
 * the reason, when the design is incoherent, needs a deliverable Brain has not
 * proved, names a state or an action Brain may not take, is excluded by the
 * goal's owner, or puts physical work on the owner. Pure over the context.
 */
export function composeInvented(spec: InventedDesign, ctx: InventionContext): ConstructedArrangement | { refused: string } {
  const { design } = spec;
  if (!STRUCTURE_KEYS.includes(design.base) || !allDesigns([design.base]).some((d) => designKey(d) === designKey(design))) return { refused: `the design ${designKey(design)} is not a coherent transaction design` };
  const def = STRUCTURES[design.base];
  if (def.needsDeliverable && !ctx.capability) return { refused: `${design.base} needs a deliverable Brain has proved it can produce, and none is proved in this process` };
  const population = clean(spec.population);
  const need = spec.need ? clean(spec.need) : null;
  if (population.length < 3) return { refused: 'it names no buyer population' };
  if (!safeName(population) || (need !== null && !safeName(need))) return { refused: 'its buyers or need name a jurisdiction or an action Brain may not take' };
  if (!namesABuyerPopulation(population)) return { refused: 'its buyers are a sentence fragment or an unknown party, not a kind of buyer a list can be built of' };
  if (excludedBy(population, ctx.exclusions) || excludedBy(need, ctx.exclusions)) return { refused: "the goal's owner excluded what it is" };
  if (!def.needsSupply && need && breaksOperatingModel(operatingFit({ title: need }))) return { refused: 'Brain would have to produce physical work itself' };
  const related = ctx.opportunities.filter((one) => norm(one.payer) === norm(population));
  if (isDefaultDesign(design) && related.some((one) => (def.alreadyHeldAs as readonly string[]).includes(one.mechanism))) return { refused: 'these buyers are already held sold exactly this way: it is not a new mechanism' };
  const demand: Primitive = { name: population, claimId: null, from: 'REVERSE', ref: `invented:${norm(population)}`, path: `INVENTED_BUYER:${norm(population)}` };
  const needPart: Primitive | null = need ? { name: need, claimId: null, from: 'REVERSE', ref: `invented-need:${norm(need)}`, path: `INVENTED_NEED:${norm(need)}` } : null;
  const supply = def.needsSupply ? null : ctx.capability;
  return compose({ ...ctx, design, origin: 'FORWARD', precedent: null, sector: null, demand, need: needPart, supply, related }).arrangement;
}

/** What the last construction for a project considered, composed, cut and reused. */
export interface ConstructionReport {
  /** Forward and transfer candidates the parts support. */
  considered: number;
  /** Of those, composed this pass (at most `MAX_CONSTRUCTIONS`). */
  composed: number;
  /** Ranked below the cap and not composed: still in the space, never discarded (§47). */
  cut: number;
  /** Taken from the library because their composition inputs had not changed. */
  reused: number;
  /** Composed because the goal's current or previous plan led with them (P4). */
  held: number;
  /** Composed because they hold observed or verified evidence for their buyers or supply, or a research confirmation (P4). */
  evidenced: number;
  /** Evidenced, but beyond the evidenced share of the cap: reported, never silent. */
  evidencedCut: number;
  /** Composed in this hour's rotation window (P4). */
  rotated: number;
  /** Candidates the library has never composed, before this pass. */
  neverComposed: number;
  at: string;
}
const constructionReports = new Map<string, ConstructionReport>();
export function lastConstructionReport(projectId: string): ConstructionReport | null {
  return constructionReports.get(projectId) ?? null;
}

/** What the last construction pass for a project read from the event graph and built from it. */
export interface GraphConstructionReport {
  /** The graph sync this pass ran: rows read since the cursor and neighborhoods recomputed. Null when it could not run. */
  sync: EventGraphSync | null;
  /** Hypotheses the graph holds after the sync. */
  hypotheses: number;
  /** The ranked graph constructions (each a hypothesis) and the pruned ones with their reasons. */
  result: GraphConstructionResult;
  /** Why the graph could not be read this pass, when it could not; construction from the map and openings goes on. */
  error: string | null;
  at: string;
}
const graphReports = new Map<string, GraphConstructionReport>();
export function lastGraphConstruction(projectId: string): GraphConstructionReport | null {
  return graphReports.get(projectId) ?? null;
}

/** One graph pass for a construction: sync the durable rows into the process graph, then construct from its hypotheses. */
export async function graphPass(input: Pick<ConstructionInput, 'capitalCeilingCents' | 'delivers'>, exclusions: readonly ExclusionClass[], now: Date): Promise<GraphConstructionReport> {
  let sync: EventGraphSync | null = null;
  let error: string | null = null;
  try {
    sync = await syncEventGraph(now);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const hypotheses = currentEventGraph().hypotheses();
  const result = constructFromGraph(hypotheses, { capitalCeilingCents: input.capitalCeilingCents, delivers: input.delivers, exclusions });
  return { sync, hypotheses: hypotheses.length, result, error, at: now.toISOString() };
}

/**
 * What the library holds for construction to rank by and reuse.
 *
 * Only what research and stored readings wrote reaches the selection: a
 * verdict, and the goal's leaders. Never the value a composition stored
 * (`value.p50`): every plan read stores what it composed
 * (`rememberArrangements`, persisted or not), so a rank on it let a read
 * reorder the next read's candidates — Deploy 44391060795 and 44410753096,
 * `planningSpeed`'s re-read composed a different 400 and its plan changed.
 */
async function libraryFor(projectId: string, goalId: string | undefined): Promise<{ known: NonNullable<ConstructionJob['known']>; reuse: NonNullable<ConstructionJob['reuse']>; held: string[] }> {
  const { listConstructedArrangements, recentLeaderSignatures } = await import('../../repos/monetization.ts');
  const rows = await listConstructedArrangements(projectId);
  /*
   * Each stored signature's current spelling: a row an arrangement Brain
   * produces was stored under while its capability was spelt from the whole
   * deliverables list re-signs to its structure's signature now
   * (`arrangementSignature`). One row per structure is re-signed in place, so
   * its verdict, evaluations and asked count stay on the row the next pass
   * composes; any other row stored under an older list is read as the same
   * structure (its leader and verdict), never as a second one.
   */
  const current = new Map<string, string>();
  for (const one of rows) current.set(one.signature, canonicalSignature(one.signature, one.design['arrangement']));
  const moving = rows.filter((one) => current.get(one.signature) !== one.signature);
  if (moving.length > 0) {
    const { resignArrangements } = await import('./arrangementLibrary.ts');
    const moved = await resignArrangements(projectId, rows, (one) => current.get(one.signature)!);
    for (const one of rows) {
      const to = moved.get(one.pathId);
      if (to) {
        current.set(to, to);
        one.signature = to;
      }
    }
  }
  const knownBy = new Map<string, { verdict: 'CONFIRMED' | 'REFUTED' | null; composedAt?: string | null }>();
  const reuse: NonNullable<ConstructionJob['reuse']> = [];
  for (const one of rows) {
    const stored = one.design['arrangement'] as ConstructedArrangement | undefined;
    const signature = current.get(one.signature) ?? one.signature;
    const mine = one.verdict?.verdict ?? null;
    const prior = knownBy.get(signature);
    // The row under the current signature speaks for its structure; a row left under an older spelling fills only what it lacks.
    const verdict = !prior ? mine : one.signature === signature && mine !== null ? mine : (prior.verdict ?? mine);
    const composedAt = [one.lastComposedAt, prior?.composedAt].filter((at): at is string => !!at).sort().pop() ?? null;
    knownBy.set(signature, { verdict, composedAt });
    if (stored && typeof stored.composedUnder === 'string' && stored.signature === one.signature && one.signature === signature) reuse.push([stored.composedUnder, stored]);
  }
  const known: NonNullable<ConstructionJob['known']> = [...knownBy.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // The goal's current and previous leaders (P4), composed every pass whatever the cap — by their structure's current signature.
  const held = goalId ? [...new Set((await recentLeaderSignatures(goalId)).map((one) => current.get(one) ?? one))].sort() : [];
  return { known, reuse, held };
}

/**
 * A stored arrangement's signature as `arrangementSignature` spells it now,
 * read from the parts it was stored with; the stored signature when its
 * design cannot be read. Pure.
 */
export function canonicalSignature(storedSignature: string, stored: unknown): string {
  const one = stored as Partial<ConstructedArrangement> | undefined;
  if (!one || typeof one !== 'object' || !one.design || !one.demand) return storedSignature;
  if (one.supply?.from !== 'CAPABILITY' && one.need?.from !== 'CAPABILITY') return storedSignature;
  return arrangementSignature(one.design, one.demand, one.need ?? null, one.supply ?? null);
}

/**
 * The real limits a constructed arrangement's leverage is judged against
 * (S-0103), in the goal's currency: the cash the ledger says may be deployed
 * now (`cashPosition`, invariant 37), and the money a person authorised —
 * what the live cash authority leaves uncommitted, or the goal's capital
 * ceiling, whichever is smaller. A contract limit belongs to one payer's
 * contract, not to the project, so it is null here and read per arrangement
 * from `contractLimitsFrom` (see `constraintsFor`). Whatever cannot be read is
 * null — unknown, never unlimited — and nothing here is a revenue ceiling.
 */
async function leverageConstraints(input: ConstructionInput, limits: GoalLimits): Promise<LeverageConstraints> {
  let cashAvailable: number | null = null;
  let authorityCeiling: number | null = limits.capitalCeilingCents !== null ? limits.capitalCeilingCents / 100 : null;
  try {
    const { cashPosition } = await import('./money.ts');
    const position = await cashPosition({ projectId: input.projectId, currency: input.currency });
    cashAvailable = Math.max(0, position.deployableCents) / 100;
  } catch {
    cashAvailable = null;
  }
  try {
    const { liveAuthority, heldCentsForProject } = await import('../../repos/cashAuthority.ts');
    const grant = await liveAuthority(input.projectId);
    if (grant && grant.currency === input.currency) {
      const left = Math.max(0, grant.maxCommittedCents - (await heldCentsForProject(input.projectId, input.currency))) / 100;
      authorityCeiling = authorityCeiling === null ? left : Math.min(authorityCeiling, left);
    }
  } catch {
    // An unreadable grant leaves the goal's own ceiling, or unknown.
  }
  return { cashAvailable, authorityCeiling, contractMax: null };
}

/** Everything composition reads, as plain data, so it can run on a pool thread (§109). */
export interface ConstructionJob {
  sectors: Array<{ name: string | null; demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }>;
  /** The project's live openings. */
  opportunities: CashOpportunity[];
  /** Per base structure, the held opening that shows it working. */
  precedent: Array<[Structure, CashOpportunity]>;
  capability: Primitive | null;
  /**
   * Per buyer population (`payerKey`), what it is shown paying for wherever
   * that was filed (`paidForParts`): the need a candidate takes when its own
   * sector names none. Absent reads as nothing filed.
   */
  paidFor?: Array<[string, Primitive[]]>;
  priced: Observation[];
  tiedUp: Observation[];
  /** Construction facts about map buyers beyond their price (F2). */
  facts?: FactObservations;
  /** What the rows state about each lever's own parts; absent reads as nothing stated. */
  leverEvidence?: LeverEvidence;
  /** Per payer, the transaction limit a contract or stated terms impose; absent reads as nothing stated. */
  contractLimits?: ContractLimits;
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
  /** The library's verdict and value per signature, for ranking before the cap (migration 152). */
  known?: Array<[string, { verdict: 'CONFIRMED' | 'REFUTED' | null; composedAt?: string | null }]>;
  /** Signatures of the goal's current and previous leaders: always composed (P4). */
  held?: string[];
  /** The rotation window this pass composes (`rotationWindow` of the pass's `now`, P4). Absent is 0. */
  rotation?: number;
  /** Stored arrangements by the composition digest they were composed under: reused, not recomposed. */
  reuse?: Array<[string, ConstructedArrangement]>;
  /** The real limits leverage is judged against, read from the ledger and the live authority; absent is unknown. */
  constraints?: LeverageConstraints;
}

/** One price fact's statement of what a buyer population paid for (`constructionObservations`). */
export interface PaidFor {
  /** The map buyer type the fact is filed against. */
  payer: string;
  /** What the figure measures, in its source's words. */
  name: string;
  claimId: string | null;
  ref: string;
}

/**
 * What each buyer population is shown paying for, keyed by `payerKey`: every
 * live opening's need (its offer, else its title — the need construction
 * already reads from an opening) under the payer it names, and every price
 * fact's described unit under the map buyer it is filed against. Each part
 * carries its source (the opening's claim, the fact's claim) and the opening
 * need's own path, so the same need read here or from its sector is one part.
 *
 * Production, 2026-11-21 (plan reads on 91bf9ef8, goals wst_4f0c…,
 * wst_db2e…, wst_6631…): the leading designs read "what homeowner pay for
 * (not yet specified)" while a published homeowner price was the very
 * figure that priced them, because a need was looked for only in the
 * buyer's own map sector, and an opening's need is filed under its industry.
 * Nothing here decides whether Brain can produce it: `fittedDeliverable`
 * matches it against the proved deliverables, and an unmatched one says so.
 * Bounded per population. Pure.
 */
export function paidForParts(
  opportunities: readonly Pick<CashOpportunity, 'id' | 'payer' | 'offerScope' | 'title' | 'industry' | 'sourceClaimId' | 'updatedAt'>[],
  facts: readonly PaidFor[],
  allowed: (text: string | null | undefined) => boolean = () => true,
): Array<[string, Primitive[]]> {
  const out = new Map<string, Primitive[]>();
  const add = (payer: string, part: Primitive): void => {
    const key = payerKey(payer);
    if (!key) return;
    const list = out.get(key) ?? [];
    if (list.length >= SIGNAL_PARTS_PER_SECTOR || list.some((one) => one.path === part.path)) return;
    list.push(part);
    out.set(key, list);
  };
  const recent = [...opportunities].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1));
  for (const o of recent) {
    const payer = o.payer?.trim();
    const need = o.offerScope ?? o.title;
    if (!payer || !safeBuyer(payer) || !allowed(payer) || !allowed(o.title) || !allowed(o.industry) || !safeName(need)) continue;
    add(payer, { name: clean(need), claimId: o.sourceClaimId, from: 'OPENING', ref: o.id, path: `OPENING_NEED:${norm(o.industry)}>${norm(need)}` });
  }
  for (const f of facts) {
    // What the price buys, read out of the fact's sentence — never the sentence (`paidForUnit`).
    const unit = paidForUnit(f.name);
    if (!unit || !safeBuyer(f.payer) || !allowed(f.payer) || !safeName(unit) || !allowed(unit)) continue;
    add(f.payer, { name: unit, claimId: f.claimId, from: 'INDUSTRY_MAP', ref: f.ref, path: `FACT_NEED:${payerKey(f.payer)}>${norm(unit)}` });
  }
  return [...out.entries()];
}

/** The framings a back-fill puts before a source's words in a fact's `measures` (`industry/expand.ts`): what the figure is, never what is bought. */
const FACT_FRAMINGS: readonly RegExp[] = [
  /^.*?\bfrom a constructed arrangement['’]s research\s*:\s*/i,
  /^answering Brain['’]s price question about "[^"]*"\s*:\s*/i,
  /^what this buyer pays per unit of work,? as published\s*:?\s*/i,
];
/** A money figure, removed so two prices of one thing read as one thing. */
const MONEY_FIGURE = /(?:USD|US\$|\$|€|£)\s?\d[\d,.]*(?:\s?(?:k|m|thousand|million))?|\b\d[\d,.]*\s?(?:USD|dollars?)\b/gi;
/** What a sentence pays: a paying verb, then (within a few words) "per / for / to / on" and its object. */
const PAID_OBJECT = /\b(?:pays?|paid|paying|charges?|charged|charging|costs?|spends?|spent|bills?|billed|fees?|prices?|priced)\b(?:\s+[^\s.;:]+){0,6}?\s+(?:per|for|to|on)\s+(?:an?\s+|the\s+|each\s+|one\s+|every\s+)?([a-z][^.;:,()"\n]{2,120})/i;
/** Where an object phrase ends and the sentence goes on about something else. */
const OBJECT_END = /\s+(?:according|which|that|while|whereas|but|as of|as published|in (?:19|20)\d\d|from (?:the|a|an)\b|on (?:the|a|an|its|their|his|her) (?:blog|page|site|website)|per the)\b.*$/i;
/** Words that describe where a figure was read, not what anyone bought. */
const SOURCE_WORDS = /\b(?:blog|blog post|article|listing|source|published|publishes|states?|says|according|reports? that)\b/i;
/** A rate's unit is how a price is counted, never what is bought. */
const RATE_UNIT = /^(?:unit|units|unit of work|work|item|items|month|months|year|years|week|weeks|day|days|hour|hours|minute|minutes|word|words|seat|seats|user|users|person|head|time|use)$/i;

/**
 * What a price fact's sentence says these buyers pay for — the object of the
 * payment ("a dental practice pays $220 per compliance report" → "compliance
 * report") — or null when the sentence names none. Pure.
 *
 * Production 2026-11-24 (goal wst_7b4fcbb5f2384f31b6c3, independent audit of
 * the plan read): the whole of a fact's `measures` was read as the need, and a
 * back-filled fact's `measures` is the back-fill's framing plus the claim's
 * words ("what this buyer pays per unit of work, as published: The
 * NameExperts blog page 'domain-name-…'"). So the plan said Offer "what this
 * buyer pays per unit of work as published The NameExperts blog page
 * 'domain-name-", Brain produces "business document for …" that, and a buyer
 * label became "domain buyer or seller — what this buyer pays per unit of
 * wo…". A description of the evidence is not an offer: only the object of a
 * stated payment is read, and a sentence that names none leaves the need
 * unknown — "(not yet specified)", asked by the design's question — rather
 * than spliced in.
 */
export function paidForUnit(measures: string | null | undefined): string | null {
  let text = (measures ?? '').trim();
  for (const framing of FACT_FRAMINGS) text = text.replace(framing, '');
  text = text.replace(MONEY_FIGURE, ' ').replace(/\s+/g, ' ');
  const match = PAID_OBJECT.exec(text);
  if (!match) return null;
  const object = clean(match[1]!.replace(OBJECT_END, '').replace(/['‘’]+/g, ' ')).replace(/^(?:the|an?|each|every|one)\s+/i, '').trim();
  if (object.length < 3 || SOURCE_WORDS.test(object) || RATE_UNIT.test(object) || /\d/.test(object)) return null;
  return object;
}

/** One forward or transfer arrangement the parts support, before it is composed. */
export interface Candidate {
  design: Design;
  transfer: CashOpportunity | null;
  sector: string | null;
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  related: CashOpportunity[];
  /** Enumeration order: the last tiebreak, so ranking is total and stable. */
  order: number;
}

/** At most this many candidates are held for ranking; the rest are counted as considered and cut. */
export const MAX_CANDIDATES = 50_000;

/**
 * Visit every forward and transfer candidate a job's parts support, in
 * enumeration order, and return how many there are. Cheap: nothing is
 * composed, so the main thread can count what a pass will cut.
 */
export function forEachCandidate(job: ConstructionJob, visit: (one: Candidate) => void): number {
  const { opportunities, capability } = job;
  const precedentByBase = new Map(job.precedent);
  const paidFor = new Map(job.paidFor ?? []);
  const relatedByPayer = new Map<string, CashOpportunity[]>();
  const relatedTo = (name: string): CashOpportunity[] => {
    const k = norm(name);
    if (!relatedByPayer.has(k)) relatedByPayer.set(k, opportunities.filter((one) => norm(one.payer) === k));
    return relatedByPayer.get(k)!;
  };
  const physical = new Map<string, boolean>();
  const breaks = (need: Primitive): boolean => {
    if (!physical.has(need.name)) physical.set(need.name, breaksOperatingModel(operatingFit({ title: need.name })));
    return physical.get(need.name)!;
  };
  let order = 0;
  for (const design of allDesigns(STRUCTURE_KEYS)) {
    const def = STRUCTURES[design.base];
    if (def.needsDeliverable && !capability) continue;
    for (const s of job.sectors) {
      for (const demand of s.demand) {
        const related = relatedTo(demand.name);
        const heldStructures = new Set(related.map((one) => one.mechanism as string));
        // An existing opening sold the way it already is, is not a new mechanism;
        // the same structure with a different funding, pooling or repeat design is.
        if (isDefaultDesign(design) && def.alreadyHeldAs.some((one) => heldStructures.has(one))) continue;
        const precedent = precedentByBase.get(design.base);
        const transfer = precedent && norm(precedent.payer) !== norm(demand.name) ? precedent : null;
        /*
         * A sector that names no need still has evidence of what these buyers
         * pay for when it was filed elsewhere — an opening in another
         * industry, a price fact against their map node — and the design
         * takes it, with its source, rather than "(not yet specified)". Only
         * when nothing names it does the need stay unknown (null), and then
         * it is asked (`compose`'s question) and ranks after a named one.
         */
        const sectorNeeds = s.needs.length > 0 ? s.needs : (paidFor.get(payerKey(demand.name)) ?? [null]);
        /*
         * A payer an opening named is evidence about that opening's need, not
         * every need its sector holds (audit 2026-11-23: the GitHub bug-bounty
         * payer was sold "what the published request asks for Software
         * Advice analyzed data from 4,415 field service management buyers",
         * an HVAC-software sentence from another opening in the sector). Its
         * own opening's need, or what it is shown paying for, or unknown.
         */
        const needs =
          demand.from === 'OPENING'
            ? (() => {
                const own = sectorNeeds.filter((one) => one !== null && one.from === 'OPENING' && one.ref === demand.ref);
                return own.length > 0 ? own : (paidFor.get(payerKey(demand.name)) ?? [null]);
              })()
            : sectorNeeds;
        for (const need of needs) {
          const supplies = def.needsSupply ? s.supply : [capability];
          // Brain produces only what it can make online; a physical need is brokered or subcontracted, never produced by the owner.
          if (!def.needsSupply && need && breaks(need)) continue;
          for (const supply of supplies) {
            visit({ design, transfer, sector: s.name, demand, need, supply, related, order });
            order += 1;
          }
        }
      }
    }
  }
  return order;
}

/**
 * Of `MAX_CONSTRUCTIONS`, the slots a pass keeps for rotation (P4): a window
 * over every candidate that is not evidenced, in a fixed order read from the
 * candidates alone, that moves one window an hour (`rotationWindow`). The
 * whole space is composed in about considered / ROTATION_SLOTS hours. 64 of
 * 400 keeps fresh composition near 64 designs a pass (the rest reuse the
 * library), against the ~400 a pass the CPU guard was written for (§102).
 *
 * The window is read from the pass's `now`, never from a row a read writes.
 * The library's "never composed" (#1105) moved on the re-read because the
 * first read had composed it (Deploy 44391060795); the goal's reading counter
 * (#1114) moved on every persisted reading, so the read that stored a plan
 * changed the next read's window, and stood still once the plan stopped
 * changing. An hour moves for neither: two reads in the same hour compose the
 * same window whatever either stored, and the rotation still advances when
 * the plan is stable. Across an hour the goal's leaders are held (`held`), so
 * a newly composed arrangement displaces the leader only by beating it.
 */
export const ROTATION_SLOTS = 64;

/** How long one rotation window stands (P4). */
export const ROTATION_WINDOW_MS = 3_600_000;

/** The rotation window a pass at `now` composes: whole hours since the epoch. Pure. */
export function rotationWindow(now: Date): number {
  return Math.floor(now.getTime() / ROTATION_WINDOW_MS);
}

/** Which candidates a pass composes, and why. */
export interface CandidateSelection {
  selected: Candidate[];
  /** Forward and transfer candidates the parts support. */
  considered: number;
  /** Composed because the goal's current or previous plan led with them. */
  held: number;
  /** Composed because they hold observed or verified evidence, or a research confirmation. */
  evidenced: number;
  /** Evidenced but beyond the evidenced share of the cap (`MAX_CONSTRUCTIONS - ROTATION_SLOTS`). */
  evidencedCut: number;
  /** Composed in this pass's rotation window. */
  rotated: number;
  /** Candidates the library had never composed before this pass (reported, never read by the selection's rotation). */
  neverComposed: number;
}

/**
 * The candidates a pass composes: deterministic and evidence-first (P4,
 * 2026-11-18), then cut at `MAX_CONSTRUCTIONS` (K-2).
 *
 * Production (goal wst_7b4fcbb5f2384f31b6c3, 11-17 to 11-18): 400 of ~16,000
 * candidates composed a pass, the plan's leader swapped among seven
 * arrangements over 38 readings, and a five-week-old arrangement led the
 * moment it was first weighed — the plan followed which 400 were composed, not
 * what the evidence said. Arrangements on accepted research facts were not
 * guaranteed a slot. So:
 *
 *  - ROTATION — `ROTATION_SLOTS` candidates are this pass's window: every
 *    candidate that is not evidenced, in a fixed order read from the
 *    candidates alone (target properties, precedent, gated parts, published
 *    prices, original design, fewer parts, enumeration order) and interleaved
 *    by buyer population, cut into windows, the window `job.rotation` (the
 *    pass's hour) mod their number. Nothing a read writes moves it, so a
 *    re-read with unchanged inputs composes the same window, and every
 *    candidate is reached within one cycle of windows.
 *  - The other slots, in order, from the candidates outside the window:
 *    1. HELD — what the goal's last two readings picked or led with
 *       (`ConstructionJob.held`): a leader is never cut between two passes
 *       that learned nothing new.
 *    2. EVIDENCED — buyers carrying an OBSERVED or VERIFIED construction fact
 *       (price, unit or run cost, volume, win rate, buyer count), a published
 *       price or money tied up on a held opening, or research CONFIRMED.
 *    3. RANKED — the existing rank: CONFIRMED before unasked before REFUTED;
 *       more target properties; a precedent; more gated parts; more published
 *       prices from this buyer; the original design; fewer parts;
 *       enumeration order. Never a weighted score, never an id, and never
 *       the value the library stored for a composition, which every read
 *       writes (`libraryFor`).
 *    Steps 2 and 3 are dealt one buyer population at a time over the whole
 *    ranked list, a candidate already taken keeping its place in its lane, so
 *    taking a leader first never changes which others the deal reaches.
 */
export function selectCandidates(job: ConstructionJob): CandidateSelection {
  const all: Candidate[] = [];
  const considered = forEachCandidate(job, (one) => {
    if (all.length < MAX_CANDIDATES) all.push(one);
  });
  const known = new Map(job.known ?? []);
  const held = new Set(job.held ?? []);
  // Every buyer population an observation is about: research's construction facts and the openings' own prices and money tied up.
  const evidencedPayers = new Set<string>();
  const facts = job.facts;
  for (const one of [...job.priced, ...job.tiedUp, ...(facts ? [...facts.unitCost, ...facts.volume, ...(facts.conversion ?? []), ...(facts.buyers ?? []), ...(facts.runCost ?? []), ...(facts.commission ?? [])] : [])]) {
    const payer = payerKey(String(one.context['payer'] ?? ''));
    if (payer) evidencedPayers.add(payer);
  }
  const pricedByPayer = new Map<string, number>();
  for (const one of job.priced) {
    const payer = payerKey(String(one.context['payer'] ?? ''));
    pricedByPayer.set(payer, (pricedByPayer.get(payer) ?? 0) + 1);
  }
  const metByDesign = new Map<string, number>();
  const partsByDesign = new Map<string, number>();
  const keyed = all.map((one) => {
    const dk = designKey(one.design);
    if (!metByDesign.has(dk)) {
      metByDesign.set(dk, propertiesOf(one.design).filter((p) => job.targets.includes(p)).length);
      partsByDesign.set(dk, designParts(one.design).length);
    }
    const signature = arrangementSignature(one.design, one.demand, one.need, one.supply);
    const stored = known.get(signature);
    return {
      one,
      signature,
      stored,
      evidence: stored?.verdict === 'CONFIRMED' || evidencedPayers.has(payerKey(one.demand.name)),
      verdict: stored?.verdict === 'CONFIRMED' ? 0 : stored?.verdict === 'REFUTED' ? 2 : 1,
      met: metByDesign.get(dk)!,
      precedent: one.transfer ? 1 : 0,
      evidenced: [one.demand, one.need, one.supply].filter((p) => p?.claimId).length,
      priced: pricedByPayer.get(payerKey(one.demand.name)) ?? 0,
      variant: isDefaultDesign(one.design) ? 0 : 1,
      parts: partsByDesign.get(dk)!,
    };
  });
  type Keyed = (typeof keyed)[number];
  const neverComposed = keyed.filter((one) => !one.stored).length;
  if (all.length <= MAX_CONSTRUCTIONS) {
    return { selected: all, considered, held: keyed.filter((one) => held.has(one.signature)).length, evidenced: keyed.filter((one) => one.evidence).length, evidencedCut: 0, rotated: 0, neverComposed };
  }
  // The rotation window: a fixed order over what the candidates carry themselves, and a window the pass's hour picks.
  const fixed = (a: Keyed, b: Keyed): number =>
    b.met - a.met || b.precedent - a.precedent || b.evidenced - a.evidenced || b.priced - a.priced || a.variant - b.variant || a.parts - b.parts || a.one.order - b.one.order;
  // Interleaved by buyer population, so each window keeps the cap's breadth.
  const turningLanes = new Map<string, Keyed[]>();
  for (const one of keyed.filter((k) => !k.evidence).sort(fixed)) {
    const k = `${norm(one.one.sector)}|${partPath(one.one.demand)}`;
    const lane = turningLanes.get(k);
    if (lane) lane.push(one);
    else turningLanes.set(k, [one]);
  }
  const turning: Keyed[] = [];
  const turningQueues = [...turningLanes.values()];
  for (let depth = 0; turningQueues.some((lane) => lane.length > depth); depth += 1) for (const lane of turningQueues) if (lane[depth]) turning.push(lane[depth]!);
  const windows = Math.max(1, Math.ceil(turning.length / ROTATION_SLOTS));
  const at = ((Math.max(0, Math.floor(job.rotation ?? 0)) % windows) * ROTATION_SLOTS);
  const window = new Set(turning.slice(at, at + ROTATION_SLOTS));
  keyed.sort(
    (a, b) =>
      a.verdict - b.verdict ||
      b.met - a.met ||
      b.precedent - a.precedent ||
      b.evidenced - a.evidenced ||
      b.priced - a.priced ||
      a.variant - b.variant ||
      a.parts - b.parts ||
      a.one.order - b.one.order,
  );
  const taken = new Set<Keyed>();
  const dealt: Candidate[] = [];
  const take = (one: Keyed): void => {
    taken.add(one);
    dealt.push(one.one);
  };
  const budget = MAX_CONSTRUCTIONS - window.size;
  /*
   * One buyer population at a time, so the cap keeps breadth (production,
   * 2026-11-02: one sector filled the list). A candidate already taken keeps
   * its place in its lane and is passed over, so a leader taken first leaves
   * the deal reaching exactly the candidates it reached without it.
   */
  const deal = (from: readonly Keyed[], upTo: number): void => {
    const lanes = new Map<string, Keyed[]>();
    for (const one of from) {
      const k = `${norm(one.one.sector)}|${partPath(one.one.demand)}`;
      const lane = lanes.get(k);
      if (lane) lane.push(one);
      else lanes.set(k, [one]);
    }
    const queues = [...lanes.values()];
    for (let depth = 0; dealt.length < upTo && queues.some((lane) => lane.length > depth); depth += 1) {
      for (const lane of queues) {
        if (dealt.length >= upTo) break;
        const one = lane[depth];
        if (one && !taken.has(one)) take(one);
      }
    }
  };
  const outside = keyed.filter((one) => !window.has(one));
  // 1. The goal's leaders, whatever else ranks above them (a leader in this pass's window is composed there).
  for (const one of outside) if (held.has(one.signature) && dealt.length < budget) take(one);
  const heldCount = dealt.length + keyed.filter((one) => held.has(one.signature) && window.has(one)).length;
  // 2. Evidence first.
  deal(outside.filter((one) => one.evidence), budget);
  // 3. The existing rank.
  deal(outside, budget);
  // 4. This pass's window.
  for (const one of keyed) if (window.has(one)) take(one);
  return {
    selected: dealt,
    considered,
    held: heldCount,
    // Every evidenced candidate composed, and every one left out.
    evidenced: keyed.filter((one) => one.evidence && taken.has(one)).length,
    evidencedCut: keyed.filter((one) => one.evidence && !taken.has(one)).length,
    rotated: window.size,
    neverComposed,
  };
}

/**
 * Compose, stress and rank every arrangement a job's parts support, up to the
 * cap, best-ranked first. Pure: the same job gives the same arrangements on
 * any thread. `yieldEveryMs` hands the loop back between designs when it runs
 * on the server's own thread.
 */
export async function composeConstruction(job: ConstructionJob, yieldEveryMs: number | null = null, plan: CompositionStep[] = compositionPlan(job)): Promise<ConstructedArrangement[]> {
  const { capability, priced, tiedUp, facts, input, limits, targets, exclusions, now } = job;
  const designs = allDesigns(STRUCTURE_KEYS);
  const contractLimits = job.contractLimits ?? [];
  const ctx = { priced, tiedUp, facts, leverEvidence: job.leverEvidence ?? emptyLeverEvidence(), contractLimits, input, limits, targets, exclusions, now };
  const out: ConstructedArrangement[] = [];
  // Each freshly composed arrangement's levered form (S-0103), for the leverage trace on the best-ranked.
  const levered = new Map<ConstructedArrangement, Arrangement>();
  const keep = (built: { arrangement: ConstructedArrangement; levered: Arrangement }) => {
    levered.set(built.arrangement, built.levered);
    return built.arrangement;
  };
  // A library arrangement is reused untraced; its step is kept so it is recomposed if it ranks among the traced.
  const reusedFrom = new Map<ConstructedArrangement, CompositionStep>();
  let lastYield = Date.now();
  const breathe = async (): Promise<void> => {
    if (yieldEveryMs === null || Date.now() - lastYield < yieldEveryMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastYield = Date.now();
  };
  const composeStep = ({ one, under }: CompositionStep): ConstructedArrangement => {
    const made = keep(compose({ ...ctx, design: one.design, origin: one.transfer ? 'TRANSFER' : 'FORWARD', precedent: one.transfer, sector: one.sector, demand: one.demand, need: one.need, supply: one.supply, related: one.related }));
    made.composedUnder = under;
    return made;
  };
  for (const step of plan) {
    if (step.stored) {
      out.push(step.stored);
      reusedFrom.set(step.stored, step);
      continue;
    }
    await breathe();
    out.push(composeStep(step));
  }
  out.push(...reverseArrangements({ ...ctx, designs, capability }).map(keep));
  const ranked = rank(out, limits, targets);
  /*
   * A reused arrangement carries no levered form (the library stores the
   * arrangement, not its lever graph), so one that ranks among the traced is
   * recomposed under the same digest: the same arrangement, now traceable.
   */
  for (let i = 0; i < Math.min(LEVERAGE_TRACED, ranked.length); i += 1) {
    const step = reusedFrom.get(ranked[i]!);
    if (!step) continue;
    await breathe();
    ranked[i] = composeStep(step);
  }
  return traceLeverageOnTop(ranked, levered, job.constraints ?? {}, contractLimits, limits, targets, now, breathe);
}

/**
 * Trace the leverage of the best-ranked arrangements and enforce what it
 * finds (S-0103): an arrangement whose evidenced cash exposure a real limit
 * cannot fit even once is EXCEEDS — the goal's plan rejects it rather than
 * asking about it — and what the trace could not establish (prepayment
 * willingness, refund obligations, when funds are usable against when the
 * supplier is paid) is asked in its research question. Re-ranked after, so a
 * refused arrangement falls below the ones that fit.
 */
async function traceLeverageOnTop(
  ranked: ConstructedArrangement[],
  levered: Map<ConstructedArrangement, Arrangement>,
  constraints: LeverageConstraints,
  contractLimits: ContractLimits,
  limits: GoalLimits,
  targets: EconomicProperty[],
  now: Date,
  breathe: () => Promise<void>,
): Promise<ConstructedArrangement[]> {
  let changed = false;
  for (const one of ranked.slice(0, LEVERAGE_TRACED)) {
    const a = levered.get(one);
    if (!a) continue;
    await breathe();
    let leverage: ArrangementLeverage;
    const bound = constraintsFor(constraints, contractLimits, one.demand.name);
    // The same levered arrangement judged against the same limits on the same day traces the same: a re-read reuses it (~0.65 s a trace).
    const traceKey = digestOf(['trace/v2', a, bound, now.toISOString().slice(0, 10)]);
    const held = traceMemo.get(traceKey);
    if (held && Date.now() - held.at < CONSTRUCTION_MEMO_MS) {
      leverage = structuredClone(held.leverage);
    } else {
      try {
        leverage = await leverageOfYielding(a, bound, breathe, { now });
      } catch {
        continue;
      }
      traceMemo.set(traceKey, { at: Date.now(), leverage: structuredClone(leverage) });
      while (traceMemo.size > TRACE_MEMO_MAX) traceMemo.delete(traceMemo.keys().next().value!);
    }
    one.leverage = leverage;
    if (leverage.refused && one.stress.exposure !== 'EXCEEDS') {
      one.stress = { ...one.stress, exposure: 'EXCEEDS' };
      changed = true;
    }
    if (leverage.constraints.contractMax === null) {
      // The question that answers the CONTRACT task: what its answer files is what `contractLimitsFrom` reads.
      one.question += ` ${CONTRACT_LIMIT_ASK}`;
    }
    const verify = leverage.prepayment.flatMap((v) => v.tasks);
    if (verify.length) {
      one.question +=
        ' Prepayment is a design possibility here, not a presumption: ' +
        verify.join('; ') +
        ' — report what a source shows for these buyers, and say plainly where none does.';
    }
  }
  return changed ? rank(ranked, limits, targets) : ranked;
}

/**
 * The commercial levers a constructed arrangement may combine (S-0103): every
 * one of the seven a candidate "may simultaneously use", composed together on
 * every design, so the trace compares each combination — AI labor beside a
 * supplier, an existing channel, marketing reach, financing, shared
 * infrastructure and, where the design takes money early, prepayment —
 * against the same combination without it.
 *
 * None is a category and none is assumed to help: each lever's parts are
 * bounds, a question rather than a reading (invariant 39), so a lever moves a
 * traced dimension only once evidence states its parts. Supplier fulfilment
 * is composed only where a supplier fulfils, because a design Brain fulfils
 * itself has no supplier to pay; prepayment only where the design's funding
 * takes money before delivery. AI labor is composed on every design: Brain's
 * own work — selling, coordinating, and producing where it fulfils — is AI
 * labor whoever else delivers.
 */
export function designLevers(
  design: Design,
  fulfiller: 'BRAIN' | 'SUPPLIER',
  evidence: (part: LeverPart) => Pick<Part, 'context' | 'material' | 'observations'> = () => ({}),
): Levers {
  const share: Part = { min: 0, max: 1 };
  const count = (min: number, max: number): Part => ({ min, max });
  const money: Part = { min: 0, max: 100_000 };
  // A part the rows can speak to: its bounds, plus whatever they state.
  const read = (part: LeverPart, bounds: Part): Part => ({ ...bounds, ...evidence(part) });
  const levers: Levers = {
    settlementDays: read('settlementDays', count(0, 365)),
    aiLabor: { costPerTransaction: read('aiLabor.costPerTransaction', money), throughput: read('aiLabor.throughput', count(0, 10_000_000)) },
    channel: { share, fee: money },
    marketing: { reachUplift: count(0, 10), acquisitionCost: money, daysToAcquire: count(1, 365) },
    financing: { rate: share, termDays: count(0, 365), advanceShare: share },
    sharedInfrastructure: { costPerTransaction: money },
  };
  if (fulfiller === 'SUPPLIER') {
    levers.fulfilment = {
      capacity: read('fulfilment.capacity', count(0, 10_000_000)),
      failureRate: read('fulfilment.failureRate', share),
      paymentDays: read('fulfilment.paymentDays', count(0, 365)),
    };
  }
  if (design.funding !== 'ON_DELIVERY') {
    levers.prepayment = {
      willingness: read('prepayment.willingness', share),
      refundShare: read('prepayment.refundShare', share),
      usableDays: read('prepayment.usableDays', count(0, 365)),
    };
  }
  return levers;
}

/**
 * What the rows state about each lever part, for one buyer population: the
 * part's population is the payer, so that payer's own observations are
 * direct and every other payer's are broad — bounds, never a probability.
 */
export function leverPartsFor(evidence: LeverEvidence, payer: string): (part: LeverPart) => Pick<Part, 'context' | 'material' | 'observations'> {
  const who = norm(payer);
  return (part) => ({
    context: { payer: who },
    material: [],
    observations: evidence[part].map((one) => ({ ...one, broad: one.context['payer'] !== who })),
  });
}

// ── a contract's transaction limit ──────────────────────────────────────────

/**
 * One payer's contract limit as the rows state it: the most binding maximum
 * number of transactions any of its terms allows over the goal's period, with
 * where it was read. Plain data, so it crosses the evaluator pool's thread.
 */
export interface ContractLimit {
  /** Normalised payer name. */
  payer: string;
  /** Transactions allowed over the period. */
  max: number;
  /** The row it was read from: `opportunity:<id>:<field>` or `fact:<id>`. */
  ref: string;
  /** The claim behind it, when a fact carried one. */
  claimId: string | null;
  /** The sentence the limit was read from, for a reader to check. */
  text: string;
  observedAt: string | null;
}

export type ContractLimits = ContractLimit[];

/** What a constructed arrangement's research question asks so that the CONTRACT limit becomes readable. */
export const CONTRACT_LIMIT_ASK =
  'State the most transactions (orders, jobs, units, loads, bookings) the buyer’s contract, framework agreement, tender award or published terms allow in the period — "up to N", "no more than N", "a maximum of N" — with its source, or say plainly that no source states one.';

// The fields of an opening that are terms: a maximum stated in them is a contract's.
const TERMS_FIELDS = ['paymentTerms', 'acceptanceCondition', 'offerScope'] as const;
// Elsewhere a maximum is a contract's only when the sentence says it is.
const OTHER_FIELDS = ['requiredInputs', 'economicsNote', 'buyingSignal'] as const;
const CONTRACT_WORD = /\b(?:contract(?:s|ed|ual)?|agreements?|framework|purchase orders?|PO|tender|award(?:ed)?|allocation|allotment|quota|terms|licen[cs]e[sd]?|permit(?:s|ted)?|allow(?:s|ed)?|caps?|capped)\b/i;
const CAP = /\b(?:up to|no more than|not more than|not to exceed|maximum(?: of)?|max\.?|at most|capped at|a cap of|cap of|limited to|limit(?:ed)? of)\s+(\d[\d,]*)\s+(?:[a-z-]+\s+){0,2}?(orders?|jobs?|units?|transactions?|bookings?|deliveries|delivery|loads?|shipments?|projects?|placements?|referrals?|leads?|sales?|contracts?|visits?|cases?|appointments?|tickets?|seats?|licen[cs]es?|pallets?|containers?|tons?|tonnes?|calls?|installs?|installations?|services?)\b(?:\s+(?:per|a|an|each|every)\s+(day|week|month|quarter|year))?/i;
const PERIOD_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };

function contractSentences(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|\n+/).map((one) => one.trim()).filter(Boolean);
}

/** The maximum a sentence states, over `periodDays`; null when it states none. */
export function statedContractMax(sentence: string, periodDays: number, needsContractWord: boolean): number | null {
  if (needsContractWord && !CONTRACT_WORD.test(sentence)) return null;
  const m = CAP.exec(sentence);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const per = m[3] ? PERIOD_DAYS[m[3].toLowerCase()] : undefined;
  // A rate cap ("up to 40 jobs a month") allows that rate over the period; a bare count is the whole allowance.
  return per ? Math.floor((n * Math.max(1, periodDays)) / per) : n;
}

/**
 * Every payer's contract limit, from the openings' own terms and the evidence
 * facts filed on them. The smallest stated maximum binds: two terms that both
 * apply allow only what both allow. A payer whose rows state no maximum is
 * absent, and its CONTRACT limit stays unknown.
 */
export function contractLimitsFrom(input: { opportunities: readonly CashOpportunity[]; facts: readonly CashCardFact[]; periodDays: number }): ContractLimits {
  const byPayer = new Map<string, ContractLimit>();
  const byId = new Map(input.opportunities.map((one) => [one.id, one]));
  const offer = (payer: string | null, text: string | null, ref: string, claimId: string | null, observedAt: string | null, needsContractWord: boolean) => {
    const who = norm(payer);
    if (!who || !text) return;
    for (const sentence of contractSentences(text)) {
      const max = statedContractMax(sentence, input.periodDays, needsContractWord);
      if (max === null) continue;
      const held = byPayer.get(who);
      if (!held || max < held.max) byPayer.set(who, { payer: who, max, ref, claimId, text: sentence.slice(0, 300), observedAt });
    }
  };
  for (const one of input.opportunities) {
    if (one.duplicateOfId) continue;
    for (const field of TERMS_FIELDS) offer(one.payer, one[field], `opportunity:${one.id}:${field}`, one.sourceClaimId, one.updatedAt, false);
    for (const field of OTHER_FIELDS) offer(one.payer, one[field], `opportunity:${one.id}:${field}`, one.sourceClaimId, one.updatedAt, true);
  }
  for (const fact of input.facts) {
    if (fact.kind !== 'EVIDENCE') continue;
    const one = byId.get(fact.opportunityId);
    if (!one || one.duplicateOfId) continue;
    offer(one.payer, fact.value, `fact:${fact.id}`, fact.claimId, fact.createdAt, !(TERMS_FIELDS as readonly string[]).includes(fact.field));
  }
  return [...byPayer.values()].sort((a, b) => a.payer.localeCompare(b.payer));
}

/** The stated contract limit for one payer, or null when its rows state none. */
export function contractLimitFor(limits: ContractLimits, payer: string | null | undefined): ContractLimit | null {
  const who = norm(payer);
  return (who && limits.find((one) => one.payer === who)) || null;
}

/**
 * The limit as a graph part: a stated maximum is one figure from a row, read
 * with the reading error every published figure carries — and, being a
 * maximum, it is also the part's hard upper bound.
 */
function contractPart(limit: ContractLimit): Part {
  return {
    min: 0,
    max: limit.max,
    context: { payer: limit.payer },
    material: [],
    observations: [
      {
        id: `${limit.ref}:contract_max`,
        value: { kind: 'POINT', value: limit.max, exact: true },
        context: { payer: limit.payer },
        lineage: [limit.ref],
        source: limit.claimId ? { kind: 'CLAIM', ref: limit.claimId } : { kind: 'CARD_FACT', ref: limit.ref },
        observedAt: limit.observedAt,
        measures: `the maximum transactions stated: "${limit.text}"`,
      },
    ],
  };
}

/** The project's real limits, with this arrangement's payer's contract limit when its rows state one. */
export function constraintsFor(base: LeverageConstraints, limits: ContractLimits, payer: string | null | undefined): LeverageConstraints {
  return { ...base, contractMax: contractLimitFor(limits, payer)?.max ?? base.contractMax ?? null };
}

/**
 * The composer's version, in every composition digest. 2: a FEE design's value
 * is reconstructed from its own buyers' prices (it was left UNKNOWN), and own
 * buyers are matched by `payerKey`. 3: the capability part Brain produces is
 * named by the deliverable these buyers pay for (`fittedDeliverable`), so a
 * stored arrangement still carrying the whole list is recomposed.
 */
export const COMPOSITION_VERSION = 3;

/** One selected candidate, the digest of everything its composition reads, and the library's arrangement composed under it. */
export interface CompositionStep {
  one: Candidate;
  under: string;
  stored: ConstructedArrangement | undefined;
}

/** The candidates a pass composes, each with its composition digest and what the library already composed under it. Pure. */
export function compositionPlan(job: ConstructionJob, selection: CandidateSelection = selectCandidates(job)): CompositionStep[] {
  const { priced, tiedUp, input, limits, targets, exclusions, now } = job;
  const reuse = new Map(job.reuse ?? []);
  // Everything a composition reads besides its own parts, once per pass. Fact observations only when
  // there are any, so a digest stored before they existed is still the same composition's.
  const facts = job.facts && (job.facts.unitCost.length > 0 || job.facts.volume.length > 0 || (job.facts.conversion?.length ?? 0) > 0 || (job.facts.buyers?.length ?? 0) > 0 || (job.facts.runCost?.length ?? 0) > 0 || (job.facts.commission?.length ?? 0) > 0) ? job.facts : undefined;
  // The lever evidence and contract limits a composition reads (S-0103), likewise only when the rows state any.
  const leverEvidence = job.leverEvidence && Object.values(job.leverEvidence).some((one) => one.length > 0) ? job.leverEvidence : undefined;
  const contractLimits = job.contractLimits && job.contractLimits.length > 0 ? job.contractLimits : undefined;
  // `composition` names the composer's own version: a stored arrangement composed by an earlier one is recomposed, not reused.
  const context = digestOf({ composition: COMPOSITION_VERSION, day: now.toISOString().slice(0, 10), currency: input.currency, daysLeft: input.daysLeft, limits, targets, exclusions, priced, tiedUp, ...(facts ? { facts } : {}), ...(leverEvidence ? { leverEvidence } : {}), ...(contractLimits ? { contractLimits } : {}) });
  return selection.selected.map((one) => {
    const under = digestOf([context, designKey(one.design), one.transfer?.id ?? '-', one.sector ?? '-', one.demand, one.need, one.supply, one.related.map((o) => o.id)]);
    const stored = reuse.get(under);
    /*
     * A stored arrangement that was traced carries what its trace added — its
     * leverage, the questions it appended, an exposure a real limit refused —
     * all judged against that pass's ledger and authority. It is recomposed
     * rather than reused, so a trace is never read back as composition.
     */
    return { one, under, stored: stored && !stored.leverage ? stored : undefined };
  });
}

/**
 * Fresh compositions a pass may run on the server's own thread (yielding every
 * `YIELD_EVERY_MS`) rather than on the pool. A pass whose candidates the
 * library already holds composes only its few reverse designs — milliseconds —
 * and sending it to a thread costs the thread's boot and a copy of every stored
 * arrangement there and back. Production, 2026-11-15: "400 reused from the
 * library", and the construction phase still took 246 s on a 2-vCPU machine
 * whose niced pool thread was starved.
 */
export const INLINE_COMPOSITIONS = 24;

/** How long an unchanged construction is reused, and how many distinct ones are held. */
export const CONSTRUCTION_MEMO_MS = 30 * 60_000;
const CONSTRUCTION_MEMO_MAX = 8;
const constructionMemo = new Map<string, { at: number; result: ConstructedArrangement[] }>();
/** Leverage traces by levered arrangement, the limits it was judged against and the day (S-0103): the trace is pure in all three. */
const TRACE_MEMO_MAX = 256;
const traceMemo = new Map<string, { at: number; leverage: ArrangementLeverage }>();
/**
 * Drop every entry older than `ttlMs`: one is never served again (each read
 * checks the same age), and its key — day, hour's rotation, inputs — is rarely
 * asked twice, so without this a full memo was mostly dead constructions of
 * several megabytes each, held until eight newer keys displaced them.
 */
export function dropStale<V extends { at: number }>(memo: Map<string, V>, ttlMs: number, now = Date.now()): void {
  for (const [key, one] of memo) if (now - one.at >= ttlMs) memo.delete(key);
}

/** For tests: forget held constructions. */
export function clearConstructionMemo(): void {
  constructionMemo.clear();
  traceMemo.clear();
}

/**
 * Reverse construction: the designs that deliver most of what the goal needs,
 * with their buyers, need and supply left for the world to supply. These are
 * what keep a sparse map from defining the universe — a design that fits the
 * goal is worth asking about whether or not the map holds a buyer for it yet.
 */
function reverseArrangements(ctx: {
  designs: Design[];
  capability: Primitive | null;
  priced: Observation[];
  tiedUp: Observation[];
  facts?: FactObservations;
  leverEvidence: LeverEvidence;
  contractLimits?: ContractLimits;
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
}): Array<{ arrangement: ConstructedArrangement; levered: Arrangement }> {
  if (ctx.targets.length === 0) return [];
  const scored = ctx.designs
    .filter((d) => !STRUCTURES[d.base].needsDeliverable || ctx.capability)
    .map((d) => ({ d, met: propertiesOf(d).filter((p) => ctx.targets.includes(p)).length, extra: designParts(d).length }))
    .filter((one) => one.met > 0)
    .sort((a, b) => b.met - a.met || a.extra - b.extra || designKey(a.d).localeCompare(designKey(b.d)));
  // Structurally different, not the same design with one knob turned: one per base structure first.
  const picked: Design[] = [];
  const bases = new Set<Structure>();
  for (const one of scored) {
    if (picked.length >= MAX_REVERSE) break;
    if (bases.has(one.d.base)) continue;
    bases.add(one.d.base);
    picked.push(one.d);
  }
  return picked.map((design) => {
    const ref = `reverse:${designKey(design)}`;
    const demand: Primitive = { name: 'buyers to be found', claimId: null, from: 'REVERSE', ref };
    const supply = STRUCTURES[design.base].needsSupply ? null : ctx.capability;
    return compose({ ...ctx, design, origin: 'REVERSE', precedent: null, sector: null, demand, need: null, supply, related: [] });
  });
}

function rank(out: ConstructedArrangement[], limits: GoalLimits, targets: EconomicProperty[]): ConstructedArrangement[] {
  // Money exposure leads whenever the goal cannot carry a loss: no capital allowed, or a pre-income limit it binds.
  const tight = (limits.capitalCeilingCents ?? 0) <= 0 || targets.includes('NO_CAPITAL_AT_RISK');
  const exposure = (one: ConstructedArrangement) => {
    const at = EXPOSURE_ORDER.indexOf(one.stress.exposure);
    return tight ? at : one.stress.exposure === 'EXCEEDS' ? 1 : 0;
  };
  const sorted = out.sort(
    (a, b) =>
      // Cannot lose money the goal does not have.
      exposure(a) - exposure(b) ||
      // Delivers more of what the goal's limits need.
      b.targetsMet.length - a.targetsMet.length ||
      // Rests on a design a held opening shows working.
      Number(!!b.precedent) - Number(!!a.precedent) ||
      // More of it rests on gated claims.
      b.evidenced - a.evidenced ||
      // These buyers already came back for more (aftercare evidence).
      (b.repeatBusiness?.observations ?? 0) - (a.repeatBusiness?.observations ?? 0) ||
      // What Brain would produce is named. An unspecified deliverable's value is read from whatever else
      // these buyers paid for, so it never outranks a named one on that value (invariant 39).
      Number(unspecifiedDeliverable(a)) - Number(unspecifiedDeliverable(b)) ||
      // Its value is better established.
      TIER_ORDER.indexOf(a.value.tier) - TIER_ORDER.indexOf(b.value.tier) ||
      // Fewer parts left to establish.
      a.unknownParts.length - b.unknownParts.length ||
      a.key.localeCompare(b.key),
  );
  return interleaveByPopulation(sorted, exposure);
}

/**
 * The ranking, dealt one buyer population at a time.
 *
 * Production, 2026-11-02: 262 arrangements, and the top of the list was one
 * sector's buyers ("production committee investor companies…") in every
 * design × need × supply combination it held, because a sector with many map
 * nodes multiplies and nothing in the sort penalises a repeat. The owner asked
 * for discovery not to be confined to one buyer group. Within each exposure
 * class (a safer arrangement never yields to a riskier one), the best of each
 * sector comes first, then each sector's second, and so on — the order inside
 * a sector is the sort's.
 */
export function interleaveByPopulation(sorted: ConstructedArrangement[], exposure: (one: ConstructedArrangement) => number): ConstructedArrangement[] {
  const out: ConstructedArrangement[] = [];
  let i = 0;
  while (i < sorted.length) {
    const tier = exposure(sorted[i]!);
    let j = i;
    while (j < sorted.length && exposure(sorted[j]!) === tier) j += 1;
    const groups = new Map<string, ConstructedArrangement[]>();
    for (const one of sorted.slice(i, j)) {
      const k = one.sector !== null ? `s:${norm(one.sector)}` : `d:${one.demand.ref}`;
      groups.set(k, [...(groups.get(k) ?? []), one]);
    }
    const lanes = [...groups.values()];
    for (let depth = 0; lanes.some((lane) => lane.length > depth); depth += 1) {
      for (const lane of lanes) if (lane[depth]) out.push(lane[depth]!);
    }
    i = j;
  }
  return out;
}

/** The lineage of the observations a value was reconstructed from: the claim a fact or a price was filed from. Pure. */
/** The value's drawn distribution, only where its evidence justifies one: never for bounds alone. Pure. */
export function valueEvidence(value: Estimate): { evidence?: NonNullable<ConstructedArrangement['value']['evidence']> } {
  const exported = toScenarioInput(value);
  if (exported.provenance !== 'EVIDENCE' || exported.spec.kind !== 'EMPIRICAL') return {};
  return { evidence: { values: exported.spec.values, low: value.p05, high: value.p95, ...inputSample(value) } };
}

/**
 * The price observations and the cost observations of one composition, with
 * every observation whose lineage (the claim, or the fact) appears on both
 * sides removed from both (GH2). One fact is never an arrangement's price and
 * its cost at once: a figure filed as both is ambiguous, so it is neither, and
 * what it would have said stays unestablished. Money tied up is not a cost and
 * is not compared: an opening's price and its peak funding share the opening's
 * claim by construction. Pure.
 */
export function withoutPriceCostOverlap<T extends Pick<Observation, 'lineage'>>(obs: { value: T[]; unitCost: T[]; runCost: T[] }): { value: T[]; unitCost: T[]; runCost: T[] } {
  const priced = new Set(obs.value.flatMap((one) => one.lineage));
  const costed = new Set([...obs.unitCost, ...obs.runCost].flatMap((one) => one.lineage));
  const both = new Set([...priced].filter((one) => costed.has(one)));
  if (both.size === 0) return obs;
  const clean = (one: T) => !one.lineage.some((l) => both.has(l));
  return { value: obs.value.filter(clean), unitCost: obs.unitCost.filter(clean), runCost: obs.runCost.filter(clean) };
}

/**
 * Why a value read from these buyers' published prices is no evidence of what
 * they pay under this design (GH2), or nothing. Every price the construction
 * reads — an opening's price, a `price_per_unit` fact, repeat business — is
 * what one payer paid for one unit it bought. A pooled design is paid
 * differently: many buyers each pay a share of one shared run. Who pays and
 * for what unit differ, so the figure locates the price and never evidences
 * it (production 2026-11-18: The Puzzle Society's "$500 for each accepted
 * puzzle", a publisher's fee per accepted submission, was the SINGLE_COMPARABLE
 * price of a pooled presale design). Pure.
 */
export function priceBasisOf(design: Pick<Design, 'aggregation'>, observations: number, perParticipant = false): { notEvidence?: string; perParticipant?: true } {
  // F4: a price each of these buyers' sources states per slot is a participant's share of a pooled run: the design's own unit.
  if (observations > 0 && perParticipant) return design.aggregation === 'POOLED_BUYERS' ? { perParticipant: true } : {};
  if (observations > 0 && design.aggregation === 'POOLED_BUYERS')
    return { notEvidence: "observed as one payer's price for a unit it bought, not a participant's share of a pooled run, so a different payment mechanism" };
  return {};
}

/** Whether every observation a value used is stated per participant (F4). Pure. */
function participantOnly(value: Estimate, observations: readonly Observation[]): boolean {
  const byId = new Map(observations.map((one) => [one.id, one]));
  return value.used.length > 0 && value.used.every((id) => byId.get(id)?.unit === 'PARTICIPANT_SHARE');
}

function valueSources(value: Estimate, observations: readonly Observation[]): string[] {
  const byId = new Map(observations.map((one) => [one.id, one]));
  return [...new Set(value.used.flatMap((id) => byId.get(id)?.lineage ?? [id]))].sort();
}

/**
 * How a timing's basis names the opening it was read from: by its title, never
 * its id. The basis reaches a person verbatim in an arrangement's steps
 * ("stated to pay in arrears (opening … is won by competitive award)"), and an
 * id there is NO_INTERNAL_KEYS (production goal wst_7b4fcbb5f2384f31b6c3,
 * release check 44986740566).
 */
function openingBasis(o: Pick<CashOpportunity, 'title'>): string {
  const title = o.title.trim();
  return `opening "${title.length > 60 ? `${title.slice(0, 59)}…` : title}"`;
}

/** An opening's stated timing as a part's `terms`, or nothing when it states none. */
function termsOfOpening(o: CashOpportunity): { terms?: PaymentTimingReading } {
  const terms = openingTiming(o, openingBasis(o));
  return terms.timing === 'UNKNOWN' ? {} : { terms };
}
function termsOfGroup(group: readonly CashOpportunity[]): { terms?: PaymentTimingReading } {
  const terms = combineTimings(group.map((o) => openingTiming(o, openingBasis(o))));
  return terms.timing === 'UNKNOWN' ? {} : { terms };
}

/**
 * When an arrangement's buyers pay, inherited from what its evidence states
 * (production 2026-11-15): the buyer part's own source, and every held
 * opening sold to the same buyer. The need part's source is not read: it may
 * describe what a different buyer pays for, and its terms are that buyer's. ARREARS if any says so; PREPAID
 * only if one does and none says otherwise; nothing when none states it. Pure.
 */
export function buyerTermsOf(demand: Primitive, related: readonly CashOpportunity[]): { buyerTerms?: PaymentTimingReading } {
  const readings = [demand.terms, ...related.map((o) => openingTiming(o, openingBasis(o)))].filter((one): one is PaymentTimingReading => !!one);
  const terms = combineTimings(readings);
  return terms.timing === 'UNKNOWN' ? {} : { buyerTerms: terms };
}

function compose(args: {
  design: Design;
  origin: ConstructionOrigin;
  precedent: CashOpportunity | null;
  sector: string | null;
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  related: CashOpportunity[];
  priced: Observation[];
  tiedUp: Observation[];
  facts?: FactObservations;
  /** What the rows state about each lever's own parts; absent reads as nothing stated. */
  leverEvidence?: LeverEvidence;
  contractLimits?: ContractLimits;
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
}): { arrangement: ConstructedArrangement; levered: Arrangement } {
  const { design, demand, need, input } = args;
  // Brain's capability is named by what these buyers pay for, never the deliverables list (identity unchanged).
  const supply = args.supply ? fittedDeliverable(args.supply, input.delivers, demand, need) : null;
  const structure = design.base;
  const def = STRUCTURES[structure];
  // The original arrangements keep their keys, and with them their round history.
  const key =
    args.origin === 'REVERSE'
      ? keyOf(['reverse', designKey(design)])
      : isDefaultDesign(design)
        ? keyOf([structure, demand.ref, need?.ref ?? '-', supply?.ref ?? '-'])
        : keyOf([designKey(design), demand.ref, need?.ref ?? '-', supply?.ref ?? '-']);
  const unknownCount = (min: number, max: number): Part => ({ min, max });
  const unknownShare: Part = { min: 0, max: 1 };
  const pooled = design.aggregation === 'POOLED_BUYERS';
  // What Brain holds about what *these* buyers pay: the same payer is comparable
  // evidence about another thing they buy. Any other payer's price is dropped,
  // never pooled (PRICE-POOL, production 2026-11-14: every constructed
  // arrangement read the identical project-wide "E 281", fulfil 0–43,661,
  // capital 0–72,769, because every held opening's price was handed to every
  // arrangement as a "broad" bound and the reconstruction pooled them). An
  // arrangement with no evidence from its own buyers has an UNKNOWN value, and
  // the library keeps it that way until research establishes one.
  // These buyers by the map's identity (`payerKey`): a construction fact filed against the node
  // "Dental practices" is evidence about an opening's payer "Dental practice", and nothing wider.
  const buyerKey = payerKey(demand.name);
  const ownBuyer = (one: Observation) => payerKey(String(one.context['payer'] ?? '')) === buyerKey;
  const pricedObs = args.priced.filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  const riskObs = args.tiedUp.filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  // What research observed supply is paid per unit for these buyers' work, and how much one of them buys (F2).
  const unitCostObsAll = (args.facts?.unitCost ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  // What supply charges for one whole run for these buyers (B1j): a pooled run's fixed cost, or a single-buyer deal's supply cost.
  const runCostObsAll = (args.facts?.runCost ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  /*
   * One fact never supplies both what these buyers pay and what serving them
   * costs (GH2, production 2026-11-18: The Puzzle Society's "$500 for each
   * accepted puzzle", clm_51df38793dfe46f6b16e, was filed as its price_per_unit
   * and as its contractor_rate_per_unit). A figure read as both is neither: it
   * is dropped from the price and from the cost, which then stay what nothing
   * else establishes.
   */
  const { value: valueObs, unitCost: unitCostObs, runCost: runCostObs } = withoutPriceCostOverlap({ value: pricedObs, unitCost: unitCostObsAll, runCost: runCostObsAll });
  const volumeObs = (args.facts?.volume ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  // What share of these buyers approached bought, and how many of them a stated market holds (R3): the demand side's conversion and buyers.
  const conversionObs = (args.facts?.conversion ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  const buyersObs = (args.facts?.buyers ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  // The share of these buyers' price an intermediary keeps: a BROKER's commission, a REFERRAL's fee as a share.
  const takes = design.base === 'BROKER' || design.base === 'REFERRAL';
  const commissionObs = takes ? (args.facts?.commission ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false })) : [];
  const context = { payer: norm(demand.name), industry: norm(args.sector), arrangement: key };
  const captureFor = (): Parameters<typeof composeArrangement>[0]['capture'] =>
    def.capture === 'COMMISSION'
      ? { kind: 'COMMISSION', rate: commissionObs.length > 0 ? { min: 0, max: 1, context, material: [], observations: commissionObs } : unknownShare }
      : def.capture === 'FEE'
        ? { kind: 'FEE', fee: { min: 0, max: 100_000 } }
        : { kind: 'MARGIN', supplyCost: { min: 0, max: 100_000, context, material: [], observations: pooled ? [] : [...riskObs, ...unitCostObs, ...runCostObs] } };
  const base: Arrangement = {
    key: 'a',
    label: demand.name,
    period: `${input.daysLeft} days`,
    currency: input.currency,
    demand: {
      /*
       * How many of these buyers exist is a fact about the population, not about
       * the arrangement sold to it: a count filed on the buyer's map node (a
       * census count, a research claim) is this population's own figure, never a
       * comparable from another arrangement (§121). With the arrangement in its
       * context the one count filed was read as a single comparable population
       * and never justified a distribution, so the plan kept sweeping buyers.
       */
      buyers: buyersObs.length > 0 ? { min: 0, max: 10_000_000, context: { payer: context.payer, industry: context.industry }, material: [], observations: buyersObs } : unknownCount(0, 10_000_000),
      needRate: volumeObs.length > 0 ? { min: 0, max: 400, context, material: [], observations: volumeObs } : unknownCount(0, 400),
      reach: unknownShare,
      conversion: conversionObs.length > 0 ? { min: 0, max: 1, context, material: [], observations: conversionObs } : unknownShare,
    },
    supply: def.needsSupply ? { units: unknownCount(0, 10_000_000), acceptance: unknownShare } : undefined,
    // The arrangement itself is new, so even the same payer's price is comparable rather than direct.
    value: { min: 0, max: 1_000_000, context, material: [], observations: valueObs },
    capture: captureFor(),
    cost: { min: 0, max: 100_000 },
    pooling: pooled ? { fixedCost: { min: 0, max: 1_000_000, context, material: [], observations: [...riskObs, ...runCostObs] }, minParticipants: unknownCount(1, 10_000), threshold: design.funding === 'THRESHOLD_PRESALE' } : undefined,
    funding: design.funding !== 'ON_DELIVERY' ? { prepayShare: unknownShare } : undefined,
    repeat: design.repeat !== 'ONE_OFF' ? { rate: unknownShare } : undefined,
  };
  const composed = composeArrangement(base);
  /*
   * The same arrangement with the levers its design uses (S-0103): the parts
   * and their evidence are construction's own — the value's published prices,
   * what supply is paid, a shared run's fixed cost — so the leverage trace
   * reads what construction established and nothing it did not. Each lever's
   * own parts start as bounds and take what the rows state about them: the
   * arrangement's own payer is direct evidence, any other payer only bounds,
   * as for published prices. What nothing states stays a question.
   */
  const facts = designFacts(design);
  /*
   * A lever part asks about these buyers — what share of them prepay, what
   * their refunds and settlement terms are — so its population is the payer,
   * not this new arrangement: the payer's own published terms are direct
   * evidence about it, and any other payer's are broad, bounds only.
   */
  const levers = designLevers(design, facts.fulfiller, leverPartsFor(args.leverEvidence ?? emptyLeverEvidence(), demand.name));
  // The payer's contract limit, when its rows state one, bounds delivery capacity in the graph itself.
  const contract = contractLimitFor(args.contractLimits ?? [], demand.name);
  if (contract) levers.limits = { ...levers.limits, contractMax: contractPart(contract) };
  const levered: Arrangement = { ...base, levers };
  let estimates: Record<string, Estimate> = {};
  try {
    estimates = reconstruct(composed.graph, composed.contribution, args.now).estimates;
    if (composed.exposure) estimates = { ...reconstruct(composed.graph, composed.exposure, args.now).estimates, ...estimates };
    /*
     * What these buyers pay is read whether or not the contribution formula
     * passes through it. A FEE design (PRODUCE, REFERRAL) earns its fee, so
     * `a_value` is not on the contribution's path and `reconstruct` never
     * resolved it: production, 2026-11-15, held 43 OBSERVED prices filed
     * against buyer populations, and every PRODUCE arrangement for those very
     * buyers (360 of 404) still read value UNKNOWN, so the plan admitted 0.
     */
    for (const leaf of ['a_value', 'a_conversion', 'a_prepay_share', 'a_repeat_rate', 'a_fixed_cost']) {
      if (!estimates[leaf] && composed.graph.nodes.some((n) => n.key === leaf)) estimates = { ...estimates, ...reconstruct(composed.graph, leaf, args.now).estimates };
    }
  } catch {
    estimates = {};
  }
  const value = estimates['a_value'];
  const conversion = estimates['a_conversion'];
  const fixedCost = pooled ? estimates['a_fixed_cost'] : undefined;
  /*
   * A design that pays its supplier per deal reads that cost on the graph's
   * own `a_supply_cost` node, from the same observations the node carries
   * (riskObs, unitCostObs, runCostObs). Before this it reached only the stress
   * check, and the plan swept the cost blind from 0 to 60% of the price
   * (fresh plan reads, 2026-11-21: COST the dominant lever on three goals).
   */
  const supplyCostObs = [...riskObs, ...unitCostObs, ...runCostObs];
  const paysSupplyPerDeal = !pooled && !takes && def.capture === 'MARGIN';
  let supplyCost: Estimate | undefined = paysSupplyPerDeal ? estimates['a_supply_cost'] : undefined;
  if (!supplyCost && paysSupplyPerDeal && unitCostObs.length + runCostObs.length > 0) {
    try {
      const node = 'a_supply_cost';
      supplyCost = reconstruct({ nodes: [{ key: node, label: 'What supply is paid per transaction', unit: input.currency, kind: 'POSITIVE', min: 0, max: 100_000, context, material: [], observations: supplyCostObs }] }, node, args.now).estimates[node];
    } catch {
      supplyCost = undefined;
    }
  }
  /*
   * A REFERRAL's graph captures a fee, so the share its supplier pays is read
   * on its own node, from the same take rates a BROKER's commission reads.
   */
  let commission: Estimate | undefined = def.capture === 'COMMISSION' ? estimates['a_commission'] : undefined;
  if (!commission && takes && commissionObs.length > 0) {
    try {
      const node = 'a_take_share';
      commission = reconstruct({ nodes: [{ key: node, label: 'Share of the price an intermediary keeps', unit: 'share', kind: 'RATE', min: 0, max: 1, context, material: [], observations: commissionObs }] }, node, args.now).estimates[node];
    } catch {
      commission = undefined;
    }
  }
  const core = ['buyers', 'need_rate', 'conversion', 'value', def.capture === 'COMMISSION' ? 'commission' : def.capture === 'FEE' ? 'fee' : 'supply_cost', ...(def.needsSupply ? ['supply_units'] : []), 'cost'];
  const leaves = [...core, ...designParts(design).filter((part) => !core.includes(part))];
  const unknownParts = leaves.filter((leaf) => {
    const est = estimates[`a_${leaf}`];
    return !est || !est.distributionJustified;
  });
  // The worst case on what is known: a shared run's fixed cost, or what supply is paid per deal.
  const risk = pooled ? estimates['a_fixed_cost'] : def.capture === 'MARGIN' ? estimates['a_supply_cost'] : undefined;
  const limitCents = args.limits.capitalBeforeProofCents ?? args.limits.capitalCeilingCents;
  const stress = stressDesign(design, { atRiskCents: risk && risk.distributionJustified ? Math.round(risk.p90 * 100) : null, limitCents });
  const properties = propertiesOf(design);
  const targetsMet = properties.filter((p) => args.targets.includes(p));
  const emergent = properties.filter((p) => !args.targets.includes(p));
  const evidenced = [demand, need, supply].filter((one) => one?.claimId).length;
  const repeatObs = args.priced.filter((one) => one.context['arrangement'] === 'repeat' && ownBuyer(one));
  const repeatBusiness = {
    observations: repeatObs.length,
    statedValueCents: repeatObs.reduce((t, one) => t + (one.value.kind === 'POINT' ? Math.round(one.value.value * 100) : 0), 0),
  };
  const shape = describeDesign(design);
  // The need comes before the design description: the label is cut to 160
  // characters, and two needs of one buyer under one long design description
  // otherwise read as the same arrangement twice.
  const label = (args.origin === 'REVERSE'
    ? `Reverse: ${shape}`
    : `${demand.name}${need ? ` — ${need.name}` : ''}: ${shape}${supply && supply.from !== 'CAPABILITY' ? ` (${supply.name})` : ''}`).slice(0, 160);
  const established =
    value && value.distributionJustified
      ? ` What these buyers pay is already partly established (${input.currency} ${Math.round(value.p10)}–${Math.round(value.p90)} from ${value.used.length} published figure${value.used.length === 1 ? '' : 's'}), so confirm it rather than start over.`
      : '';
  const asks = unknownParts.map((part) => PART_ASK[part]).filter(Boolean).join('; ');
  const relies = properties
    .filter((p) => PROPERTIES[p].needs.length > 0)
    .map((p) => `${PROPERTIES[p].label} (${PROPERTIES[p].why})`);
  const reliesText = relies.length
    ? ` Its economics rely on ${relies.join('; ')} — each of these is a hypothesis: report whether a source shows it holds for these buyers, and say so plainly where none does.`
    : '';
  const failureText = pooled
    ? ' Report also how many comparable shared or group runs fell short of their minimum and what happened to buyers then.'
    : '';
  const why = args.precedent
    ? ` The same design is shown working for a different buyer ("${args.precedent.title.slice(0, 80)}"), so ask whether these buyers would pay for it the same way. Material differences to bridge, none established by the precedent: ${TRANSFER_MATERIAL.join(', ')} — for each, report a source on how these buyers differ from the precedent's, or say none was found.`
    : '';
  const question =
    args.origin === 'REVERSE'
      ? `Brain composed an arrangement nobody has published as an opening, starting from the economics the goal needs rather than from any business: ${shape}${facts.fulfiller === 'BRAIN' && supply ? `, the work being ${supply.name} that Brain produces itself` : ''}. ` +
        'Find kinds of buyers — in any industry, consumer or business — for whom this design would work: numerous, reachable, with a recurring need they are published as paying for, ' +
        `${facts.fulfiller === 'SUPPLIER' ? 'and suppliers who publish the capacity and the terms to fulfil it, ' : ''}` +
        `and name each with its published evidence. For each, find a published source: ${asks}.${reliesText}${failureText}${exclusionSentence(args.exclusions)} ` +
        OPENING_SENTENCE +
        'Where no source shows any buyers pay for this, say so plainly — that refutes the arrangement and is a useful answer.'
      : `Brain composed an arrangement nobody has published as an opening, and needs the world to confirm or refute it: ` +
        `buyers described as "${demand.name}" pay ${need ? `to deal with "${need.name}"` : 'for what they need most — first name what these buyers are published as paying for, each with its price, page and date, since nothing held names it yet'}, fulfilled by ${supply ? (supply.from === 'CAPABILITY' ? `Brain producing it (${supply.name})` : `"${supply.name}"`) : 'a supplier'}, and the operation is designed as: ${shape}. ` +
        `Establish whether such buyers actually pay for this and whether ${def.needsSupply ? 'such suppliers would take the work on these terms' : 'the deliverable is what they buy'}.${why} ` +
        ([demand, need, supply].some((one) => one?.from === 'BRAIN_MAP') ? `${BRAIN_MAP_SENTENCE} ` : '') +
        `For each part, find a published source: ${asks}.${established}${reliesText}${failureText}${exclusionSentence(args.exclusions)} ` +
        OPENING_SENTENCE +
        unitEconomicSentence(demand.name) +
        'Where no source shows buyers pay for this, say so plainly — that refutes the arrangement and is a useful answer.';
  /*
   * The positions are asked in the round itself (RES-15-4; S-0148, S-0150).
   * `askConstructedArrangements` (goals/plan.ts) opens one constructed round
   * per arrangement from `question`, and that round is what research works on,
   * so a position question kept only beside the arrangement was never asked.
   * The same questions `positionQuestions` carries are appended to it as a
   * decomposition — one sub-question per position, and the buyer-access and
   * conversion gaps as separate ones — so the gaps decide the fragments.
   */
  const positionQuestions = def.needsSupply ? positionResearchQuestions({ demand, need, supply, estimates, exclusions: args.exclusions }) : null;
  const asked = positionQuestions ? `${question} ${positionDecomposition(positionQuestions)}` : question;
  const signature = arrangementSignature(design, demand, need, supply);
  // What research about it depends on, under an identity: the evidence beside the signature.
  const inputsDigestOf = (identity: string): string =>
    digestOf([
      'inputs/v1',
      identity,
      [demand, need, supply].map((one) => (one ? [one.ref, one.claimId] : null)),
      args.precedent?.id ?? null,
      // A filed close rate or buyer count is new evidence too, and reopens a refutation (R3); none filed adds nothing.
      [...valueObs, ...riskObs, ...conversionObs, ...buyersObs, ...(pooled ? runCostObs : []), ...commissionObs].filter((one) => !one.broad).map((one) => one.id).sort(),
    ]);
  // The signature this arrangement had while Brain's capability was spelt from the whole deliverables list, so a verdict reached under it carries over.
  const legacySignature =
    supply?.from === 'CAPABILITY' && input.delivers.length > 0
      ? digestOf(['arrangement/v1', designKey(design), partPath(demand), partPath(need), legacyCapabilityPath(input.delivers)].join('|'))
      : null;
  const arrangement: ConstructedArrangement = {
    key,
    structure,
    design,
    origin: args.origin,
    precedent: args.precedent ? { opportunityId: args.precedent.id, title: args.precedent.title } : null,
    ...(args.precedent ? { differences: [...TRANSFER_MATERIAL] } : {}),
    sector: args.sector,
    demand,
    need,
    supply,
    label,
    properties,
    targetsMet,
    emergent,
    stress,
    evidenced,
    value: value
      ? { tier: value.tier, p10: value.p10, p50: value.p50, p90: value.p90, observations: value.used.length, sources: valueSources(value, valueObs), ...valueEvidence(value), ...priceBasisOf(design, value.used.length, participantOnly(value, valueObs)) }
      : { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    ...(conversion && conversion.used.length > 0 && conversionObs.length > 0 && conversion.tier !== 'UNKNOWN'
      ? { conversion: { tier: conversion.tier, p10: conversion.p10, p50: conversion.p50, p90: conversion.p90, observations: conversion.used.length, sources: valueSources(conversion, conversionObs), ...valueEvidence(conversion) } }
      : {}),
    ...(fixedCost && fixedCost.used.length > 0 && runCostObs.length > 0 && fixedCost.tier !== 'UNKNOWN'
      ? { fixedCost: { tier: fixedCost.tier, p10: fixedCost.p10, p50: fixedCost.p50, p90: fixedCost.p90, observations: fixedCost.used.length, sources: valueSources(fixedCost, [...riskObs, ...runCostObs]) } }
      : {}),
    ...(supplyCost && supplyCost.used.length > 0 && unitCostObs.length + runCostObs.length > 0 && supplyCost.tier !== 'UNKNOWN'
      ? { supplyCost: { tier: supplyCost.tier, p10: supplyCost.p10, p50: supplyCost.p50, p90: supplyCost.p90, observations: supplyCost.used.length, sources: valueSources(supplyCost, supplyCostObs), ...valueEvidence(supplyCost) } }
      : {}),
    ...(commission && commission.used.length > 0 && commissionObs.length > 0 && commission.tier !== 'UNKNOWN'
      ? { commission: { tier: commission.tier, p10: commission.p10, p50: commission.p50, p90: commission.p90, observations: commission.used.length, sources: valueSources(commission, commissionObs), ...valueEvidence(commission) } }
      : {}),
    unknownParts,
    relatedOpenings: args.related.map((one) => one.id),
    question: asked,
    ...buyerTermsOf(demand, args.related),
    repeatBusiness,
    signature,
    inputsDigest: inputsDigestOf(signature),
    ...(legacySignature ? { legacyInputsDigest: inputsDigestOf(legacySignature) } : {}),
    ...(positionQuestions ? { positionQuestions: positionQuestions.map(carriedPositionQuestion) } : {}),
  };
  return { arrangement, levered };
}

const justified = (estimates: Record<string, Estimate>, part: string): string | null => {
  const est = estimates[`a_${part}`];
  return est && est.distributionJustified ? `${Math.round(est.p10)}–${Math.round(est.p90)}` : null;
};

/**
 * What an arrangement already establishes, in S-0150's terms. Only a part
 * resting on a gated claim or a justified reconstruction counts; everything
 * else is missing. The bases say what kind of source established it: a
 * published price on an opening is an asking price and a buyer count is a
 * market size, and neither says anybody can be reached or will buy.
 */
export function arrangementPositionFacts(args: {
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  estimates: Record<string, Estimate>;
}): PositionFacts {
  const { demand, need, supply, estimates } = args;
  const fields: PositionFacts['fields'] = {
    payer: demand.claimId && demand.from !== 'REVERSE' ? demand.name : null,
    demand: need?.claimId && need.from === 'OPENING' ? need.name : null,
    supply: supply?.claimId && supply.from !== 'CAPABILITY' && supply.from !== 'REVERSE' ? supply.name : null,
    price: justified(estimates, 'value'),
    spread: justified(estimates, 'commission') ?? justified(estimates, 'fee'),
    throughput: justified(estimates, 'supply_units'),
    cashStructure: justified(estimates, 'prepay_share'),
  };
  const bases: EvidenceBasis[] = [];
  if (fields.price) bases.push('PUBLIC_ASKING_PRICE');
  if (justified(estimates, 'buyers')) bases.push('TOTAL_MARKET_SIZE');
  if (justified(estimates, 'conversion')) bases.push('OBSERVED_TRANSACTION');
  if (fields.demand) bases.push('BUYER_INQUIRY');
  return { fields, bases };
}

const list = (items: readonly string[]) => items.join('; ');

/**
 * Expand a supply-needing arrangement into one research question per lawful,
 * economically distinct position the transaction can be held from, each
 * asking only what is missing at that position plus what holds there
 * contractually. Pure; ranking is untouched.
 */
export function positionResearchQuestions(args: {
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  estimates: Record<string, Estimate>;
  exclusions: readonly ExclusionClass[];
  positions?: ResolvedPosition[];
}): PositionResearchQuestion[] {
  const facts = arrangementPositionFacts(args);
  const established = (Object.keys(EVIDENCE_FIELDS) as EvidenceField[]).filter((field) => {
    const v = facts.fields[field];
    return v !== null && v !== undefined && String(v).trim().length > 0;
  });
  const { demand, need, supply } = args;
  const buyers = demand.from === 'REVERSE' ? 'buyers still to be found, of any type and in any market structure' : `buyers described as "${demand.name}"`;
  const subject =
    `${buyers}${need ? `, paying to deal with "${need.name}"` : ''}, fulfilled by ${supply && supply.from !== 'CAPABILITY' ? `"${supply.name}"` : 'a supplier or capacity source still to be found'}`;
  const scope =
    ` Look from both ends: buyer-first (${list(ENTRY_POINTS.BUYER_FIRST)}) and supply-first (${list(ENTRY_POINTS.SUPPLY_FIRST)}); these are examples of where to look, not limits, and so are industries such as ${INTERMEDIATION_FAMILY.examples.join(', ')}.` +
    ` Do not default to ${INTERMEDIATION_FAMILY.notDefaults.join(', ')}.`;
  const knownText = established.length ? ` Already established, so do not research again: ${established.join(', ')}.` : '';
  const out: PositionResearchQuestion[] = [];
  for (const position of args.positions ?? positionsToExamine()) {
    const label = position.definition?.label ?? position.name;
    const gaps = positionEvidenceGaps(position, facts);
    const asks = gaps.flatMap((gap) => (gap.kind === 'FIELD' ? [gap.field] : []));
    const inv = position.definition?.investigate;
    const investigate = inv
      ? ` At exactly this position, investigate: contracts (${list(inv.contracts)}); rights (${list(inv.rights)}); liabilities (${list(inv.liabilities)}); restrictions (${list(inv.restrictions)}); counterparty expectations (${list(inv.counterpartyExpectations)}).`
      : ' At exactly this position, investigate the contracts, rights, liabilities, restrictions and counterparty expectations that hold there.';
    const holds = position.definition ? ` — one that ${position.definition.holds}` : '';
    const fieldText = asks.length ? ` For this position, find a source for each of: ${asks.map((field) => `${field}: ${EVIDENCE_FIELDS[field]}`).join('; ')}.` : '';
    out.push({
      kind: 'POSITION',
      position: label,
      catalogued: position.catalogued,
      asks,
      established,
      question:
        `Brain is examining one potential transaction — ${subject} — held from the ${label} position${holds}. ` +
        'Return commercially usable evidence for this exact position, never industry facts or market overviews.' +
        `${fieldText}${knownText}${investigate}${scope}${exclusionSentence(args.exclusions)} ` +
        OPENING_SENTENCE +
        'Where this position is unlawful or uneconomic for these buyers, say so plainly — that rules the position out and is a useful answer.',
      investigate: investigate.trim(),
    });
    for (const gap of gaps) {
      if (gap.kind === 'FIELD') continue;
      out.push({
        kind: gap.kind,
        position: label,
        catalogued: position.catalogued,
        asks: [],
        established,
        investigate: '',
        question:
          `Brain is examining one potential transaction — ${subject} — held from the ${label} position. ` +
          `What is established is only ${facts.bases?.includes('PUBLIC_ASKING_PRICE') ? 'a public asking price' : ''}${facts.bases?.includes('PUBLIC_ASKING_PRICE') && facts.bases?.includes('TOTAL_MARKET_SIZE') ? ' and ' : ''}${facts.bases?.includes('TOTAL_MARKET_SIZE') ? 'a total market size' : ''}, ` +
          `which does not answer this on its own, so investigate it separately: ${gap.ask}.${exclusionSentence(args.exclusions)} ` +
          'Where no source shows it, say so plainly.',
        ask: gap.ask,
      });
    }
  }
  return out;
}

/**
 * Words the catalogues use that read, to a research envelope, as an
 * instruction to act ("purchase"), restated as what research reads about. The
 * catalogue's meaning is unchanged: a buyer's purchase request is still a
 * buying request a source shows, and a distributor's minimum purchase is still
 * a minimum order volume in its agreement.
 */
export function researchWording(text: string): string {
  return text
    .replace(/\brepeat purchases?\b/gi, 'repeat orders')
    .replace(/\bminimum purchases?\b/gi, 'minimum order volume')
    .replace(/\bpurchase price\b/gi, 'price paid')
    .replace(/\bpurchase requests?\b/gi, (m) => (m.endsWith('s') ? 'buying requests' : 'buying request'))
    .replace(/\blead-purchase\b/gi, 'lead-sale')
    .replace(/\bpurchas(?:e|es|ed|ing)\b/gi, 'buying');
}

/**
 * The position questions as one decomposition the constructed round asks:
 * each position its own numbered sub-question with only what is missing there
 * and what holds there contractually, and each buyer-access or conversion gap
 * as a separate one. What is shared — the transaction, where to look, what an
 * opening is — is already in the round's question and is not repeated.
 */
/**
 * A position question as an arrangement carries it. What research is asked is the
 * arrangement's own question, with the positions decomposed into it
 * (`positionDecomposition`); the full per-position text, ~3.4 kB each and eleven
 * per arrangement, is read by nothing past composition. Carried whole on every
 * arrangement it made a construction pass 16 MB (2026-11-15), stalling the
 * server's loop when the pool handed it back and filling the library's rows. The
 * arrangement keeps the question's opening — the transaction, the position and
 * what evidence to return — and its structured fields; what to investigate there
 * is in the arrangement's question already.
 */
const POSITION_OPENING_END = 'never industry facts or market overviews.';
function carriedPositionQuestion(q: PositionResearchQuestion): PositionResearchQuestion {
  const end = q.question.indexOf(POSITION_OPENING_END);
  // `investigate` is in the arrangement's own question already, through the decomposition.
  const { investigate: _investigate, ...rest } = q;
  return end < 0 ? rest : { ...rest, question: q.question.slice(0, end + POSITION_OPENING_END.length) };
}

export function positionDecomposition(questions: readonly PositionResearchQuestion[]): string {
  const positions = questions.filter((q) => q.kind === 'POSITION');
  if (positions.length === 0) return '';
  const established = positions[0]!.established;
  const lines = positions.map((q, i) => {
    const asks = q.asks.length ? ` Find a source for: ${q.asks.join(', ')}.` : '';
    return `(${i + 1}) The ${q.position} position.${asks}${q.investigate ? ` ${q.investigate}` : ''}`;
  });
  /*
   * A buyer-access or conversion gap is the same gap at every position it
   * arises at, so it is one separate sub-question naming those positions —
   * still investigated apart from the position's own fields, as S-0150 asks.
   */
  const gapLines: string[] = [];
  for (const kind of ['BUYER_ACCESS', 'CONVERSION'] as const) {
    const at = questions.filter((q) => q.kind === kind);
    if (at.length === 0) continue;
    const what =
      kind === 'BUYER_ACCESS'
        ? 'a public asking price or market size does not show the payer can be reached: establish a reachable channel to a named payer'
        : 'a public asking price or market size does not show anyone buys through this route: establish observed conversion from that channel';
    gapLines.push(`(${positions.length + gapLines.length + 1}) Separately, ${kind === 'BUYER_ACCESS' ? 'buyer access' : 'conversion'} — ${what}, at each of these positions: ${at.map((q) => q.position).join(', ')}.`);
  }
  const legend = [...new Set(positions.flatMap((q) => q.asks))].map((field) => `${field} = ${EVIDENCE_FIELDS[field]}`).join('; ');
  return researchWording(
    'Research this transaction position by position: each numbered item below is its own sub-question, researched separately, ' +
      'and the same transaction may be lawful and economic from one position and not another — return commercially usable evidence for each exact position, never industry facts. ' +
      (established.length ? `Already established, so do not research again: ${established.join(', ')}. ` : '') +
      (legend ? `Where an item asks for a field, it means: ${legend}. ` : '') +
      ` Look from both ends: buyer-first (${list(ENTRY_POINTS.BUYER_FIRST)}) and supply-first (${list(ENTRY_POINTS.SUPPLY_FIRST)}) — examples of where to look, not limits, as are industries such as ${INTERMEDIATION_FAMILY.examples.join(', ')}; do not default to ${INTERMEDIATION_FAMILY.notDefaults.join(', ')}. ` +
      [...lines, ...gapLines].join(' ') +
      ' Where a position is unlawful or uneconomic for these buyers, say so plainly — that rules it out and is a useful answer.',
  );
}

/**
 * How a constructed round's answer becomes an opening, said in the question.
 *
 * The harvest files only a claim whose reader set `opportunity_signal`
 * (`signalledClaims`), and the question used to say "report an opening" without
 * naming the field. Production, 2026-11-02: ten constructed rounds finished
 * with accepted claims — orc_d083edfc645c47e6b99d's fragment was ACCEPTED with
 * a demand_pattern claim and two economics claims — and every one read
 * "found 0", because a constructed arrangement is not a published opening and
 * the profile asks for a signal only on "a concrete opening". The worker still
 * decides whether a claim is one; this only names the field and the three
 * kinds a constructed design can be. It lowers no bar: a signalled claim passes
 * the same gate, and the harvested piece starts as evidence and is qualified
 * like any other.
 */
export const OPENING_SENTENCE =
  'Report an opening only where a source shows a payer, a price and a published way to reach them, ' +
  'and report it by setting opportunity_signal on the claim that names those buyers: ' +
  'RECURRING_OUTSOURCED_WORK where such buyers repeatedly commission the same brief, ' +
  'ACTIVE_BUYER_DEMAND where a named buyer is published as paying for it now, or ' +
  'SUPPLY_DEMAND_MISMATCH where published demand and a published supply are not yet connected. ' +
  'A claim with no opportunity_signal is kept as evidence and never becomes an opening. ';

/**
 * How a confirm-or-refute round's price and cost answers reach the plan.
 *
 * Production, 2026-11-17 (release 04b754ce): a constructed round on the $10K
 * goal returned accepted claims with published prices ("$0.47 per postcard
 * piece for a 10,000-home run") that reached no table, because a claim with no
 * opportunity_signal is kept only as evidence and the construction backfill
 * (`backfillClaimFacts`) files a claim only when it declares UNIT_ECONOMIC.
 * The industry kernel's questions ask for that declaration
 * (`unitEconomicsAsk`, industry/questions.ts); the constructed round never did.
 * The buyer is the arrangement's own demand, which is a buyer type on the map,
 * so the backfill can file it. Inlined rather than imported: questions.ts
 * reaches this module through cash/discovery.ts. It lowers no bar — the
 * declared figure passes the same gate and the backfill's own rules.
 */
export function unitEconomicSentence(buyer: string): string {
  // The qualifier is the buyer's name exactly as the map holds it: a clipped name matches no buyer type.
  const name = buyer.replace(/\s+/g, ' ').trim();
  return (
    `Where a source publishes what "${name}" pay per unit of work, what an independent operator ` +
    'accepts per unit, how many units one account buys a month, what share of such buyers approached bought, or how many ' +
    'such buyers a named market holds, declare it on its claim: structural_finding UNIT_ECONOMIC, ' +
    'structural_subject the fact key (price_per_unit, contractor_rate_per_unit, account_units_per_month, account_win_rate ' +
    'or accounts_reachable), ' +
    `structural_qualifier "${name}", and structural_amount_cents the figure in hundredths of its unit (a share of one: 18% is 18). `
  );
}

/**
 * The plan inputs a constructed round can ask for one at a time, in the order
 * they hold an arrangement out of the goal model or weaken it most, each with
 * the fact key its existing filer writes (`constructedRoundDecisions`,
 * industry/expand.ts; `readNonPriceFact`; `readShareOrCount`; `supplyQuote`).
 * A part no filer reads (commission, fee, minimum participants, prepay share…)
 * is not asked this way: its answer would reach no plan input. A value the
 * model cannot read is asked before all of them (`nextInputQuestion`); a value
 * it reads from an observation but not yet as a distribution comes after the
 * demand-side links, which without a filed fact are swept from nothing.
 */
const FILED_INPUTS = ['conversion', 'buyers', 'need_rate', 'value', 'fixed_cost', 'supply_cost'] as const;
export type FiledInput = (typeof FILED_INPUTS)[number];
const FILED_KEY: Record<FiledInput, FactKey> = {
  value: 'price_per_unit',
  conversion: 'account_win_rate',
  buyers: 'accounts_reachable',
  need_rate: 'account_units_per_month',
  fixed_cost: 'fixed_cost_per_run',
  supply_cost: 'contractor_rate_per_unit',
};

/**
 * The direction a price question's answer must run (production 2026-11-20,
 * prj_22fb4fec: GitHub's $10,000 bug-bounty rewards, paid TO researchers, were
 * filed as what the asked buyers pay). The back-fill refuses a claim that says
 * otherwise (`claimPaysPopulation`, industry/expand.ts).
 */
const PAID_BY_BUYER =
  'Only money these buyers pay out is this figure, and the claim must say they are the ones paying: a reward, bounty, wage, fee or payout paid to them runs the other way — leave it out. And it must be a purchase: a reward, bounty, prize, grant or rebate they pay out is not what they pay a supplier for a deliverable — leave it out too.';

/**
 * The one plan input a constructed arrangement's next round asks for, and the
 * question that asks it (P2, production 2026-11-18, goal wst_7b4fcbb5f2384f31b6c3).
 *
 * The arrangement's own `question` asks for every unknown part at once — seven
 * or more asks, then a decomposition over eleven positions — and research
 * answers whichever is easiest: round cdr_4c03f5a51e57411d8f67 on the postcard
 * arrangement 2821cce3c372 asked for the slot price and the run cost together
 * and came back with the run cost alone ($4,675, cfa_ca236ebb), so the
 * arrangement's value stayed UNKNOWN and `estimatedFromArrangement` kept it out
 * of the goal model. Of 80 claims accepted in the next twelve hours, 3 filled a
 * plan input.
 *
 * So a forward arrangement's round asks exactly one input: what these buyers
 * pay whenever the model cannot read the value (UNKNOWN, or a MECHANISM pool of
 * other buyers' prices), else the first part nothing establishes in
 * `FILED_INPUTS` order (close rate, buyer count, volume, price, run cost, supply rate) — the one its filer can file, stated in that filer's
 * unit and wording, for the arrangement's own buyer, declared under its fact
 * key. Null when the arrangement was reverse-constructed (it has no buyer yet
 * to ask about) or every filed input is established: the full question then
 * asks the rest, positions included. Pure.
 */
export function nextInputQuestion(
  one: Pick<ConstructedArrangement, 'origin' | 'design' | 'demand' | 'need' | 'supply' | 'value' | 'unknownParts'>,
  currency: string,
  exclusions: readonly ExclusionClass[] = [],
): { part: FiledInput; factKey: FactKey; question: string } | null {
  if (one.origin === 'REVERSE') return null;
  const pooled = one.design.aggregation === 'POOLED_BUYERS';
  const valueBlocks = one.value.tier === 'UNKNOWN' || one.value.tier === 'MECHANISM';
  const part: FiledInput | undefined = valueBlocks
    ? 'value'
    : FILED_INPUTS.find(
        (p) =>
          one.unknownParts.includes(p) &&
          // A pooled design's cost is its run's fixed cost; it files no per-deal supply cost.
          !(p === 'supply_cost' && pooled) &&
          // A run cost or a supply rate names the supplier, so there must be one to name.
          !((p === 'fixed_cost' || p === 'supply_cost') && !one.supply),
      );
  if (!part) return null;
  const buyer = one.demand.name.replace(/\s+/g, ' ').trim();
  const supplier = one.supply ? one.supply.name.replace(/\s+/g, ' ').trim() : null;
  const what = one.need ? `what deals with "${one.need.name}"` : 'it';
  const sym = currency === 'USD' ? '$' : `${currency} `;
  const ask: Record<FiledInput, string> = {
    value: pooled
      ? `What does one buyer described as "${buyer}" pay, in ${currency}, for one slot — that one buyer's own place in a shared run, not the whole run? ` +
        'Look for published rate cards and price lists of sellers who already sell such slots to these buyers. ' +
        `Quote each price as one of these buyers pays it, in the form ‘${sym}N per slot’, one price per claim, with its source and date. ` +
        'What producing or delivering the run costs whoever organises it is a different question: leave it out. ' +
        PAID_BY_BUYER
      : `What does one buyer described as "${buyer}" pay, in ${currency}, for one purchase of ${what}? ` +
        'Look for published price lists, rate cards and quoted prices of sellers who already sell this to these buyers. ' +
        `Quote the total one of these buyers pays for one purchase, in the form ‘${sym}N for <what one purchase delivers>’, one price per claim, with its source and date. ` +
        'A rate per word, page, hour or minute is not this figure: where a source states only such a rate, quote the total it states for one stated purchase, or say that no total is published. ' +
        'What supplying it costs the seller is a different question: leave it out. ' +
        PAID_BY_BUYER,
    conversion:
      `What share of buyers described as "${buyer}" who were approached or offered ${what} bought it? ` +
      'Look for published case studies, campaign reports and surveys. ' +
      'Quote it as ‘N% of the businesses contacted signed’ or ‘a close rate of N%’, one percentage per claim and no other percentage in that claim, with its source and date. ' +
      'A reply, open or click rate is not this figure.',
    buyers:
      `How many buyers described as "${buyer}" does one named market hold — a country, a state or a metro area? ` +
      'Look for published directories, registers, censuses and trade-body counts. ' +
      'Quote it as ‘There are N <buyers> in <market>’, one count per claim, naming the market, with its source and date. ' +
      'A count of sales, installs or sign-ups over a period is not this figure.',
    need_rate:
      `How many times a month does one buyer described as "${buyer}" buy ${what}? ` +
      "Look for published industry reports, surveys and sellers' own statements of order frequency. " +
      'Quote it as ‘each <buyer> buys N <units> per month’, one figure per claim, with its source and date.',
    fixed_cost:
      `What does one whole shared run cost, in ${currency}, from suppliers described as "${supplier ?? 'the supplier'}", however many buyers take part? ` +
      'Look for published price lists and quotes. ' +
      `Quote the supplier's total for a stated quantity together with its rate, in the form ‘<supplier> charges ${sym}R per <unit> for a Q-unit run, total ${sym}T’, one quote per claim, with its source and date.`,
    supply_cost:
      `What does a supplier described as "${supplier ?? 'the supplier'}" charge, in ${currency}, for one unit of this work? ` +
      'Look for published price lists and rate cards. ' +
      `Quote it as ‘<supplier> charges ${sym}N per <unit>’, naming the supplier, one price per claim, with its source and date.`,
  };
  const factKey = FILED_KEY[part];
  // A run's total is read from the quote's own wording (`supplyQuote`); the declared path files the other keys.
  const declare =
    part === 'fixed_cost'
      ? ''
      : ` Declare each figure on its claim: structural_finding UNIT_ECONOMIC, structural_subject ${factKey}, structural_qualifier "${buyer}", and structural_amount_cents the figure in hundredths of its unit (a share of one: 18% is 18).`;
  const question =
    // The supplier is named only when its own price is asked: a buyer's price quoted in the supply's words is filed as a cost (`claimPricesSupply`).
    `Brain is pricing one arrangement for these buyers, designed as: ${describeDesign(one.design)}, ` +
    `and asks for one figure only; the arrangement's other parts are asked separately. ${ask[part]}${declare}${exclusionSentence(exclusions)} ` +
    OPENING_SENTENCE +
    (part === 'value' ? 'Where no source shows these buyers pay for this, say so plainly — that refutes the arrangement and is a useful answer.' : 'Where no source states this figure, say so plainly — that is a useful answer.');
  return { part, factKey, question };
}

/** The design every structure had before §82, for callers that still name a structure. */
export { defaultDesign };


// ---------------------------------------------------------------------------
// Construction from the event graph (ALGO-16-1 item 4, ALGO-19-4 "derive")
// ---------------------------------------------------------------------------

/**
 * The structures each graph rule's relationship can be paid through. A rule
 * names a relationship (a buyer's request against a supplier, demand against
 * short supply, a renewal against capacity, a spread, requests a partner could
 * serve); the structures are the closed table above, so nothing here is a
 * per-industry template and a relationship in any industry reads the same way.
 */
const GRAPH_ROLES: Record<RuleId, readonly Structure[]> = {
  BUYER_REQUEST_AGAINST_SUPPLIER: ['BROKER', 'REFERRAL', 'SUBCONTRACT', 'PRODUCE'],
  REPEATED_DEMAND_LIMITED_SUPPLY: ['POOL', 'BROKER', 'PRODUCE'],
  RENEWAL_AGAINST_CAPACITY: ['BROKER', 'REFERRAL', 'SUBCONTRACT'],
  SPREAD_AFTER_COSTS: ['SUBCONTRACT', 'BROKER'],
  PARTNER_SERVABLE_CONCENTRATION: ['REFERRAL', 'BROKER', 'SUBCONTRACT'],
};

/** What the goal allows, for the cheap hard-constraint prune. Unknown is never read as allowed-and-proven. */
export interface GraphConstructionContext {
  /** The goal's capital ceiling; 0 means none may be committed, null that the owner set none. */
  capitalCeilingCents: number | null;
  /** Deliverable kinds Brain proved it can produce, as people read them. */
  delivers: readonly string[];
  exclusions?: readonly ExclusionClass[];
}

/** One candidate built from a graph hypothesis. Still a hypothesis: the type has no other status. */
export interface GraphConstruction {
  status: 'HYPOTHESIS';
  /** Stable: structure plus the hypothesis it came from. */
  key: string;
  /** Near-identical designs share this; distinct mechanisms never do. */
  signature: string;
  structure: Structure;
  structureLabel: string;
  rule: RuleId;
  neighborhood: string;
  hypothesisKey: string;
  /** The hypothesis's missing conditions, carried, plus what this structure itself still lacks. */
  missingConditions: string[];
  evidence: GraphHypothesis['evidence'];
  /** Price and margin bounds in minor units, where the hypothesis states figures; null where nothing does. */
  marginCents: { low: number | null; high: number | null };
  /** Deals the relationship shows room for; null when nothing counts them. */
  availableDeals: number | null;
  /** The stated cost at which the margin vanishes, where one is computable. */
  breakEvenCostCents: number | null;
  /** Other hypotheses' near-identical designs this one stands for. */
  collapsed: string[];
  /** The actors the hypothesis joined, as its records name them: the buyer and supplier sides construction composes. */
  actors: GraphHypothesis['actors'];
}

export interface GraphPruned {
  key: string;
  structure: Structure;
  hypothesisKey: string;
  /** The hard constraint that failed, in a sentence. */
  reason: string;
  /**
   * What of the failed design stays worth a later one: the relationship the
   * graph found (its actors, facts and neighborhood) is unchanged by one
   * structure failing, and another structure, or the same one once the
   * constraint lifts, can still use it.
   */
  salvage: { rule: RuleId; actorKeys: string[]; factIds: string[]; neighborhood: string };
}

export interface GraphConstructionResult {
  /** Ranked: what most deserves costly investigation first. */
  kept: GraphConstruction[];
  pruned: GraphPruned[];
}

function hardConstraintFailure(structure: Structure, h: GraphHypothesis, ctx: GraphConstructionContext): string | null {
  const def = STRUCTURES[structure];
  if (def.capital !== 'NONE' && ctx.capitalCeilingCents === 0) {
    return `${def.label} commits capital per deal, and the goal allows none`;
  }
  if (def.needsDeliverable && !ctx.delivers.some((kind) => norm(kind) === norm(h.neighborhood))) {
    return `Brain has not proved it can produce ${h.neighborhood}, which ${def.label} requires`;
  }
  if (def.needsSupply && h.rule === 'REPEATED_DEMAND_LIMITED_SUPPLY' && !h.figures['supplied']) {
    return `${def.label} needs a supplier, and none is recorded in this place`;
  }
  const excluded = ctx.exclusions?.length ? excludedBy(`${h.neighborhood} ${h.summary}`, ctx.exclusions) : null;
  if (excluded) return `the goal's owner excluded this class (${excluded})`;
  return null;
}

function structureGaps(structure: Structure, h: GraphHypothesis, ctx: GraphConstructionContext): string[] {
  const def = STRUCTURES[structure];
  const gaps: string[] = [];
  if (def.capture === 'COMMISSION') gaps.push('the commission share the supplier would pay is not established');
  if (def.capture === 'FEE' && def.needsSupply) gaps.push('the referral fee the supplier would pay is not established');
  if (def.capital !== 'NONE' && ctx.capitalCeilingCents === null) gaps.push('the capital per deal is not established against any ceiling');
  if (def.capital !== 'NONE' && h.figures['netCents'] === undefined && h.figures['grossCents'] === undefined) gaps.push('the margin per deal is not established');
  return gaps;
}

function boundsOf(h: GraphHypothesis): Pick<GraphConstruction, 'marginCents' | 'availableDeals' | 'breakEvenCostCents'> {
  const gross = h.figures['grossCents'];
  const net = h.figures['netCents'];
  const demanded = h.figures['demanded'];
  const supplied = h.figures['supplied'];
  const buyers = h.figures['buyers'];
  return {
    marginCents: { low: net ?? null, high: gross ?? net ?? null },
    availableDeals: demanded !== undefined && supplied !== undefined ? Math.max(0, demanded - supplied) : buyers ?? (h.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER' || h.rule === 'RENEWAL_AGAINST_CAPACITY' ? 1 : null),
    breakEvenCostCents: gross ?? null,
  };
}

/** Lexicographic, as the rest of this module ranks: fewer unknowns, then a larger margin bound, then more room, then the key. */
function decisionOrder(a: GraphConstruction, b: GraphConstruction): number {
  return (
    a.missingConditions.length - b.missingConditions.length ||
    (b.marginCents.high ?? -Infinity) - (a.marginCents.high ?? -Infinity) ||
    (b.availableDeals ?? -1) - (a.availableDeals ?? -1) ||
    a.key.localeCompare(b.key)
  );
}

/**
 * Event-graph hypotheses as construction inputs, beside the industry map,
 * openings and capabilities the rest of this module composes from.
 *
 * Each hypothesis is joined with every structure its relationship can be paid
 * through (the transaction roles). A cheap prune drops a candidate whose hard
 * constraint fails — capital the goal does not allow, a deliverable Brain has
 * not proved, a supplier nobody recorded, a class the owner excluded — before
 * anything costly is spent on it, recording why, and keeps the side of it that
 * is still worth a later design. Near-identical designs (one structure, one
 * neighborhood, one relationship, other actors) collapse into the strongest;
 * different structures are different mechanisms and all stay. What is left is
 * ranked by what most deserves costly investigation. Every result is a
 * hypothesis carrying the graph's missing conditions plus its own. Pure.
 */
export function constructFromGraph(hypotheses: readonly GraphHypothesis[], ctx: GraphConstructionContext): GraphConstructionResult {
  const pruned: GraphPruned[] = [];
  const bySignature = new Map<string, GraphConstruction>();
  for (const h of [...hypotheses].sort((a, b) => a.key.localeCompare(b.key))) {
    if (h.status !== 'HYPOTHESIS') continue;
    for (const structure of GRAPH_ROLES[h.rule]) {
      const key = `${structure}:${h.key}`;
      const failure = hardConstraintFailure(structure, h, ctx);
      if (failure) {
        pruned.push({
          key,
          structure,
          hypothesisKey: h.key,
          reason: failure,
          salvage: { rule: h.rule, actorKeys: h.actorKeys, factIds: h.factIds, neighborhood: h.neighborhood },
        });
        continue;
      }
      const candidate: GraphConstruction = {
        status: 'HYPOTHESIS',
        key,
        signature: digestOf(['graph-construction/v1', structure, h.rule, h.neighborhood].join('|')),
        structure,
        structureLabel: STRUCTURES[structure].label,
        rule: h.rule,
        neighborhood: h.neighborhood,
        hypothesisKey: h.key,
        missingConditions: [...new Set([...h.missingConditions, ...structureGaps(structure, h, ctx)])],
        evidence: h.evidence,
        ...boundsOf(h),
        collapsed: [],
        actors: h.actors,
      };
      const held = bySignature.get(candidate.signature);
      if (!held) {
        bySignature.set(candidate.signature, candidate);
      } else if (decisionOrder(candidate, held) < 0) {
        bySignature.set(candidate.signature, { ...candidate, collapsed: [...held.collapsed, held.key] });
      } else {
        held.collapsed.push(candidate.key);
      }
    }
  }
  return { kept: [...bySignature.values()].sort(decisionOrder), pruned };
}

// ---------------------------------------------------------------------------
// Missing-link questions (ALGO-19-4 "derive … rank possible transactions and missing-link questions")
// ---------------------------------------------------------------------------

/**
 * One question derived from the constructions: a condition nobody has
 * established, in one neighborhood, that stands between one or more ranked
 * constructions and an opening. It is a research question, never an answer:
 * the condition is unestablished until a source a person or an audit can read
 * says otherwise.
 */
export interface MissingLinkQuestion {
  /** Stable across cycles: the neighborhood and the condition, so the same gap is asked once. */
  key: string;
  neighborhood: string;
  /** The unestablished condition, verbatim from the construction that carries it. */
  condition: string;
  /** The question as it is put to research. */
  question: string;
  /** The constructions that would move if it were answered, strongest first. */
  constructionKeys: string[];
  /** Distinct mechanisms it bears on: an answer that settles several structures is worth more. */
  structures: Structure[];
  /** Source records the constructions were read from, so research starts where the graph did. */
  evidenceUrls: string[];
  /**
   * Expected decision value, ordinal: for each construction it bears on, one
   * over that construction's unknowns — closing one of two gaps moves a design
   * further than closing one of six — plus a unit when the design states a
   * margin, so a gap in front of a priced design ranks above one in front of
   * an unpriced one.
   */
  value: number;
}

/** Questions one cycle carries forward; the rest wait for the next cycle's ranking. */
export const MISSING_LINK_QUESTIONS = 10;

/**
 * The missing-link questions a construction result implies, ranked by what an
 * answer would move. Pure.
 *
 * Each kept construction names what it still lacks; the same condition in the
 * same neighborhood is one question however many constructions carry it, so a
 * gap shared by a broker, a referral and a subcontract design is asked once
 * and ranks by all three. Pruned designs contribute nothing here: their hard
 * constraint failed, and asking about their soft gaps would spend research on
 * a design that cannot run.
 */
export function missingLinkQuestions(result: Pick<GraphConstructionResult, 'kept'>, limit: number = MISSING_LINK_QUESTIONS): MissingLinkQuestion[] {
  const byKey = new Map<string, MissingLinkQuestion>();
  // In the construction ranking, whatever order the caller holds them in: the same result asks the same questions.
  for (const one of [...result.kept].sort(decisionOrder)) {
    const weight = 1 / Math.max(1, one.missingConditions.length) + (one.marginCents.high !== null ? 1 : 0);
    for (const condition of one.missingConditions) {
      const key = digestOf(['missing-link/v1', one.neighborhood, norm(condition)].join('|'));
      let q = byKey.get(key);
      if (!q) {
        q = {
          key,
          neighborhood: one.neighborhood,
          condition,
          question: `For ${one.neighborhood}, nobody has established this yet: ${condition}. Find what a source says about it, quoting the source, or report it unanswered.`,
          constructionKeys: [],
          structures: [],
          evidenceUrls: [],
          value: 0,
        };
        byKey.set(key, q);
      }
      q.constructionKeys.push(one.key);
      if (!q.structures.includes(one.structure)) q.structures.push(one.structure);
      for (const link of one.evidence) if (link.url && !q.evidenceUrls.includes(link.url) && q.evidenceUrls.length < 3) q.evidenceUrls.push(link.url);
      q.value += weight;
    }
  }
  return [...byKey.values()]
    .map((q) => ({ ...q, value: Math.round(q.value * 1000) / 1000 }))
    .sort((a, b) => b.value - a.value || b.structures.length - a.structures.length || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

/**
 * An opening's own words about its money: its title, what it offers, its
 * buying signal and where it came from. Read for what the price is paid for
 * (`paymentNatureOf`): a bounty's reward or a grant's award is never evidence
 * of what its payer pays a supplier (audit 2026-11-23). Pure.
 */
export function openingPaymentText(one: Pick<CashOpportunity, 'title' | 'offerScope' | 'buyingSignal' | 'source'>): string {
  return [one.title, one.offerScope, one.buyingSignal, one.source].filter(Boolean).join('. ');
}
