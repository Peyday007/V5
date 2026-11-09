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
import { composeBuyerMessage } from '../cash/outreach.ts';
import { evidenceCard } from '../cash/card.ts';
import { ARRANGEMENT_ID_PREFIX, isArrangementId, bestCaseReach, composeGoalModel, planTrace, dealsForGoal, OUTREACH_MULTIPLE, priceSupported, volumeEstablished, wilson, type ModelledOpportunity } from '../cash/goalScenario.ts';
import { readTarget, type TargetReading } from './target.ts';
import { executionFrame, MAX_LIVE_GOAL_ROUNDS, openConstructedRound, openGoalDiscovery, roundsStillResearching } from '../cash/discovery.ts';
import { constructArrangements, type ConstructedArrangement } from '../cash/construct.ts';
import { exclusionSentence, goalExclusions } from '../cash/exclusions.ts';
import { OPENING_SENTENCE } from '../cash/construct.ts';
import { listRounds } from '../../repos/cashDiscovery.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { exemptSales, recordMateriality } from './materiality.ts';
import { withReadScope } from '../../repos/readScope.ts';
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
import { goalExecutionPolicy, MAX_CONCURRENT_SALES, type GoalExecutionPolicy } from '../../domain/goalPolicy.ts';
import type { GoalPortfolio } from './portfolio.ts';
import { diagnoseGoalResearch, diagnosisInstructions, recentGoalRounds, type ResearchDiagnosis } from './researchYield.ts';
import type { EvidenceTier } from '../../domain/quant.ts';
import { readPathways, type BrainCapabilities, type PathwayReading } from './pathways.ts';
import { reconstructPlan, type Reconstruction } from './reconstruction.ts';
import { implementedFormats } from '../puzzle/formats/index.ts';

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
  /**
   * The owner's hard acceptance condition (2026-11-09): a plan meets a cash
   * goal only when a defensible probability of collecting the target before
   * the deadline is at least this — read at the lower bound of its interval,
   * never at a point estimate, and never from coverage of tested conditions.
   */
  requiredProbability: 0.9,
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
  /**
   * Every link established and the cautious numbers reach the target. A
   * qualified candidate, not an accepted plan: acceptance also needs the
   * required probability (`judgeAcceptance`).
   */
  chainComplete: boolean;
  nextTest: NextTest | null;
}

/**
 * Whether the goal has an accepted plan, kept apart from its candidates.
 *
 * ACCEPTED — the target is already collected, or a defensible probability of
 * collecting it before the deadline clears `requiredProbability` at the lower
 * bound of its interval. CANDIDATE_ONLY — Brain holds a strongest provisional
 * plan that does not (yet) meet that bar; it is pursued and improved, never
 * reported as meeting the objective. NO_CANDIDATE — nothing to pursue yet.
 */
export interface PlanAcceptance {
  status: 'ACCEPTED' | 'CANDIDATE_ONLY' | 'NO_CANDIDATE';
  required: number;
  /** Only a defensible probability: the ledger, an all-evidence Monte Carlo, or this Brain's own record. */
  probability: { value: number; lowerBound: number; basis: 'TARGET_MET' | 'EVIDENCED_PORTFOLIO' | 'MEASURED_RECORD'; sample: number; note: string } | null;
  /** The plan that meets the objective, when one does. */
  accepted: { label: string; opportunityIds: string[] } | null;
  /** The strongest provisional plan, kept and improved while nothing is accepted. */
  candidate: {
    label: string;
    opportunityIds: string[];
    source: 'QUANT_PORTFOLIO' | 'STRATEGY' | 'PATHWAYS';
    settledP50: number | null;
    /** Share of worlds reaching the target, and whether it is a probability or only coverage. */
    reach: number | null;
    reachBasis: 'PROBABILITY' | 'COVERAGE' | null;
  } | null;
  /** Why the candidate is not accepted, each a thing work can change. */
  shortfalls: string[];
  sentence: string;
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
  /** Accepted plan versus candidates, under the owner's 90% condition. RECOMMENDABLE iff ACCEPTED. */
  acceptance: PlanAcceptance;
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
  /** How many openings stand on each rung of the validation ladder. */
  ladder: Record<ValidationStage, number>;
  /**
   * The bounded buyer tests Brain can name now: openings at C, largest
   * potential first. Each says who runs it and what stops it.
   */
  marketTests: MarketTest[];
  /**
   * How this goal is executed (`domain/goalPolicy.ts`). A SQUEEZE goal — a
   * cash target with a deadline — has no market-testing phase: `marketTests`
   * is empty and `sales` holds the openings it sells now.
   */
  executionPolicy: GoalExecutionPolicy;
  /**
   * The openings a SQUEEZE goal sells now, several at once, best contribution
   * first: each can be offered responsibly (a reachable buyer, an offer, a
   * price, an outlay inside the limits), and the offer pursues an actual sale,
   * contract or deposit. Linked to the goal as PURSUES, so the goal's money
   * limits bind them and the operator reaches their buyers first.
   */
  sales: MarketTest[];
  /**
   * The quant engine's combined plan (§79): each opening's customer demand
   * estimated from verified evidence, and the combination most likely to reach
   * the target under the spending, capital and timing limits, with the shared
   * outreach counted as one risk. A probability only when its basis says so.
   */
  portfolio: GoalPortfolio | null;
  /**
   * Why the goal's research is not yet producing openings this plan can use,
   * read from the openings it judged and the goal's recent rounds
   * (`researchYield.ts`). The next goal round is asked differently for each.
   */
  researchDiagnosis: ResearchDiagnosis[];
  /**
   * When the plan is not accepted: why, what was changed, what each change
   * did, and the strongest reconstructed plan with its confidence (§99).
   */
  reconstruction?: Reconstruction | null;
  /**
   * The goal-to-transaction reasoning loop (§93, `pathways.ts`): the
   * transaction structures the goal's own figures require, a transaction model
   * per opening and constructed estimate with each field PROVEN, ESTIMATED or
   * UNKNOWN, the moves that construct its missing links, the unknowns ranked
   * by how far they could move the plan, a living portfolio with its fallback,
   * and the method's own failures. Null when nothing could be modelled.
   */
  pathways: PathwayReading | null;
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

/** Openings that pay once by nature, whatever the market's volume. */
export const PAYS_ONCE = /\b(?:bount(?:y|ies)|contests?|competitions?|prizes?|sweepstakes|one[- ]off|submissions?|hackathons?)\b/i;

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
  /**
   * It pays once by nature — an award, a bounty, a contest, a prize, a single
   * submission — so its size is its size whatever research finds about volume.
   */
  paysOnce: boolean;
  /** Where it stands on the commercial validation ladder, derived from its links and the ledger. */
  stage: ValidationStage;
}

/**
 * The commercial validation ladder (owner's specification, 2026-11-02).
 *
 * A THEORETICAL — an idea or a buyer population nothing yet evidences.
 * B EVIDENCED — research established a payer and a buying signal or a route to them.
 * C MARKET_TEST_READY — a reachable buyer, an offer and a price, and a first step
 *   inside the owner's before-income limit. What buyers will do is unknown, and
 *   it can only be learned by asking them: this is where the old gate went in a
 *   circle, demanding conversion evidence that only a market test produces.
 * D BUYER_VALIDATED — buyers have been shown to say yes (this Brain's own history).
 * E COMMITTED — a buyer's agreement is recorded.
 * F COLLECTED — the ledger holds a customer payment for it.
 *
 * Derived, never stored: a stage is a reading of rows, so it cannot drift from them.
 * Reaching C asks nothing new of the world — it names a bounded test whose result
 * is D or a recorded rejection, never a figure anyone assumed.
 */
export type ValidationStage = 'A_THEORETICAL' | 'B_EVIDENCED' | 'C_MARKET_TEST_READY' | 'D_BUYER_VALIDATED' | 'E_COMMITTED' | 'F_COLLECTED';

export interface MarketTest {
  opportunityId: string;
  title: string;
  /** What it could bring at the card's price if buyers agree; null when nothing says. */
  potentialReach: number | null;
  test: NextTest;
}

/** Pure: the stage one opening has reached, from its links and whether money arrived. */
export function validationStage(one: ModelledOpportunity, checks: LinkCheck[], target: TargetReading, collected: boolean): ValidationStage {
  if (collected) return 'F_COLLECTED';
  if (one.agreed) return 'E_COMMITTED';
  const ok = (link: ChainLink) => checks.find((check) => check.link === link)?.ok === true;
  if (ok('CONVERSION')) return 'D_BUYER_VALIDATED';
  const o = one.opportunity;
  const price = one.price.value;
  const capital = one.capital.value;
  const limit = target.capitalBeforeProofCents !== null ? target.capitalBeforeProofCents / 100 : null;
  const cost = one.directCost.value;
  if (
    ok('REACHABLE_BUYER') &&
    !!o.offerScope &&
    price !== null &&
    price > 0 &&
    // A test is a few offers at the card's price, so the price itself is what it measures.
    (cost === null || cost < price) &&
    // A first step the owner allows before any money comes in; unknown capital is a question, not a yes (invariant 39).
    capital !== null &&
    (limit === null || capital <= limit) &&
    !one.competitiveAward
  ) {
    return 'C_MARKET_TEST_READY';
  }
  if (o.payer && (ok('CURRENT_DEMAND') || ok('REACHABLE_BUYER') || !!o.buyingSignal)) return 'B_EVIDENCED';
  return 'A_THEORETICAL';
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
 * The owner's acceptance rule (2026-11-09), applied to what the plan read
 * composed. Pure.
 *
 * A plan is ACCEPTED only on a defensible probability of collecting the
 * target before the deadline of at least `requiredProbability`, read at the
 * lower bound of its interval:
 *
 *   1. TARGET_MET — the ledger already holds it.
 *   2. EVIDENCED_PORTFOLIO — the quant engine's best combination, when every
 *      input of every member rests on evidence or this Brain's measurements
 *      (basis PROBABILITY), every member's chain is complete, and the Wilson
 *      lower bound of its reach over the worlds evaluated clears the bar.
 *   3. MEASURED_RECORD — the chosen strategy's chain is complete and this
 *      Brain's own record of how its accepted plans ended clears the bar.
 *
 * Coverage of tested conditions, a cautious point reading, a sweep, a model's
 * assumed conversion rate or a recorded agreement is never one of these: each
 * leaves the plan a candidate. The strongest candidate is still named, so it
 * is pursued and improved while nothing is accepted.
 */
export function judgeAcceptance(input: {
  achieved: boolean;
  chosen: StrategyReading | null;
  portfolio: GoalPortfolio | null;
  measuredChance: PlanReading['measuredChance'];
  considered: Pick<ConsideredOpening, 'opportunityId' | 'missing'>[];
  pathways?: Pick<PathwayReading, 'portfolio'> | null;
  required?: number;
}): PlanAcceptance {
  const required = input.required ?? RECOMMENDATION_POLICY.requiredProbability;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const best = input.portfolio?.best ?? null;
  const bestIds = best ? [...new Set(best.members.map((m) => m.opportunityId))] : [];
  const candidate: PlanAcceptance['candidate'] =
    best && bestIds.length > 0
      ? { label: best.members.map((m) => m.title.slice(0, 60)).join(' + '), opportunityIds: bestIds, source: 'QUANT_PORTFOLIO', settledP50: best.settledP50, reach: best.reach, reachBasis: input.portfolio!.basis }
      : input.chosen && input.chosen.verdict !== 'NOT_VIABLE'
        ? { label: input.chosen.label, opportunityIds: input.chosen.opportunityIds, source: 'STRATEGY', settledP50: input.chosen.conservativeSettled ?? input.chosen.sweep.settledP50, reach: input.chosen.sweep.goalMetShare, reachBasis: input.chosen.sweep.goalMetShare === null ? null : input.chosen.sweep.probabilistic ? 'PROBABILITY' : 'COVERAGE' }
        : input.pathways?.portfolio.leading
          ? { label: input.pathways.portfolio.leading.members.join(' + '), opportunityIds: input.pathways.portfolio.leading.members, source: 'PATHWAYS', settledP50: input.pathways.portfolio.leading.net.p50, reach: null, reachBasis: null }
          : null;
  if (input.achieved) {
    return {
      status: 'ACCEPTED',
      required,
      probability: { value: 1, lowerBound: 1, basis: 'TARGET_MET', sample: 1, note: 'the ledger already holds the target' },
      accepted: { label: 'target collected', opportunityIds: [] },
      candidate,
      shortfalls: [],
      sentence: 'The target is collected: the ledger holds it.',
    };
  }
  const shortfalls: string[] = [];
  // 2. The evidenced portfolio.
  if (best && input.portfolio) {
    const worlds = Math.max(1, input.portfolio.worlds);
    const bounds = wilson(Math.round(best.reach * worlds), worlds);
    const missingLinks = bestIds.flatMap((id) => {
      const c = input.considered.find((one) => one.opportunityId === id);
      return c ? c.missing.map((link) => `${id}: ${CHAIN_LABEL[link]}`) : [`${id}: not judged on its chain`];
    });
    if (input.portfolio.basis !== 'PROBABILITY') {
      shortfalls.push(
        `the best combination reaches the target in ${pct(best.reach)} of worlds, which is coverage of assumed inputs, not a probability: ${input.portfolio.missing.filter((one) => !/of worlds; more openings/.test(one)).slice(0, 4).join('; ') || 'inputs are not established'}`,
      );
    } else if (missingLinks.length > 0) {
      shortfalls.push(`the evidenced combination's chain is incomplete: ${missingLinks.slice(0, 4).join('; ')}`);
    } else if (bounds.low < required) {
      shortfalls.push(`the evidenced combination reaches the target in ${pct(best.reach)} of ${worlds} worlds (lower bound ${pct(bounds.low)}), under the required ${pct(required)}`);
    } else {
      return {
        status: 'ACCEPTED',
        required,
        probability: {
          value: best.reach,
          lowerBound: bounds.low,
          basis: 'EVIDENCED_PORTFOLIO',
          sample: worlds,
          note: `every input of every member rests on evidence or this Brain's measurements; openings sharing outreach fail together at correlation ${input.portfolio.limits.correlation}`,
        },
        accepted: { label: candidate!.label, opportunityIds: bestIds },
        candidate,
        shortfalls: [],
        sentence: `Accepted: the evidenced combination collects the target before the deadline in ${pct(best.reach)} of ${worlds} worlds (lower bound ${pct(bounds.low)} ≥ ${pct(required)}).`,
      };
    }
  } else {
    shortfalls.push('no combination of the openings held can run inside the limits');
  }
  // 3. This Brain's own record.
  const m = input.measuredChance;
  if (input.chosen?.chainComplete && m && m.lowerBound >= required) {
    return {
      status: 'ACCEPTED',
      required,
      probability: { value: m.estimate, lowerBound: m.lowerBound, basis: 'MEASURED_RECORD', sample: m.sampleSize, note: m.cohort },
      accepted: { label: input.chosen.label, opportunityIds: input.chosen.opportunityIds },
      candidate,
      shortfalls: [],
      sentence: `Accepted: "${input.chosen.label}" has every link established, and ${m.sampleSize} accepted plans like it ended with a success rate whose lower bound is ${pct(m.lowerBound)} ≥ ${pct(required)}.`,
    };
  }
  shortfalls.push(
    m
      ? `this Brain's record of accepted plans has a lower bound of ${pct(m.lowerBound)} over ${m.sampleSize}, under ${pct(required)}${input.chosen?.chainComplete ? '' : ', and the chosen strategy\'s chain is not complete'}`
      : `this Brain has too few finished accepted plans (under ${RECOMMENDATION_POLICY.minPlanOutcomes}) to calibrate a success rate`,
  );
  if (input.chosen?.chainComplete) shortfalls.push(`"${input.chosen.label}" has every link established and its cautious numbers reach the target — a qualified candidate, but that is a point reading, not a ${pct(required)} probability`);
  return {
    status: candidate ? 'CANDIDATE_ONLY' : 'NO_CANDIDATE',
    required,
    probability: null,
    accepted: null,
    candidate,
    shortfalls,
    sentence: candidate
      ? `NOT ACCEPTED: no plan has a defensible ${pct(required)} probability of collecting the target before the deadline. The strongest candidate is "${candidate.label.slice(0, 160)}"${candidate.reach !== null ? ` (reaches the target in ${pct(candidate.reach)} of worlds, ${candidate.reachBasis === 'PROBABILITY' ? 'a probability' : 'coverage, not a probability'})` : ''}; Brain keeps constructing, combining and comparing strategies.`
      : `NOT ACCEPTED: no candidate plan yet; Brain keeps constructing and comparing strategies.`,
  };
}

/**
 * Read a goal's plan: compose the model from rows, run the existing engine,
 * and apply the gate. Writes nothing unless `persist` is set, and then only the
 * scenario model and run (through the scenario service) and an append-only
 * reading when the conclusion changed.
 */
/** A plan read is one read: project-wide lists are fetched once inside it (repos/readScope.ts). */
/** The permissions and providers a sale needs that this project does not yet have: each blocks only its own action. */
async function missingPermissions(projectId: string): Promise<string[]> {
  const out: string[] = [];
  for (const action of ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT']) {
    if (!(await checkCommercialAuthority({ projectId, action })).ok) out.push(action);
  }
  const caps = new Map((await readCapabilities(['SEND_A_MESSAGE', 'TAKE_A_PAYMENT'])).map((cap) => [cap.id, cap.state]));
  if (caps.get('SEND_A_MESSAGE') !== 'PRESENT') out.push('Instantly connected (messaging)');
  if (caps.get('TAKE_A_PAYMENT') !== 'PRESENT') out.push('a billing provider');
  return out;
}

/**
 * What Brain itself can fulfil (§93): the deliverable kinds the capability frame
 * proves available and the puzzle formats it generates (never one it only
 * validates). Null when the frame cannot be read — then no pathway is credited.
 */
async function brainCapabilities(projectId: string, currency: string): Promise<BrainCapabilities | null> {
  const frame = await executionFrame(projectId, currency);
  if (!frame) return null;
  return { delivers: frame.delivers, puzzleFormats: implementedFormats().filter((one) => one.authoring === 'GENERATED').map((one) => one.key) };
}

/** Two diagnoses as one, first wins on a repeated cause. */
export function mergeDiagnosis(first: ResearchDiagnosis[], second: ResearchDiagnosis[]): ResearchDiagnosis[] {
  const seen = new Set<string>();
  const out: ResearchDiagnosis[] = [];
  for (const one of [...first, ...second]) {
    if (seen.has(one.cause)) continue;
    seen.add(one.cause);
    out.push(one);
  }
  return out;
}

export function readGoalPlan(input: { goalId: string; now?: Date; persist?: boolean; evaluations?: number }): Promise<PlanReading | null> {
  return withReadScope(() => readGoalPlanUnscoped(input));
}

async function readGoalPlanUnscoped(input: { goalId: string; now?: Date; persist?: boolean; evaluations?: number }): Promise<PlanReading | null> {
  const now = input.now ?? new Date();
  const goal = await getWorkstream(input.goalId);
  if (!goal) return null;
  const target = await readTarget(goal, now);
  if (!target) return null;
  const trace = planTrace('plan');
  // The goal's constructed arrangements compete in its model on their estimates (§82, owner 2026-11-06).
  const arrangements = await goalArrangements(goal, target, now).catch((error: unknown) => {
    console.warn(`goal ${goal.id}: construction for the plan failed: ${String((error as Error)?.message ?? error)}`);
    return [] as ConstructedArrangement[];
  });
  trace(`constructed ${arrangements.length}`);
  const model = await composeGoalModel({ goal, target, now, arrangements });
  trace('composed');
  const measuredChance = await measuredPlanChance();
  const base = { goalId: goal.id, target, excluded: model.excluded, measuredChance };
  if (model.refusal) {
    const refusedReconstruction = target.achieved ? null : await reconstructionFor(model, RECOMMENDATION_POLICY.requiredProbability);
    const reading: PlanReading = {
      ...base,
      verdict: target.achieved ? 'RECOMMENDABLE' : 'NEEDS_EVIDENCE',
      summary: model.refusal,
      acceptance: judgeAcceptance({ achieved: target.achieved, chosen: null, portfolio: model.portfolio, measuredChance, considered: [] }),
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
      // No accepted plan: keep constructing while there is time (a goal without a deadline always has).
      needsMoreOpenings: !target.achieved && (target.daysLeft === null || target.daysLeft > 0),
      inferred: inferredInputs(model.considered),
      researchPriority: [],
      pool: { conclusion: 'NO_POOL', sentence: `No opening held is far enough along to model (${model.considered.length} read). That is a statement about what Brain holds, not about what exists, so it keeps searching and constructing.` },
      ladder: emptyLadder(),
      marketTests: [],
      executionPolicy: goalExecutionPolicy(target),
      sales: [],
      portfolio: model.portfolio,
      researchDiagnosis: [
        ...reconstructionDiagnosis(refusedReconstruction),
        ...diagnoseGoalResearch({
          considered: [],
          excludedReasons: model.excluded.map((one) => one.reason),
          rounds: await recentGoalRounds(target.projectId, goal.id),
          remaining: target.remainingCents / 100,
        }),
      ],
      pathways: null,
      reconstruction: refusedReconstruction,
    };
    if (input.persist) await persistReading(goal, reading, null);
    return reading;
  }

  // Run the existing engine. Stored and versioned when persisting.
  const options = { seed: parseInt(sha256(goal.id).slice(0, 8), 16) >>> 0, evaluations: input.evaluations ?? defaultEvaluations(model.included.length), informationValue: { metric: 'goal_met' } };
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
  trace('scenario run');
  const capabilities = new Map((await readCapabilities([...new Set(model.considered.flatMap((one) => one.opportunity.requiredCapabilities)), 'SEND_A_MESSAGE'])).map((one) => [one.id, one.state]));
  const modelledIds = new Set(model.included.map((one) => one.opportunity.id));
  const collected = new Set(
    (await listMoneyEntries({ projectId: target.projectId, limit: 2000 }))
      .filter((entry) => entry.opportunityId && (entry.kind === 'CUSTOMER_PAYMENT' || entry.kind === 'SETTLEMENT'))
      .map((entry) => entry.opportunityId!),
  );
  const checksOf = new Map(model.considered.map((one) => [one.opportunity.id, linkChecks(one, dealsForGoal(one, target.remainingCents / 100), target, capabilities, now)]));
  const considered: ConsideredOpening[] = model.considered.map((one) => ({
    opportunityId: one.opportunity.id,
    title: one.opportunity.title,
    modelled: modelledIds.has(one.opportunity.id),
    missing: checksOf.get(one.opportunity.id)!
      .filter((check) => !check.ok)
      .map((check) => check.link),
    stage: validationStage(one, checksOf.get(one.opportunity.id)!, target, collected.has(one.opportunity.id)),
    supportedReach: one.agreed || priceSupported(one) ? bestCaseReach(one, target.remainingCents / 100, target.daysLeft ?? 0, true) : 0,
    potentialReach:
      one.agreed || one.price.value !== null || one.price.high !== null
        ? bestCaseReach(one, target.remainingCents / 100, target.daysLeft ?? 0)
        : null,
    competitiveAward: one.competitiveAward,
    volumeEstablished: one.repeatable ? volumeEstablished(one) : one.volume.provenance === 'EVIDENCE',
    paysOnce: one.competitiveAward || PAYS_ONCE.test(one.opportunity.title),
  }));
  considered.sort((a, b) => a.missing.length - b.missing.length || b.supportedReach - a.supportedReach);
  recordMateriality(goal.id, target.remainingCents / 100, considered);
  trace('considered openings judged');
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
    if (goalExecutionPolicy(target) === 'SQUEEZE' && nextTest?.link === 'CONVERSION') {
      // A SQUEEZE goal's conversion is learned by selling: the step is the sale, not a test that gates selling.
      const selling = members.find(({ one, deals }) => !linkChecks(one, deals, target, capabilities, now).find((check) => check.link === 'CONVERSION')!.ok)?.one ?? members[0]!.one;
      nextTest = await saleFor(selling, target, considered.find((c) => c.opportunityId === selling.opportunity.id)?.potentialReach ?? null);
    } else if (nextTest?.link === 'CONVERSION' && target.capitalBeforeProofCents !== null && !target.proven) {
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
      chainComplete: verdict === 'RECOMMENDABLE',
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
  /*
   * The bounded tests the ladder allows now. A plan whose held openings cannot
   * reach the goal is still NOT_VIABLE — a test changes no verdict — but its next
   * step is no longer nothing: production, 2026-11-02, read NOT_VIABLE with no
   * next action for days while openings sat with a buyer, an offer and a price
   * that only a buyer could validate.
   */
  const byId = new Map(model.considered.map((one) => [one.opportunity.id, one]));
  const policy = goalExecutionPolicy(target);
  const marketTests: MarketTest[] = [];
  const sales = policy === 'SQUEEZE' ? await salesFor(considered, model.portfolio, byIdOf(model), target) : [];
  exemptSales(goal.id, sales.map((one) => one.opportunityId));
  for (const one of policy === 'SQUEEZE' ? [] : [...considered].filter((c) => c.stage === 'C_MARKET_TEST_READY').sort((a, b) => (b.potentialReach ?? 0) - (a.potentialReach ?? 0)).slice(0, MAX_MARKET_TESTS)) {
    let test = await nextTestFor('CONVERSION', byId.get(one.opportunityId)!, target.projectId);
    if (target.capitalBeforeProofCents !== null && !target.proven) {
      test = { ...test, test: `${test.test} Tie up no more than ${target.capitalBeforeProofCents / 100} ${target.currency} until money comes in.` };
    }
    marketTests.push({ opportunityId: one.opportunityId, title: one.title, potentialReach: one.potentialReach, test });
  }
  trace('strategies and market tests');
  const rounds = await recentGoalRounds(target.projectId, goal.id);
  const found = considered.filter((one) => !isArrangementId(one.opportunityId));
  // The reasoning loop reads what the plan composed; it decides nothing the plan already decides (§93).
  const pathways = readPathways({
    modelled: [...model.considered, ...(model.estimates ?? [])],
    considered,
    target,
    portfolio: model.portfolio,
    permissionsMissing: await missingPermissions(target.projectId),
    rounds,
    now,
    capabilities: await brainCapabilities(target.projectId, target.currency),
  });
  trace('pathways');
  /*
   * The owner's acceptance rule (2026-11-09): a complete chain whose cautious
   * numbers reach the target is a qualified candidate, not an accepted plan.
   * RECOMMENDABLE — the verdict every consumer reads as "meets the objective"
   * — is given only with a defensible probability at or over the required
   * one. Until then the candidate keeps its sale and its pursuit, and its next
   * step is to raise that probability.
   */
  const acceptance = judgeAcceptance({ achieved: target.achieved, chosen, portfolio: model.portfolio, measuredChance, considered, pathways });
  if (acceptance.status !== 'ACCEPTED') {
    for (const s of strategies) {
      if (s.verdict !== 'RECOMMENDABLE') continue;
      s.verdict = 'NEEDS_EVIDENCE';
      s.nextTest ??= {
        link: 'CONVERSION',
        test:
          `Every link is established and the cautious numbers reach the target, but no calibrated evidence shows a ${Math.round(acceptance.required * 100)}% chance of collecting it before the deadline: ` +
          'sell to measure conversion, add independent openings, and try other transaction sizes, prices, channels and combinations until one does.',
        by: 'BRAIN',
        blocker: null,
      };
    }
  }
  // A plan short of its requirement is reconstructed, not just re-read (§99).
  const reconstruction = acceptance.status !== 'ACCEPTED' ? await reconstructionFor(model, acceptance.required) : null;
  trace('reconstruction');
  const verdict: PlanVerdict = acceptance.status === 'ACCEPTED' ? 'RECOMMENDABLE' : (chosen?.verdict ?? 'NEEDS_EVIDENCE');
  const summary =
    verdict === 'RECOMMENDABLE'
      ? acceptance.sentence
      : chosen?.chainComplete
        ? `"${chosen.label}" is a qualified candidate, not an accepted plan: ${acceptance.sentence}`
        : verdict === 'NOT_VIABLE'
        ? `No modelled strategy can work under the current limits: ${chosen?.constraintsFailed[0] ?? 'every one fails a limit'}.`
        : `Not yet proven. The closest plan is "${chosen?.label}", and what it is missing first is ${CHAIN_LABEL[chosen!.nextTest!.link]}.`;
  const reading: PlanReading = {
    ...base,
    verdict,
    summary,
    acceptance,
    chosen: chosen?.key ?? null,
    strategies,
    // A SQUEEZE goal's next step is a sale when one can be offered; evidence work runs beside it.
    // An owner's open decision (how much may be committed) still comes first: it is theirs, and it binds the sale.
    nextTest: goalNextStep({
      policy,
      verdict,
      chosen: chosen?.nextTest ?? null,
      sales: sales.map((one) => one.test),
      marketTest: marketTests[0]?.test ?? null,
      bestReach,
      remaining: target.remainingCents / 100,
      currency: target.currency,
    }),
    scenarioModelId,
    scenarioRunId,
    basisNote: result?.basisNote ?? null,
    refusal: null,
    bestReach,
    considered,
    // Sufficient means a realistic, evidence-supported plan — a recommendation —
    // never openings that merely look valuable. Until there is one, keep looking.
    // A SQUEEZE goal keeps discovering and constructing stronger openings while it sells the ones it has,
    // until the target is met (owner, 2026-11-06): a recommendation is no reason to stop looking.
    // No accepted plan means keep constructing, modifying, combining and comparing (owner, 2026-11-09).
    needsMoreOpenings: !target.achieved && (policy === 'SQUEEZE' || acceptance.status !== 'ACCEPTED'),
    inferred: inferredInputs(model.considered),
    researchPriority: researchPriority(result, model.included, target, chosen?.key ?? null),
    // The pool, the ladder and the diagnosis are about openings found; an estimate is none of them.
    pool: poolConclusion(bestReach, target, considered.filter((one) => !isArrangementId(one.opportunityId)).length),
    ladder: ladderOf(considered.filter((one) => !isArrangementId(one.opportunityId))),
    marketTests,
    executionPolicy: policy,
    sales,
    portfolio: model.portfolio,
    // The method's own failures first: they change how Brain searches, not one opening (§93).
    researchDiagnosis: mergeDiagnosis(
      [...reconstructionDiagnosis(reconstruction), ...pathways.failures],
      diagnoseGoalResearch({
        considered: found,
        excludedReasons: model.excluded.map((one) => one.reason),
        rounds,
        remaining: target.remainingCents / 100,
      }),
    ),
    pathways,
    reconstruction,
  };
  if (input.persist) {
    await persistReading(goal, reading, chosen);
    await pursueSales(goal, reading);
  }
  return reading;
}

/** The reconstruction loop over exactly what the portfolio was evaluated on; null when there is nothing to reconstruct. */
export async function reconstructionFor(model: { portfolio: GoalPortfolio | null; portfolioInput?: Parameters<typeof reconstructPlan>[0]['portfolio'] & { openings: Parameters<typeof reconstructPlan>[0]['openings'] } | null }, required: number): Promise<Reconstruction | null> {
  if (!model.portfolio || !model.portfolioInput || model.portfolioInput.openings.length === 0) return null;
  const { openings, ...portfolio } = model.portfolioInput;
  try {
    return await reconstructPlan({ openings, portfolio, baseline: model.portfolio, required });
  } catch (error) {
    console.warn(`reconstruction failed: ${String((error as Error)?.message ?? error)}`);
    return null;
  }
}

/** What the reconstruction asks the next discovery round, as a diagnosis the goal round already reads (§89). */
export function reconstructionDiagnosis(r: Reconstruction | null): ResearchDiagnosis[] {
  if (!r || !r.searchBrief) return [];
  const top = r.diagnosis[0];
  return [
    {
      cause: 'STRATEGY_RECONSTRUCTION',
      evidence: `the plan reaches ${(r.baseline.reach * 100).toFixed(1)}% as built and ${(r.best.reach * 100).toFixed(1)}% reconstructed (${r.best.basis.toLowerCase()})${top ? `; ${top.factor} binds` : ''}${r.structural ? '; the openings held cannot reach the requirement at their best' : ''}`,
      instruction: r.searchBrief,
    },
  ];
}

/**
 * Samples for a goal's run. Each evaluation's cost grows with the openings in the
 * model, so a portfolio of eight takes half the evaluations four took and the
 * plan read stays inside the tick's time (production 2026-11-02: 15 s at four,
 * 64 s at eight with the count unchanged).
 */
export function defaultEvaluations(openings: number): number {
  return Math.round(20_000 * Math.min(1, 4 / Math.max(1, openings)));
}

/** At most this many market tests are named at once: a test is a person's or a sender's time. */
export const MAX_MARKET_TESTS = 5;

function byIdOf(model: { considered: ModelledOpportunity[] }): Map<string, ModelledOpportunity> {
  return new Map(model.considered.map((one) => [one.opportunity.id, one]));
}

/** Openings a responsible offer can be made on: the buyer is reachable, the offer and price are on the card, the outlay fits. */
const SELLABLE: ReadonlySet<ValidationStage> = new Set(['C_MARKET_TEST_READY', 'D_BUYER_VALIDATED', 'E_COMMITTED']);

/**
 * What a SQUEEZE goal sells now (owner, 2026-11-06): every opening a
 * responsible offer can be made on, ranked by what it adds to the whole goal —
 * a member of the quant engine's best combination first, then the cash its
 * own demand settles before the deadline (p50), then its reach at the card's
 * price — and up to `MAX_CONCURRENT_SALES` at once, so the goal's calendar is
 * not spent on one small offer while larger ones wait. The step is an actual
 * offer for a sale, contract or deposit; what buyers answer is the demand and
 * price evidence. Pure but for reading the permission and the message channel.
 */
async function salesFor(
  considered: ConsideredOpening[],
  portfolio: GoalPortfolio | null,
  byId: Map<string, ModelledOpportunity>,
  target: TargetReading,
): Promise<MarketTest[]> {
  const best = new Set(portfolio?.best?.members.map((one) => one.opportunityId) ?? []);
  const settled = new Map((portfolio?.demand ?? []).map((one) => [one.opportunityId, one.refused ? -1 : one.revenue.p50]));
  const ranked = considered
    .filter((one) => SELLABLE.has(one.stage) && !isArrangementId(one.opportunityId) && byId.has(one.opportunityId))
    .sort(
      (a, b) =>
        Number(best.has(b.opportunityId)) - Number(best.has(a.opportunityId)) ||
        (settled.get(b.opportunityId) ?? 0) - (settled.get(a.opportunityId) ?? 0) ||
        (b.potentialReach ?? 0) - (a.potentialReach ?? 0),
    )
    .slice(0, MAX_CONCURRENT_SALES);
  const out: MarketTest[] = [];
  for (const one of ranked) {
    out.push({ opportunityId: one.opportunityId, title: one.title, potentialReach: one.potentialReach, test: await saleFor(byId.get(one.opportunityId)!, target, one.potentialReach) });
  }
  return out;
}

/**
 * The sale itself, and what stands between it and the buyer: the standing
 * permission to contact buyers and a connected message channel. A missing
 * permission is a blocker on this sale, never a reason to run a test first.
 * The goal's money limits bind the outlay through the PURSUES link.
 */
/**
 * A goal's next step. An owner's open decision about the goal itself (how much
 * may be committed) comes first. A sale Brain can send comes next. A sale that
 * waits for someone to authorize contacting its buyer is that sale's blocker,
 * listed with the sale, and never the goal's next step: owner, 2026-11-07,
 * "CONTACT_BUYER is a blocker to executing an individual sale, not a blocker
 * to constructing a viable $10K plan". The goal's step is then Brain's own
 * planning work — the missing evidence, or more and stronger openings.
 */
export function goalNextStep(input: {
  policy: string;
  verdict: PlanVerdict;
  chosen: NextTest | null;
  sales: NextTest[];
  marketTest: NextTest | null;
  bestReach: number | null;
  remaining: number;
  currency: string;
}): NextTest | null {
  const waitsOnSaleAuthorization = (step: NextTest | null): boolean => step !== null && step.by === 'PERSON' && step.link === 'CONVERSION';
  if (input.chosen && input.chosen.by === 'PERSON' && !waitsOnSaleAuthorization(input.chosen)) return input.chosen;
  if (input.policy === 'SQUEEZE') {
    const sendable = input.sales.find((one) => one.by === 'BRAIN');
    if (sendable) return sendable;
  }
  // A plan that reaches the target once buyers agree (NEEDS_EVIDENCE or better):
  // its sale is the deciding step, so it is the goal's step even while it waits
  // for authorization, and the step carries the sale's terms.
  if (input.chosen && (input.verdict !== 'NOT_VIABLE' || !waitsOnSaleAuthorization(input.chosen))) return input.chosen;
  if (input.marketTest && (input.verdict !== 'NOT_VIABLE' || !waitsOnSaleAuthorization(input.marketTest))) return input.marketTest;
  if (input.verdict === 'RECOMMENDABLE') return input.sales[0] ?? null;
  const reach = input.bestReach === null ? 'nothing yet' : `at most ${Math.round(input.bestReach)} ${input.currency}`;
  return {
    link: 'OFFER_AND_PRICE',
    test:
      `Discover, construct and research openings that can reach the ${Math.round(input.remaining)} ${input.currency} still needed — ` +
      `the openings held reach ${reach} — and establish each one's buyer, price, fulfilment, costs and settlement so the quant engine can combine them.`,
    by: 'BRAIN',
    blocker: null,
  };
}

/**
 * The terms a person authorizes when they let Brain contact this buyer: what is
 * sold, to whom, at what price, who fulfils it, the margin, when cash settles
 * and what it adds to the goal. Owner, 2026-11-07: "Before asking me for
 * authorization, show exactly what Brain intends to sell, to whom, at what
 * price, with what fulfillment arrangement, expected margin, collection timing,
 * and realistic contribution." An unknown is said to be unknown.
 */
export function saleTerms(one: ModelledOpportunity, target: Pick<TargetReading, 'remainingCents' | 'currency'>, reach: number | null): string {
  const o = one.opportunity;
  const cur = target.currency;
  const known = (input: { value: number | null }): number | null => (input.value !== null && Number.isFinite(input.value) ? input.value : null);
  const price = known(one.price);
  const cost = known(one.directCost);
  const days = known(one.daysToCash);
  const margin = price !== null && cost !== null ? `${Math.round(price - cost)} ${cur} a sale (${price > 0 ? Math.round(((price - cost) / price) * 100) : 0}%)` : 'not established (direct cost unknown)';
  return [
    `sells "${(o.offerScope ?? o.title).slice(0, 100)}"`,
    `to ${o.payer ?? 'a buyer not yet named'}`,
    `at ${price !== null ? `${price} ${cur}` : 'a price not yet established'}`,
    `fulfilled by ${one.fulfilledBy?.value ?? o.fulfillmentOwner ?? 'nobody named yet'}`,
    `margin ${margin}`,
    `cash ${days !== null ? `about ${Math.round(days)} day(s) after the sale` : 'timing not established'}`,
    `contributes up to ${reach !== null ? Math.round(reach) : '?'} of the ${Math.round(target.remainingCents / 100)} ${cur} still needed`,
  ].join('; ');
}

async function saleFor(one: ModelledOpportunity, target: TargetReading, reach: number | null = null): Promise<NextTest> {
  const title = one.opportunity.title.slice(0, 80);
  const price = one.opportunity.priceCents !== null ? `${one.opportunity.priceCents / 100} ${one.opportunity.currency}` : 'the card’s price';
  // The owner's spending rule, in its own words: a limit on money, not a stage before selling.
  const limit =
    target.capitalBeforeProofCents !== null && !target.proven
      ? ` Tie up no more than ${target.capitalBeforeProofCents / 100} ${target.currency} until money comes in.`
      : '';
  const test = `Sell "${title}": offer it to its reachable buyers at ${price} for an actual sale, contract or deposit. Each answer is a sale or a refusal, and is recorded as the demand and price evidence.${limit}`;
  const missing = await missingForSale(one, target);
  // A blocker on this one sale, stated with its terms — never a blanket request and never the goal's blocker (owner, 2026-11-07).
  const terms = `Terms: ${saleTerms(one, target, reach)}.`;
  if (missing.send.length > 0) {
    return { link: 'CONVERSION', test, by: missing.sendByPerson ? 'PERSON' : 'BRAIN', blocker: `This sale waits for authorization. ${terms} ${saleBlocker(missing)}` };
  }
  return { link: 'CONVERSION', test, by: 'BRAIN', blocker: missing.collect.length > 0 ? `${terms} ${saleBlocker(missing)}` : null };
}

/**
 * Every link between this sale and settled cash that is not in place, read at
 * once. Production, 2026-11-07: the plan's blocker read "Grant CONTACT_BUYER
 * … and Brain sends the offers" while the message provider was unconfigured
 * and no invoice or payment route existed, so the one grant it asked for would
 * have sent nothing and collected nothing. Naming one missing link at a time
 * turns one morning's decision into several.
 */
export async function missingForSale(one: ModelledOpportunity, target: TargetReading): Promise<{ send: string[]; collect: string[]; sendByPerson: boolean }> {
  const send: string[] = [];
  const collect: string[] = [];
  let sendByPerson = false;
  const granted = async (action: string) => (await checkCommercialAuthority({ projectId: target.projectId, action })).ok;
  const caps = new Map((await readCapabilities(['SEND_A_MESSAGE', 'ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT'])).map((cap) => [cap.id, cap.state]));
  if (!(await granted('CONTACT_BUYER'))) {
    send.push('a standing commercial authority granting CONTACT_BUYER (none exists for this project)');
    sendByPerson = true;
  }
  if (caps.get('SEND_A_MESSAGE') !== 'PRESENT') {
    send.push('the owner\'s Instantly workspace connected: BRAIN_MESSAGING_PROVIDER=instantly and INSTANTLY_API_KEY on the deployment');
    sendByPerson = true;
  }
  // The operator reaches only a READY piece, and READY is the card's gate, not this plan's tier.
  if (one.opportunity.state !== 'READY') {
    const card = evidenceCard(one.opportunity).readiness;
    if (!card.ready) send.push(`the card answered: ${card.missing.join(', ')} unknown, so the operator cannot mark it READY (Brain researches these)`);
  }
  const message = composeBuyerMessage(one.opportunity);
  if (!message.ok) send.push(`a sendable offer: ${message.reason} (Brain researches this)`);
  const withheld = [
    !(await granted('QUOTE_AND_INVOICE')) ? 'QUOTE_AND_INVOICE' : null,
    !(await granted('ACCEPT_PAYMENT')) ? 'ACCEPT_PAYMENT' : null,
  ].filter((one): one is string => one !== null);
  if (withheld.length > 0) collect.push(`the same authority granting ${withheld.join(' and ')}`);
  if (caps.get('ISSUE_AN_INVOICE') !== 'PRESENT' || caps.get('TAKE_A_PAYMENT') !== 'PRESENT') {
    collect.push('a billing provider: BRAIN_BILLING_PROVIDER=stripe and STRIPE_SECRET_KEY on the deployment');
  }
  return { send, collect, sendByPerson };
}

function saleBlocker(missing: { send: string[]; collect: string[] }): string {
  const parts: string[] = [];
  if (missing.send.length > 0) parts.push(`To send the offer Brain needs ${missing.send.join('; ')}.`);
  if (missing.collect.length > 0) parts.push(`To be paid it needs ${missing.collect.join('; ')}.`);
  return parts.join(' ');
}

/**
 * Link what a SQUEEZE goal sells as work it pursues, on every persisted read
 * and idempotently: the goal's money limits (`spending.ts`) bind work it
 * pursues, and the operator reaches pursued openings' buyers first. Before,
 * only a RECOMMENDABLE plan linked anything, and RECOMMENDABLE needed a
 * conversion rate measured from earlier sales — selling had to have happened
 * before the goal would pursue a sale.
 */
async function pursueSales(goal: Workstream, reading: PlanReading): Promise<void> {
  if (reading.executionPolicy !== 'SQUEEZE' || reading.sales.length === 0) return;
  const links = await listLinks(goal.id);
  for (const sale of reading.sales) {
    if (links.some((one) => one.kind === 'OPPORTUNITY' && one.ref === sale.opportunityId && one.relation === 'PURSUES')) continue;
    await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: sale.opportunityId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
    await recordWorkstreamEvent({
      workstreamId: goal.id,
      kind: 'GOAL_SALE_PURSUED',
      summary: `Selling "${sale.title.slice(0, 120)}" now: ${sale.test.blocker ? `waiting on ${sale.test.blocker.slice(0, 160)}` : 'Brain sends the offer'}.`.slice(0, 400),
      detail: { opportunityId: sale.opportunityId, potentialReach: sale.potentialReach, by: sale.test.by, blocker: sale.test.blocker },
      actorRef: 'BRAIN',
    });
  }
}

/**
 * The order in which the operator reaches READY openings' buyers for a
 * project: what its SQUEEZE goals sell, best contribution first, from the last
 * reading each goal took in this process. Empty when nothing has been read yet.
 */
export function salesOrderForProject(projectId: string): string[] {
  const out: string[] = [];
  for (const reading of lastReadings.values()) {
    if (reading.target.projectId !== projectId || reading.executionPolicy !== 'SQUEEZE') continue;
    for (const sale of reading.sales) if (!out.includes(sale.opportunityId)) out.push(sale.opportunityId);
  }
  return out;
}

const STAGES: ValidationStage[] = ['A_THEORETICAL', 'B_EVIDENCED', 'C_MARKET_TEST_READY', 'D_BUYER_VALIDATED', 'E_COMMITTED', 'F_COLLECTED'];

function emptyLadder(): Record<ValidationStage, number> {
  return Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<ValidationStage, number>;
}

function ladderOf(considered: ConsideredOpening[]): Record<ValidationStage, number> {
  const out = emptyLadder();
  for (const one of considered) out[one.stage] += 1;
  return out;
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

/**
 * What a reading says about progress toward the goal, rounded so noise in the
 * simulation does not write a row: the best combination's share of worlds that
 * reach the target (against the 90% the owner requires), its median settled,
 * the openings considered and modelled, the ladder, and the research causes.
 */
export function planProgress(reading: PlanReading): {
  reach: number | null;
  settledP50: number | null;
  bestReach: number | null;
  considered: number;
  modelled: number;
  evidencedBuyerAndPrice: number;
  ladder: Record<ValidationStage, number>;
  causes: string[];
  /** The reasoning loop's measures (§93), rounded so noise writes no row. */
  pathways: { pathways: number; executable: number; proceed: number; reachable: number; constructionMoves: number; variants: number; leadingNetP50: number; proven: number; estimated: number; unknown: number } | null;
} {
  const best = reading.portfolio?.best ?? null;
  const m = reading.pathways?.measures ?? null;
  return {
    reach: best ? Math.round(best.reach * 100) / 100 : null,
    settledP50: best ? Math.round(best.settledP50 / 50) * 50 : null,
    bestReach: reading.bestReach === null ? null : Math.round(reading.bestReach / 50) * 50,
    considered: reading.considered.length,
    modelled: reading.considered.filter((one) => one.modelled).length,
    evidencedBuyerAndPrice: reading.considered.filter((one) => !one.missing.some((link) => link === 'REACHABLE_BUYER' || link === 'CURRENT_DEMAND' || link === 'OFFER_AND_PRICE')).length,
    ladder: reading.ladder,
    causes: reading.researchDiagnosis.map((one) => one.cause),
    pathways: m
      ? {
          pathways: m.pathways,
          executable: m.executable,
          proceed: m.proceedWithoutEngineering,
          reachable: m.withReachableBuyer,
          constructionMoves: m.constructionMoves,
          variants: m.variants,
          leadingNetP50: Math.round(m.leadingNetP50 / 50) * 50,
          proven: m.facts.proven,
          estimated: m.facts.estimated,
          unknown: m.facts.unknown,
        }
      : null,
  };
}

/** Append a reading when its conclusion differs from the last; link a recommended plan's work to the goal. */
/** The reconstruction's conclusion, small enough to be part of a stored reading. */
export function reconstructionSummary(r: Reconstruction | null): Record<string, unknown> | null {
  if (!r) return null;
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    baseline: round3(r.baseline.reach),
    best: { key: r.best.key, reach: round3(r.best.reach), basis: r.best.basis, settledP50: Math.round(r.best.settledP50), committed: r.best.committed },
    floor: r.floor ? round3(r.floor.reach) : null,
    requiredReply: r.requiredReply === null ? null : round3(r.requiredReply * 100) / 100,
    binding: r.diagnosis[0]?.factor ?? null,
    structural: r.structural,
    variants: r.rounds.reduce((n, x) => n + x.tried.length, 0),
  };
}

async function persistReading(goal: Workstream, reading: PlanReading, chosen: StrategyReading | null): Promise<void> {
  const summary = {
    verdict: reading.verdict,
    chosen: reading.chosen,
    strategies: reading.strategies.map((one) => ({ key: one.key, verdict: one.verdict, missing: one.links.filter((link) => !link.ok).map((link) => link.link), failed: one.constraintsFailed })),
    next: reading.nextTest,
    refusal: reading.refusal,
    // Progress toward the goal is part of the conclusion: a reading whose
    // combined reach, median or pool moved is a new row, so the plan's history
    // shows whether research is improving it (owner, 2026-11-05).
    progress: planProgress(reading),
    sales: reading.sales.map((one) => one.opportunityId),
    acceptance: { status: reading.acceptance.status, basis: reading.acceptance.probability?.basis ?? null, candidate: reading.acceptance.candidate?.opportunityIds ?? [] },
    // What the reconstruction found and kept (§99): a strategy that changed is a new row.
    reconstruction: reconstructionSummary(reading.reconstruction ?? null),
  };
  const digest = sha256(canonicalJson(summary));
  const last = await latestReading(goal.id);
  if (last && last.digest === digest) return;
  const forecast = {
    ...(chosen ? { conservativeSettled: chosen.conservativeSettled, sweep: chosen.sweep } : {}),
    acceptance: reading.acceptance,
    remainingCents: reading.target.remainingCents,
    daysLeft: reading.target.daysLeft,
    ...planProgress(reading),
    reconstruction: reconstructionSummary(reading.reconstruction ?? null),
  };
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
      JSON.stringify(forecast),
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
  // A qualified candidate is pursued too: it is the strongest provisional plan, sold and improved while
  // nothing is accepted (owner, 2026-11-09). Only the verdict says whether it meets the objective.
  const pursued = reading.acceptance.accepted?.opportunityIds.length ? reading.acceptance.accepted.opportunityIds : chosen?.chainComplete ? chosen.opportunityIds : [];
  if (pursued.length > 0) {
    const links = await listLinks(goal.id);
    for (const opportunityId of pursued) {
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

/**
 * A plan is re-read as soon as what it is composed from changes, not on the
 * next half-hour (owner's order, 2026-11-05: "as soon as new evidence arrives,
 * update the affected opportunity, recalculate its economics, update the
 * combined plan"). Production read a harvested opening reaching its goal's plan
 * a median of a quarter of an hour later, with the scenario slot idle meanwhile.
 * The half-hour stays the backstop for what only the clock changes (days left).
 * The floor bounds a burst of harvests to one scenario run every two minutes.
 */
export const PLAN_EVIDENCE_FLOOR_MS = 2 * 60_000;
const lastInputs = new Map<string, string>();

/**
 * What a goal's plan is composed from, as one cheap reading: the project's
 * openings (a harvest creates one; validation, pricing and reconsideration
 * update one), their value layers, the money ledger and the goal's own terms.
 */
export async function planInputsFingerprint(projectId: string, goalId: string): Promise<string> {
  const row = await getDb().get<{ o: number | string; ou: string | null; oc: string | null; v: number | string; vu: string | null; m: number | string; g: string | null }>(
    `SELECT (SELECT COUNT(*) FROM cash_opportunities WHERE project_id = ?) AS o,
            (SELECT MAX(updated_at) FROM cash_opportunities WHERE project_id = ?) AS ou,
            (SELECT MAX(created_at) FROM cash_opportunities WHERE project_id = ?) AS oc,
            (SELECT COUNT(*) FROM cash_value_layers WHERE project_id = ?) AS v,
            (SELECT MAX(updated_at) FROM cash_value_layers WHERE project_id = ?) AS vu,
            (SELECT COUNT(*) FROM cash_money_entries WHERE project_id = ?) AS m,
            (SELECT updated_at FROM workstreams WHERE id = ?) AS g`,
    [projectId, projectId, projectId, projectId, projectId, projectId, goalId],
  );
  return [row?.o, row?.ou, row?.oc, row?.v, row?.vu, row?.m, row?.g].map((one) => String(one ?? '')).join('|');
}

/**
 * Whether a goal's plan is due now. Pure. Never read: due. Past the half-hour:
 * due. Inside it: due once the floor has passed and the inputs differ from the
 * ones the last reading was taken over (unknown after a restart counts as
 * different, which costs one early read).
 */
export function planDue(input: { now: number; since: number; inputs: string | null; lastInputs: string | undefined }): 'FIRST' | 'REFRESH' | 'EVIDENCE' | null {
  if (!input.since) return 'FIRST';
  const age = input.now - input.since;
  if (age >= PLAN_REFRESH_MS) return 'REFRESH';
  if (age >= PLAN_EVIDENCE_FLOOR_MS && input.inputs !== null && input.inputs !== input.lastInputs) return 'EVIDENCE';
  return null;
}

/**
 * Goals a repair has just unblocked: their next pass reads the plan and widens
 * the search at once, instead of waiting out the half-hour refresh. Set by the
 * improvement loop when a goal's capability check clears a gap (§88), so a
 * released repair resumes the goal on the next tick with nobody asking.
 */
const repairedGoals = new Map<string, string>();

export function requestGoalPlanPass(goalId: string, why: string): void {
  repairedGoals.set(goalId, why);
}

/** Tests. */
export function forgetGoalReadings(): void {
  lastArrangements.clear();
  lastReadings.clear();
  lastTopUp.clear();
  lastInputs.clear();
  repairedGoals.clear();
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
  // A transaction constructed from a held opening's own evidence comes first (§93): it is the nearest to a sale.
  const fromPathways = await askPathwayConstructions(goal, reading, now, MAX_LIVE_GOAL_ROUNDS + spare);
  const constructed = [...fromPathways, ...(await askConstructedArrangements(goal, reading, now, Math.max(1, Math.ceil(attempts / 2)), MAX_LIVE_GOAL_ROUNDS + spare))];
  for (const candidateId of constructed) {
    await linkWorkstream({ workstreamId: goal.id, kind: 'CANDIDATE', ref: candidateId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
  }
  for (let i = 0; i < attempts; i += 1) {
    const opened = await openGoalDiscovery({
      goal,
      target: reading.target,
      bestReach: reading.bestReach,
      heldTitles: reading.considered.map((one) => one.title),
      // The quantity shapes the search (§93): the shape of transaction the gap needs, then why research fell short.
      diagnosis: [reading.pathways?.structures.searchBrief ?? '', diagnosisInstructions(reading.researchDiagnosis)].filter(Boolean).join(' '),
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

/** At most this many pathway constructions open a round per pass; they share construction's half of the live cap. */
export const PATHWAY_CONSTRUCTIONS_PER_PASS = 1;
export const PATHWAY_KEY_PREFIX = 'pw';
/** A turn lost with room to spare is recorded at most this often per goal, so a stuck state is one row, not one per pass. */
export const PATHWAY_NOT_ASKED_EVERY_MS = 6 * 60 * 60 * 1000;
const pathwayNotAsked = new Map<string, number>();

/**
 * Whether a pathway construction goes before the constructed arrangements this
 * pass: they take turns inside construction's half of the goal's live cap
 * (§82), so neither starves the other and the world-search lenses keep their
 * share. The arrangements go first on a goal that has asked neither. Pure.
 */
export function pathwayTurn(rounds: readonly { bucketId: string; openedAt: string }[], goalId: string): boolean {
  const mx = rounds.filter((r) => r.bucketId.startsWith(`goal-${goalId}-mx-`)).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  if (mx.length === 0) return false;
  return !mx[0]!.bucketId.startsWith(`goal-${goalId}-mx-${PATHWAY_KEY_PREFIX}`);
}

/** The constructed round's stable key for one pathway's move: `pw` + a hash of the opening and the gap. */
export function pathwayRoundKey(opportunityId: string, gap: string): string {
  return `${PATHWAY_KEY_PREFIX}${sha256(`${opportunityId}:${gap}`).slice(0, 10)}`;
}

/**
 * Ask the world about a transaction the reasoning loop constructed from a held
 * opening's own evidence (§93): the buyers of a supplier's published price, the
 * population of buyers like a single one, a role with a margin. It goes through
 * the constructed round's door (§81) — the gate, the frame, the harvest and the
 * live cap — so what comes back is an ordinary opening judged like any other.
 */
export async function askPathwayConstructions(
  goal: Workstream,
  reading: PlanReading,
  now: Date,
  liveCap: number,
  /** Why each step decided what it did, for the operator readout; with `dryRun`, nothing is opened. */
  trace?: string[],
  dryRun = false,
): Promise<string[]> {
  const note = (line: string) => trace?.push(line);
  const t = reading.target;
  if (!reading.pathways || t.daysLeft === null || t.daysLeft <= 0 || t.remainingCents <= 0) {
    note('no pathways, or the goal has no time or nothing left to raise');
    return [];
  }
  const rounds = await listRounds(t.projectId);
  if (!pathwayTurn(rounds, goal.id)) {
    note('not its turn: the latest constructed round was a pathway construction, so an arrangement goes next');
    return [];
  }
  // Construction's half of the live cap, shared with the arrangements (§82).
  const openMx = rounds.filter((r) => r.state === 'OPEN' && r.bucketId.startsWith(`goal-${goal.id}-mx-`));
  const researching = await roundsStillResearching(openMx);
  const room = Math.max(1, Math.floor(liveCap / 2)) - researching;
  if (room <= 0) {
    note(`its turn, but construction's share of the live cap is full: ${researching} constructed round(s) researching against ${Math.max(1, Math.floor(liveCap / 2))}`);
    return [];
  }
  const exclusions = await goalExclusions(goal);
  const opened: string[] = [];
  const byId = new Map(reading.pathways.pathways.map((p) => [p.opportunityId, p]));
  for (const action of reading.pathways.nextActions) {
    if (opened.length >= PATHWAY_CONSTRUCTIONS_PER_PASS) break;
    if (action.action !== 'CONSTRUCT' || !action.ask || isArrangementId(action.opportunityId)) continue;
    const pathway = byId.get(action.opportunityId);
    const move = pathway?.moves.find((one) => one.action === 'CONSTRUCT' && one.ask === action.ask);
    if (!pathway || !move) continue;
    const key = pathwayRoundKey(pathway.opportunityId, move.gap);
    if (dryRun) {
      note(`would ask mx-${key}: ${move.construct.slice(0, 100)} (from "${pathway.title.slice(0, 60)}")`);
      opened.push(key);
      continue;
    }
    const question =
      `Brain constructed a transaction from evidence it already holds: ${move.construct}. ${move.ask} ` +
      (move.mustHit ? `For it to matter to the goal: ${move.mustHit}. ` : '') +
      `${exclusionSentence(exclusions)} ` +
      OPENING_SENTENCE +
      'Where no source shows buyers pay for this, say so plainly — that refutes the construction and is a useful answer.';
    const round = await openConstructedRound({
      goal,
      projectId: t.projectId,
      key,
      title: `Constructed from "${pathway.title.slice(0, 60)}": ${move.construct.slice(0, 80)}`,
      question,
      now: now.toISOString(),
      liveCap,
    });
    if (round) {
      opened.push(round.candidateId);
      note(`asked mx-${key}: ${move.construct.slice(0, 100)}`);
    } else note(`mx-${key} not opened (its cool-off, the live cap, the focus cap or a closed discovery gate)`);
  }
  if (opened.length === 0) {
    note('no constructed move on a found opening could be asked this pass');
    // Its turn and room, and still nothing opened: a row says why, so a lost turn is read, not guessed (§93).
    if (!dryRun && trace === undefined && now.getTime() - (pathwayNotAsked.get(goal.id) ?? 0) >= PATHWAY_NOT_ASKED_EVERY_MS) {
      pathwayNotAsked.set(goal.id, now.getTime());
      await recordWorkstreamEvent({
        workstreamId: goal.id,
        kind: 'GOAL_PATHWAY_NOT_ASKED',
        summary: `It was a pathway construction's turn with room for ${room}, and none of ${reading.pathways.nextActions.filter((a) => a.action === 'CONSTRUCT').length} constructed move(s) could be asked.`.slice(0, 400),
        detail: { room, researching, liveCap },
        actorRef: 'BRAIN',
      });
    }
  }
  return opened;
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

/**
 * Which constructed arrangements to try asking, in order (§83).
 *
 * Ranking favours the best-evidenced parts, and the industry map held one
 * buyer population, so every round Brain opened was a variant of that one
 * buyer (production, 2026-11-01: nine OPEN rounds, all the same anime
 * production committee, every reverse design waiting behind them). So:
 *
 *   - a buyer population with a round already open is not asked again until
 *     that round settles — its variants are one question, not several;
 *   - a reverse-constructed design comes first when none is open, because it
 *     needs no buyer on the map and is the only search a sparse map cannot
 *     starve;
 *   - then a base structure not already open before one that is, so a pass
 *     reaches different transaction shapes rather than the same one re-dressed.
 *
 * Within each, the constructor's own rank (which reads the goal's targets and
 * worst-case exposure) decides. Pure, so the order is testable without rows.
 */
export function constructedOrder<T extends { key: string; origin: string; structure: string; demand: { ref: string } }>(
  ranked: readonly T[],
  openKeys: readonly string[],
): T[] {
  const open = new Set(openKeys);
  const openOnes = ranked.filter((one) => open.has(one.key));
  const busyDemand = new Set(openOnes.map((one) => one.demand.ref));
  const busyStructure = new Set(openOnes.map((one) => one.structure));
  const reverseOpen = openOnes.some((one) => one.origin === 'REVERSE');
  const free = ranked.filter((one) => !open.has(one.key) && !busyDemand.has(one.demand.ref));
  const out: T[] = [];
  const take = (one: T | undefined) => {
    if (one && !out.includes(one)) out.push(one);
  };
  if (!reverseOpen) take(free.find((one) => one.origin === 'REVERSE'));
  for (const one of free) if (!busyStructure.has(one.structure)) take(one);
  for (const one of free) take(one);
  return out;
}

/**
 * The constructor's ranking, re-ordered so a buyer population every earlier
 * round of this goal already asked about comes after one never asked (§83).
 *
 * `constructedOrder` spreads across *open* rounds only, so once those settle
 * the next pass starts from the same best-evidenced buyers again. Production,
 * 2026-11-02: all nine of the goal's constructed rounds had closed, every one
 * an anime production committee variant, and the next sixteen ranked designs
 * were the same buyers. Counting every round asked keeps a variant of a
 * researched population behind a population never asked. A design whose worst
 * case is SAFE stays ahead of one that might lose money, and the constructor's
 * own rank breaks every tie. Lexicographic, never a score.
 */
export function byLeastAsked<T extends { key: string; structure: string; demand: { ref: string }; stress?: { exposure: string } }>(
  ranked: readonly T[],
  rounds: readonly { bucketId: string }[],
): T[] {
  const asked = new Map<string, number>();
  for (const r of rounds) {
    const key = r.bucketId.slice(r.bucketId.lastIndexOf('-mx-') + 4);
    asked.set(key, (asked.get(key) ?? 0) + 1);
  }
  const byDemand = new Map<string, number>();
  const byStructure = new Map<string, number>();
  for (const one of ranked) {
    const n = asked.get(one.key) ?? 0;
    if (n === 0) continue;
    byDemand.set(one.demand.ref, (byDemand.get(one.demand.ref) ?? 0) + n);
    byStructure.set(one.structure, (byStructure.get(one.structure) ?? 0) + n);
  }
  return ranked
    .map((one, index) => ({ one, index }))
    .sort(
      (a, b) =>
        Number(a.one.stress?.exposure !== 'SAFE') - Number(b.one.stress?.exposure !== 'SAFE') ||
        (byDemand.get(a.one.demand.ref) ?? 0) - (byDemand.get(b.one.demand.ref) ?? 0) ||
        (byStructure.get(a.one.structure) ?? 0) - (byStructure.get(b.one.structure) ?? 0) ||
        a.index - b.index,
    )
    .map(({ one }) => one);
}

/** Open rounds for the best-ranked arrangements Brain constructed, at most `max` this pass. */
/** The last construction per goal, so one goal pass composes its arrangements once for the plan and the search. */
const lastArrangements = new Map<string, { at: number; arrangements: ConstructedArrangement[] }>();
const ARRANGEMENTS_FRESH_MS = 10 * 60_000;

/** The goal's constructed arrangements, composed at most once per ten minutes. */
export async function goalArrangements(goal: Workstream, target: TargetReading, now: Date, bestReachCents: number | null = null): Promise<ConstructedArrangement[]> {
  if (target.daysLeft === null || target.daysLeft <= 0 || target.remainingCents <= 0) return [];
  const held = lastArrangements.get(goal.id);
  if (held && now.getTime() - held.at >= 0 && now.getTime() - held.at < ARRANGEMENTS_FRESH_MS) return held.arrangements;
  const frame = await executionFrame(target.projectId, target.currency);
  const arrangements = await constructArrangements({
    projectId: target.projectId,
    currency: target.currency,
    delivers: frame?.delivers ?? [],
    capitalCeilingCents: target.capitalCeilingCents,
    daysLeft: target.daysLeft,
    limits: { daysLeft: target.daysLeft, remainingCents: target.remainingCents, capitalCeilingCents: target.capitalCeilingCents, capitalBeforeProofCents: target.capitalBeforeProofCents, bestReachCents },
    exclusions: await goalExclusions(goal),
    now,
  });
  lastArrangements.set(goal.id, { at: now.getTime(), arrangements });
  return arrangements;
}

/**
 * What each estimated arrangement contributes to the goal in the last model:
 * a member of the best combination first, then its settled cash p50. The
 * research that asks the world about an arrangement goes to the ones that
 * would move the whole goal most, not to whichever was asked least.
 */
export function arrangementContribution(reading: Pick<PlanReading, 'portfolio'>): Map<string, number> {
  const out = new Map<string, number>();
  const best = new Set(reading.portfolio?.best?.members.map((one) => one.opportunityId) ?? []);
  for (const one of reading.portfolio?.demand ?? []) {
    if (!isArrangementId(one.opportunityId)) continue;
    const key = one.opportunityId.slice(ARRANGEMENT_ID_PREFIX.length);
    out.set(key, (best.has(one.opportunityId) ? 1e9 : 0) + (one.refused ? 0 : one.revenue.p50));
  }
  return out;
}

export async function askConstructedArrangements(goal: Workstream, reading: PlanReading, now: Date, max: number, liveCap: number): Promise<string[]> {
  const t = reading.target;
  if (t.daysLeft === null || t.daysLeft <= 0 || t.remainingCents <= 0) return [];
  const arrangements = (await goalArrangements(goal, t, now, goalLimits(reading).bestReachCents))
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
  const room = Math.max(1, Math.floor(liveCap / 2)) - (await roundsStillResearching(openMx));
  if (room <= 0) return [];
  max = Math.min(max, room);
  const askedBefore = (await listRounds(t.projectId)).filter((r) => r.bucketId.startsWith(`goal-${goal.id}-mx-`));
  // What each would contribute to the whole goal in the last model leads; the least-asked order breaks ties.
  const contribution = arrangementContribution(reading);
  const byContribution = [...byLeastAsked(arrangements, askedBefore)]
    .map((one, at) => ({ one, at }))
    .sort((a, b) => (contribution.get(b.one.key) ?? -1) - (contribution.get(a.one.key) ?? -1) || a.at - b.at)
    .map(({ one }) => one);
  const order = constructedOrder(byContribution, openMx.map((r) => r.bucketId.slice(r.bucketId.lastIndexOf('-mx-') + 4)));
  const thisPass = new Set<string>();
  for (const one of order) {
    if (opened.length >= max) break;
    // One buyer population per pass: a population that opened a round this pass waits for the next.
    if (thisPass.has(one.demand.ref)) continue;
    const round = await openConstructedRound({ goal, projectId: t.projectId, key: one.key, title: `Constructed: ${one.label}`, question: one.question, now: now.toISOString(), liveCap });
    // Null is this arrangement's cool-off, the live cap or a closed gate: the next one is tried.
    if (round) {
      opened.push(round.candidateId);
      thisPass.add(one.demand.ref);
    }
  }
  return opened;
}

export async function advanceGoalPlans(now: Date = new Date()): Promise<{ read: number; outcomes: number; asked: number; constructed: number; researched: number; busy: boolean; onEvidence: number; resumed: number }> {
  const goals = await getDb().all<{ id: string; target_project_id: string | null }>(
    `SELECT id, target_project_id FROM workstreams WHERE target_metric IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL`,
  );
  let read = 0;
  let outcomes = 0;
  let asked = 0;
  let constructed = 0;
  let researched = 0;
  let busy = false;
  let onEvidence = 0;
  let resumed = 0;
  for (const { id, target_project_id: projectId } of goals) {
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
    const fingerprint = async (): Promise<string | null> => (projectId ? planInputsFingerprint(projectId, id) : null);
    const inputs = since && now.getTime() - since >= PLAN_EVIDENCE_FLOOR_MS && now.getTime() - since < PLAN_REFRESH_MS ? await fingerprint() : null;
    const repaired = repairedGoals.get(id);
    const due = busy ? null : repaired !== undefined ? 'REPAIRED' : planDue({ now: now.getTime(), since, inputs, lastInputs: lastInputs.get(id) });
    if (!due) {
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
      if (due === 'EVIDENCE') onEvidence += 1;
      if (due === 'REPAIRED') {
        repairedGoals.delete(id);
        resumed += 1;
        await recordWorkstreamEvent({
          workstreamId: id,
          kind: 'GOAL_RESUMED_AFTER_REPAIR',
          summary: `The capability check cleared ${repaired}; the plan was read at once (${reading?.verdict ?? 'no reading'}).`.slice(0, 400),
          detail: { cleared: repaired, verdict: reading?.verdict ?? null, needsMoreOpenings: reading?.needsMoreOpenings ?? null },
          actorRef: 'BRAIN',
        });
      }
    } catch (error) {
      // The process's one scenario slot is taken: this goal waits for the next
      // pass, and every other goal still records outcomes and tops up its search.
      if (error instanceof ScenarioBusyError) {
        busy = true;
        continue;
      }
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
    // Taken after this pass's own writes (the research it started on openings
    // touches their rows), so only what arrives from elsewhere reads as new.
    const after = await fingerprint();
    if (after !== null) lastInputs.set(id, after);
  }
  return { read, outcomes, asked, constructed, researched, busy, onEvidence, resumed };
}
