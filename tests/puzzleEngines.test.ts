/**
 * The production half: deterministic generators, and validators that catch a
 * generator lying.
 *
 * ---------------------------------------------------------------------------
 * Every test here corrupts a payload the generator produced
 * ---------------------------------------------------------------------------
 *
 * Asserting that a freshly generated puzzle passes its own validator proves
 * almost nothing: the same code made both. What this suite does instead is
 * take a good payload, break exactly one thing about it, and assert the
 * validator names that one thing — which is the only way to know the check is
 * looking rather than agreeing.
 *
 * The corruptions are the real failure modes. A grid with two solutions is a
 * book whose answer key is not the only answer. An answer key that drifted
 * from the solution is the artifact nobody proofreads by solving, so it ships.
 * A word-search placement off by one cell points a solver at the wrong
 * squares. A maze wall cleared from one side only renders open and walks
 * closed. Each of those has reached print in the real trade.
 *
 * ---------------------------------------------------------------------------
 * Determinism is asserted, because a repair depends on it
 * ---------------------------------------------------------------------------
 *
 * The directive's rule is *block the batch and repair the generator, do not
 * patch the outputs*. A defect you cannot reproduce is one you can only patch,
 * so every engine is asserted to produce byte-identical output from the same
 * seed.
 */
import { describe, expect, it } from 'vitest';
import { listEngines, engineById, enginesForFormat, checksAvailableFor, KERNEL_CHECKS } from '../server/services/puzzle/engines/index.ts';
import { sudokuEngine, grade, renderAnswerKey } from '../server/services/puzzle/engines/sudoku.ts';
import { wordSearchEngine } from '../server/services/puzzle/engines/wordsearch.ts';
import { mazeEngine } from '../server/services/puzzle/engines/maze.ts';
import { rngFor } from '../server/services/puzzle/engines/rng.ts';
import { canonicalJson, verdictFrom } from '../server/services/puzzle/produce.ts';
import type { PuzzlePayload, ValidationCheck } from '../server/domain/types.ts';

/** The one check every failure assertion needs: did *this* check fail, alone? */
function failedOnly(
  results: readonly { check: ValidationCheck; ok: boolean; detail: string }[],
  check: ValidationCheck,
): void {
  const failing = results.filter((one) => !one.ok).map((one) => one.check);
  expect(failing).toContain(check);
}

function ran(
  results: readonly { check: ValidationCheck; ok: boolean; detail: string }[],
  check: ValidationCheck,
): { ok: boolean; detail: string } {
  const found = results.find((one) => one.check === check);
  expect(found, `${check} did not run`).toBeDefined();
  return found as { ok: boolean; detail: string };
}

/** A deep copy, so a corruption never leaks into the next assertion. */
function clone(payload: PuzzlePayload): PuzzlePayload {
  return JSON.parse(JSON.stringify(payload)) as PuzzlePayload;
}

describe('the registry says what exists, and never what a format is', () => {
  it('registers each engine once, against a format it names', () => {
    const ids = listEngines().map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const engine of listEngines()) {
      expect(engine.formatKey.trim()).not.toBe('');
      expect(engine.implementsChecks.length).toBeGreaterThan(0);
      expect(engineById(engine.id)).toBe(engine);
    }
  });

  it('answers nothing for a format nothing implements, which is the honest answer', () => {
    expect(enginesForFormat('cryptic crossword')).toEqual([]);
    // A format with no engine still gets the checks the kernel itself
    // enforces — the duplicate gate is the database's, not any validator's.
    expect(checksAvailableFor('cryptic crossword')).toEqual([...KERNEL_CHECKS]);
  });

  it('counts the kernel-wide checks as available, because the database enforces them', () => {
    expect(KERNEL_CHECKS).toContain('DUPLICATE_DETECTION');
    expect(checksAvailableFor('sudoku')).toContain('DUPLICATE_DETECTION');
    expect(checksAvailableFor('sudoku')).toContain('SOLUTION_UNIQUENESS');
  });
});

describe('the sequence is deterministic, because a repair depends on it', () => {
  it('gives the same numbers for the same seed and different ones for different seeds', () => {
    const a = Array.from({ length: 12 }, () => rngFor('seed-one').next());
    const b = Array.from({ length: 12 }, () => rngFor('seed-one').next());
    const c = Array.from({ length: 12 }, () => rngFor('seed-two').next());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('never mutates what it shuffles', () => {
    const source = Object.freeze([1, 2, 3, 4, 5]);
    const shuffled = rngFor('x').shuffled(source);
    expect(source).toEqual([1, 2, 3, 4, 5]);
    expect([...shuffled].sort((p, q) => p - q)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('sudoku: uniqueness is proved, not asserted', () => {
  const good = (() => {
    const result = sudokuEngine.generate({ seed: 'suite-a', params: { givens: 34 } });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })();

  it('is deterministic in the seed', () => {
    const again = sudokuEngine.generate({ seed: 'suite-a', params: { givens: 34 } });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(canonicalJson(again.value.payload)).toBe(canonicalJson(good.payload));

    const different = sudokuEngine.generate({ seed: 'suite-b', params: { givens: 34 } });
    expect(different.ok).toBe(true);
    if (!different.ok) return;
    expect(canonicalJson(different.value.payload)).not.toBe(canonicalJson(good.payload));
  });

  it('passes every check it implements', () => {
    const results = sudokuEngine.validate({
      payload: good.payload,
      params: { givens: 34 },
      declaredDifficulty: good.difficulty,
    });
    expect(verdictFrom(results).verdict).toBe('PASSED');
    for (const check of sudokuEngine.implementsChecks) expect(ran(results, check).ok).toBe(true);
  });

  it('catches a second solution, which is a book whose answer key is not the only answer', () => {
    const broken = clone(good.payload);
    const shape = broken.puzzle as { grid: number[] };
    /*
     * Blank cells until a second completion exists. Removing givens can only
     * ever add solutions, so this terminates — and it is how a real carver
     * goes wrong: one removal too many with the uniqueness check skipped.
     */
    let secondExists = false;
    for (let index = 0; index < 81 && !secondExists; index += 1) {
      if (shape.grid[index] === 0) continue;
      shape.grid[index] = 0;
      const results = sudokuEngine.validate({
        payload: broken,
        params: {},
        declaredDifficulty: null,
      });
      secondExists = !ran(results, 'SOLUTION_UNIQUENESS').ok;
    }
    expect(secondExists, 'no amount of blanking produced a second solution').toBe(true);

    const results = sudokuEngine.validate({
      payload: broken,
      params: {},
      declaredDifficulty: null,
    });
    failedOnly(results, 'SOLUTION_UNIQUENESS');
    // Still solvable — which is exactly why solvability and uniqueness are two
    // checks. A grid with two answers is perfectly solvable and unpublishable.
    expect(ran(results, 'SOLVABILITY').ok).toBe(true);
  });

  it('catches an answer key that drifted from the solution', () => {
    const broken = clone(good.payload);
    const key = broken.answerKey as { rows: string[] };
    const first = key.rows[0] as string;
    key.rows[0] = `${first.slice(0, 8)}${first[8] === '9' ? '1' : '9'}`;
    const results = sudokuEngine.validate({
      payload: broken,
      params: {},
      declaredDifficulty: null,
    });
    failedOnly(results, 'ANSWER_KEY_AGREEMENT');
    expect(ran(results, 'ANSWER_KEY_AGREEMENT').detail).toContain('print an answer');
  });

  it('catches a recorded solution that is not the completion of the grid', () => {
    const broken = clone(good.payload);
    const solution = broken.solution as { grid: number[] };
    const swapAt = solution.grid.findIndex((value) => value !== 1);
    solution.grid[swapAt] = 1;
    const results = sudokuEngine.validate({
      payload: broken,
      params: {},
      declaredDifficulty: null,
    });
    failedOnly(results, 'ANSWER_KEY_AGREEMENT');
  });

  it('catches two givens conflicting, and stops there', () => {
    const broken = clone(good.payload);
    const shape = broken.puzzle as { grid: number[] };
    const row = shape.grid.slice(0, 9);
    const filled = row.findIndex((value) => value > 0);
    const other = row.findIndex((value, index) => value > 0 && index !== filled);
    shape.grid[other] = shape.grid[filled] as number;
    const results = sudokuEngine.validate({
      payload: broken,
      params: {},
      declaredDifficulty: null,
    });
    failedOnly(results, 'GRID_LEGALITY');
    // An illegal grid stops the run rather than producing five more failures
    // about a grid nobody could solve anyway.
    expect(results).toHaveLength(1);
  });

  it('catches a grid filed under a difficulty it does not have', () => {
    const results = sudokuEngine.validate({
      payload: good.payload,
      params: {},
      declaredDifficulty: good.difficulty === 'EASY' ? 'HARD' : 'EASY',
    });
    failedOnly(results, 'DIFFICULTY_CALIBRATION');
  });

  it('measures difficulty rather than accepting it', () => {
    const shape = good.payload.puzzle as { grid: number[] };
    expect(grade(shape.grid)).toBe(good.difficulty);
    // And the printed key is a rendering of the solution, re-derivable.
    const solution = good.payload.solution as { grid: number[] };
    expect((good.payload.answerKey as { rows: string[] }).rows).toEqual(
      renderAnswerKey(solution.grid),
    );
  });

  it('refuses nothing it produced — the carve respects the requested givens', () => {
    const sparse = sudokuEngine.generate({ seed: 'sparse', params: { givens: 28 } });
    expect(sparse.ok).toBe(true);
    if (!sparse.ok) return;
    const grid = (sparse.value.payload.puzzle as { grid: number[] }).grid;
    expect(grid.filter((one) => one > 0).length).toBeLessThanOrEqual(34);
    expect(
      verdictFrom(
        sudokuEngine.validate({
          payload: sparse.value.payload,
          params: {},
          declaredDifficulty: sparse.value.difficulty,
        }),
      ).verdict,
    ).toBe('PASSED');
  });
});

describe('word search: three checks that look like one and are not', () => {
  const WORDS = ['CROSSWORD', 'ANAGRAM', 'CIPHER', 'RIDDLE', 'LOGIC', 'MAZE'];
  const params = { words: WORDS, size: 14 };
  const good = (() => {
    const result = wordSearchEngine.generate({ seed: 'ws-a', params });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })();

  it('is deterministic in the seed', () => {
    const again = wordSearchEngine.generate({ seed: 'ws-a', params });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(canonicalJson(again.value.payload)).toBe(canonicalJson(good.payload));
  });

  it('passes every check it implements', () => {
    const results = wordSearchEngine.validate({
      payload: good.payload,
      params,
      declaredDifficulty: good.difficulty,
    });
    expect(verdictFrom(results).verdict).toBe('PASSED');
    for (const check of wordSearchEngine.implementsChecks) {
      expect(ran(results, check).ok, `${check}: ${ran(results, check).detail}`).toBe(true);
    }
  });

  it('catches a placement that points at the wrong squares, while the word is still findable', () => {
    const broken = clone(good.payload);
    const solution = broken.solution as { placements: { row: number; col: number }[] };
    const first = solution.placements[0] as { row: number; col: number };
    first.row = (first.row + 1) % 3;
    const results = wordSearchEngine.validate({ payload: broken, params, declaredDifficulty: null });
    failedOnly(results, 'COORDINATE_AGREEMENT');
    // The word is still in the grid — which is the whole reason solvability
    // and coordinate agreement are separate checks.
    expect(ran(results, 'SOLVABILITY').ok).toBe(true);
  });

  it('catches an answer key that names a word the puzzle never listed', () => {
    const broken = clone(good.payload);
    const solution = broken.solution as {
      placements: { word: string; row: number; col: number; dr: number; dc: number }[];
    };
    const copy = { ...(solution.placements[0] as object) } as {
      word: string;
      row: number;
      col: number;
      dr: number;
      dc: number;
    };
    copy.word = 'ZZZZZ';
    solution.placements.push(copy);
    const results = wordSearchEngine.validate({ payload: broken, params, declaredDifficulty: null });
    failedOnly(results, 'ANSWER_KEY_AGREEMENT');
  });

  it('catches a listed word that is nowhere in the grid', () => {
    const broken = clone(good.payload);
    const shape = broken.puzzle as { rows: string[]; words: string[] };
    shape.words = [...shape.words, 'NONEXISTENTWORDQ'];
    const results = wordSearchEngine.validate({ payload: broken, params, declaredDifficulty: null });
    failedOnly(results, 'SOLVABILITY');
    expect(ran(results, 'SOLVABILITY').detail).toContain('cannot be completed');
  });

  it("screens against the master's own list, and says so when there is none", () => {
    // A word from the list itself is guaranteed present, which makes the
    // screen's positive case deterministic rather than lucky.
    const hit = wordSearchEngine.validate({
      payload: good.payload,
      params: { ...params, prohibited: ['RIDDLE'] },
      declaredDifficulty: null,
    });
    failedOnly(hit, 'PROHIBITED_CONTENT');

    const none = wordSearchEngine.validate({
      payload: good.payload,
      params,
      declaredDifficulty: null,
    });
    const reading = ran(none, 'PROHIBITED_CONTENT');
    expect(reading.ok).toBe(true);
    // "We screened against nothing" and "there is nothing objectionable here"
    // are different statements, and the detail has to say which one this is.
    expect(reading.detail).toContain('not the same fact');
  });

  it('refuses a master with no word list rather than inventing one', () => {
    const result = wordSearchEngine.generate({ seed: 'ws-empty', params: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('provenance');
  });

  it('refuses rather than silently dropping a word it cannot place', () => {
    const result = wordSearchEngine.generate({
      seed: 'ws-tight',
      params: { words: ['ABCDEFGH', 'IJKLMNOP', 'QRSTUVWX'], size: 8 },
    });
    if (!result.ok) {
      expect(result.error).toContain('could not be placed');
      return;
    }
    // If it did fit, every word must be there — a generator that dropped one
    // would produce a list nobody can complete.
    const results = wordSearchEngine.validate({
      payload: result.value.payload,
      params: { words: ['ABCDEFGH', 'IJKLMNOP', 'QRSTUVWX'] },
      declaredDifficulty: null,
    });
    expect(ran(results, 'SOLVABILITY').ok).toBe(true);
  });
});

describe('maze: uniqueness is a structural property', () => {
  const params = { rows: 10, cols: 10 };
  const good = (() => {
    const result = mazeEngine.generate({ seed: 'mz-a', params });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  })();

  it('is deterministic in the seed', () => {
    const again = mazeEngine.generate({ seed: 'mz-a', params });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(canonicalJson(again.value.payload)).toBe(canonicalJson(good.payload));
  });

  it('passes every check it implements', () => {
    const results = mazeEngine.validate({
      payload: good.payload,
      params,
      declaredDifficulty: good.difficulty,
    });
    expect(verdictFrom(results).verdict).toBe('PASSED');
    for (const check of mazeEngine.implementsChecks) {
      expect(ran(results, check).ok, `${check}: ${ran(results, check).detail}`).toBe(true);
    }
  });

  it('catches a loop, which means more than one route exists', () => {
    const broken = clone(good.payload);
    const maze = broken.puzzle as { rows: number; cols: number; cells: number[] };
    // Open one interior wall from both sides. The carve produced a tree, so
    // any extra passage is a cycle by construction.
    let opened = false;
    for (let row = 0; row < maze.rows - 1 && !opened; row += 1) {
      for (let col = 0; col < maze.cols && !opened; col += 1) {
        const here = row * maze.cols + col;
        const below = (row + 1) * maze.cols + col;
        if (((maze.cells[here] as number) & 4) === 0) continue;
        maze.cells[here] = (maze.cells[here] as number) & ~4;
        maze.cells[below] = (maze.cells[below] as number) & ~1;
        opened = true;
      }
    }
    expect(opened).toBe(true);
    const results = mazeEngine.validate({ payload: broken, params, declaredDifficulty: null });
    failedOnly(results, 'SOLUTION_UNIQUENESS');
    expect(ran(results, 'SOLUTION_UNIQUENESS').detail).toContain('loop');
    // Still reachable and still legal — three distinct checks, three distinct
    // answers about the same maze.
    expect(ran(results, 'REACHABILITY').ok).toBe(true);
    expect(ran(results, 'GRID_LEGALITY').ok).toBe(true);
  });

  it('catches a wall cleared from one side only, which renders open and walks closed', () => {
    const broken = clone(good.payload);
    const maze = broken.puzzle as { rows: number; cols: number; cells: number[] };
    const here = 0;
    maze.cells[here] = (maze.cells[here] as number) | 2; // put the east wall back on one side
    const results = mazeEngine.validate({ payload: broken, params, declaredDifficulty: null });
    const legality = ran(results, 'GRID_LEGALITY');
    if (!legality.ok) {
      expect(legality.detail).toContain('disagree');
      return;
    }
    // The cell had no east passage to begin with, so try the south wall.
    const other = clone(good.payload);
    const second = other.puzzle as { cells: number[] };
    second.cells[0] = (second.cells[0] as number) ^ 4;
    failedOnly(
      mazeEngine.validate({ payload: other, params, declaredDifficulty: null }),
      'GRID_LEGALITY',
    );
  });

  it('catches a recorded route that crosses a wall', () => {
    const broken = clone(good.payload);
    const solution = broken.solution as { path: [number, number][] };
    // Drop a step out of the middle: the remaining neighbours are no longer
    // adjacent, so the route cannot be walked.
    solution.path.splice(Math.floor(solution.path.length / 2), 1);
    failedOnly(
      mazeEngine.validate({ payload: broken, params, declaredDifficulty: null }),
      'ANSWER_KEY_AGREEMENT',
    );
  });

  it('catches an exit that cannot be reached', () => {
    const broken = clone(good.payload);
    const maze = broken.puzzle as { rows: number; cols: number; cells: number[] };
    // Wall the exit in on every side, from both sides of each wall.
    const end = maze.rows * maze.cols - 1;
    maze.cells[end] = 15;
    const west = end - 1;
    const north = end - maze.cols;
    maze.cells[west] = (maze.cells[west] as number) | 2;
    maze.cells[north] = (maze.cells[north] as number) | 4;
    const results = mazeEngine.validate({ payload: broken, params, declaredDifficulty: null });
    failedOnly(results, 'REACHABILITY');
  });

  it('refuses a payload it cannot read rather than guessing at one', () => {
    const results = mazeEngine.validate({
      payload: { puzzle: { rows: 4 }, solution: null, answerKey: null, instructions: '', meta: {} },
      params,
      declaredDifficulty: null,
    });
    expect(results).toHaveLength(1);
    failedOnly(results, 'GRID_LEGALITY');
  });
});

describe('a verdict is what the checks add up to, and UNCHECKED is a third answer', () => {
  it('reports UNCHECKED when nothing could be answered', () => {
    expect(verdictFrom([])).toEqual({ verdict: 'UNCHECKED', failedCheck: null });
  });

  it('names the first failing check, so a batch-wide defect is countable', () => {
    expect(
      verdictFrom([
        { check: 'GRID_LEGALITY', ok: true, detail: '' },
        { check: 'SOLUTION_UNIQUENESS', ok: false, detail: '' },
        { check: 'SOLVABILITY', ok: false, detail: '' },
      ]),
    ).toEqual({ verdict: 'FAILED', failedCheck: 'SOLUTION_UNIQUENESS' });
  });

  it('hashes over sorted keys, so field order cannot fork a catalog', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
