/**
 * The contract a generator and a validator share.
 *
 * ---------------------------------------------------------------------------
 * One canonical source, produced once
 * ---------------------------------------------------------------------------
 *
 * The brief requires the puzzle, the solution, the answer key and the
 * production layout to come from the same canonical source so they cannot
 * silently diverge. `GeneratedPuzzle.payload` is that source: one call
 * produces the puzzle *and* its answer together, and every compiler reads it
 * rather than re-deriving anything. Nothing downstream ever solves a puzzle to
 * find out what its answer is — that would be a second derivation, and the two
 * would eventually disagree.
 *
 * ---------------------------------------------------------------------------
 * A generator reports failure; it never returns something broken
 * ---------------------------------------------------------------------------
 *
 * Generation is search, and search can fail — a word list that cannot be
 * placed in a grid that small, a dig that cannot preserve uniqueness. Every
 * generator returns a refusal with a sentence rather than a puzzle it could
 * not finish. §27's rule: an outcome delivered as success is the one a caller
 * cannot recover from.
 */
import type { PuzzleVerdict } from '../../domain/types.ts';

/** What one call to a generator produced. */
export interface GeneratedPuzzle {
  /** The puzzle and its answer, from one call. */
  payload: Record<string, unknown>;
  /**
   * The format's own canonical form, for duplicate detection.
   *
   * What each one actually catches is documented beside the function that
   * produces it, because a canonical form is always a subset of true
   * equivalence and a reader who assumed otherwise would trust it too far.
   */
  canonical: string;
  /**
   * What the solver needed, and what was measured to get it.
   *
   * Null where the format has no difficulty model at all — a real answer, and
   * never a 0 that would sort as *easiest*.
   */
  difficulty: { value: number; basis: string } | null;
}

export type GeneratorOutcome =
  | { ok: true; value: GeneratedPuzzle }
  | { ok: false; error: string };

export type Generator = (input: { spec: Record<string, unknown>; seed: string }) => GeneratorOutcome;

/** One check's answer about one puzzle. */
export interface CheckOutcome {
  check: string;
  verdict: PuzzleVerdict;
  /** What the check saw. Required by the schema on a failure. */
  detail?: string;
}

/**
 * A validator answers about a payload and nothing else.
 *
 * It is deliberately given no access to the master, the spec or the generator.
 * A check that could read what the generator intended would be grading against
 * the intention rather than against the artifact — §27's sentence about a
 * factory that could edit its own acceptance conditions, at a puzzle.
 */
export type Validator = (payload: Record<string, unknown>) => CheckOutcome[];

export function refuse(error: string): GeneratorOutcome {
  return { ok: false, error };
}

export function pass(check: string): CheckOutcome {
  return { check, verdict: 'PASS' };
}

export function fail(check: string, detail: string): CheckOutcome {
  return { check, verdict: 'FAIL', detail };
}
