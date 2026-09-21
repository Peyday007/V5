/**
 * What a puzzle finding means, what it may create, and the one validator both
 * submission doors call.
 *
 * ---------------------------------------------------------------------------
 * The rule this module exists to hold
 * ---------------------------------------------------------------------------
 *
 * A finding's kind decides which table it lands in, by a **lookup rather than
 * a reading**. `domain/dealflow.ts`, `domain/industry.ts` and
 * `domain/opportunitySignals.ts` all make the same argument: the judgement is
 * made once, by the only party that can make it — somebody who actually read
 * the source — and everything after that is Brain matching a value from a
 * closed set exactly. Nothing here inspects a sentence, and nothing downstream
 * may either.
 *
 * ---------------------------------------------------------------------------
 * There is no list of puzzle formats in this module
 * ---------------------------------------------------------------------------
 *
 * Deliberately, and `tests/puzzleKernel.test.ts` reads the source to say so.
 * Every vocabulary below classifies something about the *trade* — how money is
 * captured, which check a validator runs, which axis two products differ on —
 * and none of them says what a puzzle is. The universe is rows: a format
 * exists because a gated claim named it or a person seeded it. A hardcoded
 * taxonomy would answer the question this kernel exists to ask, and it would
 * be wrong about every format the trade has invented since somebody typed it.
 *
 * ---------------------------------------------------------------------------
 * Why a figure's basis is required and its side is not declared
 * ---------------------------------------------------------------------------
 *
 * The side of the arithmetic a component sits on is a `Record` here, never a
 * field a caller sets: a submission that could declare a retailer share as
 * revenue would be a submission that could make a run look profitable. The
 * *basis* is the opposite — what a figure is per is a fact only the source
 * states, Brain cannot recover it, and a per-unit cost added to a per-run
 * setup cost is a number that is wrong in the direction nobody checks.
 */
import {
  DEMAND_POSTURES,
  DIFFERENTIATOR_AXES,
  ECONOMIC_COMPONENTS,
  FORMAT_MATURITIES,
  OUTPUT_QUALIFICATIONS,
  PRODUCTION_CLASSES,
  PRODUCTION_STAGES,
  PUZZLE_FINDINGS,
  PUZZLE_OBSERVATION_KINDS,
  PUZZLE_ORIGINS,
  PUZZLE_ROUND_PURPOSES,
  PUZZLE_ROUND_STATES,
  RIGHTS_KINDS,
  ROUTE_CLASSES,
  ROUTE_DISPOSITIONS,
  VALIDATION_CHECKS,
  VALIDATION_VERDICTS,
  type DemandPosture,
  type DifferentiatorAxis,
  type EconomicComponent,
  type FormatMaturity,
  type OutputQualification,
  type ProductionClass,
  type ProductionStage,
  type PuzzleFinding,
  type PuzzleObservationKind,
  type PuzzleOrigin,
  type PuzzleRoundPurpose,
  type PuzzleRoundState,
  type RightsKind,
  type RouteClass,
  type RouteDisposition,
  type ValidationCheck,
  type ValidationVerdict,
} from './types.ts';

export {
  DEMAND_POSTURES,
  DIFFERENTIATOR_AXES,
  ECONOMIC_COMPONENTS,
  FORMAT_MATURITIES,
  OUTPUT_QUALIFICATIONS,
  PRODUCTION_CLASSES,
  PRODUCTION_STAGES,
  PUZZLE_FINDINGS,
  RIGHTS_KINDS,
  ROUTE_CLASSES,
  ROUTE_DISPOSITIONS,
  VALIDATION_CHECKS,
};
export type {
  DifferentiatorAxis,
  EconomicComponent,
  FormatMaturity,
  OutputQualification,
  ProductionClass,
  ProductionStage,
  PuzzleFinding,
  RightsKind,
  RouteClass,
  ValidationCheck,
};

/* --------------------------------------------------------------------------
 * Type guards
 * ------------------------------------------------------------------------ */

const isMember = (set: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && set.includes(value);

export const isPuzzleFinding = (v: unknown): v is PuzzleFinding => isMember(PUZZLE_FINDINGS, v);
export const isValidationCheck = (v: unknown): v is ValidationCheck =>
  isMember(VALIDATION_CHECKS, v);
export const isRightsKind = (v: unknown): v is RightsKind => isMember(RIGHTS_KINDS, v);
export const isRouteClass = (v: unknown): v is RouteClass => isMember(ROUTE_CLASSES, v);
export const isRouteDisposition = (v: unknown): v is RouteDisposition =>
  isMember(ROUTE_DISPOSITIONS, v);
export const isEconomicComponent = (v: unknown): v is EconomicComponent =>
  isMember(ECONOMIC_COMPONENTS, v);
export const isDifferentiatorAxis = (v: unknown): v is DifferentiatorAxis =>
  isMember(DIFFERENTIATOR_AXES, v);
export const isProductionClass = (v: unknown): v is ProductionClass =>
  isMember(PRODUCTION_CLASSES, v);
export const isProductionStage = (v: unknown): v is ProductionStage =>
  isMember(PRODUCTION_STAGES, v);
export const isFormatMaturity = (v: unknown): v is FormatMaturity =>
  isMember(FORMAT_MATURITIES, v);
export const isOutputQualification = (v: unknown): v is OutputQualification =>
  isMember(OUTPUT_QUALIFICATIONS, v);
export const isPuzzleRoundPurpose = (v: unknown): v is PuzzleRoundPurpose =>
  isMember(PUZZLE_ROUND_PURPOSES, v);
export const isPuzzleRoundState = (v: unknown): v is PuzzleRoundState =>
  isMember(PUZZLE_ROUND_STATES, v);
export const isPuzzleOrigin = (v: unknown): v is PuzzleOrigin => isMember(PUZZLE_ORIGINS, v);
export const isValidationVerdict = (v: unknown): v is ValidationVerdict =>
  isMember(VALIDATION_VERDICTS, v);
export const isDemandPosture = (v: unknown): v is DemandPosture => isMember(DEMAND_POSTURES, v);
export const isPuzzleObservationKind = (v: unknown): v is PuzzleObservationKind =>
  isMember(PUZZLE_OBSERVATION_KINDS, v);

/* --------------------------------------------------------------------------
 * Keys
 * ------------------------------------------------------------------------ */

/**
 * The key two format rows are matched on.
 *
 * Case, surrounding whitespace and internal runs of it, and nothing else. It
 * does not stem, does not strip plurals and does not know that a "word search"
 * and a "wordsearch" might be the same thing. §37 settled why: a matcher that
 * tried harder produces confident wrong answers, and missing a match costs a
 * reading while inventing one files evidence about crosswords under
 * cryptograms.
 *
 * The keys converge instead because Brain supplies the vocabulary — every
 * question about a format carries that format's name **verbatim from Brain's
 * own rows** and asks for it back unchanged, which is a mechanism somebody can
 * read rather than a similarity threshold nobody can audit.
 */
export function formatKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The same normalization for a route, so two spellings do not split a ledger entry. */
export function routeKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/* --------------------------------------------------------------------------
 * What each finding creates
 * ------------------------------------------------------------------------ */

/**
 * Where a finding lands.
 *
 * A `Record` over the whole union rather than a `Set` of the ones that do
 * something, so a finding added later is a compile error until somebody says
 * where it goes. §27 records what two `Set`s that must be total between them
 * cost: a refusal fell into the exhausting branch by default because neither
 * named it.
 */
export type PuzzleFindingTarget =
  | 'FORMAT'
  | 'STANDARD'
  | 'RIGHTS'
  | 'ROUTE'
  | 'ROUTE_EVIDENCE'
  | 'ECONOMICS';

const TARGET: Readonly<Record<PuzzleFinding, PuzzleFindingTarget>> = Object.freeze({
  FORMAT_EXISTS: 'FORMAT',
  QUALITY_STANDARD: 'STANDARD',
  RIGHTS_CONSTRAINT: 'RIGHTS',
  MONETIZATION_ROUTE: 'ROUTE',
  BUYER_DEMAND: 'ROUTE_EVIDENCE',
  DEMAND_ABSENCE: 'ROUTE_EVIDENCE',
  ECONOMIC_FIGURE: 'ECONOMICS',
});

export function targetForFinding(finding: PuzzleFinding): PuzzleFindingTarget {
  return TARGET[finding];
}

/**
 * The posture a route-evidence finding writes.
 *
 * Null for every finding that writes no evidence row. `NONE_FOUND` exists only
 * because somebody documented a search: the absence of rows says "nobody has
 * looked", which is a different fact with a different remedy.
 */
const POSTURE: Readonly<Record<PuzzleFinding, DemandPosture | null>> = Object.freeze({
  FORMAT_EXISTS: null,
  QUALITY_STANDARD: null,
  RIGHTS_CONSTRAINT: null,
  MONETIZATION_ROUTE: null,
  BUYER_DEMAND: 'DEMAND_FOUND',
  DEMAND_ABSENCE: 'NONE_FOUND',
  ECONOMIC_FIGURE: null,
});

export function postureForFinding(finding: PuzzleFinding): DemandPosture | null {
  return POSTURE[finding];
}

/**
 * Which closed set a finding's `puzzle_value` must come from, or null where
 * the finding carries no value at all.
 *
 * Reading any of these out of the claim sentence would be the prose-parsing
 * §25's Westbrook defect records — a confidently wrong answer that every row
 * around it agrees with.
 */
export function valueVocabularyFor(finding: PuzzleFinding): readonly string[] | null {
  if (finding === 'QUALITY_STANDARD') return VALIDATION_CHECKS;
  if (finding === 'RIGHTS_CONSTRAINT') return RIGHTS_KINDS;
  if (finding === 'MONETIZATION_ROUTE') return ROUTE_CLASSES;
  if (finding === 'ECONOMIC_FIGURE') return ECONOMIC_COMPONENTS;
  return null;
}

/**
 * Whether a finding must name the format it is about.
 *
 * A route and its demand evidence may be about the trade rather than about one
 * format — "libraries commission puzzle programmes" is a real and useful
 * finding that names no format — so those three are optional. Everything else
 * is meaningless without one.
 */
export function findingRequiresFormat(finding: PuzzleFinding): boolean {
  return (
    finding === 'FORMAT_EXISTS' ||
    finding === 'QUALITY_STANDARD' ||
    finding === 'RIGHTS_CONSTRAINT'
  );
}

/** Whether a finding must carry a figure, its currency and its basis. All three together. */
export function findingRequiresAmount(finding: PuzzleFinding): boolean {
  return finding === 'ECONOMIC_FIGURE';
}

/**
 * Whether a finding must carry the date the source observed it.
 *
 * Only a demand signal, and there it is required rather than encouraged. §30
 * records the rule at the same kind of column: an undated buying signal cannot
 * be told apart from one somebody remembers from years ago, and this is the
 * column the directive's own "paid demand outranks views" rests on.
 */
export function findingRequiresObservedOn(finding: PuzzleFinding): boolean {
  return finding === 'BUYER_DEMAND';
}

/* --------------------------------------------------------------------------
 * The arithmetic's two sides
 * ------------------------------------------------------------------------ */

export type EconomicSide = 'REVENUE' | 'COST';

/**
 * Which side of the arithmetic a component sits on.
 *
 * A `Record` over the whole union, so a component added later is a compile
 * error until somebody says which side it is. Never a declared field: a
 * caller that could say a retailer share is revenue would be a caller that
 * could make a run look profitable, and that error fails in the direction
 * nobody checks because it looks like good news.
 */
const SIDE: Readonly<Record<EconomicComponent, EconomicSide>> = Object.freeze({
  RETAIL_PRICE: 'REVENUE',
  NET_RECEIPTS: 'REVENUE',
  LICENSE_FEE: 'REVENUE',
  SYNDICATION_FEE: 'REVENUE',
  SUBSCRIPTION_PRICE: 'REVENUE',
  CUSTOM_COMMISSION: 'REVENUE',
  EDITORIAL_COST: 'COST',
  PLATFORM_FEE: 'COST',
  RETAILER_SHARE: 'COST',
  PREPRESS_COST: 'COST',
  TOOLING_SETUP: 'COST',
  PRINTING_COST: 'COST',
  MATERIALS_COST: 'COST',
  PACKAGING_COST: 'COST',
  FREIGHT_COST: 'COST',
  FULFILLMENT_COST: 'COST',
  STORAGE_COST: 'COST',
  RETURNS_ALLOWANCE: 'COST',
  LABOR_COST: 'COST',
  ROYALTY: 'COST',
});

export function sideFor(component: EconomicComponent): EconomicSide {
  return SIDE[component];
}

/**
 * Whether a component is a one-off setup rather than a per-unit line.
 *
 * The directive's breakeven arithmetic needs the two kept apart —
 * `breakeven units = fixed setup cost ÷ contribution per sold unit` is
 * nonsense if a per-unit printing cost is counted as a setup — and the *basis*
 * on the row says what the source meant. This says what the **component**
 * means, which is the half a basis string cannot be trusted to carry, because
 * it is free text a worker wrote.
 */
const SETUP: Readonly<Record<EconomicComponent, boolean>> = Object.freeze({
  RETAIL_PRICE: false,
  NET_RECEIPTS: false,
  LICENSE_FEE: false,
  SYNDICATION_FEE: false,
  SUBSCRIPTION_PRICE: false,
  CUSTOM_COMMISSION: false,
  EDITORIAL_COST: true,
  PLATFORM_FEE: false,
  RETAILER_SHARE: false,
  PREPRESS_COST: true,
  TOOLING_SETUP: true,
  PRINTING_COST: false,
  MATERIALS_COST: false,
  PACKAGING_COST: false,
  FREIGHT_COST: false,
  FULFILLMENT_COST: false,
  STORAGE_COST: false,
  RETURNS_ALLOWANCE: false,
  LABOR_COST: false,
  ROYALTY: false,
});

export function isSetupCost(component: EconomicComponent): boolean {
  return SETUP[component];
}

/**
 * The cost lines a contribution reading for this production class cannot be
 * computed without.
 *
 * A `Record` over the whole union, so a production class added later is a
 * compile error until somebody says what its arithmetic needs. The point is
 * the withholding: a total that steps over a missing printing cost is
 * *smaller* than anything published says, which makes a product look cheaper
 * to make than it is — and too low at the number that decides whether to print
 * reads as a bargain rather than as a mistake. §30 records
 * `conservativeContribution` making exactly that error one kernel along.
 */
const LOAD_BEARING: Readonly<Record<ProductionClass, readonly EconomicComponent[]>> = Object.freeze(
  {
    DIGITAL_ONLY: Object.freeze(['PLATFORM_FEE'] as const),
    PRINTABLE: Object.freeze(['PLATFORM_FEE'] as const),
    FEED: Object.freeze([] as const),
    BOOK: Object.freeze(['PRINTING_COST', 'FREIGHT_COST'] as const),
    ACTIVITY_PAD: Object.freeze(['PRINTING_COST', 'FREIGHT_COST'] as const),
    CARD: Object.freeze(['PRINTING_COST', 'MATERIALS_COST', 'PACKAGING_COST', 'FREIGHT_COST'] as const),
    JIGSAW: Object.freeze([
      'PRINTING_COST',
      'MATERIALS_COST',
      'TOOLING_SETUP',
      'PACKAGING_COST',
      'FREIGHT_COST',
    ] as const),
    BOXED_KIT: Object.freeze([
      'MATERIALS_COST',
      'PACKAGING_COST',
      'FREIGHT_COST',
      'LABOR_COST',
    ] as const),
    MECHANICAL: Object.freeze([
      'MATERIALS_COST',
      'TOOLING_SETUP',
      'LABOR_COST',
      'PACKAGING_COST',
      'FREIGHT_COST',
    ] as const),
  },
);

export function loadBearingFor(productionClass: ProductionClass): readonly EconomicComponent[] {
  return LOAD_BEARING[productionClass];
}

/* --------------------------------------------------------------------------
 * The reskin rule
 * ------------------------------------------------------------------------ */

/**
 * Which differentiator axes make a new qualified output, and which do not.
 *
 * This is the directive's honesty rule in one table: *a cover-color change,
 * title change, reordered pages, or other cosmetic reskin does not create a
 * new qualified output.* A `Record` over the whole union, so an axis added
 * later is a compile error until somebody says whether it counts — and the
 * three cosmetic ones are named here rather than being absent, because
 * recording that two books differ by their cover is honest and counting it is
 * not.
 */
const QUALIFYING: Readonly<Record<DifferentiatorAxis, boolean>> = Object.freeze({
  PUZZLE_CONTENT: true,
  MECHANIC: true,
  AUDIENCE: true,
  DIFFICULTY: true,
  DELIVERY_FORMAT: true,
  USE_OCCASION: true,
  LANGUAGE: true,
  BUYER: true,
  CHANNEL: true,
  ACCESSIBILITY: true,
  TITLE: false,
  COVER: false,
  PAGE_ORDER: false,
});

export function axisQualifies(axis: DifferentiatorAxis): boolean {
  return QUALIFYING[axis];
}

export function qualifyingAxes(
  axes: readonly DifferentiatorAxis[],
): DifferentiatorAxis[] {
  return axes.filter(axisQualifies);
}

/* --------------------------------------------------------------------------
 * The guide a worker reads
 * ------------------------------------------------------------------------ */

export const PUZZLE_FINDING_GUIDE: Readonly<Record<PuzzleFinding, string>> = Object.freeze({
  FORMAT_EXISTS:
    'a puzzle format that is actually published or sold, named as the trade names it, with ' +
    'who it is for',
  QUALITY_STANDARD:
    'something the trade demands of a puzzle of this format before it is fit to sell — and ' +
    'puzzle_value is which check from the closed list that is, because a standard nothing ' +
    'can run is a sentence rather than a gate',
  RIGHTS_CONSTRAINT:
    'a published rule about copyright, trademark, licensing, a platform policy or content ' +
    'that binds what may be made or sold in this format',
  MONETIZATION_ROUTE:
    'a way money is actually captured in this trade, evidenced rather than imagined — and ' +
    'puzzle_value is which class of route it is',
  BUYER_DEMAND:
    'a named organisation, publication or channel that has published that it buys, ' +
    'commissions or licenses this — with puzzle_observed_on set to the date the source ' +
    'observed it, because an undated signal cannot be told apart from one somebody ' +
    'remembers from years ago',
  DEMAND_ABSENCE:
    'a documented search establishing that nobody publishes demand on this route — name ' +
    'where you looked in searched_repositories, or this is not established',
  ECONOMIC_FIGURE:
    'one published figure for one line of the economics — and puzzle_basis is what the ' +
    'figure is *per*, in the source’s own words (one copy, one print run of 10,000, one ' +
    'month, one commission), because a per-unit cost added to a per-run setup is a number ' +
    'that is wrong in the direction nobody checks',
});

/* --------------------------------------------------------------------------
 * The one validator
 * ------------------------------------------------------------------------ */

export interface PuzzleDeclaration {
  finding: PuzzleFinding | null;
  subject: string | null;
  format: string | null;
  value: string | null;
  basis: string | null;
  amountMinor: number | null;
  currency: string | null;
  observedOn: string | null;
}

export type PuzzleCheck =
  | { ok: true; value: PuzzleDeclaration }
  | { ok: false; error: string };

const ABSENT: PuzzleDeclaration = Object.freeze({
  finding: null,
  subject: null,
  format: null,
  value: null,
  basis: null,
  amountMinor: null,
  currency: null,
  observedOn: null,
});

/** ISO-8601 date, or a year-month, or a year. A source's own granularity. */
const OBSERVED_ON = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/**
 * Validate one claim's puzzle declaration.
 *
 * Called by the MCP tool and by the provider-path parser, and by nothing else.
 * A second copy of the *rule* is how two doors come to disagree about what a
 * valid declaration is, which this repository has had to record six times.
 *
 * `searchedRepositories` is taken because one finding — and only one — is a
 * claim that something does not exist, and §14 is explicit that such a claim
 * is established by a documented search of the places it would be, or not at
 * all. Checking it here rather than at absorb time means the worker is told
 * while it still has the attempt to spend, which is §27's truncation lesson:
 * the one outcome a worker cannot recover from is the one reported as success.
 */
export function validatePuzzleFinding(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  format: unknown;
  value: unknown;
  basis: unknown;
  amountMinor: unknown;
  currency: unknown;
  observedOn: unknown;
  searchedRepositories?: unknown;
}): PuzzleCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const format = tidy(input.format);
  const value = tidy(input.value);
  const basis = tidy(input.basis);
  const observedOn = tidy(input.observedOn);

  if (absent(input.finding)) {
    /*
     * No finding means the claim says nothing about the puzzle trade, which is
     * most claims. Its companions must then be absent too: a value with no
     * finding is a field nothing will ever read, and storing it would look
     * like it had done something.
     */
    for (const [name, given] of [
      ['puzzle_subject', subject],
      ['puzzle_format', format],
      ['puzzle_value', value],
      ['puzzle_basis', basis],
      ['puzzle_currency', tidy(input.currency)],
      ['puzzle_observed_on', observedOn],
    ] as const) {
      if (given) {
        return {
          ok: false,
          error:
            `${where}: ${name} was given with no puzzle_finding. Say which kind of fact about ` +
            'the puzzle trade this establishes, or leave the field out.',
        };
      }
    }
    if (!absent(input.amountMinor)) {
      return {
        ok: false,
        error: `${where}: puzzle_amount_minor was given with no puzzle_finding.`,
      };
    }
    return { ok: true, value: ABSENT };
  }

  if (!isPuzzleFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: puzzle_finding must be one of ${PUZZLE_FINDINGS.join(', ')}, or omitted ` +
        'when the claim says nothing about the puzzle trade.',
    };
  }
  const finding = input.finding;

  if (!subject) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set puzzle_subject — ` +
        `${PUZZLE_FINDING_GUIDE[finding]}. It is the name of the thing, as the source writes ` +
        'it, not a sentence about it.',
    };
  }

  if (findingRequiresFormat(finding) && !format) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set puzzle_format — which puzzle format it is ` +
        'about. Where the assignment named a format, declare that format back verbatim, ' +
        'because two spellings of one format are two formats to Brain and the second one ' +
        'joins to nothing.',
    };
  }

  const vocabulary = valueVocabularyFor(finding);
  if (vocabulary) {
    if (!value) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding must set puzzle_value to one of ` +
          `${vocabulary.join(', ')}.`,
      };
    }
    if (!vocabulary.includes(value)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_value for a ${finding} finding must be one of ` +
          `${vocabulary.join(', ')}. "${value}" is not one of them — say which of those this ` +
          'is, and put the detail in the claim itself.',
      };
    }
  } else if (value) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding takes no puzzle_value. Putting one there would write ` +
        'a field nothing reads, which is worse than refusing it because it looks like it ' +
        'worked.',
    };
  }

  let amountMinor: number | null = null;
  if (!absent(input.amountMinor)) {
    if (typeof input.amountMinor !== 'number' || !Number.isInteger(input.amountMinor)) {
      return {
        ok: false,
        error: `${where}: puzzle_amount_minor must be a whole number of minor units.`,
      };
    }
    if (input.amountMinor < 0) {
      return { ok: false, error: `${where}: puzzle_amount_minor must not be negative.` };
    }
    if (!findingRequiresAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure. Only ECONOMIC_FIGURE does, ` +
          'because it names a line in an arithmetic.',
      };
    }
    amountMinor = input.amountMinor;
  } else if (findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: an ECONOMIC_FIGURE finding must set puzzle_amount_minor. A line with no ` +
        'figure makes a contribution reading look complete while contributing nothing to it, ' +
        'which is the one way this table can make a product look cheaper than it is.',
    };
  }

  /*
   * The currency travels with the figure, and the basis travels with both.
   *
   * Neither is taken from the sprint. A published print quote arrives in the
   * printer's currency and a platform fee in the platform's, so stamping them
   * with one would make the mixed-currency withholding unreachable — a
   * mechanism nothing calls, at the number that decides whether to print. And
   * a basis Brain supplied would be Brain deciding what somebody else's figure
   * was per.
   */
  const currencyRaw = tidy(input.currency).toUpperCase();
  let currency: string | null = null;
  if (currencyRaw) {
    if (!findingRequiresAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so puzzle_currency has nothing ` +
          'to describe.',
      };
    }
    if (!/^[A-Z]{3}$/.test(currencyRaw)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_currency must be a three-letter ISO 4217 code such as USD, GBP ` +
          `or EUR. "${currencyRaw}" is not one, and a currency Brain guessed at is a figure ` +
          'nobody can check.',
      };
    }
    currency = currencyRaw;
  } else if (findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: an ECONOMIC_FIGURE finding must set puzzle_currency. A figure with no ` +
        'currency is a number that can be added to the wrong things.',
    };
  }

  if (basis && !findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding carries no figure, so puzzle_basis has nothing to be ` +
        'the basis of.',
    };
  }
  if (!basis && findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: an ECONOMIC_FIGURE finding must set puzzle_basis — what the figure is ` +
        '*per*, in the source’s own words: one copy, one print run of 10,000, one month, ' +
        'one commission. A per-unit cost and a per-run setup cost cannot be added to each ' +
        'other, and a figure whose basis nobody stated is a number that can be added to the ' +
        'wrong things.',
    };
  }

  let observed: string | null = null;
  if (observedOn) {
    if (!OBSERVED_ON.test(observedOn)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_observed_on must be a date the source states — 2026-04-19, ` +
          '2026-04 or 2026. Report the granularity the source gives rather than inventing a ' +
          'precision it does not have.',
      };
    }
    observed = observedOn;
  } else if (findingRequiresObservedOn(finding)) {
    return {
      ok: false,
      error:
        `${where}: a BUYER_DEMAND finding must set puzzle_observed_on — when the source ` +
        'observed it. An undated buying signal cannot be told apart from one somebody ' +
        'remembers from years ago, and paid demand is the whole of what this kernel ranks on.',
    };
  }

  if (finding === 'DEMAND_ABSENCE') {
    const searched = Array.isArray(input.searchedRepositories)
      ? input.searchedRepositories.filter((one) => typeof one === 'string' && one.trim() !== '')
      : [];
    if (searched.length === 0) {
      return {
        ok: false,
        error:
          `${where}: a DEMAND_ABSENCE finding must name where you looked, in ` +
          'searched_repositories. "Nobody has looked" and "somebody looked and there is ' +
          'nothing" must never read the same, and only the search tells them apart.',
      };
    }
  }

  return {
    ok: true,
    value: {
      finding,
      subject,
      format: format || null,
      value: value || null,
      basis: basis || null,
      amountMinor,
      currency,
      observedOn: observed,
    },
  };
}
