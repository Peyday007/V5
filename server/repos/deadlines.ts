/**
 * Deadline intelligence's rows (§113): what each kind of work actually took,
 * and how each deadline actually went.
 *
 * Samples come from three places, all of them measurements:
 *   - `deadline_task_outcomes` — finished tasks of deadline-bound work,
 *     recorded by whoever ran them (a session, Factory, the operator);
 *   - `factory_sessions` — every Factory worker session's own duration, by
 *     role (ARCHITECT → PLAN, IMPLEMENTER → CODE, REVIEWER → REVIEW,
 *     INTEGRATOR → INTEGRATE, VERIFIER → VERIFY);
 *   - `factory_release_runs` — each release from creation to LIVE (RELEASE),
 *     a FAILED or ROLLED_BACK run counting as a repeated attempt.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson } from './util.ts';
import type { DurationSample, TaskOutcome } from '../domain/deadlinePlan.ts';
import type { DeadlineReviewRow, DeadlineTaskOutcomeRow } from '../domain/types.ts';

/** How far back history is read. Old enough to have samples, recent enough to describe the system as it is. */
export const HISTORY_DAYS = 30;

const ROLE_KIND: Readonly<Record<string, string>> = {
  ARCHITECT: 'PLAN',
  IMPLEMENTER: 'CODE',
  REVIEWER: 'REVIEW',
  INTEGRATOR: 'INTEGRATE',
  VERIFIER: 'VERIFY',
};

const minutesBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 60_000;

/** Every measured duration sample in the window, newest first, from all three sources. */
export async function durationSamples(sinceIso?: string): Promise<DurationSample[]> {
  const since = sinceIso ?? new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
  const db = getDb();
  const out: DurationSample[] = [];
  const own = await db.all<Pick<DeadlineTaskOutcomeRow, 'kind' | 'actual_min' | 'failed'>>(
    'SELECT kind, actual_min, failed FROM deadline_task_outcomes WHERE recorded_at >= ? ORDER BY recorded_at DESC',
    [since],
  );
  for (const r of own) out.push({ kind: r.kind, minutes: Number(r.actual_min), failed: Number(r.failed) === 1, source: 'deadline_task_outcomes' });
  const sessions = await db.all<{ role: string; state: string; duration_ms: number | string | null }>(
    `SELECT role, state, duration_ms FROM factory_sessions
      WHERE started_at >= ? AND state IN ('FINISHED','FAILED') AND duration_ms IS NOT NULL
      ORDER BY started_at DESC`,
    [since],
  );
  for (const r of sessions) {
    const kind = ROLE_KIND[r.role];
    if (kind) out.push({ kind, minutes: Number(r.duration_ms) / 60_000, failed: r.state === 'FAILED', source: 'factory_sessions' });
  }
  const releases = await db.all<{ state: string; created_at: string; finished_at: string | null }>(
    `SELECT state, created_at, finished_at FROM factory_release_runs
      WHERE created_at >= ? AND finished_at IS NOT NULL AND state IN ('LIVE','FAILED','ROLLED_BACK')
      ORDER BY created_at DESC`,
    [since],
  );
  for (const r of releases) {
    out.push({ kind: 'RELEASE', minutes: minutesBetween(r.created_at, r.finished_at!), failed: r.state !== 'LIVE', source: 'factory_release_runs' });
  }
  return out;
}

export interface RecordOutcomesInput {
  deadlineRef: string;
  outcomes: ReadonlyArray<TaskOutcome & { cause?: string | null }>;
  source: string;
  recordedBy: string;
}

/** Records each finished task once: the same (deadline, task) recorded again is the same row. */
export async function recordTaskOutcomes(input: RecordOutcomesInput): Promise<{ recorded: number; duplicates: number }> {
  let recorded = 0;
  for (const o of input.outcomes) {
    const res = await getDb().run(
      `INSERT INTO deadline_task_outcomes
         (id, deadline_ref, task_id, kind, estimate_min, actual_min, failed, cause, source, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (deadline_ref, task_id) DO NOTHING`,
      [newId('dto'), input.deadlineRef, o.id, o.kind, o.estimateMin ?? null, o.actualMin, o.failed ? 1 : 0, o.cause ?? null, input.source, input.recordedBy, nowIso()],
    );
    recorded += res.changes > 0 ? 1 : 0;
  }
  return { recorded, duplicates: input.outcomes.length - recorded };
}

export interface DeadlineReview {
  deadlineRef: string;
  deadlineAt: string;
  forecastAt: string | null;
  completedAt: string | null;
  met: boolean;
  verdictAtAccept: string | null;
  blockers: string[];
  avoidableWaitMin: number;
  allocationMistakes: string[];
  delays: string[];
  improvements: string[];
  /** Short, stable labels ("SEQUENTIAL_DIAGNOSIS", "OVERLAPPING_DEPLOYS"…) that make patterns countable. */
  causes: string[];
}

/** One review per deadline; recording it again changes nothing (the first is history). */
export async function recordDeadlineReview(review: DeadlineReview, recordedBy: string): Promise<boolean> {
  const res = await getDb().run(
    `INSERT INTO deadline_reviews
       (id, deadline_ref, deadline_at, forecast_at, completed_at, met, verdict_at_accept, blockers,
        avoidable_wait_min, allocation_mistakes, delays, improvements, causes, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (deadline_ref) DO NOTHING`,
    [
      newId('dlr'), review.deadlineRef, review.deadlineAt, review.forecastAt, review.completedAt, review.met ? 1 : 0,
      review.verdictAtAccept, JSON.stringify(review.blockers), review.avoidableWaitMin, JSON.stringify(review.allocationMistakes),
      JSON.stringify(review.delays), JSON.stringify(review.improvements), JSON.stringify(review.causes.map((c) => c.trim().toUpperCase())),
      recordedBy, nowIso(),
    ],
  );
  return res.changes > 0;
}

export function reviewFromRow(r: DeadlineReviewRow): DeadlineReview {
  return {
    deadlineRef: r.deadline_ref,
    deadlineAt: r.deadline_at,
    forecastAt: r.forecast_at,
    completedAt: r.completed_at,
    met: Number(r.met) === 1,
    verdictAtAccept: r.verdict_at_accept,
    blockers: parseJson<string[]>(r.blockers, []),
    avoidableWaitMin: Number(r.avoidable_wait_min),
    allocationMistakes: parseJson<string[]>(r.allocation_mistakes, []),
    delays: parseJson<string[]>(r.delays, []),
    improvements: parseJson<string[]>(r.improvements, []),
    causes: parseJson<string[]>(r.causes, []),
  };
}

export async function deadlineReviews(limit = 50): Promise<DeadlineReview[]> {
  const rows = await getDb().all<DeadlineReviewRow>('SELECT * FROM deadline_reviews ORDER BY recorded_at DESC LIMIT ?', [limit]);
  return rows.map(reviewFromRow);
}

/** A cause in at least two reviews is a recurring pattern: it calls for a permanent correction, not another explanation. */
export function recurringCauses(reviews: readonly DeadlineReview[], threshold = 2): Array<{ cause: string; deadlines: number; missed: number }> {
  const counts = new Map<string, { deadlines: number; missed: number }>();
  for (const r of reviews) {
    for (const c of new Set(r.causes)) {
      const v = counts.get(c) ?? { deadlines: 0, missed: 0 };
      v.deadlines += 1;
      if (!r.met) v.missed += 1;
      counts.set(c, v);
    }
  }
  return [...counts].filter(([, v]) => v.deadlines >= threshold).map(([cause, v]) => ({ cause, ...v })).sort((a, b) => b.deadlines - a.deadlines);
}
