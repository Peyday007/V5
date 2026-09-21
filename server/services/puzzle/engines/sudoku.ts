/**
 * A Sudoku generator and an independent Sudoku validator.
 *
 * ---------------------------------------------------------------------------
 * Why this format is where the kernel starts
 * ---------------------------------------------------------------------------
 *
 * Solution uniqueness is the check the directive names first, and it is one of
 * the very few puzzle properties that can be **proved** rather than judged: a
 * complete search either finds exactly one completion or it does not. A
 * generator can be wrong about it, a person eyeballing a grid cannot see it,
 * and a book full of grids with two solutions is the exact commercial failure
 * this whole kernel exists to make impossible.
 *
 * So the validator does not trust the generator by a single line of code. It
 * takes the puzzle grid, searches it from scratch, and compares what it found
 * against the recorded solution and the recorded answer key. A generator that
 * carved a second solution in, or recorded the wrong grid, or rendered the
 * answer key from stale state, is caught rather than believed.
 *
 * ---------------------------------------------------------------------------
 * The difficulty reading is a measurement, not a label
 * ---------------------------------------------------------------------------
 *
 * `grade` solves the puzzle with a ladder of techniques and reports the
 * cheapest rung that finishes it: singles only, singles plus hidden singles,
 * or a search. That is modest and it is genuinely a reading — the recorded
 * difficulty is whatever the grader measured rather than whatever the caller
 * asked for, and `DIFFICULTY_CALIBRATION` re-measures it independently. A
 * generator that aimed at EASY and produced a grid needing a search records
 * HARD, which is the honest outcome.
 */
import { rngFor } from './rng.ts';
import type { Generated, GenerateResult, PuzzleEngine } from './types.ts';
import type { PuzzlePayload, ValidationCheckResult } from '../../../domain/types.ts';

const SIZE = 9;
const CELLS = SIZE * SIZE;

/** Every cell that shares a row, column or box with this one. Computed once. */
const PEERS: readonly (readonly number[])[] = (() => {
  const peers: number[][] = [];
  for (let cell = 0; cell < CELLS; cell += 1) {
    const row = Math.floor(cell / SIZE);
    const col = cell % SIZE;
    const boxRow = Math.floor(row / 3) * 3;
    const boxCol = Math.floor(col / 3) * 3;
    const set = new Set<number>();
    for (let index = 0; index < SIZE; index += 1) {
      set.add(row * SIZE + index);
      set.add(index * SIZE + col);
    }
    for (let dr = 0; dr < 3; dr += 1) {
      for (let dc = 0; dc < 3; dc += 1) {
        set.add((boxRow + dr) * SIZE + boxCol + dc);
      }
    }
    set.delete(cell);
    peers.push([...set].sort((a, b) => a - b));
  }
  return peers;
})();

/** The twenty-seven units: nine rows, nine columns, nine boxes. */
const UNITS: readonly (readonly number[])[] = (() => {
  const units: number[][] = [];
  for (let row = 0; row < SIZE; row += 1) {
    units.push(Array.from({ length: SIZE }, (_, col) => row * SIZE + col));
  }
  for (let col = 0; col < SIZE; col += 1) {
    units.push(Array.from({ length: SIZE }, (_, row) => row * SIZE + col));
  }
  for (let boxRow = 0; boxRow < SIZE; boxRow += 3) {
    for (let boxCol = 0; boxCol < SIZE; boxCol += 3) {
      const cells: number[] = [];
      for (let dr = 0; dr < 3; dr += 1) {
        for (let dc = 0; dc < 3; dc += 1) cells.push((boxRow + dr) * SIZE + boxCol + dc);
      }
      units.push(cells);
    }
  }
  return units;
})();

type Grid = number[];

const at = (grid: Grid, cell: number): number => grid[cell] ?? 0;

function candidatesFor(grid: Grid, cell: number): number[] {
  const used = new Array<boolean>(10).fill(false);
  for (const peer of PEERS[cell] ?? []) {
    const value = at(grid, peer);
    if (value > 0) used[value] = true;
  }
  const out: number[] = [];
  for (let digit = 1; digit <= 9; digit += 1) if (!used[digit]) out.push(digit);
  return out;
}

/** Whether the filled cells conflict with each other. Says nothing about solvability. */
function isLegal(grid: Grid): boolean {
  for (const unit of UNITS) {
    const seen = new Array<boolean>(10).fill(false);
    for (const cell of unit) {
      const value = at(grid, cell);
      if (value === 0) continue;
      if (value < 1 || value > 9) return false;
      if (seen[value]) return false;
      seen[value] = true;
    }
  }
  return true;
}

/**
 * Count completions, stopping at `limit`.
 *
 * `limit` is what makes uniqueness affordable: the carver asks for at most two
 * and stops the instant a second exists, so the search never enumerates a
 * grid's whole solution space.
 *
 * `order` lets the caller randomize candidate order, which is what turns the
 * same search into a generator.
 */
function search(
  grid: Grid,
  limit: number,
  order?: (digits: number[]) => number[],
): { count: number; first: Grid | null } {
  let count = 0;
  let first: Grid | null = null;

  const step = (working: Grid): boolean => {
    // Minimum-remaining-values: take the most constrained cell, which prunes
    // hardest and makes an unsolvable branch fail immediately.
    let best = -1;
    let bestCandidates: number[] | null = null;
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (at(working, cell) !== 0) continue;
      const candidates = candidatesFor(working, cell);
      if (candidates.length === 0) return false;
      if (!bestCandidates || candidates.length < bestCandidates.length) {
        best = cell;
        bestCandidates = candidates;
        if (candidates.length === 1) break;
      }
    }
    if (best === -1 || !bestCandidates) {
      count += 1;
      if (!first) first = [...working];
      return count >= limit;
    }
    const digits = order ? order(bestCandidates) : bestCandidates;
    for (const digit of digits) {
      working[best] = digit;
      const stop = step(working);
      working[best] = 0;
      if (stop) return true;
    }
    return false;
  };

  step([...grid]);
  return { count, first };
}

/* --------------------------------------------------------------------------
 * The difficulty ladder
 * ------------------------------------------------------------------------ */

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type SudokuDifficulty = (typeof DIFFICULTIES)[number];

/** Fill every cell that has exactly one candidate. Returns whether it progressed. */
function nakedSingles(grid: Grid): boolean {
  let progressed = false;
  for (let cell = 0; cell < CELLS; cell += 1) {
    if (at(grid, cell) !== 0) continue;
    const candidates = candidatesFor(grid, cell);
    if (candidates.length === 1) {
      grid[cell] = candidates[0] as number;
      progressed = true;
    }
  }
  return progressed;
}

/** Fill every cell that is the only place in its unit a digit can go. */
function hiddenSingles(grid: Grid): boolean {
  let progressed = false;
  for (const unit of UNITS) {
    for (let digit = 1; digit <= 9; digit += 1) {
      let place = -1;
      let seen = false;
      let already = false;
      for (const cell of unit) {
        if (at(grid, cell) === digit) {
          already = true;
          break;
        }
        if (at(grid, cell) !== 0) continue;
        if (!candidatesFor(grid, cell).includes(digit)) continue;
        if (seen) {
          place = -1;
          break;
        }
        seen = true;
        place = cell;
      }
      if (!already && place >= 0) {
        grid[place] = digit;
        progressed = true;
      }
    }
  }
  return progressed;
}

const isComplete = (grid: Grid): boolean => grid.every((value) => value > 0);

/**
 * The cheapest technique ladder that finishes this grid.
 *
 * A reading rather than a label. It is deliberately a short ladder: a longer
 * one would look more precise and would be the same guess with more names on
 * it, and the directive's own requirement is that difficulty be *calibrated*
 * rather than asserted — which means measured the same way twice, by the
 * generator and by the validator, and found to agree.
 */
export function grade(puzzle: Grid): SudokuDifficulty {
  const easy = [...puzzle];
  while (nakedSingles(easy)) {
    /* keep going until it stops helping */
  }
  if (isComplete(easy)) return 'EASY';

  const medium = [...puzzle];
  for (;;) {
    const progressed = nakedSingles(medium) || hiddenSingles(medium);
    if (!progressed) break;
  }
  if (isComplete(medium)) return 'MEDIUM';

  return 'HARD';
}

/* --------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------ */

/**
 * The printed answer key: nine rows of nine digits.
 *
 * Its own function, and `ANSWER_KEY_AGREEMENT` re-runs it and compares. That
 * is not a formality — the answer key is the one artifact in a printed book
 * that nobody proofreads by solving, so a rendering that drifted from the
 * solution grid would ship, and the first person to notice would be a customer
 * who could not finish a puzzle.
 */
export function renderAnswerKey(solution: Grid): string[] {
  const rows: string[] = [];
  for (let row = 0; row < SIZE; row += 1) {
    let line = '';
    for (let col = 0; col < SIZE; col += 1) line += String(at(solution, row * SIZE + col));
    rows.push(line);
  }
  return rows;
}

interface SudokuPuzzleShape {
  size: number;
  grid: number[];
}

function readGrid(value: unknown): Grid | null {
  if (!value || typeof value !== 'object') return null;
  const grid = (value as { grid?: unknown }).grid;
  if (!Array.isArray(grid) || grid.length !== CELLS) return null;
  const out: number[] = [];
  for (const cell of grid) {
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell > 9) return null;
    out.push(cell);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * The engine
 * ------------------------------------------------------------------------ */

const ENGINE_ID = 'sudoku_classic_9x9';
const ENGINE_VERSION = '1.0.0';

function generate(input: { seed: string; params: Record<string, unknown> }): GenerateResult {
  const rng = rngFor(`${ENGINE_ID}@${ENGINE_VERSION}:${input.seed}`);

  const requested = input.params['givens'];
  const targetGivens =
    typeof requested === 'number' && Number.isInteger(requested) && requested >= 17 && requested <= 60
      ? requested
      : 32;

  const complete = search([...new Array<number>(CELLS).fill(0)], 1, (digits) =>
    rng.shuffled(digits),
  ).first;
  if (!complete) {
    return { ok: false, error: 'No complete grid could be built from this seed.' };
  }

  /*
   * Carve while uniqueness holds. Removing symmetric pairs is the usual
   * prettier choice and is deliberately not taken: it constrains the carve
   * enough that the reachable difficulty band narrows, and a grid's symmetry
   * is a cosmetic property — which is exactly the kind of thing the
   * differentiator vocabulary refuses to count as a product difference.
   */
  const puzzle = [...complete];
  let givens = CELLS;
  for (const cell of rng.shuffled(Array.from({ length: CELLS }, (_, index) => index))) {
    if (givens <= targetGivens) break;
    const held = at(puzzle, cell);
    if (held === 0) continue;
    puzzle[cell] = 0;
    if (search(puzzle, 2).count !== 1) {
      puzzle[cell] = held;
      continue;
    }
    givens -= 1;
  }

  const difficulty = grade(puzzle);
  const shape: SudokuPuzzleShape = { size: SIZE, grid: puzzle };
  const payload: PuzzlePayload = {
    puzzle: shape,
    solution: { size: SIZE, grid: complete },
    answerKey: { rows: renderAnswerKey(complete) },
    instructions:
      'Fill every empty cell with a digit from 1 to 9 so that each row, each column and each ' +
      'of the nine three-by-three boxes contains every digit exactly once. Exactly one ' +
      'solution exists.',
    meta: { givens, technique: difficulty, engine: ENGINE_ID },
  };

  const value: Generated = {
    payload,
    difficulty,
    /*
     * A rough per-empty-cell estimate, and labelled as an estimate in the
     * payload rather than presented as a measurement. Nothing in this kernel
     * reads it to decide anything; it exists because the directive lists
     * expected solve time among a puzzle's identity, and an absent field would
     * be silently dropped where a stated estimate can be checked against a
     * real playtest later.
     */
    expectedSolveSeconds: (CELLS - givens) * (difficulty === 'EASY' ? 8 : difficulty === 'MEDIUM' ? 14 : 24),
    locale: null,
  };
  return { ok: true, value };
}

function validate(input: {
  payload: PuzzlePayload;
  params: Record<string, unknown>;
  declaredDifficulty: string | null;
}): ValidationCheckResult[] {
  const results: ValidationCheckResult[] = [];
  const puzzle = readGrid(input.payload.puzzle);
  const solution = readGrid(input.payload.solution);

  if (!puzzle) {
    return [
      {
        check: 'GRID_LEGALITY',
        ok: false,
        detail: 'The payload carries no readable nine-by-nine grid of digits 0-9.',
      },
    ];
  }

  const legal = isLegal(puzzle);
  results.push({
    check: 'GRID_LEGALITY',
    ok: legal,
    detail: legal
      ? `A legal nine-by-nine grid with ${puzzle.filter((one) => one > 0).length} givens.`
      : 'Two givens conflict in a row, a column or a box.',
  });
  if (!legal) return results;

  // Stop at two: the question is whether a second exists, never how many.
  const found = search(puzzle, 2);

  results.push({
    check: 'SOLVABILITY',
    ok: found.count >= 1,
    detail: found.count >= 1 ? 'A complete solution exists.' : 'No completion of this grid exists.',
  });
  results.push({
    check: 'SOLUTION_UNIQUENESS',
    ok: found.count === 1,
    detail:
      found.count === 1
        ? 'Exactly one completion exists.'
        : found.count === 0
          ? 'No completion exists, so there is no unique one.'
          : 'At least two different completions exist, so the answer key is not the only answer.',
  });

  /*
   * The answer key is checked against the solution the validator found, never
   * against the one the payload recorded. Comparing the recorded solution to
   * the recorded key would pass a generator that got both wrong in the same
   * way, which is precisely the failure an independent check exists to catch.
   */
  const truth = found.count === 1 ? found.first : null;
  if (!truth) {
    results.push({
      check: 'ANSWER_KEY_AGREEMENT',
      ok: false,
      detail: 'There is no unique solution to agree with, so the answer key cannot be checked.',
    });
  } else {
    const solutionMatches = Boolean(solution) && solution?.every((v, i) => v === truth[i]);
    const keyRows = (input.payload.answerKey as { rows?: unknown } | null)?.rows;
    const expected = renderAnswerKey(truth);
    const keyMatches =
      Array.isArray(keyRows) &&
      keyRows.length === expected.length &&
      keyRows.every((row, index) => row === expected[index]);
    results.push({
      check: 'ANSWER_KEY_AGREEMENT',
      ok: Boolean(solutionMatches) && keyMatches,
      detail:
        solutionMatches && keyMatches
          ? 'The recorded solution and the printed answer key both match the unique solution.'
          : !solutionMatches
            ? 'The recorded solution is not the unique completion of this grid.'
            : 'The printed answer key does not match the unique solution, so the book would ' +
              'print an answer nobody can reach.',
    });
  }

  const measured = grade(puzzle);
  results.push({
    check: 'DIFFICULTY_CALIBRATION',
    ok: input.declaredDifficulty === null || input.declaredDifficulty === measured,
    detail:
      input.declaredDifficulty === null
        ? `Measured ${measured}; nothing was declared to compare it against.`
        : input.declaredDifficulty === measured
          ? `Measured ${measured}, which is what was recorded.`
          : `Measured ${measured} but ${input.declaredDifficulty} was recorded, so the grid is ` +
            'filed under a difficulty it does not have.',
  });

  return results;
}

export const sudokuEngine: PuzzleEngine = {
  id: ENGINE_ID,
  version: ENGINE_VERSION,
  formatKey: 'sudoku',
  summary:
    'Classic nine-by-nine Sudoku. Carves a complete grid down while a full search still finds ' +
    'exactly one completion, and grades the result by the cheapest technique ladder that ' +
    'finishes it.',
  implementsChecks: [
    'GRID_LEGALITY',
    'SOLVABILITY',
    'SOLUTION_UNIQUENESS',
    'ANSWER_KEY_AGREEMENT',
    'DIFFICULTY_CALIBRATION',
  ],
  generate,
  validate,
};
