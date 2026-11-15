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
import { listNodes } from '../../repos/industry.ts';
import { listProjectConstructionFacts } from '../../repos/construction.ts';
import type { FactKey, FactStatus } from '../../domain/construction.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { paidOpportunityIds } from '../../repos/cashLedger.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { buyerNameKey } from '../../domain/industry.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { composeArrangement, type Arrangement, type Levers, type Part } from '../quant/mechanism.ts';
import { leverageOfYielding, type ArrangementLeverage, type LeverageConstraints } from '../quant/leverage.ts';
import { reconstruct } from '../quant/reconstruct.ts';
import { emptyLeverEvidence, leverEvidenceFrom, type LeverEvidence, type LeverPart } from '../quant/leverEvidence.ts';
import { claimSources, claimsByIds } from '../../repos/research.ts';
import type { CashCardFact, CashOpportunity, IndustryNode } from '../../domain/types.ts';
import type { Estimate, Observation } from '../../domain/quant.ts';
import { repeatBusinessObservations } from './deliverables/realization.ts';
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
  from: 'INDUSTRY_MAP' | 'OPENING' | 'CAPABILITY' | 'REVERSE';
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
  };
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
  /** Everything its composition read, hashed: a stored arrangement composed under the same is reused rather than recomposed. */
  composedUnder?: string;
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

function safeName(text: string): boolean {
  if (!text || text.length > 240) return false;
  if (statesNamedIn(text).length > 0) return false;
  return Object.values(APPROVAL_ENVELOPES).every((envelope) => !describesOwnAction(`a buyer population: ${text}`, envelope.forbiddenActions));
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
 * An arrangement's identity by structure (K-7): the design and, for buyer,
 * need and supply, what each part is — never a row id and never the label.
 * How it was found (forward, transferred, reversed) is not part of it: the
 * same mechanism reached two ways is one mechanism.
 */
export function arrangementSignature(design: Design, demand: Primitive, need: Primitive | null, supply: Primitive | null): string {
  return digestOf(['arrangement/v1', designKey(design), partPath(demand), partPath(need), partPath(supply)].join('|'));
}

/** The parts of a structure, in the words a researcher reads. */
const PART_ASK: Record<string, string> = {
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
    if (payer && safeName(payer) && allowed(payer) && count.demand < SIGNAL_PARTS_PER_SECTOR && !s.demand.some((one) => norm(one.name) === norm(payer))) {
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
  const opportunities = (await listOpportunities({ projectId: input.projectId })).filter((one) => !one.duplicateOfId && one.state !== 'DECLINED' && one.state !== 'ARCHIVED');
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
  // The claims the map's nodes were filed from: what they state about how these buyers pay (an RFP, a deposit, net terms).
  const nodeClaims = new Map((await claimsByIds(nodes.map((one) => one.sourceClaimId).filter((one): one is string => !!one))).map((one) => [one.id, one]));
  for (const node of nodes) {
    if (!safeName(node.name) || !allowed(node.name)) continue;
    const root = rootOf(node, byId);
    if (!allowed(root.name)) continue;
    const claim = node.sourceClaimId ? nodeClaims.get(node.sourceClaimId) : undefined;
    const terms = combineTimings([
      timingOfText(node.description, `map node "${node.name.slice(0, 60)}"`),
      timingOfText(claim ? [claim.claim, claim.evidenceExcerpt].filter(Boolean).join(' ') : null, `claim ${claim?.id ?? ''}`.trim()),
    ]);
    const p: Primitive = { name: clean(node.name), claimId: node.sourceClaimId, from: 'INDUSTRY_MAP', ref: node.id, path: nodePath(node, byId), ...(terms.timing !== 'UNKNOWN' ? { terms } : {}) };
    if (node.kind === 'BUYER_TYPE') sector(root.name).demand.push(p);
    else if (node.kind === 'BOTTLENECK') sector(root.name).needs.push(p);
    else if (node.kind === 'FULFILMENT_SOURCE') sector(root.name).supply.push(p);
  }
  // A payer research established is a buyer population too, with what it pays for as its need.
  const byPayer = new Map<string, CashOpportunity[]>();
  for (const o of opportunities) {
    if (!o.payer || !evidencedPayer.has(o.id) || !safeName(o.payer)) continue;
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

  const { priced, tiedUp, facts: factObs, capability } = await heldEvidence(input, opportunities, allowed);
  /*
   * The same inputs construct the same arrangements, so a plan re-read whose map, openings,
   * facts and limits did not move reuses the last construction instead of composing up to
   * MAX_CONSTRUCTIONS designs again (production, 2026-11-14: ~11 s of quant CPU a minute on
   * the main thread, most of it identical re-construction, and the garbage it left behind).
   * Keyed by the day, as the reconstructions' recency is.
   */
  /*
   * What the library already holds about these structures (migration 152): a
   * research verdict and a value rank candidates before the cap cuts, and an
   * arrangement stored under exactly this composition's inputs is reused
   * rather than recomposed — after a restart, a deploy or by another goal.
   */
  const { known, reuse } = await libraryFor(input.projectId);
  // What the rows state about each lever's parts, each payer's contract limit, and the real limits leverage is judged against (S-0103).
  const { leverEvidence, contractLimits } = await leverInputs(input, opportunities, facts, allowed);
  const constraints = await leverageConstraints(input, limits);
  const memoKey = createHash('sha256')
    .update(JSON.stringify({ day: now.toISOString().slice(0, 10), input: { ...input, now: undefined, limits: undefined }, limits, targets, exclusions, sectors: [...sectors.values()], precedent: [...precedentByBase.entries()].map(([k, o]) => [k, o.id]), priced, tiedUp, factObs, leverEvidence, contractLimits, constraints, openings: opportunities.map((o) => [o.id, o.payer, o.mechanism, o.state, o.updatedAt]), known }))
    .digest('hex');
  const held = constructionMemo.get(memoKey);
  if (held && Date.now() - held.at < CONSTRUCTION_MEMO_MS) return structuredClone(held.result);
  const job: ConstructionJob = { sectors: [...sectors.values()], opportunities, precedent: [...precedentByBase.entries()], capability, priced, tiedUp, facts: factObs, leverEvidence, contractLimits, input, limits, targets, exclusions, now, constraints, known, reuse };
  // How many candidates the parts support, against how many are composed: the cut is reported, never silent (K-2).
  const considered = forEachCandidate(job, () => undefined);
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
  const plan = compositionPlan(job);
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
  constructionMemo.set(memoKey, { at: Date.now(), result: structuredClone(ranked) });
  while (constructionMemo.size > CONSTRUCTION_MEMO_MAX) constructionMemo.delete(constructionMemo.keys().next().value!);
  const reusable = new Set(reuse.map(([under]) => under));
  constructionReports.set(input.projectId, {
    considered,
    composed: Math.min(considered, MAX_CONSTRUCTIONS),
    cut: Math.max(0, considered - MAX_CONSTRUCTIONS),
    reused: ranked.filter((one) => one.composedUnder !== undefined && reusable.has(one.composedUnder)).length,
    at: now.toISOString(),
  });
  return ranked;
}

/** The published prices, money tied up and proved capability every composition reads. */
async function heldEvidence(input: ConstructionInput, opportunities: CashOpportunity[], allowed: (text: string | null | undefined) => boolean): Promise<{ priced: Observation[]; tiedUp: Observation[]; facts: FactObservations; capability: Primitive | null }> {
  // Published prices the project holds, as observations about the buyers who paid them.
  const priced = opportunities
    .filter((one) => one.payer && one.priceCents && one.priceCents > 0 && one.currency === input.currency && allowed(one.title))
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
  const capability: Primitive | null = input.delivers.length > 0 ? { name: input.delivers.join(', '), claimId: null, from: 'CAPABILITY', ref: 'deliverables', path: `CAPABILITY:${input.delivers.map(norm).sort().join('>')}` } : null;
  return { priced, tiedUp, facts: { unitCost: facts.unitCost, volume: facts.volume }, capability };
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

/** Construction facts that bear on a composition beyond its price: what supply costs per unit, and how much one buyer buys. */
export interface FactObservations {
  /** What supply is paid per unit for these buyers' work: a margin design's supply cost. */
  unitCost: Observation[];
  /** Units one of these buyers buys in the goal window: the demand side's need rate. */
  volume: Observation[];
}

/** Fact keys read as a price these buyers pay, a unit cost of serving them, and a volume they buy. */
const FACT_PRICE_KEYS: readonly FactKey[] = ['price_per_unit'];
const FACT_COST_KEYS: readonly FactKey[] = ['contractor_rate_per_unit'];
const FACT_VOLUME_KEYS: readonly FactKey[] = ['account_units_per_month'];
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
): Promise<{ priced: Observation[]; unitCost: Observation[]; volume: Observation[] }> {
  const out = { priced: [] as Observation[], unitCost: [] as Observation[], volume: [] as Observation[] };
  const facts = (await listProjectConstructionFacts(input.projectId)).filter((one) => FACT_EVIDENCE_STATUSES.includes(one.status) && one.segment?.startsWith('map_'));
  if (facts.length === 0) return out;
  const all = await listNodes(input.projectId);
  const byId = new Map(all.map((one) => [one.id, one]));
  const usd = input.currency.toUpperCase() === 'USD';
  const windowMonths = Math.max(1, input.daysLeft) / 30;
  for (const fact of facts) {
    const node = byId.get(fact.segment!.slice('map_'.length));
    if (!node || node.retiredAt || node.kind !== 'BUYER_TYPE' || !safeName(node.name) || !allowed(node.name)) continue;
    const root = rootOf(node, byId);
    if (!allowed(root.name)) continue;
    const kind = FACT_PRICE_KEYS.includes(fact.key) ? 'priced' : FACT_COST_KEYS.includes(fact.key) ? 'unitCost' : FACT_VOLUME_KEYS.includes(fact.key) ? 'volume' : null;
    if (!kind) continue;
    if (kind !== 'volume' && !usd) continue;
    const scale = kind === 'volume' ? windowMonths : 1;
    const low = Math.min(fact.low, fact.high) * scale;
    const high = Math.max(fact.low, fact.high) * scale;
    if (!(high > 0)) continue;
    out[kind].push({
      id: `fact:${fact.id}`,
      value: low === high ? { kind: 'POINT', value: low } : { kind: 'RANGE', low, high },
      context: { payer: norm(node.name), industry: norm(root.name), arrangement: 'held' },
      lineage: [fact.sourceClaimId ? `claim:${fact.sourceClaimId}` : `fact:${fact.id}`],
      source: fact.sourceClaimId ? { kind: 'CLAIM', ref: fact.sourceClaimId } : { kind: 'OTHER', ref: `construction_fact:${fact.id}` },
      observedAt: fact.observedAt ?? null,
      validUntil: fact.validUntil ?? null,
      measures: `${fact.key}${kind === 'volume' ? ` over ${Math.round(windowMonths * 10) / 10} month(s)` : ''}: ${fact.measures.slice(0, 120)}`,
    });
  }
  return out;
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
  const opportunities = (await listOpportunities({ projectId: input.projectId })).filter((one) => !one.duplicateOfId && one.state !== 'DECLINED' && one.state !== 'ARCHIVED');
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
  at: string;
}
const constructionReports = new Map<string, ConstructionReport>();
export function lastConstructionReport(projectId: string): ConstructionReport | null {
  return constructionReports.get(projectId) ?? null;
}

/** What the library holds for construction to rank by and reuse. */
async function libraryFor(projectId: string): Promise<{ known: NonNullable<ConstructionJob['known']>; reuse: NonNullable<ConstructionJob['reuse']> }> {
  const { listConstructedArrangements } = await import('../../repos/monetization.ts');
  const known: NonNullable<ConstructionJob['known']> = [];
  const reuse: NonNullable<ConstructionJob['reuse']> = [];
  for (const one of await listConstructedArrangements(projectId)) {
    const stored = one.design['arrangement'] as ConstructedArrangement | undefined;
    const p50 = stored?.value && typeof stored.value.p50 === 'number' ? stored.value.p50 : 0;
    known.push([one.signature, { verdict: one.verdict?.verdict ?? null, p50 }]);
    if (stored && typeof stored.composedUnder === 'string' && stored.signature === one.signature) reuse.push([stored.composedUnder, stored]);
  }
  known.sort((a, b) => a[0].localeCompare(b[0]));
  return { known, reuse };
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
  known?: Array<[string, { verdict: 'CONFIRMED' | 'REFUTED' | null; p50: number }]>;
  /** Stored arrangements by the composition digest they were composed under: reused, not recomposed. */
  reuse?: Array<[string, ConstructedArrangement]>;
  /** The real limits leverage is judged against, read from the ledger and the live authority; absent is unknown. */
  constraints?: LeverageConstraints;
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
        const needs = s.needs.length > 0 ? s.needs : [null];
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
 * The candidates a pass composes: every one the parts support, ranked by a
 * cheap closed form on what each already carries, dealt one buyer population
 * at a time, then cut at `MAX_CONSTRUCTIONS` (K-2).
 *
 * The cap was a CPU guard applied in enumeration order — designs outermost,
 * sectors in map order — so later designs and later sectors were never
 * composed and nothing said so. Now what is cut is what ranks lowest:
 * lexicographically, a structure research CONFIRMED before one nobody asked
 * about before one research REFUTED; then more of the goal's target
 * properties; a design a held opening shows working; more parts on gated
 * claims; more published prices from this very buyer; the library's own value
 * for it; the original design before a variant; fewer parts to establish.
 * Never a weighted score.
 */
export function selectCandidates(job: ConstructionJob): { selected: Candidate[]; considered: number } {
  const all: Candidate[] = [];
  const considered = forEachCandidate(job, (one) => {
    if (all.length < MAX_CANDIDATES) all.push(one);
  });
  if (all.length <= MAX_CONSTRUCTIONS) return { selected: all, considered };
  const known = new Map(job.known ?? []);
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
    const held = known.get(arrangementSignature(one.design, one.demand, one.need, one.supply));
    return {
      one,
      verdict: held?.verdict === 'CONFIRMED' ? 0 : held?.verdict === 'REFUTED' ? 2 : 1,
      met: metByDesign.get(dk)!,
      precedent: one.transfer ? 1 : 0,
      evidenced: [one.demand, one.need, one.supply].filter((p) => p?.claimId).length,
      priced: pricedByPayer.get(payerKey(one.demand.name)) ?? 0,
      p50: held?.p50 ?? 0,
      variant: isDefaultDesign(one.design) ? 0 : 1,
      parts: partsByDesign.get(dk)!,
    };
  });
  keyed.sort(
    (a, b) =>
      a.verdict - b.verdict ||
      b.met - a.met ||
      b.precedent - a.precedent ||
      b.evidenced - a.evidenced ||
      b.priced - a.priced ||
      b.p50 - a.p50 ||
      a.variant - b.variant ||
      a.parts - b.parts ||
      a.one.order - b.one.order,
  );
  // One buyer population at a time, so the cap keeps breadth (production, 2026-11-02: one sector filled the list).
  const lanes = new Map<string, Candidate[]>();
  for (const { one } of keyed) {
    const k = `${norm(one.sector)}|${partPath(one.demand)}`;
    const lane = lanes.get(k);
    if (lane) lane.push(one);
    else lanes.set(k, [one]);
  }
  const dealt: Candidate[] = [];
  const queues = [...lanes.values()];
  for (let depth = 0; dealt.length < MAX_CONSTRUCTIONS && queues.some((lane) => lane.length > depth); depth += 1) {
    for (const lane of queues) {
      if (dealt.length >= MAX_CONSTRUCTIONS) break;
      if (lane[depth]) dealt.push(lane[depth]!);
    }
  }
  return { selected: dealt, considered };
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
 * buyers are matched by `payerKey`.
 */
export const COMPOSITION_VERSION = 2;

/** One selected candidate, the digest of everything its composition reads, and the library's arrangement composed under it. */
export interface CompositionStep {
  one: Candidate;
  under: string;
  stored: ConstructedArrangement | undefined;
}

/** The candidates a pass composes, each with its composition digest and what the library already composed under it. Pure. */
export function compositionPlan(job: ConstructionJob): CompositionStep[] {
  const { priced, tiedUp, input, limits, targets, exclusions, now } = job;
  const reuse = new Map(job.reuse ?? []);
  // Everything a composition reads besides its own parts, once per pass. Fact observations only when
  // there are any, so a digest stored before they existed is still the same composition's.
  const facts = job.facts && (job.facts.unitCost.length > 0 || job.facts.volume.length > 0) ? job.facts : undefined;
  // The lever evidence and contract limits a composition reads (S-0103), likewise only when the rows state any.
  const leverEvidence = job.leverEvidence && Object.values(job.leverEvidence).some((one) => one.length > 0) ? job.leverEvidence : undefined;
  const contractLimits = job.contractLimits && job.contractLimits.length > 0 ? job.contractLimits : undefined;
  // `composition` names the composer's own version: a stored arrangement composed by an earlier one is recomposed, not reused.
  const context = digestOf({ composition: COMPOSITION_VERSION, day: now.toISOString().slice(0, 10), currency: input.currency, daysLeft: input.daysLeft, limits, targets, exclusions, priced, tiedUp, ...(facts ? { facts } : {}), ...(leverEvidence ? { leverEvidence } : {}), ...(contractLimits ? { contractLimits } : {}) });
  return selectCandidates(job).selected.map((one) => {
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
function valueSources(value: Estimate, observations: readonly Observation[]): string[] {
  const byId = new Map(observations.map((one) => [one.id, one]));
  return [...new Set(value.used.flatMap((id) => byId.get(id)?.lineage ?? [id]))].sort();
}

/** An opening's stated timing as a part's `terms`, or nothing when it states none. */
function termsOfOpening(o: CashOpportunity): { terms?: PaymentTimingReading } {
  const terms = openingTiming(o, `opening ${o.id}`);
  return terms.timing === 'UNKNOWN' ? {} : { terms };
}
function termsOfGroup(group: readonly CashOpportunity[]): { terms?: PaymentTimingReading } {
  const terms = combineTimings(group.map((o) => openingTiming(o, `opening ${o.id}`)));
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
  const readings = [demand.terms, ...related.map((o) => openingTiming(o, `opening ${o.id}`))].filter((one): one is PaymentTimingReading => !!one);
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
  const { design, demand, need, supply, input } = args;
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
  const valueObs = args.priced.filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  const riskObs = args.tiedUp.filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  // What research observed supply is paid per unit for these buyers' work, and how much one of them buys (F2).
  const unitCostObs = (args.facts?.unitCost ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  const volumeObs = (args.facts?.volume ?? []).filter(ownBuyer).map((one) => ({ ...one, broad: false }));
  const context = { payer: norm(demand.name), industry: norm(args.sector), arrangement: key };
  const captureFor = (): Parameters<typeof composeArrangement>[0]['capture'] =>
    def.capture === 'COMMISSION'
      ? { kind: 'COMMISSION', rate: unknownShare }
      : def.capture === 'FEE'
        ? { kind: 'FEE', fee: { min: 0, max: 100_000 } }
        : { kind: 'MARGIN', supplyCost: { min: 0, max: 100_000, context, material: [], observations: pooled ? [] : [...riskObs, ...unitCostObs] } };
  const base: Arrangement = {
    key: 'a',
    label: demand.name,
    period: `${input.daysLeft} days`,
    currency: input.currency,
    demand: { buyers: unknownCount(0, 10_000_000), needRate: volumeObs.length > 0 ? { min: 0, max: 400, context, material: [], observations: volumeObs } : unknownCount(0, 400), reach: unknownShare, conversion: unknownShare },
    supply: def.needsSupply ? { units: unknownCount(0, 10_000_000), acceptance: unknownShare } : undefined,
    // The arrangement itself is new, so even the same payer's price is comparable rather than direct.
    value: { min: 0, max: 1_000_000, context, material: [], observations: valueObs },
    capture: captureFor(),
    cost: { min: 0, max: 100_000 },
    pooling: pooled ? { fixedCost: { min: 0, max: 1_000_000, context, material: [], observations: riskObs }, minParticipants: unknownCount(1, 10_000), threshold: design.funding === 'THRESHOLD_PRESALE' } : undefined,
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
    for (const leaf of ['a_value', 'a_prepay_share', 'a_repeat_rate']) {
      if (!estimates[leaf] && composed.graph.nodes.some((n) => n.key === leaf)) estimates = { ...estimates, ...reconstruct(composed.graph, leaf, args.now).estimates };
    }
  } catch {
    estimates = {};
  }
  const value = estimates['a_value'];
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
        `buyers described as "${demand.name}" pay ${need ? `to deal with "${need.name}"` : 'for what they need most'}, fulfilled by ${supply ? (supply.from === 'CAPABILITY' ? `Brain producing it (${supply.name})` : `"${supply.name}"`) : 'a supplier'}, and the operation is designed as: ${shape}. ` +
        `Establish whether such buyers actually pay for this and whether ${def.needsSupply ? 'such suppliers would take the work on these terms' : 'the deliverable is what they buy'}.${why} ` +
        `For each part, find a published source: ${asks}.${established}${reliesText}${failureText}${exclusionSentence(args.exclusions)} ` +
        OPENING_SENTENCE +
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
    value: value ? { tier: value.tier, p10: value.p10, p50: value.p50, p90: value.p90, observations: value.used.length, sources: valueSources(value, valueObs) } : { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts,
    relatedOpenings: args.related.map((one) => one.id),
    question: asked,
    ...buyerTermsOf(demand, args.related),
    repeatBusiness,
    signature: arrangementSignature(design, demand, need, supply),
    inputsDigest: digestOf([
      'inputs/v1',
      arrangementSignature(design, demand, need, supply),
      [demand, need, supply].map((one) => (one ? [one.ref, one.claimId] : null)),
      args.precedent?.id ?? null,
      [...valueObs, ...riskObs].filter((one) => !one.broad).map((one) => one.id).sort(),
    ]),
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

/** The design every structure had before §82, for callers that still name a structure. */
export { defaultDesign };
