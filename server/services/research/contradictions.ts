/**
 * Telling one kind of disagreement from another.
 *
 * Two figures that disagree are usually not in conflict at all: one counts a
 * different population, one covers a different year, one uses a definition
 * three words wider. Filing all of those as "contradiction" produces a report
 * full of caveats nobody can act on, and — worse — invites the one response
 * that is never allowed, which is to average two numbers that were never
 * measuring the same thing.
 *
 * So a disagreement is classified by what actually differs, and what to do
 * about it follows from the classification: settle the definition, pick the
 * timeframe the assignment asked for, or research the conflict properly.
 * Nothing here resolves a contradiction on its own — it decides which question
 * would resolve it.
 */
import type { ContradictionKind, ExistingClaim, ResearchClaim } from '../../domain/types.ts';

export interface ContradictionAssessment {
  kind: ContradictionKind;
  /** True when the two claims really cannot both be right. */
  material: boolean;
  /** What differs, in a sentence, for the reader and the repair prompt. */
  reason: string;
  /** The question that would settle it, when one exists. */
  resolutionQuestion: string | null;
}

interface Scoped {
  claim: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  claimType: string;
  sourcePublisher: string | null;
  primarySource?: boolean;
}

function differs(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return normalize(left) !== normalize(right);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Every number in a claim, so two figures can be compared rather than two sentences. */
function quantities(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent|per cent|k|m|bn|billion|million|trillion)?/gi)) {
    const base = Number(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const unit = (match[2] ?? '').toLowerCase();
    const scale =
      unit === 'k' ? 1e3
      : unit === 'm' || unit === 'million' ? 1e6
      : unit === 'bn' || unit === 'billion' ? 1e9
      : unit === 'trillion' ? 1e12
      : 1;
    out.push(base * scale);
  }
  return out;
}

/** Words that mean the two numbers were produced in different ways. */
const METHOD_WORDS =
  /\b(survey|sample|sampled|census|model(?:led|ed)?|estimat\w+|extrapolat\w+|weighted|self[- ]reported|administrative|panel)\b/i;

/**
 * A claim that carries its own uncertainty is not in conflict with a point
 * estimate inside its range — it is the same measurement, honestly stated.
 */
const UNCERTAINTY_WORDS = /\b(approximately|about|around|roughly|±|plus or minus|between|range|margin of error)\b/i;

/**
 * How two claims about the same requirement disagree.
 *
 * The order matters: a scope difference explains the disagreement completely,
 * so it is checked before anything is called a factual conflict. Only claims
 * that survive every scope check are genuinely in conflict.
 */
export function classifyContradiction(left: Scoped, right: Scoped): ContradictionAssessment {
  if (differs(left.definition, right.definition)) {
    return {
      kind: 'DEFINITION_MISMATCH',
      material: false,
      reason:
        `The two claims define the thing being measured differently ` +
        `("${left.definition}" against "${right.definition}"), so they are not measuring the same quantity.`,
      resolutionQuestion:
        'Which definition does this assignment require, and what does the evidence say on exactly that definition?',
    };
  }
  if (differs(left.timeframe, right.timeframe)) {
    return {
      kind: 'TIMEFRAME_MISMATCH',
      material: false,
      reason: `The claims cover different periods (${left.timeframe} and ${right.timeframe}).`,
      resolutionQuestion: `What does the evidence show for ${left.timeframe} specifically?`,
    };
  }
  if (differs(left.geography, right.geography)) {
    return {
      kind: 'GEOGRAPHY_MISMATCH',
      material: false,
      reason: `The claims cover different places (${left.geography} and ${right.geography}).`,
      resolutionQuestion: `What does the evidence show for ${left.geography} specifically?`,
    };
  }
  if (differs(left.population, right.population)) {
    return {
      kind: 'POPULATION_MISMATCH',
      material: false,
      reason: `The claims count different populations (${left.population} and ${right.population}).`,
      resolutionQuestion: `What does the evidence show for ${left.population} specifically?`,
    };
  }

  if (left.claimType === 'FORECAST' || right.claimType === 'FORECAST') {
    return {
      kind: 'FORECAST_DISAGREEMENT',
      material: false,
      reason:
        'At least one of these is a projection. Projections differ because their assumptions differ; ' +
        'that is not a factual conflict and neither one settles the other.',
      resolutionQuestion:
        'What are the methodology and assumptions behind each projection, and which of them does this ' +
        'assignment accept?',
    };
  }

  const leftNumbers = quantities(left.claim);
  const rightNumbers = quantities(right.claim);
  const bothQuantified = leftNumbers.length > 0 && rightNumbers.length > 0;

  if (bothQuantified) {
    const a = leftNumbers[0]!;
    const b = rightNumbers[0]!;
    const spread = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
    if (spread === 0) {
      return {
        kind: 'RESOLVED_BY_CONTEXT',
        material: false,
        reason: 'The two claims state the same figure; the apparent disagreement is in the wording.',
        resolutionQuestion: null,
      };
    }
    if (spread <= 0.05 && (UNCERTAINTY_WORDS.test(left.claim) || UNCERTAINTY_WORDS.test(right.claim))) {
      return {
        kind: 'MEASUREMENT_UNCERTAINTY',
        material: false,
        reason:
          'The figures differ by less than the uncertainty one of them states, so they are the same ' +
          'measurement rather than two conflicting ones.',
        resolutionQuestion: null,
      };
    }
    if (METHOD_WORDS.test(left.claim) && METHOD_WORDS.test(right.claim)) {
      return {
        kind: 'METHODOLOGICAL_DIFFERENCE',
        material: true,
        reason:
          'Both figures describe how they were produced, and the methods differ. Neither is wrong; ' +
          'they are not interchangeable and must not be combined.',
        resolutionQuestion:
          'Which methodology answers the question this assignment is asking, and what does that ' +
          'source alone report?',
      };
    }
  }

  return {
    kind: 'DIRECT_FACTUAL_CONFLICT',
    material: true,
    reason:
      `The claims cover the same scope and cannot both be right` +
      (left.sourcePublisher && right.sourcePublisher
        ? ` (${left.sourcePublisher} against ${right.sourcePublisher}).`
        : '.'),
    resolutionQuestion:
      'Which primary source resolves this disagreement, and on what basis — a correction, a ' +
      'revision, or a difference the sources themselves acknowledge?',
  };
}

/** The same comparison, against a claim already in the archive. */
export function classifyAgainstExisting(
  found: ResearchClaim,
  existing: ExistingClaim,
): ContradictionAssessment {
  return classifyContradiction(
    {
      claim: found.claim,
      geography: found.geography,
      timeframe: found.timeframe,
      population: found.population,
      definition: found.definition,
      claimType: found.claimType,
      sourcePublisher: found.sourcePublisher,
      primarySource: found.primarySource,
    },
    {
      claim: existing.claim,
      geography: existing.geography,
      timeframe: existing.timeframe,
      population: existing.population,
      definition: existing.definition,
      claimType: existing.claimType,
      sourcePublisher: existing.sourcePublisher,
    },
  );
}

/**
 * Two claims are only worth comparing when they are about the same thing.
 *
 * A cheap overlap test, deliberately: the expensive part is the classification,
 * and running it against every unrelated claim in the archive would produce
 * noise rather than contradictions.
 */
export function aboutTheSameThing(left: string, right: string): boolean {
  const a = contentWords(left);
  const b = contentWords(right);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.5;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'was', 'were',
  'be', 'been', 'that', 'this', 'these', 'those', 'with', 'by', 'from', 'as', 'it', 'its', 'per',
  'about', 'approximately', 'around', 'roughly', 'than', 'more', 'less', 'over', 'under',
]);

function contentWords(text: string): Set<string> {
  const words = normalize(text)
    .replace(/[^a-z0-9\s%.-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !/^\d[\d,.]*$/.test(word));
  return new Set(words);
}
