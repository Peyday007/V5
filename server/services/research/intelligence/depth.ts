/**
 * How hard to look, decided per question rather than once per Brain.
 *
 * §14 already settled the neighbouring question and must not be confused with
 * this one. `standards.ts` decides **what it takes for one claim to be
 * believed** — one directly inspected primary source settles a statutory fact,
 * an organisation's own site is worth nothing as independent confirmation, a
 * forecast is never a fact. That is a property of the claim and is untouched
 * here.
 *
 * This decides **how much looking a question deserves before stopping**, which
 * is a property of what rides on the answer. The two were conflated by a single
 * `minIndependentSourcesFloor` applied to every fragment a compiled mission
 * produced, so a question that could wreck the whole path and a question whose
 * answer changes nothing were investigated to exactly the same depth.
 *
 * Three rungs, not a number. A number invites arithmetic — a weighted score
 * over inputs nobody calibrated, reading like a measurement. The rungs are
 * ordered and that is all the arithmetic there is.
 *
 * **It can raise a bar and it can never lower one.** `SINGLE_PRIMARY` is
 * reachable only for a claim type §14 already says one primary source settles,
 * and the fragment's own declared minimum still binds wherever it is higher —
 * `floorFor` takes the maximum. A depth allocator that could reduce an evidence
 * requirement would be a budget wearing an evidence bar's clothes, which is
 * exactly what §16 says a quota may never become.
 */
import type {
  ClaimType,
  ResearchDepth,
  ResearchReversibility,
  ResearchStakes,
} from '../../../domain/types.ts';

/** Ordered weakest to strongest. Comparison is by index and nothing else. */
export const DEPTH_ORDER: readonly ResearchDepth[] = [
  'SINGLE_PRIMARY',
  'CORROBORATED',
  'CONTESTED_DEEP',
];

export function strongerDepth(a: ResearchDepth, b: ResearchDepth): ResearchDepth {
  return DEPTH_ORDER.indexOf(a) >= DEPTH_ORDER.indexOf(b) ? a : b;
}

/**
 * Claim types a single directly inspected primary source settles.
 *
 * Taken from §14's own examples rather than invented: a statute says what it
 * says, and requiring a second publisher to confirm the text of a law is
 * requiring somebody else to have republished it. Everything not on this list
 * is ordinary and gets the ordinary bar.
 */
const SETTLED_BY_ONE_PRIMARY: readonly string[] = [
  'STATUTORY',
  'REGULATORY',
  'LEGAL',
  'DEFINITIONAL',
  'DOCUMENTARY',
  'ORGANIZATIONAL_SELF_DESCRIPTION',
];

export interface DepthInput {
  consequence: ResearchStakes;
  reversibility: ResearchReversibility;
  /** Could a wrong answer make the whole path pointless? */
  invalidating: boolean;
  /** Sources that already disagree on this question, as a count of claims. */
  conflictingClaims: number;
  /** What kind of thing the answer will be, when the plan says. */
  expectedClaimTypes: readonly (ClaimType | string)[];
}

export interface DepthDecision {
  depth: ResearchDepth;
  /** The sentence recorded on the uncertainty. Says which input decided it. */
  basis: string;
}

/**
 * The rung, and the one input that decided it.
 *
 * Deliberately a cascade rather than a score, so the basis names a real reason
 * a reader can check instead of a number they cannot.
 */
export function allocateDepth(input: DepthInput): DepthDecision {
  // A live disagreement outranks everything. Two credible sources that cannot
  // both be right is the one condition where more looking is certain to be
  // worth something, whatever the stakes are.
  if (input.conflictingClaims > 0) {
    return {
      depth: 'CONTESTED_DEEP',
      basis:
        `${input.conflictingClaims} claim(s) on this question already disagree, so the ` +
        'disagreement has to be modelled rather than averaged away.',
    };
  }

  if (input.invalidating) {
    return {
      depth: 'CONTESTED_DEEP',
      basis:
        'A wrong answer here would make the rest of the path pointless, so it is worth more ' +
        'than the ordinary bar.',
    };
  }

  if (input.consequence === 'CRITICAL' || input.reversibility === 'IRREVERSIBLE') {
    return {
      depth: 'CONTESTED_DEEP',
      basis:
        input.consequence === 'CRITICAL'
          ? 'The consequence of being wrong is critical.'
          : 'Acting on this is irreversible, so being wrong cannot be corrected later.',
    };
  }

  // The one downgrade, and it is §14's rule rather than a saving. It needs the
  // plan to have said what kind of claim will answer this, every one of them to
  // be a kind one primary source settles, and nothing much to ride on it.
  const stated = input.expectedClaimTypes.map((type) => String(type).toUpperCase());
  const allPrimary =
    stated.length > 0 && stated.every((type) => SETTLED_BY_ONE_PRIMARY.includes(type));
  if (allPrimary && input.consequence === 'LOW' && input.reversibility === 'REVERSIBLE') {
    return {
      depth: 'SINGLE_PRIMARY',
      basis:
        'One directly inspected primary source settles this kind of claim, and little rides ' +
        'on it, so corroboration would buy nothing.',
    };
  }

  return {
    depth: 'CORROBORATED',
    basis: 'Nothing about this question earns more or less than the ordinary bar.',
  };
}

/**
 * The independent-source minimum a depth implies — as a floor under the
 * fragment's own, never a replacement for it.
 *
 * The caller takes `Math.max` of this and whatever the plan declared. That
 * direction is the whole safety argument: this module can make a question
 * harder to close and can never make one easier.
 */
export function floorFor(depth: ResearchDepth): number {
  switch (depth) {
    case 'SINGLE_PRIMARY':
      return 1;
    case 'CONTESTED_DEEP':
      return 3;
    case 'CORROBORATED':
    default:
      return 2;
  }
}
