/**
 * A prediction is an auditable claim, and a miss is a question about which part
 * of the claim was wrong (LEARN-15-1).
 *
 * This module is pure: it reads the prediction, exposure and outcome rows a
 * caller passes in (the rows `ledger.ts` writes and reads back) and returns
 * judgments. It owns no table, no schedule and no queue —
 * a ledger is a set of rows, and this reads them. Nothing here reads prose.
 *
 *  - A prediction names its outcome, horizon, population, data and assumptions,
 *    and is versioned: a revision is a new row that supersedes, never an edit.
 *  - An outcome is compared with the version that was current *when it was
 *    exposed*, not with whatever the model says today.
 *  - One miss is not evidence. Calibration is judged across comparable
 *    opportunities and time windows, and a miss inside a calibrated
 *    distribution is an ordinary miss — a calibrated 90% forecast does not
 *    forbid the 10% outcome, and not every miss is a black swan.
 *  - A systematic miss is diagnosed to a named cause class, the smallest
 *    reusable cause is assigned to the owner that can correct it (Factory only
 *    for software), and dependents are recomputed and compared with the next
 *    production observations.
 *  - A figure no row states is `null`, never an assumption.
 */

export const MISS_CAUSES = [
  'EVIDENCE_QUALITY',
  'EXTERNAL_DATA_TRANSFER',
  'MISSING_MECHANISM',
  'SELECTION_BIAS',
  'PARAMETER_ESTIMATE',
  'DEPENDENCY_ASSUMPTION',
  'CAPACITY',
  'TIMING',
  'MODEL_IMPLEMENTATION',
  'EXECUTION_BEHAVIOR',
  'CHANGED_CONDITIONS',
] as const;
export type MissCause = (typeof MISS_CAUSES)[number];

export type CorrectionOwner = 'FACTORY' | 'RESEARCH' | 'COMMERCIAL_OPERATIONS';

/** Which owner corrects a cause: Factory only when the defect is in software. */
export const CAUSE_OWNER: Readonly<Record<MissCause, CorrectionOwner>> = {
  EVIDENCE_QUALITY: 'RESEARCH',
  EXTERNAL_DATA_TRANSFER: 'RESEARCH',
  MISSING_MECHANISM: 'RESEARCH',
  SELECTION_BIAS: 'RESEARCH',
  PARAMETER_ESTIMATE: 'RESEARCH',
  DEPENDENCY_ASSUMPTION: 'RESEARCH',
  CAPACITY: 'COMMERCIAL_OPERATIONS',
  TIMING: 'COMMERCIAL_OPERATIONS',
  MODEL_IMPLEMENTATION: 'FACTORY',
  EXECUTION_BEHAVIOR: 'COMMERCIAL_OPERATIONS',
  CHANGED_CONDITIONS: 'RESEARCH',
};

/** A versioned claim about a defined outcome, horizon and population. */
export interface PredictionRow {
  id: string;
  /** The claim this row is a version of; a revision shares it. */
  claimId: string;
  version: number;
  outcome: string;
  horizonDays: number | null;
  population: string;
  /** What the claim rests on, by name. Empty is a finding, not a default. */
  data: readonly string[];
  assumptions: readonly string[];
  /** Stated probability that the outcome occurs, or null when it is a point estimate only (see `impliedProbability` for an interval claim). */
  probability: number | null;
  /** The comparable-opportunity bucket the calibration is judged within. */
  comparableKey: string;
  madeAt: string;
}

/** What was put at risk on one version of a claim. */
export interface ExposureRow {
  predictionId: string;
  exposedAt: string;
  /** Money at risk in cents, or null when no row states it. */
  atRiskCents: number | null;
}

/** What actually happened, recorded once, against the version exposed. */
export interface OutcomeRow {
  predictionId: string;
  observedAt: string;
  occurred: boolean;
  /** Evidence a person or a measurement gave for why, by cause class, when known. */
  observedCauses?: readonly MissCause[];
}

export interface LedgerEntry {
  prediction: PredictionRow;
  exposure: ExposureRow | null;
  outcome: OutcomeRow | null;
}

/**
 * The probability a claim states, or the one its own stated interval implies.
 *
 * A stated probability is used as it is. A point estimate that states no
 * probability but does state an interval drawn from a sample — the form the
 * cash forecast is recorded in (`ledger.ts recordCashForecast`: "… (range
 * LOW..HIGH)" in the outcome, "derived from N opportunity row(s)" among the
 * assumptions) — is a claim that the realized figure lands inside that range,
 * and the range is the minimum and maximum of N rows. Distribution-free, the
 * chance that one further draw lands between the extremes of N exchangeable
 * draws is (N − 1) / (N + 1). That is the probability the claim carries, so
 * production predictions can be judged CALIBRATED or MISCALIBRATED like any
 * other: a range drawn from too few or too unrepresentative rows shows up as a
 * gap between that implied rate and how often the figure actually landed.
 *
 * `occurred` on such a claim's outcome means the figure landed in the range.
 * Below two rows there is no spread to imply anything, and an interval that is
 * empty or reversed implies nothing either: those stay null — unjudged, never
 * a default.
 */
export function impliedProbability(p: Pick<PredictionRow, 'probability' | 'outcome' | 'assumptions'>): number | null {
  if (p.probability !== null) return p.probability;
  const range = /\(range (-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\)/.exec(p.outcome);
  if (!range) return null;
  const low = Number(range[1]);
  const high = Number(range[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return null;
  let rows: number | null = null;
  for (const a of p.assumptions) {
    const m = /derived from (\d+) opportunity row/.exec(a);
    if (m) rows = Number(m[1]);
  }
  if (rows === null || !Number.isInteger(rows) || rows < 2) return null;
  return (rows - 1) / (rows + 1);
}

/** The version of each claim that was current at `at`: the latest made on or before it. */
export function versionAt(predictions: readonly PredictionRow[], claimId: string, at: string): PredictionRow | null {
  let found: PredictionRow | null = null;
  for (const p of predictions) {
    if (p.claimId !== claimId || p.madeAt > at) continue;
    if (!found || p.version > found.version) found = p;
  }
  return found;
}

/** Joins the three ledgers by the version exposed; an outcome with no such version is dropped, not guessed. */
export function buildLedger(
  predictions: readonly PredictionRow[],
  exposures: readonly ExposureRow[],
  outcomes: readonly OutcomeRow[],
): LedgerEntry[] {
  const exposureOf = new Map(exposures.map((e) => [e.predictionId, e]));
  const outcomeOf = new Map(outcomes.map((o) => [o.predictionId, o]));
  return predictions.map((prediction) => ({
    prediction,
    exposure: exposureOf.get(prediction.id) ?? null,
    outcome: outcomeOf.get(prediction.id) ?? null,
  }));
}

export interface CalibrationBucket {
  comparableKey: string;
  windowStart: string | null;
  windowEnd: string | null;
  /** A time window, or every window of the comparable bucket pooled so a thin window does not hide a systematic gap. */
  scope: 'WINDOW' | 'POOLED';
  /** Resolved opportunities with a stated probability. */
  n: number;
  meanForecast: number | null;
  observedRate: number | null;
  /** Observed minus forecast; null below the sample a judgment needs. */
  gap: number | null;
  /** How many standard errors the gap is from zero; null when it cannot be stated. */
  zScore: number | null;
  verdict: 'INSUFFICIENT' | 'CALIBRATED' | 'MISCALIBRATED';
}

/** The fewest resolved opportunities in a bucket before it may be called anything. */
export const MIN_CALIBRATION_SAMPLE = 20;
/** |z| beyond which a bucket's gap is not an ordinary miss. */
export const MISCALIBRATION_Z = 2;

/**
 * Calibration across comparable opportunities, per bucket and per time window,
 * and pooled over all windows of a bucket: a bucket that resolves a few
 * opportunities per window would otherwise never reach the minimum sample and
 * so never be judged. Both are judged on the same rule; either being
 * miscalibrated counts. A single win or loss lands in `INSUFFICIENT`.
 */
export function calibrate(entries: readonly LedgerEntry[], windowDays = 90): CalibrationBucket[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    if (!e.outcome || impliedProbability(e.prediction) === null) continue;
    const window = Math.floor(Date.parse(e.outcome.observedAt) / (windowDays * 86_400_000));
    const key = `${e.prediction.comparableKey}\u0000${Number.isFinite(window) ? window : 'undated'}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const pooled = new Map<string, LedgerEntry[]>();
  for (const [key, list] of groups) {
    const comparable = key.split('\u0000')[0]!;
    pooled.set(comparable, [...(pooled.get(comparable) ?? []), ...list]);
  }
  const out: CalibrationBucket[] = [];
  const judge = (comparableKey: string, list: LedgerEntry[], scope: CalibrationBucket['scope']): void => {
    const n = list.length;
    const prob = (e: LedgerEntry): number => impliedProbability(e.prediction) as number;
    const meanForecast = list.reduce((s, e) => s + prob(e), 0) / n;
    const observedRate = list.filter((e) => e.outcome!.occurred).length / n;
    const dates = list.map((e) => e.outcome!.observedAt).sort();
    // Standard error of a sum of independent Bernoulli forecasts, from the forecasts themselves.
    const variance = list.reduce((s, e) => s + prob(e) * (1 - prob(e)), 0);
    const enough = n >= MIN_CALIBRATION_SAMPLE;
    const zScore = enough && variance > 0 ? (observedRate * n - meanForecast * n) / Math.sqrt(variance) : null;
    out.push({
      comparableKey,
      windowStart: dates[0] ?? null,
      windowEnd: dates[dates.length - 1] ?? null,
      scope,
      n,
      meanForecast,
      observedRate,
      gap: enough ? observedRate - meanForecast : null,
      zScore,
      verdict: !enough || zScore === null ? 'INSUFFICIENT' : Math.abs(zScore) > MISCALIBRATION_Z ? 'MISCALIBRATED' : 'CALIBRATED',
    });
  };
  for (const [key, list] of groups) judge(key.split('\u0000')[0]!, list, 'WINDOW');
  // Pooled only where pooling adds something: more than one window held entries.
  for (const [comparable, list] of pooled) {
    const windows = [...groups.keys()].filter((k) => k.startsWith(`${comparable}\u0000`)).length;
    if (windows > 1) judge(comparable, list, 'POOLED');
  }
  return out.sort((a, b) => a.comparableKey.localeCompare(b.comparableKey) || a.scope.localeCompare(b.scope) || (a.windowStart ?? '').localeCompare(b.windowStart ?? ''));
}

export interface MissDiagnosis {
  predictionId: string;
  claimId: string;
  version: number;
  /** A contradicted forecast: the outcome occurred against a low probability, or failed against a high one. */
  contradicted: boolean;
  /** What the surprise was worth: the probability the forecast gave the outcome that actually happened. */
  probabilityOfWhatHappened: number | null;
  /** -log2 of that probability: a 90% forecast that fails (3.3 bits) is a bigger surprise than a 40% forecast that comes true (1.3 bits). Null when no probability was stated. */
  surpriseBits: number | null;
  kind: 'NOT_A_MISS' | 'EXPECTED_MISS' | 'SYSTEMATIC' | 'UNJUDGED';
  /** Causes the evidence names; empty means unattributed, never a default cause. */
  causes: readonly MissCause[];
  owner: CorrectionOwner | null;
  /** Every owner the named causes need; `owner` is the one that acts first. */
  owners: readonly CorrectionOwner[];
  /** Gaps in the claim itself that make a cause plausible. */
  claimGaps: readonly string[];
  reason: string;
}

/**
 * Diagnoses one resolved prediction against the calibration of its bucket.
 * A miss inside a calibrated bucket is an ordinary miss; only a miscalibrated
 * bucket makes it systematic, and then the causes come from what was observed
 * plus structural gaps in the claim, never from the miss alone.
 */
export function diagnose(entry: LedgerEntry, buckets: readonly CalibrationBucket[]): MissDiagnosis {
  const { prediction: p, outcome } = entry;
  const base = { predictionId: p.id, claimId: p.claimId, version: p.version };
  if (!outcome) {
    return { ...base, contradicted: false, probabilityOfWhatHappened: null, surpriseBits: null, kind: 'UNJUDGED', causes: [], owner: null, owners: [], claimGaps: [], reason: 'no outcome has been recorded for this version' };
  }
  const stated = impliedProbability(p);
  const given = stated === null ? null : outcome.occurred ? stated : 1 - stated;
  const contradicted = given !== null && given < 0.5;
  // Zero given to what happened is an unbounded surprise; keep it a finite, comparable number.
  const surpriseBits = given === null ? null : -Math.log2(Math.max(given, 1e-6));
  const claimGaps: string[] = [];
  if (p.data.length === 0) claimGaps.push('the claim names no data it rests on');
  if (p.assumptions.length === 0) claimGaps.push('the claim states no assumptions');
  if (p.horizonDays === null) claimGaps.push('the claim states no horizon');
  if (!contradicted) {
    return { ...base, contradicted, probabilityOfWhatHappened: given, surpriseBits, kind: 'NOT_A_MISS', causes: [], owner: null, owners: [], claimGaps, reason: given === null ? 'a point estimate states no probability to contradict' : 'the outcome was the likelier one' };
  }
  const own = buckets.filter((b) => b.comparableKey === p.comparableKey);
  const miscalibrated = own.some((b) => b.verdict === 'MISCALIBRATED');
  const judged = own.some((b) => b.verdict !== 'INSUFFICIENT');
  if (!miscalibrated) {
    return {
      ...base,
      contradicted,
      probabilityOfWhatHappened: given,
      surpriseBits,
      kind: judged ? 'EXPECTED_MISS' : 'UNJUDGED',
      causes: [],
      owner: null,
      owners: [],
      claimGaps,
      reason: judged
        ? 'the comparable bucket is calibrated, so this is the ordinary downside the forecast allowed for, not a model failure'
        : `fewer than ${MIN_CALIBRATION_SAMPLE} comparable resolved opportunities: one miss is not evidence either way`,
    };
  }
  const causes = [...new Set(outcome.observedCauses ?? [])];
  return {
    ...base,
    contradicted,
    probabilityOfWhatHappened: given,
    surpriseBits,
    kind: 'SYSTEMATIC',
    causes,
    owner: causes.length ? ownerOf(causes) : null,
    owners: ownersOf(causes),
    claimGaps,
    reason: causes.length
      ? 'the comparable bucket is miscalibrated and the observation names the cause'
      : 'the comparable bucket is miscalibrated but no observation names the cause yet: commission the measurement that would',
  };
}

/**
 * The owner that acts first on a set of causes; `ownersOf` lists every owner the set needs.
 *
 * A software defect is corrected first: an implementation fault corrupts every
 * estimate built on it, so correcting the others before it measures nothing —
 * Factory leads whenever MODEL_IMPLEMENTATION is among the causes, and the
 * non-software owners still receive their own causes (see `ownersOf`). Without
 * a software cause the owner covering the most named causes leads, ties going to
 * the order in which the causes were observed. No owner is ranked by name.
 */
function ownerOf(causes: readonly MissCause[]): CorrectionOwner {
  const owners = ownersOf(causes);
  if (owners.includes('FACTORY')) return 'FACTORY';
  const covers = (o: CorrectionOwner): number => causes.filter((c) => CAUSE_OWNER[c] === o).length;
  return owners.reduce((best, o) => (covers(o) > covers(best) ? o : best), owners[0]!);
}

/** Every owner a set of causes needs, in the order the causes were observed. */
export function ownersOf(causes: readonly MissCause[]): CorrectionOwner[] {
  return [...new Set(causes.map((c) => CAUSE_OWNER[c]))];
}

export interface Correction {
  cause: MissCause;
  owner: CorrectionOwner;
  /** Claims whose predictions this cause explains; the correction's reach. */
  claimIds: readonly string[];
  /** Systematic misses it explains: the smallest reusable cause is the one explaining the most. */
  misses: number;
}

/** The smallest reusable causes, most-explaining first: one correction, many claims. */
export function smallestReusableCauses(diagnoses: readonly MissDiagnosis[]): Correction[] {
  const by = new Map<MissCause, { claims: Set<string>; misses: number }>();
  for (const d of diagnoses) {
    if (d.kind !== 'SYSTEMATIC') continue;
    for (const cause of d.causes) {
      const slot = by.get(cause) ?? { claims: new Set<string>(), misses: 0 };
      slot.claims.add(d.claimId);
      slot.misses += 1;
      by.set(cause, slot);
    }
  }
  return [...by.entries()]
    .map(([cause, v]) => ({ cause, owner: CAUSE_OWNER[cause], claimIds: [...v.claims].sort(), misses: v.misses }))
    .sort((a, b) => b.misses - a.misses || a.cause.localeCompare(b.cause));
}

/** The claims a correction touches, plus every claim that depends on one of them: the plans to recompute. */
export function dependentsToRecompute(corrections: readonly Correction[], dependsOn: ReadonlyMap<string, readonly string[]>): string[] {
  const touched = new Set(corrections.flatMap((c) => c.claimIds));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [claim, deps] of dependsOn) {
      if (!touched.has(claim) && deps.some((d) => touched.has(d))) {
        touched.add(claim);
        grew = true;
      }
    }
  }
  return [...touched].sort();
}

export interface CorrectionComparison {
  /** Calibration gap before and after the correction, on the same comparable bucket. */
  before: number | null;
  after: number | null;
  /** Observations on each side, so TOO_FEW says how far short it is. */
  nBefore: number;
  nAfter: number;
  verdict: 'NO_NEW_OBSERVATIONS' | 'TOO_FEW' | 'IMPROVED' | 'NOT_IMPROVED';
}

/** Compares the next production observations with the ones that exposed the cause. */
export function compareAfterCorrection(
  entries: readonly LedgerEntry[],
  comparableKey: string,
  correctedAt: string,
  minSample = MIN_CALIBRATION_SAMPLE,
): CorrectionComparison {
  const own = entries.filter((e) => e.prediction.comparableKey === comparableKey && e.outcome && impliedProbability(e.prediction) !== null);
  const gapOf = (list: LedgerEntry[]): number | null =>
    list.length < minSample
      ? null
      : list.filter((e) => e.outcome!.occurred).length / list.length - list.reduce((s, e) => s + (impliedProbability(e.prediction) as number), 0) / list.length;
  const beforeSet = own.filter((e) => e.outcome!.observedAt < correctedAt);
  const afterSet = own.filter((e) => e.outcome!.observedAt >= correctedAt);
  if (afterSet.length === 0) return { before: gapOf(beforeSet), after: null, nBefore: beforeSet.length, nAfter: 0, verdict: 'NO_NEW_OBSERVATIONS' };
  const before = gapOf(beforeSet);
  const after = gapOf(afterSet);
  if (before === null || after === null) return { before, after, nBefore: beforeSet.length, nAfter: afterSet.length, verdict: 'TOO_FEW' };
  return { before, after, nBefore: beforeSet.length, nAfter: afterSet.length, verdict: Math.abs(after) < Math.abs(before) ? 'IMPROVED' : 'NOT_IMPROVED' };
}
