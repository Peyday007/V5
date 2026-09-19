/**
 * The industry map as Brain can currently read it, and how far it has got with
 * each subject.
 *
 * ---------------------------------------------------------------------------
 * Coverage is derived, and that is the whole design
 * ---------------------------------------------------------------------------
 *
 * There is no coverage column, no depth score and no "how well do we know this"
 * number in the schema. Every one of them is a fact about rows that change
 * underneath it: a round settles, a claim is accepted, an opening is harvested,
 * and a stored reading is wrong from that instant until something remembers to
 * recompute it. `tier.ts` makes the same argument about an opportunity's tier
 * and `placements` made it first about a disposition — a row is not a decision.
 *
 * What the schema *does* store is the two things no derivation could recover:
 * that a person seeded a subject rather than Brain finding it, and that a
 * person decided a path was not worth following. Both are decisions, and
 * decisions are exactly what cannot be re-derived from evidence.
 *
 * ---------------------------------------------------------------------------
 * A snapshot, read once
 * ---------------------------------------------------------------------------
 *
 * `allocate.ts` is a pure function and this is what it is pure over, kept apart
 * for `services/dispatch/router.ts`' reason: "why did Brain research that" has
 * to be answerable from a recorded input rather than from a re-run against a
 * database that has moved on.
 */
import { listNodes, listIndustryRounds } from '../../repos/industry.ts';
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { listConstraintsForProject } from '../../repos/industry.ts';
import { depthOf, kindRecurses, pathOf } from '../../domain/industry.ts';
import type {
  CashOpportunity,
  IndustryNode,
  IndustryRound,
  OpportunityConstraint,
} from '../../domain/types.ts';

/**
 * How far Brain has got with one subject, entirely from rows.
 *
 * Every field here is a count or a timestamp. There is deliberately nothing
 * that reads as a judgement — no score, no confidence, no "promising" — because
 * the judgement belongs to `verdict.ts`, which composes it from these and shows
 * its working. A reading that already contained an opinion would make the
 * verdict unfalsifiable.
 */
export interface NodeCoverage {
  node: IndustryNode;
  /** Root-first, so a question about it can say what it is actually about. */
  path: string[];
  depth: number;
  /** Subjects discovered underneath it, retired ones excluded. */
  children: number;
  /** Whether this kind of subject is asked the decomposition question at all. */
  recurses: boolean;
  /** Decomposition rounds: how many have settled, and whether one is live. */
  mapRounds: number;
  mapOpen: boolean;
  mapFound: number;
  /** Opening searches, per mechanism bucket. */
  scanRounds: number;
  scanOpen: boolean;
  scanFound: number;
  /** Which mechanism buckets have never been asked of this subject. */
  bucketsAsked: ReadonlySet<string>;
  /** Openings in the portfolio that this subject's scans produced. */
  openings: number;
  /** Constraints established about the subject itself rather than a piece. */
  constraints: number;
  /** When anything about this subject was last asked. Null for never. */
  lastAskedAt: string | null;
  /** When a round about it last settled. Null while nothing has finished. */
  lastSettledAt: string | null;
}

export interface GraphSnapshot {
  projectId: string;
  at: string;
  nodes: IndustryNode[];
  rounds: IndustryRound[];
  coverage: NodeCoverage[];
  /** Whether the bootstrap question has ever been asked, and how it went. */
  bootstrap: { asked: boolean; open: boolean; found: number | null };
  opportunities: CashOpportunity[];
  constraints: OpportunityConstraint[];
}

export async function graphSnapshot(projectId: string, now?: string): Promise<GraphSnapshot> {
  const [nodes, rounds, opportunities, constraints] = await Promise.all([
    listNodes(projectId),
    listIndustryRounds(projectId),
    listOpportunities({ projectId }),
    listConstraintsForProject(projectId),
  ]);
  return {
    projectId,
    at: now ?? new Date().toISOString(),
    nodes,
    rounds,
    coverage: coverageOf(nodes, rounds, opportunities, constraints),
    bootstrap: bootstrapState(rounds),
    opportunities,
    constraints,
  };
}

function bootstrapState(rounds: readonly IndustryRound[]): GraphSnapshot['bootstrap'] {
  const mine = rounds.filter((one) => one.purpose === 'BOOTSTRAP');
  if (mine.length === 0) return { asked: false, open: false, found: null };
  const open = mine.some((one) => one.state === 'OPEN');
  const found = mine.reduce<number | null>(
    (total, one) => (one.found === null ? total : (total ?? 0) + one.found),
    null,
  );
  return { asked: true, open, found };
}

/**
 * The coverage reading for every live subject.
 *
 * Retired subjects are excluded from the readings and from their parents'
 * child counts, because a reading is about what Brain would work on now. They
 * are not deleted and `listNodes` still returns them, so anything asking *what
 * has been decided here* still gets an answer.
 */
export function coverageOf(
  nodes: readonly IndustryNode[],
  rounds: readonly IndustryRound[],
  opportunities: readonly CashOpportunity[],
  constraints: readonly OpportunityConstraint[],
): NodeCoverage[] {
  const byId = new Map(nodes.map((one) => [one.id, one]));
  const live = nodes.filter((one) => one.retiredAt === null);
  const childCount = new Map<string, number>();
  for (const node of live) {
    if (!node.parentId) continue;
    childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
  }

  const openingCount = new Map<string, number>();
  for (const one of opportunities) {
    if (!one.industryNodeId) continue;
    openingCount.set(one.industryNodeId, (openingCount.get(one.industryNodeId) ?? 0) + 1);
  }

  const constraintCount = new Map<string, number>();
  for (const one of constraints) {
    if (!one.nodeId) continue;
    constraintCount.set(one.nodeId, (constraintCount.get(one.nodeId) ?? 0) + 1);
  }

  const roundsByNode = new Map<string, IndustryRound[]>();
  for (const round of rounds) {
    if (!round.nodeId) continue;
    roundsByNode.set(round.nodeId, [...(roundsByNode.get(round.nodeId) ?? []), round]);
  }

  return live.map((node) => {
    const mine = roundsByNode.get(node.id) ?? [];
    const maps = mine.filter((one) => one.purpose === 'MAP');
    const scans = mine.filter((one) => one.purpose === 'SCAN');
    const settled = mine.filter((one) => one.harvestedAt !== null);
    return {
      node,
      path: pathOf(node.id, byId),
      depth: depthOf(node.id, byId),
      children: childCount.get(node.id) ?? 0,
      recurses: kindRecurses(node.kind),
      mapRounds: maps.filter((one) => one.state !== 'OPEN').length,
      mapOpen: maps.some((one) => one.state === 'OPEN'),
      mapFound: sumFound(maps),
      scanRounds: scans.filter((one) => one.state !== 'OPEN').length,
      scanOpen: scans.some((one) => one.state === 'OPEN'),
      scanFound: sumFound(scans),
      bucketsAsked: new Set(
        scans.map((one) => one.bucketId).filter((one): one is string => one !== null),
      ),
      openings: openingCount.get(node.id) ?? 0,
      constraints: constraintCount.get(node.id) ?? 0,
      lastAskedAt: latest(mine.map((one) => one.openedAt)),
      lastSettledAt: latest(settled.map((one) => one.harvestedAt ?? one.openedAt)),
    };
  });
}

/** Rounds that have not settled contribute nothing — not zero, nothing. */
function sumFound(rounds: readonly IndustryRound[]): number {
  return rounds.reduce((total, one) => total + (one.found ?? 0), 0);
}

function latest(values: readonly string[]): string | null {
  let out: string | null = null;
  for (const value of values) {
    if (out === null || value > out) out = value;
  }
  return out;
}

/** The subject sentence a question about this node actually has to carry. */
export function subjectOf(coverage: NodeCoverage): string {
  return coverage.path.join(' → ');
}
