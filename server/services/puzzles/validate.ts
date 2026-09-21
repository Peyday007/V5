/**
 * Running the checks, and reading back what they said.
 *
 * ---------------------------------------------------------------------------
 * A check nobody implemented is recorded, never assumed
 * ---------------------------------------------------------------------------
 *
 * `runChecks` compares the checks a validator actually answered against the
 * checks its format *declares* are required, and writes `UNSUPPORTED` for
 * every one missing. That comparison is the whole safety property: without it,
 * a validator that quietly stopped answering a check would make every puzzle
 * look more validated than before, and nothing would say so.
 *
 * `readValidation` then refuses to let an `UNSUPPORTED` stand in for a pass.
 * §9 settled this for documents — a `BLOCKED` extraction is something the
 * auditor does **not** have, and every code path must say so rather than
 * treating an empty result as an empty document — and the stake here is
 * higher in one direction: the favourable reading is *ship it*.
 */
import { createHash } from 'node:crypto';
import { recordValidation } from '../../repos/puzzles.ts';
import { supportFor } from './registry.ts';
import type { FormatSupport } from './registry.ts';
import type { PuzzleInstance, PuzzleValidation, PuzzleVerdict } from '../../domain/types.ts';

/** A stable hash of a payload. Content addressing, never a credential. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/**
 * JSON with its keys in a fixed order, so the same content hashes the same.
 *
 * `JSON.stringify` preserves insertion order, and two objects built by
 * different code paths can hold the same fields in different orders — which
 * would give one puzzle two content hashes and make a verdict's record of what
 * it ran against useless.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, one]) => one !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, one]) => `${JSON.stringify(key)}:${stableJson(one)}`).join(',')}}`;
}

export interface CheckRecord {
  checkKey: string;
  verdict: PuzzleVerdict;
  detail: string | null;
}

/**
 * Run every check this format declares, and record all of them.
 *
 * Returns what was written rather than a summary, because the caller has to
 * count failures to decide whether the *master* is defective and a summary
 * would have thrown away which checks failed.
 */
export async function runChecks(input: {
  projectId: string;
  instance: PuzzleInstance;
  support: FormatSupport;
}): Promise<CheckRecord[]> {
  const { support } = input;

  /*
   * A validator that throws is a defect in the validator, and it must not take
   * the batch down. It is recorded as a failure of every required check with
   * the reason, which is the honest reading: nothing was established, and
   * something is wrong.
   */
  let answered: { check: string; verdict: PuzzleVerdict; detail?: string }[];
  try {
    answered = support.validate(input.instance.payload);
  } catch (error) {
    const detail = `the validator threw: ${error instanceof Error ? error.message : 'unknown'}`;
    answered = support.requiredChecks.map((check) => ({ check, verdict: 'FAIL' as const, detail }));
  }

  const byCheck = new Map(answered.map((one) => [one.check, one]));
  const records: CheckRecord[] = [];

  for (const checkKey of support.requiredChecks) {
    const result = byCheck.get(checkKey);
    const record: CheckRecord = result
      ? { checkKey, verdict: result.verdict, detail: result.detail ?? null }
      : {
          checkKey,
          verdict: 'UNSUPPORTED',
          detail:
            `${support.validatorKey} ${support.validatorVersion} answered nothing for this ` +
            'check, so nothing was established about it. That is not the same as passing.',
        };
    records.push(record);

    await recordValidation({
      projectId: input.projectId,
      instanceId: input.instance.id,
      checkKey: record.checkKey,
      verdict: record.verdict,
      detail: record.detail,
      validatorKey: support.validatorKey,
      validatorVersion: support.validatorVersion,
      contentHash: input.instance.contentHash,
    });
  }

  /*
   * A check the validator answered that its format does not require is still
   * recorded. It establishes something real, and dropping it would make the
   * row silently narrower than the run — §27's truncation rule at a verdict.
   */
  for (const extra of answered) {
    if (support.requiredChecks.includes(extra.check)) continue;
    await recordValidation({
      projectId: input.projectId,
      instanceId: input.instance.id,
      checkKey: extra.check,
      verdict: extra.verdict,
      detail: extra.detail ?? null,
      validatorKey: support.validatorKey,
      validatorVersion: support.validatorVersion,
      contentHash: input.instance.contentHash,
    });
  }

  return records;
}

/**
 * How far a puzzle got, from its recorded verdicts.
 *
 *   UNCHECKABLE  no validator exists for this format at all.
 *   UNCHECKED    a validator exists and has not been run against these bytes.
 *   INCOMPLETE   something required was UNSUPPORTED, so nothing established it.
 *   FAILED       something required failed.
 *   VALIDATED    every required check passed, at the current validator version.
 *
 * Five states rather than a boolean, because the four that are not
 * `VALIDATED` have four different remedies: write a validator, run it, write
 * the missing check, and repair the generator. A boolean would send everybody
 * to the same place.
 */
export type ValidationState = 'UNCHECKABLE' | 'UNCHECKED' | 'INCOMPLETE' | 'FAILED' | 'VALIDATED';

export interface ValidationReading {
  state: ValidationState;
  /** Required checks that failed at the current validator version. */
  failed: string[];
  /** Required checks nothing could establish. */
  unsupported: string[];
  why: string;
}

export function readValidation(input: {
  formatSlug: string;
  instance: PuzzleInstance;
  validations: readonly PuzzleValidation[];
}): ValidationReading {
  const support = supportFor(input.formatSlug);
  if (!support) {
    return {
      state: 'UNCHECKABLE',
      failed: [],
      unsupported: [],
      why:
        'No validator in this repository checks this format, so nothing about this puzzle has ' +
        'been established. It is not a defective puzzle; it is an unchecked one.',
    };
  }

  /*
   * Only verdicts from the current validator version count.
   *
   * An older version's pass is kept — that is why the unique index is over the
   * version — and it is history rather than evidence: a check that was fixed
   * precisely because it used to pass something it should not have would
   * otherwise keep vouching for the puzzle it got wrong.
   *
   * The content hash is compared too, although an instance is immutable, so
   * that a verdict can never be about different bytes than the row it hangs
   * off. A cheap assertion of a property the schema already intends.
   */
  const current = input.validations.filter(
    (one) =>
      one.validatorKey === support.validatorKey &&
      one.validatorVersion === support.validatorVersion &&
      one.contentHash === input.instance.contentHash,
  );

  const byCheck = new Map(current.map((one) => [one.checkKey, one]));
  const failed: string[] = [];
  const unsupported: string[] = [];
  const absent: string[] = [];

  for (const checkKey of support.requiredChecks) {
    const verdict = byCheck.get(checkKey);
    if (!verdict) absent.push(checkKey);
    else if (verdict.verdict === 'FAIL') failed.push(checkKey);
    else if (verdict.verdict === 'UNSUPPORTED') unsupported.push(checkKey);
  }

  if (failed.length > 0) {
    return {
      state: 'FAILED',
      failed,
      unsupported,
      why: `${failed.join(', ')} failed, so this puzzle is wrong rather than unproven.`,
    };
  }
  if (absent.length > 0) {
    return {
      state: 'UNCHECKED',
      failed: [],
      unsupported,
      why:
        `${support.validatorKey} ${support.validatorVersion} has not been run against these ` +
        `bytes for ${absent.join(', ')}. Re-running it is the remedy.`,
    };
  }
  if (unsupported.length > 0) {
    return {
      state: 'INCOMPLETE',
      failed: [],
      unsupported,
      why:
        `Nothing established ${unsupported.join(', ')}. An unsupported check is not a passing ` +
        'one, so this puzzle is not validated — the remedy is to implement the check.',
    };
  }
  return {
    state: 'VALIDATED',
    failed: [],
    unsupported: [],
    why: `Every check ${support.validatorKey} ${support.validatorVersion} requires passed.`,
  };
}
