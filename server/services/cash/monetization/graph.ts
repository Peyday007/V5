/**
 * How the possibilities on one discovery relate to each other, and the
 * sequences that fall out of it.
 *
 * ---------------------------------------------------------------------------
 * Derived, not drawn
 * ---------------------------------------------------------------------------
 *
 * §21's chain — permit intelligence, then lead generation, then supplier
 * referral, then representation, then brokerage, then a managed offering, then
 * a marketplace, then an intelligence product, then a subscription — is not a
 * picture somebody drew. Every link in it is a consequence of two declarations
 * in the method table: what a shape of transaction *produces* and what the next
 * one *requires*. So the graph is computed from the vocabulary rather than
 * stored beside it, and there is no second graph to keep in agreement with the
 * first.
 *
 * What is stored is only what a derivation could not have: an edge that is true
 * of *these two paths* rather than of their two methods — a source establishing
 * that this supplier will not deal through a broker, or a person recording that
 * one of these has to happen first here. Those arrive from
 * `monetization_path_edges` and are merged in, carrying which they are.
 *
 * ---------------------------------------------------------------------------
 * One edge REQUIRES a view of the whole subject
 * ---------------------------------------------------------------------------
 *
 * `derivedRelations` deliberately refuses to decide `REQUIRES`, because it is
 * stronger than *enables* and is a fact about every path on a subject rather
 * than about a pair: this path requires that one only where nothing else on the
 * subject produces what it needs. A pairwise function guessing it would state a
 * hard dependency from a partial view — so it is resolved here, where the whole
 * subject is in hand, and only where the producer is genuinely the only one.
 */
import { METHOD, derivedRelations } from '../../../domain/monetization.ts';
import type {
  Endowment,
  MonetizationEdgeKind,
  MonetizationPath,
  MonetizationPathEdge,
} from '../../../domain/types.ts';

export interface GraphEdge {
  fromPathId: string;
  toPathId: string;
  kind: MonetizationEdgeKind;
  /** Why this edge exists, in the words the declarations put it in. */
  rationale: string;
  /**
   * Whether the method table says this, or a row does.
   *
   * A reader has to be able to tell: *every brokerage produces data a
   * subscription needs* is a statement about shapes of transaction, and *this
   * supplier will not deal through a broker* is a statement about this
   * situation with a source on it. Rendering them alike would make a structural
   * consequence look like a finding.
   */
  source: 'DERIVED' | 'PERSON' | 'EVIDENCED';
  sourceClaimId: string | null;
}

/**
 * Every relation among the paths on one subject.
 *
 * Quadratic in the paths on a subject, which is bounded by the method table:
 * the enumeration produces at most one path per method, so this is at most
 * forty-seven squared for the most thoroughly enumerated discovery there could
 * be, computed in memory over declarations. It is not quadratic in the ledger —
 * paths on different subjects are never compared, because "instead of" and "on
 * the way to" mean nothing between a possibility about one discovery and a
 * possibility about another.
 */
export function subjectGraph(
  paths: readonly MonetizationPath[],
  recorded: readonly MonetizationPathEdge[] = [],
): GraphEdge[] {
  const out: GraphEdge[] = [];
  const seen = new Set<string>();
  const key = (from: string, to: string, kind: string): string => `${from}|${to}|${kind}`;

  /*
   * Recorded first, so a row about these two paths wins over the table's
   * statement about their two methods. A source that established something
   * specific is a stronger reading than a structural consequence, and the
   * failure mode of the other order is that the general claim hides the
   * particular one.
   */
  for (const edge of recorded) {
    out.push({
      fromPathId: edge.fromPathId,
      toPathId: edge.toPathId,
      kind: edge.kind,
      rationale: edge.rationale,
      source: edge.source,
      sourceClaimId: edge.sourceClaimId,
    });
    seen.add(key(edge.fromPathId, edge.toPathId, edge.kind));
  }

  for (const from of paths) {
    for (const to of paths) {
      if (from.id === to.id) continue;
      if (!sameSubject(from, to)) continue;
      for (const kind of derivedRelations(from.method, to.method)) {
        if (seen.has(key(from.id, to.id, kind))) continue;
        seen.add(key(from.id, to.id, kind));
        out.push({
          fromPathId: from.id,
          toPathId: to.id,
          kind,
          rationale: rationaleFor(kind, from, to),
          source: 'DERIVED',
          sourceClaimId: null,
        });
      }
    }
  }

  for (const edge of requirements(paths)) {
    if (seen.has(key(edge.fromPathId, edge.toPathId, edge.kind))) continue;
    seen.add(key(edge.fromPathId, edge.toPathId, edge.kind));
    out.push(edge);
  }

  return out;
}

function sameSubject(a: MonetizationPath, b: MonetizationPath): boolean {
  return a.opportunityId === b.opportunityId && a.industryNodeId === b.industryNodeId;
}

/**
 * The hard dependencies, resolved against the whole subject.
 *
 * For each endowment a path needs, the paths on that subject whose method
 * produces it. Exactly one producer means this path cannot start until that one
 * has; two or more means there is a choice and *enables* is the honest word;
 * none means nothing on this subject supplies it and the requirement is a
 * question rather than a dependency — which is what `requiredCapability` asks.
 */
function requirements(paths: readonly MonetizationPath[]): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const path of paths) {
    const peers = paths.filter((one) => one.id !== path.id && sameSubject(one, path));
    for (const endowment of METHOD[path.method].requires) {
      const producers = peers.filter((one) => METHOD[one.method].produces.includes(endowment));
      if (producers.length !== 1) continue;
      const only = producers[0]!;
      out.push({
        fromPathId: only.id,
        toPathId: path.id,
        kind: 'REQUIRES',
        rationale:
          `"${path.title}" needs ${readable(endowment)}, and "${only.title}" is the only ` +
          'possibility recorded on this discovery that produces it.',
        source: 'DERIVED',
        sourceClaimId: null,
      });
    }
  }
  return out;
}

function readable(endowment: Endowment): string {
  return endowment.toLowerCase().replace(/_/g, ' ');
}

function rationaleFor(
  kind: MonetizationEdgeKind,
  from: MonetizationPath,
  to: MonetizationPath,
): string {
  const a = METHOD[from.method];
  const b = METHOD[to.method];
  const shared = a.produces.filter((one) => b.requires.includes(one)).map(readable);
  switch (kind) {
    case 'ENABLES':
      return `${a.label} produces ${shared.join(' and ')}, which ${b.label} needs.`;
    case 'PRODUCES_DATA_FOR':
      return `${a.label} produces the observations ${b.label} is built on.`;
    case 'PRODUCES_RELATIONSHIPS_FOR':
      return `${a.label} produces the people ${b.label} cannot happen without.`;
    case 'STEPPING_STONE_TO':
      return (
        `${a.label} asks less of you than ${b.label} and produces something it needs, so it is ` +
        'the cheaper thing to do first.'
      );
    case 'COMPETES_WITH':
      return (
        `Both put you in the same role — ${a.role.toLowerCase()} — in the same transaction, so ` +
        'you are one of them or the other rather than both.'
      );
    case 'COEXISTS_WITH':
      return (
        `${a.label} is a ${a.role.toLowerCase()} role and ${b.label} is a ${b.role.toLowerCase()} ` +
        'one, so running one costs the other nothing.'
      );
    case 'VIABLE_ONLY_AT_SCALE_OF':
      return `${b.label} needs volume or an audience, and ${a.label} is what would produce it.`;
    case 'REQUIRES':
      return `${b.label} cannot start until ${a.label} has.`;
  }
}

export interface Sequence {
  /** The path ids in order, cheapest first. */
  pathIds: string[];
  /** What each step is, for a reader. */
  titles: string[];
  /** Why each hop exists, taken from the edge that produced it. */
  hops: string[];
}

/**
 * The chains worth looking at: what to do first, and what it opens.
 *
 * §21's whole point is that the most valuable thing is often a *sequence*
 * rather than any single possibility. A chain here is a walk along ENABLES and
 * STEPPING_STONE_TO edges, longest first, and it claims exactly what those
 * edges claim: that running the earlier one produces something the later one
 * needs. It does **not** claim the sequence is worth running, or that it pays
 * more than a single step — nothing here forms a view about value, for
 * `judgment.ts`'s reason, and the ranking above it reads facts rather than
 * shapes.
 *
 * Bounded by depth rather than by pruning, so the same ledger always produces
 * the same chains.
 */
export function sequences(
  paths: readonly MonetizationPath[],
  edges: readonly GraphEdge[],
  limits: { maxDepth?: number; maxSequences?: number; budget?: number } = {},
): Sequence[] {
  const maxDepth = limits.maxDepth ?? 5;
  const maxSequences = limits.maxSequences ?? 5;
  const byId = new Map(paths.map((one) => [one.id, one]));
  const forward = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== 'ENABLES' && edge.kind !== 'STEPPING_STONE_TO') continue;
    forward.set(edge.fromPathId, [...(forward.get(edge.fromPathId) ?? []), edge]);
  }

  const found: Sequence[] = [];
  /*
   * A step budget rather than a pruning rule.
   *
   * A thoroughly enumerated discovery carries dozens of paths and the enables
   * relation is dense between them, so walking every chain is combinatorial —
   * and this runs on a read path that a person is waiting on. The budget is
   * spent in a fixed traversal order over rows that are themselves ordered, so
   * the same ledger always produces the same chains: it is a bound on the work
   * rather than a heuristic about which chains matter, which is the difference
   * between a picture that is incomplete and one that is unstable.
   *
   * The caller may lower it, and `composeLedger` does — a ledger's total cost
   * has to be bounded by the ledger rather than by the number of discoveries
   * in it, or thirty subjects would each spend a full budget on a page one
   * person is waiting for.
   */
  let budget = limits.budget ?? 5_000;
  const walk = (at: string, chain: string[], hops: string[]): void => {
    if (budget <= 0) return;
    budget -= 1;
    if (chain.length >= maxDepth) {
      found.push(finish(chain, hops, byId));
      return;
    }
    const next = (forward.get(at) ?? []).filter((edge) => !chain.includes(edge.toPathId));
    if (next.length === 0) {
      if (chain.length > 1) found.push(finish(chain, hops, byId));
      return;
    }
    for (const edge of next) walk(edge.toPathId, [...chain, edge.toPathId], [...hops, edge.rationale]);
  };

  for (const path of paths) walk(path.id, [path.id], []);

  /*
   * Longest first, then by the order the paths were created, so two reads of an
   * unchanged ledger produce the same chains in the same order. A tie broken by
   * traversal order would make the picture move when nothing had.
   */
  return found
    .sort((a, b) => b.pathIds.length - a.pathIds.length || (a.pathIds[0]! < b.pathIds[0]! ? -1 : 1))
    .slice(0, maxSequences);
}

function finish(
  chain: string[],
  hops: string[],
  byId: Map<string, MonetizationPath>,
): Sequence {
  return {
    pathIds: [...chain],
    titles: chain.map((id) => byId.get(id)?.title ?? id),
    hops: [...hops],
  };
}
