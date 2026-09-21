/**
 * The three multipliers, and the two of them nothing here can measure.
 *
 * ---------------------------------------------------------------------------
 * "A setup of 10 producing 50" is a search target, not a quota
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit that ten reusable systems may produce fifty qualified
 * outputs *only when those outputs address real demand and differ
 * substantively*, and that fifty is a possible ceiling rather than an
 * obligation. So nothing here has a target in it, nothing counts up towards a
 * number, and the denominator is always named. A multiplier reported without
 * its denominator is §29's "0 of 8 settled" in the other direction: accurate,
 * and read as an achievement.
 *
 * ---------------------------------------------------------------------------
 * The count is of *qualified* outputs, which is what makes it honest
 * ---------------------------------------------------------------------------
 *
 * `readEdition` decides qualification from four conditions that all move, and
 * a cosmetic reskin can never satisfy the distinctness one. So this cannot be
 * inflated by re-covering a book: the row exists, it is counted in
 * `editionsDeclared`, and it is absent from `qualifiedEditions`. Both numbers
 * are reported, because the gap between them is the most interesting thing on
 * this reading — it is exactly how much of the catalog is real.
 *
 * ---------------------------------------------------------------------------
 * Two of the three are UNKNOWN, and that is the honest report
 * ---------------------------------------------------------------------------
 *
 * Setup-to-unit yield and contribution per setup are facts about print runs
 * and money. Nothing in this kernel holds either, and inventing a figure for
 * something a person would use to decide whether to buy a machine is the
 * single most expensive thing this file could do. §41 reports four figures as
 * UNKNOWN for the same reason and names what would measure them, which is
 * what makes an unknown actionable rather than merely empty.
 */
import { readValidation } from './validate.ts';
import type { EditionContext, EditionReading } from './editions.ts';

export interface Measured {
  value: number;
  /** What the number is over. A ratio with no denominator measures nothing. */
  denominator: string;
  basis: string;
}

export interface Unmeasured {
  value: null;
  /** What would produce this figure. An unknown with no remedy is merely empty. */
  wouldMeasureIt: string;
}

export interface LeverageReading {
  /** Reusable systems that have actually produced a validated puzzle. */
  provenMasters: number;
  /** Masters declared, including ones that have produced nothing. */
  declaredMasters: number;
  /** Distinct validated puzzles held. The reusable asset itself. */
  validatedPuzzles: number;
  /** Editions somebody declared, qualified or not. */
  editionsDeclared: number;
  /** Editions that are genuinely distinct, validated and rights-clear. */
  qualifiedEditions: number;
  /** Editions recorded honestly as cosmetic variants. Never counted as output. */
  cosmeticVariants: number;

  /** The brief's first multiplier: qualified outputs per reusable system. */
  masterToSku: Measured | Unmeasured;
  /** The brief's second: physical units per print, tooling or machine setup. */
  setupToUnitYield: Unmeasured;
  /** The brief's third: gross contribution produced by each setup. */
  contributionPerSetup: Unmeasured;
  /** Reuse: how often a validated puzzle appears in more than one edition. */
  reuse: Measured | Unmeasured;

  /** One sentence a person reads first. */
  summary: string;
}

export function readLeverage(input: {
  context: EditionContext;
  readings: readonly EditionReading[];
}): LeverageReading {
  const { context } = input;

  const validatedIds = new Set<string>();
  for (const instance of context.instances.values()) {
    const format = context.formats.get(instance.formatId);
    const reading = readValidation({
      formatSlug: format?.slug ?? '',
      instance,
      validations: context.validations.get(instance.id) ?? [],
    });
    if (reading.state === 'VALIDATED') validatedIds.add(instance.id);
  }

  const mastersWithValidated = new Set<string>();
  for (const instance of context.instances.values()) {
    if (validatedIds.has(instance.id)) mastersWithValidated.add(instance.masterId);
  }

  const byId = new Map(input.readings.map((one) => [one.editionId, one]));
  const live = context.editions.filter((one) => one.retiredAt === null);
  const qualified = live.filter((one) => byId.get(one.id)?.qualified === true);
  const cosmetic = live.filter((one) => one.distinctnessAxis === 'COSMETIC');

  const masterToSku: Measured | Unmeasured =
    mastersWithValidated.size > 0
      ? {
          value: Number((qualified.length / mastersWithValidated.size).toFixed(2)),
          denominator: `${qualified.length} qualified edition(s) over ${mastersWithValidated.size} master(s) that have produced a validated puzzle`,
          basis:
            'Counted from rows. A master that has produced nothing is left out of the ' +
            'denominator rather than counted as a system yielding zero, because it has not ' +
            'been tried.',
        }
      : {
          value: null,
          wouldMeasureIt:
            'No master has produced a validated puzzle yet, so there is no reusable system to ' +
            'divide by. Producing a batch from a declared master is what would start this.',
        };

  /* How many editions each validated puzzle appears in. Reuse is the leverage. */
  const appearances = new Map<string, number>();
  for (const edition of live) {
    for (const member of context.members.get(edition.id) ?? []) {
      if (!validatedIds.has(member.instanceId)) continue;
      appearances.set(member.instanceId, (appearances.get(member.instanceId) ?? 0) + 1);
    }
  }
  const placed = [...appearances.values()];
  const reuse: Measured | Unmeasured =
    placed.length > 0
      ? {
          value: Number(
            (placed.reduce((sum, one) => sum + one, 0) / placed.length).toFixed(2),
          ),
          denominator: `${placed.length} validated puzzle(s) that appear in at least one edition`,
          basis:
            'Editions per puzzle. Puzzles in no edition are left out, because a puzzle nobody ' +
            'has used once is not evidence about reuse either way.',
        }
      : {
          value: null,
          wouldMeasureIt:
            'No validated puzzle is carried by any edition yet, so there is nothing whose ' +
            'reuse could be counted.',
        };

  const NO_PRODUCTION_DATA =
    'Nothing here holds a print run, a tooling charge, a machine setup or a unit cost. Those ' +
    'are the manufacturing programme’s (§39) and Cash Mode’s ledger (§30), and no edition is ' +
    'linked to either. A figure invented here would be read as a measurement by somebody ' +
    'deciding whether to buy a machine.';

  return {
    provenMasters: mastersWithValidated.size,
    declaredMasters: context.masters.size,
    validatedPuzzles: validatedIds.size,
    editionsDeclared: live.length,
    qualifiedEditions: qualified.length,
    cosmeticVariants: cosmetic.length,
    masterToSku,
    setupToUnitYield: { value: null, wouldMeasureIt: NO_PRODUCTION_DATA },
    contributionPerSetup: { value: null, wouldMeasureIt: NO_PRODUCTION_DATA },
    reuse,
    summary:
      mastersWithValidated.size === 0
        ? 'No reusable system has produced a validated puzzle yet, so there is no leverage to ' +
          'report — which is a statement about where this is rather than a zero.'
        : `${mastersWithValidated.size} reusable system(s) hold ${validatedIds.size} validated ` +
          `puzzle(s) and have produced ${qualified.length} qualified output(s) from ` +
          `${live.length} declared edition(s). Physical yield and contribution per setup are ` +
          'not measured here at all.',
  };
}
