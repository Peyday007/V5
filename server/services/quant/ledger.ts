/**
 * The prediction, exposure and outcome ledgers, kept as rows (LEARN-15-1).
 *
 * `forecast.ts` judges rows it is handed; this is where those rows are written
 * and read back, so a forecast is an auditable claim rather than a hand-fed
 * input. It extends the existing append-only writer and table
 * (`recordBinEvent` → `bin_events`, the same one the acquisition and access
 * judgments use) instead of adding a store: a revision is a new row that
 * supersedes, an outcome is recorded once against the version that was exposed,
 * and nothing is edited. The ledger is a read over those rows — no figure is
 * kept anywhere else.
 *
 * `observedCauses` has a producer here: an outcome is recorded with the
 * structured signals a measurement gave (a timing overrun, a capacity shortfall,
 * a changed condition, a calculation that disagrees with its own claim), and the
 * cause classes follow from those signals and from the claim's own gaps. Prose
 * names no cause, and a signal nobody measured names none.
 */
import { getDb } from '../../db/database.ts';
import type { SqlParam } from '../../db/types.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import {
  assessModelLearning,
  type ModelLearningReading,
} from './learning.ts';
import { cashForecast, type CashForecast, type Estimate } from '../cash/forecast.ts';
import type { ExposureRow, MissCause, OutcomeRow, PredictionRow } from './forecast.ts';

export const LEDGER_EVENTS = {
  PREDICTION: 'FORECAST_PREDICTION',
  EXPOSURE: 'FORECAST_EXPOSURE',
  OUTCOME: 'FORECAST_OUTCOME',
} as const;

type LedgerKind = keyof typeof LEDGER_EVENTS;

export interface LedgerRow {
  kind: LedgerKind;
  row: PredictionRow | ExposureRow | OutcomeRow;
}

export interface LedgerDeps {
  record?: typeof recordBinEvent;
  /** The rows already on the ledger; defaults to reading them from `bin_events`. */
  read?: () => Promise<{ predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] }>;
  now?: () => string;
  caller?: string;
  /**
   * The project the rows belong to. Written to `bin_events.project_id`, and the
   * default read is scoped to it, so one project's refresh never reads another's
   * ledger. When absent it is taken from a cash claim id (`cash:<project>:…`).
   */
  projectId?: string | null;
}

/** The project a cash claim (or a version of one) belongs to, read from its id; null for any other claim. */
export function projectOfClaim(id: string): string | null {
  if (!id.startsWith('cash:')) return null;
  const project = id.split(':')[1];
  return project ? project : null;
}

/** The row's own claim or version id, which is where its project is read from. */
function idOf(row: LedgerRow['row']): string {
  return 'claimId' in row ? row.claimId : row.predictionId;
}

/** The id a version of a claim has: stable, so recording it again is the same row, not a second one. */
export function predictionIdOf(claimId: string, version: number): string {
  return `${claimId}@v${version}`;
}

async function write(kind: LedgerKind, row: LedgerRow['row'], deps: LedgerDeps, reason: string): Promise<void> {
  await (deps.record ?? recordBinEvent)({
    eventType: LEDGER_EVENTS[kind],
    projectId: deps.projectId ?? projectOfClaim(idOf(row)),
    workloadClass: deps.caller ?? 'forecast-ledger',
    outcome: kind,
    reason: reason.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { ledger: kind, row },
  });
}

/** Rebuild the three ledgers from the rows written, in the claims' own order; a row that does not parse is skipped, never guessed. */
export function ledgerFromRows(rows: readonly { measures: string | null }[]): {
  predictions: PredictionRow[];
  exposures: ExposureRow[];
  outcomes: OutcomeRow[];
} {
  const predictions = new Map<string, PredictionRow>();
  const exposures = new Map<string, ExposureRow>();
  const outcomes = new Map<string, OutcomeRow>();
  for (const r of rows) {
    let parsed: { ledger?: string; row?: unknown };
    try {
      parsed = JSON.parse(r.measures ?? '{}') as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.row || typeof parsed.row !== 'object') continue;
    if (parsed.ledger === 'PREDICTION') {
      const p = parsed.row as PredictionRow;
      if (typeof p.id === 'string' && !predictions.has(p.id)) predictions.set(p.id, p);
    } else if (parsed.ledger === 'EXPOSURE') {
      const e = parsed.row as ExposureRow;
      if (typeof e.predictionId === 'string' && !exposures.has(e.predictionId)) exposures.set(e.predictionId, e);
    } else if (parsed.ledger === 'OUTCOME') {
      const o = parsed.row as OutcomeRow;
      // An outcome is recorded once: the first stands, a later one never overwrites it.
      if (typeof o.predictionId === 'string' && !outcomes.has(o.predictionId)) outcomes.set(o.predictionId, o);
    }
  }
  // Rows written in the same millisecond tie on `at` and the row id is random, so the order is the claim's own:
  // when it was made, then which claim, then which version.
  const ordered = [...predictions.values()].sort((a, b) => a.madeAt.localeCompare(b.madeAt) || a.claimId.localeCompare(b.claimId) || a.version - b.version);
  return { predictions: ordered, exposures: [...exposures.values()], outcomes: [...outcomes.values()] };
}

/** Rows fetched per round trip. A page size, never a cap: the read continues until the ledger is exhausted. */
export const LEDGER_PAGE_ROWS = 5000;

/**
 * Read the ledger back, every row of it, oldest first. Scoped to one project when
 * one is named (the per-project claims a refresh versions and judges), the whole
 * ledger otherwise. It is paged on `(at, id)` rather than capped: a fixed LIMIT
 * on an oldest-first read would make every row past it — the newest predictions,
 * exposures and outcomes — silently invisible.
 */
export async function readLedger(
  projectId: string | null = null,
  pageRows = LEDGER_PAGE_ROWS,
): Promise<{ predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] }> {
  const rows: { measures: string | null }[] = [];
  const size = Math.max(1, Math.floor(pageRows));
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const params: SqlParam[] = [LEDGER_EVENTS.PREDICTION, LEDGER_EVENTS.EXPOSURE, LEDGER_EVENTS.OUTCOME];
    let where = 'event_type IN (?, ?, ?)';
    if (projectId !== null) {
      where += ' AND project_id = ?';
      params.push(projectId);
    }
    if (after) {
      where += ' AND (at > ? OR (at = ? AND id > ?))';
      params.push(after.at, after.at, after.id);
    }
    params.push(size);
    const page: { id: string; at: string; measures: string | null }[] = await getDb().all<{ id: string; at: string; measures: string | null }>(
      `SELECT id, at, measures FROM bin_events WHERE ${where} ORDER BY at ASC, id ASC LIMIT ?`,
      params,
    );
    rows.push(...page);
    const last = page[page.length - 1];
    if (page.length < size || !last) break;
    after = { at: last.at, id: last.id };
  }
  return ledgerFromRows(rows);
}

/** The read a write uses when none is injected: the project's own ledger when the claim names one. */
function defaultRead(deps: LedgerDeps, id: string): () => ReturnType<typeof readLedger> {
  return deps.read ?? (() => readLedger(deps.projectId ?? projectOfClaim(id)));
}

export interface PredictionInput {
  /** The claim this is a version of; the first version of a new claim names a fresh id. */
  claimId: string;
  outcome: string;
  horizonDays: number | null;
  population: string;
  data: readonly string[];
  assumptions: readonly string[];
  probability: number | null;
  comparableKey: string;
}

/** Record a claim, or a revision of it: the next version, superseding without editing the one before. */
export async function recordPrediction(input: PredictionInput, deps: LedgerDeps = {}): Promise<PredictionRow> {
  if (input.probability !== null && !(input.probability >= 0 && input.probability <= 1)) {
    throw new Error('a stated probability is between 0 and 1');
  }
  const existing = (await defaultRead(deps, input.claimId)()).predictions.filter((p) => p.claimId === input.claimId);
  const version = existing.reduce((m, p) => Math.max(m, p.version), 0) + 1;
  const row: PredictionRow = {
    id: predictionIdOf(input.claimId, version),
    claimId: input.claimId,
    version,
    outcome: input.outcome,
    horizonDays: input.horizonDays,
    population: input.population,
    data: [...input.data],
    assumptions: [...input.assumptions],
    probability: input.probability,
    comparableKey: input.comparableKey,
    madeAt: (deps.now ?? (() => new Date().toISOString()))(),
  };
  await write('PREDICTION', row, deps, `${row.claimId} v${row.version}: ${row.outcome}`);
  return row;
}

/** Record what was put at risk on one version. A figure nobody states is null, never zero. */
export async function recordExposure(predictionId: string, atRiskCents: number | null, deps: LedgerDeps = {}): Promise<ExposureRow> {
  const row: ExposureRow = { predictionId, exposedAt: (deps.now ?? (() => new Date().toISOString()))(), atRiskCents };
  await write('EXPOSURE', row, deps, `exposure on ${predictionId}`);
  return row;
}

/** What a measurement observed about an outcome. Every field is optional: an unmeasured one names no cause. */
export interface OutcomeSignals {
  /** Days past the stated horizon the outcome arrived (positive) — a timing overrun. */
  lateByDays?: number;
  /** Demand the operation could not serve, measured against capacity. */
  capacityShortfall?: boolean;
  /** A condition the claim assumed no longer held when the outcome arrived. */
  assumptionBroke?: boolean;
  /** The same inputs run through the model do not reproduce what the claim stated. */
  calculationDisagrees?: boolean;
  /** What the claim leaned on came from a population other than the one it predicts. */
  dataFromOtherPopulation?: boolean;
  /** The opportunities that reached this outcome were not a fair draw of the population. */
  selectedSample?: boolean;
  /** The work was not done the way the claim assumed it would be. */
  executionDeviated?: boolean;
  /** A step the outcome needed was missing from the claim's mechanism. */
  mechanismMissing?: boolean;
}

/**
 * The cause classes an outcome supports. Pure. Each comes from a measured signal
 * or from a structural gap in the claim itself; the miss alone names nothing.
 */
export function observedCausesOf(prediction: PredictionRow, signals: OutcomeSignals = {}): MissCause[] {
  const causes: MissCause[] = [];
  if (prediction.data.length === 0) causes.push('EVIDENCE_QUALITY');
  if (signals.dataFromOtherPopulation) causes.push('EXTERNAL_DATA_TRANSFER');
  if (signals.mechanismMissing) causes.push('MISSING_MECHANISM');
  if (signals.selectedSample) causes.push('SELECTION_BIAS');
  if (signals.calculationDisagrees) causes.push('MODEL_IMPLEMENTATION');
  if (signals.capacityShortfall) causes.push('CAPACITY');
  if ((signals.lateByDays ?? 0) > 0) causes.push('TIMING');
  if (signals.executionDeviated) causes.push('EXECUTION_BEHAVIOR');
  if (signals.assumptionBroke) causes.push('CHANGED_CONDITIONS');
  return causes;
}

/**
 * Record the actual outcome once, against the version that was exposed, with the
 * causes its signals support. A second outcome for the same version is refused:
 * new evidence is a new row somewhere else, never an overwrite of this one.
 */
export async function recordOutcome(
  predictionId: string,
  occurred: boolean,
  signals: OutcomeSignals = {},
  deps: LedgerDeps = {},
): Promise<OutcomeRow> {
  const ledger = await defaultRead(deps, predictionId)();
  const prediction = ledger.predictions.find((p) => p.id === predictionId);
  if (!prediction) throw new Error(`no prediction ${predictionId} is on the ledger: an outcome is recorded against a version that exists`);
  if (ledger.outcomes.some((o) => o.predictionId === predictionId)) {
    throw new Error(`an outcome is already recorded for ${predictionId}; it is not overwritten`);
  }
  const causes = observedCausesOf(prediction, signals);
  const row: OutcomeRow = {
    predictionId,
    observedAt: (deps.now ?? (() => new Date().toISOString()))(),
    occurred,
    ...(causes.length ? { observedCauses: causes } : {}),
  };
  await write('OUTCOME', row, deps, `${predictionId} ${occurred ? 'occurred' : 'did not occur'}`);
  return row;
}

/** Judge the ledger as it stands: calibration, diagnoses, the smallest reusable causes and the plans to recompute. */
export async function assessLedger(
  input: Omit<Parameters<typeof assessModelLearning>[0], 'predictions' | 'exposures' | 'outcomes'> = {},
  deps: Pick<LedgerDeps, 'read' | 'projectId'> = {},
): Promise<ModelLearningReading> {
  return assessModelLearning({ ...(await (deps.read ?? (() => readLedger(deps.projectId ?? null)))()), ...input });
}

/**
 * The cash forecast, written to the ledger as the claims it makes. This is the
 * connection to `cash/forecast.ts`, the existing owner of the figures: it calls
 * that function and records what it returned, one versioned prediction per
 * figure that has a value. A withheld estimate (`valueCents: null`) is not a
 * claim, so it writes nothing and is never recorded as zero. The forecast
 * states a spread of sourced rows, not a probability, so `probability` is null.
 * Claim ids are per project and currency, so a recomputed forecast is the next
 * version of the same claim, and calibration compares like with like.
 */
export async function recordCashForecast(
  projectId: string,
  forecast: CashForecast,
  deps: LedgerDeps = {},
): Promise<PredictionRow[]> {
  const horizonDays = forecast.timeToFirstDollar.days;
  const figures: [string, Estimate][] = [
    ['revenue', forecast.revenue],
    ['contribution', forecast.contribution],
  ];
  const written: PredictionRow[] = [];
  // Read once: the latest version of each claim decides whether this forecast revises it or repeats it.
  const before = await (deps.read ?? (() => readLedger(projectId)))();
  const latest = new Map<string, PredictionRow>();
  for (const p of before.predictions) {
    const held = latest.get(p.claimId);
    if (!held || p.version > held.version) latest.set(p.claimId, p);
  }
  for (const [name, est] of figures) {
    if (est.valueCents === null) continue;
    const input: PredictionInput = {
      claimId: `cash:${projectId}:${forecast.currency}:${name}`,
      outcome: `${name} of ${est.valueCents} ${forecast.currency} cents (range ${est.lowCents}..${est.highCents})`,
      horizonDays,
      population: `${forecast.qualified} qualified of ${forecast.considered} opportunities in ${forecast.currency}`,
      data: [est.basis],
      assumptions: [`derived from ${est.fromRows} opportunity row(s)`],
      probability: null,
      comparableKey: `cash:${forecast.currency}:${name}`,
    };
    // A forecast recomputed from unchanged rows states the same claim: it is not a new version.
    const held = latest.get(input.claimId);
    if (held && statesSame(held, input)) continue;
    written.push(await recordPrediction(input, { ...deps, projectId, read: async () => before }));
  }
  return written;
}

/** Whether a recorded version already states exactly this claim. */
export function statesSame(held: PredictionRow, input: PredictionInput): boolean {
  return held.outcome === input.outcome &&
    held.horizonDays === input.horizonDays &&
    held.population === input.population &&
    held.probability === input.probability &&
    held.comparableKey === input.comparableKey &&
    JSON.stringify(held.data) === JSON.stringify([...input.data]) &&
    JSON.stringify(held.assumptions) === JSON.stringify([...input.assumptions]);
}

/**
 * Keep a project's cash ledger and read it back: the production path (LEARN-15-1).
 *
 * Called when a project's cash knowledge is refreshed (`knowledge.ts
 * loadCashKnowledge`), which every goal plan reading does. For each currency
 * the project's openings are priced in, the cash forecast (`cash/forecast.ts`,
 * the existing owner of the figures) is recorded as versioned predictions —
 * only when it states something new — and what each new version puts at risk
 * (the forecast's most cash out at once, or null when nobody stated it) is
 * recorded as its exposure. Then the whole ledger is read and judged:
 * calibration, diagnoses, the smallest reusable causes and the plans to
 * recompute. No table, schedule or queue is added; the rows are `bin_events`.
 */
export async function keepCashLedger(
  projectId: string,
  currencies: readonly string[],
  deps: LedgerDeps & { forecast?: typeof cashForecast } = {},
): Promise<{ written: PredictionRow[]; exposures: ExposureRow[]; reading: ModelLearningReading }> {
  const written: PredictionRow[] = [];
  const exposures: ExposureRow[] = [];
  // One read per refresh, of this project's ledger only; what this refresh writes is added to it in memory,
  // so the versions it compares against and the reading it returns include its own rows without reading again.
  const ledger = await (deps.read ?? (() => readLedger(projectId)))();
  const held = async () => ({ predictions: [...ledger.predictions], exposures: [...ledger.exposures], outcomes: [...ledger.outcomes] });
  const scoped: LedgerDeps = { ...deps, projectId, read: held };
  for (const currency of [...new Set(currencies.filter((c) => typeof c === 'string' && c.trim()))].sort()) {
    const forecast = await (deps.forecast ?? cashForecast)({ projectId, currency });
    const fresh = await recordCashForecast(projectId, forecast, scoped);
    written.push(...fresh);
    ledger.predictions.push(...fresh);
    for (const p of fresh) {
      const exposure = await recordExposure(p.id, forecast.upfrontCash.valueCents, scoped);
      exposures.push(exposure);
      ledger.exposures.push(exposure);
    }
  }
  return { written, exposures, reading: await assessLedger({}, scoped) };
}

/** Run the cash forecast and record it: the cash forecast's output reaches the ledger through here. */
export async function forecastAndRecordCash(
  input: { projectId: string; currency: string },
  deps: LedgerDeps = {},
): Promise<{ forecast: CashForecast; predictions: PredictionRow[] }> {
  const forecast = await cashForecast(input);
  return { forecast, predictions: await recordCashForecast(input.projectId, forecast, { ...deps, projectId: input.projectId }) };
}
