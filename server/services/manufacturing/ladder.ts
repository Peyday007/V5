/**
 * The ladder as Brain can currently read it, and how far it has got with each
 * category.
 *
 * ---------------------------------------------------------------------------
 * Coverage is derived, and that is the whole design
 * ---------------------------------------------------------------------------
 *
 * There is no coverage column, no readiness column, no entry verdict and no
 * sequence position in the schema. Every one of them is a fact about rows that
 * change underneath it: a round settles, a claim is accepted, a capability
 * becomes held, and a stored reading is wrong from that instant until something
 * remembers to recompute it. `graph.ts` makes the same argument about the
 * industry map, `tier.ts` about an opportunity's tier and `placements` made it
 * first about a disposition — a row is not a decision.
 *
 * Here it is also what the brief demands in as many words. *"DO NOT blindly
 * follow 1 → 2 → 3 → 4 → 5 → 6. Continuously calculate the strongest next
 * expansion."* A stored ordering is the rigid roadmap it refuses; a derived one
 * moves the day an acquisition, a breakthrough or a piece of evidence changes
 * what is reachable.
 *
 * What the schema *does* store is the three things no derivation could recover:
 * that a person seeded a category, that a person retired one, and that this
 * company holds a capability. All three are decisions or facts about the world
 * outside Brain, and decisions are exactly what cannot be re-derived from
 * evidence.
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
import {
  getProgram,
  listCapabilities,
  listCategories,
  listCategoryEvidence,
  listEdges,
  listManufacturingRounds,
} from '../../repos/manufacturing.ts';
import { depthOf, pathOf } from '../../domain/manufacturing.ts';
import type {
  Capability,
  CapabilityEdge,
  CategoryEvidenceEntry,
  MachineCategory,
  ManufacturingProgram,
  ManufacturingRound,
  ManufacturingRoundPurpose,
} from '../../domain/types.ts';

/**
 * How far Brain has got with one category, entirely from rows.
 *
 * Every field here is a count, a set or a timestamp. There is deliberately
 * nothing that reads as a judgement — no score, no confidence, no "promising" —
 * because the judgement belongs to `readiness.ts`, which composes it from these
 * and shows its working. A reading that already contained an opinion would make
 * the verdict unfalsifiable.
 */
export interface CategoryCoverage {
  category: MachineCategory;
  /** Root-first, so a question about it can say what it is actually about. */
  path: string[];
  depth: number;
  /** Categories discovered underneath it, retired ones excluded. */
  children: number;

  /** Rounds settled per purpose, and whether one of each is live. */
  settled: Readonly<Record<ManufacturingRoundPurpose, number>>;
  open: Readonly<Record<ManufacturingRoundPurpose, boolean>>;
  found: Readonly<Record<ManufacturingRoundPurpose, number>>;

  /** Capabilities this category is established to need, and to develop. */
  requires: Capability[];
  teaches: Capability[];

  /** What is known about entering it, split by kind. */
  demand: CategoryEvidenceEntry[];
  distribution: CategoryEvidenceEntry[];
  weaknesses: CategoryEvidenceEntry[];
  barriers: CategoryEvidenceEntry[];
  boughtIn: CategoryEvidenceEntry[];

  /** When anything about it was last asked, and when one last settled. */
  lastAskedAt: string | null;
  lastSettledAt: string | null;
}

export interface LadderSnapshot {
  projectId: string;
  program: ManufacturingProgram;
  at: string;
  categories: MachineCategory[];
  capabilities: Capability[];
  edges: CapabilityEdge[];
  evidence: CategoryEvidenceEntry[];
  rounds: ManufacturingRound[];
  coverage: CategoryCoverage[];
  /** Whether the opening question has ever been asked, and how it went. */
  bootstrap: { asked: boolean; open: boolean; found: number | null };
}

const PURPOSES: readonly ManufacturingRoundPurpose[] = [
  'BOOTSTRAP',
  'MAP',
  'DEMAND',
  'CAPABILITY',
  'INTEGRATION',
];

export async function ladderSnapshot(
  projectId: string,
  now?: string,
): Promise<LadderSnapshot | null> {
  const program = await getProgram(projectId);
  if (!program) return null;

  const [categories, capabilities, edges, evidence, rounds] = await Promise.all([
    listCategories(program.id),
    listCapabilities(program.id),
    listEdges(program.id),
    listCategoryEvidence(program.id),
    listManufacturingRounds(program.id),
  ]);

  return {
    projectId,
    program,
    at: now ?? new Date().toISOString(),
    categories,
    capabilities,
    edges,
    evidence,
    rounds,
    coverage: coverageOf({ categories, capabilities, edges, evidence, rounds }),
    bootstrap: bootstrapState(rounds),
  };
}

function bootstrapState(rounds: readonly ManufacturingRound[]): LadderSnapshot['bootstrap'] {
  const mine = rounds.filter((one) => one.purpose === 'BOOTSTRAP');
  if (mine.length === 0) return { asked: false, open: false, found: null };
  return {
    asked: true,
    open: mine.some((one) => one.state === 'OPEN'),
    found: mine.reduce<number | null>(
      (total, one) => (one.found === null ? total : (total ?? 0) + one.found),
      null,
    ),
  };
}

/**
 * The coverage reading for every live category.
 *
 * Retired categories are excluded from the readings and from their parents'
 * child counts, because a reading is about what Brain would work on now. They
 * are not deleted and `listCategories` still returns them, so anything asking
 * *what has been decided here* still gets an answer.
 */
export function coverageOf(input: {
  categories: readonly MachineCategory[];
  capabilities: readonly Capability[];
  edges: readonly CapabilityEdge[];
  evidence: readonly CategoryEvidenceEntry[];
  rounds: readonly ManufacturingRound[];
}): CategoryCoverage[] {
  const byId = new Map(input.categories.map((one) => [one.id, one]));
  const capabilityById = new Map(input.capabilities.map((one) => [one.id, one]));
  const live = input.categories.filter((one) => one.retiredAt === null);

  const childCount = new Map<string, number>();
  for (const category of live) {
    if (!category.parentId) continue;
    childCount.set(category.parentId, (childCount.get(category.parentId) ?? 0) + 1);
  }

  const edgesByCategory = new Map<string, CapabilityEdge[]>();
  for (const edge of input.edges) {
    edgesByCategory.set(edge.categoryId, [...(edgesByCategory.get(edge.categoryId) ?? []), edge]);
  }

  const evidenceByCategory = new Map<string, CategoryEvidenceEntry[]>();
  for (const entry of input.evidence) {
    evidenceByCategory.set(entry.categoryId, [
      ...(evidenceByCategory.get(entry.categoryId) ?? []),
      entry,
    ]);
  }

  const roundsByCategory = new Map<string, ManufacturingRound[]>();
  for (const round of input.rounds) {
    if (!round.categoryId) continue;
    roundsByCategory.set(round.categoryId, [
      ...(roundsByCategory.get(round.categoryId) ?? []),
      round,
    ]);
  }

  return live.map((category) => {
    const mine = roundsByCategory.get(category.id) ?? [];
    const myEdges = edgesByCategory.get(category.id) ?? [];
    const myEvidence = evidenceByCategory.get(category.id) ?? [];

    const settled = {} as Record<ManufacturingRoundPurpose, number>;
    const open = {} as Record<ManufacturingRoundPurpose, boolean>;
    const found = {} as Record<ManufacturingRoundPurpose, number>;
    for (const purpose of PURPOSES) {
      const rounds = mine.filter((one) => one.purpose === purpose);
      settled[purpose] = rounds.filter((one) => one.state !== 'OPEN').length;
      open[purpose] = rounds.some((one) => one.state === 'OPEN');
      // A round that has not settled contributes nothing — not zero, nothing.
      found[purpose] = rounds.reduce((total, one) => total + (one.found ?? 0), 0);
    }

    const ofRelation = (relation: 'REQUIRES' | 'TEACHES') =>
      myEdges
        .filter((one) => one.relation === relation)
        .map((one) => capabilityById.get(one.capabilityId))
        .filter((one): one is Capability => one !== undefined);

    const ofKind = (kind: CategoryEvidenceEntry['kind']) =>
      myEvidence.filter((one) => one.kind === kind);

    const finished = mine.filter((one) => one.harvestedAt !== null);
    return {
      category,
      path: pathOf(category.id, byId),
      depth: depthOf(category.id, byId),
      children: childCount.get(category.id) ?? 0,
      settled,
      open,
      found,
      requires: ofRelation('REQUIRES'),
      teaches: ofRelation('TEACHES'),
      demand: ofKind('DEMAND_EVIDENCE'),
      distribution: ofKind('DISTRIBUTION_CHANNEL'),
      weaknesses: ofKind('INCUMBENT_WEAKNESS'),
      barriers: ofKind('ENTRY_BARRIER'),
      boughtIn: ofKind('BOUGHT_IN_COMPONENT'),
      lastAskedAt: latest(mine.map((one) => one.openedAt)),
      lastSettledAt: latest(finished.map((one) => one.harvestedAt ?? one.openedAt)),
    };
  });
}

function latest(values: readonly string[]): string | null {
  let out: string | null = null;
  for (const value of values) {
    if (out === null || value > out) out = value;
  }
  return out;
}

/** The subject sentence a question about this category actually has to carry. */
export function subjectOf(coverage: CategoryCoverage): string {
  return coverage.path.join(' → ');
}
