/**
 * Whether Brain may recommend a plan for a goal — an evidence gate, not an
 * adjective.
 *
 * For each strategy the scenario adapter composed, the gate walks the causal
 * chain a cash plan rests on and asks, from rows, whether each link is
 * established:
 *
 *   reachable buyer → current demand → offer and price → conversion →
 *   fulfilment → economics within the limits → cash settled before the deadline
 *
 * A link counts only when a row establishes it — a gated claim, a recorded
 * agreement, this Brain's own measured outcomes, a capability Brain has proved.
 * A model's prose, a long research report or a confident sentence counts for
 * nothing, so a weak plan cannot pass by being described better.
 *
 * Three verdicts:
 *
 *   * `NOT_VIABLE` — a hard limit fails on a known number (more money tied up
 *     than the ceiling, cash that settles after the deadline, a price under its
 *     cost), or the strategy cannot reach the target even in the best tested
 *     case.
 *   * `NEEDS_EVIDENCE` — a link is missing. The verdict names the first missing
 *     link in chain order and the cheapest test that would settle it, and who
 *     can run that test today. A sweep that looks good is not evidence.
 *   * `RECOMMENDABLE` — every link is established *and* a conservative reading
 *     of the established numbers (lowest measured agreement rate, lowest
 *     price, highest cost, slowest settlement) still reaches the target inside
 *     the limits.
 *
 * A numeric chance of success is reported only from this Brain's own record of
 * how earlier recommended goal plans turned out, with its sample and a Wilson
 * interval, and only once that record is large enough. Otherwise there is no
 * number — never one composed from assumptions.
 */
import { getDb } from '../../db/database.ts';
import { newId } from '../../repos/util.ts';
import { getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent } from '../../repos/register.ts';
import { readCapabilities } from '../cash/capabilities.ts';
import { checkCommercialAuthority } from '../cash/authority.ts';
import { bestCaseReach, composeGoalModel, dealsForGoal, OUTREACH_MULTIPLE, priceSupported, volumeEstablished, wilson, type ModelledOpportunity } from '../cash/goalScenario.ts';
import { readTarget, type TargetReading } from './target.ts';
import { executionFrame, MAX_LIVE_GOAL_ROUNDS, openConstructedRound, openGoalDiscovery } from '../cash/discovery.ts';
import { constructArrangements } from '../cash/construct.ts';
import { goalExclusions } from '../cash/exclusions.ts';
import { listRounds } from '../../repos/cashDiscovery.ts';
import { cashSpareSurfaces } from '../cash/researchRoom.ts';
import { researchGoalPaths } from './pathResearch.ts';
import { compileModel, canonicalJson, sha256 } from '../scenario/model.ts';
import { getScenarioModel } from '../../repos/scenario.ts';
import { runModel, saveModel } from '../scenario/service.ts';
import { runIsolated, ScenarioBusyError } from '../scenario/isolate.ts';
import { ScenarioRunError } from '../scenario/engine.ts';
import type { ScenarioResult } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';
import { decideResearch, type ResearchDecision } from '../quant/deadline.ts';
import type { EvidenceTier } from '../../domain/quant.ts';

export const PLAN_VERDICTS = ['RECOMMENDABLE', 'NEEDS_EVIDENCE', 'NOT_VIABLE'] as const;
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

/** The links of a cash plan's causal chain, in the order they are checked. */
export const CHAIN_LINKS = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'MARKET_VOLUME', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'] as const;
export type ChainLink = (typeof CHAIN_LINKS)[number];

export const CHAIN_LABEL: Record<ChainLink, string> = {
  REACHABLE_BUYER: 'a buyer we can actually reach',
  CURRENT_DEMAND: 'a dated sign they need it now',
  OFFER_AND_PRICE: 'an offer and a price',
  CONVERSION: 'buyers who have actually agreed to it',
  MARKET_VOLUME: 'enough buyers, buying often enough, for the deals the plan needs',
  FULFILMENT: 'proof it can be delivered — by Brain or by whoever is named to do it',
  ECONOMICS: 'known costs and money tied up, inside the limits',
  SETTLES_IN_TIME: 'cash that settles before the deadline',
};

/**
 * The policy a recommendation is held to. Configurable by code review only —
 * a plan cannot lower the bar it is judged against.
 */
export const RECOMMENDATION_POLICY = {
  /** A buying signal older than this is not "now". */
  demandFreshDays: 30,
  /** Earlier recommended goal plans needed before Brain quotes a success rate. */
  minPlanOutcomes: 10,
  /** The lower bound of that rate a quoted chance must clear to be called likely. */
  likelyLowerBound: 0.5,
} as const;

export interface LinkCheck {
  link: ChainLink;
  ok: boolean;
  /** The row or rule that establishes it, or what is missing. */
  basis: string;
}

export interface NextTest {
  link: ChainLink;
  /** What would settle it, in plain words. */
  test: string;
  /** Who can do it today. */
  by: 'BRAIN' | 'PERSON';
  /** When a person is needed, exactly what for. */
  blocker: string | null;
}

export interface StrategyReading {
  key: string;
  label: string;
  verdict: PlanVerdict;
  opportunityIds: string[];
  links: LinkCheck[];
  constraintsFailed: string[];
  /** Coverage of tested conditions, never a probability unless the run says so. */
  sweep: { goalMetShare: number | null; settledP50: number | null; settledP90: number | null; infeasibleShare: number | null; probabilistic: boolean };
  /** The conservative settled figure, when every input it needs is established. */
  conservativeSettled: number | null;
  nextTest: NextTest | null;
}

export interface PlanReading {
  goalId: string;
  verdict: PlanVerdict;
  /** Why, in one sentence. */
  summary: string;
  chosen: string | null;
  strategies: StrategyReading[];
  nextTest: NextTest | null;
  /** The scenario run this rests on, when one ran. */
  scenarioModelId: string | null;
  scenarioRunId: string | null;
  basisNote: string | null;
  /** What the model left out, and why. */
  excluded: { opportunityId: string; title: string; reason: string }[];
  /** Only from this Brain's own record of earlier recommended plans. */
  measuredChance: { estimate: number; lowerBound: number; upperBound: number; sampleSize: number; cohort: string } | null;
  target: TargetReading;
  refusal: string | null;
  /**
   * The most any modelled strategy could put toward the goal if every buyer it
   * asks agreed, in major units — or null when nothing could be modelled.
   */
  bestReach: number | null;
  /**
   * Every opening Brain could read, judged on its own evidence whether or not
   * it fitted in the simulation: which links are missing and how much it could
   * bring at a price buyers are shown to pay.
   */
  considered: ConsideredOpening[];
  /**
   * The openings Brain holds cannot reach the goal however they are combined,
   * so evaluating them again teaches nothing: more must be found.
   */
  needsMoreOpenings: boolean;
  /**
   * Every unknown the model reconstructed from comparable or component
   * evidence instead of sweeping blind (§79), with how far it climbed.
   */
  inferred: InferredInput[];
  /**
   * Which unknowns could change the choice of strategy, measured on the run's
   * own worlds, and what to do about each given the calendar (§79). Empty when
   * no run finished.
   */
  researchPriority: ResearchPriority[];
  /**
   * What the openings Brain holds say about the goal — never about the world.
   * `POOL_INSUFFICIENT` means the openings held cannot reach it however they
   * are combined; it is not a finding that nothing could, and the search for
   * new openings and new arrangements continues (§81).
   */
  pool: { conclusion: 'NO_POOL' | 'POOL_INSUFFICIENT' | 'POOL_COULD_REACH'; sentence: string };
}

export interface InferredInput {
  opportunityId: string;
  title: string;
  field: 'daysToCash' | 'directCosts' | 'requiredCapital' | 'close';
  tier: EvidenceTier;
  /** True when the estimate may be read as a distribution; false means bounds only. */
  justified: boolean;
  p10: number;
  p50: number;
  p90: number;
  observations: number;
}

export interface ResearchPriority {
  /** The model variable, e.g. `o2_days`. */
  variable: string;
  opportunityId: string | null;
  /** The card field research would settle, or null for something learned only by doing. */
  field: string | null;
  /** Gain in the goal-met share from knowing it first; over a sweep, over tested conditions. */
  value: number;
  changesDecision: boolean;
  decision: ResearchDecision;
  reason: string;
}

/** What the held openings say about the goal, kept apart from what exists. */
export function poolConclusion(bestReach: number, target: TargetReading, read: number): PlanReading['pool'] {
  const remaining = target.remainingCents / 100;
  if (bestReach >= remaining) {
    return { conclusion: 'POOL_COULD_REACH', sentence: `The ${read} openings held could reach the ${Math.round(remaining)} ${target.currency} still needed at prices buyers are shown to pay, if every link is established.` };
  }
  return {
    conclusion: 'POOL_INSUFFICIENT',
    sentence:
      `The ${read} openings held reach at most ${Math.round(bestReach)} of the ${Math.round(remaining)} ${target.currency} still needed at prices buyers are shown to pay. ` +
      'That limits this pool only: Brain keeps searching for new openings and constructing new arrangements rather than concluding nothing viable exists.',
  };
}

/** A path-research question takes about this long to come back, measured from the fleet's turnaround. */
export const RESEARCH_TURNAROUND_DAYS = 2;
const VARIABLE_FIELD: Record<string, { field: string | null; learnable: boolean }> = {
  days: { field: 'timeToFirstCash', learnable: false },
  cost: { field: 'directCosts', learnable: false },
  capital: { field: 'requiredCapital', learnable: false },
  price: { field: 'revenueRange', learnable: false },
  close: { field: null, learnable: true },
  volume: { field: 'buyerVolume', learnable: false },
  hours: { field: null, learnable: true },
};

export interface ConsideredOpening {
  opportunityId: string;
  title: string;
  modelled: boolean;
  missing: ChainLink[];
  /** What it could bring toward the goal at a supported price, in major units. */
  supportedReach: number;
  /**
   * What it could bring at whatever price the card holds, supported or not —
   * the most it could be worth if research confirms it. Null when the card has
   * no price at all, so nothing yet says how big it could be.
   */
  potentialReach: number | null;
  competitiveAward: boolean;
  /** Whether research established how many deals the market can take (§81). */
  volumeEstablished: boolean;
}

const DAY = 86_400_000;

function linkChecks(one: ModelledOpportunity, deals: number, target: TargetReading, capabilities: Map<string, string>, now: Date): LinkCheck[] {
  const o = one.opportunity;
  const fresh = o.signalObservedAt && now.getTime() - Date.parse(o.signalObservedAt) <= RECOMMENDATION_POLICY.demandFreshDays * DAY;
  const caps = o.requiredCapabilities;
  const allPresent = caps.length > 0 && caps.every((id) => capabilities.get(id) === 'PRESENT');
  const established = (input: { provenance: string }) => input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL';
  return [
    { link: 'REACHABLE_BUYER', ok: !!o.reachableChannel && !!o.payer, basis: o.reachableChannel ? `reach: ${o.reachableChannel.slice(0, 80)}` : 'nobody has established how to reach the buyer' },
    { link: 'CURRENT_DEMAND', ok: !!(o.buyingSignal && fresh), basis: o.buyingSignal ? (fresh ? `signal dated ${o.signalObservedAt!.slice(0, 10)}` : 'the buying signal is undated or older than the policy allows') : 'no buying signal recorded' },
    {
      link: 'OFFER_AND_PRICE',
      // A price counts only when buyers are shown to pay it: a source, this
      // Brain's own sales, or a buyer's agreement. Brain's proposal, a person's
      // hope or somebody else's asking price is a guess about revenue.
      ok: !!o.offerScope && (one.agreed || (one.price.value !== null && priceSupported(one))),
      basis: one.agreed
        ? `a buyer agreed to ${one.agreedValue} ${target.currency}`
        : one.price.value === null
          ? 'no single price on the card'
          : priceSupported(one)
            ? `price ${one.price.value} ${target.currency} (${one.price.provenance})`
            : `price ${one.price.value} ${target.currency} is a guess (${one.price.provenance}), not something buyers are shown to pay`,
    },
    {
      link: 'CONVERSION',
      ok: deals === 0 ? one.agreed : one.close.provenance === 'HISTORICAL',
      basis:
        deals === 0
          ? one.agreed ? `buyers have agreed to ${one.agreedValue} ${target.currency}` : 'nothing agreed and no buyers offered'
          : one.close.provenance === 'HISTORICAL'
            ? one.close.note
            : `${deals} new buyer(s) would be offered and nobody knows how many would agree${one.agreed ? ` (one agreement of ${one.agreedValue} is recorded)` : ''}`,
    },
    volumeCheck(one, deals),
    fulfilmentCheck(one, caps, allPresent, capabilities),
    {
      link: 'ECONOMICS',
      ok: one.directCost.value !== null && one.capital.value !== null && established(one.directCost) && one.capital.value !== null,
      basis: one.directCost.value !== null && one.capital.value !== null ? `cost ${one.directCost.value}, tied up ${one.capital.value}` : 'costs or money tied up are not established',
    },
    {
      link: 'SETTLES_IN_TIME',
      ok: one.daysToCash.value !== null && target.daysLeft !== null && one.daysToCash.value <= target.daysLeft && established(one.daysToCash),
      basis:
        one.competitiveAward && !established(one.daysToCash)
          ? 'money comes only after winning an award, then doing the work, then the buyer paying on its terms — nobody has established when that would be'
          : one.daysToCash.value !== null
            ? `${one.daysToCash.value} days to usable cash against ${target.daysLeft} left`
            : 'nobody has established when the money would settle',
    },
  ];
}

/**
 * Whether the work can be delivered, and by whom.
 *
 * Brain proving its own deliverable is one way; a source or a person naming
 * who fulfils it — a partner, a subcontractor, a supplier, the owner's own
 * people — is another, and it is the only way a brokered, freight or resale
 * opening could ever pass. Brain's own proposal of a fulfiller does not count:
 * a name nobody has confirmed is not a way to deliver.
 */
function fulfilmentCheck(one: ModelledOpportunity, caps: string[], allPresent: boolean, capabilities: Map<string, string>): LinkCheck {
  const hours = one.hours.value !== null;
  if (allPresent) {
    return { link: 'FULFILMENT', ok: hours, basis: hours ? `Brain has proved: ${caps.join(', ')}` : 'the work is proved but the hours are unknown' };
  }
  const missing = caps.filter((id) => capabilities.get(id) !== 'PRESENT');
  if (one.fulfilledBy && missing.length === 0) {
    return {
      link: 'FULFILMENT',
      ok: hours,
      basis: hours ? `fulfilled by ${one.fulfilledBy.value.slice(0, 80)} (${one.fulfilledBy.provenance === 'EVIDENCE' ? 'a source' : 'a person'} says so)` : `fulfilled by ${one.fulfilledBy.value.slice(0, 60)}, but the hours are unknown`,
    };
  }
  if (missing.length > 0) return { link: 'FULFILMENT', ok: false, basis: `not proved: ${missing.join(', ')}` };
  return { link: 'FULFILMENT', ok: false, basis: 'nobody has established who would do the work' };
}

/**
 * Whether the market can take the deals this strategy needs. A one-off needs
 * its one buyer; a repeatable play needs research to have established that
 * enough buyers exist, buying often enough, inside the window — never the
 * number of buyers the strategy would like to ask.
 */
function volumeCheck(one: ModelledOpportunity, deals: number): LinkCheck {
  const needed = one.repeatable ? Math.ceil(deals / OUTREACH_MULTIPLE) : Math.min(deals, 1);
  if (!one.repeatable || needed === 0) return { link: 'MARKET_VOLUME', ok: true, basis: one.repeatable ? 'no new deals needed' : 'a one-off needs its one buyer' };
  if (!volumeEstablished(one)) return { link: 'MARKET_VOLUME', ok: false, basis: `${needed} deal(s) needed and nobody has established how many buyers exist or how often they buy` };
  const available = one.volume.value ?? 0;
  return {
    link: 'MARKET_VOLUME',
    ok: available >= needed,
    basis: available >= needed ? `${needed} deal(s) needed, ${available} available in the window (${one.volume.note})` : `${needed} deal(s) needed but only ${available} in the window (${one.volume.note})`,
  };
}

/** The deals a strategy actually needs taken, as opposed to the buyers it asks. */
function dealsTaken(one: ModelledOpportunity, deals: number): number {
  return one.agreedDeals + (one.repeatable ? Math.ceil(deals / OUTREACH_MULTIPLE) : deals);
}

async function nextTestFor(link: ChainLink, one: ModelledOpportunity, projectId: string): Promise<NextTest> {
  const title = one.opportunity.title.slice(0, 80);
  switch (link) {
    case 'CONVERSION': {
      const contact = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER' });
      const message = (await readCapabilities(['SEND_A_MESSAGE']))[0];
      const test = `A bounded offer test for "${title}": send the offer to a few reachable buyers and count who agrees. Fewer agreements than the plan needs downgrades it.`;
      if (!contact.ok) return { link, test, by: 'PERSON', blocker: `Brain has no standing permission to contact buyers here (${contact.reason}). Grant CONTACT_BUYER under the commercial authority to let it run this test.` };
      if (message?.state !== 'PRESENT') return { link, test, by: 'PERSON', blocker: 'No message provider is connected, so Brain cannot send the offer. Connect one.' };
      return { link, test, by: 'BRAIN', blocker: null };
    }
    case 'MARKET_VOLUME':
      return { link, test: `Establish how many buyers for "${title}" exist and can be reached, and how often each buys, from a published directory, register or list.`, by: 'BRAIN', blocker: null };
    case 'FULFILMENT':
      return one.opportunity.requiredCapabilities.length > 0
        ? { link, test: `Prove Brain can produce what "${title}" needs, on a real sample, and record the hours.`, by: 'BRAIN', blocker: null }
        : { link, test: `Establish who would do the work for "${title}" — Brain, a partner, a subcontractor or a supplier — from a published source or the owner, and the hours it takes.`, by: 'BRAIN', blocker: null };
    case 'REACHABLE_BUYER':
      return { link, test: `Find a published, permitted way to reach the buyer for "${title}".`, by: 'BRAIN', blocker: null };
    case 'CURRENT_DEMAND':
      return { link, test: `Find a dated sign from the last ${RECOMMENDATION_POLICY.demandFreshDays} days that the buyer for "${title}" needs it now.`, by: 'BRAIN', blocker: null };
    case 'OFFER_AND_PRICE':
      return { link, test: `Establish the offer and one price for "${title}" from what buyers pay today.`, by: 'BRAIN', blocker: null };
    case 'ECONOMICS':
      return { link, test: `Establish the direct cost and money tied up for "${title}" from published figures.`, by: 'BRAIN', blocker: null };
    case 'SETTLES_IN_TIME':
      return { link, test: `Establish when money for "${title}" would actually settle (payment terms and payout timing).`, by: 'BRAIN', blocker: null };
  }
}

/** The conservative settled figure for a strategy, or null when an input it needs is unknown. */
function conservative(members: { one: ModelledOpportunity; deals: number }[], target: TargetReading): { settled: number | null; exposure: number | null; labour: number | null } {
  let settled = 0;
  let exposure = 0;
  let labour = 0;
  for (const { one, deals } of members) {
    const close = deals === 0 ? 0 : one.close.provenance === 'HISTORICAL' ? one.close.low : null;
    const price = one.price.value ?? one.price.low;
    const days = one.daysToCash.value;
    const cost = one.directCost.value;
    const capital = one.capital.value;
    const hours = one.hours.value;
    const volume = volumeEstablished(one) ? one.volume.value : null;
    if (volume === null ||
      close === null || price === null || days === null || cost === null || capital === null || hours === null) return { settled: null, exposure: null, labour: null };
    const won = Math.min(deals * close, volume);
    settled += days <= (target.daysLeft ?? 0) ? one.agreedValue + won * price : 0;
    exposure += (won + one.agreedDeals) * capital;
    labour += won * hours;
  }
  return { settled, exposure, labour };
}

function sweepOf(result: ScenarioResult | null, key: string): StrategyReading['sweep'] {
  const s = result?.strategies.find((one) => one.key === key);
  if (!result || !s) return { goalMetShare: null, settledP50: null, settledP90: null, infeasibleShare: null, probabilistic: false };
  return {
    goalMetShare: s.metrics['goal_met']?.mean ?? null,
    settledP50: s.metrics['settled']?.p50 ?? null,
    settledP90: s.metrics['settled']?.p90 ?? null,
    infeasibleShare: s.evaluated ? s.infeasible / s.evaluated : null,
    probabilistic: result.probabilistic,
  };
}

/** This Brain's record of earlier recommended goal plans: achieved in time, out of all that ended. */
export async function measuredPlanChance(): Promise<PlanReading['measuredChance']> {
  const rows = await getDb().all<{ kind: string }>(
    `SELECT o.kind FROM goal_outcomes o JOIN goal_plan_readings r ON r.id = o.reading_id WHERE r.verdict = 'RECOMMENDABLE'`,
  );
  if (rows.length < RECOMMENDATION_POLICY.minPlanOutcomes) return null;
  const achieved = rows.filter((one) => one.kind === 'ACHIEVED').length;
  const bounds = wilson(achieved, rows.length);
  return { estimate: achieved / rows.length, lowerBound: bounds.low, upperBound: bounds.high, sampleSize: rows.length, cohort: 'goal plans this Brain recommended, and how they ended' };
}

/**
 * Read a goal's plan: compose the model from rows, run the existing engine,
 * and apply the gate. Writes nothing unless `persist` is set, and then only the
 * scenario model and run (through the scenario service) and an append-only
 * reading when the conclusion changed.
 */
export async function readGoalPlan(input: { goalId: string; now?: Date; persist?: boolean; evaluations?: number }): Promise<PlanReading | null> {
  const now = input.now ?? new Date();
  const goal = await getWorkstream(input.goalId);
  if (!goal) return null;
  const target = await readTarget(goal, now);
  if (!target) return null;
  const model = await composeGoalModel({ goal, target, now });
  const measuredChance = await measuredPlanChance();
  const base = { goalId: goal.id, target, excluded: model.excluded, measuredChance };
  if (model.refusal) {
    const reading: PlanReading = {
      ...base,
      verdict: target.achieved ? 'RECOMMENDABLE' : 'NEEDS_EVIDENCE',
      summary: model.refusal,
      chosen: null,
      strategies: [],
      nextTest: target.achieved
        ? null
        : { link: 'OFFER_AND_PRICE', test: 'Qualify at least one opening: establish who pays, an offer and a price, so there is a plan to judge.', by: 'BRAIN', blocker: null },
      scenarioModelId: null,
      scenarioRunId: null,
      basisNote: null,
      refusal: model.refusal,
      bestReach: null,
      considered: [],
      needsMoreOpenings: !target.achieved && target.daysLeft !== null && target.daysLeft > 0,
      inferred: inferredInputs(model.considered),
      researchPriority: [],
      pool: { conclusion: 'NO_POOL', sentence: `No opening held is far enough along to model (${model.considered.length} read). That is a statement about what Brain holds, not about what exists, so it keeps searching and constructing.` },
    };
    if (input.persist) await persistReading(goal, reading, null);
    return reading;
  }

  // Run the existing engine. Stored and versioned when persisting.
  const options = { seed: parseInt(sha256(goal.id).slice(0, 8), 16) >>> 0, evaluations: input.evaluations ?? 20_000, informationValue: { metric: 'goal_met' } };
  let result: ScenarioResult | null = null;
  let scenarioModelId: string | null = null;
  let scenarioRunId: string | null = null;
  const owner = goal.ownerUserId ?? goal.createdByUserId;
  if (input.persist && owner) {
    const definitionHash = compileModel(model.definition).hash;
    const last = await latestReading(goal.id);
    const lastModel = last?.scenario_model_id ? await getScenarioModel(last.scenario_model_id) : null;
    const saved = lastModel && lastModel.definitionHash === definitionHash ? lastModel : await saveModel({ projectId: target.projectId, definition: model.definition, createdById: owner });
    const run = await runModel({ model: saved, options, label: `goal ${goal.id}`, createdById: owner });
    scenarioModelId = saved.id;
    scenarioRunId = run.id;
    result = run.result ?? null;
  } else {
    try {
      result = await runIsolated(model.definition, options);
    } catch (error) {
      // A simulation that does not finish in its budget is a missing sweep,
      // not a missing plan: the gate below judges every opening on its own
      // evidence without it, exactly as the persisted path already does when
      // its run is recorded FAILED.
      if (!(error instanceof ScenarioRunError)) throw error;
      result = null;
    }
  }

  let bestReach = 0;
  const capabilities = new Map((await readCapabilities([...new Set(model.considered.flatMap((one) => one.opportunity.requiredCapabilities)), 'SEND_A_MESSAGE'])).map((one) => [one.id, one.state]));
  const modelledIds = new Set(model.included.map((one) => one.opportunity.id));
  const considered: ConsideredOpening[] = model.considered.map((one) => ({
    opportunityId: one.opportunity.id,
    title: one.opportunity.title,
    modelled: modelledIds.has(one.opportunity.id),
    missing: linkChecks(one, dealsForGoal(one, target.remainingCents / 100), target, capabilities, now)
      .filter((check) => !check.ok)
      .map((check) => check.link),
    supportedReach: one.agreed || priceSupported(one) ? bestCaseReach(one, target.remainingCents / 100, target.daysLeft ?? 0, true) : 0,
    potentialReach:
      one.agreed || one.price.value !== null || one.price.high !== null
        ? bestCaseReach(one, target.remainingCents / 100, target.daysLeft ?? 0)
        : null,
    competitiveAward: one.competitiveAward,
    volumeEstablished: one.repeatable ? volumeEstablished(one) : one.volume.provenance === 'EVIDENCE',
  }));
  considered.sort((a, b) => a.missing.length - b.missing.length || b.supportedReach - a.supportedReach);
  const strategies: StrategyReading[] = [];
  for (const spec of model.definition.strategies) {
    const members = model.included
      .map((one) => ({ one, deals: Number(spec.set[`o${one.index}_n`] ?? 0) }))
      .filter((member) => member.deals > 0 || member.one.agreedValue > 0);
    const links = CHAIN_LINKS.map((link) => {
      const checks = members.map(({ one, deals }) => linkChecks(one, deals, target, capabilities, now).find((check) => check.link === link)!);
      return { link, ok: checks.every((check) => check.ok), basis: checks.map((check) => check.basis).join(' | ') };
    });
    const constraintsFailed: string[] = [];
    for (const { one, deals } of members) {
      if (one.capital.value !== null && one.capital.provenance !== 'UNKNOWN') {
        const ceiling = target.capitalCeilingCents;
        const tied = dealsTaken(one, deals) * one.capital.value;
        if (ceiling !== null && tied > ceiling / 100) constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" ties up ${tied} ${target.currency}, more than the ${ceiling / 100} the owner said this goal may commit`);
      }
      if (one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && target.daysLeft !== null && one.daysToCash.value > target.daysLeft) {
        constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" settles in ${one.daysToCash.value} days, after the ${target.daysLeft} left`);
      }
      // Reconstructed from comparable evidence (§79): nine worlds in ten settle too late.
      if (one.daysToCash.value === null && one.daysToCash.inferred?.justified && target.daysLeft !== null && one.daysToCash.inferred.p10 > target.daysLeft) {
        constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" would settle in at least ${Math.round(one.daysToCash.inferred.p10)} days in nine of ten reconstructed cases (${one.daysToCash.inferred.tier.toLowerCase()} evidence, ${one.daysToCash.inferred.observations} observations), after the ${target.daysLeft} left`);
      }
      if (one.price.value !== null && one.directCost.value !== null && one.directCost.provenance !== 'UNKNOWN' && one.price.value <= one.directCost.value) {
        constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" costs at least what it pays`);
      }
      if (one.opportunity.expiresAt && Date.parse(one.opportunity.expiresAt) < now.getTime()) constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" closed on ${one.opportunity.expiresAt.slice(0, 10)}`);
    }
    const sweep = sweepOf(result, spec.key);
    // The best case is computed from established numbers only — every offered
    // buyer agreeing — never from the bounds a sweep happened to test.
    const best = members.reduce((sum, { one, deals }) => {
      const late = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && target.daysLeft !== null && one.daysToCash.value > target.daysLeft;
      // An award not yet shown to pay in time is not reach: it must be won first.
      const unproven = one.competitiveAward && one.daysToCash.provenance !== 'EVIDENCE' && one.daysToCash.provenance !== 'HISTORICAL';
      if (late) return sum;
      // Agreed money is reach. New deals are reach only at a price buyers are
      // shown to pay — never at a guessed or listed one.
      // A repeatable play takes no more deals than research shows the market holds.
      const taken = volumeEstablished(one) && one.repeatable ? Math.min(deals, one.volume.value ?? deals) : deals;
      return sum + one.agreedValue + (unproven || !priceSupported(one) ? 0 : taken * (one.price.high ?? one.price.value ?? 0));
    }, 0);
    if (best < target.remainingCents / 100) {
      constraintsFailed.push(`cannot reach the ${target.remainingCents / 100} ${target.currency} still needed at prices buyers are shown to pay, even if every buyer it offers to agreed (at most ${Math.round(best)})`);
    }
    bestReach = Math.max(bestReach, best);
    /*
     * The owner's way of spending: little first, the rest once money comes in,
     * spread over time. A plan has to be able to start that way — some step
     * that can pay with no more tied up than the test allows — and an award
     * that pays one lump at the end, after somebody else decides, cannot.
     */
    const paced = target.capitalBeforeProofCents !== null || target.capitalPerWeekCents !== null;
    if (paced && members.length > 0 && members.every(({ one }) => one.competitiveAward)) {
      constraintsFailed.push('pays only after winning an award and then waiting on the buyer\'s payment, in one lump at the end — not little by little, as the owner wants');
    }
    if (target.capitalBeforeProofCents !== null && !target.proven) {
      const test = target.capitalBeforeProofCents / 100;
      const starters = members.filter(({ one }) => !one.competitiveAward && !(one.capital.value !== null && one.capital.provenance !== 'UNKNOWN' && one.capital.value > test));
      if (members.length > 0 && starters.length === 0 && !members.some(({ one }) => one.competitiveAward)) {
        constraintsFailed.push(`no step can start with ${test} ${target.currency} or less tied up, which is all the owner allows before money comes in`);
      }
    }
    if (sweep.infeasibleShare === 1) constraintsFailed.push('breaks the money or hours limit in every tested case');
    const cons = conservative(members, target);
    // Spread over the goal's life: the owner's weekly pace, over the weeks left.
    if (target.capitalPerWeekCents !== null && cons.exposure !== null && target.daysLeft !== null) {
      const room = (target.capitalPerWeekCents / 100) * Math.max(1, Math.ceil(target.daysLeft / 7));
      if (cons.exposure > room) constraintsFailed.push(`ties up ${Math.round(cons.exposure)} ${target.currency}, more than ${Math.round(room)} at the owner's weekly pace before the deadline`);
    }
    const missing = links.find((one) => !one.ok);
    let verdict: PlanVerdict;
    if (constraintsFailed.length > 0) verdict = 'NOT_VIABLE';
    else if (missing) verdict = 'NEEDS_EVIDENCE';
    else if (
      cons.settled !== null && cons.settled >= target.remainingCents / 100 &&
      (target.capitalCeilingCents === null || (cons.exposure ?? Infinity) <= target.capitalCeilingCents / 100) &&
      (target.hoursCeiling === null || (cons.labour ?? Infinity) <= target.hoursCeiling)
    ) verdict = 'RECOMMENDABLE';
    else verdict = 'NEEDS_EVIDENCE';
    /*
     * A plan that needs money up front, for a goal whose owner has not said how
     * much may be committed, is not recommended on the ledger's behalf. It is
     * a question for the owner — which is not the same thing as a failure, and
     * not permission to spend once answered: the commercial authority still
     * decides that.
     */
    const askCapital =
      verdict === 'RECOMMENDABLE' && target.capitalCeilingCents === null && (cons.exposure ?? 0) > 0;
    if (askCapital) verdict = 'NEEDS_EVIDENCE';
    let nextTest: NextTest | null = null;
    if (askCapital) {
      nextTest = {
        link: 'ECONOMICS',
        test: `This plan ties up about ${Math.round(cons.exposure!)} ${target.currency} before it pays. Say how much this goal may commit, or that it may commit none.`,
        by: 'PERSON',
        blocker: 'The owner has not said how much money this goal may commit.',
      };
    } else if (verdict === 'NEEDS_EVIDENCE') {
      if (missing) {
        const member = members.find(({ one, deals }) => !linkChecks(one, deals, target, capabilities, now).find((check) => check.link === missing.link)!.ok)!;
        nextTest = await nextTestFor(missing.link, member.one, target.projectId);
      } else {
        nextTest = { link: 'CONVERSION', test: 'Every link is established, but the cautious numbers fall short of the target: add a second opening or more buyers and test again.', by: 'BRAIN', blocker: null };
      }
    }
    // Proof first: before any money comes in, the test is held to the owner's
    // test-stage limit, and the rest waits for it to pay.
    if (nextTest?.link === 'CONVERSION' && target.capitalBeforeProofCents !== null && !target.proven) {
      nextTest = { ...nextTest, test: `${nextTest.test} Tie up no more than ${target.capitalBeforeProofCents / 100} ${target.currency} until money comes in; the rest waits for that proof.` };
    }
    strategies.push({
      key: spec.key,
      label: spec.label,
      verdict,
      opportunityIds: members.map(({ one }) => one.opportunity.id),
      links,
      constraintsFailed,
      sweep,
      conservativeSettled: cons.settled,
      nextTest,
    });
  }

  const awardIds = new Set(model.included.filter((one) => one.competitiveAward).map((one) => one.opportunity.id));
  const awards = (s: StrategyReading) => s.opportunityIds.filter((id) => awardIds.has(id)).length;
  const rank = (s: StrategyReading) => (s.verdict === 'RECOMMENDABLE' ? 0 : s.verdict === 'NEEDS_EVIDENCE' ? 1 : 2);
  const ordered = [...strategies].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.conservativeSettled ?? -1) - (a.conservativeSettled ?? -1) ||
      awards(a) - awards(b) ||
      a.links.filter((one) => !one.ok).length - b.links.filter((one) => !one.ok).length ||
      (b.sweep.goalMetShare ?? 0) - (a.sweep.goalMetShare ?? 0),
  );
  const chosen = ordered[0] ?? null;
  const verdict: PlanVerdict = chosen?.verdict ?? 'NEEDS_EVIDENCE';
  const summary =
    verdict === 'RECOMMENDABLE'
      ? `"${chosen!.label}" is recommendable: every link is established and the cautious numbers reach the target inside the limits.`
      : verdict === 'NOT_VIABLE'
        ? `No modelled strategy can work under the current limits: ${chosen?.constraintsFailed[0] ?? 'every one fails a limit'}.`
        : `Not yet proven. The closest plan is "${chosen?.label}", and what it is missing first is ${CHAIN_LABEL[chosen!.nextTest!.link]}.`;
  const reading: PlanReading = {
    ...base,
    verdict,
    summary,
    chosen: chosen?.key ?? null,
    strategies,
    nextTest: chosen?.nextTest ?? null,
    scenarioModelId,
    scenarioRunId,
    basisNote: result?.basisNote ?? null,
    refusal: null,
    bestReach,
    considered,
    // Sufficient means a realistic, evidence-supported plan — a recommendation —
    // never openings that merely look valuable. Until there is one, keep looking.
    needsMoreOpenings: !target.achieved && verdict !== 'RECOMMENDABLE',
    inferred: inferredInputs(model.considered),
    researchPriority: researchPriority(result, model.included, target, chosen?.key ?? null),
    pool: poolConclusion(bestReach, target, considered.length),
  };
  if (input.persist) await persistReading(goal, reading, chosen);
  return reading;
}

function inferredInputs(considered: ModelledOpportunity[]): InferredInput[] {
  const out: InferredInput[] = [];
  const fields: Array<[InferredInput['field'], keyof ModelledOpportunity]> = [['daysToCash', 'daysToCash'], ['directCosts', 'directCost'], ['requiredCapital', 'capital'], ['close', 'close']];
  for (const one of considered) {
    for (const [field, key] of fields) {
      const input = one[key] as ModelledOpportunity['price'];
      if (!input.inferred) continue;
      out.push({ opportunityId: one.opportunity.id, title: one.opportunity.title, field, tier: input.inferred.tier, justified: input.inferred.justified, p10: input.inferred.p10, p50: input.inferred.p50, p90: input.inferred.p90, observations: input.inferred.observations });
    }
  }
  return out;
}

/**
 * Turn the run's information value into research decisions: which unknown
 * could change the choice, and whether to research it now, learn it by doing,
 * act on the reconstruction, or leave it alone because the answer would not
 * change anything (§79).
 */
export function researchPriority(result: ScenarioResult | null, included: ModelledOpportunity[], target: TargetReading, chosen: string | null): ResearchPriority[] {
  const iv = result?.informationValue;
  // A flat metric — no input could move it at all — says nothing about which
  // question matters, so it decides nothing and the existing order stands.
  if (!iv || target.daysLeft === null || iv.perfect <= 0) return [];
  const strategy = result!.strategies.find((one) => one.key === (chosen ?? iv.baseline.strategy));
  const executionDaysP90 = strategy?.metrics['days']?.p90 ?? 0;
  const out: ResearchPriority[] = [];
  for (const input of iv.inputs) {
    const match = /^o(\d+)_([a-z]+)$/.exec(input.key);
    const member = match ? included.find((one) => one.index === Number(match[1])) : undefined;
    const kind = match ? VARIABLE_FIELD[match[2]!] : undefined;
    const verdict = decideResearch(
      { key: input.key, informationValue: input.value, changesDecision: input.changesDecision, researchDays: RESEARCH_TURNAROUND_DAYS, learnableInExecution: kind?.learnable ?? true },
      { daysLeft: target.daysLeft, executionDaysP90 },
    );
    out.push({ variable: input.key, opportunityId: member?.opportunity.id ?? null, field: kind?.field ?? null, value: input.value, changesDecision: input.changesDecision, decision: verdict.decision, reason: verdict.reason });
  }
  return out;
}

interface ReadingRow {
  id: string;
  workstream_id: string;
  digest: string;
  scenario_model_id: string | null;
  scenario_run_id: string | null;
  verdict: string;
  chosen_strategy: string | null;
  strategies: string;
  next_test: string | null;
  forecast: string | null;
  created_at: string;
}

export async function latestReading(goalId: string): Promise<ReadingRow | null> {
  return (await getDb().get<ReadingRow>(
    'SELECT * FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [goalId],
  )) ?? null;
}

export async function listReadings(goalId: string): Promise<ReadingRow[]> {
  return await getDb().all<ReadingRow>('SELECT * FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at ASC, id ASC', [goalId]);
}

/** Append a reading when its conclusion differs from the last; link a recommended plan's work to the goal. */
async function persistReading(goal: Workstream, reading: PlanReading, chosen: StrategyReading | null): Promise<void> {
  const summary = {
    verdict: reading.verdict,
    chosen: reading.chosen,
    strategies: reading.strategies.map((one) => ({ key: one.key, verdict: one.verdict, missing: one.links.filter((link) => !link.ok).map((link) => link.link), failed: one.constraintsFailed })),
    next: reading.nextTest,
    refusal: reading.refusal,
  };
  const digest = sha256(canonicalJson(summary));
  const last = await latestReading(goal.id);
  if (last && last.digest === digest) return;
  const forecast = chosen
    ? { conservativeSettled: chosen.conservativeSettled, sweep: chosen.sweep, remainingCents: reading.target.remainingCents, daysLeft: reading.target.daysLeft }
    : null;
  await getDb().run(
    `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('gpr'),
      goal.id,
      digest,
      reading.scenarioModelId,
      reading.scenarioRunId,
      reading.verdict,
      reading.chosen,
      JSON.stringify(reading.strategies),
      reading.nextTest ? JSON.stringify(reading.nextTest) : null,
      forecast ? JSON.stringify(forecast) : null,
      new Date().toISOString(),
    ],
  );
  await recordWorkstreamEvent({
    workstreamId: goal.id,
    kind: 'GOAL_PLAN_READ',
    summary: reading.summary.slice(0, 400),
    actorRef: 'BRAIN',
  });
  // A recommended plan's opportunities become work this goal pursues, so the
  // goal tick holds and prioritizes them. Execution itself stays with the
  // existing commercial authority and its effects.
  if (reading.verdict === 'RECOMMENDABLE' && chosen) {
    const links = await listLinks(goal.id);
    for (const opportunityId of chosen.opportunityIds) {
      if (links.some((one) => one.kind === 'OPPORTUNITY' && one.ref === opportunityId && one.relation === 'PURSUES')) continue;
      await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: opportunityId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
    }
  }
}

/**
 * What actually happened, against the reading in force: written once when the
 * target is reached or the due date passes. Failures stay in the record —
 * they are half of what any later success rate is computed from.
 */
export async function recordGoalOutcome(goalId: string, now: Date = new Date()): Promise<'ACHIEVED' | 'MISSED' | null> {
  const goal = await getWorkstream(goalId);
  if (!goal?.target) return null;
  const target = await readTarget(goal, now);
  if (!target) return null;
  const due = goal.dueAt ? Date.parse(goal.dueAt) : null;
  const kind = target.achieved && (due === null || now.getTime() <= due) ? 'ACHIEVED' : due !== null && now.getTime() > due ? (target.achieved ? 'ACHIEVED' : 'MISSED') : null;
  if (!kind) return null;
  const reading = (await getDb().get<{ id: string }>(
    'SELECT id FROM goal_plan_readings WHERE workstream_id = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [goal.id, now.toISOString()],
  )) ?? null;
  if (!reading) return null;
  const result = await getDb().run(
    `INSERT INTO goal_outcomes (id, workstream_id, reading_id, kind, achieved_cents, target_cents, detail, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reading_id, kind) DO NOTHING`,
    [newId('gou'), goal.id, reading.id, kind, target.achievedCents, target.targetCents, JSON.stringify({ metric: target.metric, notCounted: target.notCounted }), now.toISOString()],
  );
  return (result.changes ?? 0) > 0 ? kind : null;
}

/** The tick's pass: re-read every targeted goal's plan at most this often. */
export const PLAN_REFRESH_MS = 30 * 60_000;

/**
 * The last reading of each goal this process took, so the search can be topped
 * up between refreshes. Re-reading the plan is a scenario run; asking one more
 * question needs only the target, the best reach and the titles already held,
 * which change slowly. Lost on restart, which only means the first top-up
 * waits for the first refresh.
 */
const lastReadings = new Map<string, PlanReading>();
const lastTopUp = new Map<string, number>();
/** A top-up between refreshes at most this often per goal: rounds settle in minutes, not seconds. */
export const GOAL_TOP_UP_MS = 5 * 60_000;

/** Tests. */
export function forgetGoalReadings(): void {
  lastReadings.clear();
  lastTopUp.clear();
}

/**
 * Widen a goal's search to the capacity that would otherwise sit idle.
 *
 * One lens a refresh and three rounds at once were fixed numbers. Production,
 * 2026-10-31: the $10K goal read NOT_VIABLE over 32 openings with its plan
 * asking for more, while eight routable research surfaces held two activations.
 * Each idle surface with nothing waiting may now carry one more of the goal's
 * own rounds, opened in this pass rather than one per half hour — and every
 * round is linked to the goal, so the goal's rank reaches the bins it creates.
 * When work queues up the spare is zero and this is exactly the old behaviour.
 */
async function widenGoalSearch(goalId: string, reading: PlanReading, now: Date, spare: number): Promise<{ asked: number; constructed: number; researched: number }> {
  const goal = await getWorkstream(goalId);
  if (!goal) return { asked: 0, constructed: 0, researched: 0 };
  let asked = 0;
  const attempts = 1 + spare;
  /*
   * New mechanisms first (§81): arrangements Brain composed itself from the
   * buyer populations, needs and supply it knows of, decomposed so the round
   * asks only for the parts nothing establishes. Then the world is asked from
   * the next lens. Both are new-opening work; the existing openings' paths are
   * researched separately below, so one never crowds the other out.
   */
  const constructed = await askConstructedArrangements(goal, reading, now, Math.max(1, Math.ceil(attempts / 2)), MAX_LIVE_GOAL_ROUNDS + spare);
  for (const candidateId of constructed) {
    await linkWorkstream({ workstreamId: goal.id, kind: 'CANDIDATE', ref: candidateId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
  }
  for (let i = 0; i < attempts; i += 1) {
    const opened = await openGoalDiscovery({
      goal,
      target: reading.target,
      bestReach: reading.bestReach,
      heldTitles: reading.considered.map((one) => one.title),
      now: now.toISOString(),
      liveCap: MAX_LIVE_GOAL_ROUNDS + spare,
    });
    if (!opened) break;
    asked += 1;
    await linkWorkstream({
      workstreamId: goal.id,
      kind: 'CANDIDATE',
      ref: opened.candidateId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
      recordedByUserId: null,
    });
  }
  // And dig into the openings already held: the path to their money.
  const researched = (await researchGoalPaths({ reading, projectId: reading.target.projectId, now, spare })).length;
  return { asked, constructed: constructed.length, researched };
}

/** The goal's own limits, as construction reads them (§82). */
export function goalLimits(reading: PlanReading): import('../cash/properties.ts').GoalLimits {
  const t = reading.target;
  return {
    daysLeft: t.daysLeft,
    remainingCents: t.remainingCents,
    capitalCeilingCents: t.capitalCeilingCents,
    capitalBeforeProofCents: t.capitalBeforeProofCents,
    bestReachCents: reading.bestReach === null ? null : Math.round(reading.bestReach * 100),
  };
}

/** Open rounds for the best-ranked arrangements Brain constructed, at most `max` this pass. */
export async function askConstructedArrangements(goal: Workstream, reading: PlanReading, now: Date, max: number, liveCap: number): Promise<string[]> {
  const t = reading.target;
  if (t.daysLeft === null || t.daysLeft <= 0 || t.remainingCents <= 0) return [];
  const frame = await executionFrame(t.projectId, t.currency);
  const arrangements = (await constructArrangements({
    projectId: t.projectId,
    currency: t.currency,
    delivers: frame?.delivers ?? [],
    capitalCeilingCents: t.capitalCeilingCents,
    daysLeft: t.daysLeft,
    limits: goalLimits(reading),
    exclusions: await goalExclusions(goal),
    now,
  }))
    // A design whose known worst case is more money than the goal may tie up is rejected, not asked (§82).
    .filter((one) => one.stress.exposure !== 'EXCEEDS');
  const opened: string[] = [];
  /*
   * One buyer population per pass before a second: ranking favours the best-
   * evidenced parts, and production's first pass sent all five askings to one
   * buyer. Spread first; a population already asked waits for the next pass.
   */
  const openMx = (await listRounds(t.projectId)).filter((r) => r.state === 'OPEN' && r.bucketId.startsWith(`goal-${goal.id}-mx-`));
  /*
   * Constructed rounds share the goal's live cap with the lenses that ask the
   * world from a new angle. Since reverse construction (§82) always has a
   * design to ask about, an unbounded share would take every slot and the
   * lenses would never run, so construction holds at most half of it.
   */
  const room = Math.max(1, Math.floor(liveCap / 2)) - openMx.length;
  if (room <= 0) return [];
  max = Math.min(max, room);
  const askedDemand = new Set(openMx.map((r) => r.bucketId.slice(r.bucketId.lastIndexOf('-mx-') + 4)));
  const openDemand = new Set(arrangements.filter((one) => askedDemand.has(one.key)).map((one) => one.demand.ref));
  const spread = [...arrangements.filter((one) => !openDemand.has(one.demand.ref)), ...arrangements.filter((one) => openDemand.has(one.demand.ref))];
  const thisPass = new Set<string>();
  for (const one of spread) {
    if (opened.length >= max) break;
    if (thisPass.has(one.demand.ref) && spread.some((other) => !thisPass.has(other.demand.ref) && !openDemand.has(other.demand.ref))) continue;
    const round = await openConstructedRound({ goal, projectId: t.projectId, key: one.key, title: `Constructed: ${one.label}`, question: one.question, now: now.toISOString(), liveCap });
    // Null is this arrangement's cool-off, the live cap or a closed gate: the next one is tried.
    if (round) {
      opened.push(round.candidateId);
      thisPass.add(one.demand.ref);
    }
  }
  return opened;
}

export async function advanceGoalPlans(now: Date = new Date()): Promise<{ read: number; outcomes: number; asked: number; constructed: number; researched: number; busy: boolean }> {
  const goals = await getDb().all<{ id: string }>(
    `SELECT id FROM workstreams WHERE target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL`,
  );
  let read = 0;
  let outcomes = 0;
  let asked = 0;
  let constructed = 0;
  let researched = 0;
  for (const { id } of goals) {
    if (await recordGoalOutcome(id, now)) outcomes += 1;
    const last = await getDb().get<{ at: string | null }>(
      `SELECT MAX(created_at) AS at FROM goal_plan_readings WHERE workstream_id = ?`,
      [id],
    );
    const lastRun = await getDb().get<{ at: string | null }>(
      `SELECT MAX(r.started_at) AS at FROM scenario_runs r JOIN goal_plan_readings g ON g.scenario_model_id = r.model_id WHERE g.workstream_id = ?`,
      [id],
    );
    const since = [last?.at, lastRun?.at].filter((one): one is string => !!one).reduce((max, at) => Math.max(max, Date.parse(at)), 0);
    if (since && now.getTime() - since < PLAN_REFRESH_MS) {
      // Not due for a re-read; top the search up if the fleet has room for it.
      const held = lastReadings.get(id);
      const toppedUp = lastTopUp.get(id) ?? 0;
      if (held?.needsMoreOpenings && now.getTime() - toppedUp >= GOAL_TOP_UP_MS) {
        lastTopUp.set(id, now.getTime());
        const spare = await cashSpareSurfaces(held.target.projectId);
        if (spare > 0) {
          const more = await widenGoalSearch(id, held, now, spare);
          asked += more.asked;
          constructed += more.constructed;
          researched += more.researched;
        }
      }
      continue;
    }
    let reading: PlanReading | null;
    try {
      reading = await readGoalPlan({ goalId: id, now, persist: true });
      read += 1;
    } catch (error) {
      if (error instanceof ScenarioBusyError) return { read, outcomes, asked, constructed, researched, busy: true };
      throw error;
    }
    if (reading) lastReadings.set(id, reading);
    else lastReadings.delete(id);
    // What Brain holds cannot reach the goal however it is combined: look for
    // more, through the same discovery every bucket uses, instead of reading
    // the same openings again in thirty minutes.
    if (reading?.needsMoreOpenings) {
      const spare = await cashSpareSurfaces(reading.target.projectId);
      const more = await widenGoalSearch(id, reading, now, spare);
      asked += more.asked;
      constructed += more.constructed;
      researched += more.researched;
    }
  }
  return { read, outcomes, asked, constructed, researched, busy: false };
}
