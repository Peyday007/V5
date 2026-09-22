/**
 * The three leverage multipliers the brief asks for, and the quality readings
 * beside them.
 *
 * ---------------------------------------------------------------------------
 * Three different things, and collapsing them would flatter the one that works
 * ---------------------------------------------------------------------------
 *
 * *Master to SKU* is how many distinct commercial outputs come out of one
 * reusable system. *Setup to unit* is how many physical units come off one
 * print or tooling setup. *Contribution per setup* is what each setup actually
 * earned. The brief asks for all three separately and the reason becomes
 * obvious the moment you try to combine them: the first is measurable today
 * from rows Brain owns, and the other two require a production run and a
 * settled payment that have not happened. A single "leverage" number would be
 * the measurable one wearing the others' names.
 *
 * So each carries its own evidence class, in `evidence_class`'s own
 * vocabulary: `MEASURED` is a figure derived from rows, and `UNKNOWN` is
 * *nobody has observed this* — never zero, because zero is a measurement and a
 * missing measurement is not. §23 settled that at a fleet ceiling and it is
 * the same rule at a print run.
 *
 * ---------------------------------------------------------------------------
 * Ten producing fifty is a target, not a quota
 * ---------------------------------------------------------------------------
 *
 * `masterToSku` counts **qualified** outputs, which is `products.ts`'
 * derivation over rows rather than a count of product rows. That is the whole
 * difference between the number meaning something and the number being fifty
 * covers: a reskin does not count, it cannot be declared into counting, and
 * the reading reports how many were refused as reskins beside the multiplier
 * so the gap is visible rather than quietly absorbed.
 */
import type {
  PuzzleInstance,
  PuzzleMaster,
  PuzzleObservation,
  PuzzleProduct,
} from '../../domain/types.ts';
import type { Qualification } from './products.ts';

export type EvidenceClass = 'MEASURED' | 'UNKNOWN';

export interface Reading {
  value: number | null;
  evidence: EvidenceClass;
  /** What it means, or what would measure it. Never empty. */
  note: string;
}

export interface Leverage {
  /** Systems that have produced at least one validated puzzle. */
  provenMasters: number;
  /** Distinct validated puzzles across all of them. */
  validPuzzles: number;
  /** Products that are genuinely distinct commercial outputs. */
  qualifiedOutputs: number;
  /** Products refused as substantially the same thing again. */
  reskins: number;
  masterToSku: Reading;
  setupToUnitYield: Reading;
  contributionPerSetup: Reading;
  validPuzzlesPerEditorialHour: Reading;
}

export function readLeverage(input: {
  masters: readonly PuzzleMaster[];
  instances: readonly PuzzleInstance[];
  products: readonly PuzzleProduct[];
  qualifications: readonly Qualification[];
  observations: readonly PuzzleObservation[];
}): Leverage {
  const valid = input.instances.filter((one) => one.validationState === 'VALID');
  const productive = new Set(valid.map((one) => one.masterId));
  const qualified = input.qualifications.filter((one) => one.verdict === 'QUALIFIED');
  const reskins = input.qualifications.filter((one) => one.verdict === 'RESKIN');

  const masterToSku: Reading =
    productive.size === 0
      ? {
          value: null,
          evidence: 'UNKNOWN',
          note:
            'No puzzle system has produced a validated puzzle yet, so there is nothing for ' +
            'outputs to be a multiple of.',
        }
      : {
          value: qualified.length / productive.size,
          evidence: 'MEASURED',
          note:
            `${qualified.length} distinct commercial output(s) from ${productive.size} working ` +
            `system(s)` +
            (reskins.length > 0
              ? `. ${reskins.length} further product(s) were refused as substantially the same ` +
                'thing again and are not counted.'
              : '.'),
        };

  /*
   * A production result is the only thing that could measure the second, and
   * it is an observation a person records after a run. Brain has not printed
   * anything and cannot invent a yield: reporting zero would be a measurement
   * of a run that never happened.
   */
  const runs = input.observations.filter((one) => one.kind === 'PRODUCTION_RESULT');
  const setupToUnitYield: Reading =
    runs.length === 0
      ? {
          value: null,
          evidence: 'UNKNOWN',
          note:
            'Nothing has been physically produced. What would measure it is a recorded ' +
            'PRODUCTION_RESULT for a real run: how many saleable units came off one setup, ' +
            'and how many were spoiled.',
        }
      : {
          value: null,
          evidence: 'UNKNOWN',
          note:
            `${runs.length} production result(s) are recorded as prose. Turning them into a ` +
            'yield needs the unit and spoilage counts as figures, which this kernel does not ' +
            'yet take — and reading them out of the sentence would be a number nobody can ' +
            'check.',
        };

  const contributionPerSetup: Reading = {
    value: null,
    evidence: 'UNKNOWN',
    note:
      'Nothing has been settled against a product from this kernel, and no setup cost has ' +
      'been spent. Both are needed: contribution per setup is what a print, tooling or ' +
      'editorial setup actually earned, and it is the figure that decides whether owning ' +
      'production is worth it.',
  };

  /*
   * Deliberately UNKNOWN rather than substituted.
   *
   * Brain could report validated puzzles per *machine second*, which is a
   * genuine number and answers a question nobody asked: the brief's metric is
   * about editorial effort, because that is what a publisher pays for. No
   * hours are recorded anywhere in this repository, so the honest answer is
   * that nobody has measured it and the substitute would look like the
   * measurement.
   */
  const validPuzzlesPerEditorialHour: Reading = {
    value: null,
    evidence: 'UNKNOWN',
    note:
      'No editorial time is recorded anywhere, so this cannot be measured. Machine generation ' +
      'time is not a substitute: what this metric is about is the human effort a publisher ' +
      'pays for, and reporting a machine figure under its name would answer a different ' +
      'question in a way nobody could tell.',
  };

  return {
    provenMasters: productive.size,
    validPuzzles: valid.length,
    qualifiedOutputs: qualified.length,
    reskins: reskins.length,
    masterToSku,
    setupToUnitYield,
    contributionPerSetup,
    validPuzzlesPerEditorialHour,
  };
}

export interface Quality {
  /** Validated instances against everything a generator produced and kept. */
  passRate: Reading;
  /** Canonical forms held by more than one instance. Should always be zero. */
  duplicatesHeld: number;
  /** Instances a person or a customer found something wrong with. */
  defectsReported: number;
  complaints: number;
  /** Formats where a person has actually looked at what the machine made. */
  humanEdited: string[];
  /** The failing checks, counted by name, so a pattern is visible as a pattern. */
  failingChecks: { name: string; count: number }[];
}

export function readQuality(input: {
  instances: readonly PuzzleInstance[];
  observations: readonly PuzzleObservation[];
}): Quality {
  const total = input.instances.length;
  const valid = input.instances.filter((one) => one.validationState === 'VALID').length;

  /*
   * The pass rate is computed over *stored* instances, and every stored
   * instance passed — which would make it a permanent 100% and therefore a
   * number that says nothing. What it actually reports is the honest shape:
   * the refusals live in the batch report rather than in the table, because a
   * refused puzzle is not a row that needs keeping, and the rate a reader
   * wants is the one the last batch measured.
   */
  const passRate: Reading =
    total === 0
      ? {
          value: null,
          evidence: 'UNKNOWN',
          note: 'Nothing has been generated yet.',
        }
      : {
          value: valid / total,
          evidence: 'MEASURED',
          note:
            `${valid} of ${total} stored instance(s) are valid. Every stored instance was ` +
            'validated before it was written, so this is a floor rather than the generator’s ' +
            'true pass rate — what a generator refused is reported by the batch that ran it, ' +
            'and a batch whose failures cross a third stops rather than drawing more seeds.',
        };

  const byCanonical = new Map<string, number>();
  for (const one of input.instances) {
    if (!one.canonicalHash) continue;
    byCanonical.set(one.canonicalHash, (byCanonical.get(one.canonicalHash) ?? 0) + 1);
  }
  const duplicatesHeld = [...byCanonical.values()].filter((count) => count > 1).length;

  const counts = new Map<string, number>();
  for (const instance of input.instances) {
    for (const one of instance.checks) {
      if (one.ok) continue;
      counts.set(one.name, (counts.get(one.name) ?? 0) + 1);
    }
  }

  return {
    passRate,
    duplicatesHeld,
    defectsReported: input.observations.filter((one) => one.kind === 'DEFECT_FOUND').length,
    complaints: input.observations.filter((one) => one.kind === 'CUSTOMER_COMPLAINT').length,
    humanEdited: [
      ...new Set(
        input.observations
          .filter((one) => one.kind === 'HUMAN_EDIT_PASSED' && one.formatKey)
          .map((one) => one.formatKey as string),
      ),
    ],
    failingChecks: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}
