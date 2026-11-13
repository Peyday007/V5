/**
 * One reading of model learning (LEARN-15-1): the ledger, its calibration, the
 * diagnosis of each contradicted forecast, the smallest reusable causes, the
 * plans to recompute, and the comparison with the next observations.
 *
 * This composes `forecast.ts` and owns nothing else — no table, schedule or
 * queue. A caller passes the prediction, exposure and outcome rows it already
 * reads; what no row states stays `null`.
 */
import {
  buildLedger,
  calibrate,
  compareAfterCorrection,
  dependentsToRecompute,
  diagnose,
  smallestReusableCauses,
  type CalibrationBucket,
  type Correction,
  type CorrectionComparison,
  type ExposureRow,
  type LedgerEntry,
  type MissDiagnosis,
  type OutcomeRow,
  type PredictionRow,
} from './forecast.ts';

export interface ModelLearningInput {
  predictions: readonly PredictionRow[];
  exposures: readonly ExposureRow[];
  outcomes: readonly OutcomeRow[];
  /** claimId -> the claims it depends on, for recomputation. */
  dependsOn?: ReadonlyMap<string, readonly string[]>;
  /** When a correction took effect, per comparable bucket, so the next observations can be compared. */
  correctedAt?: ReadonlyMap<string, string>;
  windowDays?: number;
}

export interface ModelLearningReading {
  ledger: LedgerEntry[];
  calibration: CalibrationBucket[];
  diagnoses: MissDiagnosis[];
  corrections: Correction[];
  recompute: string[];
  comparisons: { comparableKey: string; comparison: CorrectionComparison }[];
}

export function assessModelLearning(input: ModelLearningInput): ModelLearningReading {
  const ledger = buildLedger(input.predictions, input.exposures, input.outcomes);
  const calibration = calibrate(ledger, input.windowDays);
  const diagnoses = ledger.filter((e) => e.outcome).map((e) => diagnose(e, calibration, ledger));
  const corrections = smallestReusableCauses(diagnoses);
  const recompute = dependentsToRecompute(corrections, input.dependsOn ?? new Map());
  const comparisons = [...(input.correctedAt ?? new Map<string, string>())].map(([comparableKey, at]) => ({
    comparableKey,
    comparison: compareAfterCorrection(ledger, comparableKey, at),
  }));
  return { ledger, calibration, diagnoses, corrections, recompute, comparisons };
}
