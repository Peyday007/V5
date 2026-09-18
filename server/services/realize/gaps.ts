/**
 * Holding a faculty's declared requirements against what Brain actually has.
 *
 * ---------------------------------------------------------------------------
 * What is a reading, and what is a judgement
 * ---------------------------------------------------------------------------
 *
 * Some of these classifications are readings over rows. "The definition names
 * the Evidence Engine; the self-model says a module exists and nothing in the
 * running process reaches it" is `EXISTS_BUT_DISCONNECTED`, and no opinion is
 * involved: re-running it produces the same answer, and a reader can check it
 * against the same two rows.
 *
 * Others are not. Whether an existing component is *sufficient* for what the
 * definition asks, whether something ought to be replaced rather than extended,
 * whether a missing thing is a research question or a build — those are
 * judgements somebody has to make by reading both the requirement and the
 * component. Brain deriving them would be model output deciding what gets
 * built, which is §8 at the most expensive altitude in this whole kernel.
 *
 * So this module derives exactly what it can and marks the rest
 * `NEEDS_A_READING`, which is a real classification rather than an absence. It
 * is §29's shape: five lenses are answered from rows and five are put in front
 * of a reader with the subject attached, and the engine answers none of the
 * second kind.
 *
 * ---------------------------------------------------------------------------
 * Why matching is conservative, and fails towards "I do not know"
 * ---------------------------------------------------------------------------
 *
 * A requirement is a sentence from the blueprint — "durable work items, leases
 * and checkpoints" — and a component is a name — `server/repos/workQueue.ts`,
 * `RESEARCH_FRAGMENT`. Nothing here will reliably match those, and a matcher
 * that tried hard would produce confident wrong answers: §25's Westbrook
 * defect, where every row is healthy and the work is filed under the wrong
 * heading.
 *
 * So the match is deliberately narrow — a distinctive token the component's own
 * name contains — and everything it does not match is `NEEDS_A_READING` rather
 * than `MUST_BE_BUILT`. The failure mode is *missing* a match, which costs a
 * reading, rather than *inventing* one, which would tell somebody a thing
 * exists when it does not.
 */
import type { FacultyDefinition } from '../../domain/faculties.ts';
import type { SystemComponent } from '../selfmodel/scan.ts';

export const GAP_KINDS = [
  'EXISTS_AND_LIVE',
  'EXISTS_BUT_DISCONNECTED',
  'EXISTS_BUT_INSUFFICIENT',
  'MUST_BE_BUILT',
  'MUST_BE_REPLACED',
  'MUST_BE_RESEARCHED',
  'REQUIRES_PERSON_AUTHORITY',
  'NEEDS_A_READING',
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/**
 * The kinds Brain may decide by itself, and the ones it may not.
 *
 * A constant rather than a rule in a comment, so the boundary is something a
 * test can hold and a later change has to move deliberately. Nothing outside
 * `DERIVABLE` may ever carry `derived_by = 'BRAIN'`.
 */
export const DERIVABLE: readonly GapKind[] = [
  'EXISTS_AND_LIVE',
  'EXISTS_BUT_DISCONNECTED',
  'REQUIRES_PERSON_AUTHORITY',
  'NEEDS_A_READING',
];

/**
 * The kinds that are somebody's reading of the requirement against the thing.
 *
 * `MUST_BE_BUILT` is in here and that is the decision this module is most
 * careful about. "Nothing matched" and "this has to be built" are different
 * statements, and only the first is something a name comparison establishes.
 */
export const NEEDS_JUDGEMENT: readonly GapKind[] = [
  'EXISTS_BUT_INSUFFICIENT',
  'MUST_BE_BUILT',
  'MUST_BE_REPLACED',
  'MUST_BE_RESEARCHED',
];

export interface DerivedGap {
  requirement: string;
  aspect: string;
  kind: GapKind;
  componentKey: string | null;
  evidence: string;
}

/**
 * The parts of a definition that state a requirement.
 *
 * Deliberately not every field. `purpose`, `promisedPower` and `boundaries`
 * describe what the faculty is *for* and what it may not do; turning those into
 * gaps would produce a build item for a sentence about scope. What is here is
 * the parts that name a thing that has to exist.
 */
export const REQUIREMENT_ASPECTS: ReadonlyArray<keyof FacultyDefinition> = [
  'inputs',
  'outputs',
  'dependencies',
  'infrastructure',
  'activationConditions',
  'reentryConditions',
  'evaluationRequirements',
];

/**
 * Words that mean a person has to decide, in a requirement's own terms.
 *
 * Narrow by construction and the failure mode is *missing* one, for the reason
 * §27 records about closed lists over ordinary English: four widenings, each
 * adding the word the last production message was declined for. A missed
 * authority requirement becomes `NEEDS_A_READING` and reaches a reader anyway;
 * an invented one would put an approval in front of somebody for a requirement
 * that never needed it, which teaches them to stop reading the approvals.
 */
const AUTHORITY_MARKERS: readonly RegExp[] = [
  /\bpermission(s)?\b/i,
  /\bauthority\b/i,
  /\bauthoris(e|ed|ation)\b|\bauthoriz(e|ed|ation)\b/i,
  /\bapprov(e|ed|al)\b/i,
  /\bconsent\b/i,
  /\bcredential(s)?\b/i,
  /\bbudget(s)?\b/i,
  /\bspend(ing)?\b/i,
];

/** Tokens too common to identify anything. A match on one means nothing. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'that', 'this', 'what', 'when', 'which',
  'brain', 'data', 'state', 'system', 'work', 'item', 'items', 'new', 'one',
  'its', 'into', 'over', 'each', 'they', 'their', 'have', 'has', 'are', 'not',
  'can', 'may', 'must', 'should', 'would', 'about', 'other', 'than', 'been',
]);

/** The shortest token worth matching on. Below this, a hit is a coincidence. */
const MIN_TOKEN = 5;

function tokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= MIN_TOKEN && !STOPWORDS.has(word)),
  )];
}

/**
 * A component whose own name contains a distinctive token of the requirement.
 *
 * One token is enough *because the token is long and not a stopword*, and
 * because the alternative — scoring, fuzzy distance, a threshold — is the shape
 * §33 corrected once already: a coverage score whose denominator is the
 * question measures how the question was asked. This either finds a name or it
 * does not, and not finding one is an answer.
 */
export function matchComponent(
  requirement: string,
  components: readonly SystemComponent[],
): { component: SystemComponent; token: string } | null {
  const wanted = tokens(requirement);
  if (wanted.length === 0) return null;
  for (const component of components) {
    const haystack = `${component.name} ${component.detail ?? ''}`.toLowerCase();
    for (const token of wanted) {
      if (haystack.includes(token)) return { component, token };
    }
  }
  return null;
}

function namesAnAuthority(requirement: string): boolean {
  return AUTHORITY_MARKERS.some((marker) => marker.test(requirement));
}

/**
 * Classify one requirement against the self-model.
 *
 * Four outcomes and no more, because those are the four a name comparison can
 * actually establish. Everything a judgement would be needed for comes back
 * `NEEDS_A_READING` with the reason, which is what puts it in front of somebody
 * rather than guessing on their behalf.
 */
export function classify(
  requirement: string,
  aspect: string,
  components: readonly SystemComponent[],
): DerivedGap {
  /*
   * Authority first, because it is a fact about the requirement's own words and
   * is true whether or not a component matches. A requirement that names a
   * budget is a person's decision even when the machinery to spend it exists —
   * §30's rule that a commercial grant is a separate decision from a capability.
   */
  if (namesAnAuthority(requirement)) {
    return {
      requirement,
      aspect,
      kind: 'REQUIRES_PERSON_AUTHORITY',
      componentKey: null,
      evidence:
        'The requirement names permission, authority, approval, consent, a credential or ' +
        'spending. Whatever machinery exists, somebody has to decide it, and Brain must not ' +
        'classify that as something it can build.',
    };
  }

  const matched = matchComponent(requirement, components);
  if (!matched) {
    return {
      requirement,
      aspect,
      kind: 'NEEDS_A_READING',
      componentKey: null,
      evidence:
        'No component in the self-model has a name containing a distinctive word of this ' +
        'requirement. That is "nothing matched" and not "this must be built": whether it has ' +
        'to be built, researched, or is served by something named differently is a judgement ' +
        'somebody makes by reading both, and Brain deciding it would be model output choosing ' +
        'what gets built.',
    };
  }

  const { component, token } = matched;
  const connected = component.answers.CONNECTED;
  const active = component.answers.OBSERVED_ACTIVE;
  const basis =
    `Matched "${component.componentKey}" on the word "${token}"; the self-model reads it ` +
    `CONNECTED=${connected}, OBSERVED_ACTIVE=${active}.`;

  if (connected === 'YES' && active === 'YES') {
    return {
      requirement,
      aspect,
      kind: 'EXISTS_AND_LIVE',
      componentKey: component.componentKey,
      evidence: basis,
    };
  }
  if (connected === 'NO') {
    return {
      requirement,
      aspect,
      kind: 'EXISTS_BUT_DISCONNECTED',
      componentKey: component.componentKey,
      evidence: `${basis} It exists and nothing in the running process reaches it.`,
    };
  }
  /*
   * Matched, and the self-model cannot say whether it is wired or whether it
   * runs. That is the ordinary case for a module — the self-model answers
   * `UNKNOWN` for connectedness on purpose, because a running process cannot
   * establish its own import graph — so it is a reading somebody has to make
   * rather than a conclusion Brain may reach from a name.
   */
  return {
    requirement,
    aspect,
    kind: 'NEEDS_A_READING',
    componentKey: component.componentKey,
    evidence:
      `${basis} A name matched and the self-model cannot say whether it is connected or ` +
      'active, so whether it serves this requirement is a reading rather than a derivation.',
  };
}

/**
 * Every gap a faculty's definition implies, held against one reading.
 *
 * Deduplicated by (aspect, requirement), because a definition may legitimately
 * repeat a requirement across aspects and two rows for one sentence would make
 * the gap count wrong in the direction that looks like more work than there is.
 */
export function deriveGaps(
  definition: FacultyDefinition,
  components: readonly SystemComponent[],
): DerivedGap[] {
  const out: DerivedGap[] = [];
  const seen = new Set<string>();
  for (const aspect of REQUIREMENT_ASPECTS) {
    const values = definition[aspect];
    if (!Array.isArray(values)) continue;
    for (const requirement of values) {
      if (typeof requirement !== 'string' || requirement.trim().length === 0) continue;
      const key = `${String(aspect)}::${requirement.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(classify(requirement.trim(), String(aspect), components));
    }
  }
  return out;
}

/** What the gaps say about whether this packet could be handed to the Factory. */
export interface GapSummary {
  total: number;
  byKind: Record<GapKind, number>;
  /** Gaps whose classification nobody has made yet. */
  awaitingAReading: number;
  /** Gaps a person has to answer before anything is built. */
  awaitingAPerson: number;
}

export function summarize(gaps: ReadonlyArray<{ kind: GapKind; state?: string }>): GapSummary {
  const byKind = Object.fromEntries(GAP_KINDS.map((kind) => [kind, 0])) as Record<GapKind, number>;
  for (const gap of gaps) {
    if (gap.state === 'CLOSED' || gap.state === 'WAIVED') continue;
    byKind[gap.kind] += 1;
  }
  const open = gaps.filter((gap) => gap.state !== 'CLOSED' && gap.state !== 'WAIVED');
  return {
    total: open.length,
    byKind,
    awaitingAReading: byKind.NEEDS_A_READING,
    awaitingAPerson: byKind.REQUIRES_PERSON_AUTHORITY,
  };
}
