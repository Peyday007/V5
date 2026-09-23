/**
 * Maze: carved by a generator, walked by a validator that parses the printed
 * page back into a graph.
 *
 * ---------------------------------------------------------------------------
 * What is actually checked
 * ---------------------------------------------------------------------------
 *
 * Three things, and only the first is the one people expect. That the end is
 * reachable from the start — obvious, and the cheap half. That the open cells
 * form a **tree**: as many edges as cells less one, which is what makes the
 * solution unique, and which a maze with one accidental extra opening quietly
 * stops being. And that the printed solution is the path the grid actually
 * has, walked cell by cell through openings rather than compared to a record
 * the generator kept.
 *
 * The second is the interesting one. A maze with a loop still has a solution,
 * still prints, still looks right, and has two answers — so the answer key is
 * one of two correct routes and a child who found the other is told they are
 * wrong. Nothing about the picture shows it. The edge count does.
 *
 * ---------------------------------------------------------------------------
 * The validator parses the characters
 * ---------------------------------------------------------------------------
 *
 * It is handed the ASCII a book would print and nothing else: no wall list, no
 * carve order, no adjacency it was given. Walls are `#`, open squares are
 * spaces, and the start and end are the two letters. That is a deliberately
 * dumb representation, chosen because a dumb one can be read back
 * unambiguously and a pretty one cannot.
 */
import {
  bandFor,
  check,
  intParam,
  Rng,
  sha256,
  verdictFrom,
  type PuzzleArtifact,
  type PuzzleCheck,
  type PuzzleFormat,
  type PuzzleSpec,
  type PuzzleVerdict,
} from './engine.ts';
import type { PuzzleDifficulty } from '../../../domain/types.ts';

export const MAZE_KEY = 'maze';

const WALL = '#';
const OPEN = ' ';
const START = 'S';
const END = 'E';
const PATH = '*';

function render(spec: PuzzleSpec): PuzzleArtifact {
  const width = intParam(spec, 'width', 12, 3, 40);
  const height = intParam(spec, 'height', 12, 3, 40);
  const intended = (spec.parameters['difficulty'] as PuzzleDifficulty | undefined) ?? 'MEDIUM';
  const rng = new Rng(`${spec.seed}:maze`);

  /*
   * A depth-first carve, which produces a perfect maze by construction: every
   * cell is visited exactly once and each visit opens exactly one wall, so the
   * result is a spanning tree and the path between any two cells is unique.
   *
   * That is the generator's reasoning and it is not what the instance is
   * accepted on. `validate` counts the edges in the printed grid, which is
   * what catches a carve that was interrupted, a rendering that opened a wall
   * it should not have, or a change to this function made three years from
   * now by somebody who did not read this paragraph.
   */
  const visited: boolean[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );
  const openRight: boolean[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );
  const openDown: boolean[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );

  const stack: [number, number][] = [[0, 0]];
  (visited[0] as boolean[])[0] = true;
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as [number, number];
    const [r, c] = top;
    const options: [number, number][] = [];
    if (r > 0 && !(visited[r - 1] as boolean[])[c]) options.push([r - 1, c]);
    if (r < height - 1 && !(visited[r + 1] as boolean[])[c]) options.push([r + 1, c]);
    if (c > 0 && !(visited[r] as boolean[])[c - 1]) options.push([r, c - 1]);
    if (c < width - 1 && !(visited[r] as boolean[])[c + 1]) options.push([r, c + 1]);
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const chosen = rng.pick(options) as [number, number];
    const [nr, nc] = chosen;
    if (nr === r && nc === c + 1) (openRight[r] as boolean[])[c] = true;
    if (nr === r && nc === c - 1) (openRight[r] as boolean[])[c - 1] = true;
    if (nr === r + 1 && nc === c) (openDown[r] as boolean[])[c] = true;
    if (nr === r - 1 && nc === c) (openDown[r - 1] as boolean[])[c] = true;
    (visited[nr] as boolean[])[nc] = true;
    stack.push([nr, nc]);
  }

  const rows = height * 2 + 1;
  const cols = width * 2 + 1;
  const canvas: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => WALL),
  );
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      (canvas[r * 2 + 1] as string[])[c * 2 + 1] = OPEN;
      if ((openRight[r] as boolean[])[c]) (canvas[r * 2 + 1] as string[])[c * 2 + 2] = OPEN;
      if ((openDown[r] as boolean[])[c]) (canvas[r * 2 + 2] as string[])[c * 2 + 1] = OPEN;
    }
  }
  (canvas[1] as string[])[1] = START;
  (canvas[height * 2 - 1] as string[])[width * 2 - 1] = END;

  const grid = canvas.map((row) => row.join(''));

  /*
   * The solution is walked on the emitted canvas rather than reconstructed
   * from the carve, so the printed answer is a route through the printed maze
   * by construction. It is the same discipline the validator applies, applied
   * once at the moment the two are written — which is what makes them one
   * source rather than two that agree today.
   */
  const route = shortestPath(grid);
  const marked = canvas.map((row) => [...row]);
  for (const [r, c] of route) {
    if ((marked[r] as string[])[c] === OPEN) (marked[r] as string[])[c] = PATH;
  }

  return {
    formatKey: MAZE_KEY,
    instructions: `Find the single route from ${START} to ${END}. There are no loops, so there ` +
      'is exactly one way through.',
    grid,
    prompts: [`${width} by ${height} cells.`],
    solution: marked.map((row) => row.join('')),
    /*
     * The key is the route as moves rather than a second picture, because that
     * is what a book prints at the back: a small column of letters beside the
     * puzzle number, rather than the whole maze again.
     */
    answerKey: [movesFrom(route)],
    intendedDifficulty: intended,
  };
}

/** Every square a solver may stand on. */
function passable(ch: string): boolean {
  return ch === OPEN || ch === START || ch === END || ch === PATH;
}

function findChar(grid: readonly string[], target: string): [number, number] | null {
  for (let r = 0; r < grid.length; r += 1) {
    const col = (grid[r] ?? '').indexOf(target);
    if (col >= 0) return [r, col];
  }
  return null;
}

/** Breadth-first, so the route found is the shortest — which in a tree is the only one. */
export function shortestPath(grid: readonly string[]): [number, number][] {
  const start = findChar(grid, START);
  const end = findChar(grid, END);
  if (!start || !end) return [];
  const key = (r: number, c: number) => `${r},${c}`;
  const cameFrom = new Map<string, string | null>();
  const queue: [number, number][] = [start];
  cameFrom.set(key(start[0], start[1]), null);
  while (queue.length > 0) {
    const [r, c] = queue.shift() as [number, number];
    if (r === end[0] && c === end[1]) break;
    for (const [dr, dc] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      const rr = r + dr;
      const cc = c + dc;
      const ch = (grid[rr] ?? '')[cc];
      if (ch === undefined || !passable(ch)) continue;
      if (cameFrom.has(key(rr, cc))) continue;
      cameFrom.set(key(rr, cc), key(r, c));
      queue.push([rr, cc]);
    }
  }
  if (!cameFrom.has(key(end[0], end[1]))) return [];
  const out: [number, number][] = [];
  let cursor: string | null = key(end[0], end[1]);
  while (cursor) {
    const [r, c] = cursor.split(',').map(Number) as [number, number];
    out.unshift([r, c]);
    cursor = cameFrom.get(cursor) ?? null;
  }
  return out;
}

function movesFrom(route: readonly [number, number][]): string {
  const letters: string[] = [];
  for (let i = 1; i < route.length; i += 1) {
    const [pr, pc] = route[i - 1] as [number, number];
    const [r, c] = route[i] as [number, number];
    if (r > pr) letters.push('D');
    else if (r < pr) letters.push('U');
    else if (c > pc) letters.push('R');
    else letters.push('L');
  }
  return letters.join('');
}

function validate(artifact: PuzzleArtifact): PuzzleVerdict {
  const checks: PuzzleCheck[] = [];
  const grid = artifact.grid;
  const width = grid[0]?.length ?? 0;
  const rectangular = grid.length >= 3 && width >= 3 && grid.every((row) => row.length === width);
  checks.push(
    check(
      'the maze is a rectangle',
      rectangular,
      rectangular ? `${grid.length} by ${width} characters.` : 'The rows are not all one length.',
    ),
  );
  if (!rectangular) return verdictFrom(checks, null, sha256(`maze:${grid.join('|')}`));

  const start = findChar(grid, START);
  const end = findChar(grid, END);
  checks.push(
    check(
      'there is exactly one start and one end',
      start !== null &&
        end !== null &&
        grid.join('').split(START).length === 2 &&
        grid.join('').split(END).length === 2,
      start && end
        ? `Start at row ${start[0] + 1}, end at row ${end[0] + 1}.`
        : 'A maze with no marked start or end cannot be attempted.',
    ),
  );

  /*
   * The tree check.
   *
   * Count the passable squares and the openings between adjacent ones. A
   * connected graph is a tree exactly when it has one fewer edge than it has
   * vertices, and a tree is exactly a maze with one route. An extra opening
   * anywhere — one wall character that should not be a space — adds an edge,
   * makes a loop, and gives the maze a second answer without changing how it
   * looks.
   */
  let cells = 0;
  let edges = 0;
  for (let r = 0; r < grid.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const ch = (grid[r] ?? '')[c] ?? WALL;
      if (!passable(ch)) continue;
      cells += 1;
      if (passable((grid[r] ?? '')[c + 1] ?? WALL)) edges += 1;
      if (passable((grid[r + 1] ?? '')[c] ?? WALL)) edges += 1;
    }
  }

  const route = shortestPath(grid);
  checks.push(
    check(
      'the end is reachable from the start',
      route.length > 0,
      route.length > 0
        ? `A route of ${route.length - 1} step(s) was walked through the printed grid.`
        : 'No route from start to end exists in the printed grid.',
    ),
  );

  const reachable = route.length > 0 ? countReachable(grid) : 0;
  const connected = reachable === cells;
  checks.push(
    check(
      'every open square is part of the maze',
      connected,
      connected
        ? `All ${cells} open squares are reachable from the start.`
        : `${cells - reachable} open square(s) are walled off entirely, which prints as a ` +
          'maze with pockets nobody can reach.',
    ),
  );

  const isTree = connected && edges === cells - 1;
  checks.push(
    check(
      'exactly one route through',
      isTree,
      isTree
        ? `${cells} squares and ${edges} openings, which is a tree, so the route is unique.`
        : `${cells} squares and ${edges} openings. A maze with ${
            edges - (cells - 1)
          } extra opening(s) has more than one answer, and the key names one of them.`,
    ),
  );

  /*
   * The printed solution walked rather than compared.
   *
   * The marked squares are checked to be a connected path from start to end
   * through squares that are actually open, and the key's letters are followed
   * from the start to see where they land. Either can be wrong on its own: a
   * route drawn through a wall, or a key that transcribed a turn wrongly.
   */
  const marked: [number, number][] = [];
  for (let r = 0; r < artifact.solution.length; r += 1) {
    const line = artifact.solution[r] ?? '';
    for (let c = 0; c < line.length; c += 1) {
      if (line[c] === PATH) marked.push([r, c]);
    }
  }
  const drawnOk =
    route.length > 0 &&
    marked.length === route.length - 2 &&
    marked.every(([r, c]) => route.some(([rr, cc]) => rr === r && cc === c));
  checks.push(
    check(
      'the drawn solution is the route',
      drawnOk,
      drawnOk
        ? 'Every marked square lies on the route found by walking the maze.'
        : 'The marked squares are not the route this maze actually has.',
    ),
  );

  const keyOk = start !== null && followKey(grid, artifact.answerKey[0] ?? '', start, end);
  checks.push(
    check(
      'the answer key reaches the end',
      keyOk,
      keyOk
        ? 'The key was followed from the start, move by move, and arrived at the end.'
        : 'Following the printed key from the start walks into a wall or stops somewhere else.',
    ),
  );

  /*
   * Difficulty from what a solver faces: how long the route is against how
   * much maze there is, and how many junctions offer a wrong turn. A long
   * route through a corridor is tedious rather than hard; a short one through
   * a thicket of branches is the opposite.
   */
  let measured: PuzzleDifficulty | null = null;
  if (route.length > 0 && cells > 0) {
    const junctions = countJunctions(grid);
    const density = junctions / cells;
    const length = (route.length - 1) / cells;
    measured = bandFor(density * 0.7 + length * 0.3, [0.12, 0.2, 0.3]);
  }

  return verdictFrom(checks, measured, sha256(`maze:${grid.join('|')}`));
}

function countReachable(grid: readonly string[]): number {
  const start = findChar(grid, START);
  if (!start) return 0;
  const seen = new Set<string>([`${start[0]},${start[1]}`]);
  const queue: [number, number][] = [start];
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
      const ch = (grid[rr] ?? '')[cc];
      if (ch === undefined || !passable(ch)) continue;
      const key = `${rr},${cc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([rr, cc]);
    }
  }
  return seen.size;
}

function countJunctions(grid: readonly string[]): number {
  let out = 0;
  for (let r = 0; r < grid.length; r += 1) {
    const line = grid[r] ?? '';
    for (let c = 0; c < line.length; c += 1) {
      if (!passable(line[c] ?? WALL)) continue;
      let degree = 0;
      for (const [dr, dc] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ] as const) {
        if (passable((grid[r + dr] ?? '')[c + dc] ?? WALL)) degree += 1;
      }
      if (degree >= 3) out += 1;
    }
  }
  return out;
}

function followKey(
  grid: readonly string[],
  key: string,
  start: [number, number],
  end: [number, number] | null,
): boolean {
  if (!end || !/^[UDLR]*$/.test(key)) return false;
  let [r, c] = start;
  for (const move of key) {
    if (move === 'U') r -= 1;
    else if (move === 'D') r += 1;
    else if (move === 'L') c -= 1;
    else c += 1;
    const ch = (grid[r] ?? '')[c];
    if (ch === undefined || !passable(ch)) return false;
  }
  return r === end[0] && c === end[1];
}

export const MAZE: PuzzleFormat = {
  key: MAZE_KEY,
  title: 'Maze',
  authoring: 'GENERATED',
  requiresHumanEdit: false,
  limitation:
    'Reachability, connectedness and uniqueness are all read from the printed characters: the ' +
    'route is walked, and the openings are counted against the squares to prove the maze is a ' +
    'tree rather than trusting the carve. Difficulty is junction density and route length, ' +
    'which is a property of the grid and not a measure of how a person experiences it.',
  render,
  validate,
  /* More spanning trees of a twelve-by-twelve grid than anybody will print. */
  catalogCeiling: null,
};
