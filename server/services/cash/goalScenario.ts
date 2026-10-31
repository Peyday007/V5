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
import type { CashOpportunity, CashCardFact } from '../../domain/types.ts';
import { SCENARIO_LIMITS, type ScenarioModelDefinition, type ScenarioVariable, type SourceRef, type StrategySpec, type VariableProvenance } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';
import type { TargetReading } from '../goals/target.ts';
import { inferCashQuantity, loadCashKnowledge, type CashKnowledge, type CashQuantity } from '../quant/knowledge.ts';
import { toScenarioInput } from '../quant/export.ts';
import type { Estimate, EvidenceTier } from '../../domain/quant.ts';
import type { VariableSpec } from '../../domain/scenario.ts';

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
  /**
   * A distribution or narrowed range the quantitative inference engine (§79)
   * reconstructed for an unknown from comparable or component evidence. `value`
   * stays null: an inferred number never establishes a link of the plan's
   * causal chain, it only replaces a blind sweep with an evidenced one.
   */
  distribution?: VariableSpec;
  inferred?: { tier: EvidenceTier; justified: boolean; p10: number; p50: number; p90: number; observations: number };
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
  /** How many live agreements that is: each one is a deal that may tie up money too. */
  agreedDeals: number;
  /**
   * Who does the work, when a source or a person has said so. Brain is one
   * possible fulfiller, never the only one: a partner, a subcontractor, a
   * supplier or the owner's own people fulfil just as well, and a plan that
   * only counted Brain's own deliverables could never contain a brokered,
   * logistics or resale opening.
   */
  fulfilledBy: { value: string; provenance: VariableProvenance; source: SourceRef | null } | null;
  /**
   * Money only comes after somebody else picks us: a bid, a tender, a
   * solicitation, a grant. That is a gate outside our control before any work,
   * a second wait after it for payment, and usually money spent to compete —
   * and it pays in one lump at the end, not little by little.
   */
  competitiveAward: boolean;
}

/**
 * Whether the opening is won by competing for an award. Read from the words
 * that name what it is — the title, the source and the published signal — and
 * deliberately narrow: a missed one is treated like any other opening, and a
 * wrong one only ranks lower and keeps Brain looking.
 */
export const COMPETITIVE_AWARD = /\b(rfp|rfq|rfi|rfx|tender|solicitation|bids?|bidding|grants?|cooperative agreements?|procurement|sam\.gov|notice of funding|funding opportunity|nofo)\b/i;

export function isCompetitiveAward(o: { title: string; source: string | null; buyingSignal: string | null; offerScope?: string | null }): boolean {
  return COMPETITIVE_AWARD.test([o.title, o.source, o.buyingSignal].filter(Boolean).join(' '));
}

export interface GoalModel {
  definition: ScenarioModelDefinition;
  included: ModelledOpportunity[];
  excluded: { opportunityId: string; title: string; reason: string }[];
  /**
   * Every opening that could be read at all, modelled or not. The engine fits
   * a few into one simulation; the gate still judges every one of these on
   * its own evidence, so the engine's limit never limits what Brain considers.
   */
  considered: ModelledOpportunity[];
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

/**
 * An unknown, inferred from what the project already holds — or the blind
 * fallback range when nothing bears on it. `scale` turns a share of the price
 * into money at this opening's price.
 */
function inferOr(knowledge: CashKnowledge | null, quantity: CashQuantity, opportunity: CashOpportunity, now: Date, fallback: ModelInput, scale = 1, what = ''): ModelInput {
  if (!knowledge) return fallback;
  let est: Estimate | null = null;
  try {
    est = inferCashQuantity(knowledge, quantity, opportunity, now);
  } catch {
    est = null;
  }
  if (!est) return fallback;
  const scaled: Estimate = scale === 1 ? est : { ...est, p05: est.p05 * scale, p10: est.p10 * scale, p50: est.p50 * scale, p90: est.p90 * scale, p95: est.p95 * scale, samples: est.samples.map((x) => x * scale) };
  const exported = toScenarioInput(scaled);
  return {
    value: null,
    low: scaled.p05,
    high: scaled.p95,
    provenance: exported.provenance,
    source: exported.sources[0] ?? null,
    note: `inferred${what}: ${exported.note}`,
    distribution: exported.spec,
    inferred: { tier: est.tier, justified: exported.provenance === 'EVIDENCE', p10: scaled.p10, p50: scaled.p50, p90: scaled.p90, observations: est.used.length },
  };
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
  knowledge: CashKnowledge | null = null,
  now: Date = new Date(),
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
  // Research answers "how much goes out before any comes back" as requiredCapital.
  const capitalFact = fact('requiredCapital');
  const capitalFigures = capitalFact ? readMoneyFigures(capitalFact.value, currency).filter((one) => !one.perUnit) : [];
  const capital =
    opportunity.peakFundingCents !== null
      ? known(opportunity.peakFundingCents / 100, kindToProvenance(exposure).provenance === 'UNKNOWN' ? 'ASSUMPTION' : kindToProvenance(exposure).provenance, kindToProvenance(exposure).source ?? ref, 'money tied up before it pays')
      : capitalFigures.length > 0
        ? known(Math.max(...capitalFigures.map((one) => one.cents)) / 100, kindToProvenance(capitalFact).provenance, kindToProvenance(capitalFact).source, 'the most that goes out before any comes back')
        : inferOr(knowledge, 'capitalShare', opportunity, now, unknown(0, top, 'nobody has established the money tied up; swept from nothing to the whole price'), top, ' as a share of the top price');

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
      : inferOr(knowledge, 'daysToCash', opportunity, now, unknown(3, 60, 'nobody has established when the money would settle; swept from 3 to 60 days'));

  const costFact = fact('directCosts');
  const costFigures = costFact ? readMoneyFigures(costFact.value, currency).filter((one) => !one.perUnit) : [];
  const directCost =
    costFigures.length > 0
      ? known(Math.max(...costFigures.map((one) => one.cents)) / 100, kindToProvenance(costFact).provenance, kindToProvenance(costFact).source, 'the highest published direct cost')
      : inferOr(knowledge, 'costShare', opportunity, now, unknown(0, Math.max(1, top * 0.6), 'nobody has established the direct cost; swept from nothing to 60% of the price'), top, ' as a share of the top price');

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
    close = inferOr(knowledge, 'close', opportunity, now, unknown(0.02, 0.5, 'no buyer has been asked yet; swept from 2% to 50% of buyers agreeing'));
  }

  const fulfilmentFact = fact('fulfillment');
  const fulfilledBy =
    fulfilmentFact && fulfilmentFact.kind !== 'RECOMMENDATION' && opportunity.fulfillmentOwner
      ? { value: opportunity.fulfillmentOwner, ...kindToProvenance(fulfilmentFact) }
      : null;

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
    agreedDeals: agreements.length,
    fulfilledBy,
    competitiveAward: agreements.length === 0 && isCompetitiveAward(opportunity),
  };
}

/**
 * The most this opening could put toward the goal inside the window, from
 * what is known: its agreed money, or its top price times the deals a
 * repeatable play could take, or one deal. Zero when it is known to settle too
 * late. A ranking key only — it is never shown as a forecast.
 */
/** A price buyers are shown to pay — a source or this Brain's own record — rather than a guess. */
export function priceSupported(one: Pick<ModelledOpportunity, 'price'>): boolean {
  return !one.price.inferred && (one.price.provenance === 'EVIDENCE' || one.price.provenance === 'HISTORICAL');
}

/** How many of an opening's money facts rest on a source or a measurement rather than a guess. */
export function evidenceCount(one: ModelledOpportunity): number {
  return [one.price, one.close, one.daysToCash, one.directCost, one.capital, one.hours].filter(
    (input) => !input.inferred && (input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL'),
  ).length;
}

export function bestCaseReach(one: ModelledOpportunity, remaining: number, daysLeft: number): number {
  const late = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && one.daysToCash.value > daysLeft;
  if (late) return 0;
  // An award nobody has shown pays inside the window does not count as reach:
  // first it must be won, then delivered, then paid on the buyer's terms.
  if (one.competitiveAward && !(one.daysToCash.provenance === 'EVIDENCE' || one.daysToCash.provenance === 'HISTORICAL')) return 0;
  const price = one.price.high ?? one.price.value ?? 0;
  const deals = one.repeatable ? Math.min(MAX_BUYERS_OFFERED, Math.ceil(remaining / Math.max(1, price))) : one.agreedValue > 0 ? 0 : 1;
  return Math.min(remaining, one.agreedValue + deals * price);
}

function variable(key: string, label: string, unit: string, input: ModelInput): ScenarioVariable {
  const spec: VariableSpec =
    input.value !== null
      ? { kind: 'FIXED' as const, value: input.value }
      : input.distribution
        ? input.distribution
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
  const candidates: ModelledOpportunity[] = [];
  const refuse = (refusal: string): GoalModel => ({
    definition: { title: goal.title, currency: target.currency, horizon: 'until the goal is due', variables: [], lines: [], strategies: [] },
    included: [],
    excluded,
    considered: candidates,
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
  // What the project already established about other openings, for inference.
  let knowledge: CashKnowledge | null = null;
  try {
    knowledge = await loadCashKnowledge(target.projectId);
  } catch {
    knowledge = null;
  }
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
    const modelled = await modelOpportunity(opportunity, 0, tier, target.currency, lessons, knowledge, input.now ?? new Date());
    if ('reason' in modelled) excluded.push({ opportunityId: opportunity.id, title: opportunity.title, reason: modelled.reason });
    else candidates.push(modelled);
  }
  /*
   * Which openings take the engine's few slots is decided by what each could
   * put toward *this* goal, not by how far along it is. Production,
   * 2026-10-28: the slots went to the four "closest to a decision" — a $2.50
   * auction among them — and the plan could reach $415 of $10,000 however it
   * combined them. Money already agreed and work already under way come first,
   * then the largest reach inside the window, then the evidence tier.
   */
  const remainingMajor = target.remainingCents / 100;
  candidates.sort(
    (a, b) =>
      (IN_FLIGHT.has(a.opportunity.state) || a.agreed ? 0 : 1) - (IN_FLIGHT.has(b.opportunity.state) || b.agreed ? 0 : 1) ||
      Number(a.competitiveAward) - Number(b.competitiveAward) ||
      // Reach at a price buyers are shown to pay comes before reach at a guess.
      (priceSupported(b) ? bestCaseReach(b, remainingMajor, target.daysLeft!) : 0) -
        (priceSupported(a) ? bestCaseReach(a, remainingMajor, target.daysLeft!) : 0) ||
      evidenceCount(b) - evidenceCount(a) ||
      bestCaseReach(b, remainingMajor, target.daysLeft!) - bestCaseReach(a, remainingMajor, target.daysLeft!) ||
      (TIER_ORDER[a.tier] ?? 3) - (TIER_ORDER[b.tier] ?? 3),
  );
  for (const one of candidates) {
    if (included.length >= MAX_MODEL_OPPORTUNITIES) {
      excluded.push({ opportunityId: one.opportunity.id, title: one.opportunity.title, reason: `the engine fits ${MAX_MODEL_OPPORTUNITIES} openings in one model and ${included.length} could reach more of this goal` });
      continue;
    }
    included.push({ ...one, index: included.length + 1 });
  }
  if (included.length === 0) {
    return refuse(
      live.length === 0
        ? 'There is no live opportunity in this project to build a plan from.'
        : 'No live opportunity is far enough along to model: each one is evidence only or has no price anywhere.',
    );
  }

  const variables: ScenarioVariable[] = [
    variable('remaining', 'Still needed to reach the target', target.currency, known(target.remainingCents / 100, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}`, note: 'target less what the ledger shows' }, 'target less the ledger')),
    variable('days_left', 'Days until the goal is due', 'days', known(target.daysLeft, 'EVIDENCE', { kind: 'OTHER', ref: `workstream:${goal.id}` }, 'the goal row')),
    variable(
      'hours_available',
      'Working hours available before the deadline',
      'hours',
      target.hoursCeiling !== null
        ? known(target.hoursCeiling, 'EVIDENCE', { kind: 'PERSON', ref: `workstream:${goal.id}` }, 'the hours a person set')
        : unknown(20, 160, 'nobody has said how many hours are available; swept from 20 to 160'),
    ),
  ];
  /*
   * Capital is the goal's own, never a global default. When the owner has said
   * how much may be committed, that is the ceiling. When nobody has said, there
   * is no ceiling to break — the model reports how much each strategy ties up,
   * and the gate asks the owner, rather than reading the ledger's deployable
   * cash (often zero) as a decision nobody made. Permission to spend is still
   * the commercial authority's either way.
   */
  if (target.capitalCeilingCents !== null) {
    variables.push(
      variable('capital_ceiling', 'Money the owner said this goal may commit', target.currency, known(target.capitalCeilingCents / 100, 'EVIDENCE', { kind: 'PERSON', ref: `workstream:${goal.id}`, note: 'the ceiling a person set' }, 'the ceiling a person set')),
    );
  }
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
    // Money is tied up per deal taken, not per buyer asked.
    exposure.push(`(${o}_won + ${one.agreedDeals}) * ${o}_capital`);
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
    { key: 'hours', label: 'Within the hours available', expr: `${labour.join(' + ')} - hours_available`, op: '<=', value: 0 },
  ];
  // A ceiling is compared against a variable, so it is written as a difference.
  if (target.capitalCeilingCents !== null) {
    constraints.unshift({ key: 'capital', label: 'Within the money the owner said this goal may commit', expr: `${exposure.join(' + ')} - capital_ceiling`, op: '<=', value: 0 });
  }

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
  const add = (spec: StrategySpec) => {
    // Two strategies that ask the same thing of every opening are one strategy.
    const same = strategies.some((one) => canonical(one.set) === canonical(spec.set));
    if (!same && strategies.length < SCENARIO_LIMITS.maxStrategies) strategies.push(spec);
  };
  const canonical = (set: StrategySpec['set']) => JSON.stringify(Object.entries(set).sort(([a], [b]) => a.localeCompare(b)));
  for (const one of included) {
    add({
      key: `only_o${one.index}`,
      label: `Only: ${one.opportunity.title.slice(0, 60)}`,
      set: { ...none(), [`o${one.index}_n`]: dealsFor(one) },
    });
  }
  /*
   * Combinations are built from the openings themselves, never from a split.
   * Each walks the openings in one order and asks each for only what is still
   * needed after the ones before it: money already agreed first, then a
   * one-off deal for its price, then a repeatable play for whatever remains.
   * So one opening may carry the whole goal, or several may share it in
   * whatever amounts they actually offer — and nothing is divided equally or
   * by template. The engine then evaluates the combination as one plan, with
   * the shared hours and money summed across it.
   */
  const combine = (key: string, label: string, order: ModelledOpportunity[]) => {
    let gap = target.remainingCents / 100;
    const set: StrategySpec['set'] = none();
    const used: ModelledOpportunity[] = [];
    for (const one of order) {
      if (gap <= 0) break;
      const price = one.price.value ?? one.price.low ?? 0;
      if (one.agreedValue > 0) {
        gap -= one.agreedValue;
      } else if (!one.repeatable) {
        if (price <= 0) continue;
        set[`o${one.index}_n`] = 1;
        gap -= price;
      } else {
        set[`o${one.index}_n`] = Math.min(MAX_BUYERS_OFFERED, Math.ceil(gap / Math.max(1, price)) * OUTREACH_MULTIPLE);
        gap = 0;
      }
      used.push(one);
    }
    if (used.length > 1) add({ key, label: `${label}: ${used.map((one) => one.opportunity.title.slice(0, 30)).join(' + ')}`.slice(0, 160), set });
  };
  if (included.length > 1) {
    const reach = (one: ModelledOpportunity) => bestCaseReach(one, target.remainingCents / 100, target.daysLeft!);
    combine('combine_reach', 'Combined, largest reach first', [...included].sort((a, b) => Number(b.agreed) - Number(a.agreed) || reach(b) - reach(a)));
    const days = (one: ModelledOpportunity) => (one.daysToCash.value !== null ? one.daysToCash.value : Number.POSITIVE_INFINITY);
    combine('combine_fast', 'Combined, fastest money first', [...included].sort((a, b) => Number(b.agreed) - Number(a.agreed) || days(a) - days(b) || reach(b) - reach(a)));
    const evidence = (one: ModelledOpportunity) =>
      [one.close, one.price, one.daysToCash, one.directCost, one.capital].filter((input) => input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL').length;
    combine('combine_evidence', 'Combined, best-evidenced first', [...included].sort((a, b) => Number(b.agreed) - Number(a.agreed) || evidence(b) - evidence(a) || reach(b) - reach(a)));
    add({
      key: 'basket_all',
      label: 'Every modelled opening at full reach',
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
      strategies,
    },
    included,
    excluded,
    considered: candidates,
    refusal: null,
  };
}

/** The buyers a single-opening plan asks, for a judgement made outside the engine. */
export function dealsForGoal(one: ModelledOpportunity, remainingMajor: number): number {
  const gap = Math.max(0, remainingMajor - one.agreedValue);
  if (gap === 0) return 0;
  if (!one.repeatable) return one.agreedValue > 0 ? 0 : 1;
  const price = one.price.value ?? one.price.low ?? 1;
  return Math.min(MAX_BUYERS_OFFERED, Math.ceil(gap / Math.max(1, price)) * OUTREACH_MULTIPLE);
}
