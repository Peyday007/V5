/**
 * Reusable design knowledge: how it is seeded, how it grows, how it is found.
 *
 * ---------------------------------------------------------------------------
 * Why there are seven seed patterns and not seven hundred
 * ---------------------------------------------------------------------------
 *
 * A design encyclopedia loaded before the kernel has looked at anything is the
 * thing the brief forbids and it would be wrong for a reason worth stating: a
 * rule the system did not arrive at has no evidence behind it, so nothing can
 * ever retire it, and the first time it is wrong about this product it will
 * still be applied. §12's sentence about research is the same sentence here —
 * *a report of invented citations is the worst thing this platform could
 * produce* — and a design rule asserted with no source is an invented citation
 * about interfaces.
 *
 * So what is seeded is the handful without which the kernel cannot do its first
 * job at all, and every one of them carries, as its evidence, **a CLAUDE.md
 * section recording an incident in this product**. They are not taste. Each one
 * is a defect this repository has already paid for, written down as the rule
 * that would have caught it.
 *
 * Everything else arrives from operation: a correction the owner made, a piece
 * of research that cleared the evidence gate, or a finding that kept recurring.
 *
 * ---------------------------------------------------------------------------
 * How the taxonomy grows
 * ---------------------------------------------------------------------------
 *
 * `primitive` is one of ten fixed concerns; `branch` is free text. A branch
 * exists because patterns accumulated under it — *dense chronology*, *editorial
 * layout*, *command surfaces* — rather than because somebody predicted it, and
 * `emergingBranches` is how the kernel notices that one has. That is the whole
 * mechanism, and it is deliberately unglamorous: a distinction is real when
 * several pieces of evidence turned out to be about it.
 *
 * ---------------------------------------------------------------------------
 * Confidence is what it rests on, never how good it sounds
 * ---------------------------------------------------------------------------
 *
 * `confidenceFor` counts distinct, *independent* pieces of evidence, and the
 * word independent is doing work: three findings from one cycle are one
 * observation of one screen, not three. §14's rule — *sources that are really
 * one source are counted as one* — applied to a design lesson.
 */
import { createHash } from 'node:crypto';
import type {
  DesignConfidence,
  DesignCorrection,
  DesignPattern,
  DesignPrimitive,
  DesignScope,
} from '../../domain/design.ts';
import { SCOPE_RANK } from '../../domain/design.ts';
import {
  branchCounts,
  listPatterns,
  markCorrectionPromoted,
  upsertPattern,
  type UpsertPatternInput,
} from '../../repos/design.ts';

/**
 * The identity of what a pattern says.
 *
 * Derived from the primitive, the scope and a normalised statement, so the same
 * lesson written twice is one row and the evidence accumulates on it. Derived
 * rather than supplied for `system_components.component_key`'s reason: a caller
 * that could choose it could split one rule in two and make a repetition look
 * like a discovery.
 */
export function patternFingerprint(input: {
  primitive: string;
  scope: string;
  scopeRef: string | null;
  statement: string;
}): string {
  const normalised = input.statement
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256')
    .update(`${input.primitive}|${input.scope}|${input.scopeRef ?? '-'}|${normalised}`)
    .digest('hex')
    .slice(0, 32);
}

type Seed = Omit<UpsertPatternInput, 'fingerprint' | 'state' | 'origin'>;

/**
 * The seed.
 *
 * Every `evidence` entry names a section of CLAUDE.md, which is this repository's
 * own record of what went wrong and what it cost. That is what makes these rules
 * rather than preferences: each one is a real production defect stated as the
 * thing that would have prevented it.
 */
export const SEED_PATTERNS: Seed[] = [
  {
    primitive: 'FEEDBACK',
    branch: 'status and controls',
    statement:
      'A status line must never contradict a control beside it. Where both describe one fact, ' +
      'they read it from one place, and while the answer is unknown the reassuring version is ' +
      'withheld rather than guessed.',
    appliesWhen:
      'Any screen where a sentence summarises something a control on the same screen changes — a ' +
      'count, a badge, an "everything is fine" line, a progress figure.',
    exceptions:
      'A deliberately historical line — "this is what it said last week" — is not a contradiction, ' +
      'provided it says so.',
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'HIGH',
    evidence: [
      'CLAUDE.md §29: the briefing said "You are not needed" directly above an approval that had ' +
        'to be given before anything could run',
      'CLAUDE.md §29: Needs You announced "Nothing needs your decision" while the nav badge beside ' +
        'it read 1, because three readers counted one fact and two had been corrected',
      'CLAUDE.md §33: a card read "Brain looks it up rather than asking you" directly above the ' +
        'control asking',
    ],
  },
  {
    primitive: 'RESPONSIVENESS',
    branch: 'one product at every width',
    statement:
      'Every destination and every capability reachable at the widest layout must be reachable at ' +
      'the narrowest — in one press or in two. A width is an arrangement, never a smaller feature set.',
    appliesWhen: 'Any shell, rail, navigation bar or menu that rearranges itself below a breakpoint.',
    exceptions:
      'A capability that is genuinely impossible on the device — not merely inconvenient — may be ' +
      'absent, and should say why rather than simply not being there.',
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'HIGH',
    evidence: [
      'CLAUDE.md §29: a stylesheet removed the element the phone menu lived in, taking Search, the ' +
        'depth control, Build, Connected sites and Sign out with it — a person on a phone could not ' +
        'sign out of Brain, while every React test of the menu passed',
    ],
  },
  {
    primitive: 'RESPONSIVENESS',
    branch: 'container queries',
    statement:
      'Ask the container how wide it is, not the viewport. A component inside a rail, a drawer or a ' +
      'column has a width its media query knows nothing about.',
    appliesWhen:
      'Any component that can appear in more than one place, or inside anything narrower than the page.',
    exceptions: 'The page shell itself, which genuinely is the viewport.',
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'HIGH',
    evidence: [
      'CLAUDE.md §29: content clipped between 822 and 953 pixels because a media query was asked ' +
        'about the viewport while the element that clipped was a column inside a rail',
    ],
  },
  {
    primitive: 'EMPHASIS',
    branch: 'destructive and expensive actions',
    statement:
      'An action that is rare and costly is visually subordinate until deliberately invoked, and its ' +
      'confirmation is proportional to the consequence. An action that is constant and free is ' +
      'immediate and asks nothing.',
    appliesWhen:
      'Any screen carrying both kinds — which is most of them. Frequency and reversibility decide ' +
      'emphasis together; neither decides it alone.',
    exceptions:
      'An expensive action that is the entire purpose of the screen is primary, and earns its weight ' +
      'from being the only thing there rather than from being loud.',
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'MEDIUM',
    evidence: [
      'CLAUDE.md §27: authorizing a change request starts a campaign that writes commits, and is ' +
        'reserved to a person precisely because it cannot be taken back',
      'CLAUDE.md §24: the standing-authority card arrives prefilled with one Approve, and the ' +
        'detailed controls start hidden',
    ],
  },
  {
    primitive: 'INTERACTION',
    branch: 'controls that pretend',
    statement:
      'A control that cannot succeed is disabled with the reason shown, never removed and never ' +
      'left live. A rendered control that opens nothing is worse than the wrong control.',
    appliesWhen:
      'Anywhere a capability depends on a permission, a precondition or a state — which is where ' +
      'controls are most often quietly dropped.',
    exceptions:
      'A control whose very existence would disclose something the reader may not know about is ' +
      'absent, and that absence is the same for every reader.',
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'HIGH',
    evidence: [
      'CLAUDE.md §33: a decision button drew itself and opened nothing once its branch was removed, ' +
        'and a person presses a dead control twice and concludes the page is broken',
      'CLAUDE.md §35: a control somebody may not use is disabled with the server’s reason rather ' +
        'than removed, because "there is no button" and "the button is not for you yet" read very ' +
        'differently',
    ],
  },
  {
    primitive: 'INFORMATION_HIERARCHY',
    branch: 'leading with the state',
    statement:
      'A screen leads with where things stand and what happens next, and puts the full inventory ' +
      'behind a disclosure that carries its own count — so a person can tell whether opening it is ' +
      'worth it.',
    appliesWhen:
      'Any screen whose underlying material can grow without bound: portfolios, activity, rows of ' +
      'research, event history.',
    exceptions:
      'A screen whose purpose is the inventory — a table somebody came to scan — leads with the table.',
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'MEDIUM',
    evidence: [
      'CLAUDE.md §33: the Cash page was restructured to lead with seven counts, the next step and ' +
        'the best three-to-five openings, with everything else behind a counted disclosure',
    ],
  },
  {
    primitive: 'FEEDBACK',
    branch: 'the four screens',
    statement:
      'Loading, empty, forbidden and error are four different screens. The forbidden one does not ' +
      'claim the thing is absent, and none of them is the absence of a screen.',
    appliesWhen: 'Every surface that fetches anything.',
    exceptions: null,
    scope: 'GLOBAL',
    scopeRef: null,
    confidence: 'HIGH',
    evidence: [
      'CLAUDE.md §24: loading, empty, forbidden and error are four different screens, and the last ' +
        'hop must not invent an answer the server could not give',
    ],
  },
];

/** Write the seed. Idempotent by fingerprint; evidence accumulates. */
export async function seedDesignPatterns(): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  for (const seed of SEED_PATTERNS) {
    const fingerprint = patternFingerprint({
      primitive: seed.primitive,
      scope: seed.scope,
      scopeRef: seed.scopeRef,
      statement: seed.statement,
    });
    const result = await upsertPattern({
      ...seed,
      origin: 'SEED',
      /*
       * ACTIVE on arrival, unlike everything else, and the asymmetry is the
       * point: a seed is a rule somebody reviewed in a code change, which is the
       * bar §29 puts on `PREFERENCES` and §16 on an approval envelope. A pattern
       * the kernel compiles for itself starts PROPOSED and has to earn its way
       * across.
       */
      state: 'ACTIVE',
      fingerprint,
    });
    (result.created ? created : updated).push(fingerprint);
  }
  return { created, updated };
}

/**
 * The patterns that apply to one place, strongest first.
 *
 * "Applies" is a scope question and nothing else — a `COMPONENT` pattern reaches
 * a screen that contains the component, a `SCREEN` pattern reaches that screen,
 * a `FACULTY` pattern reaches everything in the faculty, and `GLOBAL` reaches
 * everything. There is deliberately no relevance scoring: §33 records what a
 * coverage score whose denominator is the question actually measures, and a
 * design rule retrieved by keyword overlap would be retrieved by how it was
 * worded.
 */
export async function patternsInScope(where: {
  surfaceKey: string | null;
  faculty: string | null;
  components: readonly string[];
}): Promise<DesignPattern[]> {
  const all = await listPatterns({ state: 'ACTIVE' });
  const components = new Set(where.components.map((one) => one.toLowerCase()));
  const matched = all.filter((pattern) => {
    switch (pattern.scope) {
      case 'GLOBAL':
        return true;
      case 'FACULTY':
        return where.faculty !== null && pattern.scopeRef === where.faculty;
      case 'SCREEN':
        return where.surfaceKey !== null && pattern.scopeRef === where.surfaceKey;
      case 'COMPONENT':
        return pattern.scopeRef !== null && components.has(pattern.scopeRef.toLowerCase());
      case 'ONE_OFF':
        /*
         * A one-off never applies anywhere. It is kept because it is evidence
         * about a decision somebody made, and excluded because applying it was
         * the mistake it exists to record.
         */
        return false;
    }
  });
  const rank: Record<DesignConfidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return matched.sort((a, b) => {
    const byConfidence = rank[a.confidence] - rank[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    // Narrower first, because a rule about this screen beats a rule about
    // everything when they disagree.
    return SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
  });
}

/**
 * How confident a lesson may be, from what is actually behind it.
 *
 * Independent pieces of evidence, counted once per *source of independence*
 * rather than per row: three findings from one cycle are one observation, and
 * an owner correction is worth more than either because a person looked at it
 * and said so.
 */
export function confidenceFor(input: {
  ownerCorrections: number;
  distinctCycles: number;
  gatedClaims: number;
}): DesignConfidence {
  const independent =
    Math.min(input.ownerCorrections, 5) + Math.min(input.distinctCycles, 5) + Math.min(input.gatedClaims, 5);
  if (input.ownerCorrections >= 2 || independent >= 4) return 'HIGH';
  if (input.ownerCorrections >= 1 || independent >= 2) return 'MEDIUM';
  return 'LOW';
}

/**
 * Turn an owner correction into a proposed pattern, at the scope they gave it.
 *
 * Two refusals are the whole safety of this function, and both were the failure
 * the owner described:
 *
 *   - **A `ONE_OFF` correction never becomes a pattern.** They said it about one
 *     thing; a rule made from it is a rule that removes something useful
 *     somewhere else.
 *   - **The scope never widens.** The pattern carries the scope the correction
 *     was given at, exactly. Promoting a `COMPONENT` lesson to `GLOBAL` is how
 *     "make this smaller" becomes a product that is smaller everywhere.
 *
 * And it starts `PROPOSED`. Becoming `ACTIVE` is `activatePattern`, which is a
 * separate decision — §37's rule that nothing canonical arrives without passing
 * through a candidate, at a smaller table.
 */
export async function proposePatternFromCorrection(input: {
  correction: DesignCorrection;
  primitive: DesignPrimitive;
  branch: string | null;
  statement: string;
  appliesWhen: string;
  exceptions: string | null;
}): Promise<{ pattern: DesignPattern | null; refused: string | null }> {
  if (input.correction.scope === 'ONE_OFF') {
    return {
      pattern: null,
      refused:
        'This correction was recorded as a one-off, so it is evidence about one decision and not a ' +
        'rule. Promoting it would apply it to screens the owner never looked at.',
    };
  }
  if (input.correction.lesson === null) {
    return {
      pattern: null,
      refused:
        'This correction has no lesson taken from it yet, and a pattern whose statement nobody has ' +
        'written is a rule with no content.',
    };
  }

  const scope: DesignScope = input.correction.scope;
  const fingerprint = patternFingerprint({
    primitive: input.primitive,
    scope,
    scopeRef: input.correction.scopeRef,
    statement: input.statement,
  });
  const { pattern } = await upsertPattern({
    primitive: input.primitive,
    branch: input.branch,
    statement: input.statement,
    appliesWhen: input.appliesWhen,
    exceptions: input.exceptions,
    scope,
    scopeRef: input.correction.scopeRef,
    confidence: confidenceFor({ ownerCorrections: 1, distinctCycles: 0, gatedClaims: 0 }),
    origin: 'CORRECTION',
    evidence: [`design_correction:${input.correction.id}`, `owner said: ${input.correction.correction}`],
    state: 'PROPOSED',
    fingerprint,
  });
  await markCorrectionPromoted(input.correction.id, pattern.id);
  return { pattern, refused: null };
}

/**
 * Branches that have become distinctions.
 *
 * Three patterns under one branch is the threshold, and it is a judgement about
 * evidence rather than about interfaces: below it, a branch is a word one
 * pattern happened to use. It reports and decides nothing — turning a branch
 * into a primitive is a code change somebody reviews, which is where "does this
 * change what the self-model counts" gets asked.
 */
export async function emergingBranches(
  threshold = 3,
): Promise<{ primitive: string; branch: string; count: number }[]> {
  return (await branchCounts()).filter((one) => one.count >= threshold);
}
