/**
 * Grid helpers, and the canonical form that decides whether two puzzles are
 * the same puzzle.
 *
 * ---------------------------------------------------------------------------
 * What the canonical form catches, said plainly rather than implied
 * ---------------------------------------------------------------------------
 *
 * `canonicalGrid` returns the lexicographic minimum over the eight symmetries
 * of a square grid — four rotations and their reflections. For a puzzle whose
 * symbols are arbitrary labels, `relabel` is applied first, which renames the
 * symbols by order of first appearance in reading order.
 *
 * So two puzzles collide when one is the other **rotated, reflected, or with
 * its symbols renamed**, in any combination. That is a real and useful subset
 * of equivalence and it is emphatically not all of it. For Sudoku in
 * particular the full equivalence group also permutes rows within a band,
 * columns within a stack, and the bands and stacks themselves — 3,359,232
 * further forms per grid. Those are not caught.
 *
 * This is written down because the failure mode matters and is asymmetric:
 * the check **misses duplicates** and never invents one. A missed duplicate is
 * a puzzle printed twice in a book, which is a quality complaint; a false
 * positive would refuse to store a genuinely new puzzle, and a generator whose
 * output silently vanished would be very hard to diagnose. §14's shape at a
 * grid — a claim that two things are the same needs to be established, and the
 * cheap direction to be wrong in is the one this takes.
 */

export interface Grid {
  width: number;
  height: number;
  /** Row-major, `width * height` entries. */
  cells: string[];
}

export function gridFromRows(rows: readonly string[]): Grid {
  const height = rows.length;
  const width = height > 0 ? (rows[0]?.length ?? 0) : 0;
  const cells: string[] = [];
  for (const row of rows) {
    for (const ch of row) cells.push(ch);
  }
  return { width, height, cells };
}

export function rowsFromGrid(grid: Grid): string[] {
  const rows: string[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    rows.push(grid.cells.slice(y * grid.width, (y + 1) * grid.width).join(''));
  }
  return rows;
}

export function cellAt(grid: Grid, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return '';
  return grid.cells[y * grid.width + x] ?? '';
}

/** Rotate a quarter turn clockwise. */
function rotate(grid: Grid): Grid {
  const cells: string[] = [];
  for (let y = 0; y < grid.width; y += 1) {
    for (let x = 0; x < grid.height; x += 1) {
      cells.push(cellAt(grid, y, grid.height - 1 - x));
    }
  }
  return { width: grid.height, height: grid.width, cells };
}

/** Mirror left to right. */
function mirror(grid: Grid): Grid {
  const cells: string[] = [];
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      cells.push(cellAt(grid, grid.width - 1 - x, y));
    }
  }
  return { width: grid.width, height: grid.height, cells };
}

/** All eight symmetries of the grid, including the identity. */
export function dihedral(grid: Grid): Grid[] {
  const out: Grid[] = [];
  let current = grid;
  for (let turn = 0; turn < 4; turn += 1) {
    out.push(current, mirror(current));
    current = rotate(current);
  }
  return out;
}

/**
 * Rename symbols by order of first appearance in reading order.
 *
 * `blanks` are left exactly as they are, because a blank is a structural fact
 * about the puzzle rather than a symbol: relabelling it would make a grid with
 * different holes collide with one that has the same shape filled in.
 */
export function relabel(grid: Grid, blanks: ReadonlySet<string>): Grid {
  const map = new Map<string, string>();
  const alphabet = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const cells = grid.cells.map((cell) => {
    if (blanks.has(cell)) return cell;
    const known = map.get(cell);
    if (known !== undefined) return known;
    const next = alphabet[map.size] ?? `#${map.size}`;
    map.set(cell, next);
    return next;
  });
  return { width: grid.width, height: grid.height, cells };
}

/**
 * The canonical string for a grid: the least of its eight symmetries.
 *
 * The dimensions are part of the key, so a 5x7 and a 7x5 holding the same
 * letters do not collide through the rotation that maps one onto the other
 * while meaning two different products.
 */
export function canonicalGrid(grid: Grid, options?: { blanks?: ReadonlySet<string> }): string {
  const blanks = options?.blanks;
  const base = blanks ? relabel(grid, blanks) : grid;
  let best: string | null = null;
  for (const variant of dihedral(base)) {
    const key = `${variant.width}x${variant.height}:${variant.cells.join('')}`;
    if (best === null || key < best) best = key;
  }
  return best ?? '';
}
