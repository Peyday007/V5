/**
 * What a complete system needs, compared with what Brain demonstrably has (§88).
 *
 * Owner's order, 2026-11-04: stop discovering predictable missing capabilities
 * one production failure at a time. Before this, Brain's knowledge of itself
 * was in three places that never met: the self-model (`selfmodel/`) knew which
 * components exist and run; the improvement loop (§87) knew which failure
 * classes recur; and nothing at all said what a *complete* research system has
 * to be able to do. So a capability nobody had built — finding a page that
 * exists — showed up only as its symptom (404s, then "no readable source",
 * then a free-lane pass rate of one in ten) and was fixed route by route.
 *
 * A map is a list of requirements a working system must meet, stage by stage,
 * each with the reading that proves it in production. Nothing in a map is a
 * claim about Brain; the assessment is. Four answers, and no fifth:
 *
 *   MISSING   no implementation exists (its owning module is not in the image)
 *   UNPROVEN  it exists, and production has not exercised it enough to say
 *   BROKEN    production exercised it and it fails more often than it may
 *   WORKING   production exercised it and it meets its bar
 *
 * Existing code is never WORKING by existing — invariant 45 and §37: a
 * definition is not an implementation, and an implementation is not a result.
 *
 * Everything here is pure. `services/capability/assess.ts` reads the probes;
 * the improvement loop turns a BROKEN or MISSING requirement that names an
 * owner into a candidate, so a gap goes through the same research → Factory →
 * measurement path as any detected weakness and is not a second mechanism.
 */

export const CAPABILITY_STATUSES = ['WORKING', 'BROKEN', 'MISSING', 'UNPROVEN'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const RESEARCH_STAGES = [
  'INTAKE',
  'DISCOVERY',
  'ACCESS',
  'EXTRACTION',
  'VERIFICATION',
  'ANALYSIS',
  'DECISION',
  'DELIVERY',
  'RECOVERY',
  'LEARNING',
] as const;
export type ResearchStage = (typeof RESEARCH_STAGES)[number];

/**
 * The stages of a cash goal's planning chain: goal received → openings found
 * and constructed → research establishing buyer, price and demand → the quant
 * engine → the plan, on the compute and database it all runs on.
 */
export const GOAL_STAGES = ['GOAL', 'OPENINGS', 'CONSTRUCTION', 'EVIDENCE', 'QUANT', 'PLAN', 'COMPUTE'] as const;
export type GoalStage = (typeof GOAL_STAGES)[number];
export type CapabilityStage = ResearchStage | GoalStage;
const STAGE_ORDER: readonly CapabilityStage[] = [...RESEARCH_STAGES, ...GOAL_STAGES];

/** A probe the assessor knows how to read. Each is one SQL reading over a window. */
export const PROBES = [
  'PLAN_APPROVED',
  'DISCOVERY_SEARCHED',
  'DISCOVERY_READABLE',
  'ACCESS_READ',
  'ACCESS_ROUTINE_FETCH',
  'CLAIMS_SURVIVE_CITATION',
  'CLAIMS_ACCEPTED',
  'REJECTIONS_EXPLAINED',
  'GATE_VERDICTS',
  'VERIFY_ITEMS',
  'SYNTHESIS_ITEMS',
  'AUDIT_ITEMS',
  'PACKETS_FILED',
  'JOBS_SUCCEED',
  'PARKS_DECIDED_BY_BRAIN',
  'MISSIONS_WRITTEN_BACK',
  'AUTO_RECOVERY',
  'LEASES_RECLAIMED',
  'PROVIDERS_ANSWER',
  'PACKETS_MOVING',
  'WORK_CLAIMED_PROMPTLY',
  'WEAKNESSES_TRACKED',
  'IMPROVEMENTS_DELIVERED',
  'METHOD_POOL',
  // The goal-plan map (GOAL_PLAN_MAP).
  'GOAL_PLAN_EVALUATED',
  'GOAL_PLAN_FRESH',
  'GOAL_SEARCH_WIDENS',
  'GOAL_ROUNDS_FILE',
  'CONSTRUCTED_ROUNDS_FILE',
  'GOAL_PACKETS_COMPLETE',
  'PATH_QUESTIONS_ANSWERED',
  'OPENINGS_BUYER_PRICE',
  'OPENINGS_MODELLED',
  'OPENINGS_REACH_PLAN',
  'GPU_SERVES',
  'FREE_MODELS_SERVE',
  'DATABASE_AVAILABLE',
] as const;
export type Probe = (typeof PROBES)[number];

/** A probe's reading: successes out of attempts, and what it counted. */
export interface ProbeReading {
  ok: number;
  total: number;
  /** What was counted, in words, with the window. Never a payload or a credential. */
  detail: string;
}

/** How to judge one requirement from its probe. */
export interface Proof {
  probe: Probe;
  /** What a reading proves, in words a person can check. */
  what: string;
  /** Below this many attempts the answer is UNPROVEN. */
  minSample: number;
  /** At or above this share of successes it is WORKING; below, BROKEN. */
  workingAt: number;
}

/** When a gap may become an improvement candidate (§87): the loop's existing contract. */
export interface ImprovementRoute {
  /** The scoreboard metric the fix moves (`domain/improvement.ts` METRICS). */
  metric:
    | 'FREE_LANE_PASS_RATE'
    | 'FREE_LANE_FRAGMENT_PASS_RATE'
    | 'ACCEPTED_CLAIM_RATE'
    | 'RESEARCH_JOB_SUCCESS_RATE'
    | 'OWNER_INTERVENTIONS_PER_DAY'
    | 'AUTO_RECOVERY_RATE'
    | 'CONSTRUCTED_ROUND_YIELD';
  /** Files a fix may touch. */
  mutationScope: string[];
  /**
   * Weakness families the loop's own detectors already raise for this gap. A
   * gap they cover is always theirs — with their thresholds and their recency
   * test — and the map never opens a second candidate for it. The map routes
   * only the gaps no detector can see.
   */
  coveredBy: string[];
}

export interface CapabilityRequirement {
  id: string;
  stage: CapabilityStage;
  ability: string;
  /** Requirement ids this one cannot work without. */
  dependsOn: string[];
  inputs: string[];
  outputs: string[];
  failureConditions: string[];
  /** The existing owner. The first path must exist in the image or the requirement is MISSING. */
  owner: string[];
  proof: Proof;
  improvement?: ImprovementRoute;
  /** A limit outside Brain's control, stated so a gap here is not engineered as if it were Brain's. */
  externalLimit?: string;
}

export interface CapabilityMap {
  key: string;
  objective: string;
  requirements: CapabilityRequirement[];
}

const R = (r: CapabilityRequirement): CapabilityRequirement => r;

/**
 * The research process, end to end. Each requirement is a thing the process
 * must be able to do for its objective — a decision-grade, sourced answer
 * delivered to whatever consumes it, without the owner — and the reading that
 * shows it does.
 */
export const RESEARCH_MAP: CapabilityMap = {
  key: 'RESEARCH',
  objective:
    'Turn a question a decision depends on into a sourced, verified, audited answer that reaches the work consuming it, ' +
    'recovering from every predictable failure and learning from each, without asking the owner.',
  requirements: [
    R({
      id: 'INTAKE.PLAN',
      stage: 'INTAKE',
      ability: 'Decompose an assignment into bounded fragments and approve the plan within standing authority',
      dependsOn: [],
      inputs: ['research goal or mission', 'standing grant / approval envelope'],
      outputs: ['research_orchestrations', 'research_fragments past PLANNED'],
      failureConditions: ['plan outside the envelope', 'budget exhausted', 'archive already answers (cancelled, correct)'],
      owner: ['server/services/research/packetRunner.ts', 'server/services/research/startPacket.ts'],
      proof: { probe: 'PLAN_APPROVED', what: 'packets created in the window whose fragments left PLANNED', minSample: 5, workingAt: 0.6 },
    }),
    R({
      id: 'DISCOVERY.SEARCH',
      stage: 'DISCOVERY',
      ability: 'Find candidate pages that exist for a question (a real search, not remembered URLs)',
      dependsOn: ['INTAKE.PLAN'],
      inputs: ['fragment question and scope'],
      outputs: ['candidate URLs from a search engine'],
      failureConditions: ['search endpoint refuses or throttles', 'no results', 'only remembered deep links (404)'],
      owner: ['server/services/sources/discover.ts', 'server/services/freeLane/worker.ts'],
      proof: { probe: 'DISCOVERY_SEARCHED', what: 'free-lane fragments whose candidates included search results', minSample: 10, workingAt: 0.7 },
      improvement: {
        metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
        mutationScope: ['server/services/sources/discover.ts', 'server/services/freeLane/worker.ts', 'tests/sourceDiscovery*.test.ts', 'tests/freeLane*.test.ts'],
        coveredBy: ['FREE_LANE:NO_READABLE_SOURCE'],
      },
    }),
    R({
      id: 'DISCOVERY.READABLE',
      stage: 'DISCOVERY',
      ability: 'End discovery with at least one readable source for the fragment',
      dependsOn: ['DISCOVERY.SEARCH', 'ACCESS.READ'],
      inputs: ['candidate URLs'],
      outputs: ['readable source text per fragment'],
      failureConditions: ['every candidate 404/blocked/empty'],
      owner: ['server/services/freeLane/worker.ts'],
      proof: { probe: 'DISCOVERY_READABLE', what: 'free-lane fragments (provider failures excluded) that read at least one source', minSample: 10, workingAt: 0.6 },
      improvement: {
        metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
        mutationScope: ['server/services/freeLane/worker.ts', 'server/services/sources/**', 'tests/freeLane*.test.ts', 'tests/source*.test.ts'],
        coveredBy: ['FREE_LANE:NO_READABLE_SOURCE'],
      },
    }),
    R({
      id: 'ACCESS.READ',
      stage: 'ACCESS',
      ability: 'Read a public page by every legitimate route (direct, connector, browser, sitemap, archive, site search)',
      dependsOn: [],
      inputs: ['URL'],
      outputs: ['SourceFetch text, cited at the address actually read'],
      failureConditions: ['404 invented link', 'bot challenge', 'login wall', 'non-public address', 'oversized PDF'],
      owner: ['server/services/sources/access.ts'],
      proof: { probe: 'ACCESS_READ', what: 'SOURCE_ACCESS reads that returned a readable page', minSample: 20, workingAt: 0.5 },
      externalLimit: 'Sites that serve bot challenges to every reader (Cloudflare/PerimeterX) and pages that never existed.',
    }),
    R({
      id: 'ACCESS.ROUTINE_FETCH',
      stage: 'ACCESS',
      ability: 'Open a source for a remote worker whose own network cannot (brain_fetch_source)',
      dependsOn: ['ACCESS.READ'],
      inputs: ['URL under a lease'],
      outputs: ['page text to the worker'],
      failureConditions: ['as ACCESS.READ'],
      owner: ['server/mcp/sourceTools.ts'],
      proof: { probe: 'ACCESS_ROUTINE_FETCH', what: 'brain_fetch_source reads that returned a readable page', minSample: 10, workingAt: 0.5 },
    }),
    R({
      id: 'EXTRACTION.CITED_CLAIMS',
      stage: 'EXTRACTION',
      ability: 'Turn a read page into claims cited to verbatim sentences that survive Brain’s own citation checks',
      dependsOn: ['DISCOVERY.READABLE'],
      inputs: ['numbered sentences of read sources'],
      outputs: ['research_claims with excerpts copied by Brain'],
      failureConditions: ['citation out of range', 'unknown evidence lane', 'submission refused'],
      owner: ['server/services/freeLane/worker.ts', 'server/mcp/researchTools.ts'],
      proof: { probe: 'CLAIMS_SURVIVE_CITATION', what: 'free-lane fragments with a readable source that submitted claims', minSample: 10, workingAt: 0.6 },
      improvement: {
        metric: 'FREE_LANE_FRAGMENT_PASS_RATE',
        mutationScope: ['server/services/freeLane/worker.ts', 'tests/freeLane*.test.ts'],
        coveredBy: ['FREE_LANE:CITATION_DROPPED', 'FREE_LANE:SUBMISSION_REFUSED'],
      },
    }),
    R({
      id: 'EXTRACTION.ACCEPTED',
      stage: 'EXTRACTION',
      ability: 'Submit claims the evidence gate accepts',
      dependsOn: ['EXTRACTION.CITED_CLAIMS'],
      inputs: ['claims'],
      outputs: ['research_claims.accepted = 1'],
      failureConditions: ['scope mismatch', 'quote not in source', 'unstated inference'],
      owner: ['server/services/research/gate.ts'],
      proof: { probe: 'CLAIMS_ACCEPTED', what: 'claims the gate accepted', minSample: 30, workingAt: 0.5 },
      improvement: { metric: 'ACCEPTED_CLAIM_RATE', mutationScope: ['server/services/research/prompts.ts', 'server/services/freeLane/worker.ts', 'tests/research*.test.ts'], coveredBy: ['CLAIMS:'] },
    }),
    R({
      id: 'VERIFICATION.REASONS',
      stage: 'VERIFICATION',
      ability: 'Record why every rejected claim was rejected, so the rejection can be learned from',
      dependsOn: ['EXTRACTION.ACCEPTED'],
      inputs: ['gate verdicts'],
      outputs: ['research_claims.rejection_reason'],
      failureConditions: ['a rejection with no reason'],
      owner: ['server/services/research/gate.ts', 'server/services/research/submission.ts'],
      proof: { probe: 'REJECTIONS_EXPLAINED', what: 'rejected claims that carry a rejection reason', minSample: 20, workingAt: 0.9 },
      improvement: { metric: 'ACCEPTED_CLAIM_RATE', mutationScope: ['server/services/research/gate.ts', 'server/services/research/submission.ts', 'tests/research*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'VERIFICATION.GATE',
      stage: 'VERIFICATION',
      ability: 'Reach a gate verdict (accepted or blocked with a cause) on every submitted fragment',
      dependsOn: ['EXTRACTION.ACCEPTED'],
      inputs: ['claims', 'verification'],
      outputs: ['research_fragments ACCEPTED / BLOCKED'],
      failureConditions: ['verification lost', 'verifier insufficient'],
      owner: ['server/services/research/gate.ts'],
      proof: { probe: 'GATE_VERDICTS', what: 'fragments settled ACCEPTED of those settled ACCEPTED or BLOCKED', minSample: 10, workingAt: 0.4 },
    }),
    R({
      id: 'VERIFICATION.ITEMS',
      stage: 'VERIFICATION',
      ability: 'Complete verification work items',
      dependsOn: ['EXTRACTION.CITED_CLAIMS'],
      inputs: ['RESEARCH_VERIFY items'],
      outputs: ['verifications'],
      failureConditions: ['worker failure', 'lease lost'],
      owner: ['server/mcp/researchTools.ts'],
      proof: { probe: 'VERIFY_ITEMS', what: 'RESEARCH_VERIFY items that succeeded of those settled', minSample: 5, workingAt: 0.7 },
    }),
    R({
      id: 'ANALYSIS.SYNTHESIS',
      stage: 'ANALYSIS',
      ability: 'Synthesize accepted claims into a cited report',
      dependsOn: ['VERIFICATION.GATE'],
      inputs: ['accepted claims'],
      outputs: ['RESEARCH_SYNTHESIZE succeeded', 'documents row'],
      failureConditions: ['uncitable claims', 'nothing to file'],
      owner: ['server/services/research/filing.ts'],
      proof: { probe: 'SYNTHESIS_ITEMS', what: 'RESEARCH_SYNTHESIZE items that succeeded of those settled', minSample: 3, workingAt: 0.7 },
    }),
    R({
      id: 'ANALYSIS.AUDIT',
      stage: 'ANALYSIS',
      ability: 'Audit the report (primary, adversarial, judge) to a verdict',
      dependsOn: ['ANALYSIS.SYNTHESIS'],
      inputs: ['filed report and claim ledger'],
      outputs: ['audits, verdict'],
      failureConditions: ['auditor not independent', 'audit work lost'],
      owner: ['server/services/research/auditRound.ts'],
      proof: { probe: 'AUDIT_ITEMS', what: 'RESEARCH_AUDIT items that succeeded of those settled', minSample: 3, workingAt: 0.7 },
    }),
    R({
      id: 'ANALYSIS.FILED',
      stage: 'ANALYSIS',
      ability: 'File a registered document for every packet that completes',
      dependsOn: ['ANALYSIS.AUDIT'],
      inputs: ['audited packet'],
      outputs: ['research_orchestrations.document_id'],
      failureConditions: ['filing failed', 'extraction failed'],
      owner: ['server/services/research/filing.ts'],
      proof: { probe: 'PACKETS_FILED', what: 'completed packets that carry a filed document', minSample: 3, workingAt: 0.9 },
      improvement: { metric: 'RESEARCH_JOB_SUCCESS_RATE', mutationScope: ['server/services/research/filing.ts', 'server/services/research/synthesisRecovery.ts', 'tests/research*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'DECISION.JOB_OUTCOME',
      stage: 'DECISION',
      ability: 'Bring a research job to a usable end (COMPLETE or COMPLETE_WITH_GAPS) rather than FAILED or parked',
      dependsOn: ['ANALYSIS.FILED'],
      inputs: ['packet state'],
      outputs: ['terminal orchestration status'],
      failureConditions: ['NEEDS_HUMAN', 'FAILED'],
      owner: ['server/services/research/packetRunner.ts', 'server/services/research/outcome.ts'],
      proof: { probe: 'JOBS_SUCCEED', what: 'settled packets (cancelled excluded) that completed', minSample: 5, workingAt: 0.7 },
      improvement: { metric: 'RESEARCH_JOB_SUCCESS_RATE', mutationScope: ['server/services/research/**', 'tests/research*.test.ts'], coveredBy: ['PACKETS:'] },
    }),
    R({
      id: 'DECISION.AUTONOMOUS',
      stage: 'DECISION',
      ability: 'Decide routine research parks under standing authority instead of asking the owner (rule 11)',
      dependsOn: ['DECISION.JOB_OUTCOME'],
      inputs: ['Needs-You cards about missions'],
      outputs: ['RUSSELL_ROUTINE_DECISION', 'answered requests'],
      failureConditions: ['card left open for the owner', 'no live standing grant'],
      owner: ['server/services/russell/routineDecisions.ts'],
      proof: { probe: 'PARKS_DECIDED_BY_BRAIN', what: 'mission cards older than an hour that Brain answered itself', minSample: 5, workingAt: 0.8 },
      improvement: {
        metric: 'OWNER_INTERVENTIONS_PER_DAY',
        mutationScope: ['server/services/russell/routineDecisions.ts', 'server/services/russell/needsHuman.ts', 'tests/russell*.test.ts'],
        coveredBy: ['OWNER:'],
      },
    }),
    R({
      id: 'DELIVERY.WRITEBACK',
      stage: 'DELIVERY',
      ability: 'Deliver a finished packet to the mission, goal or plan that asked for it',
      dependsOn: ['DECISION.JOB_OUTCOME'],
      inputs: ['completed packet with a mission'],
      outputs: ['russell_missions DONE'],
      failureConditions: ['mission left RUNNING after its packet completed'],
      owner: ['server/services/russell/loop.ts'],
      proof: { probe: 'MISSIONS_WRITTEN_BACK', what: 'missions whose packet completed that reached DONE', minSample: 3, workingAt: 0.8 },
      improvement: { metric: 'RESEARCH_JOB_SUCCESS_RATE', mutationScope: ['server/services/russell/loop.ts', 'server/services/russell/completionLinks.ts', 'tests/russell*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'RECOVERY.RETRY',
      stage: 'RECOVERY',
      ability: 'Recover a failed work item on a later attempt without a person',
      dependsOn: [],
      inputs: ['failed or expired work'],
      outputs: ['work_items SUCCEEDED after attempt 1'],
      failureConditions: ['repeated failure', 'retry repeating the same strategy'],
      owner: ['server/repos/workQueue.ts', 'server/services/research/repair.ts'],
      proof: { probe: 'AUTO_RECOVERY', what: 'retried work items that eventually succeeded', minSample: 20, workingAt: 0.6 },
      improvement: { metric: 'AUTO_RECOVERY_RATE', mutationScope: ['server/services/research/repair.ts', 'server/services/research/reissue.ts', 'tests/research*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'RECOVERY.LEASES',
      stage: 'RECOVERY',
      ability: 'Return work whose worker vanished (an expired lease is ended, the item claimable again)',
      dependsOn: [],
      inputs: ['expired leases'],
      outputs: ['work_leases.ended_at'],
      failureConditions: ['lease expired and never ended'],
      owner: ['server/repos/workQueue.ts'],
      proof: { probe: 'LEASES_RECLAIMED', what: 'leases expired over an hour ago that are ended', minSample: 5, workingAt: 0.9 },
      improvement: { metric: 'AUTO_RECOVERY_RATE', mutationScope: ['server/repos/workQueue.ts', 'tests/workQueue*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'RECOVERY.PROVIDERS',
      stage: 'RECOVERY',
      ability: 'Keep answering when free model providers fail (cooldown, release without spending attempts, other model)',
      dependsOn: [],
      inputs: ['provider errors'],
      outputs: ['RELEASED_TRANSIENT, not FAILED'],
      failureConditions: ['every configured provider exhausted'],
      owner: ['server/services/freeLane/capacity.ts'],
      proof: { probe: 'PROVIDERS_ANSWER', what: 'free-lane items not released for a provider failure', minSample: 20, workingAt: 0.6 },
      externalLimit: 'Free providers’ own quotas and outages; Brain can only rotate and back off.',
    }),
    R({
      id: 'RECOVERY.STALLS',
      stage: 'RECOVERY',
      ability: 'Keep every live packet moving or conclude it (no packet idle for six hours)',
      dependsOn: [],
      inputs: ['live orchestrations'],
      outputs: ['updated_at within six hours, or a terminal status'],
      failureConditions: ['packet idle holding a slot'],
      owner: ['server/services/research/packetRunner.ts'],
      proof: { probe: 'PACKETS_MOVING', what: 'live packets updated within six hours', minSample: 3, workingAt: 0.8 },
      improvement: { metric: 'RESEARCH_JOB_SUCCESS_RATE', mutationScope: ['server/services/research/packetRunner.ts', 'tests/research*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'RECOVERY.IDLE_CAPACITY',
      stage: 'RECOVERY',
      ability: 'Pick up waiting research while a lane has idle capacity (rule 9): nothing claimable waits an hour',
      dependsOn: [],
      inputs: ['queued research work items', 'free-lane and routine slots'],
      outputs: ['leases on waiting work'],
      failureConditions: ['a claim window full of work the lane declines', 'lane pool stopped', 'membership lost'],
      owner: ['server/repos/workQueue.ts', 'server/services/freeLane/capacity.ts'],
      proof: { probe: 'WORK_CLAIMED_PROMPTLY', what: 'claimable research items that have waited under an hour (now)', minSample: 5, workingAt: 0.7 },
      improvement: { metric: 'RESEARCH_JOB_SUCCESS_RATE', mutationScope: ['server/services/freeLane/capacity.ts', 'server/services/freeLane/worker.ts', 'tests/freeLane*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'LEARNING.DETECT',
      stage: 'LEARNING',
      ability: 'Turn a recurring failure class into a tracked weakness with a stage',
      dependsOn: [],
      inputs: ['failure rows'],
      outputs: ['improvement_candidates', 'improvement_events'],
      failureConditions: ['loop off', 'no movement for 48 h'],
      owner: ['server/services/improvement/loop.ts'],
      proof: { probe: 'WEAKNESSES_TRACKED', what: 'open candidates with an event in the last 48 h', minSample: 1, workingAt: 0.5 },
    }),
    R({
      id: 'LEARNING.DELIVER',
      stage: 'LEARNING',
      ability: 'Deliver an engineered improvement to production through Factory without a person',
      dependsOn: ['LEARNING.DETECT'],
      inputs: ['candidate with a change request'],
      outputs: ['delivered_at', 'decision'],
      failureConditions: ['objective never auto-released', 'PR closed unmerged', 'Factory cancelled'],
      owner: ['server/services/improvement/loop.ts', 'server/services/factory/release/grant.ts'],
      proof: { probe: 'IMPROVEMENTS_DELIVERED', what: 'candidates sent to Factory over a day ago that were delivered', minSample: 2, workingAt: 0.5 },
    }),
    R({
      id: 'LEARNING.METHODS',
      stage: 'LEARNING',
      ability: 'Hold accepted method research that reaches every worker’s guidance',
      dependsOn: [],
      inputs: ['brain-architecture research goals'],
      outputs: ['accepted method claims'],
      failureConditions: ['empty pool'],
      owner: ['server/services/research/methodRules.ts'],
      proof: { probe: 'METHOD_POOL', what: 'accepted claims in brain-architecture (lifetime; any is a pool)', minSample: 1, workingAt: 0.01 },
    }),
  ],
};


/**
 * A cash goal's planning chain, end to end (owner's order, 2026-11-05: test the
 * whole $10K process, find every blocker rather than the first, and keep the
 * test). Each requirement is a link a plan cannot be produced without, and the
 * reading that shows it held in production — including the connections
 * between stages, because a working stage whose output never reaches the next
 * one is a broken chain. Read hourly with the research map, on every goal that
 * starts (`assessLiveObjectives`), and after a release (`capabilities show`).
 */
export const GOAL_PLAN_MAP: CapabilityMap = {
  key: 'GOAL_PLAN',
  objective:
    'Turn an approved cash goal into the strongest evidence-backed plan Brain can support — openings found and constructed, ' +
    'buyers, prices and demand researched, every opening read by the quant engine, the plan re-read when evidence arrives, ' +
    'and the search widened while the plan falls short — on compute and a database that keep answering.',
  requirements: [
    R({
      id: 'GOAL.PLAN_EVALUATED',
      stage: 'GOAL',
      ability: 'Read every live targeted goal through the scenario engine, and finish the run',
      dependsOn: ['COMPUTE.DATABASE'],
      inputs: ['workstreams with a target'],
      outputs: ['scenario_runs labelled "goal …" COMPLETE'],
      failureConditions: ['scenario slot busy', 'run failed', 'database unavailable'],
      owner: ['server/services/goals/plan.ts'],
      proof: { probe: 'GOAL_PLAN_EVALUATED', what: 'goal scenario runs started in the window that completed', minSample: 3, workingAt: 0.9 },
    }),
    R({
      id: 'GOAL.PLAN_FRESH',
      stage: 'GOAL',
      ability: 'Keep every live goal’s plan current: a run within the last two hours',
      dependsOn: ['GOAL.PLAN_EVALUATED'],
      inputs: ['live targeted goals'],
      outputs: ['a recent goal scenario run per goal'],
      failureConditions: ['goal tick stopped', 'every pass busy'],
      owner: ['server/services/goals/tick.ts'],
      proof: { probe: 'GOAL_PLAN_FRESH', what: 'live targeted goals with a scenario run in the last two hours (now)', minSample: 1, workingAt: 1 },
    }),
    R({
      id: 'OPENINGS.SEARCH_WIDENS',
      stage: 'OPENINGS',
      ability: 'Keep searching while the plan falls short: a short goal opens new rounds',
      dependsOn: ['GOAL.PLAN_FRESH'],
      inputs: ['a reading that is not RECOMMENDABLE'],
      outputs: ['goal discovery or constructed rounds opened in the window'],
      failureConditions: ['live cap full of stalled rounds', 'cool-off', 'closed gate'],
      owner: ['server/services/goals/plan.ts', 'server/services/cash/discovery.ts'],
      proof: { probe: 'GOAL_SEARCH_WIDENS', what: 'live goals short of a recommendable plan that opened a round in the window', minSample: 1, workingAt: 1 },
    }),
    R({
      id: 'OPENINGS.ROUNDS_FILE',
      stage: 'OPENINGS',
      ability: 'Turn a goal’s research rounds into filed openings',
      dependsOn: ['OPENINGS.SEARCH_WIDENS', 'EVIDENCE.PACKETS_COMPLETE'],
      inputs: ['goal discovery rounds'],
      outputs: ['cash_opportunities filed from the round'],
      failureConditions: ['round abandoned with nothing found', 'packet never finished'],
      owner: ['server/services/cash/discovery.ts'],
      proof: { probe: 'GOAL_ROUNDS_FILE', what: 'goal rounds settled in the window that filed at least one opening', minSample: 3, workingAt: 0.3 },
    }),
    R({
      id: 'CONSTRUCTION.ROUNDS_FILE',
      stage: 'CONSTRUCTION',
      ability: 'Turn arrangements Brain constructed into openings that say a buyer pays',
      dependsOn: ['OPENINGS.SEARCH_WIDENS', 'EVIDENCE.PACKETS_COMPLETE'],
      inputs: ['constructed rounds (goal-…-mx-…)'],
      outputs: ['openings filed by constructed rounds'],
      failureConditions: ['pattern claims with no payer', 'round abandoned'],
      owner: ['server/services/cash/construct.ts'],
      proof: { probe: 'CONSTRUCTED_ROUNDS_FILE', what: 'constructed rounds settled in the window that filed at least one opening', minSample: 3, workingAt: 0.3 },
      improvement: { metric: 'CONSTRUCTED_ROUND_YIELD', mutationScope: ['server/services/cash/construct.ts', 'server/services/cash/discovery.ts', 'tests/cash*.test.ts'], coveredBy: [] },
    }),
    R({
      id: 'EVIDENCE.PACKETS_COMPLETE',
      stage: 'EVIDENCE',
      ability: 'Bring the research packets behind a goal’s rounds to a usable end',
      dependsOn: ['COMPUTE.DATABASE', 'COMPUTE.FREE_MODELS'],
      inputs: ['packets of goal rounds'],
      outputs: ['COMPLETE / COMPLETE_WITH_GAPS'],
      failureConditions: ['no fragment cleared its gate', 'audit work faulted', 'judge wanted more'],
      owner: ['server/services/research/packetRunner.ts'],
      proof: { probe: 'GOAL_PACKETS_COMPLETE', what: 'packets behind goal rounds settled in the window that completed', minSample: 3, workingAt: 0.4 },
    }),
    R({
      id: 'EVIDENCE.PATH_ANSWERS',
      stage: 'EVIDENCE',
      ability: 'Answer the narrow questions on an opening’s path to money (price, payer, timing, costs, conversion)',
      dependsOn: ['EVIDENCE.PACKETS_COMPLETE'],
      inputs: ['cash_needs question:* on openings'],
      outputs: ['needs RESOLVED with a card fact'],
      failureConditions: ['research did not finish', 'sources do not settle it'],
      owner: ['server/services/goals/pathResearch.ts'],
      proof: { probe: 'PATH_QUESTIONS_ANSWERED', what: 'opening questions closed in the window that were resolved', minSample: 5, workingAt: 0.25 },
    }),
    R({
      id: 'EVIDENCE.BUYER_PRICE',
      stage: 'EVIDENCE',
      ability: 'Establish a reachable buyer, current demand and a price buyers pay on the openings a goal considers',
      dependsOn: ['EVIDENCE.PATH_ANSWERS'],
      inputs: ['openings considered by the latest plan reading'],
      outputs: ['openings with REACHABLE_BUYER, CURRENT_DEMAND and OFFER_AND_PRICE established'],
      failureConditions: ['no payer', 'undated signal', 'price a guess'],
      owner: ['server/services/goals/pathResearch.ts', 'server/services/goals/plan.ts'],
      proof: { probe: 'OPENINGS_BUYER_PRICE', what: 'openings in each live goal’s latest reading with buyer, demand and price established', minSample: 3, workingAt: 0.2 },
    }),
    R({
      id: 'QUANT.MODELLED',
      stage: 'QUANT',
      ability: 'Give the quant engine every opening the goal considers that it can model',
      dependsOn: ['GOAL.PLAN_EVALUATED'],
      inputs: ['considered openings'],
      outputs: ['openings modelled in the portfolio'],
      failureConditions: ['opening excluded for a missing input', 'over the limits'],
      owner: ['server/services/goals/portfolio.ts'],
      proof: { probe: 'OPENINGS_MODELLED', what: 'openings in each live goal’s latest reading that the quant engine modelled', minSample: 3, workingAt: 0.3 },
    }),
    R({
      id: 'PLAN.READS_NEW_EVIDENCE',
      stage: 'PLAN',
      ability: 'Re-read the plan after an opening is filed, so new evidence reaches the plan',
      dependsOn: ['GOAL.PLAN_EVALUATED', 'OPENINGS.ROUNDS_FILE'],
      inputs: ['openings filed in the window'],
      outputs: ['a goal scenario run started after the opening was filed'],
      failureConditions: ['plan not re-read', 'opening in another project'],
      owner: ['server/services/goals/plan.ts'],
      proof: { probe: 'OPENINGS_REACH_PLAN', what: 'openings filed in the window (over 30 min old) followed by a goal plan run in their project', minSample: 1, workingAt: 0.9 },
    }),
    R({
      id: 'COMPUTE.GPU',
      stage: 'COMPUTE',
      ability: 'Serve research on Brain’s own GPU (RunPod) when it is configured',
      dependsOn: [],
      inputs: ['free-lane items routed to runpod/…', 'pod starts'],
      outputs: ['SUBMITTED by the GPU model'],
      failureConditions: ['pod cannot start', 'vLLM 503', 'model output refused'],
      owner: ['server/services/cheap/runpodPod.ts'],
      proof: { probe: 'GPU_SERVES', what: 'GPU-model free-lane attempts that submitted, with every refused pod start a failure', minSample: 5, workingAt: 0.3 },
      externalLimit: 'RunPod host capacity: a stopped pod cannot start while another tenant holds its GPU.',
    }),
    R({
      id: 'COMPUTE.FREE_MODELS',
      stage: 'COMPUTE',
      ability: 'Keep research answering on the free models when the GPU is down',
      dependsOn: [],
      inputs: ['free-lane items routed to free providers'],
      outputs: ['SUBMITTED by a free model'],
      failureConditions: ['every provider exhausted', 'answers refused'],
      owner: ['server/services/freeLane/worker.ts'],
      proof: { probe: 'FREE_MODELS_SERVE', what: 'free-model free-lane attempts (provider releases excluded) that submitted', minSample: 10, workingAt: 0.3 },
      externalLimit: 'Free providers’ own quotas and outages.',
    }),
    R({
      id: 'COMPUTE.DATABASE',
      stage: 'COMPUTE',
      ability: 'Answer research work without Brain’s own database refusing it (pool, timeouts, dropped connections)',
      dependsOn: [],
      inputs: ['free-lane item attempts'],
      outputs: ['attempts that did not fail on Brain’s database'],
      failureConditions: ['pool exhausted', 'connection terminated', 'query timeout'],
      owner: ['server/db/database.ts'],
      proof: { probe: 'DATABASE_AVAILABLE', what: 'free-lane attempts that did not fail on Brain’s own database', minSample: 20, workingAt: 0.95 },
    }),
  ],
};

/** Every map Brain holds. A new objective kind adds one here, not a new mechanism. */
export const CAPABILITY_MAPS: Record<string, CapabilityMap> = { RESEARCH: RESEARCH_MAP, GOAL_PLAN: GOAL_PLAN_MAP };

/* ------------------------------------------------------------------------- */
/* Classification                                                             */
/* ------------------------------------------------------------------------- */

export interface Assessed {
  requirement: CapabilityRequirement;
  status: CapabilityStatus;
  reading: ProbeReading | null;
  why: string;
}

/** One requirement's answer. Pure. */
export function classify(requirement: CapabilityRequirement, ownerExists: boolean, reading: ProbeReading | null): Assessed {
  if (!ownerExists) {
    return { requirement, status: 'MISSING', reading, why: `no implementation: ${requirement.owner[0]} is not in the running image` };
  }
  if (!reading) return { requirement, status: 'UNPROVEN', reading, why: 'the probe could not be read' };
  const { minSample, workingAt } = requirement.proof;
  if (reading.total < minSample) {
    return { requirement, status: 'UNPROVEN', reading, why: `${reading.total} attempt(s) in the window, below the ${minSample} that would show it` };
  }
  const rate = reading.ok / reading.total;
  const shown = `${reading.ok}/${reading.total} (${(rate * 100).toFixed(0)}%, bar ${(workingAt * 100).toFixed(0)}%)`;
  return rate >= workingAt
    ? { requirement, status: 'WORKING', reading, why: shown }
    : { requirement, status: 'BROKEN', reading, why: shown };
}

export interface Gap {
  id: string;
  status: CapabilityStatus;
  stage: CapabilityStage;
  /** Failures the reading counted in the window — how many jobs the gap touched. */
  failures: number;
  /** Requirements that depend on this one, directly or not. */
  downstream: string[];
  /** Upstream gaps this one sits behind: fix them first, or this one cannot be judged. */
  behind: string[];
  rank: number;
  why: string;
  externalLimit: string | null;
}

/** Every requirement that depends on `id`, transitively. Pure. */
export function downstreamOf(map: CapabilityMap, id: string): string[] {
  const out = new Set<string>();
  const visit = (one: string): void => {
    for (const r of map.requirements) {
      if (r.dependsOn.includes(one) && !out.has(r.id)) {
        out.add(r.id);
        visit(r.id);
      }
    }
  };
  visit(id);
  return [...out];
}

/** Every requirement `id` depends on, transitively. Pure. */
export function upstreamOf(map: CapabilityMap, id: string): string[] {
  const byId = new Map(map.requirements.map((r) => [r.id, r]));
  const out = new Set<string>();
  const visit = (one: string): void => {
    for (const dep of byId.get(one)?.dependsOn ?? []) {
      if (!out.has(dep)) {
        out.add(dep);
        visit(dep);
      }
    }
  };
  visit(id);
  return [...out];
}

/**
 * The connected gaps, most consequential first. Pure.
 *
 * A gap's weight is what it touches: the jobs it failed in the window, times
 * the part of the process that cannot work while it does not (itself and
 * everything downstream). A MISSING capability weighs as if it failed every
 * job its downstream saw — nothing it would have done happened. UNPROVEN is a
 * gap of evidence, listed after every BROKEN and MISSING one.
 */
export function connectedGaps(map: CapabilityMap, assessed: Assessed[]): Gap[] {
  const byId = new Map(assessed.map((a) => [a.requirement.id, a]));
  const gaps: Gap[] = [];
  for (const a of assessed) {
    if (a.status === 'WORKING') continue;
    const downstream = downstreamOf(map, a.requirement.id);
    const behind = upstreamOf(map, a.requirement.id).filter((u) => {
      const s = byId.get(u)?.status;
      return s === 'BROKEN' || s === 'MISSING';
    });
    const seen = downstream.map((d) => byId.get(d)?.reading?.total ?? 0);
    const failures =
      a.status === 'MISSING'
        ? Math.max(a.reading?.total ?? 0, ...seen, 1)
        : a.status === 'BROKEN'
          ? (a.reading?.total ?? 0) - (a.reading?.ok ?? 0)
          : 0;
    const severity = a.status === 'UNPROVEN' ? 0 : 1;
    const rank = severity * failures * (1 + downstream.length);
    gaps.push({
      id: a.requirement.id,
      status: a.status,
      stage: a.requirement.stage,
      failures,
      downstream,
      behind,
      rank,
      why: a.why,
      externalLimit: a.requirement.externalLimit ?? null,
    });
  }
  return gaps.sort((x, y) => y.rank - x.rank || STAGE_ORDER.indexOf(x.stage) - STAGE_ORDER.indexOf(y.stage));
}

/* ------------------------------------------------------------------------- */
/* Reuse: which maps a new objective needs, and whether it earns an audit      */
/* ------------------------------------------------------------------------- */

export interface ObjectiveShape {
  text: string;
  /** Research packets it may open, when known (a research goal's ceiling). */
  maxPackets?: number | null;
  /** Money it may commit, when known (a cash goal's ceiling). */
  budget?: number | null;
  /** Days until its deadline, when known. */
  horizonDays?: number | null;
}

/** Words that say an objective is a money goal, which runs through the goal-plan chain. */
const NEEDS_GOAL_PLAN = /(\$\s?\d|\b\d[\d,.]*\s?(?:k|dollars?|usd|eur|gbp)\b|\b(?:revenue|settled cash|profit|income|sales)\b)/i;

/** Words that say an objective needs the research process. */
const NEEDS_RESEARCH = /\b(research|evidence|source|market|demand|buyer|price|competitor|plan|opportunit\w*|validate|investigat\w*|study|analy[sz]\w*)\b/i;

/**
 * Whether an objective is substantial enough to assess its capabilities first.
 *
 * Owner's order: not every small job pays for a full-system audit. An objective
 * is substantial when it commits real scope — several packets, money, a horizon
 * of weeks — or states several distinct outcomes. A one-packet question is not.
 */
export function isSubstantial(objective: ObjectiveShape): boolean {
  if ((objective.budget ?? 0) >= 100) return true;
  if ((objective.maxPackets ?? 0) >= 3) return true;
  if ((objective.horizonDays ?? 0) >= 7 && objective.text.length >= 200) return true;
  const outcomes = objective.text.split(/\n\s*(?:\d+[.)]|[-*•])\s+/).length - 1;
  return outcomes >= 4;
}

/** The maps an objective depends on, by what it asks. Pure. */
export function mapsFor(objective: ObjectiveShape): CapabilityMap[] {
  const out: CapabilityMap[] = [];
  if (NEEDS_RESEARCH.test(objective.text) || NEEDS_GOAL_PLAN.test(objective.text)) out.push(RESEARCH_MAP);
  if (NEEDS_GOAL_PLAN.test(objective.text)) out.push(GOAL_PLAN_MAP);
  return out;
}

export interface ObjectiveAssessment {
  substantial: boolean;
  maps: string[];
  /** Gaps that stand between this objective and its outcome, most consequential first. */
  blocking: Gap[];
  /** True when nothing BROKEN or MISSING stands in the way. */
  ready: boolean;
}

/**
 * What a new objective needs that Brain does not demonstrably have. Pure over
 * an assessment the caller already read; a small objective gets no audit.
 */
export function assessObjective(objective: ObjectiveShape, assessedByMap: Record<string, Assessed[]>): ObjectiveAssessment {
  const substantial = isSubstantial(objective);
  if (!substantial) return { substantial, maps: [], blocking: [], ready: true };
  const maps = mapsFor(objective);
  const blocking = maps
    .flatMap((map) => connectedGaps(map, assessedByMap[map.key] ?? []))
    .filter((g) => g.status === 'BROKEN' || g.status === 'MISSING');
  return { substantial, maps: maps.map((m) => m.key), blocking, ready: blocking.length === 0 };
}

/**
 * The gaps that become improvement candidates (§87): BROKEN or MISSING, with an
 * owner route, past the loop's own thresholds, and not already raised by one of
 * the loop's own detectors this pass. Pure.
 */
export function gapsForImprovement(
  gaps: Gap[],
  map: CapabilityMap,
  alreadyDetected: readonly string[],
  minFailures: number,
): { gap: Gap; requirement: CapabilityRequirement; route: ImprovementRoute }[] {
  const byId = new Map(map.requirements.map((r) => [r.id, r]));
  const out: { gap: Gap; requirement: CapabilityRequirement; route: ImprovementRoute }[] = [];
  for (const gap of gaps) {
    if (gap.status !== 'BROKEN' && gap.status !== 'MISSING') continue;
    if (gap.behind.length > 0) continue; // fix what it sits behind first
    if (gap.failures < minFailures) continue;
    const requirement = byId.get(gap.id);
    const route = requirement?.improvement;
    if (!requirement || !route) continue;
    if (requirement.externalLimit && gap.status === 'BROKEN') continue;
    if (route.coveredBy.length > 0) continue;
    if (alreadyDetected.some((key) => key === `CAPABILITY:${map.key}.${gap.id}` || key.startsWith(`CAPABILITY:${map.key}.${gap.id}#`))) continue;
    out.push({ gap, requirement, route });
  }
  return out;
}
