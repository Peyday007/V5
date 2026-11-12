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
import { outcomesFor } from '../../repos/cashJourney.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import type { CashOutcome } from '../../domain/cashJourney.ts';
import { asReason, type OutcomeReason } from '../../domain/cashOutcomeReasons.ts';
import { versionAt, type ExposureRow, type MissCause, type OutcomeRow, type PredictionRow } from './forecast.ts';

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
  /** The outcome was measured to arrive too late, though the claim stated no horizon to count days against. */
  arrivedLate?: boolean;
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
  if ((signals.lateByDays ?? 0) > 0 || signals.arrivedLate) causes.push('TIMING');
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
  deps: LedgerDeps & { evidence?: string; realized?: number } = {},
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
    ...(deps.evidence ? { evidence: deps.evidence } : {}),
    ...(deps.realized !== undefined ? { realized: deps.realized } : {}),
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
  deps: LedgerDeps & { sprintHorizon?: typeof sprintHorizonOf } = {},
): Promise<PredictionRow[]> {
  const horizon = await claimHorizon(projectId, forecast, deps.sprintHorizon ?? sprintHorizonOf);
  const horizonDays = horizon?.days ?? null;
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
      assumptions: [`derived from ${est.fromRows} opportunity row(s)`, ...(horizon ? [horizon.basis] : [])],
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

/**
 * The horizon a cash claim is stated over (F-HORIZON-ALWAYS-NULL).
 *
 * A prediction is a claim about an outcome over a defined horizon. The cash
 * forecast withholds `timeToFirstDollar` on every production row — it will not
 * read free-text payment terms or an opening's deadline as a cash date — so
 * taking the horizon from it alone left every recorded claim with none, and
 * every diagnosis said "the claim states no horizon". When the forecast does
 * state a time to first dollar, that is the horizon. Otherwise the horizon is
 * the one a person set for the operation: the project's Cash Mode sprint
 * horizon (`cash_modes.horizon_days`, chosen at activation), the window inside
 * which this operation's deals are meant to produce cash. A deal that ends
 * past it is a measured timing overrun (`recordCashOutcomes`). Where neither
 * exists the horizon stays null and the claim gap stays true: a horizon nobody
 * stated is never invented. The source is recorded as an assumption, so the
 * claim says where its horizon came from.
 */
export async function claimHorizon(
  projectId: string,
  forecast: CashForecast,
  sprintHorizon: typeof sprintHorizonOf = sprintHorizonOf,
): Promise<{ days: number; basis: string } | null> {
  const stated = forecast.timeToFirstDollar.days;
  if (typeof stated === 'number' && Number.isFinite(stated) && stated > 0) {
    return { days: stated, basis: `horizon: ${stated} day(s), the forecast's time to first dollar` };
  }
  const sprint = await sprintHorizon(projectId);
  if (typeof sprint === 'number' && Number.isInteger(sprint) && sprint > 0) {
    return { days: sprint, basis: `horizon: ${sprint} day(s), the cash sprint horizon set when Cash Mode was activated` };
  }
  return null;
}

/** The project's Cash Mode sprint horizon in days, or null when the project runs no cash sprint. */
export async function sprintHorizonOf(projectId: string): Promise<number | null> {
  return (await getCashMode(projectId))?.horizonDays ?? null;
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
 * recorded as its exposure. Then this project's ledger, as held, is judged:
 * calibration, diagnoses, the smallest reusable causes and the plans to
 * recompute. No table, schedule or queue is added; the rows are `bin_events`.
 */
export async function keepCashLedger(
  projectId: string,
  currencies: readonly string[],
  deps: LedgerDeps & { forecast?: typeof cashForecast; measured?: (projectId: string) => Promise<CashOutcome[]>; sprintHorizon?: typeof sprintHorizonOf } = {},
): Promise<{
  written: PredictionRow[];
  exposures: ExposureRow[];
  outcomes: OutcomeRow[];
  reading: ModelLearningReading;
  /** This project's ledger as held after this refresh's own writes: what the refresh's learning step reads instead of reading again. */
  ledger: { predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] };
}> {
  const written: PredictionRow[] = [];
  const exposures: ExposureRow[] = [];
  // One read per refresh, of this project's ledger only; what this refresh writes is added to it in memory,
  // so the versions it compares against and the reading it returns include its own rows without reading again.
  const ledger = await (deps.read ?? (() => readLedger(projectId)))();
  const held = async () => ({ predictions: [...ledger.predictions], exposures: [...ledger.exposures], outcomes: [...ledger.outcomes] });
  const scoped: LedgerDeps = { ...deps, projectId, read: held };
  for (const currency of [...new Set(currencies.filter((c) => typeof c === 'string' && c.trim()))].sort()) {
    const forecast = await (deps.forecast ?? cashForecast)({ projectId, currency });
    const fresh = await recordCashForecast(projectId, forecast, { ...scoped, ...(deps.sprintHorizon ? { sprintHorizon: deps.sprintHorizon } : {}) });
    written.push(...fresh);
    ledger.predictions.push(...fresh);
    for (const p of fresh) {
      const exposure = await recordExposure(p.id, forecast.upfrontCash.valueCents, scoped);
      exposures.push(exposure);
      ledger.exposures.push(exposure);
    }
  }
  // What actually happened: every deal that ended since a version was exposed is a measured draw of the
  // figure that version claimed, and it is recorded against that version once (the outcome producer).
  const measured = await (deps.measured ?? ((id: string) => outcomesFor({ projectId: id })))(projectId);
  const outcomes = await recordCashOutcomes(projectId, measured, scoped);
  ledger.outcomes.push(...outcomes);
  return { written, exposures, outcomes, reading: await assessLedger({}, scoped), ledger: await held() };
}

/** One ended deal's realized figures, read from its `cash_outcomes` rows. */
export interface RealizedDeal {
  opportunityId: string;
  currency: string;
  /** When the deal's end was measured: the REALIZED_CONTRIBUTION row's own time. */
  endedAt: string;
  /** Payments − refunds − costs − owed (`money.ts contributionFrom`), the realized counterpart of the contribution claim. */
  contributionCents: number;
  /** Payments − refunds: contribution plus the actual cost written beside it, the realized counterpart of the revenue claim. */
  revenueCents: number | null;
  /** The row each figure was read from. */
  evidence: { contribution: string; revenue: string | null };
}

/**
 * The deals that ended, from `cash_outcomes` rows. Pure.
 *
 * A deal's end is the first REALIZED_CONTRIBUTION written for it (a later one is
 * a refund or cost landing afterwards, and the draw a forecast is judged on is
 * the deal as it ended). Revenue is that contribution plus the ACTUAL_COST
 * written at the same end (same request-key suffix); with no such cost row it is
 * null — never the contribution standing in for it.
 */
export function realizedDealsFrom(rows: readonly CashOutcome[]): RealizedDeal[] {
  const deals = new Map<string, RealizedDeal>();
  const suffix = (row: CashOutcome) => row.requestKey.split(':').at(-1) ?? '';
  const ordered = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    if (row.kind !== 'REALIZED_CONTRIBUTION' || row.valueCents === null || !row.currency || deals.has(row.opportunityId)) continue;
    const cost = ordered.find(
      (one) => one.kind === 'ACTUAL_COST' && one.opportunityId === row.opportunityId && suffix(one) === suffix(row) && one.valueCents !== null,
    );
    deals.set(row.opportunityId, {
      opportunityId: row.opportunityId,
      currency: row.currency,
      endedAt: row.createdAt,
      contributionCents: row.valueCents,
      revenueCents: cost ? row.valueCents + cost.valueCents! : null,
      evidence: { contribution: `cash_outcomes:${row.id}`, revenue: cost ? `cash_outcomes:${row.id}+${cost.id}` : null },
    });
  }
  return [...deals.values()].sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.opportunityId.localeCompare(b.opportunityId));
}

/** Which signal a closed failure reason measures. A reason not listed (or free text) names no cause. */
export const REASON_SIGNAL: Readonly<Partial<Record<OutcomeReason, Exclude<keyof OutcomeSignals, 'lateByDays'>>>> = {
  // The money or the delivery arrived after it was needed: a timing overrun, horizon stated or not.
  PAID_TOO_LATE: 'arrivedLate',
  // The opening stopped existing before the work finished: a condition the claim assumed no longer held.
  EXPIRED: 'assumptionBroke',
  // The operation could not serve it — not with the work it can do, nor the cash it can put in.
  DELIVERY_INFEASIBLE: 'capacityShortfall',
  CAPITAL_TOO_HIGH: 'capacityShortfall',
  // Nobody would buy: the step from opening to paying buyer was not in the claim's mechanism.
  NO_BUYER_FOUND: 'mechanismMissing',
  // The opportunity was not of the population the claim's figures were drawn from.
  NOT_ELIGIBLE: 'dataFromOtherPopulation',
};

/**
 * The measured signals one ended deal gives, read from its own `cash_outcomes`
 * rows. Pure. This is what lets every cause class have a production producer:
 * the cash journey (`cash/journey/learning.ts`) already writes why a deal ended,
 * whether a person failed or abandoned its fulfillment, whether an agreement
 * was released and whether money was refunded, and each of those is a
 * measurement of one part of the claim.
 *
 * - a closed failure reason (`cashOutcomeReasons.ts`) maps by `REASON_SIGNAL`;
 * - a fulfillment a person recorded as failed (`FAILURE_REASON:obligation-…`)
 *   or a refund (`REFUNDED` above zero) is execution that deviated from what
 *   the claim assumed would be delivered;
 * - an agreement released after it was made (`FAILURE_REASON:agreement-…`) is a
 *   condition the claim relied on that stopped holding.
 *
 * Free-text reasons name no cause, and neither does an unclassified mechanism
 * (`mechanism: null` says nobody classified the deal, not that a step was
 * missing): prose and blanks are not measurements.
 */
export function dealSignals(opportunityId: string, measured: readonly CashOutcome[]): OutcomeSignals {
  const rows = measured.filter((row) => row.opportunityId === opportunityId);
  const signals: OutcomeSignals = {};
  for (const row of rows) {
    if (row.kind === 'FAILURE_REASON') {
      const reason = asReason(row.valueText);
      const signal = reason ? REASON_SIGNAL[reason] : undefined;
      if (signal) signals[signal] = true;
      if (row.requestKey.includes(':FAILURE_REASON:obligation-')) signals.executionDeviated = true;
      if (row.requestKey.includes(':FAILURE_REASON:agreement-')) signals.assumptionBroke = true;
    }
    if (row.kind === 'REFUNDED' && (row.valueCents ?? 0) > 0) signals.executionDeviated = true;
  }
  return signals;
}

/** The interval a cash claim states, read from its own outcome text; null when it states none. */
export function claimedRange(p: Pick<PredictionRow, 'outcome'>): { low: number; high: number } | null {
  const m = /\(range (-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\)/.exec(p.outcome);
  if (!m) return null;
  const low = Number(m[1]);
  const high = Number(m[2]);
  return Number.isFinite(low) && Number.isFinite(high) && high >= low ? { low, high } : null;
}

/**
 * Record the actual outcome of the cash forecast's claims from the deals that
 * ended: the production producer of the outcome ledger (LEARN-15-1).
 *
 * Each ended deal is one draw of the per-deal figure a cash claim's range was
 * drawn from (`impliedProbability`). It is judged against the version of that
 * claim that was current — and exposed — when the deal ended, never against
 * today's model: `occurred` is whether the realized figure landed inside the
 * range that version stated. A version is resolved once (the ledger refuses a
 * second outcome), a deal resolves at most one version per claim, and a deal
 * that ended before any version was exposed predicts nothing. The measured
 * timing is the one signal recorded: a deal that ended past the version's
 * stated horizon is a timing overrun, and every other signal is read from
 * the deal's own `cash_outcomes` rows by `dealSignals`. Nothing is written for
 * a figure no row states.
 */
export async function recordCashOutcomes(
  projectId: string,
  measured: readonly CashOutcome[],
  deps: LedgerDeps = {},
): Promise<OutcomeRow[]> {
  const ledger = await defaultRead({ ...deps, projectId }, `cash:${projectId}:`)();
  const resolved = new Set(ledger.outcomes.map((o) => o.predictionId));
  const used = new Set(ledger.outcomes.map((o) => o.evidence).filter((e): e is string => typeof e === 'string'));
  const exposedAt = new Map(ledger.exposures.map((e) => [e.predictionId, e.exposedAt]));
  const written: OutcomeRow[] = [];
  const held = async () => ({ predictions: ledger.predictions, exposures: ledger.exposures, outcomes: [...ledger.outcomes, ...written] });
  for (const deal of realizedDealsFrom(measured)) {
    for (const figure of ['revenue', 'contribution'] as const) {
      const realized = figure === 'revenue' ? deal.revenueCents : deal.contributionCents;
      const evidence = figure === 'revenue' ? deal.evidence.revenue : deal.evidence.contribution;
      if (realized === null || evidence === null) continue;
      const tag = `${evidence}#${figure}`;
      if (used.has(tag)) continue;
      const version = versionAt(ledger.predictions, `cash:${projectId}:${deal.currency}:${figure}`, deal.endedAt);
      if (!version || resolved.has(version.id)) continue;
      const exposed = exposedAt.get(version.id);
      if (!exposed || exposed > deal.endedAt) continue;
      const range = claimedRange(version);
      if (!range) continue;
      const horizonEnd = version.horizonDays === null ? null : Date.parse(version.madeAt) + version.horizonDays * 86_400_000;
      const lateByDays = horizonEnd === null || !Number.isFinite(horizonEnd) ? 0 : Math.floor((Date.parse(deal.endedAt) - horizonEnd) / 86_400_000);
      const signals: OutcomeSignals = { ...dealSignals(deal.opportunityId, measured), ...(lateByDays > 0 ? { lateByDays } : {}) };
      const row = await recordOutcome(version.id, realized >= range.low && realized <= range.high, signals, {
        ...deps,
        projectId,
        read: held,
        now: () => deal.endedAt,
        evidence: tag,
        realized,
      });
      written.push(row);
      resolved.add(version.id);
      used.add(tag);
    }
  }
  return written;
}

/** Run the cash forecast and record it: the cash forecast's output reaches the ledger through here. */
export async function forecastAndRecordCash(
  input: { projectId: string; currency: string },
  deps: LedgerDeps = {},
): Promise<{ forecast: CashForecast; predictions: PredictionRow[] }> {
  const forecast = await cashForecast(input);
  return { forecast, predictions: await recordCashForecast(input.projectId, forecast, { ...deps, projectId: input.projectId }) };
}
