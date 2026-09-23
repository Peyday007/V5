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
  getFragment,
  insertClaims,
  listClaimsForFragment,
  markContradiction,
  updateClaimDerivedFrom,
  updateFragment,
} from '../../repos/research.ts';
import { reconcileAcceptedFragment } from './replan.ts';
import { applyGate, fragmentPasses, type GateResult, type VerificationInput } from './gate.ts';
import { validateClaim } from './sources.ts';
import type { ClaimScopeBasis, ClaimScopeMatch, ParsedClaim } from './schema.ts';
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
        opportunitySignal: claim.opportunitySignal ?? null,
        /*
         * The structural declaration travels whole or not at all.
         *
         * Four fields that only mean anything together: a restructuring
         * without its qualifier reduces nothing, and an amount without its
         * finding belongs to no requirement. Carrying three of four here is
         * the shape of defect §33 records at `applyValidationAnswers` — the
         * fact reached one reader and not the other, and both looked healthy.
         */
        structuralFinding: claim.structuralFinding ?? null,
        structuralSubject: claim.structuralSubject ?? null,
        structuralQualifier: claim.structuralQualifier ?? null,
        structuralAmountCents: claim.structuralAmountCents ?? null,
        // And the labor declaration, whole for the identical reason: a channel
        // without its basis is a figure nothing can compare, and a rate
        // without its finding belongs to no task.
        laborFinding: claim.laborFinding ?? null,
        laborSubject: claim.laborSubject ?? null,
        laborQualifier: claim.laborQualifier ?? null,
        laborRateCents: claim.laborRateCents ?? null,
        /*
         * And the capability declaration, for the same reason.
         *
         * Eight fields that only mean anything together: a demand signal
         * without its observation date is one nobody can date, a finding
         * without its subject names nothing, a capital figure without its
         * currency is the unknown taken as a favourable assumption, and a
         * capital requirement without its scenario is a number about a shape
         * of the business nobody stated.
         *
         * **Carrying some of them is the defect §33 records at
         * `applyValidationAnswers`, and this mapper committed it.** It was
         * written when a capability declaration was three fields, the other
         * five were added beside it, and this line was not — so a worker
         * submitted a correct capital requirement over the wire, the wire door
         * validated all eight, and five of them were dropped here silently.
         * Every capital claim then reached the absorption with no scenario, no
         * basis and no amount, was refused for it, and the refusal named the
         * worker. Every row read healthy and the whole suite passed, because
         * nothing else in it submits a capital requirement through this door.
         */
        capabilityFinding: claim.capabilityFinding ?? null,
        capabilitySubject: claim.capabilitySubject ?? null,
        capabilityObservedOn: claim.capabilityObservedOn ?? null,
        capabilityQualifier: claim.capabilityQualifier ?? null,
        capabilityBasis: claim.capabilityBasis ?? null,
        capabilityAmountLowMinor: claim.capabilityAmountLowMinor ?? null,
        capabilityAmountHighMinor: claim.capabilityAmountHighMinor ?? null,
        capabilityCurrency: claim.capabilityCurrency ?? null,
        /*
         * And the dealflow declaration, for the reason directly above — which
         * this mapper then proved by omission.
         *
         * The unit suite wrote these fields straight into the claims table and
         * passed; the walk that submits through `brain_submit_claims` found
         * every one of them arriving as NULL, because the validator ran, the
         * tool accepted the claim, the insert had the columns, and *this*
         * mapper stood between them carrying only what it had been told about.
         * §33's defect one layer along and with the same signature: a healthy
         * worker, a healthy submission, a healthy row, and the one column that
         * decides whether anything is created silently empty.
         */
        dealFinding: claim.dealFinding ?? null,
        dealSubject: claim.dealSubject ?? null,
        dealEquipment: claim.dealEquipment ?? null,
        dealJurisdiction: claim.dealJurisdiction ?? null,
        dealValue: claim.dealValue ?? null,
        dealAmountCents: claim.dealAmountCents ?? null,
        dealCurrency: claim.dealCurrency ?? null,
        /*
         * And the puzzle declaration — written here *because* of the paragraph
         * directly above, rather than discovered the same way a second time.
         *
         * §45 records the dealflow axis arriving at the tool, passing the
         * validator, having its columns in the insert, and landing NULL on
         * every row because this mapper carried only what it had been told
         * about. The unit suite could not see it, because a unit suite writes
         * the columns directly; only a walk that submits over the wire can.
         * Seven fields, whole, and the walk in
         * `tests/puzzleIntegrationPass.test.ts` submits through
         * `brain_submit_claims` for exactly this reason.
         */
        puzzleFinding: claim.puzzleFinding ?? null,
        puzzleSubject: claim.puzzleSubject ?? null,
        puzzleFormat: claim.puzzleFormat ?? null,
        puzzleProductClass: claim.puzzleProductClass ?? null,
        puzzleValue: claim.puzzleValue ?? null,
        puzzleAmountCents: claim.puzzleAmountCents ?? null,
        puzzleCurrency: claim.puzzleCurrency ?? null,
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
  /**
   * What the verifier evaluated, per dimension the fragment declared.
   *
   * Stored beside the verdict rather than instead of it, so a rejection a
   * month later says *which* declared value the claim was judged against
   * rather than only that it did not match. Required at submission by
   * `scopeAnswerRefusal`; optional on this type because the fixture replay and
   * the historical rows have none.
   */
  scopeBasis?: ClaimScopeBasis;
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
      scopeBasis: verification.scopeBasis ?? {},
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
      // The verdict and what it was judged against, together. A reader of a
      // rejection needs both: "population does not match" answers nothing
      // without the population it was compared with.
      scopeMatch: (() => {
        const verdict = verdicts.get(judgement.claimId);
        if (!verdict) return null;
        const basis = verdict.scopeBasis ?? {};
        return Object.keys(basis).length > 0
          ? { ...verdict.scopeMatch, basis }
          : verdict.scopeMatch;
      })(),
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

  /*
   * Accepted evidence moves the coverage matrix, and it must do so on **every**
   * path that can accept a fragment.
   *
   * `reconcileAcceptedFragment` existed, was tested, and had exactly one
   * caller: the in-process orchestrator. The worker-driven packet runner — the
   * only path production actually uses — never called it, so a requirement
   * whose fragment had cleared all seven gate conditions still read
   * `coverage MISSING` for ever. Production shows it on a `COMPLETE` packet
   * whose one fragment is `ACCEPTED`, which is a person-facing status
   * contradicting the rows the auditor read. §24's own sentence again: a
   * mechanism nothing calls is not a mechanism.
   *
   * It belongs here rather than at either caller because this function is the
   * single place a fragment becomes `ACCEPTED` — a guard on one entrance is
   * not a guard. It re-reads the fragment because the update above changed it,
   * and it is idempotent: the claim reconciliations and the coverage rows are
   * upserts, and `cancelUnnecessaryWork` only ever touches fragments still
   * `QUEUED` or `PLANNED`. So the orchestrator's own call, which additionally
   * needs the contradictions in order to plan fragments for them, stays where
   * it is and costs nothing.
   *
   * It changes no evidence. Nothing here accepts, rejects or re-judges a
   * claim; it records what the accepted claims mean for the requirements they
   * were researched for.
   */
  if (passed) {
    const current = (await getFragment(fragment.id)) ?? fragment;
    await reconcileAcceptedFragment({
      orchestrationId: current.orchestrationId,
      projectId: current.projectId,
      fragment: current,
    });
  }

  return gate;
}
