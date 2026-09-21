/**
 * Producing puzzles from a master, and validating every one of them.
 *
 * ---------------------------------------------------------------------------
 * A hundred per cent, and the reason it is not a tunable
 * ---------------------------------------------------------------------------
 *
 * The directive says *validate 100% of output*, and here that is structural
 * rather than a setting: generation and validation happen in one pass, an
 * instance is recorded and a validation run is recorded for it before the loop
 * moves on, and there is no code path that writes an instance without one. A
 * sampling rate would be a number somebody could lower, and the first thing
 * anybody lowers it for is a batch that is running late.
 *
 * ---------------------------------------------------------------------------
 * A systematic defect blocks the batch; it does not get patched out
 * ---------------------------------------------------------------------------
 *
 * *If a systematic defect appears, block the batch and repair the generator or
 * source. Do not manually patch dozens of broken outputs and leave the source
 * defect alive.* So this stops generating the moment enough instances fail the
 * same check, records a `GENERATOR_DEFECT` observation naming that check, and
 * returns. Nothing here repairs a puzzle, drops a failure, or retries a seed
 * hoping for a better one.
 *
 * The failures it already produced **keep their rows and their validation
 * runs**. They are the evidence that the defect existed and the record a
 * repair is judged against — §5, at an artifact rather than at a research
 * attempt.
 *
 * ---------------------------------------------------------------------------
 * Determinism, and what the content hash is over
 * ---------------------------------------------------------------------------
 *
 * The hash is over a canonical serialization of the payload — keys sorted at
 * every level — so two objects that differ only in the order their fields were
 * built are one puzzle. Without that, a refactor of an engine that reordered
 * two assignments would silently double the catalog.
 */
import { createHash } from 'node:crypto';
import {
  currentValidation,
  getMaster,
  recordInstance,
  recordObservation,
  recordValidation,
} from '../../repos/puzzle.ts';
import { engineById, KERNEL_CHECKS } from './engines/index.ts';
import type {
  PuzzleInstance,
  PuzzlePayload,
  PuzzleValidation,
  ValidationCheck,
  ValidationCheckResult,
  ValidationVerdict,
} from '../../domain/types.ts';

/**
 * How many instances must fail the same check before the batch is blocked.
 *
 * Three, and a majority of what has been produced. One failure is a puzzle; a
 * run of them on one check is the generator. Both conditions are required
 * because either alone is wrong in a way that matters: a count alone blocks a
 * large healthy batch that had three unlucky seeds, and a rate alone blocks a
 * batch of two where one failed.
 */
export const SYSTEMATIC_DEFECT_COUNT = 3;
export const SYSTEMATIC_DEFECT_RATE = 0.5;

/** A bound on one call, so a runaway parameter cannot occupy the tick. */
export const MAX_BATCH = 500;

/** Canonical JSON: keys sorted at every level, so field order cannot fork a catalog. */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) out[key] = walk(source[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export function contentHashOf(payload: PuzzlePayload): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * The verdict a set of check results adds up to.
 *
 * `UNCHECKED` is not a fallback for "no results" alone: it is what a run
 * reports when the validator could not answer, which includes returning
 * nothing at all. Folding that into FAILED would send somebody to repair a
 * puzzle when the remedy is to implement a check, and folding it into PASSED
 * would be the lie this whole kernel exists to prevent.
 */
export function verdictFrom(results: readonly ValidationCheckResult[]): {
  verdict: ValidationVerdict;
  failedCheck: ValidationCheck | null;
} {
  if (results.length === 0) return { verdict: 'UNCHECKED', failedCheck: null };
  const failed = results.find((one) => !one.ok);
  if (failed) return { verdict: 'FAILED', failedCheck: failed.check };
  return { verdict: 'PASSED', failedCheck: null };
}

export interface ProducedOne {
  instance: PuzzleInstance;
  validation: PuzzleValidation;
  /** False when this payload was already in the catalog. An ordinary outcome. */
  fresh: boolean;
}

export interface ProduceReport {
  masterId: string;
  engineId: string;
  requested: number;
  /** Instances whose current validation is PASSED. The only ones that are evidence. */
  passed: ProducedOne[];
  failed: ProducedOne[];
  unchecked: ProducedOne[];
  /** Seeds whose payload was already in the catalog. Counted, never an error. */
  duplicates: number;
  /** Seeds the generator itself refused, with its reason. */
  refused: { seed: string; error: string }[];
  /** Set when a run of failures on one check stopped the batch. */
  blocked: { check: ValidationCheck; failures: number; produced: number; why: string } | null;
  /** A sentence naming why the batch is not what was asked for, or null. */
  note: string | null;
}

/**
 * Validate one instance against its master's engine, and record the run.
 *
 * Exported because re-validating is a real operation: an engine gains a check,
 * and every instance it already produced should be judged by the new
 * validator. Recording supersedes rather than edits, so the old verdict keeps
 * its row and an output filed months ago still resolves to the checks that
 * actually ran when it was filed.
 */
export async function validateInstance(instance: PuzzleInstance): Promise<PuzzleValidation> {
  const master = await getMaster(instance.masterId);
  const engine = engineById(instance.engineId);
  if (!engine) {
    /*
     * An instance whose engine is no longer registered is not a failure: it is
     * one nothing can currently judge, which is exactly what UNCHECKED means.
     * Recording it as FAILED would send somebody to look at a puzzle that may
     * be perfectly good.
     */
    return recordValidation({
      projectId: instance.projectId,
      instanceId: instance.id,
      validatorId: instance.engineId,
      validatorVersion: instance.engineVersion,
      verdict: 'UNCHECKED',
      checks: [],
    });
  }
  const results = engine.validate({
    payload: instance.payload,
    params: master?.params ?? {},
    declaredDifficulty: instance.difficulty,
  });
  const { verdict, failedCheck } = verdictFrom(results);
  return recordValidation({
    projectId: instance.projectId,
    instanceId: instance.id,
    validatorId: engine.id,
    validatorVersion: engine.version,
    verdict,
    checks: results,
    failedCheck,
  });
}

/**
 * Generate and validate a batch from one master.
 *
 * Seeds are derived from the master id and the index, so the same request
 * produces the same puzzles: re-running a batch after a generator repair gives
 * a reader the old artifact and the new one to compare, which is what makes a
 * repair checkable rather than merely claimed.
 */
export async function produceBatch(input: {
  projectId: string;
  masterId: string;
  count: number;
  /** Distinguishes two batches from one master. Part of every seed. */
  run?: string;
}): Promise<ProduceReport> {
  const master = await getMaster(input.masterId);
  if (!master) throw new Error('No such master.');
  if (master.retiredAt) {
    throw new Error('That master is retired, so nothing may be produced from it.');
  }
  const engine = engineById(master.engineId);
  if (!engine) {
    throw new Error(
      `No engine with id "${master.engineId}" is registered, so this master cannot produce. ` +
        'A format with no engine is RESEARCHED rather than GENERATABLE, and saying otherwise ' +
        'is the one claim this kernel may never make.',
    );
  }
  /*
   * The engine a master names and the engine's own version must agree with
   * what the master recorded, or the instances would carry a provenance that
   * does not reproduce. A mismatch is reported rather than silently accepted:
   * the remedy is a new master, because a master is the thing whose version is
   * part of a puzzle's identity.
   */
  const versionMismatch = master.engineVersion !== engine.version;

  const count = Math.max(0, Math.min(Math.trunc(input.count), MAX_BATCH));
  const report: ProduceReport = {
    masterId: master.id,
    engineId: engine.id,
    requested: count,
    passed: [],
    failed: [],
    unchecked: [],
    duplicates: 0,
    refused: [],
    blocked: null,
    note: versionMismatch
      ? `This master records ${master.engineId}@${master.engineVersion} and the registered ` +
        `engine is at ${engine.version}. The instances below carry the registered version, so ` +
        'they do not reproduce from the master as recorded.'
      : null,
  };

  const failuresByCheck = new Map<ValidationCheck, number>();

  for (let index = 0; index < count; index += 1) {
    const seed = `${master.id}:${input.run ?? 'r1'}:${index}`;
    const generated = engine.generate({ seed, params: master.params });
    if (!generated.ok) {
      report.refused.push({ seed, error: generated.error });
      continue;
    }

    const hash = contentHashOf(generated.value.payload);
    const { instance, created } = await recordInstance({
      projectId: input.projectId,
      masterId: master.id,
      formatKey: master.formatKey,
      seed,
      engineId: engine.id,
      engineVersion: engine.version,
      payload: generated.value.payload,
      contentHash: hash,
      difficulty: generated.value.difficulty,
      expectedSolveSeconds: generated.value.expectedSolveSeconds,
      locale: generated.value.locale,
    });

    if (!created) {
      /*
       * The duplicate gate, and an ordinary outcome. Two seeds that produced
       * the same puzzle are one puzzle. It is counted rather than hidden,
       * because a duplicate rate is one of the readings that says whether a
       * master's parameters are too tight to fill a book.
       */
      report.duplicates += 1;
      const existing = await currentValidation(instance.id);
      if (existing) {
        const already: ProducedOne = { instance, validation: existing, fresh: false };
        if (existing.verdict === 'PASSED') report.passed.push(already);
        else if (existing.verdict === 'FAILED') report.failed.push(already);
        else report.unchecked.push(already);
        continue;
      }
    }

    const validation = await validateInstance(instance);
    const one: ProducedOne = { instance, validation, fresh: created };
    if (validation.verdict === 'PASSED') report.passed.push(one);
    else if (validation.verdict === 'UNCHECKED') report.unchecked.push(one);
    else {
      report.failed.push(one);
      if (validation.failedCheck) {
        const seen = (failuresByCheck.get(validation.failedCheck) ?? 0) + 1;
        failuresByCheck.set(validation.failedCheck, seen);
        const produced = index + 1;
        if (seen >= SYSTEMATIC_DEFECT_COUNT && seen / produced >= SYSTEMATIC_DEFECT_RATE) {
          const why =
            `${seen} of the first ${produced} instances failed ${validation.failedCheck}. That ` +
            'is the generator rather than the puzzles, so the batch is blocked and the repair ' +
            'belongs in the engine or the master’s parameters.';
          report.blocked = {
            check: validation.failedCheck,
            failures: seen,
            produced,
            why,
          };
          await recordObservation({
            projectId: input.projectId,
            kind: 'GENERATOR_DEFECT',
            subjectKey: master.formatKey,
            statement: why,
            observer: 'BRAIN',
            masterId: master.id,
          });
          return report;
        }
      }
    }
  }

  return report;
}

/** The checks anything can run for this instance's format, for a reader. */
export function checksRunFor(instance: PuzzleInstance): readonly ValidationCheck[] {
  const engine = engineById(instance.engineId);
  if (!engine) return KERNEL_CHECKS;
  return [...new Set([...engine.implementsChecks, ...KERNEL_CHECKS])];
}
