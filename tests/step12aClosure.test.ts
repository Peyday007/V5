/**
 * The last four Step 12A conditions, and the two contradictions beside them.
 *
 * Each of these is a link that existed and could be reached by nothing, which
 * is the same shape §24 records four times over — so each is tested from the
 * production entrance rather than from a state a test arranged.
 *
 *   - `A07` needed an idea the judgment sent for a cheap look, and nothing
 *     could form that view after the compiler replaced the planning worker.
 *   - `A11` needed the account a pass executed under, and the static
 *     worker -> Routine binding cannot answer it once one worker is bound to
 *     two Routines — which is the shape production is in.
 *   - a terminal packet kept its claimable work, because only *advancing* a
 *     packet retires it and nothing advances one that has finished.
 *   - and an accepted fragment never moved its requirement's coverage, because
 *     the one function that does had a single caller and it was not the path
 *     production uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { judgeCandidate } from '../server/services/russell/planning.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { listProbesForCandidate, listObservations } from '../server/repos/russellProbes.ts';
import { addMessage, createConversation } from '../server/repos/russellConversations.ts';
import { tick } from '../server/services/russell/loop.ts';
import { GENERAL_LIGHT_PROBE_V1 } from '../server/services/russell/probeEnvelope.ts';
import {
  createAccount,
  createRoutine,
  bindRoutineWorker,
  getWorkerSession,
} from '../server/repos/fleet.ts';
import { lineageForWorker } from '../server/services/research/auditAdmission.ts';
import {
  createBin,
  ensureDispatchIntent,
  listDispatchesForBin,
  markDispatchRoutine,
  markDispatchSent,
} from '../server/repos/bins.ts';
import { checkIn } from '../server/services/bins/service.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createOrchestration,
  updateOrchestration,
  startPass,
  finishPass,
  getPass,
} from '../server/repos/research.ts';
import { recoverExecutionLineage } from '../server/services/dispatch/lineageRecovery.ts';
import { enqueueWork, getWorkItem, claimWork } from '../server/repos/workQueue.ts';
import {
  reconcileArguedAuditRoles,
  reconcileTerminalPackets,
} from '../server/services/research/packetRunner.ts';
import type { ExistingClaim, Principal } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';
let userId = '';

const realFetch = globalThis.fetch;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('World Model')).id;
  const owner = await createUser({
    email: 'closure-owner@example.test',
    displayName: 'The owner',
    password: 'a-long-enough-password',
    isBrainAdmin: false,
  });
  userId = owner.id;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function authorize(): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Step 12A closure',
    allowedWork: ['RESEARCH'],
    maxMissions: 1,
    maxFragments: 1,
    maxConcurrent: 1,
    maxProbes: 3,
  });
}

/* ------------------------------------------------------------------------- */
/* A07 — a bounded look, opened because there is something to look at         */
/* ------------------------------------------------------------------------- */

const STATEMENT =
  'establish whether a single statewide index of Michigan township assessing offices exists';

/**
 * One archive claim that answers the question and cites nothing.
 *
 * This is what `PRESENT_BUT_UNVERIFIED` means — "somebody wrote the answer down
 * and nothing supports it" — and it is the whole trigger. A claim with a real
 * source would settle the requirement instead.
 */
function unverifiedClaim(): ExistingClaim {
  return {
    id: 'clm_archive_unverified',
    projectId,
    documentId: 'doc_archive',
    layerId,
    claim: 'A single statewide index of Michigan township assessing offices exists.',
    claimType: 'FACT',
    sourceUrl: null,
    sourceTitle: null,
    passage: null,
    asOf: new Date().toISOString(),
    geography: 'Michigan',
    verificationState: 'UNVERIFIED',
    confidence: 0.4,
  } as unknown as ExistingClaim;
}

/** A destination that answers, so the probe settles rather than failing. */
function scriptedFetch(body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
}

describe('a cheap look comes first only when the archive holds something to check', () => {
  it('sends an idea to EXPLORE when the answer is written down and unsupported', async () => {
    await authorize();
    const captured = await capture({
      title: 'Statewide assessing-office index',
      statement: STATEMENT,
      projectId,
      visibility: 'PRIVATE',
    });
    const candidateId = captured.candidate!.id;

    const outcome = await judgeCandidate(candidateId, { claims: [unverifiedClaim()] });
    expect(outcome.answeredByArchive).toBe(false);

    const judged = (await getCandidate(candidateId))!;
    expect(judged.priority).toBe('EXPLORE');
    expect(judged.state).toBe('CAPTURED');
    // The label says what was assessed and from what. A `false` recorded as
    // `NOT_ASSESSED` was the honest answer while nothing could form the view.
    expect(judged.judgment?.['cheapToReduceAssessed']).toBe('ARCHIVE_HOLDS_UNVERIFIED_OR_STALE');
    expect(judged.judgment?.['expectedValueAssessed']).toBe('NOT_ASSESSED');
  });

  it('queues the same idea outright when the archive holds nothing to check', async () => {
    /*
     * The other half, and the one that stops this being "probe everything".
     * Same question, same code path, no unverified claim — and it goes straight
     * to work.
     */
    await authorize();
    const captured = await capture({
      title: 'Statewide assessing-office index',
      statement: STATEMENT,
      projectId,
      visibility: 'PRIVATE',
    });
    await judgeCandidate(captured.candidate!.id, { claims: [] });

    const judged = (await getCandidate(captured.candidate!.id))!;
    expect(judged.priority).not.toBe('EXPLORE');
    expect(judged.state).toBe('QUEUED');
    expect(judged.judgment?.['cheapToReduceAssessed']).toBe('ARCHIVE_HOLDS_NOTHING_TO_CHECK');
  });

  it('reads the question the person asked, not only the summary a worker wrote', async () => {
    /*
     * The production defect, in one test.
     *
     * `relevance` is the fraction of a requirement's terms found in a claim, so
     * a coverage verdict computed from `candidate.statement` alone rests on the
     * worker's choice of words. Here the person's own message says what the
     * archive's unchecked claim says and the statement does not — and before
     * this, Brain spent a research packet on a question it already held an
     * unchecked answer to.
     */
    await authorize();
    const conversation = await createConversation({
      ownerUserId: userId,
      title: 'A thread',
      projectId,
      visibility: 'PRIVATE',
    });
    const asked = await addMessage({
      conversationId: conversation.id,
      role: 'USER',
      content:
        'Does a single statewide index of Michigan township assessing offices exist, or did we ' +
        'only ever assume one does?',
    });
    const captured = await capture({
      title: 'The index question',
      statement: 'check the assumption we made earlier',
      projectId,
      visibility: 'PRIVATE',
      conversationId: conversation.id,
      sourceMessageId: asked.id,
    });
    const candidateId = captured.candidate!.id;

    await judgeCandidate(candidateId, { claims: [unverifiedClaim()] });

    const judged = (await getCandidate(candidateId))!;
    expect(judged.priority).toBe('EXPLORE');
    expect(judged.judgment?.['cheapToReduceAssessed']).toBe('ARCHIVE_HOLDS_UNVERIFIED_OR_STALE');
  });

  it('opens one probe through the loop, settles it, and does not open a second', async () => {
    await authorize();
    scriptedFetch('<html><body>Michigan assessor directory</body></html>');
    const captured = await capture({
      title: 'Statewide assessing-office index',
      statement: STATEMENT,
      projectId,
      visibility: 'PRIVATE',
    });
    const candidateId = captured.candidate!.id;
    await judgeCandidate(candidateId, { claims: [unverifiedClaim()] });

    // The loop opens it and runs it. Nothing here creates a probe.
    const first = await tick('closure');
    expect(first.probed).toHaveLength(1);

    const probes = await listProbesForCandidate(candidateId);
    expect(probes).toHaveLength(1);
    const probe = probes[0]!;
    expect(probe.state).toBe('COMPLETE');
    expect(probe.outcome).not.toBeNull();

    // Inside its bound: the observations table *is* the budget rather than a
    // log of it, so this is the spend rather than a report of the spend.
    const spent = (await listObservations(probe.id)).length;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(GENERAL_LIGHT_PROBE_V1.maxLookups);

    /*
     * A second tick must not buy the look again. `exploring()` skips a
     * candidate that already has a probe, so the allowance is spent once
     * however many ticks run.
     */
    const second = await tick('closure');
    expect(second.probed).toHaveLength(0);
    expect(await listProbesForCandidate(candidateId)).toHaveLength(1);
    expect((await listObservations(probe.id)).length).toBe(spent);
  });

  it('lets the settled probe decide, and does not send the idea back for another', async () => {
    await authorize();
    scriptedFetch('<html><body>Michigan assessor directory</body></html>');
    const captured = await capture({
      title: 'Statewide assessing-office index',
      statement: STATEMENT,
      projectId,
      visibility: 'PRIVATE',
    });
    const candidateId = captured.candidate!.id;
    await judgeCandidate(candidateId, { claims: [unverifiedClaim()] });
    await tick('closure');

    /*
     * The second judgment is what a probe is *for*. It reaches the same
     * `judgeCandidate` with the probe's verdict attached — and Brain forces
     * `cheapToReduce` false there, which is load-bearing now rather than
     * incidental: the archive has not changed, so re-deriving it would send the
     * idea round for another look for ever.
     */
    const decided = await tick('closure');
    expect(decided.planning.concat(decided.answeredByArchive)).toContain(candidateId);

    const after = (await getCandidate(candidateId))!;
    expect(after.priority).not.toBe('EXPLORE');
    expect(after.judgment?.['cheapToReduceAssessed']).toBe('SETTLED_BY_PROBE');
    expect(after.judgment?.['afterProbe']).toBeTruthy();

    // And no further probe, however many ticks run.
    await tick('closure');
    await tick('closure');
    expect(await listProbesForCandidate(candidateId)).toHaveLength(1);
  });
});

describe('an audit role that has been argued is retired by the tick', () => {
  /**
   * The reconciliation could not reach the state it was written for.
   *
   * `finishRecordedAuditRoles` runs inside `advancePacket`, and `advancePacket`
   * runs when something *completes* — which is exactly what stops happening
   * once a session submits its pass and leaves. In production the item lapsed,
   * the next arrival argued the same role again, and nothing ever advanced the
   * packet, so the fix sat in a function nothing was calling.
   *
   * A reconciliation that only runs when something else happens cannot reach a
   * state in which nothing is happening. So it is on the durable tick.
   */
  it('finds it from rows when nothing else is advancing the packet', async () => {
    const run = await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'anything',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'A packet whose adversarial role was argued and left open',
      assignment: 'the role is the subject',
      provider: 'WORKER',
      autoApprove: false,
    });
    await updateOrchestration(orchestration.id, { status: 'AUDITING', currentPass: 'AUDIT' });

    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'ADVERSARIAL' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
    });

    // The role was argued: a completed pass at the adversarial ordinal.
    const pass = await startPass({
      orchestrationId: orchestration.id,
      passKey: 'AUDIT',
      ordinal: 6,
      provider: 'WORKER',
      prompt: 'the adversarial argument',
      promptSha256: '1'.repeat(64),
    });
    await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });

    // And the session that argued it is gone: the item is claimable again.
    await getDb().run(`UPDATE work_items SET state = 'QUEUED' WHERE id = ?`, [item.id]);

    const swept = await reconcileArguedAuditRoles(10);
    expect(swept.map((entry) => entry.orchestrationId)).toContain(orchestration.id);
    const retired = (await getWorkItem(item.id))!;
    expect(retired.state).toBe('CANCELLED');
    expect(retired.cancelledReason).toMatch(/already been argued/i);

    // Idempotent: nothing left to select.
    expect(await reconcileArguedAuditRoles(10)).toHaveLength(0);
  });

  it('leaves an item alone while its own session still holds it', async () => {
    const run = await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'anything',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'A packet whose adversarial session is still working',
      assignment: 'the role is the subject',
      provider: 'WORKER',
      autoApprove: false,
    });
    await updateOrchestration(orchestration.id, { status: 'AUDITING', currentPass: 'AUDIT' });
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'ADVERSARIAL' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
    });
    const pass = await startPass({
      orchestrationId: orchestration.id,
      passKey: 'AUDIT',
      ordinal: 6,
      provider: 'WORKER',
      prompt: 'the adversarial argument',
      promptSha256: '2'.repeat(64),
    });
    await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });

    // Leased, and the lease has not lapsed: the contract asks that session to
    // complete its own item, which it cannot do if Brain retires it underneath.
    // A lease exists iff the item is LEASED, so all of it goes in one statement.
    const holder = await createWorker({
      name: 'still-arguing',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    await getDb().run(
      `UPDATE work_items
          SET state = 'LEASED',
              lease_id = ?,
              worker_id = ?,
              lease_generation = lease_generation + 1,
              lease_expires_at = ?
        WHERE id = ?`,
      [
        'wkl_stillworking',
        holder.id,
        new Date(Date.now() + 5 * 60_000).toISOString(),
        item.id,
      ],
    );

    expect(await reconcileArguedAuditRoles(10)).toHaveLength(0);
    expect((await getWorkItem(item.id))!.state).toBe('LEASED');
  });
});

/* ------------------------------------------------------------------------- */
/* A11 — the account a pass executed under                                    */
/* ------------------------------------------------------------------------- */

describe('the executing account is observed from the dispatch that fired the session', () => {
  /** Two accounts, two Routines, one worker — production's exact shape. */
  async function twoRoutinesOneWorker(): Promise<{ workerId: string; routineId: string; accountId: string }> {
    const worker = await createWorker({
      name: 'closure-worker',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const primary = await createAccount({ name: 'primary' });
    const friend = await createAccount({ name: 'friend-2' });
    const one = await createRoutine({
      accountId: primary.id,
      routineRef: 'V1',
      name: 'V1',
      tokenSecretName: 'V1_SECRET',
      tokenDigest: 'a'.repeat(64),
    });
    const two = await createRoutine({
      accountId: friend.id,
      routineRef: 'V2',
      name: 'V2',
      tokenSecretName: 'V2_SECRET',
      tokenDigest: 'b'.repeat(64),
    });
    await bindRoutineWorker(one.id, worker.id);
    await bindRoutineWorker(two.id, worker.id);
    return { workerId: worker.id, routineId: one.id, accountId: primary.id };
  }

  function principalFor(workerId: string, credentialId: string): Principal {
    return {
      type: 'WORKER',
      id: workerId,
      handle: 'closure-worker',
      displayName: 'closure-worker',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId,
      authMethod: 'WORKER_BEARER',
      memberships: [
        {
          projectId,
          principalType: 'WORKER',
          principalId: workerId,
          role: 'CONTRIBUTOR',
          scopes: ['queue:claim', 'queue:complete'],
          active: true,
        } as never,
      ],
      requestId: 'test',
    };
  }

  /** A ready bin Brain has fired one named Routine for. */
  async function firedBin(
    routineId: string,
    accountId: string,
    title: string,
    orchestrationId?: string,
  ) {
    const bin = await createBin({
      projectId,
      layerId,
      ...(orchestrationId ? { orchestrationId } : {}),
      kind: 'DETERMINISTIC_CHECK',
      title,
      objective: 'Arrive and take it.',
      manifest: {
        objective: 'Arrive and take it.',
        why: 'the fire has to be for something',
        lineage: { projectId, layerId, goal: null, orchestrationId: null },
        units: [],
        acceptableSources: [],
        excludedSources: [],
        evidence: [],
        outputs: [],
        authorizedActions: [],
        prohibitedActions: [],
        budgetUnits: 1,
        retry: { maxAttempts: 3, backoffSeconds: 30 },
        stoppingConditions: ['done'],
      },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    });
    await ensureDispatchIntent(bin);
    const dispatch = (await listDispatchesForBin(bin.id)).find((entry) => entry.state !== 'SENT')!;
    await markDispatchRoutine(dispatch.id, routineId);
    await markDispatchSent(dispatch.id, { routineRef: 'V1', routineId, accountId });
    return bin;
  }

  /** Somewhere for a pass to belong. The packet's contents are not the subject. */
  async function packetShell(): Promise<string> {
    const run = await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'anything',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'A packet whose passes need an account',
      assignment: 'the lineage is the subject, not the research',
      provider: 'WORKER',
      autoApprove: false,
    });
    return orchestration.id;
  }

  it('records the account from the fire, where the binding alone cannot say', async () => {
    const { workerId, routineId, accountId } = await twoRoutinesOneWorker();

    // Two bindings, so the static lookup is ambiguous and fails closed. That is
    // correct and it is exactly why every production pass had a null account.
    const beforeArrival = await lineageForWorker({ workerId, credentialId: 'oat_never_seen' });
    expect(beforeArrival.accountId).toBeNull();
    expect(beforeArrival.routineId).toBeNull();

    // Brain fires one Routine for this bin, at this generation.
    const bin = await firedBin(routineId, accountId, 'A bin to be fired for');

    const credentialId = 'oat_closure_session';
    const result = await checkIn({
      principal: principalFor(workerId, credentialId),
      workerId,
    });
    expect(result.assigned).toBe(true);

    const observed = await getWorkerSession(credentialId);
    expect(observed?.routineId).toBe(routineId);
    expect(observed?.accountId).toBe(accountId);
    expect(observed?.binId).toBe(bin.id);

    // And the lineage a pass is recorded with now answers.
    const lineage = await lineageForWorker({ workerId, credentialId });
    expect(lineage.accountId).toBe(accountId);
    expect(lineage.routineId).toBe(routineId);
    expect(lineage.sessionRef).toBe(credentialId);

    // First observation wins: the surface that *started* a session cannot be
    // re-pointed by a later bin it happens to take.
    const again = await getWorkerSession(credentialId);
    expect(again?.observedAt).toBe(observed?.observedAt);
  });

  /**
   * The same fact, for a session that arrived before anything was observing.
   *
   * `worker_sessions` only observes forwards, so every audit pass this Brain
   * wrote before it existed carries a null account — on genuinely independent
   * audits as much as anything else. The rows that prove which surface fired
   * the session are still there, and this is the recovery over them.
   *
   * The observation is *deleted* rather than never made, because that is the
   * production shape: the fire, the arrival and the pass all really happened,
   * and only the row that records the pairing is missing.
   */
  it('recovers a past session from the dispatch, and never over a recorded value', async () => {
    const { workerId, routineId, accountId } = await twoRoutinesOneWorker();
    const credentialId = 'oat_history_session';

    const bin = await firedBin(routineId, accountId, 'A bin fired before anything observed');
    expect((await checkIn({ principal: principalFor(workerId, credentialId), workerId })).assigned).toBe(true);

    // The history: the pairing was never written down.
    await getDb().run('DELETE FROM worker_sessions WHERE session_ref = ?', [credentialId]);
    expect(await getWorkerSession(credentialId)).toBeNull();
    expect(bin.id).toBeTruthy();

    const orchestration = await packetShell();
    const blank = await startPass({
      orchestrationId: orchestration,
      passKey: 'AUDIT',
      ordinal: 5,
      provider: 'WORKER',
      prompt: 'the primary argument',
      promptSha256: 'c'.repeat(64),
      executorWorkerId: workerId,
      executorSessionRef: credentialId,
    });
    await finishPass(blank.id, { status: 'COMPLETE' });
    expect((await getPass(blank.id))?.executorAccountId ?? null).toBeNull();

    // A pass that already names an account — a different one, so a silent
    // overwrite would be visible rather than indistinguishable from a fill.
    const recorded = await startPass({
      orchestrationId: orchestration,
      passKey: 'AUDIT',
      ordinal: 6,
      provider: 'WORKER',
      prompt: 'the adversarial argument',
      promptSha256: 'd'.repeat(64),
      executorWorkerId: workerId,
      executorSessionRef: credentialId,
      executorAccountId: 'acct_recorded_already',
      executorRoutineId: 'rtn_recorded_already',
    });
    await finishPass(recorded.id, { status: 'COMPLETE' });

    const recovery = await recoverExecutionLineage();
    expect(recovery.sessions.map((entry) => entry.sessionRef)).toEqual([credentialId]);
    expect(recovery.sessions[0]?.accountId).toBe(accountId);
    expect(recovery.passes.map((entry) => entry.passId)).toEqual([blank.id]);
    expect(recovery.unresolved).toHaveLength(0);

    const filled = await getPass(blank.id);
    expect(filled?.executorAccountId).toBe(accountId);
    expect(filled?.executorRoutineId).toBe(routineId);

    // §5 at a column: what was already recorded is what it still says.
    const untouched = await getPass(recorded.id);
    expect(untouched?.executorAccountId).toBe('acct_recorded_already');
    expect(untouched?.executorRoutineId).toBe('rtn_recorded_already');

    // And it settles: nothing left to recover, so nothing is recovered again.
    const second = await recoverExecutionLineage();
    expect(second.sessions).toHaveLength(0);
    expect(second.passes).toHaveLength(0);
  });

  /**
   * And for a session that has long since let go of everything.
   *
   * `bins.lease_credential_id` is current state: overwritten by the next
   * assignment and set to NULL on release and on completion. For a bin that
   * finished — which is nearly all of history, and exactly what this recovery
   * is for — the live arm finds nothing at all. `work_leases` is append-only by
   * design, so the durable arm walks the claim to the bin, the bin to the
   * arrival that claim followed, and the arrival to the fire it superseded.
   */
  it('recovers from the append-only claim when the bin no longer holds the credential', async () => {
    const { workerId, routineId, accountId } = await twoRoutinesOneWorker();
    const credentialId = 'oat_released_session';

    const orchestration = await packetShell();
    const bin = await firedBin(routineId, accountId, 'A bin whose lease has since ended', orchestration);
    expect((await checkIn({ principal: principalFor(workerId, credentialId), workerId })).assigned).toBe(true);
    /*
     * No `binId`, which is the production shape and was the hole.
     *
     * `enqueueResearchItem` sets `orchestration_id` and leaves `bin_id` null; a
     * bin naming an orchestration is a lease on that packet and reaches its
     * untagged work, which is `binScopeSql`'s rule. The recovery joined on the
     * column alone, so it matched no research item at all — which is every
     * audit pass there is, and the one session it was written to recover.
     */
    const item = await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'PRIMARY' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration,
    });
    const claimed = await claimWork({
      workerId,
      credentialId,
      scopes: [{ projectId, scopes: ['queue:claim'] }],
    });
    expect(claimed.map((entry) => entry.workItemId)).toContain(item.id);

    // The lease ends and the bin lets go of the credential — which is what
    // `releaseWork`, `completeWork` and the next assignment all do to it.
    await getDb().run('UPDATE bins SET lease_credential_id = NULL WHERE id = ?', [bin.id]);
    await getDb().run('DELETE FROM worker_sessions WHERE session_ref = ?', [credentialId]);

    const pass = await startPass({
      orchestrationId: orchestration,
      passKey: 'AUDIT',
      ordinal: 5,
      provider: 'WORKER',
      prompt: 'the primary argument, long since finished',
      promptSha256: 'f'.repeat(64),
      executorWorkerId: workerId,
      executorSessionRef: credentialId,
    });
    await finishPass(pass.id, { status: 'COMPLETE' });

    const recovery = await recoverExecutionLineage();
    expect(recovery.unresolved).toHaveLength(0);
    expect(recovery.sessions.map((entry) => entry.sessionRef)).toEqual([credentialId]);
    expect(recovery.sessions[0]?.accountId).toBe(accountId);
    expect(recovery.sessions[0]?.routineId).toBe(routineId);
    expect((await getPass(pass.id))?.executorAccountId).toBe(accountId);
  });

  it('refuses a session two Routines could have started', async () => {
    const worker = await createWorker({
      name: 'ambiguous-worker',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const one = await createAccount({ name: 'primary' });
    const two = await createAccount({ name: 'friend-2' });
    const v1 = await createRoutine({
      accountId: one.id,
      routineRef: 'V1',
      name: 'V1',
      tokenSecretName: 'V1_SECRET',
      tokenDigest: 'a'.repeat(64),
    });
    const v2 = await createRoutine({
      accountId: two.id,
      routineRef: 'V2',
      name: 'V2',
      tokenSecretName: 'V2_SECRET',
      tokenDigest: 'b'.repeat(64),
    });
    await bindRoutineWorker(v1.id, worker.id);
    await bindRoutineWorker(v2.id, worker.id);

    const credentialId = 'oat_ambiguous_session';
    await firedBin(v1.id, one.id, 'Fired by V1');
    expect((await checkIn({ principal: principalFor(worker.id, credentialId), workerId: worker.id })).assigned).toBe(true);
    await firedBin(v2.id, two.id, 'Fired by V2');
    expect((await checkIn({ principal: principalFor(worker.id, credentialId), workerId: worker.id })).assigned).toBe(true);
    await getDb().run('DELETE FROM worker_sessions WHERE session_ref = ?', [credentialId]);

    const orchestration = await packetShell();
    const pass = await startPass({
      orchestrationId: orchestration,
      passKey: 'AUDIT',
      ordinal: 5,
      provider: 'WORKER',
      prompt: 'the primary argument',
      promptSha256: 'e'.repeat(64),
      executorWorkerId: worker.id,
      executorSessionRef: credentialId,
    });
    await finishPass(pass.id, { status: 'COMPLETE' });

    const recovery = await recoverExecutionLineage();
    expect(recovery.sessions).toHaveLength(0);
    expect(recovery.passes).toHaveLength(0);
    expect(recovery.unresolved).toHaveLength(1);
    expect(recovery.unresolved[0]?.sessionRef).toBe(credentialId);
    expect(recovery.unresolved[0]?.reason).toContain('2 Routines');

    // Unresolved means unchanged, not defaulted to whichever came first.
    expect((await getPass(pass.id))?.executorAccountId ?? null).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* A terminal packet holds no claimable work                                  */
/* ------------------------------------------------------------------------- */

describe('a packet that has finished holds nothing a worker can be sent for', () => {
  it('retires queued and leased items, keeps their rows, and runs once', async () => {
    const run = await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'anything',
    });
    const orchestration = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'A packet that finishes with work outstanding',
      assignment: 'the work outstanding is the point',
      provider: 'WORKER',
      autoApprove: false,
    });

    const queued = await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'ADVERSARIAL' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
    });
    const held = await enqueueWork({
      projectId,
      workType: 'RESEARCH_AUDIT',
      payload: { role: 'JUDGE' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
    });
    const worker = await createWorker({
      name: 'holder',
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const claimed = await claimWork({
      workerId: worker.id,
      scopes: [{ projectId, scopes: ['queue:claim', 'queue:complete'] }],
      workTypes: ['RESEARCH_AUDIT'],
    });
    expect(claimed).not.toBeNull();

    // The packet finishes while both are still live.
    await updateOrchestration(orchestration.id, {
      status: 'COMPLETE',
      completedAt: new Date().toISOString(),
    });

    const first = await reconcileTerminalPackets(10);
    expect(first.map((entry) => entry.orchestrationId)).toContain(orchestration.id);

    // Whichever one nobody is holding is retired at once.
    const leasedId = claimed![0]!.workItemId;
    const freeId = leasedId === queued.id ? held.id : queued.id;
    const retiredFree = (await getWorkItem(freeId))!;
    expect(retiredFree.state).toBe('CANCELLED');
    // Cancelled with the reason, not deleted: the row keeps its id, its
    // attempts and its history.
    expect(retiredFree.cancelledReason).toContain('concluded');

    /*
     * The held one is left exactly where it is, and that is the correction.
     *
     * A packet goes terminal the moment the judge's verdict is recorded, and
     * the judge is still holding its own item at that instant — the contract
     * asks it to complete that item next. Retiring under a live lease made
     * that completion fail its ownership proof, which is a compliant worker
     * being told it did something wrong. The condition this reconciliation is
     * *for* is an expired lease: work claimable again for a settled question.
     */
    expect((await getWorkItem(leasedId))!.state).toBe('LEASED');

    // And when the session is gone, it is retired like the other.
    await getDb().run(`UPDATE work_items SET lease_expires_at = ? WHERE id = ?`, [
      new Date(Date.now() - 60_000).toISOString(),
      leasedId,
    ]);
    const second = await reconcileTerminalPackets(10);
    expect(second.map((entry) => entry.orchestrationId)).toContain(orchestration.id);
    const retiredHeld = (await getWorkItem(leasedId))!;
    expect(retiredHeld.state).toBe('CANCELLED');
    expect(retiredHeld.cancelledReason).toContain('concluded');

    // Idempotent by the state it produces: nothing left to select.
    expect(await reconcileTerminalPackets(10)).toHaveLength(0);
  });
});
