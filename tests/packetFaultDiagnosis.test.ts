/**
 * A packet that stops must say what stopped it, and not guess.
 *
 * Four production Cash discovery rounds parked reading *"A synthesis work item
 * finished without recording anything. The packet cannot continue on its own:
 * re-plan it, or investigate why the worker completed without submitting."*
 * Every word after the first sentence was an assertion `faultedOut` had
 * established nothing about, and it named the wrong party: the workers had
 * submitted correctly and `fileResearchPacket` could not store the bytes,
 * which it had already recorded on the row in the provider's own words.
 *
 * The overwrite is reachable because `NEEDS_HUMAN` was deliberately removed
 * from the runner's terminal list, so a packet that recorded a filing failure
 * is re-entered on the next tick, reaches the synthesis branch with
 * `documentId` still null, and used to have its diagnosis replaced. That is
 * why the fault was untraceable: the cause was recorded and then destroyed by
 * a downstream sentence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getOrchestration,
  insertClaims,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { cancelWork, enqueueWork, listWorkItemsForOrchestration } from '../server/repos/workQueue.ts';
import { advancePacket, faultedOutReason, MAX_ITEMS_PER_TARGET } from '../server/services/research/packetRunner.ts';

let projectId = '';
let layerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
});

/**
 * A packet in exactly the state production was in: every fragment terminal and
 * one ACCEPTED, a synthesis item that exists and is no longer live, and no
 * document — so the runner reaches the branch that faults the packet out.
 */
async function synthesisFaultedPacket(recordedReason: string | null): Promise<string> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'a bounded discovery question',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'a bounded discovery question',
    assignment: 'the openings it would find',
    provider: 'WORKER',
    autoApprove: false,
  });

  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      geography: 'United States',
      requiredEvidence: [{ id: 'demand_signal', description: 'a posting', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the marketplace itself'],
      excludedSourceTypes: ['a blog about it'],
      completionCriteria: ['one dated posting'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'openings',
      question: 'Who is asking to be paid for this?',
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

  // The synthesis item existed and is terminal. `alreadyCreated` is what the
  // runner reads, and it reads every state rather than only the live ones.
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_SYNTHESIZE',
    payload: { orchestrationId: orchestration.id },
    createdByType: 'SYSTEM',
    requiredScopes: ['queue:claim'],
    orchestrationId: orchestration.id,
  });
  await cancelWork(item.id, 'the worker finished it');

  await updateOrchestration(orchestration.id, {
    status: 'NEEDS_HUMAN',
    failureReason: recordedReason,
  });

  return orchestration.id;
}

describe('a faulted packet keeps the diagnosis it recorded', () => {
  it('preserves the filing failure rather than blaming the worker', async () => {
    // Verbatim what `fileResearchPacket` writes when the store refuses the key,
    // which is what happened in production.
    const filing =
      'The report could not be filed: the storage provider refused the key ' +
      '(400 InvalidKey).';
    const orchestrationId = await synthesisFaultedPacket(filing);

    const result = await advancePacket(orchestrationId);
    expect(result.status).toBe('NEEDS_HUMAN');

    const after = (await getOrchestration(orchestrationId))!;
    // The cause survives, in the provider's own words.
    expect(after.failureReason).toBe(filing);
    // And the sentence that destroyed it is gone, along with its accusation.
    expect(after.failureReason).not.toMatch(/finished without recording anything/i);
    expect(after.failureReason).not.toMatch(/why the worker completed without submitting/i);
    expect(result.waitingOn).toContain(filing);
    // The packet has still stopped: preserving a reason is not continuing.
    expect(after.completedAt).toBeTruthy();
  });

  it('says nothing was recorded when nothing was, rather than naming a party', async () => {
    const orchestrationId = await synthesisFaultedPacket(null);

    const result = await advancePacket(orchestrationId);
    expect(result.status).toBe('NEEDS_HUMAN');

    const after = (await getOrchestration(orchestrationId))!;
    expect(after.failureReason).toBe(faultedOutReason('synthesis'));
    // The two conditions must read differently, which is the whole point.
    expect(after.failureReason).toMatch(/nothing was\s+recorded about why/i);
    expect(after.failureReason).not.toMatch(/why the worker completed without submitting/i);
  });

  it('the fallback still says which kind of item it was', () => {
    expect(faultedOutReason('synthesis')).toContain('synthesis');
    expect(faultedOutReason('planning')).toContain('planning');
    // Kept, because three suites match on it and a mission carries it verbatim.
    expect(faultedOutReason('synthesis')).toMatch(/finished without recording anything/i);
  });
});

describe('an item the queue exhausted is replaced, bounded, rather than parked', () => {
  /** Mark every synthesis item of the packet as cancelled with its attempts spent. */
  /** The packet holds evidence, so the synthesis it is owed is a real one. */
  async function withAcceptedClaim(orchestrationId: string): Promise<string> {
    const [fragment] = await currentFragments(orchestrationId);
    await insertClaims([
      {
        orchestrationId,
        fragmentId: fragment!.id,
        passId: null,
        passKey: 'TARGETED',
        claim: 'A dated posting asks to be paid for this.',
        sourceUrl: 'https://example.test/posting',
        sourceTitle: 'A posting',
        sourcePublisher: 'A marketplace',
        sourceDate: '2026-10-19',
        evidenceExcerpt: 'We will pay for this.',
        evidenceLocator: 'the page',
        evidenceLane: 'demand_signal',
        retrievedAt: '2026-10-19T00:00:00.000Z',
        confidence: 0.9,
        validationState: 'SOURCED',
        validationDetail: null,
        sourced: true,
        accepted: true,
        claimType: 'SOURCED_FACT',
        contentHash: 'd'.repeat(64),
      } as never,
    ]);
    return orchestrationId;
  }

  async function exhaustSynthesisItems(orchestrationId: string): Promise<void> {
    const { getDb } = await import('../server/db/database.ts');
    for (const item of await listWorkItemsForOrchestration(orchestrationId)) {
      if (item.workType !== 'RESEARCH_SYNTHESIZE') continue;
      if (item.state === 'QUEUED' || item.state === 'LEASED') {
        await cancelWork(item.id, 'This item has spent all 2 of its attempts');
      }
      await getDb().run('UPDATE work_items SET attempt_count = max_attempts WHERE id = ?', [item.id]);
    }
  }

  it('gives a synthesis that ran out of attempts one more item, and resumes the packet', async () => {
    const orchestrationId = await withAcceptedClaim(await synthesisFaultedPacket(faultedOutReason('synthesis')));
    await exhaustSynthesisItems(orchestrationId);

    const result = await advancePacket(orchestrationId);
    expect(result.status).toBe('SYNTHESIZING');
    expect(result.enqueued.map((entry) => entry.workType)).toEqual(['RESEARCH_SYNTHESIZE']);
    const after = (await getOrchestration(orchestrationId))!;
    // Running again, so it must no longer be showing why it stopped.
    expect(after.failureReason).toBeNull();
    expect(after.completedAt).toBeNull();
  });

  it('parks the packet once the bound is spent, as before', async () => {
    const orchestrationId = await withAcceptedClaim(await synthesisFaultedPacket(null));
    for (let round = 1; round < MAX_ITEMS_PER_TARGET; round += 1) {
      await exhaustSynthesisItems(orchestrationId);
      expect((await advancePacket(orchestrationId)).status).toBe('SYNTHESIZING');
    }
    await exhaustSynthesisItems(orchestrationId);
    const result = await advancePacket(orchestrationId);
    expect(result.status).toBe('NEEDS_HUMAN');
    const synth = (await listWorkItemsForOrchestration(orchestrationId)).filter(
      (item) => item.workType === 'RESEARCH_SYNTHESIZE',
    );
    expect(synth).toHaveLength(MAX_ITEMS_PER_TARGET);
  });

  it('does not replace an item cancelled for another reason', async () => {
    // The fixture's item is cancelled with its attempts unspent.
    const orchestrationId = await withAcceptedClaim(await synthesisFaultedPacket(null));
    expect((await advancePacket(orchestrationId)).status).toBe('NEEDS_HUMAN');
  });

  it('does not replace a synthesis whose earlier item reached the effect', async () => {
    const orchestrationId = await withAcceptedClaim(await synthesisFaultedPacket(null));
    await exhaustSynthesisItems(orchestrationId);
    const { getDb } = await import('../server/db/database.ts');
    const [item] = (await listWorkItemsForOrchestration(orchestrationId)).filter(
      (one) => one.workType === 'RESEARCH_SYNTHESIZE',
    );
    // A filing that reached the store may have uploaded bytes: synthesisRecovery's.
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO idempotency_operations
         (id, scope_hash, key_fingerprint, namespace, project_id, created_by_type,
          work_item_id, request_fingerprint, reserved_at, created_at, updated_at)
       VALUES ('idop_test', 'scope', 'fp', 'research:synthesis', ?, 'WORKER', ?, 'req', ?, ?, ?)`,
      [projectId, item!.id, now, now, now],
    );
    expect((await advancePacket(orchestrationId)).status).toBe('NEEDS_HUMAN');
  });
});

describe('whether an envelope already approved this packet, read from its own events', () => {
  it('counts only a system approval of this packet under this envelope', async () => {
    const { recordEvent } = await import('../server/repos/events.ts');
    const { assignmentApprovedUnder } = await import('../server/services/research/packetRunner.ts');
    const orchestration = (await getOrchestration(await synthesisFaultedPacket(null)))!;
    const record = async (eventType: string, payload: Record<string, unknown>) =>
      recordEvent({
        projectId,
        layerId,
        entityType: 'RUN',
        entityId: orchestration.runId,
        eventType,
        payload: { orchestrationId: orchestration.id, ...payload },
      } as never);

    expect(await assignmentApprovedUnder(orchestration, 'ENV_A')).toBe(false);
    await record('RESEARCH_PLAN_OUTSIDE_ENVELOPE', { envelopeId: 'ENV_A', fits: false });
    await record('RESEARCH_PLAN_SYSTEM_APPROVED', { envelopeId: 'ENV_B', fits: true });
    await record('RESEARCH_PLAN_SYSTEM_APPROVED', { envelopeId: 'ENV_A', fits: false });
    expect(await assignmentApprovedUnder(orchestration, 'ENV_A')).toBe(false);
    await record('RESEARCH_PLAN_SYSTEM_APPROVED', { envelopeId: 'ENV_A', fits: true });
    expect(await assignmentApprovedUnder(orchestration, 'ENV_A')).toBe(true);
    // An approval recorded before the event carried `fits` is still an approval.
    expect(await assignmentApprovedUnder(orchestration, 'ENV_B')).toBe(true);
  });
});
