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
  getFragment,
  getOrchestration,
  listClaimsForFragment,
  listFragments,
  listPendingOrchestrations,
  updateFragment,
  updateOrchestration,
} from '../../repos/research.ts';
import { earlierAuditRole } from './auditBrief.ts';
import { assessPacket, MANDATORY_COVERAGE_CHECK } from './packet.ts';
import { cancelWork, enqueueWork, listWorkItems } from '../../repos/workQueue.ts';
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
  /**
   * Set when approving a fixture ran it, because "nothing was queued" is a
   * true statement about a fixture and a badly misleading one: nothing was
   * queued *because the work was already done*, not because it failed.
   */
  ran?: {
    acceptedFragments: number;
    blockedFragments: number;
    acceptedClaims: number;
    rejectedClaims: number;
    canonicalName: string | null;
  };
}

/**
 * Is there already live work of this type for this orchestration?
 *
 * The guard that makes the runner safe to call repeatedly. Two calls a
 * millisecond apart — a completion and a boot sweep, say — must not produce two
 * work items for the same fragment, and the check is against the queue's own
 * rows rather than against anything this process remembers.
 */
/**
 * Has this exact piece of work already been created — in any state at all?
 *
 * **This is the guard that matters most in the file, and the first version of
 * it was wrong.** It only looked at QUEUED and LEASED items, which meant that
 * when an item finished without moving the state it was supposed to move — a
 * worker that completes a `RESEARCH_FRAGMENT` without ever calling
 * `brain_submit_claims` — the runner saw no live work, saw a fragment still
 * QUEUED, and enqueued another one. That is a loop, and the loop is the
 * *lesser* problem.
 *
 * The real problem is that a second work item has a different id, and Step 6
 * keys a research effect from the work item. Two items for one fragment are
 * therefore two idempotency scopes, and the second one could record a second
 * claim ledger for the same fragment — the exact duplication the whole
 * mechanism exists to prevent, reintroduced above it.
 *
 * So the rule is: **one item per (type, target), for the life of the packet.**
 * Retrying inside an item is the queue's job and it already does it, bounded by
 * `max_attempts`, under one key. If an item reached a terminal state and the
 * state it should have moved did not move, that is a fault for a person to see
 * — not something to try again with a fresh key.
 */
function alreadyCreated(items: WorkItem[], predicate: (item: WorkItem) => boolean): boolean {
  return items.some(predicate);
}

/**
 * Did this research item actually record the thing it exists to record?
 *
 * Asked per type, against the rows, because that is the only honest answer. An
 * item's state says a worker said it was done; this says whether the packet
 * moved.
 *
 * Used in two places and for opposite reasons. `brain_complete_work` refuses a
 * completion when this is false, because an item whose whole purpose is to
 * record something, completed without recording it, is a contradiction and the
 * boundary is where contradictions get refused. And `advancePacket` treats a
 * no-op item as one that never happened, so a packet poisoned by one before
 * that refusal existed can still be recovered — bounded, because with the
 * refusal in place no new ones can be made.
 */
export async function researchItemRecorded(item: WorkItem): Promise<boolean> {
  if (!item.orchestrationId) return true;
  const orchestration = await getOrchestration(item.orchestrationId);
  if (!orchestration) return true;

  switch (item.workType) {
    case 'RESEARCH_PLAN':
      return (await currentFragments(orchestration.id)).length > 0;
    case 'RESEARCH_FRAGMENT': {
      if (!item.fragmentId) return true;
      return (await listClaimsForFragment(item.fragmentId)).length > 0;
    }
    case 'RESEARCH_VERIFY': {
      if (!item.fragmentId) return true;
      // The gate ran iff it left a verdict. A fragment can fail its gate and
      // that is a recorded outcome; what is not recorded is no verdict at all.
      const fragment = await getFragment(item.fragmentId);
      return Boolean(fragment?.integrityVerdict ?? fragment?.sufficiencyVerdict);
    }
    case 'RESEARCH_SYNTHESIZE':
      return orchestration.documentId !== null;
    case 'RESEARCH_AUDIT': {
      const role = item.payload['role'];
      if (typeof role !== 'string') return true;
      return await auditRoleSubmitted(orchestration, role as AuditRole);
    }
    default:
      // Not a research item, and not this module's business.
      return true;
  }
}

/**
 * Why a no-op item is not automatically replaced.
 *
 * It is tempting: an item that recorded nothing produced no ledger, so a
 * replacement could not duplicate one, and the packet would recover itself.
 * That reasoning holds for a verification and fails for a plan — a planning job
 * that yields no fragments would be re-issued forever, each new item resetting
 * the attempt count the last one exhausted, spending the allowance every time.
 *
 * So the automatic rule stays what it was: one item per (type, target), for the
 * life of the packet. What changed is upstream — `brain_complete_work` now
 * refuses to finish a research item that recorded nothing, so the state this
 * would have recovered from can no longer be created. Recovering the packets
 * that reached it before that refusal existed is a deliberate act, and it needs
 * to be per target rather than a blanket exemption.
 */

/** Of those, the ones still going to happen or happening right now. */
function stillRunning(items: WorkItem[], predicate: (item: WorkItem) => boolean): boolean {
  return items.some((item) => LIVE_ITEM.has(item.state) && predicate(item));
}

/**
 * Every item this orchestration has ever had, read once per advance.
 *
 * Once rather than per check because one advance asks about a dozen times — is
 * there a plan, is there work for this fragment, a verify for that one — and
 * each was a separate scan of the project's queue.
 *
 * Every state, not only the live ones, for the reason in `alreadyCreated`.
 */
async function itemsFor(orchestration: ResearchOrchestration): Promise<WorkItem[]> {
  const items = await listWorkItems(orchestration.projectId, { limit: 500 });
  return items.filter((item) => item.orchestrationId === orchestration.id);
}

/**
 * An item finished and the state it should have moved did not move.
 *
 * Recorded on the fragment, or on the orchestration when the work was not about
 * one, so the packet stops with a reason a person can act on rather than
 * spinning. `advancePacket` calls this instead of enqueueing a replacement.
 */
async function faultedOut(input: {
  orchestration: ResearchOrchestration;
  fragment?: ResearchFragment | null;
  what: string;
}): Promise<AdvanceResult> {
  const reason =
    `A ${input.what} work item finished without recording anything. ` +
    'The packet cannot continue on its own: re-plan it, or investigate why the worker ' +
    'completed without submitting.';
  if (input.fragment) {
    await updateFragment(input.fragment.id, {
      status: 'BLOCKED',
      blockedReason: reason,
      completedAt: new Date().toISOString(),
    });
  }
  await updateOrchestration(input.orchestration.id, {
    status: 'NEEDS_HUMAN',
    failureReason: reason,
    completedAt: new Date().toISOString(),
  });
  return {
    orchestrationId: input.orchestration.id,
    status: 'NEEDS_HUMAN',
    enqueued: [],
    waitingOn: `a person: ${reason}`,
  };
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

/**
 * Fragments that can never start, and the dependencies that doomed them.
 *
 * `readyToResearch` waits for a dependency to be accepted, and says plainly
 * that a dependency which ended BLOCKED never will. What it does not say is
 * what happens next, and until now the answer was nothing: a fragment stuck
 * behind a failed dependency is not TERMINAL, so `advancePacket` counted it as
 * "still in progress" and returned that answer forever. The packet could never
 * reach synthesis and could never reach a person. It reported progress it was
 * not making — the same lie §9 forbids a planner to tell about a document it
 * cannot read.
 *
 * A dependency dooms a fragment when it is terminal without being accepted, or
 * when it is itself doomed, or when no fragment carries that key at all. The
 * third is worth including: a plan naming a dependency that does not exist is
 * waiting on something that cannot arrive.
 *
 * Computed to a fixpoint, because doom is transitive — a penalty fragment
 * waiting on a trigger fragment waiting on a boundary fragment that failed is
 * as stuck as the boundary one.
 *
 * Nothing is mutated. A doomed fragment stays QUEUED, because repairing the
 * dependency un-dooms it and a status written here would have to be unwritten.
 */
function doomedBy(fragments: ResearchFragment[]): Map<string, string[]> {
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));
  const doomed = new Map<string, string[]>();

  for (let pass = 0; pass < fragments.length + 1; pass += 1) {
    let changed = false;
    for (const fragment of fragments) {
      if (TERMINAL_FRAGMENT.has(fragment.status) || doomed.has(fragment.fragmentKey)) continue;
      const blockers = fragment.dependsOn.filter((key) => {
        const dependency = byKey.get(key);
        if (!dependency) return true;
        if (doomed.has(key)) return true;
        return TERMINAL_FRAGMENT.has(dependency.status) && dependency.status !== 'ACCEPTED';
      });
      if (blockers.length > 0) {
        doomed.set(fragment.fragmentKey, blockers);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return doomed;
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
  let items = await itemsFor(orchestration);

  /**
   * Retire queued work its fragment has already outgrown.
   *
   * A worker that submits a fragment's claims and then *releases* the item
   * rather than completing it — which the contract tells it to do when its
   * allowance runs out — leaves a `RESEARCH_FRAGMENT` item sitting QUEUED while
   * its fragment has moved to VALIDATING. Nothing was stale about that item
   * when it was created and nothing removed it afterwards, so the queue kept
   * handing it out: a research assignment for a fragment that has already been
   * researched.
   *
   * That happened on the live packet. The worker was given one, recognised the
   * fragment as its own from a few minutes earlier, and released it rather than
   * file a second ledger. `brain_submit_claims` now refuses that submission
   * outright — but being refused is a worse outcome than never being offered
   * the work, and a queue that hands out work nobody should do is wrong on its
   * own terms.
   *
   * QUEUED only. An item a worker is holding is not stale: the fragment is very
   * likely VALIDATING *because* that worker just submitted, and cancelling
   * underneath it would fail the completion it is about to make.
   */
  const outgrown = items.filter((item) => {
    if (item.state !== 'QUEUED') return false;
    if (!item.fragmentId) return false;
    const fragment = fragments.find((candidate) => candidate.id === item.fragmentId);
    if (!fragment) return false;
    if (item.workType === 'RESEARCH_FRAGMENT') {
      return fragment.status !== 'QUEUED' && fragment.status !== 'RUNNING';
    }
    if (item.workType === 'RESEARCH_VERIFY') {
      return Boolean(fragment.integrityVerdict ?? fragment.sufficiencyVerdict);
    }
    return false;
  });
  if (outgrown.length > 0) {
    for (const item of outgrown) {
      await cancelWork(
        item.id,
        'Its fragment has already moved past the state this item serves, so doing it would ' +
          'duplicate work that is done.',
      );
    }
    items = await itemsFor(orchestration);
  }

  // ---- Nothing planned yet: ask for a plan. ------------------------------
  if (fragments.length === 0) {
    const planItem = (item: WorkItem): boolean => item.workType === 'RESEARCH_PLAN';
    if (stillRunning(items, planItem)) {
      return { orchestrationId, status: orchestration.status, enqueued: [], waitingOn: 'the plan' };
    }
    // A plan item that finished and produced no fragments. Not retried with a
    // fresh key; a person looks at it.
    if (alreadyCreated(items, planItem)) {
      return await faultedOut({ orchestration, what: 'planning' });
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
    const verifyItem = (item: WorkItem): boolean =>
      item.workType === 'RESEARCH_VERIFY' && item.fragmentId === fragment.id;
    if (stillRunning(items, verifyItem)) continue;
    if (alreadyCreated(items, verifyItem)) {
      return await faultedOut({ orchestration, fragment, what: 'verification' });
    }
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
    const researchItem = (item: WorkItem): boolean =>
      item.workType === 'RESEARCH_FRAGMENT' && item.fragmentId === fragment.id;
    if (stillRunning(items, researchItem)) continue;
    if (alreadyCreated(items, researchItem)) {
      return await faultedOut({ orchestration, fragment, what: 'research' });
    }
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

  // ---- Still working? Then wait — unless nothing left can move. ----------
  const unfinished = fragments.filter((fragment) => !TERMINAL_FRAGMENT.has(fragment.status));
  if (unfinished.length > 0) {
    const doomed = doomedBy(fragments);
    const stuck = unfinished.filter((fragment) => doomed.has(fragment.fragmentKey));

    // Every remaining fragment is waiting on one that failed. Nothing will
    // arrive to change that, so saying "in progress" would be waiting for an
    // event that cannot happen. A person decides: repair the dependency, or
    // accept the packet is short a foundation.
    if (stuck.length === unfinished.length) {
      const detail = stuck
        .map((fragment) => `${fragment.fragmentKey} (waiting on ${doomed.get(fragment.fragmentKey)!.join(', ')})`)
        .join('; ');
      await updateOrchestration(orchestration.id, {
        status: 'NEEDS_HUMAN',
        failureReason:
          `${stuck.length} fragment(s) can never start, because every dependency they are ` +
          `waiting on ended without being accepted: ${detail}. Repair the dependency and its ` +
          'dependents become researchable again; nothing here is lost.',
        completedAt: new Date().toISOString(),
      });
      return {
        orchestrationId,
        status: 'NEEDS_HUMAN',
        enqueued: [],
        waitingOn: `a person: ${stuck.length} fragment(s) are waiting on a dependency that failed`,
      };
    }

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
    const synthItem = (item: WorkItem): boolean => item.workType === 'RESEARCH_SYNTHESIZE';
    if (stillRunning(items, synthItem)) {
      return {
        orchestrationId,
        status: orchestration.status,
        enqueued: [],
        waitingOn: 'the synthesis',
      };
    }
    if (alreadyCreated(items, synthItem)) {
      return await faultedOut({ orchestration, what: 'synthesis' });
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

    /**
     * §16's question, asked before the synthesis job exists rather than after
     * a worker has written one.
     *
     * `assessPacket` checks the packet against the whole goal — mandatory
     * coverage, foundational fragments settled, one definition, one geography,
     * one timeframe, one population, calculation inputs themselves accepted,
     * nothing load-bearing on a single source. Invariant 20 says a packet that
     * does not cover the goal's mandatory part is not synthesized.
     *
     * It was called from `orchestrator.ts` and nowhere else, so it held on the
     * in-process path and not on the worker path — the third time that exact
     * asymmetry has cost something, after the archive coverage check and the
     * dependency-cycle check. The rule is the packet's, not the loop's.
     *
     * The push path answers a failure by planning targeted fragments and
     * re-running. This one stops instead, because on this path spending the
     * allowance is a decision a person makes: §16 is equally explicit that
     * research started from a browser is planned in full and approved before
     * anything is spent, and fragments this created would be researched with
     * nobody having agreed to them. So the gaps are named and a person decides.
     */
    const coverage = await assessPacket({
      orchestrationId: orchestration.id,
      projectId: orchestration.projectId,
    });
    const failed = coverage.checks.filter((check) => !check.passed);
    const mandatoryGap = failed.find((check) => check.check === MANDATORY_COVERAGE_CHECK);
    if (mandatoryGap) {
      await updateOrchestration(orchestration.id, {
        status: 'NEEDS_HUMAN',
        failureReason:
          'The packet does not cover the goal\'s mandatory part, so it was not synthesized. ' +
          `${mandatoryGap.detail}` +
          (failed.length > 1
            ? ` Also unresolved: ${failed
                .filter((check) => check !== mandatoryGap)
                .map((check) => check.check)
                .join(', ')}.`
            : ''),
        completedAt: new Date().toISOString(),
      });
      await recordEvent({
        projectId: orchestration.projectId,
        layerId: orchestration.layerId,
        entityType: 'RUN',
        entityId: orchestration.runId,
        eventType: 'RESEARCH_COVERAGE_GAP',
        payload: {
          orchestrationId: orchestration.id,
          summary: coverage.summary,
          targetedRequirementIds: coverage.targetedRequirementIds,
          failedChecks: failed.map((check) => check.check),
        },
      });
      return {
        orchestrationId,
        status: 'NEEDS_HUMAN',
        enqueued: [],
        waitingOn: 'a person: the packet does not cover the goal\'s mandatory part',
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
    const auditItem = (item: WorkItem): boolean =>
      item.workType === 'RESEARCH_AUDIT' && item.payload['role'] === role;
    if (stillRunning(items, auditItem)) {
      return {
        orchestrationId,
        status: orchestration.status,
        enqueued: [],
        waitingOn: `the ${role} audit pass`,
      };
    }
    if (alreadyCreated(items, auditItem)) {
      return await faultedOut({ orchestration, what: `${role.toLowerCase()} audit` });
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

  // A fixture supplies its own claims, so approving one runs it here rather
  // than queueing work for a worker that would have nothing to research. The
  // *approval* is identical — same screen, same decision, same event row — and
  // that is the half worth rehearsing.
  if (orchestration.fixture) {
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
    const { runFixturePacket } = await import('./fixtures.ts');
    const report = await runFixturePacket(orchestration.id);
    return {
      orchestrationId: orchestration.id,
      status: 'NEEDS_HUMAN',
      enqueued: [],
      waitingOn: report.stoppedBecause,
      ran: {
        acceptedFragments: report.acceptedFragments,
        blockedFragments: report.blockedFragments,
        acceptedClaims: report.acceptedClaims,
        rejectedClaims: report.rejectedClaims,
        canonicalName: report.canonicalName,
      },
    };
  }

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
  let advanced = 0;
  for (const orchestration of await listPendingOrchestrations()) {
    // Only packets that are actually worker-driven. A push-model orchestration
    // has no work items and enqueueing some would start it a second way.
    const items = await listWorkItems(orchestration.projectId, { limit: 500 });
    const isPulled = items.some((item) => item.orchestrationId === orchestration.id);
    if (!isPulled) continue;

    /**
     * Clear a failure the packet has already moved past.
     *
     * `failure_reason` is only ever written, never cleared, so a reason
     * survives whatever comes next and the screen keeps reporting a resolved
     * problem as a current one. That happened for real: a boot marked a
     * worker-driven packet interrupted before its plan existed, the worker
     * then filed twelve fragments and set the status back to PLANNING, and the
     * console went on saying "interrupted while planning, results were lost"
     * over a plan that was sitting there intact.
     *
     * A live status and a failure reason cannot both be true. The status is
     * the one derived from rows, so it wins.
     */
    if (orchestration.failureReason) {
      await updateOrchestration(orchestration.id, { failureReason: null });
    }

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
