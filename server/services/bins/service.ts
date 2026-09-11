/**
 * What a worker can actually do with a bin, and what Brain does about it.
 *
 * The MCP tools in `binTools.ts` are thin wrappers over this module, which is
 * where the rules live. Three of them are worth stating before the code,
 * because every function below is shaped by them:
 *
 * **1. The worker names nothing.** `checkIn` takes no bin, no project, no
 * packet and no preference. What comes back is whatever the compare-and-swap
 * gave it. There is no argument anywhere here through which a caller could
 * steer itself towards a particular row, which is what makes "no assignment
 * created from information supplied only by the worker" true by construction
 * rather than by review.
 *
 * **2. The bin comes from the lease, and so does everything else.** Once a
 * worker holds a bin, every subsequent call re-derives the bin from the lease
 * proof rather than from a parameter. So `brain_bin_next_item` cannot return an
 * item from another bin, and a unit result cannot be filed against a bin the
 * caller does not own — not because the tool checks, but because the tool never
 * had the opportunity to be told otherwise.
 *
 * **3. Completion is a question, not a statement.** `requestCompletion`
 * evaluates the bin's contract against durable rows and returns the verdict. A
 * worker saying it finished is an input to nothing.
 */
import type {
  Bin,
  BinManifest,
  ClaimedWork,
  Principal,
  WorkerScope,
  WorkItem,
} from '../../domain/types.ts';
import {
  assignNextBin,
  checkpointBin,
  confinementFor,
  countBinEvents,
  finishBin,
  creditRefusedAssignments,
  getBin,
  heartbeatBin,
  listBins,
  listBinUnitResults,
  proveBinOwnership,
  putBinUnitResult,
  recordBinEvent,
  recordBinRefusal,
  releaseBin,
  reopenNeedsHumanBin,
  terminateUnleasedBin,
  type BinProof,
  type ReopenOutcome,
} from '../../repos/bins.ts';
import { getOrchestration } from '../../repos/research.ts';
import { recordWorkerArrival } from '../../repos/fleet.ts';
import { auditAdmission, lineageForWorker } from '../research/auditAdmission.ts';
import {
  claimWork,
  getWorkItemRow,
  listWorkItemsForBin,
  type ClaimScope,
} from '../../repos/workQueue.ts';
import { evaluateContract, hashUnitValue, type ContractVerdict } from './contracts.ts';

/* ------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The projects this worker may take work from, rebuilt from live memberships.
 *
 * Read on every call rather than baked into anything, so revoking access takes
 * effect on the next request rather than at the next sign-in. A worker holding
 * the claim scope nowhere gets an empty list, and the caller turns that into
 * the same refusal as an unknown resource — never into "the queue is empty",
 * which would send whoever debugs it looking at the queue.
 */
export function claimableProjects(principal: Principal): ClaimScope[] {
  return principal.memberships
    .filter((membership) => membership.active)
    .filter((membership) => (membership.scopes as WorkerScope[]).includes('queue:claim'))
    .map((membership) => ({
      projectId: membership.projectId,
      scopes: membership.scopes as WorkerScope[],
    }));
}

/* ------------------------------------------------------------------------- */
/* Check in                                                                   */
/* ------------------------------------------------------------------------- */

export interface Assignment {
  binId: string;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  takeover: boolean;
  kind: string;
  title: string;
  objective: string;
  rationale: string | null;
  manifest: BinManifest;
  completionContract: string;
  contractVersion: number;
  priority: number;
  projectId: string;
  layerId: string | null;
  orchestrationId: string | null;
  attempt: number;
  maxAttempts: number;
  /** What the previous holder left, when there was one. */
  checkpoint: Record<string, unknown> | null;
  budgetUnits: number | null;
}

export type CheckInResult =
  | { assigned: true; assignment: Assignment }
  | { assigned: false; reason: 'NO_READY_BINS' };

/**
 * Give this worker one bin, or tell it there is nothing.
 *
 * "Nothing to do" is an ordinary answer and has to be a fast, cheap one: a
 * duplicate activation exists precisely so that the losing session finds out
 * immediately and exits. If this were slow, the at-least-once trigger would be
 * expensive rather than merely redundant.
 */
/**
 * May this worker be handed this bin at all?
 *
 * The same admission rule `nextItemInBin` and the MCP claim path already use,
 * asked one boundary earlier — at the moment the bin is *assigned*, which is
 * the moment its attempt is charged.
 *
 * Three deliberate narrownesses:
 *
 *   - **Only work that is claimable right now counts.** A bin whose items are
 *     all held by a live worker is not refused; that is somebody else's lease
 *     running, not this session being ineligible, and the takeover path exists
 *     for it.
 *   - **A drained bin is never refused.** No open work means the holder should
 *     be asking for completion, and a bin that could not be assigned could
 *     never be completed either.
 *   - **One admissible item is enough.** `auditAdmission` returns ok for every
 *     work type that is not a research audit, so this can only ever refuse a
 *     bin whose entire remaining work is audit roles this session may not take.
 *
 * It refuses, never decides *what* the worker gets: the item is still chosen by
 * `claimWork` under the same hook, so this cannot let anything through that the
 * later guard would refuse.
 */
export async function binAdmission(input: {
  workerId: string;
  principal: Principal;
}): Promise<(bin: Bin) => Promise<{ ok: boolean; reason?: string }>> {
  const lineage = await lineageForWorker({
    workerId: input.workerId,
    credentialId: input.principal.credentialId,
  });
  const admit = auditAdmission(lineage);
  return async (bin: Bin): Promise<{ ok: boolean; reason?: string }> => {
    /*
     * Can this surface do what the bin needs at all?
     *
     * `requiredCapabilities` was only ever read by the *router*, which decides
     * which Routine to fire. That is not the same question as which bin an
     * arriving worker may be handed: any authenticated worker that checks in is
     * offered the oldest ready bin in its scopes, so a surface fired for one bin
     * could be handed another it has no way of doing. For a research bin that
     * was harmless, because none required anything. A factory bin that needs to
     * push a branch is not harmless — the worker would take it, fail to push,
     * and charge the work an attempt against a condition that was never about
     * the work.
     *
     * Read from the Routine the authenticated worker resolves to, never from
     * anything the caller sent — and **unknown admits**, which is the opposite of
     * what the first version of this did and is the correction recorded rather
     * than quietly applied.
     *
     * It failed closed, and that made the gate unreachable on a first arrival.
     * An arriving session's Routine is knowable only from `worker_sessions`,
     * which is written by `creditDispatchArrival` *after* a bin is assigned — so
     * the very first session from a newly registered Routine has no lineage,
     * falls back to the static worker binding, and resolves to nothing whenever
     * one worker identity serves more than one Routine, which is the shape this
     * fleet is in. In production that refused every factory bin to the only
     * surface that could do it: Brain fired the right Routine, the session
     * arrived, and Brain answered NO_READY_BINS while its own bin sat READY.
     * Nothing could ever clear it, because clearing it required taking a bin.
     *
     * The failure direction follows from what the gate protects, and that is
     * worth stating because this codebase fails closed nearly everywhere: **fail
     * closed when the unknown could let something false be recorded; fail open
     * when the unknown could only waste a fire.** A capability grants no access —
     * the manifest says in its own first authorized action that the access comes
     * from where the worker runs — so the worst an admitted surface can do is
     * report BLOCKED honestly, which every stage already handles. The
     * independence gate below keeps failing closed, because a verdict from the
     * session that wrote the code is exactly something false being recorded.
     *
     * So it refuses only what it *knows* is wrong, and the honest limitation is
     * that in a fleet where several Routines share one worker identity it can
     * know that about no arrival. What still decides which surface Brain
     * *starts* is the router's own check on the same field; the remedy for the
     * rest is a distinct worker identity per Routine, which is granted where the
     * worker runs.
     */
    if (bin.requiredCapabilities.length > 0 && lineage.routineId) {
      const { getRoutine } = await import('../../repos/fleet.ts');
      const routine = await getRoutine(lineage.routineId);
      const has = new Set(routine?.capabilities ?? []);
      const missing = bin.requiredCapabilities.filter((tag) => !has.has(tag));
      if (routine && missing.length > 0) {
        return {
          ok: false,
          reason:
            `This surface does not carry ${missing.join(', ')}, which this bin needs. ` +
            'Declaring it is an operator decision about what the surface can actually reach.',
        };
      }
    }

    /*
     * A factory review is refused here, before the lease, for §23's reason.
     *
     * A session that implemented part of a campaign must not be handed the bin
     * that judges it. Checked at assignment rather than only when the verdict
     * arrives, because a refusal after the fact costs the bin an attempt and
     * hands the same bin straight back to the same session — the loop §23's
     * `bin_session_refusals` exists to stop. The verdict is checked again before
     * storage anyway: a lease can expire and be retaken, so eligible at claim
     * time is not eligible at submit time.
     */
    if (bin.kind === 'FACTORY_REVIEW' && bin.factoryCampaignId) {
      const { reviewLineage } = await import('../factory/remote.ts');
      /*
       * The *credential* this request authenticated with, never the `session_ref`
       * the caller sent. That field is telemetry and its own tool says so; an
       * independence decision taken on it would be a worker declaring itself
       * independent. §23, at the factory's boundary.
       */
      const lineage = await reviewLineage(bin.factoryCampaignId, {
        sessionId: input.principal.credentialId,
        workerId: input.workerId,
      });
      if (!lineage.ok) return { ok: false, reason: lineage.reason ?? 'not independent of the work' };
    }

    const now = new Date().toISOString();
    const items = await listWorkItemsForBin(confinementFor(bin));
    const claimable = items.filter(
      (item) =>
        item.state === 'QUEUED' ||
        (item.state === 'LEASED' && item.leaseExpiresAt !== null && item.leaseExpiresAt <= now),
    );
    if (claimable.length === 0) return { ok: true };

    const reasons: string[] = [];
    for (const item of claimable) {
      const row = await getWorkItemRow(item.id);
      if (!row) return { ok: true }; // Unreadable is not ineligible.
      const verdict = await admit(row);
      if (verdict.ok) return { ok: true };
      if (verdict.reason) reasons.push(`${item.workType}: ${verdict.reason}`);
    }
    return {
      ok: false,
      reason:
        reasons.length > 0
          ? reasons.join(' ')
          : 'No item this bin still has open is admissible for this session.',
    };
  };
}

export async function checkIn(input: {
  principal: Principal;
  workerId: string;
  sessionRef?: string | null;
  leaseMs?: number;
}): Promise<CheckInResult> {
  /*
   * The arrival is credited first, and unconditionally.
   *
   * A session that authenticated and asked for work has arrived. Whether Brain
   * had a bin for it is a completely separate fact, and conflating the two made
   * "arrived and found nothing" — the *expected* answer for the losing half of
   * a duplicate activation — indistinguishable from "never started". See
   * `recordWorkerArrival`.
   */
  await recordWorkerArrival(input.workerId);

  const scopes = claimableProjects(input.principal);
  if (scopes.length === 0) return { assigned: false, reason: 'NO_READY_BINS' };

  const assigned = await assignNextBin({
    workerId: input.workerId,
    credentialId: input.principal.credentialId,
    projectIds: scopes.map((scope) => scope.projectId),
    sessionRef: input.sessionRef ?? null,
    leaseMs: input.leaseMs,
    /*
     * Asked before the assignment charges an attempt. A bin whose only open
     * work this session may not take is skipped, costs the bin nothing, and
     * earns a recorded refusal plus a fire backoff — so the next arrival is a
     * fresh session rather than the same one a second later.
     */
    admit: await binAdmission({ workerId: input.workerId, principal: input.principal }),
  });
  if (!assigned) return { assigned: false, reason: 'NO_READY_BINS' };

  const { bin } = assigned;
  return {
    assigned: true,
    assignment: {
      binId: bin.id,
      leaseId: assigned.leaseId,
      leaseGeneration: assigned.leaseGeneration,
      leaseExpiresAt: assigned.leaseExpiresAt,
      takeover: assigned.takeover,
      kind: bin.kind,
      title: bin.title,
      objective: bin.objective,
      rationale: bin.rationale,
      manifest: bin.manifest,
      completionContract: bin.completionContract,
      contractVersion: bin.contractVersion,
      priority: bin.priority,
      projectId: bin.projectId,
      layerId: bin.layerId,
      orchestrationId: bin.orchestrationId,
      attempt: bin.attemptCount,
      maxAttempts: bin.maxAttempts,
      checkpoint: bin.checkpoint,
      budgetUnits: bin.budgetUnits,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Draining                                                                   */
/* ------------------------------------------------------------------------- */

export type NextItemResult =
  | { held: false }
  | { held: true; item: ClaimedWork }
  | { held: true; item: null; binHasOpenWork: boolean };

/**
 * The next unit of work inside the bin this worker holds.
 *
 * The bin is re-derived from the lease proof, so the filter passed to
 * `claimWork` is a server-held fact rather than a caller-supplied one. A worker
 * cannot reach another bin's queue through this call because it has no way to
 * say which bin it means.
 *
 * Returning `item: null` with `binHasOpenWork: false` is how a worker learns
 * the bin is drained and it should ask for completion. `binHasOpenWork: true`
 * with no item means something is claimable-but-not-yet — a dependency, a
 * backoff — and the worker should wait and ask again rather than concluding it
 * is finished.
 */
export async function nextItemInBin(input: {
  principal: Principal;
  workerId: string;
  proof: BinProof;
  leaseMs?: number;
}): Promise<NextItemResult> {
  const bin = await proveBinOwnership(input.proof);
  if (!bin) return { held: false };

  const scopes = claimableProjects(input.principal).filter(
    (scope) => scope.projectId === bin.projectId,
  );
  if (scopes.length === 0) return { held: true, item: null, binHasOpenWork: false };

  // Same admission rule as the MCP claim path. A worker draining a bin is
  // still a worker, and an audit item inside that bin is still an audit item —
  // a guard on one entrance only is not a guard.
  const claimed = await claimWork({
    admit: auditAdmission(
      await lineageForWorker({
        workerId: input.workerId,
        credentialId: input.principal.credentialId,
      }),
    ),
    workerId: input.workerId,
    credentialId: input.principal.credentialId,
    scopes,
    // The only filter, and it comes from the lease.
    bin: confinementFor(bin),
    limit: 1,
    leaseMs: input.leaseMs,
  });

  if (claimed.length > 0) {
    const first = claimed[0]!;
    await recordBinEvent({
      eventType: 'BIN_ITEM_CLAIMED',
      binId: bin.id,
      projectId: bin.projectId,
      orchestrationId: bin.orchestrationId,
      workItemId: first.workItemId,
      workerId: input.workerId,
      leaseId: input.proof.leaseId,
      leaseGeneration: input.proof.leaseGeneration,
      measures: { workType: first.workType },
      outcome: 'CLAIMED',
    });
    return { held: true, item: first };
  }

  const items = await listWorkItemsForBin(confinementFor(bin));
  const open = items.filter((item) => item.state === 'QUEUED' || item.state === 'LEASED');
  if (open.length > 0) await recordWithheld(bin, input, open);
  return { held: true, item: null, binHasOpenWork: open.length > 0 };
}

/**
 * Why a worker holding a bin with open work was handed nothing.
 *
 * This branch used to record nothing at all, and production is what showed
 * that mattered. `bin_75bea12e15534ba4b93f` had a `RESEARCH_AUDIT` item
 * `QUEUED` and `claimable now`, workers were dispatched at it and took it,
 * and every one of them was handed nothing and went away. From the outside
 * that is indistinguishable from a worker that never arrived, from a
 * dispatcher that never fired, and from an item nobody wants — three
 * different faults with three different remedies, and no way to tell which.
 *
 * The refusal a *caller* sees is deliberately uninformative, and stays so.
 * This is Brain's own ledger, which is where the reason belongs: §23 makes an
 * audit admission refusal indistinguishable from losing a race **to the
 * worker**, not to the operator reading rows afterwards.
 *
 * What it may say is bounded by what `auditEligibility` already guarantees
 * about its own `reasons` — they name the pair and the dimension and never a
 * value, because the session dimension is a credential identifier. Nothing
 * here adds to that: no credential, no payload, no item content.
 *
 * Never throws, and bounded to a handful of items: a diagnostic that could
 * fail a drain would be worse than the blindness it cures.
 */
async function recordWithheld(
  bin: Bin,
  input: { workerId: string; principal: Principal; proof: BinProof },
  open: WorkItem[],
): Promise<void> {
  try {
    const admit = auditAdmission(
      await lineageForWorker({
        workerId: input.workerId,
        credentialId: input.principal.credentialId,
      }),
    );
    const reasons: string[] = [];
    for (const item of open.slice(0, 5)) {
      const row = await getWorkItemRow(item.id);
      if (!row) continue;
      const verdict = await admit(row);
      if (!verdict.ok && verdict.reason) reasons.push(`${item.workType}: ${verdict.reason}`);
    }
    await recordBinEvent({
      eventType: 'BIN_ITEM_WITHHELD',
      binId: bin.id,
      projectId: bin.projectId,
      orchestrationId: bin.orchestrationId,
      workerId: input.workerId,
      leaseId: input.proof.leaseId,
      leaseGeneration: input.proof.leaseGeneration,
      measures: { openItems: open.length, refusedItems: reasons.length },
      outcome: reasons.length > 0 ? 'REFUSED_BY_ADMISSION' : 'NOT_CLAIMABLE',
      reason:
        reasons.length > 0
          ? reasons.join(' | ')
          : 'The bin has open work that this worker could not claim, and the admission rule did ' +
            'not refuse it — so the item was not claimable for another reason: not yet available, ' +
            'held by another lease, or out of scope.',
    });
  } catch {
    // Deliberately swallowed, for the reason recordBinEvent swallows its own.
  }
}

/* ------------------------------------------------------------------------- */
/* Unit results                                                               */
/* ------------------------------------------------------------------------- */

export type SubmitUnitResult =
  | { held: false }
  | {
      held: true;
      stored: boolean;
      alreadyStored: boolean;
      unknownUnit: boolean;
      /** True when this replaced a different value the same unit already held. */
      corrected: boolean;
    };

/**
 * Store one unit's answer against the bin this worker holds.
 *
 * Refuses a unit key the manifest never declared, rather than storing it. A
 * result for a unit nobody asked for cannot satisfy any contract, and silently
 * keeping it would let a worker appear productive while the declared units went
 * unanswered.
 */
export async function submitUnit(input: {
  workerId: string;
  proof: BinProof;
  unitKey: string;
  value: string;
  workItemId?: string | null;
}): Promise<SubmitUnitResult> {
  const bin = await proveBinOwnership(input.proof);
  if (!bin) return { held: false };

  const declared = (bin.manifest.units ?? []).some((unit) => unit.key === input.unitKey);
  if (!declared) {
    return { held: true, stored: false, alreadyStored: false, unknownUnit: true, corrected: false };
  }

  const outcome = await putBinUnitResult({
    binId: bin.id,
    unitKey: input.unitKey,
    workItemId: input.workItemId ?? null,
    value: input.value,
    contentHash: hashUnitValue(input.value),
    leaseId: input.proof.leaseId,
    leaseGeneration: input.proof.leaseGeneration,
    submittedBy: input.workerId,
  });

  await recordBinEvent({
    eventType: 'BIN_UNIT_SUBMITTED',
    binId: bin.id,
    projectId: bin.projectId,
    workItemId: input.workItemId ?? null,
    workerId: input.workerId,
    leaseId: input.proof.leaseId,
    leaseGeneration: input.proof.leaseGeneration,
    // The replaced hash goes into the append-only record. That is what keeps a
    // correction from being a silent overwrite: this table holds the current
    // value, the event history holds every value the unit ever had.
    measures: {
      unitKey: input.unitKey,
      bytes: input.value.length,
      ...(outcome.previousHash ? { replacedContentHash: outcome.previousHash } : {}),
    },
    outcome: outcome.corrected ? 'CORRECTED' : outcome.stored ? 'STORED' : 'DUPLICATE',
  });

  return {
    held: true,
    stored: outcome.stored,
    alreadyStored: !outcome.stored,
    unknownUnit: false,
    corrected: outcome.corrected,
  };
}

/* ------------------------------------------------------------------------- */
/* Completion                                                                 */
/* ------------------------------------------------------------------------- */

export interface CompletionOutcome {
  held: boolean;
  terminal: boolean;
  state: 'COMPLETE' | 'NEEDS_HUMAN' | null;
  verdict: ContractVerdict | null;
  /** Signals worth recording even when the verdict was satisfied. */
  signals: string[];
}

/**
 * Ask Brain whether the bin is finished.
 *
 * The worker is not consulted. `evaluateContract` reads durable records and
 * answers, and only a satisfied verdict reaches `finishBin`.
 *
 * The signals below are the cheap "is this worker telling the truth" checks. On
 * their own none of them is proof of anything, which is why none of them can
 * refuse a completion: they are recorded, and a pattern of them is what a human
 * would look at. Refusal is the contract's job and the contract's alone.
 */
export async function requestCompletion(input: {
  workerId: string;
  proof: BinProof;
}): Promise<CompletionOutcome> {
  const bin = await proveBinOwnership(input.proof);
  if (!bin) return { held: false, terminal: false, state: null, verdict: null, signals: [] };

  const verdict = await evaluateContract(bin);
  const signals = await completionSignals(bin);

  if (!verdict.satisfied) {
    const reason = verdict.reasons.join(' ');
    await recordBinRefusal(input.proof, reason);

    // A refusal a worker cannot act on is a stall, and the governing invariant
    // forbids one. When the contract says no further work can satisfy it, the
    // bin becomes a named human decision rather than a loop.
    if (verdict.disposition === 'HUMAN') {
      await finishBin(input.proof, {
        state: 'NEEDS_HUMAN',
        reason: `A person must decide: ${reason}`,
      });
      return { held: true, terminal: true, state: 'NEEDS_HUMAN', verdict, signals };
    }
    return { held: true, terminal: false, state: null, verdict, signals };
  }

  await recordBinEvent({
    eventType: 'BIN_COMPLETION_ACCEPTED',
    binId: bin.id,
    projectId: bin.projectId,
    orchestrationId: bin.orchestrationId,
    workerId: input.workerId,
    leaseId: input.proof.leaseId,
    leaseGeneration: input.proof.leaseGeneration,
    measures: { ...verdict.observed, signals },
    outcome: 'COMPLETE',
  });

  const outcome = await finishBin(input.proof, {
    state: 'COMPLETE',
    reason: `${bin.completionContract} v${bin.contractVersion} evaluated true.`,
  });
  if (outcome !== 'OK') {
    return { held: false, terminal: false, state: null, verdict, signals };
  }
  return { held: true, terminal: true, state: 'COMPLETE', verdict, signals };
}

/**
 * Cheap tells that a run may not have been real work.
 *
 * Recorded, never enforced. Each of these has an innocent explanation — a
 * genuinely tiny bin finishes fast and touches nothing — so treating any of
 * them as a refusal would fail honest work. What they are good for is being
 * counted: a fleet where this fires constantly is a fleet worth looking at.
 */
async function completionSignals(bin: Bin): Promise<string[]> {
  const signals: string[] = [];

  const claims = await countBinEvents(bin.id, 'BIN_ITEM_CLAIMED');
  const submissions = await countBinEvents(bin.id, 'BIN_UNIT_SUBMITTED');
  if (claims === 0 && submissions === 0) {
    signals.push('NO_RECORDED_WORK');
  }

  if (bin.leasedAt) {
    const heldMs = Date.now() - new Date(bin.leasedAt).getTime();
    if (heldMs < 5_000 && (bin.manifest.units ?? []).length > 1) {
      signals.push('SUSPICIOUSLY_FAST');
    }
  }

  const results = await listBinUnitResults(bin.id);
  if (results.length > 1) {
    const distinct = new Set(results.map((row) => row.contentHash)).size;
    if (distinct === 1) signals.push('IDENTICAL_SUBMISSIONS');
    if (results.some((row) => row.value.trim().length === 0)) signals.push('EMPTY_SUBMISSION');
  }

  if (signals.length > 0) {
    await recordBinEvent({
      eventType: 'BIN_QUALITY_SIGNAL',
      binId: bin.id,
      projectId: bin.projectId,
      outcome: signals.join(','),
      measures: { claims, submissions, results: results.length },
    });
  }
  return signals;
}

/* ------------------------------------------------------------------------- */
/* Heartbeat, checkpoint, release                                             */
/* ------------------------------------------------------------------------- */

export async function heartbeat(proof: BinProof, leaseMs?: number) {
  return await heartbeatBin(proof, leaseMs);
}

export async function checkpoint(proof: BinProof, note: Record<string, unknown>) {
  return await checkpointBin(proof, note);
}

export async function release(proof: BinProof, reason?: string | null) {
  return await releaseBin(proof, reason);
}

/* ------------------------------------------------------------------------- */
/* The governing invariant                                                    */
/* ------------------------------------------------------------------------- */

export interface ReconcileReport {
  examined: number;
  /** Bins that are fine: something is claimable, live, or retrying. */
  healthy: number;
  /** Bins turned into one precise human decision. */
  escalated: number;
  details: Array<{ binId: string; disposition: string; reason: string }>;
}

/**
 * Every nonterminal bin must have claimable work, live work, a bounded
 * automatic retry, or one precise human decision that can actually resolve it.
 *
 * An unexplained nonterminal bin with an empty queue is a defect, and this pass
 * is what makes that statement checkable rather than aspirational. It is the
 * same rule the packet runner already applies to orchestrations, lifted one
 * level: a mission nobody is working and nobody can work has to say which of
 * the four situations it is in.
 *
 * Deliberately conservative. It only ever escalates — it never quietly marks
 * anything complete — because the one thing worse than a stalled bin is a
 * stalled bin reported as finished.
 */
export async function reconcileBins(projectId?: string): Promise<ReconcileReport> {
  /*
   * Correct the accounting before judging the bin by it.
   *
   * A bin charged for assignments Brain refused itself was being measured
   * against a number that overstated what it had spent — and in production that
   * number is what retired it. So the credit runs first, over parked bins too:
   * the bin at 100/100 was parked *because* of the miscount, and a pass that
   * only looked at live bins could never reach the one the defect stranded.
   *
   * `creditRefusedAssignments` is derived from append-only events and is
   * idempotent per generation, so this is safe to run on every tick for ever.
   */
  const chargeable = await listBins({
    projectId,
    states: ['DRAFT', 'READY', 'LEASED', 'NEEDS_HUMAN'],
    limit: 500,
  });
  for (const bin of chargeable) {
    const credited = await creditRefusedAssignments(bin.id);

    /*
     * And the answering transition. §24: a state that says "waiting for a
     * person" which that person cannot resolve is not waiting, it is stuck —
     * and this one was worse, because the condition it escalated on was
     * Brain's own arithmetic. Having corrected it, Brain answers the park it
     * caused, through the same guarded transition an operator uses.
     *
     * **Derived from the bin's current budget, not from this pass having
     * moved it**, and that is a correction. It used to return early on
     * `credited === 0`, so the reopen could only ever happen in the same pass
     * as the credit — and if the two came apart for any reason, the bin was
     * left parked for ever with a full budget and a resolved condition, which
     * is the exact defect the reopen exists to answer.
     *
     * Production had one: `bin_dcb7564ba5e840b3aac3` sat at `NEEDS_HUMAN`
     * reading *"used all 5 attempts"* with `attempts 0/5`, while its packet was
     * `AUDITING` with two claimable audit items and nothing anywhere able to
     * send a worker for them. Deriving the condition from rows reaches it; the
     * moment does not.
     *
     * It cannot loop and it adds no ceiling. The bin becomes dispatchable
     * again, spends its attempts the ordinary way if the work still cannot be
     * finished, parks again with the budget genuinely exhausted, and is then
     * not selected — because `attemptCount >= maxAttempts` is the guard. And
     * `reopenParkedBin` still refuses anything whose contract answers HUMAN.
     */
    if (bin.state !== 'NEEDS_HUMAN') continue;
    const now = await getBin(bin.id);
    if (!now || now.state !== 'NEEDS_HUMAN' || now.attemptCount >= now.maxAttempts) continue;
    await reopenParkedBin({
      binId: now.id,
      operator: 'brain:admission-accounting',
      reason:
        (credited > 0
          ? `${credited} assignment(s) were charged to this bin for arrivals Brain's own audit ` +
            'independence guard refused. Those are not attempts the bin spent, and they have ' +
            'been credited back from the recorded events. '
          : 'This bin escalated on an exhausted assignment budget that is no longer exhausted: ' +
            `${now.attemptCount} of ${now.maxAttempts} are spent. `) +
        'The condition it stopped on is resolved, so there is nothing here for a person to ' +
        'decide. Nothing was reset: every refusal and every attempt keeps its row.',
    });
  }

  const bins = await listBins({
    projectId,
    states: ['DRAFT', 'READY', 'LEASED'],
    limit: 500,
  });
  const report: ReconcileReport = { examined: bins.length, healthy: 0, escalated: 0, details: [] };

  for (const bin of bins) {
    // Live work. Somebody holds it and the lease has not run out.
    if (bin.state === 'LEASED' && bin.leaseExpiresAt && new Date(bin.leaseExpiresAt) > new Date()) {
      report.healthy += 1;
      continue;
    }

    // An expired lease is claimable work by construction, and the attempt
    // budget is what bounds it. Either is a healthy answer.
    const assignable = bin.attemptCount < bin.maxAttempts;
    if (bin.state === 'READY' && assignable) {
      report.healthy += 1;
      continue;
    }
    if (bin.state === 'LEASED' && assignable) {
      report.healthy += 1; // expired, and another worker may take it over
      continue;
    }
    if (bin.state === 'DRAFT') {
      // Not yet dispatchable, and nothing will dispatch it. That is a decision
      // waiting on whoever is authoring it, and it is named as one.
      report.healthy += 1;
      continue;
    }

    // Out of attempts and nobody holds it. Nothing further will happen on its
    // own, so it becomes exactly one decision with the reason attached.
    const verdict = await evaluateContract(bin);
    const reason =
      `The bin used all ${bin.maxAttempts} attempts without satisfying ` +
      `${bin.completionContract} v${bin.contractVersion}. ` +
      (verdict.reasons.length > 0
        ? `Outstanding: ${verdict.reasons.join(' ')}`
        : 'The contract reported no outstanding reason, which is itself worth reading.') +
      ' Decide whether to raise its attempt budget, change its manifest, or close it unfinished.';

    const escalated = await terminateUnleasedBin(bin.id, bin.leaseGeneration, 'NEEDS_HUMAN', reason);
    if (escalated) {
      report.escalated += 1;
      report.details.push({ binId: bin.id, disposition: 'NEEDS_HUMAN', reason });
    } else {
      // Somebody assigned it between the read and the write. Ordinary.
      report.healthy += 1;
    }
  }
  return report;
}

/** Read a bin without holding it. For reports and the acceptance harness. */
/**
 * Answering a bin's escalation, with the one precondition the bin's own
 * contract implies.
 *
 * `reopenNeedsHumanBin` is the state machine's guard: one source state, a
 * compare-and-swap, a fence, a budget check, an audit row. This adds the
 * question that guard cannot ask, because a repository must not know what a
 * contract means: **a `RESEARCH_PACKET_V1` bin is only worth reopening if its
 * packet has actually moved.**
 *
 * Without it the operator's remedy for "the contract refused because the packet
 * was not terminal" would be to reopen the bin and let a worker discover the
 * same thing — spending an activation out of a routine's hourly fire budget to
 * be told what the row already says. Worse, it would be a loop: refuse, park,
 * reopen, refuse.
 *
 * It does not re-judge the verdict, the evidence or the gaps, and it must never
 * become a second opinion about whether a packet is finished. It asks
 * `evaluateContract` — the same evaluator the completion path runs — and
 * refuses only what that answers `HUMAN` to. An earlier version asked whether
 * the packet was terminal instead, which is a *proxy* for that question and
 * gets it wrong for a packet that has legitimately gone back to work; see the
 * comment at the check itself.
 */
export async function reopenParkedBin(input: {
  binId: string;
  operator: string;
  reason: string;
}): Promise<ReopenOutcome> {
  const bin = await getBin(input.binId);
  if (!bin) return { ok: false, refusal: 'NOT_FOUND', reason: `No bin ${input.binId}.` };

  const evidence: Record<string, unknown> = { contract: bin.completionContract };
  if (bin.completionContract === 'RESEARCH_PACKET_V1') {
    const orchestrationId = bin.orchestrationId;
    if (!orchestrationId) {
      return {
        ok: false,
        refusal: 'WRONG_STATE',
        reason:
          `Bin ${input.binId} declares RESEARCH_PACKET_V1 and links to no orchestration, so there ` +
          'is no packet whose state could have changed.',
      };
    }
    const orchestration = await getOrchestration(orchestrationId);
    if (!orchestration) {
      return {
        ok: false,
        refusal: 'WRONG_STATE',
        reason: `Orchestration ${orchestrationId} does not exist.`,
      };
    }

    /*
     * The question is "would this bin park again immediately", and it is asked
     * of the contract rather than approximated.
     *
     * This used to require the packet to be **terminal**, on the reasoning that
     * reopening otherwise "would spend an activation to be refused by the same
     * contract for the same reason". The reasoning was right and the proxy was
     * wrong, in the one direction that matters: `RESEARCH_PACKET_V1` refuses a
     * *running* packet with `RETRY`, which is the ordinary in-progress answer
     * and leaves the bin working — only a packet that has gone terminal without
     * filing, or one waiting for approval, refuses with `HUMAN` and parks it.
     *
     * An `OTHER_LAYER` handoff is exactly the case the proxy got wrong. The bin
     * parked because the packet was `NEEDS_HUMAN`; routing the document to the
     * layer that owns it resolved that and put the packet back to `AUDITING`.
     * So the escalation is answered and the packet is legitimately not
     * terminal — and the old guard refused, leaving a bin that says "waiting
     * for a person" which no person could resolve. §24's own sentence, at a
     * third altitude, and the remedy is the same: an escalation needs an
     * answering transition, and it must be guarded rather than absent.
     *
     * Asking `evaluateContract` is strictly narrower than the old rule *and*
     * strictly more accurate: `AWAITING_APPROVAL`, a failed packet, a cancelled
     * one and a packet that filed nothing all still refuse, by name, with the
     * contract's own words.
     */
    const verdict = await evaluateContract(bin);
    evidence['orchestrationId'] = orchestrationId;
    evidence['orchestrationStatus'] = orchestration.status;
    evidence['documentId'] = orchestration.documentId;
    evidence['auditId'] = orchestration.auditId;
    evidence['verdict'] = orchestration.verdict;
    evidence['contractDisposition'] = verdict.disposition;
    if (verdict.disposition === 'HUMAN') {
      return {
        ok: false,
        refusal: 'WRONG_STATE',
        reason:
          `Packet ${orchestrationId} is ${orchestration.status}, and its completion contract ` +
          `still answers HUMAN: ${verdict.reasons.join(' ')} Reopening would spend an activation ` +
          'to be refused for the same reason.',
      };
    }
  }

  return await reopenNeedsHumanBin({
    binId: bin.id,
    leaseGeneration: bin.leaseGeneration,
    operator: input.operator,
    reason: input.reason,
    resolutionEvidence: evidence,
  });
}

export async function describeBin(binId: string): Promise<Bin | null> {
  return await getBin(binId);
}
