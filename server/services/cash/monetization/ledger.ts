/**
 * The Monetization Possibility Ledger, composed.
 *
 * One read of one project's rows, and every answer the brief asks for per
 * possibility: what the method is, what it is a way of monetizing, what it
 * requires, what it would pay, what it would cost, when, how hard, how
 * contested, how repeatable, what is still unknown, what supports it, what it
 * assumes, where it stands, where it ranks, where it ranked, why it moved and
 * when it was last looked at.
 *
 * Four of those are **not** columns anywhere and must not become ones.
 *
 *   the margin   — revenue less costs, withheld naming which half is missing
 *                  rather than computed against an unknown. `derivedEconomics`
 *                  already refuses this in the direction that makes a piece
 *                  look worth doing, and so does this.
 *   the status   — derived from facts, judgements, the subject and the graph.
 *   the rank     — derived by a lexicographic order over counted rows.
 *   the unknowns — the attributes with no answer, which is a reading of the
 *                  facts rather than a list somebody maintains.
 *
 * It writes nothing. Everything here is a projection over rows that already
 * existed, so a page can be opened as often as anybody likes and the sprint
 * does not move.
 */
import { ATTRIBUTE, METHOD, MONETIZATION_ATTRIBUTES } from '../../../domain/monetization.ts';
import { listNeeds, listOpportunities } from '../../../repos/cashPortfolio.ts';
import {
  latestSnapshots,
  listEdges,
  listJudgments,
  listPaths,
  pathFactsForProject,
} from '../../../repos/monetization.ts';
import { deriveStatus } from './status.ts';
import { rankLedger, type RankableEntry } from './rank.ts';
import { subjectGraph, sequences, type GraphEdge, type Sequence } from './graph.ts';
import type {
  CashNeed,
  CashOpportunity,
  MonetizationAttribute,
  MonetizationPath,
  MonetizationPathFact,
  MonetizationPathJudgment,
  MonetizationStatus,
} from '../../../domain/types.ts';

export interface LedgerAnswer {
  attribute: MonetizationAttribute;
  label: string;
  question: string;
  /** The answer, or null when nobody has established one. */
  value: string | null;
  /** FACT, ESTIMATE, DECISION or UNKNOWN — the engine card's own four. */
  kind: 'FACT' | 'ESTIMATE' | 'DECISION' | 'UNKNOWN';
  /** What would answer it. A property of the question, never of today's blank. */
  task: string;
  owner: 'BRAIN_RESEARCH' | 'BRAIN_PROPOSES' | 'PERSON_ONLY';
  /** FACT only: the gated claim this resolves to. */
  claimId: string | null;
  /** ESTIMATE only, and all three are present on one. */
  basis: string | null;
  assumptions: string | null;
  uncertainty: string | null;
  /** The structured reading, where the attribute declares a unit. */
  amountCents: number | null;
  days: number | null;
  loadBearing: boolean;
  /**
   * When this answer was last recorded, or null where there is none.
   *
   * Carried because one question needs it and nothing else could answer that
   * question: whether a judgement that put a possibility away is older than the
   * evidence that has arrived since. That is two timestamps, and without this
   * one the surface would have to compare against the path row — which moves
   * for reasons that have nothing to do with what is known.
   */
  updatedAt: string | null;
}

export interface DerivedMargin {
  /** The arithmetic, in words, so it is visible rather than asserted. */
  formula: string;
  value: number | null;
  /** Why it is null, when it is. Never an estimate standing in for a refusal. */
  withheld: string | null;
}

export interface LedgerEntry {
  path: MonetizationPath;
  /** What the method is and what it asks of whoever runs it. */
  method: {
    label: string;
    what: string;
    role: string;
    requires: readonly string[];
    produces: readonly string[];
    scaleDependent: boolean;
  };
  /** The discovery this is a way of monetizing, where the subject is one. */
  subject: { id: string; title: string; kind: 'OPPORTUNITY' | 'INDUSTRY_NODE' } | null;
  status: MonetizationStatus;
  statusBecause: string;
  /** Every attribute, answered or not, in the order the brief asks them. */
  answers: LedgerAnswer[];
  /** The attributes with no answer. A reading of the facts, never a stored list. */
  unknowns: MonetizationAttribute[];
  /** Revenue less costs, or the reason it is withheld. */
  margin: DerivedMargin;
  /** Where it ranks now, 1-based, across the whole project. */
  rank: number;
  /** Where it ranked when it last moved, and why. Null before its first reading. */
  previousRank: number | null;
  movementReason: string | null;
  movedAt: string | null;
  lastEvaluatedAt: string | null;
  /** Everything a person recorded about it, oldest first. Never deleted. */
  judgments: MonetizationPathJudgment[];
  /** What it enables, competes with, waits on. Derived plus recorded. */
  edges: GraphEdge[];
}

export interface Ledger {
  projectId: string;
  /** Every possibility, best first. Nothing is withheld from this list. */
  entries: LedgerEntry[];
  /** How many are at each status, counted from the same entries. */
  byStatus: Record<MonetizationStatus, number>;
  /** The chains worth looking at, per subject. */
  sequences: Sequence[];
  /** When this reading was taken. */
  readAt: string;
}

/**
 * How much walking the chains may cost for a whole ledger, and the floor
 * beneath which splitting it stops being worth anything.
 *
 * Stated here rather than inside `sequences`, because the thing that has to be
 * bounded is a person's page rather than one subject's picture.
 */
const SEQUENCE_BUDGET = 4_000;
const MIN_SEQUENCE_BUDGET = 200;
/** How many chains are worth composing at all. The surface shows a handful. */
const MAX_SEQUENCES = 12;

const EMPTY_COUNTS = (): Record<MonetizationStatus, number> => ({
  ACTIVE: 0,
  WATCH: 0,
  BLOCKED: 0,
  WEAK: 0,
  UNPROVEN: 0,
  INVALIDATED: 0,
  ARCHIVED: 0,
});

function kindOf(fact: MonetizationPathFact | undefined): LedgerAnswer['kind'] {
  if (!fact) return 'UNKNOWN';
  if (fact.kind === 'EVIDENCE') return 'FACT';
  if (fact.kind === 'RECOMMENDATION') return 'ESTIMATE';
  return 'DECISION';
}

function answersFor(facts: ReadonlyMap<MonetizationAttribute, MonetizationPathFact>): LedgerAnswer[] {
  return MONETIZATION_ATTRIBUTES.map((attribute) => {
    const declaration = ATTRIBUTE[attribute];
    const fact = facts.get(attribute);
    return {
      attribute,
      label: declaration.label,
      question: declaration.question,
      value: fact?.value ?? null,
      kind: kindOf(fact),
      task: declaration.task,
      owner: declaration.owner,
      claimId: fact?.claimId ?? null,
      basis: fact?.basis ?? null,
      assumptions: fact?.assumptions ?? null,
      uncertainty: fact?.uncertainty ?? null,
      amountCents: fact?.amountCents ?? null,
      days: fact?.days ?? null,
      loadBearing: declaration.loadBearing,
      updatedAt: fact?.updatedAt ?? null,
    };
  });
}

/**
 * Revenue less costs, and withheld naming which half is missing.
 *
 * `derivedEconomics`' rule at a new table, and the reason is the same one: a
 * margin against an unknown cost reads as better than it is, and that is the
 * shape of error nobody notices because it looks like ambition.
 */
function marginFor(facts: ReadonlyMap<MonetizationAttribute, MonetizationPathFact>): DerivedMargin {
  const revenue = facts.get('expectedRevenue')?.amountCents ?? null;
  const costs = facts.get('directCosts')?.amountCents ?? null;
  const formula = 'the established revenue, less the established direct costs';
  if (revenue !== null && costs !== null) {
    return { formula, value: revenue - costs, withheld: null };
  }
  if (revenue === null && costs === null) {
    return {
      formula,
      value: null,
      withheld: 'Neither a revenue nor a cost is established, so there is nothing to take one from the other.',
    };
  }
  return {
    formula,
    value: null,
    withheld:
      revenue !== null
        ? 'The direct costs are unknown. A margin against an unknown cost reads as better than ' +
          'it is, so none is given.'
        : 'No revenue is established, so there is nothing to take the costs from.',
  };
}

/**
 * The whole ledger for one project.
 *
 * Every table is read once and joined in memory, for `cashView`'s reason: a
 * query per possibility would be one per row on a page that shows all of them,
 * and reading the same rows twice is how two figures on one screen come to
 * disagree about the same thing.
 */
export async function composeLedger(input: {
  projectId: string;
  now?: string;
}): Promise<Ledger> {
  const projectId = input.projectId;
  const readAt = input.now ?? new Date().toISOString();

  const paths = await listPaths({ projectId });
  const opportunities = await listOpportunities({ projectId });
  const subjects = new Map(opportunities.map((one) => [one.id, one]));
  const recordedEdges = await listEdges(projectId);
  const snapshots = await latestSnapshots(projectId);

  const factsByPath = new Map<string, Map<MonetizationAttribute, MonetizationPathFact>>();
  for (const fact of await pathFactsForProject(projectId)) {
    const existing = factsByPath.get(fact.pathId) ?? new Map();
    existing.set(fact.attribute, fact);
    factsByPath.set(fact.pathId, existing);
  }

  const judgmentsByPath = new Map<string, MonetizationPathJudgment[]>();
  for (const judgment of await listJudgments(projectId)) {
    judgmentsByPath.set(judgment.pathId, [
      ...(judgmentsByPath.get(judgment.pathId) ?? []),
      judgment,
    ]);
  }

  /*
   * Open capability gaps, by the discovery they were raised against.
   *
   * A recorded blocker with a remedy on it, which is what makes BLOCKED mean
   * *something named has to happen first* rather than *something might be
   * missing*. Every path on a discovery inherits its gaps, because a capability
   * Brain does not have is missing however the money would be taken.
   */
  const needs = new Map<string, CashNeed[]>();
  for (const need of await listNeeds({ projectId, states: ['OPEN'] })) {
    if (!need.opportunityId) continue;
    needs.set(need.opportunityId, [...(needs.get(need.opportunityId) ?? []), need]);
  }

  const edgesBySubject = new Map<string, GraphEdge[]>();
  const allSequences: Sequence[] = [];
  const subjectIds = [...new Set(paths.map(subjectKey))];
  /*
   * A per-subject walk budget derived from how many subjects there are.
   *
   * The chains are the only combinatorial thing on this read path — the graph
   * itself is pairwise over declarations and is cheap — and thirty discoveries
   * each spending a full walk budget is thirty times the work for a page one
   * person is waiting on. So the budget is divided, with a floor beneath which
   * dividing it further stops buying anything.
   *
   * Two things it is honest to say rather than imply. **Past the floor the
   * total grows again**, linearly in subjects: this bounds each subject's walk
   * rather than the ledger's, and the floor is what keeps a very wide ledger
   * from producing no chains at all. And `MAX_SEQUENCES` stops the collection
   * early, so on a ledger with more subjects than that, **the later subjects
   * contribute no chains** — deterministically, because the iteration order is
   * the paths' own creation order, but it is a bias toward the older
   * discoveries and a reader should know it is there.
   */
  const walkBudget = Math.max(
    MIN_SEQUENCE_BUDGET,
    Math.floor(SEQUENCE_BUDGET / Math.max(1, subjectIds.length)),
  );
  for (const subjectId of subjectIds) {
    const mine = paths.filter((one) => subjectKey(one) === subjectId);
    const edges = subjectGraph(
      mine,
      recordedEdges.filter((edge) => mine.some((one) => one.id === edge.fromPathId)),
    );
    edgesBySubject.set(subjectId, edges);
    if (allSequences.length >= MAX_SEQUENCES) continue;
    allSequences.push(...sequences(mine, edges, { budget: walkBudget }));
  }
  allSequences.splice(MAX_SEQUENCES);

  const byId = new Map(paths.map((one) => [one.id, one]));

  /*
   * Status before rank, because the ranking's first comparison is the status —
   * and the status needs the graph, because a path that cannot start until
   * another has is blocked by it. Two passes over the same rows rather than a
   * mutual recursion: a path's status reads its *requirement's* status, so the
   * first pass answers without the graph and the second resolves the
   * dependencies against it.
   */
  const firstPass = new Map<string, MonetizationStatus>();
  for (const path of paths) {
    firstPass.set(
      path.id,
      deriveStatus({
        path,
        facts: [...(factsByPath.get(path.id)?.values() ?? [])],
        judgments: judgmentsByPath.get(path.id) ?? [],
        subject: path.opportunityId ? (subjects.get(path.opportunityId) ?? null) : null,
        unmetRequirements: [],
        blockedBy: (needs.get(path.opportunityId ?? '') ?? []).map((need) => ({
          blockedAction: need.blockedAction,
          nextStep: need.nextStep,
        })),
        mergedInto: mergedInto(path, byId),
      }).status,
    );
  }

  const entries: LedgerEntry[] = [];
  for (const path of paths) {
    const facts = factsByPath.get(path.id) ?? new Map<MonetizationAttribute, MonetizationPathFact>();
    const edges = (edgesBySubject.get(subjectKey(path)) ?? []).filter(
      (edge) => edge.fromPathId === path.id || edge.toPathId === path.id,
    );
    /*
     * A dependency somebody **established**, never one the method table drew.
     *
     * The first version of this read every derived `REQUIRES` edge, and running
     * it is what found the defect: the enumeration puts dozens of shapes of
     * transaction on one discovery, a derived REQUIRES exists wherever exactly
     * one of them produces something another needs, and none of them is proven
     * on day one — so **every possibility in a fresh ledger read BLOCKED**, on
     * a condition nobody had established and nobody could act on. That is
     * §24's *waiting nobody can resolve* arriving through a status column.
     *
     * The distinction is the same one the whole ledger rests on. A derived edge
     * is a statement about two *methods* — informative, and on the entry for a
     * reader to see. A recorded one is a statement about these two *paths*,
     * with a person or a source behind it, and only that is a blocker. What a
     * method requires is a question rather than a dependency, and it already
     * has one: `requiredCapability`.
     */
    const unmet = edges
      .filter(
        (edge) =>
          edge.kind === 'REQUIRES' && edge.toPathId === path.id && edge.source !== 'DERIVED',
      )
      .map((edge) => ({
        title: byId.get(edge.fromPathId)?.title ?? edge.fromPathId,
        status: firstPass.get(edge.fromPathId) ?? 'UNPROVEN',
      }))
      .filter((one) => one.status !== 'ACTIVE');

    const reading = deriveStatus({
      path,
      facts: [...facts.values()],
      judgments: judgmentsByPath.get(path.id) ?? [],
      subject: path.opportunityId ? (subjects.get(path.opportunityId) ?? null) : null,
      unmetRequirements: unmet,
      blockedBy: (needs.get(path.opportunityId ?? '') ?? []).map((need) => ({
        blockedAction: need.blockedAction,
        nextStep: need.nextStep,
      })),
      mergedInto: mergedInto(path, byId),
    });

    const declaration = METHOD[path.method];
    const snapshot = snapshots.get(path.id) ?? null;
    entries.push({
      path,
      method: {
        label: declaration.label,
        what: declaration.what,
        role: declaration.role,
        requires: declaration.requires,
        produces: declaration.produces,
        scaleDependent: declaration.scaleDependent,
      },
      subject: subjectOf(path, subjects),
      status: reading.status,
      statusBecause: reading.because,
      answers: answersFor(facts),
      unknowns: MONETIZATION_ATTRIBUTES.filter((attribute) => !facts.has(attribute)),
      margin: marginFor(facts),
      // Filled in below, once every entry is ranked together.
      rank: 0,
      previousRank: snapshot?.previousRank ?? null,
      movementReason: snapshot?.reason ?? null,
      movedAt: snapshot?.evaluatedAt ?? null,
      lastEvaluatedAt: path.lastEvaluatedAt,
      judgments: judgmentsByPath.get(path.id) ?? [],
      edges,
    });
  }

  const ranked = rankLedger(entries.map(rankableOf));
  const position = new Map(ranked.map((one, at) => [one.path.id, at + 1]));
  for (const entry of entries) entry.rank = position.get(entry.path.id) ?? entries.length;
  entries.sort((a, b) => a.rank - b.rank);

  const byStatus = EMPTY_COUNTS();
  for (const entry of entries) byStatus[entry.status] += 1;

  return {
    projectId,
    entries,
    byStatus,
    sequences: allSequences,
    readAt,
  };
}

/**
 * The shape the ranking reads, built from an entry that is already composed.
 *
 * Built from the composed entry rather than a second time from the rows, and
 * that is the point: `composeLedger` ranks through this same function, so the
 * order on the page and the order an explanation is computed against are one
 * construction. Two builders that must agree about one ledger is the defect
 * this repository keeps correcting, and a ranking that disagreed with the list
 * beside it would be the worst available instance of it.
 *
 * It is faithful because of what the criteria actually read: a status, a count
 * of answers, which of them resolve to a source, two structured figures, three
 * choice values and the path's own creation time. Every one of those is on the
 * entry.
 */
export function rankableOf(entry: LedgerEntry): RankableEntry {
  const facts = new Map<MonetizationAttribute, MonetizationPathFact>();
  for (const answer of entry.answers) {
    if (answer.value === null) continue;
    facts.set(answer.attribute, {
      id: `${entry.path.id}:${answer.attribute}`,
      projectId: entry.path.projectId,
      pathId: entry.path.id,
      attribute: answer.attribute,
      kind:
        answer.kind === 'FACT' ? 'EVIDENCE' : answer.kind === 'ESTIMATE' ? 'RECOMMENDATION' : 'PERSON',
      value: answer.value,
      amountCents: answer.amountCents,
      days: answer.days,
      claimId: answer.claimId,
      basis: answer.basis,
      assumptions: answer.assumptions,
      uncertainty: answer.uncertainty,
      decidedBy: 'BRAIN',
      createdAt: entry.path.createdAt,
      updatedAt: answer.updatedAt ?? entry.path.updatedAt,
    });
  }
  return { path: entry.path, status: entry.status, facts };
}

function subjectKey(path: MonetizationPath): string {
  return `${path.opportunityId ?? '-'}|${path.industryNodeId ?? '-'}`;
}

function subjectOf(
  path: MonetizationPath,
  subjects: Map<string, CashOpportunity>,
): LedgerEntry['subject'] {
  if (path.opportunityId) {
    const found = subjects.get(path.opportunityId);
    return found
      ? { id: found.id, title: found.title, kind: 'OPPORTUNITY' }
      : { id: path.opportunityId, title: path.opportunityId, kind: 'OPPORTUNITY' };
  }
  if (path.industryNodeId) {
    return { id: path.industryNodeId, title: path.industryNodeId, kind: 'INDUSTRY_NODE' };
  }
  return null;
}

function mergedInto(
  path: MonetizationPath,
  byId: Map<string, MonetizationPath>,
): { title: string } | null {
  if (!path.mergedIntoId) return null;
  const survivor = byId.get(path.mergedIntoId);
  return { title: survivor?.title ?? path.mergedIntoId };
}
