/**
 * One shared Brain, and the boundary that keeps it one Brain rather than one
 * pile.
 *
 * ---------------------------------------------------------------------------
 * What crosses, and what never does
 * ---------------------------------------------------------------------------
 *
 * A validated research finding is a fact about the world. Four people running
 * four private operations in one Brain should not each pay to establish that
 * Michigan requires an e-recording cover sheet, and §13's rule — that the
 * default is *not* to research — is exactly as true one boundary out as it is
 * inside a single project.
 *
 * What crosses is therefore the claim and its evidence: the statement, the
 * canonical source, the publisher, the date, the passage, the locator and the
 * scope fields. What never crosses is everything that makes a project somebody's
 * own work — unfinished research, private notes and conversations, who owns
 * which opportunity, what a person decided, what a worker is currently assigned,
 * and every claim the gate rejected, which keeps its rejection reason for ever
 * and may never re-enter through a later attempt.
 *
 * ---------------------------------------------------------------------------
 * Nothing new decides anything here
 * ---------------------------------------------------------------------------
 *
 * The classifier is `assessRequirement` in `services/reconcile/coverage.ts`,
 * untouched. This module's whole job is to put a shared finding into the shape
 * that classifier already reads, so no bar moves: `SATISFIED` is still the only
 * status that stops research, and it still needs two independent publishers, a
 * strength of 0.55 and a relevance of 0.5. One shared finding cannot suppress
 * anything on its own, and that is the correct conservatism rather than a
 * limitation.
 *
 * ---------------------------------------------------------------------------
 * A guard on one entrance is not a guard
 * ---------------------------------------------------------------------------
 *
 * There are exactly two ways into that classifier — `projectClaims()` behind
 * Russell's pre-mission archive check, and `inventoryProject()` behind the
 * packet reconciliation a worker's proposed fragments go through. Both call
 * `sharedClaimsForProject`. A rule applied by one of two readers is worse than
 * none, because the two disagree about the same question and only one of them
 * is ever read.
 */
import { CLAIM_TYPES } from '../../domain/types.ts';
import type { ClaimType, ExistingClaim } from '../../domain/types.ts';
import { eligibleFindings, listFindings } from '../../repos/sharedFindings.ts';
import type { SharedFindingEvidence } from '../../repos/sharedFindings.ts';
import { decideProjectAccess } from '../identity/policy.ts';
import type { Principal } from '../../domain/types.ts';

/**
 * A shared finding as the coverage classifier reads it.
 *
 * Two fields are deliberately not what they look like:
 *
 * `projectId` is the **asking** project, because that is what the field means to
 * every consumer of an `ExistingClaim` — "this is evidence available to this
 * assessment". It is not a claim about where the evidence came from; the origin
 * lives on the finding row and is reported through `describeForReader` below.
 *
 * `documentId` is the **finding id**, not the document the originating packet
 * filed. That document belongs to another project and its id must not leave it:
 * `documentIds` flows onto `requirement_coverage` rows and out to readers. A
 * finding id is the honest answer to "what backs this", and it is a thing the
 * reader may legitimately resolve.
 */
export function asExistingClaim(
  finding: SharedFindingEvidence,
  askingProjectId: string,
): ExistingClaim | null {
  // An unrecognised claim type is refused rather than defaulted. Defaulting
  // would turn an unknown into `SOURCED_FACT`, which is an upgrade, and the
  // difference between a sourced fact and a self-report is the difference
  // between SATISFIED and PARTIALLY_SATISFIED.
  if (!CLAIM_TYPES.includes(finding.claimType as ClaimType)) return null;

  return {
    id: finding.findingId,
    projectId: askingProjectId,
    documentId: finding.findingId,
    extractionRunId: null,
    layerId: null,
    claim: finding.claim,
    claimType: finding.claimType as ClaimType,
    page: null,
    blockIndex: null,
    charStart: null,
    charEnd: null,
    locator: finding.evidenceLocator,
    sourceUrl: finding.sourceUrl,
    sourceTitle: finding.sourceTitle,
    sourcePublisher: finding.sourcePublisher,
    sourceDate: finding.sourceDate,
    retrievedAt: finding.retrievedAt,
    supportingPassage: finding.evidenceExcerpt,
    geography: finding.geography,
    timeframe: finding.timeframe,
    population: finding.population,
    definition: finding.definition,
    // It was submitted as structure through the tools and gated, never read out
    // of a page by an extractor, so there is no extraction confidence to report.
    extractionConfidence: 1,
    evidenceConfidence: finding.confidence,
    contradictionState: 'UNCHALLENGED',
    // The gate's seven conditions include the two judgements only a reader of
    // the source can make — whether it supports the claim, and whether the scope
    // lines up — and an accepted claim has both answered. `VERIFIED` is that
    // answer, read from the acceptance rather than asserted here.
    verificationState: 'VERIFIED',
    verificationDetail: null,
    priorAuditId: null,
    documentVersion: null,
    superseded: false,
    contentHash: finding.contentHash,
    createdAt: finding.promotedAt,
  };
}

/**
 * Every shared finding this project may reuse, as claims.
 *
 * The asking project's own findings are excluded: they already reach it through
 * its own archive, and counting a claim twice would make one publisher look
 * like two against a rule whose whole point is independence.
 *
 * A failure to read is never a favourable assumption. An empty list means
 * "nothing shared bears on this", which is the same thing it would have meant
 * before this existed — so a broken read costs a duplicate packet rather than a
 * wrongly suppressed one.
 */
export async function sharedClaimsForProject(
  projectId: string,
  options: { now?: string; limit?: number } = {},
): Promise<ExistingClaim[]> {
  const findings = await eligibleFindings({
    excludeProjectId: projectId,
    ...(options.now ? { now: options.now } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
  const claims: ExistingClaim[] = [];
  for (const finding of findings) {
    const claim = asExistingClaim(finding, projectId);
    if (claim) claims.push(claim);
  }
  return claims;
}

/**
 * What a reader is told about where a finding came from.
 *
 * The row always records the origin project, orchestration, fragment, worker
 * and session. What a given reader is *shown* is decided here, against their own
 * access, and never by leaving a column empty at write time.
 *
 * A reader who may not read the originating project still gets everything that
 * makes the finding checkable — the source, the publisher, the date, the passage
 * and the locator — and is told, in one flag, that the origin is withheld rather
 * than absent. Invariant 23 is about not distinguishing "you may not" from "it
 * is not there" for a *resource*; a shared finding is deliberately not a
 * project-scoped resource, so the finding itself is visible to everyone and only
 * the name of somebody else's project is not.
 */
export interface SharedFindingView {
  id: string;
  statement: string;
  claimType: string;
  confidence: number;
  state: SharedFindingEvidence['state'];
  /** Why it is not being reused, when it is not. Null when it is eligible. */
  withheldReason: string | null;
  source: {
    url: string | null;
    title: string | null;
    publisher: string | null;
    date: string | null;
    excerpt: string | null;
    locator: string | null;
    retrievedAt: string | null;
  };
  scope: {
    geography: string | null;
    timeframe: string | null;
    population: string | null;
    definition: string | null;
  };
  provenance: {
    /** True when this reader may see which project produced it. */
    originVisible: boolean;
    originProjectId: string | null;
    originOrchestrationId: string | null;
    originFragmentId: string | null;
    /** Null is "the pass recorded none", never a guess. */
    originWorkerId: string | null;
    originSessionRef: string | null;
    claimId: string;
    ruleVersion: string;
    promotedAt: string;
  };
  validUntil: string | null;
}

function withheldReason(finding: SharedFindingEvidence, now: string): string | null {
  if (finding.state === 'REVOKED') {
    return finding.revokedReason
      ? `Withdrawn from reuse: ${finding.revokedReason}`
      : 'Withdrawn from reuse.';
  }
  if (finding.validUntil && finding.validUntil <= now) {
    return `Declared good until ${finding.validUntil}, which has passed.`;
  }
  if (finding.contradictionState === 'CONTESTED' || finding.contradictionState === 'REFUTED') {
    return 'A contradiction was recorded against the claim and nothing resolved it.';
  }
  return null;
}

/**
 * Project one finding for one reader.
 *
 * `decideProjectAccess` at `READ` decides the origin, which is the same module
 * every HTTP route uses. There is no shared-knowledge policy module and there
 * must never be one.
 */
export function describeForReader(
  finding: SharedFindingEvidence,
  principal: Principal | null,
  now: string,
): SharedFindingView {
  const originVisible =
    decideProjectAccess(principal, finding.originProjectId, 'READ').allowed;
  return {
    id: finding.findingId,
    statement: finding.claim,
    claimType: finding.claimType,
    confidence: finding.confidence,
    state: finding.state,
    withheldReason: withheldReason(finding, now),
    source: {
      url: finding.sourceUrl,
      title: finding.sourceTitle,
      publisher: finding.sourcePublisher,
      date: finding.sourceDate,
      excerpt: finding.evidenceExcerpt,
      locator: finding.evidenceLocator,
      retrievedAt: finding.retrievedAt,
    },
    scope: {
      geography: finding.geography,
      timeframe: finding.timeframe,
      population: finding.population,
      definition: finding.definition,
    },
    provenance: {
      originVisible,
      originProjectId: originVisible ? finding.originProjectId : null,
      originOrchestrationId: originVisible ? finding.originOrchestrationId : null,
      originFragmentId: originVisible ? finding.originFragmentId : null,
      originWorkerId: originVisible ? finding.originWorkerId : null,
      originSessionRef: originVisible ? finding.originSessionRef : null,
      claimId: finding.claimId,
      ruleVersion: finding.ruleVersion,
      promotedAt: finding.promotedAt,
    },
    validUntil: finding.validUntil,
  };
}

/** The whole pool, as one reader sees it. */
export async function sharedPoolForReader(
  principal: Principal | null,
  options: { limit?: number; now?: string } = {},
): Promise<SharedFindingView[]> {
  const now = options.now ?? new Date().toISOString();
  const findings = await listFindings(options.limit ? { limit: options.limit } : {});
  return findings.map((finding) => describeForReader(finding, principal, now));
}
