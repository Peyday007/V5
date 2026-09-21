/**
 * A word-search generator and an independent word-search validator.
 *
 * ---------------------------------------------------------------------------
 * The word list is the master's, never this module's
 * ---------------------------------------------------------------------------
 *
 * `params.words` and `params.prohibited` both come from the master, which
 * carries a `rights_basis` the schema refuses to let it exist without. That is
 * the directive's rights standard made structural at the one format where it
 * bites hardest: a word list is exactly the kind of asset that gets scraped,
 * and a generator with a list baked into it is a generator whose provenance
 * nobody recorded.
 *
 * It also keeps a screening list out of this repository. `PROHIBITED_CONTENT`
 * is a real check and it is run against **the master's own list**, so what
 * counts as unacceptable is a decision a person made for a product and an
 * audience rather than a constant somebody typed once.
 *
 * ---------------------------------------------------------------------------
 * Three checks that look like one and are not
 * ---------------------------------------------------------------------------
 *
 * `COORDINATE_AGREEMENT` asks whether each word reads at the coordinates the
 * answer key gives. `SOLVABILITY` asks whether it is in the grid **at all**,
 * found by an independent scan that ignores the key. `ANSWER_KEY_AGREEMENT`
 * asks whether the key covers exactly the listed words — no extras, none
 * missing.
 *
 * They come apart in real failures. A placement that was overwritten by a
 * later word still passes solvability if it happens to appear elsewhere and
 * fails coordinate agreement; a key with a word the puzzle never listed passes
 * both and fails the third. Collapsing them into one "the words are there"
 * check is how a book ships with an answer key pointing at the wrong squares.
 */
import { rngFor } from './rng.ts';
import type { Generated, GenerateResult, PuzzleEngine } from './types.ts';
import type { PuzzlePayload, ValidationCheckResult } from '../../../domain/types.ts';

const ENGINE_ID = 'wordsearch_grid';
const ENGINE_VERSION = '1.0.0';

/** The eight directions a word may run. */
const DIRECTIONS: readonly { dr: number; dc: number; name: string }[] = [
  { dr: 0, dc: 1, name: 'E' },
  { dr: 0, dc: -1, name: 'W' },
  { dr: 1, dc: 0, name: 'S' },
  { dr: -1, dc: 0, name: 'N' },
  { dr: 1, dc: 1, name: 'SE' },
  { dr: 1, dc: -1, name: 'SW' },
  { dr: -1, dc: 1, name: 'NE' },
  { dr: -1, dc: -1, name: 'NW' },
];

interface Placement {
  word: string;
  row: number;
  col: number;
  dr: number;
  dc: number;
}

type Grid = string[][];

const cellAt = (grid: Grid, row: number, col: number): string | null => {
  const line = grid[row];
  if (!line) return null;
  return line[col] ?? null;
};

/** Read whatever runs from (row, col) in (dr, dc) for `length` cells, or null off the edge. */
function readRun(
  grid: Grid,
  row: number,
  col: number,
  dr: number,
  dc: number,
  length: number,
): string | null {
  let out = '';
  for (let step = 0; step < length; step += 1) {
    const value = cellAt(grid, row + dr * step, col + dc * step);
    if (value === null) return null;
    out += value;
  }
  return out;
}

/** Every maximal straight line through the grid, in all eight directions. */
function allLines(grid: Grid): string[] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const lines: string[] = [];
  const walk = (row: number, col: number, dr: number, dc: number): void => {
    let out = '';
    let r = row;
    let c = col;
    for (;;) {
      const value = cellAt(grid, r, c);
      if (value === null) break;
      out += value;
      r += dr;
      c += dc;
    }
    if (out.length > 0) {
      lines.push(out);
      lines.push([...out].reverse().join(''));
    }
  };
  for (let row = 0; row < rows; row += 1) walk(row, 0, 0, 1);
  for (let col = 0; col < cols; col += 1) walk(0, col, 1, 0);
  for (let row = 0; row < rows; row += 1) walk(row, 0, 1, 1);
  for (let col = 1; col < cols; col += 1) walk(0, col, 1, 1);
  for (let row = 0; row < rows; row += 1) walk(row, cols - 1, 1, -1);
  for (let col = cols - 2; col >= 0; col -= 1) walk(0, col, 1, -1);
  return lines;
}

const normalizeWord = (value: string): string => value.replace(/[^A-Za-z]/g, '').toUpperCase();

function readWords(params: Record<string, unknown>, key: string): string[] {
  const raw = params[key];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const word = normalizeWord(entry);
    if (word.length >= 2 && !out.includes(word)) out.push(word);
  }
  return out;
}

function readGrid(value: unknown): Grid | null {
  if (!value || typeof value !== 'object') return null;
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const grid: Grid = [];
  let width: number | null = null;
  for (const row of rows) {
    if (typeof row !== 'string') return null;
    if (width === null) width = row.length;
    if (row.length !== width || width === 0) return null;
    if (!/^[A-Z]+$/.test(row)) return null;
    grid.push([...row]);
  }
  return grid;
}

function readPlacements(value: unknown): Placement[] | null {
  if (!value || typeof value !== 'object') return null;
  const entries = (value as { placements?: unknown }).placements;
  if (!Array.isArray(entries)) return null;
  const out: Placement[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return null;
    const one = entry as Record<string, unknown>;
    if (
      typeof one['word'] !== 'string' ||
      typeof one['row'] !== 'number' ||
      typeof one['col'] !== 'number' ||
      typeof one['dr'] !== 'number' ||
      typeof one['dc'] !== 'number'
    ) {
      return null;
    }
    out.push({
      word: one['word'],
      row: one['row'],
      col: one['col'],
      dr: one['dr'],
      dc: one['dc'],
    });
  }
  return out;
}

function generate(input: { seed: string; params: Record<string, unknown> }): GenerateResult {
  const rng = rngFor(`${ENGINE_ID}@${ENGINE_VERSION}:${input.seed}`);
  const words = readWords(input.params, 'words');
  if (words.length === 0) {
    return {
      ok: false,
      error:
        'This master declares no word list. A word search is its corpus, and a generator with ' +
        'a list of its own would be one whose provenance nobody recorded.',
    };
  }
  const prohibited = readWords(input.params, 'prohibited');

  const requestedSize = input.params['size'];
  const longest = words.reduce((max, word) => Math.max(max, word.length), 0);
  const size =
    typeof requestedSize === 'number' && Number.isInteger(requestedSize)
      ? Math.max(requestedSize, longest)
      : Math.max(longest + 2, 12);
  if (size > 40) {
    return { ok: false, error: `A grid of ${size} squares a side is outside what this engine builds.` };
  }

  const grid: Grid = Array.from({ length: size }, () => new Array<string>(size).fill(''));
  const placements: Placement[] = [];

  // Longest first: a long word placed late has almost nowhere left to go, and
  // a failure to place it is the common way a generator silently drops a word.
  const ordered = [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  for (const word of ordered) {
    let placed = false;
    const starts = rng.shuffled(Array.from({ length: size * size }, (_, index) => index));
    for (const start of starts) {
      if (placed) break;
      const row = Math.floor(start / size);
      const col = start % size;
      for (const direction of rng.shuffled(DIRECTIONS)) {
        const endRow = row + direction.dr * (word.length - 1);
        const endCol = col + direction.dc * (word.length - 1);
        if (endRow < 0 || endRow >= size || endCol < 0 || endCol >= size) continue;
        let fits = true;
        for (let step = 0; step < word.length; step += 1) {
          const held = cellAt(grid, row + direction.dr * step, col + direction.dc * step);
          const letter = word[step] as string;
          // An empty cell or the same letter: overlapping words share letters,
          // which is what makes a grid tight rather than a list in a box.
          if (held !== '' && held !== letter) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        for (let step = 0; step < word.length; step += 1) {
          const line = grid[row + direction.dr * step];
          if (line) line[col + direction.dc * step] = word[step] as string;
        }
        placements.push({ word, row, col, dr: direction.dr, dc: direction.dc });
        placed = true;
        break;
      }
    }
    if (!placed) {
      /*
       * Refused rather than dropped. A generator that quietly omitted a word
       * would produce a puzzle whose word list cannot be completed, and the
       * customer would be the one to find out — §27's rule that the one
       * outcome a caller cannot recover from is the one reported as success.
       */
      return {
        ok: false,
        error: `"${word}" could not be placed in a ${size}-square grid with the others.`,
      };
    }
  }

  /*
   * Fill from the alphabet the words themselves use. A uniform A-Z fill is the
   * usual choice and makes the puzzle slightly easier to scan; drawing from
   * the words' own letters keeps the noise in the same distribution as the
   * signal, which is the whole difficulty of the format.
   */
  const alphabet = [...new Set(words.join('').split(''))].sort();
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const line = grid[row];
      if (line && line[col] === '') line[col] = rng.pick(alphabet) ?? 'E';
    }
  }

  const rows = grid.map((line) => line.join(''));
  const payload: PuzzlePayload = {
    puzzle: { rows, words },
    solution: { placements },
    answerKey: {
      entries: placements.map((one) => ({
        word: one.word,
        // One-based, because this is the printed form a person reads.
        row: one.row + 1,
        col: one.col + 1,
        direction:
          DIRECTIONS.find((d) => d.dr === one.dr && d.dc === one.dc)?.name ??
          `${one.dr},${one.dc}`,
      })),
    },
    instructions:
      'Find every word in the list. Words run in any of the eight directions, including ' +
      'backwards and diagonally, and may share letters with each other.',
    meta: { size, wordCount: words.length, prohibitedScreened: prohibited.length, engine: ENGINE_ID },
  };

  const value: Generated = {
    payload,
    difficulty: words.length >= 20 ? 'HARD' : words.length >= 12 ? 'MEDIUM' : 'EASY',
    expectedSolveSeconds: words.length * 25,
    locale: typeof input.params['locale'] === 'string' ? (input.params['locale'] as string) : null,
  };
  return { ok: true, value };
}

function validate(input: {
  payload: PuzzlePayload;
  params: Record<string, unknown>;
  declaredDifficulty: string | null;
}): ValidationCheckResult[] {
  const results: ValidationCheckResult[] = [];
  const grid = readGrid(input.payload.puzzle);
  const listed = Array.isArray((input.payload.puzzle as { words?: unknown } | null)?.words)
    ? ((input.payload.puzzle as { words: unknown[] }).words.filter(
        (one): one is string => typeof one === 'string',
      ) as string[])
    : [];

  if (!grid) {
    return [
      {
        check: 'GRID_LEGALITY',
        ok: false,
        detail: 'The payload carries no rectangular grid of uppercase letters.',
      },
    ];
  }
  results.push({
    check: 'GRID_LEGALITY',
    ok: true,
    detail: `A rectangular ${grid.length}x${grid[0]?.length ?? 0} grid of uppercase letters.`,
  });

  const placements = readPlacements(input.payload.solution);

  /* Does each word read where the key says it does? */
  if (!placements) {
    results.push({
      check: 'COORDINATE_AGREEMENT',
      ok: false,
      detail: 'The payload records no placements, so no coordinate can be checked.',
    });
  } else {
    const wrong = placements.filter(
      (one) => readRun(grid, one.row, one.col, one.dr, one.dc, one.word.length) !== one.word,
    );
    results.push({
      check: 'COORDINATE_AGREEMENT',
      ok: wrong.length === 0,
      detail:
        wrong.length === 0
          ? `All ${placements.length} recorded placements read as their word.`
          : `${wrong.length} placement(s) do not read as their word, starting with ` +
            `"${wrong[0]?.word}" — the answer key points at the wrong squares.`,
    });
  }

  /*
   * Independently of the key: is each listed word findable at all? A word
   * overwritten by a later placement fails here even when the key still names
   * its old coordinates, which is the defect the two checks exist to separate.
   */
  const missing = listed.filter((word) => {
    const target = normalizeWord(word);
    return !allLines(grid).some((line) => line.includes(target));
  });
  results.push({
    check: 'SOLVABILITY',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `All ${listed.length} listed words appear somewhere in the grid.`
        : `${missing.length} listed word(s) are not in the grid at all, starting with ` +
          `"${missing[0]}" — the list cannot be completed.`,
  });

  /* Does the key cover exactly the list? */
  if (!placements) {
    results.push({
      check: 'ANSWER_KEY_AGREEMENT',
      ok: false,
      detail: 'There are no recorded placements for the answer key to agree with.',
    });
  } else {
    const keyed = new Set(placements.map((one) => normalizeWord(one.word)));
    const wanted = new Set(listed.map(normalizeWord));
    const unkeyed = [...wanted].filter((word) => !keyed.has(word));
    const extra = [...keyed].filter((word) => !wanted.has(word));
    results.push({
      check: 'ANSWER_KEY_AGREEMENT',
      ok: unkeyed.length === 0 && extra.length === 0,
      detail:
        unkeyed.length === 0 && extra.length === 0
          ? 'The answer key covers exactly the listed words.'
          : `${unkeyed.length} listed word(s) have no answer and ${extra.length} answer(s) name ` +
            'a word the puzzle never listed.',
    });
  }

  /*
   * The screening list is the master's, so what counts as unacceptable is a
   * decision somebody made for this product and this audience. With no list
   * declared the check is reported as run against nothing rather than as a
   * pass, because "we screened against an empty list" and "there is nothing
   * objectionable here" are different statements.
   */
  const prohibited = readWords(input.params, 'prohibited');
  if (prohibited.length === 0) {
    results.push({
      check: 'PROHIBITED_CONTENT',
      ok: true,
      detail:
        'This master declares no screening list, so nothing was screened for. That is not the ' +
        'same fact as nothing objectionable being present.',
    });
  } else {
    const lines = allLines(grid);
    const hits = prohibited.filter((word) => lines.some((line) => line.includes(word)));
    results.push({
      check: 'PROHIBITED_CONTENT',
      ok: hits.length === 0,
      detail:
        hits.length === 0
          ? `None of the ${prohibited.length} screened strings appear in any of the eight ` +
            'reading directions.'
          : `${hits.length} screened string(s) appear accidentally in the grid.`,
    });
  }

  return results;
}

export const wordSearchEngine: PuzzleEngine = {
  id: ENGINE_ID,
  version: ENGINE_VERSION,
  formatKey: 'word search',
  summary:
    "Places a master's own word list in eight directions with shared letters, fills from the " +
    'list’s own alphabet, and screens every reading direction against the master’s ' +
    'own prohibited-string list.',
  implementsChecks: [
    'GRID_LEGALITY',
    'COORDINATE_AGREEMENT',
    'SOLVABILITY',
    'ANSWER_KEY_AGREEMENT',
    'PROHIBITED_CONTENT',
  ],
  generate,
  validate,
};
