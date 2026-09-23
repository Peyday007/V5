/**
 * Word search: placed by a generator that knows where the words are, checked
 * by a validator that has to find them.
 *
 * ---------------------------------------------------------------------------
 * The validator is handed a rectangle of letters
 * ---------------------------------------------------------------------------
 *
 * Not the placement list. Not the direction each word went in. A rectangle of
 * letters and a word list, exactly what a person buying the book gets — and it
 * scans all eight directions from every cell and finds the words itself. A
 * validator reading the generator's own placements would prove that the
 * generator remembered what it did, which is not the thing anybody needs
 * proved.
 *
 * ---------------------------------------------------------------------------
 * The defect this format actually has is a word nobody placed
 * ---------------------------------------------------------------------------
 *
 * Every word search generator ever written fills the space around the placed
 * words with letters, and those letters cross each other in eight directions.
 * Sooner or later they spell something — sometimes another word from the list,
 * which makes the answer key wrong, and sometimes something that must not be
 * on a page aimed at children. Neither is visible from the word list, because
 * the word was never placed; both are visible from the grid, because the grid
 * is where it happened.
 *
 * So there are two checks nothing else in this kernel has: every listed word
 * appears **exactly once**, and the whole grid is screened against
 * `PROHIBITED_STRINGS` in all eight directions. The screen is short and says
 * so — it is a check against the unambiguous cases, not a claim that a grid is
 * clean — and `requiresHumanEdit` stays false only because what it cannot see
 * is a matter of taste rather than of correctness.
 */
import {
  artifactHash,
  bandFor,
  check,
  intParam,
  Rng,
  sha256,
  stringParam,
  verdictFrom,
  type PuzzleArtifact,
  type PuzzleCheck,
  type PuzzleFormat,
  type PuzzleSpec,
  type PuzzleVerdict,
} from './engine.ts';
import { corpus, PROHIBITED_STRINGS } from '../../../domain/puzzleCorpora.ts';
import type { PuzzleDifficulty } from '../../../domain/types.ts';

export const WORD_SEARCH_KEY = 'word search';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The eight directions, as (dRow, dCol) with a name a key can print. */
const DIRECTIONS: readonly { name: string; dr: number; dc: number }[] = Object.freeze([
  { name: 'right', dr: 0, dc: 1 },
  { name: 'left', dr: 0, dc: -1 },
  { name: 'down', dr: 1, dc: 0 },
  { name: 'up', dr: -1, dc: 0 },
  { name: 'down-right', dr: 1, dc: 1 },
  { name: 'down-left', dr: 1, dc: -1 },
  { name: 'up-right', dr: -1, dc: 1 },
  { name: 'up-left', dr: -1, dc: -1 },
]);

interface Found {
  row: number;
  col: number;
  direction: string;
}

/** Every place this word reads in the grid, in any direction. */
export function occurrencesOf(grid: readonly string[], word: string): Found[] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const out: Found[] = [];
  if (word.length === 0) return out;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      for (const direction of DIRECTIONS) {
        let ok = true;
        for (let i = 0; i < word.length && ok; i += 1) {
          const rr = r + direction.dr * i;
          const cc = c + direction.dc * i;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) {
            ok = false;
            break;
          }
          if ((grid[rr] ?? '')[cc] !== word[i]) ok = false;
        }
        if (ok) out.push({ row: r, col: c, direction: direction.name });
      }
    }
  }
  return out;
}

function keyLine(word: string, at: Found): string {
  return `${word}: row ${at.row + 1}, column ${at.col + 1}, ${at.direction}`;
}

function render(spec: PuzzleSpec): PuzzleArtifact {
  const size = intParam(spec, 'size', 12, 7, 30);
  const wanted = intParam(spec, 'words', 10, 3, 40);
  const intended = (spec.parameters['difficulty'] as PuzzleDifficulty | undefined) ?? 'MEDIUM';
  const theme = stringParam(spec, 'theme', '');
  const source = corpus(spec.corpusId);
  if (!source) throw new Error(`No corpus named ${spec.corpusId}.`);
  if (source.words.length === 0) {
    throw new Error(
      `The corpus ${spec.corpusId} holds no words, so a word search cannot be built from it.`,
    );
  }

  const rng = new Rng(`${spec.seed}:wordsearch`);
  /*
   * Longest first, which is the standard and is not a preference: a long word
   * has far fewer legal placements than a short one, so placing it last means
   * failing to place it at all in a grid the short words have already filled.
   */
  const pool = rng
    .shuffle(source.words.filter((one) => one.length <= size))
    .sort((a, b) => b.length - a.length);

  const grid: string[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ''),
  );
  const placed: { word: string; at: Found }[] = [];

  const fits = (word: string, r: number, c: number, dr: number, dc: number): boolean => {
    for (let i = 0; i < word.length; i += 1) {
      const rr = r + dr * i;
      const cc = c + dc * i;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) return false;
      const already = (grid[rr] as string[])[cc];
      if (already !== '' && already !== word[i]) return false;
    }
    return true;
  };

  for (const word of pool) {
    if (placed.length >= wanted) break;
    if (placed.some((one) => one.word === word)) continue;
    const starts = rng.shuffle(
      Array.from({ length: size * size }, (_unused, index) => index),
    );
    let done = false;
    for (const start of starts) {
      if (done) break;
      const r = Math.floor(start / size);
      const c = start % size;
      for (const direction of rng.shuffle(DIRECTIONS)) {
        if (!fits(word, r, c, direction.dr, direction.dc)) continue;
        for (let i = 0; i < word.length; i += 1) {
          (grid[r + direction.dr * i] as string[])[c + direction.dc * i] = word[i] as string;
        }
        placed.push({ word, at: { row: r, col: c, direction: direction.name } });
        done = true;
        break;
      }
    }
  }

  /*
   * The filler.
   *
   * Drawn uniformly rather than from English letter frequencies, which is a
   * deliberate trade: frequency-weighted filler makes a prettier grid and
   * makes accidental words *more* likely, and an accidental word is the one
   * defect here that reaches a printed page. The screen in `validate` is the
   * backstop either way, and an instance it refuses is simply regenerated
   * from the next seed at no cost.
   */
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if ((grid[r] as string[])[c] === '') {
        (grid[r] as string[])[c] = LETTERS[rng.int(LETTERS.length)] as string;
      }
    }
  }

  const rows = grid.map((row) => row.join(''));
  const words = placed.map((one) => one.word).sort();
  /*
   * The solution grid shows the placed letters and blanks everything else, so
   * a reader can see the words without re-solving. It is derived from the
   * placements at the same moment the key is, which is what makes the two
   * incapable of disagreeing.
   */
  const marked: string[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => '.'),
  );
  for (const one of placed) {
    const direction = DIRECTIONS.find((d) => d.name === one.at.direction);
    if (!direction) continue;
    for (let i = 0; i < one.word.length; i += 1) {
      (marked[one.at.row + direction.dr * i] as string[])[one.at.col + direction.dc * i] =
        one.word[i] as string;
    }
  }

  return {
    formatKey: WORD_SEARCH_KEY,
    instructions:
      `Find all ${words.length} words hidden in the grid. Words read forwards, backwards, up, ` +
      'down and diagonally, and letters may be shared between words.' +
      (theme ? ` Theme: ${theme}.` : ''),
    grid: rows,
    prompts: words,
    solution: marked.map((row) => row.join('')),
    answerKey: placed
      .slice()
      .sort((a, b) => a.word.localeCompare(b.word))
      .map((one) => keyLine(one.word, one.at)),
    intendedDifficulty: intended,
  };
}

function validate(artifact: PuzzleArtifact): PuzzleVerdict {
  const checks: PuzzleCheck[] = [];
  const grid = artifact.grid;
  const width = grid[0]?.length ?? 0;
  const rectangular = grid.length > 0 && width > 0 && grid.every((row) => row.length === width);
  checks.push(
    check(
      'the grid is a rectangle of letters',
      rectangular && grid.every((row) => /^[A-Z]+$/.test(row)),
      rectangular
        ? `${grid.length} rows of ${width}.`
        : 'The rows are not all the same length, so this is not a grid.',
    ),
  );
  if (!rectangular) return verdictFrom(checks, null, artifactHash(artifact));

  const words = artifact.prompts.filter((one) => /^[A-Z]+$/.test(one));
  checks.push(
    check(
      'there is a word list',
      words.length > 0 && words.length === artifact.prompts.length,
      `${words.length} word(s) listed.` +
        (words.length === artifact.prompts.length
          ? ''
          : ' Some listed entries are not plain upper-case words.'),
    ),
  );

  /*
   * Every word found, from the grid, by searching it.
   *
   * Exactly once rather than at least once. A second occurrence is not a
   * bonus: the answer key names one position, a solver who circles the other
   * is told they are wrong, and neither of them is.
   */
  const missing: string[] = [];
  const doubled: string[] = [];
  const positions = new Map<string, Found>();
  for (const word of words) {
    const found = occurrencesOf(grid, word);
    if (found.length === 0) missing.push(word);
    else if (found.length > 1) doubled.push(`${word} (${found.length}x)`);
    const first = found[0];
    if (first) positions.set(word, first);
  }
  checks.push(
    check(
      'every listed word is in the grid',
      missing.length === 0,
      missing.length === 0
        ? `All ${words.length} found by searching the printed grid.`
        : `Not found: ${missing.join(', ')}.`,
    ),
  );
  checks.push(
    check(
      'no listed word appears twice',
      doubled.length === 0,
      doubled.length === 0
        ? 'Each word reads in exactly one place.'
        : `Appears more than once, so the answer key names one of two correct answers: ${doubled.join(', ')}.`,
    ),
  );

  /*
   * The answer key re-derived rather than trusted.
   *
   * Each key line is parsed back to a row, a column and a direction, and the
   * word is read out of the grid from there. A key that names a position the
   * word is not at is the defect a solver finds at the back of the book.
   */
  const keyProblems: string[] = [];
  for (const line of artifact.answerKey) {
    const match = /^([A-Z]+): row (\d+), column (\d+), ([a-z-]+)$/.exec(line);
    if (!match) {
      keyProblems.push(`unreadable key line "${line}"`);
      continue;
    }
    const word = match[1] as string;
    const row = Number(match[2]) - 1;
    const col = Number(match[3]) - 1;
    const direction = DIRECTIONS.find((one) => one.name === match[4]);
    if (!direction) {
      keyProblems.push(`${word}: "${match[4]}" is not a direction`);
      continue;
    }
    let reads = '';
    for (let i = 0; i < word.length; i += 1) {
      const rr = row + direction.dr * i;
      const cc = col + direction.dc * i;
      reads += (grid[rr] ?? '')[cc] ?? '';
    }
    if (reads !== word) keyProblems.push(`${word}: the grid reads "${reads}" there`);
    if (!words.includes(word)) keyProblems.push(`${word} is in the key and not in the word list`);
  }
  for (const word of words) {
    if (!artifact.answerKey.some((line) => line.startsWith(`${word}:`))) {
      keyProblems.push(`${word} is in the word list and not in the key`);
    }
  }
  checks.push(
    check(
      'the answer key points at the words',
      keyProblems.length === 0,
      keyProblems.length === 0
        ? 'Every key line was followed in the grid and read the word it names.'
        : keyProblems.join('; '),
    ),
  );

  /*
   * The screen.
   *
   * Reported as what it is: this list, in eight directions, and nothing
   * wider. A grid that passes has not been declared clean — it has been
   * checked against the unambiguous cases, which is a smaller and honest
   * claim.
   */
  const hits: string[] = [];
  for (const banned of PROHIBITED_STRINGS) {
    const found = occurrencesOf(grid, banned);
    if (found.length > 0) {
      const at = found[0] as Found;
      hits.push(`${banned} at row ${at.row + 1}, column ${at.col + 1}, ${at.direction}`);
    }
  }
  checks.push(
    check(
      'no prohibited string formed by accident',
      hits.length === 0,
      hits.length === 0
        ? `Screened against ${PROHIBITED_STRINGS.length} prohibited strings in eight ` +
          'directions. That is a check against the unambiguous cases, not a claim that the ' +
          'grid is clean of everything.'
        : `Formed by the filler: ${hits.join('; ')}.`,
    ),
  );

  /*
   * Difficulty, measured from the grid rather than asserted.
   *
   * What makes a word search hard is how much of the grid is filler a solver
   * has to read past, and how many words run backwards or diagonally. Both
   * are read off the printed artifact.
   */
  let measured: PuzzleDifficulty | null = null;
  if (missing.length === 0 && words.length > 0) {
    const letters = grid.length * width;
    const placedLetters = words.reduce((sum, word) => sum + word.length, 0);
    const fillerShare = letters === 0 ? 1 : 1 - placedLetters / letters;
    const awkward = [...positions.values()].filter(
      (one) => one.direction !== 'right' && one.direction !== 'down',
    ).length;
    const awkwardShare = words.length === 0 ? 0 : awkward / words.length;
    measured = bandFor(fillerShare * 0.6 + awkwardShare * 0.4, [0.35, 0.55, 0.75]);
  }

  /*
   * Two grids with the same letters in the same places are one puzzle whatever
   * their word lists say, so the canonical form is the grid alone. Word
   * searches have no rotation equivalence worth taking: a rotated grid is a
   * genuinely different reading experience and its key is different.
   */
  return verdictFrom(checks, measured, sha256(`wordsearch:${grid.join('|')}`));
}

export const WORD_SEARCH: PuzzleFormat = {
  key: WORD_SEARCH_KEY,
  title: 'Word search',
  authoring: 'GENERATED',
  requiresHumanEdit: false,
  limitation:
    'Every listed word is found by searching the printed grid, and a word that reads in two ' +
    'places is refused because the key can only name one. The prohibited-string screen covers ' +
    'a short explicit list in eight directions and is not a claim that a grid contains nothing ' +
    'objectionable. Difficulty is read from filler density and how many words run backwards or ' +
    'diagonally, which is a property of the grid rather than of a solver.',
  render,
  validate,
  /*
   * Bounded in principle by the corpus and the grid, and unbounded in
   * practice: the placements of ten words drawn from two hundred into a
   * twelve-by-twelve grid run to more than anybody will print, so a number
   * here would be a guess dressed as a limit.
   */
  catalogCeiling: null,
};
