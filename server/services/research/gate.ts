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
import { countIndependentSources, duplicateGroups, effectiveStandard } from './standards.ts';

/** Which of the seven a claim or fragment fell at. */
export const GATE_CONDITIONS = {
  SOURCE_URL: 'Every material claim has a canonical source URL',
  SOURCE_SUPPORTS: 'The source directly supports the claim',
  LOCATOR: 'The exact passage, table or locator is preserved',
  SCOPE_MATCH: 'Scope, date, geography and definitions match',
  CONTRADICTIONS: 'Contradictions are resolved or explicitly retained',
  COVERAGE: 'Required evidence lanes meet their coverage threshold',
  DERIVATIONS: 'Unsupported calculations and assumptions are rejected',
  CLAIM_STANDARD: 'The claim meets the evidence standard for its own type',
  INDEPENDENCE: 'Corroborating sources are genuinely independent',
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
  /**
   * Claims whose source could not be read, named so the report can say what
   * was not checked. Neither accepted nor rejected: the gate has no verdict on
   * evidence nobody could open.
   */
  unresolvedRetrieval: { claimId: string; claim: string; sourceUrl: string | null; state: string }[];
  claims: ClaimJudgement[];
  acceptedClaims: number;
  rejectedClaims: number;
  independentSources: number;
  coverage: LaneCoverage[];
  /** Sources that turned out to be the same source. Reported, not hidden. */
  duplicateSourceGroups: { group: string; claimIds: string[]; publishers: string[] }[];
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

    // The standard for the claim's own type. A statutory fact needs one
    // authoritative source; a self-report needs somebody other than the
    // organisation; a market-scale quantity from a secondary source needs
    // corroboration that is not a copy of the same estimate.
    const standard = effectiveStandard(claim);
    if (standard.minIndependentSources > 1) {
      const corroborating = claims.filter(
        (other) =>
          other.id !== claim.id &&
          other.sourced &&
          !other.derived &&
          sameSubject(other, claim) &&
          (other.sourceGroup ?? '') !== (claim.sourceGroup ?? ''),
      );
      if (corroborating.length + 1 < standard.minIndependentSources) {
        reject(
          claim,
          claim.claimType === 'SELF_REPORT' ? 'CLAIM_STANDARD' : 'INDEPENDENCE',
          standard.rationale,
        );
        continue;
      }
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
  // Independence is counted by source group rather than by hostname: three wires
  // carrying one press release are one source, and so are four pages citing the
  // same upstream estimate.
  const independentSources = countIndependentSources(acceptedList);
  const duplicates = duplicateGroups(acceptedList);

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

  /**
   * Claims whose source could not be read at all.
   *
   * Neither accepted nor rejected, because neither is true of them: nobody
   * judged the evidence, so the gate has no verdict to give. They are carried
   * out of here by name so the report can say what was not checked.
   *
   * Keeping them out of the rejection rate is the point. Paywalls, robots
   * exclusions, JavaScript shells and dead links are ordinary — the archive's
   * best research run hit all four and named fourteen items it could not
   * resolve. Scoring those as rejections is what pushes a fragment past the
   * majority-rejected line and fails it for untrustworthy sourcing, which is
   * the opposite of what happened.
   */
  const unretrieved = claims.filter((claim) => claim.retrievalState !== 'RETRIEVED');

  const uncoveredLanes = coverage.filter((lane) => !lane.meetsThreshold);
  /**
   * How many independent sources this fragment actually needs.
   *
   * `standards.ts` already decides this per claim, and decides it correctly:
   * one directly inspected primary source settles a statutory fact, an
   * organisation's own statement about itself needs a second source
   * independent of it, a disputed estimate needs two. The fragment then
   * applied a flat number the planner had declared up front, before anyone
   * knew what kind of claims the answer would consist of.
   *
   * That flat number is what failed three fragments of the first live packet
   * whose integrity had passed: each had a directly-quoted statute, which is
   * sufficient by the standard for what it was claiming, and insufficient by a
   * number chosen before the research happened.
   *
   * So the floor is derived from the claims that survived, and the planner's
   * declaration is deliberately *not* consulted as a second floor; see below.
   */
  const derivedFloor = acceptedList.reduce(
    (highest, claim) => Math.max(highest, effectiveStandard(claim).minIndependentSources),
    0,
  );

  /**
   * The higher of the two, so each can only ever raise the bar.
   *
   * An earlier version of this fix took the derived floor *alone* and dropped
   * the fragment's declaration entirely. That fixed the live regression and
   * broke something real: §12 says a fragment's declarations are what the gate
   * is applied against, so a fragment that deliberately asks for two
   * independent sources must get two. Ignoring it would let two pages of one
   * press release satisfy a question whose whole difficulty is that publishers
   * disagree.
   *
   * The declaration was only ever wrong because the *planner* declared 2 for
   * every MISSING requirement before it could know what would answer it, and
   * the schema refused anything lower. Both of those are now fixed where the
   * number is produced, which is where a wrong default belongs. What is left
   * here is the honest rule: the assignment's bar, or the bar the evidence's
   * own claim types demand, whichever is higher.
   *
   * With no accepted claims the derived floor is 0 and the fragment fails on
   * being empty, a line above, with a clearer reason than an arithmetic one.
   */
  const requiredSources = Math.max(fragment.minIndependentSources, derivedFloor);
  const enoughSources = independentSources >= requiredSources;
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
  const judged = results.length;
  const rejectionRate = judged === 0 ? 1 : (judged - acceptedList.length) / judged;
  const mostlyRejected = judged >= 2 && rejectionRate > 0.5;

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

  if (unretrieved.length > 0) {
    reasons.push(
      `${unretrieved.length} claim(s) could not be checked because their source could not be ` +
        'read; they are recorded as unresolved rather than refused.',
    );
  }
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
          `The accepted claims rest on ${independentSources} independent source(s), below the ` +
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
    unresolvedRetrieval: unretrieved.map((claim) => ({
      claimId: claim.id,
      claim: claim.claim,
      sourceUrl: claim.sourceUrl,
      state: claim.retrievalState,
    })),
    claims: results,
    acceptedClaims: acceptedList.length,
    rejectedClaims: results.length - acceptedList.length,
    independentSources,
    duplicateSourceGroups: duplicates,
    coverage,
    failedConditions: [...failedConditions],
    reasons,
    unresolvedGaps: verification.unresolvedGaps,
  };
}

/**
 * Whether two claims are about the same thing, for corroboration.
 *
 * Deliberately crude — shared distinctive words — because the alternative is
 * asking a model whether two sentences agree, and a wrong answer there would
 * manufacture corroboration that does not exist. Being too strict costs an extra
 * research pass; being too loose costs the reader their trust.
 */
function sameSubject(a: ResearchClaim, b: ResearchClaim): boolean {
  if (a.evidenceLane && b.evidenceLane && a.evidenceLane === b.evidenceLane) return true;
  const words = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 4),
    );
  const left = words(a.claim);
  const right = words(b.claim);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.4;
}

/** A fragment contributes to synthesis only when both verdicts are good. */
export function fragmentPasses(result: GateResult): boolean {
  return result.integrity === 'PASS' && result.sufficiency === 'SUFFICIENT';
}
