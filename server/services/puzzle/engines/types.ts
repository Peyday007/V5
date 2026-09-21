/**
 * What a puzzle engine is, and the two things it must declare about itself.
 *
 * ---------------------------------------------------------------------------
 * An engine is an implementation; a format is not
 * ---------------------------------------------------------------------------
 *
 * §37's sentence at a new artifact: *a definition is not an implementation*. A
 * `puzzle_formats` row says a format exists in the world, and it exists
 * because evidence named it or a person seeded it. An engine is code somebody
 * wrote. The two meet only at `formatKey`, and a format with no engine reports
 * RESEARCHED rather than GENERATABLE — which is the honest answer and the one
 * the directive demands in as many words: *do not falsely claim support for
 * puzzle formats lacking real validators.*
 *
 * ---------------------------------------------------------------------------
 * `implements` is the half that makes VALIDATABLE a reading
 * ---------------------------------------------------------------------------
 *
 * An engine declares which checks its validator actually runs. The evidence
 * declares which checks the trade demands of that format. A format is
 * VALIDATABLE only when the second is covered by the first *plus* the checks
 * the kernel itself implements for everything, and a format whose evidence
 * demands a check nothing implements is reported as exactly that, with the
 * check named.
 *
 * That is why `implements` is a declaration rather than something derived from
 * what `validate` happens to return: a validator that returned no result for a
 * check it could not run would be indistinguishable from one that ran it and
 * found nothing wrong. An `UNCHECKED` verdict exists for the same reason —
 * *the validator ran and could not answer* is a third outcome with a third
 * remedy, and folding it into either of the others is the collapse §30 keeps
 * correcting.
 *
 * ---------------------------------------------------------------------------
 * Generation is deterministic, and that is a repair mechanism
 * ---------------------------------------------------------------------------
 *
 * The same engine at the same version, given the same seed and the same
 * params, must produce the same payload byte for byte. It is what makes the
 * directive's rule enforceable: *if a systematic defect appears, block the
 * batch and repair the generator — do not manually patch dozens of broken
 * outputs and leave the source defect alive.* A defect you cannot reproduce is
 * a defect you can only patch.
 */
import type { PuzzlePayload, ValidationCheck, ValidationCheckResult } from '../../../domain/types.ts';

/** What one generation produced, before it is a row. */
export interface Generated {
  payload: PuzzlePayload;
  /** The engine's own reading. A validator checks it where a standard demands. */
  difficulty: string | null;
  expectedSolveSeconds: number | null;
  locale: string | null;
}

export type GenerateResult =
  | { ok: true; value: Generated }
  /**
   * A generator that could not produce one is a **result**, never a throw.
   * §21's rule about a tool's own failure, at a generator: a refusal delivered
   * as a crash is one the batch runner cannot see, count or act on, and a
   * generator that fails on one in fifty seeds is a real and ordinary thing.
   */
  | { ok: false; error: string };

export interface PuzzleEngine {
  readonly id: string;
  readonly version: string;
  /** The format this implements, as a `formatKey`. */
  readonly formatKey: string;
  /** A sentence a person reads on the surface. */
  readonly summary: string;

  /**
   * The checks this engine's validator actually runs.
   *
   * Declared rather than inferred from `validate`'s output, because a check
   * that returned nothing would be indistinguishable from one that passed.
   */
  readonly implementsChecks: readonly ValidationCheck[];

  /** Deterministic in (seed, params). The same three inputs give the same bytes. */
  generate(input: { seed: string; params: Record<string, unknown> }): GenerateResult;

  /**
   * Judge a payload this engine did not necessarily produce.
   *
   * Taking the payload rather than the instance is what makes this an
   * independent check rather than the generator marking its own homework: the
   * validator re-derives the solution from the puzzle and compares, so a
   * generator that recorded the wrong answer key is caught rather than
   * believed.
   */
  validate(input: {
    payload: PuzzlePayload;
    params: Record<string, unknown>;
    declaredDifficulty: string | null;
  }): ValidationCheckResult[];
}
