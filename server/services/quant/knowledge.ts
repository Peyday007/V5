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
import { keepCashLedger, readLedger } from './ledger.ts';
import { assessModelLearning, type ModelLearningReading } from './learning.ts';
import type { Correction, ExposureRow, OutcomeRow, PredictionRow } from './forecast.ts';
import { getDb } from '../../db/database.ts';
import { listWorkstreamEvents, recordWorkstreamEvent } from '../../repos/register.ts';
import { upsertCandidate } from '../../repos/improvement.ts';

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
  const learning = await keepCashLedger(projectId, currencies)
    .then(() => learnFromCashLedger(projectId, currencies))
    .catch(() => null);
  const value: CashKnowledge = { projectId, opportunities: new Map(opportunities.map((one) => [one.id, one])), facts: evidence, lessons, sources, watermark, estimates: new Map(), learning };
  cache.set(projectId, { at: now, value });
  return value;
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

/**
 * When each correction took effect, per comparable bucket, read from the ledger. Pure.
 *
 * A correction takes effect when the model states a new version of a corrected
 * claim after the last systematic miss that named the cause: that version is the
 * corrected model, and only outcomes observed from then on say whether it helped.
 * A claim not yet revised since its miss has no entry — nothing has changed to compare.
 */
export function correctionTimes(reading: Pick<ModelLearningReading, 'ledger' | 'diagnoses' | 'corrections'>, predictions: readonly PredictionRow[]): Map<string, string> {
  const outcomeAt = new Map(reading.ledger.filter((e) => e.outcome).map((e) => [e.prediction.id, e.outcome!.observedAt]));
  const out = new Map<string, string>();
  for (const correction of reading.corrections) {
    for (const claimId of correction.claimIds) {
      const missedAt = reading.diagnoses
        .filter((d) => d.kind === 'SYSTEMATIC' && d.claimId === claimId && d.causes.includes(correction.cause))
        .map((d) => outcomeAt.get(d.predictionId) ?? '')
        .reduce((max, at) => (at > max ? at : max), '');
      if (!missedAt) continue;
      const revised = predictions.filter((p) => p.claimId === claimId && p.madeAt > missedAt).sort((a, b) => a.madeAt.localeCompare(b.madeAt))[0];
      if (!revised) continue;
      const held = out.get(revised.comparableKey);
      if (!held || revised.madeAt < held) out.set(revised.comparableKey, revised.madeAt);
    }
  }
  return out;
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

/** The key one correction is routed under: the same cause over the same claims and misses is routed once. */
export function correctionKey(correction: Correction): string {
  return `${correction.cause}|${correction.claimIds.join(',')}|${correction.misses}`;
}

export const CORRECTION_EVENT = 'FORECAST_CORRECTION';

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
}

async function alreadyRouted(goalId: string, key: string): Promise<boolean> {
  const events = await listWorkstreamEvents(goalId, 500);
  return events.some((e) => e.kind === CORRECTION_EVENT && e.detail['key'] === key);
}

/**
 * Read the forecast ledger with the dependency graph and correction times, and
 * act on what it says (LEARN-15-1). The reading is not a report nobody reads:
 *
 *   * every correction is routed to its owner — a software cause to Factory
 *     through the improvement register, the existing intake that engineers
 *     Brain's own repository (§87); a research or commercial-operations cause to
 *     the record of every goal whose plan rests on the corrected claim, which is
 *     where that goal's research and operations read what to change;
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
  const rows = await (deps.read ?? readLedger)();
  const goals = await (deps.goals ?? dependentGoals)(projectId);
  const dependsOn = cashDependencyGraph(projectId, currencies, goals);
  const first = assessModelLearning({ ...rows, dependsOn });
  const correctedAt = correctionTimes(first, rows.predictions);
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
    const key = correctionKey(correction);
    if (correction.owner === 'FACTORY') {
      // Idempotent by weakness key: the register refreshes a live candidate and never reopens a decided one.
      await (deps.toFactory ?? upsertCandidate)({
        weaknessKey: `FORECAST:${correction.cause}`,
        kind: 'FORECAST_MISCALIBRATION',
        title: 'The cash forecast is systematically miscalibrated by its own implementation',
        problem:
          `${correction.misses} systematic miss(es) on ${correction.claimIds.join(', ')}: the same inputs run through the model do not reproduce what the claim stated.`.slice(0, 1000),
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
          researchQuestion: 'forecast calibration model implementation',
          knownCause: `MODEL_IMPLEMENTATION on ${correction.claimIds.join(', ')} (forecast ledger)`,
          observedAt: new Date().toISOString(),
        },
      });
    }
    for (const goal of goals) {
      const claim = planClaimId(goal.id);
      const reaches = (dependsOn.get(claim) ?? []).some((c) => correction.claimIds.includes(c));
      if (!reaches || (await routed(goal.id, key))) continue;
      await note({
        workstreamId: goal.id,
        kind: CORRECTION_EVENT,
        summary: `The cash forecast missed systematically: ${correction.cause} on ${correction.claimIds.length} claim(s), corrected by ${correction.owner}.`.slice(0, 400),
        detail: { key, cause: correction.cause, owner: correction.owner, claimIds: correction.claimIds, misses: correction.misses, recompute: recompute.has(claim) },
        actorRef: 'BRAIN',
      });
      if (recompute.has(claim)) await replan(goal.id, `forecast correction ${correction.cause}`);
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
