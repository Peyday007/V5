/**
 * The whole journey, once, through the entry points production uses.
 *
 * `russellConnectedPath.test.ts` proves capture reaches a mission.
 * `russellNervousSystem.test.ts` proves each service in isolation. Neither
 * walks the *whole* thing, and walking it is what found the four defects this
 * change repairs — every one of them a transition with no production caller,
 * invisible to a test that arranges its own starting state:
 *
 *   - nothing ever wrote `russell_candidate_merges.method = 'SEMANTIC'`, so a
 *     reworded question always became a second idea;
 *   - `overrideJudgment` had no route, so a person could not disagree;
 *   - `setNextMission` had no caller, so `next_mission_id` could only be null;
 *   - `askHuman` had no caller and nothing put a mission into `NEEDS_HUMAN`,
 *     so the resume that existed had nothing to resume;
 *   - and a settled probe was read by nothing, so an idea judged `EXPLORE`
 *     was selected by neither `exploring()` nor `nextLaunchable()` and stayed
 *     there permanently.
 *
 * **Only the worker and the network are simulated.** A worker answers by
 * submitting a unit result and completing its bin, exactly as a Cowork session
 * does over MCP; the probe's fetch is scripted. Everything between is the real
 * loop, the real validators, the real repositories and the real guards. No test
 * here writes a row it then asserts, and no branch is forced: where a decision
 * belongs to a worker, the fixture makes the decision a worker would and the
 * test checks what Brain did with it.
 *
 * The one branch that is *not* here is the person's override, which lives in
 * `russellHttp.test.ts` against a booted server — the route is the production
 * caller, so proving it in-process would prove less.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createUser,
  createWorker,
  grantMembership,
  issueWorkerCredential,
} from '../server/repos/identity.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createConversation } from '../server/repos/russellConversations.ts';
import { beginTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { PLAN_UNIT_KEY } from '../server/services/russell/planning.ts';
import { getCandidate, listMergeHistory } from '../server/repos/russellCandidates.ts';
import { assignNextBin, putBinUnitResult, releaseBin } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { hashUnitValue } from '../server/services/bins/contracts.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { tick, type TickReport } from '../server/services/russell/loop.ts';
import {
  answerHumanRequest,
  getMission,
  listMissions,
  listOpenRequests,
} from '../server/repos/russellMissions.ts';
import { NEEDS_HUMAN_CHOICES } from '../server/services/russell/needsHuman.ts';
import {
  createFragments,
  finishPass,
  getOrchestration,
  startPass,
  updateOrchestration,
} from '../server/repos/research.ts';
import { listProbesForCandidate } from '../server/repos/russellProbes.ts';
import { ideaMapForProject } from '../server/services/russell/ideas.ts';
import { clearsFloor } from '../server/services/russell/similarity.ts';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { russellRouter } from '../server/routes/russell.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

/*
 * The frozen acceptance subject, verbatim from
 * `docs/STEP-12A-ACCEPTANCE-SCENARIO-2.md` §3 — declared before any of this
 * code existed, which is what makes it a fixture rather than a shape chosen to
 * fit the implementation.
 */
const ASKED =
  'Do the counties we care about publish property tax assessment rolls in a form we could ' +
  'actually consume — a bulk download or an API — and on what terms? I want to know before ' +
  'we lean on it for valuation.';
const ASKED_AGAIN =
  'Asking again another way: is assessment roll data available anywhere in bulk or by API, ' +
  'and are we permitted to use it?';

let fixture: Awaited<ReturnType<typeof freshProject>>;
let projectId = '';
let userId = '';
let conversationId = '';
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `journey-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: userId,
    role: 'MEMBER',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const conversation = await createConversation({
    ownerUserId: userId,
    title: 'Assessment rolls',
    projectId,
    // SHARED rather than PRIVATE so the visibility inherited all the way down
    // to the follow-on is a real value rather than the default.
    visibility: 'SHARED',
  });
  conversationId = conversation.id;
  realFetch = globalThis.fetch;
});

/**
 * The standing authority, with the limits the owner approved for the live run:
 * two missions, one at a time.
 *
 * Those two numbers are the whole budget of this journey — the mission and its
 * one follow-on — so a second follow-on, or a duplicate launch, would be
 * refused by the ceiling rather than by anything this test asserts.
 */
async function authorize(): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Deal Dispatch discovery research',
    allowedWork: ['RESEARCH'],
    maxMissions: 2,
    maxFragments: 12,
    maxConcurrent: 1,
    maxProbes: 3,
  });
}

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
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

/**
 * The real Russell router, mounted in process, behind a real request context.
 *
 * Not a convenience: the whole point of this pass is which transitions have a
 * production caller, and for `overrideJudgment` the production caller *is* the
 * route. Calling the repository function directly would prove the same thing
 * the defect proved — that a function works and nothing reaches it.
 *
 * `russellHttp.test.ts` proves the gate on these routes against a booted
 * server, which is where an authorization failure would actually show up. This
 * proves what the route does once through it.
 */
async function withRoutes<T>(
  fn: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      // As routed, which is what the access requirement is looked up by.
      path: `/api/russell${req.path}`,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api/russell', russellRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({
      error: String(error?.message ?? error),
    });
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/russell${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* left as text */
      }
      return { status: response.status, body: parsed as any };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * A worker taking one bin all the way: assigned, submitted, completed.
 *
 * The real sequence, because the loop selects on `bins.state` — a unit result
 * on its own leaves the bin READY and nothing downstream ever sees it.
 */
async function workerAnswers(
  binId: string,
  unitKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const workerId = (
    await createWorker({
      name: `worker-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;
  /*
   * Ask until the wanted bin is offered, releasing the others untouched.
   *
   * By this point in the journey the project holds more than one claimable bin
   * — a mission's own research bin sits READY beside the planning bin — and a
   * real fleet has more than one worker asking. Releasing rather than
   * completing is what a worker does with work it is not doing, and it leaves
   * every other bin exactly where it was.
   */
  let assigned: Awaited<ReturnType<typeof assignNextBin>> = null;
  const setAside: NonNullable<Awaited<ReturnType<typeof assignNextBin>>>[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const offered = await assignNextBin({ workerId, projectIds: [projectId] });
    if (!offered) break;
    if (offered.bin.id === binId) {
      assigned = offered;
      break;
    }
    setAside.push(offered);
  }
  for (const other of setAside) {
    await releaseBin({
      binId: other.bin.id,
      leaseId: other.leaseId,
      leaseGeneration: other.leaseGeneration,
      workerId,
    });
  }
  if (!assigned) throw new Error(`bin ${binId} was never offered`);
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
  await requestCompletion({
    workerId,
    proof: { binId, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId },
  });
}

/** The person says something; a worker answers the turn; the loop applies it. */
async function personAsks(
  content: string,
  proposal: Record<string, unknown>,
): Promise<TickReport> {
  const started = await beginTurn({ principal: principal(), conversationId, content });
  expect(started.binId).toBeTruthy();
  await workerAnswers(started.binId!, TURN_UNIT_KEY, proposal);
  /*
   * One tick, which applies the turn *and* judges what it captured.
   *
   * Step 1d runs after 1b in the same pass, deliberately: an idea captured this
   * tick is judged this tick rather than next. So the report this returns is
   * where a first judgment shows up — asking for it on a later tick would find
   * nothing and prove the opposite of what it looked like.
   */
  return tick('journey');
}

/** The planning bin the loop most recently opened for this candidate. */
async function planBinFor(candidateId: string): Promise<string> {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM bins
      WHERE created_by_id LIKE ? AND state NOT IN ('CANCELLED','FAILED','COMPLETE')
      ORDER BY rowid DESC LIMIT 1`,
    [`russell:plan:${candidateId}%`],
  );
  const found = rows[0];
  if (!found) throw new Error(`no open plan bin for ${candidateId}`);
  return found.id;
}

function plan(options: {
  cheapToReduce: boolean;
  expectedValue: number;
  followOn?: { title: string; question: string; whyNow: string } | null;
}): Record<string, unknown> {
  return {
    observations: {
      cheapToReduce: options.cheapToReduce,
      expectedValue: options.expectedValue,
      blockedBy: null,
    },
    mission: {
      title: 'Assessment roll availability',
      objective:
        'Establish which counties publish assessment rolls in bulk or by API, and on what terms.',
      assignment:
        'For each county in scope, identify the publication route, the licence and the cadence.',
      whyNow: 'Valuation would otherwise rest on an assumption about availability.',
      acceptableSources: ['county assessor sites', 'state open-data portals'],
      excludedSources: ['data resellers'],
      evidence: ['a canonical URL per county', 'the licence terms as published'],
      ...(options.followOn === undefined
        ? {}
        : { followOn: options.followOn }),
    },
  };
}

/** Every source answers with text about the subject, so the probe can settle. */
function scriptFetch(body: string): void {
  globalThis.fetch = (async () => ({
    status: 200,
    headers: { get: () => null },
    text: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/**
 * Three completed audit passes in three distinct authenticated sessions, with
 * the lineage the independence evaluator actually reads.
 *
 * Built the way `tests/independenceEvidence.test.ts` builds it, because that is
 * the shape production has to produce: real workers, a real Routine binding,
 * real issued credentials standing in for the sessions, and a judge whose pass
 * completes after both arguments.
 */
async function threeSessionAudit(orchestrationId: string): Promise<string[]> {
  const account = (await createAccount({ name: `acct-${Math.random().toString(36).slice(2, 8)}` })).id;
  const worker = (
    await createWorker({ name: `auditor-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' })
  ).id;
  await createRoutine({
    accountId: account,
    routineRef: `trig-${Math.random().toString(36).slice(2, 8)}`,
    name: 'V1',
    tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
    tokenDigest: `digest-${Math.random().toString(36).slice(2, 10)}`,
    workerId: worker,
  });

  const sessions: string[] = [];
  for (const [ordinal, role] of [
    [5, 'PRIMARY'],
    [6, 'ADVERSARIAL'],
    [7, 'JUDGE'],
  ] as const) {
    const session = (
      await issueWorkerCredential({ workerId: worker, issuedByType: 'SYSTEM', issuedById: 't' })
    ).credential.id;
    sessions.push(session);
    const pass = await startPass({
      orchestrationId,
      passKey: 'AUDIT',
      ordinal,
      provider: 'WORKER',
      prompt: `audit:${role}`,
      promptSha256: 'a'.repeat(64),
      executorWorkerId: worker,
      executorAccountId: account,
      executorSessionRef: session,
    });
    await finishPass(pass.id, { status: 'COMPLETE' });
  }
  return sessions;
}

describe('one question, walked the whole way', () => {
  it('captures, dedupes by meaning, explores, launches, parks, resumes, files and follows on', async () => {
    await authorize();

    /* ---------------------------------------------------------------- 1 */
    // Capture. A worker reads the person's question and proposes an idea.
    const firstTick = await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted — I have written that down as something to settle.',
      confidence: 70,
      candidate: {
        title: 'Assessment roll availability',
        statement: 'establish whether counties publish assessment rolls in bulk or by API, and on what terms',
      },
    });

    const afterCapture = await getDb().all<{ id: string; canonical_candidate_id: string | null }>(
      `SELECT id, canonical_candidate_id FROM russell_candidates WHERE project_id = ?`,
      [projectId],
    );
    expect(afterCapture).toHaveLength(1);
    const candidateId = afterCapture[0]!.id;
    // A new canonical idea, which is condition 3's shape: nothing it could have
    // merged into existed.
    expect(afterCapture[0]!.canonical_candidate_id).toBeNull();

    /* ---------------------------------------------------------------- 2 */
    /*
     * The same question, reworded so no fingerprint can match it.
     *
     * The worker names the idea it repeats; Brain re-resolves that id in scope
     * and holds the two statements to the floor before merging. Both halves
     * matter: the claim alone would let a model fold unrelated ideas together,
     * and the floor alone cannot recognise a rewording.
     */
    await personAsks(ASKED_AGAIN, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'That is the same question — I have folded it into the one already on the list.',
      candidate: {
        title: 'Assessment rolls in bulk',
        statement: 'is assessment roll data available in bulk or by API, and are we permitted to use it',
        duplicateOf: candidateId,
      },
    });

    const all = await getDb().all<{ id: string; canonical_candidate_id: string | null }>(
      `SELECT id, canonical_candidate_id FROM russell_candidates WHERE project_id = ? ORDER BY rowid`,
      [projectId],
    );
    // Two rows, one canonical. A merge is a pointer a person can undo, never a
    // deletion — the second question keeps its own row and its own wording.
    expect(all).toHaveLength(2);
    expect(all[0]!.canonical_candidate_id).toBeNull();
    expect(all[1]!.canonical_candidate_id).toBe(candidateId);

    const merges = await listMergeHistory(all[1]!.id);
    expect(merges).toHaveLength(1);
    // Condition 4's exact requirement. A FINGERPRINT here would prove nothing.
    expect(merges[0]!.method).toBe('SEMANTIC');
    expect(merges[0]!.reason).toMatch(/different words/);

    /* ---------------------------------------------------------------- 3 */
    /*
     * Judgment. The archive does not answer it, so a worker reads the question.
     *
     * `firstTick` is the tick inside the *first* `personAsks`: capture and
     * judgment happen in one pass, so this is the report that carries it.
     */
    expect(firstTick.planning).toContain(candidateId);
    expect(firstTick.answeredByArchive).not.toContain(candidateId);

    await workerAnswers(
      await planBinFor(candidateId),
      PLAN_UNIT_KEY,
      plan({ cheapToReduce: true, expectedValue: 70 }),
    );
    /*
     * One tick again, and again because the ordering is deliberate: 1c takes
     * the finished plan, and 3b opens the probe for whatever that judgment sent
     * to EXPLORE. So the network has to be scripted before this call rather
     * than before a later one — the bounded look happens inside it.
     */
    scriptFetch(
      'Counties publish assessment rolls in bulk and by API. This page establishes ' +
        'whether assessment roll data is available for bulk download, and on what terms ' +
        'the licence permits reuse.',
    );
    let judged: TickReport;
    try {
      judged = await tick('journey');
    } finally {
      restoreFetch();
    }
    expect(judged.judged).toHaveLength(1);

    const explored = (await getCandidate(candidateId))!;
    // Condition 5: a priority *and* the reason it was given, both on the row.
    expect(explored.priority).toBe('EXPLORE');
    expect(explored.reason).toMatch(/cheap/i);

    /* ---------------------------------------------------------------- 4 */
    // The bounded look, opened and run by the loop inside its envelope.
    expect(judged.probed).toHaveLength(1);

    const probes = await listProbesForCandidate(candidateId);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.state).toBe('COMPLETE');
    expect(probes[0]!.outcome).toBe('SUPPORTED');

    /* ---------------------------------------------------------------- 5 */
    /*
     * And the look decides something.
     *
     * Before this repair the journey ended here: `exploring()` skips a
     * candidate that already has a probe and `nextLaunchable()` reads only
     * QUEUED, so the idea sat at EXPLORE with its answer beside it, selected by
     * nothing, forever.
     */
    const deciding = await tick('journey');
    expect(deciding.planning).toContain(candidateId);

    const secondPass = await planBinFor(candidateId);
    // The verdict reached the worker, rather than the second pass asking the
    // same question with none of what the first one bought.
    const bin = await getDb().all<{ manifest: string }>(`SELECT manifest FROM bins WHERE id = ?`, [
      secondPass,
    ]);
    expect(bin[0]!.manifest).toMatch(/BOUNDED LOOK HAS ALREADY BEEN TAKEN[\s\S]*SUPPORTED/);

    await workerAnswers(
      secondPass,
      PLAN_UNIT_KEY,
      plan({
        // Answered honestly by a worker that has read the verdict. Brain
        // overrides it to false regardless, which is what stops the idea
        // looping back to EXPLORE and being probed again.
        cheapToReduce: true,
        expectedValue: 85,
        followOn: {
          title: 'Terms of use for the publishing counties',
          question:
            'Record the terms of use for whichever counties were found to publish, so a later design knows what it may rely on.',
          whyNow: 'A design that relies on this data has to know what the licence permits.',
        },
      }),
    );
    const queued = await tick('journey');
    expect(queued.judged).toHaveLength(1);

    const readyToLaunch = (await getCandidate(candidateId))!;
    expect(readyToLaunch.state).toBe('QUEUED');
    expect(readyToLaunch.priority).toBe('MUST_DO');

    /* ---------------------------------------------------------------- 6 */
    /*
     * One mission, one orchestration, one bin, one reservation — launched by
     * the same tick that queued it, because step 4 follows 1c in one pass. The
     * loop is deliberately eager: an idea that becomes launchable does not
     * wait a cycle for somebody to notice.
     */
    expect(queued.launched).toHaveLength(1);

    const missions = await listMissions({ projectId });
    expect(missions).toHaveLength(1);
    const mission = missions[0]!;
    expect(mission.orchestrationId).toBeTruthy();
    expect(mission.candidateId).toBe(candidateId);
    /*
     * Exactly one reservation for this launch, and it is keyed by the mission
     * rather than by the attempt — which is what makes a retried launch one
     * mission rather than two.
     */
    const reservations = await getDb().all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM russell_budget_reservations WHERE kind = 'MISSION'`,
    );
    expect(Number(reservations[0]!.n)).toBe(1);

    /* ---------------------------------------------------------------- 7 */
    // Three audit roles in three distinct authenticated sessions.
    const sessions = await threeSessionAudit(mission.orchestrationId!);
    expect(new Set(sessions).size).toBe(3);

    /* ---------------------------------------------------------------- 8 */
    /*
     * A genuine out-of-authority decision: the packet stops because its
     * evidence bar was not met and its repair ladder is spent, which is a
     * decision about what the project will rely on rather than a fault.
     *
     * The stop is written by the runner. Everything after it — the mission
     * parking, the request, the person's answer reaching the packet — is the
     * loop.
     */
    /*
     * With the research the stop presupposes.
     *
     * This step used to park a packet holding no fragments at all and then
     * answer RECORD_GAPS on it — recording unresolved questions about nothing.
     * Production produced that shape for real on 2026-09-07 and the mismatch
     * was invisible here, so the fixture now has to build the state its own
     * failure reason describes.
     */
    await createFragments([
      {
        orchestrationId: mission.orchestrationId!,
        projectId,
        layerId: (await fixture.layerByName('Discovery Logic')).id,
        fragmentIndex: 0,
        fragmentKey: 'permit-coverage',
        question: 'Which counties publish permit data, and on what terms?',
        geography: 'Michigan',
        requiredEvidence: [
          { id: 'operative_definition', description: 'the county portal', necessity: 'REQUIRED' },
        ],
        acceptableSourceTypes: ['county government portals'],
        excludedSourceTypes: ['vendor marketing'],
        completionCriteria: ['a named portal per county'],
        minIndependentSources: 1,
        maxRepairs: 2,
        dependsOn: [],
        attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    await updateOrchestration(mission.orchestrationId!, {
      status: 'NEEDS_HUMAN',
      failureReason:
        'One county publishes only through a source class outside the authorized allowlist. ' +
        'Broadening it is not Russell to decide.',
    });

    const parked = await tick('journey');
    expect(parked.needsHuman.map((entry) => entry.missionId)).toContain(mission.id);
    expect((await getMission(mission.id))!.state).toBe('NEEDS_HUMAN');

    const open = await listOpenRequests(projectId);
    expect(open).toHaveLength(1);
    const request = open[0]!;
    expect(request.missionId).toBe(mission.id);
    // The choices offered are the ones Brain implements, which is the property
    // the whole park depends on: an escalation whose answer does nothing is
    // the defect, one level up.
    expect(request.choices.map((choice) => choice.key).sort()).toEqual(
      Object.keys(NEEDS_HUMAN_CHOICES).sort(),
    );

    /* ---------------------------------------------------------------- 9 */
    // The person decides, and the same mission resumes.
    await answerHumanRequest({
      requestId: request.id,
      actorUserId: userId,
      choice: NEEDS_HUMAN_CHOICES.RECORD_GAPS.key,
    });
    const resumed = await tick('journey');
    expect(resumed.resumed).toContain(request.id);

    const sameMission = (await getMission(mission.id))!;
    expect(sameMission.id).toBe(mission.id);
    expect(sameMission.state).not.toBe('NEEDS_HUMAN');
    expect(await listMissions({ projectId })).toHaveLength(1);

    // And the decision reached the packet rather than only the mission.
    const authorized = await getOrchestration(mission.orchestrationId!);
    expect(authorized!.unresolvedGapPolicy).toBe('RECORD_GAPS');
    expect(authorized!.unresolvedGapAuthorizedBy).toBe(userId);

    /* --------------------------------------------------------------- 10 */
    // The packet reaches terminal and files. The writeback happens once.
    const filed = await addDocument(fixture, 'Discovery Logic', 'v1', { withFile: true });
    await updateOrchestration(mission.orchestrationId!, {
      status: 'COMPLETE_WITH_GAPS',
      documentId: filed.id,
    });
    await getDb().run(`UPDATE russell_missions SET document_id = ? WHERE id = ?`, [
      filed.id,
      mission.id,
    ]);

    const writingBack = await tick('journey');
    expect(writingBack.wroteBack).toContain(mission.id);
    expect((await getMission(mission.id))!.state).toBe('DONE');

    const again = await tick('journey');
    expect(again.wroteBack).not.toContain(mission.id);

    /* --------------------------------------------------------------- 11 */
    /*
     * The follow-on the plan declared, created as an *idea*.
     *
     * Not a mission: the parent has just filed into this project's archive, so
     * invariant 13 applies to the question it left open exactly as it does to a
     * first one. It is judged, planned and launched through the same path
     * everything else takes, and only when it launches does the parent learn
     * its `next_mission_id`.
     */
    /*
     * Created by the same tick that wrote back, and deliberately not inside the
     * writeback's own claimed window: a crash between claiming the writeback
     * and creating the idea would lose the follow-on permanently, with nothing
     * left to notice it. Here the query asks again every tick until it lands.
     */
    expect(writingBack.followOns.map((entry) => entry.missionId)).toContain(mission.id);
    const followOnId = writingBack.followOns[0]!.candidateId;
    const followOn = (await getCandidate(followOnId))!;
    expect(followOn.followOnOfMissionId).toBe(mission.id);
    expect(followOn.visibility).toBe('SHARED');
    expect(followOn.priority).toBeNull();

    // Judged, planned, queued and launched — the ordinary path, with no
    // follow-on of its own, so the chain ends here rather than recurring.
    await tick('journey');
    await workerAnswers(
      await planBinFor(followOnId),
      PLAN_UNIT_KEY,
      plan({ cheapToReduce: false, expectedValue: 65, followOn: null }),
    );
    const launchedFollowOn = await tick('journey');
    expect((await getCandidate(followOnId))!.state).toBe('QUEUED');
    expect(launchedFollowOn.launched).toHaveLength(1);
    expect(launchedFollowOn.linkedNext).toEqual([
      { missionId: mission.id, nextMissionId: launchedFollowOn.launched[0]! },
    ]);

    // Condition 15, from the row it is actually read from.
    const parent = (await getMission(mission.id))!;
    expect(parent.nextMissionId).toBe(launchedFollowOn.launched[0]!);

    // And exactly one. A further tick creates no second follow-on for either
    // mission, and links nothing further.
    const settled = await tick('journey');
    expect(settled.followOns).toHaveLength(0);
    expect(settled.linkedNext).toHaveLength(0);
    expect(await listMissions({ projectId })).toHaveLength(2);
  }, 60_000);
});

describe('a person disagrees with Russell', () => {
  /*
   * Condition 5's second half: an override *supersedes* rather than erases.
   *
   * `overrideJudgment` has existed since Phase 1 and no request could reach it,
   * so the property was true of a function nobody could call. This drives the
   * route.
   */
  it('supersedes the stored judgment and keeps what it replaced', async () => {
    await authorize();
    await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'Assessment roll availability',
        statement: 'establish whether counties publish assessment rolls in bulk or by API',
      },
    });
    const rows = await getDb().all<{ id: string }>(
      `SELECT id FROM russell_candidates WHERE project_id = ?`,
      [projectId],
    );
    const candidateId = rows[0]!.id;
    await workerAnswers(
      await planBinFor(candidateId),
      PLAN_UNIT_KEY,
      plan({ cheapToReduce: false, expectedValue: 40 }),
    );
    await tick('journey');

    const russellSaid = (await getCandidate(candidateId))!;
    expect(russellSaid.priority).toBe('WORTH_DOING');
    expect(russellSaid.reason).toBeTruthy();

    await withRoutes(async (call) => {
      const result = await call('POST', `/candidates/${candidateId}/judgment`, {
        priority: 'MUST_DO',
        state: 'QUEUED',
        reason: 'valuation is blocked on this, so it is not merely useful',
      });
      expect(result.status).toBe(200);
    });

    const overridden = (await getCandidate(candidateId))!;
    expect(overridden.priority).toBe('MUST_DO');
    expect(overridden.overrideUserId).toBe(userId);
    expect(overridden.overrideReason).toMatch(/valuation/);
    // Superseded, not erased: what Russell decided and why is still readable,
    // which is the only way anybody can later tell whether it was right.
    const superseded = JSON.parse(overridden.supersededDecision!);
    expect(superseded.priority).toBe('WORTH_DOING');
    expect(superseded.reason).toBe(russellSaid.reason);
  });

  it('refuses a priority, a state or a merge state it does not recognise', async () => {
    await authorize();
    await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: { title: 'A', statement: 'establish whether counties publish assessment rolls' },
    });
    const rows = await getDb().all<{ id: string }>(
      `SELECT id FROM russell_candidates WHERE project_id = ?`,
      [projectId],
    );
    const candidateId = rows[0]!.id;

    await withRoutes(async (call) => {
      for (const body of [
        { priority: 'VERY_IMPORTANT', state: 'QUEUED', reason: 'r' },
        { priority: 'MUST_DO', state: 'ON_FIRE', reason: 'r' },
        // A merge is a relationship between two rows. Setting the state alone
        // would leave an idea folded into nothing, which every downstream query
        // treats as invisible.
        { priority: 'MUST_DO', state: 'MERGED', reason: 'r' },
        { priority: 'MUST_DO', state: 'QUEUED' },
      ]) {
        const result = await call('POST', `/candidates/${candidateId}/judgment`, body);
        expect(result.status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  it('lets a person undo an automatic merge, and keeps the merge row', async () => {
    await authorize();
    await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'Assessment roll availability',
        statement: 'establish whether counties publish assessment rolls in bulk or by API',
      },
    });
    const first = (
      await getDb().all<{ id: string }>(`SELECT id FROM russell_candidates WHERE project_id = ?`, [
        projectId,
      ])
    )[0]!.id;

    await personAsks(ASKED_AGAIN, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Same question.',
      candidate: {
        title: 'Assessment rolls in bulk',
        statement: 'is assessment roll data available in bulk or by API',
        duplicateOf: first,
      },
    });
    const merged = (
      await getDb().all<{ id: string }>(
        `SELECT id FROM russell_candidates WHERE canonical_candidate_id = ?`,
        [first],
      )
    )[0]!.id;

    /*
     * The way back, which this change made necessary rather than optional.
     *
     * Every merge used to be an exact fingerprint match, which is effectively
     * never wrong. A SEMANTIC merge is a worker's judgement held to a floor, and
     * a judgement that can be wrong needs an undo — otherwise automatic
     * deduplication is a mechanism for quietly losing somebody's idea.
     */
    await withRoutes(async (call) => {
      const result = await call('POST', `/candidates/${merged}/split`, {
        reason: 'these are different questions about the same subject',
      });
      expect(result.status).toBe(200);
    });

    expect((await getCandidate(merged))!.canonicalCandidateId).toBeNull();
    /*
     * Both rows survive, in order: the automatic merge and the person undoing
     * it. Append-only, so "Russell folded these together and I pulled them
     * apart" is readable a year later — the merge is not deleted to make the
     * split tidy.
     */
    const history = await listMergeHistory(merged);
    expect(history.map((row) => [row.action, row.method])).toEqual([
      ['MERGE', 'SEMANTIC'],
      ['SPLIT', 'USER'],
    ]);
    expect(history[1]!.actor_user_id).toBe(userId);
  });
});

describe('a merge is visible, or it is not reversible', () => {
  /*
   * The half of deduplication that makes it safe.
   *
   * A fold nobody can see is a fold nobody can disagree with, so the map has to
   * show it — and show it as what it is. A `MERGED` candidate used to appear as
   * a peer node whose state label happened to read "merged", which is a fact
   * about a row rather than a shape a person can act on.
   */
  it('files a folded idea under the one it folded into, and says how many', async () => {
    await authorize();
    await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'Assessment roll availability',
        statement: 'establish whether counties publish assessment rolls in bulk or by API',
      },
    });
    const canonical = (
      await getDb().all<{ id: string }>(`SELECT id FROM russell_candidates WHERE project_id = ?`, [
        projectId,
      ])
    )[0]!.id;

    await personAsks(ASKED_AGAIN, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Same question.',
      candidate: {
        title: 'Assessment rolls in bulk',
        statement: 'is assessment roll data available in bulk or by API',
        duplicateOf: canonical,
      },
    });

    // Read as the person whose thread the ideas came from. The map is scoped
    // by viewer for the same reason every other read here is.
    const map = (await ideaMapForProject({ projectId, viewerUserId: userId, includePrivate: true }))!;
    const parent = map.nodes.find((node) => node.id === `idea:${canonical}`)!;
    const folded = map.nodes.find(
      (node) => node.level === 'REGULAR' && node.id !== `idea:${canonical}`,
    )!;

    expect(folded.parentId).toBe(`idea:${canonical}`);
    expect(parent.decision.mergedIn).toBe(1);
    expect(parent.counts.children).toBe(1);

    /*
     * And the two controls are offered exactly where the routes would accept
     * them. The override route's guard is `state <> 'MERGED'` and the split's
     * is the opposite; a screen that offered either one anywhere else would be
     * a button that fails.
     */
    expect(parent.decision.canOverride).toBe(true);
    expect(parent.decision.canSplit).toBe(false);
    expect(folded.decision.canOverride).toBe(false);
    expect(folded.decision.canSplit).toBe(true);
  });

  it('shows a person’s override on the node they overrode', async () => {
    await authorize();
    await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'Assessment roll availability',
        statement: 'establish whether counties publish assessment rolls in bulk or by API',
      },
    });
    const candidateId = (
      await getDb().all<{ id: string }>(`SELECT id FROM russell_candidates WHERE project_id = ?`, [
        projectId,
      ])
    )[0]!.id;
    await workerAnswers(
      await planBinFor(candidateId),
      PLAN_UNIT_KEY,
      plan({ cheapToReduce: false, expectedValue: 40 }),
    );
    await tick('journey');

    await withRoutes(async (call) => {
      const result = await call('POST', `/candidates/${candidateId}/judgment`, {
        priority: 'MUST_DO',
        state: 'QUEUED',
        reason: 'valuation is blocked on this',
      });
      expect(result.status).toBe(200);
    });

    const map = (await ideaMapForProject({ projectId, viewerUserId: userId, includePrivate: true }))!;
    const node = map.nodes.find((entry) => entry.id === `idea:${candidateId}`)!;
    expect(node.priority).toBe('MUST_DO');
    // Shown rather than swallowed: "Russell thought otherwise and I overruled
    // it" is the fact somebody needs a year later.
    expect(node.decision.overriddenReason).toMatch(/valuation/);
  });
});

describe('the floor under a semantic merge', () => {
  /*
   * The values in `similarity.ts` are not guessed, and this is where that claim
   * is checked. The frozen pair has to clear the floor and every other subject
   * this project holds has to be refused by it.
   */
  it('admits the frozen rewording and refuses every unrelated subject', () => {
    expect(clearsFloor(ASKED, ASKED_AGAIN).ok).toBe(true);

    for (const other of [
      'Is Michigan permit data machine-readable before any discovery design depends on it?',
      'How should we price the dispatch product for small brokerages?',
      'What qualification signals separate a real seller from a tyre-kicker?',
      'Do we have a way to reach assessors by email at scale?',
    ]) {
      expect(clearsFloor(ASKED, other).ok).toBe(false);
      expect(clearsFloor(ASKED_AGAIN, other).ok).toBe(false);
    }
  });

  it('is a guard rather than a decision, and a related question shows why', () => {
    /*
     * The follow-on's own objective clears the floor against its parent — 0.43,
     * on "county", "publish" and "term" — and that is correct behaviour for a
     * guard rather than a defect.
     *
     * Lexical overlap cannot tell "do they publish" from "on what terms do they
     * publish", and a floor tuned until it could would refuse the rewording it
     * exists to admit. Which is the point: the floor never merges anything. It
     * only ever refuses, and something that read both questions has to propose
     * the merge first.
     */
    const related = clearsFloor(
      ASKED,
      'Record the terms of use for whichever counties were found to publish.',
    );
    expect(related.ok).toBe(true);
    expect(related.score).toBeGreaterThan(0.34);
  });

  it('refuses a merge a worker proposes across scopes, and keeps both ideas', async () => {
    await authorize();
    /*
     * A worker naming an id that is real but not in this scope.
     *
     * The capture still happens — refusing the whole proposal would throw away
     * work over a bad reference — and both ideas stand. What is recorded is
     * that a merge was proposed and why the server did not make it.
     */
    await personAsks(ASKED, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'Assessment roll availability',
        statement: 'establish whether counties publish assessment rolls in bulk or by API',
      },
    });
    await personAsks(ASKED_AGAIN, {
      action: 'CAPTURE_CANDIDATE',
      answer: 'Noted.',
      candidate: {
        title: 'Assessment rolls in bulk',
        statement: 'is assessment roll data available in bulk or by API',
        // Well-formed and nonexistent, which is the same answer as one in
        // another project: resolvable ids and unresolvable ones are refused
        // identically, so this is never an oracle for what exists.
        duplicateOf: 'rcn_0123456789abcdef0123',
      },
    });

    const rows = await getDb().all<{ canonical_candidate_id: string | null }>(
      `SELECT canonical_candidate_id FROM russell_candidates WHERE project_id = ?`,
      [projectId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.canonical_candidate_id === null)).toBe(true);
  });
});
