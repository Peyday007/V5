/**
 * What a puzzle generator is, what a validator is, and the wall between them.
 *
 * ---------------------------------------------------------------------------
 * A generated grid is not a puzzle until something that did not generate it
 * has proved it
 * ---------------------------------------------------------------------------
 *
 * This is the rule the whole kernel rests on, and it is the puzzle trade's
 * version of a sentence this repository has already written three times. §27:
 * *a worker's summary is never evidence; the branch is.* §42: *a render is the
 * interface, and code is a claim about it.* §9: *a file on disk is not
 * something Brain has read.* Here: a generator's own belief that it produced a
 * solvable puzzle with a unique answer is a claim about its own internals, and
 * the only thing that establishes it is a solver reading the emitted artifact
 * and reaching the same answer by itself.
 *
 * So the contract is deliberately narrow: **`validate` receives the artifact
 * and nothing else.** Not the spec, not the seed, not the generator's working
 * — no `placements` list to check against, no record of which cells were dug.
 * A word search validator is handed a rectangle of letters and a word list,
 * and it must find the words itself, in a grid it knows nothing about the
 * making of. That is what makes a passing verdict mean something, and it is
 * also what makes a *failing* one a real finding rather than an internal
 * inconsistency.
 *
 * The cost of this is real and is paid deliberately: the validators re-do work
 * the generators already did, and the sudoku validator in particular counts
 * solutions from scratch on a grid it has never seen. That duplication is the
 * mechanism.
 *
 * ---------------------------------------------------------------------------
 * The puzzle, the solution and the answer key come from one source
 * ---------------------------------------------------------------------------
 *
 * The operator's brief is explicit that these must not silently diverge, and
 * the way they cannot is that **nothing is stored except the specification**.
 * A `PuzzleSpec` is a format, a seed and a small set of parameters; `render`
 * turns it into the grid, the solution and the key together, deterministically,
 * every time. There is no copy of a grid anywhere that a later edit could make
 * disagree with its answers, because there is no copy of a grid anywhere.
 *
 * Determinism is therefore load-bearing rather than a convenience, and it is
 * tested as a property: the same spec must render byte-identically on a second
 * call and in a second process, or a stored content hash describes something
 * nobody can reproduce.
 *
 * ---------------------------------------------------------------------------
 * Difficulty is measured, never asserted
 * ---------------------------------------------------------------------------
 *
 * A generator may say what it was *aiming* at. What is stored is what the
 * validator measured by actually solving the thing — the technique ladder a
 * sudoku needs, the path length a maze has, the letter coverage a cryptogram
 * gives the solver. Where a format has no honest measure, the measurement is
 * `null` and stays null: a band a generator asserted and nothing checked is
 * §8's model output as state, wearing a number.
 */
import { createHash } from 'node:crypto';
import type { PuzzleDifficulty } from '../../../domain/types.ts';

/**
 * A puzzle, as specified rather than as drawn.
 *
 * `parameters` is format-specific and deliberately untyped at this layer: each
 * format reads its own and refuses what it does not recognise, so a parameter
 * nobody implements is a refusal rather than a silently ignored field.
 */
export interface PuzzleSpec {
  formatKey: string;
  corpusId: string;
  /** The only source of randomness. Everything downstream is a function of it. */
  seed: string;
  parameters: Readonly<Record<string, string | number>>;
}

/** What a solver is handed, what they are asked, and what the answer is. */
export interface PuzzleArtifact {
  formatKey: string;
  /** What the solver is told to do, printed above the grid. */
  instructions: string;
  /** The playable thing, one string per row. */
  grid: readonly string[];
  /** Anything beside the grid the solver needs: a word list, a cipher hint. */
  prompts: readonly string[];
  /** The completed puzzle, in the same shape as `grid`. */
  solution: readonly string[];
  /** What a product prints at the back, which is often not the solution grid. */
  answerKey: readonly string[];
  /** What the generator was aiming at. Never stored, never trusted. */
  intendedDifficulty: PuzzleDifficulty;
}

/** One thing the validator actually checked, and what it found. */
export interface PuzzleCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The verdict.
 *
 * `VALID` is every check passing. There is no partial credit and no warning
 * tier: a puzzle with one word missing from the grid is a puzzle somebody
 * cannot finish, and a product containing it is a refund. What a warning tier
 * would buy is the ability to ship something known to be broken, which is the
 * one thing this kernel exists to make impossible.
 */
export interface PuzzleVerdict {
  state: 'VALID' | 'INVALID';
  checks: readonly PuzzleCheck[];
  /** Measured by solving. Null where the format has no honest measure. */
  measuredDifficulty: PuzzleDifficulty | null;
  /**
   * A canonical form of the puzzle, for duplicate detection.
   *
   * Canonical rather than literal: two sudoku grids that differ only by a
   * relabelling of digits or a permutation of bands are the same puzzle to
   * anybody solving them, and a hash of the printed characters would call them
   * different. What "canonical" means is the format's to decide, and a format
   * with no meaningful canonical form hashes the artifact itself and says so.
   */
  canonicalHash: string;
}

export interface PuzzleFormat {
  key: string;
  title: string;
  /**
   * Whether a machine can produce this format at all, or whether it is
   * authored.
   *
   * `AUTHORED` is not a lesser state to be fixed later: a crossword's fill and
   * its clues are editorial work, and a generator that emitted one would be
   * producing exactly the unvalidated filler the brief forbids. A format
   * declared AUTHORED has a validator and no generator, which is honest and is
   * what lets Brain *check* a human-authored grid without pretending to write
   * one.
   */
  authoring: 'GENERATED' | 'AUTHORED';
  /**
   * Whether a person must read every instance before it may be sold.
   *
   * True wherever the machine check cannot see the thing that goes wrong:
   * ambiguity, cultural fit, whether a clue is fair, whether a puzzle is any
   * fun. `services/puzzle/maturity.ts` will not let such a format reach
   * SELLABLE on machine validation alone, and there is no flag anywhere that
   * overrides it.
   */
  requiresHumanEdit: boolean;
  /** What this format can and cannot establish about itself, in one line. */
  limitation: string;
  /** Absent for an AUTHORED format, which is the point of the distinction. */
  render: ((spec: PuzzleSpec) => PuzzleArtifact) | null;
  /**
   * How many distinct puzzles this format can make from one corpus, or null
   * where the answer is *more than anybody will ask for*.
   *
   * A real bound rather than a tuning knob, and it exists because one of these
   * formats has one. A cryptogram is a passage under a cipher, so a corpus of
   * sixteen proverbs is a catalog of sixteen cryptograms whatever the seed
   * does — and without this the generator is asked for forty every pass,
   * renders new seeds, finds the same sixteen puzzles under the canonical
   * form, and refuses them. Bounded, deterministic and entirely wasted: a
   * loop that looks like work, which §27 records as worse than a stop.
   *
   * A grid format returns null because its space genuinely is not the
   * corpus — there are more sudoku grids than anybody will print.
   */
  catalogCeiling: ((corpusId: string, parameters: PuzzleSpec['parameters']) => number | null) | null;
  /** Never absent. A format Brain cannot check is a format Brain cannot sell. */
  validate: (artifact: PuzzleArtifact) => PuzzleVerdict;
}

/* --------------------------------------------------------------------------
 * Determinism
 * ------------------------------------------------------------------------ */

/**
 * A seeded generator, because `Math.random` would make every stored hash a
 * description of something nobody can reproduce.
 *
 * xorshift128, which is not cryptographic and does not need to be: what is
 * required here is that the same seed produces the same stream on every
 * platform and in every process, for ever. A cryptographic generator would be
 * slower and would buy nothing, and a platform-provided one would be a
 * dependency on a version.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    const digest = createHash('sha256').update(seed).digest();
    this.a = digest.readUInt32BE(0) || 1;
    this.b = digest.readUInt32BE(4) || 2;
    this.c = digest.readUInt32BE(8) || 3;
    this.d = digest.readUInt32BE(12) || 4;
  }

  /** A float in [0, 1). */
  next(): number {
    let t = this.a ^ (this.a << 11);
    t >>>= 0;
    this.a = this.b;
    this.b = this.c;
    this.c = this.d;
    this.d = (this.d ^ (this.d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return this.d / 0x100000000;
  }

  /** An integer in [0, bound). */
  int(bound: number): number {
    if (bound <= 0) return 0;
    return Math.floor(this.next() * bound) % bound;
  }

  /** A Fisher-Yates shuffle of a copy, so the caller's array is untouched. */
  shuffle<T>(values: readonly T[]): T[] {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }

  pick<T>(values: readonly T[]): T | null {
    if (values.length === 0) return null;
    return values[this.int(values.length)] ?? null;
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The hash of an artifact exactly as printed.
 *
 * Used as the content hash of every instance, and as the canonical hash of
 * formats that have no stronger notion of sameness. It includes the solution
 * and the answer key deliberately: two puzzles with the same grid and
 * different stated answers are not one puzzle, they are one puzzle and one
 * defect.
 */
export function artifactHash(artifact: PuzzleArtifact): string {
  return sha256(
    JSON.stringify([
      artifact.formatKey,
      artifact.instructions,
      artifact.grid,
      artifact.prompts,
      artifact.solution,
      artifact.answerKey,
    ]),
  );
}

/** Every check passing, and nothing else, is a valid puzzle. */
export function verdictFrom(
  checks: readonly PuzzleCheck[],
  measuredDifficulty: PuzzleDifficulty | null,
  canonicalHash: string,
): PuzzleVerdict {
  return {
    state: checks.every((one) => one.ok) ? 'VALID' : 'INVALID',
    checks,
    /*
     * A difficulty measured on an invalid puzzle is a measurement of
     * something nobody can solve, so it is withheld rather than reported.
     * Reporting it would put a plausible band on a broken artifact, which is
     * exactly the shape of thing a later reader trusts.
     */
    measuredDifficulty: checks.every((one) => one.ok) ? measuredDifficulty : null,
    canonicalHash,
  };
}

export function check(name: string, ok: boolean, detail: string): PuzzleCheck {
  return { name, ok, detail };
}

/** Read a positive integer parameter, or fall back. Refuses a nonsense value. */
export function intParam(
  spec: PuzzleSpec,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = spec.parameters[name];
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${spec.formatKey}: ${name} must be a whole number between ${min} and ${max}; ` +
        `got ${String(raw)}. A parameter outside what the generator implements is refused ` +
        'rather than clamped, because a clamped one produces a puzzle nobody asked for.',
    );
  }
  return value;
}

export function stringParam(spec: PuzzleSpec, name: string, fallback: string): string {
  const raw = spec.parameters[name];
  return raw === undefined ? fallback : String(raw);
}

/** The band a numeric score falls in, given three ascending thresholds. */
export function bandFor(
  score: number,
  thresholds: readonly [number, number, number],
): PuzzleDifficulty {
  if (score < thresholds[0]) return 'EASY';
  if (score < thresholds[1]) return 'MEDIUM';
  if (score < thresholds[2]) return 'HARD';
  return 'EXPERT';
}
