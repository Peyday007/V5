/**
 * How long goal work takes, and where. Per goal and per stage: time spent,
 * candidates screened, rejected and advanced, research jobs, AI passes, what
 * was found, and why it is slow. Derived on the read path from rows that already
 * exist; nothing is stored, nothing is estimated, and a figure no row states is
 * `null` — printed as unknown, never as zero.
 *
 * Reading it changes nothing and bounds nothing: there is no time budget here,
 * and no work is abandoned because of what this says.
 */
import { getDb } from '../../../db/database.ts';

export const MEASURE_STAGES = ['CODE_SCREEN', 'TARGETED_INVESTIGATION', 'PLAN_CONSTRUCTION', 'DEEP_REASONING', 'EXECUTION'] as const;
export type MeasureStage = (typeof MEASURE_STAGES)[number];

export const STAGE_LABEL: Record<MeasureStage, string> = {
  CODE_SCREEN: 'code screen',
  TARGETED_INVESTIGATION: 'targeted investigation',
  PLAN_CONSTRUCTION: 'simulation and plan construction',
  DEEP_REASONING: 'deep reasoning',
  EXECUTION: 'execution',
};

export interface StageMeasure {
  stage: MeasureStage;
  /** Wall time spent in the stage, or null when no row records it. */
  timeMs: number | null;
  candidatesScreened: number | null;
  candidatesRejected: number | null;
  candidatesAdvanced: number | null;
  researchJobs: number | null;
  /** Model passes the stage consumed on the subscription fleet. */
  aiPasses: number | null;
  /** What the stage cannot say, and why. */
  unmeasured: string[];
}

export interface GoalMeasurement {
  goalId: string;
  stages: StageMeasure[];
  relevantOpenings: number | null;
  supportedPlans: number | null;
  bottlenecks: string[];
}

export interface MeasureInput {
  goalId: string;
  /** From the plan reading: every opening judged, how many fitted the simulation, how many were left out. */
  considered: number;
  modelled: number;
  excluded: number;
  /** Openings whose evidence links are all established. */
  relevantOpenings: number;
  /** Strategies whose verdict is recommendable. */
  supportedPlans: number;
  needsMoreOpenings: boolean;
  /** Plan readings recorded for the goal, oldest first. */
  readingTimes: string[];
  orchestrations: { id: string; status: string; queuedAt: string; startedAt: string | null; endedAt: string | null }[];
  passes: { passKey: string; status: string; durationMs: number | null }[];
  now: Date;
}

const INVESTIGATION_PASSES = new Set(['PLAN', 'BROAD_SCAN', 'TARGETED', 'VERIFICATION']);
const REASONING_PASSES = new Set(['SYNTHESIS', 'ADVERSARIAL', 'AUDIT']);
const LIVE = new Set(['QUEUED', 'PLANNING', 'RESEARCHING', 'SYNTHESIZING', 'AUDITING', 'AWAITING_REPAIR']);

function sumDurations(passes: MeasureInput['passes']): number | null {
  const timed = passes.filter((one) => one.durationMs !== null);
  return timed.length === 0 ? null : timed.reduce((n, one) => n + (one.durationMs ?? 0), 0);
}

export function measureGoal(input: MeasureInput): GoalMeasurement {
  const investigation = input.passes.filter((one) => INVESTIGATION_PASSES.has(one.passKey));
  const reasoning = input.passes.filter((one) => REASONING_PASSES.has(one.passKey));
  const lastReading = input.readingTimes.at(-1);
  const firstReading = input.readingTimes[0];

  const screen: StageMeasure = {
    stage: 'CODE_SCREEN',
    timeMs: null,
    candidatesScreened: input.considered + input.excluded,
    candidatesRejected: input.excluded,
    candidatesAdvanced: input.modelled,
    researchJobs: 0,
    aiPasses: 0,
    unmeasured: ['time: the screen runs inside a plan reading and records no duration'],
  };
  const targeted: StageMeasure = {
    stage: 'TARGETED_INVESTIGATION',
    timeMs: sumDurations(investigation),
    candidatesScreened: null,
    candidatesRejected: null,
    candidatesAdvanced: null,
    researchJobs: input.orchestrations.length,
    aiPasses: investigation.length,
    unmeasured: investigation.length > 0 && sumDurations(investigation) === null ? ['time: no pass recorded a duration'] : [],
  };
  const construction: StageMeasure = {
    stage: 'PLAN_CONSTRUCTION',
    timeMs: firstReading && lastReading ? Date.parse(lastReading) - Date.parse(firstReading) : null,
    candidatesScreened: null,
    candidatesRejected: null,
    candidatesAdvanced: null,
    researchJobs: 0,
    aiPasses: 0,
    unmeasured: [
      `time is the span between the first and last of ${input.readingTimes.length} recorded plan reading(s), which includes waiting, not compute`,
    ],
  };
  const deep: StageMeasure = {
    stage: 'DEEP_REASONING',
    timeMs: sumDurations(reasoning),
    candidatesScreened: null,
    candidatesRejected: null,
    candidatesAdvanced: null,
    researchJobs: 0,
    aiPasses: reasoning.length,
    unmeasured: reasoning.length > 0 && sumDurations(reasoning) === null ? ['time: no pass recorded a duration'] : [],
  };
  const execution: StageMeasure = {
    stage: 'EXECUTION',
    timeMs: null,
    candidatesScreened: null,
    candidatesRejected: null,
    candidatesAdvanced: null,
    researchJobs: null,
    aiPasses: null,
    unmeasured: ['execution is recorded on each opening\'s own job, not against the goal'],
  };

  const bottlenecks: string[] = [];
  if (input.needsMoreOpenings) bottlenecks.push('the openings held cannot reach the goal however combined, so more must be found');
  const live = input.orchestrations.filter((one) => LIVE.has(one.status));
  for (const one of live) {
    const since = Date.parse(one.startedAt ?? one.queuedAt);
    const hours = Math.round(((input.now.getTime() - since) / 3_600_000) * 10) / 10;
    bottlenecks.push(`${one.id} is ${one.status}${one.startedAt ? '' : ' and has not started'}, ${hours} h since ${one.startedAt ? 'it started' : 'it was queued'}`);
  }
  const waiting = live.filter((one) => !one.startedAt).length;
  if (waiting > 0) bottlenecks.push(`${waiting} research job(s) are queued and waiting for a worker`);
  const failed = input.orchestrations.filter((one) => one.status === 'FAILED' || one.status === 'NEEDS_HUMAN').length;
  if (failed > 0) bottlenecks.push(`${failed} research job(s) ended failed or waiting on a person`);
  const failedPasses = input.passes.filter((one) => one.status === 'FAILED').length;
  if (failedPasses > 0) bottlenecks.push(`${failedPasses} model pass(es) failed and were spent`);

  return { goalId: input.goalId, stages: [screen, targeted, construction, deep, execution], relevantOpenings: input.relevantOpenings, supportedPlans: input.supportedPlans, bottlenecks };
}

/** Rows for one goal, read once. */
export async function readMeasureRows(goalId: string): Promise<Pick<MeasureInput, 'readingTimes' | 'orchestrations' | 'passes'>> {
  const db = getDb();
  const readings = await db.all<{ created_at: string }>('SELECT created_at FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at ASC', [goalId]);
  const orchestrations = await db.all<{ id: string; status: string; queued_at: string; started_at: string | null; completed_at: string | null; failed_at: string | null; cancelled_at: string | null }>(
    'SELECT id, status, queued_at, started_at, completed_at, failed_at, cancelled_at FROM research_orchestrations WHERE goal_id = ?',
    [goalId],
  );
  const passes = await db.all<{ pass_key: string; status: string; duration_ms: number | null }>(
    'SELECT p.pass_key, p.status, p.duration_ms FROM research_passes p JOIN research_orchestrations o ON o.id = p.orchestration_id WHERE o.goal_id = ?',
    [goalId],
  );
  return {
    readingTimes: readings.map((one) => one.created_at),
    orchestrations: orchestrations.map((one) => ({ id: one.id, status: one.status, queuedAt: one.queued_at, startedAt: one.started_at, endedAt: one.completed_at ?? one.failed_at ?? one.cancelled_at })),
    passes: passes.map((one) => ({ passKey: one.pass_key, status: one.status, durationMs: one.duration_ms })),
  };
}
