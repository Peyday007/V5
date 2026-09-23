/**
 * What Brain learned from its own outcomes, as one reading a person can check.
 *
 * Every sentence here is composed from rows, and every claim carries the ids it
 * rests on: the prediction Brain made, the outcome it observed, the lesson that
 * outcome supports (or explicitly does not), the decisions that lesson changed,
 * the watches that noticed something move, and the capability Brain proposes to
 * add because one blocker keeps stopping the same work. Nothing is stored here;
 * two readers — the page and `npm run report:learning` — read one derivation.
 */
import {
  currentOutcomes,
  listCorrections,
  listDecisions,
  listOutcomes,
  listPredictions,
  listWatchChanges,
  listWatches,
  withdrawnTargets,
  type OutcomeCorrection,
  type OutcomeDecision,
  type OutcomePrediction,
  type OutcomeRecord,
  type OutcomeWatch,
  type OutcomeWatchChange,
} from '../../repos/learning.ts';
import { deriveLessons, type Lesson } from './lessons.ts';
import { capabilityProposals, type CapabilityProposal } from './capability.ts';
import type { OutcomeResult } from '../../domain/learning.ts';

export interface PredictionVersusOutcome {
  outcome: OutcomeRecord;
  prediction: OutcomePrediction | null;
  /** One line: what was expected, what happened, and the condition that explains the gap. */
  comparison: string;
}

export interface TracedDecision extends OutcomeDecision {
  /** The lesson it used has since been withdrawn by a person. */
  restsOnWithdrawnLesson: boolean;
  lessonStatusNow: Lesson['status'] | 'GONE';
}

export interface LearningView {
  projectId: string;
  /** The Russell-facing account, in three parts. Null parts mean nothing to say. */
  summary: {
    learned: string | null;
    doesDifferently: string | null;
    supportedBy: string | null;
    notConcluded: string | null;
  };
  counts: Record<OutcomeResult, number> & { total: number; withoutWork: number };
  outcomes: PredictionVersusOutcome[];
  lessons: Lesson[];
  decisions: TracedDecision[];
  watches: OutcomeWatch[];
  changes: OutcomeWatchChange[];
  capabilities: CapabilityProposal[];
  corrections: OutcomeCorrection[];
}

export async function learningView(projectId: string): Promise<LearningView> {
  const [all, predictions, corrections, decisions, watches, changes, capabilities] = await Promise.all([
    listOutcomes(projectId),
    listPredictions(projectId),
    listCorrections(projectId),
    listDecisions(projectId),
    listWatches(projectId),
    listWatchChanges(projectId, 20),
    capabilityProposals(projectId),
  ]);
  const withdrawn = withdrawnTargets(corrections);
  const current = currentOutcomes(all);
  const lessons = deriveLessons({ outcomes: all, corrections });
  const byKey = new Map(lessons.map((lesson) => [lesson.key, lesson]));
  const predictionFor = new Map(predictions.map((one) => [one.id, one]));

  const counts = {
    SUCCEEDED: 0,
    PARTIAL: 0,
    FAILED: 0,
    NOT_ATTEMPTED: 0,
    ONGOING: 0,
    UNKNOWN: 0,
    total: current.length,
    withoutWork: 0,
  } as LearningView['counts'];
  for (const outcome of current) {
    counts[outcome.result] += 1;
    if (!outcome.workPerformed && outcome.result !== 'ONGOING') counts.withoutWork += 1;
  }

  const outcomes = [...current].reverse().map((outcome) => {
    const prediction = outcome.predictionId ? predictionFor.get(outcome.predictionId) ?? null : null;
    return { outcome, prediction, comparison: compare(outcome, prediction) };
  });

  const traced: TracedDecision[] = decisions.map((decision) => {
    const lesson = byKey.get(decision.lessonKey);
    return {
      ...decision,
      restsOnWithdrawnLesson: withdrawn.has(`LESSON|${decision.lessonKey}`),
      lessonStatusNow: lesson?.status ?? 'GONE',
    };
  });

  return {
    projectId,
    summary: summarize({ lessons, decisions: traced, current }),
    counts,
    outcomes,
    lessons,
    decisions: traced.reverse(),
    watches,
    changes,
    capabilities,
    corrections,
  };
}

function compare(outcome: OutcomeRecord, prediction: OutcomePrediction | null): string {
  const expected = prediction
    ? `Expected (${prediction.provenance.toLowerCase()}): ${prediction.expected}`
    : 'No prediction was recorded for this attempt.';
  return `${expected} Observed: ${outcome.result} — ${outcome.explanation}`;
}

function summarize(input: {
  lessons: Lesson[];
  decisions: TracedDecision[];
  current: OutcomeRecord[];
}): LearningView['summary'] {
  const active = input.lessons.filter((lesson) => lesson.status === 'ACTIVE');
  const anecdotes = input.lessons.filter(
    (lesson) => lesson.status === 'BELOW_FLOOR' && lesson.kind === 'SUBJECT',
  );
  const liveDecisions = input.decisions.filter((decision) => !decision.restsOnWithdrawnLesson);
  const latest = liveDecisions[liveDecisions.length - 1] ?? null;
  const supporting = active[0]
    ? input.current.filter((outcome) => active[0]!.outcomeIds.includes(outcome.id))
    : [];
  return {
    learned: active.length > 0 ? active.map((lesson) => lesson.statement).join(' ') : null,
    doesDifferently: active.length > 0 ? active.map((lesson) => lesson.effect).join(' ') : null,
    supportedBy:
      supporting.length > 0
        ? `${supporting.length} observed outcome(s), newest ${supporting[supporting.length - 1]!.id} ` +
          `(${supporting[supporting.length - 1]!.subjectId}): ${supporting[supporting.length - 1]!.explanation}` +
          (latest ? ` Latest decision it changed: ${latest.id} — default "${latest.defaultChoice}", chose "${latest.chosen}".` : '')
        : null,
    notConcluded:
      anecdotes.length > 0
        ? anecdotes.map((lesson) => `${lesson.statement} ${lesson.effect}`).join(' ')
        : null,
  };
}

/**
 * One line for Russell's briefing: the newest thing learning changed or noticed.
 *
 * One pass can record several watch changes at once — the lesson starting to
 * hold and the fleet going quiet are two facts, often in the same tick — so the
 * line carries every change from the newest pass rather than whichever sorted
 * first. Picking one by row id would be choosing what a person hears by chance.
 */
export async function learningLine(projectId: string): Promise<string | null> {
  const [changes, decisions] = await Promise.all([
    listWatchChanges(projectId, 10),
    listDecisions(projectId),
  ]);
  const newest = changes[0] ?? null;
  const decision = decisions[decisions.length - 1] ?? null;
  if (newest && (!decision || newest.observedAt >= decision.createdAt)) {
    const windowStart = Date.parse(newest.observedAt) - 60_000;
    return changes
      .filter((change) => Date.parse(change.observedAt) >= windowStart)
      .reverse()
      .map((change) => `${change.whatChanged} ${change.proposal}`)
      .join(' ');
  }
  if (decision) return decision.reason;
  return null;
}
