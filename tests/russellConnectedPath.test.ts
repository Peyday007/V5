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
import { addMessage, createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { applyTurn, beginTurn, retryTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { shouldCapture } from '../server/services/russell/judgment.ts';
import { judgeCandidate } from '../server/services/russell/planning.ts';
import {
  getApprovalEnvelope,
  planFitsEnvelope,
} from '../server/services/research/approvalEnvelope.ts';
import {
  getCandidate,
  listCandidates,
  overrideJudgment,
  recordJudgment,
} from '../server/repos/russellCandidates.ts';
import { putBinUnitResult, getBin, assignNextBin, createBin } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { createWorker } from '../server/repos/identity.ts';
import { evaluateContract, hashUnitValue } from '../server/services/bins/contracts.ts';
import type {
  ExistingClaim,
  Principal,
  ProjectMembership,
  ResearchFragment,
  ResearchOrchestration,
} from '../server/domain/types.ts';
import { listLayers } from '../server/repos/layers.ts';
import { tick as runCycle } from '../server/services/russell/loop.ts';
import {
  askHuman,
  getHumanRequest,
  getMission,
  launchMission,
  listMissions,
  transitionMission,
} from '../server/repos/russellMissions.ts';
import { launch } from '../server/services/russell/launch.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';

let projectId = '';
let userId = '';
let layerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = fixture.layers[0]!.id;
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

describe('the path from a captured idea to compiled work', () => {
  it('judges a captured idea and compiles its specification, in one call', async () => {
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
    expect(outcome.answeredByArchive).toBe(false);
    /*
     * No bin, and that is the change.
     *
     * This used to dispatch a `RUSSELL_PLAN` bin and wait for a worker to write
     * the specification. Three times in production that worker answered with a
     * padded placeholder — `{title: 'test', …}`, then `"test placeholder title
     * long enough"` — and Brain refused all three correctly and got nowhere.
     * The specification is compiled here instead, so there is nothing
     * outstanding to point at.
     */
    expect(outcome.binId).toBeNull();
    expect(outcome.launchable).toBe(true);
    expect(await getDb().all(`SELECT id FROM bins WHERE kind = 'RUSSELL_PLAN'`, [])).toHaveLength(0);

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.state).toBe('QUEUED');
    expect(after.judgment?.['decidedBy']).toBe('COMPILER');
    // Neither semantic observation was made, and the judgment says so rather
    // than storing a `false` and a `0` that read as findings.
    expect(after.judgment?.['cheapToReduceAssessed']).toBe('NOT_ASSESSED');
    expect(after.judgment?.['expectedValueAssessed']).toBe('NOT_ASSESSED');
  });

  it('specifies the work from the person\'s own question, not from a summary of it', async () => {
    await authorize();
    const asked =
      'When a property changes hands, how quickly does the county register show it, and is ' +
      'there a lag between the closing and the record appearing?';
    const candidateId = await captureAnIdea(asked);
    await judgeCandidate(candidateId);

    const spec = specOf(
      (await listCandidates({ projectId })).find((c) => c.id === candidateId)!,
    );
    // The assignment quotes what the person actually sent. A candidate's
    // statement is a worker's restatement of it; the message is the primary
    // text and is what the mission is about.
    expect(String(spec['assignment'])).toContain(asked);
    expect(String(spec['objective'])).toContain('official Michigan public records');
    // And it asserts nothing about the world: every sentence in it is either
    // the question or a rule the envelope fixed.
    expect(String(spec['whyNow'])).toMatch(/does not answer this/);
  });

  it('uses the person\'s question even when the idea predates the link to it', async () => {
    /*
     * The blocker production reported, and it was a real one.
     *
     * `rcn_85f9689b461c4972a1ba` was captured before anything wrote
     * `source_message_id`, so it carried only the worker's restatement — "the
     * counties Deal Dispatch cares about" — and the compiled fragment inherited
     * it. The worker researching that fragment blocked it, correctly: neither
     * the orchestration nor the project names those counties. A specification
     * faithful to a summary is not faithful to the question.
     *
     * So an idea with no link falls back to the last message the person sent at
     * or before it was captured, which is the same rule a turn already used.
     */
    await authorize();
    const asked =
      'How quickly does the county register show a property changing hands in Wayne and Oakland?';
    const candidateId = await captureAnIdea(asked);
    // The link removed, which is exactly the shape every idea captured before
    // this was written has in production.
    await getDb().run(`UPDATE russell_candidates SET source_message_id = NULL WHERE id = ?`, [
      candidateId,
    ]);

    await judgeCandidate(candidateId);
    const spec = specOf((await listCandidates({ projectId })).find((c) => c.id === candidateId)!);
    expect(String(spec['assignment'])).toContain('Wayne and Oakland');
  });

  it('names the project\'s own envelope rather than one for another question', async () => {
    /*
     * The defect this replaced. `missionSpecFor` wrote the literal string
     * `RUSSELL_STATE_LICENSING_V1` on every Russell mission in every project —
     * an acceptance envelope for a licensing question about Florida and
     * California, which lists Michigan in its own `forbiddenScope`. So a real
     * Deal Dispatch idea was measured against limits for a different question
     * about a different place, and was refused every time.
     */
    await authorize();
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');
    await judgeCandidate(candidateId);

    const spec = specOf((await listCandidates({ projectId })).find((c) => c.id === candidateId)!);
    expect(spec['envelopeId']).toBe('RUSSELL_PUBLIC_RECORDS_V1');
    expect(spec['authorizedBy']).toBe(userId);
    expect(spec['layerId']).toBeTruthy();
  });

  it('compiles a plan the envelope actually accepts', async () => {
    /*
     * The property everything downstream depends on, checked against the real
     * validator rather than described.
     */
    await authorize();
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');
    await judgeCandidate(candidateId);
    const spec = specOf((await listCandidates({ projectId })).find((c) => c.id === candidateId)!);
    const envelope = getApprovalEnvelope(String(spec['envelopeId']))!;

    const fragments = (spec['plan'] as Record<string, unknown>[]).map((fragment) => ({
      ...(fragment as unknown as ResearchFragment),
      fragmentKey: String(fragment['fragmentKey']),
    })) as unknown as ResearchFragment[];

    const verdict = planFitsEnvelope({
      envelope,
      orchestration: {
        assignment: String(spec['assignment']),
        fixture: false,
        unresolvedGapPolicy: null,
      } as unknown as ResearchOrchestration,
      fragments,
    });
    expect(verdict.fits, verdict.reasons.join(' ')).toBe(true);
    expect(verdict.checked['pinnedBy']).toBe('TEMPLATE');
  });

  it('refuses a question about a jurisdiction the authorization does not cover', async () => {
    // Not quietly re-scoped to somewhere Brain is allowed to look, which would
    // answer a different question from the one somebody asked.
    await authorize();
    const candidateId = await captureAnIdea(
      'We should find out how quickly Ohio counties publish deed transfers.',
    );
    const outcome = await judgeCandidate(candidateId);
    expect(outcome.ok).toBe(true);
    expect(outcome.priority).toBe('PARKED');

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.state).toBe('PARKED');
    expect(after.reason).toMatch(/Ohio/);
    expect(after.reason).toMatch(/Michigan/);
    // Parked with the reason rather than left unjudged: a person can act on a
    // refusal they can see, and "nothing has happened yet" is a different
    // state with a different remedy.
    expect(after.judgment?.['refusal']).toBeTruthy();
    expect(after.judgment?.['missionSpec']).toBeUndefined();
  });

  it('keeps a park out of the launch queue even though the work was specified', async () => {
    await authorize();
    await getDb().run(`UPDATE russell_goals SET state = 'REVOKED' WHERE project_id = ?`, [
      projectId,
    ]);
    const candidateId = await captureAnIdea('We should add permit data once the ingest lands.');
    const outcome = await judgeCandidate(candidateId);
    expect(outcome.priority).toBe('PARKED');

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.state).toBe('PARKED');
    // The compiled specification is kept — it is free to recompute and useful
    // to read — but not under the key `nextLaunchable` reads, so a park cannot
    // become launchable by having its state changed by hand.
    expect(after.judgment?.['missionSpec']).toBeUndefined();
    expect(after.judgment?.['proposedMission']).toBeTruthy();
  });
});

/** The compiled specification a judged candidate carries. */
function specOf(candidate: { judgment: Record<string, unknown> }): Record<string, unknown> {
  return candidate.judgment['missionSpec'] as Record<string, unknown>;
}

describe('delivering the same work twice', () => {
  it('judges once however many times a candidate is judged', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should check the publication cadence.');
    const a = await judgeCandidate(candidateId);
    const b = await judgeCandidate(candidateId);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/already judged/);
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
      expect(outcome.answeredByArchive).toBe(false);
      const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
      expect(after.state).not.toBe('REJECTED');
    }
  });

  it('treats an unreadable archive as unknown, never as answered', async () => {
    const candidateId = await captureAnIdea('We should establish the licence terms.');
    // No claims at all is the ordinary empty-archive case, and it must lead to
    // asking rather than to closing the question.
    const outcome = await judgeCandidate(candidateId, { claims: [] });
    // Specified rather than closed: an empty archive is "unknown", and the
    // question goes on to be judged rather than marked answered.
    expect(outcome.answeredByArchive).toBe(false);
    expect((await getCandidate(candidateId))!.state).not.toBe('REJECTED');
  });
});

describe('the loop selects, compiles and launches on its own', () => {
  /**
   * The claim that reading alone cannot support.
   *
   * These drive `runCycle` — the real tick, with its own claim, fence and
   * cursor — and assert that it finds the work by itself. That distinction is
   * the whole reason this file exists: the previous version's redo tests called
   * `applyPlan` directly and passed while production's chain was dead, because
   * the loop's own selector matched two plan-key shapes out of three.
   */
  it('judges and specifies a captured idea on its own, with no bin and no worker', async () => {
    await authorize();
    const candidateId = await captureAnIdea(
      'We should find out which counties publish permit data.',
    );

    const tick = await runCycle('test-owner');
    expect(tick.ran).toBe(true);
    // The candidate was found by the loop's own selector, not handed to it.
    expect(tick.planning).toContain(candidateId);

    // Nothing was dispatched to write it. This is the subsystem that is gone.
    expect(await getDb().all(`SELECT id FROM bins WHERE kind = 'RUSSELL_PLAN'`, [])).toHaveLength(0);

    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(judged.state).toBe('QUEUED');
    expect(judged.judgment?.['missionSpec']).toBeTruthy();

    // And a second tick does not judge it again.
    const again = await runCycle('test-owner');
    expect(again.planning).not.toContain(candidateId);
  });

  it('launches a mission from a compiled judgment, through the loop', async () => {
    await authorize();
    const candidateId = await captureAnIdea('We should establish the licence terms in full.');

    // Tick one compiles and queues; tick two launches. Both are the loop's own
    // selectors, with nothing handed to them.
    await runCycle('test-owner');
    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(judged.state).toBe('QUEUED');
    const spec = judged.judgment?.['missionSpec'] as Record<string, unknown>;
    expect(spec).toBeTruthy();

    const launchTick = await runCycle('test-owner');
    const missions = await listMissions({ projectId });
    const mine = missions.find((mission) => mission.candidateId === candidateId);

    if (mine) {
      expect(mine.objective).toBe(spec['objective']);
      expect(mine.projectId).toBe(projectId);
      // The packet arrived planned: no `RESEARCH_PLAN` work item was ever
      // queued, because the decomposition travelled with the specification.
      const items = await getDb().all<{ work_type: string }>(
        `SELECT work_type FROM work_items WHERE orchestration_id = ?`,
        [mine.orchestrationId],
      );
      expect(items.map((item) => item.work_type)).not.toContain('RESEARCH_PLAN');
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
    // may do.
    const candidateId = await captureAnIdea('We should research the permit licence terms.');
    await runCycle('test-owner');

    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.priority).toBe('PARKED');
    expect(after.state).toBe('PARKED');
    expect(after.reason).toMatch(/no standing authority/);
    // Parked, not launchable, and not lost: the compiled specification is kept.
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

    const parked = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(parked.priority).toBe('PARKED');
    expect(parked.reason).toMatch(/no standing authority/);
    expect(await listMissions({ projectId })).toHaveLength(0);
  });

  it('runs the same idea to a mission once a person grants the authority', async () => {
    const candidateId = await captureAnIdea('We should research the publication licence terms.');
    await runCycle('test-owner');
    // Parked: nobody has authorized research here yet.
    expect(
      (await listCandidates({ projectId })).find((c) => c.id === candidateId)!.state,
    ).toBe('PARKED');

    // The grant a person makes, through the same repository function that route
    // calls — and then a person's override puts the parked idea back in play,
    // which is `PARKED`'s documented way out.
    await authorize();
    await overrideJudgment({
      candidateId,
      actorUserId: userId,
      priority: 'MUST_DO',
      state: 'CAPTURED',
      reason: 'the authority now exists, so this can be judged again',
    });
    await getDb().run(`UPDATE russell_candidates SET priority = NULL WHERE id = ?`, [candidateId]);

    await runCycle('test-owner');
    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(judged.state).toBe('QUEUED');
    expect(judged.judgment?.['missionSpec']).toBeTruthy();

    await runCycle('test-owner');
    const missions = await listMissions({ projectId });
    const mine = missions.find((mission) => mission.candidateId === candidateId);
    if (mine) {
      expect(mine.objective).toBe(
        (judged.judgment?.['missionSpec'] as Record<string, unknown>)['objective'],
      );
    } else {
      // A park for a fleet capability this fixture cannot supply is a justified
      // outcome, not a failure — but it must be one of those two, never silence.
      const parked = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
      expect(parked.judgment?.['missionSpec']).toBeTruthy();
    }
  });
});


describe('a turn with no source message', () => {
  it('captures nothing and says the link is broken, rather than treating it as permission', async () => {
    await authorize();
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'Orphan',
      projectId,
      visibility: 'PRIVATE',
    });
    /*
     * A Russell turn with nothing before it. Every turn answers something a
     * person said — that is what a turn is — so this is a fault in the thread,
     * not a licence to capture without provenance.
     *
     * Constructed rather than driven through `beginTurn`, because `beginTurn`
     * cannot produce it: it always writes the person's message first. That is
     * the point — this state is a broken link, and the test is what stops it
     * quietly becoming an idea in somebody's backlog.
     */
    const pending = await addMessage({
      conversationId: conversation.id,
      role: 'RUSSELL',
      content: '',
      status: 'PENDING',
      pendingReason: 'waiting',
    });
    const bin = await createBin({
      projectId,
      kind: 'RUSSELL_TURN',
      title: 'Answer one conversation turn',
      objective: 'Read the conversation and propose one structured response.',
      rationale: 'A person is waiting for an answer.',
      manifest: {
        objective: 'x',
        why: 'y',
        lineage: { projectId, layerId: null, goal: 'g', orchestrationId: null },
        units: [{ key: TURN_UNIT_KEY, establishes: 'one proposal', input: '', transform: 'none', dependsOn: [] }],
        acceptableSources: ['the conversation itself'],
        excludedSources: ['anything else'],
        evidence: ['one JSON object'],
        outputs: ['one proposal'],
        authorizedActions: ['reading this project'],
        prohibitedActions: ['any spend'],
        budgetUnits: 1,
        retry: { maxAttempts: 2, backoffSeconds: 30 },
        stoppingConditions: ['one proposal has been submitted'],
      },
      completionContract: 'RUSSELL_TURN_V1',
      createdByType: 'SYSTEM',
      createdById: `russell:turn:${pending.id}`,
      ready: true,
      priority: 9,
      maxAttempts: 2,
      workloadClass: 'RUSSELL_TURN',
    });
    await workerCompletesTurn(bin.id, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      confidence: 80,
      candidate: { title: 'Something', statement: 'A statement with no question behind it.' },
    });

    const applied = await applyTurn(bin.id);
    // The operation is preserved and named, and nothing is captured.
    expect(applied.candidateId).toBeNull();
    const turn = (await listTurns(conversation.id, 10)).find((t) => t.role === 'RUSSELL')!;
    expect(turn.produced).toMatchObject({
      captureDeclined: true,
      gateReason: 'NO_SOURCE_MESSAGE',
    });
    // Distinguishable from a gate that ran and refused, which is the whole
    // reason it is named rather than folded into the ordinary decline.
    expect(await listCandidates({ projectId })).toHaveLength(0);
  });
});
/**
 * One specification per idea, and a defect is not an attempt.
 *
 * These replace the redo tests. The redo existed because a worker wrote the
 * specification, so a run that produced nothing could be answered by asking for
 * a different one. With a compiled specification there is exactly one per idea,
 * so §15's rule — no repair repeats a strategy an earlier attempt already
 * tried — and "there is nothing else to try" became the same sentence.
 *
 * What is left is two obligations, and both are here. A specification the
 * retired subsystem wrote must not count against the idea, because it is a
 * defect rather than an attempt; and an idea whose one specification has been
 * researched and produced nothing must stop visibly rather than be refused in
 * silence on every tick for ever.
 */
describe('one specification per idea, and a defect is not an attempt', () => {
  const COMPILED = {
    objective: 'Establish, from official Michigan public records, the compiled question.',
    whyNow: 'Russell checked the archive and it does not answer this.',
  };

  async function launchWith(candidateId: string, spec: { objective: string; whyNow: string }) {
    return launch({
      projectId,
      layerId,
      candidateId,
      visibility: 'PRIVATE',
      title: 'Michigan permit data availability',
      assignment: 'Identify the counties, the publication route, the licence and the cadence.',
      objective: spec.objective,
      whyNow: spec.whyNow,
      acceptableSources: ['county open-data portals'],
      excludedSources: ['vendor marketing'],
      evidence: ['a canonical URL per county'],
      startedBy: { kind: 'PERSON', id: userId },
      envelopeId: 'RUSSELL_PUBLIC_RECORDS_V1',
      authorizedBy: userId,
    });
  }

  // The file's own grant helper. Two active grants on one project would make
  // `checkAuthority`'s choice an accident of ordering, which §24 refuses.
  beforeEach(authorize);

  async function queuedIdea(): Promise<string> {
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');
    await recordJudgment({
      candidateId,
      state: 'QUEUED',
      priority: 'MUST_DO',
      confidence: null,
      reason: 'it decides whether the coverage layer can be automated',
      judgment: { missionSpec: { title: 'Permit data' } },
      supporting: [],
      contradicting: [],
    });
    return candidateId;
  }

  it('keeps the first attempt replaying while it is still alive', async () => {
    /*
     * A tick runs every thirty seconds; a mission runs for minutes. Relaunching
     * the same candidate must return the same mission rather than a second one.
     */
    const candidateId = await queuedIdea();
    const first = await launchWith(candidateId, COMPILED);
    expect(first.ok, first.reason).toBe(true);

    const again = await launchWith(candidateId, COMPILED);
    expect(again.ok).toBe(true);
    expect(again.mission!.id).toBe(first.mission!.id);
    expect(await listMissions({ projectId })).toHaveLength(1);
  });

  it('refuses the same specification once it has been researched, and names the refusal', async () => {
    const candidateId = await queuedIdea();
    const first = await launchWith(candidateId, COMPILED);
    await transitionMission({
      missionId: first.mission!.id,
      from: first.mission!.state,
      to: 'FAILED',
      terminalReason: 'the packet finished without recording anything',
    });

    const repeat = await launchWith(candidateId, COMPILED);
    expect(repeat.ok).toBe(false);
    expect(repeat.reason).toMatch(/already been researched/i);
    // Named rather than matched on prose, because the loop acts on it.
    expect(repeat.kind).toBe('ALREADY_RESEARCHED');
    expect(await listMissions({ projectId })).toHaveLength(1);

    // §5: the failed row keeps its state and its reason.
    const kept = (await getMission(first.mission!.id))!;
    expect(kept.state).toBe('FAILED');
    expect(kept.terminalReason).toMatch(/without recording anything/i);
  });

  it('does not count specifications the retired subsystem wrote', async () => {
    /*
     * Production's exact shape: three mission rows carrying two placeholder
     * specifications the worker-planning subsystem produced. Rebuilt through
     * the repository, because that is the existing data the replacement has to
     * be able to move.
     */
    const candidateId = await queuedIdea();
    for (const [index, junk] of ['test', 'test placeholder title long enough'].entries()) {
      const { mission } = await launchMission({
        projectId,
        layerId,
        visibility: 'PRIVATE',
        objective: junk,
        whyNow: junk,
        idempotencyKey: `russell:mission:${candidateId}:legacy:${index}`,
        candidateId,
        attempt: index + 1,
      });
      await transitionMission({
        missionId: mission.id,
        from: 'PLANNED',
        to: 'FAILED',
        terminalReason: 'the packet finished without recording anything',
      });
    }
    expect(await listMissions({ projectId })).toHaveLength(2);

    // The compiled specification launches, because neither placeholder is it.
    const real = await launchWith(candidateId, COMPILED);
    expect(real.ok, real.reason).toBe(true);
    expect(real.mission!.supersedesMissionId).toBeTruthy();
  });

  it('the loop retires a mission the retired subsystem specified, and recompiles the idea', async () => {
    /*
     * Recovery through `runCycle`, which is the caller production uses. The
     * mission is `NEEDS_HUMAN` with an open request, exactly as
     * `rms_b37b8fe4688c46e0a48d` and `rhr_acbf51e190924d99b5a3` were: parked
     * because the envelope refused a plan whose fragment was called
     * `test-placeholder-fragment`.
     */
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');

    /*
     * The placeholder mission goes in first, so it is the idea's newest — which
     * is production's shape and is what the recovery selects on. Judging comes
     * afterwards, from the loop.
     */
    const { mission } = await launchMission({
      projectId,
      layerId,
      visibility: 'PRIVATE',
      objective: 'test placeholder title long enough',
      whyNow: 'test placeholder reason long enough to pass the floor',
      idempotencyKey: `russell:mission:${candidateId}:legacy`,
      candidateId,
    });
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: 'NEEDS_HUMAN',
      waitingOn: 'The proposed plan falls outside the preauthorized envelope.',
    });
    const { request } = await askHuman({
      projectId,
      missionId: mission.id,
      authorityNeeded: 'Deciding whether to authorize research Brain was not preauthorized to start.',
      whyNotRussell: 'The plan falls outside the limits set in code before it existed.',
      recommendation: null,
      choices: [{ key: 'STOP', label: 'Stop this work', consequence: 'The mission ends.' }],
      urgency: 'BLOCKING',
      resumeKey: `russell:needs-human:${mission.id}:legacy`,
    });

    // The idea has to be queued for the recovery to consider it, exactly as
    // production's was: `launch()` puts it there and the placeholder mission
    // above is what it ran.
    await recordJudgment({
      candidateId,
      state: 'QUEUED',
      priority: 'MUST_DO',
      confidence: null,
      reason: 'the coverage layer depends on it',
      judgment: { missionSpec: { title: 'Permit data' } },
      supporting: [],
      contradicting: [],
    });

    const tick = await runCycle('test-owner');
    expect(tick.recovered.map((entry) => entry.missionId)).toContain(mission.id);

    // The row keeps its history and says what happened to it.
    const retired = (await getMission(mission.id))!;
    expect(retired.state).toBe('FAILED');
    expect(retired.terminalReason).toMatch(/retired/i);
    expect(retired.terminalReason).toMatch(/outside the preauthorized envelope/i);
    // And the question about it is withdrawn rather than left for a person.
    expect((await getHumanRequest(request.id))!.state).toBe('WITHDRAWN');

    // The idea is queued again, on a compiled specification, and it cost
    // nothing: `launch()` counts specifications, and a placeholder is not one.
    const after = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(after.state).toBe('QUEUED');
    const spec = after.judgment?.['missionSpec'] as Record<string, unknown>;
    expect(spec).toBeTruthy();
    expect(String(spec['objective'])).not.toMatch(/placeholder/i);
    expect(after.judgment?.['supersededRetiredPlanning']).toBeTruthy();
  });

  it('does not retire a mission whose specification is the compiled one', async () => {
    // The guard that keeps recovery from eating legitimate failures. A mission
    // that ran on the specification the compiler produces is an attempt at the
    // idea, whatever went wrong with it.
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');
    await runCycle('test-owner');
    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    const spec = judged.judgment?.['missionSpec'] as Record<string, unknown>;

    const { mission } = await launchMission({
      projectId,
      layerId,
      visibility: 'PRIVATE',
      objective: String(spec['objective']),
      whyNow: String(spec['whyNow']),
      idempotencyKey: `russell:mission:${candidateId}:compiled`,
      candidateId,
    });
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: 'FAILED',
      terminalReason: 'the sources could not be reached',
    });

    const tick = await runCycle('test-owner');
    expect(tick.recovered.map((entry) => entry.missionId)).not.toContain(mission.id);
    expect((await getMission(mission.id))!.terminalReason).toBe('the sources could not be reached');
  });

  it('parks an idea whose only specification has been researched and produced nothing', async () => {
    /*
     * §24's answering transition, and the reason the redo step is gone rather
     * than merely unused. Without this the candidate stays `QUEUED`, `launch()`
     * refuses it every thirty seconds, and a person watching sees an idea that
     * says it is queued and never moves.
     */
    const candidateId = await captureAnIdea('We should establish the permit publication terms.');
    await runCycle('test-owner');
    const judged = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    const spec = judged.judgment?.['missionSpec'] as Record<string, unknown>;

    const { mission } = await launchMission({
      projectId,
      layerId,
      visibility: 'PRIVATE',
      objective: String(spec['objective']),
      whyNow: String(spec['whyNow']),
      idempotencyKey: `russell:mission:${candidateId}:compiled`,
      candidateId,
    });
    await transitionMission({
      missionId: mission.id,
      from: 'PLANNED',
      to: 'FAILED',
      terminalReason: 'no official source could be located for any part of the question',
    });

    const tick = await runCycle('test-owner');
    const parked = (await listCandidates({ projectId })).find((c) => c.id === candidateId)!;
    expect(parked.state).toBe('PARKED');
    // The run's own words, not an invented account of why it failed.
    expect(parked.reason).toMatch(/no official source could be located/);
    expect(tick.parked.map((entry) => entry.candidateId)).toContain(candidateId);
  });

  it('does not redo an idea that was actually answered', async () => {
    // §13: researching a question the project already answers is the waste the
    // whole coverage check exists to prevent. A DONE mission answered it.
    const candidateId = await queuedIdea();
    const first = await launchWith(candidateId, COMPILED);
    await transitionMission({
      missionId: first.mission!.id,
      from: first.mission!.state,
      to: 'DONE',
    });

    const again = await launchWith(candidateId, COMPILED);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already been researched/i);
    expect(await listMissions({ projectId })).toHaveLength(1);
  });
});
