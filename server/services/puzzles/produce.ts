/**
 * Producing a batch: generate, check every one, and stop the master when the
 * output is systematically wrong.
 *
 * ---------------------------------------------------------------------------
 * The brief's rule, as the only code path that can make a puzzle
 * ---------------------------------------------------------------------------
 *
 * "If a systematic defect appears, block the batch and repair the generator or
 * source. Do not manually patch dozens of broken outputs and leave the source
 * defect alive." There is no way to write a `puzzle_instances` row except
 * through here, so there is nowhere for a hand-patched puzzle to come from —
 * the rule is structural rather than a convention somebody follows.
 *
 * ---------------------------------------------------------------------------
 * One failure is a systematic defect, and that is deliberate
 * ---------------------------------------------------------------------------
 *
 * A threshold of "more than 5% wrong" would be right for a process with
 * genuine variance. These generators are deterministic functions of a recorded
 * seed, and every check is a deterministic function of the bytes — so a single
 * invalid puzzle is not bad luck, it is a bug that will produce more. Blocking
 * on the first one is the strict reading and it is the correct one; a
 * tolerance here would let a generator ship 4% wrong answers indefinitely.
 *
 * An `UNSUPPORTED` check never blocks. That is a gap in *Brain's checking*
 * rather than a defect in the master's output, and blocking the master for it
 * would send somebody to repair a generator that may well be perfect. The
 * instance simply does not count as validated, which is what `readValidation`
 * already says.
 *
 * ---------------------------------------------------------------------------
 * A duplicate is an outcome, not an error
 * ---------------------------------------------------------------------------
 *
 * A master asked for more puzzles than its parameters can distinctly produce
 * starts re-finding ones it has already made. That is the duplicate rule
 * working, and the rate is reported because a master mostly returning
 * duplicates has run out of room — which is a real thing to know before
 * planning a book around it.
 */
import { recordEvent } from '../../repos/events.ts';
import {
  blockMaster,
  getFormat,
  getMaster,
  insertInstance,
  listInstancesForMaster,
} from '../../repos/puzzles.ts';
import { supportForGenerator } from './registry.ts';
import { hashOf, runChecks } from './validate.ts';
import type { PuzzleInstance } from '../../domain/types.ts';

/**
 * How many required-check failures make a master defective.
 *
 * One. See the header: these are deterministic functions, so a single wrong
 * puzzle is a bug rather than variance.
 */
export const SYSTEMATIC_DEFECT_THRESHOLD = 1;

/** How many puzzles one call may produce. A bound on work, not an allowance. */
export const MAX_BATCH = 200;

export interface ProducedBatch {
  masterId: string;
  /** Puzzles that did not already exist. */
  created: PuzzleInstance[];
  /** Seeds whose puzzle was one this master had already produced. */
  duplicates: number;
  /** Seeds the generator refused, with why. */
  refused: { seed: string; error: string }[];
  /** Required checks that failed, per instance. */
  failures: { instanceId: string; check: string; detail: string | null }[];
  /** Required checks nothing could establish. */
  unsupported: { instanceId: string; check: string }[];
  /** Set when this batch stopped the master. */
  blocked: { reason: string } | null;
}

export type ProduceOutcome =
  | { ok: true; value: ProducedBatch }
  | { ok: false; reason: string };

export async function produceBatch(input: {
  projectId: string;
  masterId: string;
  count: number;
}): Promise<ProduceOutcome> {
  const master = await getMaster(input.masterId);
  if (!master || master.projectId !== input.projectId) {
    return { ok: false, reason: 'No master with that id.' };
  }
  if (master.retiredAt) {
    return {
      ok: false,
      reason: `${master.name} was retired: ${master.retiredReason ?? 'no reason recorded'}.`,
    };
  }
  if (master.blockedAt) {
    return {
      ok: false,
      reason:
        `${master.name} is blocked and produces nothing until the generator is repaired: ` +
        `${master.blockedReason ?? 'no reason recorded'}. Patching the output it already made ` +
        'is not the remedy — fix the generator, bump its version, and unblock it.',
    };
  }

  const format = await getFormat(master.formatId);
  if (!format || format.projectId !== input.projectId) {
    return { ok: false, reason: 'The format this master belongs to is gone.' };
  }
  if (format.retiredAt) {
    return {
      ok: false,
      reason: `${format.name} was retired: ${format.retiredReason ?? 'no reason recorded'}.`,
    };
  }

  /*
   * The support is looked up by the master's *generator key* rather than by
   * the format's slug. The key is what was recorded when the master was
   * declared, so a master keeps producing the thing it was declared to
   * produce even if somebody later renames the format.
   */
  const support = supportForGenerator(master.generatorKey);
  if (!support) {
    return {
      ok: false,
      reason:
        `No generator named ${master.generatorKey} exists in this repository, so nothing can ` +
        'be produced from this master. That is a statement about this Brain rather than about ' +
        'the format.',
    };
  }

  const count = Math.max(1, Math.min(MAX_BATCH, Math.trunc(input.count)));
  const existing = await listInstancesForMaster(master.id);

  const batch: ProducedBatch = {
    masterId: master.id,
    created: [],
    duplicates: 0,
    refused: [],
    failures: [],
    unsupported: [],
    blocked: null,
  };

  for (let index = 0; index < count; index += 1) {
    /*
     * The seed is composed from facts Brain holds rather than supplied.
     *
     * It carries the master and the generator version, so re-running after a
     * generator is repaired produces a genuinely different series rather than
     * re-finding every puzzle the broken version made — and the offset by what
     * already exists means a second call continues the series instead of
     * colliding with the first one from its first seed.
     */
    const seed = `${master.id}:${support.generatorVersion}:${existing.length + index}`;

    const generated = support.generate({ spec: master.spec, seed });
    if (!generated.ok) {
      batch.refused.push({ seed, error: generated.error });
      continue;
    }

    const payload = generated.value.payload;
    const solution = payload['solution'] ?? payload['key'] ?? payload['placements'] ?? null;

    const { instance, created } = await insertInstance({
      projectId: input.projectId,
      masterId: master.id,
      formatId: master.formatId,
      generatorKey: support.generatorKey,
      generatorVersion: support.generatorVersion,
      seed,
      payload,
      contentHash: hashOf(payload),
      solutionHash: hashOf(solution),
      canonicalHash: generated.value.canonical,
      measuredDifficulty: generated.value.difficulty?.value ?? null,
      difficultyBasis: generated.value.difficulty?.basis ?? null,
    });

    if (!created) {
      batch.duplicates += 1;
      continue;
    }
    batch.created.push(instance);

    /*
     * Checked immediately, and every one of them. The brief's "100% of output
     * is validated" is this loop having no branch that skips it.
     */
    const records = await runChecks({ projectId: input.projectId, instance, support });
    for (const record of records) {
      if (record.verdict === 'FAIL') {
        batch.failures.push({
          instanceId: instance.id,
          check: record.checkKey,
          detail: record.detail,
        });
      } else if (record.verdict === 'UNSUPPORTED') {
        batch.unsupported.push({ instanceId: instance.id, check: record.checkKey });
      }
    }
  }

  if (batch.failures.length >= SYSTEMATIC_DEFECT_THRESHOLD) {
    const checks = [...new Set(batch.failures.map((one) => one.check))];
    const firstDetail = batch.failures[0]?.detail ?? 'no detail recorded';
    const reason =
      `${batch.failures.length} of ${batch.created.length} puzzle(s) produced by ` +
      `${support.generatorKey} ${support.generatorVersion} failed ${checks.join(', ')}. ` +
      `The first said: ${firstDetail} These are deterministic functions of a recorded seed, so ` +
      'one wrong puzzle is a defect in the generator rather than bad luck. Repair the ' +
      'generator, bump its version, and unblock this master; every puzzle it already produced ' +
      'keeps its row and its verdicts.';
    const blocked = await blockMaster({ id: master.id, projectId: input.projectId, reason });
    batch.blocked = { reason: blocked?.blockedReason ?? reason };

    await recordEvent({
      projectId: input.projectId,
      entityType: 'puzzle_master',
      entityId: master.id,
      eventType: 'PUZZLE_MASTER_BLOCKED',
      payload: {
        generatorKey: support.generatorKey,
        generatorVersion: support.generatorVersion,
        produced: batch.created.length,
        failed: batch.failures.length,
        checks,
        reason: batch.blocked.reason,
      },
    });
  }

  await recordEvent({
    projectId: input.projectId,
    entityType: 'puzzle_master',
    entityId: master.id,
    eventType: 'PUZZLE_BATCH_PRODUCED',
    payload: {
      asked: count,
      created: batch.created.length,
      duplicates: batch.duplicates,
      refused: batch.refused.length,
      failedChecks: batch.failures.length,
      /*
       * Carried on the event rather than summarised away. A batch that
       * produced a hundred puzzles nothing could fully check is a very
       * different fact from one that produced a hundred validated ones, and a
       * count of "created" alone reads identically for both.
       */
      unsupportedChecks: batch.unsupported.length,
      blocked: batch.blocked !== null,
    },
  });

  return { ok: true, value: batch };
}
