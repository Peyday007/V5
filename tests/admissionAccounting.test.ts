/**
 * An assignment Brain refuses itself is not an attempt the bin spent.
 *
 * This is the defect production found, walked end to end. `bin_75bea12e15534ba4b93f`
 * held one `RESEARCH_AUDIT` item. The fleet's Routine kept arriving on the
 * session that had already performed a role in that audit round, the
 * independence guard correctly withheld the work — and the bin was charged an
 * attempt anyway, because `assignNextBin` incremented `attempt_count` in the
 * same statement that handed the bin over, before anything had asked whether
 * this session could take it. Seventy-one repetitions later the bin read
 * 100/100 and escalated, with the audit one role from finished.
 *
 * Three separate things had to be true for that to happen, and each is pinned
 * below: the eligibility question was asked after the accounting; a refusal
 * cost the bin something; and nothing remembered the refusal, so the same
 * pairing was retried as fast as the dispatcher could fire.
 *
 * The rule the fix must not touch is the one that was working correctly the
 * whole time: three distinct authenticated sessions, one per audit role.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  finishPass,
  startPass,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import {
  createBin,
  getBin,
  listBinEvents,
  listDispatchableBins,
  listSessionRefusals,
  recordBinEvent,
  refusalBackoffMs,
  terminateUnleasedBin,
} from '../server/repos/bins.ts';
import { completeWork } from '../server/repos/workQueue.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import {
  checkIn,
  nextItemInBin,
  reconcileBins,
  release,
} from '../server/services/bins/service.ts';
import type { BinManifest, Principal, ResearchOrchestration } from '../server/domain/types.ts';

let fixture: TestProject;
let workerId = '';
let orchestration: ResearchOrchestration;
let binId = '';

/**
 * One worker, three authenticated sessions.
 *
 * Exactly production's shape: a Routine is bound to one worker identity, and
 * what changes between activations is the credential the request authenticated
 * with. `lineageForWorker` reads the session from that credential, so these
 * three are three sessions of one worker — the floor the audit actually has to
 * meet, and the one a single-Routine fleet meets by being activated again.
 */
function session(credentialId: string): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'admission-worker',
    displayName: 'admission-worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId,
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        projectId: fixture.project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: ['queue:claim', 'queue:complete', 'research:write'],
        active: true,
      } as unknown as Principal['memberships'][number],
    ],
    requestId: `req_${credentialId}`,
  };
}

function manifest(): BinManifest {
  return {
    objective: 'Audit the filed report.',
    why: 'A packet is finished when its audit is.',
    lineage: {
      projectId: fixture.project.id,
      layerId: null,
      goal: null,
      orchestrationId: orchestration.id,
    },
    units: [],
    acceptableSources: ['the filed document'],
    excludedSources: ['anything else'],
    evidence: ['three audit roles'],
    outputs: ['a verdict'],
    authorizedActions: ['read the document'],
    prohibitedActions: ['any spend'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the packet is terminal'],
  };
}

beforeEach(async () => {
  fixture = await freshProject();
  workerId = (
    await createWorker({
      name: `admission-${Math.random().toString(36).slice(2, 8)}`,
      createdByType: 'SYSTEM',
      createdById: 'test',
    })
  ).id;

  const layer = await fixture.layerByName('Discovery Logic');
  const document = await addDocument(fixture, 'Discovery Logic', 'v1B', {
    contents: 'Which Michigan county offices publish assessment rolls, and on what terms.',
  });
  const run = await createRun({
    projectId: fixture.project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'county assessment-roll access',
  });
  orchestration = await createOrchestration({
    projectId: fixture.project.id,
    layerId: layer.id,
    runId: run.id,
    title: 'County property tax assessment roll access',
    assignment: 'the official sources that answer it',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: fixture.project.id,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'official-record',
      question: 'Which county offices publish assessment rolls, and on what terms?',
      geography: 'Michigan',
      requiredEvidence: [
        { id: 'official_source', description: 'the office or portal', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['county register of deeds or recording office'],
      excludedSourceTypes: ['vendor or software marketing pages'],
      completionCriteria: ['a quoted official statement of terms'],
      minIndependentSources: 1,
      maxRepairs: 2,
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  for (const fragment of await currentFragments(orchestration.id)) {
    await updateFragment(fragment.id, {
      status: 'ACCEPTED',
      completedAt: new Date().toISOString(),
    });
  }
  await updateOrchestration(orchestration.id, {
    status: 'AUDITING',
    currentPass: 'AUDIT',
    documentId: document.id,
  });
  // The runner enqueues the roles in order, one at a time, exactly as it does
  // in production. Nothing here creates a work item by hand.
  await advancePacket(orchestration.id);

  const bin = await createBin({
    projectId: fixture.project.id,
    layerId: layer.id,
    kind: 'RESEARCH_PACKET',
    title: 'County property tax assessment roll access',
    objective: 'Audit the filed report.',
    manifest: manifest(),
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId: orchestration.id,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    maxAttempts: 100,
  });
  binId = bin.id;
});

/** Take the bin, drain one item, record the pass, complete it, hand the bin back. */
async function performRole(
  credentialId: string,
  ordinal: number,
): Promise<{ assigned: boolean; workType?: string }> {
  const principal = session(credentialId);
  const arrival = await checkIn({ principal, workerId, sessionRef: credentialId });
  if (!arrival.assigned) return { assigned: false };

  const proof = {
    binId: arrival.assignment.binId,
    leaseId: arrival.assignment.leaseId,
    leaseGeneration: arrival.assignment.leaseGeneration,
    workerId,
  };
  const next = await nextItemInBin({ principal, workerId, proof });
  if (!next.held || !next.item) {
    await release(proof, 'nothing claimable');
    return { assigned: true };
  }

  const pass = await startPass({
    orchestrationId: orchestration.id,
    passKey: 'AUDIT',
    ordinal,
    provider: 'WORKER',
    model: workerId,
    prompt: `audit pass ${ordinal}`,
    promptSha256: 'x'.repeat(64),
    executorWorkerId: workerId,
    executorSessionRef: credentialId,
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}' });
  await completeWork(
    {
      workItemId: next.item.workItemId,
      workerId,
      leaseId: next.item.leaseId,
      leaseGeneration: next.item.leaseGeneration,
    },
    { summary: `${next.item.workType} done` },
  );
  await advancePacket(orchestration.id);
  await release(proof, 'role done');
  return { assigned: true, workType: next.item.workType };
}

describe('a refusal Brain issues to itself costs the bin nothing', () => {
  it('charges an assignment it actually makes', async () => {
    expect((await getBin(binId))!.attemptCount).toBe(0);
    const arrival = await checkIn({
      principal: session('cred_a'),
      workerId,
      sessionRef: 'cred_a',
    });
    expect(arrival.assigned).toBe(true);
    expect((await getBin(binId))!.attemptCount).toBe(1);
    if (arrival.assigned) {
      await release(
        {
          binId: arrival.assignment.binId,
          leaseId: arrival.assignment.leaseId,
          leaseGeneration: arrival.assignment.leaseGeneration,
          workerId,
        },
        'measured',
      );
    }
  });

  it('will not hand the same session the same bin again, at zero cost, however often it asks', async () => {
    await performRole('cred_a', 5);
    const spent = (await getBin(binId))!.attemptCount;

    /*
     * The seventy-one, in miniature. Session A has performed PRIMARY; the only
     * open item is ADVERSARIAL, which the independence floor forbids it. Every
     * one of these arrivals used to cost the bin an attempt.
     */
    for (let i = 0; i < 12; i += 1) {
      const again = await checkIn({
        principal: session('cred_a'),
        workerId,
        sessionRef: 'cred_a',
      });
      expect(again.assigned).toBe(false);
    }

    expect((await getBin(binId))!.attemptCount).toBe(spent);
    expect((await getBin(binId))!.state).toBe('READY');
  });

  it('writes down the refusal, and says which pair and dimension without naming a value', async () => {
    await performRole('cred_a', 5);
    await checkIn({ principal: session('cred_a'), workerId, sessionRef: 'cred_a' });

    const refusals = await listSessionRefusals(binId);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.sessionRef).toBe('cred_a');
    expect(refusals[0]!.refusals).toBe(1);
    expect(refusals[0]!.reason).toMatch(/same session/i);
    // §23's rule about refusals: the pair and the dimension, never the value.
    expect(refusals[0]!.reason).not.toContain('cred_a');

    const events = (await listBinEvents(binId, 200)).filter(
      (event) => event.eventType === 'BIN_ASSIGNMENT_REFUSED',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('REFUSED_BY_ADMISSION');
  });

  it('keeps every refusal, and backs off further each time', async () => {
    await performRole('cred_a', 5);
    for (let i = 0; i < 4; i += 1) {
      // Past the backoff each time, so the live check runs again rather than
      // the pre-filter short-circuiting it.
      await getDb().run('UPDATE bin_session_refusals SET retry_at = ? WHERE bin_id = ?', [
        '2000-01-01T00:00:00.000Z',
        binId,
      ]);
      await checkIn({ principal: session('cred_a'), workerId, sessionRef: 'cred_a' });
    }

    const [refusal] = await listSessionRefusals(binId);
    expect(refusal!.refusals).toBe(4);
    // The history is one row that counts, not one row that forgets.
    expect(refusal!.firstAt <= refusal!.lastAt).toBe(true);
    expect(refusalBackoffMs(1)).toBeLessThan(refusalBackoffMs(4));
  });

  it('stops the dispatcher firing at it, without hiding it from a session that can take it', async () => {
    await performRole('cred_a', 5);
    await checkIn({ principal: session('cred_a'), workerId, sessionRef: 'cred_a' });

    // No tight redispatch loop: the bin is not fireable while the only session
    // Brain has seen for it cannot take the work.
    const bin = (await getBin(binId))!;
    expect(bin.dispatchNotBefore).not.toBeNull();
    expect(bin.dispatchNotBefore! > new Date().toISOString()).toBe(true);
    expect((await listDispatchableBins()).map((entry) => entry.id)).not.toContain(binId);

    // And that is a fire decision only. A fresh session asking right now is
    // handed the bin immediately — the assigner never reads the backoff.
    const fresh = await checkIn({ principal: session('cred_b'), workerId, sessionRef: 'cred_b' });
    expect(fresh.assigned).toBe(true);
    if (fresh.assigned) expect(fresh.assignment.binId).toBe(binId);
  });
});

describe('three distinct sessions still finish the audit', () => {
  it('walks PRIMARY, ADVERSARIAL and JUDGE through sessions A, B and C', async () => {
    const a = await performRole('cred_a', 5);
    expect(a.workType).toBe('RESEARCH_AUDIT');

    // A cannot take the next role, however many times it comes back.
    for (let i = 0; i < 6; i += 1) {
      const refused = await checkIn({
        principal: session('cred_a'),
        workerId,
        sessionRef: 'cred_a',
      });
      expect(refused.assigned).toBe(false);
    }

    const b = await performRole('cred_b', 6);
    expect(b.assigned).toBe(true);
    expect(b.workType).toBe('RESEARCH_AUDIT');

    const c = await performRole('cred_c', 7);
    expect(c.assigned).toBe(true);
    expect(c.workType).toBe('RESEARCH_AUDIT');

    // Three roles, three sessions, and the floor was never lowered to get here.
    const passes = await getDb().all<{ ordinal: number; executor_session_ref: string }>(
      `SELECT ordinal, executor_session_ref FROM research_passes
        WHERE orchestration_id = ? AND pass_key = 'AUDIT' AND status = 'COMPLETE'
        ORDER BY ordinal`,
      [orchestration.id],
    );
    expect(passes.map((pass) => pass.ordinal)).toEqual([5, 6, 7]);
    expect(new Set(passes.map((pass) => pass.executor_session_ref)).size).toBe(3);

    /*
     * And the accounting is the point. Three assignments were made, one per
     * role; the six refusals in between made none. Every assignment that was
     * made completed a work item, so mutation 31 credits each of them back —
     * which is why the budget reads zero rather than three, and why a bin that
     * is making progress can no longer retire itself for making it.
     */
    const assigned = (await listBinEvents(binId, 500)).filter(
      (event) => event.eventType === 'BIN_ASSIGNED',
    );
    expect(assigned).toHaveLength(3);
    const refused = (await listBinEvents(binId, 500)).filter(
      (event) => event.eventType === 'BIN_ASSIGNMENT_REFUSED',
    );
    expect(refused.length).toBeGreaterThan(0);

    const bin = (await getBin(binId))!;
    expect(bin.attemptCount).toBeLessThan(bin.maxAttempts);
    expect(bin.attemptCount).toBe(0);
  });
});

describe('the bin the defect already stranded', () => {
  /**
   * Put the bin in the state production reached: every attempt spent, most of
   * them on arrivals Brain refused itself, and escalated for exhausting a
   * budget it had not really used.
   *
   * The events are written the way the running system wrote them — an
   * assignment at a generation, then a withheld item at that same generation
   * and nothing claimed — because that is the evidence the recovery is derived
   * from. Nothing is passed to the recovery directly.
   */
  async function stranded(refusals: number): Promise<void> {
    for (let generation = 1; generation <= refusals; generation += 1) {
      await recordBinEvent({
        eventType: 'BIN_ASSIGNED',
        binId,
        projectId: fixture.project.id,
        orchestrationId: orchestration.id,
        workerId,
        leaseGeneration: generation,
        outcome: 'ASSIGNED',
      });
      await recordBinEvent({
        eventType: 'BIN_ITEM_WITHHELD',
        binId,
        projectId: fixture.project.id,
        orchestrationId: orchestration.id,
        workerId,
        leaseGeneration: generation,
        outcome: 'REFUSED_BY_ADMISSION',
        reason: 'RESEARCH_AUDIT: ADVERSARIAL would share the same session as PRIMARY.',
      });
    }
    // One assignment that did claim something, so the recovery has to tell the
    // two apart rather than crediting everything back.
    await recordBinEvent({
      eventType: 'BIN_ASSIGNED',
      binId,
      projectId: fixture.project.id,
      orchestrationId: orchestration.id,
      workerId,
      leaseGeneration: refusals + 1,
      outcome: 'ASSIGNED',
    });
    await recordBinEvent({
      eventType: 'BIN_ITEM_WITHHELD',
      binId,
      projectId: fixture.project.id,
      orchestrationId: orchestration.id,
      workerId,
      leaseGeneration: refusals + 1,
      outcome: 'REFUSED_BY_ADMISSION',
      reason: 'withheld, but this generation went on to claim something',
    });
    await recordBinEvent({
      eventType: 'BIN_ITEM_CLAIMED',
      binId,
      projectId: fixture.project.id,
      orchestrationId: orchestration.id,
      workerId,
      leaseGeneration: refusals + 1,
      outcome: 'CLAIMED',
    });

    const bin = (await getBin(binId))!;
    await getDb().run('UPDATE bins SET attempt_count = max_attempts WHERE id = ?', [binId]);
    await terminateUnleasedBin(
      binId,
      bin.leaseGeneration,
      'NEEDS_HUMAN',
      'The bin used all 100 attempts without satisfying RESEARCH_PACKET_V1 v1.',
    );
  }

  it('gives back exactly the attempts that were charged for refusals, and reopens it', async () => {
    await stranded(71);
    const parked = (await getBin(binId))!;
    expect(parked.state).toBe('NEEDS_HUMAN');
    expect(parked.attemptCount).toBe(parked.maxAttempts);

    await reconcileBins(fixture.project.id);

    const recovered = (await getBin(binId))!;
    // Seventy-one credited; the generation that claimed something keeps its
    // attempt, because it did get the chance.
    expect(recovered.attemptCount).toBe(parked.maxAttempts - 71);
    expect(recovered.state).toBe('READY');

    const reopened = (await listBinEvents(binId, 500)).filter(
      (event) => event.eventType === 'BIN_REOPENED',
    );
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.reason).toMatch(/credited back/i);
  });

  it('keeps every one of the refusals it just credited', async () => {
    await stranded(71);
    await reconcileBins(fixture.project.id);

    // §5: the recovery is an addition, never an erasure.
    const withheld = (await listBinEvents(binId, 500)).filter(
      (event) => event.eventType === 'BIN_ITEM_WITHHELD',
    );
    expect(withheld).toHaveLength(72);
    const credits = (await listBinEvents(binId, 500)).filter(
      (event) => event.eventType === 'BIN_ATTEMPT_CREDITED',
    );
    expect(credits).toHaveLength(71);
  });

  it('answers a park whose budget was already credited by an earlier pass', async () => {
    /*
     * The production shape this exists for, and it is the same lesson at a
     * smaller scale: derive the condition from rows, not from catching the
     * moment.
     *
     * `bin_dcb7564ba5e840b3aac3` sat at `NEEDS_HUMAN` reading *"used all 5
     * attempts"* with `attempts 0/5` — the credit had happened, the condition
     * it escalated on was gone, and the packet underneath was `AUDITING` with
     * two claimable audit items and nothing anywhere able to send a worker for
     * them. The reopen returned early on `credited === 0`, so it could only
     * fire in the same pass as the credit; once the two came apart the bin was
     * parked for ever with a full budget.
     *
     * Simulated the way it actually happened: credit the attempts, then park
     * it again, so the next pass credits nothing.
     */
    await stranded(71);
    await reconcileBins(fixture.project.id);
    const credited = (await getBin(binId))!;
    expect(credited.attemptCount).toBeLessThan(credited.maxAttempts);

    // Parked again with the budget already credited — so the next pass has
    // nothing to credit and, before this, nothing to do.
    await terminateUnleasedBin(
      binId,
      credited.leaseGeneration,
      'NEEDS_HUMAN',
      'The bin used all 100 attempts without satisfying RESEARCH_PACKET_V1 v1.',
    );
    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');

    await reconcileBins(fixture.project.id);

    const answered = (await getBin(binId))!;
    expect(answered.state).toBe('READY');
    // Nothing was reset: the credited count is exactly what it was.
    expect(answered.attemptCount).toBe(credited.attemptCount);
    const reopened = (await listBinEvents(binId, 500)).filter(
      (event) => event.eventType === 'BIN_REOPENED',
    );
    expect(reopened).toHaveLength(2);
    // The second one names the condition it actually answered, which is not
    // the credit — that already happened — but the budget being free.
    expect(reopened.map((event) => event.reason ?? '').join(' | ')).toMatch(
      /no longer exhausted/i,
    );
  });

  it('leaves a park alone while the budget really is exhausted', async () => {
    /*
     * The other half, and the reason this cannot loop: the guard is the bin's
     * own budget. A bin that genuinely spent its attempts stays parked, however
     * often the reconciliation runs.
     */
    await stranded(0);
    const parked = (await getBin(binId))!;
    expect(parked.state).toBe('NEEDS_HUMAN');
    expect(parked.attemptCount).toBe(parked.maxAttempts);

    await reconcileBins(fixture.project.id);
    await reconcileBins(fixture.project.id);

    expect((await getBin(binId))!.state).toBe('NEEDS_HUMAN');
    expect(
      (await listBinEvents(binId, 500)).filter((event) => event.eventType === 'BIN_REOPENED'),
    ).toHaveLength(0);
  });

  it('credits each refusal once, however many times it runs', async () => {
    await stranded(71);
    await reconcileBins(fixture.project.id);
    const once = (await getBin(binId))!.attemptCount;

    await reconcileBins(fixture.project.id);
    await reconcileBins(fixture.project.id);
    expect((await getBin(binId))!.attemptCount).toBe(once);
  });
});
