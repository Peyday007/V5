/**
 * The monetization possibility ledger: every credible way puzzle work turns
 * into money, and where each one currently stands.
 *
 * ---------------------------------------------------------------------------
 * The ledger is a reviewed constant and the state is derived
 * ---------------------------------------------------------------------------
 *
 * The brief asks for a persistent ledger that surfaces the best five
 * prominently and **never deletes or hides** the slower, blocked, experimental
 * or long-horizon ones. Those two requirements pull in opposite directions if
 * the ledger is a table: whatever prunes it for the top five is one bug away
 * from pruning it for good, and a route that vanished would be indistinguishable
 * from one nobody thought of.
 *
 * So the routes are a constant somebody reviews, and *nothing removes one*.
 * What varies is the state, which is derived per route from rows on every
 * read — `tier.ts`' argument at a third ladder. Adding a route is a code
 * change with a diff; rejecting one is a person's observation with a reason,
 * which keeps the route visible and says why it was turned down rather than
 * making it disappear.
 *
 * ---------------------------------------------------------------------------
 * Rank is lexicographic over observable facts
 * ---------------------------------------------------------------------------
 *
 * No weighted score, for the reason §38 and §39 both give: a score needs
 * weights, the weights are a judgement nobody made, and the number then reads
 * like a measurement. Two routes that differ are separated by exactly one
 * factor and the reading names it.
 *
 * The order of the factors is the decision. Fewest unmet requirements first,
 * because the cheapest thing is the thing already nearly possible. Then
 * capital at risk, ascending, because money that cannot be lost is worth more
 * than money that might be. Then how physical it is, because atoms are slower
 * than bytes and the brief asks for cash now beside position later — not
 * instead of it, which is why the physical routes stay in the ledger at full
 * detail rather than being filtered out of it.
 */
import type {
  PuzzleConstraint,
  PuzzleDemand,
  PuzzleObservation,
  PuzzleProductClass,
  PuzzleRoute,
} from '../../domain/types.ts';
import type { FormatMaturity } from './maturity.ts';
import type { UnitEconomics } from './economics.ts';

/**
 * What a route needs before anybody could earn from it.
 *
 * A closed set, each answerable from rows, so a route's state is a derivation
 * rather than an opinion. `PERSON_AUTHORIZATION` is here and is deliberately
 * never met by anything in this kernel: every route that reaches a buyer needs
 * a commercial action a person granted, which is Cash Mode's standing
 * authority and not this ledger's to assume.
 */
export const ROUTE_REQUIREMENTS = [
  'VALIDATED_OUTPUT',
  'PUBLISHED_BUYER',
  'PUBLISHED_CHANNEL',
  'ESTABLISHED_ECONOMICS',
  'HUMAN_EDIT',
  'PRODUCTION_ROUTE',
  'OWNED_MANUFACTURING',
] as const;
export type RouteRequirement = (typeof ROUTE_REQUIREMENTS)[number];

/** How much of this operation's own money a route puts at risk before it earns. */
export const CAPITAL_AT_RISK = ['NONE', 'SMALL', 'INVENTORY', 'TOOLING', 'MACHINERY'] as const;
export type CapitalAtRisk = (typeof CAPITAL_AT_RISK)[number];

export interface MonetizationRoute {
  id: string;
  title: string;
  /** What it is, in the words somebody deciding whether to pursue it needs. */
  description: string;
  productClass: PuzzleProductClass;
  requires: readonly RouteRequirement[];
  capitalAtRisk: CapitalAtRisk;
  /**
   * Where this sits on the physical production ladder, 0 to 5.
   *
   * 0 is nothing physical at all. 1 is print-on-demand and prototypes. 2 is
   * proven outsourced batches and wholesale. 3 is bringing finishing and
   * packing in-house. 4 is owning machinery. 5 is selling the spare capacity
   * of machinery you own. The ladder is the brief's and the numbers are kept
   * because the ordering is the point: nothing at stage 4 is reachable before
   * stage 2 has been shown to work.
   */
  stage: 0 | 1 | 2 | 3 | 4 | 5;
}

export const MONETIZATION_ROUTES: readonly MonetizationRoute[] = Object.freeze([
  /* ---- Stage 0: nothing physical ------------------------------------- */
  {
    id: 'downloadable-packs',
    title: 'Downloadable puzzle packs',
    description:
      'A validated set of puzzles as a printable PDF, sold as a one-off download. The fastest ' +
      'route from a working generator to a collected payment, because there is nothing to ' +
      'print, hold or ship.',
    productClass: 'DIGITAL_DOWNLOAD',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_CHANNEL', 'HUMAN_EDIT'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'custom-branded-puzzles',
    title: 'Custom puzzles for brands and events',
    description:
      'A bespoke puzzle built around somebody’s own words — a wedding, a conference, a ' +
      'restaurant placemat, a recruitment campaign. Paid per commission, needs no catalog, ' +
      'and is the route where a single buyer pays most per puzzle.',
    productClass: 'SERVICE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'HUMAN_EDIT'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'syndication',
    title: 'Syndication to publications',
    description:
      'A recurring supply of puzzles to a newspaper, magazine, newsletter or site under a ' +
      'per-puzzle or per-period rate. Recurring rather than one-off, which is why it is worth ' +
      'more than its headline rate suggests.',
    productClass: 'RECURRING_FEED',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'PUBLISHED_CHANNEL', 'HUMAN_EDIT'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'white-label-sections',
    title: 'White-label puzzle sections',
    description:
      'Supplying a publication or app with puzzles it runs under its own name. The buyer takes ' +
      'the audience risk and pays for reliability, which is exactly what a validated generator ' +
      'is good at.',
    productClass: 'LICENSE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'HUMAN_EDIT'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'licensing-catalog',
    title: 'Licensing the back catalog',
    description:
      'Licensing puzzles already made and already paid for into another market, language or ' +
      'format. Costs nothing to supply twice, which is the whole argument for keeping a ' +
      'catalog rather than a pipeline.',
    productClass: 'LICENSE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'subscription-archive',
    title: 'Subscription or membership archive',
    description:
      'Recurring access to the whole catalog plus whatever is made next. Turns a catalog into ' +
      'an income rather than a series of sales, and gets better the larger the catalog is.',
    productClass: 'RECURRING_FEED',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_CHANNEL', 'ESTABLISHED_ECONOMICS', 'HUMAN_EDIT'],
    capitalAtRisk: 'SMALL',
    stage: 0,
  },
  {
    id: 'institutional-packs',
    title: 'School, library, care-home and hospitality packs',
    description:
      'Bulk puzzle material bought by an institution rather than a reader — classrooms, ' +
      'tutoring, libraries, museums, camps, senior living. Larger orders, slower buying, and ' +
      'a buyer who returns on a calendar.',
    productClass: 'DIGITAL_DOWNLOAD',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'HUMAN_EDIT'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'corporate-programmes',
    title: 'Corporate onboarding, training and internal communications',
    description:
      'Puzzles as a device inside somebody else’s programme. Paid as a service, sold on a ' +
      'business outcome rather than on entertainment, and priced accordingly.',
    productClass: 'SERVICE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'HUMAN_EDIT'],
    capitalAtRisk: 'NONE',
    stage: 0,
  },
  {
    id: 'daily-web-and-app',
    title: 'Daily web puzzle, app or widget',
    description:
      'An owned surface where the puzzle is free and the money is advertising, hints, premium ' +
      'access or a tournament. Needs an audience before it is worth anything, which makes it a ' +
      'slow route with a high ceiling.',
    productClass: 'INTERACTIVE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_CHANNEL', 'ESTABLISHED_ECONOMICS', 'HUMAN_EDIT'],
    capitalAtRisk: 'SMALL',
    stage: 0,
  },
  {
    id: 'embeds-and-api',
    title: 'Embeddable puzzles and a content API',
    description:
      'Selling the supply rather than the audience: a feed or an embed another site runs. The ' +
      'buyer is a business, the revenue recurs, and what is sold is the validated generator ' +
      'rather than any particular puzzle.',
    productClass: 'RECURRING_FEED',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'PUBLISHED_CHANNEL'],
    capitalAtRisk: 'SMALL',
    stage: 0,
  },
  {
    id: 'generator-software',
    title: 'Licensing the generation and validation software',
    description:
      'Selling the tool rather than its output — to publishers who want their own puzzles ' +
      'checked, or their own grids made. The validators are the unusual asset here, because ' +
      'most puzzle software will generate and almost none will prove.',
    productClass: 'LICENSE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'ESTABLISHED_ECONOMICS'],
    capitalAtRisk: 'SMALL',
    stage: 0,
  },
  {
    id: 'puzzle-hunts-and-events',
    title: 'Puzzle hunts, competitions and live events',
    description:
      'A designed experience rather than a product, sold per event or per team. Editorial-heavy ' +
      'and hard to automate, which is why it prices well and scales badly.',
    productClass: 'SERVICE',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_BUYER', 'HUMAN_EDIT'],
    capitalAtRisk: 'SMALL',
    stage: 0,
  },

  /* ---- Stage 1: print on demand, prototypes, small runs ---------------- */
  {
    id: 'pod-books',
    title: 'Print-on-demand puzzle books',
    description:
      'A book printed only when somebody orders it. No inventory and no minimum, at a much ' +
      'worse unit cost than a real print run — which is exactly the trade worth making while ' +
      'nobody knows whether the book sells.',
    productClass: 'PRINT_BOOK',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_CHANNEL', 'ESTABLISHED_ECONOMICS', 'HUMAN_EDIT'],
    capitalAtRisk: 'SMALL',
    stage: 1,
  },
  {
    id: 'personalised-print',
    title: 'Personalised printed puzzles',
    description:
      'A one-off printed puzzle made from somebody’s own content — a gift, an announcement, ' +
      'a proposal. Print-on-demand economics with a gift-market price, and the personalisation ' +
      'is what the generator is for.',
    productClass: 'PRINT_BOOK',
    requires: ['VALIDATED_OUTPUT', 'PUBLISHED_CHANNEL', 'PRODUCTION_ROUTE', 'HUMAN_EDIT'],
    capitalAtRisk: 'SMALL',
    stage: 1,
  },

  /* ---- Stage 2: proven outsourced batches, wholesale, private label ---- */
  {
    id: 'offset-books',
    title: 'Offset-printed puzzle books',
    description:
      'A real print run at a real unit cost, sold through a trade channel. The economics only ' +
      'work at volume and the volume is inventory somebody has to fund, which is why it belongs ' +
      'after a print-on-demand version has shown the book sells at all.',
    productClass: 'PRINT_BOOK',
    requires: [
      'VALIDATED_OUTPUT',
      'PUBLISHED_BUYER',
      'PUBLISHED_CHANNEL',
      'ESTABLISHED_ECONOMICS',
      'PRODUCTION_ROUTE',
      'HUMAN_EDIT',
    ],
    capitalAtRisk: 'INVENTORY',
    stage: 2,
  },
  {
    id: 'private-label-supply',
    title: 'Private-label and retailer-exclusive editions',
    description:
      'Supplying a retailer or publisher with a book that carries their name. They take the ' +
      'shelf risk and the margin; the supplier takes a smaller, surer number and no inventory ' +
      'of its own.',
    productClass: 'PRINT_BOOK',
    requires: [
      'VALIDATED_OUTPUT',
      'PUBLISHED_BUYER',
      'ESTABLISHED_ECONOMICS',
      'PRODUCTION_ROUTE',
      'HUMAN_EDIT',
    ],
    capitalAtRisk: 'SMALL',
    stage: 2,
  },
  {
    id: 'cards-and-boxed',
    title: 'Card decks, boxed kits and jigsaws',
    description:
      'A physical product that is not a book: components, packaging, a different factory and ' +
      'different safety rules. Shares the intellectual property with everything above it and ' +
      'shares almost none of the production.',
    productClass: 'CARD_OR_BOXED',
    requires: [
      'VALIDATED_OUTPUT',
      'PUBLISHED_BUYER',
      'ESTABLISHED_ECONOMICS',
      'PRODUCTION_ROUTE',
      'HUMAN_EDIT',
    ],
    capitalAtRisk: 'INVENTORY',
    stage: 2,
  },
  {
    id: 'mechanical-puzzles',
    title: 'Mechanical and wooden brainteasers',
    description:
      'Objects rather than printed matter: tooling, materials, a manufacturer and a long lead ' +
      'time. A different business that happens to share a brand, and it is in the ledger so ' +
      'that it stays visible rather than being rediscovered later.',
    productClass: 'CARD_OR_BOXED',
    requires: [
      'VALIDATED_OUTPUT',
      'PUBLISHED_BUYER',
      'ESTABLISHED_ECONOMICS',
      'PRODUCTION_ROUTE',
    ],
    capitalAtRisk: 'TOOLING',
    stage: 2,
  },
  {
    id: 'wholesale-distribution',
    title: 'Wholesale and subscription-box distribution',
    description:
      'Selling through somebody else’s shelf or box at wholesale terms. Larger volumes, ' +
      'much smaller unit receipts, and returns — which is the line most often left out of the ' +
      'arithmetic that makes it look good.',
    productClass: 'PRINT_BOOK',
    requires: [
      'VALIDATED_OUTPUT',
      'PUBLISHED_BUYER',
      'PUBLISHED_CHANNEL',
      'ESTABLISHED_ECONOMICS',
      'PRODUCTION_ROUTE',
    ],
    capitalAtRisk: 'INVENTORY',
    stage: 2,
  },

  /* ---- Stage 3 to 5: bringing production in, then selling capacity ----- */
  {
    id: 'in-house-finishing',
    title: 'In-house personalisation, finishing and packing',
    description:
      'Taking the last steps of production in-house — personalising, finishing, assembling, ' +
      'packing and quality control — while the printing stays outsourced. The cheapest step ' +
      'onto the ownership ladder and the one that most improves a personalised product.',
    productClass: 'PRINT_BOOK',
    requires: ['VALIDATED_OUTPUT', 'ESTABLISHED_ECONOMICS', 'PRODUCTION_ROUTE'],
    capitalAtRisk: 'TOOLING',
    stage: 3,
  },
  {
    id: 'owned-printing',
    title: 'Owned printing, cutting, collating and binding',
    description:
      'Buying the machines. Justified only by recurring demand, utilisation, quality, speed, ' +
      'customisation or secrecy that outsourcing cannot supply — on fully loaded economics ' +
      'including labour, maintenance, floor space and the contribution per machine-hour.',
    productClass: 'PRINT_BOOK',
    requires: ['ESTABLISHED_ECONOMICS', 'PRODUCTION_ROUTE', 'OWNED_MANUFACTURING'],
    capitalAtRisk: 'MACHINERY',
    stage: 4,
  },
  {
    id: 'contract-manufacturing',
    title: 'Contract production on owned capacity',
    description:
      'Selling the spare capacity of machinery already bought for our own products. It is the ' +
      'reason owning machinery can be better than it looks — and it exists only after the ' +
      'machinery does, which is why it is last.',
    productClass: 'SERVICE',
    requires: ['OWNED_MANUFACTURING', 'PUBLISHED_BUYER'],
    capitalAtRisk: 'MACHINERY',
    stage: 5,
  },

  /* ---- Acquisition, which is a route rather than a stage --------------- */
  {
    id: 'catalog-acquisition',
    title: 'Acquiring a puzzle catalog, newsletter or site',
    description:
      'Buying an existing audience, catalog or rights position rather than building one. It ' +
      'can make a route viable years earlier than it otherwise would be, and identifying a ' +
      'target is research while everything after that is a person’s decision with money on ' +
      'the end of it.',
    productClass: 'LICENSE',
    requires: ['PUBLISHED_BUYER', 'ESTABLISHED_ECONOMICS'],
    capitalAtRisk: 'MACHINERY',
    stage: 2,
  },
]);

export const ROUTE_STATES = [
  /** Everything it needs is in place. */
  'ACTIVE',
  /** One requirement short. */
  'NEXT_BEST',
  /** More than one short, and something is established. */
  'WATCHLIST',
  /** Nothing has been established about it at all. */
  'UNPROVEN',
  /** Short only of things no question can answer: money, a person, a machine. */
  'BLOCKED',
  /** A person turned it down, and the reason is kept. */
  'ARCHIVED',
] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

export interface LedgerEntry {
  route: MonetizationRoute;
  state: RouteState;
  met: RouteRequirement[];
  unmet: RouteRequirement[];
  /** What would move it, in one sentence. */
  next: string;
  /** Why a person turned it down, where one did. */
  rejectedBecause: string | null;
  /** Which format, if any, currently comes closest to serving it. */
  bestFormat: string | null;
}

export interface LedgerInput {
  maturity: readonly FormatMaturity[];
  demand: readonly PuzzleDemand[];
  routes: readonly PuzzleRoute[];
  economics: readonly UnitEconomics[];
  constraints: readonly PuzzleConstraint[];
  observations: readonly PuzzleObservation[];
  heldCapabilities: readonly string[];
}

/** Which requirements no research can answer. A route short only of these is blocked. */
const NOT_RESEARCHABLE: ReadonlySet<RouteRequirement> = new Set<RouteRequirement>([
  'VALIDATED_OUTPUT',
  'HUMAN_EDIT',
  'OWNED_MANUFACTURING',
]);

export function readLedger(input: LedgerInput): LedgerEntry[] {
  const rejected = new Map<string, string>();
  for (const one of input.observations) {
    if (one.kind !== 'ROUTE_REJECTED' || !one.monetizationRoute) continue;
    rejected.set(one.monetizationRoute, one.statement);
  }

  const entries: LedgerEntry[] = MONETIZATION_ROUTES.map((route) => {
    /*
     * A requirement is met if *any* format meets it, and the format that does
     * is named. The ledger is about routes rather than formats — "can we sell
     * a downloadable pack" is answered by having one sellable format, not by
     * every format being sellable.
     *
     * ---------------------------------------------------------------------
     * Read from what exists, never from how far up the ladder a format got
     * ---------------------------------------------------------------------
     *
     * The first version asked `reached.includes('VALIDATABLE')`, which looks
     * equivalent and is not: the ladder is a *business* ladder and stops at
     * the first rung that is not met, so a format with a hundred proved
     * puzzles and no published buyer stops at DISCOVERED and never reaches
     * VALIDATABLE. Driving this live printed the consequence in the operator
     * report — *"No format here yet produces puzzles that pass their own
     * checks"* — against a catalog of 136 that did.
     *
     * That is the shape of defect this file cares about most: every row
     * healthy, the arithmetic right, and the sentence about it false. The
     * counts on the reading are facts about rows and answer the question that
     * was actually being asked.
     */
    const withOutput = input.maturity.filter((one) => one.evidence.validPuzzles > 0);
    const editedKeys = new Set(
      input.observations
        .filter((one) => one.kind === 'HUMAN_EDIT_PASSED' && one.formatKey)
        .map((one) => one.formatKey as string),
    );
    const edited = withOutput.filter((one) => editedKeys.has(one.formatKey));
    const withBuyer = new Set(input.demand.map((one) => one.formatKey));
    const withChannel = new Set(
      input.routes.filter((one) => one.kind === 'CHANNEL').map((one) => one.formatKey),
    );
    const withProduction = new Set(
      input.routes.filter((one) => one.kind === 'PRODUCTION').map((one) => one.formatKey),
    );
    const costed = new Set(
      input.economics
        .filter((one) => one.productClass === route.productClass && one.withheld === null)
        .map((one) => one.formatKey),
    );

    const answer = (requirement: RouteRequirement): { met: boolean; format: string | null } => {
      switch (requirement) {
        case 'VALIDATED_OUTPUT': {
          const one = withOutput[0];
          return { met: one !== undefined, format: one?.formatKey ?? null };
        }
        case 'HUMAN_EDIT': {
          const one = edited[0];
          return { met: one !== undefined, format: one?.formatKey ?? null };
        }
        case 'PUBLISHED_BUYER': {
          const one = [...withBuyer][0];
          return { met: one !== undefined, format: one ?? null };
        }
        case 'PUBLISHED_CHANNEL': {
          const one = [...withChannel][0];
          return { met: one !== undefined, format: one ?? null };
        }
        case 'PRODUCTION_ROUTE': {
          const one = [...withProduction][0];
          return { met: one !== undefined, format: one ?? null };
        }
        case 'ESTABLISHED_ECONOMICS': {
          const one = [...costed][0];
          return { met: one !== undefined, format: one ?? null };
        }
        case 'OWNED_MANUFACTURING':
          return { met: input.heldCapabilities.length > 0, format: null };
        default:
          return { met: false, format: null };
      }
    };

    const met: RouteRequirement[] = [];
    const unmet: RouteRequirement[] = [];
    let bestFormat: string | null = null;
    for (const requirement of route.requires) {
      const result = answer(requirement);
      if (result.met) {
        met.push(requirement);
        bestFormat ??= result.format;
      } else {
        unmet.push(requirement);
      }
    }

    const rejectedBecause = rejected.get(route.id) ?? null;
    const state: RouteState = rejectedBecause
      ? 'ARCHIVED'
      : unmet.length === 0
        ? 'ACTIVE'
        : met.length === 0
          ? 'UNPROVEN'
          : unmet.every((one) => NOT_RESEARCHABLE.has(one))
            ? 'BLOCKED'
            : unmet.length === 1
              ? 'NEXT_BEST'
              : 'WATCHLIST';

    return {
      route,
      state,
      met,
      unmet,
      next: nextFor(state, unmet, rejectedBecause),
      rejectedBecause,
      bestFormat,
    };
  });

  return entries.sort(compare);
}

function nextFor(
  state: RouteState,
  unmet: readonly RouteRequirement[],
  rejectedBecause: string | null,
): string {
  if (state === 'ARCHIVED') {
    return `Turned down: ${rejectedBecause ?? 'no reason was recorded.'} It stays in the ledger ` +
      'because a route somebody rejected is a decision rather than an absence, and the reason ' +
      'is what stops it being proposed again next week.';
  }
  if (state === 'ACTIVE') {
    return 'Everything this needs is in place. What remains is a commercial action a person ' +
      'authorizes, which is the standing grant and never this ledger.';
  }
  const first = unmet[0];
  switch (first) {
    case 'VALIDATED_OUTPUT':
      return 'No format here yet produces puzzles that pass their own checks. That is a ' +
        'generator, which is a code change somebody reviews.';
    case 'HUMAN_EDIT':
      return 'Nobody has read or played what the machine produced. One person, one sitting, ' +
        'and there is no flag that stands in for it.';
    case 'PUBLISHED_BUYER':
      return 'Nobody has established who actually pays for this. That is a research question ' +
        'and it is the cheapest thing on this list.';
    case 'PUBLISHED_CHANNEL':
      return 'Nothing establishes how it reaches a buyer or on what terms. A research question.';
    case 'PRODUCTION_ROUTE':
      return 'Nobody has established who physically makes this, or what their minimum is. A ' +
        'research question, and it comes before any figure about a print run means anything.';
    case 'ESTABLISHED_ECONOMICS':
      return 'The money is not established: either no source states what this is paid, or a ' +
        'cost line this product class cannot be costed without is missing. A research question ' +
        'with a named shape.';
    case 'OWNED_MANUFACTURING':
      return 'This needs machinery this operation owns. That is the manufacturing ' +
        'programme’s capital decision and a person’s, and it comes last for a reason.';
    default:
      return 'Nothing has been established about this route.';
  }
}

/**
 * The order, lexicographic and with no weighted score anywhere.
 *
 * Every comparison is a fact about rows. Two routes with nothing between them
 * on any factor fall through to the id, which is stable — so the list does not
 * reshuffle between two reads of an unchanged database, and a change in the
 * order means something changed.
 */
function compare(a: LedgerEntry, b: LedgerEntry): number {
  const rank = (one: LedgerEntry): number => ROUTE_STATES.indexOf(one.state);
  return (
    rank(a) - rank(b) ||
    a.unmet.length - b.unmet.length ||
    CAPITAL_AT_RISK.indexOf(a.route.capitalAtRisk) - CAPITAL_AT_RISK.indexOf(b.route.capitalAtRisk) ||
    a.route.stage - b.route.stage ||
    a.route.id.localeCompare(b.route.id)
  );
}

/** The five the brief asks to be shown prominently. Never a filter of the ledger. */
export function topFive(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter((one) => one.state !== 'ARCHIVED').slice(0, 5);
}
