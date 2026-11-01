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
import type { CashMechanism, CashOpportunity, IndustryNode } from '../../domain/types.ts';
import type { Estimate, Observation } from '../../domain/quant.ts';

/** The ways an arranger is paid, and what each needs to exist first. */
export const STRUCTURES = {
  PRODUCE: {
    label: 'Brain produces it and charges a fee',
    capture: 'FEE',
    needsSupply: false,
    needsDeliverable: true,
    capital: 'NONE',
    alreadyHeldAs: ['PRODUCTIZED_SERVICE', 'CAPABILITY_ARBITRAGE'],
  },
  BROKER: {
    label: 'connect the buyer with a supplier for a commission',
    capture: 'COMMISSION',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'NONE',
    alreadyHeldAs: ['SUPPLY_DEMAND_MISMATCH', 'INFORMATION_ASYMMETRY'],
  },
  REFERRAL: {
    label: 'send qualified buyers to a supplier who pays per referral',
    capture: 'FEE',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'NONE',
    alreadyHeldAs: [],
  },
  SUBCONTRACT: {
    label: 'own the buyer, pay a supplier to deliver, and keep the margin',
    capture: 'MARGIN',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'PER_DEAL',
    alreadyHeldAs: ['SUBCONTRACTED_FULFILMENT'],
  },
  POOL: {
    label: 'pool several buyers’ purchases with one supplier and keep part of the volume discount',
    capture: 'MARGIN',
    needsSupply: true,
    needsDeliverable: false,
    capital: 'PER_DEAL',
    alreadyHeldAs: ['JIGSAW_COMBINATION'],
  },
} as const satisfies Record<string, { label: string; capture: 'FEE' | 'COMMISSION' | 'MARGIN'; needsSupply: boolean; needsDeliverable: boolean; capital: 'NONE' | 'PER_DEAL'; alreadyHeldAs: readonly CashMechanism[] }>;
export type Structure = keyof typeof STRUCTURES;
export const STRUCTURE_KEYS = Object.keys(STRUCTURES) as Structure[];

/** One part of an arrangement and where it came from. */
export interface Primitive {
  name: string;
  /** A gated claim behind it, or null for a proved capability or an opening's own words. */
  claimId: string | null;
  from: 'INDUSTRY_MAP' | 'OPENING' | 'CAPABILITY';
  ref: string;
}

export interface ConstructedArrangement {
  key: string;
  structure: Structure;
  sector: string | null;
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  label: string;
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
export const MAX_CONSTRUCTIONS = 200;

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
};

export interface ConstructionInput {
  projectId: string;
  currency: string;
  /** Deliverable kinds Brain proved it can produce in this process, as people read them. */
  delivers: string[];
  /** The goal's capital ceiling, when the owner set one. */
  capitalCeilingCents: number | null;
  daysLeft: number;
  now?: Date;
}

/**
 * Compose every arrangement the project's own rows support, decompose each,
 * and rank them. Pure over the rows it reads; writes nothing.
 */
export async function constructArrangements(input: ConstructionInput): Promise<ConstructedArrangement[]> {
  const now = input.now ?? new Date();
  const nodes = (await listNodes(input.projectId)).filter((one) => !one.retiredAt);
  const byId = new Map(nodes.map((one) => [one.id, one]));
  const opportunities = (await listOpportunities({ projectId: input.projectId })).filter((one) => !one.duplicateOfId && one.state !== 'DECLINED' && one.state !== 'ARCHIVED');
  const facts = await cardFactsForProject(input.projectId);
  const evidencedPayer = new Set(facts.filter((one) => one.field === 'payer' && one.kind === 'EVIDENCE').map((one) => one.opportunityId));

  // Parts, grouped by the part of the economy they belong to.
  interface Sector { name: string | null; demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }
  const sectors = new Map<string, Sector>();
  const sector = (name: string | null): Sector => {
    const key = norm(name) || '-';
    if (!sectors.has(key)) sectors.set(key, { name, demand: [], needs: [], supply: [] });
    return sectors.get(key)!;
  };
  for (const node of nodes) {
    if (!safeName(node.name)) continue;
    const root = rootOf(node, byId);
    const p: Primitive = { name: clean(node.name), claimId: node.sourceClaimId, from: 'INDUSTRY_MAP', ref: node.id };
    if (node.kind === 'BUYER_TYPE') sector(root.name).demand.push(p);
    else if (node.kind === 'BOTTLENECK') sector(root.name).needs.push(p);
    else if (node.kind === 'FULFILMENT_SOURCE') sector(root.name).supply.push(p);
  }
  // A payer research established is a buyer population too, with what it pays for as its need.
  const byPayer = new Map<string, CashOpportunity[]>();
  for (const o of opportunities) {
    if (!o.payer || !evidencedPayer.has(o.id) || !safeName(o.payer)) continue;
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

  // Published prices the project holds, as observations about the buyers who paid them.
  const priced = opportunities
    .filter((one) => one.payer && one.priceCents && one.priceCents > 0 && one.currency === input.currency)
    .map((one): Observation => ({
      id: `opp:${one.id}`,
      value: { kind: 'POINT', value: one.priceCents! / 100 },
      context: { payer: norm(one.payer), industry: norm(one.industry), arrangement: 'held' },
      lineage: [one.sourceClaimId ? `claim:${one.sourceClaimId}` : `opp:${one.id}`],
      source: one.sourceClaimId ? { kind: 'CLAIM', ref: one.sourceClaimId } : { kind: 'CASH_OPPORTUNITY', ref: one.id },
      measures: `the price on "${one.title.slice(0, 60)}"`,
    }));
  const capability: Primitive | null = input.delivers.length > 0 ? { name: input.delivers.join(', '), claimId: null, from: 'CAPABILITY', ref: 'deliverables' } : null;

  const out: ConstructedArrangement[] = [];
  for (const s of sectors.values()) {
    for (const demand of s.demand) {
      const related = opportunities.filter((one) => norm(one.payer) === norm(demand.name));
      const heldStructures = new Set(related.map((one) => one.mechanism as string));
      const needs = s.needs.length > 0 ? s.needs : [null];
      for (const need of needs) {
        for (const structure of STRUCTURE_KEYS) {
          const def = STRUCTURES[structure];
          if (def.needsDeliverable && !capability) continue;
          // An existing opening sold the way it already is, is not a new mechanism.
          if (def.alreadyHeldAs.some((one) => heldStructures.has(one))) continue;
          const supplies = def.needsSupply ? s.supply : [capability];
          for (const supply of supplies) {
            if (out.length >= MAX_CONSTRUCTIONS) break;
            out.push(compose({ structure, sector: s.name, demand, need, supply, related, priced, input, now }));
          }
        }
      }
    }
  }
  const capitalAllowed = (input.capitalCeilingCents ?? 0) > 0;
  const tierRank = (tier: string) => ['DIRECT', 'COMPARABLE', 'COMPONENT', 'MECHANISM', 'ASSUMED', 'UNKNOWN'].indexOf(tier);
  return out.sort(
    (a, b) =>
      // Needs no money the owner has not allowed.
      Number(!capitalAllowed && STRUCTURES[a.structure].capital !== 'NONE') - Number(!capitalAllowed && STRUCTURES[b.structure].capital !== 'NONE') ||
      // More of it rests on gated claims.
      b.evidenced - a.evidenced ||
      // Its value is better established.
      tierRank(a.value.tier) - tierRank(b.value.tier) ||
      // Fewer parts left to establish.
      a.unknownParts.length - b.unknownParts.length ||
      a.key.localeCompare(b.key),
  );
}

function compose(args: {
  structure: Structure;
  sector: string | null;
  demand: Primitive;
  need: Primitive | null;
  supply: Primitive | null;
  related: CashOpportunity[];
  priced: Observation[];
  input: ConstructionInput;
  now: Date;
}): ConstructedArrangement {
  const { structure, demand, need, supply, input } = args;
  const def = STRUCTURES[structure];
  const key = keyOf([structure, demand.ref, need?.ref ?? '-', supply?.ref ?? '-']);
  const unknownCount = (min: number, max: number): Part => ({ min, max });
  const unknownShare: Part = { min: 0, max: 1 };
  // What Brain holds about what these buyers pay: the same payer is comparable
  // evidence about another thing they buy, any other payer only bounds.
  const valueObs = args.priced.map((one) => ({ ...one, broad: one.context['payer'] !== norm(demand.name) }));
  const captureFor = (): Parameters<typeof composeArrangement>[0]['capture'] =>
    def.capture === 'COMMISSION' ? { kind: 'COMMISSION', rate: unknownShare } : def.capture === 'FEE' ? { kind: 'FEE', fee: { min: 0, max: 100_000 } } : { kind: 'MARGIN', supplyCost: { min: 0, max: 100_000 } };
  const composed = composeArrangement({
    key: 'a',
    label: demand.name,
    period: `${input.daysLeft} days`,
    currency: input.currency,
    demand: { buyers: unknownCount(0, 10_000_000), needRate: unknownCount(0, 400), reach: unknownShare, conversion: unknownShare },
    supply: def.needsSupply ? { units: unknownCount(0, 10_000_000), acceptance: unknownShare } : undefined,
    // The arrangement itself is new, so even the same payer's price is comparable rather than direct.
    value: { min: 0, max: 1_000_000, context: { payer: norm(demand.name), industry: norm(args.sector), arrangement: key }, material: [], observations: valueObs },
    capture: captureFor(),
    cost: { min: 0, max: 100_000 },
  });
  let estimates: Record<string, Estimate> = {};
  try {
    estimates = reconstruct(composed.graph, composed.contribution, args.now).estimates;
  } catch {
    estimates = {};
  }
  const value = estimates['a_value'];
  const leaves = ['buyers', 'need_rate', 'conversion', 'value', def.capture === 'COMMISSION' ? 'commission' : def.capture === 'FEE' ? 'fee' : 'supply_cost', ...(def.needsSupply ? ['supply_units'] : []), 'cost'];
  const unknownParts = leaves.filter((leaf) => {
    const est = estimates[`a_${leaf}`];
    return !est || !est.distributionJustified;
  });
  const evidenced = [demand, need, supply].filter((one) => one?.claimId).length;
  const needText = need ? `to deal with "${need.name}"` : 'for what they need most';
  const supplyText = supply ? (supply.from === 'CAPABILITY' ? `Brain producing it (${supply.name})` : `"${supply.name}"`) : '';
  const label = `${demand.name}: ${def.label}${supply && supply.from !== 'CAPABILITY' ? ` (${supply.name})` : ''}`.slice(0, 160);
  const established =
    value && value.distributionJustified
      ? ` What these buyers pay is already partly established (${input.currency} ${Math.round(value.p10)}–${Math.round(value.p90)} from ${value.used.length} published figure${value.used.length === 1 ? '' : 's'}), so confirm it rather than start over.`
      : '';
  const question =
    `Brain composed an arrangement nobody has published as an opening, and needs the world to confirm or refute it: ` +
    `buyers described as "${demand.name}" pay ${needText}, fulfilled by ${supplyText || 'a supplier'}, and the operation is paid by this structure: ${def.label}. ` +
    `Establish whether such buyers actually pay for this and whether ${def.needsSupply ? 'such suppliers would take the work on these terms' : 'the deliverable is what they buy'}. ` +
    `For each part, find a published source: ${unknownParts.map((part) => PART_ASK[part]).filter(Boolean).join('; ')}.${established} ` +
    'Report an opening only where a source shows a payer, a price and a published way to reach them; ' +
    'where no source shows buyers pay for this, say so plainly — that refutes the arrangement and is a useful answer.';
  return {
    key,
    structure,
    sector: args.sector,
    demand,
    need,
    supply,
    label,
    evidenced,
    value: value ? { tier: value.tier, p10: value.p10, p50: value.p50, p90: value.p90, observations: value.used.length } : { tier: 'UNKNOWN', p10: 0, p50: 0, p90: 0, observations: 0 },
    unknownParts,
    relatedOpenings: args.related.map((one) => one.id),
    question,
  };
}

