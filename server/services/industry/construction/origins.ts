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
 * prove it changes nothing.
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
  const goals = await listWorkstreams({ projectIds: projects.map((p) => p.id) });
  const firstPrinciples = seedsFromFirstPrinciples(goals);
  for (const s of firstPrinciples) counts[s.origin] += 1;
  for (const p of projects) {
    const [nodes, opportunities, constraints] = await Promise.all([
      listNodes(p.id),
      listOpportunities({ projectId: p.id }),
      listConstraintsForProject(p.id),
    ]);
    const field = opportunityField({ nodes, opportunities, goals: [], constraints });
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
