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
 *     is recorded through the existing operator learning store
 *     (`operator_learnings`), and is keyed by its project so a later pass —
 *     or another goal sharing the project — never records it twice. A
 *     correction whose owner is software is handed to Factory through the
 *     operator's own entrance (`submitOperatorFix`, §106), which is
 *     idempotent per defect; it is not applied by this pass.
 *
 * The ledger is a project's, so it is judged once per project: every targeted
 * goal sharing a project reads the same corrections, recorded once. A lesson
 * is attached to a goal only when it belongs to one — every supporting
 * prediction is that goal's own, or the project has exactly one targeted
 * goal — and otherwise to the project alone (`goal_id` NULL, `project=` in its
 * evidence).
 *
 * Data boundaries: a project's lessons are computed only from its own ledger
 * and its own goal readings. A row from another project is dropped before
 * judging, never pooled.
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
import { effectiveDueAtOfRow } from '../../domain/executionWindow.ts';

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
  /** Idempotency key: the project, the cause and the exact misses that support it. */
  key: string;
  /** The one goal the lesson belongs to, or null when it is the project's alone. */
  goalId: string | null;
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
export function methodCorrections(
  reading: ModelLearningReading,
  scope: { projectId: string; goalIds?: readonly string[]; goalId?: string | null },
): MethodCorrection[] {
  const goalIds = [...new Set(scope.goalIds ?? (scope.goalId ? [scope.goalId] : []))];
  const claimOf = new Map(reading.ledger.map((entry) => [entry.prediction.id, entry.prediction.claimId]));
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
      .update([`project:${scope.projectId}`, correction.cause, ...supporting.map((s) => `${s.predictionId}|${s.evidence ?? ''}`)].join('\u0000'))
      .digest('hex')
      .slice(0, 32);
    out.push({
      key,
      goalId: owningGoal(supporting.map((s) => claimOf.get(s.predictionId) ?? ''), scope.projectId, goalIds),
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

/**
 * The one goal a project-level correction belongs to: the goal whose own plan
 * predictions are every supporting miss, or the project's only targeted goal.
 * Otherwise null — the lesson is the project's, never copied onto each goal.
 */
export function owningGoal(supportingClaims: readonly string[], projectId: string, goalIds: readonly string[]): string | null {
  const prefix = `goal:${projectId}:`;
  const owners = new Set(supportingClaims.map((claim) => (claim.startsWith(prefix) ? claim.slice(prefix.length) : null)));
  if (owners.size === 1) {
    const [only] = [...owners];
    if (only && goalIds.includes(only)) return only;
  }
  return goalIds.length === 1 ? goalIds[0]! : null;
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
export function lessonOf(c: MethodCorrection, factory?: FactoryHandoff | null): { lesson: string; evidence: string } {
  const handed = !c.needsFactory
    ? ` Owner: ${c.owner}.`
    : factory?.ok
      ? ` This is a software change: handed to Factory${factory.changeRequestId ? ` (change request ${factory.changeRequestId}${factory.campaignId ? `, campaign ${factory.campaignId}` : ''})` : ''}; it is not applied by this pass.`
      : ` This is a software change: it is Factory work and is not applied by this pass. Factory did not take it: ${factory?.reason ?? 'not submitted'}.`;
  const lesson = `${c.needsFactory ? '[FACTORY] ' : ''}${c.missClass} (${c.cause}) in ${c.comparableKeys.join(', ')}: ${c.method}.` + handed;
  const evidence =
    `${KEY_MARK}${c.key}; project=${c.projectId}; supporting ${c.supporting.length}: ` +
    c.supporting.slice(0, 12).map((s) => s.evidence ?? s.predictionId).join(', ') +
    (c.supporting.length > 12 ? `, +${c.supporting.length - 12} more` : '') +
    `; disconfirming ${c.disconfirming.length}: ` +
    c.disconfirming.slice(0, 12).map((d) => `${d.predictionId} (${d.kind})`).join(', ') +
    (c.disconfirming.length > 12 ? `, +${c.disconfirming.length - 12} more` : '');
  return { lesson, evidence };
}

/** The files that own the model a correction's buckets were predicted by. */
export function factoryOwnerPaths(c: MethodCorrection): string[] {
  const paths = new Set<string>();
  for (const key of c.comparableKeys) {
    if (key.startsWith('goal-plan:')) paths.add('server/services/goals/plan.ts');
    else {
      paths.add('server/services/quant/ledger.ts');
      paths.add('server/services/quant/forecast.ts');
    }
  }
  if (paths.size === 0) paths.add('server/services/quant/forecast.ts');
  return [...paths].sort();
}

/**
 * The defect a software correction hands Factory. Deterministic in the
 * correction, so naming it again reaches the same change request.
 */
export function factoryFixOf(c: MethodCorrection): { title: string; problem: string; evidence: string; ownerPaths: string[]; acceptance: string } {
  return {
    title: `Calibration: ${c.cause} in ${c.comparableKeys.join(', ')}`.slice(0, 200),
    problem:
      `Calibration of project ${c.projectId} found ${c.supporting.length} systematic misses in ${c.comparableKeys.join(', ')} ` +
      `caused by ${c.cause} (${c.missClass}): ${c.method}. Until the model is fixed its predictions in these buckets are miscalibrated ` +
      `and plans that rely on them are ranked on wrong figures. calibration-key=${c.key}`,
    evidence: lessonOf(c).evidence,
    ownerPaths: factoryOwnerPaths(c),
    acceptance:
      `A test reproduces the predictions behind ${c.supporting.slice(0, 3).map((s) => s.evidence ?? s.predictionId).join(', ')} ` +
      `and shows the model's stated figures agree with its own calculation from the same inputs.`,
  };
}

export interface FactoryHandoff {
  ok: boolean;
  reason: string;
  changeRequestId?: string;
  campaignId?: string;
}

export interface CalibrationPorts {
  /** Targeted goals and the project each one's target is read from. */
  goals(): Promise<{ goalId: string; projectId: string }[]>;
  /** One project's LEARN-15-1 ledger. */
  ledger(projectId: string): Promise<{ predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] }>;
  /** One project's goal plan readings and goal outcomes. */
  goalRows(projectId: string): Promise<{ readings: GoalReadingRow[]; outcomes: GoalOutcomeRow[] }>;
  /** Keys already recorded for a project, whichever goal (or none) they were attached to. */
  recordedKeys(projectId: string): Promise<Set<string>>;
  /** Record one lesson; `goalId` is null when the lesson is the project's alone. */
  record(goalId: string | null, lesson: string, evidence: string): Promise<void>;
  /** Hand a software correction to Factory. */
  toFactory(c: MethodCorrection): Promise<FactoryHandoff>;
}

export interface CalibrationPassReport {
  projectId: string;
  /** The targeted goals sharing this project's ledger. */
  goalIds: string[];
  resolved: number;
  classes: Partial<Record<MissClass, number>>;
  recorded: string[];
  alreadyRecorded: number;
  /** Software corrections handed to Factory in this pass, by key. */
  factory: { key: string; ok: boolean; reason: string; changeRequestId: string | null }[];
}

/** One pass over every project a targeted goal reads: judge its ledger once, record the corrections it has earned once. */
export async function reconcileCalibration(ports: CalibrationPorts): Promise<CalibrationPassReport[]> {
  const { assessModelLearning } = await import('../quant/learning.ts');
  const goalsOf = new Map<string, string[]>();
  for (const { goalId, projectId } of await ports.goals()) {
    const list = goalsOf.get(projectId) ?? [];
    if (!list.includes(goalId)) list.push(goalId);
    goalsOf.set(projectId, list);
  }
  const out: CalibrationPassReport[] = [];
  for (const [projectId, goalIds] of [...goalsOf.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    goalIds.sort();
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
    const corrections = methodCorrections(reading, { projectId, goalIds });
    const recorded: string[] = [];
    const factory: CalibrationPassReport['factory'] = [];
    let alreadyRecorded = 0;
    if (corrections.length > 0) {
      const have = await ports.recordedKeys(projectId);
      for (const c of corrections) {
        if (have.has(c.key)) {
          alreadyRecorded += 1;
          continue;
        }
        let handoff: FactoryHandoff | null = null;
        if (c.needsFactory) {
          try {
            handoff = await ports.toFactory(c);
          } catch (error) {
            handoff = { ok: false, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) };
          }
          factory.push({ key: c.key, ok: handoff.ok, reason: handoff.reason, changeRequestId: handoff.changeRequestId ?? null });
        }
        const { lesson, evidence } = lessonOf(c, handoff);
        await ports.record(c.goalId, lesson, evidence);
        have.add(c.key);
        recorded.push(c.key);
      }
    }
    out.push({ projectId, goalIds, resolved: reading.diagnoses.filter((d) => d.observedAt !== null).length, classes, recorded, alreadyRecorded, factory });
  }
  return out;
}

/** The production rows: targeted goals, the project ledger, goal readings and outcomes, and operator learnings. */
export async function productionCalibrationPorts(): Promise<CalibrationPorts> {
  const { getDb } = await import('../../db/database.ts');
  const { readLedger } = await import('../quant/ledger.ts');
  const { recordOperatorLearning } = await import('../../repos/operator.ts');
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
      const readings = await getDb().all<{ id: string; workstream_id: string; forecast: string | null; created_at: string; due_at: string | null; execution_window_days: number | null; execution_started_at: string | null }>(
        `SELECT r.id, r.workstream_id, r.forecast, r.created_at, w.due_at, w.execution_window_days, w.execution_started_at
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
        readings: readings.map((r) => ({ id: r.id, goalId: r.workstream_id, projectId, createdAt: r.created_at, forecast: parse(r.forecast), dueAt: effectiveDueAtOfRow(r) })),
        outcomes: outcomes
          .filter((o) => o.kind === 'ACHIEVED' || o.kind === 'MISSED')
          .map((o) => ({ id: o.id, readingId: o.reading_id, kind: o.kind as 'ACHIEVED' | 'MISSED', observedAt: o.observed_at })),
      };
    },
    async recordedKeys(projectId) {
      const keys = new Set<string>();
      const rows = await getDb().all<{ evidence: string }>(
        `SELECT evidence FROM operator_learnings WHERE evidence LIKE ? ORDER BY recorded_at, id`,
        [`${KEY_MARK}%; project=${projectId};%`],
      );
      for (const { evidence } of rows) {
        if (!evidence.includes(`; project=${projectId};`)) continue;
        keys.add(evidence.slice(KEY_MARK.length, KEY_MARK.length + 32));
      }
      return keys;
    },
    async record(goalId, lesson, evidence) {
      await recordOperatorLearning({ goalId, runId: null, lesson, evidence });
    },
    async toFactory(c) {
      const { submitOperatorFix } = await import('../operator/factory.ts');
      const result = await submitOperatorFix({ ...factoryFixOf(c), runId: null, goalId: c.goalId });
      return {
        ok: result.ok,
        reason: result.reason,
        ...(result.changeRequestId ? { changeRequestId: result.changeRequestId } : {}),
        ...(result.campaignId ? { campaignId: result.campaignId } : {}),
      };
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
