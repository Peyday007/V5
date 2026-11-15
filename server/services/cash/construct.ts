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
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { composeArrangement, type Arrangement, type Levers, type Part } from '../quant/mechanism.ts';
import { leverageOfYielding, type ArrangementLeverage, type LeverageConstraints } from '../quant/leverage.ts';
import { reconstruct } from '../quant/reconstruct.ts';
import { emptyLeverEvidence, leverEvidenceFrom, type LeverEvidence, type LeverPart } from '../quant/leverEvidence.ts';
import { claimSources } from '../../repos/research.ts';
import type { CashOpportunity, IndustryNode } from '../../domain/types.ts';
import type { Estimate, Observation } from '../../domain/quant.ts';
import { repeatBusinessObservations } from './deliverables/realization.ts';

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

export { STRUCTURES, STRUCTURE_KEYS, type Structure } from './properties.ts';

/** One part of an arrangement and where it came from. */
export interface Primitive {
  name: string;
  /** A gated claim behind it, or null for a proved capability, an opening's own words, or a part reverse construction asks the world for. */
  claimId: string | null;
  from: 'INDUSTRY_MAP' | 'OPENING' | 'CAPABILITY' | 'REVERSE';
  ref: string;
}

/**
 * How an arrangement came to be composed (§82):
 *   FORWARD  — from parts the project holds, in their own part of the economy;
 *   TRANSFER — a design a held opening shows working, carried to a different buyer;
 *   REVERSE  — a design chosen for the properties the goal needs, whose buyers,
 *              need and supply the world is asked to supply.
 */
export type ConstructionOrigin = 'FORWARD' | 'TRANSFER' | 'REVERSE';

export interface ConstructedArrangement {
  key: string;
  structure: Structure;
  /** The transaction design: who fulfils, who pays, how buyers aggregate, when money moves, what recurs. */
  design: Design;
  origin: ConstructionOrigin;
  /** A held opening whose evidenced design this one transfers, for TRANSFER. */
  precedent: { opportunityId: string; title: string } | null;
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
  value: Pick<Estimate, 'tier' | 'p10' | 'p50' | 'p90'> & { observations: number };
  /** Parts nothing establishes yet: what the research round asks. */
  unknownParts: string[];
  /** Openings sharing this buyer, for the novelty check and the value evidence. */
  relatedOpenings: string[];
  question: string;
  /**
   * Repeat business this buyer population has already given Brain, read from
   * aftercare records (`deliverables/realization.ts`): how many stated values,
   * and their sum. Absent or zero is unknown, never "will not return" (LIFE-29-2).
   */
  repeatBusiness?: { observations: number; statedValueCents: number };
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
  const evidencedCapture = new Set(facts.filter((one) => one.field === 'captureMechanism' && one.kind === 'EVIDENCE').map((one) => one.opportunityId));
  const allowed = (text: string | null | undefined) => !excludedBy(text, exclusions);

  // Parts, grouped by the part of the economy they belong to.
  interface Sector { name: string | null; demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }
  const sectors = new Map<string, Sector>();
  const sector = (name: string | null): Sector => {
    const key = norm(name) || '-';
    if (!sectors.has(key)) sectors.set(key, { name, demand: [], needs: [], supply: [] });
    return sectors.get(key)!;
  };
  for (const node of nodes) {
    if (!safeName(node.name) || !allowed(node.name)) continue;
    const root = rootOf(node, byId);
    if (!allowed(root.name)) continue;
    const p: Primitive = { name: clean(node.name), claimId: node.sourceClaimId, from: 'INDUSTRY_MAP', ref: node.id };
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
    if (!s.demand.some((one) => norm(one.name) === norm(first.payer))) s.demand.push({ name: clean(first.payer!), claimId: first.sourceClaimId, from: 'OPENING', ref: first.id });
    const need = first.offerScope ?? first.title;
    if (safeName(need)) s.needs.push({ name: clean(need), claimId: first.sourceClaimId, from: 'OPENING', ref: first.id });
  }

  /*
   * Designs held openings show working, by structure: an opening whose payer
   * and way of being paid a gated claim established is a published precedent
   * for that design. Carried to a different buyer it is a transfer — the
   * causal economics, not the business.
   */
  const precedentByBase = new Map<Structure, CashOpportunity>();
  for (const o of opportunities) {
    if (!evidencedPayer.has(o.id) || !evidencedCapture.has(o.id) || !allowed(o.title)) continue;
    for (const base of STRUCTURE_KEYS) {
      if ((STRUCTURES[base].alreadyHeldAs as readonly string[]).includes(o.mechanism) && !precedentByBase.has(base)) precedentByBase.set(base, o);
    }
  }

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
  /*
   * What the project's rows say about each lever's own parts (S-0103): buyer
   * prepayment willingness, refund obligations, when funds are usable, a
   * supplier's capacity, failures and payment terms, AI labor's cost and
   * throughput, and when buyers settle — read from the EVIDENCE card facts
   * research filed and the openings' published payment terms, so an answer to
   * the prepayment question construction asks changes the next reading.
   */
  const leverFacts = facts.filter((one) => one.kind === 'EVIDENCE');
  const leverSources = await claimSources([
    ...leverFacts.map((one) => one.claimId),
    ...opportunities.map((one) => one.sourceClaimId),
  ].filter((one): one is string => !!one));
  const leverEvidence = leverEvidenceFrom({
    opportunities: opportunities.filter((one) => allowed(one.title)),
    facts: leverFacts,
    sources: leverSources,
    currency: input.currency,
    periodDays: input.daysLeft,
  });
  const capability: Primitive | null = input.delivers.length > 0 ? { name: input.delivers.join(', '), claimId: null, from: 'CAPABILITY', ref: 'deliverables' } : null;
  /*
   * The same inputs construct the same arrangements, so a plan re-read whose map, openings,
   * facts and limits did not move reuses the last construction instead of composing up to
   * MAX_CONSTRUCTIONS designs again (production, 2026-11-14: ~11 s of quant CPU a minute on
   * the main thread, most of it identical re-construction, and the garbage it left behind).
   * Keyed by the day, as the reconstructions' recency is.
   */
  const constraints = await leverageConstraints(input, limits);
  const memoKey = createHash('sha256')
    .update(JSON.stringify({ day: now.toISOString().slice(0, 10), input: { ...input, now: undefined, limits: undefined }, limits, targets, exclusions, sectors: [...sectors.values()], precedent: [...precedentByBase.entries()].map(([k, o]) => [k, o.id]), priced, tiedUp, leverEvidence, constraints, openings: opportunities.map((o) => [o.id, o.payer, o.mechanism, o.state, o.updatedAt]) }))
    .digest('hex');
  const held = constructionMemo.get(memoKey);
  if (held && Date.now() - held.at < CONSTRUCTION_MEMO_MS) return structuredClone(held.result);
  const job: ConstructionJob = { sectors: [...sectors.values()], opportunities, precedent: [...precedentByBase.entries()], capability, priced, tiedUp, leverEvidence, input, limits, targets, exclusions, now, constraints };
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
  const { sharedEvaluator } = await import('../goals/reasoning/evaluatorPool.ts');
  const evaluator = sharedEvaluator();
  try {
    ranked = evaluator.construct ? await evaluator.construct(job) : await composeConstruction(job, YIELD_EVERY_MS);
  } finally {
    await evaluator.close();
  }
  constructionMemo.set(memoKey, { at: Date.now(), result: structuredClone(ranked) });
  while (constructionMemo.size > CONSTRUCTION_MEMO_MAX) constructionMemo.delete(constructionMemo.keys().next().value!);
  return ranked;
}

/**
 * The real limits a constructed arrangement's leverage is judged against
 * (S-0103), in the goal's currency: the cash the ledger says may be deployed
 * now (`cashPosition`, invariant 37), and the money a person authorised —
 * what the live cash authority leaves uncommitted, or the goal's capital
 * ceiling, whichever is smaller. A contract limit is null: a constructed
 * arrangement has no contract yet. Whatever cannot be read is null — unknown,
 * never unlimited — and nothing here is a revenue ceiling.
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
  /** What the rows state about each lever's own parts; absent reads as nothing stated. */
  leverEvidence?: LeverEvidence;
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
  /** The real limits leverage is judged against, read from the ledger and the live authority; absent is unknown. */
  constraints?: LeverageConstraints;
}

/**
 * Compose, stress and rank every arrangement a job's parts support. Pure: the
 * same job gives the same arrangements on any thread. `yieldEveryMs` hands the
 * loop back between designs when it runs on the server's own thread.
 */
export async function composeConstruction(job: ConstructionJob, yieldEveryMs: number | null = null): Promise<ConstructedArrangement[]> {
  const { opportunities, capability, priced, tiedUp, input, limits, targets, exclusions, now } = job;
  const precedentByBase = new Map(job.precedent);
  const designs = allDesigns(STRUCTURE_KEYS);
  const ctx = { priced, tiedUp, leverEvidence: job.leverEvidence ?? emptyLeverEvidence(), input, limits, targets, exclusions, now };
  const out: ConstructedArrangement[] = [];
  const levered = new Map<ConstructedArrangement, Arrangement>();
  const keep = (built: { arrangement: ConstructedArrangement; levered: Arrangement }) => {
    levered.set(built.arrangement, built.levered);
    return built.arrangement;
  };
  let lastYield = Date.now();
  const breathe = async (): Promise<void> => {
    if (yieldEveryMs === null || Date.now() - lastYield < yieldEveryMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastYield = Date.now();
  };
  // Designs outermost and defaults first, so a capped pass keeps the original
  // arrangements of every buyer before it adds any buyer's variants.
  outer: for (const design of designs) {
    const def = STRUCTURES[design.base];
    if (def.needsDeliverable && !capability) continue;
    for (const s of job.sectors) {
      for (const demand of s.demand) {
        const related = opportunities.filter((one) => norm(one.payer) === norm(demand.name));
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
          if (!def.needsSupply && need && breaksOperatingModel(operatingFit({ title: need.name }))) continue;
          for (const supply of supplies) {
            if (out.length >= MAX_CONSTRUCTIONS) break outer;
            await breathe();
            out.push(keep(compose({ ...ctx, design, origin: transfer ? 'TRANSFER' : 'FORWARD', precedent: transfer, sector: s.name, demand, need, supply, related })));
          }
        }
      }
    }
  }
  out.push(...reverseArrangements({ ...ctx, designs, capability }).map(keep));
  const ranked = rank(out, limits, targets);
  return traceLeverageOnTop(ranked, levered, job.constraints ?? {}, limits, targets, now, breathe);
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
    try {
      leverage = await leverageOfYielding(a, constraints, breathe, { now });
    } catch {
      continue;
    }
    one.leverage = leverage;
    if (leverage.refused && one.stress.exposure !== 'EXCEEDS') {
      one.stress = { ...one.stress, exposure: 'EXCEEDS' };
      changed = true;
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

/** How long an unchanged construction is reused, and how many distinct ones are held. */
export const CONSTRUCTION_MEMO_MS = 30 * 60_000;
const CONSTRUCTION_MEMO_MAX = 8;
const constructionMemo = new Map<string, { at: number; result: ConstructedArrangement[] }>();
/** For tests: forget held constructions. */
export function clearConstructionMemo(): void {
  constructionMemo.clear();
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
  leverEvidence: LeverEvidence;
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
  leverEvidence: LeverEvidence;
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
  // What Brain holds about what these buyers pay: the same payer is comparable
  // evidence about another thing they buy, any other payer only bounds.
  const valueObs = args.priced.map((one) => ({ ...one, broad: one.context['payer'] !== norm(demand.name) }));
  const riskObs = args.tiedUp.map((one) => ({ ...one, broad: one.context['payer'] !== norm(demand.name) }));
  const context = { payer: norm(demand.name), industry: norm(args.sector), arrangement: key };
  const captureFor = (): Parameters<typeof composeArrangement>[0]['capture'] =>
    def.capture === 'COMMISSION'
      ? { kind: 'COMMISSION', rate: unknownShare }
      : def.capture === 'FEE'
        ? { kind: 'FEE', fee: { min: 0, max: 100_000 } }
        : { kind: 'MARGIN', supplyCost: { min: 0, max: 100_000, context, material: [], observations: pooled ? [] : riskObs } };
  const base: Arrangement = {
    key: 'a',
    label: demand.name,
    period: `${input.daysLeft} days`,
    currency: input.currency,
    demand: { buyers: unknownCount(0, 10_000_000), needRate: unknownCount(0, 400), reach: unknownShare, conversion: unknownShare },
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
  const levers = designLevers(design, facts.fulfiller, leverPartsFor(args.leverEvidence, demand.name));
  const levered: Arrangement = { ...base, levers };
  let estimates: Record<string, Estimate> = {};
  try {
    estimates = reconstruct(composed.graph, composed.contribution, args.now).estimates;
    if (composed.exposure) estimates = { ...reconstruct(composed.graph, composed.exposure, args.now).estimates, ...estimates };
    for (const leaf of ['a_prepay_share', 'a_repeat_rate']) {
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
  const repeatObs = args.priced.filter((one) => one.context['arrangement'] === 'repeat' && one.context['payer'] === norm(demand.name));
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
    ? ` The same design is shown working for a different buyer ("${args.precedent.title.slice(0, 80)}"), so ask whether these buyers would pay for it the same way.`
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
  const arrangement: ConstructedArrangement = {
    key,
    structure,
    design,
    origin: args.origin,
    precedent: args.precedent ? { opportunityId: args.precedent.id, title: args.precedent.title } : null,
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
    value: value ? { tier: value.tier, p10: value.p10, p50: value.p50, p90: value.p90, observations: value.used.length } : { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts,
    relatedOpenings: args.related.map((one) => one.id),
    question,
    repeatBusiness,
  };
  return { arrangement, levered };
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
