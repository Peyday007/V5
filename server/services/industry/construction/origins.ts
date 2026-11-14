/**
 * The open opportunity field: where a commercial possibility can come from
 * (OPP-03, ARCH-01; §82, §92, §93, §105; invariants 47 and 48).
 *
 * Brain's population of possibilities is not the stock of arrangements it has
 * already modelled. Exploration may start from any of five origins, and every
 * candidate seed is stamped with exactly one of them and with the rows it came
 * from, so "why is this in the field" always resolves to a record:
 *
 * - MEMORY — what Brain already holds: remembered research, businesses,
 *   contacts, suppliers, customer needs, strategies and past transactions (the
 *   industry map and the openings it has acted on).
 * - WORLD — activity newly observed outside Brain's own database: an opening a
 *   research claim reported from a public source and nobody has acted on yet.
 * - FIRST_PRINCIPLES — an economic structure inferred backward from a goal: a
 *   live goal with a target is decomposed into the transaction it needs, with
 *   no presumption of the industry that will supply it.
 * - RECOMBINATION — useful pieces of prior businesses, including unsuccessful
 *   ones: a declined or archived opening is a source of parts, never a verdict
 *   on the parts (§65: a dead end is a watch, not a verdict).
 * - CONSTRAINT — discovered constraints, surprises, inefficiencies, unmet demand
 *   and unused supply: a recorded `OpportunityConstraint` is itself a reason a
 *   different arrangement may exist.
 *
 * Deliberately absent: any list of admissible categories, industries or
 * mechanisms. B2C, B2B, AI-delivered services, brokered physical services
 * performed by independent people, logistics, consulting, reselling and
 * mechanisms nobody has a name for yet all pass through the same functions;
 * the examples in the specification are examples and none is preferred.
 *
 * Market preference is a function of economics and of how much of the
 * execution can be controlled remotely. The owner's location is not an input:
 * `rankMarkets` takes a context that may carry it precisely so that a test can
 * prove it changes nothing. In production it orders the subjects of Brain's
 * industry map before a goal's search takes its industry angles from them
 * (`rankSubjectMarkets`, called by `cash/discovery.ts` `openGoalDiscovery`),
 * each scored from its own evidence: the construction engine's unit facts
 * and the role sets of its flows (`marketOfEvidence`).
 *
 * No table, scheduler or store: the origin travels in the seed itself, and the
 * seeds are derived from rows the existing repositories already serve.
 */
import { listNodes, listConstraintsForProject } from '../../../repos/industry.ts';
import { listOpportunities } from '../../../repos/cashPortfolio.ts';
import { listWorkstreams } from '../../../repos/register.ts';
import { listProjects } from '../../../repos/projects.ts';
import type { CashOpportunity, IndustryNode, OpportunityConstraint } from '../../../domain/types.ts';
import type { Workstream } from '../../../domain/register.ts';
import type { FactKey, IndustryEvidence } from '../../../domain/construction.ts';
import { resolveFact } from './model.ts';
import type { FlowRoles } from './roles.ts';

export const OPPORTUNITY_ORIGINS = ['MEMORY', 'WORLD', 'FIRST_PRINCIPLES', 'RECOMBINATION', 'CONSTRAINT'] as const;
export type OpportunityOrigin = (typeof OPPORTUNITY_ORIGINS)[number];

/** A row a seed was derived from. */
export interface SourceRef {
  table: 'industry_nodes' | 'cash_opportunities' | 'workstreams' | 'opportunity_constraints' | 'research_claims';
  id: string;
}

export interface OpportunitySeed {
  /** Stable for the same origin and sources, so the field can be diffed between reads. */
  key: string;
  origin: OpportunityOrigin;
  /** What to explore, in words a researcher can act on. */
  prompt: string;
  /** Free text as the record states it; never checked against a list. */
  category: string | null;
  sources: SourceRef[];
}

/** Only the fields a seed reads, so the functions stay pure and testable on plain rows. */
export type OpportunityRow = Pick<CashOpportunity, 'id' | 'title' | 'industry' | 'mechanism' | 'state' | 'source' | 'sourceClaimId'>;
export type NodeRow = Pick<IndustryNode, 'id' | 'kind' | 'name' | 'description' | 'retiredAt'>;
export type ConstraintRow = Pick<OpportunityConstraint, 'id' | 'kind' | 'statement' | 'effect' | 'opportunityId' | 'nodeId' | 'sourceClaimId'>;
export type GoalRow = Pick<Workstream, 'id' | 'title' | 'intent' | 'outcome' | 'archivedAt' | 'cancelledAt' | 'pausedAt' | 'target'>;

/** States in which Brain has acted on an opening: remembered transactions and businesses. */
const ACTED_ON: ReadonlySet<string> = new Set(['READY', 'EXECUTING', 'DELIVERING', 'COLLECTED']);
/** Not yet acted on: what the world reported and Brain has only observed. */
const OBSERVED: ReadonlySet<string> = new Set(['DISCOVERED', 'EVIDENCE_CARD']);
/** Prior businesses that did not go ahead — kept as parts, never discarded (invariant 47). */
const UNSUCCESSFUL: ReadonlySet<string> = new Set(['DECLINED', 'ARCHIVED']);

function seed(origin: OpportunityOrigin, prompt: string, category: string | null, sources: SourceRef[]): OpportunitySeed {
  const key = `${origin}:${sources.map((s) => `${s.table}/${s.id}`).sort().join('+')}`;
  return { key, origin, prompt, category, sources };
}

function claimRef(id: string | null): SourceRef[] {
  return id ? [{ table: 'research_claims', id }] : [];
}

/** MEMORY: the map Brain holds and the openings it has acted on. */
export function seedsFromMemory(nodes: NodeRow[], opportunities: OpportunityRow[]): OpportunitySeed[] {
  const out: OpportunitySeed[] = [];
  for (const n of nodes) {
    if (n.retiredAt) continue;
    out.push(seed('MEMORY', `Remembered ${n.kind.toLowerCase().replace(/_/g, ' ')} "${n.name}": which roles around it are not yet represented?`, n.name, [{ table: 'industry_nodes', id: n.id }]));
  }
  for (const o of opportunities) {
    if (!ACTED_ON.has(o.state)) continue;
    out.push(seed('MEMORY', `Past transaction "${o.title}": what adjacent buyer, supplier or position does it make reachable?`, o.industry, [{ table: 'cash_opportunities', id: o.id }, ...claimRef(o.sourceClaimId)]));
  }
  return out;
}

/** WORLD: openings observed outside Brain's own database and not yet acted on. */
export function seedsFromWorld(opportunities: OpportunityRow[]): OpportunitySeed[] {
  return opportunities
    .filter((o) => OBSERVED.has(o.state) && (o.sourceClaimId !== null || o.source !== null))
    .map((o) => seed('WORLD', `Newly observed: "${o.title}" — who pays, and which position could Brain occupy?`, o.industry, [{ table: 'cash_opportunities', id: o.id }, ...claimRef(o.sourceClaimId)]));
}

/** FIRST_PRINCIPLES: a live goal with a target, reasoned backward into the transaction it needs. */
export function seedsFromFirstPrinciples(goals: GoalRow[]): OpportunitySeed[] {
  return goals
    .filter((g) => !g.archivedAt && !g.cancelledAt && !g.pausedAt && g.target !== null)
    .map((g) =>
      seed(
        'FIRST_PRINCIPLES',
        `Backward from goal "${g.title}"${g.outcome ? ` (${g.outcome})` : ''}: what transaction, at what price and volume, produces it — in any industry?`,
        null,
        [{ table: 'workstreams', id: g.id }],
      ),
    );
}

/**
 * RECOMBINATION: pairs of pieces from prior businesses, at least one of which
 * did not go ahead. The unsuccessful one contributes its buyer, mechanism or
 * category; the other contributes what worked. Bounded by `limit` so a large
 * archive cannot make the field quadratic.
 */
export function seedsFromRecombination(opportunities: OpportunityRow[], limit = 200): OpportunitySeed[] {
  const failed = opportunities.filter((o) => UNSUCCESSFUL.has(o.state));
  const out: OpportunitySeed[] = [];
  for (const f of failed) {
    for (const o of opportunities) {
      if (out.length >= limit) return out;
      if (o.id === f.id) continue;
      // Only one ordering of a pair of two failures.
      if (UNSUCCESSFUL.has(o.state) && o.id < f.id) continue;
      if (o.mechanism === f.mechanism && o.industry === f.industry) continue;
      out.push(
        seed(
          'RECOMBINATION',
          `Recombine "${f.title}" (${f.state.toLowerCase()}: ${f.mechanism}) with "${o.title}" (${o.mechanism}${o.industry ? `, ${o.industry}` : ''}): which piece of each survives in a new arrangement?`,
          [f.industry, o.industry].filter(Boolean).join(' × ') || null,
          [{ table: 'cash_opportunities', id: f.id }, { table: 'cash_opportunities', id: o.id }],
        ),
      );
    }
  }
  return out;
}

/** CONSTRAINT: each recorded constraint, surprise or inefficiency as a reason another arrangement may exist. */
export function seedsFromConstraints(constraints: ConstraintRow[]): OpportunitySeed[] {
  return constraints.map((c) => {
    const sources: SourceRef[] = [{ table: 'opportunity_constraints', id: c.id }];
    if (c.opportunityId) sources.push({ table: 'cash_opportunities', id: c.opportunityId });
    if (c.nodeId) sources.push({ table: 'industry_nodes', id: c.nodeId });
    sources.push(...claimRef(c.sourceClaimId));
    return seed('CONSTRAINT', `Constraint ${c.kind}: "${c.statement}"${c.effect ? ` (${c.effect})` : ''} — who is underserved by it, and what arrangement removes or exploits it?`, null, sources);
  });
}

export interface FieldInput {
  nodes: NodeRow[];
  opportunities: OpportunityRow[];
  goals: GoalRow[];
  constraints: ConstraintRow[];
}

/** The whole field: every origin, de-duplicated by key, no filter by category. */
export function opportunityField(input: FieldInput): OpportunitySeed[] {
  const all = [
    ...seedsFromMemory(input.nodes, input.opportunities),
    ...seedsFromWorld(input.opportunities),
    ...seedsFromFirstPrinciples(input.goals),
    ...seedsFromRecombination(input.opportunities),
    ...seedsFromConstraints(input.constraints),
  ];
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

export function countByOrigin(seeds: OpportunitySeed[]): Record<OpportunityOrigin, number> {
  const counts = Object.fromEntries(OPPORTUNITY_ORIGINS.map((o) => [o, 0])) as Record<OpportunityOrigin, number>;
  for (const s of seeds) counts[s.origin] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Market preference: economics and remote control, never the owner's location.
// ---------------------------------------------------------------------------

export interface MarketCandidate {
  key: string;
  geography: string | null;
  /** Expected contribution per transaction in dollars; null when unknown. */
  marginUsd: number | null;
  /** Transactions per month the market can plausibly supply; null when unknown. */
  monthlyVolume: number | null;
  /** Days from start to the first collected dollar; null when unknown. */
  daysToCash: number | null;
  /** Share 0..1 of the execution Brain can control without anyone being physically present. */
  remoteControl: number;
}

/**
 * Context a caller may hold while ranking. `ownerLocation` is accepted and
 * deliberately not read: a market is preferred for its economics and for how
 * remotely it can be run (OPP-03), and a test proves the order is invariant.
 */
export interface RankingContext {
  ownerLocation?: string | null;
}

/**
 * An unknown is never a favourable assumption (invariant 39): an unknown
 * margin or volume scores zero, an unknown time to cash takes the worst
 * bounded value.
 */
export function marketScore(m: MarketCandidate): number {
  const monthly = Math.max(0, m.marginUsd ?? 0) * Math.max(0, m.monthlyVolume ?? 0);
  const days = m.daysToCash === null ? 365 : Math.max(1, m.daysToCash);
  const remote = Math.min(1, Math.max(0, m.remoteControl));
  return (monthly / Math.sqrt(days)) * remote;
}

export function rankMarkets(markets: MarketCandidate[], _context: RankingContext = {}): MarketCandidate[] {
  return [...markets].sort((a, b) => marketScore(b) - marketScore(a) || a.key.localeCompare(b.key));
}

/** The bound of a fact the evidence states for a segment (or market-wide), or null when nothing states it. */
function bound(e: IndustryEvidence, key: FactKey, segment: string | null, side: 'low' | 'high'): number | null {
  const f = resolveFact(e.facts, key, segment);
  if (f.status === 'UNKNOWN') return null;
  const v = side === 'low' ? f.low : f.high;
  return Number.isFinite(v) ? v : null;
}

/**
 * One subject of the map as a market, read from its evidence and the role sets
 * of its flows. Each flow is read at its own paying segment, and the subject is
 * its best flow by `marketScore`. Every figure takes its unfavourable bound and
 * an unstated one is null (invariant 39): the margin is the best low per-unit
 * value a role Brain is not refused from can capture; the volume is units per
 * account per month times reachable accounts, both at their low bounds; the
 * time to cash is the sales cycle plus the buyer's payment days, both at their
 * high bounds; remote control is the share of those roles Brain could run
 * without anyone on site. Nothing here reads a place, the owner's or any
 * other. Pure.
 */
export function marketOfEvidence(key: string, evidence: IndustryEvidence, sets: readonly FlowRoles[]): MarketCandidate {
  const none: MarketCandidate = { key, geography: evidence.geography, marginUsd: null, monthlyVolume: null, daysToCash: null, remoteControl: 0 };
  let best = none;
  for (const set of sets) {
    const roles = set.roles.filter((role) => role.occupiable.answer !== 'NO');
    if (roles.length === 0) continue;
    const values = roles.map((role) => role.controlValue.lowUsdPerUnit).filter((v): v is number => v !== null && Number.isFinite(v));
    const perAccount = bound(evidence, 'account_units_per_month', set.segmentId, 'low');
    const accounts = bound(evidence, 'accounts_reachable', set.segmentId, 'low');
    const cycle = bound(evidence, 'sales_cycle_days', set.segmentId, 'high');
    const payment = bound(evidence, 'buyer_payment_days', set.segmentId, 'high');
    const one: MarketCandidate = {
      key,
      geography: evidence.geography,
      marginUsd: values.length > 0 ? Math.max(...values) : null,
      monthlyVolume: perAccount !== null && accounts !== null ? perAccount * accounts : null,
      daysToCash: cycle !== null && payment !== null ? cycle + payment : null,
      remoteControl: roles.filter((role) => role.remotelyOperable).length / roles.length,
    };
    if (best === none || marketScore(one) > marketScore(best)) best = one;
  }
  return best;
}

/** A node and everything recorded beneath it. Pure. */
function subtreeOf(nodes: readonly IndustryNode[], rootId: string): IndustryNode[] {
  const keep = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) if (n.parentId && keep.has(n.parentId) && !keep.has(n.id)) { keep.add(n.id); grew = true; }
  }
  return nodes.filter((n) => keep.has(n.id));
}

/**
 * The map's live subjects in market order: each node with its subtree is
 * assembled into evidence exactly as the construction engine reads a subject
 * (`evidenceFromMap` → `assembleEvidence` → `commercialRoles`), scored by
 * `marketOfEvidence`, and ordered by `rankMarkets`. Subjects that score the
 * same keep the order the rows gave them. No owner location is read or
 * accepted. Reads nothing beyond its arguments.
 */
export async function rankSubjectMarkets(nodes: readonly IndustryNode[], constraints: readonly OpportunityConstraint[]): Promise<{ node: IndustryNode; market: MarketCandidate }[]> {
  const { assembleEvidence, evidenceFromMap } = await import('./service.ts');
  const { commercialRoles } = await import('./roles.ts');
  const live = nodes.filter((n) => !n.retiredAt);
  const width = String(live.length).length;
  const byKey = new Map<string, { node: IndustryNode; market: MarketCandidate }>();
  live.forEach((node, index) => {
    const map = evidenceFromMap(subtreeOf(live, node.id), [...constraints]);
    const evidence = assembleEvidence({ text: node.name, industry: node.name, geography: null, map, recorded: [] });
    // The key carries the row order, so a tie keeps it rather than falling back to an id.
    const key = `${String(index).padStart(width, '0')}:${node.id}`;
    byKey.set(key, { node, market: marketOfEvidence(key, evidence, commercialRoles(evidence)) });
  });
  return rankMarkets([...byKey.values()].map((one) => one.market)).map((m) => byKey.get(m.key)!);
}

// ---------------------------------------------------------------------------
// The probe reader (r01.opp-03): read-only, on production rows.
// ---------------------------------------------------------------------------

export interface FieldReport {
  ok: boolean;
  detail: string;
  projects: number;
  counts: Record<OpportunityOrigin, number>;
  categories: number;
}

/**
 * Reads every project's rows through the existing repositories and reports
 * how many seeds each origin produces. Writes nothing. Holds when every origin
 * is implemented and the field is non-empty; an origin with zero seeds is
 * named, because "there is nothing to recombine yet" is a fact about the rows
 * and not a defect in the field.
 */
export async function opportunityFieldHoldsOnRows(): Promise<FieldReport> {
  const projects = await listProjects();
  const counts = countByOrigin([]);
  const categories = new Set<string>();
  for (const p of projects) {
    /*
     * The field is built exactly as a goal's discovery round builds it
     * (`openGoalDiscovery`): the project's rows, with its goals fed in, so a
     * FIRST_PRINCIPLES seed counted here is one a production round is asked
     * from — not a count kept beside a field that never saw the goals.
     */
    const [nodes, opportunities, constraints, listed] = await Promise.all([
      listNodes(p.id),
      listOpportunities({ projectId: p.id }),
      listConstraintsForProject(p.id),
      listWorkstreams({ projectIds: [p.id] }),
    ]);
    // A Brain-wide workstream is listed beside every project's own; it is no project's goal round.
    const goals = listed.filter((g) => g.projectId === p.id);
    const field = opportunityField({ nodes, opportunities, goals, constraints });
    for (const s of field) {
      counts[s.origin] += 1;
      if (s.category) categories.add(s.category);
    }
  }
  const total = OPPORTUNITY_ORIGINS.reduce((n, o) => n + counts[o], 0);
  const empty = OPPORTUNITY_ORIGINS.filter((o) => counts[o] === 0);
  const detail =
    `${total} seed(s) across ${projects.length} project(s): ` +
    OPPORTUNITY_ORIGINS.map((o) => `${o}=${counts[o]}`).join(', ') +
    `; ${categories.size} distinct categories, none filtered` +
    (empty.length ? `; no rows yet for ${empty.join(', ')}` : '');
  return { ok: total > 0, detail, projects: projects.length, counts, categories: categories.size };
}
