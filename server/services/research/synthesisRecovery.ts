/**
 * Reissuing one synthesis a worker submitted and Brain could not file.
 *
 * `reissueMissingVerification` is the same shape one work type along, and its
 * safety argument is inherited verbatim: **a replacement is issued only for an
 * item that recorded nothing**, and an item that recorded nothing has no ledger
 * for a second Step 6 scope to duplicate. Every check below exists to establish
 * that one fact beyond doubt before a row is written.
 *
 * It is written for a specific failure. A cash packet's report reached
 * `fileResearchPacket`, which built an object key carrying the em dash §33 put
 * in the canonical name, and the bucket answered `400 InvalidKey`. That throw
 * happens *inside* `runIdempotent`'s transaction, so the synthesis pass and the
 * report text roll back and the claims, verifications and gate decisions — all
 * written by earlier tools — survive untouched. The research is intact; only
 * the prose is gone. Re-running the synthesis is therefore the whole repair,
 * and re-planning the packet would discard exactly what §16 says to keep.
 *
 * ---------------------------------------------------------------------------
 * Why "the database rolled back" is not enough
 * ---------------------------------------------------------------------------
 *
 * A rollback is evidence about *Brain's* rows and about nothing else. The
 * upload is an external effect performed inside that transaction, so there is a
 * window where the bucket accepted the bytes and the transaction then failed:
 * §20's rule that a timeout is not evidence, at a new boundary. A recovery that
 * reasoned from the absent document row alone would re-file a report that had
 * already been stored, under a second key, leaving two copies and one row.
 *
 * So the store is asked. An object that looks like this packet's report, with
 * no document row pointing at it, is an **ambiguous external filing** and is
 * refused by name — the remedy is a person deciding what those bytes are, and
 * that decision is not this function's to make. A store that cannot be read at
 * all is also a refusal, for the same reason: unknown must never read as
 * absent.
 *
 * ---------------------------------------------------------------------------
 * What it does not do
 * ---------------------------------------------------------------------------
 *
 * It resets nothing. No claim, verdict, rejection reason, attempt count, lease
 * generation, budget reservation or usage record is written, cleared or
 * re-spent. The original item keeps its state, its attempts and its history,
 * because it is the evidence for why this happened. It is not a retry
 * mechanism, it refuses every work type but `RESEARCH_SYNTHESIZE`, and a
 * general "retry this item" built on top of it would be exactly what the
 * runner's one-item-per-target rule forbids.
 */
import type { ActorType, ResearchOrchestration, WorkItem } from '../../domain/types.ts';
import {
  citableClaims,
  getOrchestration,
  listPasses,
  updateOrchestration,
} from '../../repos/research.ts';
import { enqueueWork, getWorkItem, listWorkItems } from '../../repos/workQueue.ts';
import { binForOrchestration, getBin, reopenNeedsHumanBin } from '../../repos/bins.ts';
import { getLayer } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import { getRun } from '../../repos/runs.ts';
import { listDocuments } from '../../repos/documents.ts';
import { recordEvent } from '../../repos/events.ts';
import { operationsForWorkItems } from '../../repos/idempotency.ts';
import { getMissionByOrchestration, transitionMission } from '../../repos/russellMissions.ts';
import { buildNames } from '../../domain/naming.ts';
import { layerPrefix } from '../storage.ts';
import { getStorage } from '../storage/index.ts';
import { safeSegment } from '../storage/keys.ts';
import { workType } from '../queue/workTypes.ts';
import { runIdempotent, type OperationNamespace } from '../effects/engine.ts';
import { targetVersionForRun } from '../runArtifacts.ts';

/**
 * One intent per failed item, whoever asks.
 *
 * `PROJECT` scope rather than principal, for `reissue-verification`'s reason:
 * two administrators reacting to the same stuck packet are doing one thing, and
 * the effect they would each perform is the creation of a work item.
 */
const RECOVER_NAMESPACE: OperationNamespace = {
  name: 'research.reissue-synthesis',
  version: 1,
  principalScope: 'PROJECT',
  retention: 'PERMANENT',
};

/** Still someone's to finish. The same set `advancePacket` uses. */
const LIVE_STATES = new Set(['QUEUED', 'LEASED']);

export type RecoveryRefusal =
  | 'NO_SUCH_ITEM'
  | 'NOT_A_SYNTHESIS'
  | 'STILL_LIVE'
  | 'ALREADY_FILED'
  | 'SYNTHESIS_RECORDED'
  | 'OPERATION_SUCCEEDED'
  | 'REPLACEMENT_EXISTS'
  | 'NO_CITABLE_EVIDENCE'
  | 'PACKET_NOT_RECOVERABLE'
  | 'BIN_EXHAUSTED'
  | 'BIN_UNAVAILABLE'
  | 'AMBIGUOUS_EXTERNAL_FILING'
  | 'STORE_UNREADABLE';

export interface RecoveryOutcome {
  ok: boolean;
  status: 'RECOVERED' | 'ALREADY_RECOVERED' | 'REFUSED';
  refusal?: RecoveryRefusal;
  reason: string;
  originalWorkItemId: string;
  replacementWorkItemId: string | null;
  orchestrationId: string | null;
  /** What was restored so the ordinary scheduler can proceed. */
  restored?: { packet: string | null; bin: string | null; mission: string | null };
}

/** A refusal, in the shape `assessSynthesisRecovery` returns. */
function refuseAssessment(
  refusal: RecoveryRefusal,
  reason: string,
  workItemId: string,
  orchestrationId: string | null = null,
): Assessment {
  return { eligible: false, outcome: refuse(refusal, reason, workItemId, orchestrationId) };
}

function refuse(
  refusal: RecoveryRefusal,
  reason: string,
  workItemId: string,
  orchestrationId: string | null = null,
): RecoveryOutcome {
  return {
    ok: false,
    status: 'REFUSED',
    refusal,
    reason,
    originalWorkItemId: workItemId,
    replacementWorkItemId: null,
    orchestrationId,
  };
}

/**
 * Anything in the store that could be this packet's report.
 *
 * Matched on the *stem* of the canonical name rather than on one exact key,
 * because the key a given build produces has changed — that change is the
 * repair this recovery exists alongside — and `uniqueKey` may have appended a
 * ` (2)`. A stem match over-reports on purpose: a false positive costs a
 * refusal somebody reads, and a false negative costs a duplicate stored report
 * nobody ever reconciles.
 *
 * Returns `null` when the store could not be read, which the caller must treat
 * as a refusal rather than as an empty answer.
 */
async function objectsLookingLikeThisReport(
  orchestration: ResearchOrchestration,
): Promise<string[] | null> {
  const layer = await getLayer(orchestration.layerId);
  const project = await getProject(orchestration.projectId);
  const run = await getRun(orchestration.runId);
  if (!layer || !project || !run) return [];

  const version = await targetVersionForRun(run, layer.id, project.id);
  // Both spellings: the variant one this packet would build today, and the bare
  // layer-and-version one, since a stem match on the shorter covers the longer.
  const stem = safeSegment(buildNames(layer.name, version, '.md').canonicalName, 'document')
    .replace(/\.md$/i, '')
    .trim();
  if (stem.length === 0) return [];

  try {
    const keys = await getStorage().list(`${layerPrefix(project.slug, layer.slug)}/`);
    const needle = stem.toLowerCase();
    return keys.filter((key) => {
      const leaf = key.slice(key.lastIndexOf('/') + 1).toLowerCase();
      return leaf.startsWith(needle);
    });
  } catch {
    return null;
  }
}

/**
 * Recover one synthesis, once.
 *
 * Every check runs before the operation is reserved, so a refusal costs nothing
 * and leaves no record claiming an attempt was made. The creation itself is a
 * same-database effect under Step 6 keyed on the failed item, so two
 * administrators pressing this at the same moment produce one work item and the
 * loser is told which one.
 */
/** What an eligible recovery needs, read once and reused by the action. */
export interface RecoveryContext {
  original: WorkItem;
  orchestration: ResearchOrchestration;
  bin: Awaited<ReturnType<typeof getBin>>;
  citableClaimCount: number;
}

export type Assessment =
  | { eligible: true; context: RecoveryContext }
  | { eligible: false; outcome: RecoveryOutcome };

/**
 * Every check, and no effect at all.
 *
 * Separate from the action so that what a report says about a packet and what
 * the action would do to it are one function rather than two that agree today.
 * This repository has had to write that sentence about `auditRound`,
 * `completionLinks`, `reconcileAcceptedFragment` and `reconcileRepairs`; the
 * enumeration in `assessProjectSyntheses` is exactly the reader that would
 * otherwise drift.
 */
export async function assessSynthesisRecovery(workItemId: string): Promise<Assessment> {
  const original = await getWorkItem(workItemId);
  if (!original) {
    return refuseAssessment('NO_SUCH_ITEM', `No work item ${workItemId}.`, workItemId);
  }
  if (original.workType !== 'RESEARCH_SYNTHESIZE') {
    return refuseAssessment(
      'NOT_A_SYNTHESIS',
      `That item is ${original.workType}, not RESEARCH_SYNTHESIZE. This recovers syntheses only — ` +
        'a general retry would defeat the rule that one target gets one work item.',
      original.id,
    );
  }
  if (LIVE_STATES.has(original.state)) {
    return refuseAssessment(
      'STILL_LIVE',
      `That item is ${original.state}, so somebody may still finish it. Releasing a live item is ` +
        'the remedy for a live one.',
      original.id,
    );
  }
  if (!original.orchestrationId) {
    return refuseAssessment('NO_SUCH_ITEM', 'That item is not linked to a packet.', original.id);
  }

  const orchestration = await getOrchestration(original.orchestrationId);
  if (!orchestration) {
    return refuseAssessment('NO_SUCH_ITEM', 'The packet this item belonged to is gone.', original.id);
  }
  if (orchestration.projectId !== original.projectId) {
    return refuseAssessment(
      'NO_SUCH_ITEM',
      'The packet and the work item disagree about which project this is.',
      original.id,
      orchestration.id,
    );
  }

  // 1. Nothing was filed. The one fact everything else rests on.
  if (orchestration.documentId) {
    return refuseAssessment(
      'ALREADY_FILED',
      `This packet filed ${orchestration.documentId}, so its synthesis succeeded and a ` +
        'replacement would be a second scope over a report that already exists.',
      original.id,
      orchestration.id,
    );
  }
  const passes = await listPasses(orchestration.id);
  if (passes.some((pass) => pass.passKey === 'SYNTHESIS' && pass.completedAt)) {
    return refuseAssessment(
      'SYNTHESIS_RECORDED',
      'A synthesis pass completed for this packet, so something was recorded and this is not the ' +
        'state this recovery is for.',
      original.id,
      orchestration.id,
    );
  }

  // 2. No successful equivalent operation. The rollback is Brain's own account;
  //    this is the ledger's.
  const items = (await listWorkItems(orchestration.projectId, { limit: 500 })).filter(
    (item) => item.orchestrationId === orchestration.id,
  );
  const synthesisItems = items.filter((item) => item.workType === 'RESEARCH_SYNTHESIZE');
  const operations = await operationsForWorkItems(synthesisItems.map((item) => item.id));
  const succeeded = operations.find(
    (operation) =>
      operation.namespace === 'research.synthesis' && operation.state === 'SUCCEEDED',
  );
  if (succeeded) {
    return refuseAssessment(
      'OPERATION_SUCCEEDED',
      `A synthesis effect already completed for this packet (${succeeded.id}). Whatever the rows ` +
        'say about the document, this is not an item that recorded nothing.',
      original.id,
      orchestration.id,
    );
  }

  // 3. Nothing has already replaced it.
  const replacement = replacementFor(synthesisItems, original);
  if (replacement) {
    return {
      eligible: false,
      outcome: {
        ok: true,
        status: 'ALREADY_RECOVERED',
        reason:
          `A replacement synthesis already exists (${replacement.id}), in state ${replacement.state}. ` +
          'Issuing another would put two live items on one target.',
        originalWorkItemId: original.id,
        replacementWorkItemId: replacement.id,
        orchestrationId: orchestration.id,
      },
    };
  }

  // 4. There is something to synthesize from.
  const citable = await citableClaims(orchestration.id);
  if (citable.length === 0) {
    return refuseAssessment(
      'NO_CITABLE_EVIDENCE',
      'No claim in this packet cleared its gate, so a replacement synthesis would have nothing ' +
        'to cite. Repair or narrow the fragments instead.',
      original.id,
      orchestration.id,
    );
  }

  // 5. The packet is one a synthesis can still run in.
  if (!['NEEDS_HUMAN', 'SYNTHESIZING', 'AWAITING_REPAIR', 'RESEARCHING', 'VERIFYING'].includes(orchestration.status)) {
    return refuseAssessment(
      'PACKET_NOT_RECOVERABLE',
      `This packet is ${orchestration.status}. A recovery reopens a packet that stopped, not one ` +
        'that finished or was deliberately ended.',
      original.id,
      orchestration.id,
    );
  }

  // 6. The store has no copy of a report this packet never recorded.
  const strays = await objectsLookingLikeThisReport(orchestration);
  if (strays === null) {
    return refuseAssessment(
      'STORE_UNREADABLE',
      'The document store could not be listed, so whether this packet already uploaded a report ' +
        'is unknown — and unknown must not be read as absent before writing a second copy.',
      original.id,
      orchestration.id,
    );
  }
  if (strays.length > 0) {
    const known = new Set(
      (await listDocuments(orchestration.projectId))
        .flatMap((document) => [document.storageKey, document.filesystemPath])
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    const orphans = strays.filter((key) => !known.has(key));
    if (orphans.length > 0) {
      return refuseAssessment(
        'AMBIGUOUS_EXTERNAL_FILING',
        `The store holds ${orphans.length} object(s) that look like this packet's report and that ` +
          `no document row points at (${orphans.slice(0, 3).join(', ')}). Those bytes may be a ` +
          'report an earlier attempt uploaded before its transaction failed, so what they are is ' +
          'a person\'s decision rather than this recovery\'s.',
        original.id,
        orchestration.id,
      );
    }
  }

  // 7. The bin can still deliver the work.
  const found = await binForOrchestration(orchestration.id);
  const bin = found ? await getBin(found.id) : null;
  if (!bin) {
    return refuseAssessment(
      'BIN_UNAVAILABLE',
      'This packet has no bin, so nothing could be dispatched for a replacement. Its mission ' +
        'builds one; there is nothing here to reopen.',
      original.id,
      orchestration.id,
    );
  }
  if (bin.state !== 'NEEDS_HUMAN' && bin.state !== 'READY' && bin.state !== 'LEASED') {
    return refuseAssessment(
      'BIN_UNAVAILABLE',
      `The bin for this packet is ${bin.state}, which cannot be handed to a worker. A spent bin is ` +
        'replaced by a new launch, not reopened here.',
      original.id,
      orchestration.id,
    );
  }
  if (bin.attemptCount >= bin.maxAttempts) {
    return refuseAssessment(
      'BIN_EXHAUSTED',
      `The bin for this packet has used ${bin.attemptCount} of ${bin.maxAttempts} dispatch ` +
        'attempts, so a replacement item would sit in a bin nothing can fire at. Regrant its ' +
        'budget first, with the reason the budget went.',
      original.id,
      orchestration.id,
    );
  }


  return {
    eligible: true,
    context: { original, orchestration, bin, citableClaimCount: citable.length },
  };
}

/**
 * Recover one synthesis, once.
 *
 * Every check runs before the operation is reserved, so a refusal costs nothing
 * and leaves no record claiming an attempt was made. The creation itself is a
 * same-database effect under Step 6 keyed on the failed item, so two
 * administrators pressing this at the same moment produce one work item and the
 * loser is told which one.
 */
export async function recoverFailedSynthesis(input: {
  workItemId: string;
  actor: { type: ActorType; id: string };
  reason: string;
}): Promise<RecoveryOutcome> {
  const assessed = await assessSynthesisRecovery(input.workItemId);
  if (!assessed.eligible) return assessed.outcome;
  const { original, orchestration, bin, citableClaimCount } = assessed.context;
  if (!bin) {
    return refuse('BIN_UNAVAILABLE', 'This packet has no bin.', original.id, orchestration.id);
  }

  /* ---------------------------------------------------------------------- */
  /* Everything above is a decision. Below is the one effect.                */
  /* ---------------------------------------------------------------------- */

  const definition = workType('RESEARCH_SYNTHESIZE');
  const outcome = await runIdempotent<{ workItemId: string }>(
    {
      namespace: RECOVER_NAMESPACE,
      projectId: orchestration.projectId,
      // Keyed on the failed item and nothing else — not the actor, not the
      // clock, not the packet's current state. A key that changed between two
      // administrators pressing this would not be an idempotency key.
      key: `reissue-synthesis.${original.id}`,
      payload: { originalWorkItemId: original.id, operation: 'reissue-synthesis' },
      principalType: input.actor.type,
      principalId: input.actor.id,
    },
    async () => {
      const created = await enqueueWork({
        projectId: orchestration.projectId,
        workType: 'RESEARCH_SYNTHESIZE',
        payload: definition.validate({}),
        requiredScopes: definition.requiredScopes,
        orchestrationId: orchestration.id,
        // Ahead of new research: finishing a packet that already cost the
        // allowance is worth more than starting one that has not.
        priority: 8,
        createdByType: input.actor.type,
        createdById: input.actor.id,
      });
      return {
        resultRef: created.id,
        resultSummary: `Reissued the synthesis for ${orchestration.id}`,
        value: { workItemId: created.id },
      };
    },
  );

  if (outcome.status !== 'EXECUTED') {
    return {
      ok: true,
      status: 'ALREADY_RECOVERED',
      reason: 'This synthesis was already recovered; the replacement below is the one that exists.',
      originalWorkItemId: original.id,
      replacementWorkItemId: outcome.operation.resultRef,
      orchestrationId: orchestration.id,
    };
  }

  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_REPLANNED',
    payload: {
      recovery: 'reissue-synthesis',
      orchestrationId: orchestration.id,
      originalWorkItemId: original.id,
      originalState: original.state,
      originalAttempts: original.attemptCount,
      replacementWorkItemId: outcome.value.workItemId,
      citableClaims: citableClaimCount,
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: input.reason,
    },
  });

  const restored = { packet: null as string | null, bin: null as string | null, mission: null as string | null };

  /*
   * Let the packet run again.
   *
   * Only from NEEDS_HUMAN, and for `reissue-verification`'s reason: the fault
   * that set it is now answered, so the reason for the stop is gone. A packet
   * that stopped for something else is not this operation's to reopen. It goes
   * to SYNTHESIZING rather than RESEARCHING because that is the stage the
   * replacement item serves, and because `concludeAbandonedParks` cancels a
   * NEEDS_HUMAN packet under a terminal mission — leaving it there would hand
   * the recovery straight back to a sweep.
   */
  if (orchestration.status === 'NEEDS_HUMAN') {
    await updateOrchestration(orchestration.id, {
      status: 'SYNTHESIZING',
      currentPass: 'SYNTHESIS',
      failureReason: null,
      completedAt: null,
    });
    restored.packet = 'SYNTHESIZING';
  }

  /*
   * And the bin, which is how the work reaches a worker at all.
   *
   * Through the existing guarded transition rather than an update of its own:
   * it is a compare-and-swap on the generation, it refuses a bin with no
   * attempts left, and it records who answered the escalation and on what
   * evidence. A bin already READY needs nothing.
   */
  if (bin.state === 'NEEDS_HUMAN') {
    const reopened = await reopenNeedsHumanBin({
      binId: bin.id,
      leaseGeneration: bin.leaseGeneration,
      operator: `${input.actor.type}:${input.actor.id}`,
      reason: `Synthesis recovered: ${input.reason}`,
      resolutionEvidence: {
        recovery: 'reissue-synthesis',
        originalWorkItemId: original.id,
        replacementWorkItemId: outcome.value.workItemId,
        orchestrationId: orchestration.id,
      },
    });
    restored.bin = reopened.ok ? 'READY' : `not reopened (${reopened.refusal})`;
  } else {
    restored.bin = bin.state;
  }

  /*
   * And the mission, but only where restoring it can still mean something.
   *
   * `missionsAwaitingWriteback` selects `writeback_at IS NULL` and a live
   * state, so a terminal mission that has **not** written back is one whose
   * conclusion never reached the project and which the ordinary loop will
   * finish once the packet does. A mission that already wrote back is left
   * exactly as it is: the project has already been told something, and
   * replacing that belief is a decision no recovery gets to make on its own.
   *
   * No reservation is created, renewed or re-spent. The budget this mission
   * already consumed is history, and a recovery that bought a second slot
   * would be spending the allowance to repair Brain's own defect.
   */
  const mission = await getMissionByOrchestration(orchestration.id);
  if (mission && !mission.writebackAt && ['FAILED', 'NEEDS_HUMAN', 'CANCELLED'].includes(mission.state)) {
    // Guarded on the state it was read in, so a mission that moved underneath
    // this is left alone rather than dragged back.
    const moved = await transitionMission({
      missionId: mission.id,
      from: mission.state,
      to: 'RUNNING',
      terminalReason: null,
    });
    restored.mission = moved ? 'RUNNING' : `${mission.state} (moved while recovering)`;
  } else if (mission) {
    restored.mission = mission.writebackAt ? `${mission.state} (already wrote back)` : mission.state;
  }

  return {
    ok: true,
    status: 'RECOVERED',
    reason: `Reissued the synthesis with ${citableClaimCount} citable claim(s) intact.`,
    originalWorkItemId: original.id,
    replacementWorkItemId: outcome.value.workItemId,
    orchestrationId: orchestration.id,
    restored,
  };
}

/**
 * Is there already another synthesis for this packet that counts?
 *
 * Counts means live — somebody may still do it — or finished having filed.
 * A second stranded one does not count, because two items that both did
 * nothing leave the packet exactly as stuck.
 */
function replacementFor(items: WorkItem[], original: WorkItem): WorkItem | null {
  for (const item of items) {
    if (item.id === original.id) continue;
    if (LIVE_STATES.has(item.state)) return item;
  }
  return null;
}

export interface SynthesisAssessment {
  workItemId: string;
  orchestrationId: string | null;
  packetStatus: string | null;
  workItemState: string;
  attempts: string;
  /** Evidence that survived the failure. */
  citableClaims: number;
  documentId: string | null;
  binId: string | null;
  binState: string | null;
  binAttempts: string | null;
  missionState: string | null;
  eligible: boolean;
  refusal: RecoveryRefusal | 'ALREADY_RECOVERED' | null;
  reason: string;
}

/**
 * Every synthesis in one project that stopped, and what it would do next.
 *
 * Read-only, and separate from the action for `findStrandedVerifications`'
 * reason: naming the item is the operator's decision, so the two halves are a
 * list and a targeted action rather than a sweep. A sweep is how a narrow
 * recovery becomes a general one.
 *
 * Every verdict comes from `assessSynthesisRecovery`, so a packet this reports
 * as eligible is one the action will accept and a packet it refuses is one the
 * action refuses in the same words. The alternative — a report with its own
 * idea of eligibility — is the two-readers defect this repository keeps
 * correcting.
 */
export async function assessProjectSyntheses(projectId: string): Promise<SynthesisAssessment[]> {
  const items = (await listWorkItems(projectId, { limit: 500 })).filter(
    (item) => item.workType === 'RESEARCH_SYNTHESIZE' && !LIVE_STATES.has(item.state),
  );

  const out: SynthesisAssessment[] = [];
  for (const item of items) {
    const assessed = await assessSynthesisRecovery(item.id);
    const orchestration = item.orchestrationId ? await getOrchestration(item.orchestrationId) : null;
    const found = orchestration ? await binForOrchestration(orchestration.id) : null;
    const mission = orchestration ? await getMissionByOrchestration(orchestration.id) : null;
    const citable = orchestration ? (await citableClaims(orchestration.id)).length : 0;

    out.push({
      workItemId: item.id,
      orchestrationId: item.orchestrationId,
      packetStatus: orchestration?.status ?? null,
      workItemState: item.state,
      attempts: `${item.attemptCount}/${item.maxAttempts}`,
      citableClaims: citable,
      documentId: orchestration?.documentId ?? null,
      binId: found?.id ?? null,
      binState: found?.state ?? null,
      binAttempts: found ? `${found.attemptCount}/${found.maxAttempts}` : null,
      missionState: mission ? (mission.writebackAt ? `${mission.state} (wrote back)` : mission.state) : null,
      eligible: assessed.eligible,
      refusal: assessed.eligible
        ? null
        : assessed.outcome.status === 'ALREADY_RECOVERED'
          ? 'ALREADY_RECOVERED'
          : (assessed.outcome.refusal ?? null),
      reason: assessed.eligible ? 'Eligible for recovery.' : assessed.outcome.reason,
    });
  }
  return out;
}
