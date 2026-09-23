/**
 * Making puzzles, and the three things that must be true of every one.
 *
 * ---------------------------------------------------------------------------
 * Validated, deduplicated, and rights-clear — or not recorded as usable
 * ---------------------------------------------------------------------------
 *
 * One hundred per cent of output is validated, which the operator's brief asks
 * for in those words, and the way it is guaranteed is that there is no path
 * from a generator to a stored row that does not go through a validator:
 * `recordPuzzleInstance` refuses a `PENDING` state by its type, so an instance
 * exists only if something checked it.
 *
 * Duplicate detection is the second, and it is what stops a catalog of a
 * thousand puzzles being two hundred puzzles five times over. It compares the
 * validator's canonical hash — which for sudoku means a relabelling and a
 * rotation are the same puzzle — against everything this project already
 * holds and against the batch in flight.
 *
 * Rights are the third and they are checked before a single puzzle is made
 * rather than after: a master whose corpus reads `UNKNOWN` generates nothing,
 * so there is never a pile of technically-fine output somebody is tempted to
 * ship because it already exists.
 *
 * ---------------------------------------------------------------------------
 * A systematic defect blocks the batch, and the generator is what gets fixed
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit and it is worth stating why it matters here: a
 * generator whose output is failing is failing for a reason, and the cheap
 * response — throw the bad ones away and keep drawing seeds — produces a book
 * whose puzzles are the ones that happened to pass, from a generator nobody
 * fixed. So a batch whose failure rate crosses `DEFECT_CEILING` stops, reports
 * every failing check, and creates nothing further.
 *
 * There is deliberately **no route to edit an instance**. A repair is a new
 * generator version and a new master, because the seed is the puzzle: an
 * instance patched by hand would be a row whose stored hash describes
 * something the specification no longer renders, which is the one thing that
 * would make "the specification is the storage" a lie.
 */
import { createHash } from 'node:crypto';
import {
  canonicalCounts,
  getPuzzleMaster,
  listPuzzleInstances,
  recordPuzzleInstance,
} from '../../repos/puzzle.ts';
import { corpus, mayCompileCommercially } from '../../domain/puzzleCorpora.ts';
import { formatFor, type PuzzleArtifact, type PuzzleSpec } from './formats/index.ts';
import type { PuzzleInstance, PuzzleMaster } from '../../domain/types.ts';

/**
 * How much of a batch may fail before the batch is a defect rather than a run
 * of bad luck.
 *
 * A third, which is deliberately generous. Word search placement genuinely
 * fails sometimes — a long word and a small grid — and refusing at the first
 * failure would stop a working generator. A third failing is not luck.
 */
export const DEFECT_CEILING = 0.34;

/** How many puzzles one pass of the tick may make. Bounded, never a quota. */
export const MAX_INSTANCES_PER_PASS = 25;

export interface GeneratedPuzzle {
  instance: PuzzleInstance;
  artifact: PuzzleArtifact;
}

export interface BatchReport {
  masterId: string;
  made: PuzzleInstance[];
  /** Refused by the validator, with every check that failed. Kept, never hidden. */
  invalid: { seed: string; failed: { name: string; detail: string }[] }[];
  /** Refused as the same puzzle as one already held, by canonical form. */
  duplicates: { seed: string; canonicalHash: string }[];
  /** Why the batch stopped early, where it did. */
  blocked: string | null;
}

/**
 * The specification for one puzzle.
 *
 * The seed is derived from the master and an index rather than drawn at
 * random, so the hundredth puzzle of a master is the same puzzle on every
 * machine and after every restart. That is what makes a content hash a
 * description of something anybody can reproduce, rather than of something
 * that happened once.
 */
export function specFor(master: PuzzleMaster, index: number): PuzzleSpec {
  return {
    formatKey: master.formatKey,
    corpusId: master.corpusId,
    seed: seedFor(master, index),
    /*
     * The index travels beside the seed, and it is not decoration.
     *
     * A format whose content space is an enumerable list — a cryptogram is one
     * passage under a cipher — can walk that list rather than sampling it, and
     * the difference is the tail of the coupon-collector problem. Sampling
     * sixteen passages at random needs about fifty draws to see all sixteen,
     * so a system one short of its catalog is asked for one more every pass,
     * refuses three duplicates, and reports that it made nothing: bounded,
     * deterministic and entirely wasted work, which is the loop §27 records as
     * worse than a stop. With the index, the first sixteen attempts produce
     * the sixteen passages exactly once and the system reaches its ceiling and
     * is left alone.
     *
     * A grid format ignores it, because there is nothing to enumerate.
     */
    parameters: { ...master.parameters, difficulty: master.difficulty, index },
  };
}

export function seedFor(master: PuzzleMaster, index: number): string {
  return createHash('sha256')
    .update(`${master.id}:${master.generatorVersion}:${index}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Why this master cannot produce anything, or null.
 *
 * Read before any work is done, because each of these is a fact about rows and
 * constants rather than about a puzzle — and finding out after generating
 * fifty of them that the corpus may not be sold from would mean fifty rows
 * somebody has to decide what to do with.
 */
export function refusalFor(master: PuzzleMaster): string | null {
  const format = formatFor(master.formatKey);
  if (!format) {
    return (
      `Nothing in this repository generates or checks "${master.formatKey}". The format is on ` +
      'the map because research or a person named it; building it is a code change somebody ' +
      'reviews.'
    );
  }
  if (!format.render) {
    return (
      `${format.title} is authored rather than generated: its fill and its clues are editorial ` +
      'work with no correctness criterion, so there is no generator here rather than a bad ' +
      'one. Brain can check one somebody else wrote.'
    );
  }
  const source = corpus(master.corpusId);
  if (!source) {
    return `No corpus named ${master.corpusId} is shipped with this repository.`;
  }
  if (!mayCompileCommercially(source.rights)) {
    return (
      `The corpus ${source.id} reads ${source.rights}, so nothing may be compiled from it for ` +
      `sale. ${source.rightsBasis}`
    );
  }
  return null;
}

/**
 * Make, check and record up to `count` puzzles for one master.
 *
 * Every puzzle is rendered, validated and then recorded, in that order, in one
 * step per instance — so there is no window in which an unchecked instance
 * exists for another reader to make a decision about.
 */
export async function generateBatch(input: {
  projectId: string;
  masterId: string;
  count: number;
}): Promise<BatchReport> {
  const out: BatchReport = {
    masterId: input.masterId,
    made: [],
    invalid: [],
    duplicates: [],
    blocked: null,
  };

  const master = await getPuzzleMaster(input.masterId);
  if (!master || master.projectId !== input.projectId) {
    out.blocked = 'No such master in this project.';
    return out;
  }
  const refusal = refusalFor(master);
  if (refusal) {
    out.blocked = refusal;
    return out;
  }
  const format = formatFor(master.formatKey);
  if (!format?.render) {
    out.blocked = 'The format lost its generator between two reads, which should be impossible.';
    return out;
  }

  const seen = await canonicalCounts(input.projectId);
  const existing = await listPuzzleInstances({
    projectId: input.projectId,
    masterId: master.id,
  });
  /*
   * Start after everything this master has already produced, including the
   * instances it refused. An index that reused a seed a previous pass rejected
   * would render the identical failing puzzle every pass, for ever — a loop
   * that looks like progress, which §27 records as worse than a stop.
   */
  let index = existing.length;
  const want = Math.max(0, Math.min(input.count, MAX_INSTANCES_PER_PASS));
  let attempts = 0;
  const ceiling = want * 3;

  while (out.made.length < want && attempts < ceiling) {
    attempts += 1;
    const spec = specFor(master, index);
    index += 1;

    let artifact: PuzzleArtifact;
    try {
      artifact = format.render(spec);
    } catch (error) {
      /*
       * A generator that threw is a defect in the generator or in the
       * master's parameters, not a puzzle that came out badly. It stops the
       * batch immediately rather than being counted as one failure among
       * many, because every subsequent attempt would throw the same way.
       */
      out.blocked =
        `The generator refused this master outright: ${
          error instanceof Error ? error.message : String(error)
        }`;
      return out;
    }

    const verdict = format.validate(artifact);
    if (verdict.state === 'INVALID') {
      out.invalid.push({
        seed: spec.seed,
        failed: verdict.checks
          .filter((one) => !one.ok)
          .map((one) => ({ name: one.name, detail: one.detail })),
      });
      /*
       * A systematic defect, caught while there is still something to fix.
       * The check needs a few attempts behind it before it means anything,
       * which is what the second clause is for.
       */
      if (attempts >= 4 && out.invalid.length / attempts > DEFECT_CEILING) {
        out.blocked =
          `${out.invalid.length} of ${attempts} attempts failed validation, which is a defect ` +
          'in the generator or in this master rather than a run of bad luck. The batch stopped ' +
          'rather than drawing seeds until enough happened to pass: what is wrong is upstream ' +
          'of the puzzles, and the failing checks are recorded beside each refused seed.';
        return out;
      }
      continue;
    }

    if ((seen.get(verdict.canonicalHash) ?? 0) > 0) {
      out.duplicates.push({ seed: spec.seed, canonicalHash: verdict.canonicalHash });
      continue;
    }

    const { instance, created } = await recordPuzzleInstance({
      projectId: input.projectId,
      masterId: master.id,
      seed: spec.seed,
      contentHash: contentHashOf(artifact),
      canonicalHash: verdict.canonicalHash,
      validationState: 'VALID',
      measuredDifficulty: verdict.measuredDifficulty,
      checks: verdict.checks,
    });
    seen.set(verdict.canonicalHash, (seen.get(verdict.canonicalHash) ?? 0) + 1);
    if (created) out.made.push(instance);
  }

  if (out.made.length < want && out.blocked === null) {
    out.blocked =
      `Made ${out.made.length} of ${want} before running out of attempts. ${out.duplicates.length} ` +
      `were puzzles this project already holds and ${out.invalid.length} did not pass. That is ` +
      'a master whose parameter space is smaller than the batch asked for rather than a fault.';
  }
  return out;
}

/**
 * Re-render a stored instance.
 *
 * The whole of "the specification is the storage" is this function existing:
 * the grid, the solution and the answer key are produced together from the
 * master and the seed, every time they are wanted, so there is no copy of any
 * of them for a later change to make disagree with the other two.
 *
 * It re-checks the content hash, because a re-render that does not match what
 * was recorded means the generator has changed underneath a stored row — which
 * is exactly what `generator_version` exists to prevent and exactly what
 * somebody needs to be told if it happens anyway.
 */
export async function renderInstance(
  instance: PuzzleInstance,
): Promise<{ artifact: PuzzleArtifact; reproduced: boolean } | { error: string }> {
  const master = await getPuzzleMaster(instance.masterId);
  if (!master) return { error: 'The master this puzzle was made from is gone.' };
  const format = formatFor(master.formatKey);
  if (!format?.render) {
    return { error: `Nothing in this repository renders ${master.formatKey}.` };
  }
  try {
    const artifact = format.render({
      formatKey: master.formatKey,
      corpusId: master.corpusId,
      seed: instance.seed,
      parameters: { ...master.parameters, difficulty: master.difficulty },
    });
    return { artifact, reproduced: contentHashOf(artifact) === instance.contentHash };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function contentHashOf(artifact: PuzzleArtifact): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        artifact.formatKey,
        artifact.instructions,
        artifact.grid,
        artifact.prompts,
        artifact.solution,
        artifact.answerKey,
      ]),
    )
    .digest('hex');
}
