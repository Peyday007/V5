/**
 * Crossword: a validator with no generator, and that is the honest shape.
 *
 * ---------------------------------------------------------------------------
 * Why there is deliberately no `render`
 * ---------------------------------------------------------------------------
 *
 * A crossword is two editorial artifacts wearing one grid. The fill has to be
 * words a solver has heard of, in a pattern that interlocks, without the dreck
 * that makes a puzzle feel cheap; the clues have to be fair, consistent in
 * tense and number with their answers, and interesting. Neither is a
 * constraint-satisfaction problem with a correctness criterion, which is
 * exactly why the operator's brief says crosswords are **authored** and
 * human-edited.
 *
 * A generator here would produce grids full of obscure three-letter fill
 * clued from a template — the unvalidated filler this kernel exists to refuse,
 * with the added insult of being expensive to print. So `render` is null, the
 * format declares `authoring: 'AUTHORED'`, and `services/puzzle/maturity.ts`
 * stops it at RESEARCHED until somebody actually writes one.
 *
 * What Brain *can* do is check one, and that is worth a great deal on its own:
 * every structural property a crossword editor checks by eye is mechanical,
 * and an editor who is told the grid has an unchecked square or a two-letter
 * entry before they start writing clues has been saved an afternoon.
 *
 * ---------------------------------------------------------------------------
 * The representation
 * ---------------------------------------------------------------------------
 *
 * `grid` is the empty puzzle: `.` for a white square, `#` for a block.
 * `solution` is the same rectangle with the letters in. `prompts` are clue
 * lines — `12A Something to do with anchors` — and `answerKey` pairs the same
 * labels with the answers. Numbering is derived from the block pattern the way
 * every crossword numbers, so a label in a clue that the grid does not produce
 * is a finding rather than a mystery.
 */
import {
  check,
  sha256,
  verdictFrom,
  type PuzzleArtifact,
  type PuzzleCheck,
  type PuzzleFormat,
  type PuzzleVerdict,
} from './engine.ts';

export const CROSSWORD_KEY = 'crossword';

const BLOCK = '#';
const WHITE = '.';

interface Entry {
  label: string;
  row: number;
  col: number;
  length: number;
  across: boolean;
}

/**
 * The entries a block pattern produces, numbered the standard way.
 *
 * A square starts an across entry when it is white, the square to its left is
 * not, and the square to its right is; a down entry likewise. A square that
 * starts either takes the next number. This is mechanical and is the reason
 * clue labels can be checked at all.
 */
export function entriesOf(grid: readonly string[]): Entry[] {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const white = (r: number, c: number): boolean =>
    r >= 0 && r < height && c >= 0 && c < width && (grid[r] ?? '')[c] !== BLOCK;

  const out: Entry[] = [];
  let number = 0;
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if (!white(r, c)) continue;
      const startsAcross = !white(r, c - 1) && white(r, c + 1);
      const startsDown = !white(r - 1, c) && white(r + 1, c);
      if (!startsAcross && !startsDown) continue;
      number += 1;
      if (startsAcross) {
        let length = 0;
        while (white(r, c + length)) length += 1;
        out.push({ label: `${number}A`, row: r, col: c, length, across: true });
      }
      if (startsDown) {
        let length = 0;
        while (white(r + length, c)) length += 1;
        out.push({ label: `${number}D`, row: r, col: c, length, across: false });
      }
    }
  }
  return out;
}

function readEntry(solution: readonly string[], entry: Entry): string {
  let out = '';
  for (let i = 0; i < entry.length; i += 1) {
    const r = entry.row + (entry.across ? 0 : i);
    const c = entry.col + (entry.across ? i : 0);
    out += (solution[r] ?? '')[c] ?? '';
  }
  return out;
}

function validate(artifact: PuzzleArtifact): PuzzleVerdict {
  const checks: PuzzleCheck[] = [];
  const grid = artifact.grid;
  const solution = artifact.solution;
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const rectangular =
    height >= 3 && width >= 3 && grid.every((row) => row.length === width);
  checks.push(
    check(
      'the grid is a rectangle',
      rectangular,
      rectangular ? `${height} by ${width}.` : 'The rows are not all one length.',
    ),
  );
  if (!rectangular) return verdictFrom(checks, null, sha256(`crossword:${grid.join('|')}`));

  const legalChars = grid.every((row) => /^[.#]+$/.test(row));
  checks.push(
    check(
      'the empty grid is blocks and white squares only',
      legalChars,
      legalChars
        ? 'Every character is a block or a white square.'
        : 'The empty grid holds characters that are neither a block nor a white square, so a ' +
          'solver would be given some of the answers.',
    ),
  );

  const shapesMatch =
    solution.length === height &&
    solution.every((row, r) => {
      if (row.length !== width) return false;
      for (let c = 0; c < width; c += 1) {
        const isBlock = (grid[r] ?? '')[c] === BLOCK;
        const filled = row[c] ?? '';
        if (isBlock !== (filled === BLOCK)) return false;
        if (!isBlock && !/^[A-Z]$/.test(filled)) return false;
      }
      return true;
    });
  checks.push(
    check(
      'the filled grid matches the empty one',
      shapesMatch,
      shapesMatch
        ? 'Every block is a block in both, and every white square holds one letter.'
        : 'The filled grid and the empty grid disagree about where the blocks are, or a white ' +
          'square is not a single letter.',
    ),
  );

  /*
   * Rotational symmetry.
   *
   * A convention rather than a law of nature, and it is checked because it is
   * the convention every publisher this kernel could sell to actually applies.
   * A grid without it is not broken; it is unsellable to most of the market,
   * which is a thing an author should be told before they write sixty clues.
   */
  let symmetric = true;
  for (let r = 0; r < height && symmetric; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const here = (grid[r] ?? '')[c] === BLOCK;
      const opposite = (grid[height - 1 - r] ?? '')[width - 1 - c] === BLOCK;
      if (here !== opposite) {
        symmetric = false;
        break;
      }
    }
  }
  checks.push(
    check(
      'the block pattern has half-turn symmetry',
      symmetric,
      symmetric
        ? 'The grid reads the same rotated through half a turn.'
        : 'The block pattern is not symmetric under a half turn, which most publishers refuse ' +
          'on sight.',
    ),
  );

  const entries = entriesOf(grid);
  const short = entries.filter((one) => one.length < 3);
  checks.push(
    check(
      'no entry is shorter than three letters',
      short.length === 0,
      short.length === 0
        ? `${entries.length} entries, the shortest ${Math.min(...entries.map((one) => one.length))} letters.`
        : `Two-letter entries: ${short.map((one) => one.label).join(', ')}.`,
    ),
  );

  /*
   * Every white square checked in both directions.
   *
   * An unchecked square is one a solver can only get from a single clue, with
   * nothing crossing it to confirm. It is the single most common structural
   * defect in an amateur grid and it is invisible unless somebody counts.
   */
  const covered = new Map<string, { across: boolean; down: boolean }>();
  for (const entry of entries) {
    for (let i = 0; i < entry.length; i += 1) {
      const r = entry.row + (entry.across ? 0 : i);
      const c = entry.col + (entry.across ? i : 0);
      const key = `${r},${c}`;
      const at = covered.get(key) ?? { across: false, down: false };
      if (entry.across) at.across = true;
      else at.down = true;
      covered.set(key, at);
    }
  }
  const unchecked: string[] = [];
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if ((grid[r] ?? '')[c] === BLOCK) continue;
      const at = covered.get(`${r},${c}`);
      if (!at || !at.across || !at.down) unchecked.push(`row ${r + 1}, column ${c + 1}`);
    }
  }
  checks.push(
    check(
      'every white square is crossed both ways',
      unchecked.length === 0,
      unchecked.length === 0
        ? 'Every white square belongs to an across entry and a down entry.'
        : `Unchecked squares at ${unchecked.slice(0, 6).join('; ')}${
            unchecked.length > 6 ? `, and ${unchecked.length - 6} more` : ''
          }.`,
    ),
  );

  /*
   * Connectivity. A grid in two halves is two crosswords printed together,
   * and a solver who finishes one is stuck with no way in to the other.
   */
  let firstWhite: [number, number] | null = null;
  let whiteCount = 0;
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      if ((grid[r] ?? '')[c] === BLOCK) continue;
      whiteCount += 1;
      if (!firstWhite) firstWhite = [r, c];
    }
  }
  let reached = 0;
  if (firstWhite) {
    const seen = new Set<string>([`${firstWhite[0]},${firstWhite[1]}`]);
    const queue: [number, number][] = [firstWhite];
    while (queue.length > 0) {
      const [r, c] = queue.shift() as [number, number];
      for (const [dr, dc] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ] as const) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= height || cc < 0 || cc >= width) continue;
        if ((grid[rr] ?? '')[cc] === BLOCK) continue;
        const key = `${rr},${cc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([rr, cc]);
      }
    }
    reached = seen.size;
  }
  checks.push(
    check(
      'the white squares are all connected',
      reached === whiteCount,
      reached === whiteCount
        ? `All ${whiteCount} white squares form one region.`
        : `${whiteCount - reached} white square(s) are cut off from the rest of the grid.`,
    ),
  );

  /* Clues and answers, each checked against the labels the grid produces. */
  const clueLabels = new Set<string>();
  const badClues: string[] = [];
  for (const line of artifact.prompts) {
    const match = /^(\d+[AD])\s+\S/.exec(line);
    if (!match) {
      badClues.push(`unreadable clue line "${line}"`);
      continue;
    }
    clueLabels.add(match[1] as string);
  }
  const missingClues = entries.filter((one) => !clueLabels.has(one.label)).map((one) => one.label);
  const strayClues = [...clueLabels].filter(
    (label) => !entries.some((one) => one.label === label),
  );
  checks.push(
    check(
      'there is exactly one clue per entry',
      badClues.length === 0 && missingClues.length === 0 && strayClues.length === 0,
      badClues.length === 0 && missingClues.length === 0 && strayClues.length === 0
        ? `${entries.length} entries, ${clueLabels.size} clues, labels agreeing.`
        : [
            ...badClues,
            missingClues.length > 0 ? `no clue for ${missingClues.join(', ')}` : '',
            strayClues.length > 0 ? `clues for entries the grid has none of: ${strayClues.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
    ),
  );

  const keyProblems: string[] = [];
  const answered = new Map<string, string>();
  for (const line of artifact.answerKey) {
    const match = /^(\d+[AD])\s+([A-Z]+)$/.exec(line);
    if (!match) {
      keyProblems.push(`unreadable key line "${line}"`);
      continue;
    }
    answered.set(match[1] as string, match[2] as string);
  }
  if (shapesMatch) {
    for (const entry of entries) {
      const stated = answered.get(entry.label);
      const inGrid = readEntry(solution, entry);
      if (stated === undefined) keyProblems.push(`no answer given for ${entry.label}`);
      else if (stated !== inGrid) {
        keyProblems.push(`${entry.label} is "${stated}" in the key and "${inGrid}" in the grid`);
      }
    }
  }
  checks.push(
    check(
      'the answer list is what the grid spells',
      keyProblems.length === 0,
      keyProblems.length === 0
        ? 'Every entry was read out of the filled grid and matched the answer list.'
        : keyProblems.slice(0, 6).join('; '),
    ),
  );

  const seenAnswers = new Map<string, string[]>();
  for (const [label, word] of answered) {
    seenAnswers.set(word, [...(seenAnswers.get(word) ?? []), label]);
  }
  const repeated = [...seenAnswers.entries()].filter(([, labels]) => labels.length > 1);
  checks.push(
    check(
      'no answer is used twice',
      repeated.length === 0,
      repeated.length === 0
        ? 'Every answer appears once.'
        : repeated.map(([word, labels]) => `${word} at ${labels.join(' and ')}`).join('; '),
    ),
  );

  /*
   * No measured difficulty, and that is not a gap to fill later.
   *
   * What makes a crossword hard is how obliquely its clues are written, which
   * is a property of English prose. A number derived from word lengths would
   * look like a measurement and be a guess — §8 at a column — so this format
   * reports null and its limitation says why.
   */
  return verdictFrom(checks, null, sha256(`crossword:${solution.join('|')}`));
}

export const CROSSWORD: PuzzleFormat = {
  key: CROSSWORD_KEY,
  title: 'Crossword',
  authoring: 'AUTHORED',
  requiresHumanEdit: true,
  limitation:
    'Brain can check a crossword and cannot write one: the fill and the clues are editorial ' +
    'work with no correctness criterion, so there is no generator here rather than a bad one. ' +
    'Every structural property is checked from the printed grid — symmetry, minimum entry ' +
    'length, every square crossed both ways, connectivity, one clue per entry, and the answer ' +
    'list against what the grid actually spells. Difficulty is NOT measured, because what ' +
    'makes a crossword hard is how its clues are written.',
  render: null,
  validate,
  /* Nothing generates it, so there is no catalog for a ceiling to bound. */
  catalogCeiling: null,
};
