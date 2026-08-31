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
import { dependencyKeys } from '../../domain/dependencies.ts';
import { repairable, TERMINAL_ORCHESTRATION } from './outcome.ts';
import { bundleKeyFor } from './bundling.ts';
import type {
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  WorkItem,
  WorkerScope,
} from '../../domain/types.ts';
import type { ClaimJudgement, GateCondition, GateResult, LaneCoverage } from './gate.ts';
import { countIndependentSources, duplicateGroups } from './standards.ts';
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
import { listCoverage, overrideCoverage, upsertCoverage } from '../../repos/reconciliation.ts';
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
/**
 * One fragment's work faulted. Block that fragment and carry on.
 *
 * This used to stop the packet. `faultedOut` set the orchestration to
 * NEEDS_HUMAN and returned, which aborted the rest of the advance — and since
 * `advancePacket` short-circuits on NEEDS_HUMAN, every later call did nothing
 * at all. So one fragment whose verification died took the whole packet with
 * it, permanently.
 *
 * On the live packet that was Texas. Four other fragments were sitting
 * VALIDATING with real research on them — California, Florida, New York,
 * Illinois — and not one could be handed a verification job, because the loop
 * that mints them returned at Texas before reaching any of them. Two worker
 * sessions in a row reported the same thing: the queue never offers a
 * verification, only work that has already been done.
 *
 * A fault is about a fragment. The packet's own end state is decided where it
 * always was — when everything has finished, or when nothing left can move.
 */
async function faultedFragment(input: {
  orchestration: ResearchOrchestration;
  fragment: ResearchFragment;
  what: string;
}): Promise<void> {
  const reason =
    `A ${input.what} work item for this fragment finished without recording anything. ` +
    'Its research is kept; reissue the verification or give the fragment another attempt.';
  await updateFragment(input.fragment.id, {
    status: 'BLOCKED',
    blockedReason: reason,
    completedAt: new Date().toISOString(),
  });
  await recordEvent({
    projectId: input.orchestration.projectId,
    layerId: input.orchestration.layerId,
    entityType: 'RUN',
    entityId: input.orchestration.runId,
    eventType: 'RESEARCH_FRAGMENT_REJECTED',
    payload: {
      orchestrationId: input.orchestration.id,
      fragmentId: input.fragment.id,
      fragmentKey: input.fragment.fragmentKey,
      what: input.what,
      reason,
    },
  });
}

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
  bundleKey?: string | null;
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
    // Named on the item so a worker can claim the set a bundle describes,
    // without the bundle ever becoming one item and one idempotency scope.
    bundleKey: input.bundleKey ?? null,
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
      // Only a HARD dependency dooms. A conditional dependent can be
      // researched and stated as a conditional, and a sequencing one was never
      // waiting on an answer at all — writing either of them off because a
      // neighbour failed is what cost the first live packet five fragments
      // nobody ever attempted.
      const blockers = fragment.dependsOn
        .filter((declared) => declared.kind === 'HARD')
        .map((declared) => declared.key)
        .filter((key) => {
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
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));
  return fragments.filter((fragment) => {
    if (fragment.status !== 'QUEUED') return false;
    // A dependency that ended BLOCKED never becomes accepted, so a fragment
    // waiting on it waits forever. That is deliberate rather than an oversight:
    // the honest outcome is that the packet is short a foundation, and the
    // packet assessment says so. Silently starting it would produce an answer
    // resting on a definition nobody established.
    return fragment.dependsOn.every((declared) => {
      if (declared.kind === 'SEQUENCING') return true;
      if (declared.kind === 'HARD') return accepted.has(declared.key);
      // CONDITIONAL: the dependency has to have *finished*, so the dependent
      // knows what it is conditioning on. It does not have to have succeeded.
      const dependency = byKey.get(declared.key);
      return dependency ? TERMINAL_FRAGMENT.has(dependency.status) : true;
    });
  });
}

/**
 * Which of a fragment's dependencies it is never going to get.
 *
 * A dependency is unmet when the fragment carrying that key has finished
 * without being accepted, or when no fragment carries the key at all. Both mean
 * the same thing to whatever is waiting: the foundation it was promised is not
 * coming, and no further attempt at *this* fragment changes that.
 *
 * One direct level only. Transitive doom is `doomedBy`'s job; this answers the
 * narrower question of what to name in a reason a person reads.
 */
function unmetDependencies(
  fragment: ResearchFragment,
  byKey: Map<string, ResearchFragment>,
): { key: string; became: string }[] {
  const unmet: { key: string; became: string }[] = [];
  for (const declared of fragment.dependsOn) {
    // Sequencing is a preference about order. It never blocks and it never
    // dooms, so it is never unmet.
    if (declared.kind === 'SEQUENCING') continue;
    const dependency = byKey.get(declared.key);
    if (!dependency) {
      unmet.push({ key: declared.key, became: 'no fragment carries that key' });
      continue;
    }
    if (TERMINAL_FRAGMENT.has(dependency.status) && dependency.status !== 'ACCEPTED') {
      unmet.push({ key: declared.key, became: dependency.status });
    }
  }
  return unmet;
}

/**
 * Fragments that can never start become terminal, naming exactly why.
 *
 * `doomedBy` deliberately mutates nothing, and said so: repairing a dependency
 * un-dooms its dependents, and a status written the moment doom appears would
 * have to be unwritten. That reasoning is right while anything else in the
 * packet can still move. It stops being right at the point nothing can — and
 * the packet was then left holding QUEUED fragments that no advance would ever
 * offer to a worker, forever, with the only account of it an aggregate sentence
 * on the orchestration.
 *
 * That is the state the live packet reached: two penalty fragments waiting on a
 * trigger fragment whose verification faulted. Every advance recomputed the
 * same doom, reported the same count, and moved nothing.
 *
 * So when every unfinished fragment is doomed, each one is resolved to BLOCKED
 * with its own reason. **BLOCKED rather than CANCELLED on purpose**:
 * `retryFragment` only accepts a BLOCKED fragment, so this is the status that
 * keeps the documented remedy — repair the dependency, then retry what was
 * waiting on it — actually available. A cancelled fragment is one nobody may
 * pick back up.
 */
async function blockOnFailedDependency(input: {
  orchestration: ResearchOrchestration;
  stranded: ResearchFragment[];
  fragments: ResearchFragment[];
}): Promise<void> {
  const { orchestration, stranded, fragments } = input;
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));
  const at = new Date().toISOString();

  for (const fragment of stranded) {
    const unmet = unmetDependencies(fragment, byKey);
    // Transitively doomed: its own dependencies are still live-looking, but
    // something further up is not coming. Name the whole chain rather than
    // nothing.
    const detail =
      unmet.length > 0
        ? unmet.map((entry) => `${entry.key} (${entry.became})`).join(', ')
        : dependencyKeys(fragment.dependsOn).join(', ');
    const reason =
      `Not researched: it depends on ${detail}, and that never arrives. ` +
      'Answering it would rest on a foundation nobody established. Repair the dependency ' +
      'and this fragment can be retried.';
    await updateFragment(fragment.id, {
      status: 'BLOCKED',
      blockedReason: reason,
      completedAt: at,
    });
    await recordEvent({
      projectId: orchestration.projectId,
      layerId: orchestration.layerId,
      entityType: 'RUN',
      entityId: orchestration.runId,
      eventType: 'RESEARCH_FRAGMENT_REJECTED',
      payload: {
        orchestrationId: orchestration.id,
        fragmentId: fragment.id,
        fragmentKey: fragment.fragmentKey,
        what: 'dependency',
        reason,
      },
    });
  }
}

/**
 * Record what this packet is not going to answer, and let it finish around it.
 *
 * Runs early on every advance where nothing is live and nothing is awaiting
 * approval, and only on a packet a person has authorized for `RECORD_GAPS`.
 * Returns how many requirements it closed, so the caller can re-derive rather
 * than guess what changed.
 *
 * **The condition is one thing: the fragment is BLOCKED and this path cannot
 * make it researchable again.** On the pull path that is every BLOCKED
 * fragment, and the reason is structural rather than incidental. §15 requires a
 * repair to search differently from every attempt before it; `repair.ts` is
 * what chooses that strategy from a named ladder filtered against earlier
 * attempts; and it is wired only to the in-process path. So the runner cannot
 * mint a second attempt at any attempt count — one that it did mint would
 * re-run a lane the last attempt already exhausted, which is the one thing
 * Option A forbids outright.
 *
 * **An earlier version of this drew the line at the repair budget, and that was
 * wrong.** It wrote off a fragment at `attempt >= maxRepairs` and left one at
 * attempt 1 alone, "because a fragment that has failed once still has a real
 * repair available". The repair it means is `retryFragment` — an *operator*
 * pressing a control, not something the runner can do — so the sentence was
 * true about a person and false about this code. The live packet made the
 * difference visible: `extraterritorial-nexus` sat BLOCKED at attempt 1 of 2
 * with no dependencies and nothing behind it, holding the last open mandatory
 * requirement, with an empty queue that no worker session could ever refill.
 * Waiting for a worker meant waiting forever.
 *
 * The reason is still recorded per fragment, because "its research ran out",
 * "its prerequisite never arrived" and "its evidence failed the gate" are
 * different facts about the packet even when they have the same consequence.
 * And a prerequisite that stranded a dependent is written off with it: a packet
 * cannot declare the penalty question out of scope while holding the trigger
 * question open, when the only reason the penalty is unanswerable is that the
 * trigger is. They are one unresolved area and are declared together.
 *
 * What keeps this narrow is not the attempt count. It is the caller's guard —
 * nothing live, nothing awaiting approval, nothing startable — and, before all
 * of it, a person having authorized this packet to record gaps at all. Remove
 * the authorization and the packet stops at NEEDS_HUMAN and stays there, which
 * is what invariant 20 is for.
 */
async function recordUnresolvedGaps(input: {
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
}): Promise<number> {
  const { orchestration, fragments } = input;
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));

  const writtenOff = new Map<string, ResearchFragment>();
  const because = new Map<string, string>();
  for (const fragment of fragments) {
    if (fragment.status !== 'BLOCKED') continue;
    const unmet = unmetDependencies(fragment, byKey);
    writtenOff.set(fragment.id, fragment);
    because.set(
      fragment.id,
      unmet.length > 0
        ? 'DEPENDENCY_UNMET'
        : fragment.attempt >= fragment.maxRepairs
          ? 'REPAIRS_EXHAUSTED'
          : 'NO_PLANNABLE_REPAIR',
    );
    // The prerequisite goes with its dependent, whatever state it ended in.
    for (const entry of unmet) {
      const dependency = byKey.get(entry.key);
      if (!dependency || writtenOff.has(dependency.id)) continue;
      writtenOff.set(dependency.id, dependency);
      because.set(dependency.id, 'STRANDED_A_DEPENDENT');
    }
  }
  if (writtenOff.size === 0) return 0;
  const unresolved = [...writtenOff.values()];

  const coverage = await listCoverage(orchestration.id);
  const byRequirement = new Map(coverage.map((entry) => [entry.requirementId, entry]));
  let closed = 0;

  const close = async (fragment: ResearchFragment, why: string): Promise<void> => {
    for (const requirementId of fragment.requirementIds) {
      const entry = byRequirement.get(requirementId);
      if (entry?.status === 'NOT_REQUIRED') continue;
      // A requirement with no coverage row at all has to be closable too.
      // Skipping it left the requirement permanently open — the planning pass
      // does write a row per proposed fragment, so this is rare, but "rare"
      // and "cannot happen" are different and the difference is a packet that
      // can never finish.
      const target =
        entry ??
        (await upsertCoverage({
          orchestrationId: orchestration.id,
          requirementId,
          status: 'NOT_REQUIRED',
          reasons: [why],
          claimIds: [],
          documentIds: [],
          confidence: 0,
          needsResearch: false,
        }));
      await overrideCoverage(target.id, {
        status: 'NOT_REQUIRED',
        note: why,
        needsResearch: false,
      });
      byRequirement.set(requirementId, { ...target, status: 'NOT_REQUIRED' });
      closed += 1;
    }
  };

  for (const fragment of unresolved) {
    const reason = fragment.blockedReason ?? 'no evidence path remained';
    const lead =
      because.get(fragment.id) === 'REPAIRS_EXHAUSTED'
        ? `Research exhausted after ${fragment.attempt} attempt(s)`
        : because.get(fragment.id) === 'DEPENDENCY_UNMET'
          ? 'Never researchable: a prerequisite of it ended without being accepted'
          : because.get(fragment.id) === 'STRANDED_A_DEPENDENT'
            ? 'Unresolved, and other fragments were waiting on it'
            : `Unresolved after ${fragment.attempt} attempt(s), with no further attempt this ` +
              'packet can plan';
    await close(
      fragment,
      `${lead}: ${reason} Recorded as an unresolved gap rather than answered, and the packet ` +
        'is filed without it.',
    );
  }

  // Nothing was narrowed, so nothing happened. Returning before the event
  // matters: `advancePacket` runs on every completion and every boot, and the
  // written-off fragments stay written off, so an event recorded on the way
  // past would be appended again on every pass until the packet went terminal.
  // `project_events` is append-only — a duplicate there is permanent.
  if (closed === 0) return 0;

  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_COVERAGE_GAP',
    payload: {
      orchestrationId: orchestration.id,
      resolution: 'UNRESOLVED_GAP_RECORDED',
      // Named per fragment with why it is unresolved, because "the packet was
      // filed without four of its states" is a different fact from "one
      // fragment ran out of retries" and the event is the only durable record
      // of which one happened.
      unresolvedFragments: unresolved.map((fragment) => ({
        fragmentKey: fragment.fragmentKey,
        status: fragment.status,
        attempt: fragment.attempt,
        maxRepairs: fragment.maxRepairs,
        because: because.get(fragment.id) ?? 'NO_PLANNABLE_REPAIR',
      })),
      requirementsClosed: closed,
    },
  });
  return closed;
}

/**
 * Give a failed fragment the next attempt §15 says it is owed.
 *
 * The plan comes from `repair.ts`, which is the part that makes a second
 * attempt worth making: strategies come from a named ladder chosen from what
 * actually failed, and every one already used by an earlier attempt is filtered
 * out. A retry without that is the same search twice, which §15 forbids and
 * which is why this path had none.
 *
 * `retryFragment` creates the new attempt, carrying every declaration forward
 * so the repair is judged by the standard the last attempt failed — a repair
 * that relaxes the bar answers an easier question. It is idempotent on
 * (fragment, attempt), so two advances a millisecond apart produce one attempt.
 *
 * Returns how many it created, so the caller re-derives rather than guessing.
 */
async function mintRepairs(input: {
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
  items: WorkItem[];
}): Promise<number> {
  const { orchestration, fragments } = input;
  const candidates = repairable(fragments);
  if (candidates.length === 0) return 0;

  const { buildRepairPlan, describeRepairPlan } = await import('./repair.ts');
  const { retryFragment, FragmentNotRetryable } = await import('./reissue.ts');
  const { listFragments } = await import('../../repos/research.ts');

  let created = 0;
  for (const fragment of candidates) {
    // Doomed by a HARD dependency that never arrived? Repairing this one
    // changes nothing; the dependency is what needs the attempt.
    if (doomedBy(fragments).has(fragment.fragmentKey)) continue;

    const history = (await listFragments(orchestration.id)).filter(
      (entry) => entry.fragmentKey === fragment.fragmentKey,
    );
    const claims = await listClaimsForFragment(fragment.id);
    const plan = buildRepairPlan({
      fragment,
      gate: gateShapeFor(fragment, claims),
      history,
      claims,
      // Splitting is decided on the in-process path by `shouldSplit`, which
      // reads the failed attempt's own passes. This path has the claims but not
      // that analysis, so it does not claim to know: a repair that should have
      // been a split is still a repair, and the next attempt's failure will say
      // so more clearly than a guess here would.
      splitRequired: false,
      remainingBudget: Math.max(0, fragment.maxRepairs - fragment.attempt + 1),
    });
    /**
     * The ladder is exhausted, so there is no repair to make.
     *
     * `buildRepairPlan` says so by planning `MARK_UNRESOLVED` — when every
     * strategy this failure suggests has already been tried, or when the budget
     * is down to its last attempt. That is an instruction to stop, and creating
     * an attempt carrying it would be a fragment whose assignment is "do not
     * attempt this". It is left for the gap pass below, which is where an
     * honestly unresolved fragment belongs.
     *
     * Note this stops one attempt earlier than `retryFragment` would refuse.
     * The planner is the stricter of the two and it is the one that knows what
     * has been searched, so it decides.
     */
    if (plan.strategies.every((strategy) => strategy === 'MARK_UNRESOLVED')) continue;

    try {
      const outcome = await retryFragment({
        fragmentId: fragment.id,
        reason: describeRepairPlan(plan),
        actor: { type: 'SYSTEM', id: 'packet-runner' },
        // Never from inside the runner: see the option's own note. The caller
        // re-derives as soon as this loop finishes.
        advance: false,
      });
      if (outcome.status === 'RETRIED') created += 1;
    } catch (error) {
      // Not retryable is an ordinary answer here — the budget ran out between
      // the check and the call, or a later attempt already exists.
      if (!(error instanceof FragmentNotRetryable)) throw error;
    }
  }

  /**
   * No status is written here, deliberately.
   *
   * A minted repair is a QUEUED fragment, and the re-derive that follows will
   * enqueue research for it and set `RESEARCHING` — which is the truth, because
   * the packet has claimable work. Writing `AWAITING_REPAIR` from inside this
   * function overwrote that with a state meaning "waiting for something that is
   * not queued yet", on a packet whose queue was about to be full.
   *
   * `AWAITING_REPAIR` belongs to `outcomeFor`, on the judge path: the moment
   * between a MORE_RESEARCH verdict and the runner minting the attempt. This
   * function is what ends that moment, not what begins it.
   */
  return created;
}

/**
 * The gate result this fragment already received, rebuilt from its own rows.
 *
 * `buildRepairPlan` needs the whole `GateResult` — which conditions failed,
 * which lanes are empty, how many independent sources the accepted evidence
 * actually rests on — and none of that is stored as a blob. What is stored is
 * every decision it was made of: each claim carries its own `accepted`,
 * `rejectionReason` and `validationState`, and the fragment carries the two
 * verdicts and the reason it was blocked.
 *
 * So this reads the recorded decisions rather than re-judging the evidence.
 * That distinction is §12's: acceptance is decided once, at the gate. Calling
 * `applyGate` again here would be a second judgement — over claims whose
 * verification verdicts are not all persisted, so it could quietly reach a
 * different answer than the one the fragment was actually failed for, and plan
 * a repair for a failure that never happened.
 *
 * Counting is delegated to `standards.ts`, the same module the gate itself
 * used, so "how many independent sources" means one thing in both places.
 */
function gateShapeFor(fragment: ResearchFragment, claims: ResearchClaim[]): GateResult {
  const results: ClaimJudgement[] = claims.map((claim) => ({
    claimId: claim.id,
    accepted: claim.accepted,
    failedCondition: claim.accepted ? null : conditionFor(claim),
    reason: claim.accepted ? null : (claim.rejectionReason ?? claim.validationDetail),
  }));
  const accepted = claims.filter((claim) => claim.accepted);

  const coverage: LaneCoverage[] = fragment.requiredEvidence.map((lane) => {
    const inLane = accepted.filter((claim) => claim.evidenceLane === lane.id);
    return {
      lane: lane.id,
      description: lane.description,
      necessity: lane.necessity,
      acceptedClaims: inLane.length,
      independentSources: countIndependentSources(inLane),
      meetsThreshold: inLane.length > 0,
    };
  });

  const independentSources = countIndependentSources(accepted);
  const failedConditions = new Set<GateCondition>();
  // Per-claim: the condition each rejected claim actually failed.
  for (const result of results) {
    if (result.failedCondition) failedConditions.add(result.failedCondition);
  }
  // Fragment-wide: an empty lane or too few publishers is a coverage failure
  // whatever the individual claims did, and it is the one that decides the
  // ladder most often.
  // Only a REQUIRED lane failing is a coverage failure — the same rule the gate
  // itself applies, and it has to be the same here or a repair would be planned
  // for a lane that never blocked anything.
  if (coverage.some((lane) => !lane.meetsThreshold && lane.necessity === 'REQUIRED')) {
    failedConditions.add('COVERAGE');
  }
  if (independentSources < fragment.minIndependentSources) failedConditions.add('COVERAGE');

  const reason = fragment.blockedReason ?? fragment.missingEvidence ?? '';
  return {
    integrity: fragment.integrityVerdict === 'PASS' ? 'PASS' : 'FAIL',
    sufficiency: fragment.sufficiencyVerdict === 'SUFFICIENT' ? 'SUFFICIENT' : 'INSUFFICIENT',
    // A claim whose source could not be read is not a rejected claim (§4 of the
    // correction batch), so it is reported here rather than counted as failure.
    unresolvedRetrieval: claims
      .filter((claim) => claim.retrievalState !== 'RETRIEVED')
      .map((claim) => ({
        claimId: claim.id,
        claim: claim.claim,
        sourceUrl: claim.sourceUrl,
        state: claim.retrievalState,
      })),
    claims: results,
    acceptedClaims: accepted.length,
    rejectedClaims: results.filter((result) => !result.accepted).length,
    independentSources,
    coverage,
    duplicateSourceGroups: duplicateGroups(accepted),
    failedConditions: [...failedConditions],
    reasons: reason ? [reason] : [],
    unresolvedGaps: fragment.missingEvidence ? [fragment.missingEvidence] : [],
  };
}

/**
 * Which gate condition a rejected claim failed, from what its row records.
 *
 * The condition itself is not a column — only the sentence the gate wrote when
 * it rejected the claim. Those sentences come from `gate.ts` and are stable, so
 * matching them recovers the condition for the common cases; anything
 * unrecognised falls through to `SOURCE_SUPPORTS`, which is the broadest ladder
 * and therefore the safe default: it proposes more places to look rather than
 * fewer.
 */
function conditionFor(claim: ResearchClaim): GateCondition {
  if (claim.validationState === 'NO_EVIDENCE') return 'LOCATOR';
  if (!claim.sourced) return 'SOURCE_URL';
  if (claim.derived) return 'DERIVATIONS';
  if (claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED') {
    return 'CONTRADICTIONS';
  }
  const reason = (claim.rejectionReason ?? '').toLowerCase();
  for (const [condition, needle] of GATE_CONDITION_HINTS) {
    if (reason.includes(needle)) return condition;
  }
  return 'SOURCE_SUPPORTS';
}

/** Recovering which gate condition failed from the sentence it recorded. */
const GATE_CONDITION_HINTS: [GateCondition, string][] = [
  ['SOURCE_URL', 'no usable source'],
  ['SOURCE_SUPPORTS', 'directly support'],
  ['SOURCE_SUPPORTS', 'nothing confirms'],
  ['LOCATOR', 'passage'],
  ['SCOPE_MATCH', 'scope'],
  ['SCOPE_MATCH', 'geography'],
  ['SCOPE_MATCH', 'timeframe'],
  ['CONTRADICTIONS', 'contradiction'],
  ['COVERAGE', 'lane'],
  ['DERIVATIONS', 'calculation'],
];

/**
 * Decide what work should exist for this packet, and make it so.
 *
 * Idempotent by construction: every branch checks the queue for live work of
 * the kind it is about to create before creating any.
 */
/**
 * Every advance, with the one thing that must be true when it returns.
 *
 * **A non-terminal packet may never sit with an empty queue and no reason.**
 * That state is invisible: nothing is claimable, so no worker touches it;
 * nothing is terminal, so no report says it is finished; and the runner is only
 * called when something completes, which nothing will. The first live packet
 * spent a day in it.
 *
 * `AWAITING_REPAIR` with only a sentence is the same failure wearing a better
 * word, so it is held to the stronger test: either there is claimable or leased
 * repair work, or a fragment carries a `next_retry_at` saying when it returns.
 * With neither, the packet is not awaiting anything and belongs to a person.
 *
 * Checked here rather than at each of the dozen returns, because a rule
 * enforced at some exits is a rule with a hole at the others.
 */
export async function advancePacket(orchestrationId: string): Promise<AdvanceResult> {
  const result = await advanceOnce(orchestrationId);
  if (TERMINAL_ORCHESTRATION.has(result.status)) return result;

  const items = await listWorkItems(
    (await getOrchestration(orchestrationId))?.projectId ?? '',
    { limit: 500 },
  );
  const live = items.filter(
    (item) => item.orchestrationId === orchestrationId && LIVE_ITEM.has(item.state),
  );
  if (live.length > 0) return result;

  if (result.status === 'AWAITING_REPAIR') {
    const waiting = (await currentFragments(orchestrationId)).some(
      (fragment) => fragment.nextRetryAt !== null,
    );
    if (waiting) return result;
    await updateOrchestration(orchestrationId, {
      status: 'NEEDS_HUMAN',
      failureReason:
        'The packet was left awaiting a repair that has no claimable work and no scheduled ' +
        'time to return. Nothing would ever pick it up, so it is a decision rather than a wait.',
      completedAt: new Date().toISOString(),
    });
    return { ...result, status: 'NEEDS_HUMAN', waitingOn: 'a person: no repair is actually pending' };
  }

  if (result.status === 'NEEDS_HUMAN') return result;

  /**
   * A packet waiting for a person to approve its plan has an empty queue on
   * purpose, and that is the §16 gate rather than a stall.
   *
   * This guard exists to catch a packet nothing will ever pick up. A packet
   * held at approval is picked up the moment somebody approves it, the console
   * shows it as awaiting approval, and the runner is called again by the
   * approval itself. Downgrading it to NEEDS_HUMAN would be true in the
   * uselessly literal sense — a human is indeed needed — while destroying the
   * distinction between "waiting for the approval it was designed to wait for"
   * and "stuck in a state no one can resolve".
   *
   * Read from the rows rather than from `waitingOn`, which is prose.
   */
  const unapproved = (await currentFragments(orchestrationId)).filter(
    (fragment) => fragment.status === 'PLANNED',
  );
  if (unapproved.length > 0) return result;

  /**
   * Any other non-terminal status with an empty queue is the bug this guard
   * exists for. It is reported rather than repaired: inventing work here would
   * hide whichever branch failed to mint or to conclude.
   */
  await updateOrchestration(orchestrationId, {
    status: 'NEEDS_HUMAN',
    failureReason:
      `The packet was left ${result.status} with nothing queued and nothing to do` +
      `${result.waitingOn ? ` (waiting on: ${result.waitingOn})` : ''}. That state cannot ` +
      'resolve itself, so it is a decision rather than a wait.',
    completedAt: new Date().toISOString(),
  });
  return { ...result, status: 'NEEDS_HUMAN', waitingOn: `a person: left ${result.status} with an empty queue` };
}

async function advanceOnce(orchestrationId: string): Promise<AdvanceResult> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) {
    return { orchestrationId, status: 'GONE', enqueued: [], waitingOn: 'no such orchestration' };
  }

  /**
   * Only a genuinely finished packet stops the runner.
   *
   * `NEEDS_HUMAN` used to be in this list, and that was an intentional rule
   * applied at the wrong granularity rather than a slip. Three of these four
   * mean the packet is over. `NEEDS_HUMAN` means a decision is *outstanding* —
   * the packet is not finished, and other approved fragments may be perfectly
   * runnable. When the rule was written a fault killed the packet anyway, so
   * the difference never showed.
   *
   * It became load-bearing the moment `faultedFragment` let one fragment fail
   * without taking the packet with it. From then on a packet could be
   * NEEDS_HUMAN *and* hold healthy, approved, never-attempted work — and this
   * early return refused to mint any of it. Combined with
   * `listPendingOrchestrations`, which excluded the same status, the state was
   * absorbing: nothing re-entered it but an operator pressing a recovery
   * control.
   *
   * So a blocked fragment no longer prevents unrelated approved research from
   * becoming claimable. Nothing about *what* may be minted changes: the
   * per-target `alreadyCreated` guard, `stillRunning`, the attempt budget and
   * the fencing generation are all untouched, so work is still created exactly
   * once per (type, target) for the life of the packet.
   */
  const finished = [...TERMINAL_ORCHESTRATION];
  if (finished.includes(orchestration.status)) {
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
  /**
   * Close out research that has genuinely run out, before deciding anything.
   *
   * Option A, and it belongs here rather than in the stall branch below. The
   * first version was called only from `if (unfinished.length > 0)` — the case
   * where fragments are still waiting on something — and that is exactly the
   * case a finished-but-gapped packet is *not* in. When every fragment is
   * already terminal the stall branch never runs, so the gaps were never
   * recorded, and the mandatory-coverage check then refused the synthesis
   * forever. The packet had no live work, no claimable work, and no way
   * forward, which is the shape the operator was looking at.
   *
   * So it runs once, early, on every advance where nothing is live — before
   * approval, before the per-fragment loops, before the packet check — and
   * everything downstream reads the coverage it wrote.
   *
   * **And only when a person has authorized it for this packet.** Narrowing a
   * goal is a decision about one packet, not something the runner does because
   * it is stuck. Left as a default it would mean a Brain that can always
   * declare its way to "complete", which is the exact failure invariant 20
   * exists to prevent — I shipped it that way once and it was wrong. A packet
   * with no policy set and an exhausted mandatory requirement stops at
   * NEEDS_HUMAN and stays there, which is the honest outcome.
   *
   * Idempotent: it skips any requirement already NOT_REQUIRED and returns the
   * number it closed, so a second call on the same state closes zero and the
   * re-derive below cannot loop. It creates no work items itself, so it cannot
   * duplicate a fragment, a synthesis or an audit — the existing per-target
   * `alreadyCreated` guards are what mint, and they are untouched.
   */
  /**
   * Repair what can still be repaired, before writing anything off.
   *
   * §15's ladder — search differently from every attempt before it — lives in
   * `repair.ts` and was wired only to the in-process path. On the worker path a
   * failed fragment therefore got *zero* planned attempts, not two: it was
   * blocked, then declared a gap. That is most of the difference between this
   * packet and the archive's best research run, which reformulated and tried
   * different source ecosystems until it either had the answer or could say
   * precisely why it did not.
   *
   * Bounded exactly as the in-process path is: `MAX_FRAGMENT_ATTEMPTS`, and
   * every strategy filtered against every earlier attempt, so no two attempts
   * can be the same search twice.
   */
  if (!items.some((item) => LIVE_ITEM.has(item.state))) {
    const repaired = await mintRepairs({ orchestration, fragments, items });
    if (repaired > 0) return await advancePacket(orchestrationId);
  }

  if (
    orchestration.unresolvedGapPolicy === 'RECORD_GAPS' &&
    !items.some((item) => LIVE_ITEM.has(item.state)) &&
    !fragments.some((fragment) => fragment.status === 'PLANNED') &&
    // And nothing that could still be started. This is the guard that keeps
    // the rule narrow now that the attempt count no longer does: research that
    // has not been attempted may yet answer the requirement a blocked fragment
    // failed on, so writing anything off while a fragment is startable would
    // narrow the goal ahead of the evidence.
    readyToResearch(fragments).length === 0
  ) {
    const closed = await recordUnresolvedGaps({ orchestration, fragments });
    if (closed > 0) return await advancePacket(orchestrationId);
  }

  const awaitingApproval = fragments.filter((fragment) => fragment.status === 'PLANNED');
  if (awaitingApproval.length > 0) {
    return {
      orchestrationId,
      status: orchestration.status,
      enqueued: [],
      waitingOn: `a person to approve ${awaitingApproval.length} proposed fragment(s)`,
    };
  }

  /**
   * A fault this pass records, which makes the array below it stale.
   *
   * `faultedFragment` blocks a fragment in the database while `fragments` is
   * the snapshot this pass started from, and everything after these loops reads
   * that snapshot: which fragments are unfinished, which are doomed by a
   * dependency that ended without acceptance, whether anything can still move.
   * A fragment blocked a few lines earlier still reads VALIDATING there, so its
   * dependents are not yet doomed and the pass concludes the packet is making
   * progress.
   *
   * It cost the live packet a full stop. The failing verification advanced the
   * packet, the fault blocked the trigger fragment, and the same call then
   * decided its two dependents were "still in progress" — so nothing resolved
   * them, and because the packet had no other work, nothing ever called the
   * runner again to notice. The correction is one re-derive: a pass that
   * changed a fragment's status finishes by reading the rows back.
   */
  let faulted = 0;

  // ---- Fragments whose claims are in: gate them. -------------------------
  for (const fragment of fragments.filter((f) => f.status === 'VALIDATING')) {
    const verifyItem = (item: WorkItem): boolean =>
      item.workType === 'RESEARCH_VERIFY' && item.fragmentId === fragment.id;
    if (stillRunning(items, verifyItem)) continue;
    if (alreadyCreated(items, verifyItem)) {
      // This fragment is stuck. The others are not, and the loop goes on.
      await faultedFragment({ orchestration, fragment, what: 'verification' });
      faulted += 1;
      continue;
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
      await faultedFragment({ orchestration, fragment, what: 'research' });
      faulted += 1;
      continue;
    }
    enqueued.push(
      await enqueueResearchItem({
        orchestration,
        type: 'RESEARCH_FRAGMENT',
        fragment,
        bundleKey: bundleKeyFor(fragment, fragments),
      }),
    );
  }

  if (enqueued.length > 0 && orchestration.status !== 'RESEARCHING') {
    // Work exists, so the packet is researching — including when it was
    // NEEDS_HUMAN a moment ago. The reason goes with the status: a packet that
    // is running must not still be showing why it stopped, and the decision
    // itself lives on the blocked fragments, which keep their BLOCKED status
    // and their reasons. If nothing else can move later, the checks below set
    // NEEDS_HUMAN again with a reason that is current.
    //
    // Written *before* the re-derive below rather than after it. One pass can
    // both fault a fragment and mint work for a healthy one, and if the status
    // were only written on the path that returns from here, the re-derive would
    // skip it: the next pass sees the new item as live, waits on it, and leaves
    // the packet reading NEEDS_HUMAN while its queue is not empty.
    await updateOrchestration(orchestration.id, {
      status: 'RESEARCHING',
      failureReason: null,
      completedAt: null,
    });
  }

  if (faulted > 0) {
    // Re-derive rather than reason on from the snapshot. Whatever this pass
    // already enqueued is in the queue, so the next pass sees it through
    // `alreadyCreated` and cannot mint a second — it is carried into the result
    // only so a caller is told about work this call created.
    const next = await advancePacket(orchestrationId);
    return { ...next, enqueued: [...enqueued, ...next.enqueued] };
  }

  if (enqueued.length > 0) {
    return { orchestrationId, status: 'RESEARCHING', enqueued, waitingOn: null };
  }

  // ---- Still working? Then wait — unless nothing left can move. ----------
  const unfinished = fragments.filter((fragment) => !TERMINAL_FRAGMENT.has(fragment.status));
  if (unfinished.length > 0) {
    const doomed = doomedBy(fragments);
    const stuck = unfinished.filter((fragment) => doomed.has(fragment.fragmentKey));

    if (stuck.length === unfinished.length) {
      /**
       * Nothing left can move, so waiting is no longer a state — it is a
       * result. This used to write the count onto the orchestration and leave
       * the fragments QUEUED, which meant every later advance recomputed the
       * same doom and moved nothing, and the fragments themselves carried no
       * account of why they were never offered to a worker.
       *
       * Resolving them is not a decision about scope, so it is not gated on the
       * gap authorization: a fragment that can never start is a fact whatever
       * the packet is allowed to declare afterwards. What the authorization
       * decides is the next thing — whether the requirements they leave open
       * are recorded as declared gaps, or whether the packet stops for a person
       * over them. That happens on the re-derive below, which is why this
       * recurses rather than returning: the pass that reads the fragments it
       * just wrote is the one that decides what the packet does about them.
       */
      await blockOnFailedDependency({ orchestration, stranded: stuck, fragments });
      return await advancePacket(orchestrationId);
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
     * A stale failure is cleared by the advance that supersedes it, not here.
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
     * the one derived from rows, so it wins — *unless the status is itself the
     * report of the failure.* This used to clear unconditionally, which was
     * safe only while NEEDS_HUMAN packets were excluded from
     * `listPendingOrchestrations`. Now that they are included — a pending
     * decision is not a finished packet — clearing on sight would erase the
     * question a person is being asked, on every boot.
     *
     * So: stale for a live status, current for NEEDS_HUMAN. `advancePacket`
     * clears it there, at the point it actually enqueues work, because that is
     * the moment the reason stops being true.
     */
    if (orchestration.failureReason && orchestration.status !== 'NEEDS_HUMAN') {
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
