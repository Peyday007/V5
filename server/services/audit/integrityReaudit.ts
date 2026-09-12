/**
 * Re-auditing a packet because its audit was not independent.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all, and why it is not the handoff
 * ---------------------------------------------------------------------------
 *
 * §23's separation matrix now makes the author of a report a party to its own
 * audit, so a session that files the synthesis is refused every reviewer role.
 * That stops the pairing happening again. It does nothing for a packet where it
 * already happened — and production has one: `orc_abab7d7130d545eaa1a1` is
 * `COMPLETE` with a `PASS` verdict and a filed document whose PRIMARY audit was
 * written by the report's own author.
 *
 * `auditRound.ts` already knows how to make three roles outstanding again
 * without editing anything, and it starts a round from exactly one event: an
 * `OTHER_LAYER` handoff. Using that here would assert that the document moved
 * layers, which it did not. **Making the rows say something untrue to get a
 * lookup to come out right is the thing that module was written to refuse**, so
 * this is a second, narrower reason a round may begin, with its own record.
 *
 * ---------------------------------------------------------------------------
 * What it preserves, which is everything
 * ---------------------------------------------------------------------------
 *
 * The superseded audit keeps its row, its verdict, its gaps, its evidence and
 * its `created_at`. Every pass keeps its row, its raw response, its lineage and
 * its timestamps. The document keeps its bytes, its version, its hash, its
 * storage key and its extraction runs. The mission keeps its writeback and the
 * knowledge row it filed.
 *
 * What moves is a boundary in *time*, plus the small amount of state that
 * cannot be derived from one: the packet says it is auditing again rather than
 * complete, its projection of the verdict is cleared so the old one cannot be
 * read as this round's answer, and a bin exists that a worker can actually be
 * sent for. All three are recoverable facts about now; none of them is history.
 *
 * ---------------------------------------------------------------------------
 * Idempotency, and the four failures it has to survive
 * ---------------------------------------------------------------------------
 *
 * `requestKeyFor` is built from **server-controlled facts only** — the
 * orchestration, the document, the exact content hash, and the finding — and
 * `UNIQUE (request_key)` is the arbiter. Nothing the caller sent contributes, so
 * a key is never a way to reopen a packet in another project.
 *
 *   - **A duplicate request** collides and replays. One reopen, one boundary.
 *   - **A lost response** is a duplicate request with a different cause, and
 *     gets the same answer, which is what makes retrying it safe.
 *   - **A restart** mid-request loses nothing, because the row *is* the state
 *     and the round boundary is an append-only event rather than a timer.
 *   - **A changed document** produces a different key, because it is a different
 *     operation about different bytes — and an open reopen whose document no
 *     longer hashes the same is `SUPERSEDED_BY_VERSION`, never `RESOLVED`:
 *     nothing re-audited anything, and saying otherwise would claim an
 *     assurance nobody earned.
 *
 * A fifth, which is §20's rule rather than a failure: **a replay re-reads and
 * re-authorizes.** The stored `requested_by_id` is a record of who asked, never
 * a credential — a principal whose access was revoked between the first request
 * and the retry is refused at the second, from current rows.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../../db/database.ts';
import type { AuditRole } from '../queue/workTypes.ts';
import type { ResearchPass } from '../../domain/types.ts';
import { getDocument } from '../../repos/documents.ts';
import { getUser, listMembershipsForPrincipal } from '../../repos/identity.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import { getOrchestration, listPasses, updateOrchestration } from '../../repos/research.ts';
import { cancelWork, listWorkItems } from '../../repos/workQueue.ts';
import { recordEvent } from '../../repos/events.ts';
import { binByCreator, createBin, getBin } from '../../repos/bins.ts';
import { lineageFromPasses } from '../research/independence.ts';
import { advancePacket } from '../research/packetRunner.ts';
import { ROLE_PASS_ORDINAL } from '../research/auditBrief.ts';
import {
  listReopens,
  openReopen,
  openReopenFor,
  resolveReopen,
  supersedeReopen,
  type AuditIntegrityReopen,
  type CarriedRole,
  type IntegrityFinding,
} from '../../repos/auditReopens.ts';

/** Bumped when the reuse rule or the transition's shape changes. */
export const REAUDIT_DECIDER_VERSION = '2026-09-12.1';

/** The three roles, in the order they must run. */
const ROLES: AuditRole[] = ['PRIMARY', 'ADVERSARIAL', 'JUDGE'];

/**
 * Which role's output each role is built from.
 *
 * Read from `auditBriefFor`, which composes the adversarial prompt out of the
 * primary's raw response and the judge's out of both. That is what makes reuse
 * a *dependency* question rather than a preference: an adversarial pass is a
 * critique of one particular primary argument, so carrying it forward past a
 * replaced primary would keep a critique of a superseded argument and present
 * it as this round's.
 */
const DEPENDS_ON: Record<AuditRole, AuditRole[]> = {
  PRIMARY: [],
  ADVERSARIAL: ['PRIMARY'],
  JUDGE: ['PRIMARY', 'ADVERSARIAL'],
};

export type ReauditRefusal =
  | 'NOT_AUTHORIZED'
  | 'NO_SUCH_PACKET'
  | 'NO_FILED_DOCUMENT'
  | 'DOCUMENT_HAS_NO_HASH'
  | 'NO_COMPLETED_AUDIT'
  | 'NO_RECORDED_AUTHOR'
  | 'AUDIT_IS_INDEPENDENT'
  | 'ALREADY_REOPENED';

export interface ReuseDecision {
  /** Roles this round must run again, in order. */
  rerun: AuditRole[];
  /** Roles carried forward from the previous round, each with its reason. */
  carried: CarriedRole[];
  /** Roles that shared a session with an author of the report. */
  conflicted: AuditRole[];
}

/**
 * Which roles may be carried forward, decided from recorded lineage alone.
 *
 * Three conditions, and a role is reusable only if all three hold:
 *
 *   1. **Independence.** Its session is not one that authored the report. Every
 *      completed synthesis attempt counts, not just the newest: a session that
 *      wrote a superseded attempt argued the report into the shape the current
 *      one inherits.
 *   2. **Dependencies.** No role it is built from is being rerun. This is a
 *      closure rather than a single check — a replaced PRIMARY reruns
 *      ADVERSARIAL, and a replaced ADVERSARIAL reruns JUDGE.
 *   3. **Presence.** It has a completed pass to carry. A role that never ran is
 *      not "reused"; it is outstanding.
 *
 * Pure, over passes that are already recorded. Nothing here reads a role name a
 * submitter claimed, and nothing here is a preference a caller can express.
 */
export function decideRoleReuse(passes: ResearchPass[]): ReuseDecision {
  const { audits, synthesisAttempts } = lineageFromPasses(passes);
  const authorSessions = new Set(
    synthesisAttempts
      .map((attempt) => attempt.sessionRef)
      .filter((ref): ref is string => typeof ref === 'string' && ref !== ''),
  );

  const byRole = new Map<AuditRole, string | null>();
  for (const lineage of audits) byRole.set(lineage.role, lineage.sessionRef);

  const conflicted: AuditRole[] = [];
  const rerun = new Set<AuditRole>();
  for (const role of ROLES) {
    if (!byRole.has(role)) {
      // Never ran in the previous round, so there is nothing to carry.
      rerun.add(role);
      continue;
    }
    const session = byRole.get(role) ?? null;
    /*
     * Empty is absent, not distinct — the same rule the separation matrix
     * applies, and for the same reason. A role whose session was never recorded
     * cannot be shown to be independent of the author, and "we could not tell"
     * must never read the same as "we checked".
     */
    if (!session || authorSessions.has(session)) {
      conflicted.push(role);
      rerun.add(role);
    }
  }

  // The closure. Applied until it stops changing rather than in one pass, so
  // the order of `ROLES` is not load-bearing.
  for (let pass = 0; pass < ROLES.length; pass += 1) {
    for (const role of ROLES) {
      if (rerun.has(role)) continue;
      if (DEPENDS_ON[role].some((dependency) => rerun.has(dependency))) rerun.add(role);
    }
  }

  const carried: CarriedRole[] = ROLES.filter((role) => !rerun.has(role)).map((role) => ({
    role,
    reason:
      `ran in a session that authored nothing in this packet, and depends on no role ` +
      `being run again`,
  }));

  return {
    rerun: ROLES.filter((role) => rerun.has(role)),
    carried,
    conflicted,
  };
}

/**
 * The key this operation reserves itself with.
 *
 * Server facts only. The document's content hash is in it because the finding
 * is about *those bytes*: a replaced document is a different operation, not a
 * repeat of this one.
 */
export function requestKeyFor(input: {
  orchestrationId: string;
  documentId: string;
  documentHash: string;
  finding: IntegrityFinding;
}): string {
  return createHash('sha256')
    .update(
      [
        'audit-integrity-reopen',
        REAUDIT_DECIDER_VERSION,
        input.orchestrationId,
        input.documentId,
        input.documentHash,
        input.finding,
      ].join(' '),
    )
    .digest('hex');
}

export interface ReauditOutcome {
  ok: boolean;
  orchestrationId: string;
  reopen: AuditIntegrityReopen | null;
  /** False when this call replayed an existing reservation rather than making one. */
  created: boolean;
  binId: string | null;
  refusal: ReauditRefusal | null;
  detail: string;
}

/**
 * Begin a new audit round on this packet because its author reviewed it.
 *
 * The caller is responsible for authorizing the principal *before* calling —
 * and for authorizing it again on a retry, which is why this takes a resolved
 * person id rather than anything it could look up for itself. Nothing here
 * decides who may ask.
 */
export async function requestIntegrityReaudit(input: {
  orchestrationId: string;
  /** The authenticated person asking. Re-authorized here, on every attempt. */
  personId: string;
}): Promise<ReauditOutcome> {
  const orchestration = await getOrchestration(input.orchestrationId);
  if (!orchestration) {
    return refuse(input.orchestrationId, 'NO_SUCH_PACKET', 'No such packet.');
  }

  /*
   * Authorized here rather than by the caller, and re-read on every attempt.
   *
   * §20's rule: a replay re-reads and re-authorizes. The `requested_by_id` a
   * reservation stores is a record of who asked, never a credential — so a
   * person whose access was revoked between the first request and the retry is
   * refused at the second, from current rows, and the stored row does not let
   * them past. Put in the service rather than in its entrance because a guard
   * on one entrance is not a guard.
   *
   * A worker cannot reach this at all: the principal is built from a user row,
   * so `decideProjectAccess` only ever sees a `HUMAN` here, and a machine that
   * could discard a verdict about its own work is the thing this whole repair
   * is about.
   */
  const user = await getUser(input.personId);
  const principal =
    user && !user.disabled
      ? {
          type: 'HUMAN' as const,
          id: user.id,
          handle: user.email,
          displayName: user.displayName,
          isBrainAdmin: user.isBrainAdmin,
          mustChangePassword: user.mustChangePassword,
          credentialId: '',
          authMethod: 'SESSION_COOKIE' as const,
          memberships: await listMembershipsForPrincipal('HUMAN', user.id),
          requestId: '',
        }
      : null;
  const decision = decideProjectAccess(principal, orchestration.projectId, 'ADMIN');
  if (!decision.allowed) {
    /*
     * The same refusal for absent and forbidden, deliberately — invariant 23.
     * A reader who may not touch this project must not learn from the wording
     * whether the packet exists.
     */
    return refuse(
      input.orchestrationId,
      'NOT_AUTHORIZED',
      'No such packet, or you may not administer it.',
    );
  }
  if (!orchestration.documentId) {
    return refuse(
      orchestration.id,
      'NO_FILED_DOCUMENT',
      'This packet filed no document, so there is no report for an author to have reviewed.',
    );
  }
  const document = await getDocument(orchestration.documentId);
  if (!document) {
    return refuse(
      orchestration.id,
      'NO_FILED_DOCUMENT',
      'The filed document could not be read back.',
    );
  }
  if (!document.fileHash) {
    /*
     * Refused rather than keyed on the document id alone.
     *
     * Without a hash the reservation could not tell a re-audit of these bytes
     * from a re-audit of whatever replaced them, and the reopen would go on
     * reporting a finding about content nobody holds. A document with no
     * recorded hash is a reconcile, not a re-audit.
     */
    return refuse(
      orchestration.id,
      'DOCUMENT_HAS_NO_HASH',
      'The filed document has no recorded content hash, so a recovery cannot be bound to the ' +
        'exact bytes the finding is about. Reconcile the document first.',
    );
  }

  const passes = await listPasses(orchestration.id);
  const reuse = decideRoleReuse(passes);
  const { audits } = lineageFromPasses(passes);
  if (audits.length === 0) {
    return refuse(
      orchestration.id,
      'NO_COMPLETED_AUDIT',
      'This packet has no completed audit pass, so there is no audit to correct.',
    );
  }
  const { synthesisAttempts } = lineageFromPasses(passes);
  if (synthesisAttempts.length === 0) {
    return refuse(
      orchestration.id,
      'NO_RECORDED_AUTHOR',
      'This packet records no completed synthesis pass, so who authored the report cannot be ' +
        'established from its rows.',
    );
  }
  if (reuse.conflicted.length === 0) {
    /*
     * The finding has to be true of the rows, and this is where that is
     * checked. A transition that reopened any packet it was pointed at would
     * be a way to discard a verdict somebody did not like.
     */
    return refuse(
      orchestration.id,
      'AUDIT_IS_INDEPENDENT',
      'No audit role on this packet ran in a session that authored the report, so there is ' +
        'nothing here for this recovery to correct.',
    );
  }

  const existingOpen = await openReopenFor(orchestration.id);
  const requestKey = requestKeyFor({
    orchestrationId: orchestration.id,
    documentId: document.id,
    documentHash: document.fileHash,
    finding: 'AUTHOR_REVIEWED_OWN_WORK',
  });
  if (existingOpen && existingOpen.requestKey !== requestKey) {
    /*
     * An open reopen about *different* bytes. Refused rather than stacked: two
     * open corrections on one packet would make "which round are we in"
     * ambiguous, and the honest remedy is to settle the first.
     */
    return {
      ok: false,
      orchestrationId: orchestration.id,
      reopen: existingOpen,
      created: false,
      binId: null,
      refusal: 'ALREADY_REOPENED',
      detail:
        'This packet already has an open integrity reopen, about a different version of the ' +
        'document. Settle that one before opening another.',
    };
  }

  const roundStartedAt = new Date().toISOString();
  const findingDetail =
    `${reuse.conflicted.join(' and ')} ran in a session that also completed this packet's ` +
    `synthesis, so the report's own author reviewed it. Independence is not established for ` +
    `this audit.`;

  const { reopen, created } = await openReopen({
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    documentId: document.id,
    documentVersion: document.version,
    documentHash: document.fileHash,
    finding: 'AUTHOR_REVIEWED_OWN_WORK',
    findingDetail,
    supersededAuditId: orchestration.auditId ?? null,
    rolesRerun: reuse.rerun,
    rolesCarried: reuse.carried,
    requestedById: input.personId,
    requestKey,
    roundStartedAt,
  });

  if (!created) {
    /*
     * A replay. Every effect below already happened under the row that won, and
     * repeating them would cancel a *live* round's work items and build a
     * second bin for one packet. The answer is the same answer, which is the
     * whole point: retrying a request whose response was lost is safe.
     */
    const bin = await binForReopen(reopen);
    return {
      ok: true,
      orchestrationId: orchestration.id,
      reopen,
      created: false,
      binId: bin,
      refusal: null,
      detail:
        'This recovery was already reserved for exactly these bytes, so nothing was opened ' +
        'twice. The round it started is the one already running.',
    };
  }

  /* ---------------------------------------------------------------------
   * The boundary. Append-only, and the only thing the round lookup reads.
   * ------------------------------------------------------------------ */
  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'DOCUMENT',
    entityId: document.id,
    eventType: 'AUDIT_ROUND_REOPENED',
    payload: {
      reopenId: reopen.id,
      orchestrationId: orchestration.id,
      finding: 'AUTHOR_REVIEWED_OWN_WORK',
      findingDetail,
      documentId: document.id,
      documentVersion: document.version,
      documentHash: document.fileHash,
      supersededAuditId: orchestration.auditId ?? null,
      supersededVerdict: orchestration.verdict ?? null,
      rolesRerun: reuse.rerun,
      rolesCarried: reuse.carried,
      conflictedRoles: reuse.conflicted,
      requestedByType: 'PERSON',
      requestedById: input.personId,
      /*
       * The boundary itself, in the payload rather than left to the row's own
       * `created_at`.
       *
       * `recordEvent` stamps its own clock, so the event lands a few
       * milliseconds after the reservation that decided this round exists.
       * Two clocks for one instant is how a pass written in between ends up
       * counted as in-round by one reader and out by another — so
       * `auditRoundStartedAt` reads *this* value, and the row's `created_at`
       * is only the fallback for an event that predates the field.
       */
      roundStartedAt,
      deciderVersion: REAUDIT_DECIDER_VERSION,
    },
  });

  /* ---------------------------------------------------------------------
   * The previous round's outstanding items, withdrawn rather than left.
   *
   * Same reasoning as the handoff's: a worker still holding one would be
   * briefed from current rows and produce a correct pass — for a role this
   * round is enqueueing anyway, which is two passes for one role and a wasted
   * activation. Cancelling is not destroying: the row keeps its id, its
   * attempts and its history, and gains the reason it stopped.
   * ------------------------------------------------------------------ */
  for (const item of await listWorkItems(orchestration.projectId, { limit: 500 })) {
    if (item.orchestrationId !== orchestration.id) continue;
    if (item.workType !== 'RESEARCH_AUDIT') continue;
    if (item.state !== 'QUEUED' && item.state !== 'LEASED') continue;
    await cancelWork(
      item.id,
      'The audit of this packet is being run again because the report\'s own author reviewed ' +
        'it. This item belongs to the round that finding is about.',
    );
  }

  /* ---------------------------------------------------------------------
   * The packet is auditing again, and its projection of the old verdict goes.
   *
   * The `audits` row is untouched — it keeps its verdict, its gaps and its
   * timestamps, and the reopen points at it. What is cleared is the packet's
   * *pointer*, because leaving it set would let the superseded judge's verdict
   * be read as this round's answer: `advancePacket` reads
   * `orchestration.verdict` once all three roles have run, and a stale one
   * there would let an old JUDGE validate a replacement PRIMARY.
   * ------------------------------------------------------------------ */
  await updateOrchestration(orchestration.id, {
    status: 'AUDITING',
    currentPass: 'AUDIT',
    verdict: null,
    auditId: null,
    completedAt: null,
    failureReason: null,
  });

  /* ---------------------------------------------------------------------
   * The round's first item, enqueued by the thing that started the round.
   *
   * `advancePacket` is what turns "this packet is AUDITING" into a work item a
   * worker can claim, and every other transition that reopens work calls it —
   * `startPacket`, `reissue`, `surfaceRecovery`, `needsHuman`, the launch, and
   * the submit tools. This one did not, and production measured the cost
   * within ninety seconds of the first reopen: `bin_50336752dd134a2c97fa` went
   * READY at 13:31:53, Brain fired at 13:32:00, a worker arrived at 13:32:15,
   * found nothing to claim, and released at 13:34:17 saying *"No open work
   * item exists yet for this reopened audit round"*. It was fired again
   * immediately, and would have gone round until the bin's five attempts were
   * spent — a loop that looks like progress, against a packet whose state said
   * a worker should be doing something.
   *
   * §24's sentence at a fifth altitude, and §27's beside it: a stage becomes
   * fireable when something makes it fireable, and the reopen is that
   * something. Ahead of the bin rather than after it, so there is no window
   * where the fire exists and the work does not.
   *
   * Idempotent by the round rather than by a flag: `advancePacket` asks
   * `auditRoleSubmitted`, `stillRunning` and `alreadyCreated` of *this* round,
   * so a replay, a restart mid-request or a concurrent tick enqueues one item
   * for the first outstanding role and no more.
   * ------------------------------------------------------------------ */
  const advanced = await advancePacket(orchestration.id);

  const binId = await ensureReauditBin({ reopen, document, orchestration });

  return {
    ok: true,
    orchestrationId: orchestration.id,
    reopen,
    created: true,
    binId,
    refusal: null,
    detail:
      `${reuse.conflicted.join(' and ')} shared a session with this packet's synthesis, so ` +
      `${reuse.rerun.join(', ')} run again against ${document.canonicalName}. ` +
      (reuse.carried.length > 0
        ? `${reuse.carried.map((c) => c.role).join(', ')} carried forward. `
        : 'No role could be carried forward. ') +
      `The round is waiting on ${advanced.waitingOn ?? 'nothing'}; ` +
      `${advanced.enqueued.length} item(s) enqueued. ` +
      'Nothing recorded was changed.',
  };
}

function refuse(
  orchestrationId: string,
  refusal: ReauditRefusal,
  detail: string,
): ReauditOutcome {
  return {
    ok: false,
    orchestrationId,
    reopen: null,
    created: false,
    binId: null,
    refusal,
    detail,
  };
}

/**
 * The bin this reopen built, if it is still there.
 *
 * Found by the creator id the reopen stamped on it rather than by the packet,
 * because a packet can hold more than one bin over its life and asking by
 * orchestration would sometimes answer about the spent one.
 */
async function binForReopen(reopen: AuditIntegrityReopen): Promise<string | null> {
  const bin = await binByCreator(`reaudit:${reopen.id}`);
  return bin?.id ?? null;
}

/**
 * A bin the reopened round can actually be sent for.
 *
 * The packet's own bin is `COMPLETE`, and terminal is forever — §24's fourth
 * altitude, where a live packet's items are claimable and nothing will ever be
 * dispatched to claim them. `reopenParkedBin` is the wrong remedy because it
 * answers a *park*, and this bin was not parked; it finished.
 *
 * So a new bin, with the contract the packet already uses — `RESEARCH_PACKET_V1`
 * is satisfied when the packet goes terminal, which is exactly when this round
 * is done — and a manifest that describes the work honestly: three audit roles
 * over a document that is already filed, not a research packet to be run again.
 * The spent bin keeps its row, its attempts and its events.
 */
async function ensureReauditBin(input: {
  reopen: AuditIntegrityReopen;
  document: { id: string; canonicalName: string; version: string };
  orchestration: { id: string; projectId: string; layerId: string | null; title: string };
}): Promise<string> {
  const { reopen, document, orchestration } = input;
  const bin = await createBin({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    kind: 'RESEARCH_PACKET',
    title: `Re-audit: ${document.canonicalName}`,
    objective:
      `Run the audit of ${document.canonicalName} again. The previous round's ` +
      `${reopen.rolesRerun.join(', ')} cannot stand: the report's own author reviewed it.`,
    rationale: reopen.findingDetail,
    manifest: {
      objective: `Audit ${document.canonicalName} (${document.version}) again, independently.`,
      why: reopen.findingDetail,
      /*
       * `lineage` is the manifest's own typed shape and stays exactly that —
       * the document, the hash and the reopen go in `evidence` and `why`, where
       * a worker reads them, rather than being wedged into a field with four
       * declared keys. Widening a shared type for one caller is how a contract
       * stops meaning anything.
       */
      lineage: {
        projectId: orchestration.projectId,
        layerId: orchestration.layerId,
        goal: `Re-audit ${document.canonicalName} (${document.version}) independently.`,
        orchestrationId: orchestration.id,
      },
      units: [],
      /*
       * Empty on purpose, and the emptiness is the instruction.
       *
       * `BinManifest` requires both lists, and a re-audit reads a document that
       * is already filed: there are no sources to accept or exclude because
       * nothing new is being sourced. Leaving them off would have been a type
       * error; filling them with the packet's original lists would tell a
       * worker it may go looking, which is the first thing `prohibitedActions`
       * below forbids.
       */
      acceptableSources: [],
      excludedSources: [],
      evidence: [
        `The filed document ${document.canonicalName} (${document.version}), content hash ` +
          `${reopen.documentHash}, read back from the store through its extraction run`,
        "The packet's accepted claim ledger, which is settled and is not reopened",
        `Integrity record ${reopen.id}${reopen.supersededAuditId ? `, superseding audit ${reopen.supersededAuditId}` : ''}`,
      ],
      outputs: [
        `A completed pass for each of: ${reopen.rolesRerun.join(', ')}`,
        'A fresh judge verdict recorded against this round',
      ],
      authorizedActions: [
        'brain_claim_work and brain_submit_audit, for the RESEARCH_AUDIT items of this packet',
      ],
      /*
       * Restated rather than assumed, exactly as the launch does it. A worker
       * that never sees a prohibition has not been told about it — and the
       * first of these is the whole reason this bin exists.
       */
      prohibitedActions: [
        'taking an audit role in a session that authored any part of this report',
        'any new research, claim or fragment: the evidence is settled and only the audit is not',
        'any work item outside this orchestration',
        'enabling paid overage',
        'any purchase, contact, filing or other irreversible external action',
      ],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 60 },
      stoppingConditions: [
        'The packet reaches its own terminal state again with a verdict recorded in this round',
      ],
    },
    completionContract: 'RESEARCH_PACKET_V1',
    orchestrationId: orchestration.id,
    workloadClass: 'RESEARCH_PACKET',
    createdByType: 'SYSTEM',
    createdById: `reaudit:${reopen.id}`,
    ready: true,
    priority: 7,
    maxAttempts: 5,
  });
  return bin.id;
}

export interface ReopenProjection {
  /** The open correction for this packet, or null. */
  open: AuditIntegrityReopen | null;
  /** Everything this packet has ever had, newest first. */
  history: AuditIntegrityReopen[];
  /**
   * What a reader is owed in one sentence, or null when nothing is pending.
   * Composed here so two surfaces cannot describe the same state differently.
   */
  sentence: string | null;
}

/** What to say about this packet's independence assurance, derived from rows. */
export async function reopenProjection(orchestrationId: string): Promise<ReopenProjection> {
  const history = await listReopens(orchestrationId);
  const open = history.find((entry) => entry.state === 'OPEN') ?? null;
  return {
    open,
    history,
    sentence: open
      ? `Independent-review assurance is PENDING CORRECTION: ${open.findingDetail} ` +
        `${open.rolesRerun.join(', ')} are running again against ${open.documentVersion}. ` +
        `The superseded verdict keeps its row${open.supersededAuditId ? ` (${open.supersededAuditId})` : ''}.`
      : null,
  };
}

/**
 * Settle the reopens whose condition has stopped holding, from rows.
 *
 * Derived on a tick rather than hooked to the judge's submission, for the
 * reason `concludeAbandonedParks` is: a hook fixes one entrance and the rows
 * reach every entrance plus the ones already stranded.
 *
 * Two exits and they are deliberately different. A fresh verdict recorded in
 * this round is `RESOLVED`. A document whose bytes no longer hash to what the
 * finding was about is `SUPERSEDED_BY_VERSION` — nothing re-audited anything,
 * and reporting that as answered would claim an assurance nobody earned.
 */
export async function reconcileIntegrityReopens(
  open: AuditIntegrityReopen[],
): Promise<{ resolved: string[]; superseded: string[] }> {
  const resolved: string[] = [];
  const superseded: string[] = [];

  for (const reopen of open) {
    const document = await getDocument(reopen.documentId);
    if (!document || document.fileHash !== reopen.documentHash) {
      if (await supersedeReopen(reopen.id)) superseded.push(reopen.id);
      continue;
    }

    const orchestration = await getOrchestration(reopen.orchestrationId);
    if (!orchestration) continue;

    /*
     * A verdict from *this* round, and both halves of that matter.
     *
     * The audit id must differ from the one this reopen superseded — otherwise
     * a stale pointer restored by anything would settle the correction with the
     * very verdict it exists to replace. And the judge's pass must have
     * completed after the boundary, because the audit row alone cannot say
     * which round produced it.
     */
    if (!orchestration.auditId) continue;
    if (orchestration.auditId === reopen.supersededAuditId) continue;

    const passes = await listPasses(reopen.orchestrationId);
    const judged = passes.some(
      (pass) =>
        pass.passKey === 'AUDIT' &&
        pass.ordinal === ROLE_PASS_ORDINAL.JUDGE &&
        pass.status === 'COMPLETE' &&
        (pass.completedAt ?? pass.startedAt) > reopen.roundStartedAt,
    );
    if (!judged) continue;

    if (await resolveReopen({ id: reopen.id, auditId: orchestration.auditId })) {
      resolved.push(reopen.id);
    }
  }

  return { resolved, superseded };
}

export interface OverlapFinding {
  orchestrationId: string;
  projectId: string;
  status: string;
  documentId: string | null;
  /** Roles that ran in a session which also authored this packet's report. */
  conflicted: AuditRole[];
  /** True when a reviewer's or an author's session was never recorded. */
  unattributed: boolean;
  /** What this packet's reopen record says, if it has one. */
  reopenState: string | null;
}

/**
 * Every packet whose reviewer shared a session with its author, read from rows.
 *
 * A **scope report and nothing else.** It opens nothing, changes nothing and
 * names no remedy per packet, because reopening work nobody asked about is the
 * opposite of what a scan is for — the finding is the product, and the decision
 * is a person's.
 *
 * `unattributed` is a separate column rather than folded into `conflicted`, and
 * the distinction is the one this whole repair rests on: a packet whose audit
 * sessions were never recorded is one nobody can tell about, which is not the
 * same fact as one where the author demonstrably reviewed. Reporting them as
 * one number would be exactly the "we could not tell reads the same as we
 * checked" this file refuses everywhere else.
 */
export async function scanAuthorReviewerOverlap(limit = 200): Promise<OverlapFinding[]> {
  const rows = await getDb().all<{
    id: string;
    project_id: string;
    status: string;
    document_id: string | null;
  }>(
    `SELECT id, project_id, status, document_id
       FROM research_orchestrations
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [Math.max(1, limit)],
  );

  const findings: OverlapFinding[] = [];
  for (const row of rows) {
    const passes = await listPasses(row.id);
    const { audits, synthesisAttempts } = lineageFromPasses(passes);
    if (audits.length === 0 || synthesisAttempts.length === 0) continue;

    const authorSessions = new Set(
      synthesisAttempts
        .map((attempt) => attempt.sessionRef)
        .filter((ref): ref is string => typeof ref === 'string' && ref !== ''),
    );
    const unattributed =
      authorSessions.size === 0 || audits.some((audit) => !audit.sessionRef);
    const conflicted = audits
      .filter((audit) => audit.sessionRef && authorSessions.has(audit.sessionRef))
      .map((audit) => audit.role);

    if (conflicted.length === 0 && !unattributed) continue;

    const reopens = await listReopens(row.id);
    findings.push({
      orchestrationId: row.id,
      projectId: row.project_id,
      status: row.status,
      documentId: row.document_id,
      conflicted,
      unattributed,
      reopenState: reopens[0]?.state ?? null,
    });
  }
  return findings;
}

/** Present so a caller can check a bin exists without importing the repository. */
export async function reauditBinExists(binId: string | null): Promise<boolean> {
  if (!binId) return false;
  return (await getBin(binId)) !== null;
}
