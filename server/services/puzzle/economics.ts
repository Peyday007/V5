/**
 * What a puzzle product earns, and every reason that number is withheld.
 *
 * ---------------------------------------------------------------------------
 * A shelf price is not receipts, and this module will not pretend otherwise
 * ---------------------------------------------------------------------------
 *
 * The operator's brief asks a specific question — how does a hundred-puzzle
 * book at a dollar work — and the single most likely way to answer it wrongly
 * is to start from the dollar. A dollar is what a shopper pays. What reaches
 * the publisher is that less the retailer's share, less the distributor's,
 * less returns and markdowns, and it is a fraction nobody can derive from the
 * outside.
 *
 * So `RETAIL_PRICE` and `NET_RECEIPT_PER_UNIT` are two components of a closed
 * vocabulary, and **a contribution is never computed from the first**. A
 * product class with a shelf price and no receipts figure reports its
 * contribution as withheld, naming exactly that. It is the same shape as §45's
 * landed cost and §30's margin: the failure is stated rather than estimated,
 * because the estimate would be wrong in the direction that makes something
 * look worth doing.
 *
 * ---------------------------------------------------------------------------
 * Per unit and per run are separate accumulators
 * ---------------------------------------------------------------------------
 *
 * A print setup is spent once however many books come off it; a print cost is
 * spent per book. Adding them produces a number wrong by the size of the run,
 * and wrong in the direction that makes a big run look cheaper than a small
 * one for the wrong reason. `basisFor` decides which is which by lookup, the
 * two totals are kept apart, and the per-run total becomes a **breakeven** —
 * how many have to sell before the setup is paid for — which is the question
 * anybody deciding on a print run is actually asking.
 *
 * ---------------------------------------------------------------------------
 * The conservative end, and it says so
 * ---------------------------------------------------------------------------
 *
 * Two printers quoting different unit costs is a range, and §45 settled that
 * averaging them produces a number neither published. The contribution is
 * computed from the *worst* published end — the highest cost and the lowest
 * receipt — and the range is reported beside it, so a figure that looks thin
 * can be read against the better end rather than being quietly improved into
 * it.
 */
import { basisFor, directionFor, loadBearingFor } from '../../domain/puzzle.ts';
import type {
  PuzzleCostComponent,
  PuzzleEconomic,
  PuzzleEconomicComponent,
  PuzzleProductClass,
} from '../../domain/types.ts';

export interface Line {
  component: PuzzleEconomicComponent;
  lowCents: number;
  highCents: number;
  currency: string;
  sources: number;
  basisNotes: string[];
}

export interface UnitEconomics {
  formatKey: string;
  productClass: PuzzleProductClass;
  /** The one currency every load-bearing line is in, or null where they differ. */
  currency: string | null;
  lines: Line[];
  /** What the publisher receives per unit, at the lowest published end. */
  receiptsPerUnitCents: number | null;
  /** What a shopper pays, reported and never used in any arithmetic. */
  retailPriceCents: number | null;
  /** Everything spent per unit, at the highest published end. */
  perUnitCostCents: number | null;
  /** Everything spent once per run, at the highest published end. */
  perRunCostCents: number | null;
  /** Receipts less per-unit cost, or null with `withheld` saying why. */
  contributionPerUnitCents: number | null;
  /** How many must sell before the per-run cost is covered. */
  breakevenUnits: number | null;
  /** Exactly what is missing, in the words somebody would act on. */
  withheld: string | null;
}

/**
 * Read the economics of every (format, product class) somebody has published a
 * figure about.
 *
 * Grouped by both, because neither alone decides the arithmetic: a crossword
 * and a word search cost the same to print and are paid completely differently
 * to syndicate, and a book and a download of the same puzzles share nothing
 * but the puzzles.
 */
export function readEconomics(rows: readonly PuzzleEconomic[]): UnitEconomics[] {
  const groups = new Map<string, PuzzleEconomic[]>();
  for (const row of rows) {
    const key = `${row.formatKey}\u0000${row.productClass}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: UnitEconomics[] = [];
  for (const [key, group] of groups) {
    const [formatKey = '', productClass = 'DIGITAL_DOWNLOAD'] = key.split('\u0000') as [
      string,
      PuzzleProductClass,
    ];
    out.push(readOne(formatKey, productClass, group));
  }
  return out.sort((a, b) => a.formatKey.localeCompare(b.formatKey));
}

export function readOne(
  formatKey: string,
  productClass: PuzzleProductClass,
  rows: readonly PuzzleEconomic[],
): UnitEconomics {
  const byComponent = new Map<PuzzleEconomicComponent, PuzzleEconomic[]>();
  for (const row of rows) {
    byComponent.set(row.component, [...(byComponent.get(row.component) ?? []), row]);
  }

  const lines: Line[] = [];
  for (const [component, group] of byComponent) {
    const amounts = group.map((one) => one.amountCents);
    const currencies = [...new Set(group.map((one) => one.currency))];
    lines.push({
      component,
      lowCents: Math.min(...amounts),
      highCents: Math.max(...amounts),
      /*
       * One line in two currencies is reported at the first and caught by the
       * group-level check below, rather than being silently reconciled.
       */
      currency: currencies[0] ?? 'USD',
      sources: group.length,
      basisNotes: [...new Set(group.map((one) => one.basisNote))],
    });
  }
  lines.sort((a, b) => a.component.localeCompare(b.component));

  const base: UnitEconomics = {
    formatKey,
    productClass,
    currency: null,
    lines,
    receiptsPerUnitCents: null,
    retailPriceCents: null,
    perUnitCostCents: null,
    perRunCostCents: null,
    contributionPerUnitCents: null,
    breakevenUnits: null,
    withheld: null,
  };

  const retail = byComponent.get('RETAIL_PRICE');
  if (retail && retail.length > 0) {
    base.retailPriceCents = Math.min(...retail.map((one) => one.amountCents));
  }

  /*
   * One currency, or nothing. Checked across every row rather than only the
   * load-bearing ones: a freight figure in another currency is still a
   * component of this class's cost, and reporting a total that quietly left
   * it out would be worse than reporting none.
   */
  const currencies = [...new Set(rows.map((one) => one.currency))];
  if (currencies.length > 1) {
    base.withheld =
      `The figures for this are published in ${currencies.join(' and ')}. Brain never converts ` +
      'between currencies, because a rate is a fact about a day nobody recorded — so the ' +
      'contribution is withheld rather than computed through an exchange rate nobody published.';
    return base;
  }
  base.currency = currencies[0] ?? null;

  const receipts = byComponent.get('NET_RECEIPT_PER_UNIT');
  if (!receipts || receipts.length === 0) {
    base.withheld =
      base.retailPriceCents === null
        ? 'Nothing establishes what this is paid. A contribution needs a receipt figure — what ' +
          'the publisher actually gets per unit — and no source has supplied one.'
        : 'The only revenue figure here is a retail price, which is what a shopper pays rather ' +
          'than what the publisher receives. Those differ by the retailer’s share, the ' +
          'distributor’s, returns and markdowns, and the difference is most of the margin. ' +
          'The contribution is withheld until a source states net receipts per unit.';
    return base;
  }
  /* The lowest published receipt: the end this operation could least defend. */
  base.receiptsPerUnitCents = Math.min(...receipts.map((one) => one.amountCents));

  const required = loadBearingFor(productClass);
  const missing: PuzzleCostComponent[] = required.filter(
    (component) => !byComponent.has(component),
  );
  if (missing.length > 0) {
    base.withheld =
      `A ${describeClass(productClass)} cannot be costed without ${missing.join(', ')}, and no ` +
      'source has published ' +
      (missing.length === 1 ? 'it' : 'them') +
      '. A total that stepped over a missing line would be smaller than anything published ' +
      'says, which reads as a bargain rather than as a mistake.';
    return base;
  }

  let perUnit = 0;
  let perRun = 0;
  for (const line of lines) {
    if (directionFor(line.component) !== 'COST') continue;
    /* The highest published end, for the reason in the header. */
    if (basisFor(line.component) === 'PER_UNIT') perUnit += line.highCents;
    else perRun += line.highCents;
  }
  base.perUnitCostCents = perUnit;
  base.perRunCostCents = perRun;
  base.contributionPerUnitCents = base.receiptsPerUnitCents - perUnit;

  if (base.contributionPerUnitCents > 0 && perRun > 0) {
    base.breakevenUnits = Math.ceil(perRun / base.contributionPerUnitCents);
  } else if (base.contributionPerUnitCents <= 0) {
    /*
     * Not a withholding — the number is established and it is negative, which
     * is a finding rather than a gap. §30's rule: a negative margin is a
     * reason to decline rather than a reason to raise the price, and it says
     * so where somebody reads it.
     */
    base.breakevenUnits = null;
  }
  return base;
}

function describeClass(productClass: PuzzleProductClass): string {
  switch (productClass) {
    case 'PRINT_BOOK':
      return 'printed book';
    case 'CARD_OR_BOXED':
      return 'boxed or card product';
    case 'DIGITAL_DOWNLOAD':
      return 'downloadable product';
    case 'INTERACTIVE':
      return 'interactive product';
    case 'RECURRING_FEED':
      return 'recurring feed';
    case 'LICENSE':
      return 'licence';
    case 'SERVICE':
      return 'commissioned service';
    default:
      return 'product';
  }
}

/**
 * The hundred-puzzles-for-a-dollar question, answered from rows or not at all.
 *
 * The brief asks for this specific chain to be reverse-engineered, and the
 * honest answer today is a list of what is established and what is not. It is
 * its own function rather than a comment on the general reading because the
 * question is asked by name, and somebody asking it deserves to be told which
 * of the eleven things it turns on Brain actually holds — rather than a
 * plausible chain with three guesses in the middle.
 *
 * What it will **not** do is treat the dollar as revenue. That single move is
 * how the whole question gets answered wrongly, and it is the reason the
 * reading exists.
 */
export function dollarBookReading(rows: readonly PuzzleEconomic[]): {
  established: string[];
  missing: string[];
  verdict: string;
} {
  const books = rows.filter((one) => one.productClass === 'PRINT_BOOK');
  const have = new Set(books.map((one) => one.component));
  const wanted: readonly { component: PuzzleEconomicComponent; asks: string }[] = [
    { component: 'RETAIL_PRICE', asks: 'what the book sells for' },
    { component: 'NET_RECEIPT_PER_UNIT', asks: 'what the publisher actually receives from it' },
    { component: 'UNIT_PRINT_COST', asks: 'what one copy costs to print at that page count' },
    { component: 'SETUP_COST', asks: 'prepress and plates, spent once per run' },
    { component: 'EDITORIAL_COST', asks: 'what the puzzles inside cost to make' },
    { component: 'FREIGHT_PER_UNIT', asks: 'freight, which for a dense low-value book is not small' },
    { component: 'CHANNEL_FEE', asks: 'the retailer and distributor share' },
    { component: 'RETURNS_ALLOWANCE', asks: 'returns and markdowns' },
  ];

  const established = wanted
    .filter((one) => have.has(one.component))
    .map((one) => `${one.component}: ${one.asks}`);
  const missing = wanted
    .filter((one) => !have.has(one.component))
    .map((one) => `${one.component}: ${one.asks}`);

  const reading = readEconomics(books.length > 0 ? books : []).find(
    (one) => one.productClass === 'PRINT_BOOK',
  );

  const verdict =
    books.length === 0
      ? 'Nothing has been established about printed puzzle books at all. This is a research ' +
        'question with a named shape, not a thing Brain can reason its way to: the chain runs ' +
        'from a shelf price through a retailer share, a distributor share, returns and freight ' +
        'to a receipt, and every one of those is a published figure somebody has to find.'
      : reading?.contributionPerUnitCents !== null && reading?.contributionPerUnitCents !== undefined
        ? `Contribution per copy sold is ${reading.contributionPerUnitCents} ${reading.currency ?? ''}` +
          (reading.breakevenUnits !== null
            ? `, and ${reading.breakevenUnits} copies cover the setup.`
            : reading.contributionPerUnitCents <= 0
              ? ', which is negative: at these published figures the book loses money per copy, ' +
                'and that is a reason to decline rather than a reason to raise the price.'
              : '.')
        : (reading?.withheld ??
          'The figures so far do not settle it, and what is missing is named above.');

  return { established, missing, verdict };
}
