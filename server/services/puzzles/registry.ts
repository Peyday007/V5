/**
 * What this Brain can actually make and actually check.
 *
 * ---------------------------------------------------------------------------
 * This file is the only thing entitled to say a format is supported
 * ---------------------------------------------------------------------------
 *
 * The universe of puzzle formats is **rows** — `puzzle_formats`, from a person
 * or from a gated claim — because the brief seeds a universe and says not to
 * limit it. What is *in code* is this map, and it answers a different
 * question: not "does this kind of puzzle exist" but "can this Brain produce
 * one and prove it is correct".
 *
 * `FORMAT_MATURITIES` has `GENERATABLE` and `VALIDATABLE` rungs, and no row in
 * the database can reach either. They are read from this map on every pass, so
 * the brief's requirement — "do not falsely claim support for puzzle formats
 * lacking real validators" — is structural rather than remembered. Delete an
 * entry and the corresponding format falls back down the ladder immediately,
 * with nothing to update.
 *
 * ---------------------------------------------------------------------------
 * What a version means here
 * ---------------------------------------------------------------------------
 *
 * `generatorVersion` and `validatorVersion` are recorded on every instance and
 * every verdict. They exist so that a defect found later resolves to the exact
 * code that produced or judged the puzzle — and so that a *fixed* validator
 * produces a new verdict row beside the old one rather than overwriting it,
 * which is what lets somebody see that a check changed its mind. Bump a
 * version whenever the behaviour changes; leaving it alone after a fix would
 * make the new reading collide with the old one and be silently discarded.
 *
 * ---------------------------------------------------------------------------
 * The gaps are declared, because an unlisted gap reads as covered
 * ---------------------------------------------------------------------------
 *
 * `knownGaps` is what this format's support does not establish. None of these
 * checks knows whether a puzzle is enjoyable, whether its difficulty matches
 * what a person experiences, or whether its theme holds together — the brief
 * asks for human edit and stratified playtest for exactly those, and this
 * Brain holds no playtest data. Saying so here is what lets `view.ts` report
 * it as an open gap instead of letting silence read as coverage.
 */
import {
  generateCryptogram,
  generateMaze,
  generateSudoku,
  generateWordSearch,
} from './generators.ts';
import {
  CRYPTOGRAM_CHECKS,
  MAZE_CHECKS,
  SUDOKU_CHECKS,
  WORD_SEARCH_CHECKS,
  validateCryptogram,
  validateMaze,
  validateSudoku,
  validateWordSearch,
} from './validators.ts';
import { slugFor } from '../../domain/puzzles.ts';
import type { Generator, Validator } from './kinds.ts';

export interface FormatSupport {
  /** The format slug this implements, as `slugFor` produces it. */
  slug: string;
  generatorKey: string;
  generatorVersion: string;
  generate: Generator;
  validatorKey: string;
  validatorVersion: string;
  validate: Validator;
  /**
   * The checks that must PASS before an instance counts as evidence.
   *
   * A check named here that the validator does not answer is recorded
   * `UNSUPPORTED` rather than assumed — `validate.ts` compares the two sets on
   * every run, so an implementation that silently stopped answering one would
   * be visible as an unsupported check rather than as a passing puzzle.
   */
  requiredChecks: readonly string[];
  /** What this support does not establish. Declared so silence cannot read as coverage. */
  knownGaps: readonly string[];
}

/** The gaps every format here shares, stated once rather than repeated wrongly. */
const UNIVERSAL_GAPS: readonly string[] = Object.freeze([
  'No difficulty calibration against human solve times. Every difficulty here is a structural ' +
    'measurement of the puzzle and names what it counted; mapping that onto how long a person ' +
    'takes needs playtest data this Brain does not hold.',
  'No human edit and no playtest. Enjoyment, readability, cultural fit and actual difficulty ' +
    'are what the brief asks a person to check, and nothing here checks them.',
]);

const SUPPORT: readonly FormatSupport[] = Object.freeze([
  {
    slug: 'SUDOKU',
    generatorKey: 'SUDOKU_DIG_V1',
    generatorVersion: '1.0.0',
    generate: generateSudoku,
    validatorKey: 'SUDOKU_CHECKS_V1',
    validatorVersion: '1.0.0',
    validate: validateSudoku,
    requiredChecks: SUDOKU_CHECKS,
    knownGaps: Object.freeze([
      ...UNIVERSAL_GAPS,
      'Duplicate detection folds rotations, reflections and digit relabellings, and does not ' +
        'fold band or stack permutations. It misses duplicates and never invents one; ' +
        'grid.ts says why that is the safe direction.',
    ]),
  },
  {
    slug: 'WORD_SEARCH',
    generatorKey: 'WORD_SEARCH_PLACE_V1',
    generatorVersion: '1.0.0',
    generate: generateWordSearch,
    validatorKey: 'WORD_SEARCH_CHECKS_V1',
    validatorVersion: '1.0.0',
    validate: validateWordSearch,
    requiredChecks: WORD_SEARCH_CHECKS,
    knownGaps: Object.freeze([
      ...UNIVERSAL_GAPS,
      'The screening check looks only for the strings the master supplies. With an empty list ' +
        'it establishes that nothing on an empty list appears, which is true and is not the ' +
        'same fact as a grid having been screened.',
      'Nothing here establishes that the word list itself is rights-clear or appropriate for ' +
        'the stated audience. That is the master’s rights basis and a person’s judgement.',
    ]),
  },
  {
    slug: 'MAZE',
    generatorKey: 'MAZE_DFS_V1',
    generatorVersion: '1.0.0',
    generate: generateMaze,
    validatorKey: 'MAZE_CHECKS_V1',
    validatorVersion: '1.0.0',
    validate: validateMaze,
    requiredChecks: MAZE_CHECKS,
    knownGaps: Object.freeze([...UNIVERSAL_GAPS]),
  },
  {
    slug: 'CRYPTOGRAM',
    generatorKey: 'CRYPTOGRAM_SUBSTITUTION_V1',
    generatorVersion: '1.0.0',
    generate: generateCryptogram,
    validatorKey: 'CRYPTOGRAM_CHECKS_V1',
    validatorVersion: '1.0.0',
    validate: validateCryptogram,
    requiredChecks: CRYPTOGRAM_CHECKS,
    knownGaps: Object.freeze([
      ...UNIVERSAL_GAPS,
      'Nothing here can tell whether the enciphered text is somebody’s copyrighted quotation. ' +
        'That is the one thing this format most needs established, it cannot be established by ' +
        'code, and it is why the master carries a rights basis a person sets.',
    ]),
  },
]);

const BY_SLUG = new Map(SUPPORT.map((one) => [one.slug, one]));
const BY_GENERATOR = new Map(SUPPORT.map((one) => [one.generatorKey, one]));

/**
 * Formats this Brain knows it cannot yet make, and the honest reason.
 *
 * This grants nothing and is read only to compose a sentence. It exists
 * because "there is no generator" is a true and useless thing to tell
 * somebody: §24's rule that an escalation must name a remedy, at a format.
 *
 * The crossword entry is the one the brief asks for explicitly, and it is the
 * clearest statement of what this whole registry is for — a crossword
 * generator is not hard because of the grid, it is hard because a legal fill
 * needs a lexicon and a clue bank whose rights somebody has established, and
 * `RIGHTS_CONSTRAINT` findings are what would establish them.
 */
export const UNIMPLEMENTED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  CROSSWORD:
    'A crossword needs a lexicon and a clue bank whose commercial-use rights are established. ' +
    'Generating a grid is the easy half; filling it legally from a corpus nobody holds the ' +
    'rights to is the half that would make the product unsellable. Open a RIGHTS round on this ' +
    'format, and a DATABASE_OR_LEXICON_RIGHTS or NO_CONSTRAINT_FOUND finding is what would ' +
    'unblock it.',
  MINI_CROSSWORD:
    'The same lexicon and clue-bank rights question as a full crossword, at a smaller grid. ' +
    'The grid size is not what is missing.',
  NONOGRAM:
    'A nonogram generator is tractable and is not written. What it needs beyond the carve is a ' +
    'solver that establishes the clues admit exactly one picture, which is the same uniqueness ' +
    'burden the Sudoku generator already carries.',
  LOGIC_GRID:
    'A logic grid needs a constraint generator and a deduction-path solver to establish that ' +
    'the clues are sufficient and not redundant. Neither is written.',
  ACROSTIC:
    'An acrostic needs the same rights-established quotation corpus a cryptogram needs, plus a ' +
    'clue bank. The quotation half is the blocker.',
  CRYPTIC_CROSSWORD:
    'Cryptic clue construction is an editorial craft this Brain has no generator for, and a ' +
    'generated cryptic clue that does not parse is worse than none.',
});

/** What this Brain can do with the format a slug names, or null. */
export function supportFor(slug: string): FormatSupport | null {
  return BY_SLUG.get(slug) ?? null;
}

/** What a generator key implements, or null. Refused at declaration, not at production. */
export function supportForGenerator(generatorKey: string): FormatSupport | null {
  return BY_GENERATOR.get(generatorKey) ?? null;
}

/** Every format this Brain can produce. The source of the GENERATABLE rung. */
export function supportedSlugs(): string[] {
  return SUPPORT.map((one) => one.slug);
}

export function allSupport(): readonly FormatSupport[] {
  return SUPPORT;
}

/**
 * The honest sentence about a format nothing implements.
 *
 * Falls back to naming what is missing rather than to silence, because a
 * reading that says only "not generatable" sends somebody to look for a
 * setting rather than to write a generator.
 */
export function unimplementedReason(slug: string, name: string): string {
  const known = UNIMPLEMENTED_REASONS[slug];
  if (known) return known;
  return (
    `No generator in this repository produces ${name}, so nothing can be made or checked for ` +
    'it. That is a statement about this Brain rather than about the format: the remedy is a ' +
    'generator and a validator, which is a Software Factory change somebody approves.'
  );
}

/** Whether a name resolves to something this Brain can make. Slug-based, and honest about it. */
export function supportForName(name: string): FormatSupport | null {
  return supportFor(slugFor(name));
}
