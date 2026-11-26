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
import { notePlanEffects } from '../knowledge/apply.ts';
import { getDb } from '../../db/database.ts';
import { newId } from '../../repos/util.ts';
import { getWorkstream, linkWorkstream, listLinks, recordWorkstreamEvent, supersedeLink, workstreamEventsOfKind } from '../../repos/register.ts';
import { goalRoutePrefix, isRouteOpening, ROUTE_RANK_FIELD, routeRankOf } from '../../domain/routeOrigin.ts';
import { liveOpeningsWithRecordPrefix, opportunitiesWithRecordPrefix } from '../../repos/cashPortfolio.ts';
import { cardFact } from '../../repos/cashCardFacts.ts';
import { readCapabilities } from '../cash/capabilities.ts';
import { recordPathwayAsk } from '../cash/answers.ts';
// A plan is a reading: it asks whether an action is granted and performs none, so
// every check here passes { record: false } — no AUTHORITY_DECISION row and no
// approval request is written by a plan pass (AUTH-34: did versus proposed).
import { checkCommercialAuthority } from '../cash/authority.ts';

/*
 * A plan read asks whether an action is authorized once per opening, and the
 * answer is the project's grant, not the opening's: asked unmemoised it read
 * the authority rows several times per opening (40 openings, 272 statements
 * against a guard of 140). The read records nothing (`record: false`) and is a
 * view, so one answer per project and action is shared for a few seconds — a
 * read, never a decision an action could act on.
 */
const PLAN_AUTHORITY_MEMO_MS = 10_000;
const planAuthorityMemo = new Map<string, { at: number; decision: ReturnType<typeof checkCommercialAuthority> }>();
function planAuthority(projectId: string, action: string): ReturnType<typeof checkCommercialAuthority> {
  const key = `${projectId}\u0000${action}`;
  /*
   * Inside a plan read the answer is the read's own, for the whole read: a
   * wall-clock memo expired part way through any read slower than ten seconds
   * and re-read the authority rows, so the statement count of one read moved
   * with machine load (goalPlan.test.ts read 139 calm and 171 on a loaded
   * runner, failing Deploy 45037618129; production reads take minutes).
   */
  if (inReadScope()) return scopedRead(`planAuthority\u0000${key}`, () => checkCommercialAuthority({ projectId, action }, { record: false }));
  const now = Date.now();
  const held = planAuthorityMemo.get(key);
  if (held && now - held.at < PLAN_AUTHORITY_MEMO_MS) return held.decision;
  const decision = checkCommercialAuthority({ projectId, action }, { record: false });
  planAuthorityMemo.set(key, { at: now, decision });
  decision.catch(() => planAuthorityMemo.delete(key));
  return decision;
}
import { composeBuyerMessage } from '../cash/outreach.ts';
import { evidenceCard } from '../cash/card.ts';
import { agreedToward, costedDeals, costPerDeal, countsNet, perDealToward } from '../cash/towardTarget.ts';
import { ARRANGEMENT_ID_PREFIX, isArrangementId, bestCaseReach, buyersLeft, composeGoalModel, estimatedFromArrangement, inventedDesigner, planTrace, dealsForGoal, dealsFromOffers, measuredClose, priceSupported, volumeEstablished, wilson, type ModelInput, type ModelledOpportunity, type PriceVariable } from '../cash/goalScenario.ts';
import { cachedCashKnowledge } from '../quant/knowledge.ts';
import { achievedFrom, readTarget, type TargetReading } from './target.ts';
import { constructedShare, executionFrame, MAX_LIVE_GOAL_ROUNDS, openConstructedRound, openGoalDiscovery, roundsStillResearching, staleUnlaunchedRounds } from '../cash/discovery.ts';
import { constructArrangements, lastConstructionReport, nextInputQuestion, type ConstructedArrangement } from '../cash/construct.ts';
import { arrangementReachCost, arrangementSteps, COLLECTION_COST, fulfilmentStep, modelledCashSpan, openingMembers, openingSteps, type ArrangementStepContext, type OpeningChainMember } from './arrangementSteps.ts';
import { arrangementKeyOfBucket, recordReadingEvaluations, refutedUnderSameInputs, rememberArrangements } from '../cash/arrangementLibrary.ts';
import { arrangementVerdicts } from '../../repos/monetization.ts';
import { exclusionSentence, goalExclusions } from '../cash/exclusions.ts';
import { OPENING_SENTENCE } from '../cash/construct.ts';
import { listRounds } from '../../repos/cashDiscovery.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { exemptSales, recordMateriality } from './materiality.ts';
import { inReadScope, scopedRead, withReadScope } from '../../repos/readScope.ts';
import { cashSpareSurfaces } from '../cash/researchRoom.ts';
import { researchGoalPaths } from './pathResearch.ts';
import { remediesInForce, remedyInstructions } from './researchAllocation.ts';
import { compileModel, canonicalJson, sha256 } from '../scenario/model.ts';
import { getScenarioModel } from '../../repos/scenario.ts';
import { runModel, saveModel } from '../scenario/service.ts';
import { runIsolated, ScenarioBusyError } from '../scenario/isolate.ts';
import { ScenarioRunError } from '../scenario/engine.ts';
import type { ScenarioResult } from '../../domain/scenario.ts';
import type { Workstream } from '../../domain/register.ts';
import { decideResearch, type ResearchDecision } from '../quant/deadline.ts';
import { goalExecutionPolicy, MAX_CONCURRENT_SALES, type GoalExecutionPolicy } from '../../domain/goalPolicy.ts';
import { heldEvaluation, inputEvidence, type GoalPortfolio, type InputEvidence, type PortfolioCombination, type UnpricedPopulation } from './portfolio.ts';
import { sendCommitteeNeeds, sendPlanQuestions, sendPortfolioNeeds } from './portfolioNeeds.ts';
import { diagnoseGoalResearch, diagnosisInstructions, recentGoalRounds, type ResearchDiagnosis } from './researchYield.ts';
import type { EvidenceTier } from '../../domain/quant.ts';
import { namesABuyerPopulation } from '../../domain/industry.ts';
import { LEG_LABEL, legFeasibility, readPathways, requiredStructures, type BrainCapabilities, type GoalStructures, type LegFeasibility, type PathwayReading, type TransactionPathway } from './pathways.ts';
import { MATERIAL_P50, MATERIAL_REACH, reconstructPlan, type Factor, type Reconstruction, type StrategyChange, type VariantReading } from './reconstruction.ts';
import { recordEvent } from '../../repos/events.ts';
import { sharedEvaluator } from './reasoning/evaluatorPool.ts';
import { inventDirections, inventEnabled } from './reasoning/invent.ts';
import { assumedMovesOf, scopeWords, type ExploreContext, type Scope } from './reasoning/directions.ts';
import { loadLibrary, loadStancePrior, recordExploration } from './reasoning/learning.ts';
import { implementedFormats } from '../puzzle/formats/index.ts';
import { readTimelines, type TimelineReading } from './timelines.ts';
import { changeTitle } from './stepTitle.ts';
import { internalKeyIn, planIntegrity, type ArrangementStage, type PlanIntegrityViolation, type StepCostSource, type UnscheduledReason } from '../../domain/planIntegrity.ts';
import { integrityInput, leadIdsOf, leadOf, type PlanLead } from './planIntegrityInput.ts';
import { committeeOf, type CommitteeContext, type CommitteeReading } from './committee.ts';
import { armSpecialistReview, committeeContextOf } from './committeeSpecialists.ts';
import { armRouteProposal } from './routeProposal.ts';
import { readCapabilityInventory, stepExecutor, type CapabilityInventory, type OperationRequest, type StepExecutor, type StepOperation } from './stepExecutor.ts';
import { goalObjective, readOutcome, tradeOffs, type EnforceableCommitment, type GoalObjective, type OutcomeReading, type PlanTradeOff } from './objective.ts';
import { buildPlanSet, calibrationFor, candidateFromArrangement, candidateFromPathway, candidateFromStrategy, rebuildAfter, type AcceptanceCondition, type Calibration, type PlanCandidate, type PlanChange, type PlanSet, type Rebuild } from './planSet.ts';
import { blockerResolutions, type Resolution } from './resolution.ts';
import { effectiveDueAtOfRow } from '../../domain/executionWindow.ts';

export const PLAN_VERDICTS = ['RECOMMENDABLE', 'NEEDS_EVIDENCE', 'NOT_VIABLE'] as const;
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

/** The links of a cash plan's causal chain, in the order they are checked. */
export const CHAIN_LINKS = ['REACHABLE_BUYER', 'CURRENT_DEMAND', 'OFFER_AND_PRICE', 'CONVERSION', 'MARKET_VOLUME', 'FULFILMENT', 'ECONOMICS', 'SETTLES_IN_TIME'] as const;
export type ChainLink = (typeof CHAIN_LINKS)[number];

export const CHAIN_LABEL: Record<ChainLink, string> = {
  REACHABLE_BUYER: 'a buyer we can actually reach',
  CURRENT_DEMAND: 'a dated sign they need it now',
  OFFER_AND_PRICE: 'an offer and a price',
  CONVERSION: 'buyers who have actually agreed to it, or a sized measure of how many agree',
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
  /**
   * What the reading rests on, in one line: found openings at prices buyers are
   * shown to pay, or the adopted candidate on the inputs it assumes (P5).
   */
  basis?: string;
  /** The constructed arrangements among its members (`arr_…`): estimates, never openings, so never in `opportunityIds`. */
  arrangementIds?: string[];
  /**
   * The deals the strategy counts on each member, agreed ones included (`dealsTaken`) — the
   * planner's own needed-deal count, so a reader can check it against the target's metric.
   */
  dealsTaken?: { opportunityId: string; deals: number }[];
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
  /**
   * NOT_SUPPORTED — the goal as stated is arithmetically out of reach: the
   * openings held cannot reach it at their most favourable, and no transaction
   * structure the goal's own figures allow could carry it (`judgeFeasibility`).
   * Never read from a mere lack of found openings (§65).
   */
  status: 'ACCEPTED' | 'CANDIDATE_ONLY' | 'NO_CANDIDATE' | 'NOT_SUPPORTED';
  required: number;
  /** Only a defensible probability: the ledger, an all-evidence Monte Carlo, or this Brain's own record. */
  probability: { value: number; lowerBound: number; basis: 'TARGET_MET' | 'EVIDENCED_PORTFOLIO' | 'MEASURED_RECORD'; sample: number; note: string } | null;
  /** The plan that meets the objective, when one does. */
  accepted: { label: string; opportunityIds: string[] } | null;
  /** The strongest provisional plan, kept and improved while nothing is accepted. */
  candidate: {
    label: string;
    opportunityIds: string[];
    /** RECONSTRUCTED — the reconstruction's strongest plan (§99), adopted because it beats the plan as held. */
    source: 'QUANT_PORTFOLIO' | 'STRATEGY' | 'PATHWAYS' | 'RECONSTRUCTED';
    settledP50: number | null;
    /** Share of worlds reaching the target, and whether it is a probability or only coverage. */
    reach: number | null;
    reachBasis: 'PROBABILITY' | 'COVERAGE' | null;
    /**
     * Its counted legs that lack a channel, an offer, a fulfiller or settled
     * cash (`legFeasibility`): while any is listed, `reach` is assumption-only
     * coverage and never the plan's outcome. Absent when no pathway reading
     * judged the legs.
     */
    unsupported?: string[];
    /**
     * What the candidate would reach if the unmeasured assumptions its plan
     * tests held (invariant 39): reported beside `reach`, never as it. Absent
     * when the candidate rests on no assumed move.
     */
    assumedUpside?: AssumedUpside;
  } | null;
  /** Why the candidate is not accepted, each a thing work can change. */
  shortfalls: string[];
  /**
   * Each counted leg of the accepted plan (or, without one, the candidate):
   * what it structurally lacks and the permissions it still waits on. Absent
   * when no pathway reading was passed.
   */
  legs?: LegFeasibility[];
  /**
   * An accepted plan's one named blocker: the permissions and providers its
   * legs still wait on (§58). Null when nothing is missing.
   */
  blocker?: string | null;
  sentence: string;
  /**
   * The verdict, as the owner names them (Q2-8, 2026-11-14). Kept beside
   * `status`, which every existing reader uses: CONFIDENCE_VERIFIED iff
   * ACCEPTED (and so iff the reading is RECOMMENDABLE);
   * QUANTITATIVELY_CONSTRUCTED — every input of the candidate rests on
   * evidence or this Brain's measurements, every link is established, and
   * its reach is stated as an interval under parameter uncertainty whose 5th
   * percentile is under the requirement; IMPROVEMENT_REQUIRED — a candidate
   * (or none) whose inputs or links are not yet evidenced, with what to
   * improve named; NOT_SUPPORTED — arithmetic rules the goal out as stated.
   */
  verdict?: AcceptanceVerdict;
  /**
   * Result A (owner, 2026-11-14): the quantitatively constructed plan, always
   * present when any candidate exists, whatever the verdict — its reach with
   * an interval, the evidence each input rests on, what is assumed, and what
   * would raise it. Certification (result B) is `verdict` and `probability`.
   */
  construction?: PlanConstruction | null;
}

export const ACCEPTANCE_VERDICTS = ['CONFIDENCE_VERIFIED', 'QUANTITATIVELY_CONSTRUCTED', 'IMPROVEMENT_REQUIRED', 'NOT_SUPPORTED'] as const;
export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number];

export interface PlanConstruction {
  label: string;
  opportunityIds: string[];
  /** Share of worlds reaching the target (the predictive probability when `basis` is PROBABILITY). */
  reach: number | null;
  basis: 'PROBABILITY' | 'COVERAGE' | null;
  /**
   * Reach under parameter uncertainty: 5th, 50th and 95th percentile over the
   * outer draws. With basis ASSUMED_RANGES it is sensitivity to assumptions.
   */
  interval: { low: number; p50: number; high: number; draws: number; basis: 'EVIDENCE' | 'ASSUMED_RANGES' } | null;
  /** Each member input and what it rests on. */
  evidence: Array<{ opportunityId: string; input: string; tier: string; events: number | null; populations: number; sizedPopulations: number; establishes: boolean }>;
  /** What the reading assumes rather than knows. */
  assumptions: string[];
  /** The inputs whose uncertainty most limits the lower end, with the research that would narrow each (Q2-6). */
  improve: string[];
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
  excluded: { opportunityId: string; title: string; reason: string; rule?: 'OWNER_PHYSICAL' | 'STOPPED' }[];
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
   * Arrangements in the model whose price is the decision variable over an
   * observed supply cost (`priceAsVariable`): the break-even and the price the
   * target needs at each run size. The price is assumed and swept; it certifies nothing.
   */
  priceVariables?: PriceVariable[];
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
   * Openings that would be sold but are researched first: a route Brain
   * proposed whose price is still the proposal's hypothesis and whose deep
   * dive has not settled (`researchBeforeSale`). Each says why it waits.
   * Absent on readings that sell nothing.
   */
  researchFirst?: { opportunityId: string; title: string; reason: string }[];
  /**
   * The quant engine's combined plan (§79): each opening's customer demand
   * estimated from verified evidence, and the combination most likely to reach
   * the target under the spending, capital and timing limits, with the shared
   * outreach counted as one risk. A probability only when its basis says so.
   */
  portfolio: GoalPortfolio | null;
  /**
   * The buyer populations whose designs this reading could not price, the
   * leading arrangement's first (`unpricedForPlan`): what the goal tick sends
   * as `goal-price-` research (`sendPortfolioNeeds`) whether or not a
   * portfolio was evaluated. Absent when nothing was left unpriced.
   */
  unpriced?: UnpricedPopulation[];
  /**
   * The constructed arrangement the plan leads with (`leadingArrangement`):
   * its key, its buyers and how its price was read. Null when it leads with none.
   */
  lead?: PlanLead | null;
  /**
   * The plan's integrity violations (`planIntegrity`): each general rule a
   * confirmed planning failure broke, where this reading proves it broken.
   * A reading with any is never ACCEPTED. Empty when none.
   */
  integrity?: PlanIntegrityViolation[];
  /**
   * The investment committee's review of this reading (`committee.ts`, §117):
   * six independent role verdicts with cited defects. A reading it blocks is
   * never ACCEPTED. Absent on a reading built before it existed.
   */
  committee?: CommitteeReading | null;
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
  /**
   * Which plan this reading is (C-6): one plan, never three. RECONSTRUCTED when
   * the reconstruction's strongest plan beat the plan as held and is the
   * acceptance candidate, the next step and the sales order; otherwise the plan
   * as held, and a reconstruction that ran is said to be hypothetical, with why.
   */
  adoption: PlanAdoption;
  /** The adopted plan as an execution sequence (C-8): what, when, at what cost, on what basis, by whom, and what stops it. */
  steps: PlanStep[];
  /**
   * The stages of a transaction the steps sell without (`missingTransactionStages`):
   * empty when the steps offer, deliver and collect, or sell nothing. A plan never
   * reads as startable end to end without saying what it lacks.
   */
  stepsMissing?: TransactionStage[];
  /**
   * Steps found but not presented as the plan, and why (`collectsOutsideWindow`):
   * every collection lands after the goal's deadline. Absent when the steps are the plan.
   */
  excludedPlan?: { steps: string[]; reason: string };
  /** Reach figures withheld as implausible (`withholdImplausibleFigures`), one line each. Absent when none was. */
  figuresWithheld?: string[];
  /** Arithmetic infeasibility of the goal as stated (C-10), or null. Set iff acceptance is NOT_SUPPORTED. */
  infeasible: InfeasibleConclusion | null;
  /** What failed while this reading was composed, so a thinner reading is never mistaken for a complete one (C-13). */
  degraded: string[];
  /**
   * GOAL-13-6: the 30/60/90-day, deadline and derived horizons, each solved
   * backward for the deal economics and distribution it needs, with settlement
   * confirmed per pathway and independent combinations compared. Reach is
   * coverage unless calibrated; a horizon is ACCEPTED only by `acceptance`.
   */
  timelines?: TimelineReading | null;
  /**
   * GOAL-18-4: the goal's configured objective (its required confidence and
   * targets), and expected, upper and adverse outcomes read against it. The
   * threshold is a minimum, never a stop; a floor comes only from enforceable
   * commitments, never from the model.
   */
  objective?: ObjectiveReading | null;
  /**
   * GOAL-23: the goal's candidate plans proven distinct, each with a complete
   * model and ACCEPTED/PROVISIONAL status, the alternatives rebuilt after the
   * most important shared failure, and confidence withheld unless calibrated.
   */
  planSet?: GoalPlanSet | null;
  /** Whether the goal's productive work continues, and why — reaching or accepting the target never stops it by itself (S-0199). */
  continuation?: Continuation;
}

/** The objective reading the plan carries (GOAL-18-4). */
export interface ObjectiveReading {
  goal: GoalObjective;
  /** Outcomes of the strongest combination, total collections against the threshold; null when nothing is modelled. */
  outcome: OutcomeReading | null;
  /** Cash velocity, uncertainty, shared dependencies, opportunity cost and upside of each combination, explicitly. */
  tradeOffs: PlanTradeOff[];
  /** What the outcome was read from, and what it does not model. */
  basis: string;
  /**
   * Whether `outcome` is the plan's outcome or only assumption-only coverage,
   * and the figure over the supported legs alone. Null when no pathway reading
   * judged the legs.
   */
  support?: OutcomeSupport | null;
}

/**
 * The outcome split by what supports it (audit 2026-11-23, wst_7b4fcbb5f2384f31b6c3:
 * a 98% and an expected $55,772 read almost wholly from legs with no channel, no
 * offer and nobody to fulfil them). SUPPORTED: every counted leg has a channel, an
 * offer at an established price, a fulfiller and settled cash, so `outcome` is the
 * plan's. ASSUMPTION_ONLY: at least one does not, so `outcome` is exploration over
 * assumptions, and the figures a person may read as the plan's are `reach` and
 * `outcome` here — the same simulation over the supported legs alone.
 */
export interface OutcomeSupport {
  basis: 'SUPPORTED' | 'ASSUMPTION_ONLY';
  legs: LegFeasibility[];
  /** Share of worlds reaching the target over the supported legs alone; null when that was not simulated. */
  reach: number | null;
  /** Expected, upper and adverse over the supported legs alone; null when that was not simulated. */
  outcome: OutcomeReading | null;
  /** The full figure's reach, kept beside it and named for what it is. */
  assumptionReach: number | null;
  sentence: string;
}

/** The outcome a reading presents as the plan's: the supported one whenever the full one is assumption-only. Pure. */
export function planOutcomeOf(reading: Pick<ObjectiveReading, 'outcome' | 'support'> | null | undefined): OutcomeReading | null {
  if (!reading) return null;
  return reading.support?.basis === 'ASSUMPTION_ONLY' ? reading.support.outcome : reading.outcome;
}

/** The plan set the plan carries (GOAL-23), with the rebuild after the most important change. */
export interface GoalPlanSet extends PlanSet {
  /** The change the rebuild answers, and why that one. Null when no candidate depends on anything that can fail. */
  rebuild: (Rebuild & { why: string }) | null;
  /**
   * Observed money the goal holds that no opening's ledger rows name, major
   * units: counted toward the target, never credited to a plan. With
   * `collections.observed` it adds up to the cash the objective reads as held,
   * so the two readings agree about observed money for one goal.
   */
  unattributedObserved: number;
}

/** What one opening's own ledger rows show since the goal's target was set: observed money and whether a sale was executed. */
export interface OpeningLedger {
  /** The goal's own metric over this opening's rows, major units, never below zero. Observed, not modelled. */
  observed: number;
  /** A buyer agreed, paid or settled on a row naming this opening: the attempt was carried out, not only researched. */
  executed: boolean;
}

/** Ledger kinds that show a sale was carried out on an opening, whatever the goal's metric counts. */
const EXECUTED_KINDS = ['PIPELINE_AGREED', 'CUSTOMER_PAYMENT', 'SETTLEMENT'] as const;

/** Per-opening ledger readings from grouped totals (rows of opportunity, kind, cents), by the goal's own metric. Pure. */
export function openingLedgerFrom(metric: TargetReading['metric'], rows: readonly { opportunityId: string; kind: string; cents: number }[]): Map<string, OpeningLedger> {
  const totals = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const t = totals.get(r.opportunityId) ?? {};
    t[r.kind] = (t[r.kind] ?? 0) + r.cents;
    totals.set(r.opportunityId, t);
  }
  const out = new Map<string, OpeningLedger>();
  for (const [id, t] of totals) {
    out.set(id, {
      observed: Math.max(0, achievedFrom(metric, t)) / 100,
      executed: EXECUTED_KINDS.some((k) => (t[k] ?? 0) > 0),
    });
  }
  return out;
}

/**
 * Each opening's own ledger since the target was set, in one grouped
 * statement (the goal plan has a statement budget: one per opening is what
 * got #758 reverted). Counted exactly as the target counts its figure, so a
 * plan's observed collections are the same money the target reads as held.
 */
export async function readOpeningLedger(target: Pick<TargetReading, 'projectId' | 'currency' | 'since' | 'metric'>): Promise<Map<string, OpeningLedger>> {
  const rows = await getDb().all<{ opportunity_id: string; kind: string; total: number | string }>(
    `SELECT opportunity_id, kind, COALESCE(SUM(amount_cents), 0) AS total
       FROM cash_money_entries
      WHERE project_id = ? AND currency = ? AND occurred_at >= ? AND opportunity_id IS NOT NULL
      GROUP BY opportunity_id, kind
      ORDER BY opportunity_id ASC, kind ASC`,
    [target.projectId, target.currency, target.since],
  );
  return openingLedgerFrom(target.metric, rows.map((r) => ({ opportunityId: r.opportunity_id, kind: r.kind, cents: Number(r.total ?? 0) })));
}

export interface Continuation {
  continues: boolean;
  reason: string;
  /** Modelled surplus over the threshold, in dollars, that can finance successors; never a reason to stop. */
  surplusForSuccessors: number;
}

/**
 * What a plan reaches only if the unmeasured assumptions it rests on hold
 * (invariant 39): a hypothesis to test by executing each assumed move's kill
 * criterion, reported beside the reach that holds without them and never as it.
 */
export interface AssumedUpside {
  reach: number;
  settledP50: number;
  /** Each assumed move, by its title. */
  assumptions: string[];
  sentence: string;
}

export interface PlanAdoption {
  source: 'RECONSTRUCTED' | 'BASELINE';
  /** True when a reconstruction ran and is not the plan: its figures describe changes nobody has adopted. */
  hypothetical: boolean;
  reason: string;
  /** The reconstruction's reach if its assumed moves held, kept for investigation whether or not it is the plan. */
  upside?: AssumedUpside;
}

export type StepBasis = 'EVIDENCE' | 'ESTIMATE' | 'ASSUMPTION';

export interface PlanStep {
  order: number;
  label: string;
  detail: string;
  startDay: { low: number; high: number } | null;
  /**
   * What the start day is read from (the model value and its standing), or,
   * when `startDay` is null, what establishes it. Absent on steps whose day is
   * a reconstruction's own.
   */
  when?: string;
  /**
   * Money it commits before any opening pays, major units: the figure the
   * plan's model used for that stage. Null when the model holds no cost for
   * the stage — unestablished, never written as 0 (production, 2026-11-19:
   * every step of a leading arrangement read "cost 0").
   */
  cost: number | null;
  basis: StepBasis;
  /**
   * Who the step waits on before it proceeds: PERSON only for a rule-11 kind
   * (a payment, a credential, a legal commitment). Who performs it, and the
   * approval it needs, are `executor` — approval is never labor.
   */
  owner: 'BRAIN' | 'PERSON';
  ownerReason: string | null;
  /** The earlier step this one needs, by `order`, or null. */
  dependsOn: number | null;
  /**
   * A delivery step's licence constraint: the licensed act its opening names
   * (`licensedActIn`), which only a fulfiller holding that licence performs.
   * Absent where none is named.
   */
  licence?: string;
  /** The measurement that invalidates the step, and what then happens. */
  kill: string;
  /**
   * What executing it needs that is not in place (a permission to contact
   * buyers, invoicing, a billing provider). Listed, never a block on
   * constructing or evaluating the plan.
   */
  execution: string[];
  /**
   * Who performs it — Brain through which registered capability, a provider,
   * the owner, or nobody yet (CAPABILITY_MISSING) — and, separately, whether it
   * needs the owner's approval and why (`stepExecutor`; owner, 2026-11-20).
   * Read from Brain's registered capabilities, never from the step's words.
   */
  executor?: StepExecutor;
  /**
   * The openings a reconstruction's move acts on, by id (`changeOpenings`): a
   * channel's or partner's clone, the opening it brings in, the one its scope
   * names. Absent on a step on the plan as a whole. What the integrity check
   * reads to hold every step to the adopted members (STEPS_BELONG_TO_PLAN).
   */
  openings?: string[];
  /**
   * RESEARCH: establishes a part nobody has yet, by `question`. VALIDATE: an
   * action whose first results answer `question` (a first batch of offers
   * measures conversion). EXECUTE: the work itself. Absent on steps read from
   * a reconstruction or a sale, which are EXECUTE.
   */
  kind?: 'RESEARCH' | 'VALIDATE' | 'EXECUTE';
  question?: string;
  /** The research steps, by `order`, whose answers this step needs first. */
  requires?: number[];
  /** Whether its cost and timing are known to fit the goal's limits; null when what decides it is unknown. */
  withinLimits?: boolean | null;
  /**
   * Set on a step built from a constructed arrangement (`arrangementSteps`):
   * which arrangement, which stage of the transaction, where its cost comes
   * from, and — when it has no day — why it cannot be scheduled. What the
   * integrity check (`planIntegrity`) reads instead of the step's prose.
   */
  arrangement?: { key: string; stage: ArrangementStage; costSource: StepCostSource; unscheduled?: UnscheduledReason };
  /**
   * The same reading on a step no arrangement built — a reconstruction's
   * change, its sale and collection, a sale, the goal's own search: which
   * stage of the transaction it is, where its cost comes from, and why it has
   * no day. Production, 2026-11-19: a reconstructed plan's "Sell and collect"
   * read cost 0 with nothing saying where the 0 came from.
   */
  stage?: { stage: ArrangementStage; costSource: StepCostSource; unscheduled?: UnscheduledReason };
  /**
   * The ids of the rows, claims and card facts the step rests on (the
   * opening, its card facts' claims, its agreements, an arrangement's
   * sources): what an executor reads to check the step, never prose.
   */
  evidence?: string[];
  /** On the step that sells: the price a deal was judged at, major units — the strategy's own economics. */
  price?: number;
  /** On a step the owner performs: the owner's hours it takes a deal, as the model holds them. */
  hours?: number;
}

export interface InfeasibleConclusion {
  /** Why, in arithmetic. */
  reason: string;
  /** The constraints to relax, the one the diagnosis names first. */
  relax: Array<{ constraint: 'DEADLINE' | 'CAPITAL' | 'TARGET' | 'OWNER_HOURS'; suggestion: string }>;
  headroomReach: number;
  required: number;
  /**
   * Only an instant (checkout or marketplace) sale could still close the gap in
   * time, and none is held. The verdict stands for every way of selling Brain
   * holds, but a buyer already at a checkout is not ruled out by arithmetic, so
   * the search narrows to that instead of stopping (§65; review F2).
   */
  instantOnly: boolean;
  /**
   * The conclusion is about the openings held, each bounded by a measured
   * market or by the goal's own limits (`judgeHeldMarkets`). Markets nobody
   * has counted are not ruled out, so the search for other openings continues
   * (§65), while the plan on what is held names the change of terms.
   */
  heldMarkets?: boolean;
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
  // A first step the owner allows before any money comes in. A published capital
  // figure inside the limit is one; so is an unpublished one whose worst case —
  // the top of the range the model sweeps — is still inside it (commission and
  // referral openings almost never publish one). Nothing favourable is assumed:
  // without a limit, or without a bounded worst case, unknown capital stays a
  // question (invariant 39).
  const firstStepAllowed =
    capital !== null
      ? limit === null || capital <= limit
      : one.capital.high !== null && limit !== null && one.capital.high <= limit;
  if (
    ok('REACHABLE_BUYER') &&
    !!o.offerScope &&
    price !== null &&
    price > 0 &&
    // A test is a few offers at the card's price, so the price itself is what it measures.
    (cost === null || cost < price) &&
    firstStepAllowed &&
    !one.competitiveAward
  ) {
    return 'C_MARKET_TEST_READY';
  }
  if (o.payer && (ok('CURRENT_DEMAND') || ok('REACHABLE_BUYER') || !!o.buyingSignal)) return 'B_EVIDENCED';
  return 'A_THEORETICAL';
}

const DAY = 86_400_000;

/**
 * Whether buyers want this now (research-informed routes, 2026-11-25). A fresh,
 * dated buying signal for this very offer is VERIFIED demand. Where nobody has
 * asked for this exact offer — a new offer Brain created from a real market
 * need — a fresh, dated sign that buyers of this kind spend on comparable
 * offers now establishes the link as COMPARABLE demand, and the basis says so:
 * it is demand for the market, not proof that these buyers want this offer,
 * which stays the conversion test's to show. An undated or stale sign of either
 * kind is not demand. Pure.
 */
export function currentDemandCheck(one: Pick<ModelledOpportunity, 'opportunity' | 'comparableDemand'>, signalFresh: boolean, now: Date): LinkCheck {
  const o = one.opportunity;
  if (o.buyingSignal && signalFresh) return { link: 'CURRENT_DEMAND', ok: true, basis: `VERIFIED: signal dated ${o.signalObservedAt!.slice(0, 10)}` };
  const comparable = one.comparableDemand ?? null;
  const observed = comparable?.observedAt ? Date.parse(comparable.observedAt) : Number.NaN;
  const comparableFresh = Number.isFinite(observed) && now.getTime() - observed <= RECOMMENDATION_POLICY.demandFreshDays * DAY;
  if (comparable && comparableFresh) {
    return {
      link: 'CURRENT_DEMAND',
      ok: true,
      basis: `COMPARABLE: buyers of this kind spend on comparable offers now (dated ${comparable.observedAt!.slice(0, 10)}: ${comparable.text.slice(0, 100)}); demand for this exact offer is not verified`,
    };
  }
  return {
    link: 'CURRENT_DEMAND',
    ok: false,
    basis: o.buyingSignal
      ? 'the buying signal is undated or older than the policy allows'
      : comparable
        ? 'the comparable-demand sign is undated or older than the policy allows'
        : 'no buying signal recorded',
  };
}

/**
 * Agreed money that rests on a contested price (planningReliability round 10,
 * adaptation): the card's price is contradicted by a filed price fact
 * (`priceContradiction`), and the agreements were read at more a deal than the
 * lower of the two figures. Which figure the buyers agreed to is exactly what
 * the contradiction leaves open, so the agreements do not establish the offer
 * and price until somebody settles it — the same rule that keeps a contested
 * price from establishing new deals. Agreements at or below the lower figure
 * hold whichever way it is settled. Pure.
 */
export function agreedAtContestedPrice(one: Pick<ModelledOpportunity, 'agreed' | 'agreedDeals' | 'agreedValue' | 'price'>): boolean {
  const contested = one.price.contested;
  if (!contested || !one.agreed || one.agreedValue <= 0) return false;
  const each = one.agreedValue / Math.max(1, one.agreedDeals);
  return each > Math.min(contested.card, contested.stated) + 1e-9;
}

function linkChecks(one: ModelledOpportunity, deals: number, target: TargetReading, capabilities: Map<string, string>, now: Date): LinkCheck[] {
  const o = one.opportunity;
  const fresh = o.signalObservedAt && now.getTime() - Date.parse(o.signalObservedAt) <= RECOMMENDATION_POLICY.demandFreshDays * DAY;
  const caps = o.requiredCapabilities;
  const allPresent = caps.length > 0 && caps.every((id) => capabilities.get(id) === 'PRESENT');
  const established = (input: { provenance: string }) => input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL';
  const conversion = conversionState(one);
  const economics = economicsState(one, target);
  const settles = settlesState(one, target);
  return [
    { link: 'REACHABLE_BUYER', ok: !!o.reachableChannel && !!o.payer, basis: o.reachableChannel ? `reach: ${o.reachableChannel.slice(0, 80)}` : 'nobody has established how to reach the buyer' },
    currentDemandCheck(one, !!fresh, now),
    {
      link: 'OFFER_AND_PRICE',
      // A price counts only when buyers are shown to pay it: a source, this
      // Brain's own sales, or a buyer's agreement. Brain's proposal, a person's
      // hope or somebody else's asking price is a guess about revenue.
      ok: !!o.offerScope && !agreedAtContestedPrice(one) && (one.agreed || (one.price.value !== null && priceSupported(one))),
      basis: agreedAtContestedPrice(one)
        ? `buyers agreed to ${one.agreedValue} ${target.currency}, but a filed price fact states ${one.price.contested!.stated}, below the ${one.price.contested!.card} the agreements were read at: settle the price before planning on it`
        : one.agreed
        ? `a buyer agreed to ${one.agreedValue} ${target.currency}`
        : one.price.value === null
          ? 'no single price on the card'
          : priceSupported(one)
            ? `price ${one.price.value} ${target.currency} (${one.price.provenance})`
            : `price ${one.price.value} ${target.currency} is a guess (${one.price.provenance}), not something buyers are shown to pay`,
    },
    {
      link: 'CONVERSION',
      ok: deals === 0 ? one.agreed : conversion.state !== 'NONE',
      basis:
        deals === 0
          ? one.agreed ? `buyers have agreed to ${one.agreedValue} ${target.currency}` : 'nothing agreed and no buyers offered'
          : conversion.state === 'HISTORICAL'
            ? one.close.note
            : conversion.state === 'TRANSFERRED'
              ? `TRANSFERRED: ${conversion.basis}`
              : `${deals} new buyer(s) would be offered and nobody knows how many would agree${one.agreed ? ` (one agreement of ${one.agreedValue} is recorded)` : ''}${conversion.basis ? ` (${conversion.basis})` : ''}`,
    },
    volumeCheck(one, deals),
    fulfilmentCheck(one, caps, allPresent, capabilities),
    {
      link: 'ECONOMICS',
      ok: economics.ok,
      basis: economics.basis,
    },
    {
      link: 'SETTLES_IN_TIME',
      ok: settles.ok,
      basis:
        one.competitiveAward && !established(one.daysToCash)
          ? 'money comes only after winning an award, then doing the work, then the buyer paying on its terms — nobody has established when that would be'
          : settles.basis,
    },
  ];
}

/**
 * How the close rate is evidenced (Q2-3, 2026-11-14). HISTORICAL — this
 * Brain's own buyers agreed. TRANSFERRED — reconstructed from sized evidence:
 * DIRECT, COMPARABLE over two or more independent sized populations, or a
 * COMPONENT whose parts are all evidence, worth at least the minimum events.
 * Weaker than HISTORICAL and said so on the link, but it establishes the link:
 * before, "buyers who have actually agreed" meant only this Brain's own sales,
 * so no new buyer, however well evidenced, could ever complete a chain.
 * Unsized, single-comparable, mechanism, assumed and unknown never do.
 */
export function conversionState(one: Pick<ModelledOpportunity, 'close'>): { state: 'HISTORICAL' | 'TRANSFERRED' | 'NONE'; basis: string; evidence: InputEvidence } {
  const ev = inputEvidence(one.close, 'close');
  if (one.close.provenance === 'HISTORICAL' && ev.establishes) return { state: 'HISTORICAL', basis: one.close.note, evidence: ev };
  if (ev.establishes && ev.drawable) {
    return { state: 'TRANSFERRED', basis: `close rate ${ev.tier.toLowerCase()} from ${ev.sizedPopulations} independent sized population(s), worth ${ev.events} events (p10 ${fmtRate(one.close.inferred?.p10)}, p90 ${fmtRate(one.close.inferred?.p90)})`, evidence: ev };
  }
  return { state: 'NONE', basis: ev.unverifiable ?? '', evidence: ev };
}

const fmtRate = (x: number | undefined) => (x === undefined ? '?' : `${Math.round(x * 1000) / 10}%`);

/**
 * Costs and money tied up (Q2-7): a stated figure on evidence, or an evidenced
 * reconstruction judged at its cautious end — direct cost at p90 under the
 * price, money tied up at p90 inside the per-arrangement limit — exactly as a
 * reconstruction is used to refuse.
 *
 * An evidenced cost is not sound economics by itself (planningReliability
 * ho-10, 2026-11-21): a $2,300 cost against a $2,000 price passed this link
 * because only the cost's evidence was read. A stated cost at or over the
 * price is a negative unit margin, and the link fails on it.
 */
export function economicsState(one: ModelledOpportunity, target: Pick<TargetReading, 'capitalBeforeProofCents'>): { ok: boolean; basis: string } {
  const evidenced = (input: ModelInput) => input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL';
  const cost = one.directCost;
  const capital = one.capital;
  const price = one.price.value ?? one.price.low;
  if (cost.value !== null && price !== null && cost.value >= price) {
    return { ok: false, basis: `each deal loses money: a cost of ${cost.value} against a price of ${price}` };
  }
  if (cost.value !== null && capital.value !== null) return { ok: evidenced(cost), basis: `cost ${cost.value}, tied up ${capital.value}` };
  const costEv = inputEvidence(cost, 'directCost');
  const capitalEv = inputEvidence(capital, 'capital');
  const costHigh = cost.value ?? (costEv.establishes ? cost.inferred?.p90 ?? null : null);
  const capitalHigh = capital.value ?? (capitalEv.establishes ? capital.inferred?.p90 ?? null : null);
  const limit = target.capitalBeforeProofCents !== null ? target.capitalBeforeProofCents / 100 : null;
  const costOk = costHigh !== null && (cost.value !== null ? evidenced(cost) : price !== null && costHigh < price);
  const capitalOk = capitalHigh !== null && (capital.value !== null || limit === null || capitalHigh <= limit);
  if (costOk && capitalOk) return { ok: true, basis: `cost ${cost.value ?? `≤ ${Math.round(costHigh!)} at p90 (transferred)`}, tied up ${capital.value ?? `≤ ${Math.round(capitalHigh!)} at p90 (transferred)`}` };
  return { ok: false, basis: costHigh === null || capitalHigh === null ? 'costs or money tied up are not established' : `the cautious cost (${Math.round(costHigh)}) or money tied up (${Math.round(capitalHigh)}) breaks the price or the limit` };
}

/** When the cash settles (Q2-7): a stated term on evidence, or an evidenced reconstruction whose p90 is inside the time left. */
function settlesState(one: ModelledOpportunity, target: TargetReading): { ok: boolean; basis: string } {
  const days = one.daysToCash;
  const evidenced = days.provenance === 'EVIDENCE' || days.provenance === 'HISTORICAL';
  if (days.value !== null) return { ok: target.daysLeft !== null && days.value <= target.daysLeft && evidenced, basis: `${days.value} days to usable cash against ${target.daysLeft} left` };
  const ev = inputEvidence(days, 'daysToCash');
  if (ev.establishes && days.inferred) {
    const ok = target.daysLeft !== null && days.inferred.p90 <= target.daysLeft;
    return { ok, basis: `TRANSFERRED: ${Math.round(days.inferred.p90)} days to usable cash at p90 (${ev.tier.toLowerCase()}, ${ev.sizedPopulations} sized population(s)) against ${target.daysLeft} left` };
  }
  return { ok: false, basis: 'nobody has established when the money would settle' };
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
export function volumeCheck(one: ModelledOpportunity, deals: number): LinkCheck {
  const needed = one.repeatable ? dealsFromOffers(one, deals) : Math.min(deals, 1);
  if (!one.repeatable || needed === 0) return { link: 'MARKET_VOLUME', ok: true, basis: one.repeatable ? 'no new deals needed' : 'a one-off needs its one buyer' };
  if (!volumeEstablished(one)) {
    // An evidenced reconstruction of the volume establishes it at its cautious end (Q2-1).
    const ev = inputEvidence(one.volume, 'volume');
    if (ev.establishes && one.volume.inferred) {
      const p10 = Math.floor(one.volume.inferred.p10);
      return { link: 'MARKET_VOLUME', ok: p10 >= needed, basis: `TRANSFERRED: ${needed} deal(s) needed, ${p10} available at p10 (${ev.tier.toLowerCase()})` };
    }
    return { link: 'MARKET_VOLUME', ok: false, basis: `${needed} deal(s) needed and nobody has established how many buyers exist or how often they buy` };
  }
  /*
   * A counted market already holds the buyers who agreed (planningReliability
   * round 6): 4 of 6 firms signed leaves 2 to ask, not 6. When research counted
   * the buyers themselves, every live agreement is one of them and takes one of
   * the window's deals, so the new deals are checked against what is left —
   * never against the whole market a second time. An order rate counts deals
   * made, not buyers, and is read as before.
   */
  const counted = one.prospects !== null && one.prospects !== undefined;
  const taken = counted ? Math.min(one.agreedDeals, one.volume.value ?? 0) : 0;
  const available = (one.volume.value ?? 0) - taken;
  if (counted && taken > 0 && available < needed) {
    return {
      link: 'MARKET_VOLUME',
      ok: false,
      basis: `${needed} new deal(s) needed but the market holds ${one.volume.value} and ${taken} already agreed, so only ${available} are left to ask (${one.volume.note})`,
    };
  }
  const asked = prospectsAsked(one, needed);
  if (available >= needed && asked !== null && asked > one.prospects! - taken) {
    return {
      link: 'MARKET_VOLUME',
      ok: false,
      basis: `${needed} deal(s) needed at the measured rate means asking ${asked} prospects, but the market holds only ${one.prospects} (${one.volume.note}): at that rate it yields about ${Math.floor(one.prospects! * measuredClose(one)! * 10) / 10}`,
    };
  }
  return {
    link: 'MARKET_VOLUME',
    ok: available >= needed,
    basis: available >= needed ? `${needed} deal(s) needed, ${available} available in the window (${one.volume.note})` : `${needed} deal(s) needed but only ${available} in the window (${one.volume.note})`,
  };
}

/**
 * The prospects a measured rate needs asked for `deals` new deals, when the
 * market's prospects are counted (`ModelledOpportunity.prospects`), or null
 * (planningReliability round 4). A measured rate — agreements per contact,
 * pre-orders per visitor, wins per quote — is a share of prospects, so the
 * deals it wins are bounded by the prospects that exist: 10 orders at a
 * cautious 0.1% need 10,000 asked, and 320 gift shops are not 10,000
 * prospects, however the rate was measured. Read at the rate's cautious end,
 * the same one the plan's conservative figure reads. Pure.
 */
export function prospectsAsked(one: Pick<ModelledOpportunity, 'close' | 'prospects'>, deals: number): number | null {
  if (one.prospects === null || one.prospects === undefined || !(deals > 0)) return null;
  const close = measuredClose(one);
  return close === null ? null : Math.ceil(deals / Math.min(1, close) - 1e-9);
}

/** The deals a strategy actually needs taken, as opposed to the buyers it asks. */
function dealsTaken(one: ModelledOpportunity, deals: number): number {
  return one.agreedDeals + (one.repeatable ? dealsFromOffers(one, deals) : deals);
}

/** The deals a repeatable play needs, read back from its offers: goalScenario's one rule, re-exported for the plan's readers. */
export { dealsFromOffers };

async function nextTestFor(link: ChainLink, one: ModelledOpportunity, projectId: string): Promise<NextTest> {
  const title = one.opportunity.title.slice(0, 80);
  switch (link) {
    case 'CONVERSION': {
      // Evidence reconstruction was meant to supply is asked for first, by Brain (Q2-6).
      const need = conversionState(one).evidence.need;
      if (need) return { link, test: `Research for "${title}": ${need}. A bounded offer test — a few reachable buyers, counting who agrees — would measure it directly.`, by: 'BRAIN', blocker: null };
      const contact = await planAuthority(projectId, 'CONTACT_BUYER');
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

/**
 * The days one lot holds its capital: its days to cash, and never less than one day. Cash
 * usable the day of the sale ("0 days") frees a lot's money for the next day's lot (planner
 * residuals, 2026-11-25: r09, a lead service paid at signing with $600 of ads a deal, read
 * as 27 lots held at once — $16,200 against a $15,000 ceiling — because a cycle of 0 days
 * was read as unknown timing). Pure.
 */
function lotCycleDays(daysToCash: number): number {
  return Math.max(1, daysToCash);
}

/**
 * How many of an opening's lots hold money at once (planningReliability fam-16,
 * 2026-11-21). A lot ties its capital up from the day it is bought until its
 * cash settles `daysToCash` later, and then that money is free for the next
 * lot. Run back to back inside the days left, `floor(daysLeft / daysToCash)`
 * lots fit one after another in each slot, so the fewest that must overlap is
 * `ceil(lots / thatMany)` — and every lot still settles inside the window.
 * Two $8,000 lots paid in 21 days hold $8,000 at a time over 60 days, never
 * $16,000. When the timing is unknown, or a lot cannot settle in time at all,
 * every lot is read as held at once: the cautious end. Pure.
 */
export function peakConcurrentLots(lots: number, daysToCash: number | null, daysLeft: number | null): number {
  if (!(lots > 0)) return 0;
  if (daysToCash === null || daysLeft === null || !(daysToCash >= 0)) return lots;
  const inSequence = Math.floor(daysLeft / lotCycleDays(daysToCash));
  if (inSequence < 1) return lots;
  // A fractional cautious count (deals × a close rate) is never rounded up past itself.
  return Math.min(lots, Math.ceil(Math.ceil(lots - 1e-9) / inSequence));
}

/**
 * The lots an opening runs under the owner's capital ceiling, recycled
 * (planningReliability round 7): how many hold money at once, and how many
 * settle inside the window. `peakConcurrentLots` runs every lot inside the
 * window with as few overlapping as the timing allows; when even that holds
 * more than the ceiling, the ceiling decides instead — `floor(ceiling ÷
 * capital)` lots at a time, each slot reused as its lot's cash settles, so
 * `slots × floor(daysLeft ÷ daysToCash)` lots settle in time and the rest run
 * after the window and count nothing toward it. Three signed $2,000 lots paid
 * in 12 days under a $2,500 ceiling over 30 days run one at a time: two settle
 * by day 24, $2,000 is held at once, and the third settles after the window.
 * With no ceiling, no lot fitting under it, unknown timing or a lot that
 * cannot settle in time, the reading is `peakConcurrentLots`' and every lot
 * counts: the limit then breaks where it is checked, never silently. Pure.
 */
export function lotsUnderCeiling(
  lots: number,
  daysToCash: number | null,
  daysLeft: number | null,
  capital: number,
  ceilingMajor: number | null,
): { atOnce: number; inWindow: number } {
  const atOnce = peakConcurrentLots(lots, daysToCash, daysLeft);
  const all = { atOnce, inWindow: lots };
  if (ceilingMajor === null || !(capital > 0) || atOnce * capital <= ceilingMajor + 1e-9) return all;
  if (daysToCash === null || daysLeft === null || !(daysToCash >= 0)) return all;
  const slots = Math.floor(ceilingMajor / capital + 1e-9);
  const inSequence = Math.floor(daysLeft / lotCycleDays(daysToCash));
  if (slots < 1 || inSequence < 1) return all;
  return { atOnce: Math.min(atOnce, slots), inWindow: Math.min(lots, slots * inSequence) };
}

/**
 * The lots an opening's agreements need bought (planningReliability held-out,
 * 2026-11-21). Money is tied up per lot — a truckload, a sublicence — and a
 * lot is priced at `price`; agreements smaller than one lot share it. Four
 * stores agreeing to $4,940 each are $19,760 of one $26,000 truckload: one
 * lot of capital, never four. Read as the fewer of the agreements and the lots
 * their value fills; with no price, one lot an agreement. Pure.
 */
export function agreedLots(one: Pick<ModelledOpportunity, 'agreedDeals' | 'agreedValue' | 'price'>): number {
  if (one.agreedDeals <= 0) return 0;
  const price = one.price.value ?? one.price.low;
  if (price === null || !(price > 0) || !(one.agreedValue > 0)) return one.agreedDeals;
  return Math.min(one.agreedDeals, Math.ceil(one.agreedValue / price - 1e-9));
}

/**
 * A strategy's members, without agreed work the owner would have to perform
 * that the plan does not need (planningReliability fam-09, 2026-11-21).
 *
 * Every agreement is counted in every strategy, so once agreed owner-performed
 * work counts as owner hours, a strategy that reaches the target without it
 * — four signed 10-hour consultations beside a Brain-produced spreadsheet that
 * collects the $4,000 alone — would break the owner's limit on work it never
 * needed. When the owner's hours are over their limit, agreed-only members
 * that cost owner hours are left out if the rest still reach the target at
 * their cautious numbers; otherwise every member stays, and the limit breaks.
 * Pure.
 */
export function withoutSpareOwnerWork<M extends { one: ModelledOpportunity; deals: number }>(
  members: M[],
  target: Pick<TargetReading, 'daysLeft' | 'hoursCeiling' | 'remainingCents'> & Partial<Pick<TargetReading, 'metric'>>,
): M[] {
  if (target.hoursCeiling === null) return members;
  const all = conservative(members, target);
  const committed = members.reduce((sum, { one }) => sum + (one.hours.value !== null && one.hours.provenance !== 'UNKNOWN' ? one.agreedDeals * one.hours.value : 0), 0);
  if (committed <= target.hoursCeiling + 1e-9 && (all.labour === null || all.labour <= target.hoursCeiling + 1e-9)) return members;
  const spare = (m: M) => m.deals === 0 && m.one.agreedDeals > 0 && m.one.hours.value !== null && m.one.hours.provenance !== 'UNKNOWN' && m.one.hours.value > 0;
  const rest = members.filter((m) => !spare(m));
  if (rest.length === members.length) return members;
  const reaches = (set: M[]) => {
    const cons = conservative(set, target);
    return cons.settled !== null && cons.settled >= target.remainingCents / 100;
  };
  if (rest.length > 0) return reaches(rest) ? rest : members;
  /*
   * Every member is agreed work that costs hours (planningReliability round 5):
   * nine signed Brain-produced reports at half an hour each beside three signed
   * owner-hosted events at eight hours each. Leaving every spare member out
   * left nothing, so all of them stayed and the limit broke, although the
   * reports alone collect the target in 4.5 hours. The agreements that cost
   * the most hours for each unit of money go first, one at a time, while what
   * stays still reaches the target, until the hours fit.
   */
  const hoursOf = (m: M) => m.one.agreedDeals * (m.one.hours.value ?? 0);
  const order = [...members].sort((a, b) => hoursOf(b) / Math.max(1e-9, b.one.agreedValue) - hoursOf(a) / Math.max(1e-9, a.one.agreedValue));
  let kept = members;
  for (const m of order) {
    if (kept.reduce((sum, k) => sum + hoursOf(k), 0) <= target.hoursCeiling + 1e-9) break;
    const next = kept.filter((k) => k !== m);
    if (next.length > 0 && reaches(next)) kept = next;
  }
  return kept;
}

/**
 * A strategy's members, without agreed lots on which every deal loses money
 * that the plan does not need (planningReliability round 5) — the economics
 * counterpart of `withoutSpareOwnerWork`.
 *
 * Every agreement is counted in every strategy, so six signed rentals that each
 * cost more than they pay put "costs at least what it pays" on every strategy,
 * including one whose other opening reaches the target at a margin; and a
 * strategy without them could not be stated. Agreed-only members whose
 * established direct cost is at least their price are left out if the rest
 * still reach the target at their cautious numbers; otherwise every member
 * stays, and the economics break. Pure.
 */
export function withoutLossMakingLots<M extends { one: ModelledOpportunity; deals: number }>(
  members: M[],
  target: Pick<TargetReading, 'daysLeft' | 'remainingCents'> & Partial<Pick<TargetReading, 'metric'>>,
): M[] {
  const losing = (m: M) =>
    m.deals === 0 && m.one.agreedDeals > 0 && m.one.price.value !== null && m.one.directCost.value !== null && m.one.directCost.provenance !== 'UNKNOWN' && m.one.directCost.value >= m.one.price.value;
  const rest = members.filter((m) => !losing(m));
  if (rest.length === 0 || rest.length === members.length) return members;
  const cons = conservative(rest, target);
  return cons.settled !== null && cons.settled >= target.remainingCents / 100 ? rest : members;
}

/**
 * A strategy's members, without agreed lots that tie up money the plan does not
 * need (planningReliability round 4) — the capital counterpart of
 * `withoutSpareOwnerWork`.
 *
 * Every agreement is counted in every strategy, so once the owner allows less
 * money up front than an agreed lot ties up — an objective changed to "no
 * up-front capital" beside a signed $9,000 resale that ties up $6,000 — every
 * strategy, including one whose other openings reach the target with nothing
 * tied up, carried the lot and broke the limit; and a strategy offering only
 * the other openings was the same set of offers, so it could not even be
 * stated. When the money held at once is over the ceiling, agreed-only members
 * that tie money up are left out if the rest still reach the target at their
 * cautious numbers; otherwise every member stays, and the limit breaks. Pure.
 */
export function withoutSpareCapitalLots<M extends { one: ModelledOpportunity; deals: number }>(
  members: M[],
  target: Pick<TargetReading, 'daysLeft' | 'remainingCents'> & Partial<Pick<TargetReading, 'metric'>> & { capitalCeilingCents?: number | null; capitalBeforeProofCents?: number | null },
): M[] {
  // The tighter of what the goal may commit and what may be tied up before money comes in ("no up-front capital").
  const limits = [target.capitalCeilingCents, target.capitalBeforeProofCents].filter((x): x is number => x !== null && x !== undefined);
  const ceiling = limits.length ? Math.min(...limits) : null;
  if (ceiling === null) return members;
  const all = conservative(members, target);
  if (all.exposure === null || all.exposure <= ceiling / 100 + 1e-9) return members;
  const spare = (m: M) => m.deals === 0 && m.one.agreedDeals > 0 && m.one.capital.value !== null && m.one.capital.provenance !== 'UNKNOWN' && m.one.capital.value > 0;
  const rest = members.filter((m) => !spare(m));
  if (rest.length === 0 || rest.length === members.length) return members;
  const cons = conservative(rest, target);
  return cons.settled !== null && cons.settled >= target.remainingCents / 100 && cons.exposure !== null && cons.exposure <= ceiling / 100 + 1e-9 ? rest : members;
}

/**
 * A strategy's members, without agreed lots whose own evidence is incomplete
 * that the plan does not need (planningReliability round 7) — the evidence
 * counterpart of `withoutSpareCapitalLots` and `withoutLossMakingLots`.
 *
 * Every agreement is counted in every strategy, so an agreed opening whose
 * direct cost nobody established put "costs not established" on every
 * strategy — including one whose other, fully evidenced agreements already
 * collect the target — and a strategy without it could not be stated: the
 * plan was refused on an unknown it never needed (§39 forbids reading the
 * unknown favourably; it does not make an unneeded unknown decisive). An
 * agreed-only member that `broken` says fails a link of its own chain, or
 * whose cautious reading cannot be computed, is left out if the rest still
 * reach the target at their cautious numbers; otherwise every member stays,
 * and the gap stays named. Pure.
 */
export function withoutUnestablishedLots<M extends { one: ModelledOpportunity; deals: number }>(
  members: M[],
  target: Pick<TargetReading, 'daysLeft' | 'remainingCents'> & Partial<Pick<TargetReading, 'metric'>>,
  broken: (member: M) => boolean,
): M[] {
  const unestablished = (m: M) => m.deals === 0 && m.one.agreedDeals > 0 && (broken(m) || conservative([m], target).settled === null);
  const rest = members.filter((m) => !unestablished(m));
  if (rest.length === 0 || rest.length === members.length) return members;
  const cons = conservative(rest, target);
  return cons.settled !== null && cons.settled >= target.remainingCents / 100 ? rest : members;
}

/**
 * The conservative settled figure for a strategy, or null when an input it needs is unknown.
 *
 * Read against the deals the strategy takes (planningReliability, 2026-11-21):
 *   * agreed deals are established volume — an input only new deals need (the
 *     close, the price, the market's volume) is not needed when no new deal
 *     is taken, and a one-off whose buyer has already signed takes no other;
 *   * money tied up is the peak held at once, lots run one after another as
 *     their cash settles (`peakConcurrentLots`), never their sum;
 *   * owner hours count every deal the owner performs, agreed ones included;
 *   * on a net target (`countsNet`: "net settled cash", profit, contribution)
 *     `settled` is money kept: what settles in time less the direct cost of
 *     every deal taken, agreed ones included (`costedDeals`) — the same rule
 *     as the engine's `goal_met`, so the gate can never pass a plan on revenue
 *     that does not cover its costs (planningReliability round 3).
 */
export function conservative(
  members: { one: ModelledOpportunity; deals: number }[],
  target: Pick<TargetReading, 'daysLeft'> & Partial<Pick<TargetReading, 'metric' | 'capitalCeilingCents'>>,
): { settled: number | null; exposure: number | null; labour: number | null } {
  const net = countsNet(target.metric);
  let settled = 0;
  let exposure = 0;
  let labour = 0;
  const none = { settled: null, exposure: null, labour: null };
  for (const { one, deals } of members) {
    const conversion = conversionState(one);
    // The cautious end of each input: a measured low, or an evidenced reconstruction's p10 (p90 for what costs).
    const close = deals === 0 ? 0 : conversion.state === 'HISTORICAL' ? one.close.low : conversion.state === 'TRANSFERRED' ? (one.close.inferred?.p10 ?? null) : null;
    const price = one.price.value ?? one.price.low;
    const cautious = (input: ModelInput, key: 'daysToCash' | 'directCost' | 'capital') => input.value ?? (inputEvidence(input, key).establishes ? (input.inferred?.p90 ?? null) : null);
    const days = cautious(one.daysToCash, 'daysToCash');
    const cost = cautious(one.directCost, 'directCost');
    const capital = cautious(one.capital, 'capital');
    const hours = one.hours.value;
    let volume = volumeEstablished(one) ? one.volume.value : inputEvidence(one.volume, 'volume').establishes ? Math.floor(one.volume.inferred?.p10 ?? 0) : null;
    // No new deal taken, or a one-off whose one buyer has already agreed: the agreements are the volume.
    if (volume === null && (deals === 0 || (!one.repeatable && one.agreed))) volume = 0;
    if (volume === null || days === null || cost === null || capital === null || hours === null) return none;
    const taking = deals > 0 && volume > 0;
    if (taking && (close === null || price === null)) return none;
    // A measured rate wins at most its share of the prospects the market holds (`prospectsAsked`).
    const reachable = one.prospects !== null && one.prospects !== undefined && conversion.state === 'HISTORICAL' ? Math.min(deals, one.prospects) : deals;
    const won = taking ? Math.min(reachable * close!, volume) : 0;
    // Under the owner's ceiling the lots are recycled, and only those that settle in time count (`lotsUnderCeiling`); agreed lots run first.
    const ceiling = target.capitalCeilingCents === null || target.capitalCeilingCents === undefined ? null : target.capitalCeilingCents / 100;
    const lots = agreedLots(one);
    const run = lotsUnderCeiling(won + lots, days, target.daysLeft, capital, ceiling);
    const agreedIn = lots > 0 && run.inWindow < won + lots ? (one.agreedValue * Math.min(lots, run.inWindow)) / lots : one.agreedValue;
    const wonIn = run.inWindow < won + lots ? Math.max(0, Math.min(won, run.inWindow - lots)) : won;
    settled += days <= (target.daysLeft ?? 0) ? agreedIn + wonIn * price! : 0;
    // A cost is paid whether or not its money settles in time.
    if (net) settled -= costedDeals(won, one) * cost;
    exposure += run.atOnce * capital;
    labour += (won + one.agreedDeals) * hours;
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

/**
 * Why a strategy breaks a limit in every tested case, named from the limit the
 * engine counted rather than guessed as "the money or hours".
 *
 * Production 2026-11-21 (goal wst_7b4fcbb5f2384f31b6c3, "capital 3000 · hours
 * 0"): every strategy, down to one $15 opening tying up $15, read "breaks the
 * money or hours limit in every tested case". Money was never the cause. No
 * found opening had anybody established to do its work, so its owner hours
 * were swept 1 to 40 a deal (invariant 39: an unknown performer is read as
 * the owner), and any chance of a deal put the plan over the owner's 0 hours
 * in every world. The failure is correct; its reason was not: what is missing
 * is a performer, a research or supply question, not a budget.
 *
 * Returns the reasons for the limits broken in every evaluated case, or the
 * generic sentence when the run does not say which (a run recorded before the
 * per-limit count, or limits broken in turns). Pure.
 */
export function everyCaseInfeasible(
  violations: Record<string, number> | undefined,
  evaluated: number,
  members: Array<{ one: Pick<ModelledOpportunity, 'hours' | 'opportunity'>; deals: number }>,
  target: { hoursCeiling: number | null; capitalCeilingCents: number | null; currency: string },
  /**
   * The plan's own cautious reading of the money held at once (`conservative`),
   * lots run one after another as their cash settles. The engine sums every
   * lot's capital as if all were tied up together (planningReliability fam-16:
   * two sequential $8,000 lots read as $16,000 against $10,000), so a capital
   * count that the peak held at once fits is not a broken limit.
   */
  plan?: { exposure: number | null },
): string[] {
  const every = (key: string) => evaluated > 0 && (violations?.[key] ?? 0) >= evaluated;
  const reasons: string[] = [];
  const capitalFits = plan?.exposure !== null && plan?.exposure !== undefined && target.capitalCeilingCents !== null && plan.exposure <= target.capitalCeilingCents / 100;
  // Only capital broken, and the peak held at once fits: nothing is broken.
  if (capitalFits && every('capital') && !every('hours') && Object.entries(violations ?? {}).every(([key, n]) => key === 'capital' || n < evaluated)) return [];
  if (every('hours')) {
    const available = target.hoursCeiling === null ? 'the owner hours available, which nobody has stated' : `the ${target.hoursCeiling} owner hours this goal has`;
    const unperformed = members.filter(({ one, deals }) => deals > 0 && (one.hours.value === null || one.hours.provenance === 'UNKNOWN'));
    if (unperformed.length > 0) {
      const named = unperformed.map(({ one }) => `"${one.opportunity.title.slice(0, 60)}"`).join(', ');
      const ranges = [...new Set(unperformed.map(({ one }) => `${Math.round(one.hours.low ?? 0)}–${Math.round(one.hours.high ?? one.hours.low ?? 0)}`))].join(', ');
      reasons.push(
        `no performer is established for ${named}: nobody has established who does the work, so it is read as the owner's, ${ranges} owner hours a deal, against ${available} in every tested case — establish who performs it (Brain, a named supplier) or the hours it takes`,
      );
    } else {
      reasons.push(`needs more owner hours than ${available} in every tested case`);
    }
  }
  if (every('capital') && target.capitalCeilingCents !== null && !capitalFits) {
    reasons.push(`ties up more than the ${target.capitalCeilingCents / 100} ${target.currency} the owner said this goal may commit in every tested case`);
  }
  return reasons.length > 0 ? reasons : ['breaks the money or hours limit in every tested case'];
}

/** This Brain's record of earlier recommended goal plans: achieved in time, out of all that ended. */
export async function measuredPlanChance(): Promise<PlanReading['measuredChance']> {
  /*
   * The record counts every plan Brain adopted on evidence and judged at its
   * end (Q2-9, 2026-11-14): RECOMMENDABLE readings, and readings whose
   * acceptance was QUANTITATIVELY_CONSTRUCTED. Counting only RECOMMENDABLE
   * ones was a deadlock — they exist only after an accepted plan, and this
   * record is one of the ways a plan is accepted.
   */
  const rows = await getDb().all<{ kind: string }>(
    `SELECT o.kind FROM goal_outcomes o JOIN goal_plan_readings r ON r.id = o.reading_id
      WHERE r.verdict = 'RECOMMENDABLE' OR r.forecast LIKE ?`,
    ['%"verdict":"QUANTITATIVELY_CONSTRUCTED"%'],
  );
  if (rows.length < RECOMMENDATION_POLICY.minPlanOutcomes) return null;
  const achieved = rows.filter((one) => one.kind === 'ACHIEVED').length;
  const bounds = wilson(achieved, rows.length);
  return { estimate: achieved / rows.length, lowerBound: bounds.low, upperBound: bounds.high, sampleSize: rows.length, cohort: 'goal plans this Brain recommended or adopted on evidence, and how they ended' };
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
/**
 * A pathway combination's label, its members by title. The combination holds
 * ids; joined as they were they read "arr_6f3b7a404ca5 + arr_7c86…" in the
 * candidate and its sentence (NO_INTERNAL_KEYS, production goal
 * wst_7b4fcbb5f2384f31b6c3, release check 44986740566). A member no pathway or
 * portfolio entry titles is named generically, never by its id.
 */
export function pathwayLabel(members: readonly string[], pathways: ReadonlyArray<{ opportunityId: string; title: string }>, portfolio: Pick<GoalPortfolio, 'demand'> | null): string {
  const titles = new Map<string, string>([...(portfolio?.demand ?? []).map((d) => [d.opportunityId, d.title] as const), ...pathways.map((p) => [p.opportunityId, p.title] as const)]);
  return members.map((id) => (titles.get(id) ?? (isArrangementId(id) ? 'a constructed arrangement' : 'a held opening')).slice(0, 60)).join(' + ');
}

/**
 * Each counted leg judged on its structure (`legFeasibility`), from the
 * pathway reading and the quant engine's own price judgment. Null when no
 * pathway reading was passed: then nothing is judged here (the plan read
 * always passes one). Pure.
 */
export function legsOf(
  ids: readonly string[],
  pathways: ReadonlyArray<Pick<TransactionPathway, 'opportunityId' | 'gaps' | 'permissionsMissing'>> | null | undefined,
  portfolio: Pick<GoalPortfolio, 'demand'> | null | undefined,
): LegFeasibility[] | null {
  if (!pathways) return null;
  const by = new Map(pathways.map((p) => [p.opportunityId, p]));
  const unpriced = (id: string) => !!(portfolio?.demand ?? []).find((d) => d.opportunityId === id)?.unestablished.includes('price');
  return [...new Set(ids)].map((id) => legFeasibility(id, by.get(id), !unpriced(id)));
}

/** What the unsupported legs lack, in words, each leg by title. Pure. */
export function lacksSentence(legs: readonly LegFeasibility[], titles: ReadonlyMap<string, string> = new Map()): string {
  return legs
    .filter((l) => !l.supported)
    .slice(0, 6)
    .map((l) => `"${(titles.get(l.opportunityId) ?? (isArrangementId(l.opportunityId) ? 'a constructed arrangement' : 'a held opening')).slice(0, 60)}" lacks ${l.lacks.map((k) => LEG_LABEL[k]).join(', ')}`)
    .join('; ');
}

/** The candidate with its unsupported legs marked (`unsupported`), when legs were judged. Pure. */
export function withLegSupport(candidate: PlanAcceptance['candidate'], legs: readonly LegFeasibility[] | null): PlanAcceptance['candidate'] {
  if (!candidate || !legs) return candidate;
  const own = new Set(candidate.opportunityIds);
  return { ...candidate, unsupported: legs.filter((l) => own.has(l.opportunityId) && !l.supported).map((l) => l.opportunityId) };
}

/** The one named blocker of legs that lack nothing structural: the permissions and providers they wait on. Pure. */
export function permissionBlocker(legs: readonly LegFeasibility[] | null): string | null {
  const missing = [...new Set((legs ?? []).flatMap((l) => l.permissions))];
  return missing.length > 0 ? `selling and collecting wait only on ${missing.join(', ')}, which the owner grants or connects` : null;
}

export function judgeAcceptance(input: {
  achieved: boolean;
  chosen: StrategyReading | null;
  portfolio: GoalPortfolio | null;
  measuredChance: PlanReading['measuredChance'];
  considered: Pick<ConsideredOpening, 'opportunityId' | 'missing'>[];
  pathways?: (Pick<PathwayReading, 'portfolio'> & Partial<Pick<PathwayReading, 'pathways'>>) | null;
  required?: number;
  /** The goal's configured objective (GOAL-18-4): its required confidence governs, stated or recorded default. */
  objective?: Pick<GoalObjective, 'requiredConfidence'> | null;
}): PlanAcceptance {
  const required = input.required ?? input.objective?.requiredConfidence.value ?? RECOMMENDATION_POLICY.requiredProbability;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const best = input.portfolio?.best ?? null;
  const bestIds = best ? [...new Set(best.members.map((m) => m.opportunityId))] : [];
  /*
   * A combination that counts a member whose price nobody established is not a
   * candidate (planningReliability fam-08, fam-14, ho-02, ho-07, 2026-11-21):
   * the quant engine draws an unestablished price no better than its range's
   * centre, but the combination still counts that member's money toward the
   * target, and the plan then read as executable on it. An unknown price is
   * never favourable evidence (invariant 39), so the candidate is the best
   * combination whose members all have a price, or the strategy judged on its
   * chain when there is none, and the shortfall names the unpriced member.
   */
  const unpricedIn = (ids: string[]) => ids.filter((id) => (input.portfolio?.demand ?? []).find((d) => d.opportunityId === id)?.unestablished.includes('price'));
  const unpriced = unpricedIn(bestIds);
  /*
   * The held combination: the best one, or — when it counts an unpriced member —
   * the best-ranked alternative whose members all have a price, so the
   * candidate keeps the portfolio's own measure of reach. Swapping to another
   * measure (a strategy's sweep share) made tightening a limit able to raise
   * the reach the plan reports (planMetamorphic P6).
   *
   * The priced combination is the engine's own search over priced members
   * (`pricedBest`), never the first priced entry of the four alternatives the
   * reading keeps: whether one survived that cut depended on how many
   * combinations with the unpriced member ranked above it, so a looser
   * capital limit — more such combinations — pushed every priced one out and
   * the plan fell back to a strategy's sweep share (0.06 → 0.50 for
   * $10,000 → $1,000, Postgres suite 2026-11-22). A portfolio read before
   * `pricedBest` existed still reads the alternatives.
   */
  const pricedAlternative =
    best && unpriced.length > 0
      ? input.portfolio && input.portfolio.pricedBest !== undefined
        ? (input.portfolio.pricedBest && input.portfolio.pricedBest.members.length > 0 && unpricedIn([...new Set(input.portfolio.pricedBest.members.map((m) => m.opportunityId))]).length === 0 ? input.portfolio.pricedBest : null)
        : ([...(input.portfolio?.alternatives ?? [])].sort((a, b) => b.reach - a.reach).find((alt) => alt.members.length > 0 && unpricedIn([...new Set(alt.members.map((m) => m.opportunityId))]).length === 0) ?? null)
      : null;
  const pricedHeld = unpriced.length === 0 ? best : pricedAlternative;
  /*
   * A combination resting on a member whose own chain is incomplete is not
   * held over a strategy whose every link is established (planningReliability
   * round 7): an agreed opening whose direct cost nobody established beside
   * fully evidenced agreements that collect the target alone. The gate judged
   * the strategy without the unestablished lot (`withoutUnestablishedLots`)
   * and qualified it, while the candidate the plan reported still counted the
   * lot — a plan resting on the unknown it was judged without (§39). With a
   * qualified strategy in hand, the candidate is that strategy.
   *
   * A constructed arrangement is such a member too (planningReliability round
   * 12): its buyers are not found, its price is a comparable's and what it
   * delivers is not specified, so every link of its chain is an estimate. A
   * combination that added one beside found openings already carrying the
   * target alone reported a plan whose steps reach buyers nobody found and
   * deliver work nobody specified, at no established cost. It is broken
   * unless the qualified strategy itself counts it.
   */
  const constructedOutside = (id: string) => isArrangementId(id) && !(input.chosen?.arrangementIds ?? []).includes(id);
  const brokenIn = (ids: string[]) => ids.filter((id) => constructedOutside(id) || (input.considered.find((one) => one.opportunityId === id)?.missing.length ?? 0) > 0);
  const qualifiedOver = (ids: string[]) =>
    !!input.chosen?.chainComplete && input.chosen.verdict !== 'NOT_VIABLE' && input.chosen.opportunityIds.length > 0 && brokenIn(ids).some((id) => !input.chosen!.opportunityIds.includes(id));
  const held = pricedHeld && qualifiedOver([...new Set(pricedHeld.members.map((m) => m.opportunityId))]) ? null : pricedHeld;
  const heldIds = held ? [...new Set(held.members.map((m) => m.opportunityId))] : [];
  const pathwayRows = input.pathways?.pathways;
  const judge = (ids: readonly string[]) => legsOf(ids, pathwayRows, input.portfolio);
  const titles = new Map<string, string>([...(input.portfolio?.demand ?? []).map((d) => [d.opportunityId, d.title] as const), ...(pathwayRows ?? []).filter((p) => !!p.title).map((p) => [p.opportunityId, p.title] as const)]);
  // The engine's own run of exactly the pathways' leading members, when it made one: the source of both its median and its reach.
  const leadingRun = input.pathways?.portfolio.leading ? simulatedCombination(input.pathways.portfolio.leading.members, input.portfolio ?? null) : null;
  const proposed: PlanAcceptance['candidate'] =
    held && heldIds.length > 0
      ? { label: held.members.map((m) => m.title.slice(0, 60)).join(' + '), opportunityIds: heldIds, source: 'QUANT_PORTFOLIO', settledP50: held.settledP50, reach: held.reach, reachBasis: input.portfolio!.basis }
      : input.chosen && input.chosen.verdict !== 'NOT_VIABLE'
        ? { label: input.chosen.label, opportunityIds: input.chosen.opportunityIds, source: 'STRATEGY', settledP50: input.chosen.conservativeSettled ?? input.chosen.sweep.settledP50, reach: input.chosen.sweep.goalMetShare, reachBasis: input.chosen.sweep.goalMetShare === null ? null : input.chosen.sweep.probabilistic ? 'PROBABILITY' : 'COVERAGE' }
        : input.pathways?.portfolio.leading
          ? {
              label: pathwayLabel(input.pathways.portfolio.leading.members, input.pathways.pathways ?? [], input.portfolio ?? null),
              opportunityIds: input.pathways.portfolio.leading.members,
              source: 'PATHWAYS',
              /*
               * One source for a plan's settled figures: the simulated worlds. The leading
               * combination's own figures are contribution bounds (each leg's inputs at their
               * own ends, summed and capped at the gap), not a distribution, so its median is
               * the engine's for exactly these members when the engine simulated them, and
               * otherwise none (production wst_7b4fcbb5f2384f31b6c3: a $10,000 "p50" beside a
               * $368 "p10" and a $32,266 adverse case, from two estimators). Its reach comes
               * from the same run, or is not stated: a median beside "reach not computed" for
               * one simulated combination was two answers about one run (§77, 2026-11-24).
               */
              settledP50: leadingRun?.settledP50 ?? null,
              reach: leadingRun?.reach ?? null,
              reachBasis: leadingRun ? input.portfolio!.basis : null,
            }
          : null;
  const candidate = withLegSupport(proposed, proposed ? judge(proposed.opportunityIds) : null);
  const bestLegs = judge(bestIds);
  const bestUnsupported = !!bestLegs?.some((l) => !l.supported);
  // An alternative's construction is not the best combination's: the engine's assurance and interval are the best one's.
  const constructionPortfolio = pricedAlternative || !held ? null : (input.portfolio ?? null);
  if (input.achieved) {
    return {
      status: 'ACCEPTED',
      required,
      probability: { value: 1, lowerBound: 1, basis: 'TARGET_MET', sample: 1, note: 'the ledger already holds the target' },
      accepted: { label: 'target collected', opportunityIds: [] },
      candidate,
      shortfalls: [],
      sentence: 'The target is collected: the ledger holds it.',
      verdict: 'CONFIDENCE_VERIFIED',
      construction: constructionOf(candidate, constructionPortfolio, heldIds),
    };
  }
  const construction = constructionOf(candidate, constructionPortfolio, heldIds);
  const shortfalls: string[] = [];
  // 2. The evidenced portfolio.
  if (best && input.portfolio) {
    const worlds = Math.max(1, input.portfolio.worlds);
    /*
     * The number of simulated worlds is not evidence: 2,000 worlds drawn from
     * an input measured on 12 cases are 12 cases (C-7). The quant engine's own
     * assurance reads the bound over the smallest real sample behind any
     * member, and nothing else may claim 90%.
     */
    const assurance = input.portfolio.assurance ?? null;
    const sample = assuranceSample(assurance);
    const bounds = { low: assurance?.range?.low ?? 0 };
    const interval = assurance?.parameterInterval ?? null;
    const missingLinks = bestIds.flatMap((id) => {
      const c = input.considered.find((one) => one.opportunityId === id);
      return c ? c.missing.map((link) => `${id}: ${CHAIN_LABEL[link]}`) : [`${id}: not judged on its chain`];
    });
    if (unpriced.length > 0) {
      shortfalls.push(`the best combination counts money from ${unpriced.slice(0, 4).join(', ')}, whose price nobody has established; an unknown price is not evidence of reach`);
    } else if (input.portfolio.basis !== 'PROBABILITY') {
      shortfalls.push(
        `the best combination reaches the target in ${pct(best.reach)} of worlds, which is coverage of assumed inputs, not a probability: ${input.portfolio.missing.filter((one) => !/of worlds; more openings/.test(one)).slice(0, 4).join('; ') || 'inputs are not established'}`,
      );
    } else if (missingLinks.length > 0) {
      shortfalls.push(`the evidenced combination's chain is incomplete: ${missingLinks.slice(0, 4).join('; ')}`);
    } else if (!assurance || !assurance.range || (required >= RECOMMENDATION_POLICY.requiredProbability && !assurance.claimsAtLeast90)) {
      shortfalls.push(
        interval && interval.basis === 'EVIDENCE' && assurance?.status === 'RANGE'
          ? `the evidenced combination reaches the target with a 5th–95th percentile of ${pct(interval.low)}–${pct(interval.high)} under the uncertainty of its evidenced inputs; the 5th percentile is under ${pct(required)}` +
              (assurance.limitingInputs?.[0] ? `, limited most by ${assurance.limitingInputs[0].input}` : '')
          : `the evidenced combination reaches the target in ${pct(best.reach)} of ${worlds} simulated worlds, but simulated worlds are not evidence: ` +
              (assurance
                ? `the engine's assurance does not claim ${pct(required)} (${assurance.reason ?? assurance.status})`
                : 'the engine stated no assurance over the samples behind its inputs'),
      );
    } else if (bounds.low < required) {
      shortfalls.push(`the evidenced combination's defensible lower bound is ${pct(bounds.low)} over its smallest sample${sample ? ` (${sample})` : ''}, under the required ${pct(required)}`);
    } else if (bestUnsupported) {
      // Complete feasibility before acceptance: a counted leg nobody can reach, offer, fulfil or collect from is not executable, however its inputs were measured.
      shortfalls.push(`the evidenced combination counts money from legs that cannot be executed yet: ${lacksSentence(bestLegs!, titles)}`);
    } else {
      const blocker = permissionBlocker(bestLegs);
      return {
        status: 'ACCEPTED',
        required,
        probability: {
          value: best.reach,
          lowerBound: bounds.low,
          basis: 'EVIDENCED_PORTFOLIO',
          sample,
          note: interval
            ? `the lower bound is the 5th percentile of reach over ${interval.draws} draws of the evidenced inputs' parameters (weakest ${sample} events), not the share of ${worlds} simulated worlds; openings sharing outreach fail together at correlation ${input.portfolio.limits.correlation}, and openings drawing one estimate share its draw`
            : `the lower bound is read over the smallest evidence sample behind any member (${sample}), not over the ${worlds} simulated worlds; openings sharing outreach fail together at correlation ${input.portfolio.limits.correlation}`,
        },
        accepted: { label: candidate!.label, opportunityIds: bestIds },
        candidate,
        shortfalls: [],
        ...(bestLegs ? { legs: bestLegs, blocker } : {}),
        sentence: `Accepted: the evidenced combination collects the target before the deadline with a defensible lower bound of ${pct(bounds.low)} ≥ ${pct(required)} ${interval ? `(5th percentile under parameter uncertainty, weakest input ${sample} events)` : `over its smallest evidence sample (${sample})`}.${blocker ? ` Its one blocker: ${blocker}.` : ''}`,
        verdict: 'CONFIDENCE_VERIFIED',
        construction,
      };
    }
  } else {
    shortfalls.push('no combination of the openings held can run inside the limits');
  }
  // 3. This Brain's own record.
  const m = input.measuredChance;
  const chosenLegs = input.chosen ? judge([...input.chosen.opportunityIds, ...(input.chosen.arrangementIds ?? [])]) : null;
  const chosenUnsupported = !!chosenLegs?.some((l) => !l.supported);
  if (input.chosen?.chainComplete && m && m.lowerBound >= required && chosenUnsupported) {
    shortfalls.push(`"${input.chosen.label.slice(0, 120)}" has every chain link established, but counts money from legs that cannot be executed yet: ${lacksSentence(chosenLegs!, titles)}`);
  }
  if (input.chosen?.chainComplete && m && m.lowerBound >= required && !chosenUnsupported) {
    const blocker = permissionBlocker(chosenLegs);
    return {
      status: 'ACCEPTED',
      required,
      probability: { value: m.estimate, lowerBound: m.lowerBound, basis: 'MEASURED_RECORD', sample: m.sampleSize, note: m.cohort },
      accepted: { label: input.chosen.label, opportunityIds: input.chosen.opportunityIds },
      candidate,
      shortfalls: [],
      ...(chosenLegs ? { legs: chosenLegs, blocker } : {}),
      sentence: `Accepted: "${input.chosen.label}" has every link established, and ${m.sampleSize} accepted plans like it ended with a success rate whose lower bound is ${pct(m.lowerBound)} ≥ ${pct(required)}.${blocker ? ` Its one blocker: ${blocker}.` : ''}`,
      verdict: 'CONFIDENCE_VERIFIED',
      construction,
    };
  }
  shortfalls.push(
    m
      ? `this Brain's record of accepted plans has a lower bound of ${pct(m.lowerBound)} over ${m.sampleSize}, under ${pct(required)}${input.chosen?.chainComplete ? '' : ', and the chosen strategy\'s chain is not complete'}`
      : `this Brain has too few finished accepted plans (under ${RECOMMENDATION_POLICY.minPlanOutcomes}) to calibrate a success rate`,
  );
  if (input.chosen?.chainComplete) shortfalls.push(`"${input.chosen.label}" has every link established and its cautious numbers reach the target — a qualified candidate, but that is a point reading, not a ${pct(required)} probability`);
  /*
   * Constructed, or improvement required (Q2-8). Constructed: the portfolio's
   * inputs are all evidence, every member's chain is complete, and its reach
   * is stated as an interval under parameter uncertainty. Anything else names
   * what to improve: the inputs, the links, or — with no candidate — openings.
   */
  const missingAny = bestIds.some((id) => (input.considered.find((one) => one.opportunityId === id)?.missing.length ?? 1) > 0);
  const evidencedInterval = !!construction?.interval && construction.interval.basis === 'EVIDENCE';
  const constructed = !!candidate && candidate.source === 'QUANT_PORTFOLIO' && input.portfolio?.basis === 'PROBABILITY' && !missingAny && evidencedInterval && !bestUnsupported;
  const out: PlanAcceptance = {
    status: candidate ? 'CANDIDATE_ONLY' : 'NO_CANDIDATE',
    required,
    probability: null,
    accepted: null,
    candidate,
    shortfalls,
    ...(candidate && pathwayRows ? { legs: judge(candidate.opportunityIds) ?? [] } : {}),
    sentence: candidateSentence(candidate, required),
    verdict: constructed ? 'QUANTITATIVELY_CONSTRUCTED' : 'IMPROVEMENT_REQUIRED',
    construction,
  };
  if (constructed && construction?.interval) {
    out.sentence = `QUANTITATIVELY CONSTRUCTED, not yet confidence-verified: "${candidate!.label.slice(0, 160)}" rests on evidence at every input and link and reaches the target with a 5th–95th percentile of ${pct(construction.interval.low)}–${pct(construction.interval.high)} (median ${pct(construction.interval.p50)}) under the uncertainty of that evidence; ${pct(required)} needs the 5th percentile there.${construction.improve[0] ? ` What would raise it most: ${construction.improve[0].slice(0, 300)}.` : ''}`;
  }
  return out;
}

/**
 * Result A (owner, 2026-11-14): the plan as constructed — reach, its
 * interval, what each member input rests on, what is assumed, what would
 * raise it. Present whenever a candidate is, whatever the verdict.
 */
export function constructionOf(candidate: PlanAcceptance['candidate'], portfolio: GoalPortfolio | null, bestIds: string[]): PlanConstruction | null {
  if (!candidate) return null;
  const fromPortfolio = candidate.source === 'QUANT_PORTFOLIO' && portfolio;
  const members = fromPortfolio ? (portfolio.demand ?? []).filter((d) => bestIds.includes(d.opportunityId)) : [];
  const assurance = fromPortfolio ? (portfolio.assurance ?? null) : null;
  return {
    label: candidate.label,
    opportunityIds: candidate.opportunityIds,
    reach: candidate.reach,
    basis: candidate.reachBasis,
    interval: assurance?.parameterInterval ?? null,
    evidence: members.flatMap((d) =>
      (d.inputs ?? []).map((one) => ({ opportunityId: d.opportunityId, input: one.name, tier: one.tier, events: one.events, populations: one.populations, sizedPopulations: one.sizedPopulations, establishes: one.establishes })),
    ),
    assumptions: [
      ...members.flatMap((d) => d.unestablished.map((u) => `${d.title.slice(0, 60)}: ${u} is not established`)),
      ...(fromPortfolio ? [`openings sharing outreach move together at an assumed correlation of ${portfolio.limits?.correlation ?? 'the stated value'}`, 'replies and agreements are drawn as Poisson and binomial chance around the drawn rates'] : []),
    ],
    improve: [...new Set([...(assurance?.limitingInputs ?? []).map((one) => one.need), ...(assurance?.researchNeeds ?? [])])].slice(0, 6),
  };
}

/** The verdict a stored or adjusted acceptance carries, from its status and construction (Q2-8). Pure. */
export function verdictOf(acceptance: PlanAcceptance): AcceptanceVerdict {
  if (acceptance.status === 'ACCEPTED') return 'CONFIDENCE_VERIFIED';
  if (acceptance.status === 'NOT_SUPPORTED') return 'NOT_SUPPORTED';
  if (acceptance.status === 'NO_CANDIDATE') return 'IMPROVEMENT_REQUIRED';
  if (acceptance.candidate?.source === 'RECONSTRUCTED') return acceptance.candidate.reachBasis === 'PROBABILITY' ? 'QUANTITATIVELY_CONSTRUCTED' : 'IMPROVEMENT_REQUIRED';
  return acceptance.verdict === 'QUANTITATIVELY_CONSTRUCTED' ? 'QUANTITATIVELY_CONSTRUCTED' : 'IMPROVEMENT_REQUIRED';
}

/** The sentence a reading that holds no accepted plan says about its strongest candidate. */
export function candidateSentence(candidate: PlanAcceptance['candidate'], required: number): string {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  if (!candidate) return 'NOT ACCEPTED: no candidate plan yet; Brain keeps constructing and comparing strategies.';
  return (
    `NOT ACCEPTED: no plan has a defensible ${pct(required)} probability of collecting the target before the deadline. ` +
    `The strongest candidate is ${candidate.source === 'RECONSTRUCTED' ? 'the reconstructed plan ' : ''}"${candidate.label.slice(0, 160)}"` +
    (candidate.reach !== null
      ? candidate.unsupported?.length
        ? ` (assumption-only coverage: it reaches the target in ${pct(candidate.reach)} of worlds only by counting ${candidate.unsupported.length} of ${new Set(candidate.opportunityIds).size} leg(s) with no reachable channel, offer, fulfiller or settled cash yet — not the plan's outcome)`
        : ` (reaches the target in ${pct(candidate.reach)} of worlds, ${candidate.reachBasis === 'PROBABILITY' ? 'a probability' : 'coverage, not a probability'})`
      : candidate.unsupported?.length
        ? ` (${candidate.unsupported.length} of ${new Set(candidate.opportunityIds).size} leg(s) have no reachable channel, offer, fulfiller or settled cash yet)`
        : '') +
    (candidate.assumedUpside ? `; ${candidate.assumedUpside.sentence}` : '') +
    '; Brain keeps constructing, combining and comparing strategies.'
  );
}

/** A combination's settled distribution, as the quant engine or the reconstruction read it. */
export type SimulatedDistribution = Pick<PortfolioCombination, 'reach' | 'settledP10' | 'settledP50' | 'settledP90'>;

/**
 * The combination the quant engine simulated with exactly these members, or
 * null when it simulated none: the best one, the priced best, or an
 * alternative. Members compare as a set. Pure.
 */
export function simulatedCombination(ids: readonly string[], portfolio: Pick<GoalPortfolio, 'best' | 'pricedBest' | 'alternatives'> | null): PortfolioCombination | null {
  if (!portfolio || ids.length === 0) return null;
  const key = [...new Set(ids)].sort().join('|');
  const combos = [portfolio.best, portfolio.pricedBest ?? null, ...(portfolio.alternatives ?? [])];
  return combos.find((c): c is PortfolioCombination => !!c && [...new Set(c.members.map((m) => m.opportunityId))].sort().join('|') === key) ?? null;
}

/**
 * The distribution of the plan the acceptance holds — the accepted plan, or
 * else the candidate — and nothing else (production wst_7b4fcbb5f2384f31b6c3,
 * 2026-11-23): the outcome was read from `portfolio.best` whichever plan was
 * held, so a reading whose candidate was the pathways' leading combination
 * carried the engine's best's $32,266 adverse case beside the leading
 * combination's own figures. A reconstructed candidate reads the variant it
 * was adopted on; a candidate the engine never simulated has no distribution,
 * and so no outcome. Pure.
 */
export function heldDistribution(acceptance: Pick<PlanAcceptance, 'accepted' | 'candidate'>, portfolio: Pick<GoalPortfolio, 'best' | 'pricedBest' | 'alternatives'> | null, reconstruction: Pick<Reconstruction, 'best' | 'established'> | null): { ids: string[]; distribution: SimulatedDistribution } | null {
  const c = acceptance.candidate;
  if (acceptance.accepted && acceptance.accepted.opportunityIds.length > 0) {
    const found = simulatedCombination(acceptance.accepted.opportunityIds, portfolio);
    return found ? { ids: [...acceptance.accepted.opportunityIds], distribution: found } : null;
  }
  if (!c || c.opportunityIds.length === 0) return null;
  if (c.source === 'RECONSTRUCTED') {
    const held = reconstruction ? (reconstruction.established ?? reconstruction.best) : null;
    return held && held.feasible ? { ids: [...c.opportunityIds], distribution: held } : null;
  }
  const found = simulatedCombination(c.opportunityIds, portfolio);
  return found ? { ids: [...c.opportunityIds], distribution: found } : null;
}

/**
 * The adopted candidate as a strategy of the reading (P5, production
 * 2026-11-18, goal wst_7b4fcbb5f2384f31b6c3): the found openings' strategies
 * read NOT_VIABLE ("at most 265") while the acceptance's candidate — two
 * constructed arrangements on ASSUMED prices — reported 55.85% coverage and a
 * p50 of $27,410, and nothing in the reading related the two. The candidate
 * now stands in the strategies list with its basis stated: which inputs of
 * its members are assumed, that its reach is coverage (never a probability
 * unless the acceptance says so), and, for an arrangement whose price is the
 * decision variable, its break-even. NEEDS_EVIDENCE, never more: it certifies
 * nothing. Null when there is no candidate or a strategy already holds exactly
 * its openings. Pure.
 */
export function candidateStrategyReading(acceptance: PlanAcceptance, strategies: readonly StrategyReading[], priceVariables: readonly PriceVariable[] = []): StrategyReading | null {
  const c = acceptance.candidate;
  if (!c || acceptance.status === 'ACCEPTED') return null;
  const ids = [...c.opportunityIds].sort();
  if (ids.length === 0) return null;
  const membersOf = (s: StrategyReading) => [...s.opportunityIds, ...(s.arrangementIds ?? [])].sort();
  if (strategies.some((s) => membersOf(s).length === ids.length && membersOf(s).every((id, i) => id === ids[i]))) return null;
  const assumed = [...new Set((acceptance.construction?.evidence ?? []).filter((e) => !e.establishes).map((e) => e.input))];
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const blocking = priceVariables.filter((p) => ids.includes(`${ARRANGEMENT_ID_PREFIX}${p.arrangementKey}`));
  const basis =
    `The candidate "${c.label.slice(0, 160)}" (${c.source.toLowerCase().replace('_', ' ')})` +
    (c.reach !== null ? ` reaches the target in ${pct(c.reach)} of worlds, ${c.reachBasis === 'PROBABILITY' ? 'a probability' : 'coverage of assumed inputs, not a probability'}` : '') +
    (c.settledP50 !== null ? `, median ${Math.round(c.settledP50).toLocaleString('en-US')}` : '') +
    (assumed.length ? `; assumed, not established: ${assumed.join(', ')}` : '') +
    (blocking.length ? `. ${blocking.map((p) => p.sentence).join(' ')}` : '');
  return {
    key: `candidate:${c.source.toLowerCase()}`,
    label: c.label,
    verdict: 'NEEDS_EVIDENCE',
    // Rows only: a constructed arrangement is no opening a decision record can read back (`readingOpportunityIds`).
    opportunityIds: c.opportunityIds.filter((id) => !isArrangementId(id)),
    arrangementIds: c.opportunityIds.filter((id) => isArrangementId(id)),
    links: [],
    constraintsFailed: [],
    sweep: { goalMetShare: c.reach, settledP50: c.settledP50, settledP90: null, infeasibleShare: null, probabilistic: c.reachBasis === 'PROBABILITY' },
    conservativeSettled: null,
    chainComplete: false,
    nextTest: null,
    basis,
  };
}

/**
 * The smallest evidence sample the engine's assurance read its bound over, or
 * 0 when it states none. Read from the assurance's structured sample (Q2-12),
 * never parsed out of its prose.
 */
export function assuranceSample(assurance: GoalPortfolio['assurance']): number {
  if (!assurance) return 0;
  const events = assurance.sample?.events;
  if (typeof events === 'number' && Number.isFinite(events) && events > 0) return Math.round(events);
  const sizes = (assurance.history ?? []).map((one) => one.sampleSize).filter((n): n is number => typeof n === 'number' && n > 0);
  return sizes.length > 0 ? Math.min(...sizes) : 0;
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
    if (!(await planAuthority(projectId, action)).ok) out.push(action);
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

/**
 * The quantile of a combination's settled distribution at `q`, read only from
 * the engine's own p10/p50/p90: linear between them, and held at p10 and p90
 * beyond — the tails outside them are not modelled, so they are never invented.
 */
export function settledQuantile(m: { p10: number; p50: number; p90: number }, q: number): number {
  if (q <= 0.1) return m.p10;
  if (q >= 0.9) return m.p90;
  if (q <= 0.5) return m.p10 + (m.p50 - m.p10) * ((q - 0.1) / 0.4);
  return m.p50 + (m.p90 - m.p50) * ((q - 0.5) / 0.4);
}

const OUTCOME_POINTS = 200;

/** Total collections per evenly spaced quantile: what is already held plus the combination's settled money. */
function settledWorlds(held: number, m: { p10: number; p50: number; p90: number }): number[] {
  return Array.from({ length: OUTCOME_POINTS }, (_, i) => held + settledQuantile(m, (i + 0.5) / OUTCOME_POINTS));
}

/** Whether the plan's probabilities rest on a calibrated source: an evidenced portfolio's assurance or this Brain's own record. */
export function planCalibration(acceptance: PlanAcceptance): Calibration {
  const p = acceptance.probability;
  // It covers the accepted plan's openings and no others (planSet.ts `calibrationFor`).
  const covers = acceptance.accepted ? [...acceptance.accepted.opportunityIds] : null;
  if (p && (p.basis === 'EVIDENCED_PORTFOLIO' || p.basis === 'MEASURED_RECORD')) return { calibrated: true, observations: p.sample, basis: `${p.basis}: ${p.note}`, covers };
  return { calibrated: false, observations: p?.sample ?? 0, basis: p?.basis === 'TARGET_MET' ? 'the ledger holds the target, which calibrates no model' : 'no calibrated source: coverage of assumed inputs is not a probability', covers };
}

/**
 * Days until a combination's modelled cash has settled: the slowest member's
 * own settlement, read from its transaction pathway (S-0199 cash velocity).
 *
 * The goal's days left is not a combination's settlement — feeding it to every
 * combination made cash velocity differ only by expected value, so a
 * fast-settling plan was never preferred for speed. A member whose settlement
 * is unknown, or that has no pathway, leaves the combination's settlement
 * unknown (null): velocity is then not read rather than invented. Pure.
 */
export function combinationDaysToCash(memberIds: readonly string[], pathways: readonly { opportunityId: string; daysToCash: { value: number | string | null; low: number | null; high: number | null; status: string } }[]): number | null {
  if (memberIds.length === 0) return null;
  let slowest = 0;
  for (const id of new Set(memberIds)) {
    const f = pathways.find((p) => p.opportunityId === id)?.daysToCash;
    if (!f || f.status === 'UNKNOWN' || f.status === 'DENIED') return null;
    const days = typeof f.value === 'number' ? f.value : f.low !== null && f.high !== null ? (f.low + f.high) / 2 : null;
    if (days === null || !Number.isFinite(days) || days < 0) return null;
    slowest = Math.max(slowest, days);
  }
  return slowest;
}

/**
 * The three readings the plan carries (GOAL-13-6, GOAL-18-4, GOAL-23), from
 * what the plan pass already composed. Pure: it reads, it decides nothing the
 * plan's own acceptance decides, and it owns no store, scheduler or authority.
 */
/**
 * Each arrangement's scenario conversion, for its plan candidate (W2b): the
 * one the goal model entered when it entered it, else the same conversion on
 * the project knowledge the model just read (`cachedCashKnowledge`, no new
 * read). Without knowledge the conversion sweeps, so nothing unestablished
 * becomes a candidate's field. Pure but for that cache.
 */
export function arrangementModels(
  arrangements: readonly ConstructedArrangement[],
  estimates: readonly ModelledOpportunity[],
  target: Pick<TargetReading, 'projectId' | 'currency' | 'daysLeft' | 'capitalBeforeProofCents'>,
  now = new Date(),
  conversions: ReadonlyMap<string, ModelledOpportunity | null> | null = null,
): Map<string, ModelledOpportunity> {
  const out = new Map<string, ModelledOpportunity>();
  for (const one of estimates) if (one.estimated?.arrangementKey) out.set(one.estimated.arrangementKey, one);
  const knowledge = cachedCashKnowledge(target.projectId);
  for (const a of arrangements) {
    if (out.has(a.key)) continue;
    // Selection already converted it (or found it has no conversion): never a second run (W2c).
    if (conversions?.has(a.key)) {
      const seen = conversions.get(a.key);
      if (seen) out.set(a.key, seen);
      continue;
    }
    const one = estimatedFromArrangement(a, { projectId: target.projectId, currency: target.currency, beforeProofCents: target.capitalBeforeProofCents, knowledge, now, daysLeft: target.daysLeft });
    if (one) out.set(a.key, one);
  }
  return out;
}

/**
 * The held plan's outcome split by support (`OutcomeSupport`). A leg that
 * lacks a channel, an offer at an established price, a fulfiller or settled
 * cash contributes nothing to the supported figure: with none supported that
 * figure is exactly what is already held, with every leg supported it is the
 * full figure, and between the two it is the engine's own reading of the
 * supported legs alone (`supported`), or not stated when none was made —
 * never interpolated. Pure.
 */
export function outcomeSupport(input: {
  objective: GoalObjective;
  held: number;
  remaining: number;
  ids: readonly string[];
  legs: LegFeasibility[] | null;
  full: SimulatedDistribution | null;
  fullOutcome: OutcomeReading | null;
  supported: SimulatedDistribution | null;
  read: (d: SimulatedDistribution, ids: readonly string[]) => OutcomeReading;
  titles?: ReadonlyMap<string, string>;
}): OutcomeSupport | null {
  const { legs } = input;
  if (!legs || legs.length === 0) return null;
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
  const ok = legs.filter((l) => l.supported).map((l) => l.opportunityId);
  const assumptionReach = input.full?.reach ?? null;
  if (ok.length === legs.length) {
    return { basis: 'SUPPORTED', legs, reach: assumptionReach, outcome: input.fullOutcome, assumptionReach, sentence: `every one of the ${legs.length} counted leg(s) has a reachable channel, an offer at an established price, a fulfiller and settled cash: the outcome is the plan's` };
  }
  let reach: number | null;
  let outcome: OutcomeReading | null;
  if (ok.length === 0) {
    // Nothing supported collects anything: what is already held is the whole supported figure.
    reach = input.remaining <= 0 ? 1 : 0;
    outcome = input.read({ reach, settledP10: 0, settledP50: 0, settledP90: 0 }, []);
  } else if (input.supported) {
    reach = input.supported.reach;
    outcome = input.read(input.supported, ok);
  } else {
    reach = null;
    outcome = null;
  }
  const full = input.fullOutcome;
  const sentence =
    `assumption-only coverage: ${assumptionReach === null ? 'any full figure would' : `the ${pct(assumptionReach)} reach${full ? ` and expected ${usd(full.expected)} (adverse ${usd(full.adverse)})` : ''}`} count ${legs.length - ok.length} of ${legs.length} leg(s) that cannot be executed yet (${lacksSentence(legs, input.titles)}); ` +
    (reach === null
      ? `the ${ok.length} supported leg(s) were not simulated on their own, so no supported figure is stated`
      : `over the ${ok.length} supported leg(s) alone it reaches the target in ${pct(reach)} of worlds${outcome ? `, expected ${usd(outcome.expected)}, adverse ${usd(outcome.adverse)}` : ''}`);
  return { basis: 'ASSUMPTION_ONLY', legs, reach, outcome, assumptionReach, sentence };
}

export function composeGoalReadings(input: {
  objective: GoalObjective;
  target: TargetReading;
  portfolio: GoalPortfolio | null;
  pathways: PathwayReading | null;
  arrangements: readonly ConstructedArrangement[];
  reconstruction: Reconstruction | null;
  acceptance: PlanAcceptance;
  /** Each opening's own ledger rows (`readOpeningLedger`): observed collections and executed sales, never modelled ones. */
  ledger?: ReadonlyMap<string, OpeningLedger> | null;
  /** Each arrangement's own scenario conversion, by arrangement key (`arrangementModels`): what its plan candidate reads its inputs from (W2b). */
  arrangementModels?: ReadonlyMap<string, ModelledOpportunity> | null;
  /**
   * The quant engine's reading over the held plan's supported legs alone
   * (`supportedDistribution`), when some legs are supported and some are not;
   * absent, that split is reported as not simulated.
   */
  supported?: SimulatedDistribution | null;
}): { timelines: TimelineReading; objective: ObjectiveReading; planSet: GoalPlanSet } {
  const { objective, target, portfolio, acceptance } = input;
  const calibration = planCalibration(acceptance);
  const remaining = Math.max(0, target.remainingCents / 100);
  const held = target.achievedCents / 100;

  const timelines = readTimelines({ target, pathways: input.pathways?.pathways ?? [], portfolio, acceptance });

  // Expected, upper and adverse outcomes of the strongest combination and each alternative (S-0199/S-0200).
  /*
   * The enforceable commitments a floor may count: one list, read by both the
   * objective reading and the plan set, so the two cannot answer differently
   * about the same plan.
   *
   * A recorded agreement (`agreedValue`) is not one. It records that a buyer
   * said yes; nothing on the modelled row shows the yes is signed, escrowed,
   * deposited or guaranteed, and S-0200 allows a true floor only from those
   * stronger commitments. Counting it made `objective.outcome.floor` non-null
   * while every plan's downside reported no floor — two answers for one goal —
   * and manufactured a floor from a promise. The agreement still counts where
   * it belongs: in the modelled settled cash. A row that establishes an
   * enforceable mechanism (FLOOR_MECHANISMS) is what would put an entry here.
   */
  const commitments: EnforceableCommitment[] = [];
  const committedTo = (opportunityIds: readonly string[]): number =>
    commitments
      .filter((c) => c.settlesInHorizon && c.sourceRowId !== null && opportunityIds.includes(c.sourceRowId))
      .reduce((sum, c) => sum + c.amount, 0);
  const combos = portfolio ? [portfolio.best, ...portfolio.alternatives].filter((c): c is NonNullable<GoalPortfolio['best']> => c !== null) : [];
  const keyOf = (c: (typeof combos)[number]) => c.members.map((m) => m.opportunityId).join('+');
  const readingOf = (c: SimulatedDistribution, ids: readonly string[]): OutcomeReading => {
    // The accepted combination's calibration is its own; an alternative beside it is not calibrated by it.
    const own = calibrationFor({ opportunityIds: [...new Set(ids)] }, calibration) ?? calibration;
    const r = readOutcome(objective, settledWorlds(held, { p10: c.settledP10, p50: c.settledP50, p90: c.settledP90 }), {
      calibrated: own.calibrated,
      commitments,
      cashOnHand: held,
      uncalibratedReason: `withheld: ${own.basis}; the plan stays a candidate`,
    });
    // Only the plan's own acceptance accepts: the outcome reading never promotes a candidate by itself.
    return acceptance.status === 'ACCEPTED' && r.status === 'ACCEPTED' ? r : { ...r, status: 'CANDIDATE' };
  };
  // One source: the plan the acceptance holds, read from the simulated worlds that gave its reach — never another combination's.
  const heldPlan = heldDistribution(acceptance, portfolio, input.reconstruction);
  const outcome = heldPlan ? readingOf(heldPlan.distribution, heldPlan.ids) : null;
  const support = outcomeSupport({
    objective,
    held,
    remaining,
    ids: heldPlan?.ids ?? acceptance.accepted?.opportunityIds ?? acceptance.candidate?.opportunityIds ?? [],
    legs: input.pathways ? legsOf(heldPlan?.ids ?? acceptance.accepted?.opportunityIds ?? acceptance.candidate?.opportunityIds ?? [], input.pathways.pathways, portfolio) : null,
    full: heldPlan?.distribution ?? null,
    fullOutcome: outcome,
    supported: input.supported ?? null,
    read: (d, ids) => readingOf(d, ids),
    titles: new Map((input.pathways?.pathways ?? []).map((p) => [p.opportunityId, p.title] as const)),
  });
  const counts = new Map<string, number>();
  for (const c of combos) for (const id of new Set(c.members.map((m) => m.opportunityId))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const readings = combos.map((c) => ({ c, r: readingOf(c, c.members.map((m) => m.opportunityId)) }));
  const trade = tradeOffs(
    objective,
    readings.map(({ c, r }) => {
      const others = readings.filter((o) => o.c !== c).map((o) => o.r.expected);
      return {
        key: keyOf(c),
        reading: r,
        daysToCash: combinationDaysToCash(c.members.map((m) => m.opportunityId), input.pathways?.pathways ?? []),
        sharedDependencies: [...new Set(c.members.map((m) => m.opportunityId))].filter((id) => (counts.get(id) ?? 0) > 1),
        forgoneAlternative: others.length > 0 ? Math.max(...others) : null,
      };
    }),
  );
  const objectiveReading: ObjectiveReading = {
    goal: objective,
    outcome,
    tradeOffs: trade,
    basis: outcome
      ? `the plan the acceptance holds, as the quant engine simulated it over ${portfolio?.worlds ?? 'its'} worlds (${(portfolio?.basis ?? 'COVERAGE').toLowerCase()}) — the same worlds its reach is read from — at its p10/p50/p90, added to the ${held} already held; tails beyond p10 and p90 are not modelled, so an adverse quantile below 10% reads at p10 and says less than it would on a calibrated tail`
      : acceptance.candidate || acceptance.accepted
        ? 'the plan held was not simulated as a combination, so no outcome is read: its pathway figures are contribution bounds, not a distribution; the threshold still binds as a minimum'
        : 'no combination of the openings held is modelled, so no outcome is read; the threshold still binds as a minimum',
    support,
  };

  // The candidate plans, proven distinct (GOAL-23).
  // Observed money and executed sales come from the opening's own ledger rows, never from its model (GOAL-23 clause 5).
  const fromPathways = (input.pathways?.pathways ?? []).map((p) => {
    const own = input.ledger?.get(p.opportunityId) ?? null;
    return candidateFromPathway(p, {
      enforceableCommitments: committedTo([p.opportunityId]),
      observedCollections: own?.observed ?? 0,
      // A sale a buyer agreed, paid or settled was carried out, so it was authorized; otherwise the pathway's own permissions decide.
      ...(own?.executed ? { attempts: { researched: true, authorized: true, executed: true } } : {}),
    });
  });
  const byId = new Map(fromPathways.map((c) => [c.id, c]));
  const variants = input.reconstruction ? [input.reconstruction.baseline, input.reconstruction.best, ...input.reconstruction.rounds.flatMap((r) => r.tried)] : [];
  const seen = new Set<string>();
  const fromStrategies: PlanCandidate[] = [];
  for (const v of variants) {
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    const c = candidateFromStrategy(v, byId);
    if (c) fromStrategies.push(c);
  }
  const candidates = [...fromPathways, ...input.arrangements.map((a) => candidateFromArrangement(a, input.arrangementModels?.get(a.key) ?? null)), ...fromStrategies];
  const condition: AcceptanceCondition = {
    amount: remaining,
    daysLeft: target.daysLeft,
    confidence: objective.requiredConfidence.value,
    capitalCeiling: target.capitalCeilingCents === null ? null : target.capitalCeilingCents / 100,
    breadth: null,
    objective: {
      expected: 1,
      upside: objective.targets.upside.source === 'STATED' ? 1 : 0.25,
      downside: objective.targets.downsideProtection.source === 'STATED' ? 1 : 0.25,
      velocity: target.daysLeft !== null ? 0.25 : 0,
      independence: 0.25,
    },
  };
  const set = buildPlanSet(candidates, condition, calibration);
  // The most important change is the shared channel or supplier the most plans fail with.
  const shared = [...set.resilience].sort((a, b) => b.fails.length - a.fails.length)[0] ?? null;
  const lead = set.plans[0] ?? null;
  const change: PlanChange | null = shared
    ? shared.kind === 'CHANNEL' ? { kind: 'CHANNEL_FAILED', channel: shared.shared } : { kind: 'SUPPLIER_FAILED', supplier: shared.shared }
    : lead?.channels[0]
      ? { kind: 'CHANNEL_FAILED', channel: lead.channels[0] }
      : lead?.suppliers[0]
        ? { kind: 'SUPPLIER_FAILED', supplier: lead.suppliers[0] }
        : null;
  const rebuild = change
    ? {
        ...rebuildAfter(candidates, change, condition, calibration),
        why: shared
          ? `${shared.fails.length} plan(s) share the ${shared.kind.toLowerCase()} “${shared.shared}”: it is the failure that takes the most alternatives with it`
          : `the leading plan's own ${change.kind === 'CHANNEL_FAILED' ? 'channel' : 'supplier'} “${change.kind === 'CHANNEL_FAILED' ? change.channel : change.supplier}” is its single point of failure`,
      }
    : null;
  const unattributedObserved = Math.max(0, Math.round((held - set.collections.observed) * 100) / 100);
  // One reading, one modelled figure: the plan the acceptance adopted, when it has a median (P5).
  const adopted = input.acceptance?.candidate ?? null;
  const collections =
    adopted && adopted.settledP50 !== null ? { ...set.collections, modelledP50: adopted.settledP50, modelledOf: adopted.label.slice(0, 200) } : set.collections;
  return { timelines, objective: objectiveReading, planSet: { ...set, collections, rebuild, unattributedObserved } };
}

/** Compact readings stored on a persisted reading's forecast, so the production record shows them (GOAL-13-6, GOAL-18-4, GOAL-23). */
export function readingsSummary(reading: Pick<PlanReading, 'timelines' | 'objective' | 'planSet' | 'continuation'>): Record<string, unknown> {
  const o = reading.objective;
  const s = reading.planSet;
  return {
    timelines: reading.timelines
      ? {
          shortestCovered: reading.timelines.shortestCovered,
          horizons: reading.timelines.horizons.map((h) => ({
            days: h.days,
            origins: h.origins,
            status: h.status,
            reach: h.reach.value,
            reachBasis: h.reach.basis,
            eligible: h.eligible.length,
            excluded: h.excluded.length,
            wedgesNeeded: h.economics.wedgesNeeded,
            wedgesAvailable: h.economics.wedgesAvailable,
            easiest: h.economics.easiest ? { label: h.economics.easiest.label, deals: h.economics.easiest.deals, netPerDeal: h.economics.easiest.netPerDeal } : null,
          })),
        }
      : null,
    objective: o
      ? {
          requiredConfidence: o.goal.requiredConfidence,
          meaning: o.goal.meaning,
          threshold: o.goal.threshold,
          continueBeyondThreshold: o.goal.continueBeyondThreshold,
          outcome: o.outcome
            ? {
                expected: o.outcome.expected,
                upper: o.outcome.upper,
                adverse: o.outcome.adverse,
                adverseQuantile: o.outcome.adverseQuantile,
                status: o.outcome.status,
                confidenceWithheld: o.outcome.confidenceWithheld,
                floor: o.outcome.floor,
                protection: o.outcome.protection,
                surplusForSuccessors: o.outcome.surplusForSuccessors,
                basis: o.support?.basis ?? null,
              }
            : null,
          support: o.support
            ? {
                basis: o.support.basis,
                reach: o.support.reach,
                assumptionReach: o.support.assumptionReach,
                expected: o.support.outcome?.expected ?? null,
                adverse: o.support.outcome?.adverse ?? null,
                legs: o.support.legs.map((l) => ({ opportunityId: l.opportunityId, lacks: l.lacks, permissions: l.permissions })),
                sentence: o.support.sentence,
              }
            : null,
        }
      : null,
    planSet: s
      ? {
          candidates: s.candidates,
          distinct: s.distinct,
          accepted: s.accepted,
          provisional: s.provisional,
          collapses: s.collapses.length,
          doubleCounted: s.doubleCounted.length,
          attempts: s.attempts,
          collections: s.collections,
          unattributedObserved: s.unattributedObserved,
          confidence: s.confidence,
          plans: s.plans.slice(0, 12).map((p) => ({ id: p.id, source: p.source, signature: p.signature, acceptance: p.acceptance, gaps: p.gaps.map((g) => g.field) })),
          rebuild: s.rebuild ? { change: s.rebuild.change, why: s.rebuild.why, removed: s.rebuild.removed.length, reconstructed: s.rebuild.reconstructed.length, surviving: s.rebuild.surviving.length } : null,
        }
      : null,
    continuation: reading.continuation ?? null,
  };
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
  // What failed while composing this reading: carried on it and recorded, never silently thinner (C-13).
  const degraded: string[] = [];
  // The goal's constructed arrangements compete in its model on their estimates (§82, owner 2026-11-06).
  const arrangements = await goalArrangements(goal, target, now).catch((error: unknown) => {
    degraded.push(`construction: ${errorText(error)} (the plan was read without constructed arrangements)`);
    return [] as ConstructedArrangement[];
  });
  trace(`constructed ${arrangements.length}`);
  const constructionCut = lastConstructionReport(target.projectId);
  // A cap that left candidates uncomposed is said, never silent (K-2): they stay in the space, ranked below the cut.
  if (constructionCut && constructionCut.cut > 0) {
    degraded.push(
      `construction cap: ${constructionCut.composed} of ${constructionCut.considered} candidate arrangements composed this pass — ${constructionCut.held} held as the plan's leaders, ${constructionCut.evidenced} on observed or verified evidence${constructionCut.evidencedCut > 0 ? ` (${constructionCut.evidencedCut} more evidenced beyond the cap)` : ''}, ${constructionCut.rotated} in rotation; ${constructionCut.cut} ranked below the cap were not, ${constructionCut.neverComposed} never composed yet (${constructionCut.reused} reused from the library)`,
    );
  }
  // The deliverables Brain has proved: a found opening asking for one is Brain's to perform, as a constructed design over it is.
  const delivers = (await executionFrame(target.projectId, target.currency))?.delivers ?? [];
  const model = await composeGoalModel({ goal, target, now, arrangements, delivers });
  trace('composed');
  const measuredChance = await measuredPlanChance();
  // The goal's configured objective (GOAL-18-4): its own required confidence, or the recorded default, governs acceptance.
  const objective = goalObjective({ ...goal, target: { amountCents: target.targetCents } }, now, RECOMMENDATION_POLICY.requiredProbability);
  const required = objective.requiredConfidence.value;
  const base = { goalId: goal.id, target, excluded: model.excluded, measuredChance };
  const outcomeRecorded = await goalOutcomeRecorded(goal.id);
  if (model.refusal) {
    const refusedReconstruction = target.achieved ? null : await reconstructionFor(model, required, { goalId: goal.id, persist: !!input.persist, degraded, designer: goalDesigner(goal, target, now) });
    let refusedAcceptance = judgeAcceptance({ achieved: target.achieved, chosen: null, portfolio: model.portfolio, measuredChance, considered: [], objective });
    const refusedPlan = adoptReconstruction({ reconstruction: refusedReconstruction, baseline: model.portfolio, openings: planOpenings(model) });
    if (refusedPlan.candidate && refusedAcceptance.status !== 'ACCEPTED') {
      refusedAcceptance = { ...refusedAcceptance, status: 'CANDIDATE_ONLY', candidate: refusedPlan.candidate, sentence: candidateSentence(refusedPlan.candidate, refusedAcceptance.required) };
    }
    const refusedInfeasible =
      refusedAcceptance.status === 'ACCEPTED' || agreedInReach(model.considered, target.daysLeft, countsNet(target.metric)) >= target.remainingCents / 100 - 0.5
        ? null
        : judgeFeasibility(feasibilityInput(refusedReconstruction, null, model.portfolio, target, refusedAcceptance.required));
    if (refusedInfeasible) refusedAcceptance = notSupported(refusedAcceptance, refusedInfeasible);
    /*
     * One lead (transfer test, 2026-11-19, goal wst_4f0c312400e1425dab2e): the
     * candidate was the adopted reconstruction while the construction still
     * described the best combination as held, so the reading named two leads.
     * The construction follows the candidate, exactly as the main path's does.
     */
    refusedAcceptance = {
      ...refusedAcceptance,
      construction: refusedAcceptance.candidate?.source === 'RECONSTRUCTED' ? constructionOf(refusedAcceptance.candidate, null, []) : (refusedAcceptance.construction ?? constructionOf(refusedAcceptance.candidate, null, [])),
    };
    const permissions = target.achieved ? [] : await missingPermissions(target.projectId);
    const qualify = qualifyTest(model.liveOpenings, model.excluded);
    const refusedModels = arrangementModels(arrangements, model.estimates ?? [], target, undefined, model.arrangementConversions ?? null);
    const refusedLead = leadingArrangement(inGoalScope(arrangements, model), { portfolio: model.portfolio, candidateIds: refusedAcceptance.candidate?.opportunityIds ?? [] });
    const refusedSteps = target.achieved || refusedInfeasible
      ? []
      : planSteps({ adoption: refusedPlan.adoption, reconstruction: refusedReconstruction, sales: [], nextTest: qualify, permissionsMissing: permissions, arrangement: refusedLead ? { arrangement: refusedLead, context: { ...arrangementStepContext(target, refusedModels.get(refusedLead.key) ?? null, { key: refusedLead.key, portfolio: model.portfolio }), unestimated: unestimatedLead(refusedLead, arrangements.length, refusedModels) } } : null, capital: capitalOf(target), measuredReply: measuredReplyOf(model.portfolio), titles: titlesOf(model), cashDays: cashDaysOf(model), daysLeft: target.daysLeft, capabilities: await readCapabilityInventory() });
    const refusedReadings = composeGoalReadings({ objective, target, portfolio: model.portfolio, pathways: null, arrangements, reconstruction: refusedReconstruction, acceptance: refusedAcceptance, arrangementModels: refusedModels });
    const refusedContinuation = continuationOf({
      achieved: target.achieved,
      daysLeft: target.daysLeft,
      outcomeRecorded,
      policy: goalExecutionPolicy(target),
      acceptance: refusedAcceptance.status,
      instantOnly: refusedInfeasible?.instantOnly,
      surplus: refusedReadings.objective.outcome?.surplusForSuccessors ?? Math.max(0, (target.achievedCents - target.targetCents) / 100),
    });
    const built: PlanReading = {
      ...base,
      verdict: target.achieved ? 'RECOMMENDABLE' : refusedInfeasible ? 'NOT_VIABLE' : 'NEEDS_EVIDENCE',
      summary: refusedInfeasible ? refusedAcceptance.sentence : refusedPlan.adoption.hypothetical ? `${model.refusal} The reconstruction is hypothetical: ${refusedPlan.adoption.reason}.` : model.refusal,
      acceptance: refusedAcceptance,
      chosen: null,
      strategies: [],
      nextTest: target.achieved || refusedInfeasible
        ? null
        : refusedPlan.adoption.source === 'RECONSTRUCTED' && refusedSteps[0]
          ? stepAsNextTest(refusedSteps[0], refusedReconstruction)
          : qualify,
      scenarioModelId: null,
      scenarioRunId: null,
      basisNote: null,
      refusal: model.refusal,
      bestReach: null,
      considered: [],
      // No accepted plan: keep constructing while there is time (a goal without a deadline always has),
      // never past its deadline or outcome, and never on a goal arithmetic rules out (C-10).
      needsMoreOpenings: refusedContinuation.continues,
      inferred: inferredInputs(model.considered),
      researchPriority: planResearchPriority({
        reconstruction: refusedReconstruction,
        adoption: refusedPlan.adoption,
        adoptedIds: refusedAcceptance.candidate?.opportunityIds ?? [],
        daysLeft: target.daysLeft,
        remaining: target.remainingCents / 100,
        legacy: [],
      }),
      pool: { conclusion: 'NO_POOL', sentence: `No opening held is far enough along to model (${model.considered.length} read). That is a statement about what Brain holds, not about what exists, so it keeps searching and constructing.` },
      ladder: emptyLadder(),
      marketTests: [],
      executionPolicy: goalExecutionPolicy(target),
      sales: [],
      portfolio: model.portfolio,
      ...unpricedForPlan(model.arrangementSelection?.unpriced, refusedLead),
      lead: leadOf(refusedLead, refusedLead ? (refusedModels.get(refusedLead.key) ?? null) : null, model.arrangementsInScope ?? null),
      researchDiagnosis: [
        ...reconstructionDiagnosis(refusedReconstruction, { remaining: target.remainingCents / 100, daysLeft: target.daysLeft }),
        ...diagnoseGoalResearch({
          considered: [],
          excludedReasons: model.excluded.filter((one) => one.rule !== 'STOPPED').map((one) => one.reason),
          rounds: await recentGoalRounds(target.projectId, goal.id),
          remaining: target.remainingCents / 100,
        }),
      ],
      pathways: null,
      reconstruction: refusedReconstruction,
      adoption: refusedPlan.adoption,
      steps: refusedSteps,
      stepsMissing: missingTransactionStages(refusedSteps),
      infeasible: refusedInfeasible,
      degraded,
      ...refusedReadings,
      continuation: refusedContinuation,
    };
    // The plan's integrity (`planIntegrity`): a reading that breaks a rule is never ACCEPTED.
    const committeeContext = await committeeContextOf(goal.id, target.projectId, now);
    degraded.push(...committeeContext.degraded);
    const reading = gateIntegrity(
      built,
      (acceptance) => ({
        ...composeGoalReadings({ objective, target, portfolio: model.portfolio, pathways: null, arrangements, reconstruction: refusedReconstruction, acceptance, arrangementModels: refusedModels }),
        continuation: continuationOf({ achieved: target.achieved, daysLeft: target.daysLeft, outcomeRecorded, policy: goalExecutionPolicy(target), acceptance: acceptance.status, instantOnly: refusedInfeasible?.instantOnly, surplus: refusedContinuation.surplusForSuccessors }),
      }),
      committeeContext,
    );
    if (input.persist) {
      // The committee's specialists are asked in the background when due; the next read binds their recorded answer.
      armSpecialistReview(goal.id, built, reading.committee, committeeContext, now);
      await recordDegraded(goal.id, target.projectId, degraded);
      await persistReading(goal, reading, null);
    }
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
  // A net target is read net everywhere the plan compares progress with it (`countsNet`).
  const net = countsNet(target.metric);
  const checksOf = new Map(model.considered.map((one) => [one.opportunity.id, linkChecks(one, dealsForGoal(one, target.remainingCents / 100, net), target, capabilities, now)]));
  const considered: ConsideredOpening[] = model.considered.map((one) => ({
    opportunityId: one.opportunity.id,
    title: one.opportunity.title,
    modelled: modelledIds.has(one.opportunity.id),
    missing: checksOf.get(one.opportunity.id)!
      .filter((check) => !check.ok)
      .map((check) => check.link),
    stage: validationStage(one, checksOf.get(one.opportunity.id)!, target, collected.has(one.opportunity.id)),
    supportedReach: one.agreed || priceSupported(one) ? bestCaseReach(one, target.remainingCents / 100, target.daysLeft ?? 0, true, net) : 0,
    potentialReach:
      one.agreed || one.price.value !== null || one.price.high !== null
        ? bestCaseReach(one, target.remainingCents / 100, target.daysLeft ?? 0, false, net)
        : null,
    competitiveAward: one.competitiveAward,
    volumeEstablished: one.repeatable ? volumeEstablished(one) : one.volume.provenance === 'EVIDENCE',
    paysOnce: one.competitiveAward || PAYS_ONCE.test(one.opportunity.title),
  }));
  considered.sort((a, b) => a.missing.length - b.missing.length || b.supportedReach - a.supportedReach);
  recordMateriality(goal.id, target.remainingCents / 100, considered);
  trace('considered openings judged');
  const strategies: StrategyReading[] = [];
  /** Strategies whose every member is a route still awaiting its research, with those members. */
  const awaitingResearch = new Map<string, ModelledOpportunity[]>();
  for (const spec of model.definition.strategies) {
    const members = withoutSpareCapitalLots(
      withoutSpareOwnerWork(
        withoutLossMakingLots(
          withoutUnestablishedLots(
            model.included.map((one) => ({ one, deals: Number(spec.set[`o${one.index}_n`] ?? 0) })).filter((member) => member.deals > 0 || member.one.agreedValue > 0),
            target,
            ({ one, deals }) => linkChecks(one, deals, target, capabilities, now).some((check) => !check.ok),
          ),
          target,
        ),
        target,
      ),
      target,
    );
    const links = CHAIN_LINKS.map((link) => {
      const checks = members.map(({ one, deals }) => linkChecks(one, deals, target, capabilities, now).find((check) => check.link === link)!);
      return { link, ok: checks.every((check) => check.ok), basis: checks.map((check) => check.basis).join(' | ') };
    });
    const constraintsFailed: string[] = [];
    for (const { one, deals } of members) {
      if (one.capital.value !== null && one.capital.provenance !== 'UNKNOWN') {
        const ceiling = target.capitalCeilingCents;
        // Lots run one after another as their cash settles: the money held at once, never the sum of every lot.
        const settles = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' ? one.daysToCash.value : null;
        const tied = lotsUnderCeiling(dealsTaken(one, deals) - one.agreedDeals + agreedLots(one), settles, target.daysLeft, one.capital.value, ceiling === null ? null : ceiling / 100).atOnce * one.capital.value;
        if (ceiling !== null && tied > ceiling / 100) constraintsFailed.push(`"${one.opportunity.title.slice(0, 60)}" ties up ${Math.round(tied)} ${target.currency}, more than the ${ceiling / 100} the owner said this goal may commit, held at once`);
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
    /*
     * A route Brain proposed whose deep dive has not settled (`researchBeforeSale`)
     * has no price buyers are shown to pay because nobody has looked yet, not
     * because research found none. Production, 2026-11-25: goals holding only
     * such routes read NOT_VIABLE "at most 0". Its hypothesis is never reach;
     * it only says whether the research could make the plan reach, and while it
     * could, the plan is waiting on that research (NEEDS_EVIDENCE), not refuted.
     */
    const awaitingDive = members.filter(({ one }) => researchBeforeSale(one) !== null && !priceSupported(one));
    if (members.length > 0 && awaitingDive.length === members.length) awaitingResearch.set(spec.key, members.map(({ one }) => one));
    const reachOf = (counting: ReadonlySet<ModelledOpportunity>) =>
      members.reduce((sum, { one, deals }) => {
        const late = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' && target.daysLeft !== null && one.daysToCash.value > target.daysLeft;
        // An award not yet shown to pay in time is not reach: it must be won first.
        const unproven = one.competitiveAward && one.daysToCash.provenance !== 'EVIDENCE' && one.daysToCash.provenance !== 'HISTORICAL';
        if (late) return sum;
        // Agreed money is reach. New deals are reach only at a price buyers are
        // shown to pay — never at a guessed or listed one.
        // A repeatable play takes no more deals than research shows the market holds.
        // A counted market already holds the buyers who agreed: they are agreed money, never fresh deals too (`buyersLeft`).
        const taken = volumeEstablished(one) && one.repeatable ? Math.min(deals, buyersLeft(one) ?? deals) : deals;
        const fresh = unproven || !(priceSupported(one) || counting.has(one)) ? 0 : taken;
        // On a net target the best case is net too: the top price less the lowest cost of each deal, agreed ones included.
        const kept = net ? agreedToward(one, true, 'LOW') - fresh * costPerDeal(one, 'LOW') : one.agreedValue;
        return sum + kept + fresh * (one.price.high ?? one.price.value ?? 0);
      }, 0);
    const best = reachOf(new Set());
    let pendingDives: string[] = [];
    if (best < target.remainingCents / 100) {
      const ifResearchHolds = awaitingDive.length > 0 ? reachOf(new Set(awaitingDive.map(({ one }) => one))) : best;
      if (ifResearchHolds >= target.remainingCents / 100) pendingDives = awaitingDive.map(({ one }) => one.opportunity.title);
      else constraintsFailed.push(`cannot reach the ${target.remainingCents / 100} ${target.currency} still needed${net ? ' (net of direct costs)' : ''} at prices buyers are shown to pay, even if every buyer it offers to agreed (at most ${Math.round(best)})`);
    }
    bestReach = Math.max(bestReach, best);
    /*
     * The owner's way of spending: little first, the rest once money comes in,
     * spread over time. A plan has to be able to start that way — some step
     * that can pay with no more tied up than the test allows — and an award
     * that pays one lump at the end, after somebody else decides, cannot.
     *
     * Pacing is something the owner set: a before-proof figure or a weekly
     * one. A ceiling only assumed from words like "no up-front capital"
     * (`scope.capitalAssumed`) limits what is tied up and is enforced as such;
     * it says nothing about money arriving in steps (planningReliability
     * round 10), so an award that ties nothing up is not refused for paying
     * in one lump.
     */
    const paced = pacedByOwner(target);
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
    const cons = conservative(members, target);
    /*
     * Recycled lots that cannot all settle in time (`lotsUnderCeiling`): the
     * ceiling holds fewer lots at once than the timing needs, so some settle
     * after the deadline, and without them the plan falls short. Both limits
     * bind together, and the conclusion names both — never a bare shortfall.
     */
    if (target.capitalCeilingCents !== null && cons.settled !== null && cons.settled < target.remainingCents / 100) {
      const unconstrained = conservative(members, { ...target, capitalCeilingCents: null });
      if (unconstrained.settled !== null && unconstrained.settled >= target.remainingCents / 100) {
        constraintsFailed.push(
          `run one after another inside the ${target.capitalCeilingCents / 100} ${target.currency} the owner said this goal may commit, the lots that settle before the deadline bring ${Math.round(cons.settled)} of the ${target.remainingCents / 100} still needed; the rest settle after the deadline`,
        );
      }
    }
    /*
     * Agreed work the owner performs is owner hours (planningReliability ho-07,
     * 2026-11-21): ten signed translations at 6 owner hours each are 60 hours
     * against 13, yet only new deals were ever counted, so the agreements read
     * as free money. What is already signed is committed, so it breaks the limit.
     */
    if (target.hoursCeiling !== null) {
      const agreedHours = members.reduce((sum, { one }) => sum + (one.hours.value !== null && one.hours.provenance !== 'UNKNOWN' ? one.agreedDeals * one.hours.value : 0), 0);
      if (agreedHours > target.hoursCeiling + 1e-9) {
        constraintsFailed.push(`the agreed deals need ${Math.round(agreedHours * 10) / 10} owner hours, more than the ${Math.round(target.hoursCeiling * 10) / 10} owner hours this goal has`);
      }
    }
    if (sweep.infeasibleShare === 1) {
      const run = result?.strategies.find((one) => one.key === spec.key);
      constraintsFailed.push(...everyCaseInfeasible(run?.violations, run?.evaluated ?? 0, members, target, { exposure: cons.exposure }));
    }
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
    // An assumed ceiling ("little up-front capital", no figure) is still a question for the owner, never their answer.
    const askCapital = verdict === 'RECOMMENDABLE' && capitalQuestionOpen(target, cons.exposure ?? 0);
    if (askCapital) verdict = 'NEEDS_EVIDENCE';
    let nextTest: NextTest | null = null;
    if (askCapital) {
      nextTest = {
        link: 'ECONOMICS',
        test: `This plan ties up about ${Math.round(cons.exposure!)} ${target.currency} before it pays. Say how much this goal may commit, or that it may commit none.`,
        by: 'PERSON',
        blocker: 'The owner has not said how much money this goal may commit.',
      };
    } else if (verdict === 'NEEDS_EVIDENCE' && pendingDives.length > 0) {
      // The plan reaches only if its routes' research holds: that research is the step, and Brain is doing it.
      const names = pendingDives.slice(0, 4).map((title) => `"${title.slice(0, 60)}"`).join(', ');
      nextTest = {
        link: 'OFFER_AND_PRICE',
        test: `Research first: the deep dive${pendingDives.length === 1 ? '' : 's'} on ${names}${pendingDives.length > 4 ? ` and ${pendingDives.length - 4} more` : ''} establish${pendingDives.length === 1 ? 'es' : ''} or refute${pendingDives.length === 1 ? 's' : ''} the buyer, price and demand each route proposal assumed; the plan is judged on what they find.`,
        by: 'BRAIN',
        blocker: null,
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
      dealsTaken: members.map(({ one, deals }) => ({ opportunityId: one.opportunity.id, deals: dealsTaken(one, deals) })),
      chainComplete: verdict === 'RECOMMENDABLE',
      nextTest,
      basis: 'the openings found, judged at prices buyers are shown to pay',
    });
  }

  const awardIds = new Set(model.included.filter((one) => one.competitiveAward).map((one) => one.opportunity.id));
  const awards = (s: StrategyReading) => s.opportunityIds.filter((id) => awardIds.has(id)).length;
  const rank = (s: StrategyReading) => (s.verdict === 'RECOMMENDABLE' ? 0 : s.verdict === 'NEEDS_EVIDENCE' ? 1 : 2);
  /*
   * Before any route is researched, every figure on it is the proposal's own
   * hypothesis, so the numbers below cannot tell a strong route from a weak
   * one. Independent judge, 2026-11-25: in each of the 3 goals that held a
   * credible route, the plan chose a weaker one. Between two strategies made
   * only of routes awaiting research, the one whose routes its critique
   * ranked best (`ROUTE_RANK_FIELD`, on average) comes first; anything researched is
   * judged on its evidence as before.
   */
  const routeRanks = new Map<string, number>();
  for (const id of new Set([...awaitingResearch.values()].flat().map((one) => one.opportunity.id))) {
    const place = routeRankOf((await cardFact(id, ROUTE_RANK_FIELD).catch(() => null))?.value);
    if (place !== null) routeRanks.set(id, place);
  }
  const meanRouteRank = (s: StrategyReading) => {
    const members = awaitingResearch.get(s.key);
    if (!members) return null;
    const ranks = members.map((one) => routeRanks.get(one.opportunity.id)).filter((n): n is number => n !== undefined);
    // The mean place: a strategy that adds weaker routes to the best one ranks after the best one alone.
    return ranks.length === members.length ? ranks.reduce((sum, n) => sum + n, 0) / ranks.length : null;
  };
  const byRouteRank = (a: StrategyReading, b: StrategyReading) => {
    const ra = meanRouteRank(a);
    const rb = meanRouteRank(b);
    return ra !== null && rb !== null ? ra - rb : 0;
  };
  const ordered = [...strategies].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      byRouteRank(a, b) ||
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
  const permissionsMissing = await missingPermissions(target.projectId);
  // The reasoning loop reads what the plan composed; it decides nothing the plan already decides (§93).
  const pathways = readPathways({
    modelled: [...model.considered, ...(model.estimates ?? [])],
    considered,
    target,
    portfolio: model.portfolio,
    permissionsMissing,
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
  let acceptance = judgeAcceptance({ achieved: target.achieved, chosen, portfolio: model.portfolio, measuredChance, considered, pathways, objective });
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
  const reconstruction = acceptance.status !== 'ACCEPTED' ? await reconstructionFor(model, acceptance.required, { goalId: goal.id, persist: !!input.persist, degraded, designer: goalDesigner(goal, target, now) }) : null;
  trace('reconstruction');
  /*
   * One plan (C-6). The reconstruction's strongest plan, when it beats the plan
   * as held and nothing flags it implausible, is the candidate, the next step
   * and the sales order; otherwise the plan as held is, and the reading says
   * the reconstruction is hypothetical.
   */
  const plan = adoptReconstruction({ reconstruction, baseline: model.portfolio, openings: planOpenings(model) });
  if (plan.candidate && acceptance.status !== 'ACCEPTED') {
    const adoptedLegs = legsOf(plan.candidate.opportunityIds, pathways.pathways, model.portfolio);
    const adoptedCandidate = withLegSupport(plan.candidate, adoptedLegs);
    acceptance = { ...acceptance, status: 'CANDIDATE_ONLY', candidate: adoptedCandidate, ...(adoptedLegs ? { legs: adoptedLegs } : {}), sentence: candidateSentence(adoptedCandidate, acceptance.required) };
  }
  // The goal as stated, judged on arithmetic rather than on the openings found (C-10, §65).
  // Or on measurements alone: every opening held bounded by a counted market or by the goal's own limits (round 13).
  const infeasible =
    acceptance.status === 'ACCEPTED' || target.achieved
      ? null
      : ((agreedInReach(model.considered, target.daysLeft, net) >= target.remainingCents / 100 - 0.5 ? null : judgeFeasibility(feasibilityInput(reconstruction, pathways.structures, model.portfolio, target, acceptance.required))) ??
        judgeHeldMarkets({
          openings: model.considered.filter((one) => !isArrangementId(one.opportunity.id)),
          remaining: target.remainingCents / 100,
          net,
          limits: { daysLeft: target.daysLeft, capitalCeiling: target.capitalCeilingCents === null ? null : target.capitalCeilingCents / 100 },
          required: acceptance.required,
        }));
  // What would resolve the no-plan conclusion's blocker (§3a): advice beside the verdict, never a change of it.
  const resolutions = acceptance.status === 'ACCEPTED' ? [] : resolutionsOf(strategies, model.included, target, acceptance);
  // A held-market conclusion computed its own relaxations; a limit it found would not rescue the goal is not offered.
  if (infeasible && !infeasible.heldMarkets) relaxAlso(infeasible, resolutions);
  if (infeasible) acceptance = notSupported(acceptance, infeasible);
  // The verdict follows the plan adopted: a reconstructed candidate is constructed from its own reading, not the baseline's.
  acceptance = {
    ...acceptance,
    verdict: verdictOf(acceptance),
    construction: acceptance.candidate?.source === 'RECONSTRUCTED' ? constructionOf(acceptance.candidate, null, []) : (acceptance.construction ?? constructionOf(acceptance.candidate, null, [])),
  };
  const adopted = plan.adoption.source === 'RECONSTRUCTED' ? new Set(acceptance.candidate?.opportunityIds ?? []) : null;
  const sales = policy === 'SQUEEZE' && !infeasible ? await salesFor(considered, model.portfolio, byIdOf(model), target, adopted) : [];
  const researchFirst = policy === 'SQUEEZE' && !infeasible ? heldForResearch(considered, byIdOf(model)) : [];
  exemptSales(goal.id, sales.map((one) => one.opportunityId));
  const legacyNext = goalNextStep({
    policy,
    verdict: chosen?.verdict ?? 'NEEDS_EVIDENCE',
    chosen: chosen?.nextTest ?? null,
    sales: sales.map((one) => one.test),
    marketTest: marketTests[0]?.test ?? null,
    bestReach,
    remaining: target.remainingCents / 100,
    currency: target.currency,
  });
  const models = arrangementModels(arrangements, model.estimates ?? [], target, undefined, model.arrangementConversions ?? null);
  const lead = leadingArrangement(inGoalScope(arrangements, model), { portfolio: model.portfolio, candidateIds: acceptance.candidate?.opportunityIds ?? [] });
  const steps = infeasible || target.achieved
    ? []
    : planSteps({ adoption: plan.adoption, reconstruction, sales, nextTest: legacyNext, permissionsMissing, arrangement: lead ? { arrangement: lead, context: { ...arrangementStepContext(target, models.get(lead.key) ?? null, { key: lead.key, portfolio: model.portfolio }), unestimated: unestimatedLead(lead, arrangements.length, models), reachCost: arrangementReachCost(models.get(lead.key), pathways.pathways) } } : null, capital: capitalOf(target), measuredReply: measuredReplyOf(model.portfolio), titles: titlesOf(model), cashDays: cashDaysOf(model), daysLeft: target.daysLeft, capabilities: await readCapabilityInventory(), members: openingMembers(planOpenings(model), pathways.pathways, model.portfolio?.demand ?? []), lead: leadIdsOf({ acceptance, portfolio: model.portfolio }), ...(adopted ? { adoptedIds: adopted } : {}) });
  /*
   * A plan whose every collection lands after the deadline is not presented as
   * the plan (production baseline, 2026-11-24): it is excluded, with its reason,
   * and the goal's own next step stands in its place.
   */
  const lateCash = collectsOutsideWindow(steps, target.daysLeft);
  const excludedPlan = lateCash ? { steps: steps.map((one) => one.label), reason: `not presented as the plan: ${lateCash}` } : null;
  if (lateCash) steps.splice(0, steps.length);
  const openingsVerdict: PlanVerdict =
    acceptance.status === 'ACCEPTED' ? 'RECOMMENDABLE' : infeasible ? 'NOT_VIABLE' : plan.adoption.source === 'RECONSTRUCTED' ? 'NEEDS_EVIDENCE' : (chosen?.verdict ?? 'NEEDS_EVIDENCE');
  // One reading, one picture (P5): the candidate the acceptance adopted is a strategy of the reading, and a
  // NOT_VIABLE read only off the found openings does not stand beside it.
  const priceVariables = (model.estimates ?? []).flatMap((one) => (one.priceVariable ? [one.priceVariable] : []));
  const candidateStrategy = candidateStrategyReading(acceptance, strategies, priceVariables);
  if (candidateStrategy) strategies.push(candidateStrategy);
  const superseded = !infeasible && openingsVerdict === 'NOT_VIABLE' && candidateStrategy !== null && (candidateStrategy.sweep.goalMetShare ?? 0) > 0;
  const verdict: PlanVerdict = superseded ? 'NEEDS_EVIDENCE' : openingsVerdict;
  // The header names the leg the steps are written for, so a hypothetical reconstruction's own legs are never read as the plan's (§77).
  const stepsLeg = stepsLegOf(steps, lead, titlesOf(model));
  const hypotheticalNote = plan.adoption.hypothetical ? ` The reconstruction is hypothetical, not the plan: ${plan.adoption.reason}.${stepsLeg ? ` The plan's steps are for ${stepsLeg}.` : ''}` : '';
  // No figure the reading cannot stand behind is shown as a reach (production baseline, 2026-11-24).
  const upsideSentence = acceptance.candidate?.assumedUpside?.sentence ?? null;
  const withheld = acceptance.status === 'ACCEPTED' ? [] : withholdImplausibleFigures(strategies, acceptance.candidate, target.remainingCents / 100);
  if (upsideSentence && !acceptance.candidate?.assumedUpside) acceptance = { ...acceptance, sentence: acceptance.sentence.replace(upsideSentence, 'its assumed upside is withheld as implausible') };
  const presentedNote = `${excludedPlan ? ` The steps found are ${excludedPlan.reason}.` : ''}${withheld.length > 0 ? ` Figures withheld: ${withheld.join('; ')}.` : ''}`;
  const summaryHead =
    verdict === 'RECOMMENDABLE'
      ? acceptance.sentence
      : infeasible
        ? acceptance.sentence
        : plan.adoption.source === 'RECONSTRUCTED'
          ? `The plan is the reconstruction: ${acceptance.candidate!.label.slice(0, 200)} — ${plan.adoption.reason}. First step: ${steps[0] ? `${steps[0].label} (${steps[0].owner})` : 'sell'}. ${acceptance.sentence}`
          : superseded
            ? `${candidateStrategy!.basis}; the openings found cannot reach the target at prices buyers are shown to pay (at most ${Math.round(bestReach)} ${target.currency}). ${acceptance.sentence}${hypotheticalNote}`
            : chosen?.chainComplete
            ? `"${chosen.label}" is a qualified candidate, not an accepted plan: ${acceptance.sentence}${hypotheticalNote}`
            : verdict === 'NOT_VIABLE'
              ? `No modelled strategy can work under the current limits: ${chosen?.constraintsFailed[0] ?? 'every one fails a limit'}.${hypotheticalNote}`
              : `Not yet proven. The closest plan is "${chosen?.label}", and what it is missing first is ${CHAIN_LABEL[(chosen?.nextTest ?? legacyNext)?.link ?? 'OFFER_AND_PRICE']}.${chosen?.nextTest?.test.startsWith('Research first:') ? ` ${chosen.nextTest.test}` : ''}${hypotheticalNote}`;
  const summary = `${summaryHead}${presentedNote}`;
  // The adopted plan's first step is the goal's next step, unless an owner's own decision about the goal comes first.
  const ownerDecision = chosen?.nextTest && chosen.nextTest.by === 'PERSON' && chosen.nextTest.link === 'ECONOMICS' ? chosen.nextTest : null;
  const nextTest = infeasible
    ? null
    : plan.adoption.source === 'RECONSTRUCTED' && steps[0] && acceptance.status !== 'ACCEPTED'
      ? (ownerDecision ?? stepAsNextTest(steps[0], reconstruction))
      : goalNextStep({
          policy,
          verdict: openingsVerdict,
          chosen: chosen?.nextTest ?? null,
          sales: sales.map((one) => one.test),
          marketTest: marketTests[0]?.test ?? null,
          bestReach,
          remaining: target.remainingCents / 100,
          currency: target.currency,
        });
  const pool = poolConclusion(bestReach, target, considered.filter((one) => !isArrangementId(one.opportunityId)).length);
  // The held plan over its supported legs alone, when some are supported and some are not: the figure the reading may
  // present as the plan's. Started before the ledger read so the evaluator's threads and the database wait overlap.
  const supportedRead = supportedDistribution(model, acceptance, pathways, degraded);
  // Observed until it is awaited below, so a rejection during the ledger read is not an unhandled one.
  supportedRead.catch(() => undefined);
  let ledger: Map<string, OpeningLedger> | null = null;
  try {
    ledger = await readOpeningLedger(target);
  } catch (error) {
    degraded.push(`opening ledger: ${errorText(error)} (the plan set reads no observed collections or executed sales)`);
  }
  const supported = await supportedRead;
  const readings = composeGoalReadings({ objective, target, portfolio: model.portfolio, pathways, arrangements, reconstruction, acceptance, ledger, arrangementModels: models, supported });
  const continuation = continuationOf({
    achieved: target.achieved,
    daysLeft: target.daysLeft,
    outcomeRecorded,
    policy,
    acceptance: acceptance.status,
    instantOnly: infeasible?.instantOnly, heldMarkets: infeasible?.heldMarkets,
    // Surplus is financed only by what supported legs collect: an assumption-only outcome finances nothing.
    surplus: planOutcomeOf(readings.objective)?.surplusForSuccessors ?? Math.max(0, (target.achievedCents - target.targetCents) / 100),
  });
  const built: PlanReading = {
    ...base,
    verdict,
    summary,
    acceptance,
    // The evidence gate's choice among the found openings' strategies; the candidate stands beside it in `strategies`.
    chosen: chosen?.key ?? null,
    strategies,
    priceVariables,
    // A SQUEEZE goal's next step is a sale when one can be offered; evidence work runs beside it.
    // An owner's open decision (how much may be committed) still comes first: it is theirs, and it binds the sale.
    nextTest,
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
    // No accepted plan means keep constructing, modifying, combining and comparing (owner, 2026-11-09) —
    // but never past the deadline or a recorded outcome, nor on a goal arithmetic rules out (C-10).
    needsMoreOpenings: continuation.continues,
    inferred: inferredInputs(model.considered),
    // The questions the plan Brain holds needs answered, then the run's own (C-9).
    researchPriority: [...resolutions.map((one) => one.priority), ...planResearchPriority({
      reconstruction,
      adoption: plan.adoption,
      adoptedIds: acceptance.candidate?.opportunityIds ?? [],
      daysLeft: target.daysLeft,
      remaining: target.remainingCents / 100,
      legacy: researchPriority(result, model.included, target, chosen?.key ?? null),
    })],
    // The pool, the ladder and the diagnosis are about openings found; an estimate is none of them.
    pool: infeasible
      ? { ...pool, sentence: infeasible.heldMarkets ? `${pool.sentence} The openings held cannot reach the goal on their measured markets and limits; the search continues for openings outside them.` : `${pool.sentence} The goal as stated is not supported by arithmetic, so the search stops until its terms or inputs change.` }
      : pool,
    ladder: ladderOf(considered.filter((one) => !isArrangementId(one.opportunityId))),
    marketTests,
    executionPolicy: policy,
    sales,
    ...(researchFirst.length > 0 ? { researchFirst } : {}),
    portfolio: model.portfolio,
    ...unpricedForPlan(model.arrangementSelection?.unpriced, lead),
    lead: leadOf(lead, lead ? (models.get(lead.key) ?? null) : null, model.arrangementsInScope ?? null),
    // The method's own failures first: they change how Brain searches, not one opening (§93).
    researchDiagnosis: mergeDiagnosis(
      [...reconstructionDiagnosis(reconstruction, { remaining: target.remainingCents / 100, daysLeft: target.daysLeft }), ...pathways.failures],
      diagnoseGoalResearch({
        considered: found,
        excludedReasons: model.excluded.filter((one) => one.rule !== 'STOPPED').map((one) => one.reason),
        rounds,
        remaining: target.remainingCents / 100,
      }),
    ),
    pathways,
    reconstruction,
    adoption: plan.adoption,
    steps,
    stepsMissing: missingTransactionStages(steps),
    ...(excludedPlan ? { excludedPlan } : {}),
    ...(withheld.length > 0 ? { figuresWithheld: withheld } : {}),
    infeasible,
    degraded,
    ...readings,
    continuation,
  };
  // The plan's integrity (`planIntegrity`), checked on the steps, the lead and every text a person reads: a reading that breaks a rule is never ACCEPTED.
  const committeeContext = await committeeContextOf(goal.id, target.projectId, now);
  degraded.push(...committeeContext.degraded);
  const reading = gateIntegrity(
    built,
    (refused) => {
      const again = composeGoalReadings({ objective, target, portfolio: model.portfolio, pathways, arrangements, reconstruction, acceptance: refused, ledger, arrangementModels: models, supported });
      return { ...again, continuation: continuationOf({ achieved: target.achieved, daysLeft: target.daysLeft, outcomeRecorded, policy, acceptance: refused.status, instantOnly: infeasible?.instantOnly, heldMarkets: infeasible?.heldMarkets, surplus: continuation.surplusForSuccessors }) };
    },
    committeeContext,
  );
  if (input.persist) {
    // The committee's specialists are asked in the background when due; the next read binds their recorded answer.
    armSpecialistReview(goal.id, built, reading.committee, committeeContext, now);
    await recordDegraded(goal.id, target.projectId, degraded);
    await persistReading(goal, reading, chosen);
    await pursueSales(goal, reading);
  }
  return reading;
}

/**
 * The quant engine over the held plan's supported legs alone (`OutcomeSupport`),
 * on the same inputs, limits and seed as the plan's own evaluation: run only when
 * some counted legs are supported and some are not — with none supported the
 * figure is what is held, and with all it is the plan's own. Null otherwise, or
 * when the evaluation fails (said in `degraded`).
 */
async function supportedDistribution(
  model: { portfolio: GoalPortfolio | null; portfolioInput?: Parameters<typeof reconstructPlan>[0]['portfolio'] & { openings: Parameters<typeof reconstructPlan>[0]['openings'] } | null },
  acceptance: PlanAcceptance,
  pathways: PathwayReading,
  degraded: string[],
): Promise<SimulatedDistribution | null> {
  const ids = acceptance.accepted?.opportunityIds.length ? acceptance.accepted.opportunityIds : (acceptance.candidate?.opportunityIds ?? []);
  const legs = legsOf(ids, pathways.pathways, model.portfolio) ?? [];
  const ok = new Set(legs.filter((l) => l.supported).map((l) => l.opportunityId));
  if (ok.size === 0 || ok.size === legs.length || !model.portfolioInput) return null;
  const already = simulatedCombination([...ok], model.portfolio);
  if (already) return already;
  const { openings, reserve: _reserve, knowledge: _knowledge, ...limits } = model.portfolioInput;
  const only = openings.filter((one) => ok.has(one.opportunity.id));
  if (only.length === 0) return null;
  try {
    const read = await heldEvaluation({ ...limits, openings: only, knowledge: null, causal: false }, async (one) => {
      const evaluator = sharedEvaluator();
      try {
        return await evaluator.evaluate(one);
      } finally {
        await evaluator.close();
      }
    });
    return read.best;
  } catch (error) {
    degraded.push(`supported-legs evaluation: ${errorText(error)} (no supported figure is stated)`);
    return null;
  }
}

/** How long a goal's exploration is reused while its inputs are unchanged (§101); after it, the library and the model get another turn. */
export const EXPLORATION_HELD_MS = 6 * 60 * 60_000;
const explored = new Map<string, { key: string; at: number; reconstruction: Reconstruction }>();

/** How often a goal's plan read asks the model to invent new ways of reasoning (§101). */
export const INVENT_EVERY_MS = 15 * 60_000;
const lastInvent = new Map<string, number>();
export function inventDue(goalId: string | undefined, now = Date.now()): boolean {
  const key = goalId ?? '';
  if (now - (lastInvent.get(key) ?? 0) < INVENT_EVERY_MS) return false;
  lastInvent.set(key, now);
  return true;
}

/**
 * The reconstruction loop over exactly what the portfolio was evaluated on;
 * null when there is nothing to reconstruct. It explores the plan from many
 * directions (§101): the methods that worked before, Brain's model inventing
 * new ones, all evaluated concurrently on the pool's threads. A persisted read
 * records what it learned, so the next read — of this goal or another —
 * starts from what worked.
 */
export async function reconstructionFor(
  model: { portfolio: GoalPortfolio | null; portfolioInput?: Parameters<typeof reconstructPlan>[0]['portfolio'] & { openings: Parameters<typeof reconstructPlan>[0]['openings'] } | null },
  required: number,
  context: { goalId?: string; persist?: boolean; degraded?: string[]; reconstruct?: typeof reconstructPlan; library?: typeof loadLibrary; stancePrior?: typeof loadStancePrior; designer?: () => Promise<NonNullable<ExploreContext['design']>> } = {},
): Promise<Reconstruction | null> {
  if (!model.portfolio || !model.portfolioInput || model.portfolioInput.openings.length === 0) return null;
  const degraded = context.degraded ?? [];
  const reconstruct = context.reconstruct ?? reconstructPlan;
  const { openings, ...portfolio } = model.portfolioInput;
  // Unchanged inputs are not re-explored: the same plan reads the same, and the CPU goes to goals whose inputs moved.
  const inputsKey = sha256(JSON.stringify({ openings, portfolio, required }));
  const held = context.goalId ? explored.get(context.goalId) : undefined;
  if (held && held.key === inputsKey && Date.now() - held.at < EXPLORATION_HELD_MS) return held.reconstruction;
  const evaluator = sharedEvaluator();
  try {
    const library = await (context.library ?? loadLibrary)().catch((error: unknown) => {
      degraded.push(`reasoning library: ${errorText(error)} (explored without the methods that worked before)`);
      return [];
    });
    // What each stance has yielded across goals allocates the seed budget (lens S, S-10); without it every stance is even.
    const stancePrior = await (context.stancePrior ?? loadStancePrior)().catch((error: unknown) => {
      degraded.push(`reasoning stance record: ${errorText(error)} (seeds allocated evenly across stances)`);
      return {};
    });
    const due = inventDue(context.goalId);
    const design =
      // Construction's rows are read only when a model will actually be asked: a read with no lane pays nothing for it.
      due && context.designer && inventEnabled()
        ? await context.designer().catch((error: unknown) => {
            degraded.push(`invented designs: ${errorText(error)} (the model was asked without a construction path for new designs)`);
            return null;
          })
        : null;
    const r = await reconstruct({
      openings,
      portfolio,
      baseline: model.portfolio,
      required,
      evaluator,
      // The model is asked at most every INVENT_EVERY_MS per goal; between, the library carries what it invented.
      // When it is asked, it may also invent designs for new buyers, composed by construction (S-11).
      explore: { library, stancePrior, ...(due ? { invent: (brief) => inventDirections(brief), ...(design ? { design } : {}) } : {}) },
    });
    if (context.goalId) {
      for (const [id, one] of explored) if (Date.now() - one.at >= EXPLORATION_HELD_MS) explored.delete(id);
      explored.set(context.goalId, { key: inputsKey, at: Date.now(), reconstruction: r });
    }
    if (context.persist && context.goalId && r.exploration) {
      // Credited once per (goal, inputs): a re-read of unchanged inputs is the same trial (lens S, S-9).
      await recordExploration(context.goalId, r.exploration, inputsKey).catch((error: unknown) => {
        degraded.push(`reasoning record: ${errorText(error)} (this exploration is not in the library)`);
      });
    }
    return r;
  } catch (error) {
    degraded.push(`reconstruction: ${errorText(error)} (the plan is read without a reconstruction)`);
    return null;
  } finally {
    await evaluator.close();
  }
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/\s+/g, ' ').slice(0, 300);
}

/** How often one goal's same kind of failure writes an event: a failure that persists is one row an hour, not one a read. */
export const DEGRADED_EVENT_EVERY_MS = 60 * 60_000;
const degradedAt = new Map<string, number>();

/**
 * Every failure a reading absorbed, recorded as a project event (C-13): a plan
 * read without its construction, library or reconstruction must be legible as
 * thinner, not mistaken for the full reading.
 */
export async function recordDegraded(goalId: string, projectId: string, degraded: readonly string[], now = Date.now()): Promise<number> {
  let written = 0;
  for (const one of degraded) {
    const stage = one.slice(0, one.indexOf(':') > 0 ? one.indexOf(':') : one.length);
    const key = `${goalId}:${stage}`;
    if (now - (degradedAt.get(key) ?? -Infinity) < DEGRADED_EVENT_EVERY_MS) continue;
    degradedAt.set(key, now);
    console.warn(`goal ${goalId}: plan read degraded — ${one}`);
    try {
      await recordEvent({ projectId, entityType: 'workstream', entityId: goalId, eventType: 'GOAL_PLAN_DEGRADED', payload: { stage, detail: one } });
      written += 1;
    } catch (error) {
      console.warn(`goal ${goalId}: could not record a degraded plan read: ${errorText(error)}`);
    }
  }
  return written;
}

/** Whether the goal's outcome (achieved or missed) is already on the record. */
async function goalOutcomeRecorded(goalId: string): Promise<boolean> {
  return !!(await getDb().get<{ id: string }>('SELECT id FROM goal_outcomes WHERE workstream_id = ? LIMIT 1', [goalId]));
}

/** Every opening the plan's model holds, for naming a reconstruction's members. */
/** Each opening's and estimate's title by its id, as the plan names them to a person. */
function titlesOf(model: Parameters<typeof planOpenings>[0]): Map<string, string> {
  return new Map(planOpenings(model).map((o) => [o.opportunity.id, o.opportunity.title] as const));
}

/** Each opening's days to usable cash as the model holds them, by its id: when a reconstruction's collection lands. */
function cashDaysOf(model: Parameters<typeof planOpenings>[0]): Map<string, { span: { low: number; high: number }; standing: string }> {
  const out = new Map<string, { span: { low: number; high: number }; standing: string }>();
  for (const one of planOpenings(model)) {
    const held = modelledCashSpan(one);
    if (held && !out.has(one.opportunity.id)) out.set(one.opportunity.id, held);
  }
  return out;
}

function planOpenings(model: { considered: ModelledOpportunity[]; estimates?: ModelledOpportunity[]; portfolioInput?: { openings: ModelledOpportunity[] } | null }): ModelledOpportunity[] {
  return [...(model.portfolioInput?.openings ?? []), ...model.considered, ...(model.estimates ?? [])];
}

/** What `judgeFeasibility` reads, from the reading's own parts; the goal's structures are computed when the pathways are not. */
function feasibilityInput(
  reconstruction: Reconstruction | null,
  structures: GoalStructures | null,
  portfolio: GoalPortfolio | null,
  target: TargetReading,
  required: number,
): Parameters<typeof judgeFeasibility>[0] {
  const contacts = portfolio?.limits.contactsPerDay;
  const s =
    structures ??
    (reconstruction && contacts
      ? requiredStructures({
          remaining: target.remainingCents / 100,
          daysLeft: target.daysLeft,
          currency: target.currency,
          perArrangement: target.capitalBeforeProofCents !== null ? target.capitalBeforeProofCents / 100 : null,
          spendCeiling: target.capitalCeilingCents !== null ? target.capitalCeilingCents / 100 : null,
          outreachPerDay: { low: contacts.low, high: contacts.high, stated: contacts.value !== null },
        })
      : null);
  return {
    reconstruction,
    structures: s,
    required,
    remaining: target.remainingCents / 100,
    daysLeft: target.daysLeft,
    capitalCeiling: target.capitalCeilingCents !== null ? target.capitalCeilingCents / 100 : null,
  };
}

/** What the reconstruction asks the next discovery round, as a diagnosis the goal round already reads (§89). */
export function reconstructionDiagnosis(r: Reconstruction | null, ctx?: { remaining: number; daysLeft: number | null }): ResearchDiagnosis[] {
  if (!r || !r.searchBrief) return [];
  const top = r.diagnosis[0];
  return [
    {
      cause: 'STRATEGY_RECONSTRUCTION',
      evidence: `the plan reaches ${(r.baseline.reach * 100).toFixed(1)}% as built and ${(r.best.reach * 100).toFixed(1)}% reconstructed (${r.best.basis.toLowerCase()}${r.established && r.established.key !== r.best.key ? `; ${(r.established.reach * 100).toFixed(1)}% without its assumed moves` : ''})${top ? `; ${top.factor} binds` : ''}${r.structural ? '; the openings held cannot reach the requirement at their best' : ''}${r.exploration ? `; explored: ${r.exploration.sentence}` : ''}`,
      instruction: ctx ? planSearchBrief(r, ctx.remaining, ctx.daysLeft) : r.searchBrief,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* One plan (C-6), its steps (C-8), its questions (C-9), its limits (C-10) */
/* ------------------------------------------------------------------ */

const pctOf = (x: number) => `${Math.round(x * 1000) / 10}%`;
const moneyOf = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * Why the reconstruction's strongest plan is implausible, or null: its key is
 * among the readings the plausibility critic flagged (`Reconstruction.flags`),
 * or the reading itself carries flags.
 */
function implausibility(r: Reconstruction): string | null {
  const row = (r.flags ?? []).find((one) => one.key === r.best.key);
  const flags = row?.flags ?? r.best.implausible ?? [];
  if (!row && flags.length === 0) return null;
  return flags.map((x) => `${x.kind}: ${x.detail}`).join('; ') || 'flagged implausible';
}

/**
 * The opening a member or a change sells: a channel's or a partner's clone is
 * `<openingId>~<lever>` (reconstruction.ts), any other id is its own. Pure.
 */
export function openingOfMember(id: string): string {
  const at = id.indexOf('~');
  return at > 0 ? id.slice(0, at) : id;
}

/**
 * One member of a reconstruction's strongest combination, resolved to the
 * opening it sells among the openings held (id → title), or null. Pure.
 *
 * By its id where the reading kept one (`VariantReading.memberIds`): a clone
 * resolves to the opening it clones. Else by the member's name, the title cut
 * at 50: an id; an opening's own 50-character title; a longer opening's title
 * the name begins; or — a channel's or partner's clone of an opening titled
 * under 50 characters, named `${title} via …` and cut at 50 — the longest
 * held title the name begins with, followed by nothing but the start of
 * " via ". Production plans dropped that last kind from the candidate (the
 * third rule compared the wrong way round) and sold, through a partner, an
 * opening the candidate did not list.
 */
export function resolveMember(member: string, id: string | undefined, titles: ReadonlyMap<string, string>): string | null {
  for (const one of id ? [openingOfMember(id), id] : []) if (titles.has(one)) return one;
  for (const one of [openingOfMember(member), member]) if (titles.has(one)) return one;
  const held = [...titles.entries()];
  const exact = held.find(([, t]) => t.slice(0, 50) === member);
  if (exact) return exact[0];
  const longer = held.find(([, t]) => member.length >= 20 && t.startsWith(member));
  if (longer) return longer[0];
  const via = ' via ';
  const cloned = held
    .filter(([, t]) => t.length >= 12 && member.startsWith(t))
    .filter(([, t]) => {
      const rest = member.slice(t.length);
      return rest === '' || via.startsWith(rest) || rest.startsWith(via);
    })
    .sort((a, b) => b[1].length - a[1].length)[0];
  return cloned?.[0] ?? null;
}

/** A reconstruction's members: the openings they sell, and, where the reading kept them, their own ids (a clone's included). */
export interface ReconstructionMembers {
  /** The members' own ids, clones as clones; null on a reading that kept only titles. */
  exact: ReadonlySet<string> | null;
  /** Every opening a member sells, by id. */
  openings: ReadonlySet<string>;
  /** The members resolved to the openings held, in the reading's order, each once. */
  resolved: string[];
}

/** The members of a reconstruction's reading, resolved against the openings held (`resolveMember`). Pure. */
export function membersOf(reading: Pick<VariantReading, 'members' | 'memberIds'>, titles: ReadonlyMap<string, string>): ReconstructionMembers {
  const ids = reading.memberIds && reading.memberIds.length === reading.members.length ? reading.memberIds : null;
  const resolved: string[] = [];
  for (const [at, member] of reading.members.entries()) {
    const hit = resolveMember(member, ids?.[at], titles);
    if (hit && !resolved.includes(hit)) resolved.push(hit);
  }
  return { exact: ids ? new Set(ids) : null, openings: new Set([...resolved, ...(ids ?? []).map(openingOfMember)]), resolved };
}

/**
 * The openings a reconstruction's change acts on, by id: the clone it adds (a
 * channel or a partner), the opening it brings in, or the one opening its
 * scope names (`@id:…`). Empty for a move that leaves openings out (it names
 * a non-member by design); null for a move on the plan as a whole or on a
 * group. Pure.
 */
export function changeOpenings(c: Pick<StrategyChange, 'label' | 'clone'>): string[] | null {
  if (c.clone) return [c.clone];
  if (/^drop@/.test(c.label)) return [];
  const included = /^include:(.+)$/.exec(c.label);
  if (included) return [included[1]!];
  const scoped = /@id:([^\s)]+)$/.exec(c.label);
  return scoped ? [scoped[1]!] : null;
}

/**
 * Whether a change belongs to the strategy its reading selected (owner,
 * 2026-11-20: "Every execution step must belong to the strategy actually
 * selected"). A change acting on named openings belongs when one of them is a
 * member — a clone only when the clone itself is, where the reading kept its
 * members' ids. A partner clone the optimiser left out of the strongest
 * combination sells nothing in the plan: the change is kept in the search's
 * state, but it is no step of the plan, no part of its label and no
 * assumption its reach rests on. Pure.
 */
export function changeBelongs(c: Pick<StrategyChange, 'label' | 'clone'>, members: ReconstructionMembers): boolean {
  const acts = changeOpenings(c);
  if (!acts || acts.length === 0) return true;
  return acts.some((id) => (id.includes('~') && members.exact ? members.exact.has(id) : members.openings.has(openingOfMember(id))));
}

/**
 * The next test when nothing could be modelled. With live openings, one must
 * be qualified — who pays, an offer and a price. With none (every buyer gone,
 * or none ever found), nobody who pays is known at all, so the decisive
 * missing link is a reachable buyer, not a price (planningReliability round
 * 10, adaptation). Pure.
 */
export function qualifyTest(liveOpenings: number | undefined, excluded: readonly { title: string; rule?: 'OWNER_PHYSICAL' | 'STOPPED' }[] = []): NextTest {
  /*
   * A qualified opening left out only because the card names the owner as who
   * does its physical work has buyers and a price already; what it lacks is
   * somebody else to perform it (§91: the owner's own action is a refusal, the
   * service is still a question). Asking to "qualify an opening" there sends
   * Brain back to establish what it holds (planningReliability round 11).
   */
  const physical = liveOpenings ? excluded.find((one) => one.rule === 'OWNER_PHYSICAL') : undefined;
  if (physical) {
    return {
      link: 'FULFILMENT',
      test: `Find an independent provider who performs "${physical.title.slice(0, 80)}" for its buyers, at a quoted cost a deal: the card names the owner doing physical work, which the owner does not do.`,
      by: 'BRAIN',
      blocker: null,
    };
  }
  return liveOpenings === 0
    ? { link: 'REACHABLE_BUYER', test: 'No live opening remains: find a buyer who pays and a way to reach them, then establish an offer and a price, so there is a plan to judge.', by: 'BRAIN', blocker: null }
    : { link: 'OFFER_AND_PRICE', test: 'Qualify at least one opening: establish who pays, an offer and a price, so there is a plan to judge.', by: 'BRAIN', blocker: null };
}

/**
 * Whether a plan tying up `exposure` must ask the owner how much this goal may
 * commit: nobody set a ceiling, or the only one is assumed from figureless
 * words. A ceiling the objective's own words state as a figure answers the
 * question for a plan inside it, even when the target holds none — removing a
 * stored limit loosens the goal, and a looser goal never turns a plan that was
 * recommendable under the limit into an open question (planningReliability
 * round 10, adaptation). A ceiling the owner removed (`scope.capitalRemoved`)
 * answers it for any exposure: the removal is the owner saying there is none.
 */
export function capitalQuestionOpen(target: Pick<TargetReading, 'capitalCeilingCents' | 'scope'>, exposure: number): boolean {
  if (!(exposure > 0)) return false;
  // The owner removed the ceiling: that is their answer, no limit (planningReliability round 11).
  if (target.scope?.capitalRemoved) return false;
  if (target.scope?.capitalAssumed) return true;
  if (target.capitalCeilingCents !== null) return false;
  const stated = target.scope?.capitalStatedCents ?? null;
  return stated === null || exposure > stated / 100 + 1e-9;
}

/**
 * Whether the owner set how money goes out and comes back in steps: a figure
 * for what may be tied up before the first payment, or a weekly one. A
 * before-proof ceiling only assumed from the objective's words ("no up-front
 * capital", `scope.capitalAssumed`) is a limit on capital, enforced as one, and
 * never a pacing preference (planningReliability round 10).
 */
export function pacedByOwner(target: Pick<TargetReading, 'capitalBeforeProofCents' | 'capitalPerWeekCents' | 'scope'>): boolean {
  return (target.capitalBeforeProofCents !== null && !target.scope?.capitalAssumed) || target.capitalPerWeekCents !== null;
}

/**
 * Whether the reconstruction's strongest plan becomes THE plan (C-6). Pure.
 *
 * Production read three plans at once: the verdict and next step from a
 * scenario strategy, the candidate and the sales from the baseline portfolio,
 * and a reconstruction at 97.9% beside a candidate at 1.1% that nothing acted
 * on. One plan now: the reconstruction's strongest plan is adopted when it
 * runs inside the limits, is not flagged implausible and beats the plan as
 * held materially; otherwise the plan as held stays the candidate and the
 * reconstruction is said, in the reading, to be hypothetical.
 *
 * An adopted reconstruction is still a candidate. Its reach keeps the basis
 * the engine gave it, and a reach resting on any change not measured is
 * coverage, never a probability.
 *
 * Whether it beats the plan as held, and the reach it is reported at, are read
 * from the reconstruction without its assumed moves (`Reconstruction.established`,
 * invariant 39). What those moves would add is `upside`: kept, said, and
 * tested by the plan's steps, never the number that adopts it.
 */
export function adoptReconstruction(input: {
  reconstruction: Reconstruction | null;
  baseline: GoalPortfolio | null;
  openings: ReadonlyArray<{ opportunity: { id: string; title: string } }>;
}): { adoption: PlanAdoption; candidate: PlanAcceptance['candidate'] } {
  const r = input.reconstruction;
  if (!r) return { adoption: { source: 'BASELINE', hypothetical: false, reason: 'no reconstruction ran: the plan is accepted, or nothing could be reconstructed' }, candidate: null };
  const flagged = implausibility(r);
  const titled = new Map(input.openings.map((o) => [o.opportunity.id, o.opportunity.title]));
  const members = membersOf(r.best, titled);
  // Only a change on the strongest combination's members is part of the plan (`changeBelongs`).
  const real = r.best.changes.filter((c) => !c.label.startsWith('test:') && changeBelongs(c, members));
  /*
   * Invariant 39 (owner, 2026-11-20: "uncertainty never silently becomes
   * favorable evidence"). The reach a move resting on an unmeasured assumption
   * adds — a deposit assumed accepted, a bundle's close assumed, a partner's
   * referrals, a price's demand response — is a hypothesis to test by running
   * that move's kill criterion. It is reported beside the plan's reach as its
   * upside, and never adopts the plan or becomes the candidate's reach:
   * production goal C read 25.3% reconstructed against 8.3% as held and 1.5%
   * on measured campaign rates. A move a measurement establishes carries
   * another basis and is not assumed.
   */
  const assumedMoves = assumedMovesOf(real);
  const upside: AssumedUpside | null = assumedMoves.length === 0
    ? null
    : {
        reach: r.best.reach,
        settledP50: r.best.settledP50,
        assumptions: movesOf(assumedMoves, titled),
        sentence: `if its ${assumedMoves.length} unmeasured assumption(s) hold (${movesOf(assumedMoves, titled).slice(0, 4).join('; ')}) it would reach ${pctOf(r.best.reach)} (p50 ${moneyOf(r.best.settledP50)}): a hypothesis to test by running each one's kill criterion, not evidence`,
      };
  const hypothetical = (reason: string) => ({ adoption: { source: 'BASELINE' as const, hypothetical: true, reason, ...(upside ? { upside } : {}) }, candidate: null });
  /*
   * A reading the critic flags is shown as no figure at all (production baseline,
   * 2026-11-24: an HVAC deal that "keeps $37,271" on $1 of capital read as the
   * plan's): the flag says what is wrong, its money figures are withheld, and an
   * implausible reconstruction carries no upside either.
   */
  if (flagged) return { adoption: { source: 'BASELINE', hypothetical: true, reason: `the reconstruction is flagged implausible (${withoutFigures(flagged).slice(0, 300)}), so none of its figures is shown or adopted` }, candidate: null };
  if (!r.best.feasible) return hypothetical(`the reconstruction's strongest plan does not run inside the limits${r.best.why ? ` (${r.best.why})` : ''}`);
  if (real.length === 0) return { adoption: { source: 'BASELINE', hypothetical: false, reason: 'no change the reconstruction tried improves the plan as held materially' }, candidate: null };
  const baseReach = input.baseline?.best?.reach ?? r.baseline.reach;
  const baseP50 = input.baseline?.best?.settledP50 ?? r.baseline.settledP50;
  const establishedMoves = real.filter((c) => !assumedMoves.includes(c));
  if (upside && establishedMoves.length === 0) return hypothetical(`every change the reconstruction makes rests on an unmeasured assumption, so it is not the plan: ${upside.sentence}`);
  // What the plan holds on no assumed move: the reconstruction's own reading of it, or nothing — an unread figure is never the favourable one.
  const held = upside ? (r.established ?? null) : r.best;
  if (!held) return hypothetical(`no reading of the reconstruction without its assumed moves was made, so it is not the plan: ${upside!.sentence}`);
  if (!held.feasible) return hypothetical(`without its assumed moves the reconstruction does not run inside the limits${held.why ? ` (${held.why})` : ''}; ${upside!.sentence}`);
  const beats = held.reach >= baseReach + MATERIAL_REACH || (held.reach >= baseReach - 1e-9 && held.settledP50 > baseP50 * (1 + MATERIAL_P50) + 1e-9);
  if (!beats) {
    return hypothetical(
      upside
        ? `without its ${assumedMoves.length} assumed move(s) the reconstruction (${pctOf(held.reach)}, p50 ${moneyOf(held.settledP50)}) does not beat the plan as held (${pctOf(baseReach)}, p50 ${moneyOf(baseP50)}) materially; ${upside.sentence}`
        : `the reconstruction (${pctOf(r.best.reach)}, p50 ${moneyOf(r.best.settledP50)}) does not beat the plan as held (${pctOf(baseReach)}, p50 ${moneyOf(baseP50)}) materially`,
    );
  }
  const ids = members.resolved;
  const names = ids.map((id) => (titled.get(id) ?? '').slice(0, 60));
  if (ids.length === 0) return hypothetical('the reconstruction\'s strongest plan names no opening Brain holds');
  /*
   * A member whose price nobody has established counts money nobody has
   * evidenced (invariant 39, planningReliability round 9): the reconstruction
   * that rests on one is not the plan, exactly as the held combination is
   * not when it counts one (`unpricedIn`). Before, a reconstruction over
   * constructed arrangements at an assumed price could replace a held plan
   * whose every link was established, depending only on which arrangements a
   * run happened to construct.
   */
  const unpricedMembers = ids.filter((id) => (input.baseline?.demand ?? []).find((d) => d.opportunityId === id)?.unestablished.includes('price'));
  if (unpricedMembers.length > 0) {
    return hypothetical(`the reconstruction's strongest plan counts money from ${unpricedMembers.slice(0, 4).map((id) => (titled.get(id) ?? id).slice(0, 60)).join(', ')}, whose price nobody has established; an unknown price is not evidence of reach`);
  }
  const evidenced = held.basis === 'PROBABILITY' && establishedMoves.every((c) => c.basis === 'MEASURED');
  return {
    adoption: {
      source: 'RECONSTRUCTED',
      hypothetical: false,
      // A person reads each change by its title, never its reconstruction key ("focus:4", "price×2.50@…": NO_INTERNAL_KEYS).
      reason:
        `the reconstruction reaches ${pctOf(held.reach)} (p50 ${moneyOf(held.settledP50)}) against ${pctOf(baseReach)} (p50 ${moneyOf(baseP50)}) as held, by ${movesOf(establishedMoves, titled).slice(0, 4).join(', ')}` +
        (upside ? `; ${upside.sentence}` : ''),
      ...(upside ? { upside } : {}),
    },
    candidate: {
      // The members by their titles: an opening's id is the plan's identity for it (`opportunityIds`), never its name.
      label: `${movesOf(real, titled).slice(0, 4).join(' + ')} on ${names.slice(0, 4).join(' + ')}`.slice(0, 300),
      opportunityIds: ids,
      source: 'RECONSTRUCTED',
      settledP50: held.settledP50,
      reach: held.reach,
      // A reach resting on a change nobody has measured is coverage, whatever the engine's basis.
      reachBasis: evidenced ? 'PROBABILITY' : 'COVERAGE',
      ...(upside ? { assumedUpside: upside } : {}),
    },
  };
}

/** A headroom at or under this is no headroom: the openings at their best reach the target in no material share of worlds. */
export const HEADROOM_NIL = 0.005;

/**
 * Whether the goal as stated is out of reach by arithmetic (C-10, §65). Pure.
 *
 * Only arithmetic concludes it, never a short pool: the reconstruction must
 * be structural (every estimate at its favourable end at once stays under the
 * requirement), and either every transaction structure the goal's own figures
 * allow is impossible, or the openings at their best reach nothing and no
 * structure direct outreach could sell closes the gap in the time left. A
 * goal whose held openings are merely weak, with structures outreach could
 * carry, is not infeasible: Brain keeps searching (§65).
 */
export function judgeFeasibility(input: {
  reconstruction: Reconstruction | null;
  structures: GoalStructures | null;
  required: number;
  remaining: number;
  daysLeft: number | null;
  capitalCeiling: number | null;
}): InfeasibleConclusion | null {
  const r = input.reconstruction;
  const s = input.structures;
  if (!r || !s || !r.structural || r.headroom.reach >= input.required || s.structures.length === 0) return null;
  const allImpossible = s.structures.every((one) => one.verdict === 'IMPOSSIBLE');
  const outreachCarries = s.structures.some((one) => one.verdict === 'OUTREACH_CAN_CARRY' || one.verdict === 'ONLY_AT_BEST_CONVERSION');
  const nil = r.headroom.reach <= HEADROOM_NIL;
  if (!allImpossible && !(nil && !outreachCarries)) return null;
  const sold = s.structures.filter((one) => one.kind !== 'INSTANT');
  const timeBound = sold.length > 0 && sold.every((one) => one.verdict === 'IMPOSSIBLE');
  const relax: InfeasibleConclusion['relax'] = [];
  if (timeBound) {
    let days: number | null = null;
    for (let d = Math.max(1, (input.daysLeft ?? 0) + 1); d <= 365; d += 1) {
      const wider = requiredStructures({ remaining: s.remaining, daysLeft: d, currency: s.currency, perArrangement: null, spendCeiling: null, outreachPerDay: s.outreachPerDay });
      if (wider.structures.some((one) => one.verdict === 'OUTREACH_CAN_CARRY' || one.verdict === 'ONLY_AT_BEST_CONVERSION')) {
        days = d;
        break;
      }
    }
    relax.push({ constraint: 'DEADLINE', suggestion: days !== null ? `move the deadline to at least ${days} days from now, the shortest window in which a sale can be made and paid` : 'move the deadline out: no window up to a year lets outreach carry the gap at this size' });
  }
  const capital = r.diagnosis.find((one) => one.factor === 'CAPITAL');
  const top = r.diagnosis[0];
  if (input.capitalCeiling === 0 || (capital && capital.liftReach >= MATERIAL_REACH)) {
    const entry = {
      constraint: 'CAPITAL' as const,
      suggestion:
        input.capitalCeiling === 0
          ? 'allow the goal to commit some money: with none, nothing that must be bought or warmed up can start'
          : `raise the money the goal may commit: doubling it lifts reach by ${pctOf(capital!.liftReach)}`,
    };
    if (top?.factor === 'CAPITAL' && !timeBound) relax.unshift(entry);
    else relax.push(entry);
  }
  const achievable = Math.max(r.headroom.settledP50, r.best.settledP50);
  relax.push({
    constraint: 'TARGET',
    suggestion:
      achievable > 0
        ? `lower the target to about ${moneyOf(achievable)}, what the openings held settle with every estimate at its most favourable`
        : 'lower the target: the openings held settle nothing in the time left even at their most favourable',
  });
  const firstImpossible = s.structures.find((one) => one.verdict === 'IMPOSSIBLE');
  const reason = allImpossible
    ? `every transaction structure that could close ${moneyOf(input.remaining)} is impossible by arithmetic (${firstImpossible?.reason ?? 'no time'}), and the openings held reach ${pctOf(r.headroom.reach)} even with every estimate at its favourable end`
    : `no structure direct outreach can sell closes ${moneyOf(input.remaining)} in ${input.daysLeft ?? 0} day(s)${firstImpossible ? ` (${firstImpossible.reason})` : ''}, only buyers already at a checkout could pay in time, and the openings held reach ${pctOf(r.headroom.reach)} of the required ${pctOf(input.required)} even with every estimate at its favourable end`;
  const instantOnly = !allImpossible && s.structures.some((one) => one.kind === 'INSTANT' && one.verdict !== 'IMPOSSIBLE');
  return { reason, relax, headroomReach: r.headroom.reach, required: input.required, instantOnly };
}

/**
 * What the agreements already held bring toward the target when each settles
 * at its favourable end: every one whose settlement is unknown or inside the
 * window (planningReliability round 13). Agreed money needs no sale, so no
 * structure outreach could sell bears on it; when it alone covers what is
 * still needed, the goal is not out of reach by arithmetic, and what blocks it
 * is the missing link (when the buyers pay), never the target. Pure.
 */
export function agreedInReach(openings: ModelledOpportunity[], daysLeft: number | null, net: boolean): number {
  let sum = 0;
  for (const one of openings) {
    if (!(one.agreedValue > 0)) continue;
    const days = one.daysToCash.value !== null && one.daysToCash.provenance !== 'UNKNOWN' ? one.daysToCash.value : null;
    if (days !== null && daysLeft !== null && days > daysLeft) continue;
    sum += agreedToward(one, net, 'LOW');
  }
  return sum;
}

/** The goal's own limits a held-market ceiling is read under (`heldCeiling`); null fields bind nothing. */
export interface HeldLimits {
  daysLeft: number | null;
  capitalCeiling: number | null;
}

/**
 * The most one held opening could bring toward the target, every unknown at its
 * favourable end and every buyer agreeing, or null when nothing measured bounds
 * it (planningReliability round 13). Pure.
 *
 * Two measurements bound an opening, and nothing else does (§65: a short pool
 * is a search gap, never a ceiling):
 *
 * - its market, when research counted the buyers themselves (`prospects`): the
 *   agreements plus the buyers left (`buyersLeft`), at the top price;
 * - under `limits`, the goal's own terms: a lot that settles after the
 *   deadline brings nothing, a lot that ties up more than the ceiling cannot
 *   start, and a ceiling of ⌊ceiling ÷ capital⌋ lots at once turned
 *   ⌊days left ÷ days to cash⌋ times holds that many lots, agreed ones first.
 *
 * A one-off nobody sized, an order rate, an estimate, or a deal priced by a
 * figure nobody has shown buyers pay (unknown, assumed or contested) is
 * unmeasured: it returns null, and the conclusion is not drawn.
 */
export function heldCeiling(one: ModelledOpportunity, net: boolean, limits: HeldLimits | null): number | null {
  if (one.competitiveAward) return null;
  const known = (x: ModelInput): number | null => (x.value !== null && x.provenance !== 'UNKNOWN' ? x.value : null);
  // Only a price buyers are shown to pay measures what a deal brings: a contested or assumed one bounds nothing.
  const price = priceSupported(one) ? (one.price.high ?? one.price.value) : null;
  const each = price === null ? null : perDealToward(one, price, net, 'LOW');
  const agreed = agreedToward(one, net, 'LOW');
  const lots = agreedLots(one);
  const left = one.repeatable && one.prospects !== null && one.prospects !== undefined ? buyersLeft(one) : null;
  let bound = left === null ? Infinity : left > 0 && each === null ? Infinity : agreed + left * (each ?? 0);
  if (limits) {
    const days = known(one.daysToCash);
    if (days !== null && limits.daysLeft !== null && days > limits.daysLeft) return 0;
    const capital = known(one.capital);
    if (capital !== null && capital > 0 && limits.capitalCeiling !== null) {
      if (capital > limits.capitalCeiling + 1e-9) return 0;
      if (days !== null && days > 0 && limits.daysLeft !== null) {
        const inWindow = Math.floor(limits.capitalCeiling / capital + 1e-9) * Math.max(1, Math.floor(limits.daysLeft / days + 1e-9));
        const agreedIn = lots > 0 ? (agreed * Math.min(lots, inWindow)) / lots : agreed;
        const freshLots = Math.max(0, inWindow - lots);
        const byLots = freshLots > 0 && each === null ? Infinity : agreedIn + freshLots * (each ?? 0);
        bound = Math.min(bound, byLots);
      }
    }
  }
  return Number.isFinite(bound) ? Math.max(0, bound) : null;
}

/**
 * Whether the openings held are out of reach of the goal on measurements alone
 * (planningReliability round 13; §65, §95). Pure.
 *
 * `judgeFeasibility` reads the goal against every structure outreach could
 * sell, so a short pool never concludes it. A measured ceiling is different:
 * when research counted the whole market an opening sells into, or the goal's
 * own capital and deadline hold only so many lots, every buyer agreeing at the
 * top price is the most that opening can bring — a measurement, not a search
 * gap. When every held opening is bounded that way and together they fall
 * short, the goal is infeasible on what is held: the conclusion names the
 * target to lower to (and, when the limits rather than the markets bind, the
 * capital or deadline that would reach it). It covers the openings held, not
 * markets nobody has counted, so the search for other openings continues
 * (`heldMarkets`).
 */
export function judgeHeldMarkets(input: { openings: ModelledOpportunity[]; remaining: number; net: boolean; limits: HeldLimits; required: number }): InfeasibleConclusion | null {
  const { openings, remaining, net, limits } = input;
  if (openings.length === 0 || !(remaining > 0)) return null;
  const total = (l: HeldLimits | null): number => {
    let sum = 0;
    for (const one of openings) {
      const c = heldCeiling(one, net, l);
      if (c === null) return Infinity;
      sum += c;
    }
    return sum;
  };
  const within = total(limits);
  if (!(within < remaining - 0.5)) return null;
  const market = total(null);
  const marketShort = market < remaining - 0.5;
  const relax: InfeasibleConclusion['relax'] = [];
  if (!marketShort) {
    if (limits.capitalCeiling !== null && total({ ...limits, capitalCeiling: null }) >= remaining - 0.5) {
      const steps = [...new Set(openings.flatMap((one) => (one.capital.value !== null && one.capital.value > 0 ? Array.from({ length: 200 }, (_, k) => (k + 1) * one.capital.value!) : [])))]
        .filter((c) => c > limits.capitalCeiling! + 1e-9)
        .sort((a, b) => a - b);
      const enough = steps.find((c) => total({ ...limits, capitalCeiling: c }) >= remaining - 0.5);
      relax.push({ constraint: 'CAPITAL', suggestion: enough !== undefined ? `allow the goal to commit at least ${moneyOf(enough)}, what the lots that reach the target need at once` : 'allow the goal to commit more money: the lots the target needs do not fit inside the ceiling' });
    }
    if (limits.daysLeft !== null) {
      let days: number | null = null;
      for (let d = Math.floor(limits.daysLeft) + 1; d <= 365; d += 1) {
        if (total({ ...limits, daysLeft: d }) >= remaining - 0.5) {
          days = d;
          break;
        }
      }
      if (days !== null) relax.push({ constraint: 'DEADLINE', suggestion: `move the deadline to at least ${days} days from now, when enough lots have settled` });
    }
  }
  relax.push({
    constraint: 'TARGET',
    suggestion:
      within > 0
        ? `lower the target to about ${moneyOf(within)}, the most the openings held bring with every buyer agreeing at the top price`
        : 'lower the target: the openings held bring nothing inside the goal\'s limits even with every buyer agreeing',
  });
  if (marketShort) relax.unshift(relax.pop()!);
  const kept = net ? ' net of direct costs' : '';
  const reason = marketShort
    ? `the openings held sell into markets research counted whole: every buyer in them agreeing at the top price brings at most ${moneyOf(market)}${kept}, so they cannot reach the ${moneyOf(remaining)} still needed`
    : `inside the goal's own limits the openings held bring at most ${moneyOf(within)}${kept} of the ${moneyOf(remaining)} still needed, even with every buyer agreeing at the top price`;
  return { reason, relax, headroomReach: 0, required: input.required, instantOnly: false, heldMarkets: true };
}

/** The resolutions of the blockers the gate's NOT_VIABLE strategies show (`blockerResolutions`), from the planner's own numbers. */
function resolutionsOf(strategies: StrategyReading[], included: ModelledOpportunity[], target: TargetReading, acceptance: PlanAcceptance): Resolution[] {
  const byId = new Map(included.map((one) => [one.opportunity.id, one]));
  return blockerResolutions({
    strategies: strategies
      .filter((one) => one.verdict === 'NOT_VIABLE')
      .map((one) => (one.dealsTaken ?? []).flatMap(({ opportunityId, deals }) => (byId.has(opportunityId) ? [{ one: byId.get(opportunityId)!, deals }] : []))),
    remaining: target.remainingCents / 100,
    currency: target.currency,
    daysLeft: target.daysLeft,
    hoursCeiling: target.hoursCeiling,
    capitalCeiling: target.capitalCeilingCents === null ? null : target.capitalCeilingCents / 100,
    capitalBeforeProof: target.capitalBeforeProofCents === null || target.proven ? null : target.capitalBeforeProofCents / 100,
    net: countsNet(target.metric),
    researchDays: RESEARCH_TURNAROUND_DAYS,
    value: acceptance.required - (acceptance.candidate?.reach ?? 0),
  });
}

/** A relaxation the arithmetic's own diagnosis cannot see (owner hours above all), added to a NOT_SUPPORTED conclusion once per constraint. */
export function relaxAlso(infeasible: InfeasibleConclusion, resolutions: Resolution[]): void {
  for (const { relax } of resolutions) {
    if (relax && !infeasible.relax.some((one) => one.constraint === relax.constraint)) infeasible.relax.push(relax);
  }
}

/** The acceptance a NOT_SUPPORTED goal reads: no plan, the arithmetic, and which constraint to relax. */
export function notSupported(acceptance: PlanAcceptance, infeasible: InfeasibleConclusion): PlanAcceptance {
  return {
    ...acceptance,
    status: 'NOT_SUPPORTED',
    probability: null,
    accepted: null,
    shortfalls: [infeasible.reason, ...acceptance.shortfalls],
    sentence: `INFEASIBLE AS STATED: ${infeasible.reason}. To make it supportable, ${infeasible.relax.map((one) => `${one.constraint.toLowerCase()}: ${one.suggestion}`).join('; or ')}. ${
      infeasible.instantOnly
        ? 'Arithmetic still allows a sale to buyers already at a checkout or on a marketplace, so Brain keeps searching, and its search brief asks for buyers who come to the offer.'
        : infeasible.heldMarkets
          ? 'The conclusion covers the openings held; markets nobody has counted are not ruled out, so Brain keeps searching for openings outside them.'
          : 'Brain stops widening research for this goal until its terms or inputs change.'
    }`,
  };
}

/** Whether the goal's search keeps widening (C-10): not after the deadline, an outcome, or arithmetic infeasibility. Pure. */
export function continueSearch(input: { achieved: boolean; daysLeft: number | null; outcomeRecorded: boolean; policy: string; acceptance: PlanAcceptance['status']; instantOnly?: boolean; heldMarkets?: boolean }): boolean {
  return continuationOf(input).continues;
}

/**
 * Whether the goal's productive work continues, and why (S-0199). The
 * threshold is a minimum: reaching it, or accepting a plan for it, never ends
 * discovery, constructed rounds or portfolio needs while the goal's window is
 * open — surplus over it finances successors. What ends the search is the
 * window closing, a missed outcome on the record, or arithmetic ruling the
 * goal out (C-10). Pure.
 */
export function continuationOf(input: { achieved: boolean; daysLeft: number | null; outcomeRecorded: boolean; policy: string; acceptance: PlanAcceptance['status']; instantOnly?: boolean; heldMarkets?: boolean; surplus?: number }): Continuation {
  const surplusForSuccessors = Math.max(0, input.surplus ?? 0);
  const open = input.daysLeft === null || input.daysLeft > 0;
  if (input.achieved) {
    return open
      ? { continues: true, reason: 'the target is collected, and it is a minimum, not a stop: discovery, constructed rounds and portfolio needs continue while the window is open, and what is collected above it finances successors', surplusForSuccessors }
      : { continues: false, reason: 'the target is collected and the goal\'s window has closed; surplus finances successor goals', surplusForSuccessors };
  }
  if (input.outcomeRecorded) return { continues: false, reason: 'the goal\'s outcome is already on the record', surplusForSuccessors };
  if (!open) return { continues: false, reason: 'the goal\'s deadline has passed', surplusForSuccessors };
  if (input.acceptance === 'NOT_SUPPORTED') {
    return input.instantOnly === true
      ? { continues: true, reason: 'only an instantly settling opening could still reach the goal, so the search for one continues', surplusForSuccessors }
      : input.heldMarkets === true
        ? { continues: true, reason: 'the openings held cannot reach the goal on their measured markets and limits, but markets nobody has counted are not ruled out, so the search for other openings continues', surplusForSuccessors }
      : { continues: false, reason: 'the goal as stated is not supported by arithmetic; the search resumes when its terms or inputs change', surplusForSuccessors };
  }
  if (input.acceptance === 'ACCEPTED') {
    return { continues: true, reason: 'a plan is accepted, but the threshold is a minimum: Brain keeps exploring for plans whose expected and upper outcomes exceed it and whose adverse case stays defensible', surplusForSuccessors };
  }
  return { continues: true, reason: input.policy === 'SQUEEZE' ? 'a SQUEEZE goal keeps discovering while it sells, and no plan is accepted yet' : 'no plan is accepted yet: keep constructing, combining and comparing', surplusForSuccessors };
}

const CHANGE_LINK: Record<string, ChainLink> = {
  CAPACITY: 'REACHABLE_BUYER',
  ACQUISITION: 'REACHABLE_BUYER',
  PARTNER: 'REACHABLE_BUYER',
  MARKET: 'MARKET_VOLUME',
  TRANSACTION: 'OFFER_AND_PRICE',
  PRICE: 'OFFER_AND_PRICE',
  PORTFOLIO: 'OFFER_AND_PRICE',
  CASH_TIMING: 'SETTLES_IN_TIME',
  CAPITAL: 'ECONOMICS',
  FULFILMENT: 'ECONOMICS',
  EVIDENCE: 'CONVERSION',
};
const SENDS = new Set(['CAPACITY', 'ACQUISITION', 'PARTNER', 'MARKET', 'EVIDENCE', 'PORTFOLIO', 'FULFILMENT']);
const CREDENTIAL = /\b(credentials?|api key|password|log ?in|sign[- ]?in|oauth|account access)\b/i;
const LEGAL = /\b(contracts?|legal|licen[cs]es?|agreements?|terms of service|compliance|signature|signed)\b/i;

/**
 * The act a change asks for, with every name it mentions taken out. A step's
 * owner is decided by what the step does, never by the words in an opening's
 * or a buyer's name: production plan tests, 2026-11-19, made "Bring in …" a
 * PERSON step (a legal commitment in the owner's name) because the opening's
 * title contained "compliance". Quoted text is a name, and so is any title the
 * reading knows. Pure.
 */
export function actOfChange(change: { label: string; detail: string }, names: Iterable<string> = []): string {
  let text = `${change.label} ${change.detail}`.replace(/"[^"]*"|“[^”]*”/g, ' ');
  for (const name of names) if (name.trim().length >= 3) text = text.split(name).join(' ');
  return text;
}

/** Who executes a change: Brain, unless it is a rule-11 kind only the owner can do — judged on the act, not on names. */
export function ownerOf(change: { label: string; detail: string; cost: number }, names: Iterable<string> = []): { owner: 'BRAIN' | 'PERSON'; reason: string | null } {
  const text = actOfChange(change, names);
  if (change.cost > 0) return { owner: 'PERSON', reason: `a payment of ${moneyOf(change.cost)} from the owner's account, inside the goal's limits` };
  if (CREDENTIAL.test(text)) return { owner: 'PERSON', reason: 'a credential or sign-in only the owner holds' };
  if (LEGAL.test(text)) return { owner: 'PERSON', reason: 'a legal commitment in the owner\'s name' };
  return { owner: 'BRAIN', reason: null };
}

/** The outreach reply rate this Brain measured: its 90% interval over the sends recorded (`portfolio.measuredRates`). */
export type MeasuredReply = { sent: number; low: number; high: number };

/** A reply rate to two decimals where it is under 1% (0.11%, not 0.1%). */
const replyPctOf = (x: number) => `${x < 0.01 ? Math.round(x * 10_000) / 100 : Math.round(x * 1000) / 10}%`;

/**
 * The measurement that says the reply assumption failed. Production,
 * 2026-11-19: the criterion read "do no better than the measured record
 * (as-is floor 5.6%)", and 5.6% was the as-is plan's reach — the share of
 * worlds reaching the target — printed as if it were a reply rate, while the
 * measured reply rate was 0.11–0.70% over 4,970 sends. A reply criterion
 * compares replies with replies: the plan's required reply rate, else the
 * measured record's low end, else it says it is an assumption.
 */
export function replyKill(r: Reconstruction | null, measured: MeasuredReply | null = null): string {
  const record = measured ? `the measured record is ${replyPctOf(measured.low)}–${replyPctOf(measured.high)} over ${measured.sent.toLocaleString('en-US')} sends` : 'no reply rate has been measured for this outreach';
  if (r?.requiredReply) {
    const sends = Math.min(5_000, Math.max(50, Math.ceil(10 / r.requiredReply)));
    return `reply rate under ${replyPctOf(r.requiredReply)} after ${sends.toLocaleString('en-US')} sends → stop and re-plan (the plan needs ${replyPctOf(r.requiredReply)} to reach ${pctOf(r.required)}; ${record})`;
  }
  if (measured && measured.low > 0) {
    const sends = Math.min(5_000, Math.max(500, Math.ceil(10 / measured.low)));
    return `reply rate under ${replyPctOf(measured.low)} after ${sends.toLocaleString('en-US')} sends, the low end of the measured record (${record}) → stop and re-plan`;
  }
  return `no interested reply in the first 200 sends → stop and re-plan (an assumption: ${record})`;
}

function killFor(change: { dimension: string; label: string; detail: string; cost: number; startDay?: { low: number; high: number }; supplier?: string }, r: Reconstruction | null, measured: MeasuredReply | null): string {
  switch (change.dimension) {
    case 'PARTNER':
      return `no signed partner by day ${(change.startDay?.high ?? 0) + 14}, or no referred buyer within 30 days of signing → drop the partner and re-plan`;
    case 'TRANSACTION':
    case 'PRICE':
      return `fewer than 1 in 10 offered buyers accepts "${titleOfChange(change)}" → revert to the unit sale at the listed price and re-plan`;
    case 'CASH_TIMING':
      return 'fewer than half of signing buyers pay the deposit at signing → re-plan cash timing';
    case 'CAPITAL':
      return `the supplier will not ship against the buyer's payment, or the money committed passes ${moneyOf(change.cost)} → stop and re-plan`;
    case 'FULFILMENT':
      return `no written quote from ${change.supplier ?? 'the supplier'} at or under the re-routed cost by day ${(change.startDay?.high ?? 0) + 7} → fulfil at the cost the plan held before and re-plan`;
    default:
      return replyKill(r, measured);
  }
}

/** A reasoning move's scope as written into a change's description: a named group's token, or one opening's id. */
const SCOPE_TOKEN = /\((ALL|OUTREACH|SMALL_TICKET|LARGE_TICKET|FAST_CASH|SLOW_CASH|TOP|REST|id:[^)\s]+)\)/g;

/**
 * A change's description with its scope in words (production, 2026-11-18:
 * "Raise price ×4.00 on 4 opening(s) (ALL)"). The reasoning moves write words
 * since `scopeWords`; a change written before, or by any other writer, is
 * read the same way here, where a plan's steps and candidate are built. Pure.
 */
export function spokenScope(text: string, titles?: ReadonlyMap<string, string>): string {
  return text.replace(SCOPE_TOKEN, (_all, scope: string) => {
    if (!scope.startsWith('id:')) return `(${scopeWords(scope as Scope, [])})`;
    const title = titles?.get(scope.slice(3));
    return `(${title && !internalKeyIn(title) ? `"${title.slice(0, 80)}"` : 'one named opening'})`;
  });
}

/** A change as a person reads it: its title (`changeTitle`), its scope in words. */
export function titleOfChange(change: { label: string; detail: string }, titles?: ReadonlyMap<string, string>): string {
  return changeTitle({ label: change.label, detail: spokenScope(change.detail, titles) });
}

const QUOTED = /"[^"]*"?/g;
const BASIS_RANK: Record<string, number> = { MEASURED: 0, ESTIMATE: 1, ASSUMPTION: 2 };

/** One move of a reconstruction, made on one or more openings: what a plan's step is built from. */
interface Move {
  label: string;
  detail: string;
  changes: StrategyChange[];
}

/**
 * A reconstruction's changes as moves: the same move made on several openings
 * is one move naming each (production, 2026-11-19, goal B: six steps read
 * `Bring in "Constructed` — one portfolio move, six openings). Two changes are
 * the same move when their dimension and their titles agree once the opening
 * each names is set aside. Order is kept: a move stands where its first
 * change stood. Pure.
 */
export function movesOfChanges(changes: readonly StrategyChange[], titles?: ReadonlyMap<string, string>): Move[] {
  const groups = new Map<string, StrategyChange[]>();
  for (const c of changes) {
    const key = `${c.dimension}|${titleOfChange(c, titles).replace(QUOTED, '"…"')}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const title = titleOfChange(first, titles);
    const detail = spokenScope(first.detail, titles);
    if (group.length === 1) return { label: title, detail, changes: group };
    const named = (text: string) => [...text.matchAll(QUOTED)].map((m) => m[0]);
    const names = [...new Set(group.flatMap((c) => named(spokenScope(c.detail, titles)).slice(0, 1)))];
    const at = title.search(QUOTED);
    const joined = names.join('; ');
    const quoted = at < 0 ? '' : title.slice(at).match(QUOTED)![0];
    const label = at < 0 ? title : `${title.slice(0, at)}${joined.length <= 60 ? joined : `${names.length} opening${names.length === 1 ? '' : 's'}`}${title.slice(at + quoted.length)}`;
    // The description, said once with every opening named, when the changes differ only in the opening; else each in turn.
    const rest = new Set(group.map((c) => spokenScope(c.detail, titles).replace(QUOTED, '"…"')));
    const d = detail.search(QUOTED);
    const said = rest.size === 1 && d >= 0 ? `${detail.slice(0, d)}${joined}${detail.slice(d).replace(QUOTED, '')}` : [...new Set(group.map((c) => spokenScope(c.detail, titles)))].join('; ');
    return { label, detail: `${said.charAt(0).toUpperCase()}${said.slice(1)}`, changes: group };
  });
}

/** The labels of a reconstruction's moves, for a sentence or a candidate's label. */
function movesOf(changes: readonly StrategyChange[], titles?: ReadonlyMap<string, string>): string[] {
  return movesOfChanges(changes, titles).map((m) => m.label);
}

/**
 * The stage of a transaction a reconstruction's change is, for the integrity
 * check (`planIntegrity`). Its cost is always the reconstruction's own figure
 * for it (`StrategyChange.cost`, what it commits before any opening pays, which
 * the engine's committed money is read from): its source is the model.
 */
const CHANGE_STAGE: Record<string, ArrangementStage> = {
  CAPACITY: 'REACH',
  ACQUISITION: 'REACH',
  MARKET: 'REACH',
  PARTNER: 'REACH',
  PRICE: 'OFFER',
  TRANSACTION: 'OFFER',
  CASH_TIMING: 'OFFER',
  PORTFOLIO: 'OFFER',
  CAPITAL: 'ORDER',
  // A cheaper supplier route is agreed in writing before any buyer is offered it, as an arrangement's supply is.
  FULFILMENT: 'SUPPLY_TERMS',
  EVIDENCE: 'RESEARCH',
};

type Span = { low: number; high: number };
const spanText = (d: Span) => (Math.round(d.low) === Math.round(d.high) ? `day ${Math.round(d.low)}` : `day ${Math.round(d.low)}–${Math.round(d.high)}`);

/**
 * The adopted plan as an execution sequence (C-8). Pure. Each step names what
 * it is, when it starts, what it costs, what it rests on, who does it, which
 * earlier step it needs, and the measurement that invalidates it. Permissions
 * and providers a step needs are listed on it as execution dependencies: they
 * never stop the plan being constructed or evaluated (owner, 2026-11-07).
 */
export function planSteps(input: {
  adoption: PlanAdoption;
  reconstruction: Reconstruction | null;
  sales: MarketTest[];
  nextTest: NextTest | null;
  permissionsMissing: string[];
  /**
   * The leading constructed arrangement, when the plan adopts no
   * reconstruction and has no sale: its structure becomes the steps instead of
   * the goal's generic next step alone (`arrangementSteps`).
   */
  arrangement?: { arrangement: ConstructedArrangement; context: Omit<ArrangementStepContext, 'send' | 'collect'> } | null;
  /** The reconstruction's own members (the candidate's ids). Kept for callers; the steps read the members from the reconstruction and `lead`. */
  adoptedIds?: ReadonlySet<string>;
  /** What the goal allows to be spent, major units: the steps say how much of it the plan deploys. */
  capital?: { allowed: number | null; currency: string } | null;
  /** The outreach reply rate measured over the sends recorded: what a reply kill criterion compares against. */
  measuredReply?: MeasuredReply | null;
  /** Each opening's title by its id: how a reconstruction's members are named to a person (NO_INTERNAL_KEYS). */
  titles?: ReadonlyMap<string, string>;
  /**
   * Each opening's days to usable cash as the model holds them, by its id
   * (`modelledCashSpan`): when a reconstruction's collection lands, read the
   * way an arrangement's Collect step reads it.
   */
  cashDays?: ReadonlyMap<string, { span: Span; standing: string }>;
  /** Days left before the goal's deadline: cash usable only after it is not scheduled as if it settled. */
  daysLeft?: number | null;
  /** What Brain has registered and connected (`readCapabilityInventory`): who performs each step is read from it. */
  capabilities?: CapabilityInventory | null;
  /**
   * Each modelled opening as its transaction's members read it (`openingMembers`):
   * who fulfils it, the price, direct cost and days to cash it was judged on.
   * A sale, and a reconstruction's members, are sequenced through to fulfilment
   * and collection from it (`openingSteps`); an opening it lacks keeps its sale alone.
   */
  members?: ReadonlyMap<string, OpeningChainMember> | null;
  /**
   * The openings the plan names as its lead (`leadIdsOf`): the members of the
   * selected strategy. A sale of one of them is its whole transaction, each
   * step acting on it; a sale beside the lead is no step of the plan
   * (STEPS_BELONG_TO_PLAN) — the reading's sales still hold it.
   */
  lead?: readonly string[] | null;
}): PlanStep[] {
  const measured = input.measuredReply ?? null;
  const inventory = input.capabilities ?? undefined;
  const exec = (req: OperationRequest) => stepExecutor(req, inventory);
  const send = input.permissionsMissing.filter((one) => /CONTACT_BUYER|messag/i.test(one));
  const collect = input.permissionsMissing.filter((one) => /QUOTE_AND_INVOICE|ACCEPT_PAYMENT|billing/i.test(one));
  const r = input.reconstruction;
  const steps: PlanStep[] = [];
  const currency = input.capital?.currency ?? 'USD';
  /** A sale as its whole transaction when its opening is a known member: offer, fulfilment, collection (`openingSteps`). */
  let chained = false;
  const sellSteps = (sale: MarketTest, detail: string, kill: string, execution: string[]): PlanStep[] => {
    const offer = saleStep(steps.length + 1, sale, detail, kill, execution, inventory);
    const member = input.members?.get(sale.opportunityId);
    if (!member) return [offer];
    chained = true;
    const { order: _order, dependsOn: _dependsOn, ...rest } = offer;
    return openingSteps(member, { currency, daysLeft: input.daysLeft ?? null, send, collect, ...(inventory ? { capabilities: inventory } : {}) }, rest, steps.length + 1);
  };
  if (input.adoption.source === 'RECONSTRUCTED' && r) {
    const members = membersOf(r.best, input.titles ?? new Map<string, string>());
    // A change on an opening outside the strongest combination is no step: the plan says nothing it will not do (`changeBelongs`).
    const changes = r.best.changes
      .filter((c) => !c.label.startsWith('test:') && changeBelongs(c, members))
      .map((c, at) => ({ c, at }))
      .sort((a, b) => (a.c.startDay?.low ?? 0) - (b.c.startDay?.low ?? 0) || a.at - b.at)
      .map(({ c }) => c);
    // One move made on several openings is one step naming each (NO_DUPLICATE_STEPS).
    for (const move of movesOfChanges(changes, input.titles)) {
      const first = move.changes[0]!;
      const days = move.changes.map((c) => c.startDay).filter((d): d is Span => !!d);
      const cost = move.changes.reduce((sum, c) => sum + c.cost, 0);
      const basis = move.changes.map((c) => c.basis).sort((a, b) => (BASIS_RANK[b] ?? 2) - (BASIS_RANK[a] ?? 2))[0]!;
      const who = ownerOf({ label: move.label, detail: move.detail, cost }, input.titles?.values() ?? []);
      const acts = [...new Set(move.changes.flatMap((c) => changeOpenings(c) ?? []))];
      steps.push({
        order: steps.length + 1,
        label: move.label,
        detail: move.detail,
        startDay: days.length > 0 ? { low: Math.min(...days.map((d) => d.low)), high: Math.max(...days.map((d) => d.high)) } : null,
        cost,
        basis: basis === 'MEASURED' ? 'EVIDENCE' : basis,
        owner: who.owner,
        ownerReason: who.reason,
        dependsOn: null,
        kill: killFor(first, r, measured),
        execution: SENDS.has(first.dimension) ? send : collect,
        executor: exec(changeOperation(first.dimension, cost, SENDS.has(first.dimension) ? send : collect, first.supplier)),
        // Its cost is the reconstruction's own figure for the move: what it commits before any opening pays.
        stage: { stage: CHANGE_STAGE[first.dimension] ?? 'OFFER', costSource: 'MODEL' },
        ...(acts.length > 0 ? { openings: acts, evidence: acts } : {}),
      });
    }
    /*
     * The sale, then the collection, scheduled the way an arrangement's are
     * (`arrangementSteps`): selling starts once the plan's changes are in
     * place, and cash lands that day plus the members' days to usable cash as
     * the model holds them. Production, 2026-11-19: one "Sell and collect"
     * step, day 0 or day 10, cost 0, whatever the members' timing; the model
     * prices no cost of selling or collecting, so neither is written as 0.
     */
    const after = Math.max(0, ...changes.map((c) => c.startDay?.high ?? 0));
    /*
     * A partner sells a clone of an opening, never the opening itself, so the
     * members the owner sells directly start once every other change is in
     * place; only the partner's clone waits for the partner (transfer test
     * small-capital-expensive-opening, 2026-11-20: a 20-day plan the model
     * reached 74.5% read "Collect payment" as after the deadline, because
     * every sale was dated from a partner's 10-day setup).
     */
    // Nor does reach bought beside the outreach the plan already has (capacity, a channel, a partner: the REACH stage) —
    // the engine sells on the held outreach from day 0 and adds the bought contacts from their own day — nor a purchase
    // made only after proof (§99 Q-7), bought because sales have already come in. Only an offer's own terms gate the sale.
    const direct = Math.max(0, ...changes.filter((c) => CHANGE_STAGE[c.dimension] !== 'REACH' && !(c as { afterProof?: boolean }).afterProof).map((c) => c.startDay?.high ?? 0));
    const sellDay: Span = { low: Math.min(direct, after), high: after };
    const named = namedMembers(r.best.members, input.titles);
    // A member is named by its id, or by its title cut at 50 (the reconstruction's own reading): resolved as `adoptReconstruction` resolves it.
    const keptIds = r.best.memberIds && r.best.memberIds.length === r.best.members.length ? r.best.memberIds : null;
    const idOf = (m: string, at: number): string => {
      const kept = keptIds?.[at];
      if (kept) return openingOfMember(kept);
      return input.cashDays?.has(m) ? m : (resolveMember(m, undefined, input.titles ?? new Map<string, string>()) ?? m);
    };
    const memberIds = [...new Set(r.best.members.map(idOf))];
    const sellWhen = changes.length > 0 ? `${spanText(sellDay)}: once the plan's changes above are in place` : `${spanText(sellDay)}: nothing it needs is outstanding`;
    /*
     * The members' own transactions (§3a), when the plan holds every member's
     * facts (`openingMembers`): each member is sold at the price it was judged
     * at, delivered by whoever its evidence names, and collected on its own
     * days to usable cash (`openingSteps`). Planning reliability, 2026-11-22:
     * one "Sell the plan's openings" step for several members carried no
     * price, since no single price is the plan's; a step per opening carries
     * its own price, cost and evidence, and acts only on a member of the
     * selected strategy (STEPS_BELONG_TO_PLAN).
     */
    const chain = memberIds.map((id) => input.members?.get(id) ?? null);
    const known = chain.filter((m): m is OpeningChainMember => m !== null);
    if (known.length === memberIds.length && known.length > 0) {
      const saleOf = new Map(input.sales.map((one) => [one.opportunityId, one]));
      const labels = new Set(steps.map((one) => one.label));
      const unique = (label: string, n: number) => (labels.has(label) ? `${label} (opening ${n})` : label);
      for (const [at, m] of known.entries()) {
        const sale = saleOf.get(m.id);
        const title = m.title.slice(0, 80);
        const of = known.length > 1 ? `, one of the plan's ${known.length} openings${named},` : '';
        const chainSteps = openingSteps(
          m,
          { currency, daysLeft: input.daysLeft ?? null, send, collect, sellDay, ...(inventory ? { capabilities: inventory } : {}) },
          {
            label: `Sell "${title}"`,
            detail: `Offer "${title}"${of} to its buyers for an actual sale or deposit, and record every reply and sale as the plan's measurements.${sale ? ` ${sale.test.test}` : ''}`,
            startDay: sellDay,
            when: sellWhen,
            cost: null,
            basis: 'ESTIMATE',
            owner: 'BRAIN',
            ownerReason: null,
            kill: replyKill(r, measured),
            execution: send,
            executor: exec({ operation: 'SEND_OFFER', execution: send }),
            stage: { stage: 'OFFER', costSource: 'NONE_HELD' },
          },
          steps.length + 1,
        );
        // Two members titled alike are two transactions, never one label twice (NO_DUPLICATE_STEPS).
        for (const one of chainSteps) {
          const label = unique(one.label, at + 1);
          labels.add(label);
          steps.push({ ...one, label });
        }
      }
    } else {
      const sellOrder = steps.length + 1;
      steps.push({
        order: sellOrder,
        label: 'Sell the plan\'s openings',
        detail: `Offer the plan's openings${named} to their buyers for an actual sale or deposit, and record every reply and sale as the plan's measurements. The model prices no cost for selling.`,
        startDay: sellDay,
        when: sellWhen,
        cost: null,
        basis: 'ESTIMATE',
        owner: 'BRAIN',
        ownerReason: null,
        dependsOn: null,
        kill: replyKill(r, measured),
        execution: send,
        executor: exec({ operation: 'SEND_OFFER', execution: send }),
        stage: { stage: 'OFFER', costSource: 'NONE_HELD' },
      });
      const held = memberIds.map((id) => input.cashDays?.get(id) ?? null).filter((d): d is { span: Span; standing: string } => d !== null);
      const cash: Span | null = held.length > 0 ? { low: Math.min(...held.map((d) => d.span.low)), high: Math.max(...held.map((d) => d.span.high)) } : null;
      const lands: Span | null = cash ? { low: Math.round(sellDay.low + cash.low), high: Math.round(sellDay.high + cash.high) } : null;
      const daysLeft = input.daysLeft ?? null;
      const late = lands !== null && daysLeft !== null && lands.low > daysLeft;
      const standing = [...new Set(held.map((d) => d.standing))].join('; ');
      const partial = held.length > 0 && held.length < memberIds.length ? ` for the ${held.length} of ${memberIds.length} openings whose days the model holds` : '';
      steps.push({
        order: steps.length + 1,
        label: 'Collect payment',
        detail: `Collect each buyer's payment or deposit and record it against the goal.${cash ? ` Cash is usable about ${Math.round(cash.low)}–${Math.round(cash.high)} days after a sale${partial} (${standing})${daysLeft !== null && lands ? `, ${lands.high <= daysLeft ? 'inside' : late ? 'OUTSIDE' : 'partly outside'} the ${daysLeft} days left` : ''}.` : ' When cash is usable is not yet established: the first sale measures it.'} ${COLLECTION_COST}`,
        startDay: late ? null : lands,
        when: late
          ? `not scheduled: cash would be usable on ${spanText(lands!)} (${standing}), after the ${daysLeft} days left`
          : lands
            ? `${spanText(lands)}: the sale's day plus ${Math.round(cash!.low)}–${Math.round(cash!.high)} days to usable cash${partial} (${standing})`
            : 'not yet scheduled: set by days to usable cash, which the first sale measures',
        cost: 0,
        basis: held.length > 0 && held.every((d) => d.standing === 'proven') ? 'EVIDENCE' : 'ASSUMPTION',
        owner: 'BRAIN',
        ownerReason: null,
        dependsOn: sellOrder,
        kill: `cash would not be usable by day ${daysLeft ?? 'the deadline'} → re-plan the plan's payment terms (a deposit or a presale) or drop the opening`,
        execution: collect,
        executor: exec({ operation: 'COLLECT_PAYMENT', execution: collect }),
        ...(daysLeft !== null && lands ? { withinLimits: lands.high <= daysLeft } : {}),
        ...(known.length > 0 ? { evidence: [...new Set(known.flatMap((m) => m.evidence.collect))] } : {}),
        stage: { stage: 'COLLECT', costSource: 'NOT_OWNERS', ...(late ? { unscheduled: 'AFTER_DEADLINE' as const } : lands ? {} : { unscheduled: 'NO_MODEL_DAYS' as const }) },
      });
    }
    /*
     * A sale beside the reconstruction is no step of it: every execution step
     * belongs to the strategy actually selected (STEPS_BELONG_TO_PLAN, owner,
     * 2026-11-20). The reading still holds that sale (`sales`, `pursueSales`);
     * the sequence is the adopted members' own transactions above. Planning
     * reliability, 2026-11-22: such a sale stood as one step, with no opening
     * named so the rule could not see it, no price and no delivery or collection.
     */
    // Read in order (STEPS_SCHEDULED): a sale that starts now is not listed after a step that starts later.
    inDayOrder(steps);
  } else {
    // Only a sale of a member of the selected strategy is a step of it (STEPS_BELONG_TO_PLAN); with no lead named, every sale is the plan.
    const lead = new Set((input.lead ?? []).map(openingOfMember));
    for (const sale of input.sales.filter((one) => lead.size === 0 || lead.has(one.opportunityId))) steps.push(...sellSteps(sale, sale.test.test, replyKill(r, measured), [...send, ...collect]));
    const arrangementOf = (startAt: number) => (input.arrangement ? arrangementSteps(input.arrangement.arrangement, { ...input.arrangement.context, send, collect, ...(inventory ? { capabilities: inventory } : {}) }, startAt) : []);
    /*
     * The leading arrangement is sequenced when nothing else is, and beside
     * the sales when it is itself a member of the selected strategy: a member
     * is given its whole chain, never left to a generic goal step (planning
     * reliability, 2026-11-22: a candidate of an opening and an arrangement
     * read the opening's sale and "Establish buyers who have actually agreed",
     * the arrangement a member with no step).
     */
    const arrangementLeads = !!input.arrangement && lead.has(`${ARRANGEMENT_ID_PREFIX}${input.arrangement.arrangement.key}`);
    let built = steps.length === 0 || arrangementLeads ? arrangementOf(steps.length + 1) : [];
    const t = input.nextTest;
    /*
     * The goal's own next step is the plan's honest first step when nothing
     * else is (an opening with no price: "Establish an offer and a price").
     * Beside an arrangement whose own sequence already establishes that link,
     * it only repeats it (production, 2026-11-19: "Establish an offer and a
     * price · day 0" appended after "Run the next group · day 12–56", the
     * arrangement's research and offer steps having established it). Otherwise
     * it runs beside the arrangement, from day 0, so it is listed first.
     */
    const covered = t !== null && t.by === 'BRAIN' && built.some((b) => b.arrangement && (LINK_STAGES[t.link] ?? []).includes(b.arrangement.stage));
    if ((steps.length === 0 || input.arrangement) && t && !covered) {
      const beside = steps.length > 0 || built.length > 0;
      if (built.length > 0) built = arrangementOf(steps.length + 2);
      const sells = t.link === 'CONVERSION';
      const establish: PlanStep = {
        order: steps.length + 1,
        // CHAIN_LABEL names the missing link ("an offer and a price"), not an act; a step is something done.
        label: `Establish ${CHAIN_LABEL[t.link]}`,
        detail: beside ? `The goal's own search, run in parallel with the plan's other steps rather than after them: ${t.test}` : t.test,
        startDay: { low: 0, high: 0 },
        ...(beside ? { when: 'day 0: the goal\'s search runs now, beside the plan\'s other steps' } : {}),
        // Measuring conversion is selling, which the model prices nothing for: unestablished. Research and a decision spend nothing.
        cost: sells ? null : 0,
        basis: 'ESTIMATE',
        owner: t.by,
        ownerReason: t.by === 'PERSON' ? t.blocker : null,
        dependsOn: null,
        kill: sells ? replyKill(r, measured) : 'the research returns no sourced answer twice → ask a different way, then re-plan without this opening',
        execution: sells ? [...send, ...collect] : [],
        /*
         * The goal's own step is Brain's work by its link: selling measures
         * conversion, anything else is established by research — or, when the
         * next test waits on the owner (a grant, a connection, how much may be
         * committed), applied by the planner once the owner decides. What the
         * owner holds is an approval, never the step's labor (owner, 2026-11-20).
         */
        executor: exec({
          operation: sells ? 'SEND_OFFER' : t.by === 'PERSON' ? 'PLAN_DECISION' : 'RESEARCH',
          execution: sells ? [...send, ...collect] : [],
          authority: t.by === 'PERSON' ? (t.blocker ?? 'a decision only the owner can take') : null,
        }),
        // Beside a leading arrangement's steps, the goal's own search keeps running in parallel.
        ...(beside ? { kind: sells ? ('VALIDATE' as const) : ('RESEARCH' as const), question: t.test, requires: [], withinLimits: null } : {}),
        stage: sells ? { stage: 'OFFER', costSource: 'NONE_HELD' } : { stage: 'RESEARCH', costSource: 'NOT_SPENT' },
      };
      /*
       * Selling to measure the close rate is the plan's whole transaction when
       * nothing else is (2026-11-24 investigation, r28/r30): a startable plan read
       * one step, "Establish buyers who have actually agreed", with no delivery and
       * no collection, because the sale it measures was not among the reading's
       * sales. A selling step that stands alone is sequenced through fulfilment and
       * collection exactly as a sale is (`openingSteps`), on the plan's lead opening.
       */
      const member = sells && !beside ? soleChainMember(input.members ?? null, input.lead ?? null) : null;
      if (member) {
        const { order: _order, dependsOn: _dependsOn, ...rest } = establish;
        steps.push(...openingSteps(member, { currency, daysLeft: input.daysLeft ?? null, send, collect, ...(inventory ? { capabilities: inventory } : {}) }, { ...rest, label: `Sell "${member.title.slice(0, 80)}"` }, steps.length + 1));
        chained = true;
      } else steps.push(establish);
    }
    steps.push(...built);
    // A sale's chain runs from day 0 to its collection: read in day order, each step still naming the one it follows (STEPS_SCHEDULED).
    if (chained) inDayOrder(steps);
  }
  /*
   * The capital the plan deploys, against what the goal allows (transfer test,
   * 2026-11-19, goal wst_4f0c312400e1425dab2e: two steps and none of the
   * USD 25,000 allowed, and nothing said so). Read from the steps' own costs,
   * never assumed; it is stated on the first step.
   */
  if (input.capital && input.capital.allowed !== null && input.capital.allowed > 0 && steps[0]) {
    const deployed = steps.reduce((sum, one) => sum + Math.max(0, one.cost ?? 0), 0);
    const unpriced = steps.filter((one) => one.cost === null).length;
    const cur = input.capital.currency;
    const rest = unpriced > 0 ? `, plus ${unpriced} step(s) whose cost the model does not establish` : deployed === 0 ? ': none of its steps spends money' : '';
    const line = `This plan commits ${cur} ${Math.round(deployed).toLocaleString('en-US')} of the ${cur} ${Math.round(input.capital.allowed).toLocaleString('en-US')} the goal allows${rest}${deployed > input.capital.allowed ? ' — OVER the limit' : ''}.`;
    steps[0] = { ...steps[0], detail: `${line} ${steps[0].detail}` };
  }
  // A step that starts later needs the latest step that starts before it. An arrangement's steps (`requires` set) carry their own sequence,
  // and a step built with its own dependency keeps it: collection follows its sale, not whichever move happens to start just before it.
  for (const step of steps) {
    const low = step.startDay?.low ?? 0;
    if (low <= 0 || step.requires || step.dependsOn !== null) continue;
    const before = steps.filter((one) => one.order < step.order && (one.startDay?.low ?? 0) < low);
    step.dependsOn = before.length > 0 ? before[before.length - 1]!.order : null;
  }
  // A plan that sells without delivering or collecting says so on its selling step, never silently (2026-11-24 investigation).
  const lacking = missingTransactionStages(steps);
  const seller = lacking.length > 0 ? steps.find((one) => one.stage?.stage === 'OFFER' || one.stage?.stage === 'REACH') : undefined;
  if (seller) seller.detail = `${seller.detail} Not yet a whole transaction: the plan holds no step to ${lacking.join(' or ')} for what it sells; ${lacking.length > 1 ? 'they are' : 'it is'} established before a buyer is asked to pay.`;
  return steps;
}

/** The stages of an arrangement's own steps that establish a link of the chain: a goal step for that link beside them repeats them. */
const LINK_STAGES: Partial<Record<ChainLink, ArrangementStage[]>> = {
  REACHABLE_BUYER: ['REACH'],
  OFFER_AND_PRICE: ['OFFER'],
  CONVERSION: ['OFFER'],
  FULFILMENT: ['DELIVER'],
  SETTLES_IN_TIME: ['COLLECT'],
};

/**
 * The opening a lone selling step sells: the first lead opening whose facts the
 * plan holds, or — with no lead named — the one opening the plan holds facts
 * for. Several openings and no lead is no choice the steps may make: null. Pure.
 */
export function soleChainMember(members: ReadonlyMap<string, OpeningChainMember> | null, lead: readonly string[] | null): OpeningChainMember | null {
  if (!members || members.size === 0) return null;
  for (const id of lead ?? []) {
    const m = members.get(openingOfMember(id));
    if (m) return m;
  }
  if ((lead ?? []).length > 0) return null;
  const found = [...members.values()].filter((m) => !isArrangementId(m.id));
  return found.length === 1 ? found[0]! : null;
}

/** The stages of one transaction a startable plan must hold, as a reader names them. */
export const TRANSACTION_STAGES = ['offer and reach the buyer', 'deliver', 'collect payment'] as const;
export type TransactionStage = (typeof TRANSACTION_STAGES)[number];

/**
 * Which stages of a transaction a plan's steps leave out, when they sell at all
 * (2026-11-24 investigation): a plan that sells must also deliver and collect,
 * or say that it does not. Steps that sell nothing (research, a decision) are a
 * search, not a transaction, and lack nothing here. Pure.
 */
export function missingTransactionStages(steps: readonly Pick<PlanStep, 'stage' | 'executor'>[]): TransactionStage[] {
  const op = (s: Pick<PlanStep, 'executor'>) => s.executor?.operation ?? null;
  const sells = steps.some((s) => s.stage?.stage === 'OFFER' || s.stage?.stage === 'REACH' || op(s) === 'SEND_OFFER' || op(s) === 'REACH_BUYERS');
  if (!sells) return [];
  const out: TransactionStage[] = [];
  if (!steps.some((s) => s.stage?.stage === 'DELIVER' || op(s) === 'BRAIN_PRODUCES' || op(s) === 'SUPPLIER_DELIVERS')) out.push('deliver');
  if (!steps.some((s) => s.stage?.stage === 'COLLECT' || op(s) === 'COLLECT_PAYMENT')) out.push('collect payment');
  return out;
}

/**
 * How many times what remains a figure may stand before it is no plan's reach on
 * inputs not all established (production baseline, 2026-11-24, independent judge:
 * "$3,161,954 toward $1,500"). Two orders of magnitude: a plan whose established
 * inputs carry it there keeps its figure; one that gets there on swept inputs does not.
 */
export const IMPLAUSIBLE_MULTIPLE = 100;

/** Money figures in a text, withheld: a flag says what is wrong without presenting the figure it doubts. Pure. */
export function withoutFigures(text: string): string {
  return text.replace(/(?:[$£€]\s?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?[kKmM]\b)?|\b\d+(?:,\d{3})*(?:\.\d+)?\s?(?:USD|EUR|GBP)\b)/g, '[figure withheld]');
}

/**
 * The reach figures a reading presents, with every one it cannot stand behind
 * withheld (production baseline, 2026-11-24): a strategy's or candidate's settled
 * figure more than `IMPLAUSIBLE_MULTIPLE` × what remains, on a chain not every link
 * of which is established, is withheld — set to null, and the basis says why. A
 * figure established inputs carry, and every other figure, is kept unchanged.
 * Returns what it withheld, one line each. Mutates the strategies and candidate given.
 */
export function withholdImplausibleFigures(
  strategies: StrategyReading[],
  candidate: PlanAcceptance['candidate'],
  remaining: number,
): string[] {
  if (!(remaining > 0)) return [];
  const bound = remaining * IMPLAUSIBLE_MULTIPLE;
  const over = (x: number | null | undefined): x is number => typeof x === 'number' && x > bound;
  const withheld: string[] = [];
  const why = (figure: number) => `a settled figure of ${Math.round(figure / remaining)}× what remains, on inputs not all established, is not shown as a reach`;
  for (const s of strategies) {
    if (s.chainComplete) continue;
    const top = Math.max(s.sweep.settledP50 ?? 0, s.sweep.settledP90 ?? 0, s.conservativeSettled ?? 0);
    if (!over(top)) continue;
    if (over(s.sweep.settledP50)) s.sweep = { ...s.sweep, settledP50: null };
    if (over(s.sweep.settledP90)) s.sweep = { ...s.sweep, settledP90: null };
    if (over(s.conservativeSettled)) s.conservativeSettled = null;
    s.basis = `${s.basis ? `${s.basis}; ` : ''}figures withheld: ${why(top)}`;
    withheld.push(`"${s.label.slice(0, 80)}": ${why(top)}`);
  }
  if (candidate && over(candidate.settledP50) && (candidate.reachBasis !== 'PROBABILITY' || (candidate.unsupported?.length ?? 0) > 0)) {
    withheld.push(`the candidate "${candidate.label.slice(0, 80)}": ${why(candidate.settledP50)}`);
    candidate.settledP50 = null;
  }
  if (candidate?.assumedUpside && over(candidate.assumedUpside.settledP50)) {
    withheld.push(`the candidate's assumed upside: ${why(candidate.assumedUpside.settledP50)}`);
    delete candidate.assumedUpside;
  }
  return withheld;
}

/**
 * Why the plan's steps are no plan to present, or null (production baseline,
 * 2026-11-24: a plan was presented whose only collection landed after the goal's
 * 21-day window). A plan whose every collection step is scheduled after the
 * deadline brings no cash inside the window, whatever else it does: it is
 * excluded, with this reason. A plan with one collection inside the window, or
 * whose timing nobody established yet, is not. Pure.
 */
export function collectsOutsideWindow(steps: readonly Pick<PlanStep, 'stage' | 'arrangement' | 'label' | 'when'>[], daysLeft: number | null): string | null {
  if (daysLeft === null) return null;
  const collect = steps.filter((one) => (one.stage ?? one.arrangement)?.stage === 'COLLECT');
  if (collect.length === 0) return null;
  if (!collect.every((one) => (one.stage ?? one.arrangement)?.unscheduled === 'AFTER_DEADLINE')) return null;
  const first = collect[0]!;
  return `its collection ("${first.label.slice(0, 80)}") ${first.when ? `is ${first.when.replace(/^not scheduled: /, '')}` : `lands after the ${daysLeft} days left`}, so it brings no cash inside the goal's window`;
}

/** A sale the reading holds, as a step: it starts now, and the model prices no cost for sending it (unestablished, never 0). */
function saleStep(order: number, sale: MarketTest, detail: string, kill: string, execution: string[], inventory?: CapabilityInventory): PlanStep {
  return {
    order,
    label: `Sell "${sale.title.slice(0, 80)}"`,
    detail,
    startDay: { low: 0, high: 0 },
    cost: null,
    basis: 'ESTIMATE',
    owner: 'BRAIN',
    ownerReason: null,
    dependsOn: null,
    kill,
    execution,
    executor: stepExecutor({ operation: 'SEND_OFFER', execution }, inventory),
    stage: { stage: 'OFFER', costSource: 'NONE_HELD' },
  };
}

/**
 * The operation a reconstruction's change is, by its dimension — what the
 * change does, never the words it is described in. Buying sending capacity is
 * an acquisition; buying leads needs an ad or marketplace account; a partner is
 * recruited by Brain's outreach and its agreement is the owner's signature.
 */
function changeOperation(dimension: string, cost: number, execution: string[], supplier?: string): OperationRequest {
  const byDimension: Record<string, StepOperation> = {
    CAPACITY: 'BUY_SENDING_CAPACITY',
    ACQUISITION: 'BUY_PAID_LEADS',
    PARTNER: 'RECRUIT_PARTNER',
    MARKET: 'REACH_BUYERS',
    PRICE: 'SET_OFFER',
    TRANSACTION: 'SET_OFFER',
    CASH_TIMING: 'SET_PAYMENT_TERMS',
    CAPITAL: 'SET_PAYMENT_TERMS',
    // Engaging a cheaper supplier is asking it for a written quote: Brain's messages, the supplier's work.
    FULFILMENT: 'NEGOTIATE_TERMS',
    PORTFOLIO: 'PLAN_DECISION',
    EVIDENCE: 'RESEARCH',
  };
  const operation = byDimension[dimension] ?? 'PLAN_DECISION';
  return {
    operation,
    cost,
    execution,
    ...(operation === 'RECRUIT_PARTNER' ? { provider: 'a partner who already serves the buyers, who refers them', signs: "the referral agreement is signed in the owner's name" } : {}),
    ...(dimension === 'FULFILMENT' ? { provider: supplier ?? 'a cheaper supplier of the same deliverable' } : {}),
  };
}

/**
 * Steps in the order they start, renumbered, each reference to an earlier
 * step following it. A step with no day of its own stays after the step it
 * follows. Stable: steps starting the same day keep their order. In place.
 */
function inDayOrder(steps: PlanStep[]): void {
  const key = (s: PlanStep) => (s.startDay ? s.startDay.low : s.dependsOn !== null ? Number.POSITIVE_INFINITY : 0);
  const sorted = steps.map((s, at) => ({ s, at })).sort((a, b) => key(a.s) - key(b.s) || a.at - b.at).map(({ s }) => s);
  const renumber = new Map(sorted.map((s, at) => [s.order, at + 1]));
  for (const [at, s] of sorted.entries()) {
    steps[at] = {
      ...s,
      order: at + 1,
      dependsOn: s.dependsOn === null ? null : (renumber.get(s.dependsOn) ?? null),
      ...(s.requires ? { requires: s.requires.map((n) => renumber.get(n) ?? n) } : {}),
    };
  }
}

/**
 * A reconstruction's members as a person reads them: each by its title, an id
 * with no title held left out (production, 2026-11-19: "Sell and collect" read
 * "Offer the plan's openings (cop_…, arr_…)"). Empty when none can be named. Pure.
 */
export function namedMembers(members: readonly string[], titles: ReadonlyMap<string, string> | undefined): string {
  const named = [...new Set(members.map((m) => titles?.get(m) ?? (internalKeyIn(m) ? null : m)).filter((t): t is string => !!t && !internalKeyIn(t)).map((t) => t.slice(0, 80)))];
  return named.length > 0 ? ` (${named.slice(0, 4).join('; ')}${named.length > 4 ? `; ${named.length - 4} more` : ''})` : '';
}

/** The adopted plan's first step as the reading's next step. */
export function stepAsNextTest(step: PlanStep, reconstruction: Reconstruction | null): NextTest {
  const changes = reconstruction?.best.changes ?? [];
  const change = changes.find((c) => titleOfChange(c) === step.label || c.label === step.label) ?? movesOfChanges(changes).find((m) => m.label === step.label)?.changes[0];
  const link = change ? (CHANGE_LINK[change.dimension] ?? 'OFFER_AND_PRICE') : 'CONVERSION';
  return {
    link,
    test: `${step.label}: ${step.detail}${step.startDay ? ` (day ${step.startDay.low}${step.startDay.high !== step.startDay.low ? `–${step.startDay.high}` : ''})` : ''}. Stop if ${step.kill}.`,
    by: step.owner,
    blocker: step.owner === 'PERSON' ? `${step.ownerReason ?? 'the owner'}${step.execution.length ? `; to execute it also needs ${step.execution.join(', ')}` : ''}` : null,
  };
}

/** The card field a sweep condition on one opening would settle. */
const CONDITION_FIELD: Record<string, string> = {
  respond: 'conversionRates',
  close: 'conversionRates',
  volume: 'buyerVolume',
  price: 'revenueRange',
  directCost: 'directCosts',
  daysToCash: 'timeToFirstCash',
  capital: 'requiredCapital',
};
/** Conditions only selling measures. */
const LEARNED_BY_SELLING = /^(reply|close|respond|outreach-capacity)/;

/** The researchable condition a binding factor names; VOLUME and CAPITAL are not research questions. */
const BINDING_CONDITION: Partial<Record<Factor, string>> = {
  CASH_TIMING: 'days to cash',
  PRICE: 'ticket',
  MARKET_SIZE: 'market',
  COST: 'direct cost',
  REPLY: 'reply',
  CLOSE: 'close',
};

/**
 * The research the adopted plan needs (C-9). Pure. The questions come from
 * the plan Brain actually holds: the reply rate it needs, each condition the
 * sweep found the requirement needs outside today's evidence, the conditions
 * that swing it most, and every assumed change it rests on. Each is decided
 * against the calendar exactly as the run's own information value is (§79),
 * and the run's legacy questions follow, kept to the plan's own openings.
 */
export function planResearchPriority(input: {
  reconstruction: Reconstruction | null;
  adoption: PlanAdoption;
  adoptedIds: string[];
  daysLeft: number | null;
  remaining: number;
  legacy: ResearchPriority[];
}): ResearchPriority[] {
  const r = input.reconstruction;
  if (!r) return input.legacy;
  const adopted = input.adoption.source === 'RECONSTRUCTED';
  const plan = adopted ? r.best : r.baseline;
  const gap = Math.max(0.01, r.required - plan.reach);
  const executionDaysP90 = Math.max(0, ...plan.changes.map((c) => c.startDay?.high ?? 0));
  const out = new Map<string, ResearchPriority>();
  const add = (variable: string, opportunityId: string | null, field: string | null, value: number, learnable: boolean, why: string) => {
    const held = out.get(variable);
    if (held && held.value >= value) return;
    const verdict = decideResearch(
      { key: variable, informationValue: value, changesDecision: true, researchDays: RESEARCH_TURNAROUND_DAYS, learnableInExecution: learnable },
      { daysLeft: input.daysLeft ?? 365, executionDaysP90 },
    );
    out.set(variable, { variable, opportunityId, field, value, changesDecision: true, decision: verdict.decision, reason: `${why}; ${verdict.reason}` });
  };
  if (r.requiredReply !== null) add('plan:reply', null, null, gap, true, `the plan needs a reply rate of about ${pctOf(r.requiredReply)} to reach ${pctOf(r.required)}`);
  /*
   * The factor that binds the plan is always asked (production 2026-11-21 23:40Z, goal
   * wst_7b4fcbb5f2384f31b6c3): "binding CASH_TIMING … reach 96.7% (+90.5%)" from 9.9%, and no
   * question about days to cash existed — the questions above come from the sweep, which never named
   * it. Only the top one, valued by what moving it alone lifts, so it ranks first within the per-read
   * cap; outreach volume is measured by sending and capital is a person's decision, never research.
   */
  const binding = r.diagnosis.find((d) => d.liftReach > 0 && BINDING_CONDITION[d.factor] !== undefined);
  if (binding && r.diagnosis[0] === binding) {
    const condition = BINDING_CONDITION[binding.factor]!;
    add(`plan:${condition}`, null, null, Math.max(gap, binding.liftReach), LEARNED_BY_SELLING.test(condition), `it binds the plan: ${binding.moved} lifts reach by ${pctOf(binding.liftReach)}`);
  }
  const sweep = r.exploration?.sweep ?? null;
  const split = (condition: string) => {
    const at = condition.indexOf(':');
    return at > 0 ? { field: condition.slice(0, at), opportunityId: condition.slice(at + 1) } : { field: condition, opportunityId: null };
  };
  for (const req of sweep?.requirements ?? []) {
    if (req.inEvidence) continue;
    const s = split(req.condition);
    add(
      `plan:${req.condition}`,
      s.opportunityId,
      s.opportunityId ? (CONDITION_FIELD[s.field] ?? null) : null,
      gap / Math.max(1, req.needed ?? 20),
      LEARNED_BY_SELLING.test(s.field),
      req.needed === null ? `no multiple of ${req.condition} up to ×20 carries the plan alone` : `the plan needs ${req.condition} at ×${req.needed.toFixed(2)} of today's middle estimate, and evidence reaches ×${req.evidencedTop.toFixed(2)}`,
    );
  }
  for (const one of sweep?.sensitive ?? []) {
    const s = split(one.condition);
    add(`plan:${one.condition}`, s.opportunityId, s.opportunityId ? (CONDITION_FIELD[s.field] ?? null) : null, one.swing / Math.max(1, input.remaining), LEARNED_BY_SELLING.test(s.field), `its range swings the plan's mean by ${moneyOf(one.swing)}`);
  }
  if (adopted) {
    const assumed = plan.changes.filter((c) => c.basis !== 'MEASURED' && !c.label.startsWith('test:'));
    const lift = Math.max(0.01, plan.reach - r.baseline.reach);
    for (const c of assumed) add(`plan:change:${c.dimension}:${c.label}`, null, null, lift / assumed.length, true, `the plan rests on "${c.label}" (${c.basis.toLowerCase()}), which only executing it measures`);
  }
  const keep = new Set(input.adoptedIds);
  const legacy = adopted ? input.legacy.filter((one) => one.opportunityId === null || keep.has(one.opportunityId)) : input.legacy;
  return [...[...out.values()].sort((a, b) => b.value - a.value), ...legacy];
}

/**
 * The search brief, chosen by what binds the plan (C-9). The reconstruction's
 * own brief is one template whatever binds; a goal bound by reply rate needs
 * buyers who already ask, one bound by price needs larger tickets, one bound
 * by cash timing needs buyers who pay up front.
 */
export function planSearchBrief(r: Reconstruction, remaining: number, daysLeft: number | null): string {
  const ticket = Math.max(250, Math.round(remaining / 20 / 50) * 50);
  const days = Math.max(1, (daysLeft ?? 30) - 5);
  const factor = r.diagnosis[0]?.factor ?? null;
  const lead = r.structural
    ? `The openings held cannot reach the requirement even at their best (${pctOf(r.headroom.reach)}), so the pool must change. `
    : '';
  const by: Record<string, string> = {
    VOLUME: `Outreach volume binds: find buyers reachable in bulk without cold email — a marketplace category with open demand, a partner's list, a directory with a purchase route — delivering within ${days} days at ${moneyOf(ticket)} or more, with a dated example of each.`,
    REPLY: `Reply rate binds: find buyers who already ask — posted requests, RFQs, marketplace job posts, open submission calls — for work deliverable within ${days} days at ${moneyOf(ticket)} or more, with one dated request each and what the buyer pays.`,
    CLOSE: `Close rate binds: find offers buyers accept at first contact — published conversion for this kind of buyer, dated urgent needs, buyers with a budget already approved — at ${moneyOf(ticket)} or more within ${days} days.`,
    PRICE: `Revenue per deal binds: find buyers paying ${moneyOf(ticket * 2)} or more per transaction — retainers, bundles, implementation engagements — with a published price and a dated buyer, settling within ${days} days.`,
    CASH_TIMING: `Cash timing binds: find buyers who pay up front — at checkout, by deposit at signing, prepaid — for work deliverable within ${days} days, with the published payment terms.`,
    MARKET_SIZE: `Market size binds: find larger buyer populations with a count and a source — a register, association list or marketplace category — buying at ${moneyOf(ticket)} or more within ${days} days.`,
    CAPITAL: `Money tied up binds: find arrangements the buyer funds — prepaid fulfilment, drop-shipping, deposits that pay the supplier — at ${moneyOf(ticket)} or more within ${days} days.`,
    // The reconstruction names the openings whose route is unknown (`fulfilmentQuestions`); they ride on the brief after it.
    COST: `Direct cost binds: find who fulfils the plan's deliverables for these same buyers at a lower published cost per deal — a subcontractor, a wholesale supplier, a marketplace provider — with a dated quote or price list each.${r.searchBrief.includes(' Fulfilment: ') ? ` ${r.searchBrief.slice(r.searchBrief.indexOf(' Fulfilment: ') + 13)}` : ''}`,
  };
  const body = factor && by[factor] ? by[factor]! : r.searchBrief;
  const asks = r.exploration?.asks?.length ? ` Directions Brain explored need answers to: ${r.exploration.asks.slice(0, 3).join(' ')}` : '';
  return `${lead}${body} Look in any industry, including ones not searched before.${asks}`.trim();
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
 * Why an opening is researched before it is sold, or null when it may be sold.
 *
 * A route Brain proposed for a goal (`routeProposal.ts`) carries the model's
 * hypotheses — buyer, offer, price — as RECOMMENDATION facts, and its deep
 * dive is what tests them. Until that dive has settled and while its price is
 * still not something a source or a buyer established, offering it would be
 * selling a guess. Production, 2026-11-25: fresh goals recorded "Selling …
 * now" for six unresearched routes each, while no dive on any of them had
 * started. A buyer's agreement, or a price from evidence, ends the wait. Pure.
 */
export function researchBeforeSale(one: Pick<ModelledOpportunity, 'opportunity' | 'price' | 'agreed'>): string | null {
  const o = one.opportunity;
  if (!isRouteOpening(o) || o.validationSettledAt || one.agreed) return null;
  if (one.price.provenance === 'EVIDENCE' || one.price.provenance === 'HISTORICAL') return null;
  const dive =
    o.validationState === 'PENDING' || o.validationState === 'RUNNING'
      ? 'its deep dive is under way'
      : o.validationState === 'NEEDS_PERSON'
        ? 'its deep dive is waiting on a person'
        : 'its deep dive has not started yet';
  return `research first: its buyer, offer and price are the route proposal's hypotheses (the price is ${one.price.provenance}, not evidence), and ${dive}`;
}

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
  /** The adopted plan's openings (C-6): when the reconstruction is the plan, its members are sold first. */
  adopted: ReadonlySet<string> | null = null,
): Promise<MarketTest[]> {
  const best = new Set(adopted && adopted.size > 0 ? adopted : (portfolio?.best?.members.map((one) => one.opportunityId) ?? []));
  const settled = new Map((portfolio?.demand ?? []).map((one) => [one.opportunityId, one.refused ? -1 : one.revenue.p50]));
  /*
   * A sale this goal cannot count is not this goal's step (rehearsal, 2026-11-18:
   * a 7-day goal's steps sold a 21-day resale and a 30-day retainer). Dropped
   * only when the goal's own limits rule it out: the quant engine refused its
   * outlay, or even its earliest settlement lands after the deadline and the
   * engine settles nothing from it in nine worlds of ten (a deposit or a
   * milestone inside the window keeps it). It stays on the goal's considered
   * list; only the sales order leaves it out.
   */
  const demandOf = new Map((portfolio?.demand ?? []).map((one) => [one.opportunityId, one]));
  const outsideLimits = (id: string): boolean => {
    const d = demandOf.get(id);
    // Refused, or held out because an estimate it rests on breaks the goal's limits (NO_FAVOURABLE_UNKNOWN): not sold until restructured.
    if (d?.refused || d?.heldOut) return true;
    const days = byId.get(id)?.daysToCash;
    const earliest = days ? (days.low ?? days.value) : null;
    return target.daysLeft !== null && earliest !== null && earliest > target.daysLeft && d !== undefined && d.revenue.p90 <= 0;
  };
  const ranked = considered
    .filter((one) => SELLABLE.has(one.stage) && !isArrangementId(one.opportunityId) && byId.has(one.opportunityId) && !outsideLimits(one.opportunityId) && !researchBeforeSale(byId.get(one.opportunityId)!))
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

/** The openings `salesFor` would rank but holds for research first, each with why. Pure. */
export function heldForResearch(considered: readonly ConsideredOpening[], byId: ReadonlyMap<string, ModelledOpportunity>): { opportunityId: string; title: string; reason: string }[] {
  const out: { opportunityId: string; title: string; reason: string }[] = [];
  for (const one of considered) {
    if (!SELLABLE.has(one.stage) || isArrangementId(one.opportunityId)) continue;
    const modelled = byId.get(one.opportunityId);
    const reason = modelled ? researchBeforeSale(modelled) : null;
    if (reason) out.push({ opportunityId: one.opportunityId, title: one.title, reason });
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
  const granted = async (action: string) => (await planAuthority(target.projectId, action)).ok;
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
  if (reading.executionPolicy !== 'SQUEEZE') return;
  await holdForResearch(goal, reading.researchFirst ?? []);
  if (reading.sales.length === 0) return;
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

/** The goal event that says a sale waits for its research, once per opening until it is sold. */
export const SALE_WAITS_FOR_RESEARCH = 'GOAL_SALE_WAITS_FOR_RESEARCH';

/**
 * Record, once per opening, why a sale waits for research, and stop pursuing a
 * sale an earlier reading linked before this rule held (the PURSUES link is
 * superseded with the reason, never deleted). Idempotent by the goal's events.
 */
async function holdForResearch(goal: Workstream, held: readonly { opportunityId: string; title: string; reason: string }[]): Promise<void> {
  if (held.length === 0) return;
  const links = await listLinks(goal.id);
  const said = new Set(
    (await workstreamEventsOfKind(goal.id, SALE_WAITS_FOR_RESEARCH, new Date(0).toISOString(), 500)).map((one) => String(one.detail['opportunityId'] ?? '')),
  );
  for (const one of held) {
    const pursued = links.filter((link) => link.kind === 'OPPORTUNITY' && link.ref === one.opportunityId && link.relation === 'PURSUES');
    for (const link of pursued) await supersedeLink(link.id, one.reason.slice(0, 300));
    if (said.has(one.opportunityId) && pursued.length === 0) continue;
    await recordWorkstreamEvent({
      workstreamId: goal.id,
      kind: SALE_WAITS_FOR_RESEARCH,
      summary: `Not selling "${one.title.slice(0, 120)}" yet: ${one.reason}.`.slice(0, 400),
      detail: { opportunityId: one.opportunityId, reason: one.reason, stoppedPursuing: pursued.length > 0 },
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
  /**
   * ASSUMPTION_ONLY when the held plan counts a leg that cannot be executed yet: `reach` is then
   * coverage over assumptions, and `supportedReach` is the reach over its supported legs alone.
   */
  reachBasis?: 'SUPPORTED' | 'ASSUMPTION_ONLY' | null;
  supportedReach?: number | null;
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
    ...(reading.objective?.support
      ? { reachBasis: reading.objective.support.basis, supportedReach: reading.objective.support.reach === null ? null : Math.round(reading.objective.support.reach * 100) / 100 }
      : {}),
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
    // What the strongest plan holds on no assumed move (invariant 39): the reach it is adopted on.
    established: r.established ? round3(r.established.reach) : null,
    requiredReply: r.requiredReply === null ? null : round3(r.requiredReply * 100) / 100,
    binding: r.diagnosis[0]?.factor ?? null,
    structural: r.structural,
    variants: r.rounds.reduce((n, x) => n + x.tried.length, 0),
    // What the multidirectional exploration concluded (§101): a different winning way of reasoning is a new row.
    // How many directions ran is not a conclusion — the library changes it between identical reads.
    explored: r.exploration
      ? { winner: r.exploration.winner?.direction.name ?? null, replaced: r.exploration.replaced }
      : null,
  };
}

/**
 * The reconstruction's conclusion as the digest reads it (C-11): what it found,
 * never which key the time-bounded search happened to reach first or which
 * direction won this time. Those churn between identical reads, and a digest
 * that held them rewrote the plan's history every pass. They stay on the
 * reading and in the stored forecast.
 */
export function reconstructionDigest(r: Reconstruction | null): Record<string, unknown> | null {
  const full = reconstructionSummary(r);
  if (!full) return null;
  const { best, explored: _explored, variants: _variants, ...rest } = full as { best: Record<string, unknown>; explored: unknown; variants: unknown } & Record<string, unknown>;
  const { key: _key, ...kept } = best;
  return { ...rest, best: kept };
}

/** The digest of a reading's conclusion: a new row only when this changes. */
export function readingDigest(reading: PlanReading): string {
  const candidate = reading.acceptance.candidate;
  const summary = {
    verdict: reading.verdict,
    chosen: reading.chosen,
    strategies: reading.strategies.map((one) => ({ key: one.key, verdict: one.verdict, missing: one.links.filter((link) => !link.ok).map((link) => link.link), failed: one.constraintsFailed })),
    // An adopted reconstruction's first step is worded from the search's winner: only who does what kind of step is a conclusion.
    next: reading.adoption?.source === 'RECONSTRUCTED' && reading.nextTest ? { link: reading.nextTest.link, by: reading.nextTest.by } : reading.nextTest,
    refusal: reading.refusal,
    progress: planProgress(reading),
    sales: reading.sales.map((one) => one.opportunityId),
    acceptance: {
      status: reading.acceptance.status,
      basis: reading.acceptance.probability?.basis ?? null,
      // A reconstructed candidate's members are the search's output, read again by its digest below.
      candidate: candidate && candidate.source !== 'RECONSTRUCTED' ? candidate.opportunityIds : [],
    },
    adoption: reading.adoption?.source ?? null,
    reconstruction: reconstructionDigest(reading.reconstruction ?? null),
    // Whether the goal's work continues is a conclusion: a change in it is recorded as a new reading.
    ...(reading.continuation ? { continues: reading.continuation.continues } : {}),
    // The committee's verdict is a conclusion; its timing is not.
    ...(reading.committee ? { committee: reading.committee.verdict } : {}),
  };
  return sha256(canonicalJson(summary));
}

/**
 * The verdict a persisted reading may carry under the owner's acceptance rule
 * (2026-11-09, GOAL-09): RECOMMENDABLE — "meets the objective" — only with an
 * ACCEPTED acceptance. A candidate keeps its pursuit and its sale, never that
 * word. Pure.
 */
export function persistableVerdict(verdict: PlanVerdict, acceptance: Pick<PlanAcceptance, 'status'>): PlanVerdict {
  return verdict === 'RECOMMENDABLE' && acceptance.status !== 'ACCEPTED' ? 'NEEDS_EVIDENCE' : verdict;
}

/**
 * Whether a stored reading's forecast carries the acceptance record. A row the
 * Brain released before the acceptance writer wrote has none (production
 * 2026-11-10, gpr_8c679e2aefba4625a30f): it is history and is never rewritten,
 * but it must not stand as the goal's latest reading, so the next read writes
 * a stamped one even when nothing else moved. Pure.
 */
export function forecastCarriesAcceptance(forecast: string | null): boolean {
  if (!forecast) return false;
  try {
    const parsed = JSON.parse(forecast) as { acceptance?: { status?: unknown } } | null;
    return !!parsed && typeof parsed === 'object' && typeof parsed.acceptance?.status === 'string';
  } catch {
    return false;
  }
}

/**
 * An acceptance refused for the plan's integrity violations (`planIntegrity`):
 * a candidate at most, each violation a shortfall, and neither a probability
 * nor an accepted plan (`storableAcceptance`). Pure.
 */
export function refuseForIntegrity(acceptance: PlanAcceptance, violations: readonly PlanIntegrityViolation[]): PlanAcceptance {
  if (violations.length === 0 || acceptance.status !== 'ACCEPTED') return acceptance;
  const reasons = violations.map((v) => `${v.rule}: ${v.detail}`);
  const refused: PlanAcceptance = {
    ...acceptance,
    status: acceptance.candidate ? 'CANDIDATE_ONLY' : 'NO_CANDIDATE',
    probability: null,
    accepted: null,
    shortfalls: [...reasons, ...acceptance.shortfalls],
    sentence: `Not accepted: the plan breaks ${violations.length} integrity rule(s) — ${reasons.slice(0, 3).join('; ').slice(0, 400)}.`,
  };
  return { ...storableAcceptance(refused), verdict: verdictOf(refused) };
}

/**
 * An acceptance refused by the investment committee (`committee.ts`, §117): a
 * failed role, a critical defect, or — on a final plan — a role a specialist
 * has not yet settled. A candidate at most, the committee's blocker first among
 * the shortfalls, and never a probability or an accepted plan. Pure.
 */
export function refuseForCommittee(acceptance: PlanAcceptance, committee: Pick<CommitteeReading, 'blocks' | 'blocker' | 'roles' | 'verdict'>): PlanAcceptance {
  if (!committee.blocks || acceptance.status !== 'ACCEPTED') return acceptance;
  const reasons = committee.roles.flatMap((r) => [...r.defects.map((d) => `committee ${r.role}${d.critical ? ' (critical)' : ''}: ${d.claim} — ${d.why}`), ...(r.verdict === 'UNKNOWN' ? r.open.map((q) => `committee ${r.role} has not settled ${q.subject.replace(/^[A-Z_]+: /, '')}`) : [])]);
  const refused: PlanAcceptance = {
    ...acceptance,
    status: acceptance.candidate ? 'CANDIDATE_ONLY' : 'NO_CANDIDATE',
    probability: null,
    accepted: null,
    shortfalls: [...reasons, ...acceptance.shortfalls],
    sentence: `Not accepted: the investment committee ${committee.verdict === 'FAIL' ? 'failed' : 'has not settled'} the plan — ${(committee.blocker ?? reasons[0] ?? 'a role is unsettled').slice(0, 400)}.`,
  };
  return { ...storableAcceptance(refused), verdict: verdictOf(refused) };
}

/**
 * The reading with its integrity checked (`reading.integrity`). A reading
 * ACCEPTED with any violation is refused (`refuseForIntegrity`): its verdict
 * is no longer RECOMMENDABLE (RECOMMENDABLE iff ACCEPTED), its summary says
 * why, and what is read from the acceptance — the horizons, the objective, the
 * plan set and the continuation — is read again from the refused one
 * (`recompose`). Pure but for `recompose`.
 */
export function gateIntegrity(
  reading: PlanReading,
  recompose: (refused: PlanAcceptance) => Pick<PlanReading, 'timelines' | 'objective' | 'planSet' | 'continuation'>,
  committeeContext: CommitteeContext = {},
): PlanReading {
  const { violations } = planIntegrity(integrityInput(reading));
  // The investment committee (§117) reads the same reading, with the research answers to its own questions and its
  // specialists' recorded review (`committeeContextOf`); it can only take an acceptance away.
  const committee = committeeOf(reading, committeeContext);
  const committeeRefuses = reading.acceptance.status === 'ACCEPTED' && reading.acceptance.probability?.basis !== 'TARGET_MET' && committee.blocks;
  if (reading.acceptance.status !== 'ACCEPTED' || (violations.length === 0 && !committeeRefuses)) return { ...reading, integrity: violations, committee };
  const acceptance = violations.length > 0 ? refuseForIntegrity(reading.acceptance, violations) : refuseForCommittee(reading.acceptance, committee);
  const again = recompose(acceptance);
  return {
    ...reading,
    ...again,
    integrity: violations,
    committee,
    acceptance,
    verdict: reading.verdict === 'RECOMMENDABLE' ? 'NEEDS_EVIDENCE' : reading.verdict,
    // An accepted reading's summary is its acceptance's sentence: the refusal replaces it, never stands beside "Accepted".
    summary: reading.verdict === 'RECOMMENDABLE' || reading.summary === reading.acceptance.sentence ? acceptance.sentence : `${acceptance.sentence} ${reading.summary}`,
    needsMoreOpenings: again.continuation?.continues ?? reading.needsMoreOpenings,
  };
}

/**
 * The acceptance a persisted reading stores. Pure.
 *
 * A non-ACCEPTED acceptance never holds a probability or an accepted plan —
 * `judgeAcceptance` returns both null for CANDIDATE_ONLY and NO_CANDIDATE — so
 * for anything it produced this returns the acceptance unchanged, and stores
 * everything a candidate carries: its label, its opportunities, its settled P50
 * and its coverage figure, which lives in `candidate.reach` with
 * `candidate.reachBasis` saying whether it is a probability or only coverage.
 * Nothing a reader of stored readings uses is discarded (the readers —
 * `latestReading`, `listReadings`, the summary digest and the GOAL-09 probe —
 * read `status`, `probability.basis` and `candidate`).
 *
 * Only a malformed acceptance, one that pairs a candidate status with a
 * probability or an accepted plan, is changed: those two fields are the claim
 * "this meets the objective", which a candidate may never store (GOAL-09). The
 * candidate itself is kept exactly as it was.
 */
export function storableAcceptance(acceptance: PlanAcceptance): PlanAcceptance {
  if (acceptance.status === 'ACCEPTED') return acceptance;
  if (acceptance.probability === null && acceptance.accepted === null) return acceptance;
  return { ...acceptance, probability: null, accepted: null };
}

async function persistReading(goal: Workstream, reading: PlanReading, chosen: StrategyReading | null): Promise<void> {
  // A candidate is never stored as an accepted plan: the verdict follows the acceptance, and the
  // acceptance is stored whole, candidate and coverage included (`storableAcceptance`).
  if (reading.acceptance.status !== 'ACCEPTED') {
    reading = { ...reading, verdict: persistableVerdict(reading.verdict, reading.acceptance), acceptance: storableAcceptance(reading.acceptance) };
  }
  // Progress toward the goal is part of the conclusion (owner, 2026-11-05); search churn is not (C-11).
  const digest = readingDigest(reading);
  const last = await latestReading(goal.id);
  // A stored reading released before the acceptance writer has none, and must not stand as the latest (GOAL-09).
  if (last && last.digest === digest && forecastCarriesAcceptance(last.forecast)) return;
  const forecast = {
    ...(chosen ? { conservativeSettled: chosen.conservativeSettled, sweep: chosen.sweep } : {}),
    acceptance: reading.acceptance,
    remainingCents: reading.target.remainingCents,
    daysLeft: reading.target.daysLeft,
    ...planProgress(reading),
    reconstruction: reconstructionSummary(reading.reconstruction ?? null),
    // The one plan, its steps, and what limited this reading (C-6, C-8, C-10, C-13): JSON, no schema change.
    adoption: reading.adoption,
    steps: reading.steps,
    infeasible: reading.infeasible,
    degraded: reading.degraded,
    priceVariables: reading.priceVariables ?? [],
    // The investment committee (§117): each role's verdict and cited defects, on the production record.
    committee: reading.committee
      ? {
          tier: reading.committee.tier,
          verdict: reading.committee.verdict,
          blocks: reading.committee.blocks,
          blocker: reading.committee.blocker,
          criticalDefects: reading.committee.criticalDefects,
          reviewMs: reading.committee.reviewMs ?? null,
          fingerprint: reading.committee.fingerprint,
          specialists: reading.committee.specialists,
          answered: reading.committee.answered,
          roles: reading.committee.roles.map((r) => ({
            role: r.role,
            verdict: r.verdict,
            critical: r.critical,
            defects: r.defects.slice(0, 6),
            open: r.open.map((q) => q.subject).slice(0, 4),
            // Each UNKNOWN for want of evidence names the research need it waits on, and the answers read that did not settle it.
            asked: r.open.slice(0, 4).map((q) => ({ subject: q.subject, research: q.research, answeredBy: q.answeredBy ?? [] })),
            settled: (r.settled ?? []).slice(0, 4),
            specialist: r.specialist ? { verdict: r.specialist.verdict, model: r.specialist.model, reason: r.specialist.reason, defects: r.specialist.defects.slice(0, 4) } : null,
            citations: r.citations.slice(0, 6),
          })),
          investigations: reading.committee.investigations.map((i) => ({ opportunityId: i.opportunityId, fact: i.fact, established: i.established, broken: i.broken })),
        }
      : null,
    // GOAL-13-6, GOAL-18-4, GOAL-23 and the continuation rule (S-0199), compact, on the production record.
    ...readingsSummary(reading),
  };
  const readingId = newId('gpr');
  await getDb().run(
    `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      readingId,
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
  // Which constructed arrangements this model weighed, and which it picked, go on their library rows (K-3).
  await recordReadingEvaluations({
    projectId: reading.target.projectId,
    goalId: goal.id,
    readingId,
    demand: reading.portfolio?.demand ?? [],
    picked: new Set(reading.portfolio?.best?.members.map((one) => one.opportunityId) ?? []),
    prefix: ARRANGEMENT_ID_PREFIX,
  }).catch((error: unknown) => console.warn(`goal ${goal.id}: arrangement evaluations not recorded: ${errorText(error)}`));
  // A target reached or a plan accepted does not stop the goal's productive work; that it continues, and why, is recorded.
  if (reading.continuation?.continues && (reading.target.achieved || reading.acceptance.status === 'ACCEPTED')) {
    await recordWorkstreamEvent({
      workstreamId: goal.id,
      kind: 'GOAL_CONTINUES_BEYOND_TARGET',
      summary: `Work continues: ${reading.continuation.reason}.`.slice(0, 400),
      detail: { reason: reading.continuation.reason, surplusForSuccessors: reading.continuation.surplusForSuccessors, achieved: reading.target.achieved, acceptance: reading.acceptance.status },
      actorRef: 'BRAIN',
    });
  }
  // A recommended plan's opportunities become work this goal pursues, so the
  // goal tick holds and prioritizes them. Execution itself stays with the
  // existing commercial authority and its effects.
  // A qualified candidate is pursued too: it is the strongest provisional plan, sold and improved while
  // nothing is accepted (owner, 2026-11-09). Only the verdict says whether it meets the objective.
  const pursued = openingsToPursue(reading, chosen);
  if (pursued.length > 0) {
    const links = await listLinks(goal.id);
    for (const opportunityId of pursued) {
      if (links.some((one) => one.kind === 'OPPORTUNITY' && one.ref === opportunityId && one.relation === 'PURSUES')) continue;
      await linkWorkstream({ workstreamId: goal.id, kind: 'OPPORTUNITY', ref: opportunityId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
    }
  }
}

/**
 * The openings a stored reading makes this goal pursue: the accepted plan's,
 * else a complete chosen chain's. An `arr_` id is a constructed arrangement
 * — an estimate in the model, never a row — so it is recorded as an
 * evaluation on its library row and never linked as an opening (K-3).
 */
export function openingsToPursue(reading: Pick<PlanReading, 'acceptance'>, chosen: Pick<StrategyReading, 'chainComplete' | 'opportunityIds'> | null): string[] {
  const ids = reading.acceptance.accepted?.opportunityIds.length ? reading.acceptance.accepted.opportunityIds : chosen?.chainComplete ? chosen.opportunityIds : [];
  return ids.filter((one) => !isArrangementId(one));
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

/** The reading the goal tick last took for a goal, in this process, or null. */
export function heldReading(goalId: string): PlanReading | null {
  return lastReadings.get(goalId) ?? null;
}
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
 * When the goal tick last read each goal's plan, in this process, whether or
 * not the reading wrote a row. A reading whose conclusion equals the stored
 * one writes no row (`persistReading`, C-11), and the scenario run it made is
 * on a newly saved model when the model's definition moved, which no stored
 * reading references, so neither query `advanceGoalPlans` takes its `since`
 * from saw that read: production's $10K goal stored its last row at 03:47Z
 * while a fresh read at 16:29Z drew the identical conclusion, so every pass
 * after the half-hour read it again, holding the one scenario slot the
 * deploy verifier and user runs also need. Lost on restart, which costs one
 * early read, as `lastInputs` already does.
 */
const lastReadAt = new Map<string, number>();

/**
 * What a goal's plan is composed from, as one cheap reading: the project's
 * openings (a harvest creates one; validation, pricing and reconsideration
 * update one), their value layers, the money ledger and the goal's own terms.
 */
export async function planInputsFingerprint(projectId: string, goalId: string): Promise<string> {
  const row = await getDb().get<{ o: number | string; ou: string | null; oc: string | null; v: number | string; vu: string | null; m: number | string; g: string | null; f: number | string; fc: string | null; k: number | string; ku: string | null }>(
    `SELECT (SELECT COUNT(*) FROM cash_opportunities WHERE project_id = ?) AS o,
            (SELECT MAX(updated_at) FROM cash_opportunities WHERE project_id = ?) AS ou,
            (SELECT MAX(created_at) FROM cash_opportunities WHERE project_id = ?) AS oc,
            (SELECT COUNT(*) FROM cash_value_layers WHERE project_id = ?) AS v,
            (SELECT MAX(updated_at) FROM cash_value_layers WHERE project_id = ?) AS vu,
            (SELECT COUNT(*) FROM cash_money_entries WHERE project_id = ?) AS m,
            (SELECT updated_at FROM workstreams WHERE id = ?) AS g,
            (SELECT COUNT(*) FROM construction_facts WHERE source_claim_id IS NOT NULL AND (project_id = ? OR workstream_id = ?)) AS f,
            (SELECT MAX(created_at) FROM construction_facts WHERE source_claim_id IS NOT NULL AND (project_id = ? OR workstream_id = ?)) AS fc,
            (SELECT COUNT(*) FROM cash_card_facts WHERE project_id = ?) AS k,
            (SELECT MAX(updated_at) FROM cash_card_facts WHERE project_id = ?) AS ku`,
    [projectId, projectId, projectId, projectId, projectId, projectId, goalId, projectId, goalId, projectId, goalId, projectId, projectId],
  );
  return [row?.o, row?.ou, row?.oc, row?.v, row?.vu, row?.m, row?.g, row?.f, row?.fc, row?.k, row?.ku].map((one) => String(one ?? '')).join('|');
}

/**
 * The parts of `planInputsFingerprint` only arriving evidence moves: the
 * project's opening count and the newest opening's `created_at` (positions 0
 * and 2), and the count and newest `created_at` of construction facts filed
 * from research claims (positions 7 and 8). The plan pass files neither, so
 * one filed while a reading runs still reads as new on the next pass.
 *
 * Before 2026-11-17 the fingerprint saw only openings, value layers, money and
 * the goal row, so a research claim that became a construction fact or a card
 * fact — what `construct.ts` builds the plan from — never moved it, and
 * accepted research waited out the half-hour refresh (or, on a goal held
 * NOT_SUPPORTED, was never read at all): production's runpod-report on
 * 04b754ce traced 5 accepted goal claims with "no plan evaluation since".
 */
const ARRIVAL_PARTS = new Set([0, 2, 7, 8]);

/**
 * The inputs a reading was actually taken over. Pure.
 *
 * Reading a plan runs a scenario and is slow, and an opening harvested while it
 * runs is not in the model the reading used. So what a new opening moves (its
 * count and newest `created_at`) comes from `before`, taken before the read,
 * and an opening filed during the read still reads as new evidence on the next
 * pass instead of waiting out the half-hour. What the pass's own writes move
 * (the openings' and value layers' `updated_at`, the money entries, the goal
 * row) comes from `after`, taken once the pass is over, so the plan's own
 * research on its openings never causes a perpetual re-read. Duplicate or late
 * triggers stay bounded by the evidence floor and the one scenario slot.
 */
export function inputsTakenOver(before: string, after: string): string {
  const b = before.split('|');
  const a = after.split('|');
  if (b.length !== a.length) return after;
  /*
   * There is one rule for what counts as an arrival, and no exception for the
   * pass's own rounds: a round opened by `widenGoalSearch` files nothing during
   * the pass (its openings are harvested fragment by fragment once research is
   * gated, in a later tick), so every opening it finds arrives after the
   * reading and is evidence that reading never saw.
   */
  return a.map((part, i) => (ARRIVAL_PARTS.has(i) ? b[i]! : part)).join('|');
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

/**
 * Goals whose search the research allocation asked to widen because a
 * protected floor (exploration, or the urgent commercial goal's transaction
 * routes) sits below its share and no live work serves it (RES-07, review F2).
 * Raising a priority reaches only work that exists; this is how the floor
 * causes the work to exist. The next goal pass widens the goal's search once,
 * through the same openers every round uses, under their own caps and gates.
 */
const floorRequests = new Map<string, string>();

export function requestFloorResearch(goalId: string, why: string): void {
  floorRequests.set(goalId, why);
}

/** Whether a floor request is waiting for this goal's next pass, and why. */
export function floorResearchRequested(goalId: string): string | undefined {
  return floorRequests.get(goalId);
}

/** The workstream event a floor-requested widening writes on its goal. */
export const GOAL_FLOOR_RESEARCH_OPENED = 'GOAL_FLOOR_RESEARCH_OPENED';

/** Tests. */
export function forgetGoalReadings(): void {
  floorRequests.clear();
  lastArrangements.clear();
  explored.clear();
  lastReadings.clear();
  lastTopUp.clear();
  lastInputs.clear();
  lastReadAt.clear();
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
async function widenGoalSearch(goalId: string, reading: PlanReading, now: Date, spare: number): Promise<{ asked: number; constructed: number; researched: number; opened: string[] }> {
  const goal = await getWorkstream(goalId);
  if (!goal) return { asked: 0, constructed: 0, researched: 0, opened: [] };
  const opened: string[] = [];
  let asked = 0;
  const attempts = 1 + spare;
  // The lane remedies the research allocation applied to this goal (RES-15-5): how its questions are now asked.
  const remedyInstruction = remedyInstructions(await remediesInForce(goal.id));
  /*
   * New mechanisms first (§81): arrangements Brain composed itself from the
   * buyer populations, needs and supply it knows of, decomposed so the round
   * asks only for the parts nothing establishes. Then the world is asked from
   * the next lens. Both are new-opening work; the existing openings' paths are
   * researched separately below, so one never crowds the other out.
   */
  /*
   * Whole routes reasoned from the objective (PLANNING-9-10 §4.1): with no
   * accepted plan, Brain's operator model proposes concrete routes inside the
   * owner's limits and each is filed as one opening its deep dive researches
   * as a unit. In the background — the pass never waits on a model — and
   * bounded by the goal's own record (`routeProposal.ts`).
   */
  if (reading.acceptance.status !== 'ACCEPTED' && !reading.target.achieved) {
    armRouteProposal(goal.id, reading.considered.map((one) => one.title), now);
  }
  // A transaction constructed from a held opening's own evidence comes first (§93): it is the nearest to a sale.
  const fromPathways = await askPathwayConstructions(goal, reading, now, MAX_LIVE_GOAL_ROUNDS + spare);
  const constructed = [...fromPathways, ...(await askConstructedArrangements(goal, reading, now, Math.max(1, Math.ceil(attempts / 2)), MAX_LIVE_GOAL_ROUNDS + spare))];
  for (const candidateId of constructed) {
    opened.push(candidateId);
    await linkWorkstream({ workstreamId: goal.id, kind: 'CANDIDATE', ref: candidateId, relation: 'PURSUES', recordedBy: 'BRAIN', recordedByUserId: null });
  }
  for (let i = 0; i < attempts; i += 1) {
    const lens = await openGoalDiscovery({
      goal,
      target: reading.target,
      bestReach: reading.bestReach,
      heldTitles: reading.considered.map((one) => one.title),
      // The quantity shapes the search (§93): the shape of transaction the gap needs, then why research fell short.
      diagnosis: [reading.pathways?.structures.searchBrief ?? '', diagnosisInstructions(reading.researchDiagnosis), remedyInstruction].filter(Boolean).join(' '),
      now: now.toISOString(),
      liveCap: MAX_LIVE_GOAL_ROUNDS + spare,
    });
    if (!lens) break;
    asked += 1;
    opened.push(lens.candidateId);
    await linkWorkstream({
      workstreamId: goal.id,
      kind: 'CANDIDATE',
      ref: lens.candidateId,
      relation: 'PURSUES',
      recordedBy: 'BRAIN',
      recordedByUserId: null,
    });
  }
  // And dig into the openings already held: the path to their money.
  const researched = (await researchGoalPaths({ reading, projectId: reading.target.projectId, now, spare, remedyInstruction })).length;
  return { asked, constructed: constructed.length, researched, opened };
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
  const room = constructedShare(liveCap) - researching;
  if (room <= 0) {
    note(`its turn, but construction's share of the live cap is full: ${researching} constructed round(s) researching against ${constructedShare(liveCap)}`);
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
      // Which opening and field asked, so the round's answers return to its card (`applyPathwayAnswers`).
      await recordPathwayAsk({ projectId: t.projectId, opportunityId: pathway.opportunityId, field: move.field, gap: move.gap, candidateId: round.candidateId, bucketId: round.bucketId });
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
const lastArrangements = new Map<string, { at: number; composedAt: number; arrangements: ConstructedArrangement[] }>();
const ARRANGEMENTS_FRESH_MS = 10 * 60_000;

/** What construction reads for a goal: its process's proved deliverables, its limits and its owner's exclusions. */
async function constructionInputFor(goal: Workstream, target: TargetReading, now: Date, bestReachCents: number | null = null): Promise<Parameters<typeof constructArrangements>[0]> {
  const frame = await executionFrame(target.projectId, target.currency);
  const daysLeft = target.daysLeft ?? 0;
  return {
    projectId: target.projectId,
    currency: target.currency,
    delivers: frame?.delivers ?? [],
    capitalCeilingCents: target.capitalCeilingCents,
    daysLeft,
    limits: { daysLeft, remainingCents: target.remainingCents, capitalCeilingCents: target.capitalCeilingCents, capitalBeforeProofCents: target.capitalBeforeProofCents, bestReachCents },
    exclusions: await goalExclusions(goal),
    now,
    goalId: goal.id,
  };
}

/** The composer for designs the reasoning model invents on this goal (S-11): built only when the model is asked. */
function goalDesigner(goal: Workstream, target: TargetReading, now: Date): () => Promise<NonNullable<ExploreContext['design']>> {
  return async () => inventedDesigner(await constructionInputFor(goal, target, now));
}

/**
 * Whether a held construction still answers a read at `now`: composed less
 * than ten minutes ago by the wall clock, for a reading time within ten
 * minutes of the one it was composed for, in either direction. The reading
 * time alone is not an age: a plan read on the default clock and a pass that
 * carries its own slightly earlier `now` are the same pass, and refusing the
 * held construction because the caller's clock is behind it re-composed and
 * re-traced every arrangement's leverage a second time (COM-13-2 repair: the
 * plan read and the goal tick's asking each paid the full trace).
 */
export function arrangementsFresh(held: { at: number; composedAt: number }, now: Date, wallNow: number = Date.now()): boolean {
  const age = wallNow - held.composedAt;
  return age >= 0 && age < ARRANGEMENTS_FRESH_MS && Math.abs(now.getTime() - held.at) < ARRANGEMENTS_FRESH_MS;
}

/** The goal's constructed arrangements, composed at most once per ten minutes. */
export async function goalArrangements(goal: Workstream, target: TargetReading, now: Date, bestReachCents: number | null = null): Promise<ConstructedArrangement[]> {
  if (target.daysLeft === null || target.daysLeft <= 0 || target.remainingCents <= 0) return [];
  return ownerFit(goal, target, await composedGoalArrangements(goal, target, now, bestReachCents));
}

/**
 * The constructed arrangements that may stand in this owner's plan (RC13).
 *
 * The constructor reads the goal's figures and the map, never the owner's
 * words, means or place, so its designs fit any request. Production
 * 2026-11-26, dev6 (12 fresh goals): the plan for a pickup-truck owner with no
 * money near Columbus modelled "Fractional ownership of aircraft" at $30M
 * toward $2,000, while the route the proposer had read off that owner's words
 * (towing for local mechanics, $75-150 a tow) sat beside it unmodelled; the
 * same arrangement ids led goals as unlike as a photographer's and a bare
 * $12K target. Once the route proposer has filed a route for the goal, that
 * route is the owner-read search: a constructed design reaches the owner's
 * reading, its lead and its research asks only when it transfers one of the
 * goal's own routes. Nothing is discarded — the library still holds every
 * design (`rememberArrangements`), and a goal with no route yet is planned
 * over them as before.
 */
async function ownerFit(goal: Workstream, target: TargetReading, arrangements: ConstructedArrangement[]): Promise<ConstructedArrangement[]> {
  if (arrangements.length === 0) return arrangements;
  const routes = await liveOpeningsWithRecordPrefix(target.projectId, goalRoutePrefix(goal.id)).catch(() => 0);
  if (routes === 0) return arrangements;
  const own = new Set((await opportunitiesWithRecordPrefix(target.projectId, goalRoutePrefix(goal.id))).map((one) => one.id));
  return arrangements.filter((one) => one.precedent !== null && own.has(one.precedent.opportunityId));
}

async function composedGoalArrangements(goal: Workstream, target: TargetReading, now: Date, bestReachCents: number | null): Promise<ConstructedArrangement[]> {
  const held = lastArrangements.get(goal.id);
  if (held && arrangementsFresh(held, now)) return held.arrangements;
  /*
   * Only arrangements over a buyer population reach a goal (production,
   * 2026-11-19: arr_53ae6fed770b over "GitHub" led almost every plan). One
   * organisation is a payer an opening models as that one buyer, never a
   * population to list, pool and sell to again; one read back from the
   * library, composed before `namesABuyerPopulation` refused it, stops here
   * for every reader — the model, the plan's lead and its readings, the asks.
   */
  const trace = planTrace('construct');
  const constructionInput = await constructionInputFor(goal, target, now, bestReachCents);
  trace('construction input');
  const constructed = await constructArrangements(constructionInput);
  trace(`composed ${constructed.length}`);
  const arrangements = constructed.filter((one) => namesABuyerPopulation(one.demand.name));
  trace(`over a population ${arrangements.length}`);
  // One composed ten minutes ago by the wall clock is never fresh again (`arrangementsFresh`): let it go.
  for (const [id, one] of lastArrangements) if (Date.now() - one.composedAt >= ARRANGEMENTS_FRESH_MS) lastArrangements.delete(id);
  lastArrangements.set(goal.id, { at: now.getTime(), composedAt: Date.now(), arrangements });
  // The library keeps what was composed: a restart, a deploy or another goal reads it back (K-1).
  await rememberArrangements(target.projectId, goal.id, arrangements, now.toISOString()).catch((error: unknown) =>
    console.warn(`goal ${goal.id}: constructed arrangements not stored: ${errorText(error)}`),
  );
  trace('remembered');
  // Where a buyer count this plan now reads came from an acquired dataset, say so once (§122).
  await notePlanEffects(goal.id, target.projectId, arrangements, (one) => nextInputQuestion(one as ConstructedArrangement, constructionInput.currency)).catch((error: unknown) =>
    console.warn(`goal ${goal.id}: knowledge effects not recorded: ${errorText(error)}`),
  );
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

/**
 * The constructed arrangement the plan leads with, when its steps are read
 * from one (`planSteps`): a member of the candidate, else of the best
 * combination; null when that lead names members and none is an arrangement.
 * Only when the plan names no lead, the one contributing most to the last
 * model, then construction's own first-ranked. Null when nothing was
 * constructed. Pure.
 */
export function leadingArrangement(
  arrangements: readonly ConstructedArrangement[],
  reading: Pick<PlanReading, 'portfolio'> & { candidateIds?: readonly string[] },
): ConstructedArrangement | null {
  /*
   * Only an arrangement over a buyer population can lead: one named
   * organisation (an arrangement read back from the library, built before
   * `namesABuyerPopulation` refused them) is that organisation's opening, not a
   * population to list, pool and run again (transfer test, 2026-11-19: "Constructed: VA").
   */
  const leaders = arrangements.filter((a) => namesABuyerPopulation(a.demand.name));
  if (leaders.length === 0) return null;
  const byKey = new Map(leaders.map((a) => [a.key, a]));
  /*
   * The plan's lead is its candidate, else its best combination. When that
   * lead names members and none is a constructed arrangement held here, the
   * steps are not an arrangement's (production, 2026-11-19, goal wst_7b4f:
   * the plan led with cop_8015, a Pennsylvania opening, while its steps read
   * "Reach GitHub" from an arrangement that was not in the lead at all). The
   * plan's sales and next step then carry the lead.
   */
  const candidateIds = reading.candidateIds ?? [];
  const named = candidateIds.length > 0 ? [...candidateIds] : (reading.portfolio?.best?.members.map((m) => m.opportunityId) ?? []);
  for (const id of named) {
    if (!isArrangementId(id)) continue;
    const hit = byKey.get(id.slice(ARRANGEMENT_ID_PREFIX.length));
    if (hit) return hit;
  }
  if (named.length > 0) return null;
  let best: ConstructedArrangement | null = null;
  let score = 0;
  for (const [key, value] of arrangementContribution(reading)) {
    const hit = byKey.get(key);
    if (hit && value > score) {
      best = hit;
      score = value;
    }
  }
  return best ?? leaders[0]!;
}

/**
 * The leg the plan's steps are written for, in words: the leading
 * arrangement's buyers when its steps are an arrangement's, else the titles
 * of the openings the steps act on; null when no step names one (§77).
 * Production goal wst_7b4fcbb5f2384f31b6c3, 2026-11-24: the header named a
 * hypothetical reconstruction's leg ("counts money from Constructed: Small
 * and mid-size firms…") while every step was written for "domain buyer or
 * seller", and nothing said which leg the steps were. Pure.
 */
export function stepsLegOf(steps: readonly Pick<PlanStep, 'arrangement' | 'openings'>[], lead: { key: string; demand: { name: string } } | null, titles: ReadonlyMap<string, string> = new Map()): string | null {
  const keys = new Set(steps.flatMap((s) => (s.arrangement ? [s.arrangement.key] : [])));
  if (lead && keys.has(lead.key)) return `"${lead.demand.name.slice(0, 90)}"`;
  const ids = [...new Set(steps.flatMap((s) => s.openings ?? []))];
  const named = ids.map((id) => titles.get(id) ?? titles.get(openingOfMember(id))).filter((t): t is string => !!t);
  return named.length > 0 ? named.slice(0, 3).map((t) => `"${t.slice(0, 70)}"`).join(', ') : null;
}

/**
 * The constructed arrangements a plan may lead with: those inside the goal's
 * own scope, as the model read it (`arrangementsInScope`). Transfer test,
 * 2026-11-19: a goal naming one industry ("developer tools") whose every
 * arrangement was out of scope named no lead, and `leadingArrangement` fell
 * back to construction's first rank — so its steps read "Reach Dental
 * practices". All of them when the model did not read a scope. Pure.
 */
export function inGoalScope(arrangements: readonly ConstructedArrangement[], model: { arrangementsInScope?: readonly string[] }): ConstructedArrangement[] {
  if (!model.arrangementsInScope) return [...arrangements];
  const keys = new Set(model.arrangementsInScope);
  return arrangements.filter((one) => keys.has(one.key));
}

/**
 * The populations a reading could not price, as the goal tick sends them: the
 * leading arrangement's population first, so the plan's own lead is the first
 * price question asked (`PRICE_ASKS_PER_READ` per read), then the rest, most
 * designs first. Production, 2026-11-19: a goal with no portfolio carried its
 * unpriced populations only on the portfolio it did not have, so no price
 * research ever launched for the population its plan led with. Pure.
 */
export function unpricedForPlan(
  unpriced: readonly UnpricedPopulation[] | null | undefined,
  lead: Pick<ConstructedArrangement, 'demand'> | null,
): { unpriced?: UnpricedPopulation[] } {
  if (!unpriced || unpriced.length === 0) return {};
  const first = lead ? unpriced.filter((one) => one.population === lead.demand.ref) : [];
  return { unpriced: [...first, ...unpriced.filter((one) => !first.includes(one))] };
}

/**
 * Why the leading arrangement's steps are research rather than an estimated
 * plan, or null when the plan holds an estimate of it. When nothing was
 * estimated, `leadingArrangement` falls back to construction's own first
 * rank, which no figure in the plan reads from. Pure.
 */
export function unestimatedLead(lead: Pick<ConstructedArrangement, 'key'>, constructed: number, models: ReadonlyMap<string, unknown>): string | null {
  if (models.has(lead.key)) return null;
  return models.size === 0
    ? `Not an estimated plan: none of the ${constructed} constructed arrangement(s) could be estimated (nothing prices what their buyers pay), so this is construction's highest-ranked one and these steps are the research that would make it estimable.`
    : 'Not an estimated plan: this arrangement holds no estimate, so these steps are the research that would make it estimable.';
}

/** The measured outreach reply interval the portfolio was read with, or null when nothing is measured. */
export function measuredReplyOf(portfolio: Pick<GoalPortfolio, 'measuredRates'> | null | undefined): MeasuredReply | null {
  const m = portfolio?.measuredRates;
  return m && m.sent > 0 ? { sent: m.sent, low: m.low, high: m.high } : null;
}

/** What the goal allows to be spent, major units, as the steps report it: the ceiling, else the before-proof limit. */
export function capitalOf(target: Pick<TargetReading, 'currency' | 'capitalBeforeProofCents' | 'capitalCeilingCents'>): { allowed: number | null; currency: string } {
  const cents = target.capitalCeilingCents ?? target.capitalBeforeProofCents;
  return { allowed: cents === null ? null : cents / 100, currency: target.currency };
}

/** The goal's limits as an arrangement's steps read them. */
export function arrangementStepContext(
  target: Pick<TargetReading, 'currency' | 'daysLeft' | 'capitalBeforeProofCents' | 'capitalCeilingCents'>,
  modelled: ModelledOpportunity | null,
  lead?: { key: string; portfolio: Pick<GoalPortfolio, 'demand'> | null } | null,
): Omit<ArrangementStepContext, 'send' | 'collect'> {
  const before = target.capitalBeforeProofCents ?? target.capitalCeilingCents;
  // The days to usable cash the plan's simulation drew for this arrangement: what its reach was scored on.
  const simulated = lead ? (lead.portfolio?.demand ?? []).find((d) => d.opportunityId === `${ARRANGEMENT_ID_PREFIX}${lead.key}`)?.days ?? null : null;
  return { currency: target.currency, daysLeft: target.daysLeft, capitalBeforeProof: before === null ? null : before / 100, modelled, simulatedDays: simulated };
}

/** At most this many askings of one arrangement in all, counting the first, when it is re-asked for its price. */
export const PRICE_REASK_ASKINGS = 3;

/** Whether an arrangement's price is unknown while research has established its cost. Pure. */
export function awaitsPriceWithKnownCost(one: Pick<ConstructedArrangement, 'value' | 'fixedCost'>): boolean {
  return one.value.tier === 'UNKNOWN' && !!one.fixedCost && one.fixedCost.observations > 0;
}

/**
 * The question a later price re-ask puts (§15: asked a different way, not
 * repeated). The first re-ask is P2's one-input question, a published price
 * per slot (`nextInputQuestion`); when that too found nothing, the price is
 * reconstructed from what buyers pay alone and what comparable shared offers
 * charge each participant. Pure.
 */
export function priceReaskQuestion(one: Pick<ConstructedArrangement, 'label' | 'demand' | 'fixedCost'>, currency: string): string {
  const cost = one.fixedCost ? ` Research has already established the cost of one shared run (about ${currency} ${Math.round(one.fixedCost.p50).toLocaleString('en-US')}, from ${one.fixedCost.observations} source(s)); that is not what is asked.` : '';
  return (
    `Brain holds an arrangement whose price is the one missing number: ${one.label}.${cost} ` +
    `Earlier rounds found no published price per slot, so reconstruct what one participant (one slot buyer) pays per slot a different way: find what buyers described as "${one.demand.name}" pay, in ${currency}, to buy the same deliverable alone (a single-buyer price per unit), and published co-op, shared-mailer or shared-run offers in any market with their price per participant and the number of participants per run — each with its page and date, one price per claim — so the per-slot price can be derived. ` +
    'Where neither is published, say so plainly.'
  );
}

export async function askConstructedArrangements(goal: Workstream, reading: PlanReading, now: Date, max: number, liveCap: number): Promise<string[]> {
  const t = reading.target;
  if (t.daysLeft === null || t.daysLeft <= 0 || t.remainingCents <= 0) return [];
  let arrangements = (await goalArrangements(goal, t, now, goalLimits(reading).bestReachCents))
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
   * lenses would never run, so construction holds at most half of it — and
   * that half is reserved: lens rounds cannot take it (`constructedShare`).
   */
  const researching = await roundsStillResearching(openMx);
  let room = constructedShare(liveCap) - researching;
  /*
   * A full share may still take a price re-ask (below) when what fills it is
   * rounds that never launched (`staleUnlaunchedRounds`): only that ask, and
   * only into the slots they hold.
   */
  const priceOnly = room <= 0;
  if (priceOnly) room = constructedShare(liveCap) - (researching - (await staleUnlaunchedRounds(openMx, now.toISOString())));
  if (room <= 0) return [];
  max = Math.min(max, room);
  // Every goal's askings about an arrangement count (K-5): the same structure asked by another goal is not new.
  const askedBefore = (await listRounds(t.projectId)).filter((r) => arrangementKeyOfBucket(r.bucketId) !== null);
  // Research already refuted these, under the inputs they still have (K-4): not asked again until a part changes.
  const library = await arrangementVerdicts(t.projectId);
  arrangements = arrangements.filter((one) => !refutedUnderSameInputs(one.signature ? library.get(one.signature) : undefined, one));
  // What each would contribute to the whole goal in the last model leads; the least-asked order breaks ties.
  const contribution = arrangementContribution(reading);
  const byContribution = [...byLeastAsked(arrangements, askedBefore)]
    .map((one, at) => ({ one, at }))
    .sort((a, b) => (contribution.get(b.one.key) ?? -1) - (contribution.get(a.one.key) ?? -1) || a.at - b.at)
    .map(({ one }) => one);
  /*
   * An arrangement whose cost research has established but whose price nobody
   * has is one answer from entering the plan's economics (production,
   * 2026-11-18: 2821cce3c372 carried the observed $4,675 run cost and stayed
   * out of every reading, its one round barren and its backoff two days
   * long). It is asked first, for the price by name, a bounded number of times.
   */
  const priceFirst = arrangements.filter(awaitsPriceWithKnownCost);
  const order = priceOnly ? priceFirst : [
    ...priceFirst,
    ...constructedOrder(byContribution, openMx.map((r) => r.bucketId.slice(r.bucketId.lastIndexOf('-mx-') + 4))).filter((one) => !priceFirst.includes(one)),
  ];
  const exclusions = await goalExclusions(goal);
  const thisPass = new Set<string>();
  for (const one of order) {
    if (opened.length >= max) break;
    // One buyer population per pass: a population that opened a round this pass waits for the next.
    if (thisPass.has(one.demand.ref)) continue;
    const priced = awaitsPriceWithKnownCost(one);
    const prior = priced ? askedBefore.filter((r) => arrangementKeyOfBucket(r.bucketId) === one.key).length : 0;
    // The one plan input that holds this arrangement back, asked alone in its filer's unit (P2); the full question once none does.
    // A price asked that way and still missing is asked once more, reconstructed rather than repeated (§15).
    const question = priced && prior >= 2 ? priceReaskQuestion(one, t.currency) : (nextInputQuestion(one, t.currency, exclusions)?.question ?? one.question);
    const round = await openConstructedRound({
      goal, projectId: t.projectId, key: one.key, title: `Constructed: ${one.label}`, question, now: now.toISOString(), liveCap,
      ...(priced ? { priceReaskUpTo: PRICE_REASK_ASKINGS } : {}),
    });
    // Null is this arrangement's cool-off, the live cap or a closed gate: the next one is tried.
    if (round) {
      opened.push(round.candidateId);
      thisPass.add(one.demand.ref);
    }
  }
  return opened;
}

async function recordFloorWidening(goalId: string, why: string, more: { asked: number; constructed: number; researched: number }): Promise<void> {
  await recordWorkstreamEvent({
    workstreamId: goalId,
    kind: GOAL_FLOOR_RESEARCH_OPENED,
    summary: `Search widened because ${why}: ${more.asked} round(s) asked, ${more.constructed} constructed, ${more.researched} opening(s) researched.`.slice(0, 400),
    detail: { why, ...more },
    actorRef: 'BRAIN',
  });
}

export async function advanceGoalPlans(
  now: Date = new Date(),
  /**
   * `maxReads`: read at most this many plans in this pass, and start no search
   * top-ups once it is reached. The Russell loop passes 1 under database
   * pressure, so planning keeps progressing one goal at a time instead of being
   * shed (pressure.ts, `throttleUnderPressure`). Outcomes are still recorded.
   */
  options: { maxReads?: number } = {},
): Promise<{ read: number; outcomes: number; asked: number; constructed: number; researched: number; busy: boolean; onEvidence: number; resumed: number }> {
  /*
   * Least recently read first, and a goal never read before all of them.
   *
   * Production, 2026-11-25: with ~60 live goals each read took 20-60 s, so one
   * pass read about forty in table order before its 30-minute bound (and every
   * deploy's restart) ended it — and the next pass began again at the top of
   * the table. The twelve goals created at 19:29Z sat at its end and had no
   * plan read and no route ask (armed in this same loop) 75 minutes later;
   * under SHEDDING a pass reads one goal and the first due one always won.
   * Ordering by the last reading makes a pass that is cut short leave the
   * goals it just read, never the ones it has not.
   */
  const goals = await getDb().all<{ id: string; target_project_id: string | null; paused_at: string | null; due_at: string | null; execution_window_days: number | null; execution_started_at: string | null; last_read_at: string }>(
    `SELECT w.id, w.target_project_id, w.paused_at, w.due_at, w.execution_window_days, w.execution_started_at,
            COALESCE((SELECT MAX(g.created_at) FROM goal_plan_readings g WHERE g.workstream_id = w.id), '') AS last_read_at
       FROM workstreams w
      WHERE w.target_metric IS NOT NULL AND w.archived_at IS NULL AND w.cancelled_at IS NULL
      ORDER BY last_read_at, w.created_at, w.id`,
  );
  let read = 0;
  let outcomes = 0;
  let asked = 0;
  let constructed = 0;
  let researched = 0;
  let busy = false;
  let onEvidence = 0;
  let resumed = 0;
  for (const row of goals) {
    const { id, target_project_id: projectId, paused_at: pausedAt } = row;
    // Before commercial execution starts the deadline is a full window away, never past (§119).
    const dueAt = effectiveDueAtOfRow(row, now);
    if (await recordGoalOutcome(id, now)) {
      outcomes += 1;
      // A new outcome invalidates the held reading: the next read decides by the continuation rule whether the
      // search continues — a missed goal stops (C-10); an achieved one with its window open keeps working (S-0199).
      lastReadings.delete(id);
    }
    // A paused goal keeps its outcome on the record and spends nothing: no
    // re-read, no search round, no construction (an operator PAUSE must stop
    // the planning and discovery spend, not only the queue's priority).
    if (pausedAt) continue;
    /*
     * A goal with no route and a last route ask that yielded none is asked
     * again on any pass, whatever this pass reads or widens. The ask was armed
     * only from `widenGoalSearch`, which runs only after a read that wants more
     * openings or a top-up with spare surfaces and a reading held in this
     * process — so after a restart, under a read cap or while the scenario slot
     * was busy, nothing armed it. Production, 2026-11-25: a goal whose ask
     * failed at 04:07 had none recorded by 06:50, 40 minutes after a deploy.
     * In the background and bounded by the goal's own record (`routeAskDue`).
     */
    {
      const heldNow = lastReadings.get(id);
      if (heldNow?.acceptance.status !== 'ACCEPTED' && !heldNow?.target.achieved) {
        armRouteProposal(id, heldNow?.considered.map((one) => one.title) ?? [], now, {}, { retryOnly: true });
      }
    }
    if (options.maxReads !== undefined && read >= options.maxReads) continue;
    const last = await getDb().get<{ at: string | null }>(
      `SELECT MAX(created_at) AS at FROM goal_plan_readings WHERE workstream_id = ?`,
      [id],
    );
    const lastRun = await getDb().get<{ at: string | null }>(
      `SELECT MAX(r.started_at) AS at FROM scenario_runs r JOIN goal_plan_readings g ON g.scenario_model_id = r.model_id WHERE g.workstream_id = ?`,
      [id],
    );
    const since = Math.max(
      [last?.at, lastRun?.at].filter((one): one is string => !!one).reduce((max, at) => Math.max(max, Date.parse(at)), 0),
      lastReadAt.get(id) ?? 0,
    );
    const fingerprint = async (): Promise<string | null> => (projectId ? planInputsFingerprint(projectId, id) : null);
    const inputs = since && now.getTime() - since >= PLAN_EVIDENCE_FLOOR_MS && now.getTime() - since < PLAN_REFRESH_MS ? await fingerprint() : null;
    const repaired = repairedGoals.get(id);
    const floor = floorRequests.get(id);
    let due = busy
      ? null
      : repaired !== undefined
        ? 'REPAIRED'
        : (planDue({ now: now.getTime(), since, inputs, lastInputs: lastInputs.get(id) }) ?? (floor !== undefined && !lastReadings.has(id) ? 'FLOOR' : null));
    // A goal arithmetic rules out (C-10) is not re-read on the clock alone: only a change to its terms or inputs can change that.
    const held = lastReadings.get(id);
    if (due === 'REFRESH' && held?.acceptance.status === 'NOT_SUPPORTED' && projectId && (await fingerprint()) === lastInputs.get(id)) due = null;
    if (!due) {
      // A protected research floor nothing serves: widen once from the reading held, whatever the top-up cadence says.
      if (floor !== undefined && held) {
        floorRequests.delete(id);
        const more = await widenGoalSearch(id, held, now, Math.max(0, await cashSpareSurfaces(held.target.projectId)));
        asked += more.asked;
        constructed += more.constructed;
        researched += more.researched;
        await recordFloorWidening(id, floor, more);
        continue;
      }
      // Not due for a re-read; top the search up if the fleet has room for it — never past the deadline (C-10).
      const toppedUp = lastTopUp.get(id) ?? 0;
      const pastDue = dueAt !== null && Date.parse(dueAt) <= now.getTime();
      if (held?.needsMoreOpenings && !pastDue && now.getTime() - toppedUp >= GOAL_TOP_UP_MS) {
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
    // What a new opening moves, as it stood when this read began (`inputsTakenOver`).
    const before = inputs ?? (await fingerprint());
    let reading: PlanReading | null;
    try {
      reading = await readGoalPlan({ goalId: id, now, persist: true });
      read += 1;
      lastReadAt.set(id, now.getTime());
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
    // An accepted plan that Hermes has challenged and adopted is told to the owner now (planReady.ts).
    if (reading?.acceptance.status === 'ACCEPTED') {
      const { notifyPlanReady } = await import('./planReady.ts');
      await notifyPlanReady(id, reading).catch((error: unknown) => console.warn(`plan-ready notice: ${String((error as Error)?.message ?? error)}`));
    }
    // What the portfolio could not establish is sent, not only listed (review F2-2):
    // decision unknowns to research or an authorized action, missing history to research.
    // Keyed per goal, opening and unknown, so a re-read raises nothing new.
    // Reaching the target does not end this: the threshold is a minimum, and the continuation rule decides (S-0199).
    // A goal with no portfolio still sends its unpriced populations' price questions (production, 2026-11-19).
    if (reading?.needsMoreOpenings && (reading.portfolio || reading.unpriced?.length)) {
      try {
        await sendPortfolioNeeds({ goalId: id, projectId: reading.target.projectId, portfolio: reading.portfolio, unpriced: reading.unpriced ?? null });
      } catch (error) {
        console.warn(`goal ${id}: sending the portfolio's needs failed: ${String((error as Error)?.message ?? error)}`);
        await recordDegraded(id, reading.target.projectId, [`portfolio needs: ${errorText(error)}`]);
      }
    }
    // The adopted plan's own questions (C-9): the conditions it needs and rests on, keyed per goal and condition.
    if (reading?.needsMoreOpenings && reading.researchPriority.length > 0) {
      try {
        await sendPlanQuestions({ goalId: id, projectId: reading.target.projectId, priority: reading.researchPriority });
      } catch (error) {
        await recordDegraded(id, reading.target.projectId, [`plan questions: ${errorText(error)}`]);
      }
    }
    // The investment committee's disputes and, on a final plan, its specialist questions (§117), keyed per goal and subject.
    if (reading?.committee) {
      try {
        await sendCommitteeNeeds({ goalId: id, projectId: reading.target.projectId, committee: reading.committee });
      } catch (error) {
        await recordDegraded(id, reading.target.projectId, [`committee questions: ${errorText(error)}`]);
      }
    }
    // What Brain holds cannot reach the goal however it is combined: look for
    // more, through the same discovery every bucket uses, instead of reading
    // the same openings again in thirty minutes.
    if (reading && (reading.needsMoreOpenings || floor !== undefined)) {
      const spare = await cashSpareSurfaces(reading.target.projectId);
      const more = await widenGoalSearch(id, reading, now, Math.max(0, spare));
      asked += more.asked;
      constructed += more.constructed;
      researched += more.researched;
      if (floor !== undefined) {
        floorRequests.delete(id);
        await recordFloorWidening(id, floor, more);
      }
    }
    // Taken after this pass's own writes (the research it started on openings
    // touches their rows), so only what arrives from elsewhere reads as new —
    // and an opening filed while the plan was being read is not folded in
    // (`inputsTakenOver`): the reading never saw it, so the next pass reads it.
    const after = await fingerprint();
    if (after !== null) lastInputs.set(id, before !== null ? inputsTakenOver(before, after) : after);
  }
  return { read, outcomes, asked, constructed, researched, busy, onEvidence, resumed };
}
