/**
 * A maze generator and an independent maze validator.
 *
 * ---------------------------------------------------------------------------
 * Uniqueness here is a structural property, and that is why it is checkable
 * ---------------------------------------------------------------------------
 *
 * A *perfect* maze is a spanning tree over the cells: every cell reachable,
 * and exactly as many passages as cells minus one. In a tree there is exactly
 * one simple path between any two cells — so `SOLUTION_UNIQUENESS` is not a
 * search over paths, it is a count of passages and a connectivity walk, and it
 * is proved rather than sampled.
 *
 * That is the same reason Sudoku is where this kernel starts: the directive's
 * quality standard demands *required uniqueness* and *intended solution
 * structure*, and a format where those can be established by construction is
 * one where a validator can be honest instead of approximate.
 *
 * ---------------------------------------------------------------------------
 * Wall reciprocity is a real defect class, not a formality
 * ---------------------------------------------------------------------------
 *
 * A maze is stored as one wall bitmask per cell, so the same wall is
 * represented twice — once from each side. A carve that cleared only one side
 * produces a maze that renders as open and walks as closed, or the reverse,
 * and the failure appears as an unsolvable printed page. `GRID_LEGALITY`
 * checks every shared wall from both sides.
 */
import { rngFor } from './rng.ts';
import type { Generated, GenerateResult, PuzzleEngine } from './types.ts';
import type { PuzzlePayload, ValidationCheckResult } from '../../../domain/types.ts';

const ENGINE_ID = 'maze_perfect_grid';
const ENGINE_VERSION = '1.0.0';

/** Wall bits. A set bit means the wall is present. */
const N = 1;
const E = 2;
const S = 4;
const W = 8;

const MOVES: readonly { dr: number; dc: number; wall: number; opposite: number; name: string }[] = [
  { dr: -1, dc: 0, wall: N, opposite: S, name: 'N' },
  { dr: 0, dc: 1, wall: E, opposite: W, name: 'E' },
  { dr: 1, dc: 0, wall: S, opposite: N, name: 'S' },
  { dr: 0, dc: -1, wall: W, opposite: E, name: 'W' },
];

interface MazeShape {
  rows: number;
  cols: number;
  /** One bitmask per cell, row-major. */
  cells: number[];
  start: [number, number];
  end: [number, number];
}

function readMaze(value: unknown): MazeShape | null {
  if (!value || typeof value !== 'object') return null;
  const one = value as Record<string, unknown>;
  const rows = one['rows'];
  const cols = one['cols'];
  const cells = one['cells'];
  const start = one['start'];
  const end = one['end'];
  if (typeof rows !== 'number' || typeof cols !== 'number') return null;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2) return null;
  if (!Array.isArray(cells) || cells.length !== rows * cols) return null;
  const masks: number[] = [];
  for (const cell of cells) {
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell > 15) return null;
    masks.push(cell);
  }
  const point = (candidate: unknown): [number, number] | null => {
    if (!Array.isArray(candidate) || candidate.length !== 2) return null;
    const [r, c] = candidate;
    if (typeof r !== 'number' || typeof c !== 'number') return null;
    if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null;
    return [r, c];
  };
  const from = point(start);
  const to = point(end);
  if (!from || !to) return null;
  return { rows, cols, cells: masks, start: from, end: to };
}

const indexOf = (maze: MazeShape, row: number, col: number): number => row * maze.cols + col;
const maskAt = (maze: MazeShape, row: number, col: number): number =>
  maze.cells[indexOf(maze, row, col)] ?? 15;

/** Every cell reachable through open passages from (row, col). */
function reachable(maze: MazeShape, row: number, col: number): Set<number> {
  const seen = new Set<number>([indexOf(maze, row, col)]);
  const stack: [number, number][] = [[row, col]];
  while (stack.length > 0) {
    const here = stack.pop();
    if (!here) break;
    const [r, c] = here;
    for (const move of MOVES) {
      if ((maskAt(maze, r, c) & move.wall) !== 0) continue;
      const nr = r + move.dr;
      const nc = c + move.dc;
      if (nr < 0 || nr >= maze.rows || nc < 0 || nc >= maze.cols) continue;
      const key = indexOf(maze, nr, nc);
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push([nr, nc]);
    }
  }
  return seen;
}

/** How many passages exist, counted once each. */
function passageCount(maze: MazeShape): number {
  let count = 0;
  for (let row = 0; row < maze.rows; row += 1) {
    for (let col = 0; col < maze.cols; col += 1) {
      if ((maskAt(maze, row, col) & E) === 0 && col + 1 < maze.cols) count += 1;
      if ((maskAt(maze, row, col) & S) === 0 && row + 1 < maze.rows) count += 1;
    }
  }
  return count;
}

/** The simple path from start to end, or null where none exists. */
function solvePath(maze: MazeShape): [number, number][] | null {
  const [sr, sc] = maze.start;
  const [er, ec] = maze.end;
  const from = new Map<number, number>();
  const seen = new Set<number>([indexOf(maze, sr, sc)]);
  const queue: [number, number][] = [[sr, sc]];
  while (queue.length > 0) {
    const here = queue.shift();
    if (!here) break;
    const [r, c] = here;
    if (r === er && c === ec) {
      const path: [number, number][] = [];
      let key: number | undefined = indexOf(maze, r, c);
      while (key !== undefined) {
        path.push([Math.floor(key / maze.cols), key % maze.cols]);
        key = from.get(key);
      }
      return path.reverse();
    }
    for (const move of MOVES) {
      if ((maskAt(maze, r, c) & move.wall) !== 0) continue;
      const nr = r + move.dr;
      const nc = c + move.dc;
      if (nr < 0 || nr >= maze.rows || nc < 0 || nc >= maze.cols) continue;
      const key = indexOf(maze, nr, nc);
      if (seen.has(key)) continue;
      seen.add(key);
      from.set(key, indexOf(maze, r, c));
      queue.push([nr, nc]);
    }
  }
  return null;
}

function generate(input: { seed: string; params: Record<string, unknown> }): GenerateResult {
  const rng = rngFor(`${ENGINE_ID}@${ENGINE_VERSION}:${input.seed}`);
  const asSize = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 60
      ? value
      : fallback;
  const rows = asSize(input.params['rows'], 12);
  const cols = asSize(input.params['cols'], 12);

  const maze: MazeShape = {
    rows,
    cols,
    cells: new Array<number>(rows * cols).fill(15),
    start: [0, 0],
    end: [rows - 1, cols - 1],
  };

  /*
   * Recursive backtracker, iterative so a large grid cannot exhaust the stack.
   * It produces a spanning tree by construction — every cell is visited
   * exactly once and every carve joins a visited cell to an unvisited one — so
   * the uniqueness the validator checks is a property of the algorithm rather
   * than something the generator asserts.
   */
  const visited = new Set<number>([0]);
  const stack: [number, number][] = [[0, 0]];
  while (stack.length > 0) {
    const here = stack[stack.length - 1];
    if (!here) break;
    const [r, c] = here;
    const options = rng.shuffled(MOVES).filter((move) => {
      const nr = r + move.dr;
      const nc = c + move.dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return false;
      return !visited.has(indexOf(maze, nr, nc));
    });
    const move = options[0];
    if (!move) {
      stack.pop();
      continue;
    }
    const nr = r + move.dr;
    const nc = c + move.dc;
    // Both sides of the same wall, together. Clearing one is the defect
    // `GRID_LEGALITY` exists to catch, and the way not to have it is to make
    // the two writes one statement.
    maze.cells[indexOf(maze, r, c)] = maskAt(maze, r, c) & ~move.wall;
    maze.cells[indexOf(maze, nr, nc)] = maskAt(maze, nr, nc) & ~move.opposite;
    visited.add(indexOf(maze, nr, nc));
    stack.push([nr, nc]);
  }

  const path = solvePath(maze);
  if (!path) {
    return { ok: false, error: 'The carved maze has no path from its start to its end.' };
  }

  const payload: PuzzlePayload = {
    puzzle: maze,
    solution: { path },
    answerKey: {
      steps: path.map(([r, c]) => `${r + 1},${c + 1}`),
      length: path.length,
    },
    instructions:
      'Draw a single unbroken line from the entrance at the top-left to the exit at the ' +
      'bottom-right without crossing a wall. Exactly one route exists.',
    meta: { rows, cols, pathLength: path.length, engine: ENGINE_ID },
  };

  const value: Generated = {
    payload,
    difficulty: rows * cols >= 400 ? 'HARD' : rows * cols >= 144 ? 'MEDIUM' : 'EASY',
    expectedSolveSeconds: Math.round(path.length * 1.5),
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
  const maze = readMaze(input.payload.puzzle);
  if (!maze) {
    return [
      {
        check: 'GRID_LEGALITY',
        ok: false,
        detail: 'The payload carries no readable maze: rows, cols, a cell mask each, a start and an end.',
      },
    ];
  }

  /* Every shared wall, from both sides; and the border closed all the way round. */
  const asymmetric: string[] = [];
  let openBorder = 0;
  for (let row = 0; row < maze.rows; row += 1) {
    for (let col = 0; col < maze.cols; col += 1) {
      for (const move of MOVES) {
        const nr = row + move.dr;
        const nc = col + move.dc;
        const here = (maskAt(maze, row, col) & move.wall) !== 0;
        if (nr < 0 || nr >= maze.rows || nc < 0 || nc >= maze.cols) {
          if (!here) openBorder += 1;
          continue;
        }
        const there = (maskAt(maze, nr, nc) & move.opposite) !== 0;
        if (here !== there) asymmetric.push(`(${row},${col})${move.name}`);
      }
    }
  }
  const legal = asymmetric.length === 0 && openBorder === 0;
  results.push({
    check: 'GRID_LEGALITY',
    ok: legal,
    detail: legal
      ? `A ${maze.rows}x${maze.cols} maze whose every shared wall agrees from both sides and ` +
        'whose border is closed.'
      : asymmetric.length > 0
        ? `${asymmetric.length} wall(s) disagree between the two cells that share them, ` +
          `starting at ${asymmetric[0]} — the maze renders differently from how it walks.`
        : `${openBorder} border wall(s) are open, so the maze leaks off the page.`,
  });

  const seen = reachable(maze, maze.start[0], maze.start[1]);
  const endReachable = seen.has(indexOf(maze, maze.end[0], maze.end[1]));
  results.push({
    check: 'REACHABILITY',
    ok: endReachable,
    detail: endReachable
      ? `The exit is reachable, and ${seen.size} of ${maze.rows * maze.cols} cells are.`
      : 'The exit cannot be reached from the entrance.',
  });

  /*
   * The tree test. Connected *and* exactly cells-1 passages is what makes the
   * simple path unique — either alone is not enough, since a disconnected
   * graph can have the right edge count and a connected one with a cycle can
   * have too many.
   */
  const cells = maze.rows * maze.cols;
  const passages = passageCount(maze);
  const connected = seen.size === cells;
  const isTree = connected && passages === cells - 1;
  results.push({
    check: 'SOLUTION_UNIQUENESS',
    ok: isTree,
    detail: isTree
      ? `Every cell is reachable and there are exactly ${passages} passages for ${cells} cells, ` +
        'so the route from entrance to exit is the only one.'
      : !connected
        ? `Only ${seen.size} of ${cells} cells are reachable, so parts of the maze are sealed off.`
        : `There are ${passages} passages for ${cells} cells, which is ${passages - (cells - 1)} ` +
          'too many — the maze contains a loop, so more than one route exists.',
  });

  const truth = solvePath(maze);
  const recorded = (input.payload.solution as { path?: unknown } | null)?.path;
  if (!truth) {
    results.push({
      check: 'ANSWER_KEY_AGREEMENT',
      ok: false,
      detail: 'There is no route for the recorded answer to agree with.',
    });
  } else {
    const steps =
      Array.isArray(recorded) &&
      recorded.every(
        (step): step is [number, number] =>
          Array.isArray(step) && step.length === 2 && step.every((n) => typeof n === 'number'),
      )
        ? (recorded as [number, number][])
        : null;
    let walks = false;
    if (steps && steps.length >= 1) {
      walks = true;
      const [fr, fc] = steps[0] as [number, number];
      const last = steps[steps.length - 1] as [number, number];
      if (fr !== maze.start[0] || fc !== maze.start[1]) walks = false;
      if (last[0] !== maze.end[0] || last[1] !== maze.end[1]) walks = false;
      const visited = new Set<number>();
      for (let index = 0; walks && index < steps.length; index += 1) {
        const [r, c] = steps[index] as [number, number];
        const key = indexOf(maze, r, c);
        // A route that revisits a cell is not a simple path, and a printed
        // answer that doubles back is one a solver cannot follow.
        if (visited.has(key)) walks = false;
        visited.add(key);
        if (index === 0) continue;
        const [pr, pc] = steps[index - 1] as [number, number];
        const move = MOVES.find((one) => one.dr === r - pr && one.dc === c - pc);
        if (!move) walks = false;
        else if ((maskAt(maze, pr, pc) & move.wall) !== 0) walks = false;
      }
    }
    results.push({
      check: 'ANSWER_KEY_AGREEMENT',
      ok: walks,
      detail: walks
        ? `The recorded route is ${steps?.length ?? 0} steps from entrance to exit and crosses ` +
          'no wall.'
        : 'The recorded route does not walk from the entrance to the exit through open passages ' +
          'without repeating a cell.',
    });
  }

  return results;
}

export const mazeEngine: PuzzleEngine = {
  id: ENGINE_ID,
  version: ENGINE_VERSION,
  formatKey: 'maze',
  summary:
    'Carves a perfect grid maze with a recursive backtracker, so uniqueness is a property of ' +
    'the construction, and proves it by counting passages against cells and walking every ' +
    'shared wall from both sides.',
  implementsChecks: [
    'GRID_LEGALITY',
    'REACHABILITY',
    'SOLUTION_UNIQUENESS',
    'ANSWER_KEY_AGREEMENT',
  ],
  generate,
  validate,
};
