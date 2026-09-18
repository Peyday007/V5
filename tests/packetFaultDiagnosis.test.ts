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
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { cancelWork, enqueueWork } from '../server/repos/workQueue.ts';
import { advancePacket, faultedOutReason } from '../server/services/research/packetRunner.ts';

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
