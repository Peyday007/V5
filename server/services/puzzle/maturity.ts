/**
 * How far this kernel has actually got with a format, and what an output has
 * actually become.
 *
 * ---------------------------------------------------------------------------
 * The ladder stops at the first unanswered rung, with no partial credit
 * ---------------------------------------------------------------------------
 *
 * §45 argues it at a deal and it is the same argument here: a format that can
 * be generated but not validated is not most of the way to sellable. It is one
 * fact away from being worth nothing, and a percentage would say the opposite.
 * So each rung is one question answered from rows, the reading stops at the
 * first that is not, and it names what would answer it.
 *
 * ---------------------------------------------------------------------------
 * The directive's sharpest instruction lives in one rung
 * ---------------------------------------------------------------------------
 *
 * *Do not falsely claim support for puzzle formats lacking real validators.*
 * `VALIDATABLE` is therefore not "a validator ran" — it is *every check the
 * evidence says this format demands is one something can actually run, and at
 * least one instance has passed them all*. A format whose evidence demands a
 * check nothing implements stops at GENERATABLE with that check named, which
 * is the honest answer and the one a person can act on.
 *
 * Its converse matters too and is why `demandedChecks` reads rows rather than
 * a constant: with no `puzzle_standards` rows at all, nobody has established
 * what this format demands, so the rung is **not** passed by vacuous
 * satisfaction of an empty set. An unresearched format cannot be validatable,
 * and treating "no requirements found" as "no requirements" is the unknown
 * read as a favourable assumption at the one place it would put unsolvable
 * puzzles in somebody's hands.
 */
import { checksAvailableFor, enginesForFormat } from './engines/index.ts';
import { isEvidence, mastersOf, outputsOf, type PuzzleSnapshot } from './graph.ts';
import { qualifyingAxes } from '../../domain/puzzle.ts';
import type {
  FormatMaturity,
  OutputQualification,
  PuzzleFormat,
  PuzzleOutput,
  ValidationCheck,
} from '../../domain/types.ts';

/** "cover", "cover and title", "cover, title and page order". */
function listed(axes: readonly string[]): string {
  const words = axes.map((one) => one.toLowerCase().replace(/_/g, ' '));
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/* --------------------------------------------------------------------------
 * What an output has become
 * ------------------------------------------------------------------------ */

export interface OutputReading {
  outputId: string;
  title: string;
  qualification: OutputQualification;
  /** The server's own sentence. A screen renders it and composes none of its own. */
  why: string;
  members: number;
  /** Members whose current validation is not PASSED. Named, never counted away. */
  unvalidatedMembers: number;
  qualifyingAxes: string[];
  cosmeticAxes: string[];
  /** What would move it up one rung, or null where it is as far as it goes. */
  nextQuestion: string | null;
}

/**
 * Read one output.
 *
 * `siblings` is every other live output on the same master, and it is what
 * makes the reskin rule real rather than a promise: an output differentiated
 * only on axes a sibling already claims is the *same* product with a different
 * cover, whatever its differentiator list says.
 */
export function readOutput(
  snapshot: PuzzleSnapshot,
  output: PuzzleOutput,
  siblings: readonly PuzzleOutput[],
): OutputReading {
  const members = snapshot.members.get(output.id) ?? [];
  const unvalidated = members.filter((one) => !isEvidence(snapshot, one.instanceId));
  const qualifying = qualifyingAxes(output.differentiators).map(String).sort();
  const cosmetic = output.differentiators
    .filter((axis) => !qualifyingAxes([axis]).length)
    .map(String)
    .sort();

  const base = {
    outputId: output.id,
    title: output.title,
    members: members.length,
    unvalidatedMembers: unvalidated.length,
    qualifyingAxes: qualifying,
    cosmeticAxes: cosmetic,
  };

  if (members.length === 0) {
    return {
      ...base,
      qualification: 'DRAFT',
      why: 'No puzzles are in it yet, so there is nothing to be a product of.',
      nextQuestion: 'Add validated instances to it.',
    };
  }

  if (unvalidated.length > 0) {
    return {
      ...base,
      qualification: 'DRAFT',
      why:
        `${unvalidated.length} of its ${members.length} puzzles have no passing validation, so ` +
        'this is not a book of working puzzles. A puzzle with no current PASSED run is one ' +
        'this kernel does not have, never one it has and has not checked.',
      nextQuestion: 'Validate every member, or replace the ones that fail.',
    };
  }

  /*
   * Assembled. Now: is it a product, or the same product again?
   *
   * The comparison is against siblings on the same master, because that is
   * what the directive's multiplier counts — outputs *from one reusable
   * system*. Two books from two different masters are two books whatever their
   * differentiators say.
   */
  if (qualifying.length === 0) {
    return {
      ...base,
      qualification: 'REPRINT',
      why:
        cosmetic.length > 0
          ? `It differs from its siblings only by ${listed(cosmetic)}, which is ` +
            'a reprint rather than a new product. Counting it would be counting one generator ' +
            'run twice.'
          : 'It declares no way in which it differs from its siblings, so it is the same ' +
            'product again.',
      nextQuestion:
        'Differentiate it on something a buyer would notice — different puzzles, a different ' +
        'audience, a different difficulty, a different delivery format or a different language.',
    };
  }

  const signature = qualifying.join('|');
  /*
   * The **earlier** sibling is the product; a later one claiming the identical
   * qualifying differences is the reprint.
   *
   * Written the obvious way first — any sibling with the same signature — and
   * that marked *both* of two identical books as reprints, so the catalog had
   * a reprint of nothing. Order decides it, deterministically and in both
   * dialects: creation time, then id, which is the ordering the repository's
   * own listing already uses.
   */
  const isLater = (other: PuzzleOutput): boolean =>
    other.createdAt < output.createdAt ||
    (other.createdAt === output.createdAt && other.id < output.id);
  const clash = siblings.find(
    (other) =>
      other.id !== output.id &&
      !other.retiredAt &&
      isLater(other) &&
      qualifyingAxes(other.differentiators).map(String).sort().join('|') === signature,
  );
  if (clash) {
    return {
      ...base,
      qualification: 'REPRINT',
      why:
        `"${clash.title}" already claims exactly the same qualifying differences, so these are ` +
        'one product in two covers rather than two products.',
      nextQuestion: 'Differentiate it from that sibling, or record it as the reprint it is.',
    };
  }

  if (!output.targetBuyer) {
    return {
      ...base,
      qualification: 'ASSEMBLED',
      why:
        'Every puzzle in it passes, and it differs from its siblings — but nobody is named as ' +
        'the buyer, so it is a finished thing rather than a product for someone.',
      nextQuestion: 'Name who it is for.',
    };
  }

  /*
   * Sellable needs two things about the route and neither is optional: somebody
   * publishing that they buy this, and a published price. Demand with no price
   * is a market nobody has costed, and a price with no demand is a number.
   */
  const route = output.routeId ? snapshot.routes.find((one) => one.id === output.routeId) : null;
  if (!route) {
    return {
      ...base,
      qualification: 'QUALIFIED',
      why: 'A differentiated product with a named buyer, and no route recorded to reach them.',
      nextQuestion: 'Record which monetization route this reaches its buyer through.',
    };
  }
  const demand = snapshot.routeEvidence.some(
    (one) => one.routeId === route.id && one.posture === 'DEMAND_FOUND',
  );
  const priced = snapshot.economics.some(
    (one) =>
      one.routeId === route.id &&
      (one.component === 'RETAIL_PRICE' ||
        one.component === 'NET_RECEIPTS' ||
        one.component === 'LICENSE_FEE' ||
        one.component === 'SYNDICATION_FEE' ||
        one.component === 'SUBSCRIPTION_PRICE' ||
        one.component === 'CUSTOM_COMMISSION'),
  );
  if (!demand || !priced) {
    return {
      ...base,
      qualification: 'QUALIFIED',
      why:
        !demand && !priced
          ? `Nothing establishes that anybody buys through "${route.name}" or what they pay.`
          : !demand
            ? `A price is recorded for "${route.name}" but nothing establishes that anybody buys ` +
              'through it.'
            : `Somebody buys through "${route.name}" but nothing establishes what they pay.`,
      nextQuestion: !demand ? 'Establish a dated buying signal on that route.' : 'Establish a published price on that route.',
    };
  }

  if (output.opportunityId && snapshot.settledOpportunityIds.has(output.opportunityId)) {
    return {
      ...base,
      qualification: 'REVENUE_PROVEN',
      why: 'Money has settled against the opportunity this output became.',
      nextQuestion: null,
    };
  }

  return {
    ...base,
    qualification: 'SELLABLE',
    why:
      `A differentiated product for a named buyer on "${route.name}", where somebody publishes ` +
      'that they buy and what they pay. Nothing has been sold yet.',
    nextQuestion:
      output.releasedAt === null
        ? 'A person releases it, and it is pursued through Cash Mode.'
        : 'Collect the first payment.',
  };
}

/** Every output read, with siblings resolved per master. */
export function readOutputs(snapshot: PuzzleSnapshot): OutputReading[] {
  return snapshot.outputs
    .filter((one) => !one.retiredAt)
    .map((output) => readOutput(snapshot, output, outputsOf(snapshot, output.masterId)));
}

/* --------------------------------------------------------------------------
 * How far a format has got
 * ------------------------------------------------------------------------ */

export interface FormatReading {
  formatKey: string;
  name: string;
  maturity: FormatMaturity;
  why: string;
  /** What would answer the next rung, or null at the top. */
  nextQuestion: string | null;

  engines: string[];
  /** Checks the evidence says this format demands. */
  demandedChecks: ValidationCheck[];
  /** Demanded checks nothing can run. The honest gap. */
  missingChecks: ValidationCheck[];
  masters: number;
  reviewedMasters: number;
  instances: number;
  passing: number;
  outputs: number;
  qualifiedOutputs: number;
}

export function readFormat(
  snapshot: PuzzleSnapshot,
  format: PuzzleFormat,
  outputReadings: readonly OutputReading[],
): FormatReading {
  const key = format.formatKey;
  const engines = enginesForFormat(key);
  const masters = mastersOf(snapshot, key);
  const reviewed = masters.filter((one) => one.reviewedAt !== null);
  const instances = snapshot.instances.filter((one) => one.formatKey === key);
  const passing = instances.filter((one) => isEvidence(snapshot, one.id));

  const demanded = [
    ...new Set(
      snapshot.standards.filter((one) => one.formatKey === key).map((one) => one.checkKind),
    ),
  ].sort();
  const available = new Set(checksAvailableFor(key));
  const missing = demanded.filter((check) => !available.has(check));

  const ownIds = new Set(
    snapshot.outputs
      .filter((output) => masters.some((master) => master.id === output.masterId))
      .map((one) => one.id),
  );
  const own = outputReadings.filter((one) => ownIds.has(one.outputId));
  const assembled = own.filter(
    (one) =>
      one.qualification === 'ASSEMBLED' ||
      one.qualification === 'QUALIFIED' ||
      one.qualification === 'SELLABLE' ||
      one.qualification === 'REVENUE_PROVEN',
  );
  const qualified = own.filter(
    (one) =>
      one.qualification === 'QUALIFIED' ||
      one.qualification === 'SELLABLE' ||
      one.qualification === 'REVENUE_PROVEN',
  );
  const sellable = own.filter(
    (one) => one.qualification === 'SELLABLE' || one.qualification === 'REVENUE_PROVEN',
  );
  const proven = own.filter((one) => one.qualification === 'REVENUE_PROVEN');

  const base = {
    formatKey: key,
    name: format.name,
    engines: engines.map((one) => one.id),
    demandedChecks: demanded,
    missingChecks: missing,
    masters: masters.length,
    reviewedMasters: reviewed.length,
    instances: instances.length,
    passing: passing.length,
    outputs: own.length,
    qualifiedOutputs: qualified.length,
  };

  /* RESEARCHED: has anybody established anything about it? */
  const researched =
    snapshot.standards.some((one) => one.formatKey === key) ||
    snapshot.rights.some((one) => one.formatKey === key) ||
    snapshot.routeEvidence.some((one) => one.formatKey === key) ||
    snapshot.economics.some((one) => one.formatKey === key);
  if (!researched) {
    return {
      ...base,
      maturity: 'DISCOVERED',
      /*
       * Where something has already been produced, say so in the same breath.
       * This rung is about what is *known* rather than what has been *made*,
       * and a reading that said only "nothing has been established" beside a
       * line reporting fifty validated puzzles would read as a contradiction —
       * §29's defect, where a status disagreeing with the figures next to it
       * teaches a person to stop reading it.
       */
      why:
        passing.length > 0
          ? `It already produces — ${passing.length} validated puzzle(s) — and nothing ` +
            'establishes what the trade demands of one, who buys them, or what the rights ' +
            'rules are. This rung is about what is known rather than what has been made.'
          : 'It is on the map and nothing has been established about it.',
      nextQuestion:
        'What does the trade demand of one of these, who buys them, and what are the rights ' +
        'rules?',
    };
  }

  /* GENERATABLE: an engine, a reviewed master, and something actually produced. */
  if (engines.length === 0) {
    return {
      ...base,
      maturity: 'RESEARCHED',
      why: 'No engine here can generate one, so nothing can be produced in this format.',
      nextQuestion: 'Build a generator for it, or treat this format as research only.',
    };
  }
  if (reviewed.length === 0) {
    return {
      ...base,
      maturity: 'RESEARCHED',
      why:
        masters.length === 0
          ? 'An engine exists and no master uses it, so nothing has been set up to produce from.'
          : `${masters.length} master(s) exist and none has been editorially reviewed. The ` +
            'directive requires a person to review every new generator or template before it ' +
            'produces.',
      nextQuestion:
        masters.length === 0 ? 'Create a master for it.' : 'A person reviews the master.',
    };
  }
  if (instances.length === 0) {
    return {
      ...base,
      maturity: 'RESEARCHED',
      why: 'A reviewed master exists and has produced nothing.',
      nextQuestion: 'Produce a batch from it.',
    };
  }

  /* VALIDATABLE: every demanded check runnable, and something has passed. */
  if (demanded.length === 0) {
    return {
      ...base,
      maturity: 'GENERATABLE',
      why:
        'It produces, and nothing establishes what the trade demands of one — so there is no ' +
        'standard for a validator to be judged against. An empty requirement list is nobody ' +
        'having looked, never a format with no requirements.',
      nextQuestion: 'Establish what a good one of these must satisfy.',
    };
  }
  if (missing.length > 0) {
    return {
      ...base,
      maturity: 'GENERATABLE',
      why:
        `The evidence demands ${missing.join(', ')}, and nothing here can run ${
          missing.length === 1 ? 'it' : 'them'
        }. Claiming this format is validated would be the one lie that ends with unsolvable ` +
        'puzzles in somebody’s hands.',
      nextQuestion: `Implement ${missing.join(', ')} in the validator.`,
    };
  }
  if (passing.length === 0) {
    return {
      ...base,
      maturity: 'GENERATABLE',
      why: `Every demanded check can be run and none of the ${instances.length} instances passes them.`,
      nextQuestion: 'Repair the generator until one does.',
    };
  }

  /* PRODUCTIZABLE: something has been assembled out of passing instances. */
  if (assembled.length === 0) {
    return {
      ...base,
      maturity: 'VALIDATABLE',
      why: `${passing.length} validated puzzle(s) exist and none has been compiled into a product.`,
      nextQuestion: 'Compile an output from them.',
    };
  }

  if (sellable.length === 0) {
    return {
      ...base,
      maturity: 'PRODUCTIZABLE',
      why:
        qualified.length === 0
          ? `${assembled.length} assembled product(s), none of which is differentiated for a ` +
            'named buyer.'
          : `${qualified.length} qualified product(s), none of which has both a dated buying ` +
            'signal and a published price on its route.',
      nextQuestion:
        qualified.length === 0
          ? 'Differentiate one for a named buyer.'
          : 'Establish who buys through that route and what they pay.',
    };
  }

  if (proven.length === 0) {
    return {
      ...base,
      maturity: 'SELLABLE',
      why: `${sellable.length} product(s) could be sold and none has been paid for.`,
      nextQuestion: 'Collect the first settled payment.',
    };
  }

  /*
   * The top three rungs are real and are deliberately not reachable from
   * anything this Brain currently records. Saying so is the honest report:
   * REPEATABLE needs a second sale or a renewal, SCALABLE needs a measured
   * throughput, and PRODUCTION_OWNED needs machinery somebody bought. None of
   * those is a number this kernel could derive, and inventing one would be the
   * manufactured measurement §29 refuses.
   */
  if (proven.length < 2) {
    return {
      ...base,
      maturity: 'REVENUE_PROVEN',
      why: 'One product in this format has been paid for.',
      nextQuestion: 'A second sale, a repeat order or a renewal would make it repeatable.',
    };
  }
  return {
    ...base,
    maturity: 'REPEATABLE',
    why: `${proven.length} products in this format have been paid for.`,
    nextQuestion:
      'Scalability is a measured throughput and production ownership is machinery somebody ' +
      'bought. Neither is a figure this kernel can derive, so both stay unreported until they ' +
      'are measured.',
  };
}

export function readFormats(snapshot: PuzzleSnapshot): FormatReading[] {
  const outputs = readOutputs(snapshot);
  return snapshot.formats
    .filter((one) => !one.retiredAt)
    .map((format) => readFormat(snapshot, format, outputs));
}
