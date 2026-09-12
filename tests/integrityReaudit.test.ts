/**
 * The guarded re-audit, and the five ways it has to survive being interrupted.
 *
 * This is the transition that exists because §23's separation matrix arrived
 * after a packet had already been audited by its own author. It cannot edit
 * that history — §5 forbids it and the whole value of the record depends on it
 * — so it moves a boundary in time and lets the machinery that already knows
 * how to run three roles run them again.
 *
 * What is tested here is deliberately not "it works". It is the set of things
 * that go wrong around a recovery operation, because an operation somebody
 * reaches for once, under pressure, after finding a problem, is exactly the one
 * whose retry path nobody exercised:
 *
 *   - the same request sent twice
 *   - a request whose response was lost, retried
 *   - a restart in the middle
 *   - an authorization revoked between the attempts
 *   - a document that changed underneath
 *
 * Plus the decision itself: which roles may be carried forward, and the
 * dependency closure that makes a replaced PRIMARY rerun everything after it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser, grantMembership, setUserDisabled } from '../server/repos/identity.ts';
import {
  createFragments,
  createOrchestration,
  finishPass,
  getOrchestration,
  listPasses,
  startPass,
  updateOrchestration,
} from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { createAudit } from '../server/repos/audits.ts';
import {
  decideRoleReuse,
  reconcileIntegrityReopens,
  reopenProjection,
  requestIntegrityReaudit,
  requestKeyFor,
  scanAuthorReviewerOverlap,
} from '../server/services/audit/integrityReaudit.ts';
import {
  AUTHORITY_CHANNELS,
  listOpenReopens,
  listReopens,
  resolveReopen,
} from '../server/repos/auditReopens.ts';
import { listWorkItems } from '../server/repos/workQueue.ts';
import { listEvents } from '../server/repos/events.ts';
import { newId } from '../server/repos/util.ts';
import {
  concludeAbandonedParks,
  restoreWronglyConcludedParks,
} from '../server/services/russell/needsHuman.ts';
import { binForOrchestration, getBin } from '../server/repos/bins.ts';
import { auditRoundFor, auditRoundStartedAt } from '../server/services/research/auditRound.ts';
import { earlierAuditRole } from '../server/services/research/auditBrief.ts';
import type { Document } from '../server/domain/types.ts';

let fixture: Awaited<ReturnType<typeof freshProject>>;
let projectId = '';
let layerId = '';
let orchestrationId = '';
let document: Document;
let adminId = '';
let originalAudit: Awaited<ReturnType<typeof createAudit>>;

/** The session that wrote the report, and the ones that reviewed it. */
const AUTHOR = 'cred_author';
const OTHER = 'cred_other';
const THIRD = 'cred_third';

async function recordPass(input: {
  passKey: 'SYNTHESIS' | 'AUDIT';
  ordinal: number;
  sessionRef: string | null;
  completedAt?: string;
}): Promise<void> {
  const pass = await startPass({
    orchestrationId,
    fragmentId: null,
    passKey: input.passKey,
    ordinal: input.ordinal,
    provider: 'WORKER',
    model: 'wkr_one',
    prompt: 'assignment',
    promptSha256: 'x'.repeat(64),
    executorWorkerId: 'wkr_one',
    executorRoutineId: 'rtn_one',
    executorAccountId: 'acct_one',
    executorSessionRef: input.sessionRef,
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}', parsed: {} });
  if (input.completedAt) {
    await getDb().run('UPDATE research_passes SET completed_at = ? WHERE id = ?', [
      input.completedAt,
      pass.id,
    ]);
  }
}

/** The production shape: one session wrote the report and filed the primary audit. */
async function authorReviewedItsOwnWork(): Promise<void> {
  await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
  await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: AUTHOR });
  await recordPass({ passKey: 'AUDIT', ordinal: 6, sessionRef: OTHER });
  await recordPass({ passKey: 'AUDIT', ordinal: 7, sessionRef: THIRD });
}

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;

  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'A packet its author audited',
    assignment: 'Answer one question.',
    provider: 'WORKER',
  });
  orchestrationId = orchestration.id;

  document = await addDocument(fixture, 'Monetization Logic', 'v1', { withFile: true });

  /*
   * The accepted fragment a filed document implies.
   *
   * The fixture went without one and that is what hid the enqueue gap: with no
   * fragment at all `advancePacket` walks to the planning branch, so the tests
   * below never reached the audit stage the transition exists to restart. A
   * packet cannot have a document without having synthesized one, and it cannot
   * synthesize without a fragment that cleared its gate — so a fixture with a
   * document and no fragment is a shape production cannot produce.
   */
  await createFragments([
    {
      orchestrationId,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'the-one-question',
      question: 'The one question this packet answered.',
      requiredEvidence: [
        { id: 'official_source', description: 'What the official source says.', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['official source'],
      excludedSourceTypes: ['forum posts'],
      completionCriteria: ['The official source states the answer.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'ACCEPTED',
    },
  ]);

  /*
   * A real audit row, not a made-up id. `research_orchestrations.audit_id` is a
   * foreign key, and the whole point of this transition is that the superseded
   * verdict keeps its row — so the fixture has to contain one that can be kept.
   */
  originalAudit = await createAudit({
    projectId,
    layerId,
    runId: run.id,
    auditedDocumentId: document.id,
    result: {
      verdict: 'PASS',
      summary: 'The round the author reviewed.',
      failures: [],
      missingDocuments: [],
      requiredResearchRuns: [],
      requiredPatches: [],
      synthesisRequired: false,
      freezeEligible: true,
      nextVersion: null,
      nextAction: 'Nothing.',
    },
  });

  await updateOrchestration(orchestrationId, {
    documentId: document.id,
    status: 'COMPLETE',
    verdict: 'PASS',
    auditId: originalAudit.id,
    completedAt: new Date().toISOString(),
  });

  const admin = await createUser({
    email: `reaudit-${Math.random().toString(36).slice(2, 8)}@example.invalid`,
    displayName: 'An administrator',
    password: 'a-long-enough-password-01',
    isBrainAdmin: true,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  adminId = admin.id;
});

/* ========================================================================= */

describe('which roles may be carried forward', () => {
  it('reruns everything after a replaced PRIMARY, because each is built from the last', async () => {
    await authorReviewedItsOwnWork();
    const decision = decideRoleReuse(await listPasses(orchestrationId));

    expect(decision.conflicted).toEqual(['PRIMARY']);
    // ADVERSARIAL is a critique of one particular primary argument and JUDGE
    // weighs both, so carrying either forward past a replaced PRIMARY would
    // present a critique of a superseded argument as this round's.
    expect(decision.rerun).toEqual(['PRIMARY', 'ADVERSARIAL', 'JUDGE']);
    expect(decision.carried).toEqual([]);
  });

  it('carries PRIMARY forward when only the ADVERSARIAL authored', async () => {
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER });
    await recordPass({ passKey: 'AUDIT', ordinal: 6, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 7, sessionRef: THIRD });

    const decision = decideRoleReuse(await listPasses(orchestrationId));
    expect(decision.conflicted).toEqual(['ADVERSARIAL']);
    // PRIMARY depends on nothing and its session authored nothing, so it stands.
    expect(decision.carried.map((role) => role.role)).toEqual(['PRIMARY']);
    expect(decision.rerun).toEqual(['ADVERSARIAL', 'JUDGE']);
  });

  it('counts a superseded synthesis attempt as an author too', async () => {
    // A redo leaves two completed synthesis passes. The session that wrote the
    // first argued the report into the shape the second inherits.
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: OTHER });
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER });

    const decision = decideRoleReuse(await listPasses(orchestrationId));
    expect(decision.conflicted).toContain('PRIMARY');
  });

  it('treats an unrecorded reviewer session as unknown rather than distinct', async () => {
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: null });

    const decision = decideRoleReuse(await listPasses(orchestrationId));
    // "We could not tell" must never read the same as "we checked".
    expect(decision.conflicted).toContain('PRIMARY');
  });
});

/* ========================================================================= */

describe('the transition itself', () => {
  it('reopens the round without touching a single recorded row', async () => {
    await authorReviewedItsOwnWork();
    const before = await listPasses(orchestrationId);
    const documentBefore = document;

    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(outcome.ok).toBe(true);
    expect(outcome.created).toBe(true);
    expect(outcome.binId).toBeTruthy();

    // Every pass is exactly as it was: same ids, same responses, same clocks.
    const after = await listPasses(orchestrationId);
    expect(after.map((pass) => pass.id).sort()).toEqual(before.map((pass) => pass.id).sort());
    expect(after.map((pass) => pass.completedAt).sort()).toEqual(
      before.map((pass) => pass.completedAt).sort(),
    );

    // And so is the document: bytes, version and hash.
    const row = await getDb().get<{ version: string; file_hash: string | null }>(
      'SELECT version, file_hash FROM documents WHERE id = ?',
      [document.id],
    );
    expect(row?.version).toBe(documentBefore.version);
    expect(row?.file_hash).toBe(documentBefore.fileHash);

    // The record binds the recovery to those exact bytes and to the person.
    const reopen = outcome.reopen!;
    expect(reopen.documentHash).toBe(documentBefore.fileHash);
    expect(reopen.documentVersion).toBe(documentBefore.version);
    expect(reopen.requestedById).toBe(adminId);
    expect(reopen.supersededAuditId).toBe(originalAudit.id);
  });

  it('makes the three roles outstanding again, and clears the old verdict', async () => {
    await authorReviewedItsOwnWork();
    expect(await auditRoundStartedAt(orchestrationId)).toBeNull();

    await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    const round = await auditRoundFor(orchestrationId);
    expect(round.since).toBeTruthy();
    expect([...round.carried]).toEqual([]);

    // No role satisfies the new round, so the runner will enqueue all three.
    for (const role of ['PRIMARY', 'ADVERSARIAL', 'JUDGE'] as const) {
      expect(await earlierAuditRole(orchestrationId, role, round)).toBeNull();
    }

    /*
     * And the old verdict cannot validate the replacement. The `audits` row is
     * untouched — the reopen points at it — but the packet's own pointer is
     * cleared, because `advancePacket` reads it once all three roles have run.
     */
    const packet = await getOrchestration(orchestrationId);
    expect(packet?.status).toBe('AUDITING');
    expect(packet?.verdict).toBeNull();
    expect(packet?.auditId).toBeNull();
  });

  /*
   * The defect production found ninety seconds after the first real reopen.
   *
   * Everything above was true and the round still had nothing in it: the packet
   * said AUDITING, the bin said READY, Brain fired, a worker arrived — and there
   * was no work item to claim, so it released saying exactly that and the bin was
   * fired again. A loop that looks like progress. `advancePacket` is what turns
   * "AUDITING" into a claimable item and every other reopening transition calls
   * it; this one did not.
   *
   * Asked of the queue rather than of the call, because the point is that a
   * worker arriving next has something to do.
   */
  it('leaves the first rerun role claimable, so an arriving worker has work', async () => {
    await authorReviewedItsOwnWork();

    const before = (await listWorkItems(projectId, { limit: 500 })).filter(
      (item) => item.orchestrationId === orchestrationId && item.workType === 'RESEARCH_AUDIT',
    );
    expect(before.every((item) => item.state !== 'QUEUED')).toBe(true);

    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(outcome.ok).toBe(true);

    const round = await auditRoundFor(orchestrationId);
    const queued = (await listWorkItems(projectId, { limit: 500 })).filter(
      (item) =>
        item.orchestrationId === orchestrationId &&
        item.workType === 'RESEARCH_AUDIT' &&
        item.state === 'QUEUED' &&
        round.since !== null &&
        item.createdAt > round.since,
    );
    // One, not three: the roles are built from each other, so ADVERSARIAL is
    // enqueued once PRIMARY has argued and JUDGE once both have.
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload['role']).toBe('PRIMARY');
  });

  /*
   * The half that makes the replay a recovery rather than a shrug.
   *
   * Idempotency means the effect is present after either call. A round that was
   * opened before the enqueue existed has nothing in it, and a replay that did
   * nothing would leave it that way — which is exactly the production state this
   * was found in. Simulated by emptying the queue under an open reopen, because
   * that is what "opened by the old code" looks like from here.
   */
  it('a replay restores a round that was left with nothing in it', async () => {
    await authorReviewedItsOwnWork();
    await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    const round = await auditRoundFor(orchestrationId);
    /*
     * Removed rather than cancelled, because the two are different states and
     * only one of them is the one being recovered from. A round opened before
     * the enqueue existed never had an item; a *cancelled* item is one that was
     * created and stopped, which `advancePacket` reads — correctly — as a role
     * whose worker finished without recording anything.
     */
    for (const item of await listWorkItems(projectId, { limit: 500 })) {
      if (item.orchestrationId !== orchestrationId) continue;
      if (item.workType !== 'RESEARCH_AUDIT' || item.state !== 'QUEUED') continue;
      await getDb().run('DELETE FROM work_items WHERE id = ?', [item.id]);
    }
    const emptied = (await listWorkItems(projectId, { limit: 500 })).filter(
      (item) =>
        item.orchestrationId === orchestrationId &&
        item.workType === 'RESEARCH_AUDIT' &&
        item.state === 'QUEUED',
    );
    expect(emptied).toHaveLength(0);

    const replay = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(replay.created).toBe(false);
    expect(replay.reopen?.state).toBe('OPEN');

    const restored = (await listWorkItems(projectId, { limit: 500 })).filter(
      (item) =>
        item.orchestrationId === orchestrationId &&
        item.workType === 'RESEARCH_AUDIT' &&
        item.state === 'QUEUED' &&
        round.since !== null &&
        item.createdAt > round.since,
    );
    expect(restored).toHaveLength(1);
    expect(restored[0]?.payload['role']).toBe('PRIMARY');
  });

  /*
   * The other half of the recovery: somewhere for the round to run.
   *
   * Production's round was opened with nothing in it, so five fired workers
   * arrived, each correctly found no claimable item, released, and the bin
   * retired at NEEDS_HUMAN with its five attempts spent. Enqueuing the work
   * stops that happening again; it does not give *that* round anywhere to run.
   * A live round whose only bin is terminal is a packet nothing can be sent for.
   */
  it('a replay builds a new bin when the round has nowhere left to run', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(first.binId).toBeTruthy();

    // Spend it, the way five refused activations did.
    await getDb().run(`UPDATE bins SET state = 'NEEDS_HUMAN' WHERE id = ?`, [first.binId]);

    const replay = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(replay.created).toBe(false);
    expect(replay.binId).toBeTruthy();
    expect(replay.binId).not.toBe(first.binId);

    // The spent one keeps everything it had.
    const spent = await getBin(first.binId!);
    expect(spent?.state).toBe('NEEDS_HUMAN');

    const fresh = await getBin(replay.binId!);
    expect(fresh?.state).toBe('READY');
    expect(fresh?.orchestrationId).toBe(orchestrationId);
  });

  /*
   * The reader that told a person the opposite of the truth.
   *
   * `binForOrchestration` had no `ORDER BY` at all, so once a reopened round
   * gave the packet a second bin it returned whichever row the backend felt
   * like. In production it picked the spent one while a live bin was running
   * the replacement PRIMARY, and `packet-report` printed "nothing can be sent
   * for this packet". A warning that cries wolf is worse than no warning.
   */
  it('names the bin that can still deliver, not whichever row comes back first', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await getDb().run(`UPDATE bins SET state = 'NEEDS_HUMAN' WHERE id = ?`, [first.binId]);
    const replay = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(replay.binId).not.toBe(first.binId);

    // Two bins on one packet, one spent and one live. The live one is the answer.
    const chosen = await binForOrchestration(orchestrationId);
    expect(chosen?.id).toBe(replay.binId);
    expect(chosen?.state).toBe('READY');
  });

  it('falls back to the newest bin when every one of them is spent', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await getDb().run(`UPDATE bins SET state = 'NEEDS_HUMAN' WHERE id = ?`, [first.binId]);
    const replay = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await getDb().run(`UPDATE bins SET state = 'COMPLETE' WHERE id = ?`, [replay.binId]);

    // Nothing can deliver, and saying so needs a bin to say it about — the
    // newest, because that is the one whose state is the current answer.
    const chosen = await binForOrchestration(orchestrationId);
    expect(chosen?.id).toBe(replay.binId);
  });

  /*
   * Attribution is not authentication, and the record must not blur them.
   *
   * `--admin <email>` resolves an enabled administrator from `users`. That
   * proves such a person exists and may authorize this; it proves nothing about
   * who typed the command. What authenticated the only entrance that exists is
   * reaching the shell — and Brain cannot identify the party that reached it.
   *
   * Recording a delegated terminal action as though a person had approved it in
   * a browser is the kind of quiet overstatement that is impossible to detect
   * afterwards, which is exactly why it is two columns and two assertions.
   */
  it('records how the call was authenticated apart from whose authority it carries', async () => {
    await authorReviewedItsOwnWork();
    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(outcome.ok).toBe(true);
    // Whose authority.
    expect(outcome.reopen?.requestedById).toBe(adminId);
    // How it got in — defaulted to the weaker, unverifiable claim.
    expect(outcome.reopen?.authorityChannel).toBe('DELEGATED_TERMINAL');
    expect(outcome.reopen?.executedByRef).toBeNull();
  });

  it('never assumes a browser session, because Brain cannot check one', async () => {
    await authorReviewedItsOwnWork();
    // The service is called with no authority at all, which is what the terminal
    // entrance does. The stronger claim must not appear by default.
    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(outcome.reopen?.authorityChannel).not.toBe('BROWSER_SESSION');
  });

  it('stores a reported execution reference without believing it', async () => {
    await authorReviewedItsOwnWork();
    const outcome = await requestIntegrityReaudit({
      orchestrationId,
      personId: adminId,
      authority: { channel: 'DELEGATED_TERMINAL', executedByRef: 'workflow Packets run 123' },
    });
    // Kept verbatim as a lead for a person reading the record later. Nothing
    // verifies it, and every reader prints it as reported.
    expect(outcome.reopen?.executedByRef).toBe('workflow Packets run 123');
    expect(outcome.reopen?.authorityChannel).toBe('DELEGATED_TERMINAL');
  });

  it('the vocabulary is closed, so a channel nobody defined cannot be stored', () => {
    expect([...AUTHORITY_CHANNELS].sort()).toEqual(['BROWSER_SESSION', 'DELEGATED_TERMINAL']);
  });

  it('a replay reuses a bin that can still deliver, rather than building a second', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    const replay = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    // Two live bins for one packet is the duplicate the replay path exists to
    // avoid, and it is still avoided.
    expect(replay.binId).toBe(first.binId);
  });

  it('a replay enqueues nothing further, because the round already holds it', async () => {
    await authorReviewedItsOwnWork();
    await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    const after = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(after.created).toBe(false);

    const round = await auditRoundFor(orchestrationId);
    const queued = (await listWorkItems(projectId, { limit: 500 })).filter(
      (item) =>
        item.orchestrationId === orchestrationId &&
        item.workType === 'RESEARCH_AUDIT' &&
        item.state === 'QUEUED' &&
        round.since !== null &&
        item.createdAt > round.since,
    );
    expect(queued).toHaveLength(1);
  });

  it('lets a carried role satisfy the new round without being argued again', async () => {
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER });
    await recordPass({ passKey: 'AUDIT', ordinal: 6, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 7, sessionRef: THIRD });

    await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    const round = await auditRoundFor(orchestrationId);

    // PRIMARY was carried: its pass is untouched and still predates the
    // boundary, and the round stops treating that as disqualifying for it.
    expect(await earlierAuditRole(orchestrationId, 'PRIMARY', round)).not.toBeNull();
    expect(await earlierAuditRole(orchestrationId, 'ADVERSARIAL', round)).toBeNull();
    expect(await earlierAuditRole(orchestrationId, 'JUDGE', round)).toBeNull();
  });

  it('refuses a packet whose audit was independent', async () => {
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER });
    await recordPass({ passKey: 'AUDIT', ordinal: 6, sessionRef: THIRD });
    await recordPass({ passKey: 'AUDIT', ordinal: 7, sessionRef: 'cred_fourth' });

    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    // A transition that reopened anything it was pointed at would be a way to
    // discard a verdict somebody did not like.
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe('AUDIT_IS_INDEPENDENT');
    expect(await listOpenReopens()).toHaveLength(0);
  });
});

/* ========================================================================= */

describe('the five ways it gets interrupted', () => {
  it('sent twice, opens one round', async () => {
    await authorReviewedItsOwnWork();

    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    const second = await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.reopen?.id).toBe(first.reopen?.id);

    expect(await listReopens(orchestrationId)).toHaveLength(1);

    // One boundary, and one bin. A second bin would be a second worker sent for
    // one round's work.
    const bins = await getDb().all<{ total: number }>(
      'SELECT COUNT(*) AS total FROM bins WHERE orchestration_id = ?',
      [orchestrationId],
    );
    expect(Number(bins[0]?.total ?? 0)).toBe(1);
  });

  it('a lost response is a retry, and the retry is the same answer', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    // The caller never saw that reply. It asks again with the identical inputs,
    // because that is all it has.
    const retry = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(retry.ok).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.reopen?.roundStartedAt).toBe(first.reopen?.roundStartedAt);
    expect(retry.binId).toBe(first.binId);
  });

  it('survives a restart, because the row is the state', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    await restartDatabase();

    // Nothing was held in memory: the boundary is an append-only event and the
    // reservation is a row, so both survive on their own.
    const round = await auditRoundFor(orchestrationId);
    expect(round.since).toBe(first.reopen?.roundStartedAt);

    const again = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(again.created).toBe(false);
    expect(again.reopen?.id).toBe(first.reopen?.id);
  });

  it('refuses a retry from a principal whose authorization was revoked', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(first.ok).toBe(true);

    // The person is disabled between the attempts. The stored `requested_by_id`
    // is a record of who asked, never a credential, so it does not let them
    // past on the way back in.
    await setUserDisabled(adminId, true);

    const retry = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    expect(retry.ok).toBe(false);
    expect(retry.refusal).toBe('NOT_AUTHORIZED');
    // Absent and forbidden read the same, so a refused reader learns nothing
    // about whether the packet exists.
    expect(retry.detail).toBe('No such packet, or you may not administer it.');
  });

  it('refuses somebody with no access at all, in the same words', async () => {
    await authorReviewedItsOwnWork();
    const outsider = await createUser({
      email: `outsider-${Math.random().toString(36).slice(2, 8)}@example.invalid`,
      displayName: 'Not a member',
      password: 'a-long-enough-password-01',
      isBrainAdmin: false,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    const outcome = await requestIntegrityReaudit({
      orchestrationId,
      personId: outsider.id,
    });
    expect(outcome.refusal).toBe('NOT_AUTHORIZED');
    expect(outcome.detail).toBe('No such packet, or you may not administer it.');

    // And a member below ADMIN is refused too: reopening an audit is an
    // administration of the project, not a write to it.
    await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId: outsider.id,
      role: 'MEMBER',
      scopes: ['research:read', 'research:write'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
    expect((await requestIntegrityReaudit({ orchestrationId, personId: outsider.id })).refusal).toBe(
      'NOT_AUTHORIZED',
    );
  });

  it('a changed document is a different operation, and supersedes the old finding', async () => {
    await authorReviewedItsOwnWork();
    const first = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    const originalKey = first.reopen!.requestKey;

    // The bytes move on. The finding was about the ones that are gone.
    await getDb().run('UPDATE documents SET file_hash = ? WHERE id = ?', [
      'f'.repeat(64),
      document.id,
    ]);

    const settled = await reconcileIntegrityReopens(await listOpenReopens());
    expect(settled.superseded).toEqual([first.reopen!.id]);
    expect(settled.resolved).toEqual([]);

    const history = await listReopens(orchestrationId);
    // Superseded, never resolved: nothing re-audited anything, and reporting
    // this as answered would claim an assurance nobody earned.
    expect(history[0]?.state).toBe('SUPERSEDED_BY_VERSION');

    // A fresh request about the new bytes is a different key, so it is a new
    // operation rather than a replay of the one that no longer applies.
    const nextKey = requestKeyFor({
      orchestrationId,
      documentId: document.id,
      documentHash: 'f'.repeat(64),
      finding: 'AUTHOR_REVIEWED_OWN_WORK',
    });
    expect(nextKey).not.toBe(originalKey);
  });
});

/* ========================================================================= */

describe('settling it, and saying so while it is open', () => {
  it('says the assurance is pending correction while the round runs', async () => {
    await authorReviewedItsOwnWork();
    await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    const projection = await reopenProjection(orchestrationId);
    expect(projection.open).not.toBeNull();
    expect(projection.sentence).toMatch(/PENDING CORRECTION/);
    expect(projection.sentence).toContain(originalAudit.id);
  });

  it('resolves only on a verdict from this round, never the superseded one', async () => {
    await authorReviewedItsOwnWork();
    const opened = await requestIntegrityReaudit({ orchestrationId, personId: adminId });

    // The old verdict restored by anything at all must not settle the very
    // correction it exists to replace.
    await updateOrchestration(orchestrationId, { auditId: originalAudit.id, verdict: 'PASS' });
    expect((await reconcileIntegrityReopens(await listOpenReopens())).resolved).toEqual([]);

    // A new audit id, but no judge pass in this round yet: still not settled,
    // because the audit row alone cannot say which round produced it.
    const second = await createAudit({
      projectId,
      layerId,
      auditedDocumentId: document.id,
      result: {
        verdict: 'PASS',
        summary: 'The independent round.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: [],
        synthesisRequired: false,
        freezeEligible: true,
        nextVersion: null,
        nextAction: 'Nothing.',
      },
    });
    await updateOrchestration(orchestrationId, { auditId: second.id, verdict: 'PASS' });
    expect((await reconcileIntegrityReopens(await listOpenReopens())).resolved).toEqual([]);

    // Now the judge runs again, after the boundary.
    await recordPass({
      passKey: 'AUDIT',
      ordinal: 7,
      sessionRef: 'cred_fresh_judge',
      completedAt: new Date(Date.parse(opened.reopen!.roundStartedAt) + 60_000).toISOString(),
    });
    const settled = await reconcileIntegrityReopens(await listOpenReopens());
    expect(settled.resolved).toEqual([opened.reopen!.id]);

    const projection = await reopenProjection(orchestrationId);
    expect(projection.open).toBeNull();
    expect(projection.sentence).toBeNull();
    expect(projection.history[0]?.resolvedAuditId).toBe(second.id);
  });
});

/* ========================================================================= */

describe('the scope report', () => {
  it('names every affected packet and opens none of them', async () => {
    await authorReviewedItsOwnWork();

    const findings = await scanAuthorReviewerOverlap();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.orchestrationId).toBe(orchestrationId);
    expect(findings[0]?.conflicted).toEqual(['PRIMARY']);
    expect(findings[0]?.reopenState).toBeNull();

    // Reading is not reopening. A scan that acted on what it found would be
    // making somebody else's decision.
    expect(await listOpenReopens()).toHaveLength(0);
  });

  it('reports an unattributed audit separately from a demonstrated one', async () => {
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: null });

    const finding = (await scanAuthorReviewerOverlap())[0];
    expect(finding?.unattributed).toBe(true);
    // It is listed because nobody can tell, not because the author reviewed.
    expect(finding?.conflicted).toEqual([]);
  });

  it('leaves an independent packet out entirely', async () => {
    await recordPass({ passKey: 'SYNTHESIS', ordinal: 4, sessionRef: AUTHOR });
    await recordPass({ passKey: 'AUDIT', ordinal: 5, sessionRef: OTHER });
    await recordPass({ passKey: 'AUDIT', ordinal: 6, sessionRef: THIRD });

    expect(await scanAuthorReviewerOverlap()).toHaveLength(0);
  });
});

/* =========================================================================
 * A reopen is an asker, so a reopened round is not an abandoned park
 * ========================================================================= */

/*
 * The defect production produced four hours after the first reopen.
 *
 * `concludeAbandonedParks` reads the *mission* to decide whether anybody is
 * still waiting: a packet at NEEDS_HUMAN under a terminal mission is cancelled,
 * on the sentence "the thing which asked the question stopped wanting the
 * answer". That is right when the mission is the only asker, and wrong the
 * moment an administrator reopens a round on a packet whose mission finished
 * this morning.
 *
 * `orc_abab7d7130d545eaa1a1` was reopened at 13:31:53, three independent roles
 * ran, the fresh judge recorded PATCH at 17:30:08 — a verdict that does not
 * advance — and the packet was cancelled saying nobody would answer. Somebody
 * had asked, four hours earlier, and was waiting for exactly that answer.
 */
describe('a packet whose round a reopen asked for', () => {
  beforeEach(async () => {
    await authorReviewedItsOwnWork();
  });

  /** Put the packet where the sweep looks: parked, under a finished mission. */
  async function parkUnderTerminalMission(): Promise<string> {
    const mission = newId('rms');
    await getDb().run(
      `INSERT INTO russell_missions
         (id, project_id, orchestration_id, state, objective, why_now, idempotency_key,
          created_at, updated_at)
       VALUES (?, ?, ?, 'DONE', ?, ?, ?, ?, ?)`,
      [
        mission,
        projectId,
        orchestrationId,
        'A mission that finished before the round began',
        'It was the only thing asking, until an administrator reopened the round.',
        `test:${mission}`,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await updateOrchestration(orchestrationId, { status: 'NEEDS_HUMAN' });
    return mission;
  }

  it('is not cancelled while its reopen is open', async () => {
    await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await parkUnderTerminalMission();

    const concluded = await concludeAbandonedParks(50);
    expect(concluded.map((entry) => entry.orchestrationId)).not.toContain(orchestrationId);
    expect((await getOrchestration(orchestrationId))?.status).toBe('NEEDS_HUMAN');
  });

  it('is not cancelled when its current verdict is that reopen’s product', async () => {
    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    const fresh = await createAudit({
      projectId,
      layerId,
      runId: (await getOrchestration(orchestrationId))!.runId,
      auditedDocumentId: document.id,
      result: {
        verdict: 'PATCH',
        summary: 'The independent round asked for a patch.',
        failures: [],
        missingDocuments: [],
        requiredResearchRuns: [],
        requiredPatches: [],
        synthesisRequired: false,
        freezeEligible: false,
        nextVersion: null,
        nextAction: 'A person decides.',
      },
    });
    await updateOrchestration(orchestrationId, { auditId: fresh.id, verdict: 'PATCH' });
    await resolveReopen({ id: outcome.reopen!.id, auditId: fresh.id });
    await parkUnderTerminalMission();

    const concluded = await concludeAbandonedParks(50);
    expect(concluded.map((entry) => entry.orchestrationId)).not.toContain(orchestrationId);
    expect((await getOrchestration(orchestrationId))?.status).toBe('NEEDS_HUMAN');
  });

  it('a packet with no reopen at all is still concluded, because that rule was right', async () => {
    await parkUnderTerminalMission();
    const concluded = await concludeAbandonedParks(50);
    expect(concluded.map((entry) => entry.orchestrationId)).toContain(orchestrationId);
    expect((await getOrchestration(orchestrationId))?.status).toBe('CANCELLED');
  });

  it('puts back one that was cancelled before the rule knew, and keeps the history', async () => {
    // Exactly the production shape: cancelled first, reopened round second.
    await parkUnderTerminalMission();
    expect(await concludeAbandonedParks(50)).toHaveLength(1);
    expect((await getOrchestration(orchestrationId))?.status).toBe('CANCELLED');

    await updateOrchestration(orchestrationId, { status: 'NEEDS_HUMAN' });
    const outcome = await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await updateOrchestration(orchestrationId, {
      status: 'CANCELLED',
      cancelReason:
        'The mission that asked this question is DONE, so nobody is going to answer the decision this packet stopped at.',
    });

    const restored = await restoreWronglyConcludedParks(50);
    expect(restored.map((entry) => entry.orchestrationId)).toContain(orchestrationId);
    expect(restored[0]?.reopenId).toBe(outcome.reopen!.id);

    const packet = await getOrchestration(orchestrationId);
    expect(packet?.status).toBe('NEEDS_HUMAN');
    // The sentence that said nobody would answer is current state, not history,
    // and it contradicted the packet it was written on.
    expect(packet?.cancelReason ?? null).toBeNull();

    // History does not mutate: the cancellation stays on the record beside the
    // restoration.
    const events = await listEvents(projectId, 200);
    const kinds = events.map((event) => event.eventType);
    expect(kinds).toContain('RESEARCH_CANCELLED');
    expect(kinds).toContain('RESEARCH_PARK_RESTORED');
  });

  it('never puts back a packet cancelled for any other reason', async () => {
    await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await updateOrchestration(orchestrationId, {
      status: 'CANCELLED',
      cancelReason: 'A person stopped this deliberately.',
    });
    expect(await restoreWronglyConcludedParks(50)).toHaveLength(0);
    expect((await getOrchestration(orchestrationId))?.status).toBe('CANCELLED');
  });

  it('the two sweeps cannot trade a packet back and forth', async () => {
    await requestIntegrityReaudit({ orchestrationId, personId: adminId });
    await parkUnderTerminalMission();
    for (let pass = 0; pass < 3; pass += 1) {
      await concludeAbandonedParks(50);
      await restoreWronglyConcludedParks(50);
    }
    expect((await getOrchestration(orchestrationId))?.status).toBe('NEEDS_HUMAN');
  });
});
