/**
 * Deadline intelligence, served (§113). The arithmetic is
 * `domain/deadlinePlan.ts`; this reads the measurements it needs — every
 * recorded task outcome, every Factory session's duration by role, every
 * release run — and the reviews of past deadlines, whose recurring causes are
 * handed to the next plan as hazards rather than explained again.
 */
import {
  assessDeadline,
  outcomesOf,
  reforecast,
  type Assessment,
  type DurationSample,
  type PlanTask,
  type Reforecast,
  type TaskOutcome,
} from '../../domain/deadlinePlan.ts';
import {
  deadlineReviews,
  durationSamples,
  recordDeadlineReview,
  recordTaskOutcomes,
  recurringCauses,
  type DeadlineReview,
} from '../../repos/deadlines.ts';

export interface PlanRequest {
  tasks: PlanTask[];
  deadline: string;
  now?: string;
  availableWorkers: number;
  maxWorkers: number;
  /** Extra measured samples the caller holds (e.g. workflow run durations from GitHub). */
  samples?: DurationSample[];
}

export interface PlanAnswer {
  assessment: Assessment;
  /** Present once any task is RUNNING, DONE or BLOCKED: the forecast from where the work actually is. */
  progress: Reforecast | null;
  recurring: Array<{ cause: string; deadlines: number; missed: number }>;
  sampleCount: number;
}

export async function planDeadline(req: PlanRequest): Promise<PlanAnswer> {
  const stored = await durationSamples();
  const samples = [...stored, ...(req.samples ?? [])];
  const now = req.now ?? new Date().toISOString();
  const input = { tasks: req.tasks, samples, now, deadline: req.deadline, availableWorkers: req.availableWorkers, maxWorkers: req.maxWorkers };
  const assessment = assessDeadline(input);
  const started = req.tasks.some((t) => t.status && t.status !== 'TODO');
  const progress = started ? reforecast(input) : null;
  const recurring = recurringCauses(await deadlineReviews());
  if (recurring.length) {
    assessment.hazards.push(
      ...recurring.map((r) => `recurring cause ${r.cause}: in ${r.deadlines} past deadline(s), ${r.missed} missed — plan against it explicitly`),
    );
  }
  return { assessment, progress, recurring, sampleCount: samples.length };
}

export interface RecordRequest {
  deadlineRef: string;
  tasks: PlanTask[];
  failedTaskIds?: string[];
  causes?: Record<string, string>;
  review?: DeadlineReview | null;
  samples?: DurationSample[];
  recordedBy: string;
}

export interface RecordAnswer {
  outcomes: TaskOutcome[];
  recorded: number;
  duplicates: number;
  reviewRecorded: boolean;
}

/** After a deadline (met or missed): every finished task's estimate vs actual, and the review. */
export async function recordDeadline(req: RecordRequest): Promise<RecordAnswer> {
  const samples = [...(await durationSamples()), ...(req.samples ?? [])];
  const outcomes = outcomesOf(req.tasks, samples, new Set(req.failedTaskIds ?? []));
  const { recorded, duplicates } = await recordTaskOutcomes({
    deadlineRef: req.deadlineRef,
    outcomes: outcomes.map((o) => ({ ...o, cause: req.causes?.[o.id] ?? null })),
    source: 'deadline_record',
    recordedBy: req.recordedBy,
  });
  const reviewRecorded = req.review ? await recordDeadlineReview(req.review, req.recordedBy) : false;
  return { outcomes, recorded, duplicates, reviewRecorded };
}
