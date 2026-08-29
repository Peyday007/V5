/**
 * The distributed queue, at the level where the concurrency actually lives.
 *
 * These tests are written as races and as attacks rather than as features. The
 * question is never "can a worker do its job" — the HTTP suite answers that —
 * it is "can two workers own the same item", "can a worker that lost its lease
 * still write", and "does the database refuse what the code believes is
 * impossible".
 *
 * Every claim about concurrency here runs against whichever backend the suite
 * is pointed at, and the whole file runs against real Postgres with concurrent
 * connections when BRAIN_TEST_DATABASE_URL is set. That matters: the guarantee
 * is about a database, and SQLite's serialised writers could hide a design that
 * only works because nothing is ever truly simultaneous.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../server/db/database.ts';
import { createProject } from '../server/repos/projects.ts';
import { createWorker } from '../server/repos/identity.ts';
import { freshProject } from './helpers.ts';
import {
  cancelWork,
  checkpointWork,
  claimWork,
  completeWork,
  enqueueWork,
  listCheckpoints,
  MAX_CHECKPOINT_CHARS,
  MAX_CHECKPOINTS_PER_ATTEMPT,
  TooManyCheckpoints,
  failWork,
  getWorkItem,
  heartbeatWork,
  listLeases,
  queueMetrics,
  releaseWork,
  sweepExpiredLeases,
  type ClaimScope,
  type OwnershipProof,
} from '../server/repos/workQueue.ts';
import type { ClaimedWork, WorkerScope } from '../server/domain/types.ts';

const SCOPES: WorkerScope[] = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'];

let projectA = '';
let projectB = '';
let workerOne = '';
let workerTwo = '';

/** Both projects, so "may not see it" always has something to be about. */
function scopesFor(projectIds: string[], scopes: WorkerScope[] = SCOPES): ClaimScope[] {
  return projectIds.map((projectId) => ({ projectId, scopes }));
}

async function add(
  projectId: string,
  over: { priority?: number; maxAttempts?: number; requiredScopes?: WorkerScope[] } = {},
): Promise<string> {
  const item = await enqueueWork({
    projectId,
    workType: 'SYNTHETIC_ECHO',
    payload: { note: 'hello' },
    createdByType: 'SYSTEM',
    requiredScopes: over.requiredScopes ?? ['queue:claim'],
    priority: over.priority,
    maxAttempts: over.maxAttempts,
  });
  return item.id;
}

function proofOf(claim: ClaimedWork, workerId: string): OwnershipProof {
  return {
    workItemId: claim.workItemId,
    workerId,
    leaseId: claim.leaseId,
    leaseGeneration: claim.leaseGeneration,
  };
}

/** Force a lease into the past without waiting for real time to pass. */
async function expireLease(workItemId: string): Promise<void> {
  await getDb().run(
    "UPDATE work_items SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    [workItemId],
  );
  await getDb().run(
    "UPDATE work_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE work_item_id = ? AND ended_at IS NULL",
    [workItemId],
  );
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectA = fixture.project.id;
  projectB = (await createProject({ name: 'The Other Project' })).id;
  workerOne = (
    await createWorker({ name: 'worker-one', createdByType: 'SYSTEM', createdById: 'test' })
  ).id;
  workerTwo = (
    await createWorker({ name: 'worker-two', createdByType: 'SYSTEM', createdById: 'test' })
  ).id;
});

// ---------------------------------------------------------------------------

describe('atomic claiming', () => {
  it('gives one item to exactly one of two workers racing for it', async () => {
    await add(projectA);
    const [one, two] = await Promise.all([
      claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) }),
      claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) }),
    ]);
    expect(one.length + two.length).toBe(1);
  });

  it('never hands the same item to two workers, however many race', async () => {
    const workers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createWorker({ name: `racer-${i}`, createdByType: 'SYSTEM', createdById: 'test' }),
      ),
    );
    for (let i = 0; i < 12; i += 1) await add(projectA);

    const results = await Promise.all(
      workers.map((worker) =>
        claimWork({ workerId: worker.id, scopes: scopesFor([projectA]), limit: 3 }),
      ),
    );
    const ids = results.flat().map((claim) => claim.workItemId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(12);
  });

  it('advances the attempt count and the fencing generation exactly once per claim', async () => {
    const id = await add(projectA);
    await Promise.all([
      claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) }),
      claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) }),
      claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) }),
    ]);
    const item = await getWorkItem(id);
    expect(item?.attemptCount).toBe(1);
    expect(item?.leaseGeneration).toBe(1);
    expect(await listLeases(id)).toHaveLength(1);
  });

  it('treats an empty queue as an ordinary answer', async () => {
    expect(await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) })).toEqual([]);
  });

  it('hands out the highest priority first, then the oldest', async () => {
    const low = await add(projectA, { priority: 1 });
    const high = await add(projectA, { priority: 9 });
    const mid = await add(projectA, { priority: 5 });
    const claimed = await claimWork({
      workerId: workerOne,
      scopes: scopesFor([projectA]),
      limit: 3,
    });
    expect(claimed.map((c) => c.workItemId)).toEqual([high, mid, low]);
  });

  it('refuses work in a project the worker is not a member of', async () => {
    await add(projectB);
    const claimed = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    expect(claimed).toEqual([]);
  });

  it('refuses work whose required scopes the worker does not hold', async () => {
    await add(projectA, { requiredScopes: ['queue:claim', 'research:write'] });
    const claimed = await claimWork({
      workerId: workerOne,
      scopes: scopesFor([projectA], ['queue:claim']),
    });
    expect(claimed).toEqual([]);
  });

  it('gives nothing to a worker with no memberships at all', async () => {
    await add(projectA);
    expect(await claimWork({ workerId: workerOne, scopes: [] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('a lease', () => {
  it('can be extended by its owner', async () => {
    await add(projectA);
    const [claim] = await claimWork({
      workerId: workerOne,
      scopes: scopesFor([projectA]),
      leaseMs: 10_000,
    });
    // Asked for longer than the claim held, so the extension is visible even
    // when the heartbeat lands in the same millisecond as the claim — which it
    // does, and which is why comparing against the original expiry alone is not
    // a test of anything.
    const beat = await heartbeatWork(proofOf(claim!, workerOne), { leaseMs: 60_000 });
    expect(beat.ok).toBe(true);
    if (beat.ok) {
      expect(beat.item.leaseExpiresAt! > claim!.leaseExpiresAt).toBe(true);
      expect(beat.item.heartbeatAt).not.toBeNull();
    }
  });

  it('extends from now rather than from whenever it was claimed', async () => {
    await add(projectA);
    const [claim] = await claimWork({
      workerId: workerOne,
      scopes: scopesFor([projectA]),
      leaseMs: 30_000,
    });
    const beat = await heartbeatWork(proofOf(claim!, workerOne), { leaseMs: 30_000 });
    expect(beat.ok).toBe(true);
    if (beat.ok) {
      // A heartbeat is not a cumulative grant: holding it another 30 seconds
      // from now, never 30 seconds added to what was left.
      const held = new Date(beat.item.leaseExpiresAt!).getTime() - Date.now();
      expect(held).toBeLessThanOrEqual(30_000 + 2_000);
    }
  });

  it('cannot be extended by a different worker holding the same lease id', async () => {
    await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const beat = await heartbeatWork(proofOf(claim!, workerTwo));
    expect(beat.ok).toBe(false);
    if (!beat.ok) expect(beat.rejection).toBe('NOT_THE_OWNER');
  });

  it('cannot be extended with a guessed lease id', async () => {
    await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const beat = await heartbeatWork({ ...proofOf(claim!, workerOne), leaseId: 'wls_invented' });
    expect(beat.ok).toBe(false);
  });

  it('cannot be revived by a late heartbeat once it has expired', async () => {
    await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(claim!.workItemId);
    const beat = await heartbeatWork(proofOf(claim!, workerOne));
    expect(beat.ok).toBe(false);
    if (!beat.ok) expect(beat.rejection).toBe('LEASE_EXPIRED');
  });

  it('records heartbeats as a count on the current attempt, not as new rows', async () => {
    await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await heartbeatWork(proofOf(claim!, workerOne));
    await heartbeatWork(proofOf(claim!, workerOne));
    await heartbeatWork(proofOf(claim!, workerOne));
    const attempts = await listLeases(claim!.workItemId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.heartbeatCount).toBe(3);
  });

  it('is bounded: a worker cannot ask to hold something for a week', async () => {
    await add(projectA);
    const [claim] = await claimWork({
      workerId: workerOne,
      scopes: scopesFor([projectA]),
      leaseMs: 7 * 24 * 60 * 60 * 1000,
    });
    const held = new Date(claim!.leaseExpiresAt).getTime() - Date.now();
    expect(held).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });
});

// ---------------------------------------------------------------------------

describe('expiry and reclaim', () => {
  it('makes an expired lease claimable again, without any sweeper having run', async () => {
    const id = await add(projectA);
    const [first] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(id);

    const [second] = await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) });
    expect(second?.workItemId).toBe(id);
    expect(second!.leaseGeneration).toBeGreaterThan(first!.leaseGeneration);
    expect(second!.leaseId).not.toBe(first!.leaseId);
    expect(second!.attemptNumber).toBe(2);
  });

  it('keeps the previous attempt and marks why it ended', async () => {
    const id = await add(projectA);
    await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(id);
    await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) });

    const attempts = await listLeases(id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.outcome).toBe('EXPIRED');
    expect(attempts[0]!.workerId).toBe(workerOne);
    expect(attempts[1]!.outcome).toBeNull();
    expect(attempts[1]!.workerId).toBe(workerTwo);
  });

  it('locks the old owner out of every operation once it has been reclaimed', async () => {
    const id = await add(projectA);
    const [first] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(id);
    await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) });

    const stale = proofOf(first!, workerOne);
    expect((await heartbeatWork(stale)).ok).toBe(false);
    expect((await completeWork(stale)).ok).toBe(false);
    expect((await failWork(stale, { category: 'WORKER_ERROR' })).ok).toBe(false);
    expect((await releaseWork(stale)).ok).toBe(false);

    // And none of it moved the item.
    const item = await getWorkItem(id);
    expect(item?.state).toBe('LEASED');
    expect(item?.workerId).toBe(workerTwo);
  });

  it('has exactly one winner when a heartbeat races the reclaim', async () => {
    const id = await add(projectA);
    const [first] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(id);

    const [beat, reclaimed] = await Promise.all([
      heartbeatWork(proofOf(first!, workerOne)),
      claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) }),
    ]);

    // Whichever way the race fell, there is exactly one owner afterwards, and
    // the two outcomes are mutually exclusive.
    const item = await getWorkItem(id);
    expect(item?.state).toBe('LEASED');
    if (reclaimed.length === 1) {
      expect(item?.workerId).toBe(workerTwo);
      expect(beat.ok).toBe(false);
    } else {
      expect(item?.workerId).toBe(workerOne);
      expect(beat.ok).toBe(true);
    }
  });

  it('sweeping is bookkeeping: it closes lease rows and changes no ownership', async () => {
    const id = await add(projectA);
    await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(id);

    const before = await getWorkItem(id);
    expect(await sweepExpiredLeases()).toBe(1);
    const after = await getWorkItem(id);
    expect(after?.state).toBe(before?.state);
    expect(after?.leaseGeneration).toBe(before?.leaseGeneration);
    expect((await listLeases(id))[0]!.outcome).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------

describe('finishing', () => {
  it('completes once, and refuses a second completion', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const proof = proofOf(claim!, workerOne);

    const first = await completeWork(proof, { summary: 'done' });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.item.state).toBe('SUCCEEDED');

    const second = await completeWork(proof, { summary: 'done again' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejection).toBe('ALREADY_TERMINAL');

    const item = await getWorkItem(id);
    expect(item?.resultSummary).toBe('done');
  });

  it('returns retryable work to the queue while attempts remain', async () => {
    const id = await add(projectA, { maxAttempts: 3 });
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const failed = await failWork(proofOf(claim!, workerOne), { category: 'TIMEOUT' });
    expect(failed.ok).toBe(true);
    const item = await getWorkItem(id);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(1);
  });

  it('fails terminally when the attempts run out', async () => {
    const id = await add(projectA, { maxAttempts: 1 });
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await failWork(proofOf(claim!, workerOne), { category: 'WORKER_ERROR' });
    const item = await getWorkItem(id);
    expect(item?.state).toBe('FAILED');
    expect(item?.failureCategory).toBe('ATTEMPTS_EXHAUSTED');
  });

  it('honours a worker saying this will never work, even with attempts left', async () => {
    const id = await add(projectA, { maxAttempts: 5 });
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await failWork(proofOf(claim!, workerOne), {
      category: 'INVALID_INPUT',
      retryable: false,
    });
    expect((await getWorkItem(id))?.state).toBe('FAILED');
  });

  /**
   * This test used to assert the opposite, and the reversal is deliberate.
   *
   * Step 5 counted the attempt at claim time and never gave it back, on the
   * reasoning that claim time is the only moment it can be counted exactly
   * once. That reasoning is about *where* to count and is still right — the
   * count still happens at claim. What it did not decide, because the question
   * did not exist yet, is what a release means.
   *
   * In Step 5 a release meant "not for me". By Step 9 the worker contract
   * instructs a worker to release when its allowance runs out mid-item, which
   * is a routine event rather than an incidental one — and under the old rule
   * doing as instructed on the second occasion killed the item. It did exactly
   * that to the first real packet's Texas verification, which was carrying nine
   * claims at the time.
   *
   * So the budget now bounds what it is documented to bound: redelivery nobody
   * chose. A failure counts. An expiry counts. A clean hand-back does not.
   * A worker that claims and releases in a loop performs no work and changes no
   * state, and every release is a `RELEASED` row in `work_leases` — visible,
   * which is the check that suits it.
   */
  it('refunds the attempt when work is released, so a hand-back is free', async () => {
    const id = await add(projectA, { maxAttempts: 2 });
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await releaseWork(proofOf(claim!, workerOne), 'not for me');
    const item = await getWorkItem(id);
    expect(item?.state).toBe('QUEUED');
    expect(item?.attemptCount).toBe(0);
  });

  it('never terminates a released item, even with its budget spent', async () => {
    const id = await add(projectA, { maxAttempts: 1 });
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await releaseWork(proofOf(claim!, workerOne), 'out of allowance');
    const item = await getWorkItem(id);
    expect(item?.state).toBe('QUEUED');
    expect(item?.failureCategory).toBeNull();
  });

  it('still exhausts on failure, so a poisonous item is bounded as before', async () => {
    const id = await add(projectA, { maxAttempts: 1 });
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await failWork(proofOf(claim!, workerOne), { category: 'WORKER_ERROR' });
    const item = await getWorkItem(id);
    expect(item?.state).toBe('FAILED');
    expect(item?.failureCategory).toBe('ATTEMPTS_EXHAUSTED');
  });

  it('a stale completion cannot overwrite the new owner or a terminal state', async () => {
    const id = await add(projectA);
    const [first] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expireLease(id);
    const [second] = await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) });
    await completeWork(proofOf(second!, workerTwo), { summary: 'the real result' });

    const stale = await completeWork(proofOf(first!, workerOne), { summary: 'the stale result' });
    expect(stale.ok).toBe(false);
    expect((await getWorkItem(id))?.resultSummary).toBe('the real result');
  });
});

// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('wins against the current owner, deterministically', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const cancelled = await cancelWork(id, 'the operator changed their mind');
    expect(cancelled.ok).toBe(true);

    const proof = proofOf(claim!, workerOne);
    expect((await heartbeatWork(proof)).ok).toBe(false);
    expect((await completeWork(proof)).ok).toBe(false);
    expect((await failWork(proof, { category: 'WORKER_ERROR' })).ok).toBe(false);
    expect((await getWorkItem(id))?.state).toBe('CANCELLED');
  });

  it('has exactly one terminal winner when it races a completion', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const [completed, cancelled] = await Promise.all([
      completeWork(proofOf(claim!, workerOne), { summary: 'finished first' }),
      cancelWork(id, 'cancelled first'),
    ]);
    expect([completed.ok, cancelled.ok].filter(Boolean)).toHaveLength(1);
    const item = await getWorkItem(id);
    expect(item?.state).toBe(completed.ok ? 'SUCCEEDED' : 'CANCELLED');
  });

  it('cannot be reclaimed or resurrected afterwards', async () => {
    const id = await add(projectA);
    await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await cancelWork(id, 'stop');
    expect(await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) })).toEqual([]);
    expect((await cancelWork(id, 'again')).ok).toBe(false);
  });

  it('closes the open attempt with why it ended', async () => {
    const id = await add(projectA);
    await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await cancelWork(id, 'no longer needed');
    const attempts = await listLeases(id);
    expect(attempts[0]!.outcome).toBe('CANCELLED');
    expect(attempts[0]!.endedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('what the database itself refuses', () => {
  it('will not store a lease on an item that is not leased', async () => {
    const id = await add(projectA);
    await expect(
      getDb().run("UPDATE work_items SET lease_id = 'wls_x' WHERE id = ?", [id]),
    ).rejects.toThrow();
  });

  it('will not store a leased item with no owner', async () => {
    const id = await add(projectA);
    await expect(
      getDb().run("UPDATE work_items SET state = 'LEASED' WHERE id = ?", [id]),
    ).rejects.toThrow();
  });

  it('will not issue the same generation twice for one item', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await expect(
      getDb().run(
        `INSERT INTO work_leases (id, work_item_id, project_id, attempt_number, lease_generation,
           worker_id, claimed_at, expires_at, heartbeat_count)
         VALUES (?, ?, ?, 1, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 0)`,
        ['wls_duplicate', id, projectA, claim!.leaseGeneration, workerTwo],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('count only the project asked about', async () => {
    await add(projectA);
    await add(projectA);
    await add(projectB);
    const metrics = await queueMetrics(projectA);
    expect(metrics.queued).toBe(2);
    expect(metrics.claimable).toBe(2);
  });

  it('separate work that is merely queued from work that can be taken now', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    expect((await queueMetrics(projectA)).leased).toBe(1);
    expect((await queueMetrics(projectA)).claimable).toBe(0);

    await expireLease(id);
    const expired = await queueMetrics(projectA);
    expect(expired.expiredLeases).toBe(1);
    // An expired lease is work waiting to be picked up, and says so.
    expect(expired.claimable).toBe(1);
    expect(claim!.workItemId).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
//
// The queue is at-least-once, so a lease can expire in the middle of an hour of
// research and the item goes to somebody who knows nothing about what the first
// attempt found. Step 6 stops the effect repeating. These are the tests for the
// part that stops the *thinking* being thrown away.
//
// The ownership proof is inside the INSERT rather than in a SELECT before it,
// so the interesting cases are the same ones the rest of this file is about:
// what a worker whose lease is gone can still write.
// ---------------------------------------------------------------------------

describe('checkpoints', () => {
  it('records a note against work the writer currently owns', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const proof = proofOf(claim!, workerOne);

    const wrote = await checkpointWork(proof, 'Searched the 2019 register; nothing under that name.');
    expect(wrote.ok).toBe(true);

    const notes = await listCheckpoints(id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('2019 register');
    // The authorship comes from the item's own row, never from the caller.
    expect(notes[0]!.leaseGeneration).toBe(claim!.leaseGeneration);
    expect(notes[0]!.workerId).toBe(workerOne);
    expect(notes[0]!.attemptNumber).toBe(1);
    expect(notes[0]!.projectId).toBe(projectA);
  });

  it('refuses a worker whose lease has expired, and writes nothing', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const stale = proofOf(claim!, workerOne);

    await expireLease(id);
    await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) });

    const refused = await checkpointWork(stale, 'I am still working on this.');
    expect(refused.ok).toBe(false);
    expect(await listCheckpoints(id)).toHaveLength(0);
  });

  it('lets the next claimant read what the previous attempt found', async () => {
    const id = await add(projectA);
    const [first] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    await checkpointWork(proofOf(first!, workerOne), 'Two of the four lanes are covered.');

    await expireLease(id);
    const [second] = await claimWork({ workerId: workerTwo, scopes: scopesFor([projectA]) });
    await checkpointWork(proofOf(second!, workerTwo), 'Picked up from the first attempt.');

    // Deliberately not filtered by generation: reading the earlier attempt is
    // the entire reason the table exists.
    const notes = await listCheckpoints(id);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.leaseGeneration)).toEqual([1, 2]);
    expect(notes.map((n) => n.workerId)).toEqual([workerOne, workerTwo]);
    expect(notes.map((n) => n.attemptNumber)).toEqual([1, 2]);
  });

  it('cannot be forged by naming somebody else as the owner', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const impostor = { ...proofOf(claim!, workerOne), workerId: workerTwo };

    const refused = await checkpointWork(impostor, 'Signed by somebody who does not hold this.');
    expect(refused.ok).toBe(false);
    expect(await listCheckpoints(id)).toHaveLength(0);
  });

  it('bounds one attempt so a loop cannot fill the table', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });
    const proof = proofOf(claim!, workerOne);

    for (let i = 0; i < MAX_CHECKPOINTS_PER_ATTEMPT; i += 1) {
      expect((await checkpointWork(proof, `note ${i}`)).ok).toBe(true);
    }
    await expect(checkpointWork(proof, 'one too many')).rejects.toThrow(TooManyCheckpoints);
    expect(await listCheckpoints(id)).toHaveLength(MAX_CHECKPOINTS_PER_ATTEMPT);
  });

  it('truncates a long note rather than storing a source in it', async () => {
    const id = await add(projectA);
    const [claim] = await claimWork({ workerId: workerOne, scopes: scopesFor([projectA]) });

    await checkpointWork(proofOf(claim!, workerOne), 'x'.repeat(MAX_CHECKPOINT_CHARS * 3));
    const notes = await listCheckpoints(id);
    expect(notes[0]!.note.length).toBe(MAX_CHECKPOINT_CHARS);
    expect(notes[0]!.note.endsWith('…')).toBe(true);
  });
});
