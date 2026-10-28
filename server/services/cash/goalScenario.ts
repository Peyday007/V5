/**
 * A goal's scenario model, composed from Brain's own rows.
 *
 * The scenario engine (`services/scenario/`) is pure and knows nothing about
 * Cash. This is the adapter `docs/SCENARIOS.md` names as missing: it reads a
 * targeted goal, the project's live opportunities, their card facts, the
 * ledger and the measured outcome history, and writes a typed
 * `ScenarioModelDefinition` the existing engine runs. It copies no fact into a
 * second ledger — every variable carries a source reference back to the row
 * that owns it — and it invents no number:
 *
 *   * a figure on the card from a gated claim is `EVIDENCE`;
 *   * a person's figure or Brain's proposal is an `ASSUMPTION`, one value;
 *   * a measured rate from this Brain's own finished deals is `HISTORICAL`;
 *   * everything else is `UNKNOWN` and is a swept range whose bounds are named
 *     as a stress interval, never a guess at the truth.
 *
 * Because unknowns are swept, a run over them is a SWEEP and its shares are
 * coverage of tested conditions, not probabilities — the engine enforces that
 * and the plan reading repeats it.
 *
 * The money the model counts is the goal's own figure: for a settled-cash goal,
 * cash that both closes *and* settles before the deadline. A larger deal that
 * pays after the deadline contributes nothing, which is what lets a smaller,
 * faster plan beat a bigger, slower one.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactMap } from '../../repos/cashCardFacts.ts';
import { agreementsFor } from '../../repos/cashJourney.ts';
import { readMoneyFigures } from './figures.ts';
import { readDays } from './monetization/commissionPass.ts';
import { cashOutcomeLessons, LESSON_MIN_SAMPLE } from './journey/learning.ts';
import { isTestFirstPlay } from './tier.ts';
import { sharedFrontier } from './shared.ts';
import { cashPosition } from './money.ts';
import type { CashOpportunity, CashCardFact } from '../../domain/types.ts';
import { SCENARIO_LIMITS, type ScenarioModelDefinition, type ScenarioVariable, type SourceRef, type StrategySpec, type VariableProvenance } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';
import type { TargetReading } from '../goals/target.ts';

/** Variables the model declares once, and per opportunity. */
export const GOAL_MODEL_VARIABLES = 4;
export const OPPORTUNITY_MODEL_VARIABLES = 8;
/**
 * At most this many opportunities in one model, derived from the engine's own
 * variable limit rather than written beside it — a constant written beside it
 * was 5, which is 44 variables, and production refused the first real model.
 */
export const MAX_MODEL_OPPORTUNITIES = Math.floor((SCENARIO_LIMITS.maxVariables - GOAL_MODEL_VARIABLES) / OPPORTUNITY_MODEL_VARIABLES);
/** A repeatable play's strategy offers to this many times the buyers it needs. */
export const OUTREACH_MULTIPLE = 4;
/** And never more than this many buyers in one strategy. */
export const MAX_BUYERS_OFFERED = 200;

const LIVE = new Set(['DISCOVERED', 'EVIDENCE_CARD', 'READY', 'EXECUTING', 'DELIVERING']);
const IN_FLIGHT = new Set(['EXECUTING', 'DELIVERING']);
const TIER_ORDER: Record<string, number> = { READY_TO_TEST: 0, QUALIFIED: 1, CANDIDATE: 2, SIGNAL: 3 };

/** One quantity about one opportunity, with where it came from. */
export interface ModelInput {
  value: number | null;
  low: number | null;
  high: number | null;
  provenance: VariableProvenance;
  source: SourceRef | null;
  note: string;
}

export interface ModelledOpportunity {
  opportunity: CashOpportunity;
  index: number;
  tier: string;
  repeatable: boolean;
  /** Major units of the goal's currency. */
  price: ModelInput;
  capital: ModelInput;
  hours: ModelInput;
  daysToCash: ModelInput;
  close: ModelInput;
  directCost: ModelInput;
  /** A live agreement already recorded for this opportunity. */
  agreed: boolean;
  /** What those agreements are worth, in major units: money a buyer has already agreed to. */
  agreedValue: number;
}

export interface GoalModel {
  definition: ScenarioModelDefinition;
  included: ModelledOpportunity[];
  excluded: { opportunityId: string; title: string; reason: string }[];
  /** Why nothing could be modelled, when nothing could. */
  refusal: string | null;
}

function kindToProvenance(fact: CashCardFact | null): { provenance: VariableProvenance; source: SourceRef | null } {
  if (!fact) return { provenance: 'UNKNOWN', source: null };
  if (fact.kind === 'EVIDENCE') return { provenance: 'EVIDENCE', source: fact.claimId ? { kind: 'CLAIM', ref: fact.claimId } : { kind: 'CARD_FACT', ref: fact.id } };
  return { provenance: 'ASSUMPTION', source: { kind: 'CARD_FACT', ref: fact.id, note: fact.kind === 'PERSON' ? 'a person said so' : "Brain's proposal" } };
}

function known(value: number, provenance: VariableProvenance, source: SourceRef | null, note: string): ModelInput {
  return { value, low: value, high: value, provenance, source, note };
}

function unknown(low: number, high: number, note: string): ModelInput {
  return { value: null, low, high, provenance: 'UNKNOWN', source: null, note };
}

/** Wilson score interval for a rate measured as successes out of trials. */
export function wilson(successes: number, trials: number, z = 1.96): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/** Everything the model needs to know about one opportunity, read from its rows. */
async function modelOpportunity(
  opportunity: CashOpportunity,
  index: number,
  tier: string,
  currency: string,
  lessons: Awaited<ReturnType<typeof cashOutcomeLessons>>,
): Promise<ModelledOpportunity | { reason: string }> {
  const fact = await cardFactMap(opportunity.id);
  const ref: SourceRef = { kind: 'CASH_OPPORTUNITY', ref: opportunity.id };

  // Price: the column, else the low end of a published revenue range.
  let price: ModelInput | null = null;
  if (opportunity.priceCents !== null && opportunity.priceCents > 0) {
    const p = kindToProvenance(fact('price'));
    price = known(opportunity.priceCents / 100, p.provenance === 'UNKNOWN' ? 'ASSUMPTION' : p.provenance, p.source ?? ref, 'the price on the card');
  } else {
    const range = fact('revenueRange');
    const figures = range ? readMoneyFigures(range.value, currency).filter((one) => !one.perUnit) : [];
    if (range && figures.length > 0) {
      const values = figures.map((one) => one.cents / 100).sort((a, b) => a - b);
      const p = kindToProvenance(range);
      price = { value: null, low: values[0]!, high: values[values.length - 1]!, provenance: p.provenance, source: p.source, note: 'the revenue range the sources state' };
    }
  }
  if (!price) return { reason: 'no price on the card and no published revenue figure: research the price first' };
  const top = price.high ?? price.value ?? 0;

  const exposure = fact('exposure');
  const capital =
    opportunity.peakFundingCents !== null
      ? known(opportunity.peakFundingCents / 100, kindToProvenance(exposure).provenance === 'UNKNOWN' ? 'ASSUMPTION' : kindToProvenance(exposure).provenance, kindToProvenance(exposure).source ?? ref, 'money tied up before it pays')
      : unknown(0, top, 'nobody has established the money tied up; swept from nothing to the whole price');

  const hoursFact = fact('hours');
  const hours =
    opportunity.humanHours !== null
      ? known(opportunity.humanHours, hoursFact ? kindToProvenance(hoursFact).provenance : 'ASSUMPTION', ref, 'hours of work per deal')
      : unknown(1, 40, 'nobody has established the hours; swept from 1 to 40 per deal');

  const ttc = fact('timeToFirstCash');
  const ttcDays = ttc ? readDays(ttc.value) : null;
  const daysToCash =
    ttcDays !== null
      ? known(ttcDays, kindToProvenance(ttc).provenance, kindToProvenance(ttc).source, 'days from start to usable cash')
      : unknown(3, 60, 'nobody has established when the money would settle; swept from 3 to 60 days');

  const costFact = fact('directCosts');
  const costFigures = costFact ? readMoneyFigures(costFact.value, currency).filter((one) => !one.perUnit) : [];
  const directCost =
    costFigures.length > 0
      ? known(Math.max(...costFigures.map((one) => one.cents)) / 100, kindToProvenance(costFact).provenance, kindToProvenance(costFact).source, 'the highest published direct cost')
      : unknown(0, Math.max(1, top * 0.6), 'nobody has established the direct cost; swept from nothing to 60% of the price');

  const agreements = (await agreementsFor(opportunity.id)).filter((one) => !one.releasedAt);
  const lesson = lessons.find((one) => one.mechanism === opportunity.mechanism && one.contacts >= LESSON_MIN_SAMPLE);
  // An agreement is one buyer's yes, and is counted as that money — never as a
  // rate the next buyer will match. More buyers need a measured rate of their own.
  let close: ModelInput;
  if (lesson) {
    const bounds = wilson(lesson.agreements, lesson.contacts);
    close = {
      value: null,
      low: bounds.low,
      high: bounds.high,
      provenance: 'HISTORICAL',
      source: { kind: 'OTHER', ref: `cash_outcomes:${opportunity.mechanism}`, note: `${lesson.agreements} agreements from ${lesson.contacts} contacts` },
      note: `measured on this Brain: ${lesson.agreements} of ${lesson.contacts} contacts agreed`,
    };
  } else {
    close = unknown(0.02, 0.5, 'no buyer has been asked yet; swept from 2% to 50% of buyers agreeing');
  }

  return {
    opportunity,
    index,
    tier,
    repeatable: isTestFirstPlay(opportunity),
    price,
    capital,
    hours,
    daysToCash,
    close,
    directCost,
    agreed: agreements.length > 0,
    agreedValue: agreements.reduce((sum, one) => sum + one.amountCents, 0) / 100,
  };
}

function variable(key: string, label: string, unit: string, input: ModelInput): ScenarioVariable {
  const spec =
    input.value !== null
      ? { kind: 'FIXED' as const, value: input.value }
      : { kind: 'RANGE' as const, min: input.low ?? 0, max: Math.max(input.high ?? 0, (input.low ?? 0) + 1e-9) };
  return {
    key,
    label,
    unit,
    provenance: input.provenance,
    controllable: false,
    spec,
    sources: input.source ? [input.source] : [],
    note: input.note,
  };
}

/** Compose the model, or say exactly why there is nothing to model. */
export async function composeGoalModel(input: { goal: Workstream; target: TargetReading; now?: Date }): Promise<GoalModel> {
  const { goal, target } = input;
  const excluded: GoalModel['excluded'] = [];
  const refuse = (refusal: string): GoalModel => ({
    definition: { title: goal.title, currency: target.currency, horizon: 'until the goal is due', variables: [], lines: [], strategies: [] },
    included: [],
    excluded,
    refusal,
  });
  if (target.daysLeft === null) return refuse('The goal has no due date, so there is no window to count money inside. Set one with `goals terms --due`.');
  if (target.daysLeft <= 0) return refuse('The goal is past its due date.');
  if (target.achieved) return refuse('The target is already met.');

  const frontier = await sharedFrontier({ projectId: target.projectId });
  const tierOf = new Map(frontier.opportunities.map((one) => [one.id, one.tier.tier as string]));
  const live = (await listOpportunities({ projectId: target.projectId })).filter(
    (one) => LIVE.has(one.state) && !one.duplicateOfId && one.currency === target.currency,
  );
  const ordered = live.sort((a, b) => {
    const fa = IN_FLIGHT.has(a.state) ? 0 : 1;
    const fb = IN_FLIGHT.has(b.state) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ta = TIER_ORDER[tierOf.get(a.id) ?? 'SIGNAL'] ?? 3;
    const tb = TIER_ORDER[tierOf.get(b.id) ?? 'SIGNAL'] ?? 3;
    if (ta !== tb) return ta - tb;
    const pa = a.priceCents !== null ? 0 : 1;
    const pb = b.priceCents !== null ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const lessons = await cashOutcomeLessons(target.projectId);
  const included: ModelledOpportunity[] = [];
  for (const opportunity of ordered) {
    const tier = tierOf.get(opportunity.id) ?? 'SIGNAL';
    if (tier === 'SIGNAL' && !IN_FLIGHT.has(opportunity.state)) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: 'evidence only: nobody has shown who would pay us' });
      continue;
    }
    // A closed opening can contribute nothing, so it must not take one of the
    // few slots a better one needs. Production, 2026-10-28: all four slots
    // went to auctions and a notice that had already closed, and the plan read
    // NOT_VIABLE for that reason alone.
    if (opportunity.expiresAt && Date.parse(opportunity.expiresAt) < (input.now ?? new Date()).getTime()) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `closed on ${opportunity.expiresAt.slice(0, 10)}` });
      continue;
    }
    if (included.length >= MAX_MODEL_OPPORTUNITIES) {
      excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: `beyond the ${MAX_MODEL_OPPORTUNITIES} closest to a decision` });
      continue;
    }
    const modelled = await modelOpportunity(opportunity, included.length + 1, tier, target.currency, lessons);
    if ('reason' in modelled) excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: modelled.reason });
    else included.push(modelled);
  }
  if (included.length === 0) {
    return refuse(
      live.length === 0
        ? 'There is no live opportunity in this project to build a plan from.'
        : 'No live opportunity is far enough along to model: each one is evidence only or has no price anywhere.',
    );
  }

  const position = await cashPosition({ projectId: target.projectId, currency: target.currency });
  const variables: ScenarioVariable[] = [
    variable('remaining', 'Still needed to reach the target', target.currency, known(target.remainingCents / 100, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}`, note: 'target less what the ledger shows' }, 'target less the ledger')),
    variable('days_left', 'Days until the goal is due', 'days', known(target.daysLeft, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}` }, 'the goal row')),
    variable(
      'capital_ceiling',
      'Money the plan may tie up',
      target.currency,
      target.capitalCeilingCents !== null
        ? known(target.capitalCeilingCents / 100, 'EVIDENCE', { kind: 'PERSON', ref: `workstream:${goal.id}`, note: 'the ceiling a person set' }, 'the ceiling a person set')
        : known(Math.max(0, position.deployableCents) / 100, 'EVIDENCE', { kind: 'LEDGER_ENTRY', ref: `project:${target.projectId}`, note: 'deployable cash' }, 'deployable cash on the ledger'),
    ),
    variable(
      'hours_available',
      'Working hours available before the deadline',
      'hours',
      target.hoursCeiling !== null
        ? known(target.hoursCeiling, 'EVIDENCE', { kind: 'PERSON', ref: `workstream:${goal.id}` }, 'the hours a person set')
        : unknown(20, 160, 'nobody has said how many hours are available; swept from 20 to 160'),
    ),
  ];
  const derived: NonNullable<ScenarioModelDefinition['derived']> = [];
  const lines: ScenarioModelDefinition['lines'] = [];
  const exposure: string[] = [];
  const labour: string[] = [];
  const cashIn: string[] = [];
  const slowest: string[] = [];
  for (const one of included) {
    const o = `o${one.index}`;
    const name = one.opportunity.title.slice(0, 50);
    variables.push(
      variable(`${o}_price`, `${name}: price`, target.currency, one.price),
      variable(`${o}_capital`, `${name}: money tied up per deal`, target.currency, one.capital),
      variable(`${o}_hours`, `${name}: hours per deal`, 'hours', one.hours),
      variable(`${o}_days`, `${name}: days to usable cash`, 'days', one.daysToCash),
      variable(`${o}_close`, `${name}: share of buyers who agree`, 'share', one.close),
      variable(`${o}_cost`, `${name}: direct cost per deal`, target.currency, one.directCost),
      variable(`${o}_agreed`, `${name}: already agreed by a buyer`, target.currency, known(one.agreedValue, 'EVIDENCE', { kind: 'CASH_OPPORTUNITY', ref: one.opportunity.id, note: 'recorded buyer agreements' }, 'money a buyer has agreed to')),
      {
        key: `${o}_n`,
        label: `${name}: buyers offered`,
        unit: 'buyers',
        provenance: 'ASSUMPTION',
        controllable: true,
        spec: { kind: 'FIXED', value: 0 },
        note: 'a choice the strategy makes',
      },
    );
    derived.push(
      { key: `${o}_won`, label: `${name}: deals won`, unit: 'deals', expr: `${o}_n * ${o}_close` },
      { key: `${o}_in`, label: `${name}: settles before the deadline`, unit: 'flag', expr: `if(${o}_days <= days_left, 1, 0)` },
    );
    lines.push(
      { key: `${o}_cash`, label: `${name}: settled inside the window`, kind: 'REVENUE', expr: `(${o}_agreed + ${o}_won * ${o}_price) * ${o}_in` },
      { key: `${o}_spend`, label: `${name}: direct costs`, kind: 'COST', expr: `${o}_won * ${o}_cost` },
    );
    exposure.push(`${o}_n * ${o}_capital`);
    labour.push(`${o}_won * ${o}_hours`);
    cashIn.push(`(${o}_agreed + ${o}_won * ${o}_price) * ${o}_in`);
    slowest.push(`if(${o}_n + ${o}_agreed > 0, ${o}_days, 0)`);
  }
  derived.push({ key: 'settled_in_window', label: 'Cash settled before the deadline', unit: target.currency, expr: cashIn.join(' + ') });
  const metrics: NonNullable<ScenarioModelDefinition['metrics']> = [
    { key: 'goal_met', label: 'Reaches the target in time', unit: 'flag', expr: 'if(settled_in_window >= remaining, 1, 0)', better: 'HIGHER' },
    { key: 'settled', label: 'Settled before the deadline', unit: target.currency, expr: 'settled_in_window', better: 'HIGHER' },
    { key: 'exposure', label: 'Money tied up', unit: target.currency, expr: exposure.join(' + '), better: 'LOWER', role: 'CAPITAL_EXPOSURE' },
    { key: 'labour', label: 'Hours of work', unit: 'hours', expr: labour.join(' + '), better: 'LOWER', role: 'LABOR_HOURS' },
    { key: 'days', label: 'Slowest money to settle', unit: 'days', expr: slowest.length > 1 ? `max(${slowest.join(', ')})` : slowest[0]!, better: 'LOWER', role: 'DAYS_TO_CASH' },
  ];
  const constraints: NonNullable<ScenarioModelDefinition['constraints']> = [
    { key: 'capital', label: 'Within the money the plan may tie up', expr: exposure.join(' + '), op: '<=', value: 0 },
    { key: 'hours', label: 'Within the hours available', expr: `${labour.join(' + ')} - hours_available`, op: '<=', value: 0 },
  ];
  // The capital constraint compares against a variable, so it is written as a difference.
  constraints[0] = { key: 'capital', label: 'Within the money the plan may tie up', expr: `${exposure.join(' + ')} - capital_ceiling`, op: '<=', value: 0 };

  const strategies: StrategySpec[] = [];
  // How many new buyers a strategy offers to. Agreed money needs none; a
  // one-off needs its one buyer; a repeatable play offers to OUTREACH_MULTIPLE
  // times as many buyers as the deals still needed — a choice the strategy
  // makes and states, not an assumption about how many will say yes.
  const dealsFor = (one: ModelledOpportunity) => {
    const gap = Math.max(0, target.remainingCents / 100 - one.agreedValue);
    if (gap === 0) return 0;
    if (!one.repeatable) return one.agreedValue > 0 ? 0 : 1;
    const price = one.price.value ?? one.price.low ?? 1;
    return Math.min(MAX_BUYERS_OFFERED, Math.ceil(gap / Math.max(1, price)) * OUTREACH_MULTIPLE);
  };
  const none = () => Object.fromEntries(included.map((one) => [`o${one.index}_n`, 0]));
  for (const one of included) {
    if (strategies.length >= 6) break;
    strategies.push({
      key: `only_o${one.index}`,
      label: `Only: ${one.opportunity.title.slice(0, 60)}`,
      set: { ...none(), [`o${one.index}_n`]: dealsFor(one) },
    });
  }
  if (included.length > 1) {
    const fast = included.filter((one) => one.daysToCash.value !== null && one.daysToCash.value <= target.daysLeft!);
    if (fast.length > 1) {
      strategies.push({
        key: 'basket_fast',
        label: 'Every opening known to settle before the deadline',
        set: { ...none(), ...Object.fromEntries(fast.map((one) => [`o${one.index}_n`, dealsFor(one)])) },
      });
    }
    strategies.push({
      key: 'basket_all',
      label: 'Every modelled opening at once',
      set: { ...none(), ...Object.fromEntries(included.map((one) => [`o${one.index}_n`, dealsFor(one)])) },
    });
  }

  return {
    definition: {
      title: `Plan for: ${goal.title}`.slice(0, 120),
      description: `Composed from goal ${goal.id} and project ${target.projectId}. Counts ${target.metricLabel} that settles before the due date.`,
      currency: target.currency,
      horizon: `${target.daysLeft} days until the goal is due`,
      variables,
      derived,
      lines,
      metrics,
      constraints,
      strategies: strategies.slice(0, 8),
    },
    included,
    excluded,
    refusal: null,
  };
}
