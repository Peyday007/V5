/**
 * Reusable quantitative knowledge, read from the rows that already hold it.
 *
 * There is no second database of economic facts here. What one opportunity's
 * research established — a published payment term, a direct cost, the money
 * that goes out first — is a card fact resting on a gated claim; what buyers
 * actually did is a measured outcome. This module reads those rows and offers
 * them to `reconstruct` as observations about *their own* populations, with
 * the context that decides whether they transfer:
 *
 *   * the opening the target is about is direct evidence; every other opening
 *     is a comparable, discounted for each way it differs and refused outright
 *     where it differs on a dimension that matters for that quantity (a
 *     payment term measured on a resale is not evidence about a commission);
 *   * observations about other transaction types are broad evidence — enough
 *     for bounds, never for a probability;
 *   * a fact's lineage is its claim's source page, so two openings researched
 *     from one published rate card are one observation, not two;
 *   * money facts become *shares of the price* before they travel, because a
 *     cost of 40 on a 100 sale says nothing about a 2,000 sale and a share of
 *     40% does.
 *
 * What one goal's research established therefore makes the next related
 * opening cheaper to understand, and staleness is a property of each fact's
 * own date, so evidence too old to transfer stops transferring by itself.
 *
 * Reads are cached per project for a few minutes, keyed on the newest fact,
 * so a goal tick that infers fifty quantities reads the rows once.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { claimSources } from '../../repos/research.ts';
import { cashOutcomeLessons, type CashLesson } from '../cash/journey/learning.ts';
import { readMoneyFigures } from '../cash/figures.ts';
import type { CashCardFact, CashOpportunity } from '../../domain/types.ts';
import type { Estimate, Observation, QuantityNode } from '../../domain/quant.ts';
import { reconstruct } from './reconstruct.ts';
import { rankRoutesFromLedger, routeMoneyStatement, type RouteMoneyVelocity, type RouteScore } from './deadline.ts';
import { keepCashLedger, readLedger } from './ledger.ts';
import { assessModelLearning, type ModelLearningReading } from './learning.ts';
import { compareAfterCorrection, impliedProbability, MIN_CALIBRATION_SAMPLE } from './forecast.ts';
import type { Correction, CorrectionComparison, ExposureRow, OutcomeRow, PredictionRow } from './forecast.ts';
import { getDb } from '../../db/database.ts';
import { listWorkstreamEvents, recordWorkstreamEvent } from '../../repos/register.ts';
import { upsertCandidate } from '../../repos/improvement.ts';
import { raiseNeed } from '../cash/needs.ts';
import { questionKey } from '../cash/conditions.ts';
import { parseBlockerKey } from '../../domain/types.ts';

/** The opportunity quantities this adapter can infer, and how each is measured. */
export const CASH_QUANTITIES = {
  daysToCash: { label: 'Days from start to usable cash', unit: 'days', kind: 'POSITIVE', fields: ['timeToFirstCash'], material: ['mechanism'], freshDays: 365 },
  costShare: { label: 'Direct cost as a share of the price', unit: 'share', kind: 'RATE', fields: ['directCosts'], material: ['mechanism'], freshDays: 365 },
  capitalShare: { label: 'Money tied up as a share of the price', unit: 'share', kind: 'RATE', fields: ['requiredCapital', 'exposure'], material: ['mechanism'], freshDays: 365 },
  /*
   * The two demand rates (owner, 2026-11-03: "Do not require our own completed
   * sales before making mathematical estimates"). Brain's own outcomes are the
   * best evidence of either, and come first; until there are some, a published
   * rate that research put on an opening's card — a reply rate for reaching
   * buyers of that kind, a close rate for selling them that offer — is a
   * comparable, discounted for every way its population differs.
   */
  respond: { label: 'Share of prospects contacted who reply with interest', unit: 'share', kind: 'RATE', fields: ['conversionRates', 'buyingEvidence'], material: ['mechanism'], freshDays: 1095 },
  close: { label: 'Share of interested buyers who agree', unit: 'share', kind: 'RATE', fields: ['conversionRates', 'buyingEvidence'], material: ['mechanism'], freshDays: 1095 },
} as const;
export type CashQuantity = keyof typeof CASH_QUANTITIES;

export const KNOWLEDGE_TTL_MS = 5 * 60 * 1000;

export interface CashKnowledge {
  projectId: string;
  opportunities: Map<string, CashOpportunity>;
  facts: CashCardFact[];
  lessons: CashLesson[];
  sources: Map<string, { sourceUrl: string | null; sourcePublisher: string | null; sourceDate: string | null }>;
  watermark: string;
  /**
   * What the project's own money ledger measured on each route (MONEY-13-4),
   * keyed by opportunity id, in that opportunity's currency. These figures are
   * direct evidence for the route they were measured on and comparables for
   * the rest, so a goal's scenario is built on what money actually did.
   */
  routeMoney: Map<string, RouteMoneyVelocity>;
  /**
   * Each route's capital turnover and risk-adjusted collectible contribution,
   * scored from its own ledger figures (`scoreRoutes`), keyed by opportunity id.
   * Stated on that route's ledger observations, so the plan names how fast a
   * measured route returned its capital — never a requirement to retain cash.
   */
  routeScores: Map<string, RouteScore>;
  /** Why the ledger could not be read, when it could not; the rest of the knowledge still stands. */
  routeMoneyError: string | null;
  /** Estimates already made for one quantity in one context, reused across openings. */
  estimates: Map<string, Estimate | null>;
  /**
   * The forecast ledger as it stood when this knowledge was read (LEARN-15-1):
   * calibration across comparable forecasts, the diagnosis of each contradicted
   * one and the smallest reusable causes. Null when it could not be read — a
   * ledger failure never stops a goal reading.
   */
  learning: ModelLearningReading | null;
}

const cache = new Map<string, { at: number; value: CashKnowledge }>();

export function forgetKnowledge(): void {
  cache.clear();
}

/** The evidence a project holds, read once and reused while fresh. */
export async function loadCashKnowledge(projectId: string, now = Date.now()): Promise<CashKnowledge> {
  const hit = cache.get(projectId);
  if (hit && now - hit.at < KNOWLEDGE_TTL_MS) return hit.value;
  const [opportunities, facts, lessons] = await Promise.all([listOpportunities({ projectId }), cardFactsForProject(projectId), cashOutcomeLessons(projectId)]);
  const evidence = facts.filter((one) => one.kind === 'EVIDENCE');
  const sources = await claimSources(evidence.map((one) => one.claimId).filter((one): one is string => !!one));
  const watermark = facts.reduce((max, one) => (one.updatedAt > max ? one.updatedAt : max), '');
  // Every refresh keeps the cash forecast's ledger and reads it back: the forecast's figures become
  // versioned claims when they change, and the knowledge carries the calibration reading.
  const currencies = opportunities.map((one) => one.currency).filter((one): one is string => typeof one === 'string' && one.length > 0);
  // The learning step reads the ledger keepCashLedger already holds, writes included: one read of this
  // project's ledger per refresh, never a second read and never one of every project's history (§61/§63).
  const learning = await keepCashLedger(projectId, currencies)
    .then((kept) => learnFromCashLedger(projectId, currencies, { read: async () => kept.ledger }))
    .catch(() => null);
  const { routeMoney, routeScores, routeMoneyError } = await loadRouteMoney(projectId, opportunities);
  const value: CashKnowledge = { projectId, opportunities: new Map(opportunities.map((one) => [one.id, one])), facts: evidence, lessons, sources, watermark, routeMoney, routeScores, routeMoneyError, estimates: new Map(), learning };
  cache.set(projectId, { at: now, value });
  return value;
}

/**
 * Each route's money velocity, read from the ledger once per currency the
 * project's openings are priced in, and kept only in its own opening's
 * currency (a figure in another currency is not about that price).
 */
async function loadRouteMoney(
  projectId: string,
  opportunities: readonly CashOpportunity[],
): Promise<{ routeMoney: Map<string, RouteMoneyVelocity>; routeScores: Map<string, RouteScore>; routeMoneyError: string | null }> {
  const routeMoney = new Map<string, RouteMoneyVelocity>();
  const routeScores = new Map<string, RouteScore>();
  const currencyOf = new Map(opportunities.map((one) => [one.id, one.currency] as const));
  try {
    for (const currency of new Set(opportunities.map((one) => one.currency))) {
      // Scored within one currency, against routes priced in it: a score is only comparable there.
      const { money: routes, ranking } = await rankRoutesFromLedger({ projectId, currency, objective: 'TURNOVER', opportunities });
      for (const money of routes) {
        if (currencyOf.get(money.routeKey) === currency) routeMoney.set(money.routeKey, money);
      }
      for (const score of ranking) {
        if (currencyOf.get(score.routeKey) === currency) routeScores.set(score.routeKey, score);
      }
    }
    return { routeMoney, routeScores, routeMoneyError: null };
  } catch (err) {
    return { routeMoney: new Map(), routeScores: new Map(), routeMoneyError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What a route's ledger measured about one quantity, or null when its rows do
 * not state it. Days to cash is the whole lead-to-usable-cash cycle and needs
 * every stage. A share is an amount over the billings it was measured against,
 * so it travels between prices:
 *
 *   * direct cost is billings less the row-derived gross margin, so refunds,
 *     chargebacks and supplier costs incurred but not yet paid are costs as
 *     well as the outlays already made — a route whose buyer took money back
 *     did not cost only what left for suppliers;
 *   * money tied up is the peak working capital the route's own cash carried
 *     plus what is still restricted (a reserve held from receipts is in the
 *     account and cannot be deployed).
 *
 * A share over one is a loss, not a rate, and is left out rather than clamped.
 */
export function ledgerValue(money: RouteMoneyVelocity, quantity: CashQuantity): Observation['value'] | null {
  if (quantity === 'daysToCash') {
    const { daysLeadToCommitment: a, daysCommitmentToFunds: b, daysFundsToUsableCash: c } = money;
    return a === null || b === null || c === null ? null : { kind: 'POINT', value: a + b + c };
  }
  const billed = money.identities.GROSS_BILLINGS;
  if (billed === null || billed <= 0) return null;
  const margin = money.identities.GROSS_MARGIN;
  const amount =
    quantity === 'costShare'
      ? margin === null
        ? null
        : billed - margin
      : quantity === 'capitalShare'
        ? money.peakWorkingCapital === null
          ? null
          : money.peakWorkingCapital + money.restrictedCash
        : null;
  if (amount === null) return null;
  const share = amount / billed;
  return share >= 0 && share <= 1 ? { kind: 'POINT', value: share, exact: true } : null;
}

/** The ledger's measurements about one quantity, one observation per route that states it. */
export function ledgerObservations(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity): Observation[] {
  const out: Observation[] = [];
  for (const [routeKey, money] of knowledge.routeMoney) {
    const opportunity = knowledge.opportunities.get(routeKey);
    if (!opportunity || opportunity.duplicateOfId) continue;
    const value = ledgerValue(money, quantity);
    if (!value) continue;
    const last = money.supplierOutlays.at(-1)?.at ?? null;
    out.push({
      id: `ledger:${quantity}:${routeKey}`,
      value,
      context: contextOf(opportunity),
      lineage: [`cash_money_entries:${routeKey}`],
      source: { kind: 'LEDGER_ENTRY', ref: routeKey, note: `money ledger of "${opportunity.title.slice(0, 60)}": ${routeMoneyStatement(money, knowledge.routeScores.get(routeKey) ?? null)}` },
      observedAt: last,
      broad: opportunity.mechanism !== target.mechanism,
      measures: `${CASH_QUANTITIES[quantity].label.toLowerCase()} measured on the money ledger of "${opportunity.title.slice(0, 60)}"`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* The ledger reading has consumers (LEARN-15-1)                               */
/* ------------------------------------------------------------------------- */

/** A goal whose plan rests on this project's cash forecast. */
export interface DependentGoal {
  id: string;
  currency: string | null;
}

/** The claim id a goal's plan has on the ledger's dependency graph. */
export function planClaimId(goalId: string): string {
  return `plan:${goalId}`;
}

function cashClaimId(projectId: string, currency: string, figure: 'revenue' | 'contribution'): string {
  // The same id `ledger.ts recordCashForecast` writes, so the graph names the claims the ledger holds.
  return `cash:${projectId}:${currency}:${figure}`;
}

/**
 * What depends on what, read from the claims' own definitions. Pure.
 *
 * Contribution is revenue less direct cost, so it depends on that currency's
 * revenue claim; a goal's plan is composed from the project's cash forecast in
 * the goal's currency (every currency the project prices in when the goal names
 * none), so it depends on both figures there. A correction touching a forecast
 * claim therefore reaches every plan built on it.
 */
export function cashDependencyGraph(projectId: string, currencies: readonly string[], goals: readonly DependentGoal[]): Map<string, string[]> {
  const unique = [...new Set(currencies.filter((c) => typeof c === 'string' && c.trim()))].sort();
  const graph = new Map<string, string[]>();
  for (const c of unique) graph.set(cashClaimId(projectId, c, 'contribution'), [cashClaimId(projectId, c, 'revenue')]);
  for (const goal of goals) {
    const in_ = goal.currency && goal.currency.trim() ? [goal.currency] : unique;
    graph.set(planClaimId(goal.id), in_.flatMap((c) => [cashClaimId(projectId, c, 'revenue'), cashClaimId(projectId, c, 'contribution')]));
  }
  return graph;
}

/** One correction's rounds on one comparable bucket: the one being judged now, and the ones already judged not to have helped. */
export interface CorrectionRound {
  correctedAt: string;
  failed: CorrectionVerdict[];
}

/** When the MIN_CALIBRATION_SAMPLE-th resolved forecast in a bucket at or after `from` was observed: the moment it could be judged. */
function judgeableAt(ledger: ModelLearningReading['ledger'], comparableKey: string, from: string): string | null {
  const times = ledger
    .filter((e) => e.prediction.comparableKey === comparableKey && e.outcome && e.outcome.observedAt >= from && impliedProbability(e.prediction) !== null)
    .map((e) => e.outcome!.observedAt)
    .sort();
  return times[MIN_CALIBRATION_SAMPLE - 1] ?? null;
}

/**
 * When each correction took effect, per comparable bucket, and the earlier rounds of it that did not help. Pure.
 *
 * A correction takes effect when the model states a new version of a corrected claim once the misses that
 * named the cause could be judged — a systematic miss needs a calibration sample, so the first revision
 * after the sample that exposed it is the corrected model. That round stays the one being judged while the
 * observations after it accumulate: later misses on the same cause are what judge it, never a reason to move
 * the anchor past them (which would leave nothing after it to compare). Only once the comparison says
 * NOT_IMPROVED does the next revision, made after the observations that said so, start a new round; the
 * failed round is kept, so the correction is routed again under a key that names it (`correctionKey`).
 * A claim not yet revised since its misses has no entry — nothing has changed to compare.
 */
export function correctionRounds(reading: Pick<ModelLearningReading, 'ledger' | 'diagnoses' | 'corrections'>, predictions: readonly PredictionRow[]): Map<string, CorrectionRound> {
  // A version is resolved by every deal that ended under it, so a diagnosis is matched to its own observation.
  const keyOf = (predictionId: string, observedAt: string | null | undefined, evidence: string | null | undefined): string => `${predictionId}\u0000${observedAt ?? ''}\u0000${evidence ?? ''}`;
  const entry = new Map(reading.ledger.map((e) => [keyOf(e.prediction.id, e.outcome?.observedAt, e.outcome?.evidence), e]));
  const out = new Map<string, CorrectionRound>();
  for (const correction of reading.corrections) {
    for (const claimId of correction.claimIds) {
      const misses = reading.diagnoses
        .filter((d) => d.kind === 'SYSTEMATIC' && d.claimId === claimId && d.causes.includes(correction.cause))
        .map((d) => entry.get(keyOf(d.predictionId, d.observedAt, d.evidence)))
        .filter((e): e is NonNullable<typeof e> => !!e?.outcome)
        .sort((a, b) => a.outcome!.observedAt.localeCompare(b.outcome!.observedAt));
      const firstMiss = misses[0];
      if (!firstMiss) continue;
      const versions = predictions.filter((p) => p.claimId === claimId).sort((a, b) => a.madeAt.localeCompare(b.madeAt));
      const exposed = judgeableAt(reading.ledger, firstMiss.prediction.comparableKey, '');
      const from = exposed && exposed > firstMiss.outcome!.observedAt ? exposed : firstMiss.outcome!.observedAt;
      let revision = versions.find((p) => p.madeAt > from);
      if (!revision) continue;
      const failed: CorrectionVerdict[] = [];
      for (let guard = 0; guard < 50; guard++) {
        const comparison = compareAfterCorrection(reading.ledger, revision.comparableKey, revision.madeAt);
        if (comparison.verdict !== 'NOT_IMPROVED') break;
        const judged = judgeableAt(reading.ledger, revision.comparableKey, revision.madeAt);
        const next = judged ? versions.find((p) => p.madeAt > judged) : undefined;
        if (!next) break;
        failed.push({ comparableKey: revision.comparableKey, correctedAt: revision.madeAt, comparison });
        revision = next;
      }
      // One comparison per bucket: the latest round on it is the one being judged, and every failed round is kept.
      const held = out.get(revision.comparableKey);
      out.set(revision.comparableKey, {
        correctedAt: held && held.correctedAt > revision.madeAt ? held.correctedAt : revision.madeAt,
        failed: [...(held?.failed ?? []), ...failed],
      });
    }
  }
  return out;
}

/** When each correction took effect, per comparable bucket (see `correctionRounds`). Pure. */
export function correctionTimes(reading: Pick<ModelLearningReading, 'ledger' | 'diagnoses' | 'corrections'>, predictions: readonly PredictionRow[]): Map<string, string> {
  return new Map([...correctionRounds(reading, predictions)].map(([key, round]) => [key, round.correctedAt]));
}

/** The goals whose plans read this project's cash knowledge. */
async function dependentGoals(projectId: string): Promise<DependentGoal[]> {
  const rows = await getDb().all<{ id: string; target_currency: string | null }>(
    `SELECT id, target_currency FROM workstreams
      WHERE target_project_id = ? AND target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL
      ORDER BY id`,
    [projectId],
  );
  return rows.map((r) => ({ id: r.id, currency: r.target_currency }));
}

/**
 * The key one correction is routed under: the same cause over the same claims and misses is routed once.
 *
 * A correction whose revision was compared with the next observations and did not improve them
 * (`NOT_IMPROVED`) is a new round of the same correction: the earlier routing did not fix the cause, so
 * the key names each failed revision and the correction is routed again — never mistaken for the reading
 * already on the record because its miss count happened not to move.
 */
export function correctionKey(correction: Correction, failed: readonly CorrectionVerdict[] = []): string {
  const base = `${correction.cause}|${correction.claimIds.join(',')}|${correction.misses}`;
  const rounds = failed.filter((v) => v.comparison.verdict === 'NOT_IMPROVED').map((v) => `${v.comparableKey}@${v.correctedAt}`);
  return rounds.length ? `${base}|not-improved:${[...new Set(rounds)].sort().join(',')}` : base;
}

export const CORRECTION_EVENT = 'FORECAST_CORRECTION';
/** A corrected claim's next observations compared with the misses that exposed the cause, on a goal's record. */
export const COMPARISON_EVENT = 'FORECAST_CORRECTION_COMPARED';

/** One comparison of a correction with the observations after it, with when the correction took effect. */
export interface CorrectionVerdict {
  comparableKey: string;
  correctedAt: string;
  comparison: CorrectionComparison;
}

/**
 * The comparisons that judge one correction: those on the comparable buckets its claims are predicted in. Pure.
 */
export function verdictsFor(
  correction: Correction,
  reading: Pick<ModelLearningReading, 'comparisons'>,
  correctedAt: ReadonlyMap<string, string>,
  predictions: readonly PredictionRow[],
): CorrectionVerdict[] {
  const keys = new Set(predictions.filter((p) => correction.claimIds.includes(p.claimId)).map((p) => p.comparableKey));
  return reading.comparisons
    .filter((c) => keys.has(c.comparableKey) && correctedAt.has(c.comparableKey))
    .map((c) => ({ comparableKey: c.comparableKey, correctedAt: correctedAt.get(c.comparableKey)!, comparison: c.comparison }));
}

/** The key a comparison is recorded under: one record per revision, bucket and verdict, so a change of verdict is news. */
export function comparisonKey(correction: Correction, verdict: CorrectionVerdict): string {
  return `compared|${correction.cause}|${verdict.comparableKey}@${verdict.correctedAt}|${verdict.comparison.verdict}`;
}

/** What a record carries of the calibration and diagnoses behind a correction: bounded, and only its own buckets. */
export function correctionEvidence(
  correction: Correction,
  reading: Pick<ModelLearningReading, 'calibration' | 'diagnoses'>,
  predictions: readonly PredictionRow[],
): { calibration: Record<string, unknown>[]; diagnoses: Record<string, number> } {
  const keys = new Set(predictions.filter((p) => correction.claimIds.includes(p.claimId)).map((p) => p.comparableKey));
  const calibration = reading.calibration
    .filter((b) => keys.has(b.comparableKey) && b.scope === 'POOLED')
    .slice(0, 8)
    .map((b) => ({ comparableKey: b.comparableKey, n: b.n, meanForecast: b.meanForecast, observedRate: b.observedRate, gap: b.gap, zScore: b.zScore, verdict: b.verdict }));
  // Expected misses are counted beside systematic ones, so the record never reads every miss as a model failure.
  const diagnoses: Record<string, number> = {};
  for (const d of reading.diagnoses) if (correction.claimIds.includes(d.claimId)) diagnoses[d.kind] = (diagnoses[d.kind] ?? 0) + 1;
  return { calibration, diagnoses };
}

export interface LearningDeps {
  read?: () => Promise<{ predictions: PredictionRow[]; exposures: ExposureRow[]; outcomes: OutcomeRow[] }>;
  goals?: (projectId: string) => Promise<DependentGoal[]>;
  /** Hand a goal's plan back for an immediate re-read; defaults to `goals/plan.ts requestGoalPlanPass`. */
  replan?: (goalId: string, why: string) => Promise<void> | void;
  /** Whether a correction is already on a goal's record; defaults to reading `workstream_events`. */
  routed?: (goalId: string, key: string) => Promise<boolean>;
  note?: typeof recordWorkstreamEvent;
  /** Factory's intake for a software correction; defaults to the improvement register (§87). */
  toFactory?: typeof upsertCandidate;
  /** The commercial operation's own intake for a non-software correction; defaults to `cash/needs.ts raiseNeed`. */
  raise?: typeof raiseNeed;
  /** The openings whose card figures a cash claim was computed from; defaults to `listOpportunities`. */
  openings?: (projectId: string) => Promise<CashOpportunity[]>;
}

/* ------------------------------------------------------------------------- */
/* A non-software correction opens its owner's work                            */
/* ------------------------------------------------------------------------- */

/** Opening states whose figures `cash/forecast.ts` totals into a claim (its LIVE set). */
const FORECAST_STATES: readonly string[] = ['EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING', 'COLLECTED'];

/**
 * The card fields that carry what each cash claim was computed from: revenue is
 * the openings' prices, contribution is price less the money that goes out first.
 * A research correction re-establishes these, from a different source.
 */
export const CLAIM_FIELDS: Readonly<Record<'revenue' | 'contribution', readonly string[]>> = {
  revenue: ['revenueRange'],
  contribution: ['revenueRange', 'directCosts', 'requiredCapital'],
};

/** At most this many openings get research per correction: the largest figures move a total most. */
export const CORRECTION_OPENINGS = 4;

/** What a cash claim id names: `cash:<project>:<currency>:<figure>`. Null for any other claim. */
export function parseCashClaim(claimId: string): { projectId: string; currency: string; figure: 'revenue' | 'contribution' } | null {
  const m = /^cash:(.+):([^:]+):(revenue|contribution)$/.exec(claimId);
  return m ? { projectId: m[1]!, currency: m[2]!, figure: m[3] as 'revenue' | 'contribution' } : null;
}

function words(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ');
}

/**
 * Open the work a non-software correction needs, with the owner that does it
 * (LEARN-15-1: "research and commercial operations own nonsoftware corrections").
 *
 *   * A RESEARCH cause is a fact under the forecast that was wrong, so each
 *     opening whose figure the corrected claim totals gets a research question
 *     on the field that figure came from — the ordinary question path
 *     (`questionKey`, which `cash/operate.ts startDependentWork` turns into
 *     research), so the answer lands on the card through the evidence gate and
 *     the next forecast and plan are computed from it. The largest figures
 *     first, a bounded number of them.
 *   * A COMMERCIAL_OPERATIONS cause (capacity, timing, execution) is how the
 *     work was run, which no source settles: it becomes one need on the
 *     operation's own review, naming the correction and what settles it.
 *
 * Every need is keyed, so raising it again while it is open adds nothing.
 * Returns the ids of the needs that now carry the correction.
 */
export async function openCorrectionWork(
  projectId: string,
  correction: Correction,
  why: string,
  deps: Pick<LearningDeps, 'raise' | 'openings'> = {},
): Promise<string[]> {
  const intake = deps.raise ?? raiseNeed;
  // One refused or failed need never stops the rest of the correction's work, nor the routing around it.
  const raise = async (input: Parameters<typeof raiseNeed>[0]) => {
    try {
      return await intake(input);
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  };
  const cause = words(correction.cause);
  const claims = correction.claimIds.map(parseCashClaim).filter((c): c is NonNullable<typeof c> => !!c && c.projectId === projectId);
  const ids: string[] = [];
  const settles = `A new version of ${correction.claimIds.join(', ')} is stated after this correction, and outcomes observed from then on are compared with the misses that exposed it.`;

  if (correction.owner === 'RESEARCH' && claims.length > 0) {
    const all = await (deps.openings ?? ((id: string) => listOpportunities({ projectId: id })))(projectId);
    const asked = new Set<string>();
    for (const claim of claims) {
      const feeding = all
        .filter((o) => !o.duplicateOfId && FORECAST_STATES.includes(o.state) && o.currency === claim.currency)
        .sort((a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0) || a.id.localeCompare(b.id))
        .slice(0, CORRECTION_OPENINGS);
      for (const opening of feeding) {
        for (const field of CLAIM_FIELDS[claim.figure]) {
          const key = questionKey(opening.id, field);
          if (asked.has(key)) continue;
          asked.add(key);
          const ask =
            `The cash forecast built on this opening's ${field} missed systematically (${cause}). ` +
            `Re-establish the ${field} for "${opening.title.slice(0, 120)}" from a source other than the one already on the card, ` +
            'with its date, and say whether the earlier figure was wrong, stale or measured on a different population.';
          const raised = await raise({
            projectId,
            opportunityId: opening.id,
            actorRef: 'BRAIN',
            blockedAction: `Correct the ${field} under the ${claim.currency} ${claim.figure} forecast for "${opening.title.slice(0, 120)}"`,
            whyItMatters: `${correction.misses} systematic forecast miss(es) trace to ${cause}; the plans built on this forecast stay wrong until the fact under it is corrected. ${why}`.slice(0, 1000),
            recommendedPath: ask,
            setupEffort: 'One bounded look.',
            nextStep: ask,
            completionCondition: `The ${field} is recorded on this card.`,
            requestKey: key,
            blockerKey: parseBlockerKey(`FIELD:${field}`),
          });
          if (raised.ok) ids.push(raised.value.id);
        }
      }
    }
    if (ids.length > 0) return ids;
  }

  // Commercial operations, or a research cause with no opening left to research: one need on the
  // operation's own review, naming the correction, so the miss is never left at a reading.
  const raised = await raise({
    projectId,
    actorRef: 'BRAIN',
    blockedAction: `Correct the cash forecast's ${cause} (${words(correction.owner)})`,
    whyItMatters: `${correction.misses} systematic miss(es) on ${correction.claimIds.join(', ')} trace to ${cause}, and the plans built on this forecast stay wrong until it is corrected. ${why}`.slice(0, 1000),
    recommendedPath:
      correction.owner === 'COMMERCIAL_OPERATIONS'
        ? `Change how the work is run where ${cause} caused the miss — the capacity committed, the timing promised or the way the work was executed — and record the change on the opportunities it touches.`
        : `Research the ${cause} behind the forecast: which facts under ${correction.claimIds.join(', ')} were wrong, and what the right ones are, each with its source.`,
    setupEffort: 'One bounded look.',
    nextStep: `Read the misses on ${correction.claimIds.join(', ')} in the forecast ledger and correct the ${cause} they share.`,
    completionCondition: settles,
    requestKey: `forecast-correction:${correction.cause}:${correction.claimIds.join(',')}`,
  });
  if (raised.ok) ids.push(raised.value.id);
  return ids;
}

async function alreadyRouted(goalId: string, key: string): Promise<boolean> {
  const events = await listWorkstreamEvents(goalId, 500);
  return events.some((e) => (e.kind === CORRECTION_EVENT || e.kind === COMPARISON_EVENT) && e.detail['key'] === key);
}

/**
 * Read the forecast ledger with the dependency graph and correction times, and
 * act on what it says (LEARN-15-1). The reading is not a report nobody reads:
 *
 *   * every correction is routed to its owner — a software cause to Factory
 *     through the improvement register, the existing intake that engineers
 *     Brain's own repository (§87); a research or commercial-operations cause
 *     opens that owner's work (`openCorrectionWork`: research questions on the
 *     facts under the corrected claim, or a need on the operation's review) and
 *     is noted, with those needs, on the record of every goal whose plan rests on
 *     the corrected claim — and, when no goal's plan rests on it, goes to the
 *     register too, so a systematic miss always produces work and never stops at
 *     a reading;
 *   * every dependent plan in `recompute` is handed back for an immediate re-read
 *     (`requestGoalPlanPass`, the owner of plan recomputation), so the next plan
 *     is built on the corrected claims;
 *   * once a corrected claim has a new version, outcomes after it are compared
 *     with the ones that exposed the cause (`comparisons`).
 *
 * Each correction is routed once per goal: the key is the cause, the claims and
 * the misses it explains, so a new miss is new information and the same reading
 * read again on the next refresh is not.
 */
export async function learnFromCashLedger(projectId: string, currencies: readonly string[], deps: LearningDeps = {}): Promise<ModelLearningReading> {
  // Scoped to this project on purpose. Claim ids are per project (`cash:<project>:…`), every dependent goal
  // is this project's, and a whole-ledger read here would also route other projects' corrections from this
  // project's refresh. Calibration is pooled by comparableKey inside that one project's ledger, and nowhere else.
  const rows = await (deps.read ?? (() => readLedger(projectId)))();
  const goals = await (deps.goals ?? dependentGoals)(projectId);
  const dependsOn = cashDependencyGraph(projectId, currencies, goals);
  const first = assessModelLearning({ ...rows, dependsOn });
  const rounds = correctionRounds(first, rows.predictions);
  const correctedAt = new Map([...rounds].map(([key, round]) => [key, round.correctedAt]));
  const reading = correctedAt.size ? assessModelLearning({ ...rows, dependsOn, correctedAt }) : first;
  if (reading.corrections.length === 0) return reading;

  const recompute = new Set(reading.recompute);
  const note = deps.note ?? recordWorkstreamEvent;
  const routed = deps.routed ?? alreadyRouted;
  const replan =
    deps.replan ??
    (async (goalId: string, why: string) => {
      const { requestGoalPlanPass } = await import('../goals/plan.ts');
      requestGoalPlanPass(goalId, why);
    });
  for (const correction of reading.corrections) {
    // The next observations after this correction's revision, compared with the misses that exposed it. A
    // NOT_IMPROVED verdict makes this a new round of the correction (`correctionKey`), routed again in full.
    const current = verdictsFor(correction, reading, correctedAt, rows.predictions);
    // Earlier rounds already judged NOT_IMPROVED stay part of the correction's identity and its record.
    const earlier = current.flatMap((v) => rounds.get(v.comparableKey)?.failed ?? []);
    const verdicts = [...earlier, ...current];
    const failed = verdicts.filter((v) => v.comparison.verdict === 'NOT_IMPROVED');
    const key = correctionKey(correction, verdicts);
    const evidence = correctionEvidence(correction, reading, rows.predictions);
    const compared = verdicts.map((v) => ({ comparableKey: v.comparableKey, correctedAt: v.correctedAt, ...v.comparison }));
    const reached = goals.filter((goal) => (dependsOn.get(planClaimId(goal.id)) ?? []).some((c) => correction.claimIds.includes(c)));
    const reachedGoal = reached.length > 0;
    const fresh: DependentGoal[] = [];
    for (const goal of reached) if (!(await routed(goal.id, key))) fresh.push(goal);
    // A non-software correction new to some goal opens its owner's work first — research questions on the
    // facts under the corrected claim, or a need on the operation's review — so the goal's record names the
    // work that corrects it and the replan below re-reads a forecast that work will change. Once per new
    // reading: the same correction read again on the next refresh is already routed and opens nothing.
    const why = reading.diagnoses.find((d) => d.kind === 'SYSTEMATIC' && d.causes.includes(correction.cause))?.reason ?? '';
    const needs = correction.owner !== 'FACTORY' && fresh.length > 0 ? await openCorrectionWork(projectId, correction, why, deps) : [];
    for (const goal of fresh) {
      const claim = planClaimId(goal.id);
      await note({
        workstreamId: goal.id,
        kind: CORRECTION_EVENT,
        summary: `The cash forecast missed systematically: ${correction.cause} on ${correction.claimIds.length} claim(s), ${failed.length ? 'an earlier correction did not improve the next observations, corrected again' : 'corrected'} by ${correction.owner}${needs.length ? ` through ${needs.length} opened need(s)` : ''}.`.slice(0, 400),
        detail: {
          key,
          cause: correction.cause,
          owner: correction.owner,
          claimIds: correction.claimIds,
          misses: correction.misses,
          recompute: recompute.has(claim),
          needIds: needs,
          round: failed.length ? 'NOT_IMPROVED' : 'FIRST',
          calibration: evidence.calibration,
          diagnoses: evidence.diagnoses,
          comparisons: compared,
        },
        actorRef: 'BRAIN',
      });
      if (recompute.has(claim)) await replan(goal.id, `forecast correction ${correction.cause}${failed.length ? ' (not improved, again)' : ''}`);
    }
    // Every reached goal's record carries each verdict on the comparison once — IMPROVED, NOT_IMPROVED or how
    // far short TOO_FEW is — so the comparison with the next production observations is a record, not a reading.
    for (const verdict of verdicts) {
      if (verdict.comparison.verdict === 'NO_NEW_OBSERVATIONS') continue;
      const ckey = comparisonKey(correction, verdict);
      const c = verdict.comparison;
      for (const goal of reached) {
        if (await routed(goal.id, ckey)) continue;
        await note({
          workstreamId: goal.id,
          kind: COMPARISON_EVENT,
          summary: `The ${correction.cause} correction to the cash forecast, compared with the ${c.nAfter} observation(s) after it on ${verdict.comparableKey}: ${c.verdict}${c.verdict === 'TOO_FEW' ? ` (${c.nBefore} before, ${c.nAfter} after)` : c.verdict === 'NOT_IMPROVED' ? ', routed again' : ''}.`.slice(0, 400),
          detail: { key: ckey, correctionKey: key, cause: correction.cause, owner: correction.owner, claimIds: correction.claimIds, comparableKey: verdict.comparableKey, correctedAt: verdict.correctedAt, ...c },
          actorRef: 'BRAIN',
        });
      }
    }
    // A software cause always goes to Factory. Any other cause goes to the goals whose plans rest on the
    // claim; when no goal does, nobody would read it there, so it goes to the register as well, naming the
    // measurement or correction it needs. A systematic miss always produces work, never nothing.
    if (correction.owner === 'FACTORY' || !reachedGoal) {
      const software = correction.owner === 'FACTORY';
      // Idempotent by weakness key: the register refreshes a live candidate and never reopens a decided one.
      // A correction that did not improve the next observations is a new weakness: the register never reopens a
      // decided candidate, so the failed round is its own key and Factory or the owner sees it again.
      await (deps.toFactory ?? upsertCandidate)({
        weaknessKey: failed.length ? `FORECAST:${correction.cause}:not-improved:${failed.map((v) => `${v.comparableKey}@${v.correctedAt}`).sort().join(',')}`.slice(0, 200) : `FORECAST:${correction.cause}`,
        kind: 'FORECAST_MISCALIBRATION',
        title: software
          ? 'The cash forecast is systematically miscalibrated by its own implementation'
          : `The cash forecast is systematically miscalibrated: ${correction.cause.toLowerCase().replace(/_/g, ' ')} (${correction.owner.toLowerCase().replace(/_/g, ' ')})`,
        problem: (software
          ? `${correction.misses} systematic miss(es) on ${correction.claimIds.join(', ')}: the same inputs run through the model do not reproduce what the claim stated.`
          : `${correction.misses} systematic miss(es) on ${correction.claimIds.join(', ')} and no goal plan rests on them to carry the correction. ${why}`
        ).slice(0, 1000),
        metric: 'READY_OPPORTUNITIES_PER_DAY',
        downstreamMetric: null,
        ownerComponent: 'server/services/cash/forecast.ts',
        frequency: correction.misses,
        denominator: reading.ledger.filter((e) => e.outcome && correction.claimIds.includes(e.prediction.claimId)).length,
        scope: 'LOCAL',
        severity: correction.misses >= 5 ? 'HIGH' : 'MEDIUM',
        evidence: {
          samples: correction.claimIds,
          mutationScope: ['server/services/cash/forecast.ts', 'server/services/quant/**', 'tests/**'],
          researchQuestion: software ? 'forecast calibration model implementation' : `forecast calibration ${correction.cause.toLowerCase().replace(/_/g, ' ')}`,
          knownCause: `${correction.cause} on ${correction.claimIds.join(', ')} (forecast ledger)`,
          correctionOwner: correction.owner,
          calibration: evidence.calibration,
          diagnoses: evidence.diagnoses,
          comparisons: compared,
          observedAt: new Date().toISOString(),
        },
      });
    }
  }
  return reading;
}

export function priceBand(cents: number | null): string {
  if (cents === null || cents <= 0) return 'unpriced';
  return `1e${Math.floor(Math.log10(cents / 100))}`;
}

export function contextOf(opportunity: CashOpportunity): Record<string, string> {
  return {
    opportunity: opportunity.id,
    mechanism: opportunity.mechanism,
    signal: opportunity.opportunitySignal ?? 'unstated',
    industry: (opportunity.industry ?? 'unstated').toLowerCase().slice(0, 40),
    priceBand: priceBand(opportunity.priceCents),
  };
}

/** Days a published path to cash states: one figure, or a range "14–30 days". */
export function readDayRange(text: string): { low: number; high: number } | null {
  const match = /(\d{1,4})(?:\s*(?:-|–|to)\s*(\d{1,4}))?\s*(business day|day|week|month)s?\b/i.exec(text);
  if (!match) return null;
  const unit = match[3]!.toLowerCase();
  const factor = unit === 'week' ? 7 : unit === 'month' ? 30 : 1;
  const low = Number.parseInt(match[1]!, 10) * factor;
  const high = (match[2] ? Number.parseInt(match[2], 10) : Number.parseInt(match[1]!, 10)) * factor;
  if (!(low > 0) || high < low || high > 3650) return null;
  return { low, high };
}

/** The words that say which demand rate a sentence states. */
const RATE_WORDS: Record<'respond' | 'close', RegExp> = {
  respond: /\b(?:repl(?:y|ies|ied)|respon(?:se|ses|d|ded|ding)|positive repl|interested|meetings? booked|booking rate|lead rate|open rate)\b/i,
  close: /\b(?:clos(?:e|ed|ing)(?: rate)?|conver(?:t|ts|ted|sion)|win rate|won|signed|purchase rate|bought|buy(?:s|ing)?)\b/i,
};
const PERCENT = /(\d{1,2}(?:\.\d+)?)\s*%?\s*(?:-|–|to)\s*(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)|(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)/gi;

/**
 * A published rate of one kind, read from a researched sentence: a single
 * figure ("a 3.4% reply rate") or a range ("closes 10–25%"). Only a sentence
 * that names the rate's own words counts, so a reply rate is never read as a
 * close rate; a figure over 100% is not a rate. Several figures in the
 * sentences that qualify become one range spanning them — the reader never
 * picks the convenient one.
 */
export function readRate(text: string, kind: 'respond' | 'close'): Observation['value'] | null {
  const words = RATE_WORDS[kind];
  const other = RATE_WORDS[kind === 'respond' ? 'close' : 'respond'];
  const figures: number[] = [];
  for (const sentence of text.split(/(?<=[.;!?])\s+|\n+/)) {
    if (!words.test(sentence)) continue;
    // A sentence naming both rates: each figure belongs to whichever rate's words stand nearest it.
    const both = other.test(sentence);
    const distance = (re: RegExp, at: number, end: number) =>
      Math.min(...[...sentence.matchAll(new RegExp(re.source, 'gi'))].map((m) => (m.index! >= end ? m.index! - end : Math.max(0, at - (m.index! + m[0].length)))));
    for (const match of sentence.matchAll(PERCENT)) {
      if (both && distance(other, match.index!, match.index! + match[0].length) < distance(words, match.index!, match.index! + match[0].length)) continue;
      const values = match[3] !== undefined ? [Number(match[3])] : [Number(match[1]), Number(match[2])];
      for (const v of values) if (Number.isFinite(v) && v > 0 && v <= 100) figures.push(Math.round(v * 1e4) / 1e6);
    }
  }
  if (figures.length === 0) return null;
  const low = Math.min(...figures);
  const high = Math.max(...figures);
  return low === high ? { kind: 'POINT', value: low } : { kind: 'RANGE', low, high };
}

function lineageOf(fact: CashCardFact, knowledge: CashKnowledge): string[] {
  const src = fact.claimId ? knowledge.sources.get(fact.claimId) : null;
  if (src?.sourceUrl) {
    try {
      const url = new URL(src.sourceUrl);
      return [`url:${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`];
    } catch {
      return [`url:${src.sourceUrl}`];
    }
  }
  return [`fact:${fact.id}`];
}

/** The observations a project holds about one quantity. */
export function observationsFor(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity): Observation[] {
  const spec = CASH_QUANTITIES[quantity];
  const out: Observation[] = [];
  if (quantity === 'close') {
    for (const lesson of knowledge.lessons) {
      if (lesson.contacts <= 0) continue;
      const same = lesson.mechanism === target.mechanism;
      out.push({
        id: `lesson:${lesson.mechanism ?? '-'}:${lesson.channel ?? '-'}`,
        value: { kind: 'COUNT', successes: lesson.agreements, trials: lesson.contacts },
        context: { mechanism: lesson.mechanism ?? 'unstated', channel: lesson.channel ?? 'unstated' },
        lineage: [`cash_outcomes:${knowledge.projectId}:${lesson.mechanism ?? '-'}:${lesson.channel ?? '-'}`],
        source: { kind: 'OTHER', ref: `cash_outcomes:${lesson.mechanism ?? '-'}`, note: `${lesson.agreements} of ${lesson.contacts} contacts agreed` },
        broad: !same,
        measures: 'agreements per contact, measured on this Brain',
      });
    }
  }
  // What money actually did on a route outranks what research says it would do, so it comes first.
  if (quantity === 'daysToCash' || quantity === 'costShare' || quantity === 'capitalShare') out.push(...ledgerObservations(knowledge, quantity, target));
  for (const fact of knowledge.facts) {
    if (!(spec.fields as readonly string[]).includes(fact.field)) continue;
    const opportunity = knowledge.opportunities.get(fact.opportunityId);
    if (!opportunity || opportunity.duplicateOfId) continue;
    let value: Observation['value'] | null = null;
    if (quantity === 'respond' || quantity === 'close') {
      value = readRate(fact.value, quantity);
    } else if (quantity === 'daysToCash') {
      const days = readDayRange(fact.value);
      if (days) value = days.low === days.high ? { kind: 'POINT', value: days.low } : { kind: 'RANGE', low: days.low, high: days.high };
    } else {
      // A money fact travels as a share of the price it was measured against.
      const price = opportunity.priceCents;
      const figures = readMoneyFigures(fact.value, opportunity.currency).filter((one) => !one.perUnit);
      if (price && price > 0 && figures.length > 0) {
        const share = Math.max(...figures.map((one) => one.cents)) / price;
        // Two published amounts about one opening: an exact ratio, not a sampled rate.
        if (share >= 0 && share <= 1) value = { kind: 'POINT', value: share, exact: true };
      }
    }
    if (!value) continue;
    const src = fact.claimId ? knowledge.sources.get(fact.claimId) : null;
    out.push({
      id: `fact:${fact.id}`,
      value,
      context: contextOf(opportunity),
      lineage: lineageOf(fact, knowledge),
      source: fact.claimId ? { kind: 'CLAIM', ref: fact.claimId, note: src?.sourcePublisher ?? undefined } : { kind: 'CARD_FACT', ref: fact.id },
      observedAt: src?.sourceDate && !Number.isNaN(Date.parse(src.sourceDate)) ? new Date(Date.parse(src.sourceDate)).toISOString() : fact.createdAt,
      broad: opportunity.mechanism !== target.mechanism,
      measures: `${fact.field} on "${opportunity.title.slice(0, 60)}"`,
    });
  }
  return out;
}

/** The node `reconstruct` resolves for one quantity of one opening. */
export function nodeFor(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity): QuantityNode {
  const spec = CASH_QUANTITIES[quantity];
  return {
    key: quantity.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
    label: spec.label,
    unit: spec.unit,
    kind: spec.kind,
    min: 0,
    max: spec.kind === 'RATE' ? 1 : 3650,
    context: contextOf(target),
    material: [...spec.material],
    freshDays: spec.freshDays,
    observations: observationsFor(knowledge, quantity, target),
  };
}

/**
 * Infer one quantity of one opening from everything the project holds, or
 * null when nothing at all bears on it (an UNKNOWN with only physical bounds
 * says nothing the existing sweep did not already say).
 */
export function inferCashQuantity(knowledge: CashKnowledge, quantity: CashQuantity, target: CashOpportunity, now: Date = new Date()): Estimate | null {
  const node = nodeFor(knowledge, quantity, target);
  const observations = node.observations ?? [];
  if (observations.length === 0) return null;
  // Openings that differ only in identity and hold no evidence of their own
  // get the same answer; it is computed once per context.
  const own = observations.some((one) => one.context.opportunity === target.id);
  const { opportunity: _id, ...shared } = contextOf(target);
  const key = own ? null : `${quantity}|${now.toISOString().slice(0, 10)}|${JSON.stringify(shared)}`;
  if (key && knowledge.estimates.has(key)) return knowledge.estimates.get(key)!;
  const est = reconstruct({ nodes: [node] }, node.key, now).estimates[node.key]!;
  const out = est.tier === 'UNKNOWN' ? null : est;
  if (key) knowledge.estimates.set(key, out);
  return out;
}
