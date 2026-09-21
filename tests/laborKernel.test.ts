/**
 * The labor kernel: who produces the work, and what Brain may conclude from an
 * absence.
 *
 * ---------------------------------------------------------------------------
 * What was missing, and what this pins
 * ---------------------------------------------------------------------------
 *
 * Brain knew what it wanted to produce and held no row saying who produced it.
 * The nearest thing was `cash_opportunities.fulfillment_owner` — one free-text
 * line per opening, with no vocabulary, no test, no blocker and no way to ask
 * the question across a portfolio.
 *
 * Four properties are what make this kernel honest rather than a form, and
 * this file pins each of them as a property rather than as an example.
 *
 * **The default is a burden of proof, not an assumption.** The single most
 * expensive mistake available here is Brain deciding a task is its own because
 * nothing said otherwise, so the tests that matter are the *refusals*: a
 * healthy fleet, a present capability and no answered questions must still
 * produce `NOT_ESTABLISHED`, and `assignByBrain` must write nothing.
 *
 * **An unknown is never favourable, and the favourable direction is Brain.**
 * Every question that could stop a task moving has to be answered in the
 * permitting direction from a *recorded* answer, and an absence never counts.
 *
 * **A human role must name its reason.** There is no reason meaning "this is
 * how it has always been done", so a habit has nowhere to be filed — enforced
 * by a CHECK, by `assignByPerson` and by the route.
 *
 * **History is never overwritten.** Role compression is unanswerable from
 * current state, because current state is exactly what forgot.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createOpportunity, transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  insertClaims,
  updateFragment,
} from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import {
  createTask,
  createWorkflow,
  listAllocations,
  listLaborRounds,
  listMarketOptions,
  listNecessityAnswers,
  listTasks,
  listWorkflows,
  liveAllocationFor,
  recordAllocation,
  recordNecessityAnswer,
} from '../server/repos/labor.ts';
import { validateLabor, layerIsHuman, questionAnsweredBy } from '../server/domain/labor.ts';
import { assessTask } from '../server/services/labor/necessity.ts';
import { chainOf, laborSnapshot } from '../server/services/labor/map.ts';
import { allocate, MAX_OPEN_LABOR_ROUNDS } from '../server/services/labor/allocate.ts';
import { assignByBrain, assignByPerson } from '../server/services/labor/assign.ts';
import { deriveFromPortfolio, workflowNameFor } from '../server/services/labor/derive.ts';
import { runLaborKernel } from '../server/services/labor/kernel.ts';
import { ROUND_COOL_OFF_MS } from '../server/services/cash/discovery.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { declareWorkflow, retire } from '../server/services/labor/declare.ts';
import { laborView } from '../server/services/labor/view.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { getApprovalEnvelope } from '../server/services/research/approvalEnvelope.ts';
import {
  HUMAN_NECESSITY_REASONS,
  NECESSITY_BASES,
  NECESSITY_QUESTIONS,
  type Layer,
  type LaborFinding,
  type LaborTask,
} from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `labor-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

/**
 * One healthy execution surface, so `RESEARCH_A_QUESTION` reads PRESENT.
 *
 * Registered rather than stubbed, because that capability is `PRESENT` only
 * when the fleet actually holds a healthy Routine — the same reading
 * `auditAdmission` uses — and a stub would let this suite pass against a
 * `readCapability` that had stopped reading rows. A test calling it *without*
 * this is the MISSING case, which is asserted separately.
 */
async function healthyFleet(): Promise<void> {
  const account = await createAccount({ name: `labor-${Math.random().toString(36).slice(2, 8)}` });
  await createRoutine({
    accountId: account.id,
    routineRef: `trig_${Math.random().toString(36).slice(2, 12)}`,
    name: 'A surface',
    tokenSecretName: 'LABOR_TEST_SECRET',
    tokenDigest: 'a'.repeat(64),
    workerId: `wkr_${Math.random().toString(36).slice(2, 12)}`,
  });
}

/** A workflow and one task in it, without going through the portfolio. */
async function seededTask(input?: { name?: string; capabilityId?: string | null }): Promise<LaborTask> {
  const workflow = await createWorkflow({
    projectId,
    name: `A workflow ${Math.random().toString(36).slice(2, 8)}`,
    origin: 'SEED',
    declaredByRef: userId,
  });
  const task = await createTask({
    projectId,
    workflowId: workflow.workflow.id,
    name: input?.name ?? 'Write the summary',
    output: 'A one-page summary of what the buyer asked for.',
    origin: 'SEED',
    capabilityId: input?.capabilityId ?? null,
    declaredByRef: userId,
  });
  return task.task;
}

async function assess(task: LaborTask, independentVerification: boolean | null = true) {
  return assessTask({
    task,
    answers: await listNecessityAnswers(projectId),
    independentVerification,
  });
}

/**
 * Answer every question in the direction that permits Brain to take the task.
 *
 * Written out rather than looped over a "supportsBrainWhen" helper on purpose:
 * a fixture that derived the permitting answers from the same table the
 * verdict reads would pass whatever that table said.
 */
async function answerEverythingForBrain(taskId: string): Promise<void> {
  const answers: [string, 'YES' | 'NO'][] = [
    ['BRAIN_IS_FASTER', 'YES'],
    ['BRAIN_IS_CHEAPER', 'YES'],
    ['BRAIN_QUALITY_AT_LEAST_EQUAL', 'YES'],
    ['BRAIN_CAN_SELF_VERIFY', 'YES'],
    ['REQUIRES_PHYSICAL_PRESENCE', 'NO'],
    ['REQUIRES_LICENSED_HUMAN', 'NO'],
    ['HUMAN_INTERACTION_ADDS_VALUE', 'NO'],
    ['HANDLES_ONLY_EXCEPTIONS', 'NO'],
  ];
  for (const [question, answer] of answers) {
    await recordNecessityAnswer({
      projectId,
      taskId,
      question: question as (typeof NECESSITY_QUESTIONS)[number],
      answer,
      basis: 'PERSON',
      statement: 'Recorded by the fixture.',
      answeredByRef: userId,
    });
  }
}

interface LaborClaim {
  claim: string;
  finding: LaborFinding;
  subject: string;
  qualifier?: string;
  rateCents?: number;
  geography?: string | null;
}

/**
 * A finished mission for one labor round, carrying declared findings.
 *
 * Built from the real repositories rather than from a stub, because the thing
 * under test is which rows the absorption reads: a fixture that handed it
 * findings directly would pass against an absorption that read prose.
 */
async function finishedRound(input: {
  candidateId: string;
  claims: LaborClaim[];
  missionEndsAs?: 'DONE' | 'FAILED';
}): Promise<string> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a labor round',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a labor round',
    assignment: 'who may produce this',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the market this question names',
      requiredEvidence: [
        { id: 'permission', description: 'who may produce this', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a licensing board’s own published requirements'],
      excludedSourceTypes: ['a requirement asserted with no source that states it'],
      completionCriteria: ['every requirement declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'labor-allocation',
      question: 'Who may produce this?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);

  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, {
    status: 'ACCEPTED',
    completedAt: new Date().toISOString(),
    blockedReason: null,
  });

  const inserted = await insertClaims(
    input.claims.map((one) => ({
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: one.claim,
      sourceUrl: 'https://example.test/board/rule-14',
      sourceTitle: 'A licensing rule',
      sourcePublisher: 'A licensing board',
      sourceDate: '2026-09-10',
      evidenceExcerpt: one.claim,
      evidenceLocator: 'the rule body',
      evidenceLane: 'permission',
      laborFinding: one.finding,
      laborSubject: one.subject,
      laborQualifier: one.qualifier ?? null,
      laborRateCents: one.rateCents ?? null,
      geography: one.geography ?? 'Michigan',
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${one.claim}|${one.subject}`,
    })),
  );
  for (const claim of inserted) {
    await decideClaim(claim.id, { accepted: true });
  }

  const { mission } = await launchMission({
    projectId,
    layerId: layer.id,
    visibility: 'SHARED',
    objective: 'a labor round',
    whyNow: 'the map has a task with no answer',
    idempotencyKey: `mission:${orchestration.id}`,
    candidateId: input.candidateId,
  });
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({
    missionId: mission.id,
    from: 'RUNNING',
    to: input.missionEndsAs ?? 'DONE',
  });
  return orchestration.id;
}

/**
 * One accepted claim carrying a labor declaration, with no round behind it.
 *
 * For the cases that need a real `research_claims` id — a researched necessity
 * answer carries one, and the column is a foreign key — without pretending a
 * round asked for it.
 */
async function acceptedLaborClaim(input: LaborClaim): Promise<string> {
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a claim',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'a claim',
    assignment: 'who may produce this',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      geography: 'the market this question names',
      requiredEvidence: [
        { id: 'permission', description: 'who may produce this', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['a licensing board\u2019s own published requirements'],
      excludedSourceTypes: ['a requirement asserted with no source that states it'],
      completionCriteria: ['every requirement declared on its claim'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'labor-allocation',
      question: 'Who may produce this?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: input.claim,
      sourceUrl: 'https://example.test/board/rule-14',
      sourceTitle: 'A licensing rule',
      sourcePublisher: 'A licensing board',
      sourceDate: '2026-09-10',
      evidenceExcerpt: input.claim,
      evidenceLocator: 'the rule body',
      evidenceLane: 'permission',
      laborFinding: input.finding,
      laborSubject: input.subject,
      laborQualifier: input.qualifier ?? null,
      laborRateCents: input.rateCents ?? null,
      geography: input.geography ?? 'Michigan',
      retrievedAt: '2026-09-12',
      confidence: 0.8,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `${input.claim}|${input.subject}|standalone`,
    },
  ]);
  await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

// ---------------------------------------------------------------------------

describe('the default is a burden of proof, never an assumption', () => {
  it('refuses to conclude a task is Brain’s from an absence of answers', async () => {
    // Everything Brain can read for itself is as favourable as it gets: the
    // capability is present and a second session exists to verify. Every
    // question a *source* would have to answer is unasked.
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    const reading = await assess(task, true);

    expect(reading.verdict).toBe('NOT_ESTABLISHED');
    expect(reading.reason).toBeNull();
    expect(reading.blockers.length).toBeGreaterThan(0);

    const outcome = await assignByBrain({ projectId, task, reading });
    expect(outcome.ok).toBe(false);
    expect(await liveAllocationFor(task.id)).toBeNull();
  });

  it('takes the task only once every gating question is answered in the permitting direction', async () => {
    await healthyFleet();
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await answerEverythingForBrain(task.id);

    const reading = await assess(task, true);
    expect(reading.verdict).toBe('BRAIN_DEFENSIBLE');
    expect(reading.blockers).toEqual([]);

    const outcome = await assignByBrain({ projectId, task, reading });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.allocation.productionLayer).toBe('BRAIN');
    expect(outcome.allocation.necessityReason).toBeNull();
    expect(outcome.allocation.decidedBy).toBe('BRAIN');
  });

  /**
   * The refusal that matters most, because it is the one a reader would
   * assume works.
   *
   * Every question is answered in the permitting direction *except* the one
   * being suppressed, so the only thing that can make this fail is the gate
   * itself. Each one is checked, because a gate that held for two of the five
   * and not the third is exactly the shape of defect nobody notices.
   */
  it('a single unanswered gating question is enough to withhold the verdict', async () => {
    await healthyFleet();
    const gating = [
      'BRAIN_QUALITY_AT_LEAST_EQUAL',
      'REQUIRES_PHYSICAL_PRESENCE',
      'REQUIRES_LICENSED_HUMAN',
      'HUMAN_INTERACTION_ADDS_VALUE',
    ] as const;

    for (const suppressed of gating) {
      const task = await seededTask({
        name: `Task without ${suppressed}`,
        capabilityId: 'RESEARCH_A_QUESTION',
      });
      await answerEverythingForBrain(task.id);
      // Replace the one answer with an honest UNKNOWN, which is a *recorded*
      // answer and still must not permit anything.
      await recordNecessityAnswer({
        projectId,
        taskId: task.id,
        question: suppressed,
        answer: 'UNKNOWN',
        basis: 'PERSON',
        statement: 'Nothing published settles this.',
        answeredByRef: userId,
      });

      const reading = await assess(task, true);
      expect(reading.verdict, `${suppressed} should withhold the verdict`).toBe('NOT_ESTABLISHED');
    }
  });

  /**
   * The invariant `automationFrontier` orders by, and the state that broke it.
   *
   * A task with the capability present, the quality answered, verification
   * satisfied and one human question left `UNKNOWN` is correctly
   * `NOT_ESTABLISHED` — and produced **no blockers at all**, which the
   * frontier orders by and a reader takes as *ready to move now*. The most
   * misleading output this module can produce, from the one state that looks
   * healthiest. Found by re-reading the verdict logic rather than by a run.
   */
  it('never reports an empty blocker list on a task that is not established', async () => {
    await healthyFleet();
    for (const suppressed of [
      'REQUIRES_LICENSED_HUMAN',
      'REQUIRES_PHYSICAL_PRESENCE',
      'HUMAN_INTERACTION_ADDS_VALUE',
    ] as const) {
      const task = await seededTask({
        name: `Unknown ${suppressed}`,
        capabilityId: 'RESEARCH_A_QUESTION',
      });
      await answerEverythingForBrain(task.id);
      await recordNecessityAnswer({
        projectId,
        taskId: task.id,
        question: suppressed,
        answer: 'UNKNOWN',
        basis: 'PERSON',
        statement: 'Nothing published settles this.',
        answeredByRef: userId,
      });

      const reading = await assess(task, true);
      expect(reading.verdict, suppressed).toBe('NOT_ESTABLISHED');
      expect(reading.blockers.length, suppressed).toBeGreaterThan(0);
      expect(reading.blockers.map((one) => one.kind), suppressed).toContain(
        'NECESSITY_UNANSWERED',
      );
    }
  });

  it('refuses when Brain cannot produce the output at all, whatever else is answered', async () => {
    // `SEND_A_MESSAGE` has no reader, so `readCapability` reports MISSING —
    // which is a derived NO to question 2 and is not overridable by anything a
    // person recorded about speed or quality.
    const task = await seededTask({ capabilityId: 'SEND_A_MESSAGE' });
    await answerEverythingForBrain(task.id);

    const reading = await assess(task, true);
    expect(reading.verdict).toBe('NOT_ESTABLISHED');
    expect(reading.blockers.map((one) => one.kind)).toContain('CAPABILITY_MISSING');
    expect(reading.capability?.state).toBe('MISSING');
  });

  it('an unreadable fleet is UNKNOWN rather than NO, and still refuses', async () => {
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await answerEverythingForBrain(task.id);
    // Self-verification stays YES, so the disjunction is satisfied and the
    // verdict holds — the point is that an unreadable fleet does not report
    // itself as an *absence* of verification capacity.
    const reading = await assess(task, null);
    const verification = reading.questions.find(
      (one) => one.question === 'INDEPENDENT_VERIFICATION_AVAILABLE',
    );
    expect(verification?.answer).toBe('UNKNOWN');
    expect(verification?.basis).toBe('DERIVED');
  });

  it('a capability Brain has no word for is UNKNOWN, not MISSING', async () => {
    const task = await seededTask({ capabilityId: 'FOLD_THE_LAUNDRY' });
    const reading = await assess(task, true);
    expect(reading.capability?.state).toBe('UNKNOWN');
    expect(reading.blockers.map((one) => one.kind)).toContain('CAPABILITY_UNKNOWN');
  });
});

describe('a human role must name its reason', () => {
  it('refuses a person with no reason, and names the six', async () => {
    const task = await seededTask();
    const outcome = await assignByPerson({
      projectId,
      task,
      productionLayer: 'OFFSHORE_HUMAN',
      necessityReason: null,
      rationale: 'This is how we have always done it.',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    for (const reason of HUMAN_NECESSITY_REASONS) {
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
    expect(await liveAllocationFor(task.id)).toBeNull();
  });

  it('refuses a reason on a layer that is not a person', async () => {
    const task = await seededTask();
    const outcome = await assignByPerson({
      projectId,
      task,
      productionLayer: 'SOFTWARE_TOOL',
      necessityReason: 'EXPERT_JUDGMENT',
      rationale: 'A tool with an opinion.',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(false);
  });

  /**
   * There is no vocabulary entry for a habit.
   *
   * Read from the constant rather than asserted as a list, so the property
   * survives somebody adding a seventh reason — what it refuses is a reason
   * whose *meaning* is "this is how it has always been done".
   */
  it('has no reason meaning the work has simply always been done this way', () => {
    const words = HUMAN_NECESSITY_REASONS.join(' ').toLowerCase();
    expect(words).not.toMatch(/legacy|historic|tradition|always|existing|incumbent/);
    expect(HUMAN_NECESSITY_REASONS).toHaveLength(6);
  });

  /**
   * The defect the report printed on its very first row.
   *
   * `established` was a boolean read off `verdict === 'HUMAN_REQUIRED'`, and
   * the report turned it into *"established by a published source"* — false
   * whenever a person answered the necessity question themselves, which is
   * most of them on a new map. The verdict says the *test* settled it, never
   * that a source did.
   */
  it('says what actually backs a human role, in three values rather than two', async () => {
    const asserted = await seededTask({ name: 'Nothing answers the question' });
    await assignByPerson({
      projectId,
      task: asserted,
      productionLayer: 'DOMESTIC_HUMAN',
      // A reason no published source can settle, and nothing has recorded the
      // judgement either.
      necessityReason: 'EXPERT_JUDGMENT',
      rationale: 'Somebody experienced does this.',
      actorRef: userId,
    });

    const answered = await seededTask({ name: 'A person answered it' });
    await recordNecessityAnswer({
      projectId,
      taskId: answered.id,
      question: 'REQUIRES_LICENSED_HUMAN',
      answer: 'YES',
      basis: 'PERSON',
      statement: 'I am fairly sure a licence is needed here.',
      answeredByRef: userId,
    });
    await assignByPerson({
      projectId,
      task: answered,
      productionLayer: 'SPECIALIST_PROFESSIONAL',
      necessityReason: 'ACCOUNTABILITY_LICENSING',
      rationale: 'A licensed person signs it.',
      actorRef: userId,
    });

    const view = await laborView(projectId);
    const byTask = new Map(view.humanDependencies.map((one) => [one.taskId, one]));
    expect(byTask.get(asserted.id)?.backing).toBe('ASSERTED');
    // A person's own answer is recorded, and is still not a published rule.
    expect(byTask.get(answered.id)?.backing).toBe('PERSON');
    expect(view.summary).not.toMatch(/published source established/);

    // Weakest first, because that is the role worth re-examining.
    expect(view.humanDependencies[0]!.taskId).toBe(asserted.id);
  });

  it('calls a role backed by a gated claim RESEARCH, and only then', async () => {
    const task = await seededTask({ name: 'A published rule answers it' });
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'SPECIALIST_PROFESSIONAL',
      necessityReason: 'ACCOUNTABILITY_LICENSING',
      rationale: 'A licensed person signs it.',
      actorRef: userId,
    });

    // Before the claim: a reason on the allocation and nothing behind it.
    let view = await laborView(projectId);
    expect(view.humanDependencies[0]!.backing).toBe('ASSERTED');

    const claimId = await acceptedLaborClaim({
      claim: 'Only a licensed notary may certify this document.',
      finding: 'HUMAN_REQUIREMENT',
      subject: 'ACCOUNTABILITY_LICENSING',
    });
    await recordNecessityAnswer({
      projectId,
      taskId: task.id,
      question: 'REQUIRES_LICENSED_HUMAN',
      answer: 'YES',
      basis: 'RESEARCHED',
      statement: 'Only a licensed notary may certify this document.',
      sourceClaimId: claimId,
    });

    view = await laborView(projectId);
    expect(view.humanDependencies[0]!.backing).toBe('RESEARCH');
  });

  it('records a person’s decision with the reason, whatever Brain would have concluded', async () => {
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await answerEverythingForBrain(task.id);
    // Brain would take this one. A person may still say no.
    const outcome = await assignByPerson({
      projectId,
      task,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'OVERSIGHT_VERIFICATION',
      rationale: 'The first ten of these are checked by a person before anything is sent.',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.allocation.decidedBy).toBe('PERSON');
    expect(outcome.allocation.necessityReason).toBe('OVERSIGHT_VERIFICATION');
  });
});

describe('the declaration is validated once, for both doors', () => {
  it('refuses a subject with no finding, and a finding with no subject', () => {
    const orphanSubject = validateLabor({
      where: 'claims[0]',
      finding: null,
      subject: 'OFFSHORE_CONTRACTOR',
      qualifier: null,
      rateCents: null,
    });
    expect(orphanSubject.ok).toBe(false);

    const orphanFinding = validateLabor({
      where: 'claims[0]',
      finding: 'SOURCING_CHANNEL',
      subject: null,
      qualifier: null,
      rateCents: null,
    });
    expect(orphanFinding.ok).toBe(false);
  });

  it('refuses a subject outside the kind’s own vocabulary', () => {
    const wrongSet = validateLabor({
      where: 'claims[0]',
      finding: 'HUMAN_REQUIREMENT',
      // A real channel, in the wrong field. The two closed sets are separate
      // on purpose, and a validator checking "is it in either" would accept
      // this.
      subject: 'OFFSHORE_CONTRACTOR',
      qualifier: null,
      rateCents: null,
    });
    expect(wrongSet.ok).toBe(false);
  });

  it('refuses a rate with no basis, and a basis with no rate', () => {
    const noBasis = validateLabor({
      where: 'claims[0]',
      finding: 'SOURCING_CHANNEL',
      subject: 'AGENCY_OR_VENDOR',
      qualifier: null,
      rateCents: 4000,
    });
    expect(noBasis.ok).toBe(false);

    const noRate = validateLabor({
      where: 'claims[0]',
      finding: 'SOURCING_CHANNEL',
      subject: 'AGENCY_OR_VENDOR',
      qualifier: 'PER_HOUR',
      rateCents: null,
    });
    expect(noRate.ok).toBe(false);
  });

  it('accepts a channel with no published rate, which is the common case', () => {
    const parsed = validateLabor({
      where: 'claims[0]',
      finding: 'SOURCING_CHANNEL',
      subject: 'SPECIALIST_FREELANCER',
      qualifier: null,
      rateCents: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.value.rateCents).toBeNull();
  });

  it('refuses a rate on a finding that carries none', () => {
    const parsed = validateLabor({
      where: 'claims[0]',
      finding: 'HUMAN_REQUIREMENT',
      subject: 'ACCOUNTABILITY_LICENSING',
      qualifier: 'PER_HOUR',
      rateCents: 900,
    });
    expect(parsed.ok).toBe(false);
  });

  /**
   * One rule, two readers — asserted by reading the repository.
   *
   * `tests/operatorConsoleRemoved.test.ts` and the industry kernel's own suite
   * read the source for the same reason: a second *implementation* of this
   * rule would agree on the day it was written, and this repository has had to
   * record that lesson five times.
   */
  it('is called by both the provider door and the wire door, and implemented in neither', () => {
    const provider = readFileSync('server/services/research/schema.ts', 'utf8');
    const wire = readFileSync('server/mcp/researchTools.ts', 'utf8');
    expect(provider).toContain('validateLabor(');
    expect(wire).toContain('validateLabor(');
    // Neither door may hold the vocabulary itself.
    expect(provider).not.toContain('SOURCING_CHANNEL');
    expect(wire).not.toContain("'HUMAN_REQUIREMENT'");
  });

  /**
   * §33's defect, refused one axis along.
   *
   * A field a tool's prose names and its schema omits is dropped by every
   * client honouring `additionalProperties: false`, and the failure reads
   * exactly like a worker honestly finding nothing.
   */
  it('declares every labor field it asks a worker for', () => {
    const wire = readFileSync('server/mcp/researchTools.ts', 'utf8');
    for (const field of ['labor_finding', 'labor_subject', 'labor_qualifier', 'labor_rate_cents']) {
      expect(wire).toContain(`${field}: {`);
    }
  });
});

describe('what can be derived is never stored', () => {
  it('has no basis meaning a derived answer', () => {
    // Structural rather than remembered: there is nowhere to put one, so
    // nothing can accidentally put one there.
    expect([...NECESSITY_BASES]).toEqual(['RESEARCHED', 'PERSON']);
  });

  it('has no storable question for the two Brain reads from its own rows', () => {
    expect([...NECESSITY_QUESTIONS]).not.toContain('BRAIN_CAN_PRODUCE');
    expect([...NECESSITY_QUESTIONS]).not.toContain('INDEPENDENT_VERIFICATION_AVAILABLE');
  });

  it('re-reads the capability rather than remembering it', async () => {
    await healthyFleet();
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    const present = await assess(task, true);
    expect(present.capability?.state).toBe('PRESENT');
    // Nothing was written by reading it.
    expect(await listNecessityAnswers(projectId)).toEqual([]);
  });
});

describe('history is never overwritten', () => {
  it('supersedes rather than replaces, and the chain is what says a role was compressed', async () => {
    await healthyFleet();
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });

    const first = await assignByPerson({
      projectId,
      task,
      productionLayer: 'OFFSHORE_HUMAN',
      necessityReason: 'EXCEPTION_HANDLING',
      rationale: 'A person triages anything the model is unsure about.',
      actorRef: userId,
    });
    expect(first.ok).toBe(true);

    await answerEverythingForBrain(task.id);
    const reading = await assess(task, true);
    const second = await assignByBrain({ projectId, task, reading });
    expect(second.ok).toBe(true);

    const all = await listAllocations(projectId);
    expect(all).toHaveLength(2);
    expect(all.filter((one) => one.supersededAt === null)).toHaveLength(1);

    const view = await laborView(projectId);
    expect(view.roleCompression).toHaveLength(1);
    expect(view.roleCompression[0]!.direction).toBe('COMPRESSED');
    expect(view.roleCompression[0]!.from).toBe('OFFSHORE_HUMAN');
    expect(view.roleCompression[0]!.to).toBe('BRAIN');
    // What the role had existed for, which current state cannot answer.
    expect(view.roleCompression[0]!.wasFor).toBe('EXCEPTION_HANDLING');
  });

  it('reports a task going back to a person rather than filtering it out', async () => {
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'BRAIN',
      necessityReason: null,
      rationale: 'Taken by Brain.',
      actorRef: userId,
    });
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'SPECIALIST_PROFESSIONAL',
      necessityReason: 'ACCOUNTABILITY_LICENSING',
      rationale: 'The buyer requires a signature.',
      actorRef: userId,
    });

    const view = await laborView(projectId);
    expect(view.roleCompression.map((one) => one.direction)).toEqual(['ESCALATED']);
  });

  /**
   * The chain is followed, never sorted, and this forces the collision that
   * showed it.
   *
   * §33 records the same defect one module along: these timestamps are
   * ISO-8601 to the millisecond, two decisions in one millisecond compare
   * equal, and the tie fell through to a generated id — so half the time
   * `roleCompression` reported that a person had been replaced by Brain when
   * the opposite had happened. The timestamps are forced equal here rather
   * than raced for, because a test that hoped for the collision would be the
   * same flake wearing a hat.
   */
  it('reads the order from the chain rather than from the clock', async () => {
    const task = await seededTask();
    const first = await recordAllocation({
      projectId,
      taskId: task.id,
      productionLayer: 'BRAIN',
      necessityReason: null,
      decidedBy: 'PERSON',
      decidedByRef: userId,
      rationale: 'Brain took it.',
      expectedCurrentId: null,
    });
    const second = await recordAllocation({
      projectId,
      taskId: task.id,
      productionLayer: 'PHYSICAL_OPERATOR',
      necessityReason: 'PHYSICAL_EXECUTION',
      decidedBy: 'PERSON',
      decidedByRef: userId,
      rationale: 'It turned out to need somebody on site.',
      expectedCurrentId: first!.id,
    });

    /*
     * Put the clock backwards, which is the condition "follow the chain"
     * defends against and is the only way to make this deterministic.
     *
     * Equalizing the timestamps was the first version and left the old sorted
     * implementation tie-breaking on a *generated id* — so it failed three
     * times in eight rather than every time, and a regression test that
     * catches a defect half the time lets it back in half the time. With the
     * timestamps inverted the two implementations disagree on every run.
     */
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run('UPDATE labor_allocations SET created_at = ? WHERE id = ?', [
      '2026-09-20T10:00:02.000Z',
      first!.id,
    ]);
    await getDb().run('UPDATE labor_allocations SET created_at = ? WHERE id = ?', [
      '2026-09-20T10:00:01.000Z',
      second!.id,
    ]);

    const view = await laborView(projectId);
    expect(view.roleCompression).toHaveLength(1);
    expect(view.roleCompression[0]!.direction).toBe('ESCALATED');
    expect(view.roleCompression[0]!.from).toBe('BRAIN');
    expect(view.roleCompression[0]!.to).toBe('PHYSICAL_OPERATOR');
  });

  /**
   * The same rule, deterministically, because the one above is not.
   *
   * Ids are random, so the old sorted implementation got the order right
   * roughly half the time — measured at 3 failures in 8 runs. A regression
   * test that catches a defect half the time is one that lets it back in half
   * the time, so the property is also asserted against hand-built rows whose
   * ids and timestamps both point the wrong way. Nothing here can get lucky.
   */
  it('follows the chain even when both the clock and the ids disagree with it', () => {
    const base = {
      projectId: 'prj_x',
      taskId: 'ltk_x',
      necessityReason: null,
      decidedBy: 'PERSON' as const,
      decidedByRef: 'usr_x',
      supersededAt: null,
      // Identical to the millisecond, which is what the clock can actually do.
      createdAt: '2026-09-20T10:00:00.000Z',
    };
    const root = { ...base, id: 'lal_zzz', productionLayer: 'BRAIN' as const, rationale: 'first', supersedesId: null, supersededAt: '2026-09-20T10:00:00.000Z' };
    const next = { ...base, id: 'lal_aaa', productionLayer: 'PHYSICAL_OPERATOR' as const, necessityReason: 'PHYSICAL_EXECUTION' as const, rationale: 'second', supersedesId: 'lal_zzz' };

    // Handed in the order `listAllocations` would produce: id ascending.
    expect(chainOf([next, root]).map((one) => one.id)).toEqual(['lal_zzz', 'lal_aaa']);
  });

  it('keeps a row no link reaches rather than dropping it from the history', () => {
    const base = {
      projectId: 'prj_x',
      taskId: 'ltk_x',
      necessityReason: null,
      decidedBy: 'PERSON' as const,
      decidedByRef: 'usr_x',
      supersededAt: null,
      createdAt: '2026-09-20T10:00:00.000Z',
    };
    const root = { ...base, id: 'lal_1', productionLayer: 'BRAIN' as const, rationale: 'first', supersedesId: null };
    // Points at something that is not here. A history that silently lost it
    // would be worse than one out of order.
    const orphan = { ...base, id: 'lal_2', productionLayer: 'DOMESTIC_HUMAN' as const, necessityReason: 'HUMAN_INTERFACE' as const, rationale: 'orphan', supersedesId: 'lal_gone' };

    expect(chainOf([root, orphan]).map((one) => one.id)).toEqual(['lal_1', 'lal_2']);
  });

  it('writes no row when the decision says what the live one already says', async () => {
    const task = await seededTask();
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      rationale: 'The buyer wants to talk to somebody.',
      actorRef: userId,
    });
    const again = await assignByPerson({
      projectId,
      task,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      rationale: 'Saying it a second time.',
      actorRef: userId,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.changed).toBe(false);
    expect(await listAllocations(projectId)).toHaveLength(1);
  });

  it('refuses a decision made against an allocation that has since moved', async () => {
    const task = await seededTask();
    const first = await recordAllocation({
      projectId,
      taskId: task.id,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      decidedBy: 'PERSON',
      decidedByRef: userId,
      rationale: 'First.',
      expectedCurrentId: null,
    });
    expect(first).not.toBeNull();

    const second = await recordAllocation({
      projectId,
      taskId: task.id,
      productionLayer: 'BRAIN',
      necessityReason: null,
      decidedBy: 'PERSON',
      decidedByRef: userId,
      rationale: 'Second.',
      expectedCurrentId: first!.id,
    });
    expect(second).not.toBeNull();

    // A third caller still holding the first allocation's id loses the swap —
    // which is the whole exclusion, and an ordinary outcome rather than an
    // error.
    const stale = await recordAllocation({
      projectId,
      taskId: task.id,
      productionLayer: 'OFFSHORE_HUMAN',
      necessityReason: 'EXCEPTION_HANDLING',
      decidedBy: 'PERSON',
      decidedByRef: userId,
      rationale: 'Deciding against a row that has moved.',
      expectedCurrentId: first!.id,
    });
    expect(stale).toBeNull();
    expect(await listAllocations(projectId)).toHaveLength(2);
  });

  it('keeps everything when a workflow is retired', async () => {
    const task = await seededTask();
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      rationale: 'A person calls them.',
      actorRef: userId,
    });

    const retired = await retire({
      projectId,
      what: 'WORKFLOW',
      id: task.workflowId,
      reason: 'We stopped selling this.',
      actorRef: userId,
    });
    expect(retired?.retired).toBe(true);

    // Gone from the reading, still in the rows.
    const snapshot = await laborSnapshot(projectId);
    expect(snapshot.coverage).toHaveLength(0);
    expect(await listTasks(projectId)).toHaveLength(1);
    expect(await listAllocations(projectId)).toHaveLength(1);
  });
});

describe('the map derives itself from the portfolio', () => {
  async function activatedWithOpening(capabilities: string[], state: 'READY' | 'DISCOVERED' = 'READY') {
    const outcome = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(outcome.ok).toBe(true);
    const mode = await getCashMode(projectId);
    const opportunity = await createOpportunity({
      projectId,
      cashModeId: mode!.id,
      ownerUserId: userId,
      title: 'A studio published an overflow transcription request',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: mode!.currency,
      requiredCapabilities: capabilities,
    });
    if (state !== 'DISCOVERED') {
      await transitionOpportunity({ id: opportunity.id, from: ['DISCOVERED'], to: 'EVIDENCE_CARD' });
      await transitionOpportunity({ id: opportunity.id, from: ['EVIDENCE_CARD'], to: 'READY' });
    }
    return opportunity;
  }

  it('makes one workflow per opening and one task per declared capability', async () => {
    await activatedWithOpening(['RESEARCH_A_QUESTION', 'SEND_A_MESSAGE']);

    const derived = await deriveFromPortfolio(projectId);
    expect(derived.workflows).toHaveLength(1);
    expect(derived.tasks).toHaveLength(2);
    expect(derived.tasks.map((one) => one.name).sort()).toEqual([
      'RESEARCH_A_QUESTION',
      'SEND_A_MESSAGE',
    ]);
    // Question 1, answered from the capability's own declaration rather than
    // invented from the opening.
    for (const task of derived.tasks) expect(task.output.length).toBeGreaterThan(0);
  });

  it('is idempotent, so a second tick adds nothing', async () => {
    await activatedWithOpening(['RESEARCH_A_QUESTION']);
    await deriveFromPortfolio(projectId);
    const second = await deriveFromPortfolio(projectId);
    expect(second.workflows).toHaveLength(0);
    expect(second.tasks).toHaveLength(0);
    expect(await listWorkflows(projectId)).toHaveLength(1);
    expect(await listTasks(projectId)).toHaveLength(1);
  });

  it('reports a capability Brain has no word for rather than filing a task for it', async () => {
    await activatedWithOpening(['RESEARCH_A_QUESTION', 'FOLD_THE_LAUNDRY']);
    const derived = await deriveFromPortfolio(projectId);
    expect(derived.tasks).toHaveLength(1);
    expect(derived.unrecognized.map((one) => one.capabilityId)).toEqual(['FOLD_THE_LAUNDRY']);
  });

  /**
   * The defect found by re-reading the diff rather than by a failing test.
   *
   * `labor_workflows` has two unique indexes over a derived row, and the
   * insert can lose on the *name* one. Reading the fallback row as a success
   * put this opening's tasks into a workflow a person had written — Brain
   * deciding the two were the same thing, which is §25's confidently-derived
   * wrong answer at a foreign key.
   */
  it('reports a name already held by somebody’s own workflow rather than adopting it', async () => {
    const opportunity = await activatedWithOpening(['RESEARCH_A_QUESTION']);

    // A person declares a workflow under exactly the name the derivation would
    // choose, attached to nothing.
    const mine = await declareWorkflow({
      projectId,
      name: workflowNameFor(opportunity),
      description: null,
      opportunityId: null,
      actorRef: userId,
    });
    expect(mine.created).toBe(true);

    const derived = await deriveFromPortfolio(projectId);
    expect(derived.workflows).toHaveLength(0);
    expect(derived.tasks).toHaveLength(0);
    expect(derived.collided).toHaveLength(1);
    expect(derived.collided[0]!.opportunityId).toBe(opportunity.id);
    // Nothing was written into the person's workflow.
    expect(await listTasks(projectId)).toHaveLength(0);
  });

  it('leaves an unqualified opening alone', async () => {
    await activatedWithOpening(['RESEARCH_A_QUESTION'], 'DISCOVERED');
    const derived = await deriveFromPortfolio(projectId);
    expect(derived.workflows).toHaveLength(0);
    expect(derived.tasks).toHaveLength(0);
  });

  it('adds nothing to a workflow somebody retired', async () => {
    const opportunity = await activatedWithOpening(['RESEARCH_A_QUESTION']);
    await deriveFromPortfolio(projectId);
    const [workflow] = await listWorkflows(projectId);
    await retire({
      projectId,
      what: 'WORKFLOW',
      id: workflow!.id,
      reason: 'We are not delivering this ourselves.',
      actorRef: userId,
    });

    // The opening now declares a second capability, through the same service a
    // person's card edit goes through. A tick that kept adding would be
    // overruling the retirement once per capability.
    const { fillCard } = await import('../server/services/cash/opportunities.ts');
    const filled = await fillCard({
      opportunityId: opportunity.id,
      actorRef: userId,
      patch: { requiredCapabilities: ['RESEARCH_A_QUESTION', 'SEND_A_MESSAGE'] },
    });
    expect(filled.ok).toBe(true);

    const derived = await deriveFromPortfolio(projectId);
    expect(derived.tasks).toHaveLength(0);
    expect(await listTasks(projectId)).toHaveLength(1);
  });
});

describe('what it asks, and what stops it asking', () => {
  it('asks first about work a person is doing today', async () => {
    const human = await seededTask({ name: 'Call the buyer' });
    await assignByPerson({
      projectId,
      task: human,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      rationale: 'Somebody rings them.',
      actorRef: userId,
    });
    await seededTask({ name: 'Nobody has decided this one' });

    const snapshot = await laborSnapshot(projectId);
    const planned = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS });

    expect(planned.asks.length).toBeGreaterThan(0);
    const first = planned.asks[0]!;
    expect(first.taskId).toBe(human.id);
    expect(first.purpose).toBe('NECESSITY');
  });

  it('asks where a necessary person could be sourced, once the reason is established', async () => {
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await recordNecessityAnswer({
      projectId,
      taskId: task.id,
      question: 'REQUIRES_LICENSED_HUMAN',
      answer: 'YES',
      basis: 'PERSON',
      statement: 'The board requires a licensed signatory.',
      answeredByRef: userId,
    });
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'SPECIALIST_PROFESSIONAL',
      necessityReason: 'ACCOUNTABILITY_LICENSING',
      rationale: 'Established by the board’s own rule.',
      actorRef: userId,
    });

    const snapshot = await laborSnapshot(projectId);
    const planned = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS });
    expect(planned.asks.map((one) => one.purpose)).toContain('MARKET');
  });

  it('opens nothing where nothing may be spent, and says so', async () => {
    await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    // No standing research authority on this project.
    const pass = await runLaborKernel(projectId);
    expect(pass.opened).toEqual([]);
    expect(pass.declined.length).toBeGreaterThan(0);
    expect(await listLaborRounds(projectId)).toEqual([]);
  });

  it('re-running the tick repeats nothing, and settles', async () => {
    /*
     * The whole pass, run to a fixed point, with a real standing authority so
     * it actually reaches `openAsks` — which is the half a derivation-only
     * idempotency test cannot see, and the half that spends money.
     *
     * **The property is convergence rather than a no-op on the second pass**,
     * and that distinction is worth stating because the first version of this
     * test asserted the wrong one and failed. A pass fills the free slots under
     * `MAX_OPEN_LABOR_ROUNDS` and the allocator asks one purpose per task at a
     * time, so pass two legitimately opens the *next* question rather than
     * repeating the first. That is the kernel working. What would be the defect
     * is asking anything twice, or re-deriving a task, or rewriting a decision
     * that already says what the live one says — so those are what is asserted,
     * across every pass, and then that a further pass moves no row at all.
     */
    await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Labor kernel',
      allowedWork: ['RESEARCH'],
      maxMissions: 8,
      maxFragments: 8,
      maxConcurrent: 8,
      maxProbes: 8,
    });
    await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });

    const asked = new Set<string>();
    let passes = 0;
    for (; passes < 8; passes += 1) {
      const pass = await runLaborKernel(projectId);
      for (const one of pass.opened) {
        const key = `${one.taskId}/${one.purpose}/${one.round}`;
        // Nothing is ever asked twice, on any pass.
        expect(asked.has(key)).toBe(false);
        asked.add(key);
      }
      // A task is derived once, and a settled decision is never rewritten.
      if (passes > 0) {
        expect(pass.derived.tasks).toEqual([]);
        expect(pass.decided).toEqual([]);
      }
      if (pass.opened.length === 0) break;
    }

    // It stopped by itself rather than by running out of iterations, and it
    // stopped at the ceiling rather than somewhere arbitrary.
    expect(passes).toBeLessThan(8);
    expect(asked.size).toBeGreaterThan(0);
    const open = (await listLaborRounds(projectId)).filter((one) => one.state === 'OPEN');
    expect(open.length).toBeLessThanOrEqual(MAX_OPEN_LABOR_ROUNDS);

    const rounds = await listLaborRounds(projectId);
    const candidates = await listCandidates({ projectId, limit: 500 });
    const tasks = await listTasks(projectId);
    const allocations = await listAllocations(projectId);

    const again = await runLaborKernel(projectId);
    expect(again.opened).toEqual([]);

    // Every row, by id, rather than by count: a count is satisfied by one row
    // being replaced with another.
    expect((await listLaborRounds(projectId)).map((one) => one.id).sort()).toEqual(
      rounds.map((one) => one.id).sort(),
    );
    expect((await listCandidates({ projectId, limit: 500 })).map((one) => one.id).sort()).toEqual(
      candidates.map((one) => one.id).sort(),
    );
    expect((await listTasks(projectId)).map((one) => one.id).sort()).toEqual(
      tasks.map((one) => one.id).sort(),
    );
    expect((await listAllocations(projectId)).map((one) => one.id).sort()).toEqual(
      allocations.map((one) => one.id).sort(),
    );
  });

  it('is bounded by concurrency rather than by a lifetime count', () => {
    const source = readFileSync('server/services/labor/allocate.ts', 'utf8');
    expect(source).toContain('MAX_OPEN_LABOR_ROUNDS');
    // A ceiling on how many questions may ever be asked is exactly the number
    // §24 removed from the standing authority, and none exists here.
    expect(source).not.toMatch(/MAX_(TOTAL|LIFETIME)_/);
  });
});

describe('absorbing is a lookup, never a reading', () => {
  async function openOneRound(): Promise<{ task: LaborTask; candidateId: string }> {
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      rationale: 'Somebody does this today.',
      actorRef: userId,
    });
    const { openAsks } = await import('../server/services/labor/expand.ts');
    const snapshot = await laborSnapshot(projectId);
    const planned = allocate({ snapshot, slots: 1 });
    const opened = await openAsks({ projectId, asks: planned.asks, snapshot });
    expect(opened).toHaveLength(1);
    return { task, candidateId: opened[0]!.candidateId };
  }

  /**
   * Open the precedent question and leave it open.
   *
   * Rules 1 to 4 each `continue`, so at most one question per task is offered
   * per pass and rule 4 outranks the re-ask in rule 5. Getting to rule 5 at all
   * therefore means the precedent question has already been asked — which is
   * the allocator behaving exactly as designed, and a fact about these two
   * tests rather than about what they are testing.
   */
  async function parkThePrecedentQuestion(): Promise<void> {
    const { openAsks } = await import('../server/services/labor/expand.ts');
    const snapshot = await laborSnapshot(projectId);
    const precedent = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS }).asks.filter(
      (one) => one.purpose === 'PRECEDENT',
    );
    expect(precedent).toHaveLength(1);
    await openAsks({ projectId, asks: precedent, snapshot });
  }

  it('turns a declared requirement into the question it answers, and nothing else', async () => {
    const { task, candidateId } = await openOneRound();
    await finishedRound({
      candidateId,
      claims: [
        {
          claim: 'Only a licensed notary may certify this document.',
          finding: 'HUMAN_REQUIREMENT',
          subject: 'ACCOUNTABILITY_LICENSING',
        },
      ],
    });

    const { absorb } = await import('../server/services/labor/expand.ts');
    const absorbed = await absorb({ projectId });

    expect(absorbed.answers).toHaveLength(1);
    expect(absorbed.answers[0]!.question).toBe('REQUIRES_LICENSED_HUMAN');
    expect(absorbed.answers[0]!.answer).toBe('YES');
    expect(absorbed.answers[0]!.basis).toBe('RESEARCHED');
    expect(absorbed.answers[0]!.sourceClaimId).not.toBeNull();

    const reading = await assess(task, true);
    expect(reading.verdict).toBe('HUMAN_REQUIRED');
    expect(reading.reason).toBe('ACCOUNTABILITY_LICENSING');
  });

  /**
   * Three of the six reasons answer nothing, and that is a refusal rather
   * than a gap.
   *
   * A trade body can tell you a notary must sign. It cannot tell you whether
   * *this* Brain verifies its own output well enough, and a finding that moved
   * that question would be a published source deciding something it has no
   * standing to decide.
   */
  it('refuses to move a question no published source can settle', async () => {
    const { candidateId } = await openOneRound();
    await finishedRound({
      candidateId,
      claims: [
        {
          claim: 'Practitioners report that experienced judgement matters here.',
          finding: 'HUMAN_REQUIREMENT',
          subject: 'EXPERT_JUDGMENT',
        },
      ],
    });

    const { absorb } = await import('../server/services/labor/expand.ts');
    const absorbed = await absorb({ projectId });
    expect(absorbed.answers).toEqual([]);
    expect(absorbed.refused).toHaveLength(1);
    expect(questionAnsweredBy('EXPERT_JUDGMENT')).toBeNull();
  });

  it('files a sourcing option with its rate and basis, and one without', async () => {
    const { candidateId } = await openOneRound();
    await finishedRound({
      candidateId,
      claims: [
        {
          claim: 'An agency publishes a rate of 40.00 an hour for this work.',
          finding: 'SOURCING_CHANNEL',
          subject: 'AGENCY_OR_VENDOR',
          qualifier: 'PER_HOUR',
          rateCents: 4000,
        },
        {
          claim: 'A marketplace lists freelancers doing this, with no published rate.',
          finding: 'SOURCING_CHANNEL',
          subject: 'SPECIALIST_FREELANCER',
        },
      ],
    });

    const { absorb } = await import('../server/services/labor/expand.ts');
    await absorb({ projectId });

    const options = await listMarketOptions(projectId);
    expect(options).toHaveLength(2);
    const priced = options.find((one) => one.channel === 'AGENCY_OR_VENDOR');
    expect(priced?.rateCents).toBe(4000);
    expect(priced?.rateBasis).toBe('PER_HOUR');
    const unpriced = options.find((one) => one.channel === 'SPECIALIST_FREELANCER');
    // Unknown, never zero: a blank read as free would make the option nobody
    // had costed look like the best one.
    expect(unpriced?.rateCents).toBeNull();
    expect(unpriced?.rateBasis).toBeNull();
  });

  it('settles a round whose mission failed, so the question can be asked again', async () => {
    const { candidateId } = await openOneRound();
    await finishedRound({ candidateId, claims: [], missionEndsAs: 'FAILED' });

    const { absorb } = await import('../server/services/labor/expand.ts');
    const absorbed = await absorb({ projectId });
    expect(absorbed.settled).toHaveLength(1);

    const rounds = await listLaborRounds(projectId);
    expect(rounds[0]!.state).toBe('ABANDONED');
    // Not counted yet is a different fact from none found, and a settled round
    // has to say which.
    expect(rounds[0]!.found).toBe(0);
  });

  /**
   * The half the test above claims in its title and did not reach.
   *
   * "So the question can be asked again" is the whole point of settling an
   * abandoned round, and nothing asserted that the allocator would. It would
   * not: `roundsByPurpose` counts every settled round, abandoned ones included,
   * so three missions that never ran retired the question for ever — and the
   * decline recorded the reason as "nothing published has answered it. Brain
   * has documented that there is nothing there", which is a statement about the
   * world Brain had made no observation of.
   *
   * This drives three real abandonments through `absorb` and asserts the fourth
   * ask happens. It fails against the pre-fix allocator on the ask, and on the
   * sentence.
   */
  it('re-asks a question three abandoned missions never got to, and never claims they answered it', async () => {
    const { task } = await openOneRound();
    await parkThePrecedentQuestion();

    // Three rounds that were opened and whose missions died. Round 1 is the one
    // `openOneRound` opened; 2 and 3 are opened the same way, through the
    // allocator, after each abandonment.
    for (let n = 1; n <= 3; n += 1) {
      const live = (await listLaborRounds(projectId)).find(
        (one) => one.state === 'OPEN' && one.purpose === 'NECESSITY',
      );
      expect(live?.round).toBe(n);
      await finishedRound({ candidateId: live!.candidateId, claims: [], missionEndsAs: 'FAILED' });
      const { absorb, openAsks } = await import('../server/services/labor/expand.ts');
      await absorb({ projectId });

      if (n === 3) break;
      // Past the cool-off, which is a separate bound and not what is under test.
      const at = new Date(Date.now() + n * 2 * ROUND_COOL_OFF_MS).toISOString();
      const snapshot = await laborSnapshot(projectId, at);
      // Only the necessity re-ask: the allocator legitimately offers a
      // precedent round beside it, and opening that would change what is under
      // test rather than break it.
      const planned = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS });
      const next = planned.asks.filter((one) => one.purpose === 'NECESSITY');
      expect(next).toHaveLength(1);
      await openAsks({ projectId, asks: next, snapshot });
    }

    const necessity = (await listLaborRounds(projectId)).filter(
      (one) => one.purpose === 'NECESSITY',
    );
    expect(necessity).toHaveLength(3);
    expect(necessity.every((one) => one.state === 'ABANDONED')).toBe(true);

    const at = new Date(Date.now() + 8 * ROUND_COOL_OFF_MS).toISOString();
    const snapshot = await laborSnapshot(projectId, at);
    const coverage = snapshot.coverage.find((one) => one.task.id === task.id);

    // The two counts are kept apart: three settled, none of which looked.
    expect(coverage?.roundsByPurpose.NECESSITY).toBe(3);
    expect(coverage?.harvestedByPurpose.NECESSITY).toBe(0);

    const planned = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS });
    const again = planned.asks.find((one) => one.purpose === 'NECESSITY');
    expect(again).toBeDefined();
    // Numbered from the settled count, so it cannot collide with round 3.
    expect(again?.round).toBe(4);

    // And nothing anywhere says Brain looked.
    for (const one of planned.declined) {
      expect(one.why).not.toContain('nothing there');
    }
  });

  /**
   * The other direction, so the bound still exists. Three rounds that actually
   * ran and found nothing do retire the question — otherwise this fix would
   * have removed the barren rule rather than corrected what it counts.
   */
  it('still stops after three rounds that ran and found nothing', async () => {
    const { task } = await openOneRound();
    await parkThePrecedentQuestion();

    for (let n = 1; n <= 3; n += 1) {
      const live = (await listLaborRounds(projectId)).find(
        (one) => one.state === 'OPEN' && one.purpose === 'NECESSITY',
      );
      expect(live?.round).toBe(n);
      await finishedRound({ candidateId: live!.candidateId, claims: [] });
      const { absorb, openAsks } = await import('../server/services/labor/expand.ts');
      await absorb({ projectId });

      if (n === 3) break;
      const at = new Date(Date.now() + n * 2 * ROUND_COOL_OFF_MS).toISOString();
      const snapshot = await laborSnapshot(projectId, at);
      // Only the necessity re-ask: the allocator legitimately offers a
      // precedent round beside it, and opening that would change what is under
      // test rather than break it.
      const planned = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS });
      const next = planned.asks.filter((one) => one.purpose === 'NECESSITY');
      expect(next).toHaveLength(1);
      await openAsks({ projectId, asks: next, snapshot });
    }

    const at = new Date(Date.now() + 8 * ROUND_COOL_OFF_MS).toISOString();
    const snapshot = await laborSnapshot(projectId, at);
    const coverage = snapshot.coverage.find((one) => one.task.id === task.id);
    expect(coverage?.harvestedByPurpose.NECESSITY).toBe(3);

    const planned = allocate({ snapshot, slots: MAX_OPEN_LABOR_ROUNDS });
    expect(planned.asks.some((one) => one.purpose === 'NECESSITY')).toBe(false);
    expect(planned.declined.some((one) => one.why.includes('nothing there'))).toBe(true);
  });
});

describe('every figure is counted or it is unknown', () => {
  it('reports the four it cannot measure as UNKNOWN with no value', async () => {
    const task = await seededTask({ capabilityId: 'RESEARCH_A_QUESTION' });
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'DOMESTIC_HUMAN',
      necessityReason: 'HUMAN_INTERFACE',
      rationale: 'Somebody rings them.',
      actorRef: userId,
    });

    const view = await laborView(projectId);
    for (const key of ['costPerOutput', 'timePerOutput', 'errorRate', 'humanHours']) {
      const figure = view.measurements.find((one) => one.key === key);
      expect(figure, key).toBeDefined();
      expect(figure!.evidence).toBe('UNKNOWN');
      expect(figure!.value).toBeNull();
      // Named rather than omitted: an absent line reads as nothing to say.
      expect(figure!.note.length).toBeGreaterThan(0);
    }
  });

  it('names the denominator on every share it does count', async () => {
    await seededTask();
    const view = await laborView(projectId);
    const counted = view.measurements.filter(
      (one) => one.evidence === 'MEASURED' && one.key !== 'tasks',
    );
    expect(counted.length).toBeGreaterThan(0);
    for (const figure of counted) {
      expect(figure.denominator, figure.key).not.toBeNull();
    }
  });

  it('counts a task nobody has decided as neither automated nor human', async () => {
    const decided = await seededTask({ name: 'Decided' });
    await assignByPerson({
      projectId,
      task: decided,
      productionLayer: 'BRAIN',
      necessityReason: null,
      rationale: 'Brain does this.',
      actorRef: userId,
    });
    await seededTask({ name: 'Undecided' });

    const view = await laborView(projectId);
    const machine = view.measurements.find((one) => one.key === 'machineTasks');
    const human = view.measurements.find((one) => one.key === 'humanTasks');
    const allocated = view.measurements.find((one) => one.key === 'allocated');
    expect(machine!.value).toBe(1);
    expect(human!.value).toBe(0);
    expect(allocated!.value).toBe(1);
    expect(view.tasks).toBe(2);

    // And a workflow with one Brain task and one nobody has looked at is not
    // fully automated.
    for (const workflow of view.economics) {
      if (workflow.undecided > 0) expect(workflow.fullyAutomated).toBe(false);
    }
  });

  /**
   * Asserted over the values rather than over the source, after a first
   * version of this that grepped for the word and failed on the comment
   * explaining why there is no percentage.
   *
   * A grep is the wrong instrument here anyway: what must not exist is a
   * *figure* that was computed rather than counted, and the property that says
   * so is that every MEASURED value is a whole number of rows.
   */
  it('never reports a computed share, only whole counts', async () => {
    const task = await seededTask();
    await assignByPerson({
      projectId,
      task,
      productionLayer: 'BRAIN',
      necessityReason: null,
      rationale: 'Brain does this.',
      actorRef: userId,
    });

    const view = await laborView(projectId);
    for (const figure of view.measurements) {
      if (figure.evidence !== 'MEASURED') continue;
      expect(figure.value, figure.key).not.toBeNull();
      expect(Number.isInteger(figure.value), figure.key).toBe(true);
      expect(figure.value! >= 0, figure.key).toBe(true);
    }
    expect(readFileSync('server/services/labor/view.ts', 'utf8')).not.toMatch(/\* *100\b/);
  });
});

describe('the envelope authorizes reading and never engaging', () => {
  it('exists, with a compiler profile, and forbids hiring and contacting by name', () => {
    const envelope = getApprovalEnvelope('RUSSELL_LABOR_ALLOCATION_V1');
    expect(envelope).not.toBeNull();
    expect(profileFor('RUSSELL_LABOR_ALLOCATION_V1')?.id).toBe('LABOR_ALLOCATION');

    for (const phrase of ['hire', 'engage a contractor', 'contact the']) {
      expect(envelope!.forbiddenActions.test(phrase)).toBe(true);
    }
    expect(envelope!.assignmentTemplate).toMatch(/contacting any person or organisation/i);
    expect(envelope!.authorization).toMatch(/never engaging any/i);
  });

  it('is chosen by the round rather than by anything a caller sends', () => {
    const source = readFileSync('server/services/russell/compiler.ts', 'utf8');
    // Read from `labor_rounds` — a row Brain wrote — and from nothing else.
    expect(source).toContain('laborRoundForCandidate(candidate.id)');
  });

  it('asks for an established absence as a finding in its own right', () => {
    const profile = profileFor('RUSSELL_LABOR_ALLOCATION_V1');
    const permission = profile!.lanes.find((one) => one.id === 'permission');
    expect(permission?.description).toMatch(/established absence/i);
    expect(profile!.completionCriteria('this market').join(' ')).toMatch(/documented search/i);
  });
});

describe('the door', () => {
  it('has no labor policy module', () => {
    const policy = readFileSync('server/services/identity/policy.ts', 'utf8');
    expect(policy).toContain('/labor\\/');
    const routes = readFileSync('server/routes/labor.ts', 'utf8');
    // Every decision is in `services/labor/`; the route resolves the project
    // and hands over the principal.
    expect(routes).toContain('requirePerson()');
    expect(routes).toContain('requireProject(');
    /*
     * It must not reach the policy module itself.
     *
     * Asserted on the imports rather than on the whole file, after a first
     * version of this failed on the doc comment that explains `requireProject`
     * *is* `decideProjectAccess`. A grep that cannot tell a call from a
     * sentence about one is the cried-wolf warning §27 records.
     */
    const imports = routes.slice(0, routes.indexOf('export const laborRouter'));
    expect(imports).not.toContain("from '../services/identity/policy.ts'");
  });

  it('refuses a person by type at every write and at the read', () => {
    const routes = readFileSync('server/routes/labor.ts', 'utf8');
    const handlers = routes.split('handler(async').length - 1;
    const guards = routes.split('requirePerson()').length - 1;
    expect(handlers).toBeGreaterThan(0);
    expect(guards).toBe(handlers);
  });
});

describe('a layer is a person, or it is not', () => {
  it('splits the seven exactly where the schema does', () => {
    expect(layerIsHuman('BRAIN')).toBe(false);
    expect(layerIsHuman('SOFTWARE_TOOL')).toBe(false);
    expect(layerIsHuman('EXTERNAL_SERVICE')).toBe(false);
    expect(layerIsHuman('OFFSHORE_HUMAN')).toBe(true);
    expect(layerIsHuman('DOMESTIC_HUMAN')).toBe(true);
    expect(layerIsHuman('SPECIALIST_PROFESSIONAL')).toBe(true);
    expect(layerIsHuman('PHYSICAL_OPERATOR')).toBe(true);
  });

  it('declares a workflow without starting anything', async () => {
    const before = await listLaborRounds(projectId);
    const result = await declareWorkflow({
      projectId,
      name: 'Producing the weekly report',
      description: null,
      opportunityId: null,
      actorRef: userId,
    });
    expect(result.created).toBe(true);
    expect(await listLaborRounds(projectId)).toEqual(before);
    expect(await listAllocations(projectId)).toEqual([]);
  });
});
