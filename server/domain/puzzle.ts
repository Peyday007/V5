/**
 * What a puzzle finding means, where it lands, and the one validator both
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
 * A retail price is not receipts, and that distinction is a column
 * ---------------------------------------------------------------------------
 *
 * The one arithmetic this kernel most needs not to get wrong is what a puzzle
 * product earns. A book on a shelf at a dollar and a publisher's receipt from
 * that book are different numbers by a factor nobody can guess, and they look
 * identical in a claim sentence. So they are two components of a closed set
 * rather than one field a reader interprets, `directionFor` says which side of
 * the arithmetic each lands on, and `services/puzzle/economics.ts` refuses to
 * compute a contribution from a retail price at all — §30's rule that an
 * unknown is never a favourable assumption, at the figure that decides whether
 * a print run is worth doing.
 *
 * ---------------------------------------------------------------------------
 * The universe is seeded and never declared
 * ---------------------------------------------------------------------------
 *
 * There is no list of puzzle formats in this module and none anywhere else in
 * this kernel: a format exists because a gated claim named it or a person
 * seeded it. §38 settled that a hardcoded taxonomy answers the question the
 * kernel exists to ask and is wrong about everything the trade has taken up
 * since somebody typed it. What *is* in code is the registry of formats Brain
 * can actually generate and check — which is a fact about this repository
 * rather than about the world, and is read rather than declared.
 */
import {
  PUZZLE_COST_COMPONENTS,
  PUZZLE_DIFFICULTIES,
  PUZZLE_ECONOMIC_COMPONENTS,
  PUZZLE_FINDINGS,
  PUZZLE_OBSERVATION_KINDS,
  PUZZLE_PRODUCT_CLASSES,
  PUZZLE_REVENUE_COMPONENTS,
  PUZZLE_RIGHTS_CONSTRAINTS,
  PUZZLE_ROUND_PURPOSES,
  PUZZLE_ROUTE_KINDS,
  PUZZLE_SKU_DIMENSIONS,
  type PuzzleCostComponent,
  type PuzzleEconomicComponent,
  type PuzzleDifficulty,
  type PuzzleFinding,
  type PuzzleObservationKind,
  type PuzzleProductClass,
  type PuzzleRevenueComponent,
  type PuzzleRightsConstraint,
  type PuzzleRoundPurpose,
  type PuzzleRouteKind,
  type PuzzleSkuDimension,
} from './types.ts';

export {
  PUZZLE_COST_COMPONENTS,
  PUZZLE_ECONOMIC_COMPONENTS,
  PUZZLE_FINDINGS,
  PUZZLE_PRODUCT_CLASSES,
  PUZZLE_REVENUE_COMPONENTS,
  PUZZLE_RIGHTS_CONSTRAINTS,
  PUZZLE_SKU_DIMENSIONS,
};
export type {
  PuzzleCostComponent,
  PuzzleEconomicComponent,
  PuzzleFinding,
  PuzzleProductClass,
  PuzzleRevenueComponent,
  PuzzleRightsConstraint,
  PuzzleSkuDimension,
};

export function isPuzzleFinding(value: unknown): value is PuzzleFinding {
  return typeof value === 'string' && (PUZZLE_FINDINGS as readonly string[]).includes(value);
}

export function isPuzzleEconomicComponent(value: unknown): value is PuzzleEconomicComponent {
  return (
    typeof value === 'string' && (PUZZLE_ECONOMIC_COMPONENTS as readonly string[]).includes(value)
  );
}

export function isPuzzleProductClass(value: unknown): value is PuzzleProductClass {
  return typeof value === 'string' && (PUZZLE_PRODUCT_CLASSES as readonly string[]).includes(value);
}

export function isPuzzleRightsConstraint(value: unknown): value is PuzzleRightsConstraint {
  return (
    typeof value === 'string' && (PUZZLE_RIGHTS_CONSTRAINTS as readonly string[]).includes(value)
  );
}

export function isPuzzleRouteKind(value: unknown): value is PuzzleRouteKind {
  return typeof value === 'string' && (PUZZLE_ROUTE_KINDS as readonly string[]).includes(value);
}

export function isPuzzleRoundPurpose(value: unknown): value is PuzzleRoundPurpose {
  return typeof value === 'string' && (PUZZLE_ROUND_PURPOSES as readonly string[]).includes(value);
}

export function isPuzzleSkuDimension(value: unknown): value is PuzzleSkuDimension {
  return typeof value === 'string' && (PUZZLE_SKU_DIMENSIONS as readonly string[]).includes(value);
}

export function isPuzzleObservationKind(value: unknown): value is PuzzleObservationKind {
  return (
    typeof value === 'string' && (PUZZLE_OBSERVATION_KINDS as readonly string[]).includes(value)
  );
}

export function isPuzzleDifficulty(value: unknown): value is PuzzleDifficulty {
  return typeof value === 'string' && (PUZZLE_DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * The key two rows naming one format are matched on.
 *
 * Case, surrounding whitespace and internal runs of it, and nothing else — the
 * weakest matcher that could work, for `equipmentKey`'s reason. It does not
 * know that "word search" and "wordsearch" are one thing, and it must not
 * start guessing: §37 settled that a matcher which tried harder produces
 * confident wrong answers, and here an invented match would file demand for
 * one format against a generator that makes another.
 *
 * The formats converge instead by Brain naming one **verbatim from its own
 * rows** in the question it asks, which is a mechanism somebody can read
 * rather than a similarity threshold nobody can audit.
 */
export function formatKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The same normalization for an audience, a language or a channel name. */
export function labelKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * What each finding creates.
 *
 * A `Record` over the whole union rather than a `Set` of the ones that do, so
 * a finding added later is a compile error until somebody says where it lands.
 * §27 records what two `Set`s that must be total between them cost: a refusal
 * fell into the exhausting branch by default because neither named it.
 */
export type PuzzleFindingTarget = 'FORMAT' | 'DEMAND' | 'ROUTE' | 'ECONOMIC' | 'CONSTRAINT';

const TARGET: Readonly<Record<PuzzleFinding, PuzzleFindingTarget>> = Object.freeze({
  FORMAT_EVIDENCE: 'FORMAT',
  DEMAND_SIGNAL: 'DEMAND',
  CHANNEL: 'ROUTE',
  PRODUCTION_ROUTE: 'ROUTE',
  PRICE_POINT: 'ECONOMIC',
  PRODUCTION_COST: 'ECONOMIC',
  RIGHTS_CONSTRAINT: 'CONSTRAINT',
});

export function targetForFinding(finding: PuzzleFinding): PuzzleFindingTarget {
  return TARGET[finding];
}

/** Which kind of route a route finding writes, or null where it makes none. */
const ROUTE_KIND: Readonly<Record<PuzzleFinding, PuzzleRouteKind | null>> = Object.freeze({
  FORMAT_EVIDENCE: null,
  DEMAND_SIGNAL: null,
  CHANNEL: 'CHANNEL',
  PRODUCTION_ROUTE: 'PRODUCTION',
  PRICE_POINT: null,
  PRODUCTION_COST: null,
  RIGHTS_CONSTRAINT: null,
});

export function routeKindForFinding(finding: PuzzleFinding): PuzzleRouteKind | null {
  return ROUTE_KIND[finding];
}

/**
 * Which side of the arithmetic a component lands on.
 *
 * A `Record` over the whole union, because the two sets have to be total
 * between them and a component that belonged to neither would silently drop
 * out of both — which is the shape of error that makes a product look more
 * profitable than it is.
 */
export type EconomicDirection = 'REVENUE' | 'COST';

const DIRECTION: Readonly<Record<PuzzleEconomicComponent, EconomicDirection>> = Object.freeze({
  NET_RECEIPT_PER_UNIT: 'REVENUE',
  RETAIL_PRICE: 'REVENUE',
  LICENSE_FEE: 'REVENUE',
  SYNDICATION_RATE: 'REVENUE',
  SUBSCRIPTION_PRICE: 'REVENUE',
  CUSTOM_WORK_FEE: 'REVENUE',
  EDITORIAL_COST: 'COST',
  SETUP_COST: 'COST',
  UNIT_PRINT_COST: 'COST',
  PACKAGING_COST: 'COST',
  FREIGHT_PER_UNIT: 'COST',
  FULFILMENT_PER_UNIT: 'COST',
  CHANNEL_FEE: 'COST',
  RETURNS_ALLOWANCE: 'COST',
  PLATFORM_FEE: 'COST',
  RIGHTS_COST: 'COST',
});

export function directionFor(component: PuzzleEconomicComponent): EconomicDirection {
  return DIRECTION[component];
}

/**
 * Whether a component is a **per-unit** figure or a figure for a whole run.
 *
 * The distinction the "hundred puzzles for a dollar" question turns on. A
 * setup cost is spent once however many units come off it, and a print cost is
 * spent per unit — so adding them without saying which is which produces a
 * number that is wrong by the size of the run. `services/puzzle/economics.ts`
 * keeps them in separate accumulators for exactly that reason, and a component
 * added here with the wrong answer would make a run look cheaper the larger it
 * got.
 */
export type EconomicBasis = 'PER_UNIT' | 'PER_RUN';

const BASIS: Readonly<Record<PuzzleEconomicComponent, EconomicBasis>> = Object.freeze({
  NET_RECEIPT_PER_UNIT: 'PER_UNIT',
  RETAIL_PRICE: 'PER_UNIT',
  LICENSE_FEE: 'PER_RUN',
  SYNDICATION_RATE: 'PER_UNIT',
  SUBSCRIPTION_PRICE: 'PER_UNIT',
  CUSTOM_WORK_FEE: 'PER_RUN',
  EDITORIAL_COST: 'PER_RUN',
  SETUP_COST: 'PER_RUN',
  UNIT_PRINT_COST: 'PER_UNIT',
  PACKAGING_COST: 'PER_UNIT',
  FREIGHT_PER_UNIT: 'PER_UNIT',
  FULFILMENT_PER_UNIT: 'PER_UNIT',
  CHANNEL_FEE: 'PER_UNIT',
  RETURNS_ALLOWANCE: 'PER_UNIT',
  PLATFORM_FEE: 'PER_UNIT',
  RIGHTS_COST: 'PER_RUN',
});

export function basisFor(component: PuzzleEconomicComponent): EconomicBasis {
  return BASIS[component];
}

/**
 * Which cost lines a product class cannot be costed without.
 *
 * Per class rather than one global list, because the same omission means
 * different things: a downloadable PDF with no freight figure is complete, and
 * a boxed puzzle with no freight figure is a product whose largest variable
 * cost nobody has established. A global list would either withhold every
 * digital contribution for want of a shipping rate, or let a physical one
 * through with its shipping missing — and the second reads as a bargain.
 *
 * `RETAIL_PRICE` is deliberately absent from every list. It is not a cost, and
 * it is not receipts either: a class whose only revenue figure is a shelf
 * price has its contribution withheld naming that, rather than computed from a
 * number the publisher never sees.
 */
const LOAD_BEARING: Readonly<Record<PuzzleProductClass, readonly PuzzleCostComponent[]>> =
  Object.freeze({
    DIGITAL_DOWNLOAD: Object.freeze(['CHANNEL_FEE'] as const),
    INTERACTIVE: Object.freeze(['PLATFORM_FEE'] as const),
    RECURRING_FEED: Object.freeze(['EDITORIAL_COST'] as const),
    LICENSE: Object.freeze([] as const),
    PRINT_BOOK: Object.freeze([
      'UNIT_PRINT_COST',
      'FREIGHT_PER_UNIT',
      'CHANNEL_FEE',
      'RETURNS_ALLOWANCE',
    ] as const),
    CARD_OR_BOXED: Object.freeze([
      'UNIT_PRINT_COST',
      'PACKAGING_COST',
      'FREIGHT_PER_UNIT',
      'CHANNEL_FEE',
      'RETURNS_ALLOWANCE',
    ] as const),
    SERVICE: Object.freeze(['EDITORIAL_COST'] as const),
  });

export function loadBearingFor(
  productClass: PuzzleProductClass,
): readonly PuzzleCostComponent[] {
  return LOAD_BEARING[productClass];
}

/** Whether a product class is made of atoms, which is what sends it to §39. */
const PHYSICAL: Readonly<Record<PuzzleProductClass, boolean>> = Object.freeze({
  DIGITAL_DOWNLOAD: false,
  INTERACTIVE: false,
  RECURRING_FEED: false,
  LICENSE: false,
  PRINT_BOOK: true,
  CARD_OR_BOXED: true,
  SERVICE: false,
});

export function isPhysical(productClass: PuzzleProductClass): boolean {
  return PHYSICAL[productClass];
}

/**
 * Which closed set a finding's `puzzle_value` must come from, or null where
 * the finding carries no value at all.
 *
 * `PRICE_POINT` and `PRODUCTION_COST` take **disjoint** halves of one column's
 * vocabulary, deliberately. A worker that declared a print cost as a price
 * point would put a cost into the revenue accumulator, which is the one
 * mistake here that makes a product look profitable rather than merely
 * unknown — and reading the sentence to work out which it meant would be the
 * prose-parsing §25's Westbrook defect records.
 */
export function valueVocabularyFor(finding: PuzzleFinding): readonly string[] | null {
  if (finding === 'PRICE_POINT') return PUZZLE_REVENUE_COMPONENTS;
  if (finding === 'PRODUCTION_COST') return PUZZLE_COST_COMPONENTS;
  if (finding === 'RIGHTS_CONSTRAINT') return PUZZLE_RIGHTS_CONSTRAINTS;
  return null;
}

/** Whether a finding must name the format it is about. */
export function findingRequiresFormat(finding: PuzzleFinding): boolean {
  /*
   * A rights constraint need not: a marketplace rule about what may be listed,
   * or a safety standard for children's products, applies across formats and
   * filing it under one would hide it from the others. Everything else is
   * about a format — a buyer buys crosswords rather than puzzles in general,
   * and a print cost is per page count and trim rather than per idea.
   */
  return finding !== 'RIGHTS_CONSTRAINT';
}

/** Whether a finding must carry a figure. Only the two that name one do. */
export function findingRequiresAmount(finding: PuzzleFinding): boolean {
  return finding === 'PRICE_POINT' || finding === 'PRODUCTION_COST';
}

/**
 * Whether a finding must name the product class it is about.
 *
 * Both economic findings, and nothing else. A figure with no class attached
 * cannot be judged against `loadBearingFor`, so it would sit in the table
 * contributing to no arithmetic at all — present, plausible and unreadable,
 * which is worse than absent.
 */
export function findingRequiresProductClass(finding: PuzzleFinding): boolean {
  return findingRequiresAmount(finding);
}

/** One line per finding, for the tool description that asks a worker to choose. */
export const PUZZLE_FINDING_GUIDE: Readonly<Record<PuzzleFinding, string>> = Object.freeze({
  FORMAT_EVIDENCE:
    'a kind of puzzle that exists as a commercial product — name it as the trade names it, ' +
    'and say in the claim who publishes or sells it',
  DEMAND_SIGNAL:
    'a named organisation or publication that has published a need for puzzle content or ' +
    'puzzle products — a syndication call, a submission guideline, a tender, a job or ' +
    'commission posting, a stated gap, or a buyer saying what it pays for',
  CHANNEL:
    'a published route by which puzzle products actually reach buyers — a marketplace, a ' +
    'syndicate, a distributor, a retailer programme — with its terms in the claim itself',
  PRODUCTION_ROUTE:
    'a named supplier that actually produces puzzle products — a printer, a print-on-demand ' +
    'service, a board or card manufacturer, a fulfilment house — with what it will make and ' +
    'its stated minimum',
  PRICE_POINT:
    'a published figure for what somebody is PAID. puzzle_value says which kind, and the ' +
    'difference between NET_RECEIPT_PER_UNIT and RETAIL_PRICE is the whole of this kernel’s ' +
    'arithmetic: a shelf price is not receipts and is never treated as any',
  PRODUCTION_COST:
    'a published figure for one line of what producing or delivering it costs, with ' +
    'puzzle_value naming the line',
  RIGHTS_CONSTRAINT:
    'a published rule that bears on what may lawfully be made, listed or sold — a copyright ' +
    'or trademark position, a marketplace rule, a safety standard, an accessibility ' +
    'requirement, or a rights term a buyer imposes',
});

export interface PuzzleDeclaration {
  finding: PuzzleFinding | null;
  subject: string | null;
  format: string | null;
  productClass: PuzzleProductClass | null;
  value: string | null;
  amountCents: number | null;
  currency: string | null;
}

export type PuzzleCheck =
  | { ok: true; value: PuzzleDeclaration }
  | { ok: false; error: string };

const ABSENT: PuzzleDeclaration = Object.freeze({
  finding: null,
  subject: null,
  format: null,
  productClass: null,
  value: null,
  amountCents: null,
  currency: null,
});

/**
 * Validate one claim's puzzle declaration.
 *
 * Called by the MCP tool and by the provider-path parser, and by nothing else.
 * A second copy of the *rule* is how two doors come to disagree about what a
 * valid declaration is, which this repository has now had to record six times.
 *
 * Every failure refuses the submission rather than dropping the field. §27's
 * truncation lesson is the reason: the one outcome a worker cannot recover
 * from is the one delivered as success, and a silently dropped declaration is
 * exactly that — the claim is stored, the round settles, and the map stays
 * empty with nothing anywhere saying why.
 */
export function validatePuzzleFinding(input: {
  where: string;
  finding: unknown;
  subject: unknown;
  format: unknown;
  productClass: unknown;
  value: unknown;
  amountCents: unknown;
  currency: unknown;
}): PuzzleCheck {
  const { where } = input;
  const absent = (value: unknown) => value === undefined || value === null || value === '';
  const tidy = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  const subject = tidy(input.subject);
  const format = tidy(input.format);
  const productClass = tidy(input.productClass);
  const value = tidy(input.value);

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
      ['puzzle_product_class', productClass],
      ['puzzle_value', value],
      ['puzzle_currency', tidy(input.currency)],
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
    if (!absent(input.amountCents)) {
      return { ok: false, error: `${where}: puzzle_amount_cents was given with no puzzle_finding.` };
    }
    return { ok: true, value: ABSENT };
  }

  if (!isPuzzleFinding(input.finding)) {
    return {
      ok: false,
      error:
        `${where}: puzzle_finding must be one of ${PUZZLE_FINDINGS.join(', ')}, or omitted when ` +
        'the claim says nothing about the puzzle trade.',
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
        `${where}: a ${finding} finding must set puzzle_format — which kind of puzzle it is ` +
        'about. Where the assignment named a format, declare that format back verbatim, ' +
        'because two spellings of one format are two formats to Brain and will join nothing.',
    };
  }
  if (!findingRequiresFormat(finding) && format) {
    return {
      ok: false,
      error:
        `${where}: a RIGHTS_CONSTRAINT applies across formats, so puzzle_format must be left ` +
        'out. Filing it under one format would hide it from every other.',
    };
  }

  let resolvedClass: PuzzleProductClass | null = null;
  if (productClass) {
    if (!isPuzzleProductClass(productClass)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_product_class must be one of ${PUZZLE_PRODUCT_CLASSES.join(', ')}. ` +
          `"${productClass}" is not one of them.`,
      };
    }
    if (!findingRequiresProductClass(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding takes no puzzle_product_class. Only a figure needs ` +
          'one, because only a figure is judged against what that class cannot be costed ' +
          'without.',
      };
    }
    resolvedClass = productClass;
  } else if (findingRequiresProductClass(finding)) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set puzzle_product_class to one of ` +
        `${PUZZLE_PRODUCT_CLASSES.join(', ')}. A figure with no class attached contributes to ` +
        'no arithmetic at all, because what a class cannot be costed without is what decides ' +
        'whether the total may be reported.',
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
      /*
       * Naming the *other* half by name rather than only the half that is
       * accepted. A worker that declared a print cost as a PRICE_POINT has
       * made a real mistake with a real remedy, and a refusal that recited
       * only the revenue components would leave them guessing at which of two
       * findings was wrong.
       */
      const other = valueVocabularyFor(finding === 'PRICE_POINT' ? 'PRODUCTION_COST' : 'PRICE_POINT');
      const hint =
        (finding === 'PRICE_POINT' || finding === 'PRODUCTION_COST') &&
        other &&
        other.includes(value)
          ? ` "${value}" belongs to the other kind of figure: use ` +
            `${finding === 'PRICE_POINT' ? 'PRODUCTION_COST' : 'PRICE_POINT'} for it. A cost ` +
            'declared as revenue is the one error here that makes a product look profitable.'
          : '';
      return {
        ok: false,
        error:
          `${where}: puzzle_value for a ${finding} finding must be one of ` +
          `${vocabulary.join(', ')}.${hint || ` "${value}" is not one of them — say which of ` +
            'those this is, and put the detail in the claim itself.'}`,
      };
    }
  } else if (value) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding takes no puzzle_value. Putting one there would write a ` +
        'field nothing reads, which is worse than refusing it because it looks like it worked.',
    };
  }

  let amountCents: number | null = null;
  if (!absent(input.amountCents)) {
    if (typeof input.amountCents !== 'number' || !Number.isInteger(input.amountCents)) {
      return { ok: false, error: `${where}: puzzle_amount_cents must be a whole number of cents.` };
    }
    if (input.amountCents < 0) {
      return { ok: false, error: `${where}: puzzle_amount_cents must not be negative.` };
    }
    if (!findingRequiresAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure. Only PRICE_POINT and ` +
          'PRODUCTION_COST do, because only they name a line in an arithmetic.',
      };
    }
    amountCents = input.amountCents;
  } else if (findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set puzzle_amount_cents. A line with no figure ` +
        'makes the economics look complete while contributing nothing to them, which is the ' +
        'one way this table can make a product look cheaper than it is. A published zero is a ' +
        'figure and is declared as 0.',
    };
  }

  const currencyRaw = tidy(input.currency).toUpperCase();
  let currency: string | null = null;
  if (currencyRaw) {
    if (!findingRequiresAmount(finding)) {
      return {
        ok: false,
        error:
          `${where}: a ${finding} finding carries no figure, so puzzle_currency has nothing to ` +
          'describe.',
      };
    }
    if (!/^[A-Z]{3}$/.test(currencyRaw)) {
      return {
        ok: false,
        error:
          `${where}: puzzle_currency must be a three-letter ISO 4217 code such as USD, GBP or ` +
          `EUR. "${currencyRaw}" is not one, and a currency Brain guessed at is a figure ` +
          'nobody can check.',
      };
    }
    currency = currencyRaw;
  } else if (findingRequiresAmount(finding)) {
    return {
      ok: false,
      error:
        `${where}: a ${finding} finding must set puzzle_currency. A figure with no currency is ` +
        'a number that can be added to the wrong things, and Brain never converts one.',
    };
  }

  return {
    ok: true,
    value: {
      finding,
      subject,
      format: format || null,
      productClass: resolvedClass,
      value: value || null,
      amountCents,
      currency,
    },
  };
}
