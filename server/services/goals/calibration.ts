/**
 * Predictions against results, and the method corrections a goal earns from
 * them (MEM-32, source S-0472).
 *
 * "Record predictions against actual results and perform calibration/causal
 * error analysis: was the observed difference expected variability, a bad
 * model, low-quality evidence, a changed market, an omitted dependency, or
 * execution failure? Generalize lessons into better reasoning or algorithms,
 * using Factory if software improvement is needed, while retaining supporting
 * and disconfirming evidence. Prevent one unlucky result from forcing a false
 * global rule. Make the history useful across sessions and, where authorized,
 * across compatible projects without violating data boundaries."
 *
 * This owns no calibrator. LEARN-15-1 already keeps the prediction, exposure
 * and outcome ledgers (`quant/ledger.ts`) and judges them (`quant/learning.ts`
 * → `forecast.ts`: per-bucket calibration with a minimum sample, systematic
 * versus expected misses, causes read only from measured signals or the
 * ledger's own figures, and the smallest reusable corrections). What a goal
 * adds here is three things:
 *
 *   * **Its own predictions on the same ledger shape.** A goal plan reading
 *     states a defensible probability of collecting the target
 *     (`goal_plan_readings.forecast.acceptance.probability`); `goal_outcomes`
 *     records whether it was collected. Each becomes a prediction/outcome row
 *     so the one calibrator judges it — no second implementation.
 *   * **The six classes the owner asks about**, read from the calibrator's
 *     diagnosis: an ordinary miss inside a calibrated bucket is expected
 *     variability, a systematic miss takes the class of its measured causes,
 *     and a miss nothing explains — or one below the sample a judgment needs —
 *     is UNKNOWN. A classification never comes from the miss alone.
 *   * **Corrections recorded once, with both sides of the evidence.** Only a
 *     correction the calibrator calls systematic (its bucket miscalibrated over
 *     at least `MIN_CALIBRATION_SAMPLE` resolved opportunities) and that
 *     explains at least `MIN_CORRECTION_MISSES` misses becomes a lesson, so one
 *     unlucky result never becomes a rule. Each lesson names the misses that
 *     support it and the resolved predictions in the same buckets that do not,
 *     is recorded on the goal through the existing operator learning store
 *     (`operator_learnings`), and is keyed so a later pass never records it
 *     twice. A correction whose owner is software is labelled as Factory work
 *     and is not applied here.
 *
 * Data boundaries: a goal's lessons are computed only from its own project's
 * ledger and its own project's goal readings. A row from another project is
 * dropped before judging, never pooled.
 */
import { createHash } from 'node:crypto';
import type { ModelLearningReading } from '../quant/learning.ts';
import {
  CAUSE_OWNER,
  MIN_CALIBRATION_SAMPLE,
  type CorrectionOwner,
  type ExposureRow,
  type MissCause,
  type MissDiagnosis,
  type OutcomeRow,
  type PredictionRow,
} from '../quant/forecast.ts';

/** The owner's six classes, plus UNKNOWN for a miss no measurement explains. */
export const MISS_CLASSES = [
  'EXPECTED_VARIABILITY',
  'BAD_MODEL',
  'LOW_QUALITY_EVIDENCE',
  'CHANGED_MARKET',
  'OMITTED_DEPENDENCY',
  'EXECUTION_FAILURE',
  'UNKNOWN',
] as const;
export type MissClass = (typeof MISS_CLASSES)[number];

/**
 * Which of the owner's classes each measured cause belongs to. Every LEARN-15-1
 * cause has exactly one; none of them is EXPECTED_VARIABILITY, which only the
 * calibration verdict can say.
 */
export const CAUSE_CLASS: Readonly<Record<MissCause, Exclude<MissClass, 'EXPECTED_VARIABILITY' | 'UNKNOWN'>>> = {
  MODEL_IMPLEMENTATION: 'BAD_MODEL',
  PARAMETER_ESTIMATE: 'BAD_MODEL',
  EVIDENCE_QUALITY: 'LOW_QUALITY_EVIDENCE',
  EXTERNAL_DATA_TRANSFER: 'LOW_QUALITY_EVIDENCE',
  SELECTION_BIAS: 'LOW_QUALITY_EVIDENCE',
  CHANGED_CONDITIONS: 'CHANGED_MARKET',
  DEPENDENCY_ASSUMPTION: 'OMITTED_DEPENDENCY',
  MISSING_MECHANISM: 'OMITTED_DEPENDENCY',
  EXECUTION_BEHAVIOR: 'EXECUTION_FAILURE',
  CAPACITY: 'EXECUTION_FAILURE',
  TIMING: 'EXECUTION_FAILURE',
};

/** What each cause changes about the method, specifically: the lesson a correction records. */
const METHOD_FOR: Readonly<Record<MissCause, string>> = {
  MODEL_IMPLEMENTATION: 'the model does not reproduce its own stated figures from the same inputs; fix the calculation in software before trusting the bucket again',
  PARAMETER_ESTIMATE: 're-estimate the bucket’s parameter from its measured outcomes instead of the stated estimate, and widen the interval until the re-estimate is calibrated',
  EVIDENCE_QUALITY: 'require named data behind every prediction in this bucket; a claim resting on none is not used to rank or accept a plan',
  EXTERNAL_DATA_TRANSFER: 'stop transferring figures measured on another population into this bucket; research the bucket’s own population first',
  SELECTION_BIAS: 'judge the bucket only on a fair draw of its population; the resolved sample was selected',
  CHANGED_CONDITIONS: 'the market condition the bucket assumed has changed; re-research it before the next plan relies on the old figure',
  DEPENDENCY_ASSUMPTION: 'model the dependence between these predictions; they moved together, so they are not independent draws',
  MISSING_MECHANISM: 'add the missing step to the bucket’s causal chain; the outcome needed a step the prediction did not model',
  EXECUTION_BEHAVIOR: 'the work was not done as planned; correct the execution procedure rather than the forecast',
  CAPACITY: 'plan against measured capacity; demand exceeded what the operation could serve',
  TIMING: 'lengthen the bucket’s horizon to the measured time to outcome; outcomes arrived after the stated horizon',
};

/** The fewest systematic misses one cause must explain before it is generalized into a method change. */
export const MIN_CORRECTION_MISSES = 3;

export interface MissClassification {
  predictionId: string;
  /** Empty when the outcome was not a miss. */
  classes: MissClass[];
  reason: string;
}

/**
 * The owner's class of one diagnosed prediction. Pure. Reads only the
 * calibrator's verdict and its measured causes; the miss alone names nothing.
 */
export function classifyMiss(d: MissDiagnosis): MissClassification {
  const base = { predictionId: d.predictionId };
  switch (d.kind) {
    case 'NOT_A_MISS':
      return { ...base, classes: [], reason: d.reason };
    case 'EXPECTED_MISS':
      return { ...base, classes: ['EXPECTED_VARIABILITY'], reason: d.reason };
    case 'UNJUDGED':
      return { ...base, classes: d.observedAt ? ['UNKNOWN'] : [], reason: d.reason };
    case 'SYSTEMATIC': {
      const classes = [...new Set(d.causes.map((cause) => CAUSE_CLASS[cause]))];
      return classes.length > 0
        ? { ...base, classes, reason: d.reason }
        : { ...base, classes: ['UNKNOWN'], reason: `${d.reason}; no measurement names a cause, so the class is unknown` };
    }
  }
}

export interface MethodCorrection {
  /** Idempotency key: the goal, the cause and the exact misses that support it. */
  key: string;
  goalId: string;
  projectId: string;
  cause: MissCause;
  missClass: MissClass;
  owner: CorrectionOwner;
  /** True when the correction is a software change: it is Factory work and is not applied here. */
  needsFactory: boolean;
  method: string;
  /** The systematic misses this cause explains. */
  supporting: { predictionId: string; evidence: string | null }[];
  /** Resolved predictions in the same comparable buckets that this cause does not explain. */
  disconfirming: { predictionId: string; kind: MissDiagnosis['kind'] }[];
  comparableKeys: string[];
}

/**
 * The corrections a reading warrants for one goal. Pure.
 *
 * Only what the calibrator already called systematic, and only a cause that
 * explains at least `MIN_CORRECTION_MISSES` misses: a single unlucky result —
 * or a run of them in a bucket below the minimum sample, which the calibrator
 * leaves UNJUDGED — never becomes a method change.
 */
export function methodCorrections(reading: ModelLearningReading, scope: { goalId: string; projectId: string }): MethodCorrection[] {
  const bucketOf = new Map(reading.ledger.map((entry) => [entry.prediction.id, entry.prediction.comparableKey]));
  const out: MethodCorrection[] = [];
  for (const correction of reading.corrections) {
    if (correction.misses < MIN_CORRECTION_MISSES) continue;
    const supportingDiagnoses = reading.diagnoses.filter((d) => d.kind === 'SYSTEMATIC' && d.causes.includes(correction.cause));
    const comparableKeys = [...new Set(supportingDiagnoses.map((d) => bucketOf.get(d.predictionId)).filter((k): k is string => !!k))].sort();
    const supporting = supportingDiagnoses
      .map((d) => ({ predictionId: d.predictionId, evidence: d.evidence }))
      .sort((a, b) => `${a.predictionId}${a.evidence ?? ''}`.localeCompare(`${b.predictionId}${b.evidence ?? ''}`));
    const disconfirming = reading.diagnoses
      .filter((d) => d.observedAt !== null && comparableKeys.includes(bucketOf.get(d.predictionId) ?? '') && !(d.kind === 'SYSTEMATIC' && d.causes.includes(correction.cause)))
      .map((d) => ({ predictionId: d.predictionId, kind: d.kind }))
      .sort((a, b) => a.predictionId.localeCompare(b.predictionId));
    const owner = CAUSE_OWNER[correction.cause];
    const key = createHash('sha256')
      .update([scope.goalId, correction.cause, ...supporting.map((s) => `${s.predictionId}|${s.evidence ?? ''}`)].join('\u0000'))
      .digest('hex')
      .slice(0, 32);
    out.push({
      key,
      goalId: scope.goalId,
      projectId: scope.projectId,
      cause: correction.cause,
      missClass: CAUSE_CLASS[correction.cause],
      owner,
      needsFactory: owner === 'FACTORY',
      method: METHOD_FOR[correction.cause],
      supporting,
      disconfirming,
      comparableKeys,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* A goal's own predictions, on the ledger's shape                            */
/* ------------------------------------------------------------------------- */

export interface GoalReadingRow {
  id: string;
  goalId: string;
  projectId: string;
  createdAt: string;
  /** `goal_plan_readings.forecast` as stored. */
  forecast: Record<string, unknown> | null;
  dueAt: string | null;
}

export interface GoalOutcomeRow {
  id: string;
  readingId: string;
  kind: 'ACHIEVED' | 'MISSED';
  observedAt: string;
}

/** The comparable bucket a goal plan's probability is judged in: by the basis that produced it. */
export function goalComparableKey(basis: string): string {
  return `goal-plan:${basis}`;
}

/**
 * Goal plan readings as ledger rows. Pure. A reading states a prediction only
 * when its acceptance carries a defensible probability; coverage of assumed
 * inputs is not a probability and states nothing. An outcome resolves the
 * reading it was recorded against.
 */
export function goalPredictionRows(
  readings: readonly GoalReadingRow[],
  outcomes: readonly GoalOutcomeRow[],
): { predictions: PredictionRow[]; outcomes: OutcomeRow[] } {
  const predictions: PredictionRow[] = [];
  const stated = new Set<string>();
  for (const r of readings) {
    const acceptance = r.forecast && typeof r.forecast.acceptance === 'object' ? (r.forecast.acceptance as Record<string, unknown> | null) : null;
    const probability = acceptance && typeof acceptance.probability === 'object' ? (acceptance.probability as Record<string, unknown> | null) : null;
    const value = probability && typeof probability.value === 'number' ? probability.value : null;
    const basis = probability && typeof probability.basis === 'string' ? probability.basis : null;
    if (value === null || basis === null || !(value >= 0 && value <= 1)) continue;
    const horizonDays = r.dueAt ? Math.max(0, Math.ceil((Date.parse(r.dueAt) - Date.parse(r.createdAt)) / 86_400_000)) : null;
    predictions.push({
      id: `goal:${r.projectId}:${r.goalId}:${r.id}`,
      claimId: `goal:${r.projectId}:${r.goalId}`,
      version: predictions.filter((p) => p.claimId === `goal:${r.projectId}:${r.goalId}`).length + 1,
      outcome: 'the goal collects its target before its due date',
      horizonDays: Number.isFinite(horizonDays) ? horizonDays : null,
      population: `goal ${r.goalId}`,
      data: [`goal_plan_readings:${r.id}`],
      assumptions: typeof probability?.note === 'string' && probability.note ? [probability.note] : [],
      probability: value,
      comparableKey: goalComparableKey(basis),
      madeAt: r.createdAt,
    });
    stated.add(r.id);
  }
  const byReading = new Map(predictions.map((p) => [p.id.split(':').at(-1)!, p.id]));
  const resolved: OutcomeRow[] = outcomes
    .filter((o) => stated.has(o.readingId))
    .map((o) => ({ predictionId: byReading.get(o.readingId)!, observedAt: o.observedAt, occurred: o.kind === 'ACHIEVED', evidence: `goal_outcomes:${o.id}` }));
  return { predictions, outcomes: resolved };
}

/** Keep only rows whose claim belongs to `projectId`: a goal never learns from another project's rows. */
export function withinProject<T extends { claimId?: string; predictionId?: string }>(rows: readonly T[], projectId: string, projectOf: (id: string) => string | null): T[] {
  return rows.filter((row) => {
    const id = row.claimId ?? row.predictionId ?? '';
    return projectOf(id) === projectId;
  });
}

/** The project a ledger id names: a cash claim (`cash:<project>:…`) or a goal claim (`goal:<project>:…`). */
export function projectOfLedgerId(id: string): string | null {
  const [kind, project] = id.split(':');
  if ((kind === 'cash' || kind === 'goal') && project) return project;
  return null;
}

/* ------------------------------------------------------------------------- */
/* Recording, and the production pass                                         */
/* ------------------------------------------------------------------------- */

const KEY_MARK = 'calibration-key=';

/** The lesson and evidence text a correction is recorded with. Both sides of the evidence are kept. */
export function lessonOf(c: MethodCorrection): { lesson: string; evidence: string } {
  const lesson =
    `${c.needsFactory ? '[FACTORY] ' : ''}${c.missClass} (${c.cause}) in ${c.comparableKeys.join(', ')}: ${c.method}.` +
    (c.needsFactory ? ' This is a software change: it is Factory work and is not applied by this pass.' : ` Owner: ${c.owner}.`);
  const evidence =
    `${KEY_MARK}${c.key}; project=${c.projectId}; supporting ${c.supporting.length}: ` +
    c.supporting.slice(0, 12).map((s) => s.evidence ?? s.predictionId).join(', ') +
    (c.supporting.length > 12 ? `, +${c.supporting.length - 12} more` : '') +
    `; disconfirming ${c.disconfirming.length}: ` +
    c.disconfirming.slice(0, 12).map((d) => `${d.predictionId} (${d.kind})`).join(', ') +
    (c.disconfirming.length > 12 ? `, +${c.disconfirming.length - 12} more` : '');
  return { lesson, evidence };
}

export interface CalibrationPorts {
  /** Targeted goals and the project each one's target is read from. */
  goals(): Promise<{ goalId: string; projectId: string }[]>;
  /** One project's LEARN-15-1 ledger. */
  ledger(projectId: string): Promise<{ predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] }>;
  /** One project's goal plan readings and goal outcomes. */
  goalRows(projectId: string): Promise<{ readings: GoalReadingRow[]; outcomes: GoalOutcomeRow[] }>;
  /** Keys already recorded on a goal. */
  recordedKeys(goalId: string): Promise<Set<string>>;
  record(goalId: string, lesson: string, evidence: string): Promise<void>;
}

export interface CalibrationPassReport {
  goalId: string;
  projectId: string;
  resolved: number;
  classes: Partial<Record<MissClass, number>>;
  recorded: string[];
  alreadyRecorded: number;
}

/** One pass over every targeted goal: judge its project's predictions, record the corrections it has earned. */
export async function reconcileCalibration(ports: CalibrationPorts): Promise<CalibrationPassReport[]> {
  const { assessModelLearning } = await import('../quant/learning.ts');
  const out: CalibrationPassReport[] = [];
  for (const { goalId, projectId } of await ports.goals()) {
    const ledger = await ports.ledger(projectId);
    const goalRows = await ports.goalRows(projectId);
    const own = goalPredictionRows(
      goalRows.readings.filter((r) => r.projectId === projectId),
      goalRows.outcomes,
    );
    const predictions = withinProject([...ledger.predictions, ...own.predictions], projectId, projectOfLedgerId);
    const kept = new Set(predictions.map((p) => p.id));
    const reading = assessModelLearning({
      predictions,
      exposures: ledger.exposures.filter((e) => kept.has(e.predictionId)),
      outcomes: [...ledger.outcomes, ...own.outcomes].filter((o) => kept.has(o.predictionId)),
    });
    const classes: Partial<Record<MissClass, number>> = {};
    for (const d of reading.diagnoses) {
      for (const c of classifyMiss(d).classes) classes[c] = (classes[c] ?? 0) + 1;
    }
    const corrections = methodCorrections(reading, { goalId, projectId });
    const recorded: string[] = [];
    let alreadyRecorded = 0;
    if (corrections.length > 0) {
      const have = await ports.recordedKeys(goalId);
      for (const c of corrections) {
        if (have.has(c.key)) {
          alreadyRecorded += 1;
          continue;
        }
        const { lesson, evidence } = lessonOf(c);
        await ports.record(goalId, lesson, evidence);
        have.add(c.key);
        recorded.push(c.key);
      }
    }
    out.push({ goalId, projectId, resolved: reading.diagnoses.filter((d) => d.observedAt !== null).length, classes, recorded, alreadyRecorded });
  }
  return out;
}

/** The production rows: targeted goals, the project ledger, goal readings and outcomes, and operator learnings. */
export async function productionCalibrationPorts(): Promise<CalibrationPorts> {
  const { getDb } = await import('../../db/database.ts');
  const { readLedger } = await import('../quant/ledger.ts');
  const { listOperatorLearnings, recordOperatorLearning } = await import('../../repos/operator.ts');
  const parse = (text: string | null): Record<string, unknown> | null => {
    if (!text) return null;
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    async goals() {
      const rows = await getDb().all<{ id: string; target_project_id: string }>(
        `SELECT id, target_project_id FROM workstreams WHERE target_project_id IS NOT NULL ORDER BY id`,
      );
      return rows.map((r) => ({ goalId: r.id, projectId: r.target_project_id }));
    },
    ledger: (projectId) => readLedger(projectId),
    async goalRows(projectId) {
      const readings = await getDb().all<{ id: string; workstream_id: string; forecast: string | null; created_at: string; due_at: string | null }>(
        `SELECT r.id, r.workstream_id, r.forecast, r.created_at, w.due_at
           FROM goal_plan_readings r JOIN workstreams w ON w.id = r.workstream_id
          WHERE w.target_project_id = ?
          ORDER BY r.created_at, r.id`,
        [projectId],
      );
      const outcomes = await getDb().all<{ id: string; reading_id: string; kind: string; observed_at: string }>(
        `SELECT o.id, o.reading_id, o.kind, o.observed_at
           FROM goal_outcomes o JOIN workstreams w ON w.id = o.workstream_id
          WHERE w.target_project_id = ?
          ORDER BY o.observed_at, o.id`,
        [projectId],
      );
      return {
        readings: readings.map((r) => ({ id: r.id, goalId: r.workstream_id, projectId, createdAt: r.created_at, forecast: parse(r.forecast), dueAt: r.due_at })),
        outcomes: outcomes
          .filter((o) => o.kind === 'ACHIEVED' || o.kind === 'MISSED')
          .map((o) => ({ id: o.id, readingId: o.reading_id, kind: o.kind as 'ACHIEVED' | 'MISSED', observedAt: o.observed_at })),
      };
    },
    async recordedKeys(goalId) {
      const keys = new Set<string>();
      for (const learning of await listOperatorLearnings({ goalId, limit: 1000 })) {
        const at = learning.evidence.indexOf(KEY_MARK);
        if (at >= 0) keys.add(learning.evidence.slice(at + KEY_MARK.length, at + KEY_MARK.length + 32));
      }
      return keys;
    },
    async record(goalId, lesson, evidence) {
      await recordOperatorLearning({ goalId, runId: null, lesson, evidence });
    },
  };
}

/** How often the goals tick runs the calibration pass. */
export const CALIBRATION_PASS_EVERY_MS = 30 * 60_000;
let lastCalibrationPass = 0;

/** At most every half hour, from the goals tick. A failure is reported, never thrown into the tick. */
export async function reconcileCalibrationIfDue(now = Date.now(), ports?: CalibrationPorts): Promise<CalibrationPassReport[] | { error: string } | null> {
  if (now - lastCalibrationPass < CALIBRATION_PASS_EVERY_MS) return null;
  lastCalibrationPass = now;
  try {
    return await reconcileCalibration(ports ?? (await productionCalibrationPorts()));
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/** Exposed for tests and readers: the sample below which no bucket is judged at all. */
export const CALIBRATION_MIN_SAMPLE = MIN_CALIBRATION_SAMPLE;
