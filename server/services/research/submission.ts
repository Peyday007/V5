/**
 * Recording what a researcher found, and judging it.
 *
 * This module exists because Step 9 gave the Brain a second way to receive
 * research and the second one must not be a second standard.
 *
 * Until Step 9 there was one path: `orchestrator.ts` called a provider, parsed
 * the reply, stored the claims and applied the gate, all inside one process.
 * Step 9 added a worker that pulls a fragment off the queue, researches it with
 * its own capabilities, and submits claims through MCP. Those are genuinely
 * different ways of *obtaining* research — one pushes a prompt, the other hands
 * out an assignment — and they must be identical ways of *accepting* it.
 *
 * So the two functions here are the whole acceptance path, and both callers use
 * them. Not a shared helper that each path then supplements; the entire
 * substance. If someone weakens the bar for one caller they weaken it for both,
 * which is exactly the property worth engineering for — the failure mode being
 * designed against is a remote path that quietly accepts what the local path
 * would have rejected.
 *
 * Neither function decides anything itself. `validateClaim` decides what counts
 * as sourced, `applyGate` decides what is accepted, and what is stored is the
 * answer rather than an interpretation of it.
 */
import type {
  ClaimType,
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  ResearchPassKey,
} from '../../domain/types.ts';
import {
  decideClaim,
  insertClaims,
  listClaimsForFragment,
  markContradiction,
  updateClaimDerivedFrom,
  updateFragment,
} from '../../repos/research.ts';
import { applyGate, fragmentPasses, type GateResult, type VerificationInput } from './gate.ts';
import { validateClaim } from './sources.ts';
import type { ClaimScopeMatch, ParsedClaim } from './schema.ts';
import { independenceGroup } from './standards.ts';

/**
 * Store one fragment's claims, every one of them unaccepted.
 *
 * The `accepted` column defaults to 0 and nothing here sets it. That is not an
 * omission to be tidied up later: a claim's acceptance is decided exactly once,
 * by the gate, against the evidence as it stood — so a path that could store an
 * already-accepted claim would be a path around the gate.
 *
 * An unsourced claim is stored too, marked and counted. Dropping it would make
 * the ledger look better than the research was, and the count of what could not
 * be sourced is one of the more useful things the ledger says.
 */
export async function recordFragmentClaims(input: {
  orchestration: ResearchOrchestration;
  fragment: ResearchFragment;
  passId: string;
  passKey: ResearchPassKey;
  /** The provider job, when there was one. A worker submission has none. */
  jobId?: string | null;
  claims: ParsedClaim[];
}): Promise<ResearchClaim[]> {
  const { orchestration, fragment, claims } = input;

  const stored = await insertClaims(
    claims.map((claim) => {
      const validated = validateClaim(claim);
      const claimType = (claim.claimType ?? 'SOURCED_FACT') as ClaimType;
      return {
        orchestrationId: orchestration.id,
        fragmentId: fragment.id,
        passId: input.passId,
        passKey: input.passKey,
        claim: claim.claim,
        claimType,
        sourceGroup: independenceGroup({
          sourceUrl: validated.normalizedUrl ?? claim.sourceUrl ?? null,
          sourcePublisher: claim.sourcePublisher ?? null,
          evidenceExcerpt: claim.evidenceExcerpt ?? null,
        }),
        primarySource: claim.primarySource ?? false,
        // The scope comes from the fragment's declaration, not from the claim.
        // A claim that says which geography it is about would be describing
        // itself; what matters is which geography it is being judged against.
        geography: fragment.geography,
        timeframe: fragment.timeframe,
        population: fragment.population,
        definition: fragment.definitions,
        requirementIds: fragment.requirementIds,
        jobId: input.jobId ?? null,
        sourceUrl: validated.normalizedUrl ?? claim.sourceUrl ?? null,
        sourceTitle: claim.sourceTitle ?? null,
        sourcePublisher: claim.sourcePublisher ?? null,
        sourceDate: claim.sourceDate ?? null,
        evidenceExcerpt: claim.evidenceExcerpt ?? null,
        evidenceLocator: claim.evidenceLocator ?? null,
        evidenceLane: claim.evidenceLane ?? null,
        // Carried through rather than defaulted here. This mapper dropped it,
        // so every claim landed RETRIEVED however the worker had marked it —
        // and a claim whose source nobody could open was then judged as though
        // somebody had read it. The gate's whole unresolved-retrieval path was
        // unreachable from the worker path because of this one missing line.
        retrievalState: claim.retrievalState ?? 'RETRIEVED',
        retrievedAt: claim.retrievedAt ?? null,
        confidence: claim.confidence,
        validationState: validated.validationState,
        validationDetail: validated.validationDetail,
        sourced: validated.sourced,
        derived: claim.derived,
        derivedFrom: claim.derivedFrom,
        contentHash: validated.contentHash,
      };
    }),
  );

  // Resolve derivation references from whatever the researcher called them to
  // real claim ids, so the gate can check that a calculation's inputs were
  // themselves accepted. A reference that resolves to nothing is dropped rather
  // than invented, and the gate then refuses the calculation for resting on
  // inputs it cannot see — which is the correct outcome.
  const byRef = new Map<string, string>();
  stored.forEach((claim, index) => {
    byRef.set(String(index), claim.id);
    byRef.set(claim.claim.trim().toLowerCase().slice(0, 80), claim.id);
  });
  for (const [index, claim] of stored.entries()) {
    const source = claims[index];
    if (!source || !source.derived || source.derivedFrom.length === 0) continue;
    const resolved = source.derivedFrom
      .map((ref) => byRef.get(ref.trim().toLowerCase().slice(0, 80)) ?? byRef.get(ref.trim()))
      .filter((id): id is string => Boolean(id));
    await updateClaimDerivedFrom(claim.id, resolved);
  }

  return stored;
}

/** One claim's verification verdict, as the gate needs it. */
export interface ClaimVerification {
  claimId: string;
  supportsClaim: boolean;
  scopeMatch: ClaimScopeMatch;
  note: string;
  contradictionState?: ResearchClaim['contradictionState'];
}

/**
 * Judge a fragment's ledger and record the verdict.
 *
 * Two of the gate's seven conditions — does the source support the claim, and
 * does its scope line up — are judgements only a reader of the source can make.
 * They arrive here as answers. Brain's part is to insist the answer exists, is
 * structured, and is applied without exception; never to infer it.
 *
 * Everything after that is computed. The fragment's status, its two verdicts
 * and the gate's full working are written together, so a fragment is never left
 * in a state where it has been judged but does not say so.
 */
export async function gateFragment(input: {
  fragment: ResearchFragment;
  verifications: ClaimVerification[];
  sufficiency: 'SUFFICIENT' | 'INSUFFICIENT';
  missingLanes: string[];
  unresolvedGaps: string[];
}): Promise<GateResult> {
  const { fragment } = input;

  const verdicts: VerificationInput['verdicts'] = new Map();
  for (const verification of input.verifications) {
    verdicts.set(verification.claimId, {
      supportsClaim: verification.supportsClaim,
      scopeMatch: verification.scopeMatch,
      note: verification.note,
    });
    if (verification.contradictionState && verification.contradictionState !== 'UNCHALLENGED') {
      await markContradiction(
        verification.claimId,
        verification.contradictionState,
        verification.note || null,
      );
    }
  }

  const gate = applyGate({
    fragment,
    // Re-read rather than reuse: markContradiction just changed some of these,
    // and the gate's fifth condition is about exactly that column.
    claims: await listClaimsForFragment(fragment.id),
    verification: {
      verdicts,
      sufficiency: input.sufficiency,
      missingLanes: input.missingLanes,
      unresolvedGaps: input.unresolvedGaps,
    },
  });

  for (const judgement of gate.claims) {
    await decideClaim(judgement.claimId, {
      accepted: judgement.accepted,
      // Kept forever. This is what stops a rejected claim reappearing through a
      // later attempt's synthesis: acceptance was decided once, and the reason
      // it was refused travels with it.
      rejectionReason: judgement.reason,
      scopeMatch: verdicts.get(judgement.claimId)?.scopeMatch ?? null,
    });
  }

  const passed = fragmentPasses(gate);
  const at = new Date().toISOString();
  await updateFragment(fragment.id, {
    status: passed ? 'ACCEPTED' : 'BLOCKED',
    integrityVerdict: gate.integrity,
    sufficiencyVerdict: gate.sufficiency,
    verdictDetail: gate,
    blockedReason: passed ? null : gate.reasons.join(' '),
    completedAt: at,
    acceptedAt: passed ? at : null,
  });

  return gate;
}
