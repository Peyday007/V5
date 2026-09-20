/**
 * When research has done its job, judged against what the answer is for.
 *
 * ---------------------------------------------------------------------------
 * What this is not
 * ---------------------------------------------------------------------------
 *
 * It is not a second evidence gate. `gate.ts` decides whether a claim may be
 * believed and `standards.ts` decides what that takes per claim type; neither is
 * read here and neither could be affected by anything here. It is not a second
 * audit either: the three roles still argue over the filed report and the judge
 * still records the verdict.
 *
 * It answers the question in between, which nothing answered: **is what we have
 * enough for the decision this packet exists to support?** Before this the
 * stopping rule was "every fragment reached a terminal status", which is a
 * statement about the queue rather than about the answer — a packet could stop
 * with every fragment terminal, half its mandatory requirements open and two
 * claims that cannot both be right, and read as finished.
 *
 * ---------------------------------------------------------------------------
 * Counting activity is not progress
 * ---------------------------------------------------------------------------
 *
 * `readiness` is decisive-uncertainty coverage, not a fragment count and not a
 * source count. A campaign that answered nine peripheral questions and none of
 * the decisive one is further from an answer than one that answered the decisive
 * one alone, and a percentage over fragments says the opposite.
 *
 * It is `null` when there is nothing to measure against, rather than 0 or 100.
 * §29's lesson: "0 of 8 settled" was accurate and read as failure, and the
 * remedy was a named denominator with a state beside it rather than a better
 * fraction.
 */
import { isLive } from './uncertainty.ts';
import type {
  RequirementCoverage,
  Requirement,
  ResearchClaim,
  ResearchFragment,
  ResearchUncertainty,
  ResearchUncertaintyLink,
} from '../../../domain/types.ts';

/**
 * The eight outcomes, which map onto states the packet already has.
 *
 * They are kept as their own vocabulary rather than reusing the orchestration
 * statuses because they answer a different question — *is the answer usable*
 * rather than *is the workflow over* — and the two genuinely differ: a packet
 * can be `AUDITING` and already have a usable answer, and one can be
 * `COMPLETE_WITH_GAPS` over an answer that cannot support its consumer.
 * `packetStatusFor` is the one place they meet.
 */
export const SUFFICIENCY_VERDICTS = [
  'ANSWERED',
  'USABLE_WITH_GAPS',
  'KEEP_RESEARCHING',
  'INSUFFICIENT_EVIDENCE',
  'BLOCKED_BY_ACCESS',
  'CONTRADICTION_OPEN',
  'NEEDS_PERSON',
  'NOT_WORTH_CONTINUING',
] as const;
export type SufficiencyVerdict = (typeof SUFFICIENCY_VERDICTS)[number];

export interface SufficiencyInput {
  uncertainties: ResearchUncertainty[];
  links: ResearchUncertaintyLink[];
  requirements: Requirement[];
  coverage: RequirementCoverage[];
  claims: ResearchClaim[];
  /**
   * The packet's fragments, used only to resolve a claim back to the question
   * it was answering.
   *
   * Passed rather than inferred from `resolvedByFragmentId`, which is set only
   * once a question closes — so reading a contested claim through it would make
   * a disagreement invisible for exactly as long as the question it disagrees
   * about is still open, which is the whole window the refusal exists for.
   */
  fragments: ResearchFragment[];
  /** True when a person authorized this packet to file short. */
  mayRecordGaps: boolean;
}

export interface SufficiencyReading {
  verdict: SufficiencyVerdict;
  /** Why, in one sentence a person can act on. */
  detail: string;
  /** Decisive questions settled, out of decisive questions asked. */
  decisive: { settled: number; total: number };
  /** Mandatory requirements the archive or this packet answers, out of all. */
  mandatory: { covered: number; total: number };
  /** Null when there is nothing to measure. Never a fraction over fragments. */
  readiness: number | null;
  /** What is still in the way, named rather than counted. */
  blockers: string[];
}

/**
 * Whether more looking could still change the decision.
 *
 * A question whose answer cannot move the outcome is not worth the allowance,
 * and saying so is a stopping condition rather than a saving: §16 is explicit
 * that a budget must never masquerade as epistemic sufficiency, so this reads
 * only what bears on the decision and never how much has been spent.
 */
function couldStillChangeTheDecision(
  uncertainty: ResearchUncertainty,
  links: ResearchUncertaintyLink[],
): boolean {
  if (uncertainty.invalidating) return true;
  if (uncertainty.consequence === 'CRITICAL' || uncertainty.consequence === 'HIGH') return true;
  // Something else is blocked on it, so it is load-bearing whatever its own
  // consequence says.
  return links.some(
    (link) =>
      link.fromKey === uncertainty.uncertaintyKey &&
      (link.kind === 'HARD_PREREQUISITE' || link.kind === 'CONDITIONAL'),
  );
}

export function assessSufficiency(input: SufficiencyInput): SufficiencyReading {
  const { uncertainties, links, requirements, coverage, claims } = input;

  const decisiveAll = uncertainties.filter(
    (one) => one.invalidating || one.consequence === 'CRITICAL' || one.consequence === 'HIGH',
  );
  const decisiveSettled = decisiveAll.filter((one) => one.disposition === 'RESOLVED');
  const live = uncertainties.filter(isLive);

  const mandatory = requirements.filter(
    (requirement) => requirement.necessity === 'MANDATORY' && requirement.kind === 'RESEARCH',
  );
  const coverageByRequirement = new Map(coverage.map((row) => [row.requirementId, row]));
  const settledKeys = new Set(
    uncertainties
      .filter((one) => one.disposition === 'RESOLVED')
      .map((one) => one.consumerRef ?? '')
      .filter(Boolean),
  );
  const mandatoryCovered = mandatory.filter((requirement) => {
    if (settledKeys.has(requirement.id)) return true;
    const row = coverageByRequirement.get(requirement.id);
    return row ? !row.needsResearch : false;
  });

  const blockers: string[] = [];

  // A live disagreement outranks everything else that could be said about the
  // packet. Synthesizing over two claims that cannot both be right is the one
  // outcome an audit cannot repair afterwards, because the report would already
  // have chosen.
  const contested = claims.filter(
    (claim) =>
      claim.accepted &&
      (claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED'),
  );
  const challenges = new Set(
    links.filter((link) => link.kind === 'CHALLENGES').map((link) => link.toKey),
  );
  const keyForFragment = new Map(
    input.fragments.map((fragment) => [fragment.id, fragment.fragmentKey]),
  );
  const contestedKeys = new Set(
    contested
      .map((claim) => (claim.fragmentId ? keyForFragment.get(claim.fragmentId) : undefined))
      .filter((key): key is string => Boolean(key)),
  );
  const unchallenged = uncertainties.filter(
    (one) => contestedKeys.has(one.uncertaintyKey) && !challenges.has(one.uncertaintyKey),
  );

  const accessBlocked = uncertainties.filter(
    (one) =>
      isLive(one) && (one.dispositionReason ?? '').toLowerCase().includes('could not be opened'),
  );

  const personOnly = uncertainties.filter((one) => one.disposition === 'PERSON_ONLY');

  const decisiveOpen = decisiveAll.filter(isLive);
  const decisiveFailed = decisiveAll.filter(
    (one) => one.disposition === 'UNRESOLVABLE' || one.disposition === 'REFUTED',
  );

  const readiness =
    decisiveAll.length === 0
      ? mandatory.length === 0
        ? null
        : Math.round((mandatoryCovered.length / mandatory.length) * 100)
      : Math.round((decisiveSettled.length / decisiveAll.length) * 100);

  const reading = (verdict: SufficiencyVerdict, detail: string): SufficiencyReading => ({
    verdict,
    detail,
    decisive: { settled: decisiveSettled.length, total: decisiveAll.length },
    mandatory: { covered: mandatoryCovered.length, total: mandatory.length },
    readiness,
    blockers,
  });

  if (contested.length > 0 && unchallenged.length > 0) {
    blockers.push(
      `${contested.length} accepted claim(s) are contested and ${unchallenged.length} of the ` +
        'questions they answer have no challenge work.',
    );
    return reading(
      'CONTRADICTION_OPEN',
      'Credible sources disagree on something this packet relies on, and nothing has ' +
        'investigated the disagreement yet.',
    );
  }

  if (personOnly.length > 0) {
    blockers.push(`${personOnly.length} question(s) genuinely need a person.`);
    return reading(
      'NEEDS_PERSON',
      'Something here is not research: it needs a decision, a consent or a credential only a ' +
        'person can give.',
    );
  }

  if (decisiveOpen.length > 0) {
    blockers.push(`${decisiveOpen.length} decisive question(s) still open.`);
    return reading(
      'KEEP_RESEARCHING',
      `${decisiveOpen.length} question(s) that could change the outcome are still open.`,
    );
  }

  if (accessBlocked.length > 0) {
    blockers.push(`${accessBlocked.length} question(s) are waiting on a source nobody could open.`);
    return reading(
      'BLOCKED_BY_ACCESS',
      'What is missing is reachable evidence rather than an answer: sources exist and could ' +
        'not be opened.',
    );
  }

  // Everything decisive is settled one way or another. What remains decides
  // between an answer, an honest short answer, and a stop.
  const stillWorthIt = live.filter((one) => couldStillChangeTheDecision(one, links));
  if (decisiveFailed.length > 0) {
    blockers.push(
      `${decisiveFailed.length} decisive question(s) could not be established.`,
    );
    return input.mayRecordGaps
      ? reading(
          'USABLE_WITH_GAPS',
          `${decisiveFailed.length} decisive question(s) could not be established. The answer is ` +
            'usable only if the reader is told which, and a person authorized filing short.',
        )
      : reading(
          'INSUFFICIENT_EVIDENCE',
          `${decisiveFailed.length} decisive question(s) could not be established and nobody has ` +
            'authorized filing short, so the packet must not claim an answer.',
        );
  }

  if (mandatory.length > 0 && mandatoryCovered.length < mandatory.length) {
    const short = mandatory.length - mandatoryCovered.length;
    blockers.push(`${short} mandatory requirement(s) are not covered.`);
    return reading(
      input.mayRecordGaps ? 'USABLE_WITH_GAPS' : 'KEEP_RESEARCHING',
      `${short} mandatory part(s) of the goal are still unanswered.`,
    );
  }

  if (stillWorthIt.length === 0 && live.length > 0) {
    return reading(
      'NOT_WORTH_CONTINUING',
      `${live.length} question(s) are still open and none of them could change the decision, ` +
        'so further research would spend the allowance to learn something nobody would act on.',
    );
  }

  if (live.length > 0) {
    return reading('KEEP_RESEARCHING', `${live.length} question(s) still open.`);
  }

  return reading(
    'ANSWERED',
    'Every decisive question is settled and every mandatory part of the goal is covered.',
  );
}

/**
 * Whether the packet may proceed to synthesis on this reading.
 *
 * Deliberately narrow, and deliberately only ever a **refusal**. It cannot make
 * a packet ready — `assessPacket`'s mandatory-coverage check still decides that
 * and is untouched — and the one thing it adds is the refusal that check
 * computed and nothing read: a live disagreement, or a question that needs a
 * person. Both are conditions an audit cannot repair after the fact, because by
 * then the report has already chosen.
 */
export function mayProceedToSynthesis(reading: SufficiencyReading): {
  ok: boolean;
  because: string | null;
} {
  if (reading.verdict === 'CONTRADICTION_OPEN' || reading.verdict === 'NEEDS_PERSON') {
    return { ok: false, because: reading.detail };
  }
  return { ok: true, because: null };
}
