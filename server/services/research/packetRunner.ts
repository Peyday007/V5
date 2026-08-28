/**
 * The state machine that replaces the in-process loop.
 *
 * `orchestrator.ts` advances a packet by calling the next provider pass and
 * awaiting it. That works because every step happens inside one function on one
 * machine, and it is exactly what a pulling worker cannot do: the plan arrives
 * on Tuesday, a fragment on Wednesday, the judge on Thursday, possibly to
 * different processes and certainly to different leases.
 *
 * So the loop becomes a function of persisted state. Given an orchestration,
 * this decides what work should exist right now, and makes that true. It is
 * called after every research work item reaches a terminal state, and again at
 * boot, and calling it twice changes nothing — which is what makes crash
 * recovery ordinary rather than a special path.
 *
 * ---------------------------------------------------------------------------
 * Reading only rows
 * ---------------------------------------------------------------------------
 *
 * Nothing here is remembered between calls. The next step is derived from the
 * orchestration's status, its fragments' statuses, their dependencies, its
 * claims' acceptance and its passes — all of which are in the database because
 * §12 requires each of them to be written down as it happens.
 *
 * That is the property `recoverInterruptedResearch` promises for the push path,
 * and here it is not a recovery mechanism at all: it is the only mechanism.
 * A restart mid-packet resumes because resuming and continuing are the same
 * operation.
 *
 * ---------------------------------------------------------------------------
 * The approval gate
 * ---------------------------------------------------------------------------
 *
 * PLANNING does not advance on its own. §16 is explicit that research started
 * from a browser is planned in full and then stops until a person approves, and
 * the runner is where that would be most easily lost — one line moving fragments
 * from PLANNED to QUEUED and the allowance is spent before anybody looked. So
 * approval is a separate entry point a person calls, and the ordinary advance
 * refuses to queue a PLANNED fragment.
 */
import type {
  ResearchFragment,
  ResearchOrchestration,
  WorkItem,
  WorkerScope,
} from '../../domain/types.ts';
import {
  acceptedClaims,
  currentFragments,
  getOrchestration,
  listFragments,
  updateFragment,
  updateOrchestration,
} from '../../repos/research.ts';
import { enqueueWork, listWorkItems } from '../../repos/workQueue.ts';
import { workType, AUDIT_ROLES, type AuditRole } from '../queue/workTypes.ts';
import { recordEvent } from '../../repos/events.ts';

/** A fragment that has finished, whatever its verdict. */
const TERMINAL_FRAGMENT = new Set(['ACCEPTED', 'BLOCKED', 'REJECTED', 'CANCELLED']);

/** A work item that is still going to happen or is happening. */
const LIVE_ITEM = new Set(['QUEUED', 'LEASED']);

export interface AdvanceResult {
  orchestrationId: string;
  status: string;
  /** What this call created. Empty is the common and correct answer. */
  enqueued: { workType: string; workItemId: string; fragmentKey: string | null }[];
  /** Why nothing was enqueued, when nothing was. */
  waitingOn: string | null;
}

/**
 * Is there already live work of this type for this orchestration?
 *
 * The guard that makes the runner safe to call repeatedly. Two calls a
 * millisecond apart — a completion and a boot sweep, say — must not produce two
 * work items for the same fragment, and the check is against the queue's own
 * rows rather than against anything this process remembers.
 */
async function hasLiveWork(
  orchestration: ResearchOrchestration,
  predicate: (item: WorkItem) => boolean,
): Promise<boolean> {
  const items = await listWorkItems(orchestration.projectId, { limit: 500 });
  return items.some(
    (item) =>
      item.orchestrationId === orchestration.id && LIVE_ITEM.has(item.state) && predicate(item),
  );
}

async function enqueueResearchItem(input: {
  orchestration: ResearchOrchestration;
  type: string;
  fragment?: ResearchFragment | null;
  payload?: Record<string, unknown>;
  priority?: number;
}): Promise<{ workType: string; workItemId: string; fragmentKey: string | null }> {
  const definition = workType(input.type);
  const item = await enqueueWork({
    projectId: input.orchestration.projectId,
    workType: input.type,
    payload: definition.validate(input.payload ?? {}),
    requiredScopes: definition.requiredScopes as WorkerScope[],
    maxAttempts: definition.defaultMaxAttempts,
    orchestrationId: input.orchestration.id,
    fragmentId: input.fragment?.id ?? null,
    priority: input.priority ?? 6,
    // The Brain created this, not a person and not a worker. A worker cannot
    // create its own work, which is why no worker scope grants enqueueing.
    createdByType: 'SYSTEM',
  });
  return {
    workType: input.type,
    workItemId: item.id,
    fragmentKey: input.fragment?.fragmentKey ?? null,
  };
}

/** Which fragments may start: every dependency of theirs has been accepted. */
function readyToResearch(fragments: ResearchFragment[]): ResearchFragment[] {
  const accepted = new Set(
    fragments.filter((f) => f.status === 'ACCEPTED').map((f) => f.fragmentKey),
  );
  return fragments.filter((fragment) => {
    if (fragment.status !== 'QUEUED') return false;
    // A dependency that ended BLOCKED never becomes accepted, so a fragment
    // waiting on it waits forever. That is deliberate rather than an oversight:
    // the honest outcome is that the packet is short a foundation, and the
    // packet assessment says so. Silently starting it would produce an answer
    // resting on a definition nobody established.
    return fragment.dependsOn.every((key) => accepted.has(key));
  });
}

/**
 * Decide what work should exist for this packet, and make it so.
 *
 * Idempotent by construction: every branch checks the queue for live work of
 * the kind it is about to create before creating any.
 */
export async function advancePacket(orchestrationId: string): Promise<AdvanceResult> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) {
    return { orchestrationId, status: 'GONE', enqueued: [], waitingOn: 'no such orchestration' };
  }

  const done = ['COMPLETE', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN'];
  if (done.includes(orchestration.status)) {
    return {
      orchestrationId,
      status: orchestration.status,
      enqueued: [],
      waitingOn: `the packet is ${orchestration.status}`,
    };
  }

  const enqueued: AdvanceResult['enqueued'] = [];
  const fragments = await currentFragments(orchestration.id);

  // ---- Nothing planned yet: ask for a plan. ------------------------------
  if (fragments.length === 0) {
    if (await hasLiveWork(orchestration, (item) => item.workType === 'RESEARCH_PLAN')) {
      return { orchestrationId, status: orchestration.status, enqueued: [], waitingOn: 'the plan' };
    }
    enqueued.push(await enqueueResearchItem({ orchestration, type: 'RESEARCH_PLAN', priority: 7 }));
    await updateOrchestration(orchestration.id, { status: 'PLANNING', currentPass: 'PLAN' });
    return { orchestrationId, status: 'PLANNING', enqueued, waitingOn: null };
  }

  // ---- Planned but not approved: stop. -----------------------------------
  //
  // The gate §16 requires. A PLANNED fragment is a proposal a person has not
  // looked at, and the runner must not be the thing that decides to spend the
  // allowance on it.
  const awaitingApproval = fragments.filter((fragment) => fragment.status === 'PLANNED');
  if (awaitingApproval.length > 0) {
    return {
      orchestrationId,
      status: orchestration.status,
      enqueued: [],
      waitingOn: `a person to approve ${awaitingApproval.length} proposed fragment(s)`,
    };
  }

  // ---- Fragments whose claims are in: gate them. -------------------------
  for (const fragment of fragments.filter((f) => f.status === 'VALIDATING')) {
    const live = await hasLiveWork(
      orchestration,
      (item) => item.workType === 'RESEARCH_VERIFY' && item.fragmentId === fragment.id,
    );
    if (live) continue;
    enqueued.push(
      await enqueueResearchItem({
        orchestration,
        type: 'RESEARCH_VERIFY',
        fragment,
        // Ahead of new research: finishing a fragment that already cost the
        // allowance is worth more than starting one that has not.
        priority: 7,
      }),
    );
  }

  // ---- Fragments ready to research. --------------------------------------
  for (const fragment of readyToResearch(fragments)) {
    const live = await hasLiveWork(
      orchestration,
      (item) => item.workType === 'RESEARCH_FRAGMENT' && item.fragmentId === fragment.id,
    );
    if (live) continue;
    enqueued.push(
      await enqueueResearchItem({ orchestration, type: 'RESEARCH_FRAGMENT', fragment }),
    );
  }

  if (enqueued.length > 0) {
    if (orchestration.status !== 'RESEARCHING') {
      await updateOrchestration(orchestration.id, { status: 'RESEARCHING' });
    }
    return { orchestrationId, status: 'RESEARCHING', enqueued, waitingOn: null };
  }

  // ---- Still working? Then wait. -----------------------------------------
  const unfinished = fragments.filter((fragment) => !TERMINAL_FRAGMENT.has(fragment.status));
  if (unfinished.length > 0) {
    return {
      orchestrationId,
      status: orchestration.status,
      enqueued: [],
      waitingOn: `${unfinished.length} fragment(s) still in progress`,
    };
  }

  // ---- Every fragment is terminal. ---------------------------------------
  const accepted = fragments.filter((fragment) => fragment.status === 'ACCEPTED');
  if (accepted.length === 0) {
    // A packet where nothing cleared the gate is not a failure to retry; it is
    // a result a person needs to see. Repair is planned, not automatic — §15.
    await updateOrchestration(orchestration.id, {
      status: 'NEEDS_HUMAN',
      failureReason:
        'No fragment cleared its evidence gate, so there is nothing to synthesize. ' +
        'Repair or narrow the fragments and approve a new plan.',
      completedAt: new Date().toISOString(),
    });
    return {
      orchestrationId,
      status: 'NEEDS_HUMAN',
      enqueued: [],
      waitingOn: 'a person: no fragment cleared its gate',
    };
  }

  // ---- Synthesis, once there is something to synthesize from. ------------
  if (!orchestration.documentId) {
    if (await hasLiveWork(orchestration, (item) => item.workType === 'RESEARCH_SYNTHESIZE')) {
      return {
        orchestrationId,
        status: orchestration.status,
        enqueued: [],
        waitingOn: 'the synthesis',
      };
    }
    const claims = await acceptedClaims(orchestration.id);
    if (claims.length === 0) {
      await updateOrchestration(orchestration.id, {
        status: 'NEEDS_HUMAN',
        failureReason: 'Fragments were accepted but no claim was, so the packet has no evidence.',
        completedAt: new Date().toISOString(),
      });
      return {
        orchestrationId,
        status: 'NEEDS_HUMAN',
        enqueued: [],
        waitingOn: 'a person: no accepted claims',
      };
    }
    enqueued.push(
      await enqueueResearchItem({ orchestration, type: 'RESEARCH_SYNTHESIZE', priority: 8 }),
    );
    await updateOrchestration(orchestration.id, { status: 'SYNTHESIZING', currentPass: 'SYNTHESIS' });
    return { orchestrationId, status: 'SYNTHESIZING', enqueued, waitingOn: null };
  }

  // ---- The audit: three roles, strictly in order. ------------------------
  //
  // Serialised deliberately. The adversarial pass attacks what the primary
  // found and the judge weighs both, so running them together would produce
  // three independent opinions rather than one argument — which is a different
  // and much weaker thing than the pipeline this reuses.
  for (const role of AUDIT_ROLES) {
    const submitted = await auditRoleSubmitted(orchestration, role);
    if (submitted) continue;
    const live = await hasLiveWork(
      orchestration,
      (item) => item.workType === 'RESEARCH_AUDIT' && item.payload['role'] === role,
    );
    if (live) {
      return {
        orchestrationId,
        status: orchestration.status,
        enqueued: [],
        waitingOn: `the ${role} audit pass`,
      };
    }
    enqueued.push(
      await enqueueResearchItem({
        orchestration,
        type: 'RESEARCH_AUDIT',
        payload: { role },
        priority: 8,
      }),
    );
    if (orchestration.status !== 'AUDITING') {
      await updateOrchestration(orchestration.id, { status: 'AUDITING', currentPass: 'AUDIT' });
    }
    return { orchestrationId, status: 'AUDITING', enqueued, waitingOn: null };
  }

  // All three roles have run. The judge's own submission recorded the audit and
  // set the orchestration COMPLETE, so reaching here means it did not — which is
  // a state a person should look at rather than one to advance past.
  return {
    orchestrationId,
    status: orchestration.status,
    enqueued: [],
    waitingOn: 'the judge to record a verdict',
  };
}

/** Has this audit role already produced a completed pass? */
async function auditRoleSubmitted(
  orchestration: ResearchOrchestration,
  role: AuditRole,
): Promise<boolean> {
  const { earlierAuditRole } = await import('./auditBrief.ts');
  return (await earlierAuditRole(orchestration.id, role)) !== null;
}

/**
 * A person approves the plan, and the packet starts.
 *
 * Separate from `advancePacket` on purpose. Everything else the runner does is
 * a consequence of work finishing; this is the one transition that is a
 * decision, and a decision needs somebody to make it. Nothing has been spent
 * before this is called.
 */
export async function approvePlan(input: {
  orchestrationId: string;
  approvedByUserId: string;
  /** Fragment keys to drop. Everything not named is approved. */
  rejectedKeys?: string[];
}): Promise<AdvanceResult> {
  const orchestration = await getOrchestration(input.orchestrationId);
  if (!orchestration) {
    return {
      orchestrationId: input.orchestrationId,
      status: 'GONE',
      enqueued: [],
      waitingOn: 'no such orchestration',
    };
  }

  const rejected = new Set(input.rejectedKeys ?? []);
  const fragments = (await listFragments(orchestration.id)).filter((f) => f.status === 'PLANNED');
  if (fragments.length === 0) {
    return {
      orchestrationId: orchestration.id,
      status: orchestration.status,
      enqueued: [],
      waitingOn: 'nothing is awaiting approval',
    };
  }

  const at = new Date().toISOString();
  let approvedCount = 0;
  for (const fragment of fragments) {
    if (rejected.has(fragment.fragmentKey)) {
      await updateFragment(fragment.id, {
        status: 'CANCELLED',
        blockedReason: 'Not approved for research.',
        completedAt: at,
      });
      continue;
    }
    await updateFragment(fragment.id, { status: 'QUEUED', queuedAt: at });
    approvedCount += 1;
  }

  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_PLAN_REVIEWED',
    payload: {
      orchestrationId: orchestration.id,
      // Who approved it, because "a person approved this" is the whole content
      // of the event and an event that does not say who is not an audit trail.
      approvedByUserId: input.approvedByUserId,
      approved: approvedCount,
      rejected: fragments.length - approvedCount,
    },
  });

  if (approvedCount === 0) {
    await updateOrchestration(orchestration.id, {
      status: 'CANCELLED',
      cancelReason: 'Every proposed fragment was rejected.',
      cancelledAt: at,
    });
    return {
      orchestrationId: orchestration.id,
      status: 'CANCELLED',
      enqueued: [],
      waitingOn: 'every fragment was rejected',
    };
  }

  return await advancePacket(orchestration.id);
}

/**
 * Pick every unfinished worker-driven packet back up, at boot.
 *
 * Deliberately not the same treatment `recoverInterruptedResearch` gives a
 * push-model run. That one is closed as INTERRUPTED and left for a person,
 * because it needed a live process to continue and spending the allowance again
 * is the user's decision.
 *
 * A pulled packet has no process to have died. Its next step is a function of
 * its rows, so re-deriving it *is* resuming it, and there is nothing to decide.
 * What this actually repairs is narrow and real: a shutdown between a worker's
 * completion and the enqueue that should have followed it.
 *
 * Queues work; spends nothing. A worker still has to claim each item, and a
 * plan nobody approved stays PLANNED — `advancePacket` refuses to move it.
 */
export async function resumePulledPackets(): Promise<number> {
  const { listPendingOrchestrations } = await import('../../repos/research.ts');
  let advanced = 0;
  for (const orchestration of await listPendingOrchestrations()) {
    // Only packets that are actually worker-driven. A push-model orchestration
    // has no work items and enqueueing some would start it a second way.
    const items = await listWorkItems(orchestration.projectId, { limit: 500 });
    const isPulled = items.some((item) => item.orchestrationId === orchestration.id);
    if (!isPulled) continue;
    try {
      const result = await advancePacket(orchestration.id);
      if (result.enqueued.length > 0) advanced += 1;
    } catch (error) {
      // One unresumable packet must not stop the server booting. It stays
      // exactly as it is and the next completion or approval tries again.
      console.error(`[brain] could not resume packet ${orchestration.id}:`, error);
    }
  }
  return advanced;
}
