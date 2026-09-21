/**
 * The engine registry.
 *
 * ---------------------------------------------------------------------------
 * This is not a list of puzzle formats
 * ---------------------------------------------------------------------------
 *
 * Worth saying plainly, because it is the one place in this kernel that could
 * be mistaken for one. A registry entry says *there is code here that can
 * generate and check this*. A `puzzle_formats` row says *this format exists in
 * the world*, and it exists because evidence named it or a person seeded it.
 *
 * The two are joined by `formatKey` and are deliberately allowed to disagree
 * in both directions. A format with no engine is the common case and reports
 * RESEARCHED — the directive's own instruction is not to claim support for
 * formats lacking real validators. An engine whose format nobody has
 * discovered yet is harmless: it generates nothing, because a master names a
 * format and a master is a person's decision.
 *
 * ---------------------------------------------------------------------------
 * The checks the kernel implements for everything
 * ---------------------------------------------------------------------------
 *
 * `DUPLICATE_DETECTION` is not any engine's. It is the unique index on
 * `(project_id, content_hash)` — a project-wide property that no per-instance
 * validator could establish, because an instance cannot see its siblings. It
 * is listed here so a format whose evidence demands duplicate detection is
 * correctly reported as covered rather than as missing a check that is
 * actually enforced by the database.
 */
import { mazeEngine } from './maze.ts';
import { sudokuEngine } from './sudoku.ts';
import { wordSearchEngine } from './wordsearch.ts';
import { formatKey } from '../../../domain/puzzle.ts';
import type { PuzzleEngine } from './types.ts';
import type { ValidationCheck } from '../../../domain/types.ts';

export type { Generated, GenerateResult, PuzzleEngine } from './types.ts';

/**
 * Checks the kernel guarantees for every format, whatever engine is behind it.
 *
 * Exactly one member, and adding a second needs an argument: a check belongs
 * here only when the kernel itself enforces it in a way no validator could,
 * and anything else put here would be a check reported as covered that nothing
 * runs.
 */
export const KERNEL_CHECKS: readonly ValidationCheck[] = Object.freeze(['DUPLICATE_DETECTION']);

const ENGINES: readonly PuzzleEngine[] = Object.freeze([
  sudokuEngine,
  wordSearchEngine,
  mazeEngine,
]);

/** Every registered engine, for the surface and for the maturity reading. */
export function listEngines(): readonly PuzzleEngine[] {
  return ENGINES;
}

export function engineById(id: string): PuzzleEngine | null {
  return ENGINES.find((one) => one.id === id) ?? null;
}

/** The engines that serve one format. Several may, and the master names which. */
export function enginesForFormat(key: string): PuzzleEngine[] {
  const wanted = formatKey(key);
  return ENGINES.filter((one) => formatKey(one.formatKey) === wanted);
}

/**
 * Every check anything in this Brain can actually run for one format.
 *
 * The union of its engines' declarations and the kernel's own. This is one
 * half of the VALIDATABLE reading; the other half is what the evidence says
 * the format demands, and `maturity.ts` is where they meet.
 */
export function checksAvailableFor(key: string): ValidationCheck[] {
  const out = new Set<ValidationCheck>(KERNEL_CHECKS);
  for (const engine of enginesForFormat(key)) {
    for (const check of engine.implementsChecks) out.add(check);
  }
  return [...out];
}
