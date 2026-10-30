/**
 * Before a research question launches: could any answer change the decision?
 *
 * Pure and code-only. The decision is the deterministic screen's
 * (`screen.ts`): REJECT, HOLD or CLEAR under the goal's own limits. A question
 * is worth asking only if some possible answer to it would move that decision.
 *
 *   * For a question the screen reads (capital, a no-capital route, payment
 *     timing, eligibility, source freshness), the answers are tried in turn on a
 *     copy of the facts and the screen is re-run. If every answer leaves the
 *     verdict where it is, the question is skipped and says why.
 *   * A question the screen does not read (who pays, at what price, how
 *     demand looks, whether we can deliver) bears on whether the piece is worth
 *     pursuing, not on the screen. It is moot once the screen has already
 *     REJECTed - no answer to it un-rejects anything - and decisive otherwise.
 *
 * A skipped question is returned with its reason so the caller can record it;
 * nothing is deleted and nothing is refused for being unfamiliar. The rest are
 * ordered by decision impact, then by cost - the cheapest factual checks first.
 * Evaluating the whole commercial mechanism (repeatability, volume) is a
 * question in its own right, never inferred from one listing's size.
 */
import { screenOpportunity, type ScreenFacts, type ScreenLimits, type ScreenVerdict } from './screen.ts';
import { listWorkstreams } from '../../repos/register.ts';
import { cashEventsOfKindInProject, recordCashEvent } from '../../repos/cashMode.ts';
import { readTarget, type TargetReading } from '../goals/target.ts';
import { QUESTION_SKIPPED_EVENT } from './screenMetrics.ts';
import type { CashOpportunity } from '../../domain/types.ts';

export const RESEARCH_QUESTIONS = [
  'CAPITAL_REQUIRED',
  'NO_CAPITAL_ROUTE',
  'PAYMENT_TIMING',
  'ELIGIBILITY',
  'SOURCE_FRESHNESS',
  'PAYER',
  'PRICE',
  'DEMAND',
  'DELIVERY',
  'REPEATABILITY_VOLUME',
] as const;
export type ResearchQuestion = (typeof RESEARCH_QUESTIONS)[number];

/** Relative cost of answering: a lookup of a stated fact is cheaper than a market study. */
const COST: Record<ResearchQuestion, 1 | 2 | 3> = {
  SOURCE_FRESHNESS: 1,
  ELIGIBILITY: 1,
  PAYMENT_TIMING: 1,
  CAPITAL_REQUIRED: 1,
  NO_CAPITAL_ROUTE: 2,
  PAYER: 2,
  PRICE: 2,
  DELIVERY: 2,
  DEMAND: 3,
  REPEATABILITY_VOLUME: 3,
};

export interface QuestionDecision {
  question: ResearchQuestion;
  ask: boolean;
  /** Why it is skipped, or why it is decisive. */
  why: string;
  /** How many distinct decisions its possible answers lead to (1 means none changes it). */
  distinctOutcomes: number;
  cost: 1 | 2 | 3;
}

const key = (v: ScreenVerdict): string => (v.verdict === 'CLEAR' ? 'CLEAR' : `${v.verdict}:${v.reason}`);

function hypotheticals(question: ResearchQuestion, facts: ScreenFacts): ScreenFacts[] | null {
  switch (question) {
    case 'CAPITAL_REQUIRED':
      return [{ ...facts, capitalRequiredCents: 0 }, { ...facts, capitalRequiredCents: Number.MAX_SAFE_INTEGER }];
    case 'NO_CAPITAL_ROUTE':
      return [{ ...facts, noCapitalRoute: 'a named no-capital route' }, { ...facts, noCapitalRoute: null }];
    case 'PAYMENT_TIMING':
      return [{ ...facts, daysToPayment: 0 }, { ...facts, daysToPayment: 100_000 }];
    case 'ELIGIBILITY':
      return [
        { ...facts, requirements: [], capabilities: facts.capabilities ?? [] },
        { ...facts, requirements: [...facts.requirements, '__unmet_requirement__'], capabilities: facts.capabilities ?? [] },
      ];
    case 'SOURCE_FRESHNESS':
      return [{ ...facts, sourceObservedAt: new Date().toISOString() }];
    default:
      return null; // not read by the screen
  }
}

/** Decide, for one question, whether any possible answer could change the decision. */
export function questionDecision(
  question: ResearchQuestion,
  facts: ScreenFacts,
  limits: ScreenLimits,
  now: string,
): QuestionDecision {
  const base = screenOpportunity(facts, limits, now);
  const cost = COST[question];
  const alternatives = hypotheticals(question, facts);
  if (alternatives === null) {
    if (base.verdict === 'REJECT') {
      return {
        question, ask: false, cost, distinctOutcomes: 1,
        why: `the opportunity is already rejected (${base.reason}); no answer about ${question.toLowerCase().replace(/_/g, ' ')} un-rejects it`,
      };
    }
    return { question, ask: true, cost, distinctOutcomes: 2, why: `${question.toLowerCase().replace(/_/g, ' ')} bears on whether this is worth pursuing, and nothing has rejected it` };
  }
  const outcomes = new Set<string>([key(base), ...alternatives.map((f) => key(screenOpportunity(f, limits, now)))]);
  if (outcomes.size <= 1) {
    return {
      question, ask: false, cost, distinctOutcomes: 1,
      why: `every possible answer leaves the decision at ${key(base)}${base.verdict === 'REJECT' ? ` (${base.detail})` : ''}`,
    };
  }
  return { question, ask: true, cost, distinctOutcomes: outcomes.size, why: `an answer could move the decision between ${[...outcomes].join(', ')}` };
}

export interface QuestionPlan {
  /** To launch, decisive-first, then cheapest-first. */
  ask: QuestionDecision[];
  /** Skipped, each with why - to be recorded rather than dropped silently. */
  skipped: QuestionDecision[];
}

/** Decide a set of questions together and order the ones worth asking. */
export function planQuestions(
  questions: readonly ResearchQuestion[],
  facts: ScreenFacts,
  limits: ScreenLimits,
  now: string,
): QuestionPlan {
  const all = questions.map((q) => questionDecision(q, facts, limits, now));
  const ask = all
    .filter((d) => d.ask)
    .sort((a, b) => b.distinctOutcomes - a.distinctOutcomes || a.cost - b.cost || RESEARCH_QUESTIONS.indexOf(a.question) - RESEARCH_QUESTIONS.indexOf(b.question));
  return { ask, skipped: all.filter((d) => !d.ask) };
}

/** Order card-field keys by cost, cheapest factual checks first. Unknown keys keep their place after known ones. */
const FIELD_QUESTION: Record<string, ResearchQuestion> = {
  payer: 'PAYER', price: 'PRICE', fulfillment: 'DELIVERY', access: 'ELIGIBILITY', demand: 'DEMAND',
};
export function orderFieldsByCost<T extends { key: string }>(fields: readonly T[]): T[] {
  const cost = (f: T): number => {
    const q = FIELD_QUESTION[f.key];
    return q ? COST[q] : 4;
  };
  return fields.map((f, i) => ({ f, i })).sort((a, b) => cost(a.f) - cost(b.f) || a.i - b.i).map((x) => x.f);
}

/* --------------------------------------------------------------------------
 * Using the decision where questions are raised
 * ------------------------------------------------------------------------ */

/** The live goal whose limits the screen reads, or null when the project has none. */
export async function liveGoalTarget(
  projectId: string,
  now: Date = new Date(),
): Promise<{ goalId: string; target: TargetReading } | null> {
  for (const goal of await listWorkstreams({ projectIds: [projectId] })) {
    if (goal.projectId !== projectId || !goal.target) continue;
    const target = await readTarget(goal, now);
    if (target && !target.achieved) return { goalId: goal.id, target };
  }
  return null;
}

/**
 * What the screen can read about an opening from its own row. Nothing is
 * invented: a fact the row does not hold stays unknown, so it can only ever
 * produce a HOLD, and capabilities stay unrecorded so eligibility is never
 * decided from a list Brain does not have.
 */
export function screenFactsFor(opportunity: CashOpportunity, siblings: readonly CashOpportunity[]): ScreenFacts {
  return {
    capitalRequiredCents: opportunity.peakFundingCents,
    noCapitalRoute: null,
    daysToPayment: null,
    expiresAt: opportunity.expiresAt,
    duplicateOf: opportunity.duplicateOfId,
    requirements: [],
    capabilities: null,
    exclusions: [],
    hasPayer: opportunity.payer !== null,
    hasPrice: opportunity.priceCents !== null,
    typeHasHistory: siblings.some((one) => one.id !== opportunity.id && one.mechanism === opportunity.mechanism),
    sourceObservedAt: opportunity.signalObservedAt,
  };
}

/** Which (opening, question) pairs already have a skipped row, so a pass writes each once. */
export async function loadSkipLedger(projectId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const event of await cashEventsOfKindInProject(projectId, QUESTION_SKIPPED_EVENT)) {
    const question = (event.detail as { question?: unknown }).question;
    if (event.opportunityId && typeof question === 'string') seen.add(`${event.opportunityId}|${question}`);
  }
  return seen;
}

/**
 * Decide one card field's question under the goal's limits. A question no
 * answer to which could change the decision is recorded as skipped - once, with
 * why - and reported as not to be asked. An unmapped field is always asked.
 */
export async function askOrSkipField(input: {
  projectId: string;
  opportunity: CashOpportunity;
  fieldKey: string;
  goal: { goalId: string; limits: ScreenLimits };
  siblings: readonly CashOpportunity[];
  ledger: Set<string>;
  now: string;
}): Promise<boolean> {
  const question = FIELD_QUESTION[input.fieldKey];
  if (!question) return true;
  const decision = questionDecision(question, screenFactsFor(input.opportunity, input.siblings), input.goal.limits, input.now);
  if (decision.ask) return true;
  const mark = `${input.opportunity.id}|${question}`;
  if (!input.ledger.has(mark)) {
    input.ledger.add(mark);
    await recordCashEvent({
      projectId: input.projectId,
      opportunityId: input.opportunity.id,
      kind: QUESTION_SKIPPED_EVENT,
      actorRef: 'BRAIN',
      summary: `Did not ask ${question.toLowerCase().replace(/_/g, ' ')} about "${input.opportunity.title}": ${decision.why}.`,
      detail: { question, why: decision.why, goalId: input.goal.goalId, cost: decision.cost },
    });
  }
  return false;
}
