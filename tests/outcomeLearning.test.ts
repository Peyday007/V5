/**
 * Learning from outcomes: from a measured result to a changed decision.
 *
 * Four halves, each asserted against the defect it exists for:
 *
 * 1. **The real outcome.** Production's own twenty-six Cash deep dives, as
 *    read-only reports printed them on 2026-09-23, replayed into outcome rows.
 *    They must produce a lesson that changes the next launch (twenty-two in a
 *    row never reached research) and a result that must NOT be generalized
 *    (the two dives that did research came from one discovery packet).
 * 2. **The real rows.** A deep dive driven through the real tick — compiler,
 *    mission, packet, plan screen — observed by the real observer.
 * 3. **The capability.** The recurring blocker becomes a proposal with routes
 *    compared; the fix is the embedded-question rule in `actorScope.ts`, and
 *    verification reads only attempts launched after the change is live.
 * 4. **Accountability.** A withdrawn lesson stops changing decisions, the ones
 *    it already changed are flagged, and nothing is ever deleted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createProject } from '../server/repos/projects.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import {
  createOpportunity,
  getOpportunity,
  listOpportunities,
  updateOpportunity,
} from '../server/repos/cashPortfolio.ts';
import { startValidations, validationQuestion } from '../server/services/cash/validation.ts';
import { tick } from '../server/services/russell/loop.ts';
import { launch } from '../server/services/russell/launch.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { latestMissionForCandidate } from '../server/repos/russellMissions.ts';
import { getOrchestration } from '../server/repos/research.ts';
import { getDb } from '../server/db/database.ts';
import {
  APPROVAL_ENVELOPES,
  CASH_FORBIDDEN_ACTIONS,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import { ownActionMatches } from '../server/services/research/actorScope.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import {
  listCorrections,
  listDecisions,
  listOutcomes,
  listPredictions,
  listWatchChanges,
  recordCapabilityDecision,
  recordCorrection,
  recordOutcome,
  recordPrediction,
} from '../server/repos/learning.ts';
import { STREAK_LESSON_KEY, deriveLessons, signalLessonKey } from '../server/services/learning/lessons.ts';
import { adviseDeepDiveLaunch } from '../server/services/learning/advise.ts';
import { observeCashDeepDives } from '../server/services/learning/observe.ts';
import { capabilityProposals } from '../server/services/learning/capability.ts';
import { checkWatches } from '../server/services/learning/watch.ts';
import { learningView } from '../server/services/learning/view.ts';
import { briefing } from '../server/services/russell/projections.ts';
import { DEEP_DIVE_EXPECTATION } from '../server/services/learning/expectation.ts';
import { GOAL_OF, validateMeasure, type OutcomeMeasure } from '../server/domain/learning.ts';
import type { CashOpportunity, ResearchFragment, ResearchOrchestration } from '../server/domain/types.ts';

interface FixtureDive {
  opportunityId: string;
  validationState: 'NEEDS_PERSON' | 'BLOCKED' | 'RUNNING';
  startedAt: string;
  settledAt: string | null;
  completedPasses: number;
  signal: string;
  sourcePacket: string;
  candidateId: string | null;
  refusalEvidence?: string;
}

interface Fixture {
  refusal: string;
  dives: FixtureDive[];
}

let projectId = '';
let userId = '';

async function operatorProject(): Promise<void> {
  await freshProject();
  // The production shape: a Cash project an operator created, whose slug no
  // in-code envelope map claims — so the sprint's own envelope decides.
  const project = await createProject({
    name: 'Cash Mode 1',
    slug: `cash-mode-${Math.random().toString(36).slice(2, 10)}`,
  });
  projectId = project.id;
  const user = await createUser({
    email: `learning-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const started = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(started.ok).toBe(true);
}

async function fixture(): Promise<Fixture> {
  const raw = await readFile(
    new URL('./fixtures/production-deep-dives-2026-09-23.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(raw) as Fixture;
}

const UNKNOWN_MINUTES: OutcomeMeasure = {
  metric: 'HUMAN_MINUTES',
  value: null,
  unit: 'minutes',
  evidence: 'UNKNOWN',
  source: 'Nothing records how long a person spends on a decision.',
};

/**
 * Production's dives as outcome rows, exactly as the observer would write them
 * from those rows: the subject ids, signals, source packets, timestamps and
 * pass counts are the production values.
 */
async function replayProduction(options: { runningAsStopped?: boolean } = {}): Promise<void> {
  const { dives, refusal } = await fixture();
  for (const dive of dives) {
    const worked = dive.completedPasses > 0;
    const stopped = dive.validationState !== 'RUNNING' || options.runningAsStopped === true;
    const settled = dive.settledAt ?? new Date(Date.parse(dive.startedAt) + 6 * 3600 * 1000).toISOString();
    const { prediction } = await recordPrediction({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: dive.opportunityId,
      attempt: 1,
      recommendation: 'Launch deep dive round 1 on this opening.',
      expected: DEEP_DIVE_EXPECTATION,
      basis: `Reconstructed from production: launched ${dive.startedAt}.`,
      provenance: 'RECONSTRUCTED',
      decidedAt: dive.startedAt,
    });
    await recordOutcome({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: dive.opportunityId,
      attempt: 1,
      goalKind: GOAL_OF.CASH_DEEP_DIVE.goal,
      successCondition: GOAL_OF.CASH_DEEP_DIVE.success,
      result: !stopped ? 'ONGOING' : worked ? 'PARTIAL' : 'NOT_ATTEMPTED',
      workPerformed: worked,
      blockerClass: !stopped ? null : worked ? 'WAITING_ON_PERSON' : 'PLAN_OUTSIDE_ENVELOPE',
      explanation: worked ? 'Research ran and stopped at a person.' : 'No research pass ever ran.',
      measures: [
        {
          metric: 'ELAPSED_MS',
          value: Date.parse(settled) - Date.parse(dive.startedAt),
          unit: 'ms',
          evidence: 'MEASURED',
          source: 'validation_started_at to validation_settled_at',
        },
        {
          metric: 'RESEARCH_PASSES',
          value: dive.completedPasses,
          unit: 'count',
          evidence: 'MEASURED',
          source: 'research_passes COMPLETE',
        },
        UNKNOWN_MINUTES,
      ],
      conditions: {
        signal: dive.signal,
        sourceOrchestrationId: dive.sourcePacket,
        blockerDetail: worked ? null : refusal,
      },
      sourceRefs: [`cash_opportunities:${dive.opportunityId}`],
      predictionId: prediction.id,
      observedAt: stopped ? settled : new Date().toISOString(),
    });
  }
}

/** A real opening a real deep dive can be started on. */
async function opening(signal: string, buyingSignal: string): Promise<CashOpportunity> {
  const mode = (await getCashMode(projectId))!;
  const created = await createOpportunity({
    projectId,
    cashModeId: mode.id,
    ownerUserId: userId,
    title: buyingSignal.slice(0, 60),
    mechanism: 'ARBITRAGE',
    currency: 'USD',
    opportunitySignal: signal,
  } as never);
  await updateOpportunity(created.id, { buying_signal: buyingSignal } as never);
  return (await getOpportunity(created.id))!;
}

/**
 * One deep dive driven the whole way through the real machinery: the producer
 * starts it, the tick judges and compiles it, the launch service turns it into
 * a mission and a packet, and the packet runner applies the real plan screen.
 * The only shortcut is freeing the discovery buckets' concurrency, which is
 * what made production wait hours for each mission.
 */
async function driveDive(signal: string, buyingSignal: string): Promise<string> {
  const target = await opening(signal, buyingSignal);
  await startValidations({ projectId });
  for (let i = 0; i < 12; i += 1) {
    await tick('learning-test');
    const current = await getOpportunity(target.id);
    const candidate = current?.candidateId ? await getCandidate(current.candidateId) : null;
    if (candidate?.state === 'QUEUED') break;
  }
  const current = (await getOpportunity(target.id))!;
  const candidate = (await getCandidate(current.candidateId!))!;
  await getDb().run(
    `UPDATE russell_missions SET state = 'CANCELLED'
      WHERE project_id = ? AND state IN ('RUNNING', 'LAUNCHING', 'PLANNED') AND candidate_id != ?`,
    [projectId, candidate.id],
  );
  await getDb().run(
    `UPDATE russell_budget_reservations SET state = 'RELEASED' WHERE kind = 'MISSION' AND state = 'HELD'`,
  );
  const spec = (candidate as unknown as { judgment: { missionSpec: Record<string, unknown> } }).judgment
    .missionSpec;
  const launched = await launch({ ...spec, candidateId: candidate.id } as Parameters<typeof launch>[0]);
  expect(launched.ok).toBe(true);
  for (let i = 0; i < 3; i += 1) await tick('learning-test');
  return target.id;
}

beforeEach(async () => {
  await operatorProject();
});

// ---------------------------------------------------------------------------
// 1. Production's own outcomes change the next decision
// ---------------------------------------------------------------------------

describe('production deep dives, replayed', () => {
  it('learns that the approach is failing before research, from twenty-two refusals in a row', async () => {
    await replayProduction();
    const lessons = deriveLessons({
      outcomes: await listOutcomes(projectId),
      corrections: await listCorrections(projectId),
    });
    const streak = lessons.find((lesson) => lesson.key === STREAK_LESSON_KEY)!;
    expect(streak.status).toBe('ACTIVE');
    expect(streak.outcomeIds).toHaveLength(22);
    expect(streak.independent).toBe(22);
    expect(streak.scope['dominantBlocker']).toBe('PLAN_OUTSIDE_ENVELOPE');
    expect(streak.changes).toBe('CASH_DEEP_DIVE_LAUNCH');
  });

  it('does not conclude anything about pricing-asymmetry openings from two dives off one packet', async () => {
    await replayProduction();
    const lessons = deriveLessons({
      outcomes: await listOutcomes(projectId),
      corrections: await listCorrections(projectId),
    });
    const pricing = lessons.find((lesson) => lesson.key === signalLessonKey('PRICING_OR_INFORMATION_ASYMMETRY'))!;
    // Two dives did research — GoTranscript and Rev.com — and both came out of
    // discovery packet orc_8adf57cff129492ca837: one finding, researched twice.
    expect(pricing.outcomeIds).toHaveLength(2);
    expect(pricing.independent).toBe(1);
    expect(pricing.level).toBe('ANECDOTE');
    expect(pricing.status).toBe('BELOW_FLOOR');
    expect(pricing.changes).toBeNull();
    // And the thirteen refused dives on the same signal were set aside, not
    // counted as thirteen failures of the kind of opening.
    expect(pricing.statement).toContain('13 more were set aside');

    const resalable = lessons.find((lesson) => lesson.key === signalLessonKey('RESALABLE_ASSET_OPENING'))!;
    expect(resalable.independent).toBe(0);
    expect(resalable.changes).toBeNull();
    expect(resalable.effect).toContain('never looked at them');
  });

  it('replaces two new dives with one probe once the running two stop, and says why', async () => {
    // What production will look like when its two RUNNING dives reach the
    // stall window: both slots free, twenty-four refusals in a row.
    await replayProduction({ runningAsStopped: true });
    const advice = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    expect(advice.cap).toBe(1);
    const [decision] = await listDecisions(projectId);
    expect(decision!.defaultChoice).toBe('launch 2');
    expect(decision!.chosen.startsWith('PROBE')).toBe(true);
    expect(decision!.lessonKey).toBe(STREAK_LESSON_KEY);
    expect(decision!.outcomeIds).toHaveLength(24);
    expect(decision!.reason).toContain('without a single research pass');
    // Asked again, the probe it just sent is the reason to wait — and asking a
    // third time under the same conditions writes nothing new.
    const again = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    expect(again.cap).toBe(0);
    await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    const rows = await listDecisions(projectId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.chosen.startsWith('WAIT')).toBe(true);
  });

  it('waits while a probe is out, and while the last probe failed under this same revision', async () => {
    await replayProduction({ runningAsStopped: true });
    const out = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 1, ordered: [] });
    expect(out.cap).toBe(0);
    await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    const later = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    expect(later.cap).toBe(0);
    expect(later.explanation).toContain('failed the same way');
    // A new revision is a change in conditions, so it earns a probe at once.
    process.env['BRAIN_REVISION'] = 'a-new-revision';
    try {
      const fresh = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
      expect(fresh.cap).toBe(1);
    } finally {
      delete process.env['BRAIN_REVISION'];
    }
  });

  it('resumes full launching by itself once one attempt reaches research', async () => {
    await replayProduction({ runningAsStopped: true });
    await recordOutcome({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: 'cop_probe_that_ran',
      attempt: 1,
      goalKind: 'RESEARCH',
      successCondition: GOAL_OF.CASH_DEEP_DIVE.success,
      result: 'FAILED',
      workPerformed: true,
      blockerClass: 'EVIDENCE_INSUFFICIENT',
      explanation: 'Research ran and did not establish who pays.',
      measures: [UNKNOWN_MINUTES],
      conditions: { signal: 'EXPIRING_OPENING', sourceOrchestrationId: 'orc_x' },
      sourceRefs: [],
      predictionId: null,
      observedAt: new Date().toISOString(),
    });
    const advice = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    expect(advice.cap).toBe(2);
    expect(await listDecisions(projectId)).toHaveLength(0);
  });

  it('compares each prediction with its outcome, and labels a reconstructed prediction as one', async () => {
    await replayProduction();
    const view = await learningView(projectId);
    const refused = view.outcomes.find((entry) => entry.outcome.subjectId === 'cop_79d4dcfe55f34e9fb084')!;
    expect(refused.prediction!.provenance).toBe('RECONSTRUCTED');
    expect(refused.comparison).toContain('Expected (reconstructed)');
    expect(refused.comparison).toContain('NOT_ATTEMPTED');
    expect(view.counts.withoutWork).toBe(22);
    expect(view.summary.notConcluded).toContain('PRICING_OR_INFORMATION_ASYMMETRY');
    // An unknown is never presented as a figure.
    for (const entry of view.outcomes) {
      const minutes = entry.outcome.measures.find((measure) => measure.metric === 'HUMAN_MINUTES');
      expect(minutes?.value ?? null).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The observer reads real rows
// ---------------------------------------------------------------------------

describe('observing a deep dive driven through the real machinery', () => {
  it('records a refused plan as NOT_ATTEMPTED with the refusal, and never as evidence about the opening', async () => {
    // An opening whose own published words read as an instruction: the plan
    // screen refuses it correctly, before and after the fix.
    const id = await driveDive('PAID_TASK_OR_CONTRACT', 'Call the seller and ask for the bulk price.');
    const opportunity = (await getOpportunity(id))!;
    const mission = (await latestMissionForCandidate(opportunity.candidateId!))!;
    const packet = (await getOrchestration(mission.orchestrationId!))!;
    expect(packet.status).toBe('NEEDS_HUMAN');
    expect(packet.failureReason).toContain('instructs the researcher to call the');

    await observeCashDeepDives(projectId);
    const rows = (await listOutcomes(projectId)).filter((one) => one.subjectId === id);
    // The tick itself observed this dive while it was still running — the
    // learning pass is on the durable loop — and the stop is a second row
    // rather than an edit of the first.
    expect(rows.map((one) => one.result)).toEqual(['ONGOING', 'NOT_ATTEMPTED']);
    const outcome = rows[1];
    expect(outcome!.result).toBe('NOT_ATTEMPTED');
    expect(outcome!.workPerformed).toBe(false);
    expect(outcome!.blockerClass).toBe('PLAN_OUTSIDE_ENVELOPE');
    expect(outcome!.conditions['validationOrchestrationId']).toBe(packet.id);
    // The prediction the launcher wrote at the moment it decided.
    const prediction = (await listPredictions(projectId)).find((one) => one.subjectId === id)!;
    expect(prediction.provenance).toBe('RECORDED');
    expect(outcome!.predictionId).toBe(prediction.id);
    // Observing again writes nothing new.
    expect(await observeCashDeepDives(projectId)).toHaveLength(0);
  });

  it('lets production’s own refused question through the plan screen now', async () => {
    const id = await driveDive(
      'RESALABLE_ASSET_OPENING',
      'Market: U.S. limited-edition sneaker collaboration resale. Complex.com reports that the fragment collab resells well above retail.',
    );
    const opportunity = (await getOpportunity(id))!;
    const mission = (await latestMissionForCandidate(opportunity.candidateId!))!;
    const packet = (await getOrchestration(mission.orchestrationId!))!;
    expect(packet.status).not.toBe('NEEDS_HUMAN');
    expect(packet.failureReason ?? '').not.toContain('telephone call');
  });
});

// ---------------------------------------------------------------------------
// 3. The capability: proposed from the outcomes, fixed, verified from rows
// ---------------------------------------------------------------------------

describe('the recurring blocker as a capability proposal', () => {
  it('compares implementing, connecting and a person, and recommends implementing', async () => {
    await replayProduction();
    const [proposal] = await capabilityProposals(projectId);
    expect(proposal!.blockerClass).toBe('PLAN_OUTSIDE_ENVELOPE');
    expect(proposal!.occurrences).toBe(22);
    expect(proposal!.subjects).toBe(22);
    expect(proposal!.reason).toContain('instructs the researcher to telephone call');
    expect(proposal!.recommended).toBe('IMPLEMENT');
    const byRoute = Object.fromEntries(proposal!.options.map((option) => [option.route, option]));
    expect(byRoute['CONNECT_SERVICE']!.viable).toBe(false);
    expect(byRoute['PERSON']!.cost.evidence).toBe('MEASURED');
    expect(byRoute['PERSON']!.cost.text).toContain('22 person decision(s)');
    // The value is stated as unmeasured rather than invented.
    expect(proposal!.valueEvidence).toContain('not measured');
    expect(byRoute['IMPLEMENT']!.cost.evidence).toBe('UNKNOWN');
    expect(proposal!.objective!.objective).toContain('telephone call');
    expect(proposal!.state).toBe('PROPOSED');
  });

  it('verifies only from attempts launched after the change went live', async () => {
    await replayProduction();
    const [proposal] = await capabilityProposals(projectId);
    await recordCapabilityDecision({
      projectId,
      blockerKey: proposal!.blockerKey,
      route: 'IMPLEMENT',
      reason: 'Brain is refusing its own plan.',
      decidedById: userId,
      authorityChannel: 'SHELL',
    });
    const landedAt = new Date(Date.now() - 60_000).toISOString();
    await recordCapabilityDecision({
      projectId,
      blockerKey: proposal!.blockerKey,
      route: 'IMPLEMENT',
      reason: 'The embedded-question rule is deployed.',
      landedAt,
      decidedById: userId,
      authorityChannel: 'SHELL',
    });
    expect((await capabilityProposals(projectId))[0]!.state).toBe('AWAITING_EVIDENCE');

    // A dive launched after the change, that performed research.
    const { prediction } = await recordPrediction({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: 'cop_after_fix',
      attempt: 1,
      recommendation: 'Launch deep dive round 1 as a probe, one at a time.',
      expected: DEEP_DIVE_EXPECTATION,
      basis: 'probe',
      provenance: 'RECORDED',
    });
    await recordOutcome({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: 'cop_after_fix',
      attempt: 1,
      goalKind: 'RESEARCH',
      successCondition: GOAL_OF.CASH_DEEP_DIVE.success,
      result: 'PARTIAL',
      workPerformed: true,
      blockerClass: 'WAITING_ON_PERSON',
      explanation: 'Research ran.',
      measures: [UNKNOWN_MINUTES],
      conditions: { signal: 'EXPIRING_OPENING', sourceOrchestrationId: 'orc_y' },
      sourceRefs: [],
      predictionId: prediction.id,
      observedAt: new Date().toISOString(),
    });
    const verified = (await capabilityProposals(projectId))[0]!;
    expect(verified.state).toBe('VERIFIED_SOLVED');
    expect(verified.verification).toContain('performed work');
  });

  it('says NOT_SOLVED when an attempt after the change hits the same refusal', async () => {
    await replayProduction();
    const [proposal] = await capabilityProposals(projectId);
    const { refusal } = await fixture();
    await recordCapabilityDecision({
      projectId,
      blockerKey: proposal!.blockerKey,
      route: 'IMPLEMENT',
      reason: 'deployed',
      landedAt: new Date(Date.now() - 60_000).toISOString(),
      decidedById: userId,
      authorityChannel: 'SHELL',
    });
    const { prediction } = await recordPrediction({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: 'cop_still_refused',
      attempt: 1,
      recommendation: 'probe',
      expected: DEEP_DIVE_EXPECTATION,
      basis: 'probe',
      provenance: 'RECORDED',
    });
    await recordOutcome({
      projectId,
      approach: 'CASH_DEEP_DIVE',
      subjectKind: 'cash_opportunities',
      subjectId: 'cop_still_refused',
      attempt: 1,
      goalKind: 'RESEARCH',
      successCondition: GOAL_OF.CASH_DEEP_DIVE.success,
      result: 'NOT_ATTEMPTED',
      workPerformed: false,
      blockerClass: 'PLAN_OUTSIDE_ENVELOPE',
      explanation: 'No research pass ever ran.',
      measures: [UNKNOWN_MINUTES],
      conditions: { signal: 'EXPIRING_OPENING', sourceOrchestrationId: 'orc_z', blockerDetail: refusal },
      sourceRefs: [],
      predictionId: prediction.id,
      observedAt: new Date().toISOString(),
    });
    expect((await capabilityProposals(projectId))[0]!.state).toBe('NOT_SOLVED');
  });
});

describe('the embedded-question rule', () => {
  const ENVELOPE = APPROVAL_ENVELOPES['RUSSELL_CASH_VALIDATION_V1']!;

  it('admits the question every production dive since e5882ae was refused for', () => {
    const question = validationQuestion({
      buyingSignal: 'Complex.com reports that the fragment collab resells well above retail.',
      title: 'resale',
      source: 'https://www.complex.com/',
      signalObservedAt: '2026-06-25',
    } as CashOpportunity);
    expect(ownActionMatches(question, CASH_FORBIDDEN_ACTIONS)).toEqual([]);
    const profile = profileFor('RUSSELL_CASH_VALIDATION_V1')!;
    const verdict = planFitsEnvelope({
      envelope: ENVELOPE,
      orchestration: {
        id: 'orc_test',
        assignment: ENVELOPE.assignmentTemplate!.replace('{QUESTION}', question).replace(
          '{JURISDICTION}',
          ENVELOPE.jurisdiction,
        ),
        fixture: false,
      } as unknown as ResearchOrchestration,
      fragments: [
        {
          fragmentKey: 'opening-validation',
          question,
          geography: 'United States',
          timeframe: 'as published',
          population: 'this one opening',
          definitions: 'the opening as published',
          acceptableSourceTypes: ['a published price list, rate card, fee schedule or quote for comparable work'],
          excludedSourceTypes: ['a forecast or projection presented as a current fact'],
          completionCriteria: ['who pays is named from a published source'],
          minIndependentSources: 1,
          requiredEvidence: profile.lanes.map((lane) => ({ id: lane.id, description: lane.description, necessity: 'CONDITIONAL' })),
        } as unknown as ResearchFragment,
      ],
    });
    expect(verdict.reasons.filter((reason) => reason.includes('instructs the researcher'))).toEqual([]);
  });

  it('still refuses an instruction coordinated after a question, or with no question at all', () => {
    for (const text of [
      'Establish whether it is listed, and then telephone call the buyer.',
      'Establish whether it is listed and call the seller.',
      'Telephone call the buyer to ask whether it is listed.',
      'We will contact the seller whether or not it is listed.',
      'Record what the listing says about bidding, and place a bid.',
    ]) {
      expect(ownActionMatches(text, CASH_FORBIDDEN_ACTIONS).length, text).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The decision path end to end, and accountability
// ---------------------------------------------------------------------------

describe('the launcher consults outcomes', () => {
  it('starts one probe instead of two, writes the prediction with the decision, then waits', async () => {
    await replayProduction({ runningAsStopped: true });
    await opening('EXPIRING_OPENING', 'NJDOH lists RFQ #09-11-26-39DPA, open until October.');
    await opening('ACTIVE_BUYER_DEMAND', 'A county posted a request for janitorial bids.');
    const started = await startValidations({ projectId });
    expect(started).toHaveLength(1);
    const [decision] = await listDecisions(projectId);
    expect(decision!.chosen).toBe('PROBE: launch 1');
    const prediction = (await listPredictions(projectId)).find(
      (one) => one.subjectId === started[0]!.opportunityId,
    )!;
    expect(prediction.provenance).toBe('RECORDED');
    expect(prediction.decisionId).toBe(decision!.id);
    expect(prediction.basis).toContain('one probe');

    // The probe holds a slot, so the next pass starts nothing.
    expect(await startValidations({ projectId })).toHaveLength(0);
    const open = (await listOpportunities({ projectId })).filter((one) => one.validationState === null);
    expect(open).toHaveLength(1);
  });

  it('stops using a lesson a person withdrew, and flags the decisions that used it', async () => {
    await replayProduction({ runningAsStopped: true });
    await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    await recordCorrection({
      projectId,
      targetKind: 'LESSON',
      targetKey: STREAK_LESSON_KEY,
      action: 'WITHDRAW',
      reason: 'The refusal is fixed and deployed; stop probing.',
      decidedById: userId,
      authorityChannel: 'BROWSER',
    });
    const after = await adviseDeepDiveLaunch({ projectId, defaultCap: 2, slotsHeld: 0, ordered: [] });
    expect(after.cap).toBe(2);
    const view = await learningView(projectId);
    expect(view.decisions[0]!.restsOnWithdrawnLesson).toBe(true);
    expect(view.lessons.find((lesson) => lesson.key === STREAK_LESSON_KEY)!.status).toBe('WITHDRAWN');
    // Nothing it rested on was deleted.
    expect(await listOutcomes(projectId)).toHaveLength(26);
  });

  it('tells Russell when the lesson starts to hold, once, and what Brain now does', async () => {
    await replayProduction({ runningAsStopped: true });
    const first = await checkWatches(projectId);
    const lessonChange = first.find((change) => change.toValue === 'ACTIVE')!;
    expect(lessonChange.proposal).toContain('one probe dive at a time');
    expect(await checkWatches(projectId)).toHaveLength(0);
    const said = await briefing({ projectId, projectName: 'Cash Mode 1' });
    expect(said.learned).toContain('one probe dive at a time');
    expect((await listWatchChanges(projectId)).length).toBe(first.length);
  });
});

describe('what the tables refuse to hold', () => {
  it('refuses an unknown carrying a value, and a figure carrying no class', () => {
    expect(validateMeasure({ ...UNKNOWN_MINUTES, value: 0 })).toContain('UNKNOWN and still carries a value');
    expect(
      validateMeasure({ metric: 'ELAPSED_MS', value: null, unit: 'ms', evidence: 'MEASURED', source: 'x' }),
    ).toContain('carries no value');
  });

  it('never deletes, and updates nothing but a watch cursor', async () => {
    const source = await readFile(new URL('../server/repos/learning.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/DELETE\s+FROM/i);
    const updates = [...source.matchAll(/UPDATE\s+(\w+)/g)].map((match) => match[1]);
    expect(new Set(updates)).toEqual(new Set(['outcome_watches']));
  });
});
