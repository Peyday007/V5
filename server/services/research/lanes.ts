/**
 * Which declared question a claim answers.
 *
 * A fragment declares its evidence lanes up front — `requiredEvidence` — and
 * the gate asks, per lane, whether any accepted claim filled it. A lane with
 * nothing in it is a question the fragment did not answer, whatever else it
 * found. That rule is right and it is not changing.
 *
 * What was missing is that nothing made the worker *say* which lane a claim
 * fills. `evidence_lane` was optional, absent read as null, and null matches no
 * lane — so a fragment could return correct, sourced, in-scope, verified claims
 * and fail its coverage check on a missing string. The first fresh acceptance
 * packet did exactly that, across all five states, twice each: 56 claims that
 * passed integrity and scope, and not one lane covered.
 *
 * Two things follow, and both are in this file so they cannot drift apart:
 *
 * - **A claim with no lane, or a lane the fragment never declared, is refused
 *   at submission** — before anything is stored, before verification, and
 *   before the attempt is spent. Metadata Brain requires and did not collect is
 *   Brain's fault, and it must not cost the worker a research attempt.
 * - **An untagged claim is reported as untagged**, never as missing evidence.
 *   The repair planner told the second attempt "no accepted evidence in:
 *   statute" when the statute had been quoted and simply not labelled, so the
 *   repair went looking for evidence it already held. A repair aimed at the
 *   wrong failure is worse than no repair: it spends an attempt to reproduce
 *   the same result.
 */
import type { ResearchClaim, ResearchFragment, RetrievalState } from '../../domain/types.ts';
import { laneIds } from '../../domain/evidenceLanes.ts';
import { validateClaim, type RawClaim } from './sources.ts';

/** What a claim has to carry for the gate to be able to place it. */
export interface LaneCandidate extends RawClaim {
  evidenceLane: string | null;
  retrievalState?: RetrievalState;
}

/**
 * Whether this claim has to name a lane.
 *
 * Only claims that could actually be accepted, because a lane is a statement
 * about *coverage* and coverage counts accepted claims. Requiring it more
 * widely would break two controls this platform deliberately has:
 *
 * - **An unsourced claim is kept, marked, rather than dropped.** The ledger is
 *   supposed to record what the research could not source; that is one of the
 *   more useful things it says. A claim with no usable source can never be
 *   accepted and so can never fill a lane, so demanding one buys nothing and
 *   creates a reason to leave it out.
 * - **A source nobody could read is recorded as unresolved.** It is neither
 *   accepted nor rejected and is excluded from the gate's counts, for the same
 *   reason and with the same consequence.
 *
 * `validateClaim` is the authority on "sourced" everywhere else, so it is the
 * authority here too — a second opinion about what counts as evidence is how
 * the two drift apart.
 */
export function laneRequired(claim: LaneCandidate): boolean {
  if ((claim.retrievalState ?? 'RETRIEVED') !== 'RETRIEVED') return false;
  return validateClaim(claim).sourced;
}

export interface LaneProblem {
  index: number;
  claim: string;
  given: string | null;
  why: 'MISSING' | 'UNDECLARED';
}

/**
 * Every claim whose lane the fragment cannot place, with which of the two
 * mistakes it is.
 *
 * Both are refusals, and they are separated because they need different
 * corrections: one is a field the worker left out, the other is a value that
 * belongs to a different fragment's vocabulary.
 */
export function laneProblems(
  fragment: Pick<ResearchFragment, 'requiredEvidence'>,
  claims: LaneCandidate[],
): LaneProblem[] {
  // Ids, not descriptions. A claim names the lane it fills by its identifier;
  // the description is the question, and matching on it is what made a worker
  // reproduce 160 characters exactly for its evidence to count.
  const declared = new Set(laneIds(fragment.requiredEvidence));
  const problems: LaneProblem[] = [];
  claims.forEach((claim, index) => {
    const lane = claim.evidenceLane;
    if (lane === null || lane.length === 0) {
      // Only where the claim could have been accepted. See `laneRequired`.
      if (laneRequired(claim)) {
        problems.push({ index, claim: claim.claim, given: lane, why: 'MISSING' });
      }
      return;
    }
    if (!declared.has(lane)) {
      problems.push({ index, claim: claim.claim, given: lane, why: 'UNDECLARED' });
    }
  });
  return problems;
}

/** Said to the worker when a submission is refused, and it has to teach. */
export function explainLaneProblems(
  fragment: Pick<ResearchFragment, 'requiredEvidence' | 'fragmentKey'>,
  problems: LaneProblem[],
): string {
  const allowed = fragment.requiredEvidence.map((lane) => `"${lane.id}" (${lane.description})`)
    .join('; ');
  const missing = problems.filter((problem) => problem.why === 'MISSING');
  const undeclared = problems.filter((problem) => problem.why === 'UNDECLARED');
  const parts: string[] = [];

  parts.push(
    `Every claim must say which of this fragment's declared evidence lanes it fills. ` +
      `Fragment "${fragment.fragmentKey}" declares: ${allowed}. Set "evidence_lane" to one of ` +
      'those **ids** — the short identifier in quotes, never the description after it. ' +
      '`brain_get_assignment` returns the ids as `evidenceLaneIds` and each lane in full as ' +
      '`requiredEvidence`.',
  );

  if (missing.length > 0) {
    parts.push(
      `${missing.length} claim(s) have no evidence_lane: ` +
        missing.map((problem) => `claims[${problem.index}]`).join(', ') +
        '.',
    );
  }
  if (undeclared.length > 0) {
    parts.push(
      `${undeclared.length} claim(s) name a lane this fragment did not declare: ` +
        undeclared
          .map((problem) => `claims[${problem.index}] gave "${problem.given ?? ''}"`)
          .join('; ') +
        '.',
    );
  }

  parts.push(
    'This applies to claims that could be accepted. A claim with no usable source, or one whose ' +
      'source you could not read, is still submitted without a lane and is still kept — it is ' +
      'recorded as unsourced or unresolved rather than dropped, and it fills no lane either way.',
  );
  parts.push(
    'Nothing was stored and no attempt was spent, so fix the lanes and submit the same claims ' +
      'again on this same work item. If a claim genuinely fills none of the declared lanes it ' +
      'does not belong to this fragment: leave it out and use brain_report_blocker to say the ' +
      'fragment needs a lane it does not have, rather than labelling it with a lane it does not fill.',
  );
  return parts.join(' ');
}

/**
 * Accepted claims that carry no lane at all.
 *
 * The repair planner's question, and a different one from "which lanes are
 * empty": a fragment whose lanes are all empty *because nothing was tagged*
 * has an evidence problem it does not have, and telling it to search again is
 * telling it to solve the wrong one.
 */
export function untaggedAccepted(claims: Pick<ResearchClaim, 'accepted' | 'evidenceLane'>[]): number {
  return claims.filter((claim) => claim.accepted && !claim.evidenceLane).length;
}
