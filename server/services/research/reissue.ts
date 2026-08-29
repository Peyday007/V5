/**
 * Reissuing one verification a worker finished without performing.
 *
 * This exists because of a specific failure with a general shape. A worker's
 * budget ran out during a `RESEARCH_VERIFY` item; it completed the lease
 * instead of releasing it; the runner saw a finished job that had moved nothing
 * and stopped the packet for a person — correctly, and with real accepted
 * research inside it. The only documented remedy was to re-plan, which discards
 * exactly what §16 says to keep.
 *
 * `brain_complete_work` now refuses that completion, so no new packet can
 * arrive here. This is for the ones that already did.
 *
 * ---------------------------------------------------------------------------
 * Why it is narrow on purpose
 * ---------------------------------------------------------------------------
 *
 * The runner's rule is one work item per (type, target) for the life of the
 * packet, and that rule has a reason: a second item is a second Step 6
 * idempotency scope, so two items for one fragment can record two claim
 * ledgers. Anything that hands out replacement items is therefore a way to
 * break the guarantee the whole mechanism exists to provide.
 *
 * What makes this safe is not care; it is the precondition. A replacement is
 * issued **only** for an item that recorded nothing — and an item that recorded
 * nothing has no ledger to duplicate. That is the entire argument, and every
 * check below is there to establish that one fact beyond doubt before a row is
 * written.
 *
 * It is deliberately not a retry mechanism. It reissues verifications, it
 * refuses everything else, and a general "retry this item" built on top of it
 * would be exactly the thing the runner's rule forbids.
 */
import type {
  ActorType,
  ResearchFragment,
  ResearchOrchestration,
  WorkItem,
} from '../../domain/types.ts';
import {
  getFragment,
  getOrchestration,
  listClaimsForFragment,
  updateFragment,
  updateOrchestration,
} from '../../repos/research.ts';
import { enqueueWork, getWorkItem, listWorkItems } from '../../repos/workQueue.ts';
import { recordEvent } from '../../repos/events.ts';
import { workType } from '../queue/workTypes.ts';
import { runIdempotent, type OperationNamespace } from '../effects/engine.ts';
import { advancePacket, researchItemRecorded, type AdvanceResult } from './packetRunner.ts';

/**
 * One intent per failed item, whoever asks.
 *
 * `PROJECT` scope rather than principal, because two administrators reacting to
 * the same stuck packet are doing one thing, not two — and the effect they
 * would each perform is the creation of a work item, which is exactly what must
 * not happen twice.
 */
const REISSUE_NAMESPACE: OperationNamespace = {
  name: 'research.reissue-verification',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
};

export class NoSuchWorkItem extends Error {
  constructor() {
    super('No such work item.');
    this.name = 'NoSuchWorkItem';
  }
}

export class NotAVerification extends Error {
  constructor(readonly workType: string) {
    super(
      `That item is ${workType}, not RESEARCH_VERIFY. This reissues verifications only — a ` +
        'general retry would defeat the rule that one target gets one work item.',
    );
    this.name = 'NotAVerification';
  }
}

export class VerificationWasRecorded extends Error {
  constructor() {
    super(
      'That verification recorded a verdict, so the packet is not stuck on it and a replacement ' +
        'would be a second idempotency scope over evidence that already has one.',
    );
    this.name = 'VerificationWasRecorded';
  }
}

export class NotFinished extends Error {
  constructor(readonly state: string) {
    super(
      `That item is ${state}, which means somebody may still finish it. Only an item that has ` +
        'stopped without recording anything is stranded, and releasing a live one is the remedy ' +
        'for a live one.',
    );
    this.name = 'NotFinished';
  }
}

/**
 * Still someone's to finish.
 *
 * The same set `advancePacket` uses, and it has to be — the runner faults a
 * target when an item for it is **not live** and the state did not move, so a
 * recovery that defined "finished" more narrowly would refuse to repair
 * precisely the packets the fault stopped.
 *
 * The first version of this looked only at SUCCEEDED, on the assumption that a
 * worker completing without submitting was the only way to strand a
 * verification. It is not: an item that failed its last attempt, or one an
 * administrator cancelled, leaves the fragment just as ungated and trips the
 * same fault. The live packet showed no repair option at all because of it.
 *
 * Reissuing after a FAILED or CANCELLED item is exactly as safe as after a
 * SUCCEEDED one, and for the same single reason: nothing was recorded, so
 * there is no verdict for a replacement to contradict.
 */
const LIVE_STATES = new Set(['QUEUED', 'LEASED']);

export class ReplacementExists extends Error {
  constructor(readonly workItemId: string) {
    super(
      `A replacement verification already exists for this fragment (${workItemId}). Issuing ` +
        'another would put two live items on one target.',
    );
    this.name = 'ReplacementExists';
  }
}

export class FragmentMoved extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentMoved';
  }
}

export interface StrandedVerification {
  workItemId: string;
  orchestrationId: string;
  fragmentId: string;
  fragmentKey: string;
  fragmentStatus: ResearchFragment['status'];
  claims: number;
  completedAt: string | null;
  attemptCount: number;
}

/**
 * Every verification in one packet that finished without doing its job.
 *
 * Read-only, and separate from the reissue on purpose: naming the item is the
 * operator's decision, so the two halves are a list and a targeted action
 * rather than a sweep. A sweep is how a narrow recovery becomes a general one.
 */
export async function findStrandedVerifications(
  orchestrationId: string,
): Promise<StrandedVerification[]> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) return [];

  const items = (await listWorkItems(orchestration.projectId, { limit: 500 })).filter(
    (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_VERIFY',
  );

  const stranded: StrandedVerification[] = [];
  for (const item of items) {
    if (LIVE_STATES.has(item.state)) continue;
    if (await researchItemRecorded(item)) continue;
    if (!item.fragmentId) continue;
    const fragment = await getFragment(item.fragmentId);
    if (!fragment) continue;
    if (await liveOrRecordedReplacement(items, item)) continue;

    stranded.push({
      workItemId: item.id,
      orchestrationId: orchestration.id,
      fragmentId: fragment.id,
      fragmentKey: fragment.fragmentKey,
      fragmentStatus: fragment.status,
      claims: 0,
      completedAt: item.completedAt,
      attemptCount: item.attemptCount,
    });
  }
  return stranded;
}

/**
 * Is there already another verification for this fragment that counts?
 *
 * Counts means live — someone may still do it — or finished having recorded a
 * verdict. A second stranded one does not count, because two items that both
 * did nothing still leave the fragment ungated.
 */
async function liveOrRecordedReplacement(
  items: WorkItem[],
  original: WorkItem,
): Promise<WorkItem | null> {
  for (const item of items) {
    if (item.id === original.id) continue;
    if (item.fragmentId !== original.fragmentId) continue;
    if (LIVE_STATES.has(item.state)) return item;
    if (await researchItemRecorded(item)) return item;
  }
  return null;
}

export interface ReissueResult {
  status: 'REISSUED' | 'ALREADY_REISSUED';
  originalWorkItemId: string;
  replacementWorkItemId: string | null;
  fragmentKey: string;
  advanced: AdvanceResult | null;
}

/**
 * Issue one replacement verification, once.
 *
 * Every check runs before the operation is reserved, so a refusal costs nothing
 * and leaves no record claiming an attempt was made. The creation itself is a
 * same-database effect under Step 6, keyed on the failed item — so two
 * administrators pressing this at the same moment produce one work item and one
 * of them is told it was already done.
 *
 * Nothing else is touched. No claim, verdict, rejection reason, attempt count,
 * lease generation or usage record is written, cleared or reset. The original
 * item stays exactly as it is, because it is the evidence for why this
 * happened.
 */
export async function reissueMissingVerification(input: {
  workItemId: string;
  actor: { type: ActorType; id: string };
}): Promise<ReissueResult> {
  const original = await getWorkItem(input.workItemId);
  if (!original) throw new NoSuchWorkItem();

  // 1. It is a verification.
  if (original.workType !== 'RESEARCH_VERIFY') throw new NotAVerification(original.workType);

  // 2. It has stopped. A live item is not stranded — it is someone's to
  //    release, and releasing it is that situation's remedy.
  if (LIVE_STATES.has(original.state)) throw new NotFinished(original.state);

  // 3. It recorded nothing. The whole safety argument rests here: an item with
  //    no verdict behind it has no ledger a replacement could duplicate.
  if (await researchItemRecorded(original)) throw new VerificationWasRecorded();

  // 4. It still belongs to a packet and a fragment, and they still agree.
  if (!original.orchestrationId || !original.fragmentId) {
    throw new FragmentMoved('That item is not linked to a packet and a fragment.');
  }
  const orchestration = await getOrchestration(original.orchestrationId);
  const fragment = await getFragment(original.fragmentId);
  if (!orchestration || !fragment) {
    throw new FragmentMoved('The packet or the fragment this item belonged to is gone.');
  }
  if (fragment.orchestrationId !== orchestration.id) {
    throw new FragmentMoved(
      'That fragment no longer belongs to the packet the work item was created for.',
    );
  }
  if (orchestration.projectId !== original.projectId) {
    throw new FragmentMoved('The packet and the work item disagree about which project this is.');
  }

  // 5. Nothing has already replaced it.
  const items = (await listWorkItems(orchestration.projectId, { limit: 500 })).filter(
    (item) => item.orchestrationId === orchestration.id && item.workType === 'RESEARCH_VERIFY',
  );
  const existing = await liveOrRecordedReplacement(items, original);
  if (existing) throw new ReplacementExists(existing.id);

  const definition = workType('RESEARCH_VERIFY');
  const outcome = await runIdempotent<{ workItemId: string }>(
    {
      namespace: REISSUE_NAMESPACE,
      projectId: orchestration.projectId,
      // Keyed on the failed item and nothing else. Not the actor, not the
      // clock, not the fragment's current state — a key that changed between
      // two administrators pressing this would not be an idempotency key.
      key: `reissue-verify.${original.id}`,
      payload: { originalWorkItemId: original.id, operation: 'reissue-verification' },
      principalType: input.actor.type,
      principalId: input.actor.id,
    },
    async () => {
      const replacement = await enqueueWork({
        projectId: orchestration.projectId,
        workType: 'RESEARCH_VERIFY',
        payload: definition.validate({}),
        requiredScopes: definition.requiredScopes,
        orchestrationId: orchestration.id,
        fragmentId: fragment.id,
        // Ahead of new research, as the runner queues verifications: finishing
        // a fragment that already cost the allowance is worth more than
        // starting one that has not.
        priority: 7,
        createdByType: input.actor.type,
        createdById: input.actor.id,
      });
      return {
        resultRef: replacement.id,
        resultSummary: `Reissued the verification for ${fragment.fragmentKey}`,
        value: { workItemId: replacement.id },
      };
    },
  );

  if (outcome.status !== 'EXECUTED') {
    return {
      status: 'ALREADY_REISSUED',
      originalWorkItemId: original.id,
      replacementWorkItemId: outcome.operation.resultRef,
      fragmentKey: fragment.fragmentKey,
      advanced: null,
    };
  }

  // The audit trail, linking the replacement to what it replaces. Append-only,
  // and it names both ids so the pair can be read back years later without
  // inferring the relationship from timestamps.
  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_REPLANNED',
    payload: {
      recovery: 'reissue-verification',
      orchestrationId: orchestration.id,
      fragmentId: fragment.id,
      fragmentKey: fragment.fragmentKey,
      originalWorkItemId: original.id,
      originalCompletedAt: original.completedAt,
      replacementWorkItemId: outcome.value.workItemId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: 'The original verification completed without recording a verdict.',
    },
  });

  /**
   * Let the packet run again.
   *
   * `faultedOut` set NEEDS_HUMAN, which `advancePacket` treats as terminal, so
   * the replacement would sit unclaimed behind a packet that had stopped. The
   * fault is now answered, so the reason for the stop is gone — and it is
   * cleared here rather than by a person, because clearing it by hand while the
   * cause remained would be worse than leaving it.
   *
   * Only from NEEDS_HUMAN. A packet that failed or was cancelled for some other
   * reason is not something this operation gets to reopen.
   */
  if (orchestration.status === 'NEEDS_HUMAN') {
    await updateOrchestration(orchestration.id, {
      status: 'RESEARCHING',
      failureReason: null,
      completedAt: null,
    });
  }

  /**
   * And restore the fragment the fault blocked.
   *
   * `faultedOut` marks the fragment BLOCKED as well as stopping the packet, so
   * clearing only the orchestration leaves a terminal fragment behind and
   * `advancePacket` puts the packet straight back to NEEDS_HUMAN — which is
   * what happened the first time this was written, and what its own test
   * caught.
   *
   * Restored only when the gate never ran. A fragment with a verdict was
   * blocked by the gate, and that is a real outcome this operation has no
   * business reversing; a fragment with no verdict at all can only have been
   * blocked by the fault, because nothing else blocks a fragment silently.
   * That is the same fact the entire operation rests on, asked once more.
   *
   * Where it goes back to is derived, not assumed: with claims recorded it is
   * waiting to be gated, and without them it is waiting to be researched.
   */
  const current = await getFragment(fragment.id);
  if (current && current.status === 'BLOCKED' && !current.integrityVerdict && !current.sufficiencyVerdict) {
    const claims = await listClaimsForFragment(fragment.id);
    await updateFragment(fragment.id, {
      status: claims.length > 0 ? 'VALIDATING' : 'QUEUED',
      blockedReason: null,
      completedAt: null,
    });
  }

  return {
    status: 'REISSUED',
    originalWorkItemId: original.id,
    replacementWorkItemId: outcome.value.workItemId,
    fragmentKey: fragment.fragmentKey,
    advanced: await advancePacket(orchestration.id),
  };
}

export type { ResearchOrchestration };
