/**
 * A dependency outage must not permanently block Brain work.
 *
 * ---------------------------------------------------------------------------
 * The production incident this file is written from
 * ---------------------------------------------------------------------------
 *
 * 2026-09-21. A worker holding `wki_8ec24cf67707419aae39` — the JUDGE role on
 * `orc_f55f2fd8fa2147938abb`, Cash Mode 1 — submitted its verdict through
 * `brain_submit_audit`. The MCP client reported `timed out after 60s`. The
 * server had in fact committed the operation, at 10:35:06.165Z, and the
 * retried call answered `ALREADY_RECORDED` with exactly that timestamp.
 *
 * So the verdict was stored and the worker was told it had failed. It could
 * not then complete its own item, and it reported a blocker whose words were
 * *"Cloud Brain MCP connector is down, JUDGE verdict not submitted"* — about a
 * connector that was up throughout and a verdict that was in the table. §20's
 * rule at a new boundary: **a timeout is not evidence.**
 *
 * Three separate properties have to hold for that to be survivable, and each
 * one is a `describe` below.
 *
 *   1. The result is durable and the submission is idempotent, so a retry
 *      replays rather than performing a second effect.
 *   2. A role already argued is not offered again, so the redelivery costs no
 *      attempt and no second worker re-argues a settled role.
 *   3. The attempt ceiling actually binds on the path that reaches it, so an
 *      item whose lease keeps expiring stops rather than cycling for ever.
 *
 * The third had never held at all. `failWork` honours `max_attempts`; the
 * claim did not, so an item that only ever *expired* was re-offered without
 * limit. Production still holds the residue: `wki_207ff7c14abf46c19fd8` at
 * attempt 4 of 2 and `wki_7b51a43e958f42f7b5ba` at 5 of 2, both LEASED on
 * leases that lapsed days before.
 *
 * Every test here was run against the unfixed tree first and observed to fail.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker } from '../server/repos/identity.ts';
import {
  bindRoutineWorker,
  createAccount,
  createRoutine,
} from '../server/repos/fleet.ts';
import {
  queueMetrics,
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  getWorkItem,
  regrantWorkAttempts,
  releaseWork,
  type OwnershipProof,
} from '../server/repos/workQueue.ts';
import {
  createOrchestration,
  finishPass,
  listPasses,
  startPass,
} from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { auditAdmission, lineageForWorker } from '../server/services/research/auditAdmission.ts';
import { auditEligibility } from '../server/services/research/auditEligibility.ts';
import type { AuditRole } from '../server/services/queue/workTypes.ts';

let projectId = '';
let orchestrationId = '';

const ORDINAL: Record<AuditRole, number> = { PRIMARY: 5, ADVERSARIAL: 6, JUDGE: 7 };

interface Identity {
  workerId: string;
  credentialId: string;
  accountId: string;
}

let rand = 0;
function tag(): string {
  rand += 1;
  return `${rand}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One account, one Routine, one bound worker — the smallest real surface. */
async function surface(name: string): Promise<Identity> {
  const account = await createAccount({ name: `acct-${name}-${tag()}` });
  const worker = await createWorker({
    name: `wk-${name}-${tag()}`,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: `trig-${name}-${tag()}`,
    name: `R-${name}`,
    tokenSecretName: `SECRET_${name.toUpperCase()}`,
  });
  await bindRoutineWorker(routine.id, worker.id);
  return { workerId: worker.id, credentialId: `cred_${name}_${tag()}`, accountId: account.id };
}

/** A completed audit pass with an exact recorded lineage. */
async function recordAuditPass(role: AuditRole, executor: Identity): Promise<string> {
  const pass = await startPass({
    orchestrationId,
    fragmentId: null,
    passKey: 'AUDIT',
    ordinal: ORDINAL[role],
    provider: 'WORKER',
    model: executor.workerId,
    prompt: 'assignment',
    promptSha256: 'x'.repeat(64),
    executorWorkerId: executor.workerId,
    executorRoutineId: null,
    executorAccountId: executor.accountId,
    executorSessionRef: executor.credentialId,
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}', parsed: {} });
  return pass.id;
}

async function queueAudit(role: AuditRole, maxAttempts = 2): Promise<string> {
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_AUDIT',
    payload: { role },
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
    maxAttempts,
  });
  return item.id;
}

async function passes() {
  return await listPasses(orchestrationId);
}

async function claimAudit(identity: Identity) {
  return await claimWork({
    admit: auditAdmission(await lineageForWorker(identity)),
    workerId: identity.workerId,
    credentialId: identity.credentialId,
    scopes: [{ projectId, scopes: ['research:read', 'research:write', 'queue:claim'] }],
    workTypes: ['RESEARCH_AUDIT'],
  });
}

/**
 * Drop a lease into the past.
 *
 * This is the whole of what an infrastructure failure looks like from the
 * queue's side: the worker stopped heartbeating, for whatever reason, and the
 * item became claimable again. Nothing below ever asserts *why*.
 */
async function expireLease(workItemId: string): Promise<void> {
  const db = getDb();
  await db.run("UPDATE work_items SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [
    workItemId,
  ]);
  await db.run(
    "UPDATE work_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE work_item_id = ? AND ended_at IS NULL",
    [workItemId],
  );
}

function proofOf(
  claim: { workItemId: string; leaseId: string; leaseGeneration: number },
  workerId: string,
): OwnershipProof {
  return {
    workItemId: claim.workItemId,
    workerId,
    leaseId: claim.leaseId,
    leaseGeneration: claim.leaseGeneration,
  };
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const layerId = fixture.layers[0]!.id;
  const runRow = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'A small packet.',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: runRow.id,
    title: 'A small packet',
    assignment: 'Answer one question.',
    provider: 'WORKER',
    autoApprove: false,
  });
  orchestrationId = orchestration.id;
});

/* ========================================================================= */

describe('CASE A/C — a role whose pass is recorded is not offered again', () => {
  it('refuses the role itself, not merely a session that shares lineage', async () => {
    /*
     * The heart of it. The judge's reasoning is minutes of work and its answer
     * is already in `research_passes`; a second session re-arguing it would be
     * refused at submission by the operation record anyway, having spent the
     * whole activation and one of the item's two attempts to find out.
     *
     * Asked of a *completely unrelated* surface on purpose: nothing here is
     * about independence, and a refusal that only fired for the original
     * session would leave the expensive case — a different worker picking up
     * the redelivered item — exactly as it was.
     */
    const first = await surface('a');
    const second = await surface('b');
    const third = await surface('c');
    await recordAuditPass('PRIMARY', first);
    await recordAuditPass('ADVERSARIAL', second);
    await recordAuditPass('JUDGE', third);

    const fourth = await surface('d');
    const verdict = auditEligibility({
      role: 'JUDGE',
      executor: {
        workerId: fourth.workerId,
        routineId: null,
        accountId: fourth.accountId,
        sessionRef: fourth.credentialId,
      },
      passes: await passes(),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/already been argued/i);
  });

  it('costs the redelivered item no attempt, no lease and no generation', async () => {
    /*
     * CASE C, as the queue sees it: the worker died after its result was
     * durable and before it acknowledged. The item is redelivered — and a
     * refusal before the compare-and-swap has to be indistinguishable from
     * losing the race, or the attempt budget pays for an outage.
     */
    const first = await surface('a');
    const second = await surface('b');
    const third = await surface('c');
    await recordAuditPass('PRIMARY', first);
    await recordAuditPass('ADVERSARIAL', second);

    const itemId = await queueAudit('JUDGE');
    const claimed = await claimAudit(third);
    expect(claimed).toHaveLength(1);

    // The submission commits. The reply never reaches the worker, so it never
    // completes the item, and the lease lapses.
    await recordAuditPass('JUDGE', third);
    await expireLease(itemId);

    const before = (await getWorkItem(itemId))!;
    const fourth = await surface('d');
    const again = await claimAudit(fourth);
    expect(again).toHaveLength(0);

    const after = (await getWorkItem(itemId))!;
    expect(after.attemptCount).toBe(before.attemptCount);
    expect(after.leaseGeneration).toBe(before.leaseGeneration);
  });

  it('still admits the role when the packet has argued only the other two', async () => {
    // The guard must refuse a *settled* role and nothing else, or a packet
    // could never reach a judge at all.
    const first = await surface('a');
    const second = await surface('b');
    await recordAuditPass('PRIMARY', first);
    await recordAuditPass('ADVERSARIAL', second);
    const third = await surface('c');
    expect(
      auditEligibility({
        role: 'JUDGE',
        executor: {
          workerId: third.workerId,
          routineId: null,
          accountId: third.accountId,
          sessionRef: third.credentialId,
        },
        passes: await passes(),
      }).eligible,
    ).toBe(true);
  });

  it('is not tripped by a synthesis pass, which is a different ordinal', async () => {
    // `lineageFromPasses` labels the author's lineage `PRIMARY`, so a guard
    // reading roles rather than pass keys would refuse every PRIMARY audit on
    // a packet that had ever been synthesised.
    const author = await surface('a');
    const pass = await startPass({
      orchestrationId,
      fragmentId: null,
      passKey: 'SYNTHESIS',
      ordinal: 4,
      provider: 'WORKER',
      model: author.workerId,
      prompt: 'assignment',
      promptSha256: 'x'.repeat(64),
      executorWorkerId: author.workerId,
      executorRoutineId: null,
      executorAccountId: author.accountId,
      executorSessionRef: author.credentialId,
    });
    await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}', parsed: {} });

    const reviewer = await surface('b');
    expect(
      auditEligibility({
        role: 'PRIMARY',
        executor: {
          workerId: reviewer.workerId,
          routineId: null,
          accountId: reviewer.accountId,
          sessionRef: reviewer.credentialId,
        },
        passes: await passes(),
      }).eligible,
    ).toBe(true);
  });
});

/* ========================================================================= */

describe('CASE B/E/G — an expiring lease is bounded by the attempt ceiling', () => {
  it('stops offering an item once its attempts are spent', async () => {
    /*
     * CASE G. `failWork` has always honoured `max_attempts`; the claim never
     * did, so an item nobody ever *reported* failed — one that simply expired,
     * which is what an infrastructure failure looks like from here — was
     * re-offered for ever, charged another attempt each time.
     *
     * Production, Cash Mode 1: attempt 4 of 2, and attempt 5 of 2.
     */
    const item = await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: {},
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredScopes: ['queue:claim'],
      maxAttempts: 2,
    });
    const worker = await createWorker({
      name: `w-${tag()}`,
      createdByType: 'SYSTEM',
      createdById: 't',
    });
    const scopes = [{ projectId, scopes: ['queue:claim' as const] }];

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const claimed = await claimWork({ workerId: worker.id, scopes });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.attemptNumber).toBe(attempt);
      await expireLease(item.id);
    }

    // Spent. The queue must not hand it out a third time.
    expect(await claimWork({ workerId: worker.id, scopes })).toHaveLength(0);
    const after = (await getWorkItem(item.id))!;
    expect(after.attemptCount).toBe(2);
    expect(after.attemptCount).toBeLessThanOrEqual(after.maxAttempts);
  });

  it('never lets two claimants both take the last attempt', async () => {
    // The ceiling is in the compare-and-swap as well as the candidate read,
    // because a race for the final attempt is decided in the statement that
    // spends it.
    const item = await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: {},
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredScopes: ['queue:claim'],
      maxAttempts: 1,
    });
    const one = await createWorker({ name: `w1-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const two = await createWorker({ name: `w2-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const scopes = [{ projectId, scopes: ['queue:claim' as const] }];

    const [a, b] = await Promise.all([
      claimWork({ workerId: one.id, scopes }),
      claimWork({ workerId: two.id, scopes }),
    ]);
    expect(a.length + b.length).toBe(1);
    const after = (await getWorkItem(item.id))!;
    expect(after.attemptCount).toBe(1);
  });

  it('gives the attempt back on a clean release, so a handover costs nothing', async () => {
    /*
     * CASE B. A worker that runs out of allowance mid-item is asked by the
     * worker contract to checkpoint and release, and the contract says in as
     * many words that releasing costs the packet nothing. With the ceiling now
     * binding on the claim, a release that did *not* refund would turn an
     * honest handover into an exhausted item.
     */
    const item = await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: {},
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredScopes: ['queue:claim'],
      maxAttempts: 1,
    });
    const worker = await createWorker({ name: `w-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const scopes = [{ projectId, scopes: ['queue:claim' as const] }];

    for (let round = 0; round < 3; round += 1) {
      const claimed = await claimWork({ workerId: worker.id, scopes });
      expect(claimed).toHaveLength(1);
      const released = await releaseWork(proofOf(claimed[0]!, worker.id), 'out of allowance');
      expect(released.ok).toBe(true);
    }
    const after = (await getWorkItem(item.id))!;
    expect(after.state).toBe('QUEUED');
    expect(after.attemptCount).toBe(0);
    void item;
  });
});

/* ========================================================================= */

describe('CASE D/F — what the queue may and may not conclude', () => {
  it('a completion is still refused once the lease is gone, so the fence holds', async () => {
    // CASE D's other half: Brain accepted the effect, the worker lost the
    // response, and by the time it tried to acknowledge, its lease had lapsed
    // and the item had been retaken. The acknowledgement must fail — the
    // *effect* is protected by its operation record, never by the lease.
    const first = await surface('a');
    const second = await surface('b');
    await recordAuditPass('PRIMARY', first);
    await recordAuditPass('ADVERSARIAL', second);
    const itemId = await queueAudit('JUDGE', 3);

    const third = await surface('c');
    const claimed = await claimAudit(third);
    expect(claimed).toHaveLength(1);
    await expireLease(itemId);

    const fourth = await surface('d');
    const retaken = await claimAudit(fourth);
    expect(retaken).toHaveLength(1);

    const stale = await completeWork(proofOf(claimed[0]!, third.workerId), { summary: 'late' });
    expect(stale.ok).toBe(false);
  });

  it('an outage before any result leaves the role ordinarily claimable', async () => {
    // CASE F. Nothing was recorded, so nothing is settled and the next worker
    // must simply be able to do the work. The guard above must not turn "the
    // reply was lost" into "this role is finished".
    const first = await surface('a');
    const second = await surface('b');
    await recordAuditPass('PRIMARY', first);
    await recordAuditPass('ADVERSARIAL', second);
    const itemId = await queueAudit('JUDGE', 3);

    const third = await surface('c');
    expect(await claimAudit(third)).toHaveLength(1);
    await expireLease(itemId);

    const fourth = await surface('d');
    const again = await claimAudit(fourth);
    expect(again).toHaveLength(1);
    expect((await getWorkItem(itemId))!.attemptCount).toBe(2);
  });
});

/* ========================================================================= */

describe('the ceiling binds, so it needs a way past it', () => {
  async function spend(maxAttempts: number): Promise<{ id: string; workerId: string; scopes: { projectId: string; scopes: 'queue:claim'[] }[] }> {
    const item = await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: {},
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredScopes: ['queue:claim'],
      maxAttempts,
    });
    const worker = await createWorker({ name: `w-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const scopes = [{ projectId, scopes: ['queue:claim' as const] }];
    for (let n = 0; n < maxAttempts; n += 1) {
      const claimed = await claimWork({ workerId: worker.id, scopes });
      expect(claimed).toHaveLength(1);
      await expireLease(item.id);
    }
    expect(await claimWork({ workerId: worker.id, scopes })).toHaveLength(0);
    return { id: item.id, workerId: worker.id, scopes };
  }

  it('makes an exhausted item claimable again, without resetting what it spent', async () => {
    /*
     * An escalation with no answering transition is stuck rather than waiting.
     * Before the ceiling bound at the claim there was no escalation to answer —
     * the item simply cycled — so this is the transition that has to arrive
     * with the guard rather than after it. `regrantBinAttempts` is the same
     * function one object up and every restriction here is its.
     */
    const spent = await spend(2);
    const raised = await regrantWorkAttempts({
      workItemId: spent.id,
      maxAttempts: 5,
      reason: 'a dependency failed, not the work',
      actorType: 'SYSTEM',
    });
    expect(raised.raised).toBe(true);
    // The history stays. §5: the spent attempts are how a reader sees this.
    expect(raised.item!.attemptCount).toBe(2);
    expect(raised.item!.maxAttempts).toBe(5);

    const again = await claimWork({ workerId: spent.workerId, scopes: spent.scopes });
    expect(again).toHaveLength(1);
    expect(again[0]!.attemptNumber).toBe(3);
  });

  it('only ever raises, so it cannot be used to strand an item', async () => {
    const spent = await spend(2);
    const lowered = await regrantWorkAttempts({
      workItemId: spent.id,
      maxAttempts: 1,
      reason: 'should change nothing',
      actorType: 'SYSTEM',
    });
    expect(lowered.raised).toBe(false);
    expect(lowered.item!.maxAttempts).toBe(2);
  });

  it('refuses a terminal item, so a finished one cannot be reopened by a number', async () => {
    const item = await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: {},
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredScopes: ['queue:claim'],
      maxAttempts: 2,
    });
    const worker = await createWorker({ name: `w-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const claimed = await claimWork({
      workerId: worker.id,
      scopes: [{ projectId, scopes: ['queue:claim'] }],
    });
    expect(claimed).toHaveLength(1);
    const failed = await failWork(proofOf(claimed[0]!, worker.id), {
      category: 'INVALID_INPUT',
      detail: 'this input will never work',
      retryable: false,
    });
    expect(failed.ok).toBe(true);
    expect((await getWorkItem(item.id))!.state).toBe('FAILED');

    const raised = await regrantWorkAttempts({
      workItemId: item.id,
      maxAttempts: 9,
      reason: 'should change nothing',
      actorType: 'SYSTEM',
    });
    expect(raised.raised).toBe(false);
    expect((await getWorkItem(item.id))!.state).toBe('FAILED');
  });
});

/* ========================================================================= */

describe('the number and the behaviour say the same thing', () => {
  it('stops counting an exhausted item as claimable, and counts it as exhausted', async () => {
    /*
     * `queueMetrics.claimable` had its own copy of what a worker could be
     * handed, and the moment the ceiling went into the claim the two became
     * different opinions — the metric would have gone on counting items no
     * worker can be given, which is a diagnostic lying about exactly the state
     * the ceiling creates. One string, read by both.
     *
     * They are two fields rather than one, because folding the exhausted back
     * into `claimable` would make the number agree with the old behaviour, and
     * leaving them out entirely would hide the one figure that says whether to
     * regrant.
     */
    const item = await enqueueWork({
      projectId,
      workType: 'SYNTHETIC_ECHO',
      payload: {},
      createdByType: 'SYSTEM',
      createdById: 'test',
      requiredScopes: ['queue:claim'],
      maxAttempts: 1,
    });
    const worker = await createWorker({ name: `w-${tag()}`, createdByType: 'SYSTEM', createdById: 't' });
    const scopes = [{ projectId, scopes: ['queue:claim' as const] }];

    const before = await queueMetrics(projectId);
    expect(before.claimable).toBe(1);
    expect(before.exhausted).toBe(0);

    expect(await claimWork({ workerId: worker.id, scopes })).toHaveLength(1);
    await expireLease(item.id);

    const after = await queueMetrics(projectId);
    expect(after.claimable).toBe(0);
    expect(after.exhausted).toBe(1);
    // And the reading agrees with what actually happens.
    expect(await claimWork({ workerId: worker.id, scopes })).toHaveLength(0);
  });
});
