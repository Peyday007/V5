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
import type { Bin, BinManifest, ClaimedWork, Principal, WorkerScope } from '../../domain/types.ts';
import {
  assignNextBin,
  checkpointBin,
  confinementFor,
  countBinEvents,
  finishBin,
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
import { TERMINAL_ORCHESTRATION } from '../research/outcome.ts';
import { claimWork, listWorkItemsForBin, type ClaimScope } from '../../repos/workQueue.ts';
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
export async function checkIn(input: {
  principal: Principal;
  workerId: string;
  sessionRef?: string | null;
  leaseMs?: number;
}): Promise<CheckInResult> {
  const scopes = claimableProjects(input.principal);
  if (scopes.length === 0) return { assigned: false, reason: 'NO_READY_BINS' };

  const assigned = await assignNextBin({
    workerId: input.workerId,
    credentialId: input.principal.credentialId,
    projectIds: scopes.map((scope) => scope.projectId),
    sessionRef: input.sessionRef ?? null,
    leaseMs: input.leaseMs,
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

  const claimed = await claimWork({
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
  return { held: true, item: null, binHasOpenWork: open.length > 0 };
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
 * It reads the packet's status only. It does not re-judge the verdict, the
 * evidence or the gaps — `RESEARCH_PACKET_V1` does that, at execution time, and
 * this must not become a second opinion about whether a packet is finished.
 * The statuses it accepts are exactly the runner's own terminal set, asked of
 * `TERMINAL_ORCHESTRATION` rather than restated here.
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
    if (!TERMINAL_ORCHESTRATION.has(orchestration.status)) {
      return {
        ok: false,
        refusal: 'WRONG_STATE',
        reason:
          `Packet ${orchestrationId} is ${orchestration.status}, which is not terminal. Reopening ` +
          'this bin would spend an activation to be refused by the same contract for the same ' +
          'reason. Finish the packet first.',
      };
    }
    evidence['orchestrationId'] = orchestrationId;
    evidence['orchestrationStatus'] = orchestration.status;
    evidence['documentId'] = orchestration.documentId;
    evidence['auditId'] = orchestration.auditId;
    evidence['verdict'] = orchestration.verdict;
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
