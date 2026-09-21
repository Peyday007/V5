/**
 * The validators. Deterministic code that decides whether a puzzle is correct.
 *
 * ---------------------------------------------------------------------------
 * This is what "validated" is allowed to mean
 * ---------------------------------------------------------------------------
 *
 * The brief's non-negotiable is that a puzzle is not commercially valid merely
 * because it renders attractively, and that 100% of output is validated with
 * format-specific checks. Everything below is that sentence as running code: a
 * function per format, given the payload and **nothing else**, returning a
 * verdict per named check.
 *
 * Giving a validator the spec or the generator would let it grade against the
 * intention rather than against the artifact, which is §27's rule about a
 * factory that could edit its own acceptance conditions. So it re-derives
 * everything it needs from the puzzle as posed — it re-solves the Sudoku, it
 * re-scans the word grid, it re-walks the maze — and a generator that recorded
 * a wrong answer is caught by exactly that independence.
 *
 * ---------------------------------------------------------------------------
 * A malformed payload is a failure, never an exception
 * ---------------------------------------------------------------------------
 *
 * Every reader below is total: a missing field, a wrong type or a payload of
 * another format's shape produces a FAIL with a sentence. A validator that
 * threw would take the batch down and record nothing, and the run would be
 * reported as an error rather than as the defect it is.
 *
 * ---------------------------------------------------------------------------
 * What is *not* here, and is reported rather than faked
 * ---------------------------------------------------------------------------
 *
 * None of these checks establishes that a puzzle is *enjoyable*, that its
 * difficulty matches what a person would experience, or that its theme is
 * coherent. The brief asks for human edit and stratified playtest for exactly
 * those, and this Brain has no playtest data — so there is no check here
 * pretending to cover it, and `registry.ts` declares the gap where the reading
 * can name it.
 */
import {
  countOccurrences,
  mazeNeighbours,
  sudokuAllows,
  sudokuSolutionCount,
  sudokuTechniqueRung,
} from './generators.ts';
import { fail, pass, type CheckOutcome, type Validator } from './kinds.ts';

/* -------------------------------------------------------------------------
 * Total readers. Every one answers with a value or with null; none throws.
 * ---------------------------------------------------------------------- */

function str(payload: Record<string, unknown>, key: string): string | null {
  const raw = payload[key];
  return typeof raw === 'string' ? raw : null;
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const raw = payload[key];
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

function strList(payload: Record<string, unknown>, key: string): string[] | null {
  const raw = payload[key];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    out.push(entry);
  }
  return out;
}

function numList(payload: Record<string, unknown>, key: string): number[] | null {
  const raw = payload[key];
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) return null;
    out.push(entry);
  }
  return out;
}

/** Every declared check reported as failed for one structural reason. */
function allFail(checks: readonly string[], detail: string): CheckOutcome[] {
  return checks.map((check) => fail(check, detail));
}

/* ==========================================================================
 * SUDOKU
 * ======================================================================== */

export const SUDOKU_CHECKS = [
  'LEGAL_CONSTRUCTION',
  'SOLUTION_CONSISTENT',
  'UNIQUE_SOLUTION',
  'DIFFICULTY_MEASURED',
] as const;

export const validateSudoku: Validator = (payload) => {
  const givens = str(payload, 'givens');
  const solution = str(payload, 'solution');

  if (givens === null || givens.length !== 81) {
    return allFail(
      SUDOKU_CHECKS,
      `givens must be 81 characters; it was ${givens === null ? 'absent' : String(givens.length)}.`,
    );
  }
  if (solution === null || solution.length !== 81) {
    return allFail(
      SUDOKU_CHECKS,
      `solution must be 81 characters; it was ` +
        `${solution === null ? 'absent' : String(solution.length)}.`,
    );
  }

  const out: CheckOutcome[] = [];

  const asNumbers = (text: string, blankAllowed: boolean): number[] | string => {
    const cells: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index] ?? '';
      if (ch === '.' || ch === '0') {
        if (!blankAllowed) return `position ${index + 1} is blank in a grid that may not be.`;
        cells.push(0);
        continue;
      }
      if (ch < '1' || ch > '9') return `position ${index + 1} holds "${ch}", which is not 1-9.`;
      cells.push(Number(ch));
    }
    return cells;
  };

  const puzzleCells = asNumbers(givens, true);
  if (typeof puzzleCells === 'string') {
    return allFail(SUDOKU_CHECKS, `givens: ${puzzleCells}`);
  }

  // LEGAL_CONSTRUCTION — no given repeats within a row, a column or a box.
  let illegal: string | null = null;
  for (let cell = 0; cell < 81 && illegal === null; cell += 1) {
    const value = puzzleCells[cell] ?? 0;
    if (value === 0) continue;
    const without = puzzleCells.slice();
    without[cell] = 0;
    if (!sudokuAllows(without, cell, value)) {
      illegal =
        `the given ${value} at row ${Math.floor(cell / 9) + 1}, column ${(cell % 9) + 1} ` +
        'repeats within its row, column or box.';
    }
  }
  out.push(illegal ? fail('LEGAL_CONSTRUCTION', illegal) : pass('LEGAL_CONSTRUCTION'));

  // SOLUTION_CONSISTENT — the recorded answer is complete, legal, and agrees
  // with every given. Checked before uniqueness because a puzzle can have
  // exactly one solution that is not the one written down, which is the
  // silent-divergence failure the single-source rule exists to prevent.
  const solvedCells = asNumbers(solution, false);
  if (typeof solvedCells === 'string') {
    out.push(fail('SOLUTION_CONSISTENT', `solution: ${solvedCells}`));
  } else {
    let problem: string | null = null;
    for (let cell = 0; cell < 81 && problem === null; cell += 1) {
      const value = solvedCells[cell] ?? 0;
      const without = solvedCells.slice();
      without[cell] = 0;
      if (!sudokuAllows(without, cell, value)) {
        problem = `the answer repeats ${value} at position ${cell + 1}.`;
      }
    }
    for (let cell = 0; cell < 81 && problem === null; cell += 1) {
      const given = puzzleCells[cell] ?? 0;
      if (given !== 0 && given !== solvedCells[cell]) {
        problem =
          `the answer contradicts the given at position ${cell + 1}: the puzzle shows ` +
          `${given} and the answer shows ${solvedCells[cell]}.`;
      }
    }
    out.push(problem ? fail('SOLUTION_CONSISTENT', problem) : pass('SOLUTION_CONSISTENT'));
  }

  // UNIQUE_SOLUTION — counted, not asserted. Two is enough to refuse, so the
  // count stops there.
  const found = sudokuSolutionCount(puzzleCells, 2);
  out.push(
    found === 1
      ? pass('UNIQUE_SOLUTION')
      : fail(
          'UNIQUE_SOLUTION',
          found === 0
            ? 'the puzzle has no solution at all.'
            : 'the puzzle has more than one solution, so its answer key is not the only answer.',
        ),
  );

  // DIFFICULTY_MEASURED — that a rung could actually be measured. It reports
  // what a solver needed and deliberately makes no claim about how long a
  // person would take, which is the calibration nothing here holds.
  const rung = sudokuTechniqueRung(puzzleCells);
  out.push(
    rung >= 1 && rung <= 3
      ? pass('DIFFICULTY_MEASURED')
      : fail('DIFFICULTY_MEASURED', `the technique ladder returned ${rung}.`),
  );

  return out;
};

/* ==========================================================================
 * WORD SEARCH
 * ======================================================================== */

export const WORD_SEARCH_CHECKS = [
  'GRID_WELL_FORMED',
  'EVERY_WORD_PRESENT',
  'ANSWER_KEY_UNAMBIGUOUS',
  'NO_SCREENED_STRING',
] as const;

export const validateWordSearch: Validator = (payload) => {
  const rows = strList(payload, 'rows');
  const words = strList(payload, 'words');
  const width = num(payload, 'width');
  const height = num(payload, 'height');

  if (rows === null || words === null || width === null || height === null) {
    return allFail(
      WORD_SEARCH_CHECKS,
      'the payload is missing rows, words, width or height, or they are the wrong type.',
    );
  }

  const out: CheckOutcome[] = [];

  // GRID_WELL_FORMED
  let shape: string | null = null;
  if (rows.length !== height) {
    shape = `height says ${height} and there are ${rows.length} rows.`;
  } else {
    for (let index = 0; index < rows.length && shape === null; index += 1) {
      const row = rows[index] ?? '';
      if (row.length !== width) {
        shape = `row ${index + 1} is ${row.length} wide and width says ${width}.`;
      } else if (!/^[A-Z]+$/.test(row)) {
        shape = `row ${index + 1} holds something other than capital letters.`;
      }
    }
  }
  out.push(shape ? fail('GRID_WELL_FORMED', shape) : pass('GRID_WELL_FORMED'));

  if (shape) {
    // Nothing further can be established about a grid that is not a grid, and
    // saying so is not the same as saying those checks passed.
    return [
      ...out,
      ...allFail(
        WORD_SEARCH_CHECKS.filter((check) => check !== 'GRID_WELL_FORMED'),
        `not checked: ${shape}`,
      ),
    ];
  }

  // EVERY_WORD_PRESENT — read off the grid at the recorded coordinates, so a
  // placement that disagrees with the letters is caught rather than trusted.
  const placementsRaw = payload['placements'];
  const placements = Array.isArray(placementsRaw) ? placementsRaw : [];
  const byWord = new Map<string, { row: number; col: number; dr: number; dc: number }>();
  for (const entry of placements) {
    if (!entry || typeof entry !== 'object') continue;
    const one = entry as Record<string, unknown>;
    const word = typeof one['word'] === 'string' ? one['word'] : null;
    const row = typeof one['row'] === 'number' ? one['row'] : null;
    const col = typeof one['col'] === 'number' ? one['col'] : null;
    const dr = typeof one['dr'] === 'number' ? one['dr'] : null;
    const dc = typeof one['dc'] === 'number' ? one['dc'] : null;
    if (word === null || row === null || col === null || dr === null || dc === null) continue;
    byWord.set(word, { row, col, dr, dc });
  }

  let missing: string | null = null;
  for (const word of words) {
    const placement = byWord.get(word);
    if (!placement) {
      missing = `"${word}" is listed and has no recorded position.`;
      break;
    }
    let read = '';
    for (let index = 0; index < word.length; index += 1) {
      const r = placement.row + placement.dr * index;
      const c = placement.col + placement.dc * index;
      if (r < 0 || c < 0 || r >= height || c >= width) {
        read = '';
        break;
      }
      read += rows[r]?.[c] ?? '';
    }
    if (read !== word) {
      missing =
        `"${word}" is recorded at row ${placement.row + 1}, column ${placement.col + 1} but ` +
        `the grid reads "${read || 'off the edge'}" there.`;
      break;
    }
  }
  out.push(missing ? fail('EVERY_WORD_PRESENT', missing) : pass('EVERY_WORD_PRESENT'));

  // ANSWER_KEY_UNAMBIGUOUS — a word the fill happened to spell a second time
  // makes the answer key wrong for a solver who found the other one.
  let ambiguous: string | null = null;
  for (const word of words) {
    const seen = countOccurrences(rows, word);
    if (seen !== 1) {
      ambiguous =
        seen === 0
          ? `"${word}" does not appear in the grid at all.`
          : `"${word}" appears ${seen} times, so the answer key names only one of them.`;
      break;
    }
  }
  out.push(
    ambiguous ? fail('ANSWER_KEY_UNAMBIGUOUS', ambiguous) : pass('ANSWER_KEY_UNAMBIGUOUS'),
  );

  /*
   * NO_SCREENED_STRING — against the list carried on the payload.
   *
   * An empty list passes, and that is honest rather than hollow: the check
   * establishes that nothing on the screening list appears, and with nothing
   * on the list that is trivially true. What it must never do is report a
   * screened grid when nothing was screened, so the detail says how many
   * strings were actually looked for and `view.ts` reports a master with an
   * empty list as a named gap.
   */
  const prohibited = strList(payload, 'prohibited') ?? [];
  const offending = prohibited.find((one) => countOccurrences(rows, one) > 0);
  out.push(
    offending
      ? fail('NO_SCREENED_STRING', `the grid spells a screened string (${offending.length} letters).`)
      : { check: 'NO_SCREENED_STRING', verdict: 'PASS', detail: `${prohibited.length} screened` },
  );

  return out;
};

/* ==========================================================================
 * MAZE
 * ======================================================================== */

export const MAZE_CHECKS = [
  'GRID_WELL_FORMED',
  'PASSAGES_RECIPROCAL',
  'FULLY_CONNECTED',
  'SOLUTION_UNIQUE',
  'SOLUTION_MATCHES',
] as const;

export const validateMaze: Validator = (payload) => {
  const rows = strList(payload, 'passages');
  const width = num(payload, 'width');
  const height = num(payload, 'height');
  const start = num(payload, 'start');
  const end = num(payload, 'end');
  const solution = numList(payload, 'solution');

  if (
    rows === null ||
    width === null ||
    height === null ||
    start === null ||
    end === null ||
    solution === null
  ) {
    return allFail(
      MAZE_CHECKS,
      'the payload is missing passages, width, height, start, end or solution.',
    );
  }

  const total = width * height;
  const out: CheckOutcome[] = [];

  let shape: string | null = null;
  if (rows.length !== height) {
    shape = `height says ${height} and there are ${rows.length} rows.`;
  } else if (start < 0 || start >= total || end < 0 || end >= total) {
    shape = `start ${start} or end ${end} is outside a maze of ${total} cells.`;
  } else if (start === end) {
    shape = 'the start and the end are the same cell.';
  }
  const passages: number[] = [];
  if (shape === null) {
    for (let index = 0; index < rows.length && shape === null; index += 1) {
      const row = rows[index] ?? '';
      if (row.length !== width) {
        shape = `row ${index + 1} is ${row.length} wide and width says ${width}.`;
        break;
      }
      for (const ch of row) {
        const value = Number.parseInt(ch, 16);
        if (!Number.isInteger(value) || value < 0 || value > 15) {
          shape = `row ${index + 1} holds "${ch}", which is not a hex digit.`;
          break;
        }
        passages.push(value);
      }
    }
  }
  out.push(shape ? fail('GRID_WELL_FORMED', shape) : pass('GRID_WELL_FORMED'));
  if (shape) {
    return [
      ...out,
      ...allFail(
        MAZE_CHECKS.filter((check) => check !== 'GRID_WELL_FORMED'),
        `not checked: ${shape}`,
      ),
    ];
  }

  // PASSAGES_RECIPROCAL — a wall opened from one side and not the other would
  // make the maze a directed graph, which is not what is printed.
  const bits: { bit: number; opposite: number; dr: number; dc: number }[] = [
    { bit: 1, opposite: 4, dr: -1, dc: 0 },
    { bit: 2, opposite: 8, dr: 0, dc: 1 },
    { bit: 4, opposite: 1, dr: 1, dc: 0 },
    { bit: 8, opposite: 2, dr: 0, dc: -1 },
  ];
  let oneSided: string | null = null;
  let edges = 0;
  for (let cell = 0; cell < total && oneSided === null; cell += 1) {
    const row = Math.floor(cell / width);
    const col = cell % width;
    const open = passages[cell] ?? 0;
    for (const step of bits) {
      if ((open & step.bit) === 0) continue;
      const r = row + step.dr;
      const c = col + step.dc;
      if (r < 0 || c < 0 || r >= height || c >= width) {
        oneSided = `cell ${cell} opens off the edge of the maze.`;
        break;
      }
      const other = passages[r * width + c] ?? 0;
      if ((other & step.opposite) === 0) {
        oneSided = `cell ${cell} opens toward cell ${r * width + c}, which is walled against it.`;
        break;
      }
      edges += 1;
    }
  }
  // Each passage was counted from both ends.
  edges = Math.floor(edges / 2);
  out.push(oneSided ? fail('PASSAGES_RECIPROCAL', oneSided) : pass('PASSAGES_RECIPROCAL'));

  const reached = new Array<boolean>(total).fill(false);
  const queue: number[] = [start];
  reached[start] = true;
  let seen = 1;
  while (queue.length > 0) {
    const cell = queue.shift();
    if (cell === undefined) break;
    for (const next of mazeNeighbours(passages, width, height, cell)) {
      if (reached[next]) continue;
      reached[next] = true;
      seen += 1;
      queue.push(next);
    }
  }
  out.push(
    seen === total
      ? pass('FULLY_CONNECTED')
      : fail('FULLY_CONNECTED', `${total - seen} of ${total} cells cannot be reached.`),
  );

  /*
   * SOLUTION_UNIQUE, established structurally rather than by search.
   *
   * A connected graph with exactly one fewer edge than it has vertices is a
   * tree, and a tree has exactly one simple path between any two vertices. So
   * proving those two facts proves uniqueness for every pair at once, which is
   * both cheaper and stronger than walking to find a second route.
   */
  const isTree = seen === total && edges === total - 1;
  out.push(
    isTree
      ? pass('SOLUTION_UNIQUE')
      : fail(
          'SOLUTION_UNIQUE',
          `the maze has ${edges} passage(s) between ${total} cells; a maze with exactly one ` +
            `route needs ${total - 1}, so this one has loops and more than one way through.`,
        ),
  );

  // SOLUTION_MATCHES — the recorded path is walked step by step.
  let walk: string | null = null;
  if (solution.length === 0) {
    walk = 'no solution path is recorded.';
  } else if (solution[0] !== start) {
    walk = `the recorded path begins at ${solution[0]} rather than at the start, ${start}.`;
  } else if (solution[solution.length - 1] !== end) {
    walk = `the recorded path ends at ${solution[solution.length - 1]} rather than at ${end}.`;
  } else {
    for (let index = 1; index < solution.length && walk === null; index += 1) {
      const from = solution[index - 1] ?? -1;
      const to = solution[index] ?? -1;
      if (!mazeNeighbours(passages, width, height, from).includes(to)) {
        walk = `the recorded path steps from ${from} to ${to}, which is through a wall.`;
      }
    }
  }
  out.push(walk ? fail('SOLUTION_MATCHES', walk) : pass('SOLUTION_MATCHES'));

  return out;
};

/* ==========================================================================
 * CRYPTOGRAM
 * ======================================================================== */

export const CRYPTOGRAM_CHECKS = [
  'KEY_IS_BIJECTION',
  'NO_FIXED_POINT',
  'DECODES_TO_SOURCE',
] as const;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const validateCryptogram: Validator = (payload) => {
  const plaintext = str(payload, 'plaintext');
  const ciphertext = str(payload, 'ciphertext');
  const keyRaw = payload['key'];

  if (plaintext === null || ciphertext === null || keyRaw === null || typeof keyRaw !== 'object') {
    return allFail(CRYPTOGRAM_CHECKS, 'the payload is missing plaintext, ciphertext or key.');
  }
  const key = keyRaw as Record<string, unknown>;

  const out: CheckOutcome[] = [];

  // KEY_IS_BIJECTION — every letter mapped, and no two letters sharing one.
  const images = new Map<string, string>();
  let broken: string | null = null;
  for (const letter of ALPHABET) {
    const image = key[letter];
    if (typeof image !== 'string' || image.length !== 1 || !ALPHABET.includes(image)) {
      broken = `"${letter}" maps to ${JSON.stringify(image)}, which is not a single letter.`;
      break;
    }
    const already = images.get(image);
    if (already) {
      broken = `both "${already}" and "${letter}" map to "${image}", so the key cannot be undone.`;
      break;
    }
    images.set(image, letter);
  }
  out.push(broken ? fail('KEY_IS_BIJECTION', broken) : pass('KEY_IS_BIJECTION'));

  // NO_FIXED_POINT — a letter standing for itself gives the puzzle away and is
  // outside the convention every published cryptogram follows.
  const fixed = [...ALPHABET].find((letter) => key[letter] === letter);
  out.push(
    fixed
      ? fail('NO_FIXED_POINT', `"${fixed}" stands for itself.`)
      : pass('NO_FIXED_POINT'),
  );

  // DECODES_TO_SOURCE — the ciphertext is actually deciphered, rather than the
  // key being taken at its word.
  if (broken) {
    out.push(fail('DECODES_TO_SOURCE', `not checked: ${broken}`));
  } else {
    const decoded = [...ciphertext]
      .map((ch) => (ALPHABET.includes(ch) ? (images.get(ch) ?? ch) : ch))
      .join('');
    out.push(
      decoded === plaintext
        ? pass('DECODES_TO_SOURCE')
        : fail(
            'DECODES_TO_SOURCE',
            'deciphering the ciphertext with the recorded key does not give the recorded ' +
              'plaintext, so the answer printed with this puzzle is wrong.',
          ),
    );
  }

  return out;
};
