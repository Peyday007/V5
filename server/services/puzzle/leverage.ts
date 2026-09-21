/**
 * The three multipliers, kept apart, and every figure either counted or
 * reported as unmeasured with what would measure it.
 *
 * ---------------------------------------------------------------------------
 * Three, because they are three different questions
 * ---------------------------------------------------------------------------
 *
 * The directive is explicit: *track three different forms of leverage
 * separately.* Master-to-SKU is about editorial reuse, setup-to-unit is about
 * a machine, and contribution per setup is about money. A single "leverage"
 * number would be an average over three unrelated denominators, and it would
 * read like a measurement.
 *
 * ---------------------------------------------------------------------------
 * Ten producing fifty is a search target, and this reports it as one
 * ---------------------------------------------------------------------------
 *
 * *A setup of ten producing fifty is a search target, not a quota.* So the
 * multiplier here is a **reading of what exists** with its own denominator
 * named, beside the target as a target. Nothing in this kernel creates an
 * output to move it, and nothing anywhere treats fifty as an obligation —
 * *release only what passes demand, quality, rights, and contribution gates*.
 *
 * ---------------------------------------------------------------------------
 * A reprint is counted, and counted separately
 * ---------------------------------------------------------------------------
 *
 * *Track compilations, reprints, alternate formats, private-label editions,
 * and new playable content honestly and separately.* A reprint is real work
 * and real revenue and it is not a new qualified output, so it appears in its
 * own figure rather than being dropped — dropping it would understate the
 * catalog, and counting it in the multiplier would overstate the leverage.
 */
import { isEvidence, type PuzzleSnapshot } from './graph.ts';
import type { OutputReading } from './maturity.ts';

/**
 * A figure that was measured, or an honest statement that it was not.
 *
 * `null` with a reason, rather than zero. §29 and §39 both record the cost of
 * the alternative: a zero is a figure and reads as a measurement, and an
 * understatement reads as modesty rather than as a mistake.
 */
export interface Measured {
  value: number | null;
  /** What it counts, so a number is never a quantity of nothing in particular. */
  denominator: string;
  /** Present when `value` is null: what would produce it. */
  wouldMeasure: string | null;
}

const measured = (value: number, denominator: string): Measured => ({
  value,
  denominator,
  wouldMeasure: null,
});

const unmeasured = (denominator: string, wouldMeasure: string): Measured => ({
  value: null,
  denominator,
  wouldMeasure,
});

export interface LeverageReading {
  /** Masters that have produced at least one instance that passes. */
  validatedMasters: number;
  /** Instances whose current validation is PASSED. The catalog's real size. */
  validatedInstances: number;
  /** Outputs at QUALIFIED or above. What the multiplier's numerator counts. */
  qualifiedOutputs: number;
  /** Assembled outputs that are the same product again. Counted, never hidden. */
  reprints: number;
  /** Outputs that exist but have not been assembled from passing puzzles. */
  drafts: number;

  /** Qualified outputs per validated master system. */
  masterToSku: Measured;
  /** Physical units produced per print, tooling or machine setup. */
  setupToUnitYield: Measured;
  /** Gross contribution produced by each editorial, software, tooling or machine setup. */
  contributionPerSetup: Measured;
  /** Valid puzzles per editorial hour, which the directive also asks for. */
  puzzlesPerEditorialHour: Measured;

  /** The directive's own search target, reported as a target rather than a quota. */
  target: { masters: number; outputs: number; note: string };

  quality: {
    /** Instances with a current PASSED run, over instances with any current run. */
    validationPassRate: Measured;
    /** Instances with no current validation at all. Never counted as passing. */
    unvalidated: number;
    /** Distinct checks that have failed, and how often. A defect is a repair, not a patch. */
    failuresByCheck: { check: string; count: number }[];
    /** Whether a person has playtested anything. The directive requires it of a sample. */
    playtests: number;
  };
}

export function readLeverage(
  snapshot: PuzzleSnapshot,
  outputs: readonly OutputReading[],
): LeverageReading {
  const passingInstances = snapshot.instances.filter((one) => isEvidence(snapshot, one.id));
  const validatedMasterIds = new Set(passingInstances.map((one) => one.masterId));

  const qualified = outputs.filter(
    (one) =>
      one.qualification === 'QUALIFIED' ||
      one.qualification === 'SELLABLE' ||
      one.qualification === 'REVENUE_PROVEN',
  ).length;
  const reprints = outputs.filter((one) => one.qualification === 'REPRINT').length;
  const drafts = outputs.filter((one) => one.qualification === 'DRAFT').length;

  const withRun = snapshot.instances.filter((one) => snapshot.validations.has(one.id));
  const unvalidated = snapshot.instances.length - withRun.length;

  const failures = new Map<string, number>();
  for (const run of snapshot.validations.values()) {
    if (run.verdict === 'FAILED' && run.failedCheck) {
      failures.set(run.failedCheck, (failures.get(run.failedCheck) ?? 0) + 1);
    }
  }

  return {
    validatedMasters: validatedMasterIds.size,
    validatedInstances: passingInstances.length,
    qualifiedOutputs: qualified,
    reprints,
    drafts,

    masterToSku:
      validatedMasterIds.size === 0
        ? unmeasured(
            'qualified outputs per validated master system',
            'A master that has produced at least one passing puzzle.',
          )
        : measured(
            Number((qualified / validatedMasterIds.size).toFixed(2)),
            'qualified outputs per validated master system',
          ),

    /*
     * Nothing in this Brain records a print run, a tooling setup or a machine
     * hour. A figure here would be composed from nothing, and it would be the
     * most quoted number on the page — §39 refuses the same shape at a
     * manufacturing programme, for the same reason.
     */
    setupToUnitYield: unmeasured(
      'physical units per print, tooling or machine setup',
      'A recorded production run: the setup it belonged to and the units it produced. Nothing ' +
        'in this Brain records one, and no physical batch has been made.',
    ),
    contributionPerSetup: unmeasured(
      'gross contribution per editorial, software, tooling or machine setup',
      'A recorded production run and a settled payment that resolves to what it produced.',
    ),
    puzzlesPerEditorialHour: unmeasured(
      'validated puzzles per editorial hour',
      'Recorded editorial time. Brain holds no hours, and deriving one from wall-clock time ' +
        'between rows would be timing a queue rather than a person.',
    ),

    target: {
      masters: 10,
      outputs: 50,
      note:
        'The directive’s own search target, and its own caveat: ten reusable systems may ' +
        'produce fifty qualified outputs only when those outputs address real demand and ' +
        'differ substantively. Fifty is a possible ceiling, not an obligation.',
    },

    quality: {
      validationPassRate:
        withRun.length === 0
          ? unmeasured(
              'as a share of instances validated',
              'A validation run. Nothing has been validated yet.',
            )
          : measured(
              Number((passingInstances.length / withRun.length).toFixed(3)),
              `as a share of instances validated (${passingInstances.length} of ${withRun.length})`,
            ),
      unvalidated,
      failuresByCheck: [...failures.entries()]
        .map(([check, count]) => ({ check, count }))
        .sort((a, b) => b.count - a.count || (a.check < b.check ? -1 : 1)),
      playtests: snapshot.observations.filter((one) => one.kind === 'PLAYTEST_RESULT').length,
    },
  };
}
