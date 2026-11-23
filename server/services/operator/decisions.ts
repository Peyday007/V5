/**
 * The operator's decisions: reviewed, challenged, predicted, then judged (§108).
 *
 * Built on owners Brain already has, not beside them:
 *   - the prediction ledger (`quant/ledger.ts`): every committed decision is a
 *     PREDICTION with a probability, a horizon and a comparable key
 *     (`operator:<kind>`), and its verification is an OUTCOME with the causes
 *     the measured signals support — so `forecast.ts`'s calibration judges the
 *     operator over repeated comparable outcomes, never over one miss;
 *   - the goal decisions (`goals/decide.ts`): pausing and resuming are the
 *     same writers a person's decision uses;
 *   - the models Brain already has (the GPU, the free switchboard) for the
 *     challenge — a second model, never a paid frontier API.
 *
 * A decision is an event (`OPERATOR_DECISION`) carrying the whole record; the
 * ledger rows carry the claim. Nothing is edited after it is written.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import { recordEvent } from '../../repos/events.ts';
import { getWorkstream } from '../../repos/register.ts';
import { challengePrompt, parseChallenge, reviewDecision, type Challenge, type DecisionInput, type DecisionReview } from '../../domain/decision.ts';
import { chatFor, firstJson } from '../cheap/modelBench.ts';
import type { OperatorModel } from '../../domain/operator.ts';
import { buildLedger, calibrate, diagnose, type ExposureRow, type OutcomeRow, type PredictionRow } from '../quant/forecast.ts';
import { forecastBias } from '../quant/mathToolkit.ts';
import { OWNER_DIRECTED_GOAL_IDS } from '../../domain/binPurpose.ts';

export interface DecisionRecord {
  id: string;
  input: DecisionInput;
  review: DecisionReview;
  challenge: Challenge | null;
  predictionId: string;
  projectId: string;
  committedAt: string;
}

export interface DecideResult {
  committed: boolean;
  /** The measured correction applied to the stated probability, when the comparable bucket is miscalibrated. */
  correction?: BucketCorrection | null;
  decisionId: string | null;
  verdict: 'COMMITTED' | 'REVISE' | 'REFUSED';
  problems: string[];
  review: DecisionReview;
  challenge: Challenge | null;
  next: string;
}

/**
 * All challenge attempts together end inside this, so the decision is committed
 * or returned before the operator's 180 s MCP call gives up. Production,
 * 2026-11-13: three 120 s attempts in sequence (360 s) could commit a decision
 * after Hermes had already been told the call timed out.
 */
export const CHALLENGE_BUDGET_MS = 150_000;
/** One model's longest turn at the challenge. */
export const CHALLENGE_ATTEMPT_MS = 120_000;
/** An attempt with less than this left is not started: it could not answer in time. */
const CHALLENGE_MIN_ATTEMPT_MS = 5_000;

/** A model's parameter count in billions from its served name ("Qwen/Qwen3-4B-AWQ" → 4), or null. */
export function parameterBillions(model: string): number | null {
  const name = model.split('/').pop() ?? model;
  const match = /(\d+(?:\.\d+)?)b(?![a-z])/i.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * The GPU's small model (Qwen3-4B, 4B parameters or fewer): measured weakest on
 * Brain's own tasks (§108, quality 0.65 against 0.98), so it never challenges a
 * stronger model's decision.
 */
export function weakChallenger(model: OperatorModel): boolean {
  if (!model.label.startsWith('gpu:')) return false;
  const size = parameterBillions(model.model);
  return size !== null && size <= 4;
}

/**
 * Who challenges, in order: the models as `rankOperatorModels` ordered them by
 * their run record and benchmark — best first — less the weak GPU model. The
 * old order moved the best model last, so the 4B GPU model challenged first.
 * The challenge is a fresh prompt with none of the operator's conversation, so
 * the best model reading it cold is still a second reading.
 */
export function challengerModels(ranked: OperatorModel[]): OperatorModel[] {
  const strong = ranked.filter((m) => !weakChallenger(m));
  // A weak challenger is better than none: with only the small GPU model up, it still attacks the decision
  // last-resort rather than letting a high-impact decision commit unchallenged (review F11).
  return strong.length > 0 ? strong : ranked;
}

/** Ask a second model to attack the decision. Null when no model answered within the budget. */
export async function challengeDecision(
  input: DecisionInput,
  review: DecisionReview,
  models: OperatorModel[],
  fetchImpl: typeof fetch = fetch,
  bounds: { budgetMs?: number; minAttemptMs?: number; clock?: () => number } = {},
): Promise<Challenge | null> {
  const prompt = challengePrompt(input, review);
  const clock = bounds.clock ?? Date.now;
  const deadline = clock() + Math.min(CHALLENGE_BUDGET_MS, bounds.budgetMs ?? CHALLENGE_BUDGET_MS);
  for (const model of challengerModels(models)) {
    const left = deadline - clock();
    if (left < (bounds.minAttemptMs ?? CHALLENGE_MIN_ATTEMPT_MS)) break;
    const chat = chatFor({ label: model.label, url: model.baseUrl, key: model.apiKey, model: model.model, usdPerHour: null }, fetchImpl, Math.min(CHALLENGE_ATTEMPT_MS, left));
    const r = await chat(
      [
        { role: 'system', content: 'You are a rigorous challenger. Answer with exactly one JSON object.' },
        { role: 'user', content: prompt },
      ],
      undefined,
      3000,
    );
    if (r.error) continue;
    const parsed = parseChallenge(firstJson(r.content), model.label);
    if (parsed) return parsed;
  }
  return null;
}

/** What the ledger has measured about one comparable bucket of operator decisions. */
export interface BucketCorrection {
  comparableKey: string;
  /** Observed rate minus mean forecast over the bucket's resolved decisions (negative: overconfident). */
  shift: number;
  rationale: string;
  /** Claims whose systematic miss named MISSING_MECHANISM: the step from decision to outcome was not in the claim. */
  missingMechanismClaims: string[];
  /** Claims whose systematic miss named CAPACITY: the outcome needed capacity the decision assumed and did not have. */
  capacityShortfallClaims: string[];
  /** Claims whose systematic miss named CHANGED_CONDITIONS: a condition the decision assumed no longer held when the outcome arrived. */
  changedConditionClaims: string[];
  /** Claims whose systematic miss named EVIDENCE_QUALITY: the prediction rested on no named data (the chosen option cited no evidence). */
  evidenceQualityClaims: string[];
  /**
   * Claims whose systematic miss the ledger read as PARAMETER_ESTIMATE: no
   * observation named a cause, and the bucket's outcomes landed at a rate its
   * stated probabilities did not imply — the estimate itself was wrong.
   */
  parameterEstimateClaims: string[];
  /** Claims whose systematic miss named EXECUTION_BEHAVIOR: the work was not done the way the decision assumed it would be. */
  executionBehaviorClaims: string[];
  /** Claims whose systematic miss named TIMING: the outcome arrived after the horizon the decision stated (or was measured late). */
  timingLateClaims: string[];
  /** The bucket's observed rate and mean forecast, when the calibration measured them. */
  observedRate: number | null;
  meanForecast: number | null;
}

/**
 * How the operator is told to name the mechanism step: one sentence, used
 * wherever it reaches the operator. It reaches it the moment a verified miss
 * names MISSING_MECHANISM — `operatorCalibration`, which brain_operator_verify
 * returns — so the next decision of that kind is written right the first time,
 * and again in decide()'s REVISE should one still arrive without it.
 */
export const MECHANISM_ASSUMPTION_INSTRUCTION =
  'Add an assumption beginning "mechanism:" that names the step from this decision to the predicted outcome the earlier misses lacked (who acts, how they are reached, what makes them say yes)';

/** An assumption that names the mechanism step, written as MECHANISM_ASSUMPTION_INSTRUCTION tells the operator to write it. */
export const MECHANISM_ASSUMPTION = /^\s*mechanism\s*:\s*\S/i;

/**
 * The same correction for a bucket whose systematic misses named CAPACITY
 * (FORECAST:operator:CAPACITY): the decision assumed capacity — a free worker,
 * a sending inbox, a delivery slot — that was not there within the horizon. The
 * next decision of that kind states which capacity it needs and the row showing
 * it is available, so a forecast never again rests on capacity nobody measured.
 */
export const CAPACITY_ASSUMPTION_INSTRUCTION =
  'Add an assumption beginning "capacity:" naming the pool the predicted outcome needs, exactly as brain_operator_capacity reports it (ROUTINES, FREE_LANE, RESEARCH_SLOTS or FACTORY), and what it needs from that pool within the horizon';

/** An assumption that names the capacity, written as CAPACITY_ASSUMPTION_INSTRUCTION tells the operator to write it. */
export const CAPACITY_ASSUMPTION = /^\s*capacity\s*:\s*\S/i;

/**
 * The same correction for a bucket whose systematic misses named
 * CHANGED_CONDITIONS (FORECAST:operator:CHANGED_CONDITIONS, production 9 of 9):
 * the decision rested on a market condition that no longer held by the time the
 * outcome arrived. Shifting the probability alone leaves the next decision on
 * the same unchecked condition, so the bucket stays miscalibrated. The next
 * decision of that kind names the condition it relies on and where and when it
 * was last observed — re-checked now, not the figure the broken misses assumed
 * (`goals/calibration.ts`: re-research it before the next plan relies on it).
 */
export const CONDITION_ASSUMPTION_INSTRUCTION =
  'Add an assumption beginning "condition:" naming the market condition the predicted outcome relies on, the row id or source URL it was last observed in, and the date it was observed as YYYY-MM-DD, re-checked within the horizon rather than carried over from the earlier misses whose assumed condition had changed';

/** An assumption that names the condition, written as CONDITION_ASSUMPTION_INSTRUCTION tells the operator to write it. */
export const CONDITION_ASSUMPTION = /^\s*condition\s*:\s*\S/i;

/**
 * The same correction for a bucket whose systematic misses named
 * EXECUTION_BEHAVIOR (FORECAST:operator:EXECUTION_BEHAVIOR, production 2 of 2):
 * the outcome was missed because the work the decision assumed was not done as
 * planned. `goals/calibration.ts` reads that cause as an execution failure —
 * correct the execution procedure rather than the forecast — so shifting the
 * probability alone leaves the next decision on the same unplanned execution
 * and the bucket stays miscalibrated. The next decision of that kind names the
 * Brain operation that will carry it out, who or what runs it, and the row it
 * will be checked by within the horizon.
 */
export const EXECUTION_ASSUMPTION_INSTRUCTION =
  'Add an assumption beginning "execution:" naming the Brain operation (tool, bin, routine or workflow) that will carry out the chosen action, who or what runs it ("run by …"), and the row the work will be checked by within the horizon ("checked by …"); the earlier misses assumed work that was not done as planned';

/** An assumption that names the execution, written as EXECUTION_ASSUMPTION_INSTRUCTION tells the operator to write it. */
export const EXECUTION_ASSUMPTION = /^\s*execution\s*:\s*\S/i;

/** The three parts EXECUTION_ASSUMPTION_INSTRUCTION asks for; a prefix alone names none of them. */
const EXECUTION_OPERATION = /\b(?:tool|bin|routine|workflow|brain_[a-z0-9_]+)s?\b/i;
const EXECUTION_RUNNER = /\b(?:run|runs|executed|performed|carried out)\s+by\s+\S/i;
const EXECUTION_CHECK = /\bchecked\s+by\b(.*)$/i;
const EXECUTION_CHECK_ROW = /\brows?\b|\b[a-z]+_[a-z0-9_]+\b/i;

/**
 * Why no stated "execution:" assumption carries what the instruction asks for —
 * the operation that will do the work, who or what runs it, and the row it will
 * be checked by — or null when one does (or none was stated: that is a separate
 * problem). One complete assumption is enough.
 */
export function executionAssumptionProblem(assumptions: readonly string[]): string | null {
  const stated = assumptions.filter((a) => EXECUTION_ASSUMPTION.test(a));
  if (stated.length === 0) return null;
  const reasons: string[] = [];
  for (const a of stated) {
    const body = a.replace(EXECUTION_ASSUMPTION, (m) => m.slice(-1));
    const missing: string[] = [];
    if (!EXECUTION_OPERATION.test(body)) missing.push('the Brain operation (tool, bin, routine or workflow) that will carry it out');
    if (!EXECUTION_RUNNER.test(body)) missing.push('who or what runs it ("run by …")');
    const check = EXECUTION_CHECK.exec(body);
    if (!check || !EXECUTION_CHECK_ROW.test(check[1] ?? '')) missing.push('the row the work will be checked by ("checked by …")');
    if (missing.length === 0) return null;
    reasons.push(`"${a.slice(0, 120)}" names no ${missing.join(', no ')}`);
  }
  return `no execution assumption names the operation, its runner and the row it is checked by: ${reasons.join('; ')}`;
}

/**
 * The same correction for a bucket whose systematic misses named
 * EVIDENCE_QUALITY (FORECAST:operator:EVIDENCE_QUALITY, production 5 of 5): the
 * prediction decide() records takes its data from the chosen option's evidence,
 * so a chosen option that cites none records a forecast resting on no named
 * data — the cause `claimCausesOf` and the ledger's observed causes both read.
 * Shifting the probability leaves the next decision on the same empty evidence,
 * so the bucket stays miscalibrated. The next decision of that kind cites the
 * rows or sources its chosen option rests on (`goals/calibration.ts`: a claim
 * resting on no named data is not used to rank or accept a plan).
 */
export const EVIDENCE_QUALITY_INSTRUCTION =
  'List in the chosen option\'s evidence the Brain row ids or source URLs the predicted outcome rests on; a prediction resting on no named data is what the earlier misses had';

/**
 * The same correction for a bucket whose systematic misses the ledger read as
 * PARAMETER_ESTIMATE (FORECAST:operator:PARAMETER_ESTIMATE, production 4 of 4:
 * "landed as claimed 0% of the time against an implied 65%: the estimate drawn
 * from its rows is too narrow"). No observation named a cause, so neither a
 * mechanism, a capacity, a condition nor evidence assumption answers it: the
 * stated probability was simply not drawn from the bucket's own record. The
 * probability shift is applied as before, and the recorded claim now carries
 * the figure its estimate starts from — the bucket's observed rate — so it no
 * longer repeats the same unanchored figure: Brain writes that anchor itself
 * when the operator states none (it already read the rate), and an "estimate:"
 * the operator does state must give its base rate as a figure or the decision
 * is sent back.
 */
export const ESTIMATE_ASSUMPTION_INSTRUCTION =
  'Add an assumption beginning "estimate:" stating the observed rate of earlier decisions of this kind (as a percentage or a 0..1 figure) that the predicted probability starts from, and what about this decision justifies departing from it; the earlier misses stated probabilities their own record did not support';

/** An assumption that anchors the estimate, written as ESTIMATE_ASSUMPTION_INSTRUCTION tells the operator to write it. */
export const ESTIMATE_ASSUMPTION = /^\s*estimate\s*:\s*\S/i;

/**
 * A figure an "estimate:" assumption can anchor on: a percentage, or a decimal
 * rate in 0..1 written with its decimal point. A bare integer 0 or 1 is a
 * count ("1 named buyer"), not a rate, so it anchors nothing.
 */
const ESTIMATE_FIGURE = /\b\d{1,3}(?:\.\d+)?\s*%|(?<![\d.])(?:0?\.\d+|1\.0+)(?![\d.%])/;

/**
 * Why the stated "estimate:" assumptions do not anchor the probability, or
 * null when one does. A label alone is not an anchor: at least one must state
 * the base rate it starts from as a figure.
 */
export function estimateAssumptionProblem(assumptions: readonly string[]): string | null {
  const stated = assumptions.filter((a) => ESTIMATE_ASSUMPTION.test(a));
  if (stated.length === 0) return null;
  if (stated.some((a) => ESTIMATE_FIGURE.test(a.replace(ESTIMATE_ASSUMPTION, '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')))) return null;
  return `no estimate assumption states the observed rate it starts from as a figure: ${stated.map((a) => `"${a.slice(0, 120)}"`).join('; ')}`;
}

/**
 * The "estimate:" assumption Brain records itself on a PARAMETER_ESTIMATE
 * bucket when the operator stated none: the bucket's measured rate, which the
 * operator would otherwise be sent back to copy from the ledger Brain already
 * read. Null when the bucket has no such misses, the rate was not measured, or
 * the operator anchored the estimate itself.
 */
export function measuredEstimateAssumption(assumptions: readonly string[], correction: BucketCorrection | null): string | null {
  if (!correction || correction.parameterEstimateClaims.length === 0) return null;
  if (correction.observedRate === null || correction.meanForecast === null) return null;
  if (assumptions.some((a) => ESTIMATE_ASSUMPTION.test(a))) return null;
  return `estimate: decisions of ${correction.comparableKey} happened ${(correction.observedRate * 100).toFixed(0)}% of the time against a stated ${(correction.meanForecast * 100).toFixed(0)}% (PARAMETER_ESTIMATE on ${correction.parameterEstimateClaims.length} systematic miss(es)); the recorded probability starts from that base rate`;
}

/** The chosen option's evidence entries that name something, trimmed. */
function namedEvidence(input: { options: readonly { evidence?: readonly unknown[] }[]; chosen: number }): string[] {
  return (input.options[input.chosen]?.evidence ?? []).map((e) => (typeof e === 'string' ? e.trim() : '')).filter((e) => e.length > 0);
}

/**
 * The chosen option's evidence entries that cite something the outcome can be
 * re-read from — a source URL or a Brain row id (CONDITION_SOURCE), as
 * EVIDENCE_QUALITY_INSTRUCTION asks. 'none', 'n/a' or prose names no data, so
 * it does not answer an EVIDENCE_QUALITY correction.
 */
function citedEvidence(input: { options: readonly { evidence?: readonly unknown[] }[]; chosen: number }): string[] {
  return namedEvidence(input).filter((e) => CONDITION_SOURCE.test(e));
}

/** A source a condition can be re-read from: a URL, or a Brain row id (`arr_2d0bae0f1074`, `opd_…`). */
const CONDITION_SOURCE = /\bhttps?:\/\/\S+|\b[a-z]{2,8}_[0-9a-z]{6,}\b/i;
const CONDITION_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DAY_MS = 86_400_000;

/**
 * Why the stated "condition:" assumptions do not show a re-check, or null when
 * one does. A label alone is not a re-check: at least one condition assumption
 * must cite where the condition can be re-read (a URL or a row id) and the date
 * it was observed, and that date must lie within the decision's horizon before
 * `now` and not after it — an observation older than the horizon is the very
 * carried-over figure the CHANGED_CONDITIONS misses rested on.
 */
export function conditionAssumptionProblem(assumptions: readonly string[], horizonDays: number, now: Date = new Date()): string | null {
  const stated = assumptions.filter((a) => CONDITION_ASSUMPTION.test(a));
  if (stated.length === 0) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowDays = Math.max(1, Math.ceil(Number.isFinite(horizonDays) ? horizonDays : 1));
  const reasons: string[] = [];
  for (const a of stated) {
    if (!CONDITION_SOURCE.test(a)) {
      reasons.push(`"${a.slice(0, 120)}" cites no row id or URL the condition was observed in`);
      continue;
    }
    // A real calendar date only: 2026-02-30 does not round-trip and is not an observation.
    const dates = [...a.matchAll(CONDITION_DATE)]
      .map((m) => ({ text: m[0], t: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) }))
      .filter((d) => Number.isFinite(d.t) && new Date(d.t).toISOString().slice(0, 10) === d.text)
      .map((d) => d.t);
    if (dates.length === 0) {
      reasons.push(`"${a.slice(0, 120)}" gives no YYYY-MM-DD date the condition was observed`);
      continue;
    }
    const observed = Math.max(...dates);
    if (observed > today) {
      reasons.push(`"${a.slice(0, 120)}" dates its observation after today`);
      continue;
    }
    const age = Math.round((today - observed) / DAY_MS);
    if (age > windowDays) {
      reasons.push(`"${a.slice(0, 120)}" was observed ${age} days ago, outside the ${windowDays}-day horizon: re-check it now`);
      continue;
    }
    return null;
  }
  return `no condition assumption shows a re-check within the horizon: ${reasons.join('; ')}`;
}

/**
 * The same correction for a bucket whose systematic misses named TIMING
 * (FORECAST:operator:TIMING, production 1 of 1 on operator:opd_b7fc34fecd867b48):
 * the outcome arrived after the horizon the decision stated, or was measured
 * late (`quant/ledger.ts observedCausesOf`: lateByDays or arrivedLate). Shifting
 * the probability alone leaves the next decision on the same unmeasured lead
 * time, so the bucket stays miscalibrated. The next decision of that kind states
 * how long the outcome takes to become observable, where that lead time was
 * measured, and that it fits inside the horizon it predicts over.
 */
export const TIMING_ASSUMPTION_INSTRUCTION =
  'Add an assumption beginning "timing:" stating the lead time from this decision to the outcome being observable (in hours, days or weeks), the row id or source URL that lead time was measured from, and keep it within the prediction\'s horizon_days; the earlier misses arrived after the horizon they stated';

/** An assumption that names the lead time, written as TIMING_ASSUMPTION_INSTRUCTION tells the operator to write it. */
export const TIMING_ASSUMPTION = /^\s*timing\s*:\s*\S/i;

/** A lead time a "timing:" assumption states: a figure and its unit ("36 hours", "3-day"). A date or a row id is not one. */
const TIMING_LEAD = /(?<![\w.])(\d+(?:\.\d+)?)[\s-]*(hours?|hrs?|h|days?|d|weeks?|wks?|w)\b/gi;

/**
 * A figure the assumption itself marks as some other span — the window the lead
 * time was measured over, a lookback, a retention period, how long ago — is not
 * the lead time. Only an explicit marker excludes a figure; every other figure
 * still counts, and the largest of them is held to the horizon.
 */
const OTHER_SPAN_BEFORE = /\b(?:last|past|previous|prior|trailing|every|each|per)\s+(?:the\s+)?$/i;
const OTHER_SPAN_AFTER = /^[\s-]*(?:of\s+(?:data|history|records?)\b|(?:rolling\s+|trailing\s+|measurement\s+|observation\s+|sample\s+)?(?:window|retention|look-?back|history|sample|ago|old|period|cadence|cycle)\b)/i;

/** The lead times a "timing:" assumption states, in days, leaving out figures it marks as another span. */
function statedLeadDays(text: string): number[] {
  const leads: number[] = [];
  for (const m of text.matchAll(TIMING_LEAD)) {
    const at = m.index ?? 0;
    if (OTHER_SPAN_BEFORE.test(text.slice(Math.max(0, at - 24), at))) continue;
    if (OTHER_SPAN_AFTER.test(text.slice(at + m[0].length, at + m[0].length + 32))) continue;
    const d = leadDays(m[1]!, m[2]!);
    if (Number.isFinite(d) && d > 0) leads.push(d);
  }
  return leads;
}

function leadDays(figure: string, unit: string): number {
  const n = Number(figure);
  const u = unit.toLowerCase();
  if (u.startsWith('h')) return n / 24;
  if (u.startsWith('w')) return n * 7;
  return n;
}

/**
 * Why no stated "timing:" assumption shows a measured lead time that fits the
 * horizon, or null when one does (or none was stated: that is a separate
 * problem). A label alone is not a lead time: at least one timing assumption
 * must cite the row id or URL its lead time was measured in and state a lead
 * time greater than zero and no longer than the decision's horizon — a lead
 * time beyond the horizon is the very late arrival the TIMING misses had.
 */
export function timingAssumptionProblem(assumptions: readonly string[], horizonDays: number): string | null {
  const stated = assumptions.filter((a) => TIMING_ASSUMPTION.test(a));
  if (stated.length === 0) return null;
  const horizon = Number.isFinite(horizonDays) ? horizonDays : 0;
  const reasons: string[] = [];
  for (const a of stated) {
    if (!CONDITION_SOURCE.test(a)) {
      reasons.push(`"${a.slice(0, 120)}" cites no row id or URL the lead time was measured from`);
      continue;
    }
    const text = a.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
    const leads = statedLeadDays(text);
    if (leads.length === 0) {
      reasons.push(`"${a.slice(0, 120)}" states no lead time in hours, days or weeks`);
      continue;
    }
    const lead = Math.max(...leads);
    if (lead > horizon) {
      reasons.push(`"${a.slice(0, 120)}" states a lead time of ${Number(lead.toFixed(2))} day(s), longer than the ${horizon}-day horizon: lengthen the horizon or choose an outcome observable sooner`);
      continue;
    }
    return null;
  }
  return `no timing assumption states a measured lead time within the horizon: ${reasons.join('; ')}`;
}

/** The pools Brain measures capacity in (`engineering/watchdog.ts` PoolReading). */
const CAPACITY_POOLS = ['ROUTINES', 'FREE_LANE', 'RESEARCH_SLOTS', 'FACTORY'] as const;
type CapacityPool = (typeof CAPACITY_POOLS)[number];

/** The measured reading of one pool, as `brain_operator_capacity` serves it. */
export interface CapacityPoolRow {
  pool: CapacityPool;
  running: number;
  capacity: number;
}

/** The pools as `utilizationWithin` served them: null pools when Brain holds no reading. */
export interface CapacityRows {
  pools: readonly CapacityPoolRow[] | null;
  source: string;
  readAt: string | null;
}

/**
 * Hold a "capacity:" assumption to the measured rows (review F1): text alone
 * does not show capacity is there. Every pool the assumptions name must be in
 * the reading and hold less than it may; naming no pool, a pool with no
 * headroom, or having no reading at all is a problem. Null when it holds.
 */
export function capacityAssumptionProblem(assumptions: readonly string[], rows: CapacityRows): string | null {
  const stated = assumptions.filter((a) => CAPACITY_ASSUMPTION.test(a));
  const named = new Set<CapacityPool>();
  for (const a of stated) for (const pool of CAPACITY_POOLS) if (new RegExp(`\\b${pool}\\b`, 'i').test(a)) named.add(pool);
  if (named.size === 0) return `the "capacity:" assumption names none of Brain's measured pools (${CAPACITY_POOLS.join(', ')}), so nothing shows the capacity is there`;
  if (!rows.pools) return `Brain holds no capacity reading (${rows.source}) to show ${[...named].join(', ')} has room`;
  const short: string[] = [];
  for (const pool of named) {
    const row = rows.pools.find((r) => r.pool === pool);
    if (!row) short.push(`${pool} is not in the capacity reading`);
    else if (row.running >= row.capacity) short.push(`${pool} holds ${row.running} of ${row.capacity}, no room`);
  }
  return short.length > 0 ? `the capacity the decision names is not available on the reading taken ${rows.readAt ?? 'now'} (${rows.source}): ${short.join('; ')}` : null;
}

/**
 * Read the bucket's own record off the ledger (§108): forecast.ts's calibration
 * and miss diagnosis, applied to the operator's comparable key. Null when the
 * bucket is calibrated or has too few outcomes to be judged — then a decision
 * commits exactly as stated. Pure over the rows it is given.
 */
export function bucketCorrectionFrom(
  ledger: { predictions: readonly PredictionRow[]; exposures: readonly ExposureRow[]; outcomes: readonly OutcomeRow[] },
  comparableKey: string,
): BucketCorrection | null {
  const predictions = ledger.predictions.filter((p) => p.comparableKey === comparableKey);
  if (predictions.length === 0) return null;
  const ids = new Set(predictions.map((p) => p.id));
  const exposures = ledger.exposures.filter((e) => ids.has(e.predictionId));
  const outcomes = ledger.outcomes.filter((o) => ids.has(o.predictionId));
  const reading = forecastBias(predictions, exposures, outcomes).find((b) => b.comparableKey === comparableKey && b.basis === 'PROBABILITY');
  if (!reading || reading.verdict !== 'SYSTEMATIC' || reading.correction?.kind !== 'SHIFT_PROBABILITY') return null;
  const entries = buildLedger(predictions, exposures, outcomes);
  const buckets = calibrate(entries);
  const missing = new Set<string>();
  const capacity = new Set<string>();
  const changed = new Set<string>();
  const evidence = new Set<string>();
  const estimate = new Set<string>();
  const execution = new Set<string>();
  const timing = new Set<string>();
  for (const entry of entries) {
    const d = diagnose(entry, buckets, entries);
    if (d.kind !== 'SYSTEMATIC') continue;
    if (d.causes.includes('MISSING_MECHANISM')) missing.add(d.claimId);
    if (d.causes.includes('CAPACITY')) capacity.add(d.claimId);
    if (d.causes.includes('CHANGED_CONDITIONS')) changed.add(d.claimId);
    if (d.causes.includes('EVIDENCE_QUALITY')) evidence.add(d.claimId);
    if (d.causes.includes('PARAMETER_ESTIMATE')) estimate.add(d.claimId);
    if (d.causes.includes('EXECUTION_BEHAVIOR')) execution.add(d.claimId);
    if (d.causes.includes('TIMING')) timing.add(d.claimId);
  }
  const measured = buckets.find((b) => b.comparableKey === comparableKey && b.verdict === 'MISCALIBRATED');
  return {
    comparableKey,
    shift: reading.correction.amount,
    rationale: reading.correction.rationale,
    missingMechanismClaims: [...missing],
    capacityShortfallClaims: [...capacity],
    changedConditionClaims: [...changed],
    evidenceQualityClaims: [...evidence],
    parameterEstimateClaims: [...estimate],
    executionBehaviorClaims: [...execution],
    timingLateClaims: [...timing],
    observedRate: measured?.observedRate ?? null,
    meanForecast: measured?.meanForecast ?? null,
  };
}

/** Claim ids per `IN (...)` of `brokenAssumptionsOf`: a page size under every driver's parameter limit, never a cap. */
const BROKEN_ASSUMPTION_PAGE_IDS = 500;

/**
 * The assumptions a verifier recorded as broken on these claims
 * (`OPERATOR_DECISION_VERIFIED.brokenAssumption`), distinct, most recent first,
 * so a REVISE can say which condition changed. Every claim is read — paged so a
 * long bucket never exceeds a statement's parameter limit — and every distinct
 * text is returned: an older broken assumption is still a condition the next
 * decision must re-check. Read-only; a claim with none recorded adds nothing.
 */
export async function brokenAssumptionsOf(claims: readonly string[]): Promise<string[]> {
  const ids = [...new Set(claims.map((c) => c.replace(/^operator:/, '')))];
  if (ids.length === 0) return [];
  const rows: { payload: string | null; created_at: string; id: string }[] = [];
  for (let i = 0; i < ids.length; i += BROKEN_ASSUMPTION_PAGE_IDS) {
    const page = ids.slice(i, i + BROKEN_ASSUMPTION_PAGE_IDS);
    rows.push(
      ...(await getDb().all<{ payload: string | null; created_at: string; id: string }>(
        `SELECT payload, created_at, id FROM project_events WHERE event_type = 'OPERATOR_DECISION_VERIFIED' AND entity_id IN (${page.map(() => '?').join(', ')})`,
        page,
      )),
    );
  }
  rows.sort((a, b) => (a.created_at === b.created_at ? b.id.localeCompare(a.id) : b.created_at.localeCompare(a.created_at)));
  const out = new Set<string>();
  for (const row of rows) {
    try {
      const text = (JSON.parse(row.payload ?? '{}') as { brokenAssumption?: unknown }).brokenAssumption;
      if (typeof text === 'string' && text.trim()) out.add(text.trim().slice(0, 160));
    } catch {
      // An unreadable row names nothing.
    }
  }
  return [...out];
}

/** Rows fetched per round trip of `readComparableLedger`: a page size, never a cap. */
const BUCKET_PAGE_ROWS = 5000;
/** `s` as a LIKE literal: backslash, `%` and `_` each escaped with a backslash, for `LIKE ? ESCAPE '\\'` in both dialects. */
/** `s` as a LIKE literal: `\\`, `%` and `_` escaped with `\\`, for `LIKE ? ESCAPE '\\'` in both dialects. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The forecast ledger as one operator comparable bucket sees it: the predictions
 * made under `comparableKey`, and the exposures and outcomes recorded on the
 * operator's own claims (`operator:opd_*`) — read in the statement, never by
 * paging through every PREDICTION/EXPOSURE/OUTCOME row of every project and
 * filtering in memory. The LIKE patterns only narrow the read; the rows are
 * still parsed and matched exactly (`ledgerFromRows`, then the comparable key
 * and the prediction ids), so a pattern can never admit a row that does not
 * belong. Paged on `(at, id)` like `readLedger`, so nothing past a page is
 * dropped. Every project's decisions of this kind are one bucket, as before.
 */
export async function readComparableLedger(
  comparableKey: string,
  pageRows = BUCKET_PAGE_ROWS,
): Promise<{ predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] }> {
  const { LEDGER_EVENTS, ledgerFromRows } = await import('../quant/ledger.ts');
  const size = Math.max(1, Math.floor(pageRows));
  const rows: { measures: string | null }[] = [];
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const params: (string | number)[] = [
      LEDGER_EVENTS.PREDICTION,
      `%"comparableKey":${likeLiteral(JSON.stringify(comparableKey))}%`,
      LEDGER_EVENTS.EXPOSURE,
      LEDGER_EVENTS.OUTCOME,
      `%"predictionId":"${likeLiteral('operator:')}%`,
    ];
    let where =
      `((event_type = ? AND measures LIKE ? ESCAPE '\\') OR (event_type IN (?, ?) AND measures LIKE ? ESCAPE '\\'))`;
    if (after) {
      where += ' AND (at > ? OR (at = ? AND id > ?))';
      params.push(after.at, after.at, after.id);
    }
    params.push(size);
    const page = await getDb().all<{ id: string; at: string; measures: string | null }>(
      `SELECT id, at, measures FROM bin_events WHERE ${where} ORDER BY at ASC, id ASC LIMIT ?`,
      params,
    );
    rows.push(...page);
    const last = page[page.length - 1];
    if (page.length < size || !last) break;
    after = { at: last.at, id: last.id };
  }
  const ledger = ledgerFromRows(rows);
  const predictions = ledger.predictions.filter((p) => p.comparableKey === comparableKey);
  const ids = new Set(predictions.map((p) => p.id));
  return {
    predictions,
    exposures: ledger.exposures.filter((e) => ids.has(e.predictionId)),
    outcomes: ledger.outcomes.filter((o) => ids.has(o.predictionId)),
  };
}

/** The stated probability moved by the bucket's measured gap, kept strictly inside (0, 1). */
export function correctedProbability(stated: number, correction: BucketCorrection | null): number {
  if (!correction) return stated;
  return Math.round(Math.min(0.99, Math.max(0.01, stated + correction.shift)) * 1000) / 1000;
}

async function projectFor(goalId: string | null, fallback: string): Promise<string> {
  if (!goalId) return fallback;
  const goal = await getWorkstream(goalId);
  return goal?.projectId ?? fallback;
}

/**
 * Review, challenge when it matters, then commit: the event and the ledger
 * prediction. A REVISE from the challenger is returned without committing,
 * unless the operator already answered it (`answeredChallenge`).
 */
export async function decide(
  input: DecisionInput & { answeredChallenge?: string | null },
  ctx: { runId: string | null; projectIds: string[]; models: OperatorModel[]; fetchImpl?: typeof fetch; readCapacity?: () => Promise<CapacityRows> },
): Promise<DecideResult> {
  const review = reviewDecision(input);
  if (!review.ok) return { committed: false, decisionId: null, verdict: 'REFUSED', problems: review.problems, review, challenge: null, next: 'Fix the problems and call again.' };
  if (input.goalId) {
    const goal = await getWorkstream(input.goalId);
    if (!goal || !goal.projectId || !ctx.projectIds.includes(goal.projectId)) {
      return { committed: false, decisionId: null, verdict: 'REFUSED', problems: ['no such goal in a project the operator directs'], review, challenge: null, next: 'Use a goal id from brain_operator_goals.' };
    }
  }
  // The bucket's own record decides how far the stated probability can be taken at its word (FORECAST:operator:*).
  const comparableKey = `operator:${input.kind}`;
  const { recordPrediction } = await import('../quant/ledger.ts');
  // One read, scoped to this bucket, serves both the correction and the version `recordPrediction` assigns.
  const bucket = await readComparableLedger(comparableKey);
  const correction = bucketCorrectionFrom(bucket, comparableKey);
  // Every gap the bucket names is returned in one REVISE: a decision missing both a
  // mechanism and a capacity assumption is told both at once, not one per round-trip.
  if (correction) {
    const problems: string[] = [];
    const instructions: string[] = [];
    const listed = (claims: string[]): string => `${claims.slice(0, 12).join(', ')}${claims.length > 12 ? ', …' : ''}`;
    if (correction.missingMechanismClaims.length > 0 && !input.assumptions.some((a) => MECHANISM_ASSUMPTION.test(a))) {
      const claims = correction.missingMechanismClaims;
      problems.push(
        `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were MISSING_MECHANISM (${listed(claims)}): the step from this decision to its outcome was not in the claim`,
      );
      instructions.push(MECHANISM_ASSUMPTION_INSTRUCTION);
    }
    if (correction.capacityShortfallClaims.length > 0) {
      const claims = correction.capacityShortfallClaims;
      const stated = input.assumptions.some((a) => CAPACITY_ASSUMPTION.test(a));
      // A stated assumption is held to the measured pools; the read is bounded like brain_operator_capacity's own.
      const readCapacity = ctx.readCapacity ?? (async () => (await import('../engineering/watchdog.ts')).utilizationWithin());
      const unmet = stated ? capacityAssumptionProblem(input.assumptions, await readCapacity()) : null;
      if (!stated || unmet) {
        problems.push(
          `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were CAPACITY (${listed(claims)}): the outcome needed capacity the decision assumed and did not have`,
          ...(unmet ? [unmet] : []),
        );
        instructions.push(CAPACITY_ASSUMPTION_INSTRUCTION);
      }
    }
    if (correction.changedConditionClaims.length > 0) {
      const stated = input.assumptions.some((a) => CONDITION_ASSUMPTION.test(a));
      // A stated condition is held to a cited source and an observation date inside the horizon.
      const unmet = stated ? conditionAssumptionProblem(input.assumptions, input.prediction.horizonDays) : null;
      if (!stated || unmet) {
        const claims = correction.changedConditionClaims;
        const broken = await brokenAssumptionsOf(claims);
        problems.push(
          `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were CHANGED_CONDITIONS (${listed(claims)}): a condition the decision assumed no longer held when the outcome arrived${broken.length > 0 ? ` — recorded as broken: ${broken.map((b) => `"${b}"`).join('; ')}` : ''}`,
          ...(unmet ? [unmet] : []),
        );
        instructions.push(CONDITION_ASSUMPTION_INSTRUCTION);
      }
    }
    if (correction.evidenceQualityClaims.length > 0 && citedEvidence(input).length === 0) {
      const claims = correction.evidenceQualityClaims;
      problems.push(
        `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were EVIDENCE_QUALITY (${listed(claims)}): the prediction rested on no named data, and the chosen option again cites no source URL or Brain row id`,
      );
      instructions.push(EVIDENCE_QUALITY_INSTRUCTION);
    }
    if (correction.executionBehaviorClaims.length > 0) {
      const stated = input.assumptions.some((a) => EXECUTION_ASSUMPTION.test(a));
      // A stated execution is held to its three parts, not to the prefix alone.
      const unmet = stated ? executionAssumptionProblem(input.assumptions) : null;
      if (!stated || unmet) {
        const claims = correction.executionBehaviorClaims;
        problems.push(
          `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were EXECUTION_BEHAVIOR (${listed(claims)}): the work the decision assumed was not done as planned, and this decision again names no operation that will carry it out`,
          ...(unmet ? [unmet] : []),
        );
        instructions.push(EXECUTION_ASSUMPTION_INSTRUCTION);
      }
    }
    if (correction.timingLateClaims.length > 0) {
      const stated = input.assumptions.some((a) => TIMING_ASSUMPTION.test(a));
      // A stated timing is held to a cited, measured lead time inside the horizon.
      const unmet = stated ? timingAssumptionProblem(input.assumptions, input.prediction.horizonDays) : null;
      if (!stated || unmet) {
        const claims = correction.timingLateClaims;
        problems.push(
          `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were TIMING (${listed(claims)}): the outcome arrived after the horizon the decision stated, and this decision again states no measured lead time within its ${input.prediction.horizonDays}-day horizon`,
          ...(unmet ? [unmet] : []),
        );
        instructions.push(TIMING_ASSUMPTION_INSTRUCTION);
      }
    }
    if (correction.parameterEstimateClaims.length > 0) {
      // A stated estimate is held to a figure: the base rate it starts from. With none stated,
      // Brain already holds the base rate and records it itself (`measuredEstimateAssumption`).
      const unmet = estimateAssumptionProblem(input.assumptions);
      if (unmet) {
        const claims = correction.parameterEstimateClaims;
        const measured =
          correction.observedRate !== null && correction.meanForecast !== null
            ? `; decisions of this kind happened ${(correction.observedRate * 100).toFixed(0)}% of the time against a stated ${(correction.meanForecast * 100).toFixed(0)}%`
            : '';
        problems.push(
          `${comparableKey} is miscalibrated (${correction.rationale}) and ${claims.length} of its systematic misses were PARAMETER_ESTIMATE (${listed(claims)}): no observation named a cause, and the stated probability was not drawn from the bucket's own record${measured}`,
          unmet,
        );
        instructions.push(ESTIMATE_ASSUMPTION_INSTRUCTION);
      }
    }
    if (problems.length > 0) {
      return {
        committed: false,
        decisionId: null,
        verdict: 'REVISE',
        problems,
        review,
        challenge: null,
        correction,
        next: `${instructions.join('; and ')}, then call again.`,
      };
    }
  }
  let challenge: Challenge | null = null;
  if (review.highImpact) {
    challenge = await challengeDecision(input, review, ctx.models, ctx.fetchImpl);
    if (challenge?.verdict === 'REVISE' && !(input.answeredChallenge ?? '').trim()) {
      return {
        committed: false,
        decisionId: null,
        verdict: 'REVISE',
        problems: [],
        review,
        challenge,
        next: 'The challenger found a flaw that could change the choice. Revise the options, or call again with answered_challenge saying why the choice stands.',
      };
    }
  }
  const id = `opd_${randomBytes(8).toString('hex')}`;
  const projectId = await projectFor(input.goalId, ctx.projectIds[0] ?? '');
  const probability = correctedProbability(input.prediction.probability, correction);
  const anchor = measuredEstimateAssumption(input.assumptions, correction);
  const correctionNote = correction
    ? `forecast correction: ${comparableKey} is miscalibrated (${correction.rationale}); stated ${input.prediction.probability} shifted by ${correction.shift.toFixed(3)} to ${probability}`
    : null;
  const prediction = await recordPrediction(
    {
      claimId: `operator:${id}`,
      outcome: input.prediction.outcome.slice(0, 400),
      horizonDays: input.prediction.horizonDays,
      population: `operator decisions of kind ${input.kind}`,
      data: namedEvidence({ options: review.options, chosen: input.chosen }).slice(0, 10),
      assumptions: [...input.assumptions.slice(0, 10 - (correctionNote ? 1 : 0) - (anchor ? 1 : 0)), ...(anchor ? [anchor] : []), ...(correctionNote ? [correctionNote] : [])],
      probability,
      comparableKey,
    },
    { projectId, caller: 'operator-decision', read: async () => bucket },
  );
  const committedAt = new Date().toISOString();
  await recordEvent({
    projectId,
    entityType: 'PROJECT',
    entityId: id,
    eventType: 'OPERATOR_DECISION',
    payload: { id, runId: ctx.runId, input, review, challenge: challenge ?? (review.highImpact ? 'no challenger model answered' : 'not high impact'), predictionId: prediction.id, correction: correction ? { ...correction, statedProbability: input.prediction.probability, recordedProbability: probability } : null, committedAt },
  });
  return {
    committed: true,
    decisionId: id,
    verdict: 'COMMITTED',
    problems: [],
    review,
    challenge,
    correction,
    next: `Act on it now, then verify it with brain_operator_verify {decision_id: "${id}"} once ${input.prediction.horizonDays} day(s) have passed or the outcome is observable.`,
  };
}

export async function readDecision(id: string): Promise<DecisionRecord | null> {
  const row = await getDb().get<{ project_id: string; payload: string }>(
    `SELECT project_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION' AND entity_id = ? ORDER BY created_at ASC LIMIT 1`,
    [id],
  );
  if (!row) return null;
  const p = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    id,
    input: p['input'] as DecisionInput,
    review: p['review'] as DecisionReview,
    challenge: typeof p['challenge'] === 'object' ? (p['challenge'] as Challenge) : null,
    predictionId: String(p['predictionId']),
    projectId: row.project_id,
    committedAt: String(p['committedAt']),
  };
}

/** Decisions with no outcome yet, oldest first: what the operator owes a verification. */
export async function openDecisions(limit = 10): Promise<{ id: string; kind: string; goalId: string | null; outcome: string; probability: number; dueAt: string; overdue: boolean }[]> {
  const rows = await getDb().all<{ entity_id: string; payload: string }>(
    `SELECT entity_id, payload FROM project_events WHERE event_type = 'OPERATOR_DECISION'
       AND entity_id NOT IN (SELECT entity_id FROM project_events WHERE event_type = 'OPERATOR_DECISION_VERIFIED' AND entity_id IS NOT NULL)
     ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
  const now = Date.now();
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { input: DecisionInput; committedAt: string };
    const due = Date.parse(p.committedAt) + p.input.prediction.horizonDays * 86_400_000;
    return { id: r.entity_id, kind: p.input.kind, goalId: p.input.goalId, outcome: p.input.prediction.outcome, probability: p.input.prediction.probability, dueAt: new Date(due).toISOString(), overdue: due < now };
  });
}

export interface VerifyInput {
  decisionId: string;
  occurred: boolean;
  evidence: string;
  /** What the measurement showed about why, when it missed. */
  signals?: {
    assumptionBroke?: boolean;
    executionDeviated?: boolean;
    mechanismMissing?: boolean;
    capacityShortfall?: boolean;
    arrivedLate?: boolean;
  };
  brokenAssumption?: string | null;
}

/**
 * Record what happened, once, and return what the ledger now says about the
 * operator's decisions of this kind. One miss names a cause from its signals;
 * calibration is only judged over enough comparable outcomes.
 */
export async function verify(input: VerifyInput, ctx: { runId: string | null; projectIds: string[] }): Promise<Record<string, unknown>> {
  const decision = await readDecision(input.decisionId);
  if (!decision || !ctx.projectIds.includes(decision.projectId)) return { ok: false, reason: 'no such decision in a project the operator directs' };
  if (!input.evidence.trim()) return { ok: false, reason: 'state the evidence: the rows or readings the outcome was observed in' };
  const judged = await getDb().get<{ id: string }>(`SELECT id FROM project_events WHERE event_type = 'OPERATOR_DECISION_VERIFIED' AND entity_id = ? LIMIT 1`, [decision.id]);
  if (judged) return { ok: false, reason: 'this decision was already judged; an outcome is never overwritten' };
  const { recordOutcome, readLedger } = await import('../quant/ledger.ts');
  try {
    await recordOutcome(decision.predictionId, input.occurred, input.signals ?? {}, { projectId: decision.projectId, evidence: input.evidence.slice(0, 300), caller: 'operator-decision' });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  await recordEvent({
    projectId: decision.projectId,
    entityType: 'PROJECT',
    entityId: decision.id,
    eventType: 'OPERATOR_DECISION_VERIFIED',
    payload: { decisionId: decision.id, runId: ctx.runId, occurred: input.occurred, evidence: input.evidence.slice(0, 600), signals: input.signals ?? {}, brokenAssumption: input.brokenAssumption ?? null },
  });
  const ledger = await readLedger(decision.projectId);
  return { ok: true, decisionId: decision.id, ...operatorCalibration(ledger, `operator:${decision.input.kind}`) };
}

/** The operator's own record on the ledger for one comparable key: forecasts against what happened. */
export function operatorCalibration(
  ledger: { predictions: { id: string; comparableKey: string; probability: number | null }[]; outcomes: { predictionId: string; occurred: boolean; observedCauses?: readonly string[] }[] },
  comparableKey: string,
): Record<string, unknown> {
  const predictions = ledger.predictions.filter((p) => p.comparableKey === comparableKey && p.probability !== null);
  const judged = predictions
    .map((p) => ({ p, o: ledger.outcomes.find((o) => o.predictionId === p.id) }))
    .filter((x): x is { p: (typeof predictions)[number]; o: (typeof ledger.outcomes)[number] } => !!x.o);
  const n = judged.length;
  const meanForecast = n ? judged.reduce((s, x) => s + (x.p.probability ?? 0), 0) / n : null;
  const hitRate = n ? judged.filter((x) => x.o.occurred).length / n : null;
  const brier = n ? judged.reduce((s, x) => s + ((x.p.probability ?? 0) - (x.o.occurred ? 1 : 0)) ** 2, 0) / n : null;
  const causes = new Map<string, number>();
  for (const x of judged) if (!x.o.occurred) for (const c of x.o.observedCauses ?? []) causes.set(c, (causes.get(c) ?? 0) + 1);
  const enough = n >= 10;
  const mechanismMisses = causes.get('MISSING_MECHANISM') ?? 0;
  const capacityMisses = causes.get('CAPACITY') ?? 0;
  const conditionMisses = causes.get('CHANGED_CONDITIONS') ?? 0;
  const evidenceMisses = causes.get('EVIDENCE_QUALITY') ?? 0;
  const estimateMisses = causes.get('PARAMETER_ESTIMATE') ?? 0;
  const executionMisses = causes.get('EXECUTION_BEHAVIOR') ?? 0;
  const kindName = comparableKey.replace(/^operator:/, '');
  const instructions = [
    ...(mechanismMisses > 0 ? [`${mechanismMisses} miss(es) of ${comparableKey} lacked the step from decision to outcome (MISSING_MECHANISM). In every further ${kindName} decision: ${MECHANISM_ASSUMPTION_INSTRUCTION}.`] : []),
    ...(capacityMisses > 0 ? [`${capacityMisses} miss(es) of ${comparableKey} assumed capacity that was not there (CAPACITY). In every further ${kindName} decision: ${CAPACITY_ASSUMPTION_INSTRUCTION}.`] : []),
    ...(conditionMisses > 0 ? [`${conditionMisses} miss(es) of ${comparableKey} rested on a condition that had changed by the outcome (CHANGED_CONDITIONS). In every further ${kindName} decision: ${CONDITION_ASSUMPTION_INSTRUCTION}.`] : []),
    ...(evidenceMisses > 0 ? [`${evidenceMisses} miss(es) of ${comparableKey} rested on no named data (EVIDENCE_QUALITY). In every further ${kindName} decision: ${EVIDENCE_QUALITY_INSTRUCTION}.`] : []),
    ...(executionMisses > 0 ? [`${executionMisses} miss(es) of ${comparableKey} assumed work that was not done as planned (EXECUTION_BEHAVIOR). In every further ${kindName} decision: ${EXECUTION_ASSUMPTION_INSTRUCTION}.`] : []),
    ...(estimateMisses > 0 ? [`${estimateMisses} miss(es) of ${comparableKey} stated a probability the bucket's record did not support (PARAMETER_ESTIMATE). In every further ${kindName} decision: ${ESTIMATE_ASSUMPTION_INSTRUCTION}.`] : []),
  ];
  return {
    comparableKey,
    judged: n,
    meanForecast,
    hitRate,
    brier,
    missCauses: Object.fromEntries(causes),
    // Told here, where the miss is recorded, rather than first in a REVISE that costs the next decision a round-trip.
    ...(instructions.length > 0 ? { nextDecisionOfThisKind: instructions.join(' ') } : {}),
    reading: !enough
      ? `${n} judged decision(s) of this kind — too few to call the operator's probabilities calibrated or not; investigate each miss by its cause instead`
      : Math.abs((meanForecast ?? 0) - (hitRate ?? 0)) > 0.15
        ? `over ${n} comparable decisions the forecasts averaged ${(meanForecast! * 100).toFixed(0)}% and ${(hitRate! * 100).toFixed(0)}% happened: ${meanForecast! > hitRate! ? 'overconfident — lower probabilities of this kind, and fix the most frequent miss cause' : 'underconfident'}`
        : `over ${n} comparable decisions forecasts and outcomes agree within 15 points (Brier ${brier!.toFixed(3)})`,
  };
}

/**
 * Goals the owner has directed Brain's resources to (2026-11-14: "THE PRIORITY IS
 * THE PLAN. FOCUS RESOURCES THERE."). The operator may never pause one; a person
 * can. Kept equal to the operations report's goal, which is the same order.
 */
export const OWNER_DIRECTED_GOALS: ReadonlySet<string> = new Set(OWNER_DIRECTED_GOAL_IDS);

/**
 * Undo an operator pause of an owner-directed goal. Only a pause whose latest
 * GOAL_PAUSED row an operator run wrote is undone — a person's pause stands.
 * Returns the goals it resumed.
 */
export async function restoreOwnerDirectedGoals(): Promise<string[]> {
  const resumed: string[] = [];
  for (const goalId of OWNER_DIRECTED_GOALS) {
    const goal = await getWorkstream(goalId);
    if (!goal || !goal.pausedAt) continue;
    const last = await getDb().get<{ actor_ref: string }>(
      `SELECT actor_ref FROM workstream_events WHERE workstream_id = ? AND kind = 'GOAL_PAUSED' ORDER BY created_at DESC LIMIT 1`,
      [goalId],
    );
    if (!last || !last.actor_ref.startsWith('operator:')) continue;
    const { resume } = await import('../goals/decide.ts');
    const result = await resume(goalId, 'owner-directive:2026-11-14');
    if (result.ok) resumed.push(goalId);
  }
  return resumed;
}

/**
 * Move capacity between goals by pausing or resuming one, under a committed
 * decision of that kind. Never a goal owed to a customer or committed to
 * somebody (those are the person's to pause), and never without the decision.
 */
export async function setGoalFocus(
  input: { goalId: string; action: 'PAUSE' | 'RESUME'; decisionId: string; reason: string },
  ctx: { runId: string | null; projectIds: string[] },
): Promise<{ ok: boolean; reason: string; consequence?: string }> {
  const decision = await readDecision(input.decisionId);
  const kind = input.action === 'PAUSE' ? 'PAUSE_GOAL' : 'RESUME_GOAL';
  if (!decision || decision.input.kind !== kind || decision.input.goalId !== input.goalId) {
    return { ok: false, reason: `commit a ${kind} decision for this goal first (brain_operator_decide), then pass its id` };
  }
  const goal = await getWorkstream(input.goalId);
  if (!goal || !goal.projectId || !ctx.projectIds.includes(goal.projectId)) return { ok: false, reason: 'no such goal in a project the operator directs' };
  if (input.action === 'PAUSE' && goal.commitment !== 'NONE') {
    return { ok: false, reason: `the goal is committed (${goal.commitment}); only a person pauses a commitment` };
  }
  if (input.action === 'PAUSE' && OWNER_DIRECTED_GOALS.has(input.goalId)) {
    return {
      ok: false,
      reason: 'the owner directed Brain to put its resources on this goal; only a person pauses it — when capacity is short, remove what is slowing it rather than stopping it',
    };
  }
  const { pause, resume } = await import('../goals/decide.ts');
  const actor = `operator:${ctx.runId ?? 'run'}`;
  const result = input.action === 'PAUSE' ? await pause(input.goalId, `${input.reason} (decision ${decision.id})`.slice(0, 500), actor) : await resume(input.goalId, actor);
  if (result.ok) {
    await recordEvent({
      projectId: goal.projectId,
      entityType: 'PROJECT',
      entityId: input.goalId,
      eventType: 'OPERATOR_GOAL_FOCUS',
      payload: { goalId: input.goalId, action: input.action, decisionId: decision.id, runId: ctx.runId, reason: input.reason.slice(0, 500), consequence: result.consequence },
    });
  }
  return { ok: result.ok, reason: result.reason ?? 'done', consequence: result.consequence };
}
