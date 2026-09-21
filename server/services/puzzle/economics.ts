/**
 * What a route pays, what it costs, and every reason a total is withheld.
 *
 * ---------------------------------------------------------------------------
 * The withholding is the feature
 * ---------------------------------------------------------------------------
 *
 * A total that steps over a missing printing cost is **smaller** than anything
 * published says, which makes a product look cheaper to make than it is — and
 * too low at the number that decides whether to print reads as a bargain
 * rather than as a mistake. §30 records `conservativeContribution` making
 * exactly that error, and §39 and §45 both had to write the same rule at their
 * own capital readings.
 *
 * So there are four named reasons a contribution is withheld, and each is
 * reported rather than silently producing a smaller number:
 *
 * - a **load-bearing line is missing** for this production class;
 * - the figures are in **two currencies**, and Brain never converts, because a
 *   rate is a fact about a day nobody recorded;
 * - the per-unit figures are on **two bases**, and a per-copy cost cannot be
 *   added to a per-thousand rate without a load plan Brain does not have;
 * - there is **no revenue line at all**, so there is nothing for a cost to be
 *   subtracted from.
 *
 * ---------------------------------------------------------------------------
 * Setup and per-unit are kept apart, because the directive's own arithmetic
 * needs them apart
 * ---------------------------------------------------------------------------
 *
 * `breakeven units = fixed setup cost ÷ contribution per sold unit` is
 * nonsense if a per-unit printing cost has been counted as a setup. Which side
 * a component is on is `isSetupCost`, a lookup in `domain/puzzle.ts`, rather
 * than a reading of the basis string a worker typed.
 */
import { isSetupCost, loadBearingFor, sideFor } from '../../domain/puzzle.ts';
import type { PuzzleSnapshot } from './graph.ts';
import type {
  EconomicComponent,
  ProductionClass,
  ProductionStage,
  PuzzleEconomicLine,
} from '../../domain/types.ts';

/** Why a figure is not being shown. Never a silence, and never a smaller number. */
export type WithheldReason =
  | 'NO_REVENUE_LINE'
  | 'MISSING_LOAD_BEARING_COST'
  | 'MIXED_CURRENCY'
  | 'MIXED_BASIS';

export interface ContributionReading {
  routeId: string | null;
  routeName: string | null;
  productionClass: ProductionClass;

  /** Per-unit revenue, per-unit cost and the difference — or null with a reason. */
  perUnitRevenueMinor: number | null;
  perUnitCostMinor: number | null;
  contributionPerUnitMinor: number | null;

  /** One-off costs, kept apart so breakeven means something. */
  setupCostMinor: number | null;

  /** setupCost ÷ contributionPerUnit, where both are known. */
  breakevenUnits: number | null;

  currency: string | null;
  /** The basis every per-unit figure shares, where they share one. */
  basis: string | null;

  withheld: WithheldReason | null;
  /** The server's own sentence. A screen renders it and writes none of its own. */
  why: string;

  /** Load-bearing components for this class that nothing has priced. */
  missing: EconomicComponent[];
  lines: number;
}

const normalizeBasis = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Read the economics for one route and one production class.
 *
 * The production class is the caller's, because the same route sells different
 * things: what a digital download costs to make and what a jigsaw costs to
 * make share a channel and share almost nothing else, and `loadBearingFor` is
 * the whole reason that distinction is on the reading rather than folded away.
 */
export function readContribution(input: {
  lines: readonly PuzzleEconomicLine[];
  routeId: string | null;
  routeName: string | null;
  productionClass: ProductionClass;
}): ContributionReading {
  const { lines, routeId, routeName, productionClass } = input;
  const required = loadBearingFor(productionClass);

  const base = {
    routeId,
    routeName,
    productionClass,
    perUnitRevenueMinor: null,
    perUnitCostMinor: null,
    contributionPerUnitMinor: null,
    setupCostMinor: null,
    breakevenUnits: null,
    currency: null,
    basis: null,
    lines: lines.length,
  };

  const present = new Set(lines.map((one) => one.component));
  const missing = required.filter((component) => !present.has(component));

  const revenue = lines.filter((one) => sideFor(one.component) === 'REVENUE');
  if (revenue.length === 0) {
    return {
      ...base,
      withheld: 'NO_REVENUE_LINE',
      why:
        'Nothing published says what this pays, so there is nothing for a cost to be ' +
        'subtracted from.',
      missing,
    };
  }

  const currencies = [...new Set(lines.map((one) => one.currency))];
  if (currencies.length > 1) {
    return {
      ...base,
      withheld: 'MIXED_CURRENCY',
      why:
        `The figures are published in ${currencies.join(' and ')}. Brain never converts between ` +
        'currencies, because a rate is a fact about a day nobody recorded — so a total here ' +
        'would be a number nobody can check.',
      missing,
    };
  }
  const currency = currencies[0] ?? null;

  if (missing.length > 0) {
    return {
      ...base,
      currency,
      withheld: 'MISSING_LOAD_BEARING_COST',
      why:
        `Nothing prices ${missing.join(', ').toLowerCase().replace(/_/g, ' ')} for a ` +
        `${productionClass.toLowerCase().replace(/_/g, ' ')}. A total that stepped over ` +
        `${missing.length === 1 ? 'it' : 'them'} would be smaller than anything published says, ` +
        'which makes this look cheaper to make than it is.',
      missing,
    };
  }

  const perUnit = lines.filter((one) => !isSetupCost(one.component));
  const bases = [...new Set(perUnit.map((one) => normalizeBasis(one.basis)))];
  if (bases.length > 1) {
    return {
      ...base,
      currency,
      withheld: 'MIXED_BASIS',
      why:
        `The per-unit figures are published per ${bases.join(' and per ')}. Reconciling them ` +
        'needs a load plan or a run size nobody has recorded, and adding them as though they ' +
        'were the same thing is how a figure comes out wrong in the direction nobody checks.',
      missing,
    };
  }
  const basis = bases[0] ?? null;

  const perUnitRevenue = perUnit
    .filter((one) => sideFor(one.component) === 'REVENUE')
    .reduce((sum, one) => sum + one.amountMinor, 0);
  const perUnitCost = perUnit
    .filter((one) => sideFor(one.component) === 'COST')
    .reduce((sum, one) => sum + one.amountMinor, 0);
  const setup = lines
    .filter((one) => isSetupCost(one.component))
    .reduce((sum, one) => sum + one.amountMinor, 0);

  const contribution = perUnitRevenue - perUnitCost;

  return {
    ...base,
    perUnitRevenueMinor: perUnitRevenue,
    perUnitCostMinor: perUnitCost,
    contributionPerUnitMinor: contribution,
    setupCostMinor: setup,
    /*
     * Breakeven only where the contribution is positive. A negative one has no
     * breakeven — no quantity recovers the setup — and reporting a negative
     * unit count would be arithmetic pretending to be an answer. The directive
     * is explicit that a negative margin is a reason to decline rather than a
     * reason to raise the price, and the reading says so.
     */
    breakevenUnits: contribution > 0 ? Math.ceil(setup / contribution) : null,
    currency,
    basis,
    withheld: null,
    why:
      contribution > 0
        ? `Every load-bearing line is priced in ${currency} per ${basis}.`
        : `Every load-bearing line is priced, and the per-unit cost is at or above what it ` +
          'pays. No quantity recovers the setup, so this is a reason to decline rather than a ' +
          'reason to raise the price.',
    missing,
  };
}

/** One reading per route, over whatever production class its outputs actually use. */
export function readRouteEconomics(snapshot: PuzzleSnapshot): ContributionReading[] {
  const out: ContributionReading[] = [];
  for (const route of snapshot.routes) {
    const lines = snapshot.economics.filter((one) => one.routeId === route.id);
    if (lines.length === 0) continue;
    /*
     * The class the outputs on this route are actually in. With none, DIGITAL_ONLY
     * is the assumption that demands the *fewest* cost lines — so it is the one
     * most likely to produce a total, which is exactly why the reading names it:
     * a reader must be able to see that the arithmetic assumed nothing was
     * printed.
     */
    const classes = [
      ...new Set(
        snapshot.outputs.filter((one) => one.routeId === route.id).map((one) => one.productionClass),
      ),
    ];
    for (const productionClass of classes.length > 0 ? classes : (['DIGITAL_ONLY'] as const)) {
      out.push(
        readContribution({
          lines,
          routeId: route.id,
          routeName: route.name,
          productionClass,
        }),
      );
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * The physical production ladder
 * ------------------------------------------------------------------------ */

export interface ProductionReading {
  stage: ProductionStage;
  why: string;
  /** What would move it up one rung. Never null: the top rung is not reachable here. */
  nextQuestion: string;
  /** Production classes this operation has actually compiled something in. */
  classesInUse: ProductionClass[];
  /** Named plainly, because every rung above STAGE_1 rests on it. */
  recordedProductionRuns: number;
}

const PHYSICAL: ReadonlySet<ProductionClass> = new Set<ProductionClass>([
  'BOOK',
  'ACTIVITY_PAD',
  'CARD',
  'JIGSAW',
  'BOXED_KIT',
  'MECHANICAL',
]);

/**
 * Where on the directive's ladder this operation actually is.
 *
 * Derived, never stored, for `tier.ts`'s reason — a stored stage is stale the
 * moment a batch is printed. And it is honest about its own ceiling: nothing
 * in this Brain records a print run, a tooling setup or a machine, so every
 * rung above Stage 1 is unreachable from rows and the reading says which fact
 * is missing rather than estimating a stage from ambition.
 */
export function readProductionStage(snapshot: PuzzleSnapshot): ProductionReading {
  const live = snapshot.outputs.filter((one) => !one.retiredAt);
  const classesInUse = [...new Set(live.map((one) => one.productionClass))].sort();
  const physical = classesInUse.filter((one) => PHYSICAL.has(one));
  const released = live.filter((one) => one.releasedAt !== null);

  /*
   * Zero, always, today. It is a field rather than a sentence because the
   * ladder's every rung above the first is a count of these, and a reader
   * should be able to see the number the whole reading rests on rather than
   * being told about it in prose.
   */
  const recordedProductionRuns = 0;

  if (physical.length === 0) {
    return {
      stage: 'STAGE_0_DIGITAL',
      why:
        live.length === 0
          ? 'Nothing has been compiled into a product yet.'
          : `Everything compiled so far is ${classesInUse.join(', ').toLowerCase().replace(/_/g, ' ')}, ` +
            'which is made by delivering a file rather than by printing anything.',
      nextQuestion:
        'Compile something in a physical production class, and record what a print-on-demand ' +
        'or a short contract run of it actually cost.',
      classesInUse,
      recordedProductionRuns,
    };
  }

  if (released.filter((one) => PHYSICAL.has(one.productionClass)).length === 0) {
    return {
      stage: 'STAGE_0_DIGITAL',
      why:
        `${physical.length} physical production ${
          physical.length === 1 ? 'class is' : 'classes are'
        } in use and nothing in ${physical.length === 1 ? 'it' : 'them'} has been released, so ` +
        'nothing has been made.',
      nextQuestion: 'A person releases one, and a first run is recorded against it.',
      classesInUse,
      recordedProductionRuns,
    };
  }

  return {
    stage: 'STAGE_1_POD',
    why:
      'Something physical has been released. Every rung above this one is a count of recorded ' +
      `production runs, and this Brain holds ${recordedProductionRuns} — so where this ` +
      'operation actually sits between print-on-demand and owned machinery is not something ' +
      'these rows can answer.',
    nextQuestion:
      'Record a production run: its setup, its quantity, its unit cost and what was sold from ' +
      'it. Nothing in this Brain records one, and every figure above Stage 1 — utilization, ' +
      'throughput, scrap, capex payback — is derived from them.',
    classesInUse,
    recordedProductionRuns,
  };
}

/* --------------------------------------------------------------------------
 * The cheap-book investigation
 * ------------------------------------------------------------------------ */

/**
 * The lines the directive's own reverse-engineering needs.
 *
 * Its list is longer than this — print quantity, page count, paper, case
 * packs, catalog cadence — and those are not economic *components*, they are
 * facts a claim states. What this reading can be exact about is which of the
 * **figures** exist, so it reports that and says plainly that the rest is
 * prose a reader has to look at.
 */
export const CHEAP_BOOK_COMPONENTS: readonly EconomicComponent[] = Object.freeze([
  'RETAIL_PRICE',
  'NET_RECEIPTS',
  'RETAILER_SHARE',
  'PRINTING_COST',
  'MATERIALS_COST',
  'FREIGHT_COST',
  'EDITORIAL_COST',
  'RETURNS_ALLOWANCE',
]);

export interface CheapBookReading {
  /** Whether the question has even been asked. */
  asked: boolean;
  established: EconomicComponent[];
  missing: EconomicComponent[];
  /** The contribution, where every line exists. Withheld with a reason otherwise. */
  contribution: ContributionReading | null;
  why: string;
}

export function readCheapBook(snapshot: PuzzleSnapshot): CheapBookReading {
  const asked = snapshot.rounds.some((one) => one.purpose === 'CHEAP_BOOK');
  /*
   * Every book-shaped figure in the project, not only the ones on a route: the
   * investigation is about a *product shape* rather than about one of our
   * channels, and a published print rate is about printing whoever is buying.
   */
  const lines = snapshot.economics.filter((one) =>
    CHEAP_BOOK_COMPONENTS.includes(one.component),
  );
  const established = [...new Set(lines.map((one) => one.component))].sort();
  const missing = CHEAP_BOOK_COMPONENTS.filter((one) => !established.includes(one));

  const contribution =
    lines.length > 0
      ? readContribution({
          lines,
          routeId: null,
          routeName: null,
          productionClass: 'BOOK',
        })
      : null;

  return {
    asked,
    established,
    missing,
    contribution,
    why: !asked
      ? 'The reverse-engineering the directive asks for has not been asked yet.'
      : missing.length === 0
        ? 'Every figure the arithmetic needs is published.'
        : `${established.length} of ${CHEAP_BOOK_COMPONENTS.length} figures are published. The ` +
          'directive also asks for print quantity, page count, paper, binding, case packs, ' +
          'freight density, working capital, catalog cadence and required sell-through, which ' +
          'are statements in the claims rather than figures this reading can count.',
  };
}
