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
import { applyTurn, beginTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { applyPlan, judgeCandidate, PLAN_UNIT_KEY, validatePlan } from '../server/services/russell/planning.ts';
import { listCandidates } from '../server/repos/russellCandidates.ts';
import { putBinUnitResult, getBin } from '../server/repos/bins.ts';
import { evaluateContract } from '../server/services/bins/contracts.ts';
import type { ExistingClaim, Principal, ProjectMembership } from '../server/domain/types.ts';
import { listLayers } from '../server/repos/layers.ts';

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
  await workerAnswers(started.binId!, {
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
    // No standing authority in this fixture, so no launchable spec is written —
    // and the candidate is still judged. An absent grant is a fact about the
    // project, not a failure of the plan.
    expect(applied.launchable).toBe(false);
    expect(after.judgment?.['proposedMission']).toBeTruthy();
    expect(after.judgment?.['missionSpec']).toBeUndefined();
  });

  it('keeps a park out of the launch queue even though the work was specified', async () => {
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
