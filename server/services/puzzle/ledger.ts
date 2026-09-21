/**
 * The monetization possibility ledger, ranked and never pruned.
 *
 * ---------------------------------------------------------------------------
 * Top 5 Now is a view, and everything else stays on the page
 * ---------------------------------------------------------------------------
 *
 * The directive says it twice: *surface the Top 5 Now prominently, but never
 * delete or hide slower, lower-ranked, blocked, experimental,
 * physical-production or long-term paths.* So every view below is derived from
 * one list, there is no delete path to `puzzle_routes` anywhere in this
 * kernel, and the slow and the blocked are their own named views rather than a
 * tail somebody has to scroll past.
 *
 * ---------------------------------------------------------------------------
 * Lexicographic over named facts, with no weighted score anywhere
 * ---------------------------------------------------------------------------
 *
 * §38 and §39 both make this argument and it is exactly the one that applies
 * here: a score needs weights, weights are a judgement nobody made, and the
 * number then reads like a measurement. So the order is a fixed sequence of
 * observable facts, two routes that differ are separated by **exactly one** of
 * them, and the reading names which — so *why is this above that* resolves to
 * a row rather than to arithmetic nobody can inspect.
 *
 * Two routes with nothing between them say so, which is itself a finding.
 *
 * ---------------------------------------------------------------------------
 * An unknown never ranks higher
 * ---------------------------------------------------------------------------
 *
 * A route nobody has looked at does not outrank one somebody looked at and
 * found nothing on, and neither outranks one with a dated buying signal. §30's
 * `conservativeContribution` defect is the shape to avoid: a blank must never
 * be the reason something rises.
 */
import { readContribution } from './economics.ts';
import type { PuzzleSnapshot } from './graph.ts';
import type { OutputReading } from './maturity.ts';
import type { ProductionClass, PuzzleRoute, RouteClass } from '../../domain/types.ts';

/**
 * Which route classes can reach a paid proof without buying inventory first.
 *
 * A `Record` over the whole union, so a class added later is a compile error
 * until somebody says which it is. The directive asks explicitly to *prioritize
 * routes that can reach paid proof without inventory*, and this is the only
 * place that judgement is made.
 */
const INVENTORY_FREE: Readonly<Record<RouteClass, boolean>> = Object.freeze({
  DIGITAL_SALE: true,
  SUBSCRIPTION: true,
  ADVERTISING: true,
  SYNDICATION: true,
  CUSTOM_COMMISSION: true,
  INSTITUTIONAL: true,
  WHITE_LABEL: true,
  SOFTWARE: true,
  /*
   * Print-on-demand is genuinely inventory-free and lives under PRINT_PRODUCT,
   * which also covers a thousand-copy offset run. The class cannot tell them
   * apart, so it takes the answer that does not flatter: treating the whole
   * class as inventory-free would rank an offset print ahead of a commission
   * on a property it may not have.
   */
  PRINT_PRODUCT: false,
  PHYSICAL_PRODUCT: false,
  CONTRACT_PRODUCTION: false,
  ACQUISITION: false,
});

export interface RankFactor {
  key: string;
  /** Higher is better, always, so the comparison needs no per-factor direction. */
  value: number;
  label: string;
}

export interface RouteReading {
  routeId: string;
  name: string;
  routeClass: RouteClass;
  disposition: PuzzleRoute['disposition'];
  dispositionReason: string | null;

  /** Dated buying signals on this route, newest first. */
  demandSignals: { buyer: string; observedOn: string; statement: string }[];
  /** Documented searches that found nobody. A real answer, and not the same as silence. */
  searchedAndEmpty: number;
  /** Whether anything publishes what this route pays. */
  priced: boolean;
  inventoryFree: boolean;
  /** Outputs aimed at this route that are qualified or better. */
  readyOutputs: number;

  factors: RankFactor[];
  /** The server's own sentence about where this route stands. */
  why: string;
  /** What would move it up, or null where nothing in rows would. */
  nextQuestion: string | null;
}

const isRevenueComponent = (component: string): boolean =>
  component === 'RETAIL_PRICE' ||
  component === 'NET_RECEIPTS' ||
  component === 'LICENSE_FEE' ||
  component === 'SYNDICATION_FEE' ||
  component === 'SUBSCRIPTION_PRICE' ||
  component === 'CUSTOM_COMMISSION';

/** A date a source stated, as a comparable number. Missing sorts lowest. */
function dateValue(observedOn: string | null): number {
  if (!observedOn) return 0;
  const padded =
    observedOn.length === 4
      ? `${observedOn}-01-01`
      : observedOn.length === 7
        ? `${observedOn}-01`
        : observedOn;
  const time = Date.parse(padded);
  return Number.isFinite(time) ? time : 0;
}

export function readRoute(
  snapshot: PuzzleSnapshot,
  route: PuzzleRoute,
  outputs: readonly OutputReading[],
): RouteReading {
  const evidence = snapshot.routeEvidence.filter((one) => one.routeId === route.id);
  const signals = evidence
    .filter((one) => one.posture === 'DEMAND_FOUND' && one.observedOn)
    .map((one) => ({
      buyer: one.buyer,
      observedOn: one.observedOn as string,
      statement: one.statement,
    }))
    .sort((a, b) => dateValue(b.observedOn) - dateValue(a.observedOn));
  const searchedAndEmpty = evidence.filter((one) => one.posture === 'NONE_FOUND').length;

  const lines = snapshot.economics.filter((one) => one.routeId === route.id);
  const priced = lines.some((one) => isRevenueComponent(one.component));
  const inventoryFree = INVENTORY_FREE[route.routeClass];

  const outputIds = new Set(
    snapshot.outputs.filter((one) => one.routeId === route.id).map((one) => one.id),
  );
  const readyOutputs = outputs.filter(
    (one) =>
      outputIds.has(one.outputId) &&
      (one.qualification === 'QUALIFIED' ||
        one.qualification === 'SELLABLE' ||
        one.qualification === 'REVENUE_PROVEN'),
  ).length;

  /*
   * Whether the arithmetic actually comes out. Not a figure in the ranking —
   * a route whose contribution is known and positive outranks one whose
   * contribution is withheld, and the *size* of it does not enter, because
   * ranking on a margin would rank on whichever route happened to have the
   * most figures published about it.
   */
  const classes = [
    ...new Set(
      snapshot.outputs.filter((one) => one.routeId === route.id).map((one) => one.productionClass),
    ),
  ];
  const productionClass: ProductionClass = classes[0] ?? 'DIGITAL_ONLY';
  const contribution =
    lines.length > 0
      ? readContribution({ lines, routeId: route.id, routeName: route.name, productionClass })
      : null;
  const positiveContribution =
    contribution !== null &&
    contribution.withheld === null &&
    (contribution.contributionPerUnitMinor ?? 0) > 0;

  const factors: RankFactor[] = [
    {
      key: 'HAS_DATED_DEMAND',
      value: signals.length > 0 ? 1 : 0,
      label: 'somebody has published that they buy through it, with a date',
    },
    {
      key: 'DEMAND_RECENCY',
      value: dateValue(signals[0]?.observedOn ?? null),
      label: 'how recent the newest buying signal is',
    },
    {
      key: 'HAS_PUBLISHED_PRICE',
      value: priced ? 1 : 0,
      label: 'something publishes what it pays',
    },
    {
      key: 'CONTRIBUTION_POSITIVE',
      value: positiveContribution ? 1 : 0,
      label: 'the arithmetic comes out, with every load-bearing line priced',
    },
    {
      key: 'REACHES_PROOF_WITHOUT_INVENTORY',
      value: inventoryFree ? 1 : 0,
      label: 'it can reach a paid proof without buying inventory first',
    },
    {
      key: 'HAS_READY_PRODUCT',
      value: readyOutputs,
      label: 'products already qualified for it',
    },
    {
      key: 'SEARCHED_AT_ALL',
      value: signals.length > 0 || searchedAndEmpty > 0 ? 1 : 0,
      label: 'anybody has looked at it',
    },
  ];

  const why =
    signals.length > 0
      ? `${signals.length} dated buying signal(s), the newest from ${signals[0]?.observedOn}.` +
        (priced ? ' A price is published.' : ' Nothing publishes what it pays.')
      : searchedAndEmpty > 0
        ? `${searchedAndEmpty} documented search(es) found nobody publishing demand here. That ` +
          'is an answer rather than a gap.'
        : 'Nobody has looked at this route yet.';

  const nextQuestion =
    route.disposition !== 'ACTIVE'
      ? null
      : signals.length === 0 && searchedAndEmpty === 0
        ? 'Find out who buys through it, and when they said so.'
        : signals.length === 0
          ? 'Nothing more to establish here unless the market changes.'
          : !priced
            ? 'Establish what it pays.'
            : readyOutputs === 0
              ? 'Compile a product aimed at it.'
              : 'A person decides whether to pursue it.';

  return {
    routeId: route.id,
    name: route.name,
    routeClass: route.routeClass,
    disposition: route.disposition,
    dispositionReason: route.dispositionReason,
    demandSignals: signals,
    searchedAndEmpty,
    priced,
    inventoryFree,
    readyOutputs,
    factors,
    why,
    nextQuestion,
  };
}

/** Lexicographic over the factor sequence. Returns the index that separated them, or -1. */
function separatingFactor(a: RouteReading, b: RouteReading): number {
  for (let index = 0; index < a.factors.length; index += 1) {
    const left = a.factors[index]?.value ?? 0;
    const right = b.factors[index]?.value ?? 0;
    if (left !== right) return index;
  }
  return -1;
}

export interface RankedRoute extends RouteReading {
  rank: number;
  /**
   * Which single fact put this above the one below it, or null where nothing
   * did — two routes with nothing between them is itself a finding, and saying
   * "they are equal" is more useful than an arbitrary order presented as one.
   */
  aheadBecause: string | null;
}

function rank(readings: readonly RouteReading[]): RankedRoute[] {
  const sorted = [...readings].sort((a, b) => {
    const index = separatingFactor(a, b);
    if (index === -1) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    return (b.factors[index]?.value ?? 0) - (a.factors[index]?.value ?? 0);
  });
  return sorted.map((one, index) => {
    const below = sorted[index + 1];
    const separator = below ? separatingFactor(one, below) : -1;
    return {
      ...one,
      rank: index + 1,
      aheadBecause: below === undefined
        ? null
        : separator === -1
          ? null
          : (one.factors[separator]?.label ?? null),
    };
  });
}

export interface LedgerView {
  /** The best few, and never the only few shown. */
  topNow: RankedRoute[];
  nextBest: RankedRoute[];
  allActive: RankedRoute[];
  watchlist: RankedRoute[];
  blocked: RankedRoute[];
  /** Active, and nobody has looked at them. Distinct from searched-and-empty. */
  unproven: RankedRoute[];
  archivedOrRejected: RankedRoute[];
  /** The routes whose proof needs capital, kept visible rather than ranked away. */
  physicalLadder: RankedRoute[];
  totals: { routes: number; active: number; withDemand: number; searchedAndEmpty: number };
}

export const TOP_NOW = 5;

export function readLedger(
  snapshot: PuzzleSnapshot,
  outputs: readonly OutputReading[],
): LedgerView {
  const readings = snapshot.routes.map((route) => readRoute(snapshot, route, outputs));
  const ranked = rank(readings);

  const byDisposition = (value: PuzzleRoute['disposition']): RankedRoute[] =>
    ranked.filter((one) => one.disposition === value);

  const active = byDisposition('ACTIVE');

  return {
    topNow: active.slice(0, TOP_NOW),
    nextBest: active.slice(TOP_NOW, TOP_NOW * 2),
    allActive: active,
    watchlist: byDisposition('WATCHLIST'),
    blocked: byDisposition('BLOCKED'),
    unproven: active.filter(
      (one) => one.demandSignals.length === 0 && one.searchedAndEmpty === 0,
    ),
    archivedOrRejected: [...byDisposition('ARCHIVED'), ...byDisposition('REJECTED')],
    physicalLadder: ranked.filter((one) => !one.inventoryFree),
    totals: {
      routes: ranked.length,
      active: active.length,
      withDemand: ranked.filter((one) => one.demandSignals.length > 0).length,
      searchedAndEmpty: ranked.filter(
        (one) => one.demandSignals.length === 0 && one.searchedAndEmpty > 0,
      ).length,
    },
  };
}
