/**
 * The minimum useful mental state, derived on the read path.
 *
 * ---------------------------------------------------------------------------
 * Reading this changes nothing
 * ---------------------------------------------------------------------------
 *
 * No enqueue, no claim, no cancellation, no reprioritisation, no disposition
 * move, no revision row. Every value below is computed from rows already
 * written, exactly like `pending.ts` and `placements` — and for the same reason:
 * a projection that wrote something would make opening a page a decision.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to show
 * ---------------------------------------------------------------------------
 *
 * A percentage over fragments. §29's whole lesson is that "0 of 8 settled" was
 * accurate and read as failure, and the remedy was a named denominator with a
 * state beside it. So progress here is decisive-uncertainty coverage with the
 * denominator said out loud, `null` when there is nothing to measure, and never
 * a count of activity.
 *
 * Internal ids as product language. Every question carries its own sentence;
 * the keys are present because a person debugging needs them, and no line of
 * prose is built out of one.
 *
 * Certainty Brain does not have. A belief whose basis is `ASSUMED` says so
 * beside itself, because the difference between what the archive suggested and
 * what evidence established is the difference this whole faculty exists to keep.
 */
import { listClaims, listFragments } from '../../../repos/research.ts';
import { listCoverage, listRequirements } from '../../../repos/reconciliation.ts';
import {
  currentProblemModel,
  listLessons,
  listPlanRevisions,
} from '../../../repos/researchIntelligence.ts';
import { assessSufficiency, type SufficiencyReading } from './sufficiency.ts';
import { rank, readGraph } from './uncertainty.ts';
import { readExamples } from './model.ts';
import type { ResearchOrchestration } from '../../../domain/types.ts';

export interface QuestionView {
  key: string;
  question: string;
  whyItMatters: string;
  /** OPEN, RESOLVED, RETIRED … in the words the row carries. */
  disposition: string;
  /** Why it ended, when it ended. Never a silence. */
  reason: string | null;
  belief: string | null;
  /** UNKNOWN | ASSUMED | ARCHIVE | EVIDENCE | PERSON — shown, never implied. */
  beliefBasis: string;
  decisive: boolean;
  couldInvalidateEverything: boolean;
  depth: string;
  depthBasis: string | null;
  /** Where it came from: the plan, a finding, a contradiction, a gap, a person. */
  origin: string;
}

export interface ResearchIntelligenceView {
  orchestrationId: string;
  /** What Brain believes it was asked, and the decision it supports. */
  understanding: {
    outcomeSought: string;
    decisionSupported: string | null;
    stakes: string;
    reversibility: string;
    /** Properties the examples illustrate — what search may generalise over. */
    searchableProperties: string[];
    /** Examples that stated no property, which may not be read as a whitelist. */
    unexplainedExamples: string[];
    nonGoals: string[];
    assumptions: string[];
    version: number;
    derivedFrom: string;
  } | null;
  /** The ordered agenda: what is being researched now, and why that first. */
  next: { key: string; question: string; why: string }[];
  decisive: QuestionView[];
  settled: QuestionView[];
  retired: QuestionView[];
  needsPerson: QuestionView[];
  openContradictions: { claimId: string; note: string | null; challenged: boolean }[];
  /** What changed the plan, newest first, in the words the revision carries. */
  changes: { version: number; reason: string; summary: string; at: string }[];
  sufficiency: SufficiencyReading;
  lessons: { lesson: string; abstraction: string }[];
}

export async function researchIntelligenceView(
  orchestration: ResearchOrchestration,
): Promise<ResearchIntelligenceView> {
  const [graph, model, requirements, coverage, claims, fragments, revisions, lessons] =
    await Promise.all([
      readGraph(orchestration.id),
      currentProblemModel(orchestration.id),
      listRequirements(orchestration.id),
      listCoverage(orchestration.id),
      listClaims(orchestration.id),
      listFragments(orchestration.id),
      listPlanRevisions(orchestration.id),
      listLessons(orchestration.id),
    ]);

  const view = (key: string): QuestionView | null => {
    const one = graph.uncertainties.find((entry) => entry.uncertaintyKey === key);
    if (!one) return null;
    return {
      key: one.uncertaintyKey,
      question: one.question,
      whyItMatters: one.whyItMatters,
      disposition: one.disposition,
      reason: one.dispositionReason,
      belief: one.currentBelief,
      beliefBasis: one.beliefBasis,
      decisive:
        one.invalidating || one.consequence === 'CRITICAL' || one.consequence === 'HIGH',
      couldInvalidateEverything: one.invalidating,
      depth: one.depth,
      depthBasis: one.depthBasis,
      origin: one.origin,
    };
  };

  const all = graph.uncertainties
    .map((one) => view(one.uncertaintyKey))
    .filter((one): one is QuestionView => one !== null);

  const ranked = rank(graph.uncertainties, graph.links);

  const challenged = new Set(
    graph.links.filter((link) => link.kind === 'CHALLENGES').map((link) => link.toKey),
  );
  const keyForFragment = new Map(fragments.map((fragment) => [fragment.id, fragment.fragmentKey]));

  const sufficiency = assessSufficiency({
    uncertainties: graph.uncertainties,
    links: graph.links,
    requirements,
    coverage,
    claims,
    fragments,
    mayRecordGaps: orchestration.unresolvedGapPolicy === 'RECORD_GAPS',
  });

  const examples = model ? readExamples(model) : null;

  return {
    orchestrationId: orchestration.id,
    understanding: model
      ? {
          outcomeSought: model.outcomeSought,
          decisionSupported: model.decisionSupported,
          stakes: model.stakes,
          reversibility: model.reversibility,
          searchableProperties: examples?.generalisableProperties ?? [],
          unexplainedExamples: (examples?.unexplained ?? []).map((one) => one.statement),
          nonGoals: model.nonGoals,
          assumptions: model.assumptions,
          version: model.version,
          derivedFrom: model.derivedFrom,
        }
      : null,
    // Advice about ordering, and said as advice: the queue still decides what a
    // worker is handed.
    next: ranked.slice(0, 5).map((entry) => ({
      key: entry.uncertainty.uncertaintyKey,
      question: entry.uncertainty.question,
      why: entry.why,
    })),
    decisive: all.filter((one) => one.decisive),
    settled: all.filter((one) => one.disposition === 'RESOLVED'),
    retired: all.filter((one) => one.disposition === 'RETIRED'),
    needsPerson: all.filter((one) => one.disposition === 'PERSON_ONLY'),
    openContradictions: claims
      .filter(
        (claim) =>
          claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED',
      )
      .map((claim) => ({
        claimId: claim.id,
        note: claim.contradictionNote,
        challenged: Boolean(
          claim.fragmentId && challenged.has(keyForFragment.get(claim.fragmentId) ?? ''),
        ),
      })),
    changes: [...revisions]
      .reverse()
      .slice(0, 20)
      .map((revision) => ({
        version: revision.version,
        reason: revision.reason,
        summary: revision.summary,
        at: revision.createdAt,
      })),
    sufficiency,
    lessons: lessons.map((lesson) => ({
      lesson: lesson.lesson,
      abstraction: lesson.abstraction,
    })),
  };
}
