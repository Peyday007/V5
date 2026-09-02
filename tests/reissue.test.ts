/**
 * Recovering one verification a worker finished without performing.
 *
 * This reproduces the failure that stopped the first real packet, and the tests
 * are written as the ways a recovery like this goes wrong. Handing out
 * replacement work items is dangerous on its face: the runner's rule is one
 * item per (type, target) precisely because a second item is a second Step 6
 * idempotency scope, and two scopes over one fragment can record two claim
 * ledgers.
 *
 * The whole safety argument is one precondition — a replacement is issued only
 * for an item that recorded *nothing*, which therefore has no ledger to
 * duplicate. So most of what follows is about establishing that precondition
 * beyond doubt, and refusing when it does not hold.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getFragment,
  getOrchestration,
  listClaimsForFragment,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { listEvents } from '../server/repos/events.ts';
import {
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  getWorkItem,
  listWorkItems,
} from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import {
  findRetryableFragments,
  FragmentNotRetryable,
  findStrandedVerifications,
  NotAVerification,
  NotFinished,
  ReplacementExists,
  reissueMissingVerification,
  retryFragment,
  VerificationWasRecorded,
} from '../server/services/research/reissue.ts';
import type {
  ClaimedWork,
  Layer,
  Principal,
  Project,
  ResearchFragment,
  ResearchOrchestration,
  WorkerScope,
} from '../server/domain/types.ts';

const FULL: WorkerScope[] = [
  'project:read', 'documents:read', 'research:read', 'research:propose', 'research:write',
  'claims:write', 'contradictions:write', 'checkpoints:write', 'blockers:report',
  'queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete',
];

let project: Project;
let layer: Layer;
let workerId = '';
const ADMIN = { type: 'HUMAN' as const, id: 'usr_admin' };

async function principal(): Promise<Principal> {
  return {
    type: 'WORKER', id: workerId, handle: 'test-worker', displayName: 'Test Worker',
    isBrainAdmin: false, mustChangePassword: false, credentialId: 'cred_test',
    authMethod: 'WORKER_BEARER',
    memberships: [{
      id: 'mem_test', projectId: project.id, principalType: 'WORKER', principalId: workerId,
      role: 'MEMBER', scopes: FULL, active: true, grantedByType: 'SYSTEM', grantedById: 'seed',
      grantedAt: new Date().toISOString(), revokedAt: null,
    }],
    requestId: 'req_test',
  };
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const outcome = await tool.run(args, {
    principal: await principal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value;
}

const SOURCED = {
  claim: 'Texas Occupations Code section 1101.002(5) defines real estate as an interest in real property.',
  claim_type: 'SOURCED_FACT',
  source_url: 'https://statutes.capitol.texas.gov/Docs/OC/htm/OC.1101.htm',
  source_title: 'Occupations Code section 1101.002',
  source_publisher: 'Texas Legislature',
  source_date: '2026-01-01',
  evidence_excerpt: '"Real estate" means any interest in real property...',
  evidence_locator: 'section 1101.002(5)',
  evidence_lane: 'statute',
  retrieved_at: '2026-08-29',
  confidence: 0.9,
  primary_source: true,
};
const MATCHES = { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' };

async function makeOrchestration(): Promise<ResearchOrchestration> {
  const run = await createRun({
    projectId: project.id, layerId: layer.id, runType: 'FOUNDATION',
    status: 'PLANNED', provider: 'WORKER', prompt: 'Business-broker licensing.',
  });
  return await createOrchestration({
    projectId: project.id, layerId: layer.id, runId: run.id,
    title: 'Business-broker licensing for success-fee intermediation',
    assignment: 'Which US states require a licence.',
    provider: 'WORKER', autoApprove: false,
  });
}

async function makeFragment(orchestration: ResearchOrchestration): Promise<ResearchFragment> {
  const [fragment] = await createFragments([{
    orchestrationId: orchestration.id, projectId: project.id, layerId: layer.id,
    fragmentIndex: 0, fragmentKey: 'tx-licence-trigger',
    question: 'Does Texas require a licence for a success fee on a business sale?',
    geography: 'Texas', timeframe: 'in force as at 2026', population: null, definitions: null,
    requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }], acceptableSourceTypes: ['statute'], excludedSourceTypes: [],
    completionCriteria: ['One statute section that answers yes or no.'],
    dependsOn: [], minIndependentSources: 1, status: 'QUEUED',
  }]);
  return fragment!;
}

async function claimOne(type: string): Promise<ClaimedWork> {
  const [claimed] = await claimWork({
    workerId, scopes: [{ projectId: project.id, scopes: FULL }], workTypes: [type],
  });
  if (!claimed) throw new Error(`nothing claimable of type ${type}`);
  return claimed;
}

function proof(claimed: ClaimedWork): Record<string, unknown> {
  return {
    work_item_id: claimed.workItemId,
    lease_id: claimed.leaseId,
    lease_generation: claimed.leaseGeneration,
  };
}

/**
 * The packet exactly as the live one was: claims in, verification stranded.
 *
 * The stranding goes through the repository rather than the tool, because the
 * tool refuses it now — which is the point. This reconstructs a state that can
 * still exist in a database written before that refusal, and cannot be created
 * through the boundary any more.
 */
async function strandedPacket(): Promise<{
  orchestration: ResearchOrchestration;
  fragment: ResearchFragment;
  verifyItemId: string;
  claimId: string;
}> {
  const orchestration = await makeOrchestration();
  const fragment = await makeFragment(orchestration);

  const research = await claimOne('RESEARCH_FRAGMENT').catch(async () => {
    const definition = workType('RESEARCH_FRAGMENT');
    await enqueueWork({
      projectId: project.id, workType: 'RESEARCH_FRAGMENT',
      payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment.id, createdByType: 'SYSTEM',
    });
    return await claimOne('RESEARCH_FRAGMENT');
  });
  await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
  await call('brain_complete_work', { ...proof(research), summary: 'claims in' });
  const [claim] = await listClaimsForFragment(fragment.id);

  // The runner queued the verification; a worker took it and finished without
  // submitting. Straight through the repository, as a database written before
  // the boundary refused it would hold.
  const verify = await claimOne('RESEARCH_VERIFY');
  await completeWork(
    { workItemId: verify.workItemId, leaseId: verify.leaseId, leaseGeneration: verify.leaseGeneration, workerId },
    { summary: 'out of budget' },
  );

  /**
   * And the runner blocked the fragment.
   *
   * This used to assert the whole *packet* went NEEDS_HUMAN, which is what the
   * runner did and what turned out to be wrong. A fault is about one fragment;
   * stopping the packet froze every healthy fragment beside it, permanently,
   * because `advancePacket` short-circuits on NEEDS_HUMAN. On the live packet
   * that meant four fragments holding real research could never be handed a
   * verification job — which is exactly what two worker sessions reported.
   *
   * The packet's own end state is still decided where it always was: when
   * everything has finished, or when nothing left can move.
   */
  await advancePacket(orchestration.id);
  expect((await getFragment(fragment.id))?.status).toBe('BLOCKED');

  return {
    orchestration: (await getOrchestration(orchestration.id))!,
    fragment: (await getFragment(fragment.id))!,
    verifyItemId: verify.workItemId,
    claimId: claim!.id,
  };
}

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layer = await fixture.layerByName('Monetization Logic');
  const worker = await createWorker({
    name: 'test-worker', displayName: 'Test Worker',
    createdByType: 'SYSTEM', createdById: 'seed',
  });
  workerId = worker.id;
  await grantMembership({
    projectId: project.id, principalType: 'WORKER', principalId: worker.id,
    role: 'MEMBER', scopes: FULL, grantedByType: 'SYSTEM', grantedById: 'seed',
  });
});

// ---------------------------------------------------------------------------
// Finding it
// ---------------------------------------------------------------------------

describe('finding a stranded verification', () => {
  it('names the item, the fragment and when it finished', async () => {
    const { orchestration, verifyItemId } = await strandedPacket();

    const stranded = await findStrandedVerifications(orchestration.id);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.workItemId).toBe(verifyItemId);
    expect(stranded[0]!.fragmentKey).toBe('tx-licence-trigger');
  });

  it('finds nothing in a packet whose verification recorded a verdict', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const definition = workType('RESEARCH_FRAGMENT');
    await enqueueWork({
      projectId: project.id, workType: 'RESEARCH_FRAGMENT',
      payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment.id, createdByType: 'SYSTEM',
    });
    const research = await claimOne('RESEARCH_FRAGMENT');
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    await call('brain_complete_work', { ...proof(research), summary: 'in' });
    const [claim] = await listClaimsForFragment(fragment.id);

    const verify = await claimOne('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: claim!.id, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });

    expect(await findStrandedVerifications(orchestration.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What it refuses
// ---------------------------------------------------------------------------

describe('what the reissue refuses', () => {
  it('refuses anything that is not a verification', async () => {
    const { orchestration } = await strandedPacket();
    const research = (await listWorkItems(project.id, { limit: 100 })).find(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_FRAGMENT',
    );

    await expect(
      reissueMissingVerification({ workItemId: research!.id, actor: ADMIN }),
    ).rejects.toBeInstanceOf(NotAVerification);
  });

  it('refuses a verification that recorded a verdict', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const definition = workType('RESEARCH_FRAGMENT');
    await enqueueWork({
      projectId: project.id, workType: 'RESEARCH_FRAGMENT',
      payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment.id, createdByType: 'SYSTEM',
    });
    const research = await claimOne('RESEARCH_FRAGMENT');
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    await call('brain_complete_work', { ...proof(research), summary: 'in' });
    const [claim] = await listClaimsForFragment(fragment.id);
    const verify = await claimOne('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: claim!.id, supports_claim: false, ...MATCHES, note: 'no' }],
      sufficiency: 'INSUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'gated' });

    // A failing gate is a recorded outcome. Reissuing over it would be a second
    // idempotency scope on evidence that already has one.
    await expect(
      reissueMissingVerification({ workItemId: verify.workItemId, actor: ADMIN }),
    ).rejects.toBeInstanceOf(VerificationWasRecorded);
  });

  it('refuses an item that is still live, because releasing is that remedy', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const definition = workType('RESEARCH_VERIFY');
    await enqueueWork({
      projectId: project.id, workType: 'RESEARCH_VERIFY',
      payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment.id, createdByType: 'SYSTEM',
    });
    const live = await claimOne('RESEARCH_VERIFY');

    await expect(
      reissueMissingVerification({ workItemId: live.workItemId, actor: ADMIN }),
    ).rejects.toBeInstanceOf(NotFinished);
  });

  it('refuses a second replacement while the first is still live', async () => {
    const { verifyItemId } = await strandedPacket();
    await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    // The operation record would replay, so this proves the *precondition*
    // refuses too — a different administrator, a different key, same answer.
    const second = await reissueMissingVerification({
      workItemId: verifyItemId,
      actor: { type: 'HUMAN', id: 'usr_other' },
    }).catch((error: unknown) => error as Error);
    expect(second).toBeInstanceOf(ReplacementExists);
  });

  it('refuses when the fragment no longer belongs to the packet', async () => {
    const { verifyItemId, fragment } = await strandedPacket();
    const other = await makeOrchestration();
    await updateFragment(fragment.id, { status: 'VALIDATING' });
    // Move the fragment out from under the item.
    await import('../server/db/database.ts').then(async ({ getDb }) => {
      await getDb().run('UPDATE research_fragments SET orchestration_id = ? WHERE id = ?', [
        other.id,
        fragment.id,
      ]);
    });

    await expect(
      reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN }),
    ).rejects.toThrow(/no longer belongs/);
  });
});

// ---------------------------------------------------------------------------
// What it does
// ---------------------------------------------------------------------------

describe('reissuing the verification', () => {
  it('creates exactly one replacement and leaves everything else alone', async () => {
    const { orchestration, fragment, verifyItemId, claimId } = await strandedPacket();
    const before = await getWorkItem(verifyItemId);

    const result = await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    expect(result.status).toBe('REISSUED');
    expect(result.fragmentKey).toBe('tx-licence-trigger');

    const verifies = (await listWorkItems(project.id, { limit: 100 })).filter(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_VERIFY',
    );
    expect(verifies).toHaveLength(2);

    // The original is untouched — it is the evidence for why this happened.
    const after = await getWorkItem(verifyItemId);
    expect(after?.state).toBe(before?.state);
    expect(after?.attemptCount).toBe(before?.attemptCount);
    expect(after?.leaseGeneration).toBe(before?.leaseGeneration);
    expect(after?.completedAt).toBe(before?.completedAt);

    // And so is the research. No claim, verdict or rejection reason moved.
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.id).toBe(claimId);
    expect(claims[0]!.accepted).toBe(false);
  });

  it('is idempotent under a race: two at once produce one work item', async () => {
    // The sequential case is caught by the precondition and gets a better
    // message for it — the test above proves that. This is the case the
    // precondition *cannot* cover, because it is a read-then-write race: two
    // administrators reacting to the same stuck packet at the same instant,
    // neither of whom can see the other's item yet.
    //
    // This is what the Step 6 reservation is for, and the only way to show it
    // is to actually run them together.
    const { orchestration, verifyItemId } = await strandedPacket();

    const outcomes = await Promise.allSettled([
      reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN }),
      reissueMissingVerification({ workItemId: verifyItemId, actor: { type: 'HUMAN', id: 'usr_other' } }),
    ]);

    // However the two resolve — one executing and one replaying, or one
    // executing and one refused — exactly one work item may exist.
    const verifies = (await listWorkItems(project.id, { limit: 100 })).filter(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_VERIFY',
    );
    expect(verifies).toHaveLength(2);

    const created = outcomes
      .filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof reissueMissingVerification>>> =>
        outcome.status === 'fulfilled')
      .filter((outcome) => outcome.value.status === 'REISSUED');
    expect(created).toHaveLength(1);
  });

  it('links the replacement to what it replaces, in the audit trail', async () => {
    const { orchestration, verifyItemId } = await strandedPacket();
    const result = await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    const events = await listEvents(project.id, 50);
    const recovery = events.find(
      (event) => (event.payload as Record<string, unknown>)['recovery'] === 'reissue-verification',
    );
    expect(recovery).toBeTruthy();
    const payload = recovery!.payload as Record<string, unknown>;
    expect(payload['originalWorkItemId']).toBe(verifyItemId);
    expect(payload['replacementWorkItemId']).toBe(result.replacementWorkItemId);
    expect(payload['orchestrationId']).toBe(orchestration.id);
    expect(payload['actorId']).toBe(ADMIN.id);
  });

  it('restores a packet that a person had to be called for', async () => {
    const { orchestration, verifyItemId } = await strandedPacket();
    // A single blocked fragment no longer stops the packet, so put it in the
    // state a packet reaches when nothing else can move — which is the state
    // the reissue exists to lift.
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: 'Nothing left can move.',
    });

    await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    const after = await getOrchestration(orchestration.id);
    expect(after?.status).not.toBe('NEEDS_HUMAN');
    expect(after?.failureReason).toBeNull();
  });

  it('will not reopen a packet that was cancelled for some other reason', async () => {
    const { orchestration, verifyItemId } = await strandedPacket();
    await updateOrchestration(orchestration.id, {
      status: 'CANCELLED',
      cancelReason: 'A person stopped this.',
    });

    await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    // The replacement exists; the packet stays cancelled. Reopening something
    // a person closed is not this operation's business.
    expect((await getOrchestration(orchestration.id))?.status).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// What "finished" has to mean
// ---------------------------------------------------------------------------

describe('any way an item stops without recording', () => {
  /**
   * The live packet found this: the console showed no repair option at all.
   *
   * The runner faults a target when an item for it is not *live* and the state
   * did not move, so a recovery that only recognised SUCCEEDED would refuse to
   * repair exactly the packets the fault stopped. An item that failed its last
   * attempt leaves the fragment as ungated as one that was completed without
   * submitting, and reissuing after either is safe for the same single reason:
   * nothing was recorded.
   */
  it('finds a verification that failed rather than completed', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const definition = workType('RESEARCH_FRAGMENT');
    await enqueueWork({
      projectId: project.id, workType: 'RESEARCH_FRAGMENT',
      payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment.id, createdByType: 'SYSTEM',
    });
    const research = await claimOne('RESEARCH_FRAGMENT');
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    await call('brain_complete_work', { ...proof(research), summary: 'in' });

    // The verification is claimed and fails out of attempts.
    const verify = await claimOne('RESEARCH_VERIFY');
    await failWork(
      { workItemId: verify.workItemId, leaseId: verify.leaseId, leaseGeneration: verify.leaseGeneration, workerId },
      { category: 'ATTEMPTS_EXHAUSTED', detail: 'The source would not load.', retryable: false },
    );

    const stranded = await findStrandedVerifications(orchestration.id);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]!.workItemId).toBe(verify.workItemId);

    const result = await reissueMissingVerification({ workItemId: verify.workItemId, actor: ADMIN });
    expect(result.status).toBe('REISSUED');
  });

  it('still refuses an item somebody could yet finish', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);
    const definition = workType('RESEARCH_VERIFY');
    await enqueueWork({
      projectId: project.id, workType: 'RESEARCH_VERIFY',
      payload: definition.validate({}), requiredScopes: definition.requiredScopes,
      orchestrationId: orchestration.id, fragmentId: fragment.id, createdByType: 'SYSTEM',
    });

    // QUEUED, never claimed. Nobody is stuck; it simply has not been done.
    const queued = (await listWorkItems(project.id, { limit: 100 })).find(
      (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_VERIFY',
    );
    await expect(
      reissueMissingVerification({ workItemId: queued!.id, actor: ADMIN }),
    ).rejects.toBeInstanceOf(NotFinished);
    expect(await findStrandedVerifications(orchestration.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Another attempt at a fragment that failed its gate
// ---------------------------------------------------------------------------

/**
 * A fragment the *operator's* retry still applies to.
 *
 * Research it, have the gate reject it, and let the packet runner take the
 * automatic attempt §15 entitles it to — then have the gate reject that one
 * too. What is left is a fragment at the last attempt in its budget, which is
 * precisely the case this control exists for now.
 *
 * The division is deliberate and is enforced by two different numbers.
 * `buildRepairPlan` stops planning once `maxRepairs - attempt + 1 <= 1`, so the
 * runner spends every attempt the ladder has a fresh strategy for and no more.
 * `retryFragment` refuses only at `attempt > maxRepairs`, one later. The gap
 * between them is the final attempt, and it belongs to a person: it is the one
 * the automatic ladder has no new idea for, so spending it is a judgement about
 * whether this question is worth another try — not something to do on a timer.
 *
 * Before the runner had a repair planner, the first gate failure left the
 * fragment sitting for an operator, which is why these tests used to reach that
 * state in one round. They now take two, because the first one no longer waits
 * for anybody.
 */
async function gatedAndBlocked(): Promise<{
  orchestration: ResearchOrchestration;
  fragment: ResearchFragment;
  claimId: string;
}> {
  const orchestration = await makeOrchestration();
  const first = await makeFragment(orchestration);
  const definition = workType('RESEARCH_FRAGMENT');
  await enqueueWork({
    projectId: project.id, workType: 'RESEARCH_FRAGMENT',
    payload: definition.validate({}), requiredScopes: definition.requiredScopes,
    orchestrationId: orchestration.id, fragmentId: first.id, createdByType: 'SYSTEM',
  });

  /** Research one attempt, then have verification reject every claim in it. */
  const failOnce = async (fragmentId: string): Promise<string> => {
    const research = await claimOne('RESEARCH_FRAGMENT');
    await call('brain_submit_claims', { ...proof(research), claims: [SOURCED] });
    await call('brain_complete_work', { ...proof(research), summary: 'in' });
    const [claim] = await listClaimsForFragment(fragmentId);

    const verify = await claimOne('RESEARCH_VERIFY');
    await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [
        { claim_id: claim!.id, supports_claim: false, ...MATCHES, note: 'Says something else.' },
      ],
      sufficiency: 'INSUFFICIENT',
    });
    await call('brain_complete_work', { ...proof(verify), summary: 'gated' });
    return claim!.id;
  };

  await failOnce(first.id);

  // The runner's own attempt, minted by the packet's reaction to the failure
  // rather than by anything here.
  const [second] = await currentFragments(orchestration.id);
  expect(second!.id).not.toBe(first.id);
  expect(second!.attempt).toBe(2);
  const claimId = await failOnce(second!.id);

  return {
    orchestration: (await getOrchestration(orchestration.id))!,
    fragment: (await getFragment(second!.id))!,
    claimId,
  };
}

describe('trying a failed fragment again', () => {
  it('offers it only once the gate has actually rejected it', async () => {
    const { orchestration, fragment } = await gatedAndBlocked();
    expect(fragment.status).toBe('BLOCKED');

    const retryable = await findRetryableFragments(orchestration.id);
    expect(retryable.map((entry) => entry.fragmentKey)).toEqual(['tx-licence-trigger']);
    expect(retryable[0]!.claims).toBe(1);
    expect(retryable[0]!.sufficiencyVerdict).toBe('INSUFFICIENT');
  });

  it('creates the next attempt and keeps the failed one entire', async () => {
    const { orchestration, fragment, claimId } = await gatedAndBlocked();

    const result = await retryFragment({
      fragmentId: fragment.id,
      reason: 'Single publisher; try the regulator.',
      actor: ADMIN,
    });

    expect(result.status).toBe('RETRIED');
    // Three, not two: the runner already took the second.
    expect(result.attempt).toBe(3);

    // The failed attempt is untouched. Its claims and its rejection reason are
    // the history the next attempt exists not to repeat — §15 and invariant 5.
    const old = await getFragment(fragment.id);
    expect(old?.status).toBe('BLOCKED');
    expect(old?.sufficiencyVerdict).toBe('INSUFFICIENT');
    const oldClaims = await listClaimsForFragment(fragment.id);
    expect(oldClaims).toHaveLength(1);
    expect(oldClaims[0]!.id).toBe(claimId);
    expect(oldClaims[0]!.accepted).toBe(false);
    expect(oldClaims[0]!.rejectionReason ?? '').not.toBe('');

    // And the new one carries every declaration forward, so it is judged by the
    // standard the last one failed.
    const next = await getFragment(result.newFragmentId!);
    expect(next?.attempt).toBe(3);
    expect(next?.parentFragmentId).toBe(fragment.id);
    expect(next?.status).toBe('QUEUED');
    expect(next?.question).toBe(fragment.question);
    expect(next?.minIndependentSources).toBe(fragment.minIndependentSources);
    expect(next?.completionCriteria).toEqual(fragment.completionCriteria);
    expect(next?.requiredEvidence).toEqual(fragment.requiredEvidence);
    // It starts with no claims of its own.
    expect(await listClaimsForFragment(next!.id)).toHaveLength(0);
  });

  it('supersedes the failed attempt without deleting it', async () => {
    const { orchestration, fragment } = await gatedAndBlocked();
    const result = await retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN });

    const live = await currentFragments(orchestration.id);
    expect(live.map((entry) => entry.id)).toEqual([result.newFragmentId]);
    // Superseded, not gone.
    expect(await getFragment(fragment.id)).toBeTruthy();
  });

  it('queues research for the new attempt and unsticks the packet', async () => {
    const { orchestration, fragment } = await gatedAndBlocked();
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason: 'Stopped for a person.',
    });

    const result = await retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN });

    const after = await getOrchestration(orchestration.id);
    expect(after?.status).not.toBe('NEEDS_HUMAN');
    expect(after?.failureReason).toBeNull();
    expect(result.advanced?.enqueued.map((entry) => entry.workType)).toContain('RESEARCH_FRAGMENT');

    // And a worker can claim it.
    const claimed = await claimOne('RESEARCH_FRAGMENT');
    expect(claimed.workItemId).toBeTruthy();
  });

  it('withdraws the superseded attempt\'s work, so nobody is dispatched at it', async () => {
    /*
     * The defect the Step 10 packet paid for. The fragment row is superseded
     * by a higher attempt, but the work item pointing at the old row stayed
     * QUEUED, so a worker was dispatched at an attempt that no longer existed
     * and failed — one activation out of a routine's hourly fire budget, which
     * is the scarce resource this step measured.
     */
    const { orchestration, fragment } = await gatedAndBlocked();
    const stale = await enqueueWork({
      projectId: project.id,
      workType: 'RESEARCH_FRAGMENT',
      payload: { fragmentKey: fragment.fragmentKey },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
      fragmentId: fragment.id,
    });
    expect(stale.state).toBe('QUEUED');

    const result = await retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN });
    expect(result.status).toBe('RETRIED');

    const after = await getWorkItem(stale.id);
    expect(after?.state).toBe('CANCELLED');
    // Cancellation advances the generation, so a late completion from whoever
    // held the old lease matches nothing — §19, not a special case for this.
    expect(after!.leaseGeneration).toBeGreaterThan(stale.leaseGeneration);
    expect(after?.cancelledReason ?? '').toMatch(/superseded/i);
  });

  it("leaves another fragment's live work alone", async () => {
    // The inversion. A withdrawal that reached past the superseded row would
    // be cancelling work somebody is doing.
    const { orchestration, fragment } = await gatedAndBlocked();
    const [other] = await createFragments([{
      orchestrationId: orchestration.id, projectId: project.id, layerId: layer.id,
      fragmentIndex: 9, fragmentKey: 'a-different-question',
      question: 'A different bounded question entirely.',
      requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['statute'], excludedSourceTypes: [],
      completionCriteria: ['a section'], dependsOn: [], minIndependentSources: 1,
      attempt: 1, maxRepairs: 2, status: 'QUEUED',
    } as unknown as Parameters<typeof createFragments>[0][number]]);
    const untouched = await enqueueWork({
      projectId: project.id,
      workType: 'RESEARCH_FRAGMENT',
      payload: { fragmentKey: 'a-different-question' },
      createdByType: 'SYSTEM',
      requiredScopes: ['queue:claim'],
      orchestrationId: orchestration.id,
      fragmentId: other!.id,
    });

    await retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN });

    expect((await getWorkItem(untouched.id))?.state).toBe('QUEUED');
  });

  it('refuses a fragment that has used its repair budget', async () => {
    // `attempt` is immutable per row — a later attempt is a new row — so the
    // exhausted case is built as one, which is also how it arises.
    const orchestration = await makeOrchestration();
    const [spent] = await createFragments([{
      orchestrationId: orchestration.id, projectId: project.id, layerId: layer.id,
      fragmentIndex: 0, fragmentKey: 'spent-fragment',
      question: 'A question that has had every attempt it is going to get.',
      requiredEvidence: [{ id: 'statute', description: 'statute', necessity: 'REQUIRED' }], acceptableSourceTypes: ['statute'], excludedSourceTypes: [],
      completionCriteria: ['a section'], dependsOn: [], minIndependentSources: 1,
      status: 'BLOCKED', attempt: 3, maxRepairs: 2,
    }]);

    const refused = await retryFragment({
      fragmentId: spent!.id, reason: 'again', actor: ADMIN,
    }).catch((error: unknown) => error as Error);

    expect(refused).toBeInstanceOf(FragmentNotRetryable);
    // §15: when the budget runs out the honest outcome is unresolved, recorded
    // as such — not a further attempt at the same question.
    expect((refused as Error).message).toMatch(/unresolved/i);
  });

  it('refuses a fragment that did not fail', async () => {
    const orchestration = await makeOrchestration();
    const fragment = await makeFragment(orchestration);

    // QUEUED, never gated. Trying it "again" would be trying it for the first
    // time, with a second row for one question.
    await expect(
      retryFragment({ fragmentId: fragment.id, reason: 'again', actor: ADMIN }),
    ).rejects.toBeInstanceOf(FragmentNotRetryable);
  });

  it('is idempotent: two administrators produce one new attempt', async () => {
    const { orchestration, fragment } = await gatedAndBlocked();

    const first = await retryFragment({ fragmentId: fragment.id, reason: 'a', actor: ADMIN });
    const again = await retryFragment({ fragmentId: fragment.id, reason: 'b', actor: ADMIN });

    expect(first.status).toBe('RETRIED');
    expect(again.status).toBe('ALREADY_RETRIED');
    expect(again.newFragmentId).toBe(first.newFragmentId);
    expect(await currentFragments(orchestration.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The point of all of it
// ---------------------------------------------------------------------------

describe('after recovery', () => {
  it('the claims pass through verification and gating normally', async () => {
    const { orchestration, fragment, verifyItemId, claimId } = await strandedPacket();
    await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    // A worker claims the replacement exactly as it would any verification.
    const verify = await claimOne('RESEARCH_VERIFY');
    expect(verify.workItemId).not.toBe(verifyItemId);

    const gated = await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: claimId, supports_claim: true, ...MATCHES, note: 'Reads directly.' }],
      sufficiency: 'SUFFICIENT',
    });

    expect(gated['integrity']).toBe('PASS');
    expect(gated['acceptedClaims']).toBe(1);

    // The gate ran on the original research — the same claim row, now accepted.
    const claims = await listClaimsForFragment(fragment.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.id).toBe(claimId);
    expect(claims[0]!.accepted).toBe(true);
    expect((await getFragment(fragment.id))?.status).toBe('ACCEPTED');

    // And completing it is now allowed, because it recorded something.
    await call('brain_complete_work', { ...proof(verify), summary: 'gated' });
    expect((await getWorkItem(verify.workItemId))?.state).toBe('SUCCEEDED');

    // Nothing stranded remains.
    expect(await findStrandedVerifications(orchestration.id)).toHaveLength(0);
  });

  it('refuses a claim the source does not support, exactly as before', async () => {
    // The recovery must not soften the gate. Same packet, same replacement, a
    // verdict that says the source does not support the claim.
    const { fragment, verifyItemId, claimId } = await strandedPacket();
    await reissueMissingVerification({ workItemId: verifyItemId, actor: ADMIN });

    const verify = await claimOne('RESEARCH_VERIFY');
    const gated = await call('brain_submit_verification', {
      ...proof(verify),
      verdicts: [{ claim_id: claimId, supports_claim: false, ...MATCHES, note: 'Says something else.' }],
      sufficiency: 'SUFFICIENT',
    });

    expect(gated['acceptedClaims']).toBe(0);
    expect((await listClaimsForFragment(fragment.id))[0]!.accepted).toBe(false);
    expect((await getFragment(fragment.id))?.status).toBe('BLOCKED');
  });
});
