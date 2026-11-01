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
import { createHash } from 'node:crypto';
import { listNodes } from '../../repos/industry.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { statesNamedIn } from '../../domain/jurisdiction.ts';
import { APPROVAL_ENVELOPES } from '../research/approvalEnvelope.ts';
import { describesOwnAction } from '../research/actorScope.ts';
import { composeArrangement, type Part } from '../quant/mechanism.ts';
import { reconstruct } from '../quant/reconstruct.ts';
import type { CashOpportunity, IndustryNode } from '../../domain/types.ts';
import type { Estimate, Observation } from '../../domain/quant.ts';

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
}

/** At most this many arrangements are composed per goal pass (they are ranked and few are asked). */
export const MAX_CONSTRUCTIONS = 400;
/** Reverse arrangements composed per pass: one per design that best fits the goal. */
export const MAX_REVERSE = 4;

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
  const capability: Primitive | null = input.delivers.length > 0 ? { name: input.delivers.join(', '), claimId: null, from: 'CAPABILITY', ref: 'deliverables' } : null;
  const designs = allDesigns(STRUCTURE_KEYS);
  const ctx = { priced, tiedUp, input, limits, targets, exclusions, now };

  const out: ConstructedArrangement[] = [];
  // Designs outermost and defaults first, so a capped pass keeps the original
  // arrangements of every buyer before it adds any buyer's variants.
  outer: for (const design of designs) {
    const def = STRUCTURES[design.base];
    if (def.needsDeliverable && !capability) continue;
    for (const s of sectors.values()) {
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
          for (const supply of supplies) {
            if (out.length >= MAX_CONSTRUCTIONS) break outer;
            out.push(compose({ ...ctx, design, origin: transfer ? 'TRANSFER' : 'FORWARD', precedent: transfer, sector: s.name, demand, need, supply, related }));
          }
        }
      }
    }
  }
  out.push(...reverseArrangements({ ...ctx, designs, capability }));
  return rank(out, limits, targets);
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
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
}): ConstructedArrangement[] {
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
  return out.sort(
    (a, b) =>
      // Cannot lose money the goal does not have.
      exposure(a) - exposure(b) ||
      // Delivers more of what the goal's limits need.
      b.targetsMet.length - a.targetsMet.length ||
      // Rests on a design a held opening shows working.
      Number(!!b.precedent) - Number(!!a.precedent) ||
      // More of it rests on gated claims.
      b.evidenced - a.evidenced ||
      // Its value is better established.
      TIER_ORDER.indexOf(a.value.tier) - TIER_ORDER.indexOf(b.value.tier) ||
      // Fewer parts left to establish.
      a.unknownParts.length - b.unknownParts.length ||
      a.key.localeCompare(b.key),
  );
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
  input: ConstructionInput;
  limits: GoalLimits;
  targets: EconomicProperty[];
  exclusions: readonly ExclusionClass[];
  now: Date;
}): ConstructedArrangement {
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
  const composed = composeArrangement({
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
  });
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
  const facts = designFacts(design);
  const shape = describeDesign(design);
  const label = (args.origin === 'REVERSE'
    ? `Reverse: ${shape}`
    : `${demand.name}: ${shape}${supply && supply.from !== 'CAPABILITY' ? ` (${supply.name})` : ''}`).slice(0, 160);
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
        'Report an opening only where a source shows a payer, a price and a published way to reach them; ' +
        'where no source shows any buyers pay for this, say so plainly — that refutes the arrangement and is a useful answer.'
      : `Brain composed an arrangement nobody has published as an opening, and needs the world to confirm or refute it: ` +
        `buyers described as "${demand.name}" pay ${need ? `to deal with "${need.name}"` : 'for what they need most'}, fulfilled by ${supply ? (supply.from === 'CAPABILITY' ? `Brain producing it (${supply.name})` : `"${supply.name}"`) : 'a supplier'}, and the operation is designed as: ${shape}. ` +
        `Establish whether such buyers actually pay for this and whether ${def.needsSupply ? 'such suppliers would take the work on these terms' : 'the deliverable is what they buy'}.${why} ` +
        `For each part, find a published source: ${asks}.${established}${reliesText}${failureText}${exclusionSentence(args.exclusions)} ` +
        'Report an opening only where a source shows a payer, a price and a published way to reach them; ' +
        'where no source shows buyers pay for this, say so plainly — that refutes the arrangement and is a useful answer.';
  return {
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
  };
}

/** The design every structure had before §82, for callers that still name a structure. */
export { defaultDesign };
