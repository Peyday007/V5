/**
 * What a puzzle finding means, and the one place a declared one is validated.
 *
 * ---------------------------------------------------------------------------
 * A lookup, never a reading
 * ---------------------------------------------------------------------------
 *
 * `domain/industry.ts`, `domain/labor.ts` and `domain/opportunitySignals.ts`
 * make the same argument for the same reason: the judgement is made once, by
 * the only party that can make it — somebody who read the source — and
 * everything after that is Brain matching a value from a closed set exactly.
 * Nothing here inspects a sentence, and in particular nothing here decides
 * from prose whether a format sells or whether a mechanic is encumbered.
 *
 * ---------------------------------------------------------------------------
 * One finding's subject is open, and that is the universe rule
 * ---------------------------------------------------------------------------
 *
 * `PUZZLE_FORMAT` carries the format's name as the source gives it, because
 * the brief seeds a puzzle universe and says explicitly not to limit it. A
 * closed list of formats would encode the one thing it asks not to encode, and
 * would make a discovered format unrecordable. Every other finding answers a
 * question Brain asks across all formats, so its subject comes from a closed
 * set — an answer in somebody's own words could not be compared across them.
 *
 * The open subject is still bounded: it is trimmed, length-capped and refused
 * when it is empty or is an obvious non-answer. What it is not is *guessed at*
 * — nothing here decides that "Wordy Search Thing" means a word search, which
 * is a reader's judgement and `slugFor` is honest about the subset it catches.
 *
 * ---------------------------------------------------------------------------
 * Two readers, one rule
 * ---------------------------------------------------------------------------
 *
 * `services/research/schema.ts` checks a pass a provider returned;
 * `mcp/researchTools.ts` checks a claim a worker submitted over the wire. This
 * repository has had to write *a rule applied by one of two readers is worse
 * than none* six times, and every instance was two implementations that agreed
 * on the day they were written. So both call this, and it is the only thing
 * that decides.
 *
 * ---------------------------------------------------------------------------
 * Refused here, where the worker can still fix it
 * ---------------------------------------------------------------------------
 *
 * Every failure below refuses the whole submission rather than dropping the
 * field. §27 records why: truncation and silent dropping are the outcomes a
 * worker cannot recover from, because they are reported as success. Refused,
 * the worker corrects one field and submits the same claims again on the same
 * item, with the attempt still there to spend.
 */
import {
  DISTINCTNESS_AXES,
  NON_QUALIFYING_AXES,
  PRICE_BASES,
  PRODUCT_CLASSES,
  PRODUCTION_METHODS,
  PUBLISHABLE_RIGHTS_BASES,
  PUZZLE_BUYERS,
  PUZZLE_CHANNELS,
  PUZZLE_FINDINGS,
  PUZZLE_VERDICTS,
  RIGHTS_BASES,
  RIGHTS_CONSTRAINTS,
  type DistinctnessAxis,
  type PriceBasis,
  type ProductClass,
  type ProductionMethod,
  type PuzzleBuyer,
  type PuzzleChannel,
  type PuzzleFinding,
  type PuzzleVerdict,
  type RightsBasis,
  type RightsConstraint,
} from './types.ts';

export { PUZZLE_FINDINGS };
export type { PuzzleFinding };

/** The longest a discovered format's name may be. A paragraph is not a name. */
const MAX_SUBJECT_CHARS = 80;

export function isPuzzleFinding(value: unknown): value is PuzzleFinding {
  return typeof value === 'string' && (PUZZLE_FINDINGS as readonly string[]).includes(value);
}

export function isPuzzleBuyer(value: unknown): value is PuzzleBuyer {
  return typeof value === 'string' && (PUZZLE_BUYERS as readonly string[]).includes(value);
}

export function isPuzzleChannel(value: unknown): value is PuzzleChannel {
  return typeof value === 'string' && (PUZZLE_CHANNELS as readonly string[]).includes(value);
}

export function isRightsConstraint(value: unknown): value is RightsConstraint {
  return typeof value === 'string' && (RIGHTS_CONSTRAINTS as readonly string[]).includes(value);
}

export function isProductionMethod(value: unknown): value is ProductionMethod {
  return typeof value === 'string' && (PRODUCTION_METHODS as readonly string[]).includes(value);
}

export function isPriceBasis(value: unknown): value is PriceBasis {
  return typeof value === 'string' && (PRICE_BASES as readonly string[]).includes(value);
}

export function isProductClass(value: unknown): value is ProductClass {
  return typeof value === 'string' && (PRODUCT_CLASSES as readonly string[]).includes(value);
}

export function isDistinctnessAxis(value: unknown): value is DistinctnessAxis {
  return typeof value === 'string' && (DISTINCTNESS_AXES as readonly string[]).includes(value);
}

export function isRightsBasis(value: unknown): value is RightsBasis {
  return typeof value === 'string' && (RIGHTS_BASES as readonly string[]).includes(value);
}

export function isPuzzleVerdict(value: unknown): value is PuzzleVerdict {
  return typeof value === 'string' && (PUZZLE_VERDICTS as readonly string[]).includes(value);
}

/** Whether an axis counts towards the leverage multiplier. `COSMETIC` never does. */
export function axisQualifies(axis: DistinctnessAxis): boolean {
  return !NON_QUALIFYING_AXES.includes(axis);
}

/** Whether something may be sold on this rights basis. `UNESTABLISHED` may not. */
export function rightsPermitPublication(basis: RightsBasis): boolean {
  return PUBLISHABLE_RIGHTS_BASES.includes(basis);
}

/**
 * The stable handle a format is matched against, from its name.
 *
 * Honest about what it catches, which is the whole of §39's identity rule one
 * kernel along: it joins "Word Search", "word search" and "Word  Search" to
 * one row, and it does **not** join "word search" to "wordseek" or to
 * "find-a-word". Those are two phrases meaning one thing, and deciding that
 * needs a reader — §24's semantic-merge floor. Guessing there would silently
 * weld two format histories together, which is worse than two rows somebody
 * can see and merge deliberately.
 */
export function slugFor(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/**
 * Where a finding's subject comes from.
 *
 * `null` means the subject is open — the format's own name — and every other
 * finding names the closed set its subject must be in.
 */
export function subjectVocabularyFor(finding: PuzzleFinding): readonly string[] | null {
  switch (finding) {
    case 'PUZZLE_FORMAT':
      return null;
    case 'BUYER_DEMAND':
      return PUZZLE_BUYERS;
    case 'DISTRIBUTION_CHANNEL':
      return PUZZLE_CHANNELS;
    case 'RIGHTS_CONSTRAINT':
      return RIGHTS_CONSTRAINTS;
    case 'PRODUCTION_METHOD':
      return PRODUCTION_METHODS;
    case 'PRICE_POINT':
      return PRODUCT_CLASSES;
  }
}

/** Only a price point carries a figure, and only it carries a basis. */
export function findingTakesPrice(finding: PuzzleFinding): boolean {
  return finding === 'PRICE_POINT';
}

/**
 * Whether a finding adds a format to the universe.
 *
 * A `Record` over the whole union rather than a partial map, so a finding
 * added later is a compile error until somebody says whether it creates a
 * subject — §27's lesson about two sets that must be total between them.
 */
const CREATES_FORMAT: Readonly<Record<PuzzleFinding, boolean>> = Object.freeze({
  PUZZLE_FORMAT: true,
  BUYER_DEMAND: false,
  DISTRIBUTION_CHANNEL: false,
  RIGHTS_CONSTRAINT: false,
  PRODUCTION_METHOD: false,
  PRICE_POINT: false,
});

export function findingCreatesFormat(finding: PuzzleFinding): boolean {
  return CREATES_FORMAT[finding];
}

/**
 * One line per finding, for the assignment a worker actually reads.
 *
 * §33 records why this belongs in the assignment rather than only on the
 * submission tool: by the time somebody is filling in a claim they have
 * already decided what they were looking for, and the submission tool is the
 * wrong end of the job.
 */
export const PUZZLE_FINDING_GUIDE: Readonly<Record<PuzzleFinding, string>> = Object.freeze({
  PUZZLE_FORMAT:
    'a kind of puzzle, mechanic or puzzle product that exists — set puzzle_subject to what the ' +
    'source calls it, in its own words, as a short name rather than a description',
  BUYER_DEMAND:
    'a published buyer for work of this kind — set puzzle_subject to which class of buyer',
  DISTRIBUTION_CHANNEL:
    'a published route by which work of this kind reaches a buyer — set puzzle_subject to ' +
    'which channel',
  RIGHTS_CONSTRAINT:
    'a published rights, licensing or trademark constraint — set puzzle_subject to which kind, ' +
    'including NO_CONSTRAINT_FOUND where you searched the places such a rule would be and ' +
    'found none',
  PRODUCTION_METHOD:
    'a published way work of this kind is physically produced — set puzzle_subject to which ' +
    'method',
  PRICE_POINT:
    'a published price — set puzzle_subject to the product class it is a price for, ' +
    'puzzle_price_cents in minor units and puzzle_qualifier to what it is quoted on',
});

/** The closed sets a subject comes from, composed rather than restated. */
export const PUZZLE_SUBJECT_GUIDE = [
  'PUZZLE_FORMAT — the format’s own name, as the source gives it',
  `BUYER_DEMAND — one of ${PUZZLE_BUYERS.join(', ')}`,
  `DISTRIBUTION_CHANNEL — one of ${PUZZLE_CHANNELS.join(', ')}`,
  `RIGHTS_CONSTRAINT — one of ${RIGHTS_CONSTRAINTS.join(', ')}`,
  `PRODUCTION_METHOD — one of ${PRODUCTION_METHODS.join(', ')}`,
  `PRICE_POINT — one of ${PRODUCT_CLASSES.join(', ')}`,
].join('; ');

export interface PuzzleDeclaration {
  finding: PuzzleFinding | null;
  subject: string | null;
  qualifier: PriceBasis | null;
  priceCents: number | null;
}

export type PuzzleCheck = { ok: true; value: PuzzleDeclaration } | { ok: false; error: string };

export function validatePuzzle(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  qualifier: unknown;
  priceCents: unknown;
}): PuzzleCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const qualifier = tidy(input.qualifier);

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing about puzzle products, which is
     * most claims. Its companions must then be absent too: a subject with no
     * finding is a value nothing will ever read, and storing it would look
     * like it had done something.
     */
    if (subject) {
      return {
        ok: false,
        error:
          `${where}: puzzle_subject was given with no puzzle_finding. Say which kind of fact ` +
          'about puzzle products it establishes, or leave the subject out.',
      };
    }
    if (qualifier) {
      return { ok: false, error: `${where}: puzzle_qualifier was given with no puzzle_finding.` };
    }
    if (!absent(input.priceCents)) {
      return {
        ok: false,
        error: `${where}: puzzle_price_cents was given with no puzzle_finding.`,
      };
    }
    return { ok: true, value: { finding: null, subject: null, qualifier: null, priceCents: null } };
  }

  if (!isPuzzleFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: puzzle_finding must be one of ${PUZZLE_FINDINGS.join(', ')}, or omitted when ` +
        'the claim says nothing about puzzle formats, buyers, channels, rights or production.',
    };
  }
  const finding = input.finding;

  const vocabulary = subjectVocabularyFor(finding);

  if (!subject) {
    return {
      ok: false,
      error: vocabulary
        ? `${where}: a ${finding} finding must set puzzle_subject. It must be one of ` +
          `${vocabulary.join(', ')}.`
        : `${where}: a ${finding} finding must set puzzle_subject to the format’s own name, as ` +
          'the source gives it.',
    };
  }

  if (vocabulary) {
    if (!vocabulary.includes(subject)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_subject for a ${finding} finding must be one of ` +
          `${vocabulary.join(', ')}. "${subject}" is not one of them — say which of those this ` +
          'is, and put the detail in the claim itself.',
      };
    }
  } else {
    /*
     * The open subject. Bounded rather than free: a name is what goes on the
     * map and in a title, and a paragraph filed as one makes every later
     * reading of the universe unreadable. Refused rather than clipped, for
     * §27's reason — a truncated format name arrives looking like success.
     */
    if (subject.length > MAX_SUBJECT_CHARS) {
      return {
        ok: false,
        error:
          `${where}: puzzle_subject for a ${finding} finding is the format’s name and must be ` +
          `at most ${MAX_SUBJECT_CHARS} characters. "${subject.slice(0, 40)}…" is ` +
          `${subject.length}. Put what it is in the claim and name it here.`,
      };
    }
    if (!slugFor(subject)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_subject for a ${finding} finding must contain at least one letter ` +
          'or digit. A format with no nameable name cannot be put on the map.',
      };
    }
  }

  if (!findingTakesPrice(finding)) {
    if (qualifier) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so puzzle_qualifier must be ` +
          'omitted. Only PRICE_POINT has a price and a basis for it.',
      };
    }
    if (!absent(input.priceCents)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so puzzle_price_cents must be ` +
          'omitted. Only PRICE_POINT has one.',
      };
    }
    return { ok: true, value: { finding, subject, qualifier: null, priceCents: null } };
  }

  /*
   * A price point with no figure is refused, and this is the one finding where
   * that is right. A channel with no published rate is a useful fact — it
   * establishes the route exists. A *price* with no price establishes nothing
   * at all, so there is no honest row to write and the worker is told to
   * submit it as a DISTRIBUTION_CHANNEL instead.
   */
  if (absent(input.priceCents)) {
    return {
      ok: false,
      error:
        `${where}: a PRICE_POINT finding must set puzzle_price_cents. A price point with no ` +
        'price establishes nothing — where a source names a route to a buyer but no figure, ' +
        'submit it as DISTRIBUTION_CHANNEL, which is recorded as a real route at an unknown ' +
        'price.',
    };
  }

  if (
    typeof input.priceCents !== 'number' ||
    !Number.isFinite(input.priceCents) ||
    !Number.isInteger(input.priceCents) ||
    input.priceCents < 0
  ) {
    return {
      ok: false,
      error:
        `${where}: puzzle_price_cents must be a whole number of minor units, not negative. ` +
        'Read it from the source rather than converting a range or an estimate into one.',
    };
  }

  if (!qualifier) {
    return {
      ok: false,
      error:
        `${where}: a price must say what it is quoted on. Set puzzle_qualifier to one of ` +
        `${PRICE_BASES.join(', ')} — "1.00" compares to nothing, and a per-book price read as ` +
        'a per-puzzle price is wrong by two orders of magnitude silently.',
    };
  }
  if (!isPriceBasis(qualifier)) {
    return {
      ok: false,
      error: `${where}: puzzle_qualifier must be one of ${PRICE_BASES.join(', ')}.`,
    };
  }

  return { ok: true, value: { finding, subject, qualifier, priceCents: input.priceCents } };
}
