/**
 * The evidence gate.
 *
 * A fragment does not contribute a single claim to the synthesis until it has
 * passed all seven of these, and every one of them is checked here rather than
 * asserted by the model that produced the work:
 *
 *   1. every material claim has a canonical source URL
 *   2. the source directly supports the claim
 *   3. the exact passage, table or locator is preserved
 *   4. scope, date, geography and definitions match the fragment's
 *   5. contradictions are resolved or explicitly retained
 *   6. the required evidence lanes meet their coverage threshold
 *   7. unsupported calculations and assumptions are rejected
 *
 * Two of these are judgements only a reader of the source can make — whether it
 * supports the claim (2), and whether the scope lines up (4) — so they come from
 * a separate verification pass whose answer is recorded per claim. Brain's job
 * is to insist that the answer exists, is structured, and is applied without
 * exception. The other five are facts about the ledger, and are computed.
 *
 * A rejected claim keeps its rejection reason forever. That is what stops it
 * reappearing in a later attempt's synthesis: acceptance is decided once, at the
 * gate, against the evidence as it stood.
 */
import type { ResearchClaim, ResearchFragment } from '../../domain/types.ts';
import type { ClaimScopeMatch } from './schema.ts';

/** Which of the seven a claim or fragment fell at. */
export const GATE_CONDITIONS = {
  SOURCE_URL: 'Every material claim has a canonical source URL',
  SOURCE_SUPPORTS: 'The source directly supports the claim',
  LOCATOR: 'The exact passage, table or locator is preserved',
  SCOPE_MATCH: 'Scope, date, geography and definitions match',
  CONTRADICTIONS: 'Contradictions are resolved or explicitly retained',
  COVERAGE: 'Required evidence lanes meet their coverage threshold',
  DERIVATIONS: 'Unsupported calculations and assumptions are rejected',
} as const;

export type GateCondition = keyof typeof GATE_CONDITIONS;

export interface ClaimJudgement {
  claimId: string;
  accepted: boolean;
  failedCondition: GateCondition | null;
  reason: string | null;
}

export interface LaneCoverage {
  lane: string;
  acceptedClaims: number;
  independentSources: number;
  meetsThreshold: boolean;
}

export interface GateResult {
  integrity: 'PASS' | 'FAIL';
  sufficiency: 'SUFFICIENT' | 'INSUFFICIENT';
  claims: ClaimJudgement[];
  acceptedClaims: number;
  rejectedClaims: number;
  independentSources: number;
  coverage: LaneCoverage[];
  failedConditions: GateCondition[];
  /** Sentences a person can act on, not a dump of the working. */
  reasons: string[];
  unresolvedGaps: string[];
}

export interface VerificationInput {
  /** Per-claim verdicts from the verification pass, keyed by claim id. */
  verdicts: Map<string, { supportsClaim: boolean; scopeMatch: ClaimScopeMatch; note: string }>;
  sufficiency: 'SUFFICIENT' | 'INSUFFICIENT';
  missingLanes: string[];
  unresolvedGaps: string[];
}

/**
 * The registrable domain of a URL, near enough for independence.
 *
 * Two pages on the same site are one source. This deliberately treats
 * `data.gov.uk` and `www.gov.uk` as different — over-counting a corroboration is
 * the lesser error against a fragment silently resting on one publisher.
 */
export function sourceIdentity(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function scopeFailures(scope: ClaimScopeMatch, fragment: ResearchFragment): string[] {
  const failures: string[] = [];
  // Only dimensions the fragment actually declared are enforced. A fragment that
  // named no timeframe cannot fail a claim for not matching one.
  if (fragment.geography && scope.geography !== 'MATCH') {
    failures.push(`geography (${scope.geography.toLowerCase()} vs "${fragment.geography}")`);
  }
  if (fragment.timeframe && scope.timeframe !== 'MATCH') {
    failures.push(`timeframe (${scope.timeframe.toLowerCase()} vs "${fragment.timeframe}")`);
  }
  if (fragment.population && scope.population !== 'MATCH') {
    failures.push(`population (${scope.population.toLowerCase()} vs "${fragment.population}")`);
  }
  if (fragment.definitions && scope.definitions !== 'MATCH') {
    failures.push(`definitions (${scope.definitions.toLowerCase()})`);
  }
  return failures;
}

/**
 * Judge one fragment's ledger.
 *
 * Claims are judged first and independently; the fragment's own verdicts follow
 * from what survived. Derived claims are judged last, because whether a
 * calculation stands depends on whether its inputs did.
 */
export function applyGate(input: {
  fragment: ResearchFragment;
  claims: ResearchClaim[];
  verification: VerificationInput;
}): GateResult {
  const { fragment, claims, verification } = input;
  const judgements = new Map<string, ClaimJudgement>();
  const reasons: string[] = [];

  const accept = (claim: ResearchClaim): void => {
    judgements.set(claim.id, {
      claimId: claim.id,
      accepted: true,
      failedCondition: null,
      reason: null,
    });
  };
  const reject = (claim: ResearchClaim, condition: GateCondition, reason: string): void => {
    judgements.set(claim.id, { claimId: claim.id, accepted: false, failedCondition: condition, reason });
  };

  const direct = claims.filter((claim) => !claim.derived);
  const derived = claims.filter((claim) => claim.derived);

  for (const claim of direct) {
    // 1 and 3 are already settled by source validation: no URL, an unusable URL
    // or no passage all mean the claim was never evidence.
    if (!claim.sourced) {
      const condition: GateCondition = claim.validationState === 'NO_EVIDENCE' ? 'LOCATOR' : 'SOURCE_URL';
      reject(
        claim,
        condition,
        claim.validationDetail ?? 'The claim has no usable source.',
      );
      continue;
    }

    const verdict = verification.verdicts.get(claim.id);
    if (!verdict) {
      // An unverified claim is not a passing claim. Silence is not support.
      reject(
        claim,
        'SOURCE_SUPPORTS',
        'No verification verdict was returned for this claim, so nothing confirms the source supports it.',
      );
      continue;
    }

    // 2 — the reader of the source says whether it supports the claim.
    if (!verdict.supportsClaim) {
      reject(
        claim,
        'SOURCE_SUPPORTS',
        verdict.note.trim().length > 0
          ? verdict.note
          : 'Verification found the source does not directly support this claim.',
      );
      continue;
    }

    // 4 — the boundaries the fragment declared are the boundaries that apply.
    const mismatches = scopeFailures(verdict.scopeMatch, fragment);
    if (mismatches.length > 0) {
      reject(claim, 'SCOPE_MATCH', `Scope does not match on ${mismatches.join(', ')}.`);
      continue;
    }

    // 5 — a refuted claim is out; a contested one needs somebody to have said
    // what was done about it. "Retained anyway, because …" is a valid answer;
    // saying nothing is not.
    if (claim.contradictionState === 'REFUTED') {
      reject(
        claim,
        'CONTRADICTIONS',
        claim.contradictionNote ?? 'A later pass refuted this claim.',
      );
      continue;
    }
    if (claim.contradictionState === 'CONTESTED' && !(claim.contradictionNote ?? '').trim()) {
      reject(
        claim,
        'CONTRADICTIONS',
        'This claim is contested and no resolution was recorded, so it cannot be relied on.',
      );
      continue;
    }

    accept(claim);
  }

  // 7 — a calculation is only as good as its inputs, and an input that is not
  // itself an accepted claim makes the result an assumption.
  for (const claim of derived) {
    const inputs = claim.derivedFrom;
    if (inputs.length === 0) {
      reject(
        claim,
        'DERIVATIONS',
        'This is a calculation or inference with no stated inputs, which makes it an assumption.',
      );
      continue;
    }
    const missing = inputs.filter((id) => {
      const judgement = judgements.get(id);
      return !judgement || !judgement.accepted;
    });
    if (missing.length > 0) {
      reject(
        claim,
        'DERIVATIONS',
        `${missing.length} of its ${inputs.length} input claim(s) were not accepted, so the ` +
          'calculation rests on unsupported evidence.',
      );
      continue;
    }
    const verdict = verification.verdicts.get(claim.id);
    if (verdict && !verdict.supportsClaim) {
      reject(claim, 'DERIVATIONS', verdict.note || 'Verification rejected this calculation.');
      continue;
    }
    accept(claim);
  }

  const results = [...judgements.values()];
  const acceptedIds = new Set(results.filter((r) => r.accepted).map((r) => r.claimId));
  const acceptedList = claims.filter((claim) => acceptedIds.has(claim.id));

  // 6 — two separate requirements, because the fragment states them separately.
  //
  // Every declared evidence lane must actually be filled: a lane with no accepted
  // claim is a question the fragment did not answer, whatever else it found.
  //
  // And the fragment as a whole must reach its minimum independent sources,
  // counted by publisher rather than by claim — five citations of one page is one
  // source. That is where "do not rest on a single publisher" is enforced;
  // demanding it inside every lane as well would multiply the bar past what any
  // real fragment could clear.
  const allSources = new Set(
    acceptedList.map((claim) => sourceIdentity(claim.sourceUrl)).filter((id): id is string => id !== null),
  );

  const coverage: LaneCoverage[] = fragment.requiredEvidence.map((lane) => {
    const inLane = acceptedList.filter((claim) => claim.evidenceLane === lane);
    const sources = new Set(
      inLane.map((claim) => sourceIdentity(claim.sourceUrl)).filter((id): id is string => id !== null),
    );
    return {
      lane,
      acceptedClaims: inLane.length,
      independentSources: sources.size,
      meetsThreshold: inLane.length > 0,
    };
  });

  const failedConditions = new Set<GateCondition>(
    results.filter((r) => !r.accepted).map((r) => r.failedCondition!).filter(Boolean),
  );

  const uncoveredLanes = coverage.filter((lane) => !lane.meetsThreshold);
  const enoughSources = allSources.size >= fragment.minIndependentSources;
  if (uncoveredLanes.length > 0 || !enoughSources) failedConditions.add('COVERAGE');

  // Integrity is about the claims that survive, not about whether anything was
  // ever rejected. Dropping a bad claim is the gate working; failing the whole
  // fragment for it would throw away good evidence alongside it, and would push
  // toward the wrong fix — a fragment is repaired by finding better sources, not
  // by never having proposed a weak claim.
  //
  // Two things still fail it outright, because neither is a claim-level slip:
  //   - a refuted claim nobody resolved, which says the fragment's own findings
  //     disagree and nobody settled it;
  //   - a majority of claims rejected, which says the sourcing practice cannot
  //     be trusted even where it happened to hold up.
  const refutedUnresolved = claims.some(
    (claim) => claim.contradictionState === 'REFUTED' && !(claim.contradictionNote ?? '').trim(),
  );
  const rejectionRate = results.length === 0 ? 1 : (results.length - acceptedList.length) / results.length;
  const mostlyRejected = results.length >= 2 && rejectionRate > 0.5;

  const integrity: GateResult['integrity'] =
    acceptedList.length > 0 && !refutedUnresolved && !mostlyRejected ? 'PASS' : 'FAIL';

  // Sufficiency is about whether the question got answered to the declared bar.
  // The verification pass's own opinion can only make it worse, never better:
  // coverage is arithmetic, and a pass that says SUFFICIENT over empty lanes is
  // simply wrong.
  const sufficiency: GateResult['sufficiency'] =
    uncoveredLanes.length === 0 && enoughSources && verification.sufficiency === 'SUFFICIENT'
      ? 'SUFFICIENT'
      : 'INSUFFICIENT';

  if (acceptedList.length === 0) {
    reasons.push('No claim in this fragment survived the evidence gate.');
  } else if (mostlyRejected) {
    reasons.push(
      `${results.length - acceptedList.length} of ${results.length} claims were rejected, so the ` +
        'evidence in this fragment cannot be relied on even where it held up.',
    );
  }
  if (refutedUnresolved) {
    reasons.push('A refuted claim was left unresolved, so the fragment contradicts itself.');
  }
  for (const condition of failedConditions) {
    const count = results.filter((r) => r.failedCondition === condition).length;
    if (condition === 'COVERAGE') {
      if (uncoveredLanes.length > 0) {
        reasons.push(
          `${uncoveredLanes.length} required evidence lane(s) have no accepted claim: ` +
            uncoveredLanes.map((lane) => lane.lane).join(', '),
        );
      }
      if (!enoughSources) {
        reasons.push(
          `The accepted claims rest on ${allSources.size} independent source(s), below the ` +
            `${fragment.minIndependentSources} this fragment requires.`,
        );
      }
      continue;
    }
    reasons.push(`${count} claim(s) failed: ${GATE_CONDITIONS[condition].toLowerCase()}.`);
  }
  if (verification.sufficiency === 'INSUFFICIENT' && uncoveredLanes.length === 0) {
    reasons.push(
      'Verification judged the answer incomplete even though every lane is covered: ' +
        (verification.missingLanes.join(', ') || 'see the pass reasoning.'),
    );
  }

  return {
    integrity,
    sufficiency,
    claims: results,
    acceptedClaims: acceptedList.length,
    rejectedClaims: results.length - acceptedList.length,
    independentSources: allSources.size,
    coverage,
    failedConditions: [...failedConditions],
    reasons,
    unresolvedGaps: verification.unresolvedGaps,
  };
}

/** A fragment contributes to synthesis only when both verdicts are good. */
export function fragmentPasses(result: GateResult): boolean {
  return result.integrity === 'PASS' && result.sufficiency === 'SUFFICIENT';
}
