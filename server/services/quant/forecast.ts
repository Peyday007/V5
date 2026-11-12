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
  /** The production row the outcome was measured from (e.g. `cash_outcomes:<id>`); one row resolves at most one version. */
  evidence?: string;
  /** The realized figure, in the claim's own unit, when the outcome is a measured figure. */
  realized?: number;
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
  /**
   * Where the causes came from: OBSERVED when an outcome's measured signals name
   * them, LEDGER when they are read from the claim's own figures and the bucket's
   * measured outcomes (`ledgerCausesOf`), NONE when nothing names one.
   */
  attribution: 'OBSERVED' | 'LEDGER' | 'NONE';
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
 * and from what the ledger itself measured (`ledgerCausesOf`), never from the
 * single miss alone. `ledger` is every entry of the reading, so a cause that
 * shows only across claims (misses on one side, misses that move together) can
 * be read.
 */
export function diagnose(entry: LedgerEntry, buckets: readonly CalibrationBucket[], ledger: readonly LedgerEntry[] = [entry]): MissDiagnosis {
  const { prediction: p, outcome } = entry;
  const base = { predictionId: p.id, claimId: p.claimId, version: p.version };
  if (!outcome) {
    return { ...base, contradicted: false, probabilityOfWhatHappened: null, surpriseBits: null, kind: 'UNJUDGED', causes: [], attribution: 'NONE', owner: null, owners: [], claimGaps: [], reason: 'no outcome has been recorded for this version' };
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
    return { ...base, contradicted, probabilityOfWhatHappened: given, surpriseBits, kind: 'NOT_A_MISS', causes: [], attribution: 'NONE', owner: null, owners: [], claimGaps, reason: given === null ? 'a point estimate states no probability to contradict' : 'the outcome was the likelier one' };
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
      attribution: 'NONE',
      owner: null,
      owners: [],
      claimGaps,
      reason: judged
        ? 'the comparable bucket is calibrated, so this is the ordinary downside the forecast allowed for, not a model failure'
        : `fewer than ${MIN_CALIBRATION_SAMPLE} comparable resolved opportunities: one miss is not evidence either way`,
    };
  }
  const observed = [...new Set(outcome.observedCauses ?? [])];
  const derived = ledgerCausesOf(entry, ledger, own, observed);
  const causes = [...new Set([...observed, ...derived.causes])];
  return {
    ...base,
    contradicted,
    probabilityOfWhatHappened: given,
    surpriseBits,
    kind: 'SYSTEMATIC',
    causes,
    attribution: observed.length ? 'OBSERVED' : causes.length ? 'LEDGER' : 'NONE',
    owner: causes.length ? ownerOf(causes) : null,
    owners: ownersOf(causes),
    claimGaps,
    reason: observed.length
      ? `the comparable bucket is miscalibrated and the observation names the cause${derived.why.length ? `; the ledger adds: ${derived.why.join('; ')}` : ''}`
      : causes.length
        ? `the comparable bucket is miscalibrated and no observation names the cause, so it is read from the ledger: ${derived.why.join('; ')}`
        : 'the comparable bucket is miscalibrated but neither an observation nor the ledger names the cause',
  };
}

/** The figures a claim states about itself, read from its own text; null where it states none. */
export interface StatedFigures {
  /** The claimed figure (`… of V <unit> cents …`). */
  value: number | null;
  /** The per-row interval (`(range L..H)`). */
  low: number | null;
  high: number | null;
  /** How many rows the figure was derived from (`derived from N opportunity row(s)`). */
  rows: number | null;
  /** How large the population it claims about is (`Q qualified of C opportunities`). */
  population: number | null;
}

export function statedFigures(p: Pick<PredictionRow, 'outcome' | 'assumptions' | 'population'>): StatedFigures {
  const num = (m: RegExpExecArray | null, i = 1): number | null => {
    const v = m ? Number(m[i]) : Number.NaN;
    return Number.isFinite(v) ? v : null;
  };
  const range = /\(range (-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\)/.exec(p.outcome);
  let rows: number | null = null;
  for (const a of p.assumptions) {
    const m = /derived from (\d+) opportunity row/.exec(a);
    if (m) rows = Number(m[1]);
  }
  return {
    value: num(/\bof (-?\d+(?:\.\d+)?) \S+ cents\b/.exec(p.outcome)),
    low: num(range, 1),
    high: num(range, 2),
    rows,
    population: num(/^(\d+) qualified of \d+ opportunities/.exec(p.population)),
  };
}

/**
 * Causes a claim carries in its own figures, whatever happened. Pure.
 *
 *  - EVIDENCE_QUALITY: it names no data, or its figure was derived from fewer
 *    rows than the population it claims about — the blanks were left out, so
 *    the figure rests on part of the evidence its population describes.
 *  - MODEL_IMPLEMENTATION: its own arithmetic does not hold — a stated interval
 *    is reversed, or a total of N rows each inside [low, high] lies outside
 *    [N·low, N·high]. The same inputs through the model cannot have produced
 *    what the claim states, which is a software defect for Factory.
 */
export function claimCausesOf(p: Pick<PredictionRow, 'data' | 'outcome' | 'assumptions' | 'population'>): MissCause[] {
  const causes: MissCause[] = [];
  const f = statedFigures(p);
  if (p.data.length === 0 || (f.rows !== null && f.population !== null && f.rows < f.population)) causes.push('EVIDENCE_QUALITY');
  if (f.low !== null && f.high !== null && f.high < f.low) causes.push('MODEL_IMPLEMENTATION');
  else if (f.value !== null && f.low !== null && f.high !== null && f.rows !== null && f.rows > 0 && (f.value < f.rows * f.low || f.value > f.rows * f.high)) {
    causes.push('MODEL_IMPLEMENTATION');
  }
  return causes;
}

/** Paired deals needed before two claims' misses can be said to move together. */
export const MIN_DEPENDENCE_PAIRS = 5;
/** The association (phi) between two claims' misses beyond which they are not independent draws. */
export const DEPENDENCE_PHI = 0.5;
/** Of a bucket's out-of-range outcomes, the share on one side that makes them a shifted draw, not a narrow spread. */
export const ONE_SIDED_SHARE = 0.8;
/** Out-of-range outcomes with a measured figure needed before their side is read. */
export const MIN_SIDED_MISSES = 3;

/** The production row an outcome was measured from, without the figure it was read for. */
function drawOf(outcome: OutcomeRow): string | null {
  if (!outcome.evidence) return null;
  return outcome.evidence.split('#')[0]!.split('+')[0]!;
}

/**
 * Causes the ledger itself measures for one systematic miss. Pure.
 *
 * The claim's own figures first (`claimCausesOf`). Then, across the reading:
 *
 *  - DEPENDENCY_ASSUMPTION: this outcome's draw (the production row it was
 *    measured from) also resolved a claim in another comparable bucket, both
 *    missed, and across every such pair the two buckets' misses are associated
 *    (phi ≥ DEPENDENCE_PHI over ≥ MIN_DEPENDENCE_PAIRS pairs). Calibration
 *    counts each as an independent Bernoulli draw; these are not.
 *
 * Only when neither an observation nor any of the above names a cause, the
 * bucket's own measured outcomes say which estimate was wrong:
 *
 *  - SELECTION_BIAS: the bucket's out-of-range outcomes fall on one side of the
 *    claimed ranges (≥ ONE_SIDED_SHARE of ≥ MIN_SIDED_MISSES). The outcomes that
 *    arrived are a shifted draw from the rows the range was taken from.
 *  - PARAMETER_ESTIMATE: otherwise. The bucket's figures land inside or outside
 *    their ranges at a rate the estimate did not imply. A min..max range from N
 *    rows implies (N−1)/(N+1), so a miss on both sides means the spread
 *    estimated from those rows is wrong, and a rate above the implied one means
 *    the estimate is too wide. Either way the estimator is what is corrected.
 */
export function ledgerCausesOf(
  entry: LedgerEntry,
  ledger: readonly LedgerEntry[],
  ownBuckets: readonly CalibrationBucket[],
  observed: readonly MissCause[] = [],
): { causes: MissCause[]; why: string[] } {
  const causes: MissCause[] = [];
  const why: string[] = [];
  const add = (cause: MissCause, reason: string): void => {
    if (causes.includes(cause) || observed.includes(cause)) return;
    causes.push(cause);
    why.push(reason);
  };
  const p = entry.prediction;
  for (const cause of claimCausesOf(p)) {
    add(
      cause,
      cause === 'EVIDENCE_QUALITY'
        ? p.data.length === 0
          ? 'the claim names no data it rests on'
          : `the figure was derived from ${statedFigures(p).rows} of the ${statedFigures(p).population} rows its population names`
        : 'the claim\'s own figures do not reproduce: its total lies outside what its rows and range allow',
    );
  }

  const draw = entry.outcome ? drawOf(entry.outcome) : null;
  if (draw && entry.outcome && !entry.outcome.occurred) {
    const missOf = (e: LedgerEntry): boolean => e.outcome !== null && !e.outcome.occurred;
    const byDraw = new Map<string, LedgerEntry[]>();
    for (const e of ledger) {
      const d = e.outcome ? drawOf(e.outcome) : null;
      if (!d || impliedProbability(e.prediction) === null) continue;
      byDraw.set(d, [...(byDraw.get(d) ?? []), e]);
    }
    for (const sibling of byDraw.get(draw) ?? []) {
      const other = sibling.prediction.comparableKey;
      if (other === p.comparableKey || !missOf(sibling)) continue;
      let n = 0;
      let a = 0;
      let b = 0;
      let both = 0;
      for (const group of byDraw.values()) {
        const mine = group.find((e) => e.prediction.comparableKey === p.comparableKey);
        const theirs = group.find((e) => e.prediction.comparableKey === other);
        if (!mine || !theirs) continue;
        n += 1;
        const x = missOf(mine);
        const y = missOf(theirs);
        if (x) a += 1;
        if (y) b += 1;
        if (x && y) both += 1;
      }
      const denom = Math.sqrt(a * (n - a) * b * (n - b));
      const phi = denom > 0 ? (both * n - a * b) / denom : a === n && b === n && n > 0 ? 1 : 0;
      if (n >= MIN_DEPENDENCE_PAIRS && phi >= DEPENDENCE_PHI) {
        add('DEPENDENCY_ASSUMPTION', `the same deals miss ${p.comparableKey} and ${other} together (${both} of ${n} paired draws, phi ${phi.toFixed(2)}), so they are not independent draws`);
        break;
      }
    }
  }

  if (observed.length === 0 && causes.length === 0) {
    const own = ledger.filter((e) => e.prediction.comparableKey === p.comparableKey && e.outcome && impliedProbability(e.prediction) !== null);
    let below = 0;
    let above = 0;
    for (const e of own) {
      if (e.outcome!.occurred || typeof e.outcome!.realized !== 'number') continue;
      const f = statedFigures(e.prediction);
      if (f.low !== null && e.outcome!.realized < f.low) below += 1;
      else if (f.high !== null && e.outcome!.realized > f.high) above += 1;
    }
    const sided = below + above;
    if (sided >= MIN_SIDED_MISSES && Math.max(below, above) / sided >= ONE_SIDED_SHARE) {
      add('SELECTION_BIAS', `${Math.max(below, above)} of ${sided} out-of-range outcomes landed ${below >= above ? 'below' : 'above'} the claimed ranges: the outcomes that arrived are a shifted draw from the rows the ranges were taken from`);
    } else {
      const bucket = ownBuckets.find((b) => b.verdict === 'MISCALIBRATED');
      const rate = bucket?.observedRate ?? null;
      const implied = bucket?.meanForecast ?? null;
      add(
        'PARAMETER_ESTIMATE',
        rate !== null && implied !== null
          ? `the bucket's figures landed as claimed ${(rate * 100).toFixed(0)}% of the time against an implied ${(implied * 100).toFixed(0)}%${sided ? ` (${below} below, ${above} above)` : ''}: the estimate drawn from its rows is ${rate < implied ? 'too narrow' : 'too wide'}`
          : 'the bucket is miscalibrated and nothing else names a cause: the estimate drawn from its rows is wrong',
      );
    }
  }
  return { causes, why };
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
