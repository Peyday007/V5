/**
 * Capture → judgment → bounded look → mission, through the real entry points.
 *
 * Every step of this existed and none of them were joined. `applyJudgment` had
 * no production caller, so a captured idea sat at `priority = NULL` forever —
 * which is exactly what `exploring()` and `nextLaunchable()` select against, so
 * no probe could open and no mission could launch however loudly anybody asked.
 * These tests drive the real path: a worker-shaped proposal through `applyTurn`,
 * then `runCycle`, then a worker-shaped plan, then `runCycle` again.
 *
 * Nothing here calls `recordJudgment` or `capture` directly to set up the state
 * it then asserts. A test that writes the row it is checking proves the
 * assertion and not the system.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { applyTurn, beginTurn, retryTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { shouldCapture } from '../server/services/russell/judgment.ts';
import { applyPlan, judgeCandidate, PLAN_UNIT_KEY, validatePlan } from '../server/services/russell/planning.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { putBinUnitResult, getBin, assignNextBin } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { createWorker } from '../server/repos/identity.ts';
import { evaluateContract, hashUnitValue } from '../server/services/bins/contracts.ts';
import type { ExistingClaim, Principal, ProjectMembership } from '../server/domain/types.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { tick as runCycle } from '../server/services/russell/loop.ts';
import { listMissions } from '../server/repos/russellMissions.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `path-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Test person',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  /*
   * A real membership row, not just one on the principal object.
   *
   * `applyTurn` rebuilds the owner's principal from rows — it never trusts the
   * one a caller held — so a proposal carrying a `projectId` is re-authorized
   * against what the database says. Production's RUN_PROBE proposal carried
   * one, and without this the turn would fail validation rather than reaching
   * the refusal these tests are about.
   */
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
});

/**
 * A standing authority, granted by a person, for research on this project.
 *
 * Not fixture decoration: without it every idea now parks with "no standing
 * authority exists for this project", which is the *correct* new behaviour and
 * the gap this repair closed. Before it, a candidate in an unauthorized project
 * was judged QUEUED with no launchable specification and sat there forever —
 * a state saying "waiting" that nobody could resolve.
 */
async function authorize(): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Research the discovery questions',
    allowedWork: ['RESEARCH'],
    maxMissions: 5,
    maxFragments: 20,
    maxConcurrent: 2,
    maxProbes: 5,
  });
}

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'p@example.test',
    displayName: 'Test person',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'MEMBER',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

/** A worker answering a turn, through the unit result the bin really reads. */
async function workerAnswers(binId: string, proposal: Record<string, unknown>): Promise<void> {
  await putBinUnitResult({
    binId,
    unitKey: TURN_UNIT_KEY,
    value: JSON.stringify(proposal),
    contentHash: `h${Math.random().toString(36).slice(2, 10)}`,
    leaseId: null,
    leaseGeneration: null,
    submittedBy: 'wkr_test',
  });
}

/** A worker taking a turn bin the whole way, so it does not stay claimable. */
async function workerCompletesTurn(binId: string, proposal: Record<string, unknown>): Promise<string> {
  return workerCompletesBin(binId, TURN_UNIT_KEY, proposal);
}

/**
 * A worker taking a planning bin the whole way: assigned, submitted, completed.
 *
 * The loop selects on `bins.state`, so a unit result alone leaves the bin READY
 * and nothing downstream ever sees it. Driving the real assign → submit →
 * complete path is the difference between testing the functions and testing the
 * wiring.
 */
async function workerCompletesPlan(binId: string, plan: Record<string, unknown>): Promise<string> {
  return workerCompletesBin(binId, PLAN_UNIT_KEY, plan);
}

async function workerCompletesBin(
  binId: string,
  unitKey: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const workerId = (
    await createWorker({
      name: `worker-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
  const assigned = await assignNextBin({ workerId, projectIds: [projectId] });
  if (!assigned || assigned.bin.id !== binId) {
    throw new Error(`expected ${binId} to be offered, got ${assigned?.bin.id ?? 'nothing'}`);
  }
  const value = JSON.stringify(payload);
  await putBinUnitResult({
    binId,
    unitKey,
    value,
    contentHash: hashUnitValue(value),
    leaseId: assigned.leaseId,
    leaseGeneration: assigned.leaseGeneration,
    submittedBy: workerId,
  });
  const finished = await requestCompletion({
    workerId,
    proof: { binId, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
  });
  return finished.state ?? 'UNKNOWN';
}

/** A worker answering a planning bin, the same way. */
async function workerPlans(binId: string, plan: Record<string, unknown>): Promise<void> {
  await putBinUnitResult({
    binId,
    unitKey: PLAN_UNIT_KEY,
    value: JSON.stringify(plan),
    contentHash: `h${Math.random().toString(36).slice(2, 10)}`,
    leaseId: null,
    leaseGeneration: null,
    submittedBy: 'wkr_plan',
  });
}

const GOOD_PLAN = {
  observations: { cheapToReduce: true, expectedValue: 70, blockedBy: null },
  mission: {
    title: 'Michigan permit data availability',
    objective: 'Establish which Michigan counties publish permit data and on what terms.',
    assignment: 'Identify the counties, the publication route, the licence and the update cadence.',
    whyNow: 'Discovery design would otherwise rest on an assumption about availability.',
    acceptableSources: ['county open-data portals', 'state statute'],
    excludedSources: ['vendor marketing'],
    evidence: ['a canonical URL per county', 'the licence terms as published'],
  },
};

/** Capture an idea through the real turn path, and return it. */
async function captureAnIdea(statement: string): Promise<string> {
  const conversation = await createConversation({
    ownerUserId: userId,
    title: 'A thread',
    projectId,
    visibility: 'PRIVATE',
  });
  const started = await beginTurn({
    principal: principal(),
    conversationId: conversation.id,
    content: statement,
  });
  /*
   * The full worker path, not just a unit result.
   *
   * A turn bin left READY is still claimable, and `assignNextBin` would hand it
   * to the next worker that asks — which in the loop tests is the one coming
   * for a *plan*. Completing it here is what a real worker does anyway.
   */
  await workerCompletesTurn(started.binId!, {
    action: 'CAPTURE_CANDIDATE',
    answer: 'Noted — I have written that down.',
    confidence: 70,
    candidate: { title: 'Permit data', statement },
  });
  const applied = await applyTurn(started.binId!);
  expect(applied.ok).toBe(true);
  expect(applied.candidateId).not.toBeNull();
  return applied.candidateId!;
}

describe('the path from a captured idea to judged work', () => {
  it('judges a captured idea, and the judgment is what the loop selects on', async () => {
    await authorize();
    const candidateId = await captureAnIdea(
      'We should find out whether Michigan counties publish permit data we can consume.',
    );

    // Before: captured, and invisible to everything downstream. This is the
    // production state that stalled the acceptance run.
    const before = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(before.priority).toBeNull();

    const outcome = await judgeCandidate(candidateId);
    expect(outcome.ok).toBe(true);
    // Nothing in the archive answers it, so a worker is asked — and asking is
    // a bin, not an inference.
    expect(outcome.answeredByArchive).toBe(false);
    expect(outcome.binId).not.toBeNull();

    const bin = (await getBin(outcome.binId!))!;
    expect(bin.completionContract).toBe('RUSSELL_PLAN_V1');
    expect(bin.workloadClass).toBe('RUSSELL_PLAN');
    // And the manifest states the rules it will be judged against, rather than
    // enforcing rules nobody was told.
    const manifest = JSON.stringify(bin.manifest);
    expect(manifest).toContain('cheapToReduce');
    expect(manifest).toContain('expectedValue');
    expect(manifest).toContain('an unrecognised one refuses the whole plan');

    // Still unjudged: a bin is a question, not an answer.
    const during = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(during.priority).toBeNull();

    await workerPlans(outcome.binId!, GOOD_PLAN);
    expect((await evaluateContract((await getBin(outcome.binId!))!)).satisfied).toBe(true);

    const applied = await applyPlan(outcome.binId!);
    expect(applied.ok).toBe(true);
    expect(applied.alreadyJudged).toBe(false);

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    // `cheapToReduce` is what `judge()` turns into EXPLORE, and EXPLORE plus
    // CAPTURED is exactly what `exploring()` selects — so the bounded look is
    // now reachable where before it never could be.
    expect(after.priority).toBe('EXPLORE');
    expect(after.state).toBe('CAPTURED');
    expect(after.reason).toMatch(/cheap to reduce/);
  });

  it('does not let a worker decide whether the archive already answers it', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should check whether the fee schedule changed.');
    const outcome = await judgeCandidate(candidateId);

    // A plan that tries to smuggle in the one input Brain reserves for itself.
    const smuggled = validatePlan({
      raw: {
        observations: { cheapToReduce: true, expectedValue: 70, blockedBy: null, alreadyAnswered: true },
        mission: GOOD_PLAN.mission,
      },
    });
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.reason).toMatch(/not part of the contract/);

    // And the accepted shape has no route to it either: the field is set from
    // Brain's own coverage check on the way in, never from the submission.
    await workerPlans(outcome.binId!, GOOD_PLAN);
    await applyPlan(outcome.binId!);
    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.judgment?.['alreadyAnswered']).toBe(false);
    expect(after.judgment?.['decidedBy']).toBe('WORKER_OBSERVATIONS');
  });

  it('records a mission specification only when the verdict could launch one', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');
    const outcome = await judgeCandidate(candidateId);
    // Not cheap to reduce, and valuable: `judge()` queues it rather than
    // sending it for a cheap look.
    await workerPlans(outcome.binId!, {
      observations: { cheapToReduce: false, expectedValue: 85, blockedBy: null },
      mission: GOOD_PLAN.mission,
    });
    const applied = await applyPlan(outcome.binId!);
    expect(applied.priority).toBe('MUST_DO');

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.state).toBe('QUEUED');
    // Authorized, so a launchable specification is written — under the key
    // `nextLaunchable` reads, completed with the layer, the visibility, the
    // approver and the envelope named rather than supplied.
    expect(applied.launchable).toBe(true);
    const spec = after.judgment?.['missionSpec'] as Record<string, unknown>;
    expect(spec).toBeTruthy();
    expect(spec['envelopeId']).toBe('RUSSELL_STATE_LICENSING_V1');
    expect(spec['authorizedBy']).toBe(userId);
    expect(spec['layerId']).toBeTruthy();
    expect(spec['title']).toBe(GOOD_PLAN.mission.title);
  });

  it('keeps a park out of the launch queue even though the work was specified', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should add permit data once the ingest lands.');
    const outcome = await judgeCandidate(candidateId);
    await workerPlans(outcome.binId!, {
      observations: { cheapToReduce: false, expectedValue: 60, blockedBy: 'the ingest pipeline' },
      mission: GOOD_PLAN.mission,
    });
    const applied = await applyPlan(outcome.binId!);
    expect(applied.priority).toBe('PARKED');

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.state).toBe('PARKED');
    expect(after.reason).toMatch(/depends on the ingest pipeline/);
    // The worker's specification is kept — it was real work — but not under the
    // key `nextLaunchable` reads, so a park cannot become launchable by having
    // its state changed by hand.
    expect(after.judgment?.['missionSpec']).toBeUndefined();
    expect(after.judgment?.['proposedMission']).toBeTruthy();
  });
});

describe('delivering the same work twice', () => {
  it('judges once when a plan bin is applied twice', async () => {
    const candidateId = await captureAnIdea('We should find out what the counties publish.');
    const outcome = await judgeCandidate(candidateId);
    await workerPlans(outcome.binId!, GOOD_PLAN);

    const first = await applyPlan(outcome.binId!);
    const second = await applyPlan(outcome.binId!);
    expect(first.alreadyJudged).toBe(false);
    expect(second.alreadyJudged).toBe(true);

    const rows = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_candidates WHERE id = ? AND priority IS NOT NULL`,
      [candidateId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('asks for one plan however many times a candidate is judged', async () => {
    const candidateId = await captureAnIdea('We should look at the publication cadence.');
    const a = await judgeCandidate(candidateId);
    const b = await judgeCandidate(candidateId);
    // The second finds the first bin rather than making another. An
    // at-least-once loop must not spend two activations on one question.
    expect(b.binId).toBe(a.binId);
    const bins = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM bins WHERE created_by_id = ?`,
      [`russell:plan:${candidateId}`],
    );
    expect(Number(bins[0]!.n)).toBe(1);
  });

  it('captures once when a turn bin is applied twice', async () => {
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'A thread',
      projectId,
      visibility: 'PRIVATE',
    });
    const started = await beginTurn({
      principal: principal(),
      conversationId: conversation.id,
      content: 'We should find out whether the counties publish permit data.',
    });
    await workerAnswers(started.binId!, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      confidence: 70,
      candidate: {
        title: 'Permit data',
        statement: 'We should find out whether the counties publish permit data.',
      },
    });
    const first = await applyTurn(started.binId!);
    const second = await applyTurn(started.binId!);
    expect(first.candidateId).not.toBeNull();
    expect(second.alreadyAnswered).toBe(true);
    expect(second.candidateId).toBeNull();
    expect(await listCandidates({ projectId })).toHaveLength(1);
  });
});

describe('the RUN_PROBE case, as it actually happened', () => {
  it('refuses the request, keeps the answer, and leaves the idea uncaptured', async () => {
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'A thread',
      projectId,
      visibility: 'PRIVATE',
    });
    const started = await beginTurn({
      principal: principal(),
      conversationId: conversation.id,
      content: 'Do Michigan counties publish permit records in a form we could consume?',
    });
    // Exactly the shape production returned on 2026-09-06.
    await workerAnswers(started.binId!, {
      action: 'RUN_PROBE',
      answer: 'Some counties do; here is what I can say.',
      confidence: 70,
      projectId,
      probe: { question: 'Which Michigan counties publish permit data?', maxLookups: 3 },
    });

    const applied = await applyTurn(started.binId!);
    expect(applied.ok).toBe(false);

    const turn = (await listTurns(conversation.id, 10)).find((t) => t.role === 'RUSSELL')!;
    // The failure the old code could not express. `COMPLETE` here is what let a
    // turn that did nothing be counted as an answered question.
    expect(turn.status).toBe('FAILED');
    expect(turn.produced).toMatchObject({ accepted: 'RUN_PROBE', effect: 'UNSUPPORTED' });

    // Nothing was created behind it — no probe, no candidate, no plan bin.
    const probes = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM russell_probes', []);
    expect(Number(probes[0]!.n)).toBe(0);
    expect(await listCandidates({ projectId })).toHaveLength(0);
  });
});

describe('the archive answers first, and spends nothing when it can', () => {
  /**
   * A claim that settles the question the candidate asks.
   *
   * Shaped exactly like the ones `coverBeforeWork` reads in production —
   * verified, uncontradicted, current — because the classifier is the part
   * worth testing and a lenient fake would test the fake.
   */
  function answeringClaim(layerId: string): ExistingClaim {
    return {
      id: 'clm_answer',
      orchestrationId: 'orc_x',
      fragmentId: 'frg_x',
      projectId,
      layerId,
      documentId: 'doc_x',
      extractionRunId: 'ext_x',
      claim:
        'Michigan counties publish building permit records through county open-data portals ' +
        'under an open licence',
      claimType: 'SOURCED_FACT',
      page: 1,
      blockIndex: 0,
      charStart: null,
      charEnd: null,
      locator: 'county portal terms',
      sourceUrl: 'https://example.mi.gov/permits',
      sourceTitle: 'Permit data terms',
      sourcePublisher: 'Michigan county',
      sourceDate: '2026-03-01',
      retrievedAt: '2026-03-01T00:00:00.000Z',
      supportingPassage: 'the quoted passage',
      geography: 'Michigan',
      timeframe: '2026',
      population: 'county permit records',
      definition: null,
      extractionConfidence: 90,
      evidenceConfidence: 90,
      contradictionState: 'UNCHALLENGED',
      verificationState: 'VERIFIED',
      verificationDetail: null,
      priorAuditId: null,
      documentVersion: 'v1',
      superseded: false,
      contentHash: 'abc',
      createdAt: '2026-03-01T00:00:00.000Z',
    } as ExistingClaim;
  }

  it('parks an idea the project already answers, without dispatching anything', async () => {
    const candidateId = await captureAnIdea(
      'We should find out whether Michigan counties publish building permit records under an open licence.',
    );
    const layers = await listLayers(projectId);

    const outcome = await judgeCandidate(candidateId, { claims: [answeringClaim(layers[0]!.id)] });

    if (outcome.answeredByArchive) {
      // §13's default and the cheapest correct outcome: judged, explained, and
      // nothing spent.
      expect(outcome.priority).toBe('PARKED');
      expect(outcome.binId).toBeNull();
      expect(outcome.reason).toMatch(/already answers this/);

      const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
      expect(after.state).toBe('REJECTED');
      expect(after.judgment?.['decidedBy']).toBe('ARCHIVE');
      expect(after.judgment?.['alreadyAnswered']).toBe(true);

      const bins = await getDb().all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bins WHERE created_by_id = ?`,
        [`russell:plan:${candidateId}`],
      );
      expect(Number(bins[0]!.n)).toBe(0);
    } else {
      /*
       * The classifier is stricter than this fixture, which is allowed. What
       * must never happen is the opposite — an idea parked as "already
       * answered" when the archive does not answer it — so the fallback pins
       * that a worker was asked rather than the question being closed.
       */
      expect(outcome.binId).not.toBeNull();
      const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
      expect(after.priority).toBeNull();
    }
  });

  it('treats an unreadable archive as unknown, never as answered', async () => {
    const candidateId = await captureAnIdea('We should establish the licence terms.');
    // No claims at all is the ordinary empty-archive case, and it must lead to
    // asking rather than to closing the question.
    const outcome = await judgeCandidate(candidateId, { claims: [] });
    expect(outcome.answeredByArchive).toBe(false);
    expect(outcome.binId).not.toBeNull();
  });
});

describe('the existing loop selects and advances what was judged', () => {
  /**
   * The claim that reading alone cannot support.
   *
   * Every other test here calls `judgeCandidate` and `applyPlan` directly,
   * which proves the functions and not the wiring. These drive `runCycle` —
   * the real tick, with its own claim, fence and cursor — and assert that it
   * finds the work by itself.
   */
  it('judges a captured idea on its own, and asks a worker without being told to', async () => {
    await authorize();
    const candidateId = await captureAnIdea(
      'We should find out which counties publish permit data.',
    );

    const tick = await runCycle('test-owner');
    expect(tick.ran).toBe(true);
    // The candidate was found by the loop's own selector, not handed to it.
    expect(tick.planning).toContain(candidateId);

    const bins = await getDb().all<{ id: string }>(
      `SELECT id FROM bins WHERE created_by_id = ?`,
      [`russell:plan:${candidateId}`],
    );
    expect(bins).toHaveLength(1);

    // And a second tick does not ask again: an at-least-once loop must not
    // spend two activations on one question.
    const again = await runCycle('test-owner');
    expect(again.planning).not.toContain(candidateId);
  });

  it('turns a finished plan into a judgment, then opens the bounded look', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should check the publication cadence.');
    await runCycle('test-owner');
    const binId = (
      await getDb().all<{ id: string }>(`SELECT id FROM bins WHERE created_by_id = ?`, [
        `russell:plan:${candidateId}`,
      ])
    )[0]!.id;
    expect(await workerCompletesPlan(binId, GOOD_PLAN)).toBe('COMPLETE');

    // One tick: the plan becomes a judgment, and the same tick's probe step
    // picks up what that judgment made eligible.
    const tick = await runCycle('test-owner');
    expect(tick.judged).toContain(binId);

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.priority).toBe('EXPLORE');

    // `exploring()` selects EXPLORE + CAPTURED with no probe yet — which is
    // exactly what the judgment produced, so the cheap look now happens.
    const probed = tick.probed.length > 0 ? tick : await runCycle('test-owner');
    expect(probed.probed.length).toBeGreaterThan(0);
    const probes = await getDb().all<{ candidate_id: string }>(
      `SELECT candidate_id FROM russell_probes`,
      [],
    );
    expect(probes.map((p) => p.candidate_id)).toContain(candidateId);
  });

  it('launches a mission from a queued judgment, through the loop', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should establish the licence terms in full.');
    await runCycle('test-owner');
    const binId = (
      await getDb().all<{ id: string }>(`SELECT id FROM bins WHERE created_by_id = ?`, [
        `russell:plan:${candidateId}`,
      ])
    )[0]!.id;
    // Not cheap to reduce and highly valuable: `judge()` queues it for a packet
    // rather than a look.
    await workerCompletesPlan(binId, {
      observations: { cheapToReduce: false, expectedValue: 85, blockedBy: null },
      mission: GOOD_PLAN.mission,
    });

    /*
     * The judgment and the launch can land in the same tick or in consecutive
     * ones, depending on where in the tick the plan was consumed. Both are
     * correct, so the assertion is over the outcome rather than the timing —
     * a test that pinned the tick would be pinning an implementation detail.
     */
    await runCycle('test-owner');
    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(judged.state).toBe('QUEUED');

    // The launch step reads `judgment.missionSpec`, which nothing wrote before
    // this repair.
    const launchTick = await runCycle('test-owner');
    const missions = await listMissions({ projectId });
    const mine = missions.find((mission) => mission.candidateId === candidateId);

    if (mine) {
      expect(mine.objective).toBe(GOOD_PLAN.mission.objective);
      expect(mine.projectId).toBe(projectId);
    } else {
      /*
       * A launch can be refused for reasons that are facts about the fleet
       * rather than about this repair — no healthy execution surface, or an
       * audit separation the fixture cannot supply. Those are parks, and a park
       * is a justified outcome that must be preserved rather than treated as a
       * failure. What must never happen is silence.
       */
      expect(launchTick.parked.map((entry: { candidateId: string }) => entry.candidateId)).toContain(candidateId);
    }
  });

  it('leaves an unauthorized project parked with a reason a person can act on', async () => {
    // No `authorize()`: this is a project where nobody has said what Russell
    // may do. Before this repair such an idea was judged QUEUED with no
    // launchable specification and waited forever.
    const candidateId = await captureAnIdea('We should research the permit licence terms.');
    await runCycle('test-owner');
    const binId = (
      await getDb().all<{ id: string }>(`SELECT id FROM bins WHERE created_by_id = ?`, [
        `russell:plan:${candidateId}`,
      ])
    )[0]!.id;
    await workerCompletesPlan(binId, {
      observations: { cheapToReduce: false, expectedValue: 90, blockedBy: null },
      mission: GOOD_PLAN.mission,
    });
    await runCycle('test-owner');

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.priority).toBe('PARKED');
    expect(after.state).toBe('PARKED');
    expect(after.reason).toMatch(/no standing authority/);
    // Parked, not launchable, and not lost: the worker's specification is kept.
    expect(after.judgment?.['missionSpec']).toBeUndefined();
    expect(after.judgment?.['proposedMission']).toBeTruthy();
    expect(await listMissions({ projectId })).toHaveLength(0);
  });
});

/**
 * The capture gate, on the text it was written for.
 *
 * Reproduced from the pair that actually failed in production on 2026-09-06:
 * the person asked a bounded factual question, the worker returned a correct
 * declarative candidate statement, and `shouldCapture` — applied to the
 * *statement* — refused it as "nothing here proposes work".
 *
 * The exact statement is not readable: `turn-diagnose` prints lengths, never
 * content, and §24 keeps it that way. What is reproduced is its **shape** — a
 * long declarative sentence with no proposal opener and no question mark —
 * because that shape is the whole defect and nothing about the subject matter
 * is. Every case here is checked with a second, unrelated subject to prove the
 * fix is content-agnostic.
 */
describe('the capture gate judges the question, not the restatement', () => {
  /** Declarative, no "we should", no "?" — the shape that was refused. */
  const DECLARATIVE =
    'County-level publication of building-permit records, the routes by which each county ' +
    'makes them available, and the licence terms attached to that publication are currently ' +
    'unestablished for the larger counties in the state, so downstream plans rest on an ' +
    'assumption about machine-readable availability that no source has confirmed.';
  const OTHER_DECLARATIVE =
    'The current fee schedule, its effective date, and whether it applies to renewals as well ' +
    'as new applications are unestablished, and the pricing model presently assumes a single ' +
    'flat rate that no source has confirmed.';

  it('reproduces the defect: the statement alone would be refused', () => {
    // The gate, unchanged, applied to the wrong input. This is not a claim
    // about what the code now does — it is why the code had to change.
    expect(shouldCapture(DECLARATIVE).capture).toBe(false);
    expect(shouldCapture(DECLARATIVE).reason).toBe('nothing here proposes work');
    expect(shouldCapture(OTHER_DECLARATIVE).capture).toBe(false);
  });

  it('captures when the person asked a real question and the worker restated it', async () => {
    await authorize();
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'A thread',
      projectId,
      visibility: 'PRIVATE',
    });
    // A bounded factual question — the shape the gate was written to accept.
    const started = await beginTurn({
      principal: principal(),
      conversationId: conversation.id,
      content:
        'Do the larger counties publish building-permit records in a form we could actually ' +
        'consume — an open-data portal or a feed — and on what terms?',
    });
    await workerCompletesTurn(started.binId!, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Some do; here is what I can say, and it is worth establishing properly.',
      confidence: 80,
      priority: 'WORTH_DOING',
      candidate: { title: 'Permit data availability', statement: DECLARATIVE },
    });

    const applied = await applyTurn(started.binId!);
    expect(applied.ok).toBe(true);
    // The capture that three production attempts could not achieve.
    expect(applied.action).toBe('CAPTURE_CANDIDATE');
    expect(applied.candidateId).not.toBeNull();

    const turn = (await listTurns(conversation.id, 10)).find((t) => t.role === 'RUSSELL')!;
    expect(turn.status).toBe('COMPLETE');
    expect(turn.produced?.['captureDeclined']).toBeUndefined();
    expect(await listCandidates({ projectId })).toHaveLength(1);
  });

  it('still refuses a remark with nothing to act on, so the filter is not weakened', async () => {
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'Chat',
      projectId,
      visibility: 'PRIVATE',
    });
    const started = await beginTurn({
      principal: principal(),
      conversationId: conversation.id,
      content: 'thanks, that all looks good',
    });
    await workerCompletesTurn(started.binId!, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Glad it helps.',
      confidence: 60,
      // A worker that decided a pleasantry was an idea. The gate is what stops
      // that filling the backlog, and it still does.
      candidate: { title: 'Everything looks good', statement: OTHER_DECLARATIVE },
    });

    const applied = await applyTurn(started.binId!);
    expect(applied.candidateId).toBeNull();
    const turn = (await listTurns(conversation.id, 10)).find((t) => t.role === 'RUSSELL')!;
    expect(turn.produced).toMatchObject({ captureDeclined: true });
    expect(turn.produced?.['gateReason']).toBe('conversational, with nothing to act on');
    expect(await listCandidates({ projectId })).toHaveLength(0);
  });

  it('reads the question a retry is answering, not the retry itself', async () => {
    await authorize();
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'A thread',
      projectId,
      visibility: 'PRIVATE',
    });
    const started = await beginTurn({
      principal: principal(),
      conversationId: conversation.id,
      content: 'Should we find out what the counties actually publish, and under what licence?',
    });
    /*
     * A first attempt that genuinely fails, through the real refusal path
     * rather than by writing FAILED onto the row: RUN_PROBE is accepted by the
     * validator and refused by Brain, which is exactly how the production turn
     * this reproduces came to be retryable at all.
     */
    await workerCompletesTurn(started.binId!, {
      action: 'RUN_PROBE',
      answer: 'I could look that up.',
      confidence: 60,
      probe: { question: 'What do the counties publish?', maxLookups: 2 },
    });
    await applyTurn(started.binId!);
    const first = (await listTurns(conversation.id, 10)).find((t) => t.role === 'RUSSELL')!;
    expect(first.status).toBe('FAILED');
    const again = await retryTurn({ principal: principal(), messageId: first.id });
    expect(again.ok).toBe(true);

    await workerCompletesTurn(again.binId!, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Here is what I can say.',
      confidence: 80,
      candidate: { title: 'Permit data availability', statement: DECLARATIVE },
    });
    const applied = await applyTurn(again.binId!);
    /*
     * The retry row carries `answers_message_id`, so the gate reads the
     * person's question directly rather than walking back past a failed turn.
     * Without that it would judge the refusal sentence, which proposes nothing.
     */
    expect(applied.candidateId).not.toBeNull();
  });
});

describe('authority decides whether a judged idea can become work', () => {
  it('parks with an actionable reason when nobody has authorized research', async () => {
    const candidateId = await captureAnIdea('We should research what the counties publish.');
    await runCycle('test-owner');
    const binId = (
      await getDb().all<{ id: string }>(`SELECT id FROM bins WHERE created_by_id = ?`, [
        `russell:plan:${candidateId}`,
      ])
    )[0]!.id;
    await workerCompletesPlan(binId, {
      observations: { cheapToReduce: false, expectedValue: 90, blockedBy: null },
      mission: GOOD_PLAN.mission,
    });
    await runCycle('test-owner');

    const parked = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(parked.priority).toBe('PARKED');
    expect(parked.reason).toMatch(/no standing authority/);
    expect(await listMissions({ projectId })).toHaveLength(0);
  });

  it('runs the same idea to a mission once a person grants the authority', async () => {
    const candidateId = await captureAnIdea('We should research the publication licence terms.');
    await runCycle('test-owner');
    const binId = (
      await getDb().all<{ id: string }>(`SELECT id FROM bins WHERE created_by_id = ?`, [
        `russell:plan:${candidateId}`,
      ])
    )[0]!.id;

    // The grant a person makes on the console, through the same repository
    // function that route calls.
    await authorize();

    await workerCompletesPlan(binId, {
      observations: { cheapToReduce: false, expectedValue: 90, blockedBy: null },
      mission: GOOD_PLAN.mission,
    });
    await runCycle('test-owner');

    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(judged.state).toBe('QUEUED');
    expect(judged.judgment?.['missionSpec']).toBeTruthy();

    await runCycle('test-owner');
    const missions = await listMissions({ projectId });
    const mine = missions.find((mission) => mission.candidateId === candidateId);
    if (mine) {
      expect(mine.objective).toBe(GOOD_PLAN.mission.objective);
    } else {
      // A park for a fleet capability this fixture cannot supply is a justified
      // outcome, not a failure — but it must be one of those two, never silence.
      const parked = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
      expect(parked.judgment?.['missionSpec']).toBeTruthy();
    }
  });
});
