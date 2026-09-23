/**
 * Turning work Brain actually did into outcome rows.
 *
 * ---------------------------------------------------------------------------
 * Observed, not reported
 * ---------------------------------------------------------------------------
 *
 * Every field here is read from rows Brain wrote while the work ran: the
 * opening's own validation columns, the mission, the orchestration, the
 * research passes a worker completed, the plan-screen event the packet runner
 * recorded, and the money ledger. Nothing a worker said about itself decides
 * anything, and no prose is read to decide a result.
 *
 * ---------------------------------------------------------------------------
 * The distinction everything else rests on
 * ---------------------------------------------------------------------------
 *
 * `workPerformed` separates an attempt that touched its subject from one that
 * never did. A deep dive whose packet was refused before a single research
 * pass ran has said nothing whatever about the opening it was about — only
 * about the conditions it was launched into. Counting it as "this kind of
 * opening does not qualify" would be learning the wrong lesson from the right
 * rows, and it is precisely the lesson production would have taught: of the
 * first twenty-six dives, twenty-two never ran a pass.
 *
 * ---------------------------------------------------------------------------
 * When a result became true, not when Brain noticed
 * ---------------------------------------------------------------------------
 *
 * `observedAt` is the instant the result became a fact — the dive's own
 * settled stamp — so a whole history observed in one pass still sorts in the
 * order it happened. An ongoing attempt is observed at the moment of reading,
 * and says so in its measures.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { getCashMode, listCashEventsFor } from '../../repos/cashMode.ts';
import { listMoneyEntries } from '../../repos/cashLedger.ts';
import { latestMissionForCandidate } from '../../repos/russellMissions.ts';
import { getOrchestration, listPasses } from '../../repos/research.ts';
import { listEventsByEntity } from '../../repos/events.ts';
import {
  currentOutcomes,
  getPrediction,
  listOutcomes,
  recordOutcome,
  recordPrediction,
  type OutcomeRecord,
} from '../../repos/learning.ts';
import { qualifiedTier } from '../cash/validation.ts';
import { tierRank, type CashTier } from '../cash/tier.ts';
import {
  GOAL_OF,
  type BlockerClass,
  type OutcomeMeasure,
  type OutcomeResult,
} from '../../domain/learning.ts';
import type { CashOpportunity, ResearchOrchestration } from '../../domain/types.ts';
import { DEEP_DIVE_EXPECTATION } from './expectation.ts';


/**
 * Why a packet stopped, as a class, read from the plan-screen event the packet
 * runner records rather than from the sentence it also writes.
 */
async function blockerFor(
  orchestration: ResearchOrchestration | null,
  passes: number,
): Promise<{ blocker: BlockerClass | null; detail: string | null }> {
  if (!orchestration) return { blocker: null, detail: null };
  const events = await listEventsByEntity('RUN', orchestration.runId);
  const outside = events
    .filter((event) => event.eventType === 'RESEARCH_PLAN_OUTSIDE_ENVELOPE')
    .filter((event) => (event.payload as { orchestrationId?: string }).orchestrationId === orchestration.id)
    .pop();
  if (outside) {
    const reasons = (outside.payload as { reasons?: unknown }).reasons;
    const text = Array.isArray(reasons) ? reasons.filter((r) => typeof r === 'string').join(' ') : '';
    return { blocker: 'PLAN_OUTSIDE_ENVELOPE', detail: text || orchestration.failureReason };
  }
  if (orchestration.status === 'NEEDS_HUMAN') {
    const reason = orchestration.failureReason ?? '';
    if (reason.startsWith('The named approval envelope')) {
      return { blocker: 'ENVELOPE_UNAVAILABLE', detail: reason };
    }
    return { blocker: 'WAITING_ON_PERSON', detail: reason || null };
  }
  if (passes > 0 && (orchestration.status === 'FAILED' || orchestration.status === 'COMPLETE_WITH_GAPS')) {
    return { blocker: 'EVIDENCE_INSUFFICIENT', detail: orchestration.failureReason };
  }
  return { blocker: null, detail: orchestration.failureReason };
}

/**
 * The deep dives in one project, each observed once per result.
 *
 * Returns the rows written this pass, so a caller can report how many results
 * moved rather than how many it looked at.
 */
export async function observeCashDeepDives(projectId: string): Promise<OutcomeRecord[]> {
  if (!(await getCashMode(projectId))) return [];
  const written: OutcomeRecord[] = [];
  /*
   * A dive whose state is terminal and whose result is already on record is not
   * read again: nothing about a BLOCKED or COMPLETE dive's attempt can change
   * without a new round, which is a new attempt. This runs on every tick, and
   * §27 records what re-deriving a settled history on every pass costs once the
   * history is large. NEEDS_PERSON is re-read, because a person answering it
   * puts research back in motion.
   */
  const settled = new Set(
    currentOutcomes(await listOutcomes(projectId, 'CASH_DEEP_DIVE'))
      .filter((one) => one.result !== 'ONGOING')
      .map((one) => `${one.subjectId}|${one.attempt}`),
  );
  for (const opportunity of await listOpportunities({ projectId })) {
    if (!opportunity.validationStartedAt || opportunity.validationRounds < 1) continue;
    const terminal = opportunity.validationState === 'BLOCKED' || opportunity.validationState === 'COMPLETE';
    if (terminal && settled.has(`${opportunity.id}|${Math.max(1, opportunity.validationRounds)}`)) continue;
    const outcome = await observeOne(projectId, opportunity);
    if (outcome) written.push(outcome);
  }
  return written;
}

async function observeOne(projectId: string, opportunity: CashOpportunity): Promise<OutcomeRecord | null> {
  const attempt = Math.max(1, opportunity.validationRounds);
  const mission = opportunity.candidateId ? await latestMissionForCandidate(opportunity.candidateId) : null;
  const orchestrationId = mission?.orchestrationId ?? opportunity.validationOrchestrationId ?? null;
  const orchestration = orchestrationId ? await getOrchestration(orchestrationId) : null;
  const passes = orchestrationId
    ? (await listPasses(orchestrationId)).filter((pass) => pass.status === 'COMPLETE').length
    : 0;
  const tier = (await qualifiedTier(opportunity)) as CashTier;
  const reachedPayer = tierRank(tier) >= tierRank('CANDIDATE');
  const { blocker, detail } = await blockerFor(orchestration, passes);

  const state = opportunity.validationState;
  /*
   * A dive can read RUNNING while its packet has already stopped: the opening's
   * own state only moves when the stall window elapses, six hours later. A
   * packet at NEEDS_HUMAN with no pass is a stop that has already happened, and
   * waiting six hours to call it one would be waiting to learn what the rows
   * already say.
   */
  const stoppedBeforeWork = orchestration?.status === 'NEEDS_HUMAN' && passes === 0;
  let result: OutcomeResult;
  let blockerClass: BlockerClass | null = blocker;
  let explanation: string;
  if (reachedPayer) {
    result = 'SUCCEEDED';
    blockerClass = null;
    explanation = `The piece reached the ${tier} tier: research established who pays.`;
  } else if ((state === 'PENDING' || state === 'RUNNING') && !(stoppedBeforeWork)) {
    result = 'ONGOING';
    explanation =
      passes > 0
        ? `Still running: ${passes} research pass(es) completed so far.`
        : 'Still running, and no research pass has completed yet.';
    if (blocker === 'PLAN_OUTSIDE_ENVELOPE') {
      explanation += ` Its plan has already been refused: ${detail ?? ''}`.trimEnd();
    }
  } else if (passes === 0) {
    result = 'NOT_ATTEMPTED';
    blockerClass = blocker ?? (state === 'BLOCKED' ? 'STALLED' : 'OTHER');
    explanation =
      'No research pass ever ran, so this says nothing about the opening — only about the ' +
      `conditions it was launched into. ${detail ?? ''}`.trimEnd();
  } else if (state === 'NEEDS_PERSON') {
    result = 'PARTIAL';
    blockerClass = blocker ?? 'WAITING_ON_PERSON';
    explanation =
      `Research ran (${passes} pass(es)) and then stopped at a decision only a person can make; ` +
      'no payer is established yet.';
  } else {
    result = 'FAILED';
    blockerClass = blocker ?? 'EVIDENCE_INSUFFICIENT';
    explanation = `Research ran (${passes} pass(es)) and did not establish who pays. ${detail ?? ''}`.trimEnd();
  }

  const settledAt = opportunity.validationSettledAt;
  const now = new Date().toISOString();
  // When the result became true: the dive's own settle stamp, or — for a packet
  // that stopped before the dive's state caught up — the packet's last write.
  const becameTrue =
    result === 'ONGOING'
      ? now
      : settledAt ?? (stoppedBeforeWork ? orchestration?.updatedAt ?? now : now);
  const observedAt = becameTrue;
  const startedMs = Date.parse(opportunity.validationStartedAt ?? now);
  const endMs = Date.parse(becameTrue);

  const money = await listMoneyEntries({ projectId, opportunityId: opportunity.id });
  const packetWaitsOnPerson = orchestration?.status === 'NEEDS_HUMAN' ? 1 : 0;
  const measures: OutcomeMeasure[] = [
    {
      metric: 'ELAPSED_MS',
      value: Math.max(0, endMs - startedMs),
      unit: 'ms',
      evidence: 'MEASURED',
      source:
        result === 'ONGOING'
          ? 'validation_started_at to the moment of this reading (still open)'
          : settledAt
            ? 'validation_started_at to validation_settled_at'
            : 'validation_started_at to the packet stopping (research_orchestrations.updated_at)',
    },
    {
      metric: 'RESEARCH_PASSES',
      value: passes,
      unit: 'count',
      evidence: 'MEASURED',
      source: orchestrationId
        ? `research_passes with status COMPLETE on ${orchestrationId}`
        : 'no orchestration was ever created for this dive',
    },
    {
      metric: 'DIRECT_COST_CENTS',
      value: money.length === 0 ? 0 : null,
      unit: 'cents',
      evidence: money.length === 0 ? 'MEASURED' : 'UNKNOWN',
      source:
        money.length === 0
          ? 'no cash_money_entries row names this opportunity; research runs on the fixed subscription'
          : 'ledger rows exist for this opportunity and are not attributed to the dive itself',
    },
    {
      metric: 'HUMAN_DECISIONS_WAITING',
      value: packetWaitsOnPerson,
      unit: 'count',
      evidence: 'MEASURED',
      source: orchestrationId ? `research_orchestrations.status of ${orchestrationId}` : 'no packet',
    },
    {
      metric: 'HUMAN_MINUTES',
      value: null,
      unit: 'minutes',
      evidence: 'UNKNOWN',
      source: 'Nothing records how long a person spends on a decision; this is not estimated.',
    },
  ];

  const prediction = await predictionFor(projectId, opportunity, attempt);
  const { outcome, created } = await recordOutcome({
    projectId,
    approach: 'CASH_DEEP_DIVE',
    subjectKind: 'cash_opportunities',
    subjectId: opportunity.id,
    attempt,
    goalKind: GOAL_OF.CASH_DEEP_DIVE.goal,
    successCondition: GOAL_OF.CASH_DEEP_DIVE.success,
    result,
    workPerformed: passes > 0,
    blockerClass,
    explanation,
    measures,
    conditions: {
      signal: opportunity.opportunitySignal ?? null,
      // The discovery packet this opening came out of. Two openings from one
      // packet are one source of evidence about the kind of opening they are.
      sourceOrchestrationId: opportunity.orchestrationId ?? null,
      validationOrchestrationId: orchestrationId,
      envelopeId: orchestration?.approvalEnvelopeId ?? null,
      tier,
      round: attempt,
      blockerDetail: detail ? detail.slice(0, 600) : null,
    },
    sourceRefs: [
      `cash_opportunities:${opportunity.id}`,
      ...(mission ? [`russell_missions:${mission.id}`] : []),
      ...(orchestrationId ? [`research_orchestrations:${orchestrationId}`] : []),
    ],
    predictionId: prediction?.id ?? null,
    observedAt,
  });
  return created ? outcome : null;
}

/**
 * The prediction behind a dive: the one recorded when it launched, or — for a
 * dive launched before predictions were written — one reconstructed from the
 * launch event the dive left behind, and labelled as reconstructed.
 */
async function predictionFor(projectId: string, opportunity: CashOpportunity, attempt: number) {
  const recorded = await getPrediction('CASH_DEEP_DIVE', opportunity.id, attempt);
  if (recorded) return recorded;
  const events = await listCashEventsFor(opportunity.id, 200);
  const launch = events
    .filter((event) => event.kind === 'CASH_VALIDATION_STARTED')
    .find((event) => Number((event.detail as { round?: unknown }).round ?? 1) === attempt);
  if (!launch) return null;
  const { prediction } = await recordPrediction({
    projectId,
    approach: 'CASH_DEEP_DIVE',
    subjectKind: 'cash_opportunities',
    subjectId: opportunity.id,
    attempt,
    recommendation: `Launch deep dive round ${attempt} on this opening.`,
    expected: DEEP_DIVE_EXPECTATION,
    basis: `Reconstructed from the launch event ${launch.id}: "${launch.summary}"`,
    provenance: 'RECONSTRUCTED',
    decidedAt: launch.createdAt,
  });
  return prediction;
}
